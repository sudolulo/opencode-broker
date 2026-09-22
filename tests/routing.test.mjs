import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Route the config loader at the fleet-shaped fixture BEFORE any router module
// loads -- config.js reads its file once at import time.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const R = await import(new URL("../lib/routing.js", import.meta.url).href);
const C = await import(new URL("../lib/router-core.js", import.meta.url).href);

const parseScalar = (raw) => {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
};

const parseFrontmatter = (text) => {
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], "---");
  const root = {};
  const stack = [{ indent: -1, value: root }];
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---") break;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();
    const match = trimmed.match(/^([^:]+):(?:\s*(.*))?$/);
    assert.ok(match, `bad frontmatter line: ${line}`);
    const key = match[1].trim().replace(/^['"]|['"]$/g, "");
    const rawValue = match[2] ?? "";
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;
    if (!rawValue) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }
  assert.equal(lines[i], "---");
  return root;
};

const withTempHome = async (fn) => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "fleet-routing-home-"));
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
};

const freshRouting = async () => import(`${new URL("../lib/routing.js", import.meta.url).href}?v=${Date.now()}-${Math.random()}`);

test("tier mapping centralizes agent roles", () => {
  assert.equal(R.tierForAgent("build"), "build");
  assert.equal(R.tierForAgent("fast-build"), "fast-build");
  assert.equal(R.tierForAgent("smart"), "smart");
  assert.equal(R.tierForAgent("review-panelist"), "review");
  // ☠️ The verifier outranks the panel it checks. Its job -- break the claim, prove the
  // failure is reachable, rule out an upstream guard -- is strictly harder than raising the
  // claim, and a verifier no stronger than the proposer launders a plausible-but-wrong
  // finding into a CONFIRMED verdict. Same split the fleet runs on the Claude side
  // (repo-review sonnet, repo-review-verify opus).
  assert.equal(R.tierForAgent("review-verifier"), "smart",
    "☠️ a verifier must outrank the panel it checks, or it confirms what it cannot disprove");
  // `tester` runs given commands and pastes the failure tail; it may not edit source or change
  // expectations. Mechanical, so it rides worker -- it sat on `review` only because the
  // prefix rule grouped it with the reviewer, drawing a design-grade model to run `npm test`.
  assert.equal(R.tierForAgent("tester"), "worker",
    "running a command and pasting its tail is worker work");
  assert.equal(R.tierForAgent("researcher"), "smart",
    "a researcher decides what to trust, not just what to judge");
  assert.equal(R.tierForAgent("plan"), "smart");
  assert.equal(R.tierForAgent("reviewer"), "review");
  assert.equal(R.tierForAgent("standard"), "worker");
  assert.equal(R.tierForAgent("scout"), "worker");
  assert.equal(R.tierForAgent("grunt"), "worker");
  assert.equal(R.tierForAgent("verifier"), "smart", "the bare `verifier` alias follows review-verifier");
  assert.equal(R.tierForAgent("general"), "worker");
  assert.equal(R.tierForAgent("sp-implementer"), "build",
    "the superpowers implementer seat writes code; it must not fall through to worker");
  assert.equal(R.tierForAgent("explore"), "worker");
  assert.equal(R.tierForAgent("title"), "worker");
  assert.equal(R.tierForAgent("summary"), "worker");
  assert.equal(R.tierForAgent("compaction"), "worker");
});

test("reviewer is always Review while general inherits every route tier", async () => {
  for (const parentTier of ["worker", "smart", "build", "fast-build"]) {
    const routes = new Map([["parent", { tier: parentTier }]]);
    assert.equal(await C.routeTierForSession({ agent: "reviewer", parentID: "parent", routes }), "review");
    assert.equal(await C.routeTierForSession({ agent: "general", parentID: "parent", routes }), parentTier);
  }
});

test("explicit static Anthropic targets cover every routing role", () => {
  assert.deepEqual(R.targetIDsFor("auto", "smart"), ["gpt-flagship", "claude-opus-5"]);
  assert.deepEqual(R.targetEligibleIDsFor("auto", "smart"),
    ["gpt-flagship", "claude-opus-5", "claude-opus-4-8", "qwen-max", "gpt-terra"]);
  assert.deepEqual(R.targetIDsFor("auto", "build"), ["gpt-terra", "deepseek-pro", "glm"]);
  assert.deepEqual(R.targetIDsFor("auto", "fast-build"),
    ["claude-opus-5-fast", "claude-opus-4-8-fast", "gpt-terra"]);
  assert.deepEqual(R.targetIDsFor("auto", "review"),
    ["glm", "deepseek-pro", "gpt-terra", "claude-sonnet-4-6"]);
  assert.deepEqual(R.targetIDsFor("auto", "worker"),
    ["gpt-luna", "qwen-flash", "haiku", "local-coder"]);
  assert.deepEqual(R.targetEligibleIDsFor("auto", "classifier"),
    ["local-classifier", "haiku", "gpt-luna"]);
  assert.deepEqual(R.targetIDsFor("auto", "deep"), ["gpt-flagship", "qwen-max", "claude-fable-5-1"]);
  assert.equal(R.TARGETS.haiku.modelID, "claude-haiku-4-5");
  assert.equal(R.TARGETS["claude-opus-5"].fit.smart, 1.4);
  assert.equal(R.TARGETS["claude-opus-4-8"].fit.smart, 1.1);
  assert.equal(R.TARGETS["claude-opus-5-fast"].fit["fast-build"], 1.3);
  assert.equal(R.TARGETS["claude-opus-4-8-fast"].fit["fast-build"], 1.3);
  const rawConfig = JSON.parse(readFileSync(new URL("./fixtures/config.json", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, ""));
  assert.deepEqual(rawConfig.targets["claude-sonnet-4-6"], {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
    kind: "cloud",
    fit: { review: 1.4 },
    effort: { review: "medium" },
  });
  assert.deepEqual(R.modelRefForTier(R.TARGETS["claude-sonnet-4-6"], "review"), {
    providerID: "anthropic",
    id: "claude-sonnet-4-6",
    variant: "medium",
  });
  assert.deepEqual(R.TARGETS.haiku.fit, { worker: 1.0, classifier: 1.3 });
  assert.equal(R.TARGETS["claude-fable-5-1"].fit.deep, 1.5);
  assert.equal(R.desiredVariantForTier("review"), null);
});

test("Auto worker routing balances healthy cloud providers", () => {
  // Deterministic rotation may select gpt-luna after qwen-flash even when qwen has active work
  const first = R.chooseTarget({ profile: "auto", tier: "worker" });
  assert.equal(first.target.id, "gpt-luna");

  const second = R.chooseTarget({
    profile: "auto",
    tier: "worker",
    active: { "qwen-flash": 1 },
    cursors: { [first.cursorKey]: first.nextCursor },
  });
  assert.equal(second.target.id, "qwen-flash");

  const third = R.chooseTarget({
    profile: "auto",
    tier: "worker",
    active: { "qwen-flash": 1, "gpt-luna": 1 },
    cursors: { [second.cursorKey]: second.nextCursor },
  });
  assert.equal(third.target.id, "haiku");

  // High active counts on all cloud targets must NOT force local fallback while eligible cloud exists
  const highActive = R.chooseTarget({
    profile: "auto",
    tier: "worker",
    active: { "qwen-flash": 2, "gpt-luna": 2 },
    cursors: { [third.cursorKey]: third.nextCursor },
  });
  assert.equal(["gpt-luna", "qwen-flash", "haiku"].includes(highActive.target.id), true,
    "high active counts on cloud never force local fallback");
});

test("cloud targets remain eligible under high active counts", () => {
  assert.equal(R.targetAtCapacity(R.TARGETS["qwen-flash"], 999), false);

  const choice = R.chooseTarget({
    profile: "auto",
    tier: "worker",
    active: { "qwen-flash": 999 },
    circuits: { "gpt-luna": { until: null }, haiku: { until: null } },
    cursors: { "auto:worker:cloud": 0 },
  });

  assert.equal(choice.target.id, "qwen-flash");
});

test("local targets stop at a single active lease", () => {
  assert.equal(R.targetAtCapacity(R.TARGETS["local-coder"], 0), false);
  assert.equal(R.targetAtCapacity(R.TARGETS["local-coder"], 1), true);

  const circuits = Object.fromEntries(Object.values(R.TARGETS)
    .filter((target) => target.kind === "cloud")
    .map((target) => [target.id, { until: null }]));
  const choice = R.chooseTarget({
    profile: "auto",
    tier: "worker",
    circuits,
    active: { "local-coder": 1 },
    localModels: new Set(["qwen3.5-9b-coder"]),
  });

  assert.equal(choice, null);
});

test("cloud selection stays deterministic and JSON-safe", () => {
  const input = {
    profile: "auto",
    tier: "worker",
    active: { "qwen-flash": 999, "gpt-luna": 999 },
    cursors: { "auto:worker:cloud": 2 },
  };
  const first = R.chooseTarget(input);
  const second = R.chooseTarget(input);

  assert.equal(first.target.id, "haiku");
  assert.equal(second.target.id, first.target.id);
  assert.doesNotMatch(JSON.stringify(first), /Infinity|NaN/);
});

test("open cloud circuits fall through only to a deployed local target", () => {
  const circuits = Object.fromEntries(Object.values(R.TARGETS)
    .filter((target) => target.kind === "cloud" && R.targetIDsFor("auto", "worker").includes(target.id))
    .map((target) => [target.id, { until: null }]));
  assert.equal(R.chooseTarget({ profile: "auto", tier: "worker", circuits }), null);
  const choice = R.chooseTarget({
    profile: "auto",
    tier: "worker",
    circuits,
    localModels: new Set(["qwen3.5-9b-coder"]),
    contextTokens: 1000,
  });
  assert.equal(choice.target.id, "local-coder");
});

test("a provider quota circuit excludes every capped Alibaba target", () => {
  const circuits = { "provider:alibaba-token-plan": { until: null } };
  const worker = R.chooseTarget({ profile: "auto", tier: "worker", circuits });
  assert.equal(worker.target.id, "gpt-luna");
  assert.deepEqual(R.targetIDsFor("auto", "build"), ["gpt-terra", "deepseek-pro", "glm"]);
  assert.deepEqual(R.targetIDsFor("auto", "smart"), ["gpt-flagship", "claude-opus-5"]);
  assert.equal(R.providerCircuitID("alibaba-token-plan"), "provider:alibaba-token-plan");
});

test("Anthropic role targets obey target and provider circuits", () => {
  const open = { until: null };
  const cases = [
    { tier: "smart", anthropic: "claude-opus-5", competitors: ["gpt-flagship"], nonAnthropic: "gpt-flagship" },
    { tier: "fast-build", anthropic: "claude-opus-5-fast", competitors: ["claude-opus-4-8-fast", "gpt-terra"], nonAnthropic: "gpt-terra" },
    { tier: "fast-build", anthropic: "claude-opus-4-8-fast", competitors: ["claude-opus-5-fast", "gpt-terra"], nonAnthropic: "gpt-terra" },
    { tier: "review", anthropic: "claude-sonnet-4-6", competitors: ["glm", "deepseek-pro", "gpt-terra"], nonAnthropic: "glm" },
    { tier: "worker", anthropic: "haiku", competitors: ["gpt-luna", "qwen-flash", "local-coder"], nonAnthropic: "gpt-luna" },
    { tier: "deep", anthropic: "claude-fable-5-1", competitors: ["gpt-flagship", "qwen-max"], nonAnthropic: "gpt-flagship" },
  ];
  for (const { tier, anthropic, competitors, nonAnthropic } of cases) {
    const forced = R.chooseTarget({
      profile: "auto", tier, localModels: new Set(), contextTokens: 1000,
      circuits: Object.fromEntries(competitors.map((id) => [id, open])),
    });
    assert.equal(forced.target.id, anthropic, `${tier}: explicit Anthropic target is eligible`);
    const unavailable = R.chooseTarget({
      profile: "auto", tier, localModels: new Set(), contextTokens: 1000,
      circuits: { [anthropic]: open },
    });
    assert.notEqual(unavailable.target.id, anthropic, `${tier}: target circuit excludes it`);
    assert.equal(unavailable.decision.eligibleTargetIDs.includes(anthropic), false,
      `${tier}: target circuit removes it from the eligible set`);
    const exhausted = R.chooseTarget({
      profile: "auto", tier, localModels: new Set(), contextTokens: 1000,
      circuits: { "provider:anthropic": open },
    });
    assert.ok(exhausted.decision.eligibleTargetIDs.includes(nonAnthropic), `${tier}: non-Anthropic candidate remains`);
    assert.equal(exhausted.decision.eligibleTargetIDs.some((id) => R.TARGETS[id]?.providerID === "anthropic"), false);
  }
});

test("classifier Haiku fallback yields to non-Anthropic fallback when quota is exhausted", () => {
  const haiku = R.chooseTarget({ profile: "auto", tier: "classifier", localModels: new Set(), contextTokens: 1100 });
  assert.equal(haiku.target.id, "haiku");
  const exhausted = R.chooseTarget({
    profile: "auto",
    tier: "classifier",
    localModels: new Set(),
    contextTokens: 1100,
    circuits: { "provider:anthropic": { until: null } },
  });
  assert.notEqual(exhausted.target.providerID, "anthropic");
  assert.ok(exhausted.decision.eligibleTargetIDs.includes("gpt-luna"));
});

test("Smart uses Opus 4.8 in the first fallback rung", () => {
  const choice = R.chooseTarget({
    profile: "auto",
    tier: "smart",
    circuits: {
      "gpt-flagship": { until: null },
      "claude-opus-5": { until: null },
      "qwen-max": { until: null },
    },
  });
  assert.equal(choice.target.id, "claude-opus-4-8");
  assert.equal(choice.decision.policy, "strict-fallback");
});

test("researcher verifier and sp-implementer retain declared tiers and resolve to Smart", () => {
  const open = { until: null };
  const declaredByAgent = {
    researcher: "smart",
    verifier: "smart",
    "sp-implementer": "build",
  };
  for (const [agent, declared] of Object.entries(declaredByAgent)) {
    assert.equal(R.tierForAgent(agent), declared, `${agent}: declared tier`);
    const effective = R.CONFIG.tierAliases[declared] ?? declared;
    assert.equal(effective, "smart", `${agent}: effective tier`);
    assert.ok(R.targetEligibleIDsFor("auto", effective).includes("claude-opus-5"),
      `${agent}: explicit Opus is eligible`);

    const opus = R.chooseTarget({
      profile: "auto", tier: effective, localModels: new Set(), contextTokens: 1000,
      circuits: { "gpt-flagship": open },
    });
    assert.equal(opus.target.id, "claude-opus-5", `${agent}: GPT circuit leaves Opus eligible`);

    const targetExcluded = R.chooseTarget({
      profile: "auto", tier: effective, localModels: new Set(), contextTokens: 1000,
      circuits: { "claude-opus-5": open },
    });
    assert.equal(targetExcluded.target.id, "gpt-flagship", `${agent}: Opus target circuit falls back to GPT`);
    assert.equal(targetExcluded.decision.eligibleTargetIDs.includes("claude-opus-5"), false,
      `${agent}: Opus target circuit removes it from the eligible set`);

    const quotaExcluded = R.chooseTarget({
      profile: "auto", tier: effective, localModels: new Set(), contextTokens: 1000,
      circuits: { "provider:anthropic": open },
    });
    assert.equal(quotaExcluded.target.id, "gpt-flagship", `${agent}: Anthropic quota falls back to GPT`);
    assert.ok(quotaExcluded.decision.eligibleTargetIDs.includes("gpt-flagship"),
      `${agent}: non-Anthropic candidate remains`);
    assert.equal(quotaExcluded.decision.eligibleTargetIDs
      .some((id) => R.TARGETS[id]?.providerID === "anthropic"), false,
    `${agent}: Anthropic candidates are excluded`);
  }
});

test("equal-utilization Smart tie break follows configured order then cursor", () => {
  const first = R.chooseTarget({
    profile: "auto", tier: "smart", localModels: new Set(), contextTokens: 1000,
  });
  assert.equal(first.target.id, "gpt-flagship");
  assert.deepEqual(first.decision.balancedTargetIDs, ["gpt-flagship", "claude-opus-5"]);
  assert.ok(first.decision.reasons.includes("round-robin-tiebreak"));

  const second = R.chooseTarget({
    profile: "auto", tier: "smart", localModels: new Set(), contextTokens: 1000,
    cursors: { [first.cursorKey]: first.nextCursor },
  });
  assert.equal(second.target.id, "claude-opus-5");
  assert.equal(second.decision.policy, "weighted-depletion");
});

test("Smart falls back to Terra and Build to the flagship only as a strict emergency", () => {
  const smartHealthy = R.chooseTarget({ profile: "auto", tier: "smart" });
  assert.notEqual(smartHealthy.target.id, "gpt-terra");
  assert.notEqual(smartHealthy.decision.policy, "strict-fallback");

  const buildHealthy = R.chooseTarget({ profile: "auto", tier: "build" });
  assert.notEqual(buildHealthy.target.id, "gpt-flagship");
  assert.notEqual(buildHealthy.decision.policy, "strict-fallback");

  const smartFallback = R.chooseTarget({
    profile: "auto",
    tier: "smart",
    circuits: {
      "gpt-flagship": { until: null },
      "provider:alibaba-token-plan": { until: null },
      "provider:anthropic": { until: null },
    },
  });
  assert.equal(smartFallback.target.id, "gpt-terra");
  assert.equal(smartFallback.decision.policy, "strict-fallback");
  assert.deepEqual(smartFallback.decision.eligibleTargetIDs, ["gpt-terra"]);

  const buildFallback = R.chooseTarget({
    profile: "auto",
    tier: "build",
    circuits: {
      "gpt-terra": { until: null },
      "provider:alibaba-token-plan": { until: null },
      "provider:anthropic": { until: null },
    },
  });
  assert.equal(buildFallback.target.id, "gpt-flagship");
  assert.equal(buildFallback.decision.policy, "strict-fallback");
  assert.deepEqual(buildFallback.decision.eligibleTargetIDs, ["gpt-flagship"]);
});

test("Fast Build is explicit while regular Build uses Fast models only as emergency fallbacks", () => {
  assert.deepEqual(R.targetIDsFor("auto", "fast-build"), ["claude-opus-5-fast", "claude-opus-4-8-fast", "gpt-terra"]);
  assert.equal(R.targetIDsFor("auto", "build").includes("claude-opus-5-fast"), false);

  const dynamic = R.discoverSubscriptionTargets({ connected: ["anthropic"], all: [{
    id: "anthropic",
    models: { "claude-opus-5-20260820": { id: "claude-opus-5-20260820", family: "claude-opus", release_date: "2026-08-20", tool_call: true } },
  }] }, { anthropic: "oauth" }).targets;
  const standardOpusID = Object.keys(dynamic)[0];
  const targets = { ...R.TARGETS, ...dynamic };

  const interactive = R.chooseTarget({ profile: "auto", tier: "fast-build" });
  assert.equal(["claude-opus-5-fast", "claude-opus-4-8-fast"].includes(interactive.target.id), true);
  assert.equal(interactive.decision.policy, "weighted-depletion");

  const regularEmergency = R.chooseTarget({
    profile: "auto",
    tier: "build",
    targets,
    circuits: {
      "gpt-terra": { until: null },
      "deepseek-pro": { until: null },
      "glm": { until: null },
      [standardOpusID]: { until: null },
    },
  });
  assert.equal(["claude-opus-5-fast", "claude-opus-4-8-fast"].includes(regularEmergency.target.id), true);
  assert.equal(regularEmergency.decision.policy, "strict-fallback");

  // An anthropic outage no longer empties fast-build: the cross-provider lane
  // members carry it in-lane, no fallback needed.
  const anthropicDown = R.chooseTarget({
    profile: "auto",
    tier: "fast-build",
    targets,
    circuits: {
      "claude-opus-5-fast": { until: null },
      "claude-opus-4-8-fast": { until: null },
    },
  });
  assert.equal(anthropicDown.target.id, "gpt-terra");
  assert.equal(anthropicDown.decision.policy, "weighted-depletion");

  // Only when the WHOLE lane is out does the newest standard opus take over.
  const interactiveFallback = R.chooseTarget({
    profile: "auto",
    tier: "fast-build",
    targets,
    circuits: {
      "claude-opus-5-fast": { until: null },
      "claude-opus-4-8-fast": { until: null },
      "gpt-terra": { until: null },
    },
  });
  assert.equal(interactiveFallback.target.id, standardOpusID);
  assert.equal(interactiveFallback.decision.policy, "strict-fallback");
});

test("approved static Anthropic targets coexist with discovered families", () => {
  const providers = { anthropic: { connected: true, authType: "oauth" } };
  assert.equal(R.TARGETS["claude-haiku"], undefined);
  assert.equal(R.TARGETS["claude-fable"], undefined);
  assert.equal(R.TARGETS["claude-opus-5"].modelID, "claude-opus-5");
  assert.equal(R.cloudTargetAdmitted(R.TARGETS["claude-opus-5-fast"], providers), true);
  assert.equal(R.cloudTargetAdmitted(R.TARGETS["claude-opus-5-fast"], { anthropic: { connected: true, authType: "api-key" } }), false);
});

test("Smart routing uses admitted Qwen Max when both primaries are unavailable", () => {
  const choice = R.chooseTarget({
    profile: "auto",
    tier: "smart",
    circuits: {
      "gpt-flagship": { until: null },
      "provider:anthropic": { until: null },
    },
  });
  assert.equal(choice.target.id, "qwen-max");
});

test("connected OAuth inventory discovers exact Anthropic families", () => {
  const discovery = R.discoverSubscriptionTargets({
    connected: ["anthropic"],
    all: [{
      id: "anthropic",
      models: {
        "claude-opus-4-6": {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          status: "active",
          tool_call: true,
          family: "claude-opus",
          release_date: "2026-04-01",
          // API catalog reference prices do not alter Claude Code OAuth billing.
          cost: { input: 5, output: 25 },
        },
        "claude-fable-4-6": {
          id: "claude-fable-4-6",
          name: "Claude Fable 4.6",
          status: "active",
          tool_call: true,
          family: "claude-fable",
          release_date: "2026-04-01",
          cost: { input: 5, output: 25 },
        },
        "claude-haiku-4-5": {
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          status: "active",
          tool_call: true,
          family: "claude-haiku",
          release_date: "2025-10-01",
          cost: { input: 1, output: 5 },
        },
      },
    }],
  }, { anthropic: "oauth" }, {});
  assert.equal(discovery.providers.anthropic.admission, "admitted");
  assert.equal(discovery.providers.anthropic.connected, true);
  assert.equal(discovery.providers.anthropic.authType, "oauth");
  assert.equal(discovery.providers.anthropic.models, 3);
  const expected = ["claude-opus-4-6", "claude-fable-4-6", "claude-haiku-4-5"];
  assert.deepEqual(new Set(Object.values(discovery.targets).map((target) => target.modelID)),
    new Set(expected));
  assert.equal(Object.keys(discovery.targets).length, expected.length);
  assert.equal(R.cloudTargetAdmitted({ kind: "cloud", providerID: "openai" },
    { openai: { connected: true, authType: "oauth" } }), true);
});

test("Anthropic families choose the newest rolling alias and fall back after a target circuit", () => {
  const discovered = R.discoverSubscriptionTargets({ connected: ["anthropic"], all: [{
    id: "anthropic",
    models: {
      "claude-fable-4-8": { id: "claude-fable-4-8", family: "claude-fable", release_date: "2026-05-01", tool_call: true },
      "claude-fable-5-20260820": { id: "claude-fable-5-20260820", family: "claude-fable", release_date: "2026-08-20", tool_call: true },
      "claude-fable-5": { id: "claude-fable-5", family: "claude-fable", release_date: "2026-08-20", tool_call: true },
      "claude-sonnet-5": { id: "claude-sonnet-5", family: "claude-sonnet", release_date: "2026-08-25", tool_call: true },
      "claude-opus-5-fast": { id: "claude-opus-5-fast", family: "claude-opus", release_date: "2026-08-21", tool_call: true },
    },
  }] }, { anthropic: "oauth" });
  const targets = { ...R.TARGETS, ...discovered.targets };
  // Sonnet is a discovered BUILD family (quality per dollar: $2/$10 vs opus $5/$25);
  // fast speed-variants stay out of standard family discovery.
  const sonnet = Object.values(discovered.targets).find((target) => target.modelID === "claude-sonnet-5");
  assert.deepEqual(sonnet?.tiers, ["build", "review"]);
  assert.equal(Object.values(discovered.targets).some((target) => target.modelID === "claude-opus-5-fast"), false);
  const circuits = {
    "gpt-flagship": { until: null },
    "gpt-pro": { until: null },
    "claude-fable-5-1": { until: null },
    "provider:alibaba-token-plan": { until: null },
  };
  const newest = R.chooseTarget({ profile: "auto", tier: "deep", targets, circuits });
  assert.equal(newest.target.modelID, "claude-fable-5");
  const fallback = R.chooseTarget({
    profile: "auto", tier: "deep", targets,
    circuits: { ...circuits, [newest.target.id]: { until: null } },
  });
  assert.equal(fallback.target.modelID, "claude-fable-5-20260820");
});

test("inventory publication sends the current auth revision before a cloud lease", async () => withTempHome(async (home) => {
  const routing = await freshRouting();
  const authDir = join(home, ".local/share/opencode");
  mkdirSync(authDir, { recursive: true });
  const authPath = join(authDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ openai: { type: "oauth" } }) + "\n");
  const calls = [];
  await routing.publishSubscriptionInventory({
    directory: home,
    listProviders: async (parameters) => {
      assert.deepEqual(parameters, { directory: home });
      return { data: {
      connected: ["openai"],
      all: [{ id: "openai", models: { "gpt-5.6-luna": { id: "gpt-5.6-luna", name: "GPT Mini", status: "active" } } }],
      } };
    },
    request: async (path, body) => {
      calls.push({ path, body });
      return { changed: true };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/inventory");
  assert.match(calls[0].body.authRevision, /^\d+:\d+:[a-f0-9]{64}$/);
  assert.equal(calls[0].body.providers.openai.authType, "oauth");
}));

test("auth inventory admits static OAuth targets without provider catalog access", async () => withTempHome(async (home) => {
  const routing = await freshRouting();
  const authDir = join(home, ".local/share/opencode");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({
    openai: { type: "oauth" },
    "alibaba-token-plan": { type: "oauth" },
    anthropic: { type: "oauth" },
  }) + "\n");
  const calls = [];
  await routing.publishAuthInventory({ request: async (path, body) => {
    calls.push({ path, body });
    return { changed: true };
  } });
  assert.deepEqual(calls.map((call) => call.path), ["/inventory"]);
  assert.equal(calls[0].body.providers.openai.connected, true);
  assert.equal(calls[0].body.providers.openai.authType, "oauth");
  assert.equal(calls[0].body.providers.anthropic.connected, true);
  assert.equal(calls[0].body.providers.anthropic.authType, "oauth");
  assert.equal(Object.hasOwn(calls[0].body, "targets"), false);
  assert.match(calls[0].body.authRevision, /^\d+:\d+:[a-f0-9]{64}$/);
}));

test("cached inventory publishes only authenticated catalog providers", async () => withTempHome(async (home) => {
  const routing = await freshRouting();
  const authDir = join(home, ".local/share/opencode");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth" }, metered: { type: "api" } }) + "\n");
  const cachePath = join(home, "models.json");
  writeFileSync(cachePath, JSON.stringify({
    anthropic: { id: "anthropic", models: {
      "claude-fable-5": { id: "claude-fable-5", family: "claude-fable", release_date: "2026-08-20", tool_call: true },
    } },
    metered: { id: "metered", models: { expensive: { id: "expensive", tool_call: true } } },
  }));
  const calls = [];
  await routing.publishCachedSubscriptionInventory({ cachePath, request: async (path, body) => {
    calls.push({ path, body });
    return { changed: true };
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/inventory");
  assert.deepEqual(Object.keys(calls[0].body.providers), ["anthropic"]);
  assert.equal(Object.values(calls[0].body.targets)[0].modelID, "claude-fable-5");
}));

test("cached inventory errors are actionable", async () => withTempHome(async (home) => {
  const routing = await freshRouting();
  const authDir = join(home, ".local/share/opencode");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth" } }) + "\n");
  await assert.rejects(routing.publishCachedSubscriptionInventory({ cachePath: join(home, "missing.json") }), /opencode models --refresh/);
  const invalid = join(home, "invalid.json");
  writeFileSync(invalid, "[]\n");
  await assert.rejects(routing.publishCachedSubscriptionInventory({ cachePath: invalid }), /opencode models --refresh/);
}));

// ☠️ An OAuth provider nobody has MAPPED gets no lane. Tier roles are a deployment
// decision, so an unmapped family is invisible rather than guessed at from the words in
// its name -- "Example Max" no longer talks its way into the smart tier.
test("an OAuth provider with no mapped family is admitted but discovers nothing", () => {
  const discovery = R.discoverSubscriptionTargets({
    connected: ["example-oauth"],
    all: [{
      id: "example-oauth",
      models: {
        flagship: { id: "flagship", name: "Example Max", status: "active", tool_call: true,
          family: "example-max", release_date: "2026-04-01" },
        builder: { id: "builder", name: "Example Coder", status: "active", tool_call: true,
          family: "example-coder", release_date: "2026-04-01" },
        worker: { id: "worker", name: "Example Mini", status: "active", tool_call: true,
          family: "example-mini", release_date: "2026-04-01" },
      },
    }],
  }, { "example-oauth": "oauth" });
  assert.equal(discovery.providers["example-oauth"].admission, "admitted");
  assert.equal(discovery.providers["example-oauth"].models, 3);
  assert.deepEqual(Object.keys(discovery.targets), []);
});

test("provider admission describes access, not config shape", () => {
  const discovery = R.discoverSubscriptionTargets({
    connected: ["empty-oauth", "metered-api", "alibaba-token-plan"],
    all: [
      { id: "offline-oauth", models: {} },
      { id: "empty-oauth", models: {} },
      { id: "metered-api", models: {} },
      { id: "alibaba-token-plan", models: {} },
    ],
  }, {
    "offline-oauth": "oauth",
    "empty-oauth": "oauth",
    "metered-api": "api",
    "alibaba-token-plan": "api",
  }, {});
  assert.deepEqual(Object.fromEntries(Object.entries(discovery.providers)
    .map(([id, provider]) => [id, provider.admission])), {
    "offline-oauth": "disconnected",
    "empty-oauth": "quarantined-model",
    "metered-api": "quarantined-auth",
    "alibaba-token-plan": "admitted",
  });
});

// Every provider reads through the SAME table: no provider ID appears in the discovery
// path, so OpenAI families land in their tiers exactly as Anthropic's do.
test("mapped OpenAI families are discovered on the same path as Anthropic families", () => {
  const discovery = R.discoverSubscriptionTargets({
    connected: ["openai"],
    all: [{
      id: "openai",
      models: {
        "gpt-9-astra": { id: "gpt-9-astra", status: "active", tool_call: true,
          family: "gpt-astra", release_date: "2026-09-04" },
        "gpt-9-sol": { id: "gpt-9-sol", status: "active", tool_call: true,
          family: "gpt-sol", release_date: "2026-09-04" },
        "gpt-9-terra": { id: "gpt-9-terra", status: "active", tool_call: true,
          family: "gpt-terra", release_date: "2026-09-04" },
        "gpt-9-luna": { id: "gpt-9-luna", status: "active", tool_call: true,
          family: "gpt-luna", release_date: "2026-09-04" },
        // Unmapped: the generic catalog families stay out of every lane.
        "gpt-9": { id: "gpt-9", status: "active", tool_call: true,
          family: "gpt", release_date: "2026-09-04" },
        // A speed variant never joins a standard lane, whoever ships it.
        "gpt-9-sol-fast": { id: "gpt-9-sol-fast", status: "active", tool_call: true,
          family: "gpt-sol", release_date: "2026-09-04" },
      },
    }],
  }, { openai: "oauth" });
  const tiersByModel = Object.fromEntries(Object.values(discovery.targets)
    .map((target) => [target.modelID, target.tiers]));
  assert.deepEqual(tiersByModel, {
    "gpt-9-astra": ["deep"],
    "gpt-9-sol": ["smart"],
    "gpt-9-terra": ["build"],
    "gpt-9-luna": ["worker"],
  });
  assert.equal(Object.values(discovery.targets)[0].source, "subscription-oauth");
  assert.ok(Object.keys(discovery.targets).every((id) => id.startsWith("subscription-openai-")));
});

// A pin covers aliases of its release, not the whole family line.
test("a configured pin suppresses its alias but not its family line", () => {
  const discovery = R.discoverSubscriptionTargets({
    connected: ["openai"],
    all: [{
      id: "openai",
      models: {
        "gpt-5.6-sol": { id: "gpt-5.6-sol", status: "active", tool_call: true,
          family: "gpt-sol", release_date: "2026-07-09" },
        // Same family, same release, different id: an alias of the pin.
        "gpt-5.6": { id: "gpt-5.6", status: "active", tool_call: true,
          family: "gpt-sol", release_date: "2026-07-09" },
        // Same family, later release: a genuinely different model.
        "gpt-5.7-sol": { id: "gpt-5.7-sol", status: "active", tool_call: true,
          family: "gpt-sol", release_date: "2026-11-02" },
      },
    }],
  }, { openai: "oauth" }, {
    pin: { providerID: "openai", modelID: "gpt-5.6-sol" },
  });
  assert.deepEqual(Object.values(discovery.targets).map((target) => target.modelID), ["gpt-5.7-sol"]);
});

test("persisted inventory migrates legacy classification and keeps mapped family metadata", () => {
  const normalized = R.normalizeDiscoveredInventory({
    targets: {
      stale: {
        id: "stale-example-worker",
        providerID: "example-oauth",
        modelID: "example-mini",
        kind: "cloud",
        capacity: null,
        source: "subscription-oauth",
        tiers: ["worker"],
      },
      openai: {
        id: "subscription-openai-gpt-6-astra-standard",
        providerID: "openai",
        modelID: "gpt-6-astra",
        kind: "cloud",
        capacity: null,
        source: "subscription-oauth",
        tiers: ["deep"],
        family: "gpt-astra",
        releaseDate: "2026-09-04",
        speed: "standard",
      },
      local: {
        id: "stale-example-local",
        providerID: "example-oauth",
        modelID: "example-mini",
        kind: "local",
        capacity: 0,
        tiers: ["worker"],
      },
    },
    providers: {
      "example-oauth": { authType: "oauth", connected: true, classification: "subscription", models: 15 },
    },
  });
  assert.equal(normalized.targets["stale-example-worker"].id, "stale-example-worker");
  assert.equal(normalized.targets["stale-example-worker"].capacity, null);
  assert.equal(normalized.targets["stale-example-local"], undefined);
  assert.equal(normalized.providers["example-oauth"].admission, "admitted");
  assert.equal(normalized.providers["example-oauth"].classification, undefined);
  assert.equal(normalized.targets["subscription-openai-gpt-6-astra-standard"].family, "gpt-astra");
});

test("session context estimates persist to disk and reload cleanly", async () => withTempHome(async (home) => {
  const routing = await freshRouting();
  routing.ensureRoutingStateDir();
  assert.equal(routing.writeSessionContextEstimate("ses_test", 12_345), true);
  assert.equal(routing.readSessionContextEstimate("ses_test"), 12_345);
  const path = join(home, ".local/share/opencode/model-routing/context-estimates/ses_test.json");
  assert.equal(existsSync(path), true);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored.tokens, 12_345);
  assert.equal(typeof stored.updatedAt, "number");
}));

test("pending forget records persist, reload, and delete cleanly", async () => withTempHome(async (home) => {
  const routing = await freshRouting();
  routing.ensureRoutingStateDir();
  assert.equal(routing.writePendingForgetRecord("ses_forget", { completed: true }), true);
  const record = routing.readPendingForgetRecord("ses_forget");
  assert.ok(record);
  assert.equal(record.completed, true);
  assert.equal(typeof record.updatedAt, "number");
  assert.deepEqual(routing.listPendingForgetRecords(), [{ sessionID: "ses_forget", completed: true, updatedAt: record.updatedAt }]);
  routing.removePendingForgetRecord("ses_forget");
  assert.equal(routing.readPendingForgetRecord("ses_forget"), null);
  assert.deepEqual(routing.listPendingForgetRecords(), []);
}));

test("API-key and unknown providers remain quarantined after discovery", () => {
  const inventory = {
    connected: ["anthropic", "expensive-api", "unknown"],
    all: [
      {
        id: "anthropic",
        models: {
          "claude-opus-4-6": {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            status: "active",
            tool_call: true,
            cost: { input: 0, output: 0 },
          },
        },
      },
      {
        id: "expensive-api",
        models: {
          flagship: {
            id: "flagship",
            name: "Flagship Pro",
            status: "active",
            tool_call: true,
            cost: { input: 3, output: 15 },
          },
        },
      },
      {
        id: "unknown",
        models: {
          flagship: {
            id: "flagship",
            name: "Flagship Pro",
            status: "active",
            tool_call: true,
            cost: { input: 0, output: 0 },
          },
        },
      },
    ],
  };
  const discovery = R.discoverSubscriptionTargets(inventory, { anthropic: "api", "expensive-api": "api" });
  assert.equal(discovery.providers.anthropic.admission, "quarantined-auth");
  assert.equal(discovery.providers["expensive-api"].admission, "quarantined-auth");
  assert.equal(discovery.providers.unknown.admission, "quarantined-auth");
  assert.equal(R.cloudTargetAdmitted({ kind: "cloud", providerID: "openai" },
    { openai: { connected: true, authType: "api" } }), false);
  assert.equal(R.cloudTargetAdmitted({ kind: "cloud", providerID: "alibaba-token-plan" }), true);
  assert.deepEqual(discovery.targets, {});
});

test("discovered workers are not assigned to the pinned classifier lane", () => {
  const targets = {
    ...R.TARGETS,
    "subscription-anthropic-claude-haiku-4-5-worker": {
      id: "subscription-anthropic-claude-haiku-4-5-worker",
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
      kind: "cloud",
      capacity: null,
      source: "subscription-oauth",
      tiers: ["worker", "classifier"],
    },
  };
  // The lane is local-only now, which makes the pinning property sharper: a discovered
  // cloud model must not be appended to it even when it names the classifier tier.
  assert.deepEqual(R.targetIDsFor("auto", "classifier", targets), ["local-classifier"]);
});

test("restrictive profiles never include a cloud candidate", () => {
  assert.deepEqual(R.targetIDsFor("manual"), []);
  assert.deepEqual(R.targetIDsFor("local"), ["local-coder"]);
  assert.deepEqual(R.targetIDsFor("private"), ["local-coder"]);
  // One target, and deliberately not the two `local` holds: the whole point of the lane is that
  // the caller gets the vision model rather than whichever of the pair the cursor lands on.
  assert.deepEqual(R.targetIDsFor("vision"), ["vision-27b"]);
  assert.deepEqual(R.targetIDsFor("uncensored"), ["uncensored-qwen", "uncensored-floored"]);
  // ☠️ Its own lane, sharing nothing with `uncensored`: the 70B is selectable but never
  // interchangeable with the 27b, because loading it evicts every other resident model.
  // tests/profile-registry.test.mjs holds the disjointness itself.
  assert.deepEqual(R.targetIDsFor("uncensored-70b"), ["uncensored-big"]);
  assert.deepEqual(R.targetIDsFor("uncensored-offline"), ["uncensored-qwen"]);
  assert.equal(R.chooseTarget({ profile: "private", tier: "worker" }), null);
  assert.equal(R.chooseTarget({ profile: "manual", tier: "worker" }), null);
  assert.equal(R.isLocalOnlyProfile("manual"), false);
});

test("resolveProfile keeps legacy agent names and F11 routing profiles separate", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-routing-home-"));
  try {
    const script = `
      const R = await import(${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)});
      const results = {
        local: R.resolveProfile({ agent: "local" }),
        private: R.resolveProfile({ agent: "private" }),
        uncensored: R.resolveProfile({ agent: "uncensored" }),
        offline: R.resolveProfile({ agent: "uncensored-offline" }),
      };
      // The global profile is gone: writeGlobalProfile now REFUSES rather than writing a
      // file nothing reads, and an armed choice must not resolve as a default.
      try { R.writeGlobalProfile("manual"); results.globalThrew = false; }
      catch (e) { results.globalThrew = true; }
      R.writePendingProfile("manual");
      results.underArmed = R.resolveProfile({ agent: "local" });
      R.writeSessionProfile("session-1", "private", { explicit: true });
      results.session = R.resolveProfile({ sessionID: "session-1", agent: "local" });
      console.log(JSON.stringify(results));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    const results = JSON.parse(child.stdout);
    assert.deepEqual(results.local, {
      profile: "local",
      explicit: false,
      updatedAt: 0,
      source: "agent",
    });
    assert.deepEqual(results.private, {
      profile: "private",
      explicit: false,
      updatedAt: 0,
      source: "agent",
    });
    assert.deepEqual(results.uncensored, {
      profile: "uncensored",
      explicit: false,
      updatedAt: 0,
      source: "agent",
    });
    assert.deepEqual(results.offline, {
      profile: "uncensored-offline",
      explicit: false,
      updatedAt: 0,
      source: "agent",
    });
    assert.equal(results.globalThrew, true, "writeGlobalProfile must refuse, not silently no-op");
    // An armed choice leaves agent-name resolution untouched: it is applied to ONE session
    // at creation, never consulted as a fallback rung.
    assert.equal(results.underArmed.profile, "local");
    assert.equal(results.underArmed.source, "agent");
    assert.equal(results.session.profile, "private");
    assert.equal(results.session.explicit, true);
    assert.equal(results.session.source, "session");
    assert.equal(results.session.updatedAt > 0, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("offline profiles block network and MCP tools, then wrap bash without network", () => {
  assert.equal(R.toolAllowedForProfile("private", "webfetch").allowed, false);
  assert.equal(R.toolAllowedForProfile("private", "gitea_get_file_contents").allowed, false);
  assert.equal(R.toolAllowedForProfile("private", "bash").allowed, true);
  assert.equal(R.toolAllowedForProfile("local", "gitea_get_file_contents").allowed, true);
  assert.equal(R.toolAllowedForProfile("local", "webfetch").allowed, true);
  assert.equal(R.toolAllowedForProfile("local", "library_search_library").allowed, false);
  assert.equal(R.toolAllowedForProfile("manual", "webfetch").allowed, true);

  const wrapped = R.wrapOfflineCommand("printf 'ok'", "/tmp/a b");
  assert.match(wrapped, /--unshare-net/);
  assert.match(wrapped, /--chdir '\/tmp\/a b'/);
  assert.match(wrapped, /printf '"'"'ok'"'"''/);
});

test("routing failures distinguish durable quota exhaustion from transient rate limits", () => {
  assert.equal(R.classifyRoutingFailure("Too Many Requests: token-plan quota exhausted"), "quota");
  assert.equal(R.classifyRoutingFailure({ code: "Throttling.AllocationQuota", message: "allocated quota exceeded" }), "quota");
  assert.equal(R.classifyRoutingFailure("GitHub Copilot monthly premium request limit resets at 2026-09-03T12:00:00Z"), "quota");
  assert.equal(R.classifyRoutingFailure("OpenAI usage cap renews at 2026-09-03T12:00:00Z"), "quota");
  assert.equal(R.classifyRoutingFailure({ code: "Throttling.RateQuota", message: "too many requests" }), "rate");
  assert.equal(R.classifyRoutingFailure({ code: "rate_quota", message: "Rate quota exceeded; retry after 5 seconds" }), "rate");
  assert.equal(R.classifyRoutingFailure("HTTP 429 rate limit"), "rate");
  assert.equal(R.classifyRoutingFailure({ statusCode: 404, message: "model: claude-fable-4-6" }), "model");
  assert.equal(R.classifyRoutingFailure({ statusCode: 404, message: "model: claude-fable-5 not found" }), "model");
  assert.equal(R.classifyRoutingFailure({ statusCode: 404, code: "model_unavailable", message: "endpoint unavailable" }), "model");
  assert.equal(R.classifyRoutingFailure({ code: "model_not_found", message: "unavailable" }), "model");
  assert.equal(R.classifyRoutingFailure({ statusCode: 404, message: "model routing endpoint not found" }), "other");
  assert.equal(R.classifyRoutingFailure({ statusCode: 404, message: "model" }), "other");
  assert.equal(R.classifyRoutingFailure({ statusCode: 404, message: "route not found" }), "other");
  assert.equal(R.classifyRoutingFailure("connection reset"), "other");
});

test("malformed-request and caller-close failures never indict a provider", () => {
  // The three shapes that quarantined anthropic, alibaba-token-plan and llamacpp on
  // 2026-09-17. Each is deterministic per SESSION or per CALLER, so failover reproduces
  // it on sibling models and manufactures the >=2 distinct models a quarantine needs.
  const toolPairing = "messages.2: `tool_use` ids were found without `tool_result` blocks " +
    "immediately after: call_3j2wD1an5NrdBUq0Pb22yrOF. Each `tool_use` block must have a " +
    "corresponding `tool_result` block in the next message.";
  assert.equal(R.classifyRoutingFailure({ statusCode: 400, message: toolPairing }), "payload");
  assert.equal(R.classifyRoutingFailure({ message: toolPairing }), "payload");
  assert.equal(R.classifyRoutingFailure({ statusCode: 400, message: "invalid_request_error" }), "payload");
  // Alibaba's Anthropic-compat shim on an unimplemented ROUTE (verified against the live
  // endpoint: every configured model id answers 200; /models does not).
  assert.equal(R.classifyRoutingFailure({ message: "Not Found: Not support" }), "payload");
  assert.equal(R.classifyRoutingFailure({ statusCode: 404, code: "InvalidParameter", message: "Not support" }), "payload");
  assert.equal(R.classifyRoutingFailure({ message: "classifier model error: Not Found: Not support" }), "payload");
  // HTTP 499 is our own abort observed server-side; isAbortError cannot see it wrapped.
  assert.equal(R.classifyRoutingFailure({ message: "classifier request failed (HTTP 499): {}" }), "noop");
  assert.equal(R.classifyRoutingFailure({ message: "client closed request" }), "noop");

  // Context overflow is checked BEFORE payload and must keep its own kind: it steers the
  // re-lease to a roomier window, which "payload" deliberately does not do.
  assert.equal(
    R.classifyRoutingFailure({ message: "request (127237 tokens) exceeds the available context size (122880 tokens)" }),
    "context",
  );
  // And a genuine provider fault is still a provider fault.
  assert.equal(R.classifyRoutingFailure({ statusCode: 500, message: "internal server error" }), "other");
});

test("a client-version gate fences the model, never the provider", () => {
  // Anthropic refuses a model the installed client is too old to drive. Caught live on
  // 2026-09-17 with claude-fable-5-1 already at `observing` -- one more family and the
  // provider serving every build/smart/deep lane would have quarantined again.
  const tooOld = "Claude Code 2.1.217 does not support this model; version 2.1.251 or newer " +
    "is required. Run 'claude update', or update the Claude desktop app, then try again.";
  assert.equal(R.classifyRoutingFailure({ name: "AI_APICallError", message: tooOld }), "model");
  assert.equal(R.classifyRoutingFailure({ statusCode: 400, message: tooOld }), "model");
  assert.equal(R.classifyRoutingFailure("the gateway does not support the model you requested"), "model");
  assert.equal(R.classifyRoutingFailure("this endpoint requires a newer client"), "model");
  // Must not swallow unrelated version talk that says nothing about a model.
  assert.equal(R.classifyRoutingFailure({ statusCode: 500, message: "api version mismatch" }), "other");
});

test("quota circuits use the provider renewal time and otherwise remain blocked", () => {
  const now = Date.parse("2026-08-29T12:00:00Z");
  assert.equal(
    R.quotaRenewalAt("Token plan renews at 2026-09-02T04:30:00Z", now),
    Date.parse("2026-09-02T04:30:00Z"),
  );
  assert.equal(R.quotaRenewalAt("Token plan quota exhausted", now), null);
  assert.equal(
    R.quotaRenewalAt({ code: "insufficient_quota", message: "quota exhausted", resetAt: "2026-09-02T04:30:00Z" }, now),
    Date.parse("2026-09-02T04:30:00Z"),
  );

  const blocked = R.chooseTarget({
    profile: "auto",
    tier: "worker",
    circuits: { "provider:alibaba-token-plan": { until: now + 1 } },
    now,
  });
  assert.equal(blocked.target.id, "gpt-luna");
  const renewed = R.chooseTarget({
    profile: "auto",
    tier: "worker",
    circuits: { "provider:alibaba-token-plan": { until: now + 1 } },
    now: now + 2,
  });
  assert.equal(renewed.target.id, "gpt-luna");
});

test("Auto worker routing reserves one quarter of healthy assignments for local", () => {
  const localModels = new Set(["qwen3.5-9b-coder"]);
  const choose = (cursor) => R.chooseTarget({
    profile: "auto",
    tier: "worker",
    localModels,
    contextTokens: 1000,
    cursors: { "auto:worker:mixed": cursor },
  });
  assert.equal(choose(0).target.id, "local-coder");
  assert.notEqual(choose(1).target.kind, "local");
  assert.notEqual(choose(2).target.kind, "local");
  assert.notEqual(choose(3).target.kind, "local");
  assert.equal(choose(4).target.id, "local-coder");
  assert.equal(choose(0).decision.policy, "weighted-depletion-with-local-share");
});

test("contextFits leaves headroom and stays permissive on unknowns", () => {
  assert.equal(R.contextFits(32768, 60811), false);
  assert.equal(R.contextFits(32768, 27000), true);
  assert.equal(R.contextFits(32768, 28500), false); // over the 85% line
  assert.equal(R.contextFits(null, 60811), true);
  assert.equal(R.contextFits(32768, null), true);
  assert.equal(R.contextFits(0, 60811), true);
});

test("targetContext prefers a declared context over the catalog", () => {
  const target = R.TARGETS["local-coder"];
  assert.equal(R.targetContext(target, {}), 32768);
  // A declared per-slot window outranks the catalog. opencode's llamacpp block is
  // hand-written and cannot express `--ctx-size / --parallel`, so it must not win.
  assert.equal(R.targetContext(target, { "llamacpp/qwen3.5-9b-coder": 65536 }), 32768);
  // Targets that declare nothing -- every cloud target -- still use the catalog.
  assert.equal(R.targetContext(R.TARGETS["gpt-luna"], {}), null);
  assert.equal(R.targetContext(R.TARGETS["gpt-luna"], { "openai/gpt-5.6-luna": 400000 }), 400000);
});

// A large local window does not need the same fraction reserved as a small one.
// The global default still applies to every target that declares no override.
test("a local target's own context headroom overrides the global default", () => {
  assert.equal(R.targetContextHeadroom({ kind: "local", contextHeadroom: 0.75 }, 0.6), 0.75);
  assert.equal(R.targetContextHeadroom({ kind: "local" }, 0.6), 0.6);
  for (const contextHeadroom of [0, -0.5, 1.5, null]) {
    assert.equal(R.targetContextHeadroom({ kind: "local", contextHeadroom }, 0.6), 0.6);
  }
  assert.equal(R.targetContextHeadroom({ kind: "local", contextHeadroom: "0.75" }, 0.6), 0.75);
  assert.equal(R.localContextEligible(122880, 92000,
    R.targetContextHeadroom({ kind: "local", contextHeadroom: 0.75 }, 0.6)), true);
  assert.equal(R.localContextEligible(122880, 92000, 0.6), false);
});

// ☆ A FRACTION IS THE WRONG SHAPE FOR THE RESERVE. A llama.cpp slot's KV holds the
// prompt AND the generation in one allocation, so what must stay free is a sum of
// ABSOLUTE terms -- reasoning budget + answer + growth after this check -- and none
// of them scale with the window. 0.6 holds back a correct ~13k on a 32k model and
// 79k on a 131k one, ~2.4x more than the model can physically generate.
// The deployed 9b reserve is 24,576 reasoning + 8,192 answer + 16,384 growth =
// 49,152 against a 196,608 slot, which reproduces its old 0.75 cap of 147,456
// EXACTLY: the same number, now derived from named measured terms.
test("an explicit outputReserve replaces the headroom fraction rather than stacking on it", () => {
  assert.equal(R.localContextEligible(196608, 147456, 0.75, 49152), true);
  assert.equal(R.localContextEligible(196608, 147457, 0.75, 49152), false);
  // The fraction is not consulted at all when a reserve is present: an absurd 0.1
  // would cap at 19,660, and must not, or the two mechanisms would compound.
  assert.equal(R.localContextEligible(196608, 147456, 0.1, 49152), true);
  // Without a reserve nothing changed -- the fraction still rules, so a target whose
  // generation budget nobody has measured keeps the old conservative behaviour.
  assert.equal(R.localContextEligible(196608, 147456, 0.75), true);
  assert.equal(R.localContextEligible(196608, 147457, 0.75), false);
  // A reserve at or above the window is a config error, not a 0-token target. Same
  // guard as usableContext: fall back to the fraction rather than making the target
  // permanently unroutable and silently removing it from every tier it is in.
  for (const broken of [196608, 300000, 0, -1, "banana", null]) {
    assert.equal(R.localContextEligible(196608, 147456, 0.75, broken), true);
    assert.equal(R.localContextEligible(196608, 147457, 0.75, broken), false);
  }
});

// targetOutputReserve is the only path that feeds the argument above.
test("a local target honours its own outputReserve but never the catalog's", () => {
  const catalog = { "llamacpp/local": 8192, "openai/cloud": 32000 };
  const local = { providerID: "llamacpp", modelID: "local", kind: "local" };
  // The original local exclusion stands for the CATALOG, and for its original
  // reason: a provider's advertised output limit knows nothing about this
  // deployment's --reasoning-budget, which is the largest term in a local reserve.
  assert.equal(R.targetOutputReserve(local, catalog), null);
  assert.equal(R.targetOutputReserve({ ...local, outputReserve: 49152 }, catalog), 49152);
  // Cloud keeps its catalog fallback, and the explicit-beats-catalog precedence it
  // has always documented now actually works -- nothing had ever parsed the key.
  const cloud = { providerID: "openai", modelID: "cloud", kind: "cloud" };
  assert.equal(R.targetOutputReserve(cloud, catalog), 32000);
  assert.equal(R.targetOutputReserve({ ...cloud, outputReserve: 40000 }, catalog), 40000);
});

// Regression: a stale catalog entry below the target's own minContextTokens made
// the eligible band EMPTY, silently removing the target from every tier it was in.
// localContextEligible caps at context * 0.6 while meetsContextFloor demands
// >= minContextTokens, so a catalog win of 32768 (usable 19,660) against a floor
// of 49,153 could never be satisfied by any request size.
test("a stale catalog entry cannot empty a target's eligible band", () => {
  const target = { id: "big-local", providerID: "llamacpp", modelID: "big", kind: "local",
    capacity: 2, context: 131072, minContextTokens: 49153 };
  const staleCatalog = { "llamacpp/big": 32768 };
  assert.equal(R.targetContext(target, staleCatalog), 131072);
  // 60k sits inside [49153, 78643] -- routable on the declared window...
  assert.equal(R.localContextEligible(R.targetContext(target, staleCatalog), 60000), true);
  assert.equal(R.meetsContextFloor(target, 60000), true);
  // ...and would have been refused had the stale 32768 won.
  assert.equal(R.localContextEligible(32768, 60000), false);
});

test("chooseTarget never hands an oversized session to a small local window", () => {
  const localModels = new Set(["qwen3.5-9b-coder"]);
  // worker tier with every cloud target circuit-open: only local-coder remains.
  const circuits = Object.fromEntries(
    Object.values(R.TARGETS).filter((t) => t.kind === "cloud").map((t) => [t.id, { until: null }]),
  );
  const fits = R.chooseTarget({ profile: "auto", tier: "worker", circuits, localModels, contextTokens: 15000 });
  assert.equal(fits?.target?.id, "local-coder");
  // localContextHeadroom (0.6 of 32768 = 19660): the margin that keeps a single
  // fat tool-result turn from blowing the window AFTER the lease check passed.
  const nearFull = R.chooseTarget({ profile: "auto", tier: "worker", circuits, localModels, contextTokens: 20000 });
  assert.equal(nearFull, null);
  const oversized = R.chooseTarget({ profile: "auto", tier: "worker", circuits, localModels, contextTokens: 60811 });
  assert.equal(oversized, null);
  // UNKNOWN context never fits a local window -- the overflow incidents all
  // started as sessions whose size nobody knew.
  const unknown = R.chooseTarget({ profile: "auto", tier: "worker", circuits, localModels });
  assert.equal(unknown, null);
});

test("an oversized session still routes to a cloud worker with headroom", () => {
  const localModels = new Set(["qwen3.5-9b-coder"]);
  const choice = R.chooseTarget({ profile: "auto", tier: "worker", localModels, contextTokens: 60811 });
  assert.ok(choice);
  assert.notEqual(choice.target.id, "local-coder");
});

test("inventory discovery carries model contexts and normalization filters junk", () => {
  const inventory = {
    all: [{
      id: "llamacpp",
      models: {
        a: { id: "qwen3.5-9b-coder", limit: { context: 32768 } },
        b: { id: "no-limit" },
      },
    }],
    connected: ["llamacpp"],
  };
  const discovered = R.discoverSubscriptionTargets(inventory, {});
  assert.deepEqual(discovered.modelContexts, { "llamacpp/qwen3.5-9b-coder": 32768 });
  const normalized = R.normalizeDiscoveredInventory({
    modelContexts: {
      "llamacpp/qwen3.5-9b-coder": 32768,
      "bad-no-slash": 1000,
      "openai/gpt-5.6-luna": -5,
      "openai/gpt-5.6-terra": 25_000_000,
    },
  });
  assert.deepEqual(normalized.modelContexts, { "llamacpp/qwen3.5-9b-coder": 32768 });
});

test("catalog variants are normalized and only exact tier variants are selected", () => {
  const discovered = R.discoverSubscriptionTargets({
    connected: ["openai"],
    all: [{ id: "openai", models: {
      "gpt-5.6-luna": { id: "gpt-5.6-luna", variants: { low: {}, high: {}, "bad variant": {} } },
    } }],
  }, { openai: "oauth" });
  assert.deepEqual(discovered.modelVariants, { "openai/gpt-5.6-luna": ["high", "low"] });
  const normalized = R.normalizeDiscoveredInventory({ modelVariants: {
    "openai/gpt-5.6-luna": ["low", "low", 1, "bad variant"],
    malformed: ["high"],
  } });
  assert.deepEqual(normalized.modelVariants, { "openai/gpt-5.6-luna": ["low"] });
  // modelRefForTier UNIONs the discovered variants with the fleet-configured
  // ones, so a configured effort is applied even when discovery is limited.
  // The fixture pins gpt-luna's worker effort to "low"; the smart-tier default
  // is "high", which is in the configured variant list. Both resolve despite
  // discovery only naming "low" — worker from its per-target effort, smart from
  // the union making the desired "high" available.
  assert.deepEqual(R.modelRefForTier(R.TARGETS["gpt-luna"], "worker", normalized.modelVariants), {
    providerID: "openai", id: "gpt-5.6-luna", variant: "low",
  });
  assert.deepEqual(R.modelRefForTier(R.TARGETS["gpt-luna"], "smart", normalized.modelVariants), {
    providerID: "openai", id: "gpt-5.6-luna", variant: "high",
  });
  assert.deepEqual(R.desiredVariantForTier("classifier"), ["none", "low"],
    "one-word verdicts need no reasoning budget -- ask for none, settle for low");
  // ☠️ The whole point: a thinking model left at its default emits no verdict at all, so the
  // lane must actually reach for `none`. Variants are passed explicitly here rather than read
  // from the fixture, so this pins the PREFERENCE ORDER and not a particular catalog.
  const luna = { providerID: "openai", modelID: "gpt-5.6-luna" };
  assert.equal(R.modelRefForTier(luna, "classifier", { "openai/gpt-5.6-luna": ["none", "low", "high"] }).variant,
    "none", "a reasoning model on this lane must be driven to no reasoning");
  assert.equal(R.modelRefForTier(luna, "classifier", { "openai/gpt-5.6-luna": ["low", "high"] }).variant,
    "low", "and settles for low when `none` is not offered");
  // ☆ A model the config knows nothing about, so the union adds nothing: advertising neither
  // level leaves it at its own default rather than a substituted one. (luna cannot show this
  // -- modelRefForTier unions the CONFIGURED list in, and the fixture declares `low` for it,
  // which is the documented behaviour and not a leak.)
  assert.equal(R.modelRefForTier({ providerID: "openai", modelID: "gpt-imaginary" }, "classifier",
    { "openai/gpt-imaginary": ["high"] }).variant,
    undefined, "never substitute an unrequested effort -- the model runs at its own default");
});

const BUDGET_CONFIG = {
  "provider-a": { windows: [{ id: "5h", periodMs: 5 * 3600_000, meter: "requests", capacity: 100 }] },
  "provider-b": { windows: [
    { id: "5h", periodMs: 5 * 3600_000, meter: "requests", capacity: 100 },
    { id: "week", periodMs: 7 * 86_400_000, meter: "tokens", capacity: 1_000_000 },
  ] },
};

test("budget usage accumulates, binds on the worst window, and rolls over", () => {
  const now = 1_000_000;
  let budgets = {};
  for (let i = 0; i < 30; i++) {
    budgets = R.recordBudgetUsage(budgets, "provider-b", { requests: 1, tokens: { input: 20_000, output: 5_000 } }, now, BUDGET_CONFIG);
  }
  // 30/100 requests but 750k/1M tokens: tokens are the binding constraint.
  assert.equal(R.budgetUtilization(budgets, "provider-b", now, BUDGET_CONFIG), 0.75);
  // The 5h window rolls, the weekly one keeps counting.
  const later = now + 6 * 3600_000;
  budgets = R.recordBudgetUsage(budgets, "provider-b", { requests: 1, tokens: {} }, later, BUDGET_CONFIG);
  const report = R.budgetReport(budgets, later, BUDGET_CONFIG)["provider-b"];
  assert.equal(report.windows[0].spent, 1);
  assert.equal(report.windows[1].spent, 750_000);
  // Cache reads count at a discount.
  const cached = R.recordBudgetUsage({}, "provider-b", { requests: 0, tokens: { cacheRead: 100_000 } }, now, BUDGET_CONFIG);
  assert.equal(R.budgetReport(cached, now, BUDGET_CONFIG)["provider-b"].windows[1].spent, 10_000);
  // Unknown provider is a no-op with zero utilization.
  assert.equal(R.budgetUtilization({}, "llamacpp", now, BUDGET_CONFIG), 0);
});

test("chooseTarget spends where the most headroom is left", () => {
  const targets = {
    "a-worker": { id: "a-worker", providerID: "provider-a", modelID: "model-a", kind: "cloud", capacity: null },
    "b-worker": { id: "b-worker", providerID: "provider-b", modelID: "model-b", kind: "cloud", capacity: null },
  };
  const ids = ["a-worker", "b-worker"];
  const originalFor = R.targetIDsFor;
  const pick = (budgets, cursors = {}) => R.chooseTarget({
    profile: "auto", tier: "worker", cursors, budgets, budgetConfig: BUDGET_CONFIG,
    targets, now: 1_000_000,
  });
  // targetIDsFor doesn't know these ids; feed them through inventory-style targets with tiers.
  targets["a-worker"].source = "subscription-oauth"; targets["a-worker"].tiers = ["worker"];
  targets["b-worker"].source = "subscription-oauth"; targets["b-worker"].tiers = ["worker"];
  let budgets = {};
  for (let i = 0; i < 60; i++) budgets = R.recordBudgetUsage(budgets, "provider-a", { requests: 1 }, 1_000_000, BUDGET_CONFIG);
  // provider-a at 60%, provider-b at 0%: every lease goes to b until it catches up.
  assert.equal(pick(budgets).target.id, "b-worker");
  assert.equal(pick(budgets, { "auto:worker:cloud": 1 }).target.id, "b-worker");
  // Balanced providers rotate on the cursor again.
  for (let i = 0; i < 60; i++) budgets = R.recordBudgetUsage(budgets, "provider-b", { requests: 1 }, 1_000_000, BUDGET_CONFIG);
  const first = pick(budgets, { "auto:worker:cloud": 0 }).target.id;
  const second = pick(budgets, { "auto:worker:cloud": 1 }).target.id;
  assert.notEqual(first, second);
  // An estimated saturated provider remains eligible, but the least-observed provider
  // still wins. Only a provider quota circuit proves actual exhaustion.
  for (let i = 0; i < 40; i++) budgets = R.recordBudgetUsage(budgets, "provider-a", { requests: 1 }, 1_000_000, BUDGET_CONFIG);
  assert.equal(pick(budgets).target.id, "b-worker");
  assert.equal(pick(budgets, { "auto:worker:cloud": 1 }).target.id, "b-worker");
  assert.equal(originalFor, R.targetIDsFor);
});

test("fallback markers round-trip and clear", async () => {
  const originalHome = process.env.HOME;
  const { mkdtempSync: mkTmp, rmSync: rmTmp } = await import("node:fs");
  const { tmpdir: tmpD } = await import("node:os");
  const { join: joinP } = await import("node:path");
  const home = mkTmp(joinP(tmpD(), "router-fallback-"));
  process.env.HOME = home;
  try {
    // State paths bind at import time, so exercise against the live module's dir
    // via a fresh session id instead of a fake HOME -- write, read, remove.
    process.env.HOME = originalHome;
    const id = `test-fallback-${Date.now()}`;
    assert.equal(R.writeFallbackMarker(id, { policy: "strict-fallback", targetID: "gpt-terra", reasons: ["only-eligible-target"] }), true);
    const marker = R.readFallbackMarker(id);
    assert.equal(marker.targetID, "gpt-terra");
    assert.equal(marker.policy, "strict-fallback");
    R.removeFallbackMarker(id);
    assert.equal(R.readFallbackMarker(id), null);
    assert.equal(R.writeFallbackMarker("../escape", {}), false, "invalid session ids are refused");
  } finally {
    process.env.HOME = originalHome;
    rmTmp(home, { recursive: true, force: true });
  }
});

// Context overflow is a FIT problem, not a provider fault. Before this was
// classified it fell through to "other" and could fence llama.cpp -- the lane
// behind EVERY local target -- over a single oversized session. Real messages
// observed 2026-09-02: grunt at 35,672 / 41,022 and scout at 42,045 tokens.
test("context overflow is classified as 'context', never as a provider fault", () => {
  const real = [
    "request (35672 tokens) exceeds the available context size (32768 tokens), try increasing it",
    "request (42045 tokens) exceeds the available context size (32768 tokens), try increasing it",
    "This model's maximum context length is 32768 tokens",
    "context_length_exceeded",
    "prompt is too long: 51000 tokens > 32768 maximum",
  ];
  for (const message of real) {
    assert.equal(R.classifyRoutingFailure(new Error(message)), "context", message);
  }
  // and it must not swallow the classes that DO indict a provider
  assert.equal(R.classifyRoutingFailure(new Error("Our servers are currently overloaded")), "overload");
  assert.equal(R.classifyRoutingFailure(new Error("429 rate limit exceeded")), "rate");
  assert.equal(R.classifyRoutingFailure(new Error("exceeded your current quota")), "quota");
});

test("the classifier gate runs LOCAL-first and degrades to the cloud lane, never closed", () => {
  const now = Date.now();
  const open = { until: now + 600_000, openedAt: now };
  const loaded = new Set(["qwen3.5-4b"]);
  // What the guard leases with: system prompt + one cwd + one command.
  const contextTokens = 1100;
  const pick = (o = {}) => R.chooseTarget({
    profile: "auto", tier: "classifier", localModels: loaded, contextTokens, now, ...o,
  });

  // Steady state: one model, always. That is the whole point -- the same command gets
  // the same verdict, it costs nothing, and the command text stays on the LAN.
  assert.equal(pick().target.id, "local-classifier");
  assert.notEqual(pick().decision.policy, "strict-fallback");
  // A cloud subscription being circuited is irrelevant to a local primary.
  assert.equal(pick({ circuits: { "provider:anthropic": open } }).target.id, "local-classifier");

  // llama.cpp down or the model unloaded: eligible() fails on the loaded-model set and
  // the cloud lane picks it up, rather than the gate failing closed on every command.
  const down = pick({ localModels: new Set() });
  assert.equal(down.target.id, "haiku");
  assert.equal(down.decision.policy, "strict-fallback");

  // Both local slots busy: same relief path, so a burst of commands queues on the cloud
  // instead of being denied.
  const busy = pick({ active: { "local-classifier": 2 } });
  assert.equal(busy.target.id, "haiku");
  assert.equal(busy.decision.policy, "strict-fallback");

  // A caller that declares no size cannot use a local target (localContextEligible
  // refuses a null estimate). It must still get a verdict, not a refusal.
  const noSize = R.chooseTarget({ profile: "auto", tier: "classifier", localModels: loaded, now });
  assert.equal(noSize.target.id, "haiku");
});

// ☠️ A forward swap evicts whatever is resident, so when two consumers want different models
// one of them loses a live conversation mid-sentence. This pins WHO yields. The gateway's
// clients (a chat UI, a voice assistant) have a person or a device waiting on the other end
// and cannot re-route, so they never yield; an opencode session can wait, and does.
test("only the gateway may take the GPUs from a live conversation", async () => {
  const R = await import("../lib/routing.js");
  assert.equal(R.swapRequesterYields({ sessionID: "gw-mtinum5y-mgcrvm" }), false,
    "☠️ a gateway client's request must never be made to wait");
  assert.equal(R.swapRequesterYields({ sessionID: "ses_f839f46b8ffeTGrFnC5wOD8tFY" }), true,
    "an opencode session yields to whatever is using the GPU");
  // Unknown provenance yields: the safe direction is to wait, not to evict.
  assert.equal(R.swapRequesterYields({}), true);
  assert.equal(R.swapRequesterYields({ sessionID: "" }), true);
  // ☠️ Not a loose substring match -- a session merely CONTAINING "gw-" is not the gateway.
  assert.equal(R.swapRequesterYields({ sessionID: "ses_gw-not-the-gateway" }), true);
});

// ☠️ The classifier lane is deliberately NOT routed -- its agent is pinned in frontmatter and
// overriding that pin was its own bug -- so applyMessageModel returns early and nothing on that
// path ever touched the message. The lane's configured reasoning effort therefore reached
// nothing, and a thinking model ran at its default: 155 empty responses in 161 gpt-luna leases,
// each failing an ordinary command CLOSED. This pins that the EFFORT still arrives while the
// PIN is left alone.
test("a classifier lane keeps its pinned model and takes only the tier's reasoning effort", async () => {
  const { applyClassifierVariant } = await import("../lib/router-core.js");

  const message = { model: { providerID: "openai", modelID: "gpt-5.6-luna" } };
  const applied = applyClassifierVariant(message, { "openai/gpt-5.6-luna": ["none", "low"] });
  assert.equal(applied, "none");
  assert.equal(message.model.providerID, "openai", "☠️ the agent's pin must survive untouched");
  assert.equal(message.model.modelID, "gpt-5.6-luna", "☠️ the agent's pin must survive untouched");
  assert.equal(message.model.variant, "none");

  // A model offering neither level is left entirely alone rather than given a substitute.
  const plain = { model: { providerID: "openai", modelID: "gpt-imaginary" } };
  assert.equal(applyClassifierVariant(plain, { "openai/gpt-imaginary": ["high"] }), null);
  assert.equal(plain.model.variant, undefined);

  // Idempotent: re-applying the same effort is not a change worth reporting.
  assert.equal(applyClassifierVariant(message, { "openai/gpt-5.6-luna": ["none"] }), null);

  // Never throws on a message with no model to speak of.
  assert.equal(applyClassifierVariant(undefined), null);
  assert.equal(applyClassifierVariant({}), null);
  assert.equal(applyClassifierVariant({ model: {} }), null);
});
