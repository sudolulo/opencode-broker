import assert from "node:assert/strict";
import test from "node:test";

import {
  contentFilterCascadeOrder,
  normalizeContentFilterCascade,
  isCascadeEnabled,
  DEFAULT_TIER_DESCENT,
  DEFAULT_MAX_ATTEMPTS,
} from "../lib/content-filter-cascade.js";

// A representative slice of the real config.json shapes: targets keyed by target id,
// tiers as ordered target-id arrays, and modelOutages.mappings keyed by target id
// with target-id values (note gpt-6-1-sol's modelID is gpt-6.1-sol -- mappings are
// keyed by the target id, not the model id).
const CONFIG = {
  targets: {
    "claude-opus-5-5": { providerID: "anthropic", modelID: "claude-opus-5-5", kind: "cloud", family: "opus" },
    "claude-opus-5": { providerID: "anthropic", modelID: "claude-opus-5", kind: "cloud", family: "opus" },
    "claude-opus-4-8": { providerID: "anthropic", modelID: "claude-opus-4-8", kind: "cloud", family: "opus" },
    "claude-fable-5-1": { providerID: "anthropic", modelID: "claude-fable-5-1", kind: "cloud", family: "fable" },
    "claude-fable-5": { providerID: "anthropic", modelID: "claude-fable-5", kind: "cloud", family: "fable" },
    "claude-sonnet-5-5": { providerID: "anthropic", modelID: "claude-sonnet-5-5", kind: "cloud", family: "sonnet" },
    "claude-sonnet-5": { providerID: "anthropic", modelID: "claude-sonnet-5", kind: "cloud", family: "sonnet" },
    "claude-sonnet-4-6": { providerID: "anthropic", modelID: "claude-sonnet-4-6", kind: "cloud", family: "sonnet" },
    "claude-sonnet-4-5-20250929": { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929", kind: "cloud", family: "sonnet" },
    "haiku": { providerID: "anthropic", modelID: "claude-haiku-5-5", kind: "cloud" },
    "gpt-6-1-sol": { providerID: "openai", modelID: "gpt-6.1-sol", kind: "cloud", family: "sol" },
    "gpt-flagship": { providerID: "openai", modelID: "gpt-6-sol", kind: "cloud" },
    "gpt-astra": { providerID: "openai", modelID: "gpt-6-astra", kind: "cloud" },
    "gpt-terra": { providerID: "openai", modelID: "gpt-5.6-terra", kind: "cloud" },
    "gpt-luna": { providerID: "openai", modelID: "gpt-6-luna", kind: "cloud" },
    "local-27b": { providerID: "llamacpp", modelID: "qwen3.8-27b", kind: "local" },
    "local-coder": { providerID: "llamacpp", modelID: "qwen3.5-9b", kind: "local" },
    "uncensored-qwen": { providerID: "llamacpp", modelID: "qwen3.8-27b-uncensored", kind: "local" },
  },
  tiers: {
    smart: ["claude-opus-5-5", "gpt-6-1-sol"],
    deep: ["claude-fable-5-1", "gpt-astra", "gpt-6-1-sol"],
    build: ["gpt-terra", "claude-opus-5-5", "local-27b"],
    review: ["claude-sonnet-5-5", "gpt-terra", "local-27b"],
    worker: ["gpt-luna", "haiku", "local-coder"],
  },
  modelOutages: {
    mappings: {
      "claude-opus-5-5": ["claude-opus-5", "claude-opus-4-8"],
      "claude-sonnet-5-5": ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929"],
      "claude-fable-5-1": ["claude-fable-5"],
      "gpt-6-1-sol": ["gpt-flagship"],
    },
  },
  contentFilterCascade: {
    enabled: true,
    tierDescent: ["smart", "deep", "build", "review", "worker"],
    uncensoredFloorTargetID: "uncensored-qwen",
  },
};

const ids = (config, args) => contentFilterCascadeOrder({ config, ...args }).map((c) => c.targetID);

test("smart/anthropic block with full provider reach walks older-gen, then provider, then down the tiers, then the uncensored floor", () => {
  const order = ids(CONFIG, {
    tier: "smart",
    blockedModel: { providerID: "anthropic", modelID: "claude-opus-5-5" },
  });
  assert.deepEqual(order, [
    // 1. older generations of the blocked model, same provider, same tier
    "claude-opus-5", "claude-opus-4-8",
    // 2. switch providers, same tier, newest -> older
    "gpt-6-1-sol", "gpt-flagship",
    // 3. drop a tier (deep): original provider first, then the other
    "claude-fable-5-1", "claude-fable-5", "gpt-astra",
    // build
    "gpt-terra", "local-27b",
    // review
    "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929",
    // worker (original provider first)
    "haiku", "gpt-luna", "local-coder",
    // 4. uncensored local floor
    "uncensored-qwen",
  ]);
});

test("the blocked model is never re-emitted even where later tiers list it again", () => {
  const order = ids(CONFIG, {
    tier: "smart",
    blockedModel: { providerID: "anthropic", modelID: "claude-opus-5-5" },
  });
  assert.ok(!order.includes("claude-opus-5-5"), "claude-opus-5-5 recurs in the build tier but must not reappear");
});

test("an Anthropic /v1/messages turn cascades within Anthropic only (openai/llamacpp cannot serve messages)", () => {
  const order = ids(CONFIG, {
    tier: "smart",
    blockedModel: { providerID: "anthropic", modelID: "claude-opus-5-5" },
    apiEligibleProviders: ["anthropic"],
  });
  assert.deepEqual(order, [
    "claude-opus-5", "claude-opus-4-8",
    "claude-fable-5-1", "claude-fable-5",
    "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929",
    "haiku",
  ]);
  assert.ok(!order.includes("uncensored-qwen"), "the uncensored floor is local-only, unreachable on a messages turn");
});

test("already-tried targets are skipped so the gateway can walk the order by re-leasing", () => {
  const order = ids(CONFIG, {
    tier: "smart",
    blockedModel: { providerID: "anthropic", modelID: "claude-opus-5-5" },
    excludeTargetIDs: ["claude-opus-5", "gpt-6-1-sol", "gpt-flagship"],
  });
  assert.equal(order[0], "claude-opus-4-8");
  assert.ok(!order.includes("claude-opus-5"));
  assert.ok(!order.includes("gpt-6-1-sol"));
});

test("a worker-tier block only cascades across the worker tier plus the floor", () => {
  const order = ids(CONFIG, {
    tier: "worker",
    blockedModel: { providerID: "openai", modelID: "gpt-6-luna" },
  });
  assert.deepEqual(order, ["haiku", "local-coder", "uncensored-qwen"]);
});

test("a RESPONSES turn reaches every provider including the uncensored floor", () => {
  const order = ids(CONFIG, {
    tier: "smart",
    blockedModel: { providerID: "anthropic", modelID: "claude-opus-5-5" },
    apiEligibleProviders: ["anthropic", "openai", "llamacpp"],
  });
  assert.equal(order.at(-1), "uncensored-qwen");
  assert.ok(order.includes("gpt-6-1-sol") && order.includes("local-27b"));
});

test("a tier outside the descent ladder (e.g. classifier) does not cascade down", () => {
  const cfg = { ...CONFIG, tiers: { ...CONFIG.tiers, classifier: ["local-coder"] } };
  const order = ids(cfg, { tier: "classifier", blockedModel: { providerID: "llamacpp", modelID: "x" } });
  assert.deepEqual(order, ["local-coder", "uncensored-qwen"]);
});

test("disabled or absent config yields no cascade", () => {
  assert.deepEqual(contentFilterCascadeOrder({ config: { ...CONFIG, contentFilterCascade: { enabled: false } }, tier: "smart" }), []);
  assert.deepEqual(contentFilterCascadeOrder({ config: { ...CONFIG, contentFilterCascade: undefined }, tier: "smart" }), []);
  assert.equal(isCascadeEnabled({ contentFilterCascade: { enabled: true } }), true);
  assert.equal(isCascadeEnabled({}), false);
});

test("normalize is defensive: a malformed block never throws and collapses to disabled/defaults", () => {
  assert.equal(normalizeContentFilterCascade(null).enabled, false);
  assert.equal(normalizeContentFilterCascade({ enabled: true, tierDescent: "nope" }).tierDescent, DEFAULT_TIER_DESCENT);
  assert.equal(normalizeContentFilterCascade({ enabled: true, maxAttempts: -3 }).maxAttempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(normalizeContentFilterCascade({ enabled: true, uncensoredFloorTargetID: 7 }).uncensoredFloorTargetID, null);
});
