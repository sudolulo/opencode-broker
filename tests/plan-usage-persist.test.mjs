import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const P = await import("../lib/plan-usage.js");
const { utilizationIsObserved } = await import("../lib/budgets.js");

test("a snapshot round-trips so a restart keeps its readings", () => {
  P.__resetPlanUsageCacheForTests();
  assert.deepEqual(P.planUsageSnapshot(), {}, "empty cache snapshots to nothing");

  const report = { windows: [{ id: "week", percent: 41, active: true }] };
  assert.equal(P.seedPlanUsageCache({ "some-provider": report }), 1);
  assert.deepEqual(P.cachedPlanUsage("some-provider"), report, "seeded reading serves immediately");
  assert.deepEqual(P.planUsageSnapshot(), { "some-provider": report }, "and snapshots back out");
});

// This is the whole point: without a seeded reading the provider is not
// "observed", the unobserved balancing stands down, and an unreadable quota is
// briefly the leanest-looking lane again after every restart.
test("a seeded reading makes the provider count as OBSERVED right away", () => {
  P.__resetPlanUsageCacheForTests();
  assert.equal(utilizationIsObserved("p"), false, "cold cache: nothing observed");
  P.seedPlanUsageCache({ p: { windows: [{ id: "week", percent: 12 }] } });
  assert.equal(utilizationIsObserved("p"), true, "seeded: observed from the first request");
});

test("seeding never overwrites a live reading or accepts junk", () => {
  P.__resetPlanUsageCacheForTests();
  const live = { windows: [{ id: "week", percent: 90 }] };
  P.seedPlanUsageCache({ p: live });
  assert.equal(P.seedPlanUsageCache({ p: { windows: [{ id: "week", percent: 1 }] } }), 0,
    "an existing entry is not clobbered by a stale snapshot");
  assert.deepEqual(P.cachedPlanUsage("p"), live);
  assert.equal(P.seedPlanUsageCache({ bad: null }), 0);
  assert.equal(P.seedPlanUsageCache(undefined), 0);
});

// A later plan lockout must not re-kind an exact quota circuit. A known-reset, unreasoned
// quota circuit is the authority continuation records are bound to; replacing it with a
// plan-window circuit revoked every record on the provider. It is extended in place instead.
test("a later plan lockout extends a known-reset quota circuit in place, keeping it quota", () => {
  const now = Date.parse("2026-10-22T10:00:00Z");
  const reset = now + 30 * 60_000;
  const locked = now + 3 * 3600_000;
  const circuits = { "provider:src": { kind: "quota", until: reset, resetKnown: true, updatedAt: now - 60_000 } };
  P.applyPlanUsageCircuit(circuits, "provider:src", { lockedUntil: locked }, now);
  assert.deepEqual(circuits["provider:src"], { kind: "quota", until: locked, resetKnown: true, updatedAt: now });

  // A healthy report still never clears the (non-plan) quota circuit.
  P.applyPlanUsageCircuit(circuits, "provider:src", { lockedUntil: null }, now + 1000);
  assert.deepEqual(circuits["provider:src"], { kind: "quota", until: locked, resetKnown: true, updatedAt: now });
});

test("every other shorter circuit is still replaced by the plan window, unchanged", () => {
  const now = Date.parse("2026-10-22T10:00:00Z");
  const reset = now + 30 * 60_000;
  const locked = now + 3 * 3600_000;
  for (const [label, existing] of [
    ["unknown-reset quota", { kind: "quota", until: reset, resetKnown: false, updatedAt: now - 1 }],
    ["reasoned (lapsed) quota", { kind: "quota", reason: "plan-lapsed", until: reset, resetKnown: true, updatedAt: now - 1 }],
    ["legacy quota without resetKnown", { kind: "quota", until: reset, updatedAt: now - 1 }],
    ["rate circuit", { kind: "rate", until: reset, updatedAt: now - 1 }],
    ["older plan window", { kind: P.PLAN_WINDOW_KIND, until: reset, updatedAt: now - 1 }],
  ]) {
    const circuits = { "provider:src": { ...existing } };
    P.applyPlanUsageCircuit(circuits, "provider:src", { lockedUntil: locked }, now);
    assert.deepEqual(circuits["provider:src"], { kind: P.PLAN_WINDOW_KIND, until: locked, updatedAt: now }, label);
  }
  // A longer known-reset quota circuit is still never shortened or touched.
  const longer = { kind: "quota", until: locked + 1000, resetKnown: true, updatedAt: now - 1 };
  const circuits = { "provider:src": { ...longer } };
  P.applyPlanUsageCircuit(circuits, "provider:src", { lockedUntil: locked }, now);
  assert.deepEqual(circuits["provider:src"], longer);
});

test("a usage CLI that never closes its pipes cannot hang the fleet", async () => {
  // execFile's `timeout` SIGTERMs the child but promisify settles on `close`, which a
  // grandchild holding stdout keeps from ever firing. /lease awaits this refresh, so the
  // hang stopped every session from leasing for 1h45m on 2026-09-17.
  const { withDeadline } = await import("../lib/plan-usage.js");
  let killed = false;
  const neverSettles = Object.assign(new Promise(() => {}), {
    child: { kill: () => { killed = true; } },
  });
  // The deadline timer is unref'd on purpose (it must never keep the broker alive), and the
  // pending promise never settles, so nothing else holds the event loop open. Node 24's runner
  // waits anyway; Node 20 and 22 cancel the test first. Hold the loop open for the assertion only.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      () => withDeadline(neverSettles, 40, "stuck CLI"),
      /stuck CLI timed out after 40ms/,
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(killed, true, "the child must be killed so its fds are released");

  // A source that answers in time is untouched and its value passes straight through.
  const fast = await withDeadline(Promise.resolve({ stdout: "{}" }), 1000, "fast");
  assert.deepEqual(fast, { stdout: "{}" });
});
