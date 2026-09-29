import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route the config loader at the fleet-shaped fixture BEFORE lib/routing.js loads through
// lib/model-reconcile.js -- config.js reads its file once at import time.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const {
  POST_OBSERVATION_STATES,
  applyEvidenceClassification,
  candidateTransitionID,
  classifyEvidencedRecord,
  runDryReconciliation,
} = await import(new URL("../lib/model-reconcile.js", import.meta.url).href);

const { normalizeModelRoles } = await import(new URL("../lib/model-roles.js", import.meta.url).href);
const { candidateRevision, ingestEvidence } =
  await import(new URL("../lib/reconcile-evidence.js", import.meta.url).href);
const { createReconciliationStore, emptyReconciliationState } =
  await import(new URL("../lib/reconcile-state.js", import.meta.url).href);

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const RETRIEVED_AT = new Date(NOW - HOUR).toISOString();

// The product defaults are the registry under test: `openai:gpt-sol` is a known role whose
// evidence domains are openai.com and developers.openai.com.
const TEST_ROLES = normalizeModelRoles({}, { warn: () => {} });

const STATIC_TARGETS = Object.freeze({
  sol: { id: "sol", providerID: "openai", modelID: "gpt-5.6-sol", tiers: ["smart"] },
});

// One role, one incumbent, one successor: every `superseded` assertion below is then an exact
// list rather than a filtered one.
const CATALOG = Object.freeze({
  openai: {
    id: "openai",
    models: {
      "gpt-5.6-sol": { id: "gpt-5.6-sol", family: "gpt-sol", release_date: "2026-02-10", status: "active", tool_call: true },
      "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", status: "active", tool_call: true },
    },
  },
});

const CATALOG_WITH_GPT7_SOL = Object.freeze({
  openai: {
    id: "openai",
    models: {
      ...CATALOG.openai.models,
      "gpt-7-sol": { id: "gpt-7-sol", family: "gpt-sol", release_date: "2026-11-03", status: "active", tool_call: true },
    },
  },
});

const RESOLVER_KEYS = Object.freeze(["openai/gpt-5.6-sol", "openai/gpt-6-sol"]);
const AUTH = Object.freeze({ revision: "same", types: Object.freeze({ openai: "oauth" }) });

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

// The catalog the provider publishes after shipping a second successor for the same role.
const SOURCES_WITH_GPT7_SOL = sources({
  data: CATALOG_WITH_GPT7_SOL,
  resolverKeys: [...RESOLVER_KEYS, "openai/gpt-7-sol"],
});
// A healthy catalog that simply does not contain the withdrawn unknown candidate.
const SOURCES_WITHOUT_UNKNOWN = sources();

// Every way a run can fail to certify its own inputs. None of them may retire a live proposal.
const STALE_CATALOG_SOURCES = sources({ catalog: { stale: true, ageMs: 49 * HOUR } });
const EMPTY_CATALOG_SOURCES = sources({ data: {} });
const CATALOG_REFRESH_ERROR_SOURCES = sources({
  catalog: { refreshed: false, source: "live", error: "opencode models: not found" },
});
const STALE_RESOLVER_SOURCES = sources({ resolver: { stale: true, ageMs: 73 * HOUR } });
const EMPTY_RESOLVER_SOURCES = sources({ resolverKeys: [] });

const withTempRoot = (name, run) => {
  const base = mkdtempSync(join(tmpdir(), `reconcile-classify-${name}-`));
  try {
    return run(join(base, "model-routing"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

const storeAt = (root) => createReconciliationStore({ root, now: () => NOW });

const dryRunArgs = (store, overrides = {}) => ({
  store,
  modelRoles: TEST_ROLES,
  staticTargets: STATIC_TARGETS,
  authSnapshot: () => AUTH,
  collectSources: () => sources(),
  now: () => NOW,
  ...overrides,
});

// ---- record and claim fixtures --------------------------------------------------------------

const SOL_CANDIDATE = Object.freeze({
  providerID: "openai", modelID: "gpt-6-sol", family: "gpt-sol",
  roleKey: "openai:gpt-sol", releaseDate: "2026-09-22",
});
const SOL_TRANSITION_ID = candidateTransitionID(SOL_CANDIDATE);

// Evidence as `ingestEvidence()` stores it: already validated, already carrying the `policy`
// flag that says whether the claim type may drive automation for this record's kind.
const storedClaim = (claimType, policy) => ({
  providerID: "openai",
  candidateModelID: "gpt-6-sol",
  incumbentModelID: "gpt-5.6-sol",
  roleID: "gpt-sol",
  claimType,
  sourceURL: "https://openai.com/index/gpt-6-sol/",
  exactQuote: "GPT-6 Sol is the successor to GPT-5.6 Sol and replaces it in the API.",
  retrievedAt: RETRIEVED_AT,
  contentHash: "a".repeat(64),
  policy,
});
const policyClaim = (claimType) => storedClaim(claimType, true);
const supportingClaim = (claimType) => storedClaim(claimType, false);

const roleRecord = (overrides = {}) => {
  const base = {
    transitionID: SOL_TRANSITION_ID,
    roleKey: "openai:gpt-sol",
    providerID: "openai",
    roleID: "gpt-sol",
    candidateModelID: "gpt-6-sol",
    candidateFamily: "gpt-sol",
    candidateReleaseDate: "2026-09-22",
    candidateVersion: "6",
    incumbentModelID: "gpt-5.6-sol",
    proposedTiers: ["smart"],
    proposedFit: {},
    state: "evidence-pending",
    reason: null,
    stateChangedAt: NOW - DAY,
    lastObservedAt: NOW - DAY,
    transitions: ["discovered", "evidence-pending"],
    evidence: [],
    evidenceContradiction: false,
    approval: null,
    issue: null,
    supersededIssue: null,
    notified: null,
    ...overrides,
  };
  // The default revision matches the candidate, so only a test that asks for a stale one gets it.
  return { evidenceRevision: candidateRevision(base), ...base };
};

const UNKNOWN_TRANSITION_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";

const unknownRecord = (overrides = {}) => {
  const base = {
    transitionID: UNKNOWN_TRANSITION_ID,
    groupKey: "openai:openai-preview",
    providerID: "openai",
    modelID: "withdrawn-preview",
    family: "openai-preview",
    roleStatus: "unknown",
    roleMatches: [],
    releaseDate: "2026-09-10",
    version: null,
    state: "evidence-pending",
    reason: null,
    stateChangedAt: NOW - DAY,
    lastObservedAt: NOW - DAY,
    transitions: ["discovered", "evidence-pending"],
    evidence: [],
    evidenceContradiction: false,
    approval: null,
    issue: null,
    supersededIssue: null,
    notified: null,
    ...overrides,
  };
  return { evidenceRevision: candidateRevision(base), ...base };
};

const withRole = (record) => ({ ...emptyReconciliationState(), roles: { [record.roleKey]: record } });

const seedRole = (store, record) =>
  store.update((state) => ({ ...state, roles: { ...state.roles, [record.roleKey]: record } }));

const seedAwaitingApproval = (store, overrides = {}) => seedRole(store, roleRecord({
  state: "awaiting-approval",
  reason: "no official successor or recommended-replacement claim",
  transitions: ["discovered", "evidence-pending", "awaiting-approval"],
  evidence: [supportingClaim("stronger")],
  ...overrides,
}));

const seedAwaitingApprovalWithIssue = (store, { number }) => seedAwaitingApproval(store, {
  issue: { number, url: `https://git.arch.fyi/flan/opencode-broker/issues/${number}` },
});

const seedUnknownAwaitingApproval = (store, { transitionID, number }) => store.update((state) => ({
  ...state,
  unknown: {
    ...state.unknown,
    [transitionID]: unknownRecord({
      transitionID,
      state: "awaiting-approval",
      reason: "the candidate has no known role",
      transitions: ["discovered", "evidence-pending", "awaiting-approval"],
      evidence: [supportingClaim("stronger")],
      issue: { number, url: `https://git.arch.fyi/flan/opencode-broker/issues/${number}` },
    }),
  },
}));

const amendProposedTiers = (store, roleKey, tiers) => store.update((state) => ({
  ...state,
  roles: { ...state.roles, [roleKey]: { ...state.roles[roleKey], proposedTiers: [...tiers] } },
}));

// Evidence arrives the only way it can: through ingestEvidence(), against the request the run
// enqueued, inside the store's own lock.
const ingestSuccessorEvidence = (store, roleKey) => store.update((state) => {
  const record = state.roles[roleKey];
  return ingestEvidence(state, record.transitionID, {
    providerID: record.providerID,
    candidateModelID: record.candidateModelID,
    incumbentModelID: record.incumbentModelID,
    roleID: record.roleID,
    claims: [{
      claimType: "successor",
      sourceURL: "https://openai.com/index/gpt-6-sol/",
      exactQuote: "GPT-6 Sol is the successor to GPT-5.6 Sol and replaces it in the API.",
      retrievedAt: RETRIEVED_AT,
    }],
  }, { roles: TEST_ROLES, now: () => NOW }).state;
});

// ---- the decision table ---------------------------------------------------------------------

test("a known-role successor with an unambiguous official claim becomes auto-eligible", () => {
  const { state, reason } = classifyEvidencedRecord(roleRecord({
    evidence: [policyClaim("successor")],
  }), { roles: TEST_ROLES });
  assert.equal(state, "auto-eligible");
  assert.match(reason, /successor/);
});

test("recommended-replacement is equally sufficient for a known role", () => {
  assert.equal(classifyEvidencedRecord(roleRecord({
    evidence: [policyClaim("recommended-replacement")] }), { roles: TEST_ROLES }).state, "auto-eligible");
});

test("supporting claims alone are never enough", () => {
  for (const type of ["stronger", "faster", "cheaper"]) {
    const { state, reason } = classifyEvidencedRecord(roleRecord({
      evidence: [supportingClaim(type)] }), { roles: TEST_ROLES });
    assert.equal(state, "awaiting-approval");
    assert.match(reason, /no official successor/i);
  }
});

test("a policy claim set aside for review is named in the reason", () => {
  // A known role holding only a new-role claim is correctly held for a human. The reason must say
  // the claim was set aside, not that nothing was accepted, or debugging starts at the collector.
  const { state, reason } = classifyEvidencedRecord(roleRecord({
    evidence: [policyClaim("new-role")] }), { roles: TEST_ROLES });
  assert.equal(state, "awaiting-approval");
  assert.match(reason, /no official successor/i);
  assert.match(reason, /policy claims set aside for review: new-role/);
});

test("a contradiction, a role-change, or an unknown role requires approval", () => {
  assert.equal(classifyEvidencedRecord(roleRecord({
    evidence: [policyClaim("successor"), policyClaim("role-change")] }),
  { roles: TEST_ROLES }).state, "awaiting-approval");
  assert.equal(classifyEvidencedRecord(unknownRecord({
    evidence: [policyClaim("new-role")] }), { roles: TEST_ROLES }).state, "awaiting-approval");
  // The ingest-time contradiction flag is authoritative on its own.
  assert.equal(classifyEvidencedRecord(roleRecord({
    evidence: [policyClaim("successor")], evidenceContradiction: true }),
  { roles: TEST_ROLES }).state, "awaiting-approval");
  // A registry that cannot say which lane the model belongs in cannot decide automatically.
  assert.equal(classifyEvidencedRecord(roleRecord({
    roleStatus: "conflict", evidence: [policyClaim("successor")] }),
  { roles: TEST_ROLES }).state, "awaiting-approval");
});

test("a record with no evidence keeps waiting rather than being decided", () => {
  assert.equal(classifyEvidencedRecord(roleRecord({ evidence: [] }), { roles: TEST_ROLES }).state,
    "evidence-pending");
});

test("an existing decision or terminal state is never reclassified", () => {
  for (const record of [
    roleRecord({ state: "rejected", evidence: [policyClaim("successor")] }),
    roleRecord({ state: "approved", approval: { decision: "approved" }, evidence: [policyClaim("successor")] }),
    roleRecord({ state: "rolled-back", evidence: [policyClaim("successor")] }),
  ]) {
    const result = applyEvidenceClassification(withRole(record), { roles: TEST_ROLES, now: () => NOW });
    assert.equal(result.changed, false);
    assert.equal(result.state.roles[record.roleKey].state, record.state);
  }
});

// A blocked record is tracking a source problem, not waiting on evidence: classification must
// leave it exactly where Package 1 put it.
test("a blocked record is never pulled into the evidence lifecycle", () => {
  for (const state of ["blocked-stale", "blocked-conflict", "blocked-unresolvable"]) {
    const result = applyEvidenceClassification(withRole(roleRecord({ state, evidence: [] })),
      { roles: TEST_ROLES, now: () => NOW });
    assert.equal(result.changed, false);
    assert.equal(result.state.roles["openai:gpt-sol"].state, state);
  }
});

test("classification appends to transitions and moves stateChangedAt exactly once", () => {
  const first = applyEvidenceClassification(withRole(roleRecord({ evidence: [policyClaim("successor")] })),
    { roles: TEST_ROLES, now: () => NOW });
  const record = first.state.roles["openai:gpt-sol"];
  assert.deepEqual(record.transitions.slice(-1), ["auto-eligible"]);
  assert.equal(record.stateChangedAt, NOW);

  const second = applyEvidenceClassification(first.state, { roles: TEST_ROLES, now: () => NOW + 9_000 });
  assert.equal(second.changed, false);
  assert.equal(second.state.roles["openai:gpt-sol"].stateChangedAt, NOW);
});

test("stale evidence for a superseded candidate is dropped rather than trusted", () => {
  const record = roleRecord({ evidence: [policyClaim("successor")], evidenceRevision: "stale-revision" });
  const result = applyEvidenceClassification(withRole(record), { roles: TEST_ROLES, now: () => NOW });
  assert.equal(result.state.roles["openai:gpt-sol"].state, "evidence-pending");
  assert.deepEqual(result.state.roles["openai:gpt-sol"].evidence, []);
});

test("the post-observation states are named once and include approved", () => {
  assert.deepEqual([...POST_OBSERVATION_STATES], ["auto-eligible", "awaiting-approval", "approved"]);
});

// ---- re-observation: the loop this package would otherwise notify in ------------------------

test("a second dry run does not drag an advanced record back to evidence-pending", () => {
  withTempRoot("advanced", (root) => {
    const store = storeAt(root);
    runDryReconciliation(dryRunArgs(store));                 // observe
    ingestSuccessorEvidence(store, "openai:gpt-sol");        // evidence arrives
    runDryReconciliation(dryRunArgs(store));                 // classify
    const first = store.read().roles["openai:gpt-sol"];
    assert.equal(first.state, "auto-eligible");

    const again = runDryReconciliation(dryRunArgs(store, { now: () => NOW + 86_400_000 }));
    const second = store.read().roles["openai:gpt-sol"];
    assert.equal(second.state, "auto-eligible");
    assert.equal(second.stateChangedAt, first.stateChangedAt,
      "an unchanged advanced record must not look like a fresh transition to the notifier");
    assert.deepEqual(second.transitions, first.transitions);
    assert.ok(second.lastObservedAt > first.lastObservedAt);
    assert.equal(again.effects.routingMutated, false);
    assert.equal(again.effects.inventoryPublished, false);
    assert.equal(again.effects.externalPublished, false);
  });
});

test("an amended proposal keeps its operator tiers across dry runs", () => {
  withTempRoot("amended", (root) => {
    const store = storeAt(root);
    seedAwaitingApproval(store);
    amendProposedTiers(store, "openai:gpt-sol", ["smart", "build"]);
    runDryReconciliation(dryRunArgs(store));
    assert.deepEqual(store.read().roles["openai:gpt-sol"].proposedTiers, ["smart", "build"]);
  });
});

test("a genuinely newer candidate supersedes an advanced record instead of being ignored", () => {
  withTempRoot("superseded", (root) => {
    const store = storeAt(root);
    seedAwaitingApproval(store);
    const result = runDryReconciliation(dryRunArgs(store, { collectSources: () => SOURCES_WITH_GPT7_SOL }));
    const record = store.read().roles["openai:gpt-sol"];
    assert.equal(record.candidateModelID, "gpt-7-sol");
    assert.equal(record.state, "evidence-pending");
    assert.deepEqual(record.evidence, []);
    assert.equal(record.approval, null);
    assert.equal(record.issue, null);
    assert.deepEqual(record.transitions.slice(-2), ["superseded", "evidence-pending"]);
    assert.deepEqual(result.superseded, [{ kind: "role", key: "openai:gpt-sol" }]);
  });
});

test("supersession moves a real issue pointer and fabricates none when there was no issue", () => {
  // With an open issue: the pointer must survive so Task 5 can still close it.
  withTempRoot("superseded-issue", (root) => {
    const store = storeAt(root);
    seedAwaitingApprovalWithIssue(store, { number: 41 });
    runDryReconciliation(dryRunArgs(store, {
      collectSources: () => SOURCES_WITH_GPT7_SOL, now: () => NOW,
    }));
    const moved = store.read().roles["openai:gpt-sol"];
    assert.equal(moved.issue, null);
    assert.equal(moved.supersededIssue.number, 41);
    assert.equal(moved.supersededIssue.supersededAt, NOW);
    assert.equal(moved.supersededIssue.commentedAt, null);
  });

  // Without one: `{ ...null }` would store a pointer with no number, and pass one would
  // then call the forge with `number === undefined` on every run forever.
  withTempRoot("superseded-no-issue", (root) => {
    const store = storeAt(root);
    seedAwaitingApproval(store);
    runDryReconciliation(dryRunArgs(store, {
      collectSources: () => SOURCES_WITH_GPT7_SOL, now: () => NOW,
    }));
    assert.equal(store.read().roles["openai:gpt-sol"].supersededIssue, null);
  });
});

test("an unknown candidate that leaves a healthy catalog is retired rather than left approvable", () => {
  withTempRoot("retired", (root) => {
    const store = storeAt(root);
    seedUnknownAwaitingApproval(store, { transitionID: UNKNOWN_TRANSITION_ID, number: 42 });
    const result = runDryReconciliation(dryRunArgs(store, {
      collectSources: () => SOURCES_WITHOUT_UNKNOWN,
    }));
    const record = store.read().unknown[UNKNOWN_TRANSITION_ID];
    assert.equal(record.state, "superseded");
    assert.equal(record.issue, null);
    assert.equal(record.supersededIssue.number, 42);
    assert.equal(record.supersededAt, NOW, "without the stamp the retirement is never announced");
    assert.deepEqual(result.superseded, [{ kind: "unknown", key: UNKNOWN_TRANSITION_ID }]);
  });
});

// The dangerous case: a transient failure must never retire a live proposal, because `superseded`
// is terminal and held, so the model would never be proposed again.
test("an uncertifiable run retires nothing", () => {
  const cases = [
    ["stale catalog", STALE_CATALOG_SOURCES],
    ["empty catalog", EMPTY_CATALOG_SOURCES],
    ["catalog refresh error", CATALOG_REFRESH_ERROR_SOURCES],
    ["stale resolver", STALE_RESOLVER_SOURCES],
    ["empty resolver", EMPTY_RESOLVER_SOURCES],
  ];
  for (const [label, collected] of cases) {
    withTempRoot("uncertifiable", (root) => {
      const store = storeAt(root);
      seedUnknownAwaitingApproval(store, { transitionID: UNKNOWN_TRANSITION_ID, number: 42 });
      const result = runDryReconciliation(dryRunArgs(store, { collectSources: () => collected }));
      const record = store.read().unknown[UNKNOWN_TRANSITION_ID];
      assert.equal(record.state, "awaiting-approval", label);
      assert.equal(record.supersededIssue, null, label);
      assert.equal(record.issue.number, 42, label);
      assert.deepEqual(result.superseded, [], label);
    });
  }
});

test("a provider dropped by an unreadable auth store keeps its open proposals", () => {
  withTempRoot("no-auth", (root) => {
    const store = storeAt(root);
    seedUnknownAwaitingApproval(store, { transitionID: UNKNOWN_TRANSITION_ID, number: 42 });
    const result = runDryReconciliation(dryRunArgs(store, {
      authSnapshot: () => ({ revision: null, types: {} }),
    }));
    assert.equal(store.read().unknown[UNKNOWN_TRANSITION_ID].state, "awaiting-approval");
    assert.deepEqual(result.superseded, []);
  });
});
