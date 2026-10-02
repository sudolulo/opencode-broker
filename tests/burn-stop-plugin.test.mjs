// The plugin half of the burn watch: a /usage reply carrying `burn.stop` aborts that
// session's turn and tells the person why. Hosted the way failover.test.mjs hosts the
// plugin: a child process with node:http's request replaced by a scripted broker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a burn stop on the /usage reply aborts that session and toasts the reason", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-burn-plugin-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const usage = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        if (options.path === "/usage") usage.push(body);
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/usage" && body.sessionID === "ses-runaway"
          ? { ok: true, burn: { stop: true, reason: "it re-sent its whole prompt uncached 4 times in 5 min (1.71M tokens)" } }
          : { ok: true };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    const aborts = [];
    const toasts = [];
    // The session store answers for parentID chains too: ses-child has ses-parent, which
    // has no parent (a root). The plugin walks it to resolve rootSessionID.
    const sessionData = {
      "ses-healthy": { id: "ses-healthy", agent: "smart", parentID: null },
      "ses-runaway": { id: "ses-runaway", agent: "smart", parentID: null },
      "ses-child": { id: "ses-child", agent: "smart", parentID: "ses-parent" },
      "ses-parent": { id: "ses-parent", agent: "smart", parentID: null },
    };
    const client = {
      provider: { list: async () => ({ data: { connected: [], all: [] } }) },
      session: {
        get: async (input) => ({ data: sessionData[input?.path?.id] ?? { id: input?.path?.id, agent: "smart" } }),
        messages: async () => ({ data: [] }),
        abort: async (input) => { aborts.push(input.path.id); return { data: true }; },
        prompt: async () => ({ data: true }),
      },
      tui: { showToast: async (input) => { toasts.push(input.body); return { data: true }; } },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {});
    const step = async (sessionID, n) => {
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "msg-" + sessionID + n, sessionID, role: "assistant", providerID: "anthropic", modelID: "claude-opus-5" } } } });
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        id: "prt-" + sessionID + n, messageID: "msg-" + sessionID + n, sessionID, type: "step-finish",
        tokens: { input: 5, output: 400, cache: { read: 17000, write: 430000 } } } } } });
    };
    await step("ses-healthy", 1);
    await step("ses-runaway", 1);
    await step("ses-child", 1);
    await new Promise((r) => setTimeout(r, 100));
    console.log(JSON.stringify({ usage, aborts, toasts }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.usage.length, 3, "every step is still reported");
    assert.deepEqual(result.aborts, ["ses-runaway"], "only the session the broker named is stopped");
    assert.equal(result.toasts.length, 1);
    assert.equal(result.toasts[0].title, "Burn watch stopped this session");
    assert.match(result.toasts[0].message, /re-sent its whole prompt uncached 4 times .*send a message to continue deliberately/);
    // The plugin forwards rootSessionID only when it resolves to a different session (the
    // walk reached a parent). A root with no parent does not carry a self-root in the body.
    const bySession = Object.fromEntries(result.usage.map((body) => [body.sessionID, body]));
    assert.equal(bySession["ses-healthy"].rootSessionID, undefined, "a root with no parent does not carry rootSessionID");
    assert.equal(bySession["ses-runaway"].rootSessionID, undefined, "a root with no parent does not carry rootSessionID");
    assert.equal(bySession["ses-child"].rootSessionID, "ses-parent",
      "a subagent walks its parentID chain and names its root in the /usage body");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The SDK error envelope `{ error: ... }` has no string `id`. That must count as a FAILED
// lookup -- NEVER memoized as a root. Before the fix the walker read parentID off the
// error object (undefined), decided the current hop was its own root, and cached it;
// then every later report for the subagent landed under the WRONG root.
test("a session.get result without a string id is a failed lookup, never memoized as a root", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-burn-plugin-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const usage = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        if (options.path === "/usage") usage.push(body);
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit("data", JSON.stringify({ ok: true }));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    // ses-child's real root is ses-grandparent; ses-parent's lookup fails with an SDK
    // error envelope. The walk must NOT accept ses-parent as the root just because the
    // error object has no parentID field.
    const client = {
      provider: { list: async () => ({ data: { connected: [], all: [] } }) },
      session: {
        get: async (input) => {
          const id = input?.path?.id;
          if (id === "ses-child") return { data: { id, agent: "smart", parentID: "ses-parent" } };
          if (id === "ses-parent") return { data: { error: { name: "NotFoundError", message: "no such session" } } };
          return { data: { id, agent: "smart", parentID: null } };
        },
        messages: async () => ({ data: [] }),
        abort: async () => ({ data: true }),
        prompt: async () => ({ data: true }),
      },
      tui: { showToast: async () => ({ data: true }) },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {});
    const step = async (sessionID, n) => {
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "msg-" + sessionID + n, sessionID, role: "assistant", providerID: "anthropic", modelID: "claude-opus-5" } } } });
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        id: "prt-" + sessionID + n, messageID: "msg-" + sessionID + n, sessionID, type: "step-finish",
        tokens: { input: 5, output: 400, cache: { read: 17000, write: 100 } } } } } });
    };
    await step("ses-child", 1);
    await new Promise((r) => setTimeout(r, 100));
    console.log(JSON.stringify({ usage }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.usage.length, 1);
    // The error envelope must NOT have been accepted as the root -- the walk gives up
    // and omits rootSessionID instead of claiming ses-parent (an unreal shape of the
    // real session) as the root of ses-child.
    assert.notEqual(result.usage[0].rootSessionID, "ses-parent",
      "an SDK error envelope must not be read as the walker's root hop");
    assert.equal(result.usage[0].rootSessionID, undefined,
      "a failed lookup leaves rootSessionID unset (safe fallback: self-root in the broker)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Repeated failing lookups are memoized for 60 s and concurrent first lookups for the
// same session are deduped, so a looping subagent cannot ask session.get N times per step.
// A successful lookup is memoized forever, so a stepping session asks session.get once.
test("resolveRootSessionID memoizes a failure for 60 s and dedupes a successful lookup across steps", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-burn-plugin-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit("data", JSON.stringify({ ok: true }));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    let failCalls = 0;
    let goodCalls = 0;
    const client = {
      provider: { list: async () => ({ data: { connected: [], all: [] } }) },
      session: {
        get: async (input) => {
          const id = input?.path?.id;
          if (id === "ses-fail") {
            failCalls += 1;
            throw new Error("boom");
          }
          if (id === "ses-good") {
            goodCalls += 1;
            return { data: { id: "ses-good", agent: "smart", parentID: null } };
          }
          return { data: { id, agent: "smart", parentID: null } };
        },
        messages: async () => ({ data: [] }),
        abort: async () => ({ data: true }),
        prompt: async () => ({ data: true }),
      },
      tui: { showToast: async () => ({ data: true }) },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {});
    const step = async (sessionID, n) => {
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "msg-" + sessionID + n, sessionID, role: "assistant", providerID: "anthropic", modelID: "claude-opus-5" } } } });
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        id: "prt-" + sessionID + n, messageID: "msg-" + sessionID + n, sessionID, type: "step-finish",
        tokens: { input: 5, output: 400, cache: { read: 17000, write: 100 } } } } } });
    };
    // 10 concurrent steps for a failing session must collapse to at most one session.get.
    await Promise.all(Array.from({ length: 10 }, (_, i) => step("ses-fail", i)));
    // 10 concurrent steps for a succeeding session must do the same.
    await Promise.all(Array.from({ length: 10 }, (_, i) => step("ses-good", i)));
    // Wait for all detached step-finish chains to resolve.
    await new Promise((r) => setTimeout(r, 150));
    // Another 10 steps AFTER both resolutions finished -- within the 60 s negative TTL
    // for the failing session, and never asking again for the successful one.
    for (let i = 10; i < 20; i++) await step("ses-fail", i);
    for (let i = 10; i < 20; i++) await step("ses-good", i);
    await new Promise((r) => setTimeout(r, 100));
    console.log(JSON.stringify({ failCalls, goodCalls }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.failCalls, 1,
      `20 steps for a failing session must collapse to a single session.get within the TTL; got ${result.failCalls}`);
    assert.equal(result.goodCalls, 1,
      `20 steps for a succeeding session must collapse to a single session.get; got ${result.goodCalls}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A session.get that never resolves must not hold the /usage report nor the burn.stop
// reply hostage: both race root resolution against a 1500 ms deadline, and on timeout
// the report is sent without rootSessionID so the broker still sees the step.
test("a hung session.get does not block /usage: the report is sent without rootSessionID and burn.stop still aborts", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-burn-plugin-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const usage = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        if (options.path === "/usage") usage.push(body);
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/usage"
          ? { ok: true, burn: { stop: true, reason: "it re-sent its whole prompt uncached 4 times in 5 min (1.71M tokens)" } }
          : { ok: true };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    const aborts = [];
    const toasts = [];
    // session.get never resolves. The plugin must time out, send /usage without
    // rootSessionID, and still abort when the broker's reply says stop.
    const client = {
      provider: { list: async () => ({ data: { connected: [], all: [] } }) },
      session: {
        get: () => new Promise(() => {}),
        messages: async () => ({ data: [] }),
        abort: async (input) => { aborts.push(input.path.id); return { data: true }; },
        prompt: async () => ({ data: true }),
      },
      tui: { showToast: async (input) => { toasts.push(input.body); return { data: true }; } },
    };
    // Shortened timeout so the test takes ~2 s rather than ~3 s.
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, { rootResolveTimeoutMs: 300 });
    const step = async (sessionID, n) => {
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "msg-" + sessionID + n, sessionID, role: "assistant", providerID: "anthropic", modelID: "claude-opus-5" } } } });
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        id: "prt-" + sessionID + n, messageID: "msg-" + sessionID + n, sessionID, type: "step-finish",
        tokens: { input: 5, output: 400, cache: { read: 17000, write: 430000 } } } } } });
    };
    await step("ses-hung", 1);
    // Give the resolution race its full timeout plus the detached reply chain.
    await new Promise((r) => setTimeout(r, 1200));
    console.log(JSON.stringify({ usage, aborts, toasts }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.usage.length, 1, "the /usage report is sent despite the hung session.get");
    assert.equal(result.usage[0].rootSessionID, undefined,
      "the timed-out walk must omit rootSessionID instead of waiting forever");
    assert.deepEqual(result.aborts, ["ses-hung"], "the burn.stop reply still aborts the turn");
    assert.equal(result.toasts[0]?.title, "Burn watch stopped this session");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// If a hung session.get never settles, the walk promise must still settle so its
// sessionRootInflight entry is removed and a failure is memoized. Otherwise every
// later step-finish on the same session waits the full rootResolveTimeoutMs again
// (because resolveRootSessionIDBounded races a NEW outer timer against the stuck
// in-flight promise), and the in-flight map leaks forever.
test("after one hung session.get the failure is memoized; the next step on the same session skips the resolution wait", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-burn-plugin-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const usage = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        if (options.path === "/usage") usage.push({ sessionID: body.sessionID, rootSessionID: body.rootSessionID, at: Date.now() });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit("data", JSON.stringify({ ok: true }));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    let getSessionCalls = 0;
    const client = {
      provider: { list: async () => ({ data: { connected: [], all: [] } }) },
      session: {
        get: () => { getSessionCalls += 1; return new Promise(() => {}); },
        messages: async () => ({ data: [] }),
        abort: async () => ({ data: true }),
        prompt: async () => ({ data: true }),
      },
    };
    // 50 ms is short enough that the whole test stays well under a second, and far
    // enough above node_test's clock jitter to tell "no wait" apart from "one wait".
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, { rootResolveTimeoutMs: 50 });
    const step = async (sessionID, n) => {
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "msg-" + sessionID + n, sessionID, role: "assistant", providerID: "anthropic", modelID: "claude-opus-5" } } } });
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        id: "prt-" + sessionID + n, messageID: "msg-" + sessionID + n, sessionID, type: "step-finish",
        tokens: { input: 5, output: 400 } } } } });
    };
    await step("ses-hung", 1);
    // Wait > rootResolveTimeoutMs * 2 so the walk's inner getSession race has fired,
    // the walk has settled with null, the in-flight entry has been removed, and the
    // failure has been memoized.
    await new Promise((r) => setTimeout(r, 200));
    const step2At = Date.now();
    await step("ses-hung", 2);
    // Short post-step wait: the second /usage must not require another resolution
    // round-trip. With the memo in place it is detached as a microtask.
    await new Promise((r) => setTimeout(r, 20));
    console.log(JSON.stringify({ usage, getSessionCalls, step2At }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.getSessionCalls, 1,
      "session.get is called at most once; the failure memo short-circuits later steps within its TTL");
    assert.equal(result.usage.length, 2,
      "both /usage reports must land -- the second one must not be held hostage by the stale in-flight walk");
    const step2Usage = result.usage.find((entry) => entry.at >= result.step2At);
    assert.ok(step2Usage, "step 2's /usage must be among the reports");
    assert.ok(step2Usage.at - result.step2At < 40,
      "step 2's /usage must not wait another rootResolveTimeoutMs; got " + (step2Usage.at - result.step2At) + " ms");
    assert.equal(step2Usage.rootSessionID, undefined,
      "step 2 still omits rootSessionID: the failure memo keeps the fallback path");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
