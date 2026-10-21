import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const broker = join(root, 'bin/opencode-broker');
const post = (socketPath, path, body) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const request = http.request({ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (response) => {
    let text = '';
    response.on('data', (chunk) => { text += chunk; });
    response.on('end', () => {
      const value = text ? JSON.parse(text) : {};
      if (response.statusCode >= 200 && response.statusCode < 300) resolve(value);
      else reject(new Error(value.error ?? `status ${response.statusCode}`));
    });
  });
  request.on('error', reject);
  request.end(payload);
});

const start = async (home, config) => {
  const configPath = join(home, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const routing = join(home, '.local/share/opencode/model-routing');
  mkdirSync(routing, { recursive: true });
  writeFileSync(join(routing, 'resolvable-models.json'), JSON.stringify({ updatedAt: Date.now(), models: ['paid-test-provider/test-sonnet', 'oauth/test-oauth'] }));
  const socketPath = join(routing, 'broker.sock');
  const child = spawn(process.execPath, [broker, 'serve'], { cwd: root, env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath, OPENCODE_BROKER_LOCAL_MODELS_URL: 'http://127.0.0.1:9/v1/models' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening on ')) resolve(); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`broker exited ${code}: ${stderr}`)));
  });
  return { child, socketPath };
};

const stop = async (child) => {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
};

test('dedicated API profile leases without auth.json but auto and stale paid leases fail closed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'manual-api-profile-'));
  let child;
  let socketPath;
  try {
    ({ child, socketPath } = await start(home, {
      targets: {
        reserve: { providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'cloud' },
        oauth: { providerID: 'oauth', modelID: 'test-oauth', kind: 'cloud' },
      },
      profiles: { 'api-reserve': ['reserve'], ordinary: ['oauth'] },
      manualApiTargets: { reserve: ['api-reserve'] },
      tiers: { worker: ['oauth'] },
    }));
    const explicit = await post(socketPath, '/lease', {
      sessionID: 'reserve-session',
      profile: 'api-reserve',
      tier: 'worker',
      providers: ['paid-test-provider'],
      target: { requiresSpendBudget: false, billingClass: 'subscription' },
      metadata: { requiresSpendBudget: false, billingClass: 'subscription' },
    });
    assert.equal(explicit.target.id, 'reserve');
    assert.equal(explicit.target.requiresSpendBudget, true);
    assert.equal(explicit.target.billingClass, 'manual-api');
    const verified = await post(socketPath, '/lease/verify', {
      sessionID: 'reserve-session', leaseID: explicit.leaseID,
    });
    assert.equal(verified.held, true);
    assert.equal(verified.target.requiresSpendBudget, true);
    assert.equal(verified.target.billingClass, 'manual-api');
    await assert.rejects(post(socketPath, '/lease', { sessionID: 'reserve-session', profile: 'auto', tier: 'worker', providers: ['paid-test-provider'] }), /no readable auth\.json|no eligible/);
    await assert.rejects(post(socketPath, '/lease', { sessionID: 'ordinary', profile: 'auto', tier: 'worker' }), /no readable auth\.json/);
    await assert.rejects(post(socketPath, '/lease', { sessionID: 'ordinary-profile', profile: 'ordinary', tier: 'worker' }), /no readable auth\.json/);
    await assert.rejects(post(socketPath, '/lease', { sessionID: 'local-only', profile: 'api-reserve', tier: 'worker', localOnly: true }), /no eligible|busy or unavailable/);
    await assert.rejects(post(socketPath, '/lease', { sessionID: 'unrelated', profile: 'api-reserve', tier: 'worker', providers: ['unrelated'] }), /no eligible|busy or unavailable/);
  } finally {
    if (child) await stop(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test('ordinary leases cannot self-attest paid billing metadata', async () => {
  const home = mkdtempSync(join(tmpdir(), 'manual-api-attestation-'));
  let child;
  let socketPath;
  try {
    const authDir = join(home, '.local/share/opencode');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({ oauth: { type: 'oauth' } }));
    ({ child, socketPath } = await start(home, {
      targets: {
        reserve: { providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'cloud' },
        oauth: { providerID: 'oauth', modelID: 'test-oauth', kind: 'cloud' },
      },
      profiles: { 'api-reserve': ['reserve'], ordinary: ['oauth'] },
      manualApiTargets: { reserve: ['api-reserve'] },
      tiers: { worker: ['oauth'] },
    }));
    const ordinary = await post(socketPath, '/lease', {
      sessionID: 'ordinary-session', profile: 'ordinary', tier: 'worker', providers: ['oauth'],
      target: { requiresSpendBudget: true, billingClass: 'manual-api' },
      metadata: { requiresSpendBudget: true, billingClass: 'manual-api' },
    });
    assert.equal(ordinary.target.id, 'oauth');
    assert.equal(Object.hasOwn(ordinary.target, 'requiresSpendBudget'), false);
    assert.equal(Object.hasOwn(ordinary.target, 'billingClass'), false);
    const verified = await post(socketPath, '/lease/verify', {
      sessionID: 'ordinary-session', leaseID: ordinary.leaseID,
    });
    assert.equal(verified.held, true);
    assert.equal(Object.hasOwn(verified.target, 'requiresSpendBudget'), false);
    assert.equal(Object.hasOwn(verified.target, 'billingClass'), false);
  } finally {
    if (child) await stop(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test('a manual primary with an OAuth fallback revalidates stale subscription admission', async () => {
  const home = mkdtempSync(join(tmpdir(), 'manual-api-mixed-profile-'));
  let child;
  try {
    const authDir = join(home, '.local/share/opencode');
    const authPath = join(authDir, 'auth.json');
    const config = {
      targets: {
        reserve: { providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'cloud' },
        oauth: { providerID: 'oauth', modelID: 'test-oauth', kind: 'cloud' },
      },
      profiles: { 'api-reserve': ['reserve'] },
      profileFallbacks: { 'api-reserve': [['oauth']] },
      profileCloudEgress: ['api-reserve'],
      manualApiTargets: { reserve: ['api-reserve'] },
      tiers: { worker: ['oauth'] },
    };
    mkdirSync(authDir, { recursive: true });
    writeFileSync(authPath, JSON.stringify({ oauth: { type: 'oauth' } }));
    const started = await start(home, config);
    child = started.child;
    const auth = Buffer.from(JSON.stringify({ oauth: { type: 'oauth' } }));
    const stat = statSync(authPath);
    await post(started.socketPath, '/inventory', {
      providers: { oauth: { authType: 'oauth', connected: true, admission: 'subscription', models: 1 } },
      authRevision: `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash('sha256').update(auth).digest('hex')}`,
      configFingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    });
    rmSync(authPath);
    await assert.rejects(
      post(started.socketPath, '/lease', {
        sessionID: 'mixed-stale-oauth', profile: 'api-reserve', tier: 'worker', providers: ['oauth'],
      }),
      /no readable auth\.json; cloud routing needs credentials/,
    );
  } finally {
    if (child) await stop(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test('/lease/verify keeps a held lease and its plain identity when the catalog drops its effortCeiling variant', async () => {
  const home = mkdtempSync(join(tmpdir(), 'manual-api-verify-drift-'));
  let child;
  try {
    const authDir = join(home, '.local/share/opencode');
    const authPath = join(authDir, 'auth.json');
    const config = {
      targets: {
        reserve: { providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'cloud', effortCeiling: 'high' },
        oauth: { providerID: 'oauth', modelID: 'test-oauth', kind: 'cloud' },
      },
      profiles: { 'api-reserve': ['reserve'] },
      manualApiTargets: { reserve: ['api-reserve'] },
      tiers: { worker: ['oauth'] },
    };
    mkdirSync(authDir, { recursive: true });
    const auth = Buffer.from(JSON.stringify({ oauth: { type: 'oauth' } }));
    writeFileSync(authPath, auth);
    const started = await start(home, config);
    child = started.child;
    const stat = statSync(authPath);
    const publish = (modelVariants) => post(started.socketPath, '/inventory', {
      providers: {}, modelVariants,
      authRevision: `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash('sha256').update(auth).digest('hex')}`,
      configFingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    });
    assert.equal((await publish({ 'paid-test-provider/test-sonnet': ['low', 'medium', 'high'] })).accepted, true);
    const lease = await post(started.socketPath, '/lease', {
      sessionID: 'drift-session', profile: 'api-reserve', tier: 'worker', providers: ['paid-test-provider'],
    });
    assert.equal(lease.target.id, 'reserve');
    const expected = {
      id: 'reserve', kind: 'cloud', model: { providerID: 'paid-test-provider', id: 'test-sonnet' },
      requiresSpendBudget: true, billingClass: 'manual-api',
    };
    const before = await post(started.socketPath, '/lease/verify', { sessionID: 'drift-session', leaseID: lease.leaseID });
    assert.equal(before.held, true);
    // The refreshed catalog no longer advertises the ceiling variant. Verification is
    // about an EXISTING grant, not a fresh variant resolution, so it must not fail.
    const refreshed = await publish({ 'paid-test-provider/test-sonnet': ['low'] });
    assert.equal(refreshed.accepted, true);
    assert.deepEqual(refreshed.inventory.modelVariants, { 'paid-test-provider/test-sonnet': ['low'] });
    const after = await post(started.socketPath, '/lease/verify', { sessionID: 'drift-session', leaseID: lease.leaseID });
    assert.equal(after.held, true);
    assert.equal(after.leaseID, lease.leaseID);
    assert.deepEqual(after.target, expected);
    assert.equal(after.expectedCredentialInstance, null);
    assert.equal(after.generation, null);
    // Identity is the same plain shape before and after the catalog changed.
    assert.deepEqual(before.target, expected);
  } finally {
    if (child) await stop(child);
    rmSync(home, { recursive: true, force: true });
  }
});

for (const targetID of ['constructor', 'toString', '__proto__']) test(`unregistered prototype-named target ${targetID} does not bypass cloud auth`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'manual-api-prototype-'));
  let child;
  try {
    const started = await start(home, {
      targets: { [targetID]: { providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'cloud' } },
      profiles: { prototype: [targetID] },
      manualApiTargets: {},
      tiers: { worker: [] },
    });
    child = started.child;
    await assert.rejects(
      post(started.socketPath, '/lease', { sessionID: `prototype-${targetID}`, profile: 'prototype', tier: 'worker', providers: ['paid-test-provider'] }),
      /no readable auth\.json; cloud routing needs credentials|all lightweight routing targets are busy or unavailable/,
    );
  } finally {
    if (child) await stop(child);
    rmSync(home, { recursive: true, force: true });
  }
});
