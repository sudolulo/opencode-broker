import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayHealth, createTerminalParser, classifyHTTP } from '../lib/model-health.js';
import { createHealthProtocol, sha256 } from '../lib/proxy-health-context.js';

const sse = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

test('native terminal success is true only for valid terminal frames split across every byte', () => {
  const messages = sse('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [] } })
    + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
    + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + sse('message_stop', { type: 'message_stop' });
  const responses = sse('response.completed', { type: 'response.completed', response: { id: 'r', object: 'response', status: 'completed', output: [] } });
  const chat = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  for (const [api, good] of [['messages', messages], ['responses', responses], ['chat', chat]]) {
    const parser = createTerminalParser(api);
    for (const byte of Buffer.from(good)) parser.push(Uint8Array.of(byte));
    assert.equal(parser.finish({ status: 200, contentType: 'text/event-stream' }).state, 'complete');
    for (const bad of ['', good.slice(0, -8), 'data: {invalid}\n\n', good + 'data: {"type":"error"}\n\n']) {
      const rejected = createTerminalParser(api); rejected.push(bad);
      assert.notEqual(rejected.finish({ status: 200, contentType: 'text/event-stream' }).state, 'complete');
    }
    const cancelled = createTerminalParser(api); cancelled.push(good);
    assert.equal(cancelled.finish({ status: 200, contentType: 'text/event-stream', cancelled: true }).state, 'cancelled');
  }
});

test('terminal parser rejects malformed sources and classifies non-success terminal conditions', () => {
  const outOfOrder = createTerminalParser('messages');
  outOfOrder.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }));
  assert.equal(outOfOrder.finish({ status: 200, contentType: 'text/event-stream' }).state, 'invalid');
  const mismatch = createTerminalParser('responses');
  mismatch.push(sse('response.completed', { type: 'message_stop' }));
  assert.equal(mismatch.finish({ status: 200, contentType: 'text/event-stream' }).state, 'invalid');
  assert.deepEqual(createTerminalParser('chat').finish({ status: 503, contentType: 'application/json' }), { api: 'chat', state: 'http-error', status: 503, errorClass: 'service' });
  assert.deepEqual(createTerminalParser('chat').finish({ status: 200, contentType: 'text/event-stream', networkError: true }), { api: 'chat', state: 'invalid', status: 200, errorClass: 'network' });
  assert.equal(classifyHTTP(503, '{"error":{"type":"api_error"}}'), 'service');
  assert.equal(classifyHTTP(429, '{"error":{"type":"rate_limit_error"}}'), 'rate');
  assert.equal(classifyHTTP(429, 'service unavailable due to overload'), 'service');
  assert.equal(classifyHTTP(400, 'quota exhausted'), 'quota');
  assert.equal(classifyHTTP(401, '{}'), 'auth');
  assert.equal(classifyHTTP(422, '{}'), 'validation');
});

test('messages parser rejects terminal deltas before content blocks close', () => {
  const parser = createTerminalParser('messages');
  parser.push(sse('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [] } })
    + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    + sse('message_stop', { type: 'message_stop' }));
  assert.equal(parser.finish({ status: 200, contentType: 'text/event-stream' }).state, 'invalid');
});

test('messages parser rejects a negative content block index in an otherwise complete stream', () => {
  const parser = createTerminalParser('messages');
  parser.push(sse('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [] } })
    + sse('content_block_start', { type: 'content_block_start', index: -1, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { type: 'content_block_delta', index: -1, delta: { type: 'text_delta', text: 'ok' } })
    + sse('content_block_stop', { type: 'content_block_stop', index: -1 })
    + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    + sse('message_stop', { type: 'message_stop' }));
  assert.equal(parser.finish({ status: 200, contentType: 'text/event-stream' }).state, 'invalid');
});

test('terminal parser bounds one oversized frame while accepting many bounded frames', () => {
  const oversized = createTerminalParser('responses');
  oversized.push(`data: ${'x'.repeat(64 * 1024 * 1024)}\n\n`);
  assert.equal(oversized.finish({ status: 200, contentType: 'text/event-stream' }).state, 'invalid');

  const parser = createTerminalParser('responses');
  const progress = sse('response.in_progress', { type: 'response.in_progress' });
  for (let count = 0; count < 20000; count += 1) parser.push(progress);
  parser.push(sse('response.completed', { type: 'response.completed', response: { id: 'r', object: 'response', status: 'completed', output: [] } }));
  assert.equal(parser.finish({ status: 200, contentType: 'text/event-stream' }).state, 'complete');
});

test('terminal parser bounds binary decoding before oversized frames and later invalid UTF-8', (t) => {
  const decode = TextDecoder.prototype.decode, decodedSizes = [];
  t.mock.method(TextDecoder.prototype, 'decode', function (input, options) {
    if (input) decodedSizes.push(input.byteLength);
    return decode.call(this, input, options);
  });
  const prefix = Buffer.from('data: {"type":"response.in_progress","padding":"');
  const suffix = Buffer.from('"}\n\n' + sse('response.completed', { type: 'response.completed', response: { id: 'r', object: 'response', status: 'completed', output: [] } }));
  for (const invalidUTF8 of [false, true]) {
    const chunk = new Uint8Array(4 * 1024 * 1024).fill(0x78);
    chunk.set(prefix);
    chunk.set(suffix, chunk.length - suffix.length);
    if (invalidUTF8) chunk[2 * 1024 * 1024] = 0xff;
    decodedSizes.length = 0;
    const parser = createTerminalParser('responses');
    parser.push(chunk);
    assert.equal(parser.finish({ status: 200, contentType: 'text/event-stream' }).state, 'invalid');
    assert.ok(decodedSizes.length > 0);
    assert.ok(decodedSizes.every((size) => size <= 1024 * 1024), 'no decode exceeds the frame byte limit');
    assert.ok(decodedSizes.reduce((total, size) => total + size, 0) < 2 * 1024 * 1024, 'decoding stops before the invalid bytes beyond the limit');
  }
});

test('gateway health signs exact outbound bytes and bounds report delivery retries', async () => {
  const key = Buffer.alloc(32, 7), body = '{"model":"m","input":"ping"}', calls = [];
  const protocol = createHealthProtocol({ key, now: () => 1000 });
  const brokerRequest = async (path, value) => {
    calls.push({ path, value });
    if (path === '/model-health/begin') return { capability: Buffer.alloc(32, 3).toString('base64url'), nonce: Buffer.alloc(32, 1).toString('base64url'), startedAt: 1000 };
    if (calls.filter((call) => call.path === '/model-health/outcome').length === 1) throw new Error('temporary');
    return { ok: true };
  };
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', brokerRequest, now: () => 1000, sleepImpl: async () => {} });
  const leased = { sessionID: 's', leaseID: 'l', providerID: 'openai', expectedCredentialInstance: 'ci_' + Buffer.alloc(32, 2).toString('base64url') };
  const attempt = await health.begin({ leased, requestID: 'r', attemptID: 'a', purpose: 'real', bodyText: body, api: 'responses' });
  assert.equal(attempt.request[9], sha256(body));
  const attestation = protocol.signResponse([1, attempt.request[1], 'r', 'a', 'm', leased.expectedCredentialInstance, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(attempt.context)]);
  const ack = await health.finish(attempt, { responseHeaders: new Headers({ 'x-fleet-health-attestation': attestation.attestation, 'x-fleet-health-attestation-signature': attestation.attestationSignature }), terminal: { api: 'responses', state: 'complete', status: 200, errorClass: null }, finishedAt: 1000 });
  assert.deepEqual(ack, { ok: true });
  assert.equal(calls.filter((call) => call.path === '/model-health/outcome').length, 2);
});

test('gateway health refuses malformed or expired issuance tickets before signing a context', async () => {
  const key = Buffer.alloc(32, 7), body = '{"model":"m"}';
  const valid = { nonce: Buffer.alloc(32, 1).toString('base64url'), capability: Buffer.alloc(32, 2).toString('base64url'), startedAt: 1000, generation: 0 };
  const malformed = [
    null, [], {}, { ...valid, nonce: '' }, { ...valid, nonce: `${'A'.repeat(42)}B` }, { ...valid, nonce: `${valid.nonce}=` },
    { ...valid, capability: '' }, { ...valid, capability: `${'A'.repeat(42)}B` }, { ...valid, capability: `${valid.capability}=` },
    { ...valid, startedAt: '1000' }, { ...valid, startedAt: 1000.5 }, { ...valid, startedAt: -1 }, { ...valid, startedAt: 1001 },
    { ...valid, startedAt: 0 }, { ...valid, startedAt: Number.MAX_SAFE_INTEGER }, { ...valid, generation: '0' },
    { ...valid, generation: -1 }, { ...valid, generation: 0.5 }, { ...valid, generation: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const ticket of malformed) {
    const health = createGatewayHealth({ key, gatewayCredential: 'gateway', now: () => ticket?.startedAt === 0 ? 30000 : 1000, brokerRequest: async () => ticket });
    assert.equal(await health.begin({ leased: { sessionID: 's', leaseID: 'l', providerID: 'openai' }, requestID: 'r', attemptID: 'a', purpose: 'real', bodyText: body, api: 'chat' }), null);
  }
  for (const purpose of ['real', 'outage-health']) {
    const health = createGatewayHealth({ key, gatewayCredential: 'gateway', now: () => 1000, brokerRequest: async () => valid });
    const leased = { sessionID: 's', leaseID: 'l', providerID: 'openai', ...(purpose === 'outage-health' ? { expectedCredentialInstance: `ci_${Buffer.alloc(32, 3).toString('base64url')}` } : {}) };
    const attempt = await health.begin({ leased, requestID: 'r', attemptID: 'a', purpose, bodyText: body, api: 'chat' });
    assert.ok(attempt);
    assert.equal(attempt.ticket, valid);
  }
});

test('gateway health refuses malformed credential assertions and unrecognized purposes before broker issuance', async () => {
  const key = Buffer.alloc(32, 7), body = '{"model":"m"}';
  const validTicket = { nonce: Buffer.alloc(32, 1).toString('base64url'), capability: Buffer.alloc(32, 2).toString('base64url'), startedAt: 1000 };
  const validCredential = `ci_${Buffer.alloc(32, 3).toString('base64url')}`;
  const invalidCases = [
    ['outage-health', null],
    ['outage-health', 'ci_bad'],
    ['outage-health', `ci_${'A'.repeat(42)}B`],
    ['outage-health', 1],
    ['real', 'ci_bad'],
    ['real', `ci_${'A'.repeat(42)}B`],
    ['real', 1],
    ['client-claimed-outage-health', validCredential],
  ];
  for (const [purpose, expectedCredentialInstance] of invalidCases) {
    let begins = 0;
    const health = createGatewayHealth({ key, gatewayCredential: 'gateway', now: () => 1000, brokerRequest: async () => { begins += 1; return validTicket; } });
    const attempt = await health.begin({ leased: { sessionID: 's', leaseID: 'l', providerID: 'openai', expectedCredentialInstance }, requestID: 'r', attemptID: 'a', purpose, bodyText: body, api: 'chat' });
    assert.equal(attempt, null, `${purpose} / ${String(expectedCredentialInstance)} is refused`);
    assert.equal(begins, 0, `${purpose} / ${String(expectedCredentialInstance)} does not issue a ticket`);
  }
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', now: () => 1000, brokerRequest: async () => validTicket });
  assert.ok(await health.begin({ leased: { sessionID: 's', leaseID: 'l', providerID: 'openai' }, requestID: 'r', attemptID: 'a', purpose: 'real', bodyText: body, api: 'chat' }));
  assert.ok(await health.begin({ leased: { sessionID: 's', leaseID: 'l', providerID: 'openai', expectedCredentialInstance: validCredential }, requestID: 'r', attemptID: 'a', purpose: 'outage-health', bodyText: body, api: 'chat' }));
});

test('gateway health issuance tickets use the short outage expiry only for outage-health', async () => {
  const key = Buffer.alloc(32, 7), body = '{"model":"m"}';
  const ticket = { nonce: Buffer.alloc(32, 1).toString('base64url'), capability: Buffer.alloc(32, 2).toString('base64url'), startedAt: 1000 };
  const leased = { sessionID: 's', leaseID: 'l', providerID: 'openai', expectedCredentialInstance: `ci_${Buffer.alloc(32, 3).toString('base64url')}` };
  for (const [purpose, currentTime, expected] of [['outage-health', 10999, true], ['outage-health', 11000, false], ['real', 11000, true]]) {
    const health = createGatewayHealth({ key, gatewayCredential: 'gateway', now: () => currentTime, brokerRequest: async () => ticket });
    const attempt = await health.begin({ leased, requestID: 'r', attemptID: 'a', purpose, bodyText: body, api: 'chat' });
    assert.equal(Boolean(attempt), expected);
    if (attempt) assert.equal(attempt.request[3], purpose === 'outage-health' ? 11000 : 31000);
  }
});

test('gateway health never begins a second delivery after the overall deadline', async () => {
  const key = Buffer.alloc(32, 7), protocol = createHealthProtocol({ key }), request = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256('{"model":"m"}'), null];
  const signed = protocol.signRequest(request);
  const attestation = protocol.signResponse([1, request[1], 'r', 'a', 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(signed.context)]);
  let clock = 1000, deliveries = 0;
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', now: () => clock, sleepImpl: async () => { clock = 2001; }, brokerRequest: async () => { deliveries += 1; throw new Error('offline'); } });
  const attempt = { request, context: signed.context, contextSignature: signed.contextSignature, ticket: { capability: 'cap' } };
  const result = await health.finish(attempt, { responseHeaders: new Headers({ 'x-fleet-health-attestation': attestation.attestation, 'x-fleet-health-attestation-signature': attestation.attestationSignature }), terminal: { api: 'responses', state: 'complete', status: 200, errorClass: null }, finishedAt: 1000 });
  assert.equal(result, null);
  assert.equal(deliveries, 1);
});

test('gateway health returns at its wall-clock deadline when delivery never settles', { timeout: 2000 }, async () => {
  const key = Buffer.alloc(32, 7), protocol = createHealthProtocol({ key });
  const request = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256('{"model":"m"}'), null];
  const signed = protocol.signRequest(request);
  const attestation = protocol.signResponse([1, request[1], 'r', 'a', 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(signed.context)]);
  let deliveries = 0;
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', brokerRequest: async (path) => {
    if (path === '/model-health/outcome') { deliveries += 1; return new Promise(() => {}); }
    throw new Error('unexpected request');
  } });
  const attempt = { request, context: signed.context, contextSignature: signed.contextSignature, ticket: { capability: 'cap' } };
  const result = await health.finish(attempt, { responseHeaders: new Headers({ 'x-fleet-health-attestation': attestation.attestation, 'x-fleet-health-attestation-signature': attestation.attestationSignature }), terminal: { api: 'responses', state: 'complete', status: 200, errorClass: null }, finishedAt: 1000 });
  assert.equal(result, null);
  assert.equal(deliveries, 1);
});

test('gateway health does not accept a delivery that resolves after its deadline', { timeout: 2000 }, async () => {
  const key = Buffer.alloc(32, 7), protocol = createHealthProtocol({ key });
  const request = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256('{"model":"m"}'), null];
  const signed = protocol.signRequest(request);
  const attestation = protocol.signResponse([1, request[1], 'r', 'a', 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(signed.context)]);
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', brokerRequest: async (path) => {
    if (path === '/model-health/outcome') return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1050));
    throw new Error('unexpected request');
  } });
  const attempt = { request, context: signed.context, contextSignature: signed.contextSignature, ticket: { capability: 'cap' } };
  assert.equal(await health.finish(attempt, { responseHeaders: new Headers({ 'x-fleet-health-attestation': attestation.attestation, 'x-fleet-health-attestation-signature': attestation.attestationSignature }), terminal: {}, finishedAt: 1000 }), null);
});

test('gateway health handles rejection after its deadline without unhandled rejection or timer leaks', { timeout: 3000 }, async (t) => {
  const key = Buffer.alloc(32, 7), protocol = createHealthProtocol({ key });
  const request = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256('{"model":"m"}'), null];
  const signed = protocol.signRequest(request);
  const attestation = protocol.signResponse([1, request[1], 'r', 'a', 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(signed.context)]);
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const timers = new Set(), unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  let lateTimer, lateRejected = false, deliveries = 0, signalRejection;
  const rejectionFinished = new Promise((resolve) => { signalRejection = resolve; });
  process.on('unhandledRejection', onUnhandled);
  t.after(() => {
    process.off('unhandledRejection', onUnhandled);
    realClearTimeout(lateTimer);
    for (const timer of timers) realClearTimeout(timer);
  });
  // Track only timers created by finish; the deliberately late producer uses the real timer.
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = realSetTimeout(() => { timers.delete(timer); callback(...args); }, delay);
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => { timers.delete(timer); realClearTimeout(timer); });
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', brokerRequest: (path) => {
    assert.equal(path, '/model-health/outcome');
    deliveries += 1;
    return new Promise((resolve, reject) => {
      lateTimer = realSetTimeout(() => {
        lateRejected = true;
        reject(new Error('late outcome failure'));
        signalRejection();
      }, 1050);
    });
  } });
  const attempt = { request, context: signed.context, contextSignature: signed.contextSignature, ticket: { capability: 'cap' } };
  assert.equal(await health.finish(attempt, { responseHeaders: new Headers({ 'x-fleet-health-attestation': attestation.attestation, 'x-fleet-health-attestation-signature': attestation.attestationSignature }), terminal: {}, finishedAt: 1000 }), null);
  assert.equal(lateRejected, false, 'finish returns before the late rejection');
  assert.equal(timers.size, 0);
  await rejectionFinished;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateRejected, true);
  assert.deepEqual(unhandled, []);
  assert.equal(deliveries, 1);
  assert.equal(timers.size, 0);
});

test('gateway health drops unsigned or mismatched attestations without delivering an outcome', async () => {
  const key = Buffer.alloc(32, 7), protocol = createHealthProtocol({ key });
  const request = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256('{"model":"m"}'), null];
  const signed = protocol.signRequest(request);
  const good = protocol.signResponse([1, request[1], 'r', 'a', 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(signed.context)]);
  const signedWrong = (changes) => protocol.signResponse([1, changes.nonce ?? request[1], changes.requestID ?? 'r', changes.attemptID ?? 'a', changes.model ?? 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, changes.contextHash ?? sha256(signed.context)]);
  let deliveries = 0;
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', brokerRequest: async () => { deliveries += 1; return { ok: true }; } });
  const attempt = { request, context: signed.context, contextSignature: signed.contextSignature, ticket: { capability: 'cap' } };
  for (const signedFailure of [signedWrong({ nonce: Buffer.alloc(32, 2).toString('base64url') }), signedWrong({ requestID: 'wrong-request' }), signedWrong({ attemptID: 'wrong-attempt' }), signedWrong({ model: 'wrong-model' }), signedWrong({ contextHash: sha256('wrong-context') })]) {
    const headers = new Headers({ 'x-fleet-health-attestation': signedFailure.attestation, 'x-fleet-health-attestation-signature': signedFailure.attestationSignature });
    assert.equal(await health.finish(attempt, { responseHeaders: headers, terminal: {}, finishedAt: 1000 }), null);
  }
  assert.equal(await health.finish(attempt, { responseHeaders: new Headers(), terminal: {}, finishedAt: 1000 }), null);
  assert.equal(await health.finish(attempt, { responseHeaders: new Headers({ 'x-fleet-health-attestation': good.attestation, 'x-fleet-health-attestation-signature': 'A'.repeat(43) }), terminal: {}, finishedAt: 1000 }), null);
  assert.equal(deliveries, 0);
});

test('gateway health delivers an authenticated proxy-scope mismatch report', async () => {
  const key = Buffer.alloc(32, 7), protocol = createHealthProtocol({ key });
  const expected = 'ci_' + Buffer.alloc(32, 2).toString('base64url');
  const request = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256('{"model":"m"}'), expected];
  const signed = protocol.signRequest(request);
  const attestation = protocol.signResponse([1, request[1], 'r', 'a', 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'proxy-scope', null, sha256(signed.context)]);
  let deliveries = 0;
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', brokerRequest: async () => { deliveries += 1; return { ok: true }; } });
  const attempt = { request, context: signed.context, contextSignature: signed.contextSignature, ticket: { capability: 'cap' } };
  assert.deepEqual(await health.finish(attempt, { responseHeaders: new Headers({ 'x-fleet-health-attestation': attestation.attestation, 'x-fleet-health-attestation-signature': attestation.attestationSignature }), terminal: {}, finishedAt: 1000 }), { ok: true });
  assert.equal(deliveries, 1);
});

test('gateway health captures immutable verified response headers before any later mutation', async () => {
  const key = Buffer.alloc(32, 8), protocol = createHealthProtocol({ key });
  const request = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256('{"model":"m"}'), null];
  const signed = protocol.signRequest(request);
  const valid = protocol.signResponse([1, request[1], 'r', 'a', 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(signed.context)]);
  let deliveries = 0;
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', brokerRequest: async (path) => {
    if (path === '/model-health/outcome') { deliveries += 1; return { ok: true }; }
    throw new Error(`unexpected ${path}`);
  } });
  const attempt = { request, context: signed.context, contextSignature: signed.contextSignature, ticket: { capability: 'cap' } };
  const headers = new Headers({ 'x-fleet-health-attestation': valid.attestation, 'x-fleet-health-attestation-signature': valid.attestationSignature });
  const captured = health.captureResponse(attempt, headers);
  assert.equal(captured[11], 'upstream-response');
  headers.set('x-fleet-health-attestation', 'tampered');
  headers.set('x-fleet-health-attestation-signature', 'tampered');
  assert.deepEqual(await health.finish(attempt, { responseHeaders: headers, terminal: {}, finishedAt: 1000 }), { ok: true });
  assert.equal(deliveries, 1);
});

test('gateway health capture fail-closes later replacement attestations while standalone finish remains compatible', async () => {
  const key = Buffer.alloc(32, 6), protocol = createHealthProtocol({ key });
  const request = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256('{"model":"m"}'), null];
  const signed = protocol.signRequest(request);
  const valid = protocol.signResponse([1, request[1], 'r', 'a', 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(signed.context)]);
  let deliveries = 0;
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', brokerRequest: async (path) => {
    if (path === '/model-health/outcome') { deliveries += 1; return { ok: true }; }
    throw new Error(`unexpected ${path}`);
  } });
  const attempt = { request, context: signed.context, contextSignature: signed.contextSignature, ticket: { capability: 'cap' } };
  const headers = new Headers();
  assert.equal(health.captureResponse(attempt, headers), null);
  headers.set('x-fleet-health-attestation', valid.attestation);
  headers.set('x-fleet-health-attestation-signature', valid.attestationSignature);
  assert.equal(await health.finish(attempt, { responseHeaders: headers, terminal: {}, finishedAt: 1000 }), null);
  assert.equal(deliveries, 0);
  const uncaptured = { ...attempt, ticket: { capability: 'uncaptured' } };
  assert.deepEqual(await health.finish(uncaptured, { responseHeaders: headers, terminal: {}, finishedAt: 1000 }), { ok: true });
  assert.equal(deliveries, 1);
});

test('gateway health capture is first-write immutable across repeated capture calls', async () => {
  const key = Buffer.alloc(32, 5), protocol = createHealthProtocol({ key });
  const request = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256('{"model":"m"}'), null];
  const signed = protocol.signRequest(request);
  const valid = protocol.signResponse([1, request[1], 'r', 'a', 'm', null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(signed.context)]);
  let deliveries = 0;
  const health = createGatewayHealth({ key, gatewayCredential: 'gateway', brokerRequest: async (path, body) => {
    if (path === '/model-health/outcome') { deliveries += 1; return { attestation: body.attestation }; }
    throw new Error(`unexpected ${path}`);
  } });
  const attempt = { request, context: signed.context, contextSignature: signed.contextSignature, ticket: { capability: 'cap' } };
  const invalid = new Headers();
  assert.equal(health.captureResponse(attempt, invalid), null);
  const validHeaders = new Headers({ 'x-fleet-health-attestation': valid.attestation, 'x-fleet-health-attestation-signature': valid.attestationSignature });
  assert.equal(health.captureResponse(attempt, validHeaders), null);
  assert.equal(await health.finish(attempt, { responseHeaders: validHeaders, terminal: {}, finishedAt: 1000 }), null);
  assert.equal(deliveries, 0);

  const validAttempt = { ...attempt, ticket: { capability: 'valid-cap' } };
  const tuple = health.captureResponse(validAttempt, validHeaders);
  assert.throws(() => { tuple[11] = 'proxy-scope'; }, TypeError);
  const tampered = new Headers({ 'x-fleet-health-attestation': 'invalid', 'x-fleet-health-attestation-signature': 'invalid' });
  assert.equal(health.captureResponse(validAttempt, tampered), tuple);
  assert.deepEqual(await health.finish(validAttempt, { responseHeaders: tampered, terminal: {}, finishedAt: 1000 }), { attestation: valid.attestation });
  assert.equal(deliveries, 1);
});
