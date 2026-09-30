import assert from "node:assert/strict";
import test from "node:test";

import {
  OPPORTUNITY_TIMEOUT_MS,
  OPPORTUNITY_WINDOW_MS,
  PROBATION_SUCCESS_THRESHOLD,
  QUALIFYING_FAILURE_THRESHOLD,
  QUALIFYING_FAILURE_WINDOW_MS,
} from "../lib/model-lease.js";
import {
  accrueOpportunityTime,
  classifyModelPolicyFailure,
  recordCandidateLease,
  settleCandidateOutcome,
} from "../lib/model-probation.js";
import { compareAndSwapModelPolicy, emptyModelPolicy, normalizeModelPolicy } from "../lib/model-policy.js";
import { normalizeModelRoles } from "../lib/model-roles.js";

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

const desiredPolicy = ({ incumbent = "gpt-5.6-sol" } = {}) => ({
  activeModelID: incumbent,
  probationModelID: "gpt-6-sol",
  rollbackModelID: incumbent,
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
    opportunityMs: 0,
    opportunityCursorAt: null,
    opportunityEligibleUntil: null,
    successes: [],
    failures: [],
    leases: {},
  },
});

const probationPolicy = ({ incumbent = "gpt-5.6-sol" } = {}) => compareAndSwapModelPolicy(
  emptyModelPolicy(),
  {
    transitionID: "transition-openai-sol-gpt6",
    revision: "revision-2",
    roleKey: ROLE,
    expectedIncumbentModelID: incumbent,
    generation: 4,
    manifestHash: MANIFEST_HASH,
    desired: desiredPolicy({ incumbent }),
  },
  { now: () => NOW },
).policy;

const lease = (policy, leaseID, at = NOW, options = {}) => recordCandidateLease(policy, {
  roleKey: ROLE,
  leaseID,
  sessionID: options.sessionID ?? `ses-${leaseID}`,
  now: at,
  synthetic: options.synthetic,
});

const settle = (policy, leaseID, outcome, at = NOW, options = {}) => settleCandidateOutcome(policy, {
  roleKey: ROLE,
  leaseID,
  sessionID: options.sessionID ?? `ses-${leaseID}`,
  outcome,
  failureClass: options.failureClass,
  source: options.source ?? (outcome === "success" ? "complete" : "failure"),
  now: at,
});

const promote = (policy = probationPolicy()) => {
  for (let index = 0; index < PROBATION_SUCCESS_THRESHOLD; index += 1) {
    ({ policy } = lease(policy, `success-${index}`, NOW + index));
    ({ policy } = settle(policy, `success-${index}`, "success", NOW + index));
  }
  return policy;
};

test("failure classification is closed and only four model-attributable classes qualify", () => {
  const qualifying = [
    "model-not-found",
    "unsupported-model-parameter",
    "invalid-model-tool-call-response",
    "model-entitlement-failure",
  ];
  const excluded = [
    "network-failure",
    "rate-limit",
    "provider-overload",
    "user-cancellation",
    "client-disconnect",
    "tool-execution-failure",
  ];
  for (const classification of qualifying) {
    assert.deepEqual(classifyModelPolicyFailure(classification), { classification, qualifying: true });
  }
  for (const classification of excluded) {
    assert.deepEqual(classifyModelPolicyFailure({ failureClass: classification }), {
      classification,
      qualifying: false,
    });
  }
  for (const failure of [undefined, null, "auth", "MODEL-NOT-FOUND", {}, { failureClass: 7 }]) {
    assert.deepEqual(classifyModelPolicyFailure(failure), { classification: "unknown", qualifying: false });
  }
  assert.equal(QUALIFYING_FAILURE_THRESHOLD, 2);
  assert.equal(QUALIFYING_FAILURE_WINDOW_MS, 15 * 60_000);
});

test("five distinct production successes promote and complete plus usage counts once", () => {
  let policy = probationPolicy();
  for (let index = 0; index < PROBATION_SUCCESS_THRESHOLD; index += 1) {
    const leaseID = `lease-${index}`;
    ({ policy } = lease(policy, leaseID, NOW + index));
    ({ policy } = settle(policy, leaseID, "success", NOW + index, { source: "complete" }));
    const beforeReplay = structuredClone(policy);
    const replay = settle(policy, leaseID, "success", NOW + index + 1, { source: "usage" });
    assert.equal(replay.event.replayed, true);
    assert.deepEqual(replay.policy, beforeReplay);
    policy = replay.policy;
  }
  assert.equal(policy.roles[ROLE].activeModelID, "gpt-6-sol");
  assert.equal(policy.roles[ROLE].probationModelID, null);
  assert.equal(policy.roles[ROLE].probation.phase, "active");
  assert.deepEqual(policy.roles[ROLE].probation.successes,
    ["lease-0", "lease-1", "lease-2", "lease-3", "lease-4"]);
  assert.equal(policy.roles[ROLE].rollbackModelID, "gpt-5.6-sol");
});

test("post-promotion successes settle without growing the completed five-success counter", () => {
  let policy = promote();
  ({ policy } = lease(policy, "active-success", NOW + 10));
  ({ policy } = settle(policy, "active-success", "success", NOW + 10));
  assert.deepEqual(policy.roles[ROLE].probation.successes,
    ["success-0", "success-1", "success-2", "success-3", "success-4"]);
  assert.equal(policy.roles[ROLE].probation.leases["active-success"].settlement.outcome, "success");
});

test("lease and session identity make duplicate contradictory and forged settlements inert or invalid", () => {
  let policy = probationPolicy();
  ({ policy } = lease(policy, "bound", NOW, { sessionID: "ses-bound" }));
  const beforeWrongSession = structuredClone(policy);
  assert.throws(() => settleCandidateOutcome(policy, {
    roleKey: ROLE,
    leaseID: "bound",
    sessionID: "ses-other",
    outcome: "success",
    source: "complete",
    now: NOW,
  }), /session.*mismatch/i);
  assert.deepEqual(policy, beforeWrongSession);
  assert.throws(() => settleCandidateOutcome(policy, {
    roleKey: ROLE,
    leaseID: "forged",
    sessionID: "ses-forged",
    outcome: "success",
    source: "complete",
    now: NOW,
  }), /unknown lease/i);

  ({ policy } = settleCandidateOutcome(policy, {
    roleKey: ROLE,
    leaseID: "bound",
    sessionID: "ses-bound",
    outcome: "success",
    source: "complete",
    now: NOW,
  }));
  const beforeContradiction = structuredClone(policy);
  const contradiction = settleCandidateOutcome(policy, {
    roleKey: ROLE,
    leaseID: "bound",
    sessionID: "ses-bound",
    outcome: "failure",
    failureClass: "model-not-found",
    source: "failure",
    now: NOW + 1,
  });
  assert.equal(contradiction.event.replayed, true);
  assert.deepEqual(contradiction.policy, beforeContradiction);
  assert.deepEqual(contradiction.policy.roles[ROLE].probation.failures, []);
});

test("an exactly bound delayed settlement remains valid without an independent settlement window", () => {
  let policy = probationPolicy();
  ({ policy } = lease(policy, "delayed"));
  ({ policy } = settle(policy, "delayed", "success", NOW + 24 * 60 * 60_000, { source: "usage" }));
  assert.deepEqual(policy.roles[ROLE].probation.successes, ["delayed"]);
});

test("synthetic abandoned transient and unknown outcomes remain neutral while unknown is recorded", () => {
  let policy = probationPolicy();
  ({ policy } = lease(policy, "probe", NOW, { sessionID: "gw-probe-test", synthetic: true }));
  ({ policy } = settle(policy, "probe", "success", NOW, { sessionID: "gw-probe-test" }));
  assert.deepEqual(policy.roles[ROLE].probation.successes, []);

  for (const [leaseID, outcome, failureClass, source] of [
    ["abandoned", "abandoned", undefined, "expiry"],
    ["network", "failure", "network-failure", "failure"],
    ["mystery", "failure", "future-failure", "failure"],
  ]) {
    ({ policy } = lease(policy, leaseID));
    ({ policy } = settle(policy, leaseID, outcome, NOW, { failureClass, source }));
  }
  assert.deepEqual(policy.roles[ROLE].probation.failures, []);
  assert.equal(policy.roles[ROLE].probation.leases.mystery.settlement.failureClass, "unknown");
  assert.equal(policy.roles[ROLE].probation.leases.abandoned.settlement.outcome, "abandoned");
});

test("two qualifying failures roll back during probation and after activation", () => {
  for (const initial of [probationPolicy(), promote()]) {
    let policy = initial;
    for (const [leaseID, offset] of [["bad-1", 0], ["bad-2", QUALIFYING_FAILURE_WINDOW_MS - 1]]) {
      ({ policy } = lease(policy, leaseID, NOW + offset));
      ({ policy } = settle(policy, leaseID, "failure", NOW + offset, {
        failureClass: "model-not-found",
      }));
    }
    assert.equal(policy.roles[ROLE].activeModelID, "gpt-5.6-sol");
    assert.equal(policy.roles[ROLE].probationModelID, null);
    assert.equal(policy.roles[ROLE].probation.phase, "rolled-back");
    assert.equal(policy.roles[ROLE].rollbackReason, "model-failure-threshold");
  }
});

test("qualifying failures outside the rolling window do not combine", () => {
  let policy = probationPolicy();
  ({ policy } = lease(policy, "old", NOW));
  ({ policy } = settle(policy, "old", "failure", NOW, { failureClass: "model-not-found" }));
  ({ policy } = lease(policy, "new", NOW + QUALIFYING_FAILURE_WINDOW_MS + 1));
  ({ policy } = settle(policy, "new", "failure", NOW + QUALIFYING_FAILURE_WINDOW_MS + 1, {
    failureClass: "unsupported-model-parameter",
  }));
  assert.equal(policy.roles[ROLE].probation.phase, "probation");
  assert.deepEqual(policy.roles[ROLE].probation.failures.map((failure) => failure.leaseID), ["new"]);
});

test("persisted policy rejects excluded failures forged into the qualifying window", () => {
  let policy = probationPolicy();
  ({ policy } = lease(policy, "forged-failure"));
  policy.roles[ROLE].probation.failures.push({
    leaseID: "forged-failure",
    sessionID: "ses-forged-failure",
    failureClass: "network-failure",
    at: NOW,
  });
  assert.throws(() => normalizeModelPolicy(policy, {
    modelRoles: MODEL_ROLES,
    staticTargets: STATIC_TARGETS,
  }), /failures.*qualifying|network-failure/i);
});

test("eligible windows are bounded while old-only and silent periods pause across restart", () => {
  let policy = probationPolicy();
  let result = accrueOpportunityTime(policy, {
    roleKey: ROLE,
    now: NOW,
    compatibleActiveRegistration: true,
    eligibleCandidateRequest: true,
  });
  assert.notEqual(result.policy, policy);
  policy = result.policy;
  assert.equal(result.accruedMs, 0);
  assert.equal(policy.roles[ROLE].probation.opportunityEligibleUntil, null,
    "traffic before the first candidate lease does not start the timeout");

  ({ policy } = lease(policy, "first"));
  result = accrueOpportunityTime(policy, {
    roleKey: ROLE,
    now: NOW,
    compatibleActiveRegistration: true,
    eligibleCandidateRequest: true,
  });
  policy = result.policy;
  assert.equal(result.accruedMs, 0, "the first request opens a future window");
  assert.equal(policy.roles[ROLE].probation.opportunityEligibleUntil, NOW + OPPORTUNITY_WINDOW_MS);
  assert.equal(policy.roles[ROLE].probation.opportunityCursorAt, NOW);

  policy = normalizeModelPolicy(JSON.parse(JSON.stringify(policy)), {
    modelRoles: MODEL_ROLES,
    staticTargets: STATIC_TARGETS,
  });
  result = accrueOpportunityTime(policy, {
    roleKey: ROLE,
    now: NOW + 86_400_000,
    compatibleActiveRegistration: false,
    eligibleCandidateRequest: true,
  });
  policy = result.policy;
  assert.equal(result.accruedMs, OPPORTUNITY_WINDOW_MS, "silence adds only the prior bounded window");
  assert.equal(policy.roles[ROLE].probation.opportunityMs, OPPORTUNITY_WINDOW_MS);
  assert.equal(policy.roles[ROLE].probation.opportunityEligibleUntil, null,
    "old-only traffic closes the window");
  assert.equal(policy.roles[ROLE].probation.opportunityCursorAt, null);
});

test("timeout requires seven cumulative eligible opportunity-days and restores explicit null", () => {
  let policy = probationPolicy({ incumbent: null });
  ({ policy } = lease(policy, "first"));
  let result = accrueOpportunityTime(policy, {
    roleKey: ROLE,
    now: NOW,
    compatibleActiveRegistration: true,
    eligibleCandidateRequest: true,
  });
  policy = result.policy;
  for (let window = 1; window <= OPPORTUNITY_TIMEOUT_MS / OPPORTUNITY_WINDOW_MS; window += 1) {
    result = accrueOpportunityTime(policy, {
      roleKey: ROLE,
      now: NOW + window * OPPORTUNITY_WINDOW_MS,
      compatibleActiveRegistration: true,
      eligibleCandidateRequest: true,
    });
    policy = result.policy;
  }
  assert.equal(result.timedOut, true);
  assert.equal(result.accruedMs, OPPORTUNITY_WINDOW_MS);
  assert.equal(policy.roles[ROLE].activeModelID, null);
  assert.equal(policy.roles[ROLE].probationModelID, null);
  assert.equal(policy.roles[ROLE].rollbackReason, "probation-timeout");
  assert.equal(policy.roles[ROLE].probation.opportunityMs, 7 * 24 * 60 * 60_000);
});
