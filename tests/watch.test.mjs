import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const { normalizeModelLine, watchReport, formatReport } = await import("../lib/watch.js");

test("line normalization groups versions and snapshots, separates products", () => {
  assert.equal(normalizeModelLine("qwen3.8-flash"), normalizeModelLine("qwen3.9-flash"));
  assert.equal(normalizeModelLine("deepseek-v4-pro-0813"), normalizeModelLine("deepseek-v4-pro"));
  assert.equal(normalizeModelLine("gpt-5.6-luna"), normalizeModelLine("gpt-5.7-luna"));
  assert.notEqual(normalizeModelLine("qwen3.8-flash"), normalizeModelLine("qwen3.8-max"));
  assert.notEqual(normalizeModelLine("gpt-5.6-luna"), normalizeModelLine("gpt-5.6-terra"));
  assert.equal(normalizeModelLine("claude-opus-5"), normalizeModelLine("claude-opus-4-8"));
});

const catalog = {
  a: { id: "alibaba-token-plan", models: {
    "qwen3.8-flash": { id: "qwen3.8-flash", release_date: "2026-08-26", tool_call: true },
    "qwen3.9-flash": { id: "qwen3.9-flash", release_date: "2026-10-01", tool_call: true, cost: { input: 0.1, output: 0.3 } },
    "happy-video": { id: "happy-video", release_date: "2026-10-02", tool_call: false },
  } },
  b: { id: "anthropic", models: {
    "claude-nova-1": { id: "claude-nova-1", family: "claude-nova", release_date: "2026-10-03", tool_call: true },
  } },
  c: { id: "unwatched", models: { "x-1": { id: "x-1", tool_call: true } } },
};
const targets = { "qwen-flash": { id: "qwen-flash", providerID: "alibaba-token-plan", modelID: "qwen3.8-flash", kind: "cloud" } };

test("watch reports new models once, newer line-mates, and unmapped families", () => {
  const first = watchReport({
    catalog,
    reviewed: { "alibaba-token-plan/qwen3.8-flash": "2026-08-31" },
    targets,
    watchProviders: ["alibaba-token-plan", "anthropic"],
  });
  assert.deepEqual(first.newModels.map((m) => m.id).sort(), ["claude-nova-1", "qwen3.9-flash"],
    "tool-incapable and unwatched-provider models are ignored");
  assert.deepEqual(first.newerInLine, [{
    providerID: "alibaba-token-plan", targetID: "qwen-flash",
    pinned: "qwen3.8-flash", newer: "qwen3.9-flash", releaseDate: "2026-10-01",
  }]);
  // Provider-qualified: a family name is only unique within its provider, and the tier
  // table is keyed the same way.
  assert.deepEqual(first.newFamilies, ["anthropic:claude-nova"]);
  const reviewed = Object.fromEntries(first.seenKeys.map((key) => [key, "2026-08-31"]));
  const second = watchReport({ catalog, reviewed, targets, watchProviders: ["alibaba-token-plan", "anthropic"] });
  assert.deepEqual(second.newModels, [], "everything reports exactly once");
  assert.deepEqual(second.newFamilies, [],
    "an unmapped family is a one-shot notice: leaving it unmapped is a decision, not a standing alarm");
  assert.equal(second.newerInLine.length, 1, "a stale pin keeps nagging until repinned");
  const lines = formatReport(first);
  assert.ok(lines.some((line) => line.includes("NEW FAMILY anthropic:claude-nova")));
  assert.ok(lines.some((line) => line.includes("qwen3.9-flash")));
});
