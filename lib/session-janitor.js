// The session janitor: retires the child sessions that delegation leaves behind.
//
// Every native `task` call creates a child session, and nothing deletes it: a week of
// delegation leaves hundreds of dead children, and the one worth inspecting is buried in them.
// Deleting one is the easy part. Knowing WHEN it may be deleted is the whole problem, because
// every cheap signal for it is a statement about the wrong half of the system:
//
//   - the result text arriving is not the agent loop stopping: the client's wait on a prompt
//     and the server's loop are different things, and a provider retry can land after the
//     result was delivered. Delete in that window and the loop's next write fails against a
//     session that no longer exists, surfacing later as an unexplained foreign-key error;
//   - a dead owner does not prove the child stopped: the child runs server-side and its loop
//     can outlive the process that created it. Once the owner is gone, its exit does serve as
//     the idle barrier -- but a barrier is not a permission, and the terminal task part is
//     still required before anything is deleted;
//   - a wall-clock deadline cannot tell "wedged" from "thinking hard", and usually fires on
//     the wrong side (the client stops waiting while the server loop carries on).
//
// So retirement is always the same sequence: read the child and confirm its server-side
// parentID, abort, prove the loop cannot write (an idle barrier; see createIdleBarrier), read
// the parent again, delete, and read back an explicit 404. Ownership is learned only from the
// parent's persisted task-part metadata after a server read confirms the child's parentID --
// never from a session-created or idle event, and never from an after-hook payload.
//
// Records live in a durable cross-process registry (one JSON file per child, mkdir-locked,
// atomically renamed, capacity-bounded), so interrupted work is recovered at the next startup
// instead of leaking, and a three-minute retirement claim keeps two plugin processes from
// reaching abort/delete on the same child.
//
// A plugin that creates child sessions ITSELF can use the same machinery: reserve() before
// session.create (source "workflow"), bindReservation() with the returned id, register(),
// and retire() when done. A crash between create and bind is recovered at startup by matching
// the reservation marker embedded in the child's title.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// OPENCODE_SESSION_JANITOR_DIR moves it; pointing it at another janitor's registry (for
// example opencode-agent-workflows', which carries the same protocol) makes the two cooperate
// through the shared records and retirement claims instead of racing.
const REGISTRY_DIR = process.env.OPENCODE_SESSION_JANITOR_DIR ||
  join(homedir(), ".local/share/opencode/session-janitor/children");
const CAPACITY = 1024;
const VERSION = 1;
const MAX_ATTEMPTS = 8;
const ID = /^ses_[A-Za-z0-9]+$/;
const LOCK_WAIT_MS = 10_000;
const IDLE_TIMEOUT_MS = 60_000;
const RETIRE_LEASE_MS = 3 * 60_000;
const MAX_INTENTS = 1024;

const errorText = (error) => String(error?.message ?? error).slice(0, 240);
const recordPath = (root, sessionID) => join(root, `${sessionID}.json`);
const reservationPath = (root, reservationID) => join(root, `reservation-${reservationID}.json`);
const intentPath = (root, sessionID, parentSessionID) => join(root, `intent-${sessionID}-${parentSessionID}.json`);
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

const readJSON = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { return null; }
};

const readRecord = (root, sessionID) => {
  if (!ID.test(sessionID)) return null;
  const record = readJSON(recordPath(root, sessionID));
  return record?.version === VERSION && record.sessionID === sessionID && !record.reservation && ID.test(record.parentSessionID)
    ? record
    : null;
};

const validRecord = (record) =>
  record && ID.test(record.sessionID) && ID.test(record.parentSessionID) &&
  !record.reservation &&
  (record.source === "native-task" || record.source === "workflow") &&
  (record.mode === "foreground" || record.mode === "background");

const validReservation = (record) =>
  record?.version === VERSION && record.reservation === true && typeof record.reservationID === "string" &&
  ID.test(record.parentSessionID) && record.source === "workflow" && record.mode === "foreground" &&
  ["reserved", "bound", "quarantined"].includes(record.reservationState) &&
  Number.isInteger(record.ownerPID) && record.ownerPID > 0 &&
  (record.marker === undefined || (typeof record.marker === "string" && record.marker.length > 0)) &&
  (record.sessionID === undefined || ID.test(record.sessionID));

const validIntent = (record) =>
  record?.version === VERSION && record.intent === true && ID.test(record.sessionID) && ID.test(record.parentSessionID);

const clearTemps = (root) => {
  try { for (const name of readdirSync(root)) if (name.endsWith(".tmp")) rmSync(join(root, name), { force: true }); } catch {}
};

const processState = (pid) => {
  try { process.kill(pid, 0); return "live"; }
  catch (error) { return error?.code === "ESRCH" ? "missing" : "unknown"; }
};
const ownerState = (ownerPID) => Number.isInteger(ownerPID) && ownerPID > 0 ? processState(ownerPID) : "unknown";

// mkdir is atomic across plugin processes. A dead owner is reclaimed, but a
// live or unverifiable owner is never stolen.
const lock = (root) => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "owner"), `${process.pid}\n`, { mode: 0o600 });
      // Every registry writer holds this lock, so a leftover temp is from a
      // completed or crashed writer, never an active concurrent write.
      clearTemps(root);
      return () => { try { rmSync(path, { recursive: true, force: true }); } catch {} };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const pid = Number(readFileSync(join(path, "owner"), "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) {
          stale = processState(pid) === "missing";
        } else {
          stale = Date.now() - statSync(path).mtimeMs > LOCK_WAIT_MS;
        }
      } catch { stale = false; }
      if (stale) { try { rmSync(path, { recursive: true, force: true }); } catch {} }
      else if (Date.now() >= deadline) throw new Error("managed child registry lock timed out");
      else sleep(5);
    }
  }
};

const writeAtomic = (root, record) => {
  const target = record.path ?? recordPath(root, record.sessionID);
  const stem = record.sessionID ?? record.reservationID ?? "record";
  const temp = join(root, `.${stem}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    const { path: _path, ...stored } = record;
    writeFileSync(fd, JSON.stringify(stored) + "\n");
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, target);
    fsyncDirectory(root);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch {}
  }
};

export const createChildRegistry = ({ root = REGISTRY_DIR, now = Date.now } = {}) => {
  const jsonNames = () => readdirSync(root).filter((name) => name.endsWith(".json"));
  const reservationEntry = (reservationID) => jsonNames()
    .map((name) => ({ path: join(root, name), record: readJSON(join(root, name)) }))
    .find((entry) => validReservation(entry.record) && entry.record.reservationID === reservationID) ?? null;
  const recordCount = () => jsonNames().map((name) => readJSON(join(root, name)))
    .filter((record) => validRecord(record) || validReservation(record)).length;
  const list = ({ quarantined = false } = {}) => {
    let release;
    try {
      release = lock(root);
      return jsonNames()
        .filter((name) => /^ses_[A-Za-z0-9]+\.json$/.test(name))
        .map((name) => readRecord(root, name.slice(0, -5)))
        .filter((record) => validRecord(record) && (quarantined || !record.quarantinedAt));
    } catch { return []; } finally { release?.(); }
  };
  const read = (sessionID) => readRecord(root, sessionID);
  const listReservations = ({ quarantined = false } = {}) => {
    let release;
    try {
      release = lock(root);
      return jsonNames().map((name) => readJSON(join(root, name)))
        .filter((record) => validReservation(record) && (quarantined || record.reservationState !== "quarantined"));
    } catch { return []; } finally { release?.(); }
  };
  const update = (sessionID, change) => {
    const release = lock(root);
    try {
      const previous = readRecord(root, sessionID);
      if (!previous) return null;
      const next = { ...previous, ...change, updatedAt: now() };
      writeAtomic(root, next);
      return next;
    } finally { release(); }
  };
  const register = ({ sessionID, parentSessionID, source, mode, directory, reservationID, ownershipVerified, lastError: registrationError }) => {
    if (!ID.test(sessionID) || !ID.test(parentSessionID) || !["native-task", "workflow"].includes(source) || !["foreground", "background"].includes(mode)) {
      throw new Error("managed child registration needs valid ownership metadata");
    }
    const release = lock(root);
    try {
      const existing = readRecord(root, sessionID);
      if (existing) {
        if (existing.parentSessionID === parentSessionID && existing.source === source && existing.mode === mode) return existing;
        return updateUnlocked(existing, { quarantinedAt: now(), lastError: "conflicting child ownership metadata" });
      }
      let reservation = null;
      if (reservationID) {
        reservation = reservationEntry(reservationID);
        if (!reservation || reservation.record.reservationState !== "bound" || reservation.record.sessionID !== sessionID ||
          reservation.record.parentSessionID !== parentSessionID || reservation.record.source !== source || reservation.record.mode !== mode) {
          throw new Error("managed child reservation does not match created session");
        }
      } else if (recordCount() >= CAPACITY) {
        throw new Error(`managed child registry is full (${CAPACITY})`);
      }
      const timestamp = now();
      const record = {
        version: VERSION, sessionID, parentSessionID, source, mode,
        ownerPID: reservation?.record.ownerPID ?? process.pid,
        ...(directory ? { directory } : {}),
        createdAt: timestamp, updatedAt: timestamp, attempts: 0, lastError: registrationError ?? null,
        // Written only when false, so a normally-verified record keeps its exact prior shape.
        ...(ownershipVerified === false ? { ownershipVerified: false } : {}),
      };
      // A bound reservation already owns its one capacity slot and its file.
      writeAtomic(root, { ...record, ...(reservation ? { path: reservation.path } : {}) });
      return record;
    } finally { release(); }
  };
  const updateUnlocked = (record, change) => {
    const next = { ...record, ...change, updatedAt: now() };
    writeAtomic(root, next);
    return next;
  };
  // A record that has failed MAX_ATTEMPTS times is quarantined rather than retried
  // forever. Without this, a record whose proof can never be obtained -- parent gone,
  // child unreadable but not an explicit 404 -- pins attempts at the cap and is handed
  // back by list() on every single sweep. Measured: 26 such records, all at 8 attempts,
  // surviving every reconcile since they were stranded. failIntent already ends this way;
  // child records were the one path that retried without end.
  const fail = (sessionID, error) => {
    const release = lock(root);
    try {
      const record = readRecord(root, sessionID);
      if (!record) return null;
      const attempts = Math.min(MAX_ATTEMPTS, Number(record.attempts ?? 0) + 1);
      return updateUnlocked(record, {
        attempts, lastError: String(error).slice(0, 240),
        ...(attempts >= MAX_ATTEMPTS ? { quarantinedAt: now() } : {}),
      });
    } finally { release(); }
  };
  const quarantine = (sessionID, error) => {
    const release = lock(root);
    try {
      const record = readRecord(root, sessionID);
      return record ? updateUnlocked(record, { quarantinedAt: now(), lastError: String(error).slice(0, 240) }) : null;
    } finally { release(); }
  };
  const remove = (sessionID) => {
    if (!ID.test(sessionID)) return false;
    const release = lock(root);
    try {
      const record = readRecord(root, sessionID);
      if (!record || record.sessionID !== sessionID) return false;
      rmSync(recordPath(root, sessionID), { force: true });
      fsyncDirectory(root);
      return true;
    } finally { release(); }
  };
  const reserve = ({ parentSessionID, source, mode, directory }) => {
    if (!ID.test(parentSessionID) || source !== "workflow" || mode !== "foreground") {
      throw new Error("managed child reservation needs valid workflow ownership metadata");
    }
    const release = lock(root);
    try {
      if (recordCount() >= CAPACITY) throw new Error(`managed child registry is full (${CAPACITY})`);
      const timestamp = now();
      const reservationID = randomUUID();
      const record = {
        version: VERSION, reservation: true, reservationID, marker: `[workflow-reservation:${reservationID}]`, reservationState: "reserved", ownerPID: process.pid,
        parentSessionID, source, mode, ...(directory ? { directory } : {}),
        createdAt: timestamp, updatedAt: timestamp, attempts: 0, lastError: null,
      };
      writeAtomic(root, { ...record, path: reservationPath(root, record.reservationID) });
      return record;
    } finally { release(); }
  };
  const bindReservation = (reservationID, sessionID) => {
    if (!ID.test(sessionID)) throw new Error("created workflow child has an invalid session id");
    const release = lock(root);
    try {
      const entry = reservationEntry(reservationID);
      if (!entry || entry.record.reservationState !== "reserved") throw new Error("managed child reservation is unavailable");
      if (readRecord(root, sessionID) || (entry.path !== recordPath(root, sessionID) && readJSON(recordPath(root, sessionID)))) {
        const next = { ...entry.record, reservationState: "quarantined", quarantinedAt: now(), lastError: "created child id conflicts with an existing registry entry" };
        writeAtomic(root, { ...next, path: entry.path });
        throw new Error("created child id conflicts with an existing registry entry");
      }
      const next = { ...entry.record, sessionID, reservationState: "bound", updatedAt: now() };
      writeAtomic(root, { ...next, path: recordPath(root, sessionID) });
      if (entry.path !== recordPath(root, sessionID)) {
        rmSync(entry.path, { force: true });
        fsyncDirectory(root);
      }
      return next;
    } finally { release(); }
  };
  const releaseReservation = (reservationID) => {
    const release = lock(root);
    try {
      const entry = reservationEntry(reservationID);
      if (!entry) return false;
      rmSync(entry.path, { force: true });
      fsyncDirectory(root);
      return true;
    } finally { release(); }
  };
  const updateReservation = (reservationID, change) => {
    const release = lock(root);
    try {
      const entry = reservationEntry(reservationID);
      if (!entry) return null;
      const next = { ...entry.record, ...change, updatedAt: now() };
      writeAtomic(root, { ...next, path: entry.path });
      return next;
    } finally { release(); }
  };
  const failReservation = (reservationID, error) => {
    const release = lock(root);
    try {
      const entry = reservationEntry(reservationID);
      if (!entry) return null;
      const attempts = Math.min(MAX_ATTEMPTS, Number(entry.record.attempts ?? 0) + 1);
      const next = {
        ...entry.record, attempts, lastError: String(error).slice(0, 240), updatedAt: now(),
      };
      writeAtomic(root, { ...next, path: entry.path });
      return next;
    } finally { release(); }
  };
  const quarantineReservation = (reservationID, error) => updateReservation(reservationID, {
    reservationState: "quarantined", quarantinedAt: now(), lastError: String(error).slice(0, 240),
  });
  const claimRetirement = (sessionID, claimant, leaseMs = RETIRE_LEASE_MS) => {
    const release = lock(root);
    try {
      const record = readRecord(root, sessionID);
      if (!record || record.quarantinedAt) return null;
      const claim = record.retirement;
      if (claim?.claimant !== claimant && Number(claim?.leaseUntil) > now()) return null;
      return updateUnlocked(record, { retirement: { claimant, leaseUntil: now() + leaseMs } });
    } finally { release(); }
  };
  const claimed = (record, claimant) => record?.retirement?.claimant === claimant && Number(record.retirement.leaseUntil) > now();
  const removeClaimed = (sessionID, claimant) => {
    const release = lock(root);
    try {
      const record = readRecord(root, sessionID);
      if (!claimed(record, claimant)) return false;
      rmSync(recordPath(root, sessionID), { force: true }); fsyncDirectory(root); return true;
    } finally { release(); }
  };
  // Same cap as fail(). This is the path retire() takes, and it was the one left
  // without the quarantine: 130 records sat at attempts 8, un-quarantined, and were
  // retried on every startup (2026-09-21).
  const failClaimed = (sessionID, error, claimant) => {
    const release = lock(root);
    try {
      const record = readRecord(root, sessionID);
      if (!claimed(record, claimant)) return null;
      const attempts = Math.min(MAX_ATTEMPTS, Number(record.attempts ?? 0) + 1);
      return updateUnlocked(record, {
        attempts, lastError: String(error).slice(0, 240), retirement: undefined,
        ...(attempts >= MAX_ATTEMPTS ? { quarantinedAt: now() } : {}),
      });
    } finally { release(); }
  };
  const quarantineClaimed = (sessionID, error, claimant) => {
    const release = lock(root);
    try {
      const record = readRecord(root, sessionID);
      return claimed(record, claimant) ? updateUnlocked(record, {
        quarantinedAt: now(), lastError: String(error).slice(0, 240), retirement: undefined,
      }) : null;
    } finally { release(); }
  };
  const recordIntent = ({ sessionID, parentSessionID, directory }) => {
    if (!ID.test(sessionID) || !ID.test(parentSessionID)) throw new Error("terminal intent needs valid task ids");
    const release = lock(root);
    try {
      const path = intentPath(root, sessionID, parentSessionID);
      const existing = readJSON(path);
      if (validIntent(existing)) return existing;
      const count = jsonNames().map((name) => readJSON(join(root, name))).filter(validIntent).length;
      if (count >= MAX_INTENTS) throw new Error(`managed terminal intent registry is full (${MAX_INTENTS})`);
      const timestamp = now();
      const intent = { version: VERSION, intent: true, sessionID, parentSessionID, ...(directory ? { directory } : {}), createdAt: timestamp, updatedAt: timestamp, attempts: 0, lastError: null };
      writeAtomic(root, { ...intent, path });
      return intent;
    } finally { release(); }
  };
  const listIntents = ({ quarantined = false } = {}) => {
    let release;
    try {
      release = lock(root);
      return jsonNames().map((name) => readJSON(join(root, name)))
        .filter((intent) => validIntent(intent) && (quarantined || !intent.quarantinedAt));
    } catch { return []; } finally { release?.(); }
  };
  const consumeIntent = (sessionID, parentSessionID) => {
    const release = lock(root);
    try {
      const path = intentPath(root, sessionID, parentSessionID);
      if (!validIntent(readJSON(path))) return false;
      rmSync(path, { force: true }); fsyncDirectory(root); return true;
    } finally { release(); }
  };
  const failIntent = (intent, error) => {
    const release = lock(root);
    try {
      const path = intentPath(root, intent.sessionID, intent.parentSessionID);
      const current = readJSON(path);
      if (!validIntent(current)) return null;
      const attempts = Math.min(MAX_ATTEMPTS, Number(current.attempts ?? 0) + 1);
      const next = { ...current, attempts, lastError: String(error).slice(0, 240), updatedAt: now(), ...(attempts >= MAX_ATTEMPTS ? { quarantinedAt: now() } : {}) };
      writeAtomic(root, { ...next, path }); return next;
    } finally { release(); }
  };
  return {
    list, read, register, fail, quarantine, remove,
    reserve, bindReservation, releaseReservation, listReservations, failReservation, quarantineReservation,
    claimRetirement, removeClaimed, failClaimed, quarantineClaimed,
    recordIntent, listIntents, consumeIntent, failIntent,
  };
};

let createV2Client = null;
try {
  ({ createOpencodeClient: createV2Client } = await import(pathToFileURL(
    join(homedir(), ".config/opencode/node_modules/@opencode-ai/sdk/dist/v2/client.js"),
  ).href));
} catch {
  try { ({ createOpencodeClient: createV2Client } = await import("@opencode-ai/sdk/v2/client")); } catch {}
}

// OpenCode 1.18 ships session.wait as a stub that REJECTS IMMEDIATELY rather than
// hanging, so racing it against a timeout loses instantly and every child is left
// unretired. A build without the endpoint is a capability gap, not a busy signal:
// it tells us nothing about the child, so refusing to proceed leaks 100% of them.
// A timeout is the opposite -- it is positive evidence the child is STILL RUNNING,
// and must keep deferring. Only the first case may fall through to the settle.
export const barrierUnavailable = (error) => {
  const text = String(error?.message ?? error ?? "");
  if (/timed out/i.test(text)) return false;
  return /not available|not implemented|unimplemented|is not a function|unknown method|\b(?:404|501)\b/i.test(text);
};

// Bounded grace for writes already in flight when abort landed. This is weaker
// than a real idle barrier and deliberately so: retireSession has already issued
// abort, and it re-verifies the child's server-side parentID immediately before
// AND after the delete, so ownership is never inferred from this wait.
const SETTLE_MS = 1500;

export const createIdleBarrier = ({ client, directory, settleMs = SETTLE_MS }) => {
  let v2 = null;
  return async (sessionID) => {
    if (!v2) {
      if (!createV2Client) throw new Error("@opencode-ai/sdk v2 client unavailable: cannot confirm a child session is idle");
      const config = client?.session?._client?.getConfig?.();
      if (!config?.baseUrl || typeof config.fetch !== "function") throw new Error("opencode embedded transport unavailable");
      const headers = config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers;
      v2 = createV2Client({ baseUrl: config.baseUrl, fetch: config.fetch, headers, directory, throwOnError: true });
    }
    let timer;
    try {
      await Promise.race([
        v2.v2.session.wait({ sessionID }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`idle barrier timed out after ${IDLE_TIMEOUT_MS / 1000}s`)), IDLE_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      if (!barrierUnavailable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    } finally { clearTimeout(timer); }
  };
};

// ☠️ The SDK client a plugin is handed returns `{ error, request, response }`, with the
// HTTP status on `response.status`. The error BODY carries no status at all:
// `{ name: "NotFoundError", data: { message: "Session not found: …" } }` (verified
// against v1.18.22). Without `response.status` an explicit 404 read as "unknown", so a
// child that was already deleted could never be retired: 176 records sat on "could not
// verify child ownership", and every startup re-read them all (2026-09-21).
const statusCode = (value) => [value?.status, value?.statusCode, value?.response?.status, value?.data?.status, value?.data?.statusCode, value?.error?.status, value?.error?.statusCode]
  .find((candidate) => Number.isInteger(candidate));

// `unreadable` marks a read that FAILED (transport or server error), as distinct from a
// read that succeeded and returned a different session. Callers that must not strand an
// untracked child treat those two cases differently. `unknown` stays true for both, so
// existing consumers (retireSession) are unaffected.
const readSession = async (client, sessionID, query) => {
  try {
    const got = await client.session.get({ path: { id: sessionID }, query });
    if (got?.error) return statusCode(got) === 404 ? { missing: true } : { unknown: true, unreadable: true, error: errorText(got.error) };
    const session = got?.data ?? got;
    return session?.id === sessionID ? { session } : { unknown: true };
  } catch (error) { return statusCode(error) === 404 ? { missing: true } : { unknown: true, unreadable: true, error: errorText(error) }; }
};

// This operation never throws: cleanup must not mask a task or workflow result.
export const retireSession = async ({ client, directory, sessionID, parentSessionID, waitIdle }) => {
  const query = directory ? { directory } : {};
  const result = { sessionID, missing: false, owned: false, aborted: false, idle: false, deleted: false, verified: false };
  const initial = await readSession(client, sessionID, query);
  if (initial.missing) return { ...result, missing: true };
  if (initial.unknown) return { ...result, error: "could not verify child ownership" };
  if (initial.session.parentID !== parentSessionID) return { ...result, error: "server parentID does not match registered parent", mismatch: true };
  result.owned = true;
  try { await client.session.abort({ path: { id: sessionID }, query }); result.aborted = true; } catch (error) { result.abortError = errorText(error); }
  try { await waitIdle(sessionID); result.idle = true; } catch (error) {
    const afterWait = await readSession(client, sessionID, query);
    if (afterWait.missing) return { ...result, missing: true };
    return { ...result, error: `idle barrier: ${errorText(error)}` };
  }
  // A second ownership read is required immediately before delete.
  const beforeDelete = await readSession(client, sessionID, query);
  if (beforeDelete.missing) return { ...result, missing: true };
  if (beforeDelete.unknown) return { ...result, error: "could not verify child ownership before delete" };
  if (beforeDelete.session.parentID !== parentSessionID) return { ...result, error: "server parentID changed before delete", mismatch: true };
  try { await client.session.delete({ path: { id: sessionID }, query }); result.deleted = true; } catch (error) { result.deleteError = errorText(error); }
  const afterDelete = await readSession(client, sessionID, query);
  result.verified = afterDelete.missing === true;
  if (!result.verified) result.error = result.deleteError ? `delete: ${result.deleteError}` : afterDelete.session ? "still present after delete" : "could not verify deletion with an explicit 404";
  return result;
};

export const createChildManager = ({ client, directory, waitIdle, registry = createChildRegistry() }) => {
  const barrier = waitIdle ?? createIdleBarrier({ client, directory });
  const retiring = new Map();
  const claimant = `${process.pid}-${randomUUID()}`;
  const register = async ({ sessionID, parentSessionID, source, mode, directory: childDirectory, reservationID }) => {
    const existing = registry.read(sessionID);
    if (existing?.quarantinedAt) return existing;
    const query = childDirectory ? { directory: childDirectory } : directory ? { directory } : {};
    let actual = await readSession(client, sessionID, query);
    // A read that FAILS must not strand an untracked child. Native tasks cannot reserve
    // (reserve() requires source === "workflow"), so throwing here leaves nothing on disk
    // and reconcile can never find the session again. Retry briefly, then register the
    // record UNVERIFIED rather than leak it: retireSession re-reads and matches parentID
    // twice before it deletes anything, so an unverified record cannot cause a wrongful
    // delete. Ceiling: 3 attempts total; a longer outage yields ownershipVerified:false and
    // the record is retired on a later reconcile.
    for (let attempt = 0; actual.unreadable && attempt < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      actual = await readSession(client, sessionID, query);
    }
    if (actual.missing) {
      if (reservationID) registry.releaseReservation(reservationID);
      return null;
    }
    if (actual.unknown && !actual.unreadable) {
      if (reservationID) registry.failReservation(reservationID, "created child id does not match the session read back");
      throw new Error("could not verify child ownership before registration");
    }
    if (!actual.unreadable && actual.session.parentID !== parentSessionID) {
      if (reservationID) registry.quarantineReservation(reservationID, "server parentID does not match ownership metadata");
      else if (existing) registry.quarantine(sessionID, "server parentID does not match ownership metadata");
      return null;
    }
    return registry.register({
      sessionID, parentSessionID, source, mode, directory: childDirectory ?? directory, reservationID,
      ...(actual.unreadable ? { ownershipVerified: false, lastError: `ownership unverified at registration: ${actual.error ?? "session read failed"}` } : {}),
    });
  };
  const reserve = (ownership) => registry.reserve(ownership);
  const bindReservation = (reservationID, sessionID) => registry.bindReservation(reservationID, sessionID);
  const releaseReservation = (reservationID) => registry.releaseReservation(reservationID);
  const retire = (sessionID) => {
    if (retiring.has(sessionID)) return retiring.get(sessionID);
    const task = Promise.resolve().then(async () => {
      const record = registry.claimRetirement(sessionID, claimant);
      if (!record) return null;
      // OpenCode 1.18 exposes session.wait as an unimplemented stub. Once the
      // creating process is gone, process exit itself is the authoritative barrier.
      const ownerExited = ownerState(record.ownerPID) === "missing";
      const result = await retireSession({
        client, directory: record.directory ?? directory, sessionID,
        parentSessionID: record.parentSessionID,
        waitIdle: ownerExited ? async () => {} : barrier,
      });
      if (result.verified || result.missing) registry.removeClaimed(sessionID, claimant);
      else if (result.mismatch) registry.quarantineClaimed(sessionID, result.error, claimant);
      else registry.failClaimed(sessionID, result.error ?? "cleanup did not verify deletion", claimant);
      return result;
    }).finally(() => retiring.delete(sessionID));
    retiring.set(sessionID, task);
    return task;
  };
  const retireForeground = (sessionID, parentSessionID) => {
    const record = registry.read(sessionID);
    return record?.source === "native-task" && record.mode === "foreground" && record.parentSessionID === parentSessionID ? retire(sessionID) : Promise.resolve(null);
  };
  const retireBackground = (sessionID, parentSessionID) => {
    const record = registry.read(sessionID);
    return record?.source === "native-task" && record.mode === "background" && record.parentSessionID === parentSessionID ? retire(sessionID) : Promise.resolve(null);
  };
  const terminalIntent = async ({ sessionID, parentSessionID, directory: childDirectory }) => {
    registry.recordIntent({ sessionID, parentSessionID, directory: childDirectory ?? directory });
    const record = registry.read(sessionID);
    if (record?.source === "native-task" && record.mode === "foreground" && record.parentSessionID === parentSessionID) {
      registry.consumeIntent(sessionID, parentSessionID);
      return retire(sessionID);
    }
    return null;
  };
  const consumeTerminalIntent = (sessionID, parentSessionID) => registry.consumeIntent(sessionID, parentSessionID);
  // ☠️ RECONCILE ONLY THIS INSTANCE'S OWN DIRECTORY. The plugin is instantiated once per
  // opencode instance, i.e. per directory, and every instance used to sweep the WHOLE
  // registry. Each record's calls carry `directory: record.directory`, and the server
  // answers a request for a directory it has not opened by booting a full instance for
  // it, with every plugin loaded. So the first window booted every directory in the
  // registry, and each of those instances swept the whole registry again. Measured
  // 2026-09-21: 200 records over 11 directories, 3-9 GB per window within a minute,
  // the event loop pegged, Esc ignored for a minute, input dead.
  // A record is recovered by the instance of the directory it names, the next time that
  // directory is opened. Until then it just waits on disk, which costs nothing.
  const ownDirectory = directory ? resolve(directory) : undefined;
  const mine = (entry) => !ownDirectory || !entry?.directory || resolve(entry.directory) === ownDirectory;
  const reconcileReservations = async () => {
    for (const reservation of registry.listReservations()) {
      if (!mine(reservation)) continue;
      // Recovery is only for a definitely-dead workflow process. A live or
      // unverifiable owner may still bind or retire this child itself.
      if (ownerState(reservation.ownerPID) !== "missing") continue;
      if (reservation.reservationState === "reserved") {
        if (!reservation.marker) {
          registry.quarantineReservation(reservation.reservationID, "workflow reservation marker is missing");
          continue;
        }
        if (typeof client?.session?.children !== "function") {
          registry.failReservation(reservation.reservationID, "could not list parent children to recover workflow reservation");
          continue;
        }
        let children;
        try {
          const got = await client.session.children({
            path: { id: reservation.parentSessionID },
            query: reservation.directory ? { directory: reservation.directory } : directory ? { directory } : {},
          });
          if (got?.error || !Array.isArray(got?.data ?? got)) throw new Error("SDK session.children did not return a child array");
          children = got.data ?? got;
        } catch (error) {
          registry.failReservation(reservation.reservationID, `could not list parent children to recover workflow reservation: ${errorText(error)}`);
          continue;
        }
        const matches = children.filter((child) => ID.test(child?.id ?? "") && child.parentID === reservation.parentSessionID &&
          typeof child.title === "string" && child.title.includes(reservation.marker));
        if (matches.length === 0) {
          // A successful complete child listing proves this reservation never created a child.
          registry.releaseReservation(reservation.reservationID);
          continue;
        }
        if (matches.length !== 1) {
          registry.quarantineReservation(reservation.reservationID, "parent child listing matched workflow reservation ambiguously");
          continue;
        }
        try {
          registry.bindReservation(reservation.reservationID, matches[0].id);
          const record = await register({ ...reservation, sessionID: matches[0].id, reservationID: reservation.reservationID });
          if (record) await retire(record.sessionID);
        } catch (error) {
          registry.failReservation(reservation.reservationID, `could not bind recovered workflow child: ${errorText(error)}`);
        }
        continue;
      }
      const actual = await readSession(client, reservation.sessionID, reservation.directory ? { directory: reservation.directory } : directory ? { directory } : {});
      if (actual.missing) registry.releaseReservation(reservation.reservationID);
      else if (actual.unknown) registry.failReservation(reservation.reservationID, "could not verify bound reservation ownership during recovery");
      else if (actual.session.parentID !== reservation.parentSessionID) registry.quarantineReservation(reservation.reservationID, "server parentID does not match bound reservation");
      else {
        const record = registry.register({ ...reservation, sessionID: reservation.sessionID, reservationID: reservation.reservationID });
        await retire(record.sessionID);
      }
    }
  };
  const taskParts = (messages) => (Array.isArray(messages) ? messages : [])
    .flatMap((message) => Array.isArray(message?.parts) ? message.parts : Array.isArray(message?.info?.parts) ? message.info.parts : []);
  const terminalForeground = (task) => task?.mode === "foreground" && (task.status === "completed" || task.status === "error");
  const recordQuery = (record) => record.directory ? { directory: record.directory } : directory ? { directory } : {};
  const persistedParts = async (record) => {
    if (typeof client?.session?.messages !== "function") throw new Error("SDK does not expose session.messages");
    const got = await client.session.messages({ path: { id: record.parentSessionID }, query: recordQuery(record) });
    // A deleted parent and a malformed response are different faults: conflating them
    // reports a live SDK as broken and hides the far more common "the tree is gone".
    if (got?.error) throw new Error(statusCode(got) === 404 ? "parent session no longer exists" : "SDK session.messages returned an error");
    if (!Array.isArray(got?.data ?? got)) throw new Error("SDK session.messages did not return message array");
    return taskParts(got.data ?? got);
  };
  const reconcileNative = async () => {
    for (const record of registry.list()) {
      if (record.source !== "native-task" || !mine(record)) continue;
      if (Number.isInteger(record.ownerPID) && ownerState(record.ownerPID) !== "missing") continue;
      // A child that is already gone has nothing left to verify or to delete, and its
      // parent is usually gone with it -- so the parent-message check below can never
      // succeed for this record and it would be retried on every sweep forever.
      // retireSession answers an explicit 404 with { missing: true }, which retire()
      // turns into removeClaimed, so the record clears. Only an explicit 404 counts:
      // an unreachable server reads as "unknown" and is left alone for the next sweep.
      if ((await readSession(client, record.sessionID, recordQuery(record))).missing) {
        await retire(record.sessionID);
        continue;
      }
      // A dead owner does NOT prove the child stopped: the child runs server-side, so
      // its agent loop can outlive the process that created it. The terminal-part gate
      // below is what keeps this from deleting a session mid-write, and it stays.
      // What changed is the exit: a record whose parent can never be read again now
      // quarantines at MAX_ATTEMPTS inside registry.fail instead of being retried on
      // every sweep for the rest of time.
      let parts;
      try { parts = await persistedParts(record); } catch (error) {
        registry.fail(record.sessionID, `could not list persisted parent messages: ${errorText(error)}`);
        continue;
      }
      if (record.mode === "foreground") {
        const terminal = parts.map((part) => nativeTaskState({ type: "message.part.updated", properties: { sessionID: record.parentSessionID, part } }))
          .some((task) => task?.sessionID === record.sessionID && task.parentSessionID === record.parentSessionID && terminalForeground(task));
        if (terminal) await retire(record.sessionID);
      } else {
        const terminal = parts.map((part) => backgroundTaskResult({ type: "message.part.updated", properties: { sessionID: record.parentSessionID, part } }))
          .some((task) => task?.sessionID === record.sessionID && task.parentSessionID === record.parentSessionID);
        if (terminal) await retire(record.sessionID);
      }
    }
  };
  const reconcileIntents = async () => {
    for (const intent of registry.listIntents()) {
      if (!mine(intent)) continue;
      if (typeof client?.session?.messages !== "function") {
        registry.failIntent(intent, "SDK does not expose session.messages; terminal intent cannot verify persisted task-part metadata");
        continue;
      }
      try {
        const parts = await persistedParts(intent);
        const task = parts.map((part) => nativeTaskState({ type: "message.part.updated", properties: { sessionID: intent.parentSessionID, part } }))
          .find((candidate) => candidate?.sessionID === intent.sessionID && candidate.parentSessionID === intent.parentSessionID && terminalForeground(candidate));
        if (!task) {
          registry.failIntent(intent, "persisted parent messages do not contain matching foreground task-part metadata");
          continue;
        }
        const record = await register({ ...task, source: "native-task", directory: intent.directory });
        if (record) {
          registry.consumeIntent(intent.sessionID, intent.parentSessionID);
          await retire(record.sessionID);
        }
      } catch (error) {
        registry.failIntent(intent, `could not list persisted parent messages: ${errorText(error)}`);
      }
    }
  };
  const reconcile = async () => {
    await reconcileReservations();
    for (const record of registry.list()) {
      if (record.source === "workflow" && mine(record) && ownerState(record.ownerPID) === "missing") await retire(record.sessionID);
    }
    await reconcileNative();
    await reconcileIntents();
  };
  const deleted = (sessionID) => registry.read(sessionID)?.sessionID === sessionID && registry.remove(sessionID);
  // The durable record is the cheapest answer for a child this process owns.
  // A child owned by another process, or a root session, is not in here -- the
  // caller falls back to the server and treats null as "not ours to abort".
  const parentOf = (sessionID) => {
    try { return registry.read(sessionID)?.parentSessionID ?? null; } catch { return null; }
  };
  return {
    register, reserve, bindReservation, releaseReservation, retire, retireForeground, retireBackground,
    terminalIntent, consumeTerminalIntent, reconcile, deleted, parentOf, failReservation: registry.failReservation, registry,
  };
};

const taskMetadata = (part) => {
  const metadata = part?.type === "tool" && part.tool === "task" ? part.state?.metadata : null;
  const sessionID = metadata?.sessionId;
  return typeof sessionID === "string" && ID.test(sessionID) ? { sessionID, mode: metadata.background === true ? "background" : "foreground", status: part.state?.status } : null;
};

export const nativeTaskState = (event) => {
  if (event?.type !== "message.part.updated") return null;
  const parentSessionID = event.properties?.sessionID;
  const part = event.properties?.part;
  const task = taskMetadata(part);
  return ID.test(parentSessionID ?? "") && part?.sessionID === parentSessionID && task ? { ...task, parentSessionID } : null;
};

// Native task.ts emits this exact synthetic terminal result after a background
// task settles. Running updates and arbitrary synthetic text are deliberately ignored.
export const backgroundTaskResult = (event) => {
  if (event?.type !== "message.part.updated") return null;
  const parentSessionID = event.properties?.sessionID;
  const part = event.properties?.part;
  if (!ID.test(parentSessionID ?? "") || part?.type !== "text" || part.sessionID !== parentSessionID || part.synthetic !== true) return null;
  const match = /^<task id="(ses_[A-Za-z0-9]+)" state="(completed|error)">\n<summary>[^\n]*<\/summary>\n<(task_result|task_error)>\n([\s\S]*)\n<\/(task_result|task_error)>\n<\/task>$/.exec(part.text);
  if (!match || (match[2] === "completed" ? match[3] !== "task_result" : match[3] !== "task_error") || match[3] !== match[5]) return null;
  return { sessionID: match[1], parentSessionID };
};

export const taskChildFromAfter = (input, output) => {
  const sessionID = output?.metadata?.sessionId;
  return input?.tool === "task" && ID.test(input.sessionID ?? "") && typeof sessionID === "string" && ID.test(sessionID)
    ? { sessionID, parentSessionID: input.sessionID }
    : null;
};
