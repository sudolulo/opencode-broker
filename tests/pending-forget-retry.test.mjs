import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPendingForgetRetry } from "../lib/pending-forget-retry.js";
import { createAsyncPendingForgetStore, createPendingForgetStore } from "../lib/pending-forgets.js";
import { listPendingForgetRecordsAsync } from "../lib/routing.js";

const record = (sessionID, leaseID, completed = false, recordID = `${sessionID}-${leaseID}-${completed}`) =>
  ({ sessionID, leaseID, completed, recordID, updatedAt: 1 });

test("routing exposes an asynchronous pending-forget iterator", () => {
  assert.equal(typeof listPendingForgetRecordsAsync, "function");
  assert.equal(typeof listPendingForgetRecordsAsync()[Symbol.asyncIterator], "function");
});

test("async discovery yields through unknown entries without touching them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pending-forget-async-"));
  try {
    const validSessionID = (value) => /^[A-Za-z0-9_-]+$/.test(value);
    const writer = createPendingForgetStore({ directory, validSessionID });
    const handle = writer.publish("known", { leaseID: "L1" });
    for (let index = 0; index < 65; index++) writeFileSync(join(directory, `unknown-${index}`), "preserve");
    mkdirSync(join(directory, "foreign-subtree"));
    let yields = 0;
    const store = createAsyncPendingForgetStore({ directory, validSessionID, schedule: (done) => { yields += 1; done(); } });
    const records = [];
    for await (const item of store.records()) records.push(item);
    assert.deepEqual(records.map((item) => item.recordID), [handle.recordID]);
    assert.ok(yields >= 1, "one scan yields after no more than 64 entries");
    assert.equal(existsSync(join(directory, "unknown-0")), true);
    assert.equal(existsSync(join(directory, "foreign-subtree")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("async migration claims moved legacy bytes and exact removal leaves replacements alone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pending-forget-legacy-"));
  try {
    const validSessionID = (value) => /^[A-Za-z0-9_-]+$/.test(value);
    writeFileSync(join(directory, "legacy.json"), JSON.stringify({ leaseID: "L1", completed: true, updatedAt: 1 }));
    const store = createAsyncPendingForgetStore({ directory, validSessionID });
    const records = [];
    for await (const item of store.records({ now: 2 })) records.push(item);
    assert.equal(records.length, 1);
    assert.match(records[0].recordID, /^claim\./);
    assert.equal(await store.remove("legacy", records[0]), true);
    assert.equal(existsSync(join(directory, "legacy.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retry groups one async scan, completes before false, and limits distinct groups to four", async () => {
  const started = [], removed = [];
  let concurrent = 0, peak = 0;
  const retry = createPendingForgetRetry({
    records: async function* () {
      for (const item of [record("a", "1", false), record("a", "1", true), record("b", "2"), record("c", "3"), record("d", "4"), record("e", "5")]) yield item;
    },
    forget: async (item) => {
      started.push(`${item.sessionID}:${item.leaseID}:${item.completed}`);
      concurrent += 1; peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent -= 1;
    },
    remove: async (_sessionID, item) => { removed.push(item.recordID); return true; },
    setTimer: () => ({ unref() {} }), clearTimer: () => {}, schedule: () => {}, warn: () => {},
  });
  await retry.kick();
  assert.equal(peak, 4);
  assert.deepEqual(started.slice(0, 2), ["a:1:true", "b:2:false"]);
  assert.deepEqual(new Set(removed), new Set(["a-1-true", "a-1-false", "b-2-false", "c-3-false", "d-4-false", "e-5-false"]));
});

test("completion failure defers its false record while an old failing group does not starve later groups", async () => {
  const calls = [];
  const retry = createPendingForgetRetry({
    records: async function* () { yield record("old", "1"); yield record("blocked", "2", true); yield record("blocked", "2"); yield record("later", "3"); },
    forget: async (item) => { calls.push(`${item.sessionID}:${item.completed}`); if (item.sessionID !== "later") throw Error("down"); },
    remove: async () => {}, setTimer: () => ({ unref() {} }), clearTimer: () => {}, schedule: () => {}, warn: () => {},
  });
  await retry.kick();
  assert.deepEqual(calls, ["old:false", "blocked:true", "later:false"]);
});

test("an exact removal refusal remains durable work and schedules retry", async () => {
  const delays = [];
  const retry = createPendingForgetRetry({
    records: async function* () { yield record("owned", "L1"); },
    forget: async () => {}, remove: async () => false,
    setTimer: (_fn, delay) => { delays.push(delay); return { unref() {} }; },
    clearTimer: () => {}, warn: () => {},
  });
  await retry.kick();
  assert.deepEqual(delays, [5000]);
  assert.equal(retry.state().failures, 1);
});

test("busy external kicks respect failure backoff, and a timer scan finding empty stops", async () => {
  const delays = [], scheduled = [], timers = [];
  let records = [record("a", "1"), record("b", "2"), record("c", "3")];
  const retry = createPendingForgetRetry({
    records: async function* () { for (const item of records) yield item; },
    forget: async () => { throw Error("down"); }, remove: async () => {},
    setTimer: (fn, delay) => { delays.push(delay); timers.push(fn); return { unref() { scheduled.push("unref"); } }; }, clearTimer: () => {},
    schedule: setImmediate, warn: () => {}, batchSize: 1,
  });
  await retry.kick();
  for (let i = 0; i < 100; i++) await retry.kick();
  assert.deepEqual(delays, [5000], "chat kicks must not cancel backoff or spend retry budget");
  assert.deepEqual(scheduled, ["unref"]);
  records = [];
  await timers[0]();
  assert.equal(retry.state().timer, false);
});

test("one external sweep plus eight unattended retries cap at 300 seconds, then an external kick revives the budget", async () => {
  const timers = [], delays = [];
  let attempts = 0, unrefs = 0;
  const retry = createPendingForgetRetry({
    records: async function* () { yield record("a", "1"); }, forget: async () => { attempts++; throw Error("down"); }, remove: async () => false,
    setTimer: (fn, delay) => { delays.push(delay); const timer = { fn, unref() { unrefs++; } }; timers.push(timer); return timer; }, clearTimer: () => {}, warn: () => {},
  });
  await retry.kick();
  for (let index = 0; index < 8; index += 1) {
    assert.ok(timers[index], `unattended retry ${index + 1} must be armed`);
    const completion = timers[index].fn();
    assert.equal(typeof completion?.then, "function", "timer callbacks return their handled sweep promise");
    await completion;
    await new Promise(setImmediate);
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]);
  assert.deepEqual(retry.state(), { timer: false, failures: 7, unattended: 8 });
  assert.equal(attempts, 9);
  assert.equal(unrefs, 8);
  await new Promise(setImmediate);
  assert.equal(attempts, 9, "dormancy must not create spontaneous attempts");
  await retry.kick();
  assert.equal(retry.state().unattended, 0);
  assert.equal(attempts, 10);
  assert.equal(delays.length, 9);
  assert.equal(delays[8], 300000, "external kicks replenish budget without resetting failure backoff");
});

test("four huge duplicate groups cannot monopolize workers or the sixteen-attempt yield budget", async () => {
  const calls = [], active = new Set(), perTurn = [];
  let scans = 0, peak = 0, sinceYield = 0;
  const retry = createPendingForgetRetry({
    records: async function* () {
      scans++;
      for (let group = 0; group < 24; group++) {
        for (let i = 0; i < (group < 4 ? 100 : 1); i++) yield record(`g${group}`, "lease", false, `${group}-${i}`);
      }
    },
    forget: async (item) => {
      assert.equal(active.has(item.sessionID), false, "the same lease must never overlap");
      active.add(item.sessionID); peak = Math.max(peak, active.size);
      calls.push(item.sessionID); sinceYield++;
      await new Promise(setImmediate);
      active.delete(item.sessionID);
    },
    remove: async () => true,
    schedule: (done) => { perTurn.push(sinceYield); sinceYield = 0; setImmediate(done); },
  });
  await retry.kick();
  perTurn.push(sinceYield);
  assert.equal(scans, 1, "one complete scan, not repeated discovery per batch");
  assert.equal(calls.length, 420);
  assert.ok(calls.indexOf("g4") <= 4, "a fifth group must advance after one quantum of the first four");
  assert.ok(calls.indexOf("g23") < 32, "groups beyond the first sixteen must advance before duplicates drain");
  assert.equal(peak, 4);
  assert.ok(perTurn.every((attempts) => attempts <= 16), `attempts between yields: ${perTurn}`);
});

for (const fault of ["forget", "remove"]) {
  test(`all completion records precede false; a ${fault} failure blocks only its exact lease`, async () => {
    const calls = [], removed = [];
    const retry = createPendingForgetRetry({
      records: async function* () {
        yield record("same", "blocked", false);
        yield record("same", "blocked", true, "completion-1");
        yield record("same", "blocked", true, "completion-2");
        yield record("same", "other", false);
        yield record("good", "lease", false);
        yield record("good", "lease", true, "good-1");
        yield record("good", "lease", true, "good-2");
      },
      forget: async (item) => { calls.push(item.recordID); if (fault === "forget" && item.recordID === "completion-1") throw Error("down"); },
      remove: async (_session, item) => { removed.push(item.recordID); return !(fault === "remove" && item.recordID === "completion-1"); },
      setTimer: () => ({ unref() {} }),
    });
    await retry.kick();
    assert.ok(calls.includes("completion-2"), "a failure must not skip remaining completion records");
    assert.equal(calls.includes("same-blocked-false"), false);
    assert.ok(calls.includes("same-other-false"));
    assert.ok(calls.indexOf("good-lease-false") > calls.indexOf("good-2"));
    assert.ok(calls.indexOf("good-lease-false") > calls.indexOf("good-1"));
    assert.ok(removed.includes("good-lease-false"));
  });
}

test("kicks preserve the active cursor and coalesce to at most one immediate follow-up", async () => {
  let scans = 0;
  const attempts = [], timers = [];
  const retry = createPendingForgetRetry({
    records: async function* () {
      const scan = ++scans;
      for (let i = 0; i < 20; i++) yield record(`g${i}`, `scan${scan}`);
    },
    forget: async (item) => {
      attempts.push(item.recordID);
      // Bound the test's stimulus; the broken do/while still makes four full scans.
      if (scans < 4) for (let i = 0; i < 10; i++) void retry.kick();
    },
    remove: async () => true,
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; },
  });
  await retry.kick();
  assert.equal(scans, 2, "a stream of chat kicks must not extend the active promise without bound");
  assert.equal(attempts.length, 40);
  assert.equal(new Set(attempts).size, 40, "kicks must not reset the cursor");
  assert.equal(timers.length, 1, "work requested during the follow-up is deferred, not lost");
  assert.equal(timers[0].delay, 5000);
});

test("kicks during a failing active sweep do not create an immediate retry", async () => {
  let scans = 0;
  const delays = [];
  const retry = createPendingForgetRetry({
    records: async function* () { scans++; yield record("same", "lease"); },
    forget: async () => { if (scans < 4) void retry.kick(); throw Error("down"); },
    remove: async () => true,
    setTimer: (_fn, delay) => { delays.push(delay); return { unref() {} }; },
  });
  await retry.kick();
  assert.equal(scans, 1, "failure backoff applies even when kicks arrive mid-sweep");
  assert.deepEqual(delays, [5000]);
});

test("a scan error after yielding a false record dispatches no partial group", async () => {
  const calls = [];
  const retry = createPendingForgetRetry({
    records: async function* () { yield record("same", "lease"); throw Error("unsafe completion"); },
    forget: async (item) => calls.push(item), remove: async () => true,
    setTimer: () => ({ unref() {} }),
  });
  await retry.kick();
  assert.deepEqual(calls, []);
  assert.equal(retry.state().timer, true);
});

test("a stalled group cannot impose a sixteen-group barrier on free workers", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; }), calls = [];
  const retry = createPendingForgetRetry({
    records: async function* () { for (let index = 0; index < 24; index++) yield record(`s${index}`, "L"); },
    forget: async (item) => { calls.push(item.sessionID); if (item.sessionID === "s0") await held; },
    remove: async () => true,
  });
  const running = retry.kick();
  for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);
  const progressed = calls.includes("s23");
  release(); await running;
  assert.equal(progressed, true, "free workers pass group sixteen while s0 is held");
});

test("timer discovery errors are handled and sanitized without dispatching partial results", async () => {
  const timers = [], warnings = [], calls = [];
  const retry = createPendingForgetRetry({
    records: async function* () { yield record("a", "L"); throw Error("private/path/lease"); },
    forget: async (item) => calls.push(item), remove: async () => true,
    setTimer: (fn) => { const timer = { fn, unref() {} }; timers.push(timer); return timer; },
    warn: (message) => warnings.push(message),
  });
  await retry.kick();
  const completion = timers[0].fn();
  assert.equal(typeof completion?.then, "function");
  await completion;
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((message) => !message.includes("private")));
});

test("the sixteen-attempt yield budget also spans an immediate follow-up sweep", async () => {
  let scans = 0, attempts = 0, sinceYield = 0, peak = 0;
  const retry = createPendingForgetRetry({
    records: async function* () { scans++; for (let index = 0; index < 10; index++) yield record(`s${index}`, "L"); },
    forget: async () => { attempts++; peak = Math.max(peak, ++sinceYield); if (scans === 1) void retry.kick(); },
    remove: async () => true,
    schedule: (resolve) => { sinceYield = 0; setImmediate(resolve); },
  });
  await retry.kick();
  assert.equal(scans, 2); assert.equal(attempts, 20);
  assert.ok(peak <= 16, `attempts across immediate sweeps without yielding: ${peak}`);
});

test("a kick during promise finalization is either scanned or deferred, never lost", async () => {
  for (let phase = 0; phase < 16; phase++) {
    let published = false, observed = false;
    const timers = [];
    const retry = createPendingForgetRetry({
      records: async function* () { if (published) observed = true; },
      forget: async () => {}, remove: async () => true,
      setTimer: (fn) => { const timer = { fn, unref() {} }; timers.push(timer); return timer; },
    });
    const first = retry.kick();
    const activity = (async () => {
      for (let tick = 0; tick < phase; tick++) await Promise.resolve();
      published = true;
      await retry.kick();
    })();
    await Promise.all([first, activity]);
    assert.ok(observed || timers.length === 1, `kick at microtask phase ${phase} was lost`);
    if (!observed) { await timers[0].fn(); assert.equal(observed, true); }
  }
});
