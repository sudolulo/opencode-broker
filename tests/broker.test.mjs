import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  assert.deepEqual(usage.find((line) => line.sessionID === "gw-caller").caller, caller);
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
  assert.equal(smart.target.model.variant, "high", "config-declared variants apply even when the catalog advertises none");
  await request(socketPath, "/inventory", {
    providers: { openai: { authType: "oauth", connected: true, classification: "static", models: 0 } },
    authOnly: true,
    authRevision: full.authRevision,
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
  assert.equal(lease.target.model.id, "claude-fable-5-1");
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
    assert.equal(lease.target.model.id, "claude-fable-5-1");
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
