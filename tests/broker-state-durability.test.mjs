import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { emptyOutages, reduceOutages } from "../lib/model-outages.js";
import { makeBaseline, makeFailure, makePolicy, makeSnapshot, makeTargets } from "./helpers/model-outages.mjs";

const BROKER = new URL("../bin/opencode-broker", import.meta.url).pathname;
const FAULT_HOOK = new URL("./fixtures/broker-state-fault.cjs", import.meta.url).pathname;
const FETCH_HOOK = new URL("./fixtures/outage-status-fetch.cjs", import.meta.url).pathname;

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

// Enabled outage-reserve fixture: a durable, diagnosed episode whose verified reserve makes a
// primary recovery probe due at the worker's first tick, admitted providers so the probe passes
// its upper fences, fake 0600 keys, offline status feeds, and a local gateway that records each
// probe dispatch together with the broker.json image on disk at that moment.
const CI_A = `ci_${"A".repeat(43)}`;
const LOGICAL = "anthropic/opus/standard";
const outagePolicy = makePolicy();
const outageEpisode = (now) => {
  const t0 = now - 9_000;
  let outages = emptyOutages();
  for (const event of [
    makeBaseline({ credentialInstance: CI_A, startedAt: t0, finishedAt: t0 + 100 }),
    makeFailure({ credentialInstance: CI_A, startedAt: t0 + 1_000, finishedAt: t0 + 1_100 }),
    makeSnapshot({ receivedAt: t0 + 1_200 }),
    makeBaseline({ credentialInstance: CI_A, targetID: "claude-opus-5", requestID: "r-reserve", attemptID: "a-reserve",
      startedAt: t0 + 1_201, finishedAt: t0 + 1_300 }),
  ]) outages = reduceOutages(outages, event, { policy: outagePolicy, now: event.finishedAt ?? event.receivedAt });
  return outages;
};

const startGateway = async (statePath) => {
  const dispatches = [];
  const server = createHttpServer((request, response) => {
    let image = null;
    try { image = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
    dispatches.push({ path: request.url, purpose: request.headers["x-opencode-probe-purpose"], image });
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, dispatches, close: () => new Promise((resolve) => server.close(resolve)) };
};

const startBroker = async (name, fault = "", { outage = false, outageLease = false, skip = 0, armed = false } = {}) => {
  const base = mkdtempSync(join(tmpdir(), `broker-state-${name}-`));
  chmodSync(base, 0o700);
  const home = join(base, "home");
  const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
  const socketPath = join(base, "broker.sock");
  const tracePath = join(base, "fault-trace.jsonl");
  const armPath = join(base, "fault-armed");
  const configPath = join(base, "config.json");
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(statePath), 0o700);
  const initial = outage
    ? { ...emptyState(), leases: {}, outages: outageEpisode(Date.now()),
      inventory: { ...emptyState().inventory, providers: { anthropic: { connected: true, authType: "oauth" }, openai: { connected: true, authType: "oauth" } } } }
    : emptyState();
  if (outageLease) initial.leases["durability-session"] = emptyState().leases["durability-session"];
  writeFileSync(statePath, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
  writeFileSync(tracePath, "", { mode: 0o600 });
  if (armed) writeFileSync(armPath, "armed\n", { mode: 0o600 });
  const gateway = outage ? await startGateway(statePath) : null;
  const outageEnv = {};
  if (outage) {
    const keys = join(base, "keys");
    mkdirSync(keys, { mode: 0o700 });
    writeFileSync(join(keys, "gateway-key"), "fake-front-door-key\n", { mode: 0o600 });
    writeFileSync(join(keys, "health-credential"), "fake-private-gateway-credential\n", { mode: 0o600 });
    writeFileSync(join(dirname(statePath), "model-health.key"), Buffer.alloc(32, 7), { mode: 0o600 });
    Object.assign(outageEnv, {
      OPENCODE_BROKER_OUTAGE_GATEWAY_URL: gateway.url,
      OPENCODE_BROKER_GATEWAY_KEY_FILE: join(keys, "gateway-key"),
      OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE: join(keys, "health-credential"),
      OPENCODE_BROKER_TEST_FETCH_TRACE: join(base, "fetch-trace.jsonl"),
      OPENCODE_BROKER_STATE_FAULT_SKIP: String(skip),
    });
  }
  writeFileSync(configPath, JSON.stringify({ burnWatch: { enabled: false }, slotWatch: { enabled: false },
    ...(outage ? {
      targets: makeTargets(),
      tiers: { smart: ["claude-opus-5-5"], worker: ["claude-opus-5-5"] },
      modelOutages: (({ primaryScope: _derived, ...rest }) => rest)(outagePolicy),
    } : {}) }));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_)/.test(key)));
  const child = spawn(process.execPath, ["--require", FAULT_HOOK, ...(outage ? ["--require", FETCH_HOOK] : []), BROKER, "serve"], {
    env: {
      ...(outage ? inherited : process.env),
      HOME: home,
      OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_MODEL_BROKER_SOCKET: socketPath,
      OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
      OPENCODE_BROKER_STATE_FAULT_TRACE: tracePath,
      OPENCODE_BROKER_STATE_FAULT_PATH: statePath,
      OPENCODE_BROKER_STATE_FAULT_STEP: fault,
      OPENCODE_BROKER_STATE_FAULT_ARM: armPath,
      ...outageEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await new Promise((resolve, reject) => {
      const rejectStartup = (error) => {
        clearTimeout(deadline);
        reject(error);
      };
      const deadline = setTimeout(() => rejectStartup(new Error(`broker did not listen: ${stdout}\n${stderr}`)), 3000);
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
    await gateway?.close();
    rmSync(base, { recursive: true, force: true });
    throw error;
  }
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
    disarm: () => rmSync(armPath, { force: true }),
    gateway,
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      await gateway?.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
};

test("ordinary broker state writes atomically without fsync", async (context) => {
  const fixture = await startBroker("ordering");
  context.after(() => fixture.close());
  fixture.resetTrace();
  const response = await post(fixture.socketPath, "/touch", { sessionID: "durability-session" });
  assert.equal(response.status, 200, response.body);
  assert.deepEqual(fixture.trace(), [
    { operation: "open", target: "temp", flags: "wx", mode: 0o600 },
    { operation: "write", target: "temp", bytes: statSync(fixture.statePath).size },
    { operation: "close", target: "temp" },
    { operation: "rename", target: "state" },
  ]);
  assert.equal(statSync(fixture.statePath).mode & 0o777, 0o600);
});

test("an ordinary write does not reach a temp fsync fault", async (context) => {
  const fixture = await startBroker("pre-rename", "fsync-temp");
  context.after(() => fixture.close());
  fixture.resetTrace();
  const before = readFileSync(fixture.statePath);
  const response = await post(fixture.socketPath, "/touch", { sessionID: "durability-session" });
  assert.equal(response.status, 200, response.body);
  assert.notDeepEqual(readFileSync(fixture.statePath), before);
  assert.deepEqual(readdirSync(dirname(fixture.statePath)).filter((name) => name.endsWith(".tmp")), []);
  assert.deepEqual(fixture.trace().map(({ operation, target }) => `${operation}:${target}`), [
    "open:temp", "write:temp", "close:temp", "rename:state",
  ]);
});

test("an ordinary write does not reach a directory fsync fault", async (context) => {
  const fixture = await startBroker("post-rename", "fsync-directory");
  context.after(() => fixture.close());
  fixture.resetTrace();
  const before = readFileSync(fixture.statePath);
  const response = await post(fixture.socketPath, "/touch", { sessionID: "durability-session" });
  assert.equal(response.status, 200, response.body);
  assert.notDeepEqual(readFileSync(fixture.statePath), before);
  assert.doesNotMatch(fixture.stderr(), /broker state .* was committed but its directory entry could not be made durable/);
  assert.doesNotMatch(fixture.stderr(), /simulated broker directory fsync failure/);
  assert.equal(existsSync(fixture.statePath), true);
  assert.equal(fixture.trace().some((event) => event.operation === "rename"), true);
  assert.equal(fixture.trace().some((event) => event.operation === "fsync"), false);
});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return true; await settle(25); }
  return predicate();
};
const episodeOf = (image) => image?.outages?.scopes?.[LOGICAL]?.instances?.[CI_A]?.episode;

test("an outage probe leaves only after its reservation is fsynced, renamed and directory-fsynced", async (context) => {
  const fixture = await startBroker("outage-dispatch", "", { outage: true });
  context.after(() => fixture.close());
  assert.equal(await waitFor(() => fixture.gateway.dispatches.length > 0), true, fixture.stderr());
  const [dispatch] = fixture.gateway.dispatches;
  assert.equal(dispatch.path, "/v1/messages");
  assert.equal(dispatch.purpose, "outage-health");
  // The image on disk when the gateway saw the request already carried the reservation.
  assert.equal(episodeOf(dispatch.image).probeCounts.primary, 1);
  assert.equal(typeof dispatch.image.outages.providers.anthropic.inflight.id, "string");
  const events = fixture.trace().map(({ operation, target }) => `${operation}:${target}`);
  assert.ok(events.filter((event) => event === "fsync:directory").length >= 2, "startup write plus the strict reservation write");
  await settle(200);
  assert.equal(fixture.gateway.dispatches.length, 1, "one in-flight probe per provider");
});

test("a strict outage fsync failure survives an ordinary write until a stable read retries it strictly", async (context) => {
  // Armed from spawn: the ordinary startup write keeps its warn-and-continue behavior; the first
  // outage reservation write is strict and must refuse.
  const fixture = await startBroker("outage-directory", "fsync-directory", { outage: true, outageLease: true, armed: true });
  context.after(() => fixture.close());
  assert.equal(await waitFor(() => /outage worker error/.test(fixture.stderr())), true, fixture.stderr());
  await settle(300);
  assert.equal(fixture.gateway.dispatches.length, 0, "zero gateway dispatch after a failed durability step");
  assert.match(fixture.stderr(), /was committed but its directory entry could not be made durable/);
  // Visible but not durable: the renamed file already carries the advanced count.
  assert.equal(episodeOf(fixture.state()).probeCounts.primary, 1);
  fixture.disarm();
  const ordinary = await post(fixture.socketPath, "/touch", { sessionID: "durability-session" });
  assert.equal(ordinary.status, 200, ordinary.body);
  assert.equal(fixture.trace().filter((event) => event.operation === "fsync" && event.target === "directory").length, 1, "the ordinary write must not clear or fsync the strict intent");
  const response = await post(fixture.socketPath, "/status", {});
  assert.equal(response.status, 200, response.body);
  assert.equal(episodeOf(fixture.state()).probeCounts.primary, 1, "a later ordinary write keeps the advanced count");
  assert.equal(fixture.trace().filter((event) => event.operation === "fsync" && event.target === "directory").length, 2, "the stable read must retry the pending strict directory fsync before clearing intent");
  assert.equal(fixture.gateway.dispatches.length, 0);
});

test("a strict outage commit whose temp fsync fails leaves the file unchanged, dispatches nothing, and a later write keeps the count", async (context) => {
  const fixture = await startBroker("outage-temp", "fsync-temp", { outage: true, armed: true });
  context.after(() => fixture.close());
  assert.equal(await waitFor(() => /outage worker error/.test(fixture.stderr())), true, fixture.stderr());
  await settle(300);
  assert.equal(fixture.gateway.dispatches.length, 0, "zero gateway dispatch after a failed durability step");
  assert.equal(episodeOf(fixture.state()).probeCounts.primary, 0, "the pre-rename failure left the old file authoritative");
  assert.deepEqual(readdirSync(dirname(fixture.statePath)).filter((name) => name.endsWith(".tmp")), []);
  fixture.disarm();
  const response = await post(fixture.socketPath, "/status", {});
  assert.equal(response.status, 200, response.body);
  assert.equal(episodeOf(fixture.state()).probeCounts.primary, 1, "the in-memory reservation was never rolled back to the old image");
  assert.equal(fixture.gateway.dispatches.length, 0);
});
