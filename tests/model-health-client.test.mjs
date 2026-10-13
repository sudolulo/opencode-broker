import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHealthBrokerRequest, selectBrokerTransport } from "../lib/client.js";

const withSocketServer = async (handler, run) => {
  const root = mkdtempSync(join(tmpdir(), "health-client-"));
  const socketPath = join(root, "broker.sock");
  const server = createServer(handler);
  const connections = new Set();
  server.on("connection", (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try { await run(socketPath); }
  finally {
    for (const connection of connections) connection.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
};

test("health client times out one delivery without hidden transient retry", async (t) => {
  let count = 0;
  let accept;
  const accepted = new Promise((resolve) => { accept = resolve; });
  await withSocketServer(() => { count += 1; accept(); }, async (socketPath) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const request = createHealthBrokerRequest({ socketPath, timeoutMs: 20 });
      const rejection = assert.rejects(request("/model-health/outcome", {}), /health deadline/);
      await accepted;
      t.mock.timers.tick(20);
      await rejection;
    } finally {
      t.mock.timers.reset();
    }
  });
  assert.equal(count, 1);
});

test("health client deadline is absolute while a response trickles", async (t) => {
  let count = 0;
  const trickleTimers = [];
  let receiveFirstChunk;
  let receiveSecondChunk;
  const firstChunkReceived = new Promise((resolve) => { receiveFirstChunk = resolve; });
  const secondChunkReceived = new Promise((resolve) => { receiveSecondChunk = resolve; });
  await withSocketServer((_request, response) => {
    count += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
    trickleTimers.push(setTimeout(() => response.write("\"ok\""), 15));
    trickleTimers.push(setTimeout(() => response.end(":true}"), 45));
  }, async (socketPath) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const originalRequest = http.request;
    t.mock.method(http, "request", function (...args) {
      const request = originalRequest.apply(this, args);
      request.once("response", (response) => {
        let dataReceipts = 0;
        response.on("data", () => {
          dataReceipts += 1;
          if (dataReceipts === 1) receiveFirstChunk();
          if (dataReceipts === 2) receiveSecondChunk();
        });
      });
      return request;
    });
    try {
      const request = createHealthBrokerRequest({ socketPath, timeoutMs: 30 });
      const rejection = assert.rejects(request("/model-health/outcome", {}), /health deadline/);
      await firstChunkReceived;
      t.mock.timers.tick(15);
      await secondChunkReceived;
      t.mock.timers.tick(15);
      await rejection;
    } finally {
      for (const timer of trickleTimers) clearTimeout(timer);
      t.mock.restoreAll();
      t.mock.timers.reset();
    }
  });
  assert.equal(count, 1);
});

test("health client sends outage probe consume and release exactly once", async () => {
  const paths = [];
  await withSocketServer((request, response) => {
    paths.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  }, async (socketPath) => {
    const request = createHealthBrokerRequest({ socketPath });
    await request("/probe/consume", { purpose: "outage-health" });
    await request("/probe/release", { purpose: "outage-health" });
    await assert.rejects(request("/probe/other", {}), /health path/);
  });
  assert.deepEqual(paths, ["/probe/consume", "/probe/release"]);
});

test("outage probe dispatch uses the bounded health transport", async () => {
  const calls = [];
  const ordinary = (...args) => { calls.push(["ordinary", ...args]); return Promise.resolve({}); };
  const health = (...args) => { calls.push(["health", ...args]); return Promise.resolve({}); };
  const request = selectBrokerTransport({ brokerRequest: ordinary, healthRequest: health });

  await request("/probe/consume", { purpose: "outage-health" });
  await request("/probe/release", { purpose: "outage-health" });
  await request("/probe/consume", { purpose: "ordinary" });

  assert.deepEqual(calls, [
    ["health", "/probe/consume", { purpose: "outage-health" }],
    ["health", "/probe/release", { purpose: "outage-health" }],
    ["ordinary", "/probe/consume", { purpose: "ordinary" }],
  ]);
});
