import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const REQUEST_DOMAIN = 'fleet-health/request/v1\0';
const RESPONSE_DOMAIN = 'fleet-health/response/v1\0';
const CREDENTIAL_DOMAIN = 'fleet-health/credential/v1\0';
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_ID = /^ci_[A-Za-z0-9_-]{43}$/;
const FAILURE_ORIGINS = new Set(['upstream-http', 'upstream-response', 'proxy-credentials', 'proxy-scope', 'proxy-validation', 'proxy-network', 'proxy-auth-context']);

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const requireKey = (key) => {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('health key must be 32 bytes');
};
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
const canonicalNonce = (value) => typeof value === 'string' && B64URL_32.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const mac = (key, domain, value) => createHmac('sha256', key).update(domain).update(value).digest('base64url');

function readTuple(key, domain, encoded, signature) {
  if (typeof encoded !== 'string' || typeof signature !== 'string' || encoded.length + signature.length > 8192
    || !/^[A-Za-z0-9_-]+$/.test(encoded) || !B64URL_32.test(signature)) throw new Error('health header shape');
  const expected = Buffer.from(mac(key, domain, encoded), 'base64url');
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== 32 || !timingSafeEqual(received, expected)) throw new Error('health MAC');
  if (received.toString('base64url') !== signature) throw new Error('health noncanonical signature');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded) throw new Error('health noncanonical encoding');
  let tuple;
  try { tuple = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('health tuple encoding'); }
  if (!Array.isArray(tuple)) throw new Error('health tuple');
  return tuple;
}

function requestShape(tuple) {
  if (tuple.length !== 11 || tuple[0] !== 1 || !canonicalNonce(tuple[1]) || ![tuple[2], tuple[3]].every(Number.isSafeInteger)
    || ![tuple[4], tuple[5], tuple[7], tuple[8]].every(text) || !['real', 'outage-health'].includes(tuple[6])
    || typeof tuple[9] !== 'string' || !/^[a-f0-9]{64}$/.test(tuple[9])
    || !(tuple[10] === null || (typeof tuple[10] === 'string' && CREDENTIAL_ID.test(tuple[10])))) throw new Error('health request shape');
  return tuple;
}

export function credentialInstance(key, snapshot) {
  requireKey(key);
  const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
  if (!snapshot || ![snapshot.providerID, snapshot.upstreamOrigin, snapshot.authMode, snapshot.accessToken].every(nonEmpty)
    || !(snapshot.accountRoutingID === null || nonEmpty(snapshot.accountRoutingID)) || !Number.isFinite(snapshot.expiresAt)) throw new Error('health credential snapshot');
  return `ci_${mac(key, CREDENTIAL_DOMAIN, Buffer.from(JSON.stringify([snapshot.providerID, snapshot.upstreamOrigin, snapshot.authMode, snapshot.accessToken, snapshot.accountRoutingID]), 'utf8').toString('base64url'))}`;
}

export function freezeSnapshot(snapshot) {
  credentialInstance(Buffer.alloc(32), snapshot);
  return Object.freeze({ providerID: snapshot.providerID, upstreamOrigin: snapshot.upstreamOrigin, authMode: snapshot.authMode, accessToken: snapshot.accessToken, accountRoutingID: snapshot.accountRoutingID, expiresAt: snapshot.expiresAt });
}

export function stripHealthHeaders(input) {
  const headers = new Headers(input);
  for (const name of headers.keys()) if (name.toLowerCase().startsWith('x-fleet-health-')) headers.delete(name);
  return headers;
}

export function decodeAuthenticatedRequest(key, context, signature) {
  requireKey(key);
  return requestShape(readTuple(key, REQUEST_DOMAIN, context, signature));
}

export function createHealthProtocol({ key, now = Date.now, maxNonces = 4096 }) {
  requireKey(key);
  if (!Number.isSafeInteger(maxNonces) || maxNonces < 1 || maxNonces > 4096) throw new Error('health protocol configuration');
  const used = new Map();
  const sign = (domain, tuple) => {
    const encoded = Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
    return [encoded, mac(key, domain, encoded)];
  };
  return {
    signRequest(tuple) { const [context, contextSignature] = sign(REQUEST_DOMAIN, tuple); return { context, contextSignature }; },
    signResponse(tuple) { const [attestation, attestationSignature] = sign(RESPONSE_DOMAIN, tuple); return { attestation, attestationSignature }; },
    verifyRequest(context, signature, binding) {
      const tuple = requestShape(readTuple(key, REQUEST_DOMAIN, context, signature));
      const current = now();
      if (tuple[2] > current || tuple[3] <= current || tuple[3] <= tuple[2] || tuple[3] - tuple[2] > 30000) throw new Error('health request time');
      for (const [nonce, expires] of used) if (expires <= current) used.delete(nonce);
      if (used.has(tuple[1])) throw new Error('health replay');
      if (used.size >= maxNonces) throw new Error('health nonce capacity');
      used.set(tuple[1], tuple[3]);
      if (tuple[7] !== binding.providerID || tuple[8] !== binding.modelID || tuple[9] !== sha256(binding.bodyText)
        || (tuple[6] === 'outage-health' && tuple[10] === null)) throw new Error('health binding');
      return tuple;
    },
    verifyResponse(attestation, signature, request, context) {
      const tuple = readTuple(key, RESPONSE_DOMAIN, attestation, signature);
      if (tuple.length !== 14 || tuple[0] !== 1 || tuple[1] !== request[1] || tuple[2] !== request[4] || tuple[3] !== request[5]
        || tuple[4] !== request[8] || typeof context !== 'string' || tuple[13] !== sha256(context)
        || !(tuple[5] === null || (typeof tuple[5] === 'string' && CREDENTIAL_ID.test(tuple[5])))
        || !tuple.slice(6, 11).every(text) || !FAILURE_ORIGINS.has(tuple[11])
        || !(tuple[12] === null || (Number.isInteger(tuple[12]) && tuple[12] >= 100 && tuple[12] <= 599))) throw new Error('health response binding');
      return tuple;
    },
    close() { used.clear(); },
  };
}

export function verifyHealthReport(key, report, binding) {
  const request = decodeAuthenticatedRequest(key, report.context, report.contextSignature);
  if (request[2] !== binding.startedAt || request[3] <= request[2] || request[3] - request[2] > 30000) throw new Error('issuance time binding');
  const attestation = createHealthProtocol({ key }).verifyResponse(report.attestation, report.attestationSignature, request, report.context);
  return { request, attestation };
}
