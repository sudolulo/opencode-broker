import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayHandler } from "../lib/gateway.js";

const withServer = async (handler, fn) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
};

// A buffered upstream reply the fake provider returns (text + json + ok/status + headers).
const reply = (payload) => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});
const BLOCKED = { choices: [{ index: 0, finish_reason: "content_filter", message: { role: "assistant", content: "" } }] };
const CLEAN = { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "clean answer" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
const MSG_BLOCKED = { id: "msg_1", type: "message", role: "assistant", model: "blocked-model", content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } };
const MSG_CLEAN = { id: "msg_2", type: "message", role: "assistant", model: "fallback-model", content: [{ type: "text", text: "clean answer" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 4, output_tokens: 2 } };

// A fake broker: the first /lease gives the (to-be-)blocked model; a contentFilterCascade /lease
// gives the fallback (unless `cascade` is false, i.e. the order is exhausted).
const makeBroker = (calls, { cascade = "fallback-model", providerExtras = {} } = {}) => async (path, body) => {
  calls.push({ path, body });
  if (path !== "/lease") return { ok: true };
  if (body.contentFilterCascade) {
    if (!cascade) return { error: "every content-filter cascade candidate is unavailable", code: "content-filter-exhausted" };
    return { leaseID: "L-cascade", target: { id: cascade, model: { providerID: "llamacpp", id: cascade } } };
  }
  return { leaseID: "L-first", target: { id: "blocked", model: { providerID: "llamacpp", id: "blocked-model" }, ...providerExtras } };
};

const baseConfig = (providerExtras = {}) => ({
  tier: "worker", profile: "auto",
  providers: { llamacpp: { baseUrl: "http://local.example/v1", ...providerExtras } },
  modelProfiles: { smart: { profile: "auto", tier: "smart" } },
});

test("a content-filter block fails over to the next model and relays the clean answer (non-streaming)", async () => {
  const calls = [];
  const handler = createGatewayHandler({
    config: baseConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: makeBroker(calls),
    fetchImpl: async (url, options) => reply(JSON.parse(options.body).model === "blocked-model" ? BLOCKED : CLEAN),
  });
  await withServer(handler, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "smart", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "clean answer", "the client receives the fallback model's clean reply");
  });
  const cascadeLease = calls.find((c) => c.path === "/lease" && c.body.contentFilterCascade);
  assert.ok(cascadeLease, "the gateway issued a content-filter cascade lease");
  assert.deepEqual(cascadeLease.body.blockedModel, { providerID: "llamacpp", id: "blocked-model" });
  assert.ok(calls.some((c) => c.path === "/release"), "the blocked lease was released (non-sticky)");
  assert.ok(!calls.some((c) => c.path === "/failure"), "a content-filter block never indicts the model with /failure");
});

test("a clean first reply never triggers a cascade lease", async () => {
  const calls = [];
  const handler = createGatewayHandler({
    config: baseConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: makeBroker(calls),
    fetchImpl: async () => reply(CLEAN),
  });
  await withServer(handler, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "smart", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, "clean answer");
  });
  assert.ok(!calls.some((c) => c.path === "/lease" && c.body.contentFilterCascade), "no cascade lease for an unblocked reply");
  assert.ok(calls.some((c) => c.path === "/complete"), "the first lease completed normally");
});

test("when the cascade is exhausted the client still gets the original refusal", async () => {
  const calls = [];
  const handler = createGatewayHandler({
    config: baseConfig(),
    gatewayKey: "gw-secret",
    brokerRequest: makeBroker(calls, { cascade: null }), // broker has no fallback candidate
    fetchImpl: async () => reply(BLOCKED),
  });
  await withServer(handler, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "smart", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].finish_reason, "content_filter", "the original block is delivered when nothing else can answer");
  });
  assert.ok(calls.some((c) => c.path === "/lease" && c.body.contentFilterCascade), "a cascade lease was attempted");
});

test("a streaming turn on a bufferStreamingForContentFilter lane cascades and streams the clean answer", async () => {
  const calls = [];
  const handler = createGatewayHandler({
    config: baseConfig({ bufferStreamingForContentFilter: true }),
    gatewayKey: "gw-secret",
    brokerRequest: makeBroker(calls),
    fetchImpl: async (url, options) => reply(JSON.parse(options.body).model === "blocked-model" ? BLOCKED : CLEAN),
  });
  await withServer(handler, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "smart", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /clean answer/, "the fallback reply is dressed as the SSE stream the client asked for");
    assert.match(body, /\[DONE\]/);
  });
  assert.ok(calls.find((c) => c.path === "/lease" && c.body.contentFilterCascade), "a streaming block cascaded via a buffered re-issue");
});

test("an Anthropic /v1/messages streaming turn cascades past a refusal and streams the clean message", async () => {
  const calls = [];
  const handler = createGatewayHandler({
    config: {
      tier: "worker", profile: "auto",
      providers: { llamacpp: { baseUrl: "http://local.example/v1", messagesApi: true, bufferStreamingForContentFilter: true } },
      modelProfiles: { claude: { profile: "auto", tier: "smart" } },
    },
    gatewayKey: "gw-secret",
    brokerRequest: makeBroker(calls),
    fetchImpl: async (url, options) => reply(JSON.parse(options.body).model === "blocked-model" ? MSG_BLOCKED : MSG_CLEAN),
  });
  await withServer(handler, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST", headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude", stream: true, max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /event: message_start/, "the buffered fallback reply is dressed as a Messages SSE stream");
    assert.match(body, /clean answer/);
    assert.match(body, /event: message_stop/);
  });
  const cascadeLease = calls.find((c) => c.path === "/lease" && c.body.contentFilterCascade);
  assert.ok(cascadeLease, "the refused Claude turn cascaded");
  assert.deepEqual(cascadeLease.body.blockedModel, { providerID: "llamacpp", id: "blocked-model" });
});
