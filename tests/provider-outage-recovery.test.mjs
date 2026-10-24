import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;

// Each case gets a fresh HOME and module instance. Only the external broker, SDK,
// and clock are replaced: routing, classification, hooks and recovery are production.
const harness = `
  import assert from "node:assert/strict";
  import { createRequire } from "node:module";
  import { EventEmitter } from "node:events";
  import { mkdirSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  const http = createRequire(import.meta.url)("node:http");
  // Inventory publication uses the module's transport rather than the injected lease client.
  http.request = (options, callback) => {
    assert.equal(options.path, "/inventory");
    const req = new EventEmitter();
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.emit("data", JSON.stringify({ accepted: true }));
      response.emit("end");
    };
    req.destroy = () => {};
    req.setTimeout = () => {};
    return req;
  };
  mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
  mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
  writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), "{}");
  writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), "{}");
  const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
  const { classifyRoutingFailure, writeSessionProfile } = await import(${JSON.stringify(routingUrl)});
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const overload = { message: "upstream overloaded", statusCode: 503 };
  const context = { message: "request (90000 tokens) exceeds the available context size" };
  const cloud = { id: "gpt-luna", kind: "cloud", model: { providerID: "openai", id: "gpt-5.6-luna" } };
  const local = { id: "local-coder", kind: "local", model: { providerID: "llamacpp", id: "qwen3.5-9b-coder" } };
  const create = async ({ profile = "auto", agent = "worker", target = cloud, served = true } = {}) => {
    const id = "ses-recovery";
    const timers = [], prompts = [], calls = [], aborts = [], logs = [];
    const liveSession = () => ({ id, agent });
    const missingSession = () => ({
      response: { status: 404 },
      error: { name: "NotFoundError", data: { message: "Session not found: " + id } },
    });
    const state = { target, served, prompt: async () => ({ data: true }), preview: null, failure: null, abort: null, lease: null, sessionGet: liveSession };
    let clock = Date.now();
    Date.now = () => clock;
    const live = () => timers.filter((timer) => !timer.cancelled && !timer.fired);
    const fire = (delay) => {
      const timer = live().find((item) => delay === undefined || item.delay === delay);
      assert.ok(timer, "expected a live recovery timer" + (delay === undefined ? "" : " at " + delay));
      timer.fired = true;
      clock += timer.delay;
      return timer.fn();
    };
    const brokerRequest = async (path, body) => {
      calls.push({ path, body });
      if (path === "/lease") {
        if (state.lease) return state.lease(body);
        if (!state.served) throw Object.assign(new Error("no eligible target"), { code: "no-eligible-target" });
        return { leaseID: "lease-" + calls.length, target: state.target, decision: { policy: "weighted-depletion", reasons: [] } };
      }
      if (path === "/failure") return state.failure ? state.failure(body) : { kind: classifyRoutingFailure(body.error) };
      if (path === "/preview") return state.preview ? state.preview(body) : { preview: state.served ? { [body.tiers[0]]: state.target } : {} };
      return { ok: true };
    };
    const client = {
      app: { log: async (input) => { logs.push(input); return {}; } },
      session: {
        get: async () => state.sessionGet(),
        messages: async () => ({ data: [] }),
        prompt: async (input) => { prompts.push(input); return state.prompt(input); },
        abort: async (input) => { aborts.push(input); return state.abort?.(input); },
      },
    };
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {
      brokerRequest,
      setTimeout: (fn, delay) => {
        const timer = { fn, delay, cancelled: false, fired: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { timer.cancelled = true; },
    });
    const event = (type, properties = {}) => hooks.event({ event: { type, properties: { sessionID: id, ...properties } } });
    await event("session.created", { info: { id, agent } });
    writeSessionProfile(id, profile, { explicit: true });
    let messageNumber = 0;
    let currentMessageID = null;
    const chat = (parts = [{ type: "text", text: "work" }], messageID = "user-" + ++messageNumber) => {
      currentMessageID = messageID;
      return hooks["chat.message"](
        { sessionID: id, agent, model: { providerID: state.target.model.providerID, id: state.target.model.id } },
        { message: { id: messageID, model: {} }, parts },
      );
    };
    // The synthetic message is the chat hook for the prompt just dispatched above. Tests can
    // give it the engine-assigned message ID when correlating a recovery callback.
    const synthetic = (messageID, prompt = prompts.at(-1)) => chat(
      [{ ...prompt.body.parts[0] }],
      messageID,
    );
    const error = (error = overload) => event("session.error", { error });
    const abort = () => error({ name: "MessageAbortedError", data: { message: "Aborted" } });
    const assistantError = (error = overload, options = {}) => {
      const messageID = options.id ?? "assistant-error-" + ++messageNumber;
      // Undefined destructuring selects a default. Keep an explicit null parent
      // so fixtures can represent the bare identity OpenCode actually emits.
      const parentID = Object.hasOwn(options, "parentID") ? options.parentID : currentMessageID;
      const providerID = options.providerID ?? state.target.model.providerID;
      return event("message.updated", { info: {
        id: messageID, parentID, sessionID: id, role: "assistant", providerID, error,
      } });
    };
    const complete = (finish, extra = {}) => event("message.updated", { info: {
      id: "assistant-completed", sessionID: id, role: "assistant", time: { completed: clock }, finish, ...extra,
    } });
    const checkCurrentRoute = async (messageID = currentMessageID) => {
      const leaseCount = calls.filter((call) => call.path === "/lease").length;
      const model = { providerID: state.target.model.providerID, id: state.target.model.id };
      await hooks["chat.params"]({ sessionID: id, model, message: { id: messageID, model: {} } });
      assert.equal(calls.filter((call) => call.path === "/lease").length, leaseCount, "chat.params must not acquire another lease");
      return model;
    };
    const confirmDeleted = () => { state.sessionGet = missingSession; };
    const restoreLive = () => { state.sessionGet = liveSession; };
    return { id, state, hooks, live, fire, timers, prompts, calls, aborts, logs, chat, synthetic, event, error, abort, assistantError, complete, confirmDeleted, restoreLive, currentMessageID: () => currentMessageID, checkCurrentRoute };
  };
`;

function scenario(name, run, input) {
  test(name, () => {
    const home = mkdtempSync(join(tmpdir(), "fleet-provider-outage-"));
    try {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e",
        `${harness}\nawait (${run.toString()})(${JSON.stringify(input)});`], {
        env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
        encoding: "utf8",
        timeout: 60000,
      });
      assert.equal(child.status, 0, child.stderr || String(child.error));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const failure of [
  { message: "fetch failed" },
  { message: "read ECONNRESET", code: "ECONNRESET" },
  { message: "connection aborted by upstream", code: "ECONNRESET" },
]) {
  scenario(`known network outage recovers: ${failure.message}`, async (failure) => {
    const h = await create();
    await h.chat();
    await h.error(failure);
    assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
    await h.fire();
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0].body.agent, "worker");
  }, failure);
}

scenario("SDK failures back off through the third attempt and remain capped at sixty seconds", async () => {
  const h = await create();
  await h.chat();
  h.state.prompt = async () => { throw new TypeError("fetch failed"); };
  await h.error();
  for (const delay of [2500, 5000, 10000, 20000, 40000, 60000, 60000, 60000]) {
    assert.deepEqual(h.live().map((timer) => timer.delay), [delay]);
    await h.fire();
  }
  assert.equal(h.prompts.length, 8);
  assert.ok(h.prompts.every((prompt) => prompt.body.agent === "worker"));
});

// The gateway's no-live-lease refusal (gateway/lib/gateway.js), as opencode's SDK
// surfaces it: an APIError NamedError whose data carries the message, the HTTP status
// and the raw JSON body. The broker classifies it noop -- no provider is at fault --
// but the turn must resume on a fresh lease instead of waiting for a human resend.
const gatewayNoLease = '[opencode-broker] route unavailable; resend the prompt (gateway: session holds no live lease for "gpt-5.6-luna")';
const gatewayNoLeaseBody = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: gatewayNoLease } });
const sdkGatewayError = (statusCode, message = gatewayNoLease) => ({
  name: "APIError",
  data: { message, ...(statusCode === undefined ? {} : { statusCode }), responseBody: gatewayNoLeaseBody },
});
const relocatableNoLease = {
  "SDK APIError with the nested gateway message at HTTP 400": sdkGatewayError(400),
  "direct gateway message at HTTP 400": { message: gatewayNoLease, statusCode: 400 },
  "SDK APIError with the JSON body appended to its message at HTTP 400": sdkGatewayError(400, `Bad Request: ${gatewayNoLeaseBody}`),
  "legacy HTTP 409 gateway refusal": sdkGatewayError(409),
  "gateway refusal whose status the SDK lost": { name: "APIError", data: { message: gatewayNoLease } },
};

for (const [shape, failure] of Object.entries(relocatableNoLease)) {
  scenario(`gateway no-live-lease refusal resumes on a fresh lease despite the broker noop: ${shape}`, async (failure) => {
    const h = await create();
    await h.chat();
    h.state.failure = async () => ({ kind: "noop" });
    await h.error(failure);
    // OpenCode can deliver the same refusal twice; one recovery owns one timer.
    await h.error(failure);
    assert.deepEqual(h.live().map((timer) => timer.delay), [2500], "exactly one owned recovery timer");
    const leasesBefore = h.calls.filter((call) => call.path === "/lease").length;
    h.state.target = { ...cloud, id: "cloud-relocated" };
    h.state.prompt = async () => { await h.synthetic("recovery-relocated"); return { data: true }; };
    await h.fire();
    assert.equal(h.prompts.length, 1);
    const [part] = h.prompts[0].body.parts;
    assert.equal(part.synthetic, true);
    assert.match(part.text, /^\[opencode-broker\] The previous model had a provider outage and this session is being rerouted\./);
    assert.equal(h.prompts[0].body.agent, "worker");
    assert.equal(h.calls.filter((call) => call.path === "/lease").length, leasesBefore + 1, "the continuation takes a fresh lease");
    await h.checkCurrentRoute("recovery-relocated");
    assert.equal(h.live().length, 0, "an accepted continuation leaves no further timer");
  }, failure);
}

scenario("gateway no-live-lease refusal still resumes when the broker failure report is unreachable", async (failure) => {
  const h = await create();
  await h.chat();
  h.state.failure = async () => { throw new Error("broker socket closed"); };
  await h.error(failure);
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
}, relocatableNoLease["SDK APIError with the nested gateway message at HTTP 400"]);

scenario("a repeated no-live-lease refusal on the continuation backs off to the next delay", async (failure) => {
  const h = await create();
  await h.chat();
  h.state.failure = async () => ({ kind: "noop" });
  await h.error(failure);
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
  h.state.prompt = async () => ({ error: failure });
  await h.fire();
  assert.deepEqual(h.live().map((timer) => timer.delay), [5000]);
}, relocatableNoLease["SDK APIError with the nested gateway message at HTTP 400"]);

scenario("a relocated continuation that meets the gateway no-lane refusal stops instead of looping", async (failure) => {
  const h = await create();
  await h.chat();
  h.state.failure = async () => ({ kind: "noop" });
  await h.error(failure);
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
  h.state.prompt = async () => ({ error: { name: "APIError", data: {
    message: 'Bad Gateway: {"error":{"message":"gateway: no provider could serve the request: all smart routing targets are busy or unavailable","type":"upstream_error"}}',
    statusCode: 502,
  } } });
  await h.fire();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.live().length, 0, "a whole-lane refusal is terminal, not another relocate");
}, relocatableNoLease["SDK APIError with the nested gateway message at HTTP 400"]);

for (const [shape, failure] of Object.entries({
  "generic HTTP 400": { name: "APIError", data: { message: "invalid_request_error: messages.3.content.0.text must be a string", statusCode: 400 } },
  "the plugin's own route-unavailable throw": { message: "[opencode-broker] route unavailable; resend the prompt" },
  "the plugin's own route-unavailable wording at HTTP 400": { message: "[opencode-broker] route unavailable; resend the prompt", statusCode: 400 },
  "no-live-lease wording without the gateway prefix": { message: "route unavailable; resend the prompt (session holds no live lease)", statusCode: 400 },
  "gateway no-lane refusal": { message: 'Bad Gateway: {"error":{"message":"gateway: no provider could serve the request: all smart routing targets are busy or unavailable","type":"upstream_error"}}', statusCode: 502 },
  "gateway no-lane refusal without a status": { message: "gateway: no provider could serve the request: all smart routing targets are busy or unavailable" },
  "unrelated noop": { message: "routed model mismatch: expected openai/gpt-5.6-luna, got llamacpp/qwen3.5-9b" },
  "financial HTTP 402 carrying the gateway wording": sdkGatewayError(402),
  "HTTP 401 carrying the gateway wording": sdkGatewayError(401),
  "HTTP 403 carrying the gateway wording": sdkGatewayError(403),
  "HTTP 413 carrying the gateway wording": sdkGatewayError(413),
  "HTTP 422 carrying the gateway wording": sdkGatewayError(422),
  "HTTP 500 carrying the gateway wording": sdkGatewayError(500),
  "malformed request beside the gateway wording": sdkGatewayError(400, `${gatewayNoLease}: malformed request`),
  "permission refusal beside the gateway wording": sdkGatewayError(400, `${gatewayNoLease}: permission denied`),
  "an abort envelope carrying the gateway wording": { name: "MessageAbortedError", data: { message: gatewayNoLease } },
})) {
  scenario(`a broker noop stays terminal for ${shape}`, async (failure) => {
    const h = await create();
    await h.chat();
    h.state.failure = async () => ({ kind: "noop" });
    await h.error(failure);
    assert.equal(h.live().length, 0);
    assert.equal(h.prompts.length, 0);
  }, failure);
}

for (const brokerKind of ["auth", "payload", "model", "context", "abort"]) {
  scenario(`a terminal broker verdict still cancels the gateway no-live-lease refusal: ${brokerKind}`, async ({ brokerKind, failure }) => {
    const h = await create();
    await h.chat();
    h.state.failure = async () => ({ kind: brokerKind });
    await h.error(failure);
    assert.equal(h.live().length, 0);
    assert.equal(h.prompts.length, 0);
  }, { brokerKind, failure: relocatableNoLease["SDK APIError with the nested gateway message at HTTP 400"] });
}

for (const mode of ["manual", "classifier"]) {
  scenario(`${mode} sessions never relocate on the gateway no-live-lease refusal`, async ({ mode, failure }) => {
    const h = await create({ profile: mode === "manual" ? "manual" : "auto", agent: mode === "classifier" ? "fleet-classifier" : "worker" });
    await h.chat();
    h.state.failure = async () => ({ kind: "noop" });
    await h.error(failure);
    assert.equal(h.live().length, 0);
    assert.equal(h.prompts.length, 0);
  }, { mode, failure: relocatableNoLease["SDK APIError with the nested gateway message at HTTP 400"] });
}

scenario("a broker noop verdict overrides an otherwise retryable network signal", async () => {
  const h = await create();
  await h.chat();
  h.state.failure = async () => ({ kind: "noop" });
  await h.error({ message: "fetch failed" });
  assert.equal(h.live().length, 0);
});

scenario("a live lookup prevents a raw deletion event from cancelling recovery", async () => {
  const h = await create();
  await h.chat();
  await h.error();
  await h.event("session.deleted");
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
  await h.fire();
  assert.equal(h.prompts.length, 1);
});

for (const cancellation of ["user", "file", "mixed-file", "abort", "delete"]) {
  for (const outcome of ["error-result", "rejection"]) {
    scenario(`${cancellation} cancels a deferred continuation before ${outcome}`, async ({ cancellation, outcome }) => {
      const h = await create();
      await h.chat();
      const pending = deferred();
      h.state.prompt = () => pending.promise;
      await h.error();
      const running = h.fire();
      assert.equal(h.prompts.length, 1);
      if (cancellation === "user") await h.chat();
      if (cancellation === "file") await h.chat([{ type: "file", mime: "image/png", url: "file:///attachment.png" }]);
      if (cancellation === "mixed-file") await h.chat([
        { type: "text", text: "notification", synthetic: true },
        { type: "file", mime: "image/png", url: "file:///attachment.png" },
      ]);
      if (cancellation === "abort") await h.abort();
      if (cancellation === "delete") { h.confirmDeleted(); await h.event("session.deleted"); }
      if (outcome === "error-result") pending.resolve({ error: overload });
      else pending.reject(new TypeError("fetch failed"));
      await running;
      assert.equal(h.live().length, 0, "cancelled callbacks must not create a new recovery timer");
      assert.equal(h.prompts.length, 1, "cancellation must not send another continuation");
    }, { cancellation, outcome });
  }
}

for (const failure of [
  { message: "SDK serialization failed" },
  { message: "permission denied" },
  { message: "permission denied: overloaded permission service", statusCode: 503 },
  { message: "authentication failed", statusCode: 401 },
  { message: "invalid_request_error: malformed tool payload" },
  { message: "routed model mismatch" },
  { message: "prompt is too long" },
]) {
  scenario(`SDK failure stops rather than inheriting the old overload: ${failure.message}`, async (failure) => {
    const h = await create();
    await h.chat();
    h.state.prompt = async () => { throw Object.assign(new Error(failure.message), failure); };
    await h.error();
    await h.fire();
    assert.equal(h.live().length, 0);
    assert.equal(h.prompts.length, 1);
  }, failure);
}

scenario("local context overflow moves once to a larger lane with the original agent", async () => {
  const h = await create({ target: local, profile: "local" });
  await h.chat();
  await h.error(context);
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
  h.state.target = { ...local, id: "larger-local", model: { providerID: "llamacpp", id: "larger-local" } };
  h.state.prompt = async () => { await h.synthetic(); return { data: true }; };
  await h.fire();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].body.agent, "worker");
  assert.equal(h.calls.filter((call) => call.path === "/lease").at(-1).body.contextTokens, 90000);
  assert.equal(h.live().length, 0);
});

scenario("cloud context overflow cancels an already pending recovery even without a route", async () => {
  const h = await create();
  await h.chat();
  await h.error();
  await h.error(context);
  assert.equal(h.live().length, 0);
});

scenario("local context escape is one continuation, not an unlimited outage retry", async () => {
  const h = await create({ target: local, profile: "local" });
  await h.chat();
  await h.error(context);
  h.state.prompt = async () => { await h.synthetic(); return { data: true }; };
  await h.fire();
  await h.error(context);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.live().length, 0);
});

scenario("in-flight provider failures coalesce once per continuation and advance the backoff", async () => {
  const h = await create();
  await h.chat();
  await h.error();
  for (const delay of [2500, 5000, 10000, 20000, 40000, 60000, 60000]) {
    assert.deepEqual(h.live().map((timer) => timer.delay), [delay]);
    const pending = deferred();
    h.state.prompt = () => pending.promise;
    const running = h.fire();
    // No chat hook / new route is required to keep this owned session recoverable.
    await h.error();
    await h.error();
    assert.equal(h.live().length, 0, "no parallel continuation while the SDK call is pending");
    pending.resolve({ data: true });
    await running;
    assert.equal(h.live().length, 1, "one coalesced failure survives successful SDK acceptance");
  }
  assert.equal(h.prompts.length, 7);
});

scenario("duplicate message-error events from the previous attempt do not queue another continuation", async () => {
  const h = await create();
  await h.chat();
  const oldFailure = () => h.event("message.updated", { info: {
    id: "failed-attempt-one", sessionID: h.id, role: "assistant", providerID: "openai", error: overload,
  } });
  await oldFailure();
  const pending = deferred();
  h.state.prompt = () => pending.promise;
  const running = h.fire();
  await oldFailure();
  pending.resolve({ data: true });
  await running;
  assert.equal(h.live().length, 0);
});

scenario("no-lane refusal transfers exclusive ownership to the existing preview queue", async () => {
  const h = await create({ profile: "private", target: local });
  await h.chat();
  await h.error();
  h.state.served = false;
  h.state.prompt = async () => { await h.synthetic(); };
  await h.fire();
  assert.deepEqual(h.live().map((timer) => timer.delay), [60000]);
  h.state.served = true;
  h.state.prompt = async () => { await h.synthetic(); return { data: true }; };
  await h.fire();
  assert.equal(h.prompts.length, 2);
  assert.equal(h.live().length, 0);
  const leases = h.calls.filter((call) => call.path === "/lease");
  assert.ok(leases.every((call) => call.body.profile === "private"));
  const preview = h.calls.find((call) => call.path === "/preview");
  assert.equal(preview.body.profile, "private");
  assert.deepEqual(preview.body.tiers, [leases[0].body.tier]);
});

for (const cancellation of ["user", "abort", "delete", "nonretryable", "cloud-context"]) {
  scenario(`stale preview cannot resume after ${cancellation}`, async (cancellation) => {
    const h = await create({ served: false });
    await assert.rejects(h.chat(), /no eligible target/);
    const pending = deferred();
    const entered = deferred();
    h.state.preview = () => { entered.resolve(); return pending.promise; };
    const running = h.fire(60000);
    await entered.promise;
    h.state.served = true;
    if (cancellation === "user") await h.chat();
    if (cancellation === "abort") await h.abort();
    if (cancellation === "delete") { h.confirmDeleted(); await h.event("session.deleted"); }
    if (cancellation === "nonretryable") await h.error({ message: "permission denied" });
    if (cancellation === "cloud-context") await h.error(context);
    pending.resolve({ preview: { worker: cloud } });
    await running;
    assert.equal(h.prompts.length, 0);
    assert.equal(h.live().length, 0);
  }, cancellation);
}

scenario("observable AbortError after a router retry-abort still cancels recovery", async () => {
  const h = await create();
  await h.chat();
  await h.event("session.status", { status: { type: "retry", next: Date.now() + 90000, message: "upstream overloaded" } });
  assert.equal(h.aborts.length, 1);
  assert.equal(h.live().length, 1);
  await h.abort();
  assert.equal(h.live().length, 0);
});

scenario("AbortError delivered during the router abort await cannot resurrect recovery", async () => {
  const h = await create();
  await h.chat();
  h.state.abort = () => h.abort();
  await h.event("session.status", { status: { type: "retry", next: Date.now() + 90000, message: "upstream overloaded" } });
  assert.equal(h.live().length, 0);
});

scenario("a late provider event cannot revive an explicitly aborted route", async () => {
  const h = await create();
  await h.chat();
  await h.abort();
  await h.error();
  assert.equal(h.live().length, 0);
  // A real new message deliberately starts a new turn; its own failure is eligible.
  await h.chat();
  await h.error();
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
});

scenario("new user message while the broker failure report is pending prevents stale recovery", async () => {
  const h = await create();
  await h.chat();
  const pending = deferred();
  h.state.failure = () => pending.promise;
  const reporting = h.error();
  await h.chat();
  pending.resolve({ kind: "overload" });
  await reporting;
  assert.equal(h.live().length, 0);
});

for (const finish of ["stop", "length", "content-filter"]) {
  scenario(`terminal assistant ${finish} cancels recovery after its route was deleted`, async (finish) => {
    const h = await create();
    await h.chat();
    await h.error();
    await h.complete(finish);
    assert.equal(h.live().length, 0);
  }, finish);
}

for (const finish of ["tool-calls", "unknown"]) {
  scenario(`nonterminal assistant ${finish} and generic idle do not cancel provider recovery`, async (finish) => {
    const h = await create();
    await h.chat();
    await h.error();
    await h.complete(finish);
    await h.event("session.idle");
    assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
    await h.fire();
    assert.equal(h.prompts.length, 1);
  }, finish);
}

scenario("compaction summary completion does not cancel the unfinished conversation's recovery", async () => {
  const h = await create();
  await h.chat();
  await h.error();
  await h.complete("stop", { summary: true });
  assert.equal(h.live().length, 1);
});

scenario("a synthetic notification takes the active turn without a concurrent recovery prompt", async () => {
  const h = await create();
  await h.chat();
  await h.error();
  await h.fire();
  await h.synthetic();
  await h.error();
  await h.chat([{ type: "text", text: "background job finished", synthetic: true }]);
  assert.equal(h.live().length, 0);
  await h.error();
  assert.deepEqual(h.live().map((timer) => timer.delay), [5000], "notification preserves the recovery episode, not a human reset");
});

scenario("identified failure on the active recovery parent remains recoverable", async () => {
  const h = await create();
  await h.chat(undefined, "user-a");
  await h.error({ message: "fetch failed" });
  await h.fire();
  await h.synthetic("recovery-a");
  await h.assistantError({ message: "fetch failed" }, {
    id: "assistant-recovery-a", parentID: "recovery-a", providerID: "openai",
  });
  assert.deepEqual(h.live().map((timer) => timer.delay), [5000]);
});

scenario("an HTTP permission refusal never retries despite overload wording", async () => {
  const h = await create();
  await h.chat();
  h.state.prompt = async () => ({ error: { message: "upstream overloaded", statusCode: 403 } });
  await h.error();
  await h.fire();
  assert.equal(h.live().length, 0);
});

scenario("switching a parked session to Manual cancels preview resumption", async () => {
  const h = await create({ served: false });
  await assert.rejects(h.chat(), /no eligible target/);
  writeSessionProfile(h.id, "manual", { explicit: true });
  h.state.served = true;
  await h.fire(60000);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.live().length, 0);
});

for (const cancellation of ["user", "abort", "delete"]) {
  scenario(`delayed no-lane lease cannot repark a continuation after ${cancellation}`, async (cancellation) => {
    const h = await create();
    await h.chat();
    await h.error();
    const lease = deferred();
    const entered = deferred();
    h.state.lease = () => { entered.resolve(); return lease.promise; };
    h.state.prompt = async () => { await h.synthetic(); };
    const running = h.fire();
    await entered.promise;
    h.state.lease = null;
    if (cancellation === "user") await h.chat();
    if (cancellation === "abort") await h.abort();
    if (cancellation === "delete") { h.confirmDeleted(); await h.event("session.deleted"); }
    lease.reject(Object.assign(new Error("no eligible target"), { code: "no-eligible-target" }));
    await running;
    assert.equal(h.live().length, 0);
    assert.equal(h.prompts.length, 1);
  }, cancellation);
}

scenario("a cancelled SDK callback cannot cancel the new user's recovery owner", async () => {
  const h = await create();
  await h.chat(undefined, "user-before-cancellation");
  await h.error();
  const pending = deferred();
  h.state.prompt = () => pending.promise;
  const running = h.fire();
  await h.chat(undefined, "user-after-cancellation");
  await h.assistantError(overload, { id: "assistant-after-cancellation", parentID: h.currentMessageID() });
  pending.reject(new Error("permission denied"));
  await running;
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
});

scenario("provider failure reported during SDK acceptance is retained until its broker report finishes", async () => {
  const h = await create();
  await h.chat();
  await h.error();
  const prompt = deferred();
  h.state.prompt = () => prompt.promise;
  const running = h.fire();
  const report = deferred();
  h.state.failure = () => report.promise;
  const failing = h.error();
  prompt.resolve({ data: true });
  await running;
  assert.equal(h.live().length, 0, "failure circuit is still being reported");
  report.resolve({ kind: "overload" });
  await failing;
  assert.deepEqual(h.live().map((timer) => timer.delay), [5000]);
});

for (const mode of ["manual", "classifier", "unrouted"]) {
  scenario(`${mode} sessions never start provider recovery`, async (mode) => {
    const h = await create({ profile: mode === "manual" ? "manual" : "auto", agent: mode === "classifier" ? "fleet-classifier" : "worker" });
    if (mode !== "unrouted") await h.chat();
    await h.error();
    assert.equal(h.live().length, 0);
    assert.equal(h.prompts.length, 0);
  }, mode);
}

for (const { name, parts, settle } of [
  { name: "unsettled SDK callback", parts: [{ type: "text", text: "new work" }], settle: false },
  { name: "settled SDK callback after file-only C", parts: [{ type: "file", mime: "image/png", url: "file:///new-c.png" }], settle: true },
  { name: "settled SDK callback after mixed-file C", parts: [
    { type: "text", text: "new work" },
    { type: "file", mime: "image/png", url: "file:///new-c.png" },
  ], settle: true },
]) {
  scenario(`late bare B session.error cannot charge or delete C after ${name}`, async ({ parts, settle }) => {
    const h = await create();
    await h.chat(undefined, "user-b");
    await h.error({ message: "fetch failed" });
    const pending = deferred();
    h.state.prompt = () => pending.promise;
    const running = h.fire();
    h.state.target = { ...cloud, id: "cloud-c" };
    await h.chat(parts, "user-c");
    const cModel = await h.checkCurrentRoute("user-c");
    const failuresBeforeLateB = h.calls.filter((call) => call.path === "/failure").length;
    const leasesBeforeLateB = h.calls.filter((call) => call.path === "/lease").length;
    if (settle) {
      pending.resolve({ data: true });
      await running;
    }
    // OpenCode emits this actual SDK schema without a provider or message ID.
    await h.error({ message: "fetch failed" });
    assert.equal(h.live().length, 0, "an unattributable late B error must not schedule C recovery");
    assert.equal(h.calls.filter((call) => call.path === "/failure").length, failuresBeforeLateB, "late B must not report failure against C");
    assert.equal(h.calls.filter((call) => call.path === "/lease").length, leasesBeforeLateB, "late B must not replace C's lease");
    assert.deepEqual(await h.checkCurrentRoute("user-c"), cModel, "C route and model remain usable");
  }, { parts, settle });
}

scenario("stale identified B assistant.error on C's provider is ignored by parentID", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  await h.fire();
  const bParentID = h.currentMessageID();
  h.state.target = { ...cloud, id: "cloud-c" };
  await h.chat(undefined, "user-c");
  const cModel = await h.checkCurrentRoute("user-c");
  const failuresBeforeB = h.calls.filter((call) => call.path === "/failure").length;
  const leasesBeforeB = h.calls.filter((call) => call.path === "/lease").length;
  await h.assistantError({ message: "fetch failed" }, {
    id: "assistant-b", parentID: bParentID, providerID: "openai",
  });
  assert.equal(h.live().length, 0);
  assert.equal(h.calls.filter((call) => call.path === "/failure").length, failuresBeforeB);
  assert.equal(h.calls.filter((call) => call.path === "/lease").length, leasesBeforeB);
  assert.deepEqual(await h.checkCurrentRoute("user-c"), cModel);
});

scenario("identified C failure recovers while B terminal completion cannot cancel C", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  await h.fire();
  const bParentID = h.currentMessageID();
  h.state.target = { ...cloud, id: "cloud-c" };
  await h.chat(undefined, "user-c");
  await h.assistantError({ message: "fetch failed" }, {
    id: "assistant-c", parentID: "user-c", providerID: "openai",
  });
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500], "C's identified error owns recovery");
  await h.complete("stop", { id: "assistant-b-completed", parentID: bParentID, providerID: "openai" });
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500], "B completion must not cancel C's recovery");
  await h.fire();
  assert.equal(h.prompts.length, 2, "B and C each dispatched one continuation");
});

scenario("unattributable post-supersession errors preserve C while AbortError still cancels", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  const pending = deferred();
  h.state.prompt = () => pending.promise;
  h.fire();
  h.state.target = { ...cloud, id: "cloud-c" };
  await h.chat(undefined, "user-c");
  const cModel = await h.checkCurrentRoute("user-c");
  const failuresBeforeUnknown = h.calls.filter((call) => call.path === "/failure").length;
  const bareError = {
    id: "assistant-without-parent", parentID: null, sessionID: h.id, role: "assistant",
    providerID: "openai", error: { message: "fetch failed" },
  };
  assert.equal(bareError.parentID, null, "fixture must not default a missing parent to C");
  await h.event("message.updated", { info: bareError });
  assert.equal(h.live().length, 0);
  assert.equal(h.calls.filter((call) => call.path === "/failure").length, failuresBeforeUnknown);
  assert.deepEqual(await h.checkCurrentRoute("user-c"), cModel);
  assert.ok(h.logs.some((entry) => /unattributable/i.test(entry.body?.message)), "unattributable errors are reported without touching C");
  await h.assistantError({ message: "fetch failed" }, {
    id: "assistant-c", parentID: "user-c", providerID: "openai",
  });
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
  await h.abort();
  assert.equal(h.live().length, 0, "AbortError remains a cancellation even without correlation identity");
});

scenario("unattributable retry status after supersession cannot charge C", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  await h.fire();
  await h.chat(undefined, "user-c");
  const failuresBefore = h.calls.filter((call) => call.path === "/failure").length;
  await h.event("session.status", {
    status: { type: "retry", next: Date.now() + 90000, message: "upstream overloaded" },
  });
  assert.equal(h.calls.filter((call) => call.path === "/failure").length, failuresBefore);
  assert.equal(h.aborts.length, 0);
  assert.ok(h.logs.some((entry) => /unattributable provider retry/i.test(entry.body?.message)));
});

scenario("a later identified D failure remains recoverable after C succeeded behind an ambiguity fence", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  await h.fire();
  await h.chat(undefined, "user-c");
  await h.complete("stop", { id: "assistant-c-completed", parentID: "user-c", providerID: "openai" });
  await h.chat(undefined, "user-d");
  await h.assistantError({ message: "fetch failed" }, {
    id: "assistant-d", parentID: "user-d", providerID: "openai",
  });
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
});

scenario("session deletion clears fenced attribution state for a genuinely new session", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  await h.fire();
  await h.chat(undefined, "user-c");
  h.confirmDeleted();
  await h.event("session.deleted");
  h.restoreLive();
  await h.event("session.created", { info: { id: h.id, agent: "worker" } });
  await h.chat(undefined, "user-new");
  await h.error({ message: "fetch failed" });
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
});

scenario("a completed B recovery permanently fences late bare errors after C", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  h.state.prompt = async () => { await h.synthetic("recovery-b"); return { data: true }; };
  await h.error({ message: "fetch failed" });
  await h.fire();
  await h.complete("stop", { id: "assistant-b-done", parentID: "recovery-b", providerID: "openai" });
  h.state.target = { ...cloud, id: "cloud-c" };
  await h.chat(undefined, "user-c");
  const cModel = await h.checkCurrentRoute("user-c");
  const failuresBefore = h.calls.filter((call) => call.path === "/failure").length;
  await h.error({ message: "fetch failed" });
  assert.equal(h.live().length, 0);
  assert.equal(h.calls.filter((call) => call.path === "/failure").length, failuresBefore);
  assert.deepEqual(await h.checkCurrentRoute("user-c"), cModel);
});

scenario("stale B completion and idle cannot forget C or poison C context", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  h.state.prompt = async () => { await h.synthetic("recovery-b"); return { data: true }; };
  await h.error({ message: "fetch failed" });
  await h.fire();
  h.state.target = { ...cloud, id: "cloud-c" };
  await h.chat(undefined, "user-c");
  const cModel = await h.checkCurrentRoute("user-c");
  await h.complete("stop", {
    id: "assistant-b-done", parentID: "recovery-b", providerID: "openai",
    tokens: { input: 90000, output: 1 },
  });
  await h.event("session.idle");
  assert.equal(h.calls.filter((call) => call.path === "/forget").length, 0);
  assert.deepEqual(await h.checkCurrentRoute("user-c"), cModel);
  await h.assistantError({ message: "fetch failed" }, { id: "assistant-c", parentID: "user-c", providerID: "openai" });
  h.state.prompt = async () => { await h.synthetic("recovery-c"); return { data: true }; };
  await h.fire();
  assert.equal(h.calls.filter((call) => call.path === "/lease").at(-1).body.contextTokens, 0);
});

scenario("identified C terminal completion still releases C on idle after a fenced B", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  await h.fire();
  await h.chat(undefined, "user-c");
  await h.complete("stop", { id: "assistant-c-done", parentID: "user-c", providerID: "openai" });
  await h.event("session.idle");
  const forget = h.calls.filter((call) => call.path === "/forget").at(-1);
  assert.equal(forget.body.sessionID, h.id);
  assert.equal(forget.body.completed, true);
});

scenario("an evicted recovery fence rejects bare errors and retries until C is identified again", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  await h.fire();
  await h.chat(undefined, "user-c");
  const failuresBefore = h.calls.filter((call) => call.path === "/failure").length;
  for (let n = 0; n <= 2000; n += 1) {
    await h.event("session.created", { sessionID: `ses-churn-${n}`, info: { id: `ses-churn-${n}`, agent: "worker" } });
  }
  await h.error({ message: "fetch failed" });
  await h.event("session.status", { status: { type: "retry", next: Date.now() + 90000, message: "upstream overloaded" } });
  assert.equal(h.calls.filter((call) => call.path === "/failure").length, failuresBefore);
  assert.equal(h.aborts.length, 0);
  await h.chat(undefined, "user-c-again");
  await h.assistantError({ message: "fetch failed" }, {
    id: "assistant-c-again", parentID: "user-c-again", providerID: "openai",
  });
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
});

scenario("a stale B recovery hook cannot take C ownership without B's prompt part id", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  h.state.prompt = async () => ({ data: true });
  await h.fire();
  const bPrompt = h.prompts.at(-1);
  assert.match(bPrompt.body.parts[0].id, /^prt_/);
  h.state.target = { ...cloud, id: "cloud-c" };
  await h.chat(undefined, "user-c");
  await h.assistantError({ message: "fetch failed" }, { id: "assistant-c", parentID: "user-c", providerID: "openai" });
  const pending = deferred();
  h.state.prompt = () => pending.promise;
  const running = h.fire();
  await h.synthetic("recovery-c");
  await assert.rejects(h.synthetic("recovery-b", bPrompt), /cancelled continuation/);
  assert.equal(h.live().length, 0);
  await h.assistantError({ message: "fetch failed" }, { id: "assistant-c-again", parentID: "recovery-c", providerID: "openai" });
  pending.resolve({ data: true });
  await running;
  assert.deepEqual(h.live().map((timer) => timer.delay), [5000]);
});

scenario("a recovery text without an id cannot claim C before C dispatches its prompt", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  await h.fire();
  const bPrompt = h.prompts.at(-1);
  h.state.target = { ...cloud, id: "cloud-c" };
  await h.chat(undefined, "user-c");
  await h.assistantError({ message: "fetch failed" }, {
    id: "assistant-c", parentID: "user-c", providerID: "openai",
  });
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500]);
  const idlessRecovery = { ...bPrompt.body.parts[0] };
  delete idlessRecovery.id;
  await assert.rejects(h.chat([idlessRecovery], "recovery-b"), /cancelled continuation/);
  assert.deepEqual(h.live().map((timer) => timer.delay), [2500], "C's timer remains active");
  await h.fire();
  assert.equal(h.prompts.length, 2, "C retains recovery ownership");
});

scenario("a notification retires B's prompt identity before its old hook arrives", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  await h.error({ message: "fetch failed" });
  await h.fire();
  const bPrompt = h.prompts.at(-1);
  await h.chat([{ type: "text", text: "background job finished", synthetic: true }], "notification-active");
  await assert.rejects(h.synthetic("recovery-b", bPrompt), /cancelled continuation/);
  await h.assistantError({ message: "fetch failed" }, {
    id: "assistant-notification", parentID: "notification-active", providerID: "openai",
  });
  assert.deepEqual(h.live().map((timer) => timer.delay), [5000], "notification keeps the episode backoff");
});

scenario("missing C identity after supersession cannot charge an arbitrary assistant parent", async () => {
  const h = await create();
  await h.chat(undefined, "user-b");
  h.state.prompt = async () => { await h.synthetic("recovery-b"); return { data: true }; };
  await h.error({ message: "fetch failed" });
  await h.fire();
  await h.complete("stop", { id: "assistant-b-done", parentID: "recovery-b", providerID: "openai" });
  await h.hooks["chat.message"](
    { sessionID: h.id, agent: "worker", model: { providerID: "openai", id: "gpt-5.6-luna" } },
    { message: { id: null, model: {} }, parts: [{ type: "text", text: "C without engine identity" }] },
  );
  const failuresBefore = h.calls.filter((call) => call.path === "/failure").length;
  await h.assistantError({ message: "fetch failed" }, { id: "assistant-unknown", parentID: "arbitrary-parent", providerID: "openai" });
  assert.equal(h.calls.filter((call) => call.path === "/failure").length, failuresBefore);
  assert.ok(h.logs.some((entry) => /unattributable/i.test(entry.body?.message)));
});
