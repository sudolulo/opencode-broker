import test from 'node:test';
import assert from 'node:assert/strict';
import { FINGERPRINT, MODEL, NOW, OPUS_MODEL, ORIGIN, PROVIDER_ID, bodyFor, headersFor, policyFor, preparedFor, rawPolicy } from './helpers/spend-fixture.mjs';
import { normalizeSpendPolicy, prepareSpendAttempt } from '../lib/spend-policy.js';

const ledger = '/synthetic/wallet.sqlite';
const LEGACY_HASH = '50a945d5f24e04aa262a470e6331d8eb46bd6376e15c139b9ea0835d7dcf5608';
test('maximum context, not short text, sets the reservation', () => {
  assert.equal(preparedFor(policyFor(ledger)).reserveNano, 350n);
});
test('unknown policy keys are rejected', () => {
  assert.throws(() => normalizeSpendPolicy(rawPolicy(ledger, { monthlyUSD: '200' })), { code: 'invalid_policy' });
});
test('decimal and mixed-cache charges are exact', () => {
  assert.throws(() => normalizeSpendPolicy(rawPolicy(ledger, { ceilingUSD: '0.0000000001' })), { code: 'invalid_policy' });
  const policy = normalizeSpendPolicy(rawPolicy(ledger, { ceilingUSD: '0.0000000019' }));
  assert.equal(policy.ceilingNano, 1n);
  assert.equal(policy.models[MODEL].ratesNanoUSD.cacheWrite1h, 3n);
});
test('policy canonicalization is order independent and immutable', () => {
  const a = rawPolicy(ledger);
  const b = { models: a.models, binding: a.binding, ceilingUSD: a.ceilingUSD, validUntil: a.validUntil, policyID: a.policyID, ledgerPath: a.ledgerPath, reconcileUsage: false };
  const policy = normalizeSpendPolicy(a);
  assert.equal(policy.policyHash, normalizeSpendPolicy(b).policyHash);
  assert.throws(() => { policy.models[MODEL].maxInputTokens = 1; }, TypeError);
  assert.equal(policy.models[MODEL].maxInputTokens, 100);
});
test('legacy policies keep their exact pre-allocation hash', () => {
  assert.equal(normalizeSpendPolicy(rawPolicy('/synthetic/legacy-hash-wallet.sqlite')).policyHash, LEGACY_HASH);
  assert.equal(normalizeSpendPolicy(rawPolicy('/synthetic/legacy-hash-wallet.sqlite'), { targetID: 'ignored-target', providerID: PROVIDER_ID, modelID: MODEL }).policyHash, LEGACY_HASH);
});
test('allocation policies normalize exact money, hash allocations, and require complete valid splits', () => {
  const allocations = { continuationUSD: '150.000000000', manualReserveUSD: '50', releaseWindowHours: 48 };
  const registered = { targetID: 'target', providerID: PROVIDER_ID, modelID: MODEL };
  const policy = normalizeSpendPolicy(rawPolicy(ledger, { ceilingUSD: '200', allocations }), registered);
  assert.deepEqual(policy.allocations, { continuationUSD: '150', manualReserveUSD: '50', continuationNano: 150000000000n, manualReserveNano: 50000000000n, releaseWindowHours: 48, releaseWindowMs: 172800000 });
  assert.notEqual(policy.policyHash, normalizeSpendPolicy(rawPolicy(ledger, { ceilingUSD: '200', allocations: { ...allocations, releaseWindowHours: 49 } }), registered).policyHash);
  for (const invalid of [
    { continuationUSD: '150', manualReserveUSD: '49.999999999', releaseWindowHours: 48 },
    { continuationUSD: '150', manualReserveUSD: '50.0000000001', releaseWindowHours: 48 },
    { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 0 },
    { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 745 },
    { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 1.5 },
    { continuationUSD: '0', manualReserveUSD: '200', releaseWindowHours: 48 },
    { continuationUSD: 150, manualReserveUSD: '50', releaseWindowHours: 48 },
    { continuationUSD: '9223372036.854775808', manualReserveUSD: '50', releaseWindowHours: 48 },
    { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 48, unexpected: true },
  ]) assert.throws(() => normalizeSpendPolicy(rawPolicy(ledger, { ceilingUSD: '200', allocations: invalid })), { code: 'invalid_policy' });
});
test('split policies require and bind the registered target, provider, and model identity', () => {
  const raw = rawPolicy(ledger, { ceilingUSD: '200', allocations: { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 48 } });
  const registered = { targetID: 'target-a', providerID: PROVIDER_ID, modelID: MODEL };
  assert.throws(() => normalizeSpendPolicy(raw), { code: 'invalid_policy' });
  const policy = normalizeSpendPolicy(raw, registered);
  assert.notEqual(policy.policyHash, normalizeSpendPolicy(raw, { ...registered, targetID: 'target-b' }).policyHash);
  assert.notEqual(policy.policyHash, normalizeSpendPolicy(raw, { ...registered, modelID: OPUS_MODEL }).policyHash);
  assert.throws(() => normalizeSpendPolicy(raw, { ...registered, providerID: 'other-provider' }), { code: 'invalid_policy' });
  assert.throws(() => normalizeSpendPolicy(raw, { targetID: 'target-a', providerID: PROVIDER_ID, modelID: 'unknown' }), { code: 'invalid_policy' });
});
test('allocation-enabled admissions require an exact broker grant and bind it into the digest', () => {
  const registered = { targetID: 'target', providerID: PROVIDER_ID, modelID: MODEL };
  const policy = normalizeSpendPolicy(rawPolicy(ledger, { ceilingUSD: '200', allocations: { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 48 } }), registered);
  const grant = { version: 1, grantID: '11111111-1111-4111-8111-111111111111', purpose: 'manual', sessionID: 'session', leaseID: 'lease', targetID: 'target', providerID: PROVIDER_ID, modelID: MODEL, profile: 'Manual Model', tier: 'paid', issuedAtMs: NOW - 1, expiresAtMs: NOW + 1, policyRevision: policy.policyHash, source: null };
  assert.throws(() => preparedFor(policy), { code: 'invalid_authorization' });
  const prepare = (targetID, spendGrant) => prepareSpendAttempt({ policy, providerID: PROVIDER_ID, targetID, url: `${ORIGIN}/v1/messages`, body: bodyFor(), headers: headersFor(), credentialFingerprint: FINGERPRINT, now: NOW, spendGrant });
  const prepared = prepare('target', grant);
  assert.deepEqual(prepared.spendGrant, grant);
  assert.throws(() => prepare('other-target', grant), { code: 'invalid_authorization' });
  assert.throws(() => prepare('target', { ...grant, targetID: 'other-target' }), { code: 'invalid_authorization' });
  assert.throws(() => prepare('target', { ...grant, modelID: 'wrong' }), { code: 'invalid_authorization' });
});
test('split admission preserves malformed and expired grant authorization failures', () => {
  const policy = normalizeSpendPolicy(rawPolicy(ledger, { ceilingUSD: '200', allocations: { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 48 } }), { targetID: 'target', providerID: PROVIDER_ID, modelID: MODEL });
  const grant = { version: 1, grantID: '11111111-1111-4111-8111-111111111111', purpose: 'manual', sessionID: 'session', leaseID: 'lease', targetID: 'target', providerID: PROVIDER_ID, modelID: MODEL, profile: 'Manual Model', tier: 'paid', issuedAtMs: NOW - 1, expiresAtMs: NOW + 1, policyRevision: policy.policyHash, source: null };
  const attempt = spendGrant => prepareSpendAttempt({ policy, providerID: PROVIDER_ID, targetID: 'target', url: `${ORIGIN}/v1/messages`, body: bodyFor(), headers: headersFor(), credentialFingerprint: FINGERPRINT, now: NOW, spendGrant });
  assert.throws(() => attempt({ ...grant, issuedAtMs: NOW + 1 }), { code: 'invalid_authorization' });
  assert.throws(() => attempt({ ...grant, expiresAtMs: NOW }), { code: 'invalid_authorization' });
});
test('closed envelope refuses paid controls and accepts inert client tool JSON', () => {
  const policy = policyFor(ledger);
  for (const override of [{ service_tier: 'auto' }, { mcp_servers: [] }, { container: {} }, { batch: true }, { unknown: true }, { tools: [{ type: 'computer_20241022', name: 'server' }] }]) {
    assert.throws(() => preparedFor(policy, override), { code: 'unsupported_request' });
  }
  assert.equal(preparedFor(policy, { tools: [{ name: 'local', description: 'inert schema', input_schema: { type: 'object', properties: { cost: { type: 'string' } } } }], tool_choice: { type: 'tool', name: 'local' } }).model, MODEL);
});
test('request binding rejects alternate transport and ambiguous controls', () => {
  const policy = policyFor(ledger);
  const call = overrides => prepareSpendAttempt({ policy, providerID: PROVIDER_ID, url: `${ORIGIN}/v1/messages`, body: bodyFor(), headers: headersFor(), credentialFingerprint: FINGERPRINT, now: NOW, ...overrides });
  for (const overrides of [
    { providerID: 'wrong' }, { url: 'https://example.com/v1/messages' }, { url: `${ORIGIN}/v1/messages?q=1` }, { url: `https://user@api.anthropic.com/v1/messages` }, { url: `${ORIGIN}/v1/complete` }, { credentialFingerprint: '0'.repeat(64) },
    { headers: headersFor({ 'anthropic-beta': 'fast' }) }, { headers: headersFor({ 'x-region': 'us-east-1' }) }, { headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'a', Authorization: 'b' } },
  ]) assert.throws(() => call(overrides), { code: 'unsupported_request' });
});
test('strict token, thinking, and nested content limits prevent under-reservation', () => {
  const policy = policyFor(ledger);
  for (const override of [{ max_tokens: 0 }, { max_tokens: -1 }, { max_tokens: 1.5 }, { max_tokens: 11 }, { model: 'unknown' }, { thinking: { type: 'enabled', budget_tokens: 11 } }, { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }] }] }]) {
    assert.throws(() => preparedFor(policy, override), { code: 'unsupported_request' });
  }
  assert.equal(preparedFor(policy, { max_tokens: 10, thinking: { type: 'enabled', budget_tokens: 10 } }).maxOutputTokens, 10);
});
test('digests bind final bytes but never change policy identity', () => {
  const policy = policyFor(ledger);
  const first = preparedFor(policy);
  const second = prepareSpendAttempt({ policy, providerID: PROVIDER_ID, url: `${ORIGIN}/v1/messages`, body: JSON.stringify({ stream: false, max_tokens: 10, messages: [{ content: 'hello', role: 'user' }], model: MODEL, service_tier: 'standard_only' }), headers: headersFor(), credentialFingerprint: FINGERPRINT, now: NOW });
  assert.notEqual(first.bodyDigest, second.bodyDigest);
  assert.notEqual(first.requestDigest, second.requestDigest);
  assert.equal(first.policyHash, second.policyHash);
});
test('duplicate request fields are refused instead of silently selecting a billing value', () => {
  const policy = policyFor(ledger);
  const body = bodyFor().replace('"max_tokens":10', '"max_tokens":10,"max_tokens":1');
  assert.throws(() => prepareSpendAttempt({ policy, providerID: PROVIDER_ID, url: `${ORIGIN}/v1/messages`, body, headers: headersFor(), credentialFingerprint: FINGERPRINT, now: NOW }), { code: 'unsupported_request' });
});
test('closed nested envelopes permit only documented fields and bounded cache controls', () => {
  const policy = policyFor(ledger);
  const accepted = {
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'hello', cache_control: { type: 'ephemeral', ttl: '5m' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' }, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ] }],
    tools: [{ name: 'local', input_schema: { type: 'object', arbitrary_data: { provider: 'not-control' } } }],
    tool_choice: { type: 'tool', name: 'local', disable_parallel_tool_use: true },
    thinking: { type: 'disabled' },
  };
  assert.equal(preparedFor(policy, accepted).model, MODEL);
  for (const override of [
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'x', surprise: true }] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u', content: [{ type: 'text', text: 'nested', surprise: true }] }] }] },
    { system: [{ type: 'text', text: 'x', unknown: true }] },
    { tool_choice: { type: 'auto', unexpected: true } },
    { thinking: { type: 'disabled', budget_tokens: 1 } },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: 'forever' } }] }] },
  ]) assert.throws(() => preparedFor(policy, override), { code: 'unsupported_request' });
});
test('policy hash canonicalizes decimal representations and policy origins are exact origins', () => {
  const canonical = normalizeSpendPolicy(rawPolicy(ledger, { ceilingUSD: '0.000050000' }));
  const equivalent = normalizeSpendPolicy(rawPolicy(ledger, { ceilingUSD: '0.00005' }));
  assert.equal(canonical.policyHash, equivalent.policyHash);
  for (const origin of [`${ORIGIN}/v1/messages`, `${ORIGIN}?x=1`, `${ORIGIN}#fragment`, 'https://user@api.anthropic.com']) {
    assert.throws(() => normalizeSpendPolicy(rawPolicy(ledger, { binding: { providerID: PROVIDER_ID, origin, credentialSHA256: FINGERPRINT } })), { code: 'invalid_policy' });
  }
});
test('final credential bytes and pinned headers must match their policy binding', () => {
  const policy = policyFor(ledger);
  const call = headers => prepareSpendAttempt({ policy, providerID: PROVIDER_ID, url: `${ORIGIN}/v1/messages`, body: bodyFor(), headers, credentialFingerprint: FINGERPRINT, now: NOW });
  assert.equal(call(headersFor()).credentialFingerprint, FINGERPRINT);
  for (const headers of [
    headersFor({ 'x-api-key': 'not-the-bound-key' }),
    headersFor({ 'anthropic-version': '2024-01-01' }),
    headersFor({ 'content-type': 'text/plain' }),
    { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'X-API-Key': 'synthetic-not-a-provider-key', 'x-api-key': 'synthetic-not-a-provider-key' },
    new Headers([['content-type', 'application/json'], ['anthropic-version', '2023-06-01'], ['x-api-key', 'synthetic-not-a-provider-key'], ['X-API-Key', 'synthetic-not-a-provider-key']]),
  ]) assert.throws(() => call(headers), { code: 'unsupported_request' });
  assert.throws(() => prepareSpendAttempt({ policy, providerID: PROVIDER_ID, url: `${ORIGIN}/v1/messages`, body: bodyFor(), headers: headersFor(), credentialFingerprint: FINGERPRINT, now: policy.validUntilMs }), { code: 'unsupported_request' });
});
test('model lookup has no inherited or constructor escape', () => {
  const policy = policyFor(ledger);
  for (const model of ['__proto__', 'constructor']) {
    assert.throws(() => preparedFor(policy, { model }), { code: 'unsupported_request' });
  }
});
