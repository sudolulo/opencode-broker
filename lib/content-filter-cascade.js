// Content-filter failover cascade: a NON-STICKY, per-request ordering of fallback
// models to try when a provider's own content filter blocks a response mid-turn.
//
// This is deliberately NOT the model-outage machinery (lib/outage-policy.js,
// lib/model-outages.js). An outage is a model being DOWN, diagnosed over several
// requests and held open by a durable circuit; a content filter is a healthy model
// refusing ONE query. The operator's rule is the opposite of sticky: try other
// models only for the blocked query, then restore the routed model on the very next
// request. So this module writes no state, opens no circuit and consults no health:
// it derives an order from config alone, and the caller leases each candidate as an
// ordinary one-shot and settles a blocked attempt with /release (never /failure).
//
// The order encodes the rule (see ROUTING.md "Content-filter cascade"):
//   1. older generations of the BLOCKED model, SAME provider, SAME tier
//   2. the same tier on the OTHER provider(s), newest -> older
//   3. drop one tier on the ORIGINAL provider and repeat 1+2
//      ... down every tier in `tierDescent`
//   4. a local floor, then the uncensored local model, as the last resort
//
// Only candidates whose provider can actually serve the request's wire API survive
// (`apiEligibleProviders`, computed by the gateway from providerServes): an
// Anthropic /v1/messages turn cannot fail over to a provider that speaks only
// /v1/responses, and nothing here pretends otherwise. Anything already tried this
// request (`excludeTargetIDs`) and the blocked model itself are skipped.

export const DEFAULT_TIER_DESCENT = Object.freeze([
  "smart",
  "deep",
  "build",
  "review",
  "worker",
]);

// A cascade attempt never buys an unbounded walk: the shared request deadline is the
// real ceiling, but a cap keeps a misconfigured ladder from issuing dozens of leases.
export const DEFAULT_MAX_ATTEMPTS = 8;

export const DISABLED_CASCADE = Object.freeze({
  enabled: false,
  tierDescent: DEFAULT_TIER_DESCENT,
  uncensoredFloorTargetID: null,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  reserveMappings: Object.freeze({}),
});

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The older-generation chains (head targetID -> ordered [older targetIDs]). These ARE the outage
// feature's modelOutages.mappings, captured on the cascade policy so the cascade can walk older
// generations even when the OUTAGE feature is disabled -- a content filter is not an outage, and
// CONFIG.modelOutages.mappings goes empty when outages are off. Fail-closed to an empty map.
const sanitizeReserveMappings = (value) => {
  if (!isPlainObject(value)) return Object.freeze({});
  const out = {};
  for (const [head, reserves] of Object.entries(value)) {
    if (typeof head === "string" && head && Array.isArray(reserves)) {
      const ids = reserves.filter((id) => typeof id === "string" && id);
      if (ids.length) out[head] = Object.freeze([...ids]);
    }
  }
  return Object.freeze(out);
};

// Validate/normalize `config.contentFilterCascade`. DEFENSIVE, never throws: this is
// an optional, additive feature, and a typo in its block must never take down routing
// the way a malformed core policy would. Anything unusable collapses to DISABLED, so
// the broker behaves exactly as it did before the feature when the block is absent or
// wrong. Returned object is frozen. `reserveMappings` (optional) is the raw outage reserve
// chain map (config.modelOutages.mappings) captured independently of whether outages are on.
export function normalizeContentFilterCascade(raw, reserveMappings) {
  if (!isPlainObject(raw) || raw.enabled !== true) {
    const given = sanitizeReserveMappings(reserveMappings);
    return Object.keys(given).length ? Object.freeze({ ...DISABLED_CASCADE, reserveMappings: given }) : DISABLED_CASCADE;
  }

  const tierDescent = Array.isArray(raw.tierDescent)
    && raw.tierDescent.length > 0
    && raw.tierDescent.every((t) => typeof t === "string" && t.length > 0)
    ? Object.freeze([...raw.tierDescent])
    : DEFAULT_TIER_DESCENT;

  const uncensoredFloorTargetID = typeof raw.uncensoredFloorTargetID === "string"
    && raw.uncensoredFloorTargetID.length > 0
    ? raw.uncensoredFloorTargetID
    : null;

  const maxAttempts = Number.isInteger(raw.maxAttempts) && raw.maxAttempts > 0
    ? raw.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;

  return Object.freeze({ enabled: true, tierDescent, uncensoredFloorTargetID, maxAttempts,
    reserveMappings: sanitizeReserveMappings(reserveMappings ?? raw.reserveMappings) });
}

// Load-time check of the floor against the static deployment (lib/config.js calls it with the
// normalized targets and manual API registry). The floor is the uncensored LOCAL last resort, and
// a cascade lease carries no spendGrant, so a floor that is a manual API target -- or anything
// other than a static local target -- is a misconfiguration. Returns a key-only message, or null.
// Dynamic (inventory) targets are unknown at load, so "static local" is the only provable shape.
export function contentFilterCascadeFloorError(policy, { targets = {}, manualApiTargets = {} } = {}) {
  const floor = policy?.enabled === true ? policy.uncensoredFloorTargetID : null;
  if (!floor) return null;
  if (isPlainObject(manualApiTargets) && Object.hasOwn(manualApiTargets, floor)) {
    return `uncensoredFloorTargetID "${floor}" is a manualApiTargets target; a cascade lease never spends paid capacity`;
  }
  const target = isPlainObject(targets) && Object.hasOwn(targets, floor) ? targets[floor] : null;
  if (!target || target.kind !== "local") {
    return `uncensoredFloorTargetID "${floor}" must name a static target of kind "local"`;
  }
  return null;
}

export function isCascadeEnabled(config) {
  return normalizeContentFilterCascade(config?.contentFilterCascade).enabled;
}

// Ordered fallback candidates for a blocked query. Pure over `config`; returns
// [{ targetID, providerID, modelID, kind, tier, reason }], most-preferred first.
// `apiEligibleProviders` (optional) restricts to providers that can serve the wire
// API; when omitted, every provider is allowed. `blockedModel` is { providerID,
// modelID } and is always skipped. `excludeTargetIDs` are the targets already tried.
export function contentFilterCascadeOrder({
  config,
  tier,
  blockedModel = null,
  apiEligibleProviders = null,
  excludeTargetIDs = [],
} = {}) {
  const policy = normalizeContentFilterCascade(config?.contentFilterCascade);
  if (!policy.enabled) return [];

  const targets = isPlainObject(config?.targets) ? config.targets : {};
  const tiers = isPlainObject(config?.tiers) ? config.tiers : {};
  // Prefer the live outage mappings when populated (production, outages on), else the copy the
  // cascade policy captured at config load -- so older generations are walked even with outages off.
  const mappings = isPlainObject(config?.modelOutages?.mappings) && Object.keys(config.modelOutages.mappings).length
    ? config.modelOutages.mappings
    : (isPlainObject(policy.reserveMappings) ? policy.reserveMappings : {});

  const eligibleSet = Array.isArray(apiEligibleProviders) ? new Set(apiEligibleProviders) : null;
  const apiOK = (providerID) => eligibleSet === null || eligibleSet.has(providerID);

  const tried = new Set(Array.isArray(excludeTargetIDs) ? excludeTargetIDs : []);
  const pushed = new Set();
  const out = [];

  const isBlocked = (t) => blockedModel
    && t.providerID === blockedModel.providerID
    && t.modelID === blockedModel.modelID;

  const emit = (targetID, tierName, reason) => {
    const t = targets[targetID];
    if (!t || !t.providerID || !t.modelID) return;
    if (pushed.has(targetID) || tried.has(targetID)) return;
    if (!apiOK(t.providerID)) return;
    if (isBlocked(t)) return;
    pushed.add(targetID);
    out.push({
      targetID,
      providerID: t.providerID,
      modelID: t.modelID,
      kind: t.kind ?? "cloud",
      tier: tierName,
      reason,
    });
  };

  // A session turn's gateway knows only the leased model, not the tier it was assigned, so derive
  // the starting tier from the blocked model: the first descent tier that lists it. Named requests
  // pass the real tier and the blocked model lives in it, so this resolves to the same tier for
  // them; a tier outside the descent ladder (classifier/embedding) cascades in place only.
  let startTier = tier;
  if (blockedModel) {
    const found = policy.tierDescent.find((t) => (Array.isArray(tiers[t]) ? tiers[t] : [])
      .some((id) => targets[id] && targets[id].providerID === blockedModel.providerID && targets[id].modelID === blockedModel.modelID));
    if (found) startTier = found;
  }
  const startIdx = policy.tierDescent.indexOf(startTier);
  const ladder = startIdx >= 0
    ? policy.tierDescent.slice(startIdx)
    : (Array.isArray(tiers[startTier]) ? [startTier] : []);

  for (const T of ladder) {
    const tierTargetIDs = Array.isArray(tiers[T]) ? tiers[T] : [];

    // Providers present in this tier, first-appearance order, with the blocked
    // provider pulled to the front so "same provider, older generation" is tried
    // before switching providers.
    const provs = [];
    for (const id of tierTargetIDs) {
      const p = targets[id]?.providerID;
      if (p && !provs.includes(p)) provs.push(p);
    }
    const providerOrder = [];
    if (blockedModel && provs.includes(blockedModel.providerID)) providerOrder.push(blockedModel.providerID);
    for (const p of provs) if (!providerOrder.includes(p)) providerOrder.push(p);

    for (const P of providerOrder) {
      for (const slotID of tierTargetIDs) {
        const slot = targets[slotID];
        if (!slot || slot.providerID !== P) continue;
        // The tier's own candidate (skipped by emit if it is the blocked model or
        // was already tried), then its older generations, newest -> oldest. The
        // modelOutages mappings are keyed by TARGET id and their values are TARGET
        // ids (a reserve is validated same-scope, so same provider as its head).
        emit(slotID, T, "tier-candidate");
        const olders = Array.isArray(mappings[slotID]) ? mappings[slotID] : [];
        for (const olderTargetID of olders) emit(olderTargetID, T, "older-generation");
      }
    }
  }

  // Last resort: an uncensored local model answers what every filtered cloud tier
  // refused. Reachable only when its (local) provider can serve this wire API.
  if (policy.uncensoredFloorTargetID) emit(policy.uncensoredFloorTargetID, "floor", "uncensored-floor");

  return out;
}
