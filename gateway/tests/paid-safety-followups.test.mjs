// Paid-lane safety follow-ups (financial and merge review findings):
//   G1 -- content-filter buffering never applies to a paid (spend-policy) request, so a paid
//         stream keeps the stall watchdog and the idle timer can never fire on a null controller.
//   G2 -- after any paid dispatch that fails (any upstream status, or transport), the client
//         gets the terminal 402 paid_upstream_failed, and no second paid attempt is made.
//   G4 -- a settle that hits a locked ledger is retried once; if it is still locked the hold is
//         marked UNCERTAIN (never left DISPATCH_COMMITTED) and a delivered answer is not
//         turned into a 402.
// All data is synthetic; ledgers live in private 0700 mkdtemp directories (withLedgerDir).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeHarness } from './helpers/spend-gateway-fixture.mjs';
import { withLedgerDir, policyFor, allocationFor, messageFor, sseFor, chunksOf, NOW } from './helpers/spend-fixture.mjs';
import { initializeLedger, fundLedger, inspectStatus } from '../lib/spend-budget.js';

const status = (ledgerPath, policy) => inspectStatus({ ledgerPath, policy, now: NOW });
const balances = s => [s.fundedNano, s.availableNano, s.heldNano, s.spentNano];
async function fund(ledgerPath, amount = '0.000000350') {
  const policy = policyFor(ledgerPath);
  await initializeLedger({ ledgerPath, policy, now: NOW });
  await fundLedger({ ledgerPath, policy, now: NOW, allocation: allocationFor(amount) });
  return policy;
}
function rows(ledgerPath) {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try { return db.prepare('SELECT * FROM attempts').all(); } finally { db.close(); }
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const BOUND_HEADERS = { 'x-opencode-session-id': 'session-fixture', 'x-opencode-lease-id': 'synthetic-lease' };
const errorBody = code => JSON.stringify({ type: 'error', error: { type: 'api_error', message: `synthetic ${code}` } });

// ---------------------------------------------------------------- G1

test('G1 paid streaming on a bufferStreamingForContentFilter lane streams upstream and settles once', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const sent = [];
  const h = await makeHarness({ ledgerPath, providerOverrides: { bufferStreamingForContentFilter: true },
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      let index = 0; const parts = chunksOf(sseFor(), 7);
      return new Response(new ReadableStream({ pull(controller) { if (index < parts.length) controller.enqueue(parts[index++]); else controller.close(); } },
        { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    } });
  try {
    const response = await h.send({ stream: true });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(sseFor()));
    assert.equal(h.upstreamCalls(), 1);
    assert.equal(sent[0].stream, true, 'a paid stream must go upstream as a stream, not content-filter buffered');
    const s = await status(ledgerPath, policy);
    assert.equal(s.attemptCounts.SETTLED, 1); assert.equal(s.attemptCounts.UNCERTAIN, 0);
    assert.deepEqual(balances(s), [350n, 0n, 0n, 350n]);
  } finally { await h.close(); }
}));

test('G1 paid stream stalling past streamIdleMs on a bufferStreamingForContentFilter lane aborts cleanly', async t => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath); const secondPull = deferred(); let signal, pulls = 0, cancels = 0;
  const h = await makeHarness({ ledgerPath, providerOverrides: { bufferStreamingForContentFilter: true, streamIdleMs: 10 },
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({
        // First pull delivers a frame (which arms the idle timer); the second never answers.
        pull(controller) { pulls++; if (pulls === 1) controller.enqueue(sseFor().subarray(0, 40)); else secondPull.resolve(); },
        cancel() { cancels++; },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const run = h.start({ stream: true }); await secondPull.promise;
    t.mock.timers.tick(11);
    const response = await run.done; const text = await response.text();
    assert.equal(signal.aborted, true); assert.equal(cancels, 1); assert.equal(h.upstreamCalls(), 1);
    assert.match(text, /event: error/); assert.match(text, /spend_budget_refusal/);
    const s = await status(ledgerPath, policy);
    assert.equal(s.attemptCounts.UNCERTAIN, 1); assert.equal(s.heldNano, 350n);
  } finally { t.mock.timers.reset(); await h.close(); }
}));

// ---------------------------------------------------------------- G2

// After ANY failed paid dispatch the client gets ONE terminal shape: 402, x-should-retry false,
// spend_budget_refusal / paid_upstream_failed, naming only the upstream status or "transport".
// The Vercel AI SDK retries every status >= 500 whatever x-should-retry says, so a 502 here could
// buy two more paid sends. deepEqual also proves no upstream body text is echoed.
async function assertPaidUpstreamFailed(response, detail) {
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.deepEqual(await response.json(), { type: 'error', error: { type: 'spend_budget_refusal', code: 'paid_upstream_failed',
    message: `spend budget refused: paid_upstream_failed (${detail})`, retryable: false } });
}

for (const upstreamStatus of [503, 429]) {
  test(`G2 gateway-originated paid HTTP ${upstreamStatus}: one paid fetch, client sees terminal 402 paid_upstream_failed`, async () => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath, '0.000000700');
    const h = await makeHarness({ ledgerPath, fetchImpl: async () => new Response(errorBody(upstreamStatus), { status: upstreamStatus, headers: { 'content-type': 'application/json' } }) });
    try {
      const response = await h.send();
      await assertPaidUpstreamFailed(response, `upstream HTTP ${upstreamStatus}`);
      assert.equal(h.upstreamCalls(), 1, 'no second paid attempt after a retryable paid status');
      assert.equal(h.brokerCalls.filter(c => c.path === '/lease').length, 1);
      const attempts = rows(ledgerPath); assert.equal(attempts.length, 1); assert.equal(attempts[0].state, 'UNCERTAIN');
      assert.deepEqual(balances(await status(ledgerPath, policy)), [700n, 350n, 350n, 0n]);
    } finally { await h.close(); }
  }));
  test(`G2 session-bound paid HTTP ${upstreamStatus}: one paid fetch, client sees terminal 402 paid_upstream_failed`, async () => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath, '0.000000700');
    const h = await makeHarness({ ledgerPath, fetchImpl: async () => new Response(errorBody(upstreamStatus), { status: upstreamStatus, headers: { 'content-type': 'application/json' } }) });
    try {
      const response = await h.send({}, { headers: BOUND_HEADERS });
      await assertPaidUpstreamFailed(response, `upstream HTTP ${upstreamStatus}`);
      assert.equal(h.upstreamCalls(), 1);
      assert.ok(h.brokerCalls.some(c => c.path === '/lease/verify'));
      assert.equal(h.brokerCalls.some(c => c.path === '/lease'), false);
      assert.equal(rows(ledgerPath)[0].state, 'UNCERTAIN');
      assert.deepEqual(balances(await status(ledgerPath, policy)), [700n, 350n, 350n, 0n]);
    } finally { await h.close(); }
  }));
}

test('G2 paid HTTP 400 becomes the same terminal 402 paid_upstream_failed after one fetch', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath, '0.000000700');
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => new Response(errorBody(400), { status: 400, headers: { 'content-type': 'application/json' } }) });
  try {
    const response = await h.send();
    await assertPaidUpstreamFailed(response, 'upstream HTTP 400');
    assert.equal(h.upstreamCalls(), 1);
    assert.equal(rows(ledgerPath)[0].state, 'UNCERTAIN');
    assert.deepEqual(balances(await status(ledgerPath, policy)), [700n, 350n, 350n, 0n]);
  } finally { await h.close(); }
}));

test('G2 paid transport failure after dispatch: one paid fetch, no second lease, terminal 402 naming transport', async () => withLedgerDir(async ledgerPath => {
  const policy = await fund(ledgerPath, '0.000000700');
  const h = await makeHarness({ ledgerPath, fetchImpl: async () => { throw new TypeError('synthetic socket reset after send'); } });
  try {
    const response = await h.send();
    await assertPaidUpstreamFailed(response, 'transport');
    assert.equal(h.upstreamCalls(), 1, 'a transport failure after a paid send may have been billed: no second paid attempt');
    assert.equal(h.brokerCalls.filter(c => c.path === '/lease').length, 1);
    const attempts = rows(ledgerPath); assert.equal(attempts.length, 1); assert.equal(attempts[0].state, 'UNCERTAIN');
    assert.deepEqual(balances(await status(ledgerPath, policy)), [700n, 350n, 350n, 0n]);
  } finally { await h.close(); }
}));

// ---------------------------------------------------------------- G4
// Seam: settleAttempt is wrapped through the module mock (the same seam the existing
// "handler awaits financial settlement" test uses). A real competing SQLite lock cannot be
// timed deterministically here: busy_timeout waits synchronously on the event loop, so the
// test could not release the lock between the first and the retried settle.

const lockedError = () => Object.assign(new Error('ledger lock timeout'), { code: 'locked' });
async function lockedHarness(t, ledgerPath, failures, label, options = {}) {
  const real = await import('../lib/spend-budget.js');
  const calls = { settle: 0 };
  const mock = t.mock.module('../lib/spend-budget.js', { exports: { ...real, settleAttempt: async args => {
    calls.settle++;
    if (calls.settle <= failures) throw lockedError();
    return real.settleAttempt(args);
  } } });
  const { createGatewayHandler: handlerFactory } = await import(`../lib/gateway.js?g4-${label}`);
  const h = await makeHarness({ ledgerPath, handlerFactory, ...options });
  return { h, calls, mock };
}

for (const mode of ['json', 'sse']) {
  test(`G4 ${mode} settle locked once is retried and settles`, async t => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath);
    const { h, calls, mock } = await lockedHarness(t, ledgerPath, 1, `once-${mode}`, mode === 'sse'
      ? { fetchImpl: async () => new Response(sseFor(), { headers: { 'content-type': 'text/event-stream' } }) } : {});
    try {
      const response = await h.send({ stream: mode === 'sse' });
      assert.equal(response.status, 200);
      const body = Buffer.from(await response.arrayBuffer());
      if (mode === 'sse') assert.deepEqual(body, Buffer.from(sseFor()));
      else assert.deepEqual(JSON.parse(body), messageFor());
      assert.equal(calls.settle, 2);
      const s = await status(ledgerPath, policy);
      assert.equal(s.attemptCounts.SETTLED, 1); assert.deepEqual(balances(s), [350n, 0n, 0n, 350n]);
    } finally { await h.close(); mock.restore(); }
  }));
  test(`G4 ${mode} settle still locked marks the hold uncertain and delivers the answer`, async t => withLedgerDir(async ledgerPath => {
    const policy = await fund(ledgerPath);
    const { h, calls, mock } = await lockedHarness(t, ledgerPath, Infinity, `persist-${mode}`, mode === 'sse'
      ? { fetchImpl: async () => new Response(sseFor(), { headers: { 'content-type': 'text/event-stream' } }) } : {});
    try {
      const response = await h.send({ stream: mode === 'sse' });
      assert.equal(response.status, 200);
      const body = Buffer.from(await response.arrayBuffer());
      if (mode === 'sse') assert.deepEqual(body, Buffer.from(sseFor()), 'a delivered stream gets no trailing refusal frame');
      else assert.deepEqual(JSON.parse(body), messageFor());
      assert.equal(calls.settle, 2, 'exactly one settle retry');
      const [row] = rows(ledgerPath);
      assert.equal(row.state, 'UNCERTAIN'); assert.equal(row.uncertain_reason, 'settle_locked');
      assert.deepEqual(balances(await status(ledgerPath, policy)), [350n, 0n, 350n, 0n]);
      assert.equal(h.upstreamCalls(), 1);
      assert.equal(h.brokerCalls.some(c => c.path === '/failure'), false);
    } finally { await h.close(); mock.restore(); }
  }));
}
