import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as realFS from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateSpendReceipt } from '../lib/spend-receipt.js';
import { initializeLedger, fundLedger, reserveAttempt, settleAttempt, markUncertain, inspectStatus } from '../lib/spend-budget.js';
import { withLedgerDir, policyFor, rawPolicy, preparedFor, allocationFor, confirmedRefundPolicy, evidenceFor, snapshotFor, NOW, ATTEMPT_A, ATTEMPT_B, MODEL, TEST_KEY } from './helpers/spend-fixture.mjs';

function sql(path, action) {
  const db = new DatabaseSync(path);
  try { return action(db); } finally { db.close(); }
}

async function setup(ledgerPath, { refund = false, overrides = {}, amount = '0.000000700', reserve = true } = {}) {
  const policy = refund ? confirmedRefundPolicy(ledgerPath) : policyFor(ledgerPath, overrides);
  const args = { ledgerPath, policy, now: NOW };
  await initializeLedger(args);
  if (amount !== null) await fundLedger({ ...args, allocation: allocationFor(amount) });
  if (reserve) await reserveAttempt({ ...args, prepared: preparedFor(policy), attemptID: ATTEMPT_A });
  return args;
}

const balances = s => [s.fundedNano, s.availableNano, s.heldNano, s.spentNano];

// Real SQLite connections with surgical failure injection at the storage boundary.
async function withFault(t, fault, action) {
  const opened = new Set(); const closed = new Set(); const commands = [];
  const proto = DatabaseSync.prototype;
  const realClose = proto.close; const realExec = proto.exec; const realPrepare = proto.prepare;
  const mocks = [t.mock.method(proto, 'close', function () {
    realClose.call(this); closed.add(this);
    if (fault === 'close' || fault === 'rollback-close') throw Object.assign(new Error('synthetic close failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  }), t.mock.method(proto, 'exec', function (text) {
          opened.add(this);
          commands.push(text);
          if (fault === 'commit' && text === 'COMMIT') throw Object.assign(new Error('synthetic commit failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
          const result = realExec.call(this, text);
          if ((fault === 'rollback' || fault === 'rollback-close') && text === 'ROLLBACK') throw Object.assign(new Error('synthetic rollback failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
          return result;
  }), t.mock.method(proto, 'prepare', function (text) {
          opened.add(this);
          commands.push(text); const stmt = realPrepare.call(this, text);
          return new Proxy(stmt, { get(s, name) {
            if (name === 'setReadBigInts' && fault === 'bigints') return undefined;
            if (name === 'setReadBigInts' && fault === 'inexact') return () => {};
            if (name === 'get') return (...params) => {
              const row = s.get(...params);
              if (fault === 'journal' && /PRAGMA journal_mode/i.test(text)) return { journal_mode: 'delete' };
              if (fault === 'busy' && /^PRAGMA busy_timeout$/i.test(text)) return { timeout: 0n };
              if (fault === 'fk' && /^PRAGMA foreign_keys$/i.test(text)) return { foreign_keys: 0n };
              if (fault === 'sync' && /^PRAGMA synchronous$/i.test(text)) return { synchronous: 1n };
              return row;
            };
            const value = s[name]; return typeof value === 'function' ? value.bind(s) : value;
          } });
  })];
  if (fault === 'api') Object.defineProperty(proto, 'prepare', { value: undefined, configurable: true, writable: true });
  try {
    const module = await import(`../lib/spend-budget.js?fault=${fault}-${Math.random()}`);
    await action(module, commands);
  } finally { for (const mock of mocks) mock.mock.restore(); for (const db of opened) assert.ok(closed.has(db), 'every acquired database handle closed'); }
}

for (const fault of ['journal', 'busy', 'fk', 'sync', 'bigints', 'inexact', 'api']) test(`required SQLite ${fault} capability is verified on init and open`, async t => {
  await withLedgerDir(async ledgerPath => {
    const args = { ledgerPath, policy: policyFor(ledgerPath), now: NOW };
    await withFault(t, fault, async module => {
      await assert.rejects(module.initializeLedger(args), { code: ['bigints', 'inexact', 'api'].includes(fault) ? 'unsupported_runtime' : 'invalid_ledger' });
      assert.deepEqual(await readdir(dirname(ledgerPath)), [], 'failed init removes only its new state');
    });
    await initializeLedger(args);
    await withFault(t, fault, async module => {
      await assert.rejects(module.inspectStatus(args), { code: ['bigints', 'inexact', 'api'].includes(fault) ? 'unsupported_runtime' : 'invalid_ledger' });
    });
    assert.equal((await inspectStatus(args)).fundedNano, 0n);
  });
});

for (const fault of ['close', 'rollback', 'rollback-close', 'commit']) test(`storage ${fault} failures are explicit and preserve original refusal`, async t => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { amount: null, reserve: false });
    await withFault(t, fault, async module => {
      if (fault === 'close') await assert.rejects(module.inspectStatus(args), e => e.code === 'invalid_ledger' && /close/.test(e.message));
      else if (fault === 'commit') await assert.rejects(module.fundLedger({ ...args, allocation: allocationFor() }), { code: 'invalid_ledger' });
      else await assert.rejects(module.reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A }), e => {
        const rollback = fault === 'rollback-close' ? e.cause?.original : e;
        return e.code === 'invalid_ledger' && /rollback/.test(rollback.message) && rollback.cause?.original?.code === 'insufficient_funds';
      });
    });
    assert.equal((await inspectStatus(args)).fundedNano, 0n);
  });
});

test('wrong effective uid metadata is refused for parent, DB, WAL and SHM without chown', async t => {
  for (const suffix of ['parent', '', '-wal', '-shm']) await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false });
    const path = suffix === 'parent' ? dirname(ledgerPath) : ledgerPath + suffix;
    if (suffix.startsWith('-')) await writeFile(path, 'SENTINEL', { mode: 0o600 });
    const mock = t.mock.module('node:fs/promises', { exports: { ...realFS, lstat: async (...params) => {
      const info = await realFS.lstat(...params); if (params[0] === path) info.uid = process.geteuid() + 1; return info;
    } } });
    try {
      const module = await import(`../lib/spend-budget.js?uid=${suffix}`);
      await assert.rejects(module.inspectStatus(args), { code: 'invalid_ledger' });
      if (suffix.startsWith('-')) assert.equal(await readFile(path, 'utf8'), 'SENTINEL');
    } finally { mock.restore(); }
  });
});

test('unexpected receipt programming error propagates without making a storage success', async t => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath);
    const mock = t.mock.module('../lib/spend-receipt.js', { exports: { validateSpendReceipt() { throw new TypeError('synthetic receipt bug'); } } });
    try {
      const module = await import('../lib/spend-budget.js?receipt-fault');
      await assert.rejects(module.settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor() }), { name: 'TypeError', message: 'synthetic receipt bug' });
    } finally { mock.restore(); }
    assert.equal((await inspectStatus(args)).attemptCounts.DISPATCH_COMMITTED, 1);
  });
});

test('lazy unsupported SQLite import refuses without creating a database', async () => {
  await withLedgerDir(async ledgerPath => {
    const hook = registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'node:sqlite') throw new Error('synthetic missing SQLite runtime');
      return next(specifier, context);
    } });
    try {
      const module = await import('../lib/spend-budget.js?missing-sqlite');
      await assert.rejects(module.initializeLedger({ ledgerPath, policy: policyFor(ledgerPath), now: NOW }), { code: 'unsupported_runtime' });
      assert.deepEqual(await readdir(dirname(ledgerPath)), []);
    } finally { hook.deregister(); }
  });
});

test('reserve COMMIT failure grants no permission and rolls back; post-COMMIT close failure keeps durable hold', async t => {
  for (const fault of ['commit', 'close']) await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false });
    await withFault(t, fault, async module => {
      await assert.rejects(module.reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A }), { code: 'invalid_ledger' });
    });
    assert.deepEqual(balances(await inspectStatus(args)), fault === 'commit' ? [700n, 700n, 0n, 0n] : [700n, 350n, 350n, 0n]);
    if (fault === 'close') await assert.rejects(reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A }), { code: 'invalid_ledger' });
  });
});

test('fund COMMIT followed by close failure can never create a second epoch', async t => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false, amount: null });
    await withFault(t, 'close', async module => {
      await assert.rejects(module.fundLedger({ ...args, allocation: allocationFor() }), { code: 'invalid_ledger' });
    });
    assert.equal((await inspectStatus(args)).fundedNano, 700n);
    await assert.rejects(fundLedger({ ...args, allocation: allocationFor() }), { code: 'invalid_ledger' });
  });
});

test('violation storage failure is not reported as a committed freeze or settlement', async t => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath);
    const realPrepare = DatabaseSync.prototype.prepare;
    const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (text) {
      if (text.startsWith('INSERT INTO violations')) throw Object.assign(new Error('synthetic disk failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
      return realPrepare.call(this, text);
    });
    try { await assert.rejects(settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor({ usage: { ...evidenceFor().usage, output_tokens: 100 } }) }), { code: 'invalid_ledger' }); }
    finally { mock.mock.restore(); }
    const status = await inspectStatus(args);
    assert.deepEqual(balances(status), [700n, 350n, 350n, 0n]); assert.equal(status.attemptCounts.DISPATCH_COMMITTED, 1);
  });
});

test('status reads inside one transaction and does not combine two writer snapshots', async t => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false });
    const writer = new DatabaseSync(ledgerPath);
    const realPrepare = DatabaseSync.prototype.prepare;
    let wrote = false;
    const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (text) {
      // Trigger the second connection after the reader took its schema snapshot.
      if (this !== writer && text === 'SELECT * FROM wallet' && !wrote) {
        assert.equal(this.isTransaction, true); wrote = true;
        writer.exec('BEGIN IMMEDIATE; UPDATE wallet SET available_nano=701,funded_nano=701; UPDATE funding_epoch SET amount_nano=701; COMMIT');
      }
      return realPrepare.call(this, text);
    });
    try { assert.equal((await inspectStatus(args)).fundedNano, 700n); assert.ok(wrote); }
    finally { mock.mock.restore(); writer.close(); }
    assert.equal((await inspectStatus(args)).fundedNano, 701n);
  });
});

test('initialization cleanup unlink failure surfaces with original error and never deletes preexisting sentinel', async t => {
  await withLedgerDir(async ledgerPath => {
    const sentinel = join(dirname(ledgerPath), 'unrelated'); await writeFile(sentinel, 'UNCHANGED', { mode: 0o600 });
    const mock = t.mock.module('node:fs/promises', { exports: { ...realFS, unlink: async path => {
      if (path === ledgerPath) throw Object.assign(new Error('synthetic unlink error'), { code: 'EIO' });
      return realFS.unlink(path);
    } } });
    try {
      await withFault(t, 'journal', async module => {
        await assert.rejects(module.initializeLedger({ ledgerPath, policy: policyFor(ledgerPath), now: NOW }), e => e.code === 'invalid_ledger' && /initialization cleanup/.test(e.message) && e.cause?.original?.code === 'invalid_ledger');
      });
      assert.equal(await readFile(sentinel, 'utf8'), 'UNCHANGED');
    } finally { mock.restore(); }
  });
});

test('initialization file metadata failure still closes its handle and removes its exclusive file', async t => {
  await withLedgerDir(async ledgerPath => {
    let closed = false; let failed = false;
    const mock = t.mock.module('node:fs/promises', { exports: { ...realFS, open: async (...params) => {
      const handle = await realFS.open(...params);
      return new Proxy(handle, { get(target, key) {
        if (key === 'stat') return async () => { if (!failed) { failed = true; throw Object.assign(new Error('synthetic stat failure'), { code: 'EIO' }); } return target.stat(); };
        if (key === 'close') return async () => { await target.close(); closed = true; };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    } } });
    try {
      const module = await import('../lib/spend-budget.js?file-metadata-failure');
      await assert.rejects(module.initializeLedger({ ledgerPath, policy: policyFor(ledgerPath), now: NOW }), { code: 'invalid_ledger' });
      assert.ok(closed); assert.deepEqual(await readdir(dirname(ledgerPath)), []);
    } finally { mock.restore(); }
  });
});

test('sidecar privacy is rechecked after SQLite config and before operations', async t => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false });
    const before = await inspectStatus(args); let observed = false;
    const mock = t.mock.module('node:fs/promises', { exports: { ...realFS, lstat: async (...params) => {
      const info = await realFS.lstat(...params);
      if (params[0] === ledgerPath + '-wal') { observed = true; info.mode |= 0o040; }
      return info;
    } } });
    try {
      const module = await import('../lib/spend-budget.js?post-open-sidecar');
      await assert.rejects(module.reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A }), { code: 'invalid_ledger' });
      assert.ok(observed);
    } finally { mock.restore(); }
    assert.deepEqual(await inspectStatus(args), before);
  });
});

test('root ancestor is checked too; sticky exception requires root ownership', async t => {
  for (const variant of ['writable-root', 'nonroot-sticky']) await withLedgerDir(async ledgerPath => {
    const mock = t.mock.module('node:fs/promises', { exports: { ...realFS, lstat: async (...params) => {
      const info = await realFS.lstat(...params);
      if (params[0] === '/' && variant === 'writable-root') info.mode = 0o40777;
      if (params[0] === '/tmp' && variant === 'nonroot-sticky') { info.mode = 0o41777; info.uid = 1000; /* synthetic non-root independent of namespace effectiveUID */ }
      return info;
    } } });
    try {
      const module = await import(`../lib/spend-budget.js?root-ancestor=${variant}`);
      await assert.rejects(module.initializeLedger({ ledgerPath, policy: policyFor(ledgerPath), now: NOW }), { code: 'invalid_ledger' });
      assert.deepEqual(await readdir(dirname(ledgerPath)), []);
    } finally { mock.restore(); }
  });
});

test('initialized file and sidecars are private and clean checkpoint absence is valid', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath);
    assert.equal((await lstat(ledgerPath)).mode & 0o777, 0o600);
    const db = new DatabaseSync(ledgerPath);
    try {
      db.prepare('SELECT * FROM wallet').get();
      for (const suffix of ['-wal', '-shm']) {
        const info = await lstat(ledgerPath + suffix); assert.equal(info.mode & 0o777, 0o600); assert.equal(info.uid, process.geteuid());
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
    await assert.rejects(lstat(ledgerPath + '-wal'), { code: 'ENOENT' });
    assert.equal((await inspectStatus(args)).heldNano, 350n);
  });
});

test('changed policy hash or any binding cannot fund/reserve/inspect an existing wallet', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath); const before = await inspectStatus(args);
    for (const policy of [
      policyFor(ledgerPath, { policyID: 'new-policy' }),
      policyFor(ledgerPath, { binding: { ...args.policy.binding, providerID: 'new-provider' } }),
      policyFor(ledgerPath, { binding: { ...args.policy.binding, credentialSHA256: 'a'.repeat(64) } }),
      { ...args.policy, binding: { ...args.policy.binding, origin: 'https://wrong.invalid' } },
    ]) {
      await assert.rejects(inspectStatus({ ...args, policy }), { code: 'invalid_ledger' });
      await assert.rejects(fundLedger({ ...args, policy, allocation: allocationFor() }), { code: 'invalid_ledger' });
      await assert.rejects(reserveAttempt({ ...args, policy, prepared: preparedFor(args.policy), attemptID: ATTEMPT_B }), { code: 'invalid_ledger' });
    }
    assert.deepEqual(await inspectStatus(args), before);
  });
});

test('signed SQLite ceiling and aggregate receipt costs use exact BigInt not overflowing SQL SUM', async () => {
  await withLedgerDir(async ledgerPath => {
    const max = 9223372036854775807n;
    const ratesNanoUSD = { input: '1000000', cacheRead: '1000000', cacheWrite1h: '1000000', output: '1000000' };
    const args = await setup(ledgerPath, { amount: '9223372036.8547758079', overrides: { ceilingUSD: '9223372036.8547758079', models: { [MODEL]: { maxInputTokens: 100, maxOutputTokens: 10, ratesNanoUSD } } } });
    await reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_B });
    const evidence = evidenceFor({ usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: Number.MAX_SAFE_INTEGER } });
    for (const attemptID of [ATTEMPT_A, ATTEMPT_B]) await assert.rejects(settleAttempt({ ...args, attemptID, evidence }), { code: 'frozen' });
    const status = await inspectStatus(args);
    assert.equal(status.fundedNano, max); assert.equal(status.availableNano, max - 220000000n);
    assert.equal(status.observedCostNano, 2n * BigInt(Number.MAX_SAFE_INTEGER) * 1000000n);
  });
});

test('SQLITE_LOCKED extended codes are normalized, not exposed as storage success', async t => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false }); const before = await inspectStatus(args);
    const exec = DatabaseSync.prototype.exec;
    const mock = t.mock.method(DatabaseSync.prototype, 'exec', function (text) {
      if (text === 'BEGIN IMMEDIATE') throw Object.assign(new Error('synthetic locked'), { code: 'ERR_SQLITE_ERROR', errcode: 262 });
      return exec.call(this, text);
    });
    try { await assert.rejects(reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A }), { code: 'locked' }); }
    finally { mock.mock.restore(); }
    assert.deepEqual(await inspectStatus(args), before);
  });
});

test('equivalent receipt key ordering is idempotent and ledger contains no request body or key bytes', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { refund: true });
    const evidence = evidenceFor();
    const first = await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence });
    const reordered = Object.fromEntries(Object.entries(evidence).reverse());
    reordered.usage = Object.fromEntries(Object.entries(evidence.usage).reverse());
    assert.deepEqual(await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: reordered }), { ...first, duplicate: true });
    const bytes = await readFile(ledgerPath); assert.ok(!bytes.includes(Buffer.from(TEST_KEY))); assert.ok(!bytes.includes(Buffer.from(preparedFor(args.policy).body)));
  });
});

test('real unique-index content corruption that passes quick_check is rejected', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false });
    const { rootpage, epochID } = sql(ledgerPath, db => ({
      rootpage: db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='sqlite_autoindex_funding_epoch_1'").get().rootpage,
      epochID: db.prepare('SELECT epoch_id FROM funding_epoch').get().epoch_id,
    }));
    const bytes = await readFile(ledgerPath);
    const encodedSize = bytes.readUInt16BE(16); const pageSize = encodedSize === 1 ? 65536 : encodedSize;
    const start = (rootpage - 1) * pageSize;
    const index = bytes.indexOf(Buffer.from(epochID), start);
    assert.ok(index >= start && index + epochID.length <= start + pageSize, 'target the actual PK index leaf, not table data');
    bytes[index] = bytes[index] === 97 ? 98 : 97;
    await writeFile(ledgerPath, bytes);
    sql(ledgerPath, db => {
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
      assert.notEqual(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    });
    await assert.rejects(inspectStatus(args), { code: 'invalid_ledger' });
    assert.deepEqual(await readFile(ledgerPath), bytes);
  });
});

for (const [label, mutation] of [
  ['missing violation', 'DELETE FROM violations'], ['cleared freeze', 'UPDATE wallet SET frozen=0,freeze_reason=NULL'],
  ['bad freeze reason', "UPDATE wallet SET freeze_reason='other'"], ['bad liability', "UPDATE attempts SET additional_liability_nano_text='166'"],
  ['bad violation id', "UPDATE violations SET violation_id='not-uuid'"], ['bad violation time', 'UPDATE violations SET created_at_ms=0'],
  ['bad violation digest', "UPDATE violations SET evidence_hash='wrong'"], ['missing violation evidence', "UPDATE violations SET details_json='{}'"],
  ['wrong violation FK', "UPDATE violations SET attempt_id='44444444-4444-4444-8444-444444444444'"],
]) test(`frozen evidence revalidation refuses ${label}`, async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath);
    await assert.rejects(settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor({ usage: { ...evidenceFor().usage, output_tokens: 100 } }) }), { code: 'frozen' });
    sql(ledgerPath, db => { db.exec('PRAGMA foreign_keys=OFF'); db.exec(mutation); });
    await assert.rejects(inspectStatus(args), { code: 'invalid_ledger' });
  });
});

test('filesystem missing paths never create state and path is bound to policy', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = { ledgerPath, policy: policyFor(ledgerPath), now: NOW };
    for (const operation of [inspectStatus, fundLedger, reserveAttempt, markUncertain, settleAttempt]) {
      await assert.rejects(operation(args), { code: 'missing_ledger' });
      assert.deepEqual(await readdir(dirname(ledgerPath)), []);
    }
    const missing = join(dirname(ledgerPath), 'missing', 'wallet.sqlite');
    await assert.rejects(initializeLedger({ ...args, ledgerPath: missing, policy: policyFor(missing) }), { code: 'missing_ledger' });
    await assert.rejects(initializeLedger({ ...args, ledgerPath: `${ledgerPath}.other` }), { code: 'binding_mismatch' });
    assert.deepEqual(await readdir(dirname(ledgerPath)), []);
  });
});

for (const suffix of ['', '-wal', '-shm']) {
  for (const variant of ['symlink', 'public', 'executable', 'directory']) {
    test(`filesystem refuses ${variant} ${suffix || 'main'} before SQLite touches sentinel`, async () => {
      await withLedgerDir(async ledgerPath => {
        const args = { ledgerPath, policy: policyFor(ledgerPath), now: NOW };
        if (suffix) await initializeLedger(args);
        const path = ledgerPath + suffix;
        const sentinel = join(dirname(ledgerPath), 'sentinel');
        await writeFile(sentinel, 'SENTINEL', { mode: 0o600 });
        if (variant === 'symlink') await symlink(sentinel, path);
        else if (variant === 'directory') await mkdir(path, { mode: 0o700 });
        else { await writeFile(path, 'SENTINEL', { mode: 0o600 }); await chmod(path, variant === 'public' ? 0o640 : 0o700); }
        const before = await lstat(path);
        await assert.rejects(inspectStatus(args), { code: 'invalid_ledger' });
        assert.equal((await lstat(path)).ino, before.ino);
        assert.equal((await lstat(path)).mode, before.mode);
        assert.equal(await readFile(sentinel, 'utf8'), 'SENTINEL');
        if (variant !== 'directory') assert.equal(await readFile(path, 'utf8'), 'SENTINEL');
      });
    });
  }
  if (suffix) test(`initialization refuses existing private ${suffix} without deleting it`, async () => {
    await withLedgerDir(async ledgerPath => {
      await writeFile(ledgerPath + suffix, 'SENTINEL', { mode: 0o600 });
      await assert.rejects(initializeLedger({ ledgerPath, policy: policyFor(ledgerPath), now: NOW }), { code: 'invalid_ledger' });
      assert.equal(await readFile(ledgerPath + suffix, 'utf8'), 'SENTINEL');
      await assert.rejects(lstat(ledgerPath), { code: 'ENOENT' });
    });
  });
}

test('filesystem rejects symlink ancestors and unsafe test-owned parent/ancestors without chmod repair', async () => {
  await withLedgerDir(async base => {
    const root = dirname(base); const parent = join(root, 'parent'); await mkdir(parent, { mode: 0o700 });
    const link = join(root, 'link'); await symlink(parent, link);
    for (const path of [join(link, 'wallet'), `${link}/../wallet`]) {
      await assert.rejects(initializeLedger({ ledgerPath: path, policy: policyFor(path), now: NOW }), { code: 'invalid_ledger' });
    }
    await chmod(parent, 0o750);
    const path = join(parent, 'wallet');
    await assert.rejects(initializeLedger({ ledgerPath: path, policy: policyFor(path), now: NOW }), { code: 'invalid_ledger' });
    assert.equal((await lstat(parent)).mode & 0o777, 0o750);
    await chmod(parent, 0o777); const inner = join(parent, 'inner'); await mkdir(inner, { mode: 0o700 });
    const nested = join(inner, 'wallet');
    await assert.rejects(initializeLedger({ ledgerPath: nested, policy: policyFor(nested), now: NOW }), { code: 'invalid_ledger' });
  });
});

for (const bytes of ['', 'not a database']) test(`invalid database bytes (${bytes.length}) refuse without replacement`, async () => {
  await withLedgerDir(async ledgerPath => {
    await writeFile(ledgerPath, bytes, { mode: 0o600 });
    await assert.rejects(inspectStatus({ ledgerPath, policy: policyFor(ledgerPath), now: NOW }), { code: 'invalid_ledger' });
    assert.equal(await readFile(ledgerPath, 'utf8'), bytes);
  });
});

const mutations = [
  ['unknown column', 'ALTER TABLE wallet ADD COLUMN injected TEXT'],
  ['unknown table', 'CREATE TABLE other(id INTEGER)'],
  ['unknown view', 'CREATE VIEW other AS SELECT * FROM wallet'],
  ['unknown trigger', 'CREATE TRIGGER surprise AFTER UPDATE ON wallet BEGIN SELECT 1; END'],
  ['unknown index', 'CREATE INDEX surprise ON attempts(model)'],
  ['schema version', 'UPDATE wallet SET schema_version=2'],
  ['user version', 'PRAGMA user_version=99'],
  ['wallet missing', 'DELETE FROM wallet'],
  ['wallet identity', 'UPDATE wallet SET id=2'],
  ['wallet negative', 'UPDATE wallet SET available_nano=-1'],
  ['wallet real money', 'UPDATE wallet SET available_nano=350.5'],
  ['wallet text money', "UPDATE wallet SET available_nano='not-money'"],
  ['wallet conservation', 'UPDATE wallet SET held_nano=0'],
  ['wallet over ceiling', 'UPDATE wallet SET funded_nano=60000,available_nano=59650; UPDATE funding_epoch SET amount_nano=60000'],
  ['wallet time', 'UPDATE wallet SET created_at_ms=-1'],
  ['unexplained freeze', "UPDATE wallet SET frozen=1,freeze_reason='bounds_violation'"],
  ['epoch identity', "UPDATE funding_epoch SET epoch_id='not-uuid'"],
  ['epoch singleton', 'UPDATE funding_epoch SET singleton=2'],
  ['epoch reference', "UPDATE funding_epoch SET reference=''"],
  ['epoch confirmation', 'UPDATE funding_epoch SET confirmed_at_ms=expires_at_ms'],
  ['epoch expiry', 'UPDATE funding_epoch SET expires_at_ms=9999999999999'],
  ['epoch policy', "UPDATE funding_epoch SET policy_hash='wrong'"],
  ['attempt FK', "UPDATE attempts SET epoch_id='44444444-4444-4444-8444-444444444444'"],
  ['attempt policy', "UPDATE attempts SET policy_hash='wrong'"],
  ['attempt provider', "UPDATE attempts SET provider_id='wrong'"],
  ['attempt origin', "UPDATE attempts SET origin='https://wrong.invalid'"],
  ['attempt credential', "UPDATE attempts SET credential_sha256='wrong'"],
  ['attempt model', "UPDATE attempts SET model='wrong'"],
  ['attempt input bound', 'UPDATE attempts SET max_input_tokens=99'],
  ['attempt output bound', 'UPDATE attempts SET max_output_tokens=11'],
  ['attempt fractional bound', 'UPDATE attempts SET max_output_tokens=1.5'],
  ['attempt request digest', "UPDATE attempts SET request_digest='wrong'"],
  ['attempt body digest', "UPDATE attempts SET body_digest='wrong'"],
  ['attempt rate numeric', `UPDATE attempts SET rates_json='{"input":2,"cacheRead":"1","cacheWrite1h":"3","output":"5"}'`],
  ['attempt rate noncanonical', `UPDATE attempts SET rates_json='{"input":"02","cacheRead":"1","cacheWrite1h":"3","output":"5"}'`],
  ['attempt rate mismatch', `UPDATE attempts SET rates_json='{"input":"4","cacheRead":"1","cacheWrite1h":"3","output":"5"}'`],
  ['attempt reserve formula', 'UPDATE attempts SET reserved_nano=349; UPDATE wallet SET held_nano=349,available_nano=351'],
  ['attempt time', 'UPDATE attempts SET created_at_ms=-1'],
  ['attempt after expiry', 'UPDATE attempts SET created_at_ms=9999999999999'],
  ['attempt unexpected receipt', "UPDATE attempts SET receipt_json='{}'"],
  ['attempt noncanonical liability', "UPDATE attempts SET additional_liability_nano_text='00'"],
  ['attempt unexplained liability', "UPDATE attempts SET additional_liability_nano_text='1'"],
  ['attempt uncertain reason', "UPDATE attempts SET state='UNCERTAIN',uncertain_reason=''"],
  ['unknown violation', "INSERT INTO violations VALUES('44444444-4444-4444-8444-444444444444',NULL,'unknown','wrong','{}',0)"],
];

for (const [label, mutation] of mutations) test(`corruption refuses ${label} without repair`, async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath);
    sql(ledgerPath, db => { db.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON'); db.exec(mutation); });
    const before = await readFile(ledgerPath);
    await assert.rejects(inspectStatus(args), { code: 'invalid_ledger' });
    await assert.rejects(reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_B }), { code: 'invalid_ledger' });
    assert.deepEqual(await readFile(ledgerPath), before);
  });
});

for (const [label, mutation] of [
  ['usage', `UPDATE attempts SET receipt_json=replace(receipt_json,'"input_tokens":2','"input_tokens":1')`],
  ['hash', "UPDATE attempts SET receipt_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"],
  ['identity', "UPDATE attempts SET message_id='wrong'"],
  ['actual', "UPDATE attempts SET actual_cost_nano_text='41'"],
  ['cost leading zeros', "UPDATE attempts SET actual_cost_nano_text='042'"],
  ['retained', 'UPDATE attempts SET retained_nano=349; UPDATE wallet SET spent_nano=349,available_nano=351'],
  ['settlement time', 'UPDATE attempts SET settled_at_ms=0'],
  ['stale reason', "UPDATE attempts SET uncertain_reason='network_failure'"],
]) test(`stored receipt revalidation refuses mutated ${label}`, async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath);
    await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor() });
    sql(ledgerPath, db => db.exec(mutation));
    await assert.rejects(inspectStatus(args), { code: 'invalid_ledger' });
  });
});

test('schema with same columns but weakened type/null/check/FK/unique constraints is refused', async t => {
  for (const [label, from, to] of [
    ['type', 'policy_hash TEXT', 'policy_hash BLOB'], ['null', 'policy_hash TEXT NOT NULL', 'policy_hash TEXT'],
    ['check', ' CHECK(id=1)', ''], ['FK', ' REFERENCES wallet(id)', ''], ['unique', 'reference TEXT NOT NULL UNIQUE', 'reference TEXT NOT NULL'],
  ]) await t.test(label, async () => withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false, amount: null });
    // Rebuild a genuine alternative schema, not writable_schema corruption.
    const ddl = sql(ledgerPath, db => db.prepare("SELECT sql FROM sqlite_schema WHERE type='table'").all().map(r => r.sql));
    sql(ledgerPath, db => { db.exec('PRAGMA foreign_keys=OFF; DROP TABLE violations; DROP TABLE attempts; DROP TABLE funding_epoch; DROP TABLE wallet'); for (const text of ddl) db.exec(text.replace(from, to)); db.prepare('INSERT INTO wallet VALUES(1,1,?,?,?,?,0,0,0,0,0,NULL,?)').run(args.policy.policyHash, args.policy.binding.providerID, args.policy.binding.origin, args.policy.binding.credentialSHA256, NOW); });
    await assert.rejects(inspectStatus(args), { code: 'invalid_ledger' });
  }));
});

test('funding requires precise canonical time, exclusive binding and positive floored bounded money', async t => {
  const bad = [
    { confirmedAt: '2026-10-20' }, { confirmedAt: '2026-10-20T11:00:00Z' }, { confirmedAt: '2026-02-30T11:00:00.000Z' },
    { confirmedAt: '2026-10-20T11:00:00.000+00:00' }, { expiresAt: '2026-10-21' },
    { confirmedAt: '2026-10-20T13:00:00.000Z' }, { expiresAt: '2026-10-20T12:00:00.000Z' }, { expiresAt: '2026-10-22T12:00:00.000Z' },
    { exclusivePromotionalAllocation: false }, { reference: '' }, { reference: '   ' }, { providerID: 'wrong' }, { origin: 'https://wrong.invalid' }, { credentialFingerprint: 'a'.repeat(64) },
    ...['0', '-1', '+1', '01', '1e-9', '0.0000000009', '0.000050001', '9223372036.854775808', 350].map(amountUSD => ({ amountUSD })),
  ];
  for (const [index, override] of bad.entries()) await t.test(String(index), async () => withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false, amount: null }); const before = await inspectStatus(args);
    await assert.rejects(fundLedger({ ...args, allocation: allocationFor('0.000000350', override) }), { code: 'invalid_ledger' });
    assert.deepEqual(await inspectStatus(args), before);
  }));
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false, amount: null });
    const reference = "promo'); DROP TABLE wallet; --";
    const s = await fundLedger({ ...args, allocation: allocationFor('0.0000003509', { reference }) });
    assert.equal(s.fundedNano, 350n); assert.equal(s.reference, reference);
  });
});

test('one funding epoch never resets after duplicate init, same/different reference, expiry or burn', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { amount: '0.000000350' });
    for (const now of [NOW, NOW + 86400001]) {
      const at = { ...args, now }; const before = await inspectStatus(at);
      await assert.rejects(initializeLedger(at), { code: 'invalid_ledger' });
      for (const reference of ['promo-fixture-1', 'new']) await assert.rejects(fundLedger({ ...at, allocation: allocationFor('0.000000350', { reference }) }), { code: 'invalid_ledger' });
      await assert.rejects(reserveAttempt({ ...at, prepared: preparedFor(args.policy), attemptID: ATTEMPT_B }), { code: now === NOW ? 'insufficient_funds' : 'expired' });
      assert.deepEqual(await inspectStatus(at), before);
    }
    await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor() });
    const before = await inspectStatus(args);
    await assert.rejects(fundLedger({ ...args, allocation: allocationFor() }), { code: 'invalid_ledger' });
    assert.deepEqual(await inspectStatus(args), before); assert.equal(before.spentNano, 350n);
  });
});

test('reserve validates all snapshot fields and rejects duplicate canonical headers before losing them', async t => {
  for (const override of [
    { policyHash: 'a'.repeat(64) }, { origin: 'https://wrong.invalid' }, { model: 'wrong' }, { maxInputTokens: 99 }, { maxOutputTokens: 9 },
    { ratesNanoUSD: { input: 1n, cacheRead: 1n, cacheWrite1h: 3n, output: 5n } }, { reserveNano: 1n }, { bodyDigest: 'a'.repeat(64) }, { requestDigest: 'a'.repeat(64) },
    { body: '{}' },
  ]) await t.test(Object.keys(override)[0], async () => withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false }); const before = await inspectStatus(args);
    await assert.rejects(reserveAttempt({ ...args, prepared: { ...preparedFor(args.policy), ...override }, attemptID: ATTEMPT_A }));
    assert.deepEqual(await inspectStatus(args), before);
  }));
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false }); const prepared = preparedFor(args.policy);
    await assert.rejects(reserveAttempt({ ...args, prepared: { ...prepared, headers: [...prepared.headers, prepared.headers.at(-1)] }, attemptID: ATTEMPT_A }));
    assert.equal((await inspectStatus(args)).heldNano, 0n);
  });
});

test('invalid later evidence reports historical SETTLED result without a second refund or downgrade', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { refund: true });
    const first = await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor() });
    const before = await inspectStatus(args);
    const invalid = await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor({ usage: null }) });
    assert.deepEqual(invalid, { ...first, duplicate: true });
    await markUncertain({ ...args, attemptID: ATTEMPT_A, reason: 'late_failure' });
    assert.deepEqual(await inspectStatus(args), before);
  });
});

test('late complete UNCERTAIN receipt settles after expiry and clears uncertainty; no contract means burn', async () => {
  for (const refund of [false, true]) await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { refund, overrides: { reconcileUsage: true } });
    for (const field of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
      const usage = { ...evidenceFor().usage }; delete usage[field];
      assert.equal((await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor({ usage }) })).state, 'UNCERTAIN');
      assert.equal((await inspectStatus(args)).heldNano, 350n);
    }
    const result = await settleAttempt({ ...args, now: NOW + 86400001, attemptID: ATTEMPT_A, evidence: evidenceFor() });
    assert.equal(result.refundedNano, refund ? 308n : 0n);
    assert.equal(sql(ledgerPath, db => db.prepare('SELECT uncertain_reason FROM attempts').get()).uncertain_reason, null);
  });
});

test('conflict commits complete evidence and freeze, preserving original money and permitting historical settlement', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { refund: true });
    await reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_B });
    const first = await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor() });
    const before = await inspectStatus(args); const conflicting = evidenceFor({ messageID: 'different' });
    await assert.rejects(settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: conflicting }), { code: 'frozen' });
    const frozen = await inspectStatus(args); assert.equal(frozen.frozen, true); assert.deepEqual(balances(frozen), balances(before));
    const record = sql(ledgerPath, db => db.prepare('SELECT * FROM violations').get());
    assert.deepEqual(JSON.parse(record.details_json).evidence, conflicting);
    assert.equal((await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor() })).duplicate, true);
    assert.equal((await settleAttempt({ ...args, attemptID: ATTEMPT_B, evidence: evidenceFor() })).state, 'SETTLED');
    await assert.rejects(reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: '44444444-4444-4444-8444-444444444444' }), { code: 'frozen' });
    assert.equal(first.refundedNano, 308n);
  });
});

test('token-bound violations freeze even below reserve; exact excess survives duplicate and invalid evidence', async () => {
  for (const usage of [
    { input_tokens: 101, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 11 },
    { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 100 },
  ]) await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath); const evidence = evidenceFor({ usage });
    await assert.rejects(settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence }), { code: 'frozen' });
    const before = await inspectStatus(args); assert.equal(before.heldNano, 350n); assert.equal(before.frozen, true);
    const again = await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence });
    assert.equal(again.duplicate, true); assert.equal(again.state, 'UNCERTAIN');
    const invalid = await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor({ usage: null }) });
    assert.equal(invalid.actualCostNano, again.actualCostNano); assert.equal(invalid.additionalLiabilityNano, again.additionalLiabilityNano);
    assert.deepEqual(await inspectStatus(args), before);
  });
});

test('receipt liability above SQLite INTEGER range remains exact decimal TEXT, never clamped', async () => {
  await withLedgerDir(async ledgerPath => {
    const ratesNanoUSD = { input: '1000000', cacheRead: '1000000', cacheWrite1h: '1000000', output: '1000000' };
    const args = await setup(ledgerPath, { amount: '0.11', overrides: { ceilingUSD: '1', models: { [MODEL]: { maxInputTokens: 100, maxOutputTokens: 10, ratesNanoUSD } } } });
    const actual = BigInt(Number.MAX_SAFE_INTEGER) * 1000000n;
    await assert.rejects(settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor({ usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: Number.MAX_SAFE_INTEGER } }) }), { code: 'frozen' });
    const s = await inspectStatus(args); assert.equal(s.observedCostNano, actual); assert.equal(s.additionalLiabilityNano, actual - 110000000n);
    const row = sql(ledgerPath, db => db.prepare('SELECT actual_cost_nano_text,additional_liability_nano_text FROM attempts').get());
    assert.equal(row.actual_cost_nano_text, actual.toString()); assert.equal(row.additional_liability_nano_text, (actual - 110000000n).toString());
  });
});

test('separate SQLite BEGIN IMMEDIATE gives bounded locked refusal and unchanged balances', { timeout: 6000 }, async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false }); const before = await inspectStatus(args);
    const db = new DatabaseSync(ledgerPath);
    try {
      db.exec('BEGIN IMMEDIATE'); const start = performance.now();
      await assert.rejects(reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A }), { code: 'locked' });
      const elapsed = performance.now() - start; assert.ok(elapsed >= 900 && elapsed < 3000, `lock wait ${elapsed}ms`);
    } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
    assert.deepEqual(await inspectStatus(args), before);
  });
});

test('receipt storage round trips nested usage and breakdown with its original hash', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = policyFor(ledgerPath); const args = { ledgerPath, policy, now: NOW };
    await initializeLedger(args); await fundLedger({ ...args, allocation: allocationFor() });
    const prepared = preparedFor(policy);
    const reservation = await reserveAttempt({ ...args, prepared, attemptID: ATTEMPT_A });
    const evidence = evidenceFor({ cacheCreationBreakdown: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 } });
    await settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence });
    const row = sql(ledgerPath, db => db.prepare('SELECT receipt_json,receipt_hash FROM attempts').get());
    assert.deepEqual(JSON.parse(row.receipt_json), evidence);
    assert.equal(validateSpendReceipt({ attempt: snapshotFor(prepared, { epochID: reservation.epochID }), evidence: JSON.parse(row.receipt_json) }).receiptHash, row.receipt_hash);
  });
});

test('zero wallet refuses; one allocation can reserve exactly once per UUID', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = policyFor(ledgerPath);
    await initializeLedger({ ledgerPath, policy, now: NOW });
    const args = { ledgerPath, policy, prepared: preparedFor(policy), attemptID: ATTEMPT_A, now: NOW };
    await assert.rejects(reserveAttempt(args), { code: 'insufficient_funds' });
    await fundLedger({ ledgerPath, policy, allocation: allocationFor('0.000000350'), now: NOW });
    const reservation = await reserveAttempt(args);
    assert.equal(reservation.state, 'DISPATCH_COMMITTED');
    const status = await inspectStatus({ ledgerPath, policy, now: NOW });
    assert.equal(status.availableNano, 0n);
    assert.equal(status.heldNano, 350n);
    await assert.rejects(reserveAttempt(args));
  });
});

test('default settlement burns the full reservation while retaining observed cost', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = policyFor(ledgerPath);
    await initializeLedger({ ledgerPath, policy, now: NOW });
    await fundLedger({ ledgerPath, policy, allocation: allocationFor('0.000000350'), now: NOW });
    await reserveAttempt({ ledgerPath, policy, prepared: preparedFor(policy), attemptID: ATTEMPT_A, now: NOW });
    const result = await settleAttempt({ ledgerPath, policy, attemptID: ATTEMPT_A, evidence: evidenceFor(), now: NOW });
    assert.deepEqual({ state: result.state, retainedNano: result.retainedNano, refundedNano: result.refundedNano, actualCostNano: result.actualCostNano }, { state: 'SETTLED', retainedNano: 350n, refundedNano: 0n, actualCostNano: 42n });
    const status = await inspectStatus({ ledgerPath, policy, now: NOW });
    assert.deepEqual({ available: status.availableNano, held: status.heldNano, spent: status.spentNano, observed: status.observedCostNano }, { available: 0n, held: 0n, spent: 350n, observed: 42n });
  });
});

test('duplicate settlement has one confirmed-contract refund', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = confirmedRefundPolicy(ledgerPath);
    await initializeLedger({ ledgerPath, policy, now: NOW });
    await fundLedger({ ledgerPath, policy, allocation: allocationFor('0.000000350'), now: NOW });
    await reserveAttempt({ ledgerPath, policy, prepared: preparedFor(policy), attemptID: ATTEMPT_A, now: NOW });
    const args = { ledgerPath, policy, attemptID: ATTEMPT_A, evidence: evidenceFor(), now: NOW };
    assert.equal((await settleAttempt(args)).refundedNano, 308n);
    assert.equal((await settleAttempt(args)).duplicate, true);
    const status = await inspectStatus({ ledgerPath, policy, now: NOW });
    assert.deepEqual({ available: status.availableNano, held: status.heldNano, spent: status.spentNano }, { available: 308n, held: 0n, spent: 42n });
  });
});

test('invalid receipt becomes uncertain and an over-bound receipt freezes without discarding liability', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = policyFor(ledgerPath);
    await initializeLedger({ ledgerPath, policy, now: NOW });
    await fundLedger({ ledgerPath, policy, allocation: allocationFor('0.000000700'), now: NOW });
    await reserveAttempt({ ledgerPath, policy, prepared: preparedFor(policy), attemptID: ATTEMPT_A, now: NOW });
    const uncertain = await settleAttempt({ ledgerPath, policy, attemptID: ATTEMPT_A, evidence: evidenceFor({ complete: false }), now: NOW });
    assert.equal(uncertain.state, 'UNCERTAIN');
    await reserveAttempt({ ledgerPath, policy, prepared: preparedFor(policy), attemptID: '22222222-2222-4222-8222-222222222222', now: NOW });
    await assert.rejects(settleAttempt({ ledgerPath, policy, attemptID: '22222222-2222-4222-8222-222222222222', evidence: evidenceFor({ usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 100 } }), now: NOW }), { code: 'frozen' });
    const status = await inspectStatus({ ledgerPath, policy, now: NOW });
    assert.deepEqual({ frozen: status.frozen, held: status.heldNano, additional: status.additionalLiabilityNano }, { frozen: true, held: 700n, additional: 167n });
  });
});

test('mark uncertain is idempotent and never downgrades settled attempts', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = policyFor(ledgerPath);
    await initializeLedger({ ledgerPath, policy, now: NOW });
    await fundLedger({ ledgerPath, policy, allocation: allocationFor('0.000000350'), now: NOW });
    await reserveAttempt({ ledgerPath, policy, prepared: preparedFor(policy), attemptID: ATTEMPT_A, now: NOW });
    await markUncertain({ ledgerPath, policy, attemptID: ATTEMPT_A, reason: 'network_failure', now: NOW });
    await markUncertain({ ledgerPath, policy, attemptID: ATTEMPT_A, reason: 'network_failure', now: NOW });
    assert.equal((await inspectStatus({ ledgerPath, policy, now: NOW })).heldNano, 350n);
  });
});

function worker(mode, ledgerPath, attemptID) {
  const child = fork('gateway/tests/helpers/spend-worker.mjs', [mode, ledgerPath, attemptID], { cwd: '/home/dev/opencode-broker', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = []; const waiters = new Set(); let stderr = ''; let ended = false;
  child.stderr.on('data', data => { stderr += data; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => { ended = true; for (const w of waiters) w.reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)); resolve({ code, signal }); }));
  child.on('error', cause => { for (const w of waiters) w.reject(cause); });
  child.on('message', message => {
    const waiter = [...waiters].find(w => w.type === message.type);
    if (waiter) waiter.resolve(message); else messages.push(message);
  });
  return {
    child,
    send: message => new Promise((resolve, reject) => child.send(message, cause => cause ? reject(cause) : resolve())),
    wait(type) {
      const index = messages.findIndex(m => m.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      if (ended) return Promise.reject(new Error(`worker already exited: ${stderr}`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => waiter.reject(new Error(`worker ${type} deadline: ${stderr}`)), 3000);
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

test('two real worker processes admit exactly one 350 nano reservation', { timeout: 12000 }, async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = policyFor(ledgerPath);
    await initializeLedger({ ledgerPath, policy, now: NOW });
    await fundLedger({ ledgerPath, policy, allocation: allocationFor('0.000000350'), now: NOW });
    const workers = [worker('reserve', ledgerPath, ATTEMPT_A), worker('reserve', ledgerPath, ATTEMPT_B)];
    try {
      await Promise.all(workers.map(w => w.send({ type: 'policy', raw: rawPolicy(ledgerPath) })));
      await Promise.all(workers.map(w => w.wait('ready')));
      await Promise.all(workers.map(w => w.send({ type: 'go' })));
      const results = await Promise.all(workers.map(w => w.wait('result')));
      assert.deepEqual(results.map(result => result.ok).sort(), [false, true]);
      assert.equal(results.find(r => !r.ok).code, 'insufficient_funds');
      assert.deepEqual(balances(await inspectStatus({ ledgerPath, policy, now: NOW })), [350n, 0n, 350n, 0n]);
    } finally { await Promise.all(workers.map(w => w.stop())); }
  });
});

test('committed reservation survives SIGKILL and refuses same UUID on reopen', { timeout: 10000 }, async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false, amount: '0.000000350' });
    const w = worker('reserve-then-wait', ledgerPath, ATTEMPT_A);
    try {
      await w.send({ type: 'policy', raw: rawPolicy(ledgerPath) }); await w.wait('ready');
      await w.send({ type: 'go' }); await w.wait('committed');
      // Another connection observes the commit BEFORE the process is killed.
      assert.deepEqual(balances(await inspectStatus(args)), [350n, 0n, 350n, 0n]);
      assert.equal((await w.stop()).signal, 'SIGKILL');
      assert.deepEqual(balances(await inspectStatus(args)), [350n, 0n, 350n, 0n]);
      await assert.rejects(reserveAttempt({ ...args, attemptID: ATTEMPT_A, prepared: preparedFor(args.policy) }), { code: 'invalid_ledger' });
    } finally { await w.stop(); }
  });
});

// In-process overlap: one gateway process serves concurrent paid requests on ONE
// ledger. A second connection must never reach BEGIN IMMEDIATE while the first
// holds it across an awaited filesystem check, or busy_timeout blocks the event
// loop that the first operation needs to finish.
async function deadline(promise, label, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms); })]); }
  finally { clearTimeout(timer); }
}

test('same-tick in-process reservations on one funded ledger both commit', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false });
    const results = await Promise.allSettled([
      reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A }),
      reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_B }),
    ]);
    assert.deepEqual(results.map(r => r.status === 'fulfilled' ? 'ok' : r.reason.code), ['ok', 'ok']);
    assert.deepEqual(balances(await inspectStatus(args)), [700n, 0n, 700n, 0n]);
  });
});

test('overlapping settle and reserve on one ledger both commit', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath);
    const [settled, reserved] = await Promise.allSettled([
      settleAttempt({ ...args, attemptID: ATTEMPT_A, evidence: evidenceFor() }),
      reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_B }),
    ]);
    assert.equal(settled.status, 'fulfilled', settled.reason?.code); assert.equal(settled.value.state, 'SETTLED');
    assert.equal(reserved.status, 'fulfilled', reserved.reason?.code);
    assert.deepEqual(balances(await inspectStatus(args)), [700n, 0n, 350n, 350n]);
  });
});

test('a failed queued operation does not poison later operations on the same ledger', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false });
    let unhandled = null; const onUnhandled = error => { unhandled = error; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const [bad, good] = await Promise.allSettled([
        reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: 'not-a-uuid' }),
        reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A }),
      ]);
      assert.equal(bad.status, 'rejected'); assert.equal(bad.reason.code, 'invalid_ledger');
      assert.equal(good.status, 'fulfilled', good.reason?.code);
      await deadline(markUncertain({ ...args, attemptID: ATTEMPT_A, reason: 'after_failure' }), 'later operation');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(unhandled, null);
    } finally { process.off('unhandledRejection', onUnhandled); }
    const status = await inspectStatus(args);
    assert.deepEqual(balances(status), [700n, 350n, 350n, 0n]); assert.equal(status.attemptCounts.UNCERTAIN, 1);
  });
});

test('an operation stalled inside one ledger lifecycle neither breaks nor blocks other operations', async t => {
  await withLedgerDir(async first => withLedgerDir(async second => {
    const one = await setup(first, { reserve: false }); const two = await setup(second, { reserve: false });
    const entered = Promise.withResolvers(); const release = Promise.withResolvers(); let armed = false; let begins = 0;
    // Stall the first ledger's post-BEGIN privacy recheck: the real transaction lock is
    // held across this await, exactly where a second same-ledger connection would stall.
    const mock = t.mock.module('node:fs/promises', { exports: { ...realFS, lstat: async (...params) => {
      if (armed && params[0] === first) { armed = false; entered.resolve(); await release.promise; }
      return realFS.lstat(...params);
    } } });
    try {
      const module = await import('../lib/spend-budget.js?ledger-exclusion');
      const realExec = DatabaseSync.prototype.exec;
      const exec = t.mock.method(DatabaseSync.prototype, 'exec', function (text) {
        if (text === 'BEGIN IMMEDIATE' && begins++ === 0) armed = true;
        return realExec.call(this, text);
      });
      try {
        const stalled = module.reserveAttempt({ ...one, prepared: preparedFor(one.policy), attemptID: ATTEMPT_A });
        await deadline(entered.promise, 'first ledger transaction');
        const sameLedger = module.reserveAttempt({ ...one, prepared: preparedFor(one.policy), attemptID: ATTEMPT_B });
        // Independent ledgers are not globally serialized behind the stalled one.
        await deadline(module.reserveAttempt({ ...two, prepared: preparedFor(two.policy), attemptID: ATTEMPT_A }), 'independent ledger');
        release.resolve();
        const results = await Promise.allSettled([stalled, sameLedger]);
        assert.deepEqual(results.map(r => r.status === 'fulfilled' ? 'ok' : r.reason.code), ['ok', 'ok']);
      } finally { release.resolve(); exec.mock.restore(); }
    } finally { mock.restore(); }
    assert.deepEqual(balances(await inspectStatus(one)), [700n, 0n, 700n, 0n]);
    assert.deepEqual(balances(await inspectStatus(two)), [700n, 350n, 350n, 0n]);
  }));
});

test('reservation returns an immutable dispatch deadline from its validated epoch and policy', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false });
    const reserved = await reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A });
    assert.equal(reserved.dispatchDeadlineMs, Math.min(args.policy.validUntilMs, Date.parse(allocationFor().expiresAt)));
    assert.equal(reserved.dispatchDeadlineMs, Date.parse('2026-10-21T11:00:00.000Z'));
    assert.equal(Object.isFrozen(reserved), true);
    assert.throws(() => { reserved.dispatchDeadlineMs = Number.MAX_SAFE_INTEGER; }, TypeError);
  });
});

test('legacy schema1 DDL, user_version, status and reservation shapes are byte-for-byte unchanged', async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false });
    const reserved = await reserveAttempt({ ...args, prepared: preparedFor(args.policy), attemptID: ATTEMPT_A });
    const status = await inspectStatus(args);
    const ddl = sql(ledgerPath, db => db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all().map(row => `${row.type}|${row.name}|${row.sql}`).join('\n'));
    // Captured from the unmodified schema1 implementation before allocation support.
    assert.equal(createHash('sha256').update(ddl).digest('hex'), '381b01fec29bbe13fc0c4896904ee9d9bd7fe924d8fdaa77dfd1447aa363c5af');
    assert.equal(sql(ledgerPath, db => db.prepare('PRAGMA user_version').get().user_version), 1);
    assert.deepEqual(Object.keys(reserved), ['attemptID', 'epochID', 'requestDigest', 'bodyDigest', 'policyHash', 'providerID', 'origin', 'credentialFingerprint', 'model', 'maxInputTokens', 'maxOutputTokens', 'ratesNanoUSD', 'reserveNano', 'state', 'createdAtMs', 'dispatchDeadlineMs']);
    assert.deepEqual(Object.keys(status), ['schemaVersion', 'policyHash', 'fundedNano', 'availableNano', 'heldNano', 'spentNano', 'observedCostNano', 'additionalLiabilityNano', 'frozen', 'expired', 'epochID', 'reference', 'attemptCounts']);
    assert.equal(status.schemaVersion, 1);
  });
});

test('SIGKILL before go leaves zero debit and no attempt', { timeout: 10000 }, async () => {
  await withLedgerDir(async ledgerPath => {
    const args = await setup(ledgerPath, { reserve: false, amount: '0.000000350' });
    const before = await inspectStatus(args); const w = worker('reserve-then-wait', ledgerPath, ATTEMPT_A);
    try {
      await w.send({ type: 'policy', raw: rawPolicy(ledgerPath) }); await w.wait('ready');
      assert.equal((await w.stop()).signal, 'SIGKILL');
      assert.deepEqual(await inspectStatus(args), before);
    } finally { await w.stop(); }
  });
});
