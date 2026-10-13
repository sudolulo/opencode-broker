import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyOutages, reduceOutages, reserveProbe, outageGrants } from '../lib/model-outages.js';
import { decodeOutages } from '../lib/model-outage-state.js';
import { CI_A, CI_B, makePolicy, makeBaseline, makeFailure, makeSnapshot } from './helpers/model-outages.mjs';

const policy = makePolicy();
const logicalID = 'anthropic/opus/standard';
const step = (state, event, now = event.finishedAt ?? event.receivedAt) => reduceOutages(state, event, { policy, now });

test('A episode bounds survive B rotation, B real head success arms only future B failure, and A return remains latched', () => {
  let state = step(emptyOutages(), makeBaseline());
  state = step(state, makeFailure());
  state = step(state, makeSnapshot());
  const reserved = reserveProbe(state, { logicalID, targetID: 'claude-opus-5', kind: 'reserve', id: 'p1', nonce: 'n1', now: 2300 }, { policy });
  assert.ok(reserved);
  state = reserved.state;
  state = step(state, { type: 'tick' }, 602101);
  const before = structuredClone(state.scopes[logicalID].instances[CI_A].episode);
  assert.equal(before.suppressed, true);
  assert.equal(before.probeCounts.reserve, 1);
  state = step(state, makeFailure({ credentialInstance: CI_B, startedAt: 603000, finishedAt: 603001 }));
  assert.equal(state.scopes[logicalID].instances[CI_B].episode, null);
  state = step(state, makeBaseline({ credentialInstance: CI_B, requestID: 'B-base', startedAt: 604000, finishedAt: 604001 }));
  assert.equal(state.scopes[logicalID].instances[CI_B].baselineAt, 604001);
  const episodeA = state.scopes[logicalID].instances[CI_A].episode;
  assert.deepEqual([episodeA.id, episodeA.deadline, episodeA.probeCounts, episodeA.suppressed], [before.id, before.deadline, before.probeCounts, true]);
  state = step(state, makeFailure({ credentialInstance: CI_B, requestID: 'B-future', startedAt: 605000, finishedAt: 605001 }));
  assert.equal(state.scopes[logicalID].instances[CI_B].episode.firstFailureAt, 605001);
  state = step(state, makeFailure({ requestID: 'A-return', startedAt: 606000, finishedAt: 606001 }));
  const returned = state.scopes[logicalID].instances[CI_A].episode;
  assert.deepEqual([returned.id, returned.deadline, returned.probeCounts, returned.suppressed], [before.id, before.deadline, before.probeCounts, true]);
  assert.deepEqual(outageGrants(state, policy, 606001), []);
});

test('late same incident confirmation preserves fixed bounds and resolution does not reset', () => {
  let state = step(step(emptyOutages(), makeBaseline()), makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, makeBaseline({ targetID: 'claude-opus-5', modelID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }));
  assert.equal(outageGrants(state, policy, 2300).length, 1);
  const id = state.scopes[logicalID].instances[CI_A].episode.id;
  state = step(state, { type: 'tick' }, 603000);
  assert.equal(outageGrants(state, policy, 603000).length, 0);
  state = step(state, makeSnapshot({ receivedAt: 604000 }));
  assert.equal(outageGrants(state, policy, 604000).length, 0);
  state = step(state, makeSnapshot({ receivedAt: 605000, matches: {}, resolved: ['claude-opus-5-5'] }));
  assert.equal(state.scopes[logicalID].instances[CI_A].episode.id, id);
});

test('same-instance bound primary probe recovers but new-instance probe cannot bootstrap', () => {
  let state = step(emptyOutages(), makeBaseline());
  state = step(state, makeFailure());
  state = step(state, makeBaseline({ purpose: 'outage-health', startedAt: 4000, finishedAt: 4100 }));
  assert.equal(state.scopes[logicalID].instances[CI_A].baselineAt, 4100);
  assert.equal(state.scopes[logicalID].instances[CI_A].episode, null);
  state = step(state, makeBaseline({ purpose: 'outage-health', credentialInstance: 'ci_new', startedAt: 5000, finishedAt: 5100 }));
  assert.equal(state.scopes[logicalID].instances.ci_new.baselineAt, null, 'new instance without real baseline stays unbootstrapped');
});

test('partial state and probe cannot bootstrap baseline', () => {
  let state = step(emptyOutages(), makeFailure());
  assert.equal(state.scopes[logicalID].instances[CI_A].episode, null);
  state = step(state, makeBaseline({ purpose: 'outage-health', startedAt: 3000, finishedAt: 3100 }));
  assert.equal(state.scopes[logicalID].instances[CI_A].baselineAt, null);
  state = step(state, makeBaseline({ startedAt: 4000, finishedAt: 4100 }));
});

test('late SAME incident confirms active proof without resetting suppression then stale returns suppressed', () => {
  let state = step(step(emptyOutages(), makeBaseline()), makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, makeBaseline({ targetID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }));
  state = step(state, { type: 'activate', logicalID, targetID: 'claude-opus-5', credentialInstance: CI_A }, 2301);
  const before = structuredClone(state.scopes[logicalID].instances[CI_A].episode);
  state = step(state, { type: 'tick' }, 602101);
  assert.equal(outageGrants(state, policy, 602101).length, 0);
  state = step(state, makeSnapshot({ receivedAt: 604000 }));
  const episode = state.scopes[logicalID].instances[CI_A].episode;
  assert.equal(outageGrants(state, policy, 604000)[0].mode, 'confirmed');
  assert.equal(episode.suppressed, true);
  assert.deepEqual([episode.id, episode.deadline, episode.probeCounts], [before.id, before.deadline, before.probeCounts]);
  state = step(state, { type: 'tick' }, 724001);
  assert.equal(outageGrants(state, policy, 724001).length, 0);
  assert.equal(state.scopes[logicalID].instances[CI_A].episode.phase, 'suppressed-unconfirmed');
});

test('unrelated resolved history cannot close a current active incident', () => {
  let state = step(step(emptyOutages(), makeBaseline()), makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, makeSnapshot({ receivedAt: 2400, resolvedIncidentIDs: { 'claude-opus-5-5': ['unrelated-old'] } }));
  assert.equal(state.scopes[logicalID].instances[CI_A].episode.resolved, false);
  state = step(state, makeSnapshot({ receivedAt: 2500, matches: {}, resolvedIncidentIDs: { 'claude-opus-5-5': ['incident-1'] } }));
  assert.equal(state.scopes[logicalID].instances[CI_A].episode.resolved, true);
});

test('excluded trusted outcomes and retries of one request cannot diagnose service outage', () => {
  for (const result of ['unknown', 'scope-mismatch']) {
    const state = step(step(emptyOutages(), makeBaseline()), makeFailure({ result }));
    assert.equal(state.scopes[logicalID].instances[CI_A].episode, null);
  }
  let state = step(emptyOutages(), makeBaseline());
  for (let number = 0; number < 3; number++) state = step(state, makeFailure({ requestID: 'same', attemptID: `a${number}`, startedAt: 2000 + number * 200, finishedAt: 2100 + number * 200 }));
  assert.equal(reserveProbe(state, { logicalID, targetID: 'claude-opus-5', kind: 'reserve', id: 'blocked', nonce: 'blocked', now: 3000 }, { policy }), null);
});

test('proxy-scope outcome for a never-seen credential instance creates no credential state', () => {
  const state = step(emptyOutages(), makeFailure({ credentialInstance: 'ci_refused', failureOrigin: 'proxy-scope' }));
  assert.deepEqual(state.scopes, {});
});

test('a current trusted scope-mismatch revokes every old-scope proof without changing episode bounds', () => {
  let state = step(step(emptyOutages(), makeBaseline()), makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, makeBaseline({ targetID: 'claude-opus-5', modelID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }));
  state = step(state, { type: 'activate', logicalID, targetID: 'claude-opus-5', credentialInstance: CI_A }, 2301);
  const before = structuredClone(state.scopes[logicalID].instances[CI_A].episode);

  state = step(state, makeFailure({ credentialInstance: 'ci_refused', expectedCredentialInstance: CI_A, failureOrigin: 'proxy-scope', result: 'scope-mismatch', generation: 2, startedAt: 2400, finishedAt: 2500 }));

  const after = state.scopes[logicalID].instances[CI_A].episode;
  assert.deepEqual(after.proofs, {});
  assert.deepEqual([after.id, after.deadline, after.probeCounts, after.lastProbeAt, after.suppressed, after.failures, after.incidentIDs], [before.id, before.deadline, before.probeCounts, before.lastProbeAt, before.suppressed, before.failures, before.incidentIDs]);
  assert.equal(state.scopes[logicalID].instances.ci_refused, undefined);
  assert.deepEqual(outageGrants(state, policy, 2500), []);

  state = step(state, makeBaseline({ credentialInstance: 'ci_new', requestID: 'new-scope-success', attemptID: 'new-scope-success-attempt', startedAt: 2600, finishedAt: 2700 }));
  assert.equal(state.scopes[logicalID].currentCredentialInstance, 'ci_new');
  assert.equal(state.scopes[logicalID].instances.ci_new.baselineAt, 2700);
});

test('stale scope-mismatch and other proxy origins leave old-scope proofs intact', () => {
  let state = step(step(emptyOutages(), makeBaseline()), makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, makeBaseline({ targetID: 'claude-opus-5', modelID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }));
  state = step(state, { type: 'activate', logicalID, targetID: 'claude-opus-5', credentialInstance: CI_A }, 2301);
  for (const event of [
    makeFailure({ credentialInstance: 'ci_refused', expectedCredentialInstance: 'ci_stale', failureOrigin: 'proxy-scope', result: 'scope-mismatch', generation: 2, startedAt: 2400, finishedAt: 2500 }),
    makeFailure({ credentialInstance: 'ci_refused', expectedCredentialInstance: CI_A, failureOrigin: 'proxy-scope', result: 'scope-mismatch', generation: 1, startedAt: 2501, finishedAt: 2600 }),
    makeFailure({ credentialInstance: 'ci_refused', expectedCredentialInstance: CI_A, failureOrigin: 'proxy-network', result: 'unknown', generation: 2, startedAt: 2601, finishedAt: 2700 }),
  ]) state = step(state, event);
  assert.equal(state.scopes[logicalID].instances[CI_A].episode.proofs['claude-opus-5'].active, true);
  assert.equal(state.scopes[logicalID].instances.ci_refused, undefined);
});

test('proxy-network, proxy-credentials, and proxy-validation failures do not count toward diagnosis', () => {
  let state = step(emptyOutages(), makeBaseline());
  for (const [number, failureOrigin] of ['proxy-network', 'proxy-credentials', 'proxy-validation'].entries()) {
    state = step(state, makeFailure({ failureOrigin, requestID: `proxy-${number}`, attemptID: `proxy-attempt-${number}`, startedAt: 2000 + number, finishedAt: 2100 + number }));
  }
  assert.equal(state.scopes[logicalID].instances[CI_A].episode, null);
});

test('proxy outcomes cannot recover an episode', () => {
  let state = step(step(emptyOutages(), makeBaseline()), makeFailure());
  state = step(state, makeSnapshot());
  const before = structuredClone(state.scopes[logicalID].instances[CI_A]);
  state = step(state, makeBaseline({ failureOrigin: 'proxy-auth-context', startedAt: 2300, finishedAt: 2400 }));
  const after = state.scopes[logicalID].instances[CI_A];
  assert.equal(after.episode.id, before.episode.id);
  assert.equal(after.baselineAt, before.baselineAt);
  assert.equal(after.recoveryRequired, before.recoveryRequired);
});

test('credential-instance eviction requires a returning instance to establish a new real baseline', () => {
  let state = step(step(emptyOutages(), makeBaseline()), makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, { type: 'tick' }, 602101);
  assert.equal(state.scopes[logicalID].instances[CI_A].episode.suppressed, true);

  for (let number = 0; number < 16; number++) {
    state = step(state, makeFailure({ credentialInstance: `ci_rotation_${number}`, requestID: `rotation-${number}`,
      attemptID: `rotation-attempt-${number}`, startedAt: 603000 + number, finishedAt: 603001 + number }));
  }
  assert.equal(Object.keys(state.scopes[logicalID].instances).length, 16);
  assert.equal(state.scopes[logicalID].instances[CI_A], undefined);

  state = step(state, makeFailure({ requestID: 'A-return', attemptID: 'A-return-failure', startedAt: 604000, finishedAt: 604001 }));
  assert.equal(state.scopes[logicalID].instances[CI_A].episode, null);
  state = step(state, makeBaseline({ requestID: 'A-rebaseline', attemptID: 'A-rebaseline-success', startedAt: 605000, finishedAt: 605001 }));
  state = step(state, makeFailure({ requestID: 'A-future', attemptID: 'A-future-failure', startedAt: 606000, finishedAt: 606001 }));
  assert.equal(state.scopes[logicalID].instances[CI_A].episode.firstFailureAt, 606001);
});

test('eviction is no weaker than in-place recovery: only a real head success re-arms a returning instance', () => {
  let inPlace = step(step(emptyOutages(), makeBaseline()), makeFailure());
  inPlace = step(inPlace, makeSnapshot());
  inPlace = step(inPlace, { type: 'tick' }, 602101);
  const oldEpisode = structuredClone(inPlace.scopes[logicalID].instances[CI_A].episode);
  assert.equal(oldEpisode.suppressed, true);
  inPlace = step(inPlace, makeBaseline({ requestID: 'in-place-recovery', attemptID: 'in-place-recovery-success', startedAt: 605000, finishedAt: 605001 }));
  assert.equal(inPlace.history.at(-1).id, oldEpisode.id);
  assert.equal(inPlace.history.at(-1).phase, 'recovered');
  inPlace = step(inPlace, makeFailure({ requestID: 'in-place-new-failure', attemptID: 'in-place-new-failure-attempt', startedAt: 606000, finishedAt: 606001 }));
  const inPlaceEpisode = inPlace.scopes[logicalID].instances[CI_A].episode;
  assert.deepEqual([inPlaceEpisode.firstFailureAt, inPlaceEpisode.deadline], [606001, 1206001]);

  let evicted = step(step(emptyOutages(), makeBaseline()), makeFailure());
  evicted = step(evicted, makeSnapshot());
  evicted = step(evicted, { type: 'tick' }, 602101);
  for (let number = 0; number < 16; number++) {
    evicted = step(evicted, makeFailure({ credentialInstance: `ci_equivalence_rotation_${number}`, requestID: `equivalence-rotation-${number}`,
      attemptID: `equivalence-rotation-attempt-${number}`, startedAt: 603000 + number, finishedAt: 603001 + number }));
  }
  evicted = step(evicted, makeFailure({ requestID: 'evicted-return-failure', attemptID: 'evicted-return-failure-attempt', startedAt: 604000, finishedAt: 604001 }));
  assert.equal(evicted.scopes[logicalID].instances[CI_A].episode, null);
  evicted = step(evicted, makeBaseline({ requestID: 'evicted-recovery', attemptID: 'evicted-recovery-success', startedAt: 605000, finishedAt: 605001 }));
  evicted = step(evicted, makeFailure({ requestID: 'evicted-new-failure', attemptID: 'evicted-new-failure-attempt', startedAt: 606000, finishedAt: 606001 }));
  const evictedEpisode = evicted.scopes[logicalID].instances[CI_A].episode;
  assert.deepEqual([evictedEpisode.firstFailureAt, evictedEpisode.deadline], [inPlaceEpisode.firstFailureAt, inPlaceEpisode.deadline]);
});

test('fresh auth evidence reevaluates pending distinct auth failures without changing their deadline', () => {
  let state = step(emptyOutages(), makeBaseline());
  for (let number = 0; number < 3; number++) {
    state = step(state, makeFailure({ result: 'auth-fault', requestID: `auth-request-${number}`, attemptID: `auth-attempt-${number}`,
      startedAt: 2000 + number, finishedAt: 2000 + number }));
  }
  assert.equal(state.scopes[logicalID].instances[CI_A].episode, null);
  state = step(state, makeSnapshot({ receivedAt: 2100, matches: {}, authMatches: { 'claude-opus-5-5': ['auth-incident-1'] } }));
  const episode = state.scopes[logicalID].instances[CI_A].episode;
  assert.equal(episode.firstFailureAt, 2000);
  assert.equal(episode.deadline, 602000);
  assert.equal(episode.failures.length, 3);
  assert.ok(reserveProbe(state, { logicalID, targetID: 'claude-opus-5', kind: 'reserve', id: 'auth-probe', nonce: 'auth-nonce', now: 2100 }, { policy }));
});

test('a real primary success discards stale pending auth failures before a matching snapshot arrives', () => {
  let state = step(emptyOutages(), makeBaseline());
  state = step(state, makeFailure({ result: 'auth-fault', requestID: 'pending-auth', attemptID: 'pending-auth-attempt',
    startedAt: 2000, finishedAt: 2100 }));
  assert.equal(state.scopes[logicalID].instances[CI_A].pendingAuth.length, 1);
  state = step(state, makeBaseline({ requestID: 'trusted-success', attemptID: 'trusted-success-attempt', startedAt: 2150, finishedAt: 2200 }));
  state = step(state, makeSnapshot({ receivedAt: 2300, authMatches: { 'claude-opus-5-5': ['auth-incident-1'] } }));

  assert.equal(state.scopes[logicalID].instances[CI_A].episode, null);
  assert.deepEqual(outageGrants(state, policy, 2300), []);
  assert.equal(reserveProbe(state, { logicalID, targetID: 'claude-opus-5', kind: 'reserve', id: 'stale-auth-probe', nonce: 'stale-auth-nonce', now: 2300 }, { policy }), null);
});

test('resolution retains bounds and clears proofs, so a re-match authorizes again only after a fresh reserve proof', () => {
  let state = step(step(emptyOutages(), makeBaseline()), makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, makeBaseline({ targetID: 'claude-opus-5', modelID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }));
  // An active proof never expires on its own; resolution must be what retires it.
  state = step(state, { type: 'activate', logicalID, targetID: 'claude-opus-5', credentialInstance: CI_A }, 2301);
  assert.equal(state.scopes[logicalID].instances[CI_A].episode.proofs['claude-opus-5'].active, true);
  const before = structuredClone(state.scopes[logicalID].instances[CI_A].episode);
  assert.equal(outageGrants(state, policy, 2301).length, 1);
  const bounds = (episode) => [episode.id, episode.deadline, episode.probeCounts, episode.lastProbeAt, episode.suppressed, episode.failures, episode.incidentIDs];

  state = step(state, makeSnapshot({ receivedAt: 2400, matches: {}, resolvedIncidentIDs: { 'claude-opus-5-5': ['incident-1'] } }));
  const resolved = state.scopes[logicalID].instances[CI_A].episode;
  assert.equal(outageGrants(state, policy, 2400).length, 0);
  assert.equal(resolved.phase, 'resolved');
  assert.deepEqual(resolved.proofs, {});
  assert.deepEqual(bounds(resolved), bounds(before));

  // Hours later the same incident re-matches: no grant from the hours-old proof.
  state = step(state, makeSnapshot({ receivedAt: 200000 }));
  const rematched = state.scopes[logicalID].instances[CI_A].episode;
  assert.equal(rematched.resolved, false);
  assert.deepEqual(outageGrants(state, policy, 200000), []);
  assert.deepEqual(bounds(rematched), bounds(before));

  state = step(state, makeBaseline({ targetID: 'claude-opus-5', modelID: 'claude-opus-5', purpose: 'outage-health', requestID: 'fresh-proof',
    attemptID: 'fresh-proof-attempt', startedAt: 200001, finishedAt: 200100 }));
  const reconfirmed = state.scopes[logicalID].instances[CI_A].episode;
  assert.equal(outageGrants(state, policy, 200100)[0].mode, 'confirmed');
  assert.deepEqual(bounds(reconfirmed), bounds(before));
});

test('pending-auth replay never moves the stale fence backwards, so a stale success cannot close the episode', () => {
  let state = step(emptyOutages(), makeBaseline());
  state = step(state, makeFailure({ result: 'auth-fault', requestID: 'P1', attemptID: 'P1-attempt', startedAt: 2000, finishedAt: 2050 }));
  assert.equal(state.scopes[logicalID].instances[CI_A].pendingAuth.length, 1);
  state = step(state, makeFailure({ requestID: 'F2', attemptID: 'F2-attempt', startedAt: 2100, finishedAt: 3000 }));
  assert.deepEqual([state.scopes[logicalID].instances[CI_A].episode.firstFailureAt, state.scopes[logicalID].instances[CI_A].lastPrimaryFailureAt], [3000, 3000]);
  state = step(state, makeSnapshot({ receivedAt: 3100, authMatches: { 'claude-opus-5-5': ['auth-incident-1'] } }));

  const instance = state.scopes[logicalID].instances[CI_A];
  assert.equal(instance.lastPrimaryFailureAt, 3000);
  assert.ok(instance.episode.failures.every((failure) => failure.at >= instance.episode.firstFailureAt && failure.at <= instance.lastPrimaryFailureAt));
  const episodeID = instance.episode.id;

  const restored = decodeOutages(structuredClone(state), { policy, now: 3100 });
  assert.equal(restored.scopes[logicalID].instances[CI_A].episode?.id, episodeID, 'persisted episode survives a restart decode');

  state = step(state, makeBaseline({ requestID: 'stale-success', attemptID: 'stale-success-attempt', startedAt: 2500, finishedAt: 3200 }));
  assert.equal(state.scopes[logicalID].instances[CI_A].episode?.id, episodeID, 'a success that started before the last failure is stale');
});

test('a stale outcome for a known instance cannot rotate the current credential instance or clear proofs', () => {
  let state = step(emptyOutages(), makeBaseline({ credentialInstance: CI_B, requestID: 'B-base', attemptID: 'B-base-attempt', startedAt: 500, finishedAt: 600 }));
  state = step(state, makeFailure({ credentialInstance: CI_B, requestID: 'B-fail', attemptID: 'B-fail-attempt', startedAt: 700, finishedAt: 900 }));
  state = step(state, makeBaseline());
  state = step(state, makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, makeBaseline({ targetID: 'claude-opus-5', modelID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }));
  const scope = state.scopes[logicalID];
  assert.equal(scope.currentCredentialInstance, CI_A);
  const generation = scope.generation;
  const proofs = structuredClone(scope.instances[CI_A].episode.proofs);
  assert.ok(proofs['claude-opus-5']);

  // ci_B's fence is 900; this success started at 800, so it is stale for ci_B.
  state = reduceOutages(state, makeBaseline({ credentialInstance: CI_B, requestID: 'B-stale', attemptID: 'B-stale-attempt', startedAt: 800, finishedAt: 2400 }), { policy, now: 2400 });
  const after = state.scopes[logicalID];
  assert.equal(after.currentCredentialInstance, CI_A);
  assert.equal(after.generation, generation);
  assert.deepEqual(after.instances[CI_A].episode.proofs, proofs);
  assert.equal(outageGrants(state, policy, 2400).length, 1);
});

test('out-of-order real successes never regress baselineAt or lastSeenAt', () => {
  let state = step(emptyOutages(), makeBaseline({ startedAt: 3000, finishedAt: 3100 }));
  state = reduceOutages(state, makeBaseline({ requestID: 'late-report', attemptID: 'late-report-attempt', startedAt: 2000, finishedAt: 2500 }), { policy, now: 3200 });
  const instance = state.scopes[logicalID].instances[CI_A];
  assert.equal(instance.baselineAt, 3100);
  assert.equal(instance.lastSeenAt, 3100);
});

test('resolution after the deadline remains suppressed without a fresh confirmation', () => {
  let state = step(step(emptyOutages(), makeBaseline()), makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, makeBaseline({ targetID: 'claude-opus-5', modelID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }));
  state = step(state, { type: 'tick' }, 602101);
  state = step(state, makeSnapshot({ receivedAt: 602200, matches: {}, resolvedIncidentIDs: { 'claude-opus-5-5': ['incident-1'] } }));
  const episode = state.scopes[logicalID].instances[CI_A].episode;
  assert.equal(outageGrants(state, policy, 602200).length, 0);
  assert.equal(episode.phase, 'resolved');
  assert.equal(episode.suppressed, true);
});

test('a backward clock event is ignored while later forward events and grants still work', () => {
  let state = step(emptyOutages(), makeBaseline());
  const beforeRollback = structuredClone(state);
  state = step(state, { type: 'tick' }, 1000);
  assert.deepEqual(state, beforeRollback);

  state = step(state, makeFailure());
  state = step(state, makeSnapshot());
  state = step(state, makeBaseline({ targetID: 'claude-opus-5', modelID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }));
  assert.equal(outageGrants(state, policy, 2299).length, 0);
  assert.equal(outageGrants(state, policy, 2300).length, 1);
});
