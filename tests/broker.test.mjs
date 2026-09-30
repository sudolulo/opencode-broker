import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

// Route the config loader at the fleet-shaped fixture BEFORE any router module
// loads -- config.js reads its file once at import time.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const brokerScript = join(repoRoot, "bin/opencode-broker");
const { CONFIG_FINGERPRINT } = await import(new URL("../lib/config.js", import.meta.url).href);
const { MODEL_POLICY_VERSION } = await import(new URL("../lib/model-policy.js", import.meta.url).href);
const { createResolverGenerationManager } = await import(new URL("../lib/resolver-generations.js", import.meta.url).href);

const withTempHome = async (fn) => {
  const originalHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "fleet-model-broker-home-"));
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
};

const request = (socketPath, path, body = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = http.request({
    socketPath,
    path,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => {
      let parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch {}
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve(parsed);
        return;
      }
      reject(new Error(parsed.error ?? `broker HTTP ${res.statusCode ?? "error"}`));
    });
  });
  req.on("error", reject);
  req.end(payload);
});

const rawRequest = (socketPath, path, { method = "POST", body } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const req = http.request({
    socketPath,
    path,
    method,
    headers: payload === null ? {} : {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => {
      let parsed = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch {}
      resolve({ status: res.statusCode, body: parsed });
    });
  });
  req.on("error", reject);
  req.end(payload ?? undefined);
});

// The daemon's own resolver view (lib/routing.js `resolvableModelsPath`), i.e. what
// `opencode models --pure` reports on this host. The /inventory ingest filter is
// FAIL-CLOSED, so a daemon test without this file admits no discovered inventory at
// all -- these are the model references the existing tests publish and expect to keep.
const DEFAULT_RESOLVABLE_MODELS = [
  "openai/gpt-5.6-luna",
  "openai/gpt-test",
  "alibaba-token-plan/qwen3.8-flash",
  "alibaba-token-plan/deepseek-v4-flash-0731",
  "anthropic/claude-fable-4-8",
  "anthropic/claude-fable-5",
];

const writeResolvableModels = (home, models) => {
  const routing = join(home, ".local/share/opencode/model-routing");
  mkdirSync(routing, { recursive: true });
  writeFileSync(join(routing, "resolvable-models.json"),
    JSON.stringify({ updatedAt: Date.now(), models }));
};

const waitFor = async (predicate, description, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// `resolvableModels: null` starts a daemon with NO resolver view on disk, which is the
// fail-closed case; anything else is written before the daemon starts.
const startBroker = async (home, extraEnv = {}, resolvableModels = DEFAULT_RESOLVABLE_MODELS) => {
  const socketPath = join(home, ".local/share/opencode/model-routing/broker.sock");
  if (resolvableModels !== null) writeResolvableModels(home, resolvableModels);
  const child = spawn(process.execPath, [brokerScript, "serve"], {
    cwd: repoRoot,
    // Most broker tests isolate cloud selection. The local-share policy has dedicated
    // unit coverage; never depend on the developer machine's live llama.cpp endpoint.
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (String(chunk).includes("listening on ")) resolve();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`broker exited before listen (${code ?? signal}): ${stderr}`)));
  });
  // The daemon reports what it drops on stderr; tests that assert on that read it here.
  return { child, socketPath, stderr: () => stderr };
};

const stopBroker = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
};

const startBrokerFailure = async (home, stateBytes) => {
  const routing = join(home, ".local/share/opencode/model-routing");
  mkdirSync(routing, { recursive: true });
  writeFileSync(join(routing, "broker.json"), stateBytes);
  writeResolvableModels(home, DEFAULT_RESOLVABLE_MODELS);
  const child = spawn(process.execPath, [brokerScript, "serve"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const result = await Promise.race([
    new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("broker did not fail startup")), 2000)),
  ]).finally(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { ...result, stdout, stderr };
};

const startModelsServer = async (models) => {
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/v1/models") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }) + "\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    // Mirrors llama.cpp router mode: a bare string is a row with NO status field (an older
    // server, which must fail open), an object carries the status the router reports.
    response.end(JSON.stringify({
      data: models.map((model) => (typeof model === "string"
        ? { id: model }
        : { id: model.id, status: { value: model.status } })),
    }) + "\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1/models`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
};

const withBroker = async (fn, { resolvableModels = DEFAULT_RESOLVABLE_MODELS } = {}) => withTempHome(async (home) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  const { child, socketPath, stderr } = await startBroker(home, {}, resolvableModels);
  try {
    return await fn({ home, socketPath, stderr });
  } finally {
    await stopBroker(child);
  }
});

const inventory = (providers) => {
  const authPath = join(process.env.HOME, ".local/share/opencode/auth.json");
  const contents = readFileSync(authPath);
  const stat = statSync(authPath);
  return {
    connected: Object.keys(providers),
    providers,
    modelContexts: {
      "openai/gpt-5.6-luna": 1000,
      "alibaba-token-plan/qwen3.8-flash": 1000,
      "alibaba-token-plan/deepseek-v4-flash-0731": 1000,
    },
    authRevision: `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(contents).digest("hex")}`,
    configFingerprint: CONFIG_FINGERPRINT,
  };
};

test("held leases reject changed profile/tier and oversized context", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  await request(socketPath, "/usage", {
    providerID: "alibaba-token-plan",
    requests: 0,
    tokens: { input: 50_000_000, output: 50_000_000, cacheRead: 0, cacheWrite: 0 },
  });

  const acquired = await request(socketPath, "/lease", {
    sessionID: "ses-held",
    profile: "auto",
    tier: "worker",
    contextTokens: 100,
    replace: true,
  });
  assert.equal(acquired.existing, false);
  assert.equal(acquired.target.model.id, "gpt-5.6-luna");

  // An oversized request no longer REJECTS on a cloud tier. It drops to the roomiest
  // window instead: a refusal also blocks the compaction that would shrink the session
  // (compaction rides the session's own tier), so the session could neither run nor
  // recover. The held lease is still invalidated by the size change -- it just lands
  // somewhere instead of throwing.
  const oversized = await request(socketPath, "/lease", {
    sessionID: "ses-held",
    profile: "auto",
    tier: "worker",
    contextTokens: 100_000,
  });
  assert.equal(oversized.decision.policy, "context-overflow-last-resort");
  assert.equal(oversized.target.kind, "cloud");

  const retiered = await request(socketPath, "/lease", {
    sessionID: "ses-retiered",
    profile: "auto",
    tier: "worker",
    contextTokens: 100,
    replace: true,
  });
  assert.equal(retiered.target.model.id, "gpt-5.6-luna");

  const changed = await request(socketPath, "/lease", {
    sessionID: "ses-retiered",
    profile: "auto",
    tier: "smart",
  });
  assert.equal(changed.existing, false);
  assert.notEqual(changed.target.model.id, "gpt-5.6-luna");
}));

test("cloud leases share unlimited capacity while local leases stay capped and JSON stays finite", async () => withTempHome(async (home) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  const modelsServer = await startModelsServer(["qwen3.5-9b-coder"]);
  let child;
  let socketPath;
  try {
    ({ child, socketPath } = await startBroker(home, { OPENCODE_BROKER_LOCAL_MODELS_URL: modelsServer.url }));
    try {
      await request(socketPath, "/inventory", inventory({
        openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
      }));

      const firstLocal = await request(socketPath, "/lease", {
        sessionID: "ses-local-held",
        profile: "local",
        tier: "worker",
        contextTokens: 100,
        replace: true,
      });
      assert.equal(firstLocal.target.id, "local-coder");

      await assert.rejects(request(socketPath, "/lease", {
        sessionID: "ses-local-blocked",
        profile: "local",
        tier: "worker",
        contextTokens: 100,
        replace: true,
      }), (error) => {
        // Full is not gone: a resident local model with every slot taken is a WAIT,
        // not a refusal -- the caller retries and gets the next free slot.
        assert.match(String(error), /qwen3\.5-9b-coder is busy \(every slot in use\); waiting for a free slot -- resend the prompt in a moment/);
        return true; // the machine-readable code is pinned in refusal-codes.test.mjs
      });

      const [cloudA, cloudB] = await Promise.all([
        request(socketPath, "/lease", {
          sessionID: "ses-cloud-a",
          profile: "auto",
          tier: "worker",
          preferredModel: { providerID: "openai", id: "gpt-5.6-luna" },
          replace: true,
        }),
        request(socketPath, "/lease", {
          sessionID: "ses-cloud-b",
          profile: "auto",
          tier: "worker",
          preferredModel: { providerID: "openai", id: "gpt-5.6-luna" },
          replace: true,
        }),
      ]);
      assert.equal(cloudA.existing, false);
      assert.equal(cloudB.existing, false);
      assert.equal(cloudA.target.kind, "cloud");
      assert.equal(cloudA.target.model.id, "gpt-5.6-luna");
      assert.equal(cloudB.target.model.id, "gpt-5.6-luna");
      assert.equal(cloudA.target.id, cloudB.target.id);

      const status = await request(socketPath, "/status");
      const stateJson = readFileSync(join(home, ".local/share/opencode/model-routing/broker.json"), "utf8");
      assert.doesNotMatch(JSON.stringify(status), /Infinity|NaN/);
      assert.doesNotMatch(stateJson, /Infinity|NaN/);
    } finally {
      await stopBroker(child);
    }
  } finally {
    await modelsServer.stop();
  }
}));

// ☠️ Slots belong to the model: two targets naming one llama.cpp model share its slots, and
// modelCapacity is how full the MODEL may be (summed across both) for a target to take another.
// Built on a temp copy of the fixture where local-classifier runs on local-coder's model, the
// shape a deployment has when its coder and classifier lanes share one small model. The
// fixture's comments are stripped the same way the config-parse tests read it.
test("modelCapacity counts every target on the same local model, and keeps a slot in reserve", async () => withTempHome(async (home) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/config.json", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, ""));
  fixture.targets["local-coder"] = { ...fixture.targets["local-coder"], capacity: 4, modelCapacity: 2 };
  fixture.targets["local-classifier"] = {
    ...fixture.targets["local-classifier"], modelID: "qwen3.5-9b-coder", capacity: 2, modelCapacity: 3,
  };
  const configPath = join(home, "broker-config.json");
  writeFileSync(configPath, JSON.stringify(fixture));
  const modelsServer = await startModelsServer(["qwen3.5-9b-coder"]);
  let child;
  let socketPath;
  try {
    ({ child, socketPath } = await startBroker(home, {
      OPENCODE_BROKER_LOCAL_MODELS_URL: modelsServer.url,
      OPENCODE_BROKER_CONFIG: configPath,
    }));
    try {
      const lease = (sessionID, profile, tier) =>
        request(socketPath, "/lease", { sessionID, profile, tier, contextTokens: 100, replace: true });
      assert.equal((await lease("ses-coder-1", "local", "worker")).target.id, "local-coder");
      assert.equal((await lease("ses-classify-1", "auto", "classifier")).target.id, "local-classifier");
      // local-coder holds ONE of its own four, but the model carries two leases -- its
      // modelCapacity -- so the classifier's lease counts against it and the coder waits.
      await assert.rejects(lease("ses-coder-2", "local", "worker"),
        /is busy \(every slot in use\); waiting for a free slot/);
      // The classifier lane may fill the model further: the reserved slot is its to take.
      assert.equal((await lease("ses-classify-2", "auto", "classifier")).target.id, "local-classifier");
      // Releasing the classifier's leases frees the model-wide count, not just its own.
      await request(socketPath, "/forget", { sessionID: "ses-classify-1" });
      await request(socketPath, "/forget", { sessionID: "ses-classify-2" });
      assert.equal((await lease("ses-coder-2", "local", "worker")).target.id, "local-coder");
    } finally {
      await stopBroker(child);
    }
  } finally {
    await modelsServer.stop();
  }
}));

// The burn watch end to end: /usage reports in, a stop back out on the reply that crossed
// the line, a decision logged, and the notify command run with its placeholders filled.
test("the broker stops a runaway session on the /usage reply and notifies, and never counts local usage", async () => withTempHome(async (home) => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/config.json", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, ""));
  const sent = join(home, "notified.txt");
  const notifier = join(home, "notify.sh");
  writeFileSync(notifier, `#!/bin/sh\nprintf '%s|' "$@" >> "${sent}"\necho >> "${sent}"\n`);
  chmodSync(notifier, 0o755);
  fixture.burnWatch = { notifyCommand: [notifier, "{title}", "{body}", "urgent", "{kind}"] };
  const configPath = join(home, "broker-config.json");
  writeFileSync(configPath, JSON.stringify(fixture));
  const { child, socketPath } = await startBroker(home, { OPENCODE_BROKER_CONFIG: configPath });
  try {
    const step = (sessionID, providerID, cacheWrite, cacheRead = 17_000) => request(socketPath, "/usage", {
      sessionID, providerID, modelID: "m", observedAt: Date.now(), requests: 1,
      tokens: { input: 5, output: 400, cacheRead, cacheWrite },
    });
    // Local hardware costs no plan: four huge re-sends on a local provider are not a burn.
    for (let i = 0; i < 4; i++) assert.equal((await step("ses_local", "llamacpp", 500_000)).burn, undefined);
    const replies = [];
    for (let i = 0; i < 4; i++) replies.push(await step("ses_runaway", "anthropic", 430_000));
    assert.deepEqual(replies.map((r) => r.burn?.stop === true), [false, false, false, true]);
    assert.match(replies[3].burn.reason, /re-sent its whole prompt uncached 4 times/);
    const decisions = readFileSync(join(home, ".local/share/opencode/model-routing/decisions.jsonl"), "utf8");
    assert.match(decisions, /"policy":"burn-stop".*"sessionID":"ses_runaway"|"sessionID":"ses_runaway".*"policy":"burn-stop"/);
    // The alert is spawned detached; give it a moment to land.
    let text = "";
    for (let i = 0; i < 40 && !/stopped a session/.test(text); i++) {
      await new Promise((r) => setTimeout(r, 50));
      try { text = readFileSync(sent, "utf8"); } catch {}
    }
    assert.match(text, /Burn watch stopped a session \(anthropic\)\|Session ses_runaway was stopped because .*\|urgent\|stop\|/);
  } finally {
    await stopBroker(child);
  }
}));

// `enabled: false` is the whole watch off: no stop rides back, whatever the rate.
test("a disabled burn watch never stops a session", async () => withTempHome(async (home) => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/config.json", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, ""));
  fixture.burnWatch = { enabled: false };
  const configPath = join(home, "broker-config.json");
  writeFileSync(configPath, JSON.stringify(fixture));
  const { child, socketPath } = await startBroker(home, { OPENCODE_BROKER_CONFIG: configPath });
  try {
    for (let i = 0; i < 6; i++) {
      const reply = await request(socketPath, "/usage", {
        sessionID: "ses_runaway", providerID: "anthropic", modelID: "m", observedAt: Date.now(), requests: 1,
        tokens: { input: 5, output: 400, cacheRead: 17_000, cacheWrite: 430_000 },
      });
      assert.equal(reply.ok, true);
      assert.equal(reply.burn, undefined);
    }
  } finally {
    await stopBroker(child);
  }
}));

// The usage log end to end: a /usage report becomes a line with the lease's lane on it, and
// `opencode-broker usage` summarises the file without needing the broker.
test("every /usage report is logged with its prompt size, and the usage command summarises it", async () => withBroker(async ({ home, socketPath }) => {
  for (const [sessionID, input] of [["ses-a", 1_000], ["ses-a", 40_000], ["ses-b", 5_000]]) {
    await request(socketPath, "/usage", {
      sessionID, providerID: "openai", modelID: "gpt-5.6-luna", observedAt: Date.now(), requests: 1,
      tokens: { input, output: 100, cacheRead: 0, cacheWrite: 0 },
    });
  }
  const lines = readFileSync(join(home, ".local/share/opencode/model-routing/usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.sessionID, line.prompt, line.local]), [["ses-a", 1_000, false], ["ses-a", 40_000, false], ["ses-b", 5_000, false]]);
  // The cache split survives to disk, zeroes included: without it a burn-watch stop cannot be audited.
  assert.deepEqual(lines.map((line) => [line.input, line.cacheRead, line.cacheWrite]), [[1_000, 0, 0], [40_000, 0, 0], [5_000, 0, 0]]);
  const { spawnSync } = await import("node:child_process");
  const report = spawnSync(process.execPath, [brokerScript, "usage", "1"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /cloud {2}openai\/gpt-5\.6-luna/);
  assert.match(report.stdout, /session peaks \(2 sessions\): p50 \d+K? {2}p90 40K/);
}));

// A caller waiting out a busy local slot re-leases every few seconds; each attempt must not
// become a line in decisions.jsonl, or a burst of waiters truncates the whole trace.
test("a session's repeated waits are logged once, not once per poll", async () => withTempHome(async (home) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  const modelsServer = await startModelsServer(["qwen3.5-9b-coder"]);
  let child;
  let socketPath;
  try {
    ({ child, socketPath } = await startBroker(home, { OPENCODE_BROKER_LOCAL_MODELS_URL: modelsServer.url }));
    try {
      const lease = (sessionID) => request(socketPath, "/lease", { sessionID, profile: "local", tier: "worker", contextTokens: 100, replace: true });
      await lease("ses-holder");
      for (let i = 0; i < 5; i++) await assert.rejects(lease("ses-waiter"), /busy/);
      const lines = readFileSync(join(home, ".local/share/opencode/model-routing/decisions.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.filter((line) => line.sessionID === "ses-waiter" && line.policy === "waiting").length, 1);
      const selection = await request(socketPath, "/selection");
      assert.equal(selection.lastDecision?.policy, "waiting", "the live state still shows the wait");
    } finally {
      await stopBroker(child);
    }
  } finally {
    await modelsServer.stop();
  }
}));

test("a gateway caller is recorded on the session's decisions and usage lines", async () => withBroker(async ({ home, socketPath }) => {
  const caller = { address: "192.168.50.1", model: "background" };
  await request(socketPath, "/inventory", inventory({ openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 } }));
  await request(socketPath, "/lease", { sessionID: "gw-caller", profile: "auto", tier: "worker", preferredModel: { providerID: "openai", id: "gpt-5.6-luna" }, replace: true, caller });
  await request(socketPath, "/usage", { sessionID: "gw-caller", providerID: "openai", modelID: "gpt-5.6-luna", observedAt: Date.now(), requests: 1, tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, caller });
  await request(socketPath, "/lease", { sessionID: "gw-junk", profile: "auto", tier: "worker", replace: true, caller: { address: "not an ip!", model: "x".repeat(500) } });
  const dir = join(home, ".local/share/opencode/model-routing");
  const decisions = readFileSync(join(dir, "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const mine = decisions.filter((line) => line.sessionID === "gw-caller");
  assert.ok(mine.length >= 1);
  for (const line of mine) assert.deepEqual(line.caller, caller);
  assert.ok(decisions.filter((line) => line.sessionID === "gw-junk").every((line) => line.caller === undefined), "junk is dropped, never logged raw");
  const usage = readFileSync(join(dir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const gatewayUsage = usage.find((line) => line.sessionID === "gw-caller");
  assert.deepEqual(gatewayUsage.caller, caller);
  assert.deepEqual([gatewayUsage.input, gatewayUsage.cacheRead, gatewayUsage.cacheWrite], [10, 0, 0]);
}));

test("a configured-but-unloaded local model is not routable", async () => withTempHome(async (home) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  // qwen3.8-27b-uncensored and its cardmate cannot both be resident, so the router lists the
  // preset whether or not the weights are on a card. Presence alone must not make it routable.
  const modelsServer = await startModelsServer([
    { id: "qwen3.8-27b-uncensored", status: "unloaded" },
    { id: "qwen3.5-9b-coder", status: "loaded" },
  ]);
  let child;
  let socketPath;
  try {
    ({ child, socketPath } = await startBroker(home, { OPENCODE_BROKER_LOCAL_MODELS_URL: modelsServer.url }));
    try {
      await assert.rejects(request(socketPath, "/lease", {
        sessionID: "ses-unloaded",
        profile: "uncensored",
        tier: "worker",
        contextTokens: 100,
        replace: true,
      }), /no eligible local model is currently deployed/);

      // The gate is per-model, not a blanket local outage: the loaded one still leases.
      const loaded = await request(socketPath, "/lease", {
        sessionID: "ses-loaded",
        profile: "local",
        tier: "worker",
        contextTokens: 100,
        replace: true,
      });
      assert.equal(loaded.target.id, "local-coder");
    } finally {
      await stopBroker(child);
    }
  } finally {
    await modelsServer.stop();
  }
}));

test("a mid-swap local model is not routable until the load finishes", async () => withTempHome(async (home) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  // A 27b load takes ~20-40 s. Leasing against a half-loaded instance blocks the session for
  // the remainder of it, so "loading" is ineligible exactly like "unloaded".
  const modelsServer = await startModelsServer([{ id: "qwen3.8-27b-uncensored", status: "loading" }]);
  let child;
  let socketPath;
  try {
    ({ child, socketPath } = await startBroker(home, { OPENCODE_BROKER_LOCAL_MODELS_URL: modelsServer.url }));
    try {
      await assert.rejects(request(socketPath, "/lease", {
        sessionID: "ses-loading",
        profile: "uncensored",
        tier: "worker",
        contextTokens: 100,
        replace: true,
      }), /no eligible local model is currently deployed/);
    } finally {
      await stopBroker(child);
    }
  } finally {
    await modelsServer.stop();
  }
}));

test("a server that reports no status at all still routes local models", async () => withTempHome(async (home) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  // ☠️ Fail OPEN. Reading a missing status as "unloaded" would drop every local target at
  // once and move all local traffic to paid cloud, silently.
  const modelsServer = await startModelsServer(["qwen3.5-9b-coder"]);
  let child;
  let socketPath;
  try {
    ({ child, socketPath } = await startBroker(home, { OPENCODE_BROKER_LOCAL_MODELS_URL: modelsServer.url }));
    try {
      const leased = await request(socketPath, "/lease", {
        sessionID: "ses-no-status",
        profile: "local",
        tier: "worker",
        contextTokens: 100,
        replace: true,
      });
      assert.equal(leased.target.id, "local-coder");
    } finally {
      await stopBroker(child);
    }
  } finally {
    await modelsServer.stop();
  }
}));

test("inventory rejects a stale auth revision before publishing admission", async () => withBroker(async ({ home, socketPath }) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  const authPath = join(authDirectory, "auth.json");
  // alibaba-token-plan is the fixture's TRUSTED provider and must be present in
  // auth.json here: this test is about openai losing its OAuth proof, not about a
  // provider being switched off. A trusted provider absent from auth.json is now
  // correctly dropped (see the dedicated test below), which would otherwise leave
  // this scenario with no admissible fallback at all.
  const authContents = JSON.stringify({ openai: { type: "oauth" }, "alibaba-token-plan": { type: "api" } });
  writeFileSync(authPath, authContents);
  const stat = statSync(authPath);
  const revision = `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(authContents).digest("hex")}`;
  await request(socketPath, "/inventory", { ...inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }), authRevision: revision });
  await assert.rejects(request(socketPath, "/inventory", { ...inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }), authRevision: undefined }), /auth revision changed before inventory publication/);
  await assert.rejects(request(socketPath, "/inventory", { ...inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }), authRevision: "stale" }), /auth revision changed before inventory publication/);
}));

test("inventory rejects missing or stale config fingerprints without mutating full or auth-only state", async () => withBroker(async ({ socketPath }) => {
  const seededBody = inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  });
  const seeded = await request(socketPath, "/inventory", seededBody);
  assert.equal(seeded.accepted, true);
  const originalInventory = (await request(socketPath, "/status")).inventory;

  const { configFingerprint: _missing, ...missingFingerprint } = inventory({
    openai: { authType: "api", connected: false, classification: "static", models: 0 },
  });
  assert.deepEqual(await request(socketPath, "/inventory", missingFingerprint), {
    accepted: false,
    reason: "config-fingerprint-mismatch",
  });
  assert.deepEqual((await request(socketPath, "/status")).inventory, originalInventory,
    "a rejected full publication must not update data or timestamps");

  const changedProviders = {
    openai: { authType: "api", connected: false, classification: "static", models: 0 },
  };
  assert.deepEqual(await request(socketPath, "/inventory", {
    providers: changedProviders,
    authOnly: true,
    authRevision: seededBody.authRevision,
    configFingerprint: "stale-config",
  }), {
    accepted: false,
    reason: "config-fingerprint-mismatch",
  });
  assert.deepEqual((await request(socketPath, "/status")).inventory, originalInventory,
    "a rejected auth-only publication must not change provider admission");

  const accepted = await request(socketPath, "/inventory", {
    providers: changedProviders,
    authOnly: true,
    authRevision: seededBody.authRevision,
    configFingerprint: CONFIG_FINGERPRINT,
  });
  assert.equal(accepted.accepted, true);
  assert.deepEqual((await request(socketPath, "/status")).inventory.providers, {
    openai: { authType: "api", connected: false, admission: "admitted", models: 0 },
  });
}));

test("broker applies only advertised tier variants and auth-only refresh preserves catalog data", async () => withBroker(async ({ socketPath }) => {
  const full = inventory({ openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 } });
  full.modelContexts["openai/gpt-5.6-luna"] = 12345;
  full.modelVariants = { "openai/gpt-5.6-luna": ["low"] };
  await request(socketPath, "/inventory", full);
  const worker = await request(socketPath, "/lease", {
    sessionID: "ses-variant-worker", profile: "auto", tier: "worker", preferredModel: { providerID: "openai", id: "gpt-5.6-luna" }, replace: true,
  });
  assert.equal(worker.target.model.variant, "low");
  const smart = await request(socketPath, "/lease", {
    sessionID: "ses-variant-smart", profile: "auto", tier: "smart", replace: true,
  });
  assert.equal(smart.target.model.variant, undefined,
    "a tier cannot select capability the catalog did not advertise");
  await request(socketPath, "/inventory", {
    providers: { openai: { authType: "oauth", connected: true, classification: "static", models: 0 } },
    authOnly: true,
    authRevision: full.authRevision,
    configFingerprint: full.configFingerprint,
  });
  const status = await request(socketPath, "/status");
  assert.equal(status.inventory.modelContexts["openai/gpt-5.6-luna"], 12345);
  assert.deepEqual(status.inventory.modelVariants["openai/gpt-5.6-luna"], ["low"]);
}));

test("cloud leasing self-heals a rotated auth revision and drops unproven providers", async () => withBroker(async ({ home, socketPath }) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  const authPath = join(authDirectory, "auth.json");
  const authContents = JSON.stringify({ openai: { type: "oauth" } });
  writeFileSync(authPath, authContents);
  const stat = statSync(authPath);
  const revision = `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(authContents).digest("hex")}`;
  await request(socketPath, "/inventory", { ...inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }),
  targets: { "subscription-openai-test-smart": {
    id: "subscription-openai-test-smart", providerID: "openai", modelID: "gpt-test",
    kind: "cloud", capacity: null, source: "subscription-oauth", tiers: ["smart"],
  } },
  authRevision: revision });
  // Auth rotates AND openai stops proving OAuth: the next lease must not fail
  // outright (OAuth token refreshes rewrite auth.json constantly, and callers
  // without the router plugin's republish-retry -- the classifier -- starved on
  // every rotation). It self-heals: fresh admission, revoked provider excluded.
  writeFileSync(authPath, JSON.stringify({ openai: { type: "api-key" }, "alibaba-token-plan": { type: "api" } }));
  const healed = await request(socketPath, "/lease", {
    sessionID: "ses-stale-auth",
    profile: "auto",
    tier: "worker",
    contextTokens: 100,
    replace: true,
  });
  assert.notEqual(healed.target.model.providerID, "openai", "a no-longer-proven provider is not admitted");
  const status = await request(socketPath, "/status");
  assert.deepEqual(status.inventory.targets, {}, "discovered targets under revoked auth are dropped");
  assert.equal(status.inventory.providers.openai.connected, false);
}));

test("a second broker refuses to replace a live socket", async () => withBroker(async ({ home }) => {
  const duplicate = spawn(process.execPath, [brokerScript, "serve"], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  duplicate.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise((resolve) => duplicate.once("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /broker is already listening/);
}));

test("estimated budget exhaustion remains advisory until the provider reports quota exhaustion", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-held-budget",
    profile: "auto",
    tier: "worker",
    replace: true,
    preferredModel: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" },
  });
  assert.equal(lease.target.model.id, "qwen3.8-flash");
  await request(socketPath, "/usage", {
    providerID: "alibaba-token-plan",
    requests: 0,
    tokens: { input: 50_000_000, output: 50_000_000, cacheRead: 0, cacheWrite: 0 },
  });
  const renewed = await request(socketPath, "/lease", {
    sessionID: "ses-held-budget",
    profile: "auto",
    tier: "worker",
  });
  assert.equal(renewed.existing, true);
  assert.equal(renewed.target.model.id, "qwen3.8-flash");
}));

test("a confirmed Alibaba allocation quota blocks every Alibaba model until its reported reset", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-quota-reset", profile: "auto", tier: "worker", replace: true,
    preferredModel: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" },
  });
  assert.equal(lease.target.model.id, "qwen3.8-flash");
  // Relative to now: quotaRenewalAt deliberately REFUSES a reset already in the past,
  // so an absolute date here silently rots into a failure the day it passes.
  const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  await request(socketPath, "/failure", {
    sessionID: "ses-quota-reset",
    targetID: "qwen-flash",
    error: { code: "Throttling.AllocationQuota", message: `Allocated quota exceeded; reset at ${resetAt}` },
  });
  const status = await request(socketPath, "/status");
  assert.equal(status.circuits["provider:alibaba-token-plan"].kind, "quota");
  assert.equal(Date.parse(status.circuits["provider:alibaba-token-plan"].renewsAt), Date.parse(resetAt));
  const rerouted = await request(socketPath, "/lease", {
    sessionID: "ses-quota-reroute", profile: "auto", tier: "worker", replace: true,
  });
  assert.equal(rerouted.target.model.providerID, "openai");
}));

test("successful usage clears current probation and restores provider concurrency", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  await request(socketPath, "/quarantine", {
    scope: "provider", kind: "compatibility", providerID: "openai", reasonCode: "other",
  });
  await request(socketPath, "/rearm", { targetID: "provider:openai" });
  const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  await request(socketPath, "/failure", {
    sessionID: "ses-fence-alibaba",
    targetID: "qwen-flash",
    error: { code: "Throttling.AllocationQuota", message: `Allocated quota exceeded; reset at ${resetAt}` },
  });

  const probe = await request(socketPath, "/lease", {
    sessionID: "ses-openai-probe", profile: "auto", tier: "worker", replace: true,
  });
  assert.equal(probe.target.model.providerID, "openai");
  await assert.rejects(request(socketPath, "/lease", {
    sessionID: "ses-probation-blocked", profile: "auto", tier: "worker", replace: true,
  }), /all lightweight routing targets are busy or unavailable/);

  const usage = {
    sessionID: "ses-openai-probe",
    providerID: "openai",
    modelID: probe.target.model.id,
    requests: 1,
    tokens: {},
  };
  await request(socketPath, "/usage", { ...usage, observedAt: 1 });
  let status = await request(socketPath, "/status");
  assert.equal(status.health.providers.openai.state, "probation", "stale usage must not clear probation");
  assert.equal(status.circuits["provider:alibaba-token-plan"].kind, "quota");
  const budgetBeforeFutureUsage = status.budgets.openai;

  await request(socketPath, "/usage", { ...usage, observedAt: Date.now() + 60_000 });
  status = await request(socketPath, "/status");
  assert.equal(status.health.providers.openai.state, "probation", "future usage must not clear probation");
  assert.notDeepEqual(status.budgets.openai, budgetBeforeFutureUsage, "future usage still updates the budget");

  await request(socketPath, "/usage", { ...usage, observedAt: Date.now() });
  status = await request(socketPath, "/status");
  assert.equal(status.health.providers.openai, undefined);
  for (const sessionID of ["ses-openai-normal-a", "ses-openai-normal-b"]) {
    const lease = await request(socketPath, "/lease", {
      sessionID, profile: "auto", tier: "worker", replace: true,
    });
    assert.equal(lease.target.model.providerID, "openai");
  }
}));

test("Anthropic account quota reroutes the current session and blocks fresh sessions", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 2 },
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  await request(socketPath, "/usage", { providerID: "openai", requests: 100, tokens: {} });
  await request(socketPath, "/usage", {
    providerID: "alibaba-token-plan", requests: 0,
    tokens: { input: 50_000_000, output: 50_000_000 },
  });

  const first = await request(socketPath, "/lease", {
    sessionID: "ses-anthropic-quota", profile: "auto", tier: "fast-build", replace: true,
  });
  assert.equal(first.target.model.providerID, "anthropic");
  const failure = await request(socketPath, "/failure", {
    sessionID: "ses-anthropic-quota",
    targetID: first.target.id,
    error: { message: "This request would exceed your account's rate limit. Please try again later." },
  });
  assert.equal(failure.kind, "quota");
  let status = await request(socketPath, "/status");
  assert.equal(status.circuits["provider:anthropic"].kind, "quota");

  const continued = await request(socketPath, "/lease", {
    sessionID: "ses-anthropic-quota", profile: "auto", tier: "fast-build", replace: true,
  });
  assert.notEqual(continued.target.model.providerID, "anthropic");
  // A successful fallback usage report must not clear Anthropic's provider-level
  // quota circuit.
  await request(socketPath, "/usage", {
    sessionID: "ses-anthropic-quota",
    providerID: continued.target.model.providerID,
    modelID: continued.target.model.id,
    requests: 1,
    tokens: {},
  });
  const fresh = await request(socketPath, "/lease", {
    sessionID: "ses-fresh-during-anthropic-quota", profile: "auto", tier: "fast-build", replace: true,
  });
  assert.notEqual(fresh.target.model.providerID, "anthropic");
  status = await request(socketPath, "/status");
  assert.equal(status.circuits["provider:anthropic"].kind, "quota", "successful fallback usage cannot clear the quota circuit");
}));

test("a provider overload fences the target BRIEFLY (overload circuit), never crashing the handler", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-overload", profile: "auto", tier: "worker", replace: true,
  });
  const targetID = lease.target.id;
  const before = Date.now();
  // Before OVERLOAD_MS was defined, this threw a ReferenceError in the handler and
  // the target was NEVER fenced (the plugin swallowed the 400). Now it fences.
  const failure = await request(socketPath, "/failure", {
    sessionID: "ses-overload", targetID,
    error: { statusCode: 529, message: "Overloaded" },
  });
  assert.equal(failure.kind, "overload");
  const status = await request(socketPath, "/status");
  assert.equal(status.circuits[targetID]?.kind, "overload");
  const renewsAt = Date.parse(status.circuits[targetID].renewsAt);
  assert.ok(renewsAt - before > 0 && renewsAt - before < 60_000,
    `overload fence must be brief (a few seconds), got ${renewsAt - before}ms`);
}));

test("a quota response without a reset re-probes on a bounded cadence", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  await request(socketPath, "/lease", {
    sessionID: "ses-quota-indefinite", profile: "auto", tier: "worker", replace: true,
  });
  const failure = await request(socketPath, "/failure", {
    sessionID: "ses-quota-indefinite",
    targetID: "qwen-flash",
    error: { code: "insufficient_quota", message: "Token Plan quota exhausted" },
  });
  // An unknown reset must never hold the provider out until state surgery:
  // the circuit expires on a re-probe cadence (one failed request per probe),
  // and the response tells the caller when.
  assert.equal(failure.kind, "quota");
  const blocked = await request(socketPath, "/status");
  const renewsAt = Date.parse(blocked.circuits["provider:alibaba-token-plan"].renewsAt);
  assert.ok(renewsAt > Date.now() + 5 * 60 * 1000, "bounded circuit, minutes out");
  assert.ok(renewsAt < Date.now() + 60 * 60 * 1000, "not an indefinite block");
  assert.equal(failure.circuitUntil, renewsAt);
  await request(socketPath, "/rearm", { targetID: "provider:alibaba-token-plan" });
  const rearmed = await request(socketPath, "/status");
  assert.equal(rearmed.circuits["provider:alibaba-token-plan"], undefined);
}));

test("nested allocation quota signals open a provider circuit until their reset", async () => withBroker(async ({ socketPath }) => {
  // See above: must be in the future or quotaRenewalAt correctly declines it.
  const resetAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  await request(socketPath, "/failure", {
    sessionID: "ses-nested-quota",
    targetID: "qwen-flash",
    error: { data: { code: "Throttling.AllocationQuota", resetAt } },
  });
  const status = await request(socketPath, "/status");
  assert.equal(status.circuits["provider:alibaba-token-plan"].kind, "quota");
  assert.equal(Date.parse(status.circuits["provider:alibaba-token-plan"].renewsAt), Date.parse(resetAt));
}));

test("model-not-found circuits only that version, falls back, and is pruned with inventory", async () => withBroker(async ({ socketPath }) => {
  const target = (modelID, releaseDate) => ({
    id: `subscription-anthropic-${modelID}-standard`,
    providerID: "anthropic",
    modelID,
    kind: "cloud",
    capacity: null,
    source: "subscription-oauth",
    tiers: ["deep"],
    family: "claude-fable",
    releaseDate,
    speed: "standard",
  });
  const older = target("claude-fable-4-8", "2026-05-01");
  const newest = target("claude-fable-5", "2026-08-20");
  const base = inventory({ anthropic: { authType: "oauth", connected: true, classification: "static", models: 2 } });
  await request(socketPath, "/inventory", { ...base, targets: { [older.id]: older, [newest.id]: newest } });
  await request(socketPath, "/failure", {
    sessionID: "ses-block-qwen",
    targetID: "qwen-max",
    error: { code: "insufficient_quota", message: "subscription quota exhausted" },
  });
  await request(socketPath, "/failure", {
    sessionID: "ses-block-static-fable",
    targetID: "claude-fable-5-1",
    error: { statusCode: 404, code: "model_not_found", message: "model: claude-fable-5-1 not found" },
  });
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-model-newest", profile: "auto", tier: "deep", replace: true,
  });
  assert.equal(lease.target.model.id, "claude-fable-5");
  const failure = await request(socketPath, "/failure", {
    sessionID: "ses-model-newest",
    targetID: newest.id,
    error: { statusCode: 404, code: "model_not_found", message: "model: claude-fable-5 not found" },
  });
  assert.equal(failure.kind, "model");
  let status = await request(socketPath, "/status");
  assert.equal(status.circuits[newest.id].kind, "model");
  assert.equal(status.circuits[newest.id].renewsAt, null);
  assert.equal(status.circuits["provider:anthropic"], undefined);
  assert.equal(status.health.providers.anthropic, undefined);
  const fallback = await request(socketPath, "/lease", {
    sessionID: "ses-model-fallback", profile: "auto", tier: "deep", replace: true,
  });
  assert.equal(fallback.target.model.id, "claude-fable-4-8");
  await request(socketPath, "/inventory", { ...base, targets: { [older.id]: older } });
  status = await request(socketPath, "/status");
  assert.equal(status.circuits[newest.id], undefined);
}));

test("a session keeps its pinned model across releases; only a NEW session is balanced", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));

  const first = await request(socketPath, "/lease", {
    sessionID: "ses-replace",
    profile: "auto",
    tier: "worker",
    replace: true,
  });
  assert.equal(first.target.model.id, "gpt-5.6-luna");

  // Spend the session's provider hard, then release the lease the way the plugin does at idle.
  await request(socketPath, "/usage", {
    providerID: "openai",
    requests: 100,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  await request(socketPath, "/forget", { sessionID: "ses-replace" });

  // The next turn returns to the same model: a different model mid-task re-reads a history it
  // did not write, and that is what derailed long sessions.
  const again = await request(socketPath, "/lease", {
    sessionID: "ses-replace",
    profile: "auto",
    tier: "worker",
    replace: true,
  });
  assert.equal(again.target.model.id, "gpt-5.6-luna");
  assert.equal((await request(socketPath, "/selection")).lastDecision.policy, "session-stickiness");

  // Balancing still happens -- when a session gets its FIRST model.
  const fresh = await request(socketPath, "/lease", {
    sessionID: "ses-fresh",
    profile: "auto",
    tier: "worker",
    replace: true,
  });
  assert.equal(fresh.target.model.id, "qwen3.8-flash");
  const selection = await request(socketPath, "/selection");
  assert.deepEqual(selection.lastDecision.reasons, ["lowest-normalized-provider-utilization"]);
}));

test("a preferred session model stays sticky until it becomes ineligible", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const sticky = await request(socketPath, "/lease", {
    sessionID: "ses-sticky",
    profile: "auto",
    tier: "worker",
    replace: true,
    preferredModel: { providerID: "openai", id: "gpt-5.6-luna" },
  });
  assert.equal(sticky.target.model.id, "gpt-5.6-luna");
  let selection = await request(socketPath, "/selection");
  assert.equal(selection.lastDecision.policy, "session-stickiness");

  await request(socketPath, "/failure", {
    sessionID: "ses-sticky",
    targetID: "gpt-luna",
    error: "rate limit",
  });
  const rerouted = await request(socketPath, "/lease", {
    sessionID: "ses-sticky",
    profile: "auto",
    tier: "worker",
    replace: true,
    preferredModel: { providerID: "openai", id: "gpt-5.6-luna" },
  });
  assert.equal(rerouted.target.model.id, "qwen3.8-flash");
  selection = await request(socketPath, "/selection");
  assert.notEqual(selection.lastDecision.policy, "session-stickiness");
}));

test("a preferred Smart Opus session reroutes to GPT when Opus becomes ineligible", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 4 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 2 },
  }));
  const body = {
    sessionID: "ses-smart-opus",
    profile: "auto",
    tier: "smart",
    replace: true,
    preferredModel: { providerID: "anthropic", id: "claude-opus-5" },
  };
  assert.equal((await request(socketPath, "/lease", body)).target.id, "claude-opus-5");
  assert.equal((await request(socketPath, "/lease", body)).decision.policy, "session-stickiness");
  await request(socketPath, "/failure", {
    sessionID: "ses-smart-opus",
    targetID: "claude-opus-5",
    error: "rate limit",
  });
  const rerouted = await request(socketPath, "/lease", body);
  assert.equal(rerouted.target.id, "gpt-flagship");
  assert.notEqual(rerouted.decision.policy, "session-stickiness");
}));

test("strict fallback target stickiness yields to an eligible primary", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 2 },
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 3 },
  }));
  for (const targetID of ["gpt-terra", "deepseek-pro", "glm"]) {
    await request(socketPath, "/failure", { sessionID: `ses-block-${targetID}`, targetID, error: "rate limit" });
  }

  const fallback = await request(socketPath, "/lease", {
    sessionID: "ses-strict-stickiness", profile: "auto", tier: "build", replace: true,
    fallbackTargetID: "claude-opus-4-8-fast",
  });
  assert.equal(fallback.target.id, "claude-opus-4-8-fast");
  assert.equal(fallback.decision.policy, "strict-fallback");
  assert.ok(fallback.decision.reasons.includes("fallback-stickiness"));
  const fallbackSelection = await request(socketPath, "/selection");
  assert.deepEqual(fallbackSelection.lastDecision.eligibleTargetIDs.sort(), ["claude-opus-4-8-fast", "claude-opus-5-fast"]);
  assert.equal((await request(socketPath, "/status")).cursors["auto:build:cloud"], undefined,
    "fallback stickiness does not advance the round-robin cursor");

  await request(socketPath, "/rearm", { targetID: "gpt-terra" });
  const primary = await request(socketPath, "/lease", {
    sessionID: "ses-strict-stickiness", profile: "auto", tier: "build", replace: true,
    fallbackTargetID: "claude-opus-4-8-fast",
  });
  assert.equal(primary.target.id, "gpt-terra", "an eligible primary outranks fallback stickiness");
  assert.notEqual(primary.decision.policy, "strict-fallback");
}));

test("a diverged provider never moves a live session", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const preferredModel = { providerID: "openai", id: "gpt-5.6-luna" };
  const lease = () => request(socketPath, "/lease", {
    sessionID: "ses-rebalance", profile: "auto", tier: "worker", replace: true, preferredModel,
  });

  const first = await lease();
  assert.equal(first.target.model.id, "gpt-5.6-luna");

  // Spend openai far past the old 15% divergence threshold. The session stays put: live
  // rebalancing handed long sessions to a different model mid-task.
  await request(socketPath, "/usage", { providerID: "openai", requests: 90, tokens: {} });
  const held = await lease();
  const after = await request(socketPath, "/selection");
  assert.equal(held.target.model.id, "gpt-5.6-luna");
  assert.equal(after.lastDecision.policy, "session-stickiness");
  assert.ok(!(after.lastDecision.reasons ?? []).some((reason) => String(reason).startsWith("session-rebalanced")));
}));

test("Fast Build leases only Opus Fast models while they are eligible", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 2 },
  }));
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-fast-build",
    profile: "auto",
    tier: "fast-build",
    replace: true,
  });
  assert.equal(["claude-opus-5-fast", "claude-opus-4-8-fast"].includes(lease.target.model.id), true);
}));

test("Auto worker leases include the configured healthy local share", async () => withTempHome(async (home) => {
  const localServer = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen3.5-9b-coder" }] }));
  });
  await new Promise((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  const address = localServer.address();
  const localModelsURL = `http://127.0.0.1:${address.port}/v1/models`;
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
  const { child, socketPath } = await startBroker(home, { OPENCODE_BROKER_LOCAL_MODELS_URL: localModelsURL });
  try {
    await request(socketPath, "/inventory", inventory({
      openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    }));
    const leases = [];
    for (let index = 0; index < 4; index += 1) {
      leases.push(await request(socketPath, "/lease", {
        sessionID: `ses-local-share-${index}`, profile: "auto", tier: "worker", contextTokens: 100, replace: true,
      }));
    }
    assert.equal(leases.filter((lease) => lease.target.model.providerID === "llamacpp").length, 1);
    assert.equal(leases[0].target.model.id, "qwen3.5-9b-coder");
    assert.ok(leases.slice(1).some((lease) => lease.target.model.providerID === "openai"));
  } finally {
    await stopBroker(child);
    await new Promise((resolve) => localServer.close(resolve));
  }
}));

test("budget, auth, and circuit gates reject fresh leasing", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const gptLease = await request(socketPath, "/lease", {
    sessionID: "ses-circuit-gpt", profile: "auto", tier: "worker", replace: true,
  });
  assert.equal(gptLease.target.model.id, "gpt-5.6-luna");
  await request(socketPath, "/failure", {
    sessionID: "ses-circuit-gpt", targetID: "gpt-luna", error: "rate limit",
  });

  await request(socketPath, "/inventory", inventory({
    openai: { authType: "api-key", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  await request(socketPath, "/usage", {
    providerID: "alibaba-token-plan",
    requests: 0,
    tokens: { input: 50_000_000, output: 50_000_000, cacheRead: 0, cacheWrite: 0 },
  });
  const gated = await request(socketPath, "/lease", {
    sessionID: "ses-auth-budget", profile: "auto", tier: "worker",
    contextTokens: 100_000, replace: true,
  });
  assert.equal(gated.decision.policy, "context-overflow-last-resort");
  assert.equal(gated.target.id, "qwen-flash");
  assert.notEqual(gated.target.model.providerID, "openai");

  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const qwenLease = await request(socketPath, "/lease", {
    sessionID: "ses-circuit-qwen", profile: "auto", tier: "worker", replace: true,
  });
  assert.equal(qwenLease.target.model.id, "qwen3.8-flash");
  await request(socketPath, "/failure", {
    sessionID: "ses-circuit-qwen", targetID: "qwen-flash", error: "rate limit",
  });

  await assert.rejects(request(socketPath, "/lease", {
    sessionID: "ses-circuit-blocked", profile: "auto", tier: "worker",
    contextTokens: 100_000, replace: true,
  }), /all lightweight routing targets are busy or unavailable/);
}));

// The boundary the last resort must NOT cross: local targets. A llama.cpp slot's window
// is a hard wall with no roomier sibling behind it, and a LAN-confined profile that
// genuinely cannot serve a request should say so rather than fail at the provider.
test("the context last resort is cloud-only -- a local profile still refuses an oversized request", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  await assert.rejects(request(socketPath, "/lease", {
    sessionID: "ses-local-oversized",
    profile: "local",
    tier: "worker",
    contextTokens: 5_000_000,
    replace: true,
  }), /local/i);
}));

test("a providers allowlist narrows lease admission and never widens it", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  // Unconstrained worker lease can land anywhere; constrained must stay inside.
  const constrained = await request(socketPath, "/lease", {
    sessionID: "ses-allowlist", profile: "auto", tier: "worker", replace: true,
    providers: ["alibaba-token-plan", "llamacpp"],
  });
  assert.ok(["alibaba-token-plan", "llamacpp"].includes(constrained.target.model.providerID),
    `leased ${constrained.target.model.providerID}`);
  // An allowlist of only unavailable providers fails CLEARLY instead of
  // leaking a target from outside it.
  await assert.rejects(request(socketPath, "/lease", {
    sessionID: "ses-allowlist-2", profile: "auto", tier: "worker", replace: true,
    providers: ["nonexistent-provider"],
  }), /busy or unavailable|no.*target/i);
}));

// ☠️ The state file is rewritten IN FULL on every request, so the size of the assignment
// map is a per-request cost paid by every session on a daemon they all share. A 14-day
// TTL bounds age, not count -- measured 2026-09-08 at 2,958 assignments, a 405 KB file
// and /status p50 of 23.0 ms. This pins the cap that bounds it, and pins WHICH entries
// survive: recency, because the only readers (/failure, /complete, /forget) ask about a
// session that was active moments ago.


// ☠️ The state file is rewritten IN FULL on every request, so the size of the assignment
// map is a per-request cost paid by every session on a daemon they all share. A 14-day
// TTL bounds age, not count -- measured 2026-09-08 at 2,958 assignments, a 405 KB file
// and /status p50 of 23.0 ms. This pins the cap that bounds it, and pins WHICH entries
// survive: recency, because the only readers (/failure, /complete, /forget) ask about a
// session that was active moments ago.
// ☆ Seeded BEFORE the broker starts, because the daemon holds state in memory and never
// re-reads the file -- writing it behind a running broker tests nothing, which is how the
// first version of this test passed while exercising none of the cap.
test("assignments are capped by count, not just age, and the cap keeps the newest", async () => withTempHome(async (home) => {
  const share = join(home, ".local/share/opencode");
  const routing = join(share, "model-routing");
  mkdirSync(routing, { recursive: true });
  writeFileSync(join(share, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));

  // All well inside ASSIGNMENT_TTL_MS, so age cannot remove any of them -- only the cap can.
  const assignments = {};
  const base = Date.now() - 60_000;
  for (let i = 0; i < 900; i++) {
    assignments[`ses-flood-${String(i).padStart(4, "0")}`] =
      { targetID: "gpt-luna", profile: "auto", tier: "worker", updatedAt: base - (900 - i) * 1000 };
  }
  writeFileSync(join(routing, "broker.json"), JSON.stringify({
    version: 4, leases: {}, assignments, circuits: {}, cursors: {},
    inventory: {}, health: {}, budgets: {}, lastDecision: null, planUsage: {},
  }));

  // The broker sweeps and rewrites on startup, so the cap applies before it serves anything.
  const { child } = await startBroker(home);
  try {
    const after = JSON.parse(readFileSync(join(routing, "broker.json"), "utf8"));
    const ids = Object.keys(after.assignments);
    assert.equal(ids.length, 512, `capped to MAX_ASSIGNMENTS, got ${ids.length}`);
    assert.ok(ids.includes("ses-flood-0899"), "the most recent entry is kept");
    assert.ok(ids.includes("ses-flood-0388"), "the 512th-most-recent entry is kept");
    assert.ok(!ids.includes("ses-flood-0387"), "the 513th is dropped");
    assert.ok(!ids.includes("ses-flood-0000"), "the oldest is dropped");
  } finally {
    await stopBroker(child);
  }
}));

// THE CAP MUST NOT SPEND A LIVE SESSION'S PIN ON DEAD ONE-SHOT TRAFFIC. The gateway mints
// a NEW broker session id per CLIENT REQUEST (`gw-<time36>-<rand>`, gateway.js), so a gateway
// assignment becomes unreadable the moment that request settles -- the id never recurs, and
// nothing can ever ask about it again. A session pin is the exact opposite: it is read on that
// session's NEXT lease, which is what stickiness IS. Ordering the cap purely by recency ranked
// hundreds of dead gateway entries ABOVE live pins, because `updatedAt` is only rewritten by a
// FRESH selection -- /touch and held-lease revalidation refresh the LEASE and never the
// assignment, so an active session's pin ages as if it were idle. Measured on this host
// 2026-09-23: 512 assignments (the cap, holding), 450 of them settled gateway one-shots, and
// one of ten LIVE leases already had no assignment left at all.
const oneShotFlood = (count, newestAt, prefix = "gw-flood") => {
  const entries = {};
  for (let i = 0; i < count; i++) {
    entries[`${prefix}-${String(i).padStart(4, "0")}`] = {
      targetID: "gpt-luna",
      profile: "auto",
      tier: "worker",
      oneShot: true,
      updatedAt: newestAt - (count - i) * 1000,
    };
  }
  return entries;
};

// Every assignment test seeds BEFORE the daemon starts: the broker holds state in memory and
// never re-reads the file, so writing behind a running broker exercises none of the sweep.
// WRITE auth.json ONCE. authRevision is (mtime, size, hash), so REWRITING the same bytes
// still moves the revision, and a test that captures it via inventory() and then rewrites the
// file hands the daemon what looks like an auth rotation: admission is revalidated against
// the fixture's `test` provider, every cloud target drops, and the lease is refused with
// "all lightweight routing targets are busy or unavailable". It reproduces only when the two
// writes straddle a millisecond boundary -- 12 runs in 500 standalone, far more often under
// the parallel full-suite run -- so leaving it in buys an intermittent failure, not a test.
const writeAuth = (home) => {
  const share = join(home, ".local/share/opencode");
  mkdirSync(join(share, "model-routing"), { recursive: true });
  const authPath = join(share, "auth.json");
  if (!existsSync(authPath)) writeFileSync(authPath, JSON.stringify({ test: { type: "oauth" } }));
  return share;
};

const seedState = (home, state) => {
  const share = writeAuth(home);
  const statePath = join(share, "model-routing/broker.json");
  writeFileSync(statePath, JSON.stringify({
    version: 4, leases: {}, assignments: {}, circuits: {}, cursors: {},
    inventory: {}, health: {}, budgets: {}, lastDecision: null, planUsage: {}, rebalances: {},
    ...state,
  }));
  return statePath;
};

const brokerPolicyRequest = (overrides = {}) => ({
  transitionID: "transition-openai-sol-gpt6",
  revision: "revision-2",
  roleKey: "openai:gpt-sol",
  expectedIncumbentModelID: "gpt-5.6-sol",
  generation: 4,
  manifestHash: "a".repeat(64),
  desired: {
    activeModelID: "gpt-5.6-sol",
    probationModelID: "gpt-6-sol",
    rollbackModelID: "gpt-5.6-sol",
    routingIntent: {
      tiers: ["smart"], fit: { smart: 1.25 }, effortCeiling: "high", requiredReasoningMode: null,
    },
    probation: {
      phase: "staged-probing", offerEvery: 5, opportunityCursor: 0, opportunityMs: 0,
      opportunityCursorAt: null, opportunityEligibleUntil: null,
      successes: [], failures: [], leases: {},
    },
  },
  ...overrides,
});

const applyConfigPath = (home) => {
  const fixture = JSON.parse(readFileSync(process.env.OPENCODE_BROKER_CONFIG, "utf8")
    .replace(/^\s*\/\/.*$/gm, ""));
  fixture.reconcile = {
    apply: {
      enabled: true,
      overlayPath: join(home, "state/resolver-overlay.json"),
      generationsRoot: join(home, "state/generations"),
      currentLinkPath: join(home, "state/generations/current"),
    },
  };
  const path = join(home, "apply-config.json");
  writeFileSync(path, JSON.stringify(fixture));
  return path;
};

test("disabled model-policy CAS returns 409 and writes no broker state", async () => withBroker(async ({ home, socketPath }) => {
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  const before = readFileSync(statePath);
  const response = await rawRequest(socketPath, "/model-policy/cas", { body: brokerPolicyRequest() });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "reconcile-apply-disabled");
  assert.deepEqual(readFileSync(statePath), before);
}));

test("disabled resolver-process registration returns 409 and writes no broker state", async () => withBroker(async ({ home, socketPath }) => {
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  const before = readFileSync(statePath);
  const response = await rawRequest(socketPath, "/resolver-process/register", {
    body: { generation: 999, manifestHash: "forged", modelKeys: ["openai/gpt-6-sol"] },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "reconcile-apply-disabled");
  assert.deepEqual(readFileSync(statePath), before);
}));

test("enabled resolver registration validates the immutable manifest and broker restart invalidates its token", async () => withTempHome(async (home) => {
  writeAuth(home);
  const configPath = applyConfigPath(home);
  const generationsRoot = join(home, "state/generations");
  const currentLinkPath = join(generationsRoot, "current");
  const baseDirectory = join(home, "state/base");
  mkdirSync(baseDirectory, { recursive: true, mode: 0o700 });
  const baseConfigPath = join(baseDirectory, "opencode.json");
  writeFileSync(baseConfigPath, JSON.stringify({
    provider: { openai: { models: { "gpt-5.6-sol": { id: "gpt-5.6-sol" } } } },
  }) + "\n", { mode: 0o600 });
  const manager = createResolverGenerationManager({
    root: generationsRoot,
    currentLinkPath,
    runResolver: async () => "openai/gpt-5.6-sol\n",
    now: () => 1_800_000_000_000,
    pid: 77,
  });
  const generation0 = await manager.build({
    reservedGeneration: 0,
    bootstrapGeneration0: true,
    baseConfigPath,
    overlay: { version: 1, revision: 0, updatedAt: 1_800_000_000_000, entries: {} },
    authorizingRevisions: [],
    protectedReferences: [],
    authorizedRetirements: [],
  });
  await manager.publish(generation0);

  const modelsServer = await startModelsServer(["qwen3.5-9b-coder"]);
  try {
    const brokerEnv = {
      OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_BROKER_LOCAL_MODELS_URL: modelsServer.url,
    };
    const first = await startBroker(home, brokerEnv);
    let resolverToken;
    try {
      const registration = await rawRequest(first.socketPath, "/resolver-process/register", {
        body: {
          generation: generation0.generation,
          manifestHash: generation0.manifestHash,
          modelKeys: generation0.manifest.modelKeys,
        },
      });
      assert.equal(registration.status, 200);
      assert.equal(registration.body.scope, "ordinary");
      assert.equal(registration.body.generation, 0);
      resolverToken = registration.body.resolverToken;
      assert.match(resolverToken, /^[A-Za-z0-9_-]{43}$/);
      const processStatus = await rawRequest(first.socketPath, "/status", { body: {} });
      assert.equal(processStatus.body.resolverProcesses.active, 1);
      assert.deepEqual(processStatus.body.resolverProcesses.generations, { 0: 1 });
      assert.equal(processStatus.body.resolverProcesses.registrations[0].generation, 0);
      assert.equal(processStatus.body.resolverProcesses.registrations[0].manifestHash, generation0.manifestHash);
      assert.deepEqual(processStatus.body.resolverProcesses.registrations[0].modelKeys, generation0.manifest.modelKeys);
      assert.equal(JSON.stringify(processStatus.body.resolverProcesses).includes(resolverToken), false);

      const lease = await rawRequest(first.socketPath, "/lease", {
        body: { sessionID: "resolver-first", profile: "local", tier: "worker", replace: true, contextTokens: 0, resolverToken },
      });
      assert.equal(lease.status, 200, JSON.stringify(lease.body));
      assert.deepEqual(lease.body.decision.registration, {
        generation: 0,
        manifestHash: generation0.manifestHash,
        modelKeys: generation0.manifest.modelKeys,
        compatible: true,
        reason: null,
      });
      assert.equal(readFileSync(join(home, ".local/share/opencode/model-routing/broker.json"), "utf8").includes(resolverToken), false);
      const released = await rawRequest(first.socketPath, "/release", {
        body: { sessionID: "resolver-first", resolverToken },
      });
      assert.equal(released.status, 200);
    } finally {
      await stopBroker(first.child);
    }

    const restarted = await startBroker(home, brokerEnv);
    try {
      const lease = await rawRequest(restarted.socketPath, "/lease", {
        body: { sessionID: "resolver-restarted", profile: "local", tier: "worker", replace: true, contextTokens: 0, resolverToken },
      });
      assert.equal(lease.status, 200, JSON.stringify(lease.body));
      assert.equal(lease.body.decision.registration.generation, 0);
      assert.equal(lease.body.decision.registration.manifestHash, null);
      assert.equal(lease.body.decision.registration.reason, "invalid-token");
      assert.equal(lease.body.decision.registration.modelKeys.includes("openai/gpt-5.6-sol"), true);
    } finally {
      await stopBroker(restarted.child);
    }
  } finally {
    await modelsServer.stop();
  }
}));

test("v4 state migrates to v5 preserving existing fields and model-policy status is readable", async () => withTempHome(async (home) => {
  const now = Date.now();
  const statePath = seedState(home, {
    leases: { ses_migrate: { targetID: "gpt-flagship", profile: "auto", tier: "smart", touchedAt: now } },
    assignments: { ses_migrate: { targetID: "gpt-flagship", profile: "auto", tier: "smart", updatedAt: now } },
    circuits: { sentinel: { kind: "model", until: now + 60_000, updatedAt: now } },
    cursors: { smart: 3 },
    inventory: { targets: {}, providers: {}, modelContexts: {}, modelOutputs: {}, modelVariants: {}, authRevision: null, updatedAt: 17 },
    budgets: { openai: { marker: 1 } },
    lastDecision: { policy: "sentinel" },
    rebalances: { ses_migrate: now },
  });
  const { child, socketPath } = await startBroker(home);
  try {
    const migrated = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(migrated.version, 5);
    assert.deepEqual(migrated.leases.ses_migrate, {
      targetID: "gpt-flagship", profile: "auto", tier: "smart", touchedAt: now,
    });
    assert.deepEqual(migrated.assignments.ses_migrate, {
      targetID: "gpt-flagship", profile: "auto", tier: "smart", updatedAt: now,
    });
    assert.deepEqual(migrated.circuits.sentinel, { kind: "model", until: now + 60_000, updatedAt: now });
    assert.deepEqual(migrated.cursors, { smart: 3 });
    assert.deepEqual(migrated.budgets, { openai: { marker: 1 } });
    assert.deepEqual(migrated.lastDecision, { policy: "sentinel" });
    assert.deepEqual(migrated.rebalances, { ses_migrate: now });
    const status = await rawRequest(socketPath, "/model-policy/status", { method: "GET" });
    assert.equal(status.status, 200);
    assert.equal(status.body.modelPolicy.version, MODEL_POLICY_VERSION);
    assert.deepEqual(status.body.modelPolicy.roles, {});
    assert.equal(status.body.apply.enabled, false);
  } finally {
    await stopBroker(child);
  }
}));

test("model-policy status is read-only and an enabled CAS writes only on change", async () => withTempHome(async (home) => {
  writeAuth(home);
  const configPath = applyConfigPath(home);
  const { child, socketPath } = await startBroker(home, { OPENCODE_BROKER_CONFIG: configPath });
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  try {
    const beforeStatus = readFileSync(statePath);
    const initial = await rawRequest(socketPath, "/model-policy/status", { method: "GET" });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.apply.enabled, true);
    assert.deepEqual(readFileSync(statePath), beforeStatus, "GET status must not write");

    const first = await rawRequest(socketPath, "/model-policy/cas", { body: brokerPolicyRequest() });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.changed, true);
    const afterFirst = readFileSync(statePath);

    const replay = await rawRequest(socketPath, "/model-policy/cas", { body: brokerPolicyRequest() });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.changed, false);
    assert.deepEqual(replay.body.ack, first.body.ack);
    assert.deepEqual(readFileSync(statePath), afterFirst, "idempotent CAS must not rewrite state");

    const status = await rawRequest(socketPath, "/model-policy/status", { method: "GET" });
    assert.equal(status.body.modelPolicy.roles["openai:gpt-sol"].probationModelID, "gpt-6-sol");
  } finally {
    await stopBroker(child);
  }
}));

test("policy probation gives one compatible process the candidate while legacy and concurrent clients get the incumbent", async () => withTempHome(async (home) => {
  writeAuth(home);
  const configPath = applyConfigPath(home);
  const generationsRoot = join(home, "state/generations");
  const currentLinkPath = join(generationsRoot, "current");
  const baseDirectory = join(home, "state/base");
  mkdirSync(baseDirectory, { recursive: true, mode: 0o700 });
  const baseConfigPath = join(baseDirectory, "opencode.json");
  writeFileSync(baseConfigPath, JSON.stringify({
    provider: { openai: { models: {
      "gpt-5.6-sol": { id: "gpt-5.6-sol" },
      "gpt-6-sol": { id: "gpt-6-sol" },
    } } },
  }) + "\n", { mode: 0o600 });
  const manager = createResolverGenerationManager({
    root: generationsRoot,
    currentLinkPath,
    runResolver: async () => "openai/gpt-5.6-sol\nopenai/gpt-6-sol\n",
    now: () => 1_800_000_000_000,
    pid: 78,
  });
  const generation = await manager.build({
    reservedGeneration: 0,
    bootstrapGeneration0: true,
    baseConfigPath,
    overlay: { version: 1, revision: 0, updatedAt: 1_800_000_000_000, entries: {} },
    authorizingRevisions: [],
    protectedReferences: [],
    authorizedRetirements: [],
  });
  await manager.publish(generation);

  const broker = await startBroker(home, {
    OPENCODE_BROKER_CONFIG: configPath,
    OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
  }, [...DEFAULT_RESOLVABLE_MODELS, "openai/gpt-6-sol"]);
  try {
    const registration = await rawRequest(broker.socketPath, "/resolver-process/register", {
      body: {
        generation: generation.generation,
        manifestHash: generation.manifestHash,
        modelKeys: generation.manifest.modelKeys,
      },
    });
    assert.equal(registration.status, 200);

    const policy = brokerPolicyRequest({
      generation: 1,
      desired: {
        ...brokerPolicyRequest().desired,
        probation: { ...brokerPolicyRequest().desired.probation, phase: "probation" },
      },
    });
    assert.equal((await rawRequest(broker.socketPath, "/model-policy/cas", { body: policy })).status, 200);

    const candidateID = "subscription-openai-gpt-6-sol-standard";
    const published = inventory({
      openai: { authType: "oauth", connected: true, admission: "admitted", models: 1 },
    });
    published.targets = {
      [candidateID]: {
        id: candidateID,
        providerID: "openai",
        modelID: "gpt-6-sol",
        kind: "cloud",
        capacity: null,
        source: "subscription-oauth",
        tiers: ["smart"],
        fit: { smart: 9 },
        family: "gpt-sol",
        releaseDate: "2026-09-22",
        speed: "standard",
        capabilities: { toolCall: true },
        context: 400_000,
        output: 96_000,
        variants: ["low", "medium"],
      },
    };
    published.modelContexts = { "openai/gpt-6-sol": 400_000 };
    published.modelOutputs = { "openai/gpt-6-sol": 96_000 };
    published.modelVariants = { "openai/gpt-6-sol": ["low", "medium"] };
    published.configFingerprint = createHash("sha256").update(readFileSync(configPath)).digest("hex");
    await request(broker.socketPath, "/inventory", published);

    const candidate = await rawRequest(broker.socketPath, "/lease", {
      body: {
        sessionID: "policy-candidate",
        profile: "auto",
        tier: "smart",
        providers: ["openai"],
        replace: true,
        resolverToken: registration.body.resolverToken,
      },
    });
    assert.equal(candidate.status, 200, JSON.stringify(candidate.body));
    assert.equal(candidate.body.target.model.id, "gpt-6-sol");
    assert.equal(candidate.body.target.model.variant, "medium");

    const concurrent = await rawRequest(broker.socketPath, "/lease", {
      body: {
        sessionID: "policy-concurrent",
        profile: "auto",
        tier: "smart",
        providers: ["openai"],
        replace: true,
        resolverToken: registration.body.resolverToken,
      },
    });
    assert.equal(concurrent.status, 200, JSON.stringify(concurrent.body));
    assert.equal(concurrent.body.target.model.id, "gpt-5.6-sol");
    assert.equal(Object.hasOwn(concurrent.body.decision, "blockedGeneration"), false,
      "generation holds are recorded only on the lease they exclude");

    const legacy = await rawRequest(broker.socketPath, "/lease", {
      body: {
        sessionID: "policy-legacy",
        profile: "auto",
        tier: "smart",
        providers: ["openai"],
        replace: true,
      },
    });
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(legacy.body.target.model.id, "gpt-5.6-sol");
    assert.equal(legacy.body.decision.blockedGeneration, true);
    assert.equal(legacy.body.decision.reasons.includes("blocked-generation"), true);
  } finally {
    await stopBroker(broker.child);
  }
}));

test("corrupt malformed and unknown model-policy state fail broker startup loudly without replacement", async () => withTempHome(async (home) => {
  const base = {
    version: 5, leases: {}, assignments: {}, circuits: {}, cursors: {}, inventory: {}, health: {},
    budgets: {}, lastDecision: null, planUsage: {}, rebalances: {},
  };
  const cases = [
    ["corrupt", Buffer.from("{broken\n"), /broker state.*corrupt|unexpected token|json/i],
    ["malformed", Buffer.from(JSON.stringify({ ...base, modelPolicy: { version: 1, roles: [], history: [] } })), /model policy.*roles/i],
    ["unknown", Buffer.from(JSON.stringify({ ...base, modelPolicy: { version: 99, roles: {}, history: [] } })), /model policy version/i],
  ];
  for (const [name, bytes, expected] of cases) {
    const caseHome = join(home, name);
    mkdirSync(caseHome);
    const result = await startBrokerFailure(caseHome, bytes);
    assert.notEqual(result.code, 0, `${name}: ${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /listening on/, name);
    assert.match(result.stderr, expected, name);
    assert.deepEqual(readFileSync(join(caseHome, ".local/share/opencode/model-routing/broker.json")), bytes,
      `${name} state must be preserved for diagnosis`);
  }
}));

test("the assignment cap evicts settled one-shot gateway entries before session pins", async () => withTempHome(async (home) => {
  const now = Date.now();
  const assignments = {};
  // Session pins, deliberately OLDER than every one-shot entry -- which is the real shape,
  // since a pin's timestamp stops moving the moment the session stops being re-selected.
  // Under a flat recency order these are precisely the entries the cap discards first.
  for (let i = 0; i < 20; i++) {
    assignments[`ses_pin${String(i).padStart(2, "0")}`] = {
      targetID: "gpt-luna", profile: "auto", tier: "worker",
      updatedAt: now - 3_600_000 - (20 - i) * 1000,
    };
  }
  Object.assign(assignments, oneShotFlood(600, now - 60_000));
  const statePath = seedState(home, { assignments });

  const { child } = await startBroker(home);
  try {
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    const ids = Object.keys(after.assignments);
    assert.equal(ids.length, 512, `capped to MAX_ASSIGNMENTS, got ${ids.length}`);
    for (let i = 0; i < 20; i++) {
      const pin = `ses_pin${String(i).padStart(2, "0")}`;
      assert.ok(after.assignments[pin], `${pin} must outlive dead one-shot gateway traffic`);
    }
    // 620 seeded, 512 kept: the 108 evicted are the OLDEST one-shots and nothing else.
    assert.ok(!after.assignments["gw-flood-0107"], "the 108th-oldest one-shot is evicted");
    assert.ok(after.assignments["gw-flood-0108"], "the 109th-oldest one-shot survives");
  } finally {
    await stopBroker(child);
  }
}));

// THE FLAG IS ABSENT ON EVERY ENTRY THIS HOST ALREADY HAS. `oneShot` is only written by
// leases taken since it existed, so a broker upgraded in place carries hundreds of gateway
// assignments with no such field (455 measured here 2026-09-23). Read as session pins they are
// PROTECTED by the tier order for the full 14-day TTL, and the tiered eviction then applies to
// new traffic only -- live pins keep losing to dead gateway ids, which is the failure the tier
// order was written to stop. The `gw-` prefix is the gateway's own naming contract
// (`gw-<time36>-<rand>`, gateway.js) and acquire() refuses a oneShot declaration from any other
// prefix, so inferring one-shot from the prefix when the flag is absent is reading that
// contract, not guessing.
test("the assignment cap evicts a gw- entry that predates the oneShot flag ahead of a session pin", async () => withTempHome(async (home) => {
  const now = Date.now();
  const assignments = {};
  // Session pins, older than every gateway entry -- the real shape, since a pin's timestamp
  // stops moving as soon as the session stops being re-selected.
  for (let i = 0; i < 20; i++) {
    assignments[`ses_legacy_pin${String(i).padStart(2, "0")}`] = {
      targetID: "gpt-luna", profile: "auto", tier: "worker",
      updatedAt: now - 3_600_000 - (20 - i) * 1000,
    };
  }
  // No `oneShot` field anywhere in this group: these are the entries already on disk.
  for (let i = 0; i < 600; i++) {
    assignments[`gw-legacy-${String(i).padStart(4, "0")}`] = {
      targetID: "gpt-luna", profile: "auto", tier: "worker",
      updatedAt: now - 60_000 - (600 - i) * 1000,
    };
  }
  const statePath = seedState(home, { assignments });

  const { child } = await startBroker(home);
  try {
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    const ids = Object.keys(after.assignments);
    assert.equal(ids.length, 512, `capped to MAX_ASSIGNMENTS, got ${ids.length}`);
    for (let i = 0; i < 20; i++) {
      const pin = `ses_legacy_pin${String(i).padStart(2, "0")}`;
      assert.ok(after.assignments[pin], `${pin} must outlive flagless gateway traffic`);
    }
    // 620 seeded, 512 kept: the 108 evicted are the oldest gw- entries and nothing else.
    assert.ok(!after.assignments["gw-legacy-0107"], "the 108th-oldest flagless gw- entry is evicted");
    assert.ok(after.assignments["gw-legacy-0108"], "the 109th-oldest flagless gw- entry survives");
  } finally {
    await stopBroker(child);
  }
}));

test("the assignment cap never evicts a session that still holds a live lease", async () => withTempHome(async (home) => {
  const now = Date.now();
  // The competitors here are ORDINARY assignments, not one-shots, so tier ordering cannot
  // rescue the pin: only the live-lease rule can. That keeps this test about one property.
  const assignments = {};
  for (let i = 0; i < 600; i++) {
    assignments[`ses_busy${String(i).padStart(4, "0")}`] = {
      targetID: "gpt-luna", profile: "auto", tier: "worker",
      updatedAt: now - 60_000 - (600 - i) * 1000,
    };
  }
  // The oldest assignment in the file by ten hours, and the one session demonstrably alive:
  // its lease was touched a moment ago, so it survives the lease sweep in this same pass.
  assignments["ses_live"] = {
    targetID: "gpt-luna", profile: "auto", tier: "worker", updatedAt: now - 10 * 3_600_000,
  };
  const statePath = seedState(home, {
    assignments,
    leases: { ses_live: { targetID: "gpt-luna", touchedAt: now, profile: "auto", tier: "worker" } },
  });

  const { child } = await startBroker(home);
  try {
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(Object.keys(after.assignments).length, 512,
      "the cap still bounds the map");
    assert.ok(after.leases["ses_live"], "the lease itself is still live");
    assert.ok(after.assignments["ses_live"],
      "an assignment whose session still holds a live lease is never evicted by the cap");
  } finally {
    await stopBroker(child);
  }
}));

// The 14-day TTL is an AGE rule, and age alone is the wrong question for a session that is
// still running. Held-lease revalidation (`/lease` with `replace: false`) refreshes
// `lease.touchedAt` and never `assignment.updatedAt` -- only a FRESH selection moves that --
// so a session that revalidates for longer than the TTL has a live lease and an assignment the
// age sweep deletes out from under it. That contradicts the rule the cap below obeys, and it
// costs the session its pinned model on its next selection.
test("the assignment TTL evicts by age only when no live lease holds the session", async () => withTempHome(async (home) => {
  const now = Date.now();
  const aged = now - 15 * 24 * 3_600_000; // past ASSIGNMENT_TTL_MS (14 days) either way
  const statePath = seedState(home, {
    assignments: {
      ses_ttl_live: { targetID: "gpt-luna", profile: "auto", tier: "worker", updatedAt: aged },
      ses_ttl_idle: { targetID: "gpt-luna", profile: "auto", tier: "worker", updatedAt: aged },
    },
    // Touched a moment ago, so it survives the lease sweep in this same pass.
    leases: { ses_ttl_live: { targetID: "gpt-luna", touchedAt: now, profile: "auto", tier: "worker" } },
  });

  const { child } = await startBroker(home);
  try {
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(after.leases["ses_ttl_live"], "the lease itself survived the lease sweep");
    assert.ok(after.assignments["ses_ttl_live"],
      "an assignment whose session still holds a live lease is never evicted, by age or by cap");
    assert.ok(!after.assignments["ses_ttl_idle"],
      "and the TTL still removes an aged assignment that no lease holds");
  } finally {
    await stopBroker(child);
  }
}));

test("a session keeps its pinned model across the rebalance cooldown while one-shot traffic floods the cap", async () => withTempHome(async (home) => {
  const now = Date.now();
  writeAuth(home);
  const inv = inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  });
  const statePath = seedState(home, {
    assignments: {
      ses_sticky: { targetID: "gpt-luna", profile: "auto", tier: "worker", updatedAt: now - 3_600_000 },
      ...oneShotFlood(600, now - 60_000),
    },
    // Well inside sessionRebalance's cooldown, so the stamp is not what decides this lease:
    // the pin is. A fix that preserved the pin by disturbing the rebalance clock fails here.
    rebalances: { ses_sticky: now - 60_000 },
    inventory: inv,
  });

  const { child, socketPath } = await startBroker(home);
  try {
    const seeded = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(seeded.assignments["ses_sticky"], "the pin survives the startup sweep");
    const lease = await request(socketPath, "/lease", {
      sessionID: "ses_sticky", profile: "auto", tier: "worker", contextTokens: 100,
    });
    assert.equal(lease.decision.policy, "session-stickiness",
      "the pin must still decide the lease after a cap flood of dead one-shot entries");
    // The pinned TARGET this test seeded, not a model id out of the inventory fixture: a
    // renamed fixture model would otherwise fail this as "wrong model" when the property
    // under test -- that the pin survived and decided the lease -- is fine.
    assert.equal(lease.target.id, "gpt-luna", "and it returns to the target the pin names");
  } finally {
    await stopBroker(child);
  }
}));

test("assignment eviction is deterministic under injected timestamps and idempotent on a second sweep", async () => withTempHome(async (home) => {
  // Pins and one-shots INTERLEAVED in time, so neither group is uniformly older and the
  // survivor set is a fact about the policy rather than about the seeding order. Every
  // timestamp is injected, distinct, and offset from one fixed base, so the survivor set is
  // decided by the relative order alone and there is no tie to break. The base is 15 minutes
  // back -- far inside ASSIGNMENT_TTL_MS at both ends, so the age sweep removes nothing here
  // however long the run takes, and only the cap is under test.
  const base = Date.now() - 900_000;
  const assignments = {};
  for (let i = 0; i < 300; i++) {
    assignments[`ses_mix${String(i).padStart(4, "0")}`] = {
      targetID: "gpt-luna", profile: "auto", tier: "worker", updatedAt: base + i * 2000,
    };
  }
  for (let i = 0; i < 400; i++) {
    assignments[`gw-one-${String(i).padStart(4, "0")}`] = {
      targetID: "gpt-luna", profile: "auto", tier: "worker", oneShot: true,
      updatedAt: base + i * 2000 + 1000,
    };
  }
  const statePath = seedState(home, { assignments });

  // 700 seeded, cap 512, so 188 go -- and they are the 188 OLDEST ONE-SHOTS exactly:
  // 300 pins + 212 surviving one-shots = 512.
  const first = await startBroker(home);
  let surviving;
  try {
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    surviving = Object.keys(after.assignments).sort();
    assert.equal(surviving.length, 512, `capped to MAX_ASSIGNMENTS, got ${surviving.length}`);
    for (let i = 0; i < 300; i++) {
      const pin = `ses_mix${String(i).padStart(4, "0")}`;
      assert.ok(after.assignments[pin], `${pin} outranks every settled one-shot`);
    }
    assert.ok(!after.assignments["gw-one-0187"], "the 188th-oldest one-shot is evicted");
    assert.ok(after.assignments["gw-one-0188"], "the 189th-oldest one-shot survives");
  } finally {
    await stopBroker(first.child);
  }

  // Same injected timestamps, same file: a second sweep must neither drop nor revive one.
  const second = await startBroker(home);
  try {
    const again = Object.keys(JSON.parse(readFileSync(statePath, "utf8")).assignments).sort();
    assert.deepEqual(again, surviving,
      "eviction is a function of the injected updatedAt, not of when the sweep happened");
  } finally {
    await stopBroker(second.child);
  }
}));

test("a one-shot lease marks its assignment so the cap can evict it ahead of session pins", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  await request(socketPath, "/lease", {
    sessionID: "gw-marker-test", profile: "auto", tier: "worker", contextTokens: 100,
    replace: true, oneShot: true,
  });
  await request(socketPath, "/lease", {
    sessionID: "ses_marker_test", profile: "auto", tier: "worker", contextTokens: 100,
    replace: true,
  });
  const status = await request(socketPath, "/status");
  assert.equal(status.assignments["gw-marker-test"].oneShot, true,
    "a caller that declares its session id is per-request gets a one-shot assignment");
  assert.equal(status.assignments["ses_marker_test"].oneShot, undefined,
    "an ordinary session assignment carries no such marker");
}));

// A ONE-SHOT ASSIGNMENT IS DEAD THE MOMENT ITS LEASE ENDS. The reason an ordinary assignment
// outlives its lease is that the session's NEXT turn reads it back -- that is what stickiness
// is. A one-shot session id is minted per client request and never recurs, so there is no next
// turn and no reader: keeping the entry only spends cap space and file size on something
// nothing can ever ask for. Dropping it at the end of the lease means the cap rarely has to
// evict at all, instead of carrying hundreds of settled gateway ids until it overflows.
const oneShotEndOfLease = (endpoint) =>
  test(`${endpoint} drops a one-shot session's assignment and keeps an ordinary session's pin`, async () => withBroker(async ({ socketPath }) => {
    await request(socketPath, "/inventory", inventory({
      openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
      "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    }));
    const oneShotID = `gw-end-${endpoint.slice(1)}`;
    const sessionPinID = `ses_end_${endpoint.slice(1)}`;
    for (const [sessionID, oneShot] of [[oneShotID, true], [sessionPinID, false]]) {
      await request(socketPath, "/lease", {
        sessionID, profile: "auto", tier: "worker", contextTokens: 100, replace: true,
        ...(oneShot ? { oneShot: true } : {}),
      });
      await request(socketPath, endpoint, { sessionID });
    }
    const status = await request(socketPath, "/status");
    assert.equal(status.assignments[oneShotID], undefined,
      `${endpoint} must drop a one-shot assignment -- nothing can ever read it back`);
    assert.ok(status.assignments[sessionPinID],
      `${endpoint} must keep an ordinary session's pin for its next turn`);
  }));

oneShotEndOfLease("/release");
oneShotEndOfLease("/complete");
oneShotEndOfLease("/forget");

// `oneShot` is CLIENT-DECLARED, and declaring it is asking to be evicted first. A caller that
// sets it on a real session id -- a copied request body, a wrapper that sets it for every
// lease it proxies -- would hand the cap a genuine session's pin to spend ahead of dead
// gateway traffic, which is the original failure wearing the fix's clothes. The prefix is the
// contract on both sides: the sweep infers one-shot from `gw-` when the flag is absent, so the
// declaration has to agree with the prefix or the two readings of the same entry diverge.
test("/lease refuses a oneShot declaration from a session id that is not per-request", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  await assert.rejects(request(socketPath, "/lease", {
    sessionID: "ses_bogus_one_shot", profile: "auto", tier: "worker", contextTokens: 100,
    replace: true, oneShot: true,
  }), /per-request session id/);
  const status = await request(socketPath, "/status");
  assert.equal(status.assignments["ses_bogus_one_shot"], undefined,
    "a refused lease leaves no assignment behind");
  // The gateway's own ids keep working, so the contract refuses only the mismatch.
  await request(socketPath, "/lease", {
    sessionID: "gw-contract-ok", profile: "auto", tier: "worker", contextTokens: 100,
    replace: true, oneShot: true,
  });
  assert.equal((await request(socketPath, "/status")).assignments["gw-contract-ok"].oneShot, true);
}));

test("the first lease waits for a due plan refresh before admitting an exhausted provider", async () => withTempHome(async (home) => {
  const share = join(home, ".local/share/opencode");
  const routing = join(share, "model-routing");
  const bin = join(home, ".local/bin");
  mkdirSync(routing, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(share, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));

  const resetAt = Date.now() + 60 * 60 * 1000;
  const bl = join(bin, "bl");
  writeFileSync(bl, `#!/bin/sh\nsleep 0.2\nprintf '%s\\n' '${JSON.stringify({ per5HourPercentage: 1, per5HourResetTime: resetAt })}'\n`);
  chmodSync(bl, 0o755);

  const config = JSON.parse(readFileSync(process.env.OPENCODE_BROKER_CONFIG, "utf8").replace(/^\s*\/\/.*$/gm, ""));
  config.budgets.anthropic.planUsage = { type: "bailian-cli" };
  const configPath = join(home, "router-config.json");
  writeFileSync(configPath, JSON.stringify(config));

  writeFileSync(join(routing, "broker.json"), JSON.stringify({
    version: 4, leases: {}, assignments: {}, circuits: {}, cursors: {}, health: {}, budgets: {}, lastDecision: null, planUsage: {},
    inventory: inventory({
      anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 2 },
      openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    }),
  }));

  const { child, socketPath } = await startBroker(home, { OPENCODE_BROKER_CONFIG: configPath });
  try {
    const lease = await request(socketPath, "/lease", {
      sessionID: "ses-plan-refresh", profile: "auto", tier: "fast-build", replace: true,
    });
    assert.notEqual(lease.target.model.providerID, "anthropic",
      "the lease must not race ahead of the refresh that reports Anthropic exhausted");
    const status = await request(socketPath, "/status");
    assert.equal(status.circuits["provider:anthropic"].kind, "plan-window");
    assert.equal(status.circuits["provider:anthropic"].until, resetAt);
  } finally {
    await stopBroker(child);
  }
}));

test("a local-only lease does not await a due cloud-plan refresh", async () => withTempHome(async (home) => {
  const share = join(home, ".local/share/opencode");
  const bin = join(home, ".local/bin");
  mkdirSync(share, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(share, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));

  const planPidPath = join(home, "plan-refresh.pid");
  const planPid = () => {
    try {
      const value = Number(readFileSync(planPidPath, "utf8").trim());
      return Number.isInteger(value) && value > 1 ? value : null;
    } catch {
      return null;
    }
  };
  const bl = join(bin, "bl");
  writeFileSync(bl, `#!/bin/sh\nprintf '%s\\n' "$$" > "${planPidPath}"\nexec sleep 20\n`);
  chmodSync(bl, 0o755);

  const config = JSON.parse(readFileSync(process.env.OPENCODE_BROKER_CONFIG, "utf8").replace(/^\s*\/\/.*$/gm, ""));
  config.budgets.anthropic.planUsage = { type: "bailian-cli" };
  const configPath = join(home, "router-config.json");
  writeFileSync(configPath, JSON.stringify(config));

  const modelsServer = await startModelsServer(["qwen3.5-9b-coder"]);
  let child;
  let timer;
  try {
    const started = await startBroker(home, {
      OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_BROKER_LOCAL_MODELS_URL: modelsServer.url,
    });
    child = started.child;
    const lease = await Promise.race([
      request(started.socketPath, "/lease", {
        sessionID: "ses-local-only-plan-refresh", profile: "auto", tier: "worker",
        contextTokens: 100, replace: true, localOnly: true,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("local-only lease awaited cloud plan refresh")), 1000);
      }),
    ]);
    clearTimeout(timer);
    timer = null;
    assert.equal(lease.target.id, "local-coder");
    await waitFor(() => planPid() !== null, "the cloud plan refresh to be in flight");
  } finally {
    if (timer) clearTimeout(timer);
    const pid = planPid();
    if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
    if (child) await stopBroker(child);
    await modelsServer.stop();
  }
}));

test("a lease abandoned after its local probe leaves routing state unchanged", async () => withTempHome(async (home) => {
  let releaseProbe;
  let markProbeStarted;
  let rejectProbeStarted;
  const probeStarted = new Promise((resolve, reject) => {
    markProbeStarted = resolve;
    rejectProbeStarted = reject;
  });
  const modelsServer = http.createServer((req, res) => {
    if (req.url !== "/v1/models") {
      res.writeHead(404);
      res.end();
      return;
    }
    releaseProbe = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "qwen3.5-9b-coder" }] }));
    };
    markProbeStarted();
  });
  await new Promise((resolve) => modelsServer.listen(0, "127.0.0.1", resolve));
  const localModelsURL = `http://127.0.0.1:${modelsServer.address().port}/v1/models`;

  const now = Date.now();
  const statePath = seedState(home, {
    cursors: { sentinel: 7 },
    assignments: {
      ses_existing: { targetID: "gpt-luna", profile: "auto", tier: "worker", updatedAt: now },
    },
    leases: {
      ses_existing: { targetID: "gpt-luna", profile: "auto", tier: "worker", touchedAt: now },
    },
  });
  const { child, socketPath } = await startBroker(home, { OPENCODE_BROKER_LOCAL_MODELS_URL: localModelsURL });
  try {
    const body = JSON.stringify({
      sessionID: "ses-abandoned-post-probe", profile: "local", tier: "worker",
      contextTokens: 100, replace: true,
    });
    const leaseRequest = http.request({
      socketPath,
      path: "/lease",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    let disconnected = false;
    leaseRequest.on("error", (error) => {
      if (!disconnected) rejectProbeStarted(error);
    });
    leaseRequest.end(body);
    await probeStarted;

    disconnected = true;
    leaseRequest.destroy(new Error("test disconnect after local probe"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = JSON.parse(readFileSync(statePath, "utf8"));
    const snapshots = Object.fromEntries(["cursors", "assignments", "leases"]
      .map((key) => [key, JSON.stringify(before[key])]));

    releaseProbe();
    const after = await request(socketPath, "/status");
    for (const key of ["cursors", "assignments", "leases"]) {
      assert.equal(JSON.stringify(after[key]), snapshots[key], `${key} changed after the request was abandoned`);
    }
  } finally {
    await stopBroker(child);
    await new Promise((resolve) => modelsServer.close(resolve));
  }
}));

// CRITICAL: THE DAEMON DOES NOT TRUST A PUBLISHER. Model admission (drop anything this host
// cannot resolve) was first implemented in the PUBLISHER -- plugin/router.js, which every
// opencode process loads at spawn and which re-publishes on every chat.message. A pane
// started before an admission fix therefore keeps publishing the OLD unfiltered inventory
// for its whole life, and re-poisons the broker within seconds of a restart. Measured
// 2026-09-23: a clean `discovered: []` became `["gpt-6-astra","gpt-6-luna","gpt-6-sol"]`
// again from a pre-existing pane, and every worker-tier lease died with
// ProviderModelNotFoundError. The same filter therefore runs again at the ingest boundary,
// where no client can be ahead of or behind the daemon.
const discoveredFable = (modelID, releaseDate) => ({
  id: `subscription-anthropic-${modelID}-standard`,
  providerID: "anthropic",
  modelID,
  kind: "cloud",
  capacity: null,
  source: "subscription-oauth",
  tiers: ["deep"],
  family: "claude-fable",
  releaseDate,
  speed: "standard",
});

// The deep tier's two static pins, cleared so the DISCOVERED claude-fable family is what
// the tier actually selects -- the same setup the model-not-found test above uses.
const clearStaticDeepPins = async (socketPath) => {
  await request(socketPath, "/failure", {
    sessionID: "ses-ingest-quota",
    targetID: "qwen-max",
    error: { code: "insufficient_quota", message: "subscription quota exhausted" },
  });
  await request(socketPath, "/failure", {
    sessionID: "ses-ingest-not-found",
    targetID: "claude-fable-5-1",
    error: { statusCode: 404, code: "model_not_found", message: "model: claude-fable-5-1 not found" },
  });
};

const fableInventory = () => {
  const older = discoveredFable("claude-fable-5", "2026-05-01");
  const unresolvable = discoveredFable("claude-fable-6", "2026-08-20");
  const base = inventory({
    anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 2 },
  });
  return { older, unresolvable, body: { ...base, targets: { [older.id]: older, [unresolvable.id]: unresolvable } } };
};

test("/inventory refuses a published target this host cannot resolve and the tier falls back", async () => withBroker(async ({ socketPath }) => {
  const { older, unresolvable, body } = fableInventory();
  await request(socketPath, "/inventory", body);
  await clearStaticDeepPins(socketPath);
  // The point of the drop, asserted first: the tier must land on its next eligible
  // candidate. Without the filter claude-fable-6 wins the family outright (newest
  // release) and every lease on it dies at the provider.
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-ingest-fallback", profile: "auto", tier: "deep", replace: true,
  });
  assert.equal(lease.target.model.id, "claude-fable-5");
  const status = await request(socketPath, "/status");
  assert.equal(status.inventory.targets[unresolvable.id], undefined,
    "a target for a model outside the resolver view is never stored");
  assert.ok(status.inventory.targets[older.id], "the resolvable sibling is still stored");
}));

test("/inventory still stores a published target this host can resolve", async () => withBroker(async ({ socketPath }) => {
  const { older, unresolvable, body } = fableInventory();
  await request(socketPath, "/inventory", body);
  await clearStaticDeepPins(socketPath);
  const status = await request(socketPath, "/status");
  assert.ok(status.inventory.targets[unresolvable.id], "a resolvable target is admitted, not suppressed");
  assert.ok(status.inventory.targets[older.id]);
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-ingest-admitted", profile: "auto", tier: "deep", replace: true,
  });
  assert.equal(lease.target.model.id, "claude-fable-6");
}, { resolvableModels: [...DEFAULT_RESOLVABLE_MODELS, "anthropic/claude-fable-6"] }));

test("/inventory drops the catalog data of an unresolvable model with the model", async () => withBroker(async ({ socketPath }) => {
  const { body } = fableInventory();
  await request(socketPath, "/inventory", {
    ...body,
    modelContexts: { ...body.modelContexts, "anthropic/claude-fable-5": 200_000, "anthropic/claude-fable-6": 400_000 },
    modelOutputs: { "anthropic/claude-fable-5": 32_000, "anthropic/claude-fable-6": 64_000 },
    modelVariants: { "anthropic/claude-fable-5": ["high"], "anthropic/claude-fable-6": ["xhigh"] },
  });
  const status = await request(socketPath, "/status");
  assert.equal(status.inventory.modelContexts["anthropic/claude-fable-6"], undefined,
    "a window for a model that can never be leased would outlive the target that justified it");
  assert.equal(status.inventory.modelOutputs["anthropic/claude-fable-6"], undefined);
  assert.equal(status.inventory.modelVariants["anthropic/claude-fable-6"], undefined);
  assert.equal(status.inventory.modelContexts["anthropic/claude-fable-5"], 200_000);
  assert.equal(status.inventory.modelOutputs["anthropic/claude-fable-5"], 32_000);
  assert.deepEqual(status.inventory.modelVariants["anthropic/claude-fable-5"], ["high"]);
}));

test("with no resolver view on disk /inventory admits nothing and the static pins still route", async () => withBroker(async ({ socketPath }) => {
  const { body } = fableInventory();
  await request(socketPath, "/inventory", body);
  const status = await request(socketPath, "/status");
  assert.deepEqual(status.inventory.targets, {},
    "a missing snapshot means nothing is known to resolve, so nothing is admitted");
  // Fail-closed must never strand a tier: every tier keeps its configured static pins,
  // which this filter does not touch.
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-ingest-no-snapshot", profile: "auto", tier: "deep", replace: true,
  });
  // Any of the deep tier's static pins proves the tier is not stranded; which one goes
  // first is the provider rotation's business, not this test's.
  assert.ok(["claude-fable-5-1", "qwen3.8-max", "gpt-5.6-sol"].includes(lease.target.model.id), lease.target.model.id);
}, { resolvableModels: null }));

test("an ingest drop is reported, never swallowed", async () => withBroker(async ({ socketPath, stderr }) => {
  const { body } = fableInventory();
  await request(socketPath, "/inventory", body);
  await waitFor(() => /anthropic\/claude-fable-6/.test(stderr()), "the daemon to report the dropped target");
  assert.match(stderr(), /\[opencode-broker\].*inventory.*anthropic\/claude-fable-6/);
}));

// CRITICAL: THE DAEMON MUST NOT TRUST ITS OWN STATE FILE EITHER. Filtering at /inventory
// only covers what a live client publishes; broker.json is the OTHER way discovered
// inventory enters the process. A daemon poisoned before the ingest filter existed --
// or by any pane still running pre-fix plugin code -- persists those targets to disk, and
// the next restart loads them straight back into routing WITHOUT any client publishing
// anything. Measured on this host 2026-09-23: broker.json held gpt-6-astra/-luna/-sol, so
// a restart would have routed worker and deep to unresolvable models until the first
// ingest happened to land. The admission filter therefore runs at load as well.
//
// A daemon started against a broker.json that ALREADY holds discovered inventory -- i.e.
// every real restart. State is written BEFORE the process starts, so whatever the daemon
// comes up with is exactly what readState admitted, with no /inventory call involved.
const withStateFile = async (stateInventory, fn, { resolvableModels = DEFAULT_RESOLVABLE_MODELS } = {}) =>
  withTempHome(async (home) => {
    const shared = join(home, ".local/share/opencode");
    mkdirSync(shared, { recursive: true });
    const authPath = join(shared, "auth.json");
    // anthropic proves OAuth so that a reloaded claude-fable target can only be dropped by
    // the resolver view, never by admission revalidation.
    writeFileSync(authPath, JSON.stringify({ test: { type: "oauth" }, anthropic: { type: "oauth" } }));
    const contents = readFileSync(authPath);
    const stat = statSync(authPath);
    mkdirSync(join(shared, "model-routing"), { recursive: true });
    writeFileSync(join(shared, "model-routing/broker.json"), JSON.stringify({
      version: 4,
      leases: {},
      assignments: {},
      circuits: {},
      cursors: {},
      inventory: {
        providers: { anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 2 } },
        modelContexts: {},
        modelOutputs: {},
        modelVariants: {},
        ...stateInventory,
        // Matches the live auth.json, so the stored inventory is reloaded as-is rather
        // than being rebuilt by the auth-rotation path.
        authRevision: `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(contents).digest("hex")}`,
        updatedAt: Date.now(),
      },
      health: {},
      budgets: {},
      lastDecision: null,
      planUsage: {},
      rebalances: {},
    }));
    const { child, socketPath, stderr } = await startBroker(home, {}, resolvableModels);
    try {
      return await fn({ home, socketPath, stderr });
    } finally {
      await stopBroker(child);
    }
  });

test("a stored target this host cannot resolve is never routable after load", async () => {
  const older = discoveredFable("claude-fable-5", "2026-05-01");
  const unresolvable = discoveredFable("claude-fable-6", "2026-08-20");
  return withStateFile({ targets: { [older.id]: older, [unresolvable.id]: unresolvable } }, async ({ socketPath }) => {
    await clearStaticDeepPins(socketPath);
    // The point of the drop, asserted first: the tier must land on its next eligible
    // candidate. Reloaded unfiltered, claude-fable-6 wins the family outright (newest
    // release) and every deep lease dies at the provider -- with no client involved.
    const lease = await request(socketPath, "/lease", {
      sessionID: "ses-load-fallback", profile: "auto", tier: "deep", replace: true,
    });
    assert.equal(lease.target.model.id, "claude-fable-5");
    const status = await request(socketPath, "/status");
    assert.equal(status.inventory.targets[unresolvable.id], undefined,
      "a stored target outside the resolver view is dropped at load, not resurrected");
    assert.ok(status.inventory.targets[older.id], "the resolvable sibling is still reloaded");
  });
});

test("a stored target this host can resolve survives load", async () => {
  const older = discoveredFable("claude-fable-5", "2026-05-01");
  return withStateFile({ targets: { [older.id]: older } }, async ({ socketPath }) => {
    const status = await request(socketPath, "/status");
    assert.ok(status.inventory.targets[older.id], "a resolvable stored target is reloaded, not suppressed");
    await clearStaticDeepPins(socketPath);
    const lease = await request(socketPath, "/lease", {
      sessionID: "ses-load-admitted", profile: "auto", tier: "deep", replace: true,
    });
    assert.equal(lease.target.model.id, "claude-fable-5");
  });
});

test("stored catalog data for an unresolvable model is dropped at load with the model", async () => {
  const unresolvable = discoveredFable("claude-fable-6", "2026-08-20");
  const older = discoveredFable("claude-fable-5", "2026-05-01");
  return withStateFile({
    targets: { [older.id]: older, [unresolvable.id]: unresolvable },
    modelContexts: { "anthropic/claude-fable-5": 200_000, "anthropic/claude-fable-6": 400_000 },
    modelOutputs: { "anthropic/claude-fable-5": 32_000, "anthropic/claude-fable-6": 64_000 },
    modelVariants: { "anthropic/claude-fable-5": ["high"], "anthropic/claude-fable-6": ["xhigh"] },
  }, async ({ socketPath }) => {
    const status = await request(socketPath, "/status");
    assert.equal(status.inventory.modelContexts["anthropic/claude-fable-6"], undefined,
      "a reloaded window for a model that can never be leased would outlive its target");
    assert.equal(status.inventory.modelOutputs["anthropic/claude-fable-6"], undefined);
    assert.equal(status.inventory.modelVariants["anthropic/claude-fable-6"], undefined);
    assert.equal(status.inventory.modelContexts["anthropic/claude-fable-5"], 200_000);
    assert.equal(status.inventory.modelOutputs["anthropic/claude-fable-5"], 32_000);
    assert.deepEqual(status.inventory.modelVariants["anthropic/claude-fable-5"], ["high"]);
  });
});

test("with no resolver view on disk a stored inventory is not reloaded and the static pins still route", async () => {
  const older = discoveredFable("claude-fable-5", "2026-05-01");
  const unresolvable = discoveredFable("claude-fable-6", "2026-08-20");
  return withStateFile({ targets: { [older.id]: older, [unresolvable.id]: unresolvable } }, async ({ socketPath }) => {
    const status = await request(socketPath, "/status");
    // claude-fable-5 is resolvable on a normal host, so its loss here proves the MISSING
    // snapshot did it: load is fail-closed exactly like ingest.
    assert.deepEqual(status.inventory.targets, {},
      "a missing snapshot means nothing is known to resolve, so nothing is reloaded");
    const lease = await request(socketPath, "/lease", {
      sessionID: "ses-load-no-snapshot", profile: "auto", tier: "deep", replace: true,
    });
    assert.ok(["claude-fable-5-1", "qwen3.8-max", "gpt-5.6-sol"].includes(lease.target.model.id), lease.target.model.id);
  }, { resolvableModels: null });
});

test("a load-time drop is reported, never swallowed", async () => {
  const unresolvable = discoveredFable("claude-fable-6", "2026-08-20");
  return withStateFile({ targets: { [unresolvable.id]: unresolvable } }, async ({ stderr }) => {
    await waitFor(() => /anthropic\/claude-fable-6/.test(stderr()), "the daemon to report the dropped stored target");
    assert.match(stderr(), /\[opencode-broker\].*broker\.json.*anthropic\/claude-fable-6/);
  });
});

test("a clean restart reports no load-time drops", async () => {
  const older = discoveredFable("claude-fable-5", "2026-05-01");
  return withStateFile({ targets: { [older.id]: older } }, async ({ socketPath, stderr }) => {
    // Reaching /status proves the daemon finished loading, so silence here is a real
    // absence rather than a race.
    await request(socketPath, "/status");
    assert.doesNotMatch(stderr(), /dropped/,
      "a normal start has nothing to report and must stay quiet");
  });
});

// ☠️ The 2026-09-24 wedge. Clients give up after 2.5 s and retry, leaving their request queued;
// parseBody then waited on each dead socket until the 30 s handler deadline, so the chain
// drained one abandoned request per 30 s while retries refilled it and the broker went mute
// for days. An abandoned request must cost nothing when it reaches the head of the queue.
test("requests abandoned while queued are skipped, not charged the handler deadline", async () => withBroker(async ({ socketPath }) => {
  const net = await import("node:net");
  // Hold the head of the queue: headers promise a body that has not been sent yet.
  const stall = net.connect(socketPath);
  await new Promise((resolve) => stall.once("connect", resolve));
  stall.write("POST /status HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const abandonedCount = 5;
  await Promise.all(Array.from({ length: abandonedCount }, () => new Promise((resolve) => {
    const req = http.request({ socketPath, path: "/status", method: "POST", timeout: 100,
      headers: { "content-type": "application/json", "content-length": 2 } });
    req.on("timeout", () => req.destroy(new Error("broker timeout")));
    req.on("error", resolve);
    req.on("response", (res) => { res.resume(); resolve(); });
    req.end("{}");
  })));

  stall.end("{}");
  const started = Date.now();
  const status = await request(socketPath, "/status");
  assert.ok(Date.now() - started < 5000, `status took ${Date.now() - started} ms behind abandoned requests`);
  assert.equal(status.queue.abandoned, abandonedCount);
  assert.equal(status.queue.deadlineHits, 0);
  stall.destroy();
}));

test("health reports ok on a responsive broker and unhealthy when nothing answers", async () => withBroker(async ({ home }) => {
  const run = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [brokerScript, "health", "1000"], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ code, out }));
  });
  const ok = await run({ HOME: home });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /^ok: queue depth/);
  const emptyHome = mkdtempSync(join(tmpdir(), "fleet-model-broker-nobroker-"));
  try {
    const down = await run({ HOME: emptyHome });
    assert.equal(down.code, 1);
    assert.match(down.out, /^unhealthy: \/status did not answer/);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
}));
