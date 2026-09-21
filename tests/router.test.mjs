import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Route the config loader at the fleet-shaped fixture BEFORE any router module
// loads -- config.js reads its file once at import time.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const {
  applyMessageModel,
  applyOutputModel,
  cleanupDeletedSession,
  extractSessionID,
  idleCleanupPath,
  routeTierForSession,
} = await import("../lib/router-core.js");

const withTempHome = async (fn) => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "fleet-model-router-home-"));
  process.env.HOME = home;
  mkdirSync(join(home, ".cache/opencode"), { recursive: true });
  writeFileSync(join(home, ".cache/opencode/models.json"), "{}\n");
  try {
    return await fn(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
};

const startBroker = async (home, responder) => {
  const socketPath = join(home, ".local/share/opencode/model-routing/broker.sock");
  const requests = [];
  mkdirSync(join(home, ".local/share/opencode/model-routing"), { recursive: true });
  rmSync(socketPath, { force: true });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}
      requests.push({ path: req.url, body: parsed });
      const reply = responder({ path: req.url, body: parsed, requests }) ?? {};
      res.statusCode = reply.statusCode ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    requests,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(socketPath, { force: true });
    },
  };
};

test("plugin entry exports nothing but the factory", async () => {
  // OpenCode calls every export of a plugin module as a plugin factory and registers
  // the return value as a hooks object; a stray helper export breaks every boot.
  const entry = await import("../plugin/router.js");
  assert.deepEqual(Object.keys(entry).sort(), ["ModelRouter"]);
});

test("extractSessionID prefers explicit fields and only uses lifecycle ids when appropriate", () => {
  assert.equal(extractSessionID({ session_id: "abc", info: { id: "wrong" } }), "abc");
  assert.equal(extractSessionID({ data: { info: { sessionID: "nested" } } }), "nested");
  assert.equal(extractSessionID({ info: { id: "lifecycle" } }, { lifecycle: true }), "lifecycle");
  assert.equal(extractSessionID({ id: "ignored" }), null);
});

test("idle cleanup stays conservative without a local route", () => {
  const successCandidates = new Map();
  assert.equal(idleCleanupPath("session-a", successCandidates), "/release");
  successCandidates.set("session-b", true);
  assert.equal(idleCleanupPath("session-a", successCandidates), "/release");
  assert.equal(idleCleanupPath("session-b", successCandidates), "/complete");
});

test("applyMessageModel marks a changed route before mutation", () => {
  const calls = [];
  const message = { model: { providerID: "old-provider", modelID: "old-model" } };

  applyMessageModel(
    message,
    { target: { model: { providerID: "new-provider", id: "new-model" } } },
    "session-a",
    (sessionID, model) => {
      calls.push([sessionID, model, message.model]);
    },
  );

  assert.deepEqual(calls, [["session-a", { providerID: "new-provider", id: "new-model" }, { providerID: "old-provider", modelID: "old-model" }]]);
  assert.deepEqual(message.model, { providerID: "new-provider", modelID: "new-model" });
});

test("applyMessageModel does not mark an unchanged route", () => {
  const calls = [];
  const message = { model: { providerID: "same-provider", id: "same-model" } };

  applyMessageModel(
    message,
    { target: { model: { providerID: "same-provider", modelID: "same-model" } } },
    "session-b",
    (...args) => {
      calls.push(args);
    },
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(message.model, { providerID: "same-provider", modelID: "same-model" });
});

test("applyMessageModel treats a variant change as a managed model switch", () => {
  const calls = [];
  const message = { model: { providerID: "openai", modelID: "gpt", variant: "low" } };
  applyMessageModel(message, { target: { model: { providerID: "openai", id: "gpt", variant: "high" } } }, "session-variant",
    (...args) => calls.push(args));
  assert.deepEqual(calls, [["session-variant", { providerID: "openai", id: "gpt", variant: "high" }]]);
  assert.deepEqual(message.model, { providerID: "openai", modelID: "gpt", variant: "high" });
});

test("applyMessageModel ignores invalid inputs", () => {
  const calls = [];
  const message = {};

  applyMessageModel(
    message,
    { target: { model: { providerID: "", id: "bad" } } },
    "session-c",
    (...args) => {
      calls.push(args);
    },
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(message, {});
});

test("applyOutputModel sets the hook output model from the routed target", async () => {
  const output = {};
  applyOutputModel(output, { target: { model: { providerID: "anthropic", modelID: "claude-opus-5" } } });

  assert.deepEqual(output.model, { providerID: "anthropic", modelID: "claude-opus-5" });
});

test("applyOutputModel includes a variant only when it is a non-empty string", async () => {
  const withVariant = {};
  applyOutputModel(withVariant, {
    target: { model: { providerID: "anthropic", modelID: "claude-opus-5", variant: "high" } },
  });
  assert.deepEqual(withVariant.model, { providerID: "anthropic", modelID: "claude-opus-5", variant: "high" });

  const emptyVariant = {};
  applyOutputModel(emptyVariant, {
    target: { model: { providerID: "anthropic", modelID: "claude-opus-5", variant: "" } },
  });
  assert.deepEqual(emptyVariant.model, { providerID: "anthropic", modelID: "claude-opus-5" });
});

test("applyOutputModel falls back to routed.model and accepts id in place of modelID", async () => {
  const output = {};
  applyOutputModel(output, { model: { providerID: "llamacpp", id: "qwen3.5-9b" } });

  assert.deepEqual(output.model, { providerID: "llamacpp", modelID: "qwen3.5-9b" });
});

test("applyOutputModel ignores invalid inputs", async () => {
  // A missing output object must not throw -- the hook may be invoked with nothing to apply.
  applyOutputModel(null, { target: { model: { providerID: "anthropic", modelID: "claude-opus-5" } } });
  applyOutputModel(undefined, { target: { model: { providerID: "anthropic", modelID: "claude-opus-5" } } });

  const noProvider = {};
  applyOutputModel(noProvider, { target: { model: { modelID: "claude-opus-5" } } });
  assert.equal(noProvider.model, undefined);

  const noModel = {};
  applyOutputModel(noModel, { target: { model: { providerID: "anthropic" } } });
  assert.equal(noModel.model, undefined);

  const emptyProvider = {};
  applyOutputModel(emptyProvider, { target: { model: { providerID: "", modelID: "claude-opus-5" } } });
  assert.equal(emptyProvider.model, undefined);

  const noRoute = {};
  applyOutputModel(noRoute, undefined);
  assert.equal(noRoute.model, undefined);
});

test("deleted sessions with a success candidate forget once with completion", async () => {
  const calls = [];
  const routes = new Map([["session-a", { target: { id: "target-a" } }]]);
  const sessions = new Map([["session-a", { id: "session-a" }]]);
  const blocked = new Map([["session-a", "blocked"]]);
  const successCandidates = new Map([["session-a", true]]);
  const removed = [];

  await cleanupDeletedSession({
    sessionID: "session-a",
    routes,
    sessions,
    blocked,
    successCandidates,
    stopHeartbeat: () => {},
    removeSessionProfile: () => {},
    removeSessionContextEstimate: (sessionID) => removed.push(sessionID),
    writePendingForgetRecord: (...args) => {
      throw new Error(`unexpected pending record write: ${JSON.stringify(args)}`);
    },
    removePendingForgetRecord: (sessionID) => removed.push(`forget:${sessionID}`),
    brokerRequest: async (path, body) => {
      calls.push([path, body]);
    },
  });

  assert.deepEqual(calls, [["/forget", { sessionID: "session-a", completed: true }]]);
  assert.equal(routes.has("session-a"), false);
  assert.equal(sessions.has("session-a"), false);
  assert.equal(blocked.has("session-a"), false);
  assert.equal(successCandidates.has("session-a"), false);
  assert.deepEqual(removed, ["session-a", "forget:session-a"]);
});

test("deleted sessions without a success candidate forget only", async () => {
  const calls = [];
  const successCandidates = new Map();

  await cleanupDeletedSession({
    sessionID: "session-b",
    routes: new Map(),
    sessions: new Map(),
    blocked: new Map(),
    successCandidates,
    stopHeartbeat: () => {},
    removeSessionProfile: () => {},
    removeSessionContextEstimate: () => {},
    writePendingForgetRecord: (...args) => {
      throw new Error(`unexpected pending record write: ${JSON.stringify(args)}`);
    },
    removePendingForgetRecord: () => {},
    brokerRequest: async (path, body) => {
      calls.push([path, body]);
    },
  });

  assert.deepEqual(calls, [["/forget", { sessionID: "session-b" }]]);
  assert.equal(successCandidates.has("session-b"), false);
});

test("deleted sessions queue a pending forget when the broker is unavailable", async () => {
  const writes = [];

  await cleanupDeletedSession({
    sessionID: "session-c",
    routes: new Map(),
    sessions: new Map(),
    blocked: new Map(),
    successCandidates: new Map([["session-c", true]]),
    stopHeartbeat: () => {},
    removeSessionProfile: () => {},
    removeSessionContextEstimate: () => {},
    writePendingForgetRecord: (sessionID, record) => writes.push([sessionID, record]),
    removePendingForgetRecord: () => {
      throw new Error("unexpected remove");
    },
    brokerRequest: async () => {
      throw new Error("broker offline");
    },
  });

  assert.deepEqual(writes, [["session-c", { completed: true }]]);
});

test("reviewer tier resolution always selects review despite the parent route tier", async () => {
  let fetched = 0;
  const routes = new Map([["parent-a", { tier: "build" }]]);
  const sessions = new Map();
  const tier = await routeTierForSession({
    agent: "reviewer",
    parentID: "parent-a",
    routes,
    sessions,
    getSession: async () => {
      fetched += 1;
      return { id: "parent-a", agent: "researcher" };
    },
  });
  assert.equal(tier, "review");
  assert.equal(fetched, 0);
});

test("compaction rides the session's own tier, never the local worker (a large session can't compact on 32k)", async () => {
  // cached route tier wins: depot on build stays build for its compaction turn
  const cached = await routeTierForSession({
    agent: "compaction", sessionID: "ses-depot",
    routes: new Map([["ses-depot", { tier: "build" }]]), sessions: new Map(),
  });
  assert.equal(cached, "build");
  // no cached route -> the session's STORED agent decides (smart), not "compaction"
  const stored = await routeTierForSession({
    agent: "compaction", sessionID: "ses-x",
    routes: new Map(), sessions: new Map([["ses-x", { id: "ses-x", agent: "smart" }]]),
  });
  assert.equal(stored, "smart");
  // nothing known -> a safe LARGE-context default, never worker/local
  const fallback = await routeTierForSession({
    agent: "compaction", sessionID: "ses-y", routes: new Map(), sessions: new Map(),
  });
  assert.equal(fallback, "build");
  assert.notEqual(fallback, "worker");
});

test("reviewer tier resolution always selects review without a parent route", async () => {
  let fetched = 0;
  const routes = new Map();
  const sessions = new Map([["parent-b", { id: "parent-b", agent: "researcher" }]]);
  const smartTier = await routeTierForSession({
    agent: "reviewer",
    parentID: "parent-b",
    routes,
    sessions,
    getSession: async () => {
      fetched += 1;
      return null;
    },
  });
  assert.equal(smartTier, "review");
  assert.equal(fetched, 0);

  const missingParentTier = await routeTierForSession({
    agent: "reviewer",
    parentID: "missing-parent",
    routes,
    sessions: new Map(),
    getSession: async () => {
      fetched += 1;
      return null;
    },
  });
  assert.equal(missingParentTier, "review");
  assert.equal(fetched, 0);
});

test("the general subagent inherits its parent tier", async () => {
  const routes = new Map([
    ["parent-smart", { tier: "smart" }],
    ["parent-build", { tier: "build" }],
  ]);
  assert.equal(await routeTierForSession({ agent: "general", parentID: "parent-smart", routes }), "smart");
  assert.equal(await routeTierForSession({ agent: "general", parentID: "parent-build", routes }), "build");
  assert.equal(await routeTierForSession({ agent: "general", parentID: "unknown", routes: new Map(), sessions: new Map() }), "worker");
  assert.equal(await routeTierForSession({ agent: "general" }), "worker");
});

test("chat.message selects the persisted model and every send gets fresh admission", async () => withTempHome(async (home) => {
  const sessionID = "ses-test-params";
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const statePath = join(home, ".local/share/opencode/model-routing/context-estimates/ses-test-params.json");

  const child1 = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const requests = [];
    const originalRequest = http.request;
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        requests.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        if (options.path === "/lease") throw new Error("unexpected lease during context-only event test");
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit("data", JSON.stringify({ changed: false }));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: {
        get: async () => ({ id: ${JSON.stringify(sessionID)}, agent: "standard" }),
        messages: async () => ({ data: [] }),
      },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: ${JSON.stringify(sessionID)},
          message: {
            role: "assistant",
            id: "msg-1",
            providerID: "openai",
            modelID: "gpt-5.6-luna",
            time: { completed: true },
            tokens: { input: 1000, output: 200, cache: { read: 300, write: 0 } },
          },
        },
      },
    });
    process.stdout.write(JSON.stringify({ requests }));
    http.request = originalRequest;
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child1.status, 0, child1.stderr);
  const child1Result = JSON.parse(child1.stdout.trim());
  assert.deepEqual(child1Result.requests.map((request) => request.path), []);
  assert.equal(existsSync(statePath), true);

  const child2 = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const requests = [];
    let providerListCount = 0;
    const originalRequest = http.request;
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        requests.push({ path: options.path, body });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        let reply = {};
        if (options.path === "/inventory") reply = { changed: true };
        if (options.path === "/lease") reply = { target: { model: { providerID: "openai", id: "gpt-5.6-luna" } } };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    const authPath = join(process.env.HOME, ".local/share/opencode/auth.json");
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const client = {
      provider: {
        list: async () => {
          providerListCount += 1;
          throw new Error("Provider.list must not run from chat.message");
        },
      },
      session: {
        get: async () => ({ id: ${JSON.stringify(sessionID)}, agent: "standard" }),
        messages: async () => ({ data: [] }),
      },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    const first = { message: { model: { providerID: "old-provider", modelID: "old-model" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: ${JSON.stringify(sessionID)}, agent: "standard", model: { providerID: "openai", id: "gpt-5.6-luna" } }, first);
    await hooks["chat.params"]({ sessionID: ${JSON.stringify(sessionID)}, agent: "standard", model: { providerID: first.message.model.providerID, id: first.message.model.modelID } });
    const second = { message: { model: { providerID: "old-provider", modelID: "old-model" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: ${JSON.stringify(sessionID)}, agent: "standard", model: { providerID: "openai", id: "gpt-5.6-luna" } }, second);
    await hooks["chat.params"]({ sessionID: ${JSON.stringify(sessionID)}, agent: "standard", model: { providerID: second.message.model.providerID, id: second.message.model.modelID } });
    process.stdout.write(JSON.stringify({
      models: [first.message.model, second.message.model],
      providerListCount,
      requests,
    }));
    http.request = originalRequest;
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child2.status, 0, child2.stderr);
  const result = JSON.parse(child2.stdout.trim());
  assert.deepEqual(result.models, [
    { providerID: "openai", modelID: "gpt-5.6-luna" },
    { providerID: "openai", modelID: "gpt-5.6-luna" },
  ]);
  assert.equal(result.providerListCount, 0);
  assert.deepEqual(result.requests.map((request) => request.path), ["/inventory", "/lease", "/inventory", "/lease"]);
  assert.equal(result.requests[1].body.replace, true);
  assert.deepEqual(result.requests[1].body.preferredModel, { providerID: "openai", id: "gpt-5.6-luna" });
  assert.deepEqual(result.requests[3].body.preferredModel, { providerID: "openai", id: "gpt-5.6-luna" });
  assert.equal(result.requests.some((request) => request.path === "/release"), false);
}));

test("chat.params refuses a provider model that differs from the message-time lease", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const http = createRequire(import.meta.url)("node:http");
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/lease"
          ? { target: { model: { providerID: "openai", id: "gpt-5.6-sol" } } }
          : { changed: false };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      request.destroy = () => {};
      request.setTimeout = () => {};
      request.on = EventEmitter.prototype.on;
      return request;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const client = { session: {
      get: async () => ({ id: "session-mismatch", agent: "smart" }),
      messages: async () => ({ data: [] }),
    } };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    const output = { message: { model: { providerID: "old", modelID: "old" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "session-mismatch", agent: "smart" }, output);
    let error = "";
    try {
      await hooks["chat.params"]({ sessionID: "session-mismatch", agent: "smart", model: { providerID: "openai", id: "gpt-5.6-terra" } });
    } catch (value) { error = String(value?.message ?? value); }
    process.stdout.write(JSON.stringify({ model: output.message.model, error }));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.deepEqual(result.model, { providerID: "openai", modelID: "gpt-5.6-sol" });
  assert.match(result.error, /routed model mismatch: expected openai\/gpt-5\.6-sol/);
}));

test("an uncached routed session blocks when session.get fails", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const http = createRequire(import.meta.url)("node:http");
    const requests = [];
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.end = (payload = "") => {
        requests.push(options.path);
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit("data", JSON.stringify({ changed: false }));
        response.emit("end");
      };
      request.destroy = () => {};
      request.setTimeout = () => {};
      request.on = EventEmitter.prototype.on;
      return request;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client: { session: {
      get: async () => { throw new Error("session unavailable"); },
      messages: async () => ({ data: [] }),
    } }, directory: process.env.HOME });
    let messageError = "";
    let paramsError = "";
    try { await hooks["chat.message"]({ sessionID: "missing-session", agent: "standard", model: { providerID: "openai", id: "gpt-5.6-luna" } }, { message: {}, parts: [] }); }
    catch (error) { messageError = String(error.message); }
    try { await hooks["chat.params"]({ sessionID: "missing-session", model: { providerID: "openai", id: "gpt-5.6-luna" } }); }
    catch (error) { paramsError = String(error.message); }
    process.stdout.write(JSON.stringify({ messageError, paramsError, requests }));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.match(result.messageError, /\[opencode-broker\] auto profile blocked: session unavailable/);
  assert.match(result.paramsError, /\[opencode-broker\] route unavailable/);
  assert.deepEqual(result.requests, ["/inventory"]);
}));

test("a manual root preserves its supplied model when session.get fails", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { writeSessionProfile } from ${JSON.stringify(routingUrl)};
    import { ModelRouter } from ${JSON.stringify(pluginUrl)};
    writeSessionProfile("manual-missing", "manual", { explicit: true });
    const hooks = await ModelRouter({ client: { session: {
      get: async () => { throw new Error("session unavailable"); },
      messages: async () => ({ data: [] }),
    } }, directory: process.env.HOME });
    const output = { message: { model: { providerID: "old", modelID: "old" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "manual-missing", model: { providerID: "openai", id: "gpt-5.6-luna" } }, output);
    await hooks["chat.params"]({ sessionID: "manual-missing", model: { providerID: output.message.model.providerID, id: output.message.model.modelID } });
    process.stdout.write(JSON.stringify(output.message.model));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { providerID: "openai", modelID: "gpt-5.6-luna" });
}));

test("chat.message retries an initial auth-revision inventory rejection", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const requests = [];
    let inventoryCalls = 0;
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.end = (payload = "") => {
        requests.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        let reply = {};
        if (options.path === "/inventory" && ++inventoryCalls === 1) {
          response.statusCode = 400;
          reply = { error: "auth revision changed before inventory publication" };
        } else if (options.path === "/lease") {
          reply = { target: { model: { providerID: "openai", id: "gpt-5.6-luna" } } };
        }
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      request.destroy = () => {};
      request.setTimeout = () => {};
      request.on = EventEmitter.prototype.on;
      return request;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: { get: async () => ({ id: "session-auth-retry", agent: "standard" }), messages: async () => ({ data: [] }) },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    const output = { message: { model: { providerID: "old", modelID: "old" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "session-auth-retry", agent: "standard" }, output);
    await hooks["chat.params"]({ sessionID: "session-auth-retry", agent: "standard", model: { providerID: output.message.model.providerID, id: output.message.model.modelID } });
    process.stdout.write(JSON.stringify({ requests, model: output.message.model }));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.deepEqual(result.requests.map((request) => request.path), ["/inventory", "/inventory", "/lease"]);
  assert.deepEqual(result.model, { providerID: "openai", modelID: "gpt-5.6-luna" });
}));

test("chat.message retries a cached inventory auth race once and succeeds", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const cacheDir = join(home, ".cache/opencode");
  const authDir = join(home, ".local/share/opencode");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(cacheDir, "models.json"), JSON.stringify({
    openai: { id: "openai", models: {
      "gpt-5.6-luna": { id: "gpt-5.6-luna", name: "GPT Mini", status: "active" },
    } },
  }) + "\n");
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\n");

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const require = createRequire(import.meta.url);
    const fs = require("node:fs");
    const http = require("node:http");
    const requests = [];
    let authReads = 0;
    let rewroteAuth = false;
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = (path, ...rest) => {
      const text = originalReadFileSync(path, ...rest);
      if (String(path).endsWith("/auth.json")) {
        authReads += 1;
        if (!rewroteAuth) {
          rewroteAuth = true;
          writeFileSync(path, JSON.stringify({ openai: { type: "oauth", refreshed: true } }) + "\\n");
        }
      }
      return text;
    };
    syncBuiltinESMExports();
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        requests.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        let reply = {};
        if (options.path === "/lease") reply = { target: { model: { providerID: "openai", id: "gpt-5.6-luna" } } };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: { get: async () => ({ id: "session-auth-cache-retry", agent: "standard" }), messages: async () => ({ data: [] }) },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    const output = { message: { model: { providerID: "old", modelID: "old" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "session-auth-cache-retry", agent: "standard" }, output);
    process.stdout.write(JSON.stringify({ authReads, requests, model: output.message.model }));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.authReads, 4);
  assert.deepEqual(result.requests.map((request) => request.path), ["/inventory", "/lease"]);
  assert.deepEqual(result.model, { providerID: "openai", modelID: "gpt-5.6-luna" });
}));

test("pending forget records retry on startup and later chat.message", async () => withTempHome(async (home) => {
  const pendingDir = join(home, ".local/share/opencode/model-routing/pending-forgets");
  mkdirSync(pendingDir, { recursive: true });
  const pendingPath = join(pendingDir, "session-pending.json");
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  writeFileSync(pendingPath, JSON.stringify({ completed: true, updatedAt: Date.now() - 1000 }) + "\n", { mode: 0o600 });

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { existsSync, mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const requests = [];
    let forgetCount = 0;
    const originalRequest = http.request;
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        requests.push({ path: options.path, body });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        let reply = {};
        if (options.path === "/forget") {
          forgetCount += 1;
          if (forgetCount === 1) {
            response.statusCode = 500;
            reply = { error: "broker down" };
          }
        }
        if (options.path === "/inventory") reply = { changed: false };
        if (options.path === "/lease") reply = { target: { model: { providerID: "openai", id: "gpt-5.6-luna" } } };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const client = {
      provider: { list: async () => ({ data: { connected: [], all: [] } }) },
      session: {
        get: async () => ({ id: "session-pending", agent: "standard" }),
        messages: async () => ({ data: [] }),
      },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pendingPath = join(process.env.HOME, ".local/share/opencode/model-routing/pending-forgets/session-pending.json");
    const pendingAfterStartup = existsSync(pendingPath);
    await hooks["chat.message"]({ sessionID: "session-pending", agent: "standard" }, {
      message: { model: { providerID: "old", modelID: "old" } }, parts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pendingAfterMessage = existsSync(pendingPath);
    process.stdout.write(JSON.stringify({ forgetCount, pendingAfterStartup, pendingAfterMessage, requests }));
    http.request = originalRequest;
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.forgetCount, 2);
  assert.equal(result.pendingAfterStartup, true);
  assert.equal(result.pendingAfterMessage, false);
  assert.deepEqual(result.requests.filter((request) => request.path === "/forget").map((request) => request.body), [
    { sessionID: "session-pending", completed: true },
    { sessionID: "session-pending", completed: true },
  ]);
}));

test("idle cleanup queues a completed forget when the broker is unavailable", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const originalRequest = http.request;
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.end = () => {
        if (options.path === "/forget") {
          process.nextTick(() => request.emit("error", new Error("broker unavailable")));
          return;
        }
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const body = options.path === "/lease"
          ? { target: { model: { providerID: "openai", id: "gpt-5.6-luna" } } }
          : { changed: false };
        response.emit("data", JSON.stringify(body));
        response.emit("end");
      };
      request.destroy = () => {};
      request.setTimeout = () => {};
      request.on = EventEmitter.prototype.on;
      return request;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const client = {
      provider: { list: async () => ({ data: { connected: [], all: [] } }) },
      session: { get: async () => ({ id: "session-idle", agent: "standard" }), messages: async () => ({ data: [] }) },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    const output = { message: { model: { providerID: "old", modelID: "old" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "session-idle", agent: "standard" }, output);
    await hooks["chat.params"]({ sessionID: "session-idle", agent: "standard", model: { providerID: output.message.model.providerID, id: output.message.model.modelID } });
    await hooks.event({ event: { type: "message.updated", properties: { sessionID: "session-idle", info: { role: "assistant", time: { completed: Date.now() } } } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-idle" } } });
    const pending = join(process.env.HOME, ".local/share/opencode/model-routing/pending-forgets/session-idle.json");
    process.stdout.write(JSON.stringify({ exists: existsSync(pending), record: JSON.parse(readFileSync(pending, "utf8")) }));
    http.request = originalRequest;
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.exists, true);
  assert.equal(result.record.completed, true);
}));

test("local-only dispatch does not require cloud inventory", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const broker = await startBroker(home, ({ path }) => {
    if (path === "/lease") {
      return { body: { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } } };
    }
    return { body: {} };
  });
  const source = `
    const client = {
      provider: { list: async () => { throw new Error("cloud inventory must not run"); } },
      session: {
        get: async () => ({ id: "ses-local-only", agent: "standard" }),
        messages: async () => ({ data: [] }),
      },
    };
    const { writeSessionProfile } = await import(${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)});
    writeSessionProfile("ses-local-only", "local", { explicit: true });
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    const output = { message: { model: { providerID: "old", modelID: "old" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "ses-local-only", agent: "standard" }, output);
    await hooks["chat.params"]({ sessionID: "ses-local-only", agent: "standard", model: { providerID: output.message.model.providerID, id: output.message.model.modelID } });
    process.stdout.write(JSON.stringify(output.message.model));
  `;
  try {
    const child = await new Promise((resolve, reject) => {
      const childProcess = spawn(process.execPath, ["--input-type=module", "-e", source], {
        env: { ...globalThis.process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      childProcess.stdout.on("data", (chunk) => { stdout += String(chunk); });
      childProcess.stderr.on("data", (chunk) => { stderr += String(chunk); });
      childProcess.once("error", reject);
      childProcess.once("exit", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { providerID: "llamacpp", modelID: "qwen3.5-9b-coder" });
    assert.deepEqual(broker.requests.map((request) => request.path), ["/lease"]);
  } finally {
    await broker.close();
  }
}));

test("local child tools suspend the watchdog, then rearm and fail over once", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    const http = createRequire(import.meta.url)("node:http");
    const requests = [];
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.end = (payload = "") => {
        requests.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/lease"
          ? { target: { id: "local-qwen", kind: "local", model: { providerID: "llamacpp", id: "qwen" } } }
          : options.path === "/failure" ? { kind: "overload", circuitUntil: circuitUntil = Date.now() + 5000 } : {};
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      request.destroy = () => {};
      request.setTimeout = () => {};
      request.on = EventEmitter.prototype.on;
      return request;
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const { writeSessionProfile } = await import(${JSON.stringify(routingUrl)});
    const timers = [];
    const aborts = [];
    const prompts = [];
    let circuitUntil = null;
    const session = { id: "local-child", parentID: "parent", agent: "scout" };
    writeSessionProfile(session.id, "local", { explicit: true });
    const hooks = await ModelRouter({ client: { session: {
      get: async () => session,
      messages: async () => ({ data: [] }),
      abort: async (request) => { aborts.push(request); },
      prompt: async (request) => { prompts.push(request); },
    } }, directory: process.env.HOME }, {
      localChildInactivityWatchdogMs: 123,
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cleared = true; },
    });
    await hooks["chat.message"]({ sessionID: session.id, agent: session.agent }, { message: {}, parts: [] });
    await hooks["tool.execute.before"]({ sessionID: session.id, tool: "read" }, { args: {} });
    await hooks["tool.execute.before"]({ sessionID: session.id, tool: "read" }, { args: {} });
    await timers[0].callback();
    await hooks["tool.execute.after"]({ sessionID: session.id });
    const timersBeforeLastTool = timers.length;
    await hooks["tool.execute.after"]({ sessionID: session.id });
    await timers[1].callback();
    await timers[2].callback();
    process.stdout.write(JSON.stringify({ timers, timersBeforeLastTool, circuitUntil, aborts, prompts, requests }));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.timers.length, 3);
  assert.equal(result.timers[0].delay, 123);
  assert.equal(result.timers[0].unrefCalled, true);
  assert.equal(result.timers[0].cleared, true, "a tool suspends the watchdog");
  assert.equal(result.timersBeforeLastTool, 1, "parallel tools keep the watchdog suspended until the last completes");
  assert.equal(result.timers[1].delay, 123, "the final tool completion rearms the watchdog");
  assert.ok(result.timers[2].delay >= 4900 && result.timers[2].delay <= 5001,
    "a local-only route waits for the broker circuit before re-engaging");
  assert.deepEqual(result.aborts, [{ path: { id: "local-child" }, query: { directory: home } }]);
  assert.deepEqual(result.requests.map((request) => request.path), ["/lease", "/failure"]);
  assert.equal(result.requests[1].body.targetID, "local-qwen");
  assert.equal(result.requests[1].body.error.code, "LOCAL_INACTIVITY_TIMEOUT");
  assert.match(result.requests[1].body.error.message, /inactivity watchdog timed out after 123ms/);
  assert.equal(result.requests.some((request) => request.path === "/release"), false);
  assert.equal(result.prompts.length, 1, "a stale watchdog callback cannot re-engage twice");
  assert.equal(result.prompts[0].body.parts[0].synthetic, true, "the existing re-engagement path resumes the child");
}));

test("only local children arm inactivity watchdogs, and idle or deletion clears them", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    const http = createRequire(import.meta.url)("node:http");
    const requests = [];
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        requests.push({ path: options.path, body });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit("data", JSON.stringify(options.path === "/lease" ? { target: { kind: body.sessionID === "cloud-child" ? "cloud" : "local", model: { providerID: "test", id: "model" } } } : {}));
        response.emit("end");
      };
      request.destroy = () => {};
      request.setTimeout = () => {};
      request.on = EventEmitter.prototype.on;
      return request;
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const { writeSessionProfile } = await import(${JSON.stringify(routingUrl)});
    const timers = [];
    const aborts = [];
    const sessions = new Map([
      ["cloud-child", { id: "cloud-child", parentID: "parent", agent: "scout" }],
      ["local-primary", { id: "local-primary", agent: "standard" }],
      ["local-idle", { id: "local-idle", parentID: "parent", agent: "scout" }],
      ["local-deleted", { id: "local-deleted", parentID: "parent", agent: "scout" }],
    ]);
    for (const sessionID of sessions.keys()) writeSessionProfile(sessionID, "local", { explicit: true });
    const hooks = await ModelRouter({ client: { session: {
      get: async ({ path }) => sessions.get(path.id),
      messages: async () => ({ data: [] }),
      abort: async (request) => { aborts.push(request); },
    } }, directory: process.env.HOME }, {
      setTimeout: (callback) => {
        const timer = { callback, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cleared = true; },
    });
    for (const session of sessions.values()) {
      await hooks["chat.message"]({ sessionID: session.id, agent: session.agent }, { message: {}, parts: [] });
    }
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "local-idle" } } });
    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "local-deleted" } } });
    await Promise.all(timers.map((timer) => timer.callback()));
    process.stdout.write(JSON.stringify({ timers, aborts, requests }));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.timers.length, 2);
  assert.equal(result.timers.every((timer) => timer.cleared), true);
  assert.deepEqual(result.aborts, []);
  assert.equal(result.requests.some((request) => request.path === "/release"), false);
}));

test("all four progress events clear and rearm the local-child inactivity watchdog", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    const http = createRequire(import.meta.url)("node:http");
    const requests = [];
    const aborts = [];
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.end = (payload = "") => {
        requests.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/lease"
          ? { target: { id: "local-qwen", kind: "local", model: { providerID: "llamacpp", id: "qwen" } } }
          : options.path === "/failure" ? { kind: "overload", circuitUntil: Date.now() + 5000 } : {};
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      request.destroy = () => {};
      request.setTimeout = () => {};
      request.on = EventEmitter.prototype.on;
      return request;
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const { writeSessionProfile } = await import(${JSON.stringify(routingUrl)});
    const timers = [];
    const session = { id: "watchdog-progress", parentID: "parent", agent: "scout" };
    writeSessionProfile(session.id, "local", { explicit: true });
    const hooks = await ModelRouter({ client: { session: {
      get: async () => session,
      messages: async () => ({ data: [] }),
      abort: async (request) => { aborts.push(request); },
      prompt: async () => {},
    } }, directory: process.env.HOME }, {
      localChildInactivityWatchdogMs: 123,
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; }, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cleared = true; },
    });
    await hooks["chat.message"]({ sessionID: session.id, agent: session.agent }, { message: {}, parts: [] });
    const events = [
      { type: "session.status", properties: { sessionID: session.id, status: { type: "waiting" } } },
      { type: "message.updated", properties: { sessionID: session.id } },
      { type: "message.part.updated", properties: { sessionID: session.id } },
      { type: "message.part.delta", properties: { sessionID: session.id } },
    ];
    for (const event of events) {
      const previous = timers.at(-1);
      await hooks.event({ event });
      assert.equal(previous.cleared, true, event.type + " clears the previous watchdog");
    }
    const progressTimerCount = timers.length;
    for (const timer of timers.slice(0, -1)) await timer.callback();
    const failuresAfterStaleCallbacks = requests.filter((request) => request.path === "/failure").length;
    await timers.at(-1).callback();
    process.stdout.write(JSON.stringify({ timers, progressTimerCount, failuresAfterStaleCallbacks, aborts, requests }));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.progressTimerCount, 5, "the initial watchdog and all four progress resets are armed");
  assert.equal(result.timers.length, 6, "the final failure also schedules re-engagement");
  assert.equal(result.timers.slice(0, 5).every((timer) => timer.cleared), true,
    "every superseded or expired watchdog is cleared");
  assert.equal(result.failuresAfterStaleCallbacks, 0, "stale pre-progress callbacks cannot fail the child");
  assert.deepEqual(result.aborts, [{ path: { id: "watchdog-progress" }, query: { directory: home } }]);
  assert.deepEqual(result.requests.map((request) => request.path), ["/lease", "/failure"]);
  assert.equal(result.requests[1].body.error.code, "LOCAL_INACTIVITY_TIMEOUT");
}));

test("local child compaction preserves unfinished work and continues without release", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    const http = createRequire(import.meta.url)("node:http");
    const requests = [];
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.end = (payload = "") => {
        requests.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit("data", JSON.stringify(options.path === "/lease" ? { target: { kind: "local", model: { providerID: "llamacpp", id: "qwen" } } } : {}));
        response.emit("end");
      };
      request.destroy = () => {};
      request.setTimeout = () => {};
      request.on = EventEmitter.prototype.on;
      return request;
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const { writeSessionProfile } = await import(${JSON.stringify(routingUrl)});
    const session = { id: "compact-child", parentID: "parent", agent: "scout" };
    const aborts = [];
    const timers = [];
    writeSessionProfile(session.id, "local", { explicit: true });
    const hooks = await ModelRouter({ client: { session: {
      get: async () => session,
      messages: async () => ({ data: [] }),
      abort: async (request) => { aborts.push(request); },
    } }, directory: process.env.HOME }, {
      setTimeout: (callback) => { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
      clearTimeout: (timer) => { timer.cleared = true; },
    });
    await hooks["chat.message"]({ sessionID: session.id, agent: session.agent }, { message: {}, parts: [] });
    const compacting = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: session.id }, compacting);
    const first = { enabled: true };
    const second = { enabled: true };
    await hooks["experimental.compaction.autocontinue"]({ sessionID: session.id }, first);
    await hooks["experimental.compaction.autocontinue"]({ sessionID: session.id }, second);
    process.stdout.write(JSON.stringify({ compacting, first, second, timers, aborts, requests }));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.compacting.context.length, 1);
  assert.match(result.compacting.context[0], /unfinished work/);
  assert.equal(result.first.enabled, true);
  assert.equal(result.second.enabled, true);
  assert.equal(result.timers.length, 3, "compaction suspends the watchdog and auto-continue rearms it");
  assert.equal(result.timers[0].cleared, true, "compaction clears the watchdog before the summary can run long");
  assert.deepEqual(result.aborts, []);
  assert.deepEqual(result.requests.map((request) => request.path), ["/lease"]);
}));

test("a brand-new session never seeds stickiness from the agent's pinned model", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const http = createRequire(import.meta.url)("node:http");
    const bodies = [];
    http.request = (options, callback) => {
      const request = new EventEmitter();
      request.end = (payload = "") => {
        bodies.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/lease"
          ? { target: { model: { providerID: "anthropic", id: "claude-opus-5" } } }
          : { changed: false };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      request.destroy = () => {};
      request.setTimeout = () => {};
      request.on = EventEmitter.prototype.on;
      return request;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
    const client = { session: {
      get: async () => ({ id: "ses-brand-new", agent: "smart" }),
      // No completed assistant message anywhere: this session has NO history.
      messages: async () => ({ data: [] }),
    } };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    const output = { message: { model: { providerID: "old", modelID: "old" } }, parts: [] };
    // The input model is the agent's static pin (what a fresh home-screen
    // session carries) -- it must NOT reach the broker as preferredModel.
    await hooks["chat.message"]({ sessionID: "ses-brand-new", agent: "smart", model: { providerID: "openai", id: "gpt-5.6-sol" } }, output);
    const lease = bodies.find((entry) => entry.path === "/lease");
    process.stdout.write(JSON.stringify({ preferredModel: lease?.body?.preferredModel ?? null, contextTokens: lease?.body?.contextTokens, routed: output.message.model }));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.preferredModel, null, "the agent pin must not outrank fit/weights/depletion");
  assert.equal(result.contextTokens, 0, "fresh sessions report zero, keeping local targets leasable");
  assert.deepEqual(result.routed, { providerID: "anthropic", modelID: "claude-opus-5" },
    "the broker's fit-led choice lands on the message");
}));

// The router's messages used to go to console.error, which reaches the TUI ONLY and
// never opencode.log -- so routine telemetry looked like an unexplained on-screen error
// and was unfindable afterwards. These three properties are the ones that break in
// silence: the level split (telemetry off-screen, real errors still on it), no message
// lost when the platform log is absent, and never throwing inside a hook.
test("router messages go to the server log, and only errors also reach stderr", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
  const run = (appSource) => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { createRequire } from "node:module";
      import { EventEmitter } from "node:events";
      const http = createRequire(import.meta.url)("node:http");
      http.request = (options, callback) => {
        const request = new EventEmitter();
        request.end = () => {
          const response = new EventEmitter();
          response.statusCode = 200;
          response.setEncoding = () => {};
          callback(response);
          response.emit("data", JSON.stringify(options.path === "/lease"
            ? { target: { id: "local-qwen", kind: "local", model: { providerID: "llamacpp", id: "qwen" } } }
            : options.path === "/failure" ? { kind: "overload", circuitUntil: Date.now() + 5000 } : {}));
          response.emit("end");
        };
        request.destroy = () => {};
        request.setTimeout = () => {};
        request.on = EventEmitter.prototype.on;
        return request;
      };
      const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
      const { writeSessionProfile } = await import(${JSON.stringify(routingUrl)});
      const logged = [];
      const timers = [];
      const session = { id: "local-child", parentID: "parent", agent: "scout" };
      writeSessionProfile(session.id, "local", { explicit: true });
      const hooks = await ModelRouter({ client: {
        session: {
          get: async () => session,
          messages: async () => ({ data: [] }),
          abort: async () => {},
          prompt: async () => {},
        },
        ${appSource}
      }, directory: process.env.HOME }, {
        localChildInactivityWatchdogMs: 123,
        setTimeout: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
        clearTimeout: () => {},
      });
      await hooks["chat.message"]({ sessionID: session.id, agent: session.agent }, { message: {}, parts: [] });
      await timers[0].callback();
      process.stdout.write(JSON.stringify(logged));
    `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    return { logged: JSON.parse(child.stdout.trim()), stderr: child.stderr };
  };

  const captured = run(`app: { log: (request) => { logged.push(request.body); } },`);
  const warned = captured.logged.filter((entry) => /was inactive for 123ms; failing over/.test(entry.message));
  assert.equal(warned.length, 1, "the watchdog message reaches the platform log exactly once");
  assert.equal(warned[0].service, "opencode-broker", "the log entry is attributable to the router");
  assert.equal(warned[0].level, "warn", "a policy failover is telemetry, not a user-facing error");
  assert.doesNotMatch(captured.stderr, /was inactive for 123ms/,
    "telemetry must NOT be mirrored to the terminal -- that is the noise this replaced");

  // A client without the platform log (or one whose log rejects) must still surface the
  // message rather than dropping it, and must not take the hook down with it.
  const missing = run("");
  assert.equal(missing.logged.length, 0);
  assert.match(missing.stderr, /was inactive for 123ms; failing over/,
    "with no platform log the message falls back to stderr instead of being lost");

  const rejecting = run(`app: { log: () => Promise.reject(new Error("log endpoint down")) },`);
  assert.equal(rejecting.logged.length, 0);
  assert.match(rejecting.stderr, /was inactive for 123ms; failing over/,
    "a rejected log falls back to stderr without throwing inside the hook");
}));

test("every fleet-classifier lane agent keeps its own pin instead of the manual parent's model", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { writeSessionProfile } from ${JSON.stringify(routingUrl)};
    import { ModelRouter } from ${JSON.stringify(pluginUrl)};
    // The user is on Manual with a LOCAL THINKING model. A classifier child must not
    // inherit it: on 2026-09-06 fleet-classifier-haiku was missing from the lane list,
    // ran on llamacpp/qwen3.8-27b, spent its whole output budget on reasoning and
    // returned no SAFE/RISKY text -- three bash commands were denied as a result.
    writeSessionProfile("parent-manual", "manual", { explicit: true });
    const lanes = ["fleet-classifier", "fleet-classifier-qwen", "fleet-classifier-haiku", "fleet-classifier-future"];
    const sessions = { "parent-manual": { id: "parent-manual", agent: "standard", model: { providerID: "llamacpp", id: "qwen3.8-27b" } } };
    for (const agent of lanes) sessions[agent] = { id: agent, parentID: "parent-manual", agent };
    const hooks = await ModelRouter({ client: { session: {
      get: async ({ path }) => sessions[path.id],
      messages: async () => ({ data: [] }),
    } }, directory: process.env.HOME });
    const results = {};
    for (const agent of lanes) {
      const output = { message: { model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } }, parts: [] };
      await hooks["chat.message"]({ sessionID: agent, agent }, output);
      results[agent] = output.message.model;
    }
    process.stdout.write(JSON.stringify(results));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  for (const agent of ["fleet-classifier", "fleet-classifier-qwen", "fleet-classifier-haiku", "fleet-classifier-future"]) {
    assert.deepEqual(result[agent], { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      `${agent} must keep its frontmatter pin, not the manual parent's llamacpp model`);
  }
}));

test("a Manual child inherits the parent's live model, not stale session metadata", async () => withTempHome(async (home) => {
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { writeSessionProfile } from ${JSON.stringify(routingUrl)};
    import { ModelRouter } from ${JSON.stringify(pluginUrl)};
    writeSessionProfile("parent", "manual", { explicit: true });
    const sessions = {
      parent: { id: "parent", agent: "smart", model: { providerID: "anthropic", id: "claude-opus-5" } },
      child: { id: "child", parentID: "parent", agent: "grunt" },
    };
    const hooks = await ModelRouter({ client: { session: {
      get: async ({ path }) => sessions[path.id],
      messages: async () => ({ data: [] }),
    } }, directory: process.env.HOME });

    const parentOutput = { message: { model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "parent", agent: "smart" }, parentOutput);
    await hooks.event({ event: { type: "session.created", properties: { info: sessions.child } } });
    const childOutput = { message: { model: { providerID: "anthropic", modelID: "claude-opus-5" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "child", agent: "grunt" }, childOutput);
    process.stdout.write(JSON.stringify(childOutput.message.model));
  `], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { providerID: "openai", modelID: "gpt-5.6-sol" });
}));
