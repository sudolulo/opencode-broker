import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const { meetsContextFloor } = await import("../lib/routing.js");

test("a target without a floor is unaffected", () => {
  assert.equal(meetsContextFloor({}, 0), true);
  assert.equal(meetsContextFloor({ minContextTokens: 0 }, 5), true);
  assert.equal(meetsContextFloor({}, null), true, "no floor stays permissive on unknown size");
});

test("a floor rejects work below it and admits work at or above it", () => {
  const t = { minContextTokens: 8000 };
  assert.equal(meetsContextFloor(t, 50), false);
  assert.equal(meetsContextFloor(t, 7999), false);
  assert.equal(meetsContextFloor(t, 8000), true, "boundary is inclusive");
  assert.equal(meetsContextFloor(t, 40000), true);
});

// A floor is a claim about the request's size, so it cannot be evaluated without
// one. Local targets already refuse an unknown context upstream; this keeps the
// floor itself from silently admitting what it was added to exclude.
test("a floor rejects an unknown context rather than admitting it", () => {
  const t = { minContextTokens: 8000 };
  assert.equal(meetsContextFloor(t, null), false);
  assert.equal(meetsContextFloor(t, undefined), false);
  assert.equal(meetsContextFloor(t, NaN), false);
});

// End-to-end through chooseTarget. Lane membership comes from the CONFIG
// profiles, so this reuses the fixture's own ids ("uncensored" holds two local
// targets) and overrides just their definitions to give one of them a floor.
const R = await import("../lib/routing.js");

const withFloor = {
  "uncensored-qwen":    { id: "uncensored-qwen", providerID: "llamacpp", modelID: "unc-qwen",
                          kind: "local", capacity: 6, context: 65536 },
  "uncensored-floored": { id: "uncensored-floored", providerID: "llamacpp", modelID: "unc-floored",
                          kind: "local", capacity: 2, context: 65536, minContextTokens: 8000 },
};
const deployed = new Set(["unc-qwen", "unc-floored"]);
const sweep = (contextTokens) => {
  const seen = new Set();
  for (let cursor = 0; cursor < 8; cursor += 1) {
    const got = R.chooseTarget({
      profile: "uncensored", tier: "worker", targets: withFloor,
      localModels: deployed, contextTokens, cursors: { "uncensored:worker:local": cursor },
      tierWeights: {},
    });
    if (got) seen.add(got.target.id);
  }
  return seen;
};

test("a floored target is never selected for work below its floor", () => {
  const seen = sweep(500);
  assert.ok(seen.size, "something must still serve a small request");
  assert.deepEqual([...seen], ["uncensored-qwen"],
    "the floored target must not appear for a 500-token request");
});

test("the floored target becomes selectable once the request clears its floor", () => {
  const seen = sweep(20000);
  assert.ok(seen.has("uncensored-floored"), "must be reachable above its floor");
});
