// Health request identity: every actual inbound HTTP request gets its own server-generated
// requestID, and every upstream attempt inside it its own attemptID. The broker's outage reducer
// dedupes failures by attemptID and diagnoses only after 3 failures across 2 distinct requestIDs,
// so identities derived from the attempt index alone (shared by every request on a held session,
// and by every gw- request's first attempt) made a diagnosis impossible. These tests drive the
// real HTTP gateway against the real health authority and the real reducer; only the upstream
// provider (fetchImpl) and the broker transport are offline fakes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createHealthAuthority } from "../../lib/model-health.js";
import { emptyOutages, nextProbe, reduceOutages } from "../../lib/model-outages.js";
import { makeBaseline, makePolicy } from "../../tests/helpers/model-outages.mjs";
import { createGatewayHandler } from "../lib/gateway.js";
import { createHealthProtocol, verifyHealthReport } from "../lib/proxy-health-context.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = Buffer.alloc(32, 8);
const credentialInstance = `ci_${Buffer.alloc(32, 5).toString("base64url")}`;
const primaryID = "claude-opus-5-5";
const logicalID = "anthropic/opus/standard";
const policy = makePolicy();
const scopePolicy = policy.expectedScopePolicies[logicalID];
const messageBody = (model = primaryID) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "ping" }] });

const withServer = async (handler, run) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

// A broker stand-in whose health endpoints are the REAL authority feeding the REAL reducer. The
// clock is shared and strictly monotonic so every ticket starts after the latest recorded failure.
const harness = ({ external, sleepImpl, failFirstDelivery = false }) => {
  let clock = 10_000;
  const now = () => ++clock;
  let state = reduceOutages(emptyOutages(), makeBaseline({ credentialInstance, startedAt: 1, finishedAt: 2 }), { policy, now: 3 });
  const instance = () => state.scopes[logicalID]?.instances[credentialInstance];
  const calls = [];
  const begins = [];
  const deliveries = [];
  const leases = new Map();
  let leaseCount = 0;
  const externalAssignment = Object.freeze({
    held: true, sessionID: "held-session", leaseID: "held-lease", targetID: primaryID, providerID: "anthropic",
    modelID: primaryID, wireModelID: primaryID, primaryID, logicalID, purpose: "real",
    expectedScopePolicy: scopePolicy, expectedCredentialInstance: credentialInstance,
  });
  if (external) leases.set(externalAssignment.leaseID, externalAssignment);
  const authority = createHealthAuthority({
    gatewayCredential: "private-health",
    now,
    lookupLease: (input) => leases.get(input.leaseID) ?? null,
    lookupGeneration: (id) => state.scopes[id]?.generation ?? 0,
    latestFailureAt: (id, instanceID) => state.scopes[id]?.instances[instanceID]?.lastPrimaryFailureAt ?? null,
    verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding),
  });
  const protocol = createHealthProtocol({ key });
  const handler = createGatewayHandler({
    config: {
      tier: "worker", profile: "auto",
      modelProfiles: { opus: "cloud" },
      providers: { anthropic: { baseUrl: "https://upstream.example/v1", messagesApi: true } },
    },
    gatewayKey: "frontdoor",
    health: { key, gatewayCredential: "private-health" },
    now,
    sleepImpl,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === "/lease/verify") {
        return { held: true, leaseID: externalAssignment.leaseID, expectedCredentialInstance: credentialInstance,
          target: { id: primaryID, model: { providerID: "anthropic", id: primaryID } } };
      }
      if (path === "/lease") {
        leaseCount += 1;
        const leaseID = `ordinary-lease-${leaseCount}`;
        leases.set(leaseID, { held: true, sessionID: body.sessionID, leaseID, targetID: primaryID, providerID: "anthropic",
          modelID: primaryID, wireModelID: primaryID, primaryID, logicalID, purpose: "real",
          expectedScopePolicy: scopePolicy, expectedCredentialInstance: null });
        return { leaseID, target: { id: primaryID, model: { providerID: "anthropic", id: primaryID } } };
      }
      if (path === "/model-health/begin") {
        begins.push({ requestID: body.requestID, attemptID: body.attemptID, sessionID: body.sessionID });
        return authority.issue(body);
      }
      if (path === "/model-health/outcome") {
        deliveries.push(structuredClone(body));
        if (failFirstDelivery && deliveries.length === 1) throw new Error("broker briefly unreachable");
        const accepted = authority.accept(body);
        if (accepted.outcome) {
          state = reduceOutages(state, accepted.outcome, { policy, now: now() });
          authority.markApplied(body.capability);
        }
        return { accepted: true, result: accepted.outcome?.result };
      }
      return { ok: true };
    },
    fetchImpl: async (_url, options) => {
      const context = options.headers["x-fleet-health-context"];
      assert.ok(context, "every attempt carries a signed health context");
      const request = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
      const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], credentialInstance,
        scopePolicy.connectionID, "https://api.anthropic.com", scopePolicy.authMode, scopePolicy.transport, scopePolicy.product,
        "upstream-http", 503, sha256(context)]);
      return { ok: false, status: 503,
        headers: new Headers({ "x-fleet-health-attestation": signed.attestation, "x-fleet-health-attestation-signature": signed.attestationSignature }),
        text: async () => "unavailable" };
    },
  });
  return {
    handler, calls, begins, deliveries, instance,
    probe: () => nextProbe(state, policy, now()),
    close: () => authority.close(),
  };
};

const failures = (fixture) => fixture.instance()?.episode?.failures ?? [];

test("three HTTP requests on one held external session are three distinct health requests and reach diagnosis", async () => {
  const fixture = harness({ external: true });
  try {
    await withServer(fixture.handler, async (base) => {
      for (let turn = 0; turn < 3; turn += 1) {
        const response = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: { Authorization: "Bearer frontdoor", "content-type": "application/json",
            "x-opencode-session-id": "held-session", "x-opencode-lease-id": "held-lease" },
          body: JSON.stringify(messageBody()),
        });
        assert.equal(response.status, 502);
        await response.text();
      }
    });
    // A held session gets exactly one attempt per HTTP request.
    assert.equal(fixture.begins.length, 3);
    const requestIDs = fixture.begins.map((begin) => begin.requestID);
    assert.equal(new Set(requestIDs).size, 3, "each HTTP request has its own requestID");
    assert.equal(new Set(fixture.begins.map((begin) => begin.attemptID)).size, 3, "each attempt has its own attemptID");
    for (const begin of fixture.begins) {
      assert.match(begin.requestID, UUID, "requestID is server-generated, not caller- or session-derived");
      assert.equal(begin.attemptID, `${begin.requestID}:0`);
    }
    // Reducer proof: three service faults from three requests, diagnosed, and a reserve probe is due.
    assert.equal(failures(fixture).length, 3);
    assert.equal(fixture.instance().episode.diagnosed, true);
    assert.deepEqual(fixture.probe(), { logicalID, targetID: policy.mappings[primaryID][0], kind: "reserve" });
    // The external lease belongs to the session's own router: no settlement from the gateway.
    assert.equal(fixture.calls.some(({ path, body }) => ["/complete", "/failure", "/forget", "/release", "/usage"].includes(path)
      && (body?.sessionID === "held-session" || body?.leaseID === "held-lease")), false);
  } finally { fixture.close(); }
});

test("a gateway retry keeps one requestID with distinct attemptIDs and never counts as a second request", async () => {
  const fixture = harness({ external: false });
  const send = (base) => fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { Authorization: "Bearer frontdoor", "content-type": "application/json" },
    body: JSON.stringify(messageBody("opus")),
  }).then(async (response) => { await response.text(); return response.status; });
  try {
    await withServer(fixture.handler, async (base) => {
      assert.ok(await send(base) >= 500);
      // One inbound request, two upstream attempts.
      assert.equal(fixture.begins.length, 2);
      const [first, second] = fixture.begins;
      assert.match(first.requestID, UUID);
      assert.equal(second.requestID, first.requestID, "a retry stays inside its HTTP request");
      assert.notEqual(second.attemptID, first.attemptID, "each actual attempt is distinct");
      assert.deepEqual([first.attemptID, second.attemptID], [`${first.requestID}:0`, `${first.requestID}:1`]);
      // Reducer: both attempts recorded, but one request is never enough to diagnose.
      assert.equal(failures(fixture).length, 2);
      assert.equal(new Set(failures(fixture).map((failure) => failure.requestID)).size, 1);
      assert.equal(fixture.instance().episode.diagnosed, false);
      assert.equal(fixture.probe(), null);

      assert.ok(await send(base) >= 500);
    });
    assert.equal(fixture.begins.length, 4);
    assert.notEqual(fixture.begins[2].requestID, fixture.begins[0].requestID, "a new HTTP request gets a new requestID");
    assert.equal(fixture.begins[3].requestID, fixture.begins[2].requestID);
    assert.equal(failures(fixture).length, 4);
    assert.equal(fixture.instance().episode.diagnosed, true);
  } finally { fixture.close(); }
});

test("a redelivered health report carries the exact same identities and capability", async () => {
  const fixture = harness({ external: true, sleepImpl: async () => {}, failFirstDelivery: true });
  try {
    await withServer(fixture.handler, async (base) => {
      const response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { Authorization: "Bearer frontdoor", "content-type": "application/json",
          "x-opencode-session-id": "held-session", "x-opencode-lease-id": "held-lease" },
        body: JSON.stringify(messageBody()),
      });
      assert.equal(response.status, 502);
      await response.text();
    });
    assert.equal(fixture.deliveries.length, 2);
    assert.deepEqual(fixture.deliveries[1], fixture.deliveries[0], "delivery retry resends the identical report");
    const request = JSON.parse(Buffer.from(fixture.deliveries[0].context, "base64url").toString("utf8"));
    assert.equal(request[4], fixture.begins[0].requestID);
    assert.equal(request[5], fixture.begins[0].attemptID);
    assert.equal(failures(fixture).length, 1);
  } finally { fixture.close(); }
});
