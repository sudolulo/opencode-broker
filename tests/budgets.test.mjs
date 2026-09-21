import assert from "node:assert/strict";
import test from "node:test";

// ☠️ Pin the config BEFORE any router module loads -- config.js reads its file once at
// import time. Without this the suite reads whatever config the HOST has deployed, so
// these assertions passed or failed on the operator's own `burstFence`: setting it to
// 0.75 in production turned the 89% case (written against the 0.9 default) red. A unit
// test must not be a function of the machine it runs on.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

test("effectiveUtilization prefers the provider's exact plan percent", async () => {
  const { effectiveUtilization } = await import("../lib/budgets.js");
  const plan = { windows: [{ id: "5h", percent: 2 }, { id: "week", percent: 21 }] };
  assert.equal(effectiveUtilization({}, "anthropic", Date.now(), undefined, plan), 0.21);
  // no plan report: falls back to the local estimate path (0 for empty budgets)
  assert.equal(effectiveUtilization({}, "anthropic", Date.now(), undefined, null), 0);
});

test("effectiveUtilization balances on the durable window, not a fast burst", async () => {
  const { effectiveUtilization } = await import("../lib/budgets.js");
  // The live bug: a 5-hour burst at 40% must NOT masquerade as the provider's
  // utilization when the weekly subscription budget (the comparable period
  // across providers) is only 13%. Compare period to period -> 0.13.
  const anthropic = { windows: [
    { id: "5h", percent: 40 }, { id: "wk", percent: 13 }, { id: "wk:fable", percent: 3 },
  ] };
  assert.equal(effectiveUtilization({}, "anthropic", Date.now(), undefined, anthropic), 0.13);
  // A provider with only a weekly window is compared on that same weekly period.
  const openai = { windows: [{ id: "wk", percent: 15 }] };
  assert.equal(effectiveUtilization({}, "openai", Date.now(), undefined, openai), 0.15);
  // Period to period, the leaner-weekly provider (anthropic 13% < openai 15%)
  // is the one the balancer should now prefer.
  assert.ok(
    effectiveUtilization({}, "anthropic", Date.now(), undefined, anthropic) <
    effectiveUtilization({}, "openai", Date.now(), undefined, openai),
    "anthropic is leaner on the comparable (weekly) period",
  );
});

test("effectiveUtilization fences a burst window only as it nears its cap", async () => {
  const { effectiveUtilization } = await import("../lib/budgets.js");
  // Below the fence: the 5h burst is ignored, weekly durable budget rules.
  assert.equal(effectiveUtilization({}, "anthropic", Date.now(), undefined,
    { windows: [{ id: "5h", percent: 89 }, { id: "wk", percent: 10 }] }), 0.10);
  // At/above the fence: the near-exhausted burst window binds so the provider
  // yields before the hard 100% circuit fires.
  assert.equal(effectiveUtilization({}, "anthropic", Date.now(), undefined,
    { windows: [{ id: "5h", percent: 95 }, { id: "wk", percent: 10 }] }), 0.95);
});

test("credential errors classify as auth, never provider evidence", async () => {
  const { classifyRoutingFailure } = await import("../lib/routing.js");
  assert.equal(classifyRoutingFailure({ statusCode: 401, message: "nope" }), "auth");
  assert.equal(classifyRoutingFailure({ message: "The access token expired. Please re-authenticate." }), "auth");

  // ☠️ A DEAD SOCKET used to fall through to "other". On 2026-09-14 llama.cpp went down
  // mid-deploy and a tester on qwen3.5-9b hit this five times in 33 seconds, surfacing every one
  // to the user in AUTO while a healthy cloud lane sat unused. "other" fences the one target, so
  // the re-lease landed on a SIBLING behind the same dead socket and failed identically.
  assert.equal(classifyRoutingFailure({
    message: "Cannot connect to API: Unable to connect. Is the computer able to access the url?",
  }), "connect");
  assert.equal(classifyRoutingFailure({ message: "connect ECONNREFUSED 127.0.0.1:8080" }), "connect");
  assert.equal(classifyRoutingFailure({ message: "fetch failed" }), "connect");
  // ☆ The boundary, pinned: a connection that BROKE is not a connection that never
  // happened. These stay "other" so one bad stream cannot circuit a whole provider.
  assert.equal(classifyRoutingFailure({ message: "socket hang up" }), "other");
  assert.equal(classifyRoutingFailure("connection reset"), "other");
  // ☆ A server that ANSWERED is not unreachable, whatever the words say -- 503 is overload,
  // and that distinction is the whole reason `connect` is its own kind.
  assert.equal(classifyRoutingFailure({ statusCode: 503, message: "service unavailable" }), "overload");
  // ☆ And an ordinary fault is still "other": this must not become a catch-all.
  assert.equal(classifyRoutingFailure({ message: "something odd happened" }), "other");
  assert.equal(classifyRoutingFailure({ message: "invalid api key provided" }), "auth");
  assert.equal(classifyRoutingFailure({ message: "some novel explosion" }), "other");
  // a transient provider overload is its own class -- it must fence briefly, not
  // quarantine (the broker's OVERLOAD_MS branch acts on this).
  assert.equal(classifyRoutingFailure({ statusCode: 529, message: "Overloaded" }), "overload");
  assert.equal(classifyRoutingFailure({ statusCode: 503 }), "overload");
  assert.equal(classifyRoutingFailure({ message: "the model is overloaded, please try again" }), "overload");
});

test("caller-side non-faults classify as noop (never indict the provider)", async () => {
  const { classifyRoutingFailure } = await import("../lib/routing.js");
  assert.equal(classifyRoutingFailure({ message: "classifier returned no text" }), "noop");
  assert.equal(classifyRoutingFailure({ message: "model returned no output" }), "noop");
  // a real provider error is still classified normally
  assert.notEqual(classifyRoutingFailure({ statusCode: 500, message: "internal server error" }), "noop");
});

test("high-risk content raises the tier floor deterministically", async () => {
  const { highRiskTier, raiseTier } = await import("../lib/routing.js");
  // extreme risk -> deep
  assert.equal(highRiskTier("what dosage of ibuprofen is safe for a child"), "deep");
  assert.equal(highRiskTier("is this chest pain a heart attack"), "deep");
  assert.equal(highRiskTier("can I mix bleach and ammonia to clean"), "deep");
  // high risk -> smart
  assert.equal(highRiskTier("what does my blood pressure medication interact with").length > 0, true);
  assert.equal(highRiskTier("do I owe taxes on this investment"), "smart");
  assert.equal(highRiskTier("what are my legal rights in this lawsuit"), "smart");
  // ordinary -> no floor
  assert.equal(highRiskTier("refactor this function to use a map"), null);
  assert.equal(highRiskTier("what's the capital of France"), null);
  // Coding briefs use this vocabulary constantly; none of it is a safety topic. Each of
  // these used to bump a worker to smart or deep (Fable, 2x).
  for (const text of [
    "the circuit breaker never resets after a timeout", "fix the cache poisoning in the resolver",
    "wire up the dependency wiring for the router", "set the SVG stroke width",
    "use short-circuit evaluation here", "add a diagnostics endpoint",
    "the symptom of the race condition is a stale read", "this is a load-bearing assumption in the parser",
    "charge the Visa card in the payment flow", "read the voltage sensor in Home Assistant",
    "handle the liability field in the policy form", "treatment of null values in the parser",
  ]) assert.equal(highRiskTier(text), null, text);
  // ...while the safety topics behind those words still bump.
  for (const [text, tier] of [
    ["is it safe to redo the electrical wiring in my kitchen", "deep"], ["my breaker panel keeps tripping", "deep"],
    ["is chocolate toxic to dogs", "deep"], ["symptoms of a stroke", "deep"], ["can I remove this load-bearing wall", "deep"],
    ["is my visa status affected", "smart"], ["what treatment options are there for shingles", "smart"],
  ]) assert.equal(highRiskTier(text), tier, text);
  // raiseTier never lowers
  assert.equal(raiseTier("worker", "smart"), "smart");
  assert.equal(raiseTier("deep", "smart"), "deep", "never lower a deep session to smart");
  assert.equal(raiseTier("build", null), "build");
});
