import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const R = await import("../lib/routing.js");

test("the tier ladder is a cost ladder", () => {
  assert.equal(R.tierForAgent("scout"), "worker");
  assert.equal(R.tierForAgent("grunt"), "worker");
  assert.equal(R.tierForAgent("reviewer"), "review");
  assert.equal(R.tierForAgent("researcher"), "smart",
    "a researcher decides what to trust, not just what to judge");
  // ☠️ A verifier outranks the panel it checks: breaking a claim -- proving the failure is
  // reachable and no upstream guard already covers it -- is harder than raising it, and a
  // verifier level with the proposer confirms what it cannot disprove.
  assert.equal(R.tierForAgent("verifier"), "smart");
  assert.equal(R.tierForAgent("review-verifier"), "smart");
  // Mechanical: runs the given command, pastes the tail, may not edit source.
  assert.equal(R.tierForAgent("tester"), "worker");
  assert.equal(R.tierForAgent("build"), "build");
  assert.equal(R.tierForAgent("smart"), "smart");
  assert.equal(R.tierForAgent("plan"), "smart");
  assert.equal(R.tierForAgent("deep"), "deep");
  assert.equal(R.tierForAgent("general", { parentTier: "deep" }), "deep", "general inherits");
  assert.equal(R.desiredVariantForTier("review"), null,
    "review's saving is the model class; low reasoning is the wrong economy for judgment");
  // deep aims at xhigh (stock Claude's frontier level); smart/build at high;
  // worker/fast-build at medium; classifier at low.
  assert.equal(R.desiredVariantForTier("deep"), "xhigh");
  assert.equal(R.desiredVariantForTier("smart"), "high");
  assert.equal(R.desiredVariantForTier("build"), "high");
  assert.equal(R.desiredVariantForTier("worker"), "medium");
  assert.equal(R.desiredVariantForTier("fast-build"), "medium");
  // An ordered preference, not one level: `none` is exactly right for a one-word verdict and
  // is what makes a REASONING model usable on this lane at all, with `low` for a model that
  // does not offer it. modelRefForTier takes the first the model advertises.
  assert.deepEqual(R.desiredVariantForTier("classifier"), ["none", "low"]);
});

test("fable discovery lands in deep only; sonnet serves build and review", () => {
  const discovered = R.discoverSubscriptionTargets({ connected: ["anthropic"], all: [{
    id: "anthropic",
    models: {
      "claude-fable-5": { id: "claude-fable-5", family: "claude-fable", release_date: "2026-06-07", tool_call: true },
      "claude-sonnet-5": { id: "claude-sonnet-5", family: "claude-sonnet", release_date: "2026-06-29", tool_call: true },
    },
  }] }, { anthropic: "oauth" }).targets;
  const fable = Object.values(discovered).find((t) => t.modelID === "claude-fable-5");
  const sonnet = Object.values(discovered).find((t) => t.modelID === "claude-sonnet-5");
  assert.deepEqual(fable.tiers, ["deep"]);
  assert.deepEqual(sonnet.tiers, ["build", "review"]);
  const targets = { ...R.TARGETS, ...discovered };
  assert.deepEqual(R.targetIDsFor("auto", "deep", targets), ["gpt-pro", "qwen-max", fable.id], "deep is a POOL, not a single model");
  assert.equal(R.targetIDsFor("auto", "smart", targets).includes(fable.id), false, "smart no longer pays 2x credits");
  assert.equal(R.targetIDsFor("auto", "review", targets).includes(sonnet.id), true);
});

test("deep falls back to the smart lane, review to terra then luna", () => {
  const discovered = R.discoverSubscriptionTargets({ connected: ["anthropic"], all: [{
    id: "anthropic",
    models: { "claude-fable-5": { id: "claude-fable-5", family: "claude-fable", release_date: "2026-06-07", tool_call: true } },
  }] }, { anthropic: "oauth" }).targets;
  const targets = { ...R.TARGETS, ...discovered };
  const fableID = Object.keys(discovered)[0];
  const emergency = R.chooseTarget({ profile: "auto", tier: "deep", targets,
    circuits: { [fableID]: { until: null }, "gpt-pro": { until: null }, "qwen-max": { until: null } } });
  assert.equal(emergency.target.id, "gpt-flagship");
  assert.equal(emergency.decision.policy, "strict-fallback");
  const review = R.chooseTarget({ profile: "auto", tier: "review", circuits: { "glm": { until: null }, "deepseek-pro": { until: null } } });
  assert.equal(review.target.id, "gpt-terra");
});

test("tier provider weights lean a tier into a provider without exhausting it blindly", () => {
  const discovered = R.discoverSubscriptionTargets({ connected: ["anthropic"], all: [{
    id: "anthropic",
    models: { "claude-sonnet-5": { id: "claude-sonnet-5", family: "claude-sonnet", release_date: "2026-06-29", tool_call: true } },
  }] }, { anthropic: "oauth" }).targets;
  const targets = { ...R.TARGETS, ...discovered };
  const sonnetID = Object.keys(discovered)[0];
  const weights = { build: { anthropic: 3 } };
  const budgetConfig = {
    anthropic: { windows: [{ id: "w", periodMs: 1e9, meter: "requests", capacity: 100 }] },
    openai: { windows: [{ id: "w", periodMs: 1e9, meter: "requests", capacity: 100 }] },
  };
  // All-zero utilization: the weighted provider absorbs the tier.
  const fresh = R.chooseTarget({ profile: "auto", tier: "build", targets, tierWeights: weights, budgetConfig });
  assert.equal(fresh.target.id, sonnetID);
  assert.ok(fresh.decision.reasons.includes("tier-provider-preference"), String(fresh.decision.reasons));
  // Weighted provider at 3x the others' utilization: effective headroom equalizes,
  // the tier stops leaning.
  const now = Date.now();
  let budgets = {};
  const spend = (provider, n) => { for (let i = 0; i < n; i++) budgets = R.recordBudgetUsage(budgets, provider, { requests: 1 }, now, budgetConfig); };
  spend("anthropic", 60); spend("openai", 10);
  const tilted = R.chooseTarget({ profile: "auto", tier: "build", targets, tierWeights: weights, budgets, budgetConfig, now });
  assert.notEqual(tilted.target.providerID, "anthropic", "0.6/3 = 0.2 effective vs openai 0.1: anthropic yields");
  // Down-weighting saves a provider for other tiers even at equal utilization.
  const saved = R.chooseTarget({ profile: "auto", tier: "build", targets, tierWeights: { build: { anthropic: 0.5 } }, budgetConfig });
  assert.notEqual(saved.target.providerID, "anthropic");
});
