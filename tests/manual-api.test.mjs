import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeManualApiTargets, manualApiAdmission } from '../lib/manual-api.js';

const target = { id: 'reserve-sonnet', providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'cloud' };
const context = {
  targets: { [target.id]: target },
  profiles: { 'api-reserve': [target.id] },
  tiers: { worker: [] },
  fallbacks: { worker: [] },
  profileFallbacks: {},
  offlineProfiles: [],
  trustedSubscriptionProviders: [],
};
const raw = { [target.id]: ['api-reserve'] };

test('normalizes an explicit API reserve and applies exact admission', () => {
  const policy = normalizeManualApiTargets(raw, context);
  assert.deepEqual(Object.keys(normalizeManualApiTargets(undefined, context)), []);
  assert.equal(manualApiAdmission(target, 'api-reserve', policy), true);
  assert.equal(manualApiAdmission(target, 'auto', policy), false);
  assert.equal(manualApiAdmission(target, 'wrong-profile', policy), false);
  assert.equal(manualApiAdmission({ ...target, source: 'subscription-oauth' }, 'api-reserve', policy), false);
  assert.equal(manualApiAdmission({ ...target, id: 'other-id' }, 'api-reserve', policy), false);
  assert.equal(manualApiAdmission({ ...target, providerID: 'unrelated-provider' }, 'api-reserve', policy), null);
  assert.throws(
    () => normalizeManualApiTargets(raw, { ...context, tiers: { worker: [target.id] } }),
    /manualApiTargets/,
  );
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy[target.id]));
  assert.ok(Object.isFrozen(policy[target.id].profiles));
});

test('rejects every forbidden route and raw placement instead of dropping it', () => {
  const invalid = (patch) => assert.throws(() => normalizeManualApiTargets(raw, { ...context, ...patch }), /manualApiTargets/);
  invalid({ profiles: { 'api-reserve': [target.id], auto: [target.id] } });
  invalid({ profiles: { 'api-reserve': [target.id], other: [target.id] } });
  invalid({ fallbacks: { worker: [[target.id]] } });
  invalid({ profileFallbacks: { other: [[target.id]] } });
  invalid({ trustedSubscriptionProviders: ['paid-test-provider'] });
  invalid({ targets: { ...context.targets, duplicate: { ...target, id: 'duplicate' } } });
});

test('allows multiple registered models for one provider but rejects any unregistered static sibling', () => {
  const opus = { id: 'reserve-opus', providerID: target.providerID, modelID: 'test-opus', kind: 'cloud' };
  const multiContext = {
    ...context,
    targets: { [target.id]: target, [opus.id]: opus },
    profiles: { 'api-sonnet': [target.id], 'api-opus': [opus.id] },
  };
  const policy = normalizeManualApiTargets({ [target.id]: ['api-sonnet'], [opus.id]: ['api-opus'] }, multiContext);
  assert.equal(manualApiAdmission(target, 'api-sonnet', policy), true);
  assert.equal(manualApiAdmission(opus, 'api-opus', policy), true);
  assert.equal(manualApiAdmission(opus, 'api-sonnet', policy), false);
  assert.equal(manualApiAdmission({ ...opus, id: 'unknown' }, 'api-opus', policy), false);
  assert.equal(manualApiAdmission({ ...opus, modelID: 'unknown' }, 'api-opus', policy), false);
  assert.equal(manualApiAdmission({ ...opus, source: 'subscription-oauth' }, 'api-opus', policy), false);
  assert.equal(manualApiAdmission({ ...opus, providerID: 'unrelated' }, 'api-opus', policy), null);
  assert.throws(() => normalizeManualApiTargets(
    { [target.id]: ['api-sonnet'] },
    { ...multiContext, targets: { ...multiContext.targets, unregistered: { ...target, id: 'unregistered', modelID: 'other' } } },
  ), /manualApiTargets/);
});

test('rejects null and non-object raw policy values instead of treating them as absent', () => {
  for (const rawValue of [null, [], 'reserve', 1]) {
    assert.throws(() => normalizeManualApiTargets(rawValue, context), /manualApiTargets/);
  }
  assert.deepEqual(normalizeManualApiTargets(undefined, context), {});
  assert.deepEqual(normalizeManualApiTargets({}, context), {});
});

test('routing exposes a reserve only to its explicit profile', () => {
  const directory = mkdtempSync(join(tmpdir(), 'manual-api-routing-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    targets: { 'reserve-sonnet': target },
    profiles: { 'api-reserve': ['reserve-sonnet'] },
    manualApiTargets: { 'reserve-sonnet': ['api-reserve'] },
  }));
  const routingURL = new URL('../lib/routing.js', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const r = await import(${JSON.stringify(routingURL)});
    const target = { id: 'reserve-sonnet', providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'cloud' };
    process.stdout.write(JSON.stringify({
      explicit: r.targetIDsFor('api-reserve', 'worker', { 'reserve-sonnet': target }),
      automatic: r.targetIDsFor('auto', 'worker', { 'reserve-sonnet': target }),
      explicitAdmission: r.cloudTargetAdmitted(target, {}, 'api-reserve'),
      automaticAdmission: r.cloudTargetAdmitted(target, { 'paid-test-provider': { connected: true, authType: 'oauth' } }, 'auto'),
    }));
  `], { env: { ...process.env, OPENCODE_BROKER_CONFIG: configPath }, encoding: 'utf8' });
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      explicit: ['reserve-sonnet'], automatic: [], explicitAdmission: true, automaticAdmission: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manual provider guard precedes local exemptions and survives outage expansion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'manual-api-routing-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    targets: { 'reserve-sonnet': target, local: { id: 'local', providerID: 'local', modelID: 'local', kind: 'local' } },
    profiles: { 'api-reserve': ['reserve-sonnet'] },
    manualApiTargets: { 'reserve-sonnet': ['api-reserve'] },
    tiers: { worker: ['local'] },
  }));
  const routingURL = new URL('../lib/routing.js', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const r = await import(${JSON.stringify(routingURL)});
    const paid = { id: 'reserve-sonnet', providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'local' };
    const local = { id: 'local', providerID: 'local', modelID: 'local', kind: 'local' };
    const targets = { local, 'reserve-sonnet': { id: 'reserve-sonnet', providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'cloud' } };
    const { snapshotOutageContext } = await import(${JSON.stringify(new URL('../lib/outage-policy.js', import.meta.url).href)});
    const outageContext = snapshotOutageContext({
      policy: { enabled: true, mappings: { local: ['reserve-sonnet'] }, primaryScope: { local: 'local' }, expectedScopePolicies: {} },
      heads: {}, circuits: { local: { until: Date.now() + 60_000 } }, primaryIDs: ['local'], now: Date.now(),
    });
    process.stdout.write(JSON.stringify({
      forgedLocal: r.cloudTargetAdmitted(paid, { 'paid-test-provider': { connected: true, authType: 'oauth' } }, 'api-reserve'),
      ordinaryLocal: r.cloudTargetAdmitted(local, {}, 'auto'),
      automaticOutage: r.targetIDsFor('auto', 'worker', targets, outageContext),
      automaticFallback: r.fallbackTargetGroupsFor('auto', 'worker', targets, outageContext),
    }));
  `], { env: { ...process.env, OPENCODE_BROKER_CONFIG: configPath }, encoding: 'utf8' });
  try {
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      forgedLocal: false, ordinaryLocal: true, automaticOutage: ['local'], automaticFallback: [],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
