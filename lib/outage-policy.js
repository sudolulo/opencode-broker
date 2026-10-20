import { outageGrants } from './model-outages.js';
import { matchModelRole } from './model-roles.js';

// Model outage reserves: the reviewed POLICY half, validated once at config load.
//
// The policy says which older same-family targets may stand in for a named primary
// while that primary has an outage, and what route (provider, connection, auth mode,
// transport, product, speed, probe shape) a verification of that scope is EXPECTED to
// take. It is configuration only:
//   - It never carries a verified flag, token, account ID or credential instance. The
//     actual credential identity is attested at runtime by the auth proxy; nothing here
//     may stand in for it, so any key outside the exact shapes below is rejected.
//   - Absent, null or `enabled: false` returns DISABLED_OUTAGES and routing is exactly
//     what it was before this feature existed.
//   - Anything malformed THROWS. lib/config.js catches that inside its existing error
//     boundary, publishes CONFIG_ERROR, and falls back to DISABLED_OUTAGES -- fail
//     closed: no reserve is ever selectable from a policy that did not validate.
export const DISABLED_OUTAGES = Object.freeze({ enabled: false, mappings: Object.freeze({}),
  expectedScopePolicies: Object.freeze({}), incidentAliases: Object.freeze({}), primaryScope: Object.freeze({}) });

// A logical scope names an EXPECTED route (provider/family/speed), never an identity.
export const scopeID = (t) => `${t.providerID}/${t.family}/${t.speed}`;

// Every string anywhere inside a membership container (tier lanes, fallback rung groups,
// profiles, profile rungs). Deliberately structure-blind so a reserve cannot hide in a
// nesting shape the loader would later reinterpret.
export function membershipIDs(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(membershipIDs);
  return value && typeof value === 'object' ? Object.values(value).flatMap(membershipIDs) : [];
}

const POLICY_KEYS = new Set(['enabled', 'mode', 'mappings', 'expectedScopePolicies', 'incidentAliases', 'primaryScope']);
const SCOPE_KEYS = 'authMode,connectionID,probe,product,providerID,speed,transport';
// The ONLY routes a scope may expect. Each value is pinned so a public API-key path or a
// console product can never be configured as the scope a Codex/Claude Code OAuth reserve
// is verified against.
const ROUTES = Object.freeze({
  anthropic: Object.freeze({ connectionID: 'llm-auth-proxy/anthropic', authMode: 'claude-code-oauth',
    transport: 'messages', product: 'claude-code', tokenMode: 'max_tokens-total-256' }),
  openai: Object.freeze({ connectionID: 'llm-auth-proxy/openai', authMode: 'chatgpt-oauth',
    transport: 'responses', product: 'codex', tokenMode: 'request-time-only' }),
});

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// Telemetry is enabled in both modes; only active mode may alter ordinary routing.
export const outageRoutingEnabled = (policy) => policy?.enabled === true && policy.mode !== 'observe';

export function normalizeOutagePolicy(raw, env) {
  if (raw == null || raw?.enabled === false) return DISABLED_OUTAGES;
  if (!plainObject(raw) || raw.enabled !== true) throw new Error('outage enabled must be boolean true or false');
  const unknown = Object.keys(raw).filter((key) => !POLICY_KEYS.has(key));
  if (unknown.length) throw new Error(`unknown outage policy field(s): ${unknown.join(', ')}`);
  if (!plainObject(raw.mappings) || !plainObject(raw.expectedScopePolicies) || !plainObject(raw.incidentAliases)) {
    throw new Error('outage mappings, expectedScopePolicies and incidentAliases must be objects');
  }
  const p = structuredClone(raw), owned = new Set(), primaryScope = {};
  const mode = Object.hasOwn(p, 'mode') ? p.mode : 'active';
  if (!['observe', 'active'].includes(mode)) throw new Error('outage mode must be observe or active');
  // Both the RAW and the NORMALIZED memberships: normalization drops IDs (unknown
  // profiles, unknown targets, LAN-filtered rungs), and a dropped ID must not hide a
  // reserve that was written into ordinary membership.
  const ordinary = new Set(['tiers', 'fallbacks', 'profiles', 'profileFallbacks', 'rawMemberships']
    .flatMap((k) => membershipIDs(env[k])));
  for (const [head, reserves] of Object.entries(p.mappings)) {
    const t = env.targets[head];
    // A head carrying an alias marker is a same-version alias, not a canonical primary.
    if (!t?.family || !['standard', 'fast'].includes(t.speed) || t.canonicalModelID !== undefined ||
      !Array.isArray(reserves) || !reserves.length) throw new Error(`invalid mapping for ${head}`);
    const logicalID = scopeID(t), s = p.expectedScopePolicies[logicalID];
    if (!plainObject(s) || Object.keys(s).sort().join(',') !== SCOPE_KEYS) throw new Error(`invalid scope keys for ${logicalID}`);
    // Own keys only: ROUTES.constructor (and every other inherited Object property) is not a route.
    const route = Object.hasOwn(ROUTES, t.providerID) ? ROUTES[t.providerID] : undefined;
    if (!route || s.providerID !== t.providerID || s.speed !== t.speed ||
      s.connectionID !== route.connectionID || s.authMode !== route.authMode ||
      s.transport !== route.transport || s.product !== route.product ||
      !plainObject(s.probe) || Object.keys(s.probe).sort().join(',') !== 'api,tokenMode' ||
      s.probe.api !== s.transport || s.probe.tokenMode !== route.tokenMode) throw new Error(`invalid scope route for ${logicalID}`);
    if (Object.values(primaryScope).includes(logicalID)) throw new Error(`conflicting mapping: two primaries claim ${logicalID}`);
    primaryScope[head] = logicalID;
    const aliases = p.incidentAliases[head];
    if (!Array.isArray(aliases) || !aliases.length || new Set(aliases).size !== aliases.length ||
      aliases.some((a) => typeof a !== 'string' || a.length < 3 || a.length > 100 || !a.trim() ||
        /[\u0000-\u001f\u007f]/.test(a))) {
      throw new Error(`invalid incident aliases for ${head}`);
    }
    for (const id of reserves) {
      const r = typeof id === 'string' ? env.targets[id] : undefined;
      if (!r || id === head || owned.has(id) || Object.hasOwn(p.mappings, id) ||
        r.canonicalModelID !== undefined || scopeID(r) !== logicalID) throw new Error(`invalid mapping reference ${JSON.stringify(id)} for ${head}`);
      if (mode === 'active' && ordinary.has(id)) throw new Error(`reserve ${id} is in ordinary membership`);
      owned.add(id);
    }
  }
  const heads = Object.keys(primaryScope), scopes = Object.values(primaryScope);
  if (!heads.length || Object.keys(p.expectedScopePolicies).some((k) => !scopes.includes(k))) {
    throw new Error('invalid scope coverage: every expected scope needs exactly one mapped primary');
  }
  const aliasKeys = Object.keys(p.incidentAliases);
  if (aliasKeys.length !== heads.length || aliasKeys.some((k) => !Object.hasOwn(primaryScope, k))) {
    throw new Error('incident aliases must name exactly the mapped primaries');
  }
  // primaryScope is DERIVED. A config may restate it, but only as exactly what it derives to.
  if (p.primaryScope !== undefined && (!plainObject(p.primaryScope) ||
    JSON.stringify(Object.entries(p.primaryScope).sort()) !== JSON.stringify(Object.entries(primaryScope).sort()))) {
    throw new Error('primaryScope disagrees with the mapped targets');
  }
  return deepFreeze({ enabled: true, mode, mappings: p.mappings, expectedScopePolicies: p.expectedScopePolicies,
    incidentAliases: p.incidentAliases, primaryScope });
}

// Compute the normal head from the complete admitted/resolver-visible target set. This
// deliberately happens before the router applies circuits, budgets, capacity, or context:
// a temporarily unavailable head must not promote an older sibling or alias.
export function buildCanonicalHeads({ policy, targets, admittedModelKeys, resolvableModelKeys }) {
  if (!outageRoutingEnabled(policy)) return {};
  const admitted = new Set(admittedModelKeys);
  const visible = new Set(resolvableModelKeys);
  const heads = {};
  for (const [reviewed, logicalID] of Object.entries(policy.primaryScope)) {
    const candidates = Object.values(targets).filter((target) => scopeID(target) === logicalID &&
      admitted.has(`${target.providerID}/${target.modelID}`) && visible.has(`${target.providerID}/${target.modelID}`));
    const pinned = candidates.find((target) => target.id === reviewed);
    const dated = candidates.filter((target) => target.releaseDate && !target.canonicalModelID);
    // A reviewed pin without trusted comparable release metadata remains the authority.
    if (!pinned?.releaseDate) {
      heads[logicalID] = pinned?.id ?? null;
      continue;
    }
    const best = dated.sort((left, right) => right.releaseDate.localeCompare(left.releaseDate) ||
      (left.id === reviewed ? -1 : right.id === reviewed ? 1 : left.id.localeCompare(right.id)))[0];
    heads[logicalID] = best?.id ?? pinned.id;
  }
  return heads;
}

const reserveIDs = (policy) => new Set(Object.values(policy.mappings).flat());

// Every target ID the reviewed mappings list as a reserve (empty for a disabled policy).
export const policyReserveIDs = (policy) => (outageRoutingEnabled(policy) ? reserveIDs(policy) : new Set());

// Every target ID that names a managed canonical identity: a reviewed primary, a listed
// reserve, or the current head of a managed scope. An explicit alias (canonicalModelID) of
// one of these is a same-version alias of a managed model even when the alias record carries
// no family/speed of its own. Exact string identity only: no case folding, no name shapes.
const managedIdentityIDs = (policy, heads) => new Set([
  ...Object.keys(policy.primaryScope),
  ...reserveIDs(policy),
  ...Object.values(heads).filter((id) => typeof id === 'string'),
]);

const requireHeads = (policy, heads) => {
  if (!plainObject(heads)) {
    // Without heads every managed scope would read as "not the head" and the whole managed
    // lane would silently unroute. That is a caller bug, and it must fail where it happens.
    throw new TypeError('outage gate: an enabled outage policy needs canonical heads built from the complete admitted view');
  }
  return heads;
};

export function ordinaryAllowed(target, { policy, heads }) {
  if (!target) return false;
  if (!outageRoutingEnabled(policy)) return true;
  const known = requireHeads(policy, heads);
  if (reserveIDs(policy).has(target.id)) return false;
  const logicalID = scopeID(target);
  if (policy.expectedScopePolicies[logicalID]) return known[logicalID] === target.id && target.canonicalModelID === undefined;
  if (target.canonicalModelID !== undefined && managedIdentityIDs(policy, known).has(target.canonicalModelID)) return false;
  // markManagedOutageScope flags candidates that belong to a managed model role but lack the
  // metadata to identify a safe normal scope. Unknown metadata fails closed.
  if (target.managedOutageScope === true) return false;
  return true;
}

// Grants that the current heads still authorize: a grant for a configured primary that is
// no longer its scope's head (a newer admitted release took over) authorizes nothing. A
// future head inherits no mapping.
const headAuthorizedGrants = ({ policy, heads, outages, now }) => {
  if (!outageRoutingEnabled(policy) || !outages) return [];
  const known = requireHeads(policy, heads);
  return outageGrants(outages, policy, now).filter((grant) => known[grant.logicalID] === grant.primaryID);
};

// A selection context evaluates the grants reducer ONCE. The result rides on the context as
// a non-enumerable symbol property: it is answered only from the exact object it was computed
// for, so a spread copy (`{...context, primaryIDs}`) carries no stale scope or time and is
// simply recomputed. There is no module-level cache to go stale.
const GRANTS = Symbol('outage-grants');
const grantsFor = (context) => {
  if (Object.hasOwn(context, GRANTS)) return context[GRANTS];
  const authorized = headAuthorizedGrants(context);
  // Some automatic gates (published inventory, held leases, sticky assignments, and
  // previews) do not assemble a lane array themselves. Their safe scope is every reviewed
  // primary: omitting the array must never make an active head routable.
  const lane = Array.isArray(context.primaryIDs) ? context.primaryIDs : Object.keys(context.policy?.primaryScope ?? {});
  return Object.freeze({
    affectedHeadIDs: new Set(authorized.map((grant) => grant.primaryID)),
    laneGrants: Object.freeze(authorized.filter((grant) => lane.includes(grant.primaryID))),
  });
};

// ── Circuit stand-ins ──────────────────────────────────────────────────────────────────────
// A configured primary fenced by its OWN target circuit -- a single-model failure: overload, a
// burst limit, a 5xx, a missing id -- is stood in for by its mapped reserves, in configured order
// (newest first), for exactly as long as that circuit is open, and BEFORE any fallback rung. So
// claude-opus-5-5 down drops a lane to claude-opus-5, then claude-opus-4-8, instead of to qwen-max
// or gpt-terra (2026-10-19: the smart tier's last rung became its only target twice). No grant is
// involved and none is needed: a stand-in lease is an ordinary request on the same account, it
// carries no outage assertion, and the episode/grant machinery and its verified-health contract
// for GRANTED reserves are untouched. A provider-scoped circuit is not a single-model failure (and
// fences every reserve on that provider anyway); a primary that is no longer its scope's head
// (a newer admitted release took over) stands in for nothing. Active mode only.
const STANDINS = Symbol('circuit-standins');
const circuitOpenAt = (circuit, now) => !!circuit && (circuit.until === null || Number(circuit.until) > now);
const standInsFor = (context) => {
  if (Object.hasOwn(context, STANDINS)) return context[STANDINS];
  const { policy, heads, circuits, now } = context;
  if (!outageRoutingEnabled(policy) || !plainObject(circuits)) return Object.freeze({ all: [], lane: [], ids: new Set() });
  const known = requireHeads(policy, heads);
  const at = Number.isFinite(now) ? now : Date.now();
  const all = [];
  for (const [primaryID, reserves] of Object.entries(policy.mappings)) {
    if (known[policy.primaryScope[primaryID]] !== primaryID || !circuitOpenAt(circuits[primaryID], at)) continue;
    reserves.forEach((targetID, rank) => all.push(Object.freeze({ primaryID, targetID, rank })));
  }
  const lane = Array.isArray(context.primaryIDs) ? context.primaryIDs : Object.keys(policy.primaryScope ?? {});
  return Object.freeze({
    all: Object.freeze(all),
    lane: Object.freeze(all.filter((standIn) => lane.includes(standIn.primaryID))
      .sort((a, b) => a.rank - b.rank || lane.indexOf(a.primaryID) - lane.indexOf(b.primaryID))),
    ids: new Set(all.map((standIn) => standIn.targetID)),
  });
};

export function snapshotOutageContext({ policy, heads, outages = null, primaryIDs = null, now, circuits = null }) {
  const context = { policy, heads, outages, primaryIDs, now, circuits };
  Object.defineProperty(context, GRANTS, { value: grantsFor(context), enumerable: false });
  Object.defineProperty(context, STANDINS, { value: standInsFor(context), enumerable: false });
  return Object.freeze(context);
}

// Lane-scoped like grant reserves: a stand-in replaces a head only in a lane that carries it,
// first reserve rank across every fenced head, then lane order.
export function circuitStandIns(context) {
  return standInsFor(context).lane;
}

// Reserve substitution is lane-scoped: a reserve stands in only where its configured primary
// is itself a lane primary. The head exclusion below is not lane-scoped.
export function authorizedReserveIDs(context) {
  return grantsFor(context).laneGrants;
}

// A head with an active authorized grant is out of ordinary selection everywhere -- primary
// lanes, fallback rungs, inventory, held and sticky leases -- for as long as the grant lasts.
export function affectedHeadIDs(context) {
  return grantsFor(context).affectedHeadIDs;
}

export function automaticAllowed(target, context, purpose = 'ordinary') {
  if (!target) return false;
  if (purpose === 'reserve') return authorizedReserveIDs(context).some((grant) => grant.targetID === target.id);
  // A circuit stand-in is routable everywhere its head would be (held, sticky, inventory) while
  // the head's circuit lasts; like a grant's head exclusion, this is not lane-scoped.
  if (standInsFor(context).ids.has(target.id)) return true;
  return ordinaryAllowed(target, context) && !affectedHeadIDs(context).has(target.id);
}

// The one precedence rule for every automatic path: eligible ordinary primary, then an
// authorized reserve for an affected lane primary, then a circuit stand-in for a lane primary
// fenced by its own circuit, then the ordinary fallback ladder.
// `eligible` is the caller's existing upper fence; `pick(candidates, stage)` is the caller's
// existing weighted selection (stage is 'primary' or 'fallback'), so this never re-implements
// balancing, delays, or local share.
export function selectAutomatic({ primaryIDs, fallbackGroups, targets, context, eligible, pick }) {
  const ctx = snapshotOutageContext({ ...context, primaryIDs });
  const get = (ids) => ids.map((id) => targets[id]).filter(Boolean);
  const primary = get(primaryIDs).filter((target) => automaticAllowed(target, ctx) && eligible(target));
  if (primary.length) return { target: pick(primary, 'primary'), grant: null, source: 'primary' };
  for (const grant of authorizedReserveIDs(ctx)) {
    const target = targets[grant.targetID];
    if (target && eligible(target)) return { target, grant, source: 'reserve' };
  }
  for (const standIn of circuitStandIns(ctx)) {
    const target = targets[standIn.targetID];
    if (target && eligible(target)) return { target, grant: null, standIn, source: 'circuit-reserve' };
  }
  for (const group of fallbackGroups) {
    const fallback = get(group).filter((target) => automaticAllowed(target, ctx) && eligible(target));
    if (fallback.length) return { target: pick(fallback, 'fallback'), grant: null, source: 'fallback' };
  }
  return null;
}

// Nonsecret metadata classification, not scope verification. A model role (reviewed
// provider/family/id-pattern config) is MANAGED when one of its members is a policy primary
// or reserve. Every target the reviewed classification puts in a managed role is marked, so
// a catalog sibling whose record lacks family/speed fails closed in ordinaryAllowed instead of
// slipping past the head rule as "unrelated". Roles the policy never touches are left alone,
// and so is every target object that needs no mark (same reference back).
export function markManagedOutageScope(targets, { policy, modelRoles }) {
  if (!outageRoutingEnabled(policy) || !plainObject(targets)) return targets;
  const roleKeysOf = (target) => {
    const match = matchModelRole(target?.providerID, { id: target?.modelID, family: target?.family }, modelRoles);
    if (match.status === 'known') return [match.roleKey];
    // A conflicting classification that involves a managed role is still a managed candidate.
    return match.status === 'conflict' ? [...match.roleKeys] : [];
  };
  const managedRoles = new Set();
  for (const id of [...Object.keys(policy.primaryScope), ...reserveIDs(policy)]) {
    for (const key of roleKeysOf(targets[id])) managedRoles.add(key);
  }
  if (!managedRoles.size) return targets;
  let changed = false;
  const marked = {};
  for (const [id, target] of Object.entries(targets)) {
    const managed = target?.managedOutageScope !== true && roleKeysOf(target).some((key) => managedRoles.has(key));
    marked[id] = managed ? { ...target, managedOutageScope: true } : target;
    changed ||= managed;
  }
  return changed ? marked : targets;
}

// The staged model policy offers its probation candidate through a candidate-only selection
// (bin/opencode-broker). That offer is the existing staged path, not ordinary routing: for THAT
// call alone the candidate stands as its scope's head, so the gate still refuses aliases,
// listed reserves and ambiguous metadata but does not veto a reviewed staged trial. The
// ordinary heads object is never modified, so no probation-only target displaces the pin.
export function stagedCandidateHeads(heads, candidate, policy) {
  if (!outageRoutingEnabled(policy) || !candidate || candidate.canonicalModelID !== undefined) return heads;
  if (reserveIDs(policy).has(candidate.id)) return heads;
  const logicalID = scopeID(candidate);
  if (!policy.expectedScopePolicies[logicalID]) return heads;
  return { ...heads, [logicalID]: candidate.id };
}
