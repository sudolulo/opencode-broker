const GRANT_KEYS = ['version', 'grantID', 'purpose', 'sessionID', 'leaseID', 'targetID', 'providerID', 'modelID', 'profile', 'tier', 'issuedAtMs', 'expiresAtMs', 'policyRevision', 'source'];
const SOURCE_KEYS = ['providerID', 'targetID', 'leaseID', 'modelID', 'quotaObservedAtMs', 'quotaUntilMs'];
const MAX_IDENTIFIER_LENGTH = 512;

const fail = () => { const error = new Error('invalid spend authorization'); error.code = 'invalid_authorization'; throw error; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && !/[\0-\x1f\x7f]/.test(value);
const time = value => Number.isSafeInteger(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const revision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreeze(item)])));
  return value;
}

export function normalizeApiSpendGrant(raw, expected = {}) {
  if (!exactKeys(raw, GRANT_KEYS) || !plain(expected) || !time(expected.now)) fail();
  const grant = raw;
  if (grant.version !== 1 || !uuid(grant.grantID) || !['manual', 'continuation'].includes(grant.purpose)
    || !['sessionID', 'leaseID', 'targetID', 'providerID', 'modelID', 'profile', 'tier'].every(key => identifier(grant[key]))
    || !time(grant.issuedAtMs) || !time(grant.expiresAtMs) || !revision(grant.policyRevision)
    || grant.issuedAtMs > expected.now || grant.expiresAtMs <= expected.now) fail();
  for (const key of ['sessionID', 'leaseID', 'targetID', 'providerID', 'modelID']) {
    if (expected[key] !== undefined && (!identifier(expected[key]) || grant[key] !== expected[key])) fail();
  }
  let source = null;
  if (grant.purpose === 'manual') {
    if (grant.source !== null) fail();
  } else {
    if (!exactKeys(grant.source, SOURCE_KEYS) || !['providerID', 'targetID', 'leaseID', 'modelID'].every(key => identifier(grant.source[key]))
      || !time(grant.source.quotaObservedAtMs) || !time(grant.source.quotaUntilMs)
      || grant.source.quotaObservedAtMs > grant.source.quotaUntilMs || grant.source.providerID === grant.providerID
      || grant.expiresAtMs > grant.source.quotaUntilMs) fail();
    source = { providerID: grant.source.providerID, targetID: grant.source.targetID, leaseID: grant.source.leaseID,
      modelID: grant.source.modelID, quotaObservedAtMs: grant.source.quotaObservedAtMs, quotaUntilMs: grant.source.quotaUntilMs };
  }
  return deepFreeze({ version: 1, grantID: grant.grantID, purpose: grant.purpose, sessionID: grant.sessionID,
    leaseID: grant.leaseID, targetID: grant.targetID, providerID: grant.providerID, modelID: grant.modelID,
    profile: grant.profile, tier: grant.tier, issuedAtMs: grant.issuedAtMs, expiresAtMs: grant.expiresAtMs,
    policyRevision: grant.policyRevision, source });
}
