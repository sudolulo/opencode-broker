import { createHash } from "node:crypto";

export const EVIDENCE_CLAIM_LEASE_MS = 30 * 60_000;
export const EVIDENCE_RETRY_COOLDOWN_MS = 24 * 3600_000;
export const EVIDENCE_MAX_BYTES = 64 * 1024;
export const POLICY_CLAIM_TYPES = Object.freeze([
  "successor", "recommended-replacement", "new-role", "role-change",
]);
export const SUPPORTING_CLAIM_TYPES = Object.freeze(["stronger", "faster", "cheaper"]);

const MAX_EVIDENCE_CLAIMS = 10;
const MAX_RETRIEVAL_CLOCK_SKEW_MS = 5 * 60_000;
const CONTINUITY_CLAIM_TYPES = new Set(["successor", "recommended-replacement"]);
const DISCONTINUITY_CLAIM_TYPES = new Set(["new-role", "role-change"]);
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

const isPlainObject = (value) => value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

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

export const parseEvidencePayload = (text) => {
  if (typeof text !== "string") throw new Error("evidence stdout is not valid JSON text");
  if (Buffer.byteLength(text, "utf8") > EVIDENCE_MAX_BYTES) {
    throw new Error(`evidence stdout is too large (maximum ${EVIDENCE_MAX_BYTES} bytes)`);
  }
  const trimmed = text.trim();
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    if (String(error?.message ?? error).includes("after JSON")) {
      throw new Error("evidence stdout must contain exactly one JSON value", { cause: error });
    }
    throw new Error("evidence stdout is not valid JSON", { cause: error });
  }
  if (!isPlainObject(payload)) throw new Error("evidence stdout must be one plain object");
  return payload;
};

export const allowedEvidenceDomains = (request, roles) => {
  const registry = isPlainObject(roles) ? roles : {};
  if (request?.kind !== "unknown" && request?.roleID !== null && request?.roleID !== undefined) {
    const roleKey = request.roleKey ?? `${request.providerID}:${request.roleID}`;
    const role = registry[roleKey];
    if (!role || role.providerID !== request.providerID || role.roleID !== request.roleID) {
      return Object.freeze([]);
    }
    return Object.freeze([...(Array.isArray(role.evidenceDomains) ? role.evidenceDomains : [])]);
  }

  const domains = new Set();
  for (const role of Object.values(registry)) {
    if (!role || role.providerID !== request?.providerID || !Array.isArray(role.evidenceDomains)) continue;
    for (const domain of role.evidenceDomains) if (typeof domain === "string") domains.add(domain);
  }
  return Object.freeze([...domains].sort());
};

const sourceIsAllowed = (sourceURL, domains) => {
  let parsed;
  try {
    parsed = new URL(sourceURL);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  return domains.some((entry) => {
    const domain = String(entry).toLowerCase();
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
};

const evidenceHash = (sourceURL, exactQuote) => createHash("sha256")
  .update(sourceURL)
  .update("\u0000")
  .update(exactQuote)
  .digest("hex");

const parseISOTimestamp = (value) => {
  if (typeof value !== "string") return Number.NaN;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second, fraction = "0", zone, sign, zoneHour, zoneMinute] = match;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  const offsetMinutes = zone === "Z"
    ? 0
    : (sign === "+" ? 1 : -1) * (Number(zoneHour) * 60 + Number(zoneMinute));
  const local = new Date(parsed + offsetMinutes * 60_000);
  const components = [
    local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(),
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds(),
  ];
  const expected = [
    Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second),
    Number(fraction.padEnd(3, "0")),
  ];
  return components.every((component, index) => component === expected[index]) ? parsed : Number.NaN;
};

const rejectedResult = (reason) => ({ claims: [], rejected: [reason], contradiction: false });

export const validateEvidencePayload = (payload, { request, roles, now }) => {
  if (!isPlainObject(payload)) throw new Error("evidence payload must be a plain object");
  if (!isPlainObject(request)) throw new Error("evidence request must be a plain object");
  if (payload.providerID !== request.providerID) {
    return rejectedResult("payload providerID does not match the evidence request provider");
  }
  if (payload.candidateModelID !== request.candidateModelID) {
    return rejectedResult("payload candidateModelID does not match the evidence request candidate");
  }
  if (request.roleID !== null && request.roleID !== undefined && payload.roleID !== request.roleID) {
    return rejectedResult("payload roleID does not match the evidence request role");
  }
  if (!Array.isArray(payload.claims)) throw new Error("evidence payload claims must be an array");

  const timestamp = Number(now());
  if (!Number.isFinite(timestamp)) throw new Error("evidence validation clock is invalid");
  const domains = allowedEvidenceDomains(request, roles);
  const claims = [];
  const rejected = [];

  for (const [index, claim] of payload.claims.entries()) {
    const reject = (reason) => rejected.push(`claim ${index + 1}: ${reason}`);
    if (!isPlainObject(claim)) {
      reject("must be a plain object");
      continue;
    }
    const policyType = POLICY_CLAIM_TYPES.includes(claim.claimType);
    const supportingType = SUPPORTING_CLAIM_TYPES.includes(claim.claimType);
    if (!policyType && !supportingType) {
      reject("claimType is not allowed");
      continue;
    }
    if (CONTINUITY_CLAIM_TYPES.has(claim.claimType)
      && request.incumbentModelID !== null
      && request.incumbentModelID !== undefined
      && payload.incumbentModelID !== request.incumbentModelID) {
      reject("incumbentModelID does not match the evidence request incumbent");
      continue;
    }
    if (typeof claim.sourceURL !== "string" || !sourceIsAllowed(claim.sourceURL, domains)) {
      reject("sourceURL must be HTTPS on an allowed evidence domain");
      continue;
    }
    if (typeof claim.exactQuote !== "string"
      || claim.exactQuote.length < 10
      || claim.exactQuote.length > 1000) {
      reject("exactQuote must be 10 to 1000 characters");
      continue;
    }
    const retrievedAt = parseISOTimestamp(claim.retrievedAt);
    if (!Number.isFinite(retrievedAt)) {
      reject("retrievedAt must be an ISO timestamp");
      continue;
    }
    if (retrievedAt > timestamp + MAX_RETRIEVAL_CLOCK_SKEW_MS) {
      reject("retrievedAt is more than five minutes in the future");
      continue;
    }
    if (claims.length >= MAX_EVIDENCE_CLAIMS) {
      reject(`only ${MAX_EVIDENCE_CLAIMS} evidence claims may be accepted`);
      continue;
    }

    claims.push({
      providerID: payload.providerID,
      candidateModelID: payload.candidateModelID,
      incumbentModelID: payload.incumbentModelID ?? null,
      roleID: payload.roleID ?? null,
      claimType: claim.claimType,
      sourceURL: claim.sourceURL,
      exactQuote: claim.exactQuote,
      retrievedAt: claim.retrievedAt,
      contentHash: evidenceHash(claim.sourceURL, claim.exactQuote),
      policy: policyType
        && request.kind !== "unknown"
        && request.roleID !== null
        && request.roleID !== undefined,
    });
  }

  const policyTypes = new Set(claims.filter((claim) => claim.policy).map((claim) => claim.claimType));
  const contradiction = [...policyTypes].some((claimType) => CONTINUITY_CLAIM_TYPES.has(claimType))
    && [...policyTypes].some((claimType) => DISCONTINUITY_CLAIM_TYPES.has(claimType));
  if (!payload.claims.length) rejected.push("payload contains no evidence claims");
  return { claims, rejected, contradiction };
};

const evidenceRecord = (state, request, transitionID) => {
  if (request.kind === "unknown") return state.unknown?.[transitionID];
  return state.roles?.[request.roleKey];
};

export const ingestEvidence = (state, transitionID, payload, {
  roles,
  now,
  forbiddenStrings = [],
}) => {
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    throw new Error("evidence payload could not be serialized", { cause: error });
  }
  for (const forbidden of forbiddenStrings) {
    if (typeof forbidden === "string" && forbidden.length > 0 && serialized.includes(forbidden)) {
      throw new Error("evidence payload contains a forbidden string");
    }
  }

  const request = state.evidenceRequests?.[transitionID];
  if (!request) throw new Error(`evidence request ${transitionID} is missing`);
  const record = evidenceRecord(state, request, transitionID);
  if (!record) throw new Error(`evidence record ${transitionID} is missing`);
  if (record.state !== "evidence-pending") {
    throw new Error(`evidence record ${transitionID} is no longer evidence-pending`);
  }
  const revision = candidateRevision(record);
  if (revision !== request.candidateRevision) {
    throw new Error(`evidence request ${transitionID} has a stale candidate revision`);
  }

  const timestamp = Number(now());
  if (!Number.isFinite(timestamp)) throw new Error("evidence ingestion clock is invalid");
  const validated = validateEvidencePayload(payload, {
    request,
    roles,
    now: () => timestamp,
  });
  if (!validated.claims.length) {
    const reasons = validated.rejected.length ? `: ${validated.rejected.join("; ")}` : "";
    throw new Error(`no acceptable evidence${reasons}`);
  }

  const updatedRecord = {
    ...record,
    evidence: [...(Array.isArray(record.evidence) ? record.evidence : []), ...validated.claims],
    evidenceRevision: revision,
    evidenceCollectedAt: timestamp,
    evidenceContradiction: validated.contradiction,
  };
  const evidenceRequests = { ...state.evidenceRequests };
  delete evidenceRequests[transitionID];
  const nextState = request.kind === "unknown"
    ? { ...state, unknown: { ...state.unknown, [transitionID]: updatedRecord }, evidenceRequests }
    : { ...state, roles: { ...state.roles, [request.roleKey]: updatedRecord }, evidenceRequests };
  return { state: nextState, accepted: validated.claims.length };
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
