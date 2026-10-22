// The broker side of subscription-quota continuation EVIDENCE. Nothing here routes to,
// grants or funds a paid target: these tests cover only how the broker captures the source identity on a new source
// lease, records a non-settling quota observation on it, consumes that observation at the
// plugin's later exact /failure, and persists/prunes the closed source proof.
//
// Every case runs the real daemon (bin/opencode-broker serve) in a fresh private HOME with its own
// XDG dirs, config, routing dir and socket. Only PATH is inherited. auth.json holds synthetic
// type-only OAuth entries (no tokens), the catalog is a synthetic resolvable-models.json, no
// budgets are configured (so no provider usage fetch can run) and the local models URL is a
// closed loopback port. No provider, gateway or network traffic happens.
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

const PIN = "a".repeat(64);
const SRC_ID = "subscription-oauthsrc-src-model-standard";
const OTHER_ID = "subscription-othersub-other-model-standard";
const SESSION = "ses_SourceAlpha1";
const RECORD_KEYS = ["sourceLeaseID", "sourceTargetID", "sourceModelID", "sourceProviderID", "sourceAuthRevision",
  "observedAtMs", "circuitKind", "circuitUpdatedAtMs", "circuitUntilMs", "policyRevision", "quotaEvidenceClosed"].sort();
const SNAPSHOT_KEYS = ["version", "targetID", "providerID", "modelID", "authRevision", "policyRevision", "issuedAtMs"].sort();
const OBSERVATION_KEYS = ["version", "observedAtMs", "policyRevision", "subscriptionQuota"].sort();
const CONFLICT_KEYS = ["version", "conflictedAtMs"].sort();

const ENABLED = Object.freeze({
  enabled: true,
  sourceProviders: ["oauthsrc"],
  targets: { "api-sonnet": ["smart"] },
  spendPolicyHashes: { "api-sonnet": PIN },
});

const brokerConfig = (apiContinuation) => ({
  targets: { "api-sonnet": { providerID: "paid-api", modelID: "paid-sonnet", kind: "cloud" } },
  profiles: { "api-reserve": ["api-sonnet"] },
  manualApiTargets: { "api-sonnet": ["api-reserve"] },
  tiers: { smart: [], worker: [] },
  ...(apiContinuation === undefined ? {} : { apiContinuation }),
});

const AUTH = { oauthsrc: { type: "oauth" }, othersub: { type: "oauth" } };
const RESOLVABLE = ["oauthsrc/src-model", "oauthsrc/src-model-2", "othersub/other-model", "paid-api/paid-sonnet"];

const createFixture = (config) => {
  const home = mkdtempSync(join(tmpdir(), "api-continuation-broker-"));
  const dirs = Object.fromEntries(["config", "data", "state", "cache", "runtime", "routing"].map((name) => {
    const path = join(home, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return [name, path];
  }));
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true, mode: 0o700 });
  const fx = {
    home,
    configPath: join(dirs.config, "broker.json"),
    authPath: join(home, ".local/share/opencode/auth.json"),
    statePath: join(dirs.routing, "broker.json"),
    socketPath: join(dirs.routing, "broker.sock"),
    child: null,
  };
  fx.writeConfig = (value) => writeFileSync(fx.configPath, JSON.stringify(value), { mode: 0o600 });
  fx.writeAuth = (value) => writeFileSync(fx.authPath, JSON.stringify(value), { mode: 0o600 });
  fx.writeConfig(config);
  fx.writeAuth(AUTH);
  writeFileSync(join(dirs.routing, "resolvable-models.json"), JSON.stringify({ updatedAt: Date.now(), models: RESOLVABLE }));
  fx.env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    XDG_RUNTIME_DIR: dirs.runtime,
    OPENCODE_BROKER_CONFIG: fx.configPath,
    OPENCODE_MODEL_ROUTING_DIR: dirs.routing,
    OPENCODE_MODEL_BROKER_SOCKET: fx.socketPath,
    OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
  };
  fx.start = async () => {
    const child = spawn(process.execPath, [brokerScript, "serve"], { cwd: repoRoot, env: fx.env, stdio: ["ignore", "pipe", "pipe"] });
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
  fx.restart = async () => { await fx.stop(); await fx.start(); };
  fx.readState = () => JSON.parse(readFileSync(fx.statePath, "utf8"));
  fx.writeState = (value) => writeFileSync(fx.statePath, JSON.stringify(value) + "\n", { mode: 0o600 });
  fx.authRevision = () => {
    const contents = readFileSync(fx.authPath);
    const stat = statSync(fx.authPath);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(contents).digest("hex")}`;
  };
  // Per-provider auth fence: the source snapshot and record fence ONE provider's auth.json entry: sha256 over its
  // canonical serialization (a single-key entry serializes exactly as JSON.stringify does).
  fx.entryRevision = (providerID = "oauthsrc") => createHash("sha256")
    .update(JSON.stringify(JSON.parse(readFileSync(fx.authPath, "utf8"))[providerID])).digest("hex");
  fx.call = (path, body) => new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const request = http.request({ socketPath: fx.socketPath, path, method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(payload),
    } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : {} }));
    });
    request.on("error", reject);
    request.end(payload);
  });
  fx.ok = async (path, body) => {
    const result = await fx.call(path, body);
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  fx.status = () => fx.ok("/status", {});
  // /status does not publish continuation internals. The private state file is read
  // instead, right after a /status round trip (which sweeps and persists it).
  fx.state = async () => { await fx.status(); return fx.readState(); };
  fx.publish = (overrides = {}) => fx.ok("/inventory", {
    targets: {
      [SRC_ID]: { id: SRC_ID, providerID: "oauthsrc", modelID: "src-model", kind: "cloud", capacity: null,
        source: "subscription-oauth", tiers: ["smart", "deep"] },
      [OTHER_ID]: { id: OTHER_ID, providerID: "othersub", modelID: "other-model", kind: "cloud", capacity: null,
        source: "subscription-oauth", tiers: ["worker"] },
      ...(overrides.targets ?? {}),
    },
    providers: {
      oauthsrc: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
      othersub: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    },
    modelContexts: { "oauthsrc/src-model": 200000, "oauthsrc/src-model-2": 200000, "othersub/other-model": 200000 },
    authRevision: fx.authRevision(),
    configFingerprint: createHash("sha256").update(readFileSync(fx.configPath)).digest("hex"),
  });
  fx.lease = (sessionID = SESSION, extra = {}) => fx.ok("/lease", { sessionID, profile: "auto", tier: "smart", replace: true, ...extra });
  fx.cleanup = async () => {
    await fx.stop();
    rmSync(home, { recursive: true, force: true });
  };
  return fx;
};

const withBroker = async (config, run) => {
  const fx = createFixture(config);
  try {
    await fx.start();
    return await run(fx);
  } finally {
    await fx.cleanup();
  }
};

// A whole-second reset two hours out: inside the five-hour window horizon, and printable exactly
// in the gateway's ISO "resets at" wording.
const futureReset = (offsetMs = 2 * 3600_000) => Math.floor((Date.now() + offsetMs) / 1000) * 1000;
const quota = (resetAtMs, extra = {}) => ({ version: 1, kind: "anthropic-unified", window: "five_hour", resetAtMs, ...extra });
const evidence = (lease, subscriptionQuota, sessionID = SESSION) => ({
  sessionID, leaseID: lease.leaseID, targetID: lease.target.id, subscriptionQuota,
});
// The bound-session SDK error shape: the gateway's sanitized wording, with or without a reset.
const quotaError = (resetAtMs, wording = "usage limit reached") => ({
  name: "APIError",
  statusCode: 429,
  message: `upstream oauthsrc HTTP 429: ${wording}${resetAtMs ? ` (5-hour limit; resets at ${new Date(resetAtMs).toISOString()})` : ""}`,
});
const failure = (lease, error, sessionID = SESSION, extra = {}) => ({
  sessionID, leaseID: lease.leaseID, targetID: lease.target.id, error, ...extra,
});

const sourceCircuit = (status) => status.circuits["provider:oauthsrc"];

test("quota evidence never refreshes configured plan usage, while a cloud lease still does", async () => {
  let readerRequests = 0;
  const reader = http.createServer((request, response) => {
    readerRequests += 1;
    assert.equal(request.url, "/usage");
    assert.equal(request.headers["x-api-key"], "private-fixture-reader-key");
    const lockedUntil = futureReset();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      windows: [{ id: "five_hour", percent: 100, resetsAt: new Date(lockedUntil).toISOString(), active: true, severity: null }],
      lockedUntil,
    }));
  });
  await new Promise((resolve) => reader.listen(0, "127.0.0.1", resolve));
  const fx = createFixture(brokerConfig(ENABLED));
  try {
    await fx.start();
    await fx.publish();
    const staleLease = await fx.lease();
    const lease = await fx.lease();
    await fx.stop();

    const keyPath = join(fx.home, "private-fixture-reader-key");
    writeFileSync(keyPath, "private-fixture-reader-key\n", { mode: 0o600 });
    fx.writeConfig({ ...brokerConfig(ENABLED), budgets: {
      oauthsrc: {
        windows: [{ id: "fixture", periodMs: 60_000, meter: "requests", capacity: 100 }],
        planUsage: { type: "http", url: `http://127.0.0.1:${reader.address().port}/usage`, keyFile: keyPath },
      },
    } });
    await fx.start();
    assert.equal(readerRequests, 0, "starting with a configured reader does not poll it");

    const reset = futureReset();
    const valid = evidence(lease, quota(reset));
    const requests = [
      ["valid", valid],
      ["malformed", "[]"],
      ["stale", { ...valid, leaseID: staleLease.leaseID }],
      ["forged", { ...valid, leaseID: "00000000-0000-4000-8000-000000000000" }],
      ["misbound", { ...valid, targetID: OTHER_ID }],
    ];
    for (const [label, body] of requests) {
      const result = await fx.call("/quota-evidence", body);
      if (label === "valid") assert.deepEqual(result, { status: 200, body: { ok: true, accepted: true } });
      else assert.ok(result.status === 400 || result.status === 409, `${label}: ${JSON.stringify(result.body)}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readerRequests, 0, "quota evidence never starts the configured provider reader");
    assert.deepEqual((await fx.state()).circuits, {}, "quota evidence never applies a plan circuit");

    await fx.call("/lease", { sessionID: "ses_OrdinaryLease1", profile: "auto", tier: "smart", replace: true });
    assert.equal(readerRequests, 1, "an ordinary cloud lease still refreshes due plan usage");
    assert.equal(sourceCircuit(await fx.state()).kind, "plan-window");
  } finally {
    await fx.cleanup();
    await new Promise((resolve, reject) => reader.close((error) => error ? reject(error) : resolve()));
  }
});

test("a new durable auto source lease carries a closed source snapshot; observation alone settles and grants nothing", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const lease = await fx.lease();
    assert.equal(lease.target.id, SRC_ID);
    let status = await fx.state();
    const held = status.leases[SESSION];
    assert.deepEqual(Object.keys(held.apiContinuationSource).sort(), SNAPSHOT_KEYS);
    assert.equal(held.apiContinuationSource.version, 1);
    assert.equal(held.apiContinuationSource.targetID, SRC_ID);
    assert.equal(held.apiContinuationSource.providerID, "oauthsrc");
    assert.equal(held.apiContinuationSource.modelID, "src-model");
    assert.equal(held.apiContinuationSource.authRevision, fx.entryRevision(), "the snapshot fences the source provider's own entry");
    assert.notEqual(held.apiContinuationSource.authRevision, fx.authRevision(), "never the whole auth file");
    assert.match(held.apiContinuationSource.policyRevision, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(held.apiContinuationSource.issuedAtMs));
    assert.equal(status.assignments[SESSION].apiContinuationSource, undefined, "the snapshot lives on the lease only");

    const reset = futureReset();
    const before = Date.now();
    const observed = await fx.call("/quota-evidence", evidence(lease, quota(reset)));
    assert.equal(observed.status, 200, JSON.stringify(observed.body));
    assert.deepEqual(observed.body, { ok: true, accepted: true });
    status = await fx.state();
    const stored = status.leases[SESSION];
    assert.equal(stored.leaseID, lease.leaseID, "observation keeps the same live lease");
    assert.deepEqual(Object.keys(stored.quotaObservation).sort(), OBSERVATION_KEYS);
    assert.equal(stored.quotaObservation.version, 1);
    assert.deepEqual(stored.quotaObservation.subscriptionQuota, quota(reset));
    assert.ok(stored.quotaObservation.observedAtMs >= before && stored.quotaObservation.observedAtMs <= Date.now());
    assert.equal(stored.quotaObservation.policyRevision, held.apiContinuationSource.policyRevision);
    assert.equal(sourceCircuit(status), undefined, "observation creates no circuit");
    assert.deepEqual(status.apiContinuations, {}, "observation creates no proof");
    assert.deepEqual((await fx.status()).budgets, {}, "observation records no usage");
    const verified = await fx.ok("/lease/verify", { sessionID: SESSION, leaseID: lease.leaseID });
    assert.equal(verified.held, true);
    assert.equal(verified.target.requiresSpendBudget, undefined, "no paid attestation or grant");
    assert.equal(verified.target.spendGrant, undefined);

    // Identical repeat: idempotent, original timestamp preserved.
    const repeat = await fx.call("/quota-evidence", evidence(lease, quota(reset)));
    assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
    assert.deepEqual(repeat.body, { ok: true, accepted: true });
    assert.deepEqual((await fx.state()).leases[SESSION].quotaObservation, stored.quotaObservation);
    // An otherwise valid DIFFERING observation on the same exact binding refuses, erases the
    // usable observation and leaves a closed conflict tombstone on that lease.
    const conflict = await fx.call("/quota-evidence", evidence(lease, quota(reset + 1000)));
    assert.equal(conflict.status, 409);
    assert.equal(typeof conflict.body.code, "string");
    status = await fx.state();
    assert.equal(status.leases[SESSION].leaseID, lease.leaseID, "the conflict settles nothing");
    assert.equal(status.leases[SESSION].quotaObservation, undefined, "the conflict erases the usable observation");
    assert.deepEqual(Object.keys(status.leases[SESSION].quotaObservationConflict).sort(), CONFLICT_KEYS);
    assert.equal(status.leases[SESSION].quotaObservationConflict.version, 1);
    // A later replay of the ORIGINAL observation cannot restore authority.
    const replayed = await fx.call("/quota-evidence", evidence(lease, quota(reset)));
    assert.equal(replayed.status, 409);
    status = await fx.state();
    assert.equal(status.leases[SESSION].quotaObservation, undefined);
    assert.ok(status.leases[SESSION].quotaObservationConflict, "the tombstone persists until the lease is replaced");
    assert.deepEqual(status.circuits, {});
    // The later exact quota failure with a lost reset therefore has nothing to consume: an
    // ordinary unknown-reset quota circuit and no proof.
    const settled = await fx.ok("/failure", failure(lease, quotaError(null)));
    assert.equal(settled.kind, "quota");
    assert.equal(settled.resetKnown, false);
    status = await fx.state();
    assert.equal(sourceCircuit(status).resetKnown, false);
    assert.deepEqual(status.apiContinuations, {});
    assert.equal(status.leases[SESSION], undefined);
    // A replacement lease starts clean: no observation and no tombstone carried over.
    await fx.ok("/rearm", { targetID: "provider:oauthsrc" });
    const fresh = await fx.lease();
    const freshHeld = (await fx.state()).leases[SESSION];
    assert.equal(freshHeld.leaseID, fresh.leaseID);
    assert.equal(freshHeld.quotaObservation, undefined);
    assert.equal(freshHeld.quotaObservationConflict, undefined);
  });
});

test("the exact later quota /failure consumes the observation, creates the circuit and a closed proof retained by durable history", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const lease = await fx.lease();
    const policyRevision = (await fx.state()).leases[SESSION].apiContinuationSource.policyRevision;
    const reset = futureReset();
    await fx.ok("/quota-evidence", evidence(lease, quota(reset)));
    const observedAtMs = (await fx.state()).leases[SESSION].quotaObservation.observedAtMs;
    const settled = await fx.ok("/failure", failure(lease, quotaError(reset)));
    assert.equal(settled.kind, "quota");
    assert.equal(settled.circuitUntil, reset);
    assert.equal(settled.resetKnown, true);
    let status = await fx.state();
    const circuit = sourceCircuit(status);
    assert.equal(circuit.kind, "quota");
    assert.equal(circuit.resetKnown, true);
    assert.equal(circuit.until, reset);
    assert.equal(Object.hasOwn(circuit, "reason"), false);
    assert.equal(status.leases[SESSION], undefined, "the failure settles the lease");
    const record = status.apiContinuations[SESSION];
    assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS);
    assert.deepEqual(record, {
      sourceLeaseID: lease.leaseID,
      sourceTargetID: SRC_ID,
      sourceModelID: "src-model",
      sourceProviderID: "oauthsrc",
      sourceAuthRevision: fx.entryRevision(),
      observedAtMs,
      circuitKind: "quota",
      circuitUpdatedAtMs: circuit.updatedAt,
      circuitUntilMs: reset,
      policyRevision,
      quotaEvidenceClosed: quota(reset),
    });

    // A duplicate report of the settled failure is a replay: nothing new.
    const replay = await fx.ok("/failure", failure(lease, quotaError(reset)));
    assert.equal(replay.kind, "quota");
    assert.deepEqual((await fx.state()).apiContinuations[SESSION], record);

    // Ordinary durable-session lifecycle keeps the proof: a fresh lease, /complete, /forget.
    const next = await fx.lease(SESSION, { tier: "worker" });
    assert.equal(next.target.id, OTHER_ID);
    assert.equal((await fx.state()).leases[SESSION].apiContinuationSource, undefined, "a non-allowlisted provider is never a source");
    await fx.ok("/complete", { sessionID: SESSION, leaseID: next.leaseID, targetID: next.target.id });
    assert.deepEqual((await fx.state()).apiContinuations[SESSION], record);
    const again = await fx.lease(SESSION, { tier: "worker" });
    await fx.ok("/release", { sessionID: SESSION, leaseID: again.leaseID });
    const third = await fx.lease(SESSION, { tier: "worker" });
    await fx.ok("/forget", { sessionID: SESSION, leaseID: third.leaseID, completed: true });
    assert.deepEqual((await fx.state()).apiContinuations[SESSION], record);

    // Clearing the source circuit revokes the proof.
    await fx.ok("/rearm", { targetID: "provider:oauthsrc" });
    status = await fx.state();
    assert.equal(sourceCircuit(status), undefined);
    assert.equal(status.apiContinuations[SESSION], undefined);
  });
});

test("a lost SDK reset uses the observed reset; an explicit conflicting reset never yields proof", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const reset = futureReset();
    const lease = await fx.lease();
    await fx.ok("/quota-evidence", evidence(lease, quota(reset)));
    const settled = await fx.ok("/failure", failure(lease, quotaError(null)));
    assert.equal(settled.kind, "quota");
    assert.equal(settled.circuitUntil, reset, "the observed reset replaces the lost one");
    assert.equal(settled.resetKnown, true);
    let status = await fx.state();
    assert.equal(sourceCircuit(status).until, reset);
    assert.equal(status.apiContinuations[SESSION].circuitUntilMs, reset);
    await fx.ok("/rearm", { targetID: "provider:oauthsrc" });

    const second = "ses_SourceBeta2";
    const lease2 = await fx.lease(second);
    await fx.ok("/quota-evidence", evidence(lease2, quota(reset), second));
    const conflicting = reset + 60_000;
    const settled2 = await fx.ok("/failure", failure(lease2, quotaError(conflicting), second));
    assert.equal(settled2.kind, "quota");
    assert.equal(settled2.circuitUntil, conflicting, "ordinary classification keeps the explicit reset");
    status = await fx.state();
    assert.equal(sourceCircuit(status).until, conflicting);
    assert.equal(status.apiContinuations[second], undefined, "conflicting resets never authorize");
    assert.equal(status.leases[second], undefined);
  });
});

test("direct failure flags, non-quota, billing and lapsed failures never produce proof", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const reset = futureReset();
    // A direct body flag without a stored observation.
    let lease = await fx.lease();
    await fx.ok("/failure", failure(lease, quotaError(reset), SESSION, { subscriptionQuota: quota(reset) }));
    let status = await fx.state();
    assert.equal(sourceCircuit(status).kind, "quota");
    assert.deepEqual(status.apiContinuations, {});
    await fx.ok("/rearm", { targetID: "provider:oauthsrc" });

    // A non-quota failure discards the observation with the lease.
    lease = await fx.lease();
    await fx.ok("/quota-evidence", evidence(lease, quota(reset)));
    const overload = await fx.ok("/failure", failure(lease, { name: "APIError", statusCode: 529, message: "upstream oauthsrc HTTP 529: overloaded" }));
    assert.equal(overload.kind, "overload");
    status = await fx.state();
    assert.deepEqual(status.apiContinuations, {});
    assert.equal(status.leases[SESSION], undefined);
    await fx.ok("/rearm", { targetID: SRC_ID });

    // Billing wording is a contradiction even with a matching reset.
    lease = await fx.lease();
    await fx.ok("/quota-evidence", evidence(lease, quota(reset)));
    const billing = await fx.ok("/failure", failure(lease, quotaError(reset, "billing limit exhausted")));
    assert.equal(billing.kind, "quota");
    status = await fx.state();
    assert.deepEqual(status.apiContinuations, {});
    await fx.ok("/rearm", { targetID: "provider:oauthsrc" });

    // A lapsed plan is a quota stop, never a subscription window.
    lease = await fx.lease();
    await fx.ok("/quota-evidence", evidence(lease, quota(reset)));
    const lapsed = await fx.ok("/failure", failure(lease, { name: "APIError", statusCode: 403, code: "AccessDenied.Unpurchased", message: "AccessDenied.Unpurchased" }));
    assert.equal(lapsed.kind, "quota");
    status = await fx.state();
    assert.deepEqual(status.apiContinuations, {});
  });
});

test("malformed, stale, forged and wrong-target observations refuse with no side effects", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const reset = futureReset();
    const old = await fx.lease();
    const lease = await fx.lease();
    assert.notEqual(old.leaseID, lease.leaseID);
    const good = evidence(lease, quota(reset));
    const cases = [
      ["not an object", "[]"],
      ["missing key", { sessionID: SESSION, leaseID: lease.leaseID, targetID: SRC_ID }],
      ["extra key", { ...good, purpose: "continuation" }],
      ["bad session id", { ...good, sessionID: "bad id" }],
      ["numeric lease", { ...good, leaseID: 7 }],
      ["stale lease", { ...good, leaseID: old.leaseID }],
      ["forged lease", { ...good, leaseID: "00000000-0000-4000-8000-000000000000" }],
      ["wrong target", { ...good, targetID: OTHER_ID }],
      ["unknown session", { ...good, sessionID: "ses_NobodyHere9" }],
      ["expired reset", { ...good, subscriptionQuota: quota(Date.now() - 1000) }],
      ["beyond horizon", { ...good, subscriptionQuota: quota(futureReset(6 * 3600_000)) }],
      ["unknown window", { ...good, subscriptionQuota: quota(reset, { window: "one_day" }) }],
      ["extra quota key", { ...good, subscriptionQuota: quota(reset, { raw: "x" }) }],
      ["generic flag", { ...good, subscriptionQuota: true }],
    ];
    for (const [label, body] of cases) {
      const result = await fx.call("/quota-evidence", body);
      assert.ok(result.status === 400 || result.status === 409, `${label}: ${result.status} ${JSON.stringify(result.body)}`);
      assert.equal(typeof result.body.code, "string", label);
      assert.doesNotMatch(JSON.stringify(result.body), /resets_at|"raw"/, label);
    }
    const status = await fx.state();
    assert.equal(status.leases[SESSION].leaseID, lease.leaseID);
    assert.equal(status.leases[SESSION].quotaObservation, undefined);
    assert.deepEqual(status.circuits, {});
    assert.deepEqual(status.apiContinuations, {});
    assert.deepEqual((await fx.status()).budgets, {});
    await fx.ok("/quota-evidence", good);
    const kept = (await fx.state()).leases[SESSION].quotaObservation;
    // Misbound, stale and malformed DIFFERING bodies must not poison the current observation:
    // only an otherwise valid conflict on the exact current binding may tombstone it.
    const different = quota(reset + 1000);
    const poison = [
      ["stale lease", { ...good, leaseID: old.leaseID, subscriptionQuota: different }],
      ["forged lease", { ...good, leaseID: "00000000-0000-4000-8000-000000000000", subscriptionQuota: different }],
      ["wrong target", { ...good, targetID: OTHER_ID, subscriptionQuota: different }],
      ["unknown session", { ...good, sessionID: "ses_NobodyHere9", subscriptionQuota: different }],
      ["extra key", { ...good, subscriptionQuota: different, purpose: "continuation" }],
      ["expired reset", { ...good, subscriptionQuota: quota(Date.now() - 1000) }],
      ["beyond horizon", { ...good, subscriptionQuota: quota(futureReset(6 * 3600_000)) }],
      ["extra quota key", { ...good, subscriptionQuota: quota(reset, { raw: "x" }) }],
      ["generic flag", { ...good, subscriptionQuota: true }],
    ];
    for (const [label, body] of poison) {
      const result = await fx.call("/quota-evidence", body);
      assert.ok(result.status === 400 || result.status === 409, `${label}: ${result.status} ${JSON.stringify(result.body)}`);
      const held = (await fx.state()).leases[SESSION];
      assert.deepEqual(held.quotaObservation, kept, `${label} must not touch the current observation`);
      assert.equal(held.quotaObservationConflict, undefined, `${label} must not tombstone the current lease`);
    }
    // A stale /failure binding cannot consume the current lease's observation either.
    const stale = await fx.call("/failure", failure(old, quotaError(reset)));
    assert.equal(stale.status, 400);
    const after = await fx.state();
    assert.deepEqual(after.leases[SESSION].quotaObservation, kept, "the current observation is untouched");
    assert.deepEqual(after.apiContinuations, {});
    // And the untouched observation still proves at the exact later failure.
    await fx.ok("/failure", failure(lease, quotaError(reset)));
    const proven = (await fx.state()).apiContinuations[SESSION];
    assert.equal(proven.sourceLeaseID, lease.leaseID);
    assert.equal(proven.observedAtMs, kept.observedAtMs);
  });
});

test("quota evidence never refreshes configured plan usage", async (t) => {
  let reads = 0;
  const reader = http.createServer((request, response) => {
    reads += 1;
    assert.equal(request.url, "/usage");
    assert.equal(request.headers["x-api-key"], "private-fixture-reader-key");
    const lockedUntil = futureReset();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      windows: [{ id: "five_hour", percent: 100, resetsAt: new Date(lockedUntil).toISOString(), active: true, severity: null }],
      lockedUntil,
    }));
  });
  await new Promise((resolve) => reader.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => reader.close((error) => error ? reject(error) : resolve())));

  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const old = await fx.lease();
    const lease = await fx.lease();
    await fx.stop();
    const keyPath = join(fx.home, "private-fixture-reader-key");
    writeFileSync(keyPath, "private-fixture-reader-key\n", { mode: 0o600 });
    fx.writeConfig({ ...brokerConfig(ENABLED), budgets: { oauthsrc: {
      windows: [{ id: "fixture", periodMs: 60_000, meter: "requests", capacity: 100 }],
      planUsage: { type: "http", url: `http://127.0.0.1:${reader.address().port}/usage`, keyFile: keyPath },
    } } });
    await fx.start();

    const reset = futureReset();
    for (const body of [
      evidence(lease, quota(reset)),
      { sessionID: SESSION, leaseID: lease.leaseID, targetID: SRC_ID },
      evidence(old, quota(reset)),
      evidence({ ...lease, leaseID: "00000000-0000-4000-0000-000000000000" }, quota(reset)),
    ]) await fx.call("/quota-evidence", body);
    assert.equal(reads, 0, "quota observations must not invoke the configured reader");
    assert.equal(fx.readState().circuits["provider:oauthsrc"], undefined, "quota observations must not apply a plan circuit");

    await fx.call("/lease", { sessionID: SESSION, profile: "auto", tier: "smart", replace: false });
    assert.equal(reads, 1, "an ordinary authorized route refreshes the private reader once");
    assert.equal(fx.readState().circuits["provider:oauthsrc"].kind, "plan-window");
  });
});

test("source model and auth rotation refuse observation and revoke consumption", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const reset = futureReset();
    // Model rotation behind the same target ID.
    let lease = await fx.lease();
    await fx.publish({ targets: { [SRC_ID]: { id: SRC_ID, providerID: "oauthsrc", modelID: "src-model-2", kind: "cloud",
      capacity: null, source: "subscription-oauth", tiers: ["smart", "deep"] } } });
    const rotatedModel = await fx.call("/quota-evidence", evidence(lease, quota(reset)));
    assert.equal(rotatedModel.status, 409, JSON.stringify(rotatedModel.body));
    await fx.publish();

    // Auth rotation after a valid observation: consumption yields no proof.
    lease = await fx.lease();
    await fx.ok("/quota-evidence", evidence(lease, quota(reset)));
    fx.writeAuth({ ...AUTH, oauthsrc: { type: "oauth", rotated: true } });
    const refused = await fx.call("/quota-evidence", evidence(lease, quota(reset)));
    assert.equal(refused.status, 409, "a rotated credential cannot add observations");
    const settled = await fx.ok("/failure", failure(lease, quotaError(reset)));
    assert.equal(settled.kind, "quota");
    const status = await fx.state();
    assert.equal(sourceCircuit(status).kind, "quota");
    assert.deepEqual(status.apiContinuations, {});
  });
});

test("routing policy rotation across restart refuses stale snapshots and prunes stale proof", async () => {
  const fx = createFixture(brokerConfig(ENABLED));
  try {
    await fx.start();
    await fx.publish();
    const reset = futureReset();
    const proofLease = await fx.lease("ses_ProofHolder1");
    await fx.ok("/quota-evidence", evidence(proofLease, quota(reset), "ses_ProofHolder1"));
    await fx.ok("/failure", failure(proofLease, quotaError(reset), "ses_ProofHolder1"));
    assert.ok((await fx.state()).apiContinuations.ses_ProofHolder1);
    await fx.ok("/rearm", { targetID: "provider:oauthsrc" });
    // Re-create a proof and keep a separate live source lease with an observation.
    const proofLease2 = await fx.lease("ses_ProofHolder1");
    await fx.ok("/quota-evidence", evidence(proofLease2, quota(reset), "ses_ProofHolder1"));
    const live = await fx.lease("ses_LiveHolder2");
    await fx.ok("/quota-evidence", evidence(live, quota(reset), "ses_LiveHolder2"));
    await fx.ok("/failure", failure(proofLease2, quotaError(reset), "ses_ProofHolder1"));
    assert.ok((await fx.state()).apiContinuations.ses_ProofHolder1);

    // Same config: the proof survives a restart.
    await fx.restart();
    assert.ok((await fx.state()).apiContinuations.ses_ProofHolder1, "valid proof survives restart");

    // Different routing policy: proof pruned, held snapshot can neither observe nor prove.
    fx.writeConfig(brokerConfig({ ...ENABLED, grantTTLms: 120000 }));
    await fx.restart();
    const status = await fx.state();
    assert.deepEqual(status.apiContinuations, {});
    assert.equal(status.leases.ses_LiveHolder2.leaseID, live.leaseID, "the held lease itself is untouched");
    const refused = await fx.call("/quota-evidence", evidence(live, quota(reset + 1000), "ses_LiveHolder2"));
    assert.equal(refused.status, 409);
  } finally {
    await fx.cleanup();
  }
});

test("restart decoding drops malformed, orphaned, drifted and expired-circuit proof", async () => {
  const fx = createFixture(brokerConfig(ENABLED));
  try {
    await fx.start();
    await fx.publish();
    const reset = futureReset();
    const sessions = ["ses_KeepMe1", "ses_Orphan2", "ses_Idle3"];
    for (const sessionID of sessions) {
      await fx.ok("/rearm", { targetID: "provider:oauthsrc" });
      const lease = await fx.lease(sessionID);
      await fx.ok("/quota-evidence", evidence(lease, quota(reset), sessionID));
      await fx.ok("/failure", failure(lease, quotaError(reset), sessionID));
    }
    // Only the last proof survives: each /rearm above cleared the circuit, revoking the previous.
    const proven = (await fx.state()).apiContinuations;
    assert.deepEqual(Object.keys(proven), ["ses_Idle3"]);
    const valid = proven.ses_Idle3;
    await fx.stop();

    const state = fx.readState();
    // Restore three records bound to the current circuit, plus malformed and non-durable ones.
    state.apiContinuations = {
      ses_KeepMe1: { ...valid },
      ses_Orphan2: { ...valid },
      ses_Idle3: { ...valid },
      ses_Malformed4: { junk: true },
      ses_ExtraKey5: { ...valid, extra: 1 },
      "gw-oneshot-6": { ...valid },
    };
    // Give the malformed and non-durable keys a retained assignment, so only decoding drops them.
    for (const sessionID of ["ses_Malformed4", "ses_ExtraKey5", "gw-oneshot-6"]) {
      state.assignments[sessionID] = { ...state.assignments.ses_KeepMe1, sessionID };
    }
    delete state.assignments.ses_Orphan2;
    state.assignments.ses_Idle3.updatedAt = Date.now() - 5 * 3600_000;
    state.assignments.ses_Idle3.activeAt = Date.now() - 5 * 3600_000;
    fx.writeState(state);
    await fx.start();
    let status = await fx.state();
    assert.deepEqual(Object.keys(status.apiContinuations), ["ses_KeepMe1"],
      "only a well-formed durable record bound to a retained assignment survives");
    assert.equal(status.assignments.ses_Idle3, undefined, "the idle janitor removed that assignment");

    // A LATER re-stamp of the same quota circuit (another session's /failure: same kind and
    // until, newer updatedAt) keeps the proof rather than revoking it.
    await fx.stop();
    const updated = fx.readState();
    updated.circuits["provider:oauthsrc"].updatedAt += 1;
    fx.writeState(updated);
    await fx.start();
    assert.deepEqual(Object.keys((await fx.state()).apiContinuations), ["ses_KeepMe1"]);

    // Pruning deletes only PERMANENTLY invalid records (continuationRecordPermanentlyInvalid).
    // A circuit ending earlier than the record can never cover it again: deleted. A circuit
    // stamped BEFORE the record, or one that lost its known reset, is not current authority (the
    // paid lane refuses) but is not permanent, so the record is kept until it is.
    for (const [label, change, kept] of [
      ["older updatedAt", (circuit) => { circuit.updatedAt = valid.circuitUpdatedAtMs - 1; }, true],
      ["unknown reset", (circuit) => { circuit.resetKnown = false; }, true],
      ["earlier until", (circuit) => { circuit.until = valid.circuitUntilMs - 1000; }, false],
      ["non-quota kind", (circuit) => { circuit.kind = "rate"; }, false],
    ]) {
      await fx.stop();
      const weakened = fx.readState();
      weakened.apiContinuations = { ses_KeepMe1: { ...valid } };
      weakened.circuits["provider:oauthsrc"] = { kind: "quota", until: valid.circuitUntilMs, resetKnown: true, updatedAt: valid.circuitUpdatedAtMs };
      change(weakened.circuits["provider:oauthsrc"]);
      fx.writeState(weakened);
      await fx.start();
      assert.deepEqual((await fx.state()).apiContinuations, kept ? { ses_KeepMe1: valid } : {}, label);
      if (kept) {
        const refused = await fx.call("/lease", { sessionID: "ses_KeepMe1", profile: "auto", tier: "smart", replace: true });
        assert.notEqual(refused.body?.target?.id, "api-sonnet", `${label}: a non-current record never grants paid`);
        assert.equal(fx.readState().leases.ses_KeepMe1?.spendGrant, undefined, label);
      }
    }

    // An expired source circuit revokes it too.
    await fx.stop();
    const expired = fx.readState();
    expired.apiContinuations = { ses_KeepMe1: { ...valid } };
    expired.circuits["provider:oauthsrc"] = { kind: "quota", until: Date.now() - 1, resetKnown: true, updatedAt: valid.circuitUpdatedAtMs };
    fx.writeState(expired);
    await fx.start();
    status = await fx.state();
    assert.equal(sourceCircuit(status), undefined);
    assert.deepEqual(status.apiContinuations, {});
  } finally {
    await fx.cleanup();
  }
});

test("disabled policy, one-shot, manual-profile and non-allowlisted leases never become sources", async () => {
  await withBroker(brokerConfig(undefined), async (fx) => {
    await fx.publish();
    const lease = await fx.lease();
    assert.equal(lease.target.id, SRC_ID);
    assert.equal((await fx.state()).leases[SESSION].apiContinuationSource, undefined);
    const refused = await fx.call("/quota-evidence", evidence(lease, quota(futureReset())));
    assert.equal(refused.status, 409);
    assert.equal((await fx.state()).leases[SESSION].quotaObservation, undefined);
  });
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const reset = futureReset();
    const oneShot = await fx.lease("gw-abc123-xyz", { oneShot: true });
    assert.equal(oneShot.target.id, SRC_ID);
    const manual = await fx.ok("/lease", { sessionID: "ses_ManualOne1", profile: "api-reserve", tier: "smart", replace: true });
    assert.equal(manual.target.id, "api-sonnet");
    const other = await fx.lease("ses_OtherSub1", { tier: "worker" });
    assert.equal(other.target.id, OTHER_ID);
    const status = await fx.state();
    for (const sessionID of ["gw-abc123-xyz", "ses_ManualOne1", "ses_OtherSub1"]) {
      assert.equal(status.leases[sessionID].apiContinuationSource, undefined, sessionID);
    }
    for (const [sessionID, held] of [["gw-abc123-xyz", oneShot], ["ses_ManualOne1", manual], ["ses_OtherSub1", other]]) {
      const result = await fx.call("/quota-evidence", evidence(held, quota(reset), sessionID));
      assert.equal(result.status, 409, sessionID);
    }
    assert.ok(Object.values((await fx.state()).leases).every((held) => held.quotaObservation === undefined));
  });
});
