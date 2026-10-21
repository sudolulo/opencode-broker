// A session-bound request whose client lease id has gone stale must still be served when the
// session holds a live lease for the SAME model. The broker re-mints the lease id on any fresh
// selection (release at session.idle, the LEASE_TTL sweep, a revalidation miss) while
// session-stickiness keeps the model ("NO LIVE REBALANCING"), so an in-flight request can carry
// the previous lease id and the gateway's exact-id /lease/verify answers held:false -- the
// "no live lease for <model>" stall. The gateway re-verifies by session alone on that miss and
// lets leaseCoversWireModel decide, so a same-model rotation forwards while a genuine model
// change still refuses. See gateway/lib/gateway.js (the bound-session block).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayHandler } from "../lib/gateway.js";

const withServer = async (handler, fn) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

// onVerifyWithId models the broker's reply to the gateway's exact-id /lease/verify; onVerifyNoId
// models the session-only re-verify (the session's CURRENT lease, whatever its id).
const run = async ({ onVerifyWithId, onVerifyNoId, wireModel = "claude-opus-5-5" }) => {
  const calls = [];
  const forwards = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { anthropic: { baseUrl: "http://anthropic.example/v1" } } },
    gatewayKey: "gw-secret",
    brokerRequest: async (path, body) => {
      calls.push({ path, hasLeaseID: body.leaseID !== undefined });
      if (path === "/lease/verify") return body.leaseID !== undefined ? onVerifyWithId() : onVerifyNoId();
      if (path === "/lease") throw new Error("a session-bound request must never re-lease");
      return { ok: true };
    },
    fetchImpl: async (url, init) => {
      forwards.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    },
  });
  let status;
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer gw-secret",
        "Content-Type": "application/json",
        "x-opencode-session-id": "ses_abc",
        "x-opencode-lease-id": "lease-stale",
      },
      body: JSON.stringify({ model: wireModel, messages: [{ role: "user", content: "ping" }] }),
    });
    status = response.status;
    await response.arrayBuffer();
  });
  return { status, calls, forwards };
};

const opus = { held: true, leaseID: "lease-NEW", target: { id: "claude-opus-5-5", model: { providerID: "anthropic", id: "claude-opus-5-5" } } };
const haiku = { held: true, leaseID: "lease-NEW", target: { id: "claude-haiku-4-5", model: { providerID: "anthropic", id: "claude-haiku-4-5" } } };
const noLease = { held: false };

test("a stale lease id with a live same-model lease is served, not stranded", async () => {
  const r = await run({ onVerifyWithId: () => noLease, onVerifyNoId: () => opus });
  assert.equal(r.status, 200, "must forward on the session's current same-model lease");
  assert.equal(r.forwards.length, 1);
  assert.equal(r.forwards[0].body.model, "claude-opus-5-5");
  assert.deepEqual(r.calls.map((c) => c.hasLeaseID), [true, false],
    "exact-id verify misses, then a session-only re-verify finds the rotated lease");
});

test("a stale lease id but a DIFFERENT current model is still refused", async () => {
  const r = await run({ onVerifyWithId: () => noLease, onVerifyNoId: () => haiku, wireModel: "claude-opus-5-5" });
  assert.notEqual(r.status, 200, "a model change must never be served on the client's wire model");
  assert.equal(r.forwards.length, 0);
});

test("an exact-id match still forwards with a single verify (no re-verify)", async () => {
  const r = await run({ onVerifyWithId: () => opus, onVerifyNoId: () => { throw new Error("must not re-verify on an exact-id hit"); } });
  assert.equal(r.status, 200);
  assert.equal(r.forwards.length, 1);
  assert.deepEqual(r.calls.map((c) => c.hasLeaseID), [true], "only the exact-id verify runs");
});

test("a session with no live lease at all is refused", async () => {
  const r = await run({ onVerifyWithId: () => noLease, onVerifyNoId: () => noLease });
  assert.notEqual(r.status, 200);
  assert.equal(r.forwards.length, 0);
  assert.deepEqual(r.calls.map((c) => c.hasLeaseID), [true, false]);
});
