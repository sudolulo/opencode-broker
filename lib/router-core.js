// Routing and session-event helpers for the router plugin. They live
// outside the plugin entry because OpenCode invokes every export of a plugin module
// as a plugin factory; a helper exported there gets called with the plugin input and
// its return value is registered as a hooks object, poisoning every hook trigger.
import { inheritsParentTier, markManagedModelSwitch, tierForAgent } from "./routing.js";

const validRouteTier = (tier) => tier === "deep" || tier === "smart" || tier === "build" || tier === "fast-build" || tier === "review" || tier === "worker";

export const routeTierForSession = async ({ agent, parentID, sessionID, routes, sessions, getSession } = {}) => {
  // Compaction summarizes the WHOLE conversation, so it MUST run on a model that
  // fits the session's context. The turn's agent is "compaction", which would
  // fall through to the small local worker -- where a large session cannot
  // compact its way out and the session STOPS. Ride the tier the session is
  // already on (that model necessarily fits), else its stored agent's tier,
  // never worker/local.
  if (agent === "compaction") {
    const cached = routes?.get(sessionID)?.tier;
    if (validRouteTier(cached)) return cached;
    let own = sessionID ? sessions?.get(sessionID) : null;
    if (!own && sessionID && typeof getSession === "function") own = await getSession(sessionID);
    if (own?.agent && own.agent !== "compaction") return tierForAgent(own.agent);
    return "build"; // safe large-context default; never the local worker
  }
  if (!inheritsParentTier(agent)) return tierForAgent(agent);

  const directParentTier = validRouteTier(routes?.get(parentID)?.tier) ? routes.get(parentID).tier : null;
  if (directParentTier) return tierForAgent(agent, { parentTier: directParentTier });

  let parent = parentID ? sessions?.get(parentID) : null;
  if (!parent && parentID && typeof getSession === "function") {
    parent = await getSession(parentID);
    if (parent?.id && sessions?.set) sessions.set(parent.id, parent);
  }
  if (!parent?.id) return "worker";

  const cachedParentTier = validRouteTier(routes?.get(parent.id)?.tier) ? routes.get(parent.id).tier : null;
  const parentTier = cachedParentTier ?? tierForAgent(parent.agent);
  return tierForAgent(agent, { parentTier });
};

export const extractSessionID = (value, { lifecycle = false, depth = 0 } = {}) => {
  if (!value || depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const sessionID = extractSessionID(item, { lifecycle, depth: depth + 1 });
      if (sessionID) return sessionID;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.sessionID === "string" && value.sessionID) return value.sessionID;
  if (typeof value.session_id === "string" && value.session_id) return value.session_id;
  if (typeof value.info?.sessionID === "string" && value.info.sessionID) return value.info.sessionID;
  if (typeof value.part?.sessionID === "string" && value.part.sessionID) return value.part.sessionID;
  if (lifecycle) {
    if (typeof value.info?.id === "string" && value.info.id) return value.info.id;
    if (typeof value.id === "string" && value.id) return value.id;
  }
  if (Object.prototype.hasOwnProperty.call(value, "data")) {
    return extractSessionID(value.data, { lifecycle, depth: depth + 1 });
  }
  return null;
};

export const idleCleanupPath = (sessionID, successCandidates = new Map()) =>
  successCandidates.get(sessionID) === true ? "/complete" : "/release";

export const applyMessageModel = (message, routed, sessionID, mark = markManagedModelSwitch) => {
  const targetModel = routed?.target?.model ?? routed?.model;
  const providerID = targetModel?.providerID;
  const modelID = targetModel?.modelID ?? targetModel?.id;
  const variant = typeof targetModel?.variant === "string" && targetModel.variant ? targetModel.variant : undefined;
  if (!message || typeof message !== "object" || typeof sessionID !== "string" || !sessionID ||
    typeof providerID !== "string" || !providerID || typeof modelID !== "string" || !modelID) {
    return;
  }
  const current = message.model;
  const currentProviderID = current?.providerID;
  const currentModelID = current?.modelID ?? current?.id;
  if (currentProviderID !== providerID || currentModelID !== modelID || current?.variant !== variant) {
    if (typeof mark === "function") mark(sessionID, { providerID, id: modelID, ...(variant ? { variant } : {}) });
  }
  message.model = { providerID, modelID, ...(variant ? { variant } : {}) };
};

// The engine fork (opencode fork/atomic-runtime-contracts, on top of v1.18.22) adds a SUPPORTED
// `model` field to the chat.message hook output. Setting it is what actually binds the turn:
// stock v1.18.22 offers no such field, which is why applyMessageModel above has to mutate the
// UserMessage instead -- an undocumented side effect that silently does not take when the server
// has already bound the request model (a task child's first turn, or a synthetic re-engage prompt),
// producing the hard "routed model mismatch" failure that killed unattended children.
// Both are applied: a pane started before the fork was deployed is still running the old binary,
// which ignores this field, and a pane running the fork honours it.
// CEILING: once every pane runs the fork, drop applyMessageModel and keep only this.
export const applyOutputModel = (output, routed) => {
  const targetModel = routed?.target?.model ?? routed?.model;
  const providerID = targetModel?.providerID;
  const modelID = targetModel?.modelID ?? targetModel?.id;
  const variant = typeof targetModel?.variant === "string" && targetModel.variant ? targetModel.variant : undefined;
  if (!output || typeof output !== "object") return;
  if (typeof providerID !== "string" || !providerID || typeof modelID !== "string" || !modelID) return;
  output.model = { providerID, modelID, ...(variant ? { variant } : {}) };
};

export const cleanupDeletedSession = async ({
  sessionID,
  routes,
  sessions,
  blocked,
  successCandidates,
  contextSizes,
  stopHeartbeat,
  removeSessionProfile,
  removeSessionContextEstimate,
  writePendingForgetRecord,
  removePendingForgetRecord,
  brokerRequest,
} = {}) => {
  const shouldComplete = successCandidates?.get(sessionID) === true;
  stopHeartbeat?.(sessionID);
  routes?.delete(sessionID);
  sessions?.delete(sessionID);
  blocked?.delete(sessionID);
  successCandidates?.delete(sessionID);
  contextSizes?.delete(sessionID);
  removeSessionProfile?.(sessionID);
  removeSessionContextEstimate?.(sessionID);
  try {
    await brokerRequest("/forget", { sessionID, ...(shouldComplete ? { completed: true } : {}) });
    removePendingForgetRecord?.(sessionID);
  } catch {
    writePendingForgetRecord?.(sessionID, { completed: shouldComplete });
  }
};
