import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLE,
  TRANSITION_ID,
  TRUSTED_ANTHROPIC_55,
  TRUSTED_OPENAI_GPT6,
  VALID_PROBE_REQUEST,
  createModelReconcileRuntime,
} from "./helpers/model-reconcile-runtime.mjs";

test("GPT6 overlay promotes after five successes and rolls back after two post-active failures", async (context) => {
  const runtime = await createModelReconcileRuntime({
    applyEnabled: true,
    baseModels: ["openai/gpt-5.6-sol"],
    realProbeHelper: true,
  });
  context.after(() => runtime.close());

  await runtime.discover(TRUSTED_OPENAI_GPT6);
  await runtime.applier.apply({ transitionID: runtime.transitionID(ROLE) });
  assert.equal(runtime.probeBrokerSocketPath(), runtime.actualBrokerSocketPath());
  assert.equal(runtime.actualBrokerSocketMode(), 0o600);
  assert.equal(runtime.overlay().entries["openai/gpt-6-sol"].model.cost.input, 0);
  assert.equal(runtime.currentManifest().modelKeys.includes("openai/gpt-6-sol"), true);
  assert.deepEqual(runtime.probeTrace(), [
    "probe-launch",
    "child-register",
    "child-model-policy-probe", "ordinary-gateway", "release",
    "child-model-policy-probe", "ordinary-gateway", "release",
    "child-model-policy-probe", "ordinary-gateway", "release",
    "reap",
  ]);
  assert.equal(runtime.probeGeneration(), runtime.currentGeneration());
  assert.equal(runtime.parentProbeNetworkCalls(), 0);
  assert.equal(runtime.probeChildReaped(), true);
  const activeEffects = runtime.effectCounts();
  assert.equal(activeEffects.brokerMutations > 0, true);
  assert.deepEqual({ ...activeEffects, brokerMutations: "observed" }, {
    launchNonces: 1,
    assignments: 3,
    leases: 3,
    safeRegistrations: 1,
    resolverRuns: 2,
    brokerMutations: "observed",
    externalCalls: 3,
  });

  const oldClient = await runtime.registerGeneration(0);
  const newClient = await runtime.registerCurrentGeneration();
  assert.equal((await runtime.lease({ client: oldClient, tier: "smart" })).modelID, "gpt-5.6-sol");
  const forbidden = await runtime.postProbeWithToken(newClient.resolverToken, VALID_PROBE_REQUEST);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "probe-process-required");

  for (let index = 0; index < 5; index += 1) {
    await runtime.successfulCandidateLease(newClient, `lease-${index}`);
  }
  assert.equal(runtime.policy(ROLE).activeModelID, "gpt-6-sol");

  await runtime.failCandidate("post-1", "model-not-found");
  await runtime.failCandidate("post-2", "unsupported-model-parameter");
  assert.equal(runtime.policy(ROLE).activeModelID, "gpt-5.6-sol");
  assert.equal((await runtime.lease({ client: oldClient, tier: "smart" })).modelID, "gpt-5.6-sol");
});

test("trusted Anthropic api is admitted while default-off runtime mutates nothing", async (context) => {
  const active = await createModelReconcileRuntime({ applyEnabled: true });
  context.after(() => active.close());
  assert.equal((await active.discover(TRUSTED_ANTHROPIC_55)).source, "subscription-trusted");

  const dormant = await createModelReconcileRuntime({ applyEnabled: false });
  context.after(() => dormant.close());
  const noEffects = {
    launchNonces: 0,
    assignments: 0,
    leases: 0,
    safeRegistrations: 0,
    resolverRuns: 0,
    brokerMutations: 0,
    externalCalls: 0,
  };
  const rollbackCAS = {
    transitionID: `${TRANSITION_ID}:rollback`,
    revision: "disabled-logical-rollback",
    roleKey: ROLE,
    expectedIncumbentModelID: "gpt-6-sol",
    generation: 1,
    manifestHash: "a".repeat(64),
    desired: {
      activeModelID: "gpt-5.6-sol",
      probationModelID: null,
      rollbackModelID: "gpt-5.6-sol",
      routingIntent: {
        tiers: ["smart"],
        fit: { smart: 1.4 },
        effortCeiling: "high",
        requiredReasoningMode: null,
      },
      probation: {
        phase: "rolled-back",
        offerEvery: 5,
        opportunityCursor: 0,
        opportunityMs: 0,
        opportunityCursorAt: null,
        opportunityEligibleUntil: null,
        successes: [],
        failures: [],
        leases: {},
      },
    },
  };
  for (const [name, expectedStatus, operation] of [
    ["CLI apply", 1, () => dormant.runCLI(["apply", TRANSITION_ID, "--json"])],
    ["CLI rollback", 1, () => dormant.runCLI(["rollback", TRANSITION_ID, "--reason", "operator-request", "--json"])],
    ["CLI refresh", 1, () => dormant.runCLI(["refresh", "--json"])],
    ["CLI recover", 1, () => dormant.runCLI(["recover", TRANSITION_ID, "--json"])],
    ["CAS", 409, () => dormant.postControl("/model-policy/cas", {})],
    ["logical rollback CAS", 409, () => dormant.postControl("/model-policy/cas", rollbackCAS)],
    ["probe launch", 409, () => dormant.postControl("/model-policy/probe-launch", {})],
    ["probe", 409, () => dormant.postControl("/model-policy/probe", {})],
    ["probe consume", 409, () => dormant.postControl("/probe/consume", {})],
    ["probe release", 409, () => dormant.postControl("/probe/release", {})],
    ["resolver registration", 409, () => dormant.postControl("/resolver-process/register", {})],
  ]) {
    const before = dormant.snapshotBytesAndMtimes();
    const result = await operation();
    assert.equal(result.status, expectedStatus, name);
    assert.equal(result.body.code, "reconcile-apply-disabled", name);
    assert.deepEqual(dormant.snapshotBytesAndMtimes(), before, name);
    assert.deepEqual(dormant.effectCounts(), noEffects, name);
  }
});
