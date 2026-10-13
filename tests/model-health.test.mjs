import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHealthAuthority } from '../lib/model-health.js';
import { makePolicy } from './helpers/model-outages.mjs';

const bodySHA256 = 'a'.repeat(64);
const nonce = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const proxyVectors = Object.freeze({
  context: 'WzEsIkFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUEiLDEwMDAsMTEwMDAsInJlcXVlc3QtMSIsImF0dGVtcHQtMSIsInJlYWwiLCJhbnRocm9waWMiLCJjbGF1ZGUtb3B1cy01LTUiLCJhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIixudWxsXQ',
  contextSignature: 'dZa1yxJKNGhTe4cvnMCL8V8bt2pnBWgZ6lKVyYJj-EM',
  attestation: 'WzEsIkFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUEiLCJyZXF1ZXN0LTEiLCJhdHRlbXB0LTEiLCJjbGF1ZGUtb3B1cy01LTUiLCJjaV9maXh0dXJlIiwibGxtLWF1dGgtcHJveHkvYW50aHJvcGljIiwiaHR0cHM6Ly9hcGkuYW50aHJvcGljLmNvbSIsImNsYXVkZS1jb2RlLW9hdXRoIiwibWVzc2FnZXMiLCJjbGF1ZGUtY29kZSIsInVwc3RyZWFtLXJlc3BvbnNlIiwyMDAsImNvbnRleHQtaGFzaCJd',
  attestationSignature: 'F7WB16-fJVTgIQoFVYxF-DihbZyOJFpRQniFUSGgPs0',
});

test('fixed proxy HMAC vectors use canonical base64url request and response domains', () => {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const mac = (domain, encoded) => createHmac('sha256', key).update(domain).update(encoded).digest('base64url');
  const terminator = String.fromCharCode(0);
  const canonicalContext = Buffer.from(JSON.stringify([1, nonce, 1000, 11000, 'request-1', 'attempt-1', 'real', 'anthropic', 'claude-opus-5-5', bodySHA256, null]), 'utf8').toString('base64url');
  assert.equal(canonicalContext, proxyVectors.context);
  assert.equal(Buffer.from(proxyVectors.context, 'base64url').toString('base64url'), proxyVectors.context);
  assert.equal(Buffer.from(proxyVectors.attestation, 'base64url').toString('base64url'), proxyVectors.attestation);
  assert.deepEqual(JSON.parse(Buffer.from(proxyVectors.context, 'base64url')), [1, nonce, 1000, 11000, 'request-1', 'attempt-1', 'real', 'anthropic', 'claude-opus-5-5', bodySHA256, null]);
  assert.equal(mac(`fleet-health/request/v1${terminator}`, proxyVectors.context), proxyVectors.contextSignature);
  assert.equal(mac(`fleet-health/response/v1${terminator}`, proxyVectors.attestation), proxyVectors.attestationSignature);
});

function makeAuthority({ terminal = { api: 'messages', state: 'complete', status: 200, errorClass: null }, origin = 'upstream-response', expectedCredentialInstance = null } = {}) {
  let time = 1000;
  let generation = 1;
  let held = true;
  let lastFailure = 0;
  const policy = makePolicy();
  const route = policy.expectedScopePolicies['anthropic/opus/standard'];
  const authority = createHealthAuthority({
    gatewayCredential: 'private-test-only',
    now: () => time,
    randomBytes: (size) => Buffer.alloc(size, 4),
    lookupGeneration: () => generation,
    latestFailureAt: () => lastFailure,
    lookupLease: () => held ? {
      held: true, sessionID: 's', leaseID: 'l', targetID: 'claude-opus-5-5', providerID: 'anthropic',
      modelID: 'claude-opus-5-5', wireModelID: 'claude-opus-5-5', primaryID: 'claude-opus-5-5',
      logicalID: 'anthropic/opus/standard', purpose: 'real', expectedScopePolicy: route,
      expectedCredentialInstance,
    } : null,
    verifyAttestation: (_report, binding) => ({
      request: [1, binding.nonce, binding.startedAt, binding.startedAt + 10000, binding.requestID, binding.attemptID,
        binding.purpose, binding.providerID, binding.wireModelID, binding.bodySHA256, binding.expectedCredentialInstance],
      attestation: [1, binding.nonce, binding.requestID, binding.attemptID, binding.wireModelID, 'ci_actual',
        'llm-auth-proxy/anthropic', 'https://api.anthropic.com', 'claude-code-oauth', 'messages', 'claude-code',
        origin, 200, 'context-hash'],
    }),
  });
  const ticket = authority.issue({ gatewayCredential: 'private-test-only', sessionID: 's', leaseID: 'l',
    requestID: 'r', attemptID: 'a', purpose: 'real', modelID: 'claude-opus-5-5', bodySHA256 });
  const report = { gatewayCredential: 'private-test-only', capability: ticket.capability, context: 'fixture',
    contextSignature: 'fixture', attestation: 'fixture', attestationSignature: 'fixture', terminal, finishedAt: 1100 };
  return { authority, ticket, report, setTime: (value) => { time = value; }, invalidate: () => { generation++; held = false; }, setLastFailure: (value) => { lastFailure = value; } };
}

test('acceptance rejects malformed terminal values before consuming a valid capability', () => {
  const malformedTerminals = [
    { api: 'messages', state: 'invalid', status: {}, errorClass: 'network' },
    { api: 'messages', state: 'invalid', status: [], errorClass: 'network' },
    { api: 'messages', state: 'invalid', status: null, errorClass: 'network' },
    { api: 'messages', state: 'invalid', status: '0', errorClass: 'network' },
    { api: 'messages', state: 'invalid', status: false, errorClass: 'network' },
    { api: 'messages', state: 'invalid', status: 200.5, errorClass: 'network' },
    { api: 'messages', state: 'invalid', status: -1, errorClass: 'network' },
    { api: 'messages', state: 'invalid', status: 99, errorClass: 'network' },
    { api: 'messages', state: 'invalid', status: 600, errorClass: 'network' },
    { api: 'messages', state: 'invalid', status: 0, errorClass: 'unknown' },
    { api: 'messages', state: 'invalid', status: 0, errorClass: {} },
    { api: 'messages', state: 'invalid', status: 0, errorClass: undefined },
  ];
  for (const terminal of malformedTerminals) {
    const fixture = makeAuthority({ origin: 'proxy-scope', terminal });
    fixture.setTime(1100);
    assert.throws(() => fixture.authority.accept(fixture.report), /terminal/);
    const corrected = fixture.authority.accept({ ...fixture.report,
      terminal: { api: 'messages', state: 'complete', status: 200, errorClass: null } });
    assert.equal(corrected.duplicate, false);
    assert.equal(corrected.outcome.result, 'scope-mismatch');
    fixture.authority.close();
  }
});

test('acceptance permits valid HTTP terminal statuses and parser no-response status zero forms', () => {
  for (const terminal of [
    { api: 'messages', state: 'complete', status: 200, errorClass: null },
    { api: 'messages', state: 'http-error', status: 409, errorClass: 'validation' },
    { api: 'messages', state: 'invalid', status: 0, errorClass: 'network' },
    { api: 'messages', state: 'cancelled', status: 0, errorClass: null },
  ]) {
    const fixture = makeAuthority({ origin: 'proxy-scope', terminal });
    fixture.setTime(1100);
    const accepted = fixture.authority.accept(fixture.report);
    assert.equal(accepted.outcome.result, 'scope-mismatch');
    fixture.authority.close();
  }
});

test('identical authenticated replay precedes generation check and changed replay rejects', () => {
  const fixture = makeAuthority();
  fixture.setTime(1100);
  const first = fixture.authority.accept(fixture.report);
  assert.equal(first.outcome.credentialInstance, 'ci_actual');
  fixture.authority.markApplied(fixture.ticket.capability);
  fixture.invalidate();
  assert.equal(fixture.authority.accept(fixture.report).duplicate, true);
  assert.throws(() => fixture.authority.accept({ ...fixture.report, finishedAt: 1101 }), /changed replay/);
  assert.throws(() => fixture.authority.accept({ ...fixture.report, gatewayCredential: 'public' }), /private/);
  fixture.authority.close();
});

test('issuance refuses caller scope and unheld assignment', () => {
  const authority = createHealthAuthority({ gatewayCredential: 'private', now: () => 1000, randomBytes: (size) => Buffer.alloc(size),
    lookupLease: () => null, lookupGeneration: () => 0, latestFailureAt: () => null, verifyAttestation: () => { throw new Error('unused'); } });
  assert.throws(() => authority.issue({ gatewayCredential: 'private', sessionID: 'unheld', leaseID: 'x', purpose: 'real', requestID: 'r', attemptID: 'a', modelID: 'm', bodySHA256 }), /assignment/);
  authority.close();
});

test('issuance rejects boxed body digests', () => {
  const authority = createHealthAuthority({ gatewayCredential: 'private', now: () => 1000, randomBytes: (size) => Buffer.alloc(size),
    lookupLease: () => ({ held: true, sessionID: 's', leaseID: 'l', targetID: 'claude-opus-5-5', providerID: 'anthropic',
      modelID: 'claude-opus-5-5', wireModelID: 'claude-opus-5-5', primaryID: 'claude-opus-5-5', logicalID: 'anthropic/opus/standard',
      purpose: 'real', expectedScopePolicy: makePolicy().expectedScopePolicies['anthropic/opus/standard'], expectedCredentialInstance: null }),
    lookupGeneration: () => 0, latestFailureAt: () => null, verifyAttestation: () => { throw new Error('unused'); } });
  assert.throws(() => authority.issue({ gatewayCredential: 'private', sessionID: 's', leaseID: 'l', purpose: 'real', requestID: 'r', attemptID: 'a', modelID: 'claude-opus-5-5', bodySHA256: new String(bodySHA256) }), /issuance fields/);
  authority.close();
});

test('a 200 attestation with a failed terminal classification is not success', () => {
  const fixture = makeAuthority({ terminal: { api: 'messages', state: 'http-error', status: 200, errorClass: 'service' } });
  fixture.setTime(1100);
  assert.equal(fixture.authority.accept(fixture.report).outcome.result, 'unknown');
  fixture.authority.close();
});

test('a verified scope mismatch carries the ticket expected credential instance separately from the attested instance', () => {
  const expectedCredentialInstance = `ci_${Buffer.alloc(32, 8).toString('base64url')}`;
  const fixture = makeAuthority({ origin: 'proxy-scope', expectedCredentialInstance });
  fixture.setTime(1100);
  const outcome = fixture.authority.accept(fixture.report).outcome;
  assert.equal(outcome.credentialInstance, 'ci_actual');
  assert.equal(outcome.expectedCredentialInstance, expectedCredentialInstance);
  fixture.authority.close();
});

for (const origin of ['proxy-credentials', 'proxy-scope', 'proxy-validation', 'proxy-network', 'proxy-auth-context']) {
  test(`${origin} attestation remains non-success, non-service evidence`, () => {
    const fixture = makeAuthority({ origin, terminal: { api: 'messages', state: 'invalid', status: 200, errorClass: null } });
    fixture.setTime(1100);
    const outcome = fixture.authority.accept(fixture.report).outcome;
    assert.equal(outcome.failureOrigin, origin);
    assert.notEqual(outcome.result, 'success');
    assert.notEqual(outcome.result, 'service-fault');
    fixture.authority.close();
  });
}

// One isolated outage assignment buys exactly one upstream attempt, so it may hold exactly one
// capability: a second begin on the same consumed assignment would let a later unknown/fault
// outcome race the first ticket's proof while the probe is still live. Ordinary real leases
// legitimately need a capability per turn/attempt and must stay unlimited (up to the cap).
function outageAuthority() {
  const policy = makePolicy();
  let counter = 0;
  const lookups = [];
  const lease = (overrides = {}) => ({ held: true, used: true, sessionID: 'gw-probe-1', leaseID: 'outage-1', targetID: 'claude-opus-5',
    providerID: 'anthropic', modelID: 'claude-opus-5', wireModelID: 'claude-opus-5', primaryID: 'claude-opus-5-5',
    logicalID: 'anthropic/opus/standard', purpose: 'outage-health', expectedScopePolicy: policy.expectedScopePolicies['anthropic/opus/standard'],
    expectedCredentialInstance: `ci_${Buffer.alloc(32, 7).toString('base64url')}`, expiresAt: 11000, ...overrides });
  const leases = {
    'gw-probe-1': lease(),
    'gw-probe-2': lease({ sessionID: 'gw-probe-2', leaseID: 'outage-2' }),
    real: lease({ sessionID: 'real', leaseID: 'real-lease', targetID: 'claude-opus-5-5', modelID: 'claude-opus-5-5', wireModelID: 'claude-opus-5-5', purpose: 'real', expectedCredentialInstance: null }),
  };
  const authority = createHealthAuthority({ gatewayCredential: 'private', now: () => 1000,
    // Distinct entropy per call, so only the new guard (never an entropy collision) can refuse.
    randomBytes: (size) => { counter++; return Buffer.alloc(size, counter); },
    lookupLease: (input) => { lookups.push(input.sessionID); return leases[input.sessionID] ? structuredClone(leases[input.sessionID]) : null; },
    lookupGeneration: () => 0, latestFailureAt: () => null, verifyAttestation: () => { throw new Error('unused'); } });
  const begin = (sessionID, overrides = {}) => ({ gatewayCredential: 'private', sessionID, leaseID: leases[sessionID].leaseID,
    requestID: 'r', attemptID: 'a', purpose: leases[sessionID].purpose, modelID: leases[sessionID].wireModelID, bodySHA256, ...overrides });
  return { authority, begin, lookups };
}

test('a consumed outage assignment yields exactly one capability; a second begin is refused', () => {
  const { authority, begin } = outageAuthority();
  try {
    const first = authority.issue(begin('gw-probe-1'));
    assert.equal(typeof first.capability, 'string');
    // A different request/attempt (fresh nonce, fresh capability) on the same assignment is refused,
    assert.throws(() => authority.issue(begin('gw-probe-1', { requestID: 'r2', attemptID: 'a2' })), /^Error: outage capability reuse$/);
    // and so is an identical second begin.
    assert.throws(() => authority.issue(begin('gw-probe-1')), /^Error: outage capability reuse$/);
    // Another outage assignment is independent.
    assert.equal(typeof authority.issue(begin('gw-probe-2')).capability, 'string');
    assert.throws(() => authority.issue(begin('gw-probe-2', { attemptID: 'a2' })), /^Error: outage capability reuse$/);
  } finally { authority.close(); }
});

test('ordinary real leases still receive a capability per attempt on the same lease', () => {
  const { authority, begin } = outageAuthority();
  try {
    const capabilities = new Set();
    for (let i = 0; i < 3; i++) capabilities.add(authority.issue(begin('real', { requestID: `r${i}`, attemptID: `a${i}` })).capability);
    assert.equal(capabilities.size, 3);
  } finally { authority.close(); }
});

test('a refused outage issuance does not burn the assignment; the corrected begin is issued once', () => {
  for (const bad of [{ speed: 'fast' }, { speed: 'turbo' }, { bodySHA256: 'A'.repeat(64) }, { bodySHA256: new String(bodySHA256) },
    { requestID: '' }, { attemptID: 'x'.repeat(513) }, { modelID: 'claude-opus-5-fast' }]) {
    const { authority, begin } = outageAuthority();
    try {
      assert.throws(() => authority.issue(begin('gw-probe-1', bad)), (error) => error.message !== 'outage capability reuse', JSON.stringify(bad));
      assert.equal(typeof authority.issue(begin('gw-probe-1')).capability, 'string', JSON.stringify(bad));
      assert.throws(() => authority.issue(begin('gw-probe-1')), /^Error: outage capability reuse$/);
    } finally { authority.close(); }
  }
});

test('acceptance binding accepts fixed canonical proxy wire vectors', () => {
  let observed;
  let time = 1000;
  const authority = createHealthAuthority({ gatewayCredential: 'private', now: () => time, randomBytes: () => Buffer.from(nonce, 'base64url'),
    lookupLease: () => ({ held: true, sessionID: 's', leaseID: 'l', targetID: 'claude-opus-5-5', providerID: 'anthropic', modelID: 'claude-opus-5-5', wireModelID: 'claude-opus-5-5', primaryID: 'claude-opus-5-5', logicalID: 'anthropic/opus/standard', purpose: 'real', expectedScopePolicy: makePolicy().expectedScopePolicies['anthropic/opus/standard'], expectedCredentialInstance: null }),
    lookupGeneration: () => 0, latestFailureAt: () => null,
    verifyAttestation: (report, binding) => {
      observed = report;
      assert.equal(binding.nonce, nonce);
      return { request: [1, nonce, 1000, 11000, 'request-1', 'attempt-1', 'real', 'anthropic', 'claude-opus-5-5', bodySHA256, null],
        attestation: [1, nonce, 'request-1', 'attempt-1', 'claude-opus-5-5', 'ci_fixture', 'llm-auth-proxy/anthropic', 'https://api.anthropic.com', 'claude-code-oauth', 'messages', 'claude-code', 'upstream-response', 200, 'context-hash'] };
    } });
  const ticket = authority.issue({ gatewayCredential: 'private', sessionID: 's', leaseID: 'l', requestID: 'request-1', attemptID: 'attempt-1', purpose: 'real', modelID: 'claude-opus-5-5', bodySHA256 });
  time = 1100;
  const result = authority.accept({ gatewayCredential: 'private', capability: ticket.capability, ...proxyVectors,
    terminal: { api: 'messages', state: 'complete', status: 200, errorClass: null }, finishedAt: 1100 });
  assert.equal(observed.context, proxyVectors.context);
  assert.equal(result.outcome.result, 'success');
  authority.close();
});
