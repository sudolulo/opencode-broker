// modelCapacity: a second, model-wide limit on local targets that share one llama.cpp model.
import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const { modelSlotKey, targetFull, localContextEligible } = await import("../lib/routing.js");

const coder = { id: "local-coder", providerID: "llamacpp", modelID: "qwen3.5-9b", kind: "local", capacity: 4, modelCapacity: 3 };
const classifier = { id: "local-classifier", providerID: "llamacpp", modelID: "qwen3.5-9b", kind: "local", capacity: 2, modelCapacity: 4 };
const cloud = { id: "gpt-luna", providerID: "openai", modelID: "gpt-5.6-luna", kind: "cloud", capacity: null };

test("targets on one local model share a slot key; cloud targets have none", () => {
  assert.equal(modelSlotKey(coder), "model:llamacpp/qwen3.5-9b");
  assert.equal(modelSlotKey(coder), modelSlotKey(classifier));
  assert.equal(modelSlotKey(cloud), null);
  assert.ok(!modelSlotKey(coder).includes("local-coder"), "the key names the model, never a target");
});

test("a target is full at its own capacity OR at the model-wide limit, whichever comes first", () => {
  const key = modelSlotKey(coder);
  assert.equal(targetFull(coder, { "local-coder": 2, [key]: 2 }), false);
  assert.equal(targetFull(coder, { "local-coder": 1, [key]: 3 }), true, "siblings' leases count against modelCapacity");
  assert.equal(targetFull(classifier, { "local-classifier": 1, [key]: 3 }), false, "the classifier may take the reserved slot");
  assert.equal(targetFull(classifier, { "local-classifier": 2, [key]: 2 }), true, "its own capacity still binds");
  assert.equal(targetFull(cloud, { "gpt-luna": 99 }), false);
});

test("a target without modelCapacity keeps the per-target rule exactly", () => {
  const legacy = { ...coder, modelCapacity: undefined };
  assert.equal(targetFull(legacy, { "local-coder": 3, [modelSlotKey(coder)]: 9 }), false);
  assert.equal(targetFull(legacy, { "local-coder": 4 }), true);
});

// The broker's own eligibility re-check and chooseTarget must size a local window the same
// way. With an output reserve declared, the reserve wins over the headroom fraction.
test("an output reserve sizes a local window, not the headroom fraction", () => {
  assert.equal(localContextEligible(196608, 140000, 0.6, 49152), true, "196,608 - 49,152 = 147,456 admits 140k");
  assert.equal(localContextEligible(196608, 140000, 0.6), false, "the bare fraction (117,964) would refuse it");
});
