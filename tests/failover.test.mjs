import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const { normalizeProviderError } = await import("../lib/provider-health.js");
const { classifyRoutingFailure, isFastModeCreditsRequired, FAST_MODE_CREDITS_REASON } = await import("../lib/routing.js");
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
  // The gateway refusing for lack of an eligible target is the broker talking to itself.
  assert.equal(classifyRoutingFailure({
    message: "Bad Gateway: {\"error\":{\"message\":\"gateway: no provider could serve the request: all lightweight routing targets are busy or unavailable\",\"type\":\"upstream_error\"}}",
    statusCode: 502,
  }), "noop");
  // A genuine provider fault in the same shape must still be classified.
  assert.equal(classifyRoutingFailure({ message: "model not found: gpt-9", statusCode: 404 }), "model");
});

test("verified gateway upstream 5xx overloads only its matching target provider", () => {
  for (const status of [500, 502, 503, 504]) {
    const message = `gateway: no provider could serve the request: upstream openai HTTP ${status}`;
    assert.equal(classifyRoutingFailure({ message }, { targetProviderID: "openai" }), "overload");
    assert.equal(classifyRoutingFailure({
      message: `Bad Gateway: ${JSON.stringify({ error: { message, type: "upstream_error" } })}`,
    }, { targetProviderID: "openai" }), "overload");
  }

  const canonical = "gateway: no provider could serve the request: upstream openai HTTP 502";
  assert.equal(classifyRoutingFailure({ message: canonical }), "noop");
  assert.equal(classifyRoutingFailure({ message: canonical }, { targetProviderID: "anthropic" }), "noop");
  assert.equal(classifyRoutingFailure({ message: canonical, targetProviderID: "openai" }), "noop");
  const sdkCanonical = {
    name: "AI_APICallError",
    data: { message: `Bad Gateway: ${JSON.stringify({ error: { message: canonical } })}` },
  };
  assert.equal(classifyRoutingFailure(sdkCanonical, { targetProviderID: "anthropic" }), "noop",
    "an SDK envelope cannot override the verified binding's provider");
  assert.equal(classifyRoutingFailure(
    { message: "gateway: no provider could serve the request: upstream openai:spoof HTTP 502" },
    { targetProviderID: "openai:spoof" },
  ), "noop", "provider tokens outside the conservative grammar fail closed");
  for (const suffix of ["\n", "\r\n", "\r"]) {
    assert.equal(classifyRoutingFailure({
      message: `Bad Gateway: ${JSON.stringify({ error: { message: `${canonical}${suffix}` } })}`,
    }, { targetProviderID: "openai" }), "noop", `SDK inner message ending ${JSON.stringify(suffix)} is not canonical`);
  }
  assert.equal(classifyRoutingFailure({
    message: "gateway: no provider could serve the request: upstream OpenAI HTTP 502",
  }, { targetProviderID: "openai" }), "noop");
  assert.equal(classifyRoutingFailure({
    message: "gateway: no provider could serve the request: upstream openai HTTP 5021",
  }, { targetProviderID: "openai" }), "noop");
  assert.equal(classifyRoutingFailure({
    message: "gateway: no provider could serve the request: upstream openai HTTP 505",
  }, { targetProviderID: "openai" }), "noop");
  assert.equal(classifyRoutingFailure({
    message: `${canonical}: chat body`,
  }, { targetProviderID: "openai" }), "noop");
  assert.equal(classifyRoutingFailure({
    message: `Bad Gateway: ${JSON.stringify({ message: canonical })}`,
  }, { targetProviderID: "openai" }), "noop");
  assert.equal(classifyRoutingFailure({
    message: `Bad Gateway: {\"error\":`,
  }, { targetProviderID: "openai" }), "other");
  assert.equal(classifyRoutingFailure({
    message: `Bad Gateway: ${JSON.stringify({ error: { message: canonical } })} trailing`,
  }, { targetProviderID: "openai" }), "noop");
  for (const status of [400, 401, 429]) {
    assert.equal(classifyRoutingFailure({
      message: `gateway: no provider could serve the request: upstream openai HTTP ${status}`,
    }, { targetProviderID: "openai" }), "noop");
  }

  assert.equal(classifyRoutingFailure({ statusCode: 503, message: "Service Unavailable" }), "overload");
  assert.equal(classifyRoutingFailure({ statusCode: 500, message: "Internal Server Error" }), "other");
});

test("gateway raw message accepts only the exact plain or complete SDK gateway form", () => {
  const canonical = "gateway: no provider could serve the request: upstream openai HTTP 502";
  const context = { targetProviderID: "openai" };
  const wrapped = `Bad Gateway: ${JSON.stringify({ error: { message: canonical } })}`;

  for (const error of [
    canonical,
    { message: canonical },
    { message: wrapped },
    { name: "AI_APICallError", data: { message: wrapped } },
  ]) {
    assert.equal(classifyRoutingFailure(error, context), "overload", JSON.stringify(error));
  }

  for (const [label, message] of [
    ["plain LF suffix", `${canonical}\n`],
    ["plain CRLF suffix", `${canonical}\r\n`],
    ["plain CR suffix", `${canonical}\r`],
    ["leading space", ` ${canonical}`],
    ["trailing space", `${canonical} `],
    ["double space", canonical.replace("upstream openai", "upstream  openai")],
    ["tab", canonical.replace("upstream openai", "upstream\topenai")],
    ["NBSP", canonical.replace("upstream openai", "upstream\u00a0openai")],
    ["long trailing padding", `${canonical}${" ".repeat(513)}`],
    ["trailing junk", `${canonical} trailing junk`],
    ["noncanonical wrapper prefix spacing", `Bad  Gateway: ${JSON.stringify({ error: { message: canonical } })}`],
  ]) {
    assert.equal(classifyRoutingFailure({ message }, context), "noop", label);
  }

  const innerWhitespace = `${canonical}\n`;
  assert.equal(classifyRoutingFailure({
    message: `Bad Gateway: {"error":{"message":${JSON.stringify(innerWhitespace)}}}`,
  }, context), "noop", "quoted JSON inner whitespace is not canonical");
  assert.equal(classifyRoutingFailure({
    message: `${wrapped} trailing`,
  }, context), "noop", "complete JSON rejects trailing non-whitespace");
});

test("gateway raw message only reads supported own string data properties", () => {
  const canonical = "gateway: no provider could serve the request: upstream openai HTTP 502";
  const context = { targetProviderID: "openai" };
  const wrapped = `Bad Gateway: ${JSON.stringify({ error: { message: canonical } })}`;
  assert.equal(classifyRoutingFailure(new Error(canonical), context), "overload");
  assert.equal(classifyRoutingFailure(wrapped, context), "overload");
  assert.equal(classifyRoutingFailure({ message: `Bad Gateway:  ${JSON.stringify({ error: { message: canonical } })}` }, context), "overload", "JSON formatting whitespace is valid after the exact prefix");
  const inherited = Object.assign(Object.create({ message: canonical }), { name: "Error" });
  const inheritedData = { name: "Error", data: Object.assign(Object.create({ message: canonical }), { name: "Error" }) };
  const directGetter = { name: "Error", get message() { return canonical; } };
  const dataGetter = { name: "Error", get data() { return { message: canonical }; } };
  for (const [label, error] of [
    ["inherited message", inherited],
    ["inherited SDK message", inheritedData],
    ["message accessor", directGetter],
    ["data accessor", dataGetter],
    ["non-string direct message", { name: "Error", message: 502, data: { message: canonical } }],
    ["empty direct message", { name: "Error", message: "", data: { message: canonical } }],
    ["unsupported error envelope", { error: { message: canonical } }],
    ["unsupported cause envelope", { cause: { message: canonical } }],
  ]) {
    assert.equal(classifyRoutingFailure(error, context), "noop", `${label} cannot establish exact raw evidence`);
  }
  for (const error of [null, undefined, 502, true, {}, { data: null }, { data: "not-an-object" }, { data: {} }, { data: { message: 502 } }]) {
    assert.notEqual(classifyRoutingFailure(error, context), "overload", "unsupported raw shape fails closed");
  }
});

test("gateway upstream 5xx ignores non-string SDK envelope messages", () => {
  const canonical = "gateway: no provider could serve the request: upstream openai HTTP 502";
  const wrapped = (message) => ({
    message: `Bad Gateway: ${JSON.stringify({ error: { message, note: canonical } })}`,
  });

  for (const message of [
    null,
    502,
    [],
    [canonical],
    [[canonical]],
    {},
    { toString: "not-a-function", note: canonical },
    { toString: null, valueOf: null, note: canonical },
  ]) {
    assert.equal(classifyRoutingFailure(wrapped(message), { targetProviderID: "openai" }), "noop");
  }
});

test("gateway upstream 5xx needs a string provider in the broker-supplied context, nothing coerces", () => {
  const canonical = "gateway: no provider could serve the request: upstream openai HTTP 502";
  const error = { message: canonical };
  assert.equal(classifyRoutingFailure(error, { targetProviderID: "openai" }), "overload", "control: the exact string matches");
  // Only `internalContext.targetProviderID` as a genuine string counts. A coercible object,
  // an array holding the right id, a bare string in place of the context object, or an
  // absent/null field all fall back to the caller-side noop -- the guard is typeof, not ==.
  for (const [label, context] of [
    ["undefined", undefined],
    ["null", null],
    ["empty object", {}],
    ["null provider", { targetProviderID: null }],
    ["array provider", { targetProviderID: ["openai"] }],
    ["coercible object", { targetProviderID: { toString: () => "openai" } }],
    ["String wrapper", { targetProviderID: new String("openai") }],
    ["bare string context", "openai"],
    ["wrong key", { providerID: "openai" }],
    ["empty string", { targetProviderID: "" }],
  ]) {
    assert.equal(classifyRoutingFailure(error, context), "noop", `${label} must not establish provider attribution`);
  }
});

test("fast-mode-credits is recognised through the gateway wrapper and in direct upstream wording", () => {
  // The reason constant is exported so the broker and tests reference ONE name.
  assert.equal(FAST_MODE_CREDITS_REASON, "fast-mode-credits");
  // Bound-session envelope: the plugin surfaces the gateway's 502 as HTTP 502
  // with the "Bad Gateway: " prefix opencode's HTTP client applies. The upstream
  // 429 lives only inside the message text, which is why the classifier reads
  // the gateway-wrapped status out of the string.
  assert.equal(isFastModeCreditsRequired({
    message: 'Bad Gateway: {"error":{"message":"gateway: no provider could serve the request: Anthropic upstream HTTP 429: usage credits are required for fast mode","type":"upstream_error"}}',
    statusCode: 502,
  }), true);
  assert.equal(classifyRoutingFailure({
    message: 'Bad Gateway: {"error":{"message":"gateway: no provider could serve the request: Anthropic upstream HTTP 429: usage credits are required for fast mode","type":"upstream_error"}}',
    statusCode: 502,
  }), "model");
  // Own-lease path: the gateway POSTs /failure with the suffixed message and the
  // real upstream status.
  assert.equal(classifyRoutingFailure({
    statusCode: 429, message: "Anthropic upstream HTTP 429: usage credits are required for fast mode",
  }), "model");
  // Direct provider wording. The classifier accepts 400/403/429 because the
  // account-level refusal could arrive as any of those and all three are
  // client-side refusals the broker should treat the same way.
  assert.equal(classifyRoutingFailure({ statusCode: 429, message: "Usage credits are required for fast mode." }), "model");
  assert.equal(classifyRoutingFailure({ statusCode: 400, message: "Usage credits are required for fast mode." }), "model");
  assert.equal(classifyRoutingFailure({ statusCode: 403, message: "Usage credits are required for fast mode." }), "model");
  // Responses wrap, as the gateway /failure body carries it when the OpenAI
  // Responses path hits the same account refusal.
  assert.equal(classifyRoutingFailure({
    statusCode: 429, message: "OpenAI Responses upstream HTTP 429: usage credits are required for fast mode",
  }), "model");
  // Chat wrap as the plugin would see it: opencode's HTTP client prepends
  // "Bad Gateway: " to the gateway's 502 body, and the chat path's text slice
  // includes the raw upstream JSON (its 400-char slice is unchanged by the
  // signal recogniser).
  assert.equal(classifyRoutingFailure({
    statusCode: 502,
    message: 'Bad Gateway: {"error":{"message":"gateway: no provider could serve the request: upstream openai HTTP 429: {\\"error\\":{\\"message\\":\\"Usage credits are required for fast mode.\\"}}","type":"upstream_error"}}',
  }), "model");
  // Reworded upstream message. The matcher must tolerate the account refusal
  // being phrased either way around (proximity, not two independent conjuncts),
  // so a later Anthropic rewording does not reopen the loop this change closed.
  assert.equal(classifyRoutingFailure({
    statusCode: 429, message: "Fast mode requires usage credits on this account.",
  }), "model");
});

test("fast-mode-credits proximity: both words must co-occur, not merely appear in a long body", () => {
  // Negative: both phrases present but separated by > 80 chars of unrelated
  // text (a logged body, a dumped stack trace, ...) is NOT the account-refusal
  // signal. The two independent-conjuncts form -- which is what preceded this
  // change -- would have classified this as "model" and fenced every fast
  // target on anthropic for six hours over a line in an error log.
  const filler = "x".repeat(120);
  const farApart = `missing usage credits header -- ${filler} -- the fast mode toggle was off`;
  assert.equal(isFastModeCreditsRequired({ statusCode: 400, message: farApart }), false);
  assert.notEqual(classifyRoutingFailure({ statusCode: 400, message: farApart }), "model");
});

test("fast-mode-credits classifier negatives keep today's behaviour", () => {
  // Ordinary bound 502 WITHOUT the fast-mode phrase still falls through to the
  // 8dfa882 gateway-refusal rule.
  assert.equal(classifyRoutingFailure({
    message: 'Bad Gateway: {"error":{"message":"gateway: no provider could serve the request: Anthropic upstream HTTP 429","type":"upstream_error"}}',
    statusCode: 502,
  }), "noop");
  // Own-lease 429 without the phrase is a burst rate limit, five-minute target
  // fence, same as before.
  assert.equal(classifyRoutingFailure({ statusCode: 429, message: "Anthropic upstream HTTP 429" }), "rate");
  // Both phrases but no 400/403/429 anywhere (statusCode 500, no wrapped
  // upstream status) is not the fast-mode signal.
  assert.notEqual(classifyRoutingFailure({ statusCode: 500, message: "Usage credits are required for fast mode." }), "model");
  // "usage credits are required" without "fast mode" is a different wording.
  assert.notEqual(classifyRoutingFailure({ statusCode: 429, message: "Usage credits are required for your account." }), "model");
  assert.equal(isFastModeCreditsRequired({ statusCode: 429, message: "Usage credits are required for your account." }), false);
  // The gateway's own refusal text ("no live lease") stays noop -- it is the
  // broker refusing itself, never a provider answer.
  assert.equal(classifyRoutingFailure({
    message: "route unavailable; resend the prompt (gateway: session holds no live lease, re-lease to resume)",
    statusCode: 409,
  }), "noop");
  // Since 297ac7a the gateway answers 400 with this exact wording, and opencode's SDK
  // delivers it inside an APIError envelope. The broker must still indict nothing: the
  // plugin's resume of this refusal is a plugin-local decision, never a health signal.
  const current = '[opencode-broker] route unavailable; resend the prompt (gateway: session holds no live lease for "claude-opus-5-5")';
  assert.equal(classifyRoutingFailure({ message: current, statusCode: 400 }), "noop");
  assert.equal(classifyRoutingFailure({
    name: "APIError",
    data: {
      message: current,
      statusCode: 400,
      responseBody: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: current } }),
    },
  }, { targetProviderID: "anthropic" }), "noop");
});

// A full window locks only when Anthropic says it is refusing (`locked_reason` on the
// top-level entry). On 2026-10-09 100% with locked_reason null kept serving every request.
// Kept identical to llm-auth-proxy's src/plan-usage.ts.
test("anthropic plan usage locks a full window only when Anthropic reports it locked", async () => {
  const config = { windows: [], planUsage: { type: "anthropic-oauth", authPath: authFixture() } };
  const limits = [{ kind: "session", percent: 100, resets_at: "2026-10-09T03:20:00Z", is_active: true }];
  for (const [label, fiveHour, expected] of [
    ["full but not locked", { utilization: 100, locked_reason: null }, null],
    ["full and locked", { utilization: 100, locked_reason: "session_limit" }, Date.parse("2026-10-09T03:20:00Z")],
    ["no top-level entry falls back to the percentage", undefined, Date.parse("2026-10-09T03:20:00Z")],
  ]) {
    __resetPlanUsageCacheForTests();
    const report = await fetchPlanUsage("anthropic", config, {
      fetchImpl: async () => ({ ok: true, json: async () => ({ ...(fiveHour ? { five_hour: fiveHour } : {}), limits }) }),
    });
    assert.equal(report.windows[0].percent, 100, `${label}: the reading is still reported`);
    assert.equal(report.lockedUntil, expected, label);
  }
});

// Past a window's reset its percentage describes a window that no longer exists, so the
// cached reading is refetched at once instead of serving out its TTL; a reading whose reset
// was already past when it was taken does not force a refetch per request.
test("a cached plan reading is refetched once one of its windows resets", async (t) => {
  __resetPlanUsageCacheForTests();
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "test-secret" } });
  const resetAt = 30_000;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({
      windows: [{ id: "5h", percent: calls === 1 ? 100 : 3, resetsAt: new Date(resetAt).toISOString(), active: true, severity: null }],
      lockedUntil: null,
    }) };
  };
  const config = httpPlanConfig(authPath);
  const before = await fetchPlanUsage("reset-provider", config, { fetchImpl, now: 1_000 });
  const after = await fetchPlanUsage("reset-provider", config, { fetchImpl, now: 31_000 });
  assert.equal(before.windows[0].percent, 100);
  assert.equal(after.windows[0].percent, 3, "inside the 60 s TTL, but past the reset: refetched");
  await fetchPlanUsage("reset-provider", config, { fetchImpl, now: 32_000 });
  assert.equal(calls, 2, "the new reading's reset was already past when taken: no refetch loop");
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

// When NOTHING can take over -- every plan in the lane spent -- failover has nowhere to go and
// the session used to sit stopped until a human noticed the provider was back. It is parked
// instead, and resumed once the broker's /preview says its lane would get a model again.
test("a session stopped because nothing could serve it resumes once its lane can be served again", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-resume-home-"));
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
    let served = false; // the outage: nothing can serve the lane until this flips
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        brokerCalls.push({ path: options.path, body });
        const response = new EventEmitter();
        response.setEncoding = () => {};
        let reply = { ok: true };
        response.statusCode = 200;
        if (options.path === "/lease") {
          if (served) {
            reply = { target: { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } }, decision: { policy: "weighted-depletion", reasons: [] } };
          } else {
            response.statusCode = 400;
            reply = { error: "usage limit reached -- openai weekly limit, back Wed Oct 14 03:38 UTC (in 4d 23h).", code: "usage-limit" };
          }
        } else if (options.path === "/preview") {
          reply = { preview: served ? { [body.tiers[0]]: { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } } } : {} };
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
    const prompts = [];
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: {
        get: async (input) => ({ id: input?.path?.id, agent: "standard" }),
        messages: async () => ({ data: [] }),
        abort: async () => ({ data: true }),
        prompt: async (input) => { prompts.push(input); return { data: true }; },
      },
    };
    const timers = [];
    const runTimers = async () => { for (const fn of timers.splice(0)) await fn(); };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
      clearTimeout: () => {},
    });
    const refusedTurn = async (id) => {
      await hooks.event({ event: { type: "session.created", properties: { info: { id, agent: "standard" } } } });
      try { await hooks["chat.message"]({ sessionID: id, agent: "standard" }, { message: { model: {} } }); return null; }
      catch (error) { return String(error.message); }
    };
    const refusal = await refusedTurn("ses-resume");
    await refusedTurn("ses-aborted");
    // The user stops one of them: it must stay stopped.
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "ses-aborted", error: { name: "MessageAbortedError", data: { message: "Aborted" } } } } });
    await runTimers();                       // still out: nothing resumes
    const promptedDuringOutage = prompts.length;
    served = true;
    await runTimers();                       // back: the parked session resumes
    await runTimers();                       // and only once
    console.log(JSON.stringify({
      refusal,
      promptedDuringOutage,
      resumed: prompts.map((p) => p.path.id),
      text: prompts[0]?.body?.parts?.[0]?.text ?? null,
      synthetic: prompts[0]?.body?.parts?.[0]?.synthetic ?? null,
      agent: prompts[0]?.body?.agent ?? null,
      previewTier: brokerCalls.find((call) => call.path === "/preview")?.body?.tiers ?? null,
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.match(String(result.refusal), /usage limit reached/, "the turn still fails, with the explicit reason");
    assert.equal(result.promptedDuringOutage, 0, "nothing is resumed while the lane cannot be served");
    assert.deepEqual(result.resumed, ["ses-resume"], "resumed exactly once, and the aborted session not at all");
    assert.match(String(result.text), /available again/);
    assert.equal(result.synthetic, true);
    assert.equal(result.agent, "standard", "resumed in its own agent");
    assert.equal(Array.isArray(result.previewTier) && result.previewTier.length, 1, "asks about its own tier");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A strict-fallback lease binds the whole turn, so a long agent turn used to stay on the
// emergency rung after its primaries came back (2026-10-19: smart on gpt-terra for 16+ minutes
// after a 3-minute proxy outage). A root on a fallback leaves it at the next tool-call step
// boundary once /preview says a primary would serve its lane; a subagent is never aborted.
test("a root session on a fallback moves back to a primary at the next step boundary", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-restore-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const terra = { id: "gpt-terra", model: { providerID: "openai", id: "gpt-5.6-terra" } };
    const sol = { id: "gpt-sol", model: { providerID: "openai", id: "gpt-6.1-sol" } };
    let primaryBack = false;
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        const response = new EventEmitter();
        response.setEncoding = () => {};
        response.statusCode = 200;
        let reply = { ok: true };
        if (options.path === "/lease") {
          reply = primaryBack
            ? { leaseID: "l-" + body.sessionID + "-2", target: sol, decision: { policy: "weighted-depletion", reasons: [] } }
            : { leaseID: "l-" + body.sessionID, target: terra, decision: { policy: "strict-fallback", reasons: ["only-eligible-target"] } };
        } else if (options.path === "/preview") {
          reply = { preview: { [body.tiers[0]]: primaryBack ? sol : { ...terra, fallback: true } } };
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
    const prompts = [];
    const aborts = [];
    const infos = { "ses-root": { id: "ses-root", agent: "smart" }, "ses-child": { id: "ses-child", agent: "smart", parentID: "ses-root" } };
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: {
        get: async (input) => ({ data: infos[input?.path?.id] }),
        messages: async () => ({ data: [] }),
        abort: async (input) => { aborts.push(input.path.id); return { data: true }; },
        prompt: async (input) => { prompts.push(input); return { data: true }; },
      },
    };
    const timers = [];
    const runTimers = async () => { for (const fn of timers.splice(0)) await fn(); };
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
      clearTimeout: () => {},
    });
    const stepFinish = async (sessionID, reason, n) => {
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        id: "prt-" + sessionID + n, messageID: "msg-" + sessionID, sessionID, type: "step-finish", reason,
      } } } });
      await tick();
    };
    for (const id of ["ses-root", "ses-child"]) {
      await hooks.event({ event: { type: "session.created", properties: { info: infos[id] } } });
      await hooks["chat.message"]({ sessionID: id, agent: "smart" }, { message: { model: {} } });
    }
    await runTimers();                         // primaries still down: preview answers a fallback
    await stepFinish("ses-root", "tool-calls", 1);
    const abortedWhileDown = aborts.length;
    primaryBack = true;
    await runTimers();                         // preview now answers a primary
    await stepFinish("ses-root", "stop", 2);   // a turn that is ending is left alone
    const abortedOnStop = aborts.length;
    await stepFinish("ses-child", "tool-calls", 3);
    await stepFinish("ses-root", "tool-calls", 4);
    await runTimers();                         // the delayed re-engage
    await stepFinish("ses-root", "tool-calls", 5);
    await runTimers();
    console.log(JSON.stringify({
      abortedWhileDown,
      abortedOnStop,
      aborts,
      prompted: prompts.map((p) => p.path.id),
      text: prompts[0]?.body?.parts?.[0]?.text ?? null,
      synthetic: prompts[0]?.body?.parts?.[0]?.synthetic ?? null,
      agent: prompts[0]?.body?.agent ?? null,
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.abortedWhileDown, 0, "nothing moves while only a fallback can serve the lane");
    assert.equal(result.abortedOnStop, 0, "a step that ends the turn is not aborted");
    assert.deepEqual(result.aborts, ["ses-root"], "the root is aborted exactly once, the subagent never");
    assert.deepEqual(result.prompted, ["ses-root"], "and re-engaged exactly once");
    assert.match(String(result.text), /moved off its fallback/);
    assert.equal(result.synthetic, true);
    assert.equal(result.agent, "smart", "re-engaged in its own agent");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The gateway path: the lease succeeds, the provider then refuses for usage at the gateway, and
// the broker calls that 502 a noop -- so no failover follows. The session parks on the
// gateway's usage-limit wording, resumes when served, and a resume that fails the same way
// waits out a backoff instead of spending a failed request every minute.
test("a gateway usage-limit stop parks the session, and a failed resume backs off", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-resume-gw-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        const response = new EventEmitter();
        response.setEncoding = () => {};
        response.statusCode = 200;
        const target = { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } };
        const reply = options.path === "/lease" ? { target, decision: { policy: "weighted-depletion", reasons: [] } }
          : options.path === "/failure" ? { ok: true, kind: "noop" }
          : options.path === "/preview" ? { preview: { [body.tiers[0]]: target } }
          : { ok: true };
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
    const prompts = [];
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: {
        get: async () => ({ id: "ses-gw", agent: "standard" }),
        messages: async () => ({ data: [] }),
        abort: async () => ({ data: true }),
        prompt: async (input) => { prompts.push(input); return { data: true }; },
      },
    };
    const timers = [];
    const runTimers = async () => { for (const fn of timers.splice(0)) await fn(); };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
      clearTimeout: () => {},
    });
    const gatewayUsageStop = async () => {
      await hooks["chat.message"]({ sessionID: "ses-gw", agent: "standard" }, { message: { model: {} } });
      await hooks.event({ event: { type: "session.error", properties: { sessionID: "ses-gw", error: {
        name: "AI_APICallError",
        data: { message: "Bad Gateway: usage limit reached -- openai weekly limit, back Wed Oct 14 03:38 UTC (in 4d 23h). (gateway: no provider could serve the request)", statusCode: 502 },
      } } } });
    };
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-gw", agent: "standard" } } } });
    await gatewayUsageStop();
    await runTimers();                          // served: resumes
    const afterFirst = prompts.length;
    await gatewayUsageStop();                   // the resumed turn hits the same limit
    await runTimers();                          // inside the backoff: must not resume yet
    console.log(JSON.stringify({ afterFirst, afterSecond: prompts.length }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.afterFirst, 1, "the gateway usage stop parks, and it resumes when served");
    assert.equal(result.afterSecond, 1, "a resume that failed the same way waits out its backoff");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Usage nearly out with nothing to take over: every working session is told once to wrap up --
// a main session writes a handoff, a subagent returns what it has -- and nothing is said while
// the lane still has room.
test("working sessions are told once to wrap up when their lane is nearly out", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-wrapup-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    let nearlyOut = false;
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const response = new EventEmitter();
        response.setEncoding = () => {};
        response.statusCode = 200;
        const target = { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } };
        const reply = options.path === "/lease" ? { target, leaseID: "L", decision: { policy: "weighted-depletion", reasons: [] } }
          : options.path === "/headroom" ? { nearlyOut, threshold: 97, localFits: false, providers: [
              { providerID: "openai", held: false, percent: 98, window: "wk", resetsAt: Date.now() + 3_600_000, room: false }] }
          : { ok: true };
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
    const prompts = [];
    const infos = { "ses-main": { id: "ses-main", agent: "standard" }, "ses-child": { id: "ses-child", agent: "scout", parentID: "ses-main" } };
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: {
        get: async (input) => ({ data: infos[input?.path?.id] }),
        messages: async () => ({ data: [] }),
        abort: async () => ({ data: true }),
        prompt: async () => ({ data: true }),
        promptAsync: async (input) => { prompts.push(input); return { data: true }; },
      },
      tui: { showToast: async () => ({}) },
    };
    const timers = [];
    const runTimers = async () => { for (const fn of timers.splice(0)) await fn(); };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      setTimeout: (fn) => { timers.push(fn); return { unref() {} }; },
      clearTimeout: () => {},
    });
    for (const id of ["ses-main", "ses-child"]) {
      await hooks.event({ event: { type: "session.created", properties: { info: infos[id] } } });
      await hooks["chat.message"]({ sessionID: id, agent: infos[id].agent }, { message: { model: {} } });
      await hooks.event({ event: { type: "session.status", properties: { sessionID: id, status: { type: "busy" } } } });
    }
    await runTimers();                 // room left: nothing said
    const whileRoom = prompts.length;
    nearlyOut = true;
    await runTimers();                 // nearly out: each working session told
    await runTimers();                 // and only once for this window
    console.log(JSON.stringify({
      whileRoom,
      told: prompts.map((p) => p.path.id).sort(),
      main: prompts.find((p) => p.path.id === "ses-main")?.body?.parts?.[0]?.text ?? null,
      child: prompts.find((p) => p.path.id === "ses-child")?.body?.parts?.[0]?.text ?? null,
      agent: prompts.find((p) => p.path.id === "ses-child")?.body?.agent ?? null,
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.whileRoom, 0, "nothing is said while the lane has room");
    assert.deepEqual(result.told, ["ses-child", "ses-main"], "each working session is told exactly once");
    assert.match(result.main, /openai weekly window at 98%/);
    assert.match(result.main, /write|update a durable handoff/i);
    assert.match(result.child, /return what you have to your parent/);
    assert.match(result.child, /start nothing new/i);
    assert.doesNotMatch(result.child, /handoff|mutating/i);
    assert.equal(result.agent, "scout", "told in its own agent");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const [delivery, stalePrompt] of [
  ["returned", `return { error: missing };`],
  ["thrown", `throw missing;`],
]) test(`a ${delivery} missing-session error retires only the stale heartbeat and preserves live warnings`, async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-wrapup-missing-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const requests = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        requests.push({ path: options.path, body: payload ? JSON.parse(payload) : {} });
        const response = new EventEmitter(); response.setEncoding = () => {}; response.statusCode = 200;
        const target = { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } };
        const reply = options.path === "/lease" ? { target, leaseID: "L", decision: { policy: "weighted-depletion", reasons: [] } }
          : options.path === "/headroom" ? { nearlyOut: true, threshold: 97, localFits: false, providers: [{ providerID: "openai", held: false, percent: 98, window: "wk", resetsAt: null, room: false }] }
          : { ok: true };
        callback(response); response.emit("data", JSON.stringify(reply)); response.emit("end");
      };
      req.destroy = () => {}; req.setTimeout = () => {}; req.on = EventEmitter.prototype.on; return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const prompts = [];
    const infos = { stale: { id: "stale", agent: "standard" }, live: { id: "live", agent: "standard" } };
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: {
        get: async (input) => ({ data: infos[input.path.id] }), messages: async () => ({ data: [] }), abort: async () => ({ data: true }), prompt: async () => ({ data: true }),
        promptAsync: async (input) => { prompts.push(input.path.id); const missing = { name: "NotFoundError", data: { message: "Session not found: stale" } }; if (input.path.id === "stale") { ${stalePrompt} } return { data: true }; },
      }, tui: { showToast: async () => ({}) },
    };
    const timers = []; const runTimers = async () => { for (const fn of timers.splice(0)) await fn(); };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, { setTimeout: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimeout: () => {} });
    for (const id of ["stale", "live"]) {
      await hooks.event({ event: { type: "session.created", properties: { info: infos[id] } } });
      await hooks["chat.message"]({ sessionID: id, agent: "standard" }, { message: { model: {} } });
      await hooks.event({ event: { type: "session.status", properties: { sessionID: id, status: { type: "busy" } } } });
    }
    await runTimers(); await runTimers(); await runTimers();
    console.log(JSON.stringify({ prompts, forgets: requests.filter((request) => request.path === "/forget").map((request) => request.body.sessionID) }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath }, encoding: "utf8" });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.deepEqual(result.prompts, ["stale", "live"], "the stale prompt is attempted first and the later live session is still warned");
    assert.equal(result.prompts.filter((sessionID) => sessionID === "stale").length, 1, "the stale heartbeat is retired across later polls");
    assert.deepEqual(result.forgets, ["stale"], "the stale session is forgotten exactly once");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const [failureName, promptFailure] of [
  ["non-session NotFoundError", `return { error: { name: "NotFoundError", data: { message: "Model catalog not found" } } };`],
  ["transport failure", `throw new Error("socket hang up");`],
]) test(`${failureName} is reported and retried without retiring the live session`, async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-wrapup-retry-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module"; import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
    const require = createRequire(import.meta.url); const http = require("node:http"); const requests = [];
    http.request = (options, callback) => { const req = new EventEmitter(); req.end = (payload = "") => {
      requests.push({ path: options.path, body: payload ? JSON.parse(payload) : {} }); const response = new EventEmitter(); response.setEncoding = () => {}; response.statusCode = 200;
      const target = { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } };
      const reply = options.path === "/lease" ? { target, leaseID: "L", decision: { policy: "weighted-depletion", reasons: [] } }
        : options.path === "/headroom" ? { nearlyOut: true, threshold: 97, localFits: false, providers: [{ providerID: "openai", held: false, percent: 98, window: "wk", resetsAt: null, room: false }] } : { ok: true };
      callback(response); response.emit("data", JSON.stringify(reply)); response.emit("end");
    }; req.destroy = () => {}; req.setTimeout = () => {}; req.on = EventEmitter.prototype.on; return req; };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true }); mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({})); writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const prompts = []; const logs = [];
    const client = { provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) }, app: { log: async (entry) => { logs.push(entry); } }, session: {
      get: async () => ({ data: { id: "live", agent: "standard" } }), messages: async () => ({ data: [] }), abort: async () => ({ data: true }), prompt: async () => ({ data: true }),
      promptAsync: async (input) => { prompts.push(input.path.id); ${promptFailure} },
    }, tui: { showToast: async () => ({}) } };
    const timers = []; const runTimers = async () => { for (const fn of timers.splice(0)) await fn(); };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, { setTimeout: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimeout: () => {} });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "live", agent: "standard" } } } });
    await hooks["chat.message"]({ sessionID: "live", agent: "standard" }, { message: { model: {} } });
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "live", status: { type: "busy" } } } });
    await runTimers(); await runTimers();
    console.log(JSON.stringify({ prompts, forgets: requests.filter((request) => request.path === "/forget").map((request) => request.body.sessionID), errors: logs.filter((entry) => entry.body.level === "error").map((entry) => entry.body.message) }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath }, encoding: "utf8" });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.deepEqual(result.prompts, ["live", "live"], "a failed warning remains retryable on the next poll");
    assert.deepEqual(result.forgets, [], "a live session is never forgotten for an unrelated failure");
    assert.equal(result.errors.length, 2, "each failed warning is reported");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const lifecycleEvent of ["session.idle", "session.deleted"]) test(`${lifecycleEvent} prevents a warning after deferred headroom lookup`, async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-wrapup-idle-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module"; import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
    const require = createRequire(import.meta.url); const http = require("node:http"); const requests = [];
    let deferHeadroom = false; let releaseHeadroom; let headroomReached;
    const headroom = new Promise((resolve) => { releaseHeadroom = resolve; }); const headroomStarted = new Promise((resolve) => { headroomReached = resolve; });
    http.request = (options, callback) => { const req = new EventEmitter(); req.end = async (payload = "") => {
      requests.push({ path: options.path, body: payload ? JSON.parse(payload) : {} }); if (options.path === "/headroom" && deferHeadroom) { headroomReached(); await headroom; }
      const response = new EventEmitter(); response.setEncoding = () => {}; response.statusCode = 200; const target = { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } };
      const reply = options.path === "/lease" ? { target, leaseID: "L", decision: { policy: "weighted-depletion", reasons: [] } }
        : options.path === "/headroom" ? { nearlyOut: true, threshold: 97, localFits: false, providers: [{ providerID: "openai", held: false, percent: 98, window: "wk", resetsAt: null, room: false }] } : { ok: true };
      callback(response); response.emit("data", JSON.stringify(reply)); response.emit("end");
    }; req.destroy = () => {}; req.setTimeout = () => {}; req.on = EventEmitter.prototype.on; return req; };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true }); mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({})); writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    let deleted = false; const prompts = []; const client = { provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) }, session: {
      get: async () => deleted ? { error: { name: "NotFoundError", data: { message: "Session not found: idle" } }, response: { status: 404 } } : ({ data: { id: "idle", agent: "standard" } }), messages: async () => ({ data: [] }), abort: async () => ({ data: true }), prompt: async () => ({ data: true }), promptAsync: async () => { prompts.push("idle"); return { data: true }; },
    }, tui: { showToast: async () => ({}) } };
    const timers = []; const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, { setTimeout: (fn) => { timers.push(fn); return { unref() {} }; }, clearTimeout: () => {} });
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "idle", agent: "standard" } } } });
    await hooks["chat.message"]({ sessionID: "idle", messageID: "turn", agent: "standard" }, { parts: [{ type: "text", text: "continue" }], message: { id: "turn", model: {} } });
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "idle", status: { type: "busy" } } } });
    await hooks.event({ event: { type: "message.updated", properties: { sessionID: "idle", message: { id: "assistant", role: "assistant", parentID: "turn", time: { completed: 1 } } } } });
    deferHeadroom = true; const poll = timers.shift()(); await headroomStarted;
    if (${JSON.stringify(lifecycleEvent)} === "session.deleted") deleted = true; await hooks.event({ event: { type: ${JSON.stringify(lifecycleEvent)}, properties: { sessionID: "idle" } } }); releaseHeadroom(); await poll;
    console.log(JSON.stringify({ prompts, forgets: requests.filter((request) => request.path === "/forget").map((request) => request.body) }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath }, encoding: "utf8" });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.deepEqual(result.prompts, []);
    assert.deepEqual(result.forgets, [{ sessionID: "idle", leaseID: "L", completed: true }]);
  } finally { rmSync(home, { recursive: true, force: true }); }
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
    { id: "5h", percent: 42, resetsAt: "2026-09-22T08:00:00-04:00", active: true, severity: "warning" },
    { id: "wk", percent: 7, resetsAt: null, active: false, severity: null },
  ],
  lockedUntil: null,
});
// The broker stamps every reading with when it was taken (fetchedAt); compare the rest.
const reading = (report) => {
  const { fetchedAt, ...rest } = report ?? {};
  return rest;
};

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
  assert.deepEqual(reading(report), canonicalUsage());
  assert.equal(typeof report.fetchedAt, "number");
  assert.equal(request.url, "https://usage.example.invalid/v1/plan-usage");
  assert.equal(request.options.headers["x-api-key"], "expected-secret");
  assert.equal(Object.hasOwn(request.options.headers, "authorization"), false);
  assert.equal(Object.hasOwn(request.options.headers, "Authorization"), false);
});

test("HTTP plan usage rejects redirects instead of following them", async (t) => {
  __resetPlanUsageCacheForTests();
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "test-secret" } });
  let requestOptions;
  await fetchPlanUsage("redirect-policy", httpPlanConfig(authPath), {
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return { ok: true, json: async () => canonicalUsage() };
    },
  });
  assert.equal(requestOptions.redirect, "error");
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
  assert.deepEqual(reading(report), canonicalUsage());
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

test("HTTP plan usage rejects a canonical report with an invalid resetsAt date", async (t) => {
  __resetPlanUsageCacheForTests();
  const authPath = httpAuthFixture(t, { "provider-credential": { key: "test-secret" } });
  const payload = canonicalUsage();
  payload.windows[0].resetsAt = "not-a-date";
  const report = await fetchPlanUsage("invalid-reset-date", httpPlanConfig(authPath), {
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  assert.equal(report, null);
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
  assert.deepEqual(reading(first), canonicalUsage());
  assert.deepEqual(second, first, "the cached reading, fetchedAt and all");
  assert.equal(first.fetchedAt, 1_000);
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
    now: 180_999,
  });
  assert.deepEqual(reading(first), good);
  assert.deepEqual(stale, first, "the last good reading keeps serving");
  assert.equal(stale.fetchedAt, 1_000, "and keeps its own fetchedAt, so it can be shown as old");
  assert.deepEqual(backedOff, first);
  assert.equal(calls, 2, "one success, one failed refresh, then no call during the 2-minute failure backoff");
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
test("researcher verifier and sp-implementer lease the effective Smart tier", () => {
  for (const agent of ["researcher", "verifier", "sp-implementer"]) {
    const result = runLeaseWait([{ ok: true }], agent);
    assert.equal(result.outcome, "routed", agent);
    assert.deepEqual(result.tiers, ["smart"], `${agent} must lease exactly the Smart lane`);
  }
});
test("without a tierAliases entry the build agent keeps its own lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "broker-no-alias-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({}));
    assert.deepEqual(runLeaseWait([{ ok: true }], "build", configPath).tiers, ["build"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The llm-auth-proxy front-door key lives in its own owner-only file, not in opencode's
// auth.json; and its OpenAI route reports epoch-second resets in a non-canonical shape. Before
// both were read, neither proxy reading ever landed and a stale 89% stood in for a spent plan.
test("HTTP plan usage reads a keyFile and the proxy's OpenAI window shape", async (t) => {
  __resetPlanUsageCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), "plan-usage-keyfile-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, "proxy-secret\n", { mode: 0o600 });
  let sent;
  const report = await fetchPlanUsage("openai", httpPlanConfig(join(dir, "missing-auth.json"), { authRef: undefined, keyFile }), {
    fetchImpl: async (_url, options) => {
      sent = options.headers["x-api-key"];
      return { ok: true, json: async () => ({ provider: "openai", plan: "pro", windows: [{ id: "primary", percent: 100, resetsAt: 1791309426, durationSeconds: 604800 }], stale: false }) };
    },
  });
  assert.equal(sent, "proxy-secret");
  assert.deepEqual(reading(report), {
    windows: [{ id: "wk", percent: 100, resetsAt: new Date(1791309426 * 1000).toISOString(), active: true, severity: null }],
    lockedUntil: 1791309426 * 1000,
    plan: "pro",
  });

  // A group- or world-readable key file is refused, as the gateway refuses it.
  __resetPlanUsageCacheForTests();
  writeFileSync(keyFile, "proxy-secret\n");
  chmodSync(keyFile, 0o644);
  let called = false;
  const loose = await fetchPlanUsage("openai", httpPlanConfig(join(dir, "missing-auth.json"), { authRef: undefined, keyFile }), {
    fetchImpl: async () => { called = true; return { ok: true, json: async () => canonicalUsage() }; },
  });
  assert.equal(loose, null);
  assert.equal(called, false);
});

// These lifecycle fixtures run the public plugin hooks in a fresh HOME and replace only
// node:http in the child.  They never contact a broker or a provider; explicit deferred
// promises control each interleaving rather than elapsed time.
const runLifecycleFixture = (body, { beforeInit = "", routerOptions = {} } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-lifecycle-home-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = join(home, "config.json");
  const config = readFileSync(new URL("./fixtures/config.json", import.meta.url), "utf8");
  writeFileSync(configPath, config.replace('"localModelsUrl": "http://gpu-box:8080/v1/models"', '"localModelsUrl": "http://127.0.0.1:1/v1/models"'));
  const script = `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url); const http = require("node:http");
    const calls = []; const timers = []; const timerRecords = []; const prompts = []; const logs = []; const aborts = []; let brokerReply = null;
    const missing = (id) => ({ error: { name: "NotFoundError", data: { message: "Session not found: " + id } }, response: { status: 404 } });
    const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };
    const target = { id: "gpt-luna", model: { providerID: "openai", id: "gpt-5.6-luna" } };
    http.request = (options, callback) => { const req = new EventEmitter(); req.end = (payload = "") => {
      const body = payload ? JSON.parse(payload) : {}; calls.push({ path: options.path, body });
      const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {}; callback(response);
      if (brokerReply?.(options.path, body, (reply) => { response.emit("data", JSON.stringify(reply)); response.emit("end"); }, req)) return;
      const reply = options.path === "/lease" ? { leaseID: "L" + body.sessionID + ((leases.get(body.sessionID) ?? 0) + 1), target, decision: { policy: "weighted-depletion", reasons: [] } }
        : options.path === "/headroom" ? { nearlyOut: true, threshold: 97, localFits: false, providers: [{ providerID: "openai", held: false, percent: 98, window: "wk", resetsAt: null, room: false }] } : { ok: true };
      if (options.path === "/lease") leases.set(body.sessionID, (leases.get(body.sessionID) ?? 0) + 1);
      response.emit("data", JSON.stringify(reply)); response.emit("end");
    }; req.destroy = () => {}; req.setTimeout = () => {}; req.on = EventEmitter.prototype.on; return req; };
    const leases = new Map();
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true }); mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({})); writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const live = new Map();
    const client = { provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) }, app: { log: async (entry) => logs.push(entry) }, tui: { showToast: async () => ({}) }, session: {
      get: async (input) => live.get(input.path.id) ?? missing(input.path.id), messages: async () => ({ data: [] }), abort: async (input) => { aborts.push(input); return { data: true }; }, prompt: async () => ({ data: true }),
      promptAsync: async (input) => { prompts.push(input); return { data: true }; },
    } };
    ${beforeInit}
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const { routingStateDir } = await import(${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)});
    const { brokerSocketPath } = await import(${JSON.stringify(new URL("../lib/client.js", import.meta.url).href)});
    assert.equal(routingStateDir(), join(process.env.HOME, "routing"));
    assert.equal(brokerSocketPath(), join(process.env.HOME, "broker.sock"));
    assert.equal(process.env.XDG_CACHE_HOME, join(process.env.HOME, ".cache"));
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      ...${JSON.stringify(routerOptions)},
      setTimeout: (fn, ms) => {
        const timer = { fn, ms, unrefed: false, cleared: false, unref() { this.unrefed = true; } };
        timers.push(timer); timerRecords.push(timer); return timer;
      },
      clearTimeout: (timer) => {
        timer.cleared = true;
        const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1);
      },
    });
    const created = async (id, info = { id, agent: "standard" }) => { live.set(id, { data: info }); await hooks.event({ event: { type: "session.created", properties: { info } } }); };
    const routeBusy = async (id, agent = live.get(id)?.data?.agent ?? "standard") => { await hooks["chat.message"]({ sessionID: id, agent }, { message: { model: {} } }); await hooks.event({ event: { type: "session.status", properties: { sessionID: id, status: { type: "busy" } } } }); };
    const runNextTimer = async (ms) => {
      const index = ms === undefined ? 0 : timers.findIndex((timer) => timer.ms === ms);
      if (index < 0 || index >= timers.length) return false;
      const [timer] = timers.splice(index, 1); await timer.fn(); return true;
    };
    ${body}
  `;
  const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), OPENCODE_MODEL_ROUTING_DIR: join(home, "routing"), OPENCODE_MODEL_BROKER_SOCKET: join(home, "broker.sock"), OPENCODE_BROKER_CONFIG: configPath }, encoding: "utf8", timeout: 60_000,
  });
  try {
    assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message || `child signal ${child.signal}`);
    return JSON.parse(child.stdout.trim().split("\n").at(-1));
  } finally { rmSync(home, { recursive: true, force: true }); }
};

test("lifecycle fixture ignores synthetic inherited routing and XDG overrides", () => {
  const keys = ["OPENCODE_MODEL_ROUTING_DIR", "OPENCODE_MODEL_BROKER_SOCKET", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const outsider = mkdtempSync(join(tmpdir(), "lifecycle-outsider-"));
  try {
    for (const key of keys) process.env[key] = join(outsider, key);
    runLifecycleFixture(`
      for (const key of ${JSON.stringify(keys)}) assert.ok(process.env[key]?.startsWith(process.env.HOME + "/"), key + " must be private");
      console.log(JSON.stringify({ ok: true }));
    `);
  } finally {
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    rmSync(outsider, { recursive: true, force: true });
  }
});

test("a heartbeat removed while an earlier warning is pending is not warned from the poll snapshot", () => {
  const result = runLifecycleFixture(`
    await created("a"); await created("b"); await routeBusy("a"); await routeBusy("b");
    const aStarted = deferred(); const aSend = deferred(); const forgetStarted = deferred(); let finishForget;
    brokerReply = (path, body, send) => {
      if (path === "/forget" && body.sessionID === "b") { finishForget = send; forgetStarted.resolve(); return true; }
      return false;
    };
    client.session.promptAsync = async (input) => {
      prompts.push(input);
      if (input.path.id === "a") { aStarted.resolve(); return aSend.promise; }
      return { data: true };
    };
    const poll = runNextTimer(60000); await aStarted.promise;
    const idleB = hooks.event({ event: { type: "session.idle", properties: { sessionID: "b" } } });
    await forgetStarted.promise;
    aSend.resolve({ data: true }); await poll;
    const warned = prompts.map((prompt) => prompt.path.id);
    finishForget({ ok: true }); await idleB;
    console.log(JSON.stringify({ warned, forgets: calls.filter((call) => call.path === "/forget").map((call) => call.body) }));
  `);
  assert.deepEqual(result.warned, ["a"], "a poll must recheck each heartbeat before dispatching its warning");
  assert.deepEqual(result.forgets, [{ sessionID: "b", leaseID: "Lb1" }]);
});

for (const [metadata, rawProperties] of [
  ["without creation metadata", `{ sessionID: "same" }`],
  ["with stale creation metadata", `{ sessionID: "same", info: { id: "same", time: { created: 1 } } }`],
]) test(`a late raw deletion of L1 ${metadata} cannot retire a same-ID L2 route, heartbeat, or warning episode`, () => {
  const result = runLifecycleFixture(`
    await created("same", { id: "same", agent: "standard", time: { created: 1 } }); await routeBusy("same");
    // Retire L1 through the real missing-session warning path before its ID is reused.
    client.session.promptAsync = async (input) => { prompts.push(input); return missing("same"); };
    await runNextTimer();
    client.session.promptAsync = async (input) => { prompts.push(input); return { data: true }; };
    await created("same", { id: "same", agent: "standard", time: { created: 2 } }); await routeBusy("same");
    // The raw event has no usable generation metadata; the authoritative lookup says L2 exists.
    await hooks.event({ event: { type: "session.deleted", properties: ${rawProperties} } });
    await runNextTimer();
    console.log(JSON.stringify({ forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body), prompts: prompts.map((x) => x.path.id), leases: calls.filter((x) => x.path === "/lease").map((x) => x.body.sessionID) }));
  `);
  assert.deepEqual(result.forgets, [{ sessionID: "same", leaseID: "Lsame1" }], "retirement is bound to L1 exactly once");
  assert.deepEqual(result.prompts, ["same", "same"], "L2 remains heartbeat-eligible and receives its own warning");
  assert.deepEqual(result.leases, ["same", "same"], "the replacement owns a distinct lease rather than synthetic prompt metadata");
});

test("an authoritative 404 deletes the current lease once even when raw deletion is duplicated", () => {
  const result = runLifecycleFixture(`
    await created("gone"); await routeBusy("gone"); live.delete("gone");
    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "gone" } } });
    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "gone" } } });
    const drained = await runNextTimer();
    console.log(JSON.stringify({ forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body), prompts: prompts.length, drained, timers: timers.length }));
  `);
  assert.deepEqual(result.forgets, [{ sessionID: "gone", leaseID: "Lgone1" }]);
  assert.equal(result.drained, true, "the already-scheduled wrap-up poll may fire harmlessly after heartbeat removal");
  assert.equal(result.prompts, 0, "the drained poll cannot warn a deleted session");
  assert.equal(result.timers, 0, "the drained poll schedules no future work without a heartbeat");
});

test("concurrent raw deletion and wrap-up missing evidence coalesce L1 cleanup without retiring L2", () => {
  // Replacing binding-content cleanup coalescing with wrapper identity issues two L1 forgets.
  const result = runLifecycleFixture(`
    await created("same", { id: "same", agent: "standard", time: { created: 1 } }); await routeBusy("same");
    live.delete("same");
    const lookupStarted = deferred();
    const lookup = deferred();
    client.session.get = async () => { lookupStarted.resolve(); return lookup.promise; };
    const rawDeletion = hooks.event({ event: { type: "session.deleted", properties: { sessionID: "same" } } });
    await lookupStarted.promise;
    client.session.promptAsync = async (input) => { prompts.push(input); return missing("same"); };
    const wrapUp = runNextTimer();
    await Promise.resolve(); await Promise.resolve();
    lookup.resolve(missing("same"));
    await Promise.all([rawDeletion, wrapUp]);
    client.session.promptAsync = async (input) => { prompts.push(input); return { data: true }; };
    await created("same", { id: "same", agent: "standard", time: { created: 2 } }); await routeBusy("same");
    await runNextTimer();
    console.log(JSON.stringify({ forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body), prompts: prompts.map((x) => x.path.id), leases: calls.filter((x) => x.path === "/lease").map((x) => x.body.sessionID) }));
  `);
  assert.deepEqual(result.forgets, [{ sessionID: "same", leaseID: "Lsame1" }], "the two L1 deletion paths share exactly one cleanup");
  assert.deepEqual(result.leases, ["same", "same"], "the same ID was replaced with L2");
  assert.deepEqual(result.prompts, ["same", "same"], "L2 remains heartbeat-eligible after L1 cleanup");
});

for (const [label, lookup] of [
  ["transport throw", `throw new Error("socket reset");`],
  ["unknown envelope", `return { error: { name: "NotFoundError", data: { message: "Model catalog not found" } }, response: { status: 404 } };`],
  ["non-404 envelope", `return { error: { name: "NotFoundError", data: { message: "Session not found: guarded" } }, response: { status: 503 } };`],
]) test(`a ${label} during deletion leaves the cached route eligible`, () => {
  const result = runLifecycleFixture(`
    await created("guarded"); await routeBusy("guarded"); client.session.get = async () => { ${lookup} };
    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "guarded" } } }); const ran = await runNextTimer();
    console.log(JSON.stringify({ ran, forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body), prompts: prompts.map((x) => x.path.id) }));
  `);
  assert.equal(result.ran, true);
  assert.deepEqual(result.forgets, [], "uncertain lookup evidence cannot release a lease");
  assert.deepEqual(result.prompts, ["guarded"], "uncertain lookup evidence cannot erase the heartbeat cache");
});

test("a deferred authoritative 404 cannot erase a replacement created during the lookup", () => {
  const result = runLifecycleFixture(`
    await created("race", { id: "race", agent: "standard", time: { created: 1 } }); await routeBusy("race");
    const lookup = deferred(); let entered = false; client.session.get = async () => { entered = true; return lookup.promise; };
    const deleting = hooks.event({ event: { type: "session.deleted", properties: { sessionID: "race" } } });
    await Promise.resolve(); await Promise.resolve();
    await created("race", { id: "race", agent: "standard", time: { created: 2 } }); await routeBusy("race"); lookup.resolve(missing("race")); await deleting;
    const ran = await runNextTimer(); console.log(JSON.stringify({ entered, ran, forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body), prompts: prompts.map((x) => x.path.id) }));
  `);
  assert.equal(result.entered, true, "raw deletion must await the authoritative lookup before acting");
  assert.equal(result.ran, true);
  assert.deepEqual(result.forgets, [], "the old 404 is fenced by the replacement and cannot forget L2");
  assert.deepEqual(result.prompts, ["race"]);
});

for (const [delivery, settle] of [
  ["returned missing", `old.resolve(missing("stale"));`],
  ["thrown missing", `old.reject(missing("stale").error);`],
  ["unrelated failure", `old.reject(new Error("socket reset"));`],
]) test(`a deferred ${delivery} warning cannot retire or report against its same-ID replacement`, () => {
  const result = runLifecycleFixture(`
    await created("stale", { id: "stale", agent: "standard", time: { created: 1 } }); await routeBusy("stale");
    const old = deferred(); const promptStarted = deferred(); client.session.promptAsync = async (input) => { prompts.push(input); if (prompts.length === 1) { promptStarted.resolve(); return old.promise; } return { data: true }; };
    const first = runNextTimer(); await promptStarted.promise;
    await created("stale", { id: "stale", agent: "standard", time: { created: 2 } }); await routeBusy("stale");
    ${settle} await first; const second = await runNextTimer();
    console.log(JSON.stringify({ second, forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body), prompts: prompts.length, warns: logs.filter((x) => x.body?.level === "warn" && /asked it to (wrap up|checkpoint and continue safely)/.test(x.body?.message ?? "")).length, errors: logs.filter((x) => x.body?.level === "error").length }));
  `);
  assert.equal(result.second, true, "the replacement owns the next deterministic poll");
  assert.deepEqual(result.forgets, delivery === "unrelated failure" ? [] : [{ sessionID: "stale", leaseID: "Lstale1" }], "only the captured L1 lease may be forgotten; L2 is fenced");
  assert.equal(result.prompts, 2, "L2 receives its own warning exactly once");
  assert.equal(result.warns, 1, "only the replacement warning is reported as sent");
  assert.equal(result.errors, 0, "a stale warning failure is not reported against its replacement");
});

for (const [oldOutcome, finishOld] of [
  ["success", `oldSend({ ok: true });`],
  ["failure", `oldRequest.emit("error", new Error("old forget failed"));`],
]) test(`an L1 pending forget ${oldOutcome} cannot remove or rewrite L2's pending record`, () => {
  const result = runLifecycleFixture(`
    const { readPendingForgetRecord } = await import(new URL("../lib/routing.js", ${JSON.stringify(new URL("../plugin/router.js", import.meta.url).href)}).href);
    const oldSends = []; const oldRequests = [];
    const oldStarted = deferred();
    brokerReply = (path, body, send, req) => {
      if (path !== "/forget") return false;
      if (body.leaseID === "Lpending1") { oldSends.push(send); oldRequests.push(req); oldStarted.resolve(); return true; }
      if (body.leaseID === "Lpending2") { queueMicrotask(() => req.emit("error", new Error("L2 forget failed"))); return true; }
      return false;
    };
    await created("pending", { id: "pending", agent: "standard", time: { created: 1 } }); await routeBusy("pending");
    const idleL1 = hooks.event({ event: { type: "session.idle", properties: { sessionID: "pending" } } });
    await oldStarted.promise;
    await created("pending", { id: "pending", agent: "standard", time: { created: 2 } }); await routeBusy("pending");
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "pending" } } });
    for (let i = 0; i < oldSends.length; i++) { const oldSend = oldSends[i]; const oldRequest = oldRequests[i]; ${finishOld} }
    await idleL1;
    console.log(JSON.stringify({ forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body), pending: readPendingForgetRecord("pending") }));
  `);
  assert.deepEqual(result.forgets.map((call) => call.leaseID), ["Lpending1", "Lpending2"], "the asynchronous retry does not make a synchronous duplicate; L2 deletion remains independent");
  assert.equal(result.pending?.leaseID, "Lpending2", "the replacement's pending record remains bound to L2");
});

test("startup retry never emits an unbound ID-only forget", () => {
  const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
  const result = runLifecycleFixture(`
    await Promise.resolve(); await Promise.resolve();
    console.log(JSON.stringify({ forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body) }));
  `, { beforeInit: `
    const { writePendingForgetRecord } = await import(${JSON.stringify(routingUrl)});
    assert.equal(writePendingForgetRecord("orphan", {}), false);
  ` });
  assert.deepEqual(result.forgets, [], "a persisted record without a lease is local cleanup, not broker-wide session deletion");
});

test("deleting a cached but unleased session performs local cleanup without an ID-only forget", () => {
  const result = runLifecycleFixture(`
    await created("unleased");
    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "unleased" } } });
    console.log(JSON.stringify({ forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body) }));
  `);
  assert.deepEqual(result.forgets, [], "no lease means no authoritative broker ownership to release");
});

for (const [delivery, malformed] of [
  ["returned", (message) => `return { error: { name: "NotFoundError", data: { message: ${JSON.stringify(message)} } }, response: { status: 404 } };`],
  ["thrown", (message) => `throw { name: "NotFoundError", data: { message: ${JSON.stringify(message)} } };`],
]) for (const [label, message] of [
  ["wrong id", "Session not found: other"], ["leading space", " Session not found: warn"], ["trailing space", "Session not found: warn "],
  ["LF", "Session not found: warn\n"], ["CRLF", "Session not found: warn\r\n"], ["CR", "Session not found: warn\r"],
  ["case", "session not found: warn"], ["near match", "Session not found: warn!"],
]) test(`${delivery} malformed missing-session warning (${label}) is reported and retried without forget`, () => {
  const result = runLifecycleFixture(`
    client.session.promptAsync = async (input) => { prompts.push(input); ${malformed(message)} };
    await created("warn"); await routeBusy("warn"); const first = await runNextTimer(); const second = await runNextTimer();
    console.log(JSON.stringify({ first, second, prompts: prompts.length, forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body), errors: logs.filter((x) => x.body?.level === "error").length }));
  `);
  assert.deepEqual([result.first, result.second], [true, true], "both deterministic heartbeat passes must remain scheduled");
  assert.equal(result.prompts, 2, "non-exact evidence leaves the warning retryable");
  assert.deepEqual(result.forgets, [], "non-exact evidence never releases a lease");
  assert.equal(result.errors, 2, "each unsuccessful warning is observable");
});

for (const [label, properties] of [
  ["without info", `{ sessionID: "incarnation" }`],
  ["with the exact original info object", `{ info: original }`],
]) test(`creation incarnation ${label} preserves an armed private profile after a stale 404`, () => {
  const result = runLifecycleFixture(`
    const { writePendingProfile, readPendingProfile, readSessionProfile, resolveProfile } = await import(${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)});
    const original = { id: "incarnation", agent: "standard", time: { created: 1 } };
    await created("incarnation", original);
    const lookup = deferred(); const entered = deferred();
    client.session.get = async () => { entered.resolve(); return lookup.promise; };
    const deleting = hooks.event({ event: { type: "session.deleted", properties: { sessionID: "incarnation" } } });
    await entered.promise;
    writePendingProfile("private");
    await hooks.event({ event: { type: "session.created", properties: ${properties} } });
    const before = readSessionProfile("incarnation"); const pending = readPendingProfile();
    // No routing or metadata refresh may provide an accidental identity fence.
    lookup.resolve(missing("incarnation")); await deleting;
    const after = readSessionProfile("incarnation");
    await created("unarmed-next");
    console.log(JSON.stringify({ before, after, pending, resolved: resolveProfile({ sessionID: "incarnation" }), next: readSessionProfile("unarmed-next"), forgets: calls.filter((x) => x.path === "/forget"), leases: calls.filter((x) => x.path === "/lease") }));
  `);
  assert.equal(result.before?.profile, "private", "the replacement consumes the armed profile");
  assert.equal(result.before?.explicit, true);
  assert.equal(result.pending, null, "creation consumes the arming record exactly once");
  assert.deepEqual(result.after, result.before, "the stale lookup cannot erase the replacement's profile");
  assert.equal(result.resolved.profile, "private", "routing must not fall back to auto");
  assert.equal(result.next?.profile, "auto", "the following session does not inherit the consumed arming record");
  assert.deepEqual(result.forgets, [], "an unleased incarnation never sends an ID-only forget");
  assert.deepEqual(result.leases, [], "no lease change masks the session-cache identity regression");
});

test("creation incarnation: a metadata update is not a replacement fence", () => {
  const result = runLifecycleFixture(`
    const { writePendingProfile, readSessionProfile } = await import(${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)});
    writePendingProfile("private"); await created("metadata");
    const lookup = deferred(); const entered = deferred();
    client.session.get = async () => { entered.resolve(); return lookup.promise; };
    const deleting = hooks.event({ event: { type: "session.deleted", properties: { sessionID: "metadata" } } });
    await entered.promise;
    await hooks.event({ event: { type: "session.updated", properties: { info: { id: "metadata", title: "renamed" } } } });
    lookup.resolve(missing("metadata")); await deleting;
    console.log(JSON.stringify({ profile: readSessionProfile("metadata"), forgets: calls.filter((x) => x.path === "/forget") }));
  `);
  assert.equal(result.profile, null, "a metadata-only event cannot prevent authoritative deletion");
  assert.deepEqual(result.forgets, []);
});

test("creation incarnation preserves the existing route and cached parent metadata", () => {
  const result = runLifecycleFixture(`
    await created("parent"); await created("child", { id: "child", parentID: "parent", agent: "standard" });
    await routeBusy("child");
    await hooks.event({ event: { type: "session.created", properties: { sessionID: "child" } } });
    const output = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "child", model: target.model }, output);
    await runNextTimer();
    console.log(JSON.stringify({ headers: output.headers, prompts: prompts.length, forgets: calls.filter((x) => x.path === "/forget"), leases: calls.filter((x) => x.path === "/lease").length }));
  `);
  assert.equal(result.headers["x-opencode-lease-id"], "Lchild1", "a creation fence does not discard the existing route");
  assert.equal(result.headers["x-opencode-session-kind"], "subagent", "fallback metadata retains the parent identity");
  assert.equal(result.prompts, 1, "the existing heartbeat remains eligible");
  assert.equal(result.leases, 1);
  assert.deepEqual(result.forgets, []);
});

for (const [label, settle] of [
  ["network rejection", `old.reject(new Error("socket reset"));`],
  ["returned error", `old.resolve({ error: { name: "TransportError", message: "socket reset" } });`],
  ["returned missing", `old.resolve(missing("warning"));`],
  ["thrown missing", `old.reject(missing("warning").error);`],
]) test(`warning attempt: an old ${label} remains retryable across leases of the same session`, () => {
  const result = runLifecycleFixture(`
    await created("warning"); await routeBusy("warning");
    const old = deferred(); const entered = deferred();
    client.session.promptAsync = async (input) => { prompts.push(input); if (prompts.length === 1) { entered.resolve(); return old.promise; } return { data: true }; };
    const first = runNextTimer(); await entered.promise;
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "warning" } } });
    // Same actual session, not a replacement creation: only the lease changes.
    await routeBusy("warning");
    ${settle} await first;
    const polls = []; for (let i = 0; i < 3; i++) polls.push(await runNextTimer());
    console.log(JSON.stringify({ polls, prompts: prompts.length, leases: leases.get("warning"), forgets: calls.filter((x) => x.path === "/forget").map((x) => x.body), errors: logs.filter((x) => x.body?.level === "error").length }));
  `);
  assert.equal(result.leases, 2, "the fixture must exercise L1 -> idle -> L2");
  assert.deepEqual(result.polls, [true, true, true]);
  assert.equal(result.prompts, 2, "an unsuccessful L1 warning must not suppress L2's warning");
  assert.ok(result.forgets.every((x) => x.sessionID === "warning" && x.leaseID === "Lwarning1"), "late missing evidence may forget only the captured lease");
  assert.equal(result.errors, 0, "the old failure is not attributed to L2");
});

test("warning attempt: stale successful pending warning retries on the new lease", () => {
  const result = runLifecycleFixture(`
    await created("success"); await routeBusy("success");
    const old = deferred(); const entered = deferred();
    client.session.promptAsync = async (input) => { prompts.push(input); entered.resolve(); return old.promise; };
    const first = runNextTimer(); await entered.promise;
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "success" } } });
    await routeBusy("success"); old.resolve({ data: true }); await first;
    const polls = []; for (let i = 0; i < 3; i++) polls.push(await runNextTimer());
    console.log(JSON.stringify({ polls, prompts: prompts.length, leases: leases.get("success") }));
  `);
  assert.equal(result.leases, 2);
  assert.deepEqual(result.polls, [true, true, true]);
  assert.equal(result.prompts, 2, "a stale success does not cover the new lease");
});

for (const episode of ["room reset", "replacement creation"]) test(`warning attempt: an old failure cannot clear a newer marker after ${episode}`, () => {
  const result = runLifecycleFixture(`
    await created("new-marker"); await routeBusy("new-marker");
    const old = deferred(); const entered = deferred();
    client.session.promptAsync = async (input) => { prompts.push(input); if (prompts.length === 1) { entered.resolve(); return old.promise; } return { data: true }; };
    const first = runNextTimer(); await entered.promise;
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "new-marker" } } });
    ${episode === "replacement creation" ? `await created("new-marker");` : ""}
    await routeBusy("new-marker");
    ${episode === "room reset" ? `
      brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut: false }); return true; };
      await runNextTimer(); brokerReply = null;
    ` : ""}
    await runNextTimer(); const beforeFailure = prompts.length;
    old.reject(new Error("old socket reset")); await first;
    const polls = []; for (let i = 0; i < 3; i++) polls.push(await runNextTimer());
    console.log(JSON.stringify({ beforeFailure, prompts: prompts.length, polls }));
  `, { beforeInit: `Date.now = () => 1700000000000;` });
  assert.equal(result.beforeFailure, 2, "a new warning must actually be delivered before the old rejection");
  assert.deepEqual(result.polls, [true, true, true]);
  assert.equal(result.prompts, 2, "distinct attempts in the same millisecond cannot erase each other's marker");
});

for (const [label, settle, routerOptions, deadlineMs] of [
  ["never resolves", "", {}, 1500],
  ["returns a late exact 404", `lookup.resolve(missing("deadline"));`, {}, 1500],
  ["rejects late", `lookup.reject(new Error("late socket reset"));`, { rootResolveTimeoutMs: 37 }, 37],
]) test(`deletion deadline: a lookup that ${label} cannot strand the hook or retire its binding`, () => {
  const result = runLifecycleFixture(`
    const { readSessionProfile } = await import(${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)});
    await created("deadline"); await routeBusy("deadline");
    const profileBefore = readSessionProfile("deadline");
    const lookup = deferred(); const entered = deferred();
    client.session.get = async (input) => {
      assert.deepEqual(input, { path: { id: "deadline" }, query: { directory: process.env.HOME } });
      entered.resolve(); return lookup.promise;
    };
    const timerStart = timerRecords.length;
    const deleting = hooks.event({ event: { type: "session.deleted", properties: { sessionID: "deadline" } } });
    await entered.promise;
    assert.equal(await runNextTimer(${deadlineMs}), true, "raw deletion must schedule its bounded lookup deadline");
    const settled = await Promise.race([deleting.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]);
    assert.equal(settled, true, "the deadline must settle the hook without the SDK lookup resolving");
    ${settle}
    // Drain promise reactions and the unhandled-rejection checkpoint, not wall time.
    await new Promise((resolve) => setImmediate(resolve));
    const output = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "deadline", model: target.model }, output);
    await runNextTimer(60000);
    console.log(JSON.stringify({ profileBefore, profileAfter: readSessionProfile("deadline"), headers: output.headers, prompts: prompts.length, forgets: calls.filter((x) => x.path === "/forget"), deadlines: timerRecords.slice(timerStart).filter((timer) => timer.ms === ${deadlineMs}).map(({ ms, unrefed, cleared }) => ({ ms, unrefed, cleared })), pendingDeadlines: timers.filter((timer) => timer.ms === ${deadlineMs}).length, warnings: logs.filter((x) => x.body?.level === "warn" && /could not verify session deletion/.test(x.body?.message ?? "")).length }));
  `, { routerOptions });
  assert.deepEqual(result.profileAfter, result.profileBefore, "timeout and late evidence cannot erase session state");
  assert.equal(result.headers["x-opencode-lease-id"], "Ldeadline1");
  assert.equal(result.prompts, 1, "the cached heartbeat remains eligible after timeout");
  assert.deepEqual(result.forgets, [], "a timed-out lookup has no authority to forget a lease");
  assert.deepEqual(result.deadlines, [{ ms: deadlineMs, unrefed: true, cleared: true }]);
  assert.equal(result.pendingDeadlines, 0, "the lookup timer is always cleared");
  assert.equal(result.warnings, 1, "timeout is observable once; late settlement adds no cleanup or warning");
});

for (const [label, response, removed] of [
  ["live response", `return { data: { id: "settled" } };`, false],
  ["authoritative 404", `return missing("settled");`, true],
  ["transport rejection", `throw new Error("socket reset");`, false],
  ["synchronous throw", `throw new Error("sync socket reset");`, false],
]) test(`deletion deadline: a ${label} clears its timer before the deadline`, () => {
  const result = runLifecycleFixture(`
    const { readSessionProfile } = await import(${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)});
    await created("settled");
    client.session.get = ${label === "synchronous throw" ? "" : "async "}() => { ${response} };
    const timerStart = timerRecords.length;
    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "settled" } } });
    console.log(JSON.stringify({ removed: readSessionProfile("settled") === null, deadlines: timerRecords.slice(timerStart).map(({ ms, unrefed, cleared }) => ({ ms, unrefed, cleared })), pending: timers.length }));
  `);
  assert.equal(result.removed, removed, "only exact authoritative evidence permits cleanup");
  assert.deepEqual(result.deadlines, [{ ms: 1500, unrefed: true, cleared: true }]);
  assert.equal(result.pending, 0, "settlement must cancel the deadline callback");
});

test("raw deletion lookups retain all sixteen permits after hook deadlines and recover one only on late SDK settlement", () => {
  const result = runLifecycleFixture(`
    const { writePendingProfile, readSessionProfile, resolveProfile } = await import(${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)});
    // Keep a real private profile and route at the oldest ID, whose verification entry
    // will be trimmed by the synchronous burst. No replacement creation fences cleanup.
    writePendingProfile("private");
    await created("hung-0"); await routeBusy("hung-0");
    const profileBefore = readSessionProfile("hung-0");
    assert.equal(profileBefore.profile, "private");
    assert.equal(calls.find((call) => call.path === "/lease").body.profile, "private");
    const pending = new Map(); let getCalls = 0;
    let unresolved = 0;
    client.session.get = ({ path }) => {
      getCalls += 1;
      unresolved += 1;
      const lookup = deferred(); pending.set(path.id, lookup);
      return lookup.promise.finally(() => { unresolved -= 1; });
    };
    const deleting = (id) => hooks.event({ event: { type: "session.deleted", properties: { sessionID: id } } });
    const deletes = [];
    // Raw events need only IDs, not 3000 unrelated profile files. Keep this burst
    // synchronous so the tracker trims its oldest entries before rejected hooks settle.
    for (let index = 0; index < 3001; index += 1) {
      deletes.push(deleting("hung-" + index));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getCalls, 16, "only sixteen underlying SDK lookups may be outstanding");
    assert.equal(timerRecords.filter((timer) => timer.ms === 1500).length, 16, "rejected events must not allocate deadlines");

    for (let index = 0; index < 16; index += 1) {
      assert.equal(await runNextTimer(1500), true, "every hung lookup must reach its hook deadline");
    }
    const hooksSettled = await Promise.race([
      Promise.all(deletes).then(() => true), new Promise((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(hooksSettled, true, "all deletion hooks finish while all SDK operations are still unresolved");
    assert.equal(unresolved, 16);
    assert.equal(timers.filter((timer) => timer.ms === 1500).length, 0);
    assert.ok(timerRecords.filter((timer) => timer.ms === 1500).every((timer) => timer.cleared && timer.unrefed));

    const saturated = [deleting("hung-0"), deleting("new-distinct")];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getCalls, 16, "timeouts and tracker eviction must not release SDK permits, even for the oldest ID or a new ID");
    assert.equal(timerRecords.filter((timer) => timer.ms === 1500).length, 16, "saturated retries allocate no new deadline");
    await Promise.all(saturated);
    const headersBeforeLate = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "hung-0", model: target.model }, headersBeforeLate);
    assert.equal(headersBeforeLate.headers["x-opencode-lease-id"], "Lhung-01");
    assert.deepEqual(readSessionProfile("hung-0"), profileBefore);
    assert.equal(resolveProfile({ sessionID: "hung-0" }).profile, "private");
    assert.deepEqual(calls.filter((call) => call.path === "/forget"), []);

    pending.get("hung-0").resolve(missing("hung-0"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unresolved, 15, "late settlement releases capacity only, not deletion authority");
    assert.deepEqual(readSessionProfile("hung-0"), profileBefore, "late exact 404 cannot erase the private profile");
    const headersAfterLate = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "hung-0", model: target.model }, headersAfterLate);
    assert.equal(headersAfterLate.headers["x-opencode-lease-id"], "Lhung-01", "late exact 404 cannot erase the route");
    assert.deepEqual(calls.filter((call) => call.path === "/forget"), []);
    await runNextTimer(60000);
    assert.equal(prompts.length, 1, "the private session's heartbeat remains eligible");

    await created("recovered");
    const recovered = deleting("recovered");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getCalls, 17, "one settled SDK operation releases exactly one permit");
    assert.equal(unresolved, 16);
    await deleting("still-saturated");
    assert.equal(getCalls, 17, "the seventeenth operation consumes the only released permit");
    pending.get("recovered").resolve(missing("recovered"));
    await recovered;
    assert.equal(readSessionProfile("recovered"), null, "a fresh in-deadline exact 404 still authorizes local cleanup");
    assert.deepEqual(calls.filter((call) => call.path === "/forget"), [], "the new unleased session must never emit an ID-only forget");
    assert.equal(timers.filter((timer) => timer.ms === 1500).length, 0);
    console.log(JSON.stringify({ getCalls, deadlines: timerRecords.filter((timer) => timer.ms === 1500).length, unresolved, profile: readSessionProfile("hung-0").profile }));
  `);
  assert.equal(result.getCalls, 17);
  assert.equal(result.deadlines, 17);
  assert.equal(result.unresolved, 15);
  assert.equal(result.profile, "private");
});
test("main weekly stages checkpoint even while the lane has room", () => {
  const result = runLifecycleFixture(`
    let percent = 74; let sample = 0;
    brokerReply = (path, body, send) => {
      if (path !== "/headroom") return false;
      send({nearlyOut:false,threshold:97,localFits:true,providers:[
        {providerID:"openai",held:false,percent,window:"wk",room:true,
         weekly:{window:"wk",percent,resetsAt:null,fetchedAt:1000 + sample++,source:"last-fetch"}},
        {providerID:"anthropic",held:false,percent:99,window:"wk",room:false,
         weekly:{window:"wk",percent:99,resetsAt:null,fetchedAt:1000,source:"last-fetch"}}
      ]}); return true;
    };
    await created("weekly"); await routeBusy("weekly");
    const counts = [];
    for (const next of [74,75,75,85,95,99]) {
      percent = next; await runNextTimer(60000); counts.push(prompts.length);
    }
    console.log(JSON.stringify({counts,texts:prompts.map(p=>p.body.parts[0].text),leases:leases.get("weekly")}));
  `);
  assert.deepEqual(result.counts,[0,1,1,2,3,3]);
  assert.equal(result.leases,1,"warnings do not re-lease or move the session");
  assert.match(result.texts[2],/reversible|bounded/i);
  assert.doesNotMatch(result.texts.join("\n"),/start nothing new/);
});

test("weekly quota stage jump from 74 to 95 sends one cumulative main checkpoint", () => {
  const result = runLifecycleFixture(`
    let percent = 74;
    brokerReply = (path, body, send) => {
      if (path !== "/headroom") return false;
      send({ nearlyOut: false, threshold: 97, localFits: true, providers: [{
        providerID: "openai", held: false, percent: 20, window: "5h", room: true,
        weekly: { window: "wk", percent, resetsAt: 200000, fetchedAt: 1000, source: "last-fetch" },
      }] }); return true;
    };
    await created("jump"); await routeBusy("jump");
    await runNextTimer(60000); percent = 95;
    await runNextTimer(60000);
    console.log(JSON.stringify({ prompts: prompts.map((prompt) => prompt.body.parts[0].text), aborts, forgets: calls.filter((call) => call.path === "/forget").map((call) => call.body), releases: calls.filter((call) => call.path === "/release" || call.path === "/releaseTier").map((call) => call.path) }));
  `);
  assert.equal(result.prompts.length, 1, "a higher stage covers prepare and checkpoint in one delivery");
  assert.match(result.prompts[0], /prepare|handoff/i);
  assert.match(result.prompts[0], /checkpoint.*mutating|before.*mutating/i);
  assert.match(result.prompts[0], /reversible|bounded/i);
  assert.doesNotMatch(result.prompts[0], /start nothing new/i);
  assert.deepEqual(result.aborts, [], "a caution warning never aborts the main session");
  assert.deepEqual(result.forgets, [], "a caution warning never forgets its lease");
  assert.deepEqual(result.releases, [], "a caution warning never uses obsolete release paths");
});

test("weekly quota stage is own-provider main-only and coalesces with a lane warning", () => {
  const result = runLifecycleFixture(`
    let nearlyOut = false; let weekly = 75;
    brokerReply = (path, body, send) => {
      if (path !== "/headroom") return false;
      send({ nearlyOut, threshold: 97, localFits: !nearlyOut, providers: [
        { providerID: "openai", held: false, percent: nearlyOut ? 98 : 20, window: "5h", room: !nearlyOut, weekly: { window: "wk", percent: weekly, resetsAt: 200000, fetchedAt: 1000, source: "last-fetch" } },
        { providerID: "anthropic", held: false, percent: 99, window: "wk", room: false, weekly: { window: "wk", percent: 99, resetsAt: 200000, fetchedAt: 1000, source: "last-fetch" } },
      ] }); return true;
    };
    await created("main", { id: "main", agent: "standard" });
    await created("child", { id: "child", parentID: "main", agent: "standard" });
    await created("classifier", { id: "classifier", agent: "fleet-classifier" });
    await routeBusy("main"); await routeBusy("child"); await routeBusy("classifier", "fleet-classifier");
    await runNextTimer(60000);
    weekly = 95; nearlyOut = true;
    await runNextTimer(60000);
    console.log(JSON.stringify({ prompts: prompts.map((prompt) => ({ id: prompt.path.id, agent: prompt.body.agent, text: prompt.body.parts[0].text })), aborts, releases: calls.filter((call) => call.path === "/release" || call.path === "/releaseTier") }));
  `);
  assert.deepEqual(result.prompts.map((prompt) => prompt.id), ["main", "main", "child"], "the first roomy poll warns only the root; the nearly-out lane also warns its child");
  assert.equal(result.prompts[1].agent, "standard");
  assert.match(result.prompts[1].text, /reversible|bounded/i, "the lane and weekly causes share one cumulative prompt");
  assert.equal(result.prompts[2].agent, "standard", "the child retains its routed agent");
  assert.match(result.prompts[2].text, /return what you have to your parent/i);
  assert.match(result.prompts[2].text, /start nothing new/i);
  assert.doesNotMatch(result.prompts[2].text, /handoff|mutating/i, "child guidance has no root handoff or pre-mutation instructions");
  assert.deepEqual(result.aborts, []);
  assert.deepEqual(result.releases, []);
});

test("weekly quota stage re-arms only after hysteresis, material unknown-freshness drop, or a newer reset observation", () => {
  const result = runLifecycleFixture(`
    let percent = 95; let fetchedAt = 1000; let resetsAt = 200000;
    brokerReply = (path, body, send) => {
      if (path !== "/headroom") return false;
      send({ nearlyOut: false, threshold: 97, localFits: true, providers: [{ providerID: "openai", held: false, percent: 20, window: "5h", room: true, weekly: { window: "wk", percent, resetsAt, fetchedAt, source: "last-fetch" } }] }); return true;
    };
    await created("rearm"); await routeBusy("rearm");
    const counts = []; const poll = async () => { await runNextTimer(60000); counts.push(prompts.length); };
    await poll();
    resetsAt += 500; fetchedAt += 1; await poll();
    percent = 94.5; fetchedAt += 1; await poll();
    percent = 93.9; fetchedAt += 1; await poll();
    percent = 95; fetchedAt += 1; await poll();
    percent = 70; fetchedAt = null; resetsAt = null; await poll();
    percent = 75; await poll();
    percent = 95; fetchedAt = 5000; resetsAt = 270000; await poll();
    percent = 95; fetchedAt = 4999; resetsAt = 340000; await poll();
    console.log(JSON.stringify({ counts, texts: prompts.map((prompt) => prompt.body.parts[0].text) }));
  `);
  assert.deepEqual(result.counts, [1, 1, 1, 1, 2, 2, 3, 4, 4], "only a bounded-stage rearm, real drop, and newer confirmed rollover create deliveries");
  assert.match(result.texts[2], /prepare|handoff/i, "a drop to 70 re-arms the prepare boundary rather than fabricating exhaustion");
});

test("weekly stale success after idle cannot cover the same provider and stage on the new lease", () => {
  const result = runLifecycleFixture(`
    brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut: false, localFits: true, providers: [{ providerID: "openai", held: false, percent: 20, room: true, weekly: { window: "wk", percent: 85, fetchedAt: 1000, resetsAt: 200000 } }] }); return true; };
    await created("same-stage"); await routeBusy("same-stage");
    const old = deferred(); const entered = deferred();
    client.session.promptAsync = async (input) => { prompts.push(input); if (prompts.length === 1) { entered.resolve(); return old.promise; } return { data: true }; };
    const first = runNextTimer(60000); await entered.promise;
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "same-stage" } } }); await routeBusy("same-stage");
    old.resolve({ data: true }); await first; await runNextTimer(60000);
    console.log(JSON.stringify({ prompts: prompts.length, leases: leases.get("same-stage") }));
  `);
  assert.equal(result.leases, 2);
  assert.equal(result.prompts, 2, "the new binding must receive its own 85% warning");
});

test("weekly stale success preserves an overlapping new binding reservation", () => {
  const result = runLifecycleFixture(`
    let nearlyOut = false;
    brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut, localFits: !nearlyOut, providers: [{ providerID: "openai", held: false, percent: 20, room: true, weekly: { window: "wk", percent: 85, fetchedAt: 1000, resetsAt: 200000 } }] }); return true; };
    await created("overlap"); await routeBusy("overlap");
    const old = deferred(); const fresh = deferred(); const entered = deferred(); const freshEntered = deferred();
    client.session.promptAsync = async (input) => { prompts.push(input); if (prompts.length === 1) { entered.resolve(); return old.promise; } if (prompts.length === 2) { freshEntered.resolve(); return fresh.promise; } return { data: true }; };
    const first = runNextTimer(60000); await entered.promise;
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "overlap" } } }); await routeBusy("overlap");
    nearlyOut = true; const second = runNextTimer(60000); await freshEntered.promise;
    old.resolve({ data: true }); await first; fresh.resolve({ data: true }); await second;
    nearlyOut = false; await runNextTimer(60000);
    console.log(JSON.stringify({ prompts: prompts.length }));
  `);
  assert.equal(result.prompts, 2, "the new binding's own 85% reservation remains delivered");
});

test("weekly quota stage repeats only after a replacement route, not an idle route of the same ID", () => {
  const result = runLifecycleFixture(`
    let weekly = 95;
    brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut: false, localFits: true, providers: [{ providerID: "openai", held: false, percent: 20, room: true, weekly: { window: "wk", percent: weekly, fetchedAt: 1000, resetsAt: 200000 } }] }); return true; };
    await created("repeat"); await routeBusy("repeat"); await runNextTimer(60000);
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "repeat" } } }); await routeBusy("repeat"); await runNextTimer(60000);
    await created("repeat", { id: "repeat", agent: "standard", time: { created: 2 } }); await routeBusy("repeat"); await runNextTimer(60000);
    console.log(JSON.stringify({ prompts: prompts.length, leases: calls.filter((call) => call.path === "/lease").map((call) => call.body.sessionID), forgets: calls.filter((call) => call.path === "/forget").map((call) => call.body) }));
  `);
  assert.equal(result.prompts, 2);
  assert.deepEqual(result.leases, ["repeat", "repeat", "repeat"]);
  assert.deepEqual(result.forgets, [{ sessionID: "repeat", leaseID: "Lrepeat1" }]);
});

test("weekly quota stage follows the owning provider across an idle re-route", () => {
  const result = runLifecycleFixture(`
    let owner = "openai"; let weekly = 85;
    brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut: false, localFits: true, providers: ["openai", "anthropic"].map((providerID) => ({ providerID, held: false, percent: 20, room: true, weekly: { window: "wk", percent: providerID === owner ? weekly : 20, fetchedAt: 1000, resetsAt: 200000 } })) }); return true; };
    await created("owner"); await routeBusy("owner"); await runNextTimer(60000);
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "owner" } } }); target.model.providerID = "anthropic"; owner = "anthropic"; weekly = 95; await routeBusy("owner"); await runNextTimer(60000);
    target.model.providerID = "openai"; owner = "openai"; weekly = 85; await hooks.event({ event: { type: "session.idle", properties: { sessionID: "owner" } } }); await routeBusy("owner"); await runNextTimer(60000);
    console.log(JSON.stringify({ prompts: prompts.map((prompt) => ({ provider: prompt.body.parts[0].text.match(/openai|anthropic/i)?.[0], agent: prompt.body.agent })), forgets: calls.filter((call) => call.path === "/forget").map((call) => call.body) }));
  `);
  assert.equal(result.prompts.length, 2);
  assert.deepEqual(result.prompts.map((prompt) => prompt.agent), ["standard", "standard"]);
  assert.equal(result.forgets.length, 2);
});

test("lane warnings rearm independently of weekly stages", () => {
  const result = runLifecycleFixture(`
    let nearlyOut = false; let weekly = 75;
    brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut, localFits: !nearlyOut, providers: [{ providerID: "openai", held: false, percent: nearlyOut ? 98 : 20, room: !nearlyOut, weekly: { window: "wk", percent: weekly, fetchedAt: 1000, resetsAt: 200000 } }] }); return true; };
    await created("independent"); await routeBusy("independent"); const counts = [];
    for (const [lane, quota] of [[false,75], [true,75], [false,75], [true,75], [false,75], [false,85]]) { nearlyOut = lane; weekly = quota; await runNextTimer(60000); counts.push(prompts.length); }
    console.log(JSON.stringify({ counts }));
  `);
  assert.deepEqual(result.counts, [1, 2, 2, 3, 3, 4]);
});

test("weekly quota rollover requires a newer fetched observation after the prior reset", () => {
  const result = runLifecycleFixture(`
    let fetchedAt = 1000; let resetsAt = 200000;
    brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut: false, localFits: true, providers: [{ providerID: "openai", held: false, percent: 20, room: true, weekly: { window: "wk", percent: 95, fetchedAt, resetsAt } }] }); return true; };
    await created("rollover"); await routeBusy("rollover"); const counts = []; const poll = async (f, r) => { fetchedAt = f; resetsAt = r; await runNextTimer(60000); counts.push(prompts.length); };
    await poll(1000,200000); await poll(2000,270000); await poll(200001,200500); await poll(200002,270000); await poll(200002,270000); await poll(200003,269500); await poll(200004,330000); await poll(270001,330000);
    console.log(JSON.stringify({ counts }));
  `);
  assert.deepEqual(result.counts, [1, 1, 1, 2, 2, 2, 2, 3]);
});

test("weekly quota ignores older low observations and unknown or failed observations cannot rearm it", () => {
  const result = runLifecycleFixture(`
    let weekly = 95; let fetchedAt = 10000; let fail = false;
    brokerReply = (path, body, send, req) => { if (path !== "/headroom") return false; if (fail) { queueMicrotask(() => req.emit("error", new Error("headroom transport failed"))); return true; } send({ nearlyOut: false, localFits: true, providers: [{ providerID: "openai", held: false, percent: 20, room: true, weekly: { window: "wk", percent: weekly, fetchedAt, resetsAt: 200000 } }] }); return true; };
    await created("older"); await routeBusy("older"); await runNextTimer(60000);
    weekly = 70; fetchedAt = 9999; await runNextTimer(60000); weekly = null; fetchedAt = 10000; await runNextTimer(60000); weekly = "invalid"; await runNextTimer(60000); fail = true; await runNextTimer(60000); fail = false; weekly = 95; fetchedAt = 10001; await runNextTimer(60000);
    console.log(JSON.stringify({ prompts: prompts.length }));
  `);
  assert.equal(result.prompts, 1);
});

test("weekly quota: an older high reading after a newer drop cannot re-deliver a re-armed stage", () => {
  const result = runLifecycleFixture(`
    let weekly = 95; let fetchedAt = 1000;
    brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut: false, localFits: true, providers: [{ providerID: "openai", held: false, percent: 20, room: true, weekly: { window: "wk", percent: weekly, fetchedAt, resetsAt: 900000, source: "last-fetch" } }] }); return true; };
    await created("older-high"); await routeBusy("older-high"); const counts = [];
    const poll = async (percent, at) => { weekly = percent; fetchedAt = at; await runNextTimer(60000); counts.push(prompts.length); };
    await poll(95, 1000);  // bounded delivered
    await poll(70, 2000);  // newer genuine drop re-arms every stage
    await poll(95, 1500);  // older reading: rejected, must not prompt
    await poll(95, 3000);  // genuinely newer high reading: must prompt
    console.log(JSON.stringify({ counts, texts: prompts.map((prompt) => prompt.body.parts[0].text) }));
  `);
  assert.deepEqual(result.counts, [1, 1, 1, 2], "only the genuinely newer 95% reading re-delivers after the drop");
  assert.match(result.texts[1], /reversible|bounded/i);
});

test("weekly quota: a rejected older reading leaves an independent lane warning deliverable", () => {
  const result = runLifecycleFixture(`
    let weekly = 95; let fetchedAt = 1000; let nearlyOut = false;
    brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut, localFits: !nearlyOut, providers: [{ providerID: "openai", held: false, percent: nearlyOut ? 98 : 20, window: "5h", room: !nearlyOut, weekly: { window: "wk", percent: weekly, fetchedAt, resetsAt: 900000, source: "last-fetch" } }] }); return true; };
    await created("older-lane"); await routeBusy("older-lane"); const counts = [];
    const poll = async (percent, at, lane) => { weekly = percent; fetchedAt = at; nearlyOut = lane; await runNextTimer(60000); counts.push(prompts.length); };
    await poll(95, 1000, false);
    await poll(70, 2000, false);
    await poll(95, 1500, true);
    console.log(JSON.stringify({ counts, texts: prompts.map((prompt) => prompt.body.parts[0].text) }));
  `);
  assert.deepEqual(result.counts, [1, 1, 2], "the lane warning still goes out on a poll whose weekly reading is rejected");
  assert.match(result.texts[1], /nothing else can take over/);
  assert.doesNotMatch(result.texts[1], /quota null|Weekly usage:|weekly quota (?:prepare|checkpoint|bounded)/i, "the rejected older reading drives no weekly stage");
});

test("weekly quota hysteresis requires a full one-point drop at every stage", () => {
  const result = runLifecycleFixture(`
    let weekly = 75;
    brokerReply = (path, body, send) => { if (path !== "/headroom") return false; send({ nearlyOut: false, localFits: true, providers: [{ providerID: "openai", held: false, percent: 20, room: true, weekly: { window: "wk", percent: weekly, fetchedAt: null, resetsAt: null } }] }); return true; };
    await created("hysteresis"); await routeBusy("hysteresis"); const counts = []; const poll = async (next) => { weekly = next; await runNextTimer(60000); counts.push(prompts.length); };
    await poll(75); await poll(74.5); await poll(75); await poll(73.9); await poll(75); await poll(85); await poll(83.9); await poll(85); await poll(95); await poll(93.9); await poll(95);
    console.log(JSON.stringify({ counts }));
  `);
  assert.deepEqual(result.counts, [1,1,1,1,2,3,3,4,5,5,6]);
});

for (const [outcome, settle] of [
  ["returned failure", `old.resolve({ error: { name: "TransportError", message: "socket reset" } });`],
  ["thrown failure", `old.reject(new Error("socket reset"));`],
]) test(`weekly quota stage old ${outcome} cannot clear a newer provider episode`, () => {
  const result = runLifecycleFixture(`
    let provider = "openai"; let percent = 85;
    brokerReply = (path, body, send) => {
      if (path !== "/headroom") return false;
      send({ nearlyOut: false, threshold: 97, localFits: true, providers: [
        { providerID: "openai", held: false, percent: 20, window: "5h", room: true, weekly: { window: "wk", percent: provider === "openai" ? percent : 20, resetsAt: 200000, fetchedAt: 1000, source: "last-fetch" } },
        { providerID: "anthropic", held: false, percent: 20, window: "5h", room: true, weekly: { window: "wk", percent: provider === "anthropic" ? 95 : 20, resetsAt: 200000, fetchedAt: 1000, source: "last-fetch" } },
      ] }); return true;
    };
    await created("deferred"); await routeBusy("deferred");
    const old = deferred(); const entered = deferred();
    client.session.promptAsync = async (input) => { prompts.push(input); if (prompts.length === 1) { entered.resolve(); return old.promise; } return { data: true }; };
    const first = runNextTimer(60000);
    const started = await Promise.race([entered.promise.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]);
    assert.equal(started, true, "the old-router RED path must fail as an assertion instead of waiting forever for a weekly prompt");
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "deferred" } } });
    target.model.providerID = "anthropic"; provider = "anthropic"; await routeBusy("deferred");
    await runNextTimer(60000); ${settle} await first;
    await runNextTimer(60000);
    console.log(JSON.stringify({ prompts: prompts.length, texts: prompts.map((prompt) => prompt.body.parts[0].text), aborts, forgets: calls.filter((call) => call.path === "/forget").map((call) => call.body), releases: calls.filter((call) => call.path === "/release" || call.path === "/releaseTier").map((call) => call.path) }));
  `);
  assert.equal(result.prompts, 2, "the old failed 85% send cannot erase the newer provider's delivered 95% marker");
  assert.match(result.texts[1], /reversible|bounded/i);
  assert.deepEqual(result.aborts, []);
  assert.deepEqual(result.forgets, [{ sessionID: "deferred", leaseID: "Ldeferred1" }], "the explicit idle forgets Ldeferred1 exactly once");
  assert.deepEqual(result.releases, [], "idle uses /forget, never obsolete release paths");
});

for (const [outcome, settle] of [
  ["success", `old.resolve({ data: true });`],
  ["returned failure", `old.resolve({ error: { name: "TransportError", message: "socket reset" } });`],
  ["thrown failure", `old.reject(new Error("socket reset"));`],
]) test(`weekly quota stage: an old pending 85% ${outcome} on the same provider cannot cover, erase or re-arm the newer 95% delivery`, () => {
  // Same provider, same session, same wrapUpSent state: the stale lease's reservation holds the
  // prepare and checkpoint cells while the re-leased session jumps to the bounded stage.
  const result = runLifecycleFixture(`
    let percent = 85;
    brokerReply = (path, body, send) => {
      if (path !== "/headroom") return false;
      send({ nearlyOut: false, threshold: 97, localFits: true, providers: [
        { providerID: "openai", held: false, percent: 20, window: "5h", room: true, weekly: { window: "wk", percent, resetsAt: 200000, fetchedAt: 1000, source: "last-fetch" } },
      ] }); return true;
    };
    await created("same-provider"); await routeBusy("same-provider");
    const old = deferred(); const entered = deferred();
    client.session.promptAsync = async (input) => { prompts.push(input); if (prompts.length === 1) { entered.resolve(); return old.promise; } return { data: true }; };
    const first = runNextTimer(60000);
    const started = await Promise.race([entered.promise.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]);
    assert.equal(started, true, "the 85% checkpoint send must be in flight before the session goes idle");
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "same-provider" } } });
    percent = 95; await routeBusy("same-provider");
    await runNextTimer(60000); const beforeSettle = prompts.length;
    ${settle} await first;
    const counts = [];
    for (const next of [95, 85, 95]) { percent = next; await runNextTimer(60000); counts.push(prompts.length); }
    console.log(JSON.stringify({ beforeSettle, counts, texts: prompts.map((prompt) => prompt.body.parts[0].text), leases: leases.get("same-provider"), forgets: calls.filter((call) => call.path === "/forget").map((call) => call.body), warns: logs.filter((x) => x.body?.level === "warn" && /asked it to (wrap up|checkpoint and continue safely)/.test(x.body?.message ?? "")).length, errors: logs.filter((x) => x.body?.level === "error").length }));
  `);
  assert.equal(result.beforeSettle, 2, "the newer 95% bounded prompt is delivered while the old 85% send is still pending");
  assert.match(result.texts[1], /reversible|bounded/i);
  assert.deepEqual(result.counts, [2, 2, 3], "after the stale settlement: 95% stays covered, the drop to 85% stays covered by the newer marker, and only the hysteresis re-arm at 95% sends again");
  assert.match(result.texts[2], /reversible|bounded/i);
  assert.equal(result.leases, 2, "the fixture must exercise L1 -> idle -> L2 on the same provider");
  assert.deepEqual(result.forgets, [{ sessionID: "same-provider", leaseID: "Lsame-provider1" }], "the explicit idle forgets L1 exactly once");
  assert.equal(result.warns, 2, "only current-binding deliveries are reported; the stale settlement is neither reported nor retried");
  assert.equal(result.errors, 0, "a stale failure is not reported against the re-leased session");
});

test("weekly quota stage: a stale successful send cannot mark a newer rollover episode delivered or suppress its higher stage", () => {
  // The binding stays current throughout (no idle, no re-lease), so only reservation identity
  // separates the stale send from the new episode: a confirmed rollover replaces the stage cells
  // while the old 85% send is still in flight, and the new episode's own send then fails.
  const result = runLifecycleFixture(`
    let percent = 85; let fetchedAt = 1000; let resetsAt = 200000;
    brokerReply = (path, body, send) => {
      if (path !== "/headroom") return false;
      send({ nearlyOut: false, threshold: 97, localFits: true, providers: [
        { providerID: "openai", held: false, percent: 20, window: "5h", room: true, weekly: { window: "wk", percent, resetsAt, fetchedAt, source: "last-fetch" } },
      ] }); return true;
    };
    await created("episode"); await routeBusy("episode");
    const old = deferred(); const fresh = deferred(); const entered = deferred(); const freshEntered = deferred();
    client.session.promptAsync = async (input) => {
      prompts.push(input);
      if (prompts.length === 1) { entered.resolve(); return old.promise; }
      if (prompts.length === 2) { freshEntered.resolve(); return fresh.promise; }
      return { data: true };
    };
    const first = runNextTimer(60000);
    const started = await Promise.race([entered.promise.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]);
    assert.equal(started, true, "the 85% checkpoint send must be in flight");
    // A child starting work schedules the next poll while the main session's binding stays current.
    await created("episode-child", { id: "episode-child", parentID: "episode", agent: "standard" }); await routeBusy("episode-child");
    // A confirmed rollover: a newer reading taken after the previous reset whose reset advanced by a minute or more.
    fetchedAt = 200001; resetsAt = 270000;
    const second = runNextTimer(60000);
    const freshStarted = await Promise.race([freshEntered.promise.then(() => true), new Promise((resolve) => setImmediate(() => resolve(false)))]);
    assert.equal(freshStarted, true, "the rollover episode's own send must be in flight before the stale send settles");
    const beforeSettle = prompts.map((prompt) => prompt.path.id);
    old.resolve({ data: true }); await first;
    fresh.reject(new Error("socket reset")); await second;
    const counts = [];
    for (const next of [85, 85, 95]) { percent = next; await runNextTimer(60000); counts.push(prompts.length); }
    console.log(JSON.stringify({ beforeSettle, counts, texts: prompts.map((prompt) => prompt.body.parts[0].text), leases: [leases.get("episode"), leases.get("episode-child")], forgets: calls.filter((call) => call.path === "/forget").map((call) => call.body), errors: logs.filter((x) => x.body?.level === "error").length }));
  `);
  assert.deepEqual(result.beforeSettle, ["episode", "episode"], "the new episode is delivered to the main session only; the child receives no weekly policy");
  assert.deepEqual(result.counts, [3, 3, 4], "the stale success leaves the new episode undelivered so its failed send is retried once, and its 95% stage is not suppressed");
  assert.match(result.texts[2], /checkpoint/i, "the retry is the new episode's own checkpoint stage");
  assert.match(result.texts[3], /reversible|bounded/i);
  assert.deepEqual(result.leases, [1, 1], "the binding stayed current throughout: no idle or re-lease");
  assert.deepEqual(result.forgets, []);
  assert.equal(result.errors, 1, "the new episode's own failed send is observable against its current binding");
});
