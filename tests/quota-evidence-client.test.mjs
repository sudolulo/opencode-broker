import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as client from "../lib/client.js";

const { brokerRequest, createHealthBrokerRequest, selectBrokerTransport } = client;

const withSocketServer = async (handler, run) => {
  const root = mkdtempSync(join(tmpdir(), "quota-evidence-client-"));
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

test("quota evidence transport sends one bounded POST and refuses every other path", async () => {
  const paths = [];
  await withSocketServer((request, response) => {
    paths.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, accepted: true }));
  }, async (socketPath) => {
    const request = client.createQuotaEvidenceBrokerRequest({ socketPath });
    assert.deepEqual(await request("/quota-evidence", { sessionID: "ses_abc" }), { ok: true, accepted: true });
    await assert.rejects(request("/model-health/outcome", {}), /quota evidence path/);
  });
  assert.deepEqual(paths, ["/quota-evidence"]);
});

test("quota evidence transport has one attempt and an absolute deadline that closes its socket", async () => {
  let attempts = 0;
  let trickle = null;
  let resolveSocketClosed;
  const socketClosed = new Promise((resolve) => { resolveSocketClosed = resolve; });
  let closedBeforeTeardown = false;
  try {
    await withSocketServer((request, response) => {
      attempts += 1;
      request.socket.once("close", () => { clearInterval(trickle); resolveSocketClosed(); });
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      // Trickle valid JSON whitespace forever, well past the deadline: only the client
      // closing its socket ends this reply, so a deadline that merely rejects cannot pass.
      trickle = setInterval(() => response.write(" "), 5);
    }, async (socketPath) => {
      // 250 ms, not tighter: under full-suite load a very short deadline can fire before the
      // server accepts the connection, so this handler never runs and the close it waits for
      // never happens. The trickle is endless, so the deadline is still what ends the reply.
      const request = client.createQuotaEvidenceBrokerRequest({ socketPath, timeoutMs: 250 });
      await assert.rejects(request("/quota-evidence", {}), /quota evidence deadline/);
      // Observed server-side before run returns, so the fixture's own teardown destroy cannot be the cause.
      let guard;
      try {
        await Promise.race([socketClosed, new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error("client left the trickling connection open after its deadline")), 1000);
        })]);
      } finally { clearTimeout(guard); }
      closedBeforeTeardown = true;
    });
  } finally { clearInterval(trickle); }
  assert.equal(closedBeforeTeardown, true);
  assert.equal(attempts, 1);
});

test("quota evidence transport does not retry a closed Unix connection", async () => {
  let attempts = 0;
  await withSocketServer((request) => {
    attempts += 1;
    request.socket.destroy();
  }, async (socketPath) => {
    const request = client.createQuotaEvidenceBrokerRequest({ socketPath });
    await assert.rejects(request("/quota-evidence", {}));
  });
  assert.equal(attempts, 1);
});

test("quota evidence transport rejects malformed, oversized, and rejected replies", async () => {
  for (const [label, reply, expected] of [
    ["malformed", () => "not-json", /Unexpected token/],
    ["oversized", () => "x".repeat(65537), /quota evidence response size/],
    ["rejected", () => JSON.stringify({ ok: false }), /quota evidence rejected/],
  ]) {
    await withSocketServer((_request, response) => {
      response.writeHead(label === "rejected" ? 409 : 200, { "content-type": "application/json" });
      response.end(reply());
    }, async (socketPath) => {
      const request = client.createQuotaEvidenceBrokerRequest({ socketPath });
      await assert.rejects(request("/quota-evidence", {}), expected);
    });
  }
});

test("quota evidence transport surfaces a broker refusal's HTTP status and static code on the rejection", async () => {
  await withSocketServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "quota evidence refused", code: "not-a-continuation-source" }));
  }, async (socketPath) => {
    const request = client.createQuotaEvidenceBrokerRequest({ socketPath });
    await assert.rejects(request("/quota-evidence", {}), (error) => {
      assert.match(error.message, /quota evidence rejected/);
      assert.equal(error.status, 409);
      assert.equal(error.code, "not-a-continuation-source");
      return true;
    });
  });
});

test("quota evidence transport never copies a non-static refusal code onto the rejection", async () => {
  await withSocketServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "Free text, with spaces: not a static code" }));
  }, async (socketPath) => {
    const request = client.createQuotaEvidenceBrokerRequest({ socketPath });
    await assert.rejects(request("/quota-evidence", {}), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, undefined);
      return true;
    });
  });
});

test("quota evidence dispatch never falls through to ordinary retries", async () => {
  const calls = [];
  const ordinary = async (...args) => { calls.push(["ordinary", ...args]); return {}; };
  const health = async (...args) => { calls.push(["health", ...args]); return {}; };
  const quota = async (...args) => { calls.push(["quota", ...args]); return {}; };
  const request = selectBrokerTransport({ brokerRequest: ordinary, healthRequest: health, quotaEvidenceRequest: quota });

  await request("/quota-evidence", { sessionID: "ses_abc" });
  await request("/model-health/outcome", {});
  await request("/status", {});
  assert.deepEqual(calls.map(([transport, path]) => [transport, path]), [
    ["quota", "/quota-evidence"], ["health", "/model-health/outcome"], ["ordinary", "/status"],
  ]);
  assert.equal(typeof brokerRequest, "function", "ordinary broker request remains exported");
});

test("quota evidence dispatch fails closed when its dedicated transport is absent", async () => {
  const calls = [];
  const request = selectBrokerTransport({
    brokerRequest: async (...args) => { calls.push(args); return {}; },
    healthRequest: async (...args) => { calls.push(args); return {}; },
  });
  await assert.rejects(request("/quota-evidence", {}), /quota evidence transport unavailable/);
  assert.deepEqual(calls, []);
});

test("quota evidence transport rejects invalid options before opening a socket", async () => {
  const request = client.createQuotaEvidenceBrokerRequest({ socketPath: "", timeoutMs: 0 });
  await assert.rejects(request("/quota-evidence", {}), /quota evidence options/);
});

test("health transport keeps its allowlist separate from quota evidence", async () => {
  const request = createHealthBrokerRequest({ socketPath: "/tmp/not-used.sock" });
  await assert.rejects(request("/quota-evidence", {}), /health path/);
});
