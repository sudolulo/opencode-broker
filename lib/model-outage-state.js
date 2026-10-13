import { emptyOutages } from './model-outages.js';

// Optional-state decoder for the persisted `outages` property of broker.json (plan Task 9,
// pulled forward for Task 7's daemon integration). The whole-file parser stays fatal on
// corrupt JSON; this receives the already-parsed optional property and WHITELISTS the Task 5
// state shape (lib/model-outages.js). Everything it cannot vouch for degrades to a state that
// authorizes nothing:
//   - an absent/foreign/oversized document restores nothing (fresh instances start
//     `recoveryRequired: true`, so no failure can open an episode until a real current-head
//     success re-arms the scope);
//   - an incomplete episode is dropped and its instance stays `recoveryRequired: true`;
//   - every episode phase is restored as 'diagnosing' -- the reducer recomputes it from the
//     restored facts (proofs, failures, diagnosis), it is never trusted from disk;
//   - feed snapshots are never restored as freshly received: the worker polls again;
//   - terminal history keeps its episode facts but never its proofs, so it can never read as a
//     current grant.
// The retired `closed` latch (Task 5) is not used: fail-closed here means "not restored".
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const integerOrNull = (value) => (value === null ? null : integer(value) ? value : null);
const pastIntegerOrNull = (value, now) => (integerOrNull(value) !== null && value <= now ? value : null);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);
const token = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\0-\x1f\x7f]/.test(value);
const targetID = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,180}$/.test(value);
// Keep this persisted-state boundary aligned with isCanonicalCredentialInstance in
// model-outage-runtime.js without importing that runtime's startup dependencies.
const credentialID = (value) => typeof value === 'string' && /^ci_[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value.slice(3), 'base64url').toString('base64url') === value.slice(3);
const stringList = (value, max) => Array.isArray(value) && value.length <= 64 && value.every((item) => token(item, max));
const PHASES = new Set(['diagnosing', 'provisional', 'confirmed', 'suppressed-unconfirmed', 'recovered', 'resolved']);
const FEED_PROVIDERS = new Set(['anthropic', 'openai']);
const RESERVATION_STRINGS = ['id', 'nonce', 'logicalID', 'targetID', 'primaryID', 'providerID', 'kind', 'purpose', 'episodeID', 'expectedCredentialInstance'];

// A complete Task 5 episode, or null. `credentialInstance` must equal the owning instance key;
// history entries supply their recorded owner, but still need the same valid identity tuple.
function decodeEpisode(raw, { policy, logicalID, credentialInstance, lastNow, now }) {
  if (!plain(raw)) return null;
  const primaryID = raw.primaryID;
  const expected = own(policy.expectedScopePolicies, logicalID) ? policy.expectedScopePolicies[logicalID] : null;
  const reserves = own(policy.mappings, primaryID) ? policy.mappings[primaryID] : null;
  const ownerOK = credentialID(raw.credentialInstance) && raw.credentialInstance === credentialInstance;
  const complete = ownerOK && expected && FEED_PROVIDERS.has(expected.providerID) && logicalID.split('/')[0] === expected.providerID &&
    targetID(primaryID) && own(policy.primaryScope, primaryID) && policy.primaryScope[primaryID] === logicalID &&
    Array.isArray(reserves) && token(raw.id) && raw.id === `${logicalID}:${credentialInstance}:${raw.firstFailureAt}` &&
    integer(raw.firstFailureAt) && raw.firstFailureAt <= lastNow && integer(raw.deadline) && raw.deadline === raw.firstFailureAt + 600000 &&
    plain(raw.probeCounts) && ['reserve', 'primary'].every((kind) => integer(raw.probeCounts[kind]) && raw.probeCounts[kind] <= 2) &&
    // reserveProbe durably advances probe clocks, but not the reducer's outcome clock.
    (raw.probeCounts.reserve + raw.probeCounts.primary === 0 ? raw.lastProbeAt === null
      : integer(raw.lastProbeAt) && raw.lastProbeAt >= raw.firstFailureAt && raw.lastProbeAt <= now) &&
    ['suppressed', 'resolved', 'headHealthy', 'diagnosed'].every((flag) => typeof raw[flag] === 'boolean') &&
    Array.isArray(raw.failures) && raw.failures.length > 0 && raw.failures.length <= 64 &&
    raw.failures.every((failure) => plain(failure) && integer(failure.at) && failure.at >= raw.firstFailureAt && failure.at <= lastNow && token(failure.requestID) && token(failure.attemptID)) &&
    plain(raw.proofs) && stringList(raw.incidentIDs, 512) &&
    (raw.resolvedAt === undefined || raw.resolvedAt === null || (integer(raw.resolvedAt) && raw.resolvedAt <= lastNow)) &&
    (raw.resolvedIncidentIDs === undefined || stringList(raw.resolvedIncidentIDs, 512));
  if (!complete) return null;
  // Reject the size before reading any member; one bad member invalidates the whole episode.
  const proofIDs = Object.keys(raw.proofs);
  if (proofIDs.length > reserves.length) return null;
  const proofs = {};
  for (const id of proofIDs) {
    const proof = raw.proofs[id];
    if (!targetID(id) || !reserves.includes(id) || !plain(proof) || !integer(proof.at) ||
      proof.at < raw.firstFailureAt || proof.at > lastNow || typeof proof.active !== 'boolean') return null;
    proofs[id] = { at: proof.at, active: proof.active };
  }
  return {
    id: raw.id,
    primaryID: raw.primaryID,
    credentialInstance: raw.credentialInstance,
    firstFailureAt: raw.firstFailureAt,
    deadline: raw.deadline,
    phase: 'diagnosing',
    suppressed: raw.suppressed,
    resolved: raw.resolved,
    resolvedAt: raw.resolvedAt ?? null,
    resolvedIncidentIDs: [...(raw.resolvedIncidentIDs ?? [])],
    headHealthy: raw.headHealthy,
    diagnosed: raw.diagnosed,
    failures: raw.failures.map((failure) => ({ at: failure.at, requestID: failure.requestID, attemptID: failure.attemptID })),
    probeCounts: { reserve: raw.probeCounts.reserve, primary: raw.probeCounts.primary },
    lastProbeAt: raw.lastProbeAt,
    proofs,
    incidentIDs: [...raw.incidentIDs],
  };
}

function decodeReservation(raw, { policy, state, providerID, lastProbeAt, now }) {
  // Reservations are short-lived dispatch occupancy, not durable authority. Retain them only
  // while live within their 10-second TTL; never turn a corrupt future expiry into a lease.
  if (!plain(raw) || !token(raw.id) || !integer(raw.expiresAt) || raw.expiresAt <= now || raw.expiresAt > now + 10000) return null;
  const whole = RESERVATION_STRINGS.every((key) => token(raw[key])) &&
    integer(raw.generation) && integer(raw.startedAt) && raw.startedAt <= now && raw.expiresAt === raw.startedAt + 10000;
  // A reservation that is not whole still occupies the provider until its original expiry
  // (that blocks dispatch); only a whole one can ever resume an authority assignment.
  if (!whole) return { id: raw.id, expiresAt: raw.expiresAt };
  const scope = state.scopes[raw.logicalID];
  const instance = scope?.instances[scope.currentCredentialInstance];
  const episode = instance?.episode;
  const expected = own(policy.expectedScopePolicies, raw.logicalID) ? policy.expectedScopePolicies[raw.logicalID] : null;
  const targetValid = raw.kind === 'primary' ? raw.targetID === raw.primaryID
    : raw.kind === 'reserve' && own(policy.mappings, raw.primaryID) && policy.mappings[raw.primaryID].includes(raw.targetID);
  if (!expected || expected.providerID !== providerID || raw.providerID !== providerID || raw.purpose !== 'outage-health' ||
    !['reserve', 'primary'].includes(raw.kind) || !targetValid || !episode || episode.headHealthy || episode.resolved || raw.generation !== scope.generation ||
    raw.expectedCredentialInstance !== scope.currentCredentialInstance || raw.primaryID !== episode.primaryID || raw.episodeID !== episode.id ||
    raw.startedAt !== episode.lastProbeAt || raw.startedAt !== lastProbeAt || episode.probeCounts[raw.kind] < 1) return { id: raw.id, expiresAt: raw.expiresAt };
  return {
    ...Object.fromEntries(RESERVATION_STRINGS.map((key) => [key, raw[key]])),
    generation: raw.generation,
    startedAt: raw.startedAt,
    expiresAt: raw.expiresAt,
  };
}

export function decodeOutages(raw, { policy, now = Date.now() } = {}) {
  const out = emptyOutages();
  if (raw === undefined || raw === null) return out;
  if (!policy?.enabled || !plain(raw) || raw.version !== 1 || !plain(raw.scopes) || !integer(raw.lastNow) || !integer(now) || raw.lastNow > now) return out;
  out.lastNow = raw.lastNow;
  const scopes = Object.entries(raw.scopes);
  if (scopes.length <= 128) {
    for (const [logicalID, rawScope] of scopes) {
      if (!own(policy.expectedScopePolicies, logicalID) || !plain(rawScope) || !plain(rawScope.instances) ||
        !integer(rawScope.generation) || rawScope.generation < 1 || !credentialID(rawScope.currentCredentialInstance)) continue;
      const instances = Object.entries(rawScope.instances);
      if (instances.length > 16) continue;
      const scope = {
        generation: rawScope.generation,
        currentCredentialInstance: rawScope.currentCredentialInstance,
        instances: {},
      };
      for (const [credentialInstance, rawInstance] of instances) {
        if (!credentialID(credentialInstance) || !plain(rawInstance)) continue;
        const baselineAt = integerOrNull(rawInstance.baselineAt);
        const lastPrimaryFailureAt = integerOrNull(rawInstance.lastPrimaryFailureAt);
        const lastSeenAt = integerOrNull(rawInstance.lastSeenAt);
        const episode = rawInstance.episode === null ? null : decodeEpisode(rawInstance.episode, { policy, logicalID, credentialInstance, lastNow: out.lastNow, now });
        const current = credentialInstance === rawScope.currentCredentialInstance;
        // Noncurrent instances can rotate back into service. They need exactly the same
        // evidence as the current owner; stripping proofs alone cannot make a bad graph safe.
        const timestampsOK = baselineAt !== null && lastSeenAt !== null && baselineAt <= lastSeenAt && lastSeenAt <= out.lastNow &&
          (rawInstance.lastPrimaryFailureAt === null || (lastPrimaryFailureAt !== null && lastPrimaryFailureAt <= lastSeenAt));
        const armed = timestampsOK && scope.generation >= 2 && rawInstance.recoveryRequired === false &&
          (rawInstance.episode === null || (episode !== null && baselineAt <= episode.firstFailureAt &&
            lastPrimaryFailureAt !== null && lastPrimaryFailureAt >= episode.firstFailureAt &&
            episode.failures.every((failure) => failure.at <= lastPrimaryFailureAt)));
        scope.instances[credentialInstance] = {
          baselineAt: baselineAt !== null && baselineAt <= out.lastNow ? baselineAt : null,
          // Only an instance with a real baseline that explicitly recorded `false` comes back
          // armed. An instance whose episode did not decode stays recoveryRequired until a real
          // current-head success re-arms it, so it cannot reopen on failures alone.
          recoveryRequired: !armed,
          lastPrimaryFailureAt: lastPrimaryFailureAt !== null && lastPrimaryFailureAt <= out.lastNow ? lastPrimaryFailureAt : null,
          lastSeenAt: lastSeenAt !== null && lastSeenAt <= out.lastNow ? lastSeenAt : null,
          pendingAuth: [],
          episode: armed && episode ? { ...episode, proofs: current ? episode.proofs : {} } : null,
        };
      }
      if (!own(scope.instances, scope.currentCredentialInstance)) {
        scope.currentCredentialInstance = null;
        for (const instance of Object.values(scope.instances)) { instance.episode = null; instance.recoveryRequired = true; }
      }
      out.scopes[logicalID] = scope;
    }
  }
  for (const [providerID, rawProvider] of Object.entries(plain(raw.providers) ? raw.providers : {})) {
    if (!FEED_PROVIDERS.has(providerID) || !plain(rawProvider)) continue;
    // Provider clocks are wall-clock observations and must not be restored beyond this decode's
    // `now`. Episode probe clocks differ: reserveProbe advances them without advancing lastNow.
    const lastPollAt = pastIntegerOrNull(rawProvider.lastPollAt, now);
    const lastProbeAt = pastIntegerOrNull(rawProvider.lastProbeAt, now);
    out.providers[providerID] = {
      lastPollAt,
      lastProbeAt,
      inflight: decodeReservation(rawProvider.inflight, { policy, state: out, providerID, lastProbeAt, now }),
    };
  }
  if (Array.isArray(raw.history)) {
    for (const entry of raw.history.slice(-64)) {
      if (!plain(entry) || !own(policy.primaryScope, entry.primaryID)) continue;
      const logicalID = policy.primaryScope[entry.primaryID];
      const episode = decodeEpisode(entry, { policy, logicalID, credentialInstance: entry.credentialInstance, lastNow: out.lastNow, now });
      if (!episode) continue;
      out.history.push({ ...episode, proofs: {}, phase: PHASES.has(entry.phase) ? entry.phase : 'recovered' });
    }
  }
  return out;
}
