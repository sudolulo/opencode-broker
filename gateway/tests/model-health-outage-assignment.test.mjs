import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createHealthAuthority } from "../../lib/model-health.js";
import { makePolicy } from "../../tests/helpers/model-outages.mjs";
import { createGatewayHandler } from "../lib/gateway.js";
import { createHealthProtocol, verifyHealthReport } from "../lib/proxy-health-context.js";

const key = Buffer.alloc(32, 23);
const credentialInstance = `ci_${Buffer.alloc(32, 9).toString("base64url")}`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const withServer = async (handler, run) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

const outageFixture = ({ api = "responses", issuer = "valid", consumedPurpose = "outage-health", upstream, onCall = () => {} }) => {
  const calls = [], policy = makePolicy().expectedScopePolicies[api === "messages" ? "anthropic/opus/standard" : "openai/sol/standard"];
  const providerID = policy.providerID, modelID = api === "messages" ? "claude-opus-5-5" : "gpt-6-1-sol";
  const sessionID = `gw-probe-${"s".repeat(43)}`, probeNonce = `pbn_${"n".repeat(43)}`, leaseID = "isolated-outage-lease";
  const assignment = { held: true, sessionID, leaseID, targetID: "isolated-target", providerID, modelID, wireModelID: modelID,
    primaryID: modelID, logicalID: api === "messages" ? "anthropic/opus/standard" : "openai/sol/standard", purpose: "outage-health",
    expectedScopePolicy: policy, expectedCredentialInstance: credentialInstance };
  const authority = createHealthAuthority({
    gatewayCredential: "private-health", now: () => 100, randomBytes: () => Buffer.alloc(32, 1),
    lookupLease: () => assignment, lookupGeneration: () => 0, latestFailureAt: () => null,
    verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding),
  });
  const protocol = createHealthProtocol({ key });
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { [providerID]: { baseUrl: "https://upstream.example/v1", ...(api === "messages" ? { messagesApi: true } : { responsesApi: true }) } } },
    gatewayKey: "frontdoor", health: { key, gatewayCredential: "private-health" }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      onCall(path, body);
      if (path === "/probe/consume") return { ...assignment, preferredModel: { providerID, modelID }, purpose: consumedPurpose };
      if (path === "/model-health/begin") return issuer === "valid" ? authority.issue(body) : { nonce: "bad", startedAt: "100", capability: "" };
      if (path === "/model-health/outcome") { authority.accept(body); return { ok: true }; }
      return { ok: true };
    },
    fetchImpl: async (url, options) => upstream({ url, options, protocol, api }),
  });
  const path = api === "messages" ? "/v1/messages" : "/v1/responses";
  const body = api === "messages"
    ? { model: "client-model", max_tokens: 16, messages: [{ role: "user", content: "ping" }] }
    : { model: "client-model", input: "ping" };
  const headers = { Authorization: "Bearer frontdoor", "content-type": "application/json", "x-opencode-probe-purpose": "outage-health", "x-opencode-probe-session": sessionID, "x-opencode-probe-nonce": probeNonce };
  const assertIsolated = () => {
    assert.equal(calls.some(({ path }) => ["/lease", "/complete", "/failure", "/forget", "/release", "/usage"].includes(path)), false, "outage assignment must never use ordinary broker settlement");
    assert.deepEqual(calls.filter(({ path }) => path === "/probe/release").map(({ body }) => body), [{ sessionID, probeNonce, leaseID, purpose: "outage-health" }]);
  };
  return { handler, path, body, headers, calls, assignment, protocol, authority, assertIsolated };
};

const signed = (fixture, options, status = 200) => {
  const context = options.headers["x-fleet-health-context"];
  const request = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
  const policy = fixture.assignment.expectedScopePolicy;
  const response = fixture.protocol.signResponse([1, request[1], request[4], request[5], request[8], credentialInstance,
    policy.connectionID, "https://upstream.example", policy.authMode, policy.transport, policy.product, "upstream-response", status, sha256(context)]);
  return new Headers({ "x-fleet-health-attestation": response.attestation, "x-fleet-health-attestation-signature": response.attestationSignature, "content-type": "application/json" });
};

test("isolated outage assignments bind Messages and Responses directly, then release exactly once", async () => {
  for (const api of ["messages", "responses"]) {
    let fixture;
    fixture = outageFixture({ api, upstream: async ({ url, options }) => {
      assert.match(url, new RegExp(`/${api}$`));
      assert.equal(JSON.parse(options.body).model, fixture.assignment.wireModelID);
      return { ok: true, status: 200, headers: signed(fixture, options), text: async () => api === "messages"
        ? JSON.stringify({ type: "message", id: "m", role: "assistant", content: [], stop_reason: "end_turn" })
        : JSON.stringify({ object: "response", id: "r", status: "completed", output: [] }) };
    } });
    await withServer(fixture.handler, async (base) => {
      const response = await fetch(`${base}${fixture.path}`, { method: "POST", headers: fixture.headers, body: JSON.stringify(fixture.body) });
      assert.equal(response.status, 200);
    });
    fixture.assertIsolated(); fixture.authority.close();
  }
});

test("isolated outage assignment does not settle ordinary leases after upstream 409/503 or fetch rejection", async () => {
  for (const mode of ["409", "503", "reject"]) {
    let fixture;
    fixture = outageFixture({ upstream: async ({ options }) => mode === "reject"
      ? Promise.reject(new Error("offline"))
      : ({ ok: false, status: Number(mode), headers: signed(fixture, options, Number(mode)), text: async () => "unavailable" }) });
    await withServer(fixture.handler, async (base) => {
      const response = await fetch(`${base}${fixture.path}`, { method: "POST", headers: fixture.headers, body: JSON.stringify(fixture.body) });
      assert.equal(response.status, 502);
    });
    fixture.assertIsolated(); fixture.authority.close();
  }
});

test("isolated outage assignment releases when health issuance is malformed", async () => {
  const fixture = outageFixture({ issuer: "malformed", upstream: async () => { throw new Error("must not forward"); } });
  await withServer(fixture.handler, async (base) => {
    const response = await fetch(`${base}${fixture.path}`, { method: "POST", headers: fixture.headers, body: JSON.stringify(fixture.body) });
    assert.equal(response.status, 502);
  });
  fixture.assertIsolated(); fixture.authority.close();
});

test("outage claim rejects a generic consume and releases it without provider traffic", async () => {
  let forwards = 0;
  const fixture = outageFixture({ consumedPurpose: null, upstream: async () => { forwards += 1; throw new Error("must not forward"); } });
  await withServer(fixture.handler, async (base) => {
    const response = await fetch(`${base}${fixture.path}`, { method: "POST", headers: fixture.headers, body: JSON.stringify(fixture.body) });
    assert.equal(response.status, 403);
  });
  assert.equal(forwards, 0);
  assert.deepEqual(fixture.calls.filter(({ path }) => path === "/probe/release").map(({ body }) => body), [{ sessionID: fixture.assignment.sessionID, probeNonce: `pbn_${"n".repeat(43)}` }]);
  fixture.authority.close();
});

test("outage assignment with wrong required API rejects before provider traffic and releases exactly", async () => {
  let forwards = 0;
  const fixture = outageFixture({ api: "responses", upstream: async () => { forwards += 1; throw new Error("must not forward"); } });
  fixture.assignment.expectedScopePolicy = { ...fixture.assignment.expectedScopePolicy, probe: { ...fixture.assignment.expectedScopePolicy.probe, api: "messages" } };
  await withServer(fixture.handler, async (base) => {
    const response = await fetch(`${base}${fixture.path}`, { method: "POST", headers: fixture.headers, body: JSON.stringify(fixture.body) });
    assert.equal(response.status, 403);
  });
  assert.equal(forwards, 0); fixture.assertIsolated(); fixture.authority.close();
});

test("aborted isolated outage request releases its exact assignment without ordinary settlement", async () => {
  let startedResolve, releasedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const released = new Promise((resolve) => { releasedResolve = resolve; });
  const fixture = outageFixture({
    onCall: (path) => { if (path === "/probe/release") releasedResolve(); },
    upstream: async ({ options }) => {
      startedResolve();
      await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    },
  });
  await withServer(fixture.handler, async (base) => {
    const abort = new AbortController();
    const request = fetch(`${base}${fixture.path}`, { method: "POST", headers: fixture.headers, body: JSON.stringify(fixture.body), signal: abort.signal });
    await started;
    abort.abort();
    await assert.rejects(request, /AbortError/);
    await released;
  });
  fixture.assertIsolated(); fixture.authority.close();
});
