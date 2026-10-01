import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayHandler } from "../lib/gateway.js";

const SESSION_ID = "ses_abc123";
const SESSION_KIND = "subagent";
const HINTED_PROVIDER = { baseUrl: "http://proxy.example/v1", forwardSessionHints: true };
const HINTED_VERIFY = {
  held: true,
  leaseID: "lease-1",
  target: { model: { providerID: "anthropic", id: "claude-opus-5-5" } },
};
const CHAT_BODY = { model: "claude-opus-5-5", messages: [{ role: "user", content: "ping" }] };
const SESSION_HEADERS = {
  "x-opencode-session-id": SESSION_ID,
  "x-opencode-lease-id": "lease-1",
  "x-opencode-session-kind": SESSION_KIND,
};

const withServer = async (handler, fn) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
};

// A session-bound request: the id is present, the broker confirms the session holds
// a lease for exactly the requested model, and the gateway rides that lease with one
// attempt. The hints under test travel in the same headers the plugin sends.
const runBound = async (config, verify, path, body, headers = {}) => {
  const forwards = [];
  const handler = createGatewayHandler({
    config,
    gatewayKey: "gw-secret",
    brokerRequest: async (brokerPath) => {
      if (brokerPath === "/lease/verify") return verify;
      if (brokerPath === "/lease") throw new Error("must not lease: a session-bound request rides its own lease");
      return { ok: true };
    },
    fetchImpl: async (url, init) => {
      forwards.push({ url, headers: { ...init.headers } });
      if (url.endsWith("/messages")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: "pong" }] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      };
    },
  });
  let status;
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer gw-secret", "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    status = response.status;
    await response.arrayBuffer();
  });
  return { status, forwards };
};

test("an opted-in provider receives both session hints with exact values on every api it serves", async () => {
  const provider = {
    baseUrl: "http://proxy.example/v1",
    chatApi: true,
    messagesApi: true,
    responsesApi: true,
    forwardSessionHints: true,
  };
  const endpoints = [
    ["/v1/chat/completions", CHAT_BODY],
    ["/v1/responses", { model: "claude-opus-5-5", input: "ping" }],
    ["/v1/messages", { model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "ping" }] }],
  ];
  for (const [path, body] of endpoints) {
    const { status, forwards } = await runBound(
      { tier: "worker", profile: "auto", providers: { anthropic: provider } },
      HINTED_VERIFY,
      path,
      body,
      SESSION_HEADERS,
    );
    assert.equal(status, 200, path);
    assert.equal(forwards.length, 1, path);
    assert.match(forwards[0].url, new RegExp(`^http://proxy\\.example/v1${path.slice(3)}$`), path);
    assert.equal(forwards[0].headers["x-opencode-session-id"], SESSION_ID, `id on ${path}`);
    assert.equal(forwards[0].headers["x-opencode-session-kind"], SESSION_KIND, `kind on ${path}`);
  }
});

test("a provider without forwardSessionHints receives neither hint", async () => {
  const { status, forwards } = await runBound(
    { tier: "worker", profile: "auto", providers: { "alibaba-token-plan": { baseUrl: "http://plan.example/v1" } } },
    { held: true, leaseID: "lease-1", target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } },
    "/v1/chat/completions",
    { model: "qwen3.8-flash", messages: [{ role: "user", content: "ping" }] },
    SESSION_HEADERS,
  );
  assert.equal(status, 200);
  assert.equal(forwards.length, 1);
  assert.equal(forwards[0].headers["x-opencode-session-id"], undefined, "a session id must never reach a third-party lane");
  assert.equal(forwards[0].headers["x-opencode-session-kind"], undefined, "the kind must not reach a third-party lane either");
});

test("a session kind that is not exactly primary or subagent is not forwarded", async () => {
  for (const kind of ["agent", "SUBAGENT", "", "primary-extra"]) {
    const { status, forwards } = await runBound(
      { tier: "worker", profile: "auto", providers: { anthropic: { ...HINTED_PROVIDER } } },
      HINTED_VERIFY,
      "/v1/chat/completions",
      CHAT_BODY,
      { "x-opencode-session-id": SESSION_ID, "x-opencode-lease-id": "lease-1", "x-opencode-session-kind": kind },
    );
    assert.equal(status, 200, `kind ${JSON.stringify(kind)}: hints are not auth and must not throw`);
    assert.equal(forwards[0].headers["x-opencode-session-kind"], undefined, `kind ${JSON.stringify(kind)}`);
    assert.equal(forwards[0].headers["x-opencode-session-id"], SESSION_ID, "the valid id still goes, alone");
  }
});

test("a session id outside the allowed shape is not forwarded", async () => {
  for (const id of ["bad id", "x".repeat(129), "id;evil", ""]) {
    const { status, forwards } = await runBound(
      { tier: "worker", profile: "auto", providers: { anthropic: { ...HINTED_PROVIDER } } },
      HINTED_VERIFY,
      "/v1/chat/completions",
      CHAT_BODY,
      { "x-opencode-session-id": id, "x-opencode-lease-id": "lease-1", "x-opencode-session-kind": SESSION_KIND },
    );
    assert.equal(status, 200, `id ${JSON.stringify(id.slice(0, 8))}: hints are not auth and must not throw`);
    assert.equal(forwards[0].headers["x-opencode-session-id"], undefined, `id ${JSON.stringify(id.slice(0, 8))}`);
    assert.equal(forwards[0].headers["x-opencode-session-kind"], SESSION_KIND, "the valid kind still goes, alone");
  }
});

test("a 128-character session id is forwarded, at the edge of the allowed shape", async () => {
  const id = "s".repeat(128);
  const { status, forwards } = await runBound(
    { tier: "worker", profile: "auto", providers: { anthropic: { ...HINTED_PROVIDER } } },
    HINTED_VERIFY,
    "/v1/chat/completions",
    CHAT_BODY,
    { "x-opencode-session-id": id, "x-opencode-lease-id": "lease-1", "x-opencode-session-kind": SESSION_KIND },
  );
  assert.equal(status, 200);
  assert.equal(forwards[0].headers["x-opencode-session-id"], id);
  assert.equal(forwards[0].headers["x-opencode-session-kind"], SESSION_KIND);
});

// A request that carries a session id normally never fails over: the id binds it to
// its own lease, one attempt. The only shape that still rides the two-attempt loop is
// a probe request, whose marker skips the binding -- so the failover case is proven
// there: attempt 1 lands on the opted-in lane, attempt 2 on a lane that never opted in.
test("a request that fails over leaves the hints on the lane that did not opt in", async () => {
  const probeSessionID = `gw-probe-${"s".repeat(43)}`;
  const probeNonce = `pbn_${"n".repeat(43)}`;
  const forwards = [];
  let leases = 0;
  const handler = createGatewayHandler({
    config: {
      tier: "worker",
      profile: "auto",
      providers: {
        "anthropic-proxy": { baseUrl: "http://proxy.example/v1", forwardSessionHints: true },
        "alibaba-token-plan": { baseUrl: "http://plan.example/v1" },
      },
    },
    gatewayKey: "gw-secret",
    brokerRequest: async (path) => {
      if (path === "/probe/consume") {
        return {
          sessionID: probeSessionID,
          probeNonce,
          preferredModel: { providerID: "anthropic-proxy", modelID: "claude-opus-5-5" },
        };
      }
      if (path === "/lease") {
        return leases++ === 0
          ? { target: { model: { providerID: "anthropic-proxy", id: "claude-opus-5-5" } } }
          : { target: { model: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" } } };
      }
      return { ok: true };
    },
    fetchImpl: async (url, init) => {
      forwards.push({ url, headers: { ...init.headers } });
      return forwards.length === 1
        ? { ok: false, status: 500, text: async () => "failed" }
        : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    },
  });
  let status;
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer gw-secret",
        "Content-Type": "application/json",
        "x-opencode-probe-session": probeSessionID,
        "x-opencode-probe-nonce": probeNonce,
        "x-opencode-session-id": SESSION_ID,
        "x-opencode-session-kind": SESSION_KIND,
      },
      body: JSON.stringify(CHAT_BODY),
    });
    status = response.status;
    await response.arrayBuffer();
  });
  assert.equal(status, 200);
  assert.equal(forwards.length, 2, "the first lane failed and the second answered");
  assert.match(forwards[0].url, /^http:\/\/proxy\.example\/v1\//, "attempt 1 lands on the opted-in lane");
  assert.match(forwards[1].url, /^http:\/\/plan\.example\/v1\//, "attempt 2 lands on the lane that never opted in");
  assert.equal(forwards[0].headers["x-opencode-session-id"], SESSION_ID, "the opted-in lane gets the id");
  assert.equal(forwards[0].headers["x-opencode-session-kind"], SESSION_KIND, "the opted-in lane gets the kind");
  assert.equal(forwards[1].headers["x-opencode-session-id"], undefined, "the second lane must not receive the id");
  assert.equal(forwards[1].headers["x-opencode-session-kind"], undefined, "the second lane must not receive the kind");
});

test("forwarding the hints does not touch the auth headers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-hints-key-"));
  const keyFile = join(dir, "proxy-key");
  writeFileSync(keyFile, "proxy-key-123\n");
  chmodSync(keyFile, 0o600);
  try {
    const { status, forwards } = await runBound(
      { tier: "worker", profile: "auto", providers: { anthropic: { baseUrl: "http://proxy.example/v1", keyFile, forwardSessionHints: true } } },
      HINTED_VERIFY,
      "/v1/chat/completions",
      CHAT_BODY,
      SESSION_HEADERS,
    );
    assert.equal(status, 200);
    assert.equal(forwards[0].headers["x-api-key"], "proxy-key-123", "the keyFile key still goes, exactly as before");
    assert.equal(forwards[0].headers["authorization"], undefined, "no bearer header on a keyFile lane");
    assert.equal(forwards[0].headers["x-opencode-session-id"], SESSION_ID);
    assert.equal(forwards[0].headers["x-opencode-session-kind"], SESSION_KIND);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
