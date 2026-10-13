import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const brokerScript = join(fileURLToPath(new URL('..', import.meta.url)), 'bin/opencode-broker');

const waitFor = async (description, predicate, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const waitForChildExit = (child, timeoutMs = 1_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.removeListener('exit', exited);
    reject(new Error(`broker did not exit within ${timeoutMs}ms`));
  }, timeoutMs);
  const exited = () => {
    clearTimeout(timer);
    resolve();
  };
  child.once('exit', exited);
});

const closeServer = (server, timeoutMs = 1_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`models server did not close within ${timeoutMs}ms`)), timeoutMs);
  server.close((error) => {
    clearTimeout(timer);
    if (error) reject(error);
    else resolve();
  });
});

const post = (socketPath, path, body, agent) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const request = http.request({ socketPath, path, method: 'POST', agent, headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
  } }, (response) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { text += chunk; });
    response.on('end', () => {
      try { resolve({ status: response.statusCode, body: JSON.parse(text) }); }
      catch (error) { reject(error); }
    });
  });
  request.once('error', reject);
  request.end(payload);
});

test('a deadline-expired local lease cannot later claim its slot', { timeout: 5_000 }, async () => {
  let releaseUsage;
  const usageReleased = new Promise((resolve) => { releaseUsage = resolve; });
  let usageRequested;
  const usageRequestedPromise = new Promise((resolve) => { usageRequested = resolve; });
  const usage = http.createServer(async (request, response) => {
    assert.equal(request.url, '/usage');
    usageRequested();
    await usageReleased;
    response.writeHead(200, { 'content-type': 'application/json' });
    const resetsAt = Date.now() + 60_000;
    response.end(JSON.stringify({ windows: [{ id: 'wk', percent: 100, resetsAt: new Date(resetsAt).toISOString(), active: true, severity: null }], lockedUntil: resetsAt }));
  });
  await new Promise((resolve) => usage.listen(0, '127.0.0.1', resolve));
  let releaseFirstModels;
  const firstModelsReleased = new Promise((resolve) => { releaseFirstModels = resolve; });
  let releaseSecondModels;
  const secondModelsReleased = new Promise((resolve) => { releaseSecondModels = resolve; });
  let requestedFirstModels;
  const firstModelsRequested = new Promise((resolve) => { requestedFirstModels = resolve; });
  let requestedSecondModels;
  const secondModelsRequested = new Promise((resolve) => { requestedSecondModels = resolve; });
  let modelRequests = 0;
  const models = http.createServer(async (_request, response) => {
    modelRequests += 1;
    if (modelRequests === 1) {
      requestedFirstModels();
      await firstModelsReleased;
    } else if (modelRequests === 2) {
      requestedSecondModels();
      await secondModelsReleased;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'test-local', status: 'loaded' }] }));
  });
  await new Promise((resolve) => models.listen(0, '127.0.0.1', resolve));

  const home = mkdtempSync(join(tmpdir(), 'broker-handler-deadline-'));
  const configPath = join(home, 'config.json');
  const statePath = join(home, '.local/share/opencode/model-routing/broker.json');
  const socketPath = join(home, '.local/share/opencode/model-routing/broker.sock');
  const localModelsURL = `http://127.0.0.1:${models.address().port}/v1/models`;
  const usageURL = `http://127.0.0.1:${usage.address().port}/usage`;
  const localParsedMarkerPath = join(home, 'local-models-parsed');
  const usageParsedMarkerPath = join(home, 'plan-usage-parsed');
  const keyPath = join(home, 'usage-key');
  const preloadPath = join(home, 'mark-deadline-json-parse.cjs');
  writeFileSync(configPath, JSON.stringify({
    targets: {
      local: { providerID: 'llamacpp', modelID: 'test-local', kind: 'local', capacity: 1, context: 32768 },
      cloud: { providerID: 'fixture', modelID: 'fixture-cloud', kind: 'cloud', context: 32768 },
    },
    tiers: { worker: ['local'] },
    profiles: { local: ['local'] },
    budgets: { fixture: { windows: [{ id: 'wk', periodMs: 604800000, meter: 'requests', capacity: 100 }],
      planUsage: { type: 'http', url: usageURL, keyFile: keyPath } } },
    slotWatch: { enabled: false },
  }));
  mkdirSync(join(home, '.local/share/opencode/model-routing'), { recursive: true });
  writeFileSync(keyPath, 'fake-test-plan-usage-key\n', { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  writeFileSync(preloadPath, [
    "const { writeFileSync } = require('node:fs');",
    'const fetch = globalThis.fetch;',
    'const localModelsURL = process.env.OPENCODE_BROKER_TEST_MARK_LOCAL_MODELS_URL;',
    'const usageURL = process.env.OPENCODE_BROKER_TEST_MARK_USAGE_URL;',
    'const localMarker = process.env.OPENCODE_BROKER_TEST_LOCAL_MODELS_MARKER;',
    'const usageMarker = process.env.OPENCODE_BROKER_TEST_USAGE_MARKER;',
    'globalThis.fetch = async (...args) => {',
    '  const response = await fetch(...args);',
    '  const target = String(args[0]);',
    '  if (target !== localModelsURL && target !== usageURL) return response;',
    '  const json = response.json.bind(response);',
    '  response.json = async () => {',
    '    const payload = await json();',
    "    setImmediate(() => writeFileSync(target === localModelsURL ? localMarker : usageMarker, 'parsed'));",
    '    return payload;',
    '  };',
    '  return response;',
    '};',
  ].join('\n'));

  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  const child = spawn(process.execPath, ['--require', preloadPath, brokerScript, 'serve'], { env: {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    OPENCODE_BROKER_CONFIG: configPath,
    OPENCODE_BROKER_LOCAL_MODELS_URL: localModelsURL,
    OPENCODE_BROKER_TEST_HANDLER_DEADLINE_MS: '250',
    OPENCODE_BROKER_TEST_MARK_LOCAL_MODELS_URL: localModelsURL,
    OPENCODE_BROKER_TEST_LOCAL_MODELS_MARKER: localParsedMarkerPath,
    OPENCODE_BROKER_TEST_MARK_USAGE_URL: usageURL,
    OPENCODE_BROKER_TEST_USAGE_MARKER: usageParsedMarkerPath,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadlineAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const resumedStatusAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const ordinaryAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const ghostStatusAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening on ')) resolve(); });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
    });

    const expired = post(socketPath, '/lease', {
      sessionID: 'expired', profile: 'local', tier: 'worker', localOnly: true, contextTokens: 100,
    }, deadlineAgent);
    await firstModelsRequested;
    await usageRequestedPromise;
    const expiredReply = await expired;
    assert.equal(expiredReply.status, 503);
    assert.deepEqual(expiredReply.body, { error: 'broker handler deadline exceeded' });
    const stateAtDeadline = readFileSync(statePath, 'utf8');

    // The detached usage refresh has parsed a locked plan, but the request that started it has
    // expired and local discovery is still pending. It therefore cannot mutate broker.json.
    releaseUsage();
    await waitFor('the detached plan refresh to parse its response', () => existsSync(usageParsedMarkerPath));
    assert.equal(readFileSync(statePath, 'utf8'), stateAtDeadline,
      'a detached refresh from an expired local lease must not update the locked provider state');

    releaseFirstModels();
    await waitFor('the expired handler to parse local discovery', () => existsSync(localParsedMarkerPath));
    const afterResume = await post(socketPath, '/status', {}, resumedStatusAgent);
    assert.equal(afterResume.status, 200);
    assert.equal(afterResume.body.leases.expired, undefined, 'a resumed deadline-expired handler must not receive a lease');
    assert.equal(afterResume.body.assignments.expired, undefined, 'a resumed deadline-expired handler must not receive an assignment');

    const ordinary = post(socketPath, '/lease', {
      sessionID: 'ordinary', profile: 'local', tier: 'worker', localOnly: true, contextTokens: 100,
    }, ordinaryAgent);
    await secondModelsRequested;
    releaseSecondModels();
    const ordinaryReply = await ordinary;
    const ghost = await post(socketPath, '/status', {}, ghostStatusAgent);
    assert.equal(ghost.status, 200);
    const ghostState = ghost.body;
    assert.equal(ghostState.leases.expired, undefined, 'a deadline-expired session must never receive a lease');
    assert.equal(ghostState.assignments.expired, undefined, 'a deadline-expired session must never receive an assignment');

    assert.equal(ordinaryReply.status, 200, `ghost lease after 503 held the local slot: ${JSON.stringify(ordinaryReply.body)}`);
    assert.equal(ordinaryReply.body.target.id, 'local');
  } finally {
    releaseUsage?.();
    releaseFirstModels();
    releaseSecondModels();
    deadlineAgent.destroy();
    resumedStatusAgent.destroy();
    ordinaryAgent.destroy();
    ghostStatusAgent.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForChildExit(child);
      child.kill('SIGTERM');
      await exited;
    }
    await closeServer(models);
    await closeServer(usage);
    rmSync(home, { recursive: true, force: true });
  }
});

test('a deadline-expired quota failure cannot settle a lease after its shared plan lookup returns', { timeout: 5_000 }, async () => {
  let releaseUsage;
  const usageReleased = new Promise((resolve) => { releaseUsage = resolve; });
  let usageRequested;
  const usageRequestedPromise = new Promise((resolve) => { usageRequested = resolve; });
  const usage = http.createServer(async (request, response) => {
    assert.equal(request.url, '/usage');
    usageRequested();
    await usageReleased;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ windows: [{ id: 'wk', percent: 1, resetsAt: new Date(Date.now() + 60_000).toISOString(), active: true, severity: null }], lockedUntil: null }));
  });
  await new Promise((resolve) => usage.listen(0, '127.0.0.1', resolve));

  const home = mkdtempSync(join(tmpdir(), 'broker-handler-deadline-failure-'));
  const stateDir = join(home, '.local/share/opencode/model-routing');
  const configPath = join(home, 'config.json');
  const statePath = join(stateDir, 'broker.json');
  const socketPath = join(stateDir, 'broker.sock');
  const keyPath = join(home, 'usage-key');
  const resumedPath = join(home, 'usage-json-resumed');
  const preloadPath = join(home, 'mark-usage-json.cjs');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, 'fake-test-plan-usage-key\n', { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const fixtureLease = { sessionID: 'expired-failure', leaseID: 'lease-expired-failure', targetID: 'fixture-cloud', touchedAt: Date.now(), profile: 'auto', tier: 'worker' };
  writeFileSync(statePath, JSON.stringify({ version: 4, leases: { [fixtureLease.sessionID]: fixtureLease },
    assignments: { [fixtureLease.sessionID]: { ...fixtureLease } }, circuits: {}, cursors: {}, health: {}, budgets: {}, lastDecision: null, planUsage: {}, rebalances: {} }), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    targets: { 'fixture-cloud': { providerID: 'fixture', modelID: 'fixture-model', kind: 'cloud', context: 32768 } },
    tiers: { worker: ['fixture-cloud'] }, profiles: { auto: ['fixture-cloud'] }, slotWatch: { enabled: false }, burnWatch: { enabled: false },
    budgets: { fixture: { windows: [{ id: 'wk', periodMs: 604800000, meter: 'requests', capacity: 100 }],
      planUsage: { type: 'http', url: `http://127.0.0.1:${usage.address().port}/usage`, keyFile: keyPath } } },
  }));
  writeFileSync(preloadPath, [
    "const { writeFileSync } = require('node:fs');",
    'const fetch = globalThis.fetch;',
    'const target = process.env.OPENCODE_BROKER_TEST_USAGE_URL;',
    'const marker = process.env.OPENCODE_BROKER_TEST_USAGE_RESUMED;',
    'globalThis.fetch = async (...args) => {',
    '  const response = await fetch(...args);',
    '  if (String(args[0]) !== target) return response;',
    '  const json = response.json.bind(response);',
    '  response.json = async () => { const payload = await json(); setImmediate(() => writeFileSync(marker, "resumed")); return payload; };',
    '  return response;',
    '};',
  ].join('\n'));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  const child = spawn(process.execPath, ['--require', preloadPath, brokerScript, 'serve'], { env: {
    ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    OPENCODE_BROKER_CONFIG: configPath, OPENCODE_BROKER_LOCAL_MODELS_URL: 'http://127.0.0.1:9/v1/models',
    OPENCODE_BROKER_TEST_HANDLER_DEADLINE_MS: '250', OPENCODE_BROKER_TEST_USAGE_URL: `http://127.0.0.1:${usage.address().port}/usage`,
    OPENCODE_BROKER_TEST_USAGE_RESUMED: resumedPath,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening on ')) resolve(); });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
    });
    const failure = post(socketPath, '/failure', { sessionID: fixtureLease.sessionID, leaseID: fixtureLease.leaseID,
      targetID: fixtureLease.targetID, error: { statusCode: 429, message: 'fixture token-plan quota exhausted' } });
    await usageRequestedPromise;
    const failed = await failure;
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.deepEqual(failed.body, { error: 'broker handler deadline exceeded' });
    const baseline = readFileSync(statePath, 'utf8');

    releaseUsage();
    await waitFor('the expired failure handler to resume from the shared plan lookup', () => existsSync(resumedPath));
    const afterResume = readFileSync(statePath, 'utf8');
    const status = await post(socketPath, '/status', {});
    assert.equal(status.status, 200);
    assert.equal(afterResume, baseline, 'an expired failure must not write a provider circuit or settle its lease');
    assert.deepEqual(status.body.circuits, {}, 'the expired quota failure must not create a provider circuit');
    assert.equal(status.body.leases[fixtureLease.sessionID]?.leaseID, fixtureLease.leaseID, 'the expired failure must not settle its lease');
    assert.equal(status.body.assignments[fixtureLease.sessionID]?.settledFailure, undefined, 'the expired failure must not record settlement');
  } finally {
    releaseUsage?.();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForChildExit(child);
      child.kill('SIGTERM');
      await exited;
    }
    await closeServer(usage);
    rmSync(home, { recursive: true, force: true });
  }
});

test('a timed-out local lease cannot erase a successor lease attribution', { timeout: 5_000 }, async () => {
  let releaseFirstModels;
  const firstModelsReleased = new Promise((resolve) => { releaseFirstModels = resolve; });
  let releaseSecondModels;
  const secondModelsReleased = new Promise((resolve) => { releaseSecondModels = resolve; });
  let requestedFirstModels;
  const firstModelsRequested = new Promise((resolve) => { requestedFirstModels = resolve; });
  let requestedSecondModels;
  const secondModelsRequested = new Promise((resolve) => { requestedSecondModels = resolve; });
  let modelRequests = 0;
  const models = http.createServer(async (_request, response) => {
    modelRequests += 1;
    if (modelRequests === 1) {
      requestedFirstModels();
      await firstModelsReleased;
    } else if (modelRequests === 2) {
      requestedSecondModels();
      await secondModelsReleased;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'test-local', status: 'loaded' }] }));
  });
  await new Promise((resolve) => models.listen(0, '127.0.0.1', resolve));

  const home = mkdtempSync(join(tmpdir(), 'broker-handler-deadline-attribution-'));
  const configPath = join(home, 'config.json');
  const socketPath = join(home, '.local/share/opencode/model-routing/broker.sock');
  const localModelsURL = `http://127.0.0.1:${models.address().port}/v1/models`;
  const firstParsedMarkerPath = join(home, 'first-local-models-parsed');
  const preloadPath = join(home, 'mark-first-local-models-parse.cjs');
  writeFileSync(configPath, JSON.stringify({
    targets: { local: { providerID: 'llamacpp', modelID: 'test-local', kind: 'local', capacity: 1, context: 32768 } },
    tiers: { worker: ['local'] }, profiles: { local: ['local'] }, slotWatch: { enabled: false },
  }));
  mkdirSync(join(home, '.local/share/opencode/model-routing'), { recursive: true });
  writeFileSync(preloadPath, [
    "const { writeFileSync } = require('node:fs');",
    'const fetch = globalThis.fetch;',
    'const target = process.env.OPENCODE_BROKER_TEST_MARK_LOCAL_MODELS_URL;',
    'const marker = process.env.OPENCODE_BROKER_TEST_FIRST_LOCAL_MODELS_MARKER;',
    'let parsed = 0;',
    'globalThis.fetch = async (...args) => {',
    '  const response = await fetch(...args);',
    '  if (String(args[0]) !== target) return response;',
    '  const json = response.json.bind(response);',
    '  response.json = async () => {',
    '    const payload = await json();',
    '    parsed += 1;',
    "    if (parsed === 1) setImmediate(() => writeFileSync(marker, 'parsed'));",
    '    return payload;',
    '  };',
    '  return response;',
    '};',
  ].join('\n'));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  const child = spawn(process.execPath, ['--require', preloadPath, brokerScript, 'serve'], { env: {
    ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    OPENCODE_BROKER_CONFIG: configPath, OPENCODE_BROKER_LOCAL_MODELS_URL: localModelsURL,
    OPENCODE_BROKER_TEST_HANDLER_DEADLINE_MS: '250', OPENCODE_BROKER_TEST_MARK_LOCAL_MODELS_URL: localModelsURL,
    OPENCODE_BROKER_TEST_FIRST_LOCAL_MODELS_MARKER: firstParsedMarkerPath,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const firstAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const secondAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const statusAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const caller = { address: '192.168.50.1', model: 'deadline-successor' };
  try {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening on ')) resolve(); });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
    });

    const expired = post(socketPath, '/lease', {
      sessionID: 'expired-attribution', profile: 'local', tier: 'worker', localOnly: true, contextTokens: 100,
    }, firstAgent);
    await firstModelsRequested;
    const successor = post(socketPath, '/lease', {
      sessionID: 'successor-attribution', profile: 'local', tier: 'worker', localOnly: true, contextTokens: 100, caller,
    }, secondAgent);
    const expiredReply = await expired;
    assert.equal(expiredReply.status, 503);
    assert.deepEqual(expiredReply.body, { error: 'broker handler deadline exceeded' });
    await secondModelsRequested;

    // The old acquire resumes while B is waiting. Its cleanup must not clear B's request-local
    // caller or fallback resolver registration before B records its decision.
    releaseFirstModels();
    await waitFor('the first local-model fetch to parse after its request timed out', () => existsSync(firstParsedMarkerPath));
    releaseSecondModels();
    const successorReply = await successor;
    assert.equal(successorReply.status, 200, JSON.stringify(successorReply.body));
    assert.equal(successorReply.body.target.id, 'local');

    const status = await post(socketPath, '/status', {}, statusAgent);
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.lastDecision.caller, caller);
    assert.equal(status.body.lastDecision.registration?.compatible, true,
      'the successor decision must retain its fallback resolver registration');
  } finally {
    releaseFirstModels();
    releaseSecondModels();
    firstAgent.destroy();
    secondAgent.destroy();
    statusAgent.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForChildExit(child);
      child.kill('SIGTERM');
      await exited;
    }
    await closeServer(models);
    rmSync(home, { recursive: true, force: true });
  }
});
