import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutageHarness } from './helpers/outage-e2e.mjs';
import { rows } from './helpers/model-outages.mjs';
import { createHealthProtocol as proxyProtocol } from '../../projects/llm-auth-proxy/src/health-context.ts';
import { createHealthProtocol as gatewayProtocol, sha256 } from '../gateway/lib/proxy-health-context.js';

// Every case drives the real proxy, gateway, authority, worker, reducer and selector; a hang is a
// defect, so each case carries a hard ceiling well above the probe's own 10-second deadline.
const CASE = { timeout: 60000 };
const wireOf = target => target.speed === 'fast' ? target.modelID.replace(/-fast$/, '') : target.modelID;
const bounds = episode => [episode.id, episode.deadline, episode.probeCounts, episode.lastProbeAt, episode.suppressed];

test('offline only: proxy and gateway golden vectors are byte identical', CASE, () => {
  const options = { key: Buffer.alloc(32, 7), now: () => 1000 };
  const tuple = [1, Buffer.alloc(32, 1).toString('base64url'), 1000, 11000, 'request', 'attempt', 'real', 'openai', 'model', sha256('{}'), null];
  assert.deepEqual(proxyProtocol(options).signRequest(tuple), gatewayProtocol(options).signRequest(tuple));
});

for (const [primaryID, , speed, reserves] of rows) test(`offline only: ${primaryID} full outage reserve lifecycle`, CASE, async () => {
  const h = await createOutageHarness({ primaryID });
  try {
    const baseline = await h.real(); assert.equal(baseline.status, 200); assert.equal(baseline.stillHeld, true);
    const current = h.state().scopes[h.logicalID].currentCredentialInstance;
    assert.ok(h.state().scopes[h.logicalID].instances[current].baselineAt, `no baseline; health trace: ${JSON.stringify(h.stats.health.map(e => ({ path: e.path, terminal: e.terminal, origin: e.failureOrigin, error: e.error })))}`);
    if (speed === 'fast') { const request = h.stats.upstream.at(-1); assert.equal(request.model, primaryID.replace(/-fast$/, '')); assert.equal(request.body.speed, 'fast'); assert.match(request.headers['anthropic-beta'] ?? '', /fast-mode-2026-02-01/); }
    h.setFailure(true); for (let count = 0; count < 3; count++) await h.real({ sessionID: baseline.sessionID });
    const before = h.stats.upstream.length, reads = h.stats.ordinaryCredentialReads; await h.tick();
    assert.equal(h.stats.probeReservations.length, 1); assert.equal(h.stats.upstream.length - before, 1); assert.equal(h.stats.ordinaryCredentialReads, reads); assert.equal(h.stats.refreshes, 0);
    const grant = h.grant()[0]; assert.equal(grant.targetID, reserves[0]);
    const reservation = h.stats.probeReservations[0]; assert.equal(reservation.assignment.expectedCredentialInstance, grant.credentialInstance); assert.equal(reservation.durable.scopes[h.logicalID].instances[grant.credentialInstance].episode.probeCounts.reserve, 1);
    const heldReserve = await h.real(); assert.equal(heldReserve.status, 200); assert.equal(heldReserve.targetID, reserves[0]);
    assert.deepEqual([h.stats.upstream.at(-1).model, h.stats.upstream.at(-1).status], [wireOf(h.targets[reserves[0]]), 200], 'the held reserve lease actually dispatched to the reserve');
    const episode = h.state().scopes[h.logicalID].instances[grant.credentialInstance].episode;
    h.advance(600001); assert.equal(h.grant().length, 0); await h.tick();
    const expired = h.state().scopes[h.logicalID].instances[grant.credentialInstance].episode; assert.deepEqual([expired.id, expired.deadline, expired.suppressed], [episode.id, episode.deadline, true]);
    // After expiry the head is ordinarily routable again: the gateway's own lease tries it, it
    // fails, the lane is excluded, and the ordinary fallback serves. Never an older sibling.
    // (For the fast row the gateway forwards its gateway-owned lease's alias id, which no upstream
    // knows, so that head attempt fails 404 rather than 503; the fallback leg is the same.)
    const ordinaryStart = h.stats.upstream.length; const ordinary = await h.real({ external: false }); assert.equal(ordinary.status, 200);
    const attempts = h.stats.upstream.slice(ordinaryStart);
    assert.deepEqual(attempts.map(call => [call.providerID, call.status >= 400]), [[h.targets[primaryID].providerID, true], ['fallback', false]], 'head attempt failed, then the ordinary fallback served');
    assert.equal(attempts.some(call => reserves.includes(call.model) || reserves.map(id => wireOf(h.targets[id])).includes(call.model)), false, 'no expired reserve sibling was dispatched');
    h.setFailure(false); await h.real({ forceTarget: primaryID }); assert.equal(h.state().scopes[h.logicalID].instances[grant.credentialInstance].episode, null);
    assert.equal(h.stats.syntheticFailureCalls, 0);
    // The plugin owns every session-bound lease: the gateway never settles one through the ordinary boundary.
    const externalIDs = new Set(h.stats.broker.filter(call => call.path === '/lease/verify').map(call => call.sessionID));
    assert.equal(h.stats.broker.some(call => externalIDs.has(call.sessionID) && ['/complete', '/failure', '/forget'].includes(call.path)), false);
  } finally { await h.close(); }
});

for (const [primaryID] of rows) {
  test(`offline only: ${primaryID} official confirmation and resolution retain episode bounds`, CASE, async () => {
    const h = await createOutageHarness({ primaryID });
    try {
      const baseline = await h.real(); h.setFailure(true); for (let count = 0; count < 3; count++) await h.real({ sessionID: baseline.sessionID }); await h.tick(); await h.real();
      const grant = h.grant()[0], before = h.state().scopes[h.logicalID].instances[grant.credentialInstance].episode;
      h.advance(600001); h.setFeed('positive'); await h.tick(); const after = h.state().scopes[h.logicalID].instances[grant.credentialInstance].episode;
      assert.deepEqual([after.id, after.deadline, after.suppressed], [before.id, before.deadline, true]); assert.equal(h.grant()[0].mode, 'confirmed');
      h.advance(120001); assert.equal(h.grant().length, 0); const baselineAt = h.state().scopes[h.logicalID].instances[grant.credentialInstance].baselineAt;
      h.setFeed('resolved'); await h.tick(); assert.equal(h.grant().length, 0);
      const instance = h.state().scopes[h.logicalID].instances[grant.credentialInstance];
      assert.deepEqual([instance.episode.id, instance.episode.deadline, instance.episode.resolved, instance.episode.phase, instance.baselineAt], [before.id, before.deadline, true, 'resolved', baselineAt], 'official resolution lands on the same episode and establishes no baseline');
    } finally { await h.close(); }
  });
  // Design section 11: "Token rotation invalidates this scope, not episode budgets or clocks ...
  // A different scope returns a non-service failure with zero upstream dispatch; automatic normal
  // rerouting applies, not manual intervention." The signed proxy-scope refusal attests the actual
  // (new) credential instance with no upstream status, so after it the old-scope grant is gone,
  // the head is routable again, and the next AUTOMATIC request establishes the new scope's
  // baseline while the old instance keeps its episode id, deadline, counts, cooldown and latch.
  test(`offline only: ${primaryID} credential rotation rejects old reserve scope without dispatch`, CASE, async () => {
    const h = await createOutageHarness({ primaryID, feed: 'positive' });
    try {
      await h.real(); h.setFailure(true); await h.real(); await h.tick(); const grant = h.grant()[0], before = h.state().scopes[h.logicalID].instances[grant.credentialInstance].episode;
      const reserveWire = wireOf(h.targets[grant.targetID]);
      h.rotate('B'); const start = h.stats.upstream.length, reports = h.stats.health.length, calls = h.stats.broker.length;
      const result = await h.real();
      // The head is still failing here, so a reroute that lands on it legitimately ends 502; a
      // reroute that lands on the ordinary fallback ends 200. The refusal itself must never surface.
      assert.ok([200, 502].includes(result.status), `the gateway reroutes a signed scope refusal itself; client saw ${result.status}`);
      const refusal = h.stats.health.slice(reports).find(entry => entry.path === '/model-health/outcome' && entry.failureOrigin === 'proxy-scope' && entry.error === null);
      assert.ok(refusal, 'the signed proxy-scope refusal was delivered to the broker');
      assert.deepEqual({ status: refusal.terminal.status, upstreamStatus: refusal.upstreamStatus, attestsNewInstance: typeof refusal.actualCredentialInstance === 'string' && refusal.actualCredentialInstance !== grant.credentialInstance },
        { status: 409, upstreamStatus: null, attestsNewInstance: true }, 'refusal attests the actual new credential instance and zero upstream dispatch');
      // The gateway re-leases under its own gw- session (never the plugin's), excluding the refused
      // reserve; the selector must then see no old-scope grant and must not pick a reserve again.
      const afterRefusal = h.stats.broker.slice(calls);
      const reroutes = afterRefusal.filter(call => call.path === '/lease' && call.sessionID !== result.sessionID);
      assert.deepEqual({
        reserveDispatches: h.stats.upstream.slice(start).filter(call => call.model === reserveWire).length,
        reserveIndicted: afterRefusal.some(call => call.path === '/failure' && call.sessionID === result.sessionID),
        rerouted: reroutes.length >= 1 && reroutes.every(call => (call.excludeTargetIDs ?? []).includes(grant.targetID)),
        rerouteSawOldScopeGrant: reroutes.some(call => call.grantsVisible.some(g => g.credentialInstance === grant.credentialInstance)),
        rerouteSource: reroutes.map(call => call.selected?.source ?? null),
        oldScopeGrants: h.grant().length,
      }, { reserveDispatches: 0, reserveIndicted: false, rerouted: true, rerouteSawOldScopeGrant: false, rerouteSource: reroutes.map(() => 'primary'), oldScopeGrants: 0 },
      'a scope refusal is not a service failure: zero reserve dispatch, no /failure against the reserve lease, automatic re-lease excluding the reserve, and the old-scope grant retired before that re-lease');
      assert.deepEqual(bounds(h.state().scopes[h.logicalID].instances[grant.credentialInstance].episode), bounds(before), 'rotation keeps the old instance episode bounds');
      h.setFailure(false); const automatic = await h.real();
      assert.deepEqual({ targetID: automatic.targetID, status: automatic.status, wire: h.stats.upstream.at(-1).model }, { targetID: primaryID, status: 200, wire: wireOf(h.targets[primaryID]) }, 'the next automatic request reaches the head under the new scope');
      const scope = h.state().scopes[h.logicalID]; assert.notEqual(scope.currentCredentialInstance, grant.credentialInstance);
      assert.deepEqual([Boolean(scope.instances[scope.currentCredentialInstance].baselineAt), scope.instances[scope.currentCredentialInstance].recoveryRequired], [true, false], 'new scope baseline established by a real primary success');
      assert.deepEqual(bounds(scope.instances[grant.credentialInstance].episode), bounds(before), 'the new scope baseline does not touch the old instance episode');
    } finally { await h.close(); }
  });
}

test('offline only: OpenAI API-key notice is not a Codex OAuth incident', CASE, async () => {
  const h = await createOutageHarness({ primaryID: 'gpt-6-1-sol', feed: 'api-key' }); try { await h.real(); h.setFailure(true); await h.real(); await h.tick(); assert.equal(h.stats.probeReservations.length, 0); assert.equal(h.grant().length, 0); } finally { await h.close(); }
});
test('offline only: synthetic outcomes never call ordinary failure boundary while real failures do', CASE, async () => {
  const h = await createOutageHarness({ primaryID: 'claude-opus-5-5', feed: 'positive' }); try { await h.real(); h.setFailure(true); await h.real({ external: false }); const real = h.stats.realFailureCalls; assert.ok(real > 0); await h.tick(); assert.equal(h.stats.realFailureCalls, real); assert.equal(h.stats.syntheticFailureCalls, 0); } finally { await h.close(); }
});
for (const primaryID of ['claude-opus-5-5', 'gpt-6-1-sol']) {
  test(`offline only: ${primaryID} partial terminal and local proxy error establish no baseline`, CASE, async () => {
    const h = await createOutageHarness({ primaryID, feed: 'positive' }); try { h.setMode('partial'); await h.real(); const scope = h.state().scopes[h.logicalID]; assert.equal(scope ? Object.values(scope.instances).some(instance => instance.baselineAt !== null) : false, false); h.setMode('no-credentials'); const before = h.stats.upstream.length; await h.real(); assert.equal(h.stats.upstream.length, before); assert.equal(h.grant().length, 0); assert.equal(h.stats.probeReservations.length, 0); } finally { await h.close(); }
  });
  test(`offline only: ${primaryID} reserve upstream failure invalidates proof without synthetic failure`, CASE, async () => {
    const h = await createOutageHarness({ primaryID, feed: 'positive' }); try { await h.real(); h.setFailure(true); await h.real(); await h.tick(); assert.equal(h.grant().length, 1); h.setMode('reserve-failure'); await h.real(); assert.equal(h.grant().length, 0); assert.equal(h.stats.syntheticFailureCalls, 0); } finally { await h.close(); }
  });
}
// A complete 200 whose own usage.speed says "standard" is what a model that silently ignores fast
// mode returns. The probe completes and its outcome is delivered; the fast scope still has no proof.
test('offline only: fast response with standard terminal speed does not prove a fast reserve', CASE, async () => {
  const h = await createOutageHarness({ primaryID: 'claude-opus-5-5-fast', feed: 'positive' });
  try {
    await h.real(); h.setFailure(true); await h.real(); h.setMode('standard-speed'); const reports = h.stats.health.length; await h.tick();
    const probe = h.stats.health.slice(reports).find(entry => entry.path === '/model-health/outcome');
    assert.deepEqual({ probes: h.stats.probeReservations.length, delivered: probe ? probe.error : 'missing', state: probe?.terminal?.state, status: probe?.terminal?.status, speed: probe?.terminal?.speed, grants: h.grant().length },
      { probes: 1, delivered: null, state: 'complete', status: 200, speed: 'standard', grants: 0 }, 'a complete standard-speed probe outcome is delivered and proves nothing for a fast scope');
  } finally { await h.close(); }
});
