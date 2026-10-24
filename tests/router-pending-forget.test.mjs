import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, mock } from "node:test";

const priorHome = process.env.HOME;
const home = mkdtempSync(join(tmpdir(), "router-forget-f3-"));
process.env.HOME = home;
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
after(() => {
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});
const routing = await import("../lib/routing.js");
const turn = () => new Promise(setImmediate);
const drain = async () => { for (let i = 0; i < 10; i++) await turn(); };
let sequence = 0;

const harness = async (run) => {
  const publications = new Map(), timers = [], calls = [], logs = [], escaped = [];
  let scans = 0, manual = false, deleted = false, fail = false, hold = null;
  const routingMock = mock.module("../lib/routing.js", { namedExports: {
    ...routing,
    publishCachedSubscriptionInventory: async () => ({ changed: false }),
    resolveProfile: () => ({ profile: manual ? "manual" : "auto", explicit: manual }),
    listPendingForgetRecords: () => { throw Error("synchronous scan forbidden"); },
    listPendingForgetRecordsAsync: async function* () {
      scans++;
      // Snapshot at iterator entry, as a scan that precedes publication may do.
      for (const item of [...publications.values()]) yield item;
    },
    publishPendingForgetRecord: (sessionID, options) => {
      const item = { sessionID, ...options, completed: options.completed === true, updatedAt: Date.now(), recordID: `record-${sequence++}` };
      publications.set(item.recordID, item); return item;
    },
    removePendingForgetRecord: (_session, item) => publications.delete(item.recordID),
    removePendingForgetRecordAsync: async (_session, item) => publications.delete(item.recordID),
  } });
  const trap = mock.method(http, "request", () => { escaped.push(true); throw Error("live network forbidden"); });
  try {
    const { ModelRouter } = await import(`../plugin/router.js?pending-f3=${sequence++}`);
    const hooks = await ModelRouter({ directory: home, client: {
      app: { log: async (entry) => logs.push(entry) },
      session: {
        get: async ({ path }) => deleted
          ? { response: { status: 404 }, error: { name: "NotFoundError", data: { message: `Session not found: ${path.id}` } } }
          : { id: path.id, agent: "standard" },
        messages: async () => ({ data: [] }),
      },
    } }, {
      brokerRequest: async (path, body, options) => {
        calls.push({ path, body, options, at: Date.now() });
        if (path === "/forget") {
          if (hold) await hold;
          if (fail) throw Error("offline");
        }
        return path === "/lease" ? { leaseID: "lease", target: { kind: "cloud", model: { providerID: "openai", id: "gpt-5.6-luna" } } } : {};
      },
      setTimeout: (fn, delay) => { const timer = { fn, delay, unrefs: 0, cleared: false, unref() { this.unrefs++; } }; timers.push(timer); return timer; },
      clearTimeout: (timer) => { timer.cleared = true; },
    });
    await drain();
    const chat = () => hooks["chat.message"]({ sessionID: "session", agent: "standard" }, { message: {}, parts: [] });
    await run({ hooks, chat, publications, timers, calls, logs, scans: () => scans,
      setManual: () => { manual = true; }, setDeleted: () => { deleted = true; },
      setFail: (value) => { fail = value; }, setHold: (value) => { hold = value; } });
    await drain();
    assert.deepEqual(escaped, []);
  } finally { trap.mock.restore(); routingMock.restore(); }
};

test("router retry uses injected timers, preserves failure backoff on chat, and gives forget an absolute deadline", async () => harness(async (h) => {
  h.publications.set("existing", { sessionID: "session", leaseID: "existing", completed: true, recordID: "existing", updatedAt: Date.now() });
  h.setFail(true);
  await h.chat(); await drain();
  const forget = h.calls.find((call) => call.path === "/forget");
  assert.ok(forget);
  assert.ok(forget.options?.deadline >= forget.at + 4990 && forget.options.deadline <= forget.at + 5000,
    "forget must carry a five-second absolute deadline, not just an inactivity timeout");
  const timer = h.timers.find((timer) => timer.delay === 5000);
  assert.ok(timer, "retry must use ModelRouter's injected scheduler");
  assert.equal(timer.unrefs, 1);
  await h.chat(); await drain();
  assert.equal(h.calls.filter((call) => call.path === "/forget").length, 1, "chat cannot bypass failure backoff");
  h.setFail(false);
  await timer.fn(); await drain();
  assert.equal(h.publications.size, 0);
  assert.equal(timer.cleared, true, "the controller retires its timer through the injected clearer");
}));

for (const mode of ["manual", "deleted"]) {
  test(`${mode} publication does not kick retry ahead of its direct RPC; failure kicks exactly once`, async () => harness(async (h) => {
    await h.chat(); await drain();
    let release;
    h.setHold(new Promise((resolve) => { release = resolve; }));
    h.setFail(true);
    const before = h.scans();
    let operation;
    if (mode === "manual") { h.setManual(); operation = h.chat(); }
    else { h.setDeleted(); operation = h.hooks.event({ event: { type: "session.deleted", properties: { info: { id: "session" } } } }); }
    await drain();
    const calls = h.calls.filter((call) => call.path === "/forget");
    // Release the fake RPC before asserting, so a RED run cannot leak pending work.
    const countWhileHeld = calls.length, scansWhileHeld = h.scans();
    h.setHold(null); release(); await operation; await drain();
    assert.equal(countWhileHeld, 1, "publication must not cause a retry concurrent with its direct request");
    assert.equal(scansWhileHeld - before, mode === "manual" ? 1 : 0, "only the existing chat kick may scan before direct failure");
    assert.equal(h.calls.filter((call) => call.path === "/forget").length, 2);
    // F3 bounds the controller's retry RPC. The original direct cleanup keeps its
    // existing client transport; changing that path is not part of this correction.
    const retry = h.calls.filter((call) => call.path === "/forget")[1];
    assert.ok(retry.options?.deadline >= retry.at + 4990 && retry.options.deadline <= retry.at + 5000);
    assert.equal(h.publications.size, 1, "the original failed intent remains, with no re-publication");
  }));
}
