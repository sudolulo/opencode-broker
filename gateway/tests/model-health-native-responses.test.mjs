import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createHealthAuthority } from "../../lib/model-health.js";
import { makePolicy } from "../../tests/helpers/model-outages.mjs";
import { createGatewayHandler } from "../lib/gateway.js";
import { createHealthProtocol, verifyHealthReport } from "../lib/proxy-health-context.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const key = Buffer.alloc(32, 7);
const credentialInstance = `ci_${Buffer.alloc(32, 4).toString("base64url")}`;
const sessionID = "native-responses-session";
const leaseID = "externally-owned-responses-lease";
const wireModel = "gpt-6-1-sol";
const responseBody = (stream = false) => ({ model: wireModel, input: "ping", ...(stream ? { stream: true } : {}) });

const withServer = async (handler, run) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
};

const awaitReported = async (report) => {
  let timer;
  try {
    return await Promise.race([
      report.promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("health outcome was not reported")), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
};

const nativeHarness = ({ upstream }) => {
  const calls = [];
  const reported = deferred();
  const protocol = createHealthProtocol({ key });
  const scope = makePolicy().expectedScopePolicies["openai/sol/standard"];
  const assignment = Object.freeze({
    held: true, sessionID, leaseID, targetID: "external-responses-target", providerID: "openai",
    modelID: wireModel, wireModelID: wireModel, primaryID: wireModel,
    logicalID: "openai/sol/standard", purpose: "real", expectedScopePolicy: scope,
    expectedCredentialInstance: credentialInstance,
  });
  const assignmentSnapshot = structuredClone(assignment);
  const authority = createHealthAuthority({
    gatewayCredential: "private-health", now: () => 100, randomBytes: () => Buffer.alloc(32, 1),
    lookupLease: () => assignment, lookupGeneration: () => 0, latestFailureAt: () => null,
    verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding),
  });
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { openai: { baseUrl: "https://upstream.example/v1", responsesApi: true } } },
    gatewayKey: "frontdoor", health: { key, gatewayCredential: "private-health" }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === "/lease/verify") return { held: true, leaseID, expectedCredentialInstance: credentialInstance,
        target: { id: assignment.targetID, model: { providerID: assignment.providerID, id: wireModel } } };
      if (path === "/model-health/begin") return authority.issue(body);
      if (path === "/model-health/outcome") {
        const accepted = authority.accept(body);
        reported.resolve(accepted);
        return { accepted: true, result: accepted.outcome?.result };
      }
      return { ok: true };
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://upstream.example/v1/responses");
      assert.equal(options.body, JSON.stringify(responseBody(options.body.includes('"stream":true'))));
      const context = options.headers["x-fleet-health-context"];
      const request = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
      assert.equal(request[7], "openai");
      assert.equal(request[8], wireModel);
      assert.equal(request[9], sha256(options.body));
      assert.equal(request[10], credentialInstance);
      assert.equal(options.headers["x-fleet-health-forged"], undefined);
      return upstream({ protocol, request, context, options });
    },
  });
  const headers = {
    Authorization: "Bearer frontdoor", "content-type": "application/json",
    "x-opencode-session-id": sessionID, "x-opencode-lease-id": leaseID,
    "x-fleet-health-forged": "client-cannot-forge",
  };
  const assertExternalLeaseUntouched = () => {
    assert.equal(calls.some(({ path, body }) => ["/complete", "/failure", "/forget", "/release", "/usage"].includes(path)
      && (body?.sessionID === sessionID || body?.leaseID === leaseID)), false, "the gateway must not settle any external-session lease");
    assert.deepEqual(assignment, assignmentSnapshot, "health reporting must not mutate the trusted external assignment");
  };
  return { handler, headers, reported, calls, assertExternalLeaseUntouched, close: () => authority.close() };
};

const signedHeaders = (protocol, request, context, origin = "upstream-response", status = 200) => {
  const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], credentialInstance,
    "llm-auth-proxy/openai", "https://chatgpt.com", "chatgpt-oauth", "responses", "codex", origin, status, sha256(context)]);
  return new Headers({ "x-fleet-health-attestation": signed.attestation, "x-fleet-health-attestation-signature": signed.attestationSignature, "x-fleet-health-private": "never-client" });
};

test("native Responses buffered completion reports an authenticated terminal without settling its external lease", async () => {
  const fixture = nativeHarness({ upstream: ({ protocol, request, context }) => ({ ok: true, status: 200,
    headers: new Headers({ ...Object.fromEntries(signedHeaders(protocol, request, context)), "content-type": "application/json" }),
    text: async () => JSON.stringify({ object: "response", id: "resp_1", status: "completed", output: [] }),
  }) });
  await withServer(fixture.handler, async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: fixture.headers, body: JSON.stringify(responseBody()) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-fleet-health-private"), null);
    assert.deepEqual(await response.json(), { object: "response", id: "resp_1", status: "completed", output: [] });
  });
  try {
    const accepted = await awaitReported(fixture.reported);
    assert.equal(accepted.outcome.result, "success");
    fixture.assertExternalLeaseUntouched();
  } finally { fixture.close(); }
});

test("native Responses signed upstream 503 reports service-fault without settling its external lease", async () => {
  const fixture = nativeHarness({ upstream: ({ protocol, request, context }) => ({ ok: false, status: 503,
    headers: signedHeaders(protocol, request, context, "upstream-http", 503), text: async () => "unavailable",
  }) });
  await withServer(fixture.handler, async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: fixture.headers, body: JSON.stringify(responseBody()) });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /upstream openai HTTP 503/);
  });
  try {
    const accepted = await awaitReported(fixture.reported);
    assert.equal(accepted.outcome.result, "service-fault");
    fixture.assertExternalLeaseUntouched();
  } finally { fixture.close(); }
});

test("native Responses partial invalid SSE reports unknown without settling its external lease", async () => {
  const fixture = nativeHarness({ upstream: ({ protocol, request, context }) => ({ ok: true, status: 200,
    headers: new Headers({ ...Object.fromEntries(signedHeaders(protocol, request, context)), "content-type": "text/event-stream" }),
    body: (async function* () { yield "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"object\":\"response\",\"id\":\"resp_1\"}}\n\n"; yield "event: response.output_text.delta\ndata: not-json\n\n"; }()),
  }) });
  await withServer(fixture.handler, async (base) => {
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: fixture.headers, body: JSON.stringify(responseBody(true)) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response.created/);
  });
  try {
    const accepted = await awaitReported(fixture.reported);
    assert.equal(accepted.outcome.result, "unknown");
    fixture.assertExternalLeaseUntouched();
  } finally { fixture.close(); }
});

test("native Responses client cancellation after frames reports cancelled unknown without settling its external lease", async () => {
  const upstreamStarted = deferred();
  const fixture = nativeHarness({ upstream: ({ protocol, request, context, options }) => ({ ok: true, status: 200,
    headers: new Headers({ ...Object.fromEntries(signedHeaders(protocol, request, context)), "content-type": "text/event-stream" }),
    body: (async function* () {
      yield "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"object\":\"response\",\"id\":\"resp_1\"}}\n\n";
      yield "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"pong\"}\n\n";
      upstreamStarted.resolve();
      await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    }()),
  }) });
  await withServer(fixture.handler, async (base) => {
    const abort = new AbortController();
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: fixture.headers, body: JSON.stringify(responseBody(true)), signal: abort.signal });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /response.created/);
    await upstreamStarted.promise;
    abort.abort();
    await assert.rejects(reader.read(), /AbortError/);
  });
  try {
    const accepted = await awaitReported(fixture.reported);
    assert.equal(accepted.outcome.result, "unknown");
    assert.equal(fixture.calls.find(({ path }) => path === "/model-health/outcome").body.terminal.state, "cancelled");
    fixture.assertExternalLeaseUntouched();
  } finally { fixture.close(); }
});
