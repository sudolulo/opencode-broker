import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { createHealthAuthority } from './model-health.js';
import { createOutageWorker } from './model-outage-worker.js';
import { outageRoutingEnabled } from './outage-policy.js';

// Isolated outage-health probe assignments (plan Task 9). These maps are deliberately separate
// from ordinary candidate, reconciliation and compatibility-probe state: an assignment is only
// ever minted from the EXACT reservation the worker durably committed to
// read().providers[providerID].inflight, and it stays valid only while that durable reservation,
// its scope generation/credential instance and its episode are still current. This module never
// writes durable state, never refunds probe counts, and does no network or key I/O.

const TTL_MS = 10000;
const CAPACITY = 4096;
const RESERVATION_KEYS = ['id', 'nonce', 'logicalID', 'targetID', 'primaryID', 'providerID', 'kind', 'purpose',
  'episodeID', 'generation', 'expectedCredentialInstance', 'startedAt', 'expiresAt'];
const PURPOSE = 'outage-health';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => plain(object) && Object.hasOwn(object, key);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
// Bounded identifier: printable, no whitespace/control characters (episode IDs carry '/' and ':').
const token = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\0-\x1f\x7f]/.test(value);
// Reservation IDs become lease IDs, so they are restricted to a URL/header-safe alphabet.
const reservationID = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// Exactly 32 random bytes in canonical unpadded base64url (43 chars, zero padding bits): the
// worker's nonce and the credential-instance suffix. A non-canonical spelling is refused, so one
// byte string cannot be presented under two different textual identities.
const canonical32 = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const credentialInstance = (value) => typeof value === 'string' && value.startsWith('ci_') && canonical32(value.slice(3));
const exactKeys = (value) => plain(value) && Object.keys(value).length === RESERVATION_KEYS.length
  && RESERVATION_KEYS.every((key) => Object.hasOwn(value, key));

// Speed aliases: OpenCode synthesizes `<base>-fast` / `<base>-standard` from a base catalog
// record, and only the base id exists upstream (the speed travels in other body fields). Same
// contract as the gateway's leaseCoversWireModel and catalogModelForID in lib/model-candidates.js,
// narrowed to the suffix of the scope's own speed: the assignment keeps the alias as its model
// identity and puts the base id on the wire. Any other id, or a bare suffix, is the wire id as is.
const SPEED_SUFFIX = { fast: '-fast', standard: '-standard' };
function speedAliasBase(modelID, speed) {
  const suffix = Object.hasOwn(SPEED_SUFFIX, speed) ? SPEED_SUFFIX[speed] : null;
  return suffix && modelID.length > suffix.length && modelID.endsWith(suffix) ? modelID.slice(0, -suffix.length) : modelID;
}

// The reservation every caller-facing check is pinned to: returns the persisted reservation when
// `reservation` equals it field-for-field and the whole durable binding is current at `at`;
// otherwise null. Never infers a missing field and never consults anything but the current
// read() image, the static targets and the outage policy.
function currentBinding(reservation, { state, targets, policy, at }) {
  if (!integer(at) || !exactKeys(reservation) || !outageRoutingEnabled(policy)) return null;
  const r = reservation;
  if (!reservationID(r.id) || !canonical32(r.nonce) || !credentialInstance(r.expectedCredentialInstance)
    || !['logicalID', 'targetID', 'primaryID', 'providerID', 'episodeID'].every((key) => token(r[key]))
    || r.purpose !== PURPOSE || !['reserve', 'primary'].includes(r.kind)
    || !integer(r.generation) || !integer(r.startedAt) || !integer(r.expiresAt)
    || r.expiresAt <= r.startedAt || r.expiresAt > r.startedAt + TTL_MS || at < r.startedAt || at >= r.expiresAt) return null;
  // Exact current persisted occupancy; restored partial occupancy ({id, expiresAt}) never matches.
  const persisted = own(state?.providers, r.providerID) ? state.providers[r.providerID]?.inflight : null;
  if (!exactKeys(persisted) || !RESERVATION_KEYS.every((key) => persisted[key] === r[key])) return null;
  const scope = own(state.scopes, r.logicalID) ? state.scopes[r.logicalID] : null;
  if (!plain(scope) || scope.generation !== r.generation || scope.currentCredentialInstance !== r.expectedCredentialInstance) return null;
  const instance = own(scope.instances, r.expectedCredentialInstance) ? scope.instances[r.expectedCredentialInstance] : null;
  const episode = plain(instance) ? instance.episode : null;
  if (!plain(episode) || episode.id !== r.episodeID || episode.primaryID !== r.primaryID) return null;
  // A resolving snapshot or a real head success closes the episode while the probe's inflight
  // reservation can still be persisted (until probe-finished clears it): no authority after that.
  if (episode.resolved === true || episode.headHealthy === true) return null;
  // The policy must still vouch for this scope, provider, primary and (for reserves) mapping.
  const expected = own(policy.expectedScopePolicies, r.logicalID) ? policy.expectedScopePolicies[r.logicalID] : null;
  if (!plain(expected) || expected.providerID !== r.providerID) return null;
  if (!own(policy.primaryScope, r.primaryID) || policy.primaryScope[r.primaryID] !== r.logicalID) return null;
  const reserves = own(policy.mappings, r.primaryID) ? policy.mappings[r.primaryID] : null;
  if (r.kind === 'primary' ? r.targetID !== r.primaryID : !(Array.isArray(reserves) && reserves.includes(r.targetID))) return null;
  const target = own(targets, r.targetID) ? targets[r.targetID] : null;
  if (!plain(target) || target.providerID !== r.providerID || !token(target.modelID)) return null;
  return { reservation: structuredClone(persisted), target, expected };
}

export function createOutageAssignments({ now = Date.now, randomBytes = cryptoRandomBytes, read, targets, policy }) {
  // held: sessionID -> assignment (ephemeral; release removes it).
  // issued: reservation ID -> expiresAt (reuse guard; retained until the reservation's TTL).
  const held = new Map();
  const issued = new Map();
  let closed = false;
  // Highest valid clock reading this service has seen. The issued reuse guard is pruned at a
  // reservation's expiry, so if the wall clock then rewinds inside that window the same expired
  // reservation would look live and unissued again. Every issue/consume/lookup reading goes
  // through clock(): an invalid or regressed reading returns null, which fails every binding
  // check closed and prunes nothing. Operation resumes once the clock catches up.
  let highWater = -1;
  function clock() {
    const at = now();
    if (!integer(at) || at < highWater) return null;
    highWater = at;
    return at;
  }

  const binding = (reservation, at) => currentBinding(reservation, { state: read(), targets, policy, at });
  const live = (a, at) => binding(a.reservation, at) !== null;
  function prune(at) {
    // A null (invalid or regressed) clock prunes nothing; every binding check then fails closed.
    if (!integer(at)) return;
    for (const [id, expiresAt] of issued) if (expiresAt <= at) issued.delete(id);
    for (const [sessionID, a] of held) if (a.expiresAt <= at) held.delete(sessionID);
  }

  return {
    issue(reservation) {
      if (closed) throw new Error('outage assignment closed');
      const at = clock();
      prune(at);
      const bound = binding(reservation, at);
      if (!bound) throw new Error('outage assignment binding');
      const r = bound.reservation;
      if (issued.has(r.id)) throw new Error('outage assignment reuse');
      if (issued.size >= CAPACITY || held.size >= CAPACITY) throw new Error('outage assignment capacity');
      const entropy = randomBytes(32);
      if (!Buffer.isBuffer(entropy) || entropy.length !== 32) throw new Error('outage assignment entropy');
      const sessionID = `gw-probe-${entropy.toString('base64url')}`;
      if (held.has(sessionID)) throw new Error('outage assignment collision');
      const { modelID } = bound.target;
      const wireModelID = speedAliasBase(modelID, bound.expected.speed);
      const assignment = {
        ...r,
        reservation: structuredClone(r),
        reservationID: r.id,
        reservationNonce: r.nonce,
        sessionID,
        probeNonce: `pbn_${r.nonce}`,
        leaseID: `outage-${r.id}`,
        modelID,
        wireModelID,
        preferredModel: { providerID: r.providerID, modelID },
        expectedScopePolicy: structuredClone(bound.expected),
        // The health authority (lib/model-health.js issue) refuses any lookup result without held.
        held: true,
        used: false,
      };
      issued.set(r.id, r.expiresAt);
      held.set(sessionID, assignment);
      return structuredClone(assignment);
    },

    consume(input) {
      if (closed) throw new Error('outage assignment closed');
      const at = clock();
      prune(at);
      const { sessionID, probeNonce, purpose } = plain(input) ? input : {};
      const a = typeof sessionID === 'string' ? held.get(sessionID) : undefined;
      if (purpose !== PURPOSE || !a || a.used || typeof probeNonce !== 'string' || probeNonce !== a.probeNonce || !live(a, at)) {
        throw new Error('probe nonce binding');
      }
      // Synchronous mark-then-clone: a concurrent second consume can never observe used=false.
      a.used = true;
      return structuredClone(a);
    },

    lookupLease(input) {
      if (closed || !plain(input)) return null;
      const at = clock();
      prune(at);
      const { sessionID, leaseID, probeNonce, purpose } = input;
      const a = typeof sessionID === 'string' ? held.get(sessionID) : undefined;
      // Optional fields are checked only when supplied; the authority itself enforces exact
      // session + lease. A supplied empty string is a mismatch, not an omission.
      if (!a || !a.used || (leaseID !== undefined && leaseID !== a.leaseID)
        || (probeNonce !== undefined && probeNonce !== a.probeNonce)
        || (purpose !== undefined && purpose !== PURPOSE) || !live(a, at)) return null;
      return structuredClone(a);
    },

    release(input) {
      if (closed || !plain(input)) return;
      const { sessionID, probeNonce, leaseID } = input;
      const a = typeof sessionID === 'string' ? held.get(sessionID) : undefined;
      // Removes only the ephemeral held entry. The issued reuse guard and durable state stay.
      if (a && probeNonce === a.probeNonce && leaseID === a.leaseID) held.delete(sessionID);
    },

    close() {
      closed = true;
      held.clear();
      issued.clear();
    },
  };
}

// Production composition (plan Task 9): one assignments map, one health authority and one
// outage worker, built exactly once. The daemon starts the worker explicitly; this factory
// schedules nothing. Every durable change goes through the worker (and so through the shared
// serializer); this module writes nothing itself and never logs a capability or credential.
const PROVIDERS = ['anthropic', 'openai'];
const REQUIRED_FUNCTIONS = ['read', 'commit', 'fetchStatus', 'sendProbe', 'canProbe', 'serialize',
  'lookupOrdinaryLease', 'ordinaryRequest', 'verifyAttestation'];
const LOOKUP_KEYS = ['sessionID', 'leaseID', 'requestID', 'attemptID', 'purpose', 'modelID', 'bodySHA256'];

const receiptKey = (capability) => createHash('sha256').update(capability).digest('hex');

// Commit-time re-check of an accepted outcome against the image its commit reduces from. The
// authority checked generation and failure ordering at acceptance, but an earlier queued commit
// can move either before this one runs, and the reducer itself has no generation guard: without
// this, a stale accepted outcome could revert the current credential instance.
function currentOutcome(event, state) {
  const scope = own(state?.scopes, event.logicalID) ? state.scopes[event.logicalID] : null;
  const generation = integer(scope?.generation) ? scope.generation : 0;
  const expectedScopeMismatch = event.failureOrigin === 'proxy-scope' && event.result === 'scope-mismatch';
  const credentialInstance = expectedScopeMismatch ? event.expectedCredentialInstance : event.credentialInstance;
  const instance = own(scope?.instances, credentialInstance) ? scope.instances[credentialInstance] : null;
  const failureAt = integer(instance?.lastPrimaryFailureAt) ? instance.lastPrimaryFailureAt : 0;
  if (event.generation !== generation || !integer(event.startedAt) || event.startedAt < failureAt) {
    throw new Error('stale health outcome');
  }
}

export function createOutageService(options) {
  if (!plain(options)) throw new Error('outage service options');
  for (const name of REQUIRED_FUNCTIONS) if (typeof options[name] !== 'function') throw new Error(`outage service option ${name}`);
  if (typeof options.gatewayCredential !== 'string' || options.gatewayCredential.length === 0) {
    throw new Error('outage service option gatewayCredential');
  }
  const { policy, targets, now = Date.now, randomBytes = cryptoRandomBytes, read } = options;
  let closed = false;
  let closing = null;
  // Pending (not yet applied) outcome receipts keyed by SHA-256 of the capability, never the raw
  // capability. An entry lives exactly as long as its commit is in flight: dropping it by time
  // instead would let an identical replay start a second commit of the same outcome.
  const receipts = new Map();

  const scopeOf = (id) => {
    const state = read();
    return own(state?.scopes, id) ? state.scopes[id] : null;
  };
  const assignments = createOutageAssignments({ now, randomBytes, read, targets, policy });
  const authority = createHealthAuthority({
    gatewayCredential: options.gatewayCredential, now, randomBytes,
    // Purpose selects exactly one namespace. An outage-health begin never falls back to an
    // ordinary lease, and a real begin never sees an isolated probe assignment. Only the
    // whitelisted issuance fields are forwarded: the private credential stays here.
    lookupLease(input) {
      if (closed) return null;
      const query = Object.fromEntries(LOOKUP_KEYS.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
      if (input.purpose === PURPOSE) return assignments.lookupLease(query);
      if (input.purpose === 'real') return options.lookupOrdinaryLease(query);
      return null;
    },
    lookupGeneration(id) {
      const generation = scopeOf(id)?.generation;
      return integer(generation) ? generation : 0;
    },
    latestFailureAt(id, credential) {
      const scope = scopeOf(id);
      const instance = typeof credential === 'string' && own(scope?.instances, credential) ? scope.instances[credential] : null;
      return integer(instance?.lastPrimaryFailureAt) ? instance.lastPrimaryFailureAt : null;
    },
    verifyAttestation: options.verifyAttestation,
  });
  const timers = options.timers ?? globalThis;
  // leaseID -> { assignment, settle }. At most one waiter per issued assignment (and so per
  // reservation); every entry is removed by its own settle, whichever way it ends.
  const waiters = new Map();

  // The outcome waiter for ONE issued assignment. The closure fixes the assignment, its lease and
  // its expiry at issue time (before the gateway consumes it), so the gateway can register the
  // waiter before it sends anything. It resolves with the outcome only once that outcome has been
  // durably committed and marked applied; abort, expiry, probe end and close all resolve null.
  function outcomeWaiter(assignment, probeSignal) {
    let phase = 'idle'; // idle -> waiting -> done; finished before use -> done
    let settle = null;
    function waitForOutcome(leaseID, { signal } = {}) {
      if (leaseID !== assignment.leaseID) throw new Error('outage waiter lease');
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('outage waiter signal');
      if (phase === 'finished') return Promise.resolve(null);
      if (phase !== 'idle') throw new Error('outage waiter reuse');
      phase = 'waiting';
      const at = now();
      const ttl = integer(at) ? Math.min(assignment.expiresAt - at, TTL_MS) : 0;
      if (closed || ttl <= 0 || signal?.aborted || probeSignal?.aborted) {
        phase = 'done';
        return Promise.resolve(null);
      }
      if (waiters.has(leaseID) || waiters.size >= CAPACITY) {
        phase = 'done';
        throw new Error('outage waiter capacity');
      }
      return new Promise((resolve) => {
        const expire = () => settle(null);
        const timer = timers.setTimeout(expire, ttl);
        const entry = { assignment, settle: null };
        settle = (value) => {
          if (phase !== 'waiting') return;
          phase = 'done';
          timers.clearTimeout(timer);
          signal?.removeEventListener('abort', expire);
          probeSignal?.removeEventListener('abort', expire);
          if (waiters.get(leaseID) === entry) waiters.delete(leaseID);
          resolve(value);
        };
        entry.settle = settle;
        waiters.set(leaseID, entry);
        signal?.addEventListener('abort', expire, { once: true });
        probeSignal?.addEventListener('abort', expire, { once: true });
      });
    }
    return {
      waitForOutcome,
      // The probe is over: settle an outstanding waiter now rather than leave it to its TTL.
      finish() {
        if (phase === 'waiting') settle(null);
        else if (phase === 'idle') phase = 'finished';
      },
    };
  }

  // leaseID -> issued assignment, held only while its runProbe runs (so bounded by the held
  // assignment cap). A probe outcome may commit only while this binding is live.
  const probes = new Map();

  // Commit-time check for a probe outcome, against the image the commit reduces from. Its ticket
  // could have been issued before a resolving snapshot (or a real head success, or the probe's
  // end), with the generation unchanged; the reducer would then rebuild a proof for a closed
  // episode. So the probe's exact reservation must still be the persisted, unexpired inflight one
  // for the current scope, credential instance and open episode, and the outcome must match it.
function liveProbeOutcome(leaseID, event, state) {
    const assignment = probes.get(leaseID);
    const r = assignment?.reservation;
    if (!r || assignment.leaseID !== leaseID || leaseID !== `outage-${r.id}`
      || !currentBinding(r, { state, targets, policy, at: now() })
      || event.logicalID !== r.logicalID || event.primaryID !== r.primaryID || event.targetID !== r.targetID
      || event.providerID !== r.providerID || event.generation !== r.generation
      || (event.failureOrigin === 'proxy-scope' && event.result === 'scope-mismatch'
        ? event.expectedCredentialInstance !== r.expectedCredentialInstance
        : event.credentialInstance !== r.expectedCredentialInstance)) throw new Error('stale health outcome');
  }

  const worker = createOutageWorker({
    policy, now, read, randomBytes, commit: options.commit, fetchStatus: options.fetchStatus, canProbe: options.canProbe,
    timers: options.timers, serialize: options.serialize, onError: options.onError,
    // Always returns null: the outcome is applied by the authenticated outcome path, never here,
    // so the worker cannot observe it a second time. Transport failures propagate to the worker.
    async runProbe(reservation, { signal }) {
      const assignment = assignments.issue(reservation);
      if (probes.has(assignment.leaseID) || probes.size >= CAPACITY) {
        assignments.release(assignment);
        throw new Error('outage probe capacity');
      }
      probes.set(assignment.leaseID, assignment);
      const waiter = outcomeWaiter(assignment, signal);
      try {
        await options.sendProbe(structuredClone(assignment), { signal, waitForOutcome: waiter.waitForOutcome });
        return null;
      } finally {
        waiter.finish();
        if (probes.get(assignment.leaseID) === assignment) probes.delete(assignment.leaseID);
        assignments.release(assignment);
      }
    },
  });

  async function applyOutcome(body) {
    const accepted = authority.accept(body);
    if (accepted.duplicate) return { ok: true, duplicate: true };
    const key = receiptKey(body.capability);
    const pending = receipts.get(key);
    if (pending) {
      // An identical replay of an outcome whose commit is still running shares that commit.
      await pending;
      return { ok: true, duplicate: true };
    }
    if (receipts.size >= CAPACITY) throw new Error('outcome receipt capacity');
    const { outcome } = accepted;
    const work = (async () => {
      await worker.observe(outcome, { validate(event, state) {
        currentOutcome(event, state);
        if (event.purpose === PURPOSE) liveProbeOutcome(accepted.leaseID, event, state);
      } });
      // Only a committed outcome is marked applied; a failed commit leaves it retryable.
      authority.markApplied(body.capability);
    })();
    receipts.set(key, work);
    try {
      await work;
    } finally {
      if (receipts.get(key) === work) receipts.delete(key);
    }
    // Committed and marked applied: only now may the exact probe lease's waiter see it.
    const waiter = waiters.get(accepted.leaseID);
    if (waiter && outcome.purpose === PURPOSE && outcome.logicalID === waiter.assignment.logicalID
      && outcome.targetID === waiter.assignment.targetID && outcome.providerID === waiter.assignment.providerID) {
      waiter.settle(structuredClone(outcome));
    }
    // A newly applied qualifying real primary fault asks for its own provider's status only;
    // reserve faults never open an episode, and probe outcomes never chain another dispatch.
    if (outageRoutingEnabled(policy) && outcome.purpose === 'real' && outcome.targetID === outcome.primaryID
      && ['service-fault', 'auth-fault'].includes(outcome.result) && PROVIDERS.includes(outcome.providerID)) {
      worker.requestPoll(outcome.providerID);
    }
    return { ok: true, duplicate: false };
  }

  return {
    worker,
    assignments,
    async request(path, body) {
      if (path === '/model-health/begin' || path === '/model-health/outcome') {
        if (closed) throw new Error('outage service closed');
        if (!plain(body)) throw new Error('model health request');
        if (body.purpose === PURPOSE && !outageRoutingEnabled(policy)) throw new Error('outage probes require active mode');
        return path === '/model-health/begin' ? authority.issue(body) : applyOutcome(body);
      }
      if ((path === '/probe/consume' || path === '/probe/release') && plain(body) && body.purpose === PURPOSE) {
        if (closed) throw new Error('outage service closed');
        if (!outageRoutingEnabled(policy)) throw new Error('outage probes require active mode');
        if (path === '/probe/consume') return assignments.consume(body);
        // Removes the ephemeral held entry only; durable probe counts and cooldowns stay.
        assignments.release(body);
        return { ok: true };
      }
      // Ordinary paths: the private gateway credential never reaches the ordinary handler.
      let forwarded = body;
      if (plain(body) && Object.hasOwn(body, 'gatewayCredential')) {
        const { gatewayCredential: _discarded, ...rest } = body;
        forwarded = rest;
      }
      const result = await options.ordinaryRequest(path, forwarded);
      // Ordinary failure handling stays unchanged; it only nudges a nonblocking status poll.
      if (outageRoutingEnabled(policy) && path === '/failure') for (const providerID of PROVIDERS) worker.requestPoll(providerID);
      return result;
    },
    close() {
      if (!closing) {
        closed = true;
        // Settling clears each waiter's timer and listeners and lets its probe finish.
        for (const waiter of [...waiters.values()]) waiter.settle(null);
        closing = (async () => {
          try {
            await worker.close();
            await Promise.allSettled([...receipts.values()]);
          } finally {
            assignments.close();
            authority.close();
          }
        })();
      }
      return closing;
    },
  };
}
