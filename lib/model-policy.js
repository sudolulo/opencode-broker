import { createHash } from "node:crypto";

import { matchModelRole, REASONING_MODES, TIER_NAMES } from "./model-roles.js";

export const MODEL_POLICY_VERSION = 1;

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ROLE_KEY = /^([a-z0-9][a-z0-9-]{0,99}):([a-z0-9][a-z0-9-]{0,99})$/;
const POLICY_FIELDS = Object.freeze(["version", "roles", "history"]);
const ROLE_FIELDS = Object.freeze([
  "roleKey", "providerID", "incumbentModelID", "activeModelID", "probationModelID",
  "rollbackModelID", "routingIntent", "introduction", "probation", "revision",
  "transitionID", "history",
]);
const ROUTING_FIELDS = Object.freeze(["tiers", "fit", "effortCeiling", "requiredReasoningMode"]);
const INTRODUCTION_FIELDS = Object.freeze(["generation", "manifestHash"]);
const PROBATION_FIELDS = Object.freeze([
  "phase", "offerEvery", "opportunityCursor", "opportunityMs", "opportunityCursorAt",
  "opportunityEligibleUntil", "successes", "failures", "leases",
]);
const PROBATION_PHASES = Object.freeze(["staged-probing", "probation", "active", "rolled-back"]);
const ACK_FIELDS = Object.freeze([
  "transitionID", "revision", "roleKey", "generation", "manifestHash", "desiredHash", "appliedAt",
]);
const REQUEST_FIELDS = Object.freeze([
  "transitionID", "revision", "roleKey", "expectedIncumbentModelID", "generation", "manifestHash", "desired",
]);
const DESIRED_FIELDS = Object.freeze([
  "activeModelID", "probationModelID", "rollbackModelID", "routingIntent", "probation",
]);

const fail = (message) => { throw new Error(`model policy ${message}`); };
const plainObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
};
const rejectUnknown = (value, fields, label) => {
  const unsupported = Object.keys(value).filter((field) => !fields.includes(field));
  if (unsupported.length) fail(`${label} carries unsupported field(s) ${unsupported.join(", ")}`);
};
const requireExactFields = (value, fields, label) => {
  rejectUnknown(value, fields, label);
  const missing = fields.filter((field) => !(field in value));
  if (missing.length) fail(`${label} is missing field(s) ${missing.join(", ")}`);
};
const normalizeID = (value, label, { nullable = false } = {}) => {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} must be a non-empty identifier`);
  return value;
};
const normalizeRoleKey = (value, label = "roleKey") => {
  const match = typeof value === "string" ? value.match(ROLE_KEY) : null;
  if (!match) fail(`${label} must be providerID:roleID`);
  return { roleKey: value, providerID: match[1] };
};
const normalizeGeneration = (value, label = "generation") => {
  if (!Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
};
const normalizeManifestHash = (value, label = "manifestHash") => {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${label} must be a lowercase sha256 hash`);
  return value;
};
const normalizeTimestamp = (value, label, { nullable = false } = {}) => {
  if (nullable && value === null) return null;
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative finite timestamp`);
  return value;
};
const normalizeCounter = (value, label, { positive = false } = {}) => {
  if (!Number.isInteger(value) || value < (positive ? 1 : 0)) {
    fail(`${label} must be a ${positive ? "positive" : "non-negative"} integer`);
  }
  return value;
};
const cloneJSON = (value, label) => {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(`${label} must be JSON data`);
    return JSON.parse(encoded);
  } catch (error) {
    if (String(error?.message ?? error).startsWith("model policy ")) throw error;
    fail(`${label} must be JSON data`);
  }
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const canonicalHash = (value) => createHash("sha256")
  .update(JSON.stringify(canonicalize(value)))
  .digest("hex");

const normalizeRoutingIntent = (value, label) => {
  value = plainObject(value, label);
  requireExactFields(value, ROUTING_FIELDS, label);
  if (!Array.isArray(value.tiers) || !value.tiers.length) fail(`${label}.tiers must be a non-empty array`);
  const tiers = [];
  for (const tier of value.tiers) {
    if (!TIER_NAMES.includes(tier)) fail(`${label}.tiers contains unknown tier ${JSON.stringify(tier)}`);
    if (tiers.includes(tier)) fail(`${label}.tiers contains duplicate tier ${tier}`);
    tiers.push(tier);
  }
  const fitValue = plainObject(value.fit, `${label}.fit`);
  const fit = {};
  for (const [tier, weight] of Object.entries(fitValue)) {
    if (!tiers.includes(tier)) fail(`${label}.fit names tier ${tier} outside tiers`);
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      fail(`${label}.fit.${tier} must be a positive finite number`);
    }
    fit[tier] = weight;
  }
  if (!REASONING_MODES.includes(value.effortCeiling)) {
    fail(`${label}.effortCeiling must be one of ${REASONING_MODES.join(", ")}`);
  }
  if (value.requiredReasoningMode !== null && !REASONING_MODES.includes(value.requiredReasoningMode)) {
    fail(`${label}.requiredReasoningMode must be null or one of ${REASONING_MODES.join(", ")}`);
  }
  return {
    tiers,
    fit,
    effortCeiling: value.effortCeiling,
    requiredReasoningMode: value.requiredReasoningMode,
  };
};

const normalizeProbation = (value, label) => {
  value = plainObject(value, label);
  requireExactFields(value, PROBATION_FIELDS, label);
  if (!PROBATION_PHASES.includes(value.phase)) {
    fail(`${label}.phase must be one of ${PROBATION_PHASES.join(", ")}`);
  }
  if (!Array.isArray(value.successes)) fail(`${label}.successes must be an array`);
  if (!Array.isArray(value.failures)) fail(`${label}.failures must be an array`);
  plainObject(value.leases, `${label}.leases`);
  return {
    phase: value.phase,
    offerEvery: normalizeCounter(value.offerEvery, `${label}.offerEvery`, { positive: true }),
    opportunityCursor: normalizeCounter(value.opportunityCursor, `${label}.opportunityCursor`),
    opportunityMs: normalizeCounter(value.opportunityMs, `${label}.opportunityMs`),
    opportunityCursorAt: normalizeTimestamp(value.opportunityCursorAt, `${label}.opportunityCursorAt`, { nullable: true }),
    opportunityEligibleUntil: normalizeTimestamp(value.opportunityEligibleUntil, `${label}.opportunityEligibleUntil`, { nullable: true }),
    successes: cloneJSON(value.successes, `${label}.successes`),
    failures: cloneJSON(value.failures, `${label}.failures`),
    leases: cloneJSON(value.leases, `${label}.leases`),
  };
};

const normalizeAck = (value, label) => {
  value = plainObject(value, label);
  requireExactFields(value, ACK_FIELDS, label);
  normalizeRoleKey(value.roleKey, `${label}.roleKey`);
  return {
    transitionID: normalizeID(value.transitionID, `${label}.transitionID`),
    revision: normalizeID(value.revision, `${label}.revision`),
    roleKey: value.roleKey,
    generation: normalizeGeneration(value.generation, `${label}.generation`),
    manifestHash: normalizeManifestHash(value.manifestHash, `${label}.manifestHash`),
    desiredHash: normalizeManifestHash(value.desiredHash, `${label}.desiredHash`),
    appliedAt: normalizeTimestamp(value.appliedAt, `${label}.appliedAt`),
  };
};

const normalizeHistory = (value, label) => {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((entry, index) => normalizeAck(entry, `${label}[${index}]`));
};

const normalizeDesired = (value, label = "desired") => {
  value = plainObject(value, label);
  requireExactFields(value, DESIRED_FIELDS, label);
  return {
    activeModelID: normalizeID(value.activeModelID, `${label}.activeModelID`, { nullable: true }),
    probationModelID: normalizeID(value.probationModelID, `${label}.probationModelID`, { nullable: true }),
    rollbackModelID: normalizeID(value.rollbackModelID, `${label}.rollbackModelID`, { nullable: true }),
    routingIntent: normalizeRoutingIntent(value.routingIntent, `${label}.routingIntent`),
    probation: normalizeProbation(value.probation, `${label}.probation`),
  };
};

const desiredFromRole = (role) => ({
  activeModelID: role.activeModelID,
  probationModelID: role.probationModelID,
  rollbackModelID: role.rollbackModelID,
  routingIntent: role.routingIntent,
  probation: role.probation,
});

const modelMatchesRole = (modelID, roleKey, providerID, modelRoles) => {
  if (modelID === null) return true;
  const match = matchModelRole(providerID, { id: modelID }, modelRoles);
  return match.status === "known" && match.roleKey === roleKey;
};

const normalizeRoleRecord = (value, key, { modelRoles, staticTargets }) => {
  value = plainObject(value, `roles.${key}`);
  requireExactFields(value, ROLE_FIELDS, `roles.${key}`);
  const parsed = normalizeRoleKey(key, `roles key ${key}`);
  if (value.roleKey !== key) fail(`roles.${key}.roleKey mismatch`);
  const configuredRole = modelRoles?.[key];
  if (!configuredRole) fail(`roles.${key} is not a configured model role`);
  if (value.providerID !== parsed.providerID || configuredRole.providerID !== parsed.providerID) {
    fail(`roles.${key}.providerID mismatch`);
  }
  const incumbentModelID = normalizeID(value.incumbentModelID, `roles.${key}.incumbentModelID`, { nullable: true });
  const activeModelID = normalizeID(value.activeModelID, `roles.${key}.activeModelID`, { nullable: true });
  const probationModelID = normalizeID(value.probationModelID, `roles.${key}.probationModelID`, { nullable: true });
  const rollbackModelID = normalizeID(value.rollbackModelID, `roles.${key}.rollbackModelID`, { nullable: true });
  for (const [field, modelID] of Object.entries({ incumbentModelID, activeModelID, probationModelID, rollbackModelID })) {
    if (!modelMatchesRole(modelID, key, parsed.providerID, modelRoles)) {
      fail(`roles.${key}.${field} model does not match its role`);
    }
  }
  if (incumbentModelID !== null && !Object.values(staticTargets ?? {}).some((target) =>
    target?.providerID === parsed.providerID && target?.modelID === incumbentModelID)) {
    fail(`roles.${key}.incumbentModelID has no matching static target`);
  }
  const routingIntent = normalizeRoutingIntent(value.routingIntent, `roles.${key}.routingIntent`);
  const introductionValue = plainObject(value.introduction, `roles.${key}.introduction`);
  requireExactFields(introductionValue, INTRODUCTION_FIELDS, `roles.${key}.introduction`);
  const introduction = {
    generation: normalizeGeneration(introductionValue.generation, `roles.${key}.introduction.generation`),
    manifestHash: normalizeManifestHash(introductionValue.manifestHash, `roles.${key}.introduction.manifestHash`),
  };
  const probation = normalizeProbation(value.probation, `roles.${key}.probation`);
  const revision = normalizeID(value.revision, `roles.${key}.revision`);
  const transitionID = normalizeID(value.transitionID, `roles.${key}.transitionID`);
  const history = normalizeHistory(value.history, `roles.${key}.history`);
  const latest = history.at(-1);
  if (!latest || latest.roleKey !== key || latest.transitionID !== transitionID || latest.revision !== revision ||
    latest.generation !== introduction.generation || latest.manifestHash !== introduction.manifestHash ||
    latest.desiredHash !== canonicalHash({ activeModelID, probationModelID, rollbackModelID, routingIntent, probation })) {
    fail(`roles.${key}.history does not acknowledge the current policy`);
  }
  return {
    roleKey: key,
    providerID: parsed.providerID,
    incumbentModelID,
    activeModelID,
    probationModelID,
    rollbackModelID,
    routingIntent,
    introduction,
    probation,
    revision,
    transitionID,
    history,
  };
};

export const emptyModelPolicy = () => ({ version: MODEL_POLICY_VERSION, roles: {}, history: [] });

export const normalizeModelPolicy = (value, { modelRoles, staticTargets } = {}) => {
  value = plainObject(value, "root");
  rejectUnknown(value, POLICY_FIELDS, "root");
  if (value.version !== MODEL_POLICY_VERSION) {
    fail(`version ${JSON.stringify(value.version)} is unsupported; expected ${MODEL_POLICY_VERSION}`);
  }
  const rolesValue = plainObject(value.roles, "roles");
  if (!Array.isArray(value.history)) fail("history must be an array");
  const history = normalizeHistory(value.history, "history");
  const roles = {};
  for (const [key, role] of Object.entries(rolesValue)) {
    roles[key] = normalizeRoleRecord(role, key, { modelRoles, staticTargets });
    const latest = roles[key].history.at(-1);
    if (!history.some((entry) => JSON.stringify(entry) === JSON.stringify(latest))) {
      fail(`history is missing the current acknowledgement for ${key}`);
    }
  }
  return { version: MODEL_POLICY_VERSION, roles, history };
};

const normalizeRequest = (value) => {
  value = plainObject(value, "CAS request");
  requireExactFields(value, REQUEST_FIELDS, "CAS request");
  const parsed = normalizeRoleKey(value.roleKey, "CAS request.roleKey");
  return {
    transitionID: normalizeID(value.transitionID, "CAS request.transitionID"),
    revision: normalizeID(value.revision, "CAS request.revision"),
    roleKey: value.roleKey,
    providerID: parsed.providerID,
    expectedIncumbentModelID: normalizeID(value.expectedIncumbentModelID,
      "CAS request.expectedIncumbentModelID", { nullable: true }),
    generation: normalizeGeneration(value.generation, "CAS request.generation"),
    manifestHash: normalizeManifestHash(value.manifestHash, "CAS request.manifestHash"),
    desired: normalizeDesired(value.desired, "CAS request.desired"),
  };
};

export const compareAndSwapModelPolicy = (current, request, { now = Date.now } = {}) => {
  const normalizedRequest = normalizeRequest(request);
  const policy = cloneJSON(current, "current policy");
  if (policy?.version !== MODEL_POLICY_VERSION || !policy.roles || typeof policy.roles !== "object" ||
    Array.isArray(policy.roles) || !Array.isArray(policy.history)) {
    fail("current policy is malformed");
  }
  const desiredHash = canonicalHash(normalizedRequest.desired);
  const present = policy.roles[normalizedRequest.roleKey];
  if (present?.transitionID === normalizedRequest.transitionID) {
    if (present.revision !== normalizedRequest.revision) fail("CAS stale revision for existing transition");
    if (present.incumbentModelID !== normalizedRequest.expectedIncumbentModelID) fail("CAS incumbent mismatch");
    if (present.introduction?.generation !== normalizedRequest.generation) fail("CAS replay generation mismatch");
    if (present.introduction?.manifestHash !== normalizedRequest.manifestHash) fail("CAS replay manifest hash mismatch");
    const ack = Array.isArray(present.history) ? present.history.at(-1) : null;
    if (!ack || ack.desiredHash !== desiredHash) fail("CAS replay desired policy hash mismatch");
    return { policy, ack: cloneJSON(ack, "ack"), changed: false };
  }
  if (policy.history.some((entry) => entry?.transitionID === normalizedRequest.transitionID ||
    entry?.revision === normalizedRequest.revision)) {
    fail("CAS stale revision or transition replay");
  }
  const currentIncumbent = present ? present.activeModelID : normalizedRequest.expectedIncumbentModelID;
  if (currentIncumbent !== normalizedRequest.expectedIncumbentModelID) fail("CAS incumbent mismatch");
  if (!present && normalizedRequest.desired.activeModelID !== normalizedRequest.expectedIncumbentModelID) {
    fail("CAS incumbent mismatch while seeding role");
  }
  const ack = {
    transitionID: normalizedRequest.transitionID,
    revision: normalizedRequest.revision,
    roleKey: normalizedRequest.roleKey,
    generation: normalizedRequest.generation,
    manifestHash: normalizedRequest.manifestHash,
    desiredHash,
    appliedAt: normalizeTimestamp(now(), "CAS clock"),
  };
  const previousRoleHistory = Array.isArray(present?.history) ? present.history : [];
  policy.roles[normalizedRequest.roleKey] = {
    roleKey: normalizedRequest.roleKey,
    providerID: normalizedRequest.providerID,
    incumbentModelID: normalizedRequest.expectedIncumbentModelID,
    ...normalizedRequest.desired,
    introduction: {
      generation: normalizedRequest.generation,
      manifestHash: normalizedRequest.manifestHash,
    },
    revision: normalizedRequest.revision,
    transitionID: normalizedRequest.transitionID,
    history: [...previousRoleHistory, ack],
  };
  policy.history.push(ack);
  return { policy, ack: cloneJSON(ack, "ack"), changed: true };
};

// Unix-domain sockets have no remote address. If the broker ever gains a TCP listener,
// only the IPv4/IPv6 loopback forms remain authorized for model-policy control calls.
export const isLoopbackControlAddress = (address) => address === undefined || address === null ||
  address === "::1" || /^127(?:\.\d{1,3}){3}$/.test(address) || /^::ffff:127(?:\.\d{1,3}){3}$/.test(address);
