import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// Hermetic: lib/routing.js, lib/config.js, lib/plan-usage.js and lib/client.js resolve
// HOME/XDG/routing paths at IMPORT time, so the isolated root is set before any import and
// nothing falls back to the real HOME (auth.json, model cache, routing dir, broker socket).
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "quota-progression-home-"));
for (const [name, dir] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_STATE_HOME", "state"],
  ["XDG_CACHE_HOME", "cache"], ["XDG_RUNTIME_DIR", "runtime"], ["OPENCODE_MODEL_ROUTING_DIR", "routing"]]) {
  process.env[name] = join(ISOLATED_HOME, dir);
  mkdirSync(process.env[name], { recursive: true, mode: 0o700 });
}
process.env.HOME = ISOLATED_HOME;
process.env.OPENCODE_MODEL_BROKER_SOCKET = join(ISOLATED_HOME, "routing", "broker.sock");
process.env.OPENCODE_BROKER_LOCAL_MODELS_URL = "http://127.0.0.1:9/v1/models";
test.after(() => rmSync(ISOLATED_HOME, { recursive: true, force: true }));
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const B = await import("../lib/budgets.js");
const R = await import("../lib/routing.js");
const P = await import("../lib/plan-usage.js");
const targets = Object.fromEntries(["a", "b"].map((id) => [id, {
  id, providerID: `provider-${id}`, modelID: `model-${id}`, kind: "cloud",
  capacity: null, source: "subscription-oauth", tiers: ["worker"],
}]));
const report = (short, weekly) => ({windows: [
  {id: "5h", percent: short}, {id: "wk", percent: weekly},
]});
test("short-window taper gradually diverts a durable-preferred provider", () => {
  try {
    for (const [percent, expected] of [[65,10000],[75,10000],[80,9600],[90,6400],[95,3600],[99,784]]) {
      P.__resetPlanUsageCacheForTests();
      P.seedPlanUsageCache({"provider-a": report(percent, 10), "provider-b": report(0, 40)});
      let cursors = {}; let count = 0; let diverted = 0;
      for (let i = 0; i < 10000; i++) {
        const choice = R.chooseTarget({profile: "auto", tier: "worker", targets,
          cursors, tierWeights: {}, deals: [], outagePolicy: {enabled: false}, burstFence: .75});
        assert.ok(choice.target, "taper never creates a refusal");
        assert.equal(choice.nextCursor, i + 1);
        // Simulate the broker's sole commit: the global cursor AND the taper counters.
        cursors = {...cursors, [choice.cursorKey]: choice.nextCursor, ...(choice.nextTaperCursors ?? {})};
        if (choice.target.providerID === "provider-a") count++;
        else { diverted++; assert.ok(choice.decision.reasons.includes("short-window-taper")); }
      }
      assert.ok(Math.abs(count - expected) <= 1, `${percent}%: ${count}, expected ${expected}`);
      assert.equal(count + diverted, 10000);
    }
  } finally { P.__resetPlanUsageCacheForTests(); }
});
test("taper uses percentage, not reset elapsed time", () => {
  for (const resetsAt of ["2026-10-26T00:01:00Z", "2026-11-02T00:00:00Z"]) {
    const plan = report(65, 10); plan.windows[0].resetsAt = resetsAt;
    assert.equal(B.shortWindowTaper("provider-a", {plan, start: .75}), 1);
    assert.equal(B.effectiveUtilization({}, "provider-a", 0, undefined, plan), .10);
  }
});

test("short-window taper ignores unknown and model-scoped readings and clamps valid inputs", () => {
  const taper = (windows, start) => B.shortWindowTaper("provider-a", { plan: { windows }, start });
  assert.equal(taper([{ id: "5h", percent: 80 }]), 1);
  assert.equal(taper([{ id: "5h", percent: 90 }]), 1);
  assert.ok(Math.abs(taper([{ id: "5h", percent: 95 }]) - .75) < 1e-12);
  assert.ok(Math.abs(taper([{ id: "5h", percent: 99 }]) - .19) < 1e-12);
  assert.equal(taper([{ id: "5h", percent: null }, { id: "wk", percent: 10 }], .75), 1);
  assert.equal(taper([{ id: "5h", percent: " " }, { id: "wk", percent: 10 }], .75), 1);
  assert.equal(taper([{ id: "5h", percent: Infinity }, { id: "wk", percent: 10 }], .75), 1);
  assert.equal(taper([{ id: "unknown", percent: 100 }, { id: "wk", percent: 10 }], .75), 1);
  assert.equal(taper([{ id: "5h:model", percent: 100 }, { id: "wk:model", percent: 100 }], .75), 1);
  assert.ok(Math.abs(taper([{ id: "5h", percent: 80 }, { id: "1h", percent: 95 }], .9) - .75) < 1e-12);
  assert.equal(taper([{ id: "5h", percent: -10 }], -1), 1);
  assert.equal(taper([{ id: "5h", percent: 200 }], 2), 0);
  assert.equal(taper([{ id: "5h", percent: 99 }], 1), 1);
  assert.equal(taper([{ id: "5h", percent: 100 }], 1), 0);
});

test("taper admission normalizes invalid cursors without aliasing progress", () => {
  assert.equal(B.taperAdmits(-1, .5), false);
  assert.equal(B.taperAdmits(Number.MAX_SAFE_INTEGER + 1, .5), false);
  assert.equal(B.taperAdmits(0, .5), false);
  assert.equal(B.taperAdmits(1, .5), true);
});

test("provider-wide taper skip preserves eligibility and availability", () => {
  const duplicated = {
    a1: { ...targets.a, id: "a1" },
    a2: { ...targets.a, id: "a2", modelID: "model-a2" },
    b: targets.b,
  };
  try {
    P.seedPlanUsageCache({ "provider-a": report(100, 10), "provider-b": report(0, 40) });
    const diverted = R.chooseTarget({ profile: "auto", tier: "worker", targets: duplicated,
      cursors: { "auto:worker:cloud": 1 }, tierWeights: {}, deals: [], outagePolicy: { enabled: false }, burstFence: .75 });
    assert.equal(diverted.target.providerID, "provider-b");
    assert.ok(diverted.decision.reasons.includes("short-window-taper"));
    assert.deepEqual(diverted.decision.providerShortWindowWeights, { "provider-a": 0, "provider-b": 1 });

    const untaperedAlternative = R.chooseTarget({ profile: "auto", tier: "worker", targets,
      cursors: { "auto:worker:cloud": 1 }, tierWeights: {}, deals: [], outagePolicy: { enabled: false }, burstFence: .75 });
    assert.equal(untaperedAlternative.target.providerID, "provider-b");
    P.__resetPlanUsageCacheForTests();
    P.seedPlanUsageCache({ "provider-a": report(100, 10), "provider-b": report(100, 40) });
    const fallback = R.chooseTarget({ profile: "auto", tier: "worker", targets,
      cursors: { "auto:worker:cloud": 1 }, tierWeights: {}, deals: [], outagePolicy: { enabled: false }, burstFence: .75 });
    assert.ok(fallback.target, "all tapered providers retain the original eligible choice");
    assert.ok(fallback.decision.reasons.includes("short-window-taper-availability-fallback"));
  } finally { P.__resetPlanUsageCacheForTests(); }
});

test("below the taper start keeps ordinary rotation and provider preferences", () => {
  try {
    P.seedPlanUsageCache({ "provider-a": report(65, 10), "provider-b": report(0, 10) });
    const base = [0, 1].map((cursor) => R.chooseTarget({ profile: "auto", tier: "worker", targets,
      cursors: { "auto:worker:cloud": cursor }, tierWeights: {}, deals: [], outagePolicy: { enabled: false }, burstFence: .75 }));
    assert.deepEqual(base.map((choice) => choice.target.providerID), ["provider-a", "provider-b"]);
    assert.ok(base.every((choice) => !choice.decision.reasons.includes("short-window-taper")));

    const preferred = R.chooseTarget({ profile: "auto", tier: "worker", targets,
      cursors: { "auto:worker:cloud": 1 }, tierWeights: { worker: { "provider-a": 2 } }, deals: [], outagePolicy: { enabled: false }, burstFence: .75 });
    assert.equal(preferred.target.providerID, "provider-a");
  } finally { P.__resetPlanUsageCacheForTests(); }
});

// --- Per-provider taper counters -------------------------------------------------------
// The taper admission used to read the GLOBAL round-robin cursor. That cursor also drives
// provider rotation and the worker local share, so a provider only ever saw the cursor
// residues of its own rotation turn: at w=.5 a provider whose turn always lands on an even
// cursor was never admitted, while one on odd cursors was admitted every time. Each tapered
// provider now has its own counter, advanced every time that provider is EVALUATED by the
// taper (admitted or rejected). A winner-only counter would freeze on rejection -- the
// counter that just rejected would be read again unchanged next time, and a provider whose
// counter sits on a rejecting residue would be rejected forever.
const sharedTargets = {
  a: targets.a,
  b: targets.b,
  "local-coder": { id: "local-coder", providerID: "llamacpp", modelID: "qwen3.5-9b-coder", kind: "local", capacity: 1, context: 32768 },
};
const localModels = new Set(["qwen3.5-9b-coder"]);
const choose = (cursors, extra = {}) => R.chooseTarget({ profile: "auto", tier: "worker", targets, cursors,
  tierWeights: {}, deals: [], outagePolicy: { enabled: false }, burstFence: .75, ...extra });
const commit = (cursors, choice) => ({ ...cursors, [choice.cursorKey]: choice.nextCursor, ...(choice.nextTaperCursors ?? {}) });
// Short-window percent that yields taper weight w at burstFence .75: w = 1 - ((p - .75) / .25)^2.
const percentFor = (w) => 100 * (.75 + .25 * Math.sqrt(1 - w));

test("tied providers sharing worker rotation and local share are each admitted at their own weight", () => {
  try {
    for (const w of [.75, .5, .25]) {
      P.__resetPlanUsageCacheForTests();
      const percent = percentFor(w);
      P.seedPlanUsageCache({ "provider-a": report(percent, 10), "provider-b": report(percent, 10) });
      const weight = B.shortWindowTaper("provider-a", { start: .75 });
      assert.ok(Math.abs(weight - w) < 1e-9, `fixture weight ${weight} for ${w}`);
      let cursors = {};
      const admitted = { "provider-a": 0, "provider-b": 0 };
      const baseOpportunity = { "provider-a": 0, "provider-b": 0 };
      let local = 0;
      const N = 8000;
      for (let i = 0; i < N; i++) {
        const choice = choose(cursors, { targets: sharedTargets, localModels, contextTokens: 1000 });
        assert.ok(choice.target, "taper never creates a refusal");
        assert.equal(choice.cursorKey, "auto:worker:mixed");
        assert.equal(choice.nextCursor, i + 1, "the global cursor advances exactly once per lease");
        // Untapered rotation: cursor % 4 == 0 is the local share, else tiedProviders[cursor % 2].
        if (i % 4 === 0) { assert.equal(choice.target.kind, "local"); local++; }
        else baseOpportunity[i % 2 === 0 ? "provider-a" : "provider-b"]++;
        const fallback = choice.decision.reasons.includes("short-window-taper-availability-fallback");
        if (choice.target.kind === "cloud" && !fallback) admitted[choice.target.providerID]++;
        cursors = commit(cursors, choice);
      }
      assert.equal(local, N / 4, "the local share is unchanged by the taper");
      for (const providerID of ["provider-a", "provider-b"]) {
        const evaluations = cursors[`taper:auto:worker:mixed:${providerID}`];
        assert.ok(evaluations >= baseOpportunity[providerID], `${providerID} is evaluated at least on its own turns`);
        assert.ok(Math.abs(admitted[providerID] - evaluations * w) <= 1,
          `w=${w} ${providerID}: admitted ${admitted[providerID]} of ${evaluations} evaluations`);
        assert.ok(admitted[providerID] > 0, `w=${w} ${providerID} is never aliased to zero`);
        assert.ok(admitted[providerID] < evaluations, `w=${w} ${providerID} is never aliased to no taper`);
      }
    }
  } finally { P.__resetPlanUsageCacheForTests(); }
});

test("untapered rotation and local share order is unchanged and proposes no taper counters", () => {
  try {
    P.seedPlanUsageCache({ "provider-a": report(10, 10), "provider-b": report(10, 10) });
    let cursors = {};
    const order = [];
    for (let i = 0; i < 8; i++) {
      const choice = choose(cursors, { targets: sharedTargets, localModels, contextTokens: 1000 });
      assert.equal("nextTaperCursors" in choice, false, "weight-1 providers propose no counters");
      order.push(choice.target.kind === "local" ? "local" : choice.target.providerID);
      cursors = commit(cursors, choice);
    }
    assert.deepEqual(order, ["local", "provider-b", "provider-a", "provider-b", "local", "provider-b", "provider-a", "provider-b"]);
  } finally { P.__resetPlanUsageCacheForTests(); }
});

test("a rejected provider's counter advances; unconsidered and untapered providers' do not", () => {
  const three = { ...targets, c: { ...targets.a, id: "c", providerID: "provider-c", modelID: "model-c" } };
  try {
    // a leanest durable and fully tapered; b next and untapered; c tapered but never reached.
    P.seedPlanUsageCache({ "provider-a": report(100, 10), "provider-b": report(0, 40), "provider-c": report(90, 60) });
    const cursors = Object.freeze({ "auto:worker:cloud": 6, "taper:auto:worker:cloud:provider-a": 41, "taper:auto:worker:cloud:provider-c": 3 });
    const choice = choose(cursors, { targets: three });
    assert.equal(choice.target.providerID, "provider-b");
    assert.ok(choice.decision.reasons.includes("short-window-taper"));
    assert.equal(choice.nextCursor, 7);
    assert.deepEqual(choice.nextTaperCursors, { "taper:auto:worker:cloud:provider-a": 42 });
  } finally { P.__resetPlanUsageCacheForTests(); }
});

test("taper counters are read from input without mutating it; repeated previews are stable", () => {
  try {
    P.seedPlanUsageCache({ "provider-a": report(95, 10), "provider-b": report(0, 40) });
    const cursors = Object.freeze({ "auto:worker:cloud": 3, "taper:auto:worker:cloud:provider-a": 2 });
    const first = choose(cursors);
    const second = choose(cursors);
    assert.deepEqual(first, second);
    assert.deepEqual(cursors, { "auto:worker:cloud": 3, "taper:auto:worker:cloud:provider-a": 2 });
    assert.deepEqual(first.nextTaperCursors, { "taper:auto:worker:cloud:provider-a": 3 });
  } finally { P.__resetPlanUsageCacheForTests(); }
});

test("invalid or exhausted taper counters normalize to zero and never yield NaN", () => {
  try {
    P.seedPlanUsageCache({ "provider-a": report(95, 10), "provider-b": report(0, 40) });
    const key = "taper:auto:worker:cloud:provider-a";
    for (const [stored, next] of [[-1, 1], ["7", 1], [NaN, 1], [Infinity, 1], [1.5, 1], [null, 1],
      [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, 0]]) {
      const choice = choose({ "auto:worker:cloud": 0, [key]: stored });
      assert.ok(choice.target, `${stored}: still routes`);
      assert.equal(choice.nextTaperCursors[key], next, `${stored} -> ${next}`);
    }
  } finally { P.__resetPlanUsageCacheForTests(); }
});

test("every provider rejected keeps the original choice and advances each evaluated counter", () => {
  try {
    P.seedPlanUsageCache({ "provider-a": report(100, 10), "provider-b": report(100, 40) });
    const choice = choose({ "auto:worker:cloud": 0, "taper:auto:worker:cloud:provider-b": 5 });
    assert.equal(choice.target.providerID, "provider-a", "the original eligible choice is kept");
    assert.ok(choice.decision.reasons.includes("short-window-taper-availability-fallback"));
    assert.equal(choice.decision.reasons.includes("short-window-taper"), false);
    assert.deepEqual(choice.nextTaperCursors, {
      "taper:auto:worker:cloud:provider-a": 1, "taper:auto:worker:cloud:provider-b": 6,
    });
  } finally { P.__resetPlanUsageCacheForTests(); }
});

test("an active provider quota hold remains an eligibility exclusion", () => {
  const now = Date.now();
  try {
    P.seedPlanUsageCache({ "provider-a": report(100, 0), "provider-b": report(0, 90) });
    const choice = R.chooseTarget({ profile: "auto", tier: "worker", targets, now,
      circuits: { "provider:provider-a": { until: now + 60_000 } }, cursors: {}, tierWeights: {}, deals: [],
      outagePolicy: { enabled: false }, burstFence: .75 });
    assert.equal(choice.target.providerID, "provider-b");
    assert.deepEqual(choice.decision.eligibleTargetIDs, ["b"]);
  } finally { P.__resetPlanUsageCacheForTests(); }
});
