// The reconciliation ledger: the ONE file the model reconciler may write, and the exclusive
// lock every mutation of it passes through.
//
// It shares a directory with the broker's other routing state, and that is what shapes most of
// the rules here:
//   - temp cleanup matches `.model-reconciliation.*.tmp` ONLY. lib/routing.js writes
//     `<name>.<pid>.<ms>.tmp` in the same root, and a broad `*.tmp` sweep would delete a
//     concurrent writer's in-flight temp, losing that write with no error anywhere;
//   - state is read through an explicit top-level whitelist and an exact version. An unknown
//     field or version is a NEWER writer's file: round-tripping it silently would drop the
//     fields this version does not know about, so both fail loudly instead.
//
// THE LOCK PROTOCOL
//
// The lock is published by RENAMING a fully built private directory onto the public lock path,
// not by mkdir. mkdir publishes an empty directory and writes the owner record afterwards, so a
// live holder is briefly indistinguishable from an abandoned one and can be stolen; and a
// reclaim that deletes "whatever is at the lock path" can delete the instance that replaced the
// one it condemned. Both were real:
//   - `.model-reconciliation.lock.<pid>.<uuid>` is built first, 0700, holding the complete
//     `owner` record AND an `instance.<pid>.<uuid>` file. Nothing reads it for liveness while it
//     is private, so there is no ownerless window at all;
//   - `renameSync(private, lockPath)` is the publication. On Linux (verified on Node 24.16) a
//     rename onto an EMPTY directory succeeds and a rename onto a populated one fails ENOTEMPTY
//     while moving nothing. So the instance file inside the lock is exactly what makes the lock
//     un-takeable, and an empty lock directory -- all a writer killed before this module existed
//     can leave -- is taken over immediately and destructively of nothing;
//   - a contender is reclaimed only on PROOF its identity is dead, and the reclaim is a single
//     unlink of the exact `instance.<pid>.<uuid>` that was observed. ENOENT there means another
//     actor already won, and nothing else is touched. lockPath itself is NEVER deleted
//     recursively -- removing the entries an identity owns is what frees it, and the empty
//     directory left behind is takeable by the next rename;
//   - proof of death is ESRCH from `kill(pid, 0)`, a recorded boot id that is not this boot, or
//     a `/proc/<pid>/stat` start time that does not match the record. EPERM, an unreadable
//     field, a missing /proc, or any other error reads as live: a stolen lock means two writers
//     in the same read-modify-write and a lost decision.
//
// An `owner` record stays legacy-compatible -- `pid` and `acquiredAt` are still there and still
// mean the same thing -- so a lock left by an older build is understood, and an older build
// reading one of ours sees a pid it can check.
import { chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";

import { routingStateDir } from "./routing.js";

export const RECONCILIATION_STATE_VERSION = 2;

const STATE_NAME = "model-reconciliation.json";
const LOCK_NAME = ".model-reconciliation.lock";
// The trailing dot matters: it is what keeps the public lock itself out of the private sweep.
const PRIVATE_LOCK_PREFIX = `${LOCK_NAME}.`;
const OWNER_NAME = "owner";
const INSTANCE_PREFIX = "instance.";
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const REVIEWED_NAME = "reviewed-models.json";
const TEMP_PREFIX = ".model-reconciliation.";
const DEFAULT_LOCK_WAIT_MS = 5_000;
const POLL_MS = 5;

// Version 1 defined exactly these top-level keys. A version-1 file is migrated in memory on read
// (migrateReconciliationState) and written back as version 2 only by the next locked update;
// reading never rewrites the file.
const V1_STATE_FIELDS = Object.freeze(["version", "updatedAt", "roles", "unknown", "evidenceRequests"]);
// The complete set of top-level keys version 2 defines. Anything else is a different schema.
// `revision` is the ledger revision Package 4 records cite: +1 on every committed update.
const STATE_FIELDS = Object.freeze([
  ...V1_STATE_FIELDS, "revision", "providerStages", "scheduledRuns",
  "generationRegistryInitialized", "configCutover", "legacyMigration",
]);
const MAP_FIELDS = Object.freeze(["roles", "unknown", "evidenceRequests", "providerStages"]);
// Records that are ABSENT until the step that creates them. There is no null form on disk.
const OPTIONAL_RECORDS = Object.freeze(["generationRegistryInitialized", "configCutover", "legacyMigration"]);

export const SCHEDULED_RUNS_LIMIT = 50;
export const DEFAULT_RAW_BASE_PATH = "/home/dev/devbox/config/opencode/opencode.json";
export const CONFIG_CUTOVER_MODES = Object.freeze(["generated", "raw-emergency"]);
export const CONFIG_CUTOVER_REASONS = Object.freeze(["bootstrap", "provider-stage", "emergency-rollback", "reactivation"]);
export const PROVIDER_STAGE_STATUSES = Object.freeze(["prepared", "committed", "gate-running", "healthy", "failed", "rolled-back"]);
export const SCHEDULED_RUN_MODES = Object.freeze(["dry-run", "apply"]);

const SHA256_HEX = /^[a-f0-9]{64}$/;
// Same syntax as provider/target IDs in lib/config.js (TARGET_ID) and lib/provider-health.js.
const PROVIDER_ID = /^[a-z0-9][a-z0-9._:-]{0,180}$/;
const RUN_ID = /^[A-Za-z0-9._:-]{1,200}$/;

// `<providerID>/<modelID>` exactly as opencode-broker-watch records it in reviewed-models.json.
const REVIEWED_KEY = /^[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._:-]{1,180}$/;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Synchronous by design: every caller of this module is a synchronous read-modify-write holding
// a cross-process lock, and yielding to the event loop inside that window would let this
// process start work that assumes the lock it is still waiting for.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const fsyncDirectory = (path) => {
  let fd;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const processState = (pid) => {
  try { process.kill(pid, 0); return "live"; }
  catch (error) { return error?.code === "ESRCH" ? "missing" : "unknown"; }
};

// Every recoverable problem in this module is something an operator has to go and look at: an
// orphaned lock directory, a ledger committed without a durable directory entry, a lock reclaimed
// out from under a live writer. None of them are worth failing a mutation over, and none of them
// may be silent.
const defaultOnWarning = (message) => { console.error(`opencode-broker: ${message}`); };

// Every sink is somebody else's code -- an injected logger writing to a closed stream, a notifier
// that raises -- and it is called from places where throwing is not survivable:
//   - AFTER the rename that commits the ledger, where a throw tells the caller a decision that is
//     already on disk never happened;
//   - inside release, where a throw abandons the rest of the release and buries the committed
//     state update's own return value;
//   - inside acquire's post-publication sweep, where a throw escapes BEFORE the release function
//     reaches the caller, leaving a published lock that nothing will ever release and a ledger
//     wedged until an operator clears it by hand.
// So the sink is wrapped once, at the factory boundary, and every warning path below it is
// non-throwing by construction. This is the one place in this module that swallows an error, and
// it is narrow on purpose: what it suppresses is a failure of the REPORTING channel only. The
// ledger write, the lock and their errors are untouched -- a broken logger must not be able to
// corrupt the thing it is logging about.
const nonThrowingWarning = (onWarning) => (message) => {
  try {
    onWarning(message);
  } catch (error) {
    try {
      // The operator needs both halves: what was being reported, and that their sink is broken.
      console.error(`opencode-broker: warning sink failed (${error?.message ?? error}) while reporting: ${message}`);
    } catch {
      // stderr is gone too -- a closed or full pipe. There is no channel left to report through,
      // and the state and lock invariants matter more than this message: carry on regardless.
    }
  }
};

const readBootID = () => {
  try {
    const bootId = readFileSync(BOOT_ID_PATH, "utf8").trim();
    return bootId.length > 0 ? bootId : null;
  } catch { return null; }
};

// Field 22 of `/proc/<pid>/stat`, the process start time in clock ticks since boot. Together with
// the boot id it makes a pid unique: a recycled pid has a different start time, and a pid from a
// previous boot has a different boot id.
const readStartTime = (pid) => {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field is parenthesised and may itself contain spaces and parentheses, so fields
    // are counted from after the LAST ')': that puts field 3 at index 0 and field 22 at index 19.
    const starttime = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
    return /^\d+$/.test(starttime ?? "") ? starttime : null;
  } catch { return null; }
};

const buildIdentity = (pid) => {
  const identity = { pid, acquiredAt: Date.now(), uuid: randomUUID() };
  // Recorded only when readable. An absent field is never proof of anything later, so writing a
  // placeholder would be worse than omitting it.
  const bootId = readBootID();
  if (bootId !== null) identity.bootId = bootId;
  const starttime = readStartTime(pid);
  if (starttime !== null) identity.starttime = starttime;
  return identity;
};

// "missing" is PROOF the recorded process is gone and is the only verdict that licenses a
// reclaim. "live" and "unknown" are treated identically by every caller -- the difference is only
// for reading the code.
const identityState = (owner) => {
  const pid = Number.isInteger(owner?.pid) && owner.pid > 0 ? owner.pid : null;
  if (pid === null) return "unknown";
  let tiedToThisBoot = true;
  if (typeof owner.bootId === "string" && owner.bootId.length > 0) {
    const bootId = readBootID();
    // A different boot is proof on its own: nothing survives a reboot, whatever pid answers now.
    if (bootId !== null && bootId !== owner.bootId) return "missing";
    tiedToThisBoot = bootId !== null;
  }
  const live = processState(pid);
  if (live !== "live") return live;
  // The pid answers, but a record we cannot tie to this boot says nothing about who that is.
  if (!tiedToThisBoot) return "unknown";
  if (typeof owner.starttime === "string" && owner.starttime.length > 0) {
    const starttime = readStartTime(pid);
    if (starttime === null) return "unknown";
    if (starttime !== owner.starttime) return "missing";
  }
  return "live";
};

// The record AND its exact bytes: the bytes are what later proves the file on disk is still the
// one whose identity was checked, because an owner record is only ever created inside a private
// directory and published by rename -- never rewritten in place.
const readOwnerRecord = (dir) => {
  let text;
  try { text = readFileSync(join(dir, OWNER_NAME), "utf8"); }
  catch { return null; }
  try {
    const owner = JSON.parse(text);
    return isPlainObject(owner) ? { owner, text } : null;
  } catch { return null; }
};

export const emptyReconciliationState = () => ({
  version: RECONCILIATION_STATE_VERSION,
  updatedAt: 0,
  revision: 0,
  roles: {},
  unknown: {},
  evidenceRequests: {},
  providerStages: {},
  scheduledRuns: [],
});

const fail = (message) => { throw new Error(message); };
// Safe integers only: above 2^53 `revision + 1` rounds back to the same value and the
// one-per-mutation revision counter would stall.
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
// Exactly the form Date#toISOString produces: UTC, millisecond precision, trailing Z.
const isUtcIso = (value) => typeof value === "string"
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString() === value;

const exactKeys = (value, fields, label) => {
  if (!isPlainObject(value)) fail(`${label} is not an object`);
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) fail(`${label} has unknown field ${key}`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing field ${key}`);
  }
};
const requireCount = (value, label) => {
  if (!isCount(value)) fail(`${label} must be a non-negative integer`);
};
const requireHash = (value, label) => {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) fail(`${label} must be a lowercase 64-hex SHA-256`);
};
const requireIso = (value, label) => {
  if (!isUtcIso(value)) fail(`${label} must be a UTC ISO-8601 timestamp`);
};
// A record can only cite a ledger revision that already exists, never a future one.
const requireRevision = (value, label, ledgerRevision) => {
  requireCount(value, label);
  if (value > ledgerRevision) fail(`${label} ${value} is ahead of ledger revision ${ledgerRevision}`);
};
const requireProviderList = (value, label) => {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  for (const id of value) {
    if (typeof id !== "string" || !PROVIDER_ID.test(id)) fail(`${label} has an invalid provider ID ${String(id)}`);
  }
  if (new Set(value).size !== value.length) fail(`${label} has duplicate provider IDs`);
};

// Key-order-independent equality for the immutability rules: a mutator that rebuilds an
// identical record in another key order has not changed it.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const sameRecord = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

const INIT_FIELDS = Object.freeze([
  "schemaVersion", "generation", "registryHash", "manifestHash", "rawBaseHash", "sourceLedgerRevision", "initializedAt",
]);

export const validateGenerationRegistryInitialized = (value, { ledgerRevision }) => {
  const label = "generationRegistryInitialized";
  exactKeys(value, INIT_FIELDS, label);
  if (value.schemaVersion !== 1) fail(`${label} schemaVersion must be 1`);
  if (value.generation !== 0) fail(`${label} generation must be 0`);
  requireHash(value.registryHash, `${label}.registryHash`);
  requireHash(value.manifestHash, `${label}.manifestHash`);
  requireHash(value.rawBaseHash, `${label}.rawBaseHash`);
  requireRevision(value.sourceLedgerRevision, `${label}.sourceLedgerRevision`, ledgerRevision);
  requireIso(value.initializedAt, `${label}.initializedAt`);
  return value;
};

const CUTOVER_FIELDS = Object.freeze([
  "schemaVersion", "mode", "target", "generation", "manifestHash", "registryHash", "rawBaseHash",
  "sourceLedgerRevision", "changedAt", "reason",
]);

// The valid-state table from the Package 4 spec. Only two shapes exist:
//   generated     -- non-negative generation, non-null manifestHash, initialization ack present;
//   raw-emergency -- null generation and manifestHash, ack present, raw/registry hashes retained.
// The target is compared as an exact string and never canonicalized first: an equivalent
// spelling of the approved path is a different, unapproved target.
export const validateConfigCutover = (value, { generationRegistryInitialized: init, ledgerRevision, targets }) => {
  const label = "configCutover";
  exactKeys(value, CUTOVER_FIELDS, label);
  if (value.schemaVersion !== 1) fail(`${label} schemaVersion must be 1`);
  if (!init) fail(`${label} requires a generationRegistryInitialized acknowledgement`);
  if (!CONFIG_CUTOVER_MODES.includes(value.mode)) fail(`${label} mode ${String(value.mode)} is invalid`);
  if (!CONFIG_CUTOVER_REASONS.includes(value.reason)) fail(`${label} reason ${String(value.reason)} is invalid`);
  const expectedTarget = value.mode === "generated" ? targets.generated : targets.rawEmergency;
  if (value.target !== expectedTarget) fail(`${label} target for mode ${value.mode} must be exactly ${expectedTarget}`);
  requireHash(value.registryHash, `${label}.registryHash`);
  requireHash(value.rawBaseHash, `${label}.rawBaseHash`);
  requireRevision(value.sourceLedgerRevision, `${label}.sourceLedgerRevision`, ledgerRevision);
  if (value.sourceLedgerRevision < init.sourceLedgerRevision) {
    fail(`${label} predates its generationRegistryInitialized acknowledgement`);
  }
  requireIso(value.changedAt, `${label}.changedAt`);
  if (value.mode === "raw-emergency") {
    if (value.generation !== null || value.manifestHash !== null) {
      fail(`${label} raw-emergency requires null generation and manifestHash`);
    }
    if (value.reason !== "emergency-rollback") fail(`${label} raw-emergency requires reason emergency-rollback`);
    return value;
  }
  requireCount(value.generation, `${label}.generation`);
  requireHash(value.manifestHash, `${label}.manifestHash`);
  if (value.reason === "emergency-rollback") fail(`${label} reason emergency-rollback requires mode raw-emergency`);
  if (value.reason === "bootstrap" && value.generation !== 0) fail(`${label} reason bootstrap requires generation 0`);
  // Generation 0 is immutable and acknowledged exactly once, so its manifest cannot differ.
  if (value.generation === 0 && value.manifestHash !== init.manifestHash) {
    fail(`${label} generation 0 does not match the generationRegistryInitialized acknowledgement`);
  }
  if (value.reason === "bootstrap" && value.rawBaseHash !== init.rawBaseHash) {
    fail(`${label} bootstrap rawBaseHash does not match the generationRegistryInitialized acknowledgement`);
  }
  return value;
};

const LEGACY_FIELDS = Object.freeze([
  "schemaVersion", "baselineCount", "baselineHash", "finalCount", "finalHash", "sourceLedgerRevision",
  "quiescedAt", "archivePath", "archiveHash",
]);

export const validateLegacyMigration = (value, { ledgerRevision }) => {
  const label = "legacyMigration";
  exactKeys(value, LEGACY_FIELDS, label);
  if (value.schemaVersion !== 1) fail(`${label} schemaVersion must be 1`);
  requireCount(value.baselineCount, `${label}.baselineCount`);
  requireHash(value.baselineHash, `${label}.baselineHash`);
  if (value.finalCount === null) {
    if (value.finalHash !== null) fail(`${label}.finalHash requires finalCount`);
  } else {
    requireCount(value.finalCount, `${label}.finalCount`);
    // The final key set is B + D: the import only ever adds keys to the baseline.
    if (value.finalCount < value.baselineCount) fail(`${label}.finalCount is below baselineCount`);
    requireHash(value.finalHash, `${label}.finalHash`);
  }
  // The baseline phase is written before the final import names its revision, so null is allowed
  // until finalCount is set (CONTRACT v2).
  if (value.sourceLedgerRevision !== null) {
    requireRevision(value.sourceLedgerRevision, `${label}.sourceLedgerRevision`, ledgerRevision);
  }
  if (value.finalCount !== null && value.sourceLedgerRevision === null) {
    fail(`${label}.sourceLedgerRevision is required once finalCount is set`);
  }
  if (value.quiescedAt !== null) requireIso(value.quiescedAt, `${label}.quiescedAt`);
  if (value.archivePath === null) {
    if (value.archiveHash !== null) fail(`${label}.archiveHash requires archivePath`);
  } else {
    if (typeof value.archivePath !== "string" || !isAbsolute(value.archivePath)
      || normalize(value.archivePath) !== value.archivePath) {
      fail(`${label}.archivePath must be a normalized absolute path`);
    }
    requireHash(value.archiveHash, `${label}.archiveHash`);
  }
  return value;
};

const STAGE_FIELDS = Object.freeze(["schemaVersion", "status", "prepared", "committed", "checkpoint", "gate"]);
const PREPARED_FIELDS = Object.freeze([
  "at", "allowlist", "ledgerRevision", "overlayHash", "effectiveHash", "baseHash", "manifestHash", "policyIntentHash",
]);
const COMMITTED_FIELDS = Object.freeze(["at", "generation", "manifestHash", "generationAck", "brokerAck", "ledgerAck"]);
const CHECKPOINT_FIELDS = Object.freeze(["generation", "manifestHash", "allowlist", "ledgerRevision", "brokerPolicyRevision"]);
const GATE_FIELDS = Object.freeze(["startedAt", "completedAt", "scheduledRunIDs", "evidence", "resetCount"]);

export const validateProviderStage = (providerID, value, { ledgerRevision }) => {
  if (typeof providerID !== "string" || !PROVIDER_ID.test(providerID)) {
    fail(`providerStages key ${String(providerID)} is not a valid provider ID`);
  }
  const label = `providerStages.${providerID}`;
  exactKeys(value, STAGE_FIELDS, label);
  if (value.schemaVersion !== 1) fail(`${label} schemaVersion must be 1`);
  if (!PROVIDER_STAGE_STATUSES.includes(value.status)) fail(`${label} status ${String(value.status)} is invalid`);
  const { prepared, committed, checkpoint, gate } = value;

  exactKeys(prepared, PREPARED_FIELDS, `${label}.prepared`);
  requireIso(prepared.at, `${label}.prepared.at`);
  requireProviderList(prepared.allowlist, `${label}.prepared.allowlist`);
  if (!prepared.allowlist.includes(providerID)) fail(`${label}.prepared.allowlist must include ${providerID}`);
  requireRevision(prepared.ledgerRevision, `${label}.prepared.ledgerRevision`, ledgerRevision);
  for (const field of ["overlayHash", "effectiveHash", "baseHash", "policyIntentHash"]) {
    requireHash(prepared[field], `${label}.prepared.${field}`);
  }
  // A prepare that has not published a generation yet has no manifest to name.
  if (prepared.manifestHash !== null) requireHash(prepared.manifestHash, `${label}.prepared.manifestHash`);

  if (committed !== null) {
    exactKeys(committed, COMMITTED_FIELDS, `${label}.committed`);
    requireIso(committed.at, `${label}.committed.at`);
    requireCount(committed.generation, `${label}.committed.generation`);
    requireHash(committed.manifestHash, `${label}.committed.manifestHash`);
    if (!isPlainObject(committed.generationAck)
      || committed.generationAck.generation !== committed.generation
      || committed.generationAck.manifestHash !== committed.manifestHash) {
      fail(`${label}.committed.generationAck does not match committed generation ${committed.generation}`);
    }
    // brokerAck is null when the stage changed no broker policy (spec: "when policy changes").
    if (committed.brokerAck !== null && !isPlainObject(committed.brokerAck)) {
      fail(`${label}.committed.brokerAck must be an object or null`);
    }
    if (!isPlainObject(committed.ledgerAck)) fail(`${label}.committed.ledgerAck must be an object`);
  }

  if (checkpoint !== null) {
    exactKeys(checkpoint, CHECKPOINT_FIELDS, `${label}.checkpoint`);
    requireCount(checkpoint.generation, `${label}.checkpoint.generation`);
    requireHash(checkpoint.manifestHash, `${label}.checkpoint.manifestHash`);
    requireProviderList(checkpoint.allowlist, `${label}.checkpoint.allowlist`);
    requireRevision(checkpoint.ledgerRevision, `${label}.checkpoint.ledgerRevision`, ledgerRevision);
    const policy = checkpoint.brokerPolicyRevision;
    if (policy !== null && !isCount(policy) && !(typeof policy === "string" && policy.length > 0)) {
      fail(`${label}.checkpoint.brokerPolicyRevision must be null, a non-negative integer or a non-empty string`);
    }
  }

  if (gate !== null) {
    exactKeys(gate, GATE_FIELDS, `${label}.gate`);
    if (gate.startedAt !== null) requireIso(gate.startedAt, `${label}.gate.startedAt`);
    if (gate.completedAt !== null) {
      requireIso(gate.completedAt, `${label}.gate.completedAt`);
      if (gate.startedAt === null) fail(`${label}.gate.completedAt requires gate.startedAt`);
      if (Date.parse(gate.completedAt) < Date.parse(gate.startedAt)) fail(`${label}.gate.completedAt precedes gate.startedAt`);
    }
    if (!Array.isArray(gate.scheduledRunIDs) || gate.scheduledRunIDs.some((id) => typeof id !== "string" || !RUN_ID.test(id))) {
      fail(`${label}.gate.scheduledRunIDs must be an array of run IDs`);
    }
    if (new Set(gate.scheduledRunIDs).size !== gate.scheduledRunIDs.length) {
      fail(`${label}.gate.scheduledRunIDs has duplicate run IDs`);
    }
    if (!Array.isArray(gate.evidence) || gate.evidence.some((entry) => !isPlainObject(entry))) {
      fail(`${label}.gate.evidence must be an array of objects`);
    }
    requireCount(gate.resetCount, `${label}.gate.resetCount`);
  }

  // Status consistency. failed and rolled-back can stop anywhere in the saga, so they carry
  // whatever evidence existed when they stopped and are not constrained further here.
  switch (value.status) {
    case "prepared":
      if (committed !== null) fail(`${label} status prepared cannot carry committed evidence`);
      // A prepared stage MAY carry a gate whose completedAt is null; re-preparing after a failed
      // gate keeps resetCount history.
      if (gate !== null && gate.startedAt === null) fail(`${label} status prepared requires a gate with startedAt set`);
      break;
    case "committed":
      if (committed === null || checkpoint === null) fail(`${label} status committed requires committed and checkpoint`);
      break;
    case "gate-running":
      if (committed === null || checkpoint === null) fail(`${label} status gate-running requires committed and checkpoint`);
      if (gate === null || gate.startedAt === null || gate.completedAt !== null) {
        fail(`${label} status gate-running requires a started, uncompleted gate`);
      }
      break;
    case "healthy":
      if (committed === null || checkpoint === null) fail(`${label} status healthy requires committed and checkpoint`);
      if (gate === null || gate.completedAt === null) fail(`${label} status healthy requires a completed gate`);
      break;
    default:
      break;
  }
  return value;
};

const RUN_FIELDS = Object.freeze(["id", "startedAt", "endedAt", "ok", "mode", "providers", "ledgerRevision", "exitCode"]);

export const validateScheduledRuns = (runs, { ledgerRevision }) => {
  if (!Array.isArray(runs)) fail("reconciliation state field scheduledRuns is not an array");
  if (runs.length > SCHEDULED_RUNS_LIMIT) {
    fail(`scheduledRuns holds ${runs.length} entries; the limit is ${SCHEDULED_RUNS_LIMIT}`);
  }
  const seen = new Set();
  runs.forEach((run, index) => {
    const label = `scheduledRuns[${index}]`;
    exactKeys(run, RUN_FIELDS, label);
    if (typeof run.id !== "string" || !RUN_ID.test(run.id)) fail(`${label}.id is invalid`);
    if (seen.has(run.id)) fail(`scheduledRuns has duplicate id ${run.id}`);
    seen.add(run.id);
    requireIso(run.startedAt, `${label}.startedAt`);
    // A run still in flight has neither; a finished run has both.
    if ((run.endedAt === null) !== (run.exitCode === null)) {
      fail(`${label}.endedAt and exitCode must both be null or both be set`);
    }
    if (run.endedAt !== null) requireIso(run.endedAt, `${label}.endedAt`);
    if (run.exitCode !== null && !(Number.isInteger(run.exitCode) && run.exitCode >= 0 && run.exitCode <= 255)) {
      fail(`${label}.exitCode must be an integer from 0 to 255`);
    }
    if (typeof run.ok !== "boolean") fail(`${label}.ok must be a boolean`);
    if (!SCHEDULED_RUN_MODES.includes(run.mode)) fail(`${label}.mode ${String(run.mode)} is invalid`);
    requireProviderList(run.providers, `${label}.providers`);
    requireRevision(run.ledgerRevision, `${label}.ledgerRevision`, ledgerRevision);
  });
  return runs;
};

// Appends one run and keeps the newest SCHEDULED_RUNS_LIMIT, oldest first. Returns a new array
// and never mutates its input; the store validates the result when it is written.
export const appendScheduledRun = (runs, run) => {
  if (!Array.isArray(runs)) fail("scheduledRuns must be an array");
  return [...runs, run].slice(-SCHEDULED_RUNS_LIMIT);
};

// The one explicit v1 -> v2 step. Strict: a v1 file with a key v1 never defined is a different
// writer's schema, and silently carrying it forward would lose what it meant, so it fails closed.
export const migrateReconciliationState = (value) => {
  if (!isPlainObject(value) || value.version !== 1) return value;
  for (const key of Object.keys(value)) {
    if (!V1_STATE_FIELDS.includes(key)) fail(`unknown reconciliation state v1 field ${key}`);
  }
  for (const key of V1_STATE_FIELDS) {
    if (!Object.hasOwn(value, key)) fail(`reconciliation state v1 is missing field ${key}`);
  }
  return { ...value, version: RECONCILIATION_STATE_VERSION, revision: 0, providerStages: {}, scheduledRuns: [] };
};

const validateState = (value, targets) => {
  if (!isPlainObject(value)) fail("reconciliation state is not an object");
  for (const key of Object.keys(value)) {
    if (!STATE_FIELDS.includes(key)) fail(`unknown reconciliation state field ${key}`);
  }
  if (value.version !== RECONCILIATION_STATE_VERSION) {
    fail(`unsupported reconciliation state version ${String(value.version)}`);
  }
  if (!Number.isFinite(value.updatedAt) || value.updatedAt < 0) {
    fail(`reconciliation state has an invalid updatedAt ${String(value.updatedAt)}`);
  }
  if (!isCount(value.revision)) fail(`reconciliation state has an invalid revision ${String(value.revision)}`);
  for (const field of MAP_FIELDS) {
    if (!isPlainObject(value[field])) fail(`reconciliation state field ${field} is not an object`);
  }
  const ledgerRevision = value.revision;
  validateScheduledRuns(value.scheduledRuns, { ledgerRevision });
  const init = value.generationRegistryInitialized;
  if (init !== undefined) validateGenerationRegistryInitialized(init, { ledgerRevision });
  if (value.configCutover !== undefined) {
    validateConfigCutover(value.configCutover, { generationRegistryInitialized: init, ledgerRevision, targets });
  }
  if (value.legacyMigration !== undefined) validateLegacyMigration(value.legacyMigration, { ledgerRevision });
  for (const [providerID, stage] of Object.entries(value.providerStages)) {
    validateProviderStage(providerID, stage, { ledgerRevision });
  }
  return value;
};

// A mutator may express "not recorded" as null or by omitting the key; on disk it is always
// omission, so there is one representation and the transition rules see removal as removal.
const dropAbsentRecords = (value) => {
  const next = { ...value };
  for (const field of OPTIONAL_RECORDS) {
    if (next[field] === null || next[field] === undefined) delete next[field];
  }
  return next;
};

// Rules that need the PREVIOUS state, so they live here rather than in validateState:
//   - generationRegistryInitialized is written exactly once: never changed, deleted or nulled;
//   - a newly written generationRegistryInitialized, and a newly written or changed
//     configCutover, cite the very mutation that writes them (spec: "supplied by the enclosing
//     ledger mutation acknowledgement"); update() hands that revision to the mutator;
//   - configCutover and legacyMigration are never removed once written;
//   - legacyMigration's baseline is immutable once recorded.
const validateTransition = (current, next) => {
  const priorInit = current.generationRegistryInitialized;
  const nextInit = next.generationRegistryInitialized;
  if (priorInit !== undefined && (nextInit === undefined || !sameRecord(priorInit, nextInit))) {
    fail("generationRegistryInitialized is immutable once written");
  }
  if (priorInit === undefined && nextInit !== undefined && nextInit.sourceLedgerRevision !== next.revision) {
    fail(`generationRegistryInitialized.sourceLedgerRevision must be the enclosing ledger revision ${next.revision}`);
  }
  if (current.configCutover !== undefined && next.configCutover === undefined) {
    fail("configCutover cannot be removed once written");
  }
  if (next.configCutover !== undefined
    && (current.configCutover === undefined || !sameRecord(current.configCutover, next.configCutover))
    && next.configCutover.sourceLedgerRevision !== next.revision) {
    fail(`configCutover.sourceLedgerRevision must be the enclosing ledger revision ${next.revision}`);
  }
  if (current.legacyMigration !== undefined) {
    if (next.legacyMigration === undefined) fail("legacyMigration cannot be removed once written");
    if (next.legacyMigration.baselineCount !== current.legacyMigration.baselineCount
      || next.legacyMigration.baselineHash !== current.legacyMigration.baselineHash) {
      fail("legacyMigration baseline is immutable once recorded");
    }
  }
};

const readStateFile = (path, targets) => {
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
    // Never repaired or replaced: a half-written or hand-edited ledger is an operator problem,
    // and overwriting it would destroy the only record of what was already decided.
    throw new Error(`${path} is not valid reconciliation state JSON`, { cause: error });
  }
  return validateState(migrateReconciliationState(parsed), targets);
};

// A private lock directory is `.model-reconciliation.lock.<pid>.<uuid>` and so also starts with
// TEMP_PREFIX -- the `.tmp` suffix is what keeps it out of this sweep.
const clearTemps = (root, onWarning) => {
  for (const name of readdirSync(root)) {
    if (name.startsWith(TEMP_PREFIX) && name.endsWith(".tmp")) {
      // force:true already absorbs a missing file, so any surviving error means an orphaned
      // temp is accumulating under the state root -- an operator signal, never silence.
      try {
        rmSync(join(root, name), { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          onWarning(`unable to remove stale reconciliation temp ${join(root, name)}: ${error?.message ?? error}`);
        }
      }
    }
  }
};

// Built complete and private, so the directory that becomes the lock already carries the identity
// of its holder at the instant it becomes visible.
const buildPrivateLock = (root, identity, instanceName, chmodLockDir, onWarning) => {
  const dir = join(root, `${PRIVATE_LOCK_PREFIX}${identity.pid}.${identity.uuid}`);
  // Not recursive and not forgiving: the name carries a fresh uuid, so an existing directory here
  // is a collision that must not be written into -- and, being somebody else's, must not be
  // cleaned up either. That is exactly why the mkdir sits OUTSIDE the cleanup below.
  mkdirSync(dir, { mode: 0o700 });
  try {
    // `mode` is masked by the umask on creation; the identity inside must not be world-readable.
    chmodLockDir(dir, 0o700);
    const record = JSON.stringify(identity) + "\n";
    writeFileSync(join(dir, OWNER_NAME), record, { mode: 0o600 });
    writeFileSync(join(dir, instanceName), record, { mode: 0o600 });
  } catch (error) {
    // The directory exists and nothing has published it, so this process is the only thing that
    // knows it is there. Leaving it orphans it FOREVER: the sweep deletes a private directory
    // only on proof the identity inside is dead, and a half-built one has no readable identity
    // at all -- the one case the sweep correctly refuses to touch.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Named, never substituted. The construction failure is what the caller must act on; the
      // orphan that survived is what an operator has to go and delete by hand.
      onWarning(`unable to remove the partially built reconciliation lock directory ${dir}: ${cleanupError?.message ?? cleanupError}`);
    }
    throw error;
  }
  return dir;
};

// Removes only the exact name a dead identity published. false means it was already gone, which
// can only mean another actor reclaimed this lock first: whatever is at lockPath now belongs to
// somebody else and nothing further may be touched.
const unlinkDeadInstance = (lockPath, instanceName) => {
  try { unlinkSync(join(lockPath, instanceName)); return true; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

// Only removes the owner record while its bytes are still the ones whose identity was proved dead.
// Different bytes mean a replacement published here in the meantime, and a replacement is live.
const unlinkDeadOwner = (lockPath, ownerText) => {
  try {
    if (readFileSync(join(lockPath, OWNER_NAME), "utf8") !== ownerText) return false;
  } catch { return false; }
  try { unlinkSync(join(lockPath, OWNER_NAME)); return true; }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

// Everything acquire needs to know about the directory currently at lockPath. Reading is never
// destructive; the verdict is what licenses the one unlink that follows.
const inspectLock = (lockPath) => {
  let entries;
  try { entries = readdirSync(lockPath); }
  catch (error) {
    // Gone between the failed rename and this read: decide nothing, try the rename again.
    if (error?.code === "ENOENT") return { verdict: "retry" };
    throw error;
  }
  const instances = entries.filter((name) => name.startsWith(INSTANCE_PREFIX));
  const record = readOwnerRecord(lockPath);
  // A directory with contents but no readable identity fails closed. An identity that cannot be
  // read is never an identity that may be deleted.
  if (record === null) return { verdict: entries.length > 0 ? "live" : "retry" };
  if (identityState(record.owner) !== "missing") return { verdict: "live" };
  const uuid = typeof record.owner.uuid === "string" && record.owner.uuid.length > 0 ? record.owner.uuid : null;
  const instanceName = uuid === null ? null : `${INSTANCE_PREFIX}${record.owner.pid}.${uuid}`;
  if (instanceName !== null && instances.includes(instanceName)) {
    return { verdict: "reclaim", instanceName, ownerText: record.text };
  }
  // The identity proved dead has no instance here, but somebody else's does. That other identity
  // is the one that can be holding this lock, so this observation is stale: touch nothing.
  if (instances.length > 0) return { verdict: "live" };
  // An owner record with no instance beside it -- a legacy lock, or a writer killed between
  // unlinking its instance and unlinking its owner. Nothing can ever publish over it, so leaving
  // it in place would wedge the ledger permanently.
  return { verdict: "clear", ownerText: record.text };
};

const sweepPrivateLocks = (root, onWarning) => {
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PRIVATE_LOCK_PREFIX)) continue;
    const dir = join(root, name);
    const record = readOwnerRecord(dir);
    // No proof of death, no deletion: a live contender still retrying its rename, an unreadable
    // identity and a directory with no record at all all keep everything they have.
    if (record === null || identityState(record.owner) !== "missing") continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        onWarning(`unable to remove the stale reconciliation lock directory ${dir}: ${error?.message ?? error}`);
      }
    }
  }
};

const makeRelease = (lockPath, instanceName, onWarning) => () => {
  // This writer's instance file is its proof that the directory at lockPath is still ITS lock.
  // If it is gone the lock was reclaimed underneath us, and everything there now belongs to
  // another writer: the owner record and the directory are not ours to remove.
  try {
    unlinkSync(join(lockPath, instanceName));
  } catch (error) {
    if (error?.code === "ENOENT") {
      onWarning(`the model reconciliation lock ${lockPath} no longer holds this writer's instance ${instanceName}: it was reclaimed while the ledger was being written, so the lock was not exclusive`);
    } else {
      onWarning(`unable to release the model reconciliation lock instance ${join(lockPath, instanceName)}: ${error?.message ?? error}`);
    }
    return;
  }
  try {
    unlinkSync(join(lockPath, OWNER_NAME));
  } catch (error) {
    // Expected only when a reclaimer that proved this writer dead removed it first.
    if (error?.code !== "ENOENT") {
      onWarning(`unable to remove the model reconciliation lock owner record ${join(lockPath, OWNER_NAME)}: ${error?.message ?? error}`);
    }
  }
  try {
    // rmdir, never a recursive delete: anything left in there belongs to another writer, and an
    // empty directory is takeable by the next rename anyway.
    rmdirSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") {
      onWarning(`unable to remove the model reconciliation lock directory ${lockPath}: ${error?.message ?? error}`);
    }
  }
};

const acquire = (root, lockPath, lockWaitMs, pid, onWarning, chmodLockDir) => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Explicit: `mode` is masked by the umask on creation, and the root may predate this module
  // with looser permissions. The ledger is only as private as the directory holding it.
  chmodSync(root, 0o700);
  const identity = buildIdentity(pid);
  const instanceName = `${INSTANCE_PREFIX}${identity.pid}.${identity.uuid}`;
  const privateDir = buildPrivateLock(root, identity, instanceName, chmodLockDir, onWarning);
  const deadline = Date.now() + lockWaitMs;
  let published = false;
  try {
    while (!published) {
      try {
        // The publication. A rename onto a populated directory fails ENOTEMPTY and moves
        // nothing, so this either wins the lock whole -- identity already inside it -- or leaves
        // both directories exactly as they were.
        renameSync(privateDir, lockPath);
        published = true;
        break;
      } catch (error) {
        if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
      }
      const seen = inspectLock(lockPath);
      // Only a successful unlink counts as progress, and progress is bounded by the number of
      // entries in the lock directory -- so the immediate retry below cannot spin.
      let progressed = false;
      if (seen.verdict === "reclaim") {
        if (unlinkDeadInstance(lockPath, seen.instanceName)) {
          unlinkDeadOwner(lockPath, seen.ownerText);
          progressed = true;
        }
      } else if (seen.verdict === "clear") {
        progressed = unlinkDeadOwner(lockPath, seen.ownerText);
      }
      if (progressed) continue;
      if (Date.now() >= deadline) throw new Error("model reconciliation lock timed out");
      sleep(POLL_MS);
    }
  } finally {
    // Whatever happened, this process's private directory is its own to clean up -- and only
    // ever this exact path, never lockPath.
    if (!published) rmSync(privateDir, { recursive: true, force: true });
  }
  const release = makeRelease(lockPath, instanceName, onWarning);
  // Housekeeping runs INSIDE the lock and may never fail a mutation: a sweep that cannot finish
  // is an operator warning, not a lost decision. Every ledger writer holds this lock, so a
  // leftover ledger temp is from a completed or crashed writer, never an active concurrent write.
  try {
    sweepPrivateLocks(root, onWarning);
    clearTemps(root, onWarning);
  } catch (error) {
    onWarning(`unable to sweep stale reconciliation lock state under ${root}: ${error?.message ?? error}`);
  }
  return release;
};

const writeStateFile = (root, path, value, pid, onWarning, fsyncDir) => {
  const temp = join(root, `${TEMP_PREFIX}${pid}.${randomUUID()}.tmp`);
  let committed = false;
  let fd;
  try {
    // "wx" fails rather than truncating, so a temp name collision can never clobber another
    // writer's bytes; the mode is set at creation, before any content exists in the file.
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 1) + "\n");
    // The mode is enforced here, on the still-private temp and BEFORE the commit: an unusual
    // umask cannot leave the ledger group-readable even for an instant, and there is no
    // permission call left after the rename that could fail once the mutation already happened.
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, path);
    committed = true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Only while the mutation can still be reported as failed. After the rename the temp name is
    // gone anyway, and any error from here on must not mask a committed write.
    if (!committed) { try { unlinkSync(temp); } catch {} }
  }
  // Past the commit point. The rename IS the mutation; this fsync only makes the directory entry
  // durable across a crash. Reporting a failure here as a failed mutation would tell the caller a
  // decision it can see on disk never happened -- so it is a warning and the write stands.
  try {
    fsyncDir(root);
  } catch (error) {
    onWarning(`the model reconciliation ledger ${path} was committed but its directory entry could not be made durable: ${error?.message ?? error}`);
  }
};

// `onWarning` receives every recoverable problem: orphaned lock state, a commit whose directory
// entry could not be made durable, a lock reclaimed under a live writer. It is wrapped here, once,
// so that no warning path inside this module can throw whatever sink a caller injects.
// `fsyncDir` is the injection point for the post-commit durability barrier, and exists so that
// failure -- the one error that must NOT be reported as a failed mutation -- can be exercised
// against a real committed file. `chmodLockDir` is the same kind of point for the permission
// tightening of a freshly created private lock directory: the step between the mkdir and the
// publishing rename that a real filesystem can refuse, and whose cleanup has to be exercised.
// `configTargets` fixes the two exact outer-link targets configCutover may name. The generated
// target defaults to <root>/resolver-generations/current/opencode.json (the Package 3 generations
// root is a direct child of the routing state root); the raw target defaults to the canonical
// devbox raw base, overridable by OPENCODE_RECONCILE_RAW_BASE for fixture trees. Every process
// reading one ledger must agree on both, or its reads fail closed.
export const createReconciliationStore = ({ root = routingStateDir(), now = Date.now, pid = process.pid, lockWaitMs = DEFAULT_LOCK_WAIT_MS, onWarning = defaultOnWarning, fsyncDir = fsyncDirectory, chmodLockDir = chmodSync, configTargets = {} } = {}) => {
  const warn = nonThrowingWarning(onWarning);
  const statePath = join(root, STATE_NAME);
  const lockPath = join(root, LOCK_NAME);
  const targets = Object.freeze({
    generated: configTargets.generated ?? join(root, "resolver-generations", "current", "opencode.json"),
    rawEmergency: configTargets.rawEmergency ?? (process.env.OPENCODE_RECONCILE_RAW_BASE || DEFAULT_RAW_BASE_PATH),
  });
  for (const [name, target] of Object.entries(targets)) {
    if (typeof target !== "string" || !isAbsolute(target)) fail(`config target ${name} must be an absolute path`);
  }
  const paths = () => ({ state: statePath, lock: lockPath, reviewed: join(root, REVIEWED_NAME) });
  // An absent ledger is a legitimate state, not an error: nothing has been reconciled yet.
  // Callers that must distinguish "absent" from "empty" stat paths().state themselves.
  const read = () => readStateFile(statePath, targets) ?? emptyReconciliationState();
  const update = (mutator) => {
    if (typeof mutator !== "function") throw new Error("reconciliation state update needs a mutator function");
    const release = acquire(root, lockPath, lockWaitMs, pid, warn, chmodLockDir);
    try {
      const current = readStateFile(statePath, targets) ?? emptyReconciliationState();
      const revision = current.revision + 1;
      // The mutator gets a detached copy, so an in-place edit it then discards cannot reach
      // the file: what is written is exactly what it returns. It also gets the revision this
      // write will carry, so a record that must cite its enclosing mutation can do so.
      const proposed = mutator(structuredClone(current), { revision });
      if (!isPlainObject(proposed)) throw new Error("reconciliation state update must return the next state object");
      const next = validateState(dropAbsentRecords({
        ...proposed, version: RECONCILIATION_STATE_VERSION, updatedAt: now(), revision,
      }), targets);
      validateTransition(current, next);
      writeStateFile(root, statePath, next, pid, warn, fsyncDir);
      return structuredClone(next);
    } finally {
      release();
    }
  };
  return { read, update, paths, configTargets: () => ({ ...targets }) };
};

// The legacy seen-notification ledger opencode-broker-watch maintains. Package 1 only READS
// it: deletion and the one-time import happen in a later package, so a malformed file throws
// with the bytes untouched rather than being rewritten into a shape this module prefers.
export const readReviewedModels = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({});
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid reviewed-models JSON`, { cause: error });
  }
  if (!isPlainObject(parsed)) throw new Error(`${path} is not a reviewed-models object`);
  // Entry-level junk is dropped, not fatal: a single unparseable key says nothing about the
  // rest, and the import preview is advisory. A corrupt FILE is the loud case above.
  const entries = Object.entries(parsed)
    .filter(([key, seenAt]) => REVIEWED_KEY.test(key) && typeof seenAt === "string")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.freeze(Object.fromEntries(entries));
};

const ledgerModelKeys = (state) => {
  const keys = new Set();
  for (const record of [...Object.values(state?.roles ?? {}), ...Object.values(state?.unknown ?? {})]) {
    const providerID = record?.providerID;
    // Role records name their candidate; unknown-model records name the model directly.
    const modelID = record?.modelID ?? record?.candidateModelID;
    if (typeof providerID === "string" && typeof modelID === "string") keys.add(`${providerID}/${modelID}`);
  }
  return keys;
};

// A PREVIEW only. It reports which legacy seen keys a future import would add and which the
// ledger already covers; it writes nothing and mutates neither argument.
export const planReviewedModelsImport = (state, reviewed) => {
  const known = ledgerModelKeys(state);
  const keys = Object.keys(reviewed ?? {}).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return Object.freeze({
    importKeys: Object.freeze(keys.filter((key) => !known.has(key))),
    existingKeys: Object.freeze(keys.filter((key) => known.has(key))),
  });
};
