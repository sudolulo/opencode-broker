// Fast outage scope through the gateway: the TRUSTED consumed assignment (never a caller header)
// turns a native Messages forward into base model + speed "fast" + the fast-mode beta, the signed
// context binds that final body, issuance carries speed "fast", and only the upstream's own
// usage.speed "fast" can make the authority record success.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { createHealthAuthority } from "../../lib/model-health.js";
import { makePolicy } from "../../tests/helpers/model-outages.mjs";
import { createGatewayHandler } from "../lib/gateway.js";
import { createGatewayHealth, createTerminalParser } from "../lib/model-health.js";
import { createHealthProtocol, verifyHealthReport } from "../lib/proxy-health-context.js";

const key = Buffer.alloc(32, 23);
const credentialInstance = `ci_${Buffer.alloc(32, 9).toString("base64url")}`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const FAST_BETA = "fast-mode-2026-02-01";

// ---- terminal parser: ACTUAL usage.speed only ----

const sse = (...events) => events.map((value) => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join("");
const messageEvents = ({ startSpeed, deltaSpeed } = {}) => [
  { type: "message_start", message: { type: "message", id: "m", role: "assistant", usage: { input_tokens: 3, ...(startSpeed === undefined ? {} : { speed: startSpeed }) } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1, ...(deltaSpeed === undefined ? {} : { speed: deltaSpeed }) } },
  { type: "message_stop" },
];
// Push in 7-byte pieces so frames, CRLF pairs and multi-byte boundaries are split.
const parseSSE = (api, text) => {
  const parser = createTerminalParser(api);
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += 7) parser.push(bytes.subarray(offset, offset + 7));
  return parser.finish({ status: 200, contentType: "text/event-stream" });
};
const parseJSON = (api, value) => {
  const parser = createTerminalParser(api);
  parser.push(JSON.stringify(value));
  return parser.finish({ status: 200, contentType: "application/json" });
};
const ok = (api, extra = {}) => ({ api, state: "complete", status: 200, errorClass: null, ...extra });
const invalid = (api) => ({ api, state: "invalid", status: 200, errorClass: "validation" });

test("Messages SSE retains consistent actual usage.speed across split frames", () => {
  assert.deepEqual(parseSSE("messages", sse(...messageEvents({ startSpeed: "fast", deltaSpeed: "fast" }))), ok("messages", { speed: "fast" }));
  assert.deepEqual(parseSSE("messages", sse(...messageEvents({ deltaSpeed: "fast" }))), ok("messages", { speed: "fast" }));
  assert.deepEqual(parseSSE("messages", sse(...messageEvents({ startSpeed: "standard" }))), ok("messages", { speed: "standard" }));
});

test("Messages SSE without usage.speed omits the key entirely", () => {
  const terminal = parseSSE("messages", sse(...messageEvents()));
  assert.deepEqual(terminal, ok("messages"));
  assert.equal(Object.hasOwn(terminal, "speed"), false);
  assert.deepEqual(parseSSE("messages", sse(...messageEvents({ startSpeed: null }))), ok("messages"), "null is absence, not evidence");
});

test("Messages SSE with conflicting or unsupported usage.speed is invalid, never fast", () => {
  assert.deepEqual(parseSSE("messages", sse(...messageEvents({ startSpeed: "fast", deltaSpeed: "standard" }))), invalid("messages"));
  assert.deepEqual(parseSSE("messages", sse(...messageEvents({ startSpeed: "turbo" }))), invalid("messages"));
  assert.deepEqual(parseSSE("messages", sse(...messageEvents({ deltaSpeed: 1 }))), invalid("messages"));
});

test("Messages and Chat JSON read only the response usage.speed", () => {
  const message = { type: "message", id: "m", role: "assistant", content: [], stop_reason: "end_turn" };
  assert.deepEqual(parseJSON("messages", { ...message, usage: { output_tokens: 1, speed: "fast" } }), ok("messages", { speed: "fast" }));
  assert.deepEqual(parseJSON("messages", { ...message, usage: { output_tokens: 1 } }), ok("messages"));
  assert.deepEqual(parseJSON("messages", { ...message, speed: "fast" }), ok("messages"), "a top-level echo is not usage evidence");
  assert.deepEqual(parseJSON("messages", { ...message, usage: { speed: "turbo" } }), invalid("messages"));
  const chat = { choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] };
  assert.deepEqual(parseJSON("chat", { ...chat, usage: { speed: "fast" } }), ok("chat", { speed: "fast" }));
  assert.deepEqual(parseJSON("chat", chat), ok("chat"));
  assert.deepEqual(parseJSON("responses", { object: "response", id: "r", status: "completed", output: [], usage: { speed: "fast" } }), ok("responses"));
});

test("HTTP errors and network failures carry no speed", () => {
  const parser = createTerminalParser("messages");
  parser.push(JSON.stringify({ type: "error", usage: { speed: "fast" } }));
  assert.deepEqual(parser.finish({ status: 503, contentType: "application/json" }), { api: "messages", state: "http-error", status: 503, errorClass: "service" });
});

// ---- gateway health begin: trusted assertion of the FINAL body's speed ----

const beginWith = async (api, body) => {
  const calls = [];
  const health = createGatewayHealth({ key, gatewayCredential: "private-health", now: () => 100,
    brokerRequest: async (path, input) => { calls.push({ path, input }); return { capability: Buffer.alloc(32, 1).toString("base64url"), nonce: Buffer.alloc(32, 2).toString("base64url"), startedAt: 100, generation: 0 }; } });
  const leased = { sessionID: "s", leaseID: "l", providerID: "anthropic", expectedCredentialInstance: credentialInstance };
  const attempt = await health.begin({ leased, requestID: "r", attemptID: "0", purpose: "outage-health", bodyText: JSON.stringify(body), api });
  return { attempt, calls };
};

test("health begin sends speed only when the final body carries a recognized speed", async () => {
  for (const api of ["messages", "chat"]) {
    for (const speed of ["fast", "standard"]) {
      const { attempt, calls } = await beginWith(api, { model: "claude-opus-5", speed });
      assert.ok(attempt);
      assert.equal(calls[0].input.speed, speed);
    }
    const { calls } = await beginWith(api, { model: "claude-opus-5" });
    assert.equal(Object.hasOwn(calls[0].input, "speed"), false, "no undefined speed key");
  }
});

test("health begin refuses admission for an unsupported body speed rather than inferring standard", async () => {
  for (const speed of ["turbo", null, 1, "FAST"]) {
    const { attempt, calls } = await beginWith("messages", { model: "claude-opus-5", speed });
    assert.equal(attempt, null);
    assert.deepEqual(calls, []);
  }
});

// ---- end to end: trusted fast outage assignment through a real authority ----

const withServer = async (handler, run) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
};

const fastFixture = ({ scope = "fast", consumedPurpose = "outage-health", usageSpeed, providerHeaders } = {}) => {
  const calls = [], forwards = [], outcomes = [];
  const policy = makePolicy().expectedScopePolicies[`anthropic/opus/${scope}`];
  const sessionID = `gw-probe-${"s".repeat(43)}`, probeNonce = `pbn_${"n".repeat(43)}`, leaseID = "isolated-fast-lease";
  // The assignment writer has already normalized wireModelID to the base id; modelID keeps the alias.
  const assignment = { held: true, sessionID, leaseID, targetID: "claude-opus-5-fast", providerID: "anthropic",
    modelID: scope === "fast" ? "claude-opus-5-fast" : "claude-opus-5", wireModelID: "claude-opus-5",
    primaryID: scope === "fast" ? "claude-opus-5-5-fast" : "claude-opus-5-5", logicalID: `anthropic/opus/${scope}`,
    purpose: "outage-health", expectedScopePolicy: policy, expectedCredentialInstance: credentialInstance, expiresAt: 60000 };
  const authority = createHealthAuthority({
    gatewayCredential: "private-health", now: () => 100, randomBytes: () => Buffer.alloc(32, 1),
    lookupLease: () => assignment, lookupGeneration: () => 0, latestFailureAt: () => null,
    verifyAttestation: (report, binding) => verifyHealthReport(key, report, binding),
  });
  const protocol = createHealthProtocol({ key });
  const handler = createGatewayHandler({
    config: { tier: "worker", profile: "auto", providers: { anthropic: { baseUrl: "https://upstream.example/v1", messagesApi: true, ...(providerHeaders ? { headers: providerHeaders } : {}) } } },
    gatewayKey: "frontdoor", health: { key, gatewayCredential: "private-health" }, now: () => 100,
    brokerRequest: async (path, body) => {
      calls.push({ path, body });
      if (path === "/probe/consume") return { ...assignment, preferredModel: { providerID: "anthropic", modelID: assignment.modelID }, purpose: consumedPurpose };
      if (path === "/model-health/begin") return authority.issue(body);
      if (path === "/model-health/outcome") { const accepted = authority.accept(body); outcomes.push(accepted.outcome); return { ok: true }; }
      return { ok: true };
    },
    fetchImpl: async (url, options) => {
      forwards.push({ url, options });
      const request = JSON.parse(Buffer.from(options.headers["x-fleet-health-context"], "base64url").toString("utf8"));
      const signed = protocol.signResponse([1, request[1], request[4], request[5], request[8], credentialInstance,
        policy.connectionID, "https://api.anthropic.com", policy.authMode, policy.transport, policy.product, "upstream-response", 200, sha256(options.headers["x-fleet-health-context"])]);
      return { ok: true, status: 200,
        headers: new Headers({ "x-fleet-health-attestation": signed.attestation, "x-fleet-health-attestation-signature": signed.attestationSignature, "content-type": "application/json" }),
        text: async () => JSON.stringify({ type: "message", id: "m", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1, ...(usageSpeed === undefined ? {} : { speed: usageSpeed }) } }) };
    },
  });
  // The probe runner sends the alias it selected and never a speed field of its own.
  const body = { model: assignment.modelID, stream: false, max_tokens: 256, messages: [{ role: "user", content: "Reply OK." }] };
  const headers = { Authorization: "Bearer frontdoor", "content-type": "application/json", "anthropic-version": "2023-06-01",
    "x-opencode-probe-purpose": "outage-health", "x-opencode-probe-session": sessionID, "x-opencode-probe-nonce": probeNonce };
  const send = (base, extraHeaders = {}) => fetch(`${base}/v1/messages`, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
  return { handler, calls, forwards, outcomes, authority, send };
};

test("trusted fast outage assignment forwards once as base model + speed fast + merged fast beta, bound by the signed body hash", async () => {
  const fixture = fastFixture({ usageSpeed: "fast", providerHeaders: { "Anthropic-Beta": "oauth-2025-04-20, fast-mode-2026-02-01" } });
  await withServer(fixture.handler, async (base) => {
    const response = await fixture.send(base, { "anthropic-beta": "interleaved-thinking-2025-05-14" });
    assert.equal(response.status, 200);
  });
  assert.equal(fixture.forwards.length, 1);
  const { options } = fixture.forwards[0];
  const sent = JSON.parse(options.body);
  assert.equal(sent.model, "claude-opus-5");
  assert.equal(sent.speed, "fast");
  assert.equal(sent.max_tokens, 256);
  const betaNames = Object.keys(options.headers).filter((name) => name.toLowerCase() === "anthropic-beta");
  assert.deepEqual(betaNames, ["anthropic-beta"], "one deduplicated beta header");
  const betas = options.headers["anthropic-beta"].split(",").map((value) => value.trim());
  assert.deepEqual([...betas].sort(), ["fast-mode-2026-02-01", "interleaved-thinking-2025-05-14", "oauth-2025-04-20"]);
  const request = JSON.parse(Buffer.from(options.headers["x-fleet-health-context"], "base64url").toString("utf8"));
  assert.equal(request[8], "claude-opus-5");
  assert.equal(request[9], sha256(options.body), "signed context binds the exact final fast body");
  const begin = fixture.calls.find(({ path }) => path === "/model-health/begin").body;
  assert.equal(begin.speed, "fast");
  assert.equal(begin.modelID, "claude-opus-5");
  assert.equal(begin.bodySHA256, sha256(options.body));
  assert.deepEqual(fixture.outcomes.map(({ result, modelID }) => ({ result, modelID })), [{ result: "success", modelID: "claude-opus-5-fast" }]);
  fixture.authority.close();
});

test("fast outage response reporting standard or no usage.speed is unknown with no retry or fallback", async () => {
  for (const usageSpeed of ["standard", undefined]) {
    const fixture = fastFixture({ usageSpeed });
    await withServer(fixture.handler, async (base) => { await fixture.send(base); });
    assert.equal(fixture.forwards.length, 1);
    assert.equal(JSON.parse(fixture.forwards[0].options.body).speed, "fast");
    assert.deepEqual(fixture.outcomes.map(({ result }) => result), ["unknown"]);
    assert.equal(fixture.calls.filter(({ path }) => path === "/lease" || path === "/model-health/begin").map(({ path }) => path).join(","), "/model-health/begin");
    fixture.authority.close();
  }
});

test("standard outage scope never gains speed or the fast beta", async () => {
  const fixture = fastFixture({ scope: "standard" });
  await withServer(fixture.handler, async (base) => { await fixture.send(base); });
  assert.equal(fixture.forwards.length, 1);
  const { options } = fixture.forwards[0];
  assert.equal(Object.hasOwn(JSON.parse(options.body), "speed"), false);
  assert.equal(Object.hasOwn(options.headers, "anthropic-beta"), false);
  assert.equal(Object.hasOwn(fixture.calls.find(({ path }) => path === "/model-health/begin").body, "speed"), false);
  assert.deepEqual(fixture.outcomes.map(({ result }) => result), ["success"]);
  fixture.authority.close();
});

test("a raw outage purpose header on a generic consume cannot force fast", async () => {
  const fixture = fastFixture({ consumedPurpose: null, usageSpeed: "fast" });
  await withServer(fixture.handler, async (base) => {
    const response = await fixture.send(base);
    assert.equal(response.status, 403);
  });
  assert.equal(fixture.forwards.length, 0);
  fixture.authority.close();
});
