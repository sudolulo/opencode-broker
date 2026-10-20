import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  authorizedReserveIDs, automaticAllowed, buildCanonicalHeads, markManagedOutageScope, ordinaryAllowed,
  selectAutomatic, snapshotOutageContext, stagedCandidateHeads,
} from '../lib/outage-policy.js';
import { emptyOutages, reduceOutages } from '../lib/model-outages.js';
import { buildCachedSubscriptionInventory, chooseTarget } from '../lib/routing.js';
import { CONFIG } from '../lib/config.js';
import { makeTargets, makePolicy, makeBaseline, makeFailure, makeSnapshot } from './helpers/model-outages.mjs';

function loadedTargets(targets) {
  const root = mkdtempSync(join(tmpdir(), 'outage-config-'));
  try {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ targets, tiers: { build: Object.keys(targets) }, profiles: {}, fallbacks: {} }));
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      'const {CONFIG,CONFIG_ERROR}=await import("./lib/config.js");if(CONFIG_ERROR)throw Error(String(CONFIG_ERROR));console.log(JSON.stringify({targets:CONFIG.targets,tiers:CONFIG.tiers}))'],
    { cwd: new URL('..', import.meta.url), env: { ...process.env, OPENCODE_BROKER_CONFIG: path }, encoding: 'utf8' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('older and explicit same-version aliases cannot replace an unavailable canonical head', () => {
  const policy = makePolicy(), t = makeTargets();
  t['opus-alias'] = { ...t['claude-opus-5-5'], id: 'opus-alias', canonicalModelID: 'claude-opus-5-5' };
  t['opus-older'] = { ...t['claude-opus-5-5'], id: 'opus-older', modelID: 'claude-opus-5-4', releaseDate: '2026-01-01' };
  const loaded = loadedTargets(t); assert.ok(loaded.targets['opus-alias']); assert.ok(loaded.tiers.build.includes('opus-alias'));
  const keys = Object.values(loaded.targets).map(x => `${x.providerID}/${x.modelID}`);
  const heads = buildCanonicalHeads({ policy, targets: loaded.targets, admittedModelKeys: keys, resolvableModelKeys: keys });
  assert.equal(heads['anthropic/opus/standard'], 'claude-opus-5-5');
  assert.equal(ordinaryAllowed(loaded.targets['opus-alias'], { policy, heads }), false);
  assert.equal(ordinaryAllowed(loaded.targets['opus-older'], { policy, heads }), false);
  assert.equal(loaded.targets['claude-opus-5-5'].canonicalModelID, undefined);
  assert.equal(loaded.targets['opus-alias'].canonicalModelID, 'claude-opus-5-5');
  const selected = selectAutomatic({ primaryIDs: ['claude-opus-5-5', 'opus-alias', 'opus-older'], fallbackGroups: [], targets: loaded.targets,
    context: { policy, heads, outages: emptyOutages(), now: 20000 }, eligible: x => x.id !== 'claude-opus-5-5', pick: xs => xs[0] });
  assert.equal(selected, null);
  const future = { ...t['claude-opus-5-5'], id: 'opus-future', modelID: 'claude-opus-6', releaseDate: '2026-12-01' };
  t['claude-opus-5-5'].releaseDate = '2026-10-01'; t[future.id] = future;
  const all = Object.values(t).map(x => `${x.providerID}/${x.modelID}`);
  const newer = buildCanonicalHeads({ policy, targets: t, admittedModelKeys: all, resolvableModelKeys: all });
  assert.equal(newer['anthropic/opus/standard'], 'opus-future');
});

test('makeTargets fixture without release date or alias marker still selects reviewed head', () => {
  const policy = makePolicy(), targets = makeTargets();
  delete targets['claude-opus-5-5'].releaseDate; delete targets['claude-opus-5-5'].canonicalModelID;
  const loaded = loadedTargets(targets), keys = Object.values(loaded.targets).map(x => `${x.providerID}/${x.modelID}`);
  const heads = buildCanonicalHeads({ policy, targets: loaded.targets, admittedModelKeys: keys, resolvableModelKeys: keys });
  assert.equal(heads['anthropic/opus/standard'], 'claude-opus-5-5');
  assert.equal(loaded.targets['claude-opus-5-5'].canonicalModelID, undefined);
});

test('healthy unrelated primary precedes reserve and reserve precedes fallback after circuit expiry', () => {
  const policy = makePolicy(), targets = makeTargets(); targets.other = { id: 'other', providerID: 'other', modelID: 'other', kind: 'cloud' };
  const keys = Object.values(targets).map(t => `${t.providerID}/${t.modelID}`);
  const heads = buildCanonicalHeads({ policy, targets, admittedModelKeys: keys, resolvableModelKeys: keys });
  let s = emptyOutages(); for (const e of [makeBaseline(), makeFailure(), makeSnapshot(), makeBaseline({ targetID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 })]) s = reduceOutages(s, e, { policy, now: e.finishedAt ?? e.receivedAt });
  const args = { primaryIDs: ['claude-opus-5-5', 'other'], fallbackGroups: [['gpt-6-1-sol']], targets,
    context: { policy, heads, outages: s, now: 20000 }, eligible: () => true, pick: xs => xs[0] };
  assert.equal(selectAutomatic(args).target.id, 'other');
  assert.equal(selectAutomatic({ ...args, primaryIDs: ['claude-opus-5-5'] }).target.id, 'claude-opus-5');
  assert.equal(selectAutomatic({ ...args, primaryIDs: ['claude-opus-5-5'], eligible: t => t.providerID !== 'anthropic' }).target.id, 'gpt-6-1-sol');
  assert.equal(selectAutomatic({ ...args, primaryIDs: ['claude-opus-5-5'], fallbackGroups: [], eligible: () => false }), null);
});

test('an active grant excludes its canonical head when a reusable gate has no lane-local primary IDs', () => {
  const policy = makePolicy(), targets = makeTargets();
  const keys = Object.values(targets).map((target) => `${target.providerID}/${target.modelID}`);
  const heads = buildCanonicalHeads({ policy, targets, admittedModelKeys: keys, resolvableModelKeys: keys });
  let outages = emptyOutages();
  for (const event of [
    makeBaseline(), makeFailure(), makeSnapshot(),
    makeBaseline({ targetID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }),
  ]) outages = reduceOutages(outages, event, { policy, now: event.finishedAt ?? event.receivedAt });

  assert.equal(automaticAllowed(targets['claude-opus-5-5'], {
    policy, heads, outages, now: 20_000,
  }), false, 'held-lease, sticky, inventory, and preview gates must not forget the affected head');
});

// One active opus-5-5 outage with a verified claude-opus-5 reserve, as every gate test sees it.
function activeOutage(policy) {
  let outages = emptyOutages();
  for (const event of [
    makeBaseline(), makeFailure(), makeSnapshot(),
    makeBaseline({ targetID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }),
  ]) outages = reduceOutages(outages, event, { policy, now: event.finishedAt ?? event.receivedAt });
  return outages;
}
function headsFor(policy, targets) {
  const keys = Object.values(targets).map((target) => `${target.providerID}/${target.modelID}`);
  return buildCanonicalHeads({ policy, targets, admittedModelKeys: keys, resolvableModelKeys: keys });
}

test('a context snapshot computes grants once and a spread copy is recomputed for its own scope', () => {
  const policy = makePolicy(), targets = makeTargets(), heads = headsFor(policy, targets);
  const snapshot = snapshotOutageContext({ policy, heads, outages: activeOutage(policy), primaryIDs: ['claude-opus-5-5'], now: 20_000 });
  const first = authorizedReserveIDs(snapshot);
  assert.equal(first.length, 1);
  assert.equal(first[0].targetID, 'claude-opus-5');
  assert.equal(authorizedReserveIDs(snapshot), first, 'the snapshot answers from its own grants, not a fresh reducer pass');
  assert.ok(Object.isFrozen(snapshot));
  // A spread copy carries no hidden grants: its lane scope is re-evaluated, so an unrelated
  // lane cannot inherit another lane's substitution.
  const unrelatedLane = { ...snapshot, primaryIDs: ['gpt-6-1-sol'] };
  assert.deepEqual(authorizedReserveIDs(unrelatedLane), []);
  assert.deepEqual(Object.keys(unrelatedLane).sort(), ['circuits', 'heads', 'now', 'outages', 'policy', 'primaryIDs']);
});

test('an affected head is excluded in every lane while its reserve substitutes only in lanes that carry the head', () => {
  const policy = makePolicy(), targets = makeTargets(), heads = headsFor(policy, targets), outages = activeOutage(policy);
  const unrelatedLane = snapshotOutageContext({ policy, heads, outages, primaryIDs: ['gpt-6-1-sol'], now: 20_000 });
  assert.equal(automaticAllowed(targets['claude-opus-5-5'], unrelatedLane), false, 'a head in outage is not ordinary anywhere');
  assert.equal(automaticAllowed(targets['claude-opus-5'], unrelatedLane, 'reserve'), false, 'no substitution without the head in the lane');
  assert.equal(automaticAllowed(targets['gpt-6-1-sol'], unrelatedLane), true, 'an unrelated head is untouched');
  const ownLane = snapshotOutageContext({ policy, heads, outages, primaryIDs: ['claude-opus-5-5'], now: 20_000 });
  assert.equal(automaticAllowed(targets['claude-opus-5'], ownLane, 'reserve'), true);
  assert.equal(automaticAllowed(targets['claude-opus-5'], ownLane), false, 'a reserve is never ordinary, grant or not');
});

test('an explicit alias of a managed canonical identity is refused even without its own scope metadata', () => {
  const policy = makePolicy(), targets = makeTargets(), heads = headsFor(policy, targets);
  const bareAlias = { id: 'opus-bare-alias', providerID: 'anthropic', modelID: 'claude-opus-5-5', kind: 'cloud', canonicalModelID: 'claude-opus-5-5' };
  const reserveAlias = { id: 'opus-5-alias', providerID: 'anthropic', modelID: 'claude-opus-5', kind: 'cloud', canonicalModelID: 'claude-opus-5' };
  const unrelatedAlias = { id: 'qwen-alias', providerID: 'alibaba', modelID: 'qwen3-max', kind: 'cloud', canonicalModelID: 'qwen3-max' };
  const caseFolded = { id: 'opus-upper', providerID: 'anthropic', modelID: 'CLAUDE-OPUS-5-5', kind: 'cloud', canonicalModelID: 'CLAUDE-OPUS-5-5' };
  assert.equal(ordinaryAllowed(bareAlias, { policy, heads }), false);
  assert.equal(ordinaryAllowed(reserveAlias, { policy, heads }), false);
  assert.equal(ordinaryAllowed(unrelatedAlias, { policy, heads }), true, 'unrelated alias rules are unchanged');
  // Only the exact explicit identity is a managed alias; a differently-cased name is not folded
  // into one, and a target without any managed relation keeps the pre-feature answer.
  assert.equal(ordinaryAllowed(caseFolded, { policy, heads }), true);
});

test('ordinaryAllowed fails explicitly rather than silently unrouting when an enabled policy has no heads', () => {
  const policy = makePolicy(), targets = makeTargets();
  assert.throws(() => ordinaryAllowed(targets['claude-opus-5-5'], { policy }), /heads/);
  assert.throws(() => ordinaryAllowed(targets['claude-opus-5-5'], { policy, heads: null }), /heads/);
  assert.equal(ordinaryAllowed(targets['claude-opus-5-5'], { policy: { enabled: false } }), true);
});

test('managed-role marking follows the reviewed role classification and never an unrelated role', () => {
  const policy = makePolicy(), targets = makeTargets();
  const modelRoles = {
    'anthropic:claude-opus': { providerID: 'anthropic', families: ['claude-opus'], idPatterns: [{ prefix: 'claude-opus-', suffix: '' }] },
    'anthropic:claude-haiku': { providerID: 'anthropic', families: ['claude-haiku'], idPatterns: [{ prefix: 'claude-haiku-', suffix: '' }] },
  };
  // A catalog sibling in the managed opus role with no family/speed metadata, and a haiku
  // target in a role the policy never names.
  targets['opus-5-4-bare'] = { id: 'opus-5-4-bare', providerID: 'anthropic', modelID: 'claude-opus-5-4', kind: 'cloud' };
  targets['haiku-bare'] = { id: 'haiku-bare', providerID: 'anthropic', modelID: 'claude-haiku-4-5', kind: 'cloud' };
  const marked = markManagedOutageScope(targets, { policy, modelRoles });
  assert.equal(marked['opus-5-4-bare'].managedOutageScope, true);
  assert.equal(marked['claude-opus-5-5'].managedOutageScope, true);
  assert.equal('managedOutageScope' in marked['haiku-bare'], false);
  assert.equal(marked['haiku-bare'], targets['haiku-bare'], 'an unrelated target is the same object');
  const heads = headsFor(policy, marked);
  assert.equal(ordinaryAllowed(marked['opus-5-4-bare'], { policy, heads }), false, 'ambiguous managed metadata fails closed');
  assert.equal(ordinaryAllowed(marked['haiku-bare'], { policy, heads }), true);
  assert.equal(markManagedOutageScope(targets, { policy: { enabled: false }, modelRoles }), targets, 'disabled policy marks nothing');
  assert.equal(markManagedOutageScope(marked, { policy, modelRoles })['opus-5-4-bare'], marked['opus-5-4-bare'], 'marking is idempotent');
});

test('a staged probation candidate stands as head only for its own offer and never when it is a reserve or alias', () => {
  const policy = makePolicy(), targets = makeTargets(), heads = headsFor(policy, targets);
  const candidate = { id: 'opus-6', providerID: 'anthropic', modelID: 'claude-opus-6', kind: 'cloud', family: 'opus', speed: 'standard' };
  const staged = stagedCandidateHeads(heads, candidate, policy);
  assert.equal(staged['anthropic/opus/standard'], 'opus-6');
  assert.equal(heads['anthropic/opus/standard'], 'claude-opus-5-5', 'the ordinary heads object is untouched');
  assert.equal(ordinaryAllowed(candidate, { policy, heads: staged }), true);
  assert.equal(ordinaryAllowed(candidate, { policy, heads }), false);
  assert.equal(stagedCandidateHeads(heads, targets['claude-opus-5'], policy), heads, 'a listed reserve is never staged as head');
  assert.equal(stagedCandidateHeads(heads, { ...candidate, canonicalModelID: 'claude-opus-6' }, policy), heads);
  assert.equal(stagedCandidateHeads(heads, { ...candidate, family: undefined }, policy), heads, 'ambiguous metadata is not staged');
  assert.equal(stagedCandidateHeads(heads, candidate, { enabled: false }), heads);
});

test('published subscription inventory applies the same gate, including the managed-role mark on mismatched metadata', () => {
  // Catalog family names are the provider's ("claude-opus"); the policy scope below uses the
  // same name, so the catalog's older sibling is in the managed scope and is not the head.
  const opusScope = 'anthropic/claude-opus/standard';
  const policy = { enabled: true, mappings: { 'claude-opus-5-5': ['claude-opus-5'] }, primaryScope: { 'claude-opus-5-5': opusScope },
    incidentAliases: { 'claude-opus-5-5': ['Claude Opus 5.5'] },
    expectedScopePolicies: { [opusScope]: makePolicy().expectedScopePolicies['anthropic/opus/standard'] } };
  const staticTargets = {
    'claude-opus-5-5': { id: 'claude-opus-5-5', providerID: 'anthropic', modelID: 'claude-opus-5-5', kind: 'cloud', family: 'claude-opus', speed: 'standard', releaseDate: '2026-09-18' },
    'claude-opus-5': { id: 'claude-opus-5', providerID: 'anthropic', modelID: 'claude-opus-5', kind: 'cloud', family: 'claude-opus', speed: 'standard', releaseDate: '2026-06-01' },
  };
  const model = (id, family, release) => ({ id, family, release_date: release, status: 'active', tool_call: true });
  const catalog = { anthropic: { id: 'anthropic', models: {
    'claude-opus-5-4': model('claude-opus-5-4', 'claude-opus', '2026-03-01'),
    'claude-haiku-4-5': model('claude-haiku-4-5', 'claude-haiku', '2026-04-01'),
  } } };
  const resolvableModels = new Set(['anthropic/claude-opus-5-5', 'anthropic/claude-opus-5', 'anthropic/claude-opus-5-4', 'anthropic/claude-haiku-4-5']);
  const complete = buildCachedSubscriptionInventory({ catalog, authTypes: { anthropic: 'oauth' }, staticTargets, resolvableModels,
    outagePolicy: { enabled: false } });
  const discoveredIDs = Object.values(complete.targets).map((target) => target.modelID).sort();
  assert.deepEqual(discoveredIDs, ['claude-haiku-4-5', 'claude-opus-5-4'], 'without the gate both catalog models are published');

  const gated = buildCachedSubscriptionInventory({ catalog, authTypes: { anthropic: 'oauth' }, staticTargets, resolvableModels, outagePolicy: policy });
  assert.deepEqual(Object.values(gated.targets).map((target) => target.modelID), ['claude-haiku-4-5'],
    'an older managed sibling never enters automatic inventory; an unrelated family is untouched');
  assert.equal(Object.values(gated.targets).some((target) => 'managedOutageScope' in target), false, 'published records are the catalog records, not the gate\'s working copies');

  // The fixture policy names the scope family "opus" while the catalog says "claude-opus": the
  // older sibling is then NOT in an expected scope, and only the reviewed role classification
  // (anthropic:claude-opus by id pattern) can still recognise it as managed and fail closed.
  const mismatched = buildCachedSubscriptionInventory({ catalog, authTypes: { anthropic: 'oauth' }, staticTargets: makeTargets(), resolvableModels,
    outagePolicy: makePolicy() });
  assert.deepEqual(Object.values(mismatched.targets).map((target) => target.modelID), ['claude-haiku-4-5']);
});

test('disabled outage policy is exactly equivalent for representative primary, fallback, and overflow selections', () => {
  const targets = CONFIG.targets;
  const primaryID = CONFIG.tiers.build[0];
  const common = { profile: 'auto', tier: 'build', targets, cursors: {}, health: {}, localModels: new Set(), now: 1000 };
  const scenarios = [
    common,
    { ...common, circuits: { [primaryID]: { until: 2000 } } },
    { ...common, contextTokens: 1_000_000 },
  ];
  for (const scenario of scenarios) {
    // Explicitly no policy: chooseTarget's default is the host's own config, which may enable one.
    const baseline = chooseTarget({ ...scenario, outagePolicy: null });
    const disabled = chooseTarget({ ...scenario, outagePolicy: { enabled: false }, outages: emptyOutages(), canonicalHeads: {} });
    assert.deepEqual(disabled, baseline);
  }
});

test('observe policy is routing-equivalent to disabled even with an active historical grant', () => {
  // This catches reserve substitution, head exclusion, or managed filtering leaking into observe.
  const targets = makeTargets();
  const active = makePolicy();
  const observe = { ...active, mode: 'observe' };
  const outages = activeOutage(active);
  const common = { profile: 'auto', tier: 'build', targets, cursors: {}, health: {}, localModels: new Set(), now: 20_000 };
  const disabled = chooseTarget({ ...common, outagePolicy: null });
  const observing = chooseTarget({ ...common, outagePolicy: observe, outages, canonicalHeads: {} });
  assert.deepEqual(observing, disabled);
});
