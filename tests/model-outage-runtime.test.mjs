import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyOutages, outageGrants, reduceOutages } from '../lib/model-outages.js';
import { CI_A, CI_B, CI_C, makeBaseline, makeFailure, makePolicy, makeSnapshot, makeTargets } from './helpers/model-outages.mjs';

// The runtime helpers import routing (and so config); never let that read the host's live config.
process.env.OPENCODE_BROKER_CONFIG = fileURLToPath(new URL('./fixtures/config.json', import.meta.url));
const {
  currentReserveGrant, isCanonicalCredentialInstance, loadOutageRuntime, ordinaryHealthLease, outageLeaseAssertion, parseOutageGatewayURL, probeAdmissible,
} = await import('../lib/model-outage-runtime.js');

const policy = makePolicy();
const grantsOf = (outages, now) => outageGrants(outages, policy, now);
const targets = makeTargets();
targets['claude-opus-5-5-fast'].modelID = 'claude-opus-5-5-fast';
targets.unmanaged = { id: 'unmanaged', providerID: 'anthropic', modelID: 'claude-haiku-9', kind: 'cloud', context: 200000 };

// A provisional episode whose claude-opus-5 reserve was verified by a real success (active proof).
function grantedOutages(base = 1_000_000) {
  let outages = emptyOutages();
  for (const event of [
    makeBaseline({ credentialInstance: CI_A, startedAt: base, finishedAt: base + 100 }),
    makeFailure({ credentialInstance: CI_A, startedAt: base + 1_000, finishedAt: base + 1_100 }),
    makeSnapshot({ receivedAt: base + 1_200 }),
    makeBaseline({ credentialInstance: CI_A, targetID: 'claude-opus-5', requestID: 'r-reserve', attemptID: 'a-reserve',
      startedAt: base + 1_201, finishedAt: base + 1_300 }),
  ]) outages = reduceOutages(outages, event, { policy, now: event.finishedAt ?? event.receivedAt });
  return outages;
}

test('outage gateway URL is a required bare http(s) origin, normalized without a trailing slash', () => {
  assert.equal(parseOutageGatewayURL('http://127.0.0.1:8790'), 'http://127.0.0.1:8790');
  assert.equal(parseOutageGatewayURL('http://127.0.0.1:8790/'), 'http://127.0.0.1:8790');
  assert.equal(parseOutageGatewayURL('https://gateway.example'), 'https://gateway.example');
  for (const bad of [undefined, '', 'ftp://127.0.0.1', 'http://user:pw@127.0.0.1:8790', 'http://127.0.0.1:8790/?a=1',
    'http://127.0.0.1:8790/#x', 'http://127.0.0.1:8790/v1', 'not a url', 'http://127.0.0.1:8790?']) {
    assert.throws(() => parseOutageGatewayURL(bad), /OPENCODE_BROKER_OUTAGE_GATEWAY_URL/, String(bad));
  }
});

function keyFixture() {
  const base = mkdtempSync(join(tmpdir(), 'outage-runtime-'));
  chmodSync(base, 0o700);
  const state = join(base, 'state');
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const write = (name, value) => { const path = join(base, name); writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); return path; };
  const gatewayKeyPath = write('gateway-key', 'fake-front-door-key\n');
  const credentialPath = write('health-credential', 'fake-private-credential\n');
  const healthKeyPath = join(state, 'model-health.key');
  writeFileSync(healthKeyPath, Buffer.alloc(32, 9), { mode: 0o600 });
  chmodSync(healthKeyPath, 0o600);
  return {
    base, state, gatewayKeyPath, credentialPath, healthKeyPath, write,
    env: {
      OPENCODE_BROKER_OUTAGE_GATEWAY_URL: 'http://127.0.0.1:9/',
      OPENCODE_BROKER_GATEWAY_KEY_FILE: gatewayKeyPath,
      OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE: credentialPath,
    },
    close: () => rmSync(base, { recursive: true, force: true }),
  };
}

test('enabled runtime reads every dependency strictly and returns runtime-only credentials', () => {
  const f = keyFixture();
  try {
    const runtime = loadOutageRuntime({ env: f.env, stateDir: f.state });
    assert.equal(runtime.gatewayURL, 'http://127.0.0.1:9');
    assert.equal(runtime.gatewayKey, 'fake-front-door-key');
    assert.equal(runtime.gatewayCredential, 'fake-private-credential');
    assert.deepEqual(runtime.healthKey, Buffer.alloc(32, 9));
    // An explicit health-key path overrides the state-directory default.
    const other = join(f.state, 'other.key');
    writeFileSync(other, Buffer.alloc(32, 4), { mode: 0o600 });
    chmodSync(other, 0o600);
    assert.deepEqual(loadOutageRuntime({ env: { ...f.env, OPENCODE_BROKER_HEALTH_KEY_FILE: other }, stateDir: f.state }).healthKey, Buffer.alloc(32, 4));
  } finally { f.close(); }
});

test('enabled runtime fails loudly on every missing or unsafe dependency and never creates a key', () => {
  const f = keyFixture();
  try {
    const { OPENCODE_BROKER_OUTAGE_GATEWAY_URL: _u, ...noURL } = f.env;
    assert.throws(() => loadOutageRuntime({ env: noURL, stateDir: f.state }), /OPENCODE_BROKER_OUTAGE_GATEWAY_URL/);
    const { OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE: _c, ...noCredential } = f.env;
    assert.throws(() => loadOutageRuntime({ env: noCredential, stateDir: f.state }), /OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE/);
    assert.throws(() => loadOutageRuntime({ env: { ...f.env, OPENCODE_BROKER_GATEWAY_KEY_FILE: join(f.base, 'absent') }, stateDir: f.state }), /does not exist/);
    chmodSync(f.credentialPath, 0o640);
    assert.throws(() => loadOutageRuntime({ env: f.env, stateDir: f.state }), /group- or world-readable/);
    chmodSync(f.credentialPath, 0o600);
    // Missing health key: refused, and nothing is created in its place.
    rmSync(f.healthKeyPath);
    assert.throws(() => loadOutageRuntime({ env: f.env, stateDir: f.state }), /model health key/);
    assert.equal(existsSync(f.healthKeyPath), false);
    // Wrong mode and front-door reuse are refused by the strict reader.
    writeFileSync(f.healthKeyPath, Buffer.alloc(32, 9), { mode: 0o644 });
    chmodSync(f.healthKeyPath, 0o644);
    assert.throws(() => loadOutageRuntime({ env: f.env, stateDir: f.state }), /model health key/);
    chmodSync(f.healthKeyPath, 0o600);
    writeFileSync(f.healthKeyPath, Buffer.from('fake-private-credential-32bytes!'));
    const thrown = (() => { try { loadOutageRuntime({ env: { ...f.env, OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE: f.write('c2', 'fake-private-credential-32bytes!') }, stateDir: f.state }); } catch (error) { return error; } return null; })();
    assert.match(String(thrown?.message), /model health key/);
    assert.doesNotMatch(String(thrown?.message), /fake-private-credential/, 'no secret bytes in errors');
  } finally { f.close(); }
});

test('a lease assertion is built only from a grant with a canonical credential instance', () => {
  assert.ok([CI_A, CI_B, CI_C].every(isCanonicalCredentialInstance));
  const grant = { logicalID: 'anthropic/opus/standard', primaryID: 'claude-opus-5-5', targetID: 'claude-opus-5', credentialInstance: CI_A, generation: 2, episodeID: 'e' };
  assert.deepEqual(outageLeaseAssertion(grant), { logicalID: 'anthropic/opus/standard', primaryID: 'claude-opus-5-5',
    expectedCredentialInstance: CI_A, generation: 2, episodeID: 'e' });
  assert.throws(() => outageLeaseAssertion({ ...grant, credentialInstance: 'ci_A' }), /credential instance/);
});

test('a reserve assertion is current only while the exact grant generation and credential instance hold', () => {
  const outages = grantedOutages();
  const now = 1_002_000;
  const [grant] = grantsOf(outages, now);
  const assertion = outageLeaseAssertion(grant);
  assert.ok(currentReserveGrant({ policy, outages, targetID: 'claude-opus-5', assertion, now }));
  assert.equal(currentReserveGrant({ policy, outages, targetID: 'claude-opus-5', assertion: { ...assertion, generation: assertion.generation + 1 }, now }), null);
  assert.equal(currentReserveGrant({ policy, outages, targetID: 'claude-opus-5', assertion: { ...assertion, expectedCredentialInstance: CI_B }, now }), null);
  assert.equal(currentReserveGrant({ policy, outages, targetID: 'claude-opus-4-8', assertion, now }), null);
  assert.equal(currentReserveGrant({ policy, outages, targetID: 'claude-opus-5', assertion: null, now }), null);
  // After the provisional deadline without official confirmation the grant is gone.
  assert.equal(currentReserveGrant({ policy, outages, targetID: 'claude-opus-5', assertion, now: 1_001_100 + 600_000 }), null);
});

test('ordinary health lookup binds the exact held real lease, target, wire model and policy scope', () => {
  const outages = grantedOutages();
  const now = 1_002_000;
  const input = { sessionID: 's1', leaseID: 'l1', requestID: 'q', attemptID: 'a', purpose: 'real', modelID: 'claude-opus-5-5', bodySHA256: 'f'.repeat(64) };
  const lease = { sessionID: 's1', leaseID: 'l1', targetID: 'claude-opus-5-5' };
  const primary = ordinaryHealthLease({ input, lease, targets, policy, outages, now });
  assert.deepEqual(primary, {
    held: true, sessionID: 's1', leaseID: 'l1', logicalID: 'anthropic/opus/standard', primaryID: 'claude-opus-5-5',
    targetID: 'claude-opus-5-5', providerID: 'anthropic', modelID: 'claude-opus-5-5', wireModelID: 'claude-opus-5-5',
    purpose: 'real', expectedScopePolicy: policy.expectedScopePolicies['anthropic/opus/standard'], expectedCredentialInstance: null,
  });
  assert.equal(ordinaryHealthLease({ input: { ...input, purpose: 'outage-health' }, lease, targets, policy, outages, now }), null);
  assert.equal(ordinaryHealthLease({ input: { ...input, leaseID: 'other' }, lease, targets, policy, outages, now }), null);
  assert.equal(ordinaryHealthLease({ input, lease: undefined, targets, policy, outages, now }), null);
  assert.equal(ordinaryHealthLease({ input: { ...input, modelID: 'claude-opus-5' }, lease, targets, policy, outages, now }), null, 'no arbitrary wire model');
  assert.equal(ordinaryHealthLease({ input, lease: { ...lease, targetID: 'unmanaged' }, targets, policy, outages, now }), null);
  assert.equal(ordinaryHealthLease({ input, lease, targets, policy: { ...policy, enabled: false }, outages, now }), null);

  // The documented synthetic speed alias: a -fast target is covered by its base wire id only.
  const fastLease = { ...lease, targetID: 'claude-opus-5-5-fast' };
  const fast = ordinaryHealthLease({ input: { ...input, modelID: 'claude-opus-5-5' }, lease: fastLease, targets, policy, outages, now });
  assert.equal(fast.wireModelID, 'claude-opus-5-5');
  assert.equal(fast.modelID, 'claude-opus-5-5-fast');
  assert.equal(fast.logicalID, 'anthropic/opus/fast');
  assert.equal(ordinaryHealthLease({ input: { ...input, modelID: 'claude-opus-5-5-fast' }, lease: fastLease, targets, policy, outages, now }).wireModelID, 'claude-opus-5-5-fast');
  for (const wire of ['claude-opus-5-5-standard', 'claude-opus', 'claude-opus-5-5-fastx']) {
    assert.equal(ordinaryHealthLease({ input: { ...input, modelID: wire }, lease: fastLease, targets, policy, outages, now }), null, wire);
  }

  // A held reserve carries the current grant's credential instance, and nothing without it.
  const [grant] = grantsOf(outages, now);
  const reserveLease = { ...lease, targetID: 'claude-opus-5', outage: outageLeaseAssertion(grant) };
  const reserve = ordinaryHealthLease({ input: { ...input, modelID: 'claude-opus-5' }, lease: reserveLease, targets, policy, outages, now });
  assert.equal(reserve.primaryID, 'claude-opus-5-5');
  assert.equal(reserve.targetID, 'claude-opus-5');
  assert.equal(reserve.expectedCredentialInstance, CI_A);
  assert.equal(ordinaryHealthLease({ input: { ...input, modelID: 'claude-opus-5' }, lease: { ...reserveLease, outage: undefined }, targets, policy, outages, now }), null);
  assert.equal(ordinaryHealthLease({ input: { ...input, modelID: 'claude-opus-5' }, lease: { ...reserveLease, outage: { ...reserveLease.outage, generation: 99 } }, targets, policy, outages, now }), null);
});

test('probe admission keeps every upper fence except the affected primary model overload circuit', () => {
  const now = 5_000;
  const base = { policy, targets, circuits: {}, health: {}, providers: { anthropic: { connected: true, authType: 'oauth' } },
    active: {}, providerActive: {}, probationOnly: new Set(), now };
  const primary = { logicalID: 'anthropic/opus/standard', targetID: 'claude-opus-5-5', kind: 'primary' };
  const reserve = { logicalID: 'anthropic/opus/standard', targetID: 'claude-opus-5', kind: 'reserve' };
  assert.equal(probeAdmissible(primary, base), true);
  assert.equal(probeAdmissible(reserve, base), true, 'the ordinary head/membership exclusion is not a probe fence');
  const overload = { 'claude-opus-5-5': { kind: 'overload', until: now + 10_000 }, 'claude-opus-5': { kind: 'overload', until: now + 10_000 } };
  assert.equal(probeAdmissible(primary, { ...base, circuits: overload }), true);
  assert.equal(probeAdmissible(reserve, { ...base, circuits: overload }), false);
  assert.equal(probeAdmissible(primary, { ...base, circuits: { 'claude-opus-5-5': { kind: 'model', until: null } } }), false);
  assert.equal(probeAdmissible(primary, { ...base, circuits: { 'provider:anthropic': { kind: 'quota', until: now + 1 } } }), false);
  assert.equal(probeAdmissible(primary, { ...base, health: { version: 1, providers: { anthropic: { state: 'quarantined', kind: 'compatibility', source: 'operator', firstAt: 1, lastAt: 1, evidence: [] } } } }), false);
  assert.equal(probeAdmissible(primary, { ...base, probationOnly: new Set(['anthropic/claude-opus-5-5']) }), false);
  assert.equal(probeAdmissible({ ...reserve, targetID: 'claude-opus-4-9' }, base), false, 'inventory cannot invent a reserve');
  assert.equal(probeAdmissible({ ...reserve, targetID: 'claude-sonnet-5' }, base), false, 'reserve of another scope');
  assert.equal(probeAdmissible({ ...primary, targetID: 'claude-opus-5' }, base), false, 'kind/target mismatch');
  assert.equal(probeAdmissible(primary, { ...base, policy: { ...policy, enabled: false } }), false);
  assert.equal(probeAdmissible(primary, { ...base, providers: {} }), false, 'cloud admission stays an upper fence');
});

test('probe admission refuses a target whose window or output cap cannot hold the probe', () => {
  const now = 5_000;
  const withTarget = (id, patch) => ({ ...targets, [id]: { ...targets[id], ...patch } });
  const base = { policy, targets, circuits: {}, health: {}, providers: { anthropic: { connected: true, authType: 'oauth' } },
    active: {}, providerActive: {}, probationOnly: new Set(), modelContexts: {}, modelOutputs: {}, now };
  const reserve = { logicalID: 'anthropic/opus/standard', targetID: 'claude-opus-5', kind: 'reserve' };
  const primary = { logicalID: 'anthropic/opus/standard', targetID: 'claude-opus-5-5', kind: 'primary' };
  // Declared context 255 cannot hold even the 256-token probe generation, let alone its prompt.
  assert.equal(probeAdmissible(reserve, { ...base, targets: withTarget('claude-opus-5', { context: 255 }) }), false, 'context 255');
  assert.equal(probeAdmissible(primary, { ...base, targets: withTarget('claude-opus-5-5', { context: 255 }) }), false, 'primary context 255');
  // Exactly the probe footprint is still too tight once the ordinary cloud headroom applies.
  assert.equal(probeAdmissible(reserve, { ...base, targets: withTarget('claude-opus-5', { context: 300 }) }), false, 'context 300');
  assert.equal(probeAdmissible(reserve, { ...base, targets: withTarget('claude-opus-5', { context: 200000 }) }), true, 'ample context');
  // No declared context: the discovered catalog window decides, as for ordinary routing.
  const undeclared = withTarget('claude-opus-5', { context: undefined });
  assert.equal(probeAdmissible(reserve, { ...base, targets: undeclared, modelContexts: { 'anthropic/claude-opus-5': 255 } }), false, 'catalog 255');
  assert.equal(probeAdmissible(reserve, { ...base, targets: undeclared, modelContexts: { 'anthropic/claude-opus-5': 200000 } }), true, 'catalog ample');
  // Unknown window entirely: a cloud target with unknown context fits in ordinary routing too.
  assert.equal(probeAdmissible(reserve, { ...base, targets: undeclared }), true, 'unknown cloud context follows ordinary routing');
  // A known output cap below the probe's 256-token generation refuses; at 256 it admits.
  assert.equal(probeAdmissible(reserve, { ...base, targets: withTarget('claude-opus-5', { outputReserve: 255 }) }), false, 'declared output 255');
  assert.equal(probeAdmissible(reserve, { ...base, modelOutputs: { 'anthropic/claude-opus-5': 128 } }), false, 'catalog output 128');
  assert.equal(probeAdmissible(reserve, { ...base, modelOutputs: { 'anthropic/claude-opus-5': 256 } }), true, 'catalog output 256');
  assert.equal(probeAdmissible(reserve, { ...base, modelOutputs: { 'anthropic/claude-opus-5': 64000 } }), true, 'catalog output ample');
});
