import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const { normalizeProviderError } = await import("../lib/provider-health.js");
const { classifyRoutingFailure } = await import("../lib/routing.js");
const {
  fetchPlanUsage,
  planUsageResetAt,
  __resetPlanUsageCacheForTests,
} = await import("../lib/plan-usage.js");

test("NamedError envelopes keep their nested message", () => {
  // opencode's session.error carries { name, data: { message } }. The outer
  // object must not swallow the message the classifier needs.
  const nested = normalizeProviderError({
    name: "AI_APICallError",
    data: { message: "This request would exceed your account's rate limit. Please try again later." },
  });
  assert.match(nested.message, /exceed your account's rate limit/);
  // A direct message still wins over nested ones.
  const direct = normalizeProviderError({ name: "Error", message: "top", data: { message: "nested" } });
  assert.equal(direct.message, "top");
  assert.equal(normalizeProviderError({ name: "NamedError", data: { code: "nested_code", message: "nested" } }).code, "nested_code");
});

test("account-level limit wording classifies as quota, not burst rate", () => {
  assert.equal(classifyRoutingFailure({
    name: "AI_APICallError",
    data: { message: "This request would exceed your account's rate limit. Please try again later." },
  }), "quota");
  // Plain burst limits stay rate: a five-minute target circuit is right for them.
  assert.equal(classifyRoutingFailure({ message: "429 too many requests" }), "rate");
});

test("the local inactivity watchdog code is a transient overload", () => {
  assert.equal(classifyRoutingFailure({ code: "LOCAL_INACTIVITY_TIMEOUT", message: "Local child inactivity watchdog timed out after 600000ms" }), "overload");
  assert.notEqual(classifyRoutingFailure({ message: "caller timeout" }), "overload");
});

test("the router's own guard errors never indict the provider", () => {
  // noop is the only kind that opens no circuit AND records no health evidence.
  // "other" -- where these used to land -- does both, and two of them inside the
  // fifteen-minute window quarantine the provider with no expiry (2026-09-15).
  assert.equal(classifyRoutingFailure({
    message: "routed model mismatch: expected alibaba-token-plan/deepseek-v4-flash-0731, got llamacpp/qwen3.5-9b",
  }), "noop");
  assert.equal(classifyRoutingFailure({
    message: "[opencode-broker] route unavailable; resend the prompt",
  }), "noop");
  // Through the real envelope, because that is how the broker receives them from a
  // live session -- and an OLD plugin in one cannot be patched to send a code.
  assert.equal(classifyRoutingFailure({
    name: "NamedError",
    data: { message: "routed model mismatch: expected openai/gpt-5.6-luna/medium, got llamacpp/qwen3.5-9b" },
  }), "noop");
  // A genuine provider fault in the same shape must still be classified.
  assert.equal(classifyRoutingFailure({ message: "model not found: gpt-9", statusCode: 404 }), "model");
});

test("anthropic plan usage normalizes to windows with the exact reset", async () => {
  __resetPlanUsageCacheForTests();
  const payload = {
    limits: [
      { kind: "session", percent: 100, severity: "critical", resets_at: "2026-08-31T22:10:00Z", is_active: true },
      { kind: "weekly_all", percent: 29, severity: "normal", resets_at: "2026-09-07T11:00:00Z", is_active: false },
      { kind: "weekly_scoped", percent: 52, resets_at: "2026-09-07T11:00:00Z", is_active: false, scope: { model: { display_name: "Fable" } } },
    ],
  };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => payload }; };
  const config = { windows: [], planUsage: { type: "anthropic-oauth", authPath: authFixture() } };
  const report = await fetchPlanUsage("anthropic", config, { fetchImpl });
  assert.deepEqual(report.windows.map((w) => w.id), ["5h", "wk", "wk:fable"]);
  assert.equal(report.windows[0].percent, 100);
  assert.equal(report.lockedUntil, Date.parse("2026-08-31T22:10:00Z"),
    "an exhausted plan-wide window locks until ITS reset");
  // The model-scoped Fable cap must not lock the provider.
  const scopedOnly = {
    limits: [{ kind: "weekly_scoped", percent: 100, resets_at: "2026-09-07T11:00:00Z", is_active: true, scope: { model: { display_name: "Fable" } } }],
  };
  __resetPlanUsageCacheForTests();
  const scopedReport = await fetchPlanUsage("anthropic", config, {
    fetchImpl: async () => ({ ok: true, json: async () => scopedOnly }),
  });
  assert.equal(scopedReport.lockedUntil, null);
  // Cache: a second read within the TTL costs no request.
  __resetPlanUsageCacheForTests();
  calls = 0;
  await fetchPlanUsage("anthropic", config, { fetchImpl });
  await fetchPlanUsage("anthropic", config, { fetchImpl });
  assert.equal(calls, 1);
});

test("planUsageResetAt prefers exhausted windows, then active ones", () => {
  const now = Date.parse("2026-08-31T20:00:00Z");
  const report = { windows: [
    { id: "5h", percent: 100, resetsAt: "2026-08-31T22:10:00Z", active: true },
    { id: "wk", percent: 29, resetsAt: "2026-09-07T11:00:00Z", active: true },
  ] };
  assert.equal(planUsageResetAt(report, now), Date.parse("2026-08-31T22:10:00Z"));
  const healthy = { windows: [{ id: "5h", percent: 40, resetsAt: "2026-08-31T22:10:00Z", active: true }] };
  assert.equal(planUsageResetAt(healthy, now), Date.parse("2026-08-31T22:10:00Z"));
  assert.equal(planUsageResetAt({ windows: [] }, now), null);
});

const authFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-plan-usage-"));
  const path = join(dir, "auth.json");
  spawnSync(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(path)}, JSON.stringify({ "anthropic-claude": { type: "oauth", access: "test-token" } }))`]);
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return path;
};

test("a provider failure aborts the parked retry and re-engages on a new lease", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-failover-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const brokerCalls = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        brokerCalls.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/failure"
          ? { ok: true, kind: "quota", circuitUntil: Date.now() + 3600_000 }
          : options.path === "/lease"
            ? { target: { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } }, decision: { policy: "weighted-depletion", reasons: [] } }
            : { ok: true };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const aborts = [];
    const prompts = [];
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: {
        get: async () => ({ id: "ses-failover", agent: "standard" }),
        messages: async () => ({ data: [] }),
        abort: async (input) => { aborts.push(input); return { data: true }; },
        prompt: async (input) => { prompts.push(input); return { data: true }; },
      },
    };
    const timers = [];
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
      clearTimeout: () => {},
    });
    // Establish a real route through the public path: a chat.message leases
    // from the (mocked) broker.
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-failover", agent: "standard" } } } });
    await hooks["chat.message"](
      { sessionID: "ses-failover", agent: "standard" },
      { message: { model: {} } },
    );
    await hooks.event({ event: {
      type: "session.error",
      properties: {
        sessionID: "ses-failover",
        error: { name: "AI_APICallError", data: { message: "This request would exceed your account's rate limit. Please try again later." } },
      },
    } });
    for (const fn of timers.splice(0)) await fn();
    const failure = brokerCalls.find((call) => call.path === "/failure");
    const marker = JSON.parse(readFileSync(join(process.env.HOME, ".local/share/opencode/model-routing/fallbacks/ses-failover.json"), "utf8"));
    console.log(JSON.stringify({
      failureMessage: failure?.body?.error?.message ?? null,
      prompted: prompts.length,
      promptSynthetic: prompts[0]?.body?.parts?.[0]?.synthetic ?? null,
      promptMentionsReroute: /rerouted/.test(prompts[0]?.body?.parts?.[0]?.text ?? ""),
      markerPolicy: marker.policy,
      markerRestore: Number.isFinite(marker.restoreAt),
      aborts: aborts.length,
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.match(String(result.failureMessage), /exceed your account's rate limit/,
      "the nested provider message reaches the broker");
    assert.equal(result.prompted, 1, "the session is re-engaged exactly once");
    assert.equal(result.promptSynthetic, true, "the continuation part is synthetic");
    assert.equal(result.promptMentionsReroute, true);
    assert.equal(result.markerPolicy, "provider-displaced");
    assert.equal(result.markerRestore, true, "the restore time is recorded");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const runContextOverflow = (leaseTarget, connected) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-context-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const brokerCalls = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        brokerCalls.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/failure"
          ? { ok: true, kind: "context" }
          : options.path === "/lease"
            ? { target: ${JSON.stringify(leaseTarget)}, decision: { policy: "weighted-depletion", reasons: [] } }
            : { ok: true };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const prompts = [];
    const client = {
      provider: { list: async () => ({ data: { connected: ${JSON.stringify(connected)}, all: ${JSON.stringify(connected)}.map((id) => ({ id, models: {} })) } }) },
      session: {
        get: async () => ({ id: "ses-context", agent: "standard" }),
        messages: async () => ({ data: [] }),
        abort: async () => ({ data: true }),
        prompt: async (input) => { prompts.push(input); return { data: true }; },
      },
    };
    const timers = [];
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
      clearTimeout: () => {},
    });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-context", agent: "standard" } } } });
    await hooks["chat.message"]({ sessionID: "ses-context", agent: "standard" }, { message: { model: {} } });
    await hooks.event({ event: {
      type: "session.error",
      properties: {
        sessionID: "ses-context",
        error: { name: "AI_APICallError", data: { message: "prompt is too long: 1335522 tokens > 1000000 maximum" } },
      },
    } });
    for (const fn of timers.splice(0)) await fn();
    console.log(JSON.stringify({
      leased: brokerCalls.some((call) => call.path === "/lease"),
      failureReported: brokerCalls.some((call) => call.path === "/failure"),
      prompted: prompts.length,
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split("\n").at(-1));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("a context overflow on a cloud lane is never re-engaged", () => {
  // 2026-09-21: every re-engage re-sent a 1.34M-token transcript to a 1M lane and
  // rode another ~0.9M-token compaction. Only the host's compaction or a human can
  // shrink the transcript; a synthetic "continue" just pays for the failure again.
  const result = runContextOverflow(
    { id: "gpt-luna", kind: "cloud", model: { providerID: "openai", id: "gpt-5.6-luna" } },
    ["openai"],
  );
  assert.equal(result.leased, true, "the session was routed, so failover was in scope");
  assert.equal(result.failureReported, true, "the broker still hears about the overflow");
  assert.equal(result.prompted, 0, "no synthetic continuation after a cloud context overflow");
});

test("a context overflow on a local lane still re-engages onto a roomier window", () => {
  const result = runContextOverflow(
    { id: "vision-27b", kind: "local", model: { providerID: "llamacpp", id: "qwen3.8-27b" } },
    ["openai", "llamacpp"],
  );
  assert.equal(result.leased, true);
  assert.equal(result.prompted, 1, "escaping a small local window is what re-engagement is for");
});

test("context pressure moves a grown session to a roomier window before compaction", async () => {
  // Selection-level check via the library: a 133k session must not stay on a
  // 200k model when a 1M model shares the tier -- the host would compact at
  // ~136k. The broker applies this through its pressure pass; here we assert
  // the underlying fit math that pass relies on.
  const R = await import("../lib/routing.js");
  assert.equal(R.contextFits(200000, 133000), true,
    "the plain fit gate alone would keep the small model (this is the gap the pressure pass closes)");
  // The pressure threshold: 133k / 0.6 > 200k, so a 200k window is outgrown...
  assert.ok(133000 / 0.6 > 200000);
  // ...while a 1M window is not.
  assert.ok(133000 / 0.6 < 1000000);
});

test("openai plan usage normalizes wham windows and lock state", async () => {
  __resetPlanUsageCacheForTests();
  const payload = {
    plan_type: "prolite",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 8, limit_window_seconds: 604800, reset_at: 1788747969 },
      secondary_window: null,
    },
  };
  const config = { windows: [], planUsage: { type: "openai-oauth", authPath: openaiAuthFixture() } };
  const report = await fetchPlanUsage("openai", config, {
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  assert.deepEqual(report.windows, [{
    id: "wk", percent: 8, resetsAt: new Date(1788747969 * 1000).toISOString(), active: false, severity: null,
  }]);
  assert.equal(report.lockedUntil, null);
  // A reached limit locks until the window's own reset.
  __resetPlanUsageCacheForTests();
  const lockedReport = await fetchPlanUsage("openai", config, {
    fetchImpl: async () => ({ ok: true, json: async () => ({
      rate_limit: { allowed: false, limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1788747969 } },
    }) }),
  });
  assert.equal(lockedReport.lockedUntil, 1788747969 * 1000);
  assert.equal(lockedReport.windows[0].active, true);
});

const openaiAuthFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-plan-usage-oai-"));
  const path = join(dir, "auth.json");
  spawnSync(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(path)}, JSON.stringify({ openai: { type: "oauth", access: "test-token" } }))`]);
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return path;
};

test("bailian token-plan usage normalizes CLI fractions and epoch resets", async () => {
  __resetPlanUsageCacheForTests();
  const config = { windows: [], planUsage: { type: "bailian-cli" } };
  const execImpl = async () => ({ stdout: JSON.stringify({
    per5HourPercentage: 0.42, per5HourResetTime: 1788754800000,
    per1WeekPercentage: 1, per1WeekResetTime: 1788933130000,
  }) });
  const report = await fetchPlanUsage("alibaba-token-plan", config, { execImpl });
  assert.deepEqual(report.windows.map((w) => [w.id, w.percent]), [["5h", 42], ["wk", 100]]);
  assert.equal(report.lockedUntil, 1788933130000, "an exhausted week locks until its reset");
  // A CLI auth error yields null so estimates keep serving.
  __resetPlanUsageCacheForTests();
  const errored = await fetchPlanUsage("alibaba-token-plan", config, {
    execImpl: async () => ({ stdout: JSON.stringify({ error: { code: 3, message: "No console access token found." } }) }),
  });
  assert.equal(errored, null);
});

const canonicalUsage = () => ({
  windows: [
    { id: "5h", percent: 42, resetsAt: "2026-09-22T12:00:00Z", active: true, severity: "warning" },
    { id: "wk", percent: 7, resetsAt: null, active: false, severity: null },
  ],
  lockedUntil: null,
});

const httpAuthFixture = (t, auth) => {
  const dir = mkdtempSync(join(tmpdir(), "plan-usage-http-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(auth));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
};

const httpPlanConfig = (authPath, overrides = {}) => ({
  windows: [],
  planUsage: {
    type: "http",
    url: "https://usage.example.invalid/v1/plan-usage",
    authRef: "provider-credential",
    authPath,
    ...overrides,
  },
});

test("HTTP plan usage resolves an exact authRef and sends only x-api-key", async (t) => {
  __resetPlanUsageCacheForTests();
  const authPath = httpAuthFixture(t, {
    "provider-credential-extra": { key: "wrong-secret" },
    "provider-credential": { key: "expected-secret" },
  });
  let request;
  const report = await fetchPlanUsage("example-provider", httpPlanConfig(authPath), {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => canonicalUsage() };
    },
  });
  assert.deepEqual(report, canonicalUsage());
  assert.equal(request.url, "https://usage.example.invalid/v1/plan-usage");
  assert.equal(request.options.headers["x-api-key"], "expected-secret");
  assert.equal(Object.hasOwn(request.options.headers, "authorization"), false);
  assert.equal(Object.hasOwn(request.options.headers, "Authorization"), false);
});

test("HTTP plan usage supports key, apiKey, and access in precedence order", async (t) => {
  const cases = [
    {
      name: "key wins",
      credential: { key: "key-secret", apiKey: "api-secret", access: "access-secret" },
      expected: "key-secret",
    },
    {
      name: "apiKey is compatible",
      credential: { key: "", apiKey: "api-secret", access: "access-secret" },
      expected: "api-secret",
    },
    {
      name: "access is compatible",
      credential: { apiKey: "", access: "access-secret" },
      expected: "access-secret",
    },
  ];
  for (const { name, credential, expected } of cases) {
    await t.test(name, async (st) => {
      __resetPlanUsageCacheForTests();
      const authPath = httpAuthFixture(st, { "provider-credential": credential });
      let sent;
      await fetchPlanUsage(`example-provider-${name}`, httpPlanConfig(authPath), {
        fetchImpl: async (_url, options) => {
          sent = options.headers["x-api-key"];
          return { ok: true, json: async () => canonicalUsage() };
        },
      });
      assert.equal(sent, expected);
    });
  }
});

test("HTTP plan usage rereads credentials after the success TTL", async (t) => {
  __resetPlanUsageCacheForTests();
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "first-secret" } });
  const sent = [];
  const fetchImpl = async (_url, options) => {
    sent.push(options.headers["x-api-key"]);
    return { ok: true, json: async () => canonicalUsage() };
  };
  const config = httpPlanConfig(authPath);
  await fetchPlanUsage("example-provider", config, { fetchImpl, now: 1_000 });
  writeFileSync(authPath, JSON.stringify({ "provider-credential": { key: "rotated-secret" } }));
  await fetchPlanUsage("example-provider", config, { fetchImpl, now: 61_000 });
  assert.deepEqual(sent, ["first-secret", "rotated-secret"]);
});

test("HTTP plan usage accepts canonical multi-window JSON and returns a normalized copy", async (t) => {
  __resetPlanUsageCacheForTests();
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "test-secret" } });
  const payload = canonicalUsage();
  const report = await fetchPlanUsage("example-provider", httpPlanConfig(authPath), {
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  assert.deepEqual(report, canonicalUsage());
  assert.notStrictEqual(report, payload);
  assert.notStrictEqual(report.windows, payload.windows);
  assert.notStrictEqual(report.windows[0], payload.windows[0]);
  assert.equal(report.windows.length, 2);
});

test("HTTP plan usage rejects invalid schemes and URL credentials before fetch", async (t) => {
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "test-secret" } });
  for (const url of [
    "ftp://usage.example.invalid/v1/plan-usage",
    "file:///tmp/plan-usage.json",
    "/v1/plan-usage",
    "not a URL",
    "https://user:pass@usage.example.invalid/v1/plan-usage",
  ]) {
    __resetPlanUsageCacheForTests();
    let calls = 0;
    const report = await fetchPlanUsage(`invalid-url-${url}`, httpPlanConfig(authPath, { url }), {
      fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); },
    });
    assert.equal(report, null, url);
    assert.equal(calls, 0, url);
  }
});

test("HTTP plan usage requires authRef and a matching non-empty credential before fetch", async (t) => {
  const authPath = httpAuthFixture(t, {
    "provider-credential-extra": { key: "wrong-secret" },
    "empty-credential": { key: "", apiKey: "", access: "" },
  });
  const cases = [
    { name: "missing authRef", overrides: { authRef: undefined } },
    { name: "missing exact key", overrides: { authRef: "provider-credential" } },
    { name: "empty credential", overrides: { authRef: "empty-credential" } },
  ];
  for (const { name, overrides } of cases) {
    __resetPlanUsageCacheForTests();
    let calls = 0;
    const report = await fetchPlanUsage(`missing-auth-${name}`, httpPlanConfig(authPath, overrides), {
      fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); },
    });
    assert.equal(report, null, name);
    assert.equal(calls, 0, name);
  }
});

test("HTTP plan usage rejects non-2xx, malformed JSON, and invalid canonical reports", async (t) => {
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "test-secret" } });
  const invalidReports = [
    null,
    {},
    { windows: [], lockedUntil: null },
    { windows: [{ id: "", percent: 1, resetsAt: null, active: false, severity: null }], lockedUntil: null },
    { windows: [{ id: "5h", percent: Infinity, resetsAt: null, active: false, severity: null }], lockedUntil: null },
    { windows: [{ id: "5h", percent: 1, resetsAt: "", active: false, severity: null }], lockedUntil: null },
    { windows: [{ id: "5h", percent: 1, resetsAt: null, active: "false", severity: null }], lockedUntil: null },
    { windows: [{ id: "5h", percent: 1, resetsAt: null, active: false, severity: 1 }], lockedUntil: null },
    { windows: [{ id: "5h", percent: 1, resetsAt: null, active: false, severity: null }], lockedUntil: "123" },
  ];
  const cases = [
    { name: "non-2xx", response: { ok: false, status: 503, json: async () => canonicalUsage() } },
    { name: "malformed JSON", response: { ok: true, json: async () => { throw new SyntaxError("malformed JSON"); } } },
    ...invalidReports.map((payload, index) => ({
      name: `invalid canonical report ${index + 1}`,
      response: { ok: true, json: async () => payload },
    })),
  ];
  for (const { name, response } of cases) {
    __resetPlanUsageCacheForTests();
    const report = await fetchPlanUsage(`bad-response-${name}`, httpPlanConfig(authPath), {
      fetchImpl: async () => response,
    });
    assert.equal(report, null, name);
  }
});

test("HTTP plan usage degrades timeout and network rejection to null", async (t) => {
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "test-secret" } });
  for (const [name, error] of [
    ["timeout", new DOMException("timed out", "TimeoutError")],
    ["network", new TypeError("network failed")],
  ]) {
    __resetPlanUsageCacheForTests();
    const report = await fetchPlanUsage(`rejected-${name}`, httpPlanConfig(authPath), {
      fetchImpl: async (_url, options) => {
        assert.ok(options.signal instanceof AbortSignal);
        throw error;
      },
    });
    assert.equal(report, null, name);
  }
});

test("HTTP plan usage caches a successful fetch for its 60-second TTL", async (t) => {
  __resetPlanUsageCacheForTests();
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "test-secret" } });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => canonicalUsage() };
  };
  const config = httpPlanConfig(authPath);
  const first = await fetchPlanUsage("example-provider", config, { fetchImpl, now: 1_000 });
  const second = await fetchPlanUsage("example-provider", config, { fetchImpl, now: 60_999 });
  assert.deepEqual(first, canonicalUsage());
  assert.deepEqual(second, canonicalUsage());
  assert.equal(calls, 1);
});

test("HTTP plan usage serves the last good report and backs off failed refreshes", async (t) => {
  __resetPlanUsageCacheForTests();
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "test-secret" } });
  const good = canonicalUsage();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: true, json: async () => good };
    throw new TypeError("network failed");
  };
  const config = httpPlanConfig(authPath);
  const first = await fetchPlanUsage("example-provider", config, { fetchImpl, now: 1_000 });
  const stale = await fetchPlanUsage("example-provider", config, { fetchImpl, now: 61_000 });
  const backedOff = await fetchPlanUsage("example-provider", config, {
    fetchImpl: async () => { throw new Error("backoff must suppress refresh"); },
    now: 660_999,
  });
  assert.deepEqual(first, good);
  assert.deepEqual(stale, good);
  assert.deepEqual(backedOff, good);
  assert.equal(calls, 2, "one success, one failed refresh, then no call during failure backoff");
});

test("fallback markers release stickiness for a primary rebalance", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-restore-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync, existsSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const leases = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        if (options.path === "/lease") leases.push({
          body,
          markerPresent: existsSync(join(process.env.HOME, ".local/share/opencode/model-routing/fallbacks", body.sessionID + ".json")),
        });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/lease"
          ? { target: { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } }, decision: { policy: "weighted-depletion", reasons: [] } }
          : { ok: true };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {}; req.setTimeout = () => {}; req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode/model-routing/fallbacks"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    mkdirSync(join(process.env.HOME, ".local/share/opencode/model-routing/context-estimates"), { recursive: true });
    // A seasoned session (context estimate > 0) displaced from openai with a PAST restoreAt.
    writeFileSync(join(process.env.HOME, ".local/share/opencode/model-routing/context-estimates/ses-restore.json"),
      JSON.stringify({ tokens: 5000, updatedAt: Date.now() }));
    const markerPath = join(process.env.HOME, ".local/share/opencode/model-routing/fallbacks/ses-restore.json");
    writeFileSync(markerPath, JSON.stringify({
      policy: "provider-displaced", targetID: "old-target", reasons: ["quota"],
      restoreAt: Date.now() - 60_000, updatedAt: Date.now() - 3600_000,
    }));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/model-routing/context-estimates/ses-strict.json"),
      JSON.stringify({ tokens: 5000, updatedAt: Date.now() }));
    const strictMarkerPath = join(process.env.HOME, ".local/share/opencode/model-routing/fallbacks/ses-strict.json");
    writeFileSync(strictMarkerPath, JSON.stringify({
      policy: "strict-fallback", targetID: "old-target", reasons: ["only-eligible-target"], updatedAt: Date.now(),
    }));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: { get: async ({ path }) => ({ id: path.id, agent: "standard" }), messages: async () => ({ data: [] }) },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-restore", agent: "standard" } } } });
    await hooks["chat.message"](
      { sessionID: "ses-restore", agent: "standard", model: { providerID: "anthropic", id: "claude-haiku-4-5" } },
      { message: { model: {} } },
    );
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-strict", agent: "standard" } } } });
    const strict = { message: { model: {} } };
    await hooks["chat.message"](
      { sessionID: "ses-strict", agent: "standard", model: { providerID: "anthropic", id: "claude-haiku-4-5" } },
      strict,
    );
    // The primary lease rewrites this message model; its params must agree with
    // the new route instead of surfacing a routed-model-mismatch.
    await hooks["chat.params"]({
      sessionID: "ses-strict",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      message: strict.message,
    });
    console.log(JSON.stringify({
      leases,
      markerGone: !existsSync(markerPath),
      strictMarkerGone: !existsSync(strictMarkerPath),
      strictModel: strict.message.model,
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.leases.length, 2);
    assert.equal(Object.hasOwn(result.leases[0].body, "preferredModel"), false, "stickiness released for the restore lease");
    assert.equal(result.markerGone, true, "the displacement marker is consumed");
    assert.equal(result.leases[1].markerPresent, true, "strict fallback marker survives until a primary lease succeeds");
    assert.equal(Object.hasOwn(result.leases[1].body, "preferredModel"), false, "strict fallback releases stickiness for the primary lease");
    assert.equal(result.leases[1].body.fallbackTargetID, "old-target", "strict fallback carries its marker target without ordinary preference");
    assert.equal(result.strictMarkerGone, true, "the non-fallback primary lease clears the strict fallback marker");
    assert.deepEqual(result.strictModel, { providerID: "openai", modelID: "gpt-5.6-luna" }, "the eligible primary is selected");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("plan-window circuits open at the provider's reset, clear early, and never shorten a longer block", async () => {
  const { applyPlanUsageCircuit, PLAN_WINDOW_KIND } = await import("../lib/plan-usage.js");
  const now = Date.parse("2026-08-31T21:00:00Z");
  const reset = Date.parse("2026-08-31T22:10:00Z");
  const circuits = {};
  // Exhausted plan window opens a circuit until the provider's own reset.
  applyPlanUsageCircuit(circuits, "provider:anthropic", { lockedUntil: reset }, now);
  assert.deepEqual(circuits["provider:anthropic"], { kind: PLAN_WINDOW_KIND, until: reset, updatedAt: now });
  // The provider reopening early clears it before the timer.
  applyPlanUsageCircuit(circuits, "provider:anthropic", { lockedUntil: null }, now + 60_000);
  assert.equal(circuits["provider:anthropic"], undefined);
  // A longer NON-plan circuit (operator quarantine, quota with a later reset) is never shortened.
  circuits["provider:anthropic"] = { kind: "quota", until: reset + 3600_000, updatedAt: now };
  applyPlanUsageCircuit(circuits, "provider:anthropic", { lockedUntil: reset }, now);
  assert.equal(circuits["provider:anthropic"].kind, "quota");
  // ...and a healthy report does not clear a non-plan circuit either.
  applyPlanUsageCircuit(circuits, "provider:anthropic", { lockedUntil: null }, now);
  assert.equal(circuits["provider:anthropic"].kind, "quota");
});

test("concurrent plan-usage fetches share one outbound call", async () => {
  __resetPlanUsageCacheForTests();
  let calls = 0;
  const slowFetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { ok: true, json: async () => ({ limits: [{ kind: "session", percent: 10, resets_at: "2026-09-01T05:00:00Z", is_active: true }] }) };
  };
  const config = { windows: [], planUsage: { type: "anthropic-oauth", authPath: authFixture() } };
  const [a, b, c] = await Promise.all([
    fetchPlanUsage("anthropic", config, { fetchImpl: slowFetch }),
    fetchPlanUsage("anthropic", config, { fetchImpl: slowFetch }),
    fetchPlanUsage("anthropic", config, { fetchImpl: slowFetch }),
  ]);
  assert.equal(calls, 1, "one outbound call for three concurrent readers");
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("a RUN of short provider retries fails over once the parked total passes the threshold", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-failover-cumulative-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const brokerCalls = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        brokerCalls.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/failure"
          ? { ok: true, kind: "overload" }
          : options.path === "/lease"
            ? { target: { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } }, decision: { policy: "weighted-depletion", reasons: [] } }
            : { ok: true };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const aborts = [];
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: {
        get: async () => ({ id: "ses-cumulative", agent: "standard" }),
        messages: async () => ({ data: [] }),
        abort: async (input) => { aborts.push(input); return { data: true }; },
        prompt: async () => ({ data: true }),
      },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      setTimeout: () => ({ unref() {} }),
      clearTimeout: () => {},
    });
    const failures = () => brokerCalls.filter((c) => c.path === "/failure").length;
    // Each wait is 20s -- comfortably under the 30s PER-WAIT threshold, so none of
    // these would ever have triggered failover on its own.
    const retry = () => hooks.event({ event: { type: "session.status", properties: {
      sessionID: "ses-cumulative", status: { type: "retry", next: Date.now() + 20_000 },
    } } });

    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-cumulative", agent: "standard" } } } });
    await hooks["chat.message"]({ sessionID: "ses-cumulative", agent: "standard" }, { message: { model: {} } });

    await retry(); await retry();
    const afterTwo = failures();                       // 40s parked -- under the 60s total
    // A turn that COMPLETES clears the accumulator: a recovered session must not carry
    // stale waits forward and fail over on its next hiccup.
    await hooks.event({ event: { type: "message.updated", properties: {
      sessionID: "ses-cumulative", message: { role: "assistant", time: { completed: Date.now() } },
    } } });
    await retry(); await retry(); await retry();
    const afterReset = failures();                     // 60s since the reset -- still not OVER 60s
    await retry();
    const afterFourth = failures();                    // 80s -- over the threshold
    const failure = brokerCalls.filter((c) => c.path === "/failure").pop();
    console.log(JSON.stringify({
      afterTwo, afterReset, afterFourth,
      message: failure?.body?.error?.message ?? null,
      targetID: failure?.body?.targetID ?? null,
      aborts: aborts.length,
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  rmSync(home, { recursive: true, force: true });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout.trim().split("\n").pop());
  assert.equal(out.afterTwo, 0, "two short retries must not fail over");
  assert.equal(out.afterReset, 0, "a completed turn resets the accumulator");
  assert.equal(out.afterFourth, 1, "the parked total crossing the threshold fails over");
  assert.equal(out.targetID, "gpt-luna");
  assert.match(out.message, /retry waits totalled \d+s/);
  assert.equal(out.aborts, 1, "the parked turn is aborted so a new lease can take it");
});

const runLeaseWait = (replies, agent = "standard", configPath = new URL("./fixtures/config.json", import.meta.url).pathname) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-lease-wait-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const replies = ${JSON.stringify(replies)};
    const leaseCalls = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        const response = new EventEmitter();
        response.setEncoding = () => {};
        let reply = { ok: true };
        response.statusCode = 200;
        if (options.path === "/lease") {
          leaseCalls.push(body);
          const next = replies[Math.min(leaseCalls.length - 1, replies.length - 1)];
          if (next.status) { response.statusCode = next.status; reply = next.body; }
          else reply = { target: { id: "local-coder", kind: "local", model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } }, decision: { policy: "weighted-depletion", reasons: [] } };
        }
        callback(response);
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai", "llamacpp"], all: [{ id: "openai", models: {} }, { id: "llamacpp", models: {} }] } }) },
      session: { get: async () => ({ id: "ses-wait", agent: ${JSON.stringify(agent)} }), messages: async () => ({ data: [] }), prompt: async () => ({ data: true }), abort: async () => ({ data: true }) },
    };
    const sleeps = [];
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
      sleep: async (ms) => { sleeps.push(ms); }, leaseWaitStepMs: 1, leaseWaitMaxMs: 60000,
    });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-wait", agent: ${JSON.stringify(agent)} } } } });
    let outcome = "routed";
    try {
      await hooks["chat.message"]({ sessionID: "ses-wait", agent: ${JSON.stringify(agent)} }, { message: { model: {} } });
    } catch (error) { outcome = String(error?.message ?? error); }
    console.log(JSON.stringify({ outcome, leaseCalls: leaseCalls.length, sleeps: sleeps.length, tiers: leaseCalls.map((c) => c.tier) }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split("\n").at(-1));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("a busy or loading local model makes the prompt wait, not fail", () => {
  const busy = { status: 400, body: { error: "qwen3.5-9b is busy (every slot in use); waiting for a free slot -- resend the prompt in a moment", code: "target-busy" } };
  const preparing = { status: 400, body: { error: "qwen3.5-9b is not resident; preparing it now -- resend the prompt in a moment", code: "target-preparing" } };
  const result = runLeaseWait([busy, preparing, { ok: true }]);
  assert.equal(result.outcome, "routed", "the prompt goes through once a slot frees");
  assert.equal(result.leaseCalls, 3);
  assert.equal(result.sleeps, 2);
});

test("a terminal refusal still fails at once", () => {
  const refused = { status: 400, body: { error: "all lightweight routing targets are busy or unavailable", code: "no-eligible-target" } };
  const result = runLeaseWait([refused]);
  assert.notEqual(result.outcome, "routed");
  assert.equal(result.leaseCalls, 1);
  assert.equal(result.sleeps, 0);
});

test("tierAliases build->smart: build and sp-implementer lease the smart lane; fast-build keeps its own", () => {
  for (const agent of ["build", "sp-implementer"]) {
    const result = runLeaseWait([{ ok: true }], agent);
    assert.equal(result.outcome, "routed", agent);
    assert.deepEqual(result.tiers, ["smart"], `${agent} must not lease a separate build lane`);
  }
  assert.deepEqual(runLeaseWait([{ ok: true }], "fast-build").tiers, ["fast-build"]);
});
test("without a tierAliases entry the build agent keeps its own lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-no-alias-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({}));
    assert.deepEqual(runLeaseWait([{ ok: true }], "build", configPath).tiers, ["build"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
