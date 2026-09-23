import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeCaller, summarizeUsage, usageRecord } from "../lib/usage-log.js";

test("a record's prompt is everything the model read: input, cache reads and cache writes", () => {
  const record = usageRecord({
    at: 1, sessionID: "ses_a", providerID: "llamacpp", modelID: "small",
    lease: { targetID: "local-coder", profile: "auto", tier: "worker" },
    tokens: { input: 1_000, cacheRead: 20_000, cacheWrite: 500, output: 300 }, local: true,
  });
  assert.deepEqual(record, {
    at: 1, sessionID: "ses_a", providerID: "llamacpp", modelID: "small", targetID: "local-coder",
    profile: "auto", tier: "worker", prompt: 21_500, input: 1_000, cacheRead: 20_000, cacheWrite: 500,
    output: 300, local: true,
  });
  assert.equal(record.prompt, record.input + record.cacheRead + record.cacheWrite, "the total is the split added back up");
  assert.equal(usageRecord({ at: 1, providerID: "x", tokens: {} }).targetID, null, "no lease is recorded as null, not guessed");
});

// Why the split is kept and not just the total: after a burn-watch stop, the only question that
// matters is whether the session was re-sending an uncached prompt. `prompt` alone cannot answer it.
test("a fully uncached prompt and a fully cached one of the same size are distinguishable", () => {
  const rec = (tokens) => usageRecord({ at: 1, sessionID: "ses_a", providerID: "anthropic", modelID: "m", tokens, local: false });
  const uncached = rec({ input: 270_000, output: 500, cacheRead: 0, cacheWrite: 0 });
  const cached = rec({ input: 1_000, output: 500, cacheRead: 269_000, cacheWrite: 0 });
  assert.equal(uncached.prompt, cached.prompt, "the same size prompt, so the same `prompt`");
  assert.equal(uncached.input, 270_000);
  assert.equal(uncached.cacheRead, 0, "a zero cache read is the signal, so it is recorded, not omitted");
  assert.ok("cacheRead" in uncached, "the field is always present");
  assert.equal(cached.input, 1_000);
  assert.equal(cached.cacheRead, 269_000);
  assert.equal(uncached.cacheWrite, 0);
  assert.equal(cached.cacheWrite, 0);
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

test("a caller is an address and a short model name, and anything else is dropped", () => {
  assert.deepEqual(sanitizeCaller({ address: "192.168.50.1", model: "background" }), { address: "192.168.50.1", model: "background" });
  assert.deepEqual(sanitizeCaller({ address: "::1" }), { address: "::1", model: null });
  assert.equal(sanitizeCaller({ address: "evil; rm -rf /", model: "x\n" }), null);
  assert.equal(sanitizeCaller("192.168.50.1"), null);
});

test("the summary names who used each model", () => {
  const rec = (sessionID, caller) => ({ at: 10, sessionID, providerID: "llamacpp", modelID: "small", prompt: 1, output: 1, local: true, ...(caller ? { caller } : {}) });
  const [row] = summarizeUsage([
    rec("gw-1", { address: "10.0.0.5", model: "background" }),
    rec("gw-2", { address: "10.0.0.5", model: "background" }),
    rec("ses_abc"),
    rec("gw-3", { address: "10.0.0.9", model: "quick" }),
  ]);
  assert.deepEqual(row.callers, [
    { caller: "10.0.0.5 background", requests: 2 },
    { caller: "opencode", requests: 1 },
    { caller: "10.0.0.9 quick", requests: 1 },
  ]);
});
