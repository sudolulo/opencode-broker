import assert from "node:assert/strict";
import test from "node:test";

import { createResolverProcessRegistry } from "../lib/resolver-processes.js";

const NOW = 1_800_000_000_000;
const BASE_KEYS = ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol"];
const GEN1 = {
  manifestHash: "1".repeat(64),
  modelKeys: [...BASE_KEYS, "openai/gpt-6-luna"],
};
const GEN2 = {
  manifestHash: "2".repeat(64),
  modelKeys: [...GEN1.modelKeys, "openai/gpt-6-sol"],
};

const generations = (entries = { 0: { manifestHash: "0".repeat(64), modelKeys: BASE_KEYS }, 1: GEN1, 2: GEN2 }, highWater = 2) => ({
  version: 1,
  highWater,
  generations: entries,
});

const makeRegistry = (overrides = {}) => createResolverProcessRegistry({
  loadRegistry: () => generations(),
  loadBaseModelKeys: () => BASE_KEYS,
  mintToken: () => "token-1",
  now: () => NOW,
  activeMs: 600_000,
  ...overrides,
});

test("valid current and old registrations authorize only exact manifest membership", () => {
  const registry = makeRegistry();
  const old = registry.register({ generation: 1, manifestHash: GEN1.manifestHash, modelKeys: GEN1.modelKeys });

  assert.deepEqual(old, {
    resolverToken: "token-1",
    scope: "ordinary",
    generation: 1,
    manifestHash: GEN1.manifestHash,
    modelKeys: GEN1.modelKeys,
    expiresAt: NOW + 600_000,
  });
  assert.equal(registry.authorize({
    resolverToken: old.resolverToken,
    modelKey: "openai/gpt-5.6-sol",
  }).compatible, true);
  assert.equal(registry.authorize({
    resolverToken: old.resolverToken,
    modelKey: "openai/gpt-6-sol",
  }).compatible, false);

  const forgedMembership = registry.register({
    generation: 1,
    manifestHash: GEN1.manifestHash,
    modelKeys: [...GEN1.modelKeys, "openai/gpt-6-sol"],
  });
  assert.equal(forgedMembership.scope, "base-only");
  assert.equal(forgedMembership.reason, "manifest-membership-mismatch");
  assert.deepEqual(forgedMembership.modelKeys, BASE_KEYS);
});

test("unsafe registrations fall back to generation zero and restart invalidates tokens", () => {
  const registry = makeRegistry();
  const unsafe = [
    [{}, "invalid-registration"],
    [{ generation: 99, manifestHash: "f".repeat(64), modelKeys: [] }, "future-generation"],
    [{ generation: 1, manifestHash: "f".repeat(64), modelKeys: GEN1.modelKeys }, "manifest-mismatch"],
    [{ rawBase: true }, "raw-base"],
  ];
  for (const [input, reason] of unsafe) {
    assert.deepEqual(registry.register(input), {
      resolverToken: null,
      scope: "base-only",
      generation: 0,
      manifestHash: null,
      modelKeys: BASE_KEYS,
      reason,
    });
  }

  const issued = registry.register({ generation: 2, manifestHash: GEN2.manifestHash, modelKeys: GEN2.modelKeys });
  const restarted = makeRegistry();
  assert.deepEqual(restarted.authorize({ resolverToken: issued.resolverToken, modelKey: "openai/gpt-6-sol" }), {
    generation: 0,
    manifestHash: null,
    modelKeys: BASE_KEYS,
    compatible: false,
    reason: "invalid-token",
  });
});

test("missing expired future unknown and cleaned clients authorize logical generation zero", () => {
  let clock = NOW;
  let diskRegistry = generations();
  let token = 0;
  const registry = makeRegistry({
    loadRegistry: () => diskRegistry,
    now: () => clock,
    mintToken: () => `token-${++token}`,
  });

  assert.deepEqual(registry.authorize({ resolverToken: undefined, modelKey: "openai/gpt-5.6-sol" }), {
    generation: 0,
    manifestHash: null,
    modelKeys: BASE_KEYS,
    compatible: true,
    reason: "missing-token",
  });

  const cleanedToken = registry.register({ generation: 2, manifestHash: GEN2.manifestHash, modelKeys: GEN2.modelKeys });
  diskRegistry = generations({
    0: { manifestHash: "0".repeat(64), modelKeys: BASE_KEYS },
    1: GEN1,
  });
  assert.deepEqual(registry.authorize({ resolverToken: cleanedToken.resolverToken, modelKey: "openai/gpt-6-sol" }), {
    generation: 0,
    manifestHash: null,
    modelKeys: BASE_KEYS,
    compatible: false,
    reason: "cleaned-generation",
  });

  diskRegistry = generations();
  const expiring = registry.register({ generation: 1, manifestHash: GEN1.manifestHash, modelKeys: GEN1.modelKeys });
  clock = NOW + 600_000;
  assert.equal(registry.authorize({ resolverToken: expiring.resolverToken }).reason, "expired-token");

  const future = registry.register({ generation: 2, manifestHash: GEN2.manifestHash, modelKeys: GEN2.modelKeys });
  diskRegistry = generations({ 0: { manifestHash: "0".repeat(64), modelKeys: BASE_KEYS } }, 0);
  assert.equal(registry.authorize({ resolverToken: future.resolverToken }).reason, "future-generation");

  diskRegistry = generations({
    0: { manifestHash: "0".repeat(64), modelKeys: BASE_KEYS },
    2: GEN2,
  });
  const unknown = registry.register({ generation: 1, manifestHash: GEN1.manifestHash, modelKeys: GEN1.modelKeys });
  assert.equal(unknown.reason, "unknown-generation");
});

test("valid use extends the ten-minute active window and status never exposes token material", () => {
  let clock = NOW;
  const registry = makeRegistry({ now: () => clock });
  const issued = registry.register({ generation: 2, manifestHash: GEN2.manifestHash, modelKeys: GEN2.modelKeys });

  clock += 599_999;
  assert.equal(registry.authorize({ resolverToken: issued.resolverToken }).generation, 2);
  clock += 599_999;
  assert.equal(registry.authorize({ resolverToken: issued.resolverToken }).generation, 2);

  const status = registry.status();
  assert.deepEqual(status, {
    active: 1,
    generations: { 2: 1 },
    registrations: [{
      generation: 2,
      manifestHash: GEN2.manifestHash,
      modelKeys: GEN2.modelKeys,
      registeredAt: NOW,
      touchedAt: clock,
      expiresAt: clock + 600_000,
    }],
  });
  assert.equal(JSON.stringify(status).includes("token-1"), false);
  registry.clear();
  assert.equal(registry.status().active, 0);
});
