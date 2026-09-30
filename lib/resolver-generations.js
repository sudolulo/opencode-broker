// Resolver generations are immutable, resolver-validated configuration bundles. The registry is
// an identity index and monotonic high-water mark; policy authority remains in the reconciliation
// ledger and its append-only resolver overlay.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { hashResolverOverlay } from "./reconcile-overlay.js";
import { parseResolvableModelsOutput } from "./routing.js";

export const RESOLVER_REGISTRY_VERSION = 1;

const MANIFEST_VERSION = 1;
const REGISTRY_NAME = "resolver-generations.json";
const LOCK_NAME = ".resolver-generations.lock";
const OWNER_NAME = "owner";
const INSTANCE_PREFIX = "instance.";
const GENERATION_PREFIX = "generation-";
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const SHA256 = /^[a-f0-9]{64}$/;
const MODEL_KEY = /^[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._:-]{1,180}$/;
const OVERLAY_FIELDS = Object.freeze(["version", "revision", "updatedAt", "entries"]);
const ENTRY_FIELDS = Object.freeze([
  "transitionID", "revision", "authorizationKind", "providerID", "modelID", "roleKey",
  "authorizationHash", "introductionGeneration", "model",
]);
const MODEL_FIELDS = Object.freeze([
  "id", "name", "family", "release_date", "tool_call", "limit", "variants", "cost",
]);
const COST_FIELDS = Object.freeze(["input", "output", "cache_read", "cache_write"]);
const REGISTRY_FIELDS = Object.freeze(["version", "highWater", "generations"]);
const REGISTRY_ENTRY_FIELDS = Object.freeze(["manifestHash", "effectiveHash", "createdAt"]);
const MANIFEST_FIELDS = Object.freeze([
  "version", "generation", "baseHash", "overlayHash", "effectiveHash", "modelKeys",
  "createdAt", "authorizingRevisions",
]);
const PROTECTED_REFERENCE_FIELDS = Object.freeze(["roleKey", "kind", "modelKey"]);
const SENSITIVE_FIELD = /(?:apikey|credential|bearer|tokenpath|environment|baseurl)/i;
const execFileAsync = promisify(execFile);
const localPublishedLocks = new Set();

const isPlainObject = (value) => value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const cloneJSON = (value) => JSON.parse(JSON.stringify(value));
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const assertExactFields = (value, allowed, label) => {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const unsupported = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unsupported.length) throw new Error(`${label} carries unsupported field(s) ${unsupported.join(", ")}`);
};

const canonicalValue = (value, label = "value") => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalValue(entry, `${label}[${index}]`));
  if (!isPlainObject(value)) throw new Error(`${label} contains a non-JSON value`);
  return Object.fromEntries(Object.keys(value).sort(compareText)
    .map((key) => [key, canonicalValue(value[key], `${label}.${key}`)]));
};

const canonicalJSON = (value) => JSON.stringify(canonicalValue(value));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalHash = (value) => sha256(canonicalJSON(value));

const assertNoSensitiveFields = (value, label) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveFields(entry, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [field, entry] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(field.replaceAll("_", ""))) {
      throw new Error(`${label} contains unsupported secret or baseURL field ${field}`);
    }
    assertNoSensitiveFields(entry, `${label}.${field}`);
  }
};

const normalizeOverlay = (overlay) => {
  assertExactFields(overlay, OVERLAY_FIELDS, "resolver overlay");
  if (overlay.version !== 1) throw new Error(`unsupported resolver overlay version ${String(overlay.version)}`);
  if (!Number.isInteger(overlay.revision) || overlay.revision < 0) throw new Error("resolver overlay revision is invalid");
  if (!Number.isFinite(overlay.updatedAt) || overlay.updatedAt < 0) throw new Error("resolver overlay updatedAt is invalid");
  if (!isPlainObject(overlay.entries)) throw new Error("resolver overlay entries must be an object");
  const entries = {};
  for (const [key, source] of Object.entries(overlay.entries).sort(([left], [right]) => compareText(left, right))) {
    if (!MODEL_KEY.test(key)) throw new Error(`resolver overlay model key ${key} is invalid`);
    assertExactFields(source, ENTRY_FIELDS, `resolver overlay entry ${key}`);
    const slash = key.indexOf("/");
    const providerID = key.slice(0, slash);
    const modelID = key.slice(slash + 1);
    if (source.providerID !== providerID || source.modelID !== modelID) {
      throw new Error(`resolver overlay entry ${key} identity mismatch`);
    }
    if (typeof source.transitionID !== "string" || !source.transitionID
      || typeof source.revision !== "string" || !source.revision
      || typeof source.roleKey !== "string" || !source.roleKey) {
      throw new Error(`resolver overlay entry ${key} identity is incomplete`);
    }
    if (!new Set(["auto-eligible", "approved"]).has(source.authorizationKind)) {
      throw new Error(`resolver overlay entry ${key} authorization kind is invalid`);
    }
    if (!SHA256.test(source.authorizationHash)) throw new Error(`resolver overlay entry ${key} authorization hash is invalid`);
    if (!Number.isInteger(source.introductionGeneration) || source.introductionGeneration <= 0) {
      throw new Error(`resolver overlay entry ${key} introduction generation must be positive`);
    }
    assertExactFields(source.model, MODEL_FIELDS, `resolver overlay model ${key}`);
    assertNoSensitiveFields(source.model, `resolver overlay model ${key}`);
    if (source.model.id !== modelID) throw new Error(`resolver overlay model ${key} identity mismatch`);
    assertExactFields(source.model.cost, COST_FIELDS, `resolver overlay model ${key} cost`);
    for (const field of COST_FIELDS) {
      if (source.model.cost[field] !== 0) throw new Error(`resolver overlay model ${key} cost.${field} must be numeric zero`);
    }
    canonicalValue(source.model, `resolver overlay model ${key}`);
    entries[key] = cloneJSON(source);
  }
  if (overlay.revision === 0 && Object.keys(entries).length) {
    throw new Error("resolver overlay revision zero cannot contain entries");
  }
  return { version: 1, revision: overlay.revision, updatedAt: overlay.updatedAt, entries };
};

export const mergeResolverConfig = (baseConfig, overlay) => {
  if (!isPlainObject(baseConfig)) throw new Error("base resolver config must be an object");
  canonicalValue(baseConfig, "base resolver config");
  const normalizedOverlay = normalizeOverlay(overlay);
  const merged = cloneJSON(baseConfig);
  if (!isPlainObject(merged.provider)) throw new Error("base resolver config provider must be an object");
  for (const [key, entry] of Object.entries(normalizedOverlay.entries)) {
    const provider = merged.provider[entry.providerID];
    if (!isPlainObject(provider)) throw new Error(`overlay model ${key} requires existing provider ${entry.providerID}`);
    if (provider.models === undefined) provider.models = {};
    if (!isPlainObject(provider.models)) throw new Error(`base resolver provider ${entry.providerID}.models must be an object`);
    if (Object.hasOwn(provider.models, entry.modelID)) throw new Error(`resolver overlay collision at ${key}`);
    provider.models[entry.modelID] = cloneJSON(entry.model);
  }
  return merged;
};

const fsyncDirectory = (path) => {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const writePrivateFile = (path, bytes) => {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const ensurePrivateRoot = (root) => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`resolver generations root ${root} is not a canonical directory`);
  chmodSync(root, 0o700);
  const canonicalRoot = realpathSync(root);
  if (canonicalRoot !== resolve(root)) throw new Error(`resolver generations root ${root} escapes its canonical path`);
  return canonicalRoot;
};

const readBootID = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
};

const readStartTime = (pid) => {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const value = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
    return /^\d+$/.test(value ?? "") ? value : null;
  } catch {
    return null;
  }
};

const processState = (pid) => {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return error?.code === "ESRCH" ? "missing" : "unknown";
  }
};

const lockIdentity = (pid) => {
  const identity = { pid, acquiredAt: Date.now(), uuid: randomUUID() };
  const bootId = readBootID();
  if (bootId !== null) identity.bootId = bootId;
  const starttime = readStartTime(pid);
  if (starttime !== null) identity.starttime = starttime;
  return identity;
};

const identityState = (owner) => {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return "unknown";
  if (typeof owner.uuid === "string" && localPublishedLocks.has(owner.uuid)) return "live";
  if (typeof owner.bootId === "string" && owner.bootId) {
    const bootId = readBootID();
    if (bootId !== null && bootId !== owner.bootId) return "missing";
  }
  const state = processState(owner.pid);
  if (state !== "live") return state;
  if (typeof owner.starttime === "string" && owner.starttime) {
    const starttime = readStartTime(owner.pid);
    if (starttime === null) return "unknown";
    if (starttime !== owner.starttime) return "missing";
  }
  return "live";
};

const readLockOwner = (lockPath) => {
  try {
    const text = readFileSync(join(lockPath, OWNER_NAME), "utf8");
    const owner = JSON.parse(text);
    return isPlainObject(owner) ? { owner, text } : null;
  } catch {
    return null;
  }
};

const unlinkIfPresent = (path) => {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const inspectLock = (lockPath) => {
  let names;
  try {
    names = readdirSync(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { verdict: "retry" };
    throw error;
  }
  const record = readLockOwner(lockPath);
  const instances = names.filter((name) => name.startsWith(INSTANCE_PREFIX));
  if (record === null) return { verdict: names.length === 0 ? "retry" : "live" };
  if (identityState(record.owner) !== "missing") return { verdict: "live" };
  const instanceName = typeof record.owner.uuid === "string"
    ? `${INSTANCE_PREFIX}${record.owner.pid}.${record.owner.uuid}`
    : null;
  if (instanceName && instances.includes(instanceName)) {
    return { verdict: "reclaim", instanceName, ownerText: record.text };
  }
  return instances.length ? { verdict: "live" } : { verdict: "clear", ownerText: record.text };
};

const unlinkObservedOwner = (lockPath, ownerText) => {
  try {
    if (readFileSync(join(lockPath, OWNER_NAME), "utf8") !== ownerText) return false;
  } catch {
    return false;
  }
  return unlinkIfPresent(join(lockPath, OWNER_NAME));
};

const progressStaleLock = (lockPath) => {
  const observed = inspectLock(lockPath);
  if (observed.verdict === "reclaim") {
    if (!unlinkIfPresent(join(lockPath, observed.instanceName))) return true;
    unlinkObservedOwner(lockPath, observed.ownerText);
    return true;
  }
  if (observed.verdict === "clear") return unlinkObservedOwner(lockPath, observed.ownerText);
  return observed.verdict === "retry";
};

const makePrivateLock = (lockPath, pid) => {
  const identity = lockIdentity(pid);
  const instanceName = `${INSTANCE_PREFIX}${identity.pid}.${identity.uuid}`;
  const privatePath = `${lockPath}.${identity.pid}.${identity.uuid}`;
  mkdirSync(privatePath, { mode: 0o700 });
  localPublishedLocks.add(identity.uuid);
  try {
    const bytes = `${JSON.stringify(identity)}\n`;
    writeFileSync(join(privatePath, OWNER_NAME), bytes, { mode: 0o600 });
    writeFileSync(join(privatePath, instanceName), bytes, { mode: 0o600 });
  } catch (error) {
    localPublishedLocks.delete(identity.uuid);
    rmSync(privatePath, { recursive: true, force: true });
    throw error;
  }
  return { privatePath, instanceName, uuid: identity.uuid };
};

const sweepDeadPrivateLocks = (root, lockPath) => {
  const prefix = `${basename(lockPath)}.`;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix)) continue;
    const path = join(root, name);
    const record = readLockOwner(path);
    if (record !== null && identityState(record.owner) === "missing") {
      rmSync(path, { recursive: true, force: true });
    }
  }
};

const releasePublishedLock = (lockPath, instanceName) => {
  if (!unlinkIfPresent(join(lockPath, instanceName))) return;
  unlinkIfPresent(join(lockPath, OWNER_NAME));
  try {
    rmdirSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
};

const tryPublishLock = (privatePath, lockPath) => {
  try {
    renameSync(privatePath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return false;
    throw error;
  }
};

const acquireLock = async (root, lockPath, pid, lockWaitMs) => {
  ensurePrivateRoot(root);
  const { privatePath, instanceName, uuid } = makePrivateLock(lockPath, pid);
  const deadline = Date.now() + lockWaitMs;
  let published = false;
  try {
    while (!(published = tryPublishLock(privatePath, lockPath))) {
      if (!progressStaleLock(lockPath)) {
        if (Date.now() >= deadline) throw new Error("resolver generation manager lock timed out");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
    }
    localPublishedLocks.add(uuid);
  } finally {
    if (!published) {
      localPublishedLocks.delete(uuid);
      rmSync(privatePath, { recursive: true, force: true });
    }
  }
  try {
    sweepDeadPrivateLocks(root, lockPath);
  } catch (error) {
    releasePublishedLock(lockPath, instanceName);
    localPublishedLocks.delete(uuid);
    throw error;
  }
  return () => {
    try {
      releasePublishedLock(lockPath, instanceName);
    } finally {
      localPublishedLocks.delete(uuid);
    }
  };
};

const acquireLockSync = (root, lockPath, pid, lockWaitMs) => {
  ensurePrivateRoot(root);
  const { privatePath, instanceName, uuid } = makePrivateLock(lockPath, pid);
  const deadline = Date.now() + lockWaitMs;
  let published = false;
  try {
    while (!(published = tryPublishLock(privatePath, lockPath))) {
      if (!progressStaleLock(lockPath)) {
        if (Date.now() >= deadline) throw new Error("resolver generation manager lock timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    localPublishedLocks.add(uuid);
  } finally {
    if (!published) {
      localPublishedLocks.delete(uuid);
      rmSync(privatePath, { recursive: true, force: true });
    }
  }
  try {
    sweepDeadPrivateLocks(root, lockPath);
  } catch (error) {
    releasePublishedLock(lockPath, instanceName);
    localPublishedLocks.delete(uuid);
    throw error;
  }
  return () => {
    try {
      releasePublishedLock(lockPath, instanceName);
    } finally {
      localPublishedLocks.delete(uuid);
    }
  };
};

const emptyRegistry = () => ({ version: RESOLVER_REGISTRY_VERSION, highWater: 0, generations: {} });

const normalizeRegistry = (registry) => {
  assertExactFields(registry, REGISTRY_FIELDS, "resolver generation registry");
  if (registry.version !== RESOLVER_REGISTRY_VERSION) {
    throw new Error(`unsupported resolver generation registry version ${String(registry.version)}`);
  }
  if (!Number.isInteger(registry.highWater) || registry.highWater < 0) {
    throw new Error("resolver generation registry high-water is invalid");
  }
  if (!isPlainObject(registry.generations)) throw new Error("resolver generation registry generations must be an object");
  const generations = {};
  let maximum = -1;
  for (const [key, entry] of Object.entries(registry.generations)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error(`resolver generation registry key ${key} is not canonical`);
    const generation = Number(key);
    assertExactFields(entry, REGISTRY_ENTRY_FIELDS, `resolver generation registry entry ${key}`);
    if (!SHA256.test(entry.manifestHash) || !SHA256.test(entry.effectiveHash)) {
      throw new Error(`resolver generation registry entry ${key} has an invalid hash`);
    }
    if (!Number.isFinite(entry.createdAt) || entry.createdAt < 0) {
      throw new Error(`resolver generation registry entry ${key} createdAt is invalid`);
    }
    generations[key] = cloneJSON(entry);
    maximum = Math.max(maximum, generation);
  }
  if (maximum > registry.highWater) {
    throw new Error(`resolver generation registry high-water regressed below generation ${maximum}`);
  }
  return { version: RESOLVER_REGISTRY_VERSION, highWater: registry.highWater, generations };
};

const parseJSON = (bytes, label) => {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is corrupt JSON`, { cause: error });
  }
};

const normalizeManifest = (manifest) => {
  assertExactFields(manifest, MANIFEST_FIELDS, "resolver generation manifest");
  if (manifest.version !== MANIFEST_VERSION) throw new Error(`unsupported resolver generation manifest version ${String(manifest.version)}`);
  if (!Number.isInteger(manifest.generation) || manifest.generation < 0) throw new Error("resolver generation manifest generation is invalid");
  for (const field of ["baseHash", "overlayHash", "effectiveHash"]) {
    if (!SHA256.test(manifest[field])) throw new Error(`resolver generation manifest ${field} is invalid`);
  }
  if (!Number.isFinite(manifest.createdAt) || manifest.createdAt < 0) throw new Error("resolver generation manifest createdAt is invalid");
  if (!Array.isArray(manifest.modelKeys)
    || manifest.modelKeys.some((key) => typeof key !== "string" || !MODEL_KEY.test(key))) {
    throw new Error("resolver generation manifest modelKeys is invalid");
  }
  if (new Set(manifest.modelKeys).size !== manifest.modelKeys.length
    || [...manifest.modelKeys].sort(compareText).join("\0") !== manifest.modelKeys.join("\0")) {
    throw new Error("resolver generation manifest modelKeys is not an exact sorted set");
  }
  if (!Array.isArray(manifest.authorizingRevisions)
    || manifest.authorizingRevisions.some((revision) => typeof revision !== "string" || !revision)) {
    throw new Error("resolver generation manifest authorizingRevisions is invalid");
  }
  if (new Set(manifest.authorizingRevisions).size !== manifest.authorizingRevisions.length
    || [...manifest.authorizingRevisions].sort(compareText).join("\0") !== manifest.authorizingRevisions.join("\0")) {
    throw new Error("resolver generation manifest authorizingRevisions is not canonical");
  }
  return cloneJSON(manifest);
};

const normalizeRevisions = (revisions) => {
  if (!Array.isArray(revisions) || revisions.some((revision) => typeof revision !== "string" || !revision)) {
    throw new Error("authorizing revisions must be non-empty strings");
  }
  return [...new Set(revisions)].sort(compareText);
};

const normalizeReferences = (references, label) => {
  if (!Array.isArray(references)) throw new Error(`${label} must be an array`);
  return references.map((reference, index) => {
    assertExactFields(reference, PROTECTED_REFERENCE_FIELDS, `${label}[${index}]`);
    if (typeof reference.roleKey !== "string" || !reference.roleKey
      || typeof reference.kind !== "string" || !reference.kind
      || typeof reference.modelKey !== "string" || !MODEL_KEY.test(reference.modelKey)) {
      throw new Error(`${label}[${index}] is invalid`);
    }
    return cloneJSON(reference);
  });
};

const referenceIdentity = (reference) => `${reference.roleKey}\0${reference.kind}\0${reference.modelKey}`;

const assertProtectedReferences = (modelKeys, protectedReferences, authorizedRetirements) => {
  const available = new Set(modelKeys);
  const retired = new Set(authorizedRetirements.map(referenceIdentity));
  for (const reference of protectedReferences) {
    if (!available.has(reference.modelKey) && !retired.has(referenceIdentity(reference))) {
      throw new Error(`protected ${reference.kind} reference ${reference.modelKey} for ${reference.roleKey} was removed without the same authorized retirement`);
    }
  }
};

const regularFileBytes = (path, label) => {
  const stat = lstatOrNull(path);
  if (stat === null) throw new Error(`${label} is missing`);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a canonical regular file, not a symlink`);
  return readFileSync(path);
};

const writeAtomicJSON = (root, path, value, pid, prefix) => {
  const temp = join(root, `.${prefix}.${pid}.${randomUUID()}.tmp`);
  let committed = false;
  try {
    writePrivateFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, path);
    committed = true;
  } finally {
    if (!committed) {
      try { unlinkSync(temp); } catch {}
    }
  }
  fsyncDirectory(root);
};

const defaultRunResolver = async ({ env }) => {
  try {
    const { stdout } = await execFileAsync("opencode", ["models", "--pure"], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    return stdout;
  } catch (error) {
    throw new Error(`unable to render resolver generation via 'opencode models --pure': ${error?.message ?? error}`, { cause: error });
  }
};

export const createResolverGenerationManager = ({
  root,
  currentLinkPath,
  runResolver = defaultRunResolver,
  now = Date.now,
  pid = process.pid,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
} = {}) => {
  if (typeof root !== "string" || !root) throw new Error("resolver generations root is required");
  if (typeof currentLinkPath !== "string" || !currentLinkPath) throw new Error("resolver current link path is required");
  if (dirname(currentLinkPath) !== root) throw new Error("resolver current link must be a sibling under the generations root");
  if (typeof runResolver !== "function") throw new Error("resolver generation runResolver must be a function");
  const registryPath = join(root, REGISTRY_NAME);
  const lockPath = join(root, LOCK_NAME);
  const paths = () => ({ root, registry: registryPath, lock: lockPath, currentLink: currentLinkPath });

  const generationDirectory = (generation) => join(root, `${GENERATION_PREFIX}${generation}`);

  const readRegistryInternal = ({ allowedOrphanGeneration = null } = {}) => {
    const rootStat = lstatOrNull(root);
    if (rootStat === null) return emptyRegistry();
    ensurePrivateRoot(root);
    const registryStat = lstatOrNull(registryPath);
    if (registryStat === null) {
      const generationNames = readdirSync(root).filter((name) => /^generation-\d+$/.test(name));
      const allowedName = allowedOrphanGeneration === null
        ? null
        : `${GENERATION_PREFIX}${allowedOrphanGeneration}`;
      const isExactUnpublishedCandidate = allowedName !== null
        && generationNames.length === 1
        && generationNames[0] === allowedName
        && lstatOrNull(currentLinkPath) === null;
      if (!isExactUnpublishedCandidate
        && (generationNames.length > 0 || lstatOrNull(currentLinkPath) !== null)) {
        throw new Error("resolver generation registry is missing while generation directories or current link exist");
      }
      return emptyRegistry();
    }
    if (registryStat.isSymbolicLink() || !registryStat.isFile()) throw new Error("resolver generation registry must be a canonical regular file");
    try {
      return normalizeRegistry(parseJSON(readFileSync(registryPath), "resolver generation registry"));
    } catch (error) {
      throw new Error(`resolver generation registry is corrupt: ${error.message}`, { cause: error });
    }
  };
  const readRegistry = () => readRegistryInternal();

  const readBundle = (generation, { registryRecord = null, expected = null } = {}) => {
    if (!Number.isInteger(generation) || generation < 0) throw new Error("resolver generation must be a canonical non-negative integer");
    const canonicalRoot = ensurePrivateRoot(root);
    const directory = generationDirectory(generation);
    const directoryStat = lstatOrNull(directory);
    if (directoryStat === null) throw new Error(`resolver generation ${generation} is unknown or cleaned`);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`resolver generation ${generation} directory is a symlink or non-canonical`);
    }
    const canonicalDirectory = realpathSync(directory);
    if (canonicalDirectory !== resolve(directory)
      || (!canonicalDirectory.startsWith(`${canonicalRoot}${sep}`) && canonicalDirectory !== canonicalRoot)) {
      throw new Error(`resolver generation ${generation} directory escapes the canonical root`);
    }
    const manifestPath = join(canonicalDirectory, "manifest.json");
    const configPath = join(canonicalDirectory, "opencode.json");
    const manifestBytes = regularFileBytes(manifestPath, `resolver generation ${generation} manifest`);
    const configBytes = regularFileBytes(configPath, `resolver generation ${generation} effective config`);
    const manifestHash = sha256(manifestBytes);
    let manifest;
    let config;
    try {
      manifest = normalizeManifest(parseJSON(manifestBytes, `resolver generation ${generation} manifest`));
      config = parseJSON(configBytes, `resolver generation ${generation} effective config`);
      canonicalValue(config, `resolver generation ${generation} effective config`);
    } catch (error) {
      throw new Error(`resolver generation ${generation} manifest or effective config is corrupt: ${error.message}`, { cause: error });
    }
    const effectiveHash = canonicalHash(config);
    if (manifest.generation !== generation) throw new Error(`resolver generation ${generation} manifest generation mismatch`);
    if (manifest.effectiveHash !== effectiveHash) throw new Error(`resolver generation ${generation} effective hash mismatch`);
    if (registryRecord) {
      if (registryRecord.manifestHash !== manifestHash) throw new Error(`resolver generation ${generation} registry manifest hash mismatch`);
      if (registryRecord.effectiveHash !== effectiveHash) throw new Error(`resolver generation ${generation} registry effective hash mismatch`);
      if (registryRecord.createdAt !== manifest.createdAt) throw new Error(`resolver generation ${generation} registry createdAt mismatch`);
    }
    if (expected) {
      for (const field of ["baseHash", "overlayHash", "effectiveHash"]) {
        if (manifest[field] !== expected[field]) throw new Error(`immutable generation ${generation} ${field} mismatch`);
      }
      if (canonicalJSON(manifest.authorizingRevisions) !== canonicalJSON(expected.authorizingRevisions)) {
        throw new Error(`immutable generation ${generation} authorizing revisions mismatch`);
      }
      if (effectiveHash !== expected.effectiveHash) throw new Error(`immutable generation ${generation} effective hash mismatch`);
      if (expected.overlayKeys.some((key) => !manifest.modelKeys.includes(key))) {
        throw new Error(`immutable generation ${generation} resolver manifest is missing an overlay model`);
      }
    }
    return { generation, directory: canonicalDirectory, manifest, manifestHash, effectiveHash };
  };

  const generation = (generationNumber) => {
    if (!Number.isInteger(generationNumber) || generationNumber < 0) {
      throw new Error("resolver generation lookup requires a canonical non-negative integer");
    }
    const registry = readRegistry();
    const record = registry.generations[String(generationNumber)];
    if (!record) throw new Error(`resolver generation ${generationNumber} is unknown or cleaned`);
    return readBundle(generationNumber, { registryRecord: record });
  };

  const current = () => {
    const linkStat = lstatOrNull(currentLinkPath);
    if (linkStat === null) return null;
    if (!linkStat.isSymbolicLink()) throw new Error("resolver current path is not an atomic symlink");
    const target = readlinkSync(currentLinkPath);
    if (!/^generation-(0|[1-9]\d*)$/.test(target) || basename(target) !== target) {
      throw new Error("resolver current symlink target is not canonical");
    }
    const generationNumber = Number(target.slice(GENERATION_PREFIX.length));
    const resolvedOnce = realpathSync(currentLinkPath);
    const bundle = generation(generationNumber);
    if (resolvedOnce !== bundle.directory) throw new Error("resolver current symlink escapes or mismatches its registered generation");
    return bundle;
  };

  const historicalModelKeys = (registry) => {
    const keys = new Set();
    for (const key of Object.keys(registry.generations)) {
      for (const modelKey of generation(Number(key)).manifest.modelKeys) keys.add(modelKey);
    }
    return keys;
  };

  const build = async ({
    reservedGeneration,
    bootstrapGeneration0 = false,
    baseConfigPath,
    overlay,
    authorizingRevisions,
    protectedReferences,
    authorizedRetirements,
  } = {}) => {
    if (!Number.isInteger(reservedGeneration) || reservedGeneration < 0) {
      throw new Error("reserved generation must be a non-negative integer");
    }
    if (typeof baseConfigPath !== "string" || !baseConfigPath) throw new Error("base resolver config path is required");
    const revisions = normalizeRevisions(authorizingRevisions);
    const protectedSet = normalizeReferences(protectedReferences, "protected references");
    const retirements = normalizeReferences(authorizedRetirements, "authorized retirements");
    const baseBytes = regularFileBytes(baseConfigPath, "base resolver config");
    const base = parseJSON(baseBytes, "base resolver config");
    const normalizedOverlay = normalizeOverlay(overlay);
    const effective = mergeResolverConfig(base, normalizedOverlay);
    const baseHash = sha256(baseBytes);
    const overlayHash = hashResolverOverlay(normalizedOverlay);
    const effectiveHash = canonicalHash(effective);
    const overlayKeys = Object.keys(normalizedOverlay.entries).sort(compareText);
    const expected = { baseHash, overlayHash, effectiveHash, authorizingRevisions: revisions, overlayKeys };
    const release = await acquireLock(root, lockPath, pid, lockWaitMs);
    let tempDirectory = null;
    let scratchRoot = null;
    try {
      const registry = readRegistryInternal({ allowedOrphanGeneration: reservedGeneration });
      const currentLinkExists = lstatOrNull(currentLinkPath) !== null;
      if (bootstrapGeneration0) {
        if (reservedGeneration !== 0) throw new Error("bootstrap generation zero requires reserved generation 0");
        if (Object.keys(registry.generations).length || currentLinkExists) {
          throw new Error("bootstrap generation zero requires an empty registry and no current link");
        }
        if (overlayKeys.length) throw new Error("bootstrap generation zero requires an empty overlay");
      } else {
        if (reservedGeneration === 0) throw new Error("generation zero requires explicit bootstrap generation zero mode");
        const expectedGeneration = registry.highWater + 1;
        if (reservedGeneration !== expectedGeneration) {
          throw new Error(`reserved generation ${reservedGeneration} is stale; expected ${expectedGeneration}`);
        }
      }

      const historical = historicalModelKeys(registry);
      for (const [key, entry] of Object.entries(normalizedOverlay.entries)) {
        if (historical.has(key)) {
          if (entry.introductionGeneration > registry.highWater) {
            throw new Error(`overlay ${key} introduction generation is in the future`);
          }
        } else if (entry.introductionGeneration !== reservedGeneration) {
          throw new Error(`overlay ${key} introduction generation ${entry.introductionGeneration} does not match expected ${reservedGeneration}`);
        }
      }

      const active = current();
      if (active?.effectiveHash === effectiveHash) {
        return { ...active, reused: true };
      }

      const finalDirectory = generationDirectory(reservedGeneration);
      if (lstatOrNull(finalDirectory) !== null) {
        const recovered = readBundle(reservedGeneration, { expected });
        assertProtectedReferences(recovered.manifest.modelKeys, protectedSet, retirements);
        return { ...recovered, reused: true };
      }

      tempDirectory = join(root, `.generation-${reservedGeneration}.${pid}.${randomUUID()}.tmp`);
      mkdirSync(tempDirectory, { mode: 0o700 });
      chmodSync(tempDirectory, 0o700);
      const configPath = join(tempDirectory, "opencode.json");
      writePrivateFile(configPath, `${JSON.stringify(effective, null, 2)}\n`);

      scratchRoot = join(root, `.resolver-xdg.${reservedGeneration}.${pid}.${randomUUID()}.tmp`);
      const scratchConfigDirectory = join(scratchRoot, "opencode");
      mkdirSync(scratchConfigDirectory, { recursive: true, mode: 0o700 });
      chmodSync(scratchRoot, 0o700);
      chmodSync(scratchConfigDirectory, 0o700);
      symlinkSync(configPath, join(scratchConfigDirectory, "opencode.json"));
      let output;
      try {
        output = await runResolver({
          xdgConfigHome: scratchRoot,
          configPath,
          env: { ...process.env, XDG_CONFIG_HOME: scratchRoot },
        });
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true });
        scratchRoot = null;
      }
      const modelKeys = [...parseResolvableModelsOutput(output)].sort(compareText);
      if (!modelKeys.length) throw new Error("resolver generation listed no usable models");
      for (const key of overlayKeys) {
        if (!modelKeys.includes(key)) throw new Error(`resolver generation manifest is missing overlay model ${key}`);
      }
      assertProtectedReferences(modelKeys, protectedSet, retirements);
      const manifest = {
        version: MANIFEST_VERSION,
        generation: reservedGeneration,
        baseHash,
        overlayHash,
        effectiveHash,
        modelKeys,
        createdAt: now(),
        authorizingRevisions: revisions,
      };
      const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
      const manifestHash = sha256(manifestBytes);
      writePrivateFile(join(tempDirectory, "manifest.json"), manifestBytes);
      fsyncDirectory(tempDirectory);
      renameSync(tempDirectory, finalDirectory);
      tempDirectory = null;
      fsyncDirectory(root);
      return {
        generation: reservedGeneration,
        directory: realpathSync(finalDirectory),
        manifest: cloneJSON(manifest),
        manifestHash,
        effectiveHash,
        reused: false,
      };
    } finally {
      if (scratchRoot !== null) rmSync(scratchRoot, { recursive: true, force: true });
      if (tempDirectory !== null) rmSync(tempDirectory, { recursive: true, force: true });
      release();
    }
  };

  const publish = async (candidate) => {
    if (!isPlainObject(candidate) || !Number.isInteger(candidate.generation) || candidate.generation < 0) {
      throw new Error("resolver generation candidate is invalid");
    }
    const release = await acquireLock(root, lockPath, pid, lockWaitMs);
    try {
      const expectedDirectory = realpathSync(generationDirectory(candidate.generation));
      if (candidate.directory !== expectedDirectory) throw new Error("resolver generation candidate directory is not canonical");
      const verified = readBundle(candidate.generation);
      if (candidate.manifestHash !== verified.manifestHash
        || candidate.effectiveHash !== verified.effectiveHash
        || canonicalJSON(candidate.manifest) !== canonicalJSON(verified.manifest)) {
        throw new Error(`resolver generation ${candidate.generation} candidate hash mismatch`);
      }
      const registry = readRegistryInternal({ allowedOrphanGeneration: candidate.generation });
      const existing = registry.generations[String(candidate.generation)];
      let registryChanged = false;
      if (existing) {
        if (existing.manifestHash !== verified.manifestHash
          || existing.effectiveHash !== verified.effectiveHash
          || existing.createdAt !== verified.manifest.createdAt) {
          throw new Error(`resolver generation ${candidate.generation} registry hash mismatch`);
        }
      } else if (candidate.generation === 0
        && registry.highWater === 0
        && Object.keys(registry.generations).length === 0) {
        registry.generations[0] = {
          manifestHash: verified.manifestHash,
          effectiveHash: verified.effectiveHash,
          createdAt: verified.manifest.createdAt,
        };
        registryChanged = true;
      } else if (candidate.generation === registry.highWater + 1) {
        registry.highWater = candidate.generation;
        registry.generations[candidate.generation] = {
          manifestHash: verified.manifestHash,
          effectiveHash: verified.effectiveHash,
          createdAt: verified.manifest.createdAt,
        };
        registryChanged = true;
      } else {
        throw new Error(`resolver generation ${candidate.generation} cannot publish against high-water ${registry.highWater}`);
      }
      if (registryChanged) writeAtomicJSON(root, registryPath, normalizeRegistry(registry), pid, "resolver-generations");

      const tempLink = join(root, `.current.${pid}.${randomUUID()}.tmp`);
      let renamed = false;
      try {
        symlinkSync(basename(verified.directory), tempLink);
        renameSync(tempLink, currentLinkPath);
        renamed = true;
      } finally {
        if (!renamed) {
          try { unlinkSync(tempLink); } catch {}
        }
      }
      fsyncDirectory(root);
      return { ...verified, changed: registryChanged };
    } finally {
      release();
    }
  };

  const cleanup = ({ activeGenerations, olderThanMs = DEFAULT_RETENTION_MS } = {}) => {
    if (!(activeGenerations instanceof Set)
      || [...activeGenerations].some((value) => !Number.isInteger(value) || value < 0)) {
      throw new Error("cleanup activeGenerations must be a set of non-negative integers");
    }
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) throw new Error("cleanup olderThanMs must be non-negative");
    const release = acquireLockSync(root, lockPath, pid, lockWaitMs);
    try {
      const registry = readRegistry();
      const currentGeneration = current()?.generation ?? null;
      const removedTemp = [];
      const removedGenerations = [];
      for (const name of readdirSync(root).sort(compareText)) {
        const path = join(root, name);
        if (/^\.generation-\d+\..+\.tmp$/.test(name)
          || /^\.resolver-xdg\.\d+\..+\.tmp$/.test(name)
          || /^\.resolver-generations\.\d+\..+\.tmp$/.test(name)
          || /^\.current\..+\.tmp$/.test(name)) {
          rmSync(path, { recursive: true, force: true });
          removedTemp.push(name);
          continue;
        }
        const match = /^generation-(0|[1-9]\d*)$/.exec(name);
        if (!match) continue;
        const generationNumber = Number(match[1]);
        if (generationNumber === 0 || generationNumber === currentGeneration || activeGenerations.has(generationNumber)) continue;
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing to clean non-canonical generation path ${path}`);
        if (now() - statSync(path).mtimeMs < olderThanMs) continue;
        rmSync(path, { recursive: true });
        delete registry.generations[String(generationNumber)];
        removedGenerations.push(generationNumber);
      }
      if (removedGenerations.length) writeAtomicJSON(root, registryPath, normalizeRegistry(registry), pid, "resolver-generations");
      else if (removedTemp.length) fsyncDirectory(root);
      return { removedGenerations, removedTemp };
    } finally {
      release();
    }
  };

  return { readRegistry, build, publish, generation, current, cleanup, paths };
};
