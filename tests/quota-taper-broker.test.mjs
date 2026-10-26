// Short-window taper counters through the REAL daemon (bin/opencode-broker serve): /preview is
// read-only, and only a granted new lease commits the taper counters chooseTarget proposed,
// beside the global round-robin cursor.
//
// Offline: a fresh private HOME and XDG dirs, a synthetic type-only auth.json (no tokens), a
// synthetic resolvable-models.json, plan readings seeded only through the persisted state file
// (no plan-usage source is configured, so nothing is fetched), and a closed loopback port for the
// local models URL. No provider, gateway or network traffic happens.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const brokerScript = join(repoRoot, "bin/opencode-broker");
const A_ID = "subscription-provider-a-model-a-standard";
const B_ID = "subscription-provider-b-model-b-standard";
const TAPER_A = "taper:auto:worker:cloud:provider-a";

const createFixture = () => {
  const home = mkdtempSync(join(tmpdir(), "quota-taper-broker-"));
  const dirs = Object.fromEntries(["config", "data", "state", "cache", "runtime", "routing"].map((name) => {
    const path = join(home, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return [name, path];
  }));
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true, mode: 0o700 });
  const configPath = join(dirs.config, "broker.json");
  const authPath = join(home, ".local/share/opencode/auth.json");
  const statePath = join(dirs.routing, "broker.json");
  const socketPath = join(dirs.routing, "broker.sock");
  writeFileSync(configPath, JSON.stringify({ targets: {}, tiers: { worker: [], smart: [], deep: [] }, profiles: {}, burstFence: 0.75 }), { mode: 0o600 });
  writeFileSync(authPath, JSON.stringify({ "provider-a": { type: "oauth" }, "provider-b": { type: "oauth" } }), { mode: 0o600 });
  writeFileSync(join(dirs.routing, "resolvable-models.json"),
    JSON.stringify({ updatedAt: Date.now(), models: ["provider-a/model-a", "provider-b/model-b"] }));
  // provider-a is durably leanest (10% weekly) but its 5h window is exhausted: taper weight 0.
  const planUsage = {
    "provider-a": { windows: [{ id: "5h", percent: 100 }, { id: "wk", percent: 10 }] },
    "provider-b": { windows: [{ id: "5h", percent: 0 }, { id: "wk", percent: 40 }] },
  };
  // Version 4 lets the daemon supply its own empty model policy on load.
  writeFileSync(statePath, JSON.stringify({ version: 4, leases: {}, assignments: {}, circuits: {}, cursors: {},
    health: {}, budgets: {}, lastDecision: null, planUsage }) + "\n", { mode: 0o600 });
  const env = {
    PATH: process.env.PATH, HOME: home,
    XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache, XDG_RUNTIME_DIR: dirs.runtime,
    OPENCODE_BROKER_CONFIG: configPath, OPENCODE_MODEL_ROUTING_DIR: dirs.routing,
    OPENCODE_MODEL_BROKER_SOCKET: socketPath, OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
  };
  const fx = { home, child: null };
  fx.start = async () => {
    const child = spawn(process.execPath, [brokerScript, "serve"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    fx.child = child;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening on ")) resolve(); });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
    });
  };
  fx.stop = async () => {
    const child = fx.child;
    fx.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  };
  fx.ok = (path, body = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ socketPath, path, method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(payload),
    } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`${path} HTTP ${response.statusCode}: ${text}`));
        resolve(text ? JSON.parse(text) : {});
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
  // /status sweeps and persists; the cursors are read back from the private state file.
  fx.cursors = async () => { await fx.ok("/status"); return JSON.parse(readFileSync(statePath, "utf8")).cursors; };
  fx.publish = () => {
    const contents = readFileSync(authPath);
    const stat = statSync(authPath);
    const target = (provider, model) => ({ id: `subscription-${provider}-${model}-standard`, providerID: provider, modelID: model,
      kind: "cloud", capacity: null, source: "subscription-oauth", tiers: ["worker"] });
    return fx.ok("/inventory", {
      targets: { [A_ID]: target("provider-a", "model-a"), [B_ID]: target("provider-b", "model-b") },
      providers: {
        "provider-a": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
        "provider-b": { authType: "oauth", connected: true, classification: "subscription", models: 1 },
      },
      modelContexts: { "provider-a/model-a": 200000, "provider-b/model-b": 200000 },
      authRevision: `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(contents).digest("hex")}`,
      configFingerprint: createHash("sha256").update(readFileSync(configPath)).digest("hex"),
    });
  };
  fx.cleanup = async () => { await fx.stop(); rmSync(home, { recursive: true, force: true }); };
  return fx;
};

test("preview never commits taper counters; a granted new lease commits them beside the cursor", async () => {
  const fx = createFixture();
  try {
    await fx.start();
    await fx.publish();
    const before = await fx.cursors();
    assert.deepEqual(before, {});
    for (let i = 0; i < 2; i++) {
      const preview = await fx.ok("/preview", { profile: "auto", tiers: ["worker"] });
      assert.equal(preview.preview.worker.id, B_ID, "the exhausted short window diverts the preview");
    }
    assert.deepEqual(await fx.cursors(), before, "a preview leaves every cursor untouched");

    const first = await fx.ok("/lease", { sessionID: "ses-taper-1", profile: "auto", tier: "worker", replace: true });
    assert.equal(first.target.id, B_ID);
    assert.ok(first.decision.reasons.includes("short-window-taper"));
    assert.deepEqual(await fx.cursors(), { "auto:worker:cloud": 1, [TAPER_A]: 1 },
      "the lease commits the global cursor and the rejected provider's counter");

    // A held (session-stickiness) choice proposes nothing and commits nothing.
    const held = await fx.ok("/lease", { sessionID: "ses-taper-1", profile: "auto", tier: "worker", replace: true });
    assert.equal(held.decision.policy, "session-stickiness");
    assert.deepEqual(await fx.cursors(), { "auto:worker:cloud": 1, [TAPER_A]: 1 });

    await fx.ok("/lease", { sessionID: "ses-taper-2", profile: "auto", tier: "worker", replace: true });
    assert.deepEqual(await fx.cursors(), { "auto:worker:cloud": 2, [TAPER_A]: 2 });
  } finally {
    await fx.cleanup();
  }
});
