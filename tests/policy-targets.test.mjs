import assert from "node:assert/strict";
import test from "node:test";

import { resolvePolicyLane } from "../lib/policy-targets.js";

const ROLE = "openai:gpt-sol";
const INCUMBENT_TARGET_ID = "gpt-flagship";
const CANDIDATE_TARGET_ID = "subscription-openai-gpt-6-sol-standard";
const STALE_TARGET_ID = "subscription-openai-gpt-5-7-sol-standard";
const INCUMBENT_MODEL_KEY = "openai/gpt-5.6-sol";
const CANDIDATE_MODEL_KEY = "openai/gpt-6-sol";

const targets = () => ({
  [INCUMBENT_TARGET_ID]: {
    id: INCUMBENT_TARGET_ID,
    providerID: "openai",
    modelID: "gpt-5.6-sol",
    kind: "cloud",
    capacity: null,
    tiers: ["smart"],
    fit: { smart: 0.5 },
    context: 200_000,
    output: 32_000,
    variants: ["low", "high"],
    capabilities: { toolCall: true },
  },
  [STALE_TARGET_ID]: {
    id: STALE_TARGET_ID,
    providerID: "openai",
    modelID: "gpt-5.7-sol",
    kind: "cloud",
    capacity: null,
    source: "subscription-oauth",
    tiers: ["smart"],
    fit: { smart: 4 },
    family: "gpt-sol",
    releaseDate: "2026-08-01",
    speed: "standard",
    context: 300_000,
    output: 64_000,
    variants: ["low", "medium", "high"],
    capabilities: { toolCall: true },
  },
  [CANDIDATE_TARGET_ID]: {
    id: CANDIDATE_TARGET_ID,
    providerID: "openai",
    modelID: "gpt-6-sol",
    kind: "cloud",
    capacity: null,
    source: "subscription-oauth",
    tiers: ["worker"],
    fit: { worker: 9 },
    family: "gpt-sol",
    releaseDate: "2026-09-22",
    speed: "standard",
    context: 400_000,
    output: 96_000,
    variants: ["low", "medium"],
    capabilities: { toolCall: true },
  },
});

const rolePolicy = (overrides = {}) => ({
  roleKey: ROLE,
  providerID: "openai",
  incumbentModelID: "gpt-5.6-sol",
  activeModelID: "gpt-5.6-sol",
  probationModelID: "gpt-6-sol",
  rollbackModelID: "gpt-5.6-sol",
  routingIntent: {
    tiers: ["smart"],
    fit: { smart: 1.25 },
    effortCeiling: "high",
    requiredReasoningMode: null,
  },
  probation: {
    phase: "probation",
    offerEvery: 5,
    opportunityCursor: 0,
    leases: {},
  },
  ...overrides,
});

const registrationWith = (...modelKeys) => ({
  generation: 1,
  manifestHash: "a".repeat(64),
  modelKeys,
  compatible: true,
  reason: null,
});

const args = (overrides = {}) => ({
  targetIDs: [INCUMBENT_TARGET_ID, STALE_TARGET_ID, CANDIDATE_TARGET_ID],
  targets: targets(),
  modelPolicy: { version: 1, roles: { [ROLE]: rolePolicy() }, history: [] },
  registration: registrationWith(INCUMBENT_MODEL_KEY, CANDIDATE_MODEL_KEY),
  activeLeases: [],
  tier: "smart",
  enabled: true,
  ...overrides,
});

test("disabled policy is identity and governed roles hold unnamed models", () => {
  const input = args();
  const disabled = resolvePolicyLane({ ...input, enabled: false });
  assert.deepEqual(disabled.targetIDs, input.targetIDs);
  assert.notEqual(disabled.targetIDs, input.targetIDs);
  assert.equal(disabled.targets, input.targets);
  assert.equal(disabled.policyTargetID, null);
  assert.equal(disabled.reason, null);
  assert.equal(disabled.blockedGeneration, false);

  const held = resolvePolicyLane({
    ...input,
    modelPolicy: {
      version: 1,
      roles: { [ROLE]: rolePolicy({ probationModelID: null }) },
      history: [],
    },
  });
  assert.deepEqual(held.targetIDs, [INCUMBENT_TARGET_ID]);
  assert.equal(held.reason, "model-policy-active");
});

test("new clients may see the candidate while old legacy forged and cleaned clients receive the incumbent", () => {
  const current = resolvePolicyLane(args({
    registration: { ...registrationWith(INCUMBENT_MODEL_KEY, CANDIDATE_MODEL_KEY), generation: -999 },
  }));
  assert.equal(current.policyTargetID, CANDIDATE_TARGET_ID,
    "exact manifest membership, not numeric generation ordering, admits the candidate");

  for (const reason of ["missing-token", "invalid-token", "future-generation", "cleaned-generation"]) {
    const old = resolvePolicyLane(args({
      registration: {
        generation: 0,
        manifestHash: null,
        modelKeys: [INCUMBENT_MODEL_KEY],
        compatible: true,
        reason,
      },
    }));
    assert.deepEqual(old.targetIDs, [INCUMBENT_TARGET_ID], reason);
    assert.equal(old.policyTargetID, null, reason);
    assert.equal(old.blockedGeneration, true, reason);
  }
});

test("candidate metadata stays fresh while routing intent is inherited and effort is clamped", () => {
  const input = args();
  const beforeTargets = structuredClone(input.targets);
  const beforePolicy = structuredClone(input.modelPolicy);
  const lane = resolvePolicyLane(input);
  const candidate = lane.targets[CANDIDATE_TARGET_ID];

  assert.notEqual(lane.targets, input.targets);
  assert.deepEqual(candidate.tiers, ["smart"]);
  assert.deepEqual(candidate.fit, { smart: 1.25 });
  assert.deepEqual(candidate.effort, { smart: "medium" });
  assert.equal(candidate.context, 400_000);
  assert.equal(candidate.output, 96_000);
  assert.deepEqual(candidate.variants, ["low", "medium"]);
  assert.equal(candidate.effortCeiling, "medium");
  assert.equal(candidate.providerID, "openai");
  assert.equal(candidate.modelID, "gpt-6-sol");
  assert.equal(candidate.source, "subscription-oauth");
  assert.deepEqual(input.targets, beforeTargets);
  assert.deepEqual(input.modelPolicy, beforePolicy);
});

test("missing required mode or capability blocks the candidate and an active candidate lease blocks another", () => {
  const requiringHigh = structuredClone(args().modelPolicy);
  requiringHigh.roles[ROLE].routingIntent.requiredReasoningMode = "high";
  assert.equal(resolvePolicyLane(args({ modelPolicy: requiringHigh })).policyTargetID, null);

  const missingCapability = targets();
  missingCapability[CANDIDATE_TARGET_ID].capabilities.toolCall = false;
  assert.equal(resolvePolicyLane(args({ targets: missingCapability })).policyTargetID, null);

  assert.equal(resolvePolicyLane(args({
    activeLeases: [{ sessionID: "candidate-one", targetID: CANDIDATE_TARGET_ID }],
  })).policyTargetID, null);
});

test("probation is offered only on bounded cursor slots and never escapes profile or tier boundaries", () => {
  const betweenSlots = structuredClone(args().modelPolicy);
  betweenSlots.roles[ROLE].probation.opportunityCursor = 1;
  assert.deepEqual(resolvePolicyLane(args({ modelPolicy: betweenSlots })).targetIDs, [INCUMBENT_TARGET_ID]);

  const profileLane = resolvePolicyLane(args({ targetIDs: [INCUMBENT_TARGET_ID] }));
  assert.deepEqual(profileLane.targetIDs, [INCUMBENT_TARGET_ID]);
  assert.equal(profileLane.policyTargetID, null, "a candidate outside the expanded profile lane is not borrowed");

  const wrongTier = resolvePolicyLane(args({ tier: "worker" }));
  assert.deepEqual(wrongTier.targetIDs, []);
  assert.equal(wrongTier.policyTargetID, null);
});

test("active policy replaces the static incumbent while old generations use the rollback anchor", () => {
  const activePolicy = structuredClone(args().modelPolicy);
  Object.assign(activePolicy.roles[ROLE], {
    activeModelID: "gpt-6-sol",
    probationModelID: null,
    probation: { ...activePolicy.roles[ROLE].probation, phase: "active" },
  });

  const current = resolvePolicyLane(args({ modelPolicy: activePolicy }));
  assert.deepEqual(current.targetIDs, [CANDIDATE_TARGET_ID]);
  assert.equal(current.blockedGeneration, false);

  const old = resolvePolicyLane(args({
    modelPolicy: activePolicy,
    registration: registrationWith(INCUMBENT_MODEL_KEY),
  }));
  assert.deepEqual(old.targetIDs, [INCUMBENT_TARGET_ID]);
  assert.equal(old.blockedGeneration, true);
});

test("rollback and rejection holds outrank automatic release sorting", () => {
  const heldPolicy = structuredClone(args().modelPolicy);
  Object.assign(heldPolicy.roles[ROLE], {
    probationModelID: null,
    probation: { ...heldPolicy.roles[ROLE].probation, phase: "rolled-back" },
  });
  const lane = resolvePolicyLane(args({
    targetIDs: [CANDIDATE_TARGET_ID, STALE_TARGET_ID, INCUMBENT_TARGET_ID],
    modelPolicy: heldPolicy,
  }));
  assert.deepEqual(lane.targetIDs, [INCUMBENT_TARGET_ID]);
});

test("a new role with no incumbent stays explicitly unrouted and cannot borrow a sibling", () => {
  const astraPolicy = rolePolicy({
    roleKey: "openai:gpt-astra",
    incumbentModelID: null,
    activeModelID: null,
    probationModelID: "gpt-6-astra",
    rollbackModelID: null,
    routingIntent: {
      tiers: ["deep"], fit: { deep: 1.5 }, effortCeiling: "xhigh", requiredReasoningMode: null,
    },
    probation: { ...rolePolicy().probation, opportunityCursor: 1 },
  });
  const astraTargets = {
    old: {
      id: "old", providerID: "openai", modelID: "gpt-5-astra", kind: "cloud",
      tiers: ["deep"], variants: ["high"], capabilities: { toolCall: true },
    },
    candidate: {
      id: "candidate", providerID: "openai", modelID: "gpt-6-astra", kind: "cloud",
      tiers: ["deep"], variants: ["high", "xhigh"], capabilities: { toolCall: true },
    },
  };
  const lane = resolvePolicyLane({
    targetIDs: ["old", "candidate"],
    targets: astraTargets,
    modelPolicy: { version: 1, roles: { "openai:gpt-astra": astraPolicy }, history: [] },
    registration: registrationWith("openai/gpt-5-astra", "openai/gpt-6-astra"),
    activeLeases: [],
    tier: "deep",
    enabled: true,
  });
  assert.deepEqual(lane.targetIDs, []);
  assert.equal(lane.policyTargetID, null);
});
