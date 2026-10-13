import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGatewayHandler } from "../gateway/lib/gateway.js";
import { classifyRoutingFailure, quotaRenewalAt } from "../lib/routing.js";

const RESET_AT = "2099-10-09T08:20:00.000Z";
const PRIVATE_UPSTREAM_DETAIL = "private upstream diagnostic must never escape";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const brokerScript = join(repoRoot, "bin/opencode-broker");
const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;

const withServer = async (handler, run) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

const brokerRequest = (socketPath, path, body) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const request = http.request({ socketPath, path, method: "POST", headers: {
    "content-type": "application/json", "content-length": Buffer.byteLength(payload),
  } }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => {
      const parsed = text ? JSON.parse(text) : {};
      if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
      else reject(new Error(parsed.error ?? `broker HTTP ${response.statusCode}`));
    });
  });
  request.on("error", reject);
  request.end(payload);
});

const withBroker = async (run) => {
  const home = mkdtempSync(join(tmpdir(), "bound-usage-broker-"));
  const routing = join(home, ".local/share/opencode/model-routing");
  const socketPath = join(routing, "broker.sock");
  mkdirSync(routing, { recursive: true });
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  writeFileSync(join(routing, "resolvable-models.json"), JSON.stringify({ updatedAt: Date.now(), models: [
    "anthropic/claude-opus-5-fast", "anthropic/claude-opus-4-8-fast", "openai/gpt-5.6-terra",
  ] }));
  const child = spawn(process.execPath, [brokerScript, "serve"], { cwd: repoRoot, env: {
    ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath,
    OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
  }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening on ")) resolve(); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`broker exited before listen (${code})`)));
  });
  try { return await run(socketPath, home); }
  finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
};

const inventory = (home) => {
  const authPath = join(home, ".local/share/opencode/auth.json");
  const auth = readFileSync(authPath);
  const stat = statSync(authPath);
  return {
    connected: ["anthropic", "openai"],
    providers: {
      anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 2 },
      openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    },
    modelContexts: { "anthropic/claude-opus-5-fast": 1000, "anthropic/claude-opus-4-8-fast": 1000, "openai/gpt-5.6-terra": 1000 },
    authRevision: `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(auth).digest("hex")}`,
    configFingerprint: createHash("sha256").update(readFileSync(configPath)).digest("hex"),
  };
};

const boundGatewayEnvelope = async ({ headers, body, path = "/v1/messages" } = {}) => {
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { anthropic: { baseUrl: "http://anthropic.example/v1", messagesApi: true } } },
    gatewayKey: "gateway-test-key",
    brokerRequest: async (requestPath) => requestPath === "/lease/verify"
      ? { held: true, leaseID: "lease-bound-1", target: { model: { providerID: "anthropic", id: "claude-opus-5-fast" } } }
      : (() => { throw new Error(`unexpected gateway broker call ${requestPath}`); })(),
    fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers(headers), text: async () => body }),
  });
  return withServer(handler, async (base) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: {
      Authorization: "Bearer gateway-test-key", "Content-Type": "application/json",
      "x-opencode-session-id": "ses-bound-quota", "x-opencode-lease-id": "lease-bound-1",
    }, body: JSON.stringify({ model: "claude-opus-5-fast", max_tokens: 16, input: "ping", messages: [{ role: "user", content: "ping" }] }) });
    const payload = await response.json();
    return { response, payload, envelope: { name: "APIError", data: { message: `Bad Gateway: ${JSON.stringify(payload)}`, statusCode: 502 } } };
  });
};

// This fails if gateway final-error handling again turns a real bound upstream quota
// response into the broker's own no-provider refusal.
test("a verified bound Anthropic quota preserves a safe quota signal for its owning session", async () => {
  const brokerCalls = [];
  const forwards = [];
  const handler = createGatewayHandler({
    config: {
      tier: "worker",
      profile: "auto",
      providers: { anthropic: { baseUrl: "http://anthropic.example/v1", messagesApi: true } },
    },
    gatewayKey: "gateway-test-key",
    brokerRequest: async (path, body) => {
      brokerCalls.push({ path, body });
      if (path === "/lease/verify") {
        return {
          held: true,
          leaseID: "lease-bound-1",
          target: { model: { providerID: "anthropic", id: "claude-opus-5-5" } },
        };
      }
      if (path === "/lease") throw new Error("a bound request must not create a gateway lease");
      return { ok: true };
    },
    fetchImpl: async (url, init) => {
      forwards.push({ url, body: JSON.parse(init.body) });
      return {
        ok: false,
        status: 429,
        headers: new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": String(Date.parse(RESET_AT) / 1000),
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        }),
        text: async () => JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL },
        }),
      };
    },
  });

  const response = await withServer(handler, async (base) => fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: "Bearer gateway-test-key",
      "Content-Type": "application/json",
      "x-opencode-session-id": "ses-bound-quota",
      "x-opencode-lease-id": "lease-bound-1",
    },
    body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "ping" }] }),
  }));
  const payload = await response.json();
  const message = payload.error.message;
  const sdkEnvelope = { name: "APIError", data: { message: `Bad Gateway: ${JSON.stringify(payload)}`, statusCode: 502 } };

  assert.equal(response.status, 502);
  assert.equal(payload.error.type, "upstream_error");
  assert.equal(forwards.length, 1, "the bound request has exactly one upstream attempt");
  assert.match(forwards[0].url, /\/messages$/, "the gateway preserves the requested protocol");
  assert.deepEqual(brokerCalls.map(({ path }) => path), ["/lease/verify"],
    "the external lease owner alone reports failure, usage, completion, or release");
  assert.match(message, /^upstream anthropic HTTP 429: usage limit reached \(5-hour limit; resets at 2099-10-09T08:20:00\.000Z\)$/);
  assert.doesNotMatch(message, /gateway: no provider could serve the request|usage limit reached -- |private upstream/i);
  assert.equal(classifyRoutingFailure(sdkEnvelope, { targetProviderID: "anthropic" }), "quota");
  assert.equal(quotaRenewalAt(sdkEnvelope, Date.parse("2099-10-09T03:22:00Z")), Date.parse(RESET_AT));
});

test("a gateway-produced bound quota opens an exact provider circuit and fresh leases avoid Anthropic", async () => {
  const { envelope } = await boundGatewayEnvelope({
    headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Date.parse(RESET_AT) / 1000), "anthropic-ratelimit-unified-representative-claim": "five_hour" },
    body: JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL } }),
  });
  await withBroker(async (socketPath, home) => {
    await brokerRequest(socketPath, "/inventory", inventory(home));
    const first = await brokerRequest(socketPath, "/lease", { sessionID: "ses-bound-quota", profile: "auto", tier: "fast-build", replace: true, preferredModel: { providerID: "anthropic", id: "claude-opus-5-fast" } });
    assert.equal(first.target.model.providerID, "anthropic");
    const failure = await brokerRequest(socketPath, "/failure", { sessionID: "ses-bound-quota", leaseID: first.leaseID, targetID: first.target.id, error: envelope });
    assert.equal(failure.kind, "quota");
    assert.equal(failure.circuitUntil, Date.parse(RESET_AT));
    const status = await brokerRequest(socketPath, "/status", {});
    assert.deepEqual(
      { kind: status.circuits["provider:anthropic"].kind, until: status.circuits["provider:anthropic"].until, renewsAt: status.circuits["provider:anthropic"].renewsAt, resetKnown: status.circuits["provider:anthropic"].resetKnown },
      { kind: "quota", until: Date.parse(RESET_AT), renewsAt: RESET_AT, resetKnown: true },
    );
    assert.equal(status.leases["ses-bound-quota"], undefined, "the failed session releases its old lease");
    const continued = await brokerRequest(socketPath, "/lease", { sessionID: "ses-bound-quota", profile: "auto", tier: "fast-build", replace: true });
    const sibling = await brokerRequest(socketPath, "/lease", { sessionID: "ses-bound-quota-sibling", profile: "auto", tier: "fast-build", replace: true });
    assert.equal(continued.target.model.providerID, "openai", "the failed session gets a fresh non-Anthropic lease");
    assert.equal(sibling.target.model.providerID, "openai", "a fresh sibling also avoids every Anthropic target");
  });
});

test("the plugin derives quota from a gateway-produced envelope and schedules one short own-agent continuation", async () => {
  const { envelope } = await boundGatewayEnvelope({
    headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Date.parse(RESET_AT) / 1000), "anthropic-ratelimit-unified-representative-claim": "five_hour" },
    body: JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL } }),
  });
  const home = mkdtempSync(join(tmpdir(), "bound-usage-plugin-"));
  const script = `
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import http from "node:http";
    import { ModelRouter } from ${JSON.stringify(new URL("../plugin/router.js", import.meta.url).href)};
    import { classifyRoutingFailure } from ${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)};
    const envelope = ${JSON.stringify(envelope)};
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ anthropic: { type: "oauth" }, openai: { type: "oauth" } }));
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), "{}");
    http.request = (options, callback) => { const req = new EventEmitter(); req.end = (payload = "") => {
      const body = payload ? JSON.parse(payload) : {}; const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {}; callback(response);
      const reply = options.path === "/lease" ? { leaseID: "lease-anthropic", target: { id: "claude-opus-5-fast", model: { providerID: "anthropic", id: "claude-opus-5-fast" } }, decision: { policy: "test", reasons: [] } }
        : options.path === "/failure" ? { ok: true, kind: classifyRoutingFailure(body.error, { targetProviderID: "anthropic" }), circuitUntil: ${Date.parse(RESET_AT)} }
        : { ok: true }; response.emit("data", JSON.stringify(reply)); response.emit("end"); }; req.destroy = () => {}; req.setTimeout = () => {}; return req; };
    const timers = [], prompts = [], calls = [];
    const client = { provider: { list: async () => ({ data: { connected: ["anthropic", "openai"], all: [{ id: "anthropic", models: {} }, { id: "openai", models: {} }] } }) }, session: {
      get: async () => ({ id: "ses-plugin-bound", agent: "sp-implementer" }), messages: async () => ({ data: [] }), abort: async () => ({ data: true }), prompt: async (input) => { prompts.push(input); return { data: true }; },
    } };
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, { setTimeout: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; }, clearTimeout: () => {} });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-plugin-bound", agent: "sp-implementer" } } } });
    await hooks["chat.message"]({ sessionID: "ses-plugin-bound", agent: "sp-implementer" }, { message: { model: {} }, parts: [{ type: "text", text: "work" }] });
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "ses-plugin-bound", error: envelope } } });
    const continuations = timers.filter((timer) => timer.delay === 2500); for (const timer of continuations) await timer.fn();
    console.log(JSON.stringify({ continuations: continuations.length, delays: timers.map((timer) => timer.delay), prompt: prompts[0]?.body }));
  `;
  const child = await new Promise((resolve) => {
    const childProcess = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; childProcess.stdout.on("data", (chunk) => { stdout += chunk; }); childProcess.stderr.on("data", (chunk) => { stderr += chunk; }); childProcess.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.continuations, 1, "the real classifier result schedules exactly one failover continuation");
    assert.deepEqual(result.delays, [2500], "quota failover is not the 60-second parked-session poll");
    assert.equal(result.prompt.agent, "sp-implementer");
    assert.equal(result.prompt.parts[0].synthetic, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bound gateway 429 edge signals stay safely classified without inventing provider reset facts", async () => {
  const cases = [
    ["ordinary gateway refusal", {}, JSON.stringify({ error: { type: "error", message: PRIVATE_UPSTREAM_DETAIL } }), "noop", null],
    ["burst 429", {}, JSON.stringify({ error: { type: "rate_limit_error", message: "too many requests" } }), "noop", null],
    ["fast credits", {}, JSON.stringify({ error: { type: "rate_limit_error", message: "usage credits are required for fast mode" } }), "model", null],
    ["missing reset", { "anthropic-ratelimit-unified-status": "rejected" }, JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL } }), "quota", null],
    ["invalid reset and unknown window", { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": "not-a-date", "anthropic-ratelimit-unified-representative-claim": "private_window" }, JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL } }), "quota", null],
    ["past reset", { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": "1", "anthropic-ratelimit-unified-representative-claim": "private_window" }, JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL } }), "quota", null],
  ];
  for (const [label, headers, body, kind, renewal] of cases) {
    const { payload, envelope } = await boundGatewayEnvelope({ headers, body, path: label === "fast credits" ? "/v1/responses" : "/v1/messages" });
    assert.equal(classifyRoutingFailure(envelope, { targetProviderID: "anthropic" }), kind, label);
    assert.equal(quotaRenewalAt(envelope, Date.parse("2099-10-09T03:22:00Z")), renewal, label);
    assert.doesNotMatch(payload.error.message, /private upstream|private_window|not-a-date/i, label);
    assert.doesNotMatch(payload.error.message, /resets at (?!2099-)/, label);
  }
});

test("bound gateway quota rejects unusable numeric reset values without losing its quota signal", async () => {
  const cases = [
    ["oversized finite epoch", { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": "1e100" }, JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL } }), "1e100"],
    ["huge relative seconds", { "anthropic-ratelimit-unified-status": "rejected" }, JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL, resets_in_seconds: Number.MAX_VALUE } }), String(Number.MAX_VALUE)],
    ["infinite epoch multiplication", { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Number.MAX_VALUE * 2) }, JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL } }), "Infinity"],
    ["huge retry-after", { "anthropic-ratelimit-unified-status": "rejected", "retry-after": String(Number.MAX_VALUE) }, JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL } }), String(Number.MAX_VALUE)],
  ];
  for (const [label, headers, body, privateNumericValue] of cases) {
    const { response, payload, envelope } = await boundGatewayEnvelope({ headers, body });
    assert.equal(response.status, 502, label);
    assert.equal(payload.error.type, "upstream_error", label);
    assert.equal(classifyRoutingFailure(envelope, { targetProviderID: "anthropic" }), "quota", label);
    assert.doesNotMatch(payload.error.message, /resets at|private upstream/i, label);
    assert.doesNotMatch(payload.error.message, new RegExp(privateNumericValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), label);
  }
});

test("a gateway-owned quota settles once while its summary remains noop to external consumers", async () => {
  const brokerCalls = [];
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { anthropic: { baseUrl: "http://anthropic.example/v1", messagesApi: true } } },
    gatewayKey: "gateway-test-key",
    brokerRequest: async (path, body) => {
      brokerCalls.push({ path, body });
      if (path === "/lease") return { leaseID: "gateway-lease-1", target: { model: { providerID: "anthropic", id: "claude-opus-5-fast" } } };
      if (path === "/failure") return { ok: true };
      throw new Error(`unexpected gateway broker call ${path}`);
    },
    fetchImpl: async () => {
      forwards += 1;
      return { ok: false, status: 429, headers: new Headers({ "anthropic-ratelimit-unified-status": "rejected" }), text: async () => JSON.stringify({ error: { type: "rate_limit_error", message: PRIVATE_UPSTREAM_DETAIL } }) };
    },
  });
  const { response, payload } = await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/messages`, { method: "POST", headers: { Authorization: "Bearer gateway-test-key", "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-fast", max_tokens: 16, messages: [{ role: "user", content: "ping" }] }) });
    return { response, payload: await response.json() };
  });
  assert.equal(response.status, 502);
  assert.equal(forwards, 1);
  assert.equal(brokerCalls.filter(({ path }) => path === "/failure").length, 1, "the gateway reports its owned quota exactly once");
  assert.equal(classifyRoutingFailure({ name: "APIError", data: { message: `Bad Gateway: ${JSON.stringify(payload)}`, statusCode: 502 } }, { targetProviderID: "anthropic" }), "noop");
});

test("a broker-only gateway refusal makes no upstream attempt and stays noop", async () => {
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { anthropic: { baseUrl: "http://anthropic.example/v1", messagesApi: true } } },
    gatewayKey: "gateway-test-key",
    brokerRequest: async (path) => {
      assert.equal(path, "/lease");
      throw new Error("usage limit reached -- all broker targets are fenced");
    },
    fetchImpl: async () => { forwards += 1; throw new Error("must not forward"); },
  });
  const { response, payload } = await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/messages`, { method: "POST", headers: { Authorization: "Bearer gateway-test-key", "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-fast", max_tokens: 16, messages: [{ role: "user", content: "ping" }] }) });
    return { response, payload: await response.json() };
  });
  assert.equal(response.status, 502);
  assert.equal(forwards, 0);
  assert.equal(classifyRoutingFailure({ name: "APIError", data: { message: `Bad Gateway: ${JSON.stringify(payload)}`, statusCode: 502 } }, { targetProviderID: "anthropic" }), "noop");
});
