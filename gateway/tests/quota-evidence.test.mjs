import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQuotaEvidenceBrokerRequest } from "../../lib/client.js";
import { createHealthAuthority } from "../../lib/model-health.js";
import { makePolicy } from "../../tests/helpers/model-outages.mjs";
import { createGatewayHandler } from "../lib/gateway.js";
import { createHealthProtocol, verifyHealthReport } from "../lib/proxy-health-context.js";

const withServer = async (handler, run, observe = null) => {
  const server = createServer((request, response) => { observe?.(request, response); void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

const deferred = () => {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
};

// Rejects with `message` unless `promise` settles within `ms`; the guard timer never outlives it.
const within = async (promise, ms, message) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
};

// True when `promise` settles inside a bounded observation window, false when the window closes first.
const settlesWithin = async (promise, ms) => {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally { clearTimeout(timer); }
};

const runBound429 = async ({
  body,
  headers = new Headers(),
  sessionID = "ses_quota",
  quotaEvidenceRequest,
  providerID = "openai",
  modelID = "gpt-test",
  path = "/v1/responses",
  requestBody = { model: modelID, input: "ping" },
  onResponse = null,
}) => {
  const calls = [];
  const diagnostics = [];
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { [providerID]: { baseUrl: "https://upstream.example/v1", ...(providerID === "openai" ? { responsesApi: true } : {}) } } },
    gatewayKey: "frontdoor", now: () => 1_000_000,
    brokerRequest: async (path, request) => {
      calls.push({ path, request });
      if (path === "/lease/verify") return { held: true, leaseID: "lease_current", target: { id: "target_current", model: { providerID, id: modelID } } };
      if (path === "/quota-evidence") return quotaEvidenceRequest(path, request);
      throw new Error(`unexpected broker path ${path}`);
    },
    fetchImpl: async () => ({ ok: false, status: 429, headers, text: async () => body }),
    logLine: (line) => diagnostics.push(line),
  });
  let response;
  await withServer(handler, async (base) => {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer frontdoor", "content-type": "application/json", "x-opencode-session-id": sessionID, "x-opencode-lease-id": "caller_lease" },
      body: JSON.stringify(requestBody),
    });
  }, onResponse);
  return { response, calls, diagnostics };
};

test("bound typed 429 awaits one quota observation from native headers before forwarding the unchanged source error", async () => {
  const gate = deferred();
  const observationStarted = deferred();
  const serverFinished = deferred();
  const observed = [];
  const events = [];
  const result = runBound429({
    body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }),
    headers: new Headers({ "x-codex-rate-limit-reached-type": "rate_limit_reached" }),
    // Server-side: 'finish' fires once the gateway has handed its whole reply to the socket.
    onResponse: (_request, response) => response.once("finish", () => {
      events.push("server-response-finished");
      serverFinished.resolve();
    }),
    quotaEvidenceRequest: async (path, body) => {
      observed.push({ path, body });
      events.push("observation-started");
      observationStarted.resolve();
      await gate.promise;
      events.push("acknowledged");
      return { ok: true, accepted: true };
    },
  }).then((value) => { events.push("client-response-received"); return value; });
  try {
    await within(observationStarted.promise, 1000, "quota observation was not attempted");
    assert.equal(observed.length, 1, "the gateway observes the raw native provider response");
    // The acknowledgement is withheld. A gateway that did not await it would write the 502 within
    // milliseconds; a 250 ms window with no server-side 'finish' and no client reply proves it waits.
    assert.equal(await settlesWithin(serverFinished.promise, 250), false,
      "gateway answered the client before the quota observation was acknowledged");
    assert.deepEqual(events, ["observation-started"], "the client response is still pending before the acknowledgement");
  } finally {
    // Always release the stub so the gateway answers and the HTTP server can close.
    gate.resolve();
    await result.catch(() => {});
  }
  const { response, calls } = await result;
  assert.deepEqual(events.slice(0, 2), ["observation-started", "acknowledged"]);
  assert.deepEqual([...events.slice(2)].sort(), ["client-response-received", "server-response-finished"]);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /upstream openai HTTP 429/);
  assert.deepEqual(observed, [{ path: "/quota-evidence", body: {
    sessionID: "ses_quota", leaseID: "lease_current", targetID: "target_current",
    subscriptionQuota: { version: 1, kind: "openai-usage-limit", window: "usage_limit", resetAtMs: 1_060_000 },
  } }]);
  assert.equal(calls.some(({ path }) => ["/failure", "/usage", "/complete", "/release", "/forget"].includes(path)), false);
});

test("bound Anthropic unified 429 observes the native typed headers", async () => {
  const observed = [];
  const result = await runBound429({
    providerID: "anthropic",
    modelID: "claude-test",
    path: "/v1/messages",
    requestBody: { model: "claude-test", max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    body: JSON.stringify({ error: { type: "rate_limit_error" } }),
    headers: new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": "1060",
    }),
    quotaEvidenceRequest: async (path, body) => { observed.push({ path, body }); return { ok: true, accepted: true }; },
  });
  assert.equal(result.response.status, 502);
  assert.deepEqual(observed, [{ path: "/quota-evidence", body: {
    sessionID: "ses_quota", leaseID: "lease_current", targetID: "target_current",
    subscriptionQuota: { version: 1, kind: "anthropic-unified", window: "five_hour", resetAtMs: 1_060_000 },
  } }]);
  assert.equal(result.calls.some(({ path }) => ["/failure", "/usage", "/complete", "/release", "/forget"].includes(path)), false);
});

test("caller flags, billing Codex headers, and non-durable sessions never create quota observations", async () => {
  const observed = [];
  const quotaEvidenceRequest = async (...args) => { observed.push(args); return { ok: true, accepted: true }; };
  for (const fixture of [
    { body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60, message: "quota" } }), headers: new Headers({ "x-codex-rate-limit-reached-type": "credits_depleted" }) },
    { body: JSON.stringify({ error: { message: "quota", resets_in_seconds: 60 } }), headers: new Headers({ "retry-after": "60", "x-caller-quota": "true" }) },
    { body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }), headers: new Headers(), sessionID: "gw-caller-flag" },
  ]) await runBound429({ ...fixture, quotaEvidenceRequest });
  assert.equal(observed.length, 0);
});

// A real outage-health probe through the trusted probe handler: consumed assignment, verified
// health ticket and an attested typed 429 from the assigned upstream. Only synthetic local stubs.
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const runOutageProbe429 = async (sessionID) => {
  const key = Buffer.alloc(32, 29);
  const credentialInstance = `ci_${Buffer.alloc(32, 11).toString("base64url")}`;
  const policy = makePolicy().expectedScopePolicies["openai/sol/standard"];
  const providerID = policy.providerID, modelID = "gpt-6-1-sol";
  const probeNonce = `pbn_${"n".repeat(43)}`, leaseID = "isolated-outage-lease";
  const assignment = { held: true, sessionID, leaseID, targetID: "isolated-target", providerID, modelID, wireModelID: modelID,
    primaryID: modelID, logicalID: "openai/sol/standard", purpose: "outage-health",
    expectedScopePolicy: policy, expectedCredentialInstance: credentialInstance };
  const authority = createHealthAuthority({
    gatewayCredential: "private-health", now: () => 100, randomBytes: () => Buffer.alloc(32, 1),
    lookupLease: () => assignment, lookupGeneration: () => 0, latestFailureAt: () => null,
    verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding),
  });
  const protocol = createHealthProtocol({ key });
  const calls = [];
  let forwards = 0;
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { [providerID]: { baseUrl: "https://upstream.example/v1", responsesApi: true } } },
    gatewayKey: "frontdoor", health: { key, gatewayCredential: "private-health" }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === "/probe/consume") return { ...assignment, preferredModel: { providerID, modelID } };
      if (path === "/model-health/begin") return authority.issue(body);
      if (path === "/model-health/outcome") { authority.accept(body); return { ok: true }; }
      if (path === "/quota-evidence") return { ok: true, accepted: true };
      return { ok: true };
    },
    fetchImpl: async (_url, options) => {
      forwards += 1;
      const context = options.headers["x-fleet-health-context"];
      const request = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
      const signedReply = protocol.signResponse([1, request[1], request[4], request[5], request[8], credentialInstance,
        policy.connectionID, "https://upstream.example", policy.authMode, policy.transport, policy.product, "upstream-response", 429, sha256(context)]);
      return {
        ok: false, status: 429,
        headers: new Headers({
          "x-fleet-health-attestation": signedReply.attestation,
          "x-fleet-health-attestation-signature": signedReply.attestationSignature,
          "content-type": "application/json",
          "x-codex-rate-limit-reached-type": "rate_limit_reached",
        }),
        text: async () => JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }),
      };
    },
  });
  try {
    let status;
    await withServer(handler, async (base) => {
      const response = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer frontdoor", "content-type": "application/json", "x-opencode-probe-purpose": "outage-health", "x-opencode-probe-session": sessionID, "x-opencode-probe-nonce": probeNonce },
        body: JSON.stringify({ model: "client-model", input: "ping" }),
      });
      status = response.status;
      await response.text();
    });
    return { status, calls, forwards, probeNonce, leaseID };
  } finally { authority.close(); }
};

test("an outage-health probe that meets a typed 429 never reports quota evidence", async () => {
  const sessionID = `gw-probe-${"p".repeat(43)}`;
  const { status, calls, forwards, probeNonce, leaseID } = await runOutageProbe429(sessionID);
  assert.equal(status, 502);
  assert.equal(forwards, 1, "the probe reached its assigned upstream exactly once");
  assert.ok(calls.some(({ path }) => path === "/model-health/outcome"), "the 429 went through the error branch that observes quota");
  assert.equal(calls.some(({ path }) => path === "/quota-evidence"), false);
  assert.deepEqual(calls.filter(({ path }) => path === "/probe/release").map(({ body }) => body), [{ sessionID, probeNonce, leaseID, purpose: "outage-health" }]);
  assert.equal(calls.some(({ path }) => ["/lease", "/failure", "/usage", "/complete", "/release", "/forget"].includes(path)), false);
});

test("an outage-health probe context never reports quota evidence even under a native session id", async () => {
  // Today the probe ingress gate refuses a non gw-probe- session with 400 before consume. This pins
  // the observation boundary on its own: whatever ingress admits, an outage assignment is not a
  // session lease and its 429 must never become subscription quota evidence.
  const { status, calls } = await runOutageProbe429(`ses_${"Q".repeat(43)}`);
  assert.ok([400, 502].includes(status), `unexpected status ${status}`);
  assert.equal(calls.some(({ path }) => path === "/quota-evidence"), false);
});

test("quota observation rejection preserves the source error and emits no settlement", async () => {
  const result = await runBound429({
    body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }),
    quotaEvidenceRequest: async () => ({ ok: true, accepted: false }),
  });
  assert.equal(result.response.status, 502);
  assert.match(await result.response.text(), /upstream openai HTTP 429/);
  assert.equal(result.diagnostics[0], JSON.stringify({ event: "quota_evidence_rejected" }));
  assert.equal(result.calls.some(({ path }) => path === "/failure"), false);
});

// A real bounded quota-evidence transport against a local Unix-socket broker stub, so the
// gateway sees exactly the rejection shape the production transport produces.
const withBrokerSocket = async (handler, run) => {
  const root = mkdtempSync(join(tmpdir(), "gateway-quota-evidence-"));
  const socketPath = join(root, "broker.sock");
  const server = createServer(handler);
  const connections = new Set();
  server.on("connection", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try { return await run(socketPath); }
  finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
};

// Only the quota-evidence diagnostics; the ordinary request_failed line is not under test here.
const quotaDiagnostics = ({ diagnostics }) => diagnostics.filter((line) => line.includes('"event":"quota_evidence_'));

test("a lease that is not a continuation source is refused silently and the client keeps its normal error", async () => {
  let brokerCalls = 0;
  const result = await withBrokerSocket((_request, response) => {
    brokerCalls += 1;
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "quota evidence refused", code: "not-a-continuation-source" }));
  }, async (socketPath) => runBound429({
    body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }),
    quotaEvidenceRequest: createQuotaEvidenceBrokerRequest({ socketPath }),
  }));
  assert.equal(result.response.status, 502);
  assert.match(await result.response.text(), /upstream openai HTTP 429/);
  assert.deepEqual(quotaDiagnostics(result), []);
  assert.equal(brokerCalls, 1);
  assert.equal(result.calls.filter(({ path }) => path === "/quota-evidence").length, 1);
  assert.equal(result.calls.some(({ path }) => ["/failure", "/usage", "/complete", "/release", "/forget"].includes(path)), false);
});

test("any other broker refusal code still logs the static delivery-failed diagnostic", async () => {
  const result = await withBrokerSocket((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "quota evidence refused", code: "quota-evidence-conflict" }));
  }, async (socketPath) => runBound429({
    body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }),
    quotaEvidenceRequest: createQuotaEvidenceBrokerRequest({ socketPath }),
  }));
  assert.equal(result.response.status, 502);
  assert.deepEqual(quotaDiagnostics(result), [JSON.stringify({ event: "quota_evidence_delivery_failed" })]);
});

test("a broker transport timeout still logs the static delivery-failed diagnostic", async () => {
  let brokerCalls = 0;
  const result = await withBrokerSocket(() => { brokerCalls += 1; /* never answers */ }, async (socketPath) => runBound429({
    body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }),
    quotaEvidenceRequest: createQuotaEvidenceBrokerRequest({ socketPath, timeoutMs: 30 }),
  }));
  assert.equal(result.response.status, 502);
  assert.match(await result.response.text(), /upstream openai HTTP 429/);
  assert.deepEqual(quotaDiagnostics(result), [JSON.stringify({ event: "quota_evidence_delivery_failed" })]);
  assert.equal(brokerCalls, 1);
});

test("an ordinary non-quota 429 on a bound session lease never posts quota evidence", async () => {
  const observed = [];
  const result = await runBound429({
    body: JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }),
    headers: new Headers({ "retry-after": "5" }),
    quotaEvidenceRequest: async (...args) => { observed.push(args); return { ok: true, accepted: true }; },
  });
  assert.equal(result.response.status, 502);
  assert.equal(observed.length, 0);
  assert.equal(result.calls.filter(({ path }) => path === "/quota-evidence").length, 0);
  assert.deepEqual(quotaDiagnostics(result), []);
});

test("quota observation transport failures preserve the source error with a static diagnostic", async () => {
  const result = await runBound429({
    body: JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }),
    quotaEvidenceRequest: async () => { throw new Error("raw upstream body must not be logged"); },
  });
  assert.equal(result.response.status, 502);
  assert.match(await result.response.text(), /upstream openai HTTP 429/);
  assert.equal(result.diagnostics[0], JSON.stringify({ event: "quota_evidence_delivery_failed" }));
  assert.equal(result.diagnostics[0].includes("raw upstream"), false);
  assert.equal(result.calls.filter(({ path }) => path === "/quota-evidence").length, 1);
  assert.equal(result.calls.some(({ path }) => ["/failure", "/usage", "/complete", "/release", "/forget"].includes(path)), false);
});
