import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const brokerScript = join(fileURLToPath(new URL("..", import.meta.url)), "bin/opencode-broker");

const post = (socketPath, path, body, method = "POST") => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const request = http.request({ socketPath, path, method, headers: {
    "content-type": "application/json", "content-length": Buffer.byteLength(payload),
  } }, (response) => {
    let text = "";
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => {
      try { resolve({ status: response.statusCode, body: JSON.parse(text) }); }
      catch (error) { reject(error); }
    });
  });
  request.once("error", reject);
  request.end(payload);
});

const before = (promise, timeoutMs, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  promise.then((value) => {
    clearTimeout(timer);
    resolve(value);
  }, (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

const startBroker = async ({ usageURL, handlerDeadlineMs = 30_000, modelsHandler = null, planUsage = null, setupHome = null }) => {
  const models = http.createServer((request, response) => {
    if (modelsHandler) return modelsHandler(request, response);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "local-model", status: "loaded" }] }));
  });
  await new Promise((resolve) => models.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "broker-plan-usage-queue-"));
  const stateDir = join(home, ".local/share/opencode/model-routing");
  const socketPath = join(stateDir, "broker.sock");
  const configPath = join(home, "config.json");
  const keyPath = join(home, "usage-key");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, "fixture-plan-reader-key\n", { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  setupHome?.(home);
  const providerID = planUsage?.providerID ?? "fixture";
  writeFileSync(configPath, JSON.stringify({
    targets: {
      local: { providerID: "llamacpp", modelID: "local-model", kind: "local", capacity: 2, context: 32768 },
      cloud: { providerID, modelID: "cloud-model", kind: "cloud", context: 32768 },
    },
    tiers: { worker: ["local"], smart: ["cloud"] },
    profiles: { local: ["local"], auto: ["cloud"] },
    budgets: { [providerID]: { windows: [{ id: "wk", periodMs: 604800000, meter: "requests", capacity: 100 }],
      planUsage: planUsage ?? { type: "http", url: usageURL, keyFile: keyPath } } },
    slotWatch: { enabled: false }, burnWatch: { enabled: false },
  }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  const child = spawn(process.execPath, [brokerScript, "serve"], { env: {
    ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    OPENCODE_BROKER_CONFIG: configPath, OPENCODE_BROKER_LOCAL_MODELS_URL: `http://127.0.0.1:${models.address().port}/v1/models`,
    OPENCODE_BROKER_TEST_HANDLER_DEADLINE_MS: String(handlerDeadlineMs),
  }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening on ")) resolve(); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
  });
  return {
    socketPath,
    statePath: join(stateDir, "broker.json"),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
      await new Promise((resolve, reject) => models.close((error) => error ? reject(error) : resolve()));
      rmSync(home, { recursive: true, force: true });
    },
  };
};

let clientGeneration = 0;
const brokerClientFor = async (socketPath) => {
  const previous = process.env.OPENCODE_MODEL_BROKER_SOCKET;
  process.env.OPENCODE_MODEL_BROKER_SOCKET = socketPath;
  try {
    return await import(`../lib/client.js?planUsageQueue=${++clientGeneration}`);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MODEL_BROKER_SOCKET;
    else process.env.OPENCODE_MODEL_BROKER_SOCKET = previous;
  }
};

const openPartialPost = (socketPath, path) => {
  const request = http.request({ socketPath, path, method: "POST", headers: {
    "content-type": "application/json", "content-length": "65536",
  } });
  request.write("{");
  return request;
};

test("a deferred cloud plan report does not queue local admission or release, then blocks the cloud lease", { timeout: 30_000 }, async () => {
  let releaseUsage;
  const usageReleased = new Promise((resolve) => { releaseUsage = resolve; });
  let usageRequested;
  const usageRequestedPromise = new Promise((resolve) => { usageRequested = resolve; });
  const usage = http.createServer(async (_request, response) => {
    usageRequested();
    await usageReleased;
    const lockedUntil = Date.now() + 60_000;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ windows: [{ id: "wk", percent: 100, resetsAt: new Date(lockedUntil).toISOString(), active: true, severity: null }], lockedUntil }));
  });
  await new Promise((resolve) => usage.listen(0, "127.0.0.1", resolve));
  const broker = await startBroker({ usageURL: `http://127.0.0.1:${usage.address().port}/usage` });
  try {
    const held = await post(broker.socketPath, "/lease", { sessionID: "held-local", profile: "local", tier: "worker", localOnly: true, contextTokens: 100 });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    const cloud = post(broker.socketPath, "/lease", { sessionID: "blocked-cloud", profile: "auto", tier: "smart", contextTokens: 100 });
    let cloudSettled = false;
    cloud.then(() => { cloudSettled = true; }, () => { cloudSettled = true; });
    await usageRequestedPromise;
    const local = post(broker.socketPath, "/lease", { sessionID: "next-local", profile: "local", tier: "worker", localOnly: true, contextTokens: 100 });
    const release = post(broker.socketPath, "/release", { sessionID: "held-local", leaseID: held.body.leaseID });
    const [localReply, releaseReply] = await before(Promise.all([local, release]), 1_000,
      "local admission or release remained behind the deferred cloud usage fetch");
    assert.equal(localReply.status, 200, JSON.stringify(localReply.body));
    assert.equal(releaseReply.status, 200, JSON.stringify(releaseReply.body));
    assert.equal(cloudSettled, false, "cloud admission settled before its deferred usage report was released");
    releaseUsage();
    const cloudReply = await cloud;
    assert.notEqual(cloudReply.status, 200, `stale admission bypassed the 100% report: ${JSON.stringify(cloudReply.body)}`);
  } finally {
    releaseUsage?.();
    await broker.stop();
    await new Promise((resolve, reject) => usage.close((error) => error ? reject(error) : resolve()));
  }
});

test("an arrival-expired cloud report does not apply a late quota circuit", { timeout: 5_000 }, async () => {
  let releaseUsage;
  const usageReleased = new Promise((resolve) => { releaseUsage = resolve; });
  let usageRequested;
  const usageRequestedPromise = new Promise((resolve) => { usageRequested = resolve; });
  let usageReturned;
  const usageReturnedPromise = new Promise((resolve) => { usageReturned = resolve; });
  const usage = http.createServer(async (_request, response) => {
    usageRequested();
    await usageReleased;
    const lockedUntil = Date.now() + 60_000;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ windows: [{ id: "wk", percent: 100, resetsAt: new Date(lockedUntil).toISOString(), active: true, severity: null }], lockedUntil }));
    usageReturned();
  });
  await new Promise((resolve) => usage.listen(0, "127.0.0.1", resolve));
  const broker = await startBroker({ usageURL: `http://127.0.0.1:${usage.address().port}/usage`, handlerDeadlineMs: 100 });
  try {
    const cloud = post(broker.socketPath, "/lease", { sessionID: "expired-cloud", profile: "auto", tier: "smart", contextTokens: 100 });
    await usageRequestedPromise;
    const expired = await cloud;
    assert.equal(expired.status, 503, JSON.stringify(expired.body));
    releaseUsage();
    await usageReturnedPromise;
    await new Promise((resolve) => setImmediate(resolve));
    const state = JSON.parse(readFileSync(broker.statePath, "utf8"));
    assert.equal(state.circuits["provider:fixture"], undefined, JSON.stringify(state.circuits));
    assert.equal(state.leases["expired-cloud"], undefined, JSON.stringify(state.leases));
  } finally {
    releaseUsage?.();
    await broker.stop();
    await new Promise((resolve, reject) => usage.close((error) => error ? reject(error) : resolve()));
  }
});

test("a local lease keeps its arrival deadline while queued behind a stalled handler", { timeout: 5_000 }, async () => {
  const usage = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ windows: [] }));
  });
  await new Promise((resolve) => usage.listen(0, "127.0.0.1", resolve));
  let modelRequests = 0;
  let releaseSecondModels;
  const secondModels = new Promise((resolve) => { releaseSecondModels = resolve; });
  let firstModelsRequested;
  const firstModelsRequestedPromise = new Promise((resolve) => { firstModelsRequested = resolve; });
  const broker = await startBroker({
    usageURL: `http://127.0.0.1:${usage.address().port}/usage`, handlerDeadlineMs: 150,
    modelsHandler: async (_request, response) => {
      modelRequests += 1;
      if (modelRequests <= 2) {
        if (modelRequests === 1) firstModelsRequested();
        await secondModels;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-model", status: "loaded" }] }));
    },
  });
  let first;
  try {
    first = post(broker.socketPath, "/lease", {
      sessionID: "blocking-local", profile: "local", tier: "worker", localOnly: true, contextTokens: 100,
    });
    await firstModelsRequestedPromise;
    const lease = post(broker.socketPath, "/lease", {
      sessionID: "arrival-bounded-local", profile: "local", tier: "worker", localOnly: true, contextTokens: 100,
    });
    const reply = await before(lease, 300, "queued local lease exceeded its arrival deadline");
    assert.equal(reply.status, 503, JSON.stringify(reply.body));
  } finally {
    releaseSecondModels?.();
    await first?.catch(() => {});
    await broker.stop();
    await new Promise((resolve, reject) => usage.close((error) => error ? reject(error) : resolve()));
  }
});

test("preflight admission refuses excess unfinished lease bodies without delaying release and recovers slots", { timeout: 10_000 }, async () => {
  const usage = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ windows: [] }));
  });
  await new Promise((resolve) => usage.listen(0, "127.0.0.1", resolve));
  const broker = await startBroker({ usageURL: `http://127.0.0.1:${usage.address().port}/usage`, handlerDeadlineMs: 1_000 });
  const partials = [];
  try {
    const held = await post(broker.socketPath, "/lease", {
      sessionID: "preflight-held", profile: "local", tier: "worker", localOnly: true, contextTokens: 100,
    });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    for (let index = 0; index < 64; index += 1) {
      const request = openPartialPost(broker.socketPath, "/lease");
      request.on("error", () => {});
      partials.push(request);
    }
    const refused = await before(post(broker.socketPath, "/lease", {
      sessionID: "preflight-overflow", profile: "local", tier: "worker", localOnly: true, contextTokens: 100,
    }), 1_000, "excess preflight request was not promptly refused");
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: "broker preflight capacity exceeded" });
    const released = await before(post(broker.socketPath, "/release", {
      sessionID: "preflight-held", leaseID: held.body.leaseID,
    }), 1_000, "release was delayed behind preflight admission");
    assert.equal(released.status, 200, JSON.stringify(released.body));
    for (const request of partials) request.destroy();
    const recovered = await before(post(broker.socketPath, "/lease", {
      sessionID: "preflight-recovered", profile: "local", tier: "worker", localOnly: true, contextTokens: 100,
    }), 1_000, "preflight slots did not recover after abandoned bodies settled");
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  } finally {
    for (const request of partials) request.destroy();
    await broker.stop();
    await new Promise((resolve, reject) => usage.close((error) => error ? reject(error) : resolve()));
  }
});

test("a legal six-second Bailian quota refresh still leases to the ordinary client", { timeout: 20_000 }, async () => {
  const usage = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ windows: [] }));
  });
  await new Promise((resolve) => usage.listen(0, "127.0.0.1", resolve));
  let fakeCliCountPath;
  const broker = await startBroker({
    usageURL: `http://127.0.0.1:${usage.address().port}/unused`,
    planUsage: { providerID: "bailian", type: "bailian-cli" },
    setupHome(home) {
      const bin = join(home, ".local/bin");
      mkdirSync(bin, { recursive: true, mode: 0o700 });
      fakeCliCountPath = join(home, "fake-bl-count");
      writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ bailian: { type: "oauth" } }) + "\n", { mode: 0o600 });
      writeFileSync(join(bin, "bl"), `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(fakeCliCountPath)}, "1\\n");\nsetTimeout(() => process.stdout.write(JSON.stringify({ per5HourPercentage: 0.25, per5HourResetTime: Math.floor(Date.now() / 1000) + 3600, per1WeekPercentage: 0.5, per1WeekResetTime: Math.floor(Date.now() / 1000) + 86400 })), 6000);\n`, { mode: 0o700 });
      chmodSync(join(bin, "bl"), 0o700);
    },
  });
  try {
    const client = await brokerClientFor(broker.socketPath);
    const ordinary = await client.brokerRequest("/lease", {
      sessionID: "ordinary-timeout", profile: "auto", tier: "smart", contextTokens: 100,
    });
    assert.equal(readFileSync(fakeCliCountPath, "utf8").trim().split("\n").length, 1, "both client attempts must share the in-flight quota refresh");
    assert.equal(ordinary.target.id, "cloud", JSON.stringify(ordinary));
  } finally {
    await broker.stop();
    await new Promise((resolve, reject) => usage.close((error) => error ? reject(error) : resolve()));
  }
});
