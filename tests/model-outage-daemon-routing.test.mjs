import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { emptyOutages, reduceOutages } from '../lib/model-outages.js';
import { CI_A, makeTargets, makePolicy, makeBaseline, makeFailure, makeSnapshot } from './helpers/model-outages.mjs';
import { compareAndSwapModelPolicy, emptyModelPolicy } from '../lib/model-policy.js';

// The generation helper imports routing/config; never let that read the host's live config.
process.env.OPENCODE_BROKER_CONFIG = fileURLToPath(new URL('./fixtures/config.json', import.meta.url));
const { createResolverGenerationManager } = await import('../lib/resolver-generations.js');

// Task 7 daemon rows, through the real /lease and /preview handlers of a spawned broker whose
// durable broker.json carries an outage episode (decoded by lib/model-outage-state.js). No
// provider is contacted: every target is a fake cloud pin admitted by a fake oauth auth.json.
const brokerScript = join(fileURLToPath(new URL('..', import.meta.url)), 'bin/opencode-broker');
const fetchFixture = fileURLToPath(new URL('./fixtures/outage-status-fetch.cjs', import.meta.url));
const fixtureTargets = makeTargets();
fixtureTargets['gpt-terra'] = { id: 'gpt-terra', providerID: 'openai', modelID: 'gpt-6-terra', kind: 'cloud', context: 200000 };
const policy = makePolicy();

const post = (socketPath, path, body = {}, headers = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = http.request({
    socketPath, path, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
  }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
  });
  req.on('error', reject);
  req.end(payload);
});

// Keep a real body incomplete without holding up other connections to the broker.
const partialPost = (socketPath, path, body) => {
  const payload = JSON.stringify(body);
  const arrivedAt = Date.now();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({ socketPath, path, method: 'POST', agent, headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
    } }, (reply) => {
      let text = '';
      reply.setEncoding('utf8');
      reply.on('data', (chunk) => { text += chunk; });
      reply.on('end', () => {
        try { resolve({ status: reply.statusCode, body: JSON.parse(text), elapsedMs: Date.now() - arrivedAt }); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.write(payload.slice(0, -1));
  });
  return { response, finish: () => request.end(payload.slice(-1)), destroy: () => { request.destroy(); agent.destroy(); } };
};

// Real-time episode: a verified claude-opus-5 reserve (an actual real-traffic success, so the
// proof is ACTIVE and not bound by the 120s freshness) inside the 600s episode window.
function outagesAt(base, { lapsed = false, provisional = false } = {}) {
  const t0 = lapsed ? base - 2_000_000 : base - 9_000;
  let outages = emptyOutages();
  const credentialInstance = CI_A;
  for (const event of [
    makeBaseline({ credentialInstance, startedAt: t0, finishedAt: t0 + 100 }),
    makeFailure({ credentialInstance, startedAt: t0 + 1_000, finishedAt: t0 + 1_100 }),
    makeSnapshot({ receivedAt: t0 + 1_200 }),
    makeBaseline({ credentialInstance, targetID: 'claude-opus-5', purpose: lapsed || provisional ? 'outage-health' : 'real', requestID: 'r-reserve', attemptID: 'a-reserve',
      startedAt: t0 + 1_201, finishedAt: t0 + 1_300 }),
  ]) outages = reduceOutages(outages, event, { policy, now: event.finishedAt ?? event.receivedAt });
  return outages;
}

async function probationFixture(home, { candidateKind = 'newer', cursor = 0, phase = 'probation' } = {}) {
  const targets = structuredClone(fixtureTargets);
  for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']) targets[id].family = 'claude-opus';
  targets['claude-opus-5-5'].releaseDate = '2026-09-01';
  const candidateID = candidateKind === 'reserve' ? 'claude-opus-5' : 'subscription-anthropic-claude-opus-6-standard';
  const candidate = { id: candidateID, providerID: 'anthropic', modelID: candidateKind === 'reserve' ? 'claude-opus-5' : 'claude-opus-6',
    kind: 'cloud', capacity: null, source: 'subscription-oauth', tiers: ['smart'], fit: { smart: 9 },
    family: 'claude-opus', speed: 'standard', releaseDate: '2026-10-01', capabilities: { toolCall: true },
    context: 1_000_000, output: 32000, variants: ['low', 'medium', 'high'] };
  if (candidateKind === 'ambiguous') delete candidate.family;
  if (candidateKind === 'alias') {
    candidate.modelID = 'claude-opus-5-5-alias';
    candidate.canonicalModelID = 'claude-opus-5-5';
    candidate.releaseDate = targets['claude-opus-5-5'].releaseDate;
    // Alias markers are a configured-target contract, not discovered inventory metadata.
    targets[candidateID] = candidate;
  }
  const outagePolicy = makePolicy();
  outagePolicy.expectedScopePolicies['anthropic/claude-opus/standard'] = outagePolicy.expectedScopePolicies['anthropic/opus/standard'];
  delete outagePolicy.expectedScopePolicies['anthropic/opus/standard'];
  const models = [...new Set([...Object.values(targets), candidate].map((t) => `${t.providerID}/${t.modelID}`))];
  const root = join(home, 'state/generations');
  const currentLinkPath = join(root, 'current');
  mkdirSync(join(home, 'state/base'), { recursive: true, mode: 0o700 });
  const baseConfigPath = join(home, 'state/base/opencode.json');
  writeFileSync(baseConfigPath, JSON.stringify({ provider: { anthropic: { models: { 'claude-opus-5-5': { id: 'claude-opus-5-5' } } } } }), { mode: 0o600 });
  const manager = createResolverGenerationManager({ root, currentLinkPath,
    runResolver: async ({ configPath }) => readFileSync(configPath, 'utf8').includes(`"${candidate.modelID}"`)
      ? models.join('\n') + '\n' : 'anthropic/claude-opus-5-5\n' });
  const common = { baseConfigPath, protectedReferences: [], authorizedRetirements: [] };
  const zero = await manager.build({ ...common, reservedGeneration: 0, bootstrapGeneration0: true,
    overlay: { version: 1, revision: 0, updatedAt: Date.now(), entries: {} }, authorizingRevisions: [] });
  await manager.publish(zero);
  const generation = await manager.build({ ...common, reservedGeneration: 1, authorizingRevisions: ['revision-1'],
    overlay: { version: 1, revision: 1, updatedAt: Date.now(), entries: {
      [`anthropic/${candidate.modelID}`]: { transitionID: 'outage-trial', revision: 'revision-1', authorizationKind: 'auto-eligible',
        providerID: 'anthropic', modelID: candidate.modelID, roleKey: 'anthropic:claude-opus',
        authorizationHash: 'a'.repeat(64), introductionGeneration: 1,
        model: { id: candidate.modelID, name: 'Offline Opus candidate', family: 'claude-opus', release_date: '2026-10-01',
          tool_call: true, limit: { context: candidate.context, output: candidate.output }, variants: { low: {}, medium: {}, high: {} },
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } },
    } } });
  await manager.publish(generation);
  const modelPolicy = compareAndSwapModelPolicy(emptyModelPolicy(), {
    transitionID: 'outage-trial', revision: 'revision-1', roleKey: 'anthropic:claude-opus', expectedIncumbentModelID: 'claude-opus-5-5',
    generation: generation.generation, manifestHash: generation.manifestHash,
    desired: { activeModelID: 'claude-opus-5-5', probationModelID: candidate.modelID, rollbackModelID: 'claude-opus-5-5',
      routingIntent: { tiers: ['smart'], fit: { smart: 9 }, effortCeiling: 'high', requiredReasoningMode: null },
      probation: { phase, offerEvery: 2, opportunityCursor: cursor, opportunityMs: 0,
        opportunityCursorAt: null, opportunityEligibleUntil: null, successes: [], failures: [], leases: {} } },
  }).policy;
  return { targets, candidate, candidateID, models, generation, zero, modelPolicy, outagePolicy,
    reconcile: { apply: { enabled: true, providers: ['alibaba-token-plan'], overlayPath: join(home, 'state/overlay.json'), generationsRoot: root, currentLinkPath } } };
}

async function spawnBroker({ lapsed = false, probation = null, provisional = false, localModelsURL = 'http://127.0.0.1:9/v1/models',
  advanceClockAfterLocalModels = false, clockAdvanceAfterDateCalls = 1, envOverrides = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'outage-daemon-'));
  let child;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  };
  try {
  const trial = probation ? await probationFixture(home, probation) : null;
   const targets = structuredClone(trial?.targets ?? fixtureTargets);
   const smartTier = ['claude-opus-5-5'];
   if (provisional) {
     // This unavailable local fallback is only an await point. The reserve remains the selected
     // route, while localModels delays issue long enough for its provisional proof to lapse.
     targets['slow-local'] = { id: 'slow-local', providerID: 'llamacpp', modelID: 'slow-local', kind: 'local', capacity: 1, context: 32768 };
     smartTier.push('slow-local');
   }
   const configPath = join(home, 'config.json');
   writeFileSync(configPath, JSON.stringify({
     targets,
     tiers: { smart: smartTier, build: ['claude-opus-5-5', 'gpt-terra'], worker: ['gpt-terra'] },
     fallbacks: { smart: [['gpt-6-1-sol']] },
     profiles: { claude: ['claude-opus-5-5'] },
     profileCloudEgress: ['claude'],
     slotWatch: { enabled: false },
     modelOutages: (({ primaryScope, ...rest }) => rest)(trial?.outagePolicy ?? policy),
    ...(trial ? { reconcile: trial.reconcile, trustedSubscriptionProviders: ['alibaba-token-plan'] } : {}),
  }));
  mkdirSync(join(home, '.local/share/opencode/model-routing'), { recursive: true });
  writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ anthropic: { type: 'oauth' }, openai: { type: 'oauth' } }));
  writeFileSync(join(home, '.local/share/opencode/model-routing/broker.json'),
     JSON.stringify({ version: trial ? 5 : 4, outages: trial ? emptyOutages() : outagesAt(Date.now(), { lapsed, provisional }),
      ...(trial ? { modelPolicy: trial.modelPolicy, inventory: { targets: trial.candidate.canonicalModelID ? {} : { [trial.candidateID]: trial.candidate },
        modelVariants: { [`anthropic/${trial.candidate.modelID}`]: trial.candidate.variants } } } : {}) }));
  if (trial) writeFileSync(join(home, '.local/share/opencode/model-routing/resolvable-models.json'),
    JSON.stringify({ updatedAt: Date.now(), models: trial.models }));
  // Enabled outage policy runtime dependencies: fake 0600 keys in 0700 parents, a local gateway
  // URL nothing listens on, isolated HOME/XDG, and the offline status-feed preload.
  // The strict health-key reader refuses group/world-writable ancestors (the umask may allow them).
  const stateDir = join(home, '.local/share/opencode/model-routing');
  for (const dir of [home, join(home, '.local'), join(home, '.local/share'), join(home, '.local/share/opencode'), stateDir]) chmodSync(dir, 0o700);
  const keyDir = join(home, 'keys');
  mkdirSync(keyDir, { mode: 0o700 });
  writeFileSync(join(keyDir, 'gateway-key'), 'fake-front-door-key\n', { mode: 0o600 });
  writeFileSync(join(keyDir, 'health-credential'), 'fake-private-gateway-credential\n', { mode: 0o600 });
   writeFileSync(join(stateDir, 'model-health.key'), Buffer.alloc(32, 7), { mode: 0o600 });
   const clockPreloadPath = join(home, 'advance-clock-after-local-models.cjs');
   if (advanceClockAfterLocalModels) writeFileSync(clockPreloadPath, [
     'const originalNow = Date.now.bind(Date);',
     'const originalFetch = globalThis.fetch;',
     'const trigger = process.env.OPENCODE_BROKER_TEST_ADVANCE_CLOCK_ON_FETCH;',
     'let remaining = Number(process.env.OPENCODE_BROKER_TEST_CLOCK_ADVANCE_AFTER_DATE_CALLS);',
     'globalThis.fetch = async (...args) => {',
     '  const response = await originalFetch(...args);',
     '  if (String(args[0]) === trigger) Date.now = () => --remaining <= 0 ? originalNow() + 120001 : originalNow();',
     '  return response;',
     '};',
   ].join('\n'), { mode: 0o600 });
   const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
   child = spawn(process.execPath, [...(advanceClockAfterLocalModels ? ['--require', clockPreloadPath] : []), '--require', fetchFixture, brokerScript, 'serve'], {
    env: { ...inherited, HOME: home, OPENCODE_BROKER_CONFIG: configPath,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
       OPENCODE_BROKER_LOCAL_MODELS_URL: localModelsURL,
       ...(advanceClockAfterLocalModels ? { OPENCODE_BROKER_TEST_ADVANCE_CLOCK_ON_FETCH: localModelsURL,
         OPENCODE_BROKER_TEST_CLOCK_ADVANCE_AFTER_DATE_CALLS: String(clockAdvanceAfterDateCalls) } : {}),
      OPENCODE_BROKER_OUTAGE_GATEWAY_URL: 'http://127.0.0.1:9',
      OPENCODE_BROKER_GATEWAY_KEY_FILE: join(keyDir, 'gateway-key'),
      OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE: join(keyDir, 'health-credential'),
       OPENCODE_BROKER_TEST_FETCH_TRACE: join(home, 'fetch-trace.jsonl'), ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening on ')) resolve(); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
  });
  const socketPath = join(home, '.local/share/opencode/model-routing/broker.sock');
  let resolverToken, incompatibleToken;
  if (trial) {
    for (const [name, generation] of [['compatible', trial.generation], ['incompatible', trial.zero]]) {
      const registration = await post(socketPath, '/resolver-process/register', {
        generation: generation.generation, manifestHash: generation.manifestHash, modelKeys: generation.manifest.modelKeys,
      });
      assert.equal(registration.status, 200, JSON.stringify(registration.body));
      assert.ok(registration.body.resolverToken, `${name} generation registered`);
      if (name === 'compatible') resolverToken = registration.body.resolverToken;
      else incompatibleToken = registration.body.resolverToken;
    }
  }
  return { socketPath, stop, stderr: () => stderr, trial, resolverToken, incompatibleToken };
  } catch (error) {
    await stop();
    throw error;
  }
}

test('the daemon leases, holds, previews and excludes an authorized reserve from durable outage state', async () => {
  const broker = await spawnBroker();
  const lease = (body) => post(broker.socketPath, '/lease', body);
  try {
    const reserve = await lease({ sessionID: 's-reserve', profile: 'auto', tier: 'smart' });
    assert.equal(reserve.status, 200, JSON.stringify(reserve.body));
    assert.equal(reserve.body.target.id, 'claude-opus-5');
    assert.equal(reserve.body.decision.policy, 'outage-reserve');
    assert.ok(reserve.body.decision.reasons.includes('outage-reserve-for-claude-opus-5-5'));

    // Held lease: the same session gets its reserve back through revalidation while the grant holds.
    const held = await lease({ sessionID: 's-reserve', profile: 'auto', tier: 'smart' });
    assert.equal(held.body.existing, true);
    assert.equal(held.body.target.id, 'claude-opus-5');
    assert.equal(held.body.decision.policy, 'held-lease-revalidation');

    // Unrelated healthy primary wins over the reserve in a lane that carries both.
    const build = await lease({ sessionID: 's-build', profile: 'auto', tier: 'build' });
    assert.equal(build.body.target.id, 'gpt-terra');
    assert.equal(build.body.decision.policy, 'weighted-depletion');

    // Explicit exclusion is one more fence on THIS request: it beats even the held reserve, is
    // validated, and is not inherited by any later request.
    const excluded = await lease({ sessionID: 's-reserve', profile: 'auto', tier: 'smart', excludeTargetIDs: ['claude-opus-5'] });
    assert.equal(excluded.status, 200, JSON.stringify(excluded.body));
    assert.equal(excluded.body.existing, false, 'the held reserve lease is abandoned, not revalidated, under an exclusion');
    assert.equal(excluded.body.target.id, 'gpt-6-1-sol');
    assert.equal(excluded.body.decision.policy, 'strict-fallback');
    const invalid = await lease({ sessionID: 's-invalid', profile: 'auto', tier: 'smart', excludeTargetIDs: 'claude-opus-5' });
    assert.notEqual(invalid.status, 200);
    assert.match(String(invalid.body.error), /excludeTargetIDs/);
    const later = await lease({ sessionID: 's-later', profile: 'auto', tier: 'smart' });
    assert.equal(later.body.target.id, 'claude-opus-5', 'a later request inherits no exclusion');

    // A Claude-only profile widens to its same-provider reserve and nothing else.
    const claude = await lease({ sessionID: 's-claude', profile: 'claude', tier: 'smart' });
    assert.equal(claude.body.target.id, 'claude-opus-5');
    assert.equal(claude.body.decision.policy, 'outage-reserve');

    // Preview reports the same gate for every requested tier.
    const preview = await post(broker.socketPath, '/preview', { profile: 'auto', tiers: ['smart', 'build', 'worker'] });
    assert.equal(preview.body.preview.smart?.id, 'claude-opus-5');
    assert.equal(preview.body.preview.build?.id, 'gpt-terra');
    assert.equal(preview.body.preview.worker?.id, 'gpt-terra');
  } finally {
    await broker.stop();
  }
});

test('a lapsed grant leaves the head ordinary again: the daemon routes to it and never to a reserve', async () => {
  const broker = await spawnBroker({ lapsed: true });
  try {
    const head = await post(broker.socketPath, '/lease', { sessionID: 's-head', profile: 'auto', tier: 'smart' });
    assert.equal(head.status, 200, JSON.stringify(head.body));
    assert.equal(head.body.target.id, 'claude-opus-5-5');
    assert.equal(head.body.decision.policy, 'weighted-depletion');
    const preview = await post(broker.socketPath, '/preview', { profile: 'auto', tiers: ['smart'] });
    assert.equal(preview.body.preview.smart?.id, 'claude-opus-5-5');
    // With the head fenced and no grant, the reserve is still not a rung: the lane falls back.
    const fenced = await post(broker.socketPath, '/lease', { sessionID: 's-fenced', profile: 'auto', tier: 'smart', excludeTargetIDs: ['claude-opus-5-5'] });
    assert.equal(fenced.body.target.id, 'gpt-6-1-sol');
  } finally {
    await broker.stop();
  }
});

test('a provisional reserve that lapses while local-model discovery awaits is refused before issue', async () => {
  const models = http.createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [] }));
    }, 25);
  });
  await new Promise((resolve) => models.listen(0, '127.0.0.1', resolve));
  const localModelsURL = `http://127.0.0.1:${models.address().port}/v1/models`;
  const broker = await spawnBroker({ provisional: true, localModelsURL, advanceClockAfterLocalModels: true, clockAdvanceAfterDateCalls: 4 });
  try {
    const result = await post(broker.socketPath, '/lease', { sessionID: 's-provisional-lapse', profile: 'auto', tier: 'smart' });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(String(result.body.error), /outage reserve selected without a current grant/);
  } finally {
    await broker.stop();
    await new Promise((resolve) => models.close(resolve));
  }
});

const trialLease = (broker, sessionID, overrides = {}) => post(broker.socketPath, '/lease', {
  sessionID, profile: 'auto', tier: 'smart', resolverToken: broker.resolverToken,
  resolvableModels: broker.trial.models, ...overrides,
});
for (const contextTokens of [0, 180_000]) test(`staged managed candidate is actually leased with contextTokens=${contextTokens}`, async () => {
  const broker = await spawnBroker({ probation: {} });
  try {
    const offered = await trialLease(broker, 'offered', { contextTokens });
    assert.equal(offered.status, 200, JSON.stringify(offered.body));
    assert.equal(offered.body.target.id, broker.trial.candidateID, 'the candidate-only choice must survive final selection');
    assert.equal(offered.body.target.model.id, 'claude-opus-6');
    if (contextTokens) assert.ok(offered.body.decision.reasons.includes('context-pressure-prefers-roomier-window'),
      '180k / pressure threshold filters the 200k off-lane targets, so this MUST exercise the retry');
    const preview = await post(broker.socketPath, '/preview', { profile: 'auto', tiers: ['smart'] });
    assert.equal(preview.body.preview.smart?.id, 'claude-opus-5-5', 'trial does not mutate ordinary preview heads');
    const ordinary = await trialLease(broker, 'ordinary');
    assert.equal(ordinary.body.target.id, 'claude-opus-5-5', 'the live candidate lease prevents another offer');
    const held = await trialLease(broker, 'offered', { resolverToken: undefined });
    assert.equal(held.body.existing, false, 'a previous trial is not an ordinary held-lease exemption');
    assert.equal(held.body.target.id, 'claude-opus-5-5');
    const sticky = await trialLease(broker, 'offered', { replace: true, resolverToken: broker.incompatibleToken,
      preferredModel: { providerID: 'anthropic', id: 'claude-opus-6' } });
    assert.equal(sticky.body.target.id, 'claude-opus-5-5', 'neither assignment nor preferredModel makes a future trial sticky');
  } finally { await broker.stop(); }
});

for (const [name, options, overrides] of [
  ['nonoffer cursor', { cursor: 1 }, {}],
  ['missing registration', {}, { resolverToken: undefined }],
  ['incompatible registration', {}, { incompatible: true }],
  ['excluded candidate', {}, { excludeCandidate: true }],
  ['listed reserve', { candidateKind: 'reserve' }, {}],
  ['configured alias', { candidateKind: 'alias' }, {}],
  ['ambiguous managed metadata', { candidateKind: 'ambiguous' }, {}],
]) test(`staged offer cannot bypass ${name}`, async () => {
  const broker = await spawnBroker({ probation: options });
  try {
    const { incompatible, excludeCandidate, ...request } = overrides;
    const result = await trialLease(broker, 'not-offered', { ...request,
      ...(incompatible ? { resolverToken: broker.incompatibleToken } : {}),
      ...(excludeCandidate ? { excludeTargetIDs: [broker.trial.candidateID] } : {}),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.target.id, 'claude-opus-5-5');
  } finally { await broker.stop(); }
});

// A real synthetic assignment reaches the candidate-only branch even for static aliases.
// No completion is dispatched: these tests exercise only local broker protocol and selection.
for (const path of ['/probe/consume', '/probe/release']) test(`ordinary ${path} keeps its preread arrival budget and cannot mutate after expiry`, { timeout: 10_000 }, async () => {
  const deadlineMs = 300;
  const broker = await spawnBroker({ probation: { phase: 'staged-probing' }, envOverrides: {
    OPENCODE_BROKER_TEST_HANDLER_DEADLINE_MS: String(deadlineMs),
    OPENCODE_BROKER_TEST_PRIVATE_DEADLINE_MS: String(deadlineMs),
  } });
  const pending = [];
  try {
    const generation = broker.trial.generation;
    const identity = { transitionID: 'outage-trial', roleKey: 'anthropic:claude-opus',
      candidateIdentity: { providerID: 'anthropic', modelID: broker.trial.candidate.modelID },
      candidateIntroduction: { generation: generation.generation, manifestHash: generation.manifestHash } };
    const launch = await post(broker.socketPath, '/model-policy/probe-launch', { ...identity,
      operationID: 'outage-trial:staged-probing', expectedPolicyRevision: 'revision-1' });
    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    const registration = await post(broker.socketPath, '/resolver-process/register', {
      generation: generation.generation, manifestHash: generation.manifestHash, probeLaunchNonce: launch.body.probeLaunchNonce,
    });
    assert.equal(registration.status, 200, JSON.stringify(registration.body));
    const assigned = await post(broker.socketPath, '/model-policy/probe', { ...identity, probeKind: 'normal', requestID: 'deadline-probe' },
      { 'x-opencode-resolver-token': registration.body.resolverToken });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const body = { sessionID: assigned.body.sessionID, probeNonce: assigned.body.probeNonce };
    if (path === '/probe/release') assert.equal((await post(broker.socketPath, '/probe/consume', body)).status, 200);

    const probe = partialPost(broker.socketPath, path, body);
    pending.push(probe);
    // Spend most of the budget in private preread, then hand off behind a newer ordinary parser.
    // A fresh budget at classification (or queue head) would mutate at ~400ms, not expire at ~300ms.
    await new Promise((resolve) => setTimeout(resolve, 180));
    const blocker = partialPost(broker.socketPath, '/model-policy/cas', {});
    pending.push(blocker);
    await new Promise((resolve) => setTimeout(resolve, 20));
    probe.finish();
    const drained = new Promise((resolve) => setTimeout(resolve, 200)).then(() => {
      blocker.finish();
      return blocker.response;
    });
    const [expired, blockerReply] = await Promise.all([probe.response, drained]);
    assert.equal(expired.status, 503, JSON.stringify(expired.body));
    assert.deepEqual(expired.body, { error: 'broker handler deadline exceeded' });
    assert.ok(expired.elapsedMs <= deadlineMs + 50, `ordinary fallback resolved at ${expired.elapsedMs}ms, expected <=350ms`);
    assert.equal(blockerReply.status, 400, 'the incomplete CAS body must drain without changing policy');
    // A queue barrier proves the expired ordinary probe has drained before checking its state.
    assert.equal((await post(broker.socketPath, '/status')).status, 200);
    const fresh = await post(broker.socketPath, path, body);
    assert.equal(fresh.status, 200, `expired ${path} must not consume/release the assignment: ${JSON.stringify(fresh.body)}`);
    if (path === '/probe/release') assert.deepEqual(fresh.body, { changed: true, state: 'released' });
    assert.ok(broker.stderr().includes(`opencode-broker handler deadline exceeded: ${path} `),
      'the classified ordinary deadline must still alert');
    assert.doesNotMatch(broker.stderr(), /private request deadline exceeded/);
  } finally {
    for (const request of pending) request.destroy();
    await broker.stop();
  }
});

for (const candidateKind of ['newer', 'alias', 'reserve', 'ambiguous']) test(`exact staged probe preserves outage fences: ${candidateKind}`, async () => {
  const broker = await spawnBroker({ probation: { candidateKind, phase: 'staged-probing' } });
  try {
    const generation = broker.trial.generation;
    const identity = { transitionID: 'outage-trial', roleKey: 'anthropic:claude-opus',
      candidateIdentity: { providerID: 'anthropic', modelID: broker.trial.candidate.modelID },
      candidateIntroduction: { generation: generation.generation, manifestHash: generation.manifestHash } };
    const launch = await post(broker.socketPath, '/model-policy/probe-launch', { ...identity,
      operationID: 'outage-trial:staged-probing', expectedPolicyRevision: 'revision-1' });
    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    const registration = await post(broker.socketPath, '/resolver-process/register', {
      generation: generation.generation, manifestHash: generation.manifestHash, probeLaunchNonce: launch.body.probeLaunchNonce,
    });
    assert.equal(registration.status, 200, JSON.stringify(registration.body));
    const assigned = await post(broker.socketPath, '/model-policy/probe', { ...identity, probeKind: 'normal', requestID: 'probe-1' },
      { 'x-opencode-resolver-token': registration.body.resolverToken });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const consumed = await post(broker.socketPath, '/probe/consume', { sessionID: assigned.body.sessionID, probeNonce: assigned.body.probeNonce });
    assert.equal(consumed.status, 200, JSON.stringify(consumed.body));
    const leased = await trialLease(broker, assigned.body.sessionID, { oneShot: true, replace: true,
      preferredModel: { providerID: 'anthropic', id: broker.trial.candidate.modelID } });
    if (candidateKind === 'newer') {
      assert.equal(leased.status, 200, JSON.stringify(leased.body));
      assert.equal(leased.body.target.id, broker.trial.candidateID);
    } else {
      assert.equal(leased.status, 400, JSON.stringify(leased.body));
      assert.equal(leased.body.code, 'no-eligible-target', 'a probe may not fallback to the incumbent or turn an alias/reserve into a head');
    }
  } finally { await broker.stop(); }
});

test('a single-model failure stands in the head\'s reserve for pinned and fresh sessions, with no grant', async () => {
  const broker = await spawnBroker({ lapsed: true });
  try {
    const pinned = await post(broker.socketPath, '/lease', { sessionID: 's-pinned', profile: 'auto', tier: 'smart' });
    assert.equal(pinned.body.target.id, 'claude-opus-5-5');
    // A model failure (not transport, not provider-wide) opens the head's own circuit.
    const failure = await post(broker.socketPath, '/failure', { sessionID: 's-pinned', leaseID: pinned.body.leaseID,
      targetID: 'claude-opus-5-5', error: { statusCode: 500, message: 'Anthropic upstream HTTP 500' } });
    assert.equal(failure.status, 200, JSON.stringify(failure.body));
    assert.equal(failure.body.kind, 'other');

    const stayed = await post(broker.socketPath, '/lease', { sessionID: 's-pinned', profile: 'auto', tier: 'smart', replace: true });
    assert.equal(stayed.status, 200, JSON.stringify(stayed.body));
    assert.equal(stayed.body.target.id, 'claude-opus-5', 'the pinned session drops one version, not to the fallback rung');
    assert.equal(stayed.body.decision.policy, 'circuit-reserve');
    assert.equal(stayed.body.outage ?? null, null, 'an ordinary lease: no outage assertion rides on it');

    const fresh = await post(broker.socketPath, '/lease', { sessionID: 's-fresh', profile: 'auto', tier: 'smart' });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.target.id, 'claude-opus-5');
    assert.equal(fresh.body.decision.policy, 'circuit-reserve');
  } finally {
    await broker.stop();
  }
});
