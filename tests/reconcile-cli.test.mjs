import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));

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
const runCLI = (fixture, args) => {
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
    },
  });
};

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
    assert.equal(ledger.version, 1);
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
    assert.equal(status.version, 1);
    assert.deepEqual(status.roles.map((role) => role.roleKey), ["anthropic:claude-opus", "openai:gpt-sol"]);
    assert.deepEqual(status.counts, { "blocked-unresolvable": 1, "evidence-pending": 1 });
    assert.ok(result.stdout.endsWith("\n"));

    const human = runCLI(fixture, ["status"]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^reconciliation state v1, updated /);
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

test("an unknown command exits 2 with usage and writes nothing", () => {
  withFixture("bad-command", (fixture) => {
    const result = runCLI(fixture, ["apply"]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /unknown command "apply"/);
    assert.match(result.stderr, /dry-run \[--json\]/);
    assert.match(result.stderr, /status \[--json\]/);
    assert.equal(existsSync(fixture.statePath), false);

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
