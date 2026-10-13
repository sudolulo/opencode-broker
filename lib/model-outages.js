// Pure, durable model-outage episode reducer. Time is supplied by callers so replaying
// persisted state is deterministic and cannot accidentally extend an episode.
export const emptyOutages = () => ({ version: 1, scopes: {}, snapshots: {}, providers: {}, history: [], lastNow: 0 });

const providerState = (state, providerID) => state.providers[providerID]
  ?? (state.providers[providerID] = { lastPollAt: null, lastProbeAt: null, inflight: null });
const fresh = (snapshot, now) => snapshot?.status === 'valid' && snapshot.receivedAt <= now && now - snapshot.receivedAt <= 120000;
const isProxyOrigin = (origin) => typeof origin === 'string' && origin.startsWith('proxy-');
const isServiceOrigin = (origin) => origin === 'upstream-http' || origin === 'upstream-response';

function episodeView(state, logicalID, policy, now) {
  if (!policy.enabled || !policy.expectedScopePolicies[logicalID]) return null;
  const scope = state.scopes[logicalID];
  const instance = scope?.instances[scope.currentCredentialInstance];
  const episode = instance?.episode;
  if (!episode) return null;
  const snapshot = state.snapshots[policy.expectedScopePolicies[logicalID].providerID];
  const ids = fresh(snapshot, now) ? snapshot.matches[episode.primaryID] ?? [] : [];
  const window = episode.failures.filter((failure) => failure.at <= now && now - failure.at <= 60000);
  const diagnosed = episode.diagnosed === true || (ids.length > 0 && episode.failures.length > 0)
    || (window.length >= 3 && new Set(window.map((failure) => failure.requestID)).size >= 2);
  return { scope, instance, episode, ids, diagnosed };
}

function refreshPhases(state, policy, now) {
  for (const logicalID of Object.keys(state.scopes)) {
    const view = episodeView(state, logicalID, policy, now);
    if (!view) continue;
    const { episode, ids, diagnosed } = view;
    episode.diagnosed ||= diagnosed;
    if (now >= episode.deadline) episode.suppressed = true;
    episode.incidentIDs = [...new Set([...episode.incidentIDs, ...ids])].slice(-64);
    const proof = Object.values(episode.proofs).some((entry) => entry.active || (entry.at <= now && now - entry.at <= 120000));
    episode.phase = episode.resolved ? 'resolved'
      : episode.headHealthy ? 'recovered'
      : ids.length && diagnosed && proof ? 'confirmed'
        : episode.suppressed ? 'suppressed-unconfirmed'
          : diagnosed && proof ? 'provisional' : 'diagnosing';
  }
}

function recordEligiblePrimaryFailure(instance, event) {
  // The stale fence only moves forward: replayed pending-auth failures can finish earlier
  // than failures already recorded, and a backwards fence would re-admit stale successes.
  instance.lastPrimaryFailureAt = Math.max(instance.lastPrimaryFailureAt ?? 0, event.finishedAt);
  if (instance.recoveryRequired || instance.baselineAt === null) return;
  // The persisted decoder rejects an episode holding a failure before its first failure.
  if (instance.episode && event.finishedAt < instance.episode.firstFailureAt) return;
  const credentialInstance = event.credentialInstance;
  const episode = instance.episode ?? (instance.episode = {
    id: `${event.logicalID}:${credentialInstance}:${event.finishedAt}`,
    primaryID: event.primaryID,
    credentialInstance,
    firstFailureAt: event.finishedAt,
    deadline: event.finishedAt + 600000,
    phase: 'diagnosing',
    suppressed: false,
    resolved: false,
    resolvedAt: null,
    resolvedIncidentIDs: [],
    headHealthy: false,
    diagnosed: false,
    failures: [],
    probeCounts: { reserve: 0, primary: 0 },
    lastProbeAt: null,
    proofs: {},
    incidentIDs: [],
  });
  episode.headHealthy = false;
  if (!episode.failures.some((failure) => failure.attemptID === event.attemptID)) {
    episode.failures.push({ at: event.finishedAt, requestID: event.requestID, attemptID: event.attemptID });
  }
  episode.failures = episode.failures.slice(-64);
}

function recordOutcome(state, event, policy, now) {
  // Proxy rejections never reached an upstream. Their attested credential is often a
  // refused candidate, so they must not even allocate instance state.
  if (event.failureOrigin === 'proxy-scope' && event.result === 'scope-mismatch'
    && policy.expectedScopePolicies[event.logicalID]) {
    const scope = state.scopes[event.logicalID];
    const credentialInstance = event.expectedCredentialInstance;
    if (scope?.currentCredentialInstance === credentialInstance && scope.generation === event.generation) {
      const episode = scope.instances[credentialInstance]?.episode;
      if (episode) episode.proofs = {};
    }
    return;
  }
  if (isProxyOrigin(event.failureOrigin)) return;
  if (!isServiceOrigin(event.failureOrigin)) return;
  if (!event.credentialInstance || !policy.expectedScopePolicies[event.logicalID]) return;

  let scope = state.scopes[event.logicalID];
  if (!scope) {
    scope = state.scopes[event.logicalID] = { generation: 0, currentCredentialInstance: null, instances: {} };
  }
  const credentialInstance = event.credentialInstance;
  if (!scope.instances[credentialInstance]) {
    if (Object.keys(scope.instances).length >= 16) {
      const evictable = Object.entries(scope.instances)
        .filter(([id]) => id !== scope.currentCredentialInstance)
        .sort(([, left], [, right]) => (left.lastSeenAt ?? 0) - (right.lastSeenAt ?? 0))[0];
      if (evictable) delete scope.instances[evictable[0]];
    }
    scope.instances[credentialInstance] = { baselineAt: null, recoveryRequired: true, lastPrimaryFailureAt: null, episode: null, pendingAuth: [], lastSeenAt: event.finishedAt };
  }
  const instance = scope.instances[credentialInstance];
  instance.lastSeenAt = Math.max(instance.lastSeenAt ?? 0, event.finishedAt);
  // Stale events are fenced before rotation so they cannot switch the current instance,
  // bump the generation, or clear proofs. A brand-new instance has no fence yet.
  if (event.startedAt < (instance.lastPrimaryFailureAt ?? 0)) return;
  if (scope.currentCredentialInstance !== credentialInstance) {
    scope.currentCredentialInstance = credentialInstance;
    scope.generation++;
    for (const other of Object.values(scope.instances)) if (other.episode) other.episode.proofs = {};
  }
  const primary = event.targetID === event.primaryID;

  if (primary && event.result === 'success' && event.purpose === 'real') {
    if (instance.episode) state.history.push({ ...instance.episode, phase: 'recovered' });
    state.history = state.history.slice(-64);
    instance.episode = null;
    instance.pendingAuth = [];
    instance.baselineAt = Math.max(instance.baselineAt ?? 0, event.finishedAt);
    instance.recoveryRequired = false;
    scope.generation++;
    return;
  }
  if (primary && event.result === 'success' && event.purpose === 'outage-health'
    && instance.baselineAt !== null && !instance.recoveryRequired && instance.episode) {
    state.history.push({ ...instance.episode, phase: 'recovered' });
    state.history = state.history.slice(-64);
    instance.episode = null;
    instance.pendingAuth = [];
    instance.baselineAt = Math.max(instance.baselineAt, event.finishedAt);
    instance.recoveryRequired = false;
    scope.generation++;
    return;
  }
  if (primary && event.purpose === 'real' && ['service-fault', 'auth-fault'].includes(event.result)) {
    const snapshot = state.snapshots[event.providerID];
    const authEligible = event.result !== 'auth-fault'
      || (fresh(snapshot, now) && (snapshot.authMatches?.[event.primaryID]?.length ?? 0) > 0);
    if (!authEligible) {
      if (!instance.pendingAuth.some((failure) => failure.attemptID === event.attemptID)) instance.pendingAuth.push(structuredClone(event));
      instance.pendingAuth = instance.pendingAuth.slice(-64);
      return;
    }
    recordEligiblePrimaryFailure(instance, event);
    return;
  }
  if (!primary && instance.episode && policy.mappings[instance.episode.primaryID]?.includes(event.targetID)) {
    if (event.result === 'success' && event.startedAt >= (instance.lastPrimaryFailureAt ?? 0)) {
      instance.episode.proofs[event.targetID] = {
        at: event.finishedAt,
        active: instance.episode.proofs[event.targetID]?.active === true || event.purpose === 'real',
      };
    } else {
      delete instance.episode.proofs[event.targetID];
    }
  }
}

export function reduceOutages(input, event, { policy, now }) {
  const state = structuredClone(input ?? emptyOutages());
  // Legacy persisted state may contain this retired latch; it no longer controls availability.
  delete state.closed;
  if (!Number.isSafeInteger(now) || now < state.lastNow) return state;
  state.lastNow = now;
  if (event.type === 'poll-start') providerState(state, event.providerID).lastPollAt = now;
  if (event.type === 'probe-finished') {
    const provider = providerState(state, event.providerID);
    if (provider.inflight?.id === event.id) provider.inflight = null;
  }
  if (event.type === 'snapshot') {
    state.snapshots[event.providerID] = event.status === 'valid' && event.receivedAt <= now
      ? structuredClone(event) : { ...event, status: 'unknown', matches: {}, resolved: [] };
    if (fresh(state.snapshots[event.providerID], now)) {
      for (const [logicalID, scope] of Object.entries(state.scopes)) {
        if (policy.expectedScopePolicies[logicalID]?.providerID !== event.providerID) continue;
        for (const instance of Object.values(scope.instances)) {
          instance.pendingAuth = (instance.pendingAuth ?? []).filter((failure) => now - failure.finishedAt <= 60000
            && (instance.baselineAt === null || failure.startedAt >= instance.baselineAt));
          const eligible = instance.pendingAuth.filter((failure) => (event.authMatches?.[failure.primaryID]?.length ?? 0) > 0);
          instance.pendingAuth = instance.pendingAuth.filter((failure) => !eligible.includes(failure));
          // Replay applies the same stale fence a live outcome does (recordOutcome).
          for (const failure of eligible.sort((left, right) => left.finishedAt - right.finishedAt)) {
            if (failure.startedAt < (instance.lastPrimaryFailureAt ?? 0)) continue;
            recordEligiblePrimaryFailure(instance, failure);
          }
          if (!instance.episode) continue;
          const resolvedIDs = event.resolvedIncidentIDs?.[instance.episode.primaryID] ?? [];
          if (resolvedIDs.some((id) => instance.episode.incidentIDs.includes(id))) {
            instance.episode.resolved = true;
            instance.episode.resolvedAt = event.receivedAt;
            instance.episode.resolvedIncidentIDs = [...new Set([...instance.episode.resolvedIncidentIDs ?? [], ...resolvedIDs])].slice(-64);
            // Active proofs never expire, so a later re-match must re-verify a reserve rather
            // than revive a grant from a pre-resolution proof. Bounds and counters stay as-is.
            instance.episode.proofs = {};
          } else if (instance.episode.resolved && event.receivedAt > (instance.episode.resolvedAt ?? Infinity)
            && (event.matches?.[instance.episode.primaryID]?.length ?? 0) > 0) {
            instance.episode.resolved = false;
          }
        }
      }
    }
  }
  if (event.type === 'activate') {
    const scope = state.scopes[event.logicalID];
    const episode = scope?.instances[event.credentialInstance]?.episode;
    if (scope?.currentCredentialInstance === event.credentialInstance && episode?.proofs[event.targetID]
      && outageGrants(state, policy, now).some((grant) => grant.logicalID === event.logicalID && grant.targetID === event.targetID)) {
      episode.proofs[event.targetID].active = true;
    }
  }
  if (event.type === 'outcome') recordOutcome(state, event, policy, now);
  refreshPhases(state, policy, now);
  return state;
}

export function outageGrants(input, policy, now) {
  if (!policy.enabled || now < input.lastNow) return [];
  const state = structuredClone(input);
  refreshPhases(state, policy, now);
  const grants = [];
  for (const [logicalID, scope] of Object.entries(state.scopes)) {
    const episode = scope.instances[scope.currentCredentialInstance]?.episode;
    if (!episode || !['provisional', 'confirmed'].includes(episode.phase)) continue;
    for (const targetID of policy.mappings[episode.primaryID] ?? []) {
      const proof = episode.proofs[targetID];
      if (!proof || !(proof.active || (proof.at <= now && now - proof.at <= 120000))) continue;
      grants.push({ logicalID, primaryID: episode.primaryID, targetID, credentialInstance: scope.currentCredentialInstance,
        generation: scope.generation, episodeID: episode.id, mode: episode.phase });
    }
  }
  return grants;
}

export function reserveProbe(input, request, { policy }) {
  const state = structuredClone(input);
  const { logicalID, targetID, kind, id, nonce, now } = request;
  if (!Number.isSafeInteger(now) || now < state.lastNow) return null;
  refreshPhases(state, policy, now);
  const view = episodeView(state, logicalID, policy, now);
  if (!view || !['reserve', 'primary'].includes(kind)) return null;
  const { scope, episode, diagnosed } = view;
  const providerID = policy.expectedScopePolicies[logicalID].providerID;
  const provider = providerState(state, providerID);
  if (!diagnosed || episode.resolved || episode.headHealthy || episode.probeCounts.reserve + episode.probeCounts.primary >= 4
    || episode.probeCounts[kind] >= 2 || (provider.inflight && provider.inflight.expiresAt > now)
    || (provider.lastProbeAt !== null && now - provider.lastProbeAt < 60000)
    || (episode.lastProbeAt !== null && now - episode.lastProbeAt < 60000)) return null;
  if ((kind === 'reserve' && !policy.mappings[episode.primaryID].includes(targetID))
    || (kind === 'primary' && targetID !== episode.primaryID)) return null;
  if (kind === 'reserve' && episode.suppressed && !view.ids.length) return null;
  episode.probeCounts[kind]++;
  episode.lastProbeAt = now;
  provider.lastProbeAt = now;
  const reservation = { id, nonce, logicalID, targetID, primaryID: episode.primaryID, providerID, kind, purpose: 'outage-health',
    episodeID: episode.id, generation: scope.generation, expectedCredentialInstance: scope.currentCredentialInstance, startedAt: now, expiresAt: now + 10000 };
  provider.inflight = reservation;
  return { state, reservation };
}

export function nextProbe(state, policy, now) {
  for (const logicalID of Object.keys(state.scopes).sort()) {
    const view = episodeView(state, logicalID, policy, now);
    if (!view || !view.diagnosed || view.episode.resolved || view.episode.headHealthy) continue;
    const active = Object.values(view.episode.proofs).some((proof) => proof.active || (proof.at <= now && now - proof.at <= 120000));
    const candidates = active ? [{ targetID: view.episode.primaryID, kind: 'primary' }]
      : (policy.mappings[view.episode.primaryID] ?? []).map((targetID) => ({ targetID, kind: 'reserve' }));
    for (const candidate of candidates) if (reserveProbe(state, { logicalID, ...candidate, id: 'check', nonce: 'check', now }, { policy })) return { logicalID, ...candidate };
  }
  return null;
}
