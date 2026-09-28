import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProviderCheck, checkProvider, LAPSED_HOLD_MS, PLAN_LAPSED_REASON, planUsageResult,
  providerCheckConfigured, QUOTA_CLEAR_MIN_AGE_MS,
} from "../lib/provider-check.js";
import { __resetPlanUsageCacheForTests, fetchPlanUsage, freshPlanUsage } from "../lib/plan-usage.js";

const KEY = "provider:alibaba-token-plan";
const authPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "provider-check-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ "alibaba-token-plan": { type: "api", key: "sk-sp-test" } }));
  return path;
})();
const COUNT_TOKENS = { check: { type: "count-tokens", url: "https://example.test/apps/anthropic/v1/", model: "qwen3.6-flash" } };
const respond = (status, body) => async () => new Response(JSON.stringify(body), { status });

test("count-tokens: 200 is a live plan, 403 Unpurchased a lapsed one, anything else unknown", async () => {
  let seen;
  const live = await checkProvider("alibaba-token-plan", COUNT_TOKENS, {
    authPath,
    fetchImpl: async (url, init) => { seen = { url, init }; return new Response("{}", { status: 200 }); },
  });
  assert.deepEqual(live, { entitlement: "active", quotaAuthoritative: false });
  assert.equal(seen.url, "https://example.test/apps/anthropic/v1/messages/count_tokens");
  assert.equal(seen.init.headers["x-api-key"], "sk-sp-test");
  const lapsed = await checkProvider("alibaba-token-plan", COUNT_TOKENS, {
    authPath, fetchImpl: respond(403, { code: "AccessDenied.Unpurchased", message: "Access to model denied." }),
  });
  assert.deepEqual(lapsed, { entitlement: "lapsed", quotaAuthoritative: false });
  assert.equal(await checkProvider("alibaba-token-plan", COUNT_TOKENS, {
    authPath, fetchImpl: respond(500, { message: "boom" }),
  }), null);
  assert.equal(await checkProvider("alibaba-token-plan", COUNT_TOKENS, {
    authPath, fetchImpl: async () => { throw new Error("offline"); },
  }), null);
});

test("usage readings: a free plan is a lapse; a paid reading is active and authoritative", () => {
  assert.deepEqual(planUsageResult({ windows: [], lockedUntil: null, plan: "prolite" }),
    { entitlement: "active", quotaAuthoritative: true, lockedUntil: null });
  assert.deepEqual(planUsageResult({ windows: [], lockedUntil: 5, plan: "pro" }),
    { entitlement: "active", quotaAuthoritative: true, lockedUntil: 5 });
  assert.deepEqual(planUsageResult({ windows: [], lockedUntil: null, plan: "free" }),
    { entitlement: "lapsed", quotaAuthoritative: true });
  assert.equal(planUsageResult(null), null);
});

test("only a failed fetch's absence of a report reaches the check, never the last good one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "provider-check-oa-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ openai: { type: "oauth", access: "tok" } }));
  const config = { planUsage: { type: "openai-oauth", authPath: path } };
  __resetPlanUsageCacheForTests();
  await fetchPlanUsage("openai", config, { now: 1, fetchImpl: respond(200, {
    plan_type: "prolite",
    rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1791208986 } },
  }) });
  assert.equal(freshPlanUsage("openai").plan, "prolite");
  const served = await fetchPlanUsage("openai", config, { now: 1e9, fetchImpl: respond(503, {}) });
  assert.equal(served.plan, "prolite");
  assert.equal(freshPlanUsage("openai"), null);
  __resetPlanUsageCacheForTests();
});

test("providers with a usage reading are not put on the timer", () => {
  assert.equal(providerCheckConfigured({ planUsage: { type: "openai-oauth" } }), false);
  assert.equal(providerCheckConfigured(COUNT_TOKENS), true);
});

test("a lapse opens a held provider circuit and reports the transition once", () => {
  const circuits = {};
  const now = 1_000_000;
  assert.equal(applyProviderCheck(circuits, KEY, { entitlement: "lapsed" }, now), "lapsed");
  assert.deepEqual(circuits[KEY], { kind: "quota", reason: PLAN_LAPSED_REASON, until: now + LAPSED_HOLD_MS, updatedAt: now });
  assert.equal(applyProviderCheck(circuits, KEY, { entitlement: "lapsed" }, now + 1), null);
  assert.equal(circuits[KEY].until, now + 1 + LAPSED_HOLD_MS);
});

test("renewal lifts a lapse, even from a check that cannot see quota", () => {
  const circuits = { [KEY]: { kind: "quota", reason: PLAN_LAPSED_REASON, until: 9e15, updatedAt: 0 } };
  assert.equal(applyProviderCheck(circuits, KEY, { entitlement: "active", quotaAuthoritative: false }, 1), "recovered");
  assert.equal(circuits[KEY], undefined);
});

test("an ordinary quota stop is lifted only by an authoritative, unlocked, not-too-fresh reading", () => {
  const now = 10 * QUOTA_CLEAR_MIN_AGE_MS;
  const stop = () => ({ [KEY]: { kind: "quota", until: now + 3_600_000, updatedAt: now - QUOTA_CLEAR_MIN_AGE_MS } });
  let circuits = stop();
  assert.equal(applyProviderCheck(circuits, KEY, { entitlement: "active", quotaAuthoritative: false }, now), null);
  assert.ok(circuits[KEY]);
  assert.equal(applyProviderCheck(circuits, KEY, { entitlement: "active", quotaAuthoritative: true, lockedUntil: now + 60_000 }, now), null);
  assert.ok(circuits[KEY]);
  circuits = { [KEY]: { ...stop()[KEY], updatedAt: now - 1000 } };
  assert.equal(applyProviderCheck(circuits, KEY, { entitlement: "active", quotaAuthoritative: true, lockedUntil: null }, now), null);
  assert.ok(circuits[KEY]);
  circuits = stop();
  assert.equal(applyProviderCheck(circuits, KEY, { entitlement: "active", quotaAuthoritative: true, lockedUntil: null }, now), "recovered");
  assert.equal(circuits[KEY], undefined);
});

test("non-quota provider circuits are never lifted by a plan check", () => {
  const circuits = { [KEY]: { kind: "connect", until: 9e15, updatedAt: 0 } };
  assert.equal(applyProviderCheck(circuits, KEY, { entitlement: "active", quotaAuthoritative: true }, 1e12), null);
  assert.equal(circuits[KEY].kind, "connect");
  assert.equal(applyProviderCheck(circuits, KEY, null, 1), null);
});
