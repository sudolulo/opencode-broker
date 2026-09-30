import assert from "node:assert/strict";
import test from "node:test";

import { normalizeModelRoles } from "../lib/model-roles.js";
import {
  MODEL_POLICY_VERSION,
  compareAndSwapModelPolicy,
  emptyModelPolicy,
  isLoopbackControlAddress,
  normalizeModelPolicy,
} from "../lib/model-policy.js";

const ROLE = "openai:gpt-sol";
const NOW = 1_800_000_000_000;
const MANIFEST_HASH = "a".repeat(64);
const MODEL_ROLES = normalizeModelRoles({}, { warn: () => {} });
const STATIC_TARGETS = {
  "gpt-flagship": {
    id: "gpt-flagship",
    providerID: "openai",
    modelID: "gpt-5.6-sol",
    kind: "cloud",
  },
};

const desiredPolicy = (overrides = {}) => ({
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
    phase: "staged-probing",
    offerEvery: 5,
    opportunityCursor: 0,
    opportunityMs: 0,
    opportunityCursorAt: null,
    opportunityEligibleUntil: null,
    successes: [],
    failures: [],
    leases: {},
  },
  ...overrides,
});

const policyRequest = (overrides = {}) => ({
  transitionID: "transition-openai-sol-gpt6",
  revision: "revision-2",
  roleKey: ROLE,
  expectedIncumbentModelID: "gpt-5.6-sol",
  generation: 4,
  manifestHash: MANIFEST_HASH,
  desired: desiredPolicy(),
  ...overrides,
});

const seededPolicy = () => compareAndSwapModelPolicy(
  emptyModelPolicy(),
  policyRequest(),
  { now: () => NOW },
).policy;

test("normalized model-policy schema keeps explicit role identity and runtime counters", () => {
  const normalized = normalizeModelPolicy(seededPolicy(), {
    modelRoles: MODEL_ROLES,
    staticTargets: STATIC_TARGETS,
  });
  assert.equal(normalized.version, MODEL_POLICY_VERSION);
  assert.deepEqual(Object.keys(normalized), ["version", "roles", "history"]);
  assert.deepEqual(normalized.roles[ROLE], {
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
    introduction: { generation: 4, manifestHash: MANIFEST_HASH },
    probation: {
      phase: "staged-probing",
      offerEvery: 5,
      opportunityCursor: 0,
      opportunityMs: 0,
      opportunityCursorAt: null,
      opportunityEligibleUntil: null,
      successes: [],
      failures: [],
      leases: {},
    },
    revision: "revision-2",
    transitionID: "transition-openai-sol-gpt6",
    history: normalized.history,
  });
  assert.notEqual(normalized, seededPolicy(), "normalization returns a clone");
});

test("model-policy normalization rejects unknown fields identity mismatch and malformed counters", () => {
  const valid = seededPolicy();
  const cases = [
    ["unknown top-level field", (value) => { value.future = true; }, /unsupported.*future/i],
    ["unknown role field", (value) => { value.roles[ROLE].future = true; }, /unsupported.*future/i],
    ["provider mismatch", (value) => { value.roles[ROLE].providerID = "anthropic"; }, /provider.*mismatch/i],
    ["model mismatch", (value) => { value.roles[ROLE].probationModelID = "gpt-6-luna"; }, /model.*role|role.*model/i],
    ["malformed counter", (value) => { value.roles[ROLE].probation.opportunityCursor = -1; }, /opportunityCursor.*non-negative/i],
    ["unknown probation field", (value) => { value.roles[ROLE].probation.magic = 1; }, /unsupported.*magic/i],
    ["unknown version", (value) => { value.version = 99; }, /model policy version/i],
  ];
  for (const [name, mutate, expected] of cases) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => normalizeModelPolicy(changed, {
      modelRoles: MODEL_ROLES,
      staticTargets: STATIC_TARGETS,
    }), expected, name);
  }
});

test("CAS seeds an explicit incumbent and is idempotent for the same transition revision", () => {
  const request = policyRequest({ expectedIncumbentModelID: "gpt-5.6-sol" });
  const first = compareAndSwapModelPolicy(emptyModelPolicy(), request, { now: () => NOW });
  assert.equal(first.changed, true);
  assert.equal(first.policy.roles[ROLE].activeModelID, "gpt-5.6-sol");
  assert.equal(first.policy.roles[ROLE].probationModelID, "gpt-6-sol");
  const replay = compareAndSwapModelPolicy(first.policy, request, { now: () => NOW + 1 });
  assert.equal(replay.changed, false);
  assert.deepEqual(replay.ack, first.ack);
  assert.equal(JSON.stringify(replay.policy), JSON.stringify(first.policy));
});

test("CAS seeds a role with no incumbent as explicitly unrouted", () => {
  const result = compareAndSwapModelPolicy(emptyModelPolicy(), policyRequest({
    expectedIncumbentModelID: null,
    desired: desiredPolicy({ activeModelID: null, rollbackModelID: null }),
  }), { now: () => NOW });
  assert.equal(result.policy.roles[ROLE].incumbentModelID, null);
  assert.equal(result.policy.roles[ROLE].activeModelID, null);
});

test("CAS rejects stale revision and incumbent mismatch without changing bytes", () => {
  const current = seededPolicy();
  const before = JSON.stringify(current);
  for (const request of [
    policyRequest({ revision: "older" }),
    policyRequest({ expectedIncumbentModelID: "wrong" }),
    policyRequest({ transitionID: "next-transition", revision: "revision-3", expectedIncumbentModelID: "wrong" }),
  ]) {
    assert.throws(() => compareAndSwapModelPolicy(current, request), /stale revision|incumbent mismatch/);
    assert.equal(JSON.stringify(current), before);
  }
});

test("CAS rejects changed desired hash generation and manifest on replay without mutation", () => {
  const current = seededPolicy();
  const before = JSON.stringify(current);
  const changedDesired = desiredPolicy({ probationModelID: "gpt-7-sol" });
  for (const [name, request, expected] of [
    ["desired hash", policyRequest({ desired: changedDesired }), /desired policy hash/i],
    ["generation", policyRequest({ generation: 5 }), /generation/i],
    ["manifest", policyRequest({ manifestHash: "b".repeat(64) }), /manifest hash/i],
    ["invalid generation", policyRequest({ generation: -1 }), /generation/i],
  ]) {
    assert.throws(() => compareAndSwapModelPolicy(current, request), expected, name);
    assert.equal(JSON.stringify(current), before, name);
  }
});

test("model-policy control addresses accept local transports and reject non-loopback peers", () => {
  for (const address of [undefined, null, "127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackControlAddress(address), true, String(address));
  }
  for (const address of ["192.168.50.2", "10.0.0.4", "::ffff:192.168.50.2", "2001:db8::1"]) {
    assert.equal(isLoopbackControlAddress(address), false, address);
  }
});
