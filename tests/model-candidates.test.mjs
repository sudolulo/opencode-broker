import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MODEL_ROLES, normalizeModelRoles } from "../lib/model-roles.js";
import {
  catalogModelForID,
  isSpeedVariant,
  normalizeCatalogCandidates,
  normalizeCatalogModel,
  reasoningVariants,
} from "../lib/model-candidates.js";

// The registry a conflict needs: two roles under the same provider whose family list and id
// matchers disagree about the same model id.
const CONFLICTING_ROLES = normalizeModelRoles({
  "example:alpha": {
    families: ["example-alpha"], idPatterns: [{ prefix: "example-", suffix: "-alpha" }],
    tiers: ["smart"], rank: 2, effortCeiling: "high", requiredCapabilities: { toolCall: true },
    evidenceDomains: ["example.com"],
  },
  "example:beta": {
    families: ["example-beta"], idPatterns: [{ prefix: "example-", suffix: "-beta" }],
    tiers: ["worker"], rank: 1, effortCeiling: "medium", requiredCapabilities: { toolCall: true },
    evidenceDomains: ["example.com"],
  },
}, { warn: () => {} });

test("reasoningVariants reads effort, budget and null-as-none", () => {
  assert.deepEqual(reasoningVariants({
    reasoning_options: [{ type: "effort", values: [null, "low", "high"] }],
  }), ["none", "low", "high"]);
  assert.deepEqual(reasoningVariants({
    reasoning_options: [{ type: "budget_tokens", min: 1024 }],
  }), ["high", "max"]);
  assert.deepEqual(reasoningVariants({ reasoning: false }), []);
});

test("synthesized fast and standard IDs inherit base capability", () => {
  const models = {
    "claude-opus-5-5": {
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    },
  };
  assert.equal(catalogModelForID(models, "claude-opus-5-5-fast"), models["claude-opus-5-5"]);
  assert.equal(catalogModelForID(models, "claude-opus-5-5-standard"), models["claude-opus-5-5"]);
});

test("normalizes provider metadata without making a quality decision", () => {
  const candidate = normalizeCatalogModel("openai", {
    id: "gpt-6-sol",
    family: "gpt-sol",
    release_date: "2026-09-22",
    status: "active",
    tool_call: true,
    limit: { context: 1_050_000, output: 128_000 },
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
  }, {
    roles: DEFAULT_MODEL_ROLES,
    resolvableModels: new Set(["openai/gpt-6-sol"]),
  });
  assert.deepEqual(candidate, {
    providerID: "openai",
    modelID: "gpt-6-sol",
    family: "gpt-sol",
    roleKey: "openai:gpt-sol",
    roleID: "gpt-sol",
    roleStatus: "known",
    roleMatches: ["openai:gpt-sol"],
    version: "6",
    releaseDate: "2026-09-22",
    capabilities: { toolCall: true },
    context: 1_050_000,
    output: 128_000,
    variants: ["low", "medium", "high"],
    resolverKey: "openai/gpt-6-sol",
    resolvable: true,
    active: true,
    validModelID: true,
    speedVariant: false,
  });
});

// CRITICAL: A SIBLING THAT IS NOT IN THE CATALOG DOES NOT EXIST. The registry knows an
// `openai:gpt-terra` role, so the tempting inference from "gpt-6-astra, gpt-6-sol and
// gpt-6-luna shipped" is that a gpt-6-terra shipped too. Inventing it would mint a build-tier
// candidate for a model id the provider never published, and every lease on it would die with
// ProviderModelNotFoundError -- the exact failure the resolver view exists to prevent.
test("a missing family sibling is never synthesized from the roles that did ship", () => {
  const catalog = {
    openai: {
      id: "openai",
      models: {
        "gpt-6-astra": { id: "gpt-6-astra", family: "gpt-astra", release_date: "2026-09-22",
          status: "active", tool_call: true },
        "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22",
          status: "active", tool_call: true },
        "gpt-6-luna": { id: "gpt-6-luna", family: "gpt-luna", release_date: "2026-09-20",
          status: "active", tool_call: true },
      },
    },
  };
  const candidates = normalizeCatalogCandidates(catalog, {
    providerIDs: ["openai"],
    roles: DEFAULT_MODEL_ROLES,
    resolvableModels: new Set(["openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna"]),
  });
  assert.deepEqual(candidates.map((candidate) => candidate.modelID),
    ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"]);
  assert.deepEqual(candidates.filter((candidate) => candidate.family === "gpt-terra"), []);
  assert.deepEqual(candidates.filter((candidate) => candidate.roleID === "gpt-terra"), []);
});

test("an unmapped family reports unknown with no role, version or match", () => {
  const candidate = normalizeCatalogModel("example-oauth", {
    id: "flagship", family: "example-max", status: "active", tool_call: true,
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["example-oauth/flagship"]) });
  assert.equal(candidate.roleStatus, "unknown");
  assert.equal(candidate.roleKey, null);
  assert.equal(candidate.roleID, null);
  assert.deepEqual(candidate.roleMatches, []);
  assert.equal(candidate.version, null);
  // Unknown is not dropped: the reconciler has to be able to report what it saw and could
  // not place, which is how a renamed family becomes visible instead of vanishing.
  assert.equal(candidate.modelID, "flagship");
  assert.equal(candidate.resolvable, true);
});

// CRITICAL: the family and the id shape pointing at DIFFERENT roles is the one case where
// picking a winner puts a model in the wrong lane. Both keys are reported, sorted, and no
// version is claimed -- Task 5 turns this into blocked-conflict.
test("a family and id-pattern disagreement reports both roles instead of picking one", () => {
  const candidate = normalizeCatalogModel("example", {
    id: "example-2-beta", family: "example-alpha", status: "active", tool_call: true,
  }, { roles: CONFLICTING_ROLES, resolvableModels: new Set(["example/example-2-beta"]) });
  assert.equal(candidate.roleStatus, "conflict");
  assert.equal(candidate.roleKey, null);
  assert.equal(candidate.roleID, null);
  assert.deepEqual(candidate.roleMatches, ["example:alpha", "example:beta"]);
  assert.equal(candidate.version, null);
});

test("an inactive model is reported as inactive rather than filtered out", () => {
  const retired = normalizeCatalogModel("anthropic", {
    id: "claude-opus-4", family: "claude-opus", release_date: "2025-05-22",
    status: "deprecated", tool_call: true,
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["anthropic/claude-opus-4"]) });
  assert.equal(retired.active, false);
  assert.equal(retired.roleStatus, "known");
  // Absent status means active, matching what discovery already does with the same catalogs.
  const unstated = normalizeCatalogModel("anthropic", {
    id: "claude-opus-5", family: "claude-opus", release_date: "2026-08-20", tool_call: true,
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["anthropic/claude-opus-5"]) });
  assert.equal(unstated.active, true);
});

// A release date is the reconciler's ordering key, so a malformed one must read as absent
// rather than as a date that sorts wrong. Same predicate discovery already applies.
test("a malformed release date becomes null instead of an unsortable value", () => {
  for (const release of ["2026-9-22", "2026-13-01", "22 September 2026", 20260922, null, ""]) {
    const candidate = normalizeCatalogModel("openai", {
      id: "gpt-6-sol", family: "gpt-sol", release_date: release, status: "active", tool_call: true,
    }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["openai/gpt-6-sol"]) });
    assert.equal(candidate.releaseDate, null, `release_date ${JSON.stringify(release)}`);
  }
});

test("absent capability, limit and variant metadata is absent, never defaulted", () => {
  const candidate = normalizeCatalogModel("openai", {
    id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", status: "active",
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["openai/gpt-6-sol"]) });
  assert.deepEqual(candidate.capabilities, {});
  assert.equal(candidate.context, null);
  assert.equal(candidate.output, null);
  assert.deepEqual(candidate.variants, []);
  // A declared false stays false: it is the difference between "cannot call tools" and
  // "did not say", and the role's requiredCapabilities check in Task 5 needs both.
  const noTools = normalizeCatalogModel("openai", {
    id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", tool_call: false,
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["openai/gpt-6-sol"]) });
  assert.deepEqual(noTools.capabilities, { toolCall: false });
});

test("a non-positive or non-numeric window is dropped and a fractional one is floored", () => {
  const read = (limit) => normalizeCatalogModel("openai", {
    id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", limit,
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["openai/gpt-6-sol"]) });
  assert.equal(read({ context: 0, output: 0 }).context, null);
  assert.equal(read({ context: -1, output: -1 }).output, null);
  assert.equal(read({ context: "huge", output: "huge" }).context, null);
  assert.equal(read({ context: 200_000.7, output: 64_000.9 }).context, 200_000);
  assert.equal(read({ context: 200_000.7, output: 64_000.9 }).output, 64_000);
});

test("catalog candidates use reasoning_options for variants", () => {
  const candidate = normalizeCatalogModel("openai", {
    id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22",
    reasoning_options: [{ type: "effort", values: ["medium", null, "high", "medium"] }],
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["openai/gpt-6-sol"]) });
  assert.deepEqual(candidate.variants, ["medium", "none", "high"]);
});

// The shape guard routing already applies at admission, reported rather than enforced here:
// a candidate the host can never address still has to be visible to the reconciler.
test("a malformed model id is reported invalid without dropping the candidate", () => {
  const candidate = normalizeCatalogModel("openai", {
    id: "gpt luna/6", family: "gpt-luna", release_date: "2026-09-22", tool_call: true,
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set() });
  assert.equal(candidate.validModelID, false);
  assert.equal(candidate.modelID, "gpt luna/6");
  assert.equal(candidate.roleStatus, "known");
  const usable = normalizeCatalogModel("openai", {
    id: "gpt-6-luna", family: "gpt-luna", release_date: "2026-09-22", tool_call: true,
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set() });
  assert.equal(usable.validModelID, true);
});

test("an absent provider or model id yields no candidate at all", () => {
  const options = { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set() };
  assert.equal(normalizeCatalogModel("", { id: "gpt-6-sol", family: "gpt-sol" }, options), null);
  assert.equal(normalizeCatalogModel(null, { id: "gpt-6-sol" }, options), null);
  assert.equal(normalizeCatalogModel("openai", { family: "gpt-sol" }, options), null);
  assert.equal(normalizeCatalogModel("openai", { id: 6, family: "gpt-sol" }, options), null);
  assert.equal(normalizeCatalogModel("openai", null, options), null);
});

// A speed variant is a lane of its own. Mislabelling one is how a fast model joins a standard
// tier or suppresses the standard model it is a variant of, so the flag is pinned directly.
test("speed variants are flagged from the id and never inferred from anything else", () => {
  assert.equal(isSpeedVariant("claude-opus-5-fast"), true);
  assert.equal(isSpeedVariant("gpt-9-sol-fast"), true);
  assert.equal(isSpeedVariant("claude-opus-fast-2026"), true);
  assert.equal(isSpeedVariant("CLAUDE-OPUS-5-FAST"), true);
  // "fast" has to be its own hyphen-delimited segment: these are standard models.
  assert.equal(isSpeedVariant("gpt-6-fastball"), false);
  assert.equal(isSpeedVariant("fast-gpt"), false);
  assert.equal(isSpeedVariant("claude-opus-5"), false);
  assert.equal(isSpeedVariant(undefined), false);
  const candidate = normalizeCatalogModel("anthropic", {
    id: "claude-opus-5-fast", family: "claude-opus", release_date: "2026-08-21", tool_call: true,
  }, { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["anthropic/claude-opus-5-fast"]) });
  assert.equal(candidate.speedVariant, true);
  // Flagged, not filtered, and not re-tiered: the role match is untouched by the flag.
  assert.equal(candidate.roleKey, "anthropic:claude-opus");
});

test("resolver membership is reported, and an absent resolver view is unknown rather than true", () => {
  const model = { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", tool_call: true };
  assert.equal(normalizeCatalogModel("openai", model,
    { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set(["openai/gpt-5.7-sol"]) }).resolvable, false);
  assert.equal(normalizeCatalogModel("openai", model,
    { roles: DEFAULT_MODEL_ROLES, resolvableModels: ["openai/gpt-6-sol"] }).resolvable, true);
  assert.equal(normalizeCatalogModel("openai", model,
    { roles: DEFAULT_MODEL_ROLES }).resolvable, null);
  // Unresolvable is reported, never filtered: Task 5 needs to say why it blocked.
  assert.equal(normalizeCatalogModel("openai", model,
    { roles: DEFAULT_MODEL_ROLES, resolvableModels: new Set() }).modelID, "gpt-6-sol");
});

test("only the exact provider IDs asked for are normalized", () => {
  const catalog = {
    all: [
      { id: "openai", models: { "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22" } } },
      { id: "anthropic", models: { "claude-opus-5": { id: "claude-opus-5", family: "claude-opus", release_date: "2026-08-20" } } },
      { id: "openai-compatible", models: { mystery: { id: "mystery", family: "gpt-sol", release_date: "2026-09-22" } } },
    ],
  };
  const options = { roles: DEFAULT_MODEL_ROLES, resolvableModels: null };
  assert.deepEqual(normalizeCatalogCandidates(catalog, { ...options, providerIDs: ["openai"] })
    .map((candidate) => candidate.resolverKey), ["openai/gpt-6-sol"]);
  // Fail closed: no provider list means no candidates, never the whole catalog.
  assert.deepEqual(normalizeCatalogCandidates(catalog, options), []);
  assert.deepEqual(normalizeCatalogCandidates(catalog, { ...options, providerIDs: [] }), []);
  assert.deepEqual(normalizeCatalogCandidates(catalog, { ...options, providerIDs: "openai" }), []);
});

test("candidates sort by provider, family, release date then model id", () => {
  const catalog = {
    openai: {
      id: "openai",
      models: {
        "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22" },
        "gpt-5.7-sol": { id: "gpt-5.7-sol", family: "gpt-sol", release_date: "2026-08-01" },
        "gpt-6-luna": { id: "gpt-6-luna", family: "gpt-luna", release_date: "2026-09-22" },
        // Same family AND same release date: the model id breaks the tie.
        "gpt-6-sol-20260922": { id: "gpt-6-sol-20260922", family: "gpt-sol", release_date: "2026-09-22" },
        // No parseable date and no family: both sort last, deterministically.
        stray: { id: "stray" },
      },
    },
    anthropic: {
      id: "anthropic",
      models: { "claude-opus-5": { id: "claude-opus-5", family: "claude-opus", release_date: "2026-08-20" } },
    },
  };
  const candidates = normalizeCatalogCandidates(catalog, {
    providerIDs: new Set(["anthropic", "openai"]),
    roles: DEFAULT_MODEL_ROLES,
    resolvableModels: null,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.resolverKey), [
    "anthropic/claude-opus-5",
    "openai/gpt-6-luna",
    "openai/gpt-5.7-sol",
    "openai/gpt-6-sol",
    "openai/gpt-6-sol-20260922",
    "openai/stray",
  ]);
});

test("the candidate list and every candidate in it are frozen", () => {
  const candidates = normalizeCatalogCandidates({
    openai: { id: "openai", models: { "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", reasoning_options: [{ type: "effort", values: ["high"] }] } } },
  }, { providerIDs: ["openai"], roles: DEFAULT_MODEL_ROLES, resolvableModels: null });
  assert.equal(Object.isFrozen(candidates), true);
  assert.equal(Object.isFrozen(candidates[0]), true);
  assert.equal(Object.isFrozen(candidates[0].capabilities), true);
  assert.equal(Object.isFrozen(candidates[0].variants), true);
  assert.equal(Object.isFrozen(candidates[0].roleMatches), true);
});

// Nothing a provider catalog contains may throw: the reconciler reads a file it did not write.
test("normalization never throws on a hostile catalog", () => {
  for (const catalog of [null, undefined, [], "catalog", 7, { openai: null }, { openai: { id: "openai", models: [] } },
    { all: "openai" }, { all: [null, { id: "openai", models: { bad: 7 } }] }]) {
    assert.doesNotThrow(() => normalizeCatalogCandidates(catalog, {
      providerIDs: ["openai"], roles: DEFAULT_MODEL_ROLES, resolvableModels: null,
    }));
  }
  assert.doesNotThrow(() => normalizeCatalogModel("openai", { id: "gpt-6-sol" }, {}));
});
