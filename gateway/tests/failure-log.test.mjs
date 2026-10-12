import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayHandler } from "../lib/gateway.js";

// The per-request failure log: one JSON line on stderr for every request that ends non-2xx or
// is abandoned by its client, and one per upstream attempt that failed before a later one
// succeeded. Never the request body, never a credential.

const SENTINEL = "SENTINEL-PROMPT-TEXT-7f3a";

const withServer = async (handler, fn) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
};

const PROVIDERS = {
  llamacpp: { baseUrl: "http://local.example/v1" },
  "alibaba-token-plan": { baseUrl: "http://plan.example/v1" },
};

const capture = () => {
  const lines = [];
  let notify = () => {};
  return {
    lines,
    logLine: (line) => { lines.push(line); notify(); },
    // Resolves once at least `count` lines have been written; bounded, so a missing line is a
    // failed assertion rather than a hung suite.
    waitFor: (count, ms = 2000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`expected ${count} log line(s) within ${ms}ms, got ${lines.length}`)), ms);
      const check = () => { if (lines.length >= count) { clearTimeout(timer); resolve(); } };
      notify = check;
      check();
    }),
  };
};

const leaseFrom = (leases) => async (path) => {
  if (path === "/lease") return leases.shift();
  return { ok: true };
};

const ask = (base, body, init = {}) => fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
  body: JSON.stringify({ model: "some-label", messages: [{ role: "user", content: SENTINEL }], ...body }),
  ...init,
});

const assertClean = (lines) => {
  for (const line of lines) {
    assert.ok(!line.includes(SENTINEL), `no log line may carry prompt text: ${line}`);
    assert.ok(!line.includes("gw-secret"), `no log line may carry the gateway key: ${line}`);
    assert.ok(!line.includes("\n"), "one record is one line");
  }
};

test("a request whose only provider answers 400 logs exactly one request_failed line", async () => {
  const log = capture();
  const upstreamMessage = `bad parameter\u0007\u001b[31m: ${"x".repeat(600)}`;
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { llamacpp: PROVIDERS.llamacpp } },
    gatewayKey: "gw-secret",
    brokerRequest: leaseFrom([{ leaseID: "l1", target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } }]),
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: upstreamMessage } }),
      headers: new Headers(),
    }),
    logLine: log.logLine,
  });
  let status;
  await withServer(handler, async (base) => {
    const response = await ask(base);
    status = response.status;
    await response.text();
    await log.waitFor(1);
  });
  assert.equal(status, 502);
  assert.equal(log.lines.length, 1, "exactly one line for the whole request");
  assertClean(log.lines);
  const record = JSON.parse(log.lines[0]);
  assert.equal(record.event, "request_failed");
  assert.equal(record.route, "/v1/chat/completions");
  assert.equal(record.label, "some-label");
  assert.equal(record.profile, "auto");
  assert.equal(record.tier, "worker");
  assert.equal(record.caller, "127.0.0.1");
  assert.equal(record.status, 502);
  assert.equal(record.streaming, false);
  assert.equal(typeof record.duration_ms, "number");
  assert.ok(!Number.isNaN(Date.parse(record.ts)) && record.ts.endsWith("Z"), "ts is ISO-8601 UTC");
  assert.equal(record.attempts.length, 1);
  const [attempt] = record.attempts;
  assert.equal(attempt.provider, "llamacpp");
  assert.equal(attempt.model, "qwen3.5-9b-coder");
  assert.equal(attempt.outcome, "http_400");
  assert.ok(attempt.detail.startsWith("bad parameter"), attempt.detail);
  assert.ok(attempt.detail.length <= 300, `detail is truncated to 300 chars, got ${attempt.detail.length}`);
  assert.doesNotMatch(attempt.detail, /[\u0000-\u001f\u007f]/, "control characters are stripped");
});

test("a request that fails on lane 1 and succeeds on lane 2 logs one attempt_failed line and no request_failed", async () => {
  const log = capture();
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: PROVIDERS },
    gatewayKey: "gw-secret",
    brokerRequest: leaseFrom([
      { leaseID: "l1", target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } },
      { leaseID: "l2", target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } },
    ]),
    fetchImpl: async (url) => url.startsWith("http://local.example")
      ? { ok: false, status: 500, text: async () => "local model exploded", headers: new Headers() }
      : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "recovered" } }] }) },
    logLine: log.logLine,
  });
  await withServer(handler, async (base) => {
    const response = await ask(base);
    assert.equal(response.status, 200);
    await response.text();
    await log.waitFor(1);
  });
  assert.equal(log.lines.length, 1);
  assertClean(log.lines);
  const record = JSON.parse(log.lines[0]);
  assert.equal(record.event, "attempt_failed");
  assert.equal(record.status, 200);
  assert.deepEqual(record.attempts.map((a) => [a.provider, a.model, a.outcome]),
    [["llamacpp", "qwen3.5-9b-coder", "http_500"]]);
  assert.match(record.attempts[0].detail, /local model exploded/);
});

test("a clean success logs nothing", async () => {
  const log = capture();
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: PROVIDERS },
    gatewayKey: "gw-secret",
    brokerRequest: leaseFrom([{ leaseID: "l1", target: { model: { providerID: "llamacpp", id: "m" } } }]),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }),
    logLine: log.logLine,
  });
  await withServer(handler, async (base) => {
    const response = await ask(base);
    assert.equal(response.status, 200);
    await response.text();
  });
  // Give a late 'close' listener every chance to fire before asserting silence.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(log.lines, []);
});

test("a client that disconnects mid-request logs client_aborted", async () => {
  const log = capture();
  let forwarded;
  const upstreamCalled = new Promise((resolve) => { forwarded = resolve; });
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { llamacpp: PROVIDERS.llamacpp } },
    gatewayKey: "gw-secret",
    brokerRequest: leaseFrom([{ leaseID: "l1", target: { model: { providerID: "llamacpp", id: "m" } } }]),
    // Never answers: only the client's abort can end this forward.
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      forwarded();
      init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new DOMException("aborted", "AbortError")));
    }),
    logLine: log.logLine,
  });
  await withServer(handler, async (base) => {
    const abort = new AbortController();
    const pending = ask(base, {}, { signal: abort.signal }).catch(() => null);
    await upstreamCalled;
    abort.abort();
    await pending;
    await log.waitFor(1);
  });
  assert.equal(log.lines.length, 1);
  assertClean(log.lines);
  const record = JSON.parse(log.lines[0]);
  assert.equal(record.event, "client_aborted");
  assert.equal(record.route, "/v1/chat/completions");
  assert.equal(record.caller, "127.0.0.1");
});

test("credentials in an upstream error detail are redacted", async () => {
  const log = capture();
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { llamacpp: PROVIDERS.llamacpp } },
    gatewayKey: "gw-secret",
    brokerRequest: leaseFrom([{ leaseID: "l1", target: { model: { providerID: "llamacpp", id: "m" } } }]),
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid credential Bearer abc123 (also tried sk-xyz)",
      headers: new Headers(),
    }),
    logLine: log.logLine,
  });
  await withServer(handler, async (base) => {
    const response = await ask(base);
    assert.equal(response.status, 502);
    await response.text();
    await log.waitFor(1);
  });
  assertClean(log.lines);
  for (const line of log.lines) {
    assert.ok(!line.includes("abc123"), `bearer token leaked: ${line}`);
    assert.ok(!line.includes("sk-xyz"), `sk- key leaked: ${line}`);
  }
  const record = JSON.parse(log.lines[0]);
  assert.equal(record.attempts[0].outcome, "http_401");
  assert.match(record.attempts[0].detail, /\[redacted\]/);
});

test("without an injected sink the record goes to stderr as one JSON line", async () => {
  const written = [];
  const original = process.stderr.write;
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { llamacpp: PROVIDERS.llamacpp } },
    gatewayKey: "gw-secret",
    brokerRequest: async (path) => { if (path === "/lease") throw new Error("all lightweight routing targets are busy"); return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  process.stderr.write = function (chunk, ...rest) {
    if (String(chunk).includes("request_failed")) { written.push(String(chunk)); return true; }
    return original.call(this, chunk, ...rest);
  };
  try {
    await withServer(handler, async (base) => {
      const response = await ask(base);
      assert.equal(response.status, 502);
      await response.text();
      for (let i = 0; i < 50 && !written.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(written.length, 1);
  assert.ok(written[0].endsWith("\n"));
  const record = JSON.parse(written[0]);
  assert.equal(record.event, "request_failed");
  assert.deepEqual(record.attempts, [], "a lease refusal reaches no provider");
  assert.match(record.error, /all lightweight routing targets are busy/, "the final cause is named even with no attempt");
});
