// Subscription-quota API continuation: the pure authority/config foundation.
//
// Everything here is shape and context validation over data the caller already holds. Nothing
// reads config, credentials, balances, prices or the network, and nothing computes a financial
// policy hash. A well-formed value is NOT proof of origin: the broker must still prove the actual
// source lease, the actual manual admission and the current circuit before it calls mintSpendGrant.
// The stated trust boundary is the same local user: an operator with direct IPC or credential
// access is out of scope, and none of this is a cryptographic claim against one.
import { createHash, randomUUID } from 'node:crypto';
import { normalizeApiSpendGrant } from './api-spend-grant.js';
import { manualApiAdmission } from './manual-api.js';

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_SOURCE_PROVIDERS = 32;
export const MAX_GRANT_TTL_MS = 300_000;
// Default record cap. The broker passes its own assignment cap (MAX_ASSIGNMENTS, 512 today).
const DEFAULT_MAX_RECORDS = 512;
// Bounded response body accepted by the quota parser (the gateway's own usage-limit bound).
const MAX_QUOTA_BODY_LENGTH = 16_384;
// OpenAI may send resets_at (absolute seconds) and resets_in_seconds (relative). Both are whole
// seconds measured at slightly different instants, so exact equality would refuse real
// responses; a disagreement beyond this many milliseconds is a contradiction and refuses.
// 5000ms is a CONSERVATIVE comparison budget chosen for availability, not a measured provider
// latency guarantee. When both forms agree within it, the EARLIER of the two is used, so the
// resulting authority never extends past either provider hint.
const RESET_AGREEMENT_MS = 5_000;
const MAX_DATE_MS = 8.64e15;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Fail-closed finite horizons on recognized closed quota evidence, with no extra slack: a reset
// further from now than its window could be is not trusted as a subscription window, so a
// far-future (say year-2100) reset cannot keep paid continuation enabled while the ordinary source
// is held forever. Applied in normalizeSubscriptionQuota, so every wire and persisted-state path
// revalidates against the current now. 31 days is a conservative maximum for a recognized
// subscription window; anything longer or unknown is a manual-intervention case, not automatic
// spend. A legitimate response right at a boundary under clock skew may be refused: that is an
// accepted availability cost. This bounds routing authority only; it is not the financial epoch.
const QUOTA_HORIZON_MS = Object.freeze({
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * DAY_MS,
  usage_limit: 31 * DAY_MS,
});
const UNIFIED_HEADER_PREFIX = 'anthropic-ratelimit-unified-';
// Codex (first-party OpenAI) limit headers. x-codex-rate-limit-reached-type names WHICH limit a
// usage_limit_reached response hit; only the rolling subscription window is a quota we continue
// past. Credit and workspace outcomes are billing, so any other present value refuses. The
// x-codex-credits-* headers describe paid extra-usage credits, not availability, and are ignored.
const CODEX_HEADER_PREFIX = 'x-codex-';
const CODEX_REACHED_TYPE_HEADER = 'x-codex-rate-limit-reached-type';
const CODEX_ROLLING_REACHED_TYPE = 'rate_limit_reached';
const KEYS = Object.freeze(['enabled', 'sourceProviders', 'targets', 'spendPolicyHashes', 'grantTTLms']);
const POLICY_KEYS = Object.freeze([...KEYS, 'revision']);
const RECORD_KEYS = Object.freeze(['sourceLeaseID', 'sourceTargetID', 'sourceModelID', 'sourceProviderID', 'sourceAuthRevision',
  'observedAtMs', 'circuitKind', 'circuitUpdatedAtMs', 'circuitUntilMs', 'policyRevision', 'quotaEvidenceClosed']);
const QUOTA_KEYS = Object.freeze(['version', 'kind', 'window', 'resetAtMs']);
// Provider-wide windows only. A model-scoped claim (seven_day_opus, seven_day_sonnet, or any other)
// exhausts one model family, not the subscription, so it is never continuation proof (deny-only).
const ANTHROPIC_WINDOWS = Object.freeze(['five_hour', 'seven_day']);
// Exported so the broker uses this one list rather than a copy (bin/opencode-broker).
export const NON_GENERATION_TIERS = Object.freeze(['classifier', 'embedding']);
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DURABLE_SESSION_ID = /^ses_[A-Za-z0-9]{1,124}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// Wording that names something other than a subscription usage window: billing, credit, plan
// lapse, fast-mode/extra-usage credits, authentication, or a per-minute burst limit. Any of it
// next to an otherwise positive signal is a contradiction, and a contradiction refuses.
const CONTRADICTION = /billing|credit|balance|payment|insufficient|fast[ _-]?mode|extra[ _-]usage|overage|lapse|expired|cancel|renew|\bauth(entication|orization)?\b|unauthori[sz]ed|per[ _-]minute|\b[rt]pm\b|burst/i;

const fail = (message) => { throw new Error(`apiContinuation: ${message}`); };
const invalidAuthorization = () => { const error = new Error('invalid spend authorization'); error.code = 'invalid_authorization'; throw error; };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && !/[\0-\x1f\x7f]/.test(value);
const time = (value) => Number.isSafeInteger(value);
const validDateMs = (value) => time(value) && value > 0 && value <= MAX_DATE_MS;
// A diagnostic names the offending key, bounded and quoted; it never echoes a value.
const label = (value) => JSON.stringify(String(value).slice(0, 64));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreeze(item)])));
  return value;
}

// ---- 1. policy ------------------------------------------------------------------------------

const manualIdentity = (manualApiTargets, id) => {
  const entry = record(manualApiTargets) && Object.hasOwn(manualApiTargets, id) ? manualApiTargets[id] : undefined;
  if (!record(entry) || !identifier(entry.providerID) || !identifier(entry.modelID)) return null;
  return entry;
};

// The ROUTING revision: binds every input that decides whether, and to what, continuation may
// route, including the static provider/model identity behind each target and pin ID. It is not
// the financial policy hash, which the broker never computes.
const routingRevision = ({ enabled, sourceProviders, targets, spendPolicyHashes, grantTTLms }, manualApiTargets) => {
  const identity = (id) => { const entry = manualIdentity(manualApiTargets, id); return [entry.providerID, entry.modelID]; };
  return sha256(JSON.stringify({
    version: 1,
    enabled,
    sourceProviders,
    targets: Object.keys(targets).map((id) => [id, ...identity(id), targets[id]]),
    spendPolicyHashes: Object.keys(spendPolicyHashes).map((id) => [id, ...identity(id), spendPolicyHashes[id]]),
    grantTTLms,
  }));
};

export const normalizeApiContinuation = (raw, { manualApiTargets, tierNames } = {}) => {
  const block = raw === undefined ? {} : raw;
  if (!plain(block)) fail('must be an object');
  for (const key of Object.keys(block)) if (!KEYS.includes(key)) fail(`unknown key ${label(key)}`);
  const registry = record(manualApiTargets) ? manualApiTargets : {};
  const paidProviders = new Set(Object.keys(registry).map((id) => manualIdentity(registry, id)?.providerID).filter(Boolean));
  const generationTiers = new Set((Array.isArray(tierNames) ? tierNames : [])
    .filter((tier) => typeof tier === 'string' && !NON_GENERATION_TIERS.includes(tier)));

  if (block.enabled !== undefined && typeof block.enabled !== 'boolean') fail('enabled must be true or false');
  const enabled = block.enabled === true;

  // An explicit operator OAuth allowlist. It deliberately does not consult
  // trustedSubscriptionProviders, which exists for API-key subscription exemptions.
  const rawSources = block.sourceProviders === undefined ? [] : block.sourceProviders;
  if (!Array.isArray(rawSources)) fail('sourceProviders must be an array of provider IDs');
  if (rawSources.length > MAX_SOURCE_PROVIDERS) fail(`sourceProviders may name at most ${MAX_SOURCE_PROVIDERS} providers`);
  if (enabled && rawSources.length === 0) fail('sourceProviders must name at least one subscription provider when enabled');
  const sourceSet = new Set();
  for (const [index, providerID] of rawSources.entries()) {
    if (typeof providerID !== 'string' || !PROVIDER_ID.test(providerID)) fail(`sourceProviders[${index}] is not a valid provider ID`);
    if (sourceSet.has(providerID)) fail(`sourceProviders[${index}] ${label(providerID)} is a duplicate`);
    if (paidProviders.has(providerID)) fail(`sourceProviders[${index}] ${label(providerID)} is a registered paid manual API provider`);
    sourceSet.add(providerID);
  }

  const rawTargets = block.targets === undefined ? {} : block.targets;
  if (!plain(rawTargets)) fail('targets must be an object from manual API target IDs to tier arrays');
  const targets = {};
  for (const id of Object.keys(rawTargets).sort()) {
    if (!manualIdentity(registry, id)) fail(`targets ${label(id)} is not a registered manualApiTargets target`);
    const tiers = rawTargets[id];
    if (!Array.isArray(tiers) || tiers.length === 0) fail(`targets ${label(id)} must name a nonempty tier array`);
    if (new Set(tiers).size !== tiers.length) fail(`targets ${label(id)} has duplicate tiers`);
    for (const tier of tiers) {
      if (typeof tier !== 'string' || !generationTiers.has(tier)) fail(`targets ${label(id)} names ${label(tier)}, which is not a generation tier`);
    }
    targets[id] = [...tiers].sort();
  }

  const rawPins = block.spendPolicyHashes === undefined ? {} : block.spendPolicyHashes;
  if (!plain(rawPins)) fail('spendPolicyHashes must be an object from manual API target IDs to financial policy hashes');
  const spendPolicyHashes = {};
  for (const id of Object.keys(rawPins).sort()) {
    if (!manualIdentity(registry, id)) fail(`spendPolicyHashes ${label(id)} is not a registered manualApiTargets target`);
    if (typeof rawPins[id] !== 'string' || !HEX64.test(rawPins[id])) fail(`spendPolicyHashes ${label(id)} must be 64 lowercase hex characters`);
    spendPolicyHashes[id] = rawPins[id];
  }
  if (enabled) {
    for (const id of Object.keys(targets)) {
      if (!Object.hasOwn(spendPolicyHashes, id)) fail(`spendPolicyHashes must pin continuation target ${label(id)} while enabled`);
    }
  }

  const grantTTLms = block.grantTTLms === undefined ? MAX_GRANT_TTL_MS : block.grantTTLms;
  if (!Number.isSafeInteger(grantTTLms) || grantTTLms < 1 || grantTTLms > MAX_GRANT_TTL_MS) fail(`grantTTLms must be an integer from 1 through ${MAX_GRANT_TTL_MS}`);

  const canonical = { enabled, sourceProviders: [...sourceSet].sort(), targets, spendPolicyHashes, grantTTLms };
  return deepFreeze({ ...canonical, revision: routingRevision(canonical, registry) });
};

export const DISABLED_API_CONTINUATION = normalizeApiContinuation(undefined);

// ---- 2. sessions ----------------------------------------------------------------------------

// Native OpenCode session IDs only. Gateway one-shots (gw-), probes (gw-probe-), rig sessions and
// any other caller-chosen ID are not durable conversations.
export const durableOpenCodeSessionID = (sessionID) => typeof sessionID === 'string' && DURABLE_SESSION_ID.test(sessionID);

// AUTOMATIC continuation only. Named, manual, private, offline and local profiles never qualify;
// this does not restrict an explicit manual grant, which mintSpendGrant handles separately.
export const continuationSessionEligible = ({ sessionID, profile, oneShot, api } = {}) =>
  profile === 'auto' && durableOpenCodeSessionID(sessionID) &&
  (oneShot === undefined || oneShot === false) && (api === undefined || api === null);

// The REQUEST-side gates of the broker's late paid-continuation branch (bin/opencode-broker,
// inside the refusal path), as one pure predicate so every gate is table-testable. Everything
// fails closed. It deliberately does NOT judge the session's continuation record: record
// currency needs live broker state (circuits, inventory, auth.json) and stays in the broker.
//   refusalCode            only the terminal usage-limit / no-eligible-target answers; a wait
//                          (preparing, busy), a local-only or unresolvable refusal is never
//                          overridden by paid;
//   policy                 an enabled normalized policy;
//   probe                  true for a model-probe assignment (never paid);
//   localOnly / api        a LAN-only request or a non-generation API never goes paid; `api`
//                          must be exactly null (the broker's normalized generation API);
//   sessionID/profile/oneShot  continuationSessionEligible: durable ses_ ID, auto profile;
//   tier / tierNames       a configured route tier that is a generation tier; no tier list
//                          means nothing can be proven, so false;
//   policyTargetID / blockedGeneration  a staged model-policy candidate or blocked generation
//                          the late branch cannot prove exhausted;
//   includesLocal / localResidencyUnknown  a lane with a local target whose residency probe
//                          FAILED is not proof the local route is gone.
export const lateContinuationRequestEligible = ({
  refusalCode, policy, probe, localOnly, api, sessionID, profile, tier, oneShot,
  policyTargetID, blockedGeneration, includesLocal, localResidencyUnknown, tierNames,
} = {}) =>
  (refusalCode === 'usage-limit' || refusalCode === 'no-eligible-target') &&
  policy?.enabled === true && !probe && !localOnly && api === null &&
  continuationSessionEligible({ sessionID, profile, oneShot, api }) &&
  Array.isArray(tierNames) && typeof tier === 'string' && tierNames.includes(tier) && !NON_GENERATION_TIERS.includes(tier) &&
  !policyTargetID && !blockedGeneration &&
  !(includesLocal && localResidencyUnknown);

// ---- 3. subscription quota evidence ---------------------------------------------------------

export const normalizeSubscriptionQuota = (value, { now } = {}) => {
  if (!time(now) || !exactKeys(value, QUOTA_KEYS) || value.version !== 1) return null;
  const windowOK = value.kind === 'anthropic-unified' ? ANTHROPIC_WINDOWS.includes(value.window)
    : value.kind === 'openai-usage-limit' ? value.window === 'usage_limit' : false;
  if (!windowOK || !validDateMs(value.resetAtMs) || value.resetAtMs <= now) return null;
  if (value.resetAtMs - now > QUOTA_HORIZON_MS[value.window]) return null;
  return Object.freeze({ version: 1, kind: value.kind, window: value.window, resetAtMs: value.resetAtMs });
};

const secondsToMs = (seconds) => {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const ms = seconds * 1000;
  return validDateMs(ms) ? ms : null;
};

// Parses an actual provider response: status, the bounded raw body string and native Headers.
// Only two typed signals are positive; everything else, including broad quota wording and a bare
// Retry-After, is null. The result's shape says nothing about where it came from.
export const extractSubscriptionQuota = ({ status, body, headers, now } = {}) => {
  if (status !== 429 || !time(now)) return null;
  if (headers !== undefined && headers !== null && !(headers instanceof Headers)) return null;
  const header = (name) => (headers ? headers.get(name) : null);
  let parsed = null;
  if (body !== undefined && body !== null && body !== '') {
    if (typeof body !== 'string' || body.length > MAX_QUOTA_BODY_LENGTH) return null;
    try { parsed = JSON.parse(body); } catch { return null; }
    if (!plain(parsed)) return null;
  }
  const error = parsed === null ? null : parsed.error;
  if (error !== undefined && error !== null && !plain(error)) return null;
  const field = (key) => (error && Object.hasOwn(error, key) ? error[key] : undefined);
  const message = field('message');
  if (message !== undefined && typeof message !== 'string') return null;
  if (typeof message === 'string' && CONTRADICTION.test(message)) return null;
  const type = field('type');
  const code = field('code');
  for (const value of [type, code]) if (value !== undefined && value !== null && typeof value !== 'string') return null;
  // Known optional metadata. Present and non-null, each must be a string free of contradiction
  // wording; it can only refuse, never create a signal, and it is never stored. Any other field is
  // ignored and the raw body is never persisted. Compatibility with live provider wording here is
  // unverified: a mismatch fails closed (no automatic continuation), never open.
  for (const key of ['param', 'plan_type']) {
    const value = field(key);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || CONTRADICTION.test(value)) return null;
  }
  const openaiSignal = type === 'usage_limit_reached' || code === 'usage_limit_reached';
  const unifiedStatus = header('anthropic-ratelimit-unified-status');

  if (unifiedStatus !== null) {
    // Any unified status other than an outright rejection is not exhaustion, and an OpenAI signal
    // alongside Anthropic headers is two providers' answers in one response: both refuse.
    if (unifiedStatus !== 'rejected' || openaiSignal) return null;
    // Any Codex header next to Anthropic unified headers is likewise a cross-provider mix.
    for (const name of headers.keys()) if (name.startsWith(CODEX_HEADER_PREFIX)) return null;
    if (type !== undefined && type !== null && type !== 'rate_limit_error') return null;
    if (code !== undefined && code !== null) return null;
    const window = header('anthropic-ratelimit-unified-representative-claim');
    if (!ANTHROPIC_WINDOWS.includes(window)) return null;
    const reset = header('anthropic-ratelimit-unified-reset');
    if (typeof reset !== 'string' || !/^[0-9]{1,15}$/.test(reset)) return null;
    const resetAtMs = secondsToMs(Number(reset));
    if (resetAtMs === null) return null;
    for (const key of ['resets_at', 'resets_in_seconds']) if (field(key) !== undefined) return null;
    return normalizeSubscriptionQuota({ version: 1, kind: 'anthropic-unified', window, resetAtMs }, { now });
  }

  if (!openaiSignal) return null;
  // Any unified Anthropic header without the Anthropic status path above is two providers'
  // signals in one response (or an incomplete Anthropic one): refuse rather than pick one.
  if (headers) for (const name of headers.keys()) if (name.startsWith(UNIFIED_HEADER_PREFIX)) return null;
  // Optional metadata that can only refuse: absent is allowed; present must be exactly the rolling
  // window. Native Headers joins repeats with ", ", so a repeated header refuses too.
  const reachedType = header(CODEX_REACHED_TYPE_HEADER);
  if (reachedType !== null && reachedType !== CODEX_ROLLING_REACHED_TYPE) return null;
  // Both type and code, where present, must say exactly the same thing.
  for (const value of [type, code]) if (value !== undefined && value !== null && value !== 'usage_limit_reached') return null;
  const resetsAt = field('resets_at');
  const resetsIn = field('resets_in_seconds');
  const absolute = resetsAt === undefined ? undefined : secondsToMs(resetsAt);
  const relative = resetsIn === undefined ? undefined : secondsToMs(resetsIn);
  if (absolute === null || relative === null) return null;
  const relativeAt = relative === undefined ? undefined : now + relative;
  const candidates = [absolute, relativeAt].filter((value) => value !== undefined);
  if (candidates.length === 0) return null;
  if (candidates.length === 2 && Math.abs(absolute - relativeAt) > RESET_AGREEMENT_MS) return null;
  // Every supplied form must itself be valid closed evidence (future, within the horizon);
  // the earliest one is the reset.
  const quota = (resetAtMs) => normalizeSubscriptionQuota({ version: 1, kind: 'openai-usage-limit', window: 'usage_limit', resetAtMs }, { now });
  if (!candidates.every((value) => quota(value) !== null)) return null;
  return quota(Math.min(...candidates));
};

// DENIAL ONLY. The broker's later exact /failure consumes an observation /quota-evidence already
// stored from an actual typed 429; this decides whether the failure the plugin reports CONTRADICTS
// it. `false` is never positive proof by itself. `text` is the sanitized provider error text,
// `statusCode` its SDK status. Contradicted: any CONTRADICTION wording; any upstream "HTTP nnn"
// other than 429; any known status other than 429, except the gateway's outer 502 when it wraps
// an explicit nested upstream 429. A missing status is compatible only because the stored
// observation already proves the 429.
const UPSTREAM_STATUS = /\bHTTP\s+([0-9]{3})\b/gi;
const NESTED_UPSTREAM_429 = /\bupstream\s+\S+\s+HTTP\s+429\b/i;
export const subscriptionQuotaFailureContradicted = ({ text, statusCode } = {}) => {
  if (typeof text !== 'string' || text.length > MAX_QUOTA_BODY_LENGTH) return true;
  if (CONTRADICTION.test(text)) return true;
  const upstream = [...text.matchAll(UPSTREAM_STATUS)].map((match) => match[1]);
  if (upstream.some((status) => status !== '429')) return true;
  if (statusCode === undefined || statusCode === null || statusCode === 429) return false;
  if (statusCode === 502) return !NESTED_UPSTREAM_429.test(text);
  return true;
};

// ---- 4. persisted continuation records ------------------------------------------------------

// One closed record, valid at `now`, or null. The circuit must be an exact 'quota' circuit that
// was updated no earlier than the observation and not after now, still in force, and ending at
// exactly the closed evidence's reset.
export const normalizeApiContinuationRecord = (value, { now } = {}) => {
  if (!time(now) || !exactKeys(value, RECORD_KEYS)) return null;
  for (const key of ['sourceLeaseID', 'sourceTargetID', 'sourceModelID', 'sourceProviderID', 'sourceAuthRevision']) {
    if (!identifier(value[key])) return null;
  }
  const { observedAtMs, circuitUpdatedAtMs, circuitUntilMs } = value;
  if (![observedAtMs, circuitUpdatedAtMs, circuitUntilMs].every(validDateMs)) return null;
  if (!(observedAtMs <= circuitUpdatedAtMs && circuitUpdatedAtMs <= now && now < circuitUntilMs)) return null;
  if (value.circuitKind !== 'quota' || typeof value.policyRevision !== 'string' || !HEX64.test(value.policyRevision)) return null;
  const quotaEvidenceClosed = normalizeSubscriptionQuota(value.quotaEvidenceClosed, { now });
  if (!quotaEvidenceClosed || quotaEvidenceClosed.resetAtMs !== circuitUntilMs) return null;
  return Object.freeze({
    sourceLeaseID: value.sourceLeaseID,
    sourceTargetID: value.sourceTargetID,
    sourceModelID: value.sourceModelID,
    sourceProviderID: value.sourceProviderID,
    sourceAuthRevision: value.sourceAuthRevision,
    observedAtMs,
    circuitKind: 'quota',
    circuitUpdatedAtMs,
    circuitUntilMs,
    policyRevision: value.policyRevision,
    quotaEvidenceClosed,
  });
};

// Decodes untrusted persisted state. Malformed records and non-durable keys are dropped (no
// authority), never repaired; the result is bounded newest-first, ties broken by session ID.
export const normalizeApiContinuationRecords = (raw, { now, max = DEFAULT_MAX_RECORDS } = {}) => {
  if (!time(now)) throw new TypeError('normalizeApiContinuationRecords: now must be a safe integer');
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('normalizeApiContinuationRecords: max must be a positive safe integer');
  if (!plain(raw)) return Object.freeze({});
  const kept = [];
  for (const sessionID of Object.keys(raw)) {
    if (!durableOpenCodeSessionID(sessionID)) continue;
    const normalized = normalizeApiContinuationRecord(raw[sessionID], { now });
    if (normalized) kept.push([sessionID, normalized]);
  }
  kept.sort(([aID, a], [bID, b]) => (b.circuitUpdatedAtMs - a.circuitUpdatedAtMs) ||
    (b.observedAtMs - a.observedAtMs) || (aID < bID ? -1 : aID > bID ? 1 : 0));
  return Object.freeze(Object.fromEntries(kept.slice(0, max)));
};

// ---- 5. source eligibility and current authority --------------------------------------------

// The normalized manual registry shape lib/manual-api.js returns: a plain object (possibly empty)
// from target ID to {providerID, modelID, profiles}. Anything else is a missing or malformed
// registry, and every caller below fails closed on it rather than treating it as "no paid targets".
const validManualRegistry = (registry) => plain(registry) && Object.values(registry).every((entry) =>
  record(entry) && identifier(entry.providerID) && identifier(entry.modelID) &&
  Array.isArray(entry.profiles) && entry.profiles.length > 0 && entry.profiles.every(identifier));

const registeredPaid = (manualApiTargets, target) => Object.hasOwn(manualApiTargets, target.id) ||
  Object.values(manualApiTargets).some((entry) => entry.providerID === target.providerID);

export const sourceTargetEligible = ({ target, policy, provider, liveAuthType, manualApiTargets } = {}) =>
  validManualRegistry(manualApiTargets) &&
  record(policy) && policy.enabled === true && Array.isArray(policy.sourceProviders) &&
  record(target) && identifier(target.id) && identifier(target.providerID) && identifier(target.modelID) &&
  target.kind === 'cloud' && target.source === 'subscription-oauth' &&
  policy.sourceProviders.includes(target.providerID) &&
  record(provider) && provider.connected === true && provider.authType === 'oauth' && liveAuthType === 'oauth' &&
  !registeredPaid(manualApiTargets, target);

// Whether a stored record is STILL authority right now. The fences:
//   - the routing revision and the source identity (target, provider, model) are exact;
//   - liveSourceAuthRevision -- the SOURCE provider's own auth.json entry revision
//     (providerAuthRevision) -- is a readable, non-"absent" value equal to the record's
//     sourceAuthRevision, so only that provider's credential change revokes the record;
//   - separately, liveAuthRevision (the live whole-file authSnapshot revision) is non-null and
//     equal to inventoryAuthRevision (the published inventory's), so routing never acts on
//     inventory discovered against another auth configuration. An unrelated provider's entry
//     moving the file makes this transiently false; it does not touch the record fence;
//   - the circuit is an unreasoned 'quota' circuit with a known reset that still covers the
//     record: circuit.until >= record.circuitUntilMs, record.circuitUntilMs > now, and
//     record.circuitUpdatedAtMs <= circuit.updatedAt. A re-stamp (same or later reset, later
//     updatedAt) keeps the record current; the grant stays clipped to the record's own end.
// A circuit that was cleared, shortened, re-kinded or lost its known reset is not current, and a
// plan window with no actual failure never has such a circuit to match.
export const continuationAuthorityCurrent = ({ record: stored, policy, sourceTarget, provider, liveAuthType, circuit,
  liveSourceAuthRevision, liveAuthRevision, inventoryAuthRevision, manualApiTargets, now } = {}) => {
  const current = normalizeApiContinuationRecord(stored, { now });
  if (!current) return false;
  if (!sourceTargetEligible({ target: sourceTarget, policy, provider, liveAuthType, manualApiTargets })) return false;
  if (current.policyRevision !== policy.revision) return false;
  if (current.sourceTargetID !== sourceTarget.id || current.sourceProviderID !== sourceTarget.providerID ||
    current.sourceModelID !== sourceTarget.modelID) return false;
  if (!identifier(liveSourceAuthRevision) || liveSourceAuthRevision === 'absent' ||
    liveSourceAuthRevision !== current.sourceAuthRevision) return false;
  if (!identifier(liveAuthRevision) || inventoryAuthRevision !== liveAuthRevision) return false;
  if (!record(circuit) || Object.hasOwn(circuit, 'reason') || circuit.kind !== 'quota' || circuit.resetKnown !== true) return false;
  if (!time(circuit.until) || !time(circuit.updatedAt)) return false;
  return circuit.until >= current.circuitUntilMs && current.circuitUntilMs > now && current.circuitUpdatedAtMs <= circuit.updatedAt;
};

// Whether a stored record can NEVER become current again, so the caller may delete it. True only
// for permanent conditions:
//   - liveSourceAuthRevision is a string (including "absent") that differs from the record's;
//   - the circuit is missing, not a quota circuit, or ends before the record's own end;
//   - the record's own end (circuitUntilMs) is at or before now;
//   - the routing policyRevision differs from the record's;
//   - identityOK === false (the caller found the source target/provider/model drifted).
// Everything else is NOT permanent: an unreadable source entry (null/undefined), a circuit that
// lost its known reset or was re-stamped, an unknown identity (anything but false), stale
// inventory. A non-object record has nothing to keep and is reported permanent.
export const continuationRecordPermanentlyInvalid = ({ record: stored, circuit, liveSourceAuthRevision, policyRevision, now, identityOK } = {}) => {
  if (!record(stored)) return true;
  if (typeof liveSourceAuthRevision === 'string' && liveSourceAuthRevision !== stored.sourceAuthRevision) return true;
  // Written as the literal comparisons (not negated >=/>) so a malformed until or now compares
  // false and is never mistaken for permanent loss.
  if (!record(circuit) || circuit.kind !== 'quota' || circuit.until < stored.circuitUntilMs) return true;
  if (stored.circuitUntilMs <= now) return true;
  if (policyRevision !== stored.policyRevision) return true;
  return identityOK === false;
};

// ---- 6. grant minting -----------------------------------------------------------------------

// A normalized policy (normalizeApiContinuation's output shape), every target and pin ID of which
// is registered in the supplied manual registry. Shape only: this does not re-derive the revision.
const validPolicy = (policy, manualApiTargets) => exactKeys(policy, POLICY_KEYS) && typeof policy.enabled === 'boolean' &&
  Array.isArray(policy.sourceProviders) && policy.sourceProviders.every((id) => typeof id === 'string' && PROVIDER_ID.test(id)) &&
  plain(policy.targets) && Object.entries(policy.targets).every(([id, tiers]) =>
    Object.hasOwn(manualApiTargets, id) && Array.isArray(tiers) && tiers.every(identifier)) &&
  plain(policy.spendPolicyHashes) && Object.entries(policy.spendPolicyHashes).every(([id, pin]) =>
    Object.hasOwn(manualApiTargets, id) && typeof pin === 'string' && HEX64.test(pin)) &&
  Number.isSafeInteger(policy.grantTTLms) && policy.grantTTLms >= 1 && policy.grantTTLms <= MAX_GRANT_TTL_MS &&
  typeof policy.revision === 'string' && HEX64.test(policy.revision);

// Builds a grant from the caller-supplied normalized policy and manual registry, then delegates
// every canonical check to normalizeApiSpendGrant as the final step. The grant's policyRevision is
// the paid target's FINANCIAL pin, read ONLY from policy.spendPolicyHashes[target.id]; it is never
// the routing revision. A legacy policyRevision argument is accepted only if it equals that pin.
// Whether the configured pin matches the gateway's financial policy is checked by the gateway
// later; it cannot be deduced here. Both purposes require the target to be exactly its static
// manual registration (provider, model, cloud kind, no subscription source marker).
//   manual       -- the policy may be disabled with no continuation targets (manual-only pins);
//                   requires actual manualApiAdmission for the profile, so auto, manual, offline
//                   and unregistered profiles cannot mint. Named one-shot session IDs are valid.
//   continuation -- requires an enabled policy listing the target with this generation tier, a TTL
//                   within policy.grantTTLms, a durable auto session and a valid closed record.
// This is context validation, NOT a cryptographic proof of broker origin: the caller must still
// have proven the actual manual admission or current continuation authority.
export const mintSpendGrant = (args) => {
  if (!plain(args)) invalidAuthorization();
  const { purpose, sessionID, leaseID, target, profile, tier, policy, manualApiTargets, policyRevision: legacyPin, ttlMs, now, record: stored } = args;
  if (purpose !== 'manual' && purpose !== 'continuation') invalidAuthorization();
  if (!time(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_GRANT_TTL_MS) invalidAuthorization();
  if (!validManualRegistry(manualApiTargets) || !validPolicy(policy, manualApiTargets)) invalidAuthorization();
  if (!record(target) || !identifier(target.id) || !Object.hasOwn(manualApiTargets, target.id)) invalidAuthorization();
  const registration = manualApiTargets[target.id];
  if (target.kind !== 'cloud' || target.source !== undefined ||
    target.providerID !== registration.providerID || target.modelID !== registration.modelID) invalidAuthorization();
  if (!Object.hasOwn(policy.spendPolicyHashes, target.id)) invalidAuthorization();
  const policyRevision = policy.spendPolicyHashes[target.id];
  if (legacyPin !== undefined && legacyPin !== policyRevision) invalidAuthorization();
  let source = null;
  let expiresAtMs = now + ttlMs;
  if (purpose === 'manual') {
    if (stored !== undefined && stored !== null) invalidAuthorization();
    if (manualApiAdmission(target, profile, manualApiTargets) !== true) invalidAuthorization();
  } else {
    if (policy.enabled !== true || !Object.hasOwn(policy.targets, target.id)) invalidAuthorization();
    if (typeof tier !== 'string' || NON_GENERATION_TIERS.includes(tier) || !policy.targets[target.id].includes(tier)) invalidAuthorization();
    if (ttlMs > policy.grantTTLms) invalidAuthorization();
    if (profile !== 'auto' || !durableOpenCodeSessionID(sessionID)) invalidAuthorization();
    const evidence = normalizeApiContinuationRecord(stored, { now });
    if (!evidence) invalidAuthorization();
    source = {
      providerID: evidence.sourceProviderID,
      targetID: evidence.sourceTargetID,
      leaseID: evidence.sourceLeaseID,
      modelID: evidence.sourceModelID,
      quotaObservedAtMs: evidence.observedAtMs,
      quotaUntilMs: evidence.circuitUntilMs,
    };
    expiresAtMs = Math.min(expiresAtMs, evidence.circuitUntilMs);
  }
  const grant = {
    version: 1, grantID: randomUUID(), purpose, sessionID, leaseID, targetID: target.id, providerID: target.providerID,
    modelID: target.modelID, profile, tier, issuedAtMs: now, expiresAtMs, policyRevision, source,
  };
  return normalizeApiSpendGrant(grant, { now, sessionID, leaseID, targetID: target.id, providerID: target.providerID, modelID: target.modelID });
};
