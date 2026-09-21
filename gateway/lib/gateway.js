// The gateway: an OpenAI-compatible endpoint that gives every dumb HTTP client
// the broker's routing.
//
// Services that speak only "OPENAI_BASE_URL + key + model name" (a memory
// service's ingestion model, Open WebUI, a voice assistant, anything similar) get
// pinned models and no failover.
// This gateway accepts their requests, leases a model from the broker per
// request (constrained to providers it can actually forward to -- OAuth-only
// providers are not forwardable by a generic proxy), rewrites the model field,
// forwards, reports usage and failures back to the broker, and retries once
// on a fresh lease when a provider fails. Pinning becomes routing.
//
// Two response shapes, one routing path: buffered JSON, and a
// real SSE passthrough for clients that hard-require token-by-token output.
// The streaming path costs exactly one thing -- the retry window shrinks to
// "before the first frame reaches the client" -- and nothing else: usage is
// still accounted, failures still indict, circuits still open. See
// relayStream() and THE FAILOVER BOUNDARY in completions().
//
// Auth: every request must present the gateway key (a 0600 drop file) --
// this endpoint fronts paid quota. Provider keys are read from opencode's
// auth store at request time and never logged.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Constant-time comparison of the presented bearer header with the expected one. Hashing
// first gives both sides the same length, which timingSafeEqual requires.
const sameSecret = (presented, expected) => timingSafeEqual(
  createHash("sha256").update(String(presented)).digest(),
  createHash("sha256").update(String(expected)).digest(),
);

const DEFAULT_TIER = "worker";
const ATTEMPTS = 2;
// A GPU model swap measures ~2m40s. The wait is bounded, config-overridable,
// and only ever spent before the first byte -- see leaseWithPrepare().
const PREPARE_WAIT_MS = 180_000;
const PREPARE_RETRY_MS = 5_000;
// ☠️ THE STREAM WATCHDOG'S FLOOR IS NOT timeoutMs. `timeoutMs` is deliberately
// SHORT on a local lane (15s live) so the buffered path fails over inside the
// caller's patience -- and inheriting that as the streaming stall window is a
// trap for exactly the case streaming exists to serve: any lane behind a
// prepareCommand is by definition sometimes COLD. Measured on a local lane: a
// worst-case ~39,321-token prefill at 476 tok/s is ~83s, plus a one-time ~35s
// PTX JIT after a cold CUDA load -- ~118s before the first token of a
// perfectly healthy generation. A 15s window guillotines that every time.
// 180s covers it with margin and still catches a genuine hang; a lane that
// wants to give up sooner sets streamIdleMs explicitly.
const STREAM_IDLE_MS = 180_000;

// The broker refuses a lease with HTTP 400 and a structured body:
//   { error: "<prose>", code: "target-preparing" | "no-eligible-local-target" | ... }
// The broker client (lib/client.js) copies the body's fields onto the rejected
// Error, so the code arrives as `error.code`.
// ☠️ READ THE FIELD, NEVER THE PROSE. The router's own comment calls the
// wording an unversioned API that nobody may fix, and the code exists precisely
// to stop consumers regexing it -- re-creating that coupling here would undo
// the fix. ☆ The consequence is deliberate: a refusal from an older client that
// carries no code, or any code outside the one we act on, is FINAL. The gateway
// waits only when it has been told in machine-readable terms that waiting helps.
const PREPARING = "target-preparing";
const isPreparing = (refusal) => refusal?.code === PREPARING;
// A local-only lane with no resident model; waited out only by a name with `waitForLocal`.
const ABSENT_LOCAL = "no-eligible-local-target";
// ☠️ AND A BROKER THAT IS RESTARTING. The broker client retries a refused socket once, 250 ms
// later, which a restart (~1-2 s) outlasts, so every request a `waitForLocal` name had parked in
// the wait loop failed the moment the broker was bounced -- measured: 36 waiting ingestion
// requests stopped at one broker restart. For such a name an unreachable broker is one more
// thing to wait out on the same budget. The same shapes the client itself treats as transient.
const BROKER_UNREACHABLE = /broker timeout|ECONNREFUSED|ECONNRESET|EPIPE|ENOENT/;
const brokerUnreachable = (error) => !error?.code && BROKER_UNREACHABLE.test(String(error?.message ?? ""));
// A resident local model with every slot taken. Unlike a swap it
// clears within one job, and it is the case where waiting is what gets unattended work done
// on local hardware instead of dropped -- so EVERY request waits on it, mapped or not.
const BUSY = "target-busy";
const isBusy = (refusal) => refusal?.code === BUSY;

// A wait a departing client can cut short: the tab is gone, and the swap it was
// waiting for is nobody's business any more.
const sleep = (ms, signal) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener?.("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener?.("abort", done, { once: true });
});

// ☠️ NO PROFILE NAME MAY APPEAR IN THIS FILE. Which profiles exist, and which
// model name reaches which one, is deployment data -- the gateway only knows
// that a client's `model` field is a ROUTING REQUEST it may honour, not a model
// id it must obey. Config shape:
//
//   "modelProfiles": {
//     "<name a client may ask for>": "<broker profile>",
//     "<name>": { "profile": "<broker profile>", "maxContextTokens": 39321 },
//     "<name>": { "profile": "<broker profile>", "bodyExtras": { "chat_template_kwargs": null } }
//   }
//
// ☆ The object form exists because `maxContextTokens` is per-PROVIDER
// while a window is per-MODEL. One llama.cpp provider serves a 9b with a small
// operational ceiling and a 27b with a 64k window; without a per-name override
// the deployment must choose which of those two to get wrong.
const modelRoute = (config, requested) => {
  const entry = config?.modelProfiles?.[String(requested ?? "")];
  if (!entry) return null;
  const profile = typeof entry === "string" ? entry : entry?.profile;
  if (typeof profile !== "string" || !profile) return null;
  const cap = Number(typeof entry === "string" ? Number.NaN : entry?.maxContextTokens);
  // ☠️ HOW LONG TO WAIT IS THE CALLER'S POLICY, not the broker's. The broker answers
  // "target-preparing" whenever it SPAWNS a prepareCommand -- it cannot know the command then
  // declined (model-swap's in-use guard exits 0 and the broker spawns it detached with stdio
  // ignored), so a decline reads exactly like a swap in progress and the wait runs to the full
  // budget before failing. That is right for a consumer that wants the model and wrong for one
  // that would rather be told now: a chat model is worth three minutes, a wiki lookup is not.
  // ☆ >= 0, not > 0: 0 means DO NOT WAIT and must survive, so this cannot reuse the
  // "falsy means default" idiom the provider caps use.
  const wait = Number(typeof entry === "string" ? Number.NaN : entry?.prepareWaitMs);
  // ☆ Same shape of problem as maxContextTokens, different axis: `timeoutMs` is
  // per-PROVIDER while how long a generation TAKES is per-model and per-task. One
  // local lane serves a small model a latency-critical caller wants to give up on
  // in seconds and a large one whose honest answer is half a minute; a single
  // provider value has to be wrong for one of them, and wrong short is worse --
  // it aborts a generation that was going to succeed. A mapped name may raise (or
  // lower) its own ceiling without moving anyone else's.
  // ☆ > 0, not >= 0, unlike prepareWaitMs: a zero-length timeout would abort every
  // request instantly and is never what a deployment means, so falsy-means-default
  // is the right idiom here.
  const timeout = Number(typeof entry === "string" ? Number.NaN : entry?.timeoutMs);
  // ☆ And the same again for the request body. A provider's `bodyExtras` is right for
  // most of what that lane serves -- say, thinking off on every local model -- and wrong
  // for the one model whose deployment wants that model's own default. A mapped name's
  // `bodyExtras` is layered over the provider's, key by key; a key set to null injects
  // nothing, so the client's own value (or the model's default) stands. It rides with
  // the name to whichever lane serves it.
  const extras = typeof entry === "string" ? null : entry?.bodyExtras;
  // ☠️ WORK THAT MUST NOT BE DROPPED WAITS FOR ITS MODEL TO COME BACK. A local-only lane
  // refuses with `no-eligible-local-target` while its model is not resident (a server
  // restart, a swap that displaced it), and that refusal is terminal for everyone else:
  // an interactive caller would rather be told. For a background writer it is data loss --
  // a memory service that treats a failed extraction as "no memories" never retries it.
  // `waitForLocal: true` waits that refusal out on the same budget as a busy slot.
  const waitForLocal = typeof entry === "string" ? false : entry?.waitForLocal === true;
  return {
    profile,
    waitForLocal,
    maxContextTokens: Number.isFinite(cap) && cap > 0 ? cap : null,
    prepareWaitMs: Number.isFinite(wait) && wait >= 0 ? wait : null,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : null,
    bodyExtras: extras && typeof extras === "object" && !Array.isArray(extras) ? extras : null,
  };
};

// The default location; bin/opencode-broker-gateway also honours
// $OPENCODE_BROKER_GATEWAY_CONFIG and the pre-rename location.
export const DEFAULT_GATEWAY_CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode-broker/gateway.json");
// The id `GET /v1/models` lists for "let the broker pick". Any name that is not
// mapped in modelProfiles routes the same way, so this only decides what a
// client's model picker shows.
const DEFAULT_ROUTED_MODEL_ID = "routed";

export const loadGatewayConfig = (path = DEFAULT_GATEWAY_CONFIG) => {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const providers = raw.providers && typeof raw.providers === "object" ? raw.providers : {};
  if (!Object.keys(providers).length) throw new Error("gateway config has no providers");
  const modelProfiles = {};
  for (const [name, entry] of Object.entries(raw.modelProfiles && typeof raw.modelProfiles === "object" ? raw.modelProfiles : {})) {
    // Ceiling: this rejects only a MALFORMED entry (no profile, or a non-string
    // one). It cannot reject a well-formed name the router no longer defines --
    // modelRoute checks the shape, never the router's profile list. Such a model
    // starts fine and 502s on every request, the broker refusing the lease with
    // "invalid routing profile". Validating for real needs a profile-discovery
    // endpoint the broker does not have; until then, retire the gateway's model
    // entry BEFORE removing the router profile it names.
    const route = modelRoute({ modelProfiles: { [name]: entry } }, name);
    if (!route) throw new Error(`modelProfiles["${name}"] must name a routing profile`);
    modelProfiles[name] = route;
  }
  return {
    tier: typeof raw.tier === "string" ? raw.tier : DEFAULT_TIER,
    profile: typeof raw.profile === "string" ? raw.profile : "auto",
    providers,
    modelProfiles,
    routedModelId: typeof raw.routedModelId === "string" && raw.routedModelId ? raw.routedModelId : DEFAULT_ROUTED_MODEL_ID,
    ...(Number.isFinite(Number(raw.prepareWaitMs)) ? { prepareWaitMs: Number(raw.prepareWaitMs) } : {}),
    ...(Number.isFinite(Number(raw.prepareRetryMs)) ? { prepareRetryMs: Number(raw.prepareRetryMs) } : {}),
  };
};

const providerKey = (providerConfig, authPath = join(homedir(), ".local/share/opencode/auth.json")) => {
  if (!providerConfig.authRef) return null;
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  const entry = auth[providerConfig.authRef];
  // An expired OAuth access token would bounce as "revoked"; failing here
  // routes the request to another lane instead of burning the attempt.
  if (Number.isFinite(entry?.expires) && Date.now() > entry.expires) {
    throw new Error(`credential for ${providerConfig.authRef} is expired (a session touching the provider refreshes it)`);
  }
  const key = entry?.key ?? entry?.apiKey ?? entry?.access ?? null;
  if (!key) throw new Error(`no credential for ${providerConfig.authRef} in the auth store`);
  return key;
};

// A timeout or a client disconnect is OUR impatience or the client's
// abandonment, not proof the provider is down. Both paths (buffered fetch,
// streaming body read) classify with this one predicate so they can never
// drift apart -- the drift is what quarantined a healthy anthropic in 0.2.1.
const isAbort = (error) => error?.name === "AbortError"
  || error?.name === "TimeoutError"
  || /abort/i.test(String(error?.message ?? ""));

// ── SSE ──────────────────────────────────────────────────────────────────────

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // ☆ Reverse proxies buffer a normal 200 by default, which turns
  // token-by-token into one lump at the end -- i.e. back into the buffered
  // path with extra steps. nginx and friends honour this hint.
  "X-Accel-Buffering": "no",
};

const DONE_FRAME = "data: [DONE]\n\n";

// An SSE frame ends at a blank line, and the spec permits CR, LF or CRLF as the
// line break -- so the boundary is a regex, not indexOf("\n\n").
const SSE_FRAME_END = /\r?\n\r?\n/;

// A frame's payload is every `data:` line joined by newlines. llama.cpp and
// OpenAI both emit exactly one, but a multi-line frame must not parse as
// garbage and get relayed as a content-less chunk.
const sseData = (frame) => frame
  .split(/\r?\n/)
  .filter((line) => line.startsWith("data:"))
  .map((line) => line.slice(5).replace(/^ /, ""))
  .join("\n");

// The one shape an OpenAI-compatible client recognises as "the stream failed":
// a data frame whose object is an error envelope. OpenAI's own API emits this
// mid-stream, so clients that handle real OpenAI already handle it.
const errorFrame = (message) => `data: ${JSON.stringify({
  error: { message: `gateway: ${message}`, type: "upstream_error", param: null, code: null },
})}\n\n`;

// The Responses API's own terminal failure: an `error` event. Its streams have no [DONE].
const responsesErrorFrame = (message) => `event: error\ndata: ${JSON.stringify({
  type: "error", code: "upstream_error", message: `gateway: ${message}`, param: null,
})}\n\n`;

// ☠️ NEVER REPORT ZERO USAGE. A stream still spent tokens even when the
// upstream ignored stream_options and told us nothing: a 0/0 report teaches the
// budget ledger that this lane is free, and the depletion balancer then pours
// traffic into the provider it believes is idle -- the ledger corrupts silently
// and only surfaces as a surprise bill. chars/4 is the same serviceable
// estimate leaseOnce() already uses for context sizing; `estimated` rides along
// so a reader of the ledger can tell a measurement from a guess (the broker
// ignores fields it does not know).
// ── the two request shapes ──────────────────────────────────────────────────
// The gateway forwards OpenAI's Chat Completions API and its Responses API. Leasing, lane
// extras, failover and accounting are the same for both; what differs is the upstream path,
// who may serve it, where usage lives, and how a stream ends.
// ☠️ A LANE SERVES /responses ONLY WHEN ITS CONFIG SAYS SO (`responsesApi: true`). llama.cpp
// serves it natively; Anthropic's compat endpoint and most OpenAI-compatible clouds do not.
// Offering them a /responses lease would get a 404 scored as a provider fault, and every such
// request would indict the lane until its circuit opened -- taking it away from chat traffic too.
const CHAT = { name: "chat", path: "/chat/completions" };
const RESPONSES = { name: "responses", path: "/responses" };

// Usage in either dialect: chat says prompt/completion, responses says input/output.
const readUsage = (usage) => ({
  input: Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0,
  output: Number(usage?.completion_tokens ?? usage?.output_tokens) || 0,
});

const estimateUsage = (requestBody, outputChars) => ({
  input: Math.ceil(JSON.stringify(requestBody ?? {}).length / 4),
  output: Math.ceil(outputChars / 4),
  estimated: true,
});

// Pump an upstream SSE body at the client, learning usage on the way.
//
// Frames are relayed VERBATIM rather than re-serialized: an upstream may ship
// fields this gateway has never heard of (reasoning deltas, logprobs, provider
// extensions) and the client asked that provider's dialect, not ours. The only
// frames that do not pass through untouched are the ones we are responsible
// for: the usage tail we asked for ourselves, and error frames.
//
// `relayed` is the whole ballgame -- see THE FAILOVER BOUNDARY below.
const relayStream = async ({ stream, sink, keepUsageFrames, touch, api = CHAT }) => {
  const decoder = new TextDecoder();
  let buffer = "";
  let relayed = false;
  let usage = null;
  let outputChars = 0;
  let streamError = null;
  let sawDone = false;

  const emit = (raw) => { relayed = true; sink.write(raw); };

  // Returns false to stop reading this upstream.
  const onFrame = (text, terminator) => {
    const raw = text + terminator;
    const data = sseData(text);
    if (!data) {
      // A comment/heartbeat frame (`: ping`, what OpenRouter-style proxies send
      // while a queue drains) carries nothing the client needs. ☆ Dropping it
      // until real content flows keeps the response head uncommitted, so a lane
      // that pings for ten seconds and THEN dies can still fail over.
      if (relayed) emit(raw);
      return true;
    }
    if (data.trim() === "[DONE]") { sawDone = true; emit(raw); return true; }
    let event = null;
    try { event = JSON.parse(data); } catch { emit(raw); return true; }
    // A responses stream fails with an `error` event or a `response.failed` whose
    // response carries the error; a chat stream with an error envelope.
    const failure = event?.error
      ?? (api === RESPONSES && event?.type === "error" ? event : null)
      ?? (api === RESPONSES && event?.type === "response.failed" ? (event.response?.error ?? event) : null);
    if (failure) {
      streamError = new Error(String(failure?.message ?? JSON.stringify(failure)).slice(0, 400));
      // An error frame with the wire still clean is a dead lane, not a dead
      // request: swallow it so the caller can fail over and the client never
      // learns this attempt happened.
      if (relayed) emit(raw);
      return false;
    }
    // Chat puts usage on the tail chunk; responses on the response that
    // `response.completed` carries (earlier events carry `usage: null`).
    const reported = event?.usage ?? event?.response?.usage;
    if (reported && typeof reported === "object") usage = readUsage(reported);
    for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
      const piece = choice?.delta?.content;
      if (typeof piece === "string") outputChars += piece.length;
    }
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") outputChars += event.delta.length;
    // ☠️ The usage tail frame exists because WE asked for it, so it must not
    // reach a client that did not. Its `choices` is an empty array, and client
    // code written against a stream it configured itself reads
    // `chunk.choices[0].delta` -- a TypeError, not a no-op. Strip it, keep the
    // number.
    if (!keepUsageFrames && event?.usage && Array.isArray(event.choices) && event.choices.length === 0) return true;
    emit(raw);
    return true;
  };

  try {
    for await (const chunk of stream) {
      touch();
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let live = true;
      let match;
      while (live && (match = SSE_FRAME_END.exec(buffer))) {
        const text = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        live = onFrame(text, match[0]);
      }
      if (!live) break;
    }
    // An upstream that ends its last frame without the trailing blank line
    // still owes us that frame -- most often the [DONE] we need to see.
    if (buffer.trim()) onFrame(buffer.replace(/[\r\n]+$/, ""), "\n\n");
  } catch (error) {
    streamError = error;
  }
  return { relayed, usage, outputChars, error: streamError, sawDone };
};

// ☆ A lane that ignored `stream: true` and answered with one whole JSON body
// still answered. The client was promised an event stream and cannot be handed
// a bare object mid-protocol, and quarantining an otherwise healthy lane over a
// dialect gap would punish every buffered request too -- so the body is dressed
// as the stream it should have been. Usage comes straight off the payload, so
// this path accounts exactly, not by estimate.
const relayBufferedAsStream = async ({ response, sink, keepUsageFrames }) => {
  let payload;
  try { payload = await response.json(); } catch {
    return { relayed: false, usage: null, outputChars: 0, sawDone: false,
      error: new Error("upstream returned 200 with an unparseable JSON body") };
  }
  const created = Number(payload?.created) || Math.floor(Date.now() / 1000);
  const head = { id: String(payload?.id ?? `chatcmpl-gw-${created}`), object: "chat.completion.chunk", created, model: String(payload?.model ?? "") };
  let outputChars = 0;
  const frames = [];
  (Array.isArray(payload?.choices) ? payload.choices : []).forEach((choice, index) => {
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    outputChars += content.length;
    frames.push({ ...head, choices: [{ index, delta: { role: choice?.message?.role ?? "assistant", content }, finish_reason: null }] });
    frames.push({ ...head, choices: [{ index, delta: {}, finish_reason: choice?.finish_reason ?? "stop" }] });
  });
  const usage = payload?.usage && typeof payload.usage === "object" ? readUsage(payload.usage) : null;
  if (usage && keepUsageFrames) frames.push({ ...head, choices: [], usage: payload.usage });
  for (const frame of frames) sink.write(`data: ${JSON.stringify(frame)}\n\n`);
  sink.write(DONE_FRAME);
  return { relayed: true, usage, outputChars, error: null, sawDone: true };
};

export const createGatewayHandler = ({
  config,
  brokerRequest,
  fetchImpl = fetch,
  gatewayKey,
  authPath,
  now = Date.now,
}) => {
  const allowedProviders = Object.keys(config.providers);

  // WHO ASKED, per gateway session: the client's address and the model name it sent. Every
  // gateway request is a fresh `gw-...` session, so without this the broker's decision and
  // usage logs cannot tell one consumer from another -- a memory service's ingestion, a
  // document extractor and a chat UI all read as anonymous gateway traffic.
  const callers = new Map();
  const callerOf = (sessionID) => callers.get(sessionID);
  const leaseOnce = async (sessionID, requestBody, excludeProviders = [], route = null, api = CHAT) => {
    // Local targets are strict: an unknown context size never fits them, so a
    // lease without contextTokens can never land local. chars/4 is the usual
    // serviceable estimate for OpenAI-shaped payloads.
    const contextTokens = Math.ceil(JSON.stringify(requestBody ?? {}).length / 4);
    // A prompt can FIT a local model's context window and still be hopeless on
    // its hardware: a 26k-token prefill pinned the single llama.cpp slot for
    // many minutes and starved every other consumer (measured live). Providers
    // may declare maxContextTokens -- an operational ceiling, not the model's.
    // ☆ A named model's own ceiling REPLACES the provider's for that request.
    // The provider cap is an operational floor-guard chosen for the lane's
    // ordinary traffic; a client that asked for a specific model asked for that
    // model's window, and the broker still applies the real per-target rule
    // (declared context x localContextHeadroom) underneath either number.
    const override = Number(route?.maxContextTokens);
    const routeCap = Number.isFinite(override) && override > 0 ? override : null;
    const providers = allowedProviders.filter((id) => {
      if (excludeProviders.includes(id)) return false;
      if (api === RESPONSES && config.providers[id]?.responsesApi !== true) return false;
      const cap = routeCap ?? Number(config.providers[id]?.maxContextTokens);
      return !(Number.isFinite(cap) && cap > 0 && contextTokens > cap);
    });
    if (!providers.length) {
      throw new Error(api === RESPONSES && !allowedProviders.some((id) => config.providers[id]?.responsesApi === true)
        ? "no configured lane serves /v1/responses (set responsesApi: true on one that does)"
        : "every forwardable provider was excluded this attempt");
    }
    const lease = await brokerRequest("/lease", {
      sessionID,
      // A mapped name leases THAT profile; everything else leases the
      // configured one, which is the default.
      profile: route?.profile ?? config.profile,
      // ☆ The tier rides along unchanged even on a profile lease: the broker
      // routes a profile within its own lane and ignores the tier there, and
      // sending the real one keeps /selection and decisions.jsonl honest about
      // which consumer asked.
      tier: config.tier,
      replace: true,
      contextTokens,
      providers,
      ...(callerOf(sessionID) ? { caller: callerOf(sessionID) } : {}),
    });
    const model = lease?.target?.model;
    if (!model?.providerID || !model?.id) {
      const refusal = new Error(String(lease?.error ?? "broker returned no target"));
      // ☆ A refusal that arrives as a 200 body rather than the 400 the broker
      // actually sends keeps its code too, so the caller reads one field either way.
      if (typeof lease?.code === "string") refusal.code = lease.code;
      throw refusal;
    }
    return { sessionID, providerID: model.providerID, modelID: model.id };
  };

  const prepareWaitMs = Number(config.prepareWaitMs) > 0 ? Number(config.prepareWaitMs) : PREPARE_WAIT_MS;
  const prepareRetryMs = Number(config.prepareRetryMs) > 0 ? Number(config.prepareRetryMs) : PREPARE_RETRY_MS;

  // "target-preparing" means the broker just kicked off a model swap and this
  // WILL clear -- passing that 400 straight through would show a human an error
  // for a machine that is already fixing itself. So: wait, bounded, and retry.
  //
  // ☠️ WAITING IS ONLY LEGAL BEFORE THE FIRST BYTE, and this is structurally on
  // the safe side of that line: a lease refusal happens before anything is
  // forwarded, so nothing can have been relayed yet. It must STAY there --
  // NOTHING in this loop may touch the sink. One keep-alive comment frame would
  // commit the 200 and forfeit both the retry and the ability to answer 502.
  //
  // ☠️ ONLY A MAPPED REQUEST WAITS. A background ingestion client does not care which
  // model it gets and has nobody watching it: holding its request for three
  // minutes to swap in a GPU model it never asked for is strictly worse than
  // the immediate failure it would otherwise get, and "an unmapped name routes exactly as before"
  // is the promise this whole feature is built under. A named model is the
  // opposite case -- a human picked it from a dropdown and meant it.
  // The effective wait for a request: a mapped name's own budget when it declared one, else the
  // deployment default. ONE place decides, so the deadline, the loop and the error message cannot
  // disagree about how long the caller actually waited.
  // ☠️ `typeof === "number"`, never Number(): modelRoute normalizes an absent budget to NULL, and
  // Number(null) is 0, not NaN -- so a Number()-based guard reads "no budget declared" as "do not
  // wait at all" and silently strips the wait from every mapped name. Cost four tests.
  const waitFor = (route) => (typeof route?.prepareWaitMs === "number" && route.prepareWaitMs >= 0
    ? route.prepareWaitMs
    : prepareWaitMs);

  const leaseWithPrepare = async (sessionID, requestBody, excluded, route, clientAbort, deadline, api = CHAT) => {
    for (;;) {
      try { return await leaseOnce(sessionID, requestBody, excluded, route, api); } catch (refusal) {
        // A swap is waited out only for a mapped name (the rule below); a busy slot is waited
        // out for everyone. The deadline is the request's own either way.
        const absentLocal = route?.waitForLocal === true &&
          (refusal?.code === ABSENT_LOCAL || brokerUnreachable(refusal));
        if (!isBusy(refusal) && !(route && isPreparing(refusal)) && !absentLocal) throw refusal;
        // ☠️ A ZERO BUDGET IS "TELL ME NOW", NOT "WAIT ZERO SECONDS". Rethrow the broker's own
        // refusal untouched -- it carries the real reason and the machine-readable code, and
        // rewriting it as "the gateway waited 0s" would be both noise and a lie.
        const budget = waitFor(route);
        if (budget === 0) throw refusal;
        const left = deadline - now();
        // ☆ The swap outlives our patience often enough to say so plainly: the
        // message is what a human sees in the picker, and "try again shortly"
        // is actionable where a bare 502 is not.
        if (left <= 0) throw new Error(`${refusal.message} -- the gateway waited ${Math.round(budget / 1000)}s and it is still ${isBusy(refusal) ? "busy" : "not resident"}; try again shortly`);
        if (clientAbort?.aborted) throw new Error("client disconnected");
        await sleep(Math.min(prepareRetryMs, left), clientAbort);
      }
    }
  };

  const settle = async (sessionID, path, body = {}) => {
    try { await brokerRequest(path, { sessionID, ...body }); } catch { /* broker hiccup must not fail the request */ }
  };

  const reportUsage = async (leased, tokens) => settle(leased.sessionID, "/usage", {
    ...(callerOf(leased.sessionID) ? { caller: callerOf(leased.sessionID) } : {}),
    providerID: leased.providerID,
    modelID: leased.modelID,
    requests: 1,
    tokens: { input: tokens.input, output: tokens.output },
    ...(tokens.estimated ? { estimated: true } : {}),
  });

  // `sink` present == the client asked for SSE and gets frames instead of a
  // payload; absent == the buffered path, unchanged since 0.1.0.
  const completions = async (requestBody, clientAbort = null, sink = null, api = CHAT, caller = null) => {
    const streaming = Boolean(sink);
    const wantedJson = Boolean(requestBody?.response_format?.type?.startsWith?.("json"));
    // Did the CLIENT ask for the usage tail, or only we? (See the strip in
    // relayStream: the difference decides whether it reaches them.)
    const keepUsageFrames = requestBody?.stream_options?.include_usage === true;
    // The client's `model` is a routing request. Unmapped -> null -> every lease
    // below is byte-identical to a gateway with no modelProfiles at all.
    const route = modelRoute(config, requestBody?.model);
    // ☠️ ONE BROKER SESSION PER CLIENT REQUEST, NOT PER ATTEMPT. A one-shot id
    // per attempt makes the retry compete with the attempt it is retrying: on a
    // capacity-1 target the gateway's own outstanding lease is the thing
    // standing in its way, and the client is told "no provider could serve the
    // request" -- true, and completely misleading. Measured live: lease granted
    // 15:59:51, forward failed, retry refused 16:00:06 as "not FREE". Reusing
    // the id makes it structurally impossible: /lease carries `replace: true`,
    // which exists for exactly "same session, give me a different target" and
    // deletes the held lease before selecting. ☆ It also collapses the
    // decisions.jsonl trail for one curl from 19 unrelated ids down to one.
    const sessionID = `gw-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (caller) callers.set(sessionID, caller);
    try {
      return await completionsFor(sessionID, requestBody, clientAbort, sink, api, route, streaming, wantedJson, keepUsageFrames);
    } finally {
      callers.delete(sessionID);
    }
  };
  const completionsFor = async (sessionID, requestBody, clientAbort, sink, api, route, streaming, wantedJson, keepUsageFrames) => {
    let lastError = null;
    const excluded = [];
    // ☠️ A PROFILE-MAPPED REQUEST MUST NOT EXCLUDE ITS OWN LANE. The exclusion
    // (0.2.2) exists because the gateway picks among the providers IT can
    // forward to for a TIER: dropping the one that just failed sends the retry
    // somewhere else. A profile lease is not that choice -- the broker picks
    // inside the profile's lane, which the gateway cannot see and must not
    // model. Excluding there gambles that the profile has a second lane, and
    // for the case this feature exists to serve (one local target behind a
    // prepareCommand) it provably does not: the retry is refused, and the
    // refusal reads as "nothing can serve you" rather than "we just dropped the
    // only thing that could".
    const excludeLane = (providerID) => { if (!route) excluded.push(providerID); };
    // ☠️ ONE deadline for the whole request, not one per attempt: a retry after
    // a failed forward must not buy itself a second full swap window and turn a
    // 3-minute ceiling into a 6-minute one.
    // A mapped name may shorten (or refuse) the wait; anything else gets the deployment default.
    const deadline = now() + waitFor(route);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let leased;
      try { leased = await leaseWithPrepare(sessionID, requestBody, excluded, route, clientAbort, deadline, api); }
      catch (error) { lastError = error; break; }
      const providerConfig = config.providers[leased.providerID];
      if (!providerConfig?.baseUrl) {
        await settle(leased.sessionID, "/release");
        lastError = new Error(`no forward config for ${leased.providerID}`);
        continue;
      }
      // A stale local credential is OUR problem, not the provider's: indicting
      // it here would quarantine a healthy lane the same way timeout reports
      // did. Release, skip the lane for this request, move on.
      let key;
      try { key = providerKey(providerConfig, authPath); } catch (error) {
        await settle(leased.sessionID, "/release");
        excludeLane(leased.providerID);
        lastError = error;
        continue;
      }
      // A provider slower than the CLIENT's own patience helps nobody: time
      // the upstream out early enough that the retry (a fresh lease, other
      // lanes) still lands inside the caller's window. Client disconnects
      // abort the upstream too -- no orphaned generations.
      // ☆ A mapped name's own ceiling wins over the lane's, the same precedence
      // maxContextTokens uses: the more specific statement is the more informed
      // one. It is deliberately NOT clamped to the provider value -- raising it
      // is the whole point, and a deployment that wanted the lane's number back
      // simply omits the override.
      const timeoutMs = Number(route?.timeoutMs) || Number(providerConfig.timeoutMs) || 25_000;
      // ☆ An explicit per-lane value always wins; otherwise the floor applies,
      // so a short buffered timeout can never shrink the streaming window.
      // ☠️ ON THE STREAMING PATH THIS IS THE ONLY CLOCK -- it starts with the
      // request, not with the first frame. Splitting it (timeoutMs until the
      // response head, streamIdleMs after) reads better and is a trap: node's
      // own http server does not flush a head until something is written, and
      // an upstream that holds its head until the first token would then still
      // be judged by the buffered timeout on exactly the cold start this exists
      // to survive. One clock cannot be wrong about which half it is in.
      // ☆ The cost, named: a streamed request to a lane that accepts the
      // connection and then says nothing waits the full window before failing
      // over, where a buffered one gives up in timeoutMs. It is bounded, it is
      // streaming-only, and for a profile-mapped request there is no second
      // lane to fail over to anyway. A lane that should give up sooner sets
      // streamIdleMs short.
      const idleMs = Number(providerConfig.streamIdleMs) || Math.max(timeoutMs, STREAM_IDLE_MS);
      // ☠️ A STREAMING UPSTREAM MUST NOT WEAR THE BUFFERED PATH'S TOTAL
      // DEADLINE. A legitimate long generation is not a fault, but
      // AbortSignal.timeout(25s) would guillotine it mid-sentence with frames
      // already on the client's wire -- the one state this design cannot
      // recover from. Streaming gets a rearmable STALL watchdog instead: the
      // window guards the wait for the FIRST frame (where failover still
      // works), and every frame that arrives resets it, so only actual silence
      // kills. What it measures is silence, never total duration.
      const stallAbort = streaming ? new AbortController() : null;
      let stallTimer = null;
      const touch = (ms) => {
        clearTimeout(stallTimer);
        // ☆ A TimeoutError (not a bare Error) keeps a stall in the "our
        // impatience: release, do not indict" class the catch below already
        // sorts by name.
        stallTimer = setTimeout(() => stallAbort.abort(new DOMException("upstream stalled", "TimeoutError")), ms);
        stallTimer.unref?.();
      };
      let response;
      let instructedJson = false;
      try {
        const abort = streaming
          ? (AbortSignal.any
            ? AbortSignal.any([stallAbort.signal, ...(clientAbort ? [clientAbort] : [])])
            : stallAbort.signal)
          : (AbortSignal.any
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(clientAbort ? [clientAbort] : [])])
            : AbortSignal.timeout(timeoutMs));
        if (streaming) touch(idleMs);
        // Providers without OpenAI's json_object mode (Anthropic's compat
        // endpoint accepts only strict closed schemas) get the instruct
        // bridge: strip response_format, demand raw JSON in an appended
        // instruction. Haiku-class models comply reliably; a rare miss is one
        // failed attempt, not a dead lane.
        let forwardBody = { ...requestBody, model: leased.modelID };
        const extras = {
          ...(providerConfig.bodyExtras && typeof providerConfig.bodyExtras === "object" ? providerConfig.bodyExtras : {}),
          ...(route?.bodyExtras ?? {}),
        };
        for (const [key, value] of Object.entries(extras)) {
          if (value !== null) forwardBody[key] = value;
        }
        // ☠️ SOME LANES REJECT A COMBINATION THE CLIENT IS ENTITLED TO SEND. Anthropic's
        // OpenAI-compat endpoint 400s on `temperature` and `top_p` together ("Please use only
        // one"), while llama.cpp accepts both -- so Home Assistant's conversation integration,
        // which always sends both, could reach the local lane and never the cloud one. Worse,
        // the 400 is scored as a provider fault: every attempt indicted anthropic until its
        // circuit opened, which took the cloud rung away from a local profile's fallback and
        // left that profile with no lane at all. Dropping a key the lane refuses is the narrow,
        // honest fix -- the
        // request is otherwise perfectly valid and the alternative is a dead lane.
        // ☆ Drop, never rewrite: this must not invent a value the client did not ask for.
        for (const key of Array.isArray(providerConfig.dropBodyKeys) ? providerConfig.dropBodyKeys : []) {
          if (typeof key === "string" && key in forwardBody) delete forwardBody[key];
        }
        // ☠️ llama.cpp SERVES /responses BUT IGNORES ITS `text.format`: a strict json_schema comes
        // back as prose, or as fenced JSON with keys the schema never named (measured 2026-09-21,
        // firecrawl's extraction). The same server enforces chat's `response_format` on that
        // endpoint, so a lane marked `mirrorTextFormat` gets the format copied across. Never
        // over a response_format the client set itself.
        if (api === RESPONSES && providerConfig.mirrorTextFormat === true && !forwardBody.response_format) {
          const format = forwardBody.text?.format;
          if (format?.type === "json_schema" && format.schema && typeof format.schema === "object") {
            forwardBody.response_format = { type: "json_schema", json_schema: {
              name: typeof format.name === "string" ? format.name : "response",
              schema: format.schema,
              ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
            } };
          } else if (format?.type === "json_object") {
            forwardBody.response_format = { type: "json_object" };
          }
        }
        if (streaming) {
          // ☠️ HOW USAGE SURVIVES STREAMING. A buffered response hands us
          // `usage` for free; a stream only carries it when include_usage is
          // set, so the gateway sets it ON EVERY streamed request whether the
          // client asked or not -- accounting is not the client's option. The
          // extra tail frame that buys is stripped back out for clients that
          // did not ask (relayStream), so nobody sees a shape they did not
          // request. A lane that ignores stream_options anyway falls back to a
          // chars/4 estimate; what it never falls back to is zero.
          forwardBody = { ...forwardBody, stream: true };
          // ☠️ A lane that REJECTS the injected option -- a strict compat
          // endpoint 400ing on a field it does not know -- would be indicted on
          // every streamed request until its circuit opened, taking it away
          // from the buffered consumers too: a fleet-wide outage caused by our
          // own accounting. `streamUsage: false` in provider config opts a lane
          // out; it then accounts by estimate, which is worse than measured and
          // enormously better than quarantined. A client's OWN stream_options
          // still rides through untouched -- that ask is not ours to strip.
          // Chat only: a responses stream always reports usage on response.completed.
          if (api === CHAT && providerConfig.streamUsage !== false) {
            forwardBody.stream_options = { ...(forwardBody.stream_options ?? {}), include_usage: true };
          }
        }
        if (api === CHAT && providerConfig.jsonMode === "instruct" && forwardBody.response_format) {
          const wantedJson = forwardBody.response_format?.type?.startsWith("json");
          delete forwardBody.response_format;
          if (wantedJson) {
            instructedJson = true;
            forwardBody = {
              ...forwardBody,
              messages: [
                ...(Array.isArray(forwardBody.messages) ? forwardBody.messages : []),
                { role: "system", content: "Respond with ONLY the raw JSON value. No prose, no markdown fences." },
              ],
            };
          }
        }
        response = await fetchImpl(`${providerConfig.baseUrl.replace(/\/$/, "")}${api.path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(providerConfig.headers && typeof providerConfig.headers === "object" ? providerConfig.headers : {}),
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify(forwardBody),
          signal: abort,
        });
      } catch (error) {
        clearTimeout(stallTimer);
        // A timeout is OUR impatience or the client's abandonment, not proof
        // the provider is down -- reporting it as a failure quarantined a
        // healthy provider under burst (measured live). Release the lease,
        // exclude the lane for THIS request's retry, and move on; genuinely
        // broken providers still get indicted by real HTTP errors below.
        if (isAbort(error)) {
          await settle(leased.sessionID, "/release");
          if (clientAbort?.aborted) { lastError = new Error("client disconnected"); break; }
        } else {
          await settle(leased.sessionID, "/failure", { error: { message: String(error?.message ?? error) } });
        }
        excludeLane(leased.providerID);
        lastError = error;
        continue;
      }
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 400);
        clearTimeout(stallTimer);
        await settle(leased.sessionID, "/failure", {
          error: { statusCode: response.status, message: text || `upstream HTTP ${response.status}` },
        });
        lastError = new Error(`upstream ${leased.providerID} HTTP ${response.status}: ${text.slice(0, 120)}`);
        excludeLane(leased.providerID);
        continue;
      }
      if (streaming) {
        // ══ THE FAILOVER BOUNDARY ══════════════════════════════════════════
        // ☠️ EVERYTHING ABOVE THIS POINT IS RETRYABLE. NOTHING AFTER THE FIRST
        // sink.write() IS. The moment one byte of a 200 text/event-stream
        // response leaves for the client, this gateway has said "here is your
        // answer" in a protocol with no un-say: the status line is spent, and a
        // second lane's tokens cannot be spliced onto the first lane's
        // half-sentence (different model, different tokenizer, duplicated or
        // contradictory prefix). So the rule is mechanical, and `relayed` is
        // the only thing that decides it:
        //   relayed === false -> behave exactly like the buffered path:
        //                        indict or release, exclude the lane, retry.
        //   relayed === true  -> committed. Finish the stream with an error
        //                        frame, tell the broker, do NOT retry.
        // This is why the response head is written by sink.write() and not one
        // line earlier (see the sink in handle()).
        const contentType = String(response.headers?.get?.("content-type") ?? "");
        let outcome;
        try {
          // ☆ Dressing a buffered body as a stream is a chat-only courtesy: a
          // responses stream is a sequence of typed events a client parses by
          // type, and inventing them risks a shape the client rejects halfway.
          outcome = contentType.includes("application/json")
            ? (api === CHAT
              ? await relayBufferedAsStream({ response, sink, keepUsageFrames })
              : { relayed: false, usage: null, outputChars: 0, sawDone: false,
                error: new Error(`upstream ${leased.providerID} answered a streamed /responses request with one JSON body`) })
            : await relayStream({ stream: response.body ?? [], sink, keepUsageFrames, touch: () => touch(idleMs), api });
        } finally {
          clearTimeout(stallTimer);
        }
        if (!outcome.relayed) {
          // Wire still clean. No usage is reported for a lane that produced no
          // frames -- same as the buffered path, which never accounts for an
          // attempt it threw away.
          const error = outcome.error ?? new Error(`upstream ${leased.providerID} produced an empty stream`);
          if (isAbort(error) || clientAbort?.aborted) {
            await settle(leased.sessionID, "/release");
            if (clientAbort?.aborted) { lastError = new Error("client disconnected"); break; }
          } else {
            await settle(leased.sessionID, "/failure", { error: { message: String(error?.message ?? error).slice(0, 400) } });
          }
          excludeLane(leased.providerID);
          lastError = error;
          continue;
        }
        // Committed. Account first: tokens were generated and somebody is
        // paying for them whether or not the stream finished cleanly.
        // ☠️ An all-zero measurement is treated as NO measurement. A tail frame
        // carrying the usage envelope and nothing inside it (llama.cpp builds
        // differ on this) would otherwise report 0/0 as fact -- the exact ledger
        // poison the estimate exists to prevent, and worse for being labelled
        // measured.
        const measured = outcome.usage && (outcome.usage.input > 0 || outcome.usage.output > 0) ? outcome.usage : null;
        await reportUsage(leased, measured ?? estimateUsage(requestBody, outcome.outputChars));
        if (outcome.error) {
          if (clientAbort?.aborted) {
            // The client walked away mid-stream. Its own doing: release the
            // lease, indict nobody, and write nothing to a socket that is gone.
            await settle(leased.sessionID, "/release");
          } else {
            // ☆ The client gets a truncated answer AND an explanation it can
            // parse; the broker gets the failure, because circuits only open on
            // reports and a lane that dies at token 200 is exactly the lane the
            // next request must route around.
            const why = String(outcome.error?.message ?? outcome.error).slice(0, 200);
            if (api === RESPONSES) sink.write(responsesErrorFrame(why));
            else { sink.write(errorFrame(why)); sink.write(DONE_FRAME); }
            await settle(leased.sessionID, "/failure", {
              error: { message: `stream failed after ${outcome.outputChars} chars: ${String(outcome.error?.message ?? outcome.error)}`.slice(0, 400) },
            });
          }
        } else {
          // ☆ A missing [DONE] does not indict -- it is a dialect gap, not a
          // fault -- but the client must never be left waiting for a terminator
          // that is not coming.
          if (api === CHAT && !outcome.sawDone) sink.write(DONE_FRAME);
          await settle(leased.sessionID, "/complete");
        }
        return { status: 200, streamed: true, providerID: leased.providerID, modelID: leased.modelID };
      }
      // A 200 with an unparseable body IS a provider fault -- and an uncaught
      // throw here would escape completions() as an unhandledRejection.
      let payload;
      try { payload = await response.json(); } catch {
        await settle(leased.sessionID, "/failure", { error: { message: "upstream returned 200 with an unparseable JSON body" } });
        lastError = new Error(`upstream ${leased.providerID} returned unparseable JSON`);
        excludeLane(leased.providerID);
        continue;
      }
      // ANY model may fence its JSON (llama.cpp ignores json_object without a
      // schema in some builds; instruct-mode models fence despite orders).
      // The client asked for machine-readable output: unwrap deterministically.
      // ☆ The streaming path cannot do this and does not pretend to: unwrapping
      // needs the whole string, and a client that asked to stream has said it
      // will assemble the string itself. Documented in the README. (The
      // instruct bridge above still runs there: it asks for no fences.)
      if (instructedJson || wantedJson) {
        for (const choice of payload?.choices ?? []) {
          const content = choice?.message?.content;
          if (typeof content === "string") {
            const match = content.match(/^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/);
            if (match) choice.message.content = match[1];
          }
        }
      }
      if (payload?.usage) await reportUsage(leased, readUsage(payload.usage));
      await settle(leased.sessionID, "/complete");
      return { status: 200, payload, providerID: leased.providerID, modelID: leased.modelID };
    }
    // ☠️ ABANDONING THE REQUEST MUST NOT STRAND THE LEASE. Every failure path
    // above already releases or indicts (the broker deletes the lease on both),
    // but a dropped /release under a broker hiccup would pin a capacity-1
    // target for the full 2h TTL -- the debris 0.2.3's startup sweep exists to
    // clear after a CRASH, which a live process must not be manufacturing.
    // Releasing an already-released session is a no-op delete.
    await settle(sessionID, "/release");
    return {
      status: 502,
      payload: { error: { message: `gateway: no provider could serve the request: ${String(lastError?.message ?? lastError)}`, type: "upstream_error" } },
    };
  };

  const handle = async (request, response) => {
    const authHeader = request.headers.authorization ?? "";
    if (!gatewayKey || !sameSecret(authHeader, `Bearer ${gatewayKey}`)) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "missing or invalid gateway key" } }));
      return;
    }
    const url = (request.url ?? "/").split("?")[0];
    if (request.method === "GET" && url === "/v1/models") {
      // ☆ An interactive client builds its model picker from here, so this list
      // is the gateway's answer to "what may I ask for". The routed id comes
      // first -- it means "let the broker pick", and is what a consumer that
      // does not care which model answers should send -- and every mapped name
      // joins it, because a name the gateway will honour is exactly a name a
      // human may select.
      const routedID = config.routedModelId ?? DEFAULT_ROUTED_MODEL_ID;
      const named = Object.keys(config.modelProfiles ?? {}).filter((id) => id !== routedID);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [
          { id: routedID, object: "model", owned_by: "opencode-broker" },
          ...named.map((id) => ({ id, object: "model", owned_by: "opencode-broker" })),
        ],
      }));
      return;
    }
    const api = url === "/v1/chat/completions" ? CHAT : url === "/v1/responses" ? RESPONSES : null;
    if (request.method !== "POST" || !api) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "only POST /v1/chat/completions, POST /v1/responses and GET /v1/models" } }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
      return;
    }
    const streaming = parsed.stream === true;
    // Anything that is not an explicit `stream: true` keeps the buffered
    // shape byte for byte, and the key never reaches the upstream -- a lane
    // that would happily have streamed must not, or the buffered reader below
    // gets SSE text where it expects a JSON object.
    if (!streaming) delete parsed.stream;
    const clientAbortController = new AbortController();
    // ☠️ 'close' ON THE RESPONSE, NOT THE REQUEST. A fully-read
    // IncomingMessage emits 'close' the instant its body ends -- which is
    // BEFORE this line runs -- so the request-side listener this replaces could
    // never fire and client-disconnect aborts have been dead since 0.2.0
    // (proved against a real socket, not a stub). ServerResponse fires 'close'
    // when the connection genuinely goes away; writableEnded tells a hang-up
    // apart from our own end(). ☆ On the streaming path this is the
    // difference between cancelling a generation and leaving the single local
    // llama.cpp slot burning for minutes after the tab that wanted it is gone.
    response.on("close", () => { if (!response.writableEnded) clientAbortController.abort(); });
    // ☠️ The head is written by the FIRST FRAME, not before the attempt loop.
    // Committing a 200 text/event-stream up front would forfeit the retry for
    // every request, including the ones that fail before producing a single
    // token -- and would leave a failed request with no way to say 502.
    const sink = streaming ? {
      started: false,
      write(text) {
        if (!this.started) {
          this.started = true;
          // Nagle would hold a 40-byte delta back waiting for company; on this
          // path the whole product is the promptness.
          response.socket?.setNoDelay?.(true);
          response.writeHead(200, SSE_HEADERS);
        }
        response.write(text);
      },
    } : null;
    const address = String(request.socket?.remoteAddress ?? "").replace(/^::ffff:/, "") || null;
    const caller = {
      address,
      model: typeof parsed?.model === "string" ? parsed.model.slice(0, 100) : null,
    };
    const result = await completions(parsed, clientAbortController.signal, sink, api, caller);
    // A streaming request that never got a frame out still owes the client an
    // ordinary JSON error, which is exactly what an OpenAI client expects when
    // a stream fails to start.
    if (sink?.started) { response.end(); return; }
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.payload));
  };

  // The bin fires this handler with `void` -- any rejection out of it is an
  // unhandledRejection, which is fatal in this node. A torn body read (client
  // gone mid-upload) or any future slip must end as a response, not a crash.
  return async (request, response) => {
    try { await handle(request, response); } catch {
      try {
        if (response.headersSent) { response.end(); return; }
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "gateway internal error" } }));
      } catch { /* socket already gone */ }
    }
  };
};
