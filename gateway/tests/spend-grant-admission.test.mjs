// Gateway financial admission of broker-issued spend grants.
//
// A paid lease's spend grant reaches the gateway ONLY inside the broker-returned
// `target` object, on /lease (gateway-minted session) and on /lease/verify (a
// session-bound request). The gateway binds that grant to the actual lease before
// prepare: session, lease, target, provider, model, purpose vs billing class and
// clock. Every financial refusal is a terminal 402 with x-should-retry:false and
// zero upstream fetches. All grants here are synthetic and built through the real
// normalizeApiSpendGrant so no test relies on a shape the library would reject.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeHarness } from './helpers/spend-gateway-fixture.mjs';
import { withLedgerDir, rawPolicy, policyFor, allocationFor, NOW, MODEL, OPUS_MODEL, PROVIDER_ID, TEST_KEY } from './helpers/spend-fixture.mjs';
import { initializeLedger, fundLedger } from '../lib/spend-budget.js';
import { normalizeSpendPolicy } from '../lib/spend-policy.js';
import { normalizeApiSpendGrant } from '../../lib/api-spend-grant.js';

const TARGET_ID = 'synthetic-target';
const LEASE_ID = 'synthetic-lease';
const BOUND_SESSION = 'session-fixture';
const SPLIT = { ceilingUSD: '200', allocations: { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 48 } };
const REGISTERED = { targetID: TARGET_ID, providerID: PROVIDER_ID, modelID: MODEL };
const splitPolicy = ledgerPath => normalizeSpendPolicy(rawPolicy(ledgerPath, SPLIT), REGISTERED);
const BOUND_HEADERS = { 'x-opencode-session-id': BOUND_SESSION, 'x-opencode-lease-id': LEASE_ID };

async function fundSplit(ledgerPath) {
  const policy = splitPolicy(ledgerPath);
  await initializeLedger({ ledgerPath, policy, now: NOW });
  await fundLedger({ ledgerPath, policy, now: NOW, allocation: allocationFor('200') });
  return policy;
}
async function fundLegacy(ledgerPath) {
  const policy = policyFor(ledgerPath);
  await initializeLedger({ ledgerPath, policy, now: NOW });
  await fundLedger({ ledgerPath, policy, now: NOW, allocation: allocationFor('0.000000350') });
  return policy;
}

// A real normalized grant. `issuedAt` lets a test build a grant that was valid when
// minted but is at/after expiry by the time the gateway admits it.
function grantFor({ purpose = 'continuation', policyRevision, sessionID, leaseID = LEASE_ID, targetID = TARGET_ID,
  providerID = PROVIDER_ID, modelID = MODEL, issuedAt = NOW - 1, expiresAt = NOW + 60_000 }) {
  return normalizeApiSpendGrant({
    version: 1, grantID: '44444444-4444-4444-8444-444444444444', purpose, sessionID, leaseID, targetID, providerID, modelID,
    profile: purpose === 'manual' ? 'Manual Model' : 'auto', tier: purpose === 'manual' ? 'manual' : 'smart',
    issuedAtMs: issuedAt, expiresAtMs: expiresAt, policyRevision,
    source: purpose === 'manual' ? null : { providerID: 'subscription-provider', targetID: 'subscription-target',
      leaseID: 'subscription-lease', modelID: 'subscription-model', quotaObservedAtMs: issuedAt - 10, quotaUntilMs: expiresAt + 3_600_000 },
  }, { now: issuedAt });
}

// Broker double: the grant (if any) rides ONLY on the broker-returned target and is bound
// to the session id the broker actually saw in /lease or /lease/verify.
const brokerWith = ({ billingClass = 'api-continuation', grant, extra = {} } = {}) => async (path, body, target) => {
  if (path !== '/lease' && path !== '/lease/verify') return { ok: true };
  const spendGrant = typeof grant === 'function' ? grant(body.sessionID) : grant;
  return { held: true, leaseID: LEASE_ID, target: { ...target, billingClass, ...extra,
    ...(spendGrant !== undefined ? { spendGrant } : {}) } };
};

function rows(ledgerPath) {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try { return db.prepare('SELECT * FROM attempts').all(); } finally { db.close(); }
}
async function refusal(h, code, body = {}, options = {}) {
  const response = await h.send(body, options);
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  const value = await response.json();
  assert.equal(value.type, 'error');
  assert.equal(value.error.type, 'spend_budget_refusal');
  assert.equal(value.error.retryable, false);
  if (code) assert.equal(value.error.code, code);
  assert.equal(JSON.stringify(value).includes(TEST_KEY), false);
  assert.equal(h.upstreamCalls(), 0, 'a financial refusal never reaches upstream');
  return value;
}

test('continuation grant on a split policy reserves once, sends once, and records the grant in the ledger', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  let minted;
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT,
    brokerImpl: brokerWith({ grant: sessionID => (minted = grantFor({ policyRevision: policy.policyHash, sessionID })) }) });
  try {
    const response = await h.send();
    assert.equal(response.status, 200);
    assert.equal(h.upstreamCalls(), 1);
    const [row, ...rest] = rows(ledgerPath);
    assert.equal(rest.length, 0);
    assert.equal(row.spend_purpose, 'continuation');
    assert.deepEqual(JSON.parse(row.authorization_json), JSON.parse(JSON.stringify(minted)));
    assert.match(minted.sessionID, /./);
    assert.equal(h.brokerCalls.find(c => c.path === '/lease').body.sessionID, minted.sessionID);
  } finally { await h.close(); }
}));

test('bound session path propagates the /lease/verify target grant the same way', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const grant = grantFor({ policyRevision: policy.policyHash, sessionID: BOUND_SESSION });
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: brokerWith({ grant }) });
  try {
    assert.equal((await h.send({}, { headers: BOUND_HEADERS })).status, 200);
    assert.equal(h.upstreamCalls(), 1);
    assert.ok(h.brokerCalls.some(c => c.path === '/lease/verify'));
    assert.equal(h.brokerCalls.some(c => c.path === '/lease'), false);
    const [row] = rows(ledgerPath);
    assert.equal(row.spend_purpose, 'continuation');
    assert.deepEqual(JSON.parse(row.authorization_json), JSON.parse(JSON.stringify(grant)));
  } finally { await h.close(); }
}));

test('manual-api with a matching manual grant on a split policy is admitted from the reserve', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: brokerWith({ billingClass: 'manual-api',
    grant: sessionID => grantFor({ purpose: 'manual', policyRevision: policy.policyHash, sessionID }) }) });
  try {
    assert.equal((await h.send()).status, 200);
    assert.equal(h.upstreamCalls(), 1);
    assert.equal(rows(ledgerPath)[0].spend_purpose, 'manual');
  } finally { await h.close(); }
}));

for (const bound of [false, true]) test(`api-continuation without a broker grant is refused (${bound ? 'verify' : 'lease'})`, async () => withLedgerDir(async ledgerPath => {
  await fundSplit(ledgerPath);
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: brokerWith({}) });
  try {
    await refusal(h, 'binding_mismatch', {}, bound ? { headers: BOUND_HEADERS } : {});
    assert.equal(rows(ledgerPath).length, 0);
  } finally { await h.close(); }
}));

for (const billingClass of ['api-continuation', 'manual-api']) test(`a grant supplied only by the caller is ignored (${billingClass})`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const purpose = billingClass === 'manual-api' ? 'manual' : 'continuation';
  const forged = JSON.stringify(grantFor({ purpose, policyRevision: policy.policyHash, sessionID: BOUND_SESSION }));
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: brokerWith({ billingClass }) });
  try {
    await refusal(h, null, {}, { headers: { ...BOUND_HEADERS, 'x-opencode-spend-grant': forged } });
    await refusal(h, null, { metadata: { user_id: forged } });
    assert.equal(rows(ledgerPath).length, 0);
  } finally { await h.close(); }
}));

test('api-continuation against an unpartitioned policy is refused before any send', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundLegacy(ledgerPath);
  const h = await makeHarness({ ledgerPath, brokerImpl: brokerWith({
    grant: sessionID => grantFor({ policyRevision: policy.policyHash, sessionID }) }) });
  try {
    await refusal(h, 'invalid_policy');
    assert.equal(rows(ledgerPath).length, 0);
  } finally { await h.close(); }
}));

for (const [name, billingClass, overrides] of [
  ['continuation class with a manual grant', 'api-continuation', { purpose: 'manual' }],
  ['manual class with a continuation grant', 'manual-api', { purpose: 'continuation' }],
  ['another session', 'api-continuation', { sessionID: 'other-session' }],
  ['another lease', 'api-continuation', { leaseID: 'other-lease' }],
  ['another target', 'api-continuation', { targetID: 'other-target' }],
  ['another provider', 'api-continuation', { providerID: 'other-provider' }],
  ['another model', 'api-continuation', { modelID: OPUS_MODEL }],
]) test(`grant bound to ${name} is refused with zero fetches`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: brokerWith({ billingClass,
    grant: sessionID => grantFor({ policyRevision: policy.policyHash, sessionID, ...overrides }) }) });
  try {
    await refusal(h, 'binding_mismatch');
    assert.equal(rows(ledgerPath).length, 0);
  } finally { await h.close(); }
}));

test('bound session grant for another session is refused', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT,
    brokerImpl: brokerWith({ grant: grantFor({ policyRevision: policy.policyHash, sessionID: 'other-session' }) }) });
  try { await refusal(h, 'binding_mismatch', {}, { headers: BOUND_HEADERS }); assert.equal(rows(ledgerPath).length, 0); }
  finally { await h.close(); }
}));

test('malformed grant (unknown field) is refused', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: brokerWith({
    grant: sessionID => ({ ...grantFor({ policyRevision: policy.policyHash, sessionID }), surprise: true }) }) });
  try { await refusal(h, 'binding_mismatch'); assert.equal(rows(ledgerPath).length, 0); }
  finally { await h.close(); }
}));

test('a grant at its expiry instant is refused at admission', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: brokerWith({
    grant: sessionID => grantFor({ policyRevision: policy.policyHash, sessionID, issuedAt: NOW - 60_000, expiresAt: NOW }) }) });
  try { await refusal(h, 'expired'); assert.equal(rows(ledgerPath).length, 0); }
  finally { await h.close(); }
}));

for (const split of [true, false]) test(`clock reaching grant expiry after reservation never sends (${split ? 'split continuation' : 'unpartitioned manual'})`, async t => withLedgerDir(async ledgerPath => {
  const policy = split ? await fundSplit(ledgerPath) : await fundLegacy(ledgerPath);
  const expiresAt = NOW + 60_000;
  let clock = NOW;
  const real = await import('../lib/spend-budget.js');
  const mock = t.mock.module('../lib/spend-budget.js', { exports: { ...real, reserveAttempt: async args => {
    const result = await real.reserveAttempt(args); clock = expiresAt; return result;
  } } });
  let h;
  try {
    const { createGatewayHandler: handlerFactory } = await import(`../lib/gateway.js?grant-expiry-${split}`);
    h = await makeHarness({ ledgerPath, handlerFactory, now: () => clock, ...(split ? { policyOverrides: SPLIT } : {}),
      brokerImpl: brokerWith({ billingClass: split ? 'api-continuation' : 'manual-api',
        grant: sessionID => grantFor({ purpose: split ? 'continuation' : 'manual', policyRevision: policy.policyHash, sessionID, expiresAt }) }) });
    await refusal(h, 'expired');
    const [row] = rows(ledgerPath);
    assert.equal(row.state, 'UNCERTAIN');
    assert.equal(row.uncertain_reason, 'expired_before_send');
  } finally { if (h) await h.close(); mock.restore(); }
}));

// The clock moves PAST grant expiry between reservation and the final no-await gate. The
// hold is retained exactly as markUncertain records it: UNCERTAIN with its reason, the full
// reservation still held (no retained/refund split, never settled), and nothing sent.
for (const split of [true, false]) test(`clock moving past grant expiry after reservation retains the hold as uncertain (${split ? 'split continuation' : 'unpartitioned manual'})`, async t => withLedgerDir(async ledgerPath => {
  const policy = split ? await fundSplit(ledgerPath) : await fundLegacy(ledgerPath);
  const expiresAt = NOW + 60_000;
  let clock = NOW;
  const real = await import('../lib/spend-budget.js');
  const mock = t.mock.module('../lib/spend-budget.js', { exports: { ...real, reserveAttempt: async args => {
    const result = await real.reserveAttempt(args); clock = expiresAt + 5_000; return result;
  } } });
  let h;
  try {
    const { createGatewayHandler: handlerFactory } = await import(`../lib/gateway.js?grant-past-expiry-${split}`);
    h = await makeHarness({ ledgerPath, handlerFactory, now: () => clock, ...(split ? { policyOverrides: SPLIT } : {}),
      brokerImpl: brokerWith({ billingClass: split ? 'api-continuation' : 'manual-api',
        grant: sessionID => grantFor({ purpose: split ? 'continuation' : 'manual', policyRevision: policy.policyHash, sessionID, expiresAt }) }) });
    await refusal(h, 'expired');
    const all = rows(ledgerPath);
    assert.equal(all.length, 1);
    const [row] = all;
    assert.equal(row.state, 'UNCERTAIN');
    assert.equal(row.uncertain_reason, 'expired_before_send');
    assert.ok(row.reserved_nano > 0);
    assert.equal(row.retained_nano, null, 'the full hold is retained, nothing refunded');
    assert.equal(row.settled_at_ms, null);
    // The unpartitioned ledger schema has no spend_purpose column.
    if (split) assert.equal(row.spend_purpose, 'continuation');
  } finally { if (h) await h.close(); mock.restore(); }
}));

// A grant with too little life left would reserve a hold that the final gate can only strand
// as UNCERTAIN. It is refused before reserving: no ledger row, no fetch.
for (const split of [true, false]) test(`grant with under the minimum remaining life is refused before reserving (${split ? 'split continuation' : 'unpartitioned manual'})`, async () => withLedgerDir(async ledgerPath => {
  const policy = split ? await fundSplit(ledgerPath) : await fundLegacy(ledgerPath);
  const h = await makeHarness({ ledgerPath, ...(split ? { policyOverrides: SPLIT } : {}),
    brokerImpl: brokerWith({ billingClass: split ? 'api-continuation' : 'manual-api',
      grant: sessionID => grantFor({ purpose: split ? 'continuation' : 'manual', policyRevision: policy.policyHash, sessionID, expiresAt: NOW + 1_000 }) }) });
  try {
    await refusal(h, 'expired');
    assert.equal(rows(ledgerPath).length, 0, 'no stranded reservation');
    assert.ok(h.brokerCalls.some(c => c.path === '/release'), 'the lease is released like other pre-reserve refusals');
  } finally { await h.close(); }
}));

for (const split of [true, false]) test(`grant with exactly the minimum remaining life still sends once (${split ? 'split continuation' : 'unpartitioned manual'})`, async () => withLedgerDir(async ledgerPath => {
  const policy = split ? await fundSplit(ledgerPath) : await fundLegacy(ledgerPath);
  const h = await makeHarness({ ledgerPath, ...(split ? { policyOverrides: SPLIT } : {}),
    brokerImpl: brokerWith({ billingClass: split ? 'api-continuation' : 'manual-api',
      grant: sessionID => grantFor({ purpose: split ? 'continuation' : 'manual', policyRevision: policy.policyHash, sessionID, expiresAt: NOW + 2_000 }) }) });
  try {
    assert.equal((await h.send()).status, 200);
    assert.equal(h.upstreamCalls(), 1);
    assert.equal(rows(ledgerPath).length, 1);
  } finally { await h.close(); }
}));

// Bound-session path when the exact-ID verify misses. The broker answers held:false for a
// grant-bearing lease on an omitted ID, so the session-only re-verify also misses: the request
// gets the deterministic no-live-lease 400 and nothing is reserved or sent.
test('bound paid session whose exact and session-only verify both miss gets no-live-lease 400', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const grant = grantFor({ policyRevision: policy.policyHash, sessionID: BOUND_SESSION });
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: async (path, body, target) => {
    if (path !== '/lease/verify') return { ok: true };
    return { held: false, target: { ...target, billingClass: 'api-continuation', spendGrant: grant } };
  } });
  try {
    const response = await h.send({}, { headers: BOUND_HEADERS });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /session holds no live lease/);
    const verifies = h.brokerCalls.filter(c => c.path === '/lease/verify').map(c => c.body);
    assert.deepEqual(verifies, [{ sessionID: BOUND_SESSION, leaseID: LEASE_ID }, { sessionID: BOUND_SESSION }]);
    assert.equal(h.brokerCalls.some(c => c.path === '/lease'), false);
    assert.equal(h.upstreamCalls(), 0);
    assert.equal(rows(ledgerPath).length, 0);
  } finally { await h.close(); }
}));

// A broker that WRONGLY answers the session-only re-verify with a paid target whose grant is
// bound to a lease other than the one it names is refused at grant admission.
test('session-only re-verify returning a grant bound to another lease is refused binding_mismatch', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const grant = grantFor({ policyRevision: policy.policyHash, sessionID: BOUND_SESSION, leaseID: 'other-lease' });
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: async (path, body, target) => {
    if (path !== '/lease/verify') return { ok: true };
    if (body.leaseID) return { held: false };
    return { held: true, leaseID: LEASE_ID, target: { ...target, billingClass: 'api-continuation', spendGrant: grant } };
  } });
  try {
    await refusal(h, 'binding_mismatch', {}, { headers: BOUND_HEADERS });
    assert.equal(h.brokerCalls.filter(c => c.path === '/lease/verify').length, 2);
    assert.equal(rows(ledgerPath).length, 0);
  } finally { await h.close(); }
}));

// Paid leases never inherit the same-model leaseID rotation: a grant-bearing held lease must be
// the exact lease the header names. A rotated paid lease (even one whose grant is consistent
// with the rotated lease) is a routing refusal -- the no-live-lease 400 -- with nothing reserved,
// sent or settled. The verify reply is the broker's answer to the session-only re-verify.
const NO_LIVE_LEASE = /session holds no live lease/;
for (const [name, headers] of [
  ['a rotated lease id', BOUND_HEADERS],
  ['no lease id header', { 'x-opencode-session-id': BOUND_SESSION }],
]) test(`bound paid session with ${name} never forwards on a different held lease`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const grant = grantFor({ policyRevision: policy.policyHash, sessionID: BOUND_SESSION, leaseID: 'rotated-lease' });
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: async (path, body, target) => {
    if (path !== '/lease/verify') return { ok: true };
    if (body.leaseID) return { held: false };
    return { held: true, leaseID: 'rotated-lease', target: { ...target, billingClass: 'api-continuation', spendGrant: grant } };
  } });
  try {
    const response = await h.send({}, { headers });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, NO_LIVE_LEASE);
    assert.equal(h.upstreamCalls(), 0);
    assert.equal(rows(ledgerPath).length, 0);
    assert.deepEqual(h.brokerCalls.map(c => c.path).filter(p => p !== '/lease/verify'), [], 'no lease, release or settlement');
  } finally { await h.close(); }
}));

test('ordinary unpaid bound session still forwards on a same-model rotated lease', async () => withLedgerDir(async ledgerPath => {
  const h = await makeHarness({ ledgerPath, includePolicy: false, attested: false, brokerImpl: async (path, body, target) => {
    if (path !== '/lease/verify') return { ok: true };
    if (body.leaseID) return { held: false };
    return { held: true, leaseID: 'rotated-lease', target };
  } });
  try {
    assert.equal((await h.send({}, { headers: BOUND_HEADERS })).status, 200);
    assert.equal(h.upstreamCalls(), 1);
  } finally { await h.close(); }
}));

// The grant's policyRevision is the broker's pin of the exact policy it authorized. Spending
// under any other gateway policy fails closed at admission, before prepare, on every path.
const STALE_REVISION = 'a'.repeat(64);
for (const split of [false, true]) test(`grant pinned to another policy revision is refused at admission (${split ? 'split continuation' : 'unpartitioned manual'})`, async t => withLedgerDir(async ledgerPath => {
  const policy = split ? await fundSplit(ledgerPath) : await fundLegacy(ledgerPath);
  assert.notEqual(policy.policyHash, STALE_REVISION);
  const real = await import('../lib/spend-policy.js');
  let prepares = 0;
  const mock = t.mock.module('../lib/spend-policy.js', { exports: { ...real,
    prepareSpendAttempt: args => { prepares += 1; return real.prepareSpendAttempt(args); } } });
  let h;
  try {
    const { createGatewayHandler: handlerFactory } = await import(`../lib/gateway.js?stale-revision-${split}`);
    h = await makeHarness({ ledgerPath, handlerFactory, ...(split ? { policyOverrides: SPLIT } : {}),
      brokerImpl: brokerWith({ billingClass: split ? 'api-continuation' : 'manual-api',
        grant: sessionID => grantFor({ purpose: split ? 'continuation' : 'manual', policyRevision: STALE_REVISION, sessionID }) }) });
    await refusal(h, 'binding_mismatch');
    assert.equal(prepares, 0, 'refused before prepare');
    assert.equal(rows(ledgerPath).length, 0);
  } finally { if (h) await h.close(); mock.restore(); }
}));

test('legacy manual-api without a grant on a split policy surfaces invalid_authorization', async () => withLedgerDir(async ledgerPath => {
  await fundSplit(ledgerPath);
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT });
  try { await refusal(h, 'invalid_authorization'); assert.equal(rows(ledgerPath).length, 0); }
  finally { await h.close(); }
}));

// Default request reserves 100*3 + 10*5 = 350 nanoUSD; a 200 nanoUSD manual reserve cannot hold it.
const TINY_SPLIT = { ceilingUSD: '0.000000400', allocations: { continuationUSD: '0.000000200', manualReserveUSD: '0.000000200', releaseWindowHours: 48 } };
test('a manual grant larger than the remaining manual reserve surfaces allocation_exhausted', async () => withLedgerDir(async ledgerPath => {
  const policy = normalizeSpendPolicy(rawPolicy(ledgerPath, TINY_SPLIT), REGISTERED);
  await initializeLedger({ ledgerPath, policy, now: NOW });
  await fundLedger({ ledgerPath, policy, now: NOW, allocation: allocationFor('0.000000400') });
  const h = await makeHarness({ ledgerPath, policyOverrides: TINY_SPLIT, brokerImpl: brokerWith({ billingClass: 'manual-api',
    grant: sessionID => grantFor({ purpose: 'manual', policyRevision: policy.policyHash, sessionID }) }) });
  try { await refusal(h, 'allocation_exhausted'); assert.equal(rows(ledgerPath).length, 0); }
  finally { await h.close(); }
}));

test('legacy manual-api without a grant on an unpartitioned policy is unchanged', async () => withLedgerDir(async ledgerPath => {
  await fundLegacy(ledgerPath);
  const h = await makeHarness({ ledgerPath });
  try { assert.equal((await h.send()).status, 200); assert.equal(h.upstreamCalls(), 1); }
  finally { await h.close(); }
}));

test('ordinary unclassified lease is unchanged', async () => withLedgerDir(async ledgerPath => {
  const h = await makeHarness({ ledgerPath, includePolicy: false, attested: false });
  try { assert.equal((await h.send()).status, 200); assert.equal(h.upstreamCalls(), 1); }
  finally { await h.close(); }
}));

for (const extra of [{ requiresSpendBudget: false }, { requiresSpendBudget: null }]) test(`api-continuation with ${JSON.stringify(extra)} is invalid_policy`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, brokerImpl: brokerWith({ extra,
    grant: sessionID => grantFor({ policyRevision: policy.policyHash, sessionID }) }) });
  try { await refusal(h, 'invalid_policy'); } finally { await h.close(); }
}));

test('a grant on a target with no declared billing class fails closed', async () => withLedgerDir(async ledgerPath => {
  const policy = await fundSplit(ledgerPath);
  const h = await makeHarness({ ledgerPath, policyOverrides: SPLIT, attested: false, brokerImpl: async (path, body, target) => {
    if (path !== '/lease' && path !== '/lease/verify') return { ok: true };
    return { held: true, leaseID: LEASE_ID, target: { ...target, spendGrant: grantFor({ policyRevision: policy.policyHash, sessionID: body.sessionID }) } };
  } });
  try { await refusal(h, 'invalid_policy'); assert.equal(rows(ledgerPath).length, 0); }
  finally { await h.close(); }
}));
