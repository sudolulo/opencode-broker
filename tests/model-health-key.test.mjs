import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmodSync, linkSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateHealthKey, readHealthKey } from '../lib/model-health-key.js';

const frontDoorKeys = [Buffer.alloc(32, 1)];

test('private key creation refuses symlink and wrong owner or mode without repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-key-'));
  chmodSync(root, 0o700);
  try {
    const path = join(root, 'model-health.key');
    const key = loadOrCreateHealthKey(path, { frontDoorKeys });
    assert.equal(key.length, 32);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readHealthKey(path, { frontDoorKeys }), key);
    assert.throws(() => readHealthKey(path, { uid: process.getuid() + 1, frontDoorKeys }), /owner/);
    symlinkSync(path, join(root, 'link'));
    assert.throws(() => readHealthKey(join(root, 'link'), { frontDoorKeys }));
    chmodSync(path, 0o644);
    assert.throws(() => loadOrCreateHealthKey(path, { frontDoorKeys }), /mode/);
    assert.equal(lstatSync(path).mode & 0o777, 0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('private key reader rejects hard-linked leaves', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-key-'));
  chmodSync(root, 0o700);
  try {
    const path = join(root, 'model-health.key');
    loadOrCreateHealthKey(path, { frontDoorKeys });
    linkSync(path, join(root, 'second-link'));
    assert.throws(() => readHealthKey(path, { frontDoorKeys }), /owner\/type/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('private health key boundaries reject raw traversal through a symlink without touching either leaf', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-key-'));
  chmodSync(root, 0o700);
  try {
    const trusted = join(root, 'trusted');
    const outside = join(root, 'outside');
    const child = join(outside, 'child');
    fs.mkdirSync(trusted, { mode: 0o700 });
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.mkdirSync(child, { mode: 0o700 });
    symlinkSync(child, join(trusted, 'link'));

    const outsideExisting = join(outside, 'existing.key');
    const existingKey = Buffer.alloc(32, 7);
    writeFileSync(outsideExisting, existingKey, { mode: 0o600 });
    chmodSync(outsideExisting, 0o600);
    const rawExisting = `${trusted}/link/../existing.key`;
    assert.throws(() => readHealthKey(rawExisting, { frontDoorKeys }), /path traversal/);
    assert.deepEqual(fs.readFileSync(outsideExisting), existingKey);
    assert.equal(fs.existsSync(join(trusted, 'existing.key')), false);

    const rawNew = `${trusted}/link/../created.key`;
    assert.throws(() => loadOrCreateHealthKey(rawNew, { frontDoorKeys }), /path traversal/);
    assert.equal(fs.existsSync(join(outside, 'created.key')), false);
    assert.equal(fs.existsSync(join(trusted, 'created.key')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('private health keys must differ from front-door keys under UTF-8 and canonical base64url interpretations', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-key-'));
  chmodSync(root, 0o700);
  try {
    const utf8Path = join(root, 'utf8.key');
    const utf8Key = Buffer.from('01234567890123456789012345678901', 'utf8');
    assert.equal(utf8Key.length, 32);
    assert.throws(() => loadOrCreateHealthKey(utf8Path, { frontDoorKeys: [utf8Key.toString('utf8')], randomBytes: () => utf8Key }), /health key equals front-door key/);

    const base64Path = join(root, 'base64.key');
    const base64Key = Buffer.alloc(32, 8);
    assert.throws(() => loadOrCreateHealthKey(base64Path, { frontDoorKeys: [base64Key.toString('base64url')], randomBytes: () => base64Key }), /health key equals front-door key/);

    const distinctPath = join(root, 'distinct.key');
    const distinctKey = Buffer.alloc(32, 9);
    assert.deepEqual(loadOrCreateHealthKey(distinctPath, { frontDoorKeys: [base64Key.toString('base64url')], randomBytes: () => distinctKey }), distinctKey);
    assert.throws(() => readHealthKey(distinctPath), /frontDoorKeys/);
    assert.throws(() => loadOrCreateHealthKey(join(root, 'missing-front-door.key')), /frontDoorKeys/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('private health key rejects unsafe parents and malformed existing leaves without repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-key-'));
  chmodSync(root, 0o700);
  try {
    const parentModePath = join(root, 'parent-mode.key');
    chmodSync(root, 0o755);
    assert.throws(() => loadOrCreateHealthKey(parentModePath, { frontDoorKeys }), /parent owner\/mode/);
    chmodSync(root, 0o700);

    assert.throws(() => loadOrCreateHealthKey(join(root, 'parent-owner.key'), { uid: process.getuid() + 1, frontDoorKeys }), /parent owner\/mode/);

    const malformedPath = join(root, 'malformed.key');
    writeFileSync(malformedPath, Buffer.alloc(31));
    chmodSync(malformedPath, 0o600);
    assert.throws(() => loadOrCreateHealthKey(malformedPath, { frontDoorKeys }), /key length/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('private health key rejects a root immediate parent before opening its leaf', () => {
  const path = `/model-health-key-root-parent-${process.pid}-${Date.now()}`;
  const openSync = fs.openSync;
  let opens = 0;
  fs.openSync = () => {
    opens += 1;
    throw new Error('leaf open must not occur');
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => readHealthKey(path, { uid: process.getuid() + 1, frontDoorKeys }), /parent owner\/mode/);
    assert.equal(opens, 0);
  } finally {
    fs.openSync = openSync;
    syncBuiltinESMExports();
  }
});

test('exclusive creation preserves a racing existing key and creates new keys at mode 0600', () => {
  const root = mkdtempSync(join(tmpdir(), 'health-key-'));
  chmodSync(root, 0o700);
  try {
    const existingPath = join(root, 'existing.key');
    const existingKey = Buffer.alloc(32, 3);
    writeFileSync(existingPath, existingKey, { mode: 0o600 });
    chmodSync(existingPath, 0o600);
    assert.deepEqual(loadOrCreateHealthKey(existingPath, { frontDoorKeys, randomBytes: () => Buffer.alloc(32, 4) }), existingKey);

    const newPath = join(root, 'new.key');
    const newKey = Buffer.alloc(32, 5);
    assert.deepEqual(loadOrCreateHealthKey(newPath, { frontDoorKeys, randomBytes: () => {
      assert.equal(lstatSync(newPath).mode & 0o777, 0o600);
      return newKey;
    } }), newKey);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reader rejects a parent inode replacement between open and verification', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'health-key-'));
  chmodSync(root, 0o700);
  try {
    const parent = join(root, 'parent');
    const replacement = join(root, 'replacement');
    fs.mkdirSync(parent, { mode: 0o700 });
    fs.mkdirSync(replacement, { mode: 0o700 });
    const path = join(parent, 'model-health.key');
    const oldParent = join(root, 'old-parent');
    writeFileSync(path, Buffer.alloc(32, 6), { mode: 0o600 });
    chmodSync(path, 0o600);
    const openSync = fs.openSync;
    t.mock.method(fs, 'openSync', (openedPath, flags, mode) => {
      const fd = openSync(openedPath, flags, mode);
      if (openedPath === path) {
        fs.renameSync(parent, oldParent);
        fs.renameSync(replacement, parent);
      }
      return fd;
    });
    syncBuiltinESMExports();
    assert.throws(() => readHealthKey(path, { frontDoorKeys }), /parent changed/);
  } finally {
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
