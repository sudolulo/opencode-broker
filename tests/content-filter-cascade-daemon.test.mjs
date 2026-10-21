import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Exercises the daemon's content-filter cascade lease branch through the real /lease handler of a
// spawned broker. modelOutages is DISABLED (so no health/gateway runtime is needed) while its
// `mappings` are still defined -- the cascade reads those directly to walk older generations.
const brokerScript = join(fileURLToPath(new URL("..", import.meta.url)), "bin/opencode-broker");

const CLOUD = (providerID, modelID) => ({ providerID, modelID, kind: "cloud", context: 200000 });
const CONFIG = {
  targets: {
    "claude-opus-5-5": { id: "claude-opus-5-5", ...CLOUD("anthropic", "claude-opus-5-5"), family: "opus", speed: "standard" },
    "claude-opus-5": { id: "claude-opus-5", ...CLOUD("anthropic", "claude-opus-5"), family: "opus", speed: "standard" },
    "claude-opus-4-8": { id: "claude-opus-4-8", ...CLOUD("anthropic", "claude-opus-4-8"), family: "opus", speed: "standard" },
    "gpt-6-1-sol": { id: "gpt-6-1-sol", ...CLOUD("openai", "gpt-6.1-sol"), family: "sol", speed: "standard" },
    "gpt-flagship": { id: "gpt-flagship", ...CLOUD("openai", "gpt-6-sol"), family: "sol", speed: "standard" },
    "gpt-terra": { id: "gpt-terra", ...CLOUD("openai", "gpt-5.6-terra") },
  },
  tiers: { smart: ["claude-opus-5-5", "gpt-6-1-sol"], build: ["gpt-terra", "claude-opus-5-5"], worker: ["gpt-terra"] },
  fallbacks: {},
  slotWatch: { enabled: false },
  // Disabled, but the mappings are read by the cascade to enumerate older generations.
  modelOutages: {
    enabled: false,
    mappings: { "claude-opus-5-5": ["claude-opus-5", "claude-opus-4-8"], "gpt-6-1-sol": ["gpt-flagship"] },
  },
  contentFilterCascade: {
    enabled: true,
    tierDescent: ["smart", "build", "worker"],
    uncensoredFloorTargetID: null,
    maxAttempts: 8,
  },
};

const post = (socketPath, path, body) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = http.request({ socketPath, path, method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
  });
  req.on("error", reject);
  req.end(payload);
});

async function spawnBroker() {
  const home = mkdtempSync(join(tmpdir(), "cf-cascade-"));
  const stateDir = join(home, ".local/share/opencode/model-routing");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify(CONFIG));
  writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ anthropic: { type: "oauth" }, openai: { type: "oauth" } }));
  for (const dir of [home, join(home, ".local"), join(home, ".local/share"), join(home, ".local/share/opencode"), stateDir]) chmodSync(dir, 0o700);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  const child = spawn(process.execPath, [brokerScript, "serve"], {
    env: { ...inherited, HOME: home, OPENCODE_BROKER_CONFIG: join(home, "config.json"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
      OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening on ")) resolve(); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  };
  return { socketPath: join(stateDir, "broker.sock"), stop, stderr: () => stderr };
}

const cascade = (socketPath, sessionID, excludeTargetIDs) => post(socketPath, "/lease", {
  sessionID, profile: "auto", tier: "smart", oneShot: true,
  contentFilterCascade: true,
  blockedModel: { providerID: "anthropic", id: "claude-opus-5-5" },
  providers: ["anthropic", "openai"],
  contextTokens: 1000,
  excludeTargetIDs,
});

test("cascade leases the blocked model's first older generation (reserve, no grant, tier gate bypassed)", async () => {
  const broker = await spawnBroker();
  try {
    const res = await cascade(broker.socketPath, "gw-cf-1", ["claude-opus-5-5"]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.target.model.providerID, "anthropic");
    assert.equal(res.body.target.model.id, "claude-opus-5");
  } finally { await broker.stop(); }
});

test("cascade advances to the next older generation once the first is excluded", async () => {
  const broker = await spawnBroker();
  try {
    const res = await cascade(broker.socketPath, "gw-cf-2", ["claude-opus-5-5", "claude-opus-5"]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.target.model.id, "claude-opus-4-8");
  } finally { await broker.stop(); }
});

test("cascade descends tiers: with all of Anthropic plus gpt-6.1-sol spent it reaches gpt-terra (build/worker only, not in smart)", async () => {
  const broker = await spawnBroker();
  try {
    const res = await cascade(broker.socketPath, "gw-cf-3",
      ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "gpt-6-1-sol", "gpt-flagship"]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.target.model.id, "gpt-5.6-terra");
  } finally { await broker.stop(); }
});

test("cascade refuses with content-filter-exhausted when every candidate is spent", async () => {
  const broker = await spawnBroker();
  try {
    const res = await cascade(broker.socketPath, "gw-cf-4",
      ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "gpt-6-1-sol", "gpt-flagship", "gpt-terra"]);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(String(res.body.error ?? res.body.code ?? ""), /content-filter-exhausted|cascade candidate is unavailable/);
  } finally { await broker.stop(); }
});
