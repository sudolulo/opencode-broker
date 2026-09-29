import { createHash } from "node:crypto";

export const EVIDENCE_CLAIM_LEASE_MS = 30 * 60_000;
export const EVIDENCE_RETRY_COOLDOWN_MS = 24 * 3600_000;

const candidateIdentity = (record) => ({
  providerID: record.providerID,
  modelID: record.candidateModelID ?? record.modelID,
  releaseDate: record.candidateReleaseDate ?? record.releaseDate ?? "",
  // Unknown records keep their original provider/family line after an operator maps them to a
  // role. Role records have no groupKey, so their roleKey remains the line identity.
  groupKey: record.groupKey ?? record.roleKey,
  roleID: record.roleID ?? null,
  incumbentModelID: record.incumbentModelID ?? null,
});

export const evidenceRequestKey = (record) => record.transitionID;

export const candidateRevision = (record) => {
  const identity = candidateIdentity(record);
  if (identity.modelID === undefined || identity.modelID === null) {
    throw new Error("evidence candidate is missing its model ID");
  }
  if (identity.groupKey === undefined || identity.groupKey === null) {
    throw new Error("evidence candidate is missing its group key");
  }
  return createHash("sha256")
    .update([
      String(identity.providerID ?? ""),
      String(identity.modelID),
      String(identity.releaseDate),
      String(identity.groupKey),
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
};

const requestFor = (record, kind, timestamp) => {
  const identity = candidateIdentity(record);
  return {
    transitionID: evidenceRequestKey(record),
    kind,
    roleKey: record.roleKey ?? null,
    roleID: identity.roleID,
    providerID: identity.providerID,
    candidateModelID: identity.modelID,
    incumbentModelID: identity.incumbentModelID,
    candidateRevision: candidateRevision(record),
    status: "pending",
    attempts: 0,
    claimedAt: null,
    claimedBy: null,
    retryAfter: null,
    lastError: null,
    enqueuedAt: timestamp,
    updatedAt: timestamp,
  };
};

const refreshRequestIdentity = (existing, record, kind, timestamp) => {
  const refreshed = requestFor(record, kind, existing.enqueuedAt);
  const identityFields = [
    "kind", "roleKey", "roleID", "providerID", "candidateModelID", "incumbentModelID",
    "candidateRevision",
  ];
  const identityChanged = identityFields.some((field) => existing[field] !== refreshed[field]);
  return {
    ...refreshed,
    status: existing.status,
    attempts: existing.attempts,
    claimedAt: existing.claimedAt,
    claimedBy: existing.claimedBy,
    retryAfter: existing.retryAfter,
    lastError: existing.lastError,
    updatedAt: identityChanged ? timestamp : existing.updatedAt,
  };
};

const isLiveClaim = (request, timestamp) => request?.status === "claimed"
  && typeof request.claimedAt === "number"
  && timestamp - request.claimedAt <= EVIDENCE_CLAIM_LEASE_MS;

const evidencePending = (record) => record?.state === "evidence-pending"
  && Array.isArray(record.evidence)
  && record.evidence.length === 0;

const recordsWithKinds = (state) => [
  ...Object.values(state.roles ?? {}).map((record) => ({ kind: "role", record })),
  ...Object.values(state.unknown ?? {}).map((record) => ({ kind: "unknown", record })),
].sort((left, right) => String(evidenceRequestKey(left.record))
  .localeCompare(String(evidenceRequestKey(right.record))));

export const enqueueEvidenceRequests = (state, { now }) => {
  const timestamp = now();
  const currentRequests = state.evidenceRequests ?? {};
  const evidenceRequests = {};
  const enqueued = [];
  const skipped = [];
  const seen = new Set();

  for (const { kind, record } of recordsWithKinds(state)) {
    const transitionID = evidenceRequestKey(record);
    seen.add(transitionID);
    const existing = currentRequests[transitionID];

    if (!evidencePending(record)) {
      if (isLiveClaim(existing, timestamp)) evidenceRequests[transitionID] = { ...existing };
      skipped.push(transitionID);
      continue;
    }

    const revision = candidateRevision(record);
    if (existing?.candidateRevision === revision) {
      evidenceRequests[transitionID] = refreshRequestIdentity(existing, record, kind, timestamp);
      skipped.push(transitionID);
      continue;
    }

    evidenceRequests[transitionID] = requestFor(record, kind, timestamp);
    enqueued.push(transitionID);
  }

  // A collector may finish a claim after the candidate stops being current. Keep that request
  // only through its live lease so the collector can report against the claim it actually holds.
  for (const [transitionID, request] of Object.entries(currentRequests)) {
    if (!seen.has(transitionID) && isLiveClaim(request, timestamp)) {
      evidenceRequests[transitionID] = { ...request };
    }
  }

  return {
    state: { ...state, evidenceRequests },
    enqueued,
    skipped,
  };
};

const eligibleForClaim = (request, timestamp) => {
  if (request.status === "pending") return true;
  if (request.status !== "failed") return false;
  return typeof request.retryAfter !== "number" || timestamp > request.retryAfter;
};

export const claimEvidenceRequest = (state, { now, pid }) => {
  const timestamp = now();
  const eligible = Object.values(state.evidenceRequests ?? {})
    .filter((request) => eligibleForClaim(request, timestamp))
    .sort((left, right) => {
      const byTime = left.enqueuedAt - right.enqueuedAt;
      return byTime || String(left.transitionID).localeCompare(String(right.transitionID));
    });
  if (!eligible.length) return { state: { ...state, evidenceRequests: { ...(state.evidenceRequests ?? {}) } }, claim: null };

  const selected = eligible[0];
  const claimed = {
    ...selected,
    status: "claimed",
    claimedAt: timestamp,
    claimedBy: pid,
    updatedAt: timestamp,
  };
  return {
    state: {
      ...state,
      evidenceRequests: { ...(state.evidenceRequests ?? {}), [selected.transitionID]: claimed },
    },
    claim: { ...claimed },
  };
};

export const recordEvidenceFailure = (state, transitionID, { error, now }) => {
  const request = state.evidenceRequests?.[transitionID];
  if (!request) return state;
  const timestamp = now();
  const failed = {
    ...request,
    status: "failed",
    attempts: (Number.isInteger(request.attempts) && request.attempts >= 0 ? request.attempts : 0) + 1,
    claimedAt: null,
    claimedBy: null,
    retryAfter: timestamp + EVIDENCE_RETRY_COOLDOWN_MS,
    lastError: String(error?.message ?? error).slice(0, 500),
    updatedAt: timestamp,
  };
  return {
    ...state,
    evidenceRequests: { ...state.evidenceRequests, [transitionID]: failed },
  };
};

export const expireEvidenceClaims = (state, { now }) => {
  const timestamp = now();
  const evidenceRequests = Object.fromEntries(Object.entries(state.evidenceRequests ?? {}).map(
    ([transitionID, request]) => {
      if (!isLiveClaim(request, timestamp) && request.status === "claimed") {
        return [transitionID, {
          ...request,
          status: "pending",
          claimedAt: null,
          claimedBy: null,
          updatedAt: timestamp,
        }];
      }
      return [transitionID, { ...request }];
    }));
  return { ...state, evidenceRequests };
};
