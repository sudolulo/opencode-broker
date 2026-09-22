import assert from "node:assert/strict";
import test from "node:test";

// Route the config loader at the fleet-shaped fixture BEFORE any router module
// loads -- config.js reads its file once at import time. The fixture carries NO
// deals, so every deal in this file is injected explicitly and no assertion
// depends on the wall clock.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const { activeDealMultiplier } = await import("../lib/deals.js");
const { recordBudgetUsage } = await import("../lib/budgets.js");
const R = await import("../lib/routing.js");

const NIGHT_DEAL = {
  providerID: "alibaba-token-plan",
  modelPrefix: "deepseek-",
  multiplier: 0.5,
  daily: { start: "22:00", end: "08:00", utcOffsetMinutes: 480 },
};

// 2026-08-31T15:00:00Z = 23:00 UTC+8 -> inside the night window.
const NIGHT = Date.parse("2026-08-31T15:00:00Z");
// 2026-08-31T04:00:00Z = 12:00 UTC+8 -> outside.
const DAY = Date.parse("2026-08-31T04:00:00Z");

test("daily deal windows respect timezone offset and midnight wrap", () => {
  const on = (now) => activeDealMultiplier(
    { providerID: "alibaba-token-plan", modelID: "deepseek-v4-pro-0813" }, now, [NIGHT_DEAL]);
  assert.equal(on(NIGHT), 0.5);
  assert.equal(on(DAY), 1);
  // 07:59 local is still inside; 08:00 is not.
  assert.equal(on(Date.parse("2026-08-31T23:59:00Z")), 0.5);
  assert.equal(on(Date.parse("2026-09-01T00:00:00Z")), 1);
});

test("deal scoping: provider, model prefix, absolute window", () => {
  const scoped = (target, now, deals) => activeDealMultiplier(target, now, deals);
  assert.equal(scoped({ providerID: "openai", modelID: "deepseek-x" }, NIGHT, [NIGHT_DEAL]), 1,
    "wrong provider never matches");
  assert.equal(scoped({ providerID: "alibaba-token-plan", modelID: "qwen3.8-max" }, NIGHT, [NIGHT_DEAL]), 1,
    "prefix limits the deal to matching models");
  const bounded = { providerID: "openai", multiplier: 0.7, window: { from: "2026-08-01T00:00:00Z", to: "2026-08-15T00:00:00Z" } };
  assert.equal(scoped({ providerID: "openai", modelID: "gpt-5.6-luna" }, Date.parse("2026-08-10T00:00:00Z"), [bounded]), 0.7);
  assert.equal(scoped({ providerID: "openai", modelID: "gpt-5.6-luna" }, Date.parse("2026-08-20T00:00:00Z"), [bounded]), 1,
    "an expired deal is inert");
  assert.equal(scoped({ providerID: "openai", modelID: "x" }, NIGHT, []), 1, "no deals means full price");
});

test("selection prefers discounted targets within the balanced set, never across tiers", () => {
  const targets = {
    ...R.TARGETS,
    "gpt-terra": { ...R.TARGETS["gpt-terra"], fit: { build: 1 } },
    "deepseek-pro": { ...R.TARGETS["deepseek-pro"], fit: { build: 1 } },
    glm: { ...R.TARGETS.glm, fit: { build: 1 } },
  };
  const base = { profile: "auto", tier: "build", targets };
  const night = R.chooseTarget({ ...base, now: NIGHT, deals: [NIGHT_DEAL] });
  assert.equal(night.target.id, "deepseek-pro");
  assert.ok(night.decision.reasons.includes("active-usage-deal-x0.5"), String(night.decision.reasons));
  const day = R.chooseTarget({ ...base, now: DAY, deals: [NIGHT_DEAL] });
  assert.equal(day.target.id, "gpt-terra");
  assert.equal(day.decision.reasons.includes("active-usage-deal-x0.5"), false);
  const smart = R.chooseTarget({ profile: "auto", tier: "smart", now: NIGHT, deals: [NIGHT_DEAL] });
  assert.equal(["gpt-flagship", "claude-opus-5"].includes(smart.target.id), true);
});

test("the ledger records discounted spend at the multiplier", () => {
  const config = { "alibaba-token-plan": { windows: [{ id: "week", periodMs: 604800000, meter: "tokens", capacity: 1000000 }] } };
  const nightLedger = recordBudgetUsage({}, "alibaba-token-plan",
    { requests: 1, modelID: "deepseek-v4-pro-0813", tokens: { input: 1000, output: 0 } }, NIGHT, config, [NIGHT_DEAL]);
  assert.equal(nightLedger["alibaba-token-plan"].windows[0].spentTokens, 500);
  const dayLedger = recordBudgetUsage({}, "alibaba-token-plan",
    { requests: 1, modelID: "deepseek-v4-pro-0813", tokens: { input: 1000, output: 0 } }, DAY, config, [NIGHT_DEAL]);
  assert.equal(dayLedger["alibaba-token-plan"].windows[0].spentTokens, 1000);
  const otherModel = recordBudgetUsage({}, "alibaba-token-plan",
    { requests: 1, modelID: "qwen3.8-max", tokens: { input: 1000, output: 0 } }, NIGHT, config, [NIGHT_DEAL]);
  assert.equal(otherModel["alibaba-token-plan"].windows[0].spentTokens, 1000);
});

test("entitlement denials classify as model failures, never provider failures", () => {
  assert.equal(R.classifyRoutingFailure({ statusCode: 403, message: "Access to model denied" }), "model");
  assert.equal(R.classifyRoutingFailure({ message: "The model glm-5.2 is not entitled for this plan" }), "model");
  assert.equal(R.classifyRoutingFailure({ code: "AccessDenied.Model", message: "no" }), "model");
  assert.equal(R.classifyRoutingFailure({ statusCode: 429, code: "Throttling.AllocationQuota", message: "Your token-plan 1-week quota has been exhausted" }), "quota");
});

test("capacities self-calibrate from provider complaints and raise on clean overshoot", async () => {
  const { learnCapacityFromFailure, capacityFor, budgetUtilization } = await import("../lib/budgets.js");
  const config = { openai: { windows: [
    { id: "5h", periodMs: 5 * 3600 * 1000, meter: "requests", capacity: 300 },
    { id: "week", periodMs: 7 * 24 * 3600 * 1000, meter: "requests", capacity: 6000 },
  ] } };
  const now = Date.now();
  let budgets = {};
  const spend = (n) => { for (let i = 0; i < n; i++) budgets = recordBudgetUsage(budgets, "openai", { requests: 1 }, now, config, []); };
  spend(576);
  // Estimate says 192%; the provider has NOT complained, so it is only a prior.
  assert.equal(Math.round(budgetUtilization(budgets, "openai", now, config) * 100), 192);
  // A rate complaint at 576 spent calibrates the SHORT window to 576.
  budgets = learnCapacityFromFailure(budgets, "openai", "rate", now, config);
  assert.equal(capacityFor(config.openai.windows[0], budgets.openai.learned), 576);
  assert.equal(Math.round(budgetUtilization(budgets, "openai", now, config) * 100), 100,
    "utilization now reflects the observed ceiling");
  // Passing the learned ceiling without a complaint raises it.
  spend(24);
  assert.equal(budgets.openai.learned["5h"], 600);
  // A quota complaint calibrates the LONG window.
  budgets = learnCapacityFromFailure(budgets, "openai", "quota", now, config);
  assert.equal(budgets.openai.learned.week, 600);
});
