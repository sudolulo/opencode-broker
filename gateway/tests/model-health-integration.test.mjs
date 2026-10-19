import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createHash } from "node:crypto";
import { createGatewayHandler } from "../lib/gateway.js";
import { createHealthProtocol } from "../lib/proxy-health-context.js";
import { makePolicy } from "../../tests/helpers/model-outages.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const withServer = async (handler, run) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

test("ordinary primary forwards unverified after an invalid health ticket", async () => {
  const key = Buffer.alloc(32, 9);
  const protocol = createHealthProtocol({ key });
  const calls = [];
  let outbound, forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { claude: { baseUrl: "http://upstream.example/v1", messagesApi: true } } },
    gatewayKey: "frontdoor", health: { key, gatewayCredential: "private-health" },
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === "/lease") return { leaseID: "gw-lease", target: { model: { providerID: "claude", id: "claude-real" } } };
      if (path === "/model-health/begin") return { nonce: "bad", startedAt: "100", capability: "" };
      if (path === "/model-health/outcome") return { accepted: true };
      return { ok: true };
    },
    now: () => 100,
    fetchImpl: async (_url, options) => {
      forwards += 1;
      outbound = options;
      assert.equal(options.headers["x-fleet-health-forged"], undefined);
      assert.equal(options.headers["x-fleet-health-context"], undefined);
      return {
        ok: true, status: 200,
        headers: new Headers({ "content-type": "application/json", "x-fleet-health-leak": "never-client" }),
        text: async () => JSON.stringify({ type: "message", id: "m", role: "assistant", content: [], stop_reason: "end_turn" }),
      };
    },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer frontdoor", "content-type": "application/json", "x-fleet-health-forged": "forged" },
      body: JSON.stringify({ model: "client-name", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fleet-health-leak"), null);
  });
  assert.ok(outbound);
  assert.equal(forwards, 1);
  assert.equal(calls.filter((call) => call.path === "/model-health/outcome").length, 0);
});

test("outage-health probe makes one assigned upstream attempt without fallback", async () => {
  const calls = [];
  const key = Buffer.alloc(32, 4);
  const sessionID = `gw-probe-${"p".repeat(43)}`;
  const probeNonce = `pbn_${"n".repeat(43)}`;
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { openai: { baseUrl: "http://upstream.example/v1", responsesApi: true }, backup: { baseUrl: "http://backup.example/v1", responsesApi: true } } },
    gatewayKey: "frontdoor", health: { key, gatewayCredential: "private-health" }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === "/probe/consume") return { sessionID, leaseID: "outage-lease", targetID: "outage-target", expectedCredentialInstance: `ci_${Buffer.alloc(32, 2).toString("base64url")}`, modelID: "assigned", wireModelID: "assigned", expectedScopePolicy: makePolicy().expectedScopePolicies["openai/sol/standard"], preferredModel: { providerID: "openai", modelID: "assigned" }, purpose: "outage-health" };
      if (path === "/model-health/begin") return { nonce: "bad", startedAt: "100", capability: "" };
      if (path === "/lease") return calls.filter((call) => call.path === "/lease").length === 1
        ? { leaseID: "temporary", target: { model: { providerID: "openai", id: "assigned" } } }
        : { leaseID: "fallback", target: { model: { providerID: "backup", id: "wrong" } } };
      return { ok: true };
    },
    fetchImpl: async () => { forwards += 1; return { ok: false, status: 503, headers: new Headers(), text: async () => "unavailable" }; },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer frontdoor", "content-type": "application/json", "x-opencode-probe-purpose": "outage-health", "x-opencode-probe-session": sessionID, "x-opencode-probe-nonce": probeNonce },
      body: JSON.stringify({ model: "any", input: "ping" }),
    });
    assert.equal(response.status, 502);
  });
  assert.equal(calls.filter((call) => call.path === "/lease").length, 0, "outage assignment bypasses ordinary leasing");
  assert.equal(forwards, 0, "invalid outage ticket never reaches upstream");
  assert.equal(calls.filter((call) => call.path === "/model-health/outcome").length, 0);
});

test("attested proxy scope409 re-leases a temporary target without settling external lease", async () => {
  const key = Buffer.alloc(32, 7);
  const protocol = createHealthProtocol({ key });
  const calls = [];
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { openai: { baseUrl: "http://upstream.example/v1", responsesApi: true } } },
    gatewayKey: "frontdoor", health: { key, gatewayCredential: "private-health" }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === "/lease/verify") return { held: true, leaseID: "external-lease", expectedCredentialInstance: `ci_${Buffer.alloc(32, 2).toString("base64url")}`, target: { id: "original-target", model: { providerID: "openai", id: "real" } } };
      if (path === "/model-health/begin") return { nonce: Buffer.alloc(32, forwards + 1).toString("base64url"), startedAt: 100, capability: Buffer.alloc(32, forwards + 3).toString("base64url") };
      if (path === "/lease") return { leaseID: "temporary-lease", target: { id: "replacement-target", model: { providerID: "openai", id: "replacement" } } };
      if (path === "/model-health/outcome") return { result: "scope-mismatch" };
      return { ok: true };
    },
    fetchImpl: async (_url, options) => {
      forwards += 1;
      if (forwards === 1) {
        const context = options.headers["x-fleet-health-context"];
        const request = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
        const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], `ci_${Buffer.alloc(32, 2).toString("base64url")}`, "proxy/responses", "https://upstream.example", "oauth", "responses", "codex", "proxy-scope", null, sha256(context)]);
        return { ok: false, status: 409, headers: new Headers({ "x-fleet-health-attestation": signed.attestation, "x-fleet-health-attestation-signature": signed.attestationSignature }), text: async () => "scope mismatch" };
      }
      const context = options.headers["x-fleet-health-context"];
      const request = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
      const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], `ci_${Buffer.alloc(32, 2).toString("base64url")}`, "proxy/responses", "https://upstream.example", "oauth", "responses", "codex", "upstream-response", null, sha256(context)]);
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json", "x-fleet-health-attestation": signed.attestation, "x-fleet-health-attestation-signature": signed.attestationSignature }), text: async () => JSON.stringify({ id: "r", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "replacement" }] }] }) };
    },
  });
  await withServer(handler, async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: { Authorization: "Bearer frontdoor", "content-type": "application/json", "x-opencode-session-id": "session", "x-opencode-lease-id": "external-lease" }, body: JSON.stringify({ model: "real", input: "ping" }) });
    assert.equal(response.status, 200);
  });
  const replacement = calls.find((call) => call.path === "/lease");
  assert.deepEqual(replacement.body.excludeTargetIDs, ["original-target"]);
  assert.ok(calls.some((call) => call.path === "/complete" && call.body.leaseID === "temporary-lease"));
  assert.equal(calls.some((call) => ["/complete", "/failure", "/forget"].includes(call.path) && call.body.leaseID === "external-lease"), false);
});

test("a non-dispatch proxy-scope attestation must be verified and have null upstream status before rerouting", async () => {
  const key = Buffer.alloc(32, 17), protocol = createHealthProtocol({ key });
  for (const [name, signedStatus] of [['non-null upstream status', 409], ['unattested response', undefined]]) {
    const calls = [];
    const handler = createGatewayHandler({
      config: { tier: 'worker', profile: 'auto', providers: { openai: { baseUrl: 'http://upstream.example/v1' } } },
      gatewayKey: 'frontdoor', health: { key, gatewayCredential: 'private-health' }, now: () => 100,
      brokerRequest: async (path, body) => {
        calls.push({ path, body });
        if (path === '/lease/verify') return { held: true, leaseID: 'external-lease', expectedCredentialInstance: `ci_${Buffer.alloc(32, 2).toString('base64url')}`, target: { id: 'original-target', model: { providerID: 'openai', id: 'real' } } };
        if (path === '/model-health/begin') return { nonce: Buffer.alloc(32, 1).toString('base64url'), startedAt: 100, capability: Buffer.alloc(32, 3).toString('base64url') };
        return { ok: true };
      },
      fetchImpl: async (_url, options) => {
        if (signedStatus === undefined) return { ok: false, status: 409, headers: new Headers(), text: async () => 'scope mismatch' };
        const context = options.headers['x-fleet-health-context'];
        const request = JSON.parse(Buffer.from(context, 'base64url').toString('utf8'));
        const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], `ci_${Buffer.alloc(32, 2).toString('base64url')}`, 'proxy/responses', 'https://upstream.example', 'oauth', 'responses', 'codex', 'proxy-scope', signedStatus, sha256(context)]);
        return { ok: false, status: 409, headers: new Headers({ 'x-fleet-health-attestation': signed.attestation, 'x-fleet-health-attestation-signature': signed.attestationSignature }), text: async () => 'scope mismatch' };
      },
    });
    await withServer(handler, async (base) => {
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer frontdoor', 'content-type': 'application/json', 'x-opencode-session-id': 'session', 'x-opencode-lease-id': 'external-lease' }, body: JSON.stringify({ model: 'real', messages: [] }) });
      assert.equal(response.status, 502, name);
    });
    assert.equal(calls.filter((call) => call.path === '/lease').length, 0, name);
  }
});
