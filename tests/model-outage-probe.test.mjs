import assert from "node:assert/strict";
import test from "node:test";

import { runOutageProbe } from "../lib/model-probe.js";

const assignment = (overrides = {}) => ({
  leaseID: "outage-lease-1",
  sessionID: "gw-probe-session-1",
  probeNonce: "pbn-probe-1",
  preferredModel: { providerID: "openai", modelID: "assigned-model" },
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

const response = (body = null, status = 200) => ({ status, body });
const scope = (api) => ({ probe: { api } });
const chunks = (...values) => new ReadableStream({
  start(controller) {
    for (const value of values) controller.enqueue(new TextEncoder().encode(value));
    controller.close();
  },
});

test("posts exactly the assigned Messages model once and returns only the trusted outcome", async () => {
  const calls = [];
  const trusted = { type: "probe-accepted", leaseID: "outage-lease-1" };
  const result = await runOutageProbe({
    assignment: assignment(), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(chunks("model", " output"), 503); },
    waitForOutcome: async () => trusted,
  });
  assert.strictEqual(result, trusted);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gateway/v1/messages");
  // No thinking field: current models reject thinking disabled, and max_tokens 256 is the
  // total generation cap including any reasoning.
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(Object.hasOwn(sent, "thinking"), false);
  assert.deepEqual(sent, {
    model: "assigned-model", stream: true, max_tokens: 256,
    messages: [{ role: "user", content: "Reply OK." }],
  });
  assert.deepEqual(calls[0].options.headers, {
    authorization: "Bearer test-key", "content-type": "application/json", "x-opencode-probe-purpose": "outage-health",
    "x-opencode-probe-session": "gw-probe-session-1", "x-opencode-probe-nonce": "pbn-probe-1",
  });
});

test("posts the assigned Responses model without Responses token parameters", async () => {
  let call;
  await runOutageProbe({
    assignment: assignment(), scope: scope("responses"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    fetchImpl: async (url, options) => { call = { url, options }; return response(); },
    waitForOutcome: async () => null,
  });
  assert.equal(call.url, "http://gateway/v1/responses");
  assert.deepEqual(JSON.parse(call.options.body), { model: "assigned-model", stream: true, input: "Reply OK." });
});

test("registers its waiter before dispatch so an early trusted outcome is retained", async () => {
  const events = [];
  const trusted = { type: "probe-accepted" };
  const result = await runOutageProbe({
    assignment: assignment(), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    waitForOutcome: async () => { events.push("wait"); return trusted; },
    fetchImpl: async () => { events.push("fetch"); return response(chunks("ignored")); },
  });
  assert.deepEqual(events, ["wait", "fetch"]);
  assert.strictEqual(result, trusted);
});

test("drains response chunks without treating HTTP 200 as health success", async () => {
  let reads = 0;
  const body = new ReadableStream({
    pull(controller) { reads += 1; if (reads < 3) controller.enqueue(new Uint8Array([reads])); else controller.close(); },
  });
  const result = await runOutageProbe({
    assignment: assignment(), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    fetchImpl: async () => response(body), waitForOutcome: async () => null,
  });
  assert.equal(result, null);
  assert.equal(reads, 3);
});

test("propagates trusted unknown and scope-mismatch outcomes unchanged", async () => {
  for (const trusted of [{ type: "probe-unknown" }, { type: "probe-scope-mismatch", detail: "authority" }]) {
    const result = await runOutageProbe({
      assignment: assignment(), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
      fetchImpl: async () => response(), waitForOutcome: async () => trusted,
    });
    assert.strictEqual(result, trusted);
  }
});

test("rejects unsupported APIs before registering or dispatching", async () => {
  let waited = false;
  let fetched = false;
  await assert.rejects(runOutageProbe({
    assignment: assignment(), scope: scope("chat/completions"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    fetchImpl: async () => { fetched = true; return response(); }, waitForOutcome: async () => { waited = true; return null; },
  }), /unsupported.*api/i);
  assert.equal(waited, false);
  assert.equal(fetched, false);
});

test("already aborted or expired assignments do not dispatch or register a waiter", async () => {
  for (const { signal, expiresAt } of [
    { signal: AbortSignal.abort(), expiresAt: Date.now() + 60_000 },
    { signal: undefined, expiresAt: Date.now() - 1 },
  ]) {
    let calls = 0;
    const result = await runOutageProbe({
      assignment: assignment({ expiresAt }), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key", signal,
      fetchImpl: async () => { calls += 1; return response(); }, waitForOutcome: async () => { calls += 1; return null; },
    });
    assert.equal(result, null);
    assert.equal(calls, 0);
  }
});

test("network and body read errors clean up the waiter before propagating", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("network broken"); },
    async () => response(new ReadableStream({ start(controller) { controller.error(new Error("body broken")); } })),
  ]) {
    let aborted = false;
    await assert.rejects(runOutageProbe({
      assignment: assignment(), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key", fetchImpl,
      waitForOutcome: (_leaseID, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true })),
    }), /network broken|body broken/);
    assert.equal(aborted, true);
  }
});

test("does not retry or fall back after an HTTP 409", async () => {
  let posts = 0;
  const result = await runOutageProbe({
    assignment: assignment(), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    fetchImpl: async () => { posts += 1; return response(null, 409); }, waitForOutcome: async () => null,
  });
  assert.equal(result, null);
  assert.equal(posts, 1);
});

test("an injected clock alone decides assignment expiry, independent of system time", async () => {
  const epoch = 1_000_000; // a fixed fake epoch, far before the real system clock
  for (const [expiresAt, dispatched] of [[epoch + 5_000, true], [epoch, false], [epoch - 1, false]]) {
    let calls = 0;
    const result = await runOutageProbe({
      assignment: assignment({ expiresAt }), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
      now: () => epoch,
      fetchImpl: async () => { calls += 1; return response(); }, waitForOutcome: async () => { calls += 1; return null; },
    });
    assert.equal(result, null);
    assert.equal(calls, dispatched ? 2 : 0, `expiresAt ${expiresAt}`);
  }
});

test("the injected clock bounds the deadline by remaining assignment lifetime", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const epoch = 1_000_000;
  let fetchAborted = false;
  const probe = runOutageProbe({
    assignment: assignment({ expiresAt: epoch + 40 }), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    now: () => epoch,
    fetchImpl: (_url, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => {
      fetchAborted = true;
      resolve(response());
    }, { once: true })),
    waitForOutcome: (_leaseID, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true })),
  });
  await Promise.resolve();
  context.mock.timers.tick(39);
  assert.equal(fetchAborted, false);
  context.mock.timers.tick(1);
  assert.equal(await probe, null);
  assert.equal(fetchAborted, true);
});

test("the clock is read exactly once at admission", async () => {
  let reads = 0;
  await runOutageProbe({
    assignment: assignment({ expiresAt: 1_000_000 + 5_000 }), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    now: () => { reads += 1; return 1_000_000; },
    fetchImpl: async () => response(), waitForOutcome: async () => null,
  });
  assert.equal(reads, 1);
});

test("absolute deadline aborts a hung fetch and unregisters its waiter", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchAborted = false;
  let waiterAborted = false;
  const probe = runOutageProbe({
    assignment: assignment(), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    fetchImpl: (_url, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => {
      fetchAborted = true;
      resolve(response());
    }, { once: true })),
    waitForOutcome: (_leaseID, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => {
      waiterAborted = true;
      resolve(null);
    }, { once: true })),
  });
  await Promise.resolve();
  context.mock.timers.tick(10_000);
  assert.equal(await probe, null);
  assert.equal(fetchAborted, true);
  assert.equal(waiterAborted, true);
});

test("assignment expiry aborts a hung fetch before the absolute deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchAborted = false;
  let waiterAborted = false;
  const probe = runOutageProbe({
    assignment: assignment({ expiresAt: Date.now() + 25 }), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
    fetchImpl: (_url, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => {
      fetchAborted = true;
      resolve(response());
    }, { once: true })),
    waitForOutcome: (_leaseID, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => {
      waiterAborted = true;
      resolve(null);
    }, { once: true })),
  });
  await Promise.resolve();
  context.mock.timers.tick(25);
  assert.equal(await probe, null);
  assert.equal(fetchAborted, true);
  assert.equal(waiterAborted, true);
});

test("parent abort after dispatch aborts a hung body read and releases its reader", async () => {
  const parent = new AbortController();
  let readStarted;
  const body = new ReadableStream({
    pull() { readStarted(); },
  });
  let waiterAborted = false;
  const probe = runOutageProbe({
    assignment: assignment(), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key", signal: parent.signal,
    fetchImpl: async () => response(body),
    waitForOutcome: (_leaseID, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => {
      waiterAborted = true;
      resolve(null);
    }, { once: true })),
  });
  await new Promise((resolve) => { readStarted = resolve; });
  parent.abort();
  assert.equal(await probe, null);
  assert.equal(waiterAborted, true);
  assert.equal(body.locked, false);
});

test("deadline returns null for a hung waiter and observes late rejections", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectFetch;
  let rejectWaiter;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const probe = runOutageProbe({
      assignment: assignment(), scope: scope("messages"), gatewayURL: "http://gateway", gatewayKey: "test-key",
      fetchImpl: () => new Promise((_resolve, reject) => { rejectFetch = reject; }),
      waitForOutcome: () => new Promise((_resolve, reject) => { rejectWaiter = reject; }),
    });
    await Promise.resolve();
    context.mock.timers.tick(10_000);
    assert.equal(await probe, null);
    rejectFetch(new Error("late fetch"));
    rejectWaiter(new Error("late waiter"));
    await Promise.resolve();
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
