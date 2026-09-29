import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("a lock with no owner record is reclaimed only after the whole wait elapses", () => {
  withBase("ownerless", (base, root) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createReconciliationStore({ root, lockWaitMs: 200 });
    // The one window a crashed writer can leave: mkdir succeeded, the owner record did not.
    // Reclaiming needs the full wait, so a writer mid-acquisition is never robbed.
    mkdirSync(store.paths().lock, { mode: 0o700 });
    const started = Date.now();
    assert.equal(store.update((state) => state).version, 1);
    assert.ok(Date.now() - started >= 200, `reclaimed after ${Date.now() - started}ms`);
    assert.equal(existsSync(store.paths().lock), false);
  });
});
