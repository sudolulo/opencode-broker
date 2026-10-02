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
    watch.recordUsage({ sessionID: "ses_runaway", providerID: "anthropic", modelID: "claude-opus-5", tokens, at: t0 + s * 1000 }));
  const stops = results.map((result) => result.stop);
  assert.deepEqual(stops.map(Boolean), [false, false, false, false, false, false, true, false],
    "stops at the 4th re-send (1.71M re-sent), and the counters restart after it");
  assert.match(stops[6].reason, /re-sent its whole prompt uncached 4 times in 5 min \(1\.71M tokens\)/);
  const alert = results[6].alerts.find((a) => a.kind === "stop");
  assert.ok(alert, "a stop is also announced");
  // Title no longer carries the provider id.
  assert.equal(alert.title, "Burn watch stopped a session");
  // Body names the session, the reason, and the model as providerID/modelID.
  assert.match(alert.body, /Session ses_runaway was stopped because .*anthropic\/claude-opus-5/);
  // A lone session is a tree of one -- never names a subagent.
  assert.ok(!/subagent of/.test(alert.body), "no subagent-of phrase for a root with no children");
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
    stopped ||= Boolean(watch.recordUsage({ sessionID: "ses_busy", providerID: "anthropic", modelID: "claude-opus-5", tokens: cached(440_000), at: i * 5_000 }).stop);
  }
  assert.equal(stopped, false);
  // A restart re-send on top pushes it past 3.5M: that is worth a notification, not a stop.
  const restart = watch.recordUsage({ sessionID: "ses_busy", providerID: "anthropic", modelID: "claude-opus-5", tokens: rewrite(900_000), at: 301_000 });
  assert.equal(restart.stop, null);
  const alert = restart.alerts.find((a) => a.kind === "session-spend");
  assert.ok(alert, "a session-spend alert is announced");
  assert.equal(alert.title, "Burn watch: session ses_busy is burning abnormally",
    "the title names the root session with no provider id");
  assert.match(alert.body, /It was not stopped/);
  assert.match(alert.body, /anthropic\/claude-opus-5/, "the provider/model pair that spent appears in the body");
});

// The default session-tree notify line is 3.5M weighted in five minutes, calibrated from
// an 8.5-day replay of real usage.jsonl. A lone session reaching ~3.2M stays silent; one
// reaching ~3.6M crosses the line and raises exactly one session-spend alert. Steps are
// cache-read-heavy so no step's fresh prompt reaches `rewriteTokens`, isolating the spend
// signal from the rewrite stop.
test("the session-spend notify default is 3.5M in five minutes: 3.2M stays silent, 3.6M alerts once", () => {
  // weighted per step = input + output + cacheWrite + 0.1 * cacheRead
  //                   = 1_000 + 1_000 + 0 + 0.1 * 480_000 = 50_000
  // Fresh (input + cacheWrite) = 1_000, far under rewriteTokens (100_000), so isFullRewrite is false.
  const step = { input: 1_000, output: 1_000, cacheRead: 480_000, cacheWrite: 0 };

  const under = createBurnWatch();
  const underAlerts = [];
  for (let i = 0; i < 64; i++) {
    const r = under.recordUsage({
      sessionID: "ses_x", providerID: "anthropic", modelID: "claude-opus-5",
      tokens: step, at: i * 4_000,
    });
    underAlerts.push(...r.alerts);
    assert.equal(r.stop, null, "no step pushes own-spend past the 6M stop line");
  }
  assert.deepEqual(underAlerts, [], "64 steps = 3.20M weighted stays under the 3.5M notify line");

  const over = createBurnWatch();
  const overAlerts = [];
  for (let i = 0; i < 72; i++) {
    const r = over.recordUsage({
      sessionID: "ses_x", providerID: "anthropic", modelID: "claude-opus-5",
      tokens: step, at: i * 4_000,
    });
    overAlerts.push(...r.alerts);
    assert.equal(r.stop, null, "no step pushes own-spend past the 6M stop line");
  }
  const spend = overAlerts.filter((a) => a.kind === "session-spend");
  assert.equal(spend.length, 1, "72 steps = 3.60M weighted crosses the 3.5M line exactly once");
});

test("session spend stops a runaway of any shape only at 6M weighted in five minutes", () => {
  const watch = createBurnWatch();
  // Output-heavy: nothing re-sent, but 101K weighted per step, every 4.5 s.
  const results = Array.from({ length: 64 }, (_, i) =>
    watch.recordUsage({ sessionID: "ses_output", providerID: "openai", modelID: "gpt-sol", tokens: { input: 1_000, output: 100_000 }, at: i * 4_500 }));
  assert.equal(results.findIndex((r) => r.alerts.some((a) => /is burning abnormally/.test(a.title))), 34, "35 * 101K = 3.535M is the first step over the 3.5M notify line");
  const first = results.findIndex((r) => r.stop);
  assert.equal(first, 59, "60 x 101K = 6.06M is the first step over the stop limit");
  assert.match(results[first].stop.reason, /spent 6\.06M weighted tokens in 5 min \(stop limit 6\.00M\)/);
  // The report that stops emits ONLY the stop alert, never ALSO a session-spend alert on it.
  const kinds = results[first].alerts.map((a) => a.kind);
  assert.deepEqual(kinds, ["stop"], "a stop report never also carries a session-spend alert");
});

// ☠️ The removed signal: eight unrelated healthy sessions used to trip provider-spend by
// sheer parallelism. They must not alert at all now.
test("eight unrelated sessions whose combined spend exceeds 3M in five minutes raise no alert", () => {
  const watch = createBurnWatch();
  const alerts = [];
  let stops = 0;
  for (let i = 0; i < 80; i++) {
    const r = watch.recordUsage({
      sessionID: `ses_child_${i % 8}`, providerID: "anthropic", modelID: "claude-opus-5",
      tokens: { input: 1_000, output: 40_000 }, at: i * 3_000,
    });
    alerts.push(...r.alerts);
    if (r.stop) stops += 1;
  }
  assert.equal(stops, 0, "each of eight independent sessions stays far under its own limit");
  assert.deepEqual(alerts, [], "no all-sessions aggregate alert fires anymore");
});

// The reason the signal existed: fan-out that stayed below the per-session line. Now rolled
// up into the ROOT (the parent that spawned the children). Each child here sees 10 steps
// at 51K weighted = 510K on its own (far under 3.5M); the tree sums to 80 x 51K = 4.08M.
test("eight children of one root each under 3.5M but summing past it raise one tree alert for the root", () => {
  const watch = createBurnWatch();
  const alerts = [];
  for (let i = 0; i < 80; i++) {
    const r = watch.recordUsage({
      sessionID: `ses_child_${i % 8}`, rootSessionID: "ses_root",
      providerID: "anthropic", modelID: "claude-opus-5",
      tokens: { input: 1_000, output: 50_000 }, at: i * 3_000,
    });
    alerts.push(...r.alerts);
    assert.equal(r.stop, null, "no child is itself over the stop line");
  }
  const spend = alerts.filter((a) => a.kind === "session-spend");
  assert.equal(spend.length, 1, "exactly one alert for the root tree");
  assert.equal(spend[0].title, "Burn watch: session ses_root is burning abnormally",
    "the title names the ROOT and carries no provider id");
  assert.match(spend[0].body, /across 8 subagent session\(s\)/,
    "the body names the subagent count when the tree has more than one session");
  assert.match(spend[0].body, /It was not stopped/);
});

// A tree whose children's SUMMED spend crosses the stop line but no single child's own
// spend does -- stops are per actual session, so none is stopped; the tree is only notified.
test("a tree summing past 6M with no single child's OWN spend over 6M is only notified, never stopped", () => {
  const watch = createBurnWatch();
  const alerts = [];
  let stops = 0;
  // Ten children, each ~700K weighted. Summed: ~7M, past the 6M stop line. No child
  // alone passes it.
  for (let i = 0; i < 70; i++) {
    const r = watch.recordUsage({
      sessionID: `ses_child_${i % 10}`, rootSessionID: "ses_root",
      providerID: "anthropic", modelID: "claude-opus-5",
      tokens: { input: 1_000, output: 100_000 }, at: i * 3_000,
    });
    alerts.push(...r.alerts);
    if (r.stop) stops += 1;
  }
  assert.equal(stops, 0, "no child alone crosses its own stop line; stops are per actual session");
  const spend = alerts.filter((a) => a.kind === "session-spend");
  assert.equal(spend.length, 1, "exactly one tree notify for the root");
});

// Lone session, once stopped, must re-earn 6M of its OWN spend before being stopped again:
// after sessions.delete the per-session window is empty, and the stop check uses that
// window -- not the tree's -- so the pre-stop evidence does not count again.
test("a lone session, once stopped, continues at the same rate without a second stop until its own 6M is re-earned", () => {
  const watch = createBurnWatch();
  const step = (i) => watch.recordUsage({
    sessionID: "ses_lone", providerID: "openai", modelID: "gpt-sol",
    tokens: { input: 1_000, output: 100_000 }, at: i * 3_000,
  });
  const results = Array.from({ length: 100 }, (_, i) => step(i));
  const firstStop = results.findIndex((r) => r.stop);
  assert.ok(firstStop > 0, `the lone session is stopped exactly once; got firstStop=${firstStop}`);
  // The 20 steps that immediately follow the stop re-enter at ~101K/step. If the stopped
  // window still sat in trees/own, the next few steps would stop again on pre-stop evidence.
  const nextTwenty = results.slice(firstStop + 1, firstStop + 21).filter((r) => r.stop).length;
  assert.equal(nextTwenty, 0,
    "the continued lone session must not be stopped again until it re-earns its own 6M");
});

// Pre-stop entries of a stopped session must not keep the TREE above the notify line
// after the stop, either: that spend has been acted on. Keep other members' entries.
test("after a stop, the stopped session's entries are removed from the tree history (other members keep theirs)", () => {
  const watch = createBurnWatch();
  // Child A trips the rewrite signature with ~1.7M of fresh writes.
  for (let i = 0; i < 4; i++) {
    const r = watch.recordUsage({
      sessionID: "ses_A", rootSessionID: "ses_root",
      providerID: "anthropic", modelID: "claude-opus-5",
      tokens: rewrite(430_000), at: i * 10_000,
    });
    if (i < 3) assert.equal(r.stop, null);
    else assert.ok(r.stop, "A is stopped on its 4th full re-send");
  }
  // Child B now spends 2.02M weighted on its own -- under 3.5M alone. If A's pre-stop
  // entries persisted in trees[root], A's ~1.73M-weighted history plus B's 2.02M (= 3.75M)
  // would push the tree past the 3.5M notify line. They do not persist, so B alone does
  // not notify.
  const alerts = [];
  for (let i = 0; i < 20; i++) {
    const r = watch.recordUsage({
      sessionID: "ses_B", rootSessionID: "ses_root",
      providerID: "openai", modelID: "gpt-sol",
      tokens: { input: 1_000, output: 100_000 }, at: 60_000 + i * 1_000,
    });
    alerts.push(...r.alerts);
  }
  const spend = alerts.filter((a) => a.kind === "session-spend");
  assert.equal(spend.length, 0,
    "B's own 2.02M is under 3.5M; A's pre-stop spend has been acted on and must not count");
});

// Subagent count is distinct sessions in the tree window EXCLUDING the root; and the
// phrase appears only when at least one subagent reported.
test("subagent count excludes the root and the phrase disappears when the root is alone", () => {
  const watch = createBurnWatch();
  const alerts = [];
  // Root reports some, plus two children -- distinct subagent sessions = 2, not 3.
  for (let i = 0; i < 30; i++) {
    const r = watch.recordUsage({
      sessionID: "ses_root", rootSessionID: "ses_root",
      providerID: "anthropic", modelID: "claude-opus-5",
      tokens: { input: 1_000, output: 40_000 }, at: i * 3_000,
    });
    alerts.push(...r.alerts);
  }
  for (let i = 0; i < 30; i++) {
    const r = watch.recordUsage({
      sessionID: "ses_child_A", rootSessionID: "ses_root",
      providerID: "anthropic", modelID: "claude-opus-5",
      tokens: { input: 1_000, output: 40_000 }, at: 100_000 + i * 3_000,
    });
    alerts.push(...r.alerts);
  }
  for (let i = 0; i < 30; i++) {
    const r = watch.recordUsage({
      sessionID: "ses_child_B", rootSessionID: "ses_root",
      providerID: "anthropic", modelID: "claude-opus-5",
      tokens: { input: 1_000, output: 40_000 }, at: 200_000 + i * 3_000,
    });
    alerts.push(...r.alerts);
  }
  const spend = alerts.filter((a) => a.kind === "session-spend");
  assert.ok(spend.length >= 1);
  assert.match(spend[0].body, /across 2 subagent session\(s\)/,
    `the subagent count counts children only (not the root): ${spend[0].body}`);
});

// Cooldown still applies to a root key. 80 steps of 51K weighted = 4.08M, over the
// 3.5M notify line; per-child own-spend 10 x 51K = 510K stays far under 6M.
test("same root again inside cooldown raises no second tree alert", () => {
  const watch = createBurnWatch();
  const alerts = [];
  for (let i = 0; i < 80; i++) {
    const r = watch.recordUsage({
      sessionID: `ses_child_${i % 8}`, rootSessionID: "ses_root",
      providerID: "anthropic", modelID: "claude-opus-5",
      tokens: { input: 1_000, output: 50_000 }, at: i * 3_000,
    });
    alerts.push(...r.alerts);
  }
  const first = alerts.filter((a) => a.kind === "session-spend");
  assert.equal(first.length, 1);
  // Another big step from the same tree, well before the cooldown expires.
  const again = watch.recordUsage({
    sessionID: "ses_child_0", rootSessionID: "ses_root",
    providerID: "anthropic", modelID: "claude-opus-5",
    tokens: { input: 1_000, output: 100_000 }, at: 240_000 + 3_000,
  });
  assert.deepEqual(again.alerts.filter((a) => a.kind === "session-spend"), [],
    "the root's cooldown blocks a second alert");
});

// Stops stay per actual sessionID -- the looping child, never the whole tree.
test("a looping child still gets a per-session stop that names its root, and the tree does not also alert", () => {
  const watch = createBurnWatch();
  const t0 = 1_000_000;
  const steps = [
    [0, rewrite(427_000)], [6, cached(444_000)], [16, rewrite(427_000)], [39, rewrite(428_000)],
    [44, cached(445_000)], [53, cached(445_000)], [70, rewrite(429_000)], [75, cached(446_000)],
  ];
  const results = steps.map(([s, tokens]) =>
    watch.recordUsage({
      sessionID: "ses_child", rootSessionID: "ses_root",
      providerID: "anthropic", modelID: "claude-opus-5",
      tokens, at: t0 + s * 1000,
    }));
  const stopIndex = results.findIndex((r) => r.stop);
  assert.equal(stopIndex, 6, "the per-session rewrite signature still trips on the 4th re-send");
  const stopAlerts = results[stopIndex].alerts;
  assert.equal(stopAlerts.length, 1, "a stop report emits only the stop alert");
  assert.equal(stopAlerts[0].kind, "stop");
  assert.equal(stopAlerts[0].title, "Burn watch stopped a session");
  assert.match(stopAlerts[0].body, /Session ses_child.*\(a subagent of ses_root\)/,
    "the stop body names the child and its root");
  assert.match(stopAlerts[0].body, /anthropic\/claude-opus-5/);
});

// Tree-spend is provider-agnostic: two providers are summed and both pairs listed.
test("a tree spending on two providers is summed, and both provider/model pairs appear in the body", () => {
  const watch = createBurnWatch();
  // Child A on anthropic, child B on openai. Each child alone: 40 x 51K = 2.04M, under
  // the 3.5M line. Tree sum: 80 x 51K = 4.08M, over the line.
  const alerts = [];
  for (let i = 0; i < 40; i++) {
    const r = watch.recordUsage({
      sessionID: "ses_child_A", rootSessionID: "ses_root",
      providerID: "anthropic", modelID: "claude-opus-5",
      tokens: { input: 1_000, output: 50_000 }, at: i * 6_000,
    });
    alerts.push(...r.alerts);
  }
  for (let i = 0; i < 40; i++) {
    const r = watch.recordUsage({
      sessionID: "ses_child_B", rootSessionID: "ses_root",
      providerID: "openai", modelID: "gpt-sol",
      tokens: { input: 1_000, output: 50_000 }, at: i * 6_000 + 3_000,
    });
    alerts.push(...r.alerts);
  }
  const spend = alerts.filter((a) => a.kind === "session-spend");
  assert.ok(spend.length >= 1, "the summed tree crosses 3.5M even though each child does not");
  assert.ok(/anthropic\/claude-opus-5/.test(spend[0].body) && /openai\/gpt-sol/.test(spend[0].body),
    `both provider/model pairs appear in the body, got: ${spend[0].body}`);
});

test("thresholds come from config", () => {
  const watch = createBurnWatch({ config: { rewriteCount: 2, rewriteVolumeTokens: 200_000 } });
  assert.equal(watch.recordUsage({ sessionID: "ses_a", providerID: "openai", tokens: rewrite(120_000), at: 0 }).stop, null);
  assert.ok(watch.recordUsage({ sessionID: "ses_a", providerID: "openai", tokens: rewrite(120_000), at: 1_000 }).stop);
});

// The broker runs for weeks and a gateway mints a session id per request: sessions, trees
// and cooldowns whose windows have passed must not stay in memory.
test("finished sessions, trees and expired cooldowns are dropped from memory", () => {
  const watch = createBurnWatch();
  for (let i = 0; i < 100; i++) {
    watch.recordUsage({
      sessionID: `gw-${i}`, rootSessionID: `root-${i % 10}`,
      providerID: "anthropic", tokens: cached(10_000), at: i * 100,
    });
  }
  const held = watch.tracked();
  assert.equal(held.sessions, 100);
  assert.equal(held.trees, 10, "trees are tracked distinct from sessions");
  watch.recordUsage({ sessionID: "ses_later", providerID: "anthropic", tokens: cached(10_000), at: 60 * MIN });
  assert.deepEqual(watch.tracked(), { sessions: 1, trees: 1, cooldowns: 0 });
});

// The factory no longer exports recordPlan: the plan-rise signal was removed because it
// could only fire for providers that publish a plan percent and never caught a runaway.
test("createBurnWatch exposes only recordUsage and tracked", () => {
  const watch = createBurnWatch();
  assert.equal(typeof watch.recordUsage, "function");
  assert.equal(typeof watch.tracked, "function");
  assert.equal(watch.recordPlan, undefined, "recordPlan is gone");
});
