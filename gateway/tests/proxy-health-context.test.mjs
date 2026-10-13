import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHealthProtocol, credentialInstance, decodeAuthenticatedRequest, sha256, verifyHealthReport } from '../lib/proxy-health-context.js';

const key = Buffer.alloc(32, 7);
const body = '{"model":"m","input":"ping"}';
const nonce = Buffer.alloc(32, 1).toString('base64url');
const requestTuple = () => [1, nonce, 1000, 11000, 'r', 'a', 'real', 'openai', 'm', sha256(body), 'ci_' + Buffer.alloc(32, 2).toString('base64url')];

test('proxy context request and response signatures match exact tuple bytes', () => {
  const protocol = createHealthProtocol({ key, now: () => 1000 });
  const request = requestTuple();
  const context = Buffer.from(JSON.stringify(request)).toString('base64url');
  const signed = protocol.signRequest(request);
  assert.equal(signed.context, context);
  assert.equal(signed.contextSignature, createHmac('sha256', key).update('fleet-health/request/v1\0').update(context).digest('base64url'));
  const attestation = [1, nonce, 'r', 'a', 'm', request[10], 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'proxy-credentials', null, sha256(context)];
  const encoded = Buffer.from(JSON.stringify(attestation)).toString('base64url');
  assert.equal(protocol.signResponse(attestation).attestation, encoded);
  assert.equal(protocol.signResponse(attestation).attestationSignature, createHmac('sha256', key).update('fleet-health/response/v1\0').update(encoded).digest('base64url'));
});

test('report verification binds issued request and attested expected credential without consuming nonce', () => {
  const protocol = createHealthProtocol({ key, now: () => 999999 });
  const request = requestTuple();
  const signed = protocol.signRequest(request);
  const attestation = [1, nonce, 'r', 'a', 'm', request[10], 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(signed.context)];
  const response = protocol.signResponse(attestation);
  const report = { context: signed.context, contextSignature: signed.contextSignature, ...response };
  const binding = { startedAt: 1000, expectedCredentialInstance: request[10] };
  assert.deepEqual(verifyHealthReport(key, report, binding), { request, attestation });
  assert.deepEqual(decodeAuthenticatedRequest(key, signed.context, signed.contextSignature), request);
  assert.throws(() => verifyHealthReport(key, report, { ...binding, startedAt: 1001 }), /issuance time binding/);
  assert.throws(() => verifyHealthReport(key, { ...report, attestationSignature: 'A'.repeat(43) }, binding), /MAC/);
});

test('request verification rejects authentic signatures bound to a different body, provider, or model', () => {
  const request = requestTuple();
  for (const [binding, label] of [
    [{ providerID: 'openai', modelID: 'm', bodyText: '{"model":"other"}' }, 'body'],
    [{ providerID: 'anthropic', modelID: 'm', bodyText: body }, 'provider'],
    [{ providerID: 'openai', modelID: 'other', bodyText: body }, 'model'],
  ]) {
    const protocol = createHealthProtocol({ key, now: () => 1000 });
    const signed = protocol.signRequest(request);
    assert.throws(() => protocol.verifyRequest(signed.context, signed.contextSignature, binding), /health binding/, label);
  }
});

test('request verification consumes authentic mismatches and enforces outage credential and TTL', () => {
  const protocol = createHealthProtocol({ key, now: () => 1000 });
  const request = requestTuple();
  const signed = protocol.signRequest(request);
  assert.throws(() => protocol.verifyRequest(signed.context, signed.contextSignature, { providerID: 'anthropic', modelID: 'm', bodyText: body }), /health binding/);
  assert.throws(() => protocol.verifyRequest(signed.context, signed.contextSignature, { providerID: 'openai', modelID: 'm', bodyText: body }), /health replay/);

  const outage = [1, Buffer.alloc(32, 3).toString('base64url'), 1000, 11000, 'r', 'a', 'outage-health', 'openai', 'm', sha256(body), null];
  const expiry = [1, Buffer.alloc(32, 4).toString('base64url'), 1000, 32001, 'r', 'a', 'real', 'openai', 'm', sha256(body), null];
  for (const tuple of [outage, expiry]) {
    const value = protocol.signRequest(tuple);
    assert.throws(() => protocol.verifyRequest(value.context, value.contextSignature, { providerID: 'openai', modelID: 'm', bodyText: body }), /health (binding|request time)/);
  }
});

test('credential instance accepts the complete immutable credential snapshot', () => {
  const snapshot = { providerID: 'openai', upstreamOrigin: 'https://chatgpt.com', authMode: 'chatgpt-oauth', accessToken: 'x'.repeat(513), accountRoutingID: 'account', expiresAt: 9999 };
  assert.match(credentialInstance(key, snapshot), /^ci_[A-Za-z0-9_-]{43}$/);
});
