import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGatewayHandler } from "../lib/gateway.js";

const FRONTDOOR_KEY = "frontdoor-test-key";
const API_KEY = "synthetic-manual-api-key";

const listen = async (handler) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const messageResponse = (response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ type: "message", id: "msg_fake", role: "assistant", content: [], stop_reason: "end_turn" }));
};

const requestBody = async (request) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
};

const requestMessages = (base, model) => fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${FRONTDOOR_KEY}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "ping" }] }),
});

const temporaryKey = () => {
  const dir = mkdtempSync(join(tmpdir(), "manual-api-gateway-"));
  const path = join(dir, "api-key");
  writeFileSync(path, `${API_KEY}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { dir, path };
};

const startGateway = async ({ config, brokerRequest }) => {
  const handler = createGatewayHandler({ config, gatewayKey: FRONTDOOR_KEY, brokerRequest });
  return listen(handler);
};

test("manual alias leases the reserve profile but an attested unfunded configuration is terminally refused", async () => {
  const key = temporaryKey();
  const brokerCalls = [];
  const paidRequests = [];
  const subscriptionRequests = [];
  const paid = await listen(async (request, response) => {
    paidRequests.push({ url: request.url, headers: request.headers, body: await requestBody(request) });
    messageResponse(response);
  });
  const subscription = await listen(async (request, response) => {
    subscriptionRequests.push({ url: request.url, headers: request.headers });
    messageResponse(response);
  });
  const config = {
    tier: "worker",
    profile: "auto",
    modelProfiles: { "manual-sonnet": { profile: "api-reserve", tier: "worker" } },
    providers: {
      "paid-test-provider": { baseUrl: `${paid.base}/v1`, messagesApi: true, keyFile: key.path },
      subscription: { baseUrl: `${subscription.base}/v1`, messagesApi: true },
    },
  };
  const gateway = await startGateway({
    config,
    brokerRequest: async (path, body) => {
      brokerCalls.push({ path, body });
      if (path === "/lease") return {
        leaseID: "reserve-lease",
        target: { id: "reserve-sonnet", model: { providerID: "paid-test-provider", id: "claude-sonnet-5-5" },
          requiresSpendBudget: true, billingClass: "manual-api" },
      };
      return { ok: true };
    },
  });
  try {
    const response = await requestMessages(gateway.base, "manual-sonnet");
    assert.equal(response.status, 402);
    assert.equal(response.headers.get("x-should-retry"), "false");
    const payload = await response.json();
    assert.equal(payload.error.type, "spend_budget_refusal");
    assert.equal(payload.error.code, "missing_policy");
    assert.equal(payload.error.retryable, false);
  } finally {
    await gateway.close();
    await paid.close();
    await subscription.close();
    rmSync(key.dir, { recursive: true, force: true });
  }
  const lease = brokerCalls.find(({ path }) => path === "/lease");
  assert.equal(lease.body.profile, "api-reserve");
  assert.deepEqual(lease.body.providers, ["paid-test-provider", "subscription"]);
  assert.equal(paidRequests.length, 0);
  assert.equal(brokerCalls.filter(call => call.path === "/lease").length, 1);
  assert.equal(brokerCalls.some(call => call.path === "/failure"), false);
  assert.equal(subscriptionRequests.length, 0, "the subscription proxy is not an API-reserve fallback");
});

test("default and unknown models keep the auto profile and cannot select the paid provider", async () => {
  const key = temporaryKey();
  const brokerCalls = [];
  let paidRequests = 0;
  const paid = await listen(async (_request, response) => { paidRequests += 1; messageResponse(response); });
  const subscription = await listen(async (_request, response) => { messageResponse(response); });
  const gateway = await startGateway({
    config: {
      tier: "worker", profile: "auto",
      modelProfiles: { "manual-sonnet": "api-reserve" },
      providers: {
        "paid-test-provider": { baseUrl: `${paid.base}/v1`, messagesApi: true, keyFile: key.path },
        subscription: { baseUrl: `${subscription.base}/v1`, messagesApi: true },
      },
    },
    brokerRequest: async (path, body) => {
      brokerCalls.push({ path, body });
      if (path === "/lease") return { error: "manual API reserve requires api-reserve", code: "no-eligible-target" };
      return { ok: true };
    },
  });
  try {
    for (const model of [undefined, "unknown-model"]) {
      const response = await requestMessages(gateway.base, model);
      assert.equal(response.status, 502);
      await response.text();
    }
  } finally {
    await gateway.close();
    await paid.close();
    await subscription.close();
    rmSync(key.dir, { recursive: true, force: true });
  }
  const leases = brokerCalls.filter(({ path }) => path === "/lease");
  assert.equal(leases.length, 2);
  assert.deepEqual(leases.map(({ body }) => body.profile), ["auto", "auto"]);
  assert.ok(leases.every(({ body }) => body.providers.includes("paid-test-provider")));
  assert.equal(paidRequests, 0);
});

test("a failed subscription request retries only the auto profile and never reaches the API reserve", async () => {
  const key = temporaryKey();
  const brokerCalls = [];
  let paidRequests = 0;
  let subscriptionRequests = 0;
  const paid = await listen(async (_request, response) => { paidRequests += 1; messageResponse(response); });
  const subscription = await listen(async (_request, response) => {
    subscriptionRequests += 1;
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("subscription unavailable");
  });
  const gateway = await startGateway({
    config: {
      tier: "worker", profile: "auto",
      modelProfiles: { "manual-sonnet": "api-reserve" },
      providers: {
        "paid-test-provider": { baseUrl: `${paid.base}/v1`, messagesApi: true, keyFile: key.path },
        subscription: { baseUrl: `${subscription.base}/v1`, messagesApi: true },
      },
    },
    brokerRequest: async (path, body) => {
      brokerCalls.push({ path, body });
      if (path === "/lease" && brokerCalls.filter((call) => call.path === "/lease").length === 1) {
        return { leaseID: "subscription-lease", target: { model: { providerID: "subscription", id: "claude-subscription" } } };
      }
      if (path === "/lease") return { error: "no automatic target remains", code: "no-eligible-target" };
      return { ok: true };
    },
  });
  try {
    const response = await requestMessages(gateway.base, "unknown-model");
    assert.equal(response.status, 502);
    await response.text();
  } finally {
    await gateway.close();
    await paid.close();
    await subscription.close();
    rmSync(key.dir, { recursive: true, force: true });
  }
  const leases = brokerCalls.filter(({ path }) => path === "/lease");
  assert.deepEqual(leases.map(({ body }) => body.profile), ["auto", "auto"]);
  assert.equal(subscriptionRequests, 1);
  assert.equal(paidRequests, 0);
  assert.ok(brokerCalls.some(({ path }) => path === "/failure"));
});

for (const fixture of [
  { label: "missing", setup: (path) => join(path, "does-not-exist") },
  { label: "unsafe", setup: (path) => { const key = join(path, "unsafe-key"); writeFileSync(key, `${API_KEY}\n`, { mode: 0o644 }); chmodSync(key, 0o644); return key; } },
]) {
  test(`an attested missing-policy route is refused even with a ${fixture.label} API keyFile`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "manual-api-key-failure-"));
    const keyFile = fixture.setup(dir);
    let paidRequests = 0;
    const paid = await listen(async (_request, response) => { paidRequests += 1; messageResponse(response); });
    const brokerCalls = [];
    const gateway = await startGateway({
      config: {
        tier: "worker", profile: "auto",
        modelProfiles: { "manual-sonnet": "api-reserve" },
        providers: { "paid-test-provider": { baseUrl: `${paid.base}/v1`, messagesApi: true, keyFile } },
      },
      brokerRequest: async (path, body) => {
        brokerCalls.push({ path, body });
        if (path === "/lease") return { leaseID: "reserve-lease", target: { model: { providerID: "paid-test-provider", id: "claude-sonnet-5-5" },
          requiresSpendBudget: true, billingClass: "manual-api" } };
        return { ok: true };
      },
    });
    try {
      const response = await requestMessages(gateway.base, "manual-sonnet");
      assert.equal(response.status, 402);
      assert.equal(response.headers.get("x-should-retry"), "false");
      const payload = await response.json();
      assert.equal(payload.error.type, "spend_budget_refusal");
      assert.equal(payload.error.code, "missing_policy");
      assert.equal(payload.error.retryable, false);
    } finally {
      await gateway.close();
      await paid.close();
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(brokerCalls.find(({ path }) => path === "/lease").body.profile, "api-reserve");
    assert.equal(paidRequests, 0);
  });
}
