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

const rawRequest = (socketPath, path, { method = "POST", body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const req = http.request({
    socketPath,
    path,
    method,
    headers: payload === null ? headers : {
      ...headers,
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

test("embedding leases use the shared tier set and are isolated to embedding API callers", async () => withTempHome(async (home) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/config.json", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  fixture.targets.embedding = {
    providerID: "llamacpp", modelID: "qwen3-embedding-0.6b", kind: "local", embedding: true, capacity: 8, context: 1250,
  };
  fixture.targets.chat = { providerID: "llamacpp", modelID: "qwen3.5-9b-coder", kind: "local", capacity: 1, context: 1000 };
  fixture.tiers.embedding = ["embedding"];
  fixture.profiles.embedding = ["embedding"];
  const configPath = join(home, "broker-config.json");
  writeFileSync(configPath, JSON.stringify(fixture));
  const modelsServer = await startModelsServer(["qwen3-embedding-0.6b", "qwen3.5-9b-coder"]);
  let child;
  let socketPath;
  try {
    ({ child, socketPath } = await startBroker(home, {
      OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_BROKER_LOCAL_MODELS_URL: modelsServer.url,
    }));
    await assert.rejects(request(socketPath, "/lease", {
      sessionID: "gw-embedding-chat", profile: "embedding", tier: "embedding", contextTokens: 1, replace: true,
    }), /embedding targets require api: embeddings/);
    const embedding = await request(socketPath, "/lease", {
      sessionID: "gw-embedding-ok", profile: "embedding", tier: "embedding", api: "embeddings", contextTokens: 1, replace: true,
    });
    assert.equal(embedding.target.id, "embedding");
    await assert.rejects(request(socketPath, "/lease", {
      sessionID: "gw-embedding-wrong", profile: "local", tier: "worker", api: "embeddings", contextTokens: 1, replace: true,
    }), /api: embeddings requires an embedding target/);
  } finally {
    await stopBroker(child);
    await modelsServer.stop();
  }
}));

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

test("resolvableModels narrows leases, held leases, and session pins without changing legacy callers", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const base = { profile: "auto", tier: "worker", contextTokens: 100 };

  // The host resolver admits Luna and it wins this tier. A process started before Luna
  // was added must be narrowed to the model catalog it actually loaded.
  const legacy = await request(socketPath, "/lease", {
    ...base, sessionID: "ses-resolvable-legacy", replace: true,
  });
  assert.equal(legacy.target.model.id, "gpt-5.6-luna");

  const narrowed = await request(socketPath, "/lease", {
    ...base, sessionID: "ses-resolvable-fresh", replace: true,
    resolvableModels: ["alibaba-token-plan/qwen3.8-flash"],
  });
  assert.equal(narrowed.target.model.id, "qwen3.8-flash");
  assert.deepEqual(narrowed.decision.reasons.filter((reason) => reason.startsWith("resolvable-models-filter-dropped:")), [
    "resolvable-models-filter-dropped: openai/gpt-5.6-luna, llamacpp/qwen3.5-9b-coder",
  ], "the routing trail names only models dropped from this worker lane");

  const pinned = await request(socketPath, "/lease", {
    ...base, sessionID: "ses-resolvable-pinned", replace: true,
  });
  assert.equal(pinned.target.model.id, "gpt-5.6-luna");
  await request(socketPath, "/forget", { sessionID: "ses-resolvable-pinned", leaseID: pinned.leaseID });

  const movedPin = await request(socketPath, "/lease", {
    ...base, sessionID: "ses-resolvable-pinned",
    resolvableModels: ["alibaba-token-plan/qwen3.8-flash"],
  });
  assert.equal(movedPin.target.model.id, "qwen3.8-flash", "a session pin cannot bypass the caller catalog");

  const held = await request(socketPath, "/lease", {
    ...base, sessionID: "ses-resolvable-held", replace: true,
  });
  assert.equal(held.target.model.id, "gpt-5.6-luna");
  const movedHeld = await request(socketPath, "/lease", {
    ...base, sessionID: "ses-resolvable-held",
    resolvableModels: ["alibaba-token-plan/qwen3.8-flash"],
  });
  assert.equal(movedHeld.target.model.id, "qwen3.8-flash", "a held lease cannot bypass the caller catalog");

  const replaced = await request(socketPath, "/lease", {
    ...base, sessionID: "ses-resolvable-replaced", replace: true,
  });
  assert.equal(replaced.target.model.id, "gpt-5.6-luna");
  const movedReplacement = await request(socketPath, "/lease", {
    ...base, sessionID: "ses-resolvable-replaced", replace: true,
    resolvableModels: ["alibaba-token-plan/qwen3.8-flash"],
  });
  assert.equal(movedReplacement.target.model.id, "qwen3.8-flash", "a replacement lease cannot bypass the caller catalog");
}));

test("resolvableModels refuses an unresolvable lane and rejects malformed catalogs", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const base = { sessionID: "ses-resolvable-refused", profile: "auto", tier: "worker", replace: true };
  const refused = await rawRequest(socketPath, "/lease", {
    body: { ...base, resolvableModels: ["anthropic/claude-fable-5"] },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "no-resolvable-target", JSON.stringify(refused.body));
  assert.match(refused.body.error, /cannot resolve any eligible model and must be restarted/);
  assert.match(refused.body.error, /gpt-5\.6-luna/);
  const selection = await request(socketPath, "/selection");
  assert.ok(selection.lastDecision.reasons.some((reason) => reason.includes("gpt-5.6-luna")));

  for (const resolvableModels of ["openai/gpt-5.6-luna", [42], ["openai"], [""]]) {
    const invalid = await rawRequest(socketPath, "/lease", { body: { ...base, resolvableModels } });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    assert.match(invalid.body.error, /resolvableModels/);
  }
}));

test("resolvableModels rejects catalogs over 2048 entries before reading the request body limit", async () => withBroker(async ({ socketPath }) => {
  const rejected = await rawRequest(socketPath, "/lease", {
    body: {
      sessionID: "ses-resolvable-limit", profile: "auto", tier: "worker", replace: true,
      resolvableModels: Array.from({ length: 2049 }, (_, index) => `provider/model-${index}`),
    },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /at most 2048 non-empty provider\/model strings/);
}));

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
      const classifierOne = await lease("ses-classify-1", "auto", "classifier");
      assert.equal(classifierOne.target.id, "local-classifier");
      // local-coder holds ONE of its own four, but the model carries two leases -- its
      // modelCapacity -- so the classifier's lease counts against it and the coder waits.
      await assert.rejects(lease("ses-coder-2", "local", "worker"),
        /is busy \(every slot in use\); waiting for a free slot/);
      // The classifier lane may fill the model further: the reserved slot is its to take.
      const classifierTwo = await lease("ses-classify-2", "auto", "classifier");
      assert.equal(classifierTwo.target.id, "local-classifier");
      // Releasing the classifier's leases frees the model-wide count, not just its own.
      await request(socketPath, "/forget", { sessionID: "ses-classify-1", leaseID: classifierOne.leaseID });
      await request(socketPath, "/forget", { sessionID: "ses-classify-2", leaseID: classifierTwo.leaseID });
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
    // The stop title no longer carries the provider id (the all-sessions aggregate alerts
    // were removed; a stop is per-session and now also says which provider/model it was on
    // in the body).
    assert.match(text, /Burn watch stopped a session\|Session ses_runaway was stopped because .* on anthropic\/m\.\|urgent\|stop\|/);
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

// The /usage handler accepts an optional rootSessionID: it is validated with the same rule
// as sessionID, written to usage.jsonl only when it names a DIFFERENT session (a self-root
// carries no new signal), and quietly dropped when it does not look like a session id.
test("rootSessionID on /usage is validated, logged only when different, and dropped when invalid", async () => withBroker(async ({ home, socketPath }) => {
  // A tree member reporting under a parent root -- logged.
  await request(socketPath, "/usage", {
    sessionID: "ses-child", rootSessionID: "ses-parent",
    providerID: "openai", modelID: "gpt-5.6-luna", observedAt: Date.now(), requests: 1,
    tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  });
  // A session that is its own root -- the field is not written back, so older readers of
  // usage.jsonl keep working unchanged.
  await request(socketPath, "/usage", {
    sessionID: "ses-root", rootSessionID: "ses-root",
    providerID: "openai", modelID: "gpt-5.6-luna", observedAt: Date.now(), requests: 1,
    tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  });
  // A junk root does not crash the handler and does not land in the log.
  const reply = await request(socketPath, "/usage", {
    sessionID: "ses-plain", rootSessionID: "not valid!",
    providerID: "openai", modelID: "gpt-5.6-luna", observedAt: Date.now(), requests: 1,
    tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(reply.ok, true);
  const lines = readFileSync(join(home, ".local/share/opencode/model-routing/usage.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const bySession = Object.fromEntries(lines.map((line) => [line.sessionID, line]));
  assert.equal(bySession["ses-child"].rootSessionID, "ses-parent", "a different root is written to the log");
  assert.equal(bySession["ses-root"].rootSessionID, undefined, "a self-root is not written");
  assert.equal(bySession["ses-plain"].rootSessionID, undefined, "junk is dropped silently");
}));

// Local providers cost no plan, so the burn watch must stay out of their reports. The
// usage log still records them -- the log is for tuning the local window.
test("a local-provider usage report carrying rootSessionID is excluded from the burn watch but still logged", async () => withTempHome(async (home) => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/config.json", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, ""));
  const sent = join(home, "notified.txt");
  const notifier = join(home, "notify.sh");
  writeFileSync(notifier, `#!/bin/sh\nprintf '%s|' "$@" >> "${sent}"\necho >> "${sent}"\n`);
  chmodSync(notifier, 0o755);
  fixture.burnWatch = { notifyCommand: [notifier, "{title}", "{body}", "{kind}"] };
  const configPath = join(home, "broker-config.json");
  writeFileSync(configPath, JSON.stringify(fixture));
  const { child, socketPath } = await startBroker(home, { OPENCODE_BROKER_CONFIG: configPath });
  try {
    // Eight huge re-sends on llamacpp (the fixture's local provider). The pattern is a
    // classic rewrite-signature burn: on anthropic it would stop; on llamacpp it must not.
    for (let i = 0; i < 8; i++) {
      const reply = await request(socketPath, "/usage", {
        sessionID: "ses-local-child", rootSessionID: "ses-local-parent",
        providerID: "llamacpp", modelID: "qwen3.5-9b-coder",
        observedAt: Date.now(), requests: 1,
        tokens: { input: 5, output: 400, cacheRead: 17_000, cacheWrite: 500_000 },
      });
      assert.equal(reply.burn, undefined, "local providers are never counted by the burn watch");
    }
    // Give any detached notify command time to fail to appear.
    await new Promise((r) => setTimeout(r, 100));
    let notifiedText = "";
    try { notifiedText = readFileSync(sent, "utf8"); } catch {}
    assert.equal(notifiedText, "", "nothing is notified for local traffic, whatever the shape");
    // The usage log still has the lines -- it is the record used to tune the local
    // window, so missing it would blind the operator to local load.
    const usage = readFileSync(join(home, ".local/share/opencode/model-routing/usage.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(usage.length, 8);
    for (const line of usage) {
      assert.equal(line.sessionID, "ses-local-child");
      assert.equal(line.rootSessionID, "ses-local-parent", "the root is still written to the log");
      assert.equal(line.local, true);
    }
  } finally {
    await stopBroker(child);
  }
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
  const lease = await request(socketPath, "/lease", { sessionID: "gw-caller", profile: "auto", tier: "worker", preferredModel: { providerID: "openai", id: "gpt-5.6-luna" }, replace: true, caller });
  await request(socketPath, "/usage", { sessionID: "gw-caller", leaseID: lease.leaseID, providerID: "openai", modelID: "gpt-5.6-luna", observedAt: Date.now(), requests: 1, tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, caller });
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

test("ordinary leased settlements require the exact broker-minted lease id", async () => withBroker(async ({ home, socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-exact-ordinary",
    profile: "auto",
    tier: "worker",
    replace: true,
  });

  const missing = await rawRequest(socketPath, "/release", {
    body: { sessionID: "ses-exact-ordinary" },
  });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));

  const mismatchedTarget = await rawRequest(socketPath, "/failure", {
    body: {
      sessionID: "ses-exact-ordinary",
      leaseID: lease.leaseID,
      targetID: "qwen-flash",
      error: { message: "wrong target" },
    },
  });
  assert.equal(mismatchedTarget.status, 400, JSON.stringify(mismatchedTarget.body));

  const budgetBeforeRejectedUsage = (await request(socketPath, "/status")).budgets.openai;
  const staleUsage = await rawRequest(socketPath, "/usage", {
    body: {
      sessionID: "ses-exact-ordinary",
      leaseID: "00000000-0000-4000-8000-000000000000",
      providerID: "openai",
      modelID: lease.target.model.id,
      observedAt: Date.now(),
      requests: 1,
      tokens: { input: 100, output: 50 },
    },
  });
  assert.equal(staleUsage.status, 400, JSON.stringify(staleUsage.body));
  const budgetAfterRejectedUsage = (await request(socketPath, "/status")).budgets.openai;
  assert.equal(budgetAfterRejectedUsage.utilization, budgetBeforeRejectedUsage.utilization,
    "a rejected usage report must not change utilization");
  assert.deepEqual(
    budgetAfterRejectedUsage.windows.map((window) => [window.id, window.spent]),
    budgetBeforeRejectedUsage.windows.map((window) => [window.id, window.spent]),
    "a rejected usage report must not add spend",
  );

  const validFailureBody = {
    sessionID: "ses-exact-ordinary",
    leaseID: lease.leaseID,
    targetID: lease.target.id,
    error: { statusCode: 529, message: "overloaded" },
  };
  const validFailure = await rawRequest(socketPath, "/failure", { body: validFailureBody });
  assert.equal(validFailure.status, 200, JSON.stringify(validFailure.body));
  const failedState = JSON.parse(readFileSync(join(home, ".local/share/opencode/model-routing/broker.json"), "utf8"));
  assert.deepEqual(
    failedState.assignments["ses-exact-ordinary"].settledFailure?.reply,
    validFailure.body,
    "the exact assignment retains the first failure result for idempotent replay",
  );
  const replayedFailure = await rawRequest(socketPath, "/failure", { body: validFailureBody });
  assert.deepEqual(replayedFailure, validFailure);

  const exact = await rawRequest(socketPath, "/release", {
    body: { sessionID: "ses-exact-ordinary", leaseID: lease.leaseID },
  });
  assert.equal(exact.status, 200, JSON.stringify(exact.body));
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
    leaseID: lease.leaseID,
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
    leaseID: probe.leaseID,
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
    leaseID: first.leaseID,
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
    leaseID: continued.leaseID,
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
    sessionID: "ses-overload", leaseID: lease.leaseID, targetID,
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
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-quota-indefinite", profile: "auto", tier: "worker", replace: true,
    preferredModel: { providerID: "alibaba-token-plan", id: "qwen3.8-flash" },
  });
  assert.equal(lease.target.id, "qwen-flash");
  const failure = await request(socketPath, "/failure", {
    sessionID: "ses-quota-indefinite",
    leaseID: lease.leaseID,
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
    leaseID: lease.leaseID,
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

test("fast-mode-credits fences every anthropic speed sibling, leaves non-fast anthropic alone, and reroutes fast-build", async () => withBroker(async ({ home, socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 4 },
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const before = Date.now();
  // Bound-session envelope: opencode's HTTP client wraps the gateway's 502 as
  // "Bad Gateway: " + the response text. The classifier reads the upstream 429
  // out of the message, not from statusCode (which is the gateway's own 502).
  const envelope = {
    sessionID: "ses-fast-credits",
    targetID: "claude-opus-5-fast",
    error: {
      statusCode: 502,
      message: 'Bad Gateway: {"error":{"message":"gateway: no provider could serve the request: Anthropic upstream HTTP 429: usage credits are required for fast mode","type":"upstream_error"}}',
    },
  };
  const failure = await request(socketPath, "/failure", envelope);
  assert.equal(failure.kind, "model");
  assert.ok(Number.isFinite(failure.circuitUntil), "the fast-mode circuit has a finite expiry");
  const status = await request(socketPath, "/status");
  for (const siblingID of ["claude-opus-5-fast", "claude-opus-4-8-fast"]) {
    const circuit = status.circuits[siblingID];
    assert.ok(circuit, `${siblingID} must be circuited`);
    assert.equal(circuit.kind, "model");
    assert.equal(circuit.reason, "fast-mode-credits");
    const renewsAt = Date.parse(circuit.renewsAt);
    assert.ok(Number.isFinite(renewsAt), `${siblingID} renewsAt is a date`);
    // LAPSED_HOLD_MS is 6h; allow 60s of slack for test wall-clock drift.
    assert.ok(renewsAt >= before + 6 * 3600 * 1000 - 60_000,
      `${siblingID} renewsAt within [now+6h-60s, now+6h+60s]: got ${renewsAt - before}ms`);
    assert.ok(renewsAt <= Date.now() + 6 * 3600 * 1000 + 60_000,
      `${siblingID} renewsAt within [now+6h-60s, now+6h+60s]: got ${renewsAt - before}ms`);
  }
  // Scope: the fact is account-level and model-neutral, but non-fast siblings
  // on the same provider still serve ordinary speed and must not be fenced.
  assert.equal(status.circuits["claude-opus-5"], undefined, "non-fast anthropic target stays routable");
  assert.equal(status.circuits["claude-opus-4-8"], undefined, "non-fast anthropic target stays routable");
  assert.equal(status.circuits["provider:anthropic"], undefined, "never a provider-wide circuit");
  assert.equal(status.health.providers.anthropic, undefined, "never recorded as provider health evidence");
  // The decision trail names the fenced ids, so an operator reading
  // decisions.jsonl can see which siblings this /failure actually closed on.
  const decisions = readFileSync(join(home, ".local/share/opencode/model-routing/decisions.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const fastFailure = decisions.find((line) =>
    line.sessionID === "ses-fast-credits" && line.policy === "failure-reported");
  assert.ok(fastFailure, "the /failure emitted a failure-reported decision");
  assert.ok(fastFailure.reasons.includes("fast-mode-credits"),
    `failure-reported names the reason: ${JSON.stringify(fastFailure.reasons)}`);
  const fencedReason = fastFailure.reasons.find((reason) => typeof reason === "string" && reason.startsWith("fenced:"));
  assert.ok(fencedReason, `failure-reported includes a fenced:<ids> reason: ${JSON.stringify(fastFailure.reasons)}`);
  const fencedIDs = new Set(fencedReason.slice("fenced:".length).split(","));
  assert.ok(fencedIDs.has("claude-opus-5-fast") && fencedIDs.has("claude-opus-4-8-fast"),
    `fenced ids cover both speed siblings: ${fencedReason}`);
  // A fresh fast-build lease falls to gpt-terra now that both anthropic speed
  // siblings are fenced.
  const next = await request(socketPath, "/lease", {
    sessionID: "ses-fast-credits-next", profile: "auto", tier: "fast-build", replace: true,
  });
  assert.equal(next.target.id, "gpt-terra");
}));

test("fast-mode-credits only triggers on the exact signal: an ordinary bound 502 wrap stays noop", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({
    anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 4 },
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const failure = await request(socketPath, "/failure", {
    sessionID: "ses-plain-429",
    targetID: "claude-opus-5-fast",
    error: {
      statusCode: 502,
      message: 'Bad Gateway: {"error":{"message":"gateway: no provider could serve the request: Anthropic upstream HTTP 429","type":"upstream_error"}}',
    },
  });
  assert.equal(failure.kind, "noop");
  const status = await request(socketPath, "/status");
  assert.equal(status.circuits["claude-opus-5-fast"], undefined, "noop opens no circuit");
  assert.equal(status.circuits["claude-opus-4-8-fast"], undefined);
}));

test("fast-mode-credits classifies as model on an own-lease 429 straight from the gateway", async () => withBroker(async ({ socketPath }) => {
  // Own-lease path: the gateway POSTs /failure with statusCode 429 and the
  // suffixed message, no Bad Gateway wrapper. Both fast siblings fence with
  // reason fast-mode-credits even when the hit target is the other speed
  // sibling, because the signal is account-level and provider-scoped.
  await request(socketPath, "/inventory", inventory({
    anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 4 },
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const failure = await request(socketPath, "/failure", {
    sessionID: "ses-own-lease",
    targetID: "claude-opus-4-8-fast",
    error: { statusCode: 429, message: "Anthropic upstream HTTP 429: usage credits are required for fast mode" },
  });
  assert.equal(failure.kind, "model");
  const status = await request(socketPath, "/status");
  for (const siblingID of ["claude-opus-5-fast", "claude-opus-4-8-fast"]) {
    const circuit = status.circuits[siblingID];
    assert.ok(circuit, `${siblingID} must be circuited`);
    assert.equal(circuit.kind, "model");
    assert.equal(circuit.reason, "fast-mode-credits");
  }
  assert.equal(status.circuits["provider:anthropic"], undefined, "never a provider-wide circuit");
  assert.equal(status.health.providers?.anthropic, undefined, "never recorded as provider health evidence");
}));

test("fast-mode-credits on a NON-speed target is a noop, not a target fence", async () => withBroker(async ({ socketPath }) => {
  // A client asked for fast mode on a lease that is NOT a speed variant: the
  // request is caller-side (opencode's chat path reaching the gateway with a
  // standard model id), and no anthropic target should be fenced for it.
  await request(socketPath, "/inventory", inventory({
    anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 4 },
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const failure = await request(socketPath, "/failure", {
    sessionID: "ses-nonspeed",
    targetID: "claude-opus-5",
    error: { statusCode: 429, message: "Anthropic upstream HTTP 429: usage credits are required for fast mode" },
  });
  assert.equal(failure.kind, "noop",
    "a fast-mode signal on a standard target is caller-side, not a target fault");
  assert.equal(failure.circuitUntil, undefined, "no circuit expiry on noop");
  const status = await request(socketPath, "/status");
  assert.equal(status.circuits["claude-opus-5"], undefined, "the hit target itself stays routable");
  assert.equal(status.circuits["claude-opus-5-fast"], undefined, "sibling speed targets stay routable");
  assert.equal(status.circuits["claude-opus-4-8-fast"], undefined, "sibling speed targets stay routable");
  assert.equal(status.circuits["claude-opus-4-8"], undefined, "every anthropic target stays routable");
  assert.equal(status.circuits["provider:anthropic"], undefined, "never a provider-wide circuit");
  assert.equal(status.health.providers?.anthropic, undefined, "never recorded as provider health evidence");
}));

test("fast-mode-credits circuits re-admit anthropic fast once their expiry passes, end to end", async () => withTempHome(async (home) => {
  // End to end: a /failure writes the circuits, state is rewritten to make
  // their until past, and after a restart the next lease rejoins anthropic.
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  const first = await startBroker(home);
  try {
    await request(first.socketPath, "/inventory", inventory({
      anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 4 },
      openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    }));
    const fenced = await request(first.socketPath, "/failure", {
      sessionID: "ses-fast-reopen",
      targetID: "claude-opus-5-fast",
      error: {
        statusCode: 502,
        message: 'Bad Gateway: {"error":{"message":"gateway: no provider could serve the request: Anthropic upstream HTTP 429: usage credits are required for fast mode","type":"upstream_error"}}',
      },
    });
    assert.equal(fenced.kind, "model");
    // Confirm fast-build lands on gpt-terra while the circuits are still open.
    const blocked = await request(first.socketPath, "/lease", {
      sessionID: "ses-fast-reopen-while-blocked", profile: "auto", tier: "fast-build", replace: true,
    });
    assert.equal(blocked.target.id, "gpt-terra",
      "with both fast circuits still open, fast-build picks gpt-terra");
  } finally {
    await stopBroker(first.child);
  }
  // Rewrite ONLY the `until` of the two fast-mode-credits circuits, keeping
  // every other field. Nothing else is created to recreate them because the
  // restart does not re-read the fence source -- a human bought the credits.
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  for (const siblingID of ["claude-opus-5-fast", "claude-opus-4-8-fast"]) {
    const circuit = state.circuits[siblingID];
    assert.ok(circuit, `pre-restart state carries ${siblingID} circuit`);
    assert.equal(circuit.reason, "fast-mode-credits");
    circuit.until = Date.now() - 1000;
  }
  writeFileSync(statePath, JSON.stringify(state));
  const second = await startBroker(home);
  try {
    // Re-posting inventory after restart ensures catalog targets re-publish.
    await request(second.socketPath, "/inventory", inventory({
      anthropic: { authType: "oauth", connected: true, classification: "subscription", models: 4 },
      openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    }));
    const lease = await request(second.socketPath, "/lease", {
      sessionID: "ses-fast-reopen-after-restart", profile: "auto", tier: "fast-build", replace: true,
    });
    // /lease returns a reduced `decision` (policy/reasons/registration only); the
    // full choice -- including eligibleTargetIDs -- lives on /selection.
    const selection = await request(second.socketPath, "/selection");
    const eligible = new Set(selection.lastDecision?.eligibleTargetIDs ?? []);
    const anthropicFastEligible = eligible.has("claude-opus-5-fast") || eligible.has("claude-opus-4-8-fast");
    const landedOnAnthropic = ["claude-opus-5-fast", "claude-opus-4-8-fast"].includes(lease.target?.id);
    assert.ok(anthropicFastEligible || landedOnAnthropic,
      `expired circuits re-admit anthropic fast: landed ${lease.target?.id}, eligible ${[...eligible].join(",")}`);
    const status = await request(second.socketPath, "/status");
    assert.equal(status.circuits["claude-opus-5-fast"], undefined, "expired circuit was pruned");
    assert.equal(status.circuits["claude-opus-4-8-fast"], undefined, "expired circuit was pruned");
  } finally {
    await stopBroker(second.child);
  }
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
  await request(socketPath, "/forget", { sessionID: "ses-replace", leaseID: first.leaseID });

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
    leaseID: sticky.leaseID,
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
  const first = await request(socketPath, "/lease", body);
  assert.equal(first.target.id, "claude-opus-5");
  const held = await request(socketPath, "/lease", body);
  assert.equal(held.decision.policy, "session-stickiness");
  await request(socketPath, "/failure", {
    sessionID: "ses-smart-opus",
    leaseID: held.leaseID,
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
    sessionID: "ses-circuit-gpt", leaseID: gptLease.leaseID, targetID: "gpt-luna", error: "rate limit",
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
    sessionID: "ses-circuit-qwen", leaseID: qwenLease.leaseID, targetID: "qwen-flash", error: "rate limit",
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
      providers: ["alibaba-token-plan"],
      overlayPath: join(home, "state/resolver-overlay.json"),
      generationsRoot: join(home, "state/generations"),
      currentLinkPath: join(home, "state/generations/current"),
    },
  };
  const path = join(home, "apply-config.json");
  writeFileSync(path, JSON.stringify(fixture));
  return path;
};

const createProbeGeneration = async (home) => {
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
    runResolver: async ({ configPath }) => readFileSync(configPath, "utf8").includes("gpt-6-sol")
      ? "openai/gpt-5.6-sol\nopenai/gpt-6-sol\n"
      : "openai/gpt-5.6-sol\n",
    now: () => 1_800_000_000_000,
    pid: 79,
  });
  const emptyOverlay = { version: 1, revision: 0, updatedAt: 1_800_000_000_000, entries: {} };
  const generation0 = await manager.build({
    reservedGeneration: 0,
    bootstrapGeneration0: true,
    baseConfigPath,
    overlay: emptyOverlay,
    authorizingRevisions: [],
    protectedReferences: [],
    authorizedRetirements: [],
  });
  await manager.publish(generation0);
  const generation1 = await manager.build({
    reservedGeneration: 1,
    baseConfigPath,
    overlay: {
      version: 1,
      revision: 1,
      updatedAt: 1_800_000_000_001,
      entries: {
        "openai/gpt-6-sol": {
          transitionID: "transition-openai-sol-gpt6",
          revision: "revision-2",
          authorizationKind: "auto-eligible",
          providerID: "openai",
          modelID: "gpt-6-sol",
          roleKey: "openai:gpt-sol",
          authorizationHash: "c".repeat(64),
          introductionGeneration: 1,
          model: {
            id: "gpt-6-sol",
            name: "GPT-6 Sol",
            family: "gpt-sol",
            release_date: "2026-09-22",
            tool_call: true,
            limit: { context: 400_000, output: 96_000 },
            variants: { low: {}, medium: {}, high: {} },
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
        },
      },
    },
    authorizingRevisions: ["revision-2"],
    protectedReferences: [],
    authorizedRetirements: [],
  });
  await manager.publish(generation1);
  return generation1;
};

const publishProbationCandidate = async (socketPath, configPath) => {
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
  await request(socketPath, "/inventory", published);
  return candidateID;
};

const startLiveProbationCandidate = async (home, { offerEvery = 1 } = {}) => {
  writeAuth(home);
  const generation = await createProbeGeneration(home);
  const configPath = applyConfigPath(home);
  const broker = await startBroker(home, { OPENCODE_BROKER_CONFIG: configPath },
    [...DEFAULT_RESOLVABLE_MODELS, "openai/gpt-6-sol"]);
  try {
    const registration = await rawRequest(broker.socketPath, "/resolver-process/register", {
      body: {
        generation: generation.generation,
        manifestHash: generation.manifestHash,
        modelKeys: generation.manifest.modelKeys,
      },
    });
    assert.equal(registration.status, 200, JSON.stringify(registration.body));
    const policy = brokerPolicyRequest({
      generation: generation.generation,
      manifestHash: generation.manifestHash,
      desired: {
        ...brokerPolicyRequest().desired,
        probation: {
          ...brokerPolicyRequest().desired.probation,
          phase: "probation",
          offerEvery,
        },
      },
    });
    const applied = await rawRequest(broker.socketPath, "/model-policy/cas", { body: policy });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const candidateID = await publishProbationCandidate(broker.socketPath, configPath);
    const first = await rawRequest(broker.socketPath, "/lease", {
      body: {
        sessionID: "probation-live-candidate",
        profile: "auto",
        tier: "smart",
        providers: ["openai"],
        replace: true,
        contextTokens: 0,
        resolverToken: registration.body.resolverToken,
      },
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.target.model.id, "gpt-6-sol", JSON.stringify(first.body));
    return {
      ...broker,
      candidateID,
      resolverToken: registration.body.resolverToken,
      firstLeaseID: first.body.leaseID,
    };
  } catch (error) {
    await stopBroker(broker.child);
    throw error;
  }
};

const probationRole = async (socketPath) => {
  const status = await rawRequest(socketPath, "/model-policy/status", { method: "GET" });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  return status.body.modelPolicy.roles["openai:gpt-sol"];
};

const leaseCompatibleSmartSession = (socketPath, resolverToken, sessionID, overrides = {}) => rawRequest(
  socketPath,
  "/lease",
  {
    body: {
      sessionID,
      profile: "auto",
      tier: "smart",
      providers: ["openai"],
      replace: true,
      resolverToken,
      ...overrides,
    },
  },
);

const assertOpportunityPauses = async ({
  socketPath,
  resolverToken,
  sessionPrefix,
  leaseOverrides = {},
}) => {
  const open = await probationRole(socketPath);
  assert.notEqual(open.probation.opportunityCursorAt, null, "the production candidate lease opens an opportunity window");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const firstSessionID = `${sessionPrefix}-first`;
  const firstBlocked = await leaseCompatibleSmartSession(
    socketPath,
    resolverToken,
    firstSessionID,
    leaseOverrides,
  );
  assert.equal(firstBlocked.status, 200, JSON.stringify(firstBlocked.body));
  assert.equal(firstBlocked.body.target.model.id, "gpt-5.6-sol");
  const paused = await probationRole(socketPath);
  assert.equal(paused.probation.opportunityCursorAt, null,
    "an unselectable candidate must close the opportunity window");
  const pausedMs = paused.probation.opportunityMs;
  const releasedFallback = await rawRequest(socketPath, "/release", {
    body: { sessionID: firstSessionID, leaseID: firstBlocked.body.leaseID },
  });
  assert.equal(releasedFallback.status, 200, JSON.stringify(releasedFallback.body));

  await new Promise((resolve) => setTimeout(resolve, 20));
  const stillBlocked = await leaseCompatibleSmartSession(
    socketPath,
    resolverToken,
    `${sessionPrefix}-second`,
    leaseOverrides,
  );
  assert.equal(stillBlocked.status, 200, JSON.stringify(stillBlocked.body));
  assert.equal(stillBlocked.body.target.model.id, "gpt-5.6-sol");
  const stillPaused = await probationRole(socketPath);
  assert.equal(stillPaused.probation.opportunityCursorAt, null);
  assert.equal(stillPaused.probation.opportunityMs, pausedMs,
    "blocked requests must not accrue more opportunity time");
};

const probeLaunchRequest = (generation, overrides = {}) => ({
  transitionID: "transition-openai-sol-gpt6",
  operationID: "transition-openai-sol-gpt6:staged-probing",
  expectedPolicyRevision: "revision-2",
  roleKey: "openai:gpt-sol",
  candidateIdentity: { providerID: "openai", modelID: "gpt-6-sol" },
  candidateIntroduction: { generation: generation.generation, manifestHash: generation.manifestHash },
  ...overrides,
});

const modelProbeRequest = (generation, overrides = {}) => ({
  transitionID: "transition-openai-sol-gpt6",
  roleKey: "openai:gpt-sol",
  candidateIdentity: { providerID: "openai", modelID: "gpt-6-sol" },
  candidateIntroduction: { generation: generation.generation, manifestHash: generation.manifestHash },
  probeKind: "normal",
  requestID: "probe_request_1",
  ...overrides,
});

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

test("disabled probe endpoints return 409 without parsing or mutating broker state", async () => withBroker(async ({ home, socketPath }) => {
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  const before = readFileSync(statePath);
  for (const path of [
    "/model-policy/probe-launch",
    "/model-policy/probe",
    "/probe/consume",
    "/probe/release",
  ]) {
    const response = await rawRequest(socketPath, path, { body: { malformed: true } });
    assert.equal(response.status, 409, path);
    assert.equal(response.body.code, "reconcile-apply-disabled", path);
    assert.deepEqual(readFileSync(statePath), before, path);
  }
}));

test("probe launch is mode-0600 exact-bound and redeems once for a fresh process", async () => withTempHome(async (home) => {
  writeAuth(home);
  const generation = await createProbeGeneration(home);
  const configPath = applyConfigPath(home);
  const broker = await startBroker(home, { OPENCODE_BROKER_CONFIG: configPath }, [
    ...DEFAULT_RESOLVABLE_MODELS,
    "openai/gpt-6-sol",
  ]);
  try {
    assert.equal(statSync(broker.socketPath).mode & 0o777, 0o600);
    const policy = brokerPolicyRequest({
      generation: generation.generation,
      manifestHash: generation.manifestHash,
    });
    assert.equal((await rawRequest(broker.socketPath, "/model-policy/cas", { body: policy })).status, 200);
    const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
    const beforeLaunch = readFileSync(statePath);

    for (const body of [
      probeLaunchRequest(generation, { operationID: "wrong-operation" }),
      probeLaunchRequest(generation, { expectedPolicyRevision: "revision-stale" }),
      probeLaunchRequest(generation, { candidateIdentity: { providerID: "openai", modelID: "gpt-7-sol" } }),
    ]) {
      const denied = await rawRequest(broker.socketPath, "/model-policy/probe-launch", { body });
      assert.equal(denied.status, 409, JSON.stringify(denied.body));
      assert.match(denied.body.code, /^probe-|^stale-policy-revision$/);
      assert.equal(Object.hasOwn(denied.body, "probeLaunchNonce"), false);
      assert.deepEqual(readFileSync(statePath), beforeLaunch);
    }

    const launch = await rawRequest(broker.socketPath, "/model-policy/probe-launch", {
      body: probeLaunchRequest(generation),
    });
    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    assert.match(launch.body.probeLaunchNonce, /^pln_[A-Za-z0-9_-]{43}$/);
    assert.equal(readFileSync(statePath, "utf8").includes(launch.body.probeLaunchNonce), false);
    const registrationBody = {
      generation: generation.generation,
      manifestHash: generation.manifestHash,
      probeLaunchNonce: launch.body.probeLaunchNonce,
    };
    const widened = await rawRequest(broker.socketPath, "/resolver-process/register", {
      body: { ...registrationBody, modelKeys: generation.manifest.modelKeys },
    });
    assert.equal(widened.status, 409);
    assert.equal(widened.body.code, "invalid-probe-registration");
    const settled = await Promise.all([
      rawRequest(broker.socketPath, "/resolver-process/register", { body: registrationBody }),
      rawRequest(broker.socketPath, "/resolver-process/register", { body: registrationBody }),
    ]);
    assert.equal(settled.filter((entry) => entry.status === 200).length, 1);
    assert.equal(settled.filter((entry) => entry.status === 409).length, 1);
    const registration = settled.find((entry) => entry.status === 200).body;
    assert.equal(registration.scope, "probeFresh");
    assert.equal(registration.generation, generation.generation);
    assert.equal(registration.manifestHash, generation.manifestHash);
    assert.equal(readFileSync(statePath, "utf8").includes(registration.resolverToken), false);

    const ordinary = await rawRequest(broker.socketPath, "/resolver-process/register", {
      body: {
        generation: generation.generation,
        manifestHash: generation.manifestHash,
        modelKeys: generation.manifest.modelKeys,
      },
    });
    assert.equal(ordinary.status, 200);
    const denied = await rawRequest(broker.socketPath, "/model-policy/probe", {
      headers: { "x-opencode-resolver-token": ordinary.body.resolverToken },
      body: modelProbeRequest(generation),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "probe-process-required");

    const assigned = await rawRequest(broker.socketPath, "/model-policy/probe", {
      headers: { "x-opencode-resolver-token": registration.resolverToken },
      body: modelProbeRequest(generation),
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.match(assigned.body.sessionID, /^gw-probe-[A-Za-z0-9_-]{43}$/);
    assert.match(assigned.body.probeNonce, /^pbn_[A-Za-z0-9_-]{43}$/);
    const replay = await rawRequest(broker.socketPath, "/model-policy/probe", {
      headers: { "x-opencode-resolver-token": registration.resolverToken },
      body: modelProbeRequest(generation),
    });
    assert.equal(replay.status, 409);
    assert.equal(readFileSync(statePath, "utf8").includes(assigned.body.probeNonce), false);

    const published = inventory({
      openai: { authType: "oauth", connected: true, admission: "admitted", models: 1 },
    });
    published.targets = {
      "subscription-openai-gpt-6-sol-standard": {
        id: "subscription-openai-gpt-6-sol-standard",
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
        variants: ["low", "medium", "high"],
      },
    };
    published.modelContexts = { "openai/gpt-6-sol": 400_000 };
    published.modelOutputs = { "openai/gpt-6-sol": 96_000 };
    published.modelVariants = { "openai/gpt-6-sol": ["low", "medium", "high"] };
    published.configFingerprint = createHash("sha256").update(readFileSync(configPath)).digest("hex");
    assert.equal((await rawRequest(broker.socketPath, "/inventory", { body: published })).status, 200);
    const widenedConsume = await rawRequest(broker.socketPath, "/probe/consume", {
      body: { sessionID: assigned.body.sessionID, probeNonce: assigned.body.probeNonce, extra: true },
    });
    assert.equal(widenedConsume.status, 409);
    assert.equal(widenedConsume.body.code, "invalid-probe-consume");
    const consumed = await rawRequest(broker.socketPath, "/probe/consume", {
      body: { sessionID: assigned.body.sessionID, probeNonce: assigned.body.probeNonce },
    });
    assert.equal(consumed.status, 200, JSON.stringify(consumed.body));
    assert.deepEqual(consumed.body.preferredModel, { providerID: "openai", modelID: "gpt-6-sol" });
    const lease = await rawRequest(broker.socketPath, "/lease", {
      body: {
        sessionID: assigned.body.sessionID,
        profile: "auto",
        tier: "smart",
        providers: ["openai"],
        oneShot: true,
        replace: true,
        preferredModel: { providerID: "openai", id: "gpt-6-sol" },
      },
    });
    assert.equal(lease.status, 200, JSON.stringify(lease.body));
    assert.equal(lease.body.target.model.id, "gpt-6-sol");
    const widenedRelease = await rawRequest(broker.socketPath, "/probe/release", {
      body: { sessionID: assigned.body.sessionID, probeNonce: assigned.body.probeNonce, extra: true },
    });
    assert.equal(widenedRelease.status, 409);
    assert.equal(widenedRelease.body.code, "invalid-probe-release");
    const released = await rawRequest(broker.socketPath, "/probe/release", {
      body: { sessionID: assigned.body.sessionID, probeNonce: assigned.body.probeNonce },
    });
    assert.deepEqual(released.body, { changed: true, state: "released" });
    const duplicateRelease = await rawRequest(broker.socketPath, "/probe/release", {
      body: { sessionID: assigned.body.sessionID, probeNonce: assigned.body.probeNonce },
    });
    assert.deepEqual(duplicateRelease.body, { changed: false, state: "released" });
  } finally {
    await stopBroker(broker.child);
  }
}));

test("broker restart invalidates an unredeemed probe launch nonce", async () => withTempHome(async (home) => {
  writeAuth(home);
  const generation = await createProbeGeneration(home);
  const configPath = applyConfigPath(home);
  const env = { OPENCODE_BROKER_CONFIG: configPath };
  const first = await startBroker(home, env, [...DEFAULT_RESOLVABLE_MODELS, "openai/gpt-6-sol"]);
  let nonce;
  try {
    await rawRequest(first.socketPath, "/model-policy/cas", {
      body: brokerPolicyRequest({ generation: generation.generation, manifestHash: generation.manifestHash }),
    });
    const launch = await rawRequest(first.socketPath, "/model-policy/probe-launch", {
      body: probeLaunchRequest(generation),
    });
    nonce = launch.body.probeLaunchNonce;
  } finally {
    await stopBroker(first.child);
  }
  const restarted = await startBroker(home, env, [...DEFAULT_RESOLVABLE_MODELS, "openai/gpt-6-sol"]);
  try {
    const redemption = await rawRequest(restarted.socketPath, "/resolver-process/register", {
      body: {
        generation: generation.generation,
        manifestHash: generation.manifestHash,
        probeLaunchNonce: nonce,
      },
    });
    assert.equal(redemption.status, 409);
    assert.equal(redemption.body.code, "invalid-probe-launch");
  } finally {
    await stopBroker(restarted.child);
  }
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
        body: { sessionID: "resolver-first", leaseID: lease.body.leaseID, resolverToken },
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

test("probation advances every compatible opportunity and recurs at slots 0 5 and 10 without off-offer accrual", async () => withTempHome(async (home) => {
  const broker = await startLiveProbationCandidate(home, { offerEvery: 5 });
  try {
    assert.match(broker.firstLeaseID, /^[0-9a-f-]{36}$/);
    const releasedCandidate = await rawRequest(broker.socketPath, "/release", {
      body: { sessionID: "probation-live-candidate", leaseID: broker.firstLeaseID },
    });
    assert.equal(releasedCandidate.status, 200, JSON.stringify(releasedCandidate.body));
    const initial = await probationRole(broker.socketPath);
    assert.equal(initial.probation.opportunityCursor, 1, "slot 0 consumed the first opportunity");
    const initialOpportunityMs = initial.probation.opportunityMs;
    const offeredSlots = [0];

    for (let slot = 1; slot <= 10; slot += 1) {
      const sessionID = `probation-recurring-${slot}`;
      const leased = await leaseCompatibleSmartSession(
        broker.socketPath,
        broker.resolverToken,
        sessionID,
      );
      assert.equal(leased.status, 200, JSON.stringify(leased.body));
      const candidate = leased.body.target.model.id === "gpt-6-sol";
      if (candidate) offeredSlots.push(slot);
      assert.equal(candidate, slot === 5 || slot === 10, `slot ${slot}`);

      const role = await probationRole(broker.socketPath);
      assert.equal(role.probation.opportunityCursor, slot + 1, `slot ${slot} advances the cursor`);
      if (!candidate) {
        assert.equal(role.probation.opportunityMs, initialOpportunityMs,
          `off-offer slot ${slot} must not accrue opportunity time`);
        assert.equal(role.probation.opportunityCursorAt, null,
          `off-offer slot ${slot} must not open an opportunity window`);
      }
      const released = await rawRequest(broker.socketPath, "/release", {
        body: { sessionID, leaseID: leased.body.leaseID },
      });
      assert.equal(released.status, 200, JSON.stringify(released.body));
    }
    assert.deepEqual(offeredSlots, [0, 5, 10]);
  } finally {
    await stopBroker(broker.child);
  }
}));

test("a delayed L1 failure after forget and L2 cannot settle or indict L2", async () => withTempHome(async (home) => {
  const broker = await startLiveProbationCandidate(home);
  try {
    assert.match(broker.firstLeaseID, /^[0-9a-f-]{36}$/);
    const forgotten = await rawRequest(broker.socketPath, "/forget", {
      body: {
        sessionID: "probation-live-candidate",
        leaseID: broker.firstLeaseID,
        completed: false,
      },
    });
    assert.equal(forgotten.status, 200, JSON.stringify(forgotten.body));

    const second = await leaseCompatibleSmartSession(
      broker.socketPath,
      broker.resolverToken,
      "probation-live-candidate",
    );
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.target.model.id, "gpt-6-sol");
    assert.notEqual(second.body.leaseID, broker.firstLeaseID);

    const delayed = await rawRequest(broker.socketPath, "/failure", {
      body: {
        sessionID: "probation-live-candidate",
        leaseID: broker.firstLeaseID,
        targetID: broker.candidateID,
        failureClass: "model-not-found",
        error: { statusCode: 404, code: "model_not_found", message: "delayed L1 failure" },
      },
    });
    assert.equal(delayed.status, 200, JSON.stringify(delayed.body));

    const state = JSON.parse(readFileSync(join(home, ".local/share/opencode/model-routing/broker.json"), "utf8"));
    assert.equal(state.leases["probation-live-candidate"].leaseID, second.body.leaseID,
      "the delayed report must not consume L2");
    assert.equal(state.circuits[broker.candidateID], undefined,
      "an already-abandoned L1 must not indict the candidate after L2 exists");
    const role = state.modelPolicy.roles["openai:gpt-sol"];
    assert.equal(role.probation.leases[broker.firstLeaseID].settlement.outcome, "abandoned");
    assert.equal(role.probation.leases[second.body.leaseID].settlement, null);

    const valid = await rawRequest(broker.socketPath, "/failure", {
      body: {
        sessionID: "probation-live-candidate",
        leaseID: second.body.leaseID,
        targetID: broker.candidateID,
        failureClass: "model-not-found",
        error: { statusCode: 404, code: "model_not_found", message: "current L2 failure" },
      },
    });
    assert.equal(valid.status, 200, JSON.stringify(valid.body));
    const after = await probationRole(broker.socketPath);
    assert.equal(after.probation.leases[second.body.leaseID].settlement.outcome, "failure");
  } finally {
    await stopBroker(broker.child);
  }
}));

test("a delayed candidate failure without a lease id is rejected after the session moves to the incumbent", async () => withTempHome(async (home) => {
  const broker = await startLiveProbationCandidate(home, { offerEvery: 5 });
  try {
    const released = await rawRequest(broker.socketPath, "/release", {
      body: { sessionID: "probation-live-candidate", leaseID: broker.firstLeaseID },
    });
    assert.equal(released.status, 200, JSON.stringify(released.body));

    const incumbent = await leaseCompatibleSmartSession(
      broker.socketPath,
      broker.resolverToken,
      "probation-live-candidate",
    );
    assert.equal(incumbent.status, 200, JSON.stringify(incumbent.body));
    assert.equal(incumbent.body.target.model.id, "gpt-5.6-sol");

    const delayed = await rawRequest(broker.socketPath, "/failure", {
      body: {
        sessionID: "probation-live-candidate",
        targetID: broker.candidateID,
        failureClass: "model-not-found",
        error: { statusCode: 404, code: "model_not_found", message: "delayed candidate failure" },
      },
    });
    assert.equal(delayed.status, 400, JSON.stringify(delayed.body));

    const state = JSON.parse(readFileSync(join(home, ".local/share/opencode/model-routing/broker.json"), "utf8"));
    assert.equal(state.leases["probation-live-candidate"].leaseID, incumbent.body.leaseID,
      "the unbound delayed report must not consume the incumbent lease");
    assert.equal(state.circuits[broker.candidateID], undefined,
      "the unbound delayed report must not indict the candidate");
  } finally {
    await stopBroker(broker.child);
  }
}));

test("a delayed L1 usage after release cannot settle L2 while exact valid usage and completion remain idempotent", async () => withTempHome(async (home) => {
  const broker = await startLiveProbationCandidate(home);
  try {
    const released = await rawRequest(broker.socketPath, "/release", {
      body: { sessionID: "probation-live-candidate", leaseID: broker.firstLeaseID },
    });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    const second = await leaseCompatibleSmartSession(
      broker.socketPath,
      broker.resolverToken,
      "probation-live-candidate",
    );
    assert.equal(second.status, 200, JSON.stringify(second.body));

    for (const [path, body] of [
      ["/complete", { sessionID: "probation-live-candidate" }],
      ["/failure", {
        sessionID: "probation-live-candidate",
        leaseID: "00000000-0000-4000-8000-000000000000",
        error: { message: "forged" },
      }],
      ["/usage", {
        sessionID: "probation-other-session",
        leaseID: second.body.leaseID,
        providerID: "openai",
        modelID: "gpt-6-sol",
        observedAt: Date.now(),
        requests: 1,
        tokens: { input: 1, output: 1 },
      }],
    ]) {
      const rejected = await rawRequest(broker.socketPath, path, { body });
      assert.equal(rejected.status, 400, `${path}: ${JSON.stringify(rejected.body)}`);
    }

    const delayedUsage = await rawRequest(broker.socketPath, "/usage", {
      body: {
        sessionID: "probation-live-candidate",
        leaseID: broker.firstLeaseID,
        providerID: "openai",
        modelID: "gpt-6-sol",
        observedAt: Date.now(),
        requests: 1,
        tokens: { input: 10, output: 5 },
      },
    });
    assert.equal(delayedUsage.status, 200, JSON.stringify(delayedUsage.body));
    let role = await probationRole(broker.socketPath);
    assert.equal(role.probation.leases[broker.firstLeaseID].settlement.outcome, "abandoned");
    assert.equal(role.probation.leases[second.body.leaseID].settlement, null,
      "delayed L1 usage must not count as L2 success");

    const validUsage = await rawRequest(broker.socketPath, "/usage", {
      body: {
        sessionID: "probation-live-candidate",
        leaseID: second.body.leaseID,
        providerID: "openai",
        modelID: "gpt-6-sol",
        observedAt: Date.now(),
        requests: 1,
        tokens: { input: 10, output: 5 },
      },
    });
    assert.equal(validUsage.status, 200, JSON.stringify(validUsage.body));
    const completed = await rawRequest(broker.socketPath, "/complete", {
      body: { sessionID: "probation-live-candidate", leaseID: second.body.leaseID },
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    role = await probationRole(broker.socketPath);
    assert.deepEqual(role.probation.successes, [second.body.leaseID]);
    assert.equal(role.probation.leases[second.body.leaseID].settlement.source, "usage",
      "completion after usage remains an idempotent replay");
  } finally {
    await stopBroker(broker.child);
  }
}));

test("an active candidate lease routes another request to the incumbent without accruing or opening an opportunity window", async () => withTempHome(async (home) => {
  const broker = await startLiveProbationCandidate(home);
  try {
    const legacy = await leaseCompatibleSmartSession(
      broker.socketPath,
      undefined,
      "probation-active-candidate-legacy",
    );
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(legacy.body.target.model.id, "gpt-5.6-sol");
    const before = await probationRole(broker.socketPath);
    assert.equal(before.probation.opportunityCursor, 1);
    assert.equal(before.probation.opportunityCursorAt, null);

    const incumbent = await leaseCompatibleSmartSession(
      broker.socketPath,
      broker.resolverToken,
      "probation-active-candidate-current",
    );
    assert.equal(incumbent.status, 200, JSON.stringify(incumbent.body));
    assert.equal(incumbent.body.target.model.id, "gpt-5.6-sol");
    const after = await probationRole(broker.socketPath);
    assert.equal(after.probation.opportunityCursor, 1,
      "an incumbent request blocked by an active candidate lease must not advance the opportunity cursor");
    assert.equal(after.probation.opportunityCursorAt, null,
      "an incumbent request blocked by an active candidate lease must not open an opportunity window");
    assert.equal(after.probation.opportunityMs, before.probation.opportunityMs,
      "an incumbent request blocked by an active candidate lease must not accrue opportunity time");
  } finally {
    await stopBroker(broker.child);
  }
}));

test("probation opportunity pauses while the candidate circuit is open", async () => withTempHome(async (home) => {
  const broker = await startLiveProbationCandidate(home);
  try {
    const failure = await rawRequest(broker.socketPath, "/failure", {
      body: {
        sessionID: "probation-live-candidate",
        leaseID: broker.firstLeaseID,
        targetID: broker.candidateID,
        error: { statusCode: 404, code: "model_not_found", message: "model: gpt-6-sol not found" },
      },
    });
    assert.equal(failure.status, 200, JSON.stringify(failure.body));
    assert.equal(failure.body.kind, "model");
    await assertOpportunityPauses({
      socketPath: broker.socketPath,
      resolverToken: broker.resolverToken,
      sessionPrefix: "probation-circuit-blocked",
    });
  } finally {
    await stopBroker(broker.child);
  }
}));

test("probation opportunity pauses while the candidate is at full capacity", async () => withTempHome(async (home) => {
  const broker = await startLiveProbationCandidate(home);
  try {
    const quarantined = await rawRequest(broker.socketPath, "/quarantine", {
      body: { scope: "provider", kind: "compatibility", providerID: "openai", reasonCode: "operator" },
    });
    assert.equal(quarantined.status, 200, JSON.stringify(quarantined.body));
    const probation = await rawRequest(broker.socketPath, "/rearm", {
      body: { targetID: "provider:openai", reasonCode: "operator" },
    });
    assert.equal(probation.status, 200, JSON.stringify(probation.body));
    await assertOpportunityPauses({
      socketPath: broker.socketPath,
      resolverToken: broker.resolverToken,
      sessionPrefix: "probation-capacity-blocked",
    });
  } finally {
    await stopBroker(broker.child);
  }
}));

test("probation opportunity pauses while the request exceeds the candidate context", async () => withTempHome(async (home) => {
  const broker = await startLiveProbationCandidate(home);
  try {
    await assertOpportunityPauses({
      socketPath: broker.socketPath,
      resolverToken: broker.resolverToken,
      sessionPrefix: "probation-context-blocked",
      leaseOverrides: { contextTokens: 350_000 },
    });
  } finally {
    await stopBroker(broker.child);
  }
}));

test("release settles candidate leases so more than 512 lease cycles remain available", async () => withTempHome(async (home) => {
  const broker = await startLiveProbationCandidate(home);
  try {
    const sessionIDs = ["probation-live-candidate"];
    for (let index = 1; index < 513; index += 1) {
      sessionIDs.push(`probation-release-${String(index).padStart(3, "0")}`);
    }
    for (const [index, sessionID] of sessionIDs.entries()) {
      let leaseID = broker.firstLeaseID;
      if (index > 0) {
        const lease = await leaseCompatibleSmartSession(
          broker.socketPath,
          broker.resolverToken,
          sessionID,
        );
        assert.equal(lease.status, 200, `cycle ${index + 1}: ${JSON.stringify(lease.body)}`);
        assert.equal(lease.body.target.model.id, "gpt-6-sol", `cycle ${index + 1}`);
        leaseID = lease.body.leaseID;
      }
      const released = await rawRequest(broker.socketPath, "/release", { body: { sessionID, leaseID } });
      assert.equal(released.status, 200, `cycle ${index + 1}: ${JSON.stringify(released.body)}`);
    }

    let role = await probationRole(broker.socketPath);
    const records = Object.values(role.probation.leases);
    assert.equal(records.length, 512, "settled bindings are retained only up to the idempotency cap");
    assert.equal(records.some((record) => record.sessionID === sessionIDs[0]), false,
      "the oldest settled binding is trimmed");
    const latest = records.find((record) => record.sessionID === sessionIDs.at(-1));
    assert.equal(latest.settlement.outcome, "abandoned");
    assert.equal(latest.settlement.qualifying, false);
    const firstSettlement = structuredClone(latest.settlement);

    const replay = await rawRequest(broker.socketPath, "/release", {
      body: {
        sessionID: sessionIDs.at(-1),
        leaseID: Object.entries(role.probation.leases)
          .find(([, record]) => record.sessionID === sessionIDs.at(-1))[0],
      },
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    role = await probationRole(broker.socketPath);
    const replayed = Object.values(role.probation.leases)
      .find((record) => record.sessionID === sessionIDs.at(-1));
    assert.deepEqual(replayed.settlement, firstSettlement,
      "an idempotent release replay retains the original neutral settlement");
  } finally {
    await stopBroker(broker.child);
  }
}));

test("broker lease settlements survive restart, promote once, and persist post-active rollback before replying", async () => withTempHome(async (home) => {
  writeAuth(home);
  const generation = await createProbeGeneration(home);
  const configPath = applyConfigPath(home);
  const env = { OPENCODE_BROKER_CONFIG: configPath };
  const resolvable = [...DEFAULT_RESOLVABLE_MODELS, "openai/gpt-6-sol"];
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  let broker = await startBroker(home, env, resolvable);
  try {
    const registration = await rawRequest(broker.socketPath, "/resolver-process/register", {
      body: {
        generation: generation.generation,
        manifestHash: generation.manifestHash,
        modelKeys: generation.manifest.modelKeys,
      },
    });
    const policy = brokerPolicyRequest({
      generation: generation.generation,
      manifestHash: generation.manifestHash,
      desired: {
        ...brokerPolicyRequest().desired,
        probation: {
          ...brokerPolicyRequest().desired.probation,
          phase: "probation",
          offerEvery: 1,
        },
      },
    });
    assert.equal((await rawRequest(broker.socketPath, "/model-policy/cas", { body: policy })).status, 200);
    await publishProbationCandidate(broker.socketPath, configPath);

    const forgotten = await rawRequest(broker.socketPath, "/lease", {
      body: {
        sessionID: "probation-forgotten",
        profile: "auto",
        tier: "smart",
        providers: ["openai"],
        replace: true,
        resolverToken: registration.body.resolverToken,
      },
    });
    assert.equal(forgotten.body.target.model.id, "gpt-6-sol");
    await request(broker.socketPath, "/forget", {
      sessionID: "probation-forgotten",
      leaseID: forgotten.body.leaseID,
      completed: false,
    });
    let status = await rawRequest(broker.socketPath, "/model-policy/status", { method: "GET" });
    let records = Object.values(status.body.modelPolicy.roles["openai:gpt-sol"].probation.leases);
    assert.equal(records.find((record) => record.sessionID === "probation-forgotten").settlement.outcome, "abandoned");
    assert.deepEqual(status.body.modelPolicy.roles["openai:gpt-sol"].probation.successes, []);

    const expiring = await rawRequest(broker.socketPath, "/lease", {
      body: {
        sessionID: "probation-expiring",
        profile: "auto",
        tier: "smart",
        providers: ["openai"],
        replace: true,
        resolverToken: registration.body.resolverToken,
      },
    });
    assert.equal(expiring.body.target.model.id, "gpt-6-sol");
  } finally {
    await stopBroker(broker.child);
  }

  const staleState = JSON.parse(readFileSync(statePath, "utf8"));
  staleState.leases["probation-expiring"].touchedAt = Date.now() - 3 * 60 * 60_000;
  writeFileSync(statePath, JSON.stringify(staleState) + "\n", { mode: 0o600 });
  broker = await startBroker(home, env, resolvable);
  try {
    let status = await rawRequest(broker.socketPath, "/model-policy/status", { method: "GET" });
    let role = status.body.modelPolicy.roles["openai:gpt-sol"];
    let records = Object.values(role.probation.leases);
    assert.equal(records.find((record) => record.sessionID === "probation-expiring").settlement.source, "expiry");
    assert.deepEqual(role.probation.successes, []);

    const registration = await rawRequest(broker.socketPath, "/resolver-process/register", {
      body: {
        generation: generation.generation,
        manifestHash: generation.manifestHash,
        modelKeys: generation.manifest.modelKeys,
      },
    });
    for (let index = 0; index < 5; index += 1) {
      const sessionID = `probation-success-${index}`;
      const candidate = await rawRequest(broker.socketPath, "/lease", {
        body: {
          sessionID,
          profile: "auto",
          tier: "smart",
          providers: ["openai"],
          replace: true,
          resolverToken: registration.body.resolverToken,
        },
      });
      assert.equal(candidate.body.target.model.id, "gpt-6-sol");
      if (index === 0) {
        await request(broker.socketPath, "/usage", {
          sessionID,
          leaseID: candidate.body.leaseID,
          providerID: "openai",
          modelID: "gpt-6-sol",
          observedAt: Date.now(),
          requests: 1,
          tokens: {},
        });
      }
      await request(broker.socketPath, "/complete", { sessionID, leaseID: candidate.body.leaseID });
    }
    status = await rawRequest(broker.socketPath, "/model-policy/status", { method: "GET" });
    role = status.body.modelPolicy.roles["openai:gpt-sol"];
    assert.equal(role.activeModelID, "gpt-6-sol");
    assert.equal(role.probation.phase, "active");
    assert.equal(role.probation.successes.length, 5, "usage plus complete settles one success");

    const postActiveLeases = new Map();
    for (const sessionID of ["post-active-bad-1", "post-active-bad-2"]) {
      const candidate = await rawRequest(broker.socketPath, "/lease", {
        body: {
          sessionID,
          profile: "auto",
          tier: "smart",
          providers: ["openai"],
          replace: true,
          resolverToken: registration.body.resolverToken,
        },
      });
      assert.equal(candidate.body.target.model.id, "gpt-6-sol");
      postActiveLeases.set(sessionID, candidate.body.leaseID);
    }
    await request(broker.socketPath, "/failure", {
      sessionID: "post-active-bad-1",
      leaseID: postActiveLeases.get("post-active-bad-1"),
      failureClass: "model-not-found",
      error: { message: "client closed request" },
    });
    let persisted = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(persisted.modelPolicy.roles["openai:gpt-sol"].probation.failures.length, 1,
      "the response follows the state write");
    await request(broker.socketPath, "/failure", {
      sessionID: "post-active-bad-2",
      leaseID: postActiveLeases.get("post-active-bad-2"),
      failureClass: "unsupported-model-parameter",
      error: { message: "client closed request" },
    });
    persisted = JSON.parse(readFileSync(statePath, "utf8"));
    role = persisted.modelPolicy.roles["openai:gpt-sol"];
    assert.equal(role.activeModelID, "gpt-5.6-sol");
    assert.equal(role.probation.phase, "rolled-back");
    assert.equal(role.rollbackReason, "model-failure-threshold");
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
      const lease = await request(socketPath, "/lease", {
        sessionID, profile: "auto", tier: "worker", contextTokens: 100, replace: true,
        ...(oneShot ? { oneShot: true } : {}),
      });
      await request(socketPath, endpoint, { sessionID, leaseID: lease.leaseID });
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

test("/lease/verify answers only for the exact live lease, and changes nothing", async () => withBroker(async ({ socketPath }) => {
  await request(socketPath, "/inventory", inventory({ openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 } }));
  const lease = await request(socketPath, "/lease", { sessionID: "ses-verify", profile: "auto", tier: "worker", preferredModel: { providerID: "openai", id: "gpt-5.6-luna" }, replace: true });
  const held = await request(socketPath, "/lease/verify", { sessionID: "ses-verify", leaseID: lease.leaseID });
  assert.equal(held.held, true);
  assert.equal(held.leaseID, lease.leaseID);
  assert.deepEqual(held.target.model, { providerID: lease.target.model.providerID, id: lease.target.model.id });
  assert.equal((await request(socketPath, "/lease/verify", { sessionID: "ses-verify" })).held, true);
  assert.equal((await request(socketPath, "/lease/verify", { sessionID: "ses-verify", leaseID: "00000000-0000-4000-8000-000000000000" })).held, false);
  assert.equal((await request(socketPath, "/lease/verify", { sessionID: "ses-nobody" })).held, false);
  await request(socketPath, "/forget", { sessionID: "ses-verify", leaseID: lease.leaseID });
  assert.equal((await request(socketPath, "/lease/verify", { sessionID: "ses-verify", leaseID: lease.leaseID })).held, false);
}));
