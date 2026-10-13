import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createHealthAuthority } from "../../lib/model-health.js";
import { makePolicy } from "../../tests/helpers/model-outages.mjs";
import { createGatewayHandler } from "../lib/gateway.js";
import { createHealthProtocol, verifyHealthReport } from "../lib/proxy-health-context.js";

const key = Buffer.alloc(32, 7);
const credentialInstance = `ci_${Buffer.alloc(32, 4).toString("base64url")}`;
const sessionID = "assembled-responses-session";
const leaseID = "externally-owned-assembled-lease";
const wireModel = "gpt-6-1-sol";
const body = { model: wireModel, input: "ping" };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const deferred = () => {
  let resolve;
  return { promise: new Promise((next) => { resolve = next; }), resolve };
};
const waitFor = async (promise, message) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 1000); })]);
  } finally { clearTimeout(timer); }
};
const withServer = async (handler, run) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};
const sse = (value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const stream = (chunks) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
});

const nativeHarness = ({ upstream }) => {
  const calls = [];
  const reported = deferred();
  const protocol = createHealthProtocol({ key });
  const scope = makePolicy().expectedScopePolicies["openai/sol/standard"];
  const assignment = Object.freeze({
    held: true, sessionID, leaseID, targetID: "external-assembled-target", providerID: "openai",
    modelID: wireModel, wireModelID: wireModel, primaryID: wireModel,
    logicalID: "openai/sol/standard", purpose: "real", expectedScopePolicy: scope,
    expectedCredentialInstance: credentialInstance,
  });
  const snapshot = structuredClone(assignment);
  const authority = createHealthAuthority({
    gatewayCredential: "private-health", now: () => 100, randomBytes: () => Buffer.alloc(32, 1),
    lookupLease: () => assignment, lookupGeneration: () => 0, latestFailureAt: () => null,
    verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding),
  });
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { openai: { baseUrl: "https://upstream.example/v1", responsesApi: true, assembleFromStream: true } } },
    gatewayKey: "frontdoor", health: { key, gatewayCredential: "private-health" }, now: () => 100,
    brokerRequest: async (path, request) => {
      calls.push({ path, body: request });
      if (path === "/lease/verify") return { held: true, leaseID, expectedCredentialInstance: credentialInstance,
        target: { id: assignment.targetID, model: { providerID: assignment.providerID, id: wireModel } } };
      if (path === "/model-health/begin") return authority.issue(request);
      if (path === "/model-health/outcome") {
        const accepted = authority.accept(request);
        reported.resolve(accepted);
        return { accepted: true, result: accepted.outcome?.result };
      }
      return { ok: true };
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://upstream.example/v1/responses");
      assert.equal(options.body, JSON.stringify({ ...body, stream: true }));
      const context = options.headers["x-fleet-health-context"];
      const request = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
      assert.equal(request[7], "openai");
      assert.equal(request[8], wireModel);
      assert.equal(request[9], sha256(options.body));
      assert.equal(request[10], credentialInstance);
      return upstream({ protocol, request, context, options });
    },
  });
  const headers = { Authorization: "Bearer frontdoor", "content-type": "application/json", "x-opencode-session-id": sessionID, "x-opencode-lease-id": leaseID };
  const assertExternalLeaseUntouched = () => {
    assert.equal(calls.some(({ path, body: request }) => ["/complete", "/failure", "/forget", "/release", "/usage"].includes(path)
      && (request?.sessionID === sessionID || request?.leaseID === leaseID)), false);
    assert.deepEqual(assignment, snapshot);
  };
  return { handler, headers, calls, reported, assertExternalLeaseUntouched, close: () => authority.close() };
};
const signedHeaders = (protocol, request, context) => {
  const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], credentialInstance,
    "llm-auth-proxy/openai", "https://chatgpt.com", "chatgpt-oauth", "responses", "codex", "upstream-response", 200, sha256(context)]);
  return new Headers({ "content-type": "text/event-stream", "x-fleet-health-attestation": signed.attestation, "x-fleet-health-attestation-signature": signed.attestationSignature });
};
const completed = { id: "resp_1", object: "response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } };

test("assembled Responses completion reports the original SSE terminal as accepted success", async () => {
  const fixture = nativeHarness({ upstream: ({ protocol, request, context }) => ({ ok: true, status: 200, headers: signedHeaders(protocol, request, context), body: stream([sse({ type: "response.completed", response: completed })]) }) });
  try {
    await withServer(fixture.handler, async (base) => {
      const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: fixture.headers, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), completed);
    });
    assert.equal((await waitFor(fixture.reported.promise, "health outcome was not reported")).outcome.result, "success");
    assert.equal(fixture.calls.filter(({ path }) => path === "/model-health/outcome").length, 1);
    fixture.assertExternalLeaseUntouched();
  } finally { fixture.close(); }
});

test("malformed assembled Responses SSE reports accepted unknown instead of service fault", async () => {
  const fixture = nativeHarness({ upstream: ({ protocol, request, context }) => ({ ok: true, status: 200, headers: signedHeaders(protocol, request, context), body: stream([sse("not-json")]) }) });
  try {
    await withServer(fixture.handler, async (base) => {
      const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: fixture.headers, body: JSON.stringify(body) });
      assert.equal(response.status, 502);
    });
    assert.equal((await waitFor(fixture.reported.promise, "health outcome was not reported")).outcome.result, "unknown");
    assert.equal(fixture.calls.filter(({ path }) => path === "/model-health/outcome").length, 1);
    fixture.assertExternalLeaseUntouched();
  } finally { fixture.close(); }
});

test("assembled Responses upstream read error reports accepted unknown instead of success", async () => {
  const fixture = nativeHarness({ upstream: ({ protocol, request, context }) => ({ ok: true, status: 200, headers: signedHeaders(protocol, request, context), body: (async function* () { yield sse({ type: "response.created", response: { id: "resp_1" } }); throw new Error("upstream read failed"); }()) }) });
  try {
    await withServer(fixture.handler, async (base) => {
      const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: fixture.headers, body: JSON.stringify(body) });
      assert.equal(response.status, 502);
    });
    assert.equal((await waitFor(fixture.reported.promise, "health outcome was not reported")).outcome.result, "unknown");
    assert.equal(fixture.calls.filter(({ path }) => path === "/model-health/outcome").length, 1);
    fixture.assertExternalLeaseUntouched();
  } finally { fixture.close(); }
});

test("client abort while assembling Responses reports accepted cancelled unknown", async () => {
  const upstreamStarted = deferred();
  const fixture = nativeHarness({ upstream: ({ protocol, request, context, options }) => ({ ok: true, status: 200, headers: signedHeaders(protocol, request, context), body: (async function* () {
    yield sse({ type: "response.created", response: { id: "resp_1" } });
    upstreamStarted.resolve();
    await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  }()) }) });
  try {
    await withServer(fixture.handler, async (base) => {
      const abort = new AbortController();
      const pending = fetch(`${base}/v1/responses`, { method: "POST", headers: fixture.headers, body: JSON.stringify(body), signal: abort.signal });
      await waitFor(upstreamStarted.promise, "upstream did not start");
      abort.abort();
      await assert.rejects(pending, /AbortError/);
    });
    const accepted = await waitFor(fixture.reported.promise, "health outcome was not reported");
    assert.equal(accepted.outcome.result, "unknown");
    assert.equal(fixture.calls.find(({ path }) => path === "/model-health/outcome").body.terminal.state, "cancelled");
    assert.equal(fixture.calls.filter(({ path }) => path === "/model-health/outcome").length, 1);
    fixture.assertExternalLeaseUntouched();
  } finally { fixture.close(); }
});
