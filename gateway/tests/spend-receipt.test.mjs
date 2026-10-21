import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpendSSEObserver, parseMessagesReceipt, validateSpendReceipt } from '../lib/spend-receipt.js';
import { MODEL, NON_NEUTRAL_USAGE, chunksOf, evidenceFor, messageFor, metadataMessageFor, metadataSSEFor, policyFor, preparedFor, snapshotFor, sseFor } from './helpers/spend-fixture.mjs';

const attempt = () => snapshotFor(preparedFor(policyFor('/synthetic/wallet.sqlite')));
test('complete mixed-cache receipt costs 42 nanoUSD', () => {
  assert.equal(validateSpendReceipt({ attempt: attempt(), evidence: evidenceFor() }).actualCostNano, 42n);
  assert.throws(() => validateSpendReceipt({ attempt: attempt(), evidence: evidenceFor({ usage: null }) }), { code: 'invalid_receipt' });
});
test('bounded incremental SSE handles split UTF-8 and is idempotent', () => {
  const observer = createSpendSSEObserver();
  for (const part of chunksOf(sseFor(), 1)) observer.push(part);
  const evidence = observer.finish();
  assert.equal(evidence.complete, true);
  assert.equal(evidence.usage.output_tokens, 5);
  assert.deepEqual(observer.finish(), evidence);
  observer.push(new TextEncoder().encode('data: late\n\n'));
  assert.equal(observer.finish().complete, false);
  assert.ok(observer.snapshot().bufferedBytes <= 65536);
  const oversized = createSpendSSEObserver({ maxEventBytes: 32 });
  oversized.push(new TextEncoder().encode(`data: ${'x'.repeat(100)}`));
  assert.equal(oversized.finish().complete, false);
  assert.ok(oversized.snapshot().bufferedBytes <= 32);
});
test('JSON preserves missing receipt evidence rather than zero filling it', () => {
  for (const field of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    const message = messageFor(); delete message.usage[field];
    const evidence = parseMessagesReceipt({ bodyText: JSON.stringify(message), httpStatus: 200 });
    assert.equal(evidence.complete, false);
    assert.equal(evidence.usage, null);
  }
});
test('duplicate billing-sensitive JSON fields are not silently trusted', () => {
  const message = JSON.stringify(messageFor());
  const duplicateID = message.replace('"id":"msg_fixture_1"', '"id":"msg_fixture_1","id":"msg_conflict"');
  assert.equal(parseMessagesReceipt({ bodyText: duplicateID, httpStatus: 200 }).complete, false);
});
test('a receipt must be a native Messages response, not merely carry usage-shaped fields', () => {
  assert.equal(parseMessagesReceipt({ bodyText: JSON.stringify(messageFor({ type: 'other' })), httpStatus: 200 }).complete, false);
});
test('invalid usage and contradictory cache breakouts are refused', () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateSpendReceipt({ attempt: attempt(), evidence: evidenceFor({ usage: { input_tokens: value, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5 } }) }), { code: 'invalid_receipt' });
  }
  assert.throws(() => validateSpendReceipt({ attempt: attempt(), evidence: evidenceFor({ cacheCreationBreakdown: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 } }) }), { code: 'invalid_receipt' });
});
test('out-of-bound usage is durable violation evidence with exact extra liability', () => {
  const result = validateSpendReceipt({ attempt: attempt(), evidence: evidenceFor({ usage: { input_tokens: 101, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 11 } }) });
  assert.equal(result.boundsViolated, true);
  assert.equal(result.actualCostNano, 270n);
  assert.equal(result.additionalLiabilityNano, 0n);
});
test('SSE terminal ordering, duplicates, errors, and output regression remain uncertain', () => {
  const streams = [
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    'event: error\ndata: {"type":"error","error":{"type":"bad"}}\n\n',
    'event: message_start\ndata: {}\n\nevent: message_start\ndata: {}\n\n',
  ];
  for (const stream of streams) {
    const observer = createSpendSSEObserver(); observer.push(new TextEncoder().encode(stream));
    assert.equal(observer.finish().complete, false);
  }
});
test('well-formed JSON and CRLF SSE create the same complete evidence', () => {
  const json = parseMessagesReceipt({ bodyText: JSON.stringify(messageFor()), httpStatus: 200 });
  assert.equal(json.complete, true);
  assert.equal(json.model, MODEL);
  const observer = createSpendSSEObserver();
  observer.push(new TextEncoder().encode(new TextDecoder().decode(sseFor()).replaceAll('\n', '\r\n')));
  assert.equal(observer.finish().complete, true);
});
test('SSE limits each event rather than rejecting a large chunk of small events', () => {
  const observer = createSpendSSEObserver({ maxEventBytes: 1024 });
  const ping = 'event: ping\ndata: {"type":"ping"}\n\n';
  observer.push(new TextEncoder().encode(ping.repeat(100) + new TextDecoder().decode(sseFor())));
  assert.equal(observer.finish().complete, true);
});
test('SSE preserves cache breakdown and accepts cumulative delta snapshots', () => {
  const start = messageFor({ content: [], stop_reason: null, usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 } } });
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const observer = createSpendSSEObserver();
  observer.push(new TextEncoder().encode(
    event('message_start', { type: 'message_start', message: start }) +
    event('message_delta', { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 2 } }) +
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) +
    event('message_stop', { type: 'message_stop' }),
  ));
  const evidence = observer.finish();
  assert.equal(evidence.complete, true);
  assert.deepEqual(evidence.cacheCreationBreakdown, { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 });
  assert.equal(evidence.usage.output_tokens, 5);
});
test('SSE rejects trailing junk, incomplete UTF-8, mismatched event types, and invalid terminal completion', () => {
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const valid = new TextDecoder().decode(sseFor());
  for (const source of [
    `${valid}junk`,
    `${valid}\u00c3`,
    event('message_start', { type: 'message_delta', message: messageFor({ content: [], stop_reason: null }) }),
    event('message_start', { type: 'message_start', message: messageFor({ content: [], stop_reason: null }) }) + event('message_delta', { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 5 } }) + event('message_stop', { type: 'message_stop' }),
  ]) {
    const observer = createSpendSSEObserver(); observer.push(new TextEncoder().encode(source));
    assert.equal(observer.finish().complete, false);
  }
});
test('receipt validation requires complete canonical snapshot domains and deeply freezes evidence', () => {
  const validated = validateSpendReceipt({ attempt: attempt(), evidence: evidenceFor() });
  assert.throws(() => { validated.evidence.usage.output_tokens = 0; }, TypeError);
  for (const evidence of [
    evidenceFor({ messageID: '' }), evidenceFor({ kind: '' }), evidenceFor({ errorCode: '' }), evidenceFor({ complete: false }),
    evidenceFor({ cacheCreationBreakdown: { ephemeral_5m_input_tokens: Number.MAX_SAFE_INTEGER, ephemeral_1h_input_tokens: 3 } }),
  ]) assert.throws(() => validateSpendReceipt({ attempt: attempt(), evidence }), { code: 'invalid_receipt' });
});
const parseSSE = bytes => { const observer = createSpendSSEObserver(); for (const part of chunksOf(bytes, 7)) observer.push(part); return observer.finish(); };
test('real-shaped standard/global usage metadata is accepted as neutral in JSON and SSE without changing cost', () => {
  const json = parseMessagesReceipt({ bodyText: JSON.stringify(metadataMessageFor()), httpStatus: 200 });
  const sse = parseSSE(metadataSSEFor());
  for (const evidence of [json, sse]) {
    assert.equal(evidence.complete, true);
    // Canonical evidence keeps exactly the four counters; metadata is validated, not stored.
    assert.deepEqual(Object.keys(evidence.usage).sort(), ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens']);
    assert.deepEqual(evidence.cacheCreationBreakdown, { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 });
    assert.equal(validateSpendReceipt({ attempt: attempt(), evidence }).actualCostNano, 42n);
  }
  for (const nulls of [{ service_tier: null, inference_geo: null, speed: null, server_tool_use: null, output_tokens_details: null, iterations: null },
    { service_tier: undefined, inference_geo: undefined, speed: undefined, server_tool_use: undefined, output_tokens_details: undefined },
    { iterations: [], output_tokens_details: { thinking_tokens: null } }]) {
    const message = metadataMessageFor(nulls);
    assert.equal(parseMessagesReceipt({ bodyText: JSON.stringify(message), httpStatus: 200 }).complete, true, JSON.stringify(nulls));
    assert.equal(parseSSE(metadataSSEFor({ startUsage: nulls, deltaUsage: nulls })).complete, true, JSON.stringify(nulls));
  }
});
test('thinking tokens are inclusive observability and never charged a second time', () => {
  const json = parseMessagesReceipt({ bodyText: JSON.stringify(metadataMessageFor({ output_tokens_details: { thinking_tokens: 5 } })), httpStatus: 200 });
  const sse = parseSSE(metadataSSEFor({ deltaUsage: { output_tokens_details: { thinking_tokens: 5 } } }));
  for (const evidence of [json, sse]) {
    assert.equal(evidence.complete, true);
    assert.equal(evidence.usage.output_tokens, 5);
    assert.equal(validateSpendReceipt({ attempt: attempt(), evidence }).actualCostNano, 42n);
  }
});
for (const [name, usage] of NON_NEUTRAL_USAGE) test(`non-neutral usage ${name} is incomplete in JSON, message_start and message_delta`, () => {
  // The neutral baseline must be complete, or the negatives below prove nothing.
  assert.equal(parseMessagesReceipt({ bodyText: JSON.stringify(metadataMessageFor()), httpStatus: 200 }).complete, true, 'neutral JSON baseline');
  assert.equal(parseSSE(metadataSSEFor()).complete, true, 'neutral SSE baseline');
  assert.equal(parseMessagesReceipt({ bodyText: JSON.stringify(metadataMessageFor(usage)), httpStatus: 200 }).complete, false);
  assert.equal(parseSSE(metadataSSEFor({ deltaUsage: usage })).complete, false, 'message_delta');
  if (!usage.output_tokens_details) assert.equal(parseSSE(metadataSSEFor({ startUsage: usage })).complete, false, 'message_start');
});
test('message_delta usage keys are validated rather than ignored after a counters-only message_start', () => {
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const stream = usage => new TextEncoder().encode(
    event('message_start', { type: 'message_start', message: messageFor({ content: [], stop_reason: null, usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 1 } }) }) +
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, ...usage } }) +
    event('message_stop', { type: 'message_stop' }));
  assert.equal(parseSSE(stream({})).complete, true, 'counters-only control');
  for (const [name, usage] of NON_NEUTRAL_USAGE) assert.equal(parseSSE(stream(usage)).complete, false, name);
});
test('message_delta thinking tokens are bounded by the resulting cumulative output', () => {
  // Delta raises output to 5 in the same event, so 5 thinking tokens are within bounds.
  assert.equal(parseSSE(metadataSSEFor({ deltaUsage: { output_tokens_details: { thinking_tokens: 5 } } })).complete, true);
  // A delta omitting output_tokens is checked against the cumulative output from message_start (1).
  assert.equal(parseSSE(metadataSSEFor({ deltaUsage: { output_tokens: undefined, output_tokens_details: { thinking_tokens: 2 } } })).complete, false);
  assert.equal(parseSSE(metadataSSEFor({ deltaUsage: { output_tokens: undefined, output_tokens_details: { thinking_tokens: 1 } } })).complete, true);
});
test('missing or null token counters remain incomplete even with neutral metadata', () => {
  for (const field of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    for (const value of [undefined, null]) {
      const message = metadataMessageFor({ [field]: value });
      if (value === undefined) delete message.usage[field];
      assert.equal(parseMessagesReceipt({ bodyText: JSON.stringify(message), httpStatus: 200 }).complete, false, `${field}=${value}`);
      assert.equal(parseSSE(metadataSSEFor({ startUsage: { [field]: value === undefined ? undefined : null } })).complete, false, `start ${field}=${value}`);
    }
    assert.equal(parseSSE(metadataSSEFor({ deltaUsage: { [field]: null } })).complete, false, `delta ${field}=null`);
  }
});
test('empty content and model_context_window_exceeded are valid completions with bounds still enforced', () => {
  const empty = parseMessagesReceipt({ bodyText: JSON.stringify(metadataMessageFor({}, { content: [] })), httpStatus: 200 });
  assert.equal(empty.complete, true);
  const exceeded = parseMessagesReceipt({ bodyText: JSON.stringify(metadataMessageFor({ output_tokens: 11 }, { stop_reason: 'model_context_window_exceeded' })), httpStatus: 200 });
  assert.equal(exceeded.complete, true);
  assert.equal(validateSpendReceipt({ attempt: attempt(), evidence: exceeded }).boundsViolated, true);
  const sse = parseSSE(metadataSSEFor({ stopReason: 'model_context_window_exceeded' }));
  assert.equal(sse.complete, true);
  assert.equal(parseSSE(metadataSSEFor({ stopReason: 'surprise_stop' })).complete, false);
});
test('the returned model must equal the approved wire model exactly; aliases are not normalized', () => {
  for (const model of ['claude-sonnet-4-5', `${MODEL}-fast`, MODEL.toUpperCase()]) {
    const evidence = parseMessagesReceipt({ bodyText: JSON.stringify(metadataMessageFor({}, { model })), httpStatus: 200 });
    assert.equal(evidence.complete, true);
    assert.throws(() => validateSpendReceipt({ attempt: attempt(), evidence }), { code: 'invalid_receipt' });
  }
});
test('large token evidence retains exact BigInt additional liability', () => {
  const overflowingAttempt = { ...attempt(), maxInputTokens: Number.MAX_SAFE_INTEGER, maxOutputTokens: Number.MAX_SAFE_INTEGER, ratesNanoUSD: { input: 1n, cacheRead: 1n, cacheWrite1h: 1n, output: 9223372036854775807n }, reserveNano: 1n };
  const result = validateSpendReceipt({ attempt: overflowingAttempt, evidence: evidenceFor({ usage: { input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: Number.MAX_SAFE_INTEGER } }) });
  assert.equal(result.actualCostNano, BigInt(Number.MAX_SAFE_INTEGER) * 9223372036854775808n);
  assert.equal(result.additionalLiabilityNano, result.actualCostNano - 1n);
});
