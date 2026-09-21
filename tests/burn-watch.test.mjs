import assert from "node:assert/strict";
import test from "node:test";
import { createBurnWatch, isFullRewrite, weightedSpend } from "../lib/burn-watch.js";

const MIN = 60_000;
const cached = (context) => ({ input: 5, output: 400, cacheRead: context, cacheWrite: 1_000 });
const rewrite = (context) => ({ input: 5, output: 400, cacheRead: 17_000, cacheWrite: context });

test("a full rewrite is a big fresh prompt that is most of the prompt; a cached step is not", () => {
  assert.equal(isFullRewrite(rewrite(427_000)), true);
  assert.equal(isFullRewrite(cached(427_000)), false);
  assert.equal(isFullRewrite(rewrite(60_000)), false, "small prompts are not worth watching");
  // OpenAI reports the uncached part as input and never a cache write.
  assert.equal(isFullRewrite({ input: 300_000, cacheRead: 0 }), true);
  assert.equal(weightedSpend({ input: 10, output: 20, cacheWrite: 100, cacheRead: 1_000 }), 230);
});

// A recorded runaway, step for step: a cached step (cache read ~440K) interleaved with a
// full re-send (cache write ~430K, cache read 17K), all inside 75 seconds.
test("a recorded runaway is stopped on its fourth re-send, 70 seconds in", () => {
  const watch = createBurnWatch();
  const t0 = 1_000_000;
  const steps = [
    [0, rewrite(427_000)], [6, cached(444_000)], [16, rewrite(427_000)], [39, rewrite(428_000)],
    [44, cached(445_000)], [53, cached(445_000)], [70, rewrite(429_000)], [75, cached(446_000)],
  ];
  const results = steps.map(([s, tokens]) =>
    watch.recordUsage({ sessionID: "ses_runaway", providerID: "anthropic", tokens, at: t0 + s * 1000 }));
  const stops = results.map((result) => result.stop);
  assert.deepEqual(stops.map(Boolean), [false, false, false, false, false, false, true, false],
    "stops at the 4th re-send (1.71M re-sent), and the counters restart after it");
  assert.match(stops[6].reason, /re-sent its whole prompt uncached 4 times in 5 min \(1\.71M tokens\)/);
  const alert = results[6].alerts.find((a) => a.kind === "stop");
  assert.ok(alert, "a stop is also announced");
  assert.match(alert.title, /Burn watch stopped a session \(anthropic\)/);
});

test("re-sends that are cheap do not stop a session: the volume floor is what separates a burst", () => {
  const watch = createBurnWatch();
  let stopped = false;
  for (let i = 0; i < 6; i++) {
    stopped ||= Boolean(watch.recordUsage({ sessionID: "ses_small", providerID: "anthropic", tokens: rewrite(150_000), at: i * 20_000 }).stop);
  }
  assert.equal(stopped, false, "6 x 150K = 0.9M re-sent, under 1.5M");
});

test("a big session doing ordinary cached work for five minutes is never stopped", () => {
  const watch = createBurnWatch();
  // The busiest honest shape: a 440K context, a step every 5 s, all cache reads.
  let stopped = false;
  for (let i = 0; i < 60; i++) {
    stopped ||= Boolean(watch.recordUsage({ sessionID: "ses_busy", providerID: "anthropic", tokens: cached(440_000), at: i * 5_000 }).stop);
  }
  assert.equal(stopped, false);
  // A restart re-send on top pushes it past 3M: that is worth a notification, not a stop.
  const restart = watch.recordUsage({ sessionID: "ses_busy", providerID: "anthropic", tokens: rewrite(900_000), at: 301_000 });
  assert.equal(restart.stop, null);
  assert.ok(restart.alerts.some((a) => a.kind === "session-spend" && /one session is spending fast/.test(a.title) && /It was not stopped/.test(a.body)));
});

test("session spend stops a runaway of any shape only at 6M weighted in five minutes", () => {
  const watch = createBurnWatch();
  // Output-heavy: nothing re-sent, but 101K weighted per step, every 4.5 s.
  const results = Array.from({ length: 64 }, (_, i) =>
    watch.recordUsage({ sessionID: "ses_output", providerID: "openai", tokens: { input: 1_000, output: 100_000 }, at: i * 4_500 }));
  assert.equal(results.findIndex((r) => r.alerts.some((a) => /one session/.test(a.title))), 29, "3.03M alerts");
  const first = results.findIndex((r) => r.stop);
  assert.equal(first, 59, "60 x 101K = 6.06M is the first step over the stop limit");
  assert.match(results[first].stop.reason, /spent 6\.06M weighted tokens in 5 min \(stop limit 6\.00M\)/);
});

test("provider spend across sessions alerts without stopping anyone, once per cooldown", () => {
  const watch = createBurnWatch();
  const alerts = [];
  let stops = 0;
  for (let i = 0; i < 80; i++) {
    const r = watch.recordUsage({ sessionID: `ses_child_${i % 8}`, providerID: "anthropic", tokens: { input: 1_000, output: 40_000 }, at: i * 3_000 });
    alerts.push(...r.alerts);
    if (r.stop) stops += 1;
  }
  assert.equal(stops, 0, "each of eight children stays far under its own limit");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "provider-spend");
  assert.match(alerts[0].title, /anthropic is spending fast/);
});

test("plan velocity alerts on +6 points inside ten minutes, reading the provider's own percent", () => {
  const watch = createBurnWatch();
  const plan = (percent) => [{ id: "wk", percent: 18 }, { id: "5h", percent }];
  assert.deepEqual(watch.recordPlan({ providerID: "anthropic", windows: plan(5), at: 0 }), []);
  assert.deepEqual(watch.recordPlan({ providerID: "anthropic", windows: plan(10), at: 5 * MIN }), [], "+5 is heavy use, not a runaway");
  const alerts = watch.recordPlan({ providerID: "anthropic", windows: plan(13), at: 9 * MIN });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "plan-rise");
  assert.match(alerts[0].body, /5h window went from 5% to 13% within 10 min/);
  assert.deepEqual(watch.recordPlan({ providerID: "anthropic", windows: plan(20), at: 12 * MIN }), [], "cooldown");
});

test("a slow climb never alerts, and a window reset is not a rise", () => {
  const watch = createBurnWatch();
  const at = (m) => m * MIN;
  const readings = [[0, 40], [5, 44], [10, 48], [15, 52], [20, 2], [25, 5]];
  const alerts = readings.flatMap(([m, percent]) =>
    watch.recordPlan({ providerID: "anthropic", windows: [{ id: "5h", percent }], at: at(m) }));
  assert.deepEqual(alerts, []);
});

test("thresholds and the watched plan window come from config", () => {
  const watch = createBurnWatch({ config: { rewriteCount: 2, rewriteVolumeTokens: 200_000, planWindow: "wk", planRisePoints: 2 } });
  assert.equal(watch.recordUsage({ sessionID: "ses_a", providerID: "openai", tokens: rewrite(120_000), at: 0 }).stop, null);
  assert.ok(watch.recordUsage({ sessionID: "ses_a", providerID: "openai", tokens: rewrite(120_000), at: 1_000 }).stop);
  const plan = (week) => [{ id: "5h", percent: 50 }, { id: "wk", percent: week }];
  assert.deepEqual(watch.recordPlan({ providerID: "openai", windows: plan(10), at: 0 }), []);
  assert.equal(watch.recordPlan({ providerID: "openai", windows: plan(12), at: MIN }).length, 1);
});

// The broker runs for weeks and a gateway mints a session id per request: sessions whose
// windows have passed must not stay in memory.
test("finished sessions and expired cooldowns are dropped from memory", () => {
  const watch = createBurnWatch();
  for (let i = 0; i < 100; i++) {
    watch.recordUsage({ sessionID: `gw-${i}`, providerID: "anthropic", tokens: cached(10_000), at: i * 100 });
  }
  assert.equal(watch.tracked().sessions, 100);
  watch.recordUsage({ sessionID: "ses_later", providerID: "anthropic", tokens: cached(10_000), at: 60 * MIN });
  assert.deepEqual(watch.tracked(), { sessions: 1, cooldowns: 0 });
});
