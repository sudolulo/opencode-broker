import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApiSpendGrant } from '../lib/api-spend-grant.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';
const policyRevision = 'a'.repeat(64);

function continuationGrant(overrides = {}) {
  return {
    version: 1,
    grantID: ID,
    purpose: 'continuation',
    sessionID: 'session-1',
    leaseID: 'lease-1',
    targetID: 'paid-target',
    providerID: 'paid-provider',
    modelID: 'claude-test',
    profile: 'normal',
    tier: 'paid',
    issuedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 1_000,
    policyRevision,
    source: {
      providerID: 'subscription-provider',
      targetID: 'subscription-target',
      leaseID: 'subscription-lease',
      modelID: 'subscription-model',
      quotaObservedAtMs: NOW - 2_000,
      quotaUntilMs: NOW + 2_000,
    },
    ...overrides,
  };
}

test('canonical continuation grants bind every supplied admission identity', () => {
  const grant = normalizeApiSpendGrant(continuationGrant(), {
    now: NOW,
    sessionID: 'session-1',
    leaseID: 'lease-1',
    targetID: 'paid-target',
    providerID: 'paid-provider',
    modelID: 'claude-test',
  });
  assert.deepEqual(grant, continuationGrant());
  assert.ok(Object.isFrozen(grant));
  assert.ok(Object.isFrozen(grant.source));
  assert.throws(() => { grant.source.providerID = 'changed'; }, TypeError);
});

test('grant parser refuses malformed fields, bindings, and non-current authority', () => {
  const verify = raw => assert.throws(() => normalizeApiSpendGrant(raw, { now: NOW, providerID: 'paid-provider' }), { code: 'invalid_authorization' });
  verify(continuationGrant({ purpose: 'caller-forged' }));
  verify(continuationGrant({ source: null }));
  verify(continuationGrant({ source: { ...continuationGrant().source, providerID: 'paid-provider' } }));
  verify(continuationGrant({ expiresAtMs: NOW }));
  verify(continuationGrant({ issuedAtMs: NOW + 1 }));
  verify(continuationGrant({ expiresAtMs: NOW + 3_000 }));
  verify(continuationGrant({ sessionID: 'session\nforged' }));
  verify(continuationGrant({ policyRevision: 'A'.repeat(64) }));
  verify(continuationGrant({ unexpected: true }));
  verify(Object.assign(Object.create(continuationGrant()), { version: 1 }));
  assert.throws(() => normalizeApiSpendGrant(continuationGrant(), { now: NOW, leaseID: 'other-lease' }), { code: 'invalid_authorization' });
});

test('manual grants have no quota source and are still time-bound', () => {
  const manual = continuationGrant({ purpose: 'manual', source: null });
  assert.equal(normalizeApiSpendGrant(manual, { now: NOW }).purpose, 'manual');
  assert.throws(() => normalizeApiSpendGrant({ ...manual, source: continuationGrant().source }, { now: NOW }), { code: 'invalid_authorization' });
});
