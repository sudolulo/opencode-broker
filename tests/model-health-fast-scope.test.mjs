// Fast-scope proof: a fast outage scope may only be issued for a request whose FINAL body asked
// for speed "fast", and may only count as success when the upstream response itself reported
// usage.speed "fast". HTTP success alone is never fast proof (some models silently serve standard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHealthAuthority } from '../lib/model-health.js';
import { runOutageProbe } from '../lib/model-probe.js';
import { createHealthProtocol, verifyHealthReport } from '../gateway/lib/proxy-health-context.js';
import { makePolicy } from './helpers/model-outages.mjs';

const key = Buffer.alloc(32, 7);
const credential = `ci_${Buffer.alloc(32, 9).toString('base64url')}`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const bodyText = JSON.stringify({ model: 'claude-opus-5', speed: 'fast', stream: true, max_tokens: 256, messages: [{ role: 'user', content: 'Reply OK.' }] });

// A real authority with real HMAC verification of a real signed request/response pair.
function fixture({ scope = 'fast', origin = 'upstream-response', status = 200 } = {}) {
  let time = 1000;
  const policy = makePolicy().expectedScopePolicies[`anthropic/opus/${scope}`];
  const fast = scope === 'fast';
  const assignment = {
    held: true, sessionID: 's', leaseID: 'l', targetID: fast ? 'claude-opus-5-fast' : 'claude-opus-5',
    providerID: 'anthropic', modelID: fast ? 'claude-opus-5-fast' : 'claude-opus-5', wireModelID: 'claude-opus-5',
    primaryID: fast ? 'claude-opus-5-5-fast' : 'claude-opus-5-5', logicalID: `anthropic/opus/${scope}`,
    purpose: 'outage-health', expectedScopePolicy: policy, expectedCredentialInstance: credential, expiresAt: 60000,
  };
  const authority = createHealthAuthority({
    gatewayCredential: 'private-test-only', now: () => time, randomBytes: (size) => Buffer.alloc(size, 4),
    lookupLease: () => assignment, lookupGeneration: () => 0, latestFailureAt: () => null,
    verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding),
  });
  const protocol = createHealthProtocol({ key });
  const issue = (extra) => authority.issue({ gatewayCredential: 'private-test-only', sessionID: 's', leaseID: 'l',
    requestID: 'r', attemptID: 'a', purpose: 'outage-health', modelID: 'claude-opus-5', bodySHA256: sha256(bodyText), ...extra });
  const report = (ticket, terminal) => {
    const { context, contextSignature } = protocol.signRequest([1, ticket.nonce, ticket.startedAt, ticket.startedAt + 10000,
      'r', 'a', 'outage-health', 'anthropic', 'claude-opus-5', sha256(bodyText), credential]);
    const { attestation, attestationSignature } = protocol.signResponse([1, ticket.nonce, 'r', 'a', 'claude-opus-5', credential,
      policy.connectionID, 'https://api.anthropic.com', policy.authMode, policy.transport, policy.product, origin, status, sha256(context)]);
    time = 1100;
    return { gatewayCredential: 'private-test-only', capability: ticket.capability, context, contextSignature,
      attestation, attestationSignature, terminal, finishedAt: 1100 };
  };
  return { authority, issue, report };
}

const complete = (extra = {}) => ({ api: 'messages', state: 'complete', status: 200, errorClass: null, ...extra });

test('fast scope issuance requires the final body to have asked for speed fast', () => {
  for (const speed of [undefined, 'standard', 'turbo', null, 1, 'FAST']) {
    const f = fixture();
    assert.throws(() => f.issue(speed === undefined ? {} : { speed }), /speed|issuance fields/, `speed ${String(speed)}`);
    f.authority.close();
  }
  const f = fixture();
  assert.equal(typeof f.issue({ speed: 'fast' }).capability, 'string');
  f.authority.close();
});

test('standard scope issuance refuses a fast body and keeps omitted-speed back compatibility', () => {
  for (const [speed, ok] of [[undefined, true], ['standard', true], ['fast', false], ['turbo', false]]) {
    const f = fixture({ scope: 'standard' });
    const issue = () => f.issue(speed === undefined ? {} : { speed });
    if (ok) assert.equal(typeof issue().capability, 'string');
    else assert.throws(issue, /speed|issuance fields/);
    f.authority.close();
  }
});

test('fast scope succeeds only on actual upstream usage.speed fast', () => {
  const f = fixture();
  const ticket = f.issue({ speed: 'fast' });
  const accepted = f.authority.accept(f.report(ticket, complete({ speed: 'fast' })));
  assert.equal(accepted.outcome.result, 'success');
  assert.equal(accepted.outcome.modelID, 'claude-opus-5-fast');
  assert.equal(Object.hasOwn(accepted.outcome, 'speed'), false, 'outcome shape is unchanged');
  f.authority.close();
});

test('fast scope with standard or missing actual speed is durable unknown, never reserve proof', () => {
  for (const terminal of [complete({ speed: 'standard' }), complete()]) {
    const f = fixture();
    const ticket = f.issue({ speed: 'fast' });
    const accepted = f.authority.accept(f.report(ticket, terminal));
    assert.equal(accepted.outcome.result, 'unknown');
    assert.equal(accepted.duplicate, false);
    f.authority.close();
  }
});

test('standard scope reporting actual fast is unknown; standard or missing actual speed stays success', () => {
  for (const [terminal, result] of [[complete({ speed: 'fast' }), 'unknown'], [complete({ speed: 'standard' }), 'success'], [complete(), 'success']]) {
    const f = fixture({ scope: 'standard' });
    const ticket = f.issue({});
    assert.equal(f.authority.accept(f.report(ticket, terminal)).outcome.result, result);
    f.authority.close();
  }
});

test('malformed terminal speed rejects before burning the capability; corrected report is accepted', () => {
  for (const speed of ['turbo', null, 1, '']) {
    const f = fixture();
    const ticket = f.issue({ speed: 'fast' });
    const bad = f.report(ticket, complete({ speed }));
    assert.throws(() => f.authority.accept(bad), /terminal/);
    const corrected = f.authority.accept({ ...bad, terminal: complete({ speed: 'fast' }) });
    assert.equal(corrected.duplicate, false);
    assert.equal(corrected.outcome.result, 'success');
    f.authority.close();
  }
});

test('explicit-fast service fault keeps service classification without usage evidence', () => {
  const f = fixture({ origin: 'upstream-http', status: 503 });
  const ticket = f.issue({ speed: 'fast' });
  const accepted = f.authority.accept(f.report(ticket, { api: 'messages', state: 'http-error', status: 503, errorClass: 'service' }));
  assert.equal(accepted.outcome.result, 'service-fault');
  f.authority.close();
});

test('outage Messages probe omits thinking so a model rejecting disabled thinking accepts it within 256 total tokens', async () => {
  // Synthetic schema of the current Opus/Sonnet/Fable generation (no network): thinking
  // {type:"disabled"} is a 400, and the probe's only output bound is the 256 total-token cap.
  const validate = (body) => {
    if (body.thinking?.type === 'disabled') return 'thinking.type: disabled is not supported for this model';
    if (body.max_tokens !== 256) return 'probe must keep its 256 total-token cap';
    if (body.stream !== true || !Array.isArray(body.messages) || body.messages.length !== 1) return 'shape';
    return null;
  };
  let posts = 0, rejection;
  const trusted = { type: 'probe-accepted' };
  const result = await runOutageProbe({
    assignment: { leaseID: 'l', sessionID: 's', probeNonce: 'n', preferredModel: { providerID: 'anthropic', modelID: 'claude-opus-5-5-fast' }, expiresAt: Date.now() + 60000 },
    scope: { probe: { api: 'messages' } }, gatewayURL: 'http://gateway', gatewayKey: 'k',
    fetchImpl: async (_url, options) => { posts += 1; rejection = validate(JSON.parse(options.body)); return { status: rejection ? 400 : 200, body: null }; },
    waitForOutcome: async () => (rejection ? null : trusted),
  });
  assert.equal(posts, 1);
  assert.equal(rejection, null);
  assert.strictEqual(result, trusted);
});
