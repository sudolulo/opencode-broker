import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const brokerScript = join(repoRoot, "bin/opencode-broker");
const routingPath = (home) => join(home, ".local/share/opencode/model-routing");

const post = (socketPath, path, body = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const request = http.request({
    socketPath,
    path,
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => {
      try {
        const parsed = JSON.parse(text);
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed);
        else reject(new Error(parsed.error ?? `broker HTTP ${response.statusCode}`));
      } catch (error) {
        reject(error);
      }
    });
  });
  request.on("error", reject);
  request.end(payload);
});

const config = (turnEffort) => ({
  targets: {
    smart: { providerID: "openai", modelID: "smart-model", kind: "cloud" },
    build: { providerID: "openai", modelID: "build-model", kind: "cloud" },
    worker: { providerID: "openai", modelID: "worker-model", kind: "cloud" },
    deep: { providerID: "openai", modelID: "deep-model", kind: "cloud", effortCeiling: "xhigh" },
  },
  tiers: { smart: ["smart"], build: ["build"], worker: ["worker"], deep: ["deep"] },
  ...(turnEffort === undefined ? {} : { turnEffort }),
});

const startBroker = async (turnEffort, { source } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-turn-effort-"));
  const configPath = join(home, "config.json");
  const serialized = source ?? JSON.stringify(config(turnEffort));
  writeFileSync(configPath, serialized);
  const routing = routingPath(home);
  mkdirSync(routing, { recursive: true });
  writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
  writeFileSync(join(routing, "resolvable-models.json"), JSON.stringify({
    updatedAt: Date.now(),
    models: ["openai/smart-model", "openai/build-model", "openai/worker-model", "openai/deep-model"],
  }));
  const child = spawn(process.execPath, [brokerScript, "serve"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening on ")) resolve(); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
  });
  const socketPath = join(routing, "broker.sock");
  const auth = readFileSync(join(home, ".local/share/opencode/auth.json"));
  const stat = statSync(join(home, ".local/share/opencode/auth.json"));
  await post(socketPath, "/inventory", {
    connected: ["openai"],
    providers: { openai: { authType: "oauth", connected: true, classification: "subscription", models: 4 } },
    modelContexts: Object.fromEntries(["smart-model", "build-model", "worker-model", "deep-model"].map((id) => [`openai/${id}`, 1000])),
    modelVariants: Object.fromEntries(["smart-model", "build-model", "worker-model", "deep-model"]
      .map((id) => [`openai/${id}`, ["low", "medium", "high", "xhigh"]])),
    authRevision: `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(auth).digest("hex")}`,
    configFingerprint: createHash("sha256").update(serialized).digest("hex"),
  });
  return { child, home, socketPath };
};

const stopBroker = async ({ child, home }) => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  rmSync(home, { recursive: true, force: true });
};

const lease = (socketPath, tier, sessionID, extra = {}) => post(socketPath, "/lease", {
  sessionID,
  profile: "auto",
  tier,
  replace: true,
  ...extra,
});

test("absent turn effort leaves tier variants unchanged and writes no rows", async () => {
  const broker = await startBroker();
  try {
    for (const [tier, expected] of Object.entries({ smart: "high", build: "high", worker: "medium", deep: "xhigh" })) {
      const before = await lease(broker.socketPath, tier, `ses-before-${tier}`);
      const withFields = await lease(broker.socketPath, tier, `ses-fields-${tier}`, {
        turnClass: { class: "hard", reason: "explicit" }, engineEffortUpdates: true,
      });
      assert.equal(before.target.model.variant, expected);
      assert.deepEqual(withFields.target.model, before.target.model, `${tier} must remain byte-identical when mode is off`);
      assert.equal("turnEffort" in withFields, false);
    }
    assert.equal(statSync(join(routingPath(broker.home), "turn-effort.jsonl"), { throwIfNoEntry: false }), undefined);
  } finally {
    await stopBroker(broker);
  }
});

test("off mode leaves tier variants unchanged with valid turn fields", async () => {
  const broker = await startBroker({ mode: "off", policy: "tier", models: ["openai/smart-model"] });
  try {
    for (const tier of ["smart", "build", "worker", "deep"]) {
      const baseline = await lease(broker.socketPath, tier, `ses-off-baseline-${tier}`);
      const withFields = await lease(broker.socketPath, tier, `ses-off-fields-${tier}`, {
        turnClass: { class: "hard", reason: "explicit", resolvedFrom: "hard" }, engineEffortUpdates: true,
      });
      assert.equal(withFields.target.model.variant, baseline.target.model.variant, `${tier} must remain unchanged in off mode`);
    }
    assert.equal(statSync(join(routingPath(broker.home), "turn-effort.jsonl"), { throwIfNoEntry: false }), undefined);
  } finally {
    await stopBroker(broker);
  }
});

test("shadow mode writes a turn effort row", async () => {
  const broker = await startBroker({ mode: "shadow", policy: "tier", models: ["openai/smart-model"] });
  try {
    await lease(broker.socketPath, "smart", "ses-shadow", {
      turnClass: { class: "hard", reason: "explicit" }, engineEffortUpdates: true,
    });
    const rows = readFileSync(join(routingPath(broker.home), "turn-effort.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mode, "shadow");
  } finally {
    await stopBroker(broker);
  }
});

test("turn effort enforces eligible leases, logs bounded rows, rotates, and preserves lease IDs in usage", async () => {
  const broker = await startBroker({ mode: "enforce", policy: "tier", models: ["openai/smart-model"] });
  try {
    const changed = await lease(broker.socketPath, "smart", "ses-enforced", {
      turnClass: { class: "hard", reason: "explicit" }, engineEffortUpdates: true,
    });
    const unchanged = await lease(broker.socketPath, "smart", "ses-incapable", {
      turnClass: { class: "hard", reason: "explicit" }, engineEffortUpdates: false,
    });
    assert.equal(changed.target.model.variant, "xhigh");
    assert.equal(unchanged.target.model.variant, "high");

    const turnLog = join(routingPath(broker.home), "turn-effort.jsonl");
    const rows = readFileSync(turnLog, "utf8").trim().split("\n").map(JSON.parse);
    const fields = ["at", "sessionID", "leaseID", "tier", "targetID", "providerID", "modelID", "mode", "class", "reason", "resolvedFrom", "engineEffortUpdates", "eligible", "base", "policies", "applied", "clamped"];
    assert.deepEqual(Object.keys(rows[0]).sort(), fields.sort());
    assert.ok(Object.values(rows[0]).every((value) => typeof value !== "string" || value.length <= 200));

    const invalid = await lease(broker.socketPath, "smart", "ses-invalid-class", {
      turnClass: { class: "x".repeat(5000), reason: "<script>", resolvedFrom: { a: 1 } }, engineEffortUpdates: true,
    });
    assert.equal(invalid.target.model.variant, "high");
    const invalidRow = readFileSync(turnLog, "utf8").trim().split("\n").map(JSON.parse).at(-1);
    assert.equal(invalidRow.class, "invalid");
    assert.equal(invalidRow.reason, "invalid");
    assert.equal(invalidRow.resolvedFrom, "invalid");
    assert.ok(Object.values(invalidRow).every((value) => typeof value !== "string" || value.length < 200));

    writeFileSync(turnLog, "x".repeat(8 * 1024 * 1024 + 1));
    await lease(broker.socketPath, "smart", "ses-rotated", {
      turnClass: { class: "hard", reason: "explicit" }, engineEffortUpdates: true,
    });
    assert.equal(readFileSync(`${turnLog}.1`, "utf8").length, 8 * 1024 * 1024 + 1);

    await post(broker.socketPath, "/usage", {
      sessionID: "ses-enforced", leaseID: changed.leaseID, providerID: "openai", modelID: "smart-model",
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, requests: 1,
    });
    const usage = JSON.parse(readFileSync(join(routingPath(broker.home), "usage.jsonl"), "utf8").trim());
    assert.equal(usage.leaseID, changed.leaseID);
  } finally {
    await stopBroker(broker);
  }
});

test("invalid turn effort config falls back to off and JSONC comments are string-aware", async () => {
  const invalid = await startBroker({ mode: "always", policy: "tier", models: [] });
  try {
    const result = await lease(invalid.socketPath, "smart", "ses-invalid", {
      turnClass: { class: "hard", reason: "explicit" }, engineEffortUpdates: true,
    });
    assert.equal(result.target.model.variant, "high");
    assert.match((await post(invalid.socketPath, "/status")).turnEffortConfigError, /turnEffort\.mode/);
  } finally {
    await stopBroker(invalid);
  }

  const source = `{
    // a line comment
    "targets": { "smart": { "providerID": "openai", "modelID": "smart-model", "kind": "cloud" }, "build": { "providerID": "openai", "modelID": "build-model", "kind": "cloud" }, "worker": { "providerID": "openai", "modelID": "worker-model", "kind": "cloud" }, "deep": { "providerID": "openai", "modelID": "deep-model", "kind": "cloud", "effortCeiling": "xhigh" } },
    "tiers": { "smart": ["smart"], "build": ["build"], "worker": ["worker"], "deep": ["deep"] },
    /* the URL proves the stripper respects strings */
    "turnEffort": { "mode": "enforce", "policy": "tier", "models": ["openai/smart-model//kept"] }
  }`;
  const comments = await startBroker(undefined, { source });
  try {
    assert.equal((await post(comments.socketPath, "/status")).turnEffortConfigError, null);
  } finally {
    await stopBroker(comments);
  }
});
