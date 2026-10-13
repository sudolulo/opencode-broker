import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createHealthAuthority } from '../../lib/model-health.js';
import { makePolicy } from '../../tests/helpers/model-outages.mjs';
import { createGatewayHandler } from '../lib/gateway.js';
import { createHealthProtocol, sha256, verifyHealthReport } from '../lib/proxy-health-context.js';

const withServer = async (handler, run) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

test('invalid health issuance never forwards an expected-credential Responses reserve', async () => {
  const calls = [];
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: 'worker', profile: 'auto', providers: { openai: { baseUrl: 'https://upstream.example/v1', responsesApi: true } } },
    gatewayKey: 'frontdoor', health: { key: Buffer.alloc(32, 15), gatewayCredential: 'private-health' }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === '/lease') return { leaseID: 'reserve', expectedCredentialInstance: `ci_${Buffer.alloc(32, 1).toString('base64url')}`, target: { id: 'reserve-target', model: { providerID: 'openai', id: 'reserved-model' } } };
      if (path === '/model-health/begin') return { nonce: 'bad', startedAt: '100', capability: '' };
      return { ok: true };
    },
    fetchImpl: async () => { forwards += 1; throw new Error('must not forward'); },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer frontdoor', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'reserved-model', input: 'ping' }) });
    assert.equal(response.status, 502);
  });
  assert.equal(forwards, 0);
  assert.equal(calls.filter(({ path }) => path === '/model-health/outcome').length, 0);
});

test('invalid credential assertions stop trusted outage and reserve requests before issuance or forwarding', async () => {
  const validTicket = { nonce: Buffer.alloc(32, 1).toString('base64url'), capability: Buffer.alloc(32, 2).toString('base64url'), startedAt: 100 };
  const outageScope = makePolicy().expectedScopePolicies['openai/sol/standard'];
  const sessionID = `gw-probe-${'s'.repeat(43)}`, probeNonce = `pbn_${'n'.repeat(43)}`;
  for (const [expectedCredentialInstance, expectedStatus] of [[null, 403], ['ci_bad', 502]]) {
    const calls = [];
    let forwards = 0;
    const handler = createGatewayHandler({
      config: { tier: 'worker', profile: 'auto', providers: { openai: { baseUrl: 'https://upstream.example/v1', responsesApi: true }, backup: { baseUrl: 'https://backup.example/v1', responsesApi: true } } },
      gatewayKey: 'frontdoor', health: { key: Buffer.alloc(32, 15), gatewayCredential: 'private-health' }, now: () => 100,
      brokerRequest: async (path, body) => {
        calls.push({ path, body });
        if (path === '/probe/consume') return { sessionID, leaseID: 'outage-lease', targetID: 'outage-target', expectedCredentialInstance, modelID: 'assigned', wireModelID: 'assigned', expectedScopePolicy: outageScope, preferredModel: { providerID: 'openai', modelID: 'assigned' }, purpose: 'outage-health' };
        if (path === '/model-health/begin') return validTicket;
        return { ok: true };
      },
      fetchImpl: async () => { forwards += 1; throw new Error('must not forward'); },
    });
    await withServer(handler, async (base) => {
      const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer frontdoor', 'content-type': 'application/json', 'x-opencode-probe-purpose': 'outage-health', 'x-opencode-probe-session': sessionID, 'x-opencode-probe-nonce': probeNonce }, body: JSON.stringify({ model: 'client-model', input: 'ping' }) });
      assert.equal(response.status, expectedStatus);
    });
    assert.equal(calls.filter(({ path }) => path === '/model-health/begin').length, 0);
    assert.equal(forwards, 0);
    assert.equal(calls.filter(({ path }) => path === '/lease').length, 0, 'trusted outage does not ordinary-lease or fall back');
    assert.equal(calls.filter(({ path }) => path === '/model-health/outcome').length, 0);
  }

  const calls = [];
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: 'worker', profile: 'auto', providers: { openai: { baseUrl: 'https://upstream.example/v1', responsesApi: true } } },
    gatewayKey: 'frontdoor', health: { key: Buffer.alloc(32, 15), gatewayCredential: 'private-health' }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === '/lease') return { leaseID: 'reserve', expectedCredentialInstance: 'ci_bad', target: { id: 'reserve-target', model: { providerID: 'openai', id: 'reserved-model' } } };
      if (path === '/model-health/begin') return validTicket;
      return { ok: true };
    },
    fetchImpl: async () => { forwards += 1; throw new Error('must not forward'); },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer frontdoor', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'reserved-model', input: 'ping' }) });
    assert.equal(response.status, 502);
  });
  assert.equal(calls.filter(({ path }) => path === '/model-health/begin').length, 0);
  assert.equal(forwards, 0);
  assert.equal(calls.filter(({ path }) => path === '/model-health/outcome').length, 0);
});

test('generic staged probe continues unverified after invalid health issuance', async () => {
  const calls = [];
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: 'worker', profile: 'auto', providers: { openai: { baseUrl: 'https://upstream.example/v1' } } },
    gatewayKey: 'frontdoor', health: { key: Buffer.alloc(32, 16), gatewayCredential: 'private-health' }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === '/probe/consume') return { sessionID: `gw-probe-${'s'.repeat(43)}`, preferredModel: { providerID: 'openai', modelID: 'staged-model' } };
      if (path === '/lease') return { leaseID: 'staged-lease', target: { id: 'staged-target', model: { providerID: 'openai', id: 'staged-model' } } };
      if (path === '/model-health/begin') return { nonce: 'bad', startedAt: '100', capability: '' };
      return { ok: true };
    },
    fetchImpl: async (_url, options) => {
      forwards += 1;
      assert.equal(options.headers['x-fleet-health-context'], undefined);
      const payload = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => payload, text: async () => JSON.stringify(payload) };
    },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer frontdoor', 'content-type': 'application/json', 'x-opencode-probe-session': `gw-probe-${'s'.repeat(43)}`, 'x-opencode-probe-nonce': `pbn_${'n'.repeat(43)}` }, body: JSON.stringify({ model: 'staged-model', messages: [] }) });
    assert.equal(response.status, 200);
  });
  assert.equal(forwards, 1);
  assert.equal(calls.filter(({ path }) => path === '/model-health/outcome').length, 0);
});

test('a caller outage-purpose header with a consumed generic probe is rejected before forwarding', async () => {
  const calls = [];
  const sessionID = `gw-probe-${'s'.repeat(43)}`;
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: 'worker', profile: 'auto', providers: { openai: { baseUrl: 'https://upstream.example/v1' } } },
    gatewayKey: 'frontdoor', health: { key: Buffer.alloc(32, 16), gatewayCredential: 'private-health' }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === '/probe/consume') return { sessionID, preferredModel: { providerID: 'openai', modelID: 'staged-model' } };
      if (path === '/lease') return { leaseID: 'staged-lease', target: { id: 'staged-target', model: { providerID: 'openai', id: 'staged-model' } } };
      if (path === '/model-health/begin') return { nonce: Buffer.alloc(32, 1).toString('base64url'), capability: Buffer.alloc(32, 2).toString('base64url'), startedAt: 100 };
      return { ok: true };
    },
    fetchImpl: async () => { forwards += 1; throw new Error('must not forward'); },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer frontdoor', 'content-type': 'application/json', 'x-opencode-probe-purpose': 'outage-health', 'x-opencode-probe-session': sessionID, 'x-opencode-probe-nonce': `pbn_${'n'.repeat(43)}` }, body: JSON.stringify({ model: 'staged-model', messages: [] }) });
    assert.equal(response.status, 403);
  });
  assert.equal(forwards, 0);
  assert.equal(calls.some(({ path }) => path === '/lease'), false);
  assert.equal(calls.some(({ path }) => path === '/model-health/begin'), false);
});

test('gateway captures invalid initial health headers before streaming body mutation without changing client delivery', async () => {
  const key = Buffer.alloc(32, 3), protocol = createHealthProtocol({ key });
  const calls = [], sequence = [];
  const handler = createGatewayHandler({
    config: { tier: 'worker', profile: 'auto', providers: { openai: { baseUrl: 'https://upstream.example/v1' } } },
    gatewayKey: 'frontdoor', health: { key, gatewayCredential: 'private-health' }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === '/lease') return { leaseID: 'lease', target: { model: { providerID: 'openai', id: 'real' } } };
      if (path === '/model-health/begin') return { nonce: Buffer.alloc(32, 1).toString('base64url'), startedAt: 100, capability: Buffer.alloc(32, 2).toString('base64url') };
      if (path === '/model-health/outcome') return { accepted: true };
      return { ok: true };
    },
    fetchImpl: async (_url, options) => {
      const context = options.headers['x-fleet-health-context'];
      const request = JSON.parse(Buffer.from(context, 'base64url').toString('utf8'));
      const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], null, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'chat', 'codex', 'upstream-response', 200, sha256(context)]);
      const values = new Headers({ 'content-type': 'text/event-stream', 'x-fleet-health-attestation': 'invalid', 'x-fleet-health-attestation-signature': 'invalid', 'x-fleet-health-private': 'hidden' });
      const headers = { get(name) { sequence.push(`header:${name}`); return values.get(name); } };
      return { ok: true, status: 200, headers, body: { async *[Symbol.asyncIterator]() {
        sequence.push('body-read');
        values.set('x-fleet-health-attestation', signed.attestation);
        values.set('x-fleet-health-attestation-signature', signed.attestationSignature);
        yield Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } } };
    },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer frontdoor', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [], stream: true }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-fleet-health-private'), null);
    assert.match(await response.text(), /ok/);
  });
  assert.deepEqual(sequence.slice(0, 3), ['header:x-fleet-health-attestation', 'header:x-fleet-health-attestation-signature', 'header:content-type']);
  assert.ok(sequence.indexOf('body-read') > 2, 'health headers are captured before the upstream body is read');
  assert.equal(calls.filter((call) => call.path === '/model-health/outcome').length, 0);
});

test('gateway reports the original authenticated Responses attestation after its streaming body mutates headers', async () => {
  const key = Buffer.alloc(32, 12), credential = `ci_${Buffer.alloc(32, 4).toString('base64url')}`;
  const protocol = createHealthProtocol({ key }), scope = makePolicy().expectedScopePolicies['openai/sol/standard'];
  const reports = [], calls = [];
  const authority = createHealthAuthority({
    gatewayCredential: 'private-health', now: () => 100, randomBytes: () => Buffer.alloc(32, 1),
    lookupLease: (input) => ({ held: true, sessionID: input.sessionID, leaseID: input.leaseID, targetID: 'target', providerID: 'openai', modelID: input.modelID, wireModelID: input.modelID, primaryID: input.modelID, logicalID: 'openai/sol/standard', purpose: input.purpose, expectedScopePolicy: scope, expectedCredentialInstance: credential }),
    lookupGeneration: () => 0, latestFailureAt: () => null,
    verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding),
  });
  const handler = createGatewayHandler({
    config: { tier: 'worker', profile: 'auto', providers: { openai: { baseUrl: 'https://upstream.example/v1', responsesApi: true } } },
    gatewayKey: 'frontdoor', health: { key, gatewayCredential: 'private-health' }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === '/lease') return { leaseID: 'lease', expectedCredentialInstance: credential, target: { id: 'target', model: { providerID: 'openai', id: 'gpt-6-1-sol' } } };
      if (path === '/model-health/begin') return authority.issue(body);
      if (path === '/model-health/outcome') { const accepted = authority.accept(body); reports.push(accepted); return { accepted: true }; }
      return { ok: true };
    },
    fetchImpl: async (_url, options) => {
      const context = options.headers['x-fleet-health-context'];
      const request = JSON.parse(Buffer.from(context, 'base64url').toString('utf8'));
      const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], credential, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(context)]);
      const values = new Headers({ 'content-type': 'text/event-stream', 'x-fleet-health-attestation': signed.attestation, 'x-fleet-health-attestation-signature': signed.attestationSignature, 'x-fleet-health-private': 'hidden' });
      return { ok: true, status: 200, headers: values, body: { async *[Symbol.asyncIterator]() {
        values.set('x-fleet-health-attestation', 'invalid');
        values.set('x-fleet-health-attestation-signature', 'invalid');
        yield Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","status":"completed","output":[]}}\n\n');
      } } };
    },
  });
  try {
    await withServer(handler, async (base) => {
      const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer frontdoor', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6-1-sol', input: 'ping', stream: true }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-fleet-health-private'), null);
      assert.match(await response.text(), /response.completed/);
    });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].outcome.result, 'success');
    assert.equal(calls.filter(({ path }) => path === '/model-health/outcome').length, 1);
  } finally { authority.close(); }
});

test('gateway uses an accepted proxy-scope 409 to release an internal reserve and re-lease only another target', async () => {
  const key = Buffer.alloc(32, 13), initialCredential = `ci_${Buffer.alloc(32, 5).toString('base64url')}`, replacementCredential = `ci_${Buffer.alloc(32, 6).toString('base64url')}`;
  const protocol = createHealthProtocol({ key }), scope = makePolicy().expectedScopePolicies['openai/sol/standard'];
  const calls = [], reports = [];
  let entropy = 0;
  const authority = createHealthAuthority({
    gatewayCredential: 'private-health', now: () => 100, randomBytes: () => Buffer.alloc(32, ++entropy),
    lookupLease: (input) => {
      const replacement = input.leaseID === 'replacement-lease';
      return { held: true, sessionID: input.sessionID, leaseID: input.leaseID, targetID: replacement ? 'replacement-target' : 'reserve-target', providerID: 'openai', modelID: input.modelID, wireModelID: input.modelID, primaryID: 'gpt-6-1-sol', logicalID: 'openai/sol/standard', purpose: input.purpose, expectedScopePolicy: scope, expectedCredentialInstance: replacement ? replacementCredential : initialCredential };
    },
    lookupGeneration: () => 0, latestFailureAt: () => null,
    verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding),
  });
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: 'worker', profile: 'auto', providers: { openai: { baseUrl: 'https://upstream.example/v1', responsesApi: true } } },
    gatewayKey: 'frontdoor', health: { key, gatewayCredential: 'private-health' }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === '/lease') return calls.filter(({ path: item }) => item === '/lease').length === 1
        ? { leaseID: 'initial-lease', expectedCredentialInstance: initialCredential, target: { id: 'reserve-target', model: { providerID: 'openai', id: 'gpt-6-1-sol' } } }
        : { leaseID: 'replacement-lease', expectedCredentialInstance: replacementCredential, target: { id: 'replacement-target', model: { providerID: 'openai', id: 'gpt-6-1-sol' } } };
      if (path === '/model-health/begin') return authority.issue(body);
      if (path === '/model-health/outcome') { const accepted = authority.accept(body); reports.push(accepted); return { accepted: true }; }
      return { ok: true };
    },
    fetchImpl: async (_url, options) => {
      forwards += 1;
      const context = options.headers['x-fleet-health-context'];
      const request = JSON.parse(Buffer.from(context, 'base64url').toString('utf8'));
      if (forwards === 1) {
        const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], replacementCredential, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'proxy-scope', null, sha256(context)]);
        return { ok: false, status: 409, headers: new Headers({ 'x-fleet-health-attestation': signed.attestation, 'x-fleet-health-attestation-signature': signed.attestationSignature }), text: async () => 'scope mismatch' };
      }
      const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], replacementCredential, 'llm-auth-proxy/openai', 'https://chatgpt.com', 'chatgpt-oauth', 'responses', 'codex', 'upstream-response', 200, sha256(context)]);
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json', 'x-fleet-health-attestation': signed.attestation, 'x-fleet-health-attestation-signature': signed.attestationSignature }), text: async () => JSON.stringify({ object: 'response', id: 'r', status: 'completed', output: [] }) };
    },
  });
  try {
    await withServer(handler, async (base) => {
      const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer frontdoor', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6-1-sol', input: 'ping' }) });
      assert.equal(response.status, 200);
    });
    assert.deepEqual(reports.map(({ outcome }) => outcome.result), ['scope-mismatch', 'success']);
    assert.ok(calls.some(({ path, body }) => path === '/release' && body.leaseID === 'initial-lease'));
    assert.equal(calls.some(({ path, body }) => path === '/failure' && body.leaseID === 'initial-lease'), false);
    assert.ok(calls.some(({ path, body }) => path === '/complete' && body.leaseID === 'replacement-lease'));
    const leases = calls.filter(({ path }) => path === '/lease');
    assert.deepEqual(leases[1].body.excludeTargetIDs, ['reserve-target']);
    assert.deepEqual(leases[1].body.providers, ['openai'], 'the replacement keeps its provider eligible');
  } finally { authority.close(); }
});
