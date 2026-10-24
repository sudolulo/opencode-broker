import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHealthProtocol, sha256 } from '../gateway/lib/proxy-health-context.js';
import { emptyOutages, reduceOutages, reserveProbe } from '../lib/model-outages.js';
import { operatorQuarantineProvider, rearmQuarantinedProvider, recordFailureEvidenceAndNotify } from '../lib/provider-health.js';
import { makeBaseline, makeFailure, makePolicy, makeSnapshot, makeTargets } from './helpers/model-outages.mjs';

// Task 9 daemon runtime through a REAL spawned broker over its Unix socket. Offline: every key
// and credential below is a fake temp file, the official status feeds are answered by the
// test-only fetch preload (tests/fixtures/outage-status-fetch.cjs), and the gateway URL points at
// a local port nothing listens on. No provider and no live config is ever contacted.
const brokerScript = fileURLToPath(new URL('../bin/opencode-broker', import.meta.url));
const FETCH_FIXTURE = fileURLToPath(new URL('./fixtures/outage-status-fetch.cjs', import.meta.url));
const CI_A = `ci_${'A'.repeat(43)}`;
const LOGICAL = 'anthropic/opus/standard';
const policy = makePolicy();
const fixtureTargets = makeTargets();
fixtureTargets['gpt-terra'] = { id: 'gpt-terra', providerID: 'openai', modelID: 'gpt-6-terra', kind: 'cloud', context: 200000 };
const HEALTH_KEY = Buffer.alloc(32, 7);
const CREDENTIAL = 'fake-private-gateway-credential';

test('existing real quarantine notification is unchanged and remains callable', () => {
  const notices = [];
  const at = Date.now();
  const quarantined = operatorQuarantineProvider({}, 'anthropic', { at });
  const probation = rearmQuarantinedProvider(quarantined, 'anthropic', { at: at + 1 });
  const next = recordFailureEvidenceAndNotify(probation, 'anthropic', { targetID: 'claude-opus-5-5', modelID: 'claude-opus-5-5', sessionID: 'ses_real', reasonCode: 'compatibility',
    error: { message: 'fixture unsupported parameter' }, fingerprint: 'fixture-real-failure', at: at + 2 }, (notice) => notices.push(notice));
  assert.equal(next.providers.anthropic.state, 'quarantined');
  assert.deepEqual(notices, [{ title: 'anthropic quarantined', body: 'Automatic, after: fixture unsupported parameter. If the provider is fine, run: opencode-broker rearm provider:anthropic' }]);
  // Already quarantined: no second notice for the same transition.
  recordFailureEvidenceAndNotify(next, 'anthropic', { targetID: 'claude-opus-5-5', modelID: 'claude-opus-5-5', sessionID: 'ses_real', reasonCode: 'compatibility',
    error: { message: 'again' }, fingerprint: 'fixture-real-failure', at: at + 3 }, (notice) => notices.push(notice));
  assert.equal(notices.length, 1);
});

const post = (socketPath, path, body = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = http.request({ socketPath, path, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => { try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); } catch (error) { reject(error); } });
  });
  req.on('error', reject);
  req.end(payload);
});

// Durable episode in real time: a verified claude-opus-5 reserve. `reservePurpose: 'outage-health'`
// leaves the proof fresh but NOT active, so only an actual lease grant can activate it.
function outagesAt(base, { reservePurpose = 'outage-health' } = {}) {
  const t0 = base - 9_000;
  let outages = emptyOutages();
  for (const event of [
    makeBaseline({ credentialInstance: CI_A, startedAt: t0, finishedAt: t0 + 100 }),
    makeFailure({ credentialInstance: CI_A, startedAt: t0 + 1_000, finishedAt: t0 + 1_100 }),
    makeSnapshot({ receivedAt: t0 + 1_200 }),
    makeBaseline({ credentialInstance: CI_A, targetID: 'claude-opus-5', purpose: reservePurpose, requestID: 'r-reserve', attemptID: 'a-reserve',
      startedAt: t0 + 1_201, finishedAt: t0 + 1_300 }),
  ]) outages = reduceOutages(outages, event, { policy, now: event.finishedAt ?? event.receivedAt });
  return outages;
}

const brokerEnv = (extra) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  // An undefined override removes the variable rather than passing the string "undefined".
  return Object.fromEntries(Object.entries({ ...env, ...extra }).filter(([, value]) => value !== undefined));
};

async function spawnDaemon({ enabled = true, mode = 'active', ordinaryReserve = false, outages = null, leases = undefined, inventory = undefined, statusMode = 'unavailable',
  keys = true, envOverrides = {}, expectExit = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'outage-runtime-daemon-'));
  chmodSync(home, 0o700);
  const stateDir = join(home, '.local/share/opencode/model-routing');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const keyDir = join(home, 'keys');
  mkdirSync(keyDir, { mode: 0o700 });
  const gatewayKeyPath = join(keyDir, 'gateway-key');
  const credentialPath = join(keyDir, 'health-credential');
  const healthKeyPath = join(stateDir, 'model-health.key');
  if (keys) {
    writeFileSync(gatewayKeyPath, 'fake-front-door-key\n', { mode: 0o600 });
    writeFileSync(credentialPath, `${CREDENTIAL}\n`, { mode: 0o600 });
    writeFileSync(healthKeyPath, HEALTH_KEY, { mode: 0o600 });
  }
  const tracePath = join(home, 'fetch-trace.jsonl');
  writeFileSync(tracePath, '');
  const configPath = join(home, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    targets: fixtureTargets,
    tiers: { smart: ordinaryReserve ? ['claude-opus-5-5', 'claude-opus-5'] : ['claude-opus-5-5'], build: ['claude-opus-5-5', 'gpt-terra'], worker: ['gpt-terra'] },
    fallbacks: { smart: [['gpt-6-1-sol']] },
    burnWatch: { enabled: false }, slotWatch: { enabled: false },
    ...(enabled ? { modelOutages: (({ primaryScope: _derived, ...rest }) => ({ ...rest, mode }))(policy) } : {}),
  }));
  writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ anthropic: { type: 'oauth' }, openai: { type: 'oauth' } }));
  const statePath = join(stateDir, 'broker.json');
  // Schema 4 (no model policy section), which the reader still accepts and upgrades.
  writeFileSync(statePath, JSON.stringify({ version: 4, outages: outages ?? emptyOutages(),
    ...(leases ? { leases } : {}), ...(inventory ? { inventory } : {}) }), { mode: 0o600 });
  const socketPath = join(stateDir, 'broker.sock');
  const child = spawn(process.execPath, ['--require', FETCH_FIXTURE, brokerScript, 'serve'], {
    env: brokerEnv({
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_BROKER_LOCAL_MODELS_URL: 'http://127.0.0.1:9/v1/models',
      OPENCODE_BROKER_TEST_FETCH_TRACE: tracePath,
      OPENCODE_BROKER_TEST_STATUS_MODE: statusMode,
      OPENCODE_BROKER_OUTAGE_GATEWAY_URL: 'http://127.0.0.1:9',
      OPENCODE_BROKER_GATEWAY_KEY_FILE: gatewayKeyPath,
      OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE: credentialPath,
      ...envOverrides,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  if (expectExit) {
    const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
    if (!result) child.kill('SIGKILL');
    return { result, stdout, stderr, socketPath, healthKeyPath, cleanup };
  }
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`broker did not listen: ${stderr}`)), 5000);
    child.stdout.on('data', () => { if (stdout.includes('listening on ')) { clearTimeout(deadline); resolve(); } });
    exited.then(({ code }) => { clearTimeout(deadline); reject(new Error(`broker exited before listen (${code}): ${stderr}`)); });
  });
  return {
    home, child, socketPath, statePath, stderr: () => stderr, exited,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    trace: () => readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
      cleanup();
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('disabled outage policy reads no outage keys, fetches no status, and serves ordinary leases', async () => {
  const broker = await spawnDaemon({ enabled: false, keys: false, envOverrides: {
    OPENCODE_BROKER_OUTAGE_GATEWAY_URL: undefined, OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE: undefined } });
  try {
    const lease = await post(broker.socketPath, '/lease', { sessionID: 's-disabled', profile: 'auto', tier: 'smart' });
    assert.equal(lease.status, 200, JSON.stringify(lease.body));
    assert.equal(lease.body.target.id, 'claude-opus-5-5');
    assert.equal(lease.body.expectedCredentialInstance, null);
    const failure = await post(broker.socketPath, '/failure', { sessionID: 's-disabled', leaseID: lease.body.leaseID,
      error: { name: 'APIError', message: 'fixture overloaded', statusCode: 529 } });
    assert.equal(failure.status, 200, JSON.stringify(failure.body));
    const begin = await post(broker.socketPath, '/model-health/begin', { gatewayCredential: CREDENTIAL });
    assert.equal(begin.status, 404, 'no private outage endpoint exists while disabled');
    await sleep(300);
    assert.deepEqual(broker.trace(), [], 'zero status/probe network while disabled');
  } finally { await broker.stop(); }
});

for (const [name, overrides, pattern] of [
  ['missing gateway URL', { OPENCODE_BROKER_OUTAGE_GATEWAY_URL: '' }, /OPENCODE_BROKER_OUTAGE_GATEWAY_URL/],
  ['gateway URL with a path', { OPENCODE_BROKER_OUTAGE_GATEWAY_URL: 'http://127.0.0.1:9/v1' }, /OPENCODE_BROKER_OUTAGE_GATEWAY_URL/],
  ['missing private credential env', { OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE: '' }, /OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE/],
]) test(`enabled outage policy refuses to listen with ${name}`, async () => {
  const run = await spawnDaemon({ expectExit: true, envOverrides: overrides });
  try {
    assert.ok(run.result, 'broker must exit instead of listening');
    assert.equal(run.result.code, 1);
    assert.doesNotMatch(run.stdout, /listening on/);
    assert.match(run.stderr, pattern);
    assert.equal(existsSync(run.socketPath), false);
  } finally { run.cleanup(); }
});

test('enabled outage policy refuses to listen without its health key and never creates one', async () => {
  const run = await spawnDaemon({ expectExit: true, envOverrides: { OPENCODE_BROKER_HEALTH_KEY_FILE: join(tmpdir(), `absent-${process.pid}-${Date.now()}`, 'model-health.key') } });
  try {
    assert.equal(run.result?.code, 1);
    assert.match(run.stderr, /model health key/);
    assert.doesNotMatch(run.stderr, /fake-front-door-key|fake-private-gateway-credential/);
    assert.equal(existsSync(run.socketPath), false);
  } finally { run.cleanup(); }
});

function signedOutcome({ begin, sessionRequest, credentialInstance = CI_A, wireModelID, expectedCredentialInstance = null }) {
  const protocol = createHealthProtocol({ key: HEALTH_KEY });
  const { context, contextSignature } = protocol.signRequest([1, begin.nonce, begin.startedAt, begin.startedAt + 20_000,
    sessionRequest.requestID, sessionRequest.attemptID, 'real', 'anthropic', wireModelID, sessionRequest.bodySHA256, expectedCredentialInstance]);
  const { attestation, attestationSignature } = protocol.signResponse([1, begin.nonce, sessionRequest.requestID, sessionRequest.attemptID,
    wireModelID, credentialInstance, 'llm-auth-proxy/anthropic', 'https://api.anthropic.com', 'claude-code-oauth', 'messages',
    'claude-code', 'upstream-response', 200, sha256(context)]);
  return { gatewayCredential: CREDENTIAL, capability: begin.capability, context, contextSignature, attestation, attestationSignature,
    terminal: { api: 'messages', state: 'complete', status: 200, errorClass: null }, finishedAt: Date.now() };
}

test('private begin/outcome run outside the ordinary queue and durably bind the real baseline while status hangs', async () => {
  const broker = await spawnDaemon({ statusMode: 'hang' });
  try {
    const started = Date.now();
    const lease = await post(broker.socketPath, '/lease', { sessionID: 's-real', profile: 'auto', tier: 'smart' });
    assert.equal(lease.status, 200, JSON.stringify(lease.body));
    assert.equal(lease.body.target.id, 'claude-opus-5-5');
    assert.equal(lease.body.expectedCredentialInstance, null);
    const request = { requestID: 'req-1', attemptID: 'att-1', bodySHA256: 'a'.repeat(64) };
    const issue = (overrides = {}) => post(broker.socketPath, '/model-health/begin', { gatewayCredential: CREDENTIAL, sessionID: 's-real',
      leaseID: lease.body.leaseID, purpose: 'real', modelID: 'claude-opus-5-5', ...request, ...overrides });
    assert.equal((await issue({ gatewayCredential: 'wrong-credential' })).status, 400);
    assert.equal((await issue({ purpose: 'outage-health' })).status, 400, 'an ordinary lease never answers an outage-health begin');
    assert.equal((await issue({ modelID: 'claude-opus-5' })).status, 400, 'no wire-model substitution');
    const begin = await issue();
    assert.equal(begin.status, 200, JSON.stringify(begin.body));
    assert.equal(begin.body.generation, 0);
    await sleep(5);
    const report = signedOutcome({ begin: begin.body, sessionRequest: request, wireModelID: 'claude-opus-5-5' });
    const outcome = await post(broker.socketPath, '/model-health/outcome', report);
    assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
    assert.deepEqual(outcome.body, { ok: true, duplicate: false });
    const scope = broker.state().outages.scopes[LOGICAL];
    assert.equal(scope.currentCredentialInstance, CI_A);
    assert.equal(scope.generation, 2, 'credential adoption plus real baseline, durably on disk');
    assert.equal(typeof scope.instances[CI_A].baselineAt, 'number');
    const replay = await post(broker.socketPath, '/model-health/outcome', report);
    assert.deepEqual(replay.body, { ok: true, duplicate: true });
    assert.equal(broker.state().outages.scopes[LOGICAL].generation, 2, 'identical replay applies nothing');
    // Ordinary traffic was never blocked behind the hung official feed.
    assert.equal((await post(broker.socketPath, '/status', {})).status, 200);
    assert.ok(Date.now() - started < 4000, 'served within the 5 s status fetch bound');
    assert.ok(broker.trace().some((event) => event.kind === 'status'), 'the hung status poll really was in flight');
    assert.doesNotMatch(broker.stderr(), /fake-private-gateway-credential|fake-front-door-key/);
  } finally { await broker.stop(); }
});

test('observe mode durably records an exact real-head baseline without reserve authority or status I/O', async () => {
  // This fails if observe retains active startup polling, reserve selection, or private probe authority.
  const at = Date.now();
  const reservation = reserveProbe(outagesAt(at), { logicalID: LOGICAL, targetID: 'claude-opus-5', kind: 'reserve',
    id: 'observe-seeded', nonce: 'A'.repeat(43), now: at - 100 }, { policy });
  assert.ok(reservation, 'active fixture seeds a valid occupied reserve before mode transition');
  const seeded = reservation.state;
  const seededCount = seeded.scopes[LOGICAL].instances[CI_A].episode.probeCounts.reserve;
  const broker = await spawnDaemon({ mode: 'observe', ordinaryReserve: true, statusMode: 'hang', outages: seeded, inventory: admittedInventory });
  try {
    const preview = await post(broker.socketPath, '/preview', { profile: 'auto', tiers: ['smart'] });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.preview.smart?.id, 'claude-opus-5-5');
    const lease = await post(broker.socketPath, '/lease', { sessionID: 's-observe', profile: 'auto', tier: 'smart' });
    assert.equal(lease.status, 200, JSON.stringify(lease.body));
    assert.equal(lease.body.target.id, 'claude-opus-5-5');
    assert.equal(lease.body.expectedCredentialInstance, null);
    assert.deepEqual(broker.state().leases['s-observe'].outage, undefined, 'ordinary reserve membership does not create an outage assertion');
    const request = { requestID: 'req-observe', attemptID: 'att-observe', bodySHA256: 'c'.repeat(64) };
    const begin = await post(broker.socketPath, '/model-health/begin', { gatewayCredential: CREDENTIAL, sessionID: 's-observe',
      leaseID: lease.body.leaseID, purpose: 'real', modelID: 'claude-opus-5-5', ...request });
    assert.equal(begin.status, 200, JSON.stringify(begin.body));
    const outcome = await post(broker.socketPath, '/model-health/outcome', signedOutcome({ begin: begin.body, sessionRequest: request, wireModelID: 'claude-opus-5-5' }));
    assert.deepEqual(outcome.body, { ok: true, duplicate: false });
    const scope = broker.state().outages.scopes[LOGICAL];
    assert.equal(scope.instances[CI_A].baselineAt !== null, true);
    assert.equal(broker.state().outages.history.at(-1)?.probeCounts.reserve, seededCount, 'real observation retains retired episode counts in history');
    assert.equal((await post(broker.socketPath, '/probe/consume', { sessionID: 'gw-probe-restored', probeNonce: 'pbn_x', purpose: 'outage-health' })).status, 400);
    await sleep(100);
    assert.deepEqual(broker.trace(), [], 'observe starts no status fetches or probe traffic');
  } finally { await broker.stop(); }
});

test('probe consume/release route by purpose: outage-health to the isolated assignments, others to the legacy handler', async () => {
  const broker = await spawnDaemon();
  try {
    const outage = await post(broker.socketPath, '/probe/consume', { sessionID: 'gw-probe-unknown', probeNonce: 'pbn_x', purpose: 'outage-health' });
    assert.equal(outage.status, 400);
    assert.equal(outage.body.code, 'outage-health-refused');
    assert.match(outage.body.error, /probe nonce binding/);
    const release = await post(broker.socketPath, '/probe/release', { sessionID: 'gw-probe-unknown', probeNonce: 'pbn_x', leaseID: 'outage-x', purpose: 'outage-health' });
    assert.deepEqual(release.body, { ok: true });
    // Without the purpose the pre-read body still reaches the unchanged legacy handler.
    const legacy = await post(broker.socketPath, '/probe/consume', { sessionID: 'gw-probe-unknown', probeNonce: 'pbn_x' });
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.code, 'reconcile-apply-disabled');
  } finally { await broker.stop(); }
});

test('shutdown aborts a hung status poll and exits cleanly, removing the socket', async () => {
  const broker = await spawnDaemon({ statusMode: 'hang' });
  try {
    await sleep(100);
    assert.ok(broker.trace().some((event) => event.kind === 'status'));
    const started = Date.now();
    broker.child.kill('SIGTERM');
    const { code } = await broker.exited;
    assert.equal(code, 0, broker.stderr());
    assert.ok(Date.now() - started < 3000, 'shutdown does not wait out the feed');
    assert.equal(existsSync(broker.socketPath), false);
  } finally { await broker.stop(); }
});

// A private request whose client announced a body and never finished sending it. Resolves once
// the request line, headers and the partial body are on the wire; `closed` settles when the
// broker (or anything else) tears the connection down.
const stalledPost = (socketPath, path) => new Promise((resolve, reject) => {
  const socket = net.connect(socketPath);
  socket.resume();
  const closed = new Promise((settle) => socket.once('close', () => settle(Date.now())));
  socket.on('error', () => {});
  socket.once('connect', () => {
    socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"gatewayCredential":`,
      () => resolve({ socket, closed }));
  });
  socket.once('error', reject);
});
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => null)]);

test('SIGTERM with a stalled private request still exits promptly and removes the socket', async () => {
  const broker = await spawnDaemon();
  const stalled = [];
  try {
    for (const path of ['/model-health/begin', '/probe/consume']) stalled.push(await stalledPost(broker.socketPath, path));
    await sleep(100);
    const started = Date.now();
    broker.child.kill('SIGTERM');
    const result = await within(broker.exited, 3000);
    assert.ok(result, `broker did not exit within 3 s of SIGTERM with stalled private requests: ${broker.stderr()}`);
    assert.equal(result.code, 0, broker.stderr());
    assert.ok(Date.now() - started < 3000);
    assert.equal(existsSync(broker.socketPath), false, 'socket path removed');
  } finally {
    for (const { socket } of stalled) socket.destroy();
    await broker.stop();
  }
});

test('a stalled private or pre-read probe request is destroyed by the private request deadline', async () => {
  // Equal deadlines reproduce production ownership: preread must not arm the ordinary alert.
  const broker = await spawnDaemon({ envOverrides: {
    OPENCODE_BROKER_TEST_PRIVATE_DEADLINE_MS: '300', OPENCODE_BROKER_TEST_HANDLER_DEADLINE_MS: '300',
  } });
  const stalled = [];
  try {
    const before = await post(broker.socketPath, '/status', {});
    for (const path of ['/model-health/begin', '/model-health/outcome', '/probe/consume', '/probe/release']) {
      stalled.push({ path, ...(await stalledPost(broker.socketPath, path)) });
    }
    for (const { path, closed } of stalled) {
      assert.ok(await within(closed, 3000), `${path}: stalled request still open after 3 s`);
    }
    // The broker itself is unaffected and still answers.
    const after = await post(broker.socketPath, '/status', {});
    assert.equal(after.status, 200);
    assert.equal(after.body.queue.deadlineHits, before.body.queue.deadlineHits,
      'private preread stalls must not be counted as ordinary handler deadlines');
    assert.equal(after.body.queue.lastDeadlineAt, before.body.queue.lastDeadlineAt);
    assert.equal(after.body.queue.lastAlertAt, before.body.queue.lastAlertAt,
      'private preread stalls must not invoke the ordinary stall notification path');
    for (const { path } of stalled) {
      assert.ok(broker.stderr().includes(`private request deadline exceeded: ${path} `), broker.stderr());
    }
    assert.doesNotMatch(broker.stderr(), /opencode-broker handler deadline exceeded/);
    assert.equal(broker.child.exitCode, null);
  } finally {
    for (const { socket } of stalled) socket.destroy();
    await broker.stop();
  }
});

// Admitted providers as a previous /lease's auth revalidation would have persisted them; a
// preview does not revalidate admission itself.
const admittedInventory = { targets: {}, providers: { anthropic: { connected: true, authType: 'oauth' }, openai: { connected: true, authType: 'oauth' } } };

test('only an actual reserve lease activates its grant and publishes the bound credential instance', async () => {
  const broker = await spawnDaemon({ outages: outagesAt(Date.now()), inventory: admittedInventory });
  try {
    const proof = () => broker.state().outages.scopes[LOGICAL].instances[CI_A].episode.proofs['claude-opus-5'];
    const preview = await post(broker.socketPath, '/preview', { profile: 'auto', tiers: ['smart'] });
    assert.equal(preview.body.preview.smart?.id, 'claude-opus-5');
    assert.equal(proof().active, false, 'a preview activates nothing');
    const lease = await post(broker.socketPath, '/lease', { sessionID: 's-reserve', profile: 'auto', tier: 'smart' });
    assert.equal(lease.status, 200, JSON.stringify(lease.body));
    assert.equal(lease.body.target.id, 'claude-opus-5');
    assert.equal(lease.body.expectedCredentialInstance, CI_A);
    const generation = broker.state().outages.scopes[LOGICAL].generation;
    assert.equal(lease.body.generation, generation);
    assert.equal(proof().active, true, 'the actual grant activated the reserve, durably');
    assert.deepEqual(broker.state().leases['s-reserve'].outage, { logicalID: LOGICAL, primaryID: 'claude-opus-5-5',
      expectedCredentialInstance: CI_A, generation, episodeID: broker.state().outages.scopes[LOGICAL].instances[CI_A].episode.id });
    const held = await post(broker.socketPath, '/lease', { sessionID: 's-reserve', profile: 'auto', tier: 'smart' });
    assert.equal(held.body.existing, true);
    assert.equal(held.body.expectedCredentialInstance, CI_A);
    const verify = await post(broker.socketPath, '/lease/verify', {
      sessionID: 's-reserve', leaseID: lease.body.leaseID, wireModel: 'claude-opus-5',
    });
    assert.equal(verify.body.held, true);
    assert.equal(verify.body.expectedCredentialInstance, CI_A);
    assert.equal(verify.body.generation, generation);
    assert.equal(verify.body.target.id, 'claude-opus-5');
    // The real-traffic health lookup sees the reserve with its grant's credential instance.
    const request = { requestID: 'req-r', attemptID: 'att-r', bodySHA256: 'b'.repeat(64) };
    const begin = await post(broker.socketPath, '/model-health/begin', { gatewayCredential: CREDENTIAL, sessionID: 's-reserve',
      leaseID: lease.body.leaseID, purpose: 'real', modelID: 'claude-opus-5', ...request });
    assert.equal(begin.status, 200, JSON.stringify(begin.body));
    assert.equal(begin.body.generation, generation);
  } finally { await broker.stop(); }
});

test('a held reserve whose grant assertion is stale is neither verified nor reused', async () => {
  const outages = outagesAt(Date.now());
  const scope = outages.scopes[LOGICAL];
  const episodeID = scope.instances[CI_A].episode.id;
  const stale = { sessionID: 's-stale', leaseID: 'l-stale', targetID: 'claude-opus-5', touchedAt: Date.now(), profile: 'auto', tier: 'smart',
    outage: { logicalID: LOGICAL, primaryID: 'claude-opus-5-5', expectedCredentialInstance: CI_A, generation: scope.generation - 1, episodeID } };
  const broker = await spawnDaemon({ outages, leases: { 's-stale': stale } });
  try {
    const verify = await post(broker.socketPath, '/lease/verify', { sessionID: 's-stale', leaseID: 'l-stale' });
    assert.equal(verify.body.held, false);
    const lease = await post(broker.socketPath, '/lease', { sessionID: 's-stale', profile: 'auto', tier: 'smart' });
    assert.equal(lease.status, 200, JSON.stringify(lease.body));
    assert.equal(lease.body.existing, false, 'stale assertion is reselected, not reused');
    assert.notEqual(lease.body.leaseID, 'l-stale');
    assert.equal(lease.body.expectedCredentialInstance, CI_A);
    assert.equal(lease.body.generation, scope.generation);
  } finally { await broker.stop(); }
});
