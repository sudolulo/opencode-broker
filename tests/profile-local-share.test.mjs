// `profileLocalShare`: the auto worker lane's one-in-N local reservation, for a named
// profile whose lane mixes local and cloud targets. Without it a mixed profile is
// weighted depletion over its cloud targets alone and only reaches its local target
// once every cloud target is out. The fleet's `memory` lane (supermemory ingestion) is
// balanced this way, like the worker lane, over its cloud models and the 9b.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

// config.js reads its file once at import time, so the fixture has to be in place first.
process.env.OPENCODE_BROKER_CONFIG = fileURLToPath(new URL("./fixtures/profile-local-share.config.json", import.meta.url));
const { CONFIG } = await import(new URL("../lib/config.js", import.meta.url).href);
const R = await import(new URL("../lib/routing.js", import.meta.url).href);

const localModels = new Set(["lan-9b"]);
const choose = (profile, cursor, extra = {}) => R.chooseTarget({
  profile,
  tier: "worker",
  localModels,
  contextTokens: 1000,
  cursors: { [`${profile}:worker:mixed`]: cursor },
  ...extra,
});

test("only a configured profile with an integer share of at least 2 is kept", () => {
  assert.deepEqual({ ...CONFIG.profileLocalShare }, { memory: 2 });
});

test("a shared profile sends every Nth lease to its local target", () => {
  assert.equal(choose("memory", 0).target.id, "lan-memory");
  assert.equal(choose("memory", 1).target.kind, "cloud");
  assert.equal(choose("memory", 2).target.id, "lan-memory");
  assert.equal(choose("memory", 0).decision.policy, "weighted-depletion-with-local-share");
});

test("the cloud leases reach every provider in the lane, not one pinned target", () => {
  const now = Date.now();
  const out = (provider) => ({ now, circuits: { [`provider:${provider}`]: { until: now + 60_000 } } });
  const seen = new Set();
  for (const blocked of [["openai", "anthropic"], ["alibaba-token-plan", "anthropic"], ["openai", "alibaba-token-plan"]]) {
    const circuits = Object.assign({}, ...blocked.map((provider) => out(provider).circuits));
    seen.add(choose("memory", 1, { now, circuits }).target.providerID);
  }
  assert.deepEqual([...seen].sort(), ["alibaba-token-plan", "anthropic", "openai"]);
});

test("a full local target sends the lease to cloud instead of waiting", () => {
  const full = choose("memory", 0, { active: { "lan-memory": 2 } });
  assert.equal(full.target.kind, "cloud");
});

test("a mixed profile without a share keeps the old cloud-first behaviour", () => {
  assert.equal(choose("mixed-unshared", 0).target.id, "gpt-luna");
});
