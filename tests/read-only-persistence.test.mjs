import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { compareAndSwapModelPolicy, emptyModelPolicy } from "../lib/model-policy.js";

const BROKER = new URL("../bin/opencode-broker", import.meta.url).pathname;
const STATE_TRACE_HOOK = new URL("./fixtures/broker-state-fault.cjs", import.meta.url).pathname;

const state = () => ({
  version: 5,
  leases: {}, assignments: {}, circuits: {}, cursors: {},
  inventory: { targets: {}, providers: {}, modelContexts: {}, modelOutputs: {}, modelVariants: {}, authRevision: null, updatedAt: 0 },
  health: { version: 1, providers: {} }, budgets: {}, lastDecision: null,
  planUsage: {}, rebalances: {}, modelPolicy: { version: 1, roles: {}, history: [] },
  outages: { version: 1, scopes: {}, providers: {} }, policyAvoids: {}, apiContinuations: {},
});

const post = (socketPath, path, body = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const request = httpRequest({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  request.once("error", reject);
  request.end(payload);
});

const startBroker = async (name, initial = state(), {
  failNextRename = false, failNextPreparation = false, clock = null, collideNextTemp = false, base: existingBase = null,
  config: testConfig = null, auth: testAuth = null, resolvableModels = [],
  warmPlanUsage = false, traceWrites = false,
} = {}) => {
  const base = existingBase ?? mkdtempSync(join(tmpdir(), `broker-read-only-${name}-`));
  if (!existingBase) chmodSync(base, 0o700);
  const home = join(base, "home");
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  const socketPath = join(base, "broker.sock");
  const configPath = join(base, "config.json");
  const faultArmPath = join(base, "fail-next-rename");
  const clockPath = join(base, "clock-now");
  const tracePath = join(base, "state-writes.jsonl");
  const authPath = join(home, ".local/share/opencode/auth.json");
  if (!existingBase) {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(statePath, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify({ burnWatch: { enabled: false }, slotWatch: { enabled: false }, ...testConfig }), { mode: 0o600 });
    if (testAuth) writeFileSync(authPath, JSON.stringify(testAuth), { mode: 0o600 });
    if (resolvableModels.length) {
      writeFileSync(join(dirname(statePath), "resolvable-models.json"), JSON.stringify({ updatedAt: Date.now(), models: resolvableModels }), { mode: 0o600 });
    }
  }
  const preload = [];
  if (clock !== null) {
    const clockHookPath = join(base, "controlled-clock.cjs");
    writeFileSync(clockPath, `${clock}\n`, { mode: 0o600 });
    writeFileSync(clockHookPath, [
      "const fs = require('node:fs');",
      "const clockPath = process.env.OPENCODE_BROKER_TEST_CLOCK;",
      "Date.now = () => Number(fs.readFileSync(clockPath, 'utf8').trim());",
    ].join("\n"), { mode: 0o600 });
    preload.push("--require", clockHookPath);
  }
  if (failNextRename) {
    const faultHookPath = join(base, "fail-next-rename.cjs");
    writeFileSync(faultHookPath, [
      "const fs = require('node:fs');",
      "const { syncBuiltinESMExports } = require('node:module');",
      "const armPath = process.env.OPENCODE_BROKER_TEST_FAIL_RENAME_ARM;",
      "const statePath = process.env.OPENCODE_BROKER_TEST_STATE_PATH;",
      "const renameSync = fs.renameSync;",
      "fs.renameSync = (from, to) => {",
      "  if (to === statePath && fs.existsSync(armPath)) { fs.unlinkSync(armPath); throw new Error('simulated ordinary broker rename failure'); }",
      "  return renameSync(from, to);",
      "};",
      "syncBuiltinESMExports();",
    ].join("\n"), { mode: 0o600 });
    preload.push("--require", faultHookPath);
  }
  if (failNextPreparation) {
    const faultHookPath = join(base, "fail-next-preparation.cjs");
    writeFileSync(faultHookPath, [
      "const fs = require('node:fs');",
      "const { dirname } = require('node:path');",
      "const { syncBuiltinESMExports } = require('node:module');",
      "const armPath = process.env.OPENCODE_BROKER_TEST_FAIL_PREPARATION_ARM;",
      "const stateRoot = dirname(process.env.OPENCODE_BROKER_TEST_STATE_PATH);",
      "const mkdirSync = fs.mkdirSync;",
      "fs.mkdirSync = (path, options) => {",
      "  if (path === stateRoot && fs.existsSync(armPath)) { fs.unlinkSync(armPath); throw new Error('simulated ordinary broker state preparation failure'); }",
      "  return mkdirSync(path, options);",
      "};",
      "syncBuiltinESMExports();",
    ].join("\n"), { mode: 0o600 });
    preload.push("--require", faultHookPath);
  }
  if (collideNextTemp) {
    const faultHookPath = join(base, "collide-next-temp.cjs");
    writeFileSync(faultHookPath, [
      "const fs = require('node:fs');",
      "const { syncBuiltinESMExports } = require('node:module');",
      "const armPath = process.env.OPENCODE_BROKER_TEST_COLLIDE_ARM;",
      "const openSync = fs.openSync;",
      "fs.openSync = (path, flags, mode) => {",
      "  if (flags === 'wx' && String(path).endsWith('.tmp') && fs.existsSync(armPath)) { fs.unlinkSync(armPath); fs.writeFileSync(path, 'collision sentinel', { mode: 0o600 }); }",
      "  return openSync(path, flags, mode);",
      "};",
      "syncBuiltinESMExports();",
    ].join("\n"), { mode: 0o600 });
    preload.push("--require", faultHookPath);
  }
  if (traceWrites) {
    writeFileSync(tracePath, "", { mode: 0o600 });
    preload.push("--require", STATE_TRACE_HOOK);
  }
  if (warmPlanUsage) {
    // Warm the real module cache through the configured loopback API, not a persisted seed.
    // --require runs before --import, so this fetch uses the private clock too.
    const warmPath = join(base, "warm-plan-usage.mjs");
    writeFileSync(warmPath, [
      `import { fetchPlanUsage } from ${JSON.stringify(new URL("../lib/plan-usage.js", import.meta.url).href)};`,
      "import { readFileSync } from 'node:fs';",
      "const config = JSON.parse(readFileSync(process.env.OPENCODE_BROKER_CONFIG, 'utf8'));",
      "for (const [provider, budget] of Object.entries(config.budgets)) {",
      "  if (!await fetchPlanUsage(provider, budget)) throw new Error('private usage fixture did not warm the cache');",
      "}",
    ].join("\n"), { mode: 0o600 });
    preload.push("--import", warmPath);
  }
  const child = spawn(process.execPath, [...preload, BROKER, "serve"], {
    env: {
      ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_MODEL_ROUTING_DIR: dirname(statePath),
      OPENCODE_MODEL_BROKER_SOCKET: socketPath,
      OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
       ...(failNextRename ? {
         OPENCODE_BROKER_TEST_FAIL_RENAME_ARM: faultArmPath,
         OPENCODE_BROKER_TEST_STATE_PATH: statePath,
       } : {}),
        ...(failNextPreparation ? {
         OPENCODE_BROKER_TEST_FAIL_PREPARATION_ARM: faultArmPath,
         OPENCODE_BROKER_TEST_STATE_PATH: statePath,
        } : {}),
        ...(clock !== null ? { OPENCODE_BROKER_TEST_CLOCK: clockPath } : {}),
        ...(collideNextTemp ? { OPENCODE_BROKER_TEST_COLLIDE_ARM: faultArmPath } : {}),
        ...(traceWrites ? {
          OPENCODE_BROKER_STATE_FAULT_PATH: statePath,
          OPENCODE_BROKER_STATE_FAULT_TRACE: tracePath,
          OPENCODE_BROKER_STATE_FAULT_STEP: "",
        } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await new Promise((resolve, reject) => {
      const rejectStartup = (error) => {
        clearTimeout(deadline);
        reject(error);
      };
      const deadline = setTimeout(() => rejectStartup(new Error(`broker did not listen: ${stderr}`)), 3000);
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("listening on ")) return;
      clearTimeout(deadline);
      resolve();
    });
      child.once("error", rejectStartup);
      child.once("exit", (code, signal) => rejectStartup(new Error(`broker exited before listen (${code ?? signal}): ${stderr}`)));
    });
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    if (!existingBase) rmSync(base, { recursive: true, force: true });
    throw error;
  }
  return {
    base, statePath, socketPath, authPath, stderr: () => stderr,
    armNextRenameFailure: () => writeFileSync(faultArmPath, "armed\n", { mode: 0o600 }),
    armNextPreparationFailure: () => writeFileSync(faultArmPath, "armed\n", { mode: 0o600 }),
    setClock: (now) => writeFileSync(clockPath, `${now}\n`, { mode: 0o600 }),
    armNextTempCollision: () => writeFileSync(faultArmPath, "armed\n", { mode: 0o600 }),
    writes: () => readFileSync(tracePath, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line)).filter((entry) => entry.operation === "rename" && entry.target === "state").length,
    resetTrace: () => writeFileSync(tracePath, "", { mode: 0o600 }),
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    },
    close: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
};

const fileIdentity = (path) => {
  const stat = statSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs, size: stat.size, bytes: readFileSync(path) };
};

test("stable status and selection reads do not rewrite broker state", async (context) => {
  const fixture = await startBroker("stable");
  context.after(() => fixture.close());
  const before = fileIdentity(fixture.statePath);

  for (const path of ["/status", "/selection", "/status", "/selection"]) {
    const response = await post(fixture.socketPath, path);
    assert.equal(response.status, 200, response.body);
  }

  assert.deepEqual(fileIdentity(fixture.statePath), before);
});

test("large valid model-policy histories stay read-only after normalization", async (context) => {
  let modelPolicy = emptyModelPolicy();
  for (let index = 0; index < 260; index += 1) {
    modelPolicy = compareAndSwapModelPolicy(modelPolicy, {
      transitionID: `transition-openai-sol-${index}`,
      revision: `revision-${index}`,
      roleKey: "openai:gpt-sol",
      expectedIncumbentModelID: "gpt-5.6-sol",
      generation: 4,
      manifestHash: "a".repeat(64),
      desired: {
        activeModelID: "gpt-5.6-sol",
        probationModelID: "gpt-6-sol",
        rollbackModelID: "gpt-5.6-sol",
        routingIntent: { tiers: ["smart"], fit: { smart: 1.25 }, effortCeiling: "high", requiredReasoningMode: null },
        probation: {
          phase: "staged-probing", offerEvery: 5, opportunityCursor: 0, opportunityMs: 0,
          opportunityCursorAt: null, opportunityEligibleUntil: null, successes: [], failures: [], leases: {},
        },
      },
    }, { now: () => 1_700_000_000_000 + index }).policy;
  }
  assert.ok(modelPolicy.history.length * 2 * 8 > 4096, "the valid global and role histories exceed bounded comparison capacity");

  const initial = state();
  initial.modelPolicy = modelPolicy;
  const config = {
    targets: { "gpt-flagship": { providerID: "openai", modelID: "gpt-5.6-sol", kind: "cloud" } },
    profiles: {}, tiers: {},
  };
  let fixture = await startBroker("large-model-policy-history", initial, { config, traceWrites: true });
  context.after(() => fixture.close());
  const normalized = JSON.parse(readFileSync(fixture.statePath, "utf8")).modelPolicy;
  assert.equal(normalized.history.length, 260);
  assert.equal(normalized.roles["openai:gpt-sol"].history.length, 260);
  fixture.resetTrace();
  const before = fileIdentity(fixture.statePath);

  for (const path of ["/status", "/selection"]) {
    const response = await post(fixture.socketPath, path);
    assert.equal(response.status, 200, response.body);
  }
  assert.equal(fixture.writes(), 0, "stable normalized policy must not atomically rename state");
  assert.deepEqual(fileIdentity(fixture.statePath), before);

  const base = fixture.base;
  await fixture.stop();
  fixture = await startBroker("large-model-policy-history", state(), { base, config, traceWrites: true });
  const restarted = JSON.parse(readFileSync(fixture.statePath, "utf8")).modelPolicy;
  assert.equal(restarted.history.length, 260, "restart preserves every valid global acknowledgement");
  assert.equal(restarted.roles["openai:gpt-sol"].history.length, 260, "restart preserves every valid role acknowledgement");
  fixture.resetTrace();
  const stable = fileIdentity(fixture.statePath);
  for (const path of ["/status", "/selection"]) {
    const response = await post(fixture.socketPath, path);
    assert.equal(response.status, 200, response.body);
  }
  assert.equal(fixture.writes(), 0, "restart keeps the already-normalized policy read-only");
  assert.deepEqual(fileIdentity(fixture.statePath), stable);
});

test("a status sweep persists expired policy and circuit records", async (context) => {
  const expiresAt = Date.now() + 500;
  const initial = state();
  initial.policyAvoids = { "expired-policy": { until: expiresAt, targetIDs: [], providerIDs: [] } };
  initial.circuits = { "expired-circuit": { kind: "quota", until: expiresAt } };
  const fixture = await startBroker("expired", initial);
  context.after(() => fixture.close());
  const before = fileIdentity(fixture.statePath);
  await new Promise((resolve) => setTimeout(resolve, 650));

  const response = await post(fixture.socketPath, "/status");
  assert.equal(response.status, 200, response.body);
  const after = fileIdentity(fixture.statePath);
  assert.notEqual(after.ino, before.ino, "expired sweep state must be atomically persisted");
  const persisted = JSON.parse(after.bytes);
  assert.deepEqual(persisted.policyAvoids, {});
  assert.deepEqual(persisted.circuits, {});
});

test("a nonwriting headroom sweep leaves expired policy and circuit pruning pending for selection", async (context) => {
  const expiresAt = Date.now() + 500;
  const initial = state();
  initial.policyAvoids = { "expired-policy": { until: expiresAt, targetIDs: [], providerIDs: [] } };
  initial.circuits = { "expired-circuit": { kind: "quota", until: expiresAt } };
  const fixture = await startBroker("nonwriting-sweep", initial);
  context.after(() => fixture.close());
  const before = fileIdentity(fixture.statePath);
  await new Promise((resolve) => setTimeout(resolve, 650));

  const headroom = await post(fixture.socketPath, "/headroom");
  assert.equal(headroom.status, 200, headroom.body);
  assert.deepEqual(fileIdentity(fixture.statePath), before, "headroom remains a stable read");

  const selection = await post(fixture.socketPath, "/selection");
  assert.equal(selection.status, 200, selection.body);
  const persisted = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.deepEqual(persisted.policyAvoids, {});
  assert.deepEqual(persisted.circuits, {});
});

test("a read retries an ordinary failed sweep write after its in-memory mutation", async (context) => {
  const expiresAt = Date.now() + 2_000;
  const initial = state();
  initial.circuits = { "expired-circuit": { kind: "quota", until: expiresAt } };
  const fixture = await startBroker("retry-after-write-failure", initial, { failNextRename: true });
  context.after(() => fixture.close());
  await new Promise((resolve) => setTimeout(resolve, 2_150));
  fixture.armNextRenameFailure();

  const failed = await post(fixture.socketPath, "/status");
  assert.equal(failed.status, 400, failed.body);
  assert.match(failed.body, /simulated ordinary broker rename failure/);
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")).circuits, initial.circuits, "the failed rename must leave the old file authoritative");

  const retried = await post(fixture.socketPath, "/selection");
  assert.equal(retried.status, 200, retried.body);
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")).circuits, {});
});

test("a read retries a failed pre-open sweep write after its in-memory mutation", async (context) => {
  const expiresAt = Date.now() + 2_000;
  const initial = state();
  initial.circuits = { "expired-circuit": { kind: "quota", until: expiresAt } };
  const fixture = await startBroker("retry-after-preparation-failure", initial, { failNextPreparation: true });
  context.after(() => fixture.close());
  await new Promise((resolve) => setTimeout(resolve, 2_150));
  fixture.armNextPreparationFailure();

  const failed = await post(fixture.socketPath, "/status");
  assert.equal(failed.status, 400, failed.body);
  assert.match(failed.body, /simulated ordinary broker state preparation failure/);
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")).circuits, initial.circuits, "the pre-open failure must leave the old file authoritative");

  const retried = await post(fixture.socketPath, "/selection");
  assert.equal(retried.status, 200, retried.body);
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")).circuits, {});
});

test("restart retains sweep pruning and read normalization without another stable-read write", async (context) => {
  const initial = state();
  initial.leases = {
    "expired-lease": { sessionID: "expired-lease", leaseID: "old", targetID: "missing", profile: "auto", tier: "smart", touchedAt: 0 },
  };
  initial.assignments = {
    "expired-assignment": { sessionID: "expired-assignment", targetID: "missing", updatedAt: 0 },
  };
  initial.rebalances = { "expired-rebalance": 0 };
  initial.health = { version: 99, providers: "invalid" };
  initial.apiContinuations = { "expired-continuation": {} };
  let fixture = await startBroker("restart-pruning", initial);
  context.after(() => fixture.close());

  const firstImage = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.deepEqual(firstImage.leases, {});
  assert.deepEqual(firstImage.assignments, {});
  assert.deepEqual(firstImage.rebalances, {});
  assert.deepEqual(firstImage.health.providers, {});
  assert.deepEqual(firstImage.apiContinuations, {});

  const base = fixture.base;
  await fixture.stop();
  fixture = await startBroker("restart-pruning", state(), { base });
  const before = fileIdentity(fixture.statePath);
  const response = await post(fixture.socketPath, "/status");
  assert.equal(response.status, 200, response.body);
  assert.deepEqual(fileIdentity(fixture.statePath), before);
});

const assertReadPrunesOnceAndSurvivesRestart = async (context, name, initial, now, advance, assertPruned) => {
  let fixture = await startBroker(name, initial, { clock: now });
  context.after(() => fixture.close());
  const before = fileIdentity(fixture.statePath);
  fixture.setClock(advance);

  const first = await post(fixture.socketPath, "/status");
  assert.equal(first.status, 200, first.body);
  assert.notEqual(fileIdentity(fixture.statePath).ino, before.ino, "the read-time sweep must persist its mutation");
  assertPruned(JSON.parse(readFileSync(fixture.statePath, "utf8")));

  const stable = fileIdentity(fixture.statePath);
  const second = await post(fixture.socketPath, "/selection");
  assert.equal(second.status, 200, second.body);
  assert.deepEqual(fileIdentity(fixture.statePath), stable, "a stable follow-up read must not rewrite");

  const base = fixture.base;
  await fixture.stop();
  fixture = await startBroker(name, state(), { clock: advance, base });
  assertPruned(JSON.parse(readFileSync(fixture.statePath, "utf8")));
};

test("a read-time sweep persists an expired live lease", async (context) => {
  const now = 1_700_000_000_000;
  const initial = state();
  initial.leases.expired = { sessionID: "expired", leaseID: "old", targetID: "missing", profile: "auto", tier: "smart", touchedAt: now };
  await assertReadPrunesOnceAndSurvivesRestart(context, "read-expired-lease", initial, now, now + 3 * 60 * 60_000,
    (persisted) => assert.deepEqual(persisted.leases, {}));
});

test("a read-time sweep persists an idle assignment", async (context) => {
  const now = 1_700_000_000_000;
  const initial = state();
  initial.assignments.idle = { sessionID: "idle", targetID: "missing", updatedAt: now };
  await assertReadPrunesOnceAndSurvivesRestart(context, "read-idle-assignment", initial, now, now + 24 * 60 * 60_000,
    (persisted) => assert.deepEqual(persisted.assignments, {}));
});

test("a read-time sweep persists an expired rebalance cooldown", async (context) => {
  const now = 1_700_000_000_000;
  const initial = state();
  initial.rebalances = { cooled: now };
  await assertReadPrunesOnceAndSurvivesRestart(context, "read-expired-rebalance", initial, now, now + 24 * 60 * 60_000,
    (persisted) => assert.deepEqual(persisted.rebalances, {}));
});

test("a read-time sweep persists health evidence pruning", async (context) => {
  const now = 1_700_000_000_000;
  const initial = state();
  initial.health = { providers: { fixture: { state: "observing", source: "automatic", firstAt: now, lastAt: now,
    evidence: [{ targetID: "target", modelID: "model", sessionID: "session", at: now }] } } };
  await assertReadPrunesOnceAndSurvivesRestart(context, "read-health-pruning", initial, now, now + 60 * 60_000,
    (persisted) => assert.deepEqual(persisted.health.providers, {}));
});

test("an EEXIST temp collision preserves the foreign sentinel and retries on the next write", async (context) => {
  const initial = state();
  initial.leases.touchable = { sessionID: "touchable", leaseID: "lease", targetID: "missing", profile: "auto", tier: "smart", touchedAt: Date.now() };
  const fixture = await startBroker("temp-collision", initial, { collideNextTemp: true });
  context.after(() => fixture.close());
  const old = readFileSync(fixture.statePath);
  fixture.armNextTempCollision();

  const failed = await post(fixture.socketPath, "/touch", { sessionID: "touchable", leaseID: "lease" });
  assert.equal(failed.status, 400, failed.body);
  assert.match(failed.body, /EEXIST/, "the armed collision must be the observed failure");
  assert.deepEqual(readFileSync(fixture.statePath), old, "the old state remains authoritative");
  const sentinels = readdirSync(dirname(fixture.statePath)).filter((name) => name.endsWith(".tmp"));
  assert.equal(sentinels.length, 1);
  const sentinel = join(dirname(fixture.statePath), sentinels[0]);
  assert.equal(readFileSync(sentinel, "utf8"), "collision sentinel");

  const retried = await post(fixture.socketPath, "/touch", { sessionID: "touchable", leaseID: "lease" });
  assert.equal(retried.status, 200, retried.body);
  assert.equal(readFileSync(sentinel, "utf8"), "collision sentinel", "retry must not remove another writer's temp");
  rmSync(sentinel, { force: true });
  assert.equal(existsSync(sentinel), false);
});

const privateAuthRevision = (authPath) => {
  const contents = readFileSync(authPath);
  const stat = statSync(authPath);
  return `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(contents).digest("hex")}`;
};

const CAP_CONFIG = {
  targets: { fixture: { providerID: "fixture", modelID: "fixture-model", kind: "cloud" } },
  profiles: { auto: ["fixture"] },
  tiers: { smart: ["fixture"], worker: ["fixture"] },
};

// The only credential here belongs to the loopback fixture; no provider or real auth is used.
const PLAN_AUTH = { fixture: { type: "oauth" }, "fixture-usage": { type: "api", key: "private-fixture-only" } };
const planConfig = (url) => ({
  ...CAP_CONFIG,
  budgets: { fixture: {
    windows: [{ id: "wk", periodMs: 604800000, meter: "requests", capacity: 100 }],
    planUsage: { type: "http", url, authRef: "fixture-usage" },
  } },
});

const startUsageFixture = async (context, report) => {
  let calls = 0;
  let available = true;
  const server = createServer((request, response) => {
    calls += 1;
    assert.equal(request.url, "/usage");
    assert.equal(request.headers["x-api-key"], "private-fixture-only");
    response.writeHead(available ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(available ? report : { error: "private usage fixture unavailable" }));
  });
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/usage`,
    calls: () => calls,
    disable: () => { available = false; },
  };
};

test("a cached lapsed report extends its durable hold without refetch or another transition, including a failed write retry", async (context) => {
  const now = 1_700_000_000_000;
  const oldUntil = now + 6 * 60 * 60_000;
  const extendedAt = now + 1000;
  const extendedUntil = oldUntil + 1000;
  const usage = await startUsageFixture(context, {
    plan: "free", windows: [{ percent: 0, resetsAt: null, durationSeconds: 604800 }],
  });
  let fixture = await startBroker("cached-lapsed", state(), {
    clock: now, config: planConfig(usage.url), auth: PLAN_AUTH,
    warmPlanUsage: true, traceWrites: true, failNextRename: true,
  });
  context.after(() => fixture.close());
  const startup = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.equal(usage.calls(), 1, "the real cache was fetched once before startup");
  assert.equal(startup.planUsage.fixture.fetchedAt, now);
  assert.deepEqual(startup.circuits, {}, "startup did not apply the lapsed report");
  const first = await post(fixture.socketPath, "/status");
  assert.equal(first.status, 200, first.body);
  const before = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.deepEqual(before.circuits["provider:fixture"], {
    kind: "quota", reason: "plan-lapsed", until: oldUntil, updatedAt: now,
  }, "the initial hold is valid and durable after startup, before the clock advance");
  assert.deepEqual(before.planUsage, startup.planUsage);

  fixture.setClock(extendedAt);
  assert.ok(extendedAt - before.planUsage.fixture.fetchedAt < 60_000, "the report is inside its success cache TTL");
  fixture.resetTrace();
  fixture.armNextRenameFailure();
  const failed = await post(fixture.socketPath, "/status");
  assert.equal(failed.status, 400, failed.body);
  assert.match(failed.body, /simulated ordinary broker rename failure/);
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")), before, "the failed extension leaves the old persisted hold authoritative");
  // Same clock and same report: the second apply is byte-for-byte unchanged. Only the
  // failed write's retained intent can cause this selection read to persist the extension.
  const retried = await post(fixture.socketPath, "/selection");
  assert.equal(retried.status, 200, retried.body);
  const after = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.deepEqual(after.circuits["provider:fixture"], {
    kind: "quota", reason: "plan-lapsed", until: extendedUntil, updatedAt: extendedAt,
  });
  assert.deepEqual({ ...after, circuits: before.circuits }, before, "neither fetchedAt/snapshot nor any other state mutator can mask the circuit-only change");
  assert.equal(usage.calls(), 1, "both post-startup reads reuse the unchanged report");
  const transitions = JSON.parse((await post(fixture.socketPath, "/decisions")).body).decisions
    .filter((entry) => entry.policy.startsWith("provider-check-"));
  assert.deepEqual(transitions.map((entry) => entry.policy), ["provider-check-lapsed"]);
  fixture.resetTrace();
  assert.equal((await post(fixture.socketPath, "/status")).status, 200);
  assert.equal(fixture.writes(), 0, "the stable cached lapsed report must not write again");

  const base = fixture.base;
  await fixture.stop();
  assert.equal((fixture.stderr().match(/fixture plan lapsed:/g) ?? []).length, 1, "only the initial lapse emits an alert; extensions and retries never spam");
  usage.disable();
  const restartedAt = oldUntil + 1;
  assert.ok(restartedAt > oldUntil && restartedAt < extendedUntil);
  fixture = await startBroker("cached-lapsed", state(), { base, clock: restartedAt, traceWrites: true });
  const restarted = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.deepEqual(restarted.circuits, after.circuits, "restart after the OLD expiry must retain the extended block");
  assert.deepEqual(restarted.planUsage, before.planUsage);
  const refused = await post(fixture.socketPath, "/lease", { sessionID: "must-stay-blocked", profile: "auto", tier: "smart" });
  assert.equal(refused.status, 400, refused.body);
  assert.equal(JSON.parse(refused.body).code, "usage-limit", "the persisted hold, not an unrelated admission failure, refuses the provider");
  assert.equal(usage.calls(), 2, "restart attempted the unavailable usage API rather than obtaining a new report");
  const finalImage = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.deepEqual(finalImage.circuits, after.circuits);
  assert.deepEqual(finalImage.planUsage, before.planUsage);
  assert.deepEqual(finalImage.leases, {});
});

test("one status read atomically persists both an expired sweep record and a cached future plan lockout, then writes nothing", async (context) => {
  const now = 1_700_000_000_000;
  const triggeredAt = now + 20_000;
  const lockedUntil = now + 600_000;
  const usage = await startUsageFixture(context, {
    plan: "pro", windows: [{ percent: 100, resetsAt: lockedUntil / 1000, durationSeconds: 604800 }],
  });
  const initial = state();
  initial.circuits = {
    expired: { kind: "quota", until: now + 10_000 },
    // Extending an exact quota circuit retains its kind. Once extended, the cached
    // report is a true no-op instead of rebuilding a plan-window object each time.
    "provider:fixture": { kind: "quota", resetKnown: true, until: now + 300_000, updatedAt: now },
  };
  const fixture = await startBroker("cached-plan-and-sweep", initial, {
    clock: now, config: planConfig(usage.url), auth: PLAN_AUTH, warmPlanUsage: true, traceWrites: true,
  });
  context.after(() => fixture.close());
  const startup = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.deepEqual(startup.circuits, initial.circuits, "both records survive startup; neither tested mutation happened yet");
  assert.equal(startup.planUsage.fixture.fetchedAt, now);
  assert.equal(startup.planUsage.fixture.lockedUntil, lockedUntil);
  assert.equal(usage.calls(), 1);
  fixture.setClock(triggeredAt);
  assert.ok(triggeredAt - startup.planUsage.fixture.fetchedAt < 60_000);
  fixture.resetTrace();

  const first = await post(fixture.socketPath, "/status");
  assert.equal(first.status, 200, first.body);
  const after = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.deepEqual(after.circuits, {
    "provider:fixture": { kind: "quota", resetKnown: true, until: lockedUntil, updatedAt: triggeredAt },
  }, "the same request prunes the expired record and extends the provider hold");
  assert.deepEqual({ ...after, circuits: startup.circuits }, startup, "the snapshot and all other state are unchanged");
  assert.equal(fixture.writes(), 1, "count actual atomic renames: a refresh write plus a second sweep write would be two");
  fixture.resetTrace();
  for (const path of ["/selection", "/status"]) {
    const stable = await post(fixture.socketPath, path);
    assert.equal(stable.status, 200, stable.body);
  }
  assert.equal(fixture.writes(), 0, "stable follow-up reads must perform zero atomic writes");
  assert.equal(usage.calls(), 1, "no new fetch or fetchedAt change supplies a second mutation");
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")), after);
});

test("a deferred provider-check mutation records persistence intent without weakening a strict pending write", () => {
  const base = mkdtempSync(join(tmpdir(), "broker-read-only-check-intent-"));
  const source = readFileSync(BROKER, "utf8");
  const mainAt = source.lastIndexOf("\nmain().catch(");
  assert.ok(mainAt > 0, "private entrypoint must omit only the CLI invocation");
  const entrypoint = join(base, "check-intent.mjs");
  const configPath = join(base, "config.json");
  try {
    writeFileSync(configPath, JSON.stringify({ burnWatch: { enabled: false }, slotWatch: { enabled: false } }), { mode: 0o600 });
    // Private copy, real functions: expose the nonpersisting producer/consumer boundary
    // without adding production exports or rolling the production checkout backward.
    writeFileSync(entrypoint, source.slice(0, mainAt).replace(/from "(\.\.\/[^"]+)"/g,
      (_match, path) => `from ${JSON.stringify(new URL(path, new URL("../bin/opencode-broker", import.meta.url)).href)}`) + `
import assert from "node:assert/strict";
let now = 1700000001000;
Date.now = () => now;
const image = ${JSON.stringify(state())};
image.circuits["provider:fixture"] = { kind: "quota", reason: "plan-lapsed", until: 1700021600000, updatedAt: now - 1000 };
assert.equal(applyCheckResult(image, "fixture", { entitlement: "lapsed" }, { persist: false }), true);
assert.equal(pendingPersistence(image), 1, "a deferred provider-check mutation must publish ordinary persistence intent");
writeState(image);
assert.equal(pendingPersistence(image), 0);
assert.equal(JSON.parse(readFileSync(STATE_PATH, "utf8")).circuits["provider:fixture"].until, 1700021601000);
notePendingPersistence(image, true);
now += 1000;
assert.equal(applyCheckResult(image, "fixture", { entitlement: "lapsed" }, { persist: false }), true);
assert.equal(pendingPersistence(image), 2, "ordinary provider mutation never downgrades strict intent");
writeState(image);
assert.equal(pendingPersistence(image), 2, "ordinary success does not acknowledge a strict pending write");
writeState(image, { requireDurable: true });
assert.equal(pendingPersistence(image), 0);
assert.equal(applyCheckResult(image, "fixture", { entitlement: "lapsed" }, { persist: false }), false);
assert.equal(pendingPersistence(image), 0, "an unchanged result must not create new intent");
`, { mode: 0o600 });
    const child = spawnSync(process.execPath, [entrypoint], {
      env: { ...process.env, HOME: base, OPENCODE_BROKER_CONFIG: configPath,
        OPENCODE_MODEL_ROUTING_DIR: join(base, "state") }, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a status read cap-evicts the oldest settled durable assignment and persists it once", async (context) => {
  let fixture = await startBroker("assignment-cap", state(), {
    config: CAP_CONFIG,
    auth: { fixture: { type: "oauth" } },
  });
  context.after(() => fixture.close());

  for (let index = 0; index < 512; index += 1) {
    const sessionID = `ses_Cap${index.toString().padStart(4, "0")}`;
    const lease = await post(fixture.socketPath, "/lease", { sessionID, profile: "auto", tier: "smart", replace: true });
    assert.equal(lease.status, 200, lease.body);
    const leaseID = JSON.parse(lease.body).leaseID;
    const forgotten = await post(fixture.socketPath, "/forget", { sessionID, leaseID, completed: true });
    assert.equal(forgotten.status, 200, forgotten.body);
  }
  const overflowID = "ses_Cap0512";
  const overflowLease = await post(fixture.socketPath, "/lease", { sessionID: overflowID, profile: "auto", tier: "smart", replace: true });
  assert.equal(overflowLease.status, 200, overflowLease.body);
  assert.equal(Object.keys(JSON.parse(readFileSync(fixture.statePath, "utf8")).assignments).length, 513, "the overflow is durable before the read sweep");
  const before = fileIdentity(fixture.statePath);

  const first = await post(fixture.socketPath, "/status");
  assert.equal(first.status, 200, first.body);
  const after = fileIdentity(fixture.statePath);
  assert.notEqual(after.ino, before.ino, "only the post-startup status sweep persists the cap eviction");
  const capped = JSON.parse(after.bytes);
  assert.equal(Object.keys(capped.assignments).length, 512);
  assert.equal(capped.assignments.ses_Cap0000, undefined, "the oldest idle pin is evicted");
  assert.ok(capped.assignments[overflowID]);
  assert.ok(capped.leases[overflowID], "the overflow lease remains live and is not eligible for eviction");

  const stable = fileIdentity(fixture.statePath);
  const second = await post(fixture.socketPath, "/selection");
  assert.equal(second.status, 200, second.body);
  assert.deepEqual(fileIdentity(fixture.statePath), stable, "the stable follow-up read does not rewrite");

  const base = fixture.base;
  await fixture.stop();
  fixture = await startBroker("assignment-cap", state(), { base });
  const restarted = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.equal(Object.keys(restarted.assignments).length, 512);
  assert.equal(restarted.assignments.ses_Cap0000, undefined, "restart does not restore the cap-evicted pin");
});

const CONTINUATION_CONFIG = {
  targets: { "api-sonnet": { providerID: "paid-api", modelID: "paid-sonnet", kind: "cloud" } },
  profiles: { "api-reserve": ["api-sonnet"] },
  manualApiTargets: { "api-sonnet": ["api-reserve"] },
  tiers: { smart: [], worker: [] },
  apiContinuation: {
    enabled: true,
    sourceProviders: ["oauthsrc"],
    targets: { "api-sonnet": ["smart"] },
    spendPolicyHashes: { "api-sonnet": "a".repeat(64) },
  },
};

test("a status read prunes a previously valid continuation proof after its source auth changes", async (context) => {
  const sessionID = "ses_ProofRead1";
  let fixture = await startBroker("continuation-auth-pruning", state(), {
    config: CONTINUATION_CONFIG,
    auth: { oauthsrc: { type: "oauth" }, othersub: { type: "oauth" } },
    resolvableModels: ["oauthsrc/src-model", "oauthsrc/src-model-2", "othersub/other-model", "paid-api/paid-sonnet"],
  });
  context.after(() => fixture.close());
  const published = await post(fixture.socketPath, "/inventory", {
    targets: {
      "subscription-oauthsrc-src-model-standard": {
        id: "subscription-oauthsrc-src-model-standard", providerID: "oauthsrc", modelID: "src-model", kind: "cloud",
        capacity: null, source: "subscription-oauth", tiers: ["smart", "deep"],
      },
      "subscription-othersub-other-model-standard": {
        id: "subscription-othersub-other-model-standard", providerID: "othersub", modelID: "other-model", kind: "cloud",
        capacity: null, source: "subscription-oauth", tiers: ["worker"],
      },
    },
    providers: {
      oauthsrc: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
      othersub: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    },
    modelContexts: { "oauthsrc/src-model": 200000, "oauthsrc/src-model-2": 200000, "othersub/other-model": 200000 },
    authRevision: privateAuthRevision(fixture.authPath),
    configFingerprint: createHash("sha256").update(readFileSync(join(fixture.base, "config.json"))).digest("hex"),
  });
  assert.equal(published.status, 200, published.body);
  assert.ok(JSON.parse(readFileSync(fixture.statePath, "utf8")).inventory.targets["subscription-oauthsrc-src-model-standard"], "the private source inventory is retained before proving continuation authority");
  const lease = await post(fixture.socketPath, "/lease", { sessionID, profile: "auto", tier: "smart", replace: true });
  assert.equal(lease.status, 200, lease.body);
  const leased = JSON.parse(lease.body);
  const resetAtMs = Date.now() + 60 * 60_000;
  const observation = { version: 1, kind: "anthropic-unified", window: "five_hour", resetAtMs };
  const observed = await post(fixture.socketPath, "/quota-evidence", {
    sessionID, leaseID: leased.leaseID, targetID: leased.target.id, subscriptionQuota: observation,
  });
  assert.equal(observed.status, 200, observed.body);
  const failed = await post(fixture.socketPath, "/failure", {
    sessionID, leaseID: leased.leaseID, targetID: leased.target.id,
    error: { name: "APIError", statusCode: 429, message: `upstream oauthsrc HTTP 429: usage limit reached (5-hour limit; resets at ${new Date(resetAtMs).toISOString()})` },
  });
  assert.equal(failed.status, 200, failed.body);
  assert.ok(JSON.parse(readFileSync(fixture.statePath, "utf8")).apiContinuations[sessionID], "the genuine proof is durable before restart");

  const base = fixture.base;
  await fixture.stop();
  fixture = await startBroker("continuation-auth-pruning", state(), { base });
  const retained = JSON.parse(readFileSync(fixture.statePath, "utf8"));
  assert.ok(retained.apiContinuations[sessionID], "the valid proof survives startup before the post-startup auth mutation");
  assert.deepEqual(retained.leases, {});
  const assignmentsBefore = retained.assignments;
  const circuitsBefore = retained.circuits;
  const healthBefore = retained.health;
  const rebalancesBefore = retained.rebalances;
  writeFileSync(fixture.authPath, JSON.stringify({ oauthsrc: { type: "api" }, othersub: { type: "oauth" } }), { mode: 0o600 });
  const before = fileIdentity(fixture.statePath);

  const first = await post(fixture.socketPath, "/status");
  assert.equal(first.status, 200, first.body);
  const after = fileIdentity(fixture.statePath);
  assert.notEqual(after.ino, before.ino, "the post-startup auth invalidation is persisted by the status read");
  const pruned = JSON.parse(after.bytes);
  assert.deepEqual(pruned.apiContinuations, {});
  assert.deepEqual(pruned.leases, {});
  assert.deepEqual(pruned.assignments, assignmentsBefore, "assignment retention did not cause this write");
  assert.deepEqual(pruned.circuits, circuitsBefore, "the source circuit did not expire or mutate");
  assert.deepEqual(pruned.health, healthBefore);
  assert.deepEqual(pruned.rebalances, rebalancesBefore);

  const stable = fileIdentity(fixture.statePath);
  const second = await post(fixture.socketPath, "/selection");
  assert.equal(second.status, 200, second.body);
  assert.deepEqual(fileIdentity(fixture.statePath), stable, "the stable follow-up read does not rewrite");

  await fixture.stop();
  fixture = await startBroker("continuation-auth-pruning", state(), { base });
  assert.deepEqual(JSON.parse(readFileSync(fixture.statePath, "utf8")).apiContinuations, {}, "restart does not restore the pruned proof");
});
