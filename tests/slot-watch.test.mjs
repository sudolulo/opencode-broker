import assert from "node:assert/strict";
import test from "node:test";
import { createSlotWatch, parseLlamaMetrics } from "../lib/slot-watch.js";

const MIN = 60_000;

test("reads llama.cpp's processing and deferred counts, and null when absent", () => {
  const text = [
    "# HELP llamacpp:requests_processing Number of requests processing.",
    "llamacpp:requests_processing 4",
    "llamacpp:requests_deferred 2",
    "llamacpp:n_busy_slots_per_decode 1.34168",
  ].join("\n");
  assert.deepEqual(parseLlamaMetrics(text), { processing: 4, deferred: 2 });
  assert.deepEqual(parseLlamaMetrics("nothing here"), { processing: null, deferred: null });
});

test("one queued sample is a busy moment; two in a row is oversaturation, notified once per cooldown", () => {
  const watch = createSlotWatch();
  const at = (m) => m * MIN;
  assert.deepEqual(watch.record({ modelID: "small-model", processing: 4, deferred: 1, at: at(0) }), []);
  assert.deepEqual(watch.record({ modelID: "small-model", processing: 4, deferred: 0, at: at(1) }), [], "cleared: the streak resets");
  assert.deepEqual(watch.record({ modelID: "small-model", processing: 4, deferred: 1, at: at(2) }), []);
  const alerts = watch.record({ modelID: "small-model", processing: 4, deferred: 3, at: at(3) });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "slot-deferred");
  assert.match(alerts[0].title, /small-model is oversaturated/);
  assert.match(alerts[0].body, /3 request\(s\) waiting for a slot with 4 processing, for 2 min/);
  assert.deepEqual(watch.record({ modelID: "small-model", processing: 4, deferred: 3, at: at(4) }), [], "cooldown");
  assert.equal(watch.record({ modelID: "small-model", processing: 4, deferred: 1, at: at(40) }).length, 1, "after the cooldown it notifies again");
});

test("models are tracked separately", () => {
  const watch = createSlotWatch();
  watch.record({ modelID: "small-model", processing: 4, deferred: 1, at: 0 });
  assert.deepEqual(watch.record({ modelID: "big-model", processing: 2, deferred: 1, at: MIN }), []);
});
