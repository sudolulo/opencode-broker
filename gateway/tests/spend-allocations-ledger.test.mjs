import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { normalizeSpendPolicy, prepareSpendAttempt } from '../lib/spend-policy.js';
import { initializeLedger, fundLedger, reserveAttempt, settleAttempt, markUncertain, inspectStatus } from '../lib/spend-budget.js';
import { rawPolicy, policyFor, bodyFor, headersFor, allocationFor, evidenceFor, withLedgerDir, NOW, MODEL, OPUS_MODEL, PROVIDER_ID, ORIGIN, FINGERPRINT } from './helpers/spend-fixture.mjs';

const N = 1_000_000_000n;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const E = NOW + 7 * DAY; // actual funding epoch expiry, deliberately not a month end
const U = E - 48 * HOUR; // reserve unlock instant
const TARGET = 'paid-anthropic-target';
const REGISTERED = { targetID: TARGET, providerID: PROVIDER_ID, modelID: MODEL };
// ISOLATED SYNTHETIC EXPOSURE-MATH FIXTURE, NOT a production model bound or price:
// the ONE registered model charges 1 nanoUSD for every token class with a one-token
// input bound, so reserve = 1 + max_tokens exactly and each cost below is chosen by
// an integer max_tokens (all far below Number.MAX_SAFE_INTEGER).
const SYNTHETIC_MODEL = { maxInputTokens: 1, maxOutputTokens: 200_000_000_000,
  ratesNanoUSD: { input: '1', cacheRead: '1', cacheWrite1h: '1', output: '1' } };
const T150 = 149_999_999_999; // reserves exactly $150
const T199 = 198_999_999_999; // reserves exactly $199
const ALMOST = 199_989_999_999; // reserves exactly $199.99
const DOLLAR = 999_999_999; // reserves exactly $1
const CENT = 9_999_999; // reserves exactly $0.01
const T49 = 48_999_999_999; // reserves exactly $49
function splitRaw(ledgerPath, overrides = {}) {
  return rawPolicy(ledgerPath, {
    ceilingUSD: '200',
    allocations: { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 48 },
    validUntil: new Date(NOW + 8 * DAY).toISOString(),
    models: { [MODEL]: SYNTHETIC_MODEL },
    ...overrides,
  });
}
const REFUND = { reconcileUsage: true, billingReceiptContract: { confirmedAt: '2026-10-20T10:00:00.000Z', reference: 'synthetic-contract-fixture' } };
const splitPolicy = (ledgerPath, overrides) => normalizeSpendPolicy(splitRaw(ledgerPath, overrides), REGISTERED);
const fundingFor = (amountUSD, overrides = {}) => allocationFor(amountUSD, { expiresAt: new Date(E).toISOString(), ...overrides });

function grantFor(policy, purpose, { now, model = MODEL, ...overrides }) {
  return {
    version: 1, grantID: randomUUID(), purpose, sessionID: 'session-1', leaseID: 'lease-1', targetID: TARGET,
    providerID: PROVIDER_ID, modelID: model, profile: purpose === 'manual' ? 'Manual Model' : 'auto', tier: 'paid',
    issuedAtMs: now - 1, expiresAtMs: now + 60_000, policyRevision: policy.policyHash,
    source: purpose === 'manual' ? null : { providerID: 'subscription-provider', targetID: 'subscription-target',
      leaseID: 'subscription-lease', modelID: 'subscription-model', quotaObservedAtMs: now - 10, quotaUntilMs: now + HOUR },
    ...overrides,
  };
}
// preparedFor hardcodes NOW, so split admissions are prepared at the tested clock.
const preparedAt = (policy, { purpose, tokens, model = MODEL, now, grant = grantFor(policy, purpose, { now, model }) }) => prepareSpendAttempt({
  policy, providerID: PROVIDER_ID, targetID: TARGET, url: `${ORIGIN}/v1/messages`, body: bodyFor({ model, max_tokens: tokens }),
  headers: headersFor(), credentialFingerprint: FINGERPRINT, now, spendGrant: grant });
const reserve = (args, purpose, tokens, now, attemptID = randomUUID()) =>
  reserveAttempt({ ...args, now, attemptID, prepared: preparedAt(args.policy, { purpose, tokens, now }) });

async function splitLedger(ledgerPath, { amountUSD = '200', overrides } = {}) {
  const policy = splitPolicy(ledgerPath, overrides);
  const args = { ledgerPath, policy, now: NOW };
  await initializeLedger(args);
  if (amountUSD !== null) await fundLedger({ ...args, allocation: fundingFor(amountUSD) });
  return args;
}
const status = (args, now = NOW) => inspectStatus({ ...args, now });
const bucket = value => [value.fundedNano, value.availableNano, value.heldNano, value.spentNano];
const buckets = s => ({ continuation: bucket(s.allocations.continuation), manualReserve: bucket(s.allocations.manualReserve) });
const global = s => [s.fundedNano, s.availableNano, s.heldNano, s.spentNano];
const usage = overrides => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1, ...overrides });
const receipt = overrides => evidenceFor({ model: MODEL, usage: usage(overrides) });
const sha = text => createHash('sha256').update(text).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sql(path, action) {
  const db = new DatabaseSync(path);
  try { return action(db); } finally { db.close(); }
}
function assertExhausted(promise) { return assert.rejects(promise, { code: 'allocation_exhausted' }); }

test('split policy initializes an exact schema2 wallet that advertises no money or reserve permission before funding', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath, { amountUSD: null });
    const s = await status(args);
    assert.equal(s.schemaVersion, 2);
    assert.deepEqual(global(s), [0n, 0n, 0n, 0n]);
    assert.deepEqual(buckets(s), { continuation: [0n, 0n, 0n, 0n], manualReserve: [0n, 0n, 0n, 0n] });
    assert.deepEqual([s.epochExpiresAtMs, s.reserveUnlockAtMs, s.reserveWindowOpen, s.continuationMayUseReserve], [null, null, false, false]);
    assert.ok(Object.isFrozen(s.allocations) && Object.isFrozen(s.allocations.manualReserve));
    // Operators compare the echoed registered identity before funding.
    assert.deepEqual(s.registeredIdentity, REGISTERED);
    assert.ok(Object.isFrozen(s.registeredIdentity));
    sql(ledgerPath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.equal(db.prepare('SELECT schema_version FROM wallet').get().schema_version, 2);
      const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      for (const name of ['continuation_allocated_nano', 'manual_reserve_allocated_nano']) assert.ok(columns('funding_epoch').includes(name), name);
      for (const name of ['spend_purpose', 'continuation_reserved_nano', 'manual_reserve_reserved_nano', 'authorization_json', 'authorization_hash']) assert.ok(columns('attempts').includes(name), name);
    });
    await assert.rejects(reserve(args, 'manual', DOLLAR, NOW), { code: 'insufficient_funds' });
    assert.deepEqual(global(await status(args)), [0n, 0n, 0n, 0n]);
  });
});

test('funding protects the reserve first: 200 -> 150/50, 180 -> 130/50, 50 -> 0/50; below reserve, above ceiling and second epochs are refused', async () => {
  for (const [amountUSD, continuation] of [['200', 150n * N], ['180', 130n * N], ['50', 0n]]) await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath, { amountUSD });
    const s = await status(args);
    assert.deepEqual(buckets(s), { continuation: [continuation, continuation, 0n, 0n], manualReserve: [50n * N, 50n * N, 0n, 0n] });
    assert.deepEqual([s.epochExpiresAtMs, s.reserveUnlockAtMs, s.reserveWindowOpen, s.continuationMayUseReserve], [E, U, false, false]);
    sql(ledgerPath, db => {
      const stmt = db.prepare('SELECT continuation_allocated_nano AS c, manual_reserve_allocated_nano AS m FROM funding_epoch'); stmt.setReadBigInts(true);
      assert.deepEqual({ ...stmt.get() }, { c: continuation, m: 50n * N });
    });
    for (const again of ['200', '1']) await assert.rejects(fundLedger({ ...args, allocation: fundingFor(again, { reference: `second-${again}` }) }), { code: 'invalid_ledger' });
    assert.deepEqual(await status(args), s);
  });
  for (const amountUSD of ['49.999999999', '1', '200.000000001']) await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath, { amountUSD: null }); const before = await status(args);
    await assert.rejects(fundLedger({ ...args, allocation: fundingFor(amountUSD) }), { code: 'invalid_ledger' });
    assert.deepEqual(await status(args), before);
  });
});

test('schema follows policy allocations exactly and never migrates either file version', async () => {
  await withLedgerDir(async ledgerPath => {
    const legacy = { ledgerPath, policy: policyFor(ledgerPath), now: NOW };
    await initializeLedger(legacy); const bytes = await readFile(ledgerPath);
    await assert.rejects(inspectStatus({ ...legacy, policy: splitPolicy(ledgerPath) }), { code: 'invalid_ledger' });
    await assert.rejects(fundLedger({ ...legacy, policy: splitPolicy(ledgerPath), allocation: fundingFor('200') }), { code: 'invalid_ledger' });
    assert.deepEqual(await readFile(ledgerPath), bytes);
    sql(ledgerPath, db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1));
    const legacyStatus = await inspectStatus(legacy);
    assert.equal(legacyStatus.schemaVersion, 1);
    assert.equal(Object.hasOwn(legacyStatus, 'registeredIdentity'), false, 'legacy status keys are unchanged');
  });
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath); const bytes = await readFile(ledgerPath);
    // Same hash domain is impossible, so also prove the schema itself is what refuses:
    // a v2 file rewritten to the split policy's v1 identity is still not v1.
    await assert.rejects(inspectStatus({ ...args, policy: policyFor(ledgerPath) }), { code: 'invalid_ledger' });
    assert.deepEqual(await readFile(ledgerPath), bytes);
    sql(ledgerPath, db => { db.exec('PRAGMA ignore_check_constraints=ON'); db.exec('UPDATE wallet SET schema_version=1'); });
    await assert.rejects(status(args), { code: 'invalid_ledger' });
  });
});

test('before unlock, manual draws only protected funds and continuation only normal funds', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath); const now = U - 1;
    await assertExhausted(reserve(args, 'continuation', ALMOST, now));
    await assertExhausted(reserve(args, 'manual', T199, now)); // spare normal funds never cover manual
    const grant = grantFor(args.policy, 'continuation', { now, model: MODEL });
    const first = await reserveAttempt({ ...args, now, attemptID: randomUUID(), prepared: preparedAt(args.policy, { tokens: T150, now, grant }) });
    assert.equal(first.spendPurpose, 'continuation');
    assert.deepEqual({ ...first.allocationDraw }, { continuationReservedNano: 150n * N, manualReserveReservedNano: 0n });
    assert.deepEqual(first.spendGrant, grant);
    assert.equal(first.dispatchDeadlineMs, grant.expiresAtMs, 'grant expiry bounds the send deadline');
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first.allocationDraw) && Object.isFrozen(first.spendGrant) && Object.isFrozen(first.spendGrant.source));
    await assertExhausted(reserve(args, 'continuation', CENT, now));
    const s = await status(args, now);
    assert.deepEqual([s.reserveWindowOpen, s.continuationMayUseReserve], [false, false]);
    const manual = await reserve(args, 'manual', DOLLAR, now);
    assert.deepEqual({ ...manual.allocationDraw }, { continuationReservedNano: 0n, manualReserveReservedNano: N });
    assert.equal(manual.spendGrant.source, null);
    assert.deepEqual(buckets(await status(args, now)), { continuation: [150n * N, 0n, 150n * N, 0n], manualReserve: [50n * N, 49n * N, N, 0n] });
    const row = sql(ledgerPath, db => db.prepare('SELECT spend_purpose,authorization_json,authorization_hash FROM attempts WHERE attempt_id=?').get(first.attemptID));
    assert.equal(row.spend_purpose, 'continuation');
    assert.equal(row.authorization_json, canonical(grant));
    assert.equal(row.authorization_hash, sha(row.authorization_json));
  });
});

test('unlock is inclusive at U, protected remainder serves continuation through E-1, and E refuses', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath);
    const atU = await status(args, U);
    assert.deepEqual([atU.reserveWindowOpen, atU.continuationMayUseReserve], [true, true]);
    const mixed = await reserve(args, 'continuation', T199, U);
    assert.deepEqual({ ...mixed.allocationDraw }, { continuationReservedNano: 150n * N, manualReserveReservedNano: 49n * N });
    assert.deepEqual(buckets(await status(args, U)), { continuation: [150n * N, 0n, 150n * N, 0n], manualReserve: [50n * N, N, 49n * N, 0n] });
    const last = await reserve(args, 'continuation', CENT, E - 1);
    assert.deepEqual({ ...last.allocationDraw }, { continuationReservedNano: 0n, manualReserveReservedNano: 10_000_000n });
    assert.equal(last.dispatchDeadlineMs, E, 'epoch expiry bounds a longer grant');
    for (const purpose of ['manual', 'continuation']) await assert.rejects(reserve(args, purpose, CENT, E), { code: 'expired' });
    const atE = await status(args, E);
    assert.deepEqual([atE.expired, atE.reserveWindowOpen, atE.continuationMayUseReserve], [true, false, false]);
    assert.deepEqual(global(atE), [200n * N, 990_000_000n, 199_010_000_000n, 0n]);
  });
});

test('held, uncertain and settled protected funds are never released at unlock', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath);
    await reserve(args, 'continuation', T150, NOW);
    await reserve(args, 'manual', DOLLAR, NOW);
    const uncertain = await reserve(args, 'manual', DOLLAR, NOW);
    await markUncertain({ ...args, attemptID: uncertain.attemptID, reason: 'network_failure' });
    const burned = await reserve(args, 'manual', DOLLAR, NOW);
    const result = await settleAttempt({ ...args, attemptID: burned.attemptID, evidence: receipt() });
    assert.deepEqual([result.retainedNano, result.refundedNano], [N, 0n], 'default burn retains the whole reservation');
    await assertExhausted(reserve(args, 'continuation', T199, U));
    const s = await status(args, U);
    assert.deepEqual(buckets(s), { continuation: [150n * N, 0n, 150n * N, 0n], manualReserve: [50n * N, 47n * N, 2n * N, N] });
    assert.equal(s.continuationMayUseReserve, true);
    assert.deepEqual({ ...(await reserve(args, 'continuation', DOLLAR, U)).allocationDraw }, { continuationReservedNano: 0n, manualReserveReservedNano: N });
  });
});

test('confirmed refunds reverse the original normal-first draw and never move between allocations', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath, { overrides: REFUND });
    const small = await reserve(args, 'continuation', T199, U);
    assert.equal((await settleAttempt({ ...args, now: U, attemptID: small.attemptID, evidence: receipt() })).retainedNano, 1n);
    assert.deepEqual(buckets(await status(args, U)), { continuation: [150n * N, 150n * N - 1n, 0n, 1n], manualReserve: [50n * N, 50n * N, 0n, 0n] });
  });
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath, { overrides: REFUND });
    const large = await reserve(args, 'continuation', T199, U);
    // Actual cost 1 + (199N - 2) = 199N - 1: above the normal draw, one nano refunded.
    const settled = await settleAttempt({ ...args, now: U, attemptID: large.attemptID, evidence: receipt({ input_tokens: 1, output_tokens: 198_999_999_998 }) });
    assert.deepEqual([settled.retainedNano, settled.refundedNano], [199n * N - 1n, 1n]);
    assert.deepEqual(buckets(await status(args, U)), { continuation: [150n * N, 0n, 0n, 150n * N], manualReserve: [50n * N, N + 1n, 0n, 49n * N - 1n] });
    const manual = await reserve(args, 'manual', DOLLAR, U);
    await settleAttempt({ ...args, now: U, attemptID: manual.attemptID, evidence: receipt() });
    assert.deepEqual(buckets(await status(args, U)), { continuation: [150n * N, 0n, 0n, 150n * N], manualReserve: [50n * N, N, 0n, 49n * N] });
  });
});

test('violations freeze with the original draw held, suppress reserve permission, and history settles after expiry', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath);
    const normal = await reserve(args, 'continuation', T150, U);
    const manual = await reserve(args, 'manual', DOLLAR, U);
    // Two input tokens exceed the synthetic one-token input bound: a bounds violation.
    await assert.rejects(settleAttempt({ ...args, now: U, attemptID: manual.attemptID, evidence: receipt({ input_tokens: 2 }) }), { code: 'frozen' });
    const frozen = await status(args, U);
    assert.deepEqual([frozen.frozen, frozen.reserveWindowOpen, frozen.continuationMayUseReserve], [true, true, false]);
    assert.deepEqual(buckets(frozen), { continuation: [150n * N, 0n, 150n * N, 0n], manualReserve: [50n * N, 49n * N, N, 0n] });
    await assert.rejects(reserve(args, 'continuation', DOLLAR, U), { code: 'frozen' });
    const late = E + 1; // grant and epoch long expired; the historic receipt still settles its own hold
    assert.equal((await settleAttempt({ ...args, now: late, attemptID: normal.attemptID, evidence: receipt() })).state, 'SETTLED');
    const after = await status(args, late);
    assert.deepEqual(buckets(after), { continuation: [150n * N, 0n, 0n, 150n * N], manualReserve: [50n * N, 49n * N, N, 0n] });
    assert.deepEqual([after.expired, after.continuationMayUseReserve], [true, false]);
  });
});

test('reserve rebuilds the prepared attempt and compares its canonical grant by value', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath); const before = await status(args);
    const prepared = preparedAt(args.policy, { purpose: 'manual', tokens: DOLLAR, now: NOW });
    const swapped = preparedAt(args.policy, { purpose: 'manual', tokens: DOLLAR, now: NOW });
    await assert.rejects(reserveAttempt({ ...args, attemptID: randomUUID(), prepared: { ...prepared, spendGrant: swapped.spendGrant } }), { code: 'invalid_ledger' });
    // A continuation grant without source evidence fails grant normalization itself.
    await assert.rejects(reserveAttempt({ ...args, attemptID: randomUUID(), prepared: { ...prepared, spendGrant: { ...prepared.spendGrant, purpose: 'continuation' } } }), { code: 'invalid_authorization' });
    const { spendGrant: _omitted, ...withoutGrant } = prepared;
    await assert.rejects(reserveAttempt({ ...args, attemptID: randomUUID(), prepared: withoutGrant }), { code: 'invalid_authorization' });
    await assert.rejects(reserveAttempt({ ...args, now: NOW + 60_000, attemptID: randomUUID(), prepared }), { code: 'invalid_authorization' });
    assert.deepEqual(await status(args), before);
    const cloned = await reserveAttempt({ ...args, attemptID: randomUUID(), prepared: structuredClone({ ...prepared, ratesNanoUSD: { ...prepared.ratesNanoUSD } }) });
    assert.equal(cloned.spendPurpose, 'manual');
  });
});

function editGrant(edit) {
  return (db, ids) => {
    const row = db.prepare('SELECT authorization_json FROM attempts WHERE attempt_id=?').get(ids.manual);
    const text = canonical(edit(JSON.parse(row.authorization_json)));
    db.prepare('UPDATE attempts SET authorization_json=?,authorization_hash=? WHERE attempt_id=?').run(text, sha(text), ids.manual);
  };
}
const exec = text => (db, ids) => db.exec(text.replaceAll(':manual', `'${ids.manual}'`).replaceAll(':mixed', `'${ids.mixed}'`));
for (const [label, mutation] of [
  ['draw sum', exec('UPDATE attempts SET continuation_reserved_nano=continuation_reserved_nano+1 WHERE attempt_id=:mixed')],
  // Swaps one dollar of provenance so both buckets still balance: only the
  // manual-is-protected-only rule can refuse it.
  ['manual normal draw', exec(`UPDATE attempts SET continuation_reserved_nano=manual_reserve_reserved_nano,manual_reserve_reserved_nano=0 WHERE attempt_id=:manual; UPDATE attempts SET continuation_reserved_nano=continuation_reserved_nano-${N},manual_reserve_reserved_nano=manual_reserve_reserved_nano+${N} WHERE attempt_id=:mixed`)],
  ['protected draw before unlock', exec(`UPDATE attempts SET created_at_ms=${U - 1} WHERE attempt_id=:mixed`)],
  ['purpose differs from grant', exec("UPDATE attempts SET spend_purpose='continuation' WHERE attempt_id=:manual")],
  ['unknown purpose', exec("UPDATE attempts SET spend_purpose='other' WHERE attempt_id=:manual")],
  ['authorization hash', exec(`UPDATE attempts SET authorization_hash='${'a'.repeat(64)}' WHERE attempt_id=:manual`)],
  ['noncanonical authorization', exec("UPDATE attempts SET authorization_json=replace(authorization_json,'{','{ ') WHERE attempt_id=:manual")],
  ['grant model binding', editGrant(grant => ({ ...grant, modelID: 'other-model' }))],
  ['grant provider binding', editGrant(grant => ({ ...grant, providerID: 'other-provider' }))],
  ['grant target binding', editGrant(grant => ({ ...grant, targetID: 'other-target' }))],
  ['grant policy revision', editGrant(grant => ({ ...grant, policyRevision: 'b'.repeat(64) }))],
  ['grant expired at creation', editGrant(grant => ({ ...grant, expiresAtMs: NOW }))],
  ['grant issued after creation', editGrant(grant => ({ ...grant, issuedAtMs: NOW + 1 }))],
  ['grant purpose without source', editGrant(grant => ({ ...grant, purpose: 'continuation' }))],
  ['grant unknown field', editGrant(grant => ({ ...grant, surprise: true }))],
  ['epoch split', exec('UPDATE funding_epoch SET continuation_allocated_nano=continuation_allocated_nano-1,manual_reserve_allocated_nano=manual_reserve_allocated_nano+1')],
  ['user version', exec('PRAGMA user_version=1')],
]) test(`split ledger revalidation refuses corrupted ${label} without repair`, async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath);
    const ids = { manual: (await reserve(args, 'manual', DOLLAR, NOW)).attemptID, mixed: (await reserve(args, 'continuation', T199, U)).attemptID };
    await status(args, U);
    sql(ledgerPath, db => { db.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON'); mutation(db, ids); });
    const bytes = await readFile(ledgerPath);
    await assert.rejects(status(args, U), { code: 'invalid_ledger' });
    await assert.rejects(reserve(args, 'continuation', CENT, U), { code: 'invalid_ledger' });
    await assert.rejects(settleAttempt({ ...args, now: U, attemptID: ids.manual, evidence: receipt() }), { code: 'invalid_ledger' });
    assert.deepEqual(await readFile(ledgerPath), bytes);
  });
});

// NEGATIVE CASES ONLY: a second model the policy approves with the very same synthetic
// bounds and rates, which is NOT the registered paid model. Never used for normal costs.
const TWO_MODELS = { models: { [MODEL]: SYNTHETIC_MODEL, [OPUS_MODEL]: SYNTHETIC_MODEL } };

test('admission refuses an approved but unregistered model even when its grant names that model', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath, { overrides: TWO_MODELS });
    const before = await status(args, U);
    const mismatch = { code: 'invalid_authorization', message: 'spend authorization model mismatch' };
    for (const purpose of ['manual', 'continuation']) {
      const grant = grantFor(args.policy, purpose, { now: U, model: OPUS_MODEL });
      assert.throws(() => preparedAt(args.policy, { purpose, tokens: DOLLAR, model: OPUS_MODEL, now: U, grant }), mismatch);
      // A grant naming the registered model isolates the prepare fence on the body model.
      const registeredGrant = grantFor(args.policy, purpose, { now: U, model: MODEL });
      assert.throws(() => preparedAt(args.policy, { purpose, tokens: DOLLAR, model: OPUS_MODEL, now: U, grant: registeredGrant }), mismatch);
    }
    assert.deepEqual(await status(args, U), before);
    assert.equal((await reserve(args, 'manual', DOLLAR, U)).model, MODEL, 'the registered model is still admitted');
  });
});

test('historical validation refuses a row consistently rewritten to an approved but unregistered model', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath, { overrides: TWO_MODELS });
    const id = (await reserve(args, 'manual', DOLLAR, NOW)).attemptID;
    await status(args);
    // Same bounds, rates and reservation; canonical grant and its hash re-derived for the
    // other model, so only the registered-model fence can refuse the row.
    sql(ledgerPath, db => {
      const row = db.prepare('SELECT authorization_json FROM attempts WHERE attempt_id=?').get(id);
      const text = canonical({ ...JSON.parse(row.authorization_json), modelID: OPUS_MODEL });
      db.prepare('UPDATE attempts SET model=?,authorization_json=?,authorization_hash=? WHERE attempt_id=?').run(OPUS_MODEL, text, sha(text), id);
    });
    const bytes = await readFile(ledgerPath);
    const refused = { code: 'invalid_ledger', message: 'registered model mismatch' };
    await assert.rejects(status(args), refused);
    await assert.rejects(reserve(args, 'manual', CENT, NOW), refused);
    await assert.rejects(settleAttempt({ ...args, attemptID: id, evidence: receipt() }), refused);
    assert.deepEqual(await readFile(ledgerPath), bytes);
  });
});

// Moves one nano of an attempt's ORIGINAL draw from protected to normal. The draw sum,
// purpose, model, creation time, canonical grant/hash, receipt and every global total
// stay valid, so only the per-allocation overdraw guard can refuse it.
const shiftDrawToNormal = (ledgerPath, attemptID) => sql(ledgerPath, db => db.prepare(
  'UPDATE attempts SET continuation_reserved_nano=continuation_reserved_nano+1,manual_reserve_reserved_nano=manual_reserve_reserved_nano-1 WHERE attempt_id=?').run(attemptID));
const OVERDRAWN = { code: 'invalid_ledger', message: 'allocation overdrawn' };

test('a held mixed draw shifted into the normal bucket is refused as an allocation overdraw', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath);
    const mixed = await reserve(args, 'continuation', T199, U);
    assert.deepEqual({ ...mixed.allocationDraw }, { continuationReservedNano: 150n * N, manualReserveReservedNano: 49n * N });
    assert.deepEqual(global(await status(args, U)), [200n * N, N, 199n * N, 0n]);
    shiftDrawToNormal(ledgerPath, mixed.attemptID);
    const bytes = await readFile(ledgerPath);
    await assert.rejects(status(args, U), OVERDRAWN);
    await assert.rejects(reserve(args, 'manual', CENT, U), OVERDRAWN);
    await assert.rejects(settleAttempt({ ...args, now: U, attemptID: mixed.attemptID, evidence: receipt() }), OVERDRAWN);
    assert.deepEqual(await readFile(ledgerPath), bytes);
  });
});

test('a settled refunded mixed draw shifted into the normal bucket is refused as an allocation overdraw', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await splitLedger(ledgerPath, { overrides: REFUND });
    const mixed = await reserve(args, 'continuation', T199, U);
    // Verified actual cost 1 + 150999999999 = $151: normal retains 150, protected 1.
    const settled = await settleAttempt({ ...args, now: U, attemptID: mixed.attemptID, evidence: receipt({ input_tokens: 1, output_tokens: 150_999_999_999 }) });
    assert.deepEqual([settled.retainedNano, settled.refundedNano], [151n * N, 48n * N]);
    const manual = await reserve(args, 'manual', T49, U);
    assert.deepEqual({ ...manual.allocationDraw }, { continuationReservedNano: 0n, manualReserveReservedNano: 49n * N });
    const valid = await status(args, U);
    assert.deepEqual(buckets(valid), { continuation: [150n * N, 0n, 0n, 150n * N], manualReserve: [50n * N, 0n, 49n * N, N] });
    assert.deepEqual(global(valid), [200n * N, 0n, 49n * N, 151n * N]);
    shiftDrawToNormal(ledgerPath, mixed.attemptID);
    const bytes = await readFile(ledgerPath);
    await assert.rejects(status(args, U), OVERDRAWN);
    await assert.rejects(reserve(args, 'manual', CENT, U), OVERDRAWN);
    await assert.rejects(settleAttempt({ ...args, now: U, attemptID: manual.attemptID, evidence: receipt() }), OVERDRAWN);
    assert.deepEqual(await readFile(ledgerPath), bytes);
  });
});

async function finalRace(ledgerPath, prefill, final, contenders) {
  const args = await splitLedger(ledgerPath);
  await reserve(args, 'continuation', prefill, U);
  const results = await contenders(args, final);
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  assert.deepEqual(results.filter(result => !result.ok).map(result => result.code), ['allocation_exhausted']);
  const s = await status(args, U);
  assert.deepEqual(global(s), [200n * N, 0n, 200n * N, 0n]);
  assert.equal(s.allocations.continuation.heldNano + s.allocations.manualReserve.heldNano, 200n * N);
  assert.equal(s.allocations.manualReserve.availableNano, 0n);
}

for (const [label, prefill, final] of [['final dollar', T199, DOLLAR], ['final cent', ALMOST, CENT]]) {
  test(`same-process manual and continuation race for the ${label} at U has exactly one winner`, async () => {
    await withLedgerDir(ledgerPath => finalRace(ledgerPath, prefill, final, async (args, tokens) => {
      const settled = await Promise.allSettled(['manual', 'continuation'].map(purpose => reserve(args, purpose, tokens, U)));
      return settled.map(result => result.status === 'fulfilled' ? { ok: true } : { ok: false, code: result.reason.code });
    }));
  });
  test(`separate-process manual and continuation race for the ${label} at U has exactly one winner`, { timeout: 15000 }, async () => {
    await withLedgerDir(ledgerPath => finalRace(ledgerPath, prefill, final, async (args, maxTokens) => {
      const workers = ['manual', 'continuation'].map(() => worker(ledgerPath, randomUUID()));
      try {
        await Promise.all(workers.map((w, index) => {
          const purpose = index === 0 ? 'manual' : 'continuation';
          return w.send({ type: 'policy', raw: splitRaw(ledgerPath), registered: REGISTERED, split: { now: U, model: MODEL, maxTokens, grant: grantFor(args.policy, purpose, { now: U, model: MODEL }) } });
        }));
        await Promise.all(workers.map(w => w.wait('ready')));
        await Promise.all(workers.map(w => w.send({ type: 'go' })));
        return (await Promise.all(workers.map(w => w.wait('result')))).map(({ ok, code }) => ok ? { ok } : { ok, code });
      } finally { await Promise.all(workers.map(w => w.stop())); }
    }));
  });
}

function worker(ledgerPath, attemptID) {
  const child = fork('gateway/tests/helpers/spend-worker.mjs', ['split-reserve', ledgerPath, attemptID], { cwd: '/home/dev/opencode-broker', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = []; const waiters = new Set(); let stderr = ''; let ended = false;
  child.stderr.on('data', data => { stderr += data; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => { ended = true; for (const w of waiters) w.reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)); resolve({ code, signal }); }));
  child.on('error', cause => { for (const w of waiters) w.reject(cause); });
  child.on('message', message => {
    const waiter = [...waiters].find(w => w.type === message.type);
    if (waiter) waiter.resolve(message); else messages.push(message);
  });
  return {
    send: message => new Promise((resolve, reject) => child.send(message, cause => cause ? reject(cause) : resolve())),
    wait(type) {
      const index = messages.findIndex(m => m.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      if (ended) return Promise.reject(new Error(`worker already exited: ${stderr}`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => waiter.reject(new Error(`worker ${type} deadline: ${stderr}`)), 5000);
        const waiter = { type, resolve(value) { clearTimeout(timer); waiters.delete(waiter); resolve(value); }, reject(cause) { clearTimeout(timer); waiters.delete(waiter); reject(cause); } };
        waiters.add(waiter);
      });
    },
    async stop() {
      if (!ended) child.kill('SIGKILL');
      let timer;
      try { return await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('worker reap deadline')), 3000); })]); }
      finally { clearTimeout(timer); }
    },
  };
}
