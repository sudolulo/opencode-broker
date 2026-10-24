import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { createAsyncPendingForgetStore } from "../lib/pending-forgets.js";
import { createPendingForgetRetry } from "../lib/pending-forget-retry.js";

const validSessionID = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const digest = (sessionID, leaseID) => createHash("sha256").update(JSON.stringify([sessionID, leaseID])).digest("hex");
const recordName = (sessionID, leaseID) => `v1.${digest(sessionID, leaseID)}.${randomUUID()}.json`;
const age = 14 * 24 * 60 * 60 * 1000;
const content = (sessionID, leaseID, completed = true, updatedAt = Date.now()) =>
  JSON.stringify({ version: 1, sessionID, leaseID, completed, updatedAt });
const mockedStore = async (overrides, run) => {
  const injection = mock.module("node:fs/promises", { namedExports: { ...fs, ...overrides } });
  try {
    const { createAsyncPendingForgetStore: create } = await import(`../lib/pending-forgets.js?test=${randomUUID()}`);
    await run(create);
  } finally { injection.restore(); }
};

const withDirectory = async (run) => {
  const directory = mkdtempSync(join(tmpdir(), "pending-forget-async-"));
  try { await run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

test("async store migrates legacy records, preserves their age, and removes only an exact claimed handle", async () => {
  await withDirectory(async (directory) => {
    const now = Date.now();
    writeFileSync(join(directory, "session.json"), JSON.stringify({ leaseID: "legacy", completed: true, updatedAt: now - 1000 }));
    const store = createAsyncPendingForgetStore({ directory, validSessionID });
    const [record] = await Array.fromAsync(store.records({ now }));
    assert.equal(record.sessionID, "session");
    assert.equal(record.leaseID, "legacy");
    assert.equal(record.completed, true);
    assert.equal(await store.remove("session", { ...record, leaseID: "other" }), false);
    assert.equal(await store.remove("session", record), true);
    assert.deepEqual(await Array.fromAsync(store.records({ now })), []);
  });
});

test("async store retains unknown and oversized files, prunes only expired owned records, and yields in large directories", async () => {
  await withDirectory(async (directory) => {
    const now = Date.now();
    const freshName = recordName("fresh", "L1");
    const oldName = recordName("old", "L2");
    const content = (sessionID, leaseID, updatedAt) => JSON.stringify({ version: 1, sessionID, leaseID, completed: false, updatedAt });
    writeFileSync(join(directory, freshName), content("fresh", "L1", now));
    writeFileSync(join(directory, oldName), content("old", "L2", now - (14 * 24 * 60 * 60 * 1000)));
    writeFileSync(join(directory, "unknown"), "keep");
    writeFileSync(join(directory, "large-unknown"), "x".repeat(70000));
    for (let index = 0; index < 64; index += 1) writeFileSync(join(directory, `unknown-${index}`), "keep");
    let yields = 0;
    const store = createAsyncPendingForgetStore({ directory, validSessionID, schedule: (resolve) => { yields += 1; resolve(); } });
    assert.deepEqual((await Array.fromAsync(store.records({ now }))).map((record) => record.sessionID), ["fresh"]);
    assert.ok(yields >= 1);
    assert.equal(await import("node:fs/promises").then(({ access }) => access(join(directory, "unknown")).then(() => true, () => false)), true);
    assert.equal(await import("node:fs/promises").then(({ access }) => access(join(directory, oldName)).then(() => true, () => false)), false);
  });
});

test("an oversized owned completion fails the whole scan closed before a false record can dispatch", async () => {
  await withDirectory(async (directory) => {
    const now = Date.now();
    const blocked = recordName("same", "L1");
    const falseRecord = recordName("same", "L1");
    const bytes = content("same", "L1", true, now) + " ".repeat(70000);
    writeFileSync(join(directory, blocked), bytes);
    writeFileSync(join(directory, falseRecord), content("same", "L1", false, now));
    const store = createAsyncPendingForgetStore({ directory, validSessionID });
    const calls = [], warnings = [];
    const retry = createPendingForgetRetry({ records: () => store.records({ now }),
      forget: async (record) => calls.push(record), remove: store.remove,
      setTimer: () => ({ unref() {} }), warn: (message) => warnings.push(message) });
    await retry.kick();
    assert.deepEqual(calls, [], "an unreadable completion must block even its matching false settlement");
    assert.equal(warnings.length, 1);
    await assert.rejects(Array.fromAsync(store.records({ now })), /unsafe owned record/);
    assert.equal(readFileSync(join(directory, blocked), "utf8"), bytes);
  });
});

test("post-rename chmod failure retains moved bytes and the replacement legacy source", async () => withDirectory(async (directory) => {
  const source = join(directory, "session.json"), original = content("session", "old");
  const replacement = content("session", "replacement");
  writeFileSync(source, original);
  await mockedStore({
    rename: async (from, to) => { await fs.rename(from, to); writeFileSync(source, replacement); },
    chmod: async (path, mode) => {
      if (path.endsWith("/record.json")) throw Object.assign(Error("chmod denied"), { code: "EACCES" });
      return fs.chmod(path, mode);
    },
  }, async (create) => {
    await assert.rejects(Array.fromAsync(create({ directory, validSessionID }).records()), /legacy claim/);
    const claims = readdirSync(directory).filter((name) => name.startsWith("claim."));
    assert.equal(claims.length, 1, "ownership-transferred payload must survive chmod failure");
    assert.equal(readFileSync(join(directory, claims[0], "record.json"), "utf8"), original);
    assert.equal(readFileSync(source, "utf8"), replacement);
    assert.equal(statSync(join(directory, claims[0])).mode & 0o777, 0o700);
  });
  const recovered = await Array.fromAsync(createAsyncPendingForgetStore({ directory, validSessionID }).records());
  assert.deepEqual(recovered.map((item) => item.leaseID).sort(), ["old", "replacement"]);
}));

test("short reads are assembled to the exact size with no-follow opens", async () => withDirectory(async (directory) => {
  const path = join(directory, recordName("session", "short"));
  writeFileSync(path, content("session", "short"));
  const flagsSeen = [];
  await mockedStore({ open: async (path, flags, ...args) => {
    flagsSeen.push(flags);
    const handle = await fs.open(path, flags, ...args), read = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) => read(buffer, offset, Math.min(7, length), position);
    return handle;
  } }, async (create) => {
    const records = await Array.fromAsync(create({ directory, validSessionID }).records());
    assert.equal(records.length, 1, "valid JSON survives partial FileHandle.read results");
    assert.equal(records[0].leaseID, "short");
    assert.ok(flagsSeen.every((flags) => (flags & constants.O_NOFOLLOW) !== 0));
  });
}));

for (const fault of ["eof", "unreadable", "changed"]) {
  test(`${fault} owned read fails closed and preserves original bytes`, async () => withDirectory(async (directory) => {
    const path = join(directory, recordName("session", "read-fault")), bytes = content("session", "read-fault");
    writeFileSync(path, bytes);
    await mockedStore({ open: async (...args) => {
      const handle = await fs.open(...args), read = handle.read.bind(handle), stat = handle.stat.bind(handle);
      let reads = 0;
      handle.read = async (...args) => {
        reads++;
        if (fault === "unreadable") throw Object.assign(Error("denied"), { code: "EACCES" });
        if (fault === "eof") return { bytesRead: 0, buffer: args[0] };
        return read(...args);
      };
      handle.stat = async () => { const info = await stat(); if (fault === "changed" && reads) info.size++; return info; };
      return handle;
    } }, async (create) => {
      await assert.rejects(Array.fromAsync(create({ directory, validSessionID }).records()));
      assert.equal(readFileSync(path, "utf8"), bytes);
    });
  }));
}

for (const member of ["directory", "session.json", "record.json", "immutable"]) {
  test(`${member} symlink fails closed without reading or removing its target`, async () => withDirectory(async (directory) => {
    const foreign = join(directory, "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "session.json"), JSON.stringify("session"));
    writeFileSync(join(foreign, "record.json"), content("session", "linked"));
    const claim = join(directory, `claim.${randomUUID()}`);
    let link;
    if (member === "immutable") {
      link = join(directory, recordName("session", "linked")); symlinkSync(join(foreign, "record.json"), link);
    } else if (member === "directory") {
      link = claim; symlinkSync(foreign, claim);
    } else {
      mkdirSync(claim);
      writeFileSync(join(claim, "session.json"), JSON.stringify("session"));
      writeFileSync(join(claim, "record.json"), content("session", "linked"));
      link = join(claim, member); rmSync(link); symlinkSync(join(foreign, member), link);
    }
    const store = createAsyncPendingForgetStore({ directory, validSessionID });
    await assert.rejects(Array.fromAsync(store.records()), /unsafe owned record/);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(join(foreign, "record.json"), "utf8").includes("linked"), true);
    assert.equal(readFileSync(join(foreign, "session.json"), "utf8"), '"session"');
  }));
}

test("malformed and ID-only claims are cleaned, but fresh empty and foreign claims survive", async () => withDirectory(async (directory) => {
  const claims = [];
  for (const payload of ["{invalid", JSON.stringify({ sessionID: "session" })]) {
    const claim = join(directory, `claim.${randomUUID()}`); claims.push(claim); mkdirSync(claim);
    writeFileSync(join(claim, "session.json"), '"session"'); writeFileSync(join(claim, "record.json"), payload);
  }
  const fresh = join(directory, `claim.${randomUUID()}`), foreign = join(directory, `claim.${randomUUID()}`);
  mkdirSync(fresh); mkdirSync(foreign);
  writeFileSync(join(foreign, "session.json"), '"session"'); writeFileSync(join(foreign, "record.json"), "{invalid");
  writeFileSync(join(foreign, "foreign"), "preserve");
  assert.deepEqual(await Array.fromAsync(createAsyncPendingForgetStore({ directory, validSessionID }).records()), []);
  assert.deepEqual(claims.map(existsSync), [false, false], "invalid owned payloads must not accumulate");
  assert.equal(existsSync(fresh), true);
  assert.deepEqual(readdirSync(foreign).sort(), ["foreign", "record.json", "session.json"]);
}));

test("oversized claimed payload is never reaped as invalid even after the TTL", async () => withDirectory(async (directory) => {
  const claim = join(directory, `claim.${randomUUID()}`); mkdirSync(claim);
  const bytes = content("session", "large", true, 1) + " ".repeat(70000);
  writeFileSync(join(claim, "session.json"), '"session"'); writeFileSync(join(claim, "record.json"), bytes);
  await assert.rejects(Array.fromAsync(createAsyncPendingForgetStore({ directory, validSessionID }).records()), /unsafe owned record/);
  assert.equal(readFileSync(join(claim, "record.json"), "utf8"), bytes);
}));

test("legacy original mtime expires at fourteen days and is not refreshed by repeated scans", async () => withDirectory(async (directory) => {
  const now = Date.now(), original = Math.floor((now - age + 1000) / 1000) * 1000;
  const source = join(directory, "session.json"); writeFileSync(source, content("session", "old", true, now));
  utimesSync(source, original / 1000, original / 1000);
  const store = createAsyncPendingForgetStore({ directory, validSessionID });
  const [first] = await Array.fromAsync(store.records({ now }));
  assert.equal(first.updatedAt, original);
  assert.deepEqual(await Array.fromAsync(store.records({ now: original + age - 1 })), [first]);
  assert.deepEqual(await Array.fromAsync(store.records({ now: original + age })), []);
  assert.deepEqual(readdirSync(directory), []);
}));

test("disappearing directory entries count toward the 64-entry yield budget", async () => withDirectory(async (directory) => {
  for (let i = 0; i < 130; i++) writeFileSync(join(directory, `vanished-${i}.json`), "gone");
  let yields = 0, sinceYield = 0, peak = 0;
  await mockedStore({ lstat: async (path) => {
    if (path.includes("vanished-")) {
      peak = Math.max(peak, ++sinceYield);
      throw Object.assign(Error("gone"), { code: "ENOENT" });
    }
    return fs.lstat(path);
  } }, async (create) => {
    const store = create({ directory, validSessionID, schedule: (done) => { yields++; sinceYield = 0; done(); } });
    assert.deepEqual(await Array.fromAsync(store.records()), []);
    assert.ok(yields >= 2, "disappearing entries must not bypass cooperative yields");
    assert.ok(peak <= 64);
  });
}));

test("async store reaps only old, known malformed claims and leaves claims with foreign entries", async () => {
  await withDirectory(async (directory) => {
    const now = Date.now(), old = now - (15 * 24 * 60 * 60 * 1000);
    const empty = join(directory, `claim.${randomUUID()}`);
    const foreign = join(directory, `claim.${randomUUID()}`);
    mkdirSync(empty); mkdirSync(foreign);
    writeFileSync(join(empty, "session.json"), JSON.stringify({ invalid: true }));
    writeFileSync(join(foreign, "session.json"), JSON.stringify({ invalid: true }));
    writeFileSync(join(foreign, "foreign"), "keep");
    for (const path of [empty, foreign]) await import("node:fs/promises").then(({ utimes }) => utimes(path, old / 1000, old / 1000));
    const store = createAsyncPendingForgetStore({ directory, validSessionID });
    assert.deepEqual(await Array.fromAsync(store.records({ now })), []);
    assert.equal(await import("node:fs/promises").then(({ access }) => access(empty).then(() => true, () => false)), false);
    assert.equal(await import("node:fs/promises").then(({ access }) => access(foreign).then(() => true, () => false)), true);
  });
});

test("a symlinked store directory is rejected before scanning or mutating its target", async () => withDirectory(async (base) => {
  const directory = join(base, "store"), target = join(base, "foreign");
  mkdirSync(target);
  writeFileSync(join(target, "session.json"), content("session", "foreign"));
  symlinkSync(target, directory);
  await assert.rejects(Array.fromAsync(createAsyncPendingForgetStore({ directory, validSessionID }).records()), /unsafe/);
  assert.deepEqual(readdirSync(target), ["session.json"]);
}));

test("a pre-move claim failure cleans only its owned metadata and leaves the mutable source", async () => withDirectory(async (directory) => {
  writeFileSync(join(directory, "session.json"), content("session", "old"));
  await mockedStore({ rename: async () => { throw Object.assign(Error("private"), { code: "EACCES" }); } }, async (create) => {
    await assert.rejects(Array.fromAsync(create({ directory, validSessionID }).records()), /legacy claim/);
    assert.deepEqual(readdirSync(directory), ["session.json"]);
  });
}));

test("a record swapped to a symlink between lstat and open is not followed", async () => withDirectory(async (directory) => {
  const target = join(directory, "foreign"), path = join(directory, recordName("session", "L"));
  const bytes = content("session", "L");
  writeFileSync(target, bytes); writeFileSync(path, bytes);
  await mockedStore({ open: async (name, ...args) => {
    if (name === path) { rmSync(path); symlinkSync(target, path); }
    return fs.open(name, ...args);
  } }, async (create) => {
    await assert.rejects(Array.fromAsync(create({ directory, validSessionID }).records()), /unsafe owned record/);
    assert.equal(readFileSync(target, "utf8"), bytes);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
  });
}));

test("oversized claim metadata is retained rather than age-cleaned", async () => withDirectory(async (directory) => {
  const claim = join(directory, `claim.${randomUUID()}`);
  mkdirSync(claim); writeFileSync(join(claim, "session.json"), '"session"' + " ".repeat(70000));
  utimesSync(claim, 1, 1);
  await assert.rejects(Array.fromAsync(createAsyncPendingForgetStore({ directory, validSessionID }).records()), /unsafe owned record/);
  assert.equal(existsSync(join(claim, "session.json")), true);
}));
