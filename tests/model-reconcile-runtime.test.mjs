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
  for (const [name, operation] of [
    ["CLI apply", () => dormant.runCLI(["apply", TRANSITION_ID, "--json"])],
    ["CLI rollback", () => dormant.runCLI(["rollback", TRANSITION_ID, "--reason", "operator-request", "--json"])],
    ["CLI refresh", () => dormant.runCLI(["refresh", "--json"])],
    ["CLI recover", () => dormant.runCLI(["recover", TRANSITION_ID, "--json"])],
    ["CAS", () => dormant.postControl("/model-policy/cas", {})],
    ["rollback", () => dormant.postControl("/model-policy/rollback", {})],
    ["probe launch", () => dormant.postControl("/model-policy/probe-launch", {})],
    ["probe", () => dormant.postControl("/model-policy/probe", {})],
    ["probe consume", () => dormant.postControl("/probe/consume", {})],
    ["probe release", () => dormant.postControl("/probe/release", {})],
    ["resolver registration", () => dormant.postControl("/resolver-process/register", {})],
  ]) {
    const before = dormant.snapshotBytesAndMtimes();
    const result = await operation();
    assert.equal(result.code, "reconcile-apply-disabled", name);
    assert.deepEqual(dormant.snapshotBytesAndMtimes(), before, name);
  }
  assert.deepEqual(dormant.effectCounts(), {
    launchNonces: 0,
    assignments: 0,
    leases: 0,
    safeRegistrations: 0,
    resolverRuns: 0,
    brokerMutations: 0,
    externalCalls: 0,
  });
});
