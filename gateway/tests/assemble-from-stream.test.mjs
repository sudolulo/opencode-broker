import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayHandler } from "../lib/gateway.js";

// `assembleFromStream: true` on a provider: a NON-streaming client request is forwarded upstream
// as a STREAMING one and the gateway assembles the chat.completion itself. llama.cpp in router mode
// does not cancel a non-streaming generation when its client hangs up, but it does cancel a
// streaming one -- so this is what makes the gateway's timeout and a client's disconnect actually
// free the slot. These tests drive real sockets: what matters is when a connection closes.

const withServer = async (handler, fn) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A scripted upstream that can answer the SAME reply in both forms, the way llama.cpp does:
// `stream: true` gets the chunks as SSE frames (one socket write each), anything else gets the
// buffered body. `hold` keeps a stream open after its chunks, so only a hang-up can end it.
// `closed` resolves (with the time) when the upstream sees its connection go away.
const scriptedUpstream = ({ chunks = [], buffered = null, raw = null, done = true, hold = false, frameDelayMs = 0 } = {}) => new Promise((resolve) => {
  const seen = [];
  let markClosed;
  const closed = new Promise((ok) => { markClosed = ok; });
  let markStarted;
  const started = new Promise((ok) => { markStarted = ok; });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    seen.push(parsed);
    response.on("close", () => markClosed(Date.now()));
    if (parsed.stream !== true) {
      if (hold) { markStarted(); return; } // a buffered generation that never finishes
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(buffered));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of chunks) {
      response.write(`data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`);
      if (frameDelayMs) await delay(frameDelayMs);
    }
    if (raw) response.write(raw);
    markStarted();
    if (hold) return;
    if (done) response.write("data: [DONE]\n\n");
    response.end();
  });
  // A failing assertion must not leave a listening fixture holding the runner open.
  server.unref();
  server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}/v1`,
    seen,
    closed,
    started,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }),
  }));
});

const LEASE_LOCAL = { leaseID: "l1", target: { model: { providerID: "llamacpp", id: "qwen3.8-27b" } } };
const LEASE_SECOND = { leaseID: "l2", target: { model: { providerID: "second", id: "qwen3.8-flash" } } };

const gateway = ({ providers, leases, brokerCalls = [], logLines = [] }) => createGatewayHandler({
  config: { tier: "worker", profile: "auto", providers },
  gatewayKey: "gw-secret",
  brokerRequest: async (route, body) => {
    brokerCalls.push({ route, body });
    if (route === "/lease") return leases.shift();
    return { ok: true };
  },
  logLine: (line) => logLines.push(line),
});

const ask = (base, body = {}, init = {}) => fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
  body: JSON.stringify({ model: "anything", messages: [{ role: "user", content: "hi" }], ...body }),
  ...init,
});

// One non-streaming request through a gateway whose llamacpp lane has the flag set as given.
const askThrough = async (upstream, assembleFromStream, body = {}) => {
  const brokerCalls = [];
  const handler = gateway({
    providers: { llamacpp: { baseUrl: upstream.base, ...(assembleFromStream ? { assembleFromStream: true } : {}) } },
    leases: [{ ...LEASE_LOCAL }],
    brokerCalls,
  });
  let status;
  let payload;
  await withServer(handler, async (base) => {
    const response = await ask(base, body);
    status = response.status;
    payload = await response.json();
  });
  return { status, payload, brokerCalls };
};

// ── the scripted replies: llama.cpp's chunk shape, and the buffered body it returns for the same
// generation ────────────────────────────────────────────────────────────────────────────────────
const HEAD = { id: "chatcmpl-abc", created: 1760000000, model: "qwen3.8-27b", system_fingerprint: "b11552-23b0202a" };
const chunk = (delta, finishReason = null, extra = {}) => ({
  ...HEAD, object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finishReason, ...extra }],
});
const usageChunk = (usage) => ({ ...HEAD, object: "chat.completion.chunk", choices: [], usage });
const completion = (message, finishReason, usage) => ({
  ...HEAD, object: "chat.completion",
  choices: [{ index: 0, message, finish_reason: finishReason }],
  usage,
});

const SCENARIOS = {
  "plain content": {
    chunks: [
      chunk({ role: "assistant", content: null }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo, " }),
      chunk({ content: "world" }),
      chunk({}, "stop"),
      usageChunk({ prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }),
    ],
    buffered: completion({ role: "assistant", content: "Hello, world" }, "stop",
      { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }),
  },
  "reasoning_content then content": {
    chunks: [
      chunk({ role: "assistant", content: null }),
      chunk({ reasoning_content: "The user" }),
      chunk({ reasoning_content: " wants 42." }),
      chunk({ content: "4" }),
      chunk({ content: "2" }),
      chunk({}, "stop"),
      usageChunk({ prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 }),
    ],
    buffered: completion({ role: "assistant", content: "42", reasoning_content: "The user wants 42." }, "stop",
      { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 }),
  },
  "two tool calls split across many chunks": {
    chunks: [
      chunk({ role: "assistant", content: null }),
      chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"ci" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "ty\":\"Par" } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "{\"tz\"" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "is\"}" } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: ":\"CET\"}" } }] }),
      chunk({}, "tool_calls"),
      usageChunk({ prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 }),
    ],
    buffered: completion({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } },
        { id: "call_b", type: "function", function: { name: "get_time", arguments: "{\"tz\":\"CET\"}" } },
      ],
    }, "tool_calls", { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 }),
  },
  "finish_reason length": {
    chunks: [
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "1, 2, 3" }),
      chunk({ content: ", 4" }, "length"),
      usageChunk({ prompt_tokens: 7, completion_tokens: 16, total_tokens: 23 }),
    ],
    buffered: completion({ role: "assistant", content: "1, 2, 3, 4" }, "length",
      { prompt_tokens: 7, completion_tokens: 16, total_tokens: 23 }),
  },
};

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`assembled from a stream, "${name}" deep-equals the buffered reply`, async () => {
    const upstream = await scriptedUpstream(scenario);
    try {
      const buffered = await askThrough(upstream, false);
      const assembled = await askThrough(upstream, true);
      assert.equal(buffered.status, 200);
      assert.equal(assembled.status, 200);
      assert.deepEqual(buffered.payload, scenario.buffered, "flag off: the buffered body passes through as today");
      assert.deepEqual(assembled.payload, buffered.payload, "flag on: the assembled body is the buffered body");
      assert.equal(upstream.seen[0].stream, undefined, "flag off: the upstream is asked for a buffered reply");
      assert.equal(upstream.seen[0].stream_options, undefined);
      assert.equal(upstream.seen[1].stream, true, "flag on: the upstream is asked to stream");
      assert.deepEqual(upstream.seen[1].stream_options, { include_usage: true });
      // Accounting sees the assembled usage exactly as it would the buffered one.
      const usageOf = (calls) => calls.find((call) => call.route === "/usage")?.body;
      const expected = { input: scenario.buffered.usage.prompt_tokens, output: scenario.buffered.usage.completion_tokens };
      assert.deepEqual(usageOf(assembled.brokerCalls).tokens, expected);
      assert.equal(usageOf(assembled.brokerCalls).estimated, undefined, "measured, not estimated");
      // Every field but the per-request gateway session id.
      const { sessionID: _a, ...assembledUsage } = usageOf(assembled.brokerCalls);
      const { sessionID: _b, ...bufferedUsage } = usageOf(buffered.brokerCalls);
      assert.deepEqual(assembledUsage, bufferedUsage);
      assert.ok(assembled.brokerCalls.some((call) => call.route === "/complete"));
      assert.ok(!assembled.brokerCalls.some((call) => call.route === "/failure"));
    } finally {
      await upstream.close();
    }
  });
}

test("unknown top-level and choice fields keep their first non-null value; logprobs concatenate", async () => {
  const lp = (token) => ({ token, logprob: -0.1, bytes: null, top_logprobs: [] });
  const upstream = await scriptedUpstream({
    chunks: [
      { ...chunk({ role: "assistant", content: "a" }, null, { logprobs: { content: [lp("a")] } }), timings: null },
      { ...chunk({ content: "b" }, null, { logprobs: { content: [lp("b")] } }), timings: { predicted_n: 2 } },
      { ...chunk({}, "stop", { logprobs: null }), timings: { predicted_n: 3 } },
      usageChunk({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }),
    ],
  });
  try {
    const { payload } = await askThrough(upstream, true);
    assert.deepEqual(payload, {
      ...HEAD,
      object: "chat.completion",
      timings: { predicted_n: 2 },
      choices: [{ index: 0, message: { role: "assistant", content: "ab" }, finish_reason: "stop",
        logprobs: { content: [lp("a"), lp("b")] } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  } finally {
    await upstream.close();
  }
});

test("the injected include_usage merges into the client's own stream_options", async () => {
  const upstream = await scriptedUpstream(SCENARIOS["plain content"]);
  try {
    await askThrough(upstream, true, { stream_options: { include_obfuscation: false } });
    assert.deepEqual(upstream.seen[0].stream_options, { include_obfuscation: false, include_usage: true });
  } finally {
    await upstream.close();
  }
});

test("a lane that answers the streamed ask with one JSON body is still served", async () => {
  // Some OpenAI-compatible servers ignore `stream: true`. The body is the answer.
  const upstream = await new Promise((resolve) => {
    const seen = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const piece of request) body += piece;
      seen.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(SCENARIOS["plain content"].buffered));
    });
    server.unref();
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((ok) => server.close(ok)),
    }));
  });
  try {
    const { status, payload } = await askThrough(upstream, true);
    assert.equal(status, 200);
    assert.equal(upstream.seen[0].stream, true);
    assert.deepEqual(payload, SCENARIOS["plain content"].buffered);
  } finally {
    await upstream.close();
  }
});

// ── the regression: a hang-up must reach the model ──────────────────────────────────────────────

test("a client that disconnects mid-generation closes the upstream STREAMING connection within 1 s", async () => {
  // Never finishes on its own: only a hang-up ends this generation. The assertion that the
  // upstream was asked to STREAM is the bug's regression -- llama.cpp's router cancels a streamed
  // generation on disconnect and lets a buffered one run to max_tokens (measured 12 minutes).
  const upstream = await scriptedUpstream({ chunks: [chunk({ role: "assistant", content: "1, 2" })], hold: true });
  const brokerCalls = [];
  const logLines = [];
  let sawRelease;
  const released = new Promise((resolve) => { sawRelease = resolve; });
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { llamacpp: { baseUrl: upstream.base, assembleFromStream: true, timeoutMs: 60_000 } } },
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/release") sawRelease();
      if (route === "/lease") return { ...LEASE_LOCAL };
      return { ok: true };
    },
    logLine: (line) => logLines.push(line),
  });
  try {
    let abortedAt;
    await withServer(handler, async (base) => {
      const abort = new AbortController();
      const pending = ask(base, {}, { signal: abort.signal }).catch(() => null);
      await upstream.started;
      await delay(100); // the gateway is now mid-read of a live stream
      abortedAt = Date.now();
      abort.abort();
      await pending;
      const closedAt = await Promise.race([upstream.closed, delay(1000).then(() => null)]);
      assert.ok(closedAt, "the upstream connection must close within 1 s of the client hanging up");
      assert.ok(closedAt - abortedAt <= 1000, `upstream closed ${closedAt - abortedAt} ms after the hang-up`);
      await released;
    });
    assert.equal(upstream.seen[0].stream, true, "the generation the client abandoned was a STREAMING one");
    assert.ok(!brokerCalls.some((call) => call.route === "/failure"), "a client's hang-up indicts nobody");
    assert.equal(brokerCalls.filter((call) => call.route === "/lease").length, 1, "no retry for a client that left");
  } finally {
    await upstream.close();
  }
});

test("timeoutMs firing mid-generation closes the upstream stream, releases without indicting, and fails over", async () => {
  const stuck = await scriptedUpstream({ chunks: [chunk({ role: "assistant", content: "1, 2" })], hold: true });
  const alive = await scriptedUpstream(SCENARIOS["plain content"]);
  const brokerCalls = [];
  const logLines = [];
  const handler = gateway({
    providers: {
      llamacpp: { baseUrl: stuck.base, assembleFromStream: true, timeoutMs: 300 },
      second: { baseUrl: alive.base, assembleFromStream: true },
    },
    leases: [{ ...LEASE_LOCAL }, { ...LEASE_SECOND }],
    brokerCalls,
    logLines,
  });
  try {
    let status;
    let payload;
    let startedAt;
    await withServer(handler, async (base) => {
      startedAt = Date.now();
      const response = await ask(base);
      status = response.status;
      payload = await response.json();
    });
    const closedAt = await Promise.race([stuck.closed, delay(1000).then(() => null)]);
    assert.ok(closedAt, "the timed-out upstream connection is closed, not left generating");
    assert.ok(closedAt - startedAt < 1300, `closed ${closedAt - startedAt} ms after the request began (timeoutMs 300)`);
    assert.equal(stuck.seen[0].stream, true);
    assert.equal(status, 200);
    assert.deepEqual(payload, SCENARIOS["plain content"].buffered, "the second lane answered");
    assert.equal(brokerCalls.filter((call) => call.route === "/lease").length, 2);
    const failures = brokerCalls.filter((call) => call.route === "/failure");
    assert.deepEqual(failures, [], "our own timeout is impatience, not a provider fault");
    assert.ok(brokerCalls.some((call) => call.route === "/release" && call.body.leaseID === "l1"));
    await delay(20);
    const record = JSON.parse(logLines.at(-1));
    assert.equal(record.event, "attempt_failed");
    assert.equal(record.attempts[0].provider, "llamacpp");
    assert.equal(record.attempts[0].outcome, "timeout");
  } finally {
    await stuck.close();
    await alive.close();
  }
});

// ── a broken stream is a failed attempt, and the wire is still clean ────────────────────────────

const BROKEN = {
  "an error frame": { chunks: [chunk({ role: "assistant", content: "Hel" }), { error: { message: "slot unavailable", code: 500 } }], done: false },
  "a stream that ends without [DONE]": { chunks: [chunk({ role: "assistant", content: "Hel" }), chunk({}, "stop")], done: false },
  "unparseable data": { chunks: [chunk({ role: "assistant", content: "Hel" }), "{not json"] },
};

for (const [name, script] of Object.entries(BROKEN)) {
  test(`${name} is a stream_error that indicts the lane and fails over`, async () => {
    const broken = await scriptedUpstream(script);
    const alive = await scriptedUpstream(SCENARIOS["plain content"]);
    const brokerCalls = [];
    const logLines = [];
    const handler = gateway({
      providers: {
        llamacpp: { baseUrl: broken.base, assembleFromStream: true },
        second: { baseUrl: alive.base },
      },
      leases: [{ ...LEASE_LOCAL }, { ...LEASE_SECOND }],
      brokerCalls,
      logLines,
    });
    try {
      let status;
      let payload;
      await withServer(handler, async (base) => {
        const response = await ask(base);
        status = response.status;
        payload = await response.json();
      });
      assert.equal(status, 200);
      assert.deepEqual(payload, SCENARIOS["plain content"].buffered, "the second lane's answer, nothing of the first");
      assert.equal(brokerCalls.filter((call) => call.route === "/lease").length, 2);
      const failure = brokerCalls.find((call) => call.route === "/failure");
      assert.ok(failure, "a broken stream indicts the lane");
      assert.equal(failure.body.leaseID, "l1");
      assert.equal(brokerCalls.filter((call) => call.route === "/usage").length, 1, "only the answer that was used is accounted");
      await delay(20);
      const record = JSON.parse(logLines.at(-1));
      assert.equal(record.event, "attempt_failed");
      assert.equal(record.attempts[0].outcome, "stream_error");
    } finally {
      await broken.close();
      await alive.close();
    }
  });
}

test("a lane that sends garbage and keeps generating has its connection closed, not left running", async () => {
  const garbage = await scriptedUpstream({ chunks: [chunk({ role: "assistant", content: "Hel" }), "{not json"], hold: true });
  const alive = await scriptedUpstream(SCENARIOS["plain content"]);
  const handler = gateway({
    providers: { llamacpp: { baseUrl: garbage.base, assembleFromStream: true, timeoutMs: 60_000 }, second: { baseUrl: alive.base } },
    leases: [{ ...LEASE_LOCAL }, { ...LEASE_SECOND }],
  });
  try {
    let status;
    await withServer(handler, async (base) => {
      const response = await ask(base);
      status = response.status;
      await response.json();
    });
    assert.equal(status, 200);
    const closedAt = await Promise.race([garbage.closed, delay(1000).then(() => null)]);
    assert.ok(closedAt, "the abandoned stream's connection closes, so its generation is cancelled");
  } finally {
    await garbage.close();
    await alive.close();
  }
});

test("json mode unwraps a fenced answer assembled from a stream exactly as a buffered one", async () => {
  const upstream = await scriptedUpstream({
    chunks: [chunk({ role: "assistant", content: "```json\n{\"a\"" }), chunk({ content: ":1}\n```" }, "stop")],
  });
  try {
    const { payload } = await askThrough(upstream, true, { response_format: { type: "json_object" } });
    assert.equal(payload.choices[0].message.content, "{\"a\":1}");
  } finally {
    await upstream.close();
  }
});

test("a non-2xx from the streamed ask is handled exactly like the buffered path's", async () => {
  const handlerFor = (assembleFromStream, brokerCalls, logLines) => createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { llamacpp: { baseUrl: "http://local.example/v1", assembleFromStream } } },
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/lease") return { ...LEASE_LOCAL };
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "{\"error\":{\"message\":\"loading model\"}}", headers: new Headers() }),
    logLine: (line) => logLines.push(line),
  });
  const run = async (flag) => {
    const brokerCalls = [];
    const logLines = [];
    let status;
    let payload;
    await withServer(handlerFor(flag, brokerCalls, logLines), async (base) => {
      const response = await ask(base);
      status = response.status;
      payload = await response.json();
    });
    await delay(20);
    return { status, payload, brokerCalls, attempts: logLines.map((line) => JSON.parse(line).attempts) };
  };
  const off = await run(false);
  const on = await run(true);
  assert.equal(on.status, 502);
  assert.deepEqual(on.payload, off.payload);
  assert.deepEqual(on.brokerCalls.map((call) => call.route), off.brokerCalls.map((call) => call.route));
  assert.deepEqual(on.attempts, off.attempts);
});

// ── where the flag never applies ────────────────────────────────────────────────────────────────

test("a streaming client request on a flagged lane is relayed as SSE, unchanged", async () => {
  const upstream = await scriptedUpstream(SCENARIOS["plain content"]);
  const handler = gateway({
    providers: { llamacpp: { baseUrl: upstream.base, assembleFromStream: true } },
    leases: [{ ...LEASE_LOCAL }],
  });
  try {
    let contentType;
    let text;
    await withServer(handler, async (base) => {
      const response = await ask(base, { stream: true });
      contentType = response.headers.get("content-type");
      text = await response.text();
    });
    assert.match(contentType, /text\/event-stream/);
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /data: \[DONE\]/);
    assert.doesNotMatch(text, /prompt_tokens/, "the usage tail the client did not ask for is still stripped");
  } finally {
    await upstream.close();
  }
});

test("n > 1 on a flagged lane stays a buffered upstream request", async () => {
  const buffered = { ...SCENARIOS["plain content"].buffered, choices: [
    { index: 0, message: { role: "assistant", content: "a" }, finish_reason: "stop" },
    { index: 1, message: { role: "assistant", content: "b" }, finish_reason: "stop" },
  ] };
  const upstream = await scriptedUpstream({ buffered });
  try {
    const { status, payload } = await askThrough(upstream, true, { n: 2 });
    assert.equal(status, 200);
    assert.equal(upstream.seen[0].stream, undefined);
    assert.equal(upstream.seen[0].stream_options, undefined);
    assert.deepEqual(payload, buffered);
  } finally {
    await upstream.close();
  }
});

test("embeddings on a flagged lane are forwarded exactly as without the flag", async () => {
  const forwarded = [];
  const handler = createGatewayHandler({
    config: {
      tier: "worker", profile: "auto",
      providers: { llamacpp: { baseUrl: "http://local.example/v1", embeddingsApi: true, assembleFromStream: true } },
      modelProfiles: { embedding: { profile: "embedding", tier: "embedding" } },
    },
    gatewayKey: "gw-secret",
    brokerRequest: async (path) => path === "/lease"
      ? { leaseID: "e1", target: { embedding: true, model: { providerID: "llamacpp", id: "qwen3-embedding-0.6b" } } }
      : { ok: true },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.5] }] }) };
    },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embedding", input: "hello" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ embedding: [0.5] }] });
  });
  assert.equal(forwarded.length, 1);
  assert.match(forwarded[0].url, /\/embeddings$/);
  assert.deepEqual(forwarded[0].body, { model: "qwen3-embedding-0.6b", input: "hello" });
});

test("a /v1/responses request on a flagged lane stays a buffered upstream request", async () => {
  const forwarded = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { llamacpp: { baseUrl: "http://local.example/v1", responsesApi: true, assembleFromStream: true } } },
    gatewayKey: "gw-secret",
    brokerRequest: async (path) => path === "/lease" ? { ...LEASE_LOCAL } : { ok: true },
    fetchImpl: async (url, options) => {
      forwarded.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ id: "resp_1", object: "response", output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
    },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "anything", input: "hi" }),
    });
    assert.equal(response.status, 200);
    await response.json();
  });
  assert.equal(forwarded[0].body.stream, undefined);
  assert.equal(forwarded[0].body.stream_options, undefined);
});
