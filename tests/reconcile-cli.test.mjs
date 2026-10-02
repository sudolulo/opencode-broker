import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The CLI is exercised as a SPAWNED PROCESS, never by importing its module. Every isolation
// promise Package 1 makes is a property of the process environment -- which XDG_CACHE_HOME the
// refresh child inherits, which routing-state root the ledger lands in, which config file was
// read -- and lib/config.js and lib/routing.js each resolve their paths once at import. A test
// that imported the CLI would be asserting about this test runner's environment instead.
const CLI = new URL("../bin/opencode-broker-reconcile", import.meta.url).pathname;

const HOUR = 3600_000;

// The September 2026 catalog condition the design names: GPT-6 Sol has shipped past the pinned
// 5.6, and Anthropic has moved Opus 5 -> 5.5.
const SCRATCH_CATALOG = Object.freeze({
  openai: {
    id: "openai",
    models: {
      "gpt-5.6-sol": { id: "gpt-5.6-sol", family: "gpt-sol", release_date: "2026-02-10", status: "active", tool_call: true },
      "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", status: "active", tool_call: true },
    },
  },
  anthropic: {
    id: "anthropic",
    models: {
      "claude-opus-5": { id: "claude-opus-5", family: "claude-opus", release_date: "2026-08-20", status: "active", tool_call: true },
      "claude-opus-5-5": { id: "claude-opus-5-5", family: "claude-opus", release_date: "2026-09-18", status: "active", tool_call: true },
    },
  },
});

// A DIFFERENT catalog on the live cache path, so every assertion can tell which source answered:
// a run that read the live cache instead of its scratch refresh reports no gpt-6-sol at all.
const LIVE_CATALOG = Object.freeze({
  anthropic: {
    id: "anthropic",
    models: {
      "claude-opus-4-8": { id: "claude-opus-4-8", family: "claude-opus", release_date: "2026-01-05", status: "active", tool_call: true },
    },
  },
});

// CRITICAL: openai/gpt-6-sol is DELIBERATELY ABSENT. It is in the catalog and the host cannot
// address it -- the live September 2026 condition -- so it must be reported blocked-unresolvable
// rather than proposed as a target, which is the failure that took a tier down on 2026-09-22.
const PURE_KEYS = Object.freeze([
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5-5",
  "openai/gpt-5.6-sol",
]);

const CONFIG_FIXTURE = Object.freeze({
  targets: {
    sol: { providerID: "openai", modelID: "gpt-5.6-sol", kind: "cloud", fit: { smart: 1.4 } },
    opus: { providerID: "anthropic", modelID: "claude-opus-5", kind: "cloud", fit: { smart: 1.4 } },
  },
  tiers: { smart: ["sol", "opus"] },
});

// A fake `opencode` that behaves like the real one in the only two ways the collector uses it:
// `models` rewrites the catalog under whatever XDG_CACHE_HOME it was handed, and `models --pure`
// prints resolvable references on stdout.
const fakeOpencode = (catalogPath, purePath) => `#!/bin/sh
if [ "$1" = "models" ] && [ "$2" = "--pure" ]; then
  cat '${purePath}'
  exit 0
fi
if [ "$1" = "models" ] && [ -z "$2" ]; then
  mkdir -p "$XDG_CACHE_HOME/opencode"
  cp '${catalogPath}' "$XDG_CACHE_HOME/opencode/models.json"
  exit 0
fi
echo "fake opencode: unexpected invocation: $*" >&2
exit 1
`;

const BROKEN_OPENCODE = `#!/bin/sh
echo "opencode: unable to start" >&2
exit 127
`;

const build = (name, {
  catalog = SCRATCH_CATALOG,
  pure = PURE_KEYS.join("\n") + "\n",
  broken = false,
  liveCache = LIVE_CATALOG,
  config = CONFIG_FIXTURE,
  applyEnabled = false,
} = {}) => {
  const base = mkdtempSync(join(tmpdir(), `reconcile-cli-${name}-`));
  const home = join(base, "home");
  const stateRoot = join(base, "state");
  const liveCacheRoot = join(base, "live-cache");
  const configRoot = join(base, "config");
  const fakeBin = join(base, "bin");

  // OAuth auth metadata, which is what admits openai and anthropic to the reconciler at all.
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(join(home, ".local/share/opencode/auth.json"),
    JSON.stringify({ openai: { type: "oauth" }, anthropic: { type: "oauth" } }) + "\n");

  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const liveResolverPath = join(stateRoot, "resolvable-models.json");
  writeFileSync(liveResolverPath,
    JSON.stringify({ updatedAt: Date.now() - 4 * HOUR, models: ["anthropic/claude-opus-4-8"] }) + "\n");

  const liveCachePath = join(liveCacheRoot, "opencode/models.json");
  if (liveCache) {
    mkdirSync(dirname(liveCachePath), { recursive: true });
    writeFileSync(liveCachePath, JSON.stringify(liveCache) + "\n");
  }

  const configPath = join(configRoot, "opencode-broker/config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  const effectiveConfig = typeof config === "string" || !applyEnabled ? config : {
    ...config,
    trustedSubscriptionProviders: [...new Set([...(config.trustedSubscriptionProviders ?? []), "openai"])],
    reconcile: {
      ...(config.reconcile ?? {}),
      apply: {
        enabled: true,
        providers: ["openai"],
        overlayPath: join(stateRoot, "resolver-overlay.json"),
        generationsRoot: join(stateRoot, "generations"),
        currentLinkPath: join(stateRoot, "generations/current"),
      },
    },
  };
  writeFileSync(configPath, typeof effectiveConfig === "string" ? effectiveConfig : JSON.stringify(effectiveConfig));

  const catalogPath = join(base, "fake-catalog.json");
  const purePath = join(base, "fake-pure.txt");
  writeFileSync(catalogPath, JSON.stringify(catalog));
  writeFileSync(purePath, pure);
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "opencode"),
    broken ? BROKEN_OPENCODE : fakeOpencode(catalogPath, purePath), { mode: 0o755 });

  return {
    base, home, stateRoot, liveCacheRoot, liveCachePath, liveResolverPath,
    configRoot, configPath, fakeBin, statePath: join(stateRoot, "model-reconciliation.json"),
  };
};

const withFixture = (name, run, options) => {
  const fixture = build(name, options);
  try {
    return run(fixture);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
};

// Inherited OPENCODE_* and XDG_* variables are stripped: this suite runs on a host that has a
// real broker config, a real routing state root and a real models.dev cache, and any one of them
// leaking in would make the test either pass for the wrong reason or write to live state.
const runCLI = (fixture, args, extraEnv = {}) => {
  const clean = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...clean,
      HOME: fixture.home,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      OPENCODE_MODEL_ROUTING_DIR: fixture.stateRoot,
      XDG_CACHE_HOME: fixture.liveCacheRoot,
      XDG_CONFIG_HOME: fixture.configRoot,
      OPENCODE_BROKER_CONFIG: fixture.configPath,
      ...extraEnv,
    },
  });
};

// ---- proposal lifecycle fixtures ---------------------------------------------------------------
// The decision commands act on a ledger that ALREADY holds an awaiting-approval proposal, and
// reaching that state through a dry run would need collected evidence, a gateway and a researcher.
// Seeding the ledger directly is what keeps these tests about the decision surface.
const TRANSITION_ID = "a1b2c3d4e5f60718293a4b5c";
const UNKNOWN_TRANSITION_ID = "0f1e2d3c4b5a69788796a5b4";

// Exactly the shape lib/model-reconcile.js writes for a role record that evidence has carried to
// `awaiting-approval`: a contradiction is one of the conditions that lands there.
const AWAITING_ROLE_RECORD = Object.freeze({
  transitionID: TRANSITION_ID,
  roleKey: "openai:gpt-sol",
  providerID: "openai",
  roleID: "gpt-sol",
  candidateModelID: "gpt-6-sol",
  candidateFamily: "gpt-sol",
  candidateReleaseDate: "2026-09-22",
  candidateVersion: "6",
  incumbentModelID: "gpt-5.6-sol",
  proposedTiers: Object.freeze(["smart"]),
  proposedFit: Object.freeze({}),
  state: "awaiting-approval",
  reason: "the collected evidence contradicts itself",
  stateChangedAt: 1,
  lastObservedAt: 1,
  transitions: Object.freeze(["discovered", "evidence-pending", "awaiting-approval"]),
  evidence: Object.freeze([]),
  evidenceRevision: null,
  evidenceCollectedAt: null,
  evidenceContradiction: true,
  approval: null,
  issue: null,
  notified: null,
});

// An unknown candidate: no roleKey and no proposedTiers, because Package 1 refuses to invent them.
const UNMAPPED_RECORD = Object.freeze({
  transitionID: UNKNOWN_TRANSITION_ID,
  groupKey: "openai:gpt-nova",
  providerID: "openai",
  modelID: "gpt-1-nova",
  family: "gpt-nova",
  roleStatus: "unknown",
  roleMatches: Object.freeze([]),
  releaseDate: "2026-09-20",
  version: "1",
  state: "awaiting-approval",
  reason: "the candidate is not mapped to a known role",
  stateChangedAt: 1,
  lastObservedAt: 1,
  transitions: Object.freeze(["discovered", "evidence-pending", "awaiting-approval"]),
  evidence: Object.freeze([]),
  evidenceRevision: null,
  evidenceCollectedAt: null,
  evidenceContradiction: false,
  approval: null,
  issue: null,
  notified: null,
});

const seedLedger = (fixture, { roles = {}, unknown = {}, evidenceRequests = {} } = {}) => {
  writeFileSync(fixture.statePath,
    JSON.stringify({ version: 1, updatedAt: 1, roles, unknown, evidenceRequests }) + "\n", { mode: 0o600 });
};

const seedAwaitingApproval = (fixture, overrides = {}) =>
  seedLedger(fixture, { roles: { "openai:gpt-sol": { ...AWAITING_ROLE_RECORD, ...overrides } } });

const readLedger = (fixture) => JSON.parse(readFileSync(fixture.statePath, "utf8"));

// CRITICAL: A DRY RUN THAT MOVED EITHER LIVE INPUT WOULD NOT BE A DRY RUN. `opencode models`
// rewrites the models.dev cache in place and the resolver refresh rewrites
// resolvable-models.json; either one changes what the NEXT prompt's cached publication admits,
// from a command whose whole promise is that it changes nothing. Pinned by bytes and by mtime
// through the real subprocess, which is the only place the environment plumbing can be wrong.
test("dry-run JSON is machine-readable and cannot touch live routing inputs", () => {
  withFixture("dry-run-json", (fixture) => {
    const liveCacheBefore = readFileSync(fixture.liveCachePath);
    const liveResolverBefore = readFileSync(fixture.liveResolverPath);
    const liveCacheMtime = statSync(fixture.liveCachePath).mtimeMs;
    const liveResolverMtime = statSync(fixture.liveResolverPath).mtimeMs;

    const result = runCLI(fixture, ["dry-run", "--json"]);
    assert.equal(result.status, 0, result.stderr);

    const report = JSON.parse(result.stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.effects.inventoryPublished, false);
    assert.equal(report.effects.routingMutated, false);
    assert.equal(report.effects.externalPublished, false);
    assert.equal(report.effects.ledgerWritten, true);
    // The scratch refresh answered, not the live cache -- gpt-6-sol exists only in the former.
    assert.equal(report.sources.catalog.source, "scratch");
    assert.equal(report.sources.catalog.refreshed, true);
    assert.equal(report.sources.resolver.source, "scratch");
    assert.equal(report.sources.resolver.refreshed, true);
    assert.equal(report.sources.catalog.stale, false);
    assert.equal(report.sources.resolver.stale, false);
    assert.equal(report.authRevisionChanged, false);
    assert.deepEqual(report.providerIDs, ["anthropic", "openai"]);

    // The cataloged model this host cannot address is blocked, never proposed.
    assert.equal(report.byModel["openai/gpt-6-sol"].state, "blocked-unresolvable");
    assert.equal(report.byModel["openai/gpt-6-sol"].roleKey, "openai:gpt-sol");
    assert.equal(report.byModel["openai/gpt-6-sol"].incumbentModelID, "gpt-5.6-sol");
    assert.equal(report.byModel["anthropic/claude-opus-5-5"].state, "evidence-pending");
    assert.deepEqual(report.counts, { "blocked-unresolvable": 1, "evidence-pending": 1 });
    assert.deepEqual(report.evidenceRequests, { pending: 1, claimed: 0, failed: 0 });

    assert.deepEqual(readFileSync(fixture.liveCachePath), liveCacheBefore);
    assert.deepEqual(readFileSync(fixture.liveResolverPath), liveResolverBefore);
    assert.equal(statSync(fixture.liveCachePath).mtimeMs, liveCacheMtime);
    assert.equal(statSync(fixture.liveResolverPath).mtimeMs, liveResolverMtime);

    // The ledger is the ONE thing written, and the lock it was written under is gone.
    assert.equal(existsSync(fixture.statePath), true);
    assert.deepEqual(readdirSync(fixture.stateRoot).sort(),
      ["model-reconciliation.json", "resolvable-models.json"]);
    const ledger = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    assert.equal(ledger.version, 2);
    assert.deepEqual(Object.keys(ledger.roles).sort(), ["anthropic:claude-opus", "openai:gpt-sol"]);
    assert.equal(Object.keys(ledger.evidenceRequests).length, 1);
    assert.equal(statSync(fixture.statePath).mode & 0o777, 0o600);

    // Exactly one trailing newline, so the output pipes into jq and into a file diff cleanly.
    assert.ok(result.stdout.endsWith("}\n"), JSON.stringify(result.stdout.slice(-8)));
    assert.equal(result.stdout.endsWith("\n\n"), false);
  });
});

// Package 1 talks to NOTHING. No broker socket, no ntfy, no Gitea -- those are Packages 2-4, and
// each of them is what makes publication safe, so any of them firing here would act on a
// candidate no human has looked at.
test("a dry run contacts no broker, no ntfy and no Gitea", () => {
  withFixture("no-egress", (fixture) => {
    const result = runCLI(fixture, ["dry-run", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const output = `${result.stdout}\n${result.stderr}`;
    for (const pattern of [/ntfy/i, /gitea/i, /broker\.sock/, /https?:\/\//, /inventory published/i]) {
      assert.equal(pattern.test(output), false, `${pattern} appeared in the CLI output`);
    }
    // No socket, no broker.json, no reviewed-models rewrite: only the ledger appeared.
    assert.deepEqual(readdirSync(fixture.stateRoot).sort(),
      ["model-reconciliation.json", "resolvable-models.json"]);
  });
});

test("dry-run without --json prints the human report", () => {
  withFixture("dry-run-human", (fixture) => {
    const result = runCLI(fixture, ["dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout,
      /^dry run: ledger written, inventory not published, routing not mutated, nothing published externally\n/);
    assert.match(result.stdout, /catalog: refreshed from scratch/);
    assert.match(result.stdout, /resolver: refreshed from scratch/);
    assert.match(result.stdout, /openai\/gpt-6-sol -> blocked-unresolvable \(openai:gpt-sol\)/);
    assert.match(result.stdout, /anthropic\/claude-opus-5-5 -> evidence-pending \(anthropic:claude-opus\)/);
    assert.match(result.stdout, /legacy reviewed-models import: /);
    assert.ok(result.stdout.endsWith("\n"));
    // Not JSON: the human formatter, not a serialized report.
    assert.throws(() => JSON.parse(result.stdout));
  });
});

test("status reports the ledger a dry run wrote", () => {
  withFixture("status", (fixture) => {
    assert.equal(runCLI(fixture, ["dry-run", "--json"]).status, 0);
    const stateBefore = readFileSync(fixture.statePath);

    const result = runCLI(fixture, ["status", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.exists, true);
    assert.equal(status.version, 2);
    assert.deepEqual(status.roles.map((role) => role.roleKey), ["anthropic:claude-opus", "openai:gpt-sol"]);
    assert.deepEqual(status.counts, { "blocked-unresolvable": 1, "evidence-pending": 1 });
    assert.ok(result.stdout.endsWith("\n"));

    const human = runCLI(fixture, ["status"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^reconciliation state v2, updated /);
    assert.match(human.stdout, /openai:gpt-sol -> blocked-unresolvable \(gpt-6-sol\)/);

    // status is a pure read: it neither rewrites the ledger nor takes the writer lock.
    assert.deepEqual(readFileSync(fixture.statePath), stateBefore);
    assert.deepEqual(readdirSync(fixture.stateRoot).sort(),
      ["model-reconciliation.json", "resolvable-models.json"]);
  });
});

// Nothing reconciled yet is an ANSWER, not an error, and it must not be answered by creating the
// file: a status command that wrote state would make "have you run this?" unanswerable.
test("status on a host that has never reconciled says so and creates nothing", () => {
  withFixture("status-missing", (fixture) => {
    const result = runCLI(fixture, ["status", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),
      { exists: false, version: null, updatedAt: null, counts: {}, roles: [], unknown: [] });

    const human = runCLI(fixture, ["status"]);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stdout, "no reconciliation state\n");
    assert.equal(existsSync(fixture.statePath), false);
  });
});

// A hand-edited or half-written ledger is an operator problem. Repairing it would destroy the
// only record of what was already decided, so both commands exit 1 with the bytes untouched.
test("a corrupt ledger exits 1 and is never repaired", () => {
  withFixture("corrupt", (fixture) => {
    writeFileSync(fixture.statePath, "{ not json\n");
    const before = readFileSync(fixture.statePath);

    const status = runCLI(fixture, ["status", "--json"]);
    assert.equal(status.status, 1);
    assert.equal(status.stdout, "");
    assert.match(status.stderr, /not valid reconciliation state JSON/);
    assert.match(status.stderr, /model-reconciliation\.json/);

    const dryRun = runCLI(fixture, ["dry-run", "--json"]);
    assert.equal(dryRun.status, 1);
    assert.match(dryRun.stderr, /not valid reconciliation state JSON/);
    assert.deepEqual(readFileSync(fixture.statePath), before);
  });
});

// With neither a refresh nor a readable live source there is no observation at all. Reporting
// candidates as blocked here would claim the reconciler looked at each model and found a problem
// with it, when in fact it never had a view to look at.
test("a failed refresh with no readable live fallback exits 1 with an actionable error", () => {
  withFixture("no-sources", (fixture) => {
    const result = runCLI(fixture, ["dry-run", "--json"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /unable to collect the OpenCode model catalog/);
    assert.match(result.stderr, /opencode models --refresh/);
    // No half-written observation: the ledger was never created.
    assert.equal(existsSync(fixture.statePath), false);
    assert.deepEqual(readdirSync(fixture.stateRoot).sort(), ["resolvable-models.json"]);
  }, { broken: true, liveCache: null });
});

// A config that failed to parse leaves routing with NO targets, which would make every cataloged
// model look like an unmapped novelty with no incumbent to beat. That is a run whose findings are
// all artifacts of the broken config, so it must refuse rather than report them.
test("an unparseable config exits 1 instead of reconciling against no targets", () => {
  withFixture("bad-config", (fixture) => {
    const result = runCLI(fixture, ["dry-run", "--json"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /config/i);
    assert.match(result.stderr, /config\.json/);
    assert.equal(existsSync(fixture.statePath), false);
  }, { config: "{ targets: oops\n" });
});

test("apply commands are present but disabled before source collection and write nothing", () => {
  withFixture("apply-disabled", (fixture) => {
    const before = new Map([
      [fixture.liveCachePath, { bytes: readFileSync(fixture.liveCachePath), mtime: statSync(fixture.liveCachePath).mtimeMs }],
      [fixture.liveResolverPath, { bytes: readFileSync(fixture.liveResolverPath), mtime: statSync(fixture.liveResolverPath).mtimeMs }],
    ]);
    for (const argv of [
      ["apply", TRANSITION_ID, "--json"],
      ["rollback", TRANSITION_ID, "--reason", "operator-request", "--json"],
      ["refresh", "--json"],
      ["recover", TRANSITION_ID, "--json"],
    ]) {
      const result = runCLI(fixture, argv);
      assert.equal(result.status, 1, `${argv.join(" ")}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        code: "reconcile-apply-disabled",
        mutated: false,
      });
      assert.equal(result.stderr, "");
    }
    assert.equal(existsSync(fixture.statePath), false);
    for (const [path, snapshot] of before) {
      assert.deepEqual(readFileSync(path), snapshot.bytes);
      assert.equal(statSync(path).mtimeMs, snapshot.mtime);
    }
  });
});

test("enabled apply refuses missing, non-regular, loose and empty gateway key files without leaking contents", () => {
  for (const keyCase of ["missing", "directory", "loose", "empty"]) {
    withFixture(`gateway-key-${keyCase}`, (fixture) => {
      const keyPath = join(fixture.base, `gateway-key-${keyCase}`);
      const sentinel = "reconciler-gateway-secret-must-not-leak";
      if (keyCase === "directory") mkdirSync(keyPath);
      if (keyCase === "loose") {
        writeFileSync(keyPath, `${sentinel}\n`, { mode: 0o644 });
        chmodSync(keyPath, 0o644);
      }
      if (keyCase === "empty") writeFileSync(keyPath, " \n", { mode: 0o600 });

      const result = runCLI(fixture, ["apply", TRANSITION_ID, "--json"], {
        OPENCODE_BROKER_GATEWAY_KEY_FILE: keyPath,
      });

      assert.equal(result.status, 1, `${keyCase}: ${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.includes(sentinel), false);
      assert.match(result.stderr, keyCase === "missing"
        ? /does not exist/
        : keyCase === "directory"
          ? /not a regular file/
          : keyCase === "loose"
            ? /mode 0644/
            : /is empty/);
    }, { applyEnabled: true });
  }
});

test("enabled apply uses the gateway key default under XDG_CONFIG_HOME", () => {
  withFixture("gateway-key-default", (fixture) => {
    const expectedPath = join(fixture.configRoot, "opencode-broker/gateway-key");
    const result = runCLI(fixture, ["apply", TRANSITION_ID, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.stderr, /does not exist/);
  }, { applyEnabled: true });
});

test("malformed apply commands exit 2 before the disabled gate", () => {
  withFixture("bad-command", (fixture) => {
    const result = runCLI(fixture, ["apply"]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /a transition id is required/);
    assert.match(result.stderr, /dry-run \[--json\]/);
    assert.match(result.stderr, /status \[--json\]/);
    assert.equal(existsSync(fixture.statePath), false);

    assert.equal(runCLI(fixture, ["rollback", TRANSITION_ID]).status, 2);
    assert.equal(runCLI(fixture, ["rollback", TRANSITION_ID, "--reason"]).status, 2);
    assert.equal(runCLI(fixture, ["refresh", TRANSITION_ID]).status, 2);
    assert.equal(runCLI(fixture, ["recover", TRANSITION_ID, "extra"]).status, 2);

    const missing = runCLI(fixture, []);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /dry-run \[--json\]/);
  });
});

// The flag surface is exactly `--json`, and an unrecognized flag is refused rather than ignored:
// a caller that typed `--apply` or `--publish` must never have it silently dropped and come away
// believing this command can do either.
test("an unknown option exits 2 without running the command", () => {
  withFixture("bad-option", (fixture) => {
    for (const flag of ["--publish", "--json=1", "-j"]) {
      const result = runCLI(fixture, ["dry-run", flag]);
      assert.equal(result.status, 2, `${flag} was not refused`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(`unknown option "${flag.replace("=", "=")}"`));
      assert.equal(existsSync(fixture.statePath), false);
    }
    const onStatus = runCLI(fixture, ["status", "--verbose"]);
    assert.equal(onStatus.status, 2);
    assert.match(onStatus.stderr, /unknown option "--verbose"/);
  });
});

// ---- the proposal lifecycle commands -------------------------------------------------------------

// BOTH PROJECTIONS SHIP OFF, and a fresh install must therefore perform no external write at all.
// `project` on that install is a completed run that did nothing, not an error and not a no-op that
// quietly wrote a marker.
test("project is a clean no-op when Gitea is disabled and no notifier is configured", () => {
  withFixture("project-disabled", (fixture) => {
    seedAwaitingApproval(fixture);
    const before = readFileSync(fixture.statePath);

    const result = runCLI(fixture, ["project", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.skipped, "gitea-disabled");
    assert.equal(report.gitea.skipped, "gitea-disabled");
    assert.equal(report.notify.skipped, "no-notify-command");
    // The whole ledger must never reach stdout: projectProposals() returns it, and printing it
    // would put evidence quotations and issue payloads into terminal scrollback and logs.
    assert.equal(Object.hasOwn(report, "state"), false);
    assert.equal(Object.hasOwn(report.gitea, "state"), false);

    assert.deepEqual(readFileSync(fixture.statePath), before);
  });
});

// `--dry-run` answers from the ledger alone: no forge request, no notifier subprocess, no write.
// A proposal whose issue is current can only be resolved by reading its labels, so it is reported
// as a check rather than as a decision this command could predict.
test("project --dry-run reports what each projection would do and writes nothing", () => {
  withFixture("project-plan", (fixture) => {
    seedAwaitingApproval(fixture);
    const before = readFileSync(fixture.statePath);

    const result = runCLI(fixture, ["project", "--dry-run", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.gitea.enabled, false);
    assert.deepEqual(report.gitea.create, [{ kind: "role", key: "openai:gpt-sol" }]);
    assert.deepEqual(report.gitea.close, []);
    assert.deepEqual(report.gitea.supersede, []);
    assert.deepEqual(report.gitea.check, []);
    assert.equal(report.notify.configured, false);
    // `proposal-opened` is structurally gated on an issue link, so a proposal that has never been
    // projected owes no push -- a notification with nothing actionable in it is worse than none.
    assert.deepEqual(report.notify.push, []);

    assert.deepEqual(readFileSync(fixture.statePath), before);
  });
});

// The local decision surface exists because an operator has to be able to decide a proposal while
// the forge is unreachable or the projection is still switched off. A decision is recorded ONCE:
// the second one is refused, rather than overwriting the first.
test("approve records a local decision and a decided proposal cannot be decided again", () => {
  withFixture("approve", (fixture) => {
    seedAwaitingApproval(fixture);

    const approved = runCLI(fixture, ["approve", TRANSITION_ID, "--note", "checked the release notes"]);
    assert.equal(approved.status, 0, approved.stderr);
    const record = readLedger(fixture).roles["openai:gpt-sol"];
    assert.equal(record.state, "approved");
    assert.equal(record.approval.decision, "approved");
    assert.equal(record.approval.source, "cli");
    assert.equal(record.approval.note, "checked the release notes");
    assert.equal(Number.isFinite(record.approval.at), true);
    assert.equal(record.transitions.at(-1), "approved");
    // Routing is untouched by a decision: it records policy in the ledger and nothing else.
    assert.deepEqual(readdirSync(fixture.stateRoot).sort(),
      ["model-reconciliation.json", "resolvable-models.json"]);

    const again = runCLI(fixture, ["reject", TRANSITION_ID]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /not awaiting-approval/);
    assert.equal(readLedger(fixture).roles["openai:gpt-sol"].approval.decision, "approved");
  });
});

test("reject records a local rejection with no note", () => {
  withFixture("reject", (fixture) => {
    seedAwaitingApproval(fixture);
    const result = runCLI(fixture, ["reject", TRANSITION_ID]);
    assert.equal(result.status, 0, result.stderr);
    const record = readLedger(fixture).roles["openai:gpt-sol"];
    assert.equal(record.state, "rejected");
    assert.equal(record.approval.decision, "rejected");
    assert.equal(record.approval.source, "cli");
    assert.equal(record.approval.note, null);
  });
});

// A decided proposal must not leave an open issue asking a human for a label nothing reads: a label
// applied to it afterwards would be a silent no-op. The pointer is MOVED so the next projection
// closes it, which is also why the decision does not clear it outright.
test("a local decision moves an open issue pointer so the projection can close it", () => {
  withFixture("decide-issue", (fixture) => {
    seedAwaitingApproval(fixture, {
      issue: {
        number: 77, url: "https://git.arch.fyi/opencode/opencode-broker/issues/77",
        revision: "stale", createdAt: 1, commentedAt: null, reopenedAt: null, refusedAt: null, closedAt: null,
      },
    });
    assert.equal(runCLI(fixture, ["reject", TRANSITION_ID]).status, 0);
    const record = readLedger(fixture).roles["openai:gpt-sol"];
    assert.equal(record.issue, null);
    assert.equal(record.supersededIssue.number, 77);
    assert.equal(record.supersededIssue.reason, "decided-rejected");
    assert.equal(record.supersededIssue.commentedAt, null);
  });
});

// An amendment is what an operator uses instead of editing the issue text, so it has to change the
// stored proposal AND invalidate the decision the old text was asking for.
test("amend changes the proposed tiers, clears the decision and bumps the proposal revision", () => {
  withFixture("amend", (fixture) => {
    seedAwaitingApproval(fixture, { approval: null });

    const result = runCLI(fixture, ["amend", TRANSITION_ID, "--tiers", "smart,build"]);
    assert.equal(result.status, 0, result.stderr);
    const record = readLedger(fixture).roles["openai:gpt-sol"];
    assert.deepEqual(record.proposedTiers, ["smart", "build"]);
    assert.equal(record.state, "awaiting-approval");
    assert.equal(record.approval, null);

    // A successful amend always moves the revision, so an amend that would change nothing is
    // refused rather than reported as a change that did not happen. A repeated tier carries no
    // meaning, so restating the same list with one is still nothing.
    const noop = runCLI(fixture, ["amend", TRANSITION_ID, "--tiers", "smart,build,build"]);
    assert.equal(noop.status, 1);
    assert.match(noop.stderr, /changes nothing/);
  });
});

// Tier order IS part of the proposal: the tier list is ordered, so a reordering is an amendment and
// has to supersede the open issue rather than reproduce its revision.
test("amend treats a reordering as a change", () => {
  withFixture("amend-order", (fixture) => {
    seedAwaitingApproval(fixture, { proposedTiers: ["smart", "build"] });
    assert.equal(runCLI(fixture, ["amend", TRANSITION_ID, "--tiers", "build,smart"]).status, 0);
    assert.deepEqual(readLedger(fixture).roles["openai:gpt-sol"].proposedTiers, ["build", "smart"]);
  });
});

// CRITICAL: NEITHER DECISION SURFACE MAY APPROVE A MAPPING THAT DOES NOT EXIST. An unknown
// candidate names no role and no tiers, so approving it would mean guessing both. The mapping is
// supplied by `amend`, and only then can the approval land.
test("approve refuses an unmapped candidate until amend supplies the role and tiers", () => {
  withFixture("approve-unmapped", (fixture) => {
    seedLedger(fixture, { unknown: { [UNKNOWN_TRANSITION_ID]: UNMAPPED_RECORD } });

    const refused = runCLI(fixture, ["approve", UNKNOWN_TRANSITION_ID]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /no role mapping is proposed/);
    assert.equal(readLedger(fixture).unknown[UNKNOWN_TRANSITION_ID].state, "awaiting-approval");
    assert.equal(readLedger(fixture).unknown[UNKNOWN_TRANSITION_ID].approval, null);

    const amended = runCLI(fixture,
      ["amend", UNKNOWN_TRANSITION_ID, "--role", "openai:gpt-sol", "--tiers", "smart"]);
    assert.equal(amended.status, 0, amended.stderr);
    assert.equal(runCLI(fixture, ["approve", UNKNOWN_TRANSITION_ID]).status, 0);
    const record = readLedger(fixture).unknown[UNKNOWN_TRANSITION_ID];
    assert.equal(record.state, "approved");
    assert.equal(record.roleKey, "openai:gpt-sol");
    assert.equal(record.roleID, "gpt-sol");
    assert.deepEqual(record.proposedTiers, ["smart"]);
  });
});

// A role that belongs to a different provider would route an OpenAI model into an Anthropic lane
// and judge its evidence against the wrong official domains.
test("amend refuses a role from another provider and a role this deployment does not define", () => {
  withFixture("amend-role-guard", (fixture) => {
    seedLedger(fixture, { unknown: { [UNKNOWN_TRANSITION_ID]: UNMAPPED_RECORD } });

    const wrongProvider = runCLI(fixture,
      ["amend", UNKNOWN_TRANSITION_ID, "--role", "anthropic:claude-opus", "--tiers", "smart"]);
    assert.equal(wrongProvider.status, 1);
    assert.match(wrongProvider.stderr, /provider/);

    const noSuchRole = runCLI(fixture,
      ["amend", UNKNOWN_TRANSITION_ID, "--role", "openai:gpt-imaginary", "--tiers", "smart"]);
    assert.equal(noSuchRole.status, 1);
    assert.match(noSuchRole.stderr, /openai:gpt-imaginary/);

    assert.equal(readLedger(fixture).unknown[UNKNOWN_TRANSITION_ID].roleKey, undefined);
  });
});

// A tier name the registry does not define is a command line that cannot be carried out, and
// accepting it would write a proposal whose approval promotes a model into a lane that does not
// exist -- silently, because routing would simply never read it.
test("amend refuses a tier the registry does not define", () => {
  withFixture("amend-bad-tier", (fixture) => {
    seedAwaitingApproval(fixture);
    const result = runCLI(fixture, ["amend", TRANSITION_ID, "--tiers", "smart,frobnicate"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /frobnicate/);
    assert.match(result.stderr, /classifier/);
    assert.deepEqual(readLedger(fixture).roles["openai:gpt-sol"].proposedTiers, ["smart"]);
  });
});

test("a decision on an unknown proposal exits 1 and a malformed command line exits 2", () => {
  withFixture("decide-usage", (fixture) => {
    seedAwaitingApproval(fixture);

    const missing = runCLI(fixture, ["approve", "ffffffffffffffffffffffff"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ffffffffffffffffffffffff/);

    assert.equal(runCLI(fixture, ["approve"]).status, 2);
    assert.equal(runCLI(fixture, ["amend", TRANSITION_ID]).status, 2);
    assert.equal(runCLI(fixture, ["amend", TRANSITION_ID, "--tiers"]).status, 2);
    assert.equal(runCLI(fixture, ["approve", TRANSITION_ID, "--note"]).status, 2);
    assert.equal(runCLI(fixture, ["frobnicate"]).status, 2);
    assert.equal(runCLI(fixture, ["project", "--apply"]).status, 2);

    // Not one of those attempts touched the record.
    assert.equal(readLedger(fixture).roles["openai:gpt-sol"].state, "awaiting-approval");
    assert.equal(readLedger(fixture).roles["openai:gpt-sol"].approval, null);
  });
});

// The queue is a diagnostic an operator prints routinely, so it must be a pure read: a status
// command that took the writer lock would block the collector it is being run to investigate.
test("evidence-status reports the queue without taking the writer lock", () => {
  withFixture("evidence-status", (fixture) => {
    const empty = runCLI(fixture, ["evidence-status", "--json"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), { requests: 0, pending: 0, claimed: 0, failed: 0 });
    // Nothing reconciled yet is an ANSWER, not a reason to create the ledger.
    assert.equal(existsSync(fixture.statePath), false);

    assert.equal(runCLI(fixture, ["dry-run", "--json"]).status, 0);
    const before = readFileSync(fixture.statePath);

    const result = runCLI(fixture, ["evidence-status", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(status).sort(), ["claimed", "failed", "pending", "requests"]);
    assert.deepEqual(status, { requests: 1, pending: 1, claimed: 0, failed: 0 });

    assert.deepEqual(readFileSync(fixture.statePath), before);
    assert.deepEqual(readdirSync(fixture.stateRoot).sort(),
      ["model-reconciliation.json", "resolvable-models.json"]);

    const human = runCLI(fixture, ["evidence-status"]);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stdout, "1 request, 1 pending, 0 claimed, 0 failed\n");
  });
});

// The Gitea token is the one credential in this package, and no command on this surface holds a
// reason to print it or to name the endpoint it would travel to.
test("no command prints a credential or names a network endpoint", () => {
  withFixture("no-credential", (fixture) => {
    seedAwaitingApproval(fixture);
    for (const argv of [
      ["status", "--json"],
      ["project", "--json"],
      ["project", "--dry-run", "--json"],
      ["evidence-status", "--json"],
      ["amend", TRANSITION_ID, "--tiers", "smart,build"],
      ["approve", TRANSITION_ID],
    ]) {
      const result = runCLI(fixture, argv);
      assert.equal(result.status, 0, `${argv.join(" ")}: ${result.stderr}`);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.doesNotMatch(output, /token|Authorization/i, argv.join(" "));
      assert.doesNotMatch(output, /https?:\/\//, argv.join(" "));
    }
  });
});
