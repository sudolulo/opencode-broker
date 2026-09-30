// The resolver overlay is a deterministic, append-only materialized view of authorization in the
// reconciliation ledger. It is not policy authority: every entry is checked back against the
// ledger and role registry before it can be rendered into a resolver generation.
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { candidateRevision } from "./reconcile-evidence.js";
import { routingStateDir } from "./routing.js";

export const RESOLVER_OVERLAY_VERSION = 1;

const OVERLAY_NAME = "resolver-overlay.json";
const LOCK_NAME = ".resolver-overlay.lock";
const OWNER_NAME = "owner";
const INSTANCE_PREFIX = "instance.";
const DEFAULT_LOCK_WAIT_MS = 5_000;
const POLL_MS = 5;
const OVERLAY_FIELDS = Object.freeze(["version", "revision", "updatedAt", "entries"]);
const ENTRY_FIELDS = Object.freeze([
  "transitionID", "revision", "authorizationKind", "providerID", "modelID", "roleKey",
  "authorizationHash", "introductionGeneration", "model",
]);
const MODEL_FIELDS = Object.freeze([
  "id", "name", "family", "release_date", "tool_call", "limit", "variants", "cost",
]);
const CATALOG_MODEL_FIELDS = Object.freeze(MODEL_FIELDS.filter((field) => field !== "cost"));
const COST_FIELDS = Object.freeze(["input", "output", "cache_read", "cache_write"]);
const LIMIT_FIELDS = Object.freeze(["context", "output"]);
const AUTHORIZED_STATES = new Set(["auto-eligible", "approved"]);
const CONTINUITY_CLAIMS = new Set(["successor", "recommended-replacement"]);
const MODEL_KEY = /^[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._:-]{1,180}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SENSITIVE_FIELD = /(?:apikey|credential|bearer|tokenpath|environment|baseurl)/i;

const isPlainObject = (value) => value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const assertExactFields = (value, allowed, label) => {
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

const canonicalHash = (value) => createHash("sha256").update(canonicalJSON(value)).digest("hex");

const cloneJSON = (value) => JSON.parse(JSON.stringify(value));

const assertNoSensitiveFields = (value, label) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveFields(entry, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [field, entry] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(field.replaceAll("_", ""))) {
      throw new Error(`${label} contains secret or unsupported field ${field}`);
    }
    assertNoSensitiveFields(entry, `${label}.${field}`);
  }
};

export const emptyResolverOverlay = ({ now = Date.now } = {}) => ({
  version: RESOLVER_OVERLAY_VERSION,
  revision: 0,
  updatedAt: now(),
  entries: {},
});

export const hashResolverOverlay = (overlay) => canonicalHash(overlay);

const recordModelID = (record) => record?.candidateModelID ?? record?.modelID ?? null;

const recordRevision = (record) => createHash("sha256")
  .update([
    candidateRevision(record),
    (Array.isArray(record?.proposedTiers) ? record.proposedTiers : []).join(","),
    String(record?.roleKey ?? ""),
  ].join("\u0000"))
  .digest("hex")
  .slice(0, 24);

const authorizationOf = (record) => {
  if (record?.state === "approved" && record?.approval?.decision !== "approved") {
    throw new Error(`record ${record?.transitionID ?? "unknown"} is approved without an approved decision`);
  }
  if (record?.approval?.decision === "approved") {
    return {
      kind: "approved",
      hash: canonicalHash(record.approval),
    };
  }
  const evidence = Array.isArray(record?.evidence) ? record.evidence : [];
  const authorizing = evidence.filter((claim) => claim?.policy === true
    && CONTINUITY_CLAIMS.has(claim?.claimType));
  if (!authorizing.length) throw new Error(`record ${record?.transitionID ?? "unknown"} has no authorizing evidence`);
  const expectedEvidenceRevision = candidateRevision(record);
  if (record.evidenceRevision !== expectedEvidenceRevision) {
    throw new Error(`record ${record.transitionID} evidence revision mismatch`);
  }
  if (record.evidenceContradiction === true) {
    throw new Error(`record ${record.transitionID} has contradictory authorizing evidence`);
  }
  return {
    kind: "auto-eligible",
    hash: canonicalHash({ evidenceRevision: record.evidenceRevision, evidence }),
  };
};

const ledgerRecords = (ledger) => {
  if (!isPlainObject(ledger)) throw new Error("resolver overlay ledger is not an object");
  const records = [];
  for (const field of ["roles", "unknown"]) {
    if (!isPlainObject(ledger[field])) throw new Error(`resolver overlay ledger ${field} is not an object`);
    for (const record of Object.values(ledger[field])) records.push(record);
  }
  return records;
};

const checkedRecord = (record, modelRoles) => {
  if (!isPlainObject(record)) throw new Error("resolver overlay ledger record is not an object");
  const providerID = record.providerID;
  const modelID = recordModelID(record);
  const roleKey = record.roleKey;
  if (typeof providerID !== "string" || typeof modelID !== "string" || typeof roleKey !== "string") {
    throw new Error(`resolver overlay record ${record.transitionID ?? "unknown"} has incomplete provider/model/role identity`);
  }
  const key = `${providerID}/${modelID}`;
  if (!MODEL_KEY.test(key)) throw new Error(`resolver overlay model key ${key} is invalid`);
  const role = isPlainObject(modelRoles) ? modelRoles[roleKey] : null;
  if (!role || role.providerID !== providerID || role.roleID !== record.roleID) {
    throw new Error(`resolver overlay role mismatch for ${key}`);
  }
  if (typeof record.transitionID !== "string" || record.transitionID.length === 0) {
    throw new Error(`resolver overlay record for ${key} is missing its transition ID`);
  }
  return { key, providerID, modelID, roleKey };
};

const validateCost = (cost, label) => {
  if (!isPlainObject(cost)) throw new Error(`${label} must be an object`);
  assertExactFields(cost, COST_FIELDS, label);
  for (const field of COST_FIELDS) {
    if (cost[field] !== 0) throw new Error(`${label}.${field} must be numeric zero`);
  }
  return { input: 0, output: 0, cache_read: 0, cache_write: 0 };
};

const validateModel = (model, modelID, { catalog = false } = {}) => {
  const label = catalog ? `catalog model ${modelID}` : `resolver overlay model ${modelID}`;
  if (!isPlainObject(model)) throw new Error(`${label} is not an object`);
  assertNoSensitiveFields(model, label);
  assertExactFields(model, catalog ? CATALOG_MODEL_FIELDS : MODEL_FIELDS, label);
  if (model.id !== modelID) throw new Error(`${label} id mismatch`);
  for (const field of ["name", "family", "release_date"]) {
    if (field in model && typeof model[field] !== "string") throw new Error(`${label}.${field} must be a string`);
  }
  if ("tool_call" in model && typeof model.tool_call !== "boolean") {
    throw new Error(`${label}.tool_call must be a boolean`);
  }
  if ("limit" in model) {
    if (!isPlainObject(model.limit)) throw new Error(`${label}.limit must be an object`);
    assertExactFields(model.limit, LIMIT_FIELDS, `${label}.limit`);
    for (const [field, value] of Object.entries(model.limit)) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${label}.limit.${field} must be a non-negative number`);
    }
  }
  if ("variants" in model) canonicalValue(model.variants, `${label}.variants`);
  if (!catalog) validateCost(model.cost, `${label}.cost`);
  return cloneJSON(model);
};

const catalogModel = (catalogModels, providerID, modelID) => {
  const provider = isPlainObject(catalogModels) ? catalogModels[providerID] : null;
  const models = isPlainObject(provider?.models) ? provider.models : provider;
  const model = isPlainObject(models) ? models[modelID] : null;
  if (!model) throw new Error(`catalog model ${providerID}/${modelID} is missing`);
  return validateModel(model, modelID, { catalog: true });
};

const resolverModel = (source, modelID) => {
  const model = {};
  for (const field of CATALOG_MODEL_FIELDS) if (field in source) model[field] = cloneJSON(source[field]);
  model.cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  return validateModel(model, modelID);
};

const normalizeEntry = (entry, key) => {
  if (!isPlainObject(entry)) throw new Error(`resolver overlay entry ${key} is not an object`);
  assertExactFields(entry, ENTRY_FIELDS, `resolver overlay entry ${key}`);
  if (!MODEL_KEY.test(key)) throw new Error(`resolver overlay entry key ${key} is invalid`);
  const [providerID, ...modelParts] = key.split("/");
  const modelID = modelParts.join("/");
  if (entry.providerID !== providerID || entry.modelID !== modelID) {
    throw new Error(`resolver overlay entry ${key} provider/model key mismatch`);
  }
  if (typeof entry.transitionID !== "string" || entry.transitionID.length === 0) {
    throw new Error(`resolver overlay entry ${key} has no transition ID`);
  }
  if (typeof entry.revision !== "string" || entry.revision.length === 0) {
    throw new Error(`resolver overlay entry ${key} has no revision`);
  }
  if (!AUTHORIZED_STATES.has(entry.authorizationKind)) {
    throw new Error(`resolver overlay entry ${key} has invalid authorization kind`);
  }
  if (typeof entry.roleKey !== "string" || entry.roleKey.length === 0) {
    throw new Error(`resolver overlay entry ${key} has no role key`);
  }
  if (!SHA256.test(entry.authorizationHash)) {
    throw new Error(`resolver overlay entry ${key} has invalid authorization hash`);
  }
  if (!Number.isInteger(entry.introductionGeneration) || entry.introductionGeneration <= 0) {
    throw new Error(`resolver overlay entry ${key} introduction generation must be a positive integer`);
  }
  return {
    transitionID: entry.transitionID,
    revision: entry.revision,
    authorizationKind: entry.authorizationKind,
    providerID: entry.providerID,
    modelID: entry.modelID,
    roleKey: entry.roleKey,
    authorizationHash: entry.authorizationHash,
    introductionGeneration: entry.introductionGeneration,
    model: validateModel(entry.model, entry.modelID),
  };
};

const normalizeOverlayShape = (overlay, { previous } = {}) => {
  if (!isPlainObject(overlay)) throw new Error("resolver overlay is not an object");
  assertExactFields(overlay, OVERLAY_FIELDS, "resolver overlay");
  if (overlay.version !== RESOLVER_OVERLAY_VERSION) {
    throw new Error(`unsupported resolver overlay version ${String(overlay.version)}`);
  }
  if (!Number.isInteger(overlay.revision) || overlay.revision < 0) {
    throw new Error(`resolver overlay revision ${String(overlay.revision)} is invalid`);
  }
  if (!Number.isFinite(overlay.updatedAt) || overlay.updatedAt < 0) {
    throw new Error(`resolver overlay updatedAt ${String(overlay.updatedAt)} is invalid`);
  }
  if (!isPlainObject(overlay.entries)) throw new Error("resolver overlay entries is not an object");
  const entries = Object.fromEntries(Object.entries(overlay.entries).sort(([left], [right]) => compareText(left, right))
    .map(([key, entry]) => [key, normalizeEntry(entry, key)]));
  if (overlay.revision === 0 && Object.keys(entries).length > 0) {
    throw new Error("resolver overlay revision zero cannot contain entries");
  }
  const normalized = {
    version: RESOLVER_OVERLAY_VERSION,
    revision: overlay.revision,
    updatedAt: overlay.updatedAt,
    entries,
  };
  if (!previous) return normalized;

  const prior = normalizeOverlayShape(previous);
  for (const [key, entry] of Object.entries(prior.entries)) {
    if (!(key in entries)) throw new Error(`resolver overlay append-only entry ${key} was removed`);
    if (canonicalJSON(entries[key]) !== canonicalJSON(entry)) {
      throw new Error(`resolver overlay append-only entry ${key} changed`);
    }
  }
  const added = Object.keys(entries).length - Object.keys(prior.entries).length;
  if (added === 0) {
    if (canonicalJSON(normalized) !== canonicalJSON(prior)) {
      throw new Error("resolver overlay changed without an append-only entry");
    }
  } else if (normalized.revision !== prior.revision + 1) {
    throw new Error(`resolver overlay revision must advance from ${prior.revision} to ${prior.revision + 1}`);
  }
  return normalized;
};

export const validateResolverOverlay = (overlay, { ledger, modelRoles, previous } = {}) => {
  const normalized = normalizeOverlayShape(overlay, { previous });
  const priorKeys = new Set(Object.keys(previous?.entries ?? {}));
  const byModel = new Map();
  for (const record of ledgerRecords(ledger)) {
    const identity = checkedRecord(record, modelRoles);
    if (byModel.has(identity.key)) throw new Error(`resolver overlay ledger has duplicate model ${identity.key}`);
    byModel.set(identity.key, { record, identity });
  }

  for (const [key, entry] of Object.entries(normalized.entries)) {
    const found = byModel.get(key);
    if (!found) throw new Error(`resolver overlay entry ${key} is orphaned from the ledger`);
    const { record, identity } = found;
    const authorization = authorizationOf(record);
    const expected = {
      transitionID: record.transitionID,
      revision: recordRevision(record),
      authorizationKind: authorization.kind,
      providerID: identity.providerID,
      modelID: identity.modelID,
      roleKey: identity.roleKey,
      authorizationHash: authorization.hash,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (entry[field] !== value) throw new Error(`resolver overlay entry ${key} ${field} mismatch`);
    }
    if (!priorKeys.has(key) && !AUTHORIZED_STATES.has(record.state)) {
      throw new Error(`resolver overlay entry ${key} is not currently authorized`);
    }
  }

  for (const [key, { record }] of byModel) {
    if (AUTHORIZED_STATES.has(record.state) && !(key in normalized.entries)) {
      throw new Error(`resolver overlay authorized entry ${key} is missing`);
    }
  }
  return cloneJSON(normalized);
};

export const buildResolverOverlay = ({
  ledger,
  modelRoles,
  catalogModels,
  introductionGeneration,
  overlayUpdatedAt,
  previous,
}) => {
  if (!Number.isFinite(overlayUpdatedAt) || overlayUpdatedAt < 0) {
    throw new Error("resolver overlay needs the durable apply intent overlayUpdatedAt");
  }
  const prior = previous === undefined
    ? emptyResolverOverlay({ now: () => overlayUpdatedAt })
    : normalizeOverlayShape(previous);
  const entries = cloneJSON(prior.entries);
  let added = 0;

  for (const record of ledgerRecords(ledger)) {
    if (!AUTHORIZED_STATES.has(record?.state)) continue;
    const identity = checkedRecord(record, modelRoles);
    const authorization = authorizationOf(record);
    const source = catalogModel(catalogModels, identity.providerID, identity.modelID);
    const introduction = entries[identity.key]?.introductionGeneration ?? introductionGeneration;
    if (!Number.isInteger(introduction) || introduction <= 0) {
      throw new Error(`resolver overlay ${identity.key} needs a positive reserved introduction generation`);
    }
    const desired = {
      transitionID: record.transitionID,
      revision: recordRevision(record),
      authorizationKind: authorization.kind,
      providerID: identity.providerID,
      modelID: identity.modelID,
      roleKey: identity.roleKey,
      authorizationHash: authorization.hash,
      introductionGeneration: introduction,
      model: resolverModel(source, identity.modelID),
    };
    if (entries[identity.key]) {
      if (canonicalJSON(entries[identity.key]) !== canonicalJSON(desired)) {
        throw new Error(`resolver overlay append-only entry ${identity.key} changed authorization or metadata`);
      }
    } else {
      entries[identity.key] = desired;
      added += 1;
    }
  }

  if (added === 0) return validateResolverOverlay(prior, { ledger, modelRoles, previous: prior });
  const overlay = {
    version: RESOLVER_OVERLAY_VERSION,
    revision: prior.revision + 1,
    updatedAt: overlayUpdatedAt,
    entries: Object.fromEntries(Object.entries(entries).sort(([left], [right]) => compareText(left, right))),
  };
  return validateResolverOverlay(overlay, { ledger, modelRoles, previous: prior });
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const readBootID = () => {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value || null;
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

const buildIdentity = (pid) => {
  const identity = { pid, acquiredAt: Date.now(), uuid: randomUUID() };
  const bootId = readBootID();
  if (bootId !== null) identity.bootId = bootId;
  const starttime = readStartTime(pid);
  if (starttime !== null) identity.starttime = starttime;
  return identity;
};

const identityState = (owner) => {
  const ownerPID = Number.isInteger(owner?.pid) && owner.pid > 0 ? owner.pid : null;
  if (ownerPID === null) return "unknown";
  let tiedToBoot = true;
  if (typeof owner.bootId === "string" && owner.bootId.length > 0) {
    const bootId = readBootID();
    if (bootId !== null && bootId !== owner.bootId) return "missing";
    tiedToBoot = bootId !== null;
  }
  const live = processState(ownerPID);
  if (live !== "live") return live;
  if (!tiedToBoot) return "unknown";
  if (typeof owner.starttime === "string" && owner.starttime.length > 0) {
    const starttime = readStartTime(ownerPID);
    if (starttime === null) return "unknown";
    if (starttime !== owner.starttime) return "missing";
  }
  return "live";
};

const readOwner = (directory) => {
  let text;
  try {
    text = readFileSync(join(directory, OWNER_NAME), "utf8");
  } catch {
    return null;
  }
  try {
    const owner = JSON.parse(text);
    return isPlainObject(owner) ? { owner, text } : null;
  } catch {
    return null;
  }
};

const createPrivateLock = (lockPath, identity, instanceName) => {
  const privatePath = `${lockPath}.${identity.pid}.${identity.uuid}`;
  mkdirSync(privatePath, { mode: 0o700 });
  try {
    chmodSync(privatePath, 0o700);
    const bytes = `${JSON.stringify(identity)}\n`;
    writeFileSync(join(privatePath, OWNER_NAME), bytes, { mode: 0o600 });
    writeFileSync(join(privatePath, instanceName), bytes, { mode: 0o600 });
  } catch (error) {
    try { rmSync(privatePath, { recursive: true, force: true }); } catch {}
    throw error;
  }
  return privatePath;
};

const inspectLock = (lockPath) => {
  let names;
  try {
    names = readdirSync(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { verdict: "retry" };
    throw error;
  }
  const instances = names.filter((name) => name.startsWith(INSTANCE_PREFIX));
  const record = readOwner(lockPath);
  if (record === null) return { verdict: names.length === 0 ? "retry" : "live" };
  if (identityState(record.owner) !== "missing") return { verdict: "live" };
  const uuid = typeof record.owner.uuid === "string" && record.owner.uuid ? record.owner.uuid : null;
  const instanceName = uuid === null ? null : `${INSTANCE_PREFIX}${record.owner.pid}.${uuid}`;
  if (instanceName && instances.includes(instanceName)) {
    return { verdict: "reclaim", instanceName, ownerText: record.text };
  }
  if (instances.length) return { verdict: "live" };
  return { verdict: "clear", ownerText: record.text };
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

const unlinkObservedOwner = (lockPath, text) => {
  try {
    if (readFileSync(join(lockPath, OWNER_NAME), "utf8") !== text) return false;
  } catch {
    return false;
  }
  return unlinkIfPresent(join(lockPath, OWNER_NAME));
};

const releaseLock = (lockPath, instanceName) => {
  if (!unlinkIfPresent(join(lockPath, instanceName))) return;
  unlinkIfPresent(join(lockPath, OWNER_NAME));
  try {
    rmdirSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
};

const sweepDeadPrivateLocks = (root, lockPath) => {
  const prefix = `${basename(lockPath)}.`;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix)) continue;
    const privatePath = join(root, name);
    const record = readOwner(privatePath);
    if (record !== null && identityState(record.owner) === "missing") {
      rmSync(privatePath, { recursive: true, force: true });
    }
  }
};

const sweepOverlayTemps = (root) => {
  for (const name of readdirSync(root)) {
    if (name.startsWith(".resolver-overlay.") && name.endsWith(".tmp")) {
      rmSync(join(root, name), { force: true });
    }
  }
};

const acquireLock = (root, lockPath, pid, lockWaitMs) => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const identity = buildIdentity(pid);
  const instanceName = `${INSTANCE_PREFIX}${identity.pid}.${identity.uuid}`;
  const privatePath = createPrivateLock(lockPath, identity, instanceName);
  const deadline = Date.now() + lockWaitMs;
  let published = false;
  try {
    while (!published) {
      try {
        renameSync(privatePath, lockPath);
        published = true;
        break;
      } catch (error) {
        if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
      }
      const observed = inspectLock(lockPath);
      let progressed = false;
      if (observed.verdict === "reclaim") {
        if (unlinkIfPresent(join(lockPath, observed.instanceName))) {
          unlinkObservedOwner(lockPath, observed.ownerText);
          progressed = true;
        }
      } else if (observed.verdict === "clear") {
        progressed = unlinkObservedOwner(lockPath, observed.ownerText);
      }
      if (progressed) continue;
      if (Date.now() >= deadline) throw new Error("resolver overlay lock timed out");
      sleep(POLL_MS);
    }
  } finally {
    if (!published) rmSync(privatePath, { recursive: true, force: true });
  }
  const release = () => releaseLock(lockPath, instanceName);
  try {
    sweepDeadPrivateLocks(root, lockPath);
    sweepOverlayTemps(root);
  } catch (error) {
    release();
    throw error;
  }
  return release;
};

const readOverlayFile = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`resolver overlay ${path} is corrupt JSON`, { cause: error });
  }
  try {
    return normalizeOverlayShape(parsed);
  } catch (error) {
    throw new Error(`resolver overlay ${path} is corrupt: ${error.message}`, { cause: error });
  }
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

const writeOverlayFile = (root, path, overlay, pid) => {
  const temp = join(root, `.resolver-overlay.${pid}.${randomUUID()}.tmp`);
  let descriptor;
  let committed = false;
  try {
    descriptor = openSync(temp, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(overlay, null, 1)}\n`);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temp, path);
    committed = true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!committed) {
      try { unlinkSync(temp); } catch {}
    }
  }
  fsyncDirectory(root);
};

export const createResolverOverlayStore = ({
  path: configuredPath,
  root: configuredRoot,
  lockPath: configuredLockPath,
  now = Date.now,
  pid = process.pid,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
} = {}) => {
  const root = configuredRoot ?? (configuredPath ? dirname(configuredPath) : routingStateDir());
  const overlay = configuredPath ?? join(root, OVERLAY_NAME);
  const lock = configuredLockPath ?? join(root, LOCK_NAME);
  if (dirname(overlay) !== root || dirname(lock) !== root) {
    throw new Error("resolver overlay and lock paths must be siblings under the state root");
  }
  const absent = normalizeOverlayShape(emptyResolverOverlay({ now }));
  const paths = () => ({ root, overlay, lock });
  const read = () => cloneJSON(readOverlayFile(overlay) ?? absent);
  const write = (desiredOverlay, { expectedPreviousHash, expectedRevision } = {}) => {
    if (typeof expectedPreviousHash !== "string" || !SHA256.test(expectedPreviousHash)) {
      throw new Error("resolver overlay write needs an expected previous canonical hash");
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("resolver overlay write needs an expected revision");
    }
    const desired = normalizeOverlayShape(desiredOverlay);
    const desiredHash = hashResolverOverlay(desired);
    const release = acquireLock(root, lock, pid, lockWaitMs);
    try {
      const current = readOverlayFile(overlay) ?? absent;
      const currentHash = hashResolverOverlay(current);
      if (desiredHash === currentHash) {
        return { changed: false, replayed: true, hash: currentHash, revision: current.revision };
      }
      if (currentHash !== expectedPreviousHash) throw new Error("stale overlay hash");
      if (current.revision !== expectedRevision) throw new Error("stale overlay revision");
      const normalized = normalizeOverlayShape(desired, { previous: current });
      writeOverlayFile(root, overlay, normalized, pid);
      return { changed: true, replayed: false, hash: desiredHash, revision: normalized.revision };
    } finally {
      release();
    }
  };
  return { read, write, paths };
};
