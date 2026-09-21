import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { backgroundTaskResult, barrierUnavailable, createChildManager, createChildRegistry, createIdleBarrier, nativeTaskState, retireSession, taskChildFromAfter } from "../lib/session-janitor.js";
import { SessionJanitor } from "../plugin/session-janitor.js";

// The protocol these tests pin is described at the top of lib/session-janitor.js. It is shared
// with opencode-agent-workflows, where it was first written; the cases below are the ones that
// do not involve that project's workflow engine.

// The real idle barrier needs opencode's V2 SDK over the embedded transport, which a fake
// client does not have, so every manager here gets one that resolves immediately.
const idle = async () => {};
const managed = (client, registry = memoryRegistry(), directory = "/d") =>
  createChildManager({ client, directory, waitIdle: idle, registry });
const sdkAvailable = await (async () => {
  for (const specifier of [
    pathToFileURL(join(homedir(), ".config/opencode/node_modules/@opencode-ai/sdk/dist/v2/client.js")).href,
    "@opencode-ai/sdk/v2/client",
  ]) {
    try { await import(specifier); return true; } catch {}
  }
  return false;
})();

const memoryRegistry = () => {
  const records = new Map();
  const registrations = [];
  const reservations = new Map();
  const intents = new Map();
  const intentKey = (sessionID, parentSessionID) => `${sessionID}:${parentSessionID}`;
  return {
    records, registrations, reservations, intents,
    list: () => [...records.values()],
    read: (id) => records.get(id) ?? null,
    register: (record) => {
      const saved = records.get(record.sessionID) ?? record;
      if (!records.has(record.sessionID)) registrations.push(saved);
      records.set(record.sessionID, saved);
      if (record.reservationID) reservations.delete(record.reservationID);
      return saved;
    },
    fail: (id, error) => {
      const record = records.get(id);
      if (record) records.set(id, { ...record, attempts: Math.min(8, (record.attempts ?? 0) + 1), lastError: error });
      return records.get(id);
    },
    quarantine: (id, error) => {
      const record = records.get(id);
      if (record) records.set(id, { ...record, quarantinedAt: Date.now(), lastError: error });
      return records.get(id);
    },
    remove: (id) => records.delete(id),
    reserve: (record) => {
      const reservationID = `r${reservations.size + 1}`;
      const reservation = { ...record, reservationID, marker: `[workflow-reservation:${reservationID}]`, reservationState: "reserved", ownerPID: process.pid };
      reservations.set(reservation.reservationID, reservation);
      return reservation;
    },
    bindReservation: (reservationID, sessionID) => {
      const reservation = reservations.get(reservationID);
      if (!reservation) throw new Error("managed child reservation is unavailable");
      const bound = { ...reservation, sessionID, reservationState: "bound" };
      reservations.set(reservationID, bound);
      return bound;
    },
    releaseReservation: (reservationID) => reservations.delete(reservationID),
    listReservations: () => [...reservations.values()],
    failReservation: (reservationID, error) => {
      const reservation = reservations.get(reservationID);
      if (reservation) reservations.set(reservationID, { ...reservation, attempts: (reservation.attempts ?? 0) + 1, lastError: error });
    },
    quarantineReservation: (reservationID, error) => {
      const reservation = reservations.get(reservationID);
      if (reservation) reservations.set(reservationID, { ...reservation, reservationState: "quarantined", lastError: error });
    },
    claimRetirement: (id, claimant) => {
      const record = records.get(id);
      if (!record || record.quarantinedAt || (record.retirement?.claimant !== claimant && record.retirement?.leaseUntil > Date.now())) return null;
      const claimed = { ...record, retirement: { claimant, leaseUntil: Date.now() + 180_000 } };
      records.set(id, claimed); return claimed;
    },
    removeClaimed: (id, claimant) => records.get(id)?.retirement?.claimant === claimant && records.delete(id),
    failClaimed: (id, error, claimant) => {
      const record = records.get(id);
      if (record?.retirement?.claimant === claimant) records.set(id, { ...record, retirement: undefined, attempts: (record.attempts ?? 0) + 1, lastError: error });
    },
    quarantineClaimed: (id, error, claimant) => {
      const record = records.get(id);
      if (record?.retirement?.claimant === claimant) records.set(id, { ...record, retirement: undefined, quarantinedAt: Date.now(), lastError: error });
    },
    recordIntent: (intent) => { const key = intentKey(intent.sessionID, intent.parentSessionID); const saved = intents.get(key) ?? intent; intents.set(key, saved); return saved; },
    listIntents: () => [...intents.values()],
    consumeIntent: (sessionID, parentSessionID) => intents.delete(intentKey(sessionID, parentSessionID)),
    failIntent: (intent, error) => intents.set(intentKey(intent.sessionID, intent.parentSessionID), { ...intent, attempts: (intent.attempts ?? 0) + 1, lastError: error }),
  };
};

const fakeClient = ({ replies = [], parentMessages = [], parents = {}, children } = {}) => {
  let counter = 0;
  let replyIndex = 0;
  const sessionParents = new Map(Object.entries(parents));
  const created = [];
  const deleted = [];
  const prompts = [];
  const aborted = [];
  const childrenCalls = [];
  return {
    created, deleted, prompts, aborted, childrenCalls,
    session: {
      // A retired session must read back as gone; the legacy SDK reports a
      // missing session as `{ error }` rather than throwing.
      get: async ({ path }) => (deleted.includes(path.id)
        ? { error: { status: 404 } }
        : { data: { id: path.id, parentID: sessionParents.get(path.id) } }),
      create: async ({ body }) => {
        const id = `ses_child${++counter}`;
        sessionParents.set(id, body?.parentID);
        created.push({ id, title: body?.title, parentID: body?.parentID });
        return { data: { id } };
      },
      prompt: async ({ path, body }) => {
        prompts.push({ id: path.id, agent: body.agent, text: body.parts[0].text, synthetic: body.parts[0].synthetic });
        const reply = replies[replyIndex++] ?? "ok";
        if (reply instanceof Error) throw reply;
        return { data: { parts: [{ type: "text", text: reply }] } };
      },
      messages: async () => ({ data: parentMessages }),
      children: async (request) => {
        childrenCalls.push(request);
        return { data: children ?? created.map(({ id, title, parentID }) => ({ id, title, parentID })) };
      },
      abort: async ({ path }) => { aborted.push(path.id); return { data: true }; },
      delete: async ({ path }) => { deleted.push(path.id); return { data: true }; },
    },
  };
};

// A client that records the exact order of the retirement sequence, so the
// test fails if delete ever moves ahead of the idle barrier.
const orderedClient = ({ deleteFails = false, stillPresent = false, afterDeleteStatus } = {}) => {
  const calls = [];
  let deleted = false;
  return {
    calls,
    session: {
      abort: async () => { calls.push("abort"); return { data: true }; },
      delete: async () => {
        calls.push("delete");
        if (deleteFails) throw new Error("delete exploded");
        deleted = true;
        return { data: true };
      },
      get: async ({ path }) => {
        calls.push("get");
        if (!deleted || stillPresent) return { data: { id: path.id, parentID: "ses_parent" } };
        return afterDeleteStatus ? { error: { status: afterDeleteStatus } } : { error: { status: 404 } };
      },
    },
  };
};

// The SDK a plugin is handed: `{ error, request, response }`, status on response.status,
// and an error body with no status in it. The fakes above put the status on
// `error.status`, which is why the real 404 went unrecognised while every test passed.
const sdkNotFound = (id) => ({
  error: { name: "NotFoundError", data: { message: `Session not found: ${id}` } },
  request: {},
  response: { status: 404 },
});
const deadPID = () => {
  const child = spawn(process.execPath, ["-e", ""]);
  return new Promise((resolve) => child.on("exit", () => resolve(child.pid)));
};

test("retireSession aborts, waits for idle, deletes, then verifies -- in that order", async () => {
  const client = orderedClient();
  const result = await retireSession({
    client, directory: "/d", sessionID: "ses_abc", parentSessionID: "ses_parent",
    waitIdle: async (id) => { client.calls.push(`wait:${id}`); },
  });
  assert.deepEqual(client.calls, ["get", "abort", "wait:ses_abc", "get", "delete", "get"]);
  assert.deepEqual(
    { aborted: result.aborted, idle: result.idle, deleted: result.deleted, verified: result.verified },
    { aborted: true, idle: true, deleted: true, verified: true },
  );
  assert.equal(result.error, undefined);
});

test("an unconfirmed idle barrier leaves the row alone without an append-only log", async () => {
  const client = orderedClient();
  const result = await retireSession({
    client, sessionID: "ses_wedged", parentSessionID: "ses_parent",
    waitIdle: async () => { throw new Error("loop never settled"); },
  });
  assert.deepEqual(client.calls, ["get", "abort", "get"], "never deletes what it cannot prove is idle");
  assert.equal(result.deleted, false);
  assert.match(result.error, /idle barrier: loop never settled/);
});

test("a delete that leaves the row behind is reported, not assumed clean", async () => {
  const present = await retireSession({ client: orderedClient({ stillPresent: true }), sessionID: "ses_zombie", parentSessionID: "ses_parent", waitIdle: idle });
  assert.equal(present.deleted, true);
  assert.equal(present.verified, false);
  assert.match(present.error, /still present after delete/);
  const failed = await retireSession({ client: orderedClient({ deleteFails: true }), sessionID: "ses_stuck", parentSessionID: "ses_parent", waitIdle: idle });
  assert.equal(failed.deleted, false);
  assert.match(failed.error, /delete: delete exploded/);
});

test("only an explicit 404 verifies deletion, and the server parentID controls ownership", async () => {
  const ambiguous = await retireSession({
    client: orderedClient({ afterDeleteStatus: 500 }), sessionID: "ses_ambiguous", parentSessionID: "ses_parent", waitIdle: idle,
  });
  assert.equal(ambiguous.verified, false);
  assert.match(ambiguous.error, /explicit 404/);
  const wrongParent = orderedClient();
  const unowned = await retireSession({
    client: wrongParent, sessionID: "ses_unowned", parentSessionID: "ses_other", waitIdle: idle,
  });
  assert.equal(unowned.owned, false);
  assert.deepEqual(wrongParent.calls, ["get"], "metadata must not authorize an abort or delete");
});

test("the child registry persists the durable ownership schema", () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-registry-"));
  try {
    const registry = createChildRegistry({ root });
    const record = registry.register({ sessionID: "ses_child", parentSessionID: "ses_parent", directory: "/d", source: "native-task", mode: "foreground" });
    assert.deepEqual(createChildRegistry({ root }).list(), [record]);
    assert.equal(record.version, 1);
    assert.equal(record.ownerPID, process.pid);
    assert.equal(record.attempts, 0);
    assert.equal(record.lastError, null);
    const conflict = registry.register({ ...record, parentSessionID: "ses_other" });
    assert.ok(conflict.quarantinedAt, "conflicting ownership is quarantined, never replaced");
    const reservation = registry.reserve({ parentSessionID: "ses_parent", source: "workflow", mode: "foreground" });
    registry.bindReservation(reservation.reservationID, "ses_workflow");
    const workflow = registry.register({
      sessionID: "ses_workflow", parentSessionID: "ses_parent", source: "workflow", mode: "foreground", reservationID: reservation.reservationID,
    });
    assert.equal(workflow.ownerPID, reservation.ownerPID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the registry capacity is lock-protected across processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-capacity-"));
  const moduleURL = new URL("../lib/session-janitor.js", import.meta.url).href;
  const worker = (workerID) => new Promise((resolve, reject) => {
    const code = `import { createChildRegistry } from ${JSON.stringify(moduleURL)}; const registry = createChildRegistry({ root: process.argv[1] }); for (let i = 0; i < 256; i++) registry.register({ sessionID: \`ses_w${workerID}x\${i}\`, parentSessionID: "ses_parent", source: "workflow", mode: "foreground" });`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code, root]);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`registry worker ${workerID} exited ${code}`)));
  });
  try {
    await Promise.all([0, 1, 2, 3].map(worker));
    const registry = createChildRegistry({ root });
    assert.equal(registry.list().length, 1024);
    assert.throws(() => registry.register({ sessionID: "ses_overflow", parentSessionID: "ses_parent", source: "workflow", mode: "foreground" }), /full \(1024\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transient reservation recovery failures saturate metadata without quarantine", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-uncertain-reservation-"));
  try {
    const registry = createChildRegistry({ root });
    const reservation = registry.reserve({ parentSessionID: "ses_parent", source: "workflow", mode: "foreground" });
    const reservationPath = join(root, `reservation-${reservation.reservationID}.json`);
    const persisted = JSON.parse(readFileSync(reservationPath, "utf8"));
    writeFileSync(reservationPath, JSON.stringify({ ...persisted, ownerPID: 999999999 }) + "\n");
    const client = fakeClient();
    client.session.children = async () => { throw new Error("children unavailable"); };
    const manager = createChildManager({ client, waitIdle: idle, registry });
    for (let i = 0; i < 10; i++) await manager.reconcile();
    const [recovered] = registry.listReservations();
    assert.equal(recovered.reservationState, "reserved");
    assert.equal(recovered.attempts, 8);
    assert.match(recovered.lastError, /children/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup skips a workflow child while its owner is live", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-bound-recovery-"));
  try {
    const registry = createChildRegistry({ root });
    const reservation = registry.reserve({ parentSessionID: "ses_parent", source: "workflow", mode: "foreground" });
    registry.bindReservation(reservation.reservationID, "ses_bound");
    const client = fakeClient({ parents: { ses_bound: "ses_parent" } });
    await createChildManager({ client, waitIdle: idle, registry: createChildRegistry({ root }) }).reconcile();
    assert.deepEqual(client.deleted, []);
    assert.equal(createChildRegistry({ root }).listReservations().length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup preserves a dead reservation owner and retires its workflow child", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-dead-owner-recovery-"));
  try {
    const registry = createChildRegistry({ root });
    const reservation = registry.reserve({ parentSessionID: "ses_parent", source: "workflow", mode: "foreground" });
    registry.bindReservation(reservation.reservationID, "ses_bound");
    const path = join(root, "ses_bound.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ownerPID: 999999999 }) + "\n");
    const client = fakeClient({ parents: { ses_bound: "ses_parent" } });
    await createChildManager({
      client,
      waitIdle: async () => { throw new Error("live-process barrier must not run"); },
      registry: createChildRegistry({ root }),
    }).reconcile();
    assert.deepEqual(client.deleted, ["ses_bound"]);
    assert.deepEqual(createChildRegistry({ root }).listReservations(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup uses a dead native owner as the idle barrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-dead-native-owner-"));
  try {
    const registry = createChildRegistry({ root });
    registry.register({ sessionID: "ses_deadnative", parentSessionID: "ses_parent", source: "native-task", mode: "foreground" });
    const path = join(root, "ses_deadnative.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ownerPID: 999999999 }) + "\n");
    const client = fakeClient({
      parents: { ses_deadnative: "ses_parent" },
      parentMessages: [{ parts: [{
        type: "tool", tool: "task", sessionID: "ses_parent",
        state: { status: "error", metadata: { sessionId: "ses_deadnative" } },
      }] }],
    });
    await createChildManager({
      client,
      waitIdle: async () => { throw new Error("live-process barrier must not run"); },
      registry: createChildRegistry({ root }),
    }).reconcile();
    assert.deepEqual(client.deleted, ["ses_deadnative"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup clears a dead native record whose session and parent are both gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-vanished-tree-"));
  try {
    const registry = createChildRegistry({ root });
    registry.register({ sessionID: "ses_vanished", parentSessionID: "ses_goneparent", source: "native-task", mode: "foreground" });
    const path = join(root, "ses_vanished.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ownerPID: 999999999 }) + "\n");
    const client = fakeClient();
    // The whole tree is gone: the child reads 404 and the parent cannot be listed at
    // all, so the terminal-state proof this sweep normally requires is unobtainable.
    // Before the 404 short-circuit this record failed here on every startup forever.
    client.deleted.push("ses_vanished");
    client.session.messages = async () => ({ error: { status: 404 } });
    await createChildManager({
      client,
      waitIdle: async () => { throw new Error("live-process barrier must not run"); },
      registry: createChildRegistry({ root }),
    }).reconcile();
    assert.ok(!createChildRegistry({ root }).read("ses_vanished"), "a record whose session no longer exists must not survive the sweep");
    assert.deepEqual(client.deleted, ["ses_vanished"], "an already-gone session must not be deleted again on the server");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a retirement claim permits only one shared-registry manager to call the server", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-retire-race-"));
  try {
    const registry = createChildRegistry({ root });
    registry.register({ sessionID: "ses_shared", parentSessionID: "ses_parent", source: "workflow", mode: "foreground" });
    const client = fakeClient({ parents: { ses_shared: "ses_parent" } });
    const one = createChildManager({ client, waitIdle: idle, registry: createChildRegistry({ root }) });
    const two = createChildManager({ client, waitIdle: idle, registry: createChildRegistry({ root }) });
    await Promise.all([one.retire("ses_shared"), two.retire("ses_shared")]);
    assert.deepEqual(client.aborted, ["ses_shared"]);
    assert.deepEqual(client.deleted, ["ses_shared"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stale retirement claim is recoverable by another manager", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-stale-claim-"));
  try {
    const original = createChildRegistry({ root, now: () => 0 });
    original.register({ sessionID: "ses_stale", parentSessionID: "ses_parent", source: "workflow", mode: "foreground" });
    assert.ok(original.claimRetirement("ses_stale", "dead-process"));
    const client = fakeClient({ parents: { ses_stale: "ses_parent" } });
    const recovered = createChildManager({ client, waitIdle: idle, registry: createChildRegistry({ root, now: () => 180_001 }) });
    await recovered.retire("ses_stale");
    assert.deepEqual(client.deleted, ["ses_stale"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("server ownership mismatches are quarantined and retirement is deduplicated", async () => {
  const registry = memoryRegistry();
  registry.register({ version: 1, sessionID: "ses_wrong", parentSessionID: "ses_parent", source: "native-task", mode: "foreground", createdAt: 1, updatedAt: 1, attempts: 0, lastError: null });
  const client = fakeClient({ parents: { ses_wrong: "ses_other", ses_once: "ses_parent" } });
  const manager = createChildManager({ client, directory: "/d", waitIdle: idle, registry });
  assert.equal(await manager.register({ sessionID: "ses_wrong", parentSessionID: "ses_parent", source: "native-task", mode: "foreground" }), null);
  assert.ok(registry.read("ses_wrong").quarantinedAt, "a server-parent mismatch remains recorded, not deleted");
  registry.register({ version: 1, sessionID: "ses_once", parentSessionID: "ses_parent", source: "workflow", mode: "foreground", createdAt: 1, updatedAt: 1, attempts: 0, lastError: null });
  await Promise.all([manager.retire("ses_once"), manager.retire("ses_once")]);
  assert.deepEqual(client.aborted.filter((id) => id === "ses_once"), ["ses_once"]);
  assert.deepEqual(client.deleted.filter((id) => id === "ses_once"), ["ses_once"]);
});

// The reason this test exists: `client.session.wait` does not exist on either
// SDK client, and calling it throws "session.wait is not a function". Only the
// V2 NAMESPACE has the barrier. This drives the real V2 client over a fake
// transport so a wrong path fails here instead of silently disabling cleanup.

// The reason this test exists: `client.session.wait` does not exist on either
// SDK client, and calling it throws "session.wait is not a function". Only the
// V2 NAMESPACE has the barrier. This drives the real V2 client over a fake
// transport so a wrong path fails here instead of silently disabling cleanup.
test("the idle barrier hits the V2 wait route over the host transport", { skip: !sdkAvailable && "@opencode-ai/sdk is not installed" }, async () => {
  const requested = [];
  const client = {
    session: {
      _client: {
        getConfig: () => ({
          baseUrl: "http://opencode.invalid",
          headers: { "x-test": "1" },
          fetch: async (request) => {
            requested.push(new URL(request.url).pathname);
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          },
        }),
      },
    },
  };
  const barrier = createIdleBarrier({ client, directory: "/d" });
  await barrier("ses_waitme");
  assert.deepEqual(requested, ["/api/session/ses_waitme/wait"]);
});

test("native task ownership comes only from parent task-state metadata", () => {
  const event = { type: "message.part.updated", properties: { sessionID: "ses_parent", part: {
    type: "tool", tool: "task", sessionID: "ses_parent", state: { status: "completed", metadata: { sessionId: "ses_child", background: true } },
  } } };
  assert.deepEqual(nativeTaskState(event), { sessionID: "ses_child", parentSessionID: "ses_parent", mode: "background", status: "completed" });
  assert.equal(nativeTaskState({ ...event, properties: { ...event.properties, part: { ...event.properties.part, sessionID: "ses_other" } } }), null);
  assert.deepEqual(taskChildFromAfter({ tool: "task", sessionID: "ses_parent" }, { metadata: { sessionId: "ses_child" } }), { sessionID: "ses_child", parentSessionID: "ses_parent" });
});

test("live task hooks do not await pending startup recovery", async () => {
  let releaseRecovery;
  const manager = {
    reconcile: () => new Promise((resolve) => { releaseRecovery = resolve; }),
    terminalIntent: async () => {},
    deleted: () => {},
  };
  const plugin = await SessionJanitor({ client: fakeClient(), directory: "/d" }, { manager });
  let eventDone = false;
  let afterDone = false;
  const event = plugin.event({ event: { type: "session.deleted", properties: { sessionID: "ses_deleted" } } }).then(() => { eventDone = true; });
  const after = plugin["tool.execute.after"]({}, {}).then(() => { afterDone = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventDone, true);
  assert.equal(afterDone, true);
  releaseRecovery();
  await Promise.all([event, after]);
});

test("deleted-session registry cleanup cannot throw from the event hook", async () => {
  const manager = {
    reconcile: async () => {},
    deleted: () => { throw new Error("registry lock timed out"); },
  };
  const plugin = await SessionJanitor({ client: fakeClient(), directory: "/d" }, { manager });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.doesNotReject(plugin.event({ event: { type: "session.deleted", properties: { sessionID: "ses_deleted" } } }));
  } finally {
    console.error = originalError;
  }
});

test("native task cleanup retires foreground errors and after-hook successes, background only on a terminal result", async () => {
  const registry = memoryRegistry();
  const client = fakeClient({ parents: { ses_success: "ses_parent", ses_error: "ses_parent", ses_bg: "ses_parent" } });
  const manager = createChildManager({ client, directory: "/d", waitIdle: idle, registry });
  const plugin = await SessionJanitor({ client, directory: "/d" }, { manager });
  const taskEvent = (sessionID, mode, status = "completed") => ({ event: { type: "message.part.updated", properties: { sessionID: "ses_parent", part: {
    type: "tool", tool: "task", sessionID: "ses_parent", state: { status, metadata: { sessionId: sessionID, ...(mode === "background" ? { background: true } : {}) } },
  } } } });
  await plugin.event(taskEvent("ses_success", "foreground"));
  assert.deepEqual(client.deleted, [], "completed foreground work waits for the native after hook");
  await plugin["tool.execute.after"]({ tool: "task", sessionID: "ses_parent" }, { metadata: { sessionId: "ses_success" } });
  await plugin.event(taskEvent("ses_error", "foreground", "error"));
  await plugin.event(taskEvent("ses_bg", "background"));
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_bg" } } });
  assert.deepEqual(client.deleted.sort(), ["ses_error", "ses_success"], "idle never retires native children");
  const terminal = '<task id="ses_bg" state="completed">\n<summary>Background task completed: work</summary>\n<task_result>\nok\n</task_result>\n</task>';
  assert.deepEqual(backgroundTaskResult({ type: "message.part.updated", properties: { sessionID: "ses_parent", part: { type: "text", sessionID: "ses_parent", synthetic: true, text: terminal } } }), { sessionID: "ses_bg", parentSessionID: "ses_parent" });
  await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "ses_parent", part: { type: "text", sessionID: "ses_parent", synthetic: true, text: terminal } } } });
  assert.ok(client.deleted.includes("ses_bg"));
});

test("after-hook terminal intent survives until its persisted task part registers ownership", async () => {
  const registry = memoryRegistry();
  const client = fakeClient({ parents: { ses_race: "ses_parent" } });
  const manager = createChildManager({ client, directory: "/d", waitIdle: idle, registry });
  const plugin = await SessionJanitor({ client, directory: "/d" }, { manager });
  await plugin["tool.execute.after"]({ tool: "task", sessionID: "ses_parent" }, { metadata: { sessionId: "ses_race" } });
  assert.equal(registry.intents.size, 1);
  assert.deepEqual(client.deleted, []);
  await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "ses_parent", part: {
    type: "tool", tool: "task", sessionID: "ses_parent", state: { status: "completed", metadata: { sessionId: "ses_race" } },
  } } } });
  assert.equal(registry.intents.size, 0);
  assert.deepEqual(client.deleted, ["ses_race"]);
});

test("an upstream interrupted task error registers metadata and retires its child", async () => {
  const registry = memoryRegistry();
  const client = fakeClient({ parents: { ses_interrupted: "ses_parent" } });
  const plugin = await SessionJanitor({ client, directory: "/d" }, { manager: createChildManager({ client, directory: "/d", waitIdle: idle, registry }) });
  await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "ses_parent", part: {
    type: "tool", tool: "task", sessionID: "ses_parent",
    state: { status: "error", metadata: { sessionId: "ses_interrupted", interrupted: true } },
  } } } });
  assert.deepEqual(client.deleted, ["ses_interrupted"]);
});

test("startup retires registered native children only from persisted terminal parts", async () => {
  const registry = memoryRegistry();
  for (const [sessionID, mode] of [["ses_foreground", "foreground"], ["ses_interrupted", "foreground"], ["ses_background", "background"], ["ses_running", "foreground"], ["ses_bg_pending", "background"]]) {
    registry.register({ sessionID, parentSessionID: "ses_parent", source: "native-task", mode, directory: "/d" });
  }
  const terminal = '<task id="ses_background" state="completed">\n<summary>Background task completed: work</summary>\n<task_result>\nok\n</task_result>\n</task>';
  const parentMessages = [{ parts: [
    { type: "tool", tool: "task", sessionID: "ses_parent", state: { status: "completed", metadata: { sessionId: "ses_foreground" } } },
    { type: "tool", tool: "task", sessionID: "ses_parent", state: { status: "error", metadata: { sessionId: "ses_interrupted", interrupted: true } } },
    { type: "tool", tool: "task", sessionID: "ses_parent", state: { status: "running", metadata: { sessionId: "ses_running" } } },
    { type: "tool", tool: "task", sessionID: "ses_parent", state: { status: "error", metadata: { sessionId: "ses_bg_pending", background: true } } },
    { type: "text", sessionID: "ses_parent", synthetic: true, text: terminal },
  ] }];
  const client = fakeClient({
    parents: Object.fromEntries(["ses_foreground", "ses_interrupted", "ses_background", "ses_running", "ses_bg_pending"].map((id) => [id, "ses_parent"])),
    parentMessages,
  });
  await createChildManager({ client, directory: "/d", waitIdle: idle, registry }).reconcile();
  assert.deepEqual(client.deleted.sort(), ["ses_background", "ses_foreground", "ses_interrupted"]);
  assert.ok(registry.read("ses_running"));
  assert.ok(registry.read("ses_bg_pending"));
});

// A missing endpoint and a slow child are opposite facts. `not available` says the
// server cannot answer, which tells us nothing about the child and must not strand
// it forever. `timed out` says the barrier ran and the child was STILL BUSY -- that
// is positive evidence the agent loop is live, so it must keep deferring.
test("barrierUnavailable separates a missing endpoint from a child that is still working", () => {
  assert.equal(barrierUnavailable(new Error("Session wait is not available yet")), true, "the measured stub message is a capability gap");
  assert.equal(barrierUnavailable(new Error("v2.session.wait is not a function")), true, "the older SDK shape is the same capability gap");
  assert.equal(barrierUnavailable(new Error("unknown method session.wait")), true);
  assert.equal(barrierUnavailable(new Error("request failed with 501")), true);
  assert.equal(barrierUnavailable(new Error("idle barrier timed out after 60s")), false, "a timeout proves the child was still running and must not be treated as a missing endpoint");
  assert.equal(barrierUnavailable(new Error("ECONNREFUSED")), false, "an unreachable server is not a proven capability gap");
});

// 26 real records sat pinned at MAX_ATTEMPTS and were handed back by list() on every
// sweep forever. failIntent already quarantined at the cap; child records did not.

// 26 real records sat pinned at MAX_ATTEMPTS and were handed back by list() on every
// sweep forever. failIntent already quarantined at the cap; child records did not.
test("a record that fails MAX_ATTEMPTS times is quarantined out of the active list", () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-fail-"));
  try {
    const registry = createChildRegistry({ root });
    registry.register({ version: 1, sessionID: "ses_stuck", parentSessionID: "ses_parent", source: "native-task", mode: "foreground", createdAt: 1, updatedAt: 1, attempts: 0, lastError: null });
    for (let attempt = 0; attempt < 7; attempt += 1) registry.fail("ses_stuck", "could not list persisted parent messages");
    assert.equal(registry.read("ses_stuck").quarantinedAt ?? null, null, "a record under the cap stays active so later sweeps can still recover it");
    assert.ok(registry.list().some((record) => record.sessionID === "ses_stuck"), "still returned by list() below the cap");
    registry.fail("ses_stuck", "could not list persisted parent messages");
    assert.ok(registry.read("ses_stuck").quarantinedAt, "at the cap the record is quarantined rather than retried forever");
    assert.ok(!registry.list().some((record) => record.sessionID === "ses_stuck"), "a quarantined record must leave the active sweep set");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A server-side outage (non-404 error) must not leave the child stranded — the
// manager retries briefly, then registers the record UNVERIFIED so reconcile can
// still retire it later. Without this path the old code left nothing on disk.

// A server-side outage (non-404 error) must not leave the child stranded — the
// manager retries briefly, then registers the record UNVERIFIED so reconcile can
// still retire it later. Without this path the old code left nothing on disk.
test("a native task registers unverified when the ownership read fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-unverified-reg-"));
  try {
    const registry = createChildRegistry({ root });
    const client = { session: { get: async () => ({ error: { status: 500 } }) } };
    const manager = createChildManager({ client, directory: "/tmp", waitIdle: async () => {}, registry });
    const record = await manager.register({ sessionID: "ses_testchild1", parentSessionID: "ses_testparent1", source: "native-task", mode: "foreground" });
    assert.ok(record, "register must not throw on a transient read failure");
    assert.equal(record.sessionID, "ses_testchild1");
    assert.equal(record.ownershipVerified, false);
    assert.ok(typeof record.lastError === "string" && record.lastError.length > 0, "lastError must be a non-empty string");
    const listed = registry.list();
    assert.ok(listed.some((r) => r.sessionID === "ses_testchild1"), "the unverified record must be on disk and listed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child id that does not match the session read back still fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-mismatch-id-"));
  try {
    const registry = createChildRegistry({ root });
    const client = { session: { get: async () => ({ data: { id: "ses_someotherid", parentID: "ses_testparent2" } }) } };
    const manager = createChildManager({ client, directory: "/tmp", waitIdle: async () => {}, registry });
    await assert.rejects(
      manager.register({ sessionID: "ses_testchild2", parentSessionID: "ses_testparent2", source: "native-task", mode: "foreground" }),
      /could not verify child ownership before registration/,
    );
    assert.ok(!registry.list().some((r) => r.sessionID === "ses_testchild2"), "a rejected registration must not leave a record on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The dispatch gate: a read-only agent must be sent work that declares read
// intent. Capability is read from the agent's own frontmatter file, so this
// injects an agentDir instead of depending on the machine's real
// ~/.config/opencode/agent -- otherwise the suite's result would change with
// the operator's config.

test("an explicit 404 in the SDK's own response shape proves a child is gone", async () => {
  const result = await retireSession({
    client: { session: { get: async ({ path }) => sdkNotFound(path.id) } },
    sessionID: "ses_gone", parentSessionID: "ses_parent", waitIdle: idle,
  });
  assert.equal(result.missing, true, "response.status 404 must read as missing, not as unverifiable");
});

test("a claimed retirement that keeps failing is quarantined at the cap, like fail()", () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-failclaimed-"));
  try {
    const registry = createChildRegistry({ root });
    registry.register({ sessionID: "ses_stuck", parentSessionID: "ses_parent", directory: "/d", source: "native-task", mode: "foreground" });
    for (let attempt = 0; attempt < 7; attempt += 1) {
      assert.ok(registry.claimRetirement("ses_stuck", "claimant"), "below the cap the record can still be claimed");
      registry.failClaimed("ses_stuck", "could not verify child ownership", "claimant");
    }
    assert.equal(registry.read("ses_stuck").quarantinedAt ?? null, null);
    registry.claimRetirement("ses_stuck", "claimant");
    registry.failClaimed("ses_stuck", "could not verify child ownership", "claimant");
    assert.ok(registry.read("ses_stuck").quarantinedAt, "the eighth failure quarantines");
    assert.ok(!registry.list().some((record) => record.sessionID === "ses_stuck"), "and it leaves every later sweep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup recovery touches only this instance's own directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-scope-"));
  try {
    const registry = createChildRegistry({ root });
    const ownerPID = await deadPID();
    for (const [sessionID, directory] of [["ses_mine", "/work/a"], ["ses_other", "/work/b"], ["ses_other2", "/work/c"]]) {
      registry.register({ sessionID, parentSessionID: "ses_parent", directory, source: "native-task", mode: "foreground", ownerPID });
      // register() stamps the live PID; rewrite it as a crashed owner.
      writeFileSync(join(root, `${sessionID}.json`), JSON.stringify({ ...registry.read(sessionID), ownerPID }));
    }
    const directories = [];
    const client = {
      session: {
        get: async ({ path, query }) => { directories.push(query?.directory); return sdkNotFound(path.id); },
        messages: async ({ query }) => { directories.push(query?.directory); return sdkNotFound("ses_parent"); },
      },
    };
    await managed(client, registry, "/work/a").reconcile();
    assert.deepEqual([...new Set(directories)], ["/work/a"],
      "a request carrying another directory boots a whole opencode instance for it");
    assert.equal(registry.read("ses_mine"), null, "this directory's dead child is retired");
    assert.ok(registry.read("ses_other") && registry.read("ses_other2"), "other directories wait for their own instance");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the plugin module exports nothing but the factory", async () => {
  const module = await import("../plugin/session-janitor.js");
  assert.deepEqual(Object.keys(module), ["SessionJanitor"]);
});

test("the default registry lives under the janitor's own directory, and the environment moves it", async () => {
  const root = mkdtempSync(join(tmpdir(), "janitor-env-"));
  try {
    const moduleURL = new URL("../lib/session-janitor.js", import.meta.url).href;
    const { spawnSync } = await import("node:child_process");
    const run = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { createChildRegistry } = await import(${JSON.stringify(moduleURL)});
      createChildRegistry().register({ sessionID: "ses_env", parentSessionID: "ses_parent", source: "native-task", mode: "foreground" });
    `], { env: { ...process.env, ...env }, encoding: "utf8" });
    const moved = run({ HOME: root, OPENCODE_SESSION_JANITOR_DIR: join(root, "shared") });
    assert.equal(moved.status, 0, moved.stderr);
    assert.ok(readFileSync(join(root, "shared/ses_env.json"), "utf8").includes("ses_parent"));
    const home = run({ HOME: root, OPENCODE_SESSION_JANITOR_DIR: "" });
    assert.equal(home.status, 0, home.stderr);
    assert.ok(readFileSync(join(root, ".local/share/opencode/session-janitor/children/ses_env.json"), "utf8").includes("ses_parent"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
