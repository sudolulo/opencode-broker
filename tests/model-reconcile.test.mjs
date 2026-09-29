import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the config loader at the fleet-shaped fixture BEFORE lib/routing.js loads through
// lib/model-reconcile.js -- config.js reads its file once at import time.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const {
  candidateTransitionID,
  classifyDryRunCandidate,
  formatDryRunReport,
  formatReconciliationStatus,
  readReconciliationStatus,
  runDryReconciliation,
  selectUpgradeCandidates,
} = await import(new URL("../lib/model-reconcile.js", import.meta.url).href);

const { normalizeModelRoles } = await import(new URL("../lib/model-roles.js", import.meta.url).href);
const { normalizeCatalogCandidates } = await import(new URL("../lib/model-candidates.js", import.meta.url).href);
const { createReconciliationStore, emptyReconciliationState } =
  await import(new URL("../lib/reconcile-state.js", import.meta.url).href);

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;

test("model reconciliation imports no inventory publication primitive", () => {
  const source = readFileSync(new URL("../lib/model-reconcile.js", import.meta.url), "utf8");
  const routingImport = source.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/routing\.js";/);
  assert.ok(routingImport, "model reconciliation must keep an explicit routing import boundary");
  assert.doesNotMatch(routingImport[1], /\bpublish(?:CachedSubscription|Auth)Inventory\b/,
    "reconciliation is dry-run only and must not acquire an inventory publication capability");
});

// Two roles under the SAME provider whose family list and id matchers disagree about the model
// id "conflict": the family says alpha, the id shape says beta. Whichever matcher "wins" would
// put a real model in the wrong lane, so the reconciler has to block instead.
const TEST_ROLES = normalizeModelRoles({
  "example:alpha": {
    families: ["example-alpha"], idPatterns: [{ prefix: "alpha-", suffix: "" }],
    tiers: ["smart"], rank: 2, requiredCapabilities: { toolCall: true },
    evidenceDomains: ["example.com"],
  },
  "example:beta": {
    families: ["example-beta"], idPatterns: [{ prefix: "", suffix: "conflict" }],
    tiers: ["worker"], rank: 1, requiredCapabilities: { toolCall: true },
    evidenceDomains: ["example.com"],
  },
}, { warn: () => {} });

const STATIC_TARGETS = Object.freeze({
  sol: { id: "sol", providerID: "openai", modelID: "gpt-5.6-sol", tiers: ["smart"] },
  opus: { id: "opus", providerID: "anthropic", modelID: "claude-opus-5", tiers: ["build", "smart"] },
});

// The September 2026 catalog shape the design names: GPT-6 Sol and Luna exist, Terra does not,
// Anthropic moves Opus 5 -> 5.5, and one provider ships an unmapped role plus a contradictory one.
const CATALOG = Object.freeze({
  openai: {
    id: "openai",
    models: {
      "gpt-5.6-sol": { id: "gpt-5.6-sol", family: "gpt-sol", release_date: "2026-02-10", status: "active", tool_call: true, limit: { context: 400_000, output: 128_000 } },
      "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", status: "active", tool_call: true, limit: { context: 1_050_000, output: 128_000 } },
      "gpt-5.6-luna": { id: "gpt-5.6-luna", family: "gpt-luna", release_date: "2026-02-10", status: "active", tool_call: true },
      "gpt-6-luna": { id: "gpt-6-luna", family: "gpt-luna", release_date: "2026-09-20", status: "active", tool_call: true },
    },
  },
  anthropic: {
    id: "anthropic",
    models: {
      "claude-opus-5": { id: "claude-opus-5", family: "claude-opus", release_date: "2026-08-20", status: "active", tool_call: true },
      "claude-opus-5-5": { id: "claude-opus-5-5", family: "claude-opus", release_date: "2026-09-18", status: "active", tool_call: true },
    },
  },
  example: {
    id: "example",
    models: {
      "new-role": { id: "new-role", family: "example-gamma", release_date: "2026-09-01", status: "active", tool_call: true },
      conflict: { id: "conflict", family: "example-alpha", release_date: "2026-09-02", status: "active", tool_call: true },
    },
  },
});

// GPT-6 Luna is cataloged but the host's resolver does not expose it -- the live condition the
// design calls out, and the one that must read as blocked-unresolvable rather than as a target.
const RESOLVER_KEYS = Object.freeze([
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5-5",
  "example/conflict",
  "example/new-role",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-6-sol",
]);

// `data`/`resolverKeys` supply the observation; `catalog`/`resolver` override the collector's own
// freshness fields, which is how a stale or failed refresh is expressed without a subprocess.
const sources = ({ data = CATALOG, resolverKeys = RESOLVER_KEYS, catalog = {}, resolver = {} } = {}) => Object.freeze({
  catalog: Object.freeze({
    refreshed: true, source: "scratch", path: null, error: null,
    updatedAt: NOW - HOUR, ageMs: HOUR, stale: false, empty: !Object.keys(data).length,
    data,
    ...catalog,
  }),
  resolver: Object.freeze({
    refreshed: true, source: "scratch", path: null, error: null,
    updatedAt: NOW, ageMs: 0, stale: false, empty: !resolverKeys.length,
    models: new Set(resolverKeys),
    ...resolver,
  }),
});

const AUTH = Object.freeze({ revision: "same", types: Object.freeze({ openai: "oauth", anthropic: "oauth", example: "oauth" }) });

// A stubbed authSnapshot() that answers each call in turn and then repeats its last answer.
const sequence = (...values) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

const withStore = (name, run) => {
  const base = mkdtempSync(join(tmpdir(), `model-reconcile-${name}-`));
  try {
    const root = join(base, "model-routing");
    return run({
      base,
      root,
      store: createReconciliationStore({ root, now: () => NOW }),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

const dryRun = (options = {}) => runDryReconciliation({
  modelRoles: TEST_ROLES,
  staticTargets: STATIC_TARGETS,
  authSnapshot: sequence(AUTH, AUTH),
  collectSources: () => sources(),
  now: () => NOW,
  ...options,
});

const states = (report) => Object.fromEntries(
  Object.entries(report.byModel).map(([key, entry]) => [key, entry.state]));

const skipReason = (report, providerID, modelID) =>
  report.skipped.find((entry) => entry.providerID === providerID && entry.modelID === modelID)?.reason ?? null;

// ---- the release scenario ------------------------------------------------------------------

test("records known successors, unknown roles, conflicts, and unresolved models without publishing", () => {
  withStore("release", ({ store }) => {
    const report = dryRun({ store });

    assert.equal(report.dryRun, true);
    assert.deepEqual(report.effects, {
      ledgerWritten: true,
      inventoryPublished: false,
      routingMutated: false,
      externalPublished: false,
    });
    assert.equal(report.byModel["openai/gpt-6-sol"].state, "evidence-pending");
    assert.equal(report.byModel["anthropic/claude-opus-5-5"].state, "evidence-pending");
    assert.equal(report.byModel["openai/gpt-6-luna"].state, "blocked-unresolvable");
    assert.equal(report.byModel["example/new-role"].state, "evidence-pending");
    assert.equal(report.byModel["example/conflict"].state, "blocked-conflict");
    assert.deepEqual(report.counts, {
      "blocked-conflict": 1, "blocked-unresolvable": 1, "evidence-pending": 3,
    });

    // The role's own successor, not somebody else's model.
    assert.equal(report.byModel["openai/gpt-6-sol"].roleKey, "openai:gpt-sol");
    assert.equal(report.byModel["openai/gpt-6-sol"].incumbentModelID, "gpt-5.6-sol");
    assert.equal(report.byModel["example/new-role"].roleKey, null);
    assert.deepEqual(report.byModel["example/conflict"].roleMatches, ["example:alpha", "example:beta"]);

    const ledger = store.read();
    assert.deepEqual(Object.keys(ledger.roles).sort(),
      ["anthropic:claude-opus", "openai:gpt-luna", "openai:gpt-sol"]);
    assert.equal(Object.keys(ledger.unknown).length, 2);
    assert.equal(Object.keys(ledger.evidenceRequests).length, 3);
    assert.deepEqual(report.evidenceRequests, { pending: 3, claimed: 0, failed: 0 });
  });
});

// CRITICAL: A PROPOSED INVENTORY IS NOT A PUBLISHED ONE. Discovery maps a family to tiers from the
// family table alone, so the contradictory model DOES appear as a proposed target while the
// reconciler blocks it -- which is exactly why Package 1 computes the inventory and never posts it.
test("the proposed inventory is computed and withheld, never published", () => {
  withStore("proposed", ({ store }) => {
    const report = dryRun({ store });
    const proposed = Object.values(report.proposedTargets)
      .map((target) => `${target.providerID}/${target.modelID}`).sort();
    assert.ok(proposed.includes("openai/gpt-6-sol"), proposed.join(", "));
    assert.ok(proposed.includes("anthropic/claude-opus-5-5"), proposed.join(", "));
    assert.ok(proposed.includes("example/conflict"), proposed.join(", "));
    assert.equal(report.effects.inventoryPublished, false);
    // The unresolvable model is dropped by the same admission gate discovery already applies.
    assert.deepEqual(report.admissionSkipped
      .filter((entry) => entry.modelID === "gpt-6-luna")
      .map((entry) => entry.reason), ["unresolvable"]);
    assert.equal(proposed.includes("openai/gpt-6-luna"), false);
  });
});

test("the report and every branch of it is frozen and carries no publisher surface", () => {
  withStore("frozen", ({ store }) => {
    const report = dryRun({ store });
    assert.deepEqual(Object.keys(report).sort(), [
      "admissionSkipped", "authRevisionChanged", "byModel", "counts", "dryRun", "effects",
      "evidenceRequests", "incumbents", "ledger", "legacyMigration", "observedAt", "proposedTargets",
      "providerIDs", "skipped", "sources", "superseded",
    ]);
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.superseded), true);
    assert.deepEqual(report.superseded, []);
    assert.equal(Object.isFrozen(report.byModel), true);
    assert.equal(Object.isFrozen(report.byModel["openai/gpt-6-sol"]), true);
    assert.equal(Object.isFrozen(report.effects), true);
    assert.equal(Object.isFrozen(report.skipped), true);
    assert.equal(Object.isFrozen(report.legacyMigration.importKeys), true);
  });
});

test("auth is snapshotted on both sides of collection, and the lock is not held across it", () => {
  withStore("ordering", ({ store }) => {
    const order = [];
    dryRun({
      store,
      authSnapshot: () => { order.push("auth"); return AUTH; },
      collectSources: () => {
        order.push("collect");
        // The refresh subprocesses run outside the writer lock: holding it across a 3s
        // `opencode models --pure` would serialize every reconciler on the slowest source.
        assert.equal(existsSync(store.paths().lock), false);
        return sources();
      },
    });
    assert.deepEqual(order, ["auth", "collect", "auth"]);
  });
});

// ---- admission: what may never become a proposed target -------------------------------------

test("api-key, unknown-auth, inactive, non-tool, malformed-id and fast models are never candidates", () => {
  withStore("admission", ({ store }) => {
    const catalog = {
      ...CATALOG,
      openai: {
        id: "openai",
        models: {
          ...CATALOG.openai.models,
          // Each of these is NEWER than gpt-6-sol, so a missing gate shows up as a stolen role.
          "gpt-7-sol": { id: "gpt-7-sol", family: "gpt-sol", release_date: "2026-10-01", status: "deprecated", tool_call: true },
          "gpt-8-sol": { id: "gpt-8-sol", family: "gpt-sol", release_date: "2026-10-02", tool_call: false },
          "gpt 9/sol": { id: "gpt 9/sol", family: "gpt-sol", release_date: "2026-10-03", tool_call: true },
          "gpt-6-sol-fast": { id: "gpt-6-sol-fast", family: "gpt-sol", release_date: "2026-10-04", tool_call: true },
        },
      },
      metered: { id: "metered", models: { "metered-1": { id: "metered-1", family: "gpt-sol", release_date: "2026-10-05", tool_call: true } } },
      mystery: { id: "mystery", models: { "mystery-1": { id: "mystery-1", family: "gpt-sol", release_date: "2026-10-06", tool_call: true } } },
    };
    const report = dryRun({
      store,
      // metered proves API-key auth; mystery has no entry at all, which is unknown auth.
      authSnapshot: () => ({ revision: "same", types: { ...AUTH.types, metered: "api" } }),
      collectSources: () => sources({
        data: catalog,
        resolverKeys: [...RESOLVER_KEYS, "openai/gpt-7-sol", "openai/gpt-8-sol", "openai/gpt-6-sol-fast",
          "metered/metered-1", "mystery/mystery-1"],
      }),
    });

    assert.deepEqual(report.providerIDs, ["anthropic", "example", "openai"]);
    // The role still goes to the only admissible successor.
    assert.equal(report.byModel["openai/gpt-6-sol"].state, "evidence-pending");
    for (const key of ["openai/gpt-7-sol", "openai/gpt-8-sol", "openai/gpt 9/sol",
      "openai/gpt-6-sol-fast", "metered/metered-1", "mystery/mystery-1"]) {
      assert.equal(key in report.byModel, false, `${key} became a candidate`);
    }
    assert.equal(skipReason(report, "openai", "gpt-7-sol"), "inactive");
    assert.equal(skipReason(report, "openai", "gpt-8-sol"), "tool-call-unsupported");
    assert.equal(skipReason(report, "openai", "gpt 9/sol"), "invalid-model-id");
    assert.equal(skipReason(report, "openai", "gpt-6-sol-fast"), "speed-variant");
    // A quarantined provider produces no candidate AND no skip: it was never observed at all.
    assert.equal(skipReason(report, "metered", "metered-1"), null);
    assert.equal(skipReason(report, "mystery", "mystery-1"), null);
    const proposed = Object.values(report.proposedTargets).map((target) => target.modelID);
    for (const modelID of ["gpt-7-sol", "gpt-8-sol", "gpt 9/sol", "gpt-6-sol-fast", "metered-1", "mystery-1"]) {
      assert.equal(proposed.includes(modelID), false, `${modelID} reached the proposed inventory`);
    }
  });
});

// CRITICAL: the registry knows an `openai:gpt-terra` role, and a catalog carrying Sol and Luna is
// NOT evidence that a gpt-6-terra shipped. Minting one would produce a build-tier target whose
// every lease dies with ProviderModelNotFoundError.
test("an absent role sibling is never synthesized into a candidate or a ledger record", () => {
  withStore("terra", ({ store }) => {
    const report = dryRun({ store });
    assert.deepEqual(Object.keys(report.byModel).filter((key) => key.includes("terra")), []);
    assert.equal(store.read().roles["openai:gpt-terra"], undefined);
    assert.equal(report.incumbents["openai:gpt-terra"], undefined);
  });
});

// ---- classification ------------------------------------------------------------------------

const CLEAN_STATUS = Object.freeze({
  catalogStale: false, resolverStale: false, catalogError: null, resolverError: null,
  catalogEmpty: false, resolverEmpty: false, authRevisionChanged: false,
});
const KNOWN = Object.freeze({ roleStatus: "known", resolvable: true });

test("classification follows stale, then conflict, then resolver, and reads no global state", () => {
  assert.equal(classifyDryRunCandidate(KNOWN, CLEAN_STATUS), "evidence-pending");
  assert.equal(classifyDryRunCandidate({ ...KNOWN, resolvable: false }, CLEAN_STATUS), "blocked-unresolvable");
  // An absent resolver view is unknown, and unknown is never admitted.
  assert.equal(classifyDryRunCandidate({ ...KNOWN, resolvable: null }, CLEAN_STATUS), "blocked-unresolvable");
  assert.equal(classifyDryRunCandidate({ roleStatus: "unknown", resolvable: true }, CLEAN_STATUS), "evidence-pending");
  assert.equal(classifyDryRunCandidate({ roleStatus: "conflict", resolvable: true }, CLEAN_STATUS), "blocked-conflict");
  assert.equal(classifyDryRunCandidate(KNOWN, { ...CLEAN_STATUS, authRevisionChanged: true }), "blocked-conflict");
  // Stale outranks both: a run that cannot certify its inputs has nothing to say about the model.
  for (const field of ["catalogStale", "resolverStale", "catalogEmpty", "resolverEmpty"]) {
    assert.equal(classifyDryRunCandidate({ roleStatus: "conflict", resolvable: false },
      { ...CLEAN_STATUS, [field]: true, authRevisionChanged: true }), "blocked-stale", field);
  }
  for (const field of ["catalogError", "resolverError"]) {
    assert.equal(classifyDryRunCandidate(KNOWN, { ...CLEAN_STATUS, [field]: "opencode: not found" }),
      "blocked-stale", field);
  }
});

test("a stale or failed refresh blocks every otherwise valid candidate as blocked-stale", () => {
  withStore("stale", ({ store }) => {
    const stale = dryRun({
      store,
      collectSources: () => sources({ resolver: { stale: true, ageMs: 73 * HOUR } }),
    });
    assert.deepEqual(new Set(Object.values(states(stale))), new Set(["blocked-stale"]));
    assert.equal(stale.sources.resolver.stale, true);

    const failed = dryRun({
      store,
      collectSources: () => sources({ catalog: { error: "opencode models: not found", refreshed: false, source: "live" } }),
    });
    assert.deepEqual(new Set(Object.values(states(failed))), new Set(["blocked-stale"]));
    assert.equal(failed.sources.catalog.error, "opencode models: not found");
  });
});

test("an auth revision change blocks the whole run as blocked-conflict", () => {
  withStore("rotated", ({ store }) => {
    const report = dryRun({
      store,
      authSnapshot: sequence(AUTH, { revision: "rotated", types: AUTH.types }),
    });
    assert.equal(report.authRevisionChanged, true);
    assert.deepEqual(new Set(Object.values(states(report))), new Set(["blocked-conflict"]));
    assert.equal(Object.values(states(report)).includes("evidence-pending"), false);
  });
});

test("an unreadable auth store is treated as a changed revision rather than as agreement", () => {
  withStore("no-auth", ({ store }) => {
    const report = dryRun({ store, authSnapshot: () => ({ revision: null, types: AUTH.types }) });
    assert.equal(report.authRevisionChanged, true);
  });
});

// ---- selection -----------------------------------------------------------------------------

const candidatesFor = (catalog, resolverKeys = RESOLVER_KEYS, providerIDs = ["anthropic", "example", "openai"]) =>
  normalizeCatalogCandidates(catalog, { providerIDs, roles: TEST_ROLES, resolvableModels: new Set(resolverKeys) });

test("a configured model is an incumbent, not an upgrade candidate", () => {
  withStore("incumbent", ({ store }) => {
    const report = dryRun({ store });
    assert.deepEqual(report.incumbents["openai:gpt-sol"], {
      roleKey: "openai:gpt-sol", providerID: "openai", roleID: "gpt-sol",
      modelID: "gpt-5.6-sol", releaseDate: "2026-02-10", modelIDs: ["gpt-5.6-sol"],
    });
    assert.equal(report.incumbents["anthropic:claude-opus"].modelID, "claude-opus-5");
    assert.equal("openai/gpt-5.6-sol" in report.byModel, false);
    assert.equal("anthropic/claude-opus-5" in report.byModel, false);
    assert.equal(skipReason(report, "openai", "gpt-5.6-sol"), "incumbent");
    assert.equal(skipReason(report, "anthropic", "claude-opus-5"), "incumbent");
  });
});

test("only the newest candidate per role survives, release date first and model id second", () => {
  const selection = selectUpgradeCandidates(candidatesFor(CATALOG), STATIC_TARGETS, { roles: TEST_ROLES });
  assert.deepEqual(selection.roles.map((entry) => `${entry.roleKey}=${entry.candidate.modelID}`).sort(), [
    "anthropic:claude-opus=claude-opus-5-5",
    "openai:gpt-luna=gpt-6-luna",
    "openai:gpt-sol=gpt-6-sol",
  ]);
  assert.equal(selection.skipped.find((entry) => entry.modelID === "gpt-5.6-luna").reason, "not-newest-in-role");

  // Same family, same release date: the model id breaks the tie, descending.
  const tied = {
    openai: {
      id: "openai",
      models: {
        "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", tool_call: true },
        "gpt-6-sol-b": { id: "gpt-6-sol-b", family: "gpt-sol", release_date: "2026-09-22", tool_call: true },
      },
    },
  };
  const tieBreak = selectUpgradeCandidates(
    candidatesFor(tied, ["openai/gpt-6-sol", "openai/gpt-6-sol-b"], ["openai"]), {}, { roles: TEST_ROLES });
  assert.deepEqual(tieBreak.roles.map((entry) => entry.candidate.modelID), ["gpt-6-sol-b"]);
});

// A release date is the ordering key, so a known-role model without one cannot be ranked against
// its incumbent and is reported rather than guessed into the lane. Discovery drops it too.
test("a known-role candidate with no usable release date is skipped, an unknown one is not", () => {
  const catalog = {
    openai: { id: "openai", models: { "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-13-01", tool_call: true } } },
    example: { id: "example", models: { "new-role": { id: "new-role", family: "example-gamma", tool_call: true } } },
  };
  const selection = selectUpgradeCandidates(
    candidatesFor(catalog, ["openai/gpt-6-sol", "example/new-role"], ["example", "openai"]), {}, { roles: TEST_ROLES });
  assert.deepEqual(selection.roles, []);
  assert.equal(selection.skipped.find((entry) => entry.modelID === "gpt-6-sol").reason, "no-release-date");
  assert.deepEqual(selection.unknown.map((entry) => entry.candidate.modelID), ["new-role"]);
});

test("a candidate no newer than its incumbent is not an upgrade", () => {
  const catalog = {
    openai: {
      id: "openai",
      models: {
        "gpt-5.6-sol": { id: "gpt-5.6-sol", family: "gpt-sol", release_date: "2026-02-10", tool_call: true },
        "gpt-5.5-sol": { id: "gpt-5.5-sol", family: "gpt-sol", release_date: "2025-11-01", tool_call: true },
      },
    },
  };
  const selection = selectUpgradeCandidates(
    candidatesFor(catalog, ["openai/gpt-5.6-sol", "openai/gpt-5.5-sol"], ["openai"]),
    STATIC_TARGETS, { roles: TEST_ROLES });
  assert.deepEqual(selection.roles, []);
  assert.equal(selection.skipped.find((entry) => entry.modelID === "gpt-5.5-sol").reason,
    "not-newer-than-incumbent");
});

test("unknown models group by provider and family, or by exact model id when family is absent", () => {
  const catalog = {
    example: {
      id: "example",
      models: {
        "new-role": { id: "new-role", family: "example-gamma", release_date: "2026-09-01", tool_call: true },
        "new-role-2": { id: "new-role-2", family: "example-gamma", release_date: "2026-09-05", tool_call: true },
        solo: { id: "solo", release_date: "2026-09-03", tool_call: true },
        conflict: { id: "conflict", family: "example-alpha", release_date: "2026-09-02", tool_call: true },
      },
    },
  };
  const selection = selectUpgradeCandidates(candidatesFor(catalog,
    ["example/new-role", "example/new-role-2", "example/solo", "example/conflict"], ["example"]),
  {}, { roles: TEST_ROLES });
  assert.deepEqual(selection.unknown.map((entry) => `${entry.groupKey}=${entry.candidate.modelID}`).sort(), [
    "example:example-alpha=conflict",
    "example:example-gamma=new-role-2",
    "example:solo=solo",
  ]);
  assert.equal(selection.skipped.find((entry) => entry.modelID === "new-role").reason, "not-newest-in-group");
  // A conflict keeps both role keys so Package 2 can collect evidence about the disagreement.
  assert.deepEqual(selection.unknown.find((entry) => entry.candidate.modelID === "conflict").candidate.roleMatches,
    ["example:alpha", "example:beta"]);
});

// ---- transition IDs ------------------------------------------------------------------------

test("a transition id is 24 hex characters over provider, group, model and release date", () => {
  const candidate = {
    providerID: "openai", modelID: "gpt-6-sol", family: "gpt-sol",
    roleKey: "openai:gpt-sol", releaseDate: "2026-09-22",
  };
  const id = candidateTransitionID(candidate);
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(candidateTransitionID({ ...candidate }), id);
  assert.notEqual(candidateTransitionID({ ...candidate, releaseDate: "2026-09-23" }), id);
  assert.notEqual(candidateTransitionID({ ...candidate, modelID: "gpt-6-sol-b" }), id);
  assert.notEqual(candidateTransitionID({ ...candidate, roleKey: "openai:gpt-terra" }), id);
  // An unknown role is grouped by provider and family, and by the model id when family is absent.
  const unknown = { providerID: "example", modelID: "new-role", family: "example-gamma", roleKey: null, releaseDate: null };
  assert.match(candidateTransitionID(unknown), /^[0-9a-f]{24}$/);
  assert.notEqual(candidateTransitionID({ ...unknown, family: null }), candidateTransitionID(unknown));
});

// ---- idempotence and preserved decisions ---------------------------------------------------

test("an unchanged second run keeps the transition id and the state-change timestamp", () => {
  withStore("idempotent", ({ root }) => {
    const first = dryRun({ store: createReconciliationStore({ root, now: () => NOW }) });
    const later = NOW + 6 * HOUR;
    const second = dryRun({
      store: createReconciliationStore({ root, now: () => later }),
      now: () => later,
    });

    for (const key of Object.keys(first.byModel)) {
      assert.equal(second.byModel[key].transitionID, first.byModel[key].transitionID, key);
      assert.equal(second.byModel[key].stateChangedAt, first.byModel[key].stateChangedAt, key);
      assert.equal(second.byModel[key].state, first.byModel[key].state, key);
      assert.equal(second.byModel[key].lastObservedAt, later, key);
      assert.equal(first.byModel[key].lastObservedAt, NOW, key);
    }
    const ledger = createReconciliationStore({ root }).read();
    assert.deepEqual(ledger.roles["openai:gpt-sol"].transitions, ["discovered", "evidence-pending"]);
    assert.equal(ledger.roles["openai:gpt-sol"].stateChangedAt, NOW);
    assert.equal(ledger.roles["openai:gpt-sol"].lastObservedAt, later);
  });
});

test("a new record's history opens with discovered and then its computed state", () => {
  withStore("history", ({ store }) => {
    dryRun({ store });
    const ledger = store.read();
    assert.deepEqual(ledger.roles["openai:gpt-luna"].transitions, ["discovered", "blocked-unresolvable"]);
    const conflict = Object.values(ledger.unknown).find((record) => record.modelID === "conflict");
    assert.deepEqual(conflict.transitions, ["discovered", "blocked-conflict"]);
    assert.deepEqual(conflict.roleMatches, ["example:alpha", "example:beta"]);
  });
});

test("a changed candidate for the same role moves the state-change timestamp", () => {
  withStore("moved", ({ root }) => {
    dryRun({ store: createReconciliationStore({ root, now: () => NOW }) });
    const later = NOW + 12 * HOUR;
    const catalog = {
      ...CATALOG,
      openai: {
        id: "openai",
        models: {
          ...CATALOG.openai.models,
          "gpt-6-1-sol": { id: "gpt-6-1-sol", family: "gpt-sol", release_date: "2026-10-05", status: "active", tool_call: true },
        },
      },
    };
    const report = dryRun({
      store: createReconciliationStore({ root, now: () => later }),
      now: () => later,
      collectSources: () => sources({ data: catalog, resolverKeys: [...RESOLVER_KEYS, "openai/gpt-6-1-sol"] }),
    });
    assert.equal(report.byModel["openai/gpt-6-1-sol"].state, "evidence-pending");
    assert.equal(report.byModel["openai/gpt-6-1-sol"].stateChangedAt, later);
    const record = createReconciliationStore({ root }).read().roles["openai:gpt-sol"];
    assert.equal(record.candidateModelID, "gpt-6-1-sol");
    assert.equal(record.stateChangedAt, later);
  });
});

// CRITICAL: a rejection and a rollback are POLICY DECISIONS. A dry run that overwrote them would
// let a rejected model re-enter the workflow simply for still being the newest in its family.
test("a rejected, rolled-back or decided record is observed but never rewritten", () => {
  for (const seeded of [
    { state: "rejected", approval: { decision: "rejected", source: "gitea#12", at: "2026-09-01" } },
    { state: "rolled-back", approval: null },
    { state: "evidence-pending", approval: { decision: "approved", source: "skill", at: "2026-09-02" } },
  ]) {
    withStore(`decided-${seeded.state}`, ({ root }) => {
      const seedStore = createReconciliationStore({ root, now: () => NOW });
      seedStore.update((state) => ({
        ...state,
        roles: {
          "openai:gpt-sol": {
            transitionID: "seededtransition00000000",
            roleKey: "openai:gpt-sol", providerID: "openai", roleID: "gpt-sol",
            candidateModelID: "gpt-6-sol", candidateFamily: "gpt-sol",
            candidateReleaseDate: "2026-09-22", candidateVersion: "6",
            incumbentModelID: "gpt-5.6-sol",
            proposedTiers: ["smart"], proposedFit: {},
            state: seeded.state, reason: "seeded",
            stateChangedAt: NOW - 48 * HOUR, lastObservedAt: NOW - 48 * HOUR,
            transitions: ["discovered", "evidence-pending", seeded.state],
            evidence: [{ sourceURL: "https://openai.com/x", exactQuote: "successor" }],
            approval: seeded.approval,
            issue: { number: 12, url: "https://git.arch.fyi/opencode/opencode-broker/issues/12" },
            notified: { blocked: "2026-09-01" },
          },
        },
      }));
      const before = seedStore.read().roles["openai:gpt-sol"];

      const later = NOW + HOUR;
      const report = dryRun({ store: createReconciliationStore({ root, now: () => later }), now: () => later });
      const after = createReconciliationStore({ root }).read().roles["openai:gpt-sol"];

      assert.deepEqual({ ...after, lastObservedAt: before.lastObservedAt }, before);
      assert.equal(after.lastObservedAt, later);
      assert.equal(report.byModel["openai/gpt-6-sol"].state, seeded.state);
      assert.equal(report.byModel["openai/gpt-6-sol"].preserved, true);
      assert.equal(report.byModel["openai/gpt-6-sol"].transitionID, "seededtransition00000000");
    });
  }
});

// ---- legacy ledger preview -----------------------------------------------------------------

test("the legacy reviewed ledger is previewed, left on disk, and never imported", () => {
  withStore("legacy", ({ root, store }) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const reviewedPath = store.paths().reviewed;
    const bytes = JSON.stringify({ "openai/gpt-6-sol": "2026-09-22", "openai/never-seen": "2026-01-01" }) + "\n";
    writeFileSync(reviewedPath, bytes);

    const report = dryRun({ store });
    assert.deepEqual(report.legacyMigration, {
      importKeys: ["openai/never-seen"],
      existingKeys: ["openai/gpt-6-sol"],
    });
    assert.equal(readFileSync(reviewedPath, "utf8"), bytes);
    const ledger = store.read();
    const observed = [...Object.values(ledger.roles), ...Object.values(ledger.unknown)]
      .map((record) => `${record.providerID}/${record.modelID ?? record.candidateModelID}`);
    assert.equal(observed.includes("openai/never-seen"), false);
  });
});

test("a malformed legacy ledger fails loudly before anything is written", () => {
  withStore("legacy-bad", ({ root, store }) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(store.paths().reviewed, "{ truncated\n");
    assert.throws(() => dryRun({ store }), /not valid reviewed-models JSON/);
    assert.equal(readFileSync(store.paths().reviewed, "utf8"), "{ truncated\n");
    assert.equal(existsSync(store.paths().state), false);
    assert.equal(existsSync(store.paths().lock), false);
  });
});

// ---- status projection ---------------------------------------------------------------------

test("status for an absent ledger is explicitly absent and acquires no lock", () => {
  withStore("status-absent", ({ store }) => {
    assert.deepEqual(readReconciliationStatus(store), {
      exists: false, version: null, updatedAt: null, counts: {}, roles: [], unknown: [],
    });
    assert.equal(existsSync(store.paths().state), false);
    assert.equal(existsSync(store.paths().lock), false);
    assert.match(formatReconciliationStatus(readReconciliationStatus(store)), /no reconciliation state/);
  });
});

test("populated status is a sorted, bounded projection with no evidence or issue payload", () => {
  withStore("status", ({ store }) => {
    dryRun({ store });
    const status = readReconciliationStatus(store);
    assert.equal(status.exists, true);
    assert.equal(status.version, 1);
    assert.equal(status.updatedAt, NOW);
    assert.deepEqual(status.counts, {
      "blocked-conflict": 1, "blocked-unresolvable": 1, "evidence-pending": 3,
    });
    assert.deepEqual(status.roles.map((role) => role.roleKey),
      ["anthropic:claude-opus", "openai:gpt-luna", "openai:gpt-sol"]);
    assert.deepEqual(status.roles[2], {
      roleKey: "openai:gpt-sol", providerID: "openai", roleID: "gpt-sol",
      state: "evidence-pending", candidateModelID: "gpt-6-sol",
      stateChangedAt: NOW, lastObservedAt: NOW,
    });
    assert.deepEqual(status.unknown.map((entry) => entry.transitionID),
      [...status.unknown.map((entry) => entry.transitionID)].sort());
    for (const entry of status.unknown) {
      assert.deepEqual(Object.keys(entry).sort(),
        ["family", "lastObservedAt", "modelID", "providerID", "state", "stateChangedAt", "transitionID"]);
    }
    // Bounded: no raw evidence, approval, issue, notify or history field leaks into status.
    assert.deepEqual(Object.keys(status).sort(),
      ["counts", "exists", "roles", "unknown", "updatedAt", "version"]);
    for (const item of [...status.roles, ...status.unknown]) {
      for (const forbidden of ["evidence", "approval", "issue", "notified", "transitions",
        "proposedTiers", "proposedFit", "candidateFamily", "reason"]) {
        assert.equal(forbidden in item, false, forbidden);
      }
    }
    assert.match(formatReconciliationStatus(status), /openai:gpt-sol/);
    assert.match(formatReconciliationStatus(status), /evidence-pending 3/);
  });
});

// Absence is decided by the state FILE, not by what a read happens to return: an empty read and
// a missing ledger are different answers, and status has to be able to say "nothing yet".
test("status reports absent from the missing state file rather than from an empty read", () => {
  const status = readReconciliationStatus({
    paths: () => ({ state: join(tmpdir(), "definitely-absent-model-reconciliation.json") }),
    read: () => emptyReconciliationState(),
  });
  assert.deepEqual(status, { exists: false, version: null, updatedAt: null, counts: {}, roles: [], unknown: [] });
});

// ---- human formatter -----------------------------------------------------------------------

test("the human report names freshness, counts, every candidate, skips and the legacy preview", () => {
  withStore("format", ({ root, store }) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(store.paths().reviewed, JSON.stringify({ "openai/never-seen": "2026-01-01" }) + "\n");
    const text = formatDryRunReport(dryRun({ store }));
    assert.match(text, /^dry run: ledger written/m);
    assert.match(text, /inventory not published/);
    assert.match(text, /routing not mutated/);
    assert.match(text, /catalog: .*fresh/);
    assert.match(text, /resolver: .*fresh/);
    assert.match(text, /auth revision: unchanged/);
    assert.match(text, /evidence-pending 3/);
    // The two Package 2 additions an operator would otherwise only see with --json.
    assert.match(text, /evidence queue: \d+ pending, \d+ claimed, \d+ failed/);
    assert.match(text, /^superseded: none$/m);
    assert.match(text, /openai\/gpt-6-sol -> evidence-pending \(openai:gpt-sol\)/);
    assert.match(text, /openai\/gpt-6-luna -> blocked-unresolvable \(openai:gpt-luna\)/);
    assert.match(text, /example\/conflict -> blocked-conflict \(unknown example:example-alpha\)/);
    assert.match(text, /example\/new-role -> evidence-pending \(unknown example:example-gamma\)/);
    assert.match(text, /openai\/gpt-5\.6-sol: incumbent/);
    assert.match(text, /openai\/gpt-6-luna: unresolvable/);
    assert.match(text, /legacy reviewed-models import: 1 to import, 0 already covered/);
    assert.equal(text.endsWith("\n"), false);
  });
});
