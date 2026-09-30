import { spawn } from "node:child_process";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_PROTOCOL_VERSION = 1;

const MAX_PROTOCOL_FRAME_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const LAUNCH_TTL_MS = 60_000;
const PROBE_PROCESS_TTL_MS = 5 * 60_000;
const ASSIGNMENT_TTL_MS = 60_000;
const READY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 2_000;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ROLE_KEY = /^[a-z0-9][a-z0-9-]{0,99}:[a-z0-9][a-z0-9-]{0,99}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,200}$/;
const PROBE_KINDS = Object.freeze(["normal", "tool", "reasoning"]);
const PROTOCOL_TYPES = new Set(["bootstrap", "ready", "probe", "result", "error", "shutdown", "closed", "trace"]);
const TRACE_EVENTS = Object.freeze({
  "broker-registration": { path: "/resolver-process/register", brokerSocket: true },
  "broker-probe": { path: "/model-policy/probe", brokerSocket: true },
  "gateway-request": { path: "/v1/chat/completions", brokerSocket: false },
  "gateway-release-complete": { path: "/probe/release", brokerSocket: false },
});

const isPlainObject = (value) => value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const exactFields = (value, fields, label) => {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const names = Object.keys(value);
  const unknown = names.filter((name) => !fields.includes(name));
  const missing = fields.filter((name) => !Object.hasOwn(value, name));
  if (unknown.length || missing.length) {
    throw new Error(`${label} must contain exactly ${fields.join(", ")}`);
  }
  return value;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};

const canonicalJSON = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sameJSON = (left, right) => canonicalJSON(left) === canonicalJSON(right);
const cloneJSON = (value) => JSON.parse(JSON.stringify(value));

const probeFailure = (code, message, status = 409) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
};

const normalizeCandidateIdentity = (value, label = "candidateIdentity") => {
  exactFields(value, ["providerID", "modelID"], label);
  if (typeof value.providerID !== "string" || !ID.test(value.providerID)
    || typeof value.modelID !== "string" || !ID.test(value.modelID)) {
    throw new Error(`${label} is invalid`);
  }
  return { providerID: value.providerID, modelID: value.modelID };
};

const normalizeCandidateIntroduction = (value, label = "candidateIntroduction") => {
  exactFields(value, ["generation", "manifestHash"], label);
  if (!Number.isInteger(value.generation) || value.generation < 1 || !SHA256.test(value.manifestHash)) {
    throw new Error(`${label} is invalid`);
  }
  return { generation: value.generation, manifestHash: value.manifestHash };
};

const normalizeGenerationAck = (value) => {
  exactFields(value, ["generation", "manifestHash", "effectiveHash"], "generationAck");
  const introduction = normalizeCandidateIntroduction({
    generation: value.generation,
    manifestHash: value.manifestHash,
  }, "generationAck");
  if (!SHA256.test(value.effectiveHash)) throw new Error("generationAck effectiveHash is invalid");
  return { ...introduction, effectiveHash: value.effectiveHash };
};

const normalizeLaunchRequest = (request) => {
  exactFields(request, [
    "transitionID", "operationID", "expectedPolicyRevision", "roleKey",
    "candidateIdentity", "candidateIntroduction",
  ], "probe launch request");
  if (typeof request.transitionID !== "string" || !ID.test(request.transitionID)
    || typeof request.operationID !== "string" || !ID.test(request.operationID)
    || typeof request.expectedPolicyRevision !== "string" || !ID.test(request.expectedPolicyRevision)
    || typeof request.roleKey !== "string" || !ROLE_KEY.test(request.roleKey)) {
    throw new Error("probe launch request identity is invalid");
  }
  return {
    transitionID: request.transitionID,
    operationID: request.operationID,
    expectedPolicyRevision: request.expectedPolicyRevision,
    roleKey: request.roleKey,
    candidateIdentity: normalizeCandidateIdentity(request.candidateIdentity, "probe launch candidateIdentity"),
    candidateIntroduction: normalizeCandidateIntroduction(request.candidateIntroduction,
      "probe launch candidateIntroduction"),
  };
};

const normalizeProbeRequest = (request) => {
  exactFields(request, [
    "transitionID", "roleKey", "candidateIdentity", "candidateIntroduction", "probeKind", "requestID",
  ], "model probe request");
  if (typeof request.transitionID !== "string" || !ID.test(request.transitionID)
    || typeof request.roleKey !== "string" || !ROLE_KEY.test(request.roleKey)
    || !PROBE_KINDS.includes(request.probeKind)
    || typeof request.requestID !== "string" || !REQUEST_ID.test(request.requestID)) {
    throw new Error("model probe request identity is invalid");
  }
  return {
    transitionID: request.transitionID,
    roleKey: request.roleKey,
    candidateIdentity: normalizeCandidateIdentity(request.candidateIdentity, "model probe candidateIdentity"),
    candidateIntroduction: normalizeCandidateIntroduction(request.candidateIntroduction,
      "model probe candidateIntroduction"),
    probeKind: request.probeKind,
    requestID: request.requestID,
  };
};

const policyBinding = (request, modelPolicy) => {
  const role = modelPolicy?.roles?.[request.roleKey];
  if (!role || role.transitionID !== request.transitionID) {
    probeFailure("probe-transition-mismatch", "probe transition does not match staged policy");
  }
  if (request.operationID !== undefined
    && request.operationID !== `${request.transitionID}:staged-probing`) {
    probeFailure("probe-operation-mismatch", "probe operation ID must identify staged probing");
  }
  const expectedRevision = request.expectedPolicyRevision ?? role.revision;
  if (role.revision !== expectedRevision) {
    probeFailure("stale-policy-revision", "probe policy revision is stale");
  }
  const introduction = normalizeCandidateIntroduction(role.introduction, "staged policy introduction");
  if (role.probation?.phase !== "staged-probing"
    || role.activeModelID === request.candidateIdentity.modelID
    || role.probationModelID !== request.candidateIdentity.modelID) {
    probeFailure("probe-policy-not-staged", "candidate policy is not staged and non-routable");
  }
  if (role.providerID !== request.candidateIdentity.providerID
    || !sameJSON(introduction, request.candidateIntroduction)) {
    probeFailure("probe-binding-mismatch", "probe candidate binding does not match staged policy");
  }
  const acknowledged = Array.isArray(role.history) && role.history.some((entry) =>
    entry?.transitionID === request.transitionID
    && entry?.revision === role.revision
    && entry?.roleKey === request.roleKey
    && entry?.generation === introduction.generation
    && entry?.manifestHash === introduction.manifestHash)
    && Array.isArray(modelPolicy?.history) && modelPolicy.history.some((entry) =>
      entry?.transitionID === request.transitionID
      && entry?.revision === role.revision
      && entry?.roleKey === request.roleKey
      && entry?.generation === introduction.generation
      && entry?.manifestHash === introduction.manifestHash);
  if (!acknowledged) {
    probeFailure("probe-operation-unacknowledged", "staged probe operation is not acknowledged in policy history");
  }
  return {
    transitionID: request.transitionID,
    revision: role.revision,
    roleKey: request.roleKey,
    candidateIdentity: cloneJSON(request.candidateIdentity),
    candidateIntroduction: cloneJSON(request.candidateIntroduction),
  };
};

const randomToken = (prefix, randomBytes) => {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new Error(`probe random source for ${prefix} must return exactly 32 bytes`);
  }
  return `${prefix}${bytes.toString("base64url")}`;
};

export const createProbeBrokerState = ({
  now = Date.now,
  randomBytes = cryptoRandomBytes,
  onAssignmentState = () => {},
} = {}) => {
  if (typeof now !== "function" || typeof randomBytes !== "function"
    || typeof onAssignmentState !== "function") {
    throw new Error("probe broker dependencies are invalid");
  }
  const launches = new Map();
  const tokens = new Map();
  const assignments = new Map();

  const readNow = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0) throw new Error("probe broker clock returned an invalid time");
    return value;
  };

  const transitionAssignment = (record, state) => {
    record.state = state;
    onAssignmentState({ sessionID: record.sessionID, state });
  };

  const expireAssignments = () => {
    const at = readNow();
    for (const [digest, record] of launches) {
      if (record.state === "issued" && at >= record.expiresAt) record.state = "expired";
      if (record.state !== "issued" && at >= record.expiresAt + LAUNCH_TTL_MS) launches.delete(digest);
    }
    for (const [digest, record] of tokens) {
      if (at >= record.expiresAt) tokens.delete(digest);
    }
    for (const [sessionID, record] of assignments) {
      if (at < record.expiresAt) continue;
      if (record.state !== "released") transitionAssignment(record, "released");
      assignments.delete(sessionID);
    }
  };

  const issueLaunch = (rawRequest, { modelPolicy } = {}) => {
    const request = normalizeLaunchRequest(rawRequest);
    const binding = policyBinding(request, modelPolicy);
    const probeLaunchNonce = randomToken("pln_", randomBytes);
    const digest = sha256(probeLaunchNonce);
    if (launches.has(digest)) throw new Error("probe random source produced a duplicate launch nonce");
    const issuedAt = readNow();
    launches.set(digest, {
      ...binding,
      operationID: request.operationID,
      state: "issued",
      issuedAt,
      expiresAt: issuedAt + LAUNCH_TTL_MS,
    });
    return { probeLaunchNonce, expiresAt: issuedAt + LAUNCH_TTL_MS };
  };

  const redeemLaunch = (request) => {
    exactFields(request, ["generation", "manifestHash", "modelKeys", "probeLaunchNonce"],
      "probe launch redemption");
    if (!Number.isInteger(request.generation) || request.generation < 0
      || !SHA256.test(request.manifestHash ?? "")
      || !Array.isArray(request.modelKeys)
      || typeof request.probeLaunchNonce !== "string" || !/^pln_[A-Za-z0-9_-]{43}$/.test(request.probeLaunchNonce)) {
      probeFailure("invalid-probe-launch", "probe launch redemption is invalid");
    }
    const digest = sha256(request.probeLaunchNonce);
    const launch = launches.get(digest);
    if (!launch) probeFailure("invalid-probe-launch", "invalid probe launch nonce");
    const at = readNow();
    if (at >= launch.expiresAt) {
      launch.state = "expired";
      probeFailure("expired-probe-launch", "probe launch nonce expired");
    }
    if (launch.state !== "issued") {
      probeFailure("probe-launch-replayed", "probe launch nonce is already redeemed and single-use");
    }
    if (request.generation !== launch.candidateIntroduction.generation) {
      probeFailure("probe-launch-binding-mismatch", "probe generation does not match launch binding");
    }
    if (request.manifestHash !== launch.candidateIntroduction.manifestHash) {
      probeFailure("probe-launch-binding-mismatch", "probe manifest does not match launch binding");
    }
    const candidateKey = `${launch.candidateIdentity.providerID}/${launch.candidateIdentity.modelID}`;
    if (!request.modelKeys.includes(candidateKey)) {
      probeFailure("probe-launch-binding-mismatch", "probe generation manifest lacks the bound candidate");
    }
    launch.state = "redeemed";
    const resolverToken = randomToken("", randomBytes);
    const tokenDigest = sha256(resolverToken);
    if (tokens.has(tokenDigest)) throw new Error("probe random source produced a duplicate resolver token");
    for (const [priorDigest, prior] of tokens) {
      if (prior.transitionID === launch.transitionID
        && prior.revision === launch.revision
        && prior.roleKey === launch.roleKey
        && sameJSON(prior.candidateIdentity, launch.candidateIdentity)
        && sameJSON(prior.candidateIntroduction, launch.candidateIntroduction)) {
        tokens.delete(priorDigest);
      }
    }
    const tokenExpiresAt = at + PROBE_PROCESS_TTL_MS;
    tokens.set(tokenDigest, {
      ...cloneJSON(launch),
      modelKeys: [...request.modelKeys],
      tokenDigest,
      usedRequestIDs: new Set(),
      expiresAt: tokenExpiresAt,
    });
    return {
      resolverToken,
      scope: "probeFresh",
      generation: request.generation,
      manifestHash: request.manifestHash,
      expiresAt: tokenExpiresAt,
    };
  };

  const boundToken = (resolverToken, request, modelPolicy) => {
    if (typeof resolverToken !== "string") {
      probeFailure("probe-process-required", "fresh probe process token required", 403);
    }
    const token = tokens.get(sha256(resolverToken));
    if (!token || readNow() >= token.expiresAt) {
      probeFailure("probe-process-required", "fresh probe process token required", 403);
    }
    if (token.transitionID !== request.transitionID || token.roleKey !== request.roleKey
      || !sameJSON(token.candidateIdentity, request.candidateIdentity)
      || !sameJSON(token.candidateIntroduction, request.candidateIntroduction)) {
      probeFailure("probe-binding-mismatch", "fresh probe process token binding mismatch", 403);
    }
    policyBinding({ ...request, expectedPolicyRevision: token.revision }, modelPolicy);
    return token;
  };

  const issueAssignment = ({ resolverToken, request: rawRequest, modelPolicy } = {}) => {
    expireAssignments();
    const request = normalizeProbeRequest(rawRequest);
    const token = boundToken(resolverToken, request, modelPolicy);
    if (token.usedRequestIDs.has(request.requestID)) {
      probeFailure("probe-request-replayed", "probe request ID was already assigned");
    }
    token.usedRequestIDs.add(request.requestID);
    const sessionID = randomToken("gw-probe-", randomBytes);
    const probeNonce = randomToken("pbn_", randomBytes);
    if (assignments.has(sessionID)) throw new Error("probe random source produced a duplicate session ID");
    const issuedAt = readNow();
    const record = {
      sessionID,
      nonceDigest: sha256(probeNonce),
      tokenDigest: token.tokenDigest,
      transitionID: token.transitionID,
      roleKey: token.roleKey,
      candidateIdentity: cloneJSON(token.candidateIdentity),
      candidateIntroduction: cloneJSON(token.candidateIntroduction),
      generation: token.candidateIntroduction.generation,
      manifestHash: token.candidateIntroduction.manifestHash,
      modelKeys: [...token.modelKeys],
      requestID: request.requestID,
      probeKind: request.probeKind,
      state: "issued",
      issuedAt,
      expiresAt: Math.min(token.expiresAt, issuedAt + ASSIGNMENT_TTL_MS),
    };
    assignments.set(sessionID, record);
    onAssignmentState({ sessionID, state: "issued" });
    return { sessionID, probeNonce, expiresAt: record.expiresAt };
  };

  const consumeAssignment = ({ sessionID, probeNonce } = {}) => {
    expireAssignments();
    const record = assignments.get(sessionID);
    if (!record || typeof probeNonce !== "string" || sha256(probeNonce) !== record.nonceDigest) {
      probeFailure("invalid-probe-assignment", "probe assignment or nonce is invalid", 403);
    }
    if (record.state !== "issued") {
      probeFailure("probe-assignment-replayed", "probe assignment is not issued", 409);
    }
    transitionAssignment(record, "consumed-gateway-owned");
    return {
      sessionID: record.sessionID,
      preferredModel: cloneJSON(record.candidateIdentity),
      expiresAt: record.expiresAt,
    };
  };

  const releaseAssignment = ({ sessionID, probeNonce, resolverToken, owner } = {}) => {
    expireAssignments();
    const record = assignments.get(sessionID);
    if (!record) return { changed: false, state: "released" };
    if (record.state === "released") return { changed: false, state: "released" };
    if (owner === "helper") {
      if (record.state !== "issued" || typeof resolverToken !== "string"
        || sha256(resolverToken) !== record.tokenDigest) {
        return { changed: false, state: record.state };
      }
    } else if (owner === "gateway") {
      if (record.state !== "consumed-gateway-owned" || typeof probeNonce !== "string"
        || sha256(probeNonce) !== record.nonceDigest) {
        return { changed: false, state: record.state };
      }
    } else {
      probeFailure("invalid-probe-release", "probe release owner is invalid", 403);
    }
    transitionAssignment(record, "released");
    return { changed: true, state: "released" };
  };

  const assignmentForLease = (sessionID) => {
    expireAssignments();
    const record = assignments.get(sessionID);
    if (!record || record.state !== "consumed-gateway-owned") return null;
    return {
      sessionID: record.sessionID,
      preferredModel: cloneJSON(record.candidateIdentity),
      modelKeys: [...record.modelKeys],
      generation: record.generation,
      manifestHash: record.manifestHash,
    };
  };

  const status = () => {
    expireAssignments();
    const launchCounts = { issued: 0, redeemed: 0 };
    for (const record of launches.values()) {
      if (record.state === "issued" || record.state === "redeemed") launchCounts[record.state] += 1;
    }
    const assignmentCounts = { issued: 0, "consumed-gateway-owned": 0, released: 0 };
    for (const record of assignments.values()) assignmentCounts[record.state] += 1;
    return {
      launches: launchCounts,
      launchDigests: [...launches.keys()].sort(),
      assignments: assignmentCounts,
    };
  };

  return {
    issueLaunch,
    redeemLaunch,
    issueAssignment,
    consumeAssignment,
    releaseAssignment,
    assignmentForLease,
    reap: expireAssignments,
    status,
  };
};

const validateProtocolFrame = (frame) => {
  if (!isPlainObject(frame)) throw new Error("probe protocol frame must be an object");
  if (frame.version !== PROBE_PROTOCOL_VERSION) {
    throw new Error(`probe protocol version ${String(frame.version)} is unsupported`);
  }
  if (!PROTOCOL_TYPES.has(frame.type)) throw new Error(`probe protocol type ${String(frame.type)} is unsupported`);
  return frame;
};

export const createProbeProtocolParser = ({ onFrame, maxFrameBytes = MAX_PROTOCOL_FRAME_BYTES } = {}) => {
  if (typeof onFrame !== "function") throw new Error("probe protocol onFrame is required");
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) throw new Error("probe protocol frame bound is invalid");
  let buffered = Buffer.alloc(0);
  const parseLine = (line) => {
    if (line.length === 0) return;
    if (line.length > maxFrameBytes) throw new Error("probe protocol frame exceeds 64 KiB");
    let frame;
    try {
      frame = JSON.parse(line.toString("utf8"));
    } catch (error) {
      throw new Error("probe protocol frame is malformed JSON", { cause: error });
    }
    onFrame(validateProtocolFrame(frame));
  };
  const push = (chunk) => {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.length > maxFrameBytes) throw new Error("probe protocol frame exceeds 64 KiB");
        return;
      }
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      parseLine(line);
    }
  };
  const end = () => {
    if (buffered.length) throw new Error("probe protocol ended with a partial frame");
  };
  return { push, end };
};

const requestIDFor = ({ kind, ordinaryModel, candidateIntroduction, rolePolicy }) => `mpr_${sha256(canonicalJSON({
  kind,
  ordinaryModel,
  candidateIntroduction,
  effortCeiling: rolePolicy.effortCeiling,
  requiredReasoningMode: rolePolicy.requiredReasoningMode,
})).slice(0, 32)}`;

const semanticRequest = ({ kind, requestID, ordinaryModel, candidateIntroduction, rolePolicy }) => {
  const base = {
    model: ordinaryModel,
    messages: [{ role: "user", content: "Compatibility probe: reply with PROBE_OK." }],
    stream: false,
  };
  if (kind === "tool") {
    base.messages = [{ role: "user", content: "Call probe_echo once with {\"ok\":true}. Do not answer in text." }];
    base.tools = [{
      type: "function",
      function: {
        name: "probe_echo",
        description: "No-side-effect compatibility probe",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean", const: true } },
          required: ["ok"],
        },
      },
    }];
    base.tool_choice = { type: "function", function: { name: "probe_echo" } };
  }
  if (kind === "reasoning") {
    base.reasoning_effort = rolePolicy.requiredReasoningMode ?? rolePolicy.effortCeiling;
  }
  return {
    kind,
    requestID,
    ordinaryModel,
    candidateIntroduction: cloneJSON(candidateIntroduction),
    gatewayRequest: base,
  };
};

const toolResponseValid = (response) => {
  const calls = response?.body?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.function?.name !== "probe_echo") return false;
  try {
    return JSON.parse(calls[0].function.arguments)?.ok === true;
  } catch {
    return false;
  }
};

export const runModelCompatibilityProbes = async ({
  probeClient,
  rolePolicy,
  ordinaryModel,
  candidateIntroduction,
  probeKinds = PROBE_KINDS,
  onResult = async () => {},
  now = Date.now,
} = {}) => {
  if (!probeClient || typeof probeClient.probe !== "function") throw new Error("probeClient facade is required");
  if (!isPlainObject(rolePolicy)
    || typeof rolePolicy.effortCeiling !== "string"
    || !(rolePolicy.requiredReasoningMode === null || typeof rolePolicy.requiredReasoningMode === "string")) {
    throw new Error("probe rolePolicy is invalid");
  }
  if (typeof ordinaryModel !== "string" || !ordinaryModel) throw new Error("ordinary probe model is required");
  const introduction = normalizeCandidateIntroduction(candidateIntroduction);
  if (!Array.isArray(probeKinds) || probeKinds.some((kind) => !PROBE_KINDS.includes(kind))
    || new Set(probeKinds).size !== probeKinds.length) {
    throw new Error("probeKinds must be a unique canonical subset");
  }
  if (typeof onResult !== "function" || typeof now !== "function") throw new Error("probe callbacks are invalid");
  const results = [];
  for (const kind of probeKinds) {
    const requestID = requestIDFor({ kind, ordinaryModel, candidateIntroduction: introduction, rolePolicy });
    const response = await probeClient.probe(semanticRequest({
      kind,
      requestID,
      ordinaryModel,
      candidateIntroduction: introduction,
      rolePolicy,
    }));
    const successfulStatus = Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
    const success = kind === "tool" ? successfulStatus && toolResponseValid(response) : successfulStatus;
    const result = {
      kind,
      requestID,
      success,
      failureClass: success ? null : kind === "tool"
        ? "invalid-model-tool-call-response"
        : kind === "reasoning" ? "invalid-model-reasoning-response" : "invalid-model-normal-response",
      observedAt: now(),
    };
    await onResult(cloneJSON(result));
    results.push(result);
  }
  return results;
};

const helperPath = fileURLToPath(new URL("../bin/opencode-broker-probe-client", import.meta.url));
const defaultSpawnProbeProcess = ({ command, args, options }) => spawn(command, args, options);

const encodeFrame = (frame) => {
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
  if (bytes.length - 1 > MAX_PROTOCOL_FRAME_BYTES) throw new Error("probe protocol frame exceeds 64 KiB");
  return bytes;
};

const boundedRedacted = (bytes, secrets) => {
  let text = bytes.subarray(0, MAX_STDERR_BYTES).toString("utf8");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) text = text.split(secret).join("[redacted]");
  }
  return text;
};

export const createProbeClientFactory = ({
  spawnProbeProcess = defaultSpawnProbeProcess,
  generationManager,
  brokerSocketPath,
  gatewayURL,
  gatewayHeaders,
  onTrace = () => {},
  now = Date.now,
} = {}) => {
  if (typeof spawnProbeProcess !== "function" || typeof generationManager?.generation !== "function"
    || typeof generationManager?.paths !== "function" || typeof brokerSocketPath !== "string" || !brokerSocketPath
    || typeof gatewayURL !== "string" || !gatewayURL || !isPlainObject(gatewayHeaders)
    || typeof onTrace !== "function"
    || typeof now !== "function") {
    throw new Error("probe client factory dependencies are invalid");
  }

  const open = async ({
    transitionID,
    roleKey,
    candidateIdentity,
    candidateIntroduction,
    generationAck,
    ordinaryModel,
    probeLaunchNonce,
  } = {}) => {
    if (typeof transitionID !== "string" || !ID.test(transitionID)
      || typeof roleKey !== "string" || !ROLE_KEY.test(roleKey)
      || typeof ordinaryModel !== "string" || !ordinaryModel
      || typeof probeLaunchNonce !== "string" || !/^pln_[A-Za-z0-9_-]{43}$/.test(probeLaunchNonce)) {
      throw new Error("probe client open identity is invalid");
    }
    const identity = normalizeCandidateIdentity(candidateIdentity);
    const introduction = normalizeCandidateIntroduction(candidateIntroduction);
    const ack = normalizeGenerationAck(generationAck);
    if (ack.generation !== introduction.generation) {
      throw new Error("probe candidate generation ack mismatch");
    }
    if (ack.manifestHash !== introduction.manifestHash) {
      throw new Error("probe candidate manifest ack mismatch");
    }
    const bundle = generationManager.generation(ack.generation);
    if (bundle.generation !== ack.generation) throw new Error("probe generation ack generation mismatch");
    if (bundle.manifestHash !== ack.manifestHash) throw new Error("probe generation manifest ack mismatch");
    if (bundle.effectiveHash !== ack.effectiveHash) throw new Error("probe generation effective ack mismatch");
    const candidateKey = `${identity.providerID}/${identity.modelID}`;
    if (!Array.isArray(bundle.manifest?.modelKeys) || !bundle.manifest.modelKeys.includes(candidateKey)) {
      throw new Error("probe candidate is absent from the exact generation manifest");
    }
    const generationRoot = generationManager.paths().root;
    const expectedDirectory = resolve(join(generationRoot, `generation-${ack.generation}`));
    if (resolve(bundle.directory) !== expectedDirectory || dirname(expectedDirectory) !== resolve(generationRoot)) {
      throw new Error("probe generation directory is not canonical under the generation root");
    }

    const bootstrap = {
      version: PROBE_PROTOCOL_VERSION,
      type: "bootstrap",
      brokerSocketPath,
      gatewayURL,
      gatewayHeaders: cloneJSON(gatewayHeaders),
      generationRoot,
      transitionID,
      roleKey,
      candidateIdentity: identity,
      candidateIntroduction: introduction,
      generationAck: ack,
      ordinaryModel,
      probeLaunchNonce,
    };
    const child = spawnProbeProcess({
      command: process.execPath,
      args: [helperPath],
      options: { stdio: ["pipe", "pipe", "pipe"] },
    });
    if (!child || !child.stdin || !child.stdout || !child.stderr || typeof child.once !== "function") {
      throw new Error("probe spawn adapter returned an invalid child process");
    }
    const pending = new Map();
    let ready = false;
    let exited = false;
    let exitError = null;
    let stderr = Buffer.alloc(0);
    let closePromise = null;
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolveReadyPromise, rejectReadyPromise) => {
      resolveReady = resolveReadyPromise;
      rejectReady = rejectReadyPromise;
    });
    const secrets = [
      probeLaunchNonce,
      identity.modelID,
      ...Object.values(gatewayHeaders).filter((value) => typeof value === "string"),
    ];

    const rejectPending = (error) => {
      for (const record of pending.values()) {
        clearTimeout(record.timer);
        record.reject(error);
      }
      pending.clear();
    };
    const fail = (error) => {
      const diagnostic = boundedRedacted(stderr, secrets);
      const wrapped = diagnostic
        ? new Error(`${error.message}: ${diagnostic}`, { cause: error })
        : error;
      if (!ready) rejectReady(wrapped);
      rejectPending(wrapped);
    };
    const parser = createProbeProtocolParser({
      onFrame: (frame) => {
        if (frame.type === "trace") {
          exactFields(frame, [
            "version", "type", "event", "pid", "requestID", "path", "socketPath", "assignmentHash", "generation",
          ], "probe trace frame");
          const expected = TRACE_EVENTS[frame.event];
          if (!expected || frame.pid !== child.pid
            || typeof frame.requestID !== "string" || !REQUEST_ID.test(frame.requestID)
            || frame.path !== expected.path
            || (expected.brokerSocket ? frame.socketPath !== brokerSocketPath : frame.socketPath !== null)
            || (frame.event === "broker-registration"
              ? frame.requestID !== "bootstrap" || frame.assignmentHash !== null
                || frame.generation !== ack.generation
              : !SHA256.test(frame.assignmentHash ?? "") || frame.generation !== null)) {
            throw new Error("probe helper emitted an invalid trace frame");
          }
          onTrace(Object.freeze({
            event: frame.event,
            pid: frame.pid,
            requestID: frame.requestID,
            path: frame.path,
            socketPath: frame.socketPath,
            assignmentHash: frame.assignmentHash,
            generation: frame.generation,
          }));
          return;
        }
        if (frame.type === "ready") {
          if (ready) throw new Error("probe helper emitted duplicate ready frame");
          ready = true;
          resolveReady();
          return;
        }
        if (frame.type === "result" || frame.type === "error") {
          const record = pending.get(frame.requestID);
          if (!record) throw new Error("probe helper emitted an uncorrelated response");
          pending.delete(frame.requestID);
          clearTimeout(record.timer);
          if (frame.type === "error") record.reject(new Error(frame.error || "probe helper request failed"));
          else record.resolve(frame.response);
          return;
        }
        if (frame.type !== "closed") throw new Error(`probe helper emitted unexpected ${frame.type} frame`);
      },
    });
    child.stdout.on("data", (chunk) => {
      try { parser.push(chunk); } catch (error) { fail(error); }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length >= MAX_STDERR_BYTES) return;
      stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(0, MAX_STDERR_BYTES);
    });
    let resolveExitPromise;
    const exitPromise = new Promise((resolveExit) => { resolveExitPromise = resolveExit; });
    const observeExit = (code, signal) => {
      if (exited) return;
      exited = true;
      if (!ready || pending.size) {
        exitError ??= new Error(`probe helper exited before completion (${code ?? signal ?? "unknown"})`);
        fail(exitError);
      }
      resolveExitPromise();
    };
    child.once("exit", observeExit);
    child.once("close", observeExit);
    child.once("error", (error) => { exitError = error; fail(error); });
    const waitBounded = (ms) => Promise.race([
      exitPromise.then(() => true),
      new Promise((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), ms);
        timer.unref?.();
      }),
    ]);
    const terminateChild = async () => {
      if (exited) return;
      child.kill("SIGTERM");
      if (!await waitBounded(CLOSE_GRACE_MS)) {
        child.kill("SIGKILL");
        await exitPromise;
      }
    };

    const readinessTimer = setTimeout(() => {
      const error = new Error("probe helper readiness handshake timed out after 10 seconds");
      exitError = error;
      fail(error);
    }, READY_TIMEOUT_MS);
    readinessTimer.unref?.();
    try {
      child.stdin.write(encodeFrame(bootstrap));
      await readyPromise;
    } catch (error) {
      await terminateChild();
      throw error;
    } finally {
      clearTimeout(readinessTimer);
    }

    const writeFrame = (frame) => new Promise((resolveWrite, rejectWrite) => {
      if (exited || child.stdin.destroyed) return rejectWrite(exitError ?? new Error("probe helper stdin is closed"));
      const bytes = encodeFrame(frame);
      child.stdin.write(bytes, (error) => error ? rejectWrite(error) : resolveWrite());
    });
    const probe = async (request) => {
      if (!isPlainObject(request) || typeof request.requestID !== "string" || !REQUEST_ID.test(request.requestID)) {
        throw new Error("probe facade request is invalid");
      }
      if (pending.has(request.requestID)) throw new Error("probe facade requestID is already pending");
      const response = new Promise((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => {
          pending.delete(request.requestID);
          rejectResponse(new Error(`probe request ${request.requestID} timed out`));
        }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        pending.set(request.requestID, { resolve: resolveResponse, reject: rejectResponse, timer });
      });
      try {
        await writeFrame({ version: PROBE_PROTOCOL_VERSION, type: "probe", requestID: request.requestID, request });
      } catch (error) {
        const record = pending.get(request.requestID);
        if (record) clearTimeout(record.timer);
        pending.delete(request.requestID);
        throw error;
      }
      return response;
    };
    const close = () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let closeError = null;
        if (!exited) {
          try { await writeFrame({ version: PROBE_PROTOCOL_VERSION, type: "shutdown" }); }
          catch (error) { closeError = error; }
          if (!await waitBounded(CLOSE_GRACE_MS)) {
            await terminateChild();
          }
        }
        await exitPromise;
        if (closeError) throw closeError;
      })();
      return closePromise;
    };
    return Object.freeze({ probe, close });
  };
  return Object.freeze({ open });
};
