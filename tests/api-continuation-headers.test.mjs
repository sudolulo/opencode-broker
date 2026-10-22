// chat.headers session/lease binding for a broker-attested PAID route. The plugin sends
// the session, lease and kind headers for the conversation's own paid model only when the route's
// attestation is structurally bound to that exact session, lease, provider and model. Small-model
// and unrelated-provider calls never borrow the conversation's paid lease, ordinary subscription
// behavior is unchanged, and a malformed attestation on a matching paid route fails closed before
// any request leaves. Headers are routing binding, never financial admission: no grant, purpose or
// billing header is ever sent. Synthetic in-process broker replies only; no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const runPlugin = (body) => {
  const home = mkdtempSync(join(tmpdir(), "broker-paid-headers-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const leases = [];
    // The test body installs the broker's /lease reply for the Nth lease.
    globalThis.leaseReply = (lease, n) => ({ leaseID: "lease-" + n, target: { id: "sol", model: { providerID: "openai", id: "gpt-5.6-sol" } }, decision: { policy: "weighted-depletion", reasons: [] } });
    http.request = (options, callback) => {
      const req = new EventEmitter();
      let sent = "";
      req.write = (chunk) => { sent += chunk; };
      req.end = (chunk) => {
        if (chunk) sent += chunk;
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        let reply = { ok: true };
        if (options.path === "/lease") {
          const lease = JSON.parse(sent || "{}");
          leases.push(lease);
          reply = globalThis.leaseReply(lease, leases.length);
        }
        setTimeout(() => {
          callback(response);
          response.emit("data", JSON.stringify(reply));
          response.emit("end");
        }, 0);
      };
      req.destroy = () => {}; req.setTimeout = () => {}; req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" }, anthropic: { type: "oauth" } }) + "\\n");
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai", "anthropic"], all: [{ id: "openai", models: {} }, { id: "anthropic", models: {} }] } }) },
      session: {
        get: async ({ path }) => ({ data: path.id === "ses_Child1" ? { id: "ses_Child1", parentID: "ses_Root1", agent: "sp-implementer" } : { id: path.id, agent: "smart" } }),
        messages: async () => ({ data: [] }),
      },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {});
    const PAID_MODEL = { providerID: "paid-api", id: "paid-sonnet" };
    const grantFor = (sessionID, leaseID, overrides = {}) => ({
      version: 1, grantID: "11111111-1111-4111-8111-111111111111", purpose: "continuation",
      sessionID, leaseID, targetID: "api-sonnet", providerID: "paid-api", modelID: "paid-sonnet",
      profile: "auto", tier: "smart", issuedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 60000,
      policyRevision: "a".repeat(64),
      source: { providerID: "oauthsrc", targetID: "src", leaseID: "source-lease", modelID: "src-model",
        quotaObservedAtMs: Date.now() - 5000, quotaUntilMs: Date.now() + 3600000 },
      ...overrides,
    });
    const paidReply = (attestation) => (lease, n) => ({
      leaseID: "lease-" + n,
      target: { id: "api-sonnet", kind: "cloud", model: PAID_MODEL, ...attestation(lease.sessionID, "lease-" + n) },
      decision: { policy: "api-continuation", reasons: [] },
    });
    const route = async (sessionID, agent = "smart") => {
      await hooks.event({ event: { type: "session.created", properties: { info: sessionID === "ses_Child1" ? { id: sessionID, parentID: "ses_Root1", agent } : { id: sessionID, agent } } } });
      await hooks["chat.message"](
        { sessionID, agent, model: { providerID: "openai", id: "gpt-5.6-sol" } },
        { message: { agent, model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: [{ type: "text", text: "go" }] },
      );
    };
    const headers = async (sessionID, model, agent = "smart") => {
      const output = { headers: {} };
      try {
        await hooks["chat.headers"]({ sessionID, agent, model, message: {} }, output);
      } catch (error) {
        return { thrown: String(error?.message ?? error) };
      }
      return output.headers;
    };
    ${body}
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath, OPENCODE_MODEL_ROUTER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split("\n").at(-1));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("a broker-attested paid route binds only its own exact model to the session and lease", () => {
  const result = runPlugin(`
    globalThis.leaseReply = paidReply((sessionID, leaseID) => ({
      requiresSpendBudget: true, billingClass: "api-continuation", spendGrant: grantFor(sessionID, leaseID),
    }));
    await route("ses_Root1");
    await route("ses_Child1", "sp-implementer");
    console.log(JSON.stringify({
      paid: await headers("ses_Root1", PAID_MODEL),
      child: await headers("ses_Child1", PAID_MODEL, "sp-implementer"),
      smallModel: await headers("ses_Root1", { providerID: "anthropic", id: "claude-haiku-4-5" }, "title"),
      relatedSubscription: await headers("ses_Root1", { providerID: "openai", id: "gpt-5.6-sol" }),
      unrelated: await headers("ses_Root1", { providerID: "llamacpp", id: "qwen3.5-9b" }),
      otherPaidModel: await headers("ses_Root1", { providerID: "paid-api", id: "paid-opus" }),
    }));
  `);
  assert.deepEqual(result.paid, {
    "x-opencode-session-id": "ses_Root1",
    "x-opencode-lease-id": "lease-1",
    "x-opencode-session-kind": "primary",
  });
  assert.deepEqual(result.child, {
    "x-opencode-session-id": "ses_Child1",
    "x-opencode-lease-id": "lease-2",
    "x-opencode-session-kind": "subagent",
  });
  for (const key of ["smallModel", "relatedSubscription", "unrelated", "otherPaidModel"]) {
    assert.deepEqual(result[key], {}, `${key} must not borrow the conversation's paid lease`);
  }
});

test("an expired but broker-issued bound grant keeps exact session/lease headers for the gateway to refuse", () => {
  const result = runPlugin(`
    globalThis.leaseReply = paidReply((sessionID, leaseID) => ({
      requiresSpendBudget: true, billingClass: "manual-api",
      spendGrant: grantFor(sessionID, leaseID, { purpose: "manual", source: null, profile: "api-reserve",
        issuedAtMs: Date.now() - 600000, expiresAtMs: Date.now() - 300000 }),
    }));
    await route("ses_Root1");
    console.log(JSON.stringify(await headers("ses_Root1", PAID_MODEL)));
  `);
  assert.deepEqual(result, {
    "x-opencode-session-id": "ses_Root1",
    "x-opencode-lease-id": "lease-1",
    "x-opencode-session-kind": "primary",
  });
});

test("a malformed paid attestation on the matching paid route fails closed before any request", () => {
  const cases = {
    wrongLease: `requiresSpendBudget: true, billingClass: "api-continuation", spendGrant: grantFor(sessionID, "lease-other")`,
    wrongSession: `requiresSpendBudget: true, billingClass: "api-continuation", spendGrant: grantFor("ses_Other9", leaseID)`,
    wrongModel: `requiresSpendBudget: true, billingClass: "api-continuation", spendGrant: grantFor(sessionID, leaseID, { modelID: "paid-opus" })`,
    wrongProvider: `requiresSpendBudget: true, billingClass: "api-continuation", spendGrant: grantFor(sessionID, leaseID, { providerID: "other-api" })`,
    purposeDrift: `requiresSpendBudget: true, billingClass: "api-continuation", spendGrant: grantFor(sessionID, leaseID, { purpose: "manual", source: null })`,
    missingGrant: `requiresSpendBudget: true, billingClass: "api-continuation"`,
    extraKey: `requiresSpendBudget: true, billingClass: "api-continuation", spendGrant: { ...grantFor(sessionID, leaseID), extra: 1 }`,
    notRequired: `requiresSpendBudget: false, billingClass: "api-continuation", spendGrant: grantFor(sessionID, leaseID)`,
    unknownClass: `requiresSpendBudget: true, billingClass: "subscription", spendGrant: grantFor(sessionID, leaseID)`,
  };
  for (const [label, attestation] of Object.entries(cases)) {
    const result = runPlugin(`
      globalThis.leaseReply = paidReply((sessionID, leaseID) => ({ ${attestation} }));
      await route("ses_Root1");
      console.log(JSON.stringify(await headers("ses_Root1", PAID_MODEL)));
    `);
    assert.equal(typeof result.thrown, "string", `${label}: ${JSON.stringify(result)}`);
    assert.match(result.thrown, /paid route attestation/, label);
  }
});

test("legacy unpinned manual routes and ordinary subscription routes keep their prior headers", () => {
  const result = runPlugin(`
    globalThis.leaseReply = paidReply(() => ({ requiresSpendBudget: true, billingClass: "manual-api" }));
    await route("ses_Root1");
    const legacyPaid = await headers("ses_Root1", PAID_MODEL);
    globalThis.leaseReply = (lease, n) => ({ leaseID: "lease-" + n, target: { id: "sol", model: { providerID: "openai", id: "gpt-5.6-sol" } }, decision: { policy: "weighted-depletion", reasons: [] } });
    await route("ses_Root1");
    console.log(JSON.stringify({
      legacyPaid,
      ordinary: await headers("ses_Root1", { providerID: "openai", id: "gpt-5.6-sol" }),
      ordinarySmall: await headers("ses_Root1", { providerID: "anthropic", id: "claude-haiku-4-5" }, "title"),
    }));
  `);
  assert.deepEqual(result.legacyPaid, {}, "a legacy unpinned manual route keeps its prior (no-header) behavior");
  assert.deepEqual(result.ordinary, {
    "x-opencode-session-id": "ses_Root1",
    "x-opencode-lease-id": "lease-2",
    "x-opencode-session-kind": "primary",
  });
  assert.deepEqual(result.ordinarySmall, {
    "x-opencode-session-id": "ses_Root1",
    "x-opencode-lease-id": "lease-2",
    "x-opencode-session-kind": "primary",
  }, "ordinary subscription small-model behavior is unchanged");
});

// A paid API continuation spends real money on a route the user did not pick. It must be as
// VISIBLE as a strict-fallback degraded route: a warn line in the opencode log and the same
// hud fallback marker, never the healthy-lease path that clears marks. Same marker store the
// strict-fallback branch writes; read back through lib/routing.js in the plugin's own process.
const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
const visibilityProbe = `
  const logs = [];
  client.app = { log: async ({ body }) => { logs.push(body); } };
  const { readFallbackMarker, writeFallbackMarker } = await import(${JSON.stringify(routingUrl)});
  const marker = (id) => { const value = readFallbackMarker(id); return value ? { policy: value.policy, targetID: value.targetID } : null; };
  // The bare test client has no config.providers(), which the plugin warns about once per
  // lease; that harness artifact is not a routing-visibility line.
  const warns = () => logs.filter((entry) => entry.level === "warn" && !/provider catalog/.test(entry.message)).map((entry) => entry.message);
`;

test("a paid API continuation lease warns and leaves a visible marker instead of clearing as healthy", () => {
  const result = runPlugin(`
    ${visibilityProbe}
    // A stale mark from an earlier degraded route: the healthy path would delete it.
    writeFallbackMarker("ses_Root1", { policy: "strict-fallback", targetID: "old-target", reasons: [] });
    globalThis.leaseReply = paidReply((sessionID, leaseID) => ({
      requiresSpendBudget: true, billingClass: "api-continuation", spendGrant: grantFor(sessionID, leaseID),
    }));
    await route("ses_Root1");
    const paid = { marker: marker("ses_Root1"), warns: warns() };
    logs.length = 0;
    globalThis.leaseReply = (lease, n) => ({ leaseID: "lease-" + n, target: { id: "sol", model: { providerID: "openai", id: "gpt-5.6-sol" } }, decision: { policy: "weighted-depletion", reasons: [] } });
    await route("ses_Root1");
    console.log(JSON.stringify({ paid, ordinary: { marker: marker("ses_Root1"), warns: warns() } }));
  `);
  assert.deepEqual(result.paid.marker, { policy: "api-continuation", targetID: "api-sonnet" });
  assert.equal(result.paid.warns.length, 1, JSON.stringify(result.paid.warns));
  assert.match(result.paid.warns[0], /paid API continuation/);
  assert.match(result.paid.warns[0], /api-sonnet/);
  assert.match(result.paid.warns[0], /paid-api\/paid-sonnet/);
  assert.equal(result.ordinary.marker, null, "an ordinary lease still clears the mark");
  assert.deepEqual(result.ordinary.warns, []);
});

test("strict-fallback visibility is unchanged by the paid continuation branch", () => {
  const result = runPlugin(`
    ${visibilityProbe}
    globalThis.leaseReply = (lease, n) => ({ leaseID: "lease-" + n, target: { id: "terra", model: { providerID: "openai", id: "gpt-terra" } }, decision: { policy: "strict-fallback", reasons: ["only-eligible-target"] } });
    await route("ses_Root1");
    console.log(JSON.stringify({ marker: marker("ses_Root1"), warns: warns() }));
  `);
  assert.deepEqual(result.marker, { policy: "strict-fallback", targetID: "terra" });
  assert.equal(result.warns.length, 1, JSON.stringify(result.warns));
  assert.match(result.warns[0], /FALLBACK: leased terra \(openai\/gpt-terra\)/);
  assert.doesNotMatch(result.warns[0], /paid API continuation/);
});
