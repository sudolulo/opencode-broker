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

const startBroker = async (home, extraEnv = {}) => {
  const socketPath = join(home, ".local/share/opencode/model-routing/broker.sock");
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
  return { child, socketPath };
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

const withBroker = async (fn) => withTempHome(async (home) => {
  const authDirectory = join(home, ".local/share/opencode");
  mkdirSync(authDirectory, { recursive: true });
  writeFileSync(join(authDirectory, "auth.json"), JSON.stringify({ test: { type: "oauth" } }));
  const { child, socketPath } = await startBroker(home);
  try {
    return await fn({ home, socketPath });
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
    tiers: ["smart"],
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
  const lease = await request(socketPath, "/lease", {
    sessionID: "ses-model-newest", profile: "auto", tier: "smart", replace: true,
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
    sessionID: "ses-model-fallback", profile: "auto", tier: "smart", replace: true,
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
  assert.equal(first.target.model.id, "qwen3.8-flash");

  // Spend the session's provider hard, then release the lease the way the plugin does at idle.
  await request(socketPath, "/usage", {
    providerID: "alibaba-token-plan",
    requests: 0,
    tokens: { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
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
  assert.equal(again.target.model.id, "qwen3.8-flash");
  assert.equal((await request(socketPath, "/selection")).lastDecision.policy, "session-stickiness");

  // Balancing still happens -- when a session gets its FIRST model.
  const fresh = await request(socketPath, "/lease", {
    sessionID: "ses-fresh",
    profile: "auto",
    tier: "worker",
    replace: true,
  });
  assert.equal(fresh.target.model.id, "gpt-5.6-luna");
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
  const qwenLease = await request(socketPath, "/lease", {
    sessionID: "ses-circuit-qwen",
    profile: "auto",
    tier: "worker",
    replace: true,
  });
  assert.equal(qwenLease.target.model.id, "qwen3.8-flash");
  await request(socketPath, "/failure", {
    sessionID: "ses-circuit-qwen",
    targetID: "qwen-flash",
    error: "rate limit",
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
  // openai is now an api-key (quarantined, not a subscription) and qwen-flash is
  // circuited, so neither may serve. The request is also far larger than any declared
  // window, which used to make this reject outright; it now falls to the roomiest
  // remaining CLOUD window. The gates under test still hold -- the circuited and
  // unadmitted targets are excluded from the last-resort pass too, which is the point.
  const gated = await request(socketPath, "/lease", {
    sessionID: "ses-auth-budget",
    profile: "auto",
    tier: "worker",
    contextTokens: 100_000,
    replace: true,
  });
  assert.equal(gated.decision.policy, "context-overflow-last-resort");
  assert.notEqual(gated.target.id, "qwen-flash", "a circuited target must not be revived by the last resort");
  assert.notEqual(gated.target.model.providerID, "openai", "an unadmitted provider must not be revived by the last resort");

  await request(socketPath, "/inventory", inventory({
    openai: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    "alibaba-token-plan": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
  }));
  const gptLease = await request(socketPath, "/lease", {
    sessionID: "ses-circuit-gpt",
    profile: "auto",
    tier: "worker",
    replace: true,
  });
  assert.equal(gptLease.target.model.id, "gpt-5.6-luna");
  await request(socketPath, "/failure", {
    sessionID: "ses-circuit-gpt",
    targetID: "gpt-luna",
    error: "rate limit",
  });

  // qwen-flash and gpt-luna are both circuited now. deepseek-flash is not, so an
  // oversized request lands there under the last resort rather than refusing -- and
  // that is the assertion worth making: the circuited lanes stay excluded from the
  // last-resort pass, which only ever skips the SIZE check.
  const blocked = await request(socketPath, "/lease", {
    sessionID: "ses-circuit-blocked",
    profile: "auto",
    tier: "worker",
    contextTokens: 100_000,
    replace: true,
  });
  assert.equal(blocked.decision.policy, "context-overflow-last-resort");
  assert.equal(blocked.target.id, "deepseek-flash");
  assert.notEqual(blocked.target.id, "qwen-flash");
  assert.notEqual(blocked.target.id, "gpt-luna");
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
