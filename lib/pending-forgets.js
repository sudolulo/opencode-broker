import { chmodSync, closeSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const MAX_AGE = 14 * 24 * 60 * 60 * 1000;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const RECORD_NAME = new RegExp(`^v1\\.([a-f0-9]{64})\\.(${UUID})\\.json$`);
const CLAIM_NAME = new RegExp(`^claim\\.${UUID}$`);
const TEMP_NAME = new RegExp(`^\\.v1\\.[a-f0-9]{64}\\.${UUID}\\.json\\.[0-9]+\\.${UUID}\\.tmp$`);
const leaseIsValid = (value) => typeof value === "string" && value.trim().length > 0;
const timestampIsValid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const digest = (sessionID, leaseID) => createHash("sha256").update(JSON.stringify([sessionID, leaseID])).digest("hex");
const warn = (message) => console.warn(`[opencode-broker] pending cleanup: ${message}`);
// Error context intentionally excludes paths and payloads, which can contain lease identities.
const failure = (operation, error) => new Error(`pending cleanup ${operation} failed (${error?.code ?? "filesystem error"})`);
const namesAt = (path) => {
  try { return readdirSync(path); }
  catch (error) { if (error.code === "ENOENT") return []; throw failure("listing", error); }
};
const statAt = (path) => {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw failure("stat", error); }
};
const unlinkOwned = (path) => {
  try { unlinkSync(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw failure("removal", error); }
};
const readJSON = (path) => {
  if (!statAt(path)?.isFile()) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) { warn("invalid record retained unless privately claimed"); return null; }
    throw failure("read", error);
  }
};

export const createPendingForgetStore = ({ directory, validSessionID }) => {
  const ensureDirectory = () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!statAt(directory)?.isDirectory()) throw new Error("pending cleanup directory is not a real directory");
    chmodSync(directory, 0o700);
  };
  const normalize = (value, recordID) => {
    if (!value || !validSessionID(value.sessionID) || !leaseIsValid(value.leaseID) ||
      !timestampIsValid(value.updatedAt) || typeof value.completed !== "boolean") return null;
    return { recordID, sessionID: value.sessionID, leaseID: value.leaseID, completed: value.completed, updatedAt: value.updatedAt };
  };
  const immutable = (name) => {
    const match = RECORD_NAME.exec(name);
    if (!match) return null;
    const value = readJSON(join(directory, name));
    const record = value?.version === 1 ? normalize(value, name) : null;
    return record && digest(record.sessionID, record.leaseID) === match[1] ? record : null;
  };
  const legacy = (path, sessionID, recordID) => {
    const stat = statAt(path);
    if (!stat?.isFile()) return null;
    const value = readJSON(path);
    if (!value) return null;
    return normalize({ ...value, sessionID, completed: value.completed === true,
      updatedAt: timestampIsValid(value.updatedAt) ? Math.min(value.updatedAt, stat.mtimeMs) : stat.mtimeMs }, recordID);
  };
  const claimRecord = (name) => {
    const dir = join(directory, name);
    if (!CLAIM_NAME.test(name) || !statAt(dir)?.isDirectory()) return null;
    const sessionID = readJSON(join(dir, "session.json"));
    return validSessionID(sessionID) ? legacy(join(dir, "record.json"), sessionID, name) : null;
  };
  const finishClaim = (name) => {
    const dir = join(directory, name);
    // No recursive removal: unexpected entries are never ours to clean.
    unlinkOwned(join(dir, "record.json"));
    unlinkOwned(join(dir, "session.json"));
    try { rmdirSync(dir); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw failure("claim cleanup", error); }
  };
  const remove = (sessionID, handle) => {
    if (!validSessionID(sessionID) || !handle || handle.sessionID !== sessionID ||
      typeof handle.recordID !== "string" || !normalize(handle, handle.recordID)) return false;
    const isClaim = CLAIM_NAME.test(handle.recordID);
    if (!isClaim && !RECORD_NAME.test(handle.recordID)) return false;
    const current = isClaim ? claimRecord(handle.recordID) : immutable(handle.recordID);
    if (!current || ["sessionID", "leaseID", "completed", "updatedAt"].some(key => current[key] !== handle[key])) return false;
    if (!isClaim) return unlinkOwned(join(directory, handle.recordID));
    const removed = unlinkOwned(join(directory, handle.recordID, "record.json"));
    finishClaim(handle.recordID);
    return removed;
  };
  const claim = (sessionID) => {
    ensureDirectory();
    const name = `claim.${randomUUID()}`;
    const dir = join(directory, name);
    // Exclusive mkdir is the ownership boundary; never clean a colliding directory.
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    let moved = false;
    try {
      const fd = openSync(join(dir, "session.json"), "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(sessionID) + "\n"); fchmodSync(fd, 0o600); }
      finally { closeSync(fd); }
      renameSync(join(directory, `${sessionID}.json`), join(dir, "record.json"));
      moved = true;
      // Parse only the moved bytes. The mutable source may already name a replacement.
      if (statAt(join(dir, "record.json"))?.isFile()) chmodSync(join(dir, "record.json"), 0o600);
      return name;
    } catch (error) {
      if (!moved) finishClaim(name);
      if (error.code === "ENOENT") return null;
      throw failure("legacy claim", error);
    }
  };
  const expired = (record, now) => now - record.updatedAt >= MAX_AGE;
  const scan = ({ mutate = false, now = Date.now() } = {}) => {
    const records = [];
    for (let name of namesAt(directory)) {
      const path = join(directory, name);
      const stat = statAt(path);
      if (!stat) continue;
      if (TEMP_NAME.test(name) && stat.isFile()) {
        if (mutate && now - stat.mtimeMs >= MAX_AGE) unlinkOwned(path);
        continue;
      }
      let record;
      if (RECORD_NAME.test(name)) record = immutable(name);
      else if (!CLAIM_NAME.test(name) && name.endsWith(".json") && validSessionID(name.slice(0, -5)) && stat.isFile()) {
        if (!mutate) record = legacy(path, name.slice(0, -5), null);
        else { name = claim(name.slice(0, -5)); if (!name) continue; }
      }
      if (CLAIM_NAME.test(name)) {
        const dir = join(directory, name);
        if (!statAt(dir)?.isDirectory()) continue;
        record = claimRecord(name);
        if (!record && mutate) {
          const payload = statAt(join(dir, "record.json"));
          const entries = namesAt(dir);
          const knownEntries = entries.every(entry => entry === "record.json" || entry === "session.json");
          if (payload?.isFile() && validSessionID(readJSON(join(dir, "session.json")))) {
            warn("discarding claimed legacy record without exact lease authority; no broker request");
            finishClaim(name);
          } else if (!payload && knownEntries && now - (statAt(dir)?.mtimeMs ?? now) >= MAX_AGE) {
            finishClaim(name);
          }
        }
      }
      if (!record) continue;
      if (expired(record, now)) { if (mutate) remove(record.sessionID, record); }
      else records.push(record);
    }
    return records;
  };
  const publish = (sessionID, { leaseID, completed = false, updatedAt = Date.now() } = {}) => {
    if (!validSessionID(sessionID) || !leaseIsValid(leaseID) || !timestampIsValid(updatedAt) || Date.now() - updatedAt >= MAX_AGE) return null;
    ensureDirectory();
    const record = { version: 1, sessionID, leaseID, completed: completed === true, updatedAt };
    for (let attempt = 0; attempt < 3; attempt++) {
      const recordID = `v1.${digest(sessionID, leaseID)}.${randomUUID()}.json`;
      const temporary = join(directory, `.${recordID}.${process.pid}.${randomUUID()}.tmp`);
      let created = false;
      try {
        const descriptor = openSync(temporary, "wx", 0o600);
        created = true;
        try { writeFileSync(descriptor, JSON.stringify(record) + "\n"); fchmodSync(descriptor, 0o600); }
        finally { closeSync(descriptor); }
        // Do not link from the write's finally: a failed write must never publish partial JSON.
        linkSync(temporary, join(directory, recordID));
        return normalize(record, recordID);
      } catch (error) {
        if (error.code !== "EEXIST" || attempt === 2) throw failure("publication", error);
      } finally {
        if (created) unlinkOwned(temporary);
      }
    }
    return null;
  };
  const list = () => {
    const records = scan({ mutate: true });
    // Order groups by original age, then completion first within a session/lease group.
    // A pairwise special-case comparator would be non-transitive across other leases.
    const age = new Map();
    for (const record of records) {
      const key = digest(record.sessionID, record.leaseID);
      age.set(key, Math.min(age.get(key) ?? Infinity, record.updatedAt));
    }
    return records.sort((a, b) => {
      const ka = digest(a.sessionID, a.leaseID), kb = digest(b.sessionID, b.leaseID);
      return age.get(ka) - age.get(kb) || (ka === kb ? Number(b.completed) - Number(a.completed) : ka.localeCompare(kb)) ||
        a.updatedAt - b.updatedAt || a.recordID.localeCompare(b.recordID);
    });
  };
  const read = (sessionID) => {
    if (!validSessionID(sessionID)) return null;
    const latest = scan().filter(record => record.sessionID === sessionID)
      .sort((a, b) => b.updatedAt - a.updatedAt || Number(b.completed) - Number(a.completed))[0];
    return latest ? { leaseID: latest.leaseID, completed: latest.completed, updatedAt: latest.updatedAt } : null;
  };
  return { publish, list, read, remove, prune: () => { scan({ mutate: true }); } };
};
