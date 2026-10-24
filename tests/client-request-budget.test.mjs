import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brokerRequest } from "../lib/client.js";

const realSetTimeout = globalThis.setTimeout;
const settleWithin = (promise) => Promise.race([
  promise.then(() => "settled"),
  new Promise((resolve) => realSetTimeout(() => resolve("still pending"), 50)),
]);

const response = (statusCode = 200) => {
  const value = new EventEmitter();
  value.statusCode = statusCode;
  value.setEncoding = () => {};
  return value;
};

const installRequests = (t, handle) => {
  const calls = [];
  t.mock.method(http, "request", (options, callback) => {
    const request = new EventEmitter();
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    request.end = () => handle({ options, callback, request, calls });
    calls.push({ options, request });
    return request;
  });
  return calls;
};

const socketServer = async (t, handle) => {
  const directory = mkdtempSync(join(tmpdir(), "broker-client-budget-"));
  const socketPath = join(directory, "broker.sock");
  const calls = [];
  const sockets = new Set();
  const server = http.createServer((request, reply) => {
    calls.push(request.url);
    request.resume();
    handle(request, reply);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    try {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, calls, sockets };
};

let clientGeneration = 0;
const clientFor = async (socketPath) => {
  const previous = process.env.OPENCODE_MODEL_BROKER_SOCKET;
  process.env.OPENCODE_MODEL_BROKER_SOCKET = socketPath;
  try {
    return await import(`../lib/client.js?requestBudget=${++clientGeneration}`);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MODEL_BROKER_SOCKET;
    else process.env.OPENCODE_MODEL_BROKER_SOCKET = previous;
  }
};

// A natural child exit checks both unhandled stream errors and retained request timers.
const runSocketChild = (socketPath, script, { timeoutMs = 2_000, onStdout = () => {} } = {}) => new Promise((resolve, reject) => {
  const clientUrl = new URL("../lib/client.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import http from "node:http";
    import { brokerRequest } from ${JSON.stringify(clientUrl)};
    ${script}
  `], {
    env: { ...process.env, OPENCODE_MODEL_BROKER_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = realSetTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    onStdout(stdout);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, stdout, stderr, timedOut });
  });
});

test("invalid lease payload exits promptly after synchronous request setup failure", async () => {
  const clientUrl = new URL("../lib/client.js", import.meta.url).href;
  const script = `
    import { brokerRequest } from ${JSON.stringify(clientUrl)};
    try {
      await brokerRequest("/lease", { toJSON: () => undefined });
      process.exitCode = 1;
    } catch (error) {
      if (!(error instanceof TypeError)) process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const result = await Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => realSetTimeout(() => {
      child.kill();
      reject(new Error("invalid payload child retained the request deadline timer"));
    }, 1_500)),
  ]);
  assert.deepEqual(result, { code: 0, signal: null });
});

test("synchronous HTTP request construction clears the lease deadline", async (t) => {
  const expected = new Error("request constructor failed");
  let cleared = 0;
  t.mock.method(globalThis, "setTimeout", () => ({ deadline: true }));
  t.mock.method(globalThis, "clearTimeout", () => { cleared += 1; });
  t.mock.method(http, "request", () => { throw expected; });
  try {
    await assert.rejects(brokerRequest("/lease", {}), (error) => error === expected);
    assert.equal(cleared, 1);
  } finally {
    t.mock.restoreAll();
  }
});

test("default lease retry shares one absolute 32500ms budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = installRequests(t, ({ request, calls }) => {
    if (calls.length === 1) queueMicrotask(() => request.emit("error", new Error("ECONNRESET")));
  });
  try {
    const rejected = assert.rejects(brokerRequest("/lease", {}), /broker timeout/);
    await new Promise(setImmediate);
    t.mock.timers.tick(250);
    await new Promise(setImmediate);
    t.mock.timers.tick(32_250);
    assert.equal(await settleWithin(rejected), "settled");
    assert.equal(calls.length, 2);
  } finally {
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
});

test("default failure deadline cannot be extended by trickling response bytes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = installRequests(t, ({ callback }) => {
    const reply = response();
    callback(reply);
    reply.emit("data", "{");
  });
  try {
    const rejected = assert.rejects(brokerRequest("/failure", {}), /broker timeout/);
    t.mock.timers.tick(32_500);
    assert.equal(await settleWithin(rejected), "settled");
    assert.equal(calls.length, 1);
  } finally {
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
});

test("explicit lease timeout preserves the ordinary per-attempt timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = installRequests(t, ({ request }) => {
    queueMicrotask(() => request.emit("error", new Error("ECONNREFUSED")));
  });
  try {
    const rejected = assert.rejects(brokerRequest("/lease", {}, { timeout: 37 }), /ECONNREFUSED/);
    await new Promise(setImmediate);
    t.mock.timers.tick(250);
    assert.equal(await settleWithin(rejected), "settled");
    assert.deepEqual(calls.map(({ options }) => options.timeout), [37, 37]);
  } finally {
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
});

test("explicit zero timeout reaches lease and ordinary transports without an admission deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = installRequests(t, ({ request }) => {
    queueMicrotask(() => request.emit("error", new Error("ECONNREFUSED")));
  });
  try {
    for (const [path, options] of [["/lease", {}], ["/status", { method: "GET" }]]) {
      const start = calls.length;
      const rejected = assert.rejects(brokerRequest(path, {}, { ...options, timeout: 0 }), /ECONNREFUSED/);
      await new Promise(setImmediate);
      t.mock.timers.tick(250);
      assert.equal(await settleWithin(rejected), "settled");
      assert.deepEqual(calls.slice(start).map(({ options: requestOptions }) => requestOptions.timeout), [0, 0]);
    }
  } finally {
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
});

test("lease admission deadline fences wire I/O after slow payload serialization", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = installRequests(t, () => {});
  const body = {
    toJSON() {
      t.mock.timers.tick(32_501);
      return {};
    },
  };
  try {
    const rejected = assert.rejects(brokerRequest("/lease", body), /broker timeout/);
    assert.equal(await settleWithin(rejected), "settled");
    assert.equal(calls.length, 0);
  } finally {
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
});

test("ordinary routes retain the 2500ms per-attempt timeout and retry gap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = installRequests(t, ({ request }) => {
    queueMicrotask(() => request.emit("error", new Error("ECONNREFUSED")));
  });
  try {
    const rejected = assert.rejects(brokerRequest("/status", {}, { method: "GET" }), /ECONNREFUSED/);
    await new Promise(setImmediate);
    t.mock.timers.tick(250);
    assert.equal(await settleWithin(rejected), "settled");
    assert.deepEqual(calls.map(({ options }) => options.timeout), [2500, 2500]);
  } finally {
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
});

test("HTTP refusals preserve structured errors without retrying", async (t) => {
  const calls = installRequests(t, ({ callback }) => {
    const reply = response(503);
    callback(reply);
    reply.emit("data", JSON.stringify({ error: "target unavailable", code: "target-preparing", targetID: "cloud" }));
    reply.emit("end");
  });
  try {
    await assert.rejects(brokerRequest("/lease", {}), (error) => {
      assert.equal(error.message, "target unavailable");
      assert.equal(error.code, "target-preparing");
      assert.equal(error.targetID, "cloud");
      return true;
    });
    assert.equal(calls.length, 1);
  } finally {
    t.mock.restoreAll();
  }
});

test("real HTTP refusals with transient-looking messages never retry", async (t) => {
  for (const [message, path, options] of [
    ["broker timeout", "/lease", {}],
    ["ECONNREFUSED", "/failure", {}],
    ["ECONNRESET", "/status", { method: "GET" }],
    ["EPIPE", "/lease", { timeout: 0 }],
    ["ENOENT", "/failure", { timeout: 100 }],
  ]) {
    await t.test(message, async (t) => {
      const body = {
        error: message, code: "target-preparing", targetID: "cloud", retryable: true,
        isBrokerHttpError: false, message: "must not replace message", name: "must not replace name",
      };
      const fixture = await socketServer(t, (_request, reply) => {
        reply.writeHead(503, { "content-type": "application/json" });
        reply.end(JSON.stringify(body));
      });
      const client = await clientFor(fixture.socketPath);
      await assert.rejects(client.brokerRequest(path, {}, options), (error) => {
        assert.equal(error.message, message);
        assert.equal(error.name, "Error");
        assert.deepEqual({ ...error }, {
          code: "target-preparing", targetID: "cloud", retryable: true, isBrokerHttpError: false,
        });
        return true;
      });
      assert.deepEqual(fixture.calls, [path], "an HTTP refusal must not create a second wire attempt");
    });
  }
});

test("peer-aborted real responses reject promptly and leave no deadline timer", async (t) => {
  for (const [path, options] of [["/lease", {}], ["/status", { timeout: 0 }]]) {
    await t.test(path, async (t) => {
      let response;
      const fixture = await socketServer(t, (_request, reply) => {
        response = reply;
        reply.writeHead(200, { "content-type": "application/json" });
        reply.write("{");
      });
      const result = await runSocketChild(fixture.socketPath, `
        const request = http.request;
        http.request = (options, callback) => request(options, (response) => {
          // Observe real bytes, without installing an error listener that could mask a crash.
          response.once("data", () => process.stdout.write("partial\\n"));
          callback(response);
        });
        await assert.rejects(brokerRequest(${JSON.stringify(path)}, {}, ${JSON.stringify(options)}), (error) => {
          assert.equal(error.message, "aborted");
          assert.equal(error.code, "ECONNRESET");
          return true;
        });
      `, { onStdout: (text) => { if (text.includes("partial\n")) response.destroy(); } });
      assert.deepEqual(result, { code: 0, signal: null, stdout: "partial\n", stderr: "", timedOut: false });
      assert.deepEqual(fixture.calls, [path]);
      assert.equal(fixture.sockets.size, 0, "the aborted response must not leave an open socket");
    });
  }
});

test("real partial stream hits the shared deadline without process death or orphan requests", { timeout: 5_000 }, async (t) => {
  const fixture = await socketServer(t, (_request, reply) => {
    reply.writeHead(200, { "content-type": "application/json" });
    reply.write("{");
    // Keep resetting the socket inactivity timeout; only the absolute deadline can stop this.
    const timer = setInterval(() => reply.write(" "), 100);
    reply.once("close", () => clearInterval(timer));
  });
  const result = await runSocketChild(fixture.socketPath, `
    const { mock } = await import("node:test");
    // Accelerate only the clock; request, response, socket destruction and child exit are real.
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const request = http.request;
    let chunks = 0;
    let closed;
    const responseClosed = new Promise((resolve) => { closed = resolve; });
    http.request = (options, callback) => request(options, (response) => {
      response.once("close", closed);
      response.on("data", () => {
        chunks += 1;
        if (chunks === 1) mock.timers.tick(16_000);
        if (chunks === 2) mock.timers.tick(16_500);
      });
      callback(response);
    });
    try {
      await assert.rejects(brokerRequest("/failure", {}), { message: "broker timeout" });
      await responseClosed;
      assert.equal(chunks, 2);
    } finally {
      http.request = request;
      mock.timers.reset();
    }
  `, { timeoutMs: 4_000 });
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "");
  assert.deepEqual(fixture.calls, ["/failure"]);
  assert.equal(fixture.sockets.size, 0, "deadline destruction must close the live stream");
});
