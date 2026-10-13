import assert from 'node:assert/strict';
import test from 'node:test';
import { probationOnlyModelKeys, resolvePolicyLane } from '../lib/policy-targets.js';
import { makePolicy } from './helpers/model-outages.mjs';

// The reviewed `openai:gpt-sol` role (CONFIG.modelRoles, id pattern gpt-*-sol, tier smart) is
// MANAGED because the outage policy names `gpt-6-1-sol` as a primary and `gpt-flagship` as its
// reserve. Every target the role classification puts beside them is a managed candidate.
const outagePolicy = makePolicy();
const managedTargets = () => ({
  'gpt-6-1-sol': { id: 'gpt-6-1-sol', providerID: 'openai', modelID: 'gpt-6-1-sol', kind: 'cloud', family: 'sol', speed: 'standard', variants: ["low"], capabilities: { toolCall: true } },
  'gpt-flagship': { id: 'gpt-flagship', providerID: 'openai', modelID: 'gpt-6-sol', kind: 'cloud', family: 'sol', speed: 'standard', variants: ["low"], capabilities: { toolCall: true } },
  incumbent: { id: 'incumbent', providerID: 'openai', modelID: 'gpt-5.6-sol', kind: 'cloud', variants: ["low"], capabilities: { toolCall: true } },
  ambiguous: { id: 'ambiguous', providerID: 'openai', modelID: 'gpt-5.7-sol', kind: 'cloud', variants: ["low"], capabilities: { toolCall: true } },
  unrelated: { id: 'unrelated', providerID: 'openai', modelID: 'gpt-6-terra', kind: 'cloud', variants: ["low"], capabilities: { toolCall: true } },
});
const routingIntent = { tiers: ['smart'], fit: {}, effortCeiling: 'low', requiredReasoningMode: null };

test('managed-role ambiguity is marked before release metadata can filter it', () => {
  const targets = managedTargets();
  const modelPolicy = { roles: { 'openai:gpt-sol': {
    activeModelID: 'gpt-5.6-sol', incumbentModelID: 'gpt-5.6-sol', probationModelID: null, routingIntent,
  } } };
  const result = resolvePolicyLane({ targetIDs: Object.keys(targets), targets, modelPolicy, outagePolicy,
    registration: { modelKeys: [] }, activeLeases: [], tier: 'smart', enabled: true });
  assert.equal(result.targets.ambiguous.managedOutageScope, true);
  assert.equal(result.targets.incumbent.managedOutageScope, true);
  assert.equal(result.targets['gpt-6-1-sol'].managedOutageScope, true);
  assert.equal('managedOutageScope' in result.targets.unrelated, false, 'a target in no managed role is untouched');
});

test('a derived introduced active target keeps its managed mark', () => {
  const targets = managedTargets();
  const modelPolicy = { roles: { 'openai:gpt-sol': {
    providerID: 'openai', activeModelID: 'gpt-5.7-sol', incumbentModelID: 'gpt-5.6-sol', probationModelID: null, routingIntent,
  } } };
  const result = resolvePolicyLane({ targetIDs: Object.keys(targets), targets, modelPolicy, outagePolicy,
    registration: { modelKeys: ['openai/gpt-5.7-sol'] }, activeLeases: [], tier: 'smart', enabled: true });
  assert.ok(result.targetIDs.includes('ambiguous'), 'the registered introduced active model is admitted');
  assert.equal(result.targets.ambiguous.effortCeiling, 'low', 'it is the DERIVED candidate');
  assert.equal(result.targets.ambiguous.managedOutageScope, true, 'and the derived candidate still carries the mark');
});

test('an authorized reserve is admitted through the same role governance as the lane, never as an ordinary member', () => {
  const targets = managedTargets();
  const modelPolicy = { roles: { 'openai:gpt-sol': {
    activeModelID: 'gpt-6-1-sol', incumbentModelID: 'gpt-6-1-sol', probationModelID: null, routingIntent,
  } } };
  const without = resolvePolicyLane({ targetIDs: ['gpt-6-1-sol', 'gpt-flagship'], targets, modelPolicy, outagePolicy,
    registration: { modelKeys: [] }, activeLeases: [], tier: 'smart', enabled: true });
  assert.deepEqual(without.targetIDs, ['gpt-6-1-sol'], 'a listed reserve is not an active role member');
  const withReserve = resolvePolicyLane({ targetIDs: ['gpt-6-1-sol', 'gpt-flagship'], targets, modelPolicy, outagePolicy,
    reserveTargetIDs: ['gpt-flagship'], registration: { modelKeys: [] }, activeLeases: [], tier: 'smart', enabled: true });
  assert.deepEqual(withReserve.targetIDs, ['gpt-6-1-sol', 'gpt-flagship'], 'the authorized reserve passes the lane');
  assert.equal(withReserve.reason, 'model-policy-active');
  const otherTier = resolvePolicyLane({ targetIDs: ['gpt-6-1-sol', 'gpt-flagship'], targets, modelPolicy, outagePolicy,
    reserveTargetIDs: ['gpt-flagship'], registration: { modelKeys: [] }, activeLeases: [], tier: 'build', enabled: true });
  assert.deepEqual(otherTier.targetIDs, [], 'a role that does not route this tier admits neither head nor reserve');
  const unlisted = resolvePolicyLane({ targetIDs: ['gpt-6-1-sol', 'gpt-flagship', 'incumbent'], targets, modelPolicy, outagePolicy,
    reserveTargetIDs: ['incumbent'], registration: { modelKeys: [] }, activeLeases: [], tier: 'smart', enabled: true });
  assert.deepEqual(unlisted.targetIDs, ['gpt-6-1-sol'], 'only an ID the outage gate authorized is admitted as a reserve');
});

test('probation-only model keys are the staged candidates that are not yet the active model', () => {
  const modelPolicy = { roles: {
    'openai:gpt-sol': { providerID: 'openai', activeModelID: 'gpt-6-1-sol', incumbentModelID: 'gpt-6-1-sol', probationModelID: 'gpt-6-2-sol', probation: { phase: 'probation' } },
    'anthropic:claude-opus': { providerID: 'anthropic', activeModelID: 'claude-opus-6', incumbentModelID: 'claude-opus-5-5', probationModelID: 'claude-opus-6', probation: { phase: 'active' } },
    'anthropic:claude-sonnet': { providerID: 'anthropic', activeModelID: 'claude-sonnet-5-5', incumbentModelID: 'claude-sonnet-5-5', probationModelID: 'claude-sonnet-6', probation: { phase: 'rolled-back' } },
    'openai:gpt-terra': { providerID: 'openai', activeModelID: 'gpt-6-terra', incumbentModelID: 'gpt-6-terra', probationModelID: null },
  } };
  assert.deepEqual([...probationOnlyModelKeys(modelPolicy)].sort(), ['anthropic/claude-sonnet-6', 'openai/gpt-6-2-sol']);
  assert.deepEqual([...probationOnlyModelKeys(undefined)], []);
  assert.deepEqual([...probationOnlyModelKeys({ roles: null })], []);
});
