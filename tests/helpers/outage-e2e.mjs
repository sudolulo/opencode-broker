import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createProxyServer } from '../../../projects/llm-auth-proxy/src/server.ts';
import { relayOpenAIResponses } from '../../../projects/llm-auth-proxy/src/openai/responses-relay.ts';
import { createGatewayHandler } from '../../gateway/lib/gateway.js';
import { verifyHealthReport } from '../../gateway/lib/proxy-health-context.js';
import { createOutageService } from '../../lib/model-outage-service.js';
import { runOutageProbe } from '../../lib/model-probe.js';
import { emptyOutages, outageGrants, reduceOutages } from '../../lib/model-outages.js';
import { currentReserveGrant, ordinaryHealthLease, outageLeaseAssertion } from '../../lib/model-outage-runtime.js';
import { buildCanonicalHeads, selectAutomatic } from '../../lib/outage-policy.js';
import { fetchStatusSnapshot, normalizeStatusPayload, incidentMatchesScope, STATUS_URLS } from '../../lib/status-incidents.js';
import { makeTargets, makePolicy } from './model-outages.mjs';
import { v2, v2Incident, claudeHistoricalReplay, openAIAPIHistoricalReplay } from './status-fixtures.mjs';

export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
export async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function json(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); }
const sse = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
function stream(api, model, speed) {
  if (api === 'messages') return sse('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
    + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } })
    + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
    + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1, ...(speed ? { speed } : {}) } }) + sse('message_stop', { type: 'message_stop' });
  return sse('response.created', { type: 'response.created', response: { id: 'r', object: 'response', status: 'in_progress', model, output: [] } })
    + sse('response.completed', { type: 'response.completed', response: { id: 'r', object: 'response', status: 'completed', model, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
}

export async function createOutageHarness({ primaryID, feed = 'empty', outageMode = 'active' }) {
  const targets = makeTargets(); const policy = { ...makePolicy(), mode: outageMode }; const primary = targets[primaryID]; assert.ok(primary, primaryID);
  const logicalID = policy.primaryScope[primaryID], scope = policy.expectedScopePolicies[logicalID], api = scope.probe.api;
  targets.fallback = { id: 'fallback', providerID: 'fallback', modelID: 'fixture-fallback', kind: 'cloud', family: 'other', speed: 'standard' };
  // The id a target's requests carry on the wire: the documented base id of a -fast alias, else the exact model id.
  const wire = target => target.speed === 'fast' ? target.modelID.replace(/-fast$/, '') : target.modelID;
  const wireIDs = {}; for (const target of Object.values(targets)) (wireIDs[target.providerID] ??= new Set()).add(wire(target));
  const heads = buildCanonicalHeads({ policy, targets, admittedModelKeys: Object.values(targets).map(t => `${t.providerID}/${t.modelID}`), resolvableModelKeys: Object.values(targets).map(t => `${t.providerID}/${t.modelID}`) });
  let clock = 1_000_000, state = emptyOutages(), failure = false, identity = 'A', feedMode = feed, mode = 'valid', gatewayURL = '', serial = 0, closed = false;
  const key = Buffer.alloc(32, 7), gatewayCredential = 'fixture-gateway-credential', gatewayKey = 'fixture-gateway-key', proxyKey = 'fixture-proxy-key';
  const root = mkdtempSync(join(tmpdir(), 'outage-e2e-')); chmodSync(root, 0o700); const keyFile = join(root, 'key'); writeFileSync(keyFile, proxyKey, { mode: 0o600 });
  const timers = new Map(); let timerID = 0;
  const timerAPI = { setInterval(fn, ms) { const id = ++timerID; timers.set(id, { fn, ms, interval: true }); return id; }, clearInterval(id) { timers.delete(id); }, setTimeout(fn, ms) { const id = ++timerID; timers.set(id, { fn, ms, interval: false }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const stats = { upstream: [], broker: [], health: [], gatewayCalls: [], violations: [], snapshots: [], probeReservations: [], commits: [], ordinaryCredentialReads: 0, refreshes: 0, syntheticFailureCalls: 0, realFailureCalls: 0, timers };
  const leases = new Map(); let queue = Promise.resolve();
  const serialize = transaction => { const work = queue.then(transaction); queue = work.catch(() => {}); return work; };
  // The proxy's credential validity guard deliberately uses wall time; this remains a fake
  // credential but must not be expired relative to that independent guard.
  const credential = () => mode === 'no-credentials' ? null : ({ generation: identity === 'A' ? 1 : 2, accessToken: `fixture-token-${identity}`, refreshToken: 'never-refresh', expiresAt: 4_000_000_000_000, accountId: `fixture-account-${identity}` });
  let upstreamServer, proxyServer, gatewayServer, service;
  try {
    // The fake upstream sees the real upstream pathname under a provider prefix: the proxy's
    // Messages relay posts to /anthropic/v1/messages (its real URL carries ?beta=true), the Codex
    // relay to /openai/backend-api/codex/responses, and the gateway's unverified fallback lane
    // straight to /fallback/v1/{messages,responses}. The SSE dialect follows the pathname, never
    // the provider, so a request on an unknown path fails loudly instead of answering wrongly.
    const UPSTREAM_PATHS = { '/anthropic/v1/messages': 'messages', '/openai/backend-api/codex/responses': 'responses', '/fallback/v1/messages': 'messages', '/fallback/v1/responses': 'responses' };
    // A fixture-contract violation (unknown path, leaked private header, wrong upstream origin) is
    // recorded and answered 400, never 5xx: a 500 would read as a genuine service fault and could
    // pass for the outage under test. real() and tick() fail on any recorded violation.
    const violate = (what) => { stats.violations.push(what); const error = new Error(what); error.violation = true; return error; };
    upstreamServer = createServer((req, res) => { void (async () => {
      const body = await json(req); const pathname = new URL(req.url ?? '/', 'http://fixture').pathname;
      const responseAPI = UPSTREAM_PATHS[pathname]; if (!responseAPI) throw violate(`unexpected upstream path ${pathname}`);
      const providerID = pathname.split('/')[1];
      const leaked = Object.keys(req.headers).filter(name => name.startsWith('x-fleet-health-')); if (leaked.length) throw violate(`private health headers reached the upstream: ${leaked.join(',')}`);
      const record = { providerID, pathname, api: responseAPI, model: body.model, body, headers: req.headers, authorization: req.headers.authorization ?? null, account: req.headers['chatgpt-account-id'] ?? null, status: null }; stats.upstream.push(record);
      const answer = (status, headers, text) => { record.status = status; res.writeHead(status, headers); res.end(text); };
      // Like the real upstreams, only this provider's wire ids exist here: a broker-side -fast alias
      // on the wire is not a model (the gateway forwards a gateway-owned lease's own id unchanged;
      // OpenCode puts the base id on the wire for its bound leases). A 200 to one would fabricate a head.
      if (!wireIDs[providerID]?.has(body.model)) return answer(404, { 'content-type': 'application/json' }, JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model: ${body.model}` } }));
      const head = body.model === wire(primary);
      if ((providerID === primary.providerID && failure && head) || (mode === 'reserve-failure' && providerID === primary.providerID && !head)) return answer(503, { 'content-type': 'application/json' }, JSON.stringify({ error: { type: 'api_error', message: 'fixture upstream unavailable' } }));
      // 'standard-speed': the upstream silently serves standard speed to a fast request, which a
      // real model may do; only the response's own usage.speed can prove fast.
      const output = stream(responseAPI, body.model, body.speed === 'fast' && mode !== 'standard-speed' ? 'fast' : 'standard');
      answer(200, { 'content-type': 'text/event-stream' }, mode === 'partial' && providerID === primary.providerID ? output.slice(0, Math.max(1, output.indexOf('\n\n') + 1)) : output);
    })().catch(error => { if (!error?.violation) stats.violations.push(`fake upstream handler: ${error.message}`); res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'fixture_violation', message: error.message } })); }); });
    const upstreamURL = await listen(upstreamServer);
    const offlineFetch = providerID => async (url, init) => { const target = new URL(url); const origin = providerID === 'anthropic' ? 'https://api.anthropic.com' : 'https://chatgpt.com'; if (target.origin !== origin) throw violate(`proxy ${providerID} relay targeted ${target.origin}, expected ${origin}`); return fetch(`${upstreamURL}/${providerID}${target.pathname}`, init); };
    proxyServer = createProxyServer({ key: proxyKey, health: { key, now: () => clock }, messages: { fetchImpl: offlineFetch('anthropic'), credentials: async () => { stats.ordinaryCredentialReads++; return credential(); }, peekCredentials: () => credential() }, openai: { credential: () => { stats.ordinaryCredentialReads++; return credential(); }, peekCredential: () => credential(), client: { responses: (bodyText, c, headers, signal, health) => relayOpenAIResponses(bodyText, headers, signal, { credential: c, health, upstream: offlineFetch('openai'), refreshCredential: async () => { stats.refreshes++; throw new Error('offline fixture forbids refresh'); }, codexVersion: '0.0.0' }) }, codexVersion: () => '0.0.0', startCodexVersion: () => {}, stopCodexVersion: () => {} } });
    const proxyURL = await listen(proxyServer);
    const commit = async next => { state = structuredClone(next); stats.commits.push(structuredClone(next)); };
    // Ordinary lease storage is injected, but its CONTRACT is the broker's own: a stored lease is
    // what bin/opencode-broker keeps in state.leases ({sessionID, leaseID, targetID, outage}); /lease
    // and /lease/verify answer with publicTarget's shape plus the grant's expected credential
    // instance; a held reserve verifies only while its exact grant is current (currentReserveGrant);
    // and the health authority's lookup is the production ordinaryHealthLease, which admits the
    // exact target model or the base id of its -fast alias and echoes that wire id. Nothing here
    // decides health: outcomes always come from the signed proxy/gateway execution.
    const reserveIDs = new Set(Object.values(policy.mappings).flat());
    const leaseView = lease => { const target = targets[lease.targetID]; return { leaseID: lease.leaseID, target: { id: target.id, kind: target.kind, model: { providerID: target.providerID, id: target.modelID } }, expectedCredentialInstance: lease.outage?.expectedCredentialInstance ?? null, generation: lease.outage?.generation ?? null }; };
    const storeLease = (sessionID, targetID, grant = null) => { const lease = { sessionID, leaseID: `lease-${++serial}`, targetID, outage: grant ? outageLeaseAssertion(grant) : null }; leases.set(sessionID, lease); return lease; };
    const choose = (exclude = [], providers = null) => selectAutomatic({ primaryIDs: [primaryID], fallbackGroups: [['fallback']], targets, context: { policy, heads, outages: state, now: clock }, eligible: target => !exclude.includes(target.id) && (!providers || providers.includes(target.providerID)), pick: xs => xs[0] });
    async function ordinaryRequest(path, body) {
      const record = { path, ...body }; stats.broker.push(record);
      if (path === '/lease') return serialize(async () => {
        // Selection evidence: the grants the production selector could see, and what it picked.
        record.grantsVisible = outageGrants(state, policy, clock).map(g => ({ targetID: g.targetID, credentialInstance: g.credentialInstance, mode: g.mode }));
        const selected = choose(body.excludeTargetIDs ?? [], body.providers ?? null);
        record.selected = selected ? { targetID: selected.target.id, source: selected.source ?? null, grant: selected.grant ? { credentialInstance: selected.grant.credentialInstance } : null } : null;
        if (!selected) throw new Error('no eligible target');
        const lease = storeLease(body.sessionID, selected.target.id, selected.grant);
        if (selected.grant) await commit(reduceOutages(state, {
          type: 'activate', logicalID: selected.grant.logicalID, targetID: selected.target.id,
          credentialInstance: selected.grant.credentialInstance,
        }, { policy, now: clock }));
        return { ...leaseView(lease), existing: false };
      });
      if (path === '/lease/verify') {
        const lease = leases.get(body.sessionID); const matches = lease && (body.leaseID === undefined || body.leaseID === lease.leaseID);
        const target = matches ? targets[lease.targetID] : null;
        const reserve = Boolean(target) && reserveIDs.has(target.id);
        if (!target || (reserve && !currentReserveGrant({ policy, outages: state, targetID: target.id, assertion: lease.outage, now: clock }))) return { held: false };
        return { held: true, ...leaseView(lease) };
      }
      if (path === '/failure') { if (String(body.sessionID).startsWith('gw-probe-')) stats.syntheticFailureCalls++; else stats.realFailureCalls++; }
      // As in the broker, the first failure report consumes the lease and every settlement drops
      // only the exact lease it names (dropExactLease), never a newer one on the same session.
      if (['/complete', '/release', '/forget', '/failure'].includes(path)) { const lease = leases.get(body.sessionID); if (lease && (body.leaseID === undefined || body.leaseID === lease.leaseID)) leases.delete(body.sessionID); }
      return { ok: true };
    }
    const statusFetch = async (url, init) => {
      assert.equal(init.redirect, 'error');
      assert.ok(Object.values(STATUS_URLS).includes(url));
      if (url === STATUS_URLS.openaiWidget) return Response.json({ ongoing_incidents: [] });
      if (feedMode === 'empty') return Response.json(v2());
      if (feedMode === 'api-key') return Response.json(openAIAPIHistoricalReplay());
      const payload = primary.providerID === 'anthropic' ? claudeHistoricalReplay() : v2(v2Incident({
        id: `synthetic-${primaryID}`,
        name: `Elevated errors for ${policy.incidentAliases[primaryID][0]} in Codex`,
        body: `Requests to ${policy.incidentAliases[primaryID][0]} using Codex Sign in with ChatGPT are experiencing elevated service errors.`,
      }));
      const incident = payload.incidents[0];
      const alias = policy.incidentAliases[primaryID][0];
      // The Opus 5.5 capture stays literal. Other rows are schema-valid synthetic offline input.
      if (!(primaryID === 'claude-opus-5-5' && primary.providerID === 'anthropic') && primary.providerID === 'anthropic') {
        incident.id = `synthetic-${primaryID}`;
        incident.name = `Elevated errors for ${alias}`;
        incident.incident_updates[0].incident_id = incident.id;
        incident.incident_updates[0].body = `We are investigating elevated errors on requests to ${alias}.`;
      }
      if (feedMode === 'resolved') {
        incident.status = 'resolved';
        incident.resolved_at = '2026-10-01T00:02:00Z';
        incident.incident_updates[0].status = 'resolved';
      }
      const normalized = normalizeStatusPayload(primary.providerID, payload, { source: url, receivedAt: clock });
      assert.equal(normalized.status, 'valid');
      if (feedMode === 'positive') {
        assert.equal(incidentMatchesScope(normalized.incidents[0], {
          aliases: policy.incidentAliases[primaryID], scope,
        }), 'positive');
      }
      return Response.json(payload);
    };
    service = createOutageService({ policy, targets, now: () => clock, randomBytes, read: () => state, commit, serialize, timers: timerAPI, gatewayCredential, canProbe: () => true, lookupOrdinaryLease: input => ordinaryHealthLease({ input, lease: leases.get(input.sessionID) ?? null, targets, policy, outages: state, now: clock }), ordinaryRequest, verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding), fetchStatus: async (providerID, { signal }) => { const snapshot = await fetchStatusSnapshot(providerID, { signal, policy, now: () => clock, fetchImpl: statusFetch }); stats.snapshots.push(snapshot); return snapshot; }, sendProbe: async (a, { signal, waitForOutcome }) => { stats.probeReservations.push({ assignment: a, durable: structuredClone(state) }); return runOutageProbe({ assignment: a, scope: policy.expectedScopePolicies[a.logicalID], gatewayURL, gatewayKey, signal, waitForOutcome, now: () => clock }); } });
    // No modelProfiles: an unbound request names the unmapped model "auto", so the gateway leases the
    // configured profile and, on an upstream failure, excludes the failed lane for its one retry.
    // A profile-mapped name deliberately never excludes its own lane (gateway.js, excludeLane), and
    // that would re-lease the failing head and answer 502 where the ordinary fallback must run.
    const config = { profile: 'auto', tier: 'build', strictModelNames: false, providers: { anthropic: { baseUrl: `${proxyURL}/anthropic/v1`, messagesApi: true, responsesApi: true, chatApi: true, keyFile, timeoutMs: 10000 }, openai: { baseUrl: `${proxyURL}/openai/v1`, messagesApi: false, responsesApi: true, chatApi: false, keyFile, timeoutMs: 10000 }, fallback: { baseUrl: `${upstreamURL}/fallback/v1`, messagesApi: true, responsesApi: true, chatApi: false, timeoutMs: 10000 } } };
    // Boundary trace of every gateway->broker health report, sanitized: no credential, capability,
    // nonce, context or signatures; the attestation tuple is decoded (the service verifies it separately).
    const decodeTuple = encoded => { try { return JSON.parse(Buffer.from(encoded, 'base64url')); } catch { return null; } };
    const traceHealth = (path, body, result, error) => {
      const sanitized = result && typeof result === 'object' ? { ok: result.ok ?? true, duplicate: result.duplicate ?? false, startedAt: result.startedAt ?? null, generation: result.generation ?? null } : result;
      const entry = { path, result: error ? null : sanitized, error: error ? String(error.message ?? error) : null };
      if (path === '/model-health/begin') Object.assign(entry, { requestID: body.requestID, attemptID: body.attemptID, purpose: body.purpose, modelID: body.modelID, speed: body.speed ?? null });
      else { const tuple = decodeTuple(body.attestation) ?? []; Object.assign(entry, { terminal: body.terminal ?? null, requestID: tuple[2] ?? null, attemptID: tuple[3] ?? null, actualCredentialInstance: tuple[5] ?? null, failureOrigin: tuple[11] ?? null, upstreamStatus: tuple[12] ?? null }); }
      stats.health.push(entry);
    };
    const brokerRequest = async (path, body) => {
      const health = path.startsWith('/model-health/');
      try { const result = await service.request(path, body); if (health) traceHealth(path, body, result, null); else stats.gatewayCalls.push({ path, sessionID: body?.sessionID ?? null, purpose: body?.purpose ?? null, error: null }); return result; }
      catch (error) { if (health) traceHealth(path, body, null, error); else stats.gatewayCalls.push({ path, sessionID: body?.sessionID ?? null, purpose: body?.purpose ?? null, error: String(error?.message ?? error) }); throw error; }
    };
    const handler = createGatewayHandler({ config, brokerRequest, gatewayKey, health: { key, gatewayCredential }, now: () => clock, logLine: () => {}, runModelSwap: () => { throw new Error('offline fixture cannot swap'); } }); gatewayServer = createServer((req, res) => { void handler(req, res); }); gatewayURL = await listen(gatewayServer);
    service.worker.start(); await service.worker.drain();
    // Every step settles before it returns: the gateway awaits its /model-health/outcome delivery
    // before ending the client response (gateway.js, response.end after completions), the service
    // commits that outcome inside the shared serializer, and drain() waits for the serializer and
    // every worker job. No sleeps; a recorded fixture violation fails the step that observed it.
    const settled = async () => { await service.worker.drain(); if (stats.violations.length) throw new Error(`fixture contract violated: ${stats.violations.join('; ')}`); };
    return {
      stats, policy, targets, logicalID, scope, primaryID,
      state: () => structuredClone(state),
      grant: () => outageGrants(state, policy, clock).filter(g => g.logicalID === logicalID),
      advance(ms) { clock += ms; }, setFailure(value) { failure = value; }, rotate(value) { identity = value; }, setFeed(value) { feedMode = value; }, setMode(value) { mode = value; },
      async tick() { await service.worker.tick(); await settled(); },
      // external: a session-bound request on a lease the plugin (this harness) obtained from the broker
      // selector, or on a forced held current-head lease; otherwise an unbound request the gateway
      // leases itself. sessionID reuses an existing held lease (same held session, distinct request).
      async real({ external = true, forceTarget = null, sessionID = null } = {}) {
        clock++; const id = sessionID ?? `ses_fixture_${++serial}`; let a = leases.get(id) ?? null;
        if (external && !a) { if (forceTarget) { assert.equal(forceTarget, primaryID); a = storeLease(id, forceTarget); } else { await ordinaryRequest('/lease', { sessionID: id }); a = leases.get(id); } }
        const model = a ? wire(targets[a.targetID]) : 'auto'; const fast = primary.speed === 'fast';
        const body = api === 'messages' ? { model, stream: true, max_tokens: 256, messages: [{ role: 'user', content: 'Legitimate fixture request.' }], ...(fast ? { speed: 'fast' } : {}) } : { model, stream: true, input: 'Legitimate fixture request.' };
        const response = await fetch(`${gatewayURL}/v1/${api}`, { method: 'POST', headers: { authorization: `Bearer ${gatewayKey}`, 'content-type': 'application/json', ...(fast && api === 'messages' ? { 'anthropic-beta': 'fast-mode-2026-02-01' } : {}), ...(a ? { 'x-opencode-session-id': id, 'x-opencode-lease-id': a.leaseID } : {}) }, body: JSON.stringify(body) });
        await response.arrayBuffer(); await settled();
        return { status: response.status, sessionID: id, leaseID: a?.leaseID, targetID: a?.targetID, stillHeld: leases.has(id) };
      },
      async close() { if (closed) return; closed = true; await service.close(); await closeServer(gatewayServer); await closeServer(proxyServer); await closeServer(upstreamServer); rmSync(root, { recursive: true, force: true }); assert.equal(timers.size, 0); },
    };
  } catch (error) { if (service) await service.close(); await closeServer(gatewayServer); await closeServer(proxyServer); await closeServer(upstreamServer); rmSync(root, { recursive: true, force: true }); throw error; }
}
