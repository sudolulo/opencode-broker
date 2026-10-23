// Broker-owned API continuation ROUTING and grant attestation. A paid continuation
// lease exists only as a late choice inside the refusal branch, only for a durable auto session
// whose current exact source-quota proof is still authority, and only when no ordinary
// route -- including a busy or delayed one -- could still serve. Every paid lease carries a
// broker-minted spendGrant that /lease/verify re-proves against an exact lease ID.
//
// Every case runs the real daemon (bin/opencode-broker serve) in a fresh private HOME with its own
// XDG dirs, config, routing dir and socket. Only PATH is inherited. auth.json holds synthetic
// type-only OAuth entries (no tokens), the catalog is a synthetic resolvable-models.json, no
// budgets are configured, and the local models URL is either a closed loopback port or a private
// loopback fixture server. No provider, gateway, ledger or network traffic happens, and no paid
// generation is ever made: the paid target is static config data only.
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
const PIN2 = "b".repeat(64);
const SRC_ID = "subscription-oauthsrc-src-model-standard";
const OTHER_ID = "subscription-othersub-other-model-standard";
const OTHER_SMART_ID = "subscription-othersub-other-smart-standard";
const PAID = "api-sonnet";
const SESSION = "ses_ContinueAlpha1";
const GRANT_KEYS = ["version", "grantID", "purpose", "sessionID", "leaseID", "targetID", "providerID", "modelID",
  "profile", "tier", "issuedAtMs", "expiresAtMs", "policyRevision", "source"].sort();

const ENABLED = Object.freeze({
  enabled: true,
  sourceProviders: ["oauthsrc"],
  targets: { [PAID]: ["smart"] },
  spendPolicyHashes: { [PAID]: PIN },
});

const brokerConfig = (apiContinuation, extra = {}) => ({
  targets: {
    [PAID]: { providerID: "paid-api", modelID: "paid-sonnet", kind: "cloud", context: 100000 },
    ...(extra.targets ?? {}),
  },
  profiles: { "api-reserve": [PAID], ...(extra.profiles ?? {}) },
  manualApiTargets: { [PAID]: ["api-reserve"] },
  tiers: { smart: [], worker: [], deep: [], ...(extra.tiers ?? {}) },
  ...(apiContinuation === undefined ? {} : { apiContinuation }),
});

const AUTH = { oauthsrc: { type: "oauth" }, othersub: { type: "oauth" } };
const RESOLVABLE = ["oauthsrc/src-model", "othersub/other-model", "othersub/other-smart",
  "paid-api/paid-sonnet", "llamacpp/local-model"];

const createFixture = (config, { localModelsUrl = "http://127.0.0.1:9/v1/models" } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "api-continuation-routing-"));
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
    OPENCODE_BROKER_LOCAL_MODELS_URL: localModelsUrl,
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
  // /status does not publish continuation internals; read the private state file right
  // after a /status round trip (which sweeps and persists it).
  fx.state = async () => { await fx.status(); return fx.readState(); };
  // The revision of ONE provider's auth.json entry (single-key entries serialize canonically).
  fx.entryRevision = (providerID = "oauthsrc") => createHash("sha256")
    .update(JSON.stringify(JSON.parse(readFileSync(fx.authPath, "utf8"))[providerID])).digest("hex");
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
    modelContexts: { "oauthsrc/src-model": 200000, "othersub/other-model": 200000, "othersub/other-smart": 200000 },
    authRevision: fx.authRevision(),
    configFingerprint: createHash("sha256").update(readFileSync(fx.configPath)).digest("hex"),
  });
  fx.lease = (sessionID = SESSION, extra = {}) => fx.call("/lease", { sessionID, profile: "auto", tier: "smart", replace: true, ...extra });
  fx.leaseOK = async (sessionID = SESSION, extra = {}) => {
    const result = await fx.lease(sessionID, extra);
    assert.equal(result.status, 200, `/lease ${sessionID}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  fx.verify = (sessionID, leaseID) => fx.ok("/lease/verify", { sessionID, ...(leaseID === undefined ? {} : { leaseID }) });
  fx.cleanup = async () => {
    await fx.stop();
    rmSync(home, { recursive: true, force: true });
  };
  return fx;
};

const withBroker = async (config, run, options) => {
  const fx = createFixture(config, options);
  try {
    await fx.start();
    return await run(fx);
  } finally {
    await fx.cleanup();
  }
};

const futureReset = (offsetMs = 2 * 3600_000) => Math.floor((Date.now() + offsetMs) / 1000) * 1000;
const quota = (resetAtMs) => ({ version: 1, kind: "anthropic-unified", window: "five_hour", resetAtMs });
const quotaError = (resetAtMs) => ({
  name: "APIError",
  statusCode: 429,
  message: `upstream oauthsrc HTTP 429: usage limit reached (5-hour limit; resets at ${new Date(resetAtMs).toISOString()})`,
});

// The B1 producer, end to end: an actual source lease, the gateway's non-settling observation,
// then the plugin's exact quota /failure. Returns the source lease and the persisted proof.
const exhaustSource = async (fx, sessionID = SESSION, { reset = futureReset(), leaseExtra = {} } = {}) => {
  const lease = await fx.leaseOK(sessionID, leaseExtra);
  assert.equal(lease.target.id, SRC_ID, "the source lease is on the allowlisted subscription target");
  await fx.ok("/quota-evidence", { sessionID, leaseID: lease.leaseID, targetID: lease.target.id, subscriptionQuota: quota(reset) });
  const settled = await fx.ok("/failure", { sessionID, leaseID: lease.leaseID, targetID: lease.target.id, error: quotaError(reset) });
  assert.equal(settled.kind, "quota");
  const record = (await fx.state()).apiContinuations[sessionID];
  assert.ok(record, "the exact quota failure persisted a source proof");
  return { lease, record, reset };
};

const assertPaidContinuation = (lease, { sessionID = SESSION, source, record, tier = "smart", ttlMs = 300000 } = {}) => {
  assert.equal(lease.target.id, PAID);
  assert.deepEqual(lease.target.model, { providerID: "paid-api", id: "paid-sonnet" });
  assert.equal(lease.target.requiresSpendBudget, true);
  assert.equal(lease.target.billingClass, "api-continuation");
  const grant = lease.target.spendGrant;
  assert.deepEqual(Object.keys(grant).sort(), GRANT_KEYS);
  assert.equal(grant.version, 1);
  assert.match(grant.grantID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(grant.purpose, "continuation");
  assert.equal(grant.sessionID, sessionID);
  assert.equal(grant.leaseID, lease.leaseID);
  assert.equal(grant.targetID, PAID);
  assert.equal(grant.providerID, "paid-api");
  assert.equal(grant.modelID, "paid-sonnet");
  assert.equal(grant.profile, "auto");
  assert.equal(grant.tier, tier);
  assert.equal(grant.policyRevision, PIN, "the grant carries the financial pin, not the routing revision");
  assert.notEqual(grant.policyRevision, record.policyRevision);
  assert.deepEqual(grant.source, {
    providerID: "oauthsrc", targetID: SRC_ID, leaseID: source.leaseID, modelID: "src-model",
    quotaObservedAtMs: record.observedAtMs, quotaUntilMs: record.circuitUntilMs,
  });
  assert.ok(grant.expiresAtMs > grant.issuedAtMs);
  assert.ok(grant.expiresAtMs <= grant.issuedAtMs + ttlMs);
  assert.ok(grant.expiresAtMs <= record.circuitUntilMs);
  assert.equal(lease.decision.policy, "api-continuation");
  return grant;
};

test("a paid continuation lease is granted only after exact source exhaustion; caller flags never grant", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const { lease: source, record } = await exhaustSource(fx);

    // A different durable session in the same exhausted lane has NO proof: a usage-limit refusal.
    const flags = { purpose: "continuation", billingClass: "api-continuation", requiresSpendBudget: true,
      spendGrant: { purpose: "continuation" }, apiContinuation: true, subscriptionQuota: quota(futureReset()) };
    for (const extra of [{}, flags]) {
      const refused = await fx.lease("ses_NoProofBeta2", extra);
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.code, "usage-limit");
      assert.equal(refused.body.targetID, SRC_ID);
    }
    let status = await fx.state();
    assert.equal(status.leases.ses_NoProofBeta2, undefined);

    const lease = await fx.leaseOK(SESSION, flags);
    const grant = assertPaidContinuation(lease, { source, record });
    status = await fx.state();
    assert.deepEqual(status.leases[SESSION].spendGrant, grant, "the grant is persisted on the lease");
    assert.equal(status.leases[SESSION].apiContinuationSource, undefined, "a paid lease is never a source");
    assert.equal(status.assignments[SESSION].targetID, PAID);
    assert.equal(status.assignments[SESSION].fallback, true, "a continuation assignment is never a normal pin");
    assert.equal(status.assignments[SESSION].spendGrant, undefined);
    assert.deepEqual(status.apiContinuations[SESSION], record, "the source proof is retained unchanged");

    const verified = await fx.verify(SESSION, lease.leaseID);
    assert.equal(verified.held, true);
    assert.equal(verified.leaseID, lease.leaseID);
    assert.deepEqual(verified.target, {
      id: PAID, kind: "cloud", model: { providerID: "paid-api", id: "paid-sonnet" },
      requiresSpendBudget: true, billingClass: "api-continuation", spendGrant: grant,
    });
    for (const leaseID of [undefined, "", "00000000-0000-4000-8000-000000000000", source.leaseID]) {
      const denied = await fx.call("/lease/verify", { sessionID: SESSION, ...(leaseID === undefined ? {} : { leaseID }) });
      assert.ok(denied.status !== 200 || denied.body.held === false, `verify ${JSON.stringify(leaseID)}: ${JSON.stringify(denied.body)}`);
    }

    // The paid lease can never become a new source, and its own quota failure mints nothing.
    const observation = await fx.call("/quota-evidence", { sessionID: SESSION, leaseID: lease.leaseID, targetID: PAID, subscriptionQuota: quota(futureReset()) });
    assert.equal(observation.status, 409);
    const paidFailure = await fx.ok("/failure", { sessionID: SESSION, leaseID: lease.leaseID, targetID: PAID,
      error: { name: "APIError", statusCode: 429, message: "upstream paid-api HTTP 429: usage limit reached" } });
    assert.equal(paidFailure.kind, "quota");
    status = await fx.state();
    assert.deepEqual(status.apiContinuations[SESSION], record, "a paid quota failure creates no fresh source evidence");
    // No endless paid ladder: the paid target is now fenced too, and the lane refuses.
    const ladder = await fx.lease(SESSION);
    assert.equal(ladder.status, 400, JSON.stringify(ladder.body));
    assert.equal(ladder.body.code, "usage-limit");
  });
});

test("a paid continuation wire-model verify returns its spend attestation and rejects its stomped lease", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const { lease: source, record } = await exhaustSource(fx);
    const paid = await fx.leaseOK();
    const grant = assertPaidContinuation(paid, { source, record });

    const attested = await fx.call("/lease/verify", {
      sessionID: SESSION, leaseID: paid.leaseID, wireModel: "paid-sonnet",
    });
    assert.equal(attested.status, 200, JSON.stringify(attested.body));
    assert.equal(attested.body.held, true);
    assert.deepEqual(attested.body.target.spendGrant, grant,
      "wire-model verification keeps the broker-minted spend attestation");

    await fx.publish({ targets: { [OTHER_SMART_ID]: { id: OTHER_SMART_ID, providerID: "othersub", modelID: "other-smart",
      kind: "cloud", capacity: null, source: "subscription-oauth", tiers: ["smart"] } } });
    const replacement = await fx.leaseOK(SESSION);
    assert.equal(replacement.target.id, OTHER_SMART_ID);
    const stale = await fx.call("/lease/verify", {
      sessionID: SESSION, leaseID: paid.leaseID, wireModel: "paid-sonnet",
    });
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    assert.equal(stale.body.held, false, "a paid lease cannot survive a slot stomp through the ordinary grant cache");
  });
});

test("a pinned manual paid wire-model verify rejects its stomped lease", async () => {
  await withBroker(brokerConfig({ enabled: false, spendPolicyHashes: { [PAID]: PIN } }), async (fx) => {
    await fx.publish();
    const manual = await fx.leaseOK(SESSION, { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    const grant = manual.target.spendGrant;

    const attested = await fx.call("/lease/verify", {
      sessionID: SESSION, leaseID: manual.leaseID, wireModel: "paid-sonnet",
    });
    assert.equal(attested.status, 200, JSON.stringify(attested.body));
    assert.equal(attested.body.held, true);
    assert.deepEqual(attested.body.target.spendGrant, grant,
      "wire-model verification keeps the broker-minted manual spend attestation");

    const replacement = await fx.leaseOK(SESSION);
    assert.equal(replacement.target.id, SRC_ID);
    const stale = await fx.call("/lease/verify", {
      sessionID: SESSION, leaseID: manual.leaseID, wireModel: "paid-sonnet",
    });
    assert.equal(stale.status, 200, JSON.stringify(stale.body));
    assert.equal(stale.body.held, false, "a pinned manual paid lease cannot survive a slot stomp through the ordinary grant cache");
    assert.equal(Object.hasOwn(stale.body.target ?? {}, "spendGrant"), false);
  });
});

test("ordinary cloud routes, local routes and busy waits all win over paid continuation", async () => {
  // A newly eligible ordinary cloud target in the lane wins, for replace:true and replace:false.
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    await exhaustSource(fx);
    const paid = await fx.leaseOK();
    assert.equal(paid.target.id, PAID);
    await fx.publish({ targets: { [OTHER_SMART_ID]: { id: OTHER_SMART_ID, providerID: "othersub", modelID: "other-smart",
      kind: "cloud", capacity: null, source: "subscription-oauth", tiers: ["smart"] } } });
    const held = await fx.leaseOK(SESSION, { replace: false });
    assert.equal(held.target.id, OTHER_SMART_ID, "a held continuation lease is reselected, ordinary first");
    assert.equal(held.target.requiresSpendBudget, undefined);
    assert.equal(held.target.spendGrant, undefined);
    assert.equal((await fx.verify(SESSION, paid.leaseID)).held, false, "the replaced paid lease ID is dead");
    const fresh = await fx.leaseOK(SESSION);
    assert.equal(fresh.target.id, OTHER_SMART_ID);
  });

  // An ordinary cloud provider held back only by its probation concurrency (one live lease) could
  // serve the moment that lease ends: it is a wait, not exhaustion, so paid never overrides it.
  const probation = createFixture(brokerConfig(ENABLED));
  try {
    await probation.start();
    await probation.publish({ targets: { [OTHER_SMART_ID]: { id: OTHER_SMART_ID, providerID: "othersub", modelID: "other-smart",
      kind: "cloud", capacity: null, source: "subscription-oauth", tiers: ["smart"] } } });
    await exhaustSource(probation, SESSION, { leaseExtra: { providers: ["oauthsrc"] } });
    const holder = await probation.leaseOK("ses_ProbationHolder6", { providers: ["othersub"] });
    assert.equal(holder.target.id, OTHER_SMART_ID);
    await probation.stop();
    const state = probation.readState();
    const at = Date.now();
    state.health = { providers: { othersub: { state: "probation", source: "automatic", reasonCode: "fixture", firstAt: at, lastAt: at, evidence: [] } } };
    probation.writeState(state);
    await probation.start();
    assert.equal((await probation.status()).health.providers.othersub.state, "probation");
    const refused = await probation.lease(SESSION);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "no-eligible-target", "a provider waiting on its probation slot beats paid");
    assert.equal((await probation.status()).leases[SESSION], undefined);
    await probation.ok("/release", { sessionID: "ses_ProbationHolder6", leaseID: holder.leaseID });
    assert.equal((await probation.leaseOK(SESSION)).target.id, OTHER_SMART_ID);
  } finally {
    await probation.cleanup();
  }

  // A resident local target wins, a busy one is a wait, and a non-resident one being prepared is
  // a wait: paid never overrides either. Residency is served by a private loopback fixture; the
  // prepare command is the harmless `true`, which exits at once.
  let resident = false;
  const local = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: resident ? [{ id: "local-model" }] : [] }));
  });
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  try {
    const localConfig = brokerConfig(ENABLED, {
      targets: { "local-smart": { providerID: "llamacpp", modelID: "local-model", kind: "local", capacity: 1, context: 65536,
        prepareCommand: ["true"] } },
      tiers: { smart: ["local-smart"] },
    });
    await withBroker(localConfig, async (fx) => {
      await fx.publish();
      await exhaustSource(fx, SESSION, { leaseExtra: { providers: ["oauthsrc"] } });
      const preparing = await fx.lease(SESSION, { contextTokens: 1000 });
      assert.equal(preparing.status, 400, JSON.stringify(preparing.body));
      assert.equal(preparing.body.code, "target-preparing", "a model being prepared is a wait, never paid");
      resident = true;
      const holder = await fx.leaseOK("ses_LocalHolder4", { contextTokens: 1000, localOnly: true });
      assert.equal(holder.target.id, "local-smart");
      const busy = await fx.lease(SESSION, { contextTokens: 1000 });
      assert.equal(busy.status, 400, JSON.stringify(busy.body));
      assert.equal(busy.body.code, "target-busy");
      await fx.ok("/release", { sessionID: "ses_LocalHolder4", leaseID: holder.leaseID });
      const won = await fx.leaseOK(SESSION, { contextTokens: 1000 });
      assert.equal(won.target.id, "local-smart", "an eligible local route wins over paid continuation");
    }, { localModelsUrl: `http://127.0.0.1:${local.address().port}/v1/models` });
  } finally {
    await new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve()));
  }
});

// No lease the broker holds is on the paid target or carries any grant.
const assertNoPaidLease = (state, label) => {
  for (const [sessionID, held] of Object.entries(state.leases)) {
    assert.notEqual(held.targetID, PAID, `${label}: ${sessionID} holds the paid target`);
    assert.equal(held.spendGrant, undefined, `${label}: ${sessionID} holds a grant`);
  }
};

// Request gate: the request-level exclusions below are exercised against a session holding a VALID, CURRENT
// source proof, each changing one request field; the final control turn proves the proof stayed
// valid throughout. Several of them are ALSO refused by an earlier fence (acquire()'s validation,
// the refusal code, or mintSpendGrant's own profile/tier check), so they show the end-to-end
// refusal, not that the lateContinuationRequestEligible wiring alone refuses. The wiring itself is
// isolated through the daemon by the residency test below ("request gate wiring: ...").
test("each single gate refuses paid continuation for a session holding a valid current proof", async () => {
  const fx = createFixture(brokerConfig(ENABLED));
  try {
    await fx.start();
    await fx.publish();
    const { lease: source, record } = await exhaustSource(fx);
    const expectRefusal = async (label, result, { code, error } = {}) => {
      assert.equal(result.status, 400, `${label}: ${JSON.stringify(result.body)}`);
      if (code !== undefined) assert.equal(result.body.code, code, label);
      if (error !== undefined) assert.equal(result.body.error, error, label);
      const state = await fx.state();
      assertNoPaidLease(state, label);
      assert.deepEqual(state.apiContinuations[SESSION], record, `${label}: the proof is still held`);
    };
    // Request-level gates on the proof-holding durable session itself.
    const cases = [
      ["unconfigured tier", { tier: "deep" }, { code: "usage-limit" }],
      ["resolvable models omit the paid model", { resolvableModels: ["oauthsrc/src-model"] }, { code: "usage-limit" }],
      ["provider allowlist omits the paid provider", { providers: ["oauthsrc"] }, { code: "usage-limit" }],
      ["local-only privacy", { localOnly: true }, { code: "no-eligible-local-target" }],
      ["context larger than the paid window", { contextTokens: 150000 }, { code: "usage-limit" }],
      ["caller-excluded paid target", { excludeTargetIDs: [PAID] }, { code: "usage-limit" }],
      // Embeddings and oneShot on a ses_ ID are refused by acquire's own validation before
      // selection: the narrowest real seam for those gates through the daemon.
      ["embeddings api", { api: "embeddings" }, { error: "api: embeddings requires an embedding target" }],
      ["oneShot on a durable id", { oneShot: true }, { error: "oneShot requires a per-request session id (gw- prefix)" }],
      ["manual model profile", { profile: "manual" }, { code: "no-eligible-target" }],
    ];
    for (const [label, extra, expected] of cases) await expectRefusal(label, await fx.lease(SESSION, extra), expected);
    // The named manual profile is the explicit manual path: a manual grant, never continuation.
    const manual = await fx.leaseOK(SESSION, { profile: "api-reserve" });
    assert.equal(manual.target.billingClass, "manual-api");
    assert.equal(manual.target.spendGrant.purpose, "manual");
    assert.equal(manual.target.spendGrant.source, null);
    await fx.ok("/release", { sessionID: SESSION, leaseID: manual.leaseID });

    // Non-durable IDs (gateway one-shot, probe -- probe assignments are only ever minted as
    // gw-probe-* by lib/model-probe.js -- and rig) each get a seeded copy of the valid record,
    // plus a policy avoid on the paid target for the proof holder. These cases do NOT hold a
    // record and do not isolate one gate: a record cannot exist under a non-durable key (the
    // restart prunes the seeded copies, asserted below), so they refuse for having no record at
    // all. The session-ID, oneShot and probe gates themselves -- like the staged model-policy
    // candidate / blocked-generation gates, which have no daemon seam without a full model-policy
    // fixture -- are covered by the lateContinuationRequestEligible truth table
    // (tests/api-continuation.test.mjs), the exact predicate the broker's late block calls.
    const nonDurable = ["gw-abc123-xyz", "gw-probe-abc", "rig-session-1"];
    await fx.stop();
    let state = fx.readState();
    for (const sessionID of nonDurable) {
      state.apiContinuations[sessionID] = { ...record };
      state.assignments[sessionID] = { ...state.assignments[SESSION], sessionID };
    }
    state.policyAvoids = { [SESSION]: { targetIDs: [PAID], providerIDs: [], until: Date.now() + 600_000, reason: "fixture" } };
    fx.writeState(state);
    await fx.start();
    state = await fx.state();
    for (const sessionID of nonDurable) assert.equal(state.apiContinuations[sessionID], undefined, `${sessionID}: a non-durable key never holds proof`);
    assert.deepEqual(state.apiContinuations[SESSION], record, "the durable proof survived the restart");
    for (const sessionID of nonDurable) {
      await expectRefusal(sessionID, await fx.lease(sessionID, sessionID.startsWith("gw-abc") ? { oneShot: true } : {}), { code: "usage-limit" });
    }
    await expectRefusal("policy avoid on the paid target", await fx.lease(SESSION), { code: "usage-limit" });

    // Control: the same session, proof and request with the avoid gone is a paid continuation.
    await fx.stop();
    state = fx.readState();
    delete state.policyAvoids[SESSION];
    fx.writeState(state);
    await fx.start();
    assertPaidContinuation(await fx.leaseOK(SESSION, { contextTokens: 1000 }), { source, record });

    // Disabled policy (pins kept): the proof is revoked and the lane refuses.
    await fx.stop();
    fx.writeConfig(brokerConfig({ ...ENABLED, enabled: false }));
    await fx.start();
    const disabled = await fx.lease(SESSION);
    assert.equal(disabled.status, 400, JSON.stringify(disabled.body));
    assert.equal(disabled.body.code, "usage-limit");
    state = await fx.state();
    assertNoPaidLease(state, "disabled policy");
    assert.deepEqual(state.apiContinuations, {});
  } finally {
    await fx.cleanup();
  }
});

test("grants are TTL- and source-bounded; verify denies omitted, stale, expired and drifted authority", async () => {
  // Short TTL: verify expires, and reacquisition goes back through full selection with a new lease.
  await withBroker(brokerConfig({ ...ENABLED, grantTTLms: 1000 }), async (fx) => {
    await fx.publish();
    const { lease: source, record } = await exhaustSource(fx);
    const lease = await fx.leaseOK();
    const grant = assertPaidContinuation(lease, { source, record, ttlMs: 1000 });
    assert.equal((await fx.verify(SESSION, lease.leaseID)).held, true);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, grant.expiresAtMs - Date.now()) + 50));
    assert.equal((await fx.verify(SESSION, lease.leaseID)).held, false, "an expired grant never verifies");
    const again = await fx.leaseOK(SESSION, { replace: false });
    assert.notEqual(again.leaseID, lease.leaseID, "a paid lease is never held: a fresh selection mints a new lease");
    assert.notEqual(again.target.spendGrant.grantID, grant.grantID);
    assert.equal((await fx.verify(SESSION, lease.leaseID)).held, false);
    assert.equal((await fx.verify(SESSION, again.leaseID)).held, true);
  });

  // A near source reset clips the grant to it. Two minutes out: inside the default 300 s grant
  // TTL (so the clip is to the reset, not the TTL) with ample margin for a slow run.
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const reset = futureReset(120_000);
    const { lease: source, record } = await exhaustSource(fx, SESSION, { reset });
    const lease = await fx.leaseOK();
    const grant = assertPaidContinuation(lease, { source, record });
    assert.equal(grant.expiresAtMs, reset, "the grant never outlives the source quota circuit");
  });

  // Source recovery, auth rotation, stale IDs and the unchanged ordinary same-session verify.
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    await exhaustSource(fx);
    const first = await fx.leaseOK();
    const second = await fx.leaseOK();
    assert.notEqual(first.leaseID, second.leaseID);
    assert.equal((await fx.verify(SESSION, first.leaseID)).held, false, "a stale paid ID never verifies");
    assert.equal((await fx.verify(SESSION, second.leaseID)).held, true);
    await fx.ok("/rearm", { targetID: "provider:oauthsrc" });
    assert.equal((await fx.verify(SESSION, second.leaseID)).held, false, "source recovery revokes the paid lease");
    assert.deepEqual((await fx.state()).apiContinuations, {});
    const ordinary = await fx.leaseOK();
    assert.equal(ordinary.target.id, SRC_ID, "after source recovery the ordinary route returns");
    assert.equal((await fx.verify(SESSION, second.leaseID)).held, false, "the old paid ID cannot reach the ordinary lease");
    const legacy = await fx.verify(SESSION);
    assert.equal(legacy.held, true, "ordinary omitted-ID verify is unchanged");
    assert.equal(legacy.leaseID, ordinary.leaseID);
    assert.equal(legacy.target.requiresSpendBudget, undefined);
    assert.equal(legacy.target.spendGrant, undefined);
  });

  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    await exhaustSource(fx);
    const lease = await fx.leaseOK();
    fx.writeAuth({ ...AUTH, oauthsrc: { type: "oauth", rotated: true } });
    assert.equal((await fx.verify(SESSION, lease.leaseID)).held, false, "source auth rotation revokes the paid lease");
  });

  // Config, pin, target, tier and model drift across restart.
  const drifts = [
    ["routing config", (state, config) => ({ state, config: brokerConfig({ ...ENABLED, grantTTLms: 120000 }) })],
    ["financial pin", (state) => ({ state, config: brokerConfig({ ...ENABLED, spendPolicyHashes: { [PAID]: PIN2 } }) })],
    ["paid model", (state) => ({ state, config: { ...brokerConfig(ENABLED), targets: { [PAID]: { providerID: "paid-api", modelID: "paid-opus", kind: "cloud", context: 100000 } } } })],
    ["lease tier", (state, config) => { state.leases[SESSION].tier = "deep"; return { state, config }; }],
    ["grant tier", (state, config) => { state.leases[SESSION].spendGrant.tier = "deep"; return { state, config }; }],
    ["grant target", (state, config) => { state.leases[SESSION].spendGrant.targetID = "api-other"; return { state, config }; }],
    ["grant source", (state, config) => { state.leases[SESSION].spendGrant.source.quotaObservedAtMs -= 1; return { state, config }; }],
    ["grant lease", (state, config) => { state.leases[SESSION].spendGrant.leaseID = "00000000-0000-4000-8000-000000000000"; return { state, config }; }],
    ["missing grant", (state, config) => { delete state.leases[SESSION].spendGrant; return { state, config }; }],
  ];
  for (const [label, drift] of drifts) {
    const fx = createFixture(brokerConfig(ENABLED));
    try {
      await fx.start();
      await fx.publish();
      await exhaustSource(fx);
      const lease = await fx.leaseOK();
      assert.equal((await fx.verify(SESSION, lease.leaseID)).held, true, label);
      await fx.stop();
      const changed = drift(fx.readState(), brokerConfig(ENABLED));
      fx.writeState(changed.state);
      fx.writeConfig(changed.config);
      await fx.start();
      const result = await fx.call("/lease/verify", { sessionID: SESSION, leaseID: lease.leaseID });
      assert.ok(result.status !== 200 || result.body.held === false, `${label}: ${JSON.stringify(result.body)}`);
    } finally {
      await fx.cleanup();
    }
  }
});

test("manual grants need an exact manual admission and pin; legacy unpinned manual behavior is unchanged", async () => {
  // Pinned while automatic continuation is disabled.
  await withBroker(brokerConfig({ enabled: false, spendPolicyHashes: { [PAID]: PIN }, grantTTLms: 1000 }), async (fx) => {
    const manual = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(manual.target.requiresSpendBudget, true);
    assert.equal(manual.target.billingClass, "manual-api");
    const grant = manual.target.spendGrant;
    assert.deepEqual(Object.keys(grant).sort(), GRANT_KEYS);
    assert.equal(grant.purpose, "manual");
    assert.equal(grant.source, null);
    assert.equal(grant.sessionID, "reserve-session");
    assert.equal(grant.leaseID, manual.leaseID);
    assert.equal(grant.profile, "api-reserve");
    assert.equal(grant.tier, "worker");
    assert.equal(grant.policyRevision, PIN);
    assert.ok(grant.expiresAtMs <= grant.issuedAtMs + 1000);
    const verified = await fx.verify("reserve-session", manual.leaseID);
    assert.equal(verified.held, true);
    assert.deepEqual(verified.target.spendGrant, grant);
    assert.equal((await fx.verify("reserve-session")).held, false, "a grant-bearing lease needs its exact ID");
    // A held manual lease with a current grant is kept as is.
    const held = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"], replace: false });
    assert.equal(held.leaseID, manual.leaseID);
    assert.deepEqual(held.target.spendGrant, grant);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, grant.expiresAtMs - Date.now()) + 50));
    assert.equal((await fx.verify("reserve-session", manual.leaseID)).held, false, "an expired manual grant never verifies");
    const renewed = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"], replace: false });
    assert.notEqual(renewed.leaseID, manual.leaseID, "an expired held grant is reselected and re-minted");
    assert.notEqual(renewed.target.spendGrant.grantID, grant.grantID);
    // Disabled automatic continuation still never yields a continuation grant: the auto lane's
    // source is quota-stopped and the only remaining route is the pinned paid target, yet the
    // lane refuses with usage-limit. (The disabled-policy gate against a session that DID hold a
    // valid proof is exercised in the single-gate test above.)
    await fx.publish();
    const source = await fx.leaseOK(SESSION);
    assert.equal(source.target.id, SRC_ID);
    const reset = futureReset();
    await fx.call("/quota-evidence", { sessionID: SESSION, leaseID: source.leaseID, targetID: SRC_ID, subscriptionQuota: quota(reset) });
    assert.equal((await fx.ok("/failure", { sessionID: SESSION, leaseID: source.leaseID, targetID: SRC_ID, error: quotaError(reset) })).kind, "quota");
    const auto = await fx.lease(SESSION);
    assert.equal(auto.status, 400, JSON.stringify(auto.body));
    assert.equal(auto.body.code, "usage-limit");
    const state = await fx.state();
    assert.deepEqual(state.apiContinuations, {}, "a disabled policy persists no proof");
    assert.equal(state.leases[SESSION]?.spendGrant, undefined);
  });

  // Legacy: no pin, no grant, omitted-ID verify unchanged.
  await withBroker(brokerConfig(undefined), async (fx) => {
    const manual = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(manual.target.billingClass, "manual-api");
    assert.equal(Object.hasOwn(manual.target, "spendGrant"), false);
    const omitted = await fx.verify("reserve-session");
    assert.equal(omitted.held, true);
    assert.deepEqual(omitted.target, { id: PAID, kind: "cloud", model: { providerID: "paid-api", id: "paid-sonnet" },
      requiresSpendBudget: true, billingClass: "manual-api" });
  });

  // A lease minted before a pin was configured fails closed until reselected and minted.
  const fx = createFixture(brokerConfig(undefined));
  try {
    await fx.start();
    const legacy = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    await fx.stop();
    fx.writeConfig(brokerConfig({ enabled: false, spendPolicyHashes: { [PAID]: PIN } }));
    await fx.start();
    assert.equal((await fx.verify("reserve-session", legacy.leaseID)).held, false);
    const minted = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"], replace: false });
    assert.notEqual(minted.leaseID, legacy.leaseID);
    assert.equal(minted.target.spendGrant.purpose, "manual");
  } finally {
    await fx.cleanup();
  }
});

// ---- Source fencing, proof lifetime, redaction and fail-closed config --------------------------

// Per-provider auth fence: the record fences the SOURCE provider's own auth.json entry, not the whole file.
test("an unrelated provider's auth rewrite and a transient auth parse failure keep the proof; the source entry rewrite revokes it", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const { lease: source, record } = await exhaustSource(fx);
    assert.equal(record.sourceAuthRevision, fx.entryRevision("oauthsrc"), "the record fences the source entry");
    assert.notEqual(record.sourceAuthRevision, fx.authRevision(), "never the whole auth file");

    // An UNRELATED provider's entry is rewritten (a routine OAuth refresh elsewhere). Until the
    // router republishes inventory against the new file the record is kept but not current;
    // after the republish the continuation works again on the SAME record.
    fx.writeAuth({ ...AUTH, othersub: { type: "oauth", refreshed: 1 } });
    assert.deepEqual((await fx.state()).apiContinuations[SESSION], record, "an unrelated entry rewrite keeps the proof (stale inventory)");
    await fx.publish();
    assert.deepEqual((await fx.state()).apiContinuations[SESSION], record, "an unrelated entry rewrite keeps the proof");
    const paid = await fx.leaseOK(SESSION);
    assertPaidContinuation(paid, { source, record });
    assert.equal((await fx.verify(SESSION, paid.leaseID)).held, true);

    // A transient parse failure of auth.json: not current for attestation, but never pruned.
    writeFileSync(fx.authPath, "{not json", { mode: 0o600 });
    assert.deepEqual((await fx.state()).apiContinuations[SESSION], record, "an unreadable auth file does not prune");
    assert.equal((await fx.verify(SESSION, paid.leaseID)).held, false, "an unreadable auth file is not current authority");
    assert.deepEqual((await fx.state()).apiContinuations[SESSION], record, "a refused verify does not prune either");
    // Readable again (same source entry) and republished: the held paid lease verifies again.
    fx.writeAuth({ ...AUTH, othersub: { type: "oauth", refreshed: 2 } });
    await fx.publish();
    assert.deepEqual((await fx.state()).apiContinuations[SESSION], record);
    assert.equal((await fx.verify(SESSION, paid.leaseID)).held, true, "authority returns once auth.json is readable");
    assertPaidContinuation(await fx.leaseOK(SESSION), { source, record });

    // The SOURCE provider's own entry is rewritten: the proof is revoked and the lane refuses,
    // with or without a republish.
    fx.writeAuth({ ...AUTH, othersub: { type: "oauth", refreshed: 2 }, oauthsrc: { type: "oauth", rotated: true } });
    assert.equal((await fx.state()).apiContinuations[SESSION], undefined, "the source entry rewrite revokes the proof");
    await fx.publish();
    assert.equal((await fx.state()).apiContinuations[SESSION], undefined);
    const refused = await fx.lease(SESSION);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "usage-limit");
    assertNoPaidLease(await fx.state(), "source entry rotated");
  });
});

// Shared source: several sessions on one source provider each hold a proof; a later re-stamp of the circuit
// by another session's /failure (same or later reset, with or without an observation) keeps them.
test("concurrent sessions on one source provider all keep their proofs as the circuit is re-stamped; a clear revokes all", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    // A near first reset (two minutes: inside the default 300 s grant TTL, with margin for a slow
    // run), so the clip to the record's own end is observable once a later reset extends the
    // shared circuit.
    const reset = futureReset(120_000);
    const later = futureReset(2 * 3600_000);
    const sessions = { a: "ses_ConcurrentA1", b: "ses_ConcurrentB2", c: "ses_ConcurrentC3", d: "ses_NoObservationD4" };
    const leases = {};
    for (const [key, sessionID] of Object.entries(sessions)) {
      leases[key] = await fx.leaseOK(sessionID);
      assert.equal(leases[key].target.id, SRC_ID, key);
    }
    const observe = (key, at) => fx.ok("/quota-evidence", { sessionID: sessions[key], leaseID: leases[key].leaseID, targetID: SRC_ID, subscriptionQuota: quota(at) });
    const fail = (key, at) => fx.ok("/failure", { sessionID: sessions[key], leaseID: leases[key].leaseID, targetID: SRC_ID, error: quotaError(at) });
    await observe("a", reset);
    await observe("b", reset);
    await observe("c", later);
    await fail("a", reset);
    const recordA = (await fx.state()).apiContinuations[sessions.a];
    assert.ok(recordA, "first proof");
    await fail("b", reset);
    let state = await fx.state();
    assert.ok(state.circuits["provider:oauthsrc"].updatedAt >= recordA.circuitUpdatedAtMs);
    assert.deepEqual(state.apiContinuations[sessions.a], recordA, "a same-reset re-stamp keeps the first proof");
    const recordB = state.apiContinuations[sessions.b];
    assert.ok(recordB, "second proof");
    // A session with NO observation reports the same quota stop: no proof of its own, none revoked.
    await fail("d", reset);
    state = await fx.state();
    assert.equal(state.apiContinuations[sessions.d], undefined);
    assert.deepEqual(state.apiContinuations[sessions.a], recordA, "a no-observation re-stamp keeps proof A");
    assert.deepEqual(state.apiContinuations[sessions.b], recordB, "a no-observation re-stamp keeps proof B");
    // A later reset extends the circuit: every earlier proof stays current, still clipped to its own end.
    await fail("c", later);
    state = await fx.state();
    assert.equal(state.circuits["provider:oauthsrc"].until, later);
    assert.ok(state.apiContinuations[sessions.c]);
    assert.deepEqual(state.apiContinuations[sessions.a], recordA);
    assert.deepEqual(state.apiContinuations[sessions.b], recordB);

    const paidA = await fx.leaseOK(sessions.a);
    const grantA = assertPaidContinuation(paidA, { sessionID: sessions.a, source: leases.a, record: recordA });
    assert.equal(recordA.circuitUntilMs, reset);
    assert.equal(grantA.expiresAtMs, recordA.circuitUntilMs, "clipped to the record's own end, not the extended circuit");
    const paidB = await fx.leaseOK(sessions.b);
    const grantB = assertPaidContinuation(paidB, { sessionID: sessions.b, source: leases.b, record: recordB });
    assert.equal(grantB.expiresAtMs, reset);
    const paidC = await fx.leaseOK(sessions.c);
    const grantC = assertPaidContinuation(paidC, { sessionID: sessions.c, source: leases.c, record: state.apiContinuations[sessions.c] });
    assert.ok(grantC.expiresAtMs < later && grantC.expiresAtMs > reset, "the later record's grant is TTL-bound, not reset-bound");
    assert.equal((await fx.verify(sessions.d, leases.d.leaseID)).held, false, "the no-observation session never got a grant");

    await fx.ok("/rearm", { targetID: "provider:oauthsrc" });
    state = await fx.state();
    assert.deepEqual(state.apiContinuations, {}, "clearing the circuit revokes every proof");
    assert.equal((await fx.verify(sessions.a, paidA.leaseID)).held, false);
    assert.equal((await fx.verify(sessions.b, paidB.leaseID)).held, false);
    assert.equal((await fx.verify(sessions.c, paidC.leaseID)).held, false);
  });
});

// Only REAL quota exhaustion and REAL non-residency let paid fire.
test("unknown local residency, a non-quota circuit and a caller exclusion are never treated as exhaustion", async () => {
  const smartLocal = () => brokerConfig(ENABLED, {
    targets: { "local-smart": { providerID: "llamacpp", modelID: "local-model", kind: "local", capacity: 1, context: 65536 } },
    tiers: { smart: ["local-smart"] },
  });
  // (a) The local residency probe fails (closed port): residency is unknown, so no paid.
  await withBroker(smartLocal(), async (fx) => {
    await fx.publish();
    await exhaustSource(fx, SESSION, { leaseExtra: { providers: ["oauthsrc"] } });
    const refused = await fx.lease(SESSION, { contextTokens: 1000 });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assertNoPaidLease(await fx.state(), "local residency unknown");
  });
  // Control: residency KNOWN and the local model genuinely not resident (no prepare) -- paid fires.
  const local = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  try {
    await withBroker(smartLocal(), async (fx) => {
      await fx.publish();
      const { lease: source, record } = await exhaustSource(fx, SESSION, { leaseExtra: { providers: ["oauthsrc"] } });
      assertPaidContinuation(await fx.leaseOK(SESSION, { contextTokens: 1000 }), { source, record });
    }, { localModelsUrl: `http://127.0.0.1:${local.address().port}/v1/models` });
  } finally {
    await new Promise((resolve, reject) => local.close((error) => error ? reject(error) : resolve()));
  }

  const otherSmart = { [OTHER_SMART_ID]: { id: OTHER_SMART_ID, providerID: "othersub", modelID: "other-smart",
    kind: "cloud", capacity: null, source: "subscription-oauth", tiers: ["smart"] } };
  // (b) Another ordinary provider is held only by a short rate circuit, a target auth fence or a
  // provider-health quarantine: none of them is quota exhaustion.
  for (const [label, mutate] of [
    ["provider rate circuit", (state, now) => Object.assign(state.circuits, { "provider:othersub": { kind: "rate", until: now + 120_000, updatedAt: now } })],
    ["target auth fence", (state, now) => Object.assign(state.circuits, { [OTHER_SMART_ID]: { kind: "auth", until: now + 60_000, updatedAt: now } })],
    ["provider health quarantine", (state, now) => {
      state.health = { ...(state.health ?? {}), providers: { ...(state.health?.providers ?? {}), othersub: { state: "quarantined", firstAt: now, lastAt: now } } };
    }],
  ]) {
    const fx = createFixture(brokerConfig(ENABLED));
    try {
      await fx.start();
      await fx.publish({ targets: otherSmart });
      const { record } = await exhaustSource(fx, SESSION, { leaseExtra: { providers: ["oauthsrc"] } });
      await fx.stop();
      const state = fx.readState();
      mutate(state, Date.now());
      fx.writeState(state);
      await fx.start();
      // Fixture check: the fence really holds the ordinary route out of ordinary selection.
      const fenced = await fx.lease("ses_FenceProbe9");
      assert.equal(fenced.status, 400, `${label} fixture: ${JSON.stringify(fenced.body)}`);
      const refused = await fx.lease(SESSION);
      assert.equal(refused.status, 400, `${label}: ${JSON.stringify(refused.body)}`);
      const after = await fx.state();
      assertNoPaidLease(after, label);
      // The proof is still held and current-shaped, so the refusal is the projection's, not a
      // missing or revoked record's.
      assert.deepEqual(after.apiContinuations[SESSION], record, `${label}: the proof is still held`);
    } finally {
      await fx.cleanup();
    }
  }
  // (b2) Another ordinary provider held only by a PLAN-WINDOW usage stop is really exhausted
  // (lib/usage-limit.js activeUsageLimits counts plan-window and quota alike), so the projection
  // must not say it "could open": with the source quota-exhausted, paid fires.
  {
    const fx = createFixture(brokerConfig(ENABLED));
    try {
      await fx.start();
      await fx.publish({ targets: otherSmart });
      const { lease: source, record } = await exhaustSource(fx, SESSION, { leaseExtra: { providers: ["oauthsrc"] } });
      await fx.stop();
      const state = fx.readState();
      const now = Date.now();
      state.circuits["provider:othersub"] = { kind: "plan-window", until: now + 2 * 3600_000, updatedAt: now };
      fx.writeState(state);
      await fx.start();
      const fenced = await fx.lease("ses_FenceProbe9");
      assert.equal(fenced.status, 400, `plan-window fixture: ${JSON.stringify(fenced.body)}`);
      assert.equal(fenced.body.code, "usage-limit", "plan-window fixture is a usage stop");
      assertPaidContinuation(await fx.leaseOK(SESSION), { source, record });
    } finally {
      await fx.cleanup();
    }
  }
  // (c) The caller's own exclusion covers the only ordinary route.
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish({ targets: otherSmart });
    await exhaustSource(fx, SESSION, { leaseExtra: { providers: ["oauthsrc"] } });
    const refused = await fx.lease(SESSION, { excludeTargetIDs: [OTHER_SMART_ID] });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assertNoPaidLease(await fx.state(), "caller exclusion");
    assert.equal((await fx.leaseOK(SESSION)).target.id, OTHER_SMART_ID, "without the exclusion the ordinary route serves");
  });
});

// Redaction: /status publishes no grant, source snapshot, observation, conflict, record or paid lease ID.
test("/status redacts continuation internals and grant-bearing lease IDs", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    const reset = futureReset();
    const ids = { a: SESSION, b: "ses_ObservedB2", c: "ses_ConflictC3" };
    const leases = {};
    for (const [key, sessionID] of Object.entries(ids)) leases[key] = await fx.leaseOK(sessionID);
    for (const key of ["a", "b", "c"]) {
      await fx.ok("/quota-evidence", { sessionID: ids[key], leaseID: leases[key].leaseID, targetID: SRC_ID, subscriptionQuota: quota(reset) });
    }
    const conflict = await fx.call("/quota-evidence", { sessionID: ids.c, leaseID: leases.c.leaseID, targetID: SRC_ID, subscriptionQuota: quota(reset + 1000) });
    assert.equal(conflict.status, 409);
    await fx.ok("/failure", { sessionID: ids.a, leaseID: leases.a.leaseID, targetID: SRC_ID, error: quotaError(reset) });
    const paid = await fx.leaseOK(ids.a);
    assert.equal(paid.target.billingClass, "api-continuation");
    const grant = paid.target.spendGrant;
    const internal = fx.readState();
    assert.ok(internal.leases[ids.b].apiContinuationSource && internal.leases[ids.b].quotaObservation, "fixture: B holds a snapshot and an observation");
    assert.ok(internal.leases[ids.c].quotaObservationConflict, "fixture: C holds a conflict tombstone");
    const record = internal.apiContinuations[ids.a];

    const status = await fx.status();
    const text = JSON.stringify(status);
    for (const key of ["spendGrant", "apiContinuationSource", "quotaObservation", "quotaObservationConflict", "sourceLeaseID", "sourceAuthRevision", "quotaEvidenceClosed"]) {
      assert.ok(!text.includes(`"${key}"`), `/status exposes ${key}`);
    }
    for (const [label, value] of [["grant ID", grant.grantID], ["paid lease ID", paid.leaseID], ["source lease ID", record.sourceLeaseID],
      ["routing revision", record.policyRevision], ["source auth revision", record.sourceAuthRevision], ["financial pin", PIN]]) {
      assert.ok(!text.includes(value), `/status exposes the ${label}`);
    }
    // Structure consumers read is kept: the leases map and its keys, with presence flags.
    assert.deepEqual(Object.keys(status.leases).sort(), Object.keys(internal.leases).sort());
    assert.equal(status.leases[ids.a].targetID, PAID);
    assert.equal(status.leases[ids.a].hasSpendGrant, true);
    assert.equal(status.leases[ids.b].hasApiContinuationSource, true);
    assert.equal(status.leases[ids.b].hasQuotaObservation, true);
    assert.equal(status.leases[ids.c].hasQuotaObservationConflict, true);
    assert.equal(status.leases[ids.b].leaseID, leases.b.leaseID, "an ordinary lease keeps its lease ID");
    assert.deepEqual(status.apiContinuations, { [ids.a]: true });
  });
});

// Invalid-config fail-closed: a PRESENT but invalid apiContinuation block fails every registered manual target closed.
test("an invalid apiContinuation block makes every manual target unleasable and is flagged on /status; absent stays legacy", async () => {
  const fx = createFixture(brokerConfig(undefined));
  try {
    await fx.start();
    const legacy = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(legacy.target.billingClass, "manual-api");
    assert.equal(Object.hasOwn(legacy.target, "spendGrant"), false);
    assert.equal((await fx.status()).apiContinuationConfigError, false);
    await fx.stop();
    fx.writeConfig(brokerConfig({ enabled: "yes", spendPolicyHashes: { [PAID]: PIN } }));
    await fx.start();
    assert.equal((await fx.status()).apiContinuationConfigError, true);
    assert.equal((await fx.verify("reserve-session", legacy.leaseID)).held, false, "a held legacy manual lease no longer verifies");
    const held = await fx.lease("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"], replace: false });
    assert.equal(held.status, 400, `the held legacy manual lease is not reused: ${JSON.stringify(held.body)}`);
    assert.equal(held.body.code, "api-continuation-config-invalid", `held: the static fail-closed code: ${JSON.stringify(held.body)}`);
    const refused = await fx.lease("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "api-continuation-config-invalid", "fresh: the static fail-closed code");
    assert.equal((await fx.verify("reserve-session")).held, false, "no manual lease is held by omitted ID either");
    assertNoPaidLease(await fx.state(), "invalid apiContinuation block");
    // Ordinary, non-manual routing is unaffected by the rejected block.
    await fx.publish();
    const ordinary = await fx.leaseOK(SESSION);
    assert.equal(ordinary.target.id, SRC_ID);
    assert.equal(ordinary.target.requiresSpendBudget, undefined);
    assert.equal((await fx.verify(SESSION, ordinary.leaseID)).held, true);
    // And the absent block again is legacy exactly, flag cleared.
    await fx.stop();
    fx.writeConfig(brokerConfig(undefined));
    await fx.start();
    assert.equal((await fx.status()).apiContinuationConfigError, false);
    const again = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(again.target.billingClass, "manual-api");
  } finally {
    await fx.cleanup();
  }
});

// Key binding: a stored lease whose sessionID is not its own state.leases key never attests.
test("a corrupted stored grant lease whose sessionID differs from its key is never attested or reused", async () => {
  const fx = createFixture(brokerConfig({ enabled: false, spendPolicyHashes: { [PAID]: PIN } }));
  try {
    await fx.start();
    const manual = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    await fx.stop();
    const state = fx.readState();
    state.leases["reserve-session"].sessionID = "other-session";
    state.leases["reserve-session"].spendGrant.sessionID = "other-session";
    fx.writeState(state);
    await fx.start();
    assert.equal((await fx.verify("reserve-session", manual.leaseID)).held, false, "the corrupted lease never verifies under its key");
    const again = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"], replace: false });
    assert.notEqual(again.leaseID, manual.leaseID, "the corrupted lease is not reused");
    assert.equal(again.target.spendGrant.sessionID, "reserve-session");
    assert.equal((await fx.verify("other-session", manual.leaseID)).held, false);
  } finally {
    await fx.cleanup();
  }
});

// Mint failure: a manual grant that cannot be minted changes no broker state (no cursor advance, no lease,
// no assignment). The failure is injected into the REAL daemon through a module loader hook that
// wraps lib/api-continuation.js and makes only purpose:"manual" mints throw.
test("a failed manual grant mint leaves cursors, leases and assignments unchanged", async () => {
  const fx = createFixture(brokerConfig({ enabled: false, spendPolicyHashes: { [PAID]: PIN } }));
  try {
    const realURL = new URL("../lib/api-continuation.js", import.meta.url).href;
    const wrapperPath = join(fx.home, "mint-failure-wrapper.mjs");
    const hooksPath = join(fx.home, "mint-failure-hooks.mjs");
    const registerPath = join(fx.home, "mint-failure-register.mjs");
    writeFileSync(wrapperPath, `export * from ${JSON.stringify(`${realURL}?real`)};
import { mintSpendGrant as realMint } from ${JSON.stringify(`${realURL}?real`)};
export const mintSpendGrant = (args) => {
  if (args?.purpose === "manual") throw new Error("forced manual mint failure");
  return realMint(args);
};
`);
    writeFileSync(hooksPath, `export const resolve = async (specifier, context, next) => {
  const result = await next(specifier, context);
  return result.url === ${JSON.stringify(realURL)} ? { url: ${JSON.stringify(`file://${wrapperPath}`)}, shortCircuit: true } : result;
};
`);
    writeFileSync(registerPath, `import { register } from "node:module";
register(${JSON.stringify(`file://${hooksPath}`)});
`);
    const child = spawn(process.execPath, ["--import", registerPath, brokerScript, "serve"], { cwd: repoRoot, env: fx.env, stdio: ["ignore", "pipe", "pipe"] });
    fx.child = child;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("listening on ")) resolve(); });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
    });
    const before = await fx.state();
    const failed = await fx.lease("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(failed.status, 400, JSON.stringify(failed.body));
    assert.equal(failed.body.error, "forced manual mint failure", "the injected failure is what refused");
    const after = await fx.state();
    assert.deepEqual(after.cursors, before.cursors, "no cursor advanced");
    assert.equal(after.leases["reserve-session"], undefined);
    assert.equal(after.assignments["reserve-session"], undefined);
    // Control: without the injection the same request succeeds and does advance its cursor.
    await fx.stop();
    await fx.start();
    const ok = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(ok.target.spendGrant.purpose, "manual");
    assert.notDeepEqual((await fx.state()).cursors, before.cursors, "a successful lease does advance the cursor");
  } finally {
    await fx.cleanup();
  }
});

// ---- Plan lockout, request gate wiring, lease-ID redaction and preview ------------------------

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

// Plan lockout: a provider plan-usage poll reporting a LATER lockout than the exact quota circuit must not
// re-kind that circuit to plan-window (which revoked every continuation record on the provider).
// The circuit is extended in place, stays quota with a known reset, and the record stays current.
test("a later plan-usage lockout extends the exact quota circuit in place; the record and paid continuation survive", async (t) => {
  let reads = 0;
  let lockedUntil = null;
  const reader = http.createServer((request, response) => {
    reads += 1;
    assert.equal(request.url, "/usage");
    assert.equal(request.headers["x-api-key"], "private-fixture-reader-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      windows: [{ id: "five_hour", percent: 100, resetsAt: new Date(lockedUntil).toISOString(), active: true, severity: null }],
      lockedUntil,
    }));
  });
  await listen(reader);
  t.after(() => close(reader));

  const fx = createFixture(brokerConfig(ENABLED));
  try {
    await fx.start();
    await fx.publish();
    // Four minutes: inside the default 300 s grant TTL, so the grant's clip to the record's own
    // end (not the extended circuit) is observable.
    const reset = futureReset(240_000);
    const { lease: source, record } = await exhaustSource(fx, SESSION, { reset });
    const exact = (await fx.state()).circuits["provider:oauthsrc"];
    assert.deepEqual({ kind: exact.kind, until: exact.until, resetKnown: exact.resetKnown }, { kind: "quota", until: reset, resetKnown: true });

    // Configure the provider's plan-usage reader (no reader existed at the failure, so no poll
    // could run before now); it reports a lockout well after the exact reset.
    await fx.stop();
    const keyPath = join(fx.home, "private-fixture-reader-key");
    writeFileSync(keyPath, "private-fixture-reader-key\n", { mode: 0o600 });
    fx.writeConfig({ ...brokerConfig(ENABLED), budgets: { oauthsrc: {
      windows: [{ id: "fixture", periodMs: 60_000, meter: "requests", capacity: 100 }],
      planUsage: { type: "http", url: `http://127.0.0.1:${reader.address().port}/usage`, keyFile: keyPath },
    } } });
    lockedUntil = futureReset(3 * 3600_000);
    await fx.start();
    await fx.publish();
    assert.equal(reads, 0, "fixture: nothing polled the reader yet");

    // An auto cloud /lease awaits the due plan refresh before selection.
    const paid = await fx.leaseOK(SESSION);
    assert.ok(reads >= 1, "the lease polled the plan-usage reader");
    const state = await fx.state();
    const circuit = state.circuits["provider:oauthsrc"];
    assert.equal(circuit.kind, "quota", "the exact quota circuit is never re-kinded to plan-window");
    assert.equal(circuit.resetKnown, true);
    assert.equal(Object.hasOwn(circuit, "reason"), false);
    assert.equal(circuit.until, lockedUntil, "extended in place to the provider's later lockout");
    assert.ok(circuit.updatedAt >= exact.updatedAt);
    assert.deepEqual(state.apiContinuations[SESSION], record, "the continuation record is not revoked");
    const grant = assertPaidContinuation(paid, { source, record });
    assert.equal(grant.expiresAtMs, record.circuitUntilMs, "still clipped to the record's own end, not the extended circuit");
    assert.equal((await fx.verify(SESSION, paid.leaseID)).held, true);
  } finally {
    await fx.cleanup();
  }
});

// The lateContinuationRequestEligible WIRING isolated through the daemon. One session holds
// one valid current record throughout; the only thing varied is whether the local residency
// probe answered (503 -> residency unknown -> the includesLocal/localResidencyUnknown gate) or
// answered "nothing resident" ([]). Selection, the projection and the mint see the same empty
// residency set either way, so the refusal is the request gate's alone. (oneShot cannot be this
// gate's seam: acquire() refuses oneShot on a ses_ ID before any selection.)
test("request gate wiring: with one valid current record, an unknown local residency alone refuses paid; known non-residency grants it", async () => {
  let residencyKnown = false;
  const local = http.createServer((request, response) => {
    if (!residencyKnown) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
  });
  await listen(local);
  try {
    const config = brokerConfig(ENABLED, {
      targets: { "local-smart": { providerID: "llamacpp", modelID: "local-model", kind: "local", capacity: 1, context: 65536 } },
      tiers: { smart: ["local-smart"] },
    });
    await withBroker(config, async (fx) => {
      await fx.publish();
      const { lease: source, record } = await exhaustSource(fx, SESSION, { leaseExtra: { providers: ["oauthsrc"] } });
      const refused = await fx.lease(SESSION, { contextTokens: 1000 });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(refused.body.code, "usage-limit", "the ordinary refusal stands");
      const state = await fx.state();
      assertNoPaidLease(state, "local residency unknown");
      assert.deepEqual(state.apiContinuations[SESSION], record, "the same record is still held");
      // Control: the same session, record and request; only the probe now answers.
      residencyKnown = true;
      assertPaidContinuation(await fx.leaseOK(SESSION, { contextTokens: 1000 }), { source, record });
    }, { localModelsUrl: `http://127.0.0.1:${local.address().port}/v1/models` });
  } finally {
    await close(local);
  }
});

// Lease-ID redaction, assignment: the assignment keeps the lease ID (it is the /failure and /usage replay binding), but a
// grant-bearing lease's ID is never published, not even after that lease has ended.
test("/status never publishes a released grant-bearing lease ID on its assignment; ordinary assignments keep theirs", async () => {
  await withBroker(brokerConfig(ENABLED), async (fx) => {
    await fx.publish();
    await exhaustSource(fx);
    const paid = await fx.leaseOK(SESSION);
    assert.equal(paid.target.billingClass, "api-continuation");
    const manual = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(manual.target.spendGrant.purpose, "manual");
    const ordinarySession = "ses_OrdinaryGamma3";
    const ordinary = await fx.leaseOK(ordinarySession, { tier: "worker" });
    assert.equal(ordinary.target.id, OTHER_ID);
    for (const [sessionID, lease] of [[SESSION, paid], ["reserve-session", manual], [ordinarySession, ordinary]]) {
      await fx.ok("/release", { sessionID, leaseID: lease.leaseID });
    }
    const status = await fx.status();
    const internal = fx.readState();
    for (const sessionID of [SESSION, "reserve-session", ordinarySession]) {
      assert.equal(internal.leases[sessionID], undefined, `fixture: ${sessionID}'s lease ended`);
    }
    assert.equal(internal.assignments[SESSION].leaseID, paid.leaseID, "fixture: the private assignment keeps its binding");
    assert.equal(internal.assignments["reserve-session"].leaseID, manual.leaseID);

    assert.equal(status.assignments[SESSION].targetID, PAID, "the assignment itself is still published");
    assert.equal(Object.hasOwn(status.assignments[SESSION], "leaseID"), false, "paid continuation lease ID hidden");
    assert.equal(Object.hasOwn(status.assignments["reserve-session"], "leaseID"), false, "manual grant lease ID hidden");
    assert.equal(status.assignments[ordinarySession].leaseID, ordinary.leaseID, "an ordinary assignment keeps its lease ID");
    const text = JSON.stringify(status);
    assert.ok(!text.includes(paid.leaseID), "/status exposes the released paid lease ID");
    assert.ok(!text.includes(manual.leaseID), "/status exposes the released manual grant lease ID");

    // A later ordinary lease for the same session publishes its own ID again.
    const next = await fx.leaseOK("reserve-session", { tier: "worker" });
    assert.equal(next.target.id, OTHER_ID);
    assert.equal((await fx.status()).assignments["reserve-session"].leaseID, next.leaseID);
  });
});

// Lease-ID redaction, turn-effort log: the turn-effort log never records a grant-bearing lease's ID.
test("the turn-effort log omits grant-bearing lease IDs and keeps ordinary ones", async () => {
  const config = { ...brokerConfig(ENABLED), turnEffort: { mode: "shadow", policy: "tier", models: [] } };
  await withBroker(config, async (fx) => {
    await fx.publish();
    const { lease: source } = await exhaustSource(fx);
    const paid = await fx.leaseOK(SESSION);
    assert.equal(paid.target.billingClass, "api-continuation");
    const manual = await fx.leaseOK("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(manual.target.billingClass, "manual-api");
    const rows = readFileSync(join(fx.home, "routing", "turn-effort.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const rowFor = (sessionID, targetID) => rows.filter((row) => row.sessionID === sessionID && row.targetID === targetID);
    const sourceRows = rowFor(SESSION, SRC_ID);
    assert.equal(sourceRows.length, 1, "fixture: the ordinary source lease was logged");
    assert.equal(sourceRows[0].leaseID, source.leaseID, "an ordinary row keeps its lease ID");
    for (const [label, sessionID, lease] of [["paid continuation", SESSION, paid], ["manual grant", "reserve-session", manual]]) {
      const matched = rowFor(sessionID, PAID);
      assert.equal(matched.length, 1, `fixture: the ${label} lease was logged`);
      assert.equal(Object.hasOwn(matched[0], "leaseID"), false, `${label}: no lease ID in the row`);
      assert.equal(matched[0].mode, "shadow");
      assert.ok(!rows.some((row) => JSON.stringify(row).includes(lease.leaseID)), `${label}: the lease ID is nowhere in the log`);
    }
  });
});

// /preview applies the same invalid-config fail-closed rule as /lease.
test("/preview never lists a manual target blocked by an invalid apiContinuation block", async () => {
  const fx = createFixture(brokerConfig(undefined));
  try {
    await fx.start();
    const request = { profile: "api-reserve", tiers: ["worker"] };
    const before = await fx.ok("/preview", request);
    assert.equal(before.preview.worker?.id, PAID, `fixture: the valid config previews the manual target: ${JSON.stringify(before)}`);
    await fx.stop();
    fx.writeConfig(brokerConfig({ enabled: "yes", spendPolicyHashes: { [PAID]: PIN } }));
    await fx.start();
    assert.equal((await fx.status()).apiContinuationConfigError, true);
    const after = await fx.ok("/preview", request);
    assert.equal(after.preview.worker, null, `a blocked manual target is not previewed: ${JSON.stringify(after)}`);
    assert.ok(!JSON.stringify(after.preview).includes(PAID));
    const leased = await fx.lease("reserve-session", { profile: "api-reserve", tier: "worker", providers: ["paid-api"] });
    assert.equal(leased.body.code, "api-continuation-config-invalid", "preview and lease agree");
  } finally {
    await fx.cleanup();
  }
});
