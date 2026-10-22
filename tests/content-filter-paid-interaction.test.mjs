// How the content-filter cascade /lease mode interacts with paid (manual API) targets, session
// identity, the refusal-code contract and held-lease reuse. Every case runs the real daemon
// (bin/opencode-broker serve) in a fresh private HOME with its own XDG dirs, routing dir and
// socket; only PATH is inherited. auth.json holds synthetic type-only OAuth entries (no tokens),
// the local models URL is a closed loopback port, and the paid target is static config data
// only: no provider, gateway, ledger or network traffic happens.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const brokerScript = join(repoRoot, "bin/opencode-broker");

const PAID = "api-sonnet";
const CLOUD = (providerID, modelID) => ({ providerID, modelID, kind: "cloud", context: 200000 });
const ORDINARY_IDS = ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "gpt-6-1-sol", "gpt-flagship", "gpt-terra"];

const brokerConfig = ({ cascade = {}, mappings = { "claude-opus-5-5": ["claude-opus-5", "claude-opus-4-8"], "gpt-6-1-sol": ["gpt-flagship"] } } = {}) => ({
  targets: {
    "claude-opus-5-5": CLOUD("anthropic", "claude-opus-5-5"),
    "claude-opus-5": CLOUD("anthropic", "claude-opus-5"),
    "claude-opus-4-8": CLOUD("anthropic", "claude-opus-4-8"),
    "gpt-6-1-sol": CLOUD("openai", "gpt-6.1-sol"),
    "gpt-flagship": CLOUD("openai", "gpt-6-sol"),
    "gpt-terra": CLOUD("openai", "gpt-5.6-terra"),
    [PAID]: CLOUD("paid-api", "paid-sonnet"),
  },
  tiers: { smart: ["claude-opus-5-5", "gpt-6-1-sol"], build: ["gpt-terra", "claude-opus-5-5"], worker: ["gpt-terra"] },
  fallbacks: {},
  profiles: { "api-reserve": [PAID] },
  manualApiTargets: { [PAID]: ["api-reserve"] },
  slotWatch: { enabled: false },
  modelOutages: { enabled: false, mappings },
  contentFilterCascade: { enabled: true, tierDescent: ["smart", "build", "worker"], uncensoredFloorTargetID: null, maxAttempts: 8, ...cascade },
});

const createFixture = async (config) => {
  const home = mkdtempSync(join(tmpdir(), "cf-paid-"));
  const dirs = Object.fromEntries(["config", "data", "state", "cache", "runtime", "routing"].map((name) => {
    const path = join(home, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return [name, path];
  }));
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true, mode: 0o700 });
  const configPath = join(dirs.config, "broker.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(home, ".local/share/opencode/auth.json"),
    JSON.stringify({ anthropic: { type: "oauth" }, openai: { type: "oauth" } }), { mode: 0o600 });
  const socketPath = join(dirs.routing, "broker.sock");
  const statePath = join(dirs.routing, "broker.json");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    XDG_RUNTIME_DIR: dirs.runtime,
    OPENCODE_BROKER_CONFIG: configPath,
    OPENCODE_MODEL_ROUTING_DIR: dirs.routing,
    OPENCODE_MODEL_BROKER_SOCKET: socketPath,
    OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
  };
  const child = spawn(process.execPath, [brokerScript, "serve"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening on ")) resolve(); });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
    });
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  const call = (path, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ socketPath, path, method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(payload),
    } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => { try { resolve({ status: response.statusCode, body: text ? JSON.parse(text) : {} }); } catch (error) { reject(error); } });
    });
    request.on("error", reject);
    request.end(payload);
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  };
  // /status sweeps and persists; the private state file is read right after it.
  const state = async () => {
    const status = await call("/status", {});
    assert.equal(status.status, 200, JSON.stringify(status.body));
    return JSON.parse(readFileSync(statePath, "utf8"));
  };
  return { call, stop, state, stderr: () => stderr };
};

const withBroker = async (config, fn) => {
  const fx = await createFixture(config);
  try { await fn(fx); } finally { await fx.stop(); }
};

const cascadeBody = (overrides = {}) => ({
  sessionID: "gw-cfpaid-1", profile: "auto", tier: "smart", oneShot: true, replace: true,
  contentFilterCascade: true,
  blockedModel: { providerID: "anthropic", id: "claude-opus-5-5" },
  providers: ["anthropic", "openai", "paid-api"],
  contextTokens: 1000,
  excludeTargetIDs: ["claude-opus-5-5"],
  ...overrides,
});

// (a) A manual API target as the uncensored floor is a spend boundary misconfiguration: the cascade
// config fails closed (feature disabled, error logged) rather than leasing paid capacity ungranted.
test("a manual API target named as the uncensored floor disables the cascade and logs the config error", async () => {
  await withBroker(brokerConfig({ cascade: { uncensoredFloorTargetID: PAID } }), async (fx) => {
    const res = await fx.call("/lease", cascadeBody({ profile: "api-reserve", excludeTargetIDs: ORDINARY_IDS }));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "content-filter-disabled", JSON.stringify(res.body));
    assert.match(fx.stderr(), /contentFilterCascade/);
    assert.match(fx.stderr(), /uncensoredFloorTargetID/);
    const state = await fx.state();
    assert.equal(state.leases["gw-cfpaid-1"], undefined, "no lease of any kind was written");
  });
});

test("a floor that is not a static local target also disables the cascade", async () => {
  await withBroker(brokerConfig({ cascade: { uncensoredFloorTargetID: "gpt-terra" } }), async (fx) => {
    const res = await fx.call("/lease", cascadeBody());
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "content-filter-disabled", JSON.stringify(res.body));
    assert.match(fx.stderr(), /uncensoredFloorTargetID/);
  });
});

test("a manual API target reachable through a reserve mapping is skipped, never leased by the cascade", async () => {
  const mappings = { "claude-opus-5-5": ["claude-opus-5", PAID], "gpt-6-1-sol": ["gpt-flagship"] };
  await withBroker(brokerConfig({ mappings }), async (fx) => {
    // The manual profile is the one whose admission would let the paid target through; it
    // admits no ordinary target, so with the paid older-generation skipped the walk is exhausted.
    const res = await fx.call("/lease", cascadeBody({ profile: "api-reserve", excludeTargetIDs: ["claude-opus-5-5", "claude-opus-5"] }));
    assert.notEqual(res.body?.target?.model?.id, "paid-sonnet", `the paid reserve-mapped target must be skipped: ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "content-filter-exhausted", JSON.stringify(res.body));
    const state = await fx.state();
    assert.equal(state.leases["gw-cfpaid-1"], undefined, "no lease of any kind was written");
  });
});

// (b) A cascading subagent worker keeps its session identity (and so its 1 h TTL).
test("a cascade lease for a subagent session records sessionKind on the lease and the assignment", async () => {
  await withBroker(brokerConfig(), async (fx) => {
    const sessionID = "ses_CascadeSubagent1";
    const res = await fx.call("/lease", cascadeBody({ sessionID, oneShot: undefined, sessionKind: "subagent" }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const state = await fx.state();
    assert.equal(state.leases[sessionID]?.sessionKind, "subagent", JSON.stringify(state.leases[sessionID]));
    assert.equal(state.assignments[sessionID]?.sessionKind, "subagent", JSON.stringify(state.assignments[sessionID]));
  });
});

// (c) The cascade refusals carry their static machine-readable code on the 400 reply.
test("an exhausted cascade refuses with code content-filter-exhausted", async () => {
  await withBroker(brokerConfig(), async (fx) => {
    const res = await fx.call("/lease", cascadeBody({ excludeTargetIDs: ORDINARY_IDS }));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "content-filter-exhausted", JSON.stringify(res.body));
  });
});

test("a disabled cascade refuses with code content-filter-disabled", async () => {
  await withBroker(brokerConfig({ cascade: { enabled: false } }), async (fx) => {
    const res = await fx.call("/lease", cascadeBody());
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "content-filter-disabled", JSON.stringify(res.body));
  });
});

// (d) A cascade lease must never be answered by held-lease reuse: the held lease IS the model
// that was just blocked.
test("a cascade lease without replace:true is refused and never returns the held lease", async () => {
  await withBroker(brokerConfig(), async (fx) => {
    const sessionID = "ses_CascadeHeld1";
    const first = await fx.call("/lease", { sessionID, profile: "auto", tier: "smart", contextTokens: 1000 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const held = (await fx.state()).leases[sessionID];
    assert.ok(held?.leaseID, "fixture: the session holds an ordinary lease");
    const heldModel = first.body.target.model;
    // No exclusion list: the blocked model is named only by blockedModel, which held-lease
    // revalidation does not read -- the shape that would hand the blocked lease straight back.
    const res = await fx.call("/lease", cascadeBody({
      sessionID, oneShot: undefined, replace: undefined,
      blockedModel: { providerID: heldModel.providerID, id: heldModel.id },
      excludeTargetIDs: [],
    }));
    assert.notEqual(res.body.existing, true, `held lease returned to a cascade: ${JSON.stringify(res.body)}`);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "content-filter-cascade-requires-replace", JSON.stringify(res.body));
    const after = (await fx.state()).leases[sessionID];
    assert.equal(after?.leaseID, held.leaseID, "a refused cascade leaves the held lease untouched");
    const replaced = await fx.call("/lease", cascadeBody({
      sessionID, oneShot: undefined,
      blockedModel: { providerID: heldModel.providerID, id: heldModel.id },
      excludeTargetIDs: [held.targetID],
    }));
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.notEqual(replaced.body.leaseID, held.leaseID, "replace:true never reuses the held lease");
    assert.notEqual(replaced.body.target.model.id, heldModel.id, "the blocked model is not re-served");
  });
});
