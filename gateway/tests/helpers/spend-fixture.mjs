import { createHash } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSpendPolicy, prepareSpendAttempt } from '../../lib/spend-policy.js';

export const NOW = Date.parse('2026-10-20T12:00:00.000Z');
export const MODEL = 'claude-sonnet-4-5-20250929';
export const OPUS_MODEL = 'claude-opus-4-1-20250805';
export const PROVIDER_ID = 'manual-anthropic-fixture';
export const ORIGIN = 'https://api.anthropic.com';
export const TEST_KEY = 'synthetic-not-a-provider-key';
export const ATTEMPT_A = '11111111-1111-4111-8111-111111111111';
export const ATTEMPT_B = '22222222-2222-4222-8222-222222222222';
export const FINGERPRINT = createHash('sha256').update(TEST_KEY).digest('hex');

export function rawPolicy(ledgerPath, overrides = {}) {
  return {
    ledgerPath,
    policyID: 'fixture-v1',
    validUntil: '2026-10-21T12:00:00.000Z',
    ceilingUSD: '0.000050000',
    binding: { providerID: PROVIDER_ID, origin: ORIGIN, credentialSHA256: FINGERPRINT },
    reconcileUsage: false,
    models: {
      [MODEL]: { maxInputTokens: 100, maxOutputTokens: 10, ratesNanoUSD: { input: '2', cacheRead: '1', cacheWrite1h: '3', output: '5' } },
      [OPUS_MODEL]: { maxInputTokens: 200, maxOutputTokens: 20, ratesNanoUSD: { input: '4', cacheRead: '2', cacheWrite1h: '6', output: '10' } },
    },
    ...overrides,
  };
}

export const policyFor = (ledgerPath, overrides = {}) => normalizeSpendPolicy(rawPolicy(ledgerPath, overrides));
export function bodyFor(overrides = {}) {
  return JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], max_tokens: 10, stream: false, service_tier: 'standard_only', ...overrides });
}
export function headersFor(overrides = {}) {
  const headers = new Headers({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': TEST_KEY });
  for (const [key, value] of Object.entries(overrides)) headers.set(key, value);
  return headers;
}
export const preparedFor = (policy, bodyOverrides = {}) => prepareSpendAttempt({ policy, providerID: PROVIDER_ID, url: `${ORIGIN}/v1/messages`, body: bodyFor(bodyOverrides), headers: headersFor(), credentialFingerprint: FINGERPRINT, now: NOW });
export function allocationFor(amountUSD = '0.000000700', overrides = {}) {
  return { amountUSD, reference: 'promo-fixture-1', confirmedAt: '2026-10-20T11:00:00.000Z', expiresAt: '2026-10-21T11:00:00.000Z', providerID: PROVIDER_ID, origin: ORIGIN, credentialFingerprint: FINGERPRINT, exclusivePromotionalAllocation: true, ...overrides };
}
export function messageFor(overrides = {}) {
  return { id: 'msg_fixture_1', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5 }, ...overrides };
}
export function evidenceFor(overrides = {}) {
  return { kind: 'json', complete: true, messageID: 'msg_fixture_1', model: MODEL, usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5 }, cacheCreationBreakdown: null, initialOutputTokens: null, errorCode: null, ...overrides };
}
export function snapshotFor(prepared, overrides = {}) {
  const { policyHash, providerID, origin, credentialFingerprint, model, maxInputTokens, maxOutputTokens, ratesNanoUSD, reserveNano, bodyDigest, requestDigest } = prepared;
  return { attemptID: ATTEMPT_A, epochID: '33333333-3333-4333-8333-333333333333', policyHash, providerID, origin, credentialFingerprint, model, maxInputTokens, maxOutputTokens, ratesNanoUSD, reserveNano, bodyDigest, requestDigest, ...overrides };
}
function event(type, data) { return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; }
export function sseFor() {
  return new TextEncoder().encode(
    event('message_start', { type: 'message_start', message: { ...messageFor(), content: [], stop_reason: null, usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 1 } } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }) +
    event('message_stop', { type: 'message_stop' }),
  );
}
// Real-shaped neutral metadata that current Messages responses carry on every
// usage block: standard tier/speed, global geography, zero server tool use and
// inclusive thinking-token observability. None of it changes the four counters.
export function neutralUsageMetadata(overrides = {}) {
  return { service_tier: 'standard', inference_geo: 'global', speed: 'standard',
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    output_tokens_details: { thinking_tokens: 0 }, ...overrides };
}
export function metadataMessageFor(usageOverrides = {}, overrides = {}) {
  return messageFor({ usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 }, ...neutralUsageMetadata(), ...usageOverrides }, ...overrides });
}
// startUsage/deltaUsage overrides replace or add keys; a value of undefined removes the key.
export function metadataSSEFor({ startUsage = {}, deltaUsage = {}, stopReason = 'end_turn' } = {}) {
  const strip = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  const start = strip({ input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 1,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 }, ...neutralUsageMetadata(), ...startUsage });
  const delta = strip({ input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, ...deltaUsage });
  return new TextEncoder().encode(
    event('message_start', { type: 'message_start', message: { ...messageFor(), content: [], stop_reason: null, usage: start } }) +
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
    event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: delta }) +
    event('message_stop', { type: 'message_stop' }),
  );
}
// Usage variants which are documented, price-affecting or unbounded, so they can
// never support a receipt (and therefore never a refund).
export const NON_NEUTRAL_USAGE = [
  ['priority tier', { service_tier: 'priority' }],
  ['batch tier', { service_tier: 'batch' }],
  ['US inference geography', { inference_geo: 'us' }],
  ['fast speed', { speed: 'fast' }],
  ['nonzero web search', { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } }],
  ['nonzero web fetch', { server_tool_use: { web_search_requests: 0, web_fetch_requests: 2 } }],
  ['partial server tool object', { server_tool_use: { web_search_requests: 0 } }],
  ['code execution counter', { server_tool_use: { web_search_requests: 0, web_fetch_requests: 0, code_execution_requests: 0 } }],
  ['unknown server tool counter', { server_tool_use: { web_search_requests: 0, web_fetch_requests: 0, surprise_requests: 0 } }],
  ['thinking beyond output', { output_tokens_details: { thinking_tokens: 6 } }],
  ['negative thinking', { output_tokens_details: { thinking_tokens: -1 } }],
  ['unknown output detail', { output_tokens_details: { thinking_tokens: 0, premium_tokens: 0 } }],
  ['nonempty iterations', { iterations: [{ type: 'message', input_tokens: 1, output_tokens: 1 }] }],
  ['unknown usage key', { surprise_bill: 0 }],
  ['unknown tier value type', { service_tier: 1 }],
];
export function chunksOf(bytes, width) {
  if (!Number.isSafeInteger(width) || width <= 0) throw new RangeError('width must be positive');
  const chunks = [];
  for (let index = 0; index < bytes.length; index += width) chunks.push(bytes.subarray(index, index + width));
  return chunks;
}
export async function withLedgerDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-spend-'));
  await chmod(dir, 0o700);
  try { return await fn(join(dir, 'wallet.sqlite')); } finally { await rm(dir, { recursive: true, force: true }); }
}
export const confirmedRefundPolicy = ledgerPath => policyFor(ledgerPath, { reconcileUsage: true, billingReceiptContract: { confirmedAt: '2026-10-20T10:00:00.000Z', reference: 'synthetic-contract-fixture' } });
