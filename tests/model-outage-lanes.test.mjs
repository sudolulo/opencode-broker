import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CI_A, makeTargets, makePolicy, makeBaseline, makeFailure, makeSnapshot } from './helpers/model-outages.mjs';

// Task 7 integration rows, exercised through the EXPORTED routing paths against a deployment
// whose lanes are known: one lane that is only the affected head, one lane with an unrelated
// healthy primary beside it, a rung that carries the head, and a Claude-only profile. The
// config is generated here so no test depends on the live deployment's lanes.
const fixtureTargets = makeTargets();
fixtureTargets['gpt-terra'] = { id: 'gpt-terra', providerID: 'openai', modelID: 'gpt-6-terra', kind: 'cloud', context: 200000 };
const root = mkdtempSync(join(tmpdir(), 'outage-lanes-'));
const configPath = join(root, 'config.json');
writeFileSync(configPath, JSON.stringify({
  targets: fixtureTargets,
  tiers: {
    smart: ['claude-opus-5-5'],
    build: ['claude-opus-5-5', 'gpt-terra'],
    worker: ['gpt-terra'],
    deep: ['claude-fable-5-1'],
  },
  fallbacks: { smart: [['gpt-6-1-sol']], worker: [['claude-opus-5-5']] },
  profiles: { claude: ['claude-opus-5-5'] },
  profileCloudEgress: ['claude'],
  modelOutages: (({ primaryScope, ...rest }) => rest)(makePolicy()),
}));
process.env.OPENCODE_BROKER_CONFIG = configPath;
const { CONFIG, CONFIG_ERROR } = await import('../lib/config.js');
const { chooseTarget, targetIDsFor, fallbackTargetGroupsFor, targetEligibleIDsFor } = await import('../lib/routing.js');
const { emptyOutages, reduceOutages } = await import('../lib/model-outages.js');
const { buildCanonicalHeads, selectAutomatic, snapshotOutageContext } = await import('../lib/outage-policy.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

assert.equal(CONFIG_ERROR, null, `fixture config must load cleanly: ${CONFIG_ERROR}`);
assert.equal(CONFIG.modelOutages.enabled, true);
const policy = CONFIG.modelOutages;
const T = CONFIG.targets;
const keys = Object.values(T).map((target) => `${target.providerID}/${target.modelID}`);
const heads = buildCanonicalHeads({ policy, targets: T, admittedModelKeys: keys, resolvableModelKeys: keys });
assert.equal(heads['anthropic/opus/standard'], 'claude-opus-5-5');

// One confirmed opus-5-5 outage with a verified claude-opus-5 reserve. Grants hold at
// now=20_000 (proof and snapshot fresh) and have lapsed by now=140_000.
let outages = emptyOutages();
for (const event of [
  makeBaseline(), makeFailure(), makeSnapshot(),
  makeBaseline({ targetID: 'claude-opus-5', purpose: 'outage-health', startedAt: 2201, finishedAt: 2300 }),
]) outages = reduceOutages(outages, event, { policy, now: event.finishedAt ?? event.receivedAt });
const ACTIVE = 20_000;
const LAPSED = 140_000;
const base = { profile: 'auto', tier: 'smart', targets: T, cursors: {}, health: {}, circuits: {}, localModels: new Set(),
  now: ACTIVE, outagePolicy: policy, outages, canonicalHeads: heads };
const context = (now = ACTIVE) => snapshotOutageContext({ policy, heads, outages, primaryIDs: null, now });

test('chooseTarget leases the authorized reserve when the only lane primary is the affected head', () => {
  const choice = chooseTarget(base);
  assert.equal(choice.target.id, 'claude-opus-5');
  assert.equal(choice.decision.policy, 'outage-reserve');
  assert.equal(choice.decision.source, 'reserve');
  assert.equal(choice.decision.grant.primaryID, 'claude-opus-5-5');
  assert.equal(choice.decision.grant.targetID, 'claude-opus-5');
  assert.equal(choice.decision.grant.credentialInstance, CI_A);
  assert.deepEqual(choice.decision.eligibleTargetIDs, ['claude-opus-5']);
  assert.equal(choice.cursorKey, 'auto:smart:cloud');
  assert.ok(choice.decision.reasons.some((reason) => reason.includes('claude-opus-5-5')), 'the reason names the substituted head');
});

test('chooseTarget prefers a healthy unrelated primary over the reserve and carries no grant', () => {
  const choice = chooseTarget({ ...base, tier: 'build' });
  assert.equal(choice.target.id, 'gpt-terra');
  assert.equal(choice.decision.policy, 'weighted-depletion');
  assert.equal('grant' in choice.decision, false);
  assert.equal('source' in choice.decision, false);
  assert.deepEqual(choice.decision.eligibleTargetIDs, ['gpt-terra']);
});

test('an ineligible reserve falls through to the ordinary fallback ladder, never to the affected head', () => {
  const fenced = chooseTarget({ ...base, circuits: { 'claude-opus-5': { until: ACTIVE + 60_000 } } });
  assert.equal(fenced.target.id, 'gpt-6-1-sol');
  assert.equal(fenced.decision.policy, 'strict-fallback');
  const excluded = chooseTarget({ ...base, excludedTargetIDs: ['claude-opus-5'] });
  assert.equal(excluded.target.id, 'gpt-6-1-sol');
  const providerFenced = chooseTarget({ ...base, circuits: { 'provider:anthropic': { until: ACTIVE + 60_000 } } });
  assert.equal(providerFenced.target.id, 'gpt-6-1-sol', 'a provider circuit is still an upper fence on the reserve');
  const quarantined = chooseTarget({ ...base, health: { providers: { anthropic: { state: 'quarantined' } } } });
  assert.equal(quarantined.target.id, 'gpt-6-1-sol', 'provider quarantine is still an upper fence on the reserve');
});

test('the context-overflow last resort never hands a reserve a context bypass', () => {
  // The reserve declares a window five times roomier than every ordinary target.
  const windows = { ...T, 'claude-opus-5': { ...T['claude-opus-5'], context: 1_000_000 } };
  const choice = chooseTarget({ ...base, targets: windows, contextTokens: 5_000_000 });
  assert.equal(choice.decision.policy, 'context-overflow-last-resort');
  assert.equal(choice.target.id, 'gpt-6-1-sol', 'the roomiest ORDINARY window, not the roomier reserve');
  const fits = chooseTarget({ ...base, targets: windows, contextTokens: 500_000 });
  assert.equal(fits.target.id, 'claude-opus-5', 'a reserve that genuinely fits is selected on the reserve path');
  assert.equal(fits.decision.policy, 'outage-reserve');
});

test('a Claude-only profile gains a same-provider reserve and nothing else', () => {
  const claude = chooseTarget({ ...base, profile: 'claude' });
  assert.equal(claude.target.id, 'claude-opus-5');
  assert.deepEqual(claude.decision.eligibleTargetIDs, ['claude-opus-5']);
  assert.equal(chooseTarget({ ...base, profile: 'claude', circuits: { 'claude-opus-5': { until: ACTIVE + 60_000 } } }), null,
    'no reserve code adds a cross-provider rung to a restrictive profile');
});

test('a lapsed grant restores the head to ordinary selection and drops the reserve', () => {
  const choice = chooseTarget({ ...base, now: LAPSED });
  assert.equal(choice.target.id, 'claude-opus-5-5');
  assert.equal(choice.decision.policy, 'weighted-depletion');
  assert.equal('grant' in choice.decision, false);
});

test('an enabled policy without grants selects exactly as the disabled policy does', () => {
  for (const tier of ['smart', 'build', 'worker', 'deep']) {
    for (const scenario of [{}, { circuits: { 'claude-opus-5-5': { until: ACTIVE + 1 } } }, { contextTokens: 1_000_000 }, { cursors: { 'auto:build:cloud': 1 } }]) {
      const enabled = chooseTarget({ ...base, ...scenario, tier, outages: emptyOutages() });
      const disabled = chooseTarget({ ...base, ...scenario, tier, outagePolicy: { enabled: false }, outages: null, canonicalHeads: null });
      assert.deepEqual(enabled, disabled, `${tier} ${JSON.stringify(scenario)}`);
    }
  }
});

test('an enabled chooseTarget without canonical heads fails explicitly instead of unrouting the managed lanes', () => {
  assert.throws(() => chooseTarget({ ...base, canonicalHeads: null }), /heads/);
  assert.throws(() => chooseTarget({ ...base, canonicalHeads: undefined }), /heads/);
});

test('selectAutomatic hands the caller its stage so weighted selection keeps its primary and fallback shapes', () => {
  const stages = [];
  const pick = (candidates, stage) => { stages.push(stage); return candidates[0]; };
  const ctx = { policy, heads, outages, now: ACTIVE };
  selectAutomatic({ primaryIDs: ['gpt-terra'], fallbackGroups: [], targets: T, context: ctx, eligible: () => true, pick });
  selectAutomatic({ primaryIDs: ['claude-opus-5-5'], fallbackGroups: [['gpt-6-1-sol']], targets: T, context: ctx,
    eligible: (target) => target.id !== 'claude-opus-5', pick });
  assert.deepEqual(stages, ['primary', 'fallback']);
});

test('targetIDsFor removes the affected head and substitutes its reserve only in lanes that carry the head', () => {
  assert.deepEqual(targetIDsFor('auto', 'smart', T, context()), ['claude-opus-5']);
  assert.deepEqual(targetIDsFor('auto', 'build', T, context()), ['gpt-terra', 'claude-opus-5']);
  assert.deepEqual(targetIDsFor('auto', 'worker', T, context()), ['gpt-terra']);
  assert.deepEqual(targetIDsFor('claude', 'smart', T, context()), ['claude-opus-5']);
  assert.deepEqual(targetIDsFor('auto', 'smart', T, context(LAPSED)), ['claude-opus-5-5'], 'a lapsed grant drops the reserve');
  assert.deepEqual(targetIDsFor('auto', 'smart', T), ['claude-opus-5-5'], 'no context: the raw lane');
  assert.deepEqual(targetIDsFor('manual', 'smart', T, context()), []);
});

test('fallback rungs lose an affected head and receive no reserve substitution', () => {
  assert.deepEqual(fallbackTargetGroupsFor('auto', 'worker', T, context()), [[]]);
  assert.deepEqual(fallbackTargetGroupsFor('auto', 'worker', T, context(LAPSED)), [['claude-opus-5-5']]);
  assert.deepEqual(fallbackTargetGroupsFor('auto', 'smart', T, context()), [['gpt-6-1-sol']]);
});

test('targetEligibleIDsFor contains the reserve exactly while its grant is active and never the affected head', () => {
  assert.deepEqual(targetEligibleIDsFor('auto', 'smart', T, context()), ['claude-opus-5', 'gpt-6-1-sol']);
  assert.deepEqual(targetEligibleIDsFor('auto', 'smart', T, context(LAPSED)), ['claude-opus-5-5', 'gpt-6-1-sol']);
  assert.deepEqual(targetEligibleIDsFor('auto', 'worker', T, context()), ['gpt-terra']);
});

test('a grant for a primary that is no longer its scope head authorizes nothing for the newer head', () => {
  const future = { ...T['claude-opus-5-5'], id: 'opus-future', modelID: 'claude-opus-6', releaseDate: '2026-12-01' };
  const dated = { ...T, 'claude-opus-5-5': { ...T['claude-opus-5-5'], releaseDate: '2026-10-01' }, 'opus-future': future };
  const all = Object.values(dated).map((target) => `${target.providerID}/${target.modelID}`);
  const newer = buildCanonicalHeads({ policy, targets: dated, admittedModelKeys: all, resolvableModelKeys: all });
  assert.equal(newer['anthropic/opus/standard'], 'opus-future');
  const ctx = snapshotOutageContext({ policy, heads: newer, outages, primaryIDs: null, now: ACTIVE });
  assert.deepEqual(targetIDsFor('auto', 'smart', dated, ctx), [], 'the displaced pin is not ordinary and its reserve is not inherited');
  const choice = chooseTarget({ ...base, targets: dated, canonicalHeads: newer, circuits: { 'opus-future': { until: ACTIVE + 1 } } });
  assert.equal(choice.target.id, 'gpt-6-1-sol', 'with the new head fenced the lane falls back; no reserve, no older sibling');
});
