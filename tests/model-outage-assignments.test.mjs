import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOutageAssignments } from '../lib/model-outage-service.js';
import { decodeOutages } from '../lib/model-outage-state.js';
import { createHealthAuthority } from '../lib/model-health.js';
import { emptyOutages, reduceOutages, reserveProbe } from '../lib/model-outages.js';
import { CI_A, CI_B, makePolicy, makeTargets, makeBaseline, makeFailure, makeSnapshot } from './helpers/model-outages.mjs';

// Isolated outage-health probe assignments (plan Task 9). Every reservation here is produced by
// the real reducer + reserveProbe; the credential instance is a FAKE fixture value shaped like a
// real one ('ci_' + canonical 32-byte base64url). Nothing here touches credentials or the network.
const policy = makePolicy();
const targets = makeTargets();
const logicalID = 'anthropic/opus/standard';
const CI = CI_A;
const OTHER_CI = CI_B;
const RESERVATION_KEYS = ['id', 'nonce', 'logicalID', 'targetID', 'primaryID', 'providerID', 'kind', 'purpose',
  'episodeID', 'generation', 'expectedCredentialInstance', 'startedAt', 'expiresAt'];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function ready() {
  let state = emptyOutages();
  for (const event of [makeBaseline({ credentialInstance: CI }), makeFailure({ credentialInstance: CI }), makeSnapshot()]) {
    state = reduceOutages(state, event, { policy, now: event.finishedAt ?? event.receivedAt });
  }
  return state;
}

function reserved({ kind = 'reserve', targetID = kind === 'primary' ? 'claude-opus-5-5' : 'claude-opus-5', now = 2300 } = {}) {
  const r = reserveProbe(ready(), { logicalID, targetID, kind, id: randomBytes(16).toString('hex'),
    nonce: randomBytes(32).toString('base64url'), now }, { policy });
  assert.ok(r, 'fixture reservation');
  return r;
}

// A fixture whose read() returns a deep-frozen persisted image: any mutation by the module throws.
function fixture({ kind, randomSource = randomBytes, policyOverride = policy } = {}) {
  const r = reserved({ kind });
  const f = { clock: r.reservation.startedAt, reservation: r.reservation, state: deepFreeze(r.state) };
  f.pristine = structuredClone(r.state);
  f.assignments = createOutageAssignments({ now: () => f.clock, randomBytes: randomSource, read: () => f.state,
    targets, policy: policyOverride });
  f.copy = () => structuredClone(f.reservation);
  // Replace the persisted image (as a commit would) with a mutated deep copy.
  f.persist = (mutate) => { const next = structuredClone(f.state); mutate(next); f.state = deepFreeze(next); };
  f.assertUnchanged = () => assert.deepEqual(f.state, f.pristine);
  return f;
}

const consumeInput = (a) => ({ sessionID: a.sessionID, probeNonce: a.probeNonce, purpose: 'outage-health' });

test('module exports createOutageAssignments with the planned surface', () => {
  const service = createOutageAssignments({ now: () => 0, randomBytes, read: () => emptyOutages(), targets, policy });
  for (const name of ['issue', 'consume', 'lookupLease', 'release', 'close']) assert.equal(typeof service[name], 'function', name);
  service.close();
});

test('issue binds the exact persisted reservation into a held assignment without touching durable state', () => {
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  const r = f.reservation;
  assert.deepEqual(a.reservation, r);
  for (const key of RESERVATION_KEYS) assert.deepEqual(a[key], r[key], key);
  assert.equal(a.purpose, 'outage-health');
  assert.equal(a.reservationID, r.id);
  assert.equal(a.reservationNonce, r.nonce);
  assert.match(a.sessionID, /^gw-probe-[A-Za-z0-9_-]{43}$/);
  assert.equal(a.probeNonce, `pbn_${r.nonce}`);
  assert.equal(a.leaseID, `outage-${r.id}`);
  assert.equal(a.modelID, 'claude-opus-5');
  assert.equal(a.wireModelID, 'claude-opus-5');
  assert.deepEqual(a.preferredModel, { providerID: 'anthropic', modelID: 'claude-opus-5' });
  assert.deepEqual(a.expectedScopePolicy, policy.expectedScopePolicies[logicalID]);
  assert.notEqual(a.expectedScopePolicy, policy.expectedScopePolicies[logicalID]);
  assert.equal(a.used, false);
  f.assertUnchanged();
});

test('issued, consumed and looked-up assignments are marked held, as the health authority requires', () => {
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  assert.equal(a.held, true);
  assert.equal(f.assignments.consume(consumeInput(a)).held, true);
  assert.equal(f.assignments.lookupLease({ sessionID: a.sessionID, leaseID: a.leaseID }).held, true);
  f.assertUnchanged();
});

test('the real health authority issues a ticket for a consumed outage assignment through lookupLease', () => {
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  f.assignments.consume(consumeInput(a));
  const gatewayCredential = 'fake-gateway-credential-for-tests';
  const authority = createHealthAuthority({ gatewayCredential, now: () => f.clock, randomBytes,
    lookupLease: (input) => f.assignments.lookupLease(input),
    lookupGeneration: (id) => f.state.scopes[id]?.generation,
    latestFailureAt: () => null, verifyAttestation: () => { throw new Error('not reached'); } });
  const ticket = authority.issue({ gatewayCredential, sessionID: a.sessionID, leaseID: a.leaseID, requestID: 'probe-req',
    attemptID: 'probe-att', purpose: 'outage-health', modelID: a.wireModelID, bodySHA256: 'a'.repeat(64) });
  assert.equal(ticket.startedAt, f.clock);
  assert.equal(ticket.generation, f.reservation.generation);
  assert.equal(typeof ticket.capability, 'string');
  // An unconsumed assignment gets no ticket.
  const g = fixture();
  const b = g.assignments.issue(g.copy());
  const other = createHealthAuthority({ gatewayCredential, now: () => g.clock, randomBytes,
    lookupLease: (input) => g.assignments.lookupLease(input), lookupGeneration: (id) => g.state.scopes[id]?.generation,
    latestFailureAt: () => null, verifyAttestation: () => { throw new Error('not reached'); } });
  assert.throws(() => other.issue({ gatewayCredential, sessionID: b.sessionID, leaseID: b.leaseID, requestID: 'r',
    attemptID: 'a', purpose: 'outage-health', modelID: b.wireModelID, bodySHA256: 'a'.repeat(64) }), /assignment/);
  f.assertUnchanged(); g.assertUnchanged();
});

test('primary reservations bind the primary model and the actual target model ID, never a guessed one', () => {
  const f = fixture({ kind: 'primary' });
  const a = f.assignments.issue(f.copy());
  assert.equal(a.kind, 'primary');
  assert.deepEqual(a.preferredModel, { providerID: 'anthropic', modelID: 'claude-opus-5-5' });
  // A target's wire modelID may differ from its target ID; the assignment must use the target's.
  const t = structuredClone(targets);
  t['claude-opus-5-5'].modelID = 'claude-opus-5-5-wire';
  const g = fixture({ kind: 'primary' });
  const service = createOutageAssignments({ now: () => g.clock, randomBytes, read: () => g.state, targets: t, policy });
  const b = service.issue(g.copy());
  assert.equal(b.modelID, 'claude-opus-5-5-wire');
  assert.equal(b.wireModelID, 'claude-opus-5-5-wire');
  assert.deepEqual(b.preferredModel, { providerID: 'anthropic', modelID: 'claude-opus-5-5-wire' });
  f.assertUnchanged();
});

test('returned assignments are clones: mutating them changes neither the held binding nor later results', () => {
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  const original = structuredClone(a);
  a.modelID = 'claude-sonnet-5'; a.preferredModel.modelID = 'evil'; a.reservation.targetID = 'evil'; a.used = true;
  a.expectedScopePolicy.providerID = 'openai';
  const consumed = f.assignments.consume(consumeInput(original));
  assert.deepEqual(consumed, { ...original, used: true });
  consumed.leaseID = 'outage-evil'; consumed.preferredModel.modelID = 'evil';
  const looked = f.assignments.lookupLease({ sessionID: original.sessionID, leaseID: original.leaseID, probeNonce: original.probeNonce });
  assert.deepEqual(looked, { ...original, used: true });
  looked.reservation.generation = 999;
  assert.deepEqual(f.assignments.lookupLease({ sessionID: original.sessionID }), { ...original, used: true });
  f.assertUnchanged();
});

test('issue rejects any caller reservation differing from the persisted one in any durable field', () => {
  const swaps = {
    id: 'ab'.repeat(16), nonce: Buffer.alloc(32, 1).toString('base64url'), logicalID: 'anthropic/sonnet/standard',
    targetID: 'claude-opus-4-8', primaryID: 'claude-sonnet-5-5', providerID: 'openai', kind: 'primary', purpose: 'real',
    episodeID: 'anthropic/opus/standard:x:1', generation: 99, expectedCredentialInstance: OTHER_CI,
  };
  for (const key of RESERVATION_KEYS) {
    const f = fixture();
    const tampered = f.copy();
    tampered[key] = key === 'startedAt' ? tampered.startedAt - 1 : key === 'expiresAt' ? tampered.expiresAt - 1 : swaps[key];
    assert.throws(() => f.assignments.issue(tampered), /outage assignment binding/, key);
    f.assertUnchanged();
    // Nothing was held or burned: the honest reservation still issues afterwards.
    assert.ok(f.assignments.issue(f.copy()));
  }
  const f = fixture();
  assert.throws(() => f.assignments.issue({ ...f.copy(), modelID: 'claude-sonnet-5' }), /outage assignment binding/, 'extra caller field');
  for (const key of RESERVATION_KEYS) {
    const partial = f.copy(); delete partial[key];
    assert.throws(() => f.assignments.issue(partial), /outage assignment binding/, `missing caller ${key}`);
  }
  for (const junk of [undefined, null, 'x', [], 7]) assert.throws(() => f.assignments.issue(junk), /outage assignment binding/);
  f.assertUnchanged();
});

test('issue rejects a persisted reservation whose binding to scope, episode, target or policy is broken', () => {
  const cases = {
    'generation drifted from scope': (s) => { s.providers.anthropic.inflight.generation += 1; },
    'scope generation advanced': (s) => { s.scopes[logicalID].generation += 1; },
    'credential instance rotated': (s) => {
      s.scopes[logicalID].instances[OTHER_CI] = structuredClone(s.scopes[logicalID].instances[CI]);
      s.scopes[logicalID].currentCredentialInstance = OTHER_CI;
    },
    'reservation names another credential': (s) => { s.providers.anthropic.inflight.expectedCredentialInstance = OTHER_CI; },
    'episode replaced': (s) => { s.scopes[logicalID].instances[CI].episode.id = `${logicalID}:${CI}:9999`; },
    'episode cleared': (s) => { s.scopes[logicalID].instances[CI].episode = null; },
    'episode primary differs': (s) => { s.providers.anthropic.inflight.primaryID = 'claude-sonnet-5-5'; },
    'scope missing': (s) => { delete s.scopes[logicalID]; },
    'instance missing': (s) => { delete s.scopes[logicalID].instances[CI]; },
    'provider entry missing': (s) => { delete s.providers.anthropic; },
    'no inflight': (s) => { s.providers.anthropic.inflight = null; },
    'inflight under another provider key': (s) => { s.providers.openai = s.providers.anthropic; delete s.providers.anthropic; },
    'reserve substituted by unmapped target': (s) => { s.providers.anthropic.inflight.targetID = 'claude-sonnet-5'; },
    'reserve substituted by another provider target': (s) => { s.providers.anthropic.inflight.targetID = 'gpt-flagship'; },
    'unknown target': (s) => { s.providers.anthropic.inflight.targetID = 'claude-opus-9'; },
    'kind primary with reserve target': (s) => { s.providers.anthropic.inflight.kind = 'primary'; },
    'unknown kind': (s) => { s.providers.anthropic.inflight.kind = 'canary'; },
    'non-health purpose': (s) => { s.providers.anthropic.inflight.purpose = 'real'; },
    'provider claim differs from scope policy': (s) => { s.providers.anthropic.inflight.providerID = 'openai'; },
    'ttl longer than ten seconds': (s) => { s.providers.anthropic.inflight.expiresAt += 1; },
    'ttl inverted': (s) => { s.providers.anthropic.inflight.expiresAt = s.providers.anthropic.inflight.startedAt; },
    'non-canonical nonce (33 bytes)': (s) => { s.providers.anthropic.inflight.nonce = randomBytes(33).toString('base64url'); },
    'non-canonical nonce (padding bits)': (s) => { s.providers.anthropic.inflight.nonce = `${Buffer.alloc(32, 0).toString('base64url').slice(0, 42)}B`; },
    'short nonce': (s) => { s.providers.anthropic.inflight.nonce = 'n1'; },
    'fake credential shape': (s) => {
      s.scopes[logicalID].instances.ci_A = s.scopes[logicalID].instances[CI];
      s.scopes[logicalID].currentCredentialInstance = 'ci_A';
      s.providers.anthropic.inflight.expectedCredentialInstance = 'ci_A';
    },
    'id with whitespace': (s) => { s.providers.anthropic.inflight.id = 'a b'; },
    'oversized id': (s) => { s.providers.anthropic.inflight.id = 'a'.repeat(129); },
    'non-integer generation': (s) => { s.providers.anthropic.inflight.generation = '2'; },
    'extra persisted field': (s) => { s.providers.anthropic.inflight.modelID = 'claude-opus-5'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const f = fixture();
    f.persist(mutate);
    // The caller presents exactly what was persisted, so only the durable binding can refuse it.
    const presented = structuredClone(f.state.providers.anthropic?.inflight ?? f.state.providers.openai?.inflight ?? f.reservation);
    const before = structuredClone(f.state);
    assert.throws(() => f.assignments.issue(presented), /outage assignment binding/, name);
    assert.deepEqual(f.state, before, name);
  }
});

test('a policy whose scope, mapping or primary scope does not vouch for the reservation refuses it', () => {
  const mutations = {
    'scope policy missing': (p) => { delete p.expectedScopePolicies[logicalID]; },
    'scope policy provider differs': (p) => { p.expectedScopePolicies[logicalID].providerID = 'openai'; },
    'reserve no longer mapped': (p) => { p.mappings['claude-opus-5-5'] = ['claude-opus-4-8']; },
    'primary scoped elsewhere': (p) => { p.primaryScope['claude-opus-5-5'] = 'anthropic/opus/fast'; },
    'outage policy disabled': (p) => { p.enabled = false; },
    'outage policy enabled is a truthy non-boolean': (p) => { p.enabled = 'true'; },
    'outage policy enabled is 1': (p) => { p.enabled = 1; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const p = structuredClone(policy); mutate(p);
    const f = fixture({ policyOverride: p });
    assert.throws(() => f.assignments.issue(f.copy()), /outage assignment binding/, name);
    f.assertUnchanged();
  }
  const t = structuredClone(targets); t['claude-opus-5'].providerID = 'openai';
  const f = fixture();
  const service = createOutageAssignments({ now: () => f.clock, randomBytes, read: () => f.state, targets: t, policy });
  assert.throws(() => service.issue(f.copy()), /outage assignment binding/, 'target provider substituted');
  const missingModel = structuredClone(targets); delete missingModel['claude-opus-5'].modelID;
  const g = createOutageAssignments({ now: () => f.clock, randomBytes, read: () => f.state, targets: missingModel, policy });
  assert.throws(() => g.issue(f.copy()), /outage assignment binding/, 'target without model ID');
});

test('a candidate-reconciliation gate is never consulted: reconcile.enabled false is irrelevant', () => {
  const f = fixture({ policyOverride: { ...structuredClone(policy), reconcile: { enabled: false } } });
  const a = f.assignments.issue(f.copy());
  assert.equal(f.assignments.consume(consumeInput(a)).used, true);
  assert.ok(f.assignments.lookupLease({ sessionID: a.sessionID, leaseID: a.leaseID }));
  f.assertUnchanged();
});

test('restored incomplete occupancy never grants an assignment, but a whole restored reservation does', () => {
  const f = fixture();
  const image = JSON.parse(JSON.stringify(f.state));
  const whole = decodeOutages(image, { policy, now: f.clock });
  assert.deepEqual(whole.providers.anthropic.inflight, f.reservation);
  f.state = deepFreeze(whole);
  assert.ok(f.assignments.issue(f.copy()), 'whole restored reservation');

  const g = fixture();
  const broken = JSON.parse(JSON.stringify(g.state));
  broken.providers.anthropic.inflight.episodeID = 'bogus';
  const decoded = decodeOutages(broken, { policy, now: g.clock });
  assert.deepEqual(decoded.providers.anthropic.inflight, { id: g.reservation.id, expiresAt: g.reservation.expiresAt });
  g.state = deepFreeze(decoded);
  assert.throws(() => g.assignments.issue(g.copy()), /outage assignment binding/, 'caller completes partial occupancy');
  assert.throws(() => g.assignments.issue(structuredClone(decoded.providers.anthropic.inflight)), /outage assignment binding/, 'partial as-is');
});

test('the ten-second window is half-open: 9999 ms is live, 10000 ms is expired, before start is refused', () => {
  // Each probe uses its own service: the service's clock high-water mark refuses a rewind, so
  // one service cannot be shown "expired" and then "live" again.
  const e = fixture();
  e.clock = e.reservation.startedAt - 1;
  assert.throws(() => e.assignments.issue(e.copy()), /outage assignment binding/, 'before start');
  const d = fixture();
  d.clock = d.reservation.startedAt + 10000;
  assert.throws(() => d.assignments.issue(d.copy()), /outage assignment binding/, 'at expiry');
  const f = fixture();
  f.clock = f.reservation.startedAt + 9999;
  const late = f.assignments.issue(f.copy());
  assert.equal(f.assignments.consume(consumeInput(late)).used, true);

  const g = fixture();
  const a = g.assignments.issue(g.copy());
  g.clock = g.reservation.startedAt + 10000;
  assert.throws(() => g.assignments.consume(consumeInput(a)), /probe nonce binding/, 'consume at expiry');
  const h = fixture();
  const b = h.assignments.issue(h.copy());
  h.assignments.consume(consumeInput(b));
  h.clock = h.reservation.startedAt + 9999;
  assert.ok(h.assignments.lookupLease({ sessionID: b.sessionID }));
  h.clock = h.reservation.startedAt + 10000;
  assert.equal(h.assignments.lookupLease({ sessionID: b.sessionID }), null);
  for (const bad of [Number.NaN, 2300.5, -1]) {
    const k = fixture();
    k.clock = bad;
    assert.throws(() => k.assignments.issue(k.copy()), /outage assignment binding/, `clock ${bad}`);
  }
  f.assertUnchanged(); g.assertUnchanged(); h.assertUnchanged();
});

test('consume is single-use and bound to purpose, session and probe nonce; bad attempts burn nothing', () => {
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  const good = consumeInput(a);
  for (const bad of [
    { ...good, purpose: undefined }, { ...good, purpose: 'real' }, { ...good, purpose: 'outage-health ' },
    { ...good, probeNonce: `pbn_${Buffer.alloc(32, 3).toString('base64url')}` }, { ...good, probeNonce: f.reservation.nonce },
    { ...good, probeNonce: undefined }, { ...good, sessionID: `gw-probe-${Buffer.alloc(32, 3).toString('base64url')}` },
    { ...good, sessionID: undefined },
  ]) assert.throws(() => f.assignments.consume(bad), /probe nonce binding/, JSON.stringify(bad));
  for (const junk of [undefined, null, 'x']) assert.throws(() => f.assignments.consume(junk), /probe nonce binding/);
  assert.equal(f.assignments.lookupLease({ sessionID: a.sessionID }), null, 'unused binding is not a lease');
  const consumed = f.assignments.consume(good);
  assert.equal(consumed.used, true);
  assert.deepEqual(consumed.preferredModel, a.preferredModel, 'no substitution');
  assert.throws(() => f.assignments.consume(good), /probe nonce binding/, 'replay');
  f.assertUnchanged();
});

test('consume and lookup refuse once the durable reservation or scope binding changes after issue', () => {
  const changes = {
    'probe finished cleared inflight': (s) => { s.providers.anthropic.inflight = null; },
    'generation advanced': (s) => { s.scopes[logicalID].generation += 1; },
    'credential rotated': (s) => {
      s.scopes[logicalID].instances[OTHER_CI] = structuredClone(s.scopes[logicalID].instances[CI]);
      s.scopes[logicalID].currentCredentialInstance = OTHER_CI;
    },
    'episode replaced': (s) => { s.scopes[logicalID].instances[CI].episode.id = `${logicalID}:${CI}:5000`; },
    'new reservation took the slot': (s) => {
      s.providers.anthropic.inflight.id = randomBytes(16).toString('hex');
      s.providers.anthropic.inflight.nonce = randomBytes(32).toString('base64url');
    },
  };
  for (const [name, mutate] of Object.entries(changes)) {
    const f = fixture();
    const a = f.assignments.issue(f.copy());
    f.persist(mutate);
    assert.throws(() => f.assignments.consume(consumeInput(a)), /probe nonce binding/, `consume: ${name}`);
    const g = fixture();
    const b = g.assignments.issue(g.copy());
    g.assignments.consume(consumeInput(b));
    g.persist(mutate);
    assert.equal(g.assignments.lookupLease({ sessionID: b.sessionID }), null, `lookup: ${name}`);
  }
  // A real reducer-driven credential rotation (new instance success) also invalidates it.
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  f.state = deepFreeze(reduceOutages(f.state, makeBaseline({ credentialInstance: OTHER_CI, requestID: 'rot', attemptID: 'rot-1',
    startedAt: 2301, finishedAt: 2302 }), { policy, now: 2302 }));
  f.clock = 2302;
  assert.throws(() => f.assignments.consume(consumeInput(a)), /probe nonce binding/, 'reducer rotation');
});

test('lookupLease returns only the consumed current binding and checks every supplied field', () => {
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  const exact = { sessionID: a.sessionID, leaseID: a.leaseID, probeNonce: a.probeNonce, purpose: 'outage-health' };
  assert.equal(f.assignments.lookupLease(exact), null, 'unused');
  f.assignments.consume(consumeInput(a));
  assert.deepEqual(f.assignments.lookupLease(exact), { ...a, used: true });
  assert.deepEqual(f.assignments.lookupLease({ sessionID: a.sessionID }), { ...a, used: true }, 'optional fields omitted');
  for (const bad of [
    { ...exact, sessionID: `gw-probe-${Buffer.alloc(32, 4).toString('base64url')}` }, { ...exact, sessionID: undefined },
    { ...exact, leaseID: 'outage-other' }, { ...exact, leaseID: '' }, { ...exact, probeNonce: 'pbn_other' },
    { ...exact, probeNonce: '' }, { ...exact, purpose: 'real' }, { ...exact, purpose: '' },
  ]) assert.equal(f.assignments.lookupLease(bad), null, JSON.stringify(bad));
  for (const junk of [undefined, null, 'x']) assert.equal(f.assignments.lookupLease(junk), null);
  f.assertUnchanged();
});

test('release removes only the exact held assignment; wrong release is a no-op; reissue stays denied', () => {
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  f.assignments.consume(consumeInput(a));
  const exact = { sessionID: a.sessionID, probeNonce: a.probeNonce, leaseID: a.leaseID };
  for (const bad of [{ ...exact, sessionID: 'gw-probe-x' }, { ...exact, probeNonce: 'pbn_x' }, { ...exact, leaseID: 'outage-x' },
    { sessionID: a.sessionID }, undefined, null]) {
    f.assignments.release(bad);
    assert.deepEqual(f.assignments.lookupLease({ sessionID: a.sessionID }), { ...a, used: true }, JSON.stringify(bad));
  }
  f.assignments.release(exact);
  assert.equal(f.assignments.lookupLease({ sessionID: a.sessionID }), null);
  assert.throws(() => f.assignments.consume(consumeInput(a)), /probe nonce binding/);
  assert.throws(() => f.assignments.issue(f.copy()), /outage assignment reuse/, 'reissue after release');
  f.assignments.release(exact);
  f.assertUnchanged();
  // The same reservation cannot be issued twice while live either.
  const g = fixture();
  g.assignments.issue(g.copy());
  assert.throws(() => g.assignments.issue(g.copy()), /outage assignment reuse/);
  // Once the TTL passes the issued guard is pruned, but the expired reservation is still refused.
  g.clock = g.reservation.expiresAt;
  assert.throws(() => g.assignments.issue(g.copy()), /outage assignment binding/);
  g.assertUnchanged();
});

test('a session-ID entropy collision never overwrites a held assignment', () => {
  let fill = 5;
  const f = fixture({ randomSource: (n) => Buffer.alloc(n, fill) });
  const a = f.assignments.issue(f.copy());
  assert.equal(a.sessionID, `gw-probe-${Buffer.alloc(32, 5).toString('base64url')}`);
  // A second, distinct persisted reservation draws the same session entropy.
  const other = { ...f.reservation, id: randomBytes(16).toString('hex'), nonce: randomBytes(32).toString('base64url') };
  f.persist((s) => { s.providers.anthropic.inflight = structuredClone(other); });
  assert.throws(() => f.assignments.issue(structuredClone(other)), /outage assignment collision/);
  // Restore the first reservation: its held binding is intact.
  f.persist((s) => { s.providers.anthropic.inflight = structuredClone(f.reservation); });
  assert.deepEqual(f.assignments.consume(consumeInput(a)), { ...a, used: true });
  // The colliding reservation was not burned: with fresh entropy it can still be issued.
  fill = 6;
  f.persist((s) => { s.providers.anthropic.inflight = structuredClone(other); });
  const b = f.assignments.issue(structuredClone(other));
  assert.equal(b.sessionID, `gw-probe-${Buffer.alloc(32, 6).toString('base64url')}`);
  assert.notEqual(b.sessionID, a.sessionID);
  // Entropy that is not exactly 32 bytes is refused rather than trusted.
  for (const bad of [(n) => Buffer.alloc(n - 1, 6), () => 'not-bytes']) {
    const g = fixture({ randomSource: bad });
    assert.throws(() => g.assignments.issue(g.copy()), /outage assignment entropy/);
  }
});

test('held and issued maps are capped at 4096 and pruned at expiry so nothing accumulates', () => {
  const f = fixture();
  const base = f.state;
  const issueFresh = () => {
    const r = { ...f.reservation, id: randomBytes(16).toString('hex'), nonce: randomBytes(32).toString('base64url') };
    const next = structuredClone(base); next.providers.anthropic.inflight = r;
    f.state = next;
    return f.assignments.issue(structuredClone(r));
  };
  for (let i = 0; i < 4096; i++) issueFresh();
  assert.throws(issueFresh, /outage assignment capacity/);
  // Nothing is released: held and issued both still hold all 4096 entries when the clock moves.
  f.clock = f.reservation.expiresAt;
  // All 4096 entries expired: a reservation started now issues, proving BOTH maps were pruned
  // (either full map alone would still raise capacity).
  const live = { ...f.reservation, id: randomBytes(16).toString('hex'), nonce: randomBytes(32).toString('base64url'),
    startedAt: f.clock, expiresAt: f.clock + 10000 };
  f.persist((s) => {
    s.providers.anthropic.inflight = structuredClone(live);
    s.providers.anthropic.lastProbeAt = f.clock;
    s.scopes[logicalID].instances[CI].episode.lastProbeAt = f.clock;
  });
  assert.ok(f.assignments.issue(structuredClone(live)));
});

test('a resolved or head-healthy episode closes the binding: consume and lookup refuse, issue refuses', () => {
  // A fresh resolving snapshot or a real head success can close the episode while the probe's
  // inflight reservation is still persisted (until probe-finished clears it).
  for (const flag of ['resolved', 'headHealthy']) {
    const close = (s) => { s.scopes[logicalID].instances[CI].episode[flag] = true; };
    const f = fixture();
    const a = f.assignments.issue(f.copy());
    f.persist(close);
    assert.throws(() => f.assignments.consume(consumeInput(a)), /probe nonce binding/, `consume: ${flag}`);
    const g = fixture();
    const b = g.assignments.issue(g.copy());
    g.assignments.consume(consumeInput(b));
    g.persist(close);
    assert.equal(g.assignments.lookupLease({ sessionID: b.sessionID }), null, `lookup: ${flag}`);
    const h = fixture();
    h.persist(close);
    assert.throws(() => h.assignments.issue(h.copy()), /outage assignment binding/, `issue: ${flag}`);
  }
});

test('a wall-clock rewind never reissues an expired reservation after its reuse guard was pruned', () => {
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  f.assignments.consume(consumeInput(a));
  // At expiry the lookup prunes both the held entry and the issued reuse guard.
  f.clock = f.reservation.expiresAt;
  assert.equal(f.assignments.lookupLease({ sessionID: a.sessionID }), null);
  // The clock rewinds back inside the reservation window: the service must fail closed.
  f.clock = f.reservation.startedAt + 5;
  assert.throws(() => f.assignments.issue(f.copy()), /outage assignment binding/, 'issue after rewind');
  f.clock = f.reservation.expiresAt - 1;
  assert.throws(() => f.assignments.issue(f.copy()), /outage assignment binding/, 'issue one ms before expiry after rewind');
  f.assertUnchanged();
});

test('a rewound clock fails consume and lookup closed; release still works; service resumes when time catches up', () => {
  const f = fixture();
  f.clock = f.reservation.startedAt + 100;
  const a = f.assignments.issue(f.copy());
  f.clock = f.reservation.startedAt + 50;
  assert.throws(() => f.assignments.consume(consumeInput(a)), /probe nonce binding/, 'consume while rewound');
  f.clock = f.reservation.startedAt + 100;
  assert.equal(f.assignments.consume(consumeInput(a)).used, true, 'consume once caught up');
  f.clock = f.reservation.startedAt + 99;
  assert.equal(f.assignments.lookupLease({ sessionID: a.sessionID }), null, 'lookup while rewound');
  // An invalid clock reading neither grants anything nor lowers the high-water mark.
  f.clock = Number.NaN;
  assert.equal(f.assignments.lookupLease({ sessionID: a.sessionID }), null, 'lookup on NaN clock');
  f.clock = f.reservation.startedAt + 99;
  assert.equal(f.assignments.lookupLease({ sessionID: a.sessionID }), null, 'still rewound after NaN');
  f.clock = f.reservation.startedAt + 100;
  assert.ok(f.assignments.lookupLease({ sessionID: a.sessionID }), 'lookup once caught up');
  // Release reads no clock: a rewound clock does not block it.
  f.clock = f.reservation.startedAt + 1;
  f.assignments.release({ sessionID: a.sessionID, probeNonce: a.probeNonce, leaseID: a.leaseID });
  f.clock = f.reservation.startedAt + 100;
  assert.equal(f.assignments.lookupLease({ sessionID: a.sessionID }), null, 'released while rewound');
  f.assertUnchanged();
});

test('policy or target changes after issue fail both consume and lookup', () => {
  const changes = {
    'outage policy disabled': (p) => { p.enabled = false; },
    'reserve no longer mapped': (p) => { p.mappings['claude-opus-5-5'] = ['claude-opus-4-8']; },
    'target provider changed': (p, t) => { t['claude-opus-5'].providerID = 'openai'; },
  };
  for (const [name, mutate] of Object.entries(changes)) {
    for (const step of ['consume', 'lookup']) {
      const p = structuredClone(policy);
      const t = structuredClone(targets);
      const f = fixture();
      const service = createOutageAssignments({ now: () => f.clock, randomBytes, read: () => f.state, targets: t, policy: p });
      const a = service.issue(f.copy());
      if (step === 'consume') {
        mutate(p, t);
        assert.throws(() => service.consume(consumeInput(a)), /probe nonce binding/, `consume: ${name}`);
      } else {
        service.consume(consumeInput(a));
        mutate(p, t);
        assert.equal(service.lookupLease({ sessionID: a.sessionID }), null, `lookup: ${name}`);
      }
      f.assertUnchanged();
    }
  }
});

test('close clears owned maps, is idempotent, and refuses all later use', () => {
  const f = fixture();
  const a = f.assignments.issue(f.copy());
  f.assignments.consume(consumeInput(a));
  f.assignments.close();
  f.assignments.close();
  assert.equal(f.assignments.lookupLease({ sessionID: a.sessionID }), null);
  assert.throws(() => f.assignments.consume(consumeInput(a)), /outage assignment closed/);
  assert.throws(() => f.assignments.issue(f.copy()), /outage assignment closed/);
  f.assignments.release({ sessionID: a.sessionID, probeNonce: a.probeNonce, leaseID: a.leaseID });
  f.assertUnchanged();
  const g = fixture();
  const b = g.assignments.issue(g.copy());
  g.assignments.close();
  assert.throws(() => g.assignments.consume(consumeInput(b)), /outage assignment closed/, 'held but unused at close');
});
