import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { routingStateDir } from "../lib/routing.js";
import {
  RECONCILIATION_STATE_VERSION,
  createReconciliationStore,
  emptyReconciliationState,
  planReviewedModelsImport,
  readReviewedModels,
} from "../lib/reconcile-state.js";

const WORKER = fileURLToPath(new URL("./fixtures/reconcile-state-worker.mjs", import.meta.url));

const ROLE_RECORD = { providerID: "openai", roleID: "gpt-sol", state: "evidence-pending" };

// Every case gets a throwaway base directory. The state root itself is a CHILD of it that the
// store is expected to create, so the permission assertions are about this module's mkdir and
// chmod rather than about mkdtemp's own 0700.
const withBase = (name, run) => {
  const base = mkdtempSync(join(tmpdir(), `reconcile-state-${name}-`));
  try {
    return run(base, join(base, "model-routing"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

const withBaseAsync = async (name, run) => {
  const base = mkdtempSync(join(tmpdir(), `reconcile-state-${name}-`));
  try {
    return await run(base, join(base, "model-routing"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

const runWorker = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [WORKER, ...args], { stdio: ["ignore", "inherit", "inherit"] });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve(child.pid) : reject(new Error(`reconcile-state worker ${args[0]} exited ${code}`)));
});

// A pid that is definitely gone: the only owner state that may ever be reclaimed.
const deadPID = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["-e", ""]);
  child.once("error", reject);
  child.once("exit", () => resolve(child.pid));
});

// The identity fields are read straight from /proc here, independently of the module under test:
// these build test INPUTS (a live identity, a reused pid), never an expected value.
const currentBootID = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const currentStartTime = (pid) => {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
};
// A syntactically valid boot id that is not this boot's, so a live pid recorded under it can only
// be a reused number.
const OTHER_BOOT_ID = "00000000-0000-4000-8000-000000000000";

// Publish a lock directory by hand, exactly as a contending writer of either vintage leaves it.
const plantLock = (lockPath, owner, instanceNames = []) => {
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  if (owner !== null) writeFileSync(join(lockPath, "owner"), JSON.stringify(owner) + "\n", { mode: 0o600 });
  for (const name of instanceNames) writeFileSync(join(lockPath, name), JSON.stringify({ planted: true }) + "\n", { mode: 0o600 });
};

// Everything this module may leave under the shared state root: the public lock, a private
// pre-publication lock directory, and ledger temps. The ledger itself has no leading dot.
const lockDebris = (root) => readdirSync(root).filter((name) => name.startsWith(".model-reconciliation")).sort();

// A warning sink that throws is somebody else's code failing: a logger writing to a closed
// stream, a notifier that raises. The module's own fallback is stderr, so the fallback has to be
// captured to be asserted on -- and capturing it keeps the test run's output clean.
const withCapturedStderr = (run) => {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map((arg) => String(arg)).join(" ")); };
  try {
    return run(lines);
  } finally {
    console.error = original;
  }
};

const explodingSink = () => { throw new Error("warning sink exploded"); };

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("state round-trips atomically with private permissions", () => {
  withBase("roundtrip", (base, root) => {
    // A pre-existing loose directory must be tightened, not merely left alone: the broker's
    // routing state root is shared, and a 0755 root exposes every ledger under it.
    mkdirSync(root, { mode: 0o755 });
    const store = createReconciliationStore({ root, now: () => 1_700_000_000_000 });
    const saved = store.update((state) => ({
      ...state,
      roles: { "openai:gpt-sol": ROLE_RECORD },
    }));
    assert.equal(saved.version, 1);
    assert.equal(saved.version, RECONCILIATION_STATE_VERSION);
    assert.equal(saved.updatedAt, 1_700_000_000_000);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(store.paths().state).mode & 0o777, 0o600);
    assert.equal(store.read().roles["openai:gpt-sol"].state, "evidence-pending");
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
    // The lock is ephemeral: a writer that returns normally must leave nothing to reclaim.
    assert.equal(existsSync(store.paths().lock), false);
    assert.equal(readFileSync(store.paths().state, "utf8").endsWith("\n"), true);
  });
});

test("an absent ledger reads as the empty state and constructing a store writes nothing", () => {
  withBase("absent", (base, root) => {
    const store = createReconciliationStore({ root });
    assert.deepEqual(store.read(), emptyReconciliationState());
    assert.deepEqual(emptyReconciliationState(), {
      version: 1, updatedAt: 0, roles: {}, unknown: {}, evidenceRequests: {},
    });
    // Reading is not a reason to create state: status output must be able to say "absent".
    assert.equal(existsSync(root), false);
  });
});

test("the default ledger lives in the routing state directory", () => {
  const paths = createReconciliationStore().paths();
  assert.deepEqual(paths, {
    state: join(routingStateDir(), "model-reconciliation.json"),
    lock: join(routingStateDir(), ".model-reconciliation.lock"),
    reviewed: join(routingStateDir(), "reviewed-models.json"),
  });
});

test("unknown versions fail loudly without replacement", () => {
  withBase("version", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root });
    const statePath = store.paths().state;
    writeFileSync(statePath, JSON.stringify({ version: 99 }) + "\n");
    assert.throws(() => store.read(), /unsupported reconciliation state version 99/);
    const before = readFileSync(statePath, "utf8");
    assert.throws(() => store.update((state) => state), /unsupported/);
    assert.equal(readFileSync(statePath, "utf8"), before);
    assert.equal(existsSync(store.paths().lock), false);
  });
});

test("corrupt state JSON fails loudly without replacement", () => {
  withBase("corrupt", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root });
    const statePath = store.paths().state;
    writeFileSync(statePath, "{ this is not json\n");
    assert.throws(() => store.read(), /not valid reconciliation state JSON/);
    assert.throws(() => store.update((state) => state), /not valid reconciliation state JSON/);
    assert.equal(readFileSync(statePath, "utf8"), "{ this is not json\n");
  });
});

test("unknown top-level fields are rejected by the state whitelist", () => {
  withBase("whitelist", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root });
    writeFileSync(store.paths().state, JSON.stringify({ ...emptyReconciliationState(), surprise: true }) + "\n");
    assert.throws(() => store.read(), /unknown reconciliation state field surprise/);
  });
});

test("a mutator cannot introduce an unknown top-level field or a non-object state", () => {
  withBase("mutator", (base, root) => {
    const store = createReconciliationStore({ root });
    assert.throws(() => store.update((state) => ({ ...state, count: 1 })), /unknown reconciliation state field count/);
    assert.throws(() => store.update(() => null), /reconciliation state update must return/);
    assert.throws(() => store.update("not a function"), /needs a mutator function/);
    // A rejected mutation writes nothing and leaves no lock behind.
    assert.equal(existsSync(store.paths().state), false);
    assert.equal(existsSync(store.paths().lock), false);
  });
});

test("read hands back a detached copy of the ledger", () => {
  withBase("detached", (base, root) => {
    const store = createReconciliationStore({ root });
    store.update((state) => ({ ...state, roles: { "openai:gpt-sol": ROLE_RECORD } }));
    const first = store.read();
    first.roles["openai:gpt-sol"].state = "tampered";
    assert.equal(store.read().roles["openai:gpt-sol"].state, "evidence-pending");
  });
});

test("only the ledger's own leftover temp files are cleaned up under the lock", () => {
  withBase("temps", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // The routing state root is shared with lib/routing.js, whose atomic writes use
    // `<name>.<pid>.<ms>.tmp` in the same directory. Sweeping every *.tmp here would delete
    // another writer's in-flight temp and lose that write.
    const foreign = join(root, "profile.json.4242.1700000000000.tmp");
    const mine = join(root, ".model-reconciliation.4242.abcdef.tmp");
    writeFileSync(foreign, "{}\n");
    writeFileSync(mine, "{}\n");
    const store = createReconciliationStore({ root });
    store.update((state) => state);
    assert.equal(existsSync(foreign), true);
    assert.equal(existsSync(mine), false);
  });
});

test("a directory fsync failure after the rename reports the committed mutation, not a failure", () => {
  withBase("fsync-after-commit", (base, root) => {
    const warnings = [];
    const store = createReconciliationStore({
      root,
      now: () => 1_700_000_000_000,
      onWarning: (message) => warnings.push(message),
      // The rename IS the commit point. This stands in for the durability barrier failing after
      // it -- a full disk, an I/O error, a root that went away -- which used to throw and tell
      // the caller its mutation had failed while the mutation was already on disk. A caller that
      // believes that re-runs a decision, or reports one that happened as refused.
      fsyncDir: () => { throw new Error("simulated directory fsync failure"); },
    });
    const saved = store.update((state) => ({ ...state, roles: { "openai:gpt-sol": ROLE_RECORD } }));
    assert.equal(saved.roles["openai:gpt-sol"].state, "evidence-pending");
    // Read back from the real file: the state handed to the caller is the state on disk.
    assert.equal(JSON.parse(readFileSync(store.paths().state, "utf8")).roles["openai:gpt-sol"].state, "evidence-pending");
    assert.equal(statSync(store.paths().state).mode & 0o777, 0o600);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /model-reconciliation\.json was committed/);
    assert.match(warnings[0], /simulated directory fsync failure/);
    assert.deepEqual(lockDebris(root), []);
  });
});

test("a warning sink that throws cannot turn a committed ledger write into a failure", () => {
  withBase("throwing-sink-commit", (base, root) => {
    withCapturedStderr((stderr) => {
      const store = createReconciliationStore({
        root,
        now: () => 1_700_000_000_000,
        // The warning here is raised PAST the rename that commits the decision. A sink that
        // throws at that point propagates out of update and tells the caller its mutation
        // failed, while the new ledger is already on disk -- the very failure the post-commit
        // warning exists to prevent, reintroduced by the reporting channel itself.
        onWarning: explodingSink,
        fsyncDir: () => { throw new Error("simulated directory fsync failure"); },
      });
      const saved = store.update((state) => ({ ...state, roles: { "openai:gpt-sol": ROLE_RECORD } }));
      assert.equal(saved.roles["openai:gpt-sol"].state, "evidence-pending");
      assert.equal(JSON.parse(readFileSync(store.paths().state, "utf8")).roles["openai:gpt-sol"].state, "evidence-pending");
      assert.deepEqual(lockDebris(root), []);
      // Both halves reach the operator: what was being reported, and that their sink is broken.
      assert.equal(stderr.length, 1);
      assert.match(stderr[0], /warning sink exploded/);
      assert.match(stderr[0], /was committed but its directory entry could not be made durable/);
    });
  });
});

test("a write that fails before the rename is fatal and leaves no temp behind", () => {
  withBase("pre-commit-failure", (base, root) => {
    const store = createReconciliationStore({ root });
    // A value JSON.stringify refuses. The failure lands after the temp exists and before the
    // rename, which is the only window where a mutation may still be reported as failed.
    assert.throws(() => store.update((state) => ({
      ...state,
      roles: { "openai:gpt-sol": { ...ROLE_RECORD, observedAt: 1n } },
    })), /BigInt/);
    assert.equal(existsSync(store.paths().state), false);
    assert.deepEqual(lockDebris(root), []);
  });
});

test("release leaves a replacement lock untouched when this writer's instance is gone", () => {
  withBase("release-violation", (base, root) => {
    const warnings = [];
    const store = createReconciliationStore({ root, onWarning: (message) => warnings.push(message) });
    const lock = store.paths().lock;
    const replacementUUID = randomUUID();
    const replacementInstance = `instance.${process.pid}.${replacementUUID}`;
    store.update((state) => {
      // Inside the critical section, do to this writer exactly what the old reclaim did: take its
      // lock away and let another live writer publish in its place. Release must notice that the
      // directory is no longer its own and leave every byte of the replacement alone.
      rmSync(lock, { recursive: true, force: true });
      plantLock(lock, {
        pid: process.pid, acquiredAt: 1_700_000_000_000, uuid: replacementUUID,
        bootId: currentBootID(), starttime: currentStartTime(process.pid),
      }, [replacementInstance]);
      return state;
    });
    assert.equal(existsSync(join(lock, replacementInstance)), true);
    assert.equal(JSON.parse(readFileSync(join(lock, "owner"), "utf8")).uuid, replacementUUID);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no longer holds this writer's instance/);
  });
});

test("a warning sink that throws on a lost lock neither fails the mutation nor touches the replacement", () => {
  withBase("throwing-sink-release", (base, root) => {
    withCapturedStderr((stderr) => {
      const store = createReconciliationStore({ root, now: () => 1_700_000_000_000, onWarning: explodingSink });
      const lock = store.paths().lock;
      const replacementUUID = randomUUID();
      const replacementInstance = `instance.${process.pid}.${replacementUUID}`;
      // The same lost-lock scenario as above, with a sink that throws while reporting it. The
      // warning is raised inside release, which runs in update's finally: a throw there both
      // buries the committed state the caller was owed and abandons the rest of the release.
      const saved = store.update((state) => {
        rmSync(lock, { recursive: true, force: true });
        plantLock(lock, {
          pid: process.pid, acquiredAt: 1_700_000_000_000, uuid: replacementUUID,
          bootId: currentBootID(), starttime: currentStartTime(process.pid),
        }, [replacementInstance]);
        return { ...state, roles: { "openai:gpt-sol": ROLE_RECORD } };
      });
      assert.equal(saved.roles["openai:gpt-sol"].state, "evidence-pending");
      // Not one byte of the live replacement is removed, and nothing extra is left lying around.
      assert.equal(existsSync(join(lock, replacementInstance)), true);
      assert.equal(JSON.parse(readFileSync(join(lock, "owner"), "utf8")).uuid, replacementUUID);
      assert.deepEqual(lockDebris(root), [".model-reconciliation.lock"]);
      assert.equal(stderr.length, 1);
      assert.match(stderr[0], /warning sink exploded/);
      assert.match(stderr[0], /no longer holds this writer's instance/);
    });
  });
});

test("legacy reviewed-model import is preview-only", () => {
  withBase("reviewed", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const reviewedPath = createReconciliationStore({ root }).paths().reviewed;
    writeFileSync(reviewedPath, JSON.stringify({ "openai/gpt-5.6-sol": "2026-07-09" }) + "\n");
    const reviewed = readReviewedModels(reviewedPath);
    assert.deepEqual(planReviewedModelsImport(emptyReconciliationState(), reviewed), {
      importKeys: ["openai/gpt-5.6-sol"], existingKeys: [],
    });
    assert.equal(readFileSync(reviewedPath, "utf8").includes("gpt-5.6-sol"), true);
  });
});

test("reviewed models already in the ledger are existing, not imports", () => {
  const state = {
    ...emptyReconciliationState(),
    roles: {
      "openai:gpt-sol": { providerID: "openai", roleID: "gpt-sol", candidateModelID: "gpt-5.6-sol", state: "evidence-pending" },
    },
    unknown: {
      abc123: { providerID: "example", modelID: "new-role", state: "evidence-pending" },
    },
  };
  assert.deepEqual(planReviewedModelsImport(state, {
    "openai/gpt-6-sol": "2026-09-22",
    "openai/gpt-5.6-sol": "2026-07-09",
    "example/new-role": "2026-07-10",
  }), {
    importKeys: ["openai/gpt-6-sol"],
    existingKeys: ["example/new-role", "openai/gpt-5.6-sol"],
  });
});

test("a missing legacy ledger reads empty, malformed JSON throws and keeps the file", () => {
  withBase("reviewed-bad", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const reviewedPath = join(root, "reviewed-models.json");
    assert.deepEqual(readReviewedModels(reviewedPath), {});
    writeFileSync(reviewedPath, "{ truncated\n");
    assert.throws(() => readReviewedModels(reviewedPath), /not valid reviewed-models JSON/);
    assert.equal(readFileSync(reviewedPath, "utf8"), "{ truncated\n");
    // Entry-level junk is not a corrupt file: the valid neighbours still count as seen.
    writeFileSync(reviewedPath, JSON.stringify({ "openai/gpt-5.6-sol": "2026-07-09", "no-provider": "2026-07-09", "openai/bad": 7 }) + "\n");
    assert.deepEqual(readReviewedModels(reviewedPath), { "openai/gpt-5.6-sol": "2026-07-09" });
  });
});

test("two processes serialize a hundred locked increments each without a lost update", async () => {
  await withBaseAsync("increments", async (base, root) => {
    await Promise.all([0, 1].map((worker) => runWorker(["increment", root, join(base, `marker-${worker}`), "100"])));
    const store = createReconciliationStore({ root });
    assert.equal(store.read().roles["test:counter"].testCount, 200);
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
    assert.equal(existsSync(store.paths().lock), false);
    // Not one lock, temp or private pre-publication directory may outlive 200 contended rounds.
    assert.deepEqual(lockDebris(root), []);
  });
});

test("a live lock owner is never reclaimed when the wait elapses", async () => {
  await withBaseAsync("live-owner", async (base, root) => {
    const marker = join(base, "held");
    const held = runWorker(["hold", root, marker, "2000"]);
    await waitFor(() => existsSync(marker), "the worker to hold the reconciliation lock");
    const store = createReconciliationStore({ root, lockWaitMs: 50 });
    const ownerPID = Number(readFileSync(marker, "utf8").trim());
    assert.throws(() => store.update((state) => state), /model reconciliation lock timed out/);
    // The timeout must not have touched the lock: a live owner keeps it.
    assert.equal(existsSync(store.paths().lock), true);
    assert.equal(JSON.parse(readFileSync(join(store.paths().lock, "owner"), "utf8")).pid, ownerPID);
    assert.equal(await held, ownerPID);
    assert.equal(existsSync(store.paths().lock), false);
    assert.equal(store.update((state) => state).version, 1);
  });
});

test("a lock whose owner process is gone is reclaimed at once", async () => {
  await withBaseAsync("dead-owner", async (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 50 });
    mkdirSync(store.paths().lock, { mode: 0o700 });
    writeFileSync(join(store.paths().lock, "owner"), JSON.stringify({ pid: await deadPID(), acquiredAt: Date.now() }) + "\n");
    const saved = store.update((state) => ({ ...state, roles: { "openai:gpt-sol": ROLE_RECORD } }));
    assert.equal(saved.roles["openai:gpt-sol"].state, "evidence-pending");
    assert.equal(existsSync(store.paths().lock), false);
  });
});

test("an empty lock directory is taken over at once, without waiting out the lock timeout", () => {
  withBase("empty-lock", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 2_000 });
    // An empty lock directory carries no identity at all, so nobody can be holding it: it is
    // what a writer killed between creating the directory and recording itself leaves behind.
    // Publication is a rename onto this path, and a rename onto an EMPTY directory succeeds, so
    // the takeover needs no waiting period and no deletion of anything.
    mkdirSync(store.paths().lock, { mode: 0o700 });
    const started = Date.now();
    assert.equal(store.update((state) => state).version, 1);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `took ${elapsed}ms to take over an empty lock directory`);
    assert.deepEqual(lockDebris(root), []);
  });
});

test("a live legacy owner record with no identity fields keeps the lock", () => {
  withBase("legacy-live", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 50 });
    // Exactly what an older build wrote: a pid and a timestamp, no uuid, no instance file.
    const owner = { pid: process.pid, acquiredAt: 1_700_000_000_000 };
    plantLock(store.paths().lock, owner);
    assert.throws(() => store.update((state) => state), /model reconciliation lock timed out/);
    assert.deepEqual(JSON.parse(readFileSync(join(store.paths().lock, "owner"), "utf8")), owner);
    // The failed attempt must take its own private directory with it.
    assert.deepEqual(lockDebris(root), [".model-reconciliation.lock"]);
  });
});

test("an owner whose recorded identity matches a live process keeps the lock", () => {
  withBase("identity-live", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 50 });
    const uuid = randomUUID();
    const instance = `instance.${process.pid}.${uuid}`;
    const owner = { pid: process.pid, acquiredAt: 1_700_000_000_000, uuid, bootId: currentBootID(), starttime: currentStartTime(process.pid) };
    plantLock(store.paths().lock, owner, [instance]);
    assert.throws(() => store.update((state) => state), /model reconciliation lock timed out/);
    assert.deepEqual(JSON.parse(readFileSync(join(store.paths().lock, "owner"), "utf8")), owner);
    assert.equal(existsSync(join(store.paths().lock, instance)), true);
  });
});

test("a boot id from another boot proves the recorded pid was reused", () => {
  withBase("boot-reuse", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 50 });
    const uuid = randomUUID();
    // The pid is this very process, so it answers kill(0) as live. Only the boot id can tell
    // that the writer which recorded it is gone -- a reboot took it with the whole boot.
    const owner = { pid: process.pid, acquiredAt: 1_700_000_000_000, uuid, bootId: OTHER_BOOT_ID, starttime: currentStartTime(process.pid) };
    plantLock(store.paths().lock, owner, [`instance.${process.pid}.${uuid}`]);
    const saved = store.update((state) => ({ ...state, roles: { "openai:gpt-sol": ROLE_RECORD } }));
    assert.equal(saved.roles["openai:gpt-sol"].state, "evidence-pending");
    assert.equal(existsSync(store.paths().lock), false);
    assert.deepEqual(lockDebris(root), []);
  });
});

test("a recorded process start time that does not match proves the recorded pid was reused", () => {
  withBase("starttime-reuse", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 50 });
    const uuid = randomUUID();
    // Same boot, same live pid, different process: this pid was recycled after the writer died.
    const owner = { pid: process.pid, acquiredAt: 1_700_000_000_000, uuid, bootId: currentBootID(), starttime: "1" };
    plantLock(store.paths().lock, owner, [`instance.${process.pid}.${uuid}`]);
    assert.equal(store.update((state) => state).version, 1);
    assert.equal(existsSync(store.paths().lock), false);
    assert.deepEqual(lockDebris(root), []);
  });
});

test("a stale dead-owner observation never touches a replacement's live instance", async () => {
  await withBaseAsync("stale-observation", async (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 50 });
    const deadUUID = randomUUID();
    const liveUUID = randomUUID();
    // The state a writer that proved an owner dead can find a moment later: the identity it
    // condemned is already gone from the directory, and another identity's live instance is
    // there. Acting on the stale observation must not remove a byte of it.
    const owner = { pid: await deadPID(), acquiredAt: 1_700_000_000_000, uuid: deadUUID, bootId: currentBootID(), starttime: "1" };
    const liveInstance = `instance.${process.pid}.${liveUUID}`;
    plantLock(store.paths().lock, owner, [liveInstance]);
    assert.throws(() => store.update((state) => state), /model reconciliation lock timed out/);
    assert.equal(existsSync(join(store.paths().lock, liveInstance)), true);
    assert.deepEqual(JSON.parse(readFileSync(join(store.paths().lock, "owner"), "utf8")), owner);
    assert.equal(existsSync(store.paths().state), false);
  });
});

test("a dead owner whose instance is already gone is cleared so the lock can be taken", async () => {
  await withBaseAsync("dead-owner-debris", async (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 50 });
    const uuid = randomUUID();
    // A writer killed between unlinking its instance and unlinking its owner. Nothing can
    // publish over the leftover record, so refusing to clear it would wedge the ledger forever.
    plantLock(store.paths().lock, { pid: await deadPID(), acquiredAt: 1_700_000_000_000, uuid, bootId: currentBootID(), starttime: "1" });
    assert.equal(store.update((state) => state).version, 1);
    assert.equal(existsSync(store.paths().lock), false);
    assert.deepEqual(lockDebris(root), []);
  });
});

test("a dead writer's private lock directory is swept once the public lock is held", async () => {
  await withBaseAsync("sweep-dead", async (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const dead = await deadPID();
    const uuid = randomUUID();
    // A writer killed after building its private directory and before publishing it. Nothing
    // else will ever come back for it, and it accumulates under the shared state root.
    const privateDir = join(root, `.model-reconciliation.lock.${dead}.${uuid}`);
    plantLock(privateDir, { pid: dead, acquiredAt: 1_700_000_000_000, uuid, bootId: currentBootID(), starttime: "1" }, [`instance.${dead}.${uuid}`]);
    createReconciliationStore({ root }).update((state) => state);
    assert.equal(existsSync(privateDir), false);
    assert.deepEqual(lockDebris(root), []);
  });
});

test("a warning sink that throws during the post-acquire sweep cannot leak the published lock", async () => {
  await withBaseAsync("throwing-sink-sweep", async (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const dead = await deadPID();
    const uuid = randomUUID();
    const privateDir = join(root, `.model-reconciliation.lock.${dead}.${uuid}`);
    plantLock(privateDir, { pid: dead, acquiredAt: 1_700_000_000_000, uuid, bootId: currentBootID(), starttime: "1" }, [`instance.${dead}.${uuid}`]);
    // Readable, so the sweep proves the owner dead and tries to remove it -- and unremovable,
    // because its own entries cannot be unlinked through a directory with no write bit. The
    // sweep therefore warns, and it warns from INSIDE acquire, before the release function has
    // been handed to anyone. A sink that throws there abandons a lock that is already published
    // and that nothing will ever release: the ledger wedges until an operator clears it by hand.
    chmodSync(privateDir, 0o500);
    try {
      withCapturedStderr((stderr) => {
        const store = createReconciliationStore({ root, lockWaitMs: 50, onWarning: explodingSink });
        assert.equal(store.update((state) => state).version, 1);
        assert.equal(existsSync(store.paths().lock), false);
        // The orphan it could not remove is still there and still reported, which is correct:
        // only the reporting was made unable to fail.
        assert.equal(existsSync(join(privateDir, "owner")), true);
        assert.equal(stderr.some((line) => /warning sink exploded/.test(line)), true);
        assert.equal(stderr.some((line) => /unable to remove the stale reconciliation lock directory/.test(line)), true);
      });
    } finally {
      chmodSync(privateDir, 0o700);
    }
  });
});

test("a dead owner with a full identity and its own instance file is reclaimed leaving nothing behind", async () => {
  await withBaseAsync("dead-identity-reclaim", async (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 50 });
    const dead = await deadPID();
    const uuid = randomUUID();
    // The complete thing a crashed writer of this vintage leaves behind: a full identity record
    // AND the instance file that is what actually holds the lock, both belonging to a pid that
    // is definitely gone. Every other reclaim case here is missing one of the three.
    plantLock(store.paths().lock, { pid: dead, acquiredAt: 1_700_000_000_000, uuid, bootId: currentBootID(), starttime: "1" }, [`instance.${dead}.${uuid}`]);
    const saved = store.update((state) => ({ ...state, roles: { "openai:gpt-sol": ROLE_RECORD } }));
    assert.equal(saved.roles["openai:gpt-sol"].state, "evidence-pending");
    assert.equal(existsSync(store.paths().lock), false);
    assert.deepEqual(lockDebris(root), []);
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("a live writer's private lock directory survives the sweep", () => {
  withBase("sweep-live", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const uuid = randomUUID();
    const privateDir = join(root, `.model-reconciliation.lock.${process.pid}.${uuid}`);
    const instance = `instance.${process.pid}.${uuid}`;
    // A contender still building or still retrying its rename. Sweeping it would destroy the
    // identity that proves it holds nothing, and hand its name to a second live writer.
    plantLock(privateDir, { pid: process.pid, acquiredAt: 1_700_000_000_000, uuid, bootId: currentBootID(), starttime: currentStartTime(process.pid) }, [instance]);
    createReconciliationStore({ root }).update((state) => state);
    assert.equal(existsSync(join(privateDir, "owner")), true);
    assert.equal(existsSync(join(privateDir, instance)), true);
  });
});

test("a private lock that fails mid-construction takes its own directory with it", () => {
  withBase("private-build-failure", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // A pid JSON.stringify refuses. The identity record is serialized after the private
    // directory exists and before either file inside it is written, so the failure lands in
    // exactly the window that can orphan a private lock. Nothing ever comes back for one: the
    // sweep deletes only on proof the identity inside is dead, and a directory with no readable
    // owner record is the one case it correctly refuses to touch, so it accumulates forever.
    const store = createReconciliationStore({ root, pid: 42n });
    assert.throws(() => store.update((state) => state), /BigInt/);
    assert.deepEqual(lockDebris(root), []);
    assert.equal(existsSync(store.paths().state), false);
  });
});

test("a private lock whose cleanup fails is reported without replacing the construction error", () => {
  withBase("private-cleanup-failure", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const warnings = [];
    let built = null;
    const store = createReconciliationStore({
      root,
      onWarning: (message) => warnings.push(message),
      // Stands in for the permission tightening failing on the freshly created private
      // directory -- EPERM, or a filesystem that refuses chmod. Taking write permission off the
      // state root at the same moment makes the cleanup that follows fail for real (EACCES on
      // the parent), which is the case where the caller must still be told what actually broke.
      chmodLockDir: (dir) => {
        built = dir;
        chmodSync(root, 0o500);
        throw new Error("simulated private lock chmod failure");
      },
    });
    try {
      assert.throws(() => store.update((state) => state), /simulated private lock chmod failure/);
      // The orphan survives, so it has to be named: an operator is the only thing that can
      // remove it now.
      assert.equal(existsSync(built), true);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /unable to remove the partially built reconciliation lock directory/);
      assert.equal(warnings[0].includes(built), true);
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

test("a private lock directory with no readable identity survives the sweep", () => {
  withBase("sweep-unknown", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // No owner record means no proof of death, and proof is the only licence to delete.
    const privateDir = join(root, `.model-reconciliation.lock.4242.${randomUUID()}`);
    mkdirSync(privateDir, { mode: 0o700 });
    createReconciliationStore({ root }).update((state) => state);
    assert.equal(existsSync(privateDir), true);
  });
});
