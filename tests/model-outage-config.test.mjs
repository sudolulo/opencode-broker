import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOutagePolicy, DISABLED_OUTAGES, scopeID, membershipIDs } from '../lib/outage-policy.js';
import { matchModelRole } from '../lib/model-roles.js';
import { makeTargets, makePolicy } from './helpers/model-outages.mjs';
const env = () => ({ targets: makeTargets(), tiers: {}, profiles: {}, fallbacks: {},
  profileFallbacks: {}, rawMemberships: {} });
test('missing policy defaults disabled and enabled policy validates all memberships and concrete scopes', () => {
  assert.equal(normalizeOutagePolicy(undefined, env()).enabled, false);
  assert.equal(normalizeOutagePolicy(makePolicy(), env()).expectedScopePolicies['openai/sol/standard'].probe.tokenMode, 'request-time-only');
  for (const name of ['tiers', 'profiles', 'fallbacks', 'profileFallbacks', 'rawMemberships']) {
    assert.throws(() => normalizeOutagePolicy(makePolicy(), { ...env(), [name]: { build: [['claude-opus-5']] } }), /ordinary/);
  }
  for (const bad of ['missing', 'claude-opus-5-5', 'gpt-flagship', 'claude-opus-5-fast']) {
    const p = makePolicy(); p.mappings['claude-opus-5-5'] = [bad];
    assert.throws(() => normalizeOutagePolicy(p, env()), /mapping/);
  }
  const p = makePolicy(); p.expectedScopePolicies['openai/sol/standard'].verified = true;
  assert.throws(() => normalizeOutagePolicy(p, env()), /scope/);
});

// ---- strictness beyond the shared fixture test ----------------------------------------------

test('disabled and absent policies return the frozen disabled constant', () => {
  assert.equal(normalizeOutagePolicy(undefined, env()), DISABLED_OUTAGES);
  assert.equal(normalizeOutagePolicy(null, env()), DISABLED_OUTAGES);
  assert.equal(normalizeOutagePolicy({ enabled: false }, env()), DISABLED_OUTAGES);
  assert.ok(Object.isFrozen(DISABLED_OUTAGES));
  for (const enabled of ['true', 1, undefined]) {
    assert.throws(() => normalizeOutagePolicy({ ...makePolicy(), enabled }, env()), /enabled/);
  }
});

test('enabled policy derives primaryScope and returns frozen exact route values', () => {
  const policy = normalizeOutagePolicy(makePolicy(), env());
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.primaryScope, makePolicy().primaryScope);
  assert.deepEqual(policy.mappings, makePolicy().mappings);
  assert.deepEqual(policy.incidentAliases, makePolicy().incidentAliases);
  assert.deepEqual(policy.expectedScopePolicies, makePolicy().expectedScopePolicies);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.mappings['claude-opus-5-5']));
  assert.ok(Object.isFrozen(policy.expectedScopePolicies['anthropic/opus/standard'].probe));
  // primaryScope is derived; omitting it from raw config is the normal deployed shape.
  const raw = makePolicy(); delete raw.primaryScope;
  assert.deepEqual(normalizeOutagePolicy(raw, env()).primaryScope, makePolicy().primaryScope);
});

test('unknown or contradictory policy fields are rejected', () => {
  const extra = makePolicy(); extra.verified = true;
  assert.throws(() => normalizeOutagePolicy(extra, env()), /unknown/);
  const scope = makePolicy(); scope.primaryScope['claude-opus-5-5'] = 'anthropic/opus/fast';
  assert.throws(() => normalizeOutagePolicy(scope, env()), /primaryScope/);
  const probe = makePolicy(); probe.expectedScopePolicies['anthropic/opus/standard'].probe.accountID = 'x';
  assert.throws(() => normalizeOutagePolicy(probe, env()), /scope/);
  const stray = makePolicy(); stray.incidentAliases['claude-opus-5'] = ['Claude Opus 5'];
  assert.throws(() => normalizeOutagePolicy(stray, env()), /aliases/);
  const uncovered = makePolicy(); uncovered.expectedScopePolicies['anthropic/haiku/standard'] =
    uncovered.expectedScopePolicies['anthropic/opus/standard'];
  assert.throws(() => normalizeOutagePolicy(uncovered, env()), /scope/);
});

test('every concrete route value is pinned per provider', () => {
  const cases = [
    ['anthropic/opus/standard', 'connectionID', 'llm-auth-proxy/openai'],
    ['anthropic/opus/standard', 'authMode', 'api-key'],
    ['anthropic/opus/standard', 'transport', 'responses'],
    ['anthropic/opus/standard', 'product', 'console'],
    ['anthropic/opus/standard', 'speed', 'fast'],
    ['openai/sol/standard', 'providerID', 'anthropic'],
    ['openai/sol/standard', 'authMode', 'api-key'],
    ['openai/sol/standard', 'product', 'api'],
  ];
  for (const [id, key, value] of cases) {
    const p = makePolicy(); p.expectedScopePolicies[id][key] = value;
    assert.throws(() => normalizeOutagePolicy(p, env()), /scope/, `${id}.${key}`);
  }
  const token = makePolicy(); token.expectedScopePolicies['openai/sol/standard'].probe.tokenMode = 'max_tokens-total-256';
  assert.throws(() => normalizeOutagePolicy(token, env()), /scope/);
  const api = makePolicy(); api.expectedScopePolicies['anthropic/fable/standard'].probe.api = 'responses';
  assert.throws(() => normalizeOutagePolicy(api, env()), /scope/);
});

test('mappings reject duplicates, cross-speed reserves, reserve heads, empty lists, and alias-marked targets', () => {
  const dup = makePolicy(); dup.mappings['claude-opus-5-5'] = ['claude-opus-5', 'claude-opus-5'];
  assert.throws(() => normalizeOutagePolicy(dup, env()), /mapping/);
  // A standard reserve offered to the fast head is refused on scope: opus/standard is not opus/fast.
  const crossSpeed = makePolicy(); crossSpeed.mappings['claude-opus-5-5'] = ['claude-opus-5'];
  crossSpeed.mappings['claude-opus-5-5-fast'] = ['claude-opus-5'];
  assert.throws(() => normalizeOutagePolicy(crossSpeed, env()), /mapping/);
  const empty = makePolicy(); empty.mappings['claude-fable-5-1'] = [];
  assert.throws(() => normalizeOutagePolicy(empty, env()), /mapping/);
  const chained = makePolicy(); chained.mappings['claude-opus-5'] = ['claude-opus-4-8'];
  chained.mappings['claude-opus-5-5'] = ['claude-opus-5'];
  assert.throws(() => normalizeOutagePolicy(chained, env()), /mapping/);
  const targets = makeTargets(); targets['claude-opus-5-5'] = { ...targets['claude-opus-5-5'], canonicalModelID: 'claude-opus-5-5' };
  assert.throws(() => normalizeOutagePolicy(makePolicy(), { ...env(), targets }), /mapping/);
  const reserveAlias = makeTargets(); reserveAlias['claude-opus-5'] = { ...reserveAlias['claude-opus-5'], canonicalModelID: 'claude-opus-5-5' };
  assert.throws(() => normalizeOutagePolicy(makePolicy(), { ...env(), targets: reserveAlias }), /mapping/);
  const unmanaged = makeTargets(); delete unmanaged['claude-fable-5-1'].family;
  assert.throws(() => normalizeOutagePolicy(makePolicy(), { ...env(), targets: unmanaged }), /mapping/);
});

test('a providerID naming an inherited Object property gets no route', () => {
  // ROUTES.constructor is Object's constructor, so a bare ROUTES[providerID] lookup hands back
  // a truthy "route" whose pinned values are all undefined -- and a scope restating those
  // undefined values would then match it.
  const targets = {
    'ctor-head': { id: 'ctor-head', providerID: 'constructor', modelID: 'ctor-head', kind: 'cloud', family: 'x', speed: 'standard' },
    'ctor-old': { id: 'ctor-old', providerID: 'constructor', modelID: 'ctor-old', kind: 'cloud', family: 'x', speed: 'standard' },
  };
  const policy = { enabled: true, mappings: { 'ctor-head': ['ctor-old'] },
    incidentAliases: { 'ctor-head': ['Ctor Head'] },
    expectedScopePolicies: { 'constructor/x/standard': { providerID: 'constructor', speed: 'standard',
      connectionID: undefined, authMode: undefined, transport: undefined, product: undefined,
      probe: { api: undefined, tokenMode: undefined } } } };
  assert.throws(() => normalizeOutagePolicy(policy, { ...env(), targets }), /scope/);
});

test('incident aliases that are blank after trim or carry a control character are rejected', () => {
  for (const alias of ['   ', 'Claude\tOpus 5.5', 'Claude Opus\u0000', 'Claude Opus\u007f', 'Claude\u001bOpus']) {
    const p = makePolicy(); p.incidentAliases['claude-opus-5-5'] = [alias];
    assert.throws(() => normalizeOutagePolicy(p, env()), /aliases/, JSON.stringify(alias));
  }
});

test('heads may stay in ordinary membership and helpers expose ids and logical scopes', () => {
  const ordinary = { build: ['claude-opus-5-5'], smart: [['gpt-6-1-sol']] };
  assert.doesNotThrow(() => normalizeOutagePolicy(makePolicy(), { ...env(), tiers: ordinary, rawMemberships: { tiers: ordinary } }));
  assert.deepEqual(membershipIDs({ a: ['x', ['y']], b: 'z', c: 3, d: null }), ['x', 'y', 'z']);
  assert.equal(scopeID(makeTargets()['gpt-flagship']), 'openai/sol/standard');
});

// ---- the loader: lib/config.js evaluates once per import, so cache-bust per case ------------

const loadConfig = async (document) => {
  const dir = mkdtempSync(join(tmpdir(), 'outage-config-'));
  const previous = process.env.OPENCODE_BROKER_CONFIG;
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(document));
    process.env.OPENCODE_BROKER_CONFIG = path;
    return await import(`../lib/config.js?outage=${encodeURIComponent(dir)}`);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BROKER_CONFIG;
    else process.env.OPENCODE_BROKER_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};
const heads = ['claude-opus-5-5', 'claude-opus-5-5-fast', 'claude-sonnet-5-5', 'claude-fable-5-1', 'gpt-6-1-sol'];

test('loader without modelOutages keeps legacy targets and a disabled policy', async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig({
    targets: { plain: { providerID: 'anthropic', modelID: 'claude-x', kind: 'cloud' } },
    tiers: { build: ['plain'] },
  });
  assert.equal(CONFIG_ERROR, null);
  assert.equal(CONFIG.modelOutages, DISABLED_OUTAGES);
  assert.deepEqual(CONFIG.targets.plain, { id: 'plain', providerID: 'anthropic', modelID: 'claude-x', kind: 'cloud', capacity: null });
});

test('loader preserves validated family, speed, real release date and explicit alias marker only', async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig({ targets: {
    head: { providerID: 'anthropic', modelID: 'claude-opus-5-5', kind: 'cloud', family: 'opus', speed: 'standard', releaseDate: '2026-02-28' },
    alias: { providerID: 'anthropic', modelID: 'claude-opus-5-5', kind: 'cloud', family: 'opus', speed: 'standard', canonicalModelID: 'claude-opus-5-5' },
    'bad-date': { providerID: 'anthropic', modelID: 'm1', kind: 'cloud', releaseDate: '2026-02-30' },
    'bad-shape': { providerID: 'anthropic', modelID: 'm2', kind: 'cloud', releaseDate: '2026-2-1', speed: 'turbo', family: 'Opus Big', canonicalModelID: '' },
  } });
  assert.equal(CONFIG_ERROR, null);
  assert.equal(CONFIG.targets.head.family, 'opus');
  assert.equal(CONFIG.targets.head.speed, 'standard');
  assert.equal(CONFIG.targets.head.releaseDate, '2026-02-28');
  assert.equal('canonicalModelID' in CONFIG.targets.head, false);
  assert.equal(CONFIG.targets.alias.canonicalModelID, 'claude-opus-5-5');
  assert.equal('releaseDate' in CONFIG.targets.alias, false);
  assert.equal('releaseDate' in CONFIG.targets['bad-date'], false);
  for (const key of ['releaseDate', 'speed', 'family', 'canonicalModelID']) assert.equal(key in CONFIG.targets['bad-shape'], false, key);
});

test('loader accepts the complete fixture policy with reserves only in definitions', async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig({ targets: makeTargets(), tiers: { build: heads },
    modelOutages: (({ primaryScope, ...rest }) => rest)(makePolicy()) });
  assert.equal(CONFIG_ERROR, null);
  assert.equal(CONFIG.modelOutages.enabled, true);
  assert.deepEqual(CONFIG.modelOutages.primaryScope, makePolicy().primaryScope);
  assert.equal(CONFIG.targets['gpt-flagship'].modelID, 'gpt-6-sol');
  assert.equal('canonicalModelID' in CONFIG.targets['claude-opus-5-5'], false);
});

test('loader reports an invalid policy on CONFIG_ERROR, disables outages, and keeps routing', async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig({ targets: makeTargets(),
    tiers: { build: [...heads, 'claude-opus-5'] }, modelOutages: makePolicy() });
  assert.match(String(CONFIG_ERROR), /modelOutages/);
  assert.match(String(CONFIG_ERROR), /ordinary/);
  assert.equal(CONFIG.modelOutages, DISABLED_OUTAGES);
  assert.ok(CONFIG.tiers.build.includes('claude-opus-5-5'));
});

test('a reserve in a raw membership the loader drops still fails the policy', async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig({ targets: makeTargets(),
    profiles: { 'Not A Profile': ['claude-sonnet-5'] }, modelOutages: makePolicy() });
  assert.match(String(CONFIG_ERROR), /ordinary/);
  assert.equal(CONFIG.modelOutages.enabled, false);
});

test('invalid present target metadata fails an enabled policy closed', async () => {
  const targets = makeTargets(); targets.stray = { providerID: 'anthropic', modelID: 'x', kind: 'cloud', releaseDate: 'soon' };
  const { CONFIG, CONFIG_ERROR } = await loadConfig({ targets, modelOutages: makePolicy() });
  assert.match(String(CONFIG_ERROR), /releaseDate/);
  assert.equal(CONFIG.modelOutages.enabled, false);
});

test('loader rejects a reserve listed in fallbacks.build and leaves outages disabled', async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig({ targets: makeTargets(), tiers: { build: heads },
    fallbacks: { build: [['claude-opus-5']] }, modelOutages: makePolicy() });
  assert.match(String(CONFIG_ERROR), /modelOutages/);
  assert.match(String(CONFIG_ERROR), /ordinary/);
  assert.equal(CONFIG.modelOutages, DISABLED_OUTAGES);
});

test('loader rejects a reserve listed in a declared profile fallback and leaves outages disabled', async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig({ targets: makeTargets(), profiles: { work: heads },
    profileFallbacks: { work: [['claude-sonnet-5']] }, modelOutages: makePolicy() });
  // The profile is real and may leave the LAN, so the reserve survives into the NORMALIZED rungs too.
  assert.deepEqual(CONFIG.profileFallbacks.work, [['claude-sonnet-5']]);
  assert.match(String(CONFIG_ERROR), /modelOutages/);
  assert.match(String(CONFIG_ERROR), /ordinary/);
  assert.equal(CONFIG.modelOutages, DISABLED_OUTAGES);
});

test('loader with modelOutages enabled:false sets no CONFIG_ERROR and stays disabled', async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig({ targets: makeTargets(), tiers: { build: heads },
    modelOutages: { enabled: false } });
  assert.equal(CONFIG_ERROR, null);
  assert.equal(CONFIG.modelOutages, DISABLED_OUTAGES);
});

test('without modelOutages, family/speed/releaseDate metadata does not change routing-relevant config or role match', async () => {
  const strip = (targets) => Object.fromEntries(Object.entries(targets)
    .map(([id, { family, speed, releaseDate, ...rest }]) => [id, rest]));
  const dated = makeTargets(); dated['claude-opus-5-5'].releaseDate = '2026-02-28';
  const layout = { tiers: { build: heads, smart: ['claude-opus-4-8'] }, fallbacks: { build: [['claude-sonnet-5']] } };
  const withMeta = await loadConfig({ targets: dated, ...layout });
  const without = await loadConfig({ targets: strip(dated), ...layout });
  for (const loaded of [withMeta, without]) {
    assert.equal(loaded.CONFIG_ERROR, null);
    assert.equal(loaded.CONFIG.modelOutages, DISABLED_OUTAGES);
  }
  assert.equal(withMeta.CONFIG.targets['claude-opus-5-5'].family, 'opus');
  assert.deepEqual(withMeta.CONFIG.tiers, without.CONFIG.tiers);
  assert.deepEqual(withMeta.CONFIG.fallbacks, without.CONFIG.fallbacks);
  assert.deepEqual(withMeta.CONFIG.profiles, without.CONFIG.profiles);
  assert.deepEqual(strip(withMeta.CONFIG.targets), strip(without.CONFIG.targets));
  // lib/policy-targets.js roleKeyForTarget (not exported) passes target.family into
  // matchModelRole; mirror that exact call. The policy family "opus" is not a role catalog
  // family ("claude-opus"), so the role still comes from the id pattern, unchanged.
  const roleOf = (target, roles) => matchModelRole(target.providerID, { id: target.modelID, family: target.family }, roles);
  for (const id of Object.keys(dated)) {
    const a = roleOf(withMeta.CONFIG.targets[id], withMeta.CONFIG.modelRoles);
    const b = roleOf(without.CONFIG.targets[id], without.CONFIG.modelRoles);
    assert.equal(a.status, 'known', id);
    assert.equal(a.status, b.status, id);
    assert.equal(a.roleKey, b.roleKey, id);
  }
  assert.equal(roleOf(withMeta.CONFIG.targets['claude-opus-4-8'], withMeta.CONFIG.modelRoles).roleKey, 'anthropic:claude-opus');
});
