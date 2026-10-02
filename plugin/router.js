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
  const riskFloors = new Map(); // sessionID -> minimum tier for high-risk content
  const sessions = new Map();
  const successCandidates = new Map();
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
      try {
        const aborted = await client.session.abort({ path: { id: sessionID }, query: { directory } });
        if (aborted?.error) throw aborted.error;
      } catch (error) {
        report("error", `failed to abort local child ${sessionID} after inactivity watchdog failure`, error);
      }
      if (targetID && failure?.kind) {
        const circuitUntil = Number(failure.circuitUntil);
        const delay = !profileReachesCloud(routeProfile) && Number.isFinite(circuitUntil) && circuitUntil > Date.now()
          ? circuitUntil - Date.now() + 1
          : undefined;
        try { scheduleReengage(sessionID, failure.kind, delay); } catch (error) {
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
  };

  const route = async (session, preferredModel = null) => {
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
    let lease;
    try {
      const contextTokens = await sessionContextTokens(session.id);
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
      const leaseBody = {
        sessionID: session.id,
        profile: resolved.profile,
        tier,
        replace: true,
        ...(classifier ? { localOnly } : {}),
        ...(!classifier && !rebalanceFallback && seasoned && preferredModel?.providerID && preferredModel?.id ? { preferredModel } : {}),
        // The broker pins every session to its model; the one time this plugin WANTS the
        // session re-decided is restore-home after a displacement, so it says so.
        ...(restoreDue ? { releasePin: true } : {}),
        ...(marker?.policy === "strict-fallback" && typeof marker.targetID === "string" && marker.targetID
          ? { fallbackTargetID: marker.targetID }
          : {}),
        ...(contextTokens !== null && contextTokens !== undefined ? { contextTokens } : {}),
      };
      // ☠️ A WAIT IS NOT A FAILURE. `target-busy` (every slot of a resident local model is
      // taken) and `target-preparing` (the model is being swapped onto its card) both clear
      // on their own. Failing the prompt on them dropped the work; retrying finds the slot.
      // Bounded, so a wedged local host still surfaces as an error rather than a hang.
      const waitStarted = Date.now();
      let announced = false;
      for (;;) {
        try {
          lease = await brokerRequest("/lease", leaseBody);
          break;
        } catch (error) {
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
      if (localOnly && target.kind !== "local") {
        throw new Error(`broker returned non-local classifier target ${target.id ?? `${target.model.providerID}/${target.model.id}`} for a local-only lease`);
      }
      // A degraded route must be VISIBLE: log it where the opencode log shows it,
      // and mark it where the hud renders it. A non-fallback lease clears the mark.
      const policy = lease?.decision?.policy ?? null;
      if (policy === "strict-fallback") {
        report("warn", `${resolved.profile}/${tier} FALLBACK: leased ${target.id} (${target.model.providerID}/${target.model.id}) because no primary ${tier} target was eligible (${(lease.decision.reasons ?? []).join(", ") || "circuits/quota/health"})`);
        try { writeFallbackMarker(session.id, { policy, targetID: target.id, reasons: lease.decision.reasons }); } catch {}
      } else {
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
      // A replacement lease restarts the inactivity window unless a tool is still running.
      // A non-local replacement clears the prior watchdog before it can terminate the new route.
      rearmLocalChildInactivityWatchdog(session.id);
      return routed;
    } catch (error) {
      // Never bypass provider admission with a static fallback. A clear block is
      // safer than silently spending an API-key provider after broker failure.
      clearLocalChildInactivityWatchdog(session.id);
      routes.delete(session.id);
      failLease(classifier ? owner : resolved, error);
    }
  };

  // --- Seamless failover -------------------------------------------------
  // When a provider stops a session (plan window exhausted, model dead, long
  // retry park), the user must not have to come back and nudge it. The failure
  // report has already opened the circuit, so a fresh lease lands on the next
  // best target; what remains is re-running the loop. A synthetic user part
  // does exactly that -- and doubles as the transcript record of the reroute.
  const REENGAGE_TEXT = "[opencode-broker] The previous model hit a provider limit mid-turn and the session was rerouted to the next best model. Continue the task exactly where it stopped; do not restart completed work.";
  const REENGAGE_DELAY_MS = 2500;
  const REENGAGE_MAX_ATTEMPTS = 2;
  const REENGAGE_WINDOW_MS = 10 * 60 * 1000;
  const RETRY_WAIT_FAILOVER_MS = 30 * 1000;
  // A single long park is the obvious stop. The case that used to slip through is a
  // RUN of short ones: five 20s waits cost a session 100s parked against a provider
  // that is plainly struggling, and never trip a PER-WAIT threshold. Accumulate the
  // waits over a window and treat the total as the same signal.
  const RETRY_WAIT_CUMULATIVE_MS = 60 * 1000;
  const RETRY_WINDOW_MS = 5 * 60 * 1000;
  const retryWaits = new Map(); // sessionID -> [{ at, waitMs }]
  const reengageHistory = new Map();
  const scheduleReengage = (sessionID, kind, delay = REENGAGE_DELAY_MS) => {
    // ☠️ `payload` joins abort/noop: the provider refused the request as MALFORMED, so
    // re-sending the very same transcript is not a retry, it is the same failure again
    // one model over. That auto-resend is what walked a broken `tool_use`/`tool_result`
    // pair across two anthropic models in seven seconds on 2026-09-17 and handed the
    // health tracker the two distinct models a quarantine needs. The turn needs a human
    // (resend, compact, or /undo), not another lane.
    if (kind === "abort" || kind === "noop" || kind === "payload") return;
    const now = Date.now();
    const history = (reengageHistory.get(sessionID) ?? []).filter((at) => now - at < REENGAGE_WINDOW_MS);
    if (history.length >= REENGAGE_MAX_ATTEMPTS) {
      report("warn", `${sessionID}: not re-engaging after ${kind} -- ${history.length} recent attempts already`);
      return;
    }
    history.push(now);
    reengageHistory.set(sessionID, history);
    trimTracker(reengageHistory);
    const handle = scheduleTimeout(async () => {
      try {
        await client.session.prompt({
          path: { id: sessionID },
          query: { directory },
          // Carry the session's own agent: an agent-less prompt runs as the pane's default
          // (`smart`), which turned a re-engaged subagent into a primary on another tier.
          body: {
            ...(typeof sessions.get(sessionID)?.agent === "string" && sessions.get(sessionID).agent
              ? { agent: sessions.get(sessionID).agent }
              : {}),
            parts: [{ type: "text", text: REENGAGE_TEXT, synthetic: true }],
          },
        });
        report("info", `${sessionID}: re-engaged after ${kind} failure`);
      } catch (error) {
        report("error", `${sessionID}: re-engage failed`, error);
      }
    }, delay);
    if (typeof handle?.unref === "function") handle.unref();
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

  const ensure = async (sessionID, agentHint, preferredModel = null) => {
    if (!sessionID) return;
    let session = sessions.get(sessionID);
    try {
      // Session metadata is immutable for routing purposes. Fetch it only once when
      // a resumed session did not emit session.created in this plugin process.
      if (!session) session = await getSession(sessionID);
    } catch (error) {
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
    return route(session, preferredModel);
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
      if (sessionID) successCandidates.delete(sessionID);
      if (!sessionID) return;
      let session = sessions.get(sessionID);
      if (!session) {
        try { session = await getSession(sessionID); } catch {}
      }
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
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      const syntheticOnly = parts.some((part) => part?.type === "text" && part.synthetic === true) &&
        !parts.some((part) => part?.type === "text" && part.synthetic !== true);
      const routedModel = routes.get(sessionID)?.target?.model;
      const preferredModel = syntheticOnly && routedModel?.providerID && routedModel?.id
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
        routed = await ensure(sessionID, agent, preferredModel);
      } catch (error) {
        if (!needsInventory || (!/provider inventory is stale/.test(String(error?.message ?? error)) && !isAuthRevisionRaceError(error))) throw error;
        await refreshInventory();
        routed = await ensure(sessionID, agent, preferredModel);
      }
      applyMessageModel(output?.message, routed, sessionID);
      // The forked engine reads this field and binds the turn to it. A pane still running
      // stock 1.18.22 ignores it and relies on the mutation above. Ceiling: drop the
      // mutation once every pane runs the fork.
      applyOutputModel(output, routed);
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
        throw new Error(`routed model mismatch: expected ${providerID}/${modelID}${variant ? `/${variant}` : ""}, got ${input?.model?.providerID}/${input?.model?.id}${actualVariant ? `/${actualVariant}` : ""}; resend the prompt`);
      }
    },
    event: async ({ event }) => {
      const properties = event?.properties ?? {};
      const sessionID = extractSessionID(properties, { lifecycle: sessionLifecycleTypes.has(event?.type) });
      if (event?.type === "session.created") {
        const info = properties.info ?? sessions.get(sessionID) ?? (sessionID ? await getSession(sessionID) : null);
        if (info?.id) {
          sessions.set(info.id, info);
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
      if (event?.type === "session.status") {
        const status = properties.status ?? properties.info?.status;
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
            if (!classifier) {
              markDisplaced(sessionID, targetID, failure);
              try { await client.session.abort({ path: { id: sessionID }, query: { directory } }); } catch {}
              if (failure?.kind && failure.kind !== "abort") scheduleReengage(sessionID, failure.kind);
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
        const failedTarget = routes.get(sessionID)?.target;
        const failedLeaseID = routes.get(sessionID)?.leaseID;
        const targetID = failedTarget?.id;
        const failedOnLocal = failedTarget?.kind === "local" || modelIsLocalTarget(failedTarget?.model);
        const classifier = isClassifierAgent(sessions.get(sessionID)?.agent);
        routes.delete(sessionID);
        successCandidates.delete(sessionID);
        let failure = null;
        try { failure = await brokerRequest("/failure", {
          sessionID,
          ...(failedLeaseID ? { leaseID: failedLeaseID } : {}),
          ...(targetID ? { targetID } : {}),
          error,
        }); } catch {}
        // A context-overflow error names the real request size. Record it so
        // the re-lease cannot land back on the too-small model.
        const overflow = /\((\d+)\s*tokens?\)\s*exceeds the (?:available )?context (?:size|length|window)/i
          .exec(String(error?.message ?? ""));
        if (overflow && Number(overflow[1]) > 0) {
          bumpContextSize(sessionID, Number(overflow[1]));
        }
        // Seamless failover: only sessions this plugin actually routed, and
        // never for user aborts -- those end turns on purpose.
        if (!classifier && targetID && failure?.kind && failure.kind !== "abort") {
          markDisplaced(sessionID, targetID, failure);
          // ☠️ A CLOUD CONTEXT OVERFLOW IS NOT A LANE TO FAIL OVER FROM. Re-engaging exists
          // to lift a session off a small LOCAL window; a cloud lane that says "prompt is
          // too long" is answering for a transcript no sibling lane holds either, and the
          // host is already compacting it. On 2026-09-21 a 1.34M-token session on a 1M
          // anthropic lane was re-prompted three times in eight minutes, each prompt
          // riding another ~0.9M-token compaction -- 8% of the plan in five minutes.
          if (failure.kind === "context" && !failedOnLocal) {
            report("warn", `${sessionID}: not re-engaging after a context overflow on cloud target ${targetID} -- compaction or a human owns this turn`);
            return;
          }
          scheduleReengage(sessionID, failure.kind);
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
        if (isCompletedAssistantMessage(properties) && !error) {
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
        successCandidates.set(sessionID, true);
        retryWaits.delete(sessionID);
        return;
      }
      if (event?.type === "message.part.updated" && error) {
        successCandidates.delete(sessionID);
        return;
      }
      if (event?.type === "session.idle") {
        const leaseID = routes.get(sessionID)?.leaseID;
        clearLocalChildInactivityWatchdog(sessionID);
        clearLocalChildInFlightTools(sessionID);
        stopHeartbeat(sessionID);
        const completed = successCandidates.get(sessionID) === true;
        try { await brokerRequest("/forget", {
          sessionID,
          ...(leaseID ? { leaseID } : {}),
          ...(completed ? { completed: true } : {}),
        }); } catch {
          try { writePendingForgetRecord(sessionID, { leaseID, completed }); } catch {}
        } finally {
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
