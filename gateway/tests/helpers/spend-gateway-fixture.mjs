import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGatewayHandler } from '../../lib/gateway.js';
import { normalizeSpendPolicy } from '../../lib/spend-policy.js';
import { rawPolicy, policyFor, bodyFor, messageFor, NOW, MODEL, PROVIDER_ID, ORIGIN, TEST_KEY } from './spend-fixture.mjs';

export const FRONTDOOR_KEY = 'synthetic-gateway-frontdoor';
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// The production Node HTTP handler, not a parallel request implementation. Basic
// tests await its entire lifetime; cancellation tests also exercise real sockets.
export async function makeHarness({ ledgerPath, policyOverrides = {}, attested = true,
  includePolicy = true, fetchImpl = async () => new Response(JSON.stringify(messageFor()),
    { headers: { 'content-type': 'application/json' } }), brokerTargetOverrides = {},
  providerOverrides = {}, now = () => NOW, handlerFactory = createGatewayHandler,
  health = null, brokerImpl = null } = {}) {
  const directory = await mkdtemp(join(dirname(ledgerPath), 'gateway-'));
  const keyFile = join(directory, 'synthetic-key');
  await writeFile(keyFile, TEST_KEY, { mode: 0o600 });
  const target = { id: 'synthetic-target', model: { providerID: PROVIDER_ID, id: MODEL },
    ...(attested ? { requiresSpendBudget: true, billingClass: 'manual-api' } : {}), ...brokerTargetOverrides };
  // A split (allocations) policy is bound to the broker-selected target, so it can only be
  // normalized with that registered identity; unpartitioned fixtures are unchanged.
  const policy = policyOverrides.allocations === undefined ? policyFor(ledgerPath, policyOverrides)
    : normalizeSpendPolicy(rawPolicy(ledgerPath, policyOverrides), { targetID: target.id, providerID: target.model.providerID, modelID: target.model.id });
  const provider = { baseUrl: `${ORIGIN}/v1`, keyFile, messagesApi: true,
    responsesApi: true, embeddingsApi: true,
    ...(includePolicy ? { spendBudget: rawPolicy(ledgerPath, policyOverrides) } : {}), ...providerOverrides };
  const config = { tier: 'worker', profile: 'auto', modelProfiles: { [MODEL]: 'synthetic-paid' },
    providers: { [PROVIDER_ID]: provider } };
  const brokerCalls = [], logs = [], calls = [], active = new Set();
  let handler;
  try {
    handler = handlerFactory({ config, gatewayKey: FRONTDOOR_KEY, authPath: join(directory, 'no-real-auth'), now, health,
      logLine: line => logs.push(JSON.parse(line)),
      brokerRequest: async (path, body) => {
        brokerCalls.push({ path, body });
        if (brokerImpl) return brokerImpl(path, body, target);
        if (path === '/lease' || path === '/lease/verify') return { held: true, leaseID: 'synthetic-lease', target };
        return { ok: true };
      },
      fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
    });
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const start = (bodyOverrides = {}, options = {}) => {
    const request = Readable.from([Buffer.from(bodyFor(bodyOverrides))]);
    request.method = 'POST'; request.url = options.path ?? '/v1/messages';
    request.headers = { authorization: `Bearer ${FRONTDOOR_KEY}`, 'content-type': 'application/json',
      'anthropic-version': '2023-06-01', ...options.headers };
    request.rawHeaders = options.rawHeaders ?? Object.entries(request.headers).flat();
    request.socket = { remoteAddress: '127.0.0.1' };
    const response = new EventEmitter();
    const chunks = [];
    Object.assign(response, { writableEnded: false, destroyed: false, headersSent: false, statusCode: 200,
      socket: { setNoDelay() {} },
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return options.write ? options.write(chunk, this) : true; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.writableEnded = true; this.emit('finish'); },
      disconnect() { this.destroyed = true; this.emit('close'); },
    });
    const done = handler(request, response).then(() => new Response(Buffer.concat(chunks),
      { status: response.statusCode, headers: response.headers }));
    active.add(done);
    // Keep rejection handling owned by the caller/close, with no detached branch.
    done.then(() => active.delete(done), () => active.delete(done));
    return { request, response, done, chunks };
  };
  return { handler, config, provider, target, policy, keyFile, logs, calls, brokerCalls, start,
    upstreamCalls: () => calls.length, send: (body, options) => start(body, options).done,
    close: async () => { await Promise.all(active); await rm(directory, { recursive: true, force: true }); } };
}
