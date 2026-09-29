// The reconciliation ledger: the ONE file the model reconciler may write, and the exclusive
// lock every mutation of it passes through.
//
// It shares a directory with the broker's other routing state, and that is what shapes most of
// the rules here:
//   - the lock is a mkdir under that root, because mkdir is the only atomic create-exclusive
//     for a directory. Neither rename nor an O_CREAT|O_EXCL file with a timeout can give
//     mutual exclusion across processes without a stealing window;
//   - temp cleanup matches `.model-reconciliation.*.tmp` ONLY. lib/routing.js writes
//     `<name>.<pid>.<ms>.tmp` in the same root, and a broad `*.tmp` sweep would delete a
//     concurrent writer's in-flight temp, losing that write with no error anywhere;
//   - state is read through an explicit top-level whitelist and an exact version. An unknown
//     field or version is a NEWER writer's file: round-tripping it silently would drop the
//     fields this version does not know about, so both fail loudly instead.
//
// A lock owner is reclaimed only on proof it is gone -- `process.kill(pid, 0)` answering
// ESRCH. EPERM, an unreadable pid, or any other error reads as live, because a stolen lock
// means two writers in the same read-modify-write and a lost decision. The single exception is
// a lock directory holding NO owner record, which can only come from a writer killed between
// mkdir and the owner write; that is reclaimed after the full wait, never sooner.
import { closeSync, chmodSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { routingStateDir } from "./routing.js";

export const RECONCILIATION_STATE_VERSION = 1;

const STATE_NAME = "model-reconciliation.json";
const LOCK_NAME = ".model-reconciliation.lock";
const REVIEWED_NAME = "reviewed-models.json";
const TEMP_PREFIX = ".model-reconciliation.";
const DEFAULT_LOCK_WAIT_MS = 5_000;
const POLL_MS = 5;

// The complete set of top-level keys version 1 defines. Anything else is a different schema.
const STATE_FIELDS = Object.freeze(["version", "updatedAt", "roles", "unknown", "evidenceRequests"]);
const MAP_FIELDS = Object.freeze(["roles", "unknown", "evidenceRequests"]);

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

export const emptyReconciliationState = () => ({
  version: RECONCILIATION_STATE_VERSION,
  updatedAt: 0,
  roles: {},
  unknown: {},
  evidenceRequests: {},
});

const validateState = (value) => {
  if (!isPlainObject(value)) throw new Error("reconciliation state is not an object");
  for (const key of Object.keys(value)) {
    if (!STATE_FIELDS.includes(key)) throw new Error(`unknown reconciliation state field ${key}`);
  }
  if (value.version !== RECONCILIATION_STATE_VERSION) {
    throw new Error(`unsupported reconciliation state version ${String(value.version)}`);
  }
  if (!Number.isFinite(value.updatedAt) || value.updatedAt < 0) {
    throw new Error(`reconciliation state has an invalid updatedAt ${String(value.updatedAt)}`);
  }
  for (const field of MAP_FIELDS) {
    if (!isPlainObject(value[field])) throw new Error(`reconciliation state field ${field} is not an object`);
  }
  return value;
};

const readStateFile = (path) => {
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
  return validateState(parsed);
};

const clearTemps = (root) => {
  for (const name of readdirSync(root)) {
    if (name.startsWith(TEMP_PREFIX) && name.endsWith(".tmp")) {
      // force:true already absorbs a missing file, so any surviving error means an orphaned
      // temp is accumulating under the state root -- an operator signal, never silence.
      try {
        rmSync(join(root, name), { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.error(`opencode-broker: unable to remove stale reconciliation temp ${join(root, name)}: ${error?.message ?? error}`);
        }
      }
    }
  }
};

const readOwnerPID = (lockPath) => {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner"), "utf8"));
    return Number.isInteger(owner?.pid) && owner.pid > 0 ? owner.pid : null;
  } catch { return null; }
};

const acquire = (root, lockPath, lockWaitMs, pid) => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Explicit: `mode` is masked by the umask on creation, and the root may predate this module
  // with looser permissions. The ledger is only as private as the directory holding it.
  chmodSync(root, 0o700);
  const deadline = Date.now() + lockWaitMs;
  let reclaimedOwnerless = false;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "owner"), JSON.stringify({ pid, acquiredAt: Date.now() }) + "\n", { mode: 0o600 });
      // Every ledger writer holds this lock, so a leftover ledger temp is from a completed or
      // crashed writer, never an active concurrent write.
      clearTemps(root);
      return () => { try { rmSync(lockPath, { recursive: true, force: true }); } catch {} };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ownerPID = readOwnerPID(lockPath);
      if (ownerPID !== null && processState(ownerPID) === "missing") {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        // No owner record at all after the full wait: the only writer that can produce this
        // died between mkdir and the owner write, microseconds apart. Reclaimed once, so a
        // genuine live owner that reappears wins the next round instead of being robbed again.
        if (ownerPID === null && !reclaimedOwnerless) {
          reclaimedOwnerless = true;
          try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
          continue;
        }
        throw new Error("model reconciliation lock timed out");
      }
      sleep(POLL_MS);
    }
  }
};

const writeStateFile = (root, path, value, pid) => {
  const temp = join(root, `${TEMP_PREFIX}${pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    // "wx" fails rather than truncating, so a temp name collision can never clobber another
    // writer's bytes; the mode is set at creation, before any content exists in the file.
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 1) + "\n");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, path);
    // The rename is only durable once the directory entry is: without this, a crash can leave
    // the ledger missing even though the data was fsynced.
    fsyncDirectory(root);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch {}
  }
};

export const createReconciliationStore = ({ root = routingStateDir(), now = Date.now, pid = process.pid, lockWaitMs = DEFAULT_LOCK_WAIT_MS } = {}) => {
  const statePath = join(root, STATE_NAME);
  const lockPath = join(root, LOCK_NAME);
  const paths = () => ({ state: statePath, lock: lockPath, reviewed: join(root, REVIEWED_NAME) });
  // An absent ledger is a legitimate state, not an error: nothing has been reconciled yet.
  // Callers that must distinguish "absent" from "empty" stat paths().state themselves.
  const read = () => readStateFile(statePath) ?? emptyReconciliationState();
  const update = (mutator) => {
    if (typeof mutator !== "function") throw new Error("reconciliation state update needs a mutator function");
    const release = acquire(root, lockPath, lockWaitMs, pid);
    try {
      const current = readStateFile(statePath) ?? emptyReconciliationState();
      // The mutator gets a detached copy, so an in-place edit it then discards cannot reach
      // the file: what is written is exactly what it returns.
      const proposed = mutator(structuredClone(current));
      if (!isPlainObject(proposed)) throw new Error("reconciliation state update must return the next state object");
      const next = validateState({ ...proposed, version: RECONCILIATION_STATE_VERSION, updatedAt: now() });
      writeStateFile(root, statePath, next, pid);
      // chmod after rename as explicit defense against an unusual umask; openSync already
      // created the temp 0600 and rename preserves the mode.
      chmodSync(statePath, 0o600);
      return structuredClone(next);
    } finally {
      release();
    }
  };
  return { read, update, paths };
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
