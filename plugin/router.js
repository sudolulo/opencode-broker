// Assign models while OpenCode is constructing the user message. OpenCode resolves
// and persists the provider model before chat.params, so chat.message is the latest
// supported hook that can still change the model used for the actual provider call.
// Only the plugin factory may be exported from this file: OpenCode invokes every
// export of a plugin module as a factory, so helpers live in lib/router-core.js.
import {
  CONFIG,
  brokerRequest as defaultBrokerRequest,
  consumePendingProfile,
  isClassifierAgent,
  modelIsLocalTarget,
  isOfflineProfile,
  listPendingForgetRecords,
  profileConfinesToLan,
  profileReachesCloud,
  publishCachedSubscriptionInventory,
  readFallbackMarker,
  removeFallbackMarker,
  writeFallbackMarker,
  readSessionContextEstimate,
  removeSessionProfile,
  removeSessionContextEstimate,
  removePendingForgetRecord,
  resolveProfile,
  toolAllowedForProfile,
  wrapOfflineCommand,
  writePendingForgetRecord,
  writeSessionProfile,
  writeSessionContextEstimate,
  highRiskTier,
  raiseTier,
  classifyRoutingFailure,
} from "../lib/routing.js";
import {
  applyMessageModel,
  applyOutputModel,
  cleanupDeletedSession,
  createResolverProcessBrokerRequest,
  extractSessionID,
  routeTierForSession,
} from "../lib/router-core.js";
import { isAbortError, normalizeProviderError } from "../lib/provider-health.js";
import { describeProviderLimit, wrapUpMessage } from "../lib/usage-limit.js";
import { classifyTurn, nextPrevious } from "../lib/turn-effort.js";
import { randomUUID } from "node:crypto";

const HEARTBEAT_MS = 5 * 60 * 1000;
const LOCAL_CHILD_INACTIVITY_WATCHDOG_MS = 10 * 60 * 1000;
const LOCAL_CHILD_INACTIVITY_TIMEOUT = "LOCAL_INACTIVITY_TIMEOUT";
// isClassifierAgent lives in lib/routing.js now: profile RESOLUTION has to know the same
// lane this file does, and a privacy boundary with two definitions is one definition that
// gets updated and one that quietly does not.
const sessionLifecycleTypes = new Set(["session.created", "session.deleted", "session.updated", "session.status", "session.error", "session.idle"]);
const localChildProgressEventTypes = new Set(["session.status", "message.updated", "message.part.updated", "message.part.delta"]);
const classifierTierReachesCloud = () => [
  ...(CONFIG.tiers.classifier ?? []),
  ...(CONFIG.fallbacks.classifier ?? []).flat(),
].some((targetID) => CONFIG.targets[targetID]?.kind === "cloud");

const providerErrorFrom = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") return normalizeProviderError(value);
    if (typeof value === "object") {
      const direct = Object.prototype.hasOwnProperty.call(value, "message") ||
        Object.prototype.hasOwnProperty.call(value, "name") ||
        Object.prototype.hasOwnProperty.call(value, "code") ||
        Object.prototype.hasOwnProperty.call(value, "statusCode") ||
        Object.prototype.hasOwnProperty.call(value, "status");
      if (direct) {
        const safe = normalizeProviderError(value);
        if (safe.message || safe.name) return safe;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(value, "data") || Object.prototype.hasOwnProperty.call(value, "error") || Object.prototype.hasOwnProperty.call(value, "cause")) {
        const nested = providerErrorFrom(value.data, value.error, value.cause);
        if (nested) return nested;
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(value, "message") &&
        !Object.prototype.hasOwnProperty.call(value, "name") &&
        !Object.prototype.hasOwnProperty.call(value, "code") &&
        !Object.prototype.hasOwnProperty.call(value, "statusCode") &&
        !Object.prototype.hasOwnProperty.call(value, "status")) {
        continue;
      }
    }
  }
  return null;
};

const providerErrorText = (value) => {
  const safe = providerErrorFrom(value);
  return safe ? [safe.name, safe.statusCode ?? "", safe.message].filter(Boolean).join(" ") : "";
};

const messageRecordFrom = (properties) => properties?.message ?? properties?.part ?? properties?.info ?? properties?.data ?? properties;
const isCompletedAssistantMessage = (properties) => {
  const message = messageRecordFrom(properties);
  return message?.role === "assistant" && Boolean(message?.time?.completed);
};

const authRevisionRacePattern = /auth revision changed during cached inventory refresh|auth revision changed during inventory refresh|auth revision changed before inventory publication/;
const isAuthRevisionRaceError = (error) => authRevisionRacePattern.test(String(error?.message ?? error));

const contextTokensOf = (message) => {
  const tokens = message?.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const output = Number(tokens.output) || 0;
  // A compaction summary message replaces the conversation: its own input was the old
  // context, and the session continues from roughly the summary it wrote.
  const total = message.summary === true
    ? output
    : (Number(tokens.input) || 0) + output + (Number(tokens.cache?.read) || 0) + (Number(tokens.cache?.write) || 0);
  return Number.isFinite(total) && total > 0 ? Math.floor(total) : null;
};

// opencode's internal agents that run on `small_model` rather than the session's model.
const SMALL_MODEL_AGENTS = new Set(["title"]);
// Subscription providers opencode reaches through the fleet gateway (see chat.headers).
const GATEWAY_BOUND_PROVIDERS = new Set(["anthropic", "openai"]);

export const ModelRouter = async ({ client, directory } = {}, options = {}) => {
  const brokerRequest = await createResolverProcessBrokerRequest({
    apply: options.apply ?? CONFIG.reconcile.apply,
    brokerRequest: options.brokerRequest ?? defaultBrokerRequest,
    realpath: options.realpath,
    readFile: options.readFile,
  });
  const routes = new Map();
  // ☠️ ONE LEASE IN FLIGHT PER SESSION. The broker keeps the lease whose /lease ARRIVED last;
  // the route keeps the reply that RETURNED last. Two prompts landing together (2026-10-20,
  // rig: two child-permission notices 100 ms apart) leased concurrently, the replies crossed,
  // and the turn sent a lease id the broker had already replaced: refused 409 until the user
  // typed "go". Chaining keeps arrival and return in the same order.
  // A recovery continuation is the exception: an ordinary prompt has already fenced it
  // (cancelRecovery, checkContinuation), so it never writes the route and must not hold the
  // prompt that superseded it behind a lease wait that may last minutes.
  const routeQueues = new Map(); // sessionID -> { next, prior, continuation }
  const serialRoute = (sessionID, fn, { continuation = false } = {}) => {
    const tail = routeQueues.get(sessionID);
    const prior = (tail && tail.continuation && !continuation ? tail.prior : tail?.next) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    const entry = { next, prior, continuation };
    routeQueues.set(sessionID, entry);
    const settle = () => { if (routeQueues.get(sessionID) === entry) routeQueues.delete(sessionID); };
    next.then(settle, settle);
    return next;
  };
  const riskFloors = new Map(); // sessionID -> minimum tier for high-risk content
  const previousTurnClasses = new Map(); // sessionID -> last substantive normal or hard class
  const lastTurnEffort = new Map(); // sessionID -> last applied turnEffort, carried onto a cascade re-prompt
  const engineEffortUpdates = new Map(); // sessionID -> whether this session's engine supports safe effort updates
  const sessions = new Map();
  const successCandidates = new Map();
  // The model that failed before the engine's own compaction can consume the failure.
  // This is distinct from markDisplaced's provider-quota restoration marker.
  const displacedModels = new Map(); // sessionID -> { providerID, modelID, variant? }
  const heartbeats = new Map();
  const localChildInactivityWatchdogs = new Map();
  const localChildInactivityCleanups = new Map();
  const localChildInFlightTools = new Map();
  const contextSizes = new Map();
  const messageModels = new Map();
  const reportedSteps = new Set();
  // sessionID -> root sessionID (its own id when it has no parent, or lookup failed).
  // A session's root never changes, so one memoized walk per id is enough; the bounded
  // trimTracker pattern below applies here too.
  const sessionRoots = new Map();
  const localChildInactivityWatchdogMs = Number.isFinite(options.localChildInactivityWatchdogMs) && options.localChildInactivityWatchdogMs >= 0
    ? options.localChildInactivityWatchdogMs
    : LOCAL_CHILD_INACTIVITY_WATCHDOG_MS;
  const scheduleTimeout = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  // Max time the root walk may spend before the /usage reporter gives up and sends the
  // report WITHOUT rootSessionID: the broker counts the session as its own root (safe
  // fallback -- see lib/burn-watch.js) and the burn-stop reply can still come back.
  // ☠️ Not optional. On 2026-10 reviewers found that a hung session.get held the whole
  // /usage chain hostage, which also held the burn.stop reply hostage, which meant a
  // runaway could not be aborted at all. 1500 ms is well above a healthy session read
  // (~5 ms on the local SDK) and well under any human-perceptible abort delay.
  const rootResolveTimeoutMs = Number.isFinite(options.rootResolveTimeoutMs) && options.rootResolveTimeoutMs >= 0
    ? options.rootResolveTimeoutMs
    : 1500;
  // Negative memo for a FAILED root walk: a cycle, an 8-hop exhaustion, or a session.get
  // error. Without it the next step of a looping subagent calls session.get again, and
  // again, and again -- measured 2026-10: a subagent that could not resolve its root
  // issued one SDK call per step-finish. 60 s is long enough to collapse a burst and
  // short enough that a transient error does not stick when the lookup starts working.
  const ROOT_FAILURE_TTL_MS = 60_000;
  const sessionRootFailures = new Map(); // sessionID -> at
  // Dedupe concurrent FIRST lookups for the same session: a burst of step-finish parts
  // on a fresh session triggers one resolveRootSessionID per part, each walking back
  // through session.get. Fold them onto one in-flight promise so the SDK is called once.
  const sessionRootInflight = new Map(); // sessionID -> promise
  // How long a prompt waits for a busy or loading local model before failing, and the retry step.
  const leaseWaitMaxMs = Number.isFinite(options.leaseWaitMaxMs) && options.leaseWaitMaxMs >= 0 ? options.leaseWaitMaxMs : 10 * 60 * 1000;
  const leaseWaitStepMs = Number.isFinite(options.leaseWaitStepMs) && options.leaseWaitStepMs >= 0 ? options.leaseWaitStepMs : 3000;
  const leaseSleep = typeof options.sleep === "function" ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cancelTimeout = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  // ☠️ console.error from a plugin reaches the TUI/stderr ONLY -- it never enters
  // ~/.local/share/opencode/log/opencode.log. Every routing message printed that way
  // was unfindable afterwards AND looked like an unexplained error on screen, which is
  // how a once-per-classifier-turn info line got reported as a recurring bug. The
  // platform already has a log endpoint; this uses it.
  // Errors ALSO go to stderr: a failed abort/release is worth interrupting for, routine
  // telemetry is not. That is the whole reason for the level split.
  // Fire-and-forget by design: this runs inside hooks, so it must never throw and must
  // never be awaited. Ceiling: log ordering is not guaranteed against stderr.
  const report = (level, message, extra) => {
    const detail = extra instanceof Error ? { error: String(extra.message ?? extra) } : extra;
    const mirror = () => console.error(`[opencode-broker] ${message}`, ...(extra === undefined ? [] : [extra]));
    if (level === "error") mirror();
    const log = client?.app?.log;
    // No platform log (a bare client in a test) must not lose the message.
    if (typeof log !== "function") {
      if (level !== "error") mirror();
      return;
    }
    try {
      const sent = log.call(client.app, {
        body: { service: "opencode-broker", level, message, ...(detail === undefined ? {} : { extra: detail }) },
        query: { directory },
      });
      sent?.catch?.(() => { if (level !== "error") mirror(); });
    } catch {
      if (level !== "error") mirror();
    }
  };
  const RESOLVABLE_MODELS_CACHE_MS = 5 * 60 * 1000;
  const RESOLVABLE_MODELS_FAILURE_CACHE_MS = 60 * 1000;
  const resolvableModelsTimeoutMs = Number.isFinite(options.resolvableModelsTimeoutMs) && options.resolvableModelsTimeoutMs >= 0
    ? options.resolvableModelsTimeoutMs
    : 2000;
  const RESOLVABLE_MODELS_MAX_JSON_BYTES = 48 * 1024;
  // Keep these aligned with acquire() in bin/opencode-broker so a bad local catalog
  // degrades this plugin rather than causing the broker to reject every prompt.
  const RESOLVABLE_MODELS_MAX_ENTRIES = 2048;
  const RESOLVABLE_MODEL_PATTERN = /^\S+\/\S+$/;
  const now = typeof options.now === "function" ? options.now : Date.now;
  let resolvableModelsCache = null;
  let resolvableModelsInflight = null;
  let resolvableModelsFailureReported = false;
  let resolvableModelsSuccessReported = false;
  const callingProcessResolvableModels = () => {
    if (resolvableModelsCache) {
      const cacheMs = resolvableModelsCache.models === null
        ? RESOLVABLE_MODELS_FAILURE_CACHE_MS
        : RESOLVABLE_MODELS_CACHE_MS;
      if (now() - resolvableModelsCache.at < cacheMs) return Promise.resolve(resolvableModelsCache.models);
    }
    if (resolvableModelsInflight) return resolvableModelsInflight;
    resolvableModelsInflight = (async () => {
      let timeout;
      try {
        // The host resolver snapshot can change after this OpenCode process starts, but this
        // process's provider catalog is frozen at spawn. Ask only while leasing: calling the
        // in-process server during plugin initialization can deadlock startup.
        // A client without the endpoint is a failure to report, not a reason to skip silently:
        // without the catalog this process can be leased models it cannot resolve.
        if (typeof client?.config?.providers !== "function") throw new Error("plugin client has no config.providers()");
        const response = await Promise.race([
          client.config.providers({ query: { directory } }),
          new Promise((_, reject) => {
            timeout = scheduleTimeout(() => reject(new Error(`provider catalog timed out after ${resolvableModelsTimeoutMs}ms`)), resolvableModelsTimeoutMs);
          }),
        ]);
        const payload = response?.data ?? response;
        if (!Array.isArray(payload?.providers) || payload.providers.length === 0) {
          throw new Error("provider catalog response has no providers array");
        }
        const models = [];
        for (const provider of payload.providers) {
          if (typeof provider?.id !== "string" || !provider.id || !provider.models ||
            typeof provider.models !== "object" || Array.isArray(provider.models)) {
            throw new Error("provider catalog response has an invalid provider entry");
          }
          for (const modelID of Object.keys(provider.models)) {
            if (!modelID) throw new Error("provider catalog response has an empty model id");
            models.push(`${provider.id}/${modelID}`);
          }
        }
        if (models.length === 0) throw new Error("provider catalog response has no models");
        if (models.length > RESOLVABLE_MODELS_MAX_ENTRIES) {
          throw new Error(`provider catalog has ${models.length} models, exceeding the ${RESOLVABLE_MODELS_MAX_ENTRIES}-model broker limit`);
        }
        if (models.some((model) => !RESOLVABLE_MODEL_PATTERN.test(model))) {
          throw new Error("provider catalog has a model id the broker cannot accept");
        }
        const modelsCharacters = JSON.stringify(models).length;
        if (modelsCharacters > RESOLVABLE_MODELS_MAX_JSON_BYTES) {
          throw new Error(`provider catalog is ${modelsCharacters} characters, exceeding the ${RESOLVABLE_MODELS_MAX_JSON_BYTES}-character lease budget`);
        }
        resolvableModelsCache = { at: now(), models };
        resolvableModelsFailureReported = false;
        if (!resolvableModelsSuccessReported) {
          resolvableModelsSuccessReported = true;
          report("info", `leasing with this process's provider catalog (${models.length} models)`);
        }
        return models;
      } catch (error) {
        resolvableModelsCache = { at: now(), models: null };
        if (!resolvableModelsFailureReported) {
          resolvableModelsFailureReported = true;
          report("warn", `could not read calling process provider catalog; leasing without resolvableModels: ${String(error?.message ?? error)}`);
        }
        return null;
      } finally {
        if (timeout !== undefined) cancelTimeout(timeout);
      }
    })().finally(() => { resolvableModelsInflight = null; });
    return resolvableModelsInflight;
  };
  const trimTracker = (tracker, limit = 2000) => {
    if (tracker.size <= limit) return;
    for (const key of tracker.keys()) {
      if (tracker.size <= limit / 2) break;
      tracker.delete(key);
    }
  };
  // HIGH-WATER MARK. Local models have a HARD context window (32k), not a soft
  // budget -- so this is a peak, never a running value that can drop. The trap
  // it closes: compaction on a local model completes a SUMMARY message whose
  // contextTokensOf is small; writing that back made the session look like it
  // fit the local model again, so it stayed local and compacted forever (a
  // 247k session wedged on qwen-coder). Once a session has needed N tokens it
  // is treated as needing N until the process restarts -- a once-big session
  // never gets classified small enough to land back on a model it overflowed.
  const bumpContextSize = (sessionID, value) => {
    const next = Number(value);
    if (!Number.isFinite(next) || next < 0) return;
    const prev = Number(contextSizes.get(sessionID));
    const peak = Number.isFinite(prev) ? Math.max(prev, next) : next;
    contextSizes.set(sessionID, peak);
    try { writeSessionContextEstimate(sessionID, peak); } catch {}
  };
  const sessionContextTokens = async (sessionID) => {
    if (contextSizes.has(sessionID)) return contextSizes.get(sessionID);
    let value = null;
    // One-time seed for a session resumed under a fresh plugin process; afterwards the
    // message.updated tracker keeps the peak current with no further API calls.
    // Take the MAX of the persisted estimate and the true history peak: a
    // persisted value can be a stale-SMALL number written by an older build
    // during a compaction loop, and trusting it alone would re-admit a
    // once-overflowed session to the local model. The history is the ground
    // truth; the persisted file is only a shortcut, never a ceiling.
    try {
      const persisted = Number(readSessionContextEstimate(sessionID));
      value = Number.isFinite(persisted) && persisted > 0 ? persisted : null;
      // Only fetch the (potentially huge) message history when a hidden larger
      // peak could change the local-fit decision -- i.e. the persisted value is
      // missing or still small enough to admit a local model. A persisted value
      // already at/above the local ceiling refuses local regardless of the
      // exact peak, so skip the scan: on a big session it was slow enough on the
      // first message to race the route into "route unavailable". ~0.6*32k.
      const LOCAL_CEILING = 20000;
      if (value === null || value < LOCAL_CEILING) {
        const result = await client.session.messages({ path: { id: sessionID }, query: { directory } });
        const rows = result?.data ?? result;
        if (Array.isArray(rows)) {
          // PEAK across the whole history, not the last message: if the last
          // completed message is a compaction summary its size is small, but
          // the session still needed the pre-summary size and must be seeded to
          // it -- otherwise a resumed once-big session seeds small and can wedge
          // on a local model all over again. Start from the persisted value so
          // the result is max(persisted, history peak).
          let peak = Number(value) || 0;
          for (const row of rows) {
            const info = row?.info ?? row;
            if (info?.role === "assistant" && info?.time?.completed) {
              const t = contextTokensOf(info);
              if (Number.isFinite(Number(t)) && Number(t) > peak) peak = Number(t);
            }
          }
          // A session with no completed assistant message yet is genuinely
          // fresh: report 0, not unknown. Local targets refuse UNKNOWN context
          // outright, and a fresh session must still be able to lease one.
          value = peak;
        }
      }
    } catch {}
    contextSizes.set(sessionID, value);
    return value;
  };
  let inventoryTask = null;
  let pendingForgetTask = null;
  const refreshInventory = async () => {
    if (inventoryTask) return inventoryTask;
    inventoryTask = (async () => {
      try {
        const response = await publishCachedSubscriptionInventory();
        if (response?.recovered) report("warn", response.recovered);
        if (response?.accepted === false) {
          report("warn", `inventory publication rejected: ${response.reason ?? "unknown reason"}`);
          return { changed: false };
        }
        return { changed: response?.changed === true };
      } finally {
        inventoryTask = null;
      }
    })();
    return inventoryTask;
  };
  const retryPendingForgets = async () => {
    if (pendingForgetTask) return pendingForgetTask;
    pendingForgetTask = (async () => {
      try {
        for (const record of listPendingForgetRecords()) {
          try {
            await brokerRequest("/forget", {
              sessionID: record.sessionID,
              ...(record.leaseID ? { leaseID: record.leaseID } : {}),
              ...(record.completed ? { completed: true } : {}),
            });
            removePendingForgetRecord(record.sessionID);
          } catch {
            try { writePendingForgetRecord(record.sessionID, {
              leaseID: record.leaseID,
              completed: record.completed,
            }); } catch {}
          }
        }
      } catch {}
    })();
    try {
      await pendingForgetTask;
    } finally {
      pendingForgetTask = null;
    }
  };
  void retryPendingForgets();
  const getSession = async (sessionID) => {
    const result = await client.session.get({
      path: { id: sessionID },
      query: { directory },
    });
    const session = result?.data ?? result;
    // ☠️ The SDK returns an error envelope { error: ... } on NotFound and similar, which
    // has no `id` field. A caller walking parentID on that object sees undefined and
    // (before this check) memoized the walker's current hop as its own root -- the
    // broker then counted a subagent's spend under the WRONG tree. A result without a
    // string id counts as a failed lookup; nothing cached, nothing returned.
    if (typeof session?.id !== "string" || !session.id) return null;
    sessions.set(session.id, session);
    return session;
  };

  // Resolve the ROOT of a session by walking parentID up through the sessions cache,
  // reaching for the API only when a hop is unknown. A session's root never changes, so
  // the answer is memoized per sessionID in a bounded map and reused forever.
  //
  // Cycle guard: at most 8 hops. If the walk hits an unknown session the lookup CANNOT
  // read, the field is simply omitted from /usage -- the session then counts as its own
  // root in the broker's tree rollup, which is the safe fallback (worst case: a subagent
  // alerts under its own key instead of its parent's). Never throw: this runs inside the
  // fire-and-forget /usage report chain and must not break anything.
  //
  // Failures are negatively memoized for ROOT_FAILURE_TTL_MS, and concurrent first lookups
  // for the same session share one in-flight promise -- otherwise every step-finish of a
  // subagent whose root cannot be resolved re-issues session.get on every hop, every step.
  const resolveRootSessionID = async (sessionID) => {
    if (!sessionID) return null;
    if (sessionRoots.has(sessionID)) return sessionRoots.get(sessionID);
    const failedAt = sessionRootFailures.get(sessionID);
    if (failedAt !== undefined && Date.now() - failedAt < ROOT_FAILURE_TTL_MS) return null;
    if (failedAt !== undefined) sessionRootFailures.delete(sessionID);
    const inflight = sessionRootInflight.get(sessionID);
    if (inflight) return inflight;
    const walk = (async () => {
      let current = sessionID;
      const visited = new Set();
      for (let hop = 0; hop < 8; hop += 1) {
        if (visited.has(current)) {
          sessionRootFailures.set(sessionID, Date.now());
          trimTracker(sessionRootFailures);
          return null;
        }
        visited.add(current);
        let session = sessions.get(current);
        if (!session) {
          // ☠️ A hung client.session.get must not strand this walk: if the SDK
          // never answers, the outer awaiter's finally (sessionRootInflight.delete,
          // sessionRootFailures.set) never runs either, so every later step on the
          // same session enters a fresh outer race against the same stuck promise
          // and waits rootResolveTimeoutMs AGAIN. The in-flight map also leaks.
          // Race the per-hop lookup against rootResolveTimeoutMs * 2 (twice the
          // outer deadline, so a healthy session.get finishes well inside the hop
          // budget) and treat a timeout as a failed lookup.
          const timeoutSentinel = Symbol("rootHopTimeout");
          let hopTimer;
          const hopTimeout = new Promise((resolve) => {
            hopTimer = scheduleTimeout(() => resolve(timeoutSentinel), rootResolveTimeoutMs * 2);
            hopTimer?.unref?.();
          });
          try {
            session = await Promise.race([
              getSession(current).catch(() => null),
              hopTimeout,
            ]);
          } finally {
            cancelTimeout(hopTimer);
          }
          if (session === timeoutSentinel) {
            sessionRootFailures.set(sessionID, Date.now());
            trimTracker(sessionRootFailures);
            return null;
          }
        }
        if (!session) {
          sessionRootFailures.set(sessionID, Date.now());
          trimTracker(sessionRootFailures);
          return null;
        }
        const parent = session.parentID;
        if (!parent) {
          sessionRoots.set(sessionID, current);
          trimTracker(sessionRoots);
          return current;
        }
        current = parent;
      }
      // 8-hop exhaustion: a chain this long is a bug, memoize the failure so later steps
      // do not pay for it again.
      sessionRootFailures.set(sessionID, Date.now());
      trimTracker(sessionRootFailures);
      return null;
    })();
    sessionRootInflight.set(sessionID, walk);
    trimTracker(sessionRootInflight);
    try {
      return await walk;
    } finally {
      sessionRootInflight.delete(sessionID);
    }
  };

  // Race the root walk against a bounded timeout. On timeout the walk continues (its
  // result is cached if it ever lands), and the caller gets null so the /usage report
  // can go out WITHOUT rootSessionID instead of waiting on an SDK that may never answer.
  const resolveRootSessionIDBounded = async (sessionID) => {
    if (!sessionID) return null;
    if (sessionRoots.has(sessionID)) return sessionRoots.get(sessionID);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = scheduleTimeout(() => resolve(null), rootResolveTimeoutMs);
      timer?.unref?.();
    });
    try {
      return await Promise.race([resolveRootSessionID(sessionID), timeout]);
    } finally {
      cancelTimeout(timer);
    }
  };

  const failLease = (resolved, error) => {
    const reason = String(error?.message ?? error ?? "broker returned no model target");
    throw new Error(`[opencode-broker] ${resolved.profile} profile blocked: ${reason}`);
  };

  const stopHeartbeat = (sessionID) => {
    const timer = heartbeats.get(sessionID);
    if (timer) clearInterval(timer);
    heartbeats.delete(sessionID);
  };
  const clearLocalChildInactivityWatchdog = (sessionID) => {
    const timer = localChildInactivityWatchdogs.get(sessionID);
    if (timer !== undefined) cancelTimeout(timer);
    localChildInactivityWatchdogs.delete(sessionID);
  };
  const clearLocalChildInFlightTools = (sessionID) => localChildInFlightTools.delete(sessionID);
  const isLocalChildRoute = (sessionID, session = sessions.get(sessionID)) =>
    Boolean(session?.parentID && !isClassifierAgent(session.agent) && routes.get(sessionID)?.target?.kind === "local");
  const failInactiveLocalChild = (sessionID) => {
    const existing = localChildInactivityCleanups.get(sessionID);
    if (existing) return existing;
    const cleanup = (async () => {
      const route = routes.get(sessionID);
      const targetID = route?.target?.id;
      const routeProfile = route?.profile;
      const recovery = ownRecovery(sessionID, route);
      const generation = recovery?.generation;
      clearLocalChildInactivityWatchdog(sessionID);
      clearLocalChildInFlightTools(sessionID);
      stopHeartbeat(sessionID);
      routes.delete(sessionID);
      successCandidates.delete(sessionID);
      let failure = null;
      try {
        failure = await brokerRequest("/failure", {
          sessionID,
          ...(route?.leaseID ? { leaseID: route.leaseID } : {}),
          ...(targetID ? { targetID } : {}),
          error: {
            code: LOCAL_CHILD_INACTIVITY_TIMEOUT,
            message: `Local child inactivity watchdog timed out after ${localChildInactivityWatchdogMs}ms`,
          },
        });
      } catch (error) {
        report("error", `failed to report local child inactivity watchdog failure for ${sessionID}`, error);
        try {
          await brokerRequest("/release", {
            sessionID,
            ...(route?.leaseID ? { leaseID: route.leaseID } : {}),
          });
        } catch (releaseError) {
          report("error", `failed to release local child ${sessionID} after inactivity watchdog failure`, releaseError);
        }
      }
      if (!currentRecovery(sessionID, recovery, generation)) return;
      try {
        const aborted = await client.session.abort({ path: { id: sessionID }, query: { directory } });
        if (aborted?.error) throw aborted.error;
      } catch (error) {
        report("error", `failed to abort local child ${sessionID} after inactivity watchdog failure`, error);
      }
      if (currentRecovery(sessionID, recovery, generation) && targetID && failure?.kind) {
        const circuitUntil = Number(failure.circuitUntil);
        const delay = !profileReachesCloud(routeProfile) && Number.isFinite(circuitUntil) && circuitUntil > Date.now()
          ? circuitUntil - Date.now() + 1
          : undefined;
        try { scheduleReengage(sessionID, failure.kind, { code: LOCAL_CHILD_INACTIVITY_TIMEOUT }, delay); } catch (error) {
          report("error", `failed to re-engage local child ${sessionID} after inactivity watchdog failure`, error);
        }
      }
    })();
    localChildInactivityCleanups.set(sessionID, cleanup);
    return cleanup.finally(() => localChildInactivityCleanups.delete(sessionID));
  };
  const rearmLocalChildInactivityWatchdog = (sessionID) => {
    clearLocalChildInactivityWatchdog(sessionID);
    if ((localChildInFlightTools.get(sessionID) ?? 0) > 0 || !isLocalChildRoute(sessionID)) return;
    const timer = scheduleTimeout(async () => {
      if (localChildInactivityWatchdogs.get(sessionID) !== timer) return;
      // The route can be settled after this timer was armed (idle, error, deletion). Its lease is
      // gone with it, and a lease-less /failure is refused by the broker; nothing is left to fail.
      if (!isLocalChildRoute(sessionID)) {
        clearLocalChildInactivityWatchdog(sessionID);
        return;
      }
      report("warn", `local child ${sessionID} was inactive for ${localChildInactivityWatchdogMs}ms; failing over`);
      await failInactiveLocalChild(sessionID);
    }, localChildInactivityWatchdogMs);
    timer?.unref?.();
    localChildInactivityWatchdogs.set(sessionID, timer);
  };
  const beginLocalChildTool = (sessionID) => {
    if (!isLocalChildRoute(sessionID)) return;
    localChildInFlightTools.set(sessionID, (localChildInFlightTools.get(sessionID) ?? 0) + 1);
    clearLocalChildInactivityWatchdog(sessionID);
  };
  const finishLocalChildTool = (sessionID) => {
    const count = localChildInFlightTools.get(sessionID) ?? 0;
    if (count <= 0) return;
    if (count === 1) {
      localChildInFlightTools.delete(sessionID);
      rearmLocalChildInactivityWatchdog(sessionID);
      return;
    }
    localChildInFlightTools.set(sessionID, count - 1);
  };
  const startHeartbeat = (sessionID) => {
    if (heartbeats.has(sessionID) || !routes.get(sessionID)?.target) return;
    const timer = setInterval(() => {
      brokerRequest("/touch", { sessionID }).catch(() => {});
    }, HEARTBEAT_MS);
    timer.unref?.();
    heartbeats.set(sessionID, timer);
    scheduleWrapUpCheck();
  };

  const route = async (session, preferredModel = null, turnEffort = null, checkContinuation = null, cfReprompt = false) => {
    if (!session?.id) return null;
    const classifier = isClassifierAgent(session.agent);
    if (classifier) {
      // Old builds persisted the parent's profile onto the child. Remove it before reading
      // the owner so a stale child record cannot widen or narrow the inherited boundary.
      try { removeSessionProfile(session.id); } catch {}
    }
    const owner = classifier
      ? resolveProfile({ sessionID: session.id, parentID: session.parentID })
      : null;
    const resolved = classifier
      ? { profile: "auto", explicit: false }
      : resolveProfile({ sessionID: session.id, parentID: session.parentID, agent: session.agent });
    let tier = classifier ? "classifier" : await routeTierForSession({
      agent: session.agent,
      parentID: session.parentID,
      sessionID: session.id,
      routes,
      sessions,
      getSession,
    });
    checkContinuation?.();
    const localOnly = classifier && profileConfinesToLan(owner.profile);
    // High-risk content raises the tier floor: a medical/safety/legal/financial
    // question where being wrong is dangerous is served from a strong model no
    // matter what agent the session is on. Deterministic escalation, not a
    // nudge that can be ignored or fail to apply.
    if (!classifier) tier = raiseTier(tier, riskFloors.get(session.id));
    // A deployment may fold one tier into another (config `tierAliases`). Where two lanes
    // resolve to the same model the split buys nothing and only multiplies the lanes a
    // session can be moved between -- measured: build and smart leasing the same model
    // 96% of the time each, so `{ "build": "smart" }` makes every path that lands on
    // `build` lease the smart lane. Applied after the risk floor, so a floor can never be
    // undercut by an alias.
    if (!classifier) tier = CONFIG.tierAliases[tier] ?? tier;
    if (!classifier) writeSessionProfile(session.id, resolved.profile, { explicit: resolved.explicit });
    if (resolved.profile === "manual") {
      // A child continues the parent model selected by the user. A root keeps its
      // current model; neither case asks the broker to make a model decision.
      if (session.parentID) {
        const parent = sessions.get(session.parentID) ?? await getSession(session.parentID);
        // Session metadata keeps the model from session creation and can lag the model the
        // parent is actually using. Prefer the live Manual route captured on its latest turn.
        const parentModel = routes.get(parent?.id)?.target?.model ?? routes.get(parent?.id)?.model ?? parent?.model;
        const parentModelID = parentModel?.modelID ?? parentModel?.id;
        if (parentModel?.providerID && parentModelID) {
          const locked = {
            locked: true,
            profile: resolved.profile,
            explicit: resolved.explicit,
            model: { providerID: parentModel.providerID, id: parentModelID, ...(parentModel.variant ? { variant: parentModel.variant } : {}) },
            tier,
          };
          clearLocalChildInactivityWatchdog(session.id);
          routes.set(session.id, locked);
          return locked;
        }
      }
      const locked = {
        locked: true,
        profile: resolved.profile,
        explicit: resolved.explicit,
        tier,
        ...(preferredModel?.providerID && preferredModel?.id ? { model: preferredModel } : {}),
      };
      clearLocalChildInactivityWatchdog(session.id);
      routes.set(session.id, locked);
      return locked;
    }
    // A content-filter re-prompt asks the broker for the NEXT cascade candidate instead of
    // the routed model. Declared out here so the catch below can clear the episode on an
    // exhausted/disabled cascade. Reachable only on a cfReprompt turn (step 5 flag + entry).
    const cfEntry = cfReprompt ? cfFailover.get(session.id) : null;
    const cfCascade = Boolean(cfEntry && cfEntry.blocked?.providerID && cfEntry.blocked?.modelID);
    let lease;
    try {
      const contextTokens = await sessionContextTokens(session.id);
      checkContinuation?.();
      // Stickiness exists to protect a session's warm provider cache -- so only
      // a session WITH HISTORY may prefer its current model. A brand-new
      // session's message model is just the agent's static pin (or the saved
      // default): letting it seed stickiness made the pin permanently outrank
      // fit, weights and depletion, which is exactly backwards.
      const seasoned = Number(contextTokens) > 0;
      // Restore after displacement: once the provider this session was pushed
      // off of is due back (its reset time has passed), stop preferring the
      // fallback model for one lease so the balancer can move the session home.
      // Strict fallback also drops that preference at the first eligible primary
      // opportunity, but keeps its marker until the non-fallback lease clears it.
      let marker = null;
      try { marker = readFallbackMarker(session.id); } catch {}
      const restoreDue = marker?.policy === "provider-displaced" &&
        Number.isFinite(Number(marker.restoreAt)) && Date.now() >= Number(marker.restoreAt);
      const rebalanceFallback = restoreDue || marker?.policy === "strict-fallback";
      if (restoreDue) {
        try { removeFallbackMarker(session.id); } catch {}
        report("info", `${session.id}: displacement window over -- releasing model stickiness for rebalance`);
      }
      const resolvableModels = await callingProcessResolvableModels();
      checkContinuation?.();
      const leaseBody = {
        sessionID: session.id,
        profile: resolved.profile,
        tier,
        replace: true,
        ...(classifier ? { localOnly } : {}),
        // A content-filter re-prompt drives the broker's contentFilterCascade mode: it must
        // NOT prefer, pin or fall back to the model that was just blocked, so preferredModel,
        // releasePin and fallbackTargetID are all omitted in favour of the cascade fields.
        ...(cfCascade
          ? {
              contentFilterCascade: true,
              blockedModel: { providerID: cfEntry.blocked.providerID, id: cfEntry.blocked.modelID },
              excludeTargetIDs: [...cfEntry.tried],
            }
          : {
              ...(!classifier && !rebalanceFallback && seasoned && preferredModel?.providerID && preferredModel?.id ? { preferredModel } : {}),
              // The broker pins every session to its model; the one time this plugin WANTS the
              // session re-decided is restore-home after a displacement, so it says so.
              ...(restoreDue ? { releasePin: true } : {}),
              ...(marker?.policy === "strict-fallback" && typeof marker.targetID === "string" && marker.targetID
                ? { fallbackTargetID: marker.targetID }
                : {}),
            }),
        ...(contextTokens !== null && contextTokens !== undefined ? { contextTokens } : {}),
        ...(resolvableModels ? { resolvableModels } : {}),
        ...(turnEffort && session.agent !== "compaction" ? {
          turnClass: {
            class: turnEffort.class,
            reason: turnEffort.reason,
            ...(turnEffort.resolvedFrom ? { resolvedFrom: turnEffort.resolvedFrom } : {}),
          },
          engineEffortUpdates: engineEffortUpdates.get(session.id) === true,
        } : {}),
      };
      // ☠️ A WAIT IS NOT A FAILURE. `target-busy` (every slot of a resident local model is
      // taken) and `target-preparing` (the model is being swapped onto its card) both clear
      // on their own. Failing the prompt on them dropped the work; retrying finds the slot.
      // Bounded, so a wedged local host still surfaces as an error rather than a hang.
      const waitStarted = Date.now();
      let announced = false;
      for (;;) {
        checkContinuation?.();
        try {
          lease = await brokerRequest("/lease", leaseBody);
          checkContinuation?.();
          break;
        } catch (error) {
          checkContinuation?.();
          const code = error?.code;
          if ((code !== "target-busy" && code !== "target-preparing") || Date.now() - waitStarted >= leaseWaitMaxMs) throw error;
          if (!announced) {
            announced = true;
            report("warn", `${session.id}: ${error.message} (waiting up to ${Math.round(leaseWaitMaxMs / 60000)} min)`);
            try {
              client?.tui?.showToast?.({ body: { message: `Waiting for a local model slot: ${error.message}`, variant: "info", duration: 8000 }, query: { directory } })
                ?.catch?.(() => {});
            } catch {}
          }
          await leaseSleep(leaseWaitStepMs);
        }
      }
      const target = lease?.target;
      if (!target?.model?.providerID || !target?.model?.id) {
        throw new Error(lease?.error ?? lease?.reason ?? lease?.message ?? "broker returned no model target");
      }
      // Record the candidate this cascade step leased so the next step (if it also blocks)
      // excludes it and the broker advances down the order.
      if (cfEntry && typeof target.id === "string" && target.id) cfEntry.tried.add(target.id);
      if (localOnly && target.kind !== "local") {
        throw new Error(`broker returned non-local classifier target ${target.id ?? `${target.model.providerID}/${target.model.id}`} for a local-only lease`);
      }
      // A degraded route must be VISIBLE: log it where the opencode log shows it,
      // and mark it where the hud renders it. A non-fallback lease clears the mark.
      const policy = lease?.decision?.policy ?? null;
      if (policy === "strict-fallback") {
        report("warn", `${resolved.profile}/${tier} FALLBACK: leased ${target.id} (${target.model.providerID}/${target.model.id}) because no primary ${tier} target was eligible (${(lease.decision.reasons ?? []).join(", ") || "circuits/quota/health"})`);
        try { writeFallbackMarker(session.id, { policy, targetID: target.id, reasons: lease.decision.reasons }); } catch {}
        if (!classifier && !session.parentID) {
          watchFallback(session.id, { profile: resolved.profile, tier, agent: session.agent, targetID: target.id });
        }
      } else {
        unwatchFallback(session.id);
        // A healthy lease clears fallback marks -- except a pending displacement
        // hold, which must survive until its provider's reset so the restore
        // path can release stickiness at the right moment.
        try {
          const marker = readFallbackMarker(session.id);
          const displacedHold = marker?.policy === "provider-displaced" &&
            Number.isFinite(Number(marker.restoreAt)) && Date.now() < Number(marker.restoreAt);
          if (marker && !displacedHold) removeFallbackMarker(session.id);
        } catch {}
      }
      const routed = {
        leaseID: lease.leaseID,
        profile: resolved.profile,
        tier,
        target,
        explicit: resolved.explicit,
      };
      routes.set(session.id, routed);
      // Served again (the resume, or the user nudging it first): no longer waiting.
      unpark(session.id);
      // A replacement lease restarts the inactivity window unless a tool is still running.
      // A non-local replacement clears the prior watchdog before it can terminate the new route.
      rearmLocalChildInactivityWatchdog(session.id);
      return routed;
    } catch (error) {
      // A cancelled automatic prompt's late lease response must neither clear
      // its successor's route nor recreate a parked owner.
      checkContinuation?.();
      // Never bypass provider admission with a static fallback. A clear block is
      // safer than silently spending an API-key provider after broker failure.
      clearLocalChildInactivityWatchdog(session.id);
      // A cascade that ran out of candidates (content-filter-exhausted / -disabled) or
      // otherwise failed to lease ends the episode here: the normal no-target path reports
      // the failure, and there is NO further re-prompt (loop safety).
      if (cfCascade) cancelContentFilterFailover(session.id);
      routes.delete(session.id);
      // Nothing in the lane can serve it: park it to resume when something can. Classifier
      // lanes are excluded -- they serve a guard decision, not a task to pick back up.
      if (!classifier && PARKABLE_REFUSALS.has(error?.code)) {
        parkSession(session.id, { profile: resolved.profile, tier, agent: session.agent, reason: error.code });
      }
      failLease(classifier ? owner : resolved, error);
    }
  };

  // --- Seamless failover -------------------------------------------------
  // When a provider stops a session (plan window exhausted, model dead, long
  // retry park), the user must not have to come back and nudge it. The failure
  // report has already opened the circuit, so a fresh lease lands on the next
  // best target; what remains is re-running the loop. A synthetic user part
  // does exactly that -- and doubles as the transcript record of the reroute.
  const REENGAGE_TEXT = "[opencode-broker] The previous model had a provider outage and this session is being rerouted. Continue the unfinished work while preserving completed steps; verify uncertain tool outcomes instead of replaying them.";
  const REENGAGE_DELAYS_MS = [2500, 5000, 10000, 20000, 40000, 60000];
  const RETRY_WAIT_FAILOVER_MS = 30 * 1000;
  // A single long park is the obvious stop. The case that used to slip through is a
  // RUN of short ones: five 20s waits cost a session 100s parked against a provider
  // that is plainly struggling, and never trip a PER-WAIT threshold. Accumulate the
  // waits over a window and treat the total as the same signal.
  const RETRY_WAIT_CUMULATIVE_MS = 60 * 1000;
  const RETRY_WINDOW_MS = 5 * 60 * 1000;
  const retryWaits = new Map(); // sessionID -> [{ at, waitMs }]
  // One owner per recovery episode, retained when the failed lease is released. Async
  // work must hold this exact entry AND generation; cancellation never recreates it.
  const reengagements = new Map();
  // A session.error has no message or provider identity in OpenCode's schema. Once a
  // human turn supersedes recovery work, that bare event can belong to either turn.
  // Keep only the current real-human and active synthetic parent: older IDs would
  // grow without bound and are not authoritative after supersession.
  const recoveryAttribution = new Map();
  const RECOVERY_ATTRIBUTION_LIMIT = 2000;
  const setRecoveryAttribution = (sessionID, state) => {
    recoveryAttribution.set(sessionID, state);
    while (recoveryAttribution.size > RECOVERY_ATTRIBUTION_LIMIT) {
      recoveryAttribution.delete(recoveryAttribution.keys().next().value);
    }
    return state;
  };
  const newRecoveryAttribution = (fenced = false) => ({
    humanParentID: null,
    activeParentID: null,
    fenced,
    recoverySeen: false,
  });
  const attributionForChat = (sessionID) => {
    const existing = recoveryAttribution.get(sessionID);
    if (existing) return existing;
    // Session metadata outlives bounded attribution. Its presence with no entry
    // means eviction, not a new session, so a bare error must stay fail-closed.
    const evicted = sessions.has(sessionID);
    return setRecoveryAttribution(sessionID, newRecoveryAttribution(evicted));
  };
  const recordChatAttribution = (sessionID, input, output, humanParts, syntheticOnly) => {
    const state = attributionForChat(sessionID);
    const outputID = typeof output?.message?.id === "string" && output.message.id ? output.message.id : null;
    const inputID = typeof input?.messageID === "string" && input.messageID ? input.messageID : null;
    const parentID = outputID ?? inputID;
    if (humanParts) {
      // Persist this fence forever for the session lifetime: an old SDK callback
      // may surface arbitrarily late, even after the newer turn completed.
      if (state.recoverySeen) state.fenced = true;
      state.humanParentID = parentID;
      state.activeParentID = parentID;
    } else if (syntheticOnly && parentID) {
      state.activeParentID = parentID;
    }
    return state;
  };
  const attributedToActiveTurn = (sessionID, record) => {
    const state = recoveryAttribution.get(sessionID);
    const parentID = record?.role === "assistant" && typeof record.parentID === "string" && record.parentID
      ? record.parentID
      : null;
    if (parentID) {
      // A positive parent is proof only when it names this turn, never merely the
      // same provider. This rejects a superseded B on C's provider.
      return Boolean(state && (parentID === state.humanParentID || parentID === state.activeParentID));
    }
    // Preserve historic behavior until a superseding human turn creates a fence.
    // Missing state for cached metadata is an eviction and deliberately fail-closed.
    return Boolean(state && !state.fenced) || (!state && !sessions.has(sessionID));
  };
  const unattributableToActiveTurn = (sessionID, record) => !attributedToActiveTurn(sessionID, record);
  // Keep a stopped route usable by chat.params without letting a late error on
  // that same route restart it. The next chat.message leases a fresh route object.
  // Weak references need no session tombstone store or restart persistence.
  const stoppedRecoveryRoutes = new WeakSet();
  const cancelReengagement = (sessionID) => {
    const entry = reengagements.get(sessionID);
    if (!entry) return;
    entry.generation += 1;
    if (entry.timer !== null) cancelTimeout(entry.timer);
    reengagements.delete(sessionID);
  };
  // keepContentFilter leaves an in-progress content-filter failover episode intact: a
  // content-filter finish still cancels any stale OUTAGE reengagement (as every terminal
  // finish did before), but must not wipe the cascade's tried/history that a chained block
  // depends on. Every other caller (human turn, abort, session delete, terminal non-cf
  // finish) clears the cascade too.
  const cancelRecovery = (sessionID, { keepContentFilter = false } = {}) => {
    for (const route of [routes.get(sessionID), reengagements.get(sessionID)?.route]) {
      if (route) stoppedRecoveryRoutes.add(route);
    }
    cancelReengagement(sessionID);
    if (!keepContentFilter) cancelContentFilterFailover(sessionID);
    unpark(sessionID);
  };
  const ownRecovery = (sessionID, route, agent = sessions.get(sessionID)?.agent) => {
    if (!route || stoppedRecoveryRoutes.has(route) || route.profile === "manual" || isClassifierAgent(agent) || parked.has(sessionID)) return null;
    let entry = reengagements.get(sessionID);
    if (!entry) {
      // Unlike trimTracker, eviction must also cancel the owned timeout.
      if (reengagements.size >= 2000) cancelReengagement(reengagements.keys().next().value);
      entry = { timer: null, inFlight: false, generation: 0, attempts: 0, agent, route, pending: null, messages: new Set() };
      reengagements.set(sessionID, entry);
    }
    entry.route = route;
    // Remember that recovery work existed even after its owner completes or is
    // cancelled. A later human turn must keep bare SDK events fail-closed.
    attributionForChat(sessionID).recoverySeen = true;
    return entry;
  };
  const currentRecovery = (sessionID, entry, generation) => Boolean(entry) &&
    reengagements.get(sessionID) === entry && entry.generation === generation && !parked.has(sessionID);
  const continuationKind = (error, route) => {
    const kind = classifyRoutingFailure(error, { targetProviderID: route?.target?.model?.providerID });
    if (kind === "context" && (route?.target?.kind === "local" || modelIsLocalTarget(route?.target?.model))) return "context-local";
    // A broken stream is retryable here, but deliberately NOT a provider-wide
    // connect circuit in lib/routing.js. Do not broaden that broker policy.
    const safe = normalizeProviderError(error);
    if (kind === "other" && safe.statusCode === undefined &&
      /\b(?:ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|socket hang ?up|connection reset|connection aborted by upstream/i
        .test(`${safe.code ?? ""} ${safe.message}`)) return "connect";
    // The GATEWAY's no-live-lease refusal (gateway/lib/gateway.js) means this session's
    // target was fenced mid-turn and its lease dropped. No provider is at fault, so the
    // classifier and the broker keep it "noop" and indict nothing -- but "noop" also means
    // no failover, stranding the turn until the user resends. A fresh lease lands on a
    // healthy target, so this one sub-case gets a plugin-local failover-eligible kind.
    // Deliberately narrow: only the gateway's own wording (never the plugin's chat.params
    // "route unavailable" throw, which lacks it), and only at the gateway's statuses --
    // 400 today, 409 before 297ac7a, or none when the SDK dropped it. Any other known
    // status (402, 401, 403, 413, 422, 5xx ...) is a different answer and stays terminal.
    if (kind === "noop" && [undefined, 400, 409].includes(safe.statusCode) &&
      /gateway: session holds no live lease/i.test(providerErrorText(error))) return "relocate";
    return kind;
  };
  const continuationForbidden = (kind, error) => {
    if (isAbortError(error) || ["abort", "noop", "payload", "context", "model", "auth"].includes(kind)) return true;
    const status = normalizeProviderError(error).statusCode;
    if ([401, 403].includes(status) && kind !== "quota") return true;
    if ([400, 413, 422].includes(status) && !["quota", "context-local", "relocate"].includes(kind)) return true;
    // Permission and malformed-request errors can carry misleading 503/overload
    // wording. Neither a generic "context" nor "aborted" word is an abort signal.
    return /\b(?:permission|forbidden|unauthori[sz]ed|authentication|malformed|payload|serializ(?:ation|e))\b/i
      .test(providerErrorText(error));
  };
  const transientContinuation = (kind, error) => !continuationForbidden(kind, error) &&
    ["rate", "quota", "overload", "connect", "context-local", "relocate"].includes(kind);
  const promptContinuation = async (sessionID, entry, text, kind) => {
    const generation = ++entry.generation;
    entry.inFlight = true;
    entry.pending = null;
    entry.promptPartID = `prt_${randomUUID()}`;
    if (kind === "context-local") entry.contextEscapeUsed = true;
    // Attempts count actual continuations, not duplicate error notifications.
    entry.attempts = Math.min(entry.attempts + 1, REENGAGE_DELAYS_MS.length);
    let promptError = null;
    try {
      const result = await client.session.prompt({
        path: { id: sessionID },
        query: { directory },
        body: {
          ...(typeof entry.agent === "string" && entry.agent ? { agent: entry.agent } : {}),
          parts: [{ id: entry.promptPartID, type: "text", text, synthetic: true }],
        },
      });
      if (!currentRecovery(sessionID, entry, generation)) return;
      if (result?.error) promptError = providerErrorFrom(result.error) ?? result.error;
    } catch (error) {
      if (!currentRecovery(sessionID, entry, generation)) return;
      report("error", `${sessionID}: continuation failed`, error);
      promptError = error;
    }
    if (!currentRecovery(sessionID, entry, generation)) return;
    entry.inFlight = false;
    if (promptError) {
      // No fallback to the previous outage kind: an unknown SDK error is not
      // evidence of an outage. The current lease supplies local-context evidence.
      scheduleReengage(sessionID, continuationKind(promptError, routes.get(sessionID) ?? entry.route), promptError);
    } else if (entry.pending?.ready) {
      const pending = entry.pending;
      scheduleReengage(sessionID, pending.kind, pending.error, pending.delay);
    } else {
      report("info", `${sessionID}: re-engaged after ${kind} failure`);
    }
  };
  const scheduleReengage = (sessionID, kind, error, delayOverride = null) => {
    if (!transientContinuation(kind, error)) {
      cancelRecovery(sessionID);
      return;
    }
    const entry = reengagements.get(sessionID);
    if (!entry || parked.has(sessionID) || entry.timer !== null) return;
    // Context overflow is not an outage. Preserve the one move off a small local
    // window, but leave a repeated fit failure to compaction or a real new turn.
    if (kind === "context-local" && entry.contextEscapeUsed) {
      cancelRecovery(sessionID);
      return;
    }
    entry.pending = { kind, error, delay: delayOverride, ready: true };
    if (entry.inFlight) return;
    const generation = entry.generation;
    const delay = delayOverride ?? REENGAGE_DELAYS_MS[Math.min(entry.attempts, REENGAGE_DELAYS_MS.length - 1)];
    entry.timer = scheduleTimeout(async () => {
      if (!currentRecovery(sessionID, entry, generation)) return;
      entry.timer = null;
      if (resolveProfile({ sessionID, parentID: sessions.get(sessionID)?.parentID, agent: entry.agent }).profile === "manual") {
        cancelRecovery(sessionID);
        return;
      }
      await promptContinuation(sessionID, entry, REENGAGE_TEXT, kind);
    }, delay);
    entry.timer?.unref?.();
  };
  // --- Resume after an outage --------------------------------------------
  // Failover covers a provider stopping a session while ANOTHER can take it. When none
  // can -- every plan in the lane spent, or the lane otherwise empty -- the turn fails
  // with nowhere to go, and the session used to sit there until someone noticed the
  // provider was back and nudged it by hand, possibly days later for a weekly limit.
  // Such a session is PARKED instead: once a minute the broker is asked (side-effect-free
  // /preview, at the session's own context size) whether its lane would get a model now,
  // and when it would, the session is re-engaged exactly like a failover.
  const RESUME_TEXT = "[opencode-broker] A model is available again after the provider outage that stopped this session. Continue the task exactly where it stopped; do not restart completed work.";
  const RESUME_POLL_MS = 60 * 1000;
  // Longer than the longest plan window (a week), so a weekly limit still resumes.
  const PARK_MAX_MS = 8 * 24 * 60 * 60 * 1000;
  // Refusals that mean "nothing can serve this lane right now" -- and nothing else. A
  // busy or preparing target already waits in place; anything else is not an outage.
  const PARKABLE_REFUSALS = new Set(["usage-limit", "no-eligible-target"]);
  const parked = new Map(); // sessionID -> { profile, tier, agent, since, reason, notBefore }
  // ☠️ A RESUME THAT FAILS AGAIN BACKS OFF. /preview can say a lane is servable while its
  // provider still refuses (a full window Anthropic has not locked), so the resumed turn
  // fails and re-parks. Resumes within the last two hours space out 1, 2, 4 ... 30 minutes
  // apart instead of spending a failed request every minute until the window resets.
  const RESUME_BACKOFF_WINDOW_MS = 2 * 60 * 60 * 1000;
  const RESUME_BACKOFF_MAX_MS = 30 * 60 * 1000;
  const resumeHistory = new Map(); // sessionID -> [resumedAt, ...]
  let resumeTimer = null;
  const unpark = (sessionID) => {
    if (!parked.delete(sessionID)) return;
    if (!parked.size && resumeTimer) { cancelTimeout(resumeTimer); resumeTimer = null; }
  };
  // A self-rescheduling timeout on the injectable scheduler (tests drive it), running only
  // while something is parked.
  const scheduleResumePoll = () => {
    if (resumeTimer || !parked.size) return;
    resumeTimer = scheduleTimeout(async () => {
      resumeTimer = null;
      try { await pollParked(); } catch {}
      scheduleResumePoll();
    }, RESUME_POLL_MS);
    if (typeof resumeTimer?.unref === "function") resumeTimer.unref();
  };
  const pollParked = async () => {
    for (const [sessionID, entry] of [...parked]) {
      if (Date.now() - entry.since > PARK_MAX_MS) {
        report("warn", `${sessionID}: no model came back within ${Math.round(PARK_MAX_MS / 86_400_000)} days -- no longer waiting to resume`);
        unpark(sessionID);
        continue;
      }
      if (Date.now() < (entry.notBefore ?? 0)) continue;
      const sameProfile = () => resolveProfile({ sessionID, parentID: sessions.get(sessionID)?.parentID, agent: entry.agent }).profile === entry.profile;
      if (!sameProfile()) { unpark(sessionID); continue; }
      let target = null;
      try {
        const contextTokens = await sessionContextTokens(sessionID);
        if (parked.get(sessionID) !== entry) continue;
        const preview = await brokerRequest("/preview", {
          profile: entry.profile,
          tiers: [entry.tier],
          ...(Number(contextTokens) > 0 ? { contextTokens } : {}),
        });
        target = preview?.preview?.[entry.tier] ?? null;
      } catch { continue; } // broker down: try again next minute
      // The request may have outlived a user message, abort, deletion, terminal
      // failure or a replacement park. A stale snapshot never owns a prompt.
      if (parked.get(sessionID) !== entry || !target?.model?.id) continue;
      if (!sameProfile()) { unpark(sessionID); continue; }
      unpark(sessionID);
      const recovery = ownRecovery(sessionID, { profile: entry.profile, tier: entry.tier, target }, entry.agent);
      if (!recovery) continue;
      resumeHistory.set(sessionID, [...(resumeHistory.get(sessionID) ?? []), Date.now()]
        .filter((at) => Date.now() - at < RESUME_BACKOFF_WINDOW_MS));
      trimTracker(resumeHistory);
      const model = `${target.model.providerID ?? ""}/${target.model.id}`.replace(/^\//, "");
      report("info", `${sessionID}: ${model} is available again -- resuming the session parked since ${new Date(entry.since).toISOString()} (${entry.reason})`);
      try {
        client?.tui?.showToast?.({ body: { message: `Resuming a stopped session: ${model} is available again`, variant: "success", duration: 10000 }, query: { directory } })
          ?.catch?.(() => {});
      } catch {}
      await promptContinuation(sessionID, recovery, RESUME_TEXT, "parked");
    }
  };
  const parkSession = (sessionID, { profile, tier, agent, reason }) => {
    if (!sessionID || !tier) return;
    // The preview queue owns sustained no-lane recovery; it must never race a delayed prompt.
    cancelReengagement(sessionID);
    const existing = parked.get(sessionID);
    const recentResumes = (resumeHistory.get(sessionID) ?? []).filter((at) => Date.now() - at < RESUME_BACKOFF_WINDOW_MS).length;
    const notBefore = recentResumes
      ? Date.now() + Math.min(RESUME_BACKOFF_MAX_MS, RESUME_POLL_MS * 2 ** (recentResumes - 1))
      : 0;
    parked.set(sessionID, { profile, tier, agent, reason, since: existing?.since ?? Date.now(), notBefore });
    trimTracker(parked);
    if (!existing) report("info", `${sessionID}: parked -- no model can serve ${profile}/${tier} right now (${reason}); it resumes when one comes back`);
    scheduleResumePoll();
  };

  // --- Restore home after a fallback ---------------------------------------
  // A strict-fallback lease (every primary of the lane was down) binds the WHOLE turn: opencode
  // re-leases only on the next prompt, so a long agent turn stayed on the emergency rung long
  // after its primaries came back. Measured 2026-10-19: a smart root fell to gpt-terra during a
  // 3-minute llm-auth-proxy outage and was still on it 16 minutes after the proxy recovered.
  // While a root works on a fallback, the broker is asked once a minute (/preview, side-effect
  // free) whether its lane would get a primary now. When it would, the turn is aborted at the
  // next step boundary -- a step-finish that continues with tool calls, so the step's tools have
  // already returned and nothing in flight is lost -- and re-engaged, which re-leases it home.
  // Roots only: aborting a subagent ends its parent's task call with the work unreturned.
  const RESTORE_TEXT = "[opencode-broker] A primary model is available again; the session was moved off its fallback model. Continue the task exactly where it stopped; do not restart completed work.";
  const RESTORE_POLL_MS = 60 * 1000;
  // A primary that previews as servable but fails again sends the session back to the
  // fallback; cap the round trips so a flapping provider cannot abort the turn every minute.
  const RESTORE_WINDOW_MS = 30 * 60 * 1000;
  const RESTORE_MAX_ATTEMPTS = 3;
  const onFallback = new Map(); // sessionID -> { profile, tier, agent, targetID, ready }
  const restoreHistory = new Map(); // sessionID -> [restoredAt, ...]
  let restoreTimer = null;
  const unwatchFallback = (sessionID) => {
    if (!onFallback.delete(sessionID)) return;
    if (!onFallback.size && restoreTimer) { cancelTimeout(restoreTimer); restoreTimer = null; }
  };
  const scheduleRestorePoll = () => {
    if (restoreTimer || !onFallback.size) return;
    restoreTimer = scheduleTimeout(async () => {
      restoreTimer = null;
      try { await pollFallbacks(); } catch {}
      scheduleRestorePoll();
    }, RESTORE_POLL_MS);
    if (typeof restoreTimer?.unref === "function") restoreTimer.unref();
  };
  const watchFallback = (sessionID, { profile, tier, agent, targetID }) => {
    if (!sessionID || !tier) return;
    onFallback.set(sessionID, { profile, tier, agent, targetID, ready: false });
    trimTracker(onFallback);
    scheduleRestorePoll();
  };
  const pollFallbacks = async () => {
    for (const [sessionID, entry] of [...onFallback]) {
      if (entry.ready) continue;
      let target = null;
      try {
        const contextTokens = await sessionContextTokens(sessionID);
        const preview = await brokerRequest("/preview", {
          profile: entry.profile,
          tiers: [entry.tier],
          ...(Number(contextTokens) > 0 ? { contextTokens } : {}),
        });
        target = preview?.preview?.[entry.tier] ?? null;
      } catch { continue; } // broker down: try again next minute
      // `fallback` is the broker saying its answer is itself a fallback rung; a broker too old
      // to say so still never moves a session to the very target it is already on.
      if (!target?.model?.id || target.fallback === true || target.id === entry.targetID) continue;
      entry.ready = true;
      const model = `${target.model.providerID ?? ""}/${target.model.id}`.replace(/^\//, "");
      report("info", `${sessionID}: ${model} can serve ${entry.profile}/${entry.tier} again -- leaving fallback ${entry.targetID} at the next step boundary`);
    }
  };
  const restoreAtStepBoundary = (sessionID, finishReason) => {
    const entry = onFallback.get(sessionID);
    // Any other finish ends the turn; the next prompt re-leases home on its own.
    if (!entry?.ready || finishReason !== "tool-calls") return;
    unwatchFallback(sessionID);
    const now = Date.now();
    const history = (restoreHistory.get(sessionID) ?? []).filter((at) => now - at < RESTORE_WINDOW_MS);
    if (history.length >= RESTORE_MAX_ATTEMPTS) {
      report("warn", `${sessionID}: not leaving fallback ${entry.targetID} -- ${history.length} restores in the last ${RESTORE_WINDOW_MS / 60000} min`);
      return;
    }
    restoreHistory.set(sessionID, [...history, now]);
    trimTracker(restoreHistory);
    report("info", `${sessionID}: leaving fallback ${entry.targetID} -- aborting at the step boundary to re-lease on a primary`);
    Promise.resolve().then(async () => {
      try { await client.session.abort({ path: { id: sessionID }, query: { directory } }); } catch {}
      const handle = scheduleTimeout(async () => {
        try {
          await client.session.prompt({
            path: { id: sessionID },
            query: { directory },
            body: {
              ...(typeof entry.agent === "string" && entry.agent ? { agent: entry.agent } : {}),
              parts: [{ type: "text", text: RESTORE_TEXT, synthetic: true }],
            },
          });
        } catch (error) {
          report("error", `${sessionID}: restore from fallback failed`, error);
        }
      }, REENGAGE_DELAYS_MS[0]);
      if (typeof handle?.unref === "function") handle.unref();
    }).catch(() => {});
  };

  // --- Content-filter failover ---------------------------------------------
  // A provider's content filter refusing ONE query lands as a COMPLETED assistant message
  // with finish "content-filter" -- a healthy model declining this prompt, not an outage.
  // The broker's contentFilterCascade /lease mode walks a per-request, non-sticky chain of
  // fallback models; this re-prompts the session on the next candidate (aborting the blocked
  // turn, then a short delay, then a synthetic prompt -- the exact shape restoreAtStepBoundary
  // uses) and chains down the order until a model answers or the order is exhausted. The
  // broker marks the cascade assignment fallback:true, so the session returns to its routed
  // model on its next NORMAL turn with no "restore home" work here. This is a PARALLEL,
  // narrow mechanism to the outage reengagement machinery above: every path below is reachable
  // only after a turn finished "content-filter", and it is bounded so it can never re-prompt
  // storm. CF_RETRY_TEXT is the sentinel that chat.message matches (with the minted part id)
  // to recognise its own re-prompt.
  const CF_RETRY_TEXT = "[opencode-broker] Please answer my previous request.";
  const CF_MAX_ATTEMPTS = 6;
  const CF_WINDOW_MS = 10 * 60 * 1000;
  // sessionID -> { blocked: { providerID, modelID }, tried: Set<targetId>, agent, promptPartID, history: number[], timer }
  const cfFailover = new Map();
  const cancelContentFilterFailover = (sessionID) => {
    const entry = cfFailover.get(sessionID);
    if (!entry) return;
    if (entry.timer !== null && entry.timer !== undefined) cancelTimeout(entry.timer);
    cfFailover.delete(sessionID);
  };
  const beginContentFilterFailover = (sessionID, record) => {
    if (!sessionID || !record) return;
    // The cascade excludes the blocked model by provider+model; without both we cannot form
    // a valid blockedModel and the broker could re-lease the very model that just refused.
    if (!record.providerID || !record.modelID) return;
    // Guards: keep general behaviour and non-cloud/manual/classifier/parked sessions wholly
    // untouched. A local lane does not content-filter this way, and a LAN/private or manual
    // session must never be cascaded onto a cloud model.
    if (routes.get(sessionID)?.profile === "manual") return;
    if (isClassifierAgent(sessions.get(sessionID)?.agent)) return;
    if (record.providerID === "llamacpp") return;
    if (parked.has(sessionID)) return;
    const now = Date.now();
    let entry = cfFailover.get(sessionID);
    if (!entry) {
      entry = { blocked: null, tried: new Set(), agent: undefined, promptPartID: null, history: [], timer: null, reprompting: false };
      cfFailover.set(sessionID, entry);
      trimTracker(cfFailover);
    }
    entry.history = entry.history.filter((at) => now - at < CF_WINDOW_MS);
    if (entry.history.length >= CF_MAX_ATTEMPTS) {
      report("warn", `${sessionID}: content-filter failover gave up after ${entry.history.length} re-prompts within ${CF_WINDOW_MS / 60000} min -- leaving the refusal in place`);
      cancelContentFilterFailover(sessionID);
      return;
    }
    // Keep the ORIGINAL blocked model as the cascade head for the whole episode: the broker
    // skips the head by provider+model and every already-tried candidate by target id, so the
    // order always advances. Overwriting the head with each chained block would stop excluding
    // the first refusing model, letting the broker re-lease it for one wasted re-prompt.
    if (!entry.blocked) entry.blocked = { providerID: record.providerID, modelID: record.modelID };
    entry.agent = sessions.get(sessionID)?.agent;
    entry.history.push(now);
    entry.promptPartID = `prt_${randomUUID()}`;
    // A new cascade step supersedes any still-pending re-prompt timer for this session.
    if (entry.timer !== null && entry.timer !== undefined) { cancelTimeout(entry.timer); entry.timer = null; }
    report("info", `${sessionID}: content-filter block on ${record.providerID}/${record.modelID} -- failing this turn over to the next cascade model`);
    // The abort below ends the blocked turn, and OpenCode surfaces it as an abort error event.
    // The handler's "any abort cancels" rule would mistake that for a user Stop and tear down
    // THIS episode before its re-prompt fires. Flag the episode as driving a re-prompt so the
    // abort-cancel sites spare it; a genuine Stop outside this brief window still cancels.
    entry.reprompting = true;
    Promise.resolve().then(async () => {
      try { await client.session.abort({ path: { id: sessionID }, query: { directory } }); } catch {}
      // Superseded or cancelled while the abort was in flight: do not re-prompt.
      if (cfFailover.get(sessionID) !== entry) return;
      const handle = scheduleTimeout(async () => {
        if (cfFailover.get(sessionID) !== entry) return;
        // The re-prompt turn is starting: close the self-abort window so a later Stop cancels.
        entry.reprompting = false;
        try {
          await client.session.prompt({
            path: { id: sessionID },
            query: { directory },
            body: {
              ...(typeof entry.agent === "string" && entry.agent ? { agent: entry.agent } : {}),
              parts: [{ id: entry.promptPartID, type: "text", text: CF_RETRY_TEXT, synthetic: true }],
            },
          });
        } catch (error) {
          report("error", `${sessionID}: content-filter failover re-prompt failed`, error);
        }
      }, REENGAGE_DELAYS_MS[0]);
      entry.timer = handle;
      if (typeof handle?.unref === "function") handle.unref();
    }).catch(() => {});
  };

  // --- Wrap up before usage runs out ----------------------------------------
  // Failover moves a session when one provider stops it; parking resumes it when one comes
  // back. Neither helps the moment before: when every provider the lane can use is about to
  // run out and no local model can take over, a working session is cut off mid-step with
  // nothing written down. So while sessions are working, the broker is asked once a minute
  // (/headroom, side-effect-free) whether their lane is nearly out, and each working session is
  // told -- once per limit window -- to finish or checkpoint its step and write a handoff
  // (a subagent returns what it has instead). The handoff is what the resumed session reads.
  const WRAP_UP_POLL_MS = 60 * 1000;
  const wrapUpSent = new Map(); // sessionID -> when it was told, for the current nearly-out episode
  let wrapUpTimer = null;
  const checkWrapUp = async () => {
    const asked = new Map(); // one /headroom per lane and context size per pass
    const told = [];
    for (const sessionID of [...heartbeats.keys()]) {
      const routed = routes.get(sessionID);
      const session = sessions.get(sessionID);
      if (!routed?.target || !routed.tier || isClassifierAgent(session?.agent)) continue;
      let contextTokens = null;
      try { contextTokens = await sessionContextTokens(sessionID); } catch {}
      const key = `${routed.profile}|${routed.tier}|${Math.ceil((Number(contextTokens) || 0) / 10_000)}`;
      if (!asked.has(key)) {
        asked.set(key, brokerRequest("/headroom", {
          profile: routed.profile, tier: routed.tier,
          ...(Number(contextTokens) > 0 ? { contextTokens } : {}),
        }).catch(() => null));
      }
      const headroom = await asked.get(key);
      if (!headroom) continue;
      // Once per episode: the mark clears when the lane has room again (a reset, a provider
      // back). Not keyed on reset times -- providers report them with sub-second jitter
      // (03:19:59.594, then 03:20:00.046 for the same reset), which would repeat the message.
      if (!headroom.nearlyOut) { wrapUpSent.delete(sessionID); continue; }
      if (wrapUpSent.has(sessionID)) continue;
      wrapUpSent.set(sessionID, Date.now());
      trimTracker(wrapUpSent);
      try {
        const response = await client.session.promptAsync({
          path: { id: sessionID },
          query: { directory },
          body: {
            ...(typeof session?.agent === "string" && session.agent ? { agent: session.agent } : {}),
            parts: [{ type: "text", text: wrapUpMessage(headroom, { subagent: Boolean(session?.parentID) }), synthetic: true }],
          },
        });
        if (response?.error) throw new Error(JSON.stringify(response.error));
        told.push(sessionID);
        report("warn", `${sessionID}: usage nearly out on ${routed.profile}/${routed.tier} -- asked it to wrap up${session?.parentID ? "" : " and write a handoff"}`);
      } catch (error) {
        wrapUpSent.delete(sessionID);
        report("error", `${sessionID}: could not ask it to wrap up`, error);
      }
    }
    if (told.length) {
      try {
        client?.tui?.showToast?.({ body: { message: `Usage nearly out: asked ${told.length} working session${told.length === 1 ? "" : "s"} to wrap up and write a handoff`, variant: "warning", duration: 15000 }, query: { directory } })
          ?.catch?.(() => {});
      } catch {}
    }
  };
  // Runs only while some routed session is working (the heartbeat set), on the injectable
  // scheduler so tests can drive it.
  const scheduleWrapUpCheck = () => {
    // Classifier lanes serve a guard decision, not a task: they never need a wrap-up.
    const working = [...heartbeats.keys()].some((sessionID) => !isClassifierAgent(sessions.get(sessionID)?.agent));
    if (wrapUpTimer || !working) return;
    wrapUpTimer = scheduleTimeout(async () => {
      wrapUpTimer = null;
      try { await checkWrapUp(); } catch {}
      scheduleWrapUpCheck();
    }, WRAP_UP_POLL_MS);
    if (typeof wrapUpTimer?.unref === "function") wrapUpTimer.unref();
  };

  // Remember whom the session was displaced FROM and when that provider is due
  // back, so stickiness can be dropped at restore time instead of gluing the
  // session to its fallback provider forever.
  const markDisplaced = (sessionID, targetID, failure) => {
    if (!failure?.circuitUntil || !["quota", "rate"].includes(failure.kind)) return;
    try {
      writeFallbackMarker(sessionID, {
        policy: "provider-displaced",
        targetID,
        restoreAt: Number(failure.circuitUntil),
        reasons: [failure.kind],
      });
    } catch {}
  };

  const ensure = async (sessionID, agentHint, preferredModel = null, turnEffort = null, checkContinuation = null, cfReprompt = false) => {
    if (!sessionID) return;
    checkContinuation?.();
    let session = sessions.get(sessionID);
    try {
      // Session metadata is immutable for routing purposes. Fetch it only once when
      // a resumed session did not emit session.created in this plugin process.
      if (!session) session = await getSession(sessionID);
    } catch (error) {
      checkContinuation?.();
      const resolved = resolveProfile({ sessionID });
      // A Manual root with a model supplied by chat.message has enough authoritative
      // data to preserve the user's selection. Every routed profile fails closed.
      if (resolved.profile === "manual" && preferredModel?.providerID && preferredModel?.id) {
        const locked = {
          locked: true,
          profile: resolved.profile,
          explicit: resolved.explicit,
          target: { model: preferredModel },
        };
        clearLocalChildInactivityWatchdog(sessionID);
        routes.set(sessionID, locked);
        return locked;
      }
      failLease(resolved, error);
    }
    checkContinuation?.();
    if (!session?.id) return;
    // Fresh root session.created events do not consistently include the chosen agent.
    // chat.message carries the authoritative agent while OpenCode is still building
    // the persisted user message and before it resolves the provider model.
    const agent = typeof agentHint === "string" && agentHint ? agentHint : session.agent;
    if (agent !== session.agent) {
      session = { ...session, agent };
      sessions.set(session.id, session);
    }
    // ☠️ A SUBAGENT NEVER PICKS ITS OWN MODEL, so a message's model is not its preference.
    // A prompt that names no model (a re-engage, a steering message, an oc_send) is stamped
    // with the pane's default -- on 2026-09-28 that was Opus, and a gpt-5.6-sol
    // sp-implementer 24 steps into its run was re-leased onto it as "the session's preferred
    // model": a 170k-token cold write on another provider for a subagent nobody moved. Once
    // routed, a subagent's preference is the model it is already on.
    if (session.parentID) {
      const current = routes.get(sessionID)?.target?.model;
      if (current?.providerID && current?.id) {
        preferredModel = {
          providerID: current.providerID,
          id: current.id,
          ...(typeof current.variant === "string" && current.variant ? { variant: current.variant } : {}),
        };
      }
    }
    return route(session, preferredModel, turnEffort, checkContinuation, cfReprompt);
  };

  return {
    // Per-profile tool restrictions are the router's boundary -- profiles are its
    // concept: privacy profiles must not reach network or MCP tools, and offline
    // profiles run their shell commands inside a no-network sandbox (bwrap).
    // Enforced here (moved from the guard plugin at extraction) because
    // hooks from every plugin run, so a throw here blocks the tool regardless of
    // plugin load order.
    "tool.execute.before": async (input, output) => {
      const sessionID = input?.sessionID;
      if (!sessionID) return;
      let resolved = resolveProfile({ sessionID });
      if (resolved.source === "default") {
        // A fresh session may not have a record yet; the authoritative session
        // carries parent/agent, and the sessions cache makes this cheap.
        try {
          let session = sessions.get(sessionID);
          if (!session) session = await getSession(sessionID);
          resolved = resolveProfile({ sessionID, parentID: session?.parentID, agent: session?.agent });
        } catch {}
      }
      const profile = resolved.profile;
      const toolPolicy = toolAllowedForProfile(profile, input?.tool);
      if (!toolPolicy.allowed) {
        throw new Error(`[opencode-broker] blocked by ${profile} profile: ${toolPolicy.reason}.`);
      }
      if (isOfflineProfile(profile) && input?.tool === "bash" &&
        typeof output?.args?.command === "string" && output.args.command) {
        const command = output.args.command.startsWith("snip ")
          ? output.args.command.slice(5)
          : output.args.command;
        output.args.command = wrapOfflineCommand(command, directory);
      }
      beginLocalChildTool(sessionID);
    },
    "tool.execute.after": async (input) => {
      finishLocalChildTool(input?.sessionID);
    },
    "chat.message": async (input, output) => {
      const sessionID = extractSessionID(input);
      void retryPendingForgets();
      if (!sessionID) return;
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      const humanParts = parts.some((part) => ["text", "file"].includes(part?.type) && part.synthetic !== true);
      const syntheticOnly = !humanParts && parts.some((part) => part?.type === "text" && part.synthetic === true);
      const recoveryTextPart = syntheticOnly ? parts.find((part) => part?.type === "text" && part.synthetic === true &&
        [REENGAGE_TEXT, RESUME_TEXT].includes(part.text)) : null;
      const candidateContinuation = recoveryTextPart ? reengagements.get(sessionID) : null;
      const continuation = candidateContinuation && typeof candidateContinuation.promptPartID === "string" && candidateContinuation.promptPartID &&
        recoveryTextPart?.id === candidateContinuation.promptPartID
        ? candidateContinuation : null;
      const ownContinuation = Boolean(continuation);
      const continuationGeneration = continuation?.generation;
      // A content-filter failover re-prompt is ours only if the SDK returned the exact
      // synthetic part we minted (CF_RETRY_TEXT + the stored promptPartID). Parallel to the
      // outage-continuation recognition above; its own narrow mechanism, never mixed in.
      const cfRepromptEntry = syntheticOnly ? cfFailover.get(sessionID) : null;
      const cfReprompt = Boolean(cfRepromptEntry && typeof cfRepromptEntry.promptPartID === "string" && cfRepromptEntry.promptPartID &&
        parts.some((part) => part?.type === "text" && part.synthetic === true &&
          part.text === CF_RETRY_TEXT && part.id === cfRepromptEntry.promptPartID));
      const checkContinuation = ownContinuation ? () => {
        if (!currentRecovery(sessionID, continuation, continuationGeneration)) {
          throw new Error("[opencode-broker] cancelled continuation");
        }
      } : null;
      // A recovery text is ours only if the SDK returned the exact part we sent.
      // Do this before any mutation so a late B callback cannot take C ownership.
      if (recoveryTextPart && !ownContinuation) {
        throw new Error("[opencode-broker] cancelled continuation");
      }
      checkContinuation?.();
      successCandidates.delete(sessionID);
      // This must precede every await: event delivery can race route acquisition.
      // A human turn fences any cancelled recovery episode before its late SDK
      // error can be mistaken for this turn's currently leased provider.
      recordChatAttribution(sessionID, input, output, humanParts, syntheticOnly);
      // Cancel BEFORE any SDK or broker await, including attachment-only turns.
      if (humanParts) cancelRecovery(sessionID);
      else if (syntheticOnly && !ownContinuation) {
        // A background notice starts work too. Retire the pending send without
        // treating the notice as a human reset of the episode's backoff/ownership.
        const entry = reengagements.get(sessionID);
        if (entry) {
          entry.generation += 1;
          if (entry.timer !== null) cancelTimeout(entry.timer);
          entry.timer = null;
          entry.inFlight = false;
          entry.pending = null;
          entry.promptPartID = null;
        }
        unpark(sessionID);
      }
      let session = sessions.get(sessionID);
      if (!session) {
        try { session = await getSession(sessionID); } catch {}
      }
      checkContinuation?.();
      // ☠️ input.agent is the agent the CALLER named, which a headless `opencode run` without
      // --agent leaves undefined: opencode resolves its default agent onto the user message
      // (output.message.agent) only after this input is built. A fresh session's record may not
      // carry the agent yet either, so without the message's own field the lease fell through
      // to the default tier -- measured 2026-09-21: four headless `smart` runs, all leased
      // `worker`, with no smart-tier request ever reaching the broker.
      const messageAgent = typeof output?.message?.agent === "string" && output.message.agent ? output.message.agent : null;
      const agent = typeof input?.agent === "string" && input.agent ? input.agent : messageAgent ?? session?.agent;
      // Detect high-risk content in THIS user message and set the tier floor
      // before routing. A raised floor forces a re-lease (drop the cached
      // route) so an in-progress low-tier session escalates immediately.
      const messageText = (Array.isArray(output?.parts) ? output.parts : [])
        .filter((part) => part?.type === "text" && part.synthetic !== true)
        .map((part) => part.text).filter((text) => typeof text === "string").join("\n");
      let floor = highRiskTier(messageText); // safety escalation applies in every mode
      // Switch mode is gone (0.53.0), and with it the lifts that only ever ran in its
      // "automatic" setting, which no session used (Off was the deliberate default).
      // Escalation is by SEAT: a controller re-dispatches blocked work to `deep`, and
      // plan-run does so on its own in fix rounds 4-5. The safety floor above is the bump.
      // Set the floor; route() applies it on this turn's (re)lease via
      // raiseTier. Do NOT delete the cached route to force a re-lease -- that
      // raced chat.params into "route unavailable; resend the prompt". A false
      // positive is now harmless (served on a stronger model), never a break.
      if (floor) riskFloors.set(sessionID, floor);
      else riskFloors.delete(sessionID);
      const currentModel = input?.model?.providerID && input?.model?.id
        ? { providerID: input.model.providerID, id: input.model.id, ...(typeof input.model.variant === "string" && input.model.variant ? { variant: input.model.variant } : {}) }
        : output?.message?.model?.providerID && output?.message?.model?.modelID
          ? { providerID: output.message.model.providerID, id: output.message.model.modelID, ...(typeof output.message.model.variant === "string" && output.message.model.variant ? { variant: output.message.model.variant } : {}) }
          : null;
      // ☠️ A SYNTHETIC PROMPT DOES NOT PICK A MODEL EITHER. A background-job notice, a
      // re-engage or an oc_send names no model, so opencode stamps it with the pane's default,
      // and passing that on as the session's preference re-leased a ROOT onto it. Measured
      // 2026-09-28: a job notice stamped Opus moved a gpt-5.6-sol session to
      // claude-opus-5 while the pane still showed Sol, and each side's next turn then failed
      // "routed model mismatch" in turn. ensure() already keeps a subagent on its route for
      // the same reason; a prompt with no user-authored text keeps the root on its route too.
      const routedModel = routes.get(sessionID)?.target?.model;
      // A content-filter re-prompt must NOT prefer the last routed model -- that is the model
      // the provider just blocked. Drop the preference entirely so route()'s cascade branch
      // asks the broker for the next candidate (the only override of the syntheticOnly rule).
      const preferredModel = cfReprompt
        ? null
        : syntheticOnly && routedModel?.providerID && routedModel?.id
          ? { providerID: routedModel.providerID, id: routedModel.id, ...(typeof routedModel.variant === "string" && routedModel.variant ? { variant: routedModel.variant } : {}) }
          : currentModel;
      const classifier = isClassifierAgent(agent);
      if (classifier) {
        try { removeSessionProfile(sessionID); } catch {}
      }
      const owner = classifier
        ? resolveProfile({ sessionID, parentID: session?.parentID })
        : null;
      const resolved = classifier
        ? { profile: "auto", explicit: false }
        : resolveProfile({ sessionID, parentID: session?.parentID, agent });
      if (classifier || resolved.profile === "manual") cancelRecovery(sessionID);
      let turnEffort = null;
      const isCompaction = agent === "compaction";
      if (!syntheticOnly && messageText && resolved.profile !== "manual") {
        try {
          let riskRaisedTier = false;
          if (!classifier && floor && session?.id) {
            const baseTier = await routeTierForSession({
              agent,
              parentID: session.parentID,
              sessionID,
              routes,
              sessions,
              getSession,
            });
            riskRaisedTier = raiseTier(baseTier, floor) !== baseTier;
          }
          turnEffort = classifyTurn({
            text: messageText,
            isSubagent: !session?.id || Boolean(session.parentID),
            riskFloor: floor,
            riskRaisedTier,
            previous: previousTurnClasses.get(sessionID),
          });
        } catch (error) {
          // Classification must never block routing a user turn.
          report("warn", "turn effort classification failed", error);
          turnEffort = { class: "normal", reason: "classifier-error" };
        }
        if (!isCompaction) {
          previousTurnClasses.set(sessionID, nextPrevious(previousTurnClasses.get(sessionID), turnEffort));
          trimTracker(previousTurnClasses);
          // Remember the applied effort so a later content-filter cascade re-prompt (synthetic, so
          // the classifier above is skipped) can CARRY it instead of re-leasing variant-less.
          lastTurnEffort.set(sessionID, turnEffort);
          trimTracker(lastTurnEffort);
        }
      }
      // ☠️ CARRY THE EFFORT ONTO A CONTENT-FILTER CASCADE RE-PROMPT. It is synthetic, so turnEffort
      // stayed null above -> the lease would omit turnClass, the engine would apply no per-turn
      // effort to the re-prompt, and the variant-less turn would mismatch the cascade candidate the
      // broker leased at the session's STATIC effort (e.g. /high): the "routed model mismatch; resend"
      // the cascade death-looped on (petsafe, 2026-10-22: block -> cascade -> mismatch). Reuse the
      // BLOCKED turn's own effort so the cascade lease and the re-prompt turn apply the SAME variant
      // and chat.params's guard agrees -- carry the effort, never strip it.
      if (cfReprompt && !turnEffort) turnEffort = lastTurnEffort.get(sessionID) ?? null;
      // ☠️ Ask what the profile can REACH, not what it is called. A profile granted
      // `profileCloudEgress` is still one of the restrictive four by name while holding
      // a cloud fallback rung, and skipping admission work on the name would leave that
      // rung permanently unadmitted -- an opt-in that silently does nothing.
      const needsInventory = classifier
        ? !profileConfinesToLan(owner.profile) && classifierTierReachesCloud()
        : profileReachesCloud(resolved.profile);
      if (needsInventory) {
        try {
          await refreshInventory();
        } catch (error) {
          if (!isAuthRevisionRaceError(error)) throw error;
          await refreshInventory();
        }
      }
      let routed;
      try {
        routed = await serialRoute(sessionID, () => ensure(sessionID, agent, preferredModel, turnEffort, checkContinuation, cfReprompt), { continuation: ownContinuation });
      } catch (error) {
        if (!needsInventory || (!/provider inventory is stale/.test(String(error?.message ?? error)) && !isAuthRevisionRaceError(error))) throw error;
        await refreshInventory();
        routed = await serialRoute(sessionID, () => ensure(sessionID, agent, preferredModel, turnEffort, checkContinuation, cfReprompt), { continuation: ownContinuation });
      }
      checkContinuation?.();
      applyMessageModel(output?.message, routed, sessionID);
      // The forked engine reads this field and binds the turn to it. A pane still running
      // stock 1.18.22 ignores it and relies on the mutation above. Ceiling: drop the
      // mutation once every pane runs the fork.
      applyOutputModel(output, routed);
      const recovery = reengagements.get(sessionID);
      if (recovery) recovery.route = routed;
    },
    // Cache lifetime hint for claude-proxy, matching what Claude Code does on the same plan:
    // a ROOT session can sit idle for many minutes (a human thinking, or a parent waiting on
    // a subagent) and gets the 1-hour cache; a SUBAGENT runs back to back and then ends, so the
    // 5-minute cache is enough and its writes cost 1.25x instead of 2x. Measured over 60k Claude
    // Code requests on 2026-09-28: 97% of main-session writes were 1h, 99.9% of subagent writes
    // 5m. Only sent to the anthropic provider (the proxy); an unknown session sends nothing and
    // the proxy keeps the safe 1-hour default.
    // The same session id, plus the turn's lease id, is how the fleet gateway recognizes a
    // request this plugin already routed: it forwards on that exact lease instead of leasing
    // again from its own default tier. Sent for both subscription providers behind the gateway.
    "chat.headers": async (input, output) => {
      if (!GATEWAY_BOUND_PROVIDERS.has(input?.model?.providerID) || !input?.sessionID || !output?.headers) return;
      // Lets the proxy's prompt fingerprints compare consecutive requests of one session, and the
      // gateway find the lease below. Set before the session lookup, which can fail.
      output.headers["x-opencode-session-id"] = input.sessionID;
      const leaseID = routes.get(input.sessionID)?.leaseID;
      if (typeof leaseID === "string" && leaseID) output.headers["x-opencode-lease-id"] = leaseID;
      let session = sessions.get(input.sessionID);
      if (!session) {
        try { session = await getSession(input.sessionID); } catch { return; }
      }
      if (!session?.id) return;
      output.headers["x-opencode-session-kind"] = session.parentID ? "subagent" : "primary";
    },
    "chat.params": async (input) => {
      const sessionID = input?.sessionID;
      if (!sessionID) return;
      engineEffortUpdates.set(sessionID, input.effortUpdates === true);
      trimTracker(engineEffortUpdates);
      // ☠️ opencode's own small-model calls are not the conversation's turn. Title generation
      // runs on the configured `small_model`, fires chat.params with agent "title" and the
      // session's id, and never passes through chat.message -- so it has no route of its own,
      // and checking it against the CONVERSATION's route rejected it as a mismatch whenever
      // the session was on any other model. Measured: 60 of 69 root sessions in a week kept
      // opencode's placeholder title. The small model is the deployment's explicit choice
      // (point it at the gateway to have it leased and counted), so it passes untouched.
      if (SMALL_MODEL_AGENTS.has(input?.agent)) return;
      const routed = routes.get(sessionID);
      if (!routed) throw new Error("[opencode-broker] route unavailable; resend the prompt");
      const providerID = routed?.target?.model?.providerID;
      const modelID = routed?.target?.model?.modelID ?? routed?.target?.model?.id;
      const variant = routed?.target?.model?.variant;
      if (!providerID || !modelID) return;
      // chat.params `input.model` is the CATALOG model: it carries a `variants`
      // map, never a selected `variant`. The variant actually applied to this
      // request was read from the user message's model ref before this hook
      // fired, so that ref -- not the catalog object -- is what must match the
      // lease. Comparing input.model.variant here death-looped every
      // variant-carrying lease: the field is always undefined.
      const actualVariant = input?.message?.model?.variant ?? undefined;
      if (input?.model?.providerID !== providerID || input?.model?.id !== modelID ||
        actualVariant !== (variant ?? undefined)) {
        const displaced = displacedModels.get(sessionID);
        if (input?.agent === "compaction" &&
          input?.model?.providerID === displaced?.providerID &&
          input?.model?.id === displaced?.modelID &&
          actualVariant === (displaced?.variant ?? undefined)) return;
        throw new Error(`routed model mismatch: expected ${providerID}/${modelID}${variant ? `/${variant}` : ""}, got ${input?.model?.providerID}/${input?.model?.id}${actualVariant ? `/${actualVariant}` : ""}; resend the prompt`);
      }
    },
    event: async ({ event }) => {
      const properties = event?.properties ?? {};
      const sessionID = extractSessionID(properties, { lifecycle: sessionLifecycleTypes.has(event?.type) });
      if (event?.type === "session.created") {
        const info = properties.info ?? sessions.get(sessionID) ?? (sessionID ? await getSession(sessionID) : null);
        if (info?.id) {
          const knownSession = sessions.has(info.id);
          sessions.set(info.id, info);
          // Repeated metadata notifications must not erase current ownership.
          if (!recoveryAttribution.has(info.id)) {
            setRecoveryAttribution(info.id, newRecoveryAttribution(knownSession));
          }
          // ☠️ A classifier lane session gets NO profile record. This line is where the
          // guard's child used to ACQUIRE its parent's `uncensored`: resolveProfile
          // inherits from the parent, and this made that inheritance the child's own, on
          // disk, for two weeks.
          // ☆ resolveProfile checks the lane before any record, so a child whose
          // session.created arrived without an agent (they are not consistent about it)
          // still routes correctly on the authoritative agent chat.message carries.
          // This guard stops the record existing; the resolution ORDER is what makes it
          // safe when the guard cannot fire.
          if (!isClassifierAgent(info.agent)) {
            // A profile chosen on the START SCREEN, where no session exists yet, is armed
            // as a one-shot record and lands HERE: on the first ROOT session created after
            // it, and only that one. Consuming deletes it, so everything after this session
            // is `auto` again unless it is armed again or set per session.
            // ☆ Root only. A child inherits its parent's profile through resolveProfile,
            // so letting a spawned subagent eat the arming record would both misdirect the
            // choice and leave the session the person was actually starting on the default.
            const armed = info.parentID ? null : consumePendingProfile();
            const profile = armed
              ? { profile: armed.profile, explicit: true }
              : resolveProfile({ sessionID: info.id, parentID: info.parentID, agent: info.agent });
            writeSessionProfile(info.id, profile.profile, { explicit: profile.explicit });
            if (armed) {
              report("info", `${info.id}: applied the armed routing profile "${armed.profile}" to THIS session only`);
            }
          }
        }
        return;
      }
      if (!sessionID) return;
      if (event?.type === "session.deleted") {
        clearLocalChildInactivityWatchdog(sessionID);
        clearLocalChildInFlightTools(sessionID);
        unpark(sessionID);
        unwatchFallback(sessionID);
        cancelRecovery(sessionID);
        recoveryAttribution.delete(sessionID);
        displacedModels.delete(sessionID);
        try { removeFallbackMarker(sessionID); } catch {}
        await cleanupDeletedSession({
          sessionID,
          routes,
          sessions,
          successCandidates,
          contextSizes,
          stopHeartbeat,
          removeSessionProfile,
          removeSessionContextEstimate,
          writePendingForgetRecord,
          removePendingForgetRecord,
          brokerRequest,
        });
        return;
      }
      // A long provider retry wait is a stop in everything but name: the host
      // parks the turn against the SAME model until the provider's window
      // resets, which for a plan limit is hours. A fleet has other providers.
      // Abort the wait, report the failure (opening the circuit), and re-engage
      // on the next best lease.
      const observableStatusError = providerErrorFrom(
        properties.error,
        properties.message?.error,
        properties.part?.error,
        properties.info?.error,
        properties.data?.error,
        properties.session?.error,
      );
      // Stop/Abort is intentionally processed before attribution filtering.
      if (isAbortError(observableStatusError)) {
        clearLocalChildInactivityWatchdog(sessionID);
        clearLocalChildInFlightTools(sessionID);
        stopHeartbeat(sessionID);
        successCandidates.delete(sessionID);
        // The user stopped it on purpose: it must not come back on its own -- unless this abort
        // is the content-filter failover's OWN (it ends the blocked turn before re-prompting),
        // which keepContentFilter spares so the episode can still fire its next candidate.
        unpark(sessionID);
        unwatchFallback(sessionID);
        cancelRecovery(sessionID, { keepContentFilter: cfFailover.get(sessionID)?.reprompting === true });
        return;
      }
      if (event?.type === "session.status") {
        const status = properties.status ?? properties.info?.status;
        if (status?.type === "retry" && unattributableToActiveTurn(sessionID, null)) {
          report("info", `${sessionID}: ignoring unattributable provider retry after recovery supersession`);
          return;
        }
        if (status?.type === "retry" && routes.get(sessionID)?.target?.id) {
          const now = Date.now();
          const waitMs = Number(status.next) - now;
          let waits = (retryWaits.get(sessionID) ?? []).filter((w) => now - w.at < RETRY_WINDOW_MS);
          if (Number.isFinite(waitMs) && waitMs > 0) waits = [...waits, { at: now, waitMs }];
          retryWaits.set(sessionID, waits);
          trimTracker(retryWaits);
          const parkedMs = waits.reduce((total, w) => total + w.waitMs, 0);
          const singleTooLong = Number.isFinite(waitMs) && waitMs > RETRY_WAIT_FAILOVER_MS;
          const parkedTooLong = parkedMs > RETRY_WAIT_CUMULATIVE_MS;
          if (singleTooLong || parkedTooLong) {
            const failedRoute = routes.get(sessionID);
            const targetID = failedRoute.target.id;
            const leaseID = failedRoute.leaseID;
            const classifier = isClassifierAgent(sessions.get(sessionID)?.agent);
            const recovery = ownRecovery(sessionID, failedRoute);
            const generation = recovery?.generation;
            retryWaits.delete(sessionID);
            if (!singleTooLong) {
              report("warn", `${sessionID}: ${waits.length} provider retries totalling ${Math.round(parkedMs / 1000)}s within ${RETRY_WINDOW_MS / 1000}s -- failing over from ${targetID}`);
            }
            clearLocalChildInactivityWatchdog(sessionID);
            clearLocalChildInFlightTools(sessionID);
            stopHeartbeat(sessionID);
            routes.delete(sessionID);
            successCandidates.delete(sessionID);
            let failure = null;
            try {
              failure = await brokerRequest("/failure", {
                sessionID,
                ...(leaseID ? { leaseID } : {}),
                targetID,
                error: { message: String(status.message ?? (singleTooLong
                  ? "provider retry wait exceeded failover threshold"
                  : `provider retry waits totalled ${Math.round(parkedMs / 1000)}s within the failover window`)) },
              });
            } catch {}
            if (!classifier && currentRecovery(sessionID, recovery, generation)) {
              markDisplaced(sessionID, targetID, failure);
              try { await client.session.abort({ path: { id: sessionID }, query: { directory } }); } catch {}
              if (!currentRecovery(sessionID, recovery, generation)) return;
              const retryError = { message: String(status.message ?? ""), statusCode: status.statusCode };
              scheduleReengage(sessionID, failure?.kind ?? continuationKind(retryError, failedRoute), retryError);
            }
            return;
          }
        }
      }
      const error = providerErrorFrom(
        properties.error,
        properties.message?.error,
        properties.part?.error,
        properties.info?.error,
        properties.data?.error,
        properties.session?.error,
      );
      const errorEvent = event?.type === "session.error" ||
        (["session.updated", "message.updated", "message.part.updated", "session.status"].includes(event?.type) && Boolean(error));
      if (errorEvent && isAbortError(error)) {
        // A user abort ends the turn but indicts nobody: keep the route and lease so the
        // next prompt stays on the same target instead of triggering a failover re-lease.
        clearLocalChildInactivityWatchdog(sessionID);
        clearLocalChildInFlightTools(sessionID);
        stopHeartbeat(sessionID);
        successCandidates.delete(sessionID);
        // The user stopped it on purpose: it must not come back on its own.
        unpark(sessionID);
        unwatchFallback(sessionID);
        // There is no correlation ID distinguishing a router abort from Stop.
        // Safety wins: ANY observable abort cancels, even a delayed internal one -- EXCEPT the
        // content-filter failover's own abort (reprompting), which keepContentFilter spares so
        // the episode can still fire its next candidate.
        cancelRecovery(sessionID, { keepContentFilter: cfFailover.get(sessionID)?.reprompting === true });
        return;
      }
      if (errorEvent && unattributableToActiveTurn(sessionID, messageRecordFrom(properties))) {
        report("info", `${sessionID}: ignoring unattributable provider error after recovery supersession`);
        return;
      }
      // ☠️ A CONTENT-FILTER BLOCK CAN ARRIVE AS AN ERROR, NOT A CLEAN FINISH. The gateway only
      // strips a provider content-filter block to a clean `content-filter` finish (no error) on a
      // BUFFERED lane; on a STREAMING turn OpenCode attaches a ContentFilterError and the completed
      // message carries BOTH `finish: "content-filter"` AND that error. With the error present the
      // event registers as an errorEvent, so the clean-finish failover below (gated on `!error`,
      // message.updated branch) is never reached -- the turn would take the generic /failure +
      // scheduleReengage path and re-lease the SAME model, which just re-blocks (petsafe, streaming
      // Opus 5.5: blocked repeatedly, 0 cascade leases, 2026-10-22). Route it to the cascade here,
      // mirroring the clean path's cancelRecovery(keepContentFilter) + beginContentFilterFailover.
      // ☆ beginContentFilterFailover self-guards (manual/classifier/llamacpp/parked) and is bounded
      // (CF_MAX_ATTEMPTS/CF_WINDOW_MS), so this widens no reach; it only changes WHICH recovery path
      // a content-filter block takes. The abort and unattributable-error checks above already ran,
      // so by here this is a block attributed to the active turn, never a user Stop. (recovery/
      // generation are not yet in scope here -- they are defined inside the generic errorEvent
      // block below -- and are not needed: attribution is already established.)
      if (errorEvent && error?.name === "ContentFilterError") {
        cancelRecovery(sessionID, { keepContentFilter: true });
        beginContentFilterFailover(sessionID, messageRecordFrom(properties));
        return;
      }
      // ☠️ CHARGE THE FAILURE TO THE PROVIDER THAT ACTUALLY ANSWERED, OR TO NOBODY.
      // An assistant message carries the providerID that produced it, and when that
      // names a DIFFERENT provider than this session's lease, the error belongs to
      // some other lane -- a classifier or Task child whose error bubbled up here --
      // and reporting it against the lease indicts a provider that was never called.
      // On 2026-09-17 alibaba's "Not Found: Not support" was recorded against
      // local-coder that way, and it was half the evidence that quarantined llamacpp.
      // ☆ Positive proof only: both IDs must be present and differ. An unknown
      // providerID keeps the existing behaviour, so nothing that reports correctly
      // today stops reporting.
      // ☆ Keep the route and the lease, exactly like the abort branch above -- this
      // session's own target has done nothing wrong and its next prompt should stay
      // on it. The lane that really failed reports its own failure on its own lease.
      if (errorEvent) {
        const failedProvider = messageRecordFrom(properties)?.providerID;
        const leasedProvider = routes.get(sessionID)?.target?.model?.providerID;
        // ☆ This also covers the engine's overflow compaction failing on the DISPLACED local
        // model: charging that to the current lease would indict a provider that never served
        // the turn, and nothing is stranded -- the re-engage queued by the original overflow
        // still runs on the current lease once the failed compaction ends.
        if (typeof failedProvider === "string" && failedProvider &&
          typeof leasedProvider === "string" && leasedProvider &&
          failedProvider !== leasedProvider) {
          report("info", `${sessionID}: ignoring ${failedProvider} error on a ${leasedProvider} lease -- not this lane's fault`);
          return;
        }
      }
      if (errorEvent) {
        clearLocalChildInactivityWatchdog(sessionID);
        clearLocalChildInFlightTools(sessionID);
        stopHeartbeat(sessionID);
        const failedRoute = routes.get(sessionID);
        const ownedRoute = failedRoute ?? reengagements.get(sessionID)?.route;
        const failedTarget = failedRoute?.target;
        const failedLeaseID = failedRoute?.leaseID;
        const targetID = failedTarget?.id;
        const classifier = isClassifierAgent(sessions.get(sessionID)?.agent);
        const kind = continuationKind(error, ownedRoute);
        const usageRefusal = /usage limit reached -- /.test(String(error?.message ?? ""));
        // Cancel BOTH owners for a terminal failure, even if its route was already
        // deleted. The gateway's no-lane refusal is the existing park exception.
        if (classifier || ownedRoute?.profile === "manual" || (!usageRefusal && !transientContinuation(kind, error))) {
          cancelRecovery(sessionID);
        }
        const recovery = !classifier && (usageRefusal || transientContinuation(kind, error))
          ? ownRecovery(sessionID, ownedRoute) : null;
        const generation = recovery?.generation;
        const message = messageRecordFrom(properties);
        const messageID = message?.role === "assistant" && typeof message.id === "string" ? message.id : null;
        if (recovery && messageID) {
          if (recovery.messages.has(messageID)) return;
          recovery.messages.add(messageID);
          if (recovery.messages.size > 128) recovery.messages.delete(recovery.messages.values().next().value);
        }
        // Latch before /failure: prompt acceptance can resolve while this report
        // is pending. Readiness prevents a retry outrunning its circuit report.
        const pending = recovery && !usageRefusal && recovery.timer === null
          ? (recovery.pending ??= { kind, error, ready: false }) : null;
        const failedModel = failedTarget?.model;
        const failedModelID = failedModel?.modelID ?? failedModel?.id;
        displacedModels.delete(sessionID);
        if (typeof failedModel?.providerID === "string" && failedModel.providerID &&
          typeof failedModelID === "string" && failedModelID) {
          displacedModels.set(sessionID, {
            providerID: failedModel.providerID,
            modelID: failedModelID,
            ...(typeof failedModel.variant === "string" && failedModel.variant ? { variant: failedModel.variant } : {}),
          });
          trimTracker(displacedModels);
        }
        routes.delete(sessionID);
        successCandidates.delete(sessionID);
        let failure = null;
        try { failure = await brokerRequest("/failure", {
          sessionID,
          ...(failedLeaseID ? { leaseID: failedLeaseID } : {}),
          ...(targetID ? { targetID } : {}),
          error,
        }); } catch {}
        // A provider's own usage-limit error ("The usage limit has been reached") names no
        // return time, and opencode shows it as-is. The broker's quota circuit knows when the
        // limit lifts, so say it, with the day: a weekly limit can be days out.
        if (failure?.kind === "quota" && typeof failedModel?.providerID === "string") {
          // resetKnown: false means circuitUntil is only the broker's next probe, not a return date.
          const until = failure.resetKnown === false ? NaN : Number(failure.circuitUntil);
          const line = describeProviderLimit({
            providerID: failedModel.providerID,
            until: Number.isFinite(until) && until > Date.now() ? until : null,
          });
          report("warn", `${sessionID}: usage limit reached -- ${line}`);
          try {
            client?.tui?.showToast?.({ body: { message: `Usage limit reached: ${line}`, variant: "warning", duration: 15000 }, query: { directory } })
              ?.catch?.(() => {});
          } catch {}
        }
        // The gateway's usage-limit refusal (lib/usage-limit.js wording) is a noop to the broker --
        // no provider is at fault -- so no failover follows it; the session would just stop. Park
        // it like a refused lease, to resume when its lane can be served again.
        if (usageRefusal && currentRecovery(sessionID, recovery, generation) && ownedRoute?.tier) {
          parkSession(sessionID, {
            profile: ownedRoute.profile,
            tier: ownedRoute.tier,
            agent: recovery.agent,
            reason: "usage-limit",
          });
          return;
        }
        // A context-overflow error names the real request size. Record it so
        // the re-lease cannot land back on the too-small model.
        const overflow = /\((\d+)\s*tokens?\)\s*exceeds the (?:available )?context (?:size|length|window)/i
          .exec(String(error?.message ?? ""));
        if (overflow && Number(overflow[1]) > 0) {
          bumpContextSize(sessionID, Number(overflow[1]));
        }
        // Seamless failover: only sessions this plugin actually routed, and
        // never for user aborts -- those end turns on purpose.
        if (currentRecovery(sessionID, recovery, generation)) {
          markDisplaced(sessionID, targetID, failure);
          // Local context and broken-stream retryability are plugin decisions, not
          // changes to the broker's context/other circuit classifications.
          const brokerKind = failure?.kind ?? kind;
          // The broker answers a no-live-lease refusal "noop" (correctly: it indicts nothing),
          // while the plugin treats it as failover-eligible "relocate". Keep the plugin kind
          // over that "noop" ONLY -- any other broker verdict (auth, payload, model ...) still
          // wins, or scheduleReengage's re-check would cancel recovery on the broker's "noop".
          const failureKind = (brokerKind === "context" && kind === "context-local") ||
            (brokerKind === "other" && kind === "connect") ||
            (brokerKind === "noop" && kind === "relocate") ? kind : brokerKind;
          if (pending) pending.ready = true;
          scheduleReengage(sessionID, failureKind, error);
        }
        return;
      }
      if (event?.type === "message.updated") {
        const record = messageRecordFrom(properties);
        if (record?.role === "assistant" && typeof record.id === "string" &&
          typeof record.providerID === "string" && record.providerID) {
          messageModels.set(record.id, { providerID: record.providerID, modelID: record.modelID });
          trimTracker(messageModels);
        }
        if (isCompletedAssistantMessage(properties) && !error && attributedToActiveTurn(sessionID, record)) {
          // Match the engine's terminal finish semantics. A compaction summary is
          // a completed message, NOT completion of the conversation it summarizes.
          if (record.summary !== true && record.finish && !["tool-calls", "unknown"].includes(record.finish)) {
            if (record.finish === "content-filter") {
              // A provider content-filter block: fail THIS turn over to the next cascade
              // model instead of stopping. The ONLY content-filter-specific path; every other
              // finish takes the unchanged cancelRecovery branch below. keepContentFilter
              // still cancels a stale outage reengagement (as a terminal finish always did)
              // but keeps this episode's tried/history so a chained block can advance.
              cancelRecovery(sessionID, { keepContentFilter: true });
              beginContentFilterFailover(sessionID, record);
            } else {
              cancelRecovery(sessionID);
            }
          }
          // Track context size for every session, routed or not: a manual session that
          // later flips to auto must not start from an unknown (permissive) estimate.
          const total = contextTokensOf(record);
          if (total) bumpContextSize(sessionID, total);
        }
      }
      if (event?.type === "message.part.updated") {
        // One step-finish part = one provider request, with that step's token usage.
        // Reported for every session (manual and local profiles too — their spend burns
        // the same subscription windows the balancer is equalizing).
        const part = properties.part ?? properties.info ?? properties;
        if (part?.type === "step-finish" && sessionID) restoreAtStepBoundary(sessionID, part.reason);
        if (part?.type === "step-finish" && typeof part.id === "string" &&
          part.tokens && typeof part.tokens === "object" && !reportedSteps.has(part.id)) {
          const model = messageModels.get(part.messageID);
          if (model?.providerID) {
            reportedSteps.add(part.id);
            trimTracker(reportedSteps);
            // Fire-and-forget. ☠️ The root resolution MUST NOT await here: the event
            // handler must return immediately so step-finish processing is not held up
            // by broker or session-API latency. The whole chain (resolveRootSessionID
            // then POST /usage then burn-stop handling) runs detached.
            Promise.resolve().then(async () => {
              // Bounded resolve: a hung session.get must not hold the /usage report
              // (and its burn.stop reply) hostage. On timeout the field is omitted and
              // the broker counts the session as its own root; within the 60 s failure
              // TTL later steps short-circuit on the negative memo (set by the walk's
              // own per-hop timeout) instead of re-walking.
              const rootSessionID = await resolveRootSessionIDBounded(sessionID);
              return brokerRequest("/usage", {
                sessionID,
                // Omitted when the walk failed (the broker falls back to self-root).
                ...(rootSessionID && rootSessionID !== sessionID ? { rootSessionID } : {}),
                ...(routes.get(sessionID)?.leaseID ? { leaseID: routes.get(sessionID).leaseID } : {}),
                providerID: model.providerID,
                modelID: model.modelID,
                observedAt: Date.now(),
                requests: 1,
                tokens: {
                  input: Number(part.tokens.input) || 0,
                  output: Number(part.tokens.output) || 0,
                  cacheRead: Number(part.tokens.cache?.read) || 0,
                  cacheWrite: Number(part.tokens.cache?.write) || 0,
                },
              });
            }).then((reply) => {
              // The broker's burn watch (lib/burn-watch.js) judged this session a runaway.
              // This process owns it, so this is the one place that can stop it: abort the
              // turn and say why. Nothing is deleted, and continuing is the person's call.
              if (!reply?.burn?.stop || isClassifierAgent(sessions.get(sessionID)?.agent)) return;
              report("warn", `burn watch stopped session ${sessionID}: ${reply.burn.reason}`);
              client.session.abort({ path: { id: sessionID }, query: { directory } }).catch(() => {});
              client?.tui?.showToast?.({
                body: {
                  title: "Burn watch stopped this session",
                  message: `${reply.burn.reason}. Nothing was lost; send a message to continue deliberately.`,
                  variant: "error",
                  duration: 30000,
                },
                query: { directory },
              })?.catch?.(() => {});
            }).catch(() => {});
          }
        }
      }
      if (!routes.has(sessionID) && event?.type !== "session.idle") return;
      if (localChildProgressEventTypes.has(event?.type)) rearmLocalChildInactivityWatchdog(sessionID);
      if (event?.type === "session.status" && properties.status?.type === "busy") {
        successCandidates.delete(sessionID);
        try { await brokerRequest("/touch", { sessionID }); } catch {}
        startHeartbeat(sessionID);
        return;
      }
      if (event?.type === "message.updated" && isCompletedAssistantMessage(properties) && !error) {
        if (attributedToActiveTurn(sessionID, messageRecordFrom(properties))) {
          successCandidates.set(sessionID, true);
          displacedModels.delete(sessionID);
          retryWaits.delete(sessionID);
        }
        return;
      }
      if (event?.type === "message.part.updated" && error) {
        successCandidates.delete(sessionID);
        return;
      }
      if (event?.type === "session.idle") {
        if (unattributableToActiveTurn(sessionID, null) && successCandidates.get(sessionID) !== true) {
          report("info", `${sessionID}: ignoring unattributable session idle after recovery supersession`);
          return;
        }
        const leaseID = routes.get(sessionID)?.leaseID;
        clearLocalChildInactivityWatchdog(sessionID);
        clearLocalChildInFlightTools(sessionID);
        stopHeartbeat(sessionID);
        // The turn is over: the next prompt re-leases, and the fallback marker makes that
        // lease drop its preference for the fallback model.
        unwatchFallback(sessionID);
        const completed = successCandidates.get(sessionID) === true;
        try { await brokerRequest("/forget", {
          sessionID,
          ...(leaseID ? { leaseID } : {}),
          ...(completed ? { completed: true } : {}),
        }); } catch {
          try { writePendingForgetRecord(sessionID, { leaseID, completed }); } catch {}
        } finally {
          // A progress event delivered while /forget was in flight re-armed the watchdog against
          // the route that is deleted here.
          clearLocalChildInactivityWatchdog(sessionID);
          routes.delete(sessionID);
          successCandidates.delete(sessionID);
          retryWaits.delete(sessionID);
        }
        return;
      }
    },
    // A compacted session can read as "task done", and the agent then stops on the
    // synthetic continue turn instead of finishing. Steer the summary to carry the
    // unfinished work forward -- the goal, open TODOs, and the immediate next step --
    // so the post-compaction turn RESUMES the task.
    "experimental.session.compacting": async (input, output) => {
      const sessionID = extractSessionID(input);
      if (!sessionID) return;
      output.context = [
        ...(output.context ?? []),
        "This session is being compacted mid-task, not finished. In the summary, explicitly preserve the current goal, every incomplete step and open TODO, and the immediate next action -- and do NOT imply the task is complete. After compaction, continue the unfinished work; do not stop or hand a summary back to the user until the goal is actually met.",
      ];
      clearLocalChildInactivityWatchdog(sessionID);
    },
    // Successful compaction is recovery, not task failure. Resume every session,
    // including local children, and restart their suspended inactivity watchdog.
    "experimental.compaction.autocontinue": async (input, output) => {
      const sessionID = extractSessionID(input);
      if (!sessionID) return;
      output.enabled = true;
      rearmLocalChildInactivityWatchdog(sessionID);
    },
  };
};
