import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutages } from '../lib/model-outage-state.js';
import { emptyOutages, outageGrants, reduceOutages, reserveProbe } from '../lib/model-outages.js';
import { CI_A, CI_B, makePolicy, makeBaseline, makeFailure, makeSnapshot } from './helpers/model-outages.mjs';

// Pulled forward from Task 9 so Task 7's daemon integration can read durable grants. The
// decoder whitelists ONLY the Task 5 state shape; anything else degrades to a state that can
// authorize nothing until a real current-head success re-arms it.
const policy = makePolicy();
const canonicalCredentialInstance = CI_A;
function confirmed() {
  let state = emptyOutages();
  for (const event of [
    makeBaseline(), makeFailure(), makeSnapshot(),
    makeBaseline({ targetID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }),
  ]) state = reduceOutages(state, event, { policy, now: event.finishedAt ?? event.receivedAt });
  return state;
}
const persisted = (state) => JSON.parse(JSON.stringify(state));

test('decoder restores canonical credential instances but drops non-canonical persisted authority', () => {
  let state = emptyOutages();
  for (const event of [
    makeBaseline({ credentialInstance: canonicalCredentialInstance }),
    makeFailure({ credentialInstance: canonicalCredentialInstance }),
    makeSnapshot(),
    makeBaseline({ credentialInstance: canonicalCredentialInstance, targetID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }),
  ]) state = reduceOutages(state, event, { policy, now: event.finishedAt ?? event.receivedAt });
  const valid = persisted(state);
  assert.equal(outageGrants(decodeOutages(valid, { policy }), policy, 20_000).length, 1);

  const nonCanonical = persisted(valid);
  const scope = nonCanonical.scopes['anthropic/opus/standard'];
  scope.currentCredentialInstance = 'ci_A';
  scope.instances.ci_A = scope.instances[canonicalCredentialInstance];
  delete scope.instances[canonicalCredentialInstance];
  scope.instances.ci_A.episode.credentialInstance = 'ci_A';
  scope.instances.ci_A.episode.id = `anthropic/opus/standard:ci_A:${scope.instances.ci_A.episode.firstFailureAt}`;
  assert.deepEqual(outageGrants(decodeOutages(nonCanonical, { policy }), policy, 20_000), []);
});

test('optional outage decode cannot create grants from missing or partial state', () => {
  assert.deepEqual(outageGrants(decodeOutages(undefined), policy, 1000), []);
  assert.deepEqual(decodeOutages(undefined), emptyOutages());
  assert.deepEqual(decodeOutages(null), emptyOutages());
  const partial = { version: 1, lastNow: 1, scopes: { 'anthropic/opus/standard': { generation: 1, currentCredentialInstance: CI_A,
    instances: { [CI_A]: { episode: { deadline: 999999 } } } } } };
  const result = decodeOutages(partial, { policy });
  assert.deepEqual(outageGrants(result, policy, 1000), []);
  assert.equal(result.scopes['anthropic/opus/standard'].instances[CI_A].recoveryRequired, true);
  assert.equal(result.scopes['anthropic/opus/standard'].instances[CI_A].episode, null);
  assert.throws(() => JSON.parse('{broken'), SyntaxError, 'whole-file parser must remain fatal');
  for (const junk of ['x', 7, [], { version: 2, scopes: {} }, { version: 1 }, { version: 1, scopes: [] }]) {
    assert.deepEqual(decodeOutages(junk, { policy }), emptyOutages(), JSON.stringify(junk));
  }
});

test('a committed confirmed episode round-trips through JSON into identical grants, and lapses on time alone', () => {
  const state = confirmed();
  const decoded = decodeOutages(persisted(state), { policy });
  const [live] = outageGrants(state, policy, 20_000);
  const [restored] = outageGrants(decoded, policy, 20_000);
  assert.equal(live.mode, 'confirmed');
  // The feed snapshot is not restored, so the restored grant is PROVISIONAL until the worker's
  // next poll re-confirms it; every identity field is identical.
  assert.deepEqual(restored, { ...live, mode: 'provisional' });
  assert.equal(outageGrants(decoded, policy, 20_000).length, 1);
  assert.deepEqual(outageGrants(decoded, policy, 140_000), [], 'stale proof and snapshot: no grant');
  const instance = decoded.scopes['anthropic/opus/standard'].instances[CI_A];
  assert.equal(instance.recoveryRequired, false);
  assert.equal(instance.baselineAt, 1100);
  assert.equal(instance.episode.phase, 'diagnosing', 'phase is recomputed by the reducer, never trusted from disk');
  assert.deepEqual(instance.episode.proofs, { 'claude-opus-5': { at: 2300, active: false } });
  assert.equal(instance.episode.resolvedAt, null);
  assert.deepEqual(instance.episode.resolvedIncidentIDs, []);
  assert.equal(decoded.lastNow, state.lastNow);
  // Feed snapshots are never restored as freshly received: the worker polls again.
  assert.deepEqual(decoded.snapshots, {});
  // A confirmed decode still reduces: a later event advances it exactly as the live state does.
  const next = reduceOutages(decoded, makeSnapshot({ receivedAt: 20_000 }), { policy, now: 20_000 });
  assert.equal(next.scopes['anthropic/opus/standard'].instances[CI_A].episode.phase, 'confirmed');
});

test('an active proof survives the decode and an episode with the wrong credential instance does not', () => {
  const state = reduceOutages(confirmed(), { type: 'activate', logicalID: 'anthropic/opus/standard', credentialInstance: CI_A, targetID: 'claude-opus-5' },
    { policy, now: 2400 });
  assert.equal(state.scopes['anthropic/opus/standard'].instances[CI_A].episode.proofs['claude-opus-5'].active, true);
  const decoded = decodeOutages(persisted(state), { policy });
  assert.equal(decoded.scopes['anthropic/opus/standard'].instances[CI_A].episode.proofs['claude-opus-5'].active, true);
  assert.equal(outageGrants(decoded, policy, 500_000).length, 1, 'an active proof is not bound by the 120s freshness');
  const crossed = persisted(state);
  crossed.scopes['anthropic/opus/standard'].instances[CI_A].episode.credentialInstance = CI_B;
  const dropped = decodeOutages(crossed, { policy });
  assert.equal(dropped.scopes['anthropic/opus/standard'].instances[CI_A].episode, null);
  assert.equal(dropped.scopes['anthropic/opus/standard'].instances[CI_A].recoveryRequired, true);
  assert.deepEqual(outageGrants(dropped, policy, 20_000), []);
});

test('episode bounds are enforced on decode: deadline, probe counts, and list sizes', async (t) => {
  const base = persisted(confirmed());
  const episode = () => base.scopes['anthropic/opus/standard'].instances[CI_A].episode;
  for (const [name, mutate] of [
    ['deadline', (e) => { e.deadline = e.firstFailureAt + 600_001; }],
    ['probe count', (e) => { e.probeCounts.reserve = 3; }],
    ['failure count', (e) => { e.failures = Array.from({ length: 65 }, (_, i) => ({ at: 2100 + i, requestID: 'r', attemptID: `a${i}` })); }],
    ['incident count', (e) => { e.incidentIDs = Array.from({ length: 65 }, (_, i) => `i${i}`); }],
    ['suppression flag', (e) => { e.suppressed = 'yes'; }],
    ['missing primary', (e) => { delete e.primaryID; }],
  ]) {
    await t.test(name, () => {
    const raw = persisted(base);
    mutate(raw.scopes['anthropic/opus/standard'].instances[CI_A].episode);
    const decoded = decodeOutages(raw, { policy });
    assert.equal(decoded.scopes['anthropic/opus/standard'].instances[CI_A].episode, null, mutate.toString());
    assert.deepEqual(outageGrants(decoded, policy, 20_000), []);
    });
  }
  assert.ok(episode(), 'the unmutated fixture itself is a complete episode');
  const okay = decodeOutages(base, { policy });
  assert.ok(okay.scopes['anthropic/opus/standard'].instances[CI_A].episode);
});

test('terminal history is whitelisted and a reservation loses authority after its episode recovers', () => {
  let state = confirmed();
  const reserved = reserveProbe(state, { logicalID: 'anthropic/opus/standard', targetID: 'claude-opus-5', kind: 'reserve', id: 'res-1', nonce: 'n-1', now: 2400 }, { policy });
  state = reserved.state;
  assert.equal(state.lastNow, 2300, 'reserveProbe does not advance the outcome clock');
  const during = decodeOutages(persisted(state), { policy, now: 2400 });
  assert.deepEqual(during.providers.anthropic.inflight, reserved.reservation);
  state = reduceOutages(state, makeBaseline({ requestID: 'r2', attemptID: 'a2', startedAt: 2500, finishedAt: 2600 }), { policy, now: 2600 });
  assert.equal(state.history.length, 1);
  assert.equal(state.scopes['anthropic/opus/standard'].instances[CI_A].episode, null);
  const decoded = decodeOutages(persisted(state), { policy, now: 2600 });
  assert.equal(decoded.history.length, 1);
  assert.equal(decoded.history[0].phase, 'recovered');
  assert.deepEqual(decoded.history[0].proofs, {}, 'history never restores proofs as current grants');
  assert.equal(decoded.history[0].id, state.history[0].id);
  assert.deepEqual(decoded.providers.anthropic.inflight, { id: 'res-1', expiresAt: 12400 });
  assert.equal(decoded.providers.anthropic.lastProbeAt, 2400);
  const overflow = persisted(state);
  overflow.history = Array.from({ length: 70 }, (_, i) => ({ ...state.history[0],
    id: `anthropic/opus/standard:${CI_A}:${2000 + i}`, firstFailureAt: 2000 + i, deadline: 602000 + i,
    failures: [{ at: 2000 + i, requestID: `r-${i}`, attemptID: `a-${i}` }] }));
  assert.equal(decodeOutages(overflow, { policy }).history.length, 64);
  const history = decodeOutages(overflow, { policy }).history;
  assert.equal(history[0].id, `anthropic/opus/standard:${CI_A}:2006`);
  assert.equal(history[63].id, `anthropic/opus/standard:${CI_A}:2069`, 'the LAST 64 distinct episodes are kept');
  assert.ok(history.every((entry) => Object.keys(entry.proofs).length === 0));
  const crippled = persisted(state);
  crippled.providers.anthropic.inflight = { id: 'res-1', expiresAt: 12400, nonce: 7 };
  assert.deepEqual(decodeOutages(crippled, { policy, now: 2600 }).providers.anthropic.inflight, { id: 'res-1', expiresAt: 12400 },
    'a reservation that is not whole still blocks dispatch by id and expiry only');
  crippled.providers.anthropic.inflight = { nonce: 'n-1' };
  assert.equal(decodeOutages(crippled, { policy }).providers.anthropic.inflight, null);
  crippled.providers.unknown = { lastPollAt: 1 };
  assert.equal('unknown' in decodeOutages(crippled, { policy }).providers, false);
});

test('decoder drops malformed active authority before the reducer can grant it', async (t) => {
  const baseline = persisted(reduceOutages(confirmed(), { type: 'activate', logicalID: 'anthropic/opus/standard', credentialInstance: CI_A, targetID: 'claude-opus-5' }, { policy, now: 2400 }));
  const mutations = [
    (raw) => { raw.scopes['anthropic/opus/standard'].instances[CI_A].episode.id = ''; },
    (raw) => { raw.scopes['anthropic/opus/standard'].instances[CI_A].episode.id = 'wrong:episode:tuple'; },
    (raw) => { raw.scopes['anthropic/opus/standard'].instances[CI_A].episode.proofs.unexpected = { at: 2300, active: true }; },
    (raw) => { raw.scopes['anthropic/opus/standard'].instances[CI_A].episode.proofs['not-a-reserve'] = { at: 2300, active: true }; },
    (raw) => { raw.scopes['anthropic/opus/standard'].instances[CI_A].episode.proofs['claude-opus-5'].at = raw.lastNow + 1; },
    (raw) => { raw.scopes['anthropic/opus/standard'].generation = null; },
    (raw) => { raw.scopes['anthropic/opus/standard'].instances[CI_A].baselineAt = null; },
    (raw) => { raw.scopes['anthropic/opus/standard'].instances[CI_A].recoveryRequired = true; },
    (raw) => { raw.scopes['anthropic/opus/standard'].currentCredentialInstance = CI_B; },
  ];
  for (const mutate of mutations) {
    await t.test(mutate.toString(), () => {
    const raw = persisted(baseline);
    mutate(raw);
    const decoded = decodeOutages(raw, { policy });
    assert.deepEqual(outageGrants(decoded, policy, raw.lastNow), [], mutate.toString());
    const replayed = reduceOutages(decoded, makeSnapshot({ receivedAt: raw.lastNow }), { policy, now: raw.lastNow });
    assert.deepEqual(outageGrants(replayed, policy, raw.lastNow), [], `reducer must not reopen ${mutate}`);
    });
  }
  assert.deepEqual(outageGrants(decodeOutages(baseline), policy, baseline.lastNow), [], 'missing policy restores no authority');
});

test('decoder accepts the configured maximum proof map', () => {
  const threeReservePolicy = makePolicy();
  threeReservePolicy.mappings['claude-opus-5-5'] = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'];
  const state = persisted(confirmed());
  const active = state.scopes['anthropic/opus/standard'].instances[CI_A].episode;
  active.proofs = Object.fromEntries(threeReservePolicy.mappings['claude-opus-5-5'].map((id) => [id, { at: 2300, active: true }]));
  const decoded = decodeOutages(state, { policy: threeReservePolicy });
  assert.equal(Object.keys(decoded.scopes['anthropic/opus/standard'].instances[CI_A].episode.proofs).length, 3);
});

test('structural overflow restores nothing that could authorize', () => {
  const state = persisted(confirmed());
  const tooManyScopes = { ...state, scopes: { ...state.scopes,
    ...Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`s${i}`, state.scopes['anthropic/opus/standard']])) } };
  assert.deepEqual(decodeOutages(tooManyScopes, { policy }).scopes, {});
  const tooManyInstances = persisted(state);
  tooManyInstances.scopes['anthropic/opus/standard'].instances = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [`ci_${i}`, state.scopes['anthropic/opus/standard'].instances[CI_A]]));
  assert.equal('anthropic/opus/standard' in decodeOutages(tooManyInstances, { policy }).scopes, false);
  const rollback = { ...state, lastNow: -5 };
  assert.equal(decodeOutages(rollback, { policy }).lastNow, 0);
});

const logicalID = 'anthropic/opus/standard';
const instanceOf = (state) => state.scopes[logicalID].instances[CI_A];
const episodeOf = (state) => instanceOf(state).episode;
const activeState = () => reduceOutages(confirmed(), {
  type: 'activate', logicalID, credentialInstance: CI_A, targetID: 'claude-opus-5',
}, { policy, now: 2400 });

// A dropped graph must remain inert even when later trusted reserve outcomes rotate back to
// its credential. Only an actual PRIMARY success may re-arm missing authority evidence.
function assertCannotResume(raw, selectedPolicy = policy) {
  let decoded = decodeOutages(raw, { policy: selectedPolicy, now: 3000 });
  assert.deepEqual(outageGrants(decoded, policy, 3000), [], 'restart grants');
  for (const event of [
    { type: 'tick' }, makeSnapshot({ receivedAt: 3100 }),
    makeFailure({ requestID: 'later', attemptID: 'later', startedAt: 3200, finishedAt: 3300 }),
    makeBaseline({ targetID: 'claude-opus-5', purpose: 'outage-health', startedAt: 3400, finishedAt: 3500 }),
    makeBaseline({ targetID: 'claude-opus-5', requestID: 'reserve-real', attemptID: 'reserve-real', startedAt: 3600, finishedAt: 3700 }),
  ]) {
    const now = event.finishedAt ?? event.receivedAt ?? 3000;
    decoded = reduceOutages(decoded, event, { policy, now });
    assert.deepEqual(outageGrants(decoded, policy, now), [], `after ${event.type}/${event.targetID ?? ''}/${event.purpose ?? ''}`);
  }
}

const badAuthority = [
  ['baseline missing', (s) => { delete instanceOf(s).baselineAt; }],
  ['baseline null', (s) => { instanceOf(s).baselineAt = null; }],
  ['baseline after first failure', (s) => { instanceOf(s).baselineAt = 2200; }],
  ['baseline future', (s) => { instanceOf(s).baselineAt = 3001; }],
  ['recovery required', (s) => { instanceOf(s).recoveryRequired = true; }],
  ['recovery flag missing', (s) => { delete instanceOf(s).recoveryRequired; }],
  ['generation missing', (s) => { delete s.scopes[logicalID].generation; }],
  ['generation zero', (s) => { s.scopes[logicalID].generation = 0; }],
  ['generation fractional', (s) => { s.scopes[logicalID].generation = 1.5; }],
  ['current owner absent', (s) => { s.scopes[logicalID].currentCredentialInstance = 'ci_absent'; }],
  ['owner mismatch', (s) => { episodeOf(s).credentialInstance = 'ci_other'; }],
  ['last failure missing', (s) => { delete instanceOf(s).lastPrimaryFailureAt; }],
  ['last failure before episode', (s) => { instanceOf(s).lastPrimaryFailureAt = 2000; }],
  ['last failure future', (s) => { instanceOf(s).lastPrimaryFailureAt = 3001; }],
  ['last seen missing', (s) => { delete instanceOf(s).lastSeenAt; }],
  ['last seen before failure', (s) => { instanceOf(s).lastSeenAt = 2000; }],
  ['last seen future', (s) => { instanceOf(s).lastSeenAt = 3001; }],
  ['proof before episode', (s) => { episodeOf(s).proofs['claude-opus-5'] = { at: 2000, active: true }; }],
  ['proof future', (s) => { episodeOf(s).proofs['claude-opus-5'] = { at: 3001, active: true }; }],
  ['malformed proof member', (s) => { episodeOf(s).proofs['claude-opus-4-8'] = null; }],
  ['unknown proof member', (s) => { episodeOf(s).proofs.unexpected = { at: 2300, active: true }; }],
  ['oversized proof map', (s) => { Object.assign(episodeOf(s).proofs,
    Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`unknown-${i}`, { at: 2300, active: true }]))); }],
  ['failure before episode', (s) => { episodeOf(s).failures[0].at = 2000; }],
  ['missing failure evidence', (s) => { episodeOf(s).failures = []; }],
  ['unsafe deadline', (s) => { episodeOf(s).deadline = Number.MAX_SAFE_INTEGER + 1; }],
  ['wrong deadline', (s) => { episodeOf(s).deadline++; }],
];
for (const [label, value] of [['empty', ''], ['whitespace', ' '], ['control', 'bad\u0000id']]) {
  for (const [field, mutate] of [
    ['episode ID', (s) => { episodeOf(s).id = value; }],
    ['primary ID', (s) => { episodeOf(s).primaryID = value; }],
    ['proof ID', (s) => { episodeOf(s).proofs[value] = { at: 2300, active: true }; delete episodeOf(s).proofs['claude-opus-5']; }],
    ['failure request ID', (s) => { episodeOf(s).failures[0].requestID = value; }],
    ['failure attempt ID', (s) => { episodeOf(s).failures[0].attemptID = value; }],
    ['current credential ID', (s) => { s.scopes[logicalID].currentCredentialInstance = value; }],
  ]) badAuthority.push([`${label} ${field}`, mutate]);
}
for (const [name, mutate] of badAuthority) {
  for (const noncurrent of [false, true]) {
    test(`authority ${noncurrent ? 'noncurrent then rotated' : 'current'}: ${name}`, () => {
      let raw = activeState();
      if (noncurrent) raw = reduceOutages(raw, makeFailure({ credentialInstance: CI_B, startedAt: 2500, finishedAt: 2600 }), { policy, now: 2600 });
      raw = persisted(raw);
      mutate(raw);
      assertCannotResume(raw);
    });
  }
}

test('valid noncurrent armed episode preserves bounds and can continue after a trusted rotation', () => {
  const reserved = reserveProbe(confirmed(), { logicalID, targetID: 'claude-opus-5', kind: 'reserve', id: 'res-1', nonce: 'n-1', now: 2400 }, { policy });
  const rotated = reduceOutages(reserved.state, makeFailure({ credentialInstance: CI_B, startedAt: 2500, finishedAt: 2600 }), { policy, now: 2600 });
  const decoded = decodeOutages(persisted(rotated), { policy, now: 2700 });
  assert.equal(instanceOf(decoded).recoveryRequired, false);
  assert.deepEqual(episodeOf(decoded), { ...episodeOf(rotated), proofs: {}, phase: 'diagnosing' });
  const continued = reduceOutages(decoded, makeBaseline({ targetID: 'claude-opus-5', startedAt: 2800, finishedAt: 2900 }), { policy, now: 2900 });
  assert.equal(outageGrants(continued, policy, 2900).length, 1);
  assert.equal(episodeOf(continued).deadline, episodeOf(rotated).deadline);
  assert.deepEqual(episodeOf(continued).probeCounts, { reserve: 1, primary: 0 });
});

for (const [name, mutate] of [
  ['inherited scope', (p) => { p.expectedScopePolicies = Object.create(p.expectedScopePolicies); }],
  ['inherited mapping', (p) => { p.mappings = Object.create(p.mappings); }],
  ['inherited primary scope', (p) => { p.primaryScope = Object.create(p.primaryScope); }],
  ['crossed primary scope', (p) => { p.primaryScope['claude-opus-5-5'] = 'openai/sol/standard'; }],
  ['crossed provider scope', (p) => { p.expectedScopePolicies[logicalID].providerID = 'openai'; }],
]) test(`policy reference: ${name}`, () => {
  const changed = makePolicy(); mutate(changed);
  assertCannotResume(persisted(activeState()), changed);
});

function probeState(kind = 'reserve') {
  return reserveProbe(confirmed(), { logicalID, targetID: kind === 'reserve' ? 'claude-opus-5' : 'claude-opus-5-5',
    kind, id: 'res-1', nonce: 'n-1', now: 2400 }, { policy });
}
for (const kind of ['reserve', 'primary']) test(`unaltered reducer ${kind} reservation round-trips with counters and occupancy`, () => {
  const reserved = probeState(kind);
  const decoded = decodeOutages(persisted(reserved.state), { policy, now: 2400 });
  assert.equal(decoded.lastNow, 2300);
  assert.deepEqual(decoded.providers.anthropic, reserved.state.providers.anthropic);
  assert.deepEqual(instanceOf(decoded), { ...instanceOf(reserved.state), episode: { ...episodeOf(reserved.state), phase: 'diagnosing' } });
  assert.equal(reserveProbe(decoded, { logicalID, kind, targetID: reserved.reservation.targetID, id: 'next', nonce: 'next', now: 2500 }, { policy }), null);
});
const badReservations = [
  ['kind', (r) => { r.kind = 'other'; }], ['purpose', (r) => { r.purpose = 'real'; }],
  ['provider', (r) => { r.providerID = 'openai'; }], ['generation', (r) => { r.generation++; }],
  ['owner', (r) => { r.expectedCredentialInstance = CI_B; }], ['scope', (r) => { r.logicalID = 'openai/sol/standard'; }],
  ['primary', (r) => { r.primaryID = 'claude-opus-5-5-fast'; }], ['target', (r) => { r.targetID = 'claude-opus-4-7'; }],
  ['episode', (r) => { r.episodeID = 'wrong'; }], ['TTL', (r) => { r.expiresAt--; }],
  ['start', (r) => { r.startedAt--; r.expiresAt--; }],
  ['provider last probe', (_r, s) => { s.providers.anthropic.lastProbeAt = 2399; }],
  ['missing provider last probe', (_r, s) => { delete s.providers.anthropic.lastProbeAt; }],
  ['zero count', (_r, s) => { episodeOf(s).probeCounts.reserve = 0; }],
  ['recovered episode', (_r, s) => { episodeOf(s).headHealthy = true; }],
  ['resolved episode', (_r, s) => { episodeOf(s).resolved = true; episodeOf(s).resolvedAt = 2300; }],
];
for (const [label, value] of [['empty', ''], ['whitespace', ' '], ['control', 'bad\u0000id']]) {
  for (const field of ['id', 'nonce', 'logicalID', 'targetID', 'primaryID', 'episodeID', 'expectedCredentialInstance']) {
    badReservations.push([`${label} ${field}`, (r) => { r[field] = value; }]);
  }
}
for (const [name, mutate] of badReservations) test(`reservation authority: ${name}`, () => {
  const raw = persisted(probeState().state);
  // This positive control makes each mutation's downgrade non-vacuous.
  assert.deepEqual(decodeOutages(raw, { policy, now: 2400 }).providers.anthropic.inflight, raw.providers.anthropic.inflight);
  mutate(raw.providers.anthropic.inflight, raw);
  const r = raw.providers.anthropic.inflight;
  assert.deepEqual(decodeOutages(raw, { policy, now: 2400 }).providers.anthropic.inflight,
    name.endsWith(' id') ? null : { id: r.id, expiresAt: r.expiresAt });
});
test('future probe timestamps cannot resume authority at the injected wall clock', () => {
  const raw = persisted(probeState().state);
  const decoded = decodeOutages(raw, { policy, now: 2399 });
  assert.equal(decoded.providers.anthropic.inflight, null);
  assert.equal(instanceOf(decoded).episode, null);
});

test('future provider clocks are discarded so they cannot suppress a probe', () => {
  const raw = persisted(confirmed());
  raw.providers.anthropic = { lastPollAt: Number.MAX_SAFE_INTEGER, lastProbeAt: Number.MAX_SAFE_INTEGER, inflight: null };
  const decoded = decodeOutages(raw, { policy, now: 2400 });
  assert.equal(decoded.providers.anthropic.lastPollAt, null);
  assert.equal(decoded.providers.anthropic.lastProbeAt, null);
  assert.ok(reserveProbe(decoded, { logicalID, targetID: 'claude-opus-5', kind: 'reserve', id: 'res-1', nonce: 'n-1', now: 2400 }, { policy }));
});

test('a far-future incomplete reservation cannot occupy a provider', () => {
  const raw = persisted(confirmed());
  raw.providers.anthropic = { lastPollAt: null, lastProbeAt: null,
    inflight: { id: 'x', expiresAt: Number.MAX_SAFE_INTEGER, nonce: 7 } };
  const decoded = decodeOutages(raw, { policy, now: 2400 });
  assert.equal(decoded.providers.anthropic.inflight, null);
  assert.ok(reserveProbe(decoded, { logicalID, targetID: 'claude-opus-5', kind: 'reserve', id: 'res-1', nonce: 'n-1', now: 2400 }, { policy }));
});

test('a live reservation blocks redispatch but an expired one is dropped', () => {
  const reserved = probeState();
  const live = decodeOutages(persisted(reserved.state), { policy, now: 2400 });
  assert.deepEqual(live.providers.anthropic.inflight, reserved.reservation);
  assert.equal(reserveProbe(live, { logicalID, targetID: 'claude-opus-5', kind: 'reserve', id: 'next', nonce: 'next', now: 2500 }, { policy }), null);
  const expired = decodeOutages(persisted(reserved.state), { policy, now: 13000 });
  assert.equal(expired.providers.anthropic.inflight, null);
});
