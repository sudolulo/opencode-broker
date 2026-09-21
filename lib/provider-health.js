import { createHash } from "node:crypto";

const HEALTH_STATES = new Set(["observing", "quarantined", "probation"]);
const HEALTH_SOURCES = new Set(["automatic", "operator"]);
const PROVIDER_ID = /^[a-z0-9][a-z0-9._:-]{0,180}$/;
const REASON_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const WINDOW_MS = 15 * 60 * 1000;
// After this interval an automatic quarantine drops to probation, which admits exactly
// ONE lease: a success deletes the record outright, a failure re-quarantines on contact
// and the wait starts over -- a constant backoff, not a reprieve.
// ☆ Deliberately longer than WINDOW_MS so the evidence that caused the quarantine has
// aged out before the probe runs. Re-probing inside the window would meet a live count
// of 2 and re-quarantine on the first failure of any kind.
const QUARANTINE_REPROBE_MS = 30 * 60 * 1000;
const MAX_EVIDENCE = 8;

const safeText = (value, limit) => {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) : text;
};

const safeAt = (value, fallback = Date.now()) => {
  const at = Number(value);
  return Number.isFinite(at) && at >= 0 ? at : fallback;
};

const safeEvidence = (value) => {
  if (!value || typeof value !== "object") return null;
  const targetID = safeText(value.targetID, 200);
  const modelID = safeText(value.modelID, 200);
  const at = safeAt(value.at, NaN);
  if (!PROVIDER_ID.test(targetID) || !PROVIDER_ID.test(modelID) || !Number.isFinite(at)) return null;
  return { targetID, modelID, at };
};

const normalizeEvidence = (evidence, now) => {
  const rows = Array.isArray(evidence) ? evidence : [];
  const recent = rows.map(safeEvidence).filter((entry) => entry && now - entry.at <= WINDOW_MS);
  recent.sort((left, right) => left.at - right.at);
  const unique = [];
  const seen = new Set();
  for (const entry of recent) {
    const key = `${entry.targetID}\u0000${entry.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.slice(-MAX_EVIDENCE);
};

const normalizeState = (value) => HEALTH_STATES.has(value) ? value : null;
const normalizeSource = (value) => HEALTH_SOURCES.has(value) ? value : "automatic";
const normalizeReasonCode = (value) => typeof value === "string" && REASON_CODE.test(value) ? value : null;

const providerErrorEnvelope = (error, depth = 0) => {
  if (!error || typeof error !== "object" || depth > 2) return null;
  const direct = Object.prototype.hasOwnProperty.call(error, "message") ||
    Object.prototype.hasOwnProperty.call(error, "name") ||
    Object.prototype.hasOwnProperty.call(error, "code") ||
    Object.prototype.hasOwnProperty.call(error, "statusCode") ||
    Object.prototype.hasOwnProperty.call(error, "status");
  if (direct) return error;
  for (const key of ["data", "error", "cause"]) {
    const nested = providerErrorEnvelope(error[key], depth + 1);
    if (nested) return nested;
  }
  return null;
};

const providerErrorValue = (error, keys, depth = 0) => {
  if (!error || typeof error !== "object" || depth > 2) return null;
  for (const key of keys) {
    if (typeof error[key] === "string" || Number.isInteger(error[key])) return error[key];
  }
  for (const key of ["data", "error", "cause"]) {
    const nested = providerErrorValue(error[key], keys, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
};

const resetAtFrom = (error, depth = 0) => {
  if (!error || typeof error !== "object" || depth > 2) return null;
  for (const value of [error?.resetAt, error?.reset_at, error?.renewAt, error?.renew_at]) {
    if (typeof value !== "string" || value.length > 80) continue;
    const at = Date.parse(value);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  for (const key of ["data", "error", "cause"]) {
    const nested = resetAtFrom(error[key], depth + 1);
    if (nested) return nested;
  }
  return null;
};

const normalizedRecords = (health) => {
  if (!health || typeof health !== "object") return {};
  const source = health.providers && typeof health.providers === "object" ? health.providers : health;
  return source && typeof source === "object" ? source : {};
};

export const normalizeProviderError = (error) => {
  if (typeof error === "string") {
    return { name: "Error", message: safeText(error, 512) || "unknown provider error" };
  }
  if (!error || typeof error !== "object") {
    return { name: "Error", message: "unknown provider error" };
  }
  const envelope = providerErrorEnvelope(error) ?? error;
  const name = safeText(envelope.name, 128) || "Error";
  // opencode's NamedError.toObject() ships { name, data: { message } }: the outer
  // object wins the envelope walk on `name` alone, so the real message hides one
  // level down. Losing it turned every plan-limit stop into "unknown provider
  // error" -- unclassifiable, so no circuit and no failover.
  const nestedMessage = safeText(envelope.message, 512)
    ? null
    : ["data", "error", "cause"]
      .map((key) => providerErrorEnvelope(envelope[key]))
      .map((nested) => nested && safeText(nested.message, 512))
      .find(Boolean);
  const message = safeText(envelope.message, 512) || nestedMessage || "unknown provider error";
  const code = safeText(envelope.code, 128) || safeText(providerErrorValue(error, ["code"]), 128) || null;
  const statusCode = Number.isInteger(envelope.statusCode)
    ? envelope.statusCode
    : Number.isInteger(envelope.status)
      ? envelope.status
      : providerErrorValue(error, ["statusCode", "status"]);
  const resetAt = resetAtFrom(envelope) ?? resetAtFrom(error);
  return {
    name,
    message,
    ...(code ? { code } : {}),
    ...(Number.isInteger(statusCode) ? { statusCode } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
};

export const providerErrorText = (error) => {
  const safe = normalizeProviderError(error);
  return [safe.name, safe.code ?? "", safe.statusCode ?? "", safe.message].filter(Boolean).join(" ").trim();
};

// A user abort reaches the router through the same error events as provider faults,
// but it says nothing about provider health and must never open a circuit.
export const isAbortError = (error) => {
  const safe = normalizeProviderError(error);
  if (safe.name === "MessageAbortedError" || safe.name === "AbortError") return true;
  return /^abort(?:ed)?$/i.test(safe.message);
};

export const fingerprintProviderError = (error) =>
  createHash("sha256").update(JSON.stringify(normalizeProviderError(error))).digest("hex");

export const normalizeHealth = (health, now = Date.now()) => {
  const providers = {};
  for (const [providerID, value] of Object.entries(normalizedRecords(health))) {
    if (!PROVIDER_ID.test(providerID) || !value || typeof value !== "object") continue;
    const state = normalizeState(value.state);
    if (!state) continue;
    const evidence = normalizeEvidence(value.evidence, now);
    const firstAt = safeAt(value.firstAt, evidence[0]?.at ?? now);
    const lastAt = safeAt(value.lastAt, evidence.at(-1)?.at ?? firstAt);
    const record = {
      state,
      kind: "compatibility",
      source: normalizeSource(value.source),
      reasonCode: normalizeReasonCode(value.reasonCode ?? value.reason?.code),
      fingerprint: typeof value.fingerprint === "string"
        ? safeText(value.fingerprint, 128) || null
        : typeof value.reason?.fingerprint === "string"
          ? safeText(value.reason.fingerprint, 128) || null
          : null,
      firstAt,
      lastAt,
      evidence,
    };
    // ☆ source "operator" is EXEMPT: a human quarantine is a decision, not a symptom,
    // and no timer may undo it. Only an explicit `rearm` reopens one of those.
    if (record.state === "quarantined" && record.source === "automatic" &&
        now - record.lastAt >= QUARANTINE_REPROBE_MS) {
      record.state = "probation";
    }
    if (record.state === "observing" && !record.evidence.length) continue;
    providers[providerID] = record;
  }
  return { providers };
};

const normalizeFingerprint = (value) => {
  const text = safeText(value, 256);
  return text || null;
};

const appendEvidence = (current, entry, now) => {
  const evidence = [...(Array.isArray(current) ? current : []), entry]
    .filter((candidate) => candidate && now - candidate.at <= WINDOW_MS)
    .sort((left, right) => left.at - right.at);
  const unique = [];
  const seen = new Set();
  for (const candidate of evidence) {
    const key = `${candidate.targetID}\u0000${candidate.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique.slice(-MAX_EVIDENCE);
};

export const recordFailureEvidence = (
  health,
  providerID,
  { targetID, modelID, reasonCode = "compatibility", fingerprint, error, at = Date.now() } = {},
) => {
  if (!PROVIDER_ID.test(providerID)) return normalizeHealth(health, at);
  const entry = safeEvidence({ targetID, modelID, at });
  if (!entry) return normalizeHealth(health, at);
  const next = normalizeHealth(health, at);
  const current = next.providers[providerID] ?? null;
  const safeReason = normalizeReasonCode(reasonCode) ?? "compatibility";
  const safeFingerprint = normalizeFingerprint(fingerprint ?? fingerprintProviderError(error));
  if (!safeFingerprint) return next;
  const evidence = appendEvidence(current?.evidence ?? [], entry, at);
  const distinct = new Set(evidence.map(({ targetID: target, modelID: model }) => `${target}\u0000${model}`)).size;
  const state = current?.state === "probation"
    ? "quarantined"
    : current?.state === "quarantined"
      ? "quarantined"
      : distinct >= 2
        ? "quarantined"
        : "observing";
  next.providers[providerID] = {
    state,
    kind: "compatibility",
    source: "automatic",
    reasonCode: safeReason,
    fingerprint: safeFingerprint,
    firstAt: evidence[0]?.at ?? at,
    lastAt: evidence.at(-1)?.at ?? at,
    evidence,
  };
  return next;
};

export const operatorQuarantineProvider = (
  health,
  providerID,
  { reasonCode = "operator", at = Date.now() } = {},
) => {
  if (!PROVIDER_ID.test(providerID)) return normalizeHealth(health, at);
  const next = normalizeHealth(health, at);
  const current = next.providers[providerID] ?? null;
  next.providers[providerID] = {
    state: "quarantined",
    kind: "compatibility",
    source: "operator",
    reasonCode: normalizeReasonCode(reasonCode) ?? "operator",
    fingerprint: current?.fingerprint ?? null,
    firstAt: current?.firstAt ?? at,
    lastAt: at,
    evidence: Array.isArray(current?.evidence) ? current.evidence.slice(-MAX_EVIDENCE) : [],
  };
  return next;
};

export const rearmQuarantinedProvider = (health, providerID, { reasonCode, at = Date.now() } = {}) => {
  if (!PROVIDER_ID.test(providerID)) return normalizeHealth(health, at);
  const next = normalizeHealth(health, at);
  const current = next.providers[providerID] ?? null;
  if (!current || current.state !== "quarantined") return next;
  next.providers[providerID] = {
    ...current,
    state: "probation",
    source: "operator",
    reasonCode: normalizeReasonCode(reasonCode) ?? current.reasonCode ?? null,
    firstAt: current.firstAt ?? at,
    lastAt: at,
    evidence: Array.isArray(current.evidence) ? current.evidence.slice(-MAX_EVIDENCE) : [],
  };
  return next;
};

export const markProbationSuccessHealthy = (health, providerID, { at = Date.now() } = {}) => {
  if (!PROVIDER_ID.test(providerID)) return normalizeHealth(health);
  const next = normalizeHealth(health);
  const record = next.providers[providerID];
  const successAt = Number(at);
  if (record?.state !== "probation" || !Number.isFinite(successAt) || successAt < record.lastAt) return next;
  delete next.providers[providerID];
  return next;
};

export const providerEligible = (health, providerID, activeLeases = 0) => {
  const record = normalizeHealth(health).providers[providerID];
  if (!record || record.state === "observing") return true;
  if (record.state === "quarantined") return false;
  if (record.state === "probation") return Number(activeLeases) < 1;
  return true;
};
