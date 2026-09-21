import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUsage, usageRecord } from "../lib/usage-log.js";

test("a record's prompt is everything the model read: input, cache reads and cache writes", () => {
  const record = usageRecord({
    at: 1, sessionID: "ses_a", providerID: "llamacpp", modelID: "small",
    lease: { targetID: "local-coder", profile: "auto", tier: "worker" },
    tokens: { input: 1_000, cacheRead: 20_000, cacheWrite: 500, output: 300 }, local: true,
  });
  assert.deepEqual(record, {
    at: 1, sessionID: "ses_a", providerID: "llamacpp", modelID: "small", targetID: "local-coder",
    profile: "auto", tier: "worker", prompt: 21_500, output: 300, local: true,
  });
  assert.equal(usageRecord({ at: 1, providerID: "x", tokens: {} }).targetID, null, "no lease is recorded as null, not guessed");
});

test("the summary reports each session's PEAK, not its lease-time size, and what fits each local window", () => {
  const rec = (sessionID, prompt, at = 10) => ({ at, sessionID, providerID: "llamacpp", modelID: "small", prompt, output: 10, local: true });
  // One session that starts small and grows through its turn, as a subagent does.
  const records = [rec("grow", 2_000), rec("grow", 30_000), rec("grow", 90_000), rec("small", 5_000), rec("old", 999_999, 1)];
  const target = { id: "local-coder", kind: "local", providerID: "llamacpp", modelID: "small" };
  const [row] = summarizeUsage(records, { since: 5, targets: { "local-coder": target }, ceilingOf: () => 81_920 });
  assert.equal(row.model, "llamacpp/small");
  assert.equal(row.requests.count, 4, "the record older than `since` is excluded");
  assert.equal(row.sessionPeaks.count, 2);
  assert.equal(row.sessionPeaks.max, 90_000);
  assert.deepEqual(row.windows, [{ targetID: "local-coder", ceiling: 81_920, sessionsFit: 1 }]);
});

test("local models sort first, then by request count", () => {
  const rows = summarizeUsage([
    { at: 1, sessionID: "a", providerID: "cloud", modelID: "big", prompt: 1, output: 1, local: false },
    { at: 1, sessionID: "a", providerID: "cloud", modelID: "big", prompt: 1, output: 1, local: false },
    { at: 1, sessionID: "b", providerID: "llamacpp", modelID: "small", prompt: 1, output: 1, local: true },
  ]);
  assert.deepEqual(rows.map((row) => row.model), ["llamacpp/small", "cloud/big"]);
});
