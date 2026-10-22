import { createHash, randomUUID } from 'node:crypto';
import { lstat, open as openFile, unlink } from 'node:fs/promises';
import { dirname, parse, resolve, sep } from 'node:path';
import { normalizeApiSpendGrant } from '../../lib/api-spend-grant.js';
import { allocationDraw, allocationRetained, fundedAllocation } from './spend-allocations.js';
import { prepareSpendAttempt } from './spend-policy.js';
import { validateSpendReceipt } from './spend-receipt.js';

const MAX = 9223372036854775807n;
const MAX_TIME = 8640000000000000n;
const RATE_KEYS = ['input', 'cacheRead', 'cacheWrite1h', 'output'];
const STATES = ['DISPATCH_COMMITTED', 'SETTLED', 'UNCERTAIN'];
const SIDECARS = ['-wal', '-shm', '-journal'];
// One source of truth for creation AND validation, including constraints and FKs.
// Version 1 owns the whole database: extra objects are not extension points.
const DDL = {
  wallet: 'CREATE TABLE wallet (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER CHECK(schema_version=1), policy_hash TEXT NOT NULL, provider_id TEXT NOT NULL, origin TEXT NOT NULL, credential_sha256 TEXT NOT NULL, funded_nano INTEGER NOT NULL CHECK(funded_nano>=0), available_nano INTEGER NOT NULL CHECK(available_nano>=0), held_nano INTEGER NOT NULL CHECK(held_nano>=0), spent_nano INTEGER NOT NULL CHECK(spent_nano>=0), frozen INTEGER NOT NULL CHECK(frozen IN(0,1)), freeze_reason TEXT, created_at_ms INTEGER NOT NULL)',
  funding_epoch: 'CREATE TABLE funding_epoch (epoch_id TEXT PRIMARY KEY, singleton INTEGER NOT NULL UNIQUE CHECK(singleton=1) REFERENCES wallet(id), reference TEXT NOT NULL UNIQUE, amount_nano INTEGER NOT NULL CHECK(amount_nano>0), confirmed_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, policy_hash TEXT NOT NULL, provider_id TEXT NOT NULL, origin TEXT NOT NULL, credential_sha256 TEXT NOT NULL)',
  attempts: "CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, epoch_id TEXT NOT NULL REFERENCES funding_epoch(epoch_id), state TEXT NOT NULL CHECK(state IN('DISPATCH_COMMITTED','SETTLED','UNCERTAIN')), request_digest TEXT NOT NULL, body_digest TEXT NOT NULL, model TEXT NOT NULL, max_input_tokens INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL, rates_json TEXT NOT NULL, policy_hash TEXT NOT NULL, provider_id TEXT NOT NULL, origin TEXT NOT NULL, credential_sha256 TEXT NOT NULL, reserved_nano INTEGER NOT NULL CHECK(reserved_nano>0), retained_nano INTEGER, receipt_hash TEXT, receipt_json TEXT, message_id TEXT, actual_cost_nano_text TEXT, additional_liability_nano_text TEXT NOT NULL DEFAULT '0', uncertain_reason TEXT, created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER)",
  violations: 'CREATE TABLE violations (violation_id TEXT PRIMARY KEY, attempt_id TEXT REFERENCES attempts(attempt_id), kind TEXT NOT NULL, evidence_hash TEXT NOT NULL, details_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL)',
};
// Version 2 is selected ONLY by an allocation-enabled policy and only for a freshly
// initialized path; a version 1 file is never upgraded. The funding epoch stores its
// immutable split, and every attempt stores its purpose, original per-allocation draw
// and the canonical broker authorization that admitted it.
const DDL_V2 = {
  wallet: 'CREATE TABLE wallet (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER CHECK(schema_version=2), policy_hash TEXT NOT NULL, provider_id TEXT NOT NULL, origin TEXT NOT NULL, credential_sha256 TEXT NOT NULL, funded_nano INTEGER NOT NULL CHECK(funded_nano>=0), available_nano INTEGER NOT NULL CHECK(available_nano>=0), held_nano INTEGER NOT NULL CHECK(held_nano>=0), spent_nano INTEGER NOT NULL CHECK(spent_nano>=0), frozen INTEGER NOT NULL CHECK(frozen IN(0,1)), freeze_reason TEXT, created_at_ms INTEGER NOT NULL)',
  funding_epoch: 'CREATE TABLE funding_epoch (epoch_id TEXT PRIMARY KEY, singleton INTEGER NOT NULL UNIQUE CHECK(singleton=1) REFERENCES wallet(id), reference TEXT NOT NULL UNIQUE, amount_nano INTEGER NOT NULL CHECK(amount_nano>0), confirmed_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, policy_hash TEXT NOT NULL, provider_id TEXT NOT NULL, origin TEXT NOT NULL, credential_sha256 TEXT NOT NULL, continuation_allocated_nano INTEGER NOT NULL CHECK(continuation_allocated_nano>=0), manual_reserve_allocated_nano INTEGER NOT NULL CHECK(manual_reserve_allocated_nano>0))',
  attempts: "CREATE TABLE attempts (attempt_id TEXT PRIMARY KEY, epoch_id TEXT NOT NULL REFERENCES funding_epoch(epoch_id), state TEXT NOT NULL CHECK(state IN('DISPATCH_COMMITTED','SETTLED','UNCERTAIN')), request_digest TEXT NOT NULL, body_digest TEXT NOT NULL, model TEXT NOT NULL, max_input_tokens INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL, rates_json TEXT NOT NULL, policy_hash TEXT NOT NULL, provider_id TEXT NOT NULL, origin TEXT NOT NULL, credential_sha256 TEXT NOT NULL, reserved_nano INTEGER NOT NULL CHECK(reserved_nano>0), retained_nano INTEGER, receipt_hash TEXT, receipt_json TEXT, message_id TEXT, actual_cost_nano_text TEXT, additional_liability_nano_text TEXT NOT NULL DEFAULT '0', uncertain_reason TEXT, created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER, spend_purpose TEXT NOT NULL CHECK(spend_purpose IN('manual','continuation')), continuation_reserved_nano INTEGER NOT NULL CHECK(continuation_reserved_nano>=0), manual_reserve_reserved_nano INTEGER NOT NULL CHECK(manual_reserve_reserved_nano>=0), authorization_json TEXT NOT NULL, authorization_hash TEXT NOT NULL)",
  violations: DDL.violations,
};
const INDEXES = { wallet: [], funding_epoch: [['epoch_id'], ['singleton'], ['reference']], attempts: [['attempt_id']], violations: [['violation_id']] };
const PURPOSES = ['manual', 'continuation'];
const schemaVersionOf = policy => policy.allocations ? 2 : 1;

function error(code, message = code, cause) { return Object.assign(new Error(message, cause ? { cause } : undefined), { code }); }
function fail(code, message = code) { throw error(code, message); }
function requireValid(condition, message = 'invalid ledger state') { if (!condition) fail('invalid_ledger', message); }
function json(value) {
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${json(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function parsedJSON(text) {
  requireValid(typeof text === 'string');
  let value;
  try { value = JSON.parse(text); } catch (cause) { if (!(cause instanceof SyntaxError)) throw cause; fail('invalid_ledger', 'invalid stored JSON'); }
  requireValid(json(value) === text, 'noncanonical stored JSON');
  return value;
}
const isUUID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function money(value) { requireValid(typeof value === 'bigint' && value >= 0n && value <= MAX, 'invalid INTEGER money'); return value; }
function moneyText(value) { requireValid(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), 'invalid TEXT money'); return BigInt(value); }
function time(value) { requireValid(Number.isSafeInteger(value) && value >= 0 && value <= Number(MAX_TIME), 'invalid timestamp'); return value; }
function storedTime(value) { requireValid(typeof value === 'bigint' && value >= 0n && value <= MAX_TIME, 'invalid INTEGER timestamp'); return Number(value); }
function isoTime(value) {
  requireValid(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), 'invalid allocation time');
  const result = time(Date.parse(value)); requireValid(new Date(result).toISOString() === value, 'invalid allocation time'); return result;
}
const policyMatch = (row, policy) => row.policy_hash === policy.policyHash && row.provider_id === policy.binding.providerID && row.origin === policy.binding.origin && row.credential_sha256 === policy.binding.credentialSHA256;
const canonicalRates = rates => json(Object.fromEntries(RATE_KEYS.map(key => [key, rates[key].toString()])));
function parseRates(text) {
  const value = parsedJSON(text);
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4);
  for (const key of RATE_KEYS) requireValid(typeof value[key] === 'string' && /^[1-9]\d*$/.test(value[key]) && BigInt(value[key]) <= MAX, 'invalid rate');
  return Object.fromEntries(RATE_KEYS.map(key => [key, BigInt(value[key])]));
}

// Native diagnostics can contain paths/SQL values. Preserve codes, not raw messages.
function storageError(cause) {
  if (cause?.code?.startsWith('ERR_SQLITE')) {
    const primary = Number.isInteger(cause.errcode) ? cause.errcode & 255 : null;
    const code = primary === 5 || primary === 6 ? 'locked' : 'invalid_ledger';
    return error(code, code === 'locked' ? 'ledger lock timeout' : 'SQLite storage failure', { code: cause.code, sqliteCode: cause.errcode });
  }
  if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'EEXIST', 'ELOOP'].includes(cause?.code)) {
    return error(cause.code === 'ENOENT' ? 'missing_ledger' : 'invalid_ledger', 'ledger filesystem failure', { code: cause.code });
  }
  return cause;
}
function cleanupError(phase, cause, original) {
  const safe = storageError(cause);
  return error('invalid_ledger', `ledger ${phase} failed${original ? ` after ${original.code ?? 'operation failure'}` : ''}`, original ? { original, cleanup: safe } : safe);
}

async function sqlite() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail('unsupported_runtime');
  let module;
  try { module = await import('node:sqlite'); } catch { fail('unsupported_runtime', 'node:sqlite unavailable'); }
  if (typeof module.DatabaseSync !== 'function') fail('unsupported_runtime');
  return module.DatabaseSync;
}
function statement(db, sql) {
  const stmt = db.prepare(sql);
  if (!stmt || !['setReadBigInts', 'get', 'all', 'run'].every(key => typeof stmt[key] === 'function')) fail('unsupported_runtime', 'SQLite statement API unavailable');
  stmt.setReadBigInts(true); return stmt;
}
const rows = (db, sql, params = []) => statement(db, sql).all(...params);
const one = (db, sql, params = []) => statement(db, sql).get(...params);

async function maybeStat(path) {
  try { return await lstat(path); } catch (cause) { if (cause.code === 'ENOENT') return null; throw storageError(cause); }
}
function privateFile(info) {
  requireValid(info.isFile() && !info.isSymbolicLink() && info.uid === process.geteuid() && (info.mode & 0o7177) === 0, 'unsafe ledger file');
}
async function privatePath(path, policy, { creating = false } = {}) {
  requireValid(typeof path === 'string' && path.startsWith('/') && path === resolve(path), 'noncanonical ledger path');
  if (path !== policy.ledgerPath) fail('binding_mismatch', 'ledger path differs from policy');
  let current = parse(path).root;
  const ancestors = [current];
  for (const part of dirname(path).slice(current.length).split(sep).filter(Boolean)) {
    current = current === sep ? `${sep}${part}` : `${current}${sep}${part}`;
    ancestors.push(current);
  }
  for (const current of ancestors) {
    const info = await maybeStat(current);
    if (!info) fail('missing_ledger', 'ledger parent missing');
    requireValid(info.isDirectory() && !info.isSymbolicLink(), 'unsafe ancestor');
    requireValid(!(info.mode & 0o022) || (info.uid === 0 && (info.mode & 0o1000)), 'writable ancestor');
    if (current === dirname(path)) requireValid(info.uid === process.geteuid() && (info.mode & 0o7777) === 0o700, 'unsafe ledger parent');
  }
  requireValid(dirname(path) !== '/', 'unsafe ledger parent');
  const main = await maybeStat(path);
  if (creating) requireValid(main === null, 'ledger already exists');
  else { if (!main) fail('missing_ledger'); privateFile(main); }
  for (const suffix of SIDECARS) {
    const info = await maybeStat(path + suffix);
    if (info) { privateFile(info); requireValid(!creating && suffix !== '-journal', 'unexpected journal artifact'); }
  }
  return main;
}
function configure(db, creating) {
  if (!['prepare', 'exec', 'close'].every(key => typeof db[key] === 'function')) fail('unsupported_runtime', 'SQLite database API unavailable');
  try {
    if (one(db, 'SELECT 9223372036854775807 AS exact').exact !== MAX) fail('unsupported_runtime', 'SQLite exact integers unavailable');
  } catch (cause) {
    if (cause.code === 'ERR_OUT_OF_RANGE') fail('unsupported_runtime', 'SQLite exact integers unavailable');
    throw cause;
  }
  db.exec('PRAGMA busy_timeout = 1000');
  db.exec('PRAGMA foreign_keys = ON');
  // An implicit open must not turn a foreign/empty database into a WAL ledger.
  if (!creating) requireValid(one(db, 'PRAGMA journal_mode').journal_mode === 'wal', 'ledger is not WAL');
  requireValid(one(db, 'PRAGMA journal_mode = WAL').journal_mode === 'wal', 'WAL unavailable');
  db.exec('PRAGMA synchronous = FULL');
  requireValid(one(db, 'PRAGMA foreign_keys').foreign_keys === 1n && one(db, 'PRAGMA busy_timeout').timeout === 1000n && one(db, 'PRAGMA synchronous').synchronous === 2n && one(db, 'PRAGMA journal_mode').journal_mode === 'wal', 'required SQLite durability unavailable');
}

// In-process exclusion per ledger path. SQLite's busy_timeout waits SYNCHRONOUSLY,
// so a second same-process connection reaching BEGIN IMMEDIATE while the first holds
// it across an awaited filesystem check would block the very event loop the first
// needs to finish, then fail as `locked`. Cross-process exclusion stays SQLite's job.
// Each queue token is a promise that only ever RESOLVES, so a failed operation can
// never reject (poison) a later waiter or leave an unhandled rejection. The entry is
// deleted only by the operation that still owns the tail, so idle ledgers leave no
// Map growth and independent ledgers never wait on each other.
const ledgerQueues = new Map();
async function exclusive(key, operation) {
  const previous = ledgerQueues.get(key);
  let release;
  const token = new Promise(resolve => { release = resolve; });
  ledgerQueues.set(key, token);
  try {
    if (previous) await previous;
    return await operation();
  } finally {
    release();
    if (ledgerQueues.get(key) === token) ledgerQueues.delete(key);
  }
}

// The WHOLE connection lifecycle is exclusive: path validation, open, configure,
// action, final path checks, close and artifact capture. Releasing any earlier would
// let the next connection open while this one is still cleaning up.
function connected(args, action, options) {
  return exclusive(args?.ledgerPath, () => connectedExclusive(args, action, options));
}
async function connectedExclusive(args, action, { creating = false, capture } = {}) {
  const { ledgerPath, policy, now } = args; time(now);
  const info = await privatePath(ledgerPath, policy);
  if (!creating) requireValid(info.size >= 100, 'empty or truncated ledger');
  const DatabaseSync = await sqlite();
  let db; let failure; let result;
  try {
    db = new DatabaseSync(ledgerPath);
    configure(db, creating);
    await privatePath(ledgerPath, policy);
    result = await action(db);
    await privatePath(ledgerPath, policy);
  } catch (cause) { failure = storageError(cause); }
  finally {
    if (capture) {
      try { await capture(); } catch (cause) { failure = cleanupError('artifact capture', cause, failure); }
    }
    if (db) {
      try { db.close(); } catch (cause) { failure = cleanupError('close', cause, failure); }
    }
  }
  if (failure) throw failure;
  await privatePath(ledgerPath, policy);
  return result;
}

function storedAttempt(row) {
  return { attemptID: row.attempt_id, epochID: row.epoch_id, requestDigest: row.request_digest, bodyDigest: row.body_digest, policyHash: row.policy_hash, providerID: row.provider_id, origin: row.origin, credentialFingerprint: row.credential_sha256, model: row.model, maxInputTokens: Number(row.max_input_tokens), maxOutputTokens: Number(row.max_output_tokens), ratesNanoUSD: parseRates(row.rates_json), reserveNano: money(row.reserved_nano) };
}
function storedReceipt(row, text) {
  try { return validateSpendReceipt({ attempt: storedAttempt(row), evidence: parsedJSON(text) }); }
  catch (cause) { if (cause.code === 'invalid_receipt') fail('invalid_ledger', 'invalid stored receipt'); throw cause; }
}
const refundEnabled = policy => policy.reconcileUsage === true && !!policy.billingReceiptContract;
function receiptDetails(receipt) {
  return { evidence: receipt.evidence, boundsViolated: receipt.boundsViolated, actualCostNano: receipt.actualCostNano.toString(), additionalLiabilityNano: receipt.additionalLiabilityNano.toString() };
}
const sha256 = text => createHash('sha256').update(text).digest('hex');
// Stored allocation arithmetic that cannot be satisfied is ledger corruption, not a
// new refusal class; only admission-time draws surface allocation_exhausted.
function storedAllocation(compute) {
  try { return compute(); } catch (cause) { if (cause.code === 'invalid_allocation') fail('invalid_ledger', 'invalid stored allocation'); throw cause; }
}
// The authorization is re-proved from the row alone: canonical bytes, their hash,
// and a grant valid AT ITS ROW'S CREATION TIME (not now, so history stays settleable
// after expiry) bound to this row's provider, the registered target, the registered
// model (which the row's model must equal, even when the policy approves others) and
// policy. The request digest was computed over this grant at admission; final
// headers/body are deliberately not stored, so the digest cannot be recomputed here.
function validateAuthorization(row, policy) {
  requireValid(row.model === policy.registeredIdentity.modelID, 'registered model mismatch');
  const value = parsedJSON(row.authorization_json);
  requireValid(isDigest(row.authorization_hash) && row.authorization_hash === sha256(row.authorization_json), 'authorization hash mismatch');
  let grant;
  try { grant = normalizeApiSpendGrant(value, { now: storedTime(row.created_at_ms), targetID: policy.registeredIdentity.targetID, providerID: row.provider_id, modelID: policy.registeredIdentity.modelID }); }
  catch (cause) { if (cause.code === 'invalid_authorization') fail('invalid_ledger', 'invalid stored authorization'); throw cause; }
  requireValid(json(grant) === row.authorization_json && grant.purpose === row.spend_purpose && grant.policyRevision === policy.policyHash, 'authorization binding mismatch');
}
const bucket = funded => ({ funded, held: 0n, spent: 0n });

function validateSchema(db, policy) {
  const version = schemaVersionOf(policy); const split = version === 2;
  const objects = rows(db, 'SELECT type,name,tbl_name,sql FROM sqlite_schema');
  const expected = Object.entries(split ? DDL_V2 : DDL).map(([name, sql]) => ({ type: 'table', name, tbl_name: name, sql }));
  for (const [table, indexes] of Object.entries(INDEXES)) for (let i = 0; i < indexes.length; i++) expected.push({ type: 'index', name: `sqlite_autoindex_${table}_${i + 1}`, tbl_name: table, sql: null });
  const ordered = list => [...list].sort((a, b) => a.name.localeCompare(b.name));
  requireValid(json(ordered(objects)) === json(ordered(expected)), 'unexpected schema');
  requireValid(one(db, 'PRAGMA user_version').user_version === BigInt(version), 'unknown schema version');
  const checks = rows(db, 'PRAGMA quick_check');
  requireValid(checks.length === 1 && checks[0].quick_check === 'ok' && rows(db, 'PRAGMA foreign_key_check').length === 0, 'database integrity failed');
  // quick_check deliberately omits UNIQUE and index/table correspondence.
  // A structurally valid index with a damaged key must not authorize spending.
  const integrity = rows(db, 'PRAGMA integrity_check');
  requireValid(integrity.length === 1 && integrity[0].integrity_check === 'ok', 'index integrity failed');
  for (const [table, indexes] of Object.entries(INDEXES)) {
    const actual = rows(db, `PRAGMA index_list(${table})`);
    requireValid(actual.length === indexes.length);
    for (let i = 0; i < indexes.length; i++) {
      const name = `sqlite_autoindex_${table}_${i + 1}`;
      const index = actual.find(row => row.name === name);
      requireValid(index && index.unique === 1n && index.partial === 0n && index.origin === (i === 0 ? 'pk' : 'u'), 'invalid index');
      requireValid(json(rows(db, `PRAGMA index_info(${name})`).map(row => row.name)) === json(indexes[i]), 'invalid index columns');
    }
  }
  const wallets = rows(db, 'SELECT * FROM wallet');
  requireValid(wallets.length === 1 && wallets[0].id === 1n && wallets[0].schema_version === BigInt(version) && policyMatch(wallets[0], policy), 'wallet binding mismatch');
  const wallet = wallets[0]; storedTime(wallet.created_at_ms);
  for (const key of ['funded_nano', 'available_nano', 'held_nano', 'spent_nano']) money(wallet[key]);
  requireValid(wallet.funded_nano <= policy.ceilingNano && [0n, 1n].includes(wallet.frozen));
  const epochs = rows(db, 'SELECT * FROM funding_epoch'); requireValid(epochs.length <= 1);
  const epoch = epochs[0] ?? null;
  if (epoch) {
    requireValid(isUUID(epoch.epoch_id) && epoch.singleton === 1n && nonempty(epoch.reference) && policyMatch(epoch, policy));
    requireValid(money(epoch.amount_nano) > 0n && epoch.amount_nano === wallet.funded_nano);
    const confirmed = storedTime(epoch.confirmed_at_ms); const expires = storedTime(epoch.expires_at_ms);
    requireValid(confirmed < expires && expires <= policy.validUntilMs && wallet.created_at_ms < epoch.expires_at_ms, 'invalid epoch times');
  } else requireValid(wallet.funded_nano === 0n);
  // Per-allocation contributions are recomputed from every historical row, exactly
  // like the global sums; nothing is cached or carried between transactions.
  let allocation = null;
  if (split) {
    let funded = { continuationFundedNano: 0n, manualReserveFundedNano: 0n };
    if (epoch) {
      funded = storedAllocation(() => fundedAllocation({ fundedNano: epoch.amount_nano, allocations: policy.allocations }));
      requireValid(money(epoch.continuation_allocated_nano) === funded.continuationFundedNano && money(epoch.manual_reserve_allocated_nano) === funded.manualReserveFundedNano, 'funding split mismatch');
    }
    allocation = { continuation: bucket(funded.continuationFundedNano), manualReserve: bucket(funded.manualReserveFundedNano) };
  }
  const attempts = rows(db, 'SELECT * FROM attempts');
  const violations = rows(db, 'SELECT * FROM violations');
  let held = 0n; let spent = 0n;
  for (const row of attempts) {
    let draw = null;
    if (split) {
      requireValid(epoch && PURPOSES.includes(row.spend_purpose), 'invalid spend purpose');
      draw = { continuationReservedNano: money(row.continuation_reserved_nano), manualReserveReservedNano: money(row.manual_reserve_reserved_nano) };
      requireValid(draw.continuationReservedNano + draw.manualReserveReservedNano === row.reserved_nano, 'allocation draw mismatch');
      // Manual is protected-only; continuation may touch protected funds only from U.
      if (row.spend_purpose === 'manual') requireValid(draw.continuationReservedNano === 0n, 'manual draw outside reserve');
      else if (draw.manualReserveReservedNano > 0n) requireValid(row.created_at_ms >= epoch.expires_at_ms - BigInt(policy.allocations.releaseWindowMs), 'reserve drawn before unlock');
      validateAuthorization(row, policy);
    }
    requireValid(epoch && isUUID(row.attempt_id) && row.epoch_id === epoch.epoch_id && STATES.includes(row.state) && policyMatch(row, policy));
    requireValid(isDigest(row.request_digest) && isDigest(row.body_digest) && Object.hasOwn(policy.models, row.model));
    const model = policy.models[row.model];
    requireValid(row.max_input_tokens === BigInt(model.maxInputTokens) && typeof row.max_output_tokens === 'bigint' && row.max_output_tokens > 0n && row.max_output_tokens <= BigInt(model.maxOutputTokens));
    const rates = parseRates(row.rates_json);
    requireValid(row.rates_json === canonicalRates(model.ratesNanoUSD));
    const maximumRate = [rates.input, rates.cacheRead, rates.cacheWrite1h].reduce((a, b) => a > b ? a : b);
    requireValid(money(row.reserved_nano) > 0n && row.reserved_nano === row.max_input_tokens * maximumRate + row.max_output_tokens * rates.output, 'reservation formula mismatch');
    storedTime(row.created_at_ms);
    requireValid(row.created_at_ms >= wallet.created_at_ms && row.created_at_ms >= epoch.confirmed_at_ms && row.created_at_ms < epoch.expires_at_ms && row.created_at_ms < BigInt(policy.validUntilMs));
    const liability = moneyText(row.additional_liability_nano_text);
    let receipt = null;
    if (row.receipt_hash !== null) {
      requireValid(isDigest(row.receipt_hash) && nonempty(row.message_id));
      receipt = storedReceipt(row, row.receipt_json);
      requireValid(json(receipt.evidence) === row.receipt_json && receipt.receiptHash === row.receipt_hash && receipt.messageID === row.message_id && receipt.actualCostNano === moneyText(row.actual_cost_nano_text) && receipt.additionalLiabilityNano === liability, 'receipt mismatch');
    } else requireValid(row.receipt_json === null && row.message_id === null && row.actual_cost_nano_text === null && liability === 0n);
    if (row.state === 'SETTLED') {
      requireValid(receipt && !receipt.boundsViolated && liability === 0n && row.uncertain_reason === null);
      storedTime(row.settled_at_ms); requireValid(row.settled_at_ms >= row.created_at_ms);
      requireValid(money(row.retained_nano) <= row.reserved_nano && row.retained_nano === (refundEnabled(policy) ? receipt.actualCostNano : row.reserved_nano));
      spent += row.retained_nano;
      if (split) {
        // Retained normal-first; any refund therefore reverses the original draw.
        const retained = storedAllocation(() => allocationRetained({ ...draw, retainedNano: row.retained_nano }));
        allocation.continuation.spent += retained.continuationRetainedNano;
        allocation.manualReserve.spent += retained.manualReserveRetainedNano;
      }
    } else {
      requireValid(row.retained_nano === null && row.settled_at_ms === null);
      if (row.state === 'DISPATCH_COMMITTED') requireValid(!receipt && row.uncertain_reason === null);
      else {
        requireValid(nonempty(row.uncertain_reason));
        if (receipt) requireValid((receipt.boundsViolated || liability > 0n) && row.uncertain_reason === 'bounds_violation' && violations.some(v => v.attempt_id === row.attempt_id && v.kind === 'bounds_violation' && v.evidence_hash === receipt.receiptHash));
        else requireValid(row.uncertain_reason !== 'bounds_violation');
      }
      held += row.reserved_nano;
      // Held and uncertain attempts (including frozen violations) keep the FULL
      // original draw; nothing is reclassified at unlock or expiry.
      if (split) {
        allocation.continuation.held += draw.continuationReservedNano;
        allocation.manualReserve.held += draw.manualReserveReservedNano;
      }
    }
  }
  for (const violation of violations) {
    requireValid(isUUID(violation.violation_id) && isDigest(violation.evidence_hash) && ['bounds_violation', 'conflicting_receipt'].includes(violation.kind));
    const attempt = attempts.find(row => row.attempt_id === violation.attempt_id);
    requireValid(attempt && attempt.receipt_hash !== null);
    storedTime(violation.created_at_ms); requireValid(violation.created_at_ms >= attempt.created_at_ms);
    const details = parsedJSON(violation.details_json);
    requireValid(details && typeof details === 'object' && !Array.isArray(details));
    const receipt = storedReceipt(attempt, json(details.evidence));
    requireValid(receipt.receiptHash === violation.evidence_hash && json(details) === json(receiptDetails(receipt)), 'violation evidence mismatch');
    if (violation.kind === 'bounds_violation') requireValid(attempt.state === 'UNCERTAIN' && attempt.receipt_hash === receipt.receiptHash && (receipt.boundsViolated || receipt.additionalLiabilityNano > 0n));
    else requireValid(attempt.receipt_hash !== receipt.receiptHash);
  }
  requireValid(violations.length ? wallet.frozen === 1n && violations.some(v => v.kind === wallet.freeze_reason) : wallet.frozen === 0n && wallet.freeze_reason === null, 'freeze/violation mismatch');
  // Never SQL SUM: even corrupt rows must not overflow into a REAL or lose evidence.
  requireValid(wallet.available_nano + wallet.held_nano + wallet.spent_nano === wallet.funded_nano && held === wallet.held_nano && spent === wallet.spent_nano, 'wallet invariant failed');
  if (split) {
    for (const item of Object.values(allocation)) {
      item.available = item.funded - item.held - item.spent;
      requireValid(item.available >= 0n, 'allocation overdrawn');
    }
    requireValid(allocation.continuation.available + allocation.manualReserve.available === wallet.available_nano, 'allocation invariant failed');
  }
  return { wallet, epoch, attempts, allocation };
}

async function transaction(db, args, action, { read = false, initializing = false } = {}) {
  db.exec(read ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    await privatePath(args.ledgerPath, args.policy);
    const before = initializing ? null : validateSchema(db, args.policy);
    const result = action(before);
    validateSchema(db, args.policy);
    await privatePath(args.ledgerPath, args.policy);
    db.exec('COMMIT');
    return result;
  } catch (cause) {
    const original = storageError(cause);
    try { db.exec('ROLLBACK'); } catch (rollback) { throw cleanupError('rollback', rollback, original); }
    throw original;
  }
}
function statusOf(state, policy, now) {
  let observed = 0n; let liability = 0n;
  for (const row of state.attempts) { if (row.actual_cost_nano_text !== null) observed += moneyText(row.actual_cost_nano_text); liability += moneyText(row.additional_liability_nano_text); }
  const base = { schemaVersion: 1, policyHash: policy.policyHash, fundedNano: state.wallet.funded_nano, availableNano: state.wallet.available_nano, heldNano: state.wallet.held_nano, spentNano: state.wallet.spent_nano, observedCostNano: observed, additionalLiabilityNano: liability, frozen: state.wallet.frozen === 1n, expired: now >= policy.validUntilMs || (state.epoch !== null && now >= storedTime(state.epoch.expires_at_ms)), epochID: state.epoch?.epoch_id ?? null, reference: state.epoch?.reference ?? null, attemptCounts: Object.freeze(Object.fromEntries(STATES.map(key => [key, state.attempts.filter(row => row.state === key).length]))) };
  if (!state.allocation) return Object.freeze(base);
  const view = item => Object.freeze({ fundedNano: item.funded, availableNano: item.available, heldNano: item.held, spentNano: item.spent });
  // Unlock is an eligibility instant evaluated at admission, never a transfer and
  // never new money. A frozen or expired wallet advertises no permission to draw.
  const epochExpiresAtMs = state.epoch ? storedTime(state.epoch.expires_at_ms) : null;
  const reserveUnlockAtMs = epochExpiresAtMs === null ? null : epochExpiresAtMs - policy.allocations.releaseWindowMs;
  const reserveWindowOpen = epochExpiresAtMs !== null && now >= reserveUnlockAtMs && now < epochExpiresAtMs && now < policy.validUntilMs;
  const continuationMayUseReserve = reserveWindowOpen && state.wallet.frozen === 0n && state.allocation.manualReserve.available > 0n;
  // Echo of the registered paid identity bound into the policy hash, so an operator
  // can compare it before funding. Legacy (schema 1) status keys stay unchanged.
  const { targetID, providerID, modelID } = policy.registeredIdentity;
  return Object.freeze({ ...base, schemaVersion: 2, registeredIdentity: Object.freeze({ targetID, providerID, modelID }), allocations: Object.freeze({ continuation: view(state.allocation.continuation), manualReserve: view(state.allocation.manualReserve) }), epochExpiresAtMs, reserveUnlockAtMs, reserveWindowOpen, continuationMayUseReserve });
}

export async function initializeLedger(args) {
  const { ledgerPath, policy, now } = args; time(now);
  await privatePath(ledgerPath, policy, { creating: true });
  // Load before creating anything; unsupported runtimes leave no empty file.
  await sqlite();
  const owned = new Map(); let handle; let failure; let result;
  const capture = async () => {
    for (const path of [ledgerPath, ...SIDECARS.map(s => ledgerPath + s)]) {
      const info = await maybeStat(path);
      if (info && !owned.has(path)) { privateFile(info); owned.set(path, info); }
    }
  };
  try {
    handle = await openFile(ledgerPath, 'wx', 0o600);
    owned.set(ledgerPath, await handle.stat());
    await handle.sync();
    await handle.close(); handle = null;
    result = await connected(args, db => transaction(db, args, () => {
      // The policy alone selects the exact schema; initialization never funds.
      if (schemaVersionOf(policy) === 2) {
        for (const ddl of Object.values(DDL_V2)) db.exec(ddl);
        db.exec('PRAGMA user_version = 2');
        statement(db, 'INSERT INTO wallet VALUES(1,2,?,?,?,?,0,0,0,0,0,NULL,?)').run(policy.policyHash, policy.binding.providerID, policy.binding.origin, policy.binding.credentialSHA256, now);
        return statusOf(validateSchema(db, policy), policy, now);
      }
      for (const ddl of Object.values(DDL)) db.exec(ddl);
      db.exec('PRAGMA user_version = 1');
      statement(db, 'INSERT INTO wallet VALUES(1,1,?,?,?,?,0,0,0,0,0,NULL,?)').run(policy.policyHash, policy.binding.providerID, policy.binding.origin, policy.binding.credentialSHA256, now);
      return statusOf(validateSchema(db, policy), policy, now);
    }, { initializing: true }), { creating: true, capture });
  } catch (cause) { failure = storageError(cause); }
  finally {
    if (handle) {
      if (!owned.has(ledgerPath)) {
        // The exclusive open succeeded but the first metadata read failed.
        // Recover identity from that same descriptor, never an unrelated path.
        try { owned.set(ledgerPath, await handle.stat()); }
        catch (cause) { failure = cleanupError('initialization identity capture', cause, failure); }
      }
      try { await handle.close(); } catch (cause) { failure = cleanupError('file close', cause, failure); }
    }
    if (failure) {
      // All candidates were absent before exclusive creation. Never delete a
      // preexisting sidecar or an inode substituted after it was captured.
      for (const [path, original] of [...owned].reverse()) {
        try {
          const info = await maybeStat(path);
          if (info) { requireValid(info.ino === original.ino && info.dev === original.dev && info.uid === original.uid, 'initialization artifact changed'); await unlink(path); }
        } catch (cause) { failure = cleanupError('initialization cleanup', cause, failure); }
      }
    }
  }
  if (failure) throw failure;
  return result;
}

export async function fundLedger(args) {
  const { policy, allocation, now } = args;
  return connected(args, db => transaction(db, args, state => {
    requireValid(!state.epoch, 'funding epoch already exists');
    requireValid(allocation && allocation.exclusivePromotionalAllocation === true && nonempty(allocation.reference) && allocation.providerID === policy.binding.providerID && allocation.origin === policy.binding.origin && allocation.credentialFingerprint === policy.binding.credentialSHA256, 'invalid allocation binding');
    const confirmed = isoTime(allocation.confirmedAt); const expires = isoTime(allocation.expiresAt);
    requireValid(confirmed <= now && now < expires && expires <= policy.validUntilMs && now >= storedTime(state.wallet.created_at_ms), 'invalid allocation time');
    requireValid(typeof allocation.amountUSD === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(allocation.amountUSD), 'invalid allocation amount');
    const [whole, fraction = ''] = allocation.amountUSD.split('.');
    const amount = BigInt(whole) * 1000000000n + BigInt((fraction.slice(0, 9) + '000000000').slice(0, 9));
    requireValid(amount > 0n && amount <= policy.ceilingNano && amount <= MAX, 'invalid allocation amount');
    if (policy.allocations) {
      // R <= F <= C+R: the protected reserve is funded first and in full, so a
      // partial balance reduces normal capacity, never the promised reserve.
      const split = storedAllocation(() => fundedAllocation({ fundedNano: amount, allocations: policy.allocations }));
      statement(db, 'INSERT INTO funding_epoch VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), 1, allocation.reference, amount, confirmed, expires, policy.policyHash, policy.binding.providerID, policy.binding.origin, policy.binding.credentialSHA256, split.continuationFundedNano, split.manualReserveFundedNano);
    } else statement(db, 'INSERT INTO funding_epoch VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), 1, allocation.reference, amount, confirmed, expires, policy.policyHash, policy.binding.providerID, policy.binding.origin, policy.binding.credentialSHA256);
    statement(db, 'UPDATE wallet SET funded_nano=?,available_nano=? WHERE id=1').run(amount, amount);
    return statusOf(validateSchema(db, policy), policy, now);
  }));
}

function rebuildPrepared(prepared, policy, now) {
  requireValid(prepared && Array.isArray(prepared.headers), 'invalid prepared attempt');
  // Converting pairs to an object is safe ONLY after rejecting duplicates. A
  // Headers constructor would merge auth values and destroy the same evidence.
  const headers = {}; const seen = new Set();
  for (const pair of prepared.headers) {
    requireValid(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string', 'invalid prepared headers');
    const name = pair[0].toLowerCase(); requireValid(!seen.has(name), 'duplicate prepared header'); seen.add(name);
    Object.defineProperty(headers, pair[0], { value: pair[1], enumerable: true });
  }
  // A split admission re-normalizes the supplied grant at THIS clock against the
  // registered target; the rebuilt digest covers the canonical grant.
  const authorization = policy.allocations ? { targetID: prepared.spendGrant?.targetID, spendGrant: prepared.spendGrant } : {};
  const rebuilt = prepareSpendAttempt({ policy, providerID: prepared.providerID, url: prepared.url, body: prepared.body, headers, credentialFingerprint: prepared.credentialFingerprint, now, ...authorization });
  for (const key of Object.keys(rebuilt)) {
    if (key === 'headers') requireValid(json(rebuilt.headers) === json(prepared.headers), 'prepared headers changed');
    else if (key === 'spendGrant') requireValid(json(rebuilt.spendGrant) === json(prepared.spendGrant), 'prepared authorization changed');
    else if (key === 'ratesNanoUSD') requireValid(prepared[key] && Object.keys(prepared[key]).length === 4 && RATE_KEYS.every(rate => prepared[key][rate] === rebuilt[key][rate]), 'prepared rates changed');
    else requireValid(prepared[key] === rebuilt[key], 'prepared attempt changed');
  }
  return rebuilt;
}
// Runs inside reserveAttempt's single BEGIN IMMEDIATE transaction, after the full
// historical validation produced `state.allocation`. The complete worst-case cost is
// drawn atomically from eligible availability or refused; it is never split into
// extra paid calls. The transaction revalidates everything again before COMMIT.
function reserveSplit(db, state, policy, p, attemptID, now) {
  const grant = p.spendGrant;
  const expiresAtMs = storedTime(state.epoch.expires_at_ms);
  const draw = allocationDraw({ purpose: grant.purpose, reserveNano: p.reserveNano, continuationAvailableNano: state.allocation.continuation.available, manualReserveAvailableNano: state.allocation.manualReserve.available, now, expiresAtMs, releaseWindowMs: policy.allocations.releaseWindowMs });
  const authorization = json(grant);
  statement(db, 'INSERT INTO attempts(attempt_id,epoch_id,state,request_digest,body_digest,model,max_input_tokens,max_output_tokens,rates_json,policy_hash,provider_id,origin,credential_sha256,reserved_nano,created_at_ms,spend_purpose,continuation_reserved_nano,manual_reserve_reserved_nano,authorization_json,authorization_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(attemptID, state.epoch.epoch_id, 'DISPATCH_COMMITTED', p.requestDigest, p.bodyDigest, p.model, p.maxInputTokens, p.maxOutputTokens, canonicalRates(p.ratesNanoUSD), p.policyHash, p.providerID, p.origin, p.credentialFingerprint, p.reserveNano, now, grant.purpose, draw.continuationReservedNano, draw.manualReserveReservedNano, authorization, sha256(authorization));
  statement(db, 'UPDATE wallet SET available_nano=available_nano-?,held_nano=held_nano+? WHERE id=1').run(p.reserveNano, p.reserveNano);
  const snapshot = storedAttempt(one(db, 'SELECT * FROM attempts WHERE attempt_id=?', [attemptID]));
  // The send deadline is the earliest of policy, actual epoch and grant expiry.
  const dispatchDeadlineMs = Math.min(policy.validUntilMs, expiresAtMs, grant.expiresAtMs);
  return Object.freeze({ ...snapshot, ratesNanoUSD: Object.freeze(snapshot.ratesNanoUSD), state: 'DISPATCH_COMMITTED', createdAtMs: now, dispatchDeadlineMs, spendPurpose: grant.purpose, allocationDraw: Object.freeze({ continuationReservedNano: draw.continuationReservedNano, manualReserveReservedNano: draw.manualReserveReservedNano }), spendGrant: grant });
}
export async function reserveAttempt(args) {
  const { policy, prepared, attemptID, now } = args;
  return connected(args, db => transaction(db, args, state => {
    requireValid(isUUID(attemptID), 'attempt ID must be UUID');
    if (state.wallet.frozen === 1n) fail('frozen');
    if (now >= policy.validUntilMs || (state.epoch && now >= storedTime(state.epoch.expires_at_ms))) fail('expired');
    const p = rebuildPrepared(prepared, policy, now);
    if (!state.epoch) fail('insufficient_funds');
    requireValid(!one(db, 'SELECT attempt_id FROM attempts WHERE attempt_id=?', [attemptID]), 'attempt already exists');
    if (policy.allocations) return reserveSplit(db, state, policy, p, attemptID, now);
    if (state.wallet.available_nano < p.reserveNano) fail('insufficient_funds');
    statement(db, 'INSERT INTO attempts(attempt_id,epoch_id,state,request_digest,body_digest,model,max_input_tokens,max_output_tokens,rates_json,policy_hash,provider_id,origin,credential_sha256,reserved_nano,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(attemptID, state.epoch.epoch_id, 'DISPATCH_COMMITTED', p.requestDigest, p.bodyDigest, p.model, p.maxInputTokens, p.maxOutputTokens, canonicalRates(p.ratesNanoUSD), p.policyHash, p.providerID, p.origin, p.credentialFingerprint, p.reserveNano, now);
    statement(db, 'UPDATE wallet SET available_nano=available_nano-?,held_nano=held_nano+? WHERE id=1').run(p.reserveNano, p.reserveNano);
    const snapshot = storedAttempt(one(db, 'SELECT * FROM attempts WHERE attempt_id=?', [attemptID]));
    // The latest instant this reservation may be SENT, from the same validated
    // transaction that admitted it. A caller may wait (queueing, slow storage) between
    // commit and egress; it must recheck its own clock against this, never reopen the
    // ledger or trust a caller-supplied expiry.
    // Epoch expiry is currently <= policy expiry by invariant; min is defensive.
    const dispatchDeadlineMs = Math.min(policy.validUntilMs, storedTime(state.epoch.expires_at_ms));
    return Object.freeze({ ...snapshot, ratesNanoUSD: Object.freeze(snapshot.ratesNanoUSD), state: 'DISPATCH_COMMITTED', createdAtMs: now, dispatchDeadlineMs });
  }));
}

function getAttempt(db, attemptID, now) {
  requireValid(isUUID(attemptID), 'attempt ID must be UUID');
  const row = one(db, 'SELECT * FROM attempts WHERE attempt_id=?', [attemptID]);
  requireValid(row && now >= storedTime(row.created_at_ms), 'invalid attempt or time'); return row;
}
export async function markUncertain(args) {
  const { attemptID, reason, now } = args;
  return connected(args, db => transaction(db, args, () => {
    const row = getAttempt(db, attemptID, now);
    requireValid(nonempty(reason) && reason !== 'bounds_violation', 'invalid uncertainty reason');
    if (row.state === 'DISPATCH_COMMITTED') statement(db, "UPDATE attempts SET state='UNCERTAIN',uncertain_reason=? WHERE attempt_id=?").run(reason, attemptID);
  }));
}
function historical(row, frozen, duplicate) {
  return { state: row.state, duplicate, frozen, retainedNano: row.retained_nano ?? row.reserved_nano, refundedNano: row.retained_nano === null ? 0n : row.reserved_nano - row.retained_nano, actualCostNano: row.actual_cost_nano_text === null ? null : moneyText(row.actual_cost_nano_text), additionalLiabilityNano: moneyText(row.additional_liability_nano_text) };
}
function recordViolation(db, attemptID, kind, receipt, now) {
  statement(db, 'INSERT INTO violations VALUES(?,?,?,?,?,?)').run(randomUUID(), attemptID, kind, receipt.receiptHash, json(receiptDetails(receipt)), now);
  statement(db, 'UPDATE wallet SET frozen=1,freeze_reason=? WHERE id=1').run(kind);
}
export async function settleAttempt(args) {
  const { policy, attemptID, evidence, now } = args;
  const result = await connected(args, db => transaction(db, args, state => {
    const row = getAttempt(db, attemptID, now); const frozen = state.wallet.frozen === 1n;
    let receipt;
    try { receipt = validateSpendReceipt({ attempt: storedAttempt(row), evidence }); }
    catch (cause) {
      if (cause.code !== 'invalid_receipt') throw cause;
      if (row.receipt_hash !== null) return historical(row, frozen, true);
      if (row.state === 'DISPATCH_COMMITTED') statement(db, "UPDATE attempts SET state='UNCERTAIN',uncertain_reason='invalid_receipt' WHERE attempt_id=?").run(attemptID);
      return historical({ ...row, state: 'UNCERTAIN' }, frozen, row.state === 'UNCERTAIN');
    }
    if (row.receipt_hash !== null) {
      if (row.receipt_hash === receipt.receiptHash) return historical(row, frozen, true);
      recordViolation(db, attemptID, 'conflicting_receipt', receipt, now);
      return { freezeAfterCommit: true };
    }
    if (receipt.boundsViolated || receipt.additionalLiabilityNano > 0n) {
      statement(db, "UPDATE attempts SET state='UNCERTAIN',receipt_hash=?,receipt_json=?,message_id=?,actual_cost_nano_text=?,additional_liability_nano_text=?,uncertain_reason='bounds_violation' WHERE attempt_id=?").run(receipt.receiptHash, json(receipt.evidence), receipt.messageID, receipt.actualCostNano.toString(), receipt.additionalLiabilityNano.toString(), attemptID);
      recordViolation(db, attemptID, 'bounds_violation', receipt, now);
      return { freezeAfterCommit: true };
    }
    const refund = refundEnabled(policy) ? row.reserved_nano - receipt.actualCostNano : 0n;
    const retained = row.reserved_nano - refund;
    statement(db, "UPDATE attempts SET state='SETTLED',retained_nano=?,receipt_hash=?,receipt_json=?,message_id=?,actual_cost_nano_text=?,uncertain_reason=NULL,settled_at_ms=? WHERE attempt_id=?").run(retained, receipt.receiptHash, json(receipt.evidence), receipt.messageID, receipt.actualCostNano.toString(), now, attemptID);
    statement(db, 'UPDATE wallet SET held_nano=held_nano-?,spent_nano=spent_nano+?,available_nano=available_nano+? WHERE id=1').run(row.reserved_nano, retained, refund);
    return { state: 'SETTLED', duplicate: false, frozen, retainedNano: retained, refundedNano: refund, actualCostNano: receipt.actualCostNano, additionalLiabilityNano: 0n };
  }));
  // Throw only AFTER the transaction and connection cleanup have succeeded.
  if (result.freezeAfterCommit) fail('frozen');
  return result;
}
export async function inspectStatus(args) {
  return connected(args, db => transaction(db, args, state => statusOf(state, args.policy, args.now), { read: true }));
}
