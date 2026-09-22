import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayHandler, loadGatewayConfig } from "../lib/gateway.js";

const CONFIG = {
  tier: "worker",
  profile: "auto",
  providers: {
    llamacpp: { baseUrl: "http://local.example/v1" },
    "alibaba-token-plan": { baseUrl: "http://plan.example/v1", authRef: "alibaba-token-plan" },
  },
};

const withServer = async (handler, fn) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
};

const authFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ "alibaba-token-plan": { type: "api", key: "sk-sp-test" } }));
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return path;
};

test("config loader validates and applies defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-cfg-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ providers: { llamacpp: { baseUrl: "http://x/v1" } } }));
  const config = loadGatewayConfig(path);
  assert.equal(config.tier, "worker");
  assert.deepEqual(Object.keys(config.providers), ["llamacpp"]);
  assert.deepEqual(config.modelProfiles, {}, "no mapping is the default");
  assert.equal(config.routedModelId, "routed", "the id /v1/models lists for broker-picked routing");
  writeFileSync(path, JSON.stringify({ providers: { llamacpp: { baseUrl: "http://x/v1" } }, routedModelId: "auto-pick" }));
  assert.equal(loadGatewayConfig(path).routedModelId, "auto-pick");
  writeFileSync(path, JSON.stringify({
    providers: { llamacpp: { baseUrl: "http://x/v1" } },
    modelProfiles: {
      plain: "uncensored",
      smart: { profile: "auto", tier: "smart" },
      blankTier: { profile: "auto", tier: "" },
      malformedTier: { profile: "auto", tier: 42 },
      detailed: { profile: "private", maxContextTokens: 39321 },
      patient: { profile: "private", timeoutMs: 60000 },
      // A zero-length timeout is never a deployment's intent; it normalizes away
      // rather than aborting every request on that name instantly.
      zero: { profile: "private", timeoutMs: 0 },
      thinking: { profile: "vision", bodyExtras: { chat_template_kwargs: null } },
      // Only an object is a body; anything else is a typo, not an instruction.
      garbled: { profile: "vision", bodyExtras: "enable_thinking" },
    },
  }));
  const none = {
    tier: null,
    maxContextTokens: null,
    prepareWaitMs: null,
    timeoutMs: null,
    bodyExtras: null,
    waitForLocal: false,
    holdOpenMs: null,
  };
  assert.deepEqual(loadGatewayConfig(path).modelProfiles, {
    plain: { ...none, profile: "uncensored" },
    smart: { ...none, profile: "auto", tier: "smart" },
    blankTier: { ...none, profile: "auto" },
    malformedTier: { ...none, profile: "auto" },
    detailed: { ...none, profile: "private", maxContextTokens: 39321 },
    patient: { ...none, profile: "private", timeoutMs: 60000 },
    zero: { ...none, profile: "private" },
    thinking: { ...none, profile: "vision", bodyExtras: { chat_template_kwargs: null } },
    garbled: { ...none, profile: "vision" },
  }, "both shapes normalize to one");
  writeFileSync(path, JSON.stringify({ providers: { llamacpp: { baseUrl: "http://x/v1" } }, modelProfiles: { broken: { maxContextTokens: 10 } } }));
  // A mapping with no profile is a name the picker offers and the gateway then
  // routes as if it had never been named: refuse to start instead.
  assert.throws(() => loadGatewayConfig(path), /must name a routing profile/);
  writeFileSync(path, JSON.stringify({}));
  assert.throws(() => loadGatewayConfig(path), /no providers/);
  rmSync(dir, { recursive: true, force: true });
});

test("routes a request through a lease, rewrites the model, reports usage", async () => {
  const brokerCalls = [];
  const upstream = [];
  const handler = createGatewayHandler({
    config: CONFIG,
    gatewayKey: "gw-secret",
    authPath: authFile(),
    brokerRequest: async (path, body) => {
      brokerCalls.push({ path, body });
      if (path === "/lease") return { target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } };
      return { ok: true };
    },
    fetchImpl: async (url, options) => {
      upstream.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "whatever-the-client-thinks", messages: [{ role: "user", content: "x" }], stream: false }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "hi");
  });
  assert.equal(upstream[0].url, "http://plan.example/v1/chat/completions");
  assert.equal(upstream[0].body.model, "qwen3.8-flash", "leased model replaces the client's");
  assert.equal(upstream[0].body.stream, undefined, "a non-streaming request forwards no stream key");
  assert.equal(upstream[0].body.stream_options, undefined, "the buffered path never asks for a usage tail frame");
  assert.equal(upstream[0].auth, "Bearer sk-sp-test", "credential from the auth store");
  const lease = brokerCalls.find((call) => call.path === "/lease");
  assert.deepEqual(lease.body.providers, ["llamacpp", "alibaba-token-plan"]);
  assert.ok(brokerCalls.some((call) => call.path === "/usage" && call.body.tokens.input === 10));
  assert.ok(brokerCalls.some((call) => call.path === "/complete"));
});

test("a failing provider is reported and the retry lands elsewhere", async () => {
  const leases = [
    { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } },
    { target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } },
  ];
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: CONFIG,
    gatewayKey: "gw-secret",
    authPath: authFile(),
    brokerRequest: async (path, body) => {
      brokerCalls.push({ path, body });
      if (path === "/lease") return leases.shift();
      return { ok: true };
    },
    fetchImpl: async (url) => url.startsWith("http://local.example")
      ? { ok: false, status: 500, text: async () => "local model exploded", json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "recovered" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "recovered");
  });
  const failure = brokerCalls.find((call) => call.path === "/failure");
  assert.match(failure.body.error.message, /local model exploded/);
});

test("bad gateway keys and unroutable requests fail closed", async () => {
  const handler = createGatewayHandler({
    config: CONFIG,
    gatewayKey: "gw-secret",
    authPath: authFile(),
    brokerRequest: async (path) => { if (path === "/lease") throw new Error("all lightweight routing targets are busy"); return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/v1/models`)).status, 401);
    const denied = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(denied.status, 502);
    assert.match((await denied.json()).error.message, /busy/);
    const models = await fetch(`${base}/v1/models`, { headers: { Authorization: "Bearer gw-secret" } });
    assert.equal(models.status, 200);
  });
});

test("instruct jsonMode strips response_format and appends the raw-JSON instruction", async () => {
  const upstream = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: {
      anthropic: { baseUrl: "http://claude.example/v1", jsonMode: "instruct" },
    } },
    gatewayKey: "gw-secret",
    brokerRequest: async (path) => path === "/lease"
      ? { target: { model: { providerID: "anthropic", id: "claude-haiku-4-5" } } }
      : { ok: true },
    fetchImpl: async (url, options) => {
      upstream.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" } }], usage: {} }) };
    },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ response_format: { type: "json_object" }, messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(upstream[0].response_format, undefined, "response_format stripped");
  assert.match(upstream[0].messages.at(-1).content, /ONLY the raw JSON/);
});

test("dropBodyKeys removes a key the lane refuses, and leaves every other lane alone", async () => {
  // ☠️ Anthropic's compat endpoint 400s on `temperature` and `top_p` together ("Please use only
  // one") while llama.cpp accepts both. Home Assistant's conversation integration always sends
  // both, so without this the cloud lane could never serve it -- and because a 400 scores as a
  // provider fault, every attempt indicted anthropic until its circuit opened, taking haiku away
  // from a local profile's fallback rung and leaving that profile with no lane at all.
  const upstream = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: {
      anthropic: { baseUrl: "http://claude.example/v1", dropBodyKeys: ["top_p"] },
    } },
    gatewayKey: "gw-secret",
    brokerRequest: async (path) => path === "/lease"
      ? { target: { model: { providerID: "anthropic", id: "claude-haiku-4-5" } } }
      : { ok: true },
    fetchImpl: async (url, options) => {
      upstream.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }], usage: {} }) };
    },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ temperature: 0.3, top_p: 0.9, messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(upstream[0].top_p, undefined, "the refused key is gone");
  assert.equal(upstream[0].temperature, 0.3,
    "☠️ DROP, NEVER REWRITE -- the surviving knob keeps the value the client chose");
});

test("a lane without dropBodyKeys forwards the body untouched", async () => {
  const upstream = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: {
      llamacpp: { baseUrl: "http://llama.example/v1" },
    } },
    gatewayKey: "gw-secret",
    brokerRequest: async (path) => path === "/lease"
      ? { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b" } } }
      : { ok: true },
    fetchImpl: async (url, options) => {
      upstream.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }], usage: {} }) };
    },
  });
  await withServer(handler, async (base) => {
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ temperature: 0.3, top_p: 0.9, messages: [{ role: "user", content: "x" }] }),
    });
  });
  assert.equal(upstream[0].top_p, 0.9, "llama.cpp accepts both and must keep both");
  assert.equal(upstream[0].temperature, 0.3);
});

test("an expired credential releases the lease and never indicts the provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-auth-exp-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({
    "alibaba-token-plan": { type: "oauth", access: "tok", expires: Date.now() - 1000 },
  }));
  const leases = [
    { target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } },
    { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } },
  ];
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: CONFIG,
    gatewayKey: "gw-secret",
    authPath: path,
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/lease") return leases.shift();
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "local answered" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "local answered");
  });
  rmSync(dir, { recursive: true, force: true });
  assert.ok(brokerCalls.some((call) => call.route === "/release"), "stale credential releases");
  assert.ok(!brokerCalls.some((call) => call.route === "/failure"), "stale credential never indicts");
  const second = brokerCalls.filter((call) => call.route === "/lease")[1];
  assert.deepEqual(second.body.providers, ["llamacpp"], "retry excludes the stale-credential lane");
});

test("a 200 with an unparseable body indicts the lane and the retry recovers", async () => {
  const leases = [
    { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } },
    { target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } },
  ];
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: CONFIG,
    gatewayKey: "gw-secret",
    authPath: authFile(),
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/lease") return leases.shift();
      return { ok: true };
    },
    fetchImpl: async (url) => url.startsWith("http://local.example")
      ? { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }
      : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "recovered" } }], usage: {} }) },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "recovered");
  });
  const failure = brokerCalls.find((call) => call.route === "/failure");
  assert.match(failure.body.error.message, /unparseable/);
});

test("a request over a provider's maxContextTokens never offers that lane", async () => {
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: {
      llamacpp: { baseUrl: "http://local.example/v1", maxContextTokens: 100 },
      "alibaba-token-plan": { baseUrl: "http://plan.example/v1", authRef: "alibaba-token-plan" },
    } },
    gatewayKey: "gw-secret",
    authPath: authFile(),
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/lease") return { target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } };
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "big served elsewhere" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2000) }] }),
    });
    assert.equal(response.status, 200);
  });
  const lease = brokerCalls.find((call) => call.route === "/lease");
  assert.deepEqual(lease.body.providers, ["alibaba-token-plan"], "capped lane excluded from the allowlist");
});

// ── streaming (SSE) ──────────────────────────────────────────────────────────
// These drive a REAL upstream over a real socket and the real global fetch:
// the streaming path's whole risk lives in byte timing and connection teardown,
// which a fetchImpl stub returning a settled object cannot reproduce.

const startUpstream = (respond) => new Promise((resolve) => {
  const server = createServer((request, response) => { void respond(request, response); });
  // ☆ An assertion that throws skips its close(), and a still-listening fixture
  // then holds the runner open forever: a FAILING test would hang the suite
  // instead of reporting. unref keeps a leaked fixture from being the thing
  // node is waiting for.
  server.unref();
  server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((done) => server.close(done)),
  }));
});

// Emits frames one socket write at a time (a real upstream never delivers them
// as one buffer, and neither must the fixture).
const sseUpstream = (frames, { seen, contentType = "text/event-stream", afterFirst = null, delayMs = 0 } = {}) => startUpstream(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  seen?.push(JSON.parse(body));
  // ☆ The head goes out at once and the first FRAME can be minutes later: that
  // is what a just-swapped local model looks like, and the two waits are
  // governed by different clocks.
  response.writeHead(200, { "Content-Type": contentType });
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  for (const [index, frame] of frames.entries()) {
    response.write(frame);
    if (index === 0 && afterFirst) { await afterFirst(request, response); return; }
  }
  response.end();
});

const CHUNK_HELLO = 'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n';
const CHUNK_LO = 'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n';
const CHUNK_USAGE = 'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n';
const CHUNK_DONE = "data: [DONE]\n\n";

const drain = async (response, onChunk) => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (onChunk) await onChunk(text);
  }
  return text;
};

const streamingHandler = ({ providers, brokerCalls, leases }) => createGatewayHandler({
  config: { tier: "worker", profile: "auto", providers },
  gatewayKey: "gw-secret",
  brokerRequest: async (route, body) => {
    brokerCalls.push({ route, body });
    if (route === "/lease") return leases.shift();
    return { ok: true };
  },
});

const askStream = (base, body) => fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true, ...body }),
});

test("a streaming request is relayed frame by frame, with real usage off the tail chunk", async () => {
  const seen = [];
  const upstream = await sseUpstream([CHUNK_HELLO, CHUNK_LO, CHUNK_USAGE, CHUNK_DONE], { seen });
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base } },
    brokerCalls,
    leases: [{ target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } }],
  });
  let text;
  await withServer(handler, async (base) => {
    const response = await askStream(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    text = await drain(response);
  });
  await upstream.close();
  assert.match(text, /"Hel"/);
  assert.match(text, /"lo"/);
  assert.match(text, /data: \[DONE\]/);
  // The client never asked for the usage tail; it must not be given one.
  assert.doesNotMatch(text, /prompt_tokens/, "the injected usage frame is stripped for a client that did not ask");
  assert.equal(seen[0].stream, true, "stream forwarded, not downgraded");
  assert.equal(seen[0].stream_options.include_usage, true, "usage accounting is injected, not requested");
  const usage = brokerCalls.find((call) => call.route === "/usage");
  assert.deepEqual(usage.body.tokens, { input: 11, output: 7 }, "measured, not estimated");
  assert.equal(usage.body.estimated, undefined);
  assert.ok(brokerCalls.some((call) => call.route === "/complete"));
});

test("a lane configured streamUsage:false is never handed the option, and still accounts", async () => {
  const seen = [];
  const upstream = await sseUpstream([CHUNK_HELLO, CHUNK_LO, CHUNK_DONE], { seen });
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base, streamUsage: false } },
    brokerCalls,
    leases: [{ target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } }],
  });
  await withServer(handler, async (base) => { await drain(await askStream(base)); });
  await upstream.close();
  assert.equal(seen[0].stream_options, undefined, "a lane that would 400 on it is not handed it");
  const usage = brokerCalls.find((call) => call.route === "/usage");
  assert.equal(usage.body.estimated, true);
  assert.ok(usage.body.tokens.output > 0, "opting out of measurement is not opting out of accounting");
});

test("a client that asked for include_usage still gets its tail frame", async () => {
  const upstream = await sseUpstream([CHUNK_HELLO, CHUNK_USAGE, CHUNK_DONE]);
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base } },
    brokerCalls,
    leases: [{ target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } }],
  });
  let text;
  await withServer(handler, async (base) => {
    text = await drain(await askStream(base, { stream_options: { include_usage: true } }));
  });
  await upstream.close();
  assert.match(text, /prompt_tokens/, "a client that configured the tail frame keeps it");
});

test("an upstream that ignores stream_options is accounted by estimate, never as zero", async () => {
  const upstream = await sseUpstream([CHUNK_HELLO, CHUNK_LO, CHUNK_DONE]);
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base } },
    brokerCalls,
    leases: [{ target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } }],
  });
  await withServer(handler, async (base) => { await drain(await askStream(base)); });
  await upstream.close();
  const usage = brokerCalls.find((call) => call.route === "/usage");
  assert.ok(usage, "a stream with no usage frame is still reported");
  assert.equal(usage.body.estimated, true, "flagged as a guess for the ledger");
  assert.ok(usage.body.tokens.input > 0, "prompt tokens were spent and must not report as 0");
  assert.ok(usage.body.tokens.output > 0, "5 chars of content must not report as 0 output");
});

test("an empty usage envelope counts as no measurement, not as zero spend", async () => {
  const upstream = await sseUpstream([CHUNK_HELLO, 'data: {"choices":[],"usage":{}}\n\n', CHUNK_DONE]);
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base } },
    brokerCalls,
    leases: [{ target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } }],
  });
  await withServer(handler, async (base) => { await drain(await askStream(base)); });
  await upstream.close();
  const usage = brokerCalls.find((call) => call.route === "/usage");
  assert.equal(usage.body.estimated, true, "an envelope with nothing in it is not a measurement");
  assert.ok(usage.body.tokens.input > 0 && usage.body.tokens.output > 0);
});

test("a stream that fails before its first frame still fails over to another lane", async () => {
  // llama.cpp's shape for "slot unavailable": HTTP 200, then an error frame.
  const dead = await sseUpstream(['data: {"error":{"message":"slot unavailable","code":500}}\n\n']);
  const alive = await sseUpstream([CHUNK_HELLO, CHUNK_USAGE, CHUNK_DONE]);
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: dead.base }, "alibaba-token-plan": { baseUrl: alive.base } },
    brokerCalls,
    leases: [
      { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } },
      { target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } },
    ],
  });
  let text;
  await withServer(handler, async (base) => { text = await drain(await askStream(base)); });
  await dead.close();
  await alive.close();
  assert.match(text, /"Hel"/, "the second lane's stream reached the client");
  assert.doesNotMatch(text, /slot unavailable/, "with a clean wire the client never learns the first lane existed");
  assert.equal(brokerCalls.filter((call) => call.route === "/lease").length, 2, "a clean wire means failover is still legal");
  assert.match(brokerCalls.find((call) => call.route === "/failure").body.error.message, /slot unavailable/);
});

test("once a frame is relayed the request is married to that lane: error frame, no retry", async () => {
  const upstream = await sseUpstream([CHUNK_HELLO, 'data: {"error":{"message":"context shift failed"}}\n\n']);
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base }, "alibaba-token-plan": { baseUrl: "http://never.example/v1" } },
    brokerCalls,
    leases: [
      { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } },
      { target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } },
    ],
  });
  let text;
  await withServer(handler, async (base) => {
    const response = await askStream(base);
    assert.equal(response.status, 200, "the head was already committed by the first frame");
    text = await drain(response);
  });
  await upstream.close();
  assert.match(text, /"Hel"/, "the client keeps what it was already given");
  assert.match(text, /context shift failed/, "the upstream's own error frame is passed through");
  assert.match(text, /data: \[DONE\]/, "the client is never left waiting for a terminator");
  assert.equal(brokerCalls.filter((call) => call.route === "/lease").length, 1, "no second lease once bytes are on the wire");
  assert.ok(brokerCalls.some((call) => call.route === "/failure"), "the broker still hears it, so circuits still open");
  const usage = brokerCalls.find((call) => call.route === "/usage");
  assert.ok(usage.body.tokens.output > 0, "tokens generated before the failure are still accounted");
});

test("a connection torn mid-stream ends the client's stream with a parseable error and indicts", async () => {
  // Deterministic: the upstream holds the socket open until the TEST's client
  // has actually received frame one, so "relayed" is a fact, not a race.
  let clientGotFirst;
  const relayed = new Promise((resolve) => { clientGotFirst = resolve; });
  const upstream = await sseUpstream([CHUNK_HELLO], {
    afterFirst: async (request) => { await relayed; request.socket.destroy(); },
  });
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base } },
    brokerCalls,
    leases: [{ target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } }],
  });
  let text;
  await withServer(handler, async (base) => {
    const response = await askStream(base);
    text = await drain(response, (soFar) => { if (soFar.includes("Hel")) clientGotFirst(); });
  });
  await upstream.close();
  assert.match(text, /"Hel"/);
  assert.match(text, /"error"/, "an OpenAI-shaped error frame explains the truncation");
  assert.match(text, /gateway: /);
  assert.match(text, /data: \[DONE\]/);
  assert.ok(brokerCalls.some((call) => call.route === "/failure"), "a lane that dies mid-stream is indicted");
  assert.equal(brokerCalls.filter((call) => call.route === "/lease").length, 1, "no retry after the boundary");
});

test("a lane that ignores stream: true is dressed as a stream instead of breaking the client", async () => {
  const upstream = await startUpstream(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "c9", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "whole answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
  });
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base } },
    brokerCalls,
    leases: [{ target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } }],
  });
  let text;
  let contentType;
  await withServer(handler, async (base) => {
    const response = await askStream(base);
    contentType = response.headers.get("content-type");
    text = await drain(response);
  });
  await upstream.close();
  assert.match(contentType, /text\/event-stream/, "the client asked for a stream and gets one");
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /whole answer/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
  const usage = brokerCalls.find((call) => call.route === "/usage");
  assert.deepEqual(usage.body.tokens, { input: 3, output: 2 }, "a buffered body accounts exactly");
  assert.ok(brokerCalls.some((call) => call.route === "/complete"), "a working lane is not indicted for a dialect gap");
});

test("a client that disconnects mid-stream releases the lease and indicts nobody", async () => {
  let clientGotFirst;
  const relayed = new Promise((resolve) => { clientGotFirst = resolve; });
  // Never ends on its own: only the client walking away can finish this stream.
  const upstream = await sseUpstream([CHUNK_HELLO], { afterFirst: () => relayed.then(() => new Promise(() => {})) });
  const brokerCalls = [];
  let sawRelease;
  const released = new Promise((resolve) => { sawRelease = resolve; });
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { llamacpp: { baseUrl: upstream.base } } },
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/release") sawRelease();
      if (route === "/lease") return { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } } };
      return { ok: true };
    },
  });
  await withServer(handler, async (base) => {
    const abort = new AbortController();
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [], stream: true }),
      signal: abort.signal,
    });
    try {
      await drain(response, (soFar) => { if (soFar.includes("Hel")) { clientGotFirst(); abort.abort(); } });
    } catch { /* our own abort */ }
    await released;
  });
  await upstream.close();
  assert.ok(brokerCalls.some((call) => call.route === "/release"), "the client's own abandonment releases the lease");
  assert.ok(!brokerCalls.some((call) => call.route === "/failure"), "and never indicts a healthy lane");
  assert.ok(brokerCalls.some((call) => call.route === "/usage"), "tokens already generated are still accounted");
});

// ── named models -> routing profiles ─────────────────────────────────────────
// A human picking "the uncensored 27b" from a dropdown means it; a background client
// asking for nothing in particular means that too. These prove the two cases
// stay separate.

// The broker's refusal for "I just started the GPU swap": HTTP 400 whose body
// carries a machine-readable code alongside the prose, which opencode-router's
// client copies onto the rejected Error.
const preparingRefusal = () => Object.assign(
  new Error("qwen3.8-27b-uncensored is not resident; preparing it now -- resend the prompt in a moment"),
  { code: "target-preparing" },
);
const finalRefusal = () => Object.assign(
  new Error("no eligible local model is currently deployed, free, or within its context window"),
  { code: "no-eligible-local-target" },
);

const NAMED = "qwen3.8-27b-uncensored";
const namedConfig = (extra = {}) => ({
  tier: "worker",
  profile: "auto",
  providers: { llamacpp: { baseUrl: "http://local.example/v1" } },
  modelProfiles: { [NAMED]: "uncensored" },
  prepareRetryMs: 5,
  prepareWaitMs: 2000,
  ...extra,
});

const askModel = (base, body) => fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "x" }], ...body }),
});

test("a mapped model name leases its profile; every other name leases the tier's", async () => {
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: namedConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/lease") return { target: { model: { providerID: "llamacpp", id: "qwen3.8-27b-uncensored" } } };
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    assert.equal((await askModel(base, { model: NAMED })).status, 200);
    assert.equal((await askModel(base, { model: "whatever-the-client-sends" })).status, 200);
  });
  const [named, unmapped] = brokerCalls.filter((call) => call.route === "/lease");
  assert.equal(named.body.profile, "uncensored", "the name the human picked selects its profile");
  assert.equal(named.body.tier, "worker", "the configured tier still rides along");
  assert.equal(unmapped.body.profile, "auto", "an unmapped name is 0.3.1 exactly: the configured profile");
});

test("a per-model tier overrides the global tier and unmapped names preserve it", async () => {
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: namedConfig({ modelProfiles: { smart: { profile: "auto", tier: "smart" } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/lease") return { target: { model: { providerID: "llamacpp", id: NAMED } } };
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    assert.equal((await askModel(base, { model: "smart" })).status, 200);
    assert.equal((await askModel(base, { model: "unknown-compatible-name" })).status, 200);
  });
  const [mapped, unmapped] = brokerCalls.filter((call) => call.route === "/lease");
  assert.equal(mapped.body.profile, "auto");
  assert.equal(mapped.body.tier, "smart");
  assert.equal(unmapped.body.profile, "auto");
  assert.equal(unmapped.body.tier, "worker");
});

test("a mapped name with no budget of its own still waits", async () => {
  // ☠️ THE REGRESSION GUARD. modelRoute normalizes an absent budget to NULL, and Number(null) is
  // 0 -- so a Number()-based guard reads "declared nothing" as "wait zero seconds" and silently
  // strips the wait from EVERY mapped name. The object shape is the one production uses.
  const answers = [preparingRefusal(), { target: { model: { providerID: "llamacpp", id: NAMED } } }];
  const leases = [];
  const handler = createGatewayHandler({
    config: namedConfig({ modelProfiles: { [NAMED]: { profile: "uncensored" } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => {
      if (route !== "/lease") return { ok: true };
      leases.push(1);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    assert.equal((await askModel(base, { model: NAMED })).status, 200);
  });
  assert.equal(leases.length, 2, "it must retry, not give up on the first refusal");
});

test("prepareWaitMs 0 answers now, with the broker's own refusal", async () => {
  // A wiki lookup is not worth three minutes. The broker cannot tell a swap in progress from a
  // swap its prepareCommand already DECLINED (model-swap's in-use guard exits 0, spawned
  // detached), so a caller that would rather be told now has to say so itself.
  const leases = [];
  const handler = createGatewayHandler({
    config: namedConfig({ modelProfiles: { [NAMED]: { profile: "uncensored", prepareWaitMs: 0 } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => {
      if (route !== "/lease") return { ok: true };
      leases.push(1);
      throw preparingRefusal();
    },
    fetchImpl: async () => { throw new Error("must never forward"); },
  });
  await withServer(handler, async (base) => {
    const response = await askModel(base, { model: NAMED });
    assert.equal(response.status, 502);
    const message = (await response.json()).error.message;
    assert.match(message, /preparing it now/, "the broker's own sentence survives");
    assert.doesNotMatch(message, /the gateway waited/,
      "\u2620 rewriting a zero budget as 'waited 0s' would be both noise and a lie");
  });
  assert.equal(leases.length, 1, "no retries at all");
});

test("an explicit budget is the one reported when it runs out", async () => {
  const handler = createGatewayHandler({
    // Deployment default is 2000; this name asks for half of it.
    config: namedConfig({ modelProfiles: { [NAMED]: { profile: "uncensored", prepareWaitMs: 1000 } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => {
      if (route !== "/lease") return { ok: true };
      throw preparingRefusal();
    },
    fetchImpl: async () => { throw new Error("must never forward"); },
  });
  await withServer(handler, async (base) => {
    const message = (await (await askModel(base, { model: NAMED })).json()).error.message;
    assert.match(message, /the gateway waited 1s/, "its own budget, not the deployment default");
  });
});

test("target-preparing is waited out, and the lease after the swap succeeds", async () => {
  const answers = [preparingRefusal(), preparingRefusal(), { target: { model: { providerID: "llamacpp", id: NAMED } } }];
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: namedConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route !== "/lease") return { ok: true };
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "swapped in" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    const response = await askModel(base, { model: NAMED });
    assert.equal(response.status, 200, "a swap in progress is not an error, it is a wait");
    assert.equal((await response.json()).choices[0].message.content, "swapped in");
  });
  assert.equal(brokerCalls.filter((call) => call.route === "/lease").length, 3, "it kept asking until the model was resident");
});

test("the prepare wait is bounded: it answers rather than hanging forever", async () => {
  let leases = 0;
  const handler = createGatewayHandler({
    config: namedConfig({ prepareWaitMs: 60, prepareRetryMs: 5 }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => { if (route === "/lease") { leases += 1; throw preparingRefusal(); } return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    const started = Date.now();
    const response = await askModel(base, { model: NAMED });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /waited 0s and it is still not resident|not resident/);
    assert.ok(Date.now() - started < 5000, "the bound is a bound");
  });
  assert.ok(leases > 1, "it did retry within the budget");
});

test("an unmapped request never waits for a swap it did not ask for", async () => {
  // ☠️ A background client's contract: an immediate answer, never a three-minute hold.
  let leases = 0;
  const handler = createGatewayHandler({
    config: namedConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => { if (route === "/lease") { leases += 1; throw preparingRefusal(); } return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    const started = Date.now();
    const response = await askModel(base, { model: "something-unmapped" });
    assert.equal(response.status, 502);
    assert.ok(Date.now() - started < 1000, "no wait was taken on its behalf");
  });
  assert.equal(leases, 1, "exactly one lease attempt, exactly as 0.3.1");
});

test("a refusal without the prepare code is final, even for a mapped model", async () => {
  let leases = 0;
  const handler = createGatewayHandler({
    config: namedConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => { if (route === "/lease") { leases += 1; throw finalRefusal(); } return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    const response = await askModel(base, { model: NAMED });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /no eligible local model/);
  });
  assert.equal(leases, 1, "an unrecognised refusal is not retried: waiting would never clear it");
});

test("a code-less refusal is final too, so an older broker client cannot make us hang", async () => {
  let leases = 0;
  const handler = createGatewayHandler({
    config: namedConfig(),
    gatewayKey: "gw-secret",
    // The pre-0.28.0 client discarded everything but the prose -- the same
    // sentence, no code. It must read as final.
    brokerRequest: async (route) => {
      if (route === "/lease") { leases += 1; throw new Error("qwen3.8-27b-uncensored is not resident; preparing it now -- resend the prompt in a moment"); }
      return { ok: true };
    },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    assert.equal((await askModel(base, { model: NAMED })).status, 502);
  });
  assert.equal(leases, 1, "prose is not an API: no code, no wait");
});

test("a mapped model's maxContextTokens replaces the provider ceiling for that request", async () => {
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: namedConfig({
      providers: { llamacpp: { baseUrl: "http://local.example/v1", maxContextTokens: 100 } },
      modelProfiles: { [NAMED]: { profile: "uncensored", maxContextTokens: 5000 } },
    }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/lease") return { target: { model: { providerID: "llamacpp", id: NAMED } } };
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    // ~500 estimated tokens: over the provider's 100, far under the model's 5000.
    assert.equal((await askModel(base, { model: NAMED, messages: [{ role: "user", content: "x".repeat(2000) }] })).status, 200);
    // ~25000 estimated tokens: over the model's own window too.
    const tooBig = await askModel(base, { model: NAMED, messages: [{ role: "user", content: "x".repeat(100000) }] });
    assert.equal(tooBig.status, 502);
  });
  const [fits, doesNot] = brokerCalls.filter((call) => call.route === "/lease");
  assert.deepEqual(fits.body.providers, ["llamacpp"], "the provider ceiling does not apply to a named model");
  assert.equal(doesNot, undefined, "past the model's own ceiling the lane is not offered at all");
});

// A stub that behaves like fetch does: slow, and abortable by the caller's signal.
const slowFetch = (ms) => async (_url, init) => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    init?.signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "TimeoutError"));
    }, { once: true });
  });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) };
};

test("a mapped model's timeoutMs replaces the provider timeout for that request", async () => {
  // The lane is tuned for a caller that would rather be told now. This name is
  // the slow model on the same lane: without its own ceiling the generation is
  // aborted on the way to succeeding.
  const lane = { llamacpp: { baseUrl: "http://local.example/v1", timeoutMs: 30 } };
  const lease = async (route) => (route === "/lease"
    ? { target: { model: { providerID: "llamacpp", id: NAMED } } }
    : { ok: true });
  const patient = createGatewayHandler({
    config: namedConfig({ providers: lane, modelProfiles: { [NAMED]: { profile: "uncensored", timeoutMs: 5000 } } }),
    gatewayKey: "gw-secret",
    brokerRequest: lease,
    fetchImpl: slowFetch(120),
  });
  await withServer(patient, async (base) => {
    assert.equal((await askModel(base, { model: NAMED })).status, 200, "the name's own ceiling governs");
  });

  // Control: the identical request on the identical lane, with the override
  // removed. If this also passed, the test above would be proving nothing.
  const impatient = createGatewayHandler({
    config: namedConfig({ providers: lane, modelProfiles: { [NAMED]: { profile: "uncensored" } } }),
    gatewayKey: "gw-secret",
    brokerRequest: lease,
    fetchImpl: slowFetch(120),
  });
  await withServer(impatient, async (base) => {
    assert.notEqual((await askModel(base, { model: NAMED })).status, 200, "without it, the lane's 30ms still applies");
  });
});

test("a mapped name's bodyExtras layer over the lane's, and null leaves the model its default", async () => {
  // The lane turns thinking off for every local model it serves. One name wants the 27b's
  // own default instead, another wants the lane's, and neither may move the other.
  const upstream = [];
  const handler = createGatewayHandler({
    config: namedConfig({
      providers: { llamacpp: { baseUrl: "http://local.example/v1",
        bodyExtras: { chat_template_kwargs: { enable_thinking: false }, cache_prompt: true } } },
      modelProfiles: {
        "qwen3.8-27b": { profile: "vision", bodyExtras: { chat_template_kwargs: null } },
        "qwen3.8-27b-nothink": { profile: "vision" },
        "qwen3.8-27b-cool": { profile: "vision", bodyExtras: { temperature: 0.1 } },
      },
    }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => (route === "/lease"
      ? { target: { model: { providerID: "llamacpp", id: "qwen3.8-27b" } } }
      : { ok: true }),
    fetchImpl: async (url, options) => {
      upstream.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) };
    },
  });
  await withServer(handler, async (base) => {
    for (const body of [
      { model: "qwen3.8-27b" },
      { model: "qwen3.8-27b", chat_template_kwargs: { enable_thinking: true, custom: 1 } },
      { model: "qwen3.8-27b-nothink" },
      { model: "qwen3.8-27b-cool", temperature: 0.9 },
      { model: "anything-unmapped" },
    ]) assert.equal((await askModel(base, body)).status, 200);
  });
  const [thinking, clientsOwn, nothink, cool, unmapped] = upstream;
  assert.equal("chat_template_kwargs" in thinking, false, "null injects nothing: the model's default stands");
  assert.equal(thinking.cache_prompt, true, "every other lane extra still applies");
  assert.deepEqual(clientsOwn.chat_template_kwargs, { enable_thinking: true, custom: 1 },
    "with the lane's value lifted, the client's own survives untouched");
  assert.deepEqual(nothink.chat_template_kwargs, { enable_thinking: false }, "a name without extras keeps the lane's");
  assert.equal(cool.temperature, 0.1, "a name's value overrides the client's, as the lane's always has");
  assert.deepEqual(cool.chat_template_kwargs, { enable_thinking: false }, "and only the keys it names");
  assert.deepEqual(unmapped.chat_template_kwargs, { enable_thinking: false }, "an unmapped name is untouched");
});

test("routedModelId renames the routed entry in /v1/models", async () => {
  const handler = createGatewayHandler({
    config: namedConfig({ routedModelId: "lab-default", modelProfiles: { [NAMED]: "uncensored" } }),
    gatewayKey: "gw-secret",
    brokerRequest: async () => ({ ok: true }),
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/models`, { headers: { Authorization: "Bearer gw-secret" } });
    assert.deepEqual((await response.json()).data.map((entry) => entry.id), ["lab-default", NAMED]);
  });
});

test("GET /v1/models lists the routed id plus every mapped name", async () => {
  const handler = createGatewayHandler({
    config: namedConfig({ modelProfiles: { [NAMED]: "uncensored", "some-other-name": { profile: "private" } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async () => ({ ok: true }),
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/models`, { headers: { Authorization: "Bearer gw-secret" } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.object, "list");
    assert.deepEqual(payload.data.map((entry) => entry.id), ["routed", NAMED, "some-other-name"]);
    assert.ok(payload.data.every((entry) => entry.object === "model" && entry.owned_by === "opencode-broker"));
    // ☠️ No profile name may leak to a client: it is deployment topology. (The
    // "uncensored" in the model id is the NAME the human picked, not the
    // profile behind it -- "private" is the one that would prove a leak.)
    assert.doesNotMatch(JSON.stringify(payload), /profile|"private"/);
  });
});

test("a streamed request that exhausts its prepare budget answers JSON, never a half-committed stream", async () => {
  const handler = createGatewayHandler({
    config: namedConfig({ prepareWaitMs: 40, prepareRetryMs: 5 }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => { if (route === "/lease") throw preparingRefusal(); return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    const response = await askModel(base, { model: NAMED, stream: true });
    assert.equal(response.status, 502, "nothing was relayed, so the head was still ours to spend");
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.match((await response.json()).error.message, /not resident/);
  });
});

// ── a retry must not be blocked by the attempt it is retrying ────────────────

// A capacity-1 local target: one lease at a time. ☠️ The broker frees a
// session's own slot when it re-leases with `replace: true` -- that is the
// property the gateway now relies on. This fake also drops /release and
// /failure on the floor (settle swallows broker errors, so a hiccup there is
// invisible to the request) which is precisely the state that used to lock a
// request out of its own retry.
const capacityOneBroker = (calls, { settleWorks = false } = {}) => {
  let holder = null;
  return async (route, body) => {
    calls.push({ route, body });
    if (route === "/lease") {
      if (holder === body.sessionID && body.replace) holder = null;
      if (holder) throw Object.assign(
        new Error("no eligible local model is currently deployed, free, or within its context window"),
        { code: "no-eligible-local-target" },
      );
      holder = body.sessionID;
      return { target: { model: { providerID: "llamacpp", id: NAMED } } };
    }
    if (settleWorks && (route === "/release" || route === "/failure") && holder === body.sessionID) holder = null;
    if (!settleWorks) throw new Error("broker hiccup");
    return { ok: true };
  };
};

test("a retry on a capacity-1 target is not blocked by the lease it is retrying", async () => {
  const brokerCalls = [];
  let forwards = 0;
  const handler = createGatewayHandler({
    config: namedConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: capacityOneBroker(brokerCalls),
    fetchImpl: async () => (forwards++ === 0
      ? { ok: false, status: 500, text: async () => "cold model fell over", json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "second try" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    const response = await askModel(base, { model: NAMED });
    assert.equal(response.status, 200, "the single slot was the gateway's own to reuse");
    assert.equal((await response.json()).choices[0].message.content, "second try");
  });
  const leases = brokerCalls.filter((call) => call.route === "/lease");
  assert.equal(leases.length, 2);
  assert.equal(leases[0].body.sessionID, leases[1].body.sessionID, "one session per client request");
  assert.ok(leases.every((call) => call.body.replace === true), "replace is what frees the slot");
});

test("a profile-mapped retry keeps offering its own lane; an unmapped one still drops it", async () => {
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: namedConfig({ providers: {
      llamacpp: { baseUrl: "http://local.example/v1" },
      "alibaba-token-plan": { baseUrl: "http://plan.example/v1" },
    } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/lease") return { target: { model: { providerID: "llamacpp", id: NAMED } } };
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) }),
  });
  await withServer(handler, async (base) => {
    assert.equal((await askModel(base, { model: NAMED })).status, 502);
    assert.equal((await askModel(base, { model: "unmapped" })).status, 502);
  });
  const leases = brokerCalls.filter((call) => call.route === "/lease");
  // ☠️ The profile's lane is the only one that can serve it; dropping it makes
  // the retry a guaranteed refusal that reads as "nothing can serve you".
  assert.ok(leases[1].body.providers.includes("llamacpp"), "a mapped retry keeps its lane");
  assert.ok(!leases[3].body.providers.includes("llamacpp"), "an unmapped retry still moves off the failed lane");
});

test("a request that fails entirely releases the session it was holding", async () => {
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: namedConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: capacityOneBroker(brokerCalls, { settleWorks: true }),
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "always broken", json: async () => ({}) }),
  });
  await withServer(handler, async (base) => {
    assert.equal((await askModel(base, { model: NAMED })).status, 502);
  });
  const sessionID = brokerCalls.find((call) => call.route === "/lease").body.sessionID;
  assert.match(sessionID, /^gw-/);
  assert.ok(brokerCalls.some((call) => call.route === "/release" && call.body.sessionID === sessionID),
    "an abandoned request leaves nothing pinned for the broker's 2h TTL");
});

test("one session id covers the prepare polls and every attempt of a request", async () => {
  const answers = [preparingRefusal(), preparingRefusal(), { target: { model: { providerID: "llamacpp", id: NAMED } } }];
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: namedConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route !== "/lease") return { ok: true };
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    assert.equal((await askModel(base, { model: NAMED })).status, 200);
  });
  const ids = new Set(brokerCalls.map((call) => call.body.sessionID));
  assert.equal(ids.size, 1, "one curl is one row-family in decisions.jsonl, not nineteen");
});

test("the stream window, not the buffered timeout, governs the wait for the first token", async () => {
  // A just-swapped 27b answers its HTTP request at once and produces its first
  // token much later. timeoutMs is 50ms here: if it still governed the first
  // frame, this would be aborted and failed over instead of served.
  const upstream = await sseUpstream([CHUNK_HELLO, CHUNK_USAGE, CHUNK_DONE], { delayMs: 250 });
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base, timeoutMs: 50 } },
    brokerCalls,
    leases: [
      { target: { model: { providerID: "llamacpp", id: NAMED } } },
      { target: { model: { providerID: "llamacpp", id: NAMED } } },
    ],
  });
  let text;
  await withServer(handler, async (base) => {
    const response = await askStream(base);
    assert.equal(response.status, 200);
    text = await drain(response);
  });
  await upstream.close();
  assert.match(text, /"Hel"/, "a cold first token is not a fault");
  assert.equal(brokerCalls.filter((call) => call.route === "/lease").length, 1, "nothing was failed over");
});

const busyRefusal = () => Object.assign(
  new Error("qwen3.5-9b is busy (every slot in use); waiting for a free slot -- resend the prompt in a moment"),
  { code: "target-busy" },
);

test("an unmapped request waits out a busy local slot instead of being dropped", async () => {
  // background ingestion arriving while the cloud lane is rate-limited and the local model is full:
  // 969 of these were refused outright over 2026-09-18..21. A busy slot frees within one job.
  const answers = [busyRefusal(), busyRefusal(), { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b" } } }];
  let leases = 0;
  const handler = createGatewayHandler({
    config: namedConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => {
      if (route !== "/lease") return { ok: true };
      leases += 1;
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ingested" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    const response = await askModel(base, { model: "whatever-the-client-sends" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "ingested");
  });
  assert.equal(leases, 3);
});

test("the busy wait is bounded and says it was busy", async () => {
  const handler = createGatewayHandler({
    config: namedConfig({ prepareWaitMs: 60, prepareRetryMs: 5 }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => { if (route === "/lease") throw busyRefusal(); return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    const started = Date.now();
    const response = await askModel(base, { model: "something-unmapped" });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /still busy; try again shortly/);
    assert.ok(Date.now() - started < 5000);
  });
});

const absentRefusal = () => Object.assign(
  new Error("no eligible local model is currently deployed, free, or within its context window"),
  { code: "no-eligible-local-target" },
);

test("a name with waitForLocal waits for its local model to come back instead of failing", async () => {
  // A memory service's ingestion during a model-server restart: failing here is a lost memory.
  const answers = [absentRefusal(), absentRefusal(), { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b" } } }];
  let leases = 0;
  const handler = createGatewayHandler({
    config: namedConfig({ modelProfiles: { background: { profile: "background", waitForLocal: true } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => {
      if (route !== "/lease") return { ok: true };
      leases += 1;
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "remembered" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    const response = await askModel(base, { model: "background" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "remembered");
  });
  assert.equal(leases, 3);
});

test("without waitForLocal, a missing local model is still reported at once", async () => {
  let leases = 0;
  const handler = createGatewayHandler({
    config: namedConfig({ modelProfiles: { quick: { profile: "quick" } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => { if (route === "/lease") { leases += 1; throw absentRefusal(); } return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    const response = await askModel(base, { model: "quick" });
    assert.equal(response.status, 502);
  });
  assert.equal(leases, 1, "no wait, no re-lease");
});

// ── /v1/responses ────────────────────────────────────────────────────────────
// The Responses API rides the same leasing, extras, failover and accounting as chat. What
// differs: the upstream path, which lanes may serve it, where usage lives, and how a stream ends.

const askResponses = (base, body) => fetch(`${base}/v1/responses`, {
  method: "POST",
  headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
  body: JSON.stringify({ input: "hi", ...body }),
});

const RESP_CREATED = 'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","status":"in_progress","usage":null}}\n\n';
const RESP_DELTA = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n';
const RESP_DONE = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":13,"output_tokens":5,"total_tokens":18}}}\n\n';
const RESP_ERROR = 'event: error\ndata: {"type":"error","code":"server_error","message":"slot died"}\n\n';

test("a /v1/responses request goes to the lane's /responses with its extras, and is accounted", async () => {
  const seen = [];
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: {
      llamacpp: { baseUrl: "http://local.example/v1", responsesApi: true,
        bodyExtras: { chat_template_kwargs: { enable_thinking: false } } },
    } },
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      return route === "/lease" ? { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b" } } } : { ok: true };
    },
    fetchImpl: async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ id: "r1", object: "response", status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 13, output_tokens: 5, total_tokens: 18 } }) };
    },
  });
  let payload;
  await withServer(handler, async (base) => {
    const response = await askResponses(base, { model: "whatever", text: { format: { type: "json_object" } } });
    assert.equal(response.status, 200);
    payload = await response.json();
  });
  assert.equal(seen[0].url, "http://local.example/v1/responses", "the Responses path, not chat");
  assert.equal(seen[0].body.model, "qwen3.5-9b", "model rewritten to the leased one, as for chat");
  assert.deepEqual(seen[0].body.chat_template_kwargs, { enable_thinking: false }, "lane extras apply here too");
  assert.deepEqual(seen[0].body.text, { format: { type: "json_object" } }, "the Responses fields ride through untouched");
  assert.equal(payload.output[0].content[0].text, "ok", "the upstream's payload is the client's, verbatim");
  const usage = brokerCalls.find((call) => call.route === "/usage");
  assert.deepEqual(usage.body.tokens, { input: 13, output: 5 }, "input_tokens/output_tokens are read, not zero");
});

test("only a lane that declares responsesApi is offered a /responses lease", async () => {
  const leases = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: {
      llamacpp: { baseUrl: "http://local.example/v1", responsesApi: true },
      anthropic: { baseUrl: "http://claude.example/v1" },
    } },
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      if (route === "/lease") { leases.push(body); return { target: { model: { providerID: "llamacpp", id: "m" } } }; }
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ output: [], usage: { input_tokens: 1, output_tokens: 1 } }) }),
  });
  await withServer(handler, async (base) => {
    assert.equal((await askResponses(base)).status, 200);
    assert.equal((await askModel(base, {})).status, 200, "chat still offers every lane");
  });
  assert.deepEqual(leases[0].providers, ["llamacpp"], "a lane that would 404 /responses is never offered it");
  assert.deepEqual(leases[1].providers, ["llamacpp", "anthropic"]);

  // With no capable lane there is nothing to lease: say why, and never touch the broker.
  let brokerTouched = false;
  const none = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { anthropic: { baseUrl: "http://claude.example/v1" } } },
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => { if (route === "/lease") brokerTouched = true; return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not forward"); },
  });
  await withServer(none, async (base) => {
    const response = await askResponses(base);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /no configured lane serves \/v1\/responses/);
  });
  assert.equal(brokerTouched, false);
});

test("a streamed /responses request is relayed verbatim, accounted off response.completed, with no [DONE]", async () => {
  const seen = [];
  const upstream = await sseUpstream([RESP_CREATED, RESP_DELTA, RESP_DONE], { seen });
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { llamacpp: { baseUrl: upstream.base, responsesApi: true } },
    brokerCalls,
    leases: [{ target: { model: { providerID: "llamacpp", id: "qwen3.5-9b" } } }],
  });
  let text;
  await withServer(handler, async (base) => {
    const response = await askResponses(base, { stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    text = await drain(response);
  });
  await upstream.close();
  assert.equal(text, RESP_CREATED + RESP_DELTA + RESP_DONE, "typed events pass through byte for byte");
  assert.doesNotMatch(text, /\[DONE\]/, "a Responses stream has no [DONE], and must not be handed one");
  assert.equal(seen[0].stream, true);
  assert.equal(seen[0].stream_options, undefined, "stream_options is a chat option; it is not injected here");
  const usage = brokerCalls.find((call) => call.route === "/usage");
  assert.deepEqual(usage.body.tokens, { input: 13, output: 5 }, "measured off response.completed, not estimated");
  assert.equal(usage.body.estimated, undefined);
});

test("a /responses error event before any output fails over; after output it ends the stream in kind", async () => {
  // Before the first frame: a dead lane, not a dead request -- swallow it and try the next lane.
  const dead = await sseUpstream([RESP_ERROR]);
  const live = await sseUpstream([RESP_CREATED, RESP_DELTA, RESP_DONE]);
  const brokerCalls = [];
  const handler = streamingHandler({
    providers: { dead: { baseUrl: dead.base, responsesApi: true }, live: { baseUrl: live.base, responsesApi: true } },
    brokerCalls,
    leases: [
      { target: { model: { providerID: "dead", id: "m" } } },
      { target: { model: { providerID: "live", id: "m" } } },
    ],
  });
  let text;
  await withServer(handler, async (base) => { text = await drain(await askResponses(base, { stream: true })); });
  await dead.close(); await live.close();
  assert.equal(text, RESP_CREATED + RESP_DELTA + RESP_DONE, "the client never learns the first attempt happened");
  assert.ok(brokerCalls.some((call) => call.route === "/failure"), "the lane that errored is indicted");

  // After output: committed. End with the Responses API's own error event, never a chat
  // error envelope or a [DONE] its parser would choke on.
  const dying = await sseUpstream([RESP_CREATED, RESP_DELTA, RESP_ERROR]);
  const calls = [];
  const committed = streamingHandler({
    providers: { llamacpp: { baseUrl: dying.base, responsesApi: true } },
    brokerCalls: calls,
    leases: [{ target: { model: { providerID: "llamacpp", id: "m" } } }],
  });
  await withServer(committed, async (base) => { text = await drain(await askResponses(base, { stream: true })); });
  await dying.close();
  assert.ok(text.startsWith(RESP_CREATED + RESP_DELTA), "what was relayed stays relayed");
  assert.match(text, /event: error\ndata: \{"type":"error","code":"upstream_error","message":"gateway: slot died"/);
  assert.doesNotMatch(text, /\[DONE\]/);
  assert.ok(calls.some((call) => call.route === "/failure"));
});

test("an unknown path is a 404 that names both endpoints", async () => {
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { llamacpp: { baseUrl: "http://x/v1" } } },
    gatewayKey: "gw-secret", brokerRequest: async () => ({ ok: true }),
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/embeddings`, { method: "POST", headers: { Authorization: "Bearer gw-secret" }, body: "{}" });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error.message, /POST \/v1\/chat\/completions, POST \/v1\/responses/);
  });
});

test("a waitForLocal name also waits out a broker that is restarting", async () => {
  const down = () => new Error("connect ECONNREFUSED /run/user/1000/broker.sock");
  const answers = [down(), down(), { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b" } } }];
  const handler = createGatewayHandler({
    config: namedConfig({ modelProfiles: { background: { profile: "background", waitForLocal: true } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => {
      if (route !== "/lease") return { ok: true };
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "kept" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    const response = await askModel(base, { model: "background" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "kept");
  });
});

test("any other name still fails at once when the broker is unreachable", async () => {
  let leases = 0;
  const handler = createGatewayHandler({
    config: namedConfig({ modelProfiles: { quick: { profile: "quick" } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => { if (route === "/lease") { leases += 1; throw new Error("connect ECONNREFUSED broker.sock"); } return { ok: true }; },
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await withServer(handler, async (base) => {
    assert.equal((await askModel(base, { model: "quick" })).status, 502);
  });
  assert.equal(leases, 1);
});

test("mirrorTextFormat copies a /responses text.format into response_format, and only there", async () => {
  // llama.cpp ignores Responses' text.format but enforces chat's response_format on the same
  // endpoint; without the mirror a strict schema came back as prose.
  const seen = [];
  const make = (providerExtra) => createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: {
      llamacpp: { baseUrl: "http://local.example/v1", responsesApi: true, ...providerExtra },
    } },
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => (route === "/lease" ? { target: { model: { providerID: "llamacpp", id: "m" } } } : { ok: true }),
    fetchImpl: async (url, options) => {
      seen.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
    },
  });
  const schema = { type: "object", properties: { heading: { type: "string" } }, required: ["heading"] };
  await withServer(make({ mirrorTextFormat: true }), async (base) => {
    await askResponses(base, { text: { format: { type: "json_schema", name: "page", strict: true, schema } } });
    await askResponses(base, { text: { format: { type: "json_object" } } });
    await askResponses(base, { text: { format: { type: "text" } } });
    await askResponses(base, { text: { format: { type: "json_object" } }, response_format: { type: "text" } });
    await askModel(base, { response_format: { type: "json_object" } });
  });
  await withServer(make({}), async (base) => {
    await askResponses(base, { text: { format: { type: "json_schema", name: "page", schema } } });
  });
  const [schemaReq, objectReq, textReq, clientsOwn, chatReq, unmarked] = seen;
  assert.deepEqual(schemaReq.response_format, { type: "json_schema", json_schema: { name: "page", schema, strict: true } });
  assert.deepEqual(schemaReq.text.format.schema, schema, "text.format itself is left in place");
  assert.deepEqual(objectReq.response_format, { type: "json_object" });
  assert.equal(textReq.response_format, undefined, "plain text asks for no format");
  assert.deepEqual(clientsOwn.response_format, { type: "text" }, "a client's own response_format is never overwritten");
  assert.deepEqual(chatReq.response_format, { type: "json_object" }, "chat requests are untouched");
  assert.equal(unmarked.response_format, undefined, "a lane without the flag gets exactly what the client sent");
});

test("the broker is told who asked: the client's address and the model name it sent", async () => {
  const brokerCalls = [];
  const handler = createGatewayHandler({
    config: namedConfig({ modelProfiles: { background: { profile: "background" } } }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/lease") return { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b" } } };
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) }),
  });
  await withServer(handler, async (base) => {
    assert.equal((await askModel(base, { model: "background" })).status, 200);
  });
  const lease = brokerCalls.find((call) => call.route === "/lease");
  const usage = brokerCalls.find((call) => call.route === "/usage");
  assert.deepEqual(lease.body.caller, { address: "127.0.0.1", model: "background" });
  assert.deepEqual(usage.body.caller, { address: "127.0.0.1", model: "background" });
  assert.equal(usage.body.sessionID, lease.body.sessionID);
});

// A client that hangs up on silence (Bun's fetch after ~5 minutes) must see bytes while the
// gateway waits for a slot on its behalf, and still get one parseable JSON answer at the end.
const heldHandler = ({ busyFor, extra = {}, entry = {} }) => {
  let refusals = 0;
  return createGatewayHandler({
    config: namedConfig({ modelProfiles: { memory: { profile: "memory", waitForLocal: true, holdOpenMs: 10, ...entry } }, ...extra }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => {
      if (route !== "/lease") return { ok: true };
      if (refusals < busyFor) { refusals += 1; throw busyRefusal(); }
      return { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b" } } };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "remembered" } }], usage: {} }) }),
  });
};

test("holdOpenMs keeps a long buffered wait alive with whitespace, then sends the answer", async () => {
  await withServer(heldHandler({ busyFor: 12 }), async (base) => {
    const response = await askModel(base, { model: "memory" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const text = await response.text();
    assert.match(text, /^ +\{/, "spaces went out while it waited, before the JSON");
    assert.equal(JSON.parse(text).choices[0].message.content, "remembered");
  });
});

test("an answer inside holdOpenMs is sent as before, with no early commit", async () => {
  await withServer(heldHandler({ busyFor: 0, entry: { holdOpenMs: 5000 } }), async (base) => {
    const response = await askModel(base, { model: "memory" });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /^\{/);
    assert.equal(JSON.parse(text).choices[0].message.content, "remembered");
  });
});

test("a failure after the hold commits arrives as the error object under the 200", async () => {
  await withServer(heldHandler({ busyFor: Infinity, entry: { prepareWaitMs: 120 } }), async (base) => {
    const response = await askModel(base, { model: "memory" });
    assert.equal(response.status, 200, "the head was already committed");
    const body = JSON.parse(await response.text());
    assert.match(body.error.message, /busy/);
  });
});

test("a failure before holdOpenMs keeps its real status", async () => {
  await withServer(heldHandler({ busyFor: Infinity, entry: { prepareWaitMs: 0, holdOpenMs: 5000 } }), async (base) => {
    const response = await askModel(base, { model: "memory" });
    assert.equal(response.status, 502);
  });
});

test("a streaming request never takes the hold path", async () => {
  await withServer(heldHandler({ busyFor: Infinity, entry: { prepareWaitMs: 120 } }), async (base) => {
    const response = await askModel(base, { model: "memory", stream: true });
    assert.equal(response.status, 502, "no frame was produced, so the stream owes an ordinary error");
  });
});

// A lane's waiters are served in arrival order. Unfair admission -- every waiter retrying on its
// own timer -- gave a memory service's 3-slot lane a 40-minute worst case against a 55 s median.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lineHandler = ({ modelProfiles, prepareRetryMs, onServe = () => {} }) => {
  const state = { free: 0, served: [], refusals: [] };
  const handler = createGatewayHandler({
    config: namedConfig({ prepareRetryMs, modelProfiles }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route) => {
      if (route !== "/lease") return { ok: true };
      if (state.free > 0) { state.free -= 1; return { target: { model: { providerID: "llamacpp", id: "qwen3.5-9b" } } }; }
      for (const notify of state.refusals.splice(0)) notify();
      throw busyRefusal();
    },
    fetchImpl: async (url, init) => {
      const who = JSON.parse(init.body).messages[0].content;
      state.served.push(who);
      onServe(who, state);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) };
    },
  });
  const nextRefusal = () => new Promise((resolve) => state.refusals.push(resolve));
  return { handler, state, nextRefusal };
};

test("waiters get freed slots in arrival order, and a newcomer does not jump the line", async () => {
  const { handler, state, nextRefusal } = lineHandler({
    prepareRetryMs: 1000,
    modelProfiles: { memory: { profile: "memory", prepareWaitMs: 10000 } },
    // Once the head is served, two more slots free up: they go to B, then C.
    onServe: (who, s) => { if (who === "A") s.free += 2; },
  });
  await withServer(handler, async (base) => {
    const ask = (who) => askModel(base, { model: "memory", messages: [{ role: "user", content: who }] });
    const a = ask("A");
    await nextRefusal();
    const b = ask("B");
    await delay(50);
    // Right after the head's refused retry, a slot frees and C arrives: C must not take it.
    await nextRefusal();
    state.free = 1;
    const c = ask("C");
    const answers = await Promise.all([a, b, c]);
    assert.deepEqual(answers.map((r) => r.status), [200, 200, 200]);
  });
  assert.deepEqual(state.served, ["A", "B", "C"]);
});

test("a waiter that gives up leaves the line, and the next one is still served", async () => {
  const { handler, state, nextRefusal } = lineHandler({
    prepareRetryMs: 20,
    modelProfiles: {
      impatient: { profile: "memory", prepareWaitMs: 150 },
      memory: { profile: "memory", prepareWaitMs: 5000 },
    },
  });
  await withServer(handler, async (base) => {
    const first = askModel(base, { model: "impatient", messages: [{ role: "user", content: "A" }] });
    await nextRefusal();
    const second = askModel(base, { model: "memory", messages: [{ role: "user", content: "B" }] });
    assert.equal((await first).status, 502, "A ran out of budget in line");
    state.free = 1;
    assert.equal((await second).status, 200, "B was not stranded behind A's stale place");
  });
  assert.deepEqual(state.served, ["B"]);
});
