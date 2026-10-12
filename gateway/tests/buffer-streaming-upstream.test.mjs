import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayHandler, loadGatewayConfig } from "../lib/gateway.js";

// `bufferStreamingUpstream: true` on a provider: a STREAMING client request is forwarded upstream
// as a BUFFERED one and the gateway dresses the reply as the SSE stream the client asked for. The
// mirror image of `assembleFromStream`. It exists for lanes that refuse to stream at all -- the
// fleet auth proxy's Anthropic chat route answers `stream: true` with a 400 ("stream must be
// false") on purpose, so Home Assistant's always-streaming Assist failed whenever it fell back to
// that lane. These tests drive real sockets, like the assemble-from-stream ones.

const withServer = async (handler, fn) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A buffered-only upstream, the shape of the auth proxy: any `stream` key other than false is a
// 400 with the proxy's own message. `status`/`errorBody` script a refusal; `hold` sends the head
// and the first half of the body and then never finishes, so only a hang-up can end it.
const bufferedUpstream = ({ buffered = null, status = 200, errorBody = null, hold = false } = {}) => new Promise((resolve) => {
  const seen = [];
  let markClosed;
  const closed = new Promise((ok) => { markClosed = ok; });
  let markStarted;
  const started = new Promise((ok) => { markStarted = ok; });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const piece of request) body += piece;
    const parsed = JSON.parse(body);
    seen.push({ url: request.url, body: parsed });
    response.on("close", () => markClosed(Date.now()));
    if ("stream" in parsed && parsed.stream !== false) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "llm-auth-proxy: stream must be false" } }));
      return;
    }
    if (status !== 200) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(errorBody));
      return;
    }
    const text = JSON.stringify(buffered);
    response.writeHead(200, { "Content-Type": "application/json" });
    if (hold) {
      response.write(text.slice(0, Math.floor(text.length / 2)));
      markStarted();
      return;
    }
    response.end(text);
  });
  server.unref();
  server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}/v1`,
    seen,
    closed,
    started,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }),
  }));
});

const LEASE_CLOUD = { leaseID: "l1", target: { model: { providerID: "anthropic", id: "claude-haiku-4-5" } } };
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

const post = (base, path, body, init = {}) => fetch(`${base}${path}`, {
  method: "POST",
  headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
  body: JSON.stringify(body),
  ...init,
});
const askChat = (base, body = {}, init = {}) => post(base, "/v1/chat/completions",
  { model: "anything", messages: [{ role: "user", content: "hi" }], stream: true, ...body }, init);
const askResponses = (base, body = {}, init = {}) => post(base, "/v1/responses",
  { model: "anything", input: "hi", stream: true, ...body }, init);

// Every `data:` payload of an SSE body, in order, plus the `event:` names where present.
const sseEvents = (text) => text.split(/\r?\n\r?\n/).filter((frame) => frame.trim()).map((frame) => {
  const lines = frame.split(/\r?\n/);
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? null;
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  return { event, data };
});

// What an OpenAI client does with a chat stream: concatenate the deltas back into one message.
// Top-level fields keep their first value, like the gateway's own assembler.
const reassembleChat = (events) => {
  const payload = {};
  const choices = new Map();
  for (const { data } of events) {
    if (data === "[DONE]") continue;
    const chunk = JSON.parse(data);
    assert.equal(chunk.object, "chat.completion.chunk");
    for (const [key, value] of Object.entries(chunk)) {
      if (key === "choices" || key === "object") continue;
      if (!(key in payload)) payload[key] = value;
    }
    for (const part of chunk.choices) {
      const choice = choices.get(part.index) ?? { role: null, content: null, reasoning: null, toolCalls: new Map(), finish: null };
      if (part.delta.role) choice.role = part.delta.role;
      if (typeof part.delta.content === "string") choice.content = (choice.content ?? "") + part.delta.content;
      if (typeof part.delta.reasoning_content === "string") choice.reasoning = (choice.reasoning ?? "") + part.delta.reasoning_content;
      for (const call of part.delta.tool_calls ?? []) {
        const entry = choice.toolCalls.get(call.index) ?? { id: null, type: "function", function: { name: null, arguments: "" } };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.function.name = call.function.name;
        if (typeof call.function?.arguments === "string") entry.function.arguments += call.function.arguments;
        choice.toolCalls.set(call.index, entry);
      }
      if (part.finish_reason) choice.finish = part.finish_reason;
      choices.set(part.index, choice);
    }
  }
  payload.object = "chat.completion";
  payload.choices = [...choices.entries()].map(([index, choice]) => {
    const message = { role: choice.role, content: choice.content };
    if (choice.reasoning !== null) message.reasoning_content = choice.reasoning;
    if (choice.toolCalls.size) message.tool_calls = [...choice.toolCalls.values()];
    return { index, message, finish_reason: choice.finish };
  });
  return payload;
};

const HEAD = { id: "chatcmpl-abc", created: 1760000000, model: "claude-haiku-4-5" };
const USAGE = { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 };
const BUFFERED_CHAT = {
  ...HEAD,
  object: "chat.completion",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "Turning on the kitchen light.",
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "HassTurnOn", arguments: "{\"name\":\"kitchen\"}" } },
      ],
    },
    finish_reason: "tool_calls",
  }],
  usage: USAGE,
};
const withoutUsage = ({ usage: _usage, ...rest }) => rest;

const streamThrough = async (providers, body = {}, leases = [{ ...LEASE_CLOUD }]) => {
  const brokerCalls = [];
  const logLines = [];
  const handler = gateway({ providers, leases, brokerCalls, logLines });
  let status;
  let contentType;
  let text;
  await withServer(handler, async (base) => {
    const response = await askChat(base, body);
    status = response.status;
    contentType = response.headers.get("content-type");
    text = await response.text();
  });
  await delay(20);
  return { status, contentType, text, events: sseEvents(text), brokerCalls, logLines };
};

test("a streaming chat request on a flagged lane is asked buffered and relayed as an equivalent SSE stream", async () => {
  const upstream = await bufferedUpstream({ buffered: BUFFERED_CHAT });
  try {
    const result = await streamThrough({ anthropic: { baseUrl: upstream.base, bufferStreamingUpstream: true } });
    assert.equal(result.status, 200);
    assert.match(result.contentType, /text\/event-stream/);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].url, "/v1/chat/completions");
    assert.equal("stream" in upstream.seen[0].body, false, "the upstream is never asked to stream");
    assert.equal("stream_options" in upstream.seen[0].body, false);
    assert.equal(result.events.at(-1).data, "[DONE]", "the stream ends in [DONE]");
    assert.deepEqual(reassembleChat(result.events), withoutUsage(BUFFERED_CHAT),
      "the chunks reassemble to exactly the buffered body: content, the tool call, finish_reason");
    assert.ok(!result.events.some(({ data }) => data.includes("prompt_tokens")), "no usage chunk the client did not ask for");
    // Accounting is exact, off the buffered body.
    const usage = result.brokerCalls.find((call) => call.route === "/usage")?.body;
    assert.deepEqual(usage.tokens, { input: 50, output: 30 });
    assert.equal(usage.estimated, undefined);
    assert.ok(result.brokerCalls.some((call) => call.route === "/complete"));
    assert.ok(!result.brokerCalls.some((call) => call.route === "/failure"));
    assert.deepEqual(result.logLines, [], "a clean success is not logged");
  } finally {
    await upstream.close();
  }
});

test("include_usage on a flagged lane adds the usage chunk before [DONE]", async () => {
  const upstream = await bufferedUpstream({ buffered: BUFFERED_CHAT });
  try {
    const result = await streamThrough(
      { anthropic: { baseUrl: upstream.base, bufferStreamingUpstream: true } },
      { stream_options: { include_usage: true } },
    );
    assert.equal(result.status, 200);
    assert.equal("stream_options" in upstream.seen[0].body, false, "the client's stream_options never reach a buffered upstream");
    const usageChunk = JSON.parse(result.events.at(-2).data);
    assert.deepEqual(usageChunk.choices, []);
    assert.deepEqual(usageChunk.usage, USAGE);
    assert.equal(result.events.at(-1).data, "[DONE]");
    assert.deepEqual(reassembleChat(result.events), BUFFERED_CHAT, "with the usage chunk, the stream reassembles to the whole buffered body");
  } finally {
    await upstream.close();
  }
});

test("an unflagged lane still forwards stream: true unchanged", async () => {
  const upstream = await bufferedUpstream({ buffered: BUFFERED_CHAT });
  try {
    const result = await streamThrough({ anthropic: { baseUrl: upstream.base } });
    assert.equal(upstream.seen[0].body.stream, true, "without the flag the client's stream ask goes upstream as today");
    assert.equal(result.status, 502, "and the refusing lane is still refused");
  } finally {
    await upstream.close();
  }
});

test("a flagged lane that answers 400 fails over to the next lane, logged as http_400", async () => {
  const refusing = await bufferedUpstream({ status: 400, errorBody: { error: { message: "unsupported request field: tools" } } });
  const alive = await bufferedUpstream({ buffered: BUFFERED_CHAT });
  try {
    const result = await streamThrough(
      {
        anthropic: { baseUrl: refusing.base, bufferStreamingUpstream: true },
        second: { baseUrl: alive.base, bufferStreamingUpstream: true },
      },
      {},
      [{ ...LEASE_CLOUD }, { ...LEASE_SECOND }],
    );
    assert.equal(result.status, 200);
    assert.equal(refusing.seen.length, 1);
    assert.equal(alive.seen.length, 1);
    assert.deepEqual(reassembleChat(result.events), withoutUsage(BUFFERED_CHAT), "only the second lane's answer reaches the client");
    assert.equal(result.brokerCalls.filter((call) => call.route === "/lease").length, 2);
    const failure = result.brokerCalls.find((call) => call.route === "/failure");
    assert.equal(failure.body.leaseID, "l1");
    assert.equal(result.logLines.length, 1);
    const record = JSON.parse(result.logLines[0]);
    assert.equal(record.event, "attempt_failed");
    assert.equal(record.attempts[0].provider, "anthropic");
    assert.equal(record.attempts[0].outcome, "http_400");
    assert.match(record.attempts[0].detail, /unsupported request field: tools/);
  } finally {
    await refusing.close();
    await alive.close();
  }
});

test("a client that disconnects before the buffered reply is whole: upstream closed, lease released, nothing written", async () => {
  const upstream = await bufferedUpstream({ buffered: BUFFERED_CHAT, hold: true });
  const brokerCalls = [];
  let sawRelease;
  const released = new Promise((resolve) => { sawRelease = resolve; });
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { anthropic: { baseUrl: upstream.base, bufferStreamingUpstream: true, timeoutMs: 60_000 } } },
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      brokerCalls.push({ route, body });
      if (route === "/release") sawRelease();
      if (route === "/lease") return { ...LEASE_CLOUD };
      return { ok: true };
    },
    logLine: () => {},
  });
  try {
    await withServer(handler, async (base) => {
      const abort = new AbortController();
      let headArrived = false;
      const pending = askChat(base, {}, { signal: abort.signal }).then(() => { headArrived = true; }, () => null);
      assert.ok(await Promise.race([upstream.started.then(() => true), delay(2000).then(() => false)]),
        "the upstream was asked for a buffered body and began sending it");
      await delay(100); // the gateway is now mid-read of a half-sent buffered body
      assert.equal(headArrived, false, "nothing is written to the client before the buffered reply is whole");
      const abortedAt = Date.now();
      abort.abort();
      await pending;
      const closedAt = await Promise.race([upstream.closed, delay(1000).then(() => null)]);
      assert.ok(closedAt && closedAt - abortedAt <= 1000, "the upstream connection closes within 1 s of the hang-up");
      assert.ok(await Promise.race([released.then(() => true), delay(1000).then(() => false)]), "the lease is released");
    });
    assert.ok(brokerCalls.some((call) => call.route === "/release" && call.body.leaseID === "l1"));
    assert.ok(!brokerCalls.some((call) => call.route === "/failure"), "a client's hang-up indicts nobody");
    assert.ok(!brokerCalls.some((call) => call.route === "/usage"), "an answer nobody received is not accounted");
    assert.equal(brokerCalls.filter((call) => call.route === "/lease").length, 1, "no retry for a client that left");
  } finally {
    await upstream.close();
  }
});

test("timeoutMs is a total deadline on a flagged lane: the half-sent body is abandoned, released, and failed over", async () => {
  const stuck = await bufferedUpstream({ buffered: BUFFERED_CHAT, hold: true });
  const alive = await bufferedUpstream({ buffered: BUFFERED_CHAT });
  try {
    // streamIdleMs is far longer than the test: only timeoutMs can end the first attempt in time.
    const result = await streamThrough(
      {
        anthropic: { baseUrl: stuck.base, bufferStreamingUpstream: true, timeoutMs: 300, streamIdleMs: 60_000 },
        second: { baseUrl: alive.base, bufferStreamingUpstream: true },
      },
      {},
      [{ ...LEASE_CLOUD }, { ...LEASE_SECOND }],
    );
    assert.equal(result.status, 200);
    assert.deepEqual(reassembleChat(result.events), withoutUsage(BUFFERED_CHAT), "only the second lane's answer reaches the client");
    assert.ok(await Promise.race([stuck.closed, delay(1000).then(() => null)]), "the timed-out upstream connection is closed");
    assert.ok(result.brokerCalls.some((call) => call.route === "/release" && call.body.leaseID === "l1"));
    assert.ok(!result.brokerCalls.some((call) => call.route === "/failure"), "our own timeout indicts nobody");
    assert.equal(JSON.parse(result.logLines[0]).attempts[0].outcome, "timeout");
  } finally {
    await stuck.close();
    await alive.close();
  }
});

// ── /v1/responses: the auth proxy's Anthropic Responses route refuses any `stream` key ───────────

const BUFFERED_RESPONSE = {
  id: "resp_abc", object: "response", created_at: 1760000000, model: "claude-haiku-4-5", status: "completed",
  output: [
    { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] },
    { id: "fc_1", type: "function_call", call_id: "call_1", name: "weather", arguments: "{\"city\":\"Paris\"}", status: "completed" },
  ],
  usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
};

test("a streaming Responses request on a flagged lane is asked buffered and relayed as typed events ending in response.completed", async () => {
  const upstream = await bufferedUpstream({ buffered: BUFFERED_RESPONSE });
  const brokerCalls = [];
  const handler = gateway({
    providers: { anthropic: { baseUrl: upstream.base, responsesApi: true, bufferStreamingUpstream: true } },
    leases: [{ ...LEASE_CLOUD }],
    brokerCalls,
  });
  try {
    let text;
    await withServer(handler, async (base) => {
      const response = await askResponses(base);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      text = await response.text();
    });
    assert.equal(upstream.seen[0].url, "/v1/responses");
    assert.equal("stream" in upstream.seen[0].body, false, "the proxy's Responses route rejects any stream key");
    const events = sseEvents(text).map(({ event, data }) => ({ event, payload: JSON.parse(data) }));
    for (const { event, payload } of events) assert.equal(event, payload.type, "each frame names its event type");
    assert.deepEqual(events.map(({ payload }) => payload.sequence_number), events.map((_, index) => index));
    assert.equal(events[0].payload.type, "response.created");
    assert.equal(events[0].payload.response.status, "in_progress");
    const last = events.at(-1).payload;
    assert.equal(last.type, "response.completed");
    assert.deepEqual(last.response, BUFFERED_RESPONSE, "the terminal event carries the buffered response whole");
    // What a client assembling from deltas sees.
    const deltas = events.filter(({ payload }) => payload.type === "response.output_text.delta").map(({ payload }) => payload.delta).join("");
    assert.equal(deltas, "Hello");
    const args = events.filter(({ payload }) => payload.type === "response.function_call_arguments.delta").map(({ payload }) => payload.delta).join("");
    assert.equal(args, "{\"city\":\"Paris\"}");
    const done = events.filter(({ payload }) => payload.type === "response.output_item.done").map(({ payload }) => payload.item);
    assert.deepEqual(done, BUFFERED_RESPONSE.output);
    assert.deepEqual(brokerCalls.find((call) => call.route === "/usage")?.body.tokens, { input: 11, output: 4 });
    assert.ok(brokerCalls.some((call) => call.route === "/complete"));
  } finally {
    await upstream.close();
  }
});

// ── the two flags contradict each other ─────────────────────────────────────────────────────────

test("a lane carrying both bufferStreamingUpstream and assembleFromStream is a configuration error", () => {
  const providers = { anthropic: { baseUrl: "http://x/v1", bufferStreamingUpstream: true, assembleFromStream: true } };
  assert.throws(
    () => createGatewayHandler({ config: { tier: "worker", profile: "auto", providers }, gatewayKey: "k", brokerRequest: async () => ({}) }),
    /providers\["anthropic"\].*bufferStreamingUpstream.*assembleFromStream/,
  );
  const dir = mkdtempSync(join(tmpdir(), "gw-buffer-stream-"));
  try {
    const path = join(dir, "gateway.json");
    writeFileSync(path, JSON.stringify({ providers }));
    assert.throws(() => loadGatewayConfig(path), /providers\["anthropic"\].*bufferStreamingUpstream.*assembleFromStream/);
    writeFileSync(path, JSON.stringify({ providers: { anthropic: { baseUrl: "http://x/v1", bufferStreamingUpstream: true } } }));
    assert.equal(loadGatewayConfig(path).providers.anthropic.bufferStreamingUpstream, true, "either flag alone is fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
