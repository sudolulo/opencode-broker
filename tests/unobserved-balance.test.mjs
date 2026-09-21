import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const { balanceUnobservedUtilization, utilizationIsObserved } = await import("../lib/routing.js");

const cloud = (id, providerID) => ({ id, providerID, kind: "cloud" });
const local = (id) => ({ id, providerID: "llamacpp", kind: "local" });

test("an unobserved provider floats up to the mean of the observed ones", () => {
  const targets = [cloud("a", "seen1"), cloud("b", "seen2"), cloud("c", "blind")];
  const u = new Map([["a", 0.2], ["b", 0.4], ["c", 0.0]]);
  const balance = balanceUnobservedUtilization(targets, u, (p) => p !== "blind");
  assert.ok(Math.abs(balance - 0.3) < 1e-9, "balance is the mean of 0.2 and 0.4");
  assert.ok(Math.abs(u.get("c") - 0.3) < 1e-9, "the blind provider sits at the balance point");
  assert.equal(u.get("a"), 0.2, "observed values are untouched");
  assert.equal(u.get("b"), 0.4);
});

// The point is not to hide a heavy lane -- only to stop an unreadable one
// looking empty. A high inferred figure is real evidence and must survive.
test("a HIGHER inferred figure is kept, not lowered to the balance point", () => {
  const targets = [cloud("a", "seen"), cloud("c", "blind")];
  const u = new Map([["a", 0.2], ["c", 0.9]]);
  balanceUnobservedUtilization(targets, u, (p) => p !== "blind");
  assert.equal(u.get("c"), 0.9, "heavy inferred usage is not discarded");
});

test("local targets are never balanced -- their 0 is a fact, not a gap", () => {
  const targets = [cloud("a", "seen"), local("L")];
  const u = new Map([["a", 0.8], ["L", 0]]);
  balanceUnobservedUtilization(targets, u, (p) => p === "seen");
  assert.equal(u.get("L"), 0, "a local target has no quota to deplete");
});

test("with nothing observed there is no balance point, so nothing moves", () => {
  const targets = [cloud("a", "blind1"), cloud("b", "blind2")];
  const u = new Map([["a", 0.0], ["b", 0.1]]);
  assert.equal(balanceUnobservedUtilization(targets, u, () => false), null);
  assert.equal(u.get("a"), 0.0);
  assert.equal(u.get("b"), 0.1);
});

test("with nothing unobserved it is a no-op", () => {
  const targets = [cloud("a", "seen"), cloud("b", "seen")];
  const u = new Map([["a", 0.1], ["b", 0.5]]);
  assert.equal(balanceUnobservedUtilization(targets, u, () => true), null);
  assert.equal(u.get("a"), 0.1);
});

// The real regression: the blind provider used to win every comparison.
test("the blind provider no longer beats the leanest observed one outright", () => {
  const targets = [cloud("anthropic-t", "anthropic"), cloud("openai-t", "openai"), cloud("qwen-t", "alibaba")];
  const u = new Map([["anthropic-t", 0.32], ["openai-t", 0.18], ["qwen-t", 0.0275]]);
  balanceUnobservedUtilization(targets, u, (p) => p !== "alibaba");
  const leanest = [...u.entries()].sort((a, b) => a[1] - b[1])[0][0];
  assert.notEqual(leanest, "qwen-t", "an unreadable quota must not be the cheapest-looking lane");
  assert.equal(leanest, "openai-t", "the genuinely leanest observed provider wins instead");
});

test("utilizationIsObserved needs a real percent, not just a plan object", () => {
  assert.equal(utilizationIsObserved("x", { windows: [{ id: "week", percent: 12 }] }), true);
  assert.equal(utilizationIsObserved("x", { windows: [{ id: "week" }] }), false, "no percent = not observed");
  assert.equal(utilizationIsObserved("x", { windows: [] }), false);
  assert.equal(utilizationIsObserved("x", null), false);
});

// ☠️ Utilization is a provider property. A provider fielding several targets in
// a tier must not count several times, or it drags the balance point toward its
// own figure -- observed live as 0.2733 where the true mean was 0.25.
test("the balance point averages per provider, not per target", () => {
  const targets = [
    cloud("anth-1", "anthropic"), cloud("anth-2", "anthropic"),
    cloud("oai-1", "openai"), cloud("blind-1", "alibaba"),
  ];
  const u = new Map([["anth-1", 0.32], ["anth-2", 0.32], ["oai-1", 0.18], ["blind-1", 0.0275]]);
  const balance = balanceUnobservedUtilization(targets, u, (p) => p !== "alibaba");
  assert.ok(Math.abs(balance - 0.25) < 1e-9,
    `expected mean(0.32, 0.18) = 0.25, got ${balance}`);
  assert.ok(Math.abs(u.get("blind-1") - 0.25) < 1e-9);
});
