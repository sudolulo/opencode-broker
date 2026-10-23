// The paid API continuation chain END TO END, with the real broker daemon, the real
// gateway handler and the real spend ledger. Only the upstream providers are mocked (fetchImpl);
// every identity, credential, quota and amount is synthetic.
//
//   source lease (subscription OAuth target)
//   -> session-bound request through the gateway on that lease
//   -> mocked source answers a TYPED subscription-quota 429 (Anthropic unified headers)
//   -> the gateway posts /quota-evidence to the real broker over its unix socket, through the
//      same selectBrokerTransport + createQuotaEvidenceBrokerRequest wiring as
//      gateway/bin/opencode-broker-gateway
//   -> this test, standing in for the router plugin (the sole failure settler), posts the exact
//      /failure, and the broker records the continuation proof
//   -> the next /lease is a paid continuation lease carrying a broker-minted spendGrant
//   -> session-bound request through the gateway with the NEW lease id
//   -> the gateway admits the grant, reserves in the real split ledger from the continuation
//      allocation, sends exactly once, and settles the receipt.
//
// Isolation: each case runs in a private 0700 directory created with mkdtemp directly under the
// OS temp dir (prefix task4b-int-) and removed in finally. The ledger cannot live under
// /tmp/opencode: the ledger's privatePath check refuses any group/other-writable ancestor, and
// /tmp/opencode is 0775. The broker daemon gets that directory as HOME and XDG dirs; the gateway
// reads only its synthetic 0600 key file; the gateway HTTP server and every fetch are loopback;
// the provider fetch is a mock that never touches the network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGatewayHandler } from "../gateway/lib/gateway.js";
import { fundLedger, initializeLedger, inspectStatus } from "../gateway/lib/spend-budget.js";
import { normalizeSpendPolicy } from "../gateway/lib/spend-policy.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const brokerScript = join(repoRoot, "bin/opencode-broker");

const SRC_ID = "subscription-oauthsrc-src-model-standard";
const OTHER_ID = "subscription-othersub-other-model-standard";
const PAID = "api-sonnet";
const PAID_PROVIDER = "paid-api";
const PAID_MODEL = "paid-sonnet";
const SESSION = "ses_IntegrationAlpha1";
const SOURCE_BASE = "https://oauthsrc.invalid/v1";
const PAID_ORIGIN = "https://api.anthropic.com";
const PAID_KEY = "synthetic-task4b-paid-key-not-a-provider-key";
const FRONTDOOR = "synthetic-task4b-frontdoor";
const REGISTERED = { targetID: PAID, providerID: PAID_PROVIDER, modelID: PAID_MODEL };
const DAY = 24 * 3600_000;
// Worst-case hold of the paid request below: maxInputTokens * max input rate + max_tokens * output
// = 100 * 3 + 10 * 5 nanoUSD. The continuation allocation (500) fits exactly one such hold.
const HOLD_NANO = 350n;
const CONTINUATION_NANO = 500n;
const RESERVE_NANO = 200n;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isoSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const futureReset = (offsetMs = 2 * 3600_000) => Math.floor((Date.now() + offsetMs) / 1000) * 1000;
const quota = (resetAtMs) => ({ version: 1, kind: "anthropic-unified", window: "five_hour", resetAtMs });
// The bound-session SDK error the plugin reports for the source failure (broker-test shape).
const quotaError = (resetAtMs) => ({
  name: "APIError",
  statusCode: 429,
  message: `upstream oauthsrc HTTP 429: usage limit reached (5-hour limit; resets at ${new Date(resetAtMs).toISOString()})`,
});

// ---- spend policy and ledger ---------------------------------------------------------------

// Split policy: ceiling 700 nanoUSD = continuation 500 + manual reserve 200. The release window
// (1 h) is closed for the whole run because the funding epoch expires a day out, so a continuation
// hold may never dip into the manual reserve.
const rawPolicy = (ledgerPath, t0, { split = true } = {}) => ({
  ledgerPath,
  policyID: "task4b-integration-v1",
  validUntil: isoSecond(t0 + 2 * DAY),
  ceilingUSD: "0.0000007",
  binding: { providerID: PAID_PROVIDER, origin: PAID_ORIGIN, credentialSHA256: sha256(PAID_KEY) },
  reconcileUsage: false,
  models: { [PAID_MODEL]: { maxInputTokens: 100, maxOutputTokens: 10, ratesNanoUSD: { input: "2", cacheRead: "1", cacheWrite1h: "3", output: "5" } } },
  ...(split ? { allocations: { continuationUSD: "0.0000005", manualReserveUSD: "0.0000002", releaseWindowHours: 1 } } : {}),
});

const ledgerRows = (ledgerPath) => {
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    return { attempts: db.prepare("SELECT * FROM attempts").all(), wallet: db.prepare("SELECT * FROM wallet").get() };
  } finally { db.close(); }
};

// ---- broker daemon fixture (minimum copied from tests/api-continuation-routing.test.mjs) ------

const brokerConfig = (apiContinuation) => ({
  targets: { [PAID]: { providerID: PAID_PROVIDER, modelID: PAID_MODEL, kind: "cloud", context: 100000 } },
  profiles: { "api-reserve": [PAID] },
  manualApiTargets: { [PAID]: ["api-reserve"] },
  tiers: { smart: [], worker: [], deep: [] },
  apiContinuation,
});
const continuationPolicy = (pin, extra = {}) => ({
  enabled: true, sourceProviders: ["oauthsrc"], targets: { [PAID]: ["smart"] }, spendPolicyHashes: { [PAID]: pin }, ...extra,
});
const AUTH = { oauthsrc: { type: "oauth" }, othersub: { type: "oauth" } };
const RESOLVABLE = ["oauthsrc/src-model", "othersub/other-model", `${PAID_PROVIDER}/${PAID_MODEL}`];

const createBroker = (home, config) => {
  const dirs = Object.fromEntries(["config", "data", "state", "cache", "runtime", "routing"].map((name) => {
    const path = join(home, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return [name, path];
  }));
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true, mode: 0o700 });
  const fx = {
    configPath: join(dirs.config, "broker.json"),
    authPath: join(home, ".local/share/opencode/auth.json"),
    statePath: join(dirs.routing, "broker.json"),
    socketPath: join(dirs.routing, "broker.sock"),
    child: null,
  };
  writeFileSync(fx.configPath, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(fx.authPath, JSON.stringify(AUTH), { mode: 0o600 });
  writeFileSync(join(dirs.routing, "resolvable-models.json"), JSON.stringify({ updatedAt: Date.now(), models: RESOLVABLE }));
  const env = {
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
  fx.readState = () => JSON.parse(readFileSync(fx.statePath, "utf8"));
  fx.authRevision = () => {
    const contents = readFileSync(fx.authPath);
    const stat = statSync(fx.authPath);
    return `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(contents).digest("hex")}`;
  };
  fx.call = (path, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
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
  fx.state = async () => { await fx.ok("/status", {}); return fx.readState(); };
  fx.publish = () => fx.ok("/inventory", {
    targets: {
      [SRC_ID]: { id: SRC_ID, providerID: "oauthsrc", modelID: "src-model", kind: "cloud", capacity: null,
        source: "subscription-oauth", tiers: ["smart", "deep"] },
      [OTHER_ID]: { id: OTHER_ID, providerID: "othersub", modelID: "other-model", kind: "cloud", capacity: null,
        source: "subscription-oauth", tiers: ["worker"] },
    },
    providers: {
      oauthsrc: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
      othersub: { authType: "oauth", connected: true, classification: "subscription", models: 1 },
    },
    modelContexts: { "oauthsrc/src-model": 200000, "othersub/other-model": 200000 },
    authRevision: fx.authRevision(),
    configFingerprint: createHash("sha256").update(readFileSync(fx.configPath)).digest("hex"),
  });
  fx.lease = (sessionID = SESSION) => fx.call("/lease", { sessionID, profile: "auto", tier: "smart", replace: true });
  fx.leaseOK = async (sessionID = SESSION) => {
    const result = await fx.lease(sessionID);
    assert.equal(result.status, 200, `/lease ${sessionID}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  fx.verify = (sessionID, leaseID) => fx.call("/lease/verify", { sessionID, leaseID });
  return fx;
};

// ---- gateway ---------------------------------------------------------------------------------

let clientGeneration = 0;
// lib/client.js binds its socket from OPENCODE_MODEL_BROKER_SOCKET at module evaluation, so a
// fresh module instance is evaluated per fixture with the fixture's socket in the environment.
// The transport is then assembled exactly as gateway/bin/opencode-broker-gateway does it; only a
// recording wrapper is added on the outside.
const brokerTransportFor = async (socketPath) => {
  const previous = process.env.OPENCODE_MODEL_BROKER_SOCKET;
  process.env.OPENCODE_MODEL_BROKER_SOCKET = socketPath;
  let client;
  try {
    client = await import(`../lib/client.js?task4b=${++clientGeneration}`);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MODEL_BROKER_SOCKET;
    else process.env.OPENCODE_MODEL_BROKER_SOCKET = previous;
  }
  assert.equal(client.brokerSocketPath(), socketPath, "the client module is bound to this fixture's broker socket");
  const healthRequest = client.createHealthBrokerRequest();
  const quotaEvidenceRequest = client.createQuotaEvidenceBrokerRequest();
  const request = client.selectBrokerTransport({ brokerRequest: client.brokerRequest, healthRequest, quotaEvidenceRequest });
  const calls = [];
  return {
    calls,
    request: async (path, body) => {
      const entry = { path, body, outcome: "pending" };
      calls.push(entry);
      try {
        const value = await request(path, body);
        entry.outcome = "ok";
        entry.value = value;
        return value;
      } catch (error) {
        entry.outcome = "error";
        entry.error = String(error?.message ?? error);
        throw error;
      }
    },
  };
};

const sourceQuota429 = (reset) => new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
  status: 429,
  headers: {
    "content-type": "application/json",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-reset": String(reset / 1000),
  },
});
const paidMessage = (id = "msg_task4b_paid_1") => ({
  id, type: "message", role: "assistant", model: PAID_MODEL, content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5 },
});

const startGateway = async (chain, { policy = "split", now = Date.now } = {}) => {
  const transport = await brokerTransportFor(chain.broker.socketPath);
  const fetches = [];
  const logs = [];
  const spendBudget = policy === "split" ? chain.raw : rawPolicy(chain.ledgerPath, chain.t0, { split: false });
  const handler = createGatewayHandler({
    config: { tier: "smart", profile: "auto", providers: {
      oauthsrc: { baseUrl: SOURCE_BASE, messagesApi: true },
      [PAID_PROVIDER]: { baseUrl: `${PAID_ORIGIN}/v1`, keyFile: chain.keyFile, messagesApi: true, spendBudget },
    } },
    gatewayKey: FRONTDOOR,
    authPath: join(chain.home, "no-gateway-auth.json"),
    now,
    brokerRequest: transport.request,
    logLine: (line) => logs.push(line),
    fetchImpl: async (url, init) => {
      const entry = { url: String(url), init };
      fetches.push(entry);
      if (entry.url.startsWith(SOURCE_BASE)) return chain.sourceReply(entry);
      if (entry.url.startsWith(PAID_ORIGIN)) return chain.paidReply(entry);
      throw new Error(`unexpected upstream ${entry.url}`);
    },
  });
  const server = http.createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    transport, fetches, logs,
    paidFetches: () => fetches.filter(({ url }) => url.startsWith(PAID_ORIGIN)),
    sourceFetches: () => fetches.filter(({ url }) => url.startsWith(SOURCE_BASE)),
    brokerPaths: () => transport.calls.map(({ path }) => path),
    send: async ({ leaseID, model, sessionID = SESSION }) => {
      const response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${FRONTDOOR}`, "content-type": "application/json", "anthropic-version": "2023-06-01",
          "x-opencode-session-id": sessionID, ...(leaseID === undefined ? {} : { "x-opencode-lease-id": leaseID }),
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], max_tokens: 10, stream: false, service_tier: "standard_only" }),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, headers: response.headers, text, json };
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

// ---- the whole chain -------------------------------------------------------------------------

// One private directory holds the broker HOME, the ledger and the synthetic key. The ledger is
// initialized and funded with the real library; the broker's financial pin defaults to the real
// normalized split policy hash for the registered paid identity.
const withChain = async ({ pin, grantTTLms } = {}, run) => {
  const home = mkdtempSync(join(tmpdir(), "task4b-int-"));
  const chain = { home, gateways: [] };
  try {
    assert.equal(statSync(home).mode & 0o777, 0o700, "private fixture directory");
    const ledgerDir = join(home, "ledger");
    mkdirSync(ledgerDir, { mode: 0o700 });
    chain.ledgerPath = join(ledgerDir, "wallet.sqlite");
    chain.keyFile = join(home, "paid-key");
    writeFileSync(chain.keyFile, PAID_KEY, { mode: 0o600 });
    chain.t0 = Date.now();
    chain.raw = rawPolicy(chain.ledgerPath, chain.t0);
    chain.policy = normalizeSpendPolicy(chain.raw, REGISTERED);
    await initializeLedger({ ledgerPath: chain.ledgerPath, policy: chain.policy, now: chain.t0 });
    await fundLedger({ ledgerPath: chain.ledgerPath, policy: chain.policy, now: chain.t0, allocation: {
      amountUSD: "0.0000007", reference: "task4b-synthetic-allocation", confirmedAt: isoSecond(chain.t0 - 60_000),
      expiresAt: isoSecond(chain.t0 + DAY), providerID: PAID_PROVIDER, origin: PAID_ORIGIN,
      credentialFingerprint: sha256(PAID_KEY), exclusivePromotionalAllocation: true,
    } });
    chain.pin = pin ?? chain.policy.policyHash;
    chain.broker = createBroker(home, brokerConfig(continuationPolicy(chain.pin, grantTTLms === undefined ? {} : { grantTTLms })));
    chain.reset = futureReset();
    chain.sourceReply = () => sourceQuota429(chain.reset);
    chain.paidReply = () => new Response(JSON.stringify(paidMessage()), { status: 200, headers: { "content-type": "application/json" } });
    chain.gateway = async (options) => { const gateway = await startGateway(chain, options); chain.gateways.push(gateway); return gateway; };
    await chain.broker.start();
    await chain.broker.publish();
    return await run(chain);
  } finally {
    for (const gateway of chain.gateways) await gateway.close();
    if (chain.broker) await chain.broker.stop();
    rmSync(home, { recursive: true, force: true });
  }
};

// Runs the source half through the gateway: a source lease, one session-bound request answered by
// the mocked source, then the plugin's exact /failure. Returns the source lease and gateway reply.
const sourceTurn = async (chain, gateway, { failure = quotaError(chain.reset) } = {}) => {
  const source = await chain.broker.leaseOK();
  assert.equal(source.target.id, SRC_ID, "the source lease is on the allowlisted subscription target");
  assert.equal(source.target.spendGrant, undefined);
  const reply = await gateway.send({ leaseID: source.leaseID, model: "src-model" });
  const settled = await chain.broker.ok("/failure", { sessionID: SESSION, leaseID: source.leaseID, targetID: SRC_ID, error: failure });
  return { source, reply, settled };
};

// The full positive prefix: source exhausted with a typed quota 429, proof recorded, paid lease.
const exhaustAndLeasePaid = async (chain, gateway) => {
  const { source, reply, settled } = await sourceTurn(chain, gateway);
  assert.equal(reply.status, 502, reply.text);
  assert.equal(settled.kind, "quota");
  const record = (await chain.broker.state()).apiContinuations[SESSION];
  assert.ok(record, "the exact quota failure persisted a source proof");
  const paid = await chain.broker.leaseOK();
  assert.equal(paid.target.id, PAID, JSON.stringify(paid));
  assert.equal(paid.target.billingClass, "api-continuation");
  assert.equal(paid.target.spendGrant.policyRevision, chain.pin);
  return { source, record, paid, grant: paid.target.spendGrant };
};

const assertNoSpend = (chain, gateway, label) => {
  assert.equal(gateway.paidFetches().length, 0, `${label}: zero paid upstream fetches`);
  const { attempts, wallet } = ledgerRows(chain.ledgerPath);
  assert.equal(attempts.length, 0, `${label}: zero ledger reservations`);
  assert.equal(BigInt(wallet.held_nano), 0n);
  assert.equal(BigInt(wallet.spent_nano), 0n);
  assert.equal(BigInt(wallet.available_nano), CONTINUATION_NANO + RESERVE_NANO);
};

const assertSpendRefusal = (reply, code, label) => {
  assert.equal(reply.status, 402, `${label}: ${reply.text}`);
  assert.equal(reply.headers.get("x-should-retry"), "false");
  assert.equal(reply.json?.error?.type, "spend_budget_refusal", label);
  assert.equal(reply.json.error.code, code, label);
  assert.equal(reply.text.includes(PAID_KEY), false, `${label}: never echoes the credential`);
};

const NO_LIVE_LEASE = /session holds no live lease/;

// ---- positive chain --------------------------------------------------------------------------

test("typed source quota 429 -> gateway evidence -> plugin failure -> paid continuation lease -> one paid send settled from the continuation allocation", async (t) => {
  await withChain({}, async (chain) => {
    const gateway = await chain.gateway();

    // Source half.
    const source = await chain.broker.leaseOK();
    assert.equal(source.target.id, SRC_ID);
    assert.deepEqual(source.target.model, { providerID: "oauthsrc", id: "src-model" });
    const sourceReply = await gateway.send({ leaseID: source.leaseID, model: "src-model" });
    assert.equal(sourceReply.status, 502, sourceReply.text);
    assert.match(sourceReply.text, /HTTP 429/);
    assert.equal(gateway.sourceFetches().length, 1, "exactly one source upstream fetch");
    assert.equal(gateway.paidFetches().length, 0);
    const sourceHeaders = new Headers(gateway.sourceFetches()[0].init.headers);
    assert.equal(sourceHeaders.get("x-api-key"), null, "the paid credential never reaches the source");
    // The gateway delivered exactly one observation through the one-shot quota transport, and
    // settled nothing itself: the session-bound lease belongs to the plugin.
    const evidenceCalls = gateway.transport.calls.filter(({ path }) => path === "/quota-evidence");
    assert.equal(evidenceCalls.length, 1);
    assert.deepEqual(evidenceCalls[0].body, { sessionID: SESSION, leaseID: source.leaseID, targetID: SRC_ID, subscriptionQuota: quota(chain.reset) });
    assert.equal(evidenceCalls[0].outcome, "ok", JSON.stringify(evidenceCalls[0]));
    assert.deepEqual(evidenceCalls[0].value, { ok: true, accepted: true });
    assert.equal(gateway.brokerPaths().some((path) => ["/failure", "/usage", "/complete", "/release", "/forget", "/lease"].includes(path)), false,
      `gateway broker paths: ${gateway.brokerPaths().join(",")}`);
    let state = await chain.broker.state();
    assert.deepEqual(state.leases[SESSION].quotaObservation.subscriptionQuota, quota(chain.reset), "the real broker stored the observation");
    assert.deepEqual(state.apiContinuations, {}, "the observation alone grants nothing");

    // The plugin's exact failure settles the source lease and records the proof.
    const settled = await chain.broker.ok("/failure", { sessionID: SESSION, leaseID: source.leaseID, targetID: SRC_ID, error: quotaError(chain.reset) });
    assert.equal(settled.kind, "quota");
    assert.equal(settled.circuitUntil, chain.reset);
    state = await chain.broker.state();
    const record = state.apiContinuations[SESSION];
    assert.equal(record.sourceLeaseID, source.leaseID);
    assert.equal(record.sourceTargetID, SRC_ID);
    assert.equal(record.circuitUntilMs, chain.reset);
    assert.deepEqual(record.quotaEvidenceClosed, quota(chain.reset));

    // The next lease is a paid continuation with a broker-minted grant pinned to the gateway policy.
    const paid = await chain.broker.leaseOK();
    assert.notEqual(paid.leaseID, source.leaseID);
    assert.equal(paid.target.id, PAID);
    assert.deepEqual(paid.target.model, { providerID: PAID_PROVIDER, id: PAID_MODEL });
    assert.equal(paid.target.requiresSpendBudget, true);
    assert.equal(paid.target.billingClass, "api-continuation");
    const grant = paid.target.spendGrant;
    assert.equal(grant.purpose, "continuation");
    assert.equal(grant.sessionID, SESSION);
    assert.equal(grant.leaseID, paid.leaseID);
    assert.equal(grant.targetID, PAID);
    assert.equal(grant.policyRevision, chain.policy.policyHash, "the broker pin is the real normalized gateway policy hash");
    assert.equal(grant.source.leaseID, source.leaseID);

    // Paid half: the gateway admits the grant, reserves, sends once and settles.
    const callsBefore = gateway.transport.calls.length;
    const paidReply = await gateway.send({ leaseID: paid.leaseID, model: PAID_MODEL });
    assert.equal(paidReply.status, 200, paidReply.text);
    assert.equal(paidReply.json.id, "msg_task4b_paid_1");
    const paidFetches = gateway.paidFetches();
    assert.equal(paidFetches.length, 1, "exactly one paid upstream fetch");
    assert.equal(paidFetches[0].url, `${PAID_ORIGIN}/v1/messages`);
    assert.equal(JSON.parse(paidFetches[0].init.body).model, PAID_MODEL);
    assert.equal(new Headers(paidFetches[0].init.headers).get("x-api-key"), PAID_KEY);
    assert.equal(gateway.sourceFetches().length, 1, "no further source fetch");
    const paidBrokerCalls = gateway.transport.calls.slice(callsBefore);
    assert.deepEqual(paidBrokerCalls.map(({ path, body }) => [path, body]), [["/lease/verify", { sessionID: SESSION, leaseID: paid.leaseID, wireModel: PAID_MODEL }]],
      "the paid request only verifies its exact lease; the plugin owns settlement");

    // Ledger: one settled continuation attempt drawn wholly from the continuation allocation.
    const { attempts, wallet } = ledgerRows(chain.ledgerPath);
    assert.equal(attempts.length, 1);
    const [row] = attempts;
    assert.equal(row.state, "SETTLED");
    assert.equal(row.spend_purpose, "continuation");
    assert.equal(row.model, PAID_MODEL);
    assert.equal(row.provider_id, PAID_PROVIDER);
    assert.equal(row.policy_hash, chain.policy.policyHash);
    assert.equal(BigInt(row.reserved_nano), HOLD_NANO);
    assert.equal(BigInt(row.continuation_reserved_nano), HOLD_NANO, "the draw comes from the continuation allocation");
    assert.equal(BigInt(row.manual_reserve_reserved_nano), 0n, "the manual reserve is untouched");
    assert.equal(BigInt(row.retained_nano), HOLD_NANO, "no refund without a receipt contract");
    assert.equal(row.message_id, "msg_task4b_paid_1");
    assert.deepEqual(JSON.parse(row.authorization_json), JSON.parse(JSON.stringify(grant)), "the ledger records the broker grant");
    assert.equal(BigInt(wallet.funded_nano), CONTINUATION_NANO + RESERVE_NANO);
    assert.equal(BigInt(wallet.held_nano), 0n);
    assert.equal(BigInt(wallet.spent_nano), HOLD_NANO);
    assert.equal(BigInt(wallet.available_nano), CONTINUATION_NANO + RESERVE_NANO - HOLD_NANO);
    const status = await inspectStatus({ ledgerPath: chain.ledgerPath, policy: chain.policy, now: Date.now() });
    assert.deepEqual({ ...status.allocations.continuation }, { fundedNano: CONTINUATION_NANO, availableNano: CONTINUATION_NANO - HOLD_NANO, heldNano: 0n, spentNano: HOLD_NANO });
    assert.deepEqual({ ...status.allocations.manualReserve }, { fundedNano: RESERVE_NANO, availableNano: RESERVE_NANO, heldNano: 0n, spentNano: 0n });
    assert.equal(status.continuationMayUseReserve, false);
    assert.equal(status.attemptCounts.SETTLED, 1);

    // Broker: the paid lease is still held and verifies on its exact id only.
    const verified = await chain.broker.verify(SESSION, paid.leaseID);
    assert.equal(verified.status, 200);
    assert.equal(verified.body.held, true);
    assert.deepEqual(verified.body.target.spendGrant, grant);
    const stale = await chain.broker.verify(SESSION, source.leaseID);
    assert.ok(stale.status !== 200 || stale.body.held === false, JSON.stringify(stale.body));
    state = await chain.broker.state();
    assert.equal(state.leases[SESSION].targetID, PAID);
    assert.deepEqual(state.leases[SESSION].spendGrant, grant);
    assert.deepEqual(state.apiContinuations[SESSION], record, "the proof is retained unchanged");
    t.diagnostic(`paid send settled: reserved=${row.reserved_nano} continuation=${row.continuation_reserved_nano} manual=${row.manual_reserve_reserved_nano}`);
  });
});

// ---- negative cases --------------------------------------------------------------------------

test("(1) a request carrying the OLD source lease id after rotation to the paid lease is a no-live-lease 400", async (t) => {
  await withChain({}, async (chain) => {
    const gateway = await chain.gateway();
    const { source, paid } = await exhaustAndLeasePaid(chain, gateway);
    for (const model of [PAID_MODEL, "src-model"]) {
      const callsBefore = gateway.transport.calls.length;
      const reply = await gateway.send({ leaseID: source.leaseID, model });
      assert.equal(reply.status, 400, `${model}: ${reply.text}`);
      assert.match(reply.json.error.message, NO_LIVE_LEASE);
      const verifies = gateway.transport.calls.slice(callsBefore).map(({ path, body }) => [path, body]);
      assert.deepEqual(verifies, [["/lease/verify", { sessionID: SESSION, leaseID: source.leaseID, wireModel: model }], ["/lease/verify", { sessionID: SESSION, wireModel: model }]],
        `${model}: exact verify missed, session-only re-verify cannot adopt the grant-bearing lease`);
      t.diagnostic(`old source lease id, model ${model}: HTTP ${reply.status}`);
    }
    assertNoSpend(chain, gateway, "old source lease id");
    assert.equal(gateway.sourceFetches().length, 1, "no second source fetch either");
    assert.equal((await chain.broker.verify(SESSION, paid.leaseID)).body.held, true, "the paid lease itself is untouched");
  });
});

test("(2a) the gateway clock past the grant's expiry refuses 402 expired before any reservation", async (t) => {
  let shift = 0;
  await withChain({}, async (chain) => {
    const gateway = await chain.gateway({ now: () => Date.now() + shift });
    const { paid, grant } = await exhaustAndLeasePaid(chain, gateway);
    shift = grant.expiresAtMs - Date.now() + 1000;
    const reply = await gateway.send({ leaseID: paid.leaseID, model: PAID_MODEL });
    assertSpendRefusal(reply, "expired", "gateway clock past grant expiry");
    assertNoSpend(chain, gateway, "gateway clock past grant expiry");
    assert.equal((await chain.broker.verify(SESSION, paid.leaseID)).body.held, true, "the broker (real clock) still holds the lease");
    t.diagnostic(`grant expired at gateway: HTTP ${reply.status} ${reply.json.error.code}`);
  });
});

test("(2b) a grant that really expired (grantTTLms 1000) is refused by the broker verify: no-live-lease 400", async (t) => {
  await withChain({ grantTTLms: 1000 }, async (chain) => {
    const gateway = await chain.gateway();
    const { paid, grant } = await exhaustAndLeasePaid(chain, gateway);
    assert.ok(grant.expiresAtMs <= grant.issuedAtMs + 1000);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, grant.expiresAtMs - Date.now()) + 50));
    const reply = await gateway.send({ leaseID: paid.leaseID, model: PAID_MODEL });
    assert.equal(reply.status, 400, reply.text);
    assert.match(reply.json.error.message, NO_LIVE_LEASE);
    assertNoSpend(chain, gateway, "broker-expired grant");
    t.diagnostic(`grant expired at broker: HTTP ${reply.status}`);
  });
});

test("(3) a gateway with an UNPARTITIONED policy for the paid provider refuses 402 invalid_policy", async (t) => {
  await withChain({}, async (chain) => {
    const gateway = await chain.gateway({ policy: "unpartitioned" });
    const { paid } = await exhaustAndLeasePaid(chain, gateway);
    const reply = await gateway.send({ leaseID: paid.leaseID, model: PAID_MODEL });
    assertSpendRefusal(reply, "invalid_policy", "unpartitioned gateway policy");
    assertNoSpend(chain, gateway, "unpartitioned gateway policy");
    t.diagnostic(`unpartitioned policy: HTTP ${reply.status} ${reply.json.error.code}`);
  });
});

test("(4) a broker financial pin that differs from the gateway policyHash refuses 402 binding_mismatch", async (t) => {
  const foreignPin = "c".repeat(64);
  await withChain({ pin: foreignPin }, async (chain) => {
    assert.notEqual(chain.policy.policyHash, foreignPin);
    const gateway = await chain.gateway();
    const { paid, grant } = await exhaustAndLeasePaid(chain, gateway);
    assert.equal(grant.policyRevision, foreignPin);
    const reply = await gateway.send({ leaseID: paid.leaseID, model: PAID_MODEL });
    assertSpendRefusal(reply, "binding_mismatch", "pin mismatch");
    assertNoSpend(chain, gateway, "pin mismatch");
    t.diagnostic(`pin mismatch: HTTP ${reply.status} ${reply.json.error.code}`);
  });
});

test("(5) two concurrent paid requests whose holds fit the continuation allocation once: one sends, one 402 allocation_exhausted, ledger conserved", async (t) => {
  await withChain({}, async (chain) => {
    // The paid upstream holds its reply until the competing request has been answered, so the
    // winner's reservation is live (held, unsettled) while the loser tries to reserve.
    let releaseWinner;
    const loserAnswered = new Promise((resolve) => { releaseWinner = resolve; });
    chain.paidReply = async () => {
      let timer;
      await Promise.race([loserAnswered, new Promise((resolve) => { timer = setTimeout(resolve, 10_000); })]);
      clearTimeout(timer);
      return new Response(JSON.stringify(paidMessage()), { status: 200, headers: { "content-type": "application/json" } });
    };
    const gateway = await chain.gateway();
    const { paid } = await exhaustAndLeasePaid(chain, gateway);
    const first = gateway.send({ leaseID: paid.leaseID, model: PAID_MODEL });
    const second = gateway.send({ leaseID: paid.leaseID, model: PAID_MODEL });
    const settledFirst = first.then((reply) => { if (reply.status !== 200) releaseWinner(); return reply; });
    const settledSecond = second.then((reply) => { if (reply.status !== 200) releaseWinner(); return reply; });
    const replies = await Promise.all([settledFirst, settledSecond]);
    releaseWinner();
    const statuses = replies.map(({ status }) => status).sort();
    assert.deepEqual(statuses, [200, 402], replies.map(({ text }) => text).join(" | "));
    const loser = replies.find(({ status }) => status === 402);
    assertSpendRefusal(loser, "allocation_exhausted", "final-cent loser");
    assert.equal(gateway.paidFetches().length, 1, "exactly one paid send");
    const { attempts, wallet } = ledgerRows(chain.ledgerPath);
    assert.equal(attempts.length, 1, "the loser reserved nothing");
    assert.equal(attempts[0].state, "SETTLED");
    assert.equal(BigInt(attempts[0].continuation_reserved_nano), HOLD_NANO);
    assert.equal(BigInt(attempts[0].manual_reserve_reserved_nano), 0n);
    assert.equal(BigInt(wallet.held_nano), 0n);
    assert.equal(BigInt(wallet.spent_nano), HOLD_NANO);
    assert.equal(BigInt(wallet.available_nano) + BigInt(wallet.held_nano) + BigInt(wallet.spent_nano), BigInt(wallet.funded_nano), "funded = available + held + spent");
    const status = await inspectStatus({ ledgerPath: chain.ledgerPath, policy: chain.policy, now: Date.now() });
    assert.equal(status.allocations.continuation.availableNano, CONTINUATION_NANO - HOLD_NANO);
    assert.equal(status.allocations.manualReserve.availableNano, RESERVE_NANO, "the reserve is never dipped into");
    t.diagnostic(`final cent: statuses ${statuses.join(",")} loser code ${loser.json.error.code}`);
  });
});

// For (6) and (7): the source answered a 429 that carries no typed subscription signal, so the
// gateway sends no observation; whatever the plugin then reports, no proof and no paid lease.
const assertNoContinuation = async (chain, gateway, label, t) => {
  assert.equal(gateway.transport.calls.some(({ path }) => path === "/quota-evidence"), false, `${label}: no quota observation posted`);
  const state = await chain.broker.state();
  assert.deepEqual(state.apiContinuations, {}, `${label}: no proof`);
  const next = await chain.broker.lease();
  assert.notEqual(next.body?.target?.id, PAID, `${label}: next lease is not paid: ${JSON.stringify(next.body)}`);
  assert.equal(next.body?.target?.spendGrant, undefined);
  const after = await chain.broker.state();
  for (const [sessionID, held] of Object.entries(after.leases)) {
    assert.notEqual(held.targetID, PAID, `${label}: ${sessionID} holds the paid target`);
    assert.equal(held.spendGrant, undefined, `${label}: ${sessionID} holds a grant`);
  }
  assertNoSpend(chain, gateway, label);
  t.diagnostic(`${label}: next /lease HTTP ${next.status} code ${next.body?.code ?? "(none)"} target ${next.body?.target?.id ?? "(none)"}`);
  return next;
};

test("(6) a generic (non-quota) source rate-limit 429 yields no proof, and the next lease is not paid", async (t) => {
  await withChain({}, async (chain) => {
    chain.sourceReply = () => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "Number of requests has exceeded your per-minute rate limit" } }), {
      status: 429, headers: { "content-type": "application/json", "retry-after": "30" },
    });
    const gateway = await chain.gateway();
    const { reply, settled } = await sourceTurn(chain, gateway, { failure: {
      name: "APIError", statusCode: 429, message: "upstream oauthsrc HTTP 429: rate limited",
    } });
    assert.equal(reply.status, 502, reply.text);
    assert.notEqual(settled.kind, "quota", `generic rate limit classified as ${settled.kind}`);
    const next = await assertNoContinuation(chain, gateway, "generic rate limit", t);
    t.diagnostic(`generic rate limit: /failure kind ${settled.kind}, next lease HTTP ${next.status}`);
  });
});

test("(7) a quota 429 whose typed headers were stripped yields no proof even when the plugin reports a quota failure", async (t) => {
  await withChain({}, async (chain) => {
    chain.sourceReply = () => new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
      status: 429, headers: { "content-type": "application/json" },
    });
    const gateway = await chain.gateway();
    const { reply, settled } = await sourceTurn(chain, gateway);
    assert.equal(reply.status, 502, reply.text);
    assert.equal(settled.kind, "quota", "the broker still fences the source on the reported quota stop");
    const next = await assertNoContinuation(chain, gateway, "stripped typed headers", t);
    assert.equal(next.status, 400, JSON.stringify(next.body));
    assert.equal(next.body.code, "usage-limit");
  });
});
