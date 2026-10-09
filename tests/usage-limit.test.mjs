import assert from "node:assert/strict";
import test from "node:test";

import { classifyRoutingFailure } from "../lib/routing.js";
import { activeUsageLimits, describeProviderLimit, formatReturn, formatReturnShort, usageLimitMessage } from "../lib/usage-limit.js";
import { upstreamUsageLimit } from "../gateway/lib/gateway.js";

const NOW = Date.parse("2026-10-09T03:22:00Z");

test("the return time names the day, the time and how long from now", () => {
  assert.equal(formatReturn(Date.parse("2026-10-14T03:38:00Z"), NOW), "Wed Oct 14 03:38 UTC (in 5d 0h)");
  assert.equal(formatReturn(Date.parse("2026-10-09T08:20:00Z"), NOW), "Fri Oct 9 08:20 UTC (in 4h 58m)");
  assert.equal(formatReturn(Date.parse("2026-10-09T03:40:00Z"), NOW), "Fri Oct 9 03:40 UTC (in 18m)");
});

test("the sidebar's short form keeps the weekday, and the date once the weekday would repeat", () => {
  assert.equal(formatReturnShort(Date.parse("2026-10-14T03:38:00Z"), NOW), "Wed 03:38");
  assert.equal(formatReturnShort(Date.parse("2026-10-09T08:20:00Z"), NOW), "Fri 08:20");
  assert.equal(formatReturnShort(Date.parse("2026-10-20T03:38:00Z"), NOW), "Oct 20 03:38");
});

test("each provider says which limit and when it is back, or that nobody said", () => {
  assert.equal(describeProviderLimit({ providerID: "openai", limit: "weekly limit", until: Date.parse("2026-10-14T03:38:00Z") }, NOW),
    "openai weekly limit, back Wed Oct 14 03:38 UTC (in 5d 0h)");
  assert.equal(describeProviderLimit({ providerID: "alibaba-token-plan" }, NOW),
    "alibaba-token-plan usage limit, return time not reported");
  assert.equal(describeProviderLimit({ providerID: "alibaba-token-plan", lapsed: true }, NOW),
    "alibaba-token-plan plan has lapsed, back when it is renewed");
});

test("usage stops are read from broker circuits, soonest first, with the plan's window name", () => {
  const circuits = {
    "provider:openai": { kind: "plan-window", until: Date.parse("2026-10-14T03:38:00Z") },
    "provider:anthropic": { kind: "plan-window", until: Date.parse("2026-10-09T08:20:00Z") },
    // Only a re-probe time: no return date may be claimed for it.
    "provider:alibaba-token-plan": { kind: "quota", until: NOW + 30 * 60_000, resetKnown: false },
    // Not a usage stop.
    "provider:llamacpp": { kind: "connect", until: NOW + 60_000 },
  };
  const plans = {
    anthropic: { windows: [{ id: "5h", percent: 100, resetsAt: "2026-10-09T08:20:00Z" }, { id: "wk", percent: 72, resetsAt: "2026-10-12T11:00:00Z" }] },
    openai: { windows: [{ id: "wk", percent: 100, resetsAt: "2026-10-14T03:38:00Z" }] },
  };
  const limits = activeUsageLimits(circuits, ["anthropic", "openai", "alibaba-token-plan", "llamacpp"], (id) => plans[id], NOW);
  assert.equal(usageLimitMessage(limits, NOW),
    "usage limit reached -- anthropic 5-hour limit, back Fri Oct 9 08:20 UTC (in 4h 58m); " +
    "openai weekly limit, back Wed Oct 14 03:38 UTC (in 5d 0h); " +
    "alibaba-token-plan usage limit, return time not reported");
});

test("the gateway recognises an upstream usage limit and its reset, never a fast-mode or burst 429", () => {
  const headers = (entries) => new Headers(entries);
  const anthropic = upstreamUsageLimit(429,
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } }),
    headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Date.parse("2026-10-09T08:20:00Z") / 1000), "anthropic-ratelimit-unified-representative-claim": "five_hour" }),
    NOW);
  assert.deepEqual(anthropic, { limit: "5-hour limit", until: Date.parse("2026-10-09T08:20:00Z") });
  const openai = upstreamUsageLimit(429,
    JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_in_seconds: 3600 } }),
    headers({}), NOW);
  assert.deepEqual(openai, { limit: null, until: NOW + 3_600_000 });
  assert.equal(upstreamUsageLimit(429,
    JSON.stringify({ error: { type: "rate_limit_error", message: "Usage credits are required for fast mode." } }), headers({}), NOW), null);
  assert.equal(upstreamUsageLimit(429,
    JSON.stringify({ error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }), headers({}), NOW), null);
  assert.equal(upstreamUsageLimit(500, "{}", headers({}), NOW), null);
});

test("the broker's own usage-limit wording never indicts a provider; a provider's still reads as quota", () => {
  assert.equal(classifyRoutingFailure({ message: "usage limit reached -- openai weekly limit, back Wed Oct 14 03:38 UTC (in 5d 0h)." }), "noop");
  assert.equal(classifyRoutingFailure({ message: "usage limit reached -- anthropic 5-hour limit (gateway: no provider could serve the request)", statusCode: 502 }), "noop");
  assert.equal(classifyRoutingFailure({ statusCode: 429, message: "The usage limit has been reached" }), "quota");
});

// Wrap-up: when every cloud provider the lane can use is about to run out and no local model
// can take over, working sessions are told to wrap up and write a handoff.
test("a lane is nearly out only when no provider has room and nothing local can take over", async () => {
  const { laneHeadroom } = await import("../lib/usage-limit.js");
  const plans = {
    anthropic: { windows: [{ id: "5h", percent: 98, resetsAt: "2026-10-09T08:20:00Z" }, { id: "wk:fable", percent: 100 }] },
    openai: { windows: [{ id: "wk", percent: 100, resetsAt: "2026-10-14T03:38:00Z" }] },
    roomy: { windows: [{ id: "5h", percent: 40 }] },
  };
  const held = { "provider:openai": { kind: "plan-window", until: Date.parse("2026-10-14T03:38:00Z") } };
  const at = (providerIDs, extra = {}) => laneHeadroom({ providerIDs, circuits: held, planFor: (id) => plans[id], localFits: false, now: NOW, ...extra });
  const out = at(["anthropic", "openai"]);
  assert.equal(out.nearlyOut, true);
  assert.deepEqual(out.providers.map((p) => [p.providerID, p.held, p.percent, p.window]), [["anthropic", false, 98, "5h"], ["openai", true, 100, "wk"]]);
  assert.equal(at(["anthropic", "openai", "roomy"]).nearlyOut, false, "one provider with room keeps the lane going");
  assert.equal(at(["anthropic", "openai", "unread"]).nearlyOut, false, "a provider with no reading is never a reason to stop");
  assert.equal(at(["anthropic", "openai"], { localFits: true }).nearlyOut, false, "a local model that fits can take over");
  assert.equal(at(["anthropic"], { threshold: 99 }).nearlyOut, false, "the threshold is the line");
  assert.equal(at([]).nearlyOut, false, "a local-only lane never wraps up for cloud usage");
});

test("the wrap-up asks a main session for a handoff and a subagent for its results", async () => {
  const { laneHeadroom, wrapUpMessage } = await import("../lib/usage-limit.js");
  const headroom = laneHeadroom({
    providerIDs: ["anthropic", "openai"], localFits: false, now: NOW,
    circuits: { "provider:openai": { kind: "plan-window", until: Date.parse("2026-10-14T03:38:00Z") } },
    planFor: (id) => ({ anthropic: { windows: [{ id: "5h", percent: 98, resetsAt: "2026-10-09T08:20:00Z" }] } })[id],
  });
  const main = wrapUpMessage(headroom, { now: NOW });
  assert.match(main, /anthropic 5-hour window at 98%, back Fri Oct 9 08:20 UTC \(in 4h 58m\); openai is already out, back Wed Oct 14 03:38 UTC/);
  assert.match(main, /write a handoff/); assert.match(main, /copy-pasteable one-liner/);
  const sub = wrapUpMessage(headroom, { subagent: true, now: NOW });
  assert.match(sub, /return what you have to your parent/); assert.doesNotMatch(sub, /handoff/);
});
