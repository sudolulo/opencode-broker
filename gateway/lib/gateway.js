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
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { usageLimitMessage } from "../../lib/usage-limit.js";
import { createGatewayHealth, createTerminalParser } from "./model-health.js";

// Constant-time comparison of a presented credential with its expected wire value. Hashing first
// gives both sides the same length, which timingSafeEqual requires for bearer and x-api-key auth.
const sameSecret = (presented, expected) => timingSafeEqual(
  createHash("sha256").update(String(presented)).digest(),
  createHash("sha256").update(String(expected)).digest(),
);

const loopbackAddress = (value) => {
  const address = String(value ?? "").replace(/^::ffff:/, "");
  return address === "::1" || /^127(?:\.\d{1,3}){3}$/.test(address);
};

// ☠️ KEEP IN STEP WITH catalogModelForID() IN lib/model-candidates.js. OpenCode synthesizes the
// speed aliases `<base>-fast` and `<base>-standard` from the base catalog record, so the broker
// leases the alias id while the request on the wire names the base id (the speed travels in other
// body fields). A lease therefore covers the wire model when the ids are equal, or when the lease
// id is the wire id plus exactly one of those suffixes -- never the reverse, and never any other
// prefix or suffix. Plain string comparison, not a RegExp built from the client-supplied id. The
// gateway takes no imports from the broker's lib/, hence the copy rather than a shared helper.
const SPEED_ALIAS_SUFFIXES = ["-fast", "-standard"];
const speedAliasBase = (modelID) => {
  if (typeof modelID !== "string") return null;
  const suffix = SPEED_ALIAS_SUFFIXES.find((candidate) => modelID.endsWith(candidate));
  const base = suffix ? modelID.slice(0, -suffix.length) : "";
  return base || null;
};
// Required anthropic-beta for a Messages request with top-level speed "fast".
const FAST_MODE_BETA = "fast-mode-2026-02-01";
const leaseCoversWireModel = (leasedModelID, wireModelID) => {
  if (typeof leasedModelID !== "string") return false;
  if (leasedModelID === wireModelID) return true;
  return wireModelID !== "" &&
    SPEED_ALIAS_SUFFIXES.some((suffix) => leasedModelID === `${wireModelID}${suffix}`);
};

const DEFAULT_TIER = "worker";
const ATTEMPTS = 2;
export const MAX_EMBEDDING_BATCH_ITEMS = 2048;
export const MAX_EMBEDDINGS_BODY_BYTES = 1024 * 1024;

// TRAP: WHY AN ALLOWLIST OF GATEWAY-OWNED PHRASES AND NOT THE UPSTREAM MESSAGE. The
// Messages and Responses buffered error paths drop the upstream body on purpose
// (gateway/tests/gateway.test.mjs "...never echo provider details"); the client
// gets "Anthropic upstream HTTP <status>" and nothing else. A few upstream
// facts, however, change what the BROKER should do about the failure: this
// recogniser surfaces exactly those -- as fixed gateway-owned phrases, with no
// upstream bytes passed through -- so the broker's classifier (lib/routing.js
// isFastModeCreditsRequired / classifyRoutingFailure) can key on them.
//   - "usage credits are required for fast mode": Anthropic refuses `speed:
//     "fast"` requests on accounts without usage credits (400/403/429 with
//     body `{type:"error",error:{type:"rate_limit_error",
//     message:"Usage credits are required for fast mode."}}`). Account-level,
//     speed-scoped, no reset -- without this suffix the plain 429 reads as a
//     burst rate limit and every fast target re-fails forever.
// TRAP: PROXIMITY, NOT TWO INDEPENDENT CONJUNCTS. The matcher must agree with
// the broker's classifier (lib/routing.js isFastModeCreditsRequired); the
// two-independent-regex form matched any body that happened to mention both
// words anywhere, so an echoed stack trace could trip this. 80 chars tolerates
// a rewording ("fast mode requires usage credits") while rejecting words
// paragraphs apart.
const UPSTREAM_SIGNALS = [
  {
    matches: (message) =>
      /\busage credits?.{0,80}fast[ -]?mode\b|\bfast[ -]?mode.{0,80}usage credits?\b/i.test(message),
    phrase: "usage credits are required for fast mode",
  },
  // ☠️ CONTEXT OVERFLOW MUST REACH THE CLIENT AS ONE. Without it a session past the window got
  // "Anthropic upstream HTTP 400" and OpenCode, unable to see an overflow, retried the same
  // 1.6M-token prompt instead of compacting (2026-10-13), while the broker filed it as a provider
  // failure. The phrase is the one OpenCode's isContextOverflow and the broker's
  // classifyRoutingFailure ("context") both key on.
  {
    matches: (message) => /prompt is too long|context[._ -]?length[._ -]?exceeded|maximum context length/i.test(message),
    phrase: "prompt is too long",
  },
];

// Reads the upstream error message out of the shared Anthropic/OpenAI JSON
// shape (`{..., error: { message } }`) and returns the first matching signal's
// phrase, or null. The body has already been fully read by the caller; the
// 16 KB cap here is only a parser-cost ceiling for JSON.parse. Silent on parse
// failure. The phrase is a GATEWAY STRING; the raw body never escapes.
const upstreamSignal = (body) => {
  if (typeof body !== "string" || body.length === 0 || body.length > 16384) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const message = parsed?.error?.message;
  if (typeof message !== "string" || !message) return null;
  for (const signal of UPSTREAM_SIGNALS) {
    if (signal.matches(message)) return signal.phrase;
  }
  return null;
};
// ☠️ A USAGE LIMIT MUST SAY SO. An upstream 429 that is the account's plan being spent reached
// the user as "gateway: no provider could serve the request: upstream openai HTTP 429" -- true,
// and useless: which limit, and when is it back? Recognised here from the status, the
// `anthropic-ratelimit-unified-*` headers and the error's type/message, and only FACTS leave
// (that it is a usage limit, which window, the reset time) -- never upstream wording, same rule
// as UPSTREAM_SIGNALS above. Fast-mode credits are their own 429 and are excluded first.
const UNIFIED_CLAIMS = { five_hour: "5-hour limit", seven_day: "weekly limit", seven_day_opus: "weekly Opus limit", seven_day_sonnet: "weekly Sonnet limit" };
export const upstreamUsageLimit = (status, body, headers, now = Date.now()) => {
  if (status !== 429) return null;
  const header = (name) => {
    try { return headers?.get?.(name) ?? null; } catch { return null; }
  };
  let parsed = null;
  if (typeof body === "string" && body.length > 0 && body.length <= 16384) {
    try { parsed = JSON.parse(body); } catch { parsed = null; }
  }
  const message = String(parsed?.error?.message ?? "");
  const type = String(parsed?.error?.type ?? parsed?.error?.code ?? "");
  if (UPSTREAM_SIGNALS.some((signal) => signal.matches(message))) return null;
  const rejected = header("anthropic-ratelimit-unified-status") === "rejected";
  if (!rejected && !/usage[_ ]limit|would exceed your account.{0,8}rate limit|limit has been reached/i.test(`${type} ${message}`)) {
    return null;
  }
  const epochSeconds = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 1e9 ? n * 1000 : null;
  };
  const inSeconds = Number(parsed?.error?.resets_in_seconds ?? header("retry-after"));
  const computedUntil = epochSeconds(header("anthropic-ratelimit-unified-reset")) ??
    epochSeconds(parsed?.error?.resets_at) ??
    (Number.isFinite(inSeconds) && inSeconds > 0 ? now + inSeconds * 1000 : null);
  // Date throws outside its supported range. A reset is optional quota metadata,
  // so discard unusable provider values while preserving the recognised 429 itself.
  const until = Number.isFinite(computedUntil) && computedUntil <= 8.64e15 ? computedUntil : null;
  const claim = header("anthropic-ratelimit-unified-representative-claim");
  return { limit: UNIFIED_CLAIMS[claim] ?? null, until };
};
// The shape a forwarded session fingerprint may take. Anything else is dropped at the
// forward site, never an error: the hints steer cache and diagnostics, they are not
// auth (see the x-opencode-session-* comment at the forward site).
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;
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
//     "<name>": { "profile": "<broker profile>", "bodyExtras": { "chat_template_kwargs": null } },
//     "<name>": { "profile": "<broker profile>", "waitForLocal": true, "holdOpenMs": 30000 }
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
  const wait = entry?.prepareWaitMs == null ? Number.NaN : Number(entry.prepareWaitMs);
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
  // ☠️ A WAIT THE CLIENT CANNOT SEE IS A WAIT THE CLIENT WILL NOT SIT THROUGH. A buffered
  // (non-streaming) request is silent until its whole answer is ready, and HTTP clients give up
  // on silence long before a patient wait is over: Bun's fetch drops a connection after ~5 minutes
  // with no bytes ("The operation timed out."), undici's headersTimeout is 5 minutes. Measured
  // 2026-09-21: a memory service's cron retried 11 documents at once into a 3-slot lane, and
  // every call the gateway parked past 5 minutes died client-side while its 50-minute budget
  // still had 45 to run -- each one a document marked failed with its memories lost.
  // `holdOpenMs` keeps such a request visibly alive: once it has waited that long with no answer,
  // the 200 head is committed and a space follows every holdOpenMs until the JSON is written
  // after them (leading whitespace is valid JSON). ☆ The price is the status line: a failure
  // after that point can only arrive as the error object under a 200. A request that settles
  // inside holdOpenMs never commits early and keeps its real status, so only the long waits pay.
  const holdOpen = Number(typeof entry === "string" ? Number.NaN : entry?.holdOpenMs);
  const tier = typeof entry === "string" ? null
    : typeof entry?.tier === "string" && entry.tier ? entry.tier : null;
  return {
    profile,
    tier,
    waitForLocal,
    holdOpenMs: Number.isFinite(holdOpen) && holdOpen > 0 ? holdOpen : null,
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

// ── the tenant control surface ───────────────────────────────────────────────
// A GPU tenant is an app outside the router that needs a whole card for a while: ComfyUI
// wants 24,576 MiB of card 1 for the length of a render. It cannot take that itself -- it is
// a container with no midclt, no router and no state dir -- so it asks the gateway, which
// already spawns `model-swap` and already runs on the host that owns the reservation state.
//
// ☠️ THIS SURFACE IS NOT THE OPENAI SURFACE AND SHARES NO CREDENTIAL WITH IT. The gateway key
// fronts paid quota; the tenant token can only move a local model off a card. The container
// runs third-party custom nodes, so it holds the narrow one and nothing else -- which is why
// the dispatch below sits BEFORE the gateway-key gate rather than after it. Neither secret is
// accepted in place of the other, and a request that presents the wrong one gets 401.
//
// The route shape, and the reason the id charset is narrow: an id is a path segment and a
// `model-swap` argv word, so it may not contain anything that reads as either a path
// traversal or a flag.
const TENANT_ROUTE = /^\/tenant\/([a-z0-9-]+)(?:\/(acquire|release))?$/;
const TENANT_ID = /^[a-z0-9-]+$/;
// How long `reserve` may wait for an in-use model to go quiet before it overrides the
// ACTIVITY guard (never feasibility). 60s chosen in the 2026-09-28 design: long enough for an
// ordinary Frigate or paperless request on the 27b to finish, short enough that a render does
// not sit behind a chat session indefinitely.
const TENANT_WAIT_ACTIVE_SECONDS = "60";
// Where `model-swap` keeps its reservations (tools/model-swap:260). Read, never written here:
// the gateway's job is to ask model-swap to change it and then report what it says.
const DEFAULT_RESERVATIONS_PATH = join(
  process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
  "llamacpp-model-swap/reservations.json",
);

// Exactly model-swap's own read_reservations() rule (tools/model-swap:263-274): an entry
// counts only if it is an object carrying BOTH "card" and "mib". Anything else -- no file,
// unparseable JSON, a half-formed entry -- reads as NOT held.
//
// ☆ Reading "not held" when a reservation does exist costs at worst a redundant reserve.
// Reading "held" when it does not would let a render start on a card the 27b still occupies,
// and llama.cpp answers that by partial-offloading to a no-AVX2 CPU at 0.88 tok/s with an
// HTTP 200 -- a silent failure. So every ambiguous read resolves to false.
const reservationHeld = (path, id) => {
  let blob;
  try { blob = JSON.parse(readFileSync(path, "utf8")); } catch { return false; }
  if (!blob || typeof blob !== "object") return false;
  const entry = blob[id];
  return Boolean(entry) && typeof entry === "object" && "card" in entry && "mib" in entry;
};

// How much of a child's chatter the gateway is willing to hold. ☠️ This is a DIAGNOSTIC
// ceiling, not a transcript: the captured text has exactly one consumer, the stderr line the
// tenant handler writes when a swap does not end how the action wanted. 32 KiB is several
// screens of a model-swap failure -- far more than the one line that usually matters -- while
// staying small enough that a swap stuck in a retry loop cannot grow the heap of a process
// that is concurrently serving paid requests.
export const MODEL_SWAP_OUTPUT_LIMIT = 32 * 1024;

// The bounded capture behind spawnModelSwap, separated so the bound can be observed WHILE
// chunks arrive rather than only in the resolved value. Two properties it exists to hold:
//
//  1. The retained text is trimmed after EVERY chunk. Trimming once at exit -- which is what
//     `output.slice(-4000)` on close did -- bounds the reported string and nothing else: the
//     process still holds everything the child ever printed for as long as it runs.
//  2. Each stream decodes through its OWN StringDecoder. A UTF-8 character straddling two
//     chunks arrives as a partial byte sequence, and stringifying each Buffer alone turns it
//     into U+FFFD -- garbling the error line exactly when someone is trying to read it. The
//     decoders cannot be shared between stdout and stderr either: they are independent byte
//     streams, so one stream's held partial character would corrupt the other's next chunk.
//
// The TAIL is what survives a trim, because a failing command's last words are its reason. A
// trailing partial character (a child killed mid-write) is simply dropped rather than flushed
// as U+FFFD: end() is never called.
export const createModelSwapCapture = (limit = MODEL_SWAP_OUTPUT_LIMIT) => {
  let text = "";
  return {
    // One sink per stream, each with its own decoder.
    sink: () => {
      const decoder = new StringDecoder("utf8");
      return (chunk) => {
        text += decoder.write(chunk);
        if (text.length > limit) text = text.slice(-limit);
      };
    },
    text: () => text,
  };
};

// Spawn `model-swap` and WAIT for it. ☠️ This is deliberately not the bin's prepareCommand
// spawn (bin/opencode-broker:587-598), which is detached, stdio-ignored and unref'd because
// nothing there wants an answer. Here the whole point is the answer: the caller may not start
// rendering until the reservation has actually been taken, so the child must be awaited.
//
// No server-side deadline: the client owns that (the ComfyUI node passes an explicit
// aiohttp.ClientTimeout), and a `reserve --wait-active 60` legitimately runs minutes when it
// triggers a real swap. A client that gives up disconnects; model-swap finishes its own
// transaction either way, which is what keeps the reservation file honest. What IS bounded is
// how much it may print at us while it does: see createModelSwapCapture.
export const spawnModelSwap = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const capture = createModelSwapCapture();
  child.stdout?.on("data", capture.sink());
  child.stderr?.on("data", capture.sink());
  // An ENOENT on the command is a deployment fault, not a refusal: it must be visible in the
  // gateway's log rather than looking like a tenant that declined.
  child.on("error", (error) => resolve({ code: null, output: String(error?.message ?? error) }));
  child.on("close", (code) => resolve({ code, output: capture.text() }));
});

const advertisedModelIDs = (config) => {
  const routedID = config.routedModelId ?? DEFAULT_ROUTED_MODEL_ID;
  return [routedID, ...Object.keys(config.modelProfiles ?? {})]
    .filter((id, index, ids) => ids.indexOf(id) === index);
};

// Group and other bits, all three triads. Any one of them set means an account that is not
// the gateway's own can read the key.
const SHARED_MODE_BITS = 0o077;

// The ONE reader of the gateway key, and the reason the bin does not call readFileSync itself.
//
// ☠️ This endpoint fronts PAID QUOTA. The key in this file is the whole boundary between a
// local account and someone else's provider bill, so it is held to exactly the standard
// lib/reconcile-secrets.js holds the reconciler's Gitea write token to: a regular file, mode
// 0600, non-empty. A gateway key read from a group-readable file while a forge token refuses
// to be was the asymmetry this closes.
//
// Every refusal is LOUD and happens before listen(), never a downgrade to "no key": the auth
// gate treats a falsy key as "refuse every caller", which is indistinguishable from a broken
// deploy once the process is up. And no message ever quotes the key -- startup errors land in
// journals that are not themselves 0600.
//
// ☆ statSync FOLLOWS the symlink on purpose. A link's own mode is 0777 on Linux and always
// will be, so checking it would refuse every legitimate indirection; the mode that protects
// the bytes is the target's.
export const readGatewayKeyFile = (keyPath) => {
  if (typeof keyPath !== "string" || keyPath === "") {
    throw new Error("no gateway key file was named: the gateway refuses to run without a key");
  }

  let stats;
  try {
    stats = statSync(keyPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${keyPath} does not exist: the gateway refuses to run without a key`);
    }
    throw error;
  }
  if (!stats.isFile()) throw new Error(`${keyPath} is not a regular file`);

  const mode = stats.mode & 0o777;
  if (mode & SHARED_MODE_BITS) {
    throw new Error(`${keyPath} is group- or world-readable (mode ${mode.toString(8).padStart(4, "0")}); chmod 600 it`);
  }

  const key = readFileSync(keyPath, "utf8").trim();
  if (key === "") throw new Error(`${keyPath} is empty: the gateway refuses to run without a key`);
  return key;
};

// ☠️ `assembleFromStream` says "this lane streams, so ask it to even when the client did not";
// `bufferStreamingUpstream` says "this lane cannot stream, so never ask it to". A lane carrying
// both is a config that contradicts itself, and whichever one silently won would be wrong for
// half its traffic. Refused at load and again at handler construction (tests and embedders pass
// config without loading a file).
const validateProviderFlags = (providers) => {
  for (const [name, provider] of Object.entries(providers ?? {})) {
    if (provider?.bufferStreamingUpstream === true && provider?.assembleFromStream === true) {
      throw new Error(`providers["${name}"] sets both bufferStreamingUpstream and assembleFromStream: a lane either cannot stream (buffer) or should always stream (assemble), not both`);
    }
  }
};

export const loadGatewayConfig = (path = DEFAULT_GATEWAY_CONFIG) => {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const providers = raw.providers && typeof raw.providers === "object" ? raw.providers : {};
  if (!Object.keys(providers).length) throw new Error("gateway config has no providers");
  validateProviderFlags(providers);
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
  // Which tenants exist, which address each may call from, and which command serves them are
  // all DEPLOYMENT DATA -- the same reason no profile name may appear in this file. A gateway
  // with no `tenants` block has no tenant surface at all, and every id is a 404.
  const tenants = {};
  for (const [id, entry] of Object.entries(raw.tenants && typeof raw.tenants === "object" ? raw.tenants : {})) {
    // An id the route regex cannot match would be a tenant nothing could ever call. Rejecting
    // it at load beats a silently unreachable reservation path.
    if (!TENANT_ID.test(id)) throw new Error(`tenants["${id}"] must match ${TENANT_ID} to be reachable as a route`);
    const command = Array.isArray(entry?.command) && entry.command.length
      && entry.command.every((word) => typeof word === "string" && word)
      ? [...entry.command] : null;
    if (!command) throw new Error(`tenants["${id}"] needs a command: the argv of the model-swap that serves it`);
    // ☠️ An absent or empty allowFrom would mean "any address on the LAN may evict the
    // household's vision model". There is no permissive default here on purpose.
    const allowFrom = Array.isArray(entry?.allowFrom) && entry.allowFrom.length
      && entry.allowFrom.every((address) => typeof address === "string" && address)
      ? [...entry.allowFrom] : null;
    if (!allowFrom) throw new Error(`tenants["${id}"] needs a non-empty allowFrom: the addresses it may call from`);
    tenants[id] = { allowFrom, command };
  }
  return {
    tenants,
    tier: typeof raw.tier === "string" ? raw.tier : DEFAULT_TIER,
    profile: typeof raw.profile === "string" ? raw.profile : "auto",
    providers,
    modelProfiles,
    routedModelId: typeof raw.routedModelId === "string" && raw.routedModelId ? raw.routedModelId : DEFAULT_ROUTED_MODEL_ID,
    strictModelNames: raw.strictModelNames === true,
    ...(Number.isFinite(Number(raw.prepareWaitMs)) ? { prepareWaitMs: Number(raw.prepareWaitMs) } : {}),
    ...(Number.isFinite(Number(raw.prepareRetryMs)) ? { prepareRetryMs: Number(raw.prepareRetryMs) } : {}),
  };
};

const readProviderKey = async (keyFile) => {
  if (typeof keyFile !== "string" || keyFile.length === 0) throw new Error("keyFile must name a file");
  const stats = await stat(keyFile);
  if (!stats.isFile()) throw new Error("keyFile is not a regular file");
  if (stats.mode & SHARED_MODE_BITS) throw new Error("keyFile has unsafe permissions");
  const content = (await readFile(keyFile, "utf8")).trim();
  if (content.length === 0) throw new Error("keyFile is empty");
  return content;
};

const providerKey = async (providerConfig, authPath = join(homedir(), ".local/share/opencode/auth.json")) => {
  if (Object.hasOwn(providerConfig, "keyFile")) return readProviderKey(providerConfig.keyFile);
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

// ── per-request failure log ─────────────────────────────────────────────────
// One JSON line on stderr (journald) per request that ends non-2xx or is abandoned by its client,
// and one per upstream attempt that failed before a later attempt succeeded. Before this, a caller
// that got "no provider could serve the request" had the only copy of the cause.
// ☠️ NOTHING FROM THE REQUEST BODY GOES IN HERE -- no messages, no input, no prompt. The only
// free text is `detail`/`error`, which is the UPSTREAM's error message or the gateway's own reply,
// and it passes through logDetail(): control characters stripped (one record must stay one line,
// and an escape sequence must not reach a terminal reading the journal), bearer tokens and
// sk- keys redacted defensively in case an upstream echoes a credential, then capped.
const LOG_DETAIL_CHARS = 300;
const logDetail = (value) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]+/g, " ")
  .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
  .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
  .trim()
  .slice(0, LOG_DETAIL_CHARS);

// The message inside an upstream's error body when it is the usual JSON envelope, else the raw text.
const upstreamDetail = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message ?? (typeof parsed?.error === "string" ? parsed.error : parsed?.message);
    if (typeof message === "string" && message) return message;
  } catch { /* not JSON: the raw text is the detail */ }
  return raw;
};

// What a forward that threw (no HTTP status) looked like: our stall watchdog, our timeout, or
// the network. A client's own disconnect is never recorded as an attempt outcome.
const thrownOutcome = (error) => {
  if (!isAbort(error)) return "network";
  return /stalled/i.test(String(error?.message ?? "")) ? "stalled" : "timeout";
};
const thrownDetail = (error) => {
  const cause = error?.cause;
  const why = cause ? ` (${[cause.code, cause.message].filter(Boolean).join(": ")})` : "";
  return `${String(error?.message ?? error)}${why}`;
};

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
// ── the three request shapes ────────────────────────────────────────────────
// The gateway forwards OpenAI's Chat Completions, Responses and Embeddings APIs plus native
// Anthropic Messages. Leasing, failover and accounting are shared; provider eligibility, request
// shaping, upstream paths, usage fields and stream terminals are protocol-specific.
// ☠️ A LANE SERVES /responses ONLY WHEN ITS CONFIG SAYS SO (`responsesApi: true`). llama.cpp
// serves it natively; Anthropic's compat endpoint and most OpenAI-compatible clouds do not.
// Offering them a /responses lease would get a 404 scored as a provider fault, and every such
// request would indict the lane until its circuit opened -- taking it away from chat traffic too.
const CHAT = { name: "chat", path: "/chat/completions" };
const RESPONSES = { name: "responses", path: "/responses" };
const MESSAGES = { name: "messages", path: "/messages" };
const EMBEDDINGS = { name: "embeddings", path: "/embeddings" };
// This is control flow, unlike the human-facing sentence on the Error.
const LOCAL_FORWARDABLE_EXHAUSTION = "gateway-local-forwardable-exhaustion";

const providerServes = (provider, api) => api === CHAT
  ? provider.chatApi !== false
  : api === RESPONSES
    ? provider.responsesApi === true
    : api === MESSAGES
      ? provider.messagesApi === true
      : provider.embeddingsApi === true;

// Usage in either dialect: chat says prompt/completion, responses says input/output.
const readUsage = (usage) => ({
  input: Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0,
  output: Number(usage?.completion_tokens ?? usage?.output_tokens) || 0,
});

const readMessagesUsage = (usage) => ({
  input: Number(usage?.input_tokens) || 0,
  output: Number(usage?.output_tokens) || 0,
  cacheRead: Number(usage?.cache_read_input_tokens) || 0,
  cacheWrite: Number(usage?.cache_creation_input_tokens) || 0,
});

const mergeMessagesUsage = (current, usage) => {
  const next = { ...(current ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) };
  if (usage && Object.hasOwn(usage, "input_tokens")) next.input = Number(usage.input_tokens) || 0;
  if (usage && Object.hasOwn(usage, "output_tokens")) next.output = Number(usage.output_tokens) || 0;
  if (usage && Object.hasOwn(usage, "cache_read_input_tokens")) next.cacheRead = Number(usage.cache_read_input_tokens) || 0;
  if (usage && Object.hasOwn(usage, "cache_creation_input_tokens")) next.cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
  return next;
};

const estimateUsage = (requestBody, outputChars) => ({
  input: Math.ceil(JSON.stringify(requestBody ?? {}).length / 4),
  output: Math.ceil(outputChars / 4),
  estimated: true,
});

// A vision model tokenizes an image into a bounded number of patches, NOT into its base64
// length: a 1280x720 Frigate JPEG is ~99,000 base64 characters (~24,700 by chars/4) and
// llama.cpp measured 222-277 real prompt tokens for it on qwen3.8-27b. Counting images as text
// put two snapshots past a 32768-token lane cap, so the request was never forwarded at all.
// 1500 per image leaves headroom for larger images and other vision encoders.
export const IMAGE_TOKEN_ESTIMATE = 1500;

// Chat `image_url` parts, Responses `input_image` parts and Messages (Anthropic) `image` parts,
// whatever their `source` (base64, url, file). A remote http(s) URL counts the same allowance as
// inline data: the model sees the same image either way.
// Messages `document` (PDF) parts are deliberately NOT here; they stay counted as text. Their real
// cost scales with page count (each page is extracted text plus a page image), which the gateway
// cannot see without parsing the PDF, and chars/4 of the base64 already tends to UNDER-count a
// text-heavy PDF. A flat per-document allowance would wave a 100-page PDF onto a small-cap lane.
const isImagePart = (part) => part && typeof part === "object"
  && (part.type === "image_url" || part.type === "input_image" || part.type === "image");

// Replaces image parts in a COPY of a content array; the forwarded body is never touched.
// A Messages `tool_result` carries its own content array, which may hold images (a tool
// returning a camera snapshot), so it is walked one level down.
const stripImages = (content, counter) => (Array.isArray(content)
  ? content.map((part) => {
    if (isImagePart(part)) {
      counter.images += 1;
      return { type: part.type };
    }
    return part && typeof part === "object" && part.type === "tool_result" && Array.isArray(part.content)
      ? { ...part, content: stripImages(part.content, counter) }
      : part;
  })
  : content);

// chars/4 is the usual serviceable estimate for OpenAI-shaped payloads, with each image part
// counted at IMAGE_TOKEN_ESTIMATE instead of its serialized length.
const estimateContextTokens = (requestBody) => {
  const counter = { images: 0 };
  const body = requestBody ?? {};
  const withoutImages = {
    ...body,
    // Messages' top-level `system` may be an array of content blocks rather than a string.
    ...(Array.isArray(body.system) ? { system: stripImages(body.system, counter) } : {}),
    ...(Array.isArray(body.messages) ? { messages: body.messages.map((message) => (message && typeof message === "object"
      ? { ...message, content: stripImages(message.content, counter) }
      : message)) } : {}),
    ...(Array.isArray(body.input) ? { input: body.input.map((item) => {
      if (isImagePart(item)) { counter.images += 1; return { type: item.type }; }
      return item && typeof item === "object" && Array.isArray(item.content)
        ? { ...item, content: stripImages(item.content, counter) }
        : item;
    }) } : {}),
  };
  return Math.ceil(JSON.stringify(withoutImages).length / 4) + counter.images * IMAGE_TOKEN_ESTIMATE;
};

const embeddingInputItems = (input) => Array.isArray(input) && !input.every((entry) => Number.isInteger(entry)) ? input : [input];
const embeddingInputTokens = (input) => embeddingInputItems(input).reduce((max, item) => Math.max(max,
  typeof item === "string" ? Math.ceil(item.length / 4) : Array.isArray(item) ? item.length : 0), 0);
const estimateEmbeddingUsage = (input) => ({
  input: embeddingInputItems(input).reduce((total, item) => total + (typeof item === "string" ? Math.ceil(item.length / 4) : item.length), 0),
  output: 0,
  estimated: true,
});

const validEmbeddingInput = (input) => typeof input === "string" || (Array.isArray(input) && (
  input.every((token) => Number.isInteger(token)) || input.every((entry) =>
    typeof entry === "string" || (Array.isArray(entry) && entry.every((token) => Number.isInteger(token))))));

// Pump an upstream SSE body at the client, learning usage on the way.
//
// Frames are relayed VERBATIM rather than re-serialized: an upstream may ship
// fields this gateway has never heard of (reasoning deltas, logprobs, provider
// extensions) and the client asked that provider's dialect, not ours. The only
// frames that do not pass through untouched are the ones we are responsible
// for: the usage tail we asked for ourselves, and error frames.
//
// `relayed` is the whole ballgame -- see THE FAILOVER BOUNDARY below.
const relayStream = async ({ stream, sink, keepUsageFrames, touch, api = CHAT, observe = null }) => {
  const decoder = new TextDecoder();
  let buffer = "";
  let relayed = false;
  let usage = null;
  let outputChars = 0;
  let streamError = null;
  let sawDone = false;

  const emit = async (raw) => { relayed = true; await sink.write(raw); };

  // Returns false to stop reading this upstream.
  const onFrame = async (text, terminator) => {
    const raw = text + terminator;
    const data = sseData(text);
    if (!data) {
      // A comment/heartbeat frame (`: ping`, what OpenRouter-style proxies send
      // while a queue drains) carries nothing the client needs. ☆ Dropping it
      // until real content flows keeps the response head uncommitted, so a lane
      // that pings for ten seconds and THEN dies can still fail over.
      if (relayed) await emit(raw);
      return true;
    }
    if (data.trim() === "[DONE]") {
      if (api === MESSAGES) {
        streamError = new Error("Anthropic upstream stream used an invalid terminal event");
        return false;
      }
      sawDone = true;
      await emit(raw);
      return true;
    }
    let event = null;
    try { event = JSON.parse(data); } catch {
      if (api === MESSAGES) {
        streamError = new Error("Anthropic upstream stream was malformed");
        return false;
      }
      await emit(raw);
      return true;
    }
    // A responses stream fails with an `error` event or a `response.failed` whose
    // response carries the error; a chat stream with an error envelope.
    const failure = event?.error
      ?? (api === RESPONSES && event?.type === "error" ? event : null)
      ?? (api === RESPONSES && event?.type === "response.failed" ? (event.response?.error ?? event) : null);
    if (failure) {
      streamError = new Error(api === MESSAGES
        ? "Anthropic upstream stream failed"
        : String(failure?.message ?? JSON.stringify(failure)).slice(0, 400));
      // An error frame with the wire still clean is a dead lane, not a dead
      // request: swallow it so the caller can fail over and the client never
      // learns this attempt happened.
      if (relayed && api !== MESSAGES) await emit(raw);
      return false;
    }
    // Chat puts usage on the tail chunk; responses on the response that
    // `response.completed` carries (earlier events carry `usage: null`).
    const reported = api === MESSAGES && event?.type === "message_start"
      ? event?.message?.usage
      : event?.usage ?? event?.response?.usage;
    if (reported && typeof reported === "object") {
      usage = api === MESSAGES ? mergeMessagesUsage(usage, reported) : readUsage(reported);
    }
    for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
      const piece = choice?.delta?.content;
      if (typeof piece === "string") outputChars += piece.length;
    }
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") outputChars += event.delta.length;
    if (api === MESSAGES && event?.type === "content_block_delta") {
      if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") outputChars += event.delta.text.length;
      if (event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string") outputChars += event.delta.partial_json.length;
    }
    if (api === MESSAGES && event?.type === "message_stop") sawDone = true;
    // ☠️ The usage tail frame exists because WE asked for it, so it must not
    // reach a client that did not. Its `choices` is an empty array, and client
    // code written against a stream it configured itself reads
    // `chunk.choices[0].delta` -- a TypeError, not a no-op. Strip it, keep the
    // number.
    if (!keepUsageFrames && event?.usage && Array.isArray(event.choices) && event.choices.length === 0) return true;
    await emit(raw);
    return !(api === MESSAGES && event?.type === "message_stop");
  };

  try {
    for await (const chunk of stream) {
      touch();
      observe?.(chunk);
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let live = true;
      let match;
      while (live && (match = SSE_FRAME_END.exec(buffer))) {
        const text = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        live = await onFrame(text, match[0]);
      }
      if (!live) {
        buffer = "";
        break;
      }
    }
    // An upstream that ends its last frame without the trailing blank line
    // still owes us that frame -- most often the [DONE] we need to see.
    if (buffer.trim()) await onFrame(buffer.replace(/[\r\n]+$/, ""), "\n\n");
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
const relayBufferedAsStream = async ({ response, sink, keepUsageFrames, observe = null }) => {
  let payload;
  try {
    if (observe) {
      const raw = await response.text();
      observe(raw);
      payload = JSON.parse(raw);
    } else payload = await response.json();
  } catch {
    return { relayed: false, usage: null, outputChars: 0, sawDone: false,
      error: new Error("upstream returned 200 with an unparseable JSON body") };
  }
  const usage = payload?.usage && typeof payload.usage === "object" ? readUsage(payload.usage) : null;
  // Keep this dialect-recovery path byte-for-byte aligned with a deliberately buffered upstream
  // reply: tool calls and reasoning are part of the stream contract too.
  const frames = bufferedChatFrames(payload && typeof payload === "object" ? payload : {}, keepUsageFrames);
  for (const frame of frames.text) await sink.write(frame);
  return { relayed: true, usage, outputChars: frames.outputChars, error: null, sawDone: true };
};

// TRAP: WHY A STREAMED ASK CAN GO UPSTREAM BUFFERED (`bufferStreamingUpstream: true`). The mirror
// image of `assembleFromStream` below. Some lanes refuse to stream at all: the fleet auth proxy's
// Anthropic chat route answers `stream: true` with a 400 ("stream must be false") and its
// Responses route rejects any `stream` key, both on purpose. Home Assistant's Assist always
// streams, so every Assist request that fell back to that lane failed (measured 2026-10-12). A
// lane that opts in is asked for one buffered body; this reads it WHOLE and only then writes the
// stream the client asked for, so a failed or abandoned attempt has written nothing and failover
// is exactly the buffered path's. The cost, named: the client sees no token until the last one.
// Returns relayStream's outcome shape. A failed read (our timeout, the client's abort) surfaces as
// the error itself, so the caller can tell impatience from a broken body.
const relayBufferedReply = async ({ response, sink, keepUsageFrames, api, observe = null }) => {
  const failed = (error) => ({ relayed: false, usage: null, outputChars: 0, sawDone: false, error });
  let raw;
  try { raw = await response.text(); observe?.(raw); } catch (error) { return failed(error); }
  let payload;
  try { payload = JSON.parse(raw); } catch {
    return failed(new Error("upstream returned 200 with an unparseable JSON body"));
  }
  if (!payload || typeof payload !== "object") return failed(new Error("upstream returned 200 with an unparseable JSON body"));
  const usage = payload.usage && typeof payload.usage === "object" ? readUsage(payload.usage) : null;
  const frames = api === RESPONSES ? bufferedResponseEvents(payload) : bufferedChatFrames(payload, keepUsageFrames);
  for (const frame of frames.text) await sink.write(frame);
  return { relayed: true, usage, outputChars: frames.outputChars, error: null, sawDone: true };
};

// One chat.completion as the chunk sequence an OpenAI stream would have carried: per choice a
// role/content delta (reasoning_content riding with it when present), one tool_calls delta holding
// every call whole, and the finish_reason chunk; then the usage chunk if the client asked for it,
// then [DONE]. Every top-level field but choices/usage/object rides on every chunk, so a client
// that keeps the first value of each gets the buffered body back.
const bufferedChatFrames = (payload, keepUsageFrames) => {
  const head = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "choices" && key !== "usage" && key !== "object") head[key] = value;
  }
  head.object = "chat.completion.chunk";
  const chunks = [];
  let outputChars = 0;
  (Array.isArray(payload.choices) ? payload.choices : []).forEach((choice, position) => {
    const index = Number.isInteger(choice?.index) ? choice.index : position;
    const message = choice?.message ?? {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const content = typeof message.content === "string" ? message.content : (toolCalls.length ? null : "");
    outputChars += content?.length ?? 0;
    const delta = { role: message.role ?? "assistant", content };
    if (typeof message.reasoning_content === "string") delta.reasoning_content = message.reasoning_content;
    chunks.push({ ...head, choices: [{ index, delta, finish_reason: null, ...(choice?.logprobs !== undefined ? { logprobs: choice.logprobs } : {}) }] });
    if (toolCalls.length) {
      chunks.push({ ...head, choices: [{ index, delta: { tool_calls: toolCalls.map((call, at) => {
        outputChars += String(call?.function?.arguments ?? "").length;
        return { index: at, id: call?.id, type: call?.type ?? "function", function: { name: call?.function?.name, arguments: call?.function?.arguments ?? "" } };
      }) }, finish_reason: null }] });
    }
    chunks.push({ ...head, choices: [{ index, delta: {}, finish_reason: choice?.finish_reason ?? "stop" }] });
  });
  if (keepUsageFrames && payload.usage && typeof payload.usage === "object") chunks.push({ ...head, choices: [], usage: payload.usage });
  return { text: [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), DONE_FRAME], outputChars };
};

// One Responses object as the typed event sequence its stream would have carried: created, then
// per output item added -> (text part added/delta/done, or arguments delta/done) -> done, then the
// terminal event carrying the buffered response whole. Item kinds without deltas (reasoning, ...)
// get only added/done, both carrying the item. Responses streams have no [DONE].
const bufferedResponseEvents = (payload) => {
  const events = [];
  let outputChars = 0;
  const output = Array.isArray(payload.output) ? payload.output : [];
  events.push({ type: "response.created", response: { ...payload, status: "in_progress", output: [], usage: null } });
  output.forEach((item, outputIndex) => {
    const itemId = item?.id;
    if (item?.type === "message") {
      const parts = Array.isArray(item.content) ? item.content : [];
      events.push({ type: "response.output_item.added", output_index: outputIndex, item: { ...item, status: "in_progress", content: [] } });
      parts.forEach((part, contentIndex) => {
        const at = { item_id: itemId, output_index: outputIndex, content_index: contentIndex };
        if (part?.type === "output_text" && typeof part.text === "string") {
          outputChars += part.text.length;
          events.push({ type: "response.content_part.added", ...at, part: { ...part, text: "" } });
          events.push({ type: "response.output_text.delta", ...at, delta: part.text });
          events.push({ type: "response.output_text.done", ...at, text: part.text });
        } else {
          events.push({ type: "response.content_part.added", ...at, part });
        }
        events.push({ type: "response.content_part.done", ...at, part });
      });
    } else if (item?.type === "function_call") {
      const args = typeof item.arguments === "string" ? item.arguments : "";
      outputChars += args.length;
      events.push({ type: "response.output_item.added", output_index: outputIndex, item: { ...item, status: "in_progress", arguments: "" } });
      events.push({ type: "response.function_call_arguments.delta", item_id: itemId, output_index: outputIndex, delta: args });
      events.push({ type: "response.function_call_arguments.done", item_id: itemId, output_index: outputIndex, arguments: args });
    } else {
      events.push({ type: "response.output_item.added", output_index: outputIndex, item });
    }
    events.push({ type: "response.output_item.done", output_index: outputIndex, item });
  });
  const terminal = payload.status === "incomplete" ? "response.incomplete"
    : payload.status === "failed" ? "response.failed"
      : "response.completed";
  events.push({ type: terminal, response: payload });
  return {
    text: events.map((event, sequence) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`),
    outputChars,
  };
};

// TRAP: WHY A BUFFERED ASK CAN GO UPSTREAM AS A STREAM (`assembleFromStream: true`). llama.cpp in
// router mode (measured on build b11552, 2026-10-12) does NOT cancel a non-streaming generation
// when its HTTP client hangs up; it cancels a streaming one within ~0.2 s. So the gateway's own
// timeoutMs and a caller's disconnect both aborted the fetch and left the model generating to
// max_tokens -- one orphan held a 27b slot for 12 minutes. A lane that opts in is asked to stream,
// and this reads that stream to its end and builds the chat.completion the buffered upstream
// would have returned, so aborting the fetch actually stops the generation. Nothing reaches the
// client until it is whole, so failover and every consumer downstream are unchanged.
// Returns { payload } or { error }; an abort while reading surfaces as the error itself, so the
// caller can tell our impatience (or the client's) from a broken stream.
const assembleChatCompletion = async (stream) => {
  const decoder = new TextDecoder();
  const top = new Map(); // first non-null value per unknown top-level key
  const choices = new Map(); // by index
  let usage;
  let sawUsageKey = false;
  let sawDone = false;
  let buffer = "";
  const keepFirst = (map, key, value) => {
    if (!map.has(key) || (map.get(key) === null && value !== null)) map.set(key, value ?? null);
  };
  const choiceAt = (index) => {
    if (!choices.has(index)) {
      choices.set(index, { fields: new Map(), role: null, content: null, reasoning: null, toolCalls: new Map(), finishReason: null, logprobs: undefined });
    }
    return choices.get(index);
  };
  const absorb = (event) => {
    for (const [key, value] of Object.entries(event)) {
      if (key === "choices" || key === "object") continue;
      if (key === "usage") {
        sawUsageKey = true;
        if (value && typeof value === "object") usage = value; // the final usage chunk wins
        continue;
      }
      keepFirst(top, key, value);
    }
    for (const part of Array.isArray(event.choices) ? event.choices : []) {
      const choice = choiceAt(Number(part?.index) || 0);
      for (const [key, value] of Object.entries(part ?? {})) {
        if (key === "index" || key === "delta") continue;
        if (key === "finish_reason") { if (value != null) choice.finishReason = value; continue; }
        if (key === "logprobs") {
          // Streamed logprobs arrive a token's worth per chunk; buffered, as one list per field.
          if (value && typeof value === "object") {
            const merged = choice.logprobs ?? {};
            for (const [field, entries] of Object.entries(value)) {
              merged[field] = Array.isArray(entries) ? [...(Array.isArray(merged[field]) ? merged[field] : []), ...entries] : entries;
            }
            choice.logprobs = merged;
          } else if (choice.logprobs === undefined) choice.logprobs = null;
          continue;
        }
        keepFirst(choice.fields, key, value);
      }
      const delta = part?.delta ?? {};
      if (typeof delta.role === "string" && !choice.role) choice.role = delta.role;
      if (typeof delta.content === "string") choice.content = (choice.content ?? "") + delta.content;
      if (typeof delta.reasoning_content === "string") choice.reasoning = (choice.reasoning ?? "") + delta.reasoning_content;
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const at = Number(call?.index) || 0;
        const entry = choice.toolCalls.get(at) ?? { id: null, name: null, arguments: "" };
        if (!entry.id && call?.id) entry.id = call.id;
        // The name is sent once, on the call's first delta; only the arguments are streamed.
        if (!entry.name && call?.function?.name) entry.name = call.function.name;
        if (typeof call?.function?.arguments === "string") entry.arguments += call.function.arguments;
        choice.toolCalls.set(at, entry);
      }
    }
  };
  // Returns an Error for a frame that ends this attempt, else null.
  const onFrame = (text) => {
    const data = sseData(text);
    if (!data) return null; // comment / heartbeat
    if (data.trim() === "[DONE]") { sawDone = true; return null; }
    let event;
    try { event = JSON.parse(data); } catch {
      return new Error("upstream stream carried unparseable data");
    }
    if (!event || typeof event !== "object") return new Error("upstream stream carried unparseable data");
    if (event.error) return new Error(String(event.error?.message ?? JSON.stringify(event.error)).slice(0, 400));
    absorb(event);
    return null;
  };
  try {
    // Leaving this loop early (return) cancels the body, which closes the upstream connection:
    // a lane that sent garbage is not left generating either.
    for await (const piece of stream) {
      buffer += typeof piece === "string" ? piece : decoder.decode(piece, { stream: true });
      let match;
      while (!sawDone && (match = SSE_FRAME_END.exec(buffer))) {
        const text = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const failure = onFrame(text);
        if (failure) return { error: failure };
      }
      if (sawDone) break;
    }
    if (!sawDone && buffer.trim()) {
      const failure = onFrame(buffer.replace(/[\r\n]+$/, ""));
      if (failure) return { error: failure };
    }
  } catch (error) {
    return { error };
  }
  if (!sawDone) return { error: new Error("upstream stream ended without [DONE]") };
  const payload = {};
  for (const [key, value] of top) payload[key] = value;
  payload.object = "chat.completion";
  payload.choices = [...choices.keys()].sort((a, b) => a - b).map((index) => {
    const choice = choices.get(index);
    const toolCalls = [...choice.toolCalls.keys()].sort((a, b) => a - b).map((at) => {
      const call = choice.toolCalls.get(at);
      return { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
    });
    // OpenAI's buffered shape: content is null for a pure tool-call turn, a string otherwise.
    const message = { role: choice.role ?? "assistant", content: choice.content ?? (toolCalls.length ? null : "") };
    if (choice.reasoning !== null) message.reasoning_content = choice.reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    const assembled = { index, message, finish_reason: choice.finishReason };
    for (const [key, value] of choice.fields) assembled[key] = value;
    if (choice.logprobs !== undefined) assembled.logprobs = choice.logprobs;
    return assembled;
  });
  if (usage) payload.usage = usage;
  else if (sawUsageKey) payload.usage = null;
  return { payload };
};

// Responses streams end in `response.completed`, whose `response` is the authoritative buffered
// object. Some compatible servers omit it, so retain enough typed-event state to return their
// output-item/delta equivalent. Unlike chat, Responses has no [DONE]: completion is mandatory.
const assembleResponse = async (stream) => {
  const decoder = new TextDecoder();
  const output = new Map();
  let created = null;
  let completed = false;
  let finalResponse = null;
  let buffer = "";
  const itemAt = (event) => {
    const key = event?.output_index ?? event?.item?.id ?? event?.item_id;
    if (!output.has(key)) output.set(key, { id: event?.item_id, type: "message", role: "assistant", content: [] });
    return output.get(key);
  };
  const appendText = (item, index, delta, type = "output_text") => {
    const content = item.content ?? (item.content = []);
    const at = Number(index) || 0;
    if (!content[at]) content[at] = { type, text: "" };
    content[at].text = `${content[at].text ?? ""}${delta}`;
  };
  const absorb = (event) => {
    if (event.type === "response.created" && event.response && typeof event.response === "object") created = event.response;
    if (event.type === "response.output_item.added") output.set(event.output_index ?? event.item?.id, structuredClone(event.item));
    if (event.type === "response.output_item.done") output.set(event.output_index ?? event.item?.id, structuredClone(event.item));
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") appendText(itemAt(event), event.content_index, event.delta);
    if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const item = itemAt(event);
      item.type = "function_call";
      item.arguments = `${item.arguments ?? ""}${event.delta}`;
    }
    if (/^response\.reasoning_.*\.delta$/.test(event.type) && typeof event.delta === "string") {
      const item = itemAt(event);
      const summary = item.summary ?? (item.summary = []);
      const at = Number(event.summary_index ?? event.content_index) || 0;
      if (!summary[at]) summary[at] = { type: "summary_text", text: "" };
      summary[at].text = `${summary[at].text ?? ""}${event.delta}`;
    }
    if (event.type === "response.completed") {
      completed = true;
      if (event.response && typeof event.response === "object") finalResponse = event.response;
    }
  };
  const onFrame = (text) => {
    const data = sseData(text);
    if (!data) return null;
    let event;
    try { event = JSON.parse(data); } catch { return new Error("upstream responses stream carried unparseable data"); }
    if (!event || typeof event !== "object") return new Error("upstream responses stream carried unparseable data");
    const failure = event.error ?? (event.type === "response.failed" ? (event.response?.error ?? event) : null);
    if (failure) return new Error(String(failure.message ?? JSON.stringify(failure)).slice(0, 400));
    absorb(event);
    return null;
  };
  try {
    for await (const piece of stream) {
      buffer += typeof piece === "string" ? piece : decoder.decode(piece, { stream: true });
      let match;
      while (!completed && (match = SSE_FRAME_END.exec(buffer))) {
        const failure = onFrame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (failure) return { error: failure };
      }
      if (completed) break;
    }
    if (!completed && buffer.trim()) {
      const failure = onFrame(buffer.replace(/[\r\n]+$/, ""));
      if (failure) return { error: failure };
    }
  } catch (error) { return { error }; }
  if (!completed) return { error: new Error("upstream responses stream ended without response.completed") };
  if (finalResponse) return { payload: finalResponse };
  return { payload: { ...(created ?? {}), object: "response", output: [...output.values()] } };
};

/** Broker tiers a rig session may ask for; anything else is ignored (the name's own tier applies). */
const RIG_TIERS = new Set(["worker", "review", "build", "smart", "deep"]);
/**
 * The opt-in rig hints: a stable session id (`x-rig-session`, 8-96 of [A-Za-z0-9_-]) and an optional
 * tier (`x-rig-tier`). Malformed values are dropped, never guessed at.
 */
export const rigSessionHints = (headers = {}) => {
  const session = typeof headers.rigSession === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(headers.rigSession)
    ? headers.rigSession : null;
  if (!session) return null;
  const tier = typeof headers.rigTier === "string" && RIG_TIERS.has(headers.rigTier) ? headers.rigTier : null;
  return { session, tier };
};

export const createGatewayHandler = ({
  config,
  brokerRequest,
  fetchImpl = fetch,
  gatewayKey,
  authPath,
  now = Date.now,
  // Injected beside `now` so a test can advance the SAME clock the wait arithmetic reads.
  // Production passes neither and behaves exactly as before.
  sleepImpl = sleep,
  // The tenant surface's bearer token, read ONCE at startup from a root-owned drop file by
  // the bin. A long-running service must never call rbw -- the vault may be locked when it
  // restarts -- and the token must never be in the compose env, in config, or in git.
  // Absent means the surface is closed, not open.
  tenantToken = null,
  // Private health credentials are startup-injected only. They are never accepted from the
  // public JSON body or front-door headers.
  health = null,
  reservationsPath = DEFAULT_RESERVATIONS_PATH,
  // Injected so no test can spawn a real model-swap. On 2026-09-07 a test run in the llamacpp
  // repo fired a real swap and pulled a model out from under a live session.
  runModelSwap = spawnModelSwap,
  // Where the per-request failure log goes: one JSON string per call, no newline. Injected only
  // so tests can read it; production writes stderr, which systemd hands to journald.
  logLine = (line) => { process.stderr.write(`${line}\n`); },
}) => {
  validateProviderFlags(config.providers);
  const allowedProviders = Object.keys(config.providers);
  const healthReporter = health?.key instanceof Uint8Array && typeof health.gatewayCredential === "string"
    ? createGatewayHealth({ key: health.key, gatewayCredential: health.gatewayCredential, brokerRequest, now, sleepImpl })
    : null;

  // WHO ASKED, per gateway session: the client's address and the model name it sent. Every
  // gateway request is a fresh `gw-...` session, so without this the broker's decision and
  // usage logs cannot tell one consumer from another -- a memory service's ingestion, a
  // document extractor and a chat UI all read as anonymous gateway traffic.
  const callers = new Map();
  const callerOf = (sessionID) => callers.get(sessionID);
  // Strict-mode session exemptions without a lease header are evidence for a future hardening
  // decision. Keep one entry per session, but never let observability state grow unbounded.
  const sessionBoundWithoutLeaseLogged = new Set();
  const MAX_SESSION_BOUND_WITHOUT_LEASE_LOGS = 500;
  const leaseOnce = async (
    sessionID,
    requestBody,
    excludeProviders = [],
    route = null,
    api = CHAT,
    waitedMs = 0,
    probeAssignment = null,
    excludeTargetIDs = [],
  ) => {
    // Local targets are strict: an unknown context size never fits them, so a
    // lease without contextTokens can never land local. See estimateContextTokens
    // for why images are not counted by their base64 length.
    const contextTokens = api === EMBEDDINGS
      ? embeddingInputTokens(requestBody?.input)
      : estimateContextTokens(requestBody);
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
    const capOf = (id) => {
      const cap = routeCap ?? Number(config.providers[id]?.maxContextTokens);
      return Number.isFinite(cap) && cap > 0 ? cap : null;
    };
    const servingProviders = allowedProviders.filter((id) => providerServes(config.providers[id] ?? {}, api));
    const forwardableProviders = servingProviders.filter((id) => {
      const cap = capOf(id);
      return !(cap !== null && contextTokens > cap);
    });
    const providers = forwardableProviders.filter((id) => !excludeProviders.includes(id));
    if (!providers.length) {
      const apiUnsupported = !servingProviders.length;
      // Every lane that serves this API was dropped by its context cap alone: say THAT, with the
      // numbers. "excluded" here sent an operator hunting for a failure that never happened.
      // Several lanes may carry different caps; the largest is the one the request missed by least.
      const overCap = !apiUnsupported && !forwardableProviders.length;
      const error = new Error(apiUnsupported
        ? `no configured lane serves /v1${api.path} (set ${api.name}Api: true on one that does)`
        : overCap
          ? `request estimated at ${contextTokens} tokens exceeds the context cap ${Math.max(...servingProviders.map(capOf))} for every lane that serves it`
          : "every forwardable provider was excluded this attempt");
      if (forwardableProviders.length && forwardableProviders.every((id) => excludeProviders.includes(id))) {
        error.code = LOCAL_FORWARDABLE_EXHAUSTION;
      }
      throw error;
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
      tier: route?.tier ?? config.tier,
      replace: true,
      // This session id is minted per CLIENT REQUEST above and never reused, so the
      // assignment it leaves behind is unreadable the moment the request settles. Saying so
      // lets the broker's assignment cap spend these before any real session's sticky pin;
      // without it, gateway traffic evicted live sessions' models purely by being newer.
      // ...except a rig session, which is long-lived by design and must keep its pin.
      ...(sessionID.startsWith("rig-") ? {} : { oneShot: true }),
      ...(api === EMBEDDINGS ? { api: "embeddings" } : {}),
      contextTokens,
      // How long THIS caller has already queued for a slot on this lane. The broker holds a
      // delayed fallback rung shut until this reaches the rung's threshold, so a lane that is
      // merely bursty cannot seize a scarce shared target the moment its own lane is busy.
      waitedMs,
      providers,
      ...(excludeTargetIDs.length ? { excludeTargetIDs } : {}),
      ...(probeAssignment ? {
        preferredModel: {
          providerID: probeAssignment.preferredModel.providerID,
          id: probeAssignment.preferredModel.modelID,
        },
      } : {}),
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
    const wireModelID = speedAliasBase(model.id);
    return {
      sessionID,
      leaseID: lease?.leaseID,
      providerID: model.providerID,
      modelID: model.id,
      // Gateway-owned aliases use the same wire-model forwarding path as a
      // session-bound lease: retain the alias for lease identity, base for wire.
      ...(wireModelID ? { wireModelID } : {}),
      targetID: typeof lease?.target?.id === "string" ? lease.target.id : model.id,
      embedding: lease?.target?.embedding === true,
      expectedCredentialInstance: typeof lease?.expectedCredentialInstance === "string" ? lease.expectedCredentialInstance : null,
    };
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

  // ☠️ WAITERS ARE SERVED IN ARRIVAL ORDER. Every waiting request used to retry on its own
  // timer, so a freed slot went to whichever retry happened to land first -- often a request
  // that had just arrived. Measured 2026-09-21 on a memory service's 3-slot lane: median wait
  // 55 s, p99 27 minutes, max 40, against a 50-minute budget. The tail is the unfairness, not the
  // load. Now the requests waiting on one profile form a queue: only its head retries, a newcomer
  // does not try ahead of a non-empty queue, and a head that gets its lease wakes the next one at
  // once, so several slots freeing together drain without a retry interval between them.
  const waiting = new Map(); // profile -> entries in arrival order

  const leaseWithPrepare = async (
    sessionID,
    requestBody,
    excluded,
    route,
    clientAbort,
    deadline,
    api = CHAT,
    probeAssignment = null,
    excludeTargetIDs = [],
  ) => {
    const line = route?.profile ?? config.profile;
    const budget = waitFor(route);
    let entry = null;
    let lastRefusal = null;
    // ☠️ Set at the first WAITABLE refusal, not at entry. This is per INVOCATION, and
    // completionsFor calls this once per forward attempt, so attempt 2 starts from zero -- it
    // has not queued for anything yet, and inheriting attempt 1's elapsed time would hand it a
    // delayed rung on its very first ask. Deliberately not derived from the request deadline,
    // which is shared across attempts precisely so a retry cannot buy a second full window.
    let waitStarted = null;
    const leave = () => {
      if (!entry) return;
      const queue = waiting.get(line) ?? [];
      const at = queue.indexOf(entry);
      if (at >= 0) queue.splice(at, 1);
      if (!queue.length) waiting.delete(line);
      else if (at === 0) queue[0].wake();
      entry = null;
    };
    try {
      for (;;) {
        const queue = waiting.get(line);
        // ☆ A zero budget never waits, so it never queues: it asks once and takes the answer.
        const myTurn = budget === 0 || (entry ? queue?.[0] === entry : !queue?.length);
        if (myTurn) {
          // Time spent waiting, not time spent being answered: a slow first refusal is latency,
          // and counting it would let a request that never queued walk onto a delayed rung.
          const waitedMs = waitStarted === null ? 0 : Math.max(0, now() - waitStarted);
          try {
            return await leaseOnce(sessionID, requestBody, excluded, route, api, waitedMs, probeAssignment, excludeTargetIDs);
          } catch (refusal) {
            // A swap is waited out only for a mapped name (the rule below); a busy slot is waited
            // out for everyone. The deadline is the request's own either way.
            const absentLocal = route?.waitForLocal === true &&
              (refusal?.code === ABSENT_LOCAL || brokerUnreachable(refusal));
            if (!isBusy(refusal) && !(route && isPreparing(refusal)) && !absentLocal) throw refusal;
            // ☠️ A ZERO BUDGET IS "TELL ME NOW", NOT "WAIT ZERO SECONDS". Rethrow the broker's own
            // refusal untouched -- it carries the real reason and the machine-readable code, and
            // rewriting it as "the gateway waited 0s" would be both noise and a lie.
            if (budget === 0) throw refusal;
            // After the waitability gate and after the zero-budget throw, so a caller that is
            // never going to wait never accrues a wait.
            if (waitStarted === null) waitStarted = now();
            lastRefusal = refusal;
          }
        }
        const left = deadline - now();
        // ☆ The swap outlives our patience often enough to say so plainly: the
        // message is what a human sees in the picker, and "try again shortly"
        // is actionable where a bare 502 is not.
        if (left <= 0) {
          throw new Error(lastRefusal
            ? `${lastRefusal.message} -- the gateway waited ${Math.round(budget / 1000)}s and it is still ${isBusy(lastRefusal) ? "busy" : "not resident"}; try again shortly`
            : `every slot on this lane stayed busy -- the gateway waited ${Math.round(budget / 1000)}s in line behind earlier requests; try again shortly`);
        }
        if (clientAbort?.aborted) throw new Error("client disconnected");
        if (!entry) {
          entry = { wake: () => {} };
          if (!waiting.has(line)) waiting.set(line, []);
          waiting.get(line).push(entry);
        }
        await new Promise((resolve) => {
          entry.wake = resolve;
          sleepImpl(Math.min(prepareRetryMs, left), clientAbort).then(resolve);
        });
      }
    } finally {
      leave();
    }
  };

  const settle = async (leased, path, body = {}) => {
    // A session-bound request rides the opencode session's OWN lease: the plugin that minted it
    // reports its usage, failure and release, so the gateway settling it too would double-count
    // spend and could drop a lease the session still holds for its next step.
    if (leased?.external) return;
    try {
      await brokerRequest(path, {
        sessionID: leased.sessionID,
        ...(leased.leaseID ? { leaseID: leased.leaseID } : {}),
        ...body,
      });
    } catch { /* broker hiccup must not fail the request */ }
  };

  const reportUsage = async (leased, tokens) => settle(leased, "/usage", {
    ...(callerOf(leased.sessionID) ? { caller: callerOf(leased.sessionID) } : {}),
    providerID: leased.providerID,
    modelID: leased.modelID,
    requests: 1,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      ...(Object.hasOwn(tokens, "cacheRead") ? { cacheRead: tokens.cacheRead } : {}),
      ...(Object.hasOwn(tokens, "cacheWrite") ? { cacheWrite: tokens.cacheWrite } : {}),
    },
    ...(tokens.estimated ? { estimated: true } : {}),
  });

  // `sink` present == the client asked for SSE and gets frames instead of a
  // payload; absent == the buffered path, unchanged since 0.1.0.
  const completions = async (
    requestBody,
    clientAbort = null,
    sink = null,
    api = CHAT,
    caller = null,
    requestHeaders = {},
    probeAssignment = null,
    boundLease = null,
    trace = null,
  ) => {
    const streaming = Boolean(sink);
    const wantedJson = Boolean(requestBody?.response_format?.type?.startsWith?.("json"));
    // Did the CLIENT ask for the usage tail, or only we? (See the strip in
    // relayStream: the difference decides whether it reaches them.)
    const keepUsageFrames = requestBody?.stream_options?.include_usage === true;
    // The client's `model` is a routing request. Unmapped -> null -> every lease
    // below is byte-identical to a gateway with no modelProfiles at all.
    const namedRoute = modelRoute(config, requestBody?.model);
    // rig sessions (Pi behind the trusted frontend) name a STABLE session and a tier. The broker
    // then pins that session to its model exactly as it pins an opencode session, so a
    // conversation keeps its prompt cache instead of being re-rolled on every request as a
    // one-shot gw- session is. Opt-in and additive: without both headers nothing below changes.
    // Only a name whose route already carries a tier (the cloud-tier names `smart`/`auto`) may
    // take another tier, so a private or local name can never be escalated to the cloud.
    const rig = !probeAssignment && !boundLease ? rigSessionHints(requestHeaders) : null;
    const route = rig?.tier && namedRoute?.tier ? { ...namedRoute, tier: rig.tier } : namedRoute;
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
    const sessionID = probeAssignment?.sessionID
      ?? (rig ? `rig-${rig.session}` : `gw-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    if (caller) callers.set(sessionID, caller);
    try {
      return await completionsFor(
        sessionID,
        requestBody,
        clientAbort,
        sink,
        api,
        route,
        streaming,
        wantedJson,
        keepUsageFrames,
        requestHeaders,
        probeAssignment,
        boundLease,
        trace,
      );
    } finally {
      callers.delete(sessionID);
      if (probeAssignment) {
        const release = {
          sessionID: probeAssignment.sessionID,
          probeNonce: probeAssignment.probeNonce,
          ...(probeAssignment.outageAssignment ? {
            leaseID: probeAssignment.leaseID,
            purpose: "outage-health",
          } : {}),
        };
        try { await brokerRequest("/probe/release", release); } catch { /* probe expiry is the broker-side backstop */ }
      }
    }
  };
  const completionsFor = async (
    sessionID,
    requestBody,
    clientAbort,
    sink,
    api,
    route,
    streaming,
    wantedJson,
    keepUsageFrames,
    requestHeaders,
    probeAssignment = null,
    boundLease = null,
    trace = null,
  ) => {
    // One entry per upstream attempt that failed, for the failure log (see handle's wrapper).
    // Recording only: nothing here reads it back, so routing cannot depend on it.
    const noteAttempt = (leased, outcome, detail) => {
      trace?.attempts.push({ provider: leased.providerID, model: leased.modelID, outcome, detail: logDetail(detail) });
    };
    // The session hints are validated once per request; whether they go out at all is
    // decided per provider, per attempt, at the forward site (forwardHeaders).
    const forwardSessionID = typeof requestHeaders.sessionID === "string"
      && SESSION_ID_SHAPE.test(requestHeaders.sessionID)
      ? requestHeaders.sessionID : null;
    const forwardSessionKind = requestHeaders.sessionKind === "primary" || requestHeaders.sessionKind === "subagent"
      ? requestHeaders.sessionKind : null;
    let lastError = null;
    let lastForwardError = null;
    // Every provider that answered with a usage limit during this request, so the final reply
    // can name them all (a retry may walk across several spent plans).
    const usageLimited = [];
    const rememberForwardError = (error) => {
      lastForwardError = error;
      lastError = error;
      if (error?.usageLimit && !usageLimited.some((entry) => entry.providerID === error.usageLimit.providerID)) {
        usageLimited.push(error.usageLimit);
      }
    };
    let acquiredLease = false;
    let lastLeased = null;
    const excluded = [];
    const excludedTargets = [];
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
    // HEALTH IDENTITY IS PER INBOUND HTTP REQUEST, NOT PER SESSION OR ATTEMPT INDEX. The
    // broker's outage reducer dedupes failures by attemptID and diagnoses only on failures from
    // two distinct requestIDs. An index-only attemptID ("0") collided across every request on a
    // held session and across every gw- request's first attempt, so only one failure was ever
    // recorded and no outage could be diagnosed. completionsFor runs once per inbound HTTP
    // request, so one server-generated UUID minted here names that request for every attempt
    // (retries and scope reroutes included), and `${UUID}:${attempt}` names each actual attempt.
    // Never derived from caller headers or session ids; minted only when health is enabled.
    const healthRequestID = healthReporter ? randomUUID() : null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      // ☠️ A SESSION-BOUND REQUEST GETS EXACTLY ONE ATTEMPT, ON EXACTLY ITS MODEL. Choosing a
      // different target is the session's own router's job (it holds the pin and the transcript
      // context); a gateway retry onto another lane would answer a Claude turn from whatever the
      // worker tier had free, which is how every opencode prompt failed on 2026-10-01.
      if ((boundLease || probeAssignment?.purpose === "outage-health") && attempt > 0) break;
      let leased;
      try {
        leased = boundLease ?? await leaseWithPrepare(
          sessionID,
          requestBody,
          excluded,
          route,
          clientAbort,
          deadline,
          api,
          probeAssignment,
          excludedTargets,
        );
      }
      catch (error) {
        // A local retry dead-end adds no new diagnosis. Broker and pre-forward
        // errors still replace the old failure because they carry new facts.
        lastError = error?.code === LOCAL_FORWARDABLE_EXHAUSTION && lastForwardError
          ? lastForwardError
          : error;
        break;
      }
      acquiredLease = true;
      lastLeased = leased;
      // A broker lease is authoritative about target capability. Releasing here keeps a
      // misconfigured chain from pinning a slot while ensuring request types never cross.
      if (api === EMBEDDINGS ? !leased.embedding : leased.embedding) {
        await settle(leased, "/release");
        return {
          status: 400,
          payload: { error: { message: api === EMBEDDINGS
            ? "gateway: embeddings require an embedding target"
            : "gateway: chat, responses and messages require a chat target", type: "invalid_request_error" } },
        };
      }
      const providerConfig = config.providers[leased.providerID];
      if (!providerConfig?.baseUrl) {
        await settle(leased, "/release");
        lastError = new Error(`no forward config for ${leased.providerID}`);
        noteAttempt(leased, "no_forward_config", lastError.message);
        continue;
      }
      // A stale local credential is OUR problem, not the provider's: indicting
      // it here would quarantine a healthy lane the same way timeout reports
      // did. Release, skip the lane for this request, move on.
      let key;
      try { key = await providerKey(providerConfig, authPath); } catch (error) {
        await settle(leased, "/release");
        excludeLane(leased.providerID);
        // ☠️ SAY SO. This path spends a real lease and produces nothing: no usage is reported and
        // no `/failure` is filed (deliberately -- a stale LOCAL credential must not indict a
        // healthy provider), so before this line it was completely invisible. A lane whose
        // credential stopped resolving burned two leases per request in total silence; the only
        // trace was cloud leases in the decision log with no matching usage, which reads like a
        // routing bug rather than an expired token. Name the lane and the reason.
        console.error(`opencode-gateway: ${leased.providerID} credential did not resolve -- released the lease and skipped the lane for this request: ${String(error?.message ?? error)}`);
        lastError = new Error(`${leased.providerID} credential did not resolve: ${String(error?.message ?? error)}`);
        noteAttempt(leased, "credential", lastError.message);
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
      // A streamed client ask on a `bufferStreamingUpstream` lane goes upstream BUFFERED (see
      // relayBufferedReply), so it wears the buffered path's clock -- timeoutMs as a total deadline
      // plus the client's abort -- and never the stall watchdog: a buffered upstream sends nothing
      // until it is done, which the watchdog would read as a stall. Messages keeps its native
      // stream; the flag covers the two OpenAI-shaped routes.
      const bufferingStream = streaming && providerConfig.bufferStreamingUpstream === true
        && (api === CHAT || api === RESPONSES);
      const upstreamStreaming = streaming && !bufferingStream;
      const stallAbort = upstreamStreaming ? new AbortController() : null;
      let stallTimer = null;
      const touch = (ms) => {
        clearTimeout(stallTimer);
        // ☆ A TimeoutError (not a bare Error) keeps a stall in the "our
        // impatience: release, do not indict" class the catch below already
        // sorts by name.
        stallTimer = setTimeout(() => stallAbort.abort(new DOMException("upstream stalled", "TimeoutError")), ms);
        stallTimer.unref?.();
      };
      // Chat never assembles n > 1. Responses can opt in only when the lane explicitly serves
      // that API; Messages and embeddings retain their buffered upstream request.
      const assembling = !streaming && providerConfig.assembleFromStream === true && (
        (api === CHAT && !(Number(requestBody?.n) > 1))
        || (api === RESPONSES && providerConfig.responsesApi === true)
      );
      let response;
      let healthAttempt = null;
      let instructedJson = false;
      try {
        const abort = upstreamStreaming
          ? (AbortSignal.any
            ? AbortSignal.any([stallAbort.signal, ...(clientAbort ? [clientAbort] : [])])
            : stallAbort.signal)
          : (AbortSignal.any
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(clientAbort ? [clientAbort] : [])])
            : AbortSignal.timeout(timeoutMs));
        if (upstreamStreaming) touch(idleMs);
        // Providers without OpenAI's json_object mode (Anthropic's compat
        // endpoint accepts only strict closed schemas) get the instruct
        // bridge: strip response_format, demand raw JSON in an appended
        // instruction. Haiku-class models comply reliably; a rare miss is one
        // failed attempt, not a dead lane.
        // A session-bound lease may name a speed alias the upstream does not know; it carries the
        // id the client sent as wireModelID (see leaseCoversWireModel). Gateway leases have none.
        let forwardBody = { ...requestBody, model: leased.wireModelID ?? leased.modelID };
        const extras = api === MESSAGES ? {} : {
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
        for (const key of api === MESSAGES ? [] : Array.isArray(providerConfig.dropBodyKeys) ? providerConfig.dropBodyKeys : []) {
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
        if (bufferingStream) {
          // Both keys go, not `stream: false`: the proxy's Responses route rejects any `stream`
          // key, and its chat route rejects `stream_options` as an unknown field. The client's
          // include_usage ask is honoured downstream from the buffered body's usage.
          delete forwardBody.stream;
          delete forwardBody.stream_options;
        }
        if (upstreamStreaming) {
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
        // A buffered client ask on an `assembleFromStream` lane goes upstream as a stream, so an
        // abort can cancel the generation. Chat needs include_usage; Responses reports it on
        // response.completed and strict servers need not accept chat's stream_options.
        if (assembling) {
          forwardBody = {
            ...forwardBody,
            stream: true,
            ...(api === CHAT ? { stream_options: { ...(forwardBody.stream_options ?? {}), include_usage: true } } : {}),
          };
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
        const forwardHeaders = {
          "Content-Type": api === MESSAGES
            ? String(requestHeaders.contentType ?? "application/json")
            : "application/json",
          ...(api === MESSAGES && requestHeaders.anthropicVersion
            ? { "anthropic-version": requestHeaders.anthropicVersion } : {}),
          ...(api === MESSAGES && requestHeaders.anthropicBeta
            ? { "anthropic-beta": requestHeaders.anthropicBeta } : {}),
          ...(providerConfig.headers && typeof providerConfig.headers === "object" ? providerConfig.headers : {}),
          // The opencode session hints: which session is asking, and whether it is a
          // subagent. llm-auth-proxy uses the kind to pick the prompt-cache TTL
          // (subagent 5m, otherwise 1h) and the id to link request fingerprints for
          // prefix-change diagnostics; it strips both before calling Anthropic. They
          // are opt-in per provider on purpose: a session id is a fleet-internal
          // identity, and a third-party upstream (alibaba, a direct llama.cpp) must
          // never receive it. So the decision is made HERE, per providerConfig, per
          // attempt: a request that fails over to a lane that did not opt in leaves
          // the hints behind. Only validated values reach this point -- an invalid
          // one is dropped, silently, because the hints steer cache and diagnostics,
          // they are not auth.
          ...(providerConfig.forwardSessionHints === true
            ? {
              ...(forwardSessionID ? { "x-opencode-session-id": forwardSessionID } : {}),
              ...(forwardSessionKind ? { "x-opencode-session-kind": forwardSessionKind } : {}),
            }
            : {}),
        };
        if (providerConfig.keyFile) {
          for (const name of Object.keys(forwardHeaders)) {
            if (["authorization", "x-api-key"].includes(name.toLowerCase())) delete forwardHeaders[name];
          }
          if (key) forwardHeaders["x-api-key"] = key;
        } else if (key) {
          forwardHeaders.Authorization = `Bearer ${key}`;
        }
        // A FAST OUTAGE SCOPE IS ASKED FOR IN THE BODY, NOT THE MODEL ID. Anthropic's fast mode
        // is the BASE model plus top-level speed "fast" plus the fast-mode beta; the assignment
        // writer already put the base id in wireModelID. Only the trusted consumed outage
        // assignment decides this -- never a caller header, never provider bodyExtras, and an
        // ordinary request's body/speed is left exactly as sent. Done before serialization so the
        // signed health context and bodySHA256 bind the final fast body. Fast is defined only for
        // native Messages; anything else is refused rather than sent as a fake fast probe.
        if (probeAssignment?.outageAssignment === true && leased.outageAssignment === true
          && leased.expectedScopePolicy?.speed === "fast") {
          if (api !== MESSAGES) {
            lastError = new Error("fast outage scope requires native Messages");
            break;
          }
          forwardBody = { ...forwardBody, speed: "fast" };
          const betas = [];
          for (const name of Object.keys(forwardHeaders)) {
            if (name.toLowerCase() !== "anthropic-beta") continue;
            for (const beta of String(forwardHeaders[name]).split(",")) {
              const value = beta.trim();
              if (value && !betas.includes(value)) betas.push(value);
            }
            delete forwardHeaders[name];
          }
          if (!betas.includes(FAST_MODE_BETA)) betas.push(FAST_MODE_BETA);
          forwardHeaders["anthropic-beta"] = betas.join(",");
        }
        const outboundBody = JSON.stringify(forwardBody);
        const purpose = probeAssignment?.purpose === "outage-health" ? "outage-health" : "real";
        // ☠️ HEALTH CONTEXT ONLY WHERE THE PROXY CAN ATTEST IT. llm-auth-proxy verifies a private
        // health context only on Claude Code Messages and Codex Responses (the outage design's
        // product paths); on any other route it answers 403 "invalid health context" before the
        // request runs. Signing a chat-completions request therefore turned every ordinary Claude
        // chat request through this gateway into a 403 (the smart lane's 502s from 2026-10-16).
        // Off those paths no context is sent: an ordinary primary request runs exactly as it did
        // before health existed, and one that REQUIRES verified health (a reserve lease or an
        // outage probe) still fails below rather than going out unverified.
        if (healthReporter && (api === MESSAGES || api === RESPONSES)) {
          try {
            healthAttempt = await healthReporter.begin({
              leased,
              requestID: healthRequestID,
              attemptID: `${healthRequestID}:${attempt}`,
              purpose,
              bodyText: outboundBody,
              api: api === MESSAGES ? "messages" : api === RESPONSES ? "responses" : "chat",
            });
          } catch (error) {
            if (probeAssignment?.purpose === "outage-health") {
              lastError = new Error("health control plane unavailable");
              break;
            }
          }
        }
        const requiresVerifiedHealth = probeAssignment?.purpose === "outage-health" || leased.expectedCredentialInstance !== null;
        if (requiresVerifiedHealth && !healthAttempt) {
          lastError = new Error("health control plane unavailable");
          break;
        }
        // Generated context is the sole health header source. Provider config is deployment
        // input, not a private authority, so remove all health-prefixed values before install.
        for (const name of Object.keys(forwardHeaders)) {
          if (name.toLowerCase().startsWith("x-fleet-health-")) delete forwardHeaders[name];
        }
        if (healthAttempt) Object.assign(forwardHeaders, healthAttempt.headers);
        response = await fetchImpl(`${providerConfig.baseUrl.replace(/\/$/, "")}${api.path}`, {
          method: "POST",
          headers: forwardHeaders,
          body: outboundBody,
          signal: abort,
        });
        // Keep this attempt local to the loop body while every terminal branch reports it.
        response.healthAttempt = healthAttempt;
        response.healthAttestation = healthAttempt ? healthReporter.captureResponse(healthAttempt, response.headers) : null;
        if (healthAttempt) response.healthParser = createTerminalParser(healthAttempt.api);
      } catch (error) {
        clearTimeout(stallTimer);
        if (healthAttempt) {
          const parser = createTerminalParser(healthAttempt.api);
          await healthReporter.finish(healthAttempt, { responseHeaders: new Headers(), terminal: parser.finish({ status: 0, contentType: "", cancelled: clientAbort?.aborted, networkError: true }), finishedAt: now() }).catch(() => null);
        }
        // A timeout is OUR impatience or the client's abandonment, not proof
        // the provider is down -- reporting it as a failure quarantined a
        // healthy provider under burst (measured live). Release the lease,
        // exclude the lane for THIS request's retry, and move on; genuinely
        // broken providers still get indicted by real HTTP errors below.
        if (isAbort(error)) {
          await settle(leased, "/release");
          if (clientAbort?.aborted) { lastError = new Error("client disconnected"); break; }
        } else {
          await settle(leased, "/failure", { error: { message: String(error?.message ?? error) } });
        }
        noteAttempt(leased, thrownOutcome(error), thrownDetail(error));
        excludeLane(leased.providerID);
        rememberForwardError(error);
        continue;
      }
      // A proxy-authenticated scope refusal is distinct from any broker/control-plane 409.
      // Only this exact attested upstream fact may replace an external lease; the plugin retains
      // ownership of that original lease while the gateway settles the replacement it acquires.
      let scopeMismatch = false;
      if (response.status === 409 && response.healthAttestation) {
        scopeMismatch = response.healthAttestation[11] === "proxy-scope" && response.healthAttestation[12] === null;
      }
      if (scopeMismatch && !probeAssignment && (boundLease?.external || leased.expectedCredentialInstance !== null)) {
        const parser = response.healthParser ?? createTerminalParser(response.healthAttempt.api);
        await healthReporter.finish(response.healthAttempt, { responseHeaders: response.headers, terminal: parser.finish({ status: response.status, contentType: String(response.headers?.get?.("content-type") ?? "") }), finishedAt: now() }).catch(() => null);
        if (!boundLease?.external) await settle(leased, "/release");
        if (!excludedTargets.includes(leased.targetID)) excludedTargets.push(leased.targetID);
        boundLease = null;
        continue;
      }
      if (!response.ok) {
        // The body is already read whole; `text` is a 400-char slice of it for
        // the chat path (unchanged). `upstreamSignal` is a fixed gateway-owned
        // phrase lookup -- no upstream bytes relay. Skipped on the chat path:
        // its client-facing message is the raw text slice, so the signal
        // suffix would never land there, and the broker reads the signal out
        // of that text slice directly through the classifier's proximity
        // regex. Messages and Responses, by contrast, DROP the upstream body
        // and only name the status; the suffix is how the signal reaches the
        // broker there.
        const raw = await response.text().catch(() => "");
        if (response.healthAttempt) {
          const parser = createTerminalParser(response.healthAttempt.api);
          parser.push(raw);
          await healthReporter.finish(response.healthAttempt, { responseHeaders: response.headers, terminal: parser.finish({ status: response.status, contentType: String(response.headers?.get?.("content-type") ?? "") }), finishedAt: now() }).catch(() => null);
        }
        const text = raw.slice(0, 400);
        const usageLimit = upstreamUsageLimit(response.status, raw, response.headers, now());
        const signal = api === CHAT ? null : (upstreamSignal(raw) ?? (usageLimit ? "usage limit reached" : null));
        const suffix = signal ? `: ${signal}` : "";
        const safeMessage = api === MESSAGES
          ? `Anthropic upstream HTTP ${response.status}${suffix}`
          : api === RESPONSES
            ? `OpenAI Responses upstream HTTP ${response.status}${suffix}`
            : text || `upstream HTTP ${response.status}`;
        clearTimeout(stallTimer);
        await settle(leased, "/failure", {
          error: {
            statusCode: response.status,
            message: safeMessage,
            // The reset the provider reported, so the broker's quota circuit ends when the limit does.
            ...(usageLimit?.until ? { resetAt: new Date(usageLimit.until).toISOString() } : {}),
          },
        });
        const error = new Error(api === MESSAGES
          ? safeMessage
          : api === RESPONSES
            ? `upstream ${leased.providerID} HTTP ${response.status}${suffix}`
            : `upstream ${leased.providerID} HTTP ${response.status}: ${text.slice(0, 120)}`);
        if (usageLimit) error.usageLimit = { providerID: leased.providerID, ...usageLimit };
        noteAttempt(leased, usageLimit ? "usage_limit" : `http_${response.status}`, upstreamDetail(raw) || `HTTP ${response.status}`);
        rememberForwardError(error);
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
          // A buffered upstream reply: read whole under the buffered signal, THEN written as the
          // stream. Until it is whole `relayed` stays false, so everything below sorts it exactly
          // like a streamed attempt that failed with the wire clean.
          outcome = bufferingStream
            ? await relayBufferedReply({ response, sink, keepUsageFrames, api, observe: (chunk) => response.healthParser?.push(chunk) })
            : contentType.includes("application/json")
            ? (api === CHAT
              ? await relayBufferedAsStream({ response, sink, keepUsageFrames, observe: (chunk) => response.healthParser?.push(chunk) })
              : { relayed: false, usage: null, outputChars: 0, sawDone: false,
                error: new Error(`upstream ${leased.providerID} answered a streamed ${api.path} request with one JSON body`) })
            : await relayStream({ stream: response.body ?? [], sink, keepUsageFrames, touch: () => touch(idleMs), api,
              observe: (chunk) => response.healthParser?.push(chunk) });
        } finally {
          clearTimeout(stallTimer);
        }
        if (api === MESSAGES && outcome.relayed && !outcome.error && !outcome.sawDone) {
          outcome.error = new Error("Anthropic upstream stream ended before message_stop");
        }
        if (response.healthAttempt) {
          const parser = response.healthParser ?? createTerminalParser(response.healthAttempt.api);
          await healthReporter.finish(response.healthAttempt, { responseHeaders: response.headers, terminal: parser.finish({ status: response.status, contentType, cancelled: clientAbort?.aborted }), finishedAt: now() }).catch(() => null);
        }
        if (!outcome.relayed) {
          // Wire still clean. No usage is reported for a lane that produced no
          // frames -- same as the buffered path, which never accounts for an
          // attempt it threw away.
          const error = outcome.error ?? new Error(`upstream ${leased.providerID} produced an empty stream`);
          if (isAbort(error) || clientAbort?.aborted) {
            await settle(leased, "/release");
            if (clientAbort?.aborted) { lastError = new Error("client disconnected"); break; }
          } else {
            await settle(leased, "/failure", { error: { message: String(error?.message ?? error).slice(0, 400) } });
          }
          noteAttempt(leased, isAbort(error) ? thrownOutcome(error) : "stream_error", thrownDetail(error));
          excludeLane(leased.providerID);
          rememberForwardError(error);
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
            await settle(leased, "/release");
          } else {
            // ☆ The client gets a truncated answer AND an explanation it can
            // parse; the broker gets the failure, because circuits only open on
            // reports and a lane that dies at token 200 is exactly the lane the
            // next request must route around.
            const why = String(outcome.error?.message ?? outcome.error).slice(0, 200);
            if (api === RESPONSES) await sink.write(responsesErrorFrame(why));
            else if (api === MESSAGES) await sink.write(`event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "api_error", message: "gateway: Anthropic upstream stream failed" },
            })}\n\n`);
            else { await sink.write(errorFrame(why)); await sink.write(DONE_FRAME); }
            await settle(leased, "/failure", {
              error: { message: api === MESSAGES
                ? `Anthropic stream failed after ${outcome.outputChars} chars`
                : `stream failed after ${outcome.outputChars} chars: ${String(outcome.error?.message ?? outcome.error)}`.slice(0, 400) },
            });
          }
        } else {
          // ☆ A missing [DONE] does not indict -- it is a dialect gap, not a
          // fault -- but the client must never be left waiting for a terminator
          // that is not coming.
          if (api === CHAT && !outcome.sawDone) await sink.write(DONE_FRAME);
          await settle(leased, "/complete");
        }
        return { status: 200, streamed: true, providerID: leased.providerID, modelID: leased.modelID };
      }
      if (api === MESSAGES) {
        let rawBody;
        let payload;
        try {
          rawBody = await response.text();
          payload = JSON.parse(rawBody);
        } catch {
          if (response.healthAttempt) {
            const parser = response.healthParser ?? createTerminalParser(response.healthAttempt.api);
            await healthReporter.finish(response.healthAttempt, { responseHeaders: response.headers, terminal: parser.finish({ status: response.status, contentType: String(response.headers?.get?.("content-type") ?? ""), cancelled: clientAbort?.aborted }), finishedAt: now() }).catch(() => null);
          }
          await settle(leased, "/failure", { error: { message: "upstream returned 200 with an unparseable JSON body" } });
          noteAttempt(leased, "bad_json", "upstream returned 200 with an unparseable JSON body");
          rememberForwardError(new Error(`upstream ${leased.providerID} returned unparseable JSON`));
          excludeLane(leased.providerID);
          continue;
        }
        if (response.healthAttempt) {
          const parser = createTerminalParser(response.healthAttempt.api);
          parser.push(rawBody);
          await healthReporter.finish(response.healthAttempt, { responseHeaders: response.headers, terminal: parser.finish({ status: response.status, contentType: String(response.headers?.get?.("content-type") ?? "") }), finishedAt: now() }).catch(() => null);
        }
        if (payload?.usage) await reportUsage(leased, readMessagesUsage(payload.usage));
        await settle(leased, "/complete");
        return {
          status: response.status,
          rawBody,
          contentType: String(response.headers?.get?.("content-type") ?? "application/json"),
          providerID: leased.providerID,
          modelID: leased.modelID,
        };
      }
      // A 200 with an unparseable body IS a provider fault -- and an uncaught
      // throw here would escape completions() as an unhandledRejection.
      let payload;
      // The assembled body is read under the same signal as the buffered one (timeoutMs plus
      // the client's abort), so the deadline is unchanged; an abort mid-read closes the upstream
      // connection, which is the whole point. A lane that ignored `stream: true` and answered
      // with one JSON body falls through to the ordinary buffered read below.
      if (assembling && !String(response.headers?.get?.("content-type") ?? "").includes("application/json")) {
          const stream = response.healthParser ? {
            async *[Symbol.asyncIterator]() {
              for await (const chunk of response.body ?? []) {
                response.healthParser.push(chunk);
                yield chunk;
              }
            },
          } : (response.body ?? []);
          const outcome = api === RESPONSES
            ? await assembleResponse(stream)
            : await assembleChatCompletion(stream);
        if (outcome.error) {
          if (response.healthAttempt) {
            const parser = response.healthParser ?? createTerminalParser(response.healthAttempt.api);
            await healthReporter.finish(response.healthAttempt, { responseHeaders: response.headers, terminal: parser.finish({ status: response.status, contentType: String(response.headers?.get?.("content-type") ?? ""), cancelled: clientAbort?.aborted }), finishedAt: now() }).catch(() => null);
          }
          // Nothing has reached the client: same sorting as a streamed attempt that failed with
          // a clean wire -- our impatience or the client's releases, a broken stream indicts.
          const error = outcome.error;
          if (isAbort(error) || clientAbort?.aborted) {
            await settle(leased, "/release");
            if (clientAbort?.aborted) { lastError = new Error("client disconnected"); break; }
          } else {
            await settle(leased, "/failure", { error: { message: String(error?.message ?? error).slice(0, 400) } });
          }
          noteAttempt(leased, isAbort(error) ? thrownOutcome(error) : "stream_error", thrownDetail(error));
          excludeLane(leased.providerID);
          rememberForwardError(error);
          continue;
        }
        payload = outcome.payload;
        if (response.healthAttempt) {
          const parser = response.healthParser ?? createTerminalParser(response.healthAttempt.api);
          await healthReporter.finish(response.healthAttempt, { responseHeaders: response.headers, terminal: parser.finish({ status: response.status, contentType: String(response.headers?.get?.("content-type") ?? "") }), finishedAt: now() }).catch(() => null);
        }
      } else {
        let rawBody;
        try {
          if (response.healthAttempt) {
            rawBody = await response.text();
            payload = JSON.parse(rawBody);
          } else payload = await response.json();
        } catch {
          if (response.healthAttempt) {
            const parser = response.healthParser ?? createTerminalParser(response.healthAttempt.api);
            await healthReporter.finish(response.healthAttempt, { responseHeaders: response.headers, terminal: parser.finish({ status: response.status, contentType: String(response.headers?.get?.("content-type") ?? ""), cancelled: clientAbort?.aborted }), finishedAt: now() }).catch(() => null);
          }
          await settle(leased, "/failure", { error: { message: "upstream returned 200 with an unparseable JSON body" } });
          noteAttempt(leased, "bad_json", "upstream returned 200 with an unparseable JSON body");
          rememberForwardError(new Error(`upstream ${leased.providerID} returned unparseable JSON`));
          excludeLane(leased.providerID);
          continue;
        }
        if (response.healthAttempt) {
          const parser = response.healthParser ?? createTerminalParser(response.healthAttempt.api);
          if (typeof rawBody === "string") parser.push(rawBody);
          await healthReporter.finish(response.healthAttempt, { responseHeaders: response.headers, terminal: parser.finish({ status: response.status, contentType: String(response.headers?.get?.("content-type") ?? "") }), finishedAt: now() }).catch(() => null);
        }
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
      if (api === EMBEDDINGS) {
        const inputTokens = Number(payload?.usage?.prompt_tokens);
        await reportUsage(leased, Number.isFinite(inputTokens) && inputTokens > 0
          ? { input: inputTokens, output: 0 }
            : estimateEmbeddingUsage(requestBody?.input));
      } else if (payload?.usage) await reportUsage(leased, readUsage(payload.usage));
      await settle(leased, "/complete");
      return { status: 200, payload, providerID: leased.providerID, modelID: leased.modelID };
    }
    // ☠️ ABANDONING THE REQUEST MUST NOT STRAND THE LEASE. Every failure path
    // above already releases or indicts (the broker deletes the lease on both),
    // but a dropped /release under a broker hiccup would pin a capacity-1
    // target for the full 2h TTL -- the debris 0.2.3's startup sweep exists to
    // clear after a CRASH, which a live process must not be manufacturing.
    // Releasing an already-released session is a no-op delete.
    if (acquiredLease && lastLeased) await settle(lastLeased, "/release");
    // A usage limit LEADS the message: it is the one failure the user must act on (wait, or
    // switch), and the day it lifts is the answer they need. The gateway phrase stays in it,
    // because callers and the broker's classifier key on it to know no provider was at fault.
    // Still a 502, not a 429: a 429 tells clients to retry, and a weekly limit is days away.
    const boundUsage = boundLease?.external && lastError?.usageLimit?.providerID === boundLease.providerID
      ? lastError.usageLimit : null;
    const resetAt = Number(boundUsage?.until);
    const hasReset = Number.isFinite(resetAt) && resetAt > now() && resetAt <= 8.64e15;
    const providerID = typeof boundUsage?.providerID === "string" && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(boundUsage.providerID)
      ? boundUsage.providerID : null;
    const window = ["5-hour limit", "weekly limit", "weekly Opus limit", "weekly Sonnet limit"].includes(boundUsage?.limit)
      ? boundUsage.limit : null;
    // A verified session owns its lease and will report this failure to the broker. Its one
    // upstream attempt nevertheless needs a provider-attributable, quota-classified message:
    // the ordinary gateway summary is gateway-owned and noop, even when it summarizes attempts
    // the gateway already settled itself.
    const boundUsageMessage = providerID
      ? `upstream ${providerID} HTTP 429: usage limit reached${window || hasReset
        ? ` (${[window, hasReset ? `resets at ${new Date(resetAt).toISOString()}` : null].filter(Boolean).join("; ")})` : ""}`
      : null;
    const usageLead = boundUsageMessage ?? (lastError?.code === "usage-limit"
      ? String(lastError.message)
      : usageLimited.length ? `${usageLimitMessage(usageLimited, now())}.` : null);
    return {
      status: 502,
      payload: { error: { message: usageLead
        ? boundUsageMessage ?? `${usageLead} (gateway: no provider could serve the request)`
        : `gateway: no provider could serve the request: ${String(lastError?.message ?? lastError)}`, type: "upstream_error" } },
    };
  };

  const respondJson = (response, status, payload) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  // The caller's address as the socket sees it, with the IPv4-mapped IPv6 prefix stripped --
  // the same normalization the OpenAI path's `caller` uses.
  const callerAddress = (request) => String(request.socket?.remoteAddress ?? "").replace(/^::ffff:/, "") || null;

  // Authorization is BOTH halves: the right token AND the right source address. The token
  // alone is a bearer credential bind-mounted into a container running third-party code;
  // pinning the address means a leaked copy is not usable from anywhere else on the LAN.
  // ☆ An absent token is a closed surface, never an open one: a gateway deployed before its
  // drop file exists must refuse every caller.
  const tenantPresented = (request) => Boolean(tenantToken)
    && sameSecret(request.headers.authorization ?? "", `Bearer ${tenantToken}`);
  // ☆ Said ONCE, here at construction, never per request: a `tenants` block with no token is a
  // deploy that half-happened -- the drop file was never written, or the service restarted
  // before it was -- and its only other symptom is every render 401ing with nothing in this
  // log, because the address log below runs AFTER the token check and so never sees these.
  // Per-request would let an unauthenticated prober fill the log. The ordinary deployment
  // (no tenants block, no token) stays silent.
  const configuredTenants = Object.keys(config.tenants ?? {});
  if (configuredTenants.length && !tenantToken) {
    console.error(`opencode-broker-gateway: tenants [${configuredTenants.join(", ")}] are configured but no tenant token is loaded: every tenant request is 401 until the drop file exists and the gateway restarts`);
  }

  const tenantFromAllowedAddress = (request, tenant) => {
    const address = callerAddress(request);
    if (tenant.allowFrom.includes(address)) return true;
    // ☆ The observed address is logged because it is the one thing a deployment cannot know in
    // advance: which source address a container's traffic arrives from depends on its network
    // mode, and a wrong `allowFrom` otherwise presents as every render silently 401ing with no
    // way to find the right value. A correct token from an unexpected address is exactly the
    // case worth naming. The token itself is never logged.
    console.error(`opencode-broker-gateway: tenant request from ${address} is not in allowFrom [${tenant.allowFrom.join(", ")}]`);
    return false;
  };

  const handle = async (request, response, trace) => {
    const url = (request.url ?? "/").split("?")[0];
    // ── tenant control ─────────────────────────────────────────────────────────────────────
    // ☠️ DISPATCHED BEFORE THE GATEWAY-KEY GATE, AND BEFORE EVERY ROUTE. A sibling surface
    // that happens to share this process: it deliberately does NOT inherit the gateway key,
    // the OpenAI request path, the model router or holdOpenMs. The only things it shares are
    // that the broker already spawns model-swap and already runs on the host holding its
    // state. Placing it first is what guarantees a tenant URL can never fall through into the
    // model router, and what keeps the container's credential narrow.
    const tenantMatch = TENANT_ROUTE.exec(url);
    if (tenantMatch) {
      const [, id, action] = tenantMatch;
      // ☆ Order matters: the TOKEN is checked before the id is resolved, so an
      // unauthenticated prober cannot enumerate which tenants this gateway serves by telling
      // a 404 from a 401. Only a caller that already holds the token learns that much.
      if (!tenantPresented(request)) return respondJson(response, 401, { error: "unauthorized" });
      const tenant = config.tenants?.[id] ?? null;
      if (!tenant) return respondJson(response, 404, { error: "unknown tenant" });
      if (!tenantFromAllowedAddress(request, tenant)) return respondJson(response, 401, { error: "unauthorized" });
      if (request.method === "GET" && !action) {
        return respondJson(response, 200, { held: reservationHeld(reservationsPath, id) });
      }
      const swapArgs = request.method === "POST" && action === "acquire"
        // --no-start: the tenant's lifecycle is managed outside this tool (ComfyUI runs
        // permanently under `restart: unless-stopped`), so reserve must take the room and
        // evict without trying to start anything.
        ? ["reserve", id, "--no-start", "--wait-active", TENANT_WAIT_ACTIVE_SECONDS]
        // --no-stop: give the room back, leave the app up.
        : request.method === "POST" && action === "release" ? ["release", id, "--no-stop"]
        : null;
      if (!swapArgs) return respondJson(response, 405, { error: "method not allowed" });
      const [command, ...fixedArgs] = tenant.command;
      const result = await runModelSwap(command, [...fixedArgs, ...swapArgs]);
      // ☠️ `model-swap` EXITS 0 ON A REFUSAL BY DESIGN -- a correct policy decline must not
      // toast the HUD -- so the exit code is not the postcondition. Read the reservation back
      // and report what is ACTUALLY held; the caller decides what to do about it.
      const held = reservationHeld(reservationsPath, id);
      // ☆ The two actions want OPPOSITE readings, so `held` alone is never the verdict:
      // acquire worked when the reservation APPEARED, release worked when it is GONE. Comparing
      // against the action's intent is what keeps a clean release out of the log and a stuck
      // one in it.
      const wantedHeld = action === "acquire";
      if (result?.code !== 0 || held !== wantedHeld) {
        console.error(`opencode-broker-gateway: tenant ${id} ${action}: exit ${result?.code}, held=${held} (wanted ${wantedHeld}): ${result?.output ?? ""}`.trim());
      }
      return respondJson(response, 200, { held });
    }
    const authHeader = request.headers.authorization ?? "";
    const apiKeyHeader = request.headers["x-api-key"] ?? "";
    const gatewayAuthorized = Boolean(gatewayKey)
      && (sameSecret(authHeader, `Bearer ${gatewayKey}`) || sameSecret(apiKeyHeader, gatewayKey));
    if (!gatewayAuthorized) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "missing or invalid gateway key" } }));
      return;
    }
    const rawProbeNonce = request.headers["x-opencode-probe-nonce"];
    const rawProbeSession = request.headers["x-opencode-probe-session"];
    const probeNonce = Array.isArray(rawProbeNonce) ? rawProbeNonce[0] : rawProbeNonce;
    const probeSessionID = Array.isArray(rawProbeSession) ? rawProbeSession[0] : rawProbeSession;
    const hasProbeMarker = probeNonce !== undefined || probeSessionID !== undefined;
    if (hasProbeMarker) {
      if (!loopbackAddress(request.socket?.remoteAddress)) {
        return respondJson(response, 403, { error: { message: "probe requests require loopback" } });
      }
      if (typeof probeNonce !== "string" || !/^pbn_[A-Za-z0-9_-]{43}$/.test(probeNonce)
        || typeof probeSessionID !== "string" || !/^gw-probe-[A-Za-z0-9_-]{43}$/.test(probeSessionID)) {
        return respondJson(response, 400, { error: { message: "probe session and nonce are required" } });
      }
    }
    if (request.method === "GET" && url === "/v1/models") {
      // ☆ An interactive client builds its model picker from here, so this list
      // is the gateway's answer to "what may I ask for". The routed id comes
      // first -- it means "let the broker pick", and is what a consumer that
      // does not care which model answers should send -- and every mapped name
      // joins it, because a name the gateway will honour is exactly a name a
      // human may select.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: advertisedModelIDs(config).map((id) => ({ id, object: "model", owned_by: "opencode-broker" })),
      }));
      return;
    }
    const api = url === "/v1/chat/completions" ? CHAT
      : url === "/v1/responses" ? RESPONSES
      : url === "/v1/messages" ? MESSAGES
        : url === "/v1/embeddings" ? EMBEDDINGS
          : null;
    if (request.method !== "POST" || !api) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "only POST /v1/chat/completions, POST /v1/responses, POST /v1/messages, POST /v1/embeddings and GET /v1/models" } }));
      return;
    }
    // ☆ From here on the request is an authorized model request, and only those are logged:
    // a 401 to an unauthenticated prober must not be a way to fill the journal.
    trace.route = url;
    const declaredBytes = Number(request.headers["content-length"]);
    if (api === EMBEDDINGS && Number.isFinite(declaredBytes) && declaredBytes > MAX_EMBEDDINGS_BODY_BYTES) {
      return respondJson(response, 413, { error: { message: "gateway: embeddings request body exceeds 1048576 bytes", type: "invalid_request_error" } });
    }
    let body = "";
    let bodyBytes = 0;
    for await (const chunk of request) {
      bodyBytes += Buffer.byteLength(chunk);
      if (api === EMBEDDINGS && bodyBytes > MAX_EMBEDDINGS_BODY_BYTES) {
        request.pause();
        return respondJson(response, 413, { error: { message: "gateway: embeddings request body exceeds 1048576 bytes", type: "invalid_request_error" } });
      }
      body += chunk;
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
      return;
    }
    const requestedModel = String(parsed?.model ?? "");
    trace.label = requestedModel.slice(0, 100);
    trace.streaming = parsed?.stream === true;
    {
      const route = modelRoute(config, requestedModel);
      trace.profile = route?.profile ?? config.profile ?? null;
      trace.tier = route?.tier ?? config.tier ?? null;
    }
    if (api === EMBEDDINGS) {
      if (!modelRoute(config, requestedModel)) {
        return respondJson(response, 400, { error: { message: "gateway: embeddings require a mapped model", type: "invalid_request_error", param: "model" } });
      }
      if (!validEmbeddingInput(parsed?.input)) {
        return respondJson(response, 400, { error: { message: "gateway: embeddings input must be a string, string array, or token array", type: "invalid_request_error", param: "input" } });
      }
      if (parsed.stream === true) {
        return respondJson(response, 400, { error: { message: "gateway: embeddings do not support stream: true", type: "invalid_request_error", param: "stream" } });
      }
      if (embeddingInputItems(parsed.input).length > MAX_EMBEDDING_BATCH_ITEMS) {
        return respondJson(response, 400, { error: { message: "gateway: embeddings input has more than 2048 items", type: "invalid_request_error", param: "input" } });
      }
    }
    // ☠️ NOT FOR A SESSION-BOUND REQUEST. OpenCode sends its leased model's real id
    // (`claude-opus-5-5`), never a gateway label, and /lease/verify below admits exactly that id
    // and nothing else -- a tighter gate than this list. Applying the list to it refused every
    // OpenCode cloud turn the moment strict mode went on (2026-10-12, "Bad Request").
    const sessionBound = request.headers["x-opencode-session-id"] !== undefined && !hasProbeMarker;
    const advertisedModels = advertisedModelIDs(config);
    if (config.strictModelNames && sessionBound
      && request.headers["x-opencode-lease-id"] === undefined
      && !advertisedModels.includes(requestedModel)) {
      const rawSessionID = request.headers["x-opencode-session-id"];
      const sessionID = Array.isArray(rawSessionID) ? rawSessionID[0] : rawSessionID;
      if (sessionBoundWithoutLeaseLogged.size < MAX_SESSION_BOUND_WITHOUT_LEASE_LOGS
        && !sessionBoundWithoutLeaseLogged.has(sessionID)) {
        sessionBoundWithoutLeaseLogged.add(sessionID);
        logLine(JSON.stringify({
          source: "opencode-broker-gateway",
          ts: new Date(Date.now()).toISOString(),
          event: "session_bound_without_lease",
          model: requestedModel,
          sessionID,
        }));
      }
    }
    if (config.strictModelNames && !sessionBound && !advertisedModels.includes(requestedModel)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: `unknown model "${requestedModel}"; use "auto" or a model listed by GET /v1/models`,
          type: "invalid_request_error",
          param: "model",
          code: "unknown_model",
        },
      }));
      return;
    }
    const rawProbePurpose = request.headers["x-opencode-probe-purpose"];
    const probePurpose = Array.isArray(rawProbePurpose) ? rawProbePurpose[0] : rawProbePurpose;
    let probeAssignment = null;
    let boundLease = null;
    if (hasProbeMarker) {
      let consumed;
      try {
        consumed = await brokerRequest("/probe/consume", {
          sessionID: probeSessionID,
          probeNonce,
          ...(probePurpose === "outage-health" ? { purpose: "outage-health" } : {}),
        });
      } catch {
        return respondJson(response, 403, { error: { message: "probe assignment rejected" } });
      }
      if (consumed?.sessionID !== probeSessionID
        || typeof consumed?.preferredModel?.providerID !== "string"
        || typeof consumed?.preferredModel?.modelID !== "string") {
        return respondJson(response, 403, { error: { message: "probe assignment binding mismatch" } });
      }
      const consumedOutageAssignment = consumed.purpose === "outage-health";
      const releaseConsumedProbe = async () => {
        try {
          await brokerRequest("/probe/release", {
            sessionID: probeSessionID,
            probeNonce,
            ...(consumedOutageAssignment ? { leaseID: consumed.leaseID, purpose: "outage-health" } : {}),
          });
        } catch { /* probe expiry is the broker-side backstop */ }
      };
      // A caller's header asks the service for an isolated assignment; it cannot turn a
      // consumed generic staged probe into one after the fact.
      if (probePurpose === "outage-health" && !consumedOutageAssignment) {
        await releaseConsumedProbe();
        return respondJson(response, 403, { error: { message: "outage probe assignment purpose mismatch" } });
      }
      probeAssignment = {
        sessionID: probeSessionID,
        probeNonce,
        preferredModel: {
          providerID: consumed.preferredModel.providerID,
          modelID: consumed.preferredModel.modelID,
        },
        purpose: consumedOutageAssignment ? "outage-health" : null,
      };
      if (probeAssignment.purpose === "outage-health") {
        if (typeof consumed.leaseID !== "string" || typeof consumed.expectedCredentialInstance !== "string"
          || typeof consumed.modelID !== "string" || typeof consumed.wireModelID !== "string"
          || typeof consumed.targetID !== "string" || typeof consumed.preferredModel?.providerID !== "string"
          || typeof consumed.expectedScopePolicy !== "object" || consumed.expectedScopePolicy === null
          || !config.providers[consumed.preferredModel.providerID]) {
          await releaseConsumedProbe();
          return respondJson(response, 403, { error: { message: "outage probe assignment binding mismatch" } });
        }
        const requiredApi = api === MESSAGES ? "messages" : api === RESPONSES ? "responses" : null;
        const scope = consumed.expectedScopePolicy;
        if (requiredApi === null || scope.providerID !== consumed.preferredModel.providerID
          || scope.transport !== requiredApi || scope.probe?.api !== requiredApi) {
          await releaseConsumedProbe();
          return respondJson(response, 403, { error: { message: "outage probe assignment API scope mismatch" } });
        }
        probeAssignment = {
          ...probeAssignment,
          leaseID: consumed.leaseID,
          outageAssignment: true,
        };
        boundLease = {
          sessionID: probeSessionID,
          leaseID: consumed.leaseID,
          providerID: consumed.preferredModel.providerID,
          modelID: consumed.modelID,
          wireModelID: consumed.wireModelID,
          targetID: consumed.targetID,
          expectedCredentialInstance: consumed.expectedCredentialInstance,
          expectedScopePolicy: consumed.expectedScopePolicy,
          external: true,
          outageAssignment: true,
        };
      }
    }
    // ☠️ AN OPENCODE SESSION HAS ALREADY BEEN ROUTED. Its router plugin leased a target in
    // chat.message and sent that exact model here, so leasing again from this gateway's default
    // tier would discard the choice (and, with the worker lanes fenced, refuse a Claude turn the
    // session's own lease could serve). A request carrying the session id is forwarded on the
    // session's live lease instead -- but only from loopback, only when the broker confirms the
    // lease is held, and only for the model that lease names, so the header cannot be used to
    // reach a model the broker did not grant. "The model that lease names" is the exact id, or
    // its base when the lease is on a synthesized speed alias: OpenCode leases
    // `claude-opus-5-5-fast` but puts `claude-opus-5-5` on the wire, and only the base id exists
    // upstream (2026-10-01: every -fast build lease was refused 409). leaseCoversWireModel() holds
    // the exact rule. The forward therefore sends the client's own id (wireModelID), while
    // modelID stays the lease's id so the lease identity is never rewritten.
    const rawBoundSession = request.headers["x-opencode-session-id"];
    const boundSessionID = Array.isArray(rawBoundSession) ? rawBoundSession[0] : rawBoundSession;
    if (boundSessionID !== undefined && !hasProbeMarker) {
      if (!loopbackAddress(request.socket?.remoteAddress)) {
        return respondJson(response, 403, { error: { message: "session-bound requests require loopback" } });
      }
      const rawBoundLease = request.headers["x-opencode-lease-id"];
      const boundLeaseID = Array.isArray(rawBoundLease) ? rawBoundLease[0] : rawBoundLease;
      let held = null;
      try {
        held = await brokerRequest("/lease/verify", {
          sessionID: boundSessionID,
          ...(typeof boundLeaseID === "string" && boundLeaseID ? { leaseID: boundLeaseID } : {}),
        });
      } catch { held = null; }
      const model = held?.target?.model;
      if (!held?.held || typeof model?.providerID !== "string" ||
        !leaseCoversWireModel(model.id, requestedModel) || !config.providers[model.providerID]) {
        // The plugin classifies this wording as its own route error (noop), so a stale binding
        // never indicts the provider; the session re-leases on the next prompt.
        return respondJson(response, 409, {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `[opencode-broker] route unavailable; resend the prompt (gateway: session holds no live lease for "${requestedModel}")`,
          },
        });
      }
      boundLease = {
        sessionID: boundSessionID,
        leaseID: held.leaseID,
        providerID: model.providerID,
        modelID: model.id,
        targetID: typeof held?.target?.id === "string" ? held.target.id : model.id,
        wireModelID: requestedModel,
        expectedCredentialInstance: typeof held.expectedCredentialInstance === "string" ? held.expectedCredentialInstance : null,
        external: true,
      };
      // Rides the session's own lease, so no gateway profile or tier was consulted.
      trace.profile = null;
      trace.tier = null;
    }
    const streaming = parsed.stream === true;
    // Anything that is not an explicit `stream: true` keeps the buffered
    // shape byte for byte, and the key never reaches the upstream -- a lane
    // that would happily have streamed must not, or the buffered reader below
    // gets SSE text where it expects a JSON object.
    if (!streaming && api !== MESSAGES) delete parsed.stream;
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
      async write(text) {
        if (!this.started) {
          this.started = true;
          // Nagle would hold a 40-byte delta back waiting for company; on this
          // path the whole product is the promptness.
          response.socket?.setNoDelay?.(true);
          response.writeHead(200, SSE_HEADERS);
        }
        if (response.write(text)) return;
        await new Promise((resolve) => {
          const done = () => {
            response.removeListener("drain", done);
            response.removeListener("close", done);
            resolve();
          };
          response.once("drain", done);
          response.once("close", done);
        });
      },
    } : null;
    const address = String(request.socket?.remoteAddress ?? "").replace(/^::ffff:/, "") || null;
    const caller = {
      address,
      model: typeof parsed?.model === "string" ? parsed.model.slice(0, 100) : null,
    };
    // A buffered Chat/Responses request on a name with holdOpenMs: after that long without an
    // answer, commit the 200 and send a space every holdOpenMs so the client's idle timeout never
    // fires (see modelRoute). Streaming has frames of its own; native Messages must preserve the
    // upstream status and content type, so neither protocol takes this path.
    const holdOpenMs = streaming || api === MESSAGES
      ? null
      : modelRoute(config, parsed?.model)?.holdOpenMs ?? null;
    let held = false;
    const holdTimer = holdOpenMs ? setInterval(() => {
      if (response.writableEnded || response.destroyed) return;
      if (!held) {
        held = true;
        response.writeHead(200, { "Content-Type": "application/json" });
      }
      response.write(" ");
    }, holdOpenMs) : null;
    let result;
    try {
      result = await completions(parsed, clientAbortController.signal, sink, api, caller, {
        contentType: Array.isArray(request.headers["content-type"])
          ? request.headers["content-type"][0] : request.headers["content-type"],
        anthropicVersion: Array.isArray(request.headers["anthropic-version"])
          ? request.headers["anthropic-version"][0] : request.headers["anthropic-version"],
        anthropicBeta: Array.isArray(request.headers["anthropic-beta"])
          ? request.headers["anthropic-beta"][0] : request.headers["anthropic-beta"],
        sessionID: Array.isArray(request.headers["x-opencode-session-id"])
          ? request.headers["x-opencode-session-id"][0] : request.headers["x-opencode-session-id"],
        sessionKind: Array.isArray(request.headers["x-opencode-session-kind"])
          ? request.headers["x-opencode-session-kind"][0] : request.headers["x-opencode-session-kind"],
        rigSession: Array.isArray(request.headers["x-rig-session"])
          ? request.headers["x-rig-session"][0] : request.headers["x-rig-session"],
        rigTier: Array.isArray(request.headers["x-rig-tier"])
          ? request.headers["x-rig-tier"][0] : request.headers["x-rig-tier"],
      }, probeAssignment, boundLease, trace);
    } finally {
      if (holdTimer) clearInterval(holdTimer);
    }
    // The status the gateway DECIDED, which is not always the one on the wire: a held-open
    // request has already committed a 200 head before its 502 body.
    trace.status = result.status;
    if (result.status < 200 || result.status >= 300) trace.error = result.payload?.error?.message ?? null;
    // A streaming request that never got a frame out still owes the client an
    // ordinary JSON error, which is exactly what an OpenAI client expects when
    // a stream fails to start.
    if (sink?.started) { response.end(); return; }
    if (held) { response.end(result.rawBody ?? JSON.stringify(result.payload)); return; }
    if (Object.hasOwn(result, "rawBody")) {
      response.writeHead(result.status, { "Content-Type": result.contentType });
      response.end(result.rawBody);
      return;
    }
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.payload));
  };

  // The bin fires this handler with `void` -- any rejection out of it is an
  // unhandledRejection, which is fatal in this node. A torn body read (client
  // gone mid-upload) or any future slip must end as a response, not a crash.
  //
  // The failure log is written here, after handle() has fully returned, so a record always carries
  // every attempt the request made -- including one whose client walked away mid-way.
  // ☆ Date.now(), not the injected `now`: tests drive that clock to steer waits, and the log must
  // not add reads to it.
  const writeFailureLog = (trace, response) => {
    if (!trace.route) return; // never got past the key gate and route check
    const status = trace.status ?? (response.headersSent ? response.statusCode : null);
    const failed = status === null || status < 200 || status >= 300;
    if (!trace.aborted && !failed && !trace.attempts.length) return; // a clean success: not logged
    const record = (event, attempts) => JSON.stringify({
      source: "opencode-broker-gateway",
      ts: new Date().toISOString(),
      event,
      route: trace.route,
      label: trace.label,
      profile: trace.profile,
      tier: trace.tier,
      caller: trace.caller,
      status,
      attempts,
      duration_ms: Date.now() - trace.started,
      streaming: trace.streaming,
      ...(trace.error ? { error: logDetail(trace.error) } : {}),
    });
    if (trace.aborted) logLine(record("client_aborted", trace.attempts));
    else if (failed) logLine(record("request_failed", trace.attempts));
    // Recovered: one line per lane that failed first, so a flapping lane is visible even though
    // every caller got its answer.
    else for (const attempt of trace.attempts) logLine(record("attempt_failed", [attempt]));
  };

  return async (request, response) => {
    const trace = {
      started: Date.now(),
      route: null,
      label: null,
      profile: null,
      tier: null,
      caller: callerAddress(request),
      streaming: false,
      status: null,
      error: null,
      attempts: [],
      aborted: false,
    };
    // Same test as the abort wiring in handle(): 'close' before our own end() is a hang-up.
    response.on("close", () => { if (!response.writableEnded) trace.aborted = true; });
    try { await handle(request, response, trace); } catch (error) {
      trace.error = String(error?.message ?? error);
      try {
        if (response.headersSent) { response.end(); return; }
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "gateway internal error" } }));
      } catch { /* socket already gone */ }
    } finally {
      writeFailureLog(trace, response);
    }
  };
};
