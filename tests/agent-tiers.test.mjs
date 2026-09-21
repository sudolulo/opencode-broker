import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/config.js reads the config once at import, so each deployment shape is
// evaluated in its own node process.
const routingModule = new URL("../lib/routing.js", import.meta.url).href;
const evaluate = (config, probes) => {
  const dir = mkdtempSync(join(tmpdir(), "broker-agent-tiers-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const R = await import(${JSON.stringify(routingModule)});
      const probes = ${JSON.stringify(probes)};
      process.stdout.write(JSON.stringify(probes.map(([agent, parentTier]) => ({
        agent, parentTier,
        tier: R.tierForAgent(agent, { parentTier }),
        classifier: R.isClassifierAgent(agent),
        inherits: R.inheritsParentTier(agent),
      }))));
    `], { env: { ...process.env, HOME: dir, OPENCODE_BROKER_CONFIG: path }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return { results: JSON.parse(result.stdout), stderr: result.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const tiersOf = (results) => Object.fromEntries(results.map((r) => [`${r.agent}${r.parentTier ? `<${r.parentTier}` : ""}`, r.tier]));

test("with no agentTiers, opencode's built-in agents get sensible tiers", () => {
  const { results } = evaluate({}, [
    ["build"], ["plan"], ["explore"], ["general"], ["general", "smart"], ["general", "deep"],
    ["deep"], ["smart"], ["fast-build"], ["some-custom-agent"], ["compaction"],
  ]);
  assert.deepEqual(tiersOf(results), {
    build: "build",
    plan: "smart",
    explore: "worker",
    general: "worker",
    "general<smart": "smart",
    "general<deep": "deep",
    deep: "deep",
    smart: "smart",
    "fast-build": "fast-build",
    "some-custom-agent": "worker",
    compaction: "worker",
  });
  assert.deepEqual(results.filter((r) => r.inherits).map((r) => r.agent), ["general", "general", "general"]);
});

test("opencode-guard's classifier agents are classifier lanes by default, and are never leased on that lane", () => {
  const { results } = evaluate({}, [["fleet-classifier"], ["fleet-classifier-local"], ["classifier-ish"]]);
  assert.deepEqual(results.map((r) => [r.agent, r.classifier, r.tier]), [
    ["fleet-classifier", true, "worker"],
    ["fleet-classifier-local", true, "worker"],
    ["classifier-ish", false, "worker"],
  ]);
});

test("an exact entry beats a prefix, and the longest prefix wins", () => {
  const { results } = evaluate({
    agentTiers: { "review-*": "review", "review-deep-*": "smart", "review-verifier": "deep" },
  }, [["review-panelist"], ["review-deep-dive"], ["review-verifier"], ["review"]]);
  assert.deepEqual(tiersOf(results), {
    "review-panelist": "review",
    "review-deep-dive": "smart",
    "review-verifier": "deep",
    review: "worker",
  });
});

test("entries merge over the defaults, and any default can be overridden", () => {
  const { results } = evaluate({ agentTiers: { plan: "deep", general: "build", explore: "review" } },
    [["plan"], ["general", "smart"], ["explore"], ["build"]]);
  assert.deepEqual(tiersOf(results), { plan: "deep", "general<smart": "build", explore: "review", build: "build" });
});

test("defaultAgentTier catches unmapped agents and an inherit with no parent", () => {
  const { results } = evaluate({ defaultAgentTier: "review" }, [["unmapped"], ["general"], ["general", "deep"]]);
  assert.deepEqual(tiersOf(results), { unmapped: "review", general: "review", "general<deep": "deep" });
});

test("a deployment can name its own classifier lanes", () => {
  const { results } = evaluate({ agentTiers: { "gate-*": "classifier" } }, [["gate-local"], ["fleet-classifier"]]);
  assert.deepEqual(results.map((r) => [r.agent, r.classifier]), [["gate-local", true], ["fleet-classifier", true]]);
});

test("malformed entries are ignored loudly instead of breaking routing", () => {
  const { results, stderr } = evaluate({
    agentTiers: { "tester": "fastest", "a*b*": "worker", "": "smart", "ok": "smart" },
    defaultAgentTier: "classifier",
  }, [["tester"], ["ok"], ["unmapped"]]);
  assert.deepEqual(tiersOf(results), { tester: "worker", ok: "smart", unmapped: "worker" });
  assert.match(stderr, /agentTiers\["tester"\]/);
  assert.match(stderr, /defaultAgentTier "classifier"/);
});

// The behaviour opencode-router 0.51 hardcoded, kept verbatim as the reference the
// config-driven mapping must reproduce for a deployment that states it in config.
const legacyTierForAgent = (agent, { parentTier } = {}) => {
  const ROUTE_TIERS = new Set(["deep", "smart", "build", "fast-build", "review", "worker"]);
  if (agent === "deep") return "deep";
  if (agent === "fast-build") return "fast-build";
  if (agent === "build") return "build";
  if (agent === "sp-implementer") return "build";
  if (agent === "review-verifier" || agent === "verifier") return "smart";
  if (agent === "tester") return "worker";
  if (agent === "reviewer" || (typeof agent === "string" && agent.startsWith("review-"))) return "review";
  if (agent === "smart" || agent === "plan" || agent === "researcher") return "smart";
  if (agent === "general") return ROUTE_TIERS.has(parentTier) ? parentTier : "worker";
  return "worker";
};

test("the documented agentTiers block reproduces the pre-1.0 hardcoded table exactly", () => {
  const fleet = {
    agentTiers: {
      "sp-implementer": "build",
      "review-verifier": "smart",
      verifier: "smart",
      tester: "worker",
      reviewer: "review",
      "review-*": "review",
      researcher: "smart",
    },
  };
  const agents = ["deep", "fast-build", "build", "sp-implementer", "review-verifier", "verifier", "tester",
    "reviewer", "review-panelist", "review-", "review", "smart", "plan", "researcher", "general", "explore",
    "standard", "scout", "grunt", "title", "summary", "compaction", "fleet-classifier", "fleet-classifier-local", ""];
  const parents = [undefined, "deep", "smart", "build", "fast-build", "review", "worker", "classifier", "bogus"];
  const probes = agents.flatMap((agent) => parents.map((parent) => [agent, parent]));
  const { results } = evaluate(fleet, probes);
  for (const { agent, parentTier, tier } of results) {
    assert.equal(tier, legacyTierForAgent(agent, { parentTier }), `${agent} under parent ${parentTier}`);
  }
  // And the classifier lanes are the same family the old prefix matched.
  for (const { agent, classifier } of results) {
    assert.equal(classifier, agent.startsWith("fleet-classifier"), agent);
  }
});

test("tierAliases only ever point upward, so an alias cannot undercut a risk floor", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-tier-aliases-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ tierAliases: { build: "smart", smart: "build", review: "review", worker: "nonsense" } }));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { CONFIG } = await import(${JSON.stringify(new URL("../lib/config.js", import.meta.url).href)});
      process.stdout.write(JSON.stringify(CONFIG.tierAliases));
    `], { env: { ...process.env, HOME: dir, OPENCODE_BROKER_CONFIG: path }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { build: "smart" });
    assert.match(result.stderr, /tierAliases\["smart"\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
