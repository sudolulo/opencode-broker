import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ☠️ A TEMPORARY HOME, SET BEFORE THE FIRST DYNAMIC IMPORT AND FOR THE WHOLE SUITE. Both modules
// under test resolve their paths from `homedir()` at module scope -- the broker SOCKET, tui.js's
// mode directory, the profile records -- so this is the only point at which they can be
// redirected, and every import below is dynamic precisely so it lands after this line. It buys
// two things: the suite never reads or writes a real installation's state, and a fake broker can
// listen on the path `brokerRequest` will actually dial, which is what lets a test drive a real
// 400 body through the router's real parsing.
const HOME = mkdtempSync(join(tmpdir(), "hud-home-"));
process.env.HOME = HOME;
after(() => { rmSync(HOME, { recursive: true, force: true }); });

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures-config.json", import.meta.url).pathname;
// The fixture's swap-back command is `true`: every swap-back path under test is about WHETHER the
// swap is asked for, and none of them reads what it printed -- so a test run can never touch a
// real GPU.
// The permission-mode controls follow opencode-guard's presence; pin them on for this suite, and
// flip the variable per test where the absence is what is under test.
process.env.OPENCODE_BROKER_HUD_GUARD = "on";
// The lease wait polls every 5 s in production. Nothing here should sit through that.
process.env.OPENCODE_HUD_PREPARE_POLL_MS = "5";

// ☠️ THE SEAM THAT WAS MISSING. tui.js reaches the broker through `brokerRequest`, a STATIC import
// from lib/routing.js, and requestLease/switchProfile are closure-local -- so nothing in this
// suite could observe a routing decision at all, and two routing bugs shipped straight through the
// gap. node:test's module mocking closes it: the namespace is replaced ONCE, before tui.js is
// imported, with the REAL exports plus a dispatch shim for the few a test needs to steer. Each
// shim delegates to the real implementation unless a test installs a hook, so every test that does
// not opt in behaves exactly as it did before.
// ☠️ Requires --experimental-test-module-mocks (package.json's test script). It is experimental:
// if a node upgrade renames or drops it, this file is where it fails, loudly, at import time.
const routerUrl = new URL("../../lib/routing.js", import.meta.url).href;
const realRouter = await import(routerUrl);
const routerHooks = {};
const shim = (name) => (...args) => (routerHooks[name] ?? realRouter[name])(...args);
const resetRouterHooks = () => { for (const key of Object.keys(routerHooks)) delete routerHooks[key]; };
// The background-shell store the HUD imports from `CONFIG.hud.backgroundShells` at plugin init.
// It is null (no store, no shells) unless a test points it at the fake below, so every other
// test sees the same shell-less HUD it always did. CONFIG itself is frozen, so the mocked
// namespace carries a copy whose hud.backgroundShells is a getter over this variable.
let fakeBgStorePath = null;
const mockedRouter = {
  ...realRouter,
  CONFIG: { ...realRouter.CONFIG, hud: { ...realRouter.CONFIG.hud, get backgroundShells() { return fakeBgStorePath; } } },
  brokerRequest: shim("brokerRequest"),
  resolveProfile: shim("resolveProfile"),
  // ☠️ Stubbable because the real ones WRITE into ~/.local/share/opencode/model-routing. A test must not leave managed-switch records behind for the running TUI to read.
  markManagedModelSwitch: shim("markManagedModelSwitch"),
  clearManagedModelSwitch: shim("clearManagedModelSwitch"),
};
// Node 24 renamed the option to `exports` and deprecated `namedExports`; Node 20 and 22 only
// understand `namedExports` and silently ignore `exports`, which leaves the module with no exports.
const nodeMajor = Number(process.versions.node.split(".")[0]);
mock.module(routerUrl, nodeMajor >= 24 ? { exports: mockedRouter } : { namedExports: mockedRouter });

// Swap-back is an external process boundary. Record that boundary rather than running even the
// fixture's harmless `true` command: the behavior under test is whether cleanup launches an
// awaited or detached restore at all.
const childProcessUrl = "node:child_process";
const realChildProcess = await import(childProcessUrl);
const swapBackCalls = [];
const resetSwapBackCalls = () => { swapBackCalls.length = 0; };
const mockedChildProcess = {
  ...realChildProcess,
  execFile: (command, args, options, callback) => {
    swapBackCalls.push({ kind: "awaited", command, args });
    callback(null, "", "");
  },
  spawn: (command, args, options) => {
    swapBackCalls.push({ kind: "detached", command, args });
    return { unref() {} };
  },
};
mock.module(childProcessUrl,
  nodeMajor >= 24 ? { exports: mockedChildProcess } : { namedExports: mockedChildProcess });

// THE SIDEBAR SEAM. The usage sidebar's text is a closure (`sidebarText`), reachable only
// through getters on the elements the `sidebar_content` slot factory builds -- and the real
// @opentui/solid runtime throws "No renderer found" the instant it is called outside a live TUI,
// so invoking that factory from a test is impossible with the real runtime. It is replaced here
// with one that returns a plain object carrying the SAME property descriptors, so
// `element.content` still re-reads the closure on every access. Nothing in tui.js is restructured
// for testability: a test drives the exact factory opencode drives, with the exact getters.
//
// @opentui/solid is an optionalDependency, and tui.js treats it as one: its import at
// tui.js:345 is dynamic and falls back to null. Resolving it at module scope therefore turned
// its absence into 30 unrelated HUD failures. Only the three sidebar tests need the runtime, so
// only they fail for it, and by name. Nothing is skipped: no test passes without what it needs.
let jsxUrl = null;
let jsxRuntimeMissing = null;
try {
  jsxUrl = import.meta.resolve("@opentui/solid/jsx-runtime");
} catch (error) {
  jsxRuntimeMissing = error?.message ?? String(error);
}
const requireJsxRuntime = () => {
  if (jsxRuntimeMissing) {
    throw new Error(`the usage-sidebar tests need the @opentui/solid jsx runtime: ${jsxRuntimeMissing}`);
  }
};
const recordingJsx = (type, props = {}) => {
  const element = { type };
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(props ?? {}))) {
    Object.defineProperty(element, key, { ...descriptor, configurable: true });
  }
  return element;
};
const recordingRuntime = { jsx: recordingJsx, jsxs: recordingJsx, Fragment: "fragment" };
if (jsxUrl) mock.module(jsxUrl, nodeMajor >= 24 ? { exports: recordingRuntime } : { namedExports: recordingRuntime });

// A stand-in for opencode-background-shells' lib/bg-store.js, written into the temporary HOME (and
// removed with it). Its jobs are set per test through `setJobs`, on the very module instance the
// HUD imported, since both import the same file URL.
const FAKE_BG_STORE = join(HOME, "fake-bg-store.mjs");
writeFileSync(FAKE_BG_STORE, [
  "let jobs = {};",
  "export const setJobs = (next) => { jobs = next; };",
  "export const listJobs = (sessionID) => { const value = jobs[sessionID]; if (value instanceof Error) throw value; return value ?? []; };",
  "export const readOutput = () => ({ text: '', truncated: false });",
].join("\n") + "\n");
const fakeBgStore = await import(new URL(`file://${FAKE_BG_STORE}`).href);

// This fixture re-exports the actual producer after it was evaluated against a separate HOME.
// The HUD imports the fixture later while the suite HOME is restored, proving it honours the
// producer's exported directory rather than assuming the consumer's documented default.
const REAL_BG_HOME = mkdtempSync(join(tmpdir(), "hud-real-bg-home-"));
const suiteHome = process.env.HOME;
const realBgStoreUrl = new URL("../../../opencode-background-shells/lib/bg-store.js", import.meta.url).href + "?hud-real-store";
process.env.HOME = REAL_BG_HOME;
const realBgStore = await import(realBgStoreUrl);
process.env.HOME = suiteHome;
after(() => { rmSync(REAL_BG_HOME, { recursive: true, force: true }); });
const REAL_BG_STORE = join(HOME, "real-bg-store.mjs");
writeFileSync(REAL_BG_STORE, `export * from ${JSON.stringify(realBgStoreUrl)};\n`);

const tuiUrl = new URL("../tui.js", import.meta.url).href;
const plugin = await import(tuiUrl);
let harnessQueue = Promise.resolve();

// ---- the virtual clock -------------------------------------------------------------------------
// The HUD schedules everything it does with the global timers: the budget poll is a recursively
// re-armed setTimeout aligned to the wall clock (Date.now() % 10 s), the roster and the repaint are
// setIntervals, the allocation debounce and the lease wait are setTimeouts. A harness that stubbed
// only setInterval (the old one) left the REAL budget timer running unobserved, so a "poll" helper
// that looked for a 30 s interval did nothing at all and every freshness test passed off the
// construction-time poll. While a harness is open, this clock owns all four timer globals AND
// Date.now, so a test drives the exact production schedule by advancing virtual time, and nothing
// real is ever armed by the plugin.
// The suite's own waits use the REAL timers, captured here before any harness can replace them.
const REAL_TIMERS = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  dateNow: Date.now,
};
let activeClock = null;
// One real macrotask turn drains every microtask chain a hooked (in-process) broker answer starts.
const flushReal = async (turns = 3) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => { REAL_TIMERS.setImmediate(resolve); });
};
const createVirtualClock = (startAt) => {
  let now = startAt;
  let seq = 0;
  const timers = new Map();
  const idOf = (handle) => (typeof handle === "object" && handle !== null ? handle.id : handle);
  const arm = (fn, ms, args, repeat) => {
    seq += 1;
    const delay = Math.max(repeat ? 1 : 0, Number(ms) || 0);
    const handle = { id: seq, unref() { return handle; }, ref() { return handle; }, hasRef: () => false,
      [Symbol.toPrimitive]: () => handle.id };
    timers.set(seq, { id: seq, fn, args, due: now + delay, every: repeat ? delay : null, armedAt: now, delay });
    return handle;
  };
  const clock = {
    now: () => now,
    // Every armed timer, in firing order: what a test inspects to see the real schedule.
    pending: () => [...timers.values()].sort((a, b) => a.due - b.due || a.id - b.id)
      .map(({ id, due, every, armedAt, delay }) => ({ id, due, every, armedAt, delay })),
    // Run every timer that falls due up to now + ms, in due order, letting each one's async work
    // settle before the next fires -- the way an idle TUI would live through that stretch.
    advance: async (ms) => {
      const target = now + ms;
      for (;;) {
        const next = clock.pending().find((timer) => timer.due <= target);
        if (!next) break;
        const timer = timers.get(next.id);
        now = Math.max(now, timer.due);
        if (timer.every) timer.due += timer.every; else timers.delete(timer.id);
        timer.fn(...(timer.args ?? []));
        await flushReal();
      }
      now = target;
      await flushReal();
    },
    advanceTo: (at) => clock.advance(Math.max(0, at - now)),
    // Run one armed timer's callback now, without moving time or its schedule, and wait for what
    // it returned. A one-shot timer is consumed, as it would be by firing.
    fire: async (id) => {
      const timer = timers.get(id);
      if (!timer) return undefined;
      if (!timer.every) timers.delete(id);
      return timer.fn(...(timer.args ?? []));
    },
    install: () => {
      globalThis.setTimeout = (fn, ms, ...args) => arm(fn, ms, args, false);
      globalThis.setInterval = (fn, ms, ...args) => arm(fn, ms, args, true);
      globalThis.clearTimeout = (handle) => { timers.delete(idOf(handle)); };
      globalThis.clearInterval = (handle) => { timers.delete(idOf(handle)); };
      Date.now = () => now;
      activeClock = clock;
    },
    uninstall: () => {
      globalThis.setTimeout = REAL_TIMERS.setTimeout;
      globalThis.clearTimeout = REAL_TIMERS.clearTimeout;
      globalThis.setInterval = REAL_TIMERS.setInterval;
      globalThis.clearInterval = REAL_TIMERS.clearInterval;
      Date.now = REAL_TIMERS.dateNow;
      timers.clear();
      if (activeClock === clock) activeClock = null;
    },
  };
  return clock;
};

const settle = (ms = 5) => new Promise((resolve) => { REAL_TIMERS.setTimeout(resolve, ms); });
// The allocation path is fired by an event, debounced 25 ms and then fully async, so there is no
// promise to await from out here. Poll for the outcome instead of guessing a sleep long enough.
// Each real wait also moves the open harness's virtual clock by the same amount, so the plugin's
// own debounce and lease-poll timers fall due while real I/O (the fake broker socket) proceeds.
const waitFor = async (predicate, { timeoutMs = 4000 } = {}) => {
  const deadline = REAL_TIMERS.dateNow() + timeoutMs;
  while (!predicate()) {
    if (REAL_TIMERS.dateNow() > deadline) throw new Error("timed out waiting for the condition under test");
    await settle(5);
    if (activeClock) await activeClock.advance(5);
  }
};
// A promise a test resolves by hand: how an in-flight broker or session-list call is held open.
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
// The text a recorded element would show: `content` is a getter over the live closure.
const contentOf = (element) => String(element?.content ?? "");
// The human half of a refusal, byte for byte as the broker writes it. Kept in the tests purely so
// they read like the real thing: nothing under test looks at these words any more.
const PREPARING_MESSAGE = "qwen3.8-27b-uncensored is not resident; preparing it now -- resend the prompt in a moment";
const refusal = (message, code) => {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
};
const preparingRefusal = () => refusal(PREPARING_MESSAGE, "target-preparing");

// ☠️ A REAL http server on a REAL unix socket, at the path `brokerSocketPath()` reports -- which is
// the path `brokerRequest` dials, because the temporary HOME above moved both. What is under test
// is how a refusal is read off the WIRE: the `code` exists only in the 400 body, and it is
// lib/client.js's `brokerError` that has to carry it onto the Error, so a fake stubbed in at the
// function boundary would prove nothing about the parsing that keeps it.
const withFakeBroker = async (handler) => {
  const socketPath = realRouter.brokerSocketPath();
  mkdirSync(dirname(socketPath), { recursive: true });
  // A previous fixture's socket file would otherwise be EADDRINUSE.
  rmSync(socketPath, { force: true });
  const seen = [];
  const server = http.createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch {}
      seen.push({ path: request.url, body });
      const { status, payload } = handler(request.url, body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload) + "\n");
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    seen,
    leases: () => seen.filter((call) => call.path === "/lease"),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(socketPath, { force: true });
    },
  };
};
const LEASED_TARGET = {
  leaseID: "lease-hud-allocation",
  target: { id: "qwen-unc", kind: "local", model: { providerID: "llamacpp", id: "qwen3.8-27b-uncensored" } },
  existing: false,
};

// Options beyond the original ones:
//   listSessions  replaces api.client.session.list (return or reject a promise to hold it open)
//   sessionModel  what api.state.session.get(id).model reports, i.e. the live chat-bar model
//   startAt       the virtual clock's starting epoch ms (default: the real time at open)
const withTuiHarness = async ({ questionState, questionError, permissionState, sessionRows = [], initialMode = "manual",
  listSessions, sessionModel, messages, projectedMessages, rendererWidth, sessionStatuses, startAt } = {}) => {
  let releaseHarness;
  const previousHarness = harnessQueue;
  harnessQueue = new Promise((resolve) => { releaseHarness = resolve; });
  await previousHarness;
  const clock = createVirtualClock(startAt ?? REAL_TIMERS.dateNow());
  clock.install();
  const handlers = new Map();
  const disposers = [];
  const pushes = [];
  const releases = [];
  const consumes = [];
  const switches = [];
  const cycles = [];
  const replies = [];
  const toasts = [];
  const navigations = [];
  const switchedModels = [];
  const slotRegistrations = [];
  let layer = null;
  let dialog = null;
  let cleaned = false;

  const on = (name, handler) => {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
    return () => {
      const next = (handlers.get(name) ?? []).filter((entry) => entry !== handler);
      if (next.length) handlers.set(name, next);
      else handlers.delete(name);
    };
  };
  const emit = async (type, properties = {}) => {
    const event = { type, properties };
    for (const handler of handlers.get(type) ?? []) await handler(event);
  };

  let currentMode = initialMode;
  // One TUI window's api. A second window (openWindow below) gets its own slots and route but
  // shares the clock, the broker hooks and the event bus -- two opencode panes on one machine.
  const buildApi = (slotSink, route = { name: "session", params: { sessionID: "ses-1" } }) => ({
    client: {
      session: {
        // The second argument is the SDK's per-request options (where an AbortSignal travels).
        list: (input, options) => (listSessions ? listSessions(input, options) : Promise.resolve({ data: sessionRows })),
        messages: (input, options) => (messages ? messages(input, options) : Promise.resolve({ data: [] })),
      },
      v2: {
        session: {
          messages: (input, options) => (projectedMessages ? projectedMessages(input, options) : Promise.resolve({ data: { data: [], cursor: {} } })),
          switchAgent: async (input) => { switches.push(input); return { data: true }; },
          switchModel: async (input) => { switchedModels.push(input); return { data: true }; },
        },
        app: { agents: async () => ({ data: [
          { name: "standard", mode: "primary" },
          { name: "build", mode: "primary" },
          { name: "fast-build", mode: "primary" },
          { name: "smart", mode: "primary" },
          { name: "deep", mode: "primary" },
          { name: "scout", mode: "subagent" },
          { name: "secret", mode: "primary", hidden: true },
        ] }) },
        question: { reply: async (input) => { replies.push(input); return { data: true }; } },
      },
    },
    event: { on },
    keymap: {
      intercept: (_scope, handler) => { handlers.set("key", [handler]); },
      registerLayer: (registered) => { layer = registered; },
      dispatchCommand: (name) => { cycles.push(name); },
    },
    lifecycle: { onDispose: (fn) => { if (typeof fn === "function") disposers.push(fn); } },
    mode: {
      current: () => currentMode,
      push: (name) => {
        pushes.push(name);
        currentMode = name;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          releases.push(name);
          currentMode = "manual";
        };
      }
    },
    route: {
      current: route,
      navigate: (name, params) => { navigations.push({ name, params }); },
    },
    renderer: rendererWidth ? { width: rendererWidth } : undefined,
    slots: { register: (registration) => { slotSink.push(registration); } },
    state: {
      path: { directory: "/tmp/hud-test" },
      session: {
        // Either state may be a per-session function, for rosters where only one child is blocked.
        question: (id) => {
          if (questionError) throw questionError;
          return (typeof questionState === "function" ? questionState(id) : questionState) ?? [];
        },
        permission: (id) => (typeof permissionState === "function" ? permissionState(id) : permissionState) ?? [],
        status: (id) => ({ type: sessionStatuses?.[id] ?? "idle" }),
        messages: () => [{ role: "user", agent: "standard" }],
        get: () => (sessionModel ? { model: sessionModel } : undefined),
      },
    },
    theme: {},
    ui: {
      dialog: {
        open: false,
        clear: () => { dialog = null; },
        replace: (factory) => { dialog = typeof factory === "function" ? factory() : factory; },
        setSize: () => {},
      },
      toast: (t) => { toasts.push(t); },
    },
  });
  // The elements a user actually sees, built by the same slot factories opencode calls. Each
  // element's `content` getter re-reads the live closure, so one capture keeps reporting the screen.
  const slotsOf = (sink, name) => {
    const registration = sink.find((entry) => entry?.slots?.[name]);
    assert.ok(registration, `the HUD registered no ${name} slot`);
    return registration.slots[name];
  };
  const viewsOf = (sink, api) => ({
    sidebarTitle: () => slotsOf(sink, "sidebar_content")().children[0],
    sidebarBody: () => slotsOf(sink, "sidebar_content")().children[1],
    lastAssistantTitle: () => slotsOf(sink, "sidebar_content")().children[2],
    lastAssistantBody: () => slotsOf(sink, "sidebar_content")().children[3],
    strip: () => slotsOf(sink, "app_bottom")(),
    badge: () => slotsOf(sink, "session_prompt_right")({ session_id: api.route.current?.params?.sessionID }),
    homeBadge: () => slotsOf(sink, "home_prompt_right")(),
  });
  const api = buildApi(slotRegistrations);

  // Dispose the plugin(s) the way opencode does, but leave the virtual clock installed, so a
  // test can still see what is armed afterwards and resolve calls that were in flight.
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const fn of [...disposers]) await fn();
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await dispose();
    } finally {
      clock.uninstall();
      releaseHarness();
    }
  };
  try {
    await plugin.default.tui(api);
    // Fire every repeating timer of this period once, in place (no time passes), and wait for
    // what each returned -- the roster poll is async and its result is what a test asserts on.
    const runEvery = async (ms) => {
      for (const timer of clock.pending().filter((entry) => entry.every === ms)) {
        await clock.fire(timer.id);
      }
      await flushReal();
    };
    const runAgentPoll = () => runEvery(2000);
    const runRefresh = () => runEvery(1000);
    const key = () => handlers.get("key")?.[0];
    // THE REAL BUDGET SCHEDULE: move virtual time to the next 10 s wall-clock boundary plus the
    // 50 ms the plugin arms past it. Whatever the plugin armed fires on the way, exactly as it
    // would for an idle window; if it armed nothing there, nothing polls and the test says so.
    const BUDGET_PERIOD_MS = 10_000;
    const nextBudgetBoundary = () => clock.now() - (clock.now() % BUDGET_PERIOD_MS) + BUDGET_PERIOD_MS + 50;
    const runBudgetPoll = () => clock.advanceTo(nextBudgetBoundary());
    // Navigate the way opencode does: the route object is replaced, and nothing is emitted.
    const navigate = (sessionID) => {
      api.route.current = sessionID ? { name: "session", params: { sessionID } } : { name: "home" };
    };
    const openWindow = async (route) => {
      const sink = [];
      const windowApi = buildApi(sink, route);
      await plugin.default.tui(windowApi);
      return { api: windowApi, ...viewsOf(sink, windowApi) };
    };
    return { api, clock, emit, key, runAgentPoll, runRefresh, runBudgetPoll, nextBudgetBoundary, navigate,
      openWindow, dispose, ...viewsOf(slotRegistrations, api), pushes, releases,
      consumes, switches, cycles, replies, toasts, navigations, switchedModels, cleanup,
      get layer() { return layer; },
      get dialog() { return dialog; } };
  } catch (error) {
    clock.uninstall();
    releaseHarness();
    throw error;
  }
};

test("question asked blocks the first Down before state visibility", async () => {
  const h = await withTuiHarness({ sessionRows: [{ id: "child-1", parentID: "ses-1" }] });
  try {
    await h.runAgentPoll();
    await h.emit("question.asked", { id: "question-1", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
    const ctx = { event: { name: "down" }, consume: () => h.consumes.push("down") };
    await h.key()(ctx);
    assert.deepEqual(h.pushes, ["question"]);
    assert.deepEqual(h.consumes, []);
  } finally {
    await h.cleanup();
  }
});

test("duplicate legacy and v2 asked events push question mode only once", async () => {
  const h = await withTuiHarness();
  try {
    await h.emit("question.asked", { id: "question-dup", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
    await h.emit("question.v2.asked", { id: "question-dup", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
    assert.deepEqual(h.pushes, ["question"]);
  } finally {
    await h.cleanup();
  }
});

test("replying to one of two pending questions retains mode until the last reply", async () => {
  const h = await withTuiHarness();
  try {
    await h.emit("question.asked", { id: "question-first", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
    await h.emit("question.v2.asked", { id: "question-second", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
    await h.emit("question.replied", { sessionID: "ses-1", requestID: "question-first", answers: [["Continue"]] });
    assert.deepEqual(h.pushes, ["question"]);
    assert.deepEqual(h.releases, []);
    await h.emit("question.v2.replied", { sessionID: "ses-1", requestID: "question-second", answers: [["Continue"]] });
    assert.deepEqual(h.releases, ["question"]);
  } finally {
    await h.cleanup();
  }
});

for (const [label, type, extra] of [
  ["replied", "question.replied", { requestID: "question-close", answers: [["Continue"]] }],
  ["rejected", "question.v2.rejected", { requestID: "question-close" }],
  ["deleted", "session.deleted", {}],
]) {
  test(`question ${label} releases plugin-owned mode and clears pending state`, async () => {
    const h = await withTuiHarness();
    try {
      await h.emit("question.asked", { id: "question-close", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
      await h.emit(type, { sessionID: "ses-1", ...extra });
      assert.deepEqual(h.pushes, ["question"]);
      assert.deepEqual(h.releases, ["question"]);
      await h.emit("question.asked", { id: "question-next", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
      assert.deepEqual(h.pushes, ["question", "question"]);
    } finally {
      await h.cleanup();
    }
  });
}

test("dispose releases plugin-owned question mode exactly once", async () => {
  const h = await withTuiHarness();
  try {
    await h.emit("question.asked", { id: "question-dispose", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
    await h.cleanup();
    assert.deepEqual(h.releases, ["question"]);
  } finally {
    await h.cleanup();
  }
});

test("state-query failure fails open without console noise", async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args); };
  const h = await withTuiHarness({ questionError: new Error("stale") , sessionRows: [{ id: "child-1", parentID: "ses-1" }] });
  try {
    await h.runAgentPoll();
    const ctx = { event: { name: "down" }, consume: () => h.consumes.push("down") };
    await h.key()(ctx);
    assert.deepEqual(h.consumes, []);
    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
    await h.cleanup();
  }
});

test("state store visible while mode current is base still causes a push", async () => {
  const h = await withTuiHarness({ questionState: [{ id: "native-question" }], sessionRows: [{ id: "child-1", parentID: "ses-1" }] });
  try {
    await h.runAgentPoll();
    const ctx = { event: { name: "down" }, consume: () => h.consumes.push("down") };
    await h.key()(ctx);
    assert.deepEqual(h.pushes, ["question"]);
    assert.deepEqual(h.consumes, []);
  } finally {
    await h.cleanup();
  }
});

test("mode current already question does not push", async () => {
  const h = await withTuiHarness({ questionState: [{ id: "native-question" }], sessionRows: [{ id: "child-1", parentID: "ses-1" }], initialMode: "question" });
  try {
    assert.deepEqual(h.pushes, []);
    const ctx = { event: { name: "down" }, consume: () => h.consumes.push("down") };
    await h.key()(ctx);
    assert.deepEqual(h.pushes, []);
    assert.deepEqual(h.consumes, []);
  } finally {
    await h.cleanup();
  }
});

test("missed reply event self-heals from host question state", async () => {
  const h = await withTuiHarness();
  const originalNow = Date.now;
  try {
    await h.emit("question.asked", { id: "question-lost", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
    assert.deepEqual(h.pushes, ["question"]);
    // Within the grace window nothing is released even though the host already
    // reports no open question -- a just-asked question must not be popped.
    await h.runRefresh();
    assert.deepEqual(h.releases, []);
    // The replied event never arrives. Once the grace window passes, the
    // reconciler trusts the host's empty question state and releases the mode.
    Date.now = () => originalNow() + 4000;
    await h.runRefresh();
    assert.deepEqual(h.releases, ["question"]);
    // The session's entry is gone: a later question claims the mode again.
    await h.emit("question.asked", { id: "question-after", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
    assert.deepEqual(h.pushes, ["question", "question"]);
  } finally {
    Date.now = originalNow;
    await h.cleanup();
  }
});

test("navigating away drops the mode claim and returning re-claims it", async () => {
  const h = await withTuiHarness();
  try {
    await h.emit("question.asked", { id: "question-elsewhere", sessionID: "ses-1", questions: [{ options: [{ label: "Continue" }] }] });
    assert.deepEqual(h.pushes, ["question"]);
    h.api.route.current = { name: "session", params: { sessionID: "ses-2" } };
    await h.runRefresh();
    // The global mode is released so ses-2 keeps its keybinds, while the
    // pending-question bookkeeping for ses-1 survives.
    assert.deepEqual(h.releases, ["question"]);
    h.api.route.current = { name: "session", params: { sessionID: "ses-1" } };
    const ctx = { event: { name: "down" }, consume: () => h.consumes.push("down") };
    await h.key()(ctx);
    assert.deepEqual(h.pushes, ["question", "question"]);
    assert.deepEqual(h.consumes, []);
  } finally {
    await h.cleanup();
  }
});

test("background-session asked does not push", async () => {
  const h = await withTuiHarness();
  try {
    await h.emit("question.asked", { id: "question-bg", sessionID: "ses-2", questions: [{ options: [{ label: "Continue" }] }] });
    assert.deepEqual(h.pushes, []);
  } finally {
    await h.cleanup();
  }
});

test("staying on a native tier-switch question does not switch the agent", async () => {
  const h = await withTuiHarness();
  try {
    await h.emit("question.asked", { id: "question-stay", sessionID: "ses-1", questions: [{ options: [
      { label: "Switch to Standard (Recommended)" },
      { label: "Stay on current agent" },
    ] }] });
    await h.emit("question.replied", { sessionID: "ses-1", requestID: "question-stay", answers: [["Stay on current agent"]] });
    assert.deepEqual(h.switches, []);
  } finally {
    await h.cleanup();
  }
});

// ---- the broker owns the swap in; the HUD waits for it -------------------------------------

test("HUD allocation releases the exact broker-minted lease", async () => {
  const calls = [];
  routerHooks.resolveProfile = () => ({ profile: "local" });
  routerHooks.brokerRequest = async (path, body) => {
    calls.push({ path, body });
    return path === "/lease" ? LEASED_TARGET : { ok: true };
  };
  routerHooks.markManagedModelSwitch = () => {};
  routerHooks.clearManagedModelSwitch = () => {};
  const h = await withTuiHarness();
  try {
    await h.emit("session.created", { info: { id: "hud-exact-lease", agent: "build" } });
    await waitFor(() => calls.some((call) => call.path === "/release"));
    assert.deepEqual(calls.find((call) => call.path === "/release")?.body, {
      sessionID: "hud-exact-lease",
      leaseID: LEASED_TARGET.leaseID,
    });
  } finally {
    resetRouterHooks();
    await h.cleanup();
    resetSwapBackCalls();
  }
});

test("deleting a session this HUD did not swap does not launch an awaited restore", async () => {
  const h = await withTuiHarness();
  try {
    resetSwapBackCalls();
    await h.emit("session.deleted", { sessionID: "session-owned-by-another-process" });
    assert.deepEqual(swapBackCalls, []);
  } finally {
    await h.cleanup();
  }
});

test("disposing a HUD that owns no swapped sessions does not launch a detached restore", async () => {
  const h = await withTuiHarness();
  resetSwapBackCalls();
  await h.cleanup();
  assert.deepEqual(swapBackCalls, []);
});

test("deleting a session this HUD swapped still launches the awaited restore", async () => {
  routerHooks.resolveProfile = () => ({ profile: "uncensored" });
  routerHooks.brokerRequest = async (path) => path === "/lease" ? LEASED_TARGET : { ok: true };
  routerHooks.markManagedModelSwitch = () => {};
  routerHooks.clearManagedModelSwitch = () => {};
  const h = await withTuiHarness();
  try {
    await h.emit("session.created", { info: { id: "owned-delete", agent: "build" } });
    await waitFor(() => h.switchedModels.length > 0);
    resetSwapBackCalls();

    await h.emit("session.deleted", { sessionID: "owned-delete" });

    assert.deepEqual(swapBackCalls, [{ kind: "awaited", command: "true", args: ["default"] }]);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("explicitly leaving a swapped profile still launches the awaited restore", async () => {
  let profile = "auto";
  routerHooks.resolveProfile = () => ({ profile });
  routerHooks.brokerRequest = async (path) => path === "/lease" ? LEASED_TARGET : { ok: true };
  routerHooks.markManagedModelSwitch = () => {};
  routerHooks.clearManagedModelSwitch = () => {};
  const h = await withTuiHarness();
  try {
    const chooseProfile = h.layer.commands.find((command) => command.name === "hud.routing.profile");
    chooseProfile.run();
    h.dialog.onSelect({ value: "uncensored" });
    h.dialog.onSelect({ value: "switch" });
    await waitFor(() => h.switchedModels.length > 0);

    profile = "uncensored";
    resetSwapBackCalls();
    chooseProfile.run();
    h.dialog.onSelect({ value: "manual" });
    h.dialog.onSelect({ value: "switch" });
    await waitFor(() => swapBackCalls.length > 0);

    assert.deepEqual(swapBackCalls, [{ kind: "awaited", command: "true", args: ["default"] }]);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("the lease wait polls while the broker's code says the target is preparing", async () => {
  const told = [];
  let attempts = 0;
  const lease = await plugin.awaitPreparedLease(async () => {
    attempts += 1;
    if (attempts <= 2) throw preparingRefusal();
    return { target: { id: "qwen-unc" } };
  }, { announce: () => told.push("announce"), progress: () => told.push("progress"), sleep: async () => {} });
  assert.equal(attempts, 3);
  assert.deepEqual(lease, { target: { id: "qwen-unc" } });
  // The user is told ONCE that the card is being swapped, not once per poll.
  assert.deepEqual(told, ["announce"]);
});

test("every refusal but target-preparing is surfaced immediately rather than waited on", async () => {
  const cases = [
    ["no eligible local model is currently deployed, free, or within its context window", "no-eligible-local-target"],
    ["all lightweight routing targets are busy or unavailable", "no-eligible-target"],
    ["broker timeout", undefined],
    // ☠️ THE COMPATIBILITY PATH, and the reason this suite exists in this shape. The prose says
    // the model is being prepared, in the broker's own words -- but an older broker sends no code,
    // and a missing code must never become a fifteen-minute poll. Waiting is decided by the code
    // and by nothing else, so this is refused on the first try like any other unknown refusal.
    [PREPARING_MESSAGE, undefined],
  ];
  for (const [message, code] of cases) {
    let attempts = 0;
    // ☠️ A FAKE CLOCK THAT RUNS OUT, not a no-op sleep. If this assertion ever regresses the loop
    // must terminate and FAIL -- with real time and an instant sleep it would spin for the whole
    // 900 s ceiling instead, and a hanging suite says far less than a red one.
    let clock = 0;
    await assert.rejects(() => plugin.awaitPreparedLease(async () => {
      attempts += 1;
      throw refusal(message, code);
    }, { now: () => clock, sleep: async (ms) => { clock += ms; } }),
      new RegExp(message.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(attempts, 1, `${message} / ${code}`);
  }
});

test("the lease wait gives up at its ceiling and says how long it waited", async () => {
  let clock = 0;
  let attempts = 0;
  let progressed = 0;
  await assert.rejects(() => plugin.awaitPreparedLease(async () => {
    attempts += 1;
    throw preparingRefusal();
  }, {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    progress: () => { progressed += 1; },
    pollMs: 60_000,
    ceilingMs: 900_000,
  }), /still not resident after 15 min of waiting for the broker/);
  // 15 minutes of one-minute polls: the sixteenth attempt is the one that is over the ceiling.
  assert.equal(attempts, 16);
  // Reassurance on the minute, from the first refusal to the last -- transient toasts mean silence
  // reads as a hung TUI.
  assert.equal(progressed, 14);
});

test("an uncensored allocation waits out a target-preparing refusal and then pins the leased model",
  async () => {
    let refusalsLeft = 2;
    // ☠️ brokerRequest is NOT hooked here: /lease has to travel the real client, or this proves
    // nothing about `code` surviving the trip. /release lands on the same fake broker, which is
    // exactly why the temporary HOME matters -- the live broker is unreachable from this suite.
    const broker = await withFakeBroker((path) => {
      if (path !== "/lease") return { status: 200, payload: { ok: true } };
      return refusalsLeft-- > 0
        ? { status: 400, payload: {
            error: PREPARING_MESSAGE,
            code: "target-preparing",
            targetID: "qwen-unc",
            modelID: "qwen3.8-27b-uncensored",
          } }
        : { status: 200, payload: LEASED_TARGET };
    });
    routerHooks.resolveProfile = () => ({ profile: "uncensored" });
    routerHooks.markManagedModelSwitch = () => {};
    routerHooks.clearManagedModelSwitch = () => {};
    const h = await withTuiHarness();
    try {
      // A session created on an inherited uncensored default: no F11, no swap of our own, and the
      // model not resident. The broker refuses twice while it prepares.
      await h.emit("session.created", { info: { id: "ses-unc", agent: "build" } });
      await waitFor(() => h.switchedModels.length > 0);
      assert.equal(broker.leases().length, 3);
      assert.equal(broker.leases()[0].body.profile, "uncensored");
      assert.equal(broker.leases()[0].body.sessionID, "ses-unc");
      // ☆ The whole point of requirement one: when the wait returns, the session is PINNED to the
      // leased target, not merely told the profile changed.
      assert.deepEqual(h.switchedModels, [{
        sessionID: "ses-unc",
        model: { providerID: "llamacpp", id: "qwen3.8-27b-uncensored" },
      }]);
      // The notice is the profile's own, from the deployment config -- once, not once per poll.
      const swapToasts = h.toasts.filter((t) => /uncensored 27b/.test(String(t?.message ?? "")));
      assert.equal(swapToasts.length, 1);
      assert.equal(swapToasts[0].message, "Swapping GPU 1 to the uncensored 27b -- 1-3 minutes.");
    } finally {
      resetRouterHooks();
      await h.emit("session.deleted", { sessionID: "ses-unc" });
      await h.cleanup();
      await broker.close();
    }
  });

test("a refusal with no code at all is surfaced on the first try, not polled", async () => {
  // ☠️ The wire-level half of the compatibility path: an older broker's 400 body, carrying the
  // preparing SENTENCE and nothing machine-readable. One request, no wait, no pin, and the user
  // gets the broker's own words -- a version skew costs a keypress, never a quarter of an hour.
  const broker = await withFakeBroker((path) => (path === "/lease"
    ? { status: 400, payload: { error: PREPARING_MESSAGE } }
    : { status: 200, payload: { ok: true } }));
  routerHooks.resolveProfile = () => ({ profile: "uncensored" });
  routerHooks.markManagedModelSwitch = () => {};
  routerHooks.clearManagedModelSwitch = () => {};
  const h = await withTuiHarness();
  try {
    await h.emit("session.created", { info: { id: "ses-old", agent: "build" } });
    await waitFor(() => h.toasts.some((t) => t?.variant === "error"));
    assert.equal(broker.leases().length, 1);
    assert.deepEqual(h.switchedModels, []);
    // The message reaches the user verbatim, which is why the transport must not reshape it.
    assert.match(String(h.toasts.at(-1)?.message ?? ""), new RegExp(PREPARING_MESSAGE.slice(0, 40)));
    assert.equal(h.toasts.filter((t) => /uncensored 27b/.test(String(t?.message ?? ""))).length, 0);
  } finally {
    resetRouterHooks();
    await h.cleanup();
    await broker.close();
  }
});

// ---- the roster shows subagents, not the guard's command classifier -------------------------

test("the command classifier is kept out of the subagent roster", async () => {
  const h = await withTuiHarness({ sessionRows: [
    { id: "child-classifier", parentID: "ses-1", agent: "fleet-classifier-local", title: "Command classifier" },
  ] });
  try {
    await h.runAgentPoll();
    // An empty roster leaves `down` to the prompt: the intercept only takes it when there is a row
    // to move onto, so an unconsumed `down` is the observable "nothing is listed".
    await h.key()({ event: { name: "down" }, consume: () => h.consumes.push("down") });
    assert.deepEqual(h.consumes, []);
  } finally {
    await h.cleanup();
  }
});

test("a real subagent still reaches the roster beside a classifier child", async () => {
  const h = await withTuiHarness({ sessionRows: [
    // The classifier is listed FIRST: if the filter missed it, row 0 -- the one `down` selects --
    // would be the classifier and enter would open it.
    { id: "child-classifier", parentID: "ses-1", agent: "fleet-classifier", title: "Command classifier" },
    { id: "child-scout", parentID: "ses-1", agent: "scout", title: "Find the thing" },
  ] });
  try {
    await h.runAgentPoll();
    await h.key()({ event: { name: "down" }, consume: () => h.consumes.push("down") });
    await h.key()({ event: { name: "return" }, consume: () => h.consumes.push("return") });
    assert.deepEqual(h.consumes, ["down", "return"]);
    assert.deepEqual(h.navigations, [{ name: "session", params: { sessionID: "child-scout" } }]);
  } finally {
    await h.cleanup();
  }
});

test("assistant hydration uses the legacy message endpoint, not projected v2 messages", async () => {
  requireJsxRuntime();
  const calls = [];
  const h = await withTuiHarness({
    messages: async ({ sessionID }) => {
      calls.push("legacy");
      return { data: [{ info: {
        id: "legacy-turn", sessionID, role: "assistant", providerID: "openai", modelID: "actual-legacy",
        time: { created: 20 },
      }, parts: [] }] };
    },
    projectedMessages: async () => {
      calls.push("projected");
      return { data: { data: [{
        id: "projected-turn", type: "assistant", time: { created: 20 },
        model: { providerID: "openai", id: "projected-model" }, content: [],
      }], cursor: {} } };
    },
  });
  try {
    const last = h.lastAssistantBody();
    await h.runRefresh();
    await flushReal();
    assert.equal(contentOf(last), " openai/actual-legacy");
    assert.deepEqual(calls, ["legacy"]);
  } finally {
    await h.cleanup();
  }
});

test("the HUD shows actual assistant models without preview calls or static defaults", async () => {
  requireJsxRuntime();
  const messageCalls = [];
  const h = await withTuiHarness({
    sessionModel: "wrong-provider/wrong-static-default",
    sessionRows: [{ id: "child-scout", parentID: "ses-1", agent: "scout", title: "Find the thing" }],
    messages: async ({ sessionID, limit }) => {
      messageCalls.push({ sessionID, limit });
      const bySession = {
        "ses-1": [{ info: { id: "main-message", sessionID, role: "assistant", providerID: "anthropic", modelID: "claude-actual", time: { created: 20 } } }],
        "child-scout": [{ info: { id: "child-message", sessionID, role: "assistant", providerID: "openai", modelID: "gpt-child", time: { created: 10 } } }],
      };
      return { data: bySession[sessionID] ?? [] };
    },
  });
  try {
    const last = h.lastAssistantBody();
    const strip = h.strip();
    await h.runAgentPoll();
    await flushReal();
    assert.equal(contentOf(last), " anthropic/claude-actual");
    assert.match(contentOf(strip), /scout.*openai\/gpt-child/);
    assert.deepEqual(messageCalls.sort((a, b) => a.sessionID.localeCompare(b.sessionID)), [
      { sessionID: "child-scout", limit: 20 }, { sessionID: "ses-1", limit: 20 },
    ]);
    assert.doesNotMatch(contentOf(h.homeBadge()), /Route|preview/);

    await h.emit("message.updated", { info: {
      id: "child-newer", sessionID: "child-scout", role: "assistant", providerID: "google", modelID: "gemini-live", time: { created: 30 },
    } });
    assert.match(contentOf(strip), /scout.*google\/gemini-live/);
  } finally {
    await h.cleanup();
  }
});

test("assistant-model hydration is scoped to navigation and cannot overwrite newer live metadata", async () => {
  requireJsxRuntime();
  const requests = new Map();
  const h = await withTuiHarness({ messages: ({ sessionID }) => {
    const request = deferred();
    requests.set(sessionID, request);
    return request.promise;
  } });
  try {
    h.navigate("ses-a");
    const last = h.lastAssistantBody();
    await h.runRefresh();
    assert.equal(contentOf(last), " pending");

    h.navigate("ses-b");
    await h.runRefresh();
    await h.emit("message.updated", { info: {
      id: "b-live", sessionID: "ses-b", role: "assistant", providerID: "openai", modelID: "newer", time: { created: 20 },
    } });
    requests.get("ses-b").resolve({ data: [{ info: {
      id: "b-old", sessionID: "ses-b", role: "assistant", providerID: "openai", modelID: "older", time: { created: 10 },
    } }] });
    requests.get("ses-a").resolve({ data: [{ info: {
      id: "a-late", sessionID: "ses-a", role: "assistant", providerID: "anthropic", modelID: "stale", time: { created: 30 },
    } }] });
    await flushReal();
    assert.equal(contentOf(last), " openai/newer");

    h.navigate("ses-fail");
    await h.runRefresh();
    requests.get("ses-fail").reject(new Error("unavailable"));
    await flushReal();
    assert.equal(contentOf(last), " unavailable");
  } finally {
    await h.cleanup();
  }
});

test("completed empty, malformed, failed, and synchronous assistant hydration becomes stable unavailable metadata", async () => {
  requireJsxRuntime();
  const calls = new Map();
  const h = await withTuiHarness({ messages: ({ sessionID }) => {
    calls.set(sessionID, (calls.get(sessionID) ?? 0) + 1);
    if (sessionID === "ses-error") return { error: new Error("SDK failure") };
    if (sessionID === "ses-reject") return Promise.reject(new Error("transport failure"));
    if (sessionID === "ses-throw") throw new Error("synchronous failure");
    return { data: sessionID === "ses-user" ? [{ info: { role: "user" } }] : [] };
  } });
  try {
    const last = h.lastAssistantBody();
    for (const id of ["ses-empty", "ses-user", "ses-error", "ses-reject", "ses-throw"]) {
      h.navigate(id);
      await h.runRefresh();
      await flushReal();
      const expected = id === "ses-empty" || id === "ses-user" ? " awaiting assistant model" : " unavailable";
      assert.equal(contentOf(last), expected, `${id} is a completed load, not pending`);
      await h.runRefresh();
      assert.equal(calls.get(id), 1, `${id} is hydrated once per visit`);
    }
  } finally {
    await h.cleanup();
  }
});

test("assistant hydration deadline releases an ignored request without repeat polling or disposal timers", async () => {
  requireJsxRuntime();
  let calls = 0;
  const h = await withTuiHarness({ messages: () => { calls += 1; return never(); } });
  try {
    const last = h.lastAssistantBody();
    await h.runRefresh();
    assert.equal(contentOf(last), " pending");
    await h.clock.advance(5_000);
    assert.equal(contentOf(last), " unavailable");
    await h.runRefresh();
    assert.equal(calls, 1, "a timed-out visit is not fetched again");
    await h.dispose();
    assert.equal(h.clock.pending().filter((timer) => timer.delay === 5_000).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("an old A visit cannot overwrite or release the current A hydration", async () => {
  requireJsxRuntime();
  const requests = [];
  const h = await withTuiHarness({ messages: ({ sessionID }) => {
    const request = deferred();
    requests.push({ sessionID, request });
    return request.promise;
  } });
  try {
    const last = h.lastAssistantBody();
    await h.runRefresh(); // A1
    h.navigate("ses-b");
    await h.runRefresh();
    h.navigate("ses-1");
    await h.runRefresh(); // A2
    const [a1, b, a2] = requests;
    a1.request.resolve({ data: [{ info: { id: "a1", sessionID: "ses-1", role: "assistant", providerID: "old", modelID: "stale", time: { created: 99 } } }] });
    await flushReal();
    assert.equal(contentOf(last), " pending", "A1 cannot complete A2");
    a2.request.resolve({ data: [{ info: { id: "a2", sessionID: "ses-1", role: "assistant", providerID: "new", modelID: "current", time: { created: 10 } } }] });
    await flushReal();
    assert.equal(contentOf(last), " new/current");
    a1.request.reject(new Error("late A1 failure"));
    b.request.resolve({ data: [] });
  } finally {
    await h.cleanup();
  }
});

test("assistant metadata ignores summaries and lets a live correction beat stale hydration", async () => {
  requireJsxRuntime();
  const request = deferred();
  const h = await withTuiHarness({ messages: () => request.promise });
  try {
    const last = h.lastAssistantBody();
    await h.runRefresh();
    await h.emit("message.updated", { info: { id: "turn", sessionID: "ses-1", role: "assistant", providerID: "old", modelID: "initial", time: { created: 20 } } });
    await h.emit("message.updated", { info: { id: "turn", sessionID: "ses-1", role: "assistant", providerID: "openai", modelID: "corrected", time: { created: 20 } } });
    await h.emit("message.updated", { info: { id: "summary", sessionID: "ses-1", role: "assistant", summary: true, providerID: "bad", modelID: "compaction", time: { created: 99 } } });
    request.resolve({ data: [
      { info: { id: "turn", sessionID: "ses-1", role: "assistant", providerID: "old", modelID: "hydrated", time: { created: 20 } } },
      { summary: true, info: { id: "summary-hydrated", sessionID: "ses-1", role: "assistant", providerID: "bad", modelID: "compaction", time: { created: 100 } } },
    ] });
    await flushReal();
    assert.equal(contentOf(last), " openai/corrected");
  } finally {
    await h.cleanup();
  }
});

test("narrow roster retains agent status and provider/model suffix before task metrics", async () => {
  requireJsxRuntime();
  const h = await withTuiHarness({ rendererWidth: 60, sessionStatuses: { "child-wide": "running" }, sessionRows: [{
    id: "child-wide", parentID: "ses-1", agent: "very-long-agent-name", status: "running",
    title: "An exceptionally long task title that must yield to model identity", time: { created: 0 },
  }], messages: ({ sessionID }) => ({ data: [{ info: {
    id: "child-model", sessionID, role: "assistant", providerID: "very-long-provider-name", modelID: "meaningful-model-suffix", time: { created: 1 },
  } }] }) });
  try {
    await h.runAgentPoll();
    await flushReal();
    const row = contentOf(h.strip()).split("\n").at(-1);
    assert.ok(row.length <= 60);
    assert.match(row, /very-long-age/);
    assert.match(row, /running/);
    assert.match(row, /ver[^/]*\//);
    assert.match(row, /suffix/);
    assert.doesNotMatch(row, /\d+[sm]\s+·|tok/);
  } finally {
    await h.cleanup();
  }
});

test("a child blocked on a permission or question prompt says so instead of plain busy", async () => {
  requireJsxRuntime();
  const pending = { "child-perm": "permission", "child-ask": "question" };
  const h = await withTuiHarness({ rendererWidth: 120,
    sessionStatuses: { "child-perm": "busy", "child-ask": "busy", "child-run": "busy" },
    permissionState: (id) => (pending[id] === "permission" ? [{ id: "per-1", sessionID: id }] : []),
    questionState: (id) => (pending[id] === "question" ? [{ id: "que-1", sessionID: id }] : []),
    sessionRows: ["child-perm", "child-ask", "child-run"].map((id, i) => ({
      id, parentID: "ses-1", agent: id.slice(6), title: `task ${id}`, time: { created: i },
    })) });
  try {
    await h.runAgentPoll();
    await flushReal();
    const rows = contentOf(h.strip()).split("\n");
    assert.match(rows.find((r) => /child-perm/.test(r)), /needs permission/);
    assert.match(rows.find((r) => /child-ask/.test(r)), /needs answer/);
    const running = rows.find((r) => /child-run/.test(r));
    assert.match(running, /busy/);
    assert.doesNotMatch(running, /needs/);
  } finally {
    await h.cleanup();
  }
});

// ---- the profile tables and the router's profile list must not drift -----------------------
// ☠️ THREE LISTS, ONE TRUTH. The router owns which profiles exist; this plugin decides which are
// OFFERED (F11), how each is LABELLED on screen, and which of them own the swap-back. Each
// omission fails silently and differently:
//
//   missing from ROUTING_OPTIONS    -> the profile exists and is simply unreachable from F11
//   missing from PROFILE_BADGES     -> the badge renders as "", so the session looks like Auto
//   missing from SWAP_BACK_PROFILES -> its sessions do not count in the swap-back veto, so
//                                      leaving the last session on a SIBLING profile runs the
//                                      swap-back and pulls the weights out from under this one
//
// All three are derived from the router's PROFILES; this is the test that keeps them together.
test("\u2620\ufe0f the F11 picker, the badge map and the router's profile list cannot drift apart", () => {
  const offered = plugin.ROUTING_OPTIONS.map((option) => option.value);
  assert.deepEqual(offered, realRouter.PROFILES,
    "every routing profile is offered by F11, in config order, and F11 offers nothing the router does not know");
  for (const option of plugin.ROUTING_OPTIONS) {
    assert.equal(option.title, realRouter.profileTitle(option.value),
      `${option.value}: the picker title and profileTitle() must agree -- they appear side by side`);
    assert.ok(option.description?.length > 20, `${option.value} needs a description`);
  }
  for (const profile of realRouter.PROFILES) {
    assert.equal(typeof plugin.PROFILE_BADGES[profile], "string", `${profile} has no badge entry`);
    // `auto` is the default and deliberately silent; every other profile must be visible.
    if (profile !== "auto") {
      assert.ok(plugin.PROFILE_BADGES[profile].length,
        `${profile} would render no badge at all, which is how the most expensive lane becomes invisible`);
    }
  }
  assert.deepEqual(plugin.SWAP_BACK_PROFILES,
    realRouter.PROFILES.filter((profile) => profile.startsWith("uncensored")),
    "the swap-back veto set is derived from the router's list through the configured pattern, never retyped");
  assert.ok(plugin.SWAP_BACK_PROFILES.includes("uncensored-70b"),
    "\u2620\ufe0f a 70B session that does not veto the swap-back gets its model yanked mid-conversation");
});

test("a profile with no configured copy is described by what it actually is", () => {
  const described = Object.fromEntries(plugin.ROUTING_OPTIONS.map((option) => [option.value, option.description]));
  // `private` is offline by naming convention, `local` is LAN-confined; neither has copy in the fixture.
  assert.match(described.private, /no cloud, web or MCP/);
  assert.match(described.local, /LAN models only; core tools/);
  assert.equal(plugin.PROFILE_BADGES.local, "R:local");
  // Configured copy wins over the derived sentence and badge.
  assert.equal(plugin.PROFILE_BADGES["uncensored-70b"], "R:unc-70b");
  assert.equal(plugin.prepareNotice("local"),
    "The broker is loading a local model for this profile -- this can take a few minutes.");
});

test("the 70B profile states its cost where the choice is actually made", () => {
  // The picker description is the last thing read before the keypress, and this deployment's
  // copy says what the lane costs the rest of the machine.
  const option = plugin.ROUTING_OPTIONS.find((entry) => entry.value === "uncensored-70b");
  assert.ok(option, "the 70B lane must be reachable from F11");
  assert.match(option.description, /BOTH GPUs/);
  assert.match(option.description, /evicts every other resident model/);
});

test("an uncensored-70b allocation waits out the prepare and names ITS cost, not the 27b's",
  async () => {
    // ☠️ Same wire path as the 27b test above -- a real 400 body over a real socket -- because the
    // claim is that the wait is profile-AGNOSTIC (it polls on `target-preparing`, nothing else)
    // while the WORDING is not.
    let refusalsLeft = 2;
    const PREPARING_70B = "big-70b is not resident; preparing it now -- resend the prompt in a moment";
    const broker = await withFakeBroker((path) => {
      if (path !== "/lease") return { status: 200, payload: { ok: true } };
      return refusalsLeft-- > 0
        ? { status: 400, payload: {
            error: PREPARING_70B,
            code: "target-preparing",
            targetID: "uncensored-big",
            modelID: "big-70b",
          } }
        : { status: 200, payload: {
            target: { id: "uncensored-big", kind: "local", model: { providerID: "llamacpp", id: "big-70b" } },
            existing: false,
          } };
    });
    routerHooks.resolveProfile = () => ({ profile: "uncensored-70b" });
    routerHooks.markManagedModelSwitch = () => {};
    routerHooks.clearManagedModelSwitch = () => {};
    const h = await withTuiHarness();
    try {
      await h.emit("session.created", { info: { id: "ses-70b", agent: "build" } });
      await waitFor(() => h.switchedModels.length > 0);
      assert.equal(broker.leases().length, 3);
      assert.equal(broker.leases()[0].body.profile, "uncensored-70b",
        "the lease must carry the 70B's own profile, never the 27b's lane");
      assert.deepEqual(h.switchedModels, [{
        sessionID: "ses-70b",
        model: { providerID: "llamacpp", id: "big-70b" },
      }]);
      const notices = h.toasts.filter((t) => /BOTH GPUs/.test(String(t?.message ?? "")));
      assert.equal(notices.length, 1, "one notice on the first refusal, not one per poll");
      assert.match(notices[0].message, /Every other local model is down/);
      assert.equal(h.toasts.filter((t) => /uncensored 27b/.test(String(t?.message ?? ""))).length, 0,
        "\u2620\ufe0f the 27b's sentence must never be shown for a swap that is not the 27b's");
    } finally {
      resetRouterHooks();
      await h.emit("session.deleted", { sessionID: "ses-70b" });
      await h.cleanup();
      await broker.close();
    }
  });

// ---- a pinned lane joins the picker and NOTHING else ----------------------------------------
test("\u2620\ufe0f vision is offered and badged, and stays out of the swap-back groupings", () => {
  // ☠️ THE RISK ON THIS PROFILE RUNS THE OTHER WAY. For `uncensored-70b` the danger was a list
  // that forgot it; here it is a list that ADOPTS it. `vision` pins a resting model and owns no
  // swap at all. If it joined SWAP_BACK_PROFILES:
  //   - an ordinary vision session would VETO the swap-back, so the displaced models would never
  //     come back while anyone had the vision model pinned; and
  //   - leaving a vision session would RUN the swap-back for a swap it never made.
  assert.ok(plugin.ROUTING_OPTIONS.some((option) => option.value === "vision"),
    "the vision lane must be reachable from F11");
  assert.equal(plugin.PROFILE_BADGES.vision, "R:vision");
  assert.ok(!plugin.SWAP_BACK_PROFILES.includes("vision"),
    "\u2620\ufe0f a vision session must not veto the swap-back, nor trigger one");
});

test("a vision allocation waits on its own sentence, which promises nothing it cannot do",
  async () => {
    // The wait itself is profile-agnostic -- it polls `target-preparing` and nothing else -- so
    // what is under test is the WORDING. A restore that declines rather than displacing a model
    // somebody is using must not promise the model in "1-3 minutes"; it has to say the request
    // may be waiting on somebody else.
    let refusalsLeft = 1;
    const broker = await withFakeBroker((path) => {
      if (path !== "/lease") return { status: 200, payload: { ok: true } };
      return refusalsLeft-- > 0
        ? { status: 400, payload: {
            error: "qwen3.8-27b is not resident; preparing it now -- resend the prompt in a moment",
            code: "target-preparing", targetID: "vision-27b", modelID: "qwen3.8-27b" } }
        : { status: 200, payload: {
            target: { id: "vision-27b", kind: "local", model: { providerID: "llamacpp", id: "qwen3.8-27b" } },
            existing: false } };
    });
    routerHooks.resolveProfile = () => ({ profile: "vision" });
    routerHooks.markManagedModelSwitch = () => {};
    routerHooks.clearManagedModelSwitch = () => {};
    const h = await withTuiHarness();
    try {
      await h.emit("session.created", { info: { id: "ses-vision", agent: "build" } });
      await waitFor(() => h.switchedModels.length > 0);
      assert.equal(broker.leases()[0].body.profile, "vision");
      assert.deepEqual(h.switchedModels, [{
        sessionID: "ses-vision",
        model: { providerID: "llamacpp", id: "qwen3.8-27b" },
      }]);
      const notice = h.toasts.find((t) => /vision model back/.test(String(t?.message ?? "")));
      assert.ok(notice, "the vision wait needs its own sentence");
      assert.match(notice.message, /waits for them rather than taking it/,
        "the notice must say the request may be declined in favour of a live session");
      assert.equal(h.toasts.filter((t) => /uncensored 27b|BOTH GPUs/.test(String(t?.message ?? ""))).length, 0,
        "\u2620\ufe0f neither uncensored sentence belongs on a lane that owns no swap");
    } finally {
      resetRouterHooks();
      await h.cleanup();
      await broker.close();
    }
  });

// ---- a lapsed subscription is not a provider in use ------------------------------------------
// When alibaba-token-plan's plan lapsed, the broker parked it behind a `provider:` circuit and
// routed around it -- but /status keeps reporting its budget for diagnostics, so the sidebar went
// on showing a percentage and a circuit note for a subscription nobody holds. Only `plan-lapsed`
// hides a provider. A quota stop or a bench is a lane still IN USE and its note is the only
// warning anyone gets that routing is avoiding it, so widening this filter to "has any circuit"
// is how openai sits excluded for a day again.
const LAPSED = () => ({ kind: "quota", reason: "plan-lapsed", until: Date.now() + 3_600_000, updatedAt: Date.now() });
const learnedWindow = (spent) => ({ windows: [{ id: "week", spent, capacity: 100, source: "learned" }] });
const withStatus = (status) => {
  routerHooks.brokerRequest = async (path) => {
    if (path === "/status") return status;
    if (path === "/preview") return { preview: {} };
    return {};
  };
};

test("a plan-lapsed provider leaves the usage sidebar entirely while every other note stays", async () => {
  requireJsxRuntime();
  withStatus({
    budgets: {
      "alibaba-token-plan": learnedWindow(50),
      anthropic: learnedWindow(25),
      openai: learnedWindow(10),
    },
    health: { providers: {
      // The lapsed provider is quarantined too: its health note must go with it.
      "alibaba-token-plan": { state: "quarantined" },
      google: { state: "probation" },
      zai: { state: "quarantined" },
    } },
    circuits: {
      "provider:alibaba-token-plan": LAPSED(),
      "provider:openai": { kind: "quota", reason: "quota", until: Date.now() + 3_600_000, updatedAt: Date.now() },
    },
  });
  const h = await withTuiHarness();
  try {
    const body = h.sidebarBody();
    await h.runBudgetPoll();
    await waitFor(() => body.content.includes("anthropic"));
    const text = body.content;
    assert.ok(!/alibaba|token-plan/.test(text),
      `a lapsed plan must appear nowhere -- no row, no note:\n${text}`);
    assert.match(text, /anthropic\s+wk 25%/, "a live provider still gets its row");
    assert.match(text, /openai\s+wk 10%/, "a quota-stopped provider is still a provider in use");
    // A usage stop reads "limit til <weekday> HH:MM": the day is what tells a weekly limit apart
    // from one that lifts later today.
    assert.match(text, /openai\s+\u26d4 limit til (?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d/,
      "a non-lapsed circuit note is load-bearing and must survive the filter");
    assert.match(text, /google\s+\u26d4 probation/, "probation is not a lapse");
    assert.match(text, /zai\s+\u26d4 quarantined/,
      "a non-lapsed quarantine is load-bearing and must survive the filter");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("the sidebar says so when every budgeted provider is lapsed, instead of rendering an empty block", async () => {
  requireJsxRuntime();
  withStatus({
    budgets: { "alibaba-token-plan": learnedWindow(50) },
    health: { providers: {} },
    circuits: { "provider:alibaba-token-plan": LAPSED() },
  });
  const h = await withTuiHarness();
  try {
    const body = h.sidebarBody();
    await h.runBudgetPoll();
    // The broker ANSWERED, so "no broker data yet" would be a lie; the filter emptied the list.
    await waitFor(() => body.content !== " (no broker data yet)");
    assert.equal(body.content, " (no active providers)");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a failed poll marks an all-lapsed sidebar stale without hiding its empty state", async () => {
  requireJsxRuntime();
  withStatus({
    budgets: { "alibaba-token-plan": learnedWindow(50) },
    health: { providers: {} },
    circuits: { "provider:alibaba-token-plan": LAPSED() },
  });
  const h = await withTuiHarness();
  try {
    const body = h.sidebarBody();
    await h.runBudgetPoll();
    assert.equal(body.content, " (no active providers)");

    // Seven minutes of the real schedule, every poll of it failing.
    routerHooks.brokerRequest = async () => { throw new Error("broker unavailable"); };
    await h.clock.advance(7 * 60_000);

    assert.match(body.content, /^ \(stale 7m\)$/m);
    assert.match(body.content, /^ \(no active providers\)$/m);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

// ---- opencode-guard is optional --------------------------------------------------------------
// The keymap layer the plugin registers, as the harness captured it.
const registeredLayer = async () => {
  const h = await withTuiHarness();
  try {
    return h.layer;
  } finally {
    await h.cleanup();
  }
};

test("with opencode-guard present the permission-mode commands and F9 are registered", async () => {
  process.env.OPENCODE_BROKER_HUD_GUARD = "on";
  const layer = await registeredLayer();
  assert.ok(layer.commands.some((command) => command.name === "hud.mode.cycle"));
  assert.ok(layer.bindings.some((binding) => binding.cmd === "hud.mode.cycle" && binding.key === "f9"));
});

test("without opencode-guard the HUD drops every permission-mode control and keeps the rest", async () => {
  process.env.OPENCODE_BROKER_HUD_GUARD = "off";
  try {
    const layer = await registeredLayer();
    const names = layer.commands.map((command) => command.name);
    assert.ok(!names.includes("hud.mode.cycle"), "no mode cycle for a guard that is not listening");
    assert.ok(!names.includes("hud.mode.show"));
    assert.ok(!layer.bindings.some((binding) => binding.key === "f9"));
    for (const name of ["hud.agents.list", "hud.menu", "hud.routing.profile", "hud.usage.toggle"]) {
      assert.ok(names.includes(name), `${name} does not depend on the guard`);
    }
  } finally {
    process.env.OPENCODE_BROKER_HUD_GUARD = "on";
  }
});

test("guard detection: explicit settings win, and a bare machine detects nothing", async () => {
  const { detectGuard } = await import(new URL("../guard.js", import.meta.url).href);
  const bare = mkdtempSync(join(tmpdir(), "hud-guard-"));
  try {
    const base = { env: {}, home: bare, configHome: join(bare, ".config"), resolveFrom: join(bare, "x.js") };
    assert.equal(detectGuard(base).present, false);
    assert.equal(detectGuard({ ...base, setting: true }).present, true);
    assert.equal(detectGuard({ ...base, env: { OPENCODE_BROKER_HUD_GUARD: "off" }, setting: true }).present, false,
      "the environment override beats the config setting");
    // Any one trace of an installed guard is enough.
    mkdirSync(join(bare, ".config/opencode/plugin"), { recursive: true });
    writeFileSync(join(bare, ".config/opencode/plugin/opencode-guard.js"), "");
    assert.deepEqual(detectGuard(base), { present: true, reason: "plugin/" });
    assert.equal(detectGuard({ ...base, setting: false }).present, false, "an explicit false still hides it");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("disposing a HUD that owns a swapped session still launches a detached restore", async () => {
  routerHooks.resolveProfile = () => ({ profile: "uncensored" });
  routerHooks.brokerRequest = async (path) => path === "/lease" ? LEASED_TARGET : { ok: true };
  routerHooks.markManagedModelSwitch = () => {};
  routerHooks.clearManagedModelSwitch = () => {};
  const h = await withTuiHarness();
  try {
    await h.emit("session.created", { info: { id: "owned-dispose", agent: "build" } });
    await waitFor(() => h.switchedModels.length > 0);
    resetSwapBackCalls();

    await h.cleanup();

    assert.deepEqual(swapBackCalls, [{ kind: "detached", command: "true", args: ["default"] }]);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

// ---- freshness: nothing the HUD shows may be silently stale ---------------------------------
// The HUD polls the broker on aligned 10 s boundaries (/status, then /preview) and the session
// list every 2 s. Provider truth cannot be instantaneous -- the broker legitimately caches a plan
// reading for minutes -- so the rule is not "always current" but "never passed off as current":
// what could not be refreshed says so, and warnings are never muted to make it say so.
const EPOCH = 1_800_000_000_000;
const routeOf = (...models) => ({ preview: Object.fromEntries(
  ["deep", "smart"].slice(0, models.length).map((tier, i) => [tier, { model: { id: models[i] } }])) });
// A scripted broker: each field can be swapped mid-test, and every call is stamped with the
// virtual time it arrived at.
const scriptBroker = (initial = {}) => {
  const broker = { status: { budgets: {}, health: { providers: {} }, circuits: {} }, preview: routeOf("model-a"),
    statusError: null, previewError: null, calls: [], ...initial };
  routerHooks.brokerRequest = async (path) => {
    broker.calls.push({ path, at: Date.now() });
    if (path === "/status") {
      if (broker.statusError) throw broker.statusError;
      return typeof broker.status === "function" ? broker.status() : broker.status;
    }
    if (path === "/preview") {
      if (broker.previewError) throw broker.previewError;
      return typeof broker.preview === "function" ? broker.preview() : broker.preview;
    }
    return {};
  };
  return broker;
};
const planReading = (percent, fetchedAt) => ({ plan: { fetchedAt, windows: [
  { id: "week", percent, resetsAt: new Date(fetchedAt + 3 * 86_400_000).toISOString() },
] } });

test("two windows opened at different wall-clock times poll the broker on the same 10 s boundaries", async () => {
  requireJsxRuntime();
  const broker = scriptBroker();
  // Window A opens 3.0 s past a boundary, window B 7.5 s past it.
  const h = await withTuiHarness({ startAt: EPOCH + 3_000 });
  try {
    await h.clock.advance(4_500);
    await h.openWindow({ name: "session", params: { sessionID: "ses-2" } });
    // Each window armed exactly one budget timer, and both point at the same instant.
    const budgetTimers = h.clock.pending().filter((timer) => timer.every === null);
    assert.deepEqual(budgetTimers.map((timer) => timer.due - EPOCH), [10_050, 10_050]);

    broker.calls.length = 0;
    await h.clock.advanceTo(EPOCH + 30_100);
    assert.deepEqual(broker.calls.filter((call) => call.path === "/status").map((call) => call.at - EPOCH),
      [10_050, 10_050, 20_050, 20_050, 30_050, 30_050]);
    assert.equal(broker.calls.some((call) => call.path === "/preview"), false, "the HUD never forecasts routes");
    assert.equal(broker.calls.length, 6, "only /status is polled");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("an idle window picks up new usage on the shared schedule with no input", async () => {
  requireJsxRuntime();
  let percent = 25;
  const broker = scriptBroker({
    status: () => ({ budgets: { anthropic: planReading(percent, Date.now()) }, health: { providers: {} }, circuits: {} }),
  });
  const h = await withTuiHarness({ startAt: EPOCH + 1_000, sessionModel: "anthropic/claude-opus" });
  try {
    const body = h.sidebarBody();
    const badge = h.badge();
    await flushReal();
    assert.match(contentOf(body), /anthropic\s+wk 25%/);
    assert.match(contentOf(badge), /ant 25% wk/);

    percent = 40;
    // No key, no event, no explicit poll: only time passes.
    await h.clock.advance(10_000);
    assert.match(contentOf(body), /anthropic\s+wk 40%/);
    assert.match(contentOf(badge), /ant 40% wk/);
    assert.equal(broker.calls.some((call) => call.path === "/preview"), false);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a healthy broker serving an old provider reading never shows it as current", async () => {
  requireJsxRuntime();
  // The broker answers every poll, but its plan reading was taken at open and never refreshed
  // (a usage API that stopped answering behind a healthy broker).
  const fetchedAt = EPOCH + 1_000;
  scriptBroker({ status: () => ({ budgets: { anthropic: planReading(30, fetchedAt) }, health: { providers: {} }, circuits: {} }) });
  const h = await withTuiHarness({ startAt: EPOCH + 1_000, sessionModel: "anthropic/claude-opus" });
  try {
    const body = h.sidebarBody();
    const badge = h.badge();
    await flushReal();
    assert.match(contentOf(badge), /ant 30% wk/, "a fresh reading is shown");

    await h.clock.advance(4 * 60_000);
    assert.doesNotMatch(contentOf(badge), /ant/, "the badge has no room to say old, so it shows nothing");
    assert.match(contentOf(body), /anthropic\s+wk 30% \(4m old\)/, "the sidebar keeps the number and says its age");
    assert.doesNotMatch(contentOf(body), /\(stale/, "the broker itself is answering; only the reading is old");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a /status failure keeps every warning visible, marks the block stale at once, and recovers", async () => {
  requireJsxRuntime();
  const broker = scriptBroker({ status: () => ({
    budgets: { anthropic: learnedWindow(25) },
    health: { providers: { zai: { state: "quarantined" } } },
    circuits: { "provider:openai": { kind: "quota", until: Date.now() + 3_600_000 } },
  }) });
  const h = await withTuiHarness({ startAt: EPOCH + 1_000, sessionModel: "anthropic/claude-opus" });
  try {
    const body = h.sidebarBody();
    const badge = h.badge();
    await flushReal();
    assert.match(contentOf(badge), /ant 25% wk/);
    assert.doesNotMatch(contentOf(body), /stale/);

    broker.statusError = new Error("broker unavailable");
    await h.runBudgetPoll();
    const text = contentOf(body);
    assert.match(text, /^ \(stale 9s\)$/m, `one failed poll is already stale, with its age:\n${text}`);
    assert.match(text, /zai\s+\u26d4 quarantined/, "a health warning is never dropped by a failed poll");
    assert.match(text, /openai\s+\u26d4 limit til/, "a circuit warning is never dropped by a failed poll");
    assert.doesNotMatch(contentOf(badge), /ant 25%/, "the badge must not vouch for a number the broker did not confirm");

    await h.clock.advance(7 * 60_000);
    assert.match(contentOf(body), /^ \(stale 7m\)$/m);
    assert.match(contentOf(body), /zai\s+\u26d4 quarantined/);
    assert.match(contentOf(badge), /BROKER DOWN/, "the existing broker-down alarm still fires");

    broker.statusError = null;
    await h.runBudgetPoll();
    assert.doesNotMatch(contentOf(body), /stale/);
    assert.match(contentOf(badge), /ant 25% wk/);
    assert.doesNotMatch(contentOf(badge), /BROKER DOWN/);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});


// ---- the roster belongs to the session on screen, and only to it -----------------------------
const CHILD_A = { id: "child-a", parentID: "ses-a", agent: "scout", title: "Task of session A" };
const CHILD_B = { id: "child-b", parentID: "ses-b", agent: "scout", title: "Task of session B" };
// Every session.list call is held open until the test answers it, in whatever order it likes.
// It records the AbortSignal it was given and IGNORES it: the shape of a request whose
// cancellation does not take, so whatever bounds the wait cannot be the request ending.
const heldSessionList = () => {
  const calls = [];
  const listSessions = (_input, options) => {
    const call = deferred();
    call.signal = options?.signal;
    calls.push(call);
    return call.promise;
  };
  return { calls, listSessions, answer: (index, rows) => calls[index].resolve({ data: rows }) };
};

test("navigating while a roster load is in flight loads the new session and drops the old answer", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    const firstPoll = h.runAgentPoll();
    await flushReal();
    assert.equal(list.calls.length, 1);

    h.navigate("ses-b");
    await h.runRefresh();
    assert.equal(list.calls.length, 2, "the new session must not wait behind the old session's request");
    void h.runAgentPoll();
    await flushReal();
    assert.equal(list.calls.length, 2, "one request per session visit, never one per tick");

    list.answer(1, [CHILD_A, CHILD_B]);
    await flushReal();
    assert.match(contentOf(strip), /Task of session B/);

    // The old request lands last. Its rows are session A's children and must go nowhere.
    list.answer(0, [CHILD_A, CHILD_B]);
    await firstPoll;
    await flushReal();
    assert.match(contentOf(strip), /Task of session B/);
    assert.doesNotMatch(contentOf(strip), /Task of session A/);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("A -> B -> A: a late answer from the first visit to A cannot replace the current one", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    void h.runAgentPoll();
    await flushReal();
    h.navigate("ses-b");
    await h.runRefresh();
    h.navigate("ses-a");
    await h.runRefresh();
    assert.equal(list.calls.length, 3, "returning to A is a new visit with a request of its own");

    list.answer(2, [{ ...CHILD_A, title: "Fresh title" }]);
    list.answer(1, [CHILD_B]);
    await flushReal();
    assert.match(contentOf(strip), /Fresh title/);

    // Same session ID as the screen, but an older visit: still discarded.
    list.answer(0, [{ ...CHILD_A, title: "Stale title" }]);
    await flushReal();
    assert.match(contentOf(strip), /Fresh title/);
    assert.doesNotMatch(contentOf(strip), /Stale title|Task of session B/);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("navigation clears the old roster and its selection before the next draw", async () => {
  requireJsxRuntime();
  scriptBroker();
  const h = await withTuiHarness({ sessionRows: [CHILD_A] });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    await h.runAgentPoll();
    assert.match(contentOf(strip), /Task of session A/);
    await h.key()({ event: { name: "down" }, consume: () => h.consumes.push("down") });
    assert.deepEqual(h.consumes, ["down"], "row 0 of session A is selected");

    // No poll and no repaint tick yet: the very next draw is already for session B.
    h.navigate("ses-b");
    assert.doesNotMatch(contentOf(strip), /Task of session A/);
    assert.doesNotMatch(contentOf(h.badge()), /\d+\/\d+/, "no tally of session A's children on B's badge");
    await h.key()({ event: { name: "return" }, consume: () => h.consumes.push("return") });
    assert.deepEqual(h.consumes, ["down"], "session A's selection does not survive into B");
    assert.deepEqual(h.navigations, []);

    h.navigate(undefined);
    assert.doesNotMatch(contentOf(strip), /Task of session A/);
    assert.equal(contentOf(strip), "", "home shows no hypothetical route forecast");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a same-session roster picks up changed titles and tokens on the next poll", async () => {
  requireJsxRuntime();
  scriptBroker();
  let row = { ...CHILD_A, tokens: { input: 100, output: 0 } };
  const h = await withTuiHarness({ listSessions: async () => ({ data: [row] }) });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    await h.runAgentPoll();
    assert.match(contentOf(strip), /Task of session A/);
    row = { ...CHILD_A, title: "Renamed task", tokens: { input: 2500, output: 0 } };
    await h.runAgentPoll();
    assert.match(contentOf(strip), /Renamed task/);
    assert.match(contentOf(strip), /2\.5k tokens/);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a failed session list is marked unavailable instead of passing off a roster as current", async () => {
  requireJsxRuntime();
  scriptBroker();
  let failing = false;
  const h = await withTuiHarness({ listSessions: async () => {
    if (failing) throw new Error("server unavailable");
    return { data: [CHILD_A] };
  } });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    await h.runAgentPoll();
    assert.match(contentOf(strip), /Task of session A/);

    failing = true;
    await h.runAgentPoll();
    assert.match(contentOf(strip), /subagents: unavailable/);
    assert.doesNotMatch(contentOf(strip), /Task of session A/, "a roster that could not be read is not shown as current");
    assert.match(contentOf(h.badge()), /agents \?/);

    failing = false;
    await h.runAgentPoll();
    assert.match(contentOf(strip), /Task of session A/);
    assert.doesNotMatch(contentOf(strip), /unavailable/);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("disposal stops in-flight polls from mutating the HUD and arms nothing further", async () => {
  requireJsxRuntime();
  const status = deferred();
  routerHooks.brokerRequest = async (path) => (path === "/status" ? status.promise : routeOf("model-a"));
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions, startAt: EPOCH + 1_000 });
  try {
    h.navigate("ses-a");
    const body = h.sidebarBody();
    const strip = h.strip();
    void h.runAgentPoll();
    await flushReal();
    assert.equal(contentOf(body), " (no broker data yet)");

    await h.dispose();
    assert.deepEqual(h.clock.pending(), [], "no timer of any kind survives disposal");

    status.resolve({ budgets: { anthropic: learnedWindow(25) }, health: { providers: { zai: { state: "quarantined" } } }, circuits: {} });
    list.answer(0, [CHILD_A]);
    await flushReal();
    assert.equal(contentOf(body), " (no broker data yet)", "a poll that lands after disposal changes nothing");
    await h.clock.advance(60_000);
    // Time still passes for the getters (the age fallback may say "unavailable" by now), but
    // nothing the late answer carried is ever installed.
    assert.doesNotMatch(contentOf(body), /anthropic|zai/, "a poll that lands after disposal changes nothing");
    assert.doesNotMatch(contentOf(strip), /Task of session A/);
    assert.deepEqual(h.clock.pending(), [], "and schedules nothing");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

// ---- bounded waits: a request that never ends must not freeze the HUD on old data ------------
// The session list has a 5 s deadline; the broker's /status and /preview have an age fallback of
// two 10 s polls plus 5 s slack. lib/client.js's own timeout is a SOCKET IDLE timeout, which a
// broker dribbling bytes never trips, so these bounds are the HUD's own.
const ROSTER_DEADLINE = 5_000;
const FRESHNESS_FALLBACK = 25_000;
const never = () => new Promise(() => {});
const watchRejections = () => {
  const seen = [];
  const onRejection = (reason) => { seen.push(reason); };
  process.on("unhandledRejection", onRejection);
  return { seen, stop: () => { process.off("unhandledRejection", onRejection); } };
};
// A session list that honours its AbortSignal the way the v2 SDK does: with throwOnError off (the
// default) an aborted fetch is RETURNED as `{ error }`, it does not reject.
const abortableSessionList = () => {
  const calls = [];
  const listSessions = (_input, options) => {
    const call = deferred();
    call.signal = options?.signal;
    options?.signal?.addEventListener?.("abort", () => {
      call.resolve({ error: Object.assign(new Error("This operation was aborted"), { name: "AbortError" }) });
    });
    calls.push(call);
    return call.promise;
  };
  return { calls, listSessions, answer: (index, rows) => calls[index].resolve({ data: rows }) };
};

test("a session list that hangs after a success goes unavailable at its deadline and its late answer is dropped", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const rejections = watchRejections();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    void h.runAgentPoll();
    await flushReal();
    list.answer(0, [CHILD_A]);
    await flushReal();
    assert.match(contentOf(strip), /Task of session A/);

    void h.runAgentPoll();
    await flushReal();
    assert.equal(list.calls.length, 2);
    await h.clock.advance(ROSTER_DEADLINE - 100);
    assert.match(contentOf(strip), /Task of session A/, "inside the deadline the last answer stands");
    await h.clock.advance(200);
    assert.match(contentOf(strip), /subagents: unavailable \(session list not answering\)/);
    assert.doesNotMatch(contentOf(strip), /Task of session A/, "rows nobody could confirm are not shown as current");
    assert.match(contentOf(h.badge()), /agents \?/);
    assert.equal(list.calls[1].signal?.aborted, true, "the hung request is cancelled through its signal");

    // This one ignored the abort and is still out: ticks share it rather than stacking more.
    await h.clock.advance(20_000);
    assert.equal(list.calls.length, 2, "a request that will not end is not joined by another every tick");

    list.answer(1, [{ ...CHILD_A, title: "Late title" }]);
    await flushReal();
    assert.doesNotMatch(contentOf(strip), /Late title/, "an answer past its deadline is not installed");
    assert.match(contentOf(strip), /subagents: unavailable/);

    void h.runAgentPoll();
    await flushReal();
    assert.equal(list.calls.length, 3, "once it has ended, the next tick asks again");
    list.answer(2, [{ ...CHILD_A, title: "Fresh title" }]);
    await flushReal();
    assert.match(contentOf(strip), /Fresh title/);
    assert.doesNotMatch(contentOf(strip), /unavailable/);
    assert.doesNotMatch(contentOf(h.badge()), /agents \?/);
    assert.deepEqual(rejections.seen, []);
  } finally {
    rejections.stop();
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a session list that never answers from the start says unavailable at its deadline, not nothing", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    void h.runAgentPoll();
    await flushReal();
    assert.equal(contentOf(strip), "");
    await h.clock.advance(ROSTER_DEADLINE);
    assert.match(contentOf(strip), /subagents: unavailable \(session list not answering\)/);
    assert.match(contentOf(h.badge()), /agents \?/);
    assert.equal(list.calls.length, 1);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("the roster deadline aborts through the SDK signal, and a list that honours it recovers next tick", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = abortableSessionList();
  const rejections = watchRejections();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    void h.runAgentPoll();
    await flushReal();
    await h.clock.advance(ROSTER_DEADLINE);
    assert.equal(list.calls[0].signal?.aborted, true);
    assert.match(contentOf(strip), /subagents: unavailable/);
    assert.equal(list.calls.length, 1);

    // The abort ended the request, so the guard is free and the next tick asks again at once.
    void h.runAgentPoll();
    await flushReal();
    assert.equal(list.calls.length, 2);
    list.answer(1, [CHILD_A]);
    await flushReal();
    assert.match(contentOf(strip), /Task of session A/);
    assert.doesNotMatch(contentOf(strip), /unavailable/);
    assert.deepEqual(rejections.seen, []);
  } finally {
    rejections.stop();
    resetRouterHooks();
    await h.cleanup();
  }
});

test("navigation aborts the old visit's list, and disposal aborts the current one and arms nothing", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    void h.runAgentPoll();
    await flushReal();
    h.navigate("ses-b");
    await h.runRefresh();
    assert.equal(list.calls.length, 2);
    assert.equal(list.calls[0].signal?.aborted, true, "session A's list is no longer anyone's business");
    assert.equal(list.calls[1].signal?.aborted, false);

    await h.dispose();
    assert.equal(list.calls[1].signal?.aborted, true);
    assert.deepEqual(h.clock.pending(), [], "no deadline timer survives disposal");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

// ---- F10: the roster dialog is held to the same rules as the strip ----------------------------
const runF10 = (h) => h.layer.commands.find((command) => command.name === "hud.agents.list").run();
const SHELL_JOB = { id: "job-1", description: "watch build", state: "running", started: new Date(EPOCH).toISOString() };
const subagentToasts = (h) => h.toasts.filter((t) => t?.title === "subagents");

test("F10 says the subagent list failed instead of 'Nothing running', and still offers the shells", async () => {
  requireJsxRuntime();
  scriptBroker();
  fakeBgStorePath = FAKE_BG_STORE;
  fakeBgStore.setJobs({ "ses-a": [SHELL_JOB] });
  const h = await withTuiHarness({ listSessions: async () => { throw new Error("server unavailable"); } });
  try {
    h.navigate("ses-a");
    runF10(h);
    await flushReal();
    assert.ok(!h.toasts.some((t) => /Nothing running/.test(String(t?.message))), "a failed list is not an empty one");
    assert.ok(subagentToasts(h).some((t) => t.variant === "warning" && /subagent list failed/i.test(t.message)),
      `the failure is said out loud: ${JSON.stringify(h.toasts)}`);
    assert.ok(h.dialog, "the shells are still offered");
    assert.deepEqual(h.dialog.options.map((option) => option.value), ["job-1"]);
    assert.match(String(h.dialog.title), /subagents unavailable/i);
  } finally {
    fakeBgStorePath = null;
    fakeBgStore.setJobs({});
    resetRouterHooks();
    await h.cleanup();
  }
});

test("F10 with no shells and a failed list reports the failure, not 'Nothing running'", async () => {
  requireJsxRuntime();
  scriptBroker();
  const h = await withTuiHarness({ listSessions: async () => { throw new Error("server unavailable"); } });
  try {
    h.navigate("ses-a");
    runF10(h);
    await flushReal();
    assert.ok(!h.toasts.some((t) => /Nothing running/.test(String(t?.message))));
    assert.ok(subagentToasts(h).some((t) => t.variant === "warning" && /subagent list failed/i.test(t.message)));
    assert.equal(h.dialog, null);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("F10 on a list that hangs says so at the deadline and cancels the request", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    runF10(h);
    await flushReal();
    assert.equal(list.calls.length, 1);
    assert.deepEqual(subagentToasts(h), []);
    await h.clock.advance(ROSTER_DEADLINE);
    assert.ok(subagentToasts(h).some((t) => t.variant === "warning" && /did not answer/.test(t.message)),
      `a hung list is reported: ${JSON.stringify(h.toasts)}`);
    assert.equal(list.calls[0].signal?.aborted, true);
    assert.equal(h.dialog, null);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("A -> B -> A: an F10 answer from the first visit to A opens nothing", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    runF10(h);
    await flushReal();
    const f10Call = list.calls.length - 1;
    h.navigate("ses-b");
    await h.runRefresh();
    h.navigate("ses-a");
    await h.runRefresh();
    list.answer(f10Call, [CHILD_A]);
    await flushReal();
    assert.equal(h.dialog, null, "the dialog belongs to a visit that has ended");
    assert.deepEqual(subagentToasts(h), []);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("disposing while F10 waits opens nothing and leaves no timer", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    runF10(h);
    await flushReal();
    await h.dispose();
    assert.deepEqual(h.clock.pending(), []);
    assert.equal(list.calls[0].signal?.aborted, true);
    list.answer(0, [CHILD_A]);
    await flushReal();
    assert.equal(h.dialog, null);
    assert.deepEqual(subagentToasts(h), []);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("an F10 selection acts on its own visit only", async () => {
  requireJsxRuntime();
  scriptBroker();
  const h = await withTuiHarness({ listSessions: async () => ({ data: [CHILD_A] }) });
  try {
    h.navigate("ses-a");
    runF10(h);
    await flushReal();
    h.dialog.onSelect({ value: "child-a" });
    assert.deepEqual(h.navigations, [{ name: "session", params: { sessionID: "child-a" } }], "same visit: it opens");

    runF10(h);
    await flushReal();
    const select = h.dialog.onSelect;
    h.navigate("ses-b");
    await h.runRefresh();
    select({ value: "child-a" });
    assert.equal(h.navigations.length, 1, "a pick from session A's list does not act from session B");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("newer F10 owns the dialog when two same-visit answers resolve in reverse order", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    runF10(h);
    runF10(h);
    list.answer(1, [{ ...CHILD_A, title: "Latest picker" }]);
    await flushReal();
    const latest = h.dialog;
    assert.equal(latest.options[0].title, "Latest picker");
    list.answer(0, [{ ...CHILD_A, title: "Obsolete picker" }]);
    await flushReal();
    assert.equal(h.dialog, latest, "the older invocation cannot replace the newer dialog");
    assert.deepEqual(subagentToasts(h), []);
    assert.equal(list.calls[0].signal.aborted, true, "superseded work is cancelled");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

for (const outcome of ["empty", "failed"]) {
  test(`a newer ${outcome} F10 supersedes an older successful answer`, async () => {
    requireJsxRuntime();
    scriptBroker();
    const list = heldSessionList();
    const h = await withTuiHarness({ listSessions: list.listSessions });
    try {
      h.navigate("ses-a");
      runF10(h);
      runF10(h);
      if (outcome === "empty") list.answer(1, []);
      else list.calls[1].reject(new Error("new list failed"));
      await flushReal();
      const notices = [...subagentToasts(h)];
      assert.equal(notices.length, 1);
      assert.match(notices[0].message, outcome === "empty" ? /Nothing running/ : /new list failed/);
      list.answer(0, [CHILD_A]);
      await flushReal();
      assert.equal(h.dialog, null, "superseded rows must not open a picker after the latest result");
      assert.deepEqual(subagentToasts(h), notices);
    } finally {
      resetRouterHooks();
      await h.cleanup();
    }
  });
  test(`an older ${outcome} F10 cannot toast over a newer successful picker`, async () => {
    requireJsxRuntime();
    scriptBroker();
    const list = heldSessionList();
    const h = await withTuiHarness({ listSessions: list.listSessions });
    try {
      h.navigate("ses-a");
      runF10(h);
      runF10(h);
      list.answer(1, [CHILD_A]);
      await flushReal();
      if (outcome === "empty") list.answer(0, []);
      else list.calls[0].reject(new Error("obsolete list failed"));
      await flushReal();
      assert.deepEqual(subagentToasts(h), [], "only the latest invocation may report its outcome");
      assert.equal(h.dialog.options[0].value, "child-a");
    } finally {
      resetRouterHooks();
      await h.cleanup();
    }
  });
}

for (const replacement of ["another visit", "newer invocation", "empty invocation", "disposed HUD"]) {
  test(`retained F10 selection cannot affect a replacement after ${replacement}`, async () => {
    requireJsxRuntime();
    scriptBroker();
    let rows = [CHILD_A, CHILD_B];
    const h = await withTuiHarness({ listSessions: async () => ({ data: rows }) });
    try {
      h.navigate("ses-a");
      runF10(h);
      await flushReal();
      const selectOld = h.dialog.onSelect;
      if (replacement === "another visit") h.navigate("ses-b");
      if (replacement === "empty invocation") rows = [];
      if (replacement === "disposed HUD") {
        await h.dispose();
        h.api.ui.dialog.replace(() => ({ title: "Replacement dialog" }));
      } else {
        runF10(h);
        await flushReal();
      }
      const current = h.dialog;
      if (replacement === "empty invocation") assert.equal(current, null, "old rows are not left visible");
      selectOld({ value: "child-a" });
      assert.equal(h.dialog, current, "an obsolete selection must not clear another dialog");
      assert.deepEqual(h.navigations, [], "an obsolete selection must not navigate");
    } finally {
      resetRouterHooks();
      await h.cleanup();
    }
  });
}

test("repeated F10 with ignored aborts bounds requests and recovers after they settle", async () => {
  requireJsxRuntime();
  scriptBroker();
  const list = heldSessionList();
  const rejections = watchRejections();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    for (let i = 0; i < 20; i += 1) runF10(h);
    await flushReal();
    assert.equal(list.calls.length, 2, "at most a superseded request plus its replacement remain outstanding");
    assert.ok(list.calls.every((call) => call.signal.aborted));
    assert.equal(subagentToasts(h).length, 1, "only the latest invocation reports unavailable");
    assert.match(subagentToasts(h)[0].message, /unavailable/i);
    list.answer(1, [CHILD_A]);
    list.answer(0, [CHILD_A]);
    await flushReal();
    assert.equal(h.dialog, null);
    runF10(h);
    list.answer(2, [CHILD_A]);
    await flushReal();
    assert.equal(h.dialog.options[0].value, "child-a");
    await h.dispose();
    assert.deepEqual(h.clock.pending(), []);
    assert.deepEqual(rejections.seen, []);
  } finally {
    rejections.stop();
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a shell a subagent started shows under its parent, marked as the subagent's, in the panel and F10", async () => {
  requireJsxRuntime();
  scriptBroker();
  fakeBgStorePath = FAKE_BG_STORE;
  const kidJob = { ...SHELL_JOB, id: "job-kid", sessionID: "ses-kid", description: "child build" };
  fakeBgStore.setJobs({
    "ses-kid": [kidJob],
    "ses-stranger": [{ ...SHELL_JOB, id: "job-stranger", sessionID: "ses-stranger", description: "stranger build" }],
  });
  const h = await withTuiHarness({ rendererWidth: 120, sessionStatuses: { "ses-kid": "busy" }, sessionRows: [
    { id: "ses-kid", parentID: "ses-a", agent: "tester", title: "run the suite", time: { created: 0 } },
    { id: "ses-stranger", parentID: "ses-elsewhere", agent: "tester", title: "not ours", time: { created: 0 } },
  ] });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    await h.runAgentPoll();
    await h.clock.advance(2_000);
    const text = contentOf(strip);
    assert.match(text, /subagent shell\s+child build/, text);
    assert.doesNotMatch(text, /stranger build/, "another tree's shells stay out");
    runF10(h);
    await flushReal();
    assert.deepEqual(h.dialog.options.map((option) => option.value), ["ses-kid", "job-kid"]);
  } finally {
    fakeBgStorePath = null;
    fakeBgStore.setJobs({});
    resetRouterHooks();
    await h.cleanup();
  }
});

test("shell rows keep refreshing every two seconds while the subagent list ignores cancellation", async () => {
  requireJsxRuntime();
  scriptBroker();
  fakeBgStorePath = FAKE_BG_STORE;
  fakeBgStore.setJobs({ "ses-a": [SHELL_JOB] });
  const list = heldSessionList();
  const h = await withTuiHarness({ listSessions: list.listSessions });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    void h.runAgentPoll();
    await h.clock.advance(2_000);
    assert.match(contentOf(strip), /watch build/, "shells need not wait five seconds for a list timeout");
    fakeBgStore.setJobs({ "ses-a": [{ ...SHELL_JOB, description: "renamed build" }] });
    await h.clock.advance(2_000);
    assert.match(contentOf(strip), /renamed build/);
    await h.clock.advance(2_000);
    assert.match(contentOf(strip), /subagents: unavailable/);
    fakeBgStore.setJobs({ "ses-a": [{ ...SHELL_JOB, state: "done" }] });
    await h.clock.advance(2_000);
    assert.doesNotMatch(contentOf(strip), /renamed build|watch build/);
    fakeBgStore.setJobs({ "ses-a": [{ ...SHELL_JOB, description: "next build" }] });
    await h.clock.advance(2_000);
    assert.match(contentOf(strip), /next build/);
    assert.equal(list.calls.length, 1, "disk refresh does not stack session-list calls");
    assert.equal(list.calls[0].signal.aborted, true);
  } finally {
    fakeBgStorePath = null;
    fakeBgStore.setJobs({});
    resetRouterHooks();
    await h.cleanup();
  }
});

test("shell source failure is visible beside valid agents and recovers without losing other warnings", async () => {
  requireJsxRuntime();
  scriptBroker();
  fakeBgStorePath = FAKE_BG_STORE;
  fakeBgStore.setJobs({ "ses-a": new Error("unreadable store") });
  let failedList = false;
  const h = await withTuiHarness({ listSessions: async () => {
    if (failedList) throw new Error("list failed");
    return { data: [CHILD_A] };
  } });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    await h.runAgentPoll();
    assert.match(contentOf(strip), /shells: unavailable/i);
    assert.match(contentOf(strip), /Task of session A/);
    assert.match(contentOf(h.badge()), /shells \?/);
    runF10(h);
    await flushReal();
    assert.equal(h.dialog.options[0].value, "child-a");
    assert.ok(subagentToasts(h).some((toast) => /shells.*unavailable/i.test(toast.message)));
    failedList = true;
    await h.clock.advance(2_000);
    assert.match(contentOf(strip), /subagents: unavailable/);
    assert.match(contentOf(strip), /shells: unavailable/);
    fakeBgStore.setJobs({ "ses-a": [SHELL_JOB] });
    await h.clock.advance(2_000);
    assert.match(contentOf(strip), /watch build/);
    assert.doesNotMatch(contentOf(strip), /shells: unavailable/);
    assert.match(contentOf(strip), /subagents: unavailable/);
  } finally {
    fakeBgStorePath = null;
    fakeBgStore.setJobs({});
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a configured shell store that cannot load is unavailable rather than absent", async () => {
  requireJsxRuntime();
  scriptBroker();
  fakeBgStorePath = join(HOME, "missing-configured-store.mjs");
  const h = await withTuiHarness();
  try {
    await h.runAgentPoll();
    assert.match(contentOf(h.strip()), /shells: unavailable/);
    runF10(h);
    await flushReal();
    assert.ok(subagentToasts(h).some((toast) => /shells.*unavailable/i.test(toast.message)));
    assert.ok(!subagentToasts(h).some((toast) => /Nothing running/.test(toast.message)));
  } finally {
    fakeBgStorePath = null;
    resetRouterHooks();
    await h.cleanup();
  }
});

test("the Bun TUI treats an uninstalled optional shell plugin as absent, not a failed store", () => {
  // Bun reports a missing module, whereas Node reports a missing package. Exercise the real
  // host runtime rather than guessing an error shape; HOME/config remain the suite's fixtures.
  const output = realChildProcess.execFileSync("bun", ["--eval", `
    const plugin = (await import(${JSON.stringify(tuiUrl)})).default;
    const disposers = [];
    const toasts = [];
    let layer;
    await plugin.tui({
      route: { current: { name: "session", params: { sessionID: "missing-store-test" } } },
      client: { session: { list: async () => ({ data: [] }) } },
      state: { path: { directory: ${JSON.stringify(HOME)} }, session: {} },
      event: { on: () => () => {} },
      lifecycle: { onDispose: (fn) => disposers.push(fn) },
      keymap: { intercept() {}, registerLayer: (value) => { layer = value; } },
      slots: { register() {} },
      ui: { dialog: { clear() {} }, toast: (value) => toasts.push(value) },
    });
    layer.commands.find((command) => command.name === "hud.agents.list").run();
    await new Promise((resolve) => setImmediate(resolve));
    for (const dispose of disposers) await dispose();
    console.log(JSON.stringify(toasts.filter((toast) => toast.title === "subagents")));
  `], { encoding: "utf8", timeout: 10_000 });
  const toasts = JSON.parse(output);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /Nothing running/);
  assert.doesNotMatch(toasts[0].message, /unavailable|partial read/);
});

test("invalid shell records leave valid rows visible with a partial-read warning", async () => {
  requireJsxRuntime();
  scriptBroker();
  fakeBgStorePath = FAKE_BG_STORE;
  fakeBgStore.setJobs({ "ses-a": [null, SHELL_JOB, {}] });
  const h = await withTuiHarness();
  try {
    h.navigate("ses-a");
    await h.runAgentPoll();
    assert.match(contentOf(h.strip()), /watch build/);
    assert.match(contentOf(h.strip()), /shells: partial read/);
    runF10(h);
    await flushReal();
    assert.deepEqual(h.dialog.options.map((option) => option.value), ["job-1"]);
    assert.ok(subagentToasts(h).some((toast) => /shells: partial read/.test(toast.message)));
  } finally {
    fakeBgStorePath = null;
    fakeBgStore.setJobs({});
    resetRouterHooks();
    await h.cleanup();
  }
});

test("the real shell producer's skipped records stay visible as HUD partial reads and recover", async () => {
  requireJsxRuntime();
  scriptBroker();
  fakeBgStorePath = REAL_BG_STORE;
  const dir = realBgStore.DIR;
  const owned = { id: "owned", sessionID: "ses-a", pid: process.pid, description: "Owned shell", started: new Date(EPOCH).toISOString() };
  const other = { id: "other", sessionID: "ses-b", pid: process.pid, description: "Other session", started: new Date(EPOCH).toISOString() };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owned.json"), JSON.stringify(owned));
  writeFileSync(join(dir, "other.json"), JSON.stringify(other));
  writeFileSync(join(dir, "broken.json"), "{");
  mkdirSync(join(dir, "unreadable.json"));
  assert.deepEqual(realBgStore.listJobs("ses-a").map((job) => job.id), ["owned"],
    "the real producer skips malformed and unreadable records while retaining the owned row");
  const h = await withTuiHarness({ startAt: EPOCH + 1_000 });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    await h.runAgentPoll();
    assert.match(contentOf(strip), /Owned shell/);
    assert.doesNotMatch(contentOf(strip), /Other session/);
    assert.match(contentOf(strip), /shells: partial read/);

    runF10(h);
    await flushReal();
    assert.deepEqual(h.dialog.options.map((option) => option.value), ["owned"]);
    assert.ok(subagentToasts(h).some((toast) => /shells: partial read/.test(toast.message)));

    rmSync(join(dir, "owned.json"));
    await h.clock.advance(3_000);
    assert.doesNotMatch(contentOf(strip), /Owned shell/);
    assert.match(contentOf(strip), /shells: partial read/, "all producer-filtered records still diagnose the partial read");
    runF10(h);
    await flushReal();
    assert.ok(subagentToasts(h).some((toast) => /shells: partial read/.test(toast.message)));

    rmSync(join(dir, "broken.json"));
    rmSync(join(dir, "unreadable.json"), { recursive: true });
    writeFileSync(join(dir, "recovered.json"), JSON.stringify({ ...owned, id: "recovered", description: "Recovered shell" }));
    await h.clock.advance(3_000);
    assert.match(contentOf(strip), /Recovered shell/);
    assert.doesNotMatch(contentOf(strip), /shells: partial read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    fakeBgStorePath = null;
    resetRouterHooks();
    await h.cleanup();
  }
});

test("the real shell producer's unreadable exit record warns in the HUD and recovers", async () => {
  requireJsxRuntime();
  scriptBroker();
  fakeBgStorePath = REAL_BG_STORE;
  const dir = realBgStore.DIR;
  const job = { id: "exit-unreadable", sessionID: "ses-a", pid: process.pid, description: "Exit unreadable", started: new Date(EPOCH).toISOString() };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${job.id}.json`), JSON.stringify(job));
  mkdirSync(join(dir, `${job.id}.rc`));
  assert.deepEqual(realBgStore.listJobs("ses-a"), [],
    "the real producer skips a record when its exit file cannot be read");
  const h = await withTuiHarness({ startAt: EPOCH + 1_000 });
  try {
    h.navigate("ses-a");
    const strip = h.strip();
    await h.runAgentPoll();
    assert.match(contentOf(strip), /shells: partial read/);

    runF10(h);
    await flushReal();
    assert.ok(subagentToasts(h).some((toast) => /shells: partial read/.test(toast.message)));
    assert.ok(!subagentToasts(h).some((toast) => /Nothing running/.test(toast.message)));

    rmSync(join(dir, `${job.id}.rc`), { recursive: true });
    writeFileSync(join(dir, `${job.id}.rc`), "0");
    await h.clock.advance(3_000);
    assert.doesNotMatch(contentOf(strip), /shells: partial read/);
    runF10(h);
    await flushReal();
    assert.deepEqual(h.dialog.options.map((option) => option.value), [job.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    fakeBgStorePath = null;
    resetRouterHooks();
    await h.cleanup();
  }
});

test("the real shell producer's directory errors warn while a missing optional store stays quiet", async () => {
  requireJsxRuntime();
  scriptBroker();
  fakeBgStorePath = REAL_BG_STORE;
  const dir = realBgStore.DIR;
  rmSync(dir, { recursive: true, force: true });
  const h = await withTuiHarness();
  try {
    await h.runAgentPoll();
    assert.doesNotMatch(contentOf(h.strip()), /shells: unavailable|shells: partial read/,
      "ENOENT is an absent optional store, not an error");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    writeFileSync(dir, "not a directory");
    assert.deepEqual(realBgStore.listJobs("ses-a"), [], "the real producer hides its directory error as an empty list");
    await h.clock.advance(3_000);
    assert.match(contentOf(h.strip()), /shells: unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    fakeBgStorePath = null;
    resetRouterHooks();
    await h.cleanup();
  }
});

// Real files exercise directory, read and parse failures without platform-dependent chmod tests.
const TASK_ROOT = join(HOME, ".local/share/opencode");
for (const failure of ["invalid", "unreadable"]) {
  test(`${failure} shell exit records are partial reads, not successful outcomes`, async () => {
    requireJsxRuntime();
    scriptBroker();
    const dir = join(TASK_ROOT, "bg");
    mkdirSync(dir, { recursive: true });
    const h = await withTuiHarness({ startAt: EPOCH + 1_000 });
    try {
      writeFileSync(join(dir, "job.json"), JSON.stringify({ id: "job", sessionID: "ses-1", description: "Exit unknown", started: new Date(EPOCH).toISOString() }));
      if (failure === "invalid") writeFileSync(join(dir, "job.rc"), "not an exit code");
      else mkdirSync(join(dir, "job.rc"));
      assert.match(contentOf(h.strip()), /shells: partial read/);
      assert.doesNotMatch(contentOf(h.strip()), /Exit unknown.*(?:done|exit)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      resetRouterHooks();
      await h.cleanup();
    }
  });
}
for (const source of ["bg", "workflow-runs"]) {
  test(`${source} directory failures are visible, missing optional stores remain quiet`, async () => {
    requireJsxRuntime();
    scriptBroker();
    const path = join(TASK_ROOT, source);
    mkdirSync(TASK_ROOT, { recursive: true });
    const h = await withTuiHarness();
    try {
      assert.doesNotMatch(contentOf(h.strip()), /unavailable|partial read/);
      writeFileSync(path, "not a directory");
      await h.clock.advance(3_000);
      assert.match(contentOf(h.strip()), source === "bg" ? /shells: unavailable/ : /workflows: unavailable/);
      rmSync(path);
      await h.clock.advance(3_000);
      assert.doesNotMatch(contentOf(h.strip()), /unavailable|partial read/);
    } finally {
      rmSync(path, { recursive: true, force: true });
      resetRouterHooks();
      await h.cleanup();
    }
  });

  for (const failure of ["corrupt", "unreadable"]) {
    test(`${source} ${failure} records preserve valid rows and recover across session changes`, async () => {
      requireJsxRuntime();
      scriptBroker();
      const dir = join(TASK_ROOT, source);
      mkdirSync(dir, { recursive: true });
      const bad = join(dir, "bad.json");
      const h = await withTuiHarness({ startAt: EPOCH + 1_000 });
      const record = (id, sessionID) => source === "bg"
        ? { id, sessionID, description: `Work for ${sessionID}`, started: new Date(EPOCH).toISOString() }
        : { id, sessionID, name: `Work for ${sessionID}`, status: "running", phase: "review", agentsDone: 0, agentsStarted: 2 };
      const put = (name, data) => {
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(data));
        if (source === "bg") writeFileSync(join(dir, `${data.id}.rc`), "0");
      };
      try {
        put("good-a", record("good-a", "ses-a"));
        put("good-b", record("good-b", "ses-b"));
        if (failure === "corrupt") writeFileSync(bad, "{");
        else mkdirSync(bad);
        h.navigate("ses-a");
        const strip = h.strip();
        assert.match(contentOf(strip), /Work for ses-a/);
        assert.match(contentOf(strip), source === "bg" ? /shells: partial read/ : /workflows: partial read/);
        h.navigate("ses-b");
        assert.match(contentOf(strip), /Work for ses-b/);
        assert.doesNotMatch(contentOf(strip), /Work for ses-a/);
        assert.match(contentOf(strip), /partial read/);
        rmSync(bad, { recursive: true });
        put("bad", record("recovered", "ses-b"));
        await h.clock.advance(3_000);
        assert.doesNotMatch(contentOf(strip), /unavailable|partial read/);
        assert.match(contentOf(strip), /Work for ses-b/);
        h.navigate("ses-a");
        assert.match(contentOf(strip), /Work for ses-a/);
        assert.doesNotMatch(contentOf(strip), /Work for ses-b|partial read/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        resetRouterHooks();
        await h.cleanup();
      }
    });
  }
}

// ---- the broker's answers are aged by when they were ASKED for --------------------------------
const STATUS_25 = () => ({
  budgets: { anthropic: learnedWindow(25) },
  health: { providers: { zai: { state: "quarantined" } } },
  circuits: {},
});

test("a /status that never answers turns 'no broker data yet' into unavailable at the fallback age", async () => {
  requireJsxRuntime();
  const calls = [];
  routerHooks.brokerRequest = (path) => { calls.push(path); return never(); };
  const h = await withTuiHarness({ startAt: EPOCH + 1_000 });
  try {
    const body = h.sidebarBody();
    await flushReal();
    assert.equal(contentOf(body), " (no broker data yet)");
    await h.clock.advance(FRESHNESS_FALLBACK - 1_000);
    assert.equal(contentOf(body), " (no broker data yet)", "a first answer may still come inside two polls and slack");
    await h.clock.advance(2_000);
    assert.equal(contentOf(body), " (broker unavailable)");
    h.navigate(undefined);
    assert.equal(contentOf(h.strip()), "");
    assert.deepEqual(calls, ["/status"], "the hung request is not joined by more");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a /status that hangs after an answer goes stale at the fallback age, warnings kept and badge hidden", async () => {
  requireJsxRuntime();
  let hang = false;
  const calls = [];
  routerHooks.brokerRequest = async (path) => {
    calls.push(path);
    if (hang) return never();
    return path === "/status" ? STATUS_25() : routeOf("model-a");
  };
  const h = await withTuiHarness({ startAt: EPOCH + 1_000, sessionModel: "anthropic/claude-opus" });
  try {
    const body = h.sidebarBody();
    const badge = h.badge();
    await flushReal();
    assert.match(contentOf(badge), /ant 25% wk/);

    hang = true;
    await h.clock.advance(FRESHNESS_FALLBACK - 2_000);
    assert.doesNotMatch(contentOf(body), /stale/);
    assert.match(contentOf(badge), /ant 25% wk/);
    await h.clock.advance(3_000);
    const text = contentOf(body);
    assert.match(text, /^ \(stale 26s\)$/m, `an overdue answer is stale with no failure to report:\n${text}`);
    assert.match(text, /zai\s+\u26d4 quarantined/, "a warning is kept, not dropped");
    assert.doesNotMatch(contentOf(badge), /ant 25%/);
    assert.deepEqual(calls, ["/status", "/status"], "one hung request, never another stacked on it");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("an answer that lands minutes after it was asked for is shown as that old, not as fresh", async () => {
  requireJsxRuntime();
  let held = null;
  routerHooks.brokerRequest = async (path) => {
    if (path !== "/status") return routeOf("model-a");
    if (held) return held.promise;
    return STATUS_25();
  };
  const h = await withTuiHarness({ startAt: EPOCH + 1_000, sessionModel: "anthropic/claude-opus" });
  try {
    const body = h.sidebarBody();
    const badge = h.badge();
    await flushReal();
    held = deferred();
    await h.clock.advance(3 * 60_000);
    assert.match(contentOf(body), /^ \(stale 3m\)$/m);

    const late = held;
    held = null;
    late.resolve({ budgets: { anthropic: learnedWindow(40) }, health: { providers: {} }, circuits: {} });
    await flushReal();
    // Asked for at EPOCH + 10 050, answered at EPOCH + 181 000: its numbers are ~3 min old.
    assert.match(contentOf(body), /anthropic\s+wk 40%/);
    assert.match(contentOf(body), /^ \(stale 3m\)$/m, "a late answer is aged from when it was asked for");
    assert.doesNotMatch(contentOf(badge), /ant 40%/);

    await h.runBudgetPoll();
    assert.doesNotMatch(contentOf(body), /stale/);
    assert.match(contentOf(badge), /ant 25% wk/);
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});


for (const [label, fetchedAt] of [
  ["missing", () => undefined],
  ["zero", () => 0],
  ["negative", () => -5],
  ["not a number", () => "yesterday"],
  ["infinite", () => Infinity],
  ["in the future", () => Date.now() + 60_000],
]) {
  test(`a plan reading whose fetchedAt is ${label} has an unknown age, never a made-up one`, async () => {
    requireJsxRuntime();
    scriptBroker({ status: () => ({
      budgets: { anthropic: { plan: { fetchedAt: fetchedAt(), windows: [{ id: "week", percent: 30 }] } } },
      health: { providers: {} },
      circuits: {},
    }) });
    const h = await withTuiHarness({ startAt: EPOCH + 1_000, sessionModel: "anthropic/claude-opus" });
    try {
      const body = h.sidebarBody();
      await flushReal();
      assert.match(contentOf(body), /^ anthropic\s+wk 30% \(age unknown\)$/m, contentOf(body));
      assert.doesNotMatch(contentOf(h.badge()), /ant/, "an unknown age is not vouched for on the badge");
    } finally {
      resetRouterHooks();
      await h.cleanup();
    }
  });
}

test("a collapsed Usage heading still says the block is stale", async () => {
  requireJsxRuntime();
  const broker = scriptBroker({ status: STATUS_25 });
  const h = await withTuiHarness({ startAt: EPOCH + 1_000 });
  try {
    const title = h.sidebarTitle();
    await flushReal();
    h.layer.commands.find((command) => command.name === "hud.usage.toggle").run();
    assert.equal(contentOf(title), "\nUsage \u25b8");
    broker.statusError = new Error("broker unavailable");
    await h.runBudgetPoll();
    assert.equal(contentOf(title), "\nUsage \u25b8 (stale 9s)");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});

test("a collapsed Usage heading still says the broker is unavailable", async () => {
  requireJsxRuntime();
  routerHooks.brokerRequest = async () => { throw new Error("broker unavailable"); };
  const h = await withTuiHarness({ startAt: EPOCH + 1_000 });
  try {
    const title = h.sidebarTitle();
    await flushReal();
    h.layer.commands.find((command) => command.name === "hud.usage.toggle").run();
    assert.equal(contentOf(title), "\nUsage \u25b8 (unavailable)");
  } finally {
    resetRouterHooks();
    await h.cleanup();
  }
});
