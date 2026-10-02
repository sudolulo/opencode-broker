import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { routingStateDir } from "../lib/routing.js";
import {
  DEFAULT_RAW_BASE_PATH,
  RECONCILIATION_STATE_VERSION,
  SCHEDULED_RUNS_LIMIT,
  appendScheduledRun,
  createReconciliationStore,
  emptyReconciliationState,
  migrateReconciliationState,
} from "../lib/reconcile-state.js";

const NOW = 1_800_000_000_000;
const AT = new Date(NOW).toISOString();
const LATER = new Date(NOW + 60_000).toISOString();
const DAY_LATER = new Date(NOW + 86_400_000 + 120_000).toISOString();
const hash = (char) => char.repeat(64);
// Any absolute path will do: configCutover targets are compared as exact strings.
const RAW = "/srv/fixture-devbox/config/opencode/opencode.json";

const withStore = (name, run) => {
  const base = mkdtempSync(join(tmpdir(), `reconcile-state-v2-${name}-`));
  try {
    const root = join(base, "model-routing");
    const store = createReconciliationStore({ root, now: () => NOW, configTargets: { rawEmergency: RAW } });
    return run({ root, store, generated: join(root, "resolver-generations", "current", "opencode.json") });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

const seed = (root, store, value) => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(store.paths().state, JSON.stringify(value) + "\n", { mode: 0o600 });
};

const ledgerBytes = (store) => readFileSync(store.paths().state, "utf8");

// A refused update must leave the ledger byte-identical (or still absent) and release its lock.
const assertRefused = (store, mutator, pattern) => {
  const before = existsSync(store.paths().state) ? ledgerBytes(store) : null;
  assert.throws(() => store.update(mutator), pattern);
  assert.equal(existsSync(store.paths().state) ? ledgerBytes(store) : null, before);
  assert.equal(existsSync(store.paths().lock), false);
};

const V1 = Object.freeze({
  version: 1,
  updatedAt: 5,
  roles: { "openai:gpt-sol": { providerID: "openai", roleID: "gpt-sol", state: "evidence-pending" } },
  unknown: {},
  evidenceRequests: {},
});

const initRecord = (revision) => ({
  schemaVersion: 1, generation: 0, registryHash: hash("1"), manifestHash: hash("2"), rawBaseHash: hash("3"),
  sourceLedgerRevision: revision, initializedAt: AT,
});
const generatedCutover = (target, revision, overrides = {}) => ({
  schemaVersion: 1, mode: "generated", target, generation: 0, manifestHash: hash("2"),
  registryHash: hash("1"), rawBaseHash: hash("3"), sourceLedgerRevision: revision, changedAt: AT,
  reason: "bootstrap", ...overrides,
});
const rawCutover = (revision, overrides = {}) => ({
  schemaVersion: 1, mode: "raw-emergency", target: RAW, generation: null, manifestHash: null,
  registryHash: hash("1"), rawBaseHash: hash("3"), sourceLedgerRevision: revision, changedAt: LATER,
  reason: "emergency-rollback", ...overrides,
});
const legacy = (revision, overrides = {}) => ({
  schemaVersion: 1, baselineCount: 83, baselineHash: hash("b"), finalCount: null, finalHash: null,
  sourceLedgerRevision: revision, quiescedAt: null, archivePath: null, archiveHash: null, ...overrides,
});
const prepared = (overrides = {}) => ({
  at: AT, allowlist: ["openai"], ledgerRevision: 1, overlayHash: hash("4"), effectiveHash: hash("5"),
  baseHash: hash("3"), manifestHash: null, policyIntentHash: hash("6"), ...overrides,
});
const committed = (overrides = {}) => ({
  at: LATER, generation: 1, manifestHash: hash("7"),
  generationAck: { generation: 1, manifestHash: hash("7"), effectiveHash: hash("5") },
  brokerAck: null, ledgerAck: { revision: 2 }, ...overrides,
});
const checkpoint = (overrides = {}) => ({
  generation: 0, manifestHash: hash("2"), allowlist: [], ledgerRevision: 1, brokerPolicyRevision: null, ...overrides,
});
const gate = (overrides = {}) => ({
  startedAt: LATER, completedAt: null, scheduledRunIDs: [], evidence: [], resetCount: 0, ...overrides,
});
const stage = (overrides = {}) => ({
  schemaVersion: 1, status: "prepared", prepared: prepared(), committed: null, checkpoint: null, gate: null, ...overrides,
});
const scheduledRun = (index, overrides = {}) => ({
  id: `run-${index}`, startedAt: AT, endedAt: LATER, ok: true, mode: "dry-run", providers: [],
  ledgerRevision: 0, exitCode: 0, ...overrides,
});

const bootstrap = (store) => store.update((state, { revision }) => ({
  ...state, generationRegistryInitialized: initRecord(revision),
}));

test("an empty v2 ledger carries a zero revision, no stages and no scheduled runs", () => {
  assert.equal(RECONCILIATION_STATE_VERSION, 2);
  assert.deepEqual(emptyReconciliationState(), {
    version: 2, updatedAt: 0, revision: 0, roles: {}, unknown: {}, evidenceRequests: {},
    providerStages: {}, scheduledRuns: [],
  });
});

test("a v1 ledger migrates in memory on read and is persisted as v2 only by a locked update", () => {
  const input = structuredClone(V1);
  const migrated = migrateReconciliationState(input);
  assert.equal(input.version, 1, "migration must not mutate its input");
  assert.deepEqual(migrated, { ...V1, version: 2, revision: 0, providerStages: {}, scheduledRuns: [] });
  assert.equal(migrateReconciliationState(migrated), migrated);

  withStore("migrate", ({ root, store }) => {
    seed(root, store, V1);
    const before = ledgerBytes(store);
    const read = store.read();
    assert.equal(read.version, 2);
    assert.equal(read.revision, 0);
    assert.deepEqual(read.roles, V1.roles);
    assert.deepEqual(read.providerStages, {});
    assert.deepEqual(read.scheduledRuns, []);
    // Reading is never a reason to rewrite: a read-only verifier must leave the bytes alone.
    assert.equal(ledgerBytes(store), before);

    let seen = null;
    const saved = store.update((state, ack) => {
 seen = ack; return state; });
    assert.deepEqual(seen, { revision: 1 });
    assert.equal(saved.revision, 1);
    const onDisk = JSON.parse(ledgerBytes(store));
    assert.equal(onDisk.version, 2);
    assert.equal(onDisk.revision, 1);
    assert.deepEqual(onDisk.roles, V1.roles);
  });
});

test("v1 migration is strict and fails closed with the bytes preserved", () => {
  const { evidenceRequests, ...missing } = V1;
  assert.deepEqual(evidenceRequests, {});
  const cases = [
    [{ ...V1, surprise: true }, /unknown reconciliation state v1 field surprise/],
    [{ ...V1, revision: 3 }, /unknown reconciliation state v1 field revision/],
    [missing, /reconciliation state v1 is missing field evidenceRequests/],
    [{ ...V1, roles: [] }, /reconciliation state field roles is not an object/],
  ];
  for (const [value, pattern] of cases) {
    withStore("strict-v1", ({ root, store }) => {
      seed(root, store, value);
      assert.throws(() => store.read(), pattern);
      assertRefused(store, (state) => state, pattern);
    });
  }
});

test("unknown versions, unknown v2 fields and a malformed revision fail loudly", () => {
  const cases = [
    [{ ...emptyReconciliationState(), version: 3 }, /unsupported reconciliation state version 3/],
    [{ ...emptyReconciliationState(), surprise: true }, /unknown reconciliation state field surprise/],
    [{ ...emptyReconciliationState(), revision: -1 }, /reconciliation state has an invalid revision -1/],
    [{ ...emptyReconciliationState(), scheduledRuns: {} }, /reconciliation state field scheduledRuns is not an array/],
  ];
  for (const [value, pattern] of cases) {
    withStore("versions", ({ root, store }) => {
      seed(root, store, value);
      assert.throws(() => store.read(), pattern);
      assertRefused(store, (state) => state, pattern);
    });
  }
});

test("every update advances the revision by exactly one and a mutator cannot set it", () => {
  withStore("revision", ({ store }) => {
    assert.equal(store.update((state) => state).revision, 1);
    assert.equal(store.update((state) => ({ ...state, revision: 40 })).revision, 2);
    assert.equal(store.read().revision, 2);
  });
});

test("generationRegistryInitialized is validated field by field", () => {
  withStore("init-fields", ({ store }) => {
    const cases = [
      [{ generation: 1 }, /generationRegistryInitialized generation must be 0/],
      [{ schemaVersion: 2 }, /generationRegistryInitialized schemaVersion must be 1/],
      [{ manifestHash: hash("A") }, /generationRegistryInitialized\.manifestHash must be a lowercase 64-hex SHA-256/],
      [{ initializedAt: "2026-10-01 00:00:00" }, /generationRegistryInitialized\.initializedAt must be a UTC ISO-8601 timestamp/],
      [{ initializedAt: "2026-10-01T00:00:00+02:00" }, /initializedAt must be a UTC ISO-8601 timestamp/],
      [{ extra: true }, /generationRegistryInitialized has unknown field extra/],
    ];
    for (const [overrides, pattern] of cases) {
      assertRefused(store, (state, { revision }) => ({
        ...state, generationRegistryInitialized: { ...initRecord(revision), ...overrides },
      }), pattern);
    }
  });
});

test("generationRegistryInitialized is written once with the enclosing revision and is then immutable", () => {
  withStore("init-immutable", ({ store }) => {
    store.update((state) => state); // revision 1
    assertRefused(store, (state) => ({ ...state, generationRegistryInitialized: initRecord(1) }),
      /generationRegistryInitialized\.sourceLedgerRevision must be the enclosing ledger revision 2/);
    const saved = bootstrap(store);
    assert.equal(saved.generationRegistryInitialized.sourceLedgerRevision, 2);
    // An identical record rebuilt in another key order is an exact replay, not a change.
    const replayed = store.update((state) => ({
      ...state,
      generationRegistryInitialized: Object.fromEntries(Object.entries(state.generationRegistryInitialized).reverse()),
    }));
    assert.equal(replayed.generationRegistryInitialized.sourceLedgerRevision, 2);
    for (const mutator of [
      (state) => ({ ...state, generationRegistryInitialized: { ...state.generationRegistryInitialized, registryHash: hash("9") } }),
      (state) => { delete state.generationRegistryInitialized; return state; },
      (state) => ({ ...state, generationRegistryInitialized: null }),
    ]) {
      assertRefused(store, mutator, /generationRegistryInitialized is immutable once written/);
    }
  });
});

test("configCutover accepts only the two valid states of the spec table", () => {
  withStore("cutover", ({ store, generated }) => {
    bootstrap(store); // revision 1; every refused attempt below runs at revision 2
    const cases = [
      [(rev) => generatedCutover(generated, rev, { manifestHash: null }), /configCutover\.manifestHash must be a lowercase 64-hex SHA-256/],
      [(rev) => generatedCutover(generated, rev, { generation: null }), /configCutover\.generation must be a non-negative integer/],
      [(rev) => rawCutover(rev, { generation: 0 }), /configCutover raw-emergency requires null generation and manifestHash/],
      [(rev) => rawCutover(rev, { manifestHash: hash("2") }), /configCutover raw-emergency requires null generation and manifestHash/],
      [(rev) => rawCutover(rev, { reason: "bootstrap" }), /configCutover raw-emergency requires reason emergency-rollback/],
      [(rev) => generatedCutover(generated, rev, { reason: "emergency-rollback" }), /configCutover reason emergency-rollback requires mode raw-emergency/],
      [(rev) => generatedCutover(generated.replace("/current/", "/./current/"), rev), /configCutover target for mode generated must be exactly/],
      [(rev) => generatedCutover(RAW, rev), /configCutover target for mode generated must be exactly/],
      [(rev) => rawCutover(rev, { target: generated }), /configCutover target for mode raw-emergency must be exactly/],
      [(rev) => generatedCutover(generated, rev, { manifestHash: hash("8") }), /configCutover generation 0 does not match the generationRegistryInitialized acknowledgement/],
      [(rev) => generatedCutover(generated, rev, { rawBaseHash: hash("9") }), /configCutover bootstrap rawBaseHash does not match the generationRegistryInitialized acknowledgement/],
      [(rev) => generatedCutover(generated, rev, { generation: 2, manifestHash: hash("a") }), /configCutover reason bootstrap requires generation 0/],
      [(rev) => generatedCutover(generated, rev, { mode: "rollback" }), /configCutover mode rollback is invalid/],
      [(rev) => ({ ...generatedCutover(generated, rev), extra: 1 }), /configCutover has unknown field extra/],
      [(rev) => generatedCutover(generated, rev - 1), /configCutover\.sourceLedgerRevision must be the enclosing ledger revision 2/],
    ];
    for (const [build, pattern] of cases) {
      assertRefused(store, (state, { revision }) => ({ ...state, configCutover: build(revision) }), pattern);
    }
    const cutover = store.update((state, { revision }) => ({ ...state, configCutover: generatedCutover(generated, revision) }));
    assert.equal(cutover.configCutover.sourceLedgerRevision, 2);
    // Carrying an unchanged record through an unrelated write is not a new CAS.
    assert.equal(store.update((state) => state).configCutover.sourceLedgerRevision, 2);
    const rolledBack = store.update((state, { revision }) => ({ ...state, configCutover: rawCutover(revision) }));
    assert.equal(rolledBack.configCutover.mode, "raw-emergency");
    assert.equal(rolledBack.configCutover.generation, null);
    const reactivated = store.update((state, { revision }) => ({
      ...state,
      configCutover: generatedCutover(generated, revision, { generation: 3, manifestHash: hash("a"), reason: "reactivation" }),
    }));
    assert.equal(reactivated.configCutover.generation, 3);
    assertRefused(store, (state) => { delete state.configCutover; return state; }, /configCutover cannot be removed once written/);
    assertRefused(store, (state) => ({ ...state, configCutover: null }), /configCutover cannot be removed once written/);
  });
});

test("configCutover without the initialization acknowledgement is invalid in both modes", () => {
  withStore("cutover-no-init", ({ store, generated }) => {
    assertRefused(store, (state, { revision }) => ({ ...state, configCutover: generatedCutover(generated, revision) }),
      /configCutover requires a generationRegistryInitialized acknowledgement/);
    assertRefused(store, (state, { revision }) => ({ ...state, configCutover: rawCutover(revision) }),
      /configCutover requires a generationRegistryInitialized acknowledgement/);
  });
});

test("a schema-invalid v2 ledger on disk fails closed for read and update with its bytes preserved", () => {
  withStore("corrupt-v2", ({ root, store, generated }) => {
    const cases = [
      [{ ...emptyReconciliationState(), revision: 4, configCutover: generatedCutover(generated, 4) }, /configCutover requires a generationRegistryInitialized acknowledgement/],
      [{ ...emptyReconciliationState(), generationRegistryInitialized: null }, /generationRegistryInitialized is not an object/],
      [{ ...emptyReconciliationState(), revision: 2, generationRegistryInitialized: initRecord(3) }, /generationRegistryInitialized\.sourceLedgerRevision 3 is ahead of ledger revision 2/],
      [{ ...emptyReconciliationState(), scheduledRuns: Array.from({ length: 51 }, (_, index) => scheduledRun(index)) }, /scheduledRuns holds 51 entries; the limit is 50/],
    ];
    for (const [value, pattern] of cases) {
      seed(root, store, value);
      const before = ledgerBytes(store);
      assert.throws(() => store.read(), pattern);
      assertRefused(store, (state) => state, pattern);
      assert.equal(ledgerBytes(store), before);
    }
  });
});

test("legacyMigration records a baseline first and keeps that baseline immutable", () => {
   withStore("legacy", ({ store }) => {
     const saved = store.update((state, { revision }) => ({ ...state, legacyMigration: legacy(revision) }));
     assert.equal(saved.legacyMigration.finalCount, null);
     const cases = [
       [{ finalCount: 80, finalHash: hash("c") }, /legacyMigration\.finalCount is below baselineCount/],
       [{ finalHash: hash("c") }, /legacyMigration\.finalHash requires finalCount/],
       [{ archivePath: "archive/reviewed-models.json", archiveHash: hash("d") }, /legacyMigration\.archivePath must be a normalized absolute path/],
       [{ archivePath: "/srv/archive/../reviewed-models.json", archiveHash: hash("d") }, /legacyMigration\.archivePath must be a normalized absolute path/],
       [{ archiveHash: hash("d") }, /legacyMigration\.archiveHash requires archivePath/],
       [{ quiescedAt: "yesterday" }, /legacyMigration\.quiescedAt must be a UTC ISO-8601 timestamp/],
       [{ baselineCount: 84 }, /legacyMigration baseline is immutable once recorded/],
       [{ baselineHash: hash("e") }, /legacyMigration baseline is immutable once recorded/],
     ];
     for (const [overrides, pattern] of cases) {
       assertRefused(store, (state) => ({ ...state, legacyMigration: { ...state.legacyMigration, ...overrides } }), pattern);
     }
     const final = store.update((state, { revision }) => ({
       ...state,
       legacyMigration: {
         ...state.legacyMigration, finalCount: 85, finalHash: hash("c"), sourceLedgerRevision: revision,
         quiescedAt: LATER, archivePath: "/srv/archive/reviewed-models.json", archiveHash: hash("d"),
       },
     }));
     assert.equal(final.legacyMigration.finalCount, 85);
     assertRefused(store, (state) => { delete state.legacyMigration; return state; }, /legacyMigration cannot be removed once written/);
   });
});

test("legacyMigration baseline phase allows null sourceLedgerRevision; final phase requires it and rejects values greater than ledger revision", () => {
    withStore("legacy-revision", ({ store }) => {
      // Baseline phase: sourceLedgerRevision may be null
      const baseline = store.update((state, { revision }) => ({
        ...state,
        legacyMigration: { ...legacy(null), sourceLedgerRevision: null },
      }));
      assert.equal(baseline.legacyMigration.sourceLedgerRevision, null);
      // Final phase: sourceLedgerRevision must be set and must not exceed ledger revision
      const final = store.update((state, { revision }) => ({
        ...state,
        legacyMigration: {
          ...state.legacyMigration,
          finalCount: 85,
          finalHash: hash("c"),
          sourceLedgerRevision: revision,
          quiescedAt: LATER,
          archivePath: "/srv/archive/reviewed-models.json",
          archiveHash: hash("d"),
        },
      }));
      assert.equal(final.legacyMigration.sourceLedgerRevision, 2);
      // Reject a sourceLedgerRevision greater than the current ledger revision
      assertRefused(store, (state, { revision }) => ({
        ...state,
        legacyMigration: { ...state.legacyMigration, sourceLedgerRevision: revision + 1 },
      }), /legacyMigration\.sourceLedgerRevision \d+ is ahead of ledger revision \d+/);
      // Final phase with null finalCount: sourceLedgerRevision must be set even if finalCount is null
      assertRefused(store, (state, { revision }) => ({
        ...state,
        legacyMigration: { ...state.legacyMigration, sourceLedgerRevision: null },
      }), /legacyMigration\.sourceLedgerRevision is required once finalCount is set/);
    });
  });

test("a re-prepared stage may keep its failed gate, but never committed evidence", () => {
  withStore("reprepare", ({ store }) => {
    const kept = store.update((state) => ({ ...state,
      providerStages: { openai: stage({ gate: gate({ resetCount: 1 }) }) } }));
    assert.equal(kept.providerStages.openai.status, "prepared");
    assert.equal(kept.providerStages.openai.gate.resetCount, 1);
    assertRefused(store, (state) => ({ ...state, providerStages: { openai: stage({ committed: committed() }) } }),
      /providerStages\.openai status prepared cannot carry committed evidence/);
  });
});

test("provider stages enforce exact shapes and status consistency", () => {
  withStore("stages", ({ store }) => {
    const cases = [
      [{ OpenAI: stage() }, /providerStages key OpenAI is not a valid provider ID/],
      [{ openai: stage({ status: "paused" }) }, /providerStages\.openai status paused is invalid/],
      [{ openai: stage({ prepared: prepared({ allowlist: ["anthropic"] }) }) }, /providerStages\.openai\.prepared\.allowlist must include openai/],
      [{ openai: stage({ prepared: prepared({ allowlist: ["openai", "openai"] }) }) }, /providerStages\.openai\.prepared\.allowlist has duplicate provider IDs/],
      [{ openai: stage({ prepared: prepared({ ledgerRevision: 99 }) }) }, /providerStages\.openai\.prepared\.ledgerRevision 99 is ahead of ledger revision 1/],
      [{ openai: stage({ prepared: prepared({ policyIntentHash: "nope" }) }) }, /providerStages\.openai\.prepared\.policyIntentHash must be a lowercase 64-hex SHA-256/],
      [{ openai: stage({ committed: committed(), checkpoint: checkpoint() }) }, /providerStages\.openai status prepared cannot carry committed evidence/],
      [{ openai: stage({ status: "committed", committed: committed() }) }, /providerStages\.openai status committed requires committed and checkpoint/],
      [{ openai: stage({ status: "committed", checkpoint: checkpoint() }) }, /providerStages\.openai status committed requires committed and checkpoint/],
      [{ openai: stage({ status: "committed", checkpoint: checkpoint(), committed: committed({ generationAck: { generation: 2, manifestHash: hash("7"), effectiveHash: hash("5") } }) }) }, /providerStages\.openai\.committed\.generationAck does not match committed generation 1/],
      [{ openai: stage({ status: "committed", committed: committed(), checkpoint: checkpoint({ brokerPolicyRevision: "" }) }) }, /providerStages\.openai\.checkpoint\.brokerPolicyRevision must be null, a non-negative integer or a non-empty string/],
      [{ openai: stage({ status: "gate-running", committed: committed(), checkpoint: checkpoint() }) }, /providerStages\.openai status gate-running requires a started, uncompleted gate/],
      [{ openai: stage({ status: "gate-running", committed: committed(), checkpoint: checkpoint(), gate: gate({ completedAt: DAY_LATER }) }) }, /providerStages\.openai status gate-running requires a started, uncompleted gate/],
      [{ openai: stage({ status: "gate-running", committed: committed(), checkpoint: checkpoint(), gate: gate({ scheduledRunIDs: ["run-1", "run-1"] }) }) }, /providerStages\.openai\.gate\.scheduledRunIDs has duplicate run IDs/],
      [{ openai: stage({ status: "healthy", committed: committed(), checkpoint: checkpoint(), gate: gate() }) }, /providerStages\.openai status healthy requires a completed gate/],
      [{ openai: stage({ status: "healthy", committed: committed(), checkpoint: checkpoint(), gate: gate({ completedAt: AT }) }) }, /providerStages\.openai\.gate\.completedAt precedes gate\.startedAt/],
    ];
    for (const [providerStages, pattern] of cases) {
      assertRefused(store, (state) => ({ ...state, providerStages }), pattern);
    }
    store.update((state) => ({ ...state, providerStages: { openai: stage() } }));
    store.update((state) => ({ ...state, providerStages: { openai: stage({ status: "committed", committed: committed(), checkpoint: checkpoint() }) } }));
    store.update((state) => ({ ...state, providerStages: { openai: stage({ status: "gate-running", committed: committed(), checkpoint: checkpoint(), gate: gate() }) } }));
    const healthy = store.update((state) => ({
      ...state,
      providerStages: { openai: stage({ status: "healthy", committed: committed(), checkpoint: checkpoint(), gate: gate({ completedAt: DAY_LATER, scheduledRunIDs: ["run-1"] }) }) },
    }));
    assert.equal(healthy.providerStages.openai.status, "healthy");
    const failed = store.update((state) => ({ ...state, providerStages: { ...state.providerStages, anthropic: stage({ status: "failed", prepared: prepared({ allowlist: ["openai", "anthropic"] }) }) } }));
    assert.equal(failed.providerStages.anthropic.status, "failed");
  });
});

test("scheduled runs keep only the newest fifty and reject malformed entries", () => {
  withStore("runs", ({ store }) => {
    assert.equal(SCHEDULED_RUNS_LIMIT, 50);
    const input = Object.freeze([scheduledRun(0)]);
    assert.equal(appendScheduledRun(input, scheduledRun(1)).length, 2);
    assert.equal(input.length, 1, "appendScheduledRun must not mutate its input");
    let runs = [];
    for (let index = 0; index < 55; index += 1) runs = appendScheduledRun(runs, scheduledRun(index));
    assert.equal(runs.length, 50);
    assert.equal(runs[0].id, "run-5");
    assert.equal(runs.at(-1).id, "run-54");
    assert.equal(store.update((state) => ({ ...state, scheduledRuns: runs })).scheduledRuns.length, 50);
    const cases = [
      [(state) => [...state.scheduledRuns, scheduledRun(99)], /scheduledRuns holds 51 entries; the limit is 50/],
      [() => [scheduledRun(1), scheduledRun(1)], /scheduledRuns has duplicate id run-1/],
      [() => [scheduledRun(1, { mode: "live" })], /scheduledRuns\[0\]\.mode live is invalid/],
      [() => [scheduledRun(1, { endedAt: null })], /scheduledRuns\[0\]\.endedAt and exitCode must both be null or both be set/],
      [() => [scheduledRun(1, { exitCode: 256 })], /scheduledRuns\[0\]\.exitCode must be an integer from 0 to 255/],
      [() => [scheduledRun(1, { ledgerRevision: 99 })], /scheduledRuns\[0\]\.ledgerRevision 99 is ahead of ledger revision 2/],
      [() => [scheduledRun(1, { providers: ["openai", "openai"] })], /scheduledRuns\[0\]\.providers has duplicate provider IDs/],
    ];
    for (const [build, pattern] of cases) {
      assertRefused(store, (state) => ({ ...state, scheduledRuns: build(state) }), pattern);
    }
    // A run still in flight has neither an end nor an exit code.
    const inFlight = store.update((state) => ({
      ...state, scheduledRuns: appendScheduledRun(state.scheduledRuns, scheduledRun(60, { endedAt: null, exitCode: null })),
    }));
    assert.equal(inFlight.scheduledRuns.at(-1).id, "run-60");
    assert.equal(inFlight.scheduledRuns.length, 50);
  });
});

test("config targets default to the store root and the raw base, with an env override for tests", () => {
  const saved = process.env.OPENCODE_RECONCILE_RAW_BASE;
  try {
    delete process.env.OPENCODE_RECONCILE_RAW_BASE;
    assert.equal(DEFAULT_RAW_BASE_PATH, "/home/dev/devbox/config/opencode/opencode.json");
    assert.deepEqual(createReconciliationStore().configTargets(), {
      generated: join(routingStateDir(), "resolver-generations", "current", "opencode.json"),
      rawEmergency: DEFAULT_RAW_BASE_PATH,
    });
    process.env.OPENCODE_RECONCILE_RAW_BASE = "/tmp/fixture-raw-base.json";
    assert.equal(createReconciliationStore({ root: "/tmp/fixture-root" }).configTargets().rawEmergency, "/tmp/fixture-raw-base.json");
    assert.throws(() => createReconciliationStore({ configTargets: { rawEmergency: "relative.json" } }),
      /config target rawEmergency must be an absolute path/);
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_RECONCILE_RAW_BASE;
    else process.env.OPENCODE_RECONCILE_RAW_BASE = saved;
  }
});
