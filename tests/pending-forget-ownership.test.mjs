import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const routingURL = new URL("../lib/routing.js", import.meta.url).href;
const prelude = `
  import assert from 'node:assert/strict';
  import * as fs from 'node:fs';
  import { join } from 'node:path';
  const directory = join(process.env.HOME, '.local/share/opencode/model-routing/pending-forgets');
  const ttl = 14 * 24 * 60 * 60 * 1000;
  const routing = await import(${JSON.stringify(routingURL)});
`;

const inPrivateHome = (script) => {
  const home = mkdtempSync(join(tmpdir(), "pending-forget-ownership-"));
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("an exact ownership handle removes only its immutable publication", () => {
  const result = inPrivateHome(`
    const routing = await import(${JSON.stringify(routingURL)});
    const first = routing.publishPendingForgetRecord("session_a", { leaseID: "lease_L1" });
    const second = routing.publishPendingForgetRecord("session_a", { leaseID: "lease_L2", completed: true });
    const removed = routing.removePendingForgetRecord("session_a", first);
    const records = routing.listPendingForgetRecords();
    process.stdout.write(JSON.stringify({ first, second, removed, records }));
  `);
  assert.notEqual(result.first.recordID, result.second.recordID);
  assert.equal(result.removed, true);
  assert.equal(result.records.some((record) => record.recordID === result.second.recordID), true);
});

test("completion versions precede older false versions and false success removes only itself", () => {
  inPrivateHome(prelude + `
    const a = routing.publishPendingForgetRecord('session', { leaseID: 'opaque / lease', updatedAt: Date.now() - 1000 });
    const b = routing.publishPendingForgetRecord('session', { leaseID: a.leaseID, completed: true });
    assert.equal(routing.listPendingForgetRecords()[0].recordID, b.recordID);
    assert.equal(routing.removePendingForgetRecord('session', a), true);
    assert.deepEqual(routing.listPendingForgetRecords(), [b]);
    process.stdout.write('{}');
  `);
});

test("TTL is original intent age at the exact boundary and expired publication cannot refresh it", () => {
  inPrivateHome(prelude + `
    const now = Date.now();
    Date.now = () => now;
    const handle = routing.publishPendingForgetRecord('session', { leaseID: 'L1', updatedAt: now - ttl + 1 });
    const path = join(directory, handle.recordID);
    const bytes = fs.readFileSync(path, 'utf8');
    for (let i = 0; i < 3; i++) {
      assert.equal(routing.listPendingForgetRecords()[0].updatedAt, now - ttl + 1);
      assert.equal(fs.readFileSync(path, 'utf8'), bytes);
    }
    Date.now = () => now + 1;
    assert.deepEqual(routing.listPendingForgetRecords(), []);
    assert.equal(fs.existsSync(path), false);
    assert.equal(routing.publishPendingForgetRecord('session', { leaseID: 'L1', updatedAt: now - ttl }), null);
    process.stdout.write('{}');
  `);
});

test("mixed invalid handles, wrong digest, malformed UUID and summary cannot remove intent", () => {
  inPrivateHome(prelude + `
    const handle = routing.publishPendingForgetRecord('session', { leaseID: ' L1 ' });
    for (const bad of [null, {}, routing.readPendingForgetRecord('session'),
      { ...handle, sessionID: '../session' }, { ...handle, leaseID: 'L1' },
      { ...handle, completed: 1 }, { ...handle, updatedAt: String(handle.updatedAt) },
      { ...handle, recordID: '../' + handle.recordID },
      { ...handle, recordID: handle.recordID.replace(/[a-f0-9]{64}/, 'a'.repeat(64)) }]) {
      assert.equal(routing.removePendingForgetRecord('session', bad), false);
    }
    const path = join(directory, handle.recordID);
    const invalid = handle.recordID.replace(/[a-f0-9]{64}/, 'a'.repeat(64));
    fs.copyFileSync(path, join(directory, invalid));
    assert.equal(routing.listPendingForgetRecords().length, 1);
    assert.equal(routing.writePendingForgetRecord('session', { leaseID: '  ' }), false);
    assert.equal(routing.writePendingForgetRecord('session'), false);
    assert.equal(fs.existsSync(path), true);
    process.stdout.write('{}');
  `);
});

test("legacy claims parse moved replacement bytes, preserve mtime and never delete a new source", () => {
  inPrivateHome(`
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const patched = createRequire(import.meta.url)('node:fs');
    const rename = patched.renameSync;
    patched.renameSync = (from, to) => {
      patched.writeFileSync(from, JSON.stringify({ leaseID: 'replacement', completed: true, updatedAt: Date.now() }));
      patched.utimesSync(from, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
      rename(from, to);
      patched.writeFileSync(from, JSON.stringify({ leaseID: 'next', updatedAt: Date.now() }));
    };
    syncBuiltinESMExports();
  ` + prelude + `
    fs.mkdirSync(directory, { recursive: true });
    const source = join(directory, 'session.json');
    fs.writeFileSync(source, JSON.stringify({ leaseID: 'old', updatedAt: Date.now() }));
    const [record] = routing.listPendingForgetRecords();
    assert.equal(record.leaseID, 'replacement');
    assert.ok(record.updatedAt <= Date.now() - 4900);
    assert.equal(routing.removePendingForgetRecord('session', record), true);
    assert.equal(JSON.parse(fs.readFileSync(source)).leaseID, 'next');
    assert.deepEqual(fs.readdirSync(directory), ['session.json']);
    process.stdout.write('{}');
  `);
});

test("read summary does not claim legacy files; listing discards only claimed ID-only data with warning", () => {
  inPrivateHome(prelude + `
    fs.mkdirSync(directory, { recursive: true });
    const source = join(directory, 'session.json');
    fs.writeFileSync(source, JSON.stringify({ completed: true, updatedAt: Date.now() }));
    const warnings = []; console.warn = (message) => warnings.push(message);
    assert.equal(routing.readPendingForgetRecord('session'), null);
    assert.deepEqual(fs.readdirSync(directory), ['session.json']);
    assert.deepEqual(routing.listPendingForgetRecords(), []);
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.ok(warnings.length > 0);
    process.stdout.write('{}');
  `);
});

test("publication is complete before link, exact private modes and final collision preserves foreign bytes", () => {
  inPrivateHome(`
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const patched = createRequire(import.meta.url)('node:fs');
    const link = patched.linkSync;
    let collision; let linkCount = 0;
    patched.linkSync = (from, to) => {
      const bytes = patched.readFileSync(from, 'utf8');
      if (JSON.parse(bytes).leaseID !== 'L1' || (patched.statSync(from).mode & 0o777) !== 0o600) throw Error('partial or public temp');
      if (++linkCount === 1) { collision = to; patched.writeFileSync(to, 'foreign', { flag: 'wx', mode: 0o600 }); }
      return link(from, to);
    };
    syncBuiltinESMExports();
  ` + prelude + `
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    const record = routing.publishPendingForgetRecord('session', { leaseID: 'L1' });
    assert.equal(linkCount, 2);
    assert.equal(fs.readFileSync(collision, 'utf8'), 'foreign');
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(join(directory, record.recordID)).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
    process.stdout.write('{}');
  `);
});

for (const stage of ['before-link', 'after-link', 'claim-created', 'claim-metadata', 'claim-moved']) {
  test('crash recovery at ' + stage + ' preserves live intent and bounds abandoned cleanup', () => {
    inPrivateHome(prelude + `
      const { spawnSync } = await import('node:child_process');
      fs.mkdirSync(directory, { recursive: true });
      const claiming = ${JSON.stringify(stage)}.startsWith('claim');
      if (claiming) fs.writeFileSync(join(directory, 'session.json'), JSON.stringify({ leaseID: 'L1', updatedAt: Date.now() }));
      const child = spawnSync(process.execPath, ['--require', ${JSON.stringify(new URL('./fixtures/pending-forget-ownership-crash.cjs', import.meta.url).pathname)}, '--input-type=module', '-e',
        'const r = await import(' + JSON.stringify(${JSON.stringify(routingURL)}) + '); ' + (claiming ? 'r.listPendingForgetRecords()' : 'r.publishPendingForgetRecord("session", { leaseID: "L1" })')],
        { env: { ...process.env, PENDING_CRASH_STAGE: ${JSON.stringify(stage)} }, encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 77, child.stderr);
      const records = routing.listPendingForgetRecords();
      assert.equal(records.length, ${stage === 'before-link' ? 0 : 1});
      for (const record of records) assert.equal(routing.removePendingForgetRecord(record.sessionID, record), true);
      const abandoned = fs.readdirSync(directory);
      assert.ok(abandoned.length >= ${stage === 'after-link' || stage === 'before-link' || stage === 'claim-created' || stage === 'claim-metadata' ? 1 : 0});
      const now = Date.now(); Date.now = () => now + ttl + 1000;
      routing.prunePendingForgetRecords();
      assert.deepEqual(fs.readdirSync(directory), []);
      process.stdout.write('{}');
    `);
  });
}

for (const outcome of ['failure', 'success', 'simultaneous']) {
  test('two processes: ' + outcome + ' never loses a newer publication', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pending-forget-processes-'));
    const children = [];
    const start = (lease) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', prelude + `
        const handle = routing.publishPendingForgetRecord('session', { leaseID: ${JSON.stringify(lease)} });
        process.send(handle);
        process.once('message', action => {
          if (action === 'success') routing.removePendingForgetRecord('session', handle);
          process.disconnect();
        });
      `], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('worker exit ' + code)));
      });
      return { child, exited, ready: new Promise((resolve) => child.once('message', resolve)) };
    };
    try {
      const a = start('L1');
      if (outcome !== 'simultaneous') await a.ready;
      const b = start('L2');
      await b.ready;
      if (outcome === 'simultaneous') await a.ready;
      b.child.send('failure'); a.child.send(outcome === 'success' ? 'success' : 'failure');
      await Promise.all([a.exited, b.exited]);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', prelude + `process.stdout.write(JSON.stringify(routing.listPendingForgetRecords()));`], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).map(r => r.leaseID).sort(), outcome === 'success' ? ['L2'] : ['L1', 'L2']);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("invalid and ID-only writes cannot delete an exact publication", () => {
  const result = inPrivateHome(`
    const routing = await import(${JSON.stringify(routingURL)});
    const handle = routing.publishPendingForgetRecord("session_a", { leaseID: "lease_L1" });
    const invalidWrite = routing.writePendingForgetRecord("session_a", { completed: true });
    const traversal = routing.removePendingForgetRecord("session_a", { ...handle, recordID: "../../foreign" });
    const missing = routing.removePendingForgetRecord("session_a");
    process.stdout.write(JSON.stringify({ invalidWrite, traversal, missing, count: routing.listPendingForgetRecords().length }));
  `);
  assert.equal(result.invalidWrite, false);
  assert.equal(result.traversal, false);
  assert.equal(result.missing, false);
  assert.equal(result.count, 1);
});
