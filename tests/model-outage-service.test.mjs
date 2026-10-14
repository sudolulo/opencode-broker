import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createOutageAssignments, createOutageService } from '../lib/model-outage-service.js';
import { createHealthAuthority } from '../lib/model-health.js';
import { emptyOutages, reduceOutages, reserveProbe } from '../lib/model-outages.js';
import { CI_A, makePolicy, makeTargets, makeBaseline, makeFailure, makeSnapshot } from './helpers/model-outages.mjs';

// Service composition (plan Task 9, createOutageService). Everything here runs the REAL health
// authority, the REAL outage worker and the REAL isolated assignments against an in-memory
// durable image, a fake clock, fake timers and a counting shared serializer. The proxy
// attestation is a genuine HMAC over canonical base64url tuples with a FAKE fixture key, so an
// unsigned or tampered report is refused by the verifier rather than acknowledged by a mock.
// No status feed, provider or credential is contacted; every value below is a fixture.
const policy = makePolicy();
const targets = makeTargets();
const logicalID = 'anthropic/opus/standard';
const route = policy.expectedScopePolicies[logicalID];
const CI = CI_A;
const GATEWAY = 'fake-gateway-credential-for-tests';
const PROXY_KEY = Buffer.alloc(32, 9);
const BODY = 'b'.repeat(64);

const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const sign = (domain, encoded) => createHmac('sha256', PROXY_KEY).update(`fleet-health/${domain}/v1\0`).update(encoded).digest('base64url');

function verifyAttestation(report) {
  for (const [field, signatureField, domain] of [['context', 'contextSignature', 'request'], ['attestation', 'attestationSignature', 'response']]) {
    const value = report[field];
    const given = report[signatureField];
    if (typeof value !== 'string' || typeof given !== 'string') throw new Error('attestation signature');
    const expected = Buffer.from(sign(domain, value));
    const actual = Buffer.from(given);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('attestation signature');
  }
  return {
    request: JSON.parse(Buffer.from(report.context, 'base64url').toString('utf8')),
    attestation: JSON.parse(Buffer.from(report.attestation, 'base64url').toString('utf8')),
  };
}

function ready() {
  let state = emptyOutages();
  for (const event of [makeBaseline({ credentialInstance: CI }), makeFailure({ credentialInstance: CI }), makeSnapshot()]) {
    state = reduceOutages(state, event, { policy, now: event.finishedAt ?? event.receivedAt });
  }
  return state;
}

const ordinaryLease = (overrides = {}) => ({ held: true, sessionID: 'sess-1', leaseID: 'lease-1', targetID: 'claude-opus-5-5',
  providerID: 'anthropic', modelID: 'claude-opus-5-5', wireModelID: 'claude-opus-5-5', primaryID: 'claude-opus-5-5', logicalID,
  purpose: 'real', expectedScopePolicy: route, expectedCredentialInstance: null, ...overrides });

function fixture({ state = ready(), clock = 3000, pollsAllowed = false, enabled = true } = {}) {
  const f = { clock, commits: [], applied: 0, polls: [], ordinary: [], ordinaryLookups: [], errors: [], serialized: 0,
    timers: new Map(), nextTimer: 0, gate: null, failCommit: null, fetch: null, lease: ordinaryLease(),
    // Default probe transport: sends nothing and reports no outcome (snapshots can dispatch probes).
    sendProbe: async () => {} };
  // A recent poll in the durable image keeps worker ticks from polling unless a test wants it.
  if (!pollsAllowed) for (const providerID of ['anthropic', 'openai']) state = reduceOutages(state, { type: 'poll-start', providerID }, { policy, now: clock });
  f.state = state;
  f.timerAPI = {
    setTimeout(fn, ms) { const id = ++f.nextTimer; f.timers.set(id, { fn, ms, interval: false }); return id; },
    clearTimeout(id) { f.timers.delete(id); },
    setInterval(fn, ms) { const id = ++f.nextTimer; f.timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval(id) { f.timers.delete(id); },
  };
  let tail = Promise.resolve();
  f.opts = {
    policy: enabled ? policy : { ...policy, enabled: false }, targets, now: () => f.clock, randomBytes,
    read: () => f.state,
    commit: async (next) => {
      if (f.gate) await f.gate;
      f.commits.push(structuredClone(next));
      if (f.failCommit?.(next)) throw new Error('disk full');
      f.state = structuredClone(next);
      f.applied++;
    },
    fetchStatus: (providerID, { signal }) => {
      f.polls.push(providerID);
      // A test fetch may stay pending; like a real fetch it settles when the worker aborts it.
      if (f.fetch) return Promise.race([f.fetch(providerID, { signal }), new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })]);
      return Promise.resolve(makeSnapshot({ providerID, receivedAt: f.clock,
        matches: providerID === 'anthropic' ? { 'claude-opus-5-5': ['incident-1'] } : {} }));
    },
    sendProbe: (assignment, context) => f.sendProbe(assignment, context),
    canProbe: () => true,
    timers: f.timerAPI,
    // The production shared queue stand-in: strictly ordered, counted.
    serialize: (transaction) => { f.serialized++; const result = tail.then(transaction); tail = result.catch(() => {}); return result; },
    onError: (error) => { f.errors.push(error); },
    gatewayCredential: GATEWAY,
    lookupOrdinaryLease: (input) => {
      f.ordinaryLookups.push(structuredClone(input));
      return input.sessionID === f.lease.sessionID ? structuredClone(f.lease) : null;
    },
    ordinaryRequest: async (path, body) => { f.ordinary.push({ path, body: structuredClone(body) }); return { ok: true, path }; },
    verifyAttestation,
  };
  f.flush = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return f;
}

const beginBody = (lease, overrides = {}) => ({ gatewayCredential: GATEWAY, sessionID: lease.sessionID, leaseID: lease.leaseID,
  requestID: 'req-1', attemptID: 'att-1', purpose: lease.purpose, modelID: lease.wireModelID, bodySHA256: BODY, ...overrides });

function signedReport(ticket, begin, lease, { finishedAt, status = 200, origin = status >= 200 && status < 300 ? 'upstream-response' : 'upstream-http', credentialInstance = CI } = {}) {
  const context = encode([1, ticket.nonce, ticket.startedAt, ticket.startedAt + 10000, begin.requestID, begin.attemptID, begin.purpose,
    lease.providerID, lease.wireModelID, begin.bodySHA256, lease.expectedCredentialInstance ?? null]);
  const attestation = encode([1, ticket.nonce, begin.requestID, begin.attemptID, lease.wireModelID, credentialInstance, route.connectionID,
    'https://api.anthropic.com', route.authMode, route.transport, route.product, origin, status, 'context-hash']);
  const terminal = status >= 200 && status < 300 ? { api: 'messages', state: 'complete', status, errorClass: null }
    : { api: 'messages', state: 'http-error', status, errorClass: status === 401 || status === 403 ? 'auth' : 'service' };
  return { gatewayCredential: GATEWAY, capability: ticket.capability, context, contextSignature: sign('request', context),
    attestation, attestationSignature: sign('response', attestation), terminal, finishedAt };
}

// Runs the ordinary (purpose 'real') begin -> outcome round trip through the service.
async function realRound(f, service, { requestID = 'req-1', attemptID = 'att-1', status = 200, elapsed = 50 } = {}) {
  const begin = beginBody(f.lease, { requestID, attemptID });
  const ticket = await service.request('/model-health/begin', begin);
  f.clock += elapsed;
  return { ticket, begin, report: signedReport(ticket, begin, f.lease, { finishedAt: f.clock, status }) };
}

const durableText = (f) => JSON.stringify([f.state, ...f.commits]);

test('construction composes once, starts nothing, and refuses missing collaborators without echoing secrets', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  try {
    for (const name of ['request', 'close']) assert.equal(typeof service[name], 'function', name);
    for (const name of ['start', 'tick', 'observe', 'requestPoll', 'drain', 'close']) assert.equal(typeof service.worker[name], 'function', name);
    for (const name of ['issue', 'consume', 'lookupLease', 'release', 'close']) assert.equal(typeof service.assignments[name], 'function', name);
    await f.flush();
    assert.equal(f.timers.size, 0, 'no worker interval: the daemon starts it explicitly');
    assert.equal(f.commits.length, 0);
    assert.equal(f.serialized, 0);
    assert.deepEqual(f.polls, []);
  } finally { await service.close(); }
  for (const name of ['read', 'commit', 'fetchStatus', 'sendProbe', 'canProbe', 'serialize', 'lookupOrdinaryLease', 'ordinaryRequest', 'verifyAttestation']) {
    const g = fixture();
    const { [name]: _removed, ...rest } = g.opts;
    assert.throws(() => createOutageService(rest), (error) => error.message === `outage service option ${name}` && !error.message.includes(GATEWAY), name);
  }
  for (const bad of [undefined, '', 7]) {
    const g = fixture();
    assert.throws(() => createOutageService({ ...g.opts, gatewayCredential: bad }), /^Error: outage service option gatewayCredential$/);
  }
});

test('a verified real baseline success is durably committed and acknowledged without requesting a poll', async () => {
  const f = fixture({ state: emptyOutages(), pollsAllowed: true });
  const service = createOutageService(f.opts);
  try {
    const { ticket, report } = await realRound(f, service);
    assert.equal(ticket.generation, 0);
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: false });
    const instance = f.state.scopes[logicalID].instances[CI];
    assert.equal(instance.baselineAt, f.clock);
    assert.equal(instance.recoveryRequired, false);
    assert.equal(f.applied, 1);
    await service.worker.drain();
    assert.deepEqual(f.polls, [], 'a success never requests a status poll');
    // The ordinary lease lookup never sees the private gateway credential.
    assert.equal(f.ordinaryLookups.length, 1);
    assert.equal(Object.hasOwn(f.ordinaryLookups[0], 'gatewayCredential'), false);
    assert.equal(f.ordinary.length, 0);
    assert.ok(!durableText(f).includes(ticket.capability) && !durableText(f).includes(GATEWAY), 'no capability or credential in durable state');
  } finally { await service.close(); }
});

test('observe mode accepts a signed real head outcome but refuses outage probes and polls', async () => {
  // This catches an observation policy accidentally retaining synthetic probe authority.
  const f = fixture({ state: emptyOutages(), pollsAllowed: true });
  f.opts.policy = { ...policy, mode: 'observe' };
  const service = createOutageService(f.opts);
  try {
    const { report } = await realRound(f, service);
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: false });
    assert.equal(f.state.scopes[logicalID].instances[CI].baselineAt, f.clock);
    assert.deepEqual(f.polls, []);
    await assert.rejects(service.request('/probe/consume', { purpose: 'outage-health' }), /active mode/);
  } finally { await service.close(); }
});

test('a qualifying real primary fault returns before its nonblocking poll of only that provider finishes', async () => {
  const f = fixture({ pollsAllowed: true });
  let finishFetch;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  f.fetch = (providerID) => { fetchStarted(providerID); return new Promise((resolve) => { finishFetch = () => resolve(makeSnapshot({ providerID, receivedAt: f.clock })); }); };
  const service = createOutageService(f.opts);
  try {
    const { report } = await realRound(f, service, { status: 503 });
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: false });
    assert.equal(f.state.scopes[logicalID].instances[CI].lastPrimaryFailureAt, f.clock, 'fault committed');
    assert.equal(await started, 'anthropic');
    assert.deepEqual(f.polls, ['anthropic'], 'only the faulting provider is polled');
    finishFetch();
    await service.worker.drain();
    assert.deepEqual(f.polls, ['anthropic']);
  } finally { await service.close(); }
  // A reserve-target fault never opens an episode, so it requests no poll.
  const g = fixture({ pollsAllowed: true });
  g.lease = ordinaryLease({ targetID: 'claude-opus-5', modelID: 'claude-opus-5', wireModelID: 'claude-opus-5', expectedCredentialInstance: CI });
  const other = createOutageService(g.opts);
  try {
    const { report } = await realRound(g, other, { status: 503 });
    assert.deepEqual(await other.request('/model-health/outcome', report), { ok: true, duplicate: false });
    await other.worker.drain();
    assert.deepEqual(g.polls, []);
  } finally { await other.close(); }
});

test('unauthenticated or unverified outcomes mutate nothing and do not burn the capability', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  try {
    const { report } = await realRound(f, service, { status: 503 });
    const before = structuredClone(f.state);
    await assert.rejects(service.request('/model-health/outcome', { ...report, gatewayCredential: 'wrong' }), /private authentication/);
    await assert.rejects(service.request('/model-health/outcome', { ...report, attestationSignature: sign('response', encode(['forged'])) }), /attestation signature/);
    await assert.rejects(service.request('/model-health/outcome', { ...report, contextSignature: sign('response', report.context) }), /attestation signature/);
    await assert.rejects(service.request('/model-health/begin', { ...beginBody(f.lease), gatewayCredential: 'wrong' }), /private authentication/);
    await assert.rejects(service.request('/model-health/outcome', null), /model health request/);
    assert.deepEqual(f.state, before);
    assert.equal(f.commits.length, 0);
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: false });
    assert.equal(f.applied, 1);
  } finally { await service.close(); }
});

test('a failed commit acknowledges nothing; the identical retry applies once; applied replays never reapply', async () => {
  const f = fixture({ pollsAllowed: true });
  f.fetch = () => new Promise(() => {});
  const service = createOutageService(f.opts);
  try {
    const { report } = await realRound(f, service, { status: 503 });
    f.failCommit = () => true;
    await assert.rejects(service.request('/model-health/outcome', report), /disk full/);
    assert.equal(f.applied, 0);
    await f.flush();
    assert.deepEqual(f.polls, [], 'no poll for an outcome that never committed');
    f.failCommit = null;
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: false });
    assert.equal(f.state.scopes[logicalID].instances[CI].lastPrimaryFailureAt, report.finishedAt);
    await f.flush();
    assert.equal(f.applied, 2, 'the outcome plus exactly one poll-start marker');
    assert.deepEqual(f.polls, ['anthropic']);
    const commits = f.commits.length;
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: true });
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: true });
    assert.equal(f.commits.length, commits, 'applied replay commits nothing');
    await assert.rejects(service.request('/model-health/outcome', { ...report, finishedAt: report.finishedAt - 1 }), /changed replay/);
    await f.flush();
    assert.deepEqual(f.polls, ['anthropic'], 'replays request no further poll');
  } finally { await service.close(); }
});

test('concurrent identical outcomes share one pending commit; a changed replay is rejected while it is pending', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  try {
    const { report } = await realRound(f, service, { status: 503 });
    let open;
    f.gate = new Promise((resolve) => { open = resolve; });
    const first = service.request('/model-health/outcome', report);
    const second = service.request('/model-health/outcome', structuredClone(report));
    await assert.rejects(service.request('/model-health/outcome', { ...report, finishedAt: report.finishedAt - 1 }), /changed replay/);
    await f.flush();
    assert.equal(f.commits.length, 0, 'still gated');
    open();
    f.gate = null;
    assert.deepEqual(await Promise.all([first, second]), [{ ok: true, duplicate: false }, { ok: true, duplicate: true }]);
    assert.equal(f.applied, 1, 'single observe');
    // A concurrent replay of a commit that fails fails with it, and the retry still applies.
    const next = await realRound(f, service, { requestID: 'req-2', attemptID: 'att-2', status: 503 });
    f.gate = new Promise((resolve) => { open = resolve; });
    f.failCommit = () => true;
    const a = service.request('/model-health/outcome', next.report);
    const b = service.request('/model-health/outcome', next.report);
    open();
    f.gate = null;
    await assert.rejects(a, /disk full/);
    await assert.rejects(b, /disk full/);
    f.failCommit = null;
    assert.deepEqual(await service.request('/model-health/outcome', next.report), { ok: true, duplicate: false });
    assert.equal(f.applied, 2);
  } finally { await service.close(); }
});

test('an outcome issued before a generation change is refused and commits nothing', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  try {
    const stale = await realRound(f, service, { requestID: 'stale', attemptID: 'stale-1', status: 503 });
    const fresh = await realRound(f, service, { requestID: 'fresh', attemptID: 'fresh-1', status: 200 });
    const generation = f.state.scopes[logicalID].generation;
    assert.deepEqual(await service.request('/model-health/outcome', fresh.report), { ok: true, duplicate: false });
    assert.equal(f.state.scopes[logicalID].generation, generation + 1, 'real primary success advances generation');
    const commits = f.commits.length;
    await assert.rejects(service.request('/model-health/outcome', stale.report), /generation\/time/);
    assert.equal(f.commits.length, commits);
  } finally { await service.close(); }
  // An outcome that started before the latest recorded primary failure is ordered out.
  const g = fixture();
  const other = createOutageService(g.opts);
  try {
    const early = await realRound(g, other, { requestID: 'early', attemptID: 'early-1', status: 200 });
    const fault = await realRound(g, other, { requestID: 'fault', attemptID: 'fault-1', status: 503 });
    assert.deepEqual(await other.request('/model-health/outcome', fault.report), { ok: true, duplicate: false });
    const commits = g.commits.length;
    await assert.rejects(other.request('/model-health/outcome', early.report), /outcome ordering/);
    assert.equal(g.commits.length, commits);
  } finally { await other.close(); }
});

test('an accepted outcome made stale by an earlier queued commit is refused at commit time', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  try {
    // Both tickets are issued, and both outcomes accepted, at the same generation.
    const success = await realRound(f, service, { requestID: 'ok', attemptID: 'ok-1', status: 200 });
    const fault = await realRound(f, service, { requestID: 'late', attemptID: 'late-1', status: 503 });
    const generation = f.state.scopes[logicalID].generation;
    let open;
    f.gate = new Promise((resolve) => { open = resolve; });
    const first = service.request('/model-health/outcome', success.report);
    const second = service.request('/model-health/outcome', fault.report);
    await f.flush();
    open();
    f.gate = null;
    assert.deepEqual(await first, { ok: true, duplicate: false });
    await assert.rejects(second, (error) => error.message === 'stale health outcome');
    const instance = f.state.scopes[logicalID].instances[CI];
    assert.equal(f.state.scopes[logicalID].generation, generation + 1);
    assert.equal(instance.episode, null, 'the stale fault reopened nothing');
    assert.equal(f.applied, 1);
    // Not marked applied: an identical retry is re-validated at commit (and still refused), never acked as a duplicate.
    await assert.rejects(service.request('/model-health/outcome', fault.report), (error) => error.message === 'stale health outcome');
    assert.equal(f.applied, 1);
  } finally { await service.close(); }
  // A queued transaction that only moves the failure watermark also invalidates an accepted outcome.
  const g = fixture();
  const other = createOutageService(g.opts);
  try {
    const early = await realRound(g, other, { requestID: 'early', attemptID: 'early-1', status: 200 });
    const before = structuredClone(g.state);
    let open;
    g.gate = new Promise((resolve) => { open = resolve; });
    const later = makeFailure({ credentialInstance: CI, requestID: 'q', attemptID: 'q-1', startedAt: g.clock, finishedAt: g.clock,
      generation: before.scopes[logicalID].generation });
    const queued = other.worker.observe(later);
    const stale = other.request('/model-health/outcome', early.report);
    await g.flush();
    open();
    g.gate = null;
    await queued;
    await assert.rejects(stale, (error) => error.message === 'stale health outcome');
    assert.equal(g.applied, 1);
  } finally { await other.close(); }
});

test('the outage purpose never falls back to ordinary leases, and real begins never see isolated ones', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  try {
    // The ordinary lookup knows sess-1, but an outage-health begin must not consult it.
    await assert.rejects(service.request('/model-health/begin', beginBody(f.lease, { purpose: 'outage-health' })), /assignment/);
    await assert.rejects(service.request('/model-health/begin', beginBody(f.lease, { purpose: 'canary' })), /assignment/);
    assert.equal(f.ordinaryLookups.length, 0);
    // A real begin for an unknown session asks only the ordinary namespace and is refused.
    await assert.rejects(service.request('/model-health/begin', beginBody(f.lease, { sessionID: `gw-probe-${'A'.repeat(43)}` })), /assignment/);
    assert.equal(f.ordinaryLookups.length, 1);
    // Outage consume/release never reach the ordinary handler.
    await assert.rejects(service.request('/probe/consume', { sessionID: 'sess-1', probeNonce: 'pbn_x', purpose: 'outage-health' }), /probe nonce binding/);
    assert.deepEqual(await service.request('/probe/release', { sessionID: 'sess-1', probeNonce: 'pbn_x', leaseID: 'lease-1', purpose: 'outage-health' }), { ok: true });
    assert.equal(f.ordinary.length, 0);
  } finally { await service.close(); }
});

test('ordinary paths are delegated with the private credential stripped; /failure then polls both providers nonblockingly', async () => {
  const f = fixture({ pollsAllowed: true });
  const pending = [];
  f.fetch = (providerID) => new Promise((resolve) => { pending.push(() => resolve(makeSnapshot({ providerID, receivedAt: f.clock, matches: {} }))); });
  const service = createOutageService(f.opts);
  try {
    const complete = { sessionID: 's', leaseID: 'l', gatewayCredential: GATEWAY, usage: { tokens: 3 } };
    assert.deepEqual(await service.request('/complete', complete), { ok: true, path: '/complete' });
    await f.flush();
    assert.deepEqual(f.polls, [], '/complete requests no poll');
    assert.deepEqual(f.ordinary, [{ path: '/complete', body: { sessionID: 's', leaseID: 'l', usage: { tokens: 3 } } }]);
    assert.equal(complete.gatewayCredential, GATEWAY, 'caller body is not mutated');
    assert.deepEqual(await service.request('/failure', { sessionID: 's', kind: 'service', gatewayCredential: GATEWAY }), { ok: true, path: '/failure' });
    assert.deepEqual(f.ordinary[1], { path: '/failure', body: { sessionID: 's', kind: 'service' } });
    await f.flush();
    assert.deepEqual(f.polls.sort(), ['anthropic', 'openai'], 'returned while both fetches are pending');
    assert.equal(f.commits.length, 2, 'only the two poll-start markers; no fabricated outcome');
    assert.deepEqual(await service.request('/lease', { purpose: 'outage-health', gatewayCredential: GATEWAY }), { ok: true, path: '/lease' });
    assert.deepEqual(f.ordinary[2], { path: '/lease', body: { purpose: 'outage-health' } });
    assert.deepEqual(await service.request('/status', null), { ok: true, path: '/status' });
    for (const resolve of pending) resolve();
    await service.worker.drain();
    assert.ok(!JSON.stringify(f.ordinary).includes(GATEWAY));
  } finally { await service.close(); }
});

test('a rejected ordinary /failure requests no poll', async () => {
  const f = fixture({ pollsAllowed: true });
  const service = createOutageService({ ...f.opts, ordinaryRequest: async () => { throw new Error('ordinary refused'); } });
  try {
    await assert.rejects(service.request('/failure', { sessionID: 's' }), /ordinary refused/);
    await f.flush();
    assert.deepEqual(f.polls, []);
  } finally { await service.close(); }
});

test('close is idempotent and denies model-health and outage probe paths afterwards', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  const { report } = await realRound(f, service, { status: 503 });
  const first = service.close();
  const second = service.close();
  assert.equal(first, second);
  await first;
  await service.close();
  await assert.rejects(service.request('/model-health/begin', beginBody(f.lease)), /outage service closed/);
  await assert.rejects(service.request('/model-health/outcome', report), /outage service closed/);
  await assert.rejects(service.request('/probe/consume', { sessionID: 'x', probeNonce: 'y', purpose: 'outage-health' }), /outage service closed/);
  assert.equal(f.commits.length, 0);
});

test('the authority ticket cap holds through the service while 4096 verified outcomes are pending commit', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  try {
    let open;
    f.gate = new Promise((resolve) => { open = resolve; });
    const acks = [];
    for (let i = 0; i < 4096; i++) {
      const begin = beginBody(f.lease, { requestID: `r${i}`, attemptID: `a${i}` });
      const ticket = await service.request('/model-health/begin', begin);
      // A proxy-side scope refusal: verified, durable, generation-neutral evidence.
      acks.push(service.request('/model-health/outcome', signedReport(ticket, begin, f.lease, { finishedAt: f.clock, status: 200, origin: 'proxy-scope' })));
    }
    await assert.rejects(service.request('/model-health/begin', beginBody(f.lease, { requestID: 'over', attemptID: 'over' })), /capability capacity/);
    open();
    f.gate = null;
    const results = await Promise.all(acks);
    assert.ok(results.every((result) => result.ok && result.duplicate === false));
    assert.equal(f.applied, 4096);
  } finally { await service.close(); }
});

// ---- Outage probes: worker dispatch -> isolated assignment -> outcome waiter ----

const consumeBody = (a) => ({ sessionID: a.sessionID, probeNonce: a.probeNonce, purpose: 'outage-health' });
const releaseBody = (a) => ({ sessionID: a.sessionID, probeNonce: a.probeNonce, leaseID: a.leaseID, purpose: 'outage-health' });

// What the gateway does for one probe after registering its waiter: consume, begin, report.
async function probeRound(f, service, a, { elapsed = 50, status = 200, ...signing } = {}) {
  const consumed = await service.request('/probe/consume', consumeBody(a));
  const begin = { gatewayCredential: GATEWAY, sessionID: consumed.sessionID, leaseID: consumed.leaseID, requestID: 'probe-r',
    attemptID: 'probe-a', purpose: 'outage-health', modelID: consumed.wireModelID, bodySHA256: BODY };
  const ticket = await service.request('/model-health/begin', begin);
  f.clock += elapsed;
  return { consumed, begin, ticket, report: signedReport(ticket, begin, consumed, { finishedAt: f.clock, status, ...signing }) };
}

// Resolves with the promise's value if it is already settled, else with a 'still pending'
// marker: a waiter that leaked fails the assertion instead of hanging the run.
const settledNow = async (promise) => {
  await new Promise((resolve) => setImmediate(resolve));
  return Promise.race([promise, Promise.resolve('still pending')]);
};

async function dispatchOne(f, service) {
  await service.worker.tick();
  await service.worker.drain();
}

test('a probe waiter registered before consume resolves only after the verified outcome is durable and applied', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  const trace = [];
  let assignment;
  let capability;
  f.sendProbe = async (a, { signal, waitForOutcome }) => {
    assignment = a;
    assert.ok(signal instanceof AbortSignal);
    assert.equal(a.purpose, 'outage-health');
    const wait = waitForOutcome(a.leaseID, { signal });
    const waiterTimer = f.nextTimer;
    assert.equal(f.timers.get(waiterTimer).ms, 10000, 'TTL never exceeds the reservation window');
    trace.push('registered');
    const { consumed, ticket, report } = await probeRound(f, service, a);
    capability = ticket.capability;
    trace.push('consumed');
    assert.equal(consumed.leaseID, a.leaseID);
    assert.equal(consumed.expectedCredentialInstance, CI);
    await assert.rejects(service.request('/probe/consume', consumeBody(a)), /probe nonce binding/, 'one use');
    let resolved = false;
    wait.then(() => { resolved = true; });
    // An unrelated ordinary outcome (generation-neutral proxy refusal) never resolves the probe waiter.
    const real = await realRound(f, service, { requestID: 'other', attemptID: 'other-1', elapsed: 0 });
    const scopeRefusal = signedReport(real.ticket, real.begin, f.lease, { finishedAt: f.clock, status: 200, origin: 'proxy-scope' });
    assert.deepEqual(await service.request('/model-health/outcome', scopeRefusal), { ok: true, duplicate: false });
    await f.flush();
    assert.equal(resolved, false, 'another lease does not resolve this waiter');
    let open;
    f.gate = new Promise((resolve) => { open = resolve; });
    const ack = service.request('/model-health/outcome', report);
    try {
      await f.flush();
      assert.equal(resolved, false, 'not resolved while the commit is pending');
    } finally {
      // Never leave the commit gated: a failed assertion must fail the test, not hang it.
      open();
      f.gate = null;
    }
    const outcome = await wait;
    trace.push('resolved');
    assert.equal(outcome.result, 'success');
    assert.equal(outcome.purpose, 'outage-health');
    assert.equal(outcome.targetID, 'claude-opus-5');
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.proofs['claude-opus-5'].at, report.finishedAt, 'durable before resolution');
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: true }, 'applied before resolution');
    assert.deepEqual(await ack, { ok: true, duplicate: false });
    assert.equal(f.timers.has(waiterTimer), false, 'waiter timer cleared');
    // Release removes the ephemeral binding only: the durable reservation and count stay.
    assert.deepEqual(await service.request('/probe/release', releaseBody(a)), { ok: true });
    assert.equal(f.state.providers.anthropic.inflight.id, a.id);
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.probeCounts.reserve, 1);
  };
  try {
    await dispatchOne(f, service);
    assert.deepEqual(trace, ['registered', 'consumed', 'resolved']);
    assert.deepEqual(f.errors, []);
    assert.equal(f.ordinary.length, 0, 'no ordinary lease or settlement for a probe');
    assert.ok(f.ordinaryLookups.every((input) => input.purpose === 'real' && input.sessionID === 'sess-1'));
    assert.equal(f.state.providers.anthropic.inflight, null, 'probe-finished cleared the reservation');
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.probeCounts.reserve, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(service.assignments.lookupLease({ sessionID: assignment.sessionID }), null);
    // reservation, scope refusal, probe outcome, probe-finished: the worker never re-observes.
    assert.equal(f.commits.length, 4);
    assert.ok(!durableText(f).includes(capability) && !durableText(f).includes(GATEWAY));
    assert.deepEqual(f.polls, [], 'a probe outcome chains no poll or dispatch');
  } finally { await service.close(); }
});

test('a probe outcome is refused at commit once its episode resolved or its probe ended, and rebuilds no proof', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  const results = [];
  let late;
  f.sendProbe = async (a, { signal, waitForOutcome }) => {
    const wait = waitForOutcome(a.leaseID, { signal });
    const { report } = await probeRound(f, service, a);
    late = report;
    // A resolving snapshot is committed while the probe is still in flight (generation unchanged).
    const generation = f.state.scopes[logicalID].generation;
    await service.worker.observe(makeSnapshot({ receivedAt: f.clock, resolvedIncidentIDs: { 'claude-opus-5-5': ['incident-1'] } }));
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.resolved, true);
    assert.equal(f.state.scopes[logicalID].generation, generation);
    const commits = f.commits.length;
    await assert.rejects(service.request('/model-health/outcome', report), (error) => error.message === 'stale health outcome');
    assert.equal(f.commits.length, commits, 'nothing committed');
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.proofs['claude-opus-5'], undefined, 'no proof reconstituted');
    results.push(await settledNow(wait));
  };
  try {
    await dispatchOne(f, service);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(results, ['still pending'], 'the refused outcome resolved no waiter');
    // After the probe ended its binding is gone: the same report still fails closed.
    await assert.rejects(service.request('/model-health/outcome', late), (error) => error.message === 'stale health outcome');
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.proofs['claude-opus-5'], undefined);
  } finally { await service.close(); }
  // A valid probe outcome that arrives after its probe already ended is refused as well.
  const g = fixture();
  const other = createOutageService(g.opts);
  let report;
  g.sendProbe = async (a) => { ({ report } = await probeRound(g, other, a)); };
  try {
    await dispatchOne(g, other);
    const commits = g.commits.length;
    await assert.rejects(other.request('/model-health/outcome', report), (error) => error.message === 'stale health outcome');
    assert.equal(g.commits.length, commits);
  } finally { await other.close(); }
});

test('waiters enforce the exact lease and one use, and abort resolves null with nothing left behind', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  f.sendProbe = async (a, { waitForOutcome }) => {
    assert.throws(() => waitForOutcome('outage-other', {}), /outage waiter lease/);
    const controller = new AbortController();
    const wait = waitForOutcome(a.leaseID, { signal: controller.signal });
    assert.throws(() => waitForOutcome(a.leaseID, {}), /outage waiter reuse/);
    const timer = f.nextTimer;
    controller.abort();
    assert.equal(await wait, null);
    assert.equal(f.timers.has(timer), false);
  };
  try {
    await dispatchOne(f, service);
    assert.deepEqual(f.errors, []);
    assert.equal(f.timers.size, 0);
  } finally { await service.close(); }
  // An already-aborted signal resolves null without registering a timer.
  const g = fixture();
  const other = createOutageService(g.opts);
  g.sendProbe = async (a, { waitForOutcome }) => {
    const controller = new AbortController();
    controller.abort();
    const before = g.nextTimer;
    assert.equal(await waitForOutcome(a.leaseID, { signal: controller.signal }), null);
    assert.equal(g.nextTimer, before);
  };
  try { await dispatchOne(g, other); assert.deepEqual(g.errors, []); } finally { await other.close(); }
});

test('waiter TTL is bounded by the remaining reservation window, and expiry resolves null and cleans up', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  f.sendProbe = async (a, { waitForOutcome }) => {
    f.clock += 4000;
    const wait = waitForOutcome(a.leaseID);
    const timer = f.nextTimer;
    assert.equal(f.timers.get(timer).ms, 6000);
    f.timers.get(timer).fn();
    assert.equal(await wait, null);
    assert.equal(f.timers.has(timer), false);
  };
  try { await dispatchOne(f, service); assert.deepEqual(f.errors, []); assert.equal(f.timers.size, 0); } finally { await service.close(); }
  // A stray waiter requested after the probe finished resolves null at once and registers nothing.
  const g = fixture();
  const other = createOutageService(g.opts);
  let stray;
  let lease;
  g.sendProbe = async (a, { waitForOutcome }) => { stray = waitForOutcome; lease = a.leaseID; };
  try {
    await dispatchOne(g, other);
    const before = g.nextTimer;
    assert.equal(await settledNow(stray(lease)), null);
    assert.equal(g.nextTimer, before);
    assert.equal(g.timers.size, 0);
  } finally { await other.close(); }
});

test('a probe transport failure after registering propagates to the worker and cleans waiter, timer and binding', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  let pending;
  let assignment;
  f.sendProbe = async (a, { signal, waitForOutcome }) => {
    assignment = a;
    pending = waitForOutcome(a.leaseID, { signal });
    await service.request('/probe/consume', consumeBody(a));
    throw new Error('network down');
  };
  try {
    await service.worker.tick();
    await assert.rejects(service.worker.drain(), /network down/);
    assert.equal(await settledNow(pending), null, 'the waiter was settled, not left to its TTL');
    assert.equal(f.timers.size, 0);
    assert.equal(service.assignments.lookupLease({ sessionID: assignment.sessionID }), null, 'binding released');
    assert.equal(f.state.providers.anthropic.inflight, null);
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.probeCounts.reserve, 1, 'the probe stays charged');
    assert.equal(f.ordinary.length, 0);
    assert.equal(f.ordinaryLookups.length, 0);
  } finally { await service.close(); }
});

test('close resolves an outstanding waiter, drains the probe, and refuses later probe traffic', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const results = [];
  let assignment;
  f.sendProbe = async (a, { waitForOutcome }) => {
    assignment = a;
    const wait = waitForOutcome(a.leaseID);
    entered();
    results.push(await wait);
  };
  await service.worker.tick();
  await started;
  await service.close();
  assert.deepEqual(results, [null]);
  assert.equal(f.timers.size, 0);
  await assert.rejects(service.request('/probe/consume', consumeBody(assignment)), /outage service closed/);
  await assert.rejects(service.request('/model-health/begin', beginBody(f.lease)), /outage service closed/);
  await service.close();
});

test('a disabled outage policy performs no commits, polls, probes or timers', async () => {
  const f = fixture({ enabled: false, pollsAllowed: true });
  let probes = 0;
  f.sendProbe = async () => { probes++; };
  const service = createOutageService(f.opts);
  try {
    service.worker.start();
    await service.worker.tick();
    assert.deepEqual(await service.request('/failure', { sessionID: 's' }), { ok: true, path: '/failure' });
    await f.flush();
    assert.equal(f.serialized, 0, 'no transaction was queued (drain below adds only its empty barrier)');
    await service.worker.drain();
    assert.equal(f.commits.length, 0);
    assert.deepEqual(f.polls, []);
    assert.equal(probes, 0);
    assert.equal(f.timers.size, 0);
  } finally { await service.close(); }
});

// ---- Review coverage: one capability per probe, commit-time binding, close ordering ----

test('a probe assignment yields one capability through the service; the first ticket still commits its proof', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  const results = [];
  f.sendProbe = async (a, { signal, waitForOutcome }) => {
    const wait = waitForOutcome(a.leaseID, { signal });
    const { begin, report } = await probeRound(f, service, a);
    // A second begin (fresh request/attempt, so a fresh nonce) on the same consumed assignment.
    await assert.rejects(service.request('/model-health/begin', { ...begin, requestID: 'probe-r2', attemptID: 'probe-a2' }),
      (error) => error.message === 'outage capability reuse');
    await assert.rejects(service.request('/model-health/begin', begin), (error) => error.message === 'outage capability reuse');
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: false });
    results.push(await wait);
  };
  try {
    await dispatchOne(f, service);
    assert.deepEqual(f.errors, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].result, 'success');
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.proofs['claude-opus-5'].at, results[0].finishedAt);
    // reservation, the one probe outcome, probe-finished.
    assert.equal(f.commits.length, 3);
  } finally { await service.close(); }
});

test('a verified proxy-scope probe outcome uses its ticket credential instance, not the different attested instance', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  const OTHER = `ci_${Buffer.alloc(32, 8).toString('base64url')}`;
  const results = [];
  f.sendProbe = async (a, { signal, waitForOutcome }) => {
    const wait = waitForOutcome(a.leaseID, { signal });
    // The proxy attests the refused credential, but the ticket identifies the old scope whose
    // proofs must be revoked. Commit-time binding must therefore use the ticket identity.
    const { report } = await probeRound(f, service, a, { origin: 'proxy-scope', credentialInstance: OTHER });
    const commits = f.commits.length;
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: false });
    assert.equal(f.commits.length, commits + 1, 'the revocation commits once');
    assert.equal(f.state.scopes[logicalID].instances[OTHER], undefined, 'no instance created for the foreign credential');
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.proofs['claude-opus-5'], undefined, 'no proof');
    results.push(await wait);
    assert.deepEqual(await service.request('/model-health/outcome', report), { ok: true, duplicate: true });
    assert.equal(f.commits.length, commits + 1);
  };
  try {
    await dispatchOne(f, service);
    assert.deepEqual(f.errors, []);
    assert.equal(results[0].result, 'scope-mismatch');
    assert.equal(f.commits.length, 3, 'reservation, revocation, and probe-finished');
    assert.equal(f.state.scopes[logicalID].instances[CI].episode.probeCounts.reserve, 1);
  } finally { await service.close(); }
  // Control: the same proxy-scope report naming the expected instance also commits and resolves.
  const g = fixture();
  const other = createOutageService(g.opts);
  const controls = [];
  g.sendProbe = async (a, { signal, waitForOutcome }) => {
    const wait = waitForOutcome(a.leaseID, { signal });
    const { report } = await probeRound(g, other, a, { origin: 'proxy-scope' });
    assert.deepEqual(await other.request('/model-health/outcome', report), { ok: true, duplicate: false });
    controls.push(await wait);
  };
  try {
    await dispatchOne(g, other);
    assert.deepEqual(g.errors, []);
    assert.equal(controls[0].result, 'scope-mismatch');
    assert.equal(controls[0].credentialInstance, CI);
    assert.equal(g.commits.length, 3);
  } finally { await other.close(); }
});

test('a probe outcome is stale when, at the same generation, the persisted inflight changed or the head turned healthy', async () => {
  const edits = {
    'inflight replaced': (state) => { const r = state.providers.anthropic.inflight; state.providers.anthropic.inflight = { ...r, id: 'f'.repeat(32), nonce: Buffer.alloc(32, 5).toString('base64url') }; },
    'inflight field mismatch': (state) => { state.providers.anthropic.inflight.expiresAt -= 1; },
    'inflight restored partially': (state) => { const { id, expiresAt } = state.providers.anthropic.inflight; state.providers.anthropic.inflight = { id, expiresAt }; },
    'head healthy': (state) => { state.scopes[logicalID].instances[CI].episode.headHealthy = true; },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const f = fixture();
    const service = createOutageService(f.opts);
    const results = [];
    f.sendProbe = async (a, { signal, waitForOutcome }) => {
      const wait = waitForOutcome(a.leaseID, { signal });
      const { report } = await probeRound(f, service, a);
      const generation = f.state.scopes[logicalID].generation;
      // Another writer changed the image after the ticket was issued and before the outcome.
      edit(f.state);
      const before = structuredClone(f.state);
      const commits = f.commits.length;
      await assert.rejects(service.request('/model-health/outcome', report), (error) => error.message === 'stale health outcome', name);
      assert.equal(f.commits.length, commits, `${name}: nothing committed`);
      assert.deepEqual(f.state, before, `${name}: durable image untouched`);
      assert.equal(f.state.scopes[logicalID].generation, generation, `${name}: same generation`);
      assert.equal(f.state.scopes[logicalID].instances[CI].episode.proofs['claude-opus-5'], undefined, `${name}: no proof`);
      results.push(await settledNow(wait));
    };
    try {
      await dispatchOne(f, service);
      assert.deepEqual(results, ['still pending'], name);
      assert.equal(f.state.scopes[logicalID].instances[CI].episode.proofs['claude-opus-5'], undefined, name);
    } finally { await service.close(); }
  }
  // Control: the same image round-tripped through structuredClone with no edit still commits.
  const g = fixture();
  const other = createOutageService(g.opts);
  g.sendProbe = async (a, { signal, waitForOutcome }) => {
    const wait = waitForOutcome(a.leaseID, { signal });
    const { report } = await probeRound(g, other, a);
    g.state = structuredClone(g.state);
    assert.deepEqual(await other.request('/model-health/outcome', report), { ok: true, duplicate: false });
    assert.equal((await wait).result, 'success');
  };
  try {
    await dispatchOne(g, other);
    assert.deepEqual(g.errors, []);
    assert.equal(typeof g.state.scopes[logicalID].instances[CI].episode.proofs['claude-opus-5'].at, 'number');
  } finally { await other.close(); }
});

test('close called while an outcome commit is gated waits for it; the outcome is applied, not lost to an unknown receipt', async () => {
  const f = fixture();
  const service = createOutageService(f.opts);
  const { report } = await realRound(f, service, { status: 503 });
  let open;
  f.gate = new Promise((resolve) => { open = resolve; });
  const ack = service.request('/model-health/outcome', report);
  await f.flush();
  const closing = service.close();
  let ackResult;
  let closeResult;
  try {
    assert.equal(await settledNow(closing), 'still pending', 'close awaits the pending commit');
    assert.equal(await settledNow(ack), 'still pending');
    assert.equal(f.applied, 0);
  } finally {
    open();
    f.gate = null;
    ackResult = await ack;
    closeResult = await closing;
  }
  assert.deepEqual(ackResult, { ok: true, duplicate: false }, 'markApplied ran before the authority closed');
  assert.equal(closeResult, undefined);
  assert.equal(f.applied, 1);
  assert.equal(f.state.scopes[logicalID].instances[CI].lastPrimaryFailureAt, report.finishedAt);
  assert.deepEqual(f.errors, []);
  assert.equal(f.timers.size, 0);
  await assert.rejects(service.request('/model-health/outcome', report), /outage service closed/);
  assert.equal(service.close(), closing, 'memoized');
});

test('a worker.close rejection (serializer failure) still closes assignments, leaves no timers, and memoizes the rejection', async () => {
  const f = fixture();
  const shared = f.opts.serialize;
  let broken = false;
  f.opts.serialize = (transaction) => (broken ? Promise.reject(new Error('queue broken')) : shared(transaction));
  const service = createOutageService(f.opts);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const waited = [];
  let assignment;
  f.sendProbe = async (a, { signal, waitForOutcome }) => {
    assignment = a;
    const wait = waitForOutcome(a.leaseID, { signal });
    entered();
    waited.push(await wait);
  };
  await service.worker.tick();
  await started;
  service.worker.start();
  await f.flush();
  // Owned timers before close: the worker interval, the probe deadline and the outcome waiter.
  assert.deepEqual([...f.timers.values()].map((t) => t.interval).sort(), [false, false, true]);
  broken = true;
  const first = service.close();
  const second = service.close();
  assert.equal(first, second);
  await assert.rejects(first, /queue broken/);
  assert.equal(service.close(), first, 'the rejected close stays memoized');
  await assert.rejects(service.close(), /queue broken/);
  assert.deepEqual(waited, [null], 'the outstanding waiter was settled');
  assert.equal(f.timers.size, 0, 'interval, probe deadline and waiter timer all cleared');
  assert.throws(() => service.assignments.issue(assignment.reservation), /outage assignment closed/);
  assert.throws(() => service.assignments.consume(consumeBody(assignment)), /outage assignment closed/);
  assert.equal(service.assignments.lookupLease({ sessionID: assignment.sessionID }), null);
  await assert.rejects(service.request('/model-health/begin', beginBody(f.lease)), /outage service closed/);
  await assert.rejects(service.request('/probe/consume', consumeBody(assignment)), /outage service closed/);
});

// ---- Speed-alias assignments: the lease keeps the alias, the wire names the base id ----

// A reserve reservation in `scopeID`, produced by the real reducer and reserveProbe.
function aliasReservation(scopeID, primaryID, reserveID) {
  let state = emptyOutages();
  const ids = { logicalID: scopeID, primaryID, targetID: primaryID, modelID: primaryID, credentialInstance: CI };
  for (const event of [makeBaseline(ids), makeFailure(ids), makeSnapshot({ matches: { [primaryID]: ['incident-1'] } })]) {
    state = reduceOutages(state, event, { policy, now: event.finishedAt ?? event.receivedAt });
  }
  const reserved = reserveProbe(state, { logicalID: scopeID, targetID: reserveID, kind: 'reserve', id: randomBytes(16).toString('hex'),
    nonce: randomBytes(32).toString('base64url'), now: 2300 }, { policy });
  assert.ok(reserved, 'fixture reservation');
  return reserved;
}

function aliasAssignment(scopeID, primaryID, reserveID, targetSet = targets) {
  const { state, reservation } = aliasReservation(scopeID, primaryID, reserveID);
  const assignments = createOutageAssignments({ now: () => 2300, randomBytes, read: () => state, targets: targetSet, policy });
  return { state, assignments, assignment: assignments.issue(structuredClone(reservation)) };
}

test('a fast-scope alias assignment keeps the alias identity but puts the base id on the wire', () => {
  const fastScope = 'anthropic/opus/fast';
  assert.equal(policy.expectedScopePolicies[fastScope].speed, 'fast');
  const { state, assignments, assignment: a } = aliasAssignment(fastScope, 'claude-opus-5-5-fast', 'claude-opus-5-fast');
  assert.equal(a.modelID, 'claude-opus-5-fast', 'alias identity retained');
  assert.deepEqual(a.preferredModel, { providerID: 'anthropic', modelID: 'claude-opus-5-fast' });
  assert.equal(a.wireModelID, 'claude-opus-5', 'base id on the wire');
  assert.equal(a.expectedScopePolicy.speed, 'fast', 'scope speed unchanged');
  assert.equal(a.logicalID, fastScope);
  const authority = createHealthAuthority({ gatewayCredential: GATEWAY, now: () => 2300, randomBytes,
    lookupLease: (input) => assignments.lookupLease(input),
    lookupGeneration: (id) => state.scopes[id]?.generation ?? 0, latestFailureAt: () => null,
    verifyAttestation: () => { throw new Error('not reached'); } });
  // The gateway asserts the final outbound body's speed; a fast scope requires 'fast'.
  const begin = (modelID, speed = 'fast') => ({ gatewayCredential: GATEWAY, sessionID: a.sessionID, leaseID: a.leaseID, requestID: 'r',
    attemptID: 'a', purpose: 'outage-health', modelID, bodySHA256: BODY, ...(speed ? { speed } : {}) });
  try {
    assert.throws(() => authority.issue(begin('claude-opus-5')), /assignment/, 'refused before consume');
    assignments.consume({ sessionID: a.sessionID, probeNonce: a.probeNonce, purpose: 'outage-health' });
    assert.throws(() => authority.issue(begin('claude-opus-5-fast')), /assignment/, 'the alias is not a wire id');
    assert.throws(() => authority.issue(begin('claude-opus-5', null)), /speed scope/, 'a fast scope needs the fast body');
    assert.equal(typeof authority.issue(begin('claude-opus-5')).capability, 'string', 'the base wire id is accepted');
  } finally { authority.close(); assignments.close(); }
});

test('speed suffixes are stripped only when they match the scope speed, and never to an empty id', () => {
  // A standard scope whose catalog model carries the explicit -standard alias.
  const standardAlias = structuredClone(targets);
  standardAlias['claude-opus-5'].modelID = 'claude-opus-5-standard';
  const s = aliasAssignment('anthropic/opus/standard', 'claude-opus-5-5', 'claude-opus-5', standardAlias).assignment;
  assert.equal(s.modelID, 'claude-opus-5-standard');
  assert.equal(s.wireModelID, 'claude-opus-5');
  // A -fast model id in a standard scope is not an alias of that scope: it stays as is.
  const wrongSpeed = structuredClone(targets);
  wrongSpeed['claude-opus-5'].modelID = 'claude-opus-5-fast';
  assert.equal(aliasAssignment('anthropic/opus/standard', 'claude-opus-5-5', 'claude-opus-5', wrongSpeed).assignment.wireModelID, 'claude-opus-5-fast');
  // A fast scope whose model is already the base id keeps it.
  const baseFast = structuredClone(targets);
  baseFast['claude-opus-5-fast'].modelID = 'claude-opus-5';
  assert.equal(aliasAssignment('anthropic/opus/fast', 'claude-opus-5-5-fast', 'claude-opus-5-fast', baseFast).assignment.wireModelID, 'claude-opus-5');
  // -standard in a fast scope, and a bare suffix, are never stripped.
  const standardInFast = structuredClone(targets);
  standardInFast['claude-opus-5-fast'].modelID = 'claude-opus-5-standard';
  assert.equal(aliasAssignment('anthropic/opus/fast', 'claude-opus-5-5-fast', 'claude-opus-5-fast', standardInFast).assignment.wireModelID, 'claude-opus-5-standard');
  const bare = structuredClone(targets);
  bare['claude-opus-5-fast'].modelID = '-fast';
  assert.equal(aliasAssignment('anthropic/opus/fast', 'claude-opus-5-5-fast', 'claude-opus-5-fast', bare).assignment.wireModelID, '-fast');
});
