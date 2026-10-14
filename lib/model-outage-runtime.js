// Daemon runtime contract for model outage reserves (plan Task 9): what an ENABLED outage
// policy needs before the broker may listen, and the pure lookups the daemon wires into the
// outage service. Nothing here schedules, persists, or talks to the network.
//
// Startup dependencies, all REQUIRED when CONFIG.modelOutages.enabled === true and never read
// otherwise (the daemon does not even import this module's readers on the disabled path):
//   OPENCODE_BROKER_OUTAGE_GATEWAY_URL            gateway origin probes are sent through. Bare
//                                                 http(s) origin only; no default is guessed.
//   OPENCODE_BROKER_GATEWAY_KEY_FILE              front-door key (same source and default as the
//                                                 gateway and the reconciler).
//   OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE private gateway->broker capability credential
//                                                 (the gateway's own opt-in field).
//   OPENCODE_BROKER_HEALTH_KEY_FILE               optional override of the MAC key path, default
//                                                 <routing state dir>/model-health.key. Read with
//                                                 the strict secure-file reader; never created.
// Credentials live in process memory only; no error message quotes one.
import { dirname, join } from 'node:path';
import { DEFAULT_GATEWAY_CONFIG, readGatewayKeyFile } from '../gateway/lib/gateway.js';
import { readHealthKey } from './model-health-key.js';
import { outageGrants } from './model-outages.js';
import { outageRoutingEnabled } from './outage-policy.js';
import { providerEligible } from './provider-health.js';
import { cloudTargetAdmitted, contextFits, providerCircuitID, targetContext, targetFull, targetOutputReserve } from './routing.js';

export const OUTAGE_GATEWAY_URL_ENV = 'OPENCODE_BROKER_OUTAGE_GATEWAY_URL';
const CREDENTIAL_ENV = 'OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE';
const HEALTH_KEY_ENV = 'OPENCODE_BROKER_HEALTH_KEY_FILE';
const GATEWAY_KEY_ENV = 'OPENCODE_BROKER_GATEWAY_KEY_FILE';
const CANONICAL_CI = /^ci_[A-Za-z0-9_-]{43}$/;
const SPEEDS = ['fast', 'standard'];

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => plain(object) && Object.hasOwn(object, key);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

export const isCanonicalCredentialInstance = (value) => typeof value === 'string' && CANONICAL_CI.test(value)
  && Buffer.from(value.slice(3), 'base64url').toString('base64url') === value.slice(3);

// The probe runner appends /v1/{api}, so only a bare origin is accepted: credentials, query,
// fragment or a path would be silently re-shaped by that append.
export function parseOutageGatewayURL(raw) {
  const refuse = (why) => new Error(`${OUTAGE_GATEWAY_URL_ENV} ${why}`);
  if (typeof raw !== 'string' || raw === '') throw refuse('is required when modelOutages is enabled');
  let url;
  try { url = new URL(raw); } catch { throw refuse('is not a URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse('must be http or https');
  if (url.username || url.password) throw refuse('must not carry credentials');
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) throw refuse('must not carry a query or fragment');
  if (url.pathname !== '/') throw refuse('must be an origin with no path');
  return url.origin;
}

export function loadOutageRuntime({
  env = process.env,
  stateDir,
  defaultGatewayKeyPath = join(dirname(DEFAULT_GATEWAY_CONFIG), 'gateway-key'),
}) {
  const gatewayURL = parseOutageGatewayURL(env[OUTAGE_GATEWAY_URL_ENV]);
  const gatewayKey = readGatewayKeyFile(env[GATEWAY_KEY_ENV] || defaultGatewayKeyPath);
  const credentialPath = env[CREDENTIAL_ENV];
  if (typeof credentialPath !== 'string' || credentialPath === '') {
    throw new Error(`${CREDENTIAL_ENV} is required when modelOutages is enabled`);
  }
  const gatewayCredential = readGatewayKeyFile(credentialPath);
  if (typeof stateDir !== 'string' || stateDir === '') throw new Error('model health key: no routing state directory');
  const healthKeyPath = env[HEALTH_KEY_ENV] || join(stateDir, 'model-health.key');
  let healthKey;
  try {
    healthKey = readHealthKey(healthKeyPath, { frontDoorKeys: [gatewayKey, gatewayCredential] });
  } catch (error) {
    // The strict reader's messages name the failed check, never key bytes.
    throw new Error(`model health key ${healthKeyPath}: ${error?.message ?? 'unreadable'}`);
  }
  return { gatewayURL, gatewayKey, gatewayCredential, healthKey };
}

// What a held ordinary lease records about the reserve grant it was issued under.
export function outageLeaseAssertion(grant) {
  if (!plain(grant) || !isCanonicalCredentialInstance(grant.credentialInstance) || !integer(grant.generation)) {
    throw new Error('outage grant credential instance is not canonical');
  }
  return {
    logicalID: grant.logicalID,
    primaryID: grant.primaryID,
    expectedCredentialInstance: grant.credentialInstance,
    generation: grant.generation,
    episodeID: grant.episodeID,
  };
}

// The grant an assertion was issued under, only while that exact grant (same scope, primary,
// target, credential instance, generation and episode) is still authorized at `now`.
export function currentReserveGrant({ policy, outages, targetID, assertion, now }) {
  if (!outageRoutingEnabled(policy) || !plain(outages) || !plain(assertion)
    || !isCanonicalCredentialInstance(assertion.expectedCredentialInstance) || !integer(assertion.generation)) return null;
  return outageGrants(outages, policy, now).find((grant) => grant.targetID === targetID
    && grant.logicalID === assertion.logicalID && grant.primaryID === assertion.primaryID
    && grant.credentialInstance === assertion.expectedCredentialInstance
    && grant.generation === assertion.generation && grant.episodeID === assertion.episodeID) ?? null;
}

// The wire model a lease covers: the exact target model, or the documented base id of a
// synthetic -fast/-standard speed alias whose suffix is the target's own speed. Nothing else.
const coversWireModel = (target, wire) => typeof wire === 'string' && wire !== '' && (wire === target.modelID
  || (SPEEDS.includes(target.speed) && target.modelID === `${wire}-${target.speed}`));

// Health-authority lookup for purpose 'real': the exact held ordinary lease for this session and
// lease ID, on a statically configured managed target. A reserve is covered only through its
// lease's still-current grant assertion; a primary's expected credential instance is null so the
// proxy's actual attested identity establishes the baseline.
export function ordinaryHealthLease({ input, lease, targets, policy, outages, now }) {
  if (policy?.enabled !== true || !plain(input) || input.purpose !== 'real' || !plain(lease)) return null;
  if (typeof input.sessionID !== 'string' || typeof input.leaseID !== 'string' || lease.leaseID !== input.leaseID
    || (lease.sessionID !== undefined && lease.sessionID !== input.sessionID)) return null;
  const target = own(targets, lease.targetID) ? targets[lease.targetID] : null;
  if (!plain(target) || typeof target.modelID !== 'string' || !coversWireModel(target, input.modelID)) return null;
  let primaryID;
  let expectedCredentialInstance = null;
  if (own(policy.primaryScope, target.id)) {
    primaryID = target.id;
  } else {
    primaryID = Object.keys(policy.mappings).find((id) => policy.mappings[id].includes(target.id));
    if (!primaryID) return null;
    const grant = currentReserveGrant({ policy, outages, targetID: target.id, assertion: lease.outage, now });
    if (!grant) return null;
    expectedCredentialInstance = grant.credentialInstance;
  }
  const logicalID = policy.primaryScope[primaryID];
  const expected = own(policy.expectedScopePolicies, logicalID) ? policy.expectedScopePolicies[logicalID] : null;
  if (!plain(expected) || expected.providerID !== target.providerID) return null;
  return {
    held: true,
    sessionID: input.sessionID,
    leaseID: input.leaseID,
    logicalID,
    primaryID,
    targetID: target.id,
    providerID: target.providerID,
    modelID: target.modelID,
    wireModelID: input.modelID,
    purpose: 'real',
    expectedScopePolicy: structuredClone(expected),
    expectedCredentialInstance,
  };
}

// Trusted internal admission for an outage-health probe candidate. A probe is not an ordinary
// lane offer, so it skips only the ordinary managed-outage/head/membership exclusion (it must
// verify a reserve before any grant exists). Every other upper fence stays: static validated
// mapping, cloud admission, staged-policy admission, provider circuits (quota, lapse, connect,
// budget), quarantine/probation, capacity, and target circuits -- except the AFFECTED primary
// model's temporary overload circuit, which a primary recovery probe may test.
//
// Context fence: the probe (lib/model-probe.js runOutageProbe) sends a one-line prompt with a
// fixed 256-token generation cap, so a target must be able to hold it. The window and the output
// cap are resolved exactly as ordinary routing resolves them (targetContext / targetOutputReserve,
// declared value first, then the discovered catalog), and the fit uses ordinary routing's cloud
// predicate (contextFits) over the probe's whole footprint. Its unknown-reserve headroom applies
// because the 256 tokens are part of the request being fitted, not the provider's reserve. An
// unknown window FITS, as it does for every ordinary cloud lease; probe targets are cloud only.
export const OUTAGE_PROBE_OUTPUT_TOKENS = 256;
// Conservative upper bound on the prompt "Reply OK." plus its message framing.
export const OUTAGE_PROBE_PROMPT_TOKENS = 32;
export function probeAdmissible(candidate, { policy, targets, circuits = {}, health = {}, providers = {}, active = {},
  providerActive = {}, probationOnly = new Set(), modelContexts = {}, modelOutputs = {}, now }) {
  if (!outageRoutingEnabled(policy) || !plain(candidate) || !integer(now)) return false;
  const { logicalID, targetID, kind } = candidate;
  const expected = own(policy.expectedScopePolicies, logicalID) ? policy.expectedScopePolicies[logicalID] : null;
  const target = own(targets, targetID) ? targets[targetID] : null;
  if (!plain(expected) || !plain(target) || target.kind !== 'cloud' || target.providerID !== expected.providerID) return false;
  if (kind === 'primary') {
    if (!own(policy.primaryScope, targetID) || policy.primaryScope[targetID] !== logicalID) return false;
  } else if (kind === 'reserve') {
    const primaryID = Object.keys(policy.primaryScope).find((id) => policy.primaryScope[id] === logicalID);
    if (!primaryID || !policy.mappings[primaryID]?.includes(targetID)) return false;
  } else {
    return false;
  }
  if (!cloudTargetAdmitted(target, providers)) return false;
  if (!contextFits(targetContext(target, modelContexts), OUTAGE_PROBE_PROMPT_TOKENS + OUTAGE_PROBE_OUTPUT_TOKENS)) return false;
  const outputCap = targetOutputReserve(target, modelOutputs);
  if (outputCap !== null && outputCap < OUTAGE_PROBE_OUTPUT_TOKENS) return false;
  if (probationOnly.has(`${target.providerID}/${target.modelID}`)) return false;
  const open = (circuit) => Boolean(circuit) && (circuit.until === null || Number(circuit.until) > now);
  if (open(circuits[providerCircuitID(target)])) return false;
  const targetCircuit = circuits[target.id];
  if (open(targetCircuit) && !(kind === 'primary' && targetCircuit.kind === 'overload')) return false;
  if (targetFull(target, active)) return false;
  return providerEligible(health, target.providerID, providerActive[target.providerID] ?? 0);
}
