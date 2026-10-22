import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { fork, spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { makeHarness, deferred, FRONTDOOR_KEY } from './helpers/spend-gateway-fixture.mjs';
import { withLedgerDir, policyFor, rawPolicy, allocationFor, messageFor, sseFor, chunksOf,
  preparedFor, evidenceFor, metadataMessageFor, metadataSSEFor, NON_NEUTRAL_USAGE,
  NOW, MODEL, PROVIDER_ID, ORIGIN, TEST_KEY, FINGERPRINT, ATTEMPT_A } from './helpers/spend-fixture.mjs';
import { initializeLedger, fundLedger, inspectStatus, reserveAttempt, settleAttempt } from '../lib/spend-budget.js';
import { prepareSpendAttempt } from '../lib/spend-policy.js';
import { createGatewayHandler, loadGatewayConfig } from '../lib/gateway.js';
import { collectSpendJSON } from '../lib/spend-transport.js';

const status = (ledgerPath, policy, now = NOW) => inspectStatus({ ledgerPath, policy, now });
const balances = s => [s.fundedNano, s.availableNano, s.heldNano, s.spentNano];
async function fund(ledgerPath, policy = policyFor(ledgerPath), amount = '0.000000350', allocation = {}) {
  await initializeLedger({ ledgerPath, policy, now: NOW });
  if (amount !== null) await fundLedger({ ledgerPath, policy, now: NOW, allocation: allocationFor(amount, allocation) });
  return policy;
}
function rows(ledgerPath, sql = 'SELECT * FROM attempts') {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try { const stmt = db.prepare(sql); stmt.setReadBigInts(true); return stmt.all(); } finally { db.close(); }
}
// Every financial refusal before the response head is a terminal HTTP 402 in the
// native Anthropic error envelope, with x-should-retry:false for the Anthropic SDK.
function assertFinancialHead(response) {
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('x-should-retry'), 'false');
}
async function refusal(h, code, body = {}, options = {}) {
  const response = await h.send(body, options);
  assertFinancialHead(response);
  const value = await response.json();
  assert.equal(value.type, 'error');
  assert.equal(value.error.type, 'spend_budget_refusal');
  assert.equal(value.error.retryable, false);
  if (code) assert.equal(value.error.code, code);
  assert.equal(JSON.stringify(value).includes(TEST_KEY), false);
  assert.equal(h.brokerCalls.some(c => c.path === '/failure'), false);
  return value;
}

test('successful baseline fixture reaches actual handler upstream', async () => {
  await withLedgerDir(async ledgerPath => {
    const h = await makeHarness({ ledgerPath, includePolicy: false, attested: false });
    try { assert.equal((await h.send()).status, 200); assert.equal(h.upstreamCalls(), 1); }
    finally { await h.close(); }
  });
});

test('missing ledger has zero upstream calls', async () => {
  await withLedgerDir(async ledgerPath => {
    const h = await makeHarness({ ledgerPath });
    try { await refusal(h, 'missing_ledger'); assert.equal(h.upstreamCalls(), 0); }
    finally { await h.close(); }
  });
});

test('final bytes are bound and durable before fetch; default burn is not estimated usage', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath);
    const h = await makeHarness({ ledgerPath, providerOverrides: { bodyExtras: { stream_options: { include_usage: true }, speed: 'fast' } },
      fetchImpl: async (url, init) => {
        assert.equal(url, `${ORIGIN}/v1/messages`);
        assert.equal(init.redirect, 'error');
        const body = JSON.parse(init.body);
        assert.equal(body.service_tier, 'standard_only'); assert.equal(body.max_tokens, 10);
        assert.equal(body.model, MODEL); assert.equal(body.stream_options, undefined); assert.equal(body.speed, undefined);
        assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]);
        const row = rows(ledgerPath)[0];
        const prepared = prepareSpendAttempt({ policy, providerID: PROVIDER_ID, url, body: init.body,
          headers: Object.fromEntries(init.headers), credentialFingerprint: FINGERPRINT, now: NOW });
        assert.equal(row.state, 'DISPATCH_COMMITTED');
        assert.equal(row.body_digest, createHash('sha256').update(init.body).digest('hex'));
        assert.equal(row.request_digest, prepared.requestDigest);
        assert.equal(Object.isFrozen(init.headers), true);
        assert.equal(Object.isFrozen(init.headers[0]), true);
        assert.equal(row.credential_sha256, FINGERPRINT);
        assert.match(row.attempt_id, /^[a-f0-9-]{36}$/);
        assert.equal(JSON.stringify(row, (_, v) => typeof v === 'bigint' ? String(v) : v).includes(TEST_KEY), false);
        return new Response(JSON.stringify(messageFor()), { headers: { 'content-type': 'application/json' } });
      } });
    try {
      assert.equal((await h.send({ service_tier: undefined, model: 'manual-alias' })).status, 200);
      assert.equal(h.upstreamCalls(), 1);
      const s = await status(ledgerPath, policy);
      assert.deepEqual(balances(s), [350n, 0n, 0n, 350n]); assert.equal(s.observedCostNano, 42n);
      assert.equal(s.attemptCounts.SETTLED, 1);
      assert.equal((await readFile(ledgerPath)).includes(Buffer.from(TEST_KEY)), false);
    } finally { await h.close(); }
  });
});

const admissions = [
  ['missing policy', 'missing_policy', h => { delete h.provider.spendBudget; }],
  ['explicit null policy', 'invalid_policy', h => { h.provider.spendBudget = null; }],
  ['explicit false policy', 'invalid_policy', h => { h.provider.spendBudget = false; }],
  ['unknown policy key', 'invalid_policy', h => { h.provider.spendBudget.monthlyUSD = '200'; }],
  ['policy hash changed', 'invalid_ledger', h => { h.provider.spendBudget.policyID = 'changed'; }],
  ['provider binding', 'binding_mismatch', h => { h.provider.spendBudget.binding.providerID = 'other'; }],
  ['origin binding', 'binding_mismatch', h => { h.provider.baseUrl = 'https://regional.example/v1'; }],
  ['effective key fingerprint', 'binding_mismatch', async h => { await writeFile(h.keyFile, 'synthetic-different-key'); }],
  ['key missing', 'binding_mismatch', h => { h.provider.keyFile += '-missing'; }],
  ['key unsafe', 'binding_mismatch', h => chmod(h.keyFile, 0o644)],
  ['missing forward config', 'invalid_policy', h => { delete h.provider.baseUrl; }],
  ['unknown classification', 'invalid_policy', h => { h.target.billingClass = 'unknown-paid'; }],
  ['false manual contradiction', 'invalid_policy', h => { h.target.requiresSpendBudget = false; }],
  ['missing paid class', 'invalid_policy', h => { delete h.target.billingClass; }],
  ['missing paid boolean', 'invalid_policy', h => { delete h.target.requiresSpendBudget; }],
  ['nonboolean attestation', 'invalid_policy', h => { h.target.requiresSpendBudget = 'true'; }],
  ['unknown beta', 'unsupported_request', h => { h.provider.headers = { 'anthropic-beta': 'unknown-billing' }; }],
  ['unknown final header', 'unsupported_request', h => { h.provider.headers = { 'x-provider-region': 'regional' }; }],
  ['unknown anthropic control', 'unsupported_request', h => { h.provider.headers = { 'anthropic-fast': 'true' }; }],
  ['private health config', 'unsupported_request', h => { h.provider.headers = { 'x-fleet-health-context': 'private' }; }],
  ['ambiguous auth config', 'unsupported_request', h => { h.provider.headers = { 'X-Api-Key': 'synthetic-override' }; }],
  ['alternate auth config', 'unsupported_request', h => { h.provider.headers = { Authorization: 'Bearer synthetic' }; }],
  ['case-colliding version', 'unsupported_request', h => { h.provider.headers = { 'Anthropic-Version': '2023-06-01' }; }],
  ['noncanonical version', 'unsupported_request', h => { h.provider.headers = { 'anthropic-version': '2026-01-01' }; }],
  ['unsupported final URL query', 'unsupported_request', h => { h.provider.baseUrl = `${ORIGIN}/v1?region=us`; }],
  ['unsupported final URL path', 'unsupported_request', h => { h.provider.baseUrl = `${ORIGIN}/v2`; }],
  ['premium tier', 'unsupported_request', null, { service_tier: 'auto' }],
  ['null tier', 'unsupported_request', null, { service_tier: null }],
  ['fast body', 'unsupported_request', null, { speed: 'fast' }],
  ['region body', 'unsupported_request', null, { region: 'us' }],
  ['unknown body', 'unsupported_request', null, { surprise_bill: true }],
  ['server tool', 'unsupported_request', null, { tools: [{ type: 'web_search_20250305', name: 'web_search' }] }],
  ['nested unknown', 'unsupported_request', null, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', premium: true }] }] }],
  ['missing max_tokens', 'unsupported_request', null, { max_tokens: undefined }],
  ['max_tokens zero', 'unsupported_request', null, { max_tokens: 0 }],
  ['max_tokens fractional', 'unsupported_request', null, { max_tokens: 1.1 }],
  ['max_tokens over bound', 'unsupported_request', null, { max_tokens: 11 }],
  ['unknown final model', 'unsupported_request', h => { h.target.model.id = 'unknown'; }],
  ['incoming beta', 'unsupported_request', null, {}, { headers: { 'anthropic-beta': 'billing-control' } }],
  ['incoming region', 'unsupported_request', null, {}, { headers: { 'anthropic-region': 'us' } }],
  ['incoming wrong version', 'unsupported_request', null, {}, { headers: { 'anthropic-version': '2026-01-01' } }],
  ['chat path', 'unsupported_request', null, {}, { path: '/v1/chat/completions' }],
  ['responses path', 'unsupported_request', null, {}, { path: '/v1/responses' }],
  ['embeddings path', 'unsupported_request', h => { h.target.embedding = true; }, { input: 'hello' }, { path: '/v1/embeddings' }],
];
for (const [name, code, mutate, body, options] of admissions) test(`admission ${name}: zero egress and balances unchanged`, async () => {
  await withLedgerDir(async ledgerPath => {
    const original = await fund(ledgerPath);
    const before = await status(ledgerPath, original);
    const h = await makeHarness({ ledgerPath });
    try {
      await mutate?.(h); await refusal(h, code, body, options);
      assert.equal(h.upstreamCalls(), 0);
      assert.equal(h.brokerCalls.filter(c => c.path === '/lease').length, 1, 'financial refusal must not fall back');
      assert.deepEqual(await status(ledgerPath, original), before);
    } finally { await h.close(); }
  });
});

for (const [name, amount, code] of [['unfunded', null, 'insufficient_funds'], ['insufficient', '0.000000349', 'insufficient_funds']]) {
  test(`admission ${name} wallet`, async () => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath, policyFor(ledgerPath), amount);
    const before = await status(ledgerPath, policy); const h = await makeHarness({ ledgerPath });
    try { await refusal(h, code); assert.equal(h.upstreamCalls(), 0); assert.deepEqual(await status(ledgerPath, policy), before); }
    finally { await h.close(); }
  }));
}
for (const [name, time] of [['epoch', Date.parse('2026-10-21T11:30:00.000Z')], ['policy', Date.parse('2026-10-21T12:01:00.000Z')]]) {
  test(`admission expired ${name} retains balances`, async () => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath); const before = await status(ledgerPath, policy, time);
    const h = await makeHarness({ ledgerPath, now: () => time });
    try { await refusal(h, 'expired'); assert.equal(h.upstreamCalls(), 0); assert.deepEqual(await status(ledgerPath, policy, time), before); }
    finally { await h.close(); }
  }));
}
test('corrupt and unsafe wallet never reset or dispatch', async () => {
  for (const kind of ['corrupt', 'unsafe']) await withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath); const before = await status(ledgerPath, policy);
    if (kind === 'corrupt') await writeFile(ledgerPath, 'synthetic-corruption'); else await chmod(ledgerPath, 0o644);
    const bytes = await readFile(ledgerPath); const h = await makeHarness({ ledgerPath });
    try {
      await refusal(h, 'invalid_ledger'); assert.equal(h.upstreamCalls(), 0); assert.deepEqual(await readFile(ledgerPath), bytes);
      if (kind === 'unsafe') { await chmod(ledgerPath, 0o600); assert.deepEqual(await status(ledgerPath, policy), before); }
    } finally { await h.close(); }
  });
});
test('real SQLite lock has terminal refusal and no balance changes', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const before = await status(ledgerPath, policy);
  const db = new DatabaseSync(ledgerPath); db.exec('BEGIN IMMEDIATE');
  const h = await makeHarness({ ledgerPath });
  try { await refusal(h, 'locked'); assert.equal(h.upstreamCalls(), 0); }
  finally { db.exec('ROLLBACK'); db.close(); await h.close(); }
  assert.deepEqual(await status(ledgerPath, policy), before);
}));

for (const verified of [false, true]) test(`trusted flags survive ${verified ? 'verified session' : 'ordinary lease'} normalization`, async () => {
  await withLedgerDir(async ledgerPath => {
    const h = await makeHarness({ ledgerPath, includePolicy: false });
    try {
      await refusal(h, 'missing_policy', {}, verified ? { headers: { 'x-opencode-session-id': 'session-fixture', 'x-opencode-lease-id': 'synthetic-lease' } } : {});
      assert.equal(h.upstreamCalls(), 0);
      assert.ok(h.brokerCalls.some(c => c.path === (verified ? '/lease/verify' : '/lease')));
    } finally { await h.close(); }
  });
});
test('legacy policy alone still gates without broker attestation', async () => withLedgerDir(async ledgerPath => {
  const h = await makeHarness({ ledgerPath, attested: false });
  try { await refusal(h, 'missing_ledger'); assert.equal(h.upstreamCalls(), 0); } finally { await h.close(); }
}));

test('startup strictly validates policies and bindings without opening a wallet, registration explicitly deferred', async () => withLedgerDir(async ledgerPath => {
  const h = await makeHarness({ ledgerPath });
  try {
    assert.ok(h.logs.some(log => log.event === 'spend_budget_validation' && log.registration === 'deferred'));
    for (const bad of [null, false, {}, { ...rawPolicy(ledgerPath), unknown: 1 }]) {
      const config = { providers: { [PROVIDER_ID]: { ...h.provider, spendBudget: bad } } };
      assert.throws(() => createGatewayHandler({ config, brokerRequest: async () => assert.fail('startup must not query broker') }), { code: 'invalid_policy' });
      const path = `${h.keyFile}-config`; await writeFile(path, JSON.stringify(config));
      assert.throws(() => loadGatewayConfig(path), { code: 'invalid_policy' });
    }
    assert.throws(() => createGatewayHandler({ config: { providers: { other: h.provider } } }), { code: 'binding_mismatch' });
    await assert.rejects(readFile(ledgerPath), { code: 'ENOENT' });
  } finally { await h.close(); }
}));

test('startup accepts a null provider sibling, reports a real spend policy, and refuses a null paid provider before egress', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath);
  const h = await makeHarness({ ledgerPath });
  try {
    // The null sibling must come BEFORE the paid provider: the startup scan uses
    // `.some`, which would short-circuit on the paid entry and never reach a
    // trailing null, letting the test pass even without the null guard.
    h.config.providers = { missing: null, ...h.config.providers };
    const logs = [];
    assert.doesNotThrow(() => createGatewayHandler({
      config: h.config,
      gatewayKey: FRONTDOOR_KEY,
      logLine: line => logs.push(JSON.parse(line)),
      brokerRequest: async () => assert.fail('startup must not query broker'),
    }));
    assert.ok(logs.some(log => log.event === 'spend_budget_validation' && log.policyShape === 'validated'));
    h.target.model.providerID = 'missing';
    await refusal(h, 'missing_policy');
    assert.equal(h.upstreamCalls(), 0);
    assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 350n, 0n, 0n]);
  } finally { await h.close(); }
}));

const cleanupRejectingResponse = ({ read, cancel }) => {
  let released = false;
  const reader = {
    read,
    cancel,
    releaseLock() { released = true; },
  };
  return { response: { body: { getReader: () => reader } }, released: () => released };
};

for (const [name, setup, want] of [
  ['body error', () => cleanupRejectingResponse({ read: async () => { throw new Error('synthetic body failure'); }, cancel: async () => { throw new Error('synthetic cancel failure'); } }), 'body_error'],
  ['synchronous cancel throw', () => cleanupRejectingResponse({ read: async () => { throw new Error('synthetic body failure'); }, cancel: () => { throw new Error('synthetic cancel failure'); } }), 'body_error'],
  ['abort', () => cleanupRejectingResponse({ read: () => new Promise(() => {}), cancel: async () => { throw new Error('synthetic cancel failure'); } }), 'aborted'],
  ['JSON limit', () => cleanupRejectingResponse({ read: async () => ({ done: false, value: new Uint8Array(1048577) }), cancel: async () => { throw new Error('synthetic cancel failure'); } }), 'json_limit'],
]) test(`spend JSON ${name} preserves the primary failure when owned cancellation rejects`, async () => {
  const fixture = setup();
  const controller = new AbortController();
  const signal = controller.signal;
  let unhandled = null;
  const onUnhandled = error => { unhandled = error; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = name === 'abort'
      ? (() => { controller.abort(); return collectSpendJSON({ response: fixture.response, controller, signal }); })()
      : collectSpendJSON({ response: fixture.response, controller, signal });
    await assert.rejects(result, error => error.code === 'unsupported_request' && error.spendReason === want && error.cleanupReason === 'cancel_failed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, null);
    assert.equal(fixture.released(), true);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('no-budget construction emits no spend diagnostic on any channel and still serves', async t => withLedgerDir(async ledgerPath => {
  const info = t.mock.method(console, 'info', () => {});
  const log = t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  const h = await makeHarness({ ledgerPath, includePolicy: false, attested: false });
  try {
    // A null sibling must not make the scan throw or count as a configured budget.
    const logs = [];
    createGatewayHandler({ config: { providers: { missing: null, ...h.config.providers } }, gatewayKey: FRONTDOOR_KEY,
      logLine: line => logs.push(JSON.parse(line)), brokerRequest: async () => assert.fail('startup must not query broker') });
    assert.deepEqual(logs, []);
    assert.equal(h.logs.some(entry => entry.event === 'spend_budget_validation'), false);
    assert.equal(info.mock.calls.length, 0); assert.equal(log.mock.calls.length, 0); assert.equal(errors.mock.calls.length, 0);
    assert.equal((await h.send()).status, 200);
  } finally { await h.close(); }
}));

test('configured budget reports deferred registration validation only through the log contract', async t => withLedgerDir(async ledgerPath => {
  const info = t.mock.method(console, 'info', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  const h = await makeHarness({ ledgerPath });
  try {
    assert.equal(h.logs.filter(entry => entry.event === 'spend_budget_validation' && entry.registration === 'deferred'
      && entry.policyShape === 'validated').length, 1);
    assert.equal(info.mock.calls.length, 0); assert.equal(errors.mock.calls.length, 0);
  } finally { await h.close(); }
}));

// A failed paid dispatch is never retried by the gateway (it would be another paid send);
// the client gets the terminal 402 paid_upstream_failed instead (the AI SDK retries any >= 500).
async function assertPaidUpstreamFailed(response, detail) {
  assertFinancialHead(response);
  assert.deepEqual(await response.json(), { type: 'error', error: { type: 'spend_budget_refusal', code: 'paid_upstream_failed',
    message: `spend budget refused: paid_upstream_failed (${detail})`, retryable: false } });
}
for (const amount of ['0.000000700', '0.000000350']) test(`paid 503 is not retried with ${amount === '0.000000700' ? 'funds for a second send' : 'no retry funds'}: one durable attempt, full hold`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath, policyFor(ledgerPath), amount); let calls = 0;
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => {
    calls++; return calls === 1 ? new Response('unavailable', { status: 503 }) : new Response(JSON.stringify(messageFor()));
  } });
  try {
    const response = await h.send(); await assertPaidUpstreamFailed(response, 'upstream HTTP 503'); assert.equal(calls, 1);
    const attempts = rows(ledgerPath); assert.equal(attempts.length, 1); assert.equal(attempts[0].state, 'UNCERTAIN');
    const funded = amount === '0.000000700' ? 700n : 350n;
    assert.deepEqual(balances(await status(ledgerPath, policy)), [funded, funded - 350n, 350n, 0n]);
  } finally { await h.close(); }
}));
test('concurrent handler requests have exactly one winner from one 350n wallet', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const entered = deferred(), release = deferred();
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => { entered.resolve(); await release.promise; return new Response(JSON.stringify(messageFor())); } });
  try {
    const a = h.send(); await entered.promise;
    const b = await h.send(); assertFinancialHead(b); assert.equal((await b.json()).error.code, 'insufficient_funds');
    release.resolve(); assert.equal((await a).status, 200); assert.equal(h.upstreamCalls(), 1);
    assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 0n, 350n]);
  } finally { release.resolve(); await h.close(); }
}));

test('same-tick handler paid requests funded for both each reserve, fetch and settle', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath, policyFor(ledgerPath), '0.000000700');
  const h = await makeHarness({ ledgerPath });
  try {
    const responses = await Promise.all([h.send(), h.send()]);
    const bodies = await Promise.all(responses.map(r => r.text()));
    assert.deepEqual(responses.map(r => r.status), [200, 200], bodies.join('\n'));
    assert.equal(h.upstreamCalls(), 2);
    const s = await status(ledgerPath, policy);
    assert.deepEqual(balances(s), [700n, 0n, 0n, 700n]); assert.equal(s.attemptCounts.SETTLED, 2);
  } finally { await h.close(); }
}));

// The later case crosses both expiries: valid epochs cannot outlive the policy.
// The ledger validated expiry at reservation time; time can pass before the single
// fetch site (queueing, slow storage). Egress must still be bounded by that SAME
// validated transaction's deadline, without reopening the ledger to re-ask.
for (const [name, late] of [['epoch', Date.parse('2026-10-21T11:30:00.000Z')], ['both epoch and policy', Date.parse('2026-10-21T12:01:00.000Z')]]) {
  test(`reservation delayed past ${name} expiry is never dispatched and retains its full hold`, async t => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath); let clock = NOW; let reserved = 0;
    const real = await import('../lib/spend-budget.js');
    const mock = t.mock.module('../lib/spend-budget.js', { exports: { ...real, reserveAttempt: async args => {
      const result = await real.reserveAttempt(args); reserved++; clock = late; return result;
    } } });
    let h;
    try {
      const { createGatewayHandler: handlerFactory } = await import(`../lib/gateway.js?delayed-expiry-${name}`);
      h = await makeHarness({ ledgerPath, handlerFactory, now: () => clock });
      await refusal(h, 'expired');
      assert.equal(reserved, 1); assert.equal(h.upstreamCalls(), 0);
      const row = rows(ledgerPath)[0];
      assert.equal(row.state, 'UNCERTAIN'); assert.equal(row.uncertain_reason, 'expired_before_send');
      assert.deepEqual(balances(await status(ledgerPath, policy, late)), [350n, 0n, 350n, 0n]);
      // Historical receipt settlement is unchanged: it is not an expiry-gated egress.
      const settled = await settleAttempt({ ledgerPath, policy, attemptID: row.attempt_id, evidence: evidenceFor(), now: late });
      assert.equal(settled.state, 'SETTLED');
      assert.deepEqual(balances(await status(ledgerPath, policy, late)), [350n, 0n, 0n, 350n]);
    } finally { if (h) await h.close(); mock.restore(); }
  }));
}

function streamResponse(parts, { status = 200, contentType = 'text/event-stream', onCancel = () => {}, onPull = () => {} } = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) { onPull(); if (index < parts.length) controller.enqueue(parts[index++]); else controller.close(); },
    cancel: onCancel,
  }, { highWaterMark: 0 }), { status, headers: { 'content-type': contentType } });
}
const refundOverrides = { reconcileUsage: true,
  billingReceiptContract: { confirmedAt: '2026-10-20T10:00:00.000Z', reference: 'synthetic-contract-fixture' } };
for (const mode of ['json', 'sse']) for (const refund of [false, true]) {
  test(`complete ${mode} ${refund ? 'verified refund 308 once' : 'burn 350 observed 42'} owned by handler`, async () => withLedgerDir(async ledgerPath => {
    const overrides = refund ? refundOverrides : {};
    const policy = await fund(ledgerPath, policyFor(ledgerPath, overrides));
    const h = await makeHarness({ ledgerPath, policyOverrides: overrides,
      fetchImpl: async () => mode === 'sse' ? streamResponse(chunksOf(sseFor(), 1)) : new Response(JSON.stringify(messageFor())) });
    try {
      const response = await h.send({ stream: mode === 'sse' }); assert.equal(response.status, 200);
      if (mode === 'sse') assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(sseFor()));
      const s = await status(ledgerPath, policy);
      assert.deepEqual(balances(s), refund ? [350n, 308n, 0n, 42n] : [350n, 0n, 0n, 350n]);
      assert.equal(s.observedCostNano, 42n); assert.equal(s.attemptCounts.SETTLED, 1);
      const row = rows(ledgerPath)[0];
      const duplicate = await settleAttempt({ ledgerPath, policy, attemptID: row.attempt_id, evidence: JSON.parse(row.receipt_json), now: NOW });
      assert.equal(duplicate.duplicate, true); assert.deepEqual(await status(ledgerPath, policy), s);
    } finally { await h.close(); }
  }));
}
for (const httpStatus of [200, 503]) test(`oversized JSON HTTP ${httpStatus} aborts at 1MiB without retry or receipt hunt`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); let pulls = 0, cancels = 0, signal;
  const parts = Array.from({ length: 20 }, () => new Uint8Array(65536).fill(32));
  const h = await makeHarness({ ledgerPath, fetchImpl: async (_url, init) => {
    signal = init.signal;
    return streamResponse(parts, { status: httpStatus, contentType: 'application/json', onPull: () => pulls++, onCancel: () => cancels++ });
  } });
  try {
    const response = await h.send(); assertFinancialHead(response);
    assert.equal((await response.json()).error.type, 'spend_budget_refusal');
    assert.equal(pulls, 17); assert.equal(cancels, 1); assert.equal(signal.aborted, true);
    assert.equal(h.upstreamCalls(), 1);
    const s = await status(ledgerPath, policy); assert.deepEqual(balances(s), [350n, 0n, 350n, 0n]); assert.equal(s.attemptCounts.UNCERTAIN, 1);
  } finally { await h.close(); }
}));

test('private health is never begun or forwarded for paid calls; ordinary health is unchanged', async t => withLedgerDir(async ledgerPath => {
  await fund(ledgerPath); let begins = 0, finishes = 0;
  const mock = t.mock.module('../lib/model-health.js', { exports: {
    createGatewayHealth: () => ({
      begin: async () => { begins++; return { api: 'messages', headers: { 'x-fleet-health-context': 'synthetic-private-context' } }; },
      captureResponse: () => null, finish: async () => { finishes++; },
    }), createTerminalParser: () => ({ push() {}, finish: () => ({}) }),
  } });
  try {
    const { createGatewayHandler: handlerFactory } = await import('../lib/gateway.js?health-isolation');
    for (const paid of [true, false]) {
      const h = await makeHarness({ ledgerPath, handlerFactory, attested: paid, includePolicy: paid,
        providerOverrides: { forwardSessionHints: true }, health: { key: new Uint8Array(32), gatewayCredential: 'synthetic-health' } });
      try {
        assert.equal((await h.send({}, { headers: { 'x-opencode-session-id': 'session-fixture', 'x-opencode-session-kind': 'primary' } })).status, 200);
        const headers = new Headers(h.calls[0].init.headers);
        assert.equal(headers.has('x-fleet-health-context'), !paid);
        assert.equal(headers.has('x-opencode-session-id'), !paid);
        assert.equal(begins, paid ? 0 : 1); assert.equal(finishes, paid ? 0 : 1);
      } finally { await h.close(); }
    }
  } finally { mock.restore(); }
}));

for (const mode of ['required-health', 'generic-probe', 'outage-health', 'outage-fast']) test(`paid ${mode} is refused before health and egress`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const before = await status(ledgerPath, policy);
  const probeSession = `gw-probe-${'a'.repeat(43)}`, nonce = `pbn_${'b'.repeat(43)}`;
  const h = await makeHarness({ ledgerPath, brokerImpl: async (path, _body, target) => {
    if (path === '/lease' || path === '/lease/verify') return { held: true, leaseID: 'synthetic-lease', target,
      ...(mode === 'required-health' ? { expectedCredentialInstance: 'synthetic-instance' } : {}) };
    if (path === '/probe/consume') return { sessionID: probeSession, preferredModel: { providerID: PROVIDER_ID, modelID: MODEL },
      ...(mode.startsWith('outage') ? { purpose: 'outage-health', leaseID: 'synthetic-probe-lease', modelID: MODEL, wireModelID: MODEL,
        targetID: target.id, expectedCredentialInstance: 'synthetic-instance', expectedScopePolicy: {
          providerID: PROVIDER_ID, transport: 'messages', probe: { api: 'messages' }, speed: mode === 'outage-fast' ? 'fast' : 'standard' },
        requiresSpendBudget: true, billingClass: 'manual-api' } : {}) };
    return { ok: true };
  } });
  try {
    const headers = mode === 'required-health' ? {} : { 'x-opencode-probe-session': probeSession, 'x-opencode-probe-nonce': nonce,
      ...(mode.startsWith('outage') ? { 'x-opencode-probe-purpose': 'outage-health' } : {}) };
    await refusal(h, 'unsupported_request', {}, { headers }); assert.equal(h.upstreamCalls(), 0);
    assert.deepEqual(await status(ledgerPath, policy), before);
    if (mode.startsWith('outage')) assert.equal(h.brokerCalls.some(c => c.path === '/lease'), false);
  } finally { await h.close(); }
}));

for (const verified of [false, true]) for (const fields of [
  { requiresSpendBudget: false, billingClass: 'manual-api' },
  { requiresSpendBudget: true, billingClass: 'unknown' },
  { requiresSpendBudget: null, billingClass: 'manual-api' },
]) test(`bad trusted metadata ${JSON.stringify(fields)} on ${verified ? 'verify' : 'lease'}`, async () => withLedgerDir(async ledgerPath => {
  const h = await makeHarness({ ledgerPath, brokerTargetOverrides: fields, includePolicy: false });
  try { await refusal(h, 'invalid_policy', {}, verified ? { headers: { 'x-opencode-session-id': 'session-fixture' } } : {}); assert.equal(h.upstreamCalls(), 0); }
  finally { await h.close(); }
}));

for (const [name, makeParts] of [
  ['missing stop', () => [sseFor().subarray(0, sseFor().length - 51)]],
  ['error event', () => [Buffer.from('event: error\ndata: {"type":"error","error":{"type":"api_error"}}\n\n')]],
  ['invalid usage', () => [Buffer.from(Buffer.from(sseFor()).toString().replace('"input_tokens":2', '"input_tokens":-1'))]],
  ['missing usage', () => [Buffer.from(Buffer.from(sseFor()).toString().replace('"cache_read_input_tokens":4,', ''))]],
  ['oversized event', () => [Buffer.from('event: content_block_delta\ndata: ' + 'x'.repeat(65537) + '\n\n'), sseFor()]],
  ['trailing partial UTF8', () => [sseFor(), Uint8Array.of(0xf0, 0x9f)]],
]) test(`SSE ${name} retains full hold without refund`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath, policyFor(ledgerPath, refundOverrides)); const parts = makeParts();
  const h = await makeHarness({ ledgerPath, policyOverrides: refundOverrides, fetchImpl: async () => streamResponse(parts) });
  try {
    const response = await h.send({ stream: true }); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat(parts.map(part => Buffer.from(part))));
    const s = await status(ledgerPath, policy); assert.deepEqual(balances(s), [350n, 0n, 350n, 0n]); assert.equal(s.attemptCounts.UNCERTAIN, 1);
    assert.equal(s.observedCostNano, 0n); assert.equal(rows(ledgerPath)[0].receipt_hash, null); assert.equal(h.upstreamCalls(), 1);
  } finally { await h.close(); }
}));

for (const usage of [{ ...messageFor().usage, output_tokens: 11 }, { ...messageFor().usage, output_tokens: 100 },
  { ...messageFor().usage, input_tokens: 101 }]) test(`over-bound usage ${JSON.stringify(usage)} freezes the next request`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath, policyFor(ledgerPath), '0.000000700');
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => new Response(JSON.stringify(messageFor({ usage }))) });
  try {
    const response = await h.send(); assertFinancialHead(response); assert.equal((await response.json()).error.code, 'frozen');
    const before = await status(ledgerPath, policy); assert.equal(before.frozen, true);
    assert.deepEqual(balances(before), [700n, 350n, 350n, 0n]);
    assert.equal(rows(ledgerPath, 'SELECT * FROM violations').length, 1);
    if (usage.output_tokens === 100) { assert.equal(before.additionalLiabilityNano, 167n); assert.equal(before.observedCostNano, 517n); }
    await refusal(h, 'frozen'); assert.equal(h.upstreamCalls(), 1); assert.deepEqual(await status(ledgerPath, policy), before);
  } finally { await h.close(); }
}));

test('redirect error cannot escape, and fetch exception never leaks key or body', async () => withLedgerDir(async ledgerPath => {
  // Funded for a second send: only the gateway's own rule, not the wallet, stops a retry.
  const policy = await fund(ledgerPath, policyFor(ledgerPath), '0.000000700'); const h = await makeHarness({ ledgerPath, fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, 'error'); throw new TypeError(`redirect to https://elsewhere.invalid: ${TEST_KEY}`);
  } });
  try {
    const response = await h.send(); await assertPaidUpstreamFailed(response, 'transport');
    assert.equal(h.upstreamCalls(), 1, 'exactly one paid fetch'); assert.equal(rows(ledgerPath).length, 1); assert.equal(rows(ledgerPath)[0].state, 'UNCERTAIN');
    assert.equal(JSON.stringify([...h.brokerCalls, ...h.logs]).includes(TEST_KEY), false);
    assert.deepEqual(balances(await status(ledgerPath, policy)), [700n, 350n, 350n, 0n]);
  } finally { await h.close(); }
}));

test('handler awaits financial settlement and completion report, no detached refund', async t => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const settling = deferred(), settleGo = deferred(), reporting = deferred(), reportGo = deferred();
  const real = await import('../lib/spend-budget.js');
  const mock = t.mock.module('../lib/spend-budget.js', { exports: { ...real, settleAttempt: async args => {
    settling.resolve(); await settleGo.promise; return real.settleAttempt(args);
  } } });
  let h;
  try {
    const { createGatewayHandler: handlerFactory } = await import('../lib/gateway.js?settlement-owned');
    h = await makeHarness({ ledgerPath, handlerFactory, brokerImpl: async (path, _body, target) => {
      if (path === '/lease') return { leaseID: 'synthetic-lease', target };
      if (path === '/complete') { reporting.resolve(); await reportGo.promise; }
      return { ok: true };
    } });
    const run = h.start(); let finished = false; run.done.then(() => { finished = true; });
    await settling.promise; assert.equal(finished, false); assert.equal(run.response.writableEnded, false);
    assert.equal((await status(ledgerPath, policy)).heldNano, 350n);
    settleGo.resolve(); await reporting.promise; assert.equal(finished, false); assert.equal(run.response.writableEnded, false);
    reportGo.resolve(); assert.equal((await run.done).status, 200); assert.equal((await status(ledgerPath, policy)).spentNano, 350n);
  } finally { settleGo.resolve(); reportGo.resolve(); if (h) await h.close(); mock.restore(); }
}));

test('settlement storage error is explicit, leaves hold and never reports complete', async t => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const prepare = DatabaseSync.prototype.prepare;
  const mock = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (sql.startsWith("UPDATE attempts SET state='SETTLED'")) throw Object.assign(new Error(`synthetic I/O ${TEST_KEY}`), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    return prepare.call(this, sql);
  });
  const h = await makeHarness({ ledgerPath });
  try {
    await refusal(h, 'invalid_ledger'); assert.equal(h.upstreamCalls(), 1);
    assert.equal(h.brokerCalls.some(c => c.path === '/complete' || c.path === '/usage'), false);
    assert.equal(JSON.stringify(h.logs).includes(TEST_KEY), false);
    assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]);
  } finally { mock.mock.restore(); await h.close(); }
}));

async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
test('backpressured downstream close aborts fetch and cancels reader without another pull', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const written = deferred(); let pulls = 0, cancels = 0, signal;
  const h = await makeHarness({ ledgerPath, fetchImpl: async (_url, init) => {
    signal = init.signal;
    return streamResponse([sseFor(), sseFor()], { onPull: () => pulls++, onCancel: () => cancels++ });
  } });
  let run;
  try {
    run = h.start({ stream: true }, { write: () => { written.resolve(); return false; } });
    await bounded(written.promise, 'backpressure'); assert.equal(pulls, 1);
    run.response.disconnect(); await bounded(run.done, 'cancelled handler');
    assert.equal(signal.aborted, true); assert.equal(cancels, 1); assert.equal(pulls, 1);
    const s = await status(ledgerPath, policy); assert.deepEqual(balances(s), [350n, 0n, 350n, 0n]); assert.equal(s.attemptCounts.UNCERTAIN, 1);
  } finally { run?.response.disconnect(); await h.close(); }
}));

test('real NodeHTTP mid-UTF8 client disconnect cancels pending WebStream read and actual fetch signal', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const handlerDone = deferred(), pendingRead = deferred(); let signal, pulls = 0, cancels = 0;
  const partial = Buffer.concat([sseFor().subarray(0, 80), Buffer.from([0xf0, 0x9f])]);
  const h = await makeHarness({ ledgerPath, fetchImpl: async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({
      pull(controller) { pulls++; if (pulls === 1) controller.enqueue(partial); else pendingRead.resolve(); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const server = createServer(async (req, res) => { try { await h.handler(req, res); handlerDone.resolve(); } catch (error) { handlerDone.reject(error); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); let client, downstream;
  try {
    const received = deferred();
    client = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/messages', method: 'POST',
      headers: { authorization: `Bearer ${FRONTDOOR_KEY}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' } }, res => {
      downstream = res; res.once('data', data => received.resolve(data)); res.on('error', error => { if (error.code !== 'ECONNRESET') received.reject(error); });
    });
    client.on('error', error => { if (error.code !== 'ECONNRESET') received.reject(error); });
    client.end(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], max_tokens: 10, stream: true }));
    assert.deepEqual(await bounded(received.promise, 'client first bytes'), partial);
    await bounded(pendingRead.promise, 'pending upstream read'); downstream.destroy(); client.destroy();
    await bounded(handlerDone.promise, 'real disconnected handler');
    assert.equal(signal.aborted, true); assert.equal(cancels, 1); assert.equal(pulls, 2);
    assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]);
    assert.equal(rows(ledgerPath)[0].state, 'UNCERTAIN');
  } finally {
    downstream?.destroy(); client?.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await h.close();
  }
}));

test('stall timeout aborts and cancels a WebStream which ignores fetch signals', async t => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const reading = deferred(); let signal, pulls = 0, cancels = 0;
  const h = await makeHarness({ ledgerPath, providerOverrides: { streamIdleMs: 10 }, fetchImpl: async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ pull() { pulls++; reading.resolve(); }, cancel() { cancels++; } }, { highWaterMark: 0 }),
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const run = h.start({ stream: true }); await reading.promise; t.mock.timers.tick(11);
    const response = await run.done; assertFinancialHead(response);
    assert.equal(signal.aborted, true); assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(h.upstreamCalls(), 1);
    assert.equal((await status(ledgerPath, policy)).heldNano, 350n);
  } finally { t.mock.timers.reset(); await h.close(); }
}));

test('partial stream read failure ends with a safe error frame and uncertain full hold', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); let pulls = 0;
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { if (pulls++ === 0) controller.enqueue(sseFor().subarray(0, 80)); else controller.error(new Error(TEST_KEY)); },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const response = await h.send({ stream: true }); const text = await response.text();
    assert.match(text, /event: error/); assert.equal(text.includes(TEST_KEY), false);
    assert.equal(h.upstreamCalls(), 1); assert.equal(rows(ledgerPath)[0].state, 'UNCERTAIN');
    assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]);
  } finally { await h.close(); }
}));

test('malformed JSON is terminal without echoing raw body or retrying', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath);
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => new Response(`malformed ${TEST_KEY}`) });
  try {
    const response = await h.send(); assertFinancialHead(response); assert.equal((await response.text()).includes(TEST_KEY), false);
    assert.equal(h.upstreamCalls(), 1); assert.equal(rows(ledgerPath)[0].state, 'UNCERTAIN');
    assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]);
  } finally { await h.close(); }
}));

test('header digest binds fetch-normalized values, not a pre-normalized draft', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); let digest;
  const h = await makeHarness({ ledgerPath, providerOverrides: { headers: { 'user-agent': '  synthetic-agent  ' } },
    fetchImpl: async (url, init) => {
      const effective = new Headers(init.headers);
      digest = prepareSpendAttempt({ policy, providerID: PROVIDER_ID, url, body: init.body,
        headers: effective, credentialFingerprint: FINGERPRINT, now: NOW }).requestDigest;
      return new Response(JSON.stringify(messageFor()));
    } });
  try { assert.equal((await h.send()).status, 200); assert.equal(rows(ledgerPath)[0].request_digest, digest); }
  finally { await h.close(); }
}));

test('fast alias and explicit empty beta are not silently downgraded or stripped', async () => {
  for (const fast of [true, false]) await withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath); const before = await status(ledgerPath, policy);
    const h = await makeHarness({ ledgerPath, ...(fast ? { brokerTargetOverrides: { model: { providerID: PROVIDER_ID, id: `${MODEL}-fast` } } } : {}) });
    try {
      await refusal(h, 'unsupported_request', {}, fast ? {} : { headers: { 'anthropic-beta': '' } });
      assert.equal(h.upstreamCalls(), 0); assert.deepEqual(await status(ledgerPath, policy), before);
    } finally { await h.close(); }
  });
});

test('child missing lazy SQLite import fails paid admission but ordinary gateway still loads and serves', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const before = await status(ledgerPath, policy);
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    let imports = 0;
    const hook = registerHooks({ resolve(name, context, next) {
      if (name === 'node:sqlite') { imports++; throw new Error('synthetic missing SQLite'); }
      return next(name, context);
    } });
    const { makeHarness } = await import('./gateway/tests/helpers/spend-gateway-fixture.mjs');
    assert.equal(imports, 0);
    for (const paid of [false, true, false]) {
      const h = await makeHarness({ ledgerPath: process.argv[1], attested: paid, includePolicy: paid });
      try {
        const before = imports; const response = await h.send();
        assert.equal(response.status, paid ? 402 : 200); assert.equal(response.headers.get('x-should-retry'), paid ? 'false' : null);
        assert.equal(h.upstreamCalls(), paid ? 0 : 1);
        if (paid) { assert.equal((await response.json()).error.code, 'unsupported_runtime'); assert.equal(imports, before + 1); }
        else assert.equal(imports, before);
      } finally { await h.close(); }
    }
    hook.deregister();
    process.stdout.write(JSON.stringify({ passed: true, imports }));
  `;
  const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script, ledgerPath],
    { cwd: '/home/dev/opencode-broker', stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const exited = once(child, 'close');
  try {
    const [code] = await bounded(exited, 'runtime child'); assert.equal(code, 0, stderr);
    // Harness logLine captures the paid diagnostic; nothing is written to stdout for any build.
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { passed: true, imports: 1 });
    assert.deepEqual(await status(ledgerPath, policy), before);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await bounded(exited, 'runtime child reap'); }
}));

function gatewayWorker(mode, ledgerPath) {
  const child = fork('gateway/tests/helpers/spend-worker.mjs', [mode, ledgerPath, ATTEMPT_A],
    { cwd: '/home/dev/opencode-broker', execArgv: ['--experimental-test-module-mocks'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = [], waiters = new Set(); let stderr = '', ended = false;
  child.stderr.on('data', part => { stderr += part; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true; for (const waiter of waiters) waiter.reject(new Error(`gateway worker exited ${code}/${signal}: ${stderr}`)); resolve({ code, signal });
  }));
  child.on('error', error => { for (const waiter of waiters) waiter.reject(error); });
  child.on('message', message => {
    const waiter = [...waiters].find(w => w.type === message.type);
    if (waiter) { waiters.delete(waiter); waiter.resolve(message); } else messages.push(message);
  });
  return {
    send: message => new Promise((resolve, reject) => child.send(message, error => error ? reject(error) : resolve())),
    async wait(type) {
      const index = messages.findIndex(m => m.type === type); if (index >= 0) return messages.splice(index, 1)[0];
      if (ended) throw new Error(`gateway worker ended: ${stderr}`);
      let waiter;
      try { return await bounded(new Promise((resolve, reject) => { waiter = { type, resolve, reject }; waiters.add(waiter); }), `worker ${type}`); }
      finally { waiters.delete(waiter); }
    },
    async stop() { if (!ended) child.kill('SIGKILL'); return bounded(exit, 'gateway child reap'); },
  };
}
for (const mode of ['gateway-before-send', 'gateway-after-send']) test(`${mode}: SIGKILL retains committed hold and UUID never replays`, async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const worker = gatewayWorker(mode, ledgerPath);
  try {
    await worker.send({ type: 'policy', raw: rawPolicy(ledgerPath) }); await worker.wait('ready'); await worker.send({ type: 'go' });
    const barrier = await worker.wait(mode === 'gateway-before-send' ? 'committed' : 'entered');
    assert.equal(barrier.actualSends, mode === 'gateway-before-send' ? 0 : 1);
    const before = await status(ledgerPath, policy); assert.deepEqual(balances(before), [350n, 0n, 350n, 0n]);
    const attemptID = rows(ledgerPath)[0].attempt_id; assert.equal(rows(ledgerPath)[0].state, 'DISPATCH_COMMITTED');
    assert.equal((await worker.stop()).signal, 'SIGKILL'); assert.deepEqual(await status(ledgerPath, policy), before);
    await assert.rejects(reserveAttempt({ ledgerPath, policy, prepared: preparedFor(policy), attemptID, now: NOW }), { code: 'invalid_ledger' });
    const h = await makeHarness({ ledgerPath });
    try { await refusal(h, 'insufficient_funds'); assert.equal(h.upstreamCalls(), 0); assert.deepEqual(await status(ledgerPath, policy), before); }
    finally { await h.close(); }
  } finally { await worker.stop(); }
}));

for (const field of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
  test(`JSON missing ${field} cannot refund`, async () => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath, policyFor(ledgerPath, refundOverrides)); const message = messageFor(); delete message.usage[field];
    const h = await makeHarness({ ledgerPath, policyOverrides: refundOverrides, fetchImpl: async () => new Response(JSON.stringify(message)) });
    try {
      assert.equal((await h.send()).status, 200);
      assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]); assert.equal(rows(ledgerPath)[0].state, 'UNCERTAIN');
    } finally { await h.close(); }
  }));
}

test('valid JSON exactly at cap is accepted; one byte beyond cap is terminal and uncertain', async () => {
  for (const size of [1048576, 1048577]) await withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath);
    const message = messageFor({ content: [{ type: 'text', text: '' }] });
    message.content[0].text = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(message)));
    const bytes = Buffer.from(JSON.stringify(message)); assert.equal(bytes.byteLength, size); let signal, cancels = 0;
    const h = await makeHarness({ ledgerPath, fetchImpl: async (_url, init) => {
      signal = init.signal; return streamResponse(chunksOf(bytes, 65536), { contentType: 'application/json', onCancel: () => cancels++ });
    } });
    try {
      const response = await h.send(); if (size === 1048576) assert.equal(response.status, 200); else assertFinancialHead(response);
      if (size === 1048576) assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      else { assert.equal(signal.aborted, true); assert.equal(cancels, 1); }
      assert.deepEqual(balances(await status(ledgerPath, policy)), size === 1048576 ? [350n, 0n, 0n, 350n] : [350n, 0n, 350n, 0n]);
    } finally { await h.close(); }
  });
});

test('paid JSON cancellation with a pending read retains full hold without retry', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const reading = deferred(); let signal, pulls = 0, cancels = 0;
  const h = await makeHarness({ ledgerPath, fetchImpl: async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ pull() { pulls++; reading.resolve(); }, cancel() { cancels++; } }, { highWaterMark: 0 }));
  } });
  let run;
  try {
    run = h.start(); await bounded(reading.promise, 'JSON pending read'); run.response.disconnect();
    await bounded(run.done, 'JSON cancelled handler'); assert.equal(signal.aborted, true); assert.equal(cancels, 1); assert.equal(pulls, 1);
    assert.equal(h.upstreamCalls(), 1); assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]);
  } finally { run?.response.disconnect(); await h.close(); }
}));

test('cancel rejection retains the JSON limit primary failure with no receipt hunt', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); let cancels = 0, pulls = 0;
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => streamResponse([new Uint8Array(1048577)],
    { contentType: 'application/json', onPull: () => pulls++, onCancel: () => { cancels++; throw new Error(TEST_KEY); } }) });
  try {
    const response = await h.send(); assertFinancialHead(response); assert.equal((await response.text()).includes(TEST_KEY), false);
    assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(rows(ledgerPath)[0].uncertain_reason, 'json_limit');
    assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]);
  } finally { await h.close(); }
}));

test('failed uncertainty persistence is an explicit local financial failure, not capacity fallback', async t => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const prepare = DatabaseSync.prototype.prepare;
  const mocked = t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (sql.startsWith("UPDATE attempts SET state='UNCERTAIN'")) throw Object.assign(new Error('synthetic disk failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    return prepare.call(this, sql);
  });
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => { throw new Error(TEST_KEY); } });
  try {
    await refusal(h, 'invalid_ledger'); assert.equal(h.upstreamCalls(), 1);
    assert.equal(h.brokerCalls.some(c => c.path === '/complete' || c.path === '/usage'), false);
    assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]); assert.equal(rows(ledgerPath)[0].state, 'DISPATCH_COMMITTED');
    assert.ok(h.logs.some(log => log.error === 'spend budget refused: invalid_ledger'));
  } finally { mocked.mock.restore(); await h.close(); }
}));

test('post-COMMIT config and key changes cannot rewrite immutable prepared wire', async t => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const real = await import('../lib/spend-budget.js'); let h;
  const mocked = t.mock.module('../lib/spend-budget.js', { exports: { ...real, reserveAttempt: async args => {
    const result = await real.reserveAttempt(args);
    h.provider.baseUrl = 'https://elsewhere.invalid/v1'; h.provider.headers = { 'anthropic-beta': 'fast' };
    h.provider.spendBudget.policyID = 'changed-after-commit'; await writeFile(h.keyFile, 'synthetic-replacement');
    return result;
  } } });
  try {
    const { createGatewayHandler: handlerFactory } = await import('../lib/gateway.js?immutable-wire');
    h = await makeHarness({ ledgerPath, handlerFactory, fetchImpl: async (url, init) => {
      assert.equal(url, `${ORIGIN}/v1/messages`); assert.equal(new Headers(init.headers).get('x-api-key'), TEST_KEY);
      assert.equal(new Headers(init.headers).has('anthropic-beta'), false);
      return new Response(JSON.stringify(messageFor()));
    } });
    assert.equal((await h.send()).status, 200); assert.equal(h.upstreamCalls(), 1);
    assert.equal((await status(ledgerPath, policy)).spentNano, 350n);
  } finally { if (h) await h.close(); mocked.restore(); }
}));

test('SSE overrun freezes before a later handler request can send', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath, policyFor(ledgerPath), '0.000000700');
  const bytes = Buffer.from(Buffer.from(sseFor()).toString().replace('"output_tokens":5', '"output_tokens":100'));
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => streamResponse(chunksOf(bytes, 1)) });
  try {
    const response = await h.send({ stream: true }); assert.match(await response.text(), /"code":"frozen"/);
    const before = await status(ledgerPath, policy); assert.equal(before.frozen, true); assert.equal(before.additionalLiabilityNano, 167n);
    await refusal(h, 'frozen'); assert.equal(h.upstreamCalls(), 1); assert.deepEqual(await status(ledgerPath, policy), before);
  } finally { await h.close(); }
}));

// Real-shaped standard/global usage metadata (Important finding 1).
const metadataUpstream = (mode, usage = {}) => async () => mode === 'sse'
  ? streamResponse(chunksOf(metadataSSEFor({ deltaUsage: usage }), 5))
  : new Response(JSON.stringify(metadataMessageFor(usage)), { headers: { 'content-type': 'application/json' } });
for (const mode of ['json', 'sse']) for (const refund of [false, true]) {
  test(`neutral metadata ${mode} ${refund ? 'confirmed refund 308' : 'default burn 350'} with observed 42`, async () => withLedgerDir(async ledgerPath => {
    const overrides = refund ? refundOverrides : {};
    const policy = await fund(ledgerPath, policyFor(ledgerPath, overrides));
    const h = await makeHarness({ ledgerPath, policyOverrides: overrides, fetchImpl: metadataUpstream(mode) });
    try {
      const response = await h.send({ stream: mode === 'sse' }); assert.equal(response.status, 200);
      if (mode === 'sse') assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(metadataSSEFor()));
      const s = await status(ledgerPath, policy);
      assert.deepEqual(balances(s), refund ? [350n, 308n, 0n, 42n] : [350n, 0n, 0n, 350n]);
      assert.equal(s.observedCostNano, 42n); assert.equal(s.attemptCounts.SETTLED, 1);
      // Canonical stored evidence keeps the four counters only; metadata is not persisted.
      assert.deepEqual(Object.keys(JSON.parse(rows(ledgerPath)[0].receipt_json).usage).sort(),
        ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens']);
    } finally { await h.close(); }
  }));
}
for (const mode of ['json', 'sse']) {
  for (const [label, usage] of [['output', { output_tokens: 100 }], ['input', { input_tokens: 101 }]]) {
    test(`neutral metadata ${mode} ${label} excess still freezes the next call`, async () => withLedgerDir(async ledgerPath => {
      const policy = await fund(ledgerPath, policyFor(ledgerPath), '0.000000700');
      const h = await makeHarness({ ledgerPath, fetchImpl: metadataUpstream(mode, usage) });
      try {
        const response = await h.send({ stream: mode === 'sse' });
        if (mode === 'json') { assertFinancialHead(response); assert.equal((await response.json()).error.code, 'frozen'); }
        else assert.match(await response.text(), /"code":"frozen"/);
        const before = await status(ledgerPath, policy); assert.equal(before.frozen, true);
        assert.equal(rows(ledgerPath, 'SELECT * FROM violations').length, 1);
        await refusal(h, 'frozen'); assert.equal(h.upstreamCalls(), 1); assert.deepEqual(await status(ledgerPath, policy), before);
      } finally { await h.close(); }
    }));
  }
  for (const [name, usage] of NON_NEUTRAL_USAGE) test(`non-neutral ${name} ${mode} receipt is uncertain and cannot refund`, async () => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath, policyFor(ledgerPath, refundOverrides));
    const h = await makeHarness({ ledgerPath, policyOverrides: refundOverrides, fetchImpl: metadataUpstream(mode, usage) });
    try {
      assert.equal((await h.send({ stream: mode === 'sse' })).status, 200);
      const s = await status(ledgerPath, policy);
      assert.deepEqual(balances(s), [350n, 0n, 350n, 0n]); assert.equal(s.attemptCounts.UNCERTAIN, 1);
      assert.equal(s.observedCostNano, 0n); assert.equal(rows(ledgerPath)[0].receipt_hash, null); assert.equal(h.upstreamCalls(), 1);
    } finally { await h.close(); }
  }));
}
test('neutral metadata with missing or null counters cannot refund', async () => {
  for (const field of ['input_tokens', 'output_tokens']) for (const value of [undefined, null]) await withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath, policyFor(ledgerPath, refundOverrides));
    const message = metadataMessageFor({ [field]: value }); if (value === undefined) delete message.usage[field];
    const h = await makeHarness({ ledgerPath, policyOverrides: refundOverrides, fetchImpl: async () => new Response(JSON.stringify(message)) });
    try {
      assert.equal((await h.send()).status, 200);
      assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]); assert.equal(rows(ledgerPath)[0].state, 'UNCERTAIN');
    } finally { await h.close(); }
  });
});

// Important finding 2: default client retry predicates, emulated from their
// published sources (NOT an installed-SDK integration run):
//  - Vercel AI SDK APICallError.isRetryable: 408, 409, 429 or >= 500; maxRetries 2.
//  - Anthropic TS SDK shouldRetry: x-should-retry 'true'/'false' first, then
//    408, 409, 429 or >= 500; maxRetries 2.
const CLIENT_PREDICATES = {
  'ai-sdk': (status) => status === 408 || status === 409 || status === 429 || status >= 500,
  'anthropic-sdk': (status, headers) => {
    const header = headers.get('x-should-retry');
    if (header === 'true') return true;
    if (header === 'false') return false;
    return status === 408 || status === 409 || status === 429 || status >= 500;
  },
};
async function withWire(h, fn) {
  const server = createServer((req, res) => { h.handler(req, res).catch(() => {}); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const post = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, { method: 'POST',
      headers: { authorization: `Bearer ${FRONTDOOR_KEY}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  try { return await fn(post); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const wireCases = [
  ['pre-dispatch missing ledger', 'missing_ledger', 0, { funded: false }],
  ['post-dispatch JSON overflow', 'unsupported_request', 1, { fetchImpl: async () => streamResponse([new Uint8Array(1048577).fill(32)], { contentType: 'application/json' }) }],
  ['post-dispatch malformed JSON', 'unsupported_request', 1, { fetchImpl: async () => new Response('malformed') }],
  ['post-dispatch settlement storage error', 'invalid_ledger', 1, { storageFault: true }],
  // A paid upstream 5xx or transport failure: a 502 here would be re-sent by the AI SDK loop.
  ['post-dispatch upstream HTTP 503', 'paid_upstream_failed', 1, { detail: 'upstream HTTP 503',
    fetchImpl: async () => new Response('synthetic unavailable', { status: 503 }) }],
  ['post-dispatch transport failure', 'paid_upstream_failed', 1, { detail: 'transport',
    fetchImpl: async () => { throw new TypeError('synthetic socket reset'); } }],
];
for (const [name, code, sends, options] of wireCases) for (const client of Object.keys(CLIENT_PREDICATES)) {
  test(`real NodeHTTP ${name}: 402 native envelope, x-should-retry false, ${client} default loop sends once`, async t => withLedgerDir(async ledgerPath => {
    const policy = options.funded === false ? null : await fund(ledgerPath, policyFor(ledgerPath), '0.000001050');
    if (options.storageFault) {
      const prepare = DatabaseSync.prototype.prepare;
      t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
        if (sql.startsWith("UPDATE attempts SET state='SETTLED'")) throw Object.assign(new Error('synthetic I/O'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
        return prepare.call(this, sql);
      });
    }
    const h = await makeHarness({ ledgerPath, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    try {
      const responses = await withWire(h, async post => {
        const seen = [];
        for (let attempt = 0; attempt <= 2; attempt++) {
          const response = await post(); seen.push(response);
          if (!CLIENT_PREDICATES[client](response.status, response.headers)) break;
        }
        return seen;
      });
      assert.equal(responses.length, 1, 'the client must not retry a terminal financial refusal');
      const [response] = responses;
      assert.equal(response.status, 402);
      assert.equal(response.headers.get('x-should-retry'), 'false');
      assert.match(response.headers.get('content-type'), /^application\/json/);
      assert.deepEqual(response.body, { type: 'error', error: { type: 'spend_budget_refusal', code,
        message: `spend budget refused: ${code}${options.detail ? ` (${options.detail})` : ''}`, retryable: false } });
      assert.equal(h.upstreamCalls(), sends);
      if (policy) {
        t.mock.restoreAll();
        assert.equal(rows(ledgerPath).length, 1);
        assert.deepEqual(balances(await status(ledgerPath, policy)), [1050n, 700n, 350n, 0n]);
      }
    } finally { t.mock.restoreAll(); await h.close(); }
  }));
}

// Important finding 3: a deterministic paid 4xx must not take the inherited
// second attempt. The harness model is profile-mapped, so excludeLane is a
// no-op and the broker would hand back the same paid lane. The client gets the
// terminal 402 paid_upstream_failed naming only the upstream status.
const errorBody = status => JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `synthetic ${status}` } });
for (const upstreamStatus of [400, 401, 402, 403, 404, 405, 413, 415, 422]) {
  test(`deterministic paid HTTP ${upstreamStatus} is terminal: one fetch, full hold, funds for a second send intact`, async () => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath, policyFor(ledgerPath), '0.000000700');
    const h = await makeHarness({ ledgerPath, fetchImpl: async () => new Response(errorBody(upstreamStatus), { status: upstreamStatus, headers: { 'content-type': 'application/json' } }) });
    try {
      const response = await h.send();
      // deepEqual of the whole envelope also proves the upstream body is never echoed.
      await assertPaidUpstreamFailed(response, `upstream HTTP ${upstreamStatus}`);
      assert.equal(h.upstreamCalls(), 1);
      assert.equal(h.brokerCalls.filter(c => c.path === '/lease').length, 1, 'no second lease or fallback');
      assert.equal(h.brokerCalls.filter(c => c.path === '/failure').length, 1, 'existing upstream failure report retained once');
      const attempts = rows(ledgerPath); assert.equal(attempts.length, 1); assert.equal(attempts[0].state, 'UNCERTAIN');
      assert.deepEqual(balances(await status(ledgerPath, policy)), [700n, 350n, 350n, 0n]);
    } finally { await h.close(); }
  }));
}
// Retryable upstream statuses are not retried by the gateway either: the client sees the
// same terminal 402, and one fully held attempt, funded for more or not.
for (const upstreamStatus of [408, 409, 429, 503]) {
  test(`retryable paid HTTP ${upstreamStatus} is terminal when funded for a second send: one fetch, 402 paid_upstream_failed`, async () => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath, policyFor(ledgerPath), '0.000000700');
    const h = await makeHarness({ ledgerPath, fetchImpl: async () => new Response(errorBody(upstreamStatus), { status: upstreamStatus, headers: { 'content-type': 'application/json' } }) });
    try {
      const response = await h.send(); await assertPaidUpstreamFailed(response, `upstream HTTP ${upstreamStatus}`);
      assert.equal(h.upstreamCalls(), 1);
      assert.equal(h.brokerCalls.filter(c => c.path === '/lease').length, 1, 'no second lease');
      const attempts = rows(ledgerPath); assert.equal(attempts.length, 1); assert.equal(attempts[0].state, 'UNCERTAIN');
      assert.deepEqual(balances(await status(ledgerPath, policy)), [700n, 350n, 350n, 0n]);
    } finally { await h.close(); }
  }));
  test(`retryable paid HTTP ${upstreamStatus} without retry funds is the same terminal 402`, async () => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath);
    const h = await makeHarness({ ledgerPath, fetchImpl: async () => new Response(errorBody(upstreamStatus), { status: upstreamStatus }) });
    try {
      const response = await h.send(); await assertPaidUpstreamFailed(response, `upstream HTTP ${upstreamStatus}`);
      assert.equal(h.upstreamCalls(), 1);
      assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]);
    } finally { await h.close(); }
  }));
}

test('duplicate incoming version cannot disappear in Node header normalization', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const before = await status(ledgerPath, policy); const h = await makeHarness({ ledgerPath });
  try {
    await refusal(h, 'unsupported_request', {}, { rawHeaders: ['anthropic-version', '2023-06-01', 'Anthropic-Version', '2023-06-01'] });
    assert.equal(h.upstreamCalls(), 0); assert.deepEqual(await status(ledgerPath, policy), before);
  } finally { await h.close(); }
}));
