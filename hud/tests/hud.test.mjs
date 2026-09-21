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
const mockedRouter = {
  ...realRouter,
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

const tuiUrl = new URL("../tui.js", import.meta.url).href;
const plugin = await import(tuiUrl);
let harnessQueue = Promise.resolve();

const settle = (ms = 5) => new Promise((resolve) => { setTimeout(resolve, ms); });
// The allocation path is fired by an event, debounced 25 ms and then fully async, so there is no
// promise to await from out here. Poll for the outcome instead of guessing a sleep long enough.
const waitFor = async (predicate, { timeoutMs = 4000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition under test");
    await settle(5);
  }
};
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
  target: { id: "qwen-unc", kind: "local", model: { providerID: "llamacpp", id: "qwen3.8-27b-uncensored" } },
  existing: false,
};

const withTuiHarness = async ({ questionState, questionError, permissionState, sessionRows = [], initialMode = "manual" } = {}) => {
  let releaseHarness;
  const previousHarness = harnessQueue;
  harnessQueue = new Promise((resolve) => { releaseHarness = resolve; });
  await previousHarness;
  const handlers = new Map();
  const disposers = [];
  const intervals = [];
  const pushes = [];
  const releases = [];
  const consumes = [];
  const switches = [];
  const cycles = [];
  const replies = [];
  const toasts = [];
  const navigations = [];
  const switchedModels = [];
  let layer = null;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let cleaned = false;
  global.setInterval = (fn, ms) => {
    intervals.push({ fn, ms });
    return { unref() {} };
  };
  global.clearInterval = () => {};

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
  const api = {
    client: {
      session: {
        list: async () => ({ data: sessionRows }),
      },
      v2: {
        session: {
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
      current: { name: "session", params: { sessionID: "ses-1" } },
      navigate: (name, params) => { navigations.push({ name, params }); },
    },
    slots: { register: () => {} },
    state: {
      path: { directory: "/tmp/hud-test" },
      session: {
        question: () => {
          if (questionError) throw questionError;
          return questionState ?? [];
        },
        permission: () => permissionState ?? [],
        status: () => ({ type: "idle" }),
        messages: () => [{ role: "user", agent: "standard" }],
      },
    },
    theme: {},
    ui: {
      dialog: { open: false, clear: () => {}, replace: () => {}, setSize: () => {} },
      toast: (t) => { toasts.push(t); },
    },
  };

  try {
    await plugin.default.tui(api);
    const runAgentPoll = async () => {
      const agentPoll = intervals.find((entry) => entry.ms === 2000);
      if (agentPoll) await agentPoll.fn();
    };
    const runRefresh = async () => {
      const refreshTimer = intervals.find((entry) => entry.ms === 1000);
      if (refreshTimer) await refreshTimer.fn();
    };
    const key = () => handlers.get("key")?.[0];
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        for (const fn of [...disposers]) await fn();
      } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        releaseHarness();
      }
    };
    return { api, emit, key, runAgentPoll, runRefresh, pushes, releases, consumes, switches, cycles,
      replies, toasts, navigations, switchedModels, cleanup, get layer() { return layer; } };
  } catch (error) {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
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
