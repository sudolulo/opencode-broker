import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// lib/config.js reads its file once at import, so every case loads it in a fresh child process
// with a private HOME, every XDG directory, its own config path, routing dir and socket path.
// Only PATH is inherited: no host credentials, config, wallets or network endpoints are visible.
const root = new URL('..', import.meta.url).pathname;
const configURL = new URL('../lib/config.js', import.meta.url).href;
const PIN_A = 'a'.repeat(64);
const PIN_B = 'b'.repeat(64);

const BASE = Object.freeze({
  targets: {
    'api-sonnet': { providerID: 'anthropic-api', modelID: 'claude-sonnet-x', kind: 'cloud' },
    'api-opus': { providerID: 'anthropic-api', modelID: 'claude-opus-x', kind: 'cloud' },
    oauth: { providerID: 'anthropic', modelID: 'claude-sonnet-4', kind: 'cloud' },
  },
  profiles: { 'api-reserve': ['api-sonnet', 'api-opus'], ordinary: ['oauth'] },
  manualApiTargets: { 'api-sonnet': ['api-reserve'], 'api-opus': ['api-reserve'] },
  tiers: { worker: ['oauth'], smart: ['oauth'] },
});

const loadConfig = (config) => {
  const home = mkdtempSync(join(tmpdir(), 'api-continuation-profile-'));
  try {
    const dirs = Object.fromEntries(['config', 'data', 'state', 'cache', 'runtime', 'routing'].map((name) => {
      const path = join(home, name);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      return [name, path];
    }));
    const configPath = join(dirs.config, 'broker.json');
    if (config !== null) writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const script = `
      const m = await import(${JSON.stringify(configURL)});
      const policy = m.CONFIG.apiContinuation;
      const frozen = (v) => v === null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(frozen));
      process.stdout.write(JSON.stringify({ policy, frozen: frozen(policy), error: m.CONFIG_ERROR,
        apiError: m.API_CONTINUATION_CONFIG_ERROR, fallbackDelays: m.CONFIG.profileFallbackAfterMs,
        tiers: m.CONFIG.tiers, manual: m.CONFIG.manualApiTargets, trusted: m.CONFIG.trustedSubscriptionProviders,
        keys: Object.keys(m.CONFIG) }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_STATE_HOME: dirs.state,
        XDG_CACHE_HOME: dirs.cache,
        XDG_RUNTIME_DIR: dirs.runtime,
        OPENCODE_BROKER_CONFIG: configPath,
        OPENCODE_MODEL_ROUTING_DIR: dirs.routing,
        OPENCODE_MODEL_BROKER_SOCKET: join(dirs.routing, 'broker.sock'),
      },
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    return { ...JSON.parse(result.stdout), stderr: result.stderr, configPath };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const DEFAULT_KEYS = ['enabled', 'sourceProviders', 'targets', 'spendPolicyHashes', 'grantTTLms', 'revision'];

test('absent apiContinuation is the disabled default and leaves legacy config unchanged', () => {
  const loaded = loadConfig(BASE);
  assert.equal(loaded.error, null);
  // An ABSENT block is legacy exactly: no API-continuation config error flag.
  assert.equal(loaded.apiError, null);
  assert.deepEqual(Object.keys(loaded.policy), DEFAULT_KEYS);
  assert.equal(loaded.policy.enabled, false);
  assert.deepEqual(loaded.policy.sourceProviders, []);
  assert.deepEqual(loaded.policy.targets, {});
  assert.deepEqual(loaded.policy.spendPolicyHashes, {});
  assert.equal(loaded.policy.grantTTLms, 300000);
  assert.match(loaded.policy.revision, /^[0-9a-f]{64}$/);
  assert.ok(loaded.frozen);
  assert.deepEqual(loaded.manual, {
    'api-opus': { providerID: 'anthropic-api', modelID: 'claude-opus-x', profiles: ['api-reserve'] },
    'api-sonnet': { providerID: 'anthropic-api', modelID: 'claude-sonnet-x', profiles: ['api-reserve'] },
  });
  assert.deepEqual(loaded.tiers.worker, ['oauth']);
  // The only new CONFIG field is apiContinuation.
  const withBlock = loadConfig({ ...BASE, apiContinuation: { enabled: false } });
  assert.deepEqual(withBlock.keys, loaded.keys);
  assert.ok(loaded.keys.includes('apiContinuation'));
  assert.deepEqual(withBlock.policy, loaded.policy);
  // An absent config file also yields the disabled default without any error.
  const absent = loadConfig(null);
  assert.equal(absent.error, null);
  assert.equal(absent.policy.enabled, false);
  assert.equal(absent.policy.revision, loadConfig({}).policy.revision);
});

test('a valid block normalizes against the real manual registry and generation tiers', () => {
  const loaded = loadConfig({ ...BASE, apiContinuation: {
    enabled: true, sourceProviders: ['openai', 'anthropic'], targets: { 'api-sonnet': ['smart', 'worker'] },
    spendPolicyHashes: { 'api-sonnet': PIN_A, 'api-opus': PIN_B }, grantTTLms: 90000,
  } });
  assert.equal(loaded.error, null, loaded.stderr);
  assert.deepEqual(loaded.policy, {
    enabled: true, sourceProviders: ['anthropic', 'openai'], targets: { 'api-sonnet': ['smart', 'worker'] },
    spendPolicyHashes: { 'api-opus': PIN_B, 'api-sonnet': PIN_A }, grantTTLms: 90000, revision: loaded.policy.revision,
  });
  assert.ok(loaded.frozen);
  // The source allowlist is explicit: trustedSubscriptionProviders is not required or altered.
  assert.deepEqual(loaded.trusted, []);
});

test('a disabled block keeps manual target pins for split manual grants', () => {
  const loaded = loadConfig({ ...BASE, apiContinuation: { enabled: false, spendPolicyHashes: { 'api-opus': PIN_B } } });
  assert.equal(loaded.error, null, loaded.stderr);
  assert.equal(loaded.policy.enabled, false);
  assert.deepEqual(loaded.policy.spendPolicyHashes, { 'api-opus': PIN_B });
});

test('an invalid block is reported on CONFIG_ERROR and fails closed to the disabled default', () => {
  const disabled = loadConfig(BASE).policy;
  const marker = 'f'.repeat(63) + 'Z';
  const invalid = {
    unknownKey: { enabled: true, sourceProviders: ['anthropic'], quotaEvidence: true },
    paidSource: { enabled: true, sourceProviders: ['anthropic-api'], targets: {}, spendPolicyHashes: {} },
    missingPin: { enabled: true, sourceProviders: ['anthropic'], targets: { 'api-sonnet': ['smart'] } },
    badPin: { enabled: true, sourceProviders: ['anthropic'], targets: { 'api-sonnet': ['smart'] }, spendPolicyHashes: { 'api-sonnet': marker } },
    unregistered: { enabled: true, sourceProviders: ['anthropic'], targets: { oauth: ['smart'] }, spendPolicyHashes: {} },
    classifierTier: { enabled: true, sourceProviders: ['anthropic'], targets: { 'api-sonnet': ['classifier'] }, spendPolicyHashes: { 'api-sonnet': PIN_A } },
    badTTL: { grantTTLms: 300001 },
    notObject: 'enabled',
  };
  for (const [name, apiContinuation] of Object.entries(invalid)) {
    const loaded = loadConfig({ ...BASE, apiContinuation });
    assert.ok(loaded.error, name);
    assert.ok(loaded.error.includes(loaded.configPath), name);
    assert.match(loaded.error, /apiContinuation/, name);
    assert.ok(!loaded.error.includes(marker), `${name} echoes a pin value`);
    assert.match(loaded.stderr, /API CONTINUATION POLICY REJECTED/, name);
    assert.deepEqual(loaded.policy, disabled, name);
    assert.ok(loaded.frozen, name);
    // The PRESENT-but-invalid block is flagged separately, so the broker can fail every
    // registered manual target closed instead of falling back to legacy unpinned manual.
    assert.equal(typeof loaded.apiError, 'string', name);
    assert.match(loaded.apiError, /apiContinuation/, name);
    assert.ok(!loaded.apiError.includes(marker), `${name} flag echoes a pin value`);
    // Ordinary routing and the manual registry are unchanged by the rejected block.
    assert.deepEqual(loaded.tiers.worker, ['oauth'], name);
    assert.deepEqual(Object.keys(loaded.manual).sort(), ['api-opus', 'api-sonnet'], name);
  }
});
