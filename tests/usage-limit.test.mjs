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
  assert.match(main, /[Ww]rite or update a durable handoff/); assert.match(main, /copy-pasteable resume command/);
  const sub = wrapUpMessage(headroom, { subagent: true, now: NOW });
  assert.match(sub, /return what you have to your parent/); assert.doesNotMatch(sub, /handoff/);
});
test("weekly caution is plan-wide and belongs to the routed provider", async () => {
  const {laneHeadroom, primaryQuotaStage, wrapUpMessage} = await import("../lib/usage-limit.js");
  const plans = {
    openai: {fetchedAt: NOW, windows: [{id:"5h",percent:99},{id:"wk",percent:85},{id:"wk:model",percent:100}]},
    anthropic: {windows: [{id:"7d",percent:10}]},
  };
  const room = laneHeadroom({providerIDs:["openai","anthropic"], circuits:{},
    planFor:id=>plans[id], localFits:true, now:NOW});
  assert.equal(room.nearlyOut, false);
  assert.equal(room.providers[0].weekly.percent, 85);
  assert.equal(primaryQuotaStage(room,"openai"), "checkpoint");
  assert.equal(primaryQuotaStage(room,"anthropic"), null);
  const main = wrapUpMessage(room,{sessionID:"ses-main",providerID:"openai",stage:"checkpoint",now:NOW});
  assert.match(main,/before every mutating unit/i);
  assert.match(main,/handoffs\/ses-main\.md/);
  assert.match(main,/keep (doing|working)|continue.*safe/i);
  assert.doesNotMatch(main,/start nothing new/i);
  const child = wrapUpMessage(room,{subagent:true,now:NOW});
  assert.match(child,/return what you have to your parent/);
  assert.doesNotMatch(child,/handoffs|before every mutating unit/i);
});

test("weekly metadata rejects invalid values, selects the largest alias, and reports honest source labels", async () => {
  const { laneHeadroom } = await import("../lib/usage-limit.js");
  const plans = {
    aliases: {
      fetchedAt: NOW,
      windows: [
        { id: "wk", percent: 75, resetsAt: "2026-10-10T00:00:00Z" },
        { id: "week", percent: 85 }, { id: "weekly", percent: 95 },
        { id: "7d", percent: 94 }, { id: "168h", percent: 101 },
        { id: "wk:model", percent: 100 }, { id: "wk", percent: null },
        { id: "week", percent: "  " }, { id: "7d", percent: false },
        { id: "168h", percent: {} },
      ],
    },
    cached: { fetchedAt: NOW - 1, windows: [{ id: "wk", percent: 75 }] },
    unknown: { windows: [{ id: "wk", percent: 75 }] },
    invalid: { windows: [{ id: "wk", percent: false }, { id: "week", percent: "" }, { id: "7d", percent: Infinity }] },
  };
  const headroom = laneHeadroom({
    providerIDs: Object.keys(plans), circuits: {}, localFits: true, now: NOW,
    planFor: (id) => plans[id], freshPlanFor: (id) => id === "aliases",
  });
  assert.deepEqual(headroom.providers.map((provider) => [provider.providerID, provider.weekly]), [
    ["aliases", { window: "168h", percent: 100, resetsAt: null, fetchedAt: NOW, source: "last-fetch" }],
    ["cached", { window: "wk", percent: 75, resetsAt: null, fetchedAt: NOW - 1, source: "cached" }],
    ["unknown", { window: "wk", percent: 75, resetsAt: null, fetchedAt: null, source: "unknown" }],
    ["invalid", null],
  ]);
});

test("weekly stages have exact boundaries and main warnings remain cumulative and safe", async () => {
  const { laneHeadroom, primaryQuotaStage, wrapUpMessage } = await import("../lib/usage-limit.js");
  const expected = [[74.99, null], [75, "prepare"], [84.99, "prepare"], [85, "checkpoint"], [94.99, "checkpoint"], [95, "bounded"], [99.99, "bounded"], [100, "bounded"]];
  for (const [percent, stage] of expected) {
    const headroom = laneHeadroom({ providerIDs: ["openai"], circuits: {}, localFits: true, now: NOW,
      planFor: () => ({ windows: [{ id: "wk", percent }] }) });
    assert.equal(primaryQuotaStage(headroom, "openai"), stage, `${percent}%`);
  }
  const laneOnly = laneHeadroom({ providerIDs: ["openai"], circuits: {}, localFits: false, now: NOW,
    planFor: () => ({ windows: [{ id: "5h", percent: 98 }] }) });
  const main = wrapUpMessage(laneOnly, { sessionID: "ses-main", providerID: "openai", now: NOW });
  assert.match(main, /before every mutating unit/i);
  assert.match(main, /safe, reversible, bounded/i);
  assert.match(main, /0700/); assert.match(main, /0600/);
  assert.match(main, /pending\/background jobs and cleanup obligations/i);
  assert.match(main, /verified against installed CLI help/i);
  assert.match(main, /exclude secrets, credentials, raw transcripts/i);
  assert.match(main, /handoff write fails.*safe nonmutating work/i);
  assert.match(main, /continue useful safe authorized work/i);
  assert.doesNotMatch(main, /start nothing new/i);
  const child = wrapUpMessage(laneOnly, { subagent: true, now: NOW });
  assert.match(child, /start nothing new/i);
  const invalid = wrapUpMessage(laneOnly, { sessionID: "../escape", providerID: "openai", now: NOW });
  assert.doesNotMatch(invalid, /handoffs\/\.\.\/escape\.md/);
  assert.match(invalid, /obtaining and validating your actual session ID/i);
});

test("weekly-only caution identifies its provider, stage, source, and last successful fetch on separate lines", async () => {
  const { laneHeadroom, wrapUpMessage } = await import("../lib/usage-limit.js");
  const headroom = laneHeadroom({
    providerIDs: ["openai"], circuits: {}, localFits: true, now: NOW,
    planFor: () => ({ fetchedAt: "2026-10-09T03:22:00Z", windows: [{ id: "wk", percent: 75 }] }),
    freshPlanFor: () => true,
  });

  const main = wrapUpMessage(headroom, { sessionID: "ses-weekly", providerID: "openai", stage: "prepare", now: NOW });
  assert.match(main, /^\[opencode-broker\] openai weekly quota prepare: 75%\.$/m);
  assert.match(main, /^Weekly usage: openai weekly quota prepare, 75% \(source last-fetch; last successful fetch Fri Oct 9 03:22 UTC; freshness unverified\)\.$/m);
  assert.doesNotMatch(main, /nothing else can take over/i);
  assert.ok(main.includes("\n"), "message fragments are readable newline-separated lines");
});

test("unknown weekly fetch time explicitly reports unknown freshness without a cache freshness promise", async () => {
  const { laneHeadroom, wrapUpMessage } = await import("../lib/usage-limit.js");
  const headroom = laneHeadroom({
    providerIDs: ["openai"], circuits: {}, localFits: true, now: NOW,
    planFor: () => ({ windows: [{ id: "week", percent: 85 }] }),
  });

  const main = wrapUpMessage(headroom, { providerID: "openai", stage: "checkpoint", now: NOW });
  assert.match(main, /^Weekly usage: openai weekly quota checkpoint, 85% \(source unknown; fetch time unknown; freshness unknown\)\.$/m);
  assert.doesNotMatch(main, /cache.*(?:fresh|TTL)|fresh.*cache|TTL/i);
});

test("nearly-out prepare warning gives both the lane cause and its weekly evidence before every mutating unit", async () => {
  const { laneHeadroom, wrapUpMessage } = await import("../lib/usage-limit.js");
  const headroom = laneHeadroom({
    providerIDs: ["openai"], circuits: {}, localFits: false, now: NOW,
    planFor: () => ({ fetchedAt: NOW, windows: [{ id: "5h", percent: 98 }, { id: "wk", percent: 75 }] }),
    freshPlanFor: () => true,
  });

  const main = wrapUpMessage(headroom, { sessionID: "ses-nearly-out", providerID: "openai", stage: "prepare", now: NOW });
  assert.match(main, /^\[opencode-broker\] Usage is about to run out and nothing else can take over:/m);
  assert.match(main, /^Weekly usage: openai weekly quota prepare, 75% \(source last-fetch; last successful fetch Fri Oct 9 03:22 UTC; freshness unverified\)\.$/m);
  assert.match(main, /before every mutating unit/i);
  assert.match(main, /safe, reversible, bounded mutating units/i);
  assert.match(main, /continue useful safe authorized work until actual exhaustion: 100% or a genuine provider limit/i);
  assert.doesNotMatch(main, /tier.?handoff/i);
});

test("weekly aliases remain isolated, clamp values, parse dates, and read each plan once", async (t) => {
  const { laneHeadroom } = await import("../lib/usage-limit.js");
  for (const [id, percent, fetchedAt, resetsAt, expected] of [
    ["wk", -2, "2026-10-09T03:22:00Z", "2026-10-10T00:00:00Z", { window: "wk", percent: 0, fetchedAt: NOW, resetsAt: Date.parse("2026-10-10T00:00:00Z"), source: "cached" }],
    ["week", 12, NOW, NOW + 1_000, { window: "week", percent: 12, fetchedAt: NOW, resetsAt: NOW + 1_000, source: "cached" }],
    ["weekly", 34, undefined, undefined, { window: "weekly", percent: 34, fetchedAt: null, resetsAt: null, source: "unknown" }],
    ["7d", 56, "not-a-date", "not-a-date", { window: "7d", percent: 56, fetchedAt: null, resetsAt: null, source: "unknown" }],
    ["168h", 78, null, null, { window: "168h", percent: 78, fetchedAt: null, resetsAt: null, source: "unknown" }],
  ]) {
    await t.test(`${id} is a standalone weekly alias`, () => {
      let calls = 0;
      const headroom = laneHeadroom({
        providerIDs: ["provider"], circuits: {}, localFits: true, now: NOW,
        planFor: () => {
          calls += 1;
          return { fetchedAt, windows: [{ id, percent, resetsAt }] };
        },
      });
      assert.equal(calls, 1);
      assert.deepEqual(headroom.providers[0].weekly, expected);
    });
  }
  const scoped = laneHeadroom({
    providerIDs: ["provider"], circuits: {}, localFits: true, now: NOW,
    planFor: () => ({ windows: [{ id: "wk:model", percent: 100 }] }),
  });
  assert.equal(scoped.providers[0].weekly, null);
});

test("subagents keep their existing concise wording even when main-stage options are supplied", async () => {
  const { laneHeadroom, wrapUpMessage } = await import("../lib/usage-limit.js");
  const headroom = laneHeadroom({
    providerIDs: ["openai"], circuits: {}, localFits: false, now: NOW,
    planFor: () => ({ fetchedAt: NOW, windows: [{ id: "5h", percent: 98 }, { id: "wk", percent: 95 }] }),
    freshPlanFor: () => true,
  });
  const child = wrapUpMessage(headroom, { subagent: true, sessionID: "ses-child", providerID: "openai", stage: "bounded", now: NOW });
  assert.match(child, /Wrap up now: finish or checkpoint your current step, start nothing new, and return what you have to your parent/);
  assert.doesNotMatch(child, /Weekly usage:|last successful fetch|fetch time unknown|handoff path|before every mutating unit|reversible, bounded/i);
});

test("weekly metadata accepts only valid numeric or nonblank string timestamps", async () => {
  const { laneHeadroom } = await import("../lib/usage-limit.js");
  const invalidTimestamps = [1e20, { toString: () => "2026-10-10T00:00:00Z" }, "   ", "not-a-date"];
  for (const timestamp of invalidTimestamps) {
    const headroom = laneHeadroom({
      providerIDs: ["openai"], circuits: {}, localFits: true, now: NOW,
      planFor: () => ({ fetchedAt: timestamp, windows: [{ id: "wk", percent: 75, resetsAt: timestamp }] }),
      freshPlanFor: () => true,
    });
    assert.deepEqual(headroom.providers[0].weekly, {
      window: "wk", percent: 75, resetsAt: null, fetchedAt: null, source: "unknown",
    }, `${String(timestamp)} is not valid metadata`);
  }
});

test("mixed lane and weekly warnings identify the weekly stage and continue through genuine exhaustion", async () => {
  const { laneHeadroom, wrapUpMessage } = await import("../lib/usage-limit.js");
  const headroom = laneHeadroom({
    providerIDs: ["openai"], circuits: {}, localFits: false, now: NOW,
    planFor: () => ({ fetchedAt: NOW, windows: [{ id: "5h", percent: 98 }, { id: "wk", percent: 75 }] }),
    freshPlanFor: () => true,
  });
  const prepare = wrapUpMessage(headroom, { providerID: "openai", stage: "prepare", now: NOW });
  assert.match(prepare, /^Weekly usage: openai weekly quota prepare, 75% \(source last-fetch; last successful fetch Fri Oct 9 03:22 UTC; freshness unverified\)\.$/m);

  const bounded = wrapUpMessage(headroom, { providerID: "openai", stage: "bounded", now: NOW });
  assert.match(bounded, /Continue useful safe authorized work until actual exhaustion: 100% or a genuine provider limit\./i);
});

test("subagents use generic caution and missing provider uses a generic checkpoint heading", async () => {
  const { laneHeadroom, wrapUpMessage } = await import("../lib/usage-limit.js");
  const headroom = laneHeadroom({
    providerIDs: ["openai"], circuits: {}, localFits: true, now: NOW,
    planFor: () => ({ fetchedAt: NOW, windows: [{ id: "wk", percent: 95 }] }),
  });
  const child = wrapUpMessage(headroom, { subagent: true, providerID: "openai", stage: "bounded", now: NOW });
  assert.match(child, /^\[opencode-broker\] Usage caution\./m);
  assert.doesNotMatch(child, /weekly quota|bounded/i);

  const missing = wrapUpMessage({ providers: [{ providerID: "openai", percent: 90, window: "wk" }], nearlyOut: false }, { stage: "checkpoint", now: NOW });
  assert.match(missing, /^\[opencode-broker\] Quota checkpoint\./m);
  assert.doesNotMatch(missing, /undefined weekly quota|null/);
});

test("a lane-only main warning with a sub-75 weekly reading claims no weekly stage or policy", async () => {
  const { laneHeadroom, primaryQuotaStage, wrapUpMessage } = await import("../lib/usage-limit.js");
  const headroom = laneHeadroom({
    providerIDs: ["openai"], circuits: {}, localFits: false, now: NOW,
    planFor: () => ({ fetchedAt: NOW, windows: [{ id: "5h", percent: 98 }, { id: "wk", percent: 40 }] }),
    freshPlanFor: () => true,
  });
  assert.equal(headroom.nearlyOut, true);
  assert.equal(primaryQuotaStage(headroom, "openai"), null);
  const main = wrapUpMessage(headroom, { sessionID: "ses-lane", providerID: "openai", stage: null, now: NOW });
  assert.match(main, /^\[opencode-broker\] Usage is about to run out and nothing else can take over:/m);
  assert.doesNotMatch(main, /quota null|null/i);
  assert.doesNotMatch(main, /Weekly usage:|weekly quota (?:prepare|checkpoint|bounded)/i, "no weekly stage claim below 75%");
  assert.match(main, /handoffs\/ses-lane\.md/);
  assert.match(main, /before every mutating unit/i);
  assert.match(main, /safe, reversible, bounded mutating units/i);
  assert.match(main, /continue useful safe authorized work/i);
  assert.doesNotMatch(main, /start nothing new/i);

  // Not a lane warning and no stage: the heading falls back instead of naming a null stage.
  const roomy = laneHeadroom({
    providerIDs: ["openai"], circuits: {}, localFits: true, now: NOW,
    planFor: () => ({ fetchedAt: NOW, windows: [{ id: "wk", percent: 40 }] }),
  });
  const heading = wrapUpMessage(roomy, { sessionID: "ses-lane", providerID: "openai", stage: null, now: NOW });
  assert.doesNotMatch(heading, /quota null|null|Weekly usage:/i);

  const child = wrapUpMessage(headroom, { subagent: true, sessionID: "ses-child", providerID: "openai", stage: null, now: NOW });
  assert.match(child, /start nothing new, and return what you have to your parent/);
  assert.doesNotMatch(child, /Weekly usage:|weekly quota|handoff path|before every mutating unit/i);
});

test("weekly output never renders an invalid fetch time as the epoch", async () => {
  const { wrapUpMessage } = await import("../lib/usage-limit.js");
  for (const source of ["cached", "last-fetch"]) {
    const message = wrapUpMessage({
      providers: [{ providerID: "openai", weekly: { percent: 75, fetchedAt: null, source } }], nearlyOut: false,
    }, { providerID: "openai", stage: "prepare", now: NOW });
    assert.match(message, /fetch time unknown; freshness unknown/);
    assert.doesNotMatch(message, /Jan 1 00:00 UTC|1970/);
  }
});
