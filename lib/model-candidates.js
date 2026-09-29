// Turns a provider catalog record into a NORMALIZED CANDIDATE: everything the reconciler
// (Packages 2-5) needs to reason about a model, and nothing that amounts to a judgement about
// it. This module observes and reports; it never ranks, never assigns a tier, and never
// invents a model the catalog did not publish.
//
// CRITICAL: NOTHING HERE MAY IMPORT lib/routing.js. The dependency runs the other way --
// routing imports VALID_MODEL_ID and isSpeedVariant from here so the discovery path and the
// reconciler cannot disagree about which catalog ids are addressable or which are speed
// variants. A back-import is an ESM cycle whose symptom is an undefined regex at
// module-evaluation time, i.e. discovery admitting or dropping everything.
//
// CRITICAL: WHAT THIS MODULE MUST NOT DO, and why each one has a test above it in
// tests/model-candidates.test.mjs:
//   - never synthesize a family sibling the catalog does not list. The registry knows an
//     `openai:gpt-terra` role; a catalog carrying astra, sol and luna is NOT evidence that a
//     gpt-6-terra exists, and minting one produces a build-tier target whose every lease dies
//     with ProviderModelNotFoundError.
//   - never resolve a family/id-pattern disagreement. Both role keys are reported so Task 5
//     can block on the conflict, because whichever matcher "wins" is an iteration-order
//     accident that puts a real model in the wrong lane.
//   - never FILTER. Inactive, unresolvable, malformed-id and unknown-role models are all
//     reported with the flag that says so. A reconciler that cannot see what it rejected
//     cannot explain itself, and a renamed family would simply vanish.

import { matchModelRole } from "./model-roles.js";

// The provider half of a catalog key is split off before this is applied, so a model id
// carrying a slash, a space or a control character is not a model reference the host can ever
// resolve -- it is junk that would reach the provider verbatim. Shared with lib/routing.js,
// which applies it at admission; a regex used only with .test() and no /g flag is stateless,
// so one instance is safe for both callers.
export const VALID_MODEL_ID = /^[A-Za-z0-9._:-]{1,180}$/;

// A release date the reconciler can order on: the calendar shape AND a real date. "2026-13-01"
// passes the shape and is not a day, so it is reported as absent rather than sorted wrong.
const RELEASE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// `-fast` as its own hyphen-delimited segment: "gpt-9-sol-fast" and "claude-opus-fast-2026"
// are speed variants, "gpt-6-fastball" is a standard model.
const SPEED_VARIANT = /-fast(?:-|$)/i;

// A speed variant is a lane of its own: it is pinned in config for fast-build, it never joins a
// standard tier, and it never suppresses the standard model it is a variant of. Shared with
// lib/routing.js so discovery and the reconciler classify the same ids the same way.
export const isSpeedVariant = (modelID) =>
  typeof modelID === "string" && SPEED_VARIANT.test(modelID);

// Sorts nulls last without a second comparator: no family name or date contains U+FFFF.
const LAST = "\uffff";

const readString = (value) => (typeof value === "string" && value ? value : null);

export const reasoningVariants = (model) => {
  const options = Array.isArray(model?.reasoning_options) ? model.reasoning_options : [];
  const effort = options.find((option) => option?.type === "effort" && Array.isArray(option.values));
  if (effort) {
    return [...new Set(effort.values
      .map((value) => value === null ? "none" : value)
      .filter((value) => typeof value === "string" && value))];
  }
  return options.some((option) => option?.type === "budget_tokens") ? ["high", "max"] : [];
};

export const catalogModelForID = (models, modelID) => {
  if (!models || typeof models !== "object") return null;
  return models[modelID] ?? models[modelID.replace(/-(?:fast|standard)$/, "")] ?? null;
};

const readReleaseDate = (value) => {
  if (typeof value !== "string" || !RELEASE_DATE.test(value)) return null;
  return Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : null;
};

// A window or output budget is only metadata when it is a usable positive count; 0, a negative
// and a non-number all mean "the catalog did not tell us", which is not the same as zero.
const readCount = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
};

// Only capabilities the catalog actually DECLARED. An absent `tool_call` is not `false`: a
// role's requiredCapabilities check (Task 5) has to distinguish "cannot call tools" from
// "the catalog did not say", because the second is a reason to probe and the first is not.
const readCapabilities = (model) => {
  const capabilities = {};
  if (typeof model?.tool_call === "boolean") capabilities.toolCall = model.tool_call;
  return Object.freeze(capabilities);
};

// null means NO RESOLVER VIEW WAS SUPPLIED, which is "unknown", not "resolvable". The caller
// (Task 4) always supplies one; reporting an absent view as `true` would let the reconciler
// treat a model it knows nothing about as addressable.
const resolverMembership = (resolverKey, resolvableModels) => {
  if (resolvableModels instanceof Set) return resolvableModels.has(resolverKey);
  if (Array.isArray(resolvableModels)) return resolvableModels.includes(resolverKey);
  return null;
};

// One catalog record to one candidate, or null when there is no model to speak about.
//
// Returns null ONLY when the provider id or the model id is absent, because without both there
// is no resolver key and nothing downstream can refer to the record. A model id that is
// PRESENT but malformed is a candidate with `validModelID: false` -- the reconciler has to be
// able to report it.
export const normalizeCatalogModel = (providerID, model, { roles, resolvableModels } = {}) => {
  const provider = readString(providerID);
  const modelID = readString(model?.id);
  if (!provider || !modelID) return null;
  const match = matchModelRole(provider, model, roles);
  const resolverKey = `${provider}/${modelID}`;
  return Object.freeze({
    providerID: provider,
    modelID,
    family: readString(model?.family),
    // A conflict and an unknown both have no single role, so neither reports a role key, a
    // role id, or a version: a version parsed from one side of a disagreement is a guess.
    roleKey: match.status === "known" ? match.roleKey : null,
    roleID: match.status === "known" ? (readString(match.role?.roleID) ?? null) : null,
    roleStatus: match.status,
    roleMatches: match.status === "known"
      ? Object.freeze([match.roleKey])
      : Object.freeze([...match.roleKeys]),
    version: match.status === "known" ? (match.version ?? null) : null,
    releaseDate: readReleaseDate(model?.release_date),
    capabilities: readCapabilities(model),
    context: readCount(model?.limit?.context),
    output: readCount(model?.limit?.output),
    variants: Object.freeze(reasoningVariants(model)),
    resolverKey,
    resolvable: resolverMembership(resolverKey, resolvableModels),
    // An absent status means active, which is what discovery already does with these same
    // catalogs -- see activeModel in lib/routing.js.
    active: !model?.status || model.status === "active",
    validModelID: VALID_MODEL_ID.test(modelID),
    speedVariant: isSpeedVariant(modelID),
  });
};

// Accepts either shape a catalog arrives in: the models.dev cache (a provider-keyed object,
// what publishCachedSubscriptionInventory reads) or an already-shaped inventory with an `all`
// array. Both are "the catalog"; guessing wrong would silently produce zero candidates.
const catalogProviders = (catalog) => {
  if (!catalog || typeof catalog !== "object") return [];
  if (Array.isArray(catalog.all)) return catalog.all;
  if (Array.isArray(catalog)) return catalog;
  return Object.values(catalog);
};

// Sorted so the same catalog produces the same candidate order in every process: the ledger
// (Task 3) stores this list and a reshuffle would read as a change that did not happen.
const compareCandidates = (a, b) =>
  (a.providerID < b.providerID ? -1 : a.providerID > b.providerID ? 1
    : (a.family ?? LAST) < (b.family ?? LAST) ? -1 : (a.family ?? LAST) > (b.family ?? LAST) ? 1
      : (a.releaseDate ?? LAST) < (b.releaseDate ?? LAST) ? -1
        : (a.releaseDate ?? LAST) > (b.releaseDate ?? LAST) ? 1
          : a.modelID < b.modelID ? -1 : a.modelID > b.modelID ? 1 : 0);

// Every candidate for the EXACT providers asked for.
//
// CRITICAL: FAIL CLOSED ON `providerIDs`. An absent or unusable provider list yields no
// candidates rather than the whole catalog: models.dev carries every vendor it knows, and the
// reconciler is only ever entitled to reason about the providers this deployment proved
// subscription auth for. Matching is exact -- "openai-compatible" is not "openai".
export const normalizeCatalogCandidates = (catalog,
  { providerIDs, roles, resolvableModels } = {}) => {
  const wanted = providerIDs instanceof Set ? providerIDs
    : Array.isArray(providerIDs) ? new Set(providerIDs.filter((id) => typeof id === "string" && id))
      : null;
  if (!wanted || !wanted.size) return Object.freeze([]);
  const candidates = [];
  for (const provider of catalogProviders(catalog)) {
    const providerID = readString(provider?.id);
    if (!providerID || !wanted.has(providerID)) continue;
    const models = provider.models;
    if (!models || typeof models !== "object") continue;
    for (const model of Object.values(models)) {
      const candidate = normalizeCatalogModel(providerID, model, { roles, resolvableModels });
      if (candidate) candidates.push(candidate);
    }
  }
  return Object.freeze(candidates.sort(compareCandidates));
};
