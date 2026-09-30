import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createReconciliationApplier } from "../lib/reconcile-apply.js";
import { collectApplyReconciliationSources } from "../lib/model-reconcile.js";

const NOW = 1_800_000_000_000;
const TRANSITION_ID = "a1b2c3d4e5f60718293a4b5c";
const ROLE = "openai:gpt-sol";
const INCUMBENT_MODEL_ID = "gpt-5.6-sol";
const CANDIDATE_MODEL_ID = "gpt-6-sol";
const MANIFEST_HASH = "a".repeat(64);
const EFFECTIVE_HASH = "b".repeat(64);
const CANDIDATE_IDENTITY = Object.freeze({ providerID: "openai", modelID: CANDIDATE_MODEL_ID });
const CANDIDATE_INTRODUCTION = Object.freeze({ generation: 1, manifestHash: MANIFEST_HASH });
const GENERATION_ACK = Object.freeze({ ...CANDIDATE_INTRODUCTION, effectiveHash: EFFECTIVE_HASH });
const ROLE_POLICY = Object.freeze({ effortCeiling: "high", requiredReasoningMode: null });
const PROBE_KINDS = Object.freeze(["normal", "tool", "reasoning"]);

const clone = (value) => structuredClone(value);
const canonical = (value) => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]));
});
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");

const approvedRecord = (overrides = {}) => ({
  transitionID: TRANSITION_ID,
  roleKey: ROLE,
  providerID: "openai",
  roleID: "gpt-sol",
  candidateModelID: CANDIDATE_MODEL_ID,
  candidateFamily: "gpt-sol",
  candidateReleaseDate: "2026-09-22",
  candidateVersion: "6",
  incumbentModelID: INCUMBENT_MODEL_ID,
  proposedTiers: ["smart"],
  proposedFit: { smart: 1.4 },
  proposedEffortCeiling: "high",
  requiredReasoningMode: null,
  state: "approved",
  reason: "operator approved",
  stateChangedAt: NOW - 1,
  lastObservedAt: NOW - 1,
  transitions: ["discovered", "awaiting-approval", "approved"],
  evidence: [],
  evidenceRevision: null,
  evidenceCollectedAt: null,
  evidenceContradiction: false,
  approval: { decision: "approved", source: "cli", at: NOW - 1, note: null },
  issue: null,
  notified: null,
  ...overrides,
});

const recordIntentRevision = (record, ordinaryModel = "smart") => hash({
  transitionID: record.transitionID,
  roleKey: record.roleKey,
  providerID: record.providerID,
  roleID: record.roleID ?? null,
  candidateModelID: record.candidateModelID ?? record.modelID ?? null,
  candidateReleaseDate: record.candidateReleaseDate ?? record.releaseDate ?? null,
  incumbentModelID: record.incumbentModelID ?? null,
  proposedTiers: record.proposedTiers ?? [],
  proposedFit: record.proposedFit ?? {},
  proposedEffortCeiling: record.proposedEffortCeiling ?? null,
  requiredReasoningMode: record.requiredReasoningMode ?? null,
  evidenceRevision: record.evidenceRevision ?? null,
  evidence: record.evidence ?? [],
  approval: record.approval ?? null,
  ordinaryModel,
});

const probationState = (phase) => ({
  phase,
  offerEvery: 5,
  opportunityCursor: 0,
  opportunityMs: 0,
  opportunityCursorAt: null,
  opportunityEligibleUntil: null,
  successes: [],
  failures: [],
  leases: {},
});

const stagedPolicyRequest = (revision) => ({
  transitionID: TRANSITION_ID,
  revision,
  roleKey: ROLE,
  expectedIncumbentModelID: INCUMBENT_MODEL_ID,
  generation: 1,
  manifestHash: MANIFEST_HASH,
  desired: {
    activeModelID: INCUMBENT_MODEL_ID,
    probationModelID: CANDIDATE_MODEL_ID,
    rollbackModelID: INCUMBENT_MODEL_ID,
    routingIntent: {
      tiers: ["smart"], fit: { smart: 1.4 }, effortCeiling: "high", requiredReasoningMode: null,
    },
    probation: probationState("staged-probing"),
  },
});

const policyAck = (request) => ({
  transitionID: request.transitionID,
  revision: request.revision,
  roleKey: request.roleKey,
  generation: request.generation,
  manifestHash: request.manifestHash,
  desiredHash: hash(request.desired),
  appliedAt: NOW,
});

const initialState = (record = approvedRecord()) => ({
  version: 1,
  updatedAt: NOW - 1,
  roles: { [ROLE]: record },
  unknown: {},
  evidenceRequests: {},
});

const completeProbeResults = () => Object.fromEntries(PROBE_KINDS.map((kind, index) => [kind, {
  kind,
  requestID: `request-${kind}`,
  success: true,
  failureClass: null,
  observedAt: NOW + index,
}]));

test("apply source collection leaves protected broker references for the applier to collect", () => {
  const source = collectApplyReconciliationSources({
    authSnapshot: () => ({ revision: "auth-revision-1" }),
    collectSources: () => ({ catalog: { data: {} }, resolver: {} }),
    modelRoles: {},
    baseConfigPath: "/tmp/opencode.json",
  });
  assert.equal(source.protectedReferences, undefined);
});

const makeFixture = ({
  state: seededState = initialState(),
  probeFailure = null,
  failureAt = null,
  closeAlsoFails = false,
  brokerError = null,
  uncertainResultKind = null,
  crashAfter = null,
  sourceOverrides = {},
} = {}) => {
  const events = [];
  let crashed = false;
  const emit = (event) => {
    events.push(event);
    if (!crashed && crashAfter === event) {
      crashed = true;
      throw new Error(`injected crash after ${event}`);
    }
  };
  const counts = {
    sourceCollections: 0,
    overlayChanges: 0,
    generationBuilds: 0,
    generationPublishes: 0,
    brokerChanges: 0,
    probeLaunches: 0,
    probeRuns: 0,
    probeResultWrites: { normal: 0, tool: 0, reasoning: 0 },
    probeAcks: 0,
    probationChanges: 0,
  };
  let state = clone(seededState);
  let lockHeld = false;
  let overlay = { version: 1, revision: 0, updatedAt: NOW - 10, entries: {} };
  let registered = null;
  let currentBundle = null;
  let launchNumber = 0;
  let uncertainThrown = false;
  let policy = { version: 1, roles: {}, history: [] };
  const openCalls = [];
  const launchNonces = [];
  let closeCalls = 0;

  const ledgerEvent = (before, after) => {
    const prior = before.roles[ROLE];
    const next = after.roles[ROLE];
    if (!prior.applyIntent && next.applyIntent) return "ledger:intent";
    if (!prior.generationAck && next.generationAck) return "ledger:generation-ack";
    if (!prior.policyPending && next.policyPending) return "ledger:policy-pending";
    if (!prior.brokerAck && next.brokerAck) return "ledger:broker-ack";
    for (const kind of PROBE_KINDS) {
      if (!prior.probeResults?.[kind] && next.probeResults?.[kind]) return `ledger:probe-${kind}`;
    }
    if (!prior.probeAck && next.probeAck) return "ledger:probe-ack";
    if (!prior.probationPending && next.probationPending) return "ledger:probation-pending";
    if (!prior.probationAck && next.probationAck) return "ledger:probation-ack";
    if (!prior.probeRollbackAck && next.probeRollbackAck) return "ledger:rollback-ack";
    return "ledger:update";
  };

  const store = {
    read: () => clone(state),
    update(mutator) {
      assert.equal(lockHeld, false, "ledger updates must not nest");
      lockHeld = true;
      try {
        const before = clone(state);
        const next = mutator(clone(state));
        const proposed = { ...clone(next), version: 1, updatedAt: state.updatedAt + 1 };
        const event = ledgerEvent(before, proposed);
        if (failureAt === "callback" && event === "ledger:probe-normal") throw new Error("callback failure");
        state = proposed;
        emit(event);
        const resultKind = PROBE_KINDS.find((kind) => event === `ledger:probe-${kind}`);
        if (resultKind) counts.probeResultWrites[resultKind] += 1;
        if (event === "ledger:probe-ack") counts.probeAcks += 1;
        if (resultKind === uncertainResultKind && !uncertainThrown) {
          uncertainThrown = true;
          throw new Error("uncertain ledger write");
        }
        return clone(state);
      } finally {
        lockHeld = false;
      }
    },
  };

  const overlayStore = {
    read: () => clone(overlay),
    write(desired, expected) {
      assert.equal(lockHeld, false, "overlay write ran under ledger lock");
      const desiredHash = hash(desired);
      if (hash(overlay) === desiredHash) {
        emit("overlay:write");
        return { changed: false, replayed: true, hash: desiredHash, revision: overlay.revision };
      }
      assert.equal(hash(overlay), expected.expectedPreviousHash);
      assert.equal(overlay.revision, expected.expectedRevision);
      overlay = clone(desired);
      counts.overlayChanges += 1;
      emit("overlay:write");
      return { changed: true, replayed: false, hash: desiredHash, revision: overlay.revision };
    },
  };

  const bundle = () => ({
    generation: 1,
    directory: "/tmp/generations/generation-1",
    manifest: {
      version: 1,
      generation: 1,
      baseHash: "c".repeat(64),
      overlayHash: hash(overlay),
      effectiveHash: EFFECTIVE_HASH,
      modelKeys: [`openai/${INCUMBENT_MODEL_ID}`, `openai/${CANDIDATE_MODEL_ID}`],
      createdAt: NOW,
      authorizingRevisions: Object.values(overlay.entries).map((entry) => entry.revision).sort(),
    },
    manifestHash: MANIFEST_HASH,
    effectiveHash: EFFECTIVE_HASH,
    reused: false,
  });
  const seededRecord = state.roles[ROLE];
  if (seededRecord?.generationAck) {
    registered = bundle();
    currentBundle = bundle();
  }
  if (seededRecord?.brokerAck && seededRecord?.policyPending?.desired) {
    const request = seededRecord.policyPending;
    const ack = seededRecord.brokerAck;
    policy = {
      version: 1,
      roles: { [ROLE]: {
        roleKey: ROLE,
        providerID: "openai",
        incumbentModelID: request.expectedIncumbentModelID,
        ...clone(request.desired),
        introduction: { generation: request.generation, manifestHash: request.manifestHash },
        revision: request.revision,
        transitionID: request.transitionID,
        history: [clone(ack)],
      } },
      history: [clone(ack)],
    };
  }
  const generationManager = {
    readRegistry: () => ({ version: 1, highWater: registered ? 1 : 0, generations: registered ? {
      1: { manifestHash: MANIFEST_HASH, effectiveHash: EFFECTIVE_HASH, createdAt: NOW },
    } : {} }),
    async build(request) {
      assert.equal(lockHeld, false, "generation build ran under ledger lock");
      counts.generationBuilds += 1;
      assert.equal(request.reservedGeneration, 1);
      assert.equal(request.overlay.updatedAt, NOW);
      emit("generation:build");
      return bundle();
    },
    async publish(candidate) {
      assert.equal(lockHeld, false, "generation publish ran under ledger lock");
      if (!registered) {
        registered = clone(candidate);
        counts.generationPublishes += 1;
      }
      emit("generation:publish");
      currentBundle = clone(candidate);
      return { ...bundle(), changed: counts.generationPublishes === 1 };
    },
    generation(number) {
      if (!registered || number !== 1) throw new Error("unknown generation");
      return bundle();
    },
    current: () => currentBundle ? bundle() : null,
  };

  const ackFor = (body) => ({
    transitionID: body.transitionID,
    revision: body.revision,
    roleKey: body.roleKey,
    generation: body.generation,
    manifestHash: body.manifestHash,
    desiredHash: hash(body.desired),
    appliedAt: NOW,
  });
  const brokerRequest = async (path, body = {}) => {
    assert.equal(lockHeld, false, `${path} ran under ledger lock`);
    if (path === "/model-policy/status") return { modelPolicy: clone(policy), apply: { enabled: true } };
    if (path === "/model-policy/probe-launch") {
      counts.probeLaunches += 1;
      const probeLaunchNonce = `pln_${String(++launchNumber).padStart(43, "A")}`;
      launchNonces.push(probeLaunchNonce);
      emit("broker:probe-launch");
      return { probeLaunchNonce, expiresAt: NOW + 60_000 };
    }
    if (path !== "/model-policy/cas") throw new Error(`unexpected broker path ${path}`);
    if (brokerError && body.desired?.probation?.phase === "staged-probing") {
      const error = new Error(brokerError.code);
      error.code = brokerError.code;
      throw error;
    }
    const present = policy.roles[body.roleKey];
    const desiredJSON = canonical(body.desired);
    const same = present?.transitionID === body.transitionID
      && present?.revision === body.revision
      && canonical({
        activeModelID: present.activeModelID,
        probationModelID: present.probationModelID,
        rollbackModelID: present.rollbackModelID,
        routingIntent: present.routingIntent,
        probation: present.probation,
      }) === desiredJSON;
    const ack = same ? present.history.at(-1) : ackFor(body);
    if (!same) {
      const role = {
        roleKey: body.roleKey,
        providerID: body.roleKey.split(":")[0],
        incumbentModelID: body.expectedIncumbentModelID,
        ...clone(body.desired),
        introduction: { generation: body.generation, manifestHash: body.manifestHash },
        revision: body.revision,
        transitionID: body.transitionID,
        history: [...(present?.history ?? []), ack],
      };
      policy.roles[body.roleKey] = role;
      policy.history.push(ack);
      counts.brokerChanges += 1;
    }
    const phase = body.desired.probation.phase;
    if (phase === "staged-probing") emit("broker:cas");
    else if (phase === "probation") {
      if (!same) counts.probationChanges += 1;
      emit("broker:probation-cas");
    } else if (phase === "rolled-back") emit("broker:probe-rollback");
    return { ok: true, ack: clone(ack), changed: !same };
  };

  const probeClientFactory = {
    async open(request) {
      assert.equal(lockHeld, false, "probe open ran under ledger lock");
      openCalls.push(clone(request));
      emit("probe:open");
      if (failureAt === "open") throw new Error("open failure");
      if (failureAt === "candidate-absent") throw new Error("probe candidate is absent from the exact generation manifest");
      return {
        async probe(requestFrame) {
          counts.probeRuns += 1;
          emit(`probe:${requestFrame.kind}`);
          if (failureAt === "probe" || failureAt === "dispatch") throw new Error(`${failureAt} failure`);
          if (requestFrame.kind === "tool") {
            return probeFailure === "tool"
              ? { status: 200, body: { choices: [{ message: { tool_calls: [] } }] } }
              : { status: 200, body: { choices: [{ message: { tool_calls: [{ function: {
                name: "probe_echo", arguments: "{\"ok\":true}",
              } }] } }] } };
          }
          return { status: probeFailure === requestFrame.kind ? 500 : 200, body: { choices: [{ message: { content: "PROBE_OK" } }] } };
        },
        async close() {
          closeCalls += 1;
          emit("probe:close");
          if (failureAt === "close" || closeAlsoFails) throw new Error("close failure");
        },
      };
    },
  };

  let source = {
    authRevision: "auth-revision-1",
    authRevisionAfter: "auth-revision-1",
    catalog: { stale: false, empty: false, error: null },
    resolver: { stale: false, empty: false, error: null },
    catalogModels: {
      openai: { models: { [CANDIDATE_MODEL_ID]: {
        id: CANDIDATE_MODEL_ID,
        name: "GPT-6 Sol",
        family: "gpt-sol",
        release_date: "2026-09-22",
        tool_call: true,
        limit: { context: 200_000, output: 32_000 },
        variants: { high: { reasoning_effort: "high" } },
      } } },
    },
    modelRoles: {
      [ROLE]: {
        roleID: "gpt-sol", providerID: "openai", tiers: ["smart"], fit: { smart: 1.4 },
        effortCeiling: "high", requiredReasoningMode: null,
      },
    },
    baseConfigPath: "/tmp/base-opencode.json",
    protectedReferences: [],
    authorizedRetirements: [],
    ordinaryModel: "smart",
    ...sourceOverrides,
  };
  const collectSources = () => {
    assert.equal(lockHeld, false, "source collection ran under ledger lock");
    counts.sourceCollections += 1;
    return clone(source);
  };

  const applier = () => createReconciliationApplier({
    store,
    overlayStore,
    generationManager,
    brokerRequest,
    probeClientFactory,
    collectSources,
    now: () => NOW,
  });
  return {
    applier,
    events,
    counts,
    openCalls,
    launchNonces,
    state: () => clone(state),
    policy: () => clone(policy.roles[ROLE]),
    tamperPolicy: (mutator) => { policy = mutator(clone(policy)); },
    tamperSources: (mutator) => { source = mutator(clone(source)); },
    closeCalls: () => closeCalls,
    lockHeld: () => lockHeld,
  };
};

test("apply records each durable boundary in order without holding the ledger lock across calls", async () => {
  const fixture = makeFixture();
  const result = await fixture.applier().apply({ transitionID: TRANSITION_ID });
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.events, [
    "ledger:intent", "overlay:write", "generation:build", "generation:publish",
    "ledger:generation-ack", "ledger:policy-pending", "broker:cas", "ledger:broker-ack",
    "broker:probe-launch", "probe:open", "probe:normal", "ledger:probe-normal",
    "probe:tool", "ledger:probe-tool", "probe:reasoning", "ledger:probe-reasoning",
    "probe:close", "ledger:probe-ack", "ledger:probation-pending",
    "broker:probation-cas", "ledger:probation-ack",
  ]);
  assert.equal(fixture.lockHeld(), false);
  assert.equal(fixture.state().roles[ROLE].stateChangedAt, fixture.state().roles[ROLE].probationAck.appliedAt);
  assert.deepEqual(fixture.openCalls, [{
    transitionID: TRANSITION_ID,
    roleKey: ROLE,
    candidateIdentity: CANDIDATE_IDENTITY,
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    generationAck: GENERATION_ACK,
    ordinaryModel: "smart",
    probeLaunchNonce: fixture.launchNonces[0],
  }]);
  assert.equal(fixture.closeCalls(), 1);
});

test("recovery resumes commit-before-ack boundaries without repeating committed external mutations", async () => {
  const fixture = makeFixture();
  await fixture.applier().apply({ transitionID: TRANSITION_ID });
  const before = clone(fixture.counts);
  const recovered = await fixture.applier().recover({ transitionID: TRANSITION_ID });
  assert.equal(recovered.ok, true);
  assert.equal(fixture.counts.overlayChanges, before.overlayChanges);
  assert.equal(fixture.counts.generationPublishes, before.generationPublishes);
  assert.equal(fixture.counts.brokerChanges, before.brokerChanges);
  assert.equal(fixture.counts.probeLaunches, before.probeLaunches);
  assert.equal(fixture.counts.probeRuns, before.probeRuns);
});

test("recover-all skips completed probation transitions", async () => {
  const fixture = makeFixture();
  await fixture.applier().apply({ transitionID: TRANSITION_ID });
  const before = clone(fixture.counts);
  const result = await fixture.applier().recover();
  assert.deepEqual(result, { ok: true, mutated: false, results: [] });
  assert.deepEqual(fixture.counts, { ...before, sourceCollections: before.sourceCollections + 1 });
});

test("recovery resumes every saga boundary and retries probes with a fresh nonce and child", async () => {
  const boundaries = [
    "ledger:intent",
    "overlay:write",
    "generation:build",
    "generation:publish",
    "ledger:generation-ack",
    "ledger:policy-pending",
    "broker:cas",
    "ledger:broker-ack",
    "broker:probe-launch",
    "probe:open",
    "probe:normal",
    "probe:close",
    "ledger:probe-ack",
    "ledger:probation-pending",
    "broker:probation-cas",
    "ledger:probation-ack",
  ];
  for (const boundary of boundaries) {
    const fixture = makeFixture({ crashAfter: boundary });
    await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /injected crash/, boundary);
    let recovered;
    try {
      recovered = await fixture.applier().recover({ transitionID: TRANSITION_ID });
    } catch (error) {
      throw new Error(`recovery failed after ${boundary}: ${error.message}`, { cause: error });
    }
    assert.equal(recovered.ok, true, boundary);
    assert.equal(fixture.counts.overlayChanges, 1, boundary);
    assert.equal(fixture.counts.generationPublishes, 1, boundary);
    assert.equal(fixture.counts.brokerChanges, 2, boundary);
    assert.equal(fixture.counts.probationChanges, 1, boundary);
    if (["broker:probe-launch", "probe:open", "probe:normal"].includes(boundary)) {
      assert.equal(new Set(fixture.launchNonces).size, fixture.launchNonces.length, boundary);
      assert.equal(fixture.launchNonces.length, 2, boundary);
    }
    if (["probe:open", "probe:normal"].includes(boundary)) {
      assert.equal(fixture.openCalls.length, 2, boundary);
    }
  }
});

test("complete persisted probe results skip launch and child creation while finishing acknowledgements", async () => {
  const baseRecord = approvedRecord();
  const revision = recordIntentRevision(baseRecord);
  const pending = stagedPolicyRequest(revision);
  const record = { ...baseRecord,
    applyIntent: {
      transitionID: TRANSITION_ID,
      revision,
      reservedGeneration: 1,
      overlayUpdatedAt: NOW,
      authRevision: "auth-revision-1",
      ordinaryModel: "smart",
      previousOverlayHash: hash({ version: 1, revision: 0, updatedAt: NOW - 10, entries: {} }),
      previousOverlayRevision: 0,
      catalogModels: {
        openai: { models: { [CANDIDATE_MODEL_ID]: {
          id: CANDIDATE_MODEL_ID, name: "GPT-6 Sol", family: "gpt-sol",
          release_date: "2026-09-22", tool_call: true,
        } } },
      },
    },
    generationAck: GENERATION_ACK,
    policyPending: pending,
    brokerAck: policyAck(pending),
    probeResults: completeProbeResults(),
  };
  const fixture = makeFixture({ state: initialState(record) });
  const result = await fixture.applier().recover({ transitionID: TRANSITION_ID });
  assert.equal(result.ok, true);
  assert.equal(fixture.counts.probeLaunches, 0);
  assert.equal(fixture.openCalls.length, 0);
  assert.equal(fixture.counts.probeRuns, 0);
  assert.equal(fixture.counts.probeAcks, 1);
  assert.equal(fixture.counts.probationChanges, 1);
});

test("failed probe rolls policy back before recording terminal failure", async () => {
  const fixture = makeFixture({ probeFailure: "tool" });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /probe.*tool/i);
  assert.equal(fixture.events.indexOf("broker:probe-rollback") < fixture.events.indexOf("ledger:probe-tool"), true);
  assert.equal(fixture.events.includes("broker:probation-cas"), false);
  assert.equal(fixture.policy().activeModelID, INCUMBENT_MODEL_ID);
  const record = fixture.state().roles[ROLE];
  assert.equal(record.probeRollbackAck !== undefined, true);
  assert.equal(record.state, "rolled-back");
  assert.equal(record.reason, "invalid-model-tool-call-response");
});

test("recovery observes a committed failed-probe rollback before reconstructing its terminal result", async () => {
  const fixture = makeFixture({ probeFailure: "tool", crashAfter: "broker:probe-rollback" });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /injected crash/);
  assert.equal(fixture.state().roles[ROLE].probeResults?.tool, undefined);

  await assert.rejects(fixture.applier().recover({ transitionID: TRANSITION_ID }), /probe.*tool/i);
  const record = fixture.state().roles[ROLE];
  assert.equal(record.probeResults.tool.success, false);
  assert.equal(record.probeResults.tool.observedAt, record.probeRollbackAck.appliedAt);
  assert.equal(record.state, "rolled-back");
  assert.equal(fixture.counts.probeLaunches, 1, "recovery must not launch after durable rollback");
  assert.equal(fixture.openCalls.length, 1, "recovery must not open a child after durable rollback");
});

test("recovery acknowledges a committed probation CAS before rejecting stale sources", async () => {
  const fixture = makeFixture({ crashAfter: "broker:probation-cas" });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /injected crash/);
  assert.equal(fixture.state().roles[ROLE].probationAck, undefined);
  fixture.tamperSources((sources) => ({
    ...sources,
    catalog: { ...sources.catalog, stale: true },
  }));

  const result = await fixture.applier().recover({ transitionID: TRANSITION_ID });
  assert.equal(result.ok, true);
  assert.equal(result.state, "probation");
  assert.equal(result.mutated, true);
  assert.equal(fixture.state().roles[ROLE].state, "probation");
  assert.deepEqual(fixture.state().roles[ROLE].probationAck, result.probationAck);
  assert.equal(fixture.counts.probationChanges, 1, "recovery must not replay the committed CAS");
});

test("recovery records a committed probe rollback from persisted intent before rejecting stale sources", async () => {
  const fixture = makeFixture({ probeFailure: "tool", crashAfter: "broker:probe-rollback" });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /injected crash/);
  assert.equal(fixture.state().roles[ROLE].probeResults?.tool, undefined);
  fixture.tamperSources((sources) => ({
    ...sources,
    ordinaryModel: "changed-after-commit",
    resolver: { ...sources.resolver, stale: true },
  }));

  await assert.rejects(fixture.applier().recover({ transitionID: TRANSITION_ID }), /probe.*tool/i);
  const record = fixture.state().roles[ROLE];
  assert.equal(record.state, "rolled-back");
  assert.equal(record.reason, "invalid-model-tool-call-response");
  assert.equal(record.probeResults.tool.requestID, "mpr_0cb35402c527602dcefee6184b662f70");
  assert.equal(record.probeResults.tool.observedAt, record.probeRollbackAck.appliedAt);
  assert.equal(fixture.counts.probeLaunches, 1, "recovery must not launch after durable rollback");
  assert.equal(fixture.openCalls.length, 1, "recovery must not open a child after durable rollback");
});

test("recovery rejects a changed probe model before launching missing probes", async () => {
  const fixture = makeFixture({ crashAfter: "broker:cas" });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /injected crash/);
  fixture.tamperSources((sources) => ({ ...sources, ordinaryModel: "changed-after-intent" }));

  await assert.rejects(fixture.applier().recover({ transitionID: TRANSITION_ID }), /ordinary probe model changed since apply intent/);
  assert.equal(fixture.state().roles[ROLE].state, "blocked-conflict");
  assert.equal(fixture.counts.probeLaunches, 0);
  assert.equal(fixture.openCalls.length, 0);
});

test("probe lifecycle closes opened children and aggregates primary plus close failures", async () => {
  for (const failureAt of ["open", "probe", "dispatch", "callback", "close"]) {
    const fixture = makeFixture({ failureAt });
    await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), new RegExp(failureAt));
    assert.equal(fixture.closeCalls(), failureAt === "open" ? 0 : 1, failureAt);
  }

  const aggregate = makeFixture({ failureAt: "probe", closeAlsoFails: true });
  await assert.rejects(aggregate.applier().apply({ transitionID: TRANSITION_ID }), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.deepEqual(error.errors.map((cause) => cause.message), ["probe failure", "close failure"]);
    return true;
  });
});

test("read-after-write error accepts matching durable probe result exactly once", async () => {
  const fixture = makeFixture({ uncertainResultKind: "normal" });
  const result = await fixture.applier().apply({ transitionID: TRANSITION_ID });
  assert.equal(result.ok, true);
  assert.equal(fixture.counts.probeRuns, 3);
  assert.equal(fixture.counts.probeResultWrites.normal, 1);
  assert.equal(fixture.state().roles[ROLE].probeResults.normal.success, true);
});

test("stale broker CAS blocks before a broker acknowledgement or probe", async () => {
  const fixture = makeFixture({ brokerError: { code: "stale-model-policy" } });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /stale-model-policy/);
  assert.equal(fixture.state().roles[ROLE].brokerAck, undefined);
  assert.equal(fixture.counts.probeLaunches, 0);
});

test("blocked presentation reasons are bounded", async () => {
  const fixture = makeFixture({ brokerError: { code: `stale-${"x".repeat(1_000)}` } });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /stale-/);
  const reason = fixture.state().roles[ROLE].reason;
  assert.equal(reason.startsWith("stale-"), true);
  assert.equal(reason.length <= 512, true);
});

test("an exact-generation candidate absence blocks as unresolvable", async () => {
  const fixture = makeFixture({ failureAt: "candidate-absent" });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /candidate is absent/);
  assert.equal(fixture.state().roles[ROLE].state, "blocked-unresolvable");
  assert.equal(fixture.closeCalls(), 0);
});

test("an incomplete candidate identity blocks before any external mutation", async () => {
  const fixture = makeFixture({ state: initialState(approvedRecord({ candidateModelID: null })) });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /incomplete candidate identity/);
  assert.equal(fixture.state().roles[ROLE].state, "blocked-conflict");
  assert.equal(fixture.counts.overlayChanges, 0);
  assert.equal(fixture.counts.brokerChanges, 0);
});

test("an empty certified source records a blocked presentation without external mutation", async () => {
  const fixture = makeFixture({ sourceOverrides: { catalog: { stale: false, empty: true, error: null } } });
  await assert.rejects(fixture.applier().apply({ transitionID: TRANSITION_ID }), /catalog source is empty/);
  assert.equal(fixture.state().roles[ROLE].state, "blocked-stale");
  assert.match(fixture.state().roles[ROLE].reason, /catalog source is empty/);
  assert.equal(fixture.state().roles[ROLE].blocked, undefined);
  assert.equal(fixture.counts.overlayChanges, 0);
  assert.equal(fixture.counts.generationBuilds, 0);
  assert.equal(fixture.counts.brokerChanges, 0);
  assert.equal(fixture.counts.probeLaunches, 0);
});

test("refresh records source-gate failures on the transition it refuses", async () => {
  const fixture = makeFixture({ sourceOverrides: { resolver: { stale: false, empty: false, error: "offline" } } });
  await assert.rejects(fixture.applier().refresh(), /resolver source refresh failed/);
  assert.equal(fixture.state().roles[ROLE].state, "blocked-stale");
  assert.match(fixture.state().roles[ROLE].reason, /resolver source refresh failed/);
  assert.equal(fixture.counts.overlayChanges, 0);
  assert.equal(fixture.counts.brokerChanges, 0);
});

test("manual rollback validates broker status and is a non-writing idempotent replay", async () => {
  const fixture = makeFixture();
  await fixture.applier().apply({ transitionID: TRANSITION_ID });
  const first = await fixture.applier().rollback({
    transitionID: TRANSITION_ID,
    reason: "operator-request",
  });
  assert.equal(first.ok, true);
  assert.equal(fixture.policy().activeModelID, INCUMBENT_MODEL_ID);
  assert.equal(fixture.state().roles[ROLE].state, "rolled-back");
  assert.equal(fixture.state().roles[ROLE].stateChangedAt, first.rollbackAck.appliedAt);
  assert.equal(fixture.state().roles[ROLE].rollbackAck, undefined);
  assert.equal(fixture.state().roles[ROLE].probeRollbackAck !== undefined, true);
  const brokerChanges = fixture.counts.brokerChanges;
  const ledgerEvents = fixture.events.length;

  const replay = await fixture.applier().rollback({
    transitionID: TRANSITION_ID,
    reason: "operator-request",
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.mutated, false);
  assert.equal(fixture.counts.brokerChanges, brokerChanges);
  assert.equal(fixture.events.length, ledgerEvents);
});

test("recovery treats an acknowledged manual rollback as terminal", async () => {
  const fixture = makeFixture();
  await fixture.applier().apply({ transitionID: TRANSITION_ID });
  await fixture.applier().rollback({ transitionID: TRANSITION_ID, reason: "operator-request" });
  const brokerChanges = fixture.counts.brokerChanges;
  const ledgerEvents = fixture.events.length;

  const result = await fixture.applier().recover({ transitionID: TRANSITION_ID });
  assert.equal(result.ok, true);
  assert.equal(result.state, "rolled-back");
  assert.equal(result.mutated, false);
  assert.equal(fixture.counts.brokerChanges, brokerChanges);
  assert.equal(fixture.events.length, ledgerEvents);
});

test("manual rollback records a broker generation mismatch as blocked", async () => {
  const fixture = makeFixture();
  await fixture.applier().apply({ transitionID: TRANSITION_ID });
  fixture.tamperPolicy((policy) => {
    policy.roles[ROLE].introduction.manifestHash = "d".repeat(64);
    return policy;
  });
  await assert.rejects(fixture.applier().rollback({
    transitionID: TRANSITION_ID,
    reason: "operator-request",
  }), /generation status mismatch/);
  assert.equal(fixture.state().roles[ROLE].state, "blocked-conflict");
  assert.match(fixture.state().roles[ROLE].reason, /generation status mismatch/);
});

test("dry-run preserves durable state and makes no publisher, resolver, broker, or probe calls", async () => {
  const fixture = makeFixture();
  const before = fixture.state();
  const result = await fixture.applier().apply({ transitionID: TRANSITION_ID, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.deepEqual(fixture.state(), before);
  assert.equal(fixture.counts.sourceCollections, 1);
  assert.equal(fixture.counts.overlayChanges, 0);
  assert.equal(fixture.counts.generationBuilds, 0);
  assert.equal(fixture.counts.generationPublishes, 0);
  assert.equal(fixture.counts.brokerChanges, 0);
  assert.equal(fixture.counts.probeLaunches, 0);
});
