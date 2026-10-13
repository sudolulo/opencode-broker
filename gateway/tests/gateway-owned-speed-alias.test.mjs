import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayHandler } from "../lib/gateway.js";

const withServer = async (handler, run) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

const successfulMessage = () => ({
  ok: true,
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => JSON.stringify({ type: "message", id: "m", role: "assistant", content: [], stop_reason: "end_turn" }),
});

const gatewayOwnedFixture = (modelID) => {
  const forwards = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { anthropic: { baseUrl: "https://upstream.example/v1", messagesApi: true } } },
    gatewayKey: "frontdoor",
    brokerRequest: async (path) => path === "/lease"
      ? { leaseID: "gateway-lease", target: { model: { providerID: "anthropic", id: modelID } } }
      : { ok: true },
    fetchImpl: async (_url, options) => { forwards.push(options); return successfulMessage(); },
  });
  return { handler, forwards };
};

const send = (base, body) => fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { Authorization: "Bearer frontdoor", "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify(body),
});

test("a gateway-owned speed-alias lease forwards the session-bound base wire model", async () => {
  const fixture = gatewayOwnedFixture("claude-opus-5-5-fast");
  await withServer(fixture.handler, async (base) => {
    const response = await send(base, { model: "caller-model", max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
    assert.equal(response.status, 200);
  });
  assert.equal(fixture.forwards.length, 1);
  assert.deepEqual(JSON.parse(fixture.forwards[0].body), {
    model: "claude-opus-5-5",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(fixture.forwards[0].headers["anthropic-beta"], undefined);
});

test("a gateway-owned ordinary lease preserves the existing outbound body", async () => {
  const fixture = gatewayOwnedFixture("claude-opus-5-5");
  await withServer(fixture.handler, async (base) => {
    const response = await send(base, { model: "caller-model", max_tokens: 64, messages: [{ role: "user", content: "hello" }] });
    assert.equal(response.status, 200);
  });
  assert.equal(fixture.forwards.length, 1);
  assert.equal(fixture.forwards[0].body, JSON.stringify({
    model: "claude-opus-5-5",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  }));
});
