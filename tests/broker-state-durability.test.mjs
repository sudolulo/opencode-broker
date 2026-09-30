import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const BROKER = new URL("../bin/opencode-broker", import.meta.url).pathname;
const FAULT_HOOK = new URL("./fixtures/broker-state-fault.cjs", import.meta.url).pathname;

const emptyState = () => ({
  version: 5,
  leases: {
    "durability-session": {
      sessionID: "durability-session",
      leaseID: "lease-durability",
      targetID: "unused-target",
      profile: "auto",
      tier: "smart",
      touchedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
  },
  assignments: {},
  circuits: {},
  cursors: {},
  inventory: {
    targets: {}, providers: {}, modelContexts: {}, modelOutputs: {}, modelVariants: {},
    authRevision: null, updatedAt: 0,
  },
  health: { version: 1, providers: {} },
  budgets: {},
  lastDecision: null,
  planUsage: {},
  rebalances: {},
  modelPolicy: { version: 1, roles: {}, history: [] },
});

const post = (socketPath, path, body) => new Promise((resolve, reject) => {
  const payload = Buffer.from(JSON.stringify(body));
  const request = httpRequest({
    socketPath,
    path,
    method: "POST",
    headers: { "content-type": "application/json", "content-length": payload.length },
  }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => resolve({
      status: response.statusCode,
      body: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  request.once("error", reject);
  request.end(payload);
});

const startBroker = async (name, fault = "") => {
  const base = mkdtempSync(join(tmpdir(), `broker-state-${name}-`));
  const home = join(base, "home");
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  const socketPath = join(base, "broker.sock");
  const tracePath = join(base, "fault-trace.jsonl");
  const armPath = join(base, "fault-armed");
  const configPath = join(base, "config.json");
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(statePath), 0o700);
  writeFileSync(statePath, `${JSON.stringify(emptyState())}\n`, { mode: 0o600 });
  writeFileSync(tracePath, "", { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ burnWatch: { enabled: false }, slotWatch: { enabled: false } }));
  const child = spawn(process.execPath, ["--require", FAULT_HOOK, BROKER, "serve"], {
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_MODEL_BROKER_SOCKET: socketPath,
      OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
      OPENCODE_BROKER_STATE_FAULT_TRACE: tracePath,
      OPENCODE_BROKER_STATE_FAULT_PATH: statePath,
      OPENCODE_BROKER_STATE_FAULT_STEP: fault,
      OPENCODE_BROKER_STATE_FAULT_ARM: armPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`broker did not listen: ${stdout}\n${stderr}`)), 3000);
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("listening on ")) return;
      clearTimeout(deadline);
      resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`broker exited before listen (${code ?? signal}): ${stderr}`)));
  });
  return {
    base,
    child,
    socketPath,
    statePath,
    stderr: () => stderr,
    trace: () => readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    resetTrace: () => {
      writeFileSync(tracePath, "", { mode: 0o600 });
      writeFileSync(armPath, "armed\n", { mode: 0o600 });
    },
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
};

test("broker state fsyncs the private 0600 temp before rename and the directory after rename", async (context) => {
  const fixture = await startBroker("ordering");
  context.after(() => fixture.close());
  fixture.resetTrace();
  const response = await post(fixture.socketPath, "/touch", { sessionID: "durability-session" });
  assert.equal(response.status, 200, response.body);
  assert.deepEqual(fixture.trace(), [
    { operation: "open", target: "temp", flags: "wx", mode: 0o600 },
    { operation: "write", target: "temp", bytes: statSync(fixture.statePath).size },
    { operation: "fsync", target: "temp" },
    { operation: "close", target: "temp" },
    { operation: "rename", target: "state" },
    { operation: "open", target: "directory", flags: "r" },
    { operation: "fsync", target: "directory" },
    { operation: "close", target: "directory" },
  ]);
  assert.equal(statSync(fixture.statePath).mode & 0o777, 0o600);
});

test("a pre-rename fsync failure preserves the live broker state and removes its temp", async (context) => {
  const fixture = await startBroker("pre-rename", "fsync-temp");
  context.after(() => fixture.close());
  fixture.resetTrace();
  const before = readFileSync(fixture.statePath);
  const response = await post(fixture.socketPath, "/touch", { sessionID: "durability-session" });
  assert.equal(response.status, 400, response.body);
  assert.deepEqual(readFileSync(fixture.statePath), before);
  assert.deepEqual(readdirSync(dirname(fixture.statePath)).filter((name) => name.endsWith(".tmp")), []);
  assert.deepEqual(fixture.trace().map(({ operation, target }) => `${operation}:${target}`), [
    "open:temp", "write:temp", "fsync:temp", "close:temp", "unlink:temp",
  ]);
});

test("a post-rename directory fsync failure keeps the commit and warns instead of reporting failure", async (context) => {
  const fixture = await startBroker("post-rename", "fsync-directory");
  context.after(() => fixture.close());
  fixture.resetTrace();
  const before = readFileSync(fixture.statePath);
  const response = await post(fixture.socketPath, "/touch", { sessionID: "durability-session" });
  assert.equal(response.status, 200, response.body);
  assert.notDeepEqual(readFileSync(fixture.statePath), before);
  assert.match(fixture.stderr(), /broker state .* was committed but its directory entry could not be made durable/);
  assert.match(fixture.stderr(), /simulated broker directory fsync failure/);
  assert.equal(existsSync(fixture.statePath), true);
  assert.equal(fixture.trace().some((event) => event.operation === "rename"), true);
  assert.equal(fixture.trace().some((event) => event.operation === "fsync" && event.target === "directory"), true);
});
