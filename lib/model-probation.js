import {
  OPPORTUNITY_TIMEOUT_MS,
  OPPORTUNITY_WINDOW_MS,
  PROBATION_SUCCESS_THRESHOLD,
  QUALIFYING_FAILURE_THRESHOLD,
  QUALIFYING_FAILURE_WINDOW_MS,
} from "./model-lease.js";

const QUALIFYING_FAILURES = new Set([
  "model-not-found",
  "unsupported-model-parameter",
  "invalid-model-tool-call-response",
  "model-entitlement-failure",
]);
const EXCLUDED_FAILURES = new Set([
  "network-failure",
  "rate-limit",
  "provider-overload",
  "user-cancellation",
  "client-disconnect",
  "tool-execution-failure",
]);
const OUTCOMES = new Set(["success", "failure", "abandoned"]);
const SOURCES = new Set(["complete", "usage", "failure", "expiry", "forget", "lease"]);
const MAX_TRACKED_LEASES = 512;

const clone = (value) => structuredClone(value);
const fail = (message) => { throw new Error(`model probation ${message}`); };
const requireID = (value, label) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    fail(`${label} must be a non-empty identifier`);
  }
  return value;
};
const requireNow = (value) => {
  if (!Number.isFinite(value) || value < 0) fail("now must be a non-negative finite timestamp");
  return value;
};
const roleFor = (policy, roleKey) => {
  requireID(roleKey, "roleKey");
  const role = policy?.roles?.[roleKey];
  if (!role || typeof role !== "object") fail(`unknown role ${roleKey}`);
  if (!role.probation || typeof role.probation !== "object") fail(`role ${roleKey} has no probation state`);
  if (!role.probation.leases || typeof role.probation.leases !== "object" || Array.isArray(role.probation.leases)) {
    fail(`role ${roleKey} has malformed lease state`);
  }
  return role;
};

const normalizedFailureClass = (failure) => {
  if (typeof failure === "string") return failure;
  if (failure && typeof failure === "object" && typeof failure.failureClass === "string") {
    return failure.failureClass;
  }
  return "unknown";
};

export const classifyModelPolicyFailure = (failure) => {
  const candidate = normalizedFailureClass(failure);
  if (QUALIFYING_FAILURES.has(candidate)) return { classification: candidate, qualifying: true };
  if (EXCLUDED_FAILURES.has(candidate)) return { classification: candidate, qualifying: false };
  return { classification: "unknown", qualifying: false };
};

const trimTrackedLeases = (leases) => {
  const entries = Object.entries(leases);
  if (entries.length <= MAX_TRACKED_LEASES) return;
  const removable = entries
    .filter(([, record]) => record?.settlement)
    .sort((left, right) => Number(left[1].settlement.at) - Number(right[1].settlement.at));
  while (Object.keys(leases).length > MAX_TRACKED_LEASES && removable.length) {
    delete leases[removable.shift()[0]];
  }
  if (Object.keys(leases).length > MAX_TRACKED_LEASES) {
    fail(`cannot track more than ${MAX_TRACKED_LEASES} unsettled candidate leases`);
  }
};

export const recordCandidateLease = (inputPolicy, {
  roleKey,
  leaseID,
  sessionID,
  now,
  synthetic = false,
} = {}) => {
  leaseID = requireID(leaseID, "leaseID");
  sessionID = requireID(sessionID, "sessionID");
  now = requireNow(now);
  const policy = clone(inputPolicy);
  const role = roleFor(policy, roleKey);
  const present = role.probation.leases[leaseID];
  if (present) {
    if (present.sessionID !== sessionID) fail(`lease ${leaseID} session mismatch`);
    return {
      policy,
      event: { type: "candidate-lease", leaseID, sessionID, replayed: true, synthetic: present.synthetic },
    };
  }
  const isSynthetic = synthetic === true || sessionID.startsWith("gw-probe-");
  role.probation.leases[leaseID] = {
    sessionID,
    leasedAt: now,
    synthetic: isSynthetic,
    settlement: null,
  };
  trimTrackedLeases(role.probation.leases);
  return {
    policy,
    event: { type: "candidate-lease", leaseID, sessionID, replayed: false, synthetic: isSynthetic },
  };
};

const rollback = (role, reason) => {
  role.activeModelID = role.rollbackModelID;
  role.probationModelID = null;
  role.probation.phase = "rolled-back";
  role.probation.opportunityCursorAt = null;
  role.probation.opportunityEligibleUntil = null;
  role.rollbackReason = reason;
};

const promote = (role) => {
  role.activeModelID = role.probationModelID;
  role.probationModelID = null;
  role.probation.phase = "active";
  role.probation.opportunityCursorAt = null;
  role.probation.opportunityEligibleUntil = null;
  delete role.rollbackReason;
};

export const settleCandidateOutcome = (inputPolicy, {
  roleKey,
  leaseID,
  sessionID,
  outcome,
  failureClass,
  source,
  now,
} = {}) => {
  leaseID = requireID(leaseID, "leaseID");
  sessionID = requireID(sessionID, "sessionID");
  now = requireNow(now);
  if (!OUTCOMES.has(outcome)) fail(`outcome must be one of ${[...OUTCOMES].join(", ")}`);
  if (!SOURCES.has(source)) fail(`source must be one of ${[...SOURCES].join(", ")}`);
  const policy = clone(inputPolicy);
  const role = roleFor(policy, roleKey);
  const lease = role.probation.leases[leaseID];
  if (!lease) fail(`unknown lease ${leaseID}`);
  if (lease.sessionID !== sessionID) fail(`lease ${leaseID} session mismatch`);
  if (lease.settlement) {
    return {
      policy,
      event: {
        type: "candidate-outcome",
        leaseID,
        sessionID,
        outcome: lease.settlement.outcome,
        replayed: true,
        changed: false,
      },
    };
  }

  const classified = outcome === "failure"
    ? classifyModelPolicyFailure(failureClass)
    : { classification: null, qualifying: false };
  lease.settlement = {
    outcome,
    failureClass: classified.classification,
    qualifying: classified.qualifying,
    source,
    at: now,
  };

  let promoted = false;
  let rolledBack = false;
  if (!lease.synthetic && role.probation.phase !== "rolled-back") {
    if (outcome === "success" && role.probation.phase === "probation" &&
      !role.probation.successes.includes(leaseID)) {
      role.probation.successes.push(leaseID);
      if (role.probation.successes.length >= PROBATION_SUCCESS_THRESHOLD) {
        promote(role);
        promoted = true;
      }
    } else if (outcome === "failure" && classified.qualifying) {
      const cutoff = now - QUALIFYING_FAILURE_WINDOW_MS;
      role.probation.failures = role.probation.failures.filter((failure) =>
        Number(failure?.at) >= cutoff);
      if (!role.probation.failures.some((failure) => failure?.leaseID === leaseID)) {
        role.probation.failures.push({
          leaseID,
          sessionID,
          failureClass: classified.classification,
          at: now,
        });
      }
      if ((role.probation.phase === "probation" || role.probation.phase === "active") &&
        role.probation.failures.length >= QUALIFYING_FAILURE_THRESHOLD) {
        rollback(role, "model-failure-threshold");
        rolledBack = true;
      }
    }
  }

  return {
    policy,
    event: {
      type: "candidate-outcome",
      leaseID,
      sessionID,
      outcome,
      failureClass: classified.classification,
      qualifying: classified.qualifying,
      replayed: false,
      changed: true,
      promoted,
      rolledBack,
    },
  };
};

export const accrueOpportunityTime = (inputPolicy, {
  roleKey,
  now,
  compatibleActiveRegistration,
  eligibleCandidateRequest,
} = {}) => {
  now = requireNow(now);
  const policy = clone(inputPolicy);
  const role = roleFor(policy, roleKey);
  const probation = role.probation;
  if (probation.phase !== "probation") return { policy, accruedMs: 0, timedOut: false };

  const cursorAt = Number(probation.opportunityCursorAt);
  const eligibleUntil = Number(probation.opportunityEligibleUntil);
  let accruedMs = 0;
  if (Number.isFinite(cursorAt) && Number.isFinite(eligibleUntil)) {
    const accrualEnd = Math.min(now, eligibleUntil);
    accruedMs = Math.max(0, accrualEnd - cursorAt);
    const remaining = Math.max(0, OPPORTUNITY_TIMEOUT_MS - probation.opportunityMs);
    accruedMs = Math.min(accruedMs, remaining);
    probation.opportunityMs += accruedMs;
  }

  const hasProductionCandidateLease = Object.values(probation.leases)
    .some((candidateLease) => candidateLease?.synthetic === false);
  const eligible = compatibleActiveRegistration === true && eligibleCandidateRequest === true &&
    hasProductionCandidateLease;
  if (eligible) {
    probation.opportunityCursor += 1;
    probation.opportunityCursorAt = now;
    probation.opportunityEligibleUntil = now + OPPORTUNITY_WINDOW_MS;
  } else {
    probation.opportunityCursorAt = null;
    probation.opportunityEligibleUntil = null;
  }

  const timedOut = probation.opportunityMs >= OPPORTUNITY_TIMEOUT_MS;
  if (timedOut) rollback(role, "probation-timeout");
  return { policy, accruedMs, timedOut };
};
