import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Route the config loader at the fleet-shaped fixture BEFORE lib/routing.js loads through
// lib/model-reconcile.js -- config.js reads its file once at import time.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const {
  CATALOG_MAX_AGE_MS,
  RESOLVER_MAX_AGE_MS,
  assessSourceAge,
  collectDryRunSources,
} = await import(new URL("../lib/model-reconcile.js", import.meta.url).href);

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;

// Two DIFFERENT catalogs, so every assertion below can tell which source answered: a scratch
// refresh that silently read the live cache would hand back the anthropic one.
const SCRATCH_CATALOG = Object.freeze({
  openai: { id: "openai", models: { "gpt-6-sol": { id: "gpt-6-sol", family: "gpt-sol" } } },
});
const LIVE_CATALOG = Object.freeze({
  anthropic: { id: "anthropic", models: { "claude-opus-5": { id: "claude-opus-5", family: "claude-opus" } } },
});

const withSources = (name, run) => {
  const base = mkdtempSync(join(tmpdir(), `model-reconcile-${name}-`));
  const tmpRoot = join(base, "scratch");
  mkdirSync(tmpRoot);
  try {
    return run({
      base,
      tmpRoot,
      cachePath: join(base, "models.json"),
      resolverPath: join(base, "resolvable-models.json"),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

// The live catalog's age is its mtime, so a deterministic age needs a set mtime.
const setMtime = (path, ms) => utimesSync(path, new Date(ms), new Date(ms));

const writeLiveCatalog = (path, catalog = LIVE_CATALOG, ageMs = HOUR) => {
  writeFileSync(path, JSON.stringify(catalog) + "\n");
  setMtime(path, NOW - ageMs);
};

const writeLiveResolver = (path, models = ["anthropic/claude-opus-5"], ageMs = HOUR) => {
  writeFileSync(path, JSON.stringify({ updatedAt: NOW - ageMs, models }) + "\n");
};

// A refresh that succeeds: it writes the catalog where OpenCode would, under whatever
// XDG_CACHE_HOME it was handed, and prints one resolvable reference.
const refreshingExec = (catalog = SCRATCH_CATALOG, pureOutput = "openai/gpt-6-sol\n") =>
  (file, args, options) => {
    assert.equal(file, "opencode");
    const joined = args.join(" ");
    if (joined === "models") {
      const path = join(options.env.XDG_CACHE_HOME, "opencode/models.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof catalog === "string" ? catalog : JSON.stringify(catalog));
      return "";
    }
    if (joined === "models --pure") return pureOutput;
    throw new Error(`unexpected args: ${joined}`);
  };

const failingExec = (file, args) => { throw new Error(`opencode ${args.join(" ")}: not found`); };

const listTree = (root) => {
  const names = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      names.push(relative);
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
    }
  };
  walk(root, "");
  return names.sort();
};

// CRITICAL: A DRY RUN MUST NOT MOVE THE LIVE VIEW. `opencode models` rewrites the models.dev
// cache in place and refreshResolvableModels() rewrites resolvable-models.json; either one
// would change what the NEXT prompt's cached publication admits, from a run whose whole
// promise is that it changes nothing. The refresh therefore happens against a scratch
// XDG_CACHE_HOME and the resolver listing is parsed in memory, and this pins both by bytes
// and by mtime rather than by inspecting how it was done.
test("a successful dry-run refresh writes only below the scratch cache home", () => withSources("scratch", ({ tmpRoot, cachePath, resolverPath }) => {
  writeLiveCatalog(cachePath);
  writeLiveResolver(resolverPath);
  const liveCacheBefore = readFileSync(cachePath);
  const liveResolverBefore = readFileSync(resolverPath);
  const liveCacheMtime = statSync(cachePath).mtimeMs;
  const liveResolverMtime = statSync(resolverPath).mtimeMs;
  let scratchCacheHome = null;
  const refresh = refreshingExec();
  const sources = collectDryRunSources({
    liveCachePath: cachePath,
    liveResolverPath: resolverPath,
    tmpRoot,
    now: () => NOW,
    exec: (file, args, options) => {
      scratchCacheHome = options.env.XDG_CACHE_HOME;
      return refresh(file, args, options);
    },
  });

  assert.equal(sources.catalog.refreshed, true);
  assert.equal(sources.resolver.refreshed, true);
  assert.equal(sources.catalog.error, null);
  assert.equal(sources.resolver.error, null);
  // The refreshed catalog, not the live one.
  assert.deepEqual(sources.catalog.data, SCRATCH_CATALOG);
  assert.deepEqual([...sources.resolver.models], ["openai/gpt-6-sol"]);
  assert.equal(sources.catalog.stale, false);
  assert.equal(sources.resolver.stale, false);

  assert.deepEqual(readFileSync(cachePath), liveCacheBefore);
  assert.deepEqual(readFileSync(resolverPath), liveResolverBefore);
  assert.equal(statSync(cachePath).mtimeMs, liveCacheMtime);
  assert.equal(statSync(resolverPath).mtimeMs, liveResolverMtime);

  // The scratch tree was under the injected root, and it is gone.
  assert.ok(scratchCacheHome.startsWith(`${tmpRoot}/`), `${scratchCacheHome} is not under ${tmpRoot}`);
  assert.equal(existsSync(scratchCacheHome), false);
  assert.deepEqual(readdirSync(tmpRoot), []);
}));

// The refresh runs a subprocess that would happily read a credential store if the environment
// pointed it at one, and the scratch tree is deleted after the run -- so the only auth-safe
// shape is: nothing about auth is copied anywhere, and nothing but XDG_CACHE_HOME is altered.
// A collector that "helpfully" staged a copy of the auth store, or redirected HOME, breaks here.
test("the scratch environment differs only in XDG_CACHE_HOME and holds no auth material", () => withSources("auth", ({ base, tmpRoot, cachePath, resolverPath }) => {
  writeLiveCatalog(cachePath);
  writeLiveResolver(resolverPath);
  const home = join(base, "home");
  const authDir = join(home, ".local/share/opencode");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ openai: { type: "oauth", refresh: "not-a-real-token" } }));
  const env = Object.freeze({ PATH: "/usr/bin:/bin", HOME: home, XDG_CACHE_HOME: join(base, "live-cache") });
  const childEnvs = [];
  const scratchTrees = [];
  const refresh = refreshingExec();
  collectDryRunSources({
    liveCachePath: cachePath,
    liveResolverPath: resolverPath,
    tmpRoot,
    now: () => NOW,
    env,
    exec: (file, args, options) => {
      childEnvs.push(options.env);
      scratchTrees.push(listTree(dirname(options.env.XDG_CACHE_HOME)));
      return refresh(file, args, options);
    },
  });

  assert.equal(childEnvs.length, 2, "both the catalog and the resolver refresh ran");
  for (const childEnv of childEnvs) {
    assert.notEqual(childEnv.XDG_CACHE_HOME, env.XDG_CACHE_HOME, "the live cache home was replaced");
    // Everything else is the caller's environment, untouched.
    assert.deepEqual({ ...childEnv, XDG_CACHE_HOME: "<scratch>" }, { ...env, XDG_CACHE_HOME: "<scratch>" });
  }
  for (const tree of scratchTrees) {
    assert.deepEqual(tree.filter((entry) => /auth/i.test(entry)), []);
  }
  // The credential store itself was neither moved nor rewritten.
  assert.deepEqual(JSON.parse(readFileSync(join(authDir, "auth.json"), "utf8")),
    { openai: { type: "oauth", refresh: "not-a-real-token" } });
}));

// A failed refresh is not a dead run: stale observation still produces findings, and the stale
// gate in a later package is what withholds activation. What it must never do is repair the
// live view on the way past -- the fallback is strictly a read.
test("a failed refresh falls back to the live sources read-only and reports why", () => withSources("fallback", ({ tmpRoot, cachePath, resolverPath }) => {
  writeLiveCatalog(cachePath, LIVE_CATALOG, 2 * HOUR);
  // "bad key" is not a model reference: the snapshot whitelist still applies on the read path.
  writeLiveResolver(resolverPath, ["anthropic/claude-opus-5", "bad key"], 3 * HOUR);
  const cacheBefore = readFileSync(cachePath);
  const resolverBefore = readFileSync(resolverPath);
  const cacheMtime = statSync(cachePath).mtimeMs;
  const resolverMtime = statSync(resolverPath).mtimeMs;

  const sources = collectDryRunSources({
    liveCachePath: cachePath,
    liveResolverPath: resolverPath,
    tmpRoot,
    now: () => NOW,
    exec: failingExec,
  });

  assert.equal(sources.catalog.refreshed, false);
  assert.equal(sources.catalog.source, "live");
  assert.equal(sources.catalog.path, cachePath);
  assert.match(sources.catalog.error, /opencode models: not found/);
  assert.deepEqual(sources.catalog.data, LIVE_CATALOG);
  assert.equal(sources.catalog.updatedAt, NOW - 2 * HOUR);
  assert.equal(sources.catalog.ageMs, 2 * HOUR);
  assert.equal(sources.catalog.stale, false);

  assert.equal(sources.resolver.refreshed, false);
  assert.equal(sources.resolver.source, "live");
  assert.equal(sources.resolver.path, resolverPath);
  assert.match(sources.resolver.error, /opencode models --pure: not found/);
  assert.deepEqual([...sources.resolver.models], ["anthropic/claude-opus-5"]);
  assert.equal(sources.resolver.updatedAt, NOW - 3 * HOUR);
  assert.equal(sources.resolver.ageMs, 3 * HOUR);
  assert.equal(sources.resolver.stale, false);

  assert.deepEqual(readFileSync(cachePath), cacheBefore);
  assert.deepEqual(readFileSync(resolverPath), resolverBefore);
  assert.equal(statSync(cachePath).mtimeMs, cacheMtime);
  assert.equal(statSync(resolverPath).mtimeMs, resolverMtime);
  // The scratch root is swept on the failure path too.
  assert.deepEqual(readdirSync(tmpRoot), []);
}));

// A refresh that exits 0 and leaves something that is not a catalog is a FAILED refresh. Taking
// it at face value would hand an array or a string to the inventory builder as "the catalog",
// and every provider would silently vanish from the proposal.
test("a refresh that leaves an unusable catalog behind falls back instead of proposing junk", () => withSources("junk", ({ tmpRoot, cachePath, resolverPath }) => {
  writeLiveCatalog(cachePath);
  writeLiveResolver(resolverPath);
  const sources = collectDryRunSources({
    liveCachePath: cachePath,
    liveResolverPath: resolverPath,
    tmpRoot,
    now: () => NOW,
    exec: refreshingExec("[]"),
  });
  assert.equal(sources.catalog.refreshed, false);
  assert.equal(sources.catalog.source, "live");
  assert.match(sources.catalog.error, /catalog/);
  assert.deepEqual(sources.catalog.data, LIVE_CATALOG);
  // The resolver refresh is independent and still succeeded.
  assert.equal(sources.resolver.refreshed, true);
  assert.deepEqual([...sources.resolver.models], ["openai/gpt-6-sol"]);
}));

// CRITICAL: EMPTY IS A FINDING, NOT A FAILURE. A catalog with no providers and a resolver
// listing with no models are exactly the conditions the mutation gate refuses activation on, so
// they have to arrive as an explicit, FRESH observation. Collapsing them into an exception (or
// into a stale fallback read) loses the one fact the run needed to report.
test("an empty refreshed catalog and an empty resolver listing are reported, not thrown", () => withSources("empty", ({ tmpRoot, cachePath, resolverPath }) => {
  writeLiveCatalog(cachePath);
  writeLiveResolver(resolverPath);
  const sources = collectDryRunSources({
    liveCachePath: cachePath,
    liveResolverPath: resolverPath,
    tmpRoot,
    now: () => NOW,
    exec: refreshingExec({}, "\nnot a model key\n"),
  });
  assert.equal(sources.catalog.refreshed, true);
  assert.equal(sources.catalog.empty, true);
  assert.deepEqual(sources.catalog.data, {});
  assert.equal(sources.resolver.refreshed, true);
  assert.equal(sources.resolver.empty, true);
  assert.equal(sources.resolver.models.size, 0);
  assert.equal(sources.catalog.stale, false);
  assert.equal(sources.resolver.stale, false);
  // The live sources were never consulted, so the emptiness is genuinely the refresh's.
  assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), LIVE_CATALOG);
  assert.equal(sources.catalog.source, "scratch");
  assert.equal(sources.resolver.source, "scratch");
}));

// With neither a refresh nor a readable live source there is no observation at all. That is a
// collection failure the CLI exits 1 on -- never a candidate reported as blocked, which would
// claim the reconciler looked and found a problem with the model.
test("a refresh and a live fallback that both fail is an actionable collection failure", () => withSources("missing", ({ tmpRoot, cachePath, resolverPath }) => {
  const options = {
    liveCachePath: cachePath,
    liveResolverPath: resolverPath,
    tmpRoot,
    now: () => NOW,
    exec: failingExec,
  };
  // Nothing on disk at all.
  assert.throws(() => collectDryRunSources(options), (error) => {
    assert.match(error.message, /catalog/);
    assert.match(error.message, /opencode models: not found/);
    assert.match(error.message, new RegExp(cachePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
  // A live cache that exists but is not a catalog is no more usable than a missing one.
  writeFileSync(cachePath, "[]\n");
  assert.throws(() => collectDryRunSources(options), /catalog/);
  writeLiveCatalog(cachePath);
  // Catalog usable now, so the resolver becomes the failure -- and it names itself.
  assert.throws(() => collectDryRunSources(options), (error) => {
    assert.match(error.message, /resolver/);
    assert.match(error.message, /opencode models --pure: not found/);
    return true;
  });
  writeFileSync(resolverPath, "{ not json\n");
  assert.throws(() => collectDryRunSources(options), /resolver/);
  // An ageless snapshot cannot be certified fresh OR stale, so it is not observation input.
  writeFileSync(resolverPath, JSON.stringify({ models: ["anthropic/claude-opus-5"] }) + "\n");
  assert.throws(() => collectDryRunSources(options), /resolver/);
  // Every one of those throws swept its scratch root.
  assert.deepEqual(readdirSync(tmpRoot), []);
}));

// CRITICAL: THE TWO THRESHOLDS ARE DIFFERENT AND MUST NOT BE SWAPPED. The catalog goes stale at
// 48 hours and the resolver at 72, and the boundary itself is FRESH -- a run at exactly 48h that
// reported stale would withhold a legitimate activation, and one that reported fresh at 48h+1ms
// would activate on a view the host may already have outgrown. The third case is the swap
// detector: 72h of catalog is stale while 48h+1ms of resolver is still fresh.
test("the catalog goes stale past 48 hours and the resolver past 72, the boundary itself fresh", () => withSources("boundary", ({ tmpRoot, cachePath, resolverPath }) => {
  const at = (catalogAgeMs, resolverAgeMs) => {
    writeLiveCatalog(cachePath, LIVE_CATALOG, catalogAgeMs);
    writeLiveResolver(resolverPath, ["anthropic/claude-opus-5"], resolverAgeMs);
    return collectDryRunSources({
      liveCachePath: cachePath,
      liveResolverPath: resolverPath,
      tmpRoot,
      now: () => NOW,
      exec: failingExec,
    });
  };

  const boundary = at(48 * HOUR, 72 * HOUR);
  assert.equal(boundary.catalog.ageMs, 48 * HOUR);
  assert.equal(boundary.catalog.stale, false);
  assert.equal(boundary.resolver.ageMs, 72 * HOUR);
  assert.equal(boundary.resolver.stale, false);

  const past = at(48 * HOUR + 1, 72 * HOUR + 1);
  assert.equal(past.catalog.ageMs, 48 * HOUR + 1);
  assert.equal(past.catalog.stale, true);
  assert.equal(past.resolver.ageMs, 72 * HOUR + 1);
  assert.equal(past.resolver.stale, true);

  const crossed = at(72 * HOUR, 48 * HOUR + 1);
  assert.equal(crossed.catalog.stale, true);
  assert.equal(crossed.resolver.stale, false);
}));

test("an age is stale only past its threshold, and an unknown age is never fresh", () => {
  assert.deepEqual(assessSourceAge(NOW - 48 * HOUR, 48 * HOUR, NOW), { ageMs: 48 * HOUR, stale: false });
  assert.deepEqual(assessSourceAge(NOW - 48 * HOUR - 1, 48 * HOUR, NOW), { ageMs: 48 * HOUR + 1, stale: true });
  assert.deepEqual(assessSourceAge(NOW, 48 * HOUR, NOW), { ageMs: 0, stale: false });
  // The thresholds the collector runs on, used here so a changed export cannot go unnoticed.
  assert.deepEqual(assessSourceAge(NOW - CATALOG_MAX_AGE_MS, CATALOG_MAX_AGE_MS, NOW),
    { ageMs: 48 * HOUR, stale: false });
  assert.deepEqual(assessSourceAge(NOW - RESOLVER_MAX_AGE_MS, RESOLVER_MAX_AGE_MS, NOW),
    { ageMs: 72 * HOUR, stale: false });
  // No establishable age: fail closed rather than certify freshness.
  assert.deepEqual(assessSourceAge(null, 48 * HOUR, NOW), { ageMs: null, stale: true });
  assert.deepEqual(assessSourceAge(Number.NaN, 48 * HOUR, NOW), { ageMs: null, stale: true });
});
