import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL_ROLES,
  REASONING_MODES,
  familyTiersFromRoles,
  matchModelRole,
  normalizeModelRoles,
} from "../lib/model-roles.js";

const EXPECTED_FAMILIES = {
  "anthropic:claude-opus": { tiers: ["build", "smart"], fit: { build: 1.5 } },
  "anthropic:claude-sonnet": { tiers: ["build", "review"], fit: { review: 1.4 } },
  "anthropic:claude-fable": { tiers: ["deep"], fit: { deep: 1.5 } },
  "anthropic:claude-haiku": { tiers: ["worker", "classifier"], fit: {} },
  "openai:gpt-astra": { tiers: ["deep"], fit: {} },
  "openai:gpt-sol": { tiers: ["smart"], fit: {} },
  "openai:gpt-terra": { tiers: ["build"], fit: {} },
  "openai:gpt-luna": { tiers: ["worker"], fit: {} },
};

test("roles carry an effort ceiling and an optional required reasoning mode", () => {
  assert.deepEqual(REASONING_MODES, ["none", "low", "medium", "high", "xhigh"]);
  const roles = normalizeModelRoles({
    "openai:gpt-sol": { effortCeiling: "medium", requiredReasoningMode: "low" },
  });
  assert.equal(roles["openai:gpt-sol"].effortCeiling, "medium");
  assert.equal(roles["openai:gpt-sol"].requiredReasoningMode, "low");
  assert.equal(Object.isFrozen(roles["openai:gpt-sol"]), true);

  assert.deepEqual(Object.fromEntries(Object.entries(DEFAULT_MODEL_ROLES)
    .map(([key, role]) => [key, role.effortCeiling])), {
    "anthropic:claude-opus": "high",
    "anthropic:claude-sonnet": "high",
    "anthropic:claude-fable": "xhigh",
    "anthropic:claude-haiku": "medium",
    "openai:gpt-astra": "xhigh",
    "openai:gpt-sol": "high",
    "openai:gpt-terra": "high",
    "openai:gpt-luna": "medium",
  });
  assert.equal(Object.values(DEFAULT_MODEL_ROLES)
    .every((role) => role.requiredReasoningMode === null), true);
});

test("invalid effort ceiling policy is rejected without deleting the product role", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "openai:gpt-sol": { effortCeiling: "turbo", requiredReasoningMode: "magic" },
  }, { warn: (message) => warnings.push(message) });
  assert.equal(roles["openai:gpt-sol"].effortCeiling, "high");
  assert.equal(warnings.length, 1);
});

test("default roles derive the existing family-tier policy exactly", () => {
  assert.deepEqual(familyTiersFromRoles(DEFAULT_MODEL_ROLES), EXPECTED_FAMILIES);
});

test("deletion-shaped and invalid overrides cannot remove safe defaults", () => {
  const warnings = [];
  for (const value of [null, false, {}, { tiers: [] }, { families: [] }]) {
    const roles = normalizeModelRoles({ "anthropic:claude-opus": value }, {
      warn: (line) => warnings.push(line),
    });
    assert.deepEqual(roles["anthropic:claude-opus"].tiers, ["build", "smart"]);
    assert.deepEqual(roles["anthropic:claude-opus"].families, ["claude-opus"]);
  }
  assert.ok(warnings.length >= 4);
});

test("a valid subscription-provider role can be added without replacing defaults", () => {
  const roles = normalizeModelRoles({
    "example:prime": {
      families: ["example-prime"],
      idPatterns: [{ prefix: "example-", suffix: "-prime" }],
      tiers: ["smart"],
      fit: { smart: 1.2 },
      rank: 3,
      effortCeiling: "high",
      requiredCapabilities: { toolCall: true },
      evidenceDomains: ["models.example.com"],
    },
  });
  assert.ok(roles["anthropic:claude-opus"]);
  assert.equal(roles["example:prime"].providerID, "example");
  assert.equal(roles["example:prime"].roleID, "prime");
  assert.deepEqual(familyTiersFromRoles(roles)["example:example-prime"], {
    tiers: ["smart"], fit: { smart: 1.2 },
  });
});

test("a colliding override is ignored and the default family owner wins", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "anthropic:premium": {
      families: ["claude-opus"], idPatterns: [{ prefix: "premium-", suffix: "" }],
      tiers: ["deep"], rank: 9, effortCeiling: "xhigh", requiredCapabilities: { toolCall: true },
      evidenceDomains: ["anthropic.com"],
    },
  }, { warn: (line) => warnings.push(line) });
  assert.equal(roles["anthropic:premium"], undefined);
  assert.ok(roles["anthropic:claude-opus"]);
  assert.match(warnings.join("\n"), /claude-opus.*already belongs to anthropic:claude-opus/);
});

test("a same-key override changes policy without removing safe matchers", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "anthropic:claude-opus": { tiers: ["smart"], fit: { smart: 1.25 } },
  }, { warn: (line) => warnings.push(line) });
  assert.deepEqual(roles["anthropic:claude-opus"].tiers, ["smart"]);
  assert.deepEqual(roles["anthropic:claude-opus"].fit, { smart: 1.25 });
  assert.deepEqual(roles["anthropic:claude-opus"].families, ["claude-opus"]);
  assert.deepEqual(roles["anthropic:claude-opus"].idPatterns,
    [{ prefix: "claude-opus-", suffix: "" }]);
  assert.deepEqual(warnings, []);
});

test("family and id-pattern disagreement is an explicit conflict", () => {
  const roles = normalizeModelRoles({
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
  });
  const match = matchModelRole("example", { id: "example-2-beta", family: "example-alpha" }, roles);
  assert.equal(match.status, "conflict");
  assert.deepEqual(match.roleKeys, ["example:alpha", "example:beta"]);
});

// The other two match outcomes the reconciler in Tasks 2, 4 and 5 branches on. `version` is
// parsed from the id matcher, not from the family, because a family name carries no release.
test("a single agreeing matcher reports the role and its parsed version", () => {
  const opus = matchModelRole("anthropic", { id: "claude-opus-5", family: "claude-opus" },
    DEFAULT_MODEL_ROLES);
  assert.equal(opus.status, "known");
  assert.equal(opus.roleKey, "anthropic:claude-opus");
  assert.equal(opus.role.tiers[0], "build");
  assert.equal(opus.version, "5");
  // An internal `-` between version digits is a separator, not part of the number.
  assert.equal(matchModelRole("anthropic", { id: "claude-haiku-4-5", family: "claude-haiku" },
    DEFAULT_MODEL_ROLES).version, "4.5");
  // Matched on family alone: no id matcher agreed, so there is no version to report.
  assert.equal(matchModelRole("anthropic", { id: "claude-opus-latest", family: "claude-opus" },
    DEFAULT_MODEL_ROLES).version, null);
});

test("an unmapped family and provider is unknown, never guessed into a role", () => {
  assert.deepEqual(matchModelRole("example-oauth", { id: "flagship", family: "example-max" },
    DEFAULT_MODEL_ROLES), { status: "unknown", roleKeys: [] });
  // A matching id shape under the WRONG provider stays unknown: family names are not global.
  assert.deepEqual(matchModelRole("example-oauth", { id: "claude-opus-9", family: "claude-opus" },
    DEFAULT_MODEL_ROLES), { status: "unknown", roleKeys: [] });
});

// CRITICAL: Package 3 adds reasoning-mode and compatibility-probe fields. Until its validation
// exists, an unknown key must reject the whole override rather than ride through unchecked
// and look like it took effect.
test("an unknown role field is rejected instead of silently passed through", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "anthropic:claude-opus": { tiers: ["deep"], reasoningMode: "high" },
  }, { warn: (line) => warnings.push(line) });
  assert.deepEqual(roles["anthropic:claude-opus"].tiers, ["build", "smart"]);
  assert.match(warnings.join("\n"), /reasoningMode/);
});

test("a malformed role key is ignored and leaves every default standing", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "anthropic": {
      families: ["claude-nimbus"], idPatterns: [{ prefix: "claude-nimbus-", suffix: "" }],
      tiers: ["smart"], rank: 1, effortCeiling: "high", requiredCapabilities: { toolCall: true },
      evidenceDomains: ["anthropic.com"],
    },
    "Anthropic:Claude-Opus": { tiers: ["worker"] },
  }, { warn: (line) => warnings.push(line) });
  assert.deepEqual(Object.keys(roles), Object.keys(DEFAULT_MODEL_ROLES));
  assert.deepEqual(familyTiersFromRoles(roles), EXPECTED_FAMILIES);
  assert.equal(warnings.length, 2);
});

// A new role key is policy from scratch, so every field that decides where it routes and
// what may justify it has to be present -- an incomplete new role is not a safe partial.
test("a new role key missing required fields is rejected whole", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "example:partial": { tiers: ["smart"], families: ["example-partial"] },
  }, { warn: (line) => warnings.push(line) });
  assert.equal(roles["example:partial"], undefined);
  assert.match(warnings.join("\n"), /example:partial/);
});

// Additive union, not replacement: a host may teach a role a new catalog family or a new
// evidence domain, but cannot erase the matcher or allowlist that keeps the default safe.
test("families, id patterns and evidence domains merge additively on an existing role", () => {
  const roles = normalizeModelRoles({
    "anthropic:claude-opus": {
      families: ["claude-opus-preview"],
      idPatterns: [{ prefix: "opus-", suffix: "" }],
      evidenceDomains: ["anthropic.com", "docs.anthropic.com"],
    },
  });
  const role = roles["anthropic:claude-opus"];
  assert.deepEqual(role.families, ["claude-opus", "claude-opus-preview"]);
  assert.deepEqual(role.idPatterns, [
    { prefix: "claude-opus-", suffix: "" },
    { prefix: "opus-", suffix: "" },
  ]);
  assert.deepEqual(role.evidenceDomains,
    ["anthropic.com", "platform.claude.com", "docs.anthropic.com"]);
  // The added family becomes a second key of the SAME role, with that role's policy.
  assert.deepEqual(familyTiersFromRoles(roles)["anthropic:claude-opus-preview"], {
    tiers: ["build", "smart"], fit: { build: 1.5 },
  });
});

test("the returned registry and its nested policy are frozen", () => {
  const roles = normalizeModelRoles({});
  assert.equal(Object.isFrozen(roles), true);
  assert.equal(Object.isFrozen(roles["anthropic:claude-opus"]), true);
  assert.equal(Object.isFrozen(roles["anthropic:claude-opus"].tiers), true);
  assert.equal(Object.isFrozen(roles["anthropic:claude-opus"].fit), true);
  assert.equal(Object.isFrozen(DEFAULT_MODEL_ROLES), true);
});

// Nothing a host writes in a config file may throw at import: lib/config.js is imported by
// the TUI plugin, where an exception takes the editor's session down with it.
test("normalization never throws on hostile input", () => {
  for (const overrides of [null, undefined, [], "roles", 7, { "a:b": [] }, { "a:b": "smart" }]) {
    assert.doesNotThrow(() => normalizeModelRoles(overrides, { warn: () => {} }));
  }
  assert.deepEqual(familyTiersFromRoles(normalizeModelRoles([], { warn: () => {} })),
    EXPECTED_FAMILIES);
});
