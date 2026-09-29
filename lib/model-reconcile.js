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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG } from "./config.js";
import { normalizeCatalogCandidates } from "./model-candidates.js";
import { matchModelRole } from "./model-roles.js";
import { planReviewedModelsImport, readReviewedModels } from "./reconcile-state.js";
import {
  authSnapshot as liveAuthSnapshot,
  buildCachedSubscriptionInventory,
  modelCachePath,
  parseResolvableModelsOutput,
  readResolvableModelsSnapshot,
  resolvableModelsPath,
} from "./routing.js";

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

// =============================================================================================
// The DRY RUN ENGINE: collected sources in, one ledger write out, and nothing else.
//
// CRITICAL: THE ONLY SIDE EFFECT THIS ENGINE IS ALLOWED IS THE RECONCILIATION LEDGER. It computes
// the inventory the broker WOULD be handed and returns it for review; it never posts it. It takes
// no request, notify, Gitea or broker-control callback, so there is no parameter through which a
// caller could turn a dry run into a live one -- the absence is the guarantee. Governed-role
// holds, evidence collection, approvals, probes and probation all belong to later packages, and
// every one of them is what makes publication safe, so publishing here would expose a candidate
// no human has looked at.
//
// CRITICAL: A DECISION ALREADY IN THE LEDGER OUTRANKS ANYTHING THIS RUN OBSERVES. A rejection and
// a rollback are policy, and the failure mode being designed against is a rejected model
// re-entering the workflow for no better reason than still being the newest in its family. So a
// terminal record, or any record carrying an approval decision, is only stamped with a new
// `lastObservedAt`; every other byte of it is left exactly as the deciding run wrote it.
// =============================================================================================

// The states that represent a settled decision. A record in one of these is observed, never
// recomputed, by any dry run.
const TERMINAL_STATES = Object.freeze(["rejected", "rolled-back", "superseded"]);

// Why a candidate never reached classification. Each one mirrors a gate discovery already
// applies, so a model the router would refuse can never be reported as a proposal.
const ADMISSION_REASONS = Object.freeze({
  inactive: "inactive",
  toolCall: "tool-call-unsupported",
  modelID: "invalid-model-id",
  speedVariant: "speed-variant",
  incumbent: "incumbent",
  noReleaseDate: "no-release-date",
  notNewerThanIncumbent: "not-newer-than-incumbent",
  notNewestInRole: "not-newest-in-role",
  notNewestInGroup: "not-newest-in-group",
});

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Frozen all the way down, so a caller that stashes the report cannot be surprised later by a
// mutation, and the CLI can serialize it without defensive copying.
const deepFreeze = (value) => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
};

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const sortedObject = (entries) => Object.fromEntries([...entries].sort(([a], [b]) => compareText(a, b)));

// NEWEST FIRST: release date descending, then model id descending. An absent date sorts last
// rather than first, because "the provider did not say when" must never outrank a dated release.
const byNewest = (left, right) => {
  const leftDate = left.releaseDate ?? "";
  const rightDate = right.releaseDate ?? "";
  if (leftDate !== rightDate) return leftDate < rightDate ? 1 : -1;
  return -compareText(left.modelID, right.modelID);
};

// The group a candidate is reasoned about in: its role when the registry placed it, otherwise its
// provider/family line -- or its exact provider/model when the catalog declared no family, since
// there is then no line to group with.
export const candidateGroupKey = (candidate) => candidate?.roleKey
  ?? `${candidate?.providerID}:${candidate?.family ?? candidate?.modelID}`;

// The stable identity of one candidate-in-one-group, and the key every later package's issue,
// notification and decision hangs off. NUL-separated because no component may contain NUL, so no
// two different tuples can render to the same string; truncated to 24 hex characters, which is
// short enough to paste into an issue title and far past collision risk for this cardinality.
//
// The release date is part of the identity: a provider that re-dates a model has published a
// different release, and that has to read as a new candidate rather than as the old one changing
// underneath a decision.
export const candidateTransitionID = (candidate) => createHash("sha256")
  .update([
    String(candidate?.providerID ?? ""),
    candidateGroupKey(candidate),
    String(candidate?.modelID ?? ""),
    candidate?.releaseDate ?? "",
  ].join("\u0000"))
  .digest("hex")
  .slice(0, 24);

// Which providers this deployment has PROVEN subscription auth for, and therefore the only ones
// the reconciler may reason about. Exactly the admission rule discovery uses: OAuth, or a trusted
// subscription integration that still holds some credential.
const admittedProviderIDs = (authTypes, trusted) => Object.freeze(Object.entries(authTypes ?? {})
  .filter(([id, type]) => type === "oauth" || (trusted.has(id) && type !== "unknown"))
  .map(([id]) => id)
  .sort());

// The gates discovery applies before a model can take a lane, in the order a reader of
// discoverSubscriptionTargets would expect. Returns null when the candidate is admissible.
const candidateAdmissionFailure = (candidate) => {
  if (!candidate.active) return ADMISSION_REASONS.inactive;
  // An ABSENT tool_call is not a refusal: only a declared false is, which is what discovery
  // checks too. The difference is a reason to probe (Package 3), not a reason to drop.
  if (candidate.capabilities?.toolCall === false) return ADMISSION_REASONS.toolCall;
  if (!candidate.validModelID) return ADMISSION_REASONS.modelID;
  // A speed variant is a lane of its own: it is pinned in config for fast-build and must never
  // be proposed as a standard-tier successor.
  if (candidate.speedVariant) return ADMISSION_REASONS.speedVariant;
  return null;
};

// The configured targets, resolved to roles through the SAME registry the candidates went
// through, so "what is installed" and "what could replace it" are never compared across two
// different notions of a role. Catalog metadata is used when the configured model is in the
// catalog; otherwise the registry answers from the model id alone and the release date is
// honestly unknown.
const collectIncumbents = (candidates, staticTargets, roles) => {
  const byKey = new Map(candidates.map((candidate) => [candidate.resolverKey, candidate]));
  const found = new Map();
  for (const target of Object.values(isPlainObject(staticTargets) ? staticTargets : {})) {
    const providerID = typeof target?.providerID === "string" ? target.providerID : "";
    const modelID = typeof target?.modelID === "string" ? target.modelID : "";
    if (!providerID || !modelID) continue;
    const candidate = byKey.get(`${providerID}/${modelID}`);
    let roleKey = null;
    let roleID = null;
    let releaseDate = null;
    if (candidate && candidate.roleStatus === "known") {
      ({ roleKey, roleID, releaseDate } = candidate);
    } else if (!candidate && roles) {
      const match = matchModelRole(providerID, { id: modelID }, roles);
      if (match.status === "known") {
        roleKey = match.roleKey;
        roleID = match.role?.roleID ?? null;
      }
    }
    if (!roleKey) continue;
    const entry = found.get(roleKey) ?? { roleKey, providerID, roleID, models: [] };
    entry.models.push({ modelID, releaseDate });
    found.set(roleKey, entry);
  }
  const incumbents = {};
  for (const [roleKey, entry] of found) {
    // A role may hold several configured models (an incumbent plus a kept-around predecessor).
    // The newest is the one a successor has to beat.
    const newest = [...entry.models].sort(byNewest)[0];
    incumbents[roleKey] = {
      roleKey,
      providerID: entry.providerID,
      roleID: entry.roleID,
      modelID: newest.modelID,
      releaseDate: newest.releaseDate,
      modelIDs: entry.models.map((model) => model.modelID).sort(compareText),
    };
  }
  return sortedObject(Object.entries(incumbents));
};

// One candidate per role and one per unknown group, plus the reason every other observed model
// was set aside.
//
// CRITICAL: NEVER SYNTHESIZE. Only models the catalog actually listed appear here, so a registry
// that knows an `openai:gpt-terra` role cannot mint a gpt-6-terra out of the fact that Sol and
// Luna shipped -- a target for a model the provider never published takes its whole tier down
// with ProviderModelNotFoundError.
//
// CRITICAL: NO NUMERIC VERSION COMPARISON while provider release dates are available. "5.6" and
// "6" are the provider's marketing strings, not a total order, and parsing them is how a
// re-released older line jumps ahead of a newer one.
export const selectUpgradeCandidates = (candidates, staticTargets, { roles } = {}) => {
  const list = Array.isArray(candidates) ? candidates : [];
  const incumbents = collectIncumbents(list, staticTargets, roles);
  const incumbentModelKeys = new Set(Object.values(isPlainObject(staticTargets) ? staticTargets : {})
    .filter((target) => typeof target?.providerID === "string" && typeof target?.modelID === "string")
    .map((target) => `${target.providerID}/${target.modelID}`));
  const skipped = [];
  const skip = (candidate, reason) =>
    skipped.push({ providerID: candidate.providerID, modelID: candidate.modelID, reason });

  const roleGroups = new Map();
  const unknownGroups = new Map();
  for (const candidate of list) {
    const failure = candidateAdmissionFailure(candidate);
    if (failure) { skip(candidate, failure); continue; }
    // An exact configured model is the incumbent of its role, not a proposal to replace it.
    if (incumbentModelKeys.has(candidate.resolverKey)) {
      skip(candidate, ADMISSION_REASONS.incumbent);
      continue;
    }
    if (candidate.roleStatus === "known") {
      // Discovery refuses a mapped model with no usable release date, and so does this: without
      // one there is no way to say it is NEWER than the incumbent, and "newest wins" is the only
      // ordering the provider itself supplies.
      if (!candidate.releaseDate) { skip(candidate, ADMISSION_REASONS.noReleaseDate); continue; }
      const group = roleGroups.get(candidate.roleKey) ?? [];
      group.push(candidate);
      roleGroups.set(candidate.roleKey, group);
      continue;
    }
    // An unknown or contradictory role has no lane to compete for, so an absent release date is
    // not disqualifying: the point of reporting it is that a human decides what it is.
    const groupKey = candidateGroupKey(candidate);
    const group = unknownGroups.get(groupKey) ?? [];
    group.push(candidate);
    unknownGroups.set(groupKey, group);
  }

  const roleSelections = [];
  for (const [roleKey, group] of [...roleGroups].sort(([a], [b]) => compareText(a, b))) {
    const [winner, ...rest] = [...group].sort(byNewest);
    for (const loser of rest) skip(loser, ADMISSION_REASONS.notNewestInRole);
    const incumbent = incumbents[roleKey] ?? null;
    // Same date or older than what is already configured is not an upgrade. An incumbent the
    // catalog does not describe has no comparable date, so no such claim is made about it.
    if (incumbent?.releaseDate && winner.releaseDate <= incumbent.releaseDate) {
      skip(winner, ADMISSION_REASONS.notNewerThanIncumbent);
      continue;
    }
    roleSelections.push(Object.freeze({
      roleKey,
      providerID: winner.providerID,
      roleID: winner.roleID,
      candidate: winner,
      incumbent,
    }));
  }

  const unknownSelections = [];
  for (const [groupKey, group] of [...unknownGroups].sort(([a], [b]) => compareText(a, b))) {
    const [winner, ...rest] = [...group].sort(byNewest);
    for (const loser of rest) skip(loser, ADMISSION_REASONS.notNewestInGroup);
    unknownSelections.push(Object.freeze({
      groupKey,
      providerID: winner.providerID,
      family: winner.family,
      candidate: winner,
    }));
  }

  return deepFreeze({
    incumbents,
    roles: roleSelections,
    unknown: unknownSelections,
    skipped: skipped.sort((left, right) =>
      compareText(left.providerID, right.providerID) || compareText(left.modelID, right.modelID)),
  });
};

// One candidate, one observed source status, one state name -- and NOTHING else read.
//
// CRITICAL: THIS FUNCTION TOUCHES NO GLOBAL STATE. Every input arrives as an argument, because a
// classifier that consulted the live catalog, the live clock or the live auth store could return
// a different answer than the run that is about to persist it, and the ledger would then record a
// state nothing observed.
//
// The precedence is deliberate. Staleness comes FIRST because a run that cannot certify its own
// inputs has nothing truthful to say about any individual model -- reporting such a model as
// `blocked-unresolvable` would claim the reconciler looked at the host's resolver view and found
// the model missing, when in fact it never had a usable view to look at.
export const classifyDryRunCandidate = (candidate, sourceStatus) => {
  const status = sourceStatus ?? {};
  if (status.catalogStale || status.resolverStale || status.catalogEmpty || status.resolverEmpty ||
    status.catalogError || status.resolverError) {
    return "blocked-stale";
  }
  // A rotated auth.json mid-run means the admission this run computed may already be obsolete; a
  // family/id-pattern disagreement means the registry itself cannot say which lane the model
  // belongs in. Neither is resolvable by observation, so both stop here.
  if (status.authRevisionChanged || candidate?.roleStatus === "conflict") return "blocked-conflict";
  // Fail closed on an unknown resolver answer: `null` is "no resolver view was supplied", which
  // is not the same as "the host resolves it".
  if (candidate?.resolvable !== true) return "blocked-unresolvable";
  return "evidence-pending";
};

const classificationReason = (candidate, status, state) => {
  if (state === "blocked-stale") {
    const parts = [];
    if (status.catalogError) parts.push(`catalog refresh failed (${status.catalogError})`);
    if (status.resolverError) parts.push(`resolver refresh failed (${status.resolverError})`);
    if (status.catalogStale) parts.push("catalog older than 48h");
    if (status.resolverStale) parts.push("resolver older than 72h");
    if (status.catalogEmpty) parts.push("catalog is empty");
    if (status.resolverEmpty) parts.push("resolver view is empty");
    return parts.join("; ");
  }
  if (state === "blocked-conflict") {
    return status.authRevisionChanged
      ? "auth revision changed during the run"
      : `role match conflict between ${(candidate.roleMatches ?? []).join(" and ")}`;
  }
  if (state === "blocked-unresolvable") return "the host resolver view does not expose this model";
  return null;
};

const heldRecord = (record) => Boolean(record) &&
  (TERMINAL_STATES.includes(record.state) || (record.approval ?? null) !== null);

// Merge one observation into whatever the ledger already holds for that key.
//
// `stateChangedAt` moves only when the STATE or the candidate IDENTITY changes, which is what
// makes a repeated run idempotent: an unchanged observation must not look like a fresh event to
// the notification and issue projections Package 2 builds on these timestamps.
const mergeObservation = (existing, observation, observedAt) => {
  if (heldRecord(existing)) {
    return { record: { ...existing, lastObservedAt: observedAt }, preserved: true };
  }
  if (!existing) {
    return {
      preserved: false,
      record: {
        ...observation,
        stateChangedAt: observedAt,
        lastObservedAt: observedAt,
        // The umbrella state machine starts at `discovered` even though Package 1 computes the
        // discovery and the classification inside one locked update: a later package reading
        // this history must see the same first step a staged transition would have written.
        transitions: ["discovered", observation.state],
        evidence: [],
        approval: null,
        issue: null,
        notified: null,
      },
    };
  }
  const stateChanged = existing.state !== observation.state;
  const identityChanged = existing.transitionID !== observation.transitionID;
  return {
    preserved: false,
    record: {
      // `existing` first so evidence, approval, issue, notify markers and history survive; the
      // observation then overwrites only the fields this run actually measured.
      ...existing,
      ...observation,
      stateChangedAt: stateChanged || identityChanged ? observedAt : existing.stateChangedAt,
      lastObservedAt: observedAt,
      transitions: stateChanged
        ? [...(Array.isArray(existing.transitions) ? existing.transitions : ["discovered"]), observation.state]
        : (Array.isArray(existing.transitions) ? existing.transitions : ["discovered", observation.state]),
    },
  };
};

const sourceProjection = (source) => ({
  refreshed: source.refreshed === true,
  source: source.source ?? null,
  error: source.error ?? null,
  updatedAt: source.updatedAt ?? null,
  ageMs: source.ageMs ?? null,
  stale: source.stale === true,
  empty: source.empty === true,
});

const targetProjection = (targets) => sortedObject(Object.entries(isPlainObject(targets) ? targets : {})
  .map(([id, target]) => [id, {
    id,
    providerID: target.providerID,
    modelID: target.modelID,
    tiers: [...(target.tiers ?? [])],
    family: target.family ?? null,
    releaseDate: target.releaseDate ?? null,
  }]));

// One dry reconciliation.
//
// Every dependency is injected so the whole engine is testable without a subprocess, a broker or
// a credential store: `collectSources` is the refresh, `authSnapshot` the auth store, `now` the
// clock, `store` the ledger. There is deliberately no `request`, `notify`, `gitea` or `control`
// parameter -- see the section header.
export const runDryReconciliation = ({
  store,
  modelRoles = CONFIG.modelRoles,
  staticTargets = CONFIG.targets,
  trustedProviderIDs = new Set(CONFIG.trustedSubscriptionProviders),
  authSnapshot = liveAuthSnapshot,
  collectSources = collectDryRunSources,
  now = Date.now,
} = {}) => {
  if (!store || typeof store.update !== "function" || typeof store.paths !== "function") {
    throw new Error("dry reconciliation needs a reconciliation store");
  }
  const trusted = trustedProviderIDs instanceof Set ? trustedProviderIDs
    : new Set(Array.isArray(trustedProviderIDs) ? trustedProviderIDs : []);

  // Auth is read on BOTH sides of collection. A rotation in between means the admission this run
  // computed may already describe credentials that no longer exist, which is a blocked run rather
  // than a run whose findings are quietly one revision out of date.
  const before = authSnapshot();
  const sources = collectSources();
  const after = authSnapshot();
  // An unreadable auth store reports a null revision, and two nulls are not agreement: fail
  // closed rather than certify that nothing changed.
  const authRevisionChanged = !before?.revision || before.revision !== after?.revision;

  const authTypes = before?.types ?? {};
  const providerIDs = admittedProviderIDs(authTypes, trusted);
  const resolvableModels = sources.resolver.models;

  // The inventory the broker WOULD receive, computed through the same pure builder live
  // publication uses so the reviewed proposal and the published one cannot drift. It is returned
  // for review and never posted.
  const { skipped: admissionSkipped, ...proposed } = buildCachedSubscriptionInventory({
    catalog: sources.catalog.data,
    authTypes,
    staticTargets,
    resolvableModels,
    modelRoles,
    trustedProviderIDs: trusted,
  });

  const candidates = normalizeCatalogCandidates(sources.catalog.data, {
    providerIDs,
    roles: modelRoles,
    resolvableModels,
  });
  const selection = selectUpgradeCandidates(candidates, staticTargets, { roles: modelRoles });

  const sourceStatus = Object.freeze({
    catalogStale: sources.catalog.stale === true,
    resolverStale: sources.resolver.stale === true,
    catalogError: sources.catalog.error ?? null,
    resolverError: sources.resolver.error ?? null,
    catalogEmpty: sources.catalog.empty === true,
    resolverEmpty: sources.resolver.empty === true,
    authRevisionChanged,
  });

  // Read BEFORE the lock and deliberately loud: a hand-mangled legacy ledger aborts the run with
  // the ledger untouched, rather than being written around and silently forgotten.
  const reviewed = readReviewedModels(store.paths().reviewed);

  const observedAt = now();
  const entries = {};
  let legacyMigration = null;
  // The lock covers only this read-modify-write. The refreshes above are subprocesses that take
  // seconds; holding the lock across them would serialize every reconciler on the slowest source.
  const saved = store.update((current) => {
    const roles = { ...current.roles };
    const unknown = { ...current.unknown };

    for (const selected of selection.roles) {
      const candidate = selected.candidate;
      const state = classifyDryRunCandidate(candidate, sourceStatus);
      const role = modelRoles?.[selected.roleKey];
      const observation = {
        transitionID: candidateTransitionID(candidate),
        roleKey: selected.roleKey,
        providerID: candidate.providerID,
        roleID: candidate.roleID,
        candidateModelID: candidate.modelID,
        candidateFamily: candidate.family,
        candidateReleaseDate: candidate.releaseDate,
        candidateVersion: candidate.version,
        incumbentModelID: selected.incumbent?.modelID ?? null,
        proposedTiers: [...(role?.tiers ?? [])],
        proposedFit: { ...(role?.fit ?? {}) },
        state,
        reason: classificationReason(candidate, sourceStatus, state),
      };
      const { record, preserved } = mergeObservation(roles[selected.roleKey], observation, observedAt);
      roles[selected.roleKey] = record;
      entries[candidate.resolverKey] = {
        transitionID: record.transitionID,
        providerID: candidate.providerID,
        modelID: candidate.modelID,
        family: candidate.family,
        roleKey: selected.roleKey,
        roleID: candidate.roleID,
        roleStatus: candidate.roleStatus,
        roleMatches: [...candidate.roleMatches],
        groupKey: selected.roleKey,
        releaseDate: candidate.releaseDate,
        resolvable: candidate.resolvable,
        incumbentModelID: selected.incumbent?.modelID ?? null,
        state: record.state,
        reason: record.reason ?? null,
        stateChangedAt: record.stateChangedAt,
        lastObservedAt: record.lastObservedAt,
        preserved,
      };
    }

    for (const selected of selection.unknown) {
      const candidate = selected.candidate;
      const state = classifyDryRunCandidate(candidate, sourceStatus);
      const transitionID = candidateTransitionID(candidate);
      const observation = {
        transitionID,
        groupKey: selected.groupKey,
        providerID: candidate.providerID,
        modelID: candidate.modelID,
        family: candidate.family,
        roleStatus: candidate.roleStatus,
        // Both disputed role keys are kept on the record: Package 2 collects evidence about the
        // disagreement itself, and resolving it here would be the guess this design forbids.
        roleMatches: [...candidate.roleMatches],
        releaseDate: candidate.releaseDate,
        version: candidate.version,
        state,
        reason: classificationReason(candidate, sourceStatus, state),
      };
      const { record, preserved } = mergeObservation(unknown[transitionID], observation, observedAt);
      unknown[transitionID] = record;
      entries[candidate.resolverKey] = {
        transitionID,
        providerID: candidate.providerID,
        modelID: candidate.modelID,
        family: candidate.family,
        roleKey: null,
        roleID: null,
        roleStatus: candidate.roleStatus,
        roleMatches: [...candidate.roleMatches],
        groupKey: selected.groupKey,
        releaseDate: candidate.releaseDate,
        resolvable: candidate.resolvable,
        incumbentModelID: null,
        state: record.state,
        reason: record.reason ?? null,
        stateChangedAt: record.stateChangedAt,
        lastObservedAt: record.lastObservedAt,
        preserved,
      };
    }

    const next = { ...current, roles, unknown };
    // Computed against the state this run is about to write, so an identical rerun previews an
    // identical import instead of re-listing keys it has just come to cover.
    legacyMigration = planReviewedModelsImport(next, reviewed);
    return next;
  });

  const counts = {};
  for (const entry of Object.values(entries)) counts[entry.state] = (counts[entry.state] ?? 0) + 1;

  return deepFreeze({
    dryRun: true,
    // Stated as data rather than left to prose, so the CLI and any later assertion can check that
    // a run which claims to be a dry run really did nothing but write its own ledger.
    effects: {
      ledgerWritten: true,
      inventoryPublished: false,
      routingMutated: false,
      externalPublished: false,
    },
    observedAt,
    sources: {
      catalog: sourceProjection(sources.catalog),
      resolver: sourceProjection(sources.resolver),
    },
    authRevisionChanged,
    providerIDs: [...providerIDs],
    incumbents: selection.incumbents,
    byModel: sortedObject(Object.entries(entries)),
    counts: sortedObject(Object.entries(counts)),
    proposedTargets: targetProjection(proposed.targets),
    admissionSkipped: (admissionSkipped ?? []).map((entry) => ({
      providerID: entry.providerID,
      modelID: entry.modelID,
      tiers: [...(entry.tiers ?? [])],
      reason: entry.reason,
    })),
    skipped: selection.skipped.map((entry) => ({ ...entry })),
    legacyMigration: {
      importKeys: [...legacyMigration.importKeys],
      existingKeys: [...legacyMigration.existingKeys],
    },
    ledger: {
      version: saved.version,
      updatedAt: saved.updatedAt,
      roleCount: Object.keys(saved.roles).length,
      unknownCount: Object.keys(saved.unknown).length,
      evidenceRequestCount: Object.keys(saved.evidenceRequests).length,
    },
  });
};

// ---- read projections -----------------------------------------------------------------------
// Both of these are PURE READS. Neither takes the writer lock: `status` must stay answerable
// while a reconciliation run holds it, and a reader that blocked on the writer would turn a
// diagnostic command into a second way to wait on a stuck lock.

const ageLabel = (ageMs) => ageMs === null || ageMs === undefined
  ? "age unknown" : `${Math.floor(ageMs / 3600_000)}h old`;

const sourceLine = (label, source) => {
  const origin = source.refreshed ? `refreshed from ${source.source}` : `read from the live ${source.source}`;
  const notes = [ageLabel(source.ageMs), source.stale ? "STALE" : "fresh"];
  if (source.empty) notes.push("empty");
  if (source.error) notes.push(`refresh error: ${source.error}`);
  return `${label}: ${origin}, ${notes.join(", ")}`;
};

const countLine = (counts) => Object.entries(counts).length
  ? Object.entries(counts).map(([state, count]) => `${state} ${count}`).join(", ")
  : "none";

// The human surface of a dry run: freshness of both sources, the tally by state, every candidate
// with the role or unknown group it was reasoned about in, every skip with its reason, and the
// legacy-import preview.
export const formatDryRunReport = (report) => {
  const lines = [
    `dry run: ledger written, inventory not published, routing not mutated, nothing published externally`,
    sourceLine("catalog", report.sources.catalog),
    sourceLine("resolver", report.sources.resolver),
    `auth revision: ${report.authRevisionChanged ? "CHANGED during the run" : "unchanged"}`,
    `providers: ${report.providerIDs.length ? report.providerIDs.join(", ") : "none"}`,
    `counts: ${countLine(report.counts)}`,
  ];
  const incumbents = Object.values(report.incumbents);
  lines.push(`incumbents: ${incumbents.length ? "" : "none"}`.trimEnd());
  for (const incumbent of incumbents) {
    lines.push(`  ${incumbent.roleKey} = ${incumbent.modelID}`);
  }
  lines.push(`candidates: ${Object.keys(report.byModel).length ? "" : "none"}`.trimEnd());
  for (const [key, entry] of Object.entries(report.byModel)) {
    const group = entry.roleKey ?? `unknown ${entry.groupKey}`;
    const note = entry.preserved ? " [existing decision preserved]" : entry.reason ? ` -- ${entry.reason}` : "";
    lines.push(`  ${key} -> ${entry.state} (${group})${note}`);
  }
  lines.push(`skipped: ${report.skipped.length ? "" : "none"}`.trimEnd());
  for (const entry of report.skipped) {
    lines.push(`  ${entry.providerID}/${entry.modelID}: ${entry.reason}`);
  }
  lines.push(`admission skipped: ${report.admissionSkipped.length ? "" : "none"}`.trimEnd());
  for (const entry of report.admissionSkipped) {
    lines.push(`  ${entry.providerID}/${entry.modelID}: ${entry.reason}`);
  }
  lines.push(`proposed targets: ${Object.keys(report.proposedTargets).length} (computed, not published)`);
  lines.push(`legacy reviewed-models import: ${report.legacyMigration.importKeys.length} to import, ` +
    `${report.legacyMigration.existingKeys.length} already covered`);
  return lines.join("\n");
};

// The bounded projection of the ledger.
//
// CRITICAL: BOUNDED ON PURPOSE. Normalized catalog metadata, evidence quotations, approval
// decisions, issue numbers and transition histories stay out: `status` is a diagnostic an
// operator (and later a skill) prints routinely, and growing it into a dump of the whole record
// is how evidence text and issue payloads end up in logs and terminal scrollback.
export const readReconciliationStatus = (store) => {
  const statePath = store.paths().state;
  // Absence is decided by the FILE, not by what a read returns: nothing reconciled yet and an
  // empty ledger are different answers, and only the first one means "no state".
  if (!existsSync(statePath)) {
    return deepFreeze({ exists: false, version: null, updatedAt: null, counts: {}, roles: [], unknown: [] });
  }
  const state = store.read();
  const counts = {};
  const tally = (record) => {
    const name = typeof record?.state === "string" ? record.state : "unknown";
    counts[name] = (counts[name] ?? 0) + 1;
  };
  const roles = Object.entries(state.roles ?? {})
    .sort(([a], [b]) => compareText(a, b))
    .map(([roleKey, record]) => {
      tally(record);
      return {
        roleKey,
        providerID: record?.providerID ?? null,
        roleID: record?.roleID ?? null,
        state: record?.state ?? null,
        candidateModelID: record?.candidateModelID ?? null,
        stateChangedAt: record?.stateChangedAt ?? null,
        lastObservedAt: record?.lastObservedAt ?? null,
      };
    });
  const unknown = Object.entries(state.unknown ?? {})
    .sort(([a], [b]) => compareText(a, b))
    .map(([transitionID, record]) => {
      tally(record);
      return {
        transitionID,
        providerID: record?.providerID ?? null,
        modelID: record?.modelID ?? null,
        family: record?.family ?? null,
        state: record?.state ?? null,
        stateChangedAt: record?.stateChangedAt ?? null,
        lastObservedAt: record?.lastObservedAt ?? null,
      };
    });
  return deepFreeze({
    exists: true,
    version: state.version,
    updatedAt: state.updatedAt,
    counts: sortedObject(Object.entries(counts)),
    roles,
    unknown,
  });
};

export const formatReconciliationStatus = (status) => {
  if (!status?.exists) return "no reconciliation state";
  const lines = [
    `reconciliation state v${status.version}, updated ${new Date(status.updatedAt).toISOString()}`,
    `counts: ${countLine(status.counts)}`,
  ];
  lines.push(`roles: ${status.roles.length ? "" : "none"}`.trimEnd());
  for (const role of status.roles) {
    lines.push(`  ${role.roleKey} -> ${role.state} (${role.candidateModelID ?? "no candidate"})`);
  }
  lines.push(`unknown: ${status.unknown.length ? "" : "none"}`.trimEnd());
  for (const entry of status.unknown) {
    lines.push(`  ${entry.transitionID} ${entry.providerID}/${entry.modelID} -> ${entry.state}`);
  }
  return lines.join("\n");
};
