// Source collection for the model reconciler's DRY RUN: what the catalog and the host's resolver
// say right now, gathered without moving either of the live views the router runs on.
//
// CRITICAL: A DRY RUN THAT REFRESHES IN PLACE IS NOT A DRY RUN. `opencode models` rewrites
// OpenCode's models.dev cache wherever XDG_CACHE_HOME points, and refreshResolvableModels() rewrites
// resolvable-models.json. Either one changes what the NEXT prompt's cached publication admits --
// from a run whose entire promise is that it changes nothing, and before any human has looked at
// the proposal. So the refresh runs against a scratch XDG_CACHE_HOME that is deleted afterwards,
// and the resolver listing is parsed in memory. Neither refreshResolvableModels() nor
// publishCachedSubscriptionInventory() may be called from here: the first writes the snapshot,
// the second posts to the broker.
//
// A failed refresh is not a dead run. Stale observation still produces findings, so the fallback
// READS the live cache and the live snapshot -- and only reads them: no repair, no rewrite, not
// even a touched mtime. What it cannot do is invent an observation, so a refresh and a fallback
// that both fail is a collection failure the CLI exits on, never a candidate reported as blocked
// (which would claim the reconciler looked at the model and found a problem with it).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelCachePath, parseResolvableModelsOutput, readResolvableModelsSnapshot, resolvableModelsPath } from "./routing.js";

// CRITICAL: TWO DIFFERENT THRESHOLDS, AND THEY ARE NOT INTERCHANGEABLE. The catalog is a vendor
// feed that moves daily; the resolver view is this host's provider config, which moves when someone
// edits it. Swapping them either withholds a legitimate activation or activates on a view the
// host has already outgrown. The boundary itself is FRESH: only `age > threshold` is stale.
export const CATALOG_MAX_AGE_MS = 48 * 3600_000;
export const RESOLVER_MAX_AGE_MS = 72 * 3600_000;

const REFRESH_TIMEOUT_MS = 120_000;
const PURE_MAX_BUFFER = 16 * 1024 * 1024;

const describe = (error) => String(error?.message ?? error);

// An age that cannot be established is never certified fresh: `stale` is the fail-closed answer
// for a source whose timestamp is missing, non-numeric or infinite.
export const assessSourceAge = (updatedAt, maxAgeMs, now) => {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return { ageMs: null, stale: true };
  const ageMs = now - updatedAt;
  return { ageMs, stale: ageMs > maxAgeMs };
};

const readCatalogFile = (path) => {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  // A refresh that exits 0 and leaves an array or a scalar behind is a FAILED refresh. Taken at
  // face value it would reach the inventory builder as "the catalog" and silently empty the
  // proposal of every provider.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not an OpenCode model catalog object`);
  }
  return parsed;
};

const collectCatalog = ({ exec, scratchEnv, cacheHome, liveCachePath, startedAt, now }) => {
  // The path OpenCode writes under the cache home it was handed.
  const scratchPath = join(cacheHome, "opencode/models.json");
  let refreshError = null;
  try {
    exec("opencode", ["models"], { stdio: "ignore", timeout: REFRESH_TIMEOUT_MS, env: scratchEnv });
    const data = readCatalogFile(scratchPath);
    // Measured from before the refresh started, so the reported age never understates how old
    // the data could be.
    const { ageMs, stale } = assessSourceAge(startedAt, CATALOG_MAX_AGE_MS, now());
    return {
      refreshed: true, source: "scratch", path: scratchPath, error: null,
      updatedAt: startedAt, ageMs, stale, empty: !Object.keys(data).length, data,
    };
  } catch (error) {
    refreshError = describe(error);
  }
  let data;
  let updatedAt;
  try {
    data = readCatalogFile(liveCachePath);
    updatedAt = statSync(liveCachePath).mtimeMs;
  } catch (error) {
    throw new Error(`unable to collect the OpenCode model catalog: the scratch refresh failed ` +
      `(${refreshError}) and the live cache at ${liveCachePath} is unusable (${describe(error)}); ` +
      `run 'opencode models --refresh'`);
  }
  const { ageMs, stale } = assessSourceAge(updatedAt, CATALOG_MAX_AGE_MS, now());
  return {
    refreshed: false, source: "live", path: liveCachePath, error: refreshError,
    updatedAt, ageMs, stale, empty: !Object.keys(data).length, data,
  };
};

const collectResolver = ({ exec, scratchEnv, liveResolverPath, now }) => {
  let refreshError = null;
  try {
    const output = exec("opencode", ["models", "--pure"], {
      encoding: "utf8", timeout: REFRESH_TIMEOUT_MS, maxBuffer: PURE_MAX_BUFFER, env: scratchEnv,
    });
    // Parsed in memory. refreshResolvableModels() would have written the live snapshot, and it
    // also THROWS on an empty listing -- but an empty resolver view is a finding the dry run has
    // to report, not a crash.
    const models = parseResolvableModelsOutput(output);
    const updatedAt = now();
    const { ageMs, stale } = assessSourceAge(updatedAt, RESOLVER_MAX_AGE_MS, now());
    return {
      refreshed: true, source: "scratch", path: null, error: null,
      updatedAt, ageMs, stale, empty: models.size === 0, models,
    };
  } catch (error) {
    refreshError = describe(error);
  }
  // Read-only, and fail-closed on age: the snapshot reader reports `updatedAt: null` for a
  // missing, unparseable or ageless file, and none of those is observation input.
  const snapshot = readResolvableModelsSnapshot(liveResolverPath);
  if (snapshot.updatedAt === null) {
    throw new Error(`unable to collect the OpenCode resolver view: the scratch refresh failed ` +
      `(${refreshError}) and the live snapshot at ${liveResolverPath} is missing, unreadable or ` +
      `carries no timestamp; run 'opencode models --pure' through the broker watch job`);
  }
  const { ageMs, stale } = assessSourceAge(snapshot.updatedAt, RESOLVER_MAX_AGE_MS, now());
  return {
    refreshed: false, source: "live", path: liveResolverPath, error: refreshError,
    updatedAt: snapshot.updatedAt, ageMs, stale, empty: snapshot.models.size === 0,
    models: snapshot.models,
  };
};

// Gather both sources for one dry run. Every dependency is injected so the isolation itself is
// testable: `exec` is the subprocess, `now` the clock, `tmpRoot` where the scratch tree lands,
// `env` the environment the child inherits.
export const collectDryRunSources = ({
  liveCachePath = modelCachePath(),
  liveResolverPath = resolvableModelsPath(),
  now = Date.now,
  exec = execFileSync,
  tmpRoot = tmpdir(),
  env = process.env,
} = {}) => {
  const scratchRoot = mkdtempSync(join(tmpRoot, "opencode-broker-dry-run-"));
  const startedAt = now();
  try {
    const cacheHome = join(scratchRoot, "cache");
    mkdirSync(cacheHome, { recursive: true, mode: 0o700 });
    // CRITICAL: ONLY XDG_CACHE_HOME IS REPLACED. HOME stays the caller's, because the refresh
    // needs the host's real provider config to report the host's real resolver view -- a
    // redirected HOME would answer confidently about a deployment that does not exist. Nothing
    // about the credential store is copied, moved or staged: the child reads it in place, exactly
    // as the watch job's refresh does.
    const scratchEnv = { ...env, XDG_CACHE_HOME: cacheHome };
    const catalog = collectCatalog({ exec, scratchEnv, cacheHome, liveCachePath, startedAt, now });
    const resolver = collectResolver({ exec, scratchEnv, liveResolverPath, now });
    return Object.freeze({ catalog: Object.freeze(catalog), resolver: Object.freeze(resolver) });
  } finally {
    // Swept on every path, including the throws above: an automated run must not accumulate
    // catalog copies in the temp directory.
    rmSync(scratchRoot, { recursive: true, force: true });
  }
};
