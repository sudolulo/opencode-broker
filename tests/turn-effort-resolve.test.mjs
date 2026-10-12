import assert from "node:assert/strict";
import test from "node:test";

import { canaryHalf, EFFORT_RANK, resolveTurnEffort } from "../lib/turn-effort.js";

const baseInput = {
  advertised: ["low", "medium", "high", "xhigh"],
  ceiling: "xhigh",
  baseVariant: "high",
  modelKey: "openai/gpt-6.1-sol",
  engineEffortUpdates: true,
  sessionID: "session-a",
  turnClass: { class: "hard", reason: "explicit" },
  config: { mode: "enforce", policy: "tier", models: ["openai/gpt-6.1-sol"] },
};

test("exports the canonical effort rank", () => {
  assert.deepEqual(EFFORT_RANK, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("resolves tier and savings policies for a hard turn", () => {
  const result = resolveTurnEffort(baseInput);

  assert.deepEqual(result, {
    eligible: true,
    base: "high",
    policies: { tier: "xhigh", savings: "high" },
    applied: "xhigh",
    clamped: false,
  });
});

test("lowers light turns without stepping below low", () => {
  const result = resolveTurnEffort({
    ...baseInput,
    turnClass: { class: "light", reason: "status" },
  });
  const atFloor = resolveTurnEffort({
    ...baseInput,
    baseVariant: "low",
    turnClass: { class: "light", reason: "status" },
  });

  assert.deepEqual(result.policies, { tier: "medium", savings: "low" });
  assert.deepEqual(atFloor.policies, { tier: "low", savings: "low" });
  assert.equal(atFloor.clamped, true);
});

test("applies the savings policy from its lowered base", () => {
  const result = resolveTurnEffort({
    ...baseInput,
    turnClass: { class: "normal", reason: "default" },
    config: { ...baseInput.config, policy: "savings" },
  });

  assert.equal(result.applied, "medium");
});

test("marks a hard step stopped by the ceiling as clamped", () => {
  const result = resolveTurnEffort({ ...baseInput, ceiling: "high" });

  assert.equal(result.policies.tier, "high");
  assert.equal(result.clamped, true);
});

test("steps by rank rather than advertised ordering and respects the light floor", () => {
  const hard = resolveTurnEffort({
    ...baseInput,
    advertised: ["high", "unknown", "max"],
    ceiling: undefined,
  });
  const light = resolveTurnEffort({
    ...baseInput,
    advertised: ["high", "unknown", "max"],
    ceiling: undefined,
    turnClass: { class: "light", reason: "status" },
  });

  assert.equal(hard.policies.tier, "max");
  assert.equal(light.policies.tier, "high");
  assert.equal(light.clamped, true);
});

test("does not resolve policies without a base variant", () => {
  const result = resolveTurnEffort({ ...baseInput, baseVariant: undefined });

  assert.deepEqual(result, {
    eligible: false,
    base: undefined,
    policies: { tier: undefined, savings: undefined },
    applied: undefined,
    clamped: false,
  });
});

test("keeps the base when each eligibility gate fails", () => {
  const cases = [
    { config: { ...baseInput.config, mode: "off" } },
    { turnClass: undefined },
    { turnClass: { class: "normal", reason: "subagent-seat" } },
    { turnClass: { class: "normal", reason: "classifier-error" } },
    { engineEffortUpdates: false },
    { modelKey: "other/model" },
  ];

  for (const changes of cases) {
    const result = resolveTurnEffort({ ...baseInput, ...changes });
    assert.equal(result.eligible, false);
    assert.equal(result.applied, "high");
  }
});

test("computes policies in shadow mode without applying them", () => {
  const result = resolveTurnEffort({
    ...baseInput,
    config: { ...baseInput.config, mode: "shadow" },
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.policies, { tier: "xhigh", savings: "high" });
  assert.equal(result.applied, "high");
});

test("deterministically applies canary policy to the even session half", () => {
  const sessionIDs = ["canary-a", "canary-b", "canary-c", "canary-d"];
  const zero = sessionIDs.find((sessionID) => canaryHalf(sessionID) === 0);
  const one = sessionIDs.find((sessionID) => canaryHalf(sessionID) === 1);
  assert.ok(zero);
  assert.ok(one);
  assert.equal(canaryHalf(zero), 0);
  assert.equal(canaryHalf(one), 1);

  const config = { ...baseInput.config, mode: "canary" };
  assert.equal(resolveTurnEffort({ ...baseInput, config, sessionID: zero }).applied, "xhigh");
  assert.equal(resolveTurnEffort({ ...baseInput, config, sessionID: one }).applied, "high");
});

test("treats an unknown turn class as absent", () => {
  const result = resolveTurnEffort({
    ...baseInput,
    turnClass: { class: "weird", reason: "default" },
  });

  assert.equal(result.eligible, false);
  assert.equal(result.applied, "high");
});
