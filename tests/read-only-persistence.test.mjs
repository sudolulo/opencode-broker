import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const BROKER = new URL("../bin/opencode-broker", import.meta.url).pathname;

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
} = {}) => {
  const base = existingBase ?? mkdtempSync(join(tmpdir(), `broker-read-only-${name}-`));
  if (!existingBase) chmodSync(base, 0o700);
  const home = join(base, "home");
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  const socketPath = join(base, "broker.sock");
  const configPath = join(base, "config.json");
  const faultArmPath = join(base, "fail-next-rename");
   const clockPath = join(base, "clock-now");
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
