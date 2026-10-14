import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutages } from '../lib/model-outage-state.js';
import { createOutageWorker } from '../lib/model-outage-worker.js';
import { emptyOutages, nextProbe, outageGrants, reduceOutages, reserveProbe } from '../lib/model-outages.js';
import { CI_A, makePolicy, makeBaseline, makeFailure, makeSnapshot } from './helpers/model-outages.mjs';

const policy = makePolicy();

function ready() {
  let state = emptyOutages();
  for (const event of [makeBaseline(), makeFailure(), makeSnapshot()]) {
    state = reduceOutages(state, event, { policy, now: event.finishedAt ?? event.receivedAt });
  }
  return state;
}

function fixture({ enabled = true, failCommit = false, serialize } = {}) {
  let state = ready();
  let clock = 3_000;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const polls = [];
  const commits = [];
  const controllers = [];
  const timerAPI = {
    setInterval(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms, interval: false }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const opts = {
    policy: enabled ? policy : { ...policy, enabled: false }, now: () => clock, read: () => state,
    commit: async (next) => {
      commits.push(structuredClone(next));
      if (typeof failCommit === 'function' ? failCommit(next) : failCommit) throw new Error('disk full');
      state = structuredClone(next);
    },
    fetchStatus: async (providerID, { signal }) => {
      polls.push({ providerID, at: clock, signal });
      controllers.push(signal);
      return makeSnapshot({ providerID, receivedAt: clock, matches: {} });
    },
    runProbe: async (reservation, { signal }) => {
      calls.push({ reservation, durable: structuredClone(state), signal });
      controllers.push(signal);
      return null;
    },
    canProbe: () => true, timers: timerAPI, randomBytes: (size) => Buffer.alloc(size, 8), serialize,
  };
  return { opts, calls, polls, commits, timers, controllers, get state() { return state; }, set state(value) { state = value; }, advance(ms) { clock += ms; } };
}

test('failed durable reservation means zero probe dispatch', async () => {
  const f = fixture({ failCommit: true });
  const worker = createOutageWorker(f.opts);
  try {
    await assert.rejects(worker.tick(), /disk full/);
    assert.equal(f.calls.length, 0);
  } finally { await worker.close(); }
});

test('observe mode commits authenticated evidence without scheduling polls, probes, or timers', async () => {
  // Removing the active-mode fence would make this dispatch a reserve probe and alter traffic.
  const f = fixture();
  f.opts.policy = { ...policy, mode: 'observe' };
  const worker = createOutageWorker(f.opts);
  try {
    worker.start();
    await worker.tick();
    worker.requestPoll('anthropic');
    await worker.drain();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.polls, []);
    assert.equal(f.timers.size, 0);
    await worker.observe(makeBaseline({ finishedAt: 3_000, startedAt: 2_900 }));
    assert.equal(f.commits.length, 1);
    assert.equal(f.state.scopes['anthropic/opus/standard'].instances[CI_A].baselineAt, 3_000);
  } finally { await worker.close(); }
});

test('switching active history to observe retains counts and occupancy without grants', () => {
  // This catches a mode transition resetting spent probe capacity or silently authorizing it.
  const state = ready();
  const active = reserveProbe(state, {
    logicalID: 'anthropic/opus/standard', targetID: 'claude-opus-5', kind: 'reserve', id: 'reservation', nonce: 'n'.repeat(43), now: 3_000,
  }, { policy });
  assert.ok(active);
  const observing = { ...policy, mode: 'observe' };
  const retained = reduceOutages(active.state, { type: 'tick' }, { policy: observing, now: 3_001 });
  assert.equal(retained.providers.anthropic.inflight.id, 'reservation');
  assert.equal(retained.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 1);
  assert.deepEqual(outageGrants(retained, observing, 3_001), []);
  assert.equal(nextProbe(retained, observing, 3_001), null);
});

test('probe dispatch sees the durable reservation before network I/O', async () => {
  const f = fixture();
  const worker = createOutageWorker(f.opts);
  try {
    await worker.tick();
    await worker.drain();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].durable.providers.anthropic.inflight.id, f.calls[0].reservation.id);
    assert.equal(f.calls[0].durable.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 1);
  } finally { await worker.close(); }
});

test('background failures report only their error name and reject drain by default', async () => {
  const f = fixture();
  const writes = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  const worker = createOutageWorker({ ...f.opts, runProbe: async () => { throw new Error('provider token must not be reported'); } });
  try {
    await worker.tick();
    await assert.rejects(worker.drain(), /provider token must not be reported/);
    assert.deepEqual(writes, ['outage worker error: Error\n']);
  } finally {
    process.stderr.write = write;
    await worker.close();
  }
});

test('default reporter bounds hostile error names without coercing or logging payloads', async () => {
  const names = ['Error\nforged\u001b[31m', 'Error\n', 'Error\r', 'X'.repeat(65), '', null, 42, { toString() { throw new Error('must not coerce'); } }];
  const writes = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    for (const name of names) {
      const f = fixture();
      const error = { name, message: 'private message', output: 'private output' };
      const worker = createOutageWorker({ ...f.opts, runProbe: async () => { throw error; } });
      try {
        await worker.tick();
        await assert.rejects(worker.drain(), (caught) => caught === error);
      } finally { await worker.close(); }
    }
    assert.deepEqual(writes, names.map(() => 'outage worker error: unknown\n'));
  } finally { process.stderr.write = write; }
});

for (const first of [undefined, null, 0, false, '']) {
  test(`drain retains a first ${String(first)} rejection while reporting later errors`, async () => {
    const f = fixture();
    const later = new Error('later failure');
    const errors = [];
    const worker = createOutageWorker({
      ...f.opts,
      fetchStatus: async (providerID) => { throw providerID === 'anthropic' ? first : later; },
      onError: (error) => {
        errors.push(error);
        if (error === first) worker.requestPoll('openai');
      },
    });
    try {
      worker.requestPoll('anthropic');
      await assert.rejects(worker.drain(), (error) => error === first);
      assert.deepEqual(errors, [first, later]);
      await worker.drain();
      f.advance(60_000);
      worker.requestPoll('openai');
      await assert.rejects(worker.drain(), (error) => error === later);
      assert.deepEqual(errors, [first, later, later]);
    } finally { await worker.close(); }
  });

  test(`default reporter uses unknown for a ${String(first)} probe rejection and drain rejects`, async () => {
    const f = fixture();
    const writes = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    const worker = createOutageWorker({ ...f.opts, runProbe: async () => { throw first; } });
    try {
      await worker.tick();
      await assert.rejects(worker.drain(), (error) => error === first);
      assert.deepEqual(writes, ['outage worker error: unknown\n']);
      await worker.drain();
    } finally {
      await worker.close();
      process.stderr.write = write;
    }
  });
}

test('restart preserves spent count and cooldown after a dispatched reservation', async () => {
  const f = fixture();
  let image;
  const first = createOutageWorker({ ...f.opts, runProbe: async () => {
    image = structuredClone(f.state);
    throw new Error('crash after commit');
  }, onError: () => {} });
  try {
    await first.tick();
    await assert.rejects(first.drain(), /crash after commit/);
  } finally { await first.close(); }
  const decoded = decodeOutages(image, { policy, now: 3_000 });
  assert.equal(decoded.providers.anthropic.inflight.id, '08080808080808080808080808080808');
  assert.equal(decoded.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 1);
  f.state = decoded;
  let dispatches = 0;
  const second = createOutageWorker({ ...f.opts, runProbe: async () => { dispatches++; return null; } });
  try {
    await second.tick(); await second.drain();
    assert.equal(dispatches, 0, 'live persisted occupancy blocks immediate retry');
    f.advance(60_000);
    await second.tick(); await second.drain();
    assert.equal(dispatches, 1);
    assert.equal(f.state.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 2);
  } finally { await second.close(); }
});

test('polls both providers at most once each sixty seconds and requestPoll is nonblocking', { timeout: 1_000 }, async () => {
  const f = fixture();
  let release;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  f.opts.fetchStatus = async (providerID, { signal }) => {
    f.polls.push({ providerID, at: 3_000 });
    if (providerID === 'anthropic' && release === undefined) await new Promise((resolve) => {
      release = () => { signal.removeEventListener('abort', release); resolve(); };
      signal.addEventListener('abort', release, { once: true });
      if (signal.aborted) release();
      started();
    });
    return makeSnapshot({ providerID, receivedAt: 3_000, matches: {} });
  };
  const worker = createOutageWorker(f.opts);
  try {
    assert.equal(worker.requestPoll('anthropic'), undefined);
    worker.requestPoll('anthropic');
    await began;
    assert.equal(f.polls.filter((poll) => poll.providerID === 'anthropic').length, 1);
    release(); await worker.drain();
    await worker.tick(); await worker.drain();
    assert.equal(f.polls.filter((poll) => poll.providerID === 'anthropic').length, 1);
    assert.equal(f.polls.filter((poll) => poll.providerID === 'openai').length, 1);
    f.advance(60_000);
    await worker.tick(); await worker.drain();
    assert.equal(f.polls.length, 4);
  } finally { release?.(); await worker.close(); }
});

test('upper fence false prevents probes', async () => {
  const f = fixture();
  const worker = createOutageWorker({ ...f.opts, canProbe: () => false });
  try { await worker.tick(); await worker.drain(); assert.equal(f.calls.length, 0); } finally { await worker.close(); }
});

test('deadline abort and close drain every owned timer and controller', { timeout: 1_000 }, async () => {
  const f = fixture();
  let signal;
  const worker = createOutageWorker({ ...f.opts, runProbe: async (_reservation, options) => {
    signal = options.signal;
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
  } });
  try {
    await worker.tick(); await new Promise(setImmediate);
    const deadline = [...f.timers.values()].find((timer) => timer.ms === 10_000);
    assert.ok(deadline);
    f.advance(10_000); deadline.fn(); await worker.drain();
    assert.equal(signal.aborted, true);
    assert.equal(f.state.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 1);
  } finally { await worker.close(); assert.equal(f.timers.size, 0); }
});

test('close aborts a deferred poll and settles its owned job', { timeout: 1_000 }, async () => {
  const f = fixture();
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  let signal;
  f.opts.fetchStatus = async (_providerID, options) => {
    signal = options.signal;
    started();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(makeSnapshot()), { once: true }));
  };
  const worker = createOutageWorker(f.opts);
  worker.requestPoll('anthropic');
  await began;
  await worker.close();
  assert.equal(signal.aborted, true);
  assert.equal(f.timers.size, 0);
});

test('a healthy probe outcome does not chain another probe', { timeout: 1_000 }, async () => {
  const f = fixture();
  let tail = Promise.resolve();
  const serialize = (transaction) => {
    const result = tail.then(transaction);
    tail = result.catch(() => {});
    return result;
  };
  let allowed = false;
  let release;
  let reservation;
  let probeCalls = 0;
  f.opts.runProbe = async (reserved, { signal }) => {
    probeCalls++;
    if (probeCalls > 1) return null;
    reservation = reserved;
    return new Promise((resolve) => {
      const abort = () => release(null);
      release = (outcome) => { signal.removeEventListener('abort', abort); resolve(outcome); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  const worker = createOutageWorker({ ...f.opts, serialize, canProbe: () => allowed });
  try {
    // Finish the legitimate polls before enabling probes. Refresh positive diagnosis
    // without scheduling I/O; the second tick's polls must skip at the original clock.
    await worker.tick(); await worker.drain();
    await worker.observe(makeSnapshot({ receivedAt: 3_000 }));
    allowed = true;
    await worker.tick();
    await serialize(async () => {});
    assert.equal(f.polls.length, 2);
    assert.equal(probeCalls, 1);
    f.advance(60_000);
    release(makeBaseline({
      purpose: reservation.purpose, targetID: reservation.targetID, modelID: reservation.targetID,
      generation: reservation.generation, credentialInstance: reservation.expectedCredentialInstance,
      requestID: reservation.id, attemptID: 'healthy-probe', startedAt: reservation.startedAt, finishedAt: 63_000,
    }));
    // Wait past outcome commit, probe-finished and latch cleanup, not just commit's
    // own promise. A chained dispatch would now spend an eligible primary probe.
    await worker.drain();
    assert.equal(probeCalls, 1);
    const episode = f.state.scopes['anthropic/opus/standard'].instances[CI_A].episode;
    assert.deepEqual(episode.proofs['claude-opus-5'], { at: 63_000, active: false });
    assert.deepEqual(episode.probeCounts, { reserve: 1, primary: 0 });
    assert.equal(f.state.providers.anthropic.inflight, null);
    assert.deepEqual(nextProbe(f.state, policy, 63_000), {
      logicalID: 'anthropic/opus/standard', targetID: 'claude-opus-5-5', kind: 'primary',
    });
    assert.equal(f.polls.length, 2);
  } finally { await worker.close(); }
});

test('simultaneous tick requestPoll and close cannot resurrect worker activity', async () => {
  const f = fixture();
  const worker = createOutageWorker(f.opts);
  const tick = worker.tick();
  worker.requestPoll('anthropic');
  const close = worker.close();
  await Promise.allSettled([tick, close]);
  await worker.drain();
  assert.equal(f.commits.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.polls.length, 0);
  await worker.tick();
  worker.requestPoll('openai');
  assert.equal(f.commits.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.polls.length, 0);
});

test('close between reservation and launched probe allocates no timer or I/O', async () => {
  const f = fixture();
  let tail = Promise.resolve();
  let close;
  let armed = true;
  let allocatedTimers = 0;
  const setTimeout = f.opts.timers.setTimeout;
  f.opts.timers.setTimeout = (...args) => { allocatedTimers++; return setTimeout(...args); };
  const serialize = (transaction) => {
    const result = tail.then(transaction);
    tail = result.catch(() => {});
    if (armed) {
      armed = false;
      // Attach after dispatchDueProbe awaits result: its continuation queues the
      // launch first, then this reaction closes before the launched operation runs.
      queueMicrotask(() => { result.then(() => { close = worker.close(); }); });
    }
    return result;
  };
  const worker = createOutageWorker({ ...f.opts, serialize });
  try {
    await worker.tick();
    assert.ok(close);
    await close;
    await worker.drain();
    assert.equal(f.state.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 1);
    assert.equal(f.calls.length, 0);
    assert.equal(f.polls.length, 0);
    assert.equal(allocatedTimers, 0);
    assert.equal(f.timers.size, 0);
  } finally { await worker.close(); }
});

test('failed probe-finished commit releases dispatch latch without refunding quota or cooldown', async () => {
  let failFinished = true;
  const f = fixture({ failCommit: (next) => failFinished && next.providers?.anthropic?.inflight === null });
  const worker = createOutageWorker({ ...f.opts, onError: () => {} });
  try {
    await worker.tick();
    await assert.rejects(worker.drain(), /disk full/);
    assert.equal(f.state.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 1);
    assert.equal(f.state.providers.anthropic.lastProbeAt, 3_000);
    failFinished = false;
    f.advance(60_000);
    await worker.tick(); await worker.drain();
    assert.equal(f.calls.length, 2);
    assert.equal(f.state.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 2);
  } finally { await worker.close(); }
});

test('probe and cleanup failures are both reported while drain retains the primary failure', async () => {
  const primary = new Error('probe failed');
  const secondary = new Error('cleanup failed');
  const errors = [];
  const f = fixture();
  const commit = f.opts.commit;
  const runProbe = f.opts.runProbe;
  let fail = true;
  const worker = createOutageWorker({
    ...f.opts,
    commit: async (next) => {
      if (fail && next.providers?.anthropic?.inflight === null) throw secondary;
      await commit(next);
    },
    runProbe: async (...args) => {
      await runProbe(...args);
      if (fail) throw primary;
      return null;
    },
    onError: (error) => errors.push(error),
  });
  try {
    await worker.tick();
    await assert.rejects(worker.drain(), (error) => error === primary);
    assert.deepEqual(errors, [primary, secondary]);
    assert.equal(f.state.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 1);
    assert.equal(f.state.providers.anthropic.lastProbeAt, 3_000);
    await worker.drain(); // Only the first failure is retained, not an unbounded error queue.
    fail = false;
    f.advance(60_000);
    await worker.tick(); await worker.drain();
    assert.equal(f.calls.length, 2, 'cleanup failure did not strand the dispatch latch');
    assert.equal(f.state.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts.reserve, 2);
  } finally { await worker.close(); }
});

test('disabled and missing policy have no timers, I/O, or optional-state commits on every entry point', async () => {
  for (const disabled of [fixture({ enabled: false }), fixture()]) {
    if (disabled.opts.policy.enabled) disabled.opts.policy = undefined;
    const worker = createOutageWorker(disabled.opts);
    worker.start(); worker.requestPoll('anthropic');
    await worker.tick(); await worker.observe(makeSnapshot()); await worker.drain(); await worker.close();
    assert.equal(disabled.timers.size, 0);
    assert.equal(disabled.calls.length, 0);
    assert.equal(disabled.polls.length, 0);
    assert.equal(disabled.commits.length, 0);
  }
});

test('shared serializer recovers after a rejected mutation and never encloses network I/O', async () => {
  let rejectNextCommit = true;
  const f = fixture({ failCommit: () => {
    if (!rejectNextCommit) return false;
    rejectNextCommit = false;
    return true;
  } });
  let tail = Promise.resolve();
  let inSerializer = false;
  const entries = [];
  const serialize = (transaction) => {
    const result = tail.then(async () => { inSerializer = true; try { return await transaction(); } finally { inSerializer = false; } });
    tail = result.catch(() => {});
    return result;
  };
  f.opts.serialize = serialize;
  f.opts.fetchStatus = async (providerID) => { assert.equal(inSerializer, false); entries.push(providerID); return makeSnapshot({ providerID, receivedAt: 3_000, matches: {} }); };
  f.opts.runProbe = async () => { assert.equal(inSerializer, false); return null; };
  const worker = createOutageWorker(f.opts);
  try {
    await assert.rejects(worker.observe(makeSnapshot()), /disk full/);
    await worker.tick(); await worker.drain();
    assert.deepEqual(entries.sort(), ['anthropic', 'openai']);
  } finally { await worker.close(); }
});

test('observe validate runs inside the serialized transaction against the current image before commit', async () => {
  const f = fixture();
  const worker = createOutageWorker(f.opts);
  try {
    const event = makeBaseline({ requestID: 'v1', attemptID: 'v1-1', startedAt: 2950, finishedAt: 3000 });
    const seen = [];
    // A transaction queued earlier changes the image the validator must see.
    const earlier = worker.observe(makeSnapshot({ receivedAt: 3000 }));
    await worker.observe(event, { validate: (observed, current) => { seen.push({ observed, current: structuredClone(current) }); } });
    await earlier;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].observed, event);
    assert.equal(seen[0].current.snapshots.anthropic.receivedAt, 3000, 'validator saw the post-snapshot image');
    const commits = f.commits.length;
    const before = structuredClone(f.state);
    await assert.rejects(worker.observe(makeFailure({ requestID: 'v2', attemptID: 'v2-1', startedAt: 2960, finishedAt: 3000 }),
      { validate: () => { throw new Error('stale health outcome'); } }), /stale health outcome/);
    assert.equal(f.commits.length, commits, 'a refused validation commits nothing');
    assert.deepEqual(f.state, before);
    await assert.rejects(worker.observe(event, { validate: 'yes' }), /outage observe validate/);
    assert.equal(f.commits.length, commits);
    // Ordinary observe is unchanged.
    await worker.observe(makeSnapshot({ receivedAt: 3000 }));
    assert.equal(f.commits.length, commits + 1);
  } finally { await worker.close(); }
});

test('four reservations persist quota and role limits after accepted decode', async () => {
  let state = ready();
  for (const [index] of ['reserve', 'reserve', 'primary', 'primary'].entries()) {
    const now = 3_000 + index * 60_000;
    const f = fixture(); f.state = state; f.advance(now - 3_000);
    const worker = createOutageWorker(f.opts);
    try { await worker.tick(); await worker.drain(); state = f.state; } finally { await worker.close(); }
    state = reduceOutages(state, { type: 'probe-finished', providerID: 'anthropic', id: state.providers.anthropic.inflight?.id }, { policy, now: now + 1 });
    if (index === 1) state.scopes['anthropic/opus/standard'].instances[CI_A].episode.proofs['claude-opus-5'] = { at: now + 1, active: true };
  }
  state = reduceOutages(state, makeSnapshot({ receivedAt: 250_000 }), { policy, now: 250_000 });
  const decoded = decodeOutages(state, { policy, now: 250_000 });
  decoded.snapshots.anthropic = makeSnapshot({ receivedAt: 250_000 });
  assert.deepEqual(decoded.scopes['anthropic/opus/standard'].instances[CI_A].episode.probeCounts, { reserve: 2, primary: 2 });
  const f = fixture(); f.state = decoded; f.advance(247_000);
  const worker = createOutageWorker(f.opts);
  try { await worker.tick(); await worker.drain(); assert.equal(f.calls.length, 0); } finally { await worker.close(); }
});
