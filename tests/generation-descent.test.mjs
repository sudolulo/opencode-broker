import assert from "node:assert/strict";
import test from "node:test";

import { orderedReserveDescent } from "../lib/generation-descent.js";

test("orderedReserveDescent walks each requested primary's reserve chain in primary-major order", () => {
  const mappings = {
    newest: ["newer", "oldest"],
    middle: ["middle-old"],
  };

  assert.deepEqual(orderedReserveDescent(["middle", "newest"], mappings), [
    { primaryID: "middle", targetID: "middle-old", rank: 0 },
    { primaryID: "newest", targetID: "newer", rank: 0 },
    { primaryID: "newest", targetID: "oldest", rank: 1 },
  ]);
});

test("orderedReserveDescent returns empty chains for absent or non-array mappings", () => {
  assert.deepEqual(orderedReserveDescent(["missing", "bad"], { bad: "not-an-array" }), []);
  assert.deepEqual(orderedReserveDescent(["missing"], null), []);
});

test("orderedReserveDescent preserves duplicate primary and reserve entries without mutation", () => {
  const primaryIDs = ["head", "head"];
  const reserves = ["same", "same"];
  const mappings = { head: reserves };

  assert.deepEqual(orderedReserveDescent(primaryIDs, mappings), [
    { primaryID: "head", targetID: "same", rank: 0 },
    { primaryID: "head", targetID: "same", rank: 1 },
    { primaryID: "head", targetID: "same", rank: 0 },
    { primaryID: "head", targetID: "same", rank: 1 },
  ]);
  assert.deepEqual(primaryIDs, ["head", "head"]);
  assert.deepEqual(reserves, ["same", "same"]);
});
