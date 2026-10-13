import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join, parse, resolve } from 'node:path';

function parentProof(path, uid) {
  const parent = dirname(path);
  const root = parse(parent).root;
  let current = root;
  for (const component of parent.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe parent');
    if (current === parent && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700)) throw new Error('parent owner/mode');
    if (current !== parent && stat.uid !== 0 && stat.uid !== uid) throw new Error('ancestor owner');
    if (current !== parent && (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) throw new Error('writable ancestor');
  }
  const stat = lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe parent');
  if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error('parent owner/mode');
  return stat;
}

function resolveHealthKeyPath(path) {
  if (typeof path !== 'string') throw new TypeError('key path must be a string');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(path)) throw new Error('path traversal');
  return resolve(path);
}

function openKey(path, uid, flags) {
  const before = parentProof(path, uid);
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    const after = parentProof(path, uid);
    if (before.ino !== after.ino || before.dev !== after.dev) throw new Error('parent changed');
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid) throw new Error('key owner/type');
    if ((stat.mode & 0o777) !== 0o600) throw new Error('key mode');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function sameBytes(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function frontDoorKeyCandidates(frontDoorKey) {
  if (Buffer.isBuffer(frontDoorKey)) return [frontDoorKey];
  if (typeof frontDoorKey !== 'string') throw new TypeError('frontDoorKeys must contain Buffer or string values');
  const candidates = [Buffer.from(frontDoorKey, 'utf8')];
  const decoded = Buffer.from(frontDoorKey, 'base64url');
  if (decoded.toString('base64url') === frontDoorKey) candidates.push(decoded);
  return candidates;
}

function assertDifferentFromFrontDoorKeys(key, frontDoorKeys) {
  if (!Array.isArray(frontDoorKeys) || frontDoorKeys.length === 0) throw new TypeError('frontDoorKeys must be a non-empty array');
  if (frontDoorKeys.flatMap(frontDoorKeyCandidates).some((candidate) => sameBytes(key, candidate))) {
    throw new Error('health key equals front-door key');
  }
}

function readHealthKeyAtPath(path, { uid, frontDoorKeys }) {
  const fd = openKey(path, uid, constants.O_RDONLY);
  try {
    const key = readFileSync(fd);
    if (key.length !== 32) throw new Error('key length');
    assertDifferentFromFrontDoorKeys(key, frontDoorKeys);
    return key;
  } finally {
    closeSync(fd);
  }
}

export function readHealthKey(path, { uid = process.getuid(), frontDoorKeys } = {}) {
  return readHealthKeyAtPath(resolveHealthKeyPath(path), { uid, frontDoorKeys });
}

export function loadOrCreateHealthKey(path, { uid = process.getuid(), randomBytes = cryptoRandomBytes, frontDoorKeys } = {}) {
  const absolutePath = resolveHealthKeyPath(path);
  if (!Array.isArray(frontDoorKeys) || frontDoorKeys.length === 0) throw new TypeError('frontDoorKeys must be a non-empty array');
  let fd;
  try {
    fd = openKey(absolutePath, uid, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  } catch (error) {
    if (error.code === 'EEXIST') return readHealthKeyAtPath(absolutePath, { uid, frontDoorKeys });
    throw error;
  }
  try {
    const key = randomBytes(32);
    let offset = 0;
    while (offset < key.length) {
      const written = writeSync(fd, key, offset, key.length - offset);
      if (written <= 0) throw new Error('short key write');
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(absolutePath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return readHealthKeyAtPath(absolutePath, { uid, frontDoorKeys });
}
