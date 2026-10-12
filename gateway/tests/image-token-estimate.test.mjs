import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayHandler } from "../lib/gateway.js";

// A real Frigate snapshot is ~99,000 base64 characters; llama.cpp measured 222-277 prompt tokens
// for one. Counted as text (chars/4) two of them estimate past a 32768-token cap and the request
// never reached the model.
const IMAGE_CHARS = 100_000;
const dataUrl = () => `data:image/jpeg;base64,${"A".repeat(IMAGE_CHARS)}`;

const withServer = async (handler, fn) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
};

const post = (base, path, body) => fetch(`${base}/v1${path}`, {
  method: "POST",
  headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const cappedLane = (extra = {}) => ({
  tier: "worker",
  profile: "auto",
  providers: { llamacpp: { baseUrl: "http://local.example/v1", maxContextTokens: 32768, ...extra } },
});

test("a chat request with two inline base64 images is forwarded on a 32768-token lane, images intact", async () => {
  const leases = [];
  const forwarded = [];
  const handler = createGatewayHandler({
    config: cappedLane(),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      if (route === "/lease") { leases.push(body); return { target: { model: { providerID: "llamacpp", id: "qwen3.8-27b" } } }; }
      return { ok: true };
    },
    fetchImpl: async (url, options) => {
      forwarded.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "a car" } }], usage: {} }) };
    },
  });
  const messages = [{ role: "user", content: [
    { type: "text", text: "Describe these camera frames." },
    { type: "image_url", image_url: { url: dataUrl() } },
    { type: "image_url", image_url: { url: dataUrl() } },
  ] }];
  await withServer(handler, async (base) => {
    const response = await post(base, "/chat/completions", { messages });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  });
  assert.equal(leases.length, 1);
  assert.ok(leases[0].contextTokens <= 32768, `estimate ${leases[0].contextTokens} must fit the cap`);
  assert.ok(leases[0].contextTokens >= 2 * 1500, "each image still counts its fixed allowance");
  assert.deepEqual(forwarded[0].messages, messages, "the forwarded body keeps both images byte for byte");
});

test("a remote image URL counts the same fixed allowance as an inline one", async () => {
  const leases = [];
  const handler = createGatewayHandler({
    config: cappedLane(),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      if (route === "/lease") { leases.push(body); return { target: { model: { providerID: "llamacpp", id: "m" } } }; }
      return { ok: true };
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }) }),
  });
  await withServer(handler, async (base) => {
    for (const url of ["https://cam.example/x.jpg", dataUrl()]) {
      const response = await post(base, "/chat/completions", {
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
      });
      assert.equal(response.status, 200);
    }
  });
  assert.equal(leases[0].contextTokens, leases[1].contextTokens);
});

test("a Responses request with two input_image parts is forwarded on a 32768-token lane, images intact", async () => {
  const leases = [];
  const forwarded = [];
  const handler = createGatewayHandler({
    config: cappedLane({ responsesApi: true }),
    gatewayKey: "gw-secret",
    brokerRequest: async (route, body) => {
      if (route === "/lease") { leases.push(body); return { target: { model: { providerID: "llamacpp", id: "m" } } }; }
      return { ok: true };
    },
    fetchImpl: async (url, options) => {
      forwarded.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ id: "r1", object: "response", status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 600, output_tokens: 2 } }) };
    },
  });
  const input = [{ role: "user", content: [
    { type: "input_text", text: "Describe these camera frames." },
    { type: "input_image", image_url: dataUrl() },
    { type: "input_image", image_url: dataUrl() },
  ] }];
  await withServer(handler, async (base) => {
    const response = await post(base, "/responses", { input });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  });
  assert.ok(leases[0].contextTokens <= 32768, `estimate ${leases[0].contextTokens} must fit the cap`);
  assert.ok(leases[0].contextTokens >= 2 * 1500);
  assert.deepEqual(forwarded[0].input, input, "the forwarded body keeps both images byte for byte");
});

test("a text request over every lane's context cap says so, with both numbers", async () => {
  const handler = createGatewayHandler({
    config: cappedLane(),
    gatewayKey: "gw-secret",
    brokerRequest: async () => { throw new Error("must not lease"); },
    fetchImpl: async () => { throw new Error("must not forward"); },
  });
  const body = { messages: [{ role: "user", content: "x".repeat(200_000) }] };
  const estimate = Math.ceil(JSON.stringify(body).length / 4);
  await withServer(handler, async (base) => {
    const response = await post(base, "/chat/completions", body);
    assert.equal(response.status, 502);
    const message = (await response.json()).error.message;
    assert.match(message, new RegExp(`estimated at ${estimate} tokens exceeds the context cap 32768`));
    assert.doesNotMatch(message, /excluded/);
  });
});

test("a lane excluded after a failure still reports the exclusion, not a context cap", async () => {
  const home = mkdtempSync(join(tmpdir(), "gw-img-cred-"));
  const authPath = join(home, "auth.json");
  writeFileSync(authPath, JSON.stringify({ someprovider: { key: "stale", expires: 1 } }));
  try {
    const handler = createGatewayHandler({
      // Unmapped: the first attempt's credential failure excludes the only lane, and the second
      // attempt finds nothing left to offer.
      config: { tier: "worker", profile: "auto", providers: {
        llamacpp: { baseUrl: "http://local.example/v1", authRef: "someprovider", maxContextTokens: 32768 },
      } },
      gatewayKey: "gw-secret",
      authPath,
      brokerRequest: async (route) => (route === "/lease"
        ? { target: { model: { providerID: "llamacpp", id: "m" } } }
        : { ok: true }),
      fetchImpl: async () => { throw new Error("must not forward"); },
    });
    await withServer(handler, async (base) => {
      const response = await post(base, "/chat/completions", { messages: [{ role: "user", content: "hi" }] });
      assert.equal(response.status, 502);
      const message = (await response.json()).error.message;
      assert.match(message, /every forwardable provider was excluded this attempt/);
      assert.doesNotMatch(message, /context cap/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
