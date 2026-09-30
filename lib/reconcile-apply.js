// Cross-store reconciliation saga. The ledger records intent and acknowledgements, while the
// overlay, generation manager, broker, and fresh probe process retain their own authority. Every
// ledger update is deliberately separated from external work so the reconciliation lock is never
// held across filesystem rendering, broker calls, or model execution.
import { createHash } from "node:crypto";

import { runModelCompatibilityProbes } from "./model-probe.js";
import { buildResolverOverlay, hashResolverOverlay } from "./reconcile-overlay.js";

const PROBE_KINDS = Object.freeze(["normal", "tool", "reasoning"]);
const MAX_BLOCKED_REASON_LENGTH = 512;
const AUTHORIZED_STATES = new Set(["auto-eligible", "approved"]);
const RECOVERABLE_STATES = new Set(["auto-eligible", "approved", "probing", "probation", "rolled-back"]);
const incompleteRecord = (record) => Boolean(record?.applyIntent)
  && !record.probationAck
  && !(record.state === "rolled-back" && record.probeRollbackAck)
  && RECOVERABLE_STATES.has(record.state);

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const canonicalJSON = (value) => JSON.stringify(canonicalize(value));
const canonicalHash = (value) => createHash("sha256").update(canonicalJSON(value)).digest("hex");
const same = (left, right) => canonicalJSON(left) === canonicalJSON(right);

const candidateModelID = (record) => record?.candidateModelID ?? record?.modelID ?? null;

const locateTransition = (state, transitionID) => {
  const matches = [];
  for (const field of ["roles", "unknown"]) {
    for (const [key, record] of Object.entries(state?.[field] ?? {})) {
      if (record?.transitionID === transitionID) matches.push({ field, key, record });
    }
  }
  if (matches.length !== 1) {
    throw new Error(matches.length ? `transition ${transitionID} is duplicated` : `transition ${transitionID} was not found`);
  }
  return matches[0];
};

const updateTransition = (store, transitionID, mutate) => store.update((state) => {
  const found = locateTransition(state, transitionID);
  const nextRecord = mutate(clone(found.record), state);
  if (!plainObject(nextRecord)) throw new Error(`transition ${transitionID} update returned no record`);
  state[found.field][found.key] = nextRecord;
  return state;
});

const durableRecord = (store, transitionID) => locateTransition(store.read(), transitionID).record;

// Runtime fields and presentation timestamps do not participate. Recovery must derive the same
// revision after the record moves from approved through probing and probation.
const intentRevision = (record) => canonicalHash({
  transitionID: record.transitionID,
  roleKey: record.roleKey,
  providerID: record.providerID,
  roleID: record.roleID ?? null,
  candidateModelID: candidateModelID(record),
  candidateReleaseDate: record.candidateReleaseDate ?? record.releaseDate ?? null,
  incumbentModelID: record.incumbentModelID ?? null,
  proposedTiers: record.proposedTiers ?? [],
  proposedFit: record.proposedFit ?? {},
  proposedEffortCeiling: record.proposedEffortCeiling ?? null,
  requiredReasoningMode: record.requiredReasoningMode ?? null,
  evidenceRevision: record.evidenceRevision ?? null,
  evidence: record.evidence ?? [],
  approval: record.approval ?? null,
});

const candidateIdentity = (record) => {
  const modelID = candidateModelID(record);
  if (typeof record?.providerID !== "string" || !record.providerID
    || typeof modelID !== "string" || !modelID
    || typeof record?.roleKey !== "string" || !record.roleKey) {
    throw new Error(`transition ${record?.transitionID ?? "unknown"} has incomplete candidate identity`);
  }
  return { providerID: record.providerID, modelID };
};

const rolePolicy = (record) => {
  const effortCeiling = record.proposedEffortCeiling;
  const requiredReasoningMode = record.requiredReasoningMode ?? null;
  if (typeof effortCeiling !== "string") {
    throw new Error(`transition ${record.transitionID} has no effort ceiling`);
  }
  return { effortCeiling, requiredReasoningMode };
};

const routingIntent = (record) => ({
  tiers: [...(record.proposedTiers ?? [])],
  fit: { ...(record.proposedFit ?? {}) },
  effortCeiling: rolePolicy(record).effortCeiling,
  requiredReasoningMode: rolePolicy(record).requiredReasoningMode,
});

const emptyProbation = (phase) => ({
  phase,
  offerEvery: 5,
  opportunityCursor: 0,
  opportunityMs: 0,
  opportunityCursorAt: null,
  opportunityEligibleUntil: null,
  successes: [],
  failures: [],
  leases: {},
});

const stagedDesired = (record) => ({
  activeModelID: record.incumbentModelID ?? null,
  probationModelID: candidateModelID(record),
  rollbackModelID: record.incumbentModelID ?? null,
  routingIntent: routingIntent(record),
  probation: emptyProbation("staged-probing"),
});

const probationDesired = (record, staged) => ({
  activeModelID: record.incumbentModelID ?? null,
  probationModelID: candidateModelID(record),
  rollbackModelID: record.incumbentModelID ?? null,
  routingIntent: routingIntent(record),
  probation: { ...(staged?.probation ?? emptyProbation("probation")), phase: "probation" },
});

const roleDesired = (role) => role ? {
  activeModelID: role.activeModelID,
  probationModelID: role.probationModelID,
  rollbackModelID: role.rollbackModelID,
  routingIntent: role.routingIntent,
  probation: role.probation,
} : null;

const latestAck = (role) => Array.isArray(role?.history) ? role.history.at(-1) : null;

const exactPolicyMatch = (role, request) => Boolean(role)
  && role.transitionID === request.transitionID
  && role.revision === request.revision
  && role.roleKey === request.roleKey
  && role.introduction?.generation === request.generation
  && role.introduction?.manifestHash === request.manifestHash
  && same(roleDesired(role), request.desired)
  && latestAck(role)?.transitionID === request.transitionID
  && latestAck(role)?.revision === request.revision
  && latestAck(role)?.generation === request.generation
  && latestAck(role)?.manifestHash === request.manifestHash;

const validateAck = (ack, request, label) => {
  if (!plainObject(ack)
    || ack.transitionID !== request.transitionID
    || ack.revision !== request.revision
    || ack.roleKey !== request.roleKey
    || ack.generation !== request.generation
    || ack.manifestHash !== request.manifestHash
    || ack.desiredHash !== canonicalHash(request.desired)
    || !Number.isFinite(ack.appliedAt)) {
    throw new Error(`${label} acknowledgement mismatch`);
  }
  return clone(ack);
};

const sourceCatalog = (sources) => sources?.catalogModels ?? sources?.catalog?.data ?? null;
const sourceFlag = (sources, group, field) => sources?.[group]?.[field] ?? false;

const validateSources = (sources, record, expectedAuthRevision = null) => {
  if (!plainObject(sources)) throw new Error("reconciliation source collection returned no sources");
  for (const group of ["catalog", "resolver"]) {
    if (sourceFlag(sources, group, "stale")) throw new Error(`${group} source is stale`);
    if (sourceFlag(sources, group, "empty")) throw new Error(`${group} source is empty`);
    if (sourceFlag(sources, group, "error")) throw new Error(`${group} source refresh failed`);
  }
  const before = sources.authRevision ?? sources.auth?.before ?? null;
  const after = sources.authRevisionAfter ?? sources.auth?.after ?? before;
  if (!before || before !== after) throw new Error("authentication revision changed during apply");
  if (expectedAuthRevision !== null && before !== expectedAuthRevision) {
    throw new Error("authentication revision changed since apply intent");
  }
  const identity = candidateIdentity(record);
  const catalog = sourceCatalog(sources);
  const provider = catalog?.[identity.providerID];
  const model = provider?.models?.[identity.modelID] ?? provider?.[identity.modelID];
  if (!plainObject(model)) throw new Error(`catalog is missing exact candidate ${identity.providerID}/${identity.modelID}`);
  if (typeof sources.baseConfigPath !== "string" || !sources.baseConfigPath) {
    throw new Error("apply source collection is missing the base resolver config path");
  }
  if (!plainObject(sources.modelRoles) || !sources.modelRoles[record.roleKey]) {
    throw new Error(`apply source collection is missing model role ${record.roleKey}`);
  }
  if (typeof sources.ordinaryModel !== "string" || !sources.ordinaryModel) {
    throw new Error("apply source collection is missing the ordinary probe model");
  }
  return { authRevision: before, catalogModels: catalog };
};

const blockedError = (error) => /stale|mismatch|conflict|corrupt|changed|missing|absent|unknown or cleaned|regressed|incomplete candidate identity|has no effort ceiling|broker model-policy status is malformed|cannot find .*broker policy|source is empty|source refresh failed|unable to render resolver generation|listed no usable models/i
  .test(String(error?.message ?? error));

const blockedState = (error) => {
  const message = String(error?.message ?? error);
  if (/source is stale|source is empty|source refresh failed/i.test(message)) return "blocked-stale";
  if (/missing exact|missing overlay model|absent from the exact generation manifest|unable to render resolver generation|listed no usable models/i.test(message)) {
    return "blocked-unresolvable";
  }
  return "blocked-conflict";
};

const persistBlocked = (store, transitionID, error, now) => {
  try {
    updateTransition(store, transitionID, (record) => {
      const state = blockedState(error);
      const reason = String(error?.message ?? error).slice(0, MAX_BLOCKED_REASON_LENGTH);
      return {
        ...record,
        state,
        reason,
        stateChangedAt: now(),
        transitions: record.transitions?.at(-1) === state
          ? record.transitions : [...(record.transitions ?? []), state],
      };
    });
  } catch {
    // The original error is the actionable failure. A concurrent transition replacement is itself
    // why this best-effort presentation marker could not be recorded.
  }
};

const persistProbeResult = (store, transitionID, result, rollbackAck = null) => {
  const write = () => updateTransition(store, transitionID, (record) => {
    const present = record.probeResults?.[result.kind];
    if (present && !same(present, result)) throw new Error(`probe result conflict for ${result.kind}`);
    return {
      ...record,
      probeResults: { ...(record.probeResults ?? {}), [result.kind]: clone(result) },
      ...(rollbackAck === null ? {} : {
        state: "rolled-back",
        reason: result.failureClass,
        stateChangedAt: rollbackAck.appliedAt,
        transitions: record.transitions?.at(-1) === "rolled-back"
          ? record.transitions : [...(record.transitions ?? []), "rolled-back"],
        probeRollbackAck: clone(rollbackAck),
      }),
    };
  });
  try {
    write();
  } catch (error) {
    const durable = durableRecord(store, transitionID);
    const present = durable.probeResults?.[result.kind];
    if (present && same(present, result)
      && (rollbackAck === null || same(durable.probeRollbackAck, rollbackAck))) return;
    if (present) throw new Error(`probe result conflict for ${result.kind}`, { cause: error });
    throw error;
  }
};

const requestIDFor = ({ kind, ordinaryModel, introduction, policy }) => `mpr_${canonicalHash({
  kind,
  ordinaryModel,
  candidateIntroduction: introduction,
  effortCeiling: policy.effortCeiling,
  requiredReasoningMode: policy.requiredReasoningMode,
}).slice(0, 32)}`;

const closeProbeClient = async (client, primary) => {
  let closeError = null;
  try {
    await client.close();
  } catch (error) {
    closeError = error;
  }
  if (primary && closeError) throw new AggregateError([primary, closeError], "probe lifecycle and close both failed");
  if (primary) throw primary;
  if (closeError) throw closeError;
};

const allResults = (record) => PROBE_KINDS.map((kind) => record.probeResults?.[kind]).filter(Boolean);

const protectedReferences = (modelPolicy) => {
  const references = [];
  for (const [roleKey, role] of Object.entries(modelPolicy?.roles ?? {})) {
    for (const [kind, modelID] of [
      ["active", role?.activeModelID],
      ["probation", role?.probationModelID],
      ["rollback", role?.rollbackModelID],
    ]) {
      if (typeof role?.providerID === "string" && typeof modelID === "string" && modelID) {
        references.push({ roleKey, kind, modelKey: `${role.providerID}/${modelID}` });
      }
    }
  }
  return references;
};

export const createReconciliationApplier = ({
  store,
  overlayStore,
  generationManager,
  brokerRequest,
  probeClientFactory,
  collectSources,
  now = Date.now,
} = {}) => {
  if (typeof store?.read !== "function" || typeof store?.update !== "function"
    || typeof overlayStore?.read !== "function" || typeof overlayStore?.write !== "function"
    || typeof generationManager?.readRegistry !== "function" || typeof generationManager?.build !== "function"
    || typeof generationManager?.publish !== "function" || typeof generationManager?.generation !== "function"
    || typeof brokerRequest !== "function" || typeof probeClientFactory?.open !== "function"
    || typeof collectSources !== "function" || typeof now !== "function") {
    throw new Error("reconciliation applier dependencies are incomplete");
  }

  const status = async () => {
    const response = await brokerRequest("/model-policy/status", {});
    if (!plainObject(response?.modelPolicy?.roles)) throw new Error("broker model-policy status is malformed");
    return response.modelPolicy;
  };

  const applyCAS = async (request, label) => {
    const policy = await status();
    const present = policy.roles[request.roleKey];
    if (exactPolicyMatch(present, request)) return validateAck(latestAck(present), request, label);
    if (present?.transitionID === request.transitionID || present?.revision === request.revision) {
      throw new Error(`${label} status mismatch for an already committed transition`);
    }
    const response = await brokerRequest("/model-policy/cas", request);
    return validateAck(response?.ack, request, label);
  };

  const rollbackRequest = (record, intent, generationAck, currentRole, { kind, reason }) => {
    const suffix = kind === "manual" ? "rollback" : `probe-rollback:${kind}`;
    const transitionID = `${record.transitionID}:${suffix}`;
    const revision = canonicalHash({ intent: intent.revision, suffix, reason });
    const rollbackModelID = currentRole?.rollbackModelID ?? record.incumbentModelID ?? null;
    return {
      transitionID,
      revision,
      roleKey: record.roleKey,
      expectedIncumbentModelID: currentRole?.activeModelID ?? record.incumbentModelID ?? null,
      generation: generationAck.generation,
      manifestHash: generationAck.manifestHash,
      desired: {
        activeModelID: rollbackModelID,
        probationModelID: null,
        rollbackModelID,
        routingIntent: currentRole?.routingIntent ?? routingIntent(record),
        probation: {
          ...(currentRole?.probation ?? emptyProbation("rolled-back")),
          phase: "rolled-back",
          opportunityCursorAt: null,
          opportunityEligibleUntil: null,
        },
      },
    };
  };

  const rollbackProbe = async (record, intent, generationAck, result) => {
    const policy = await status();
    const currentRole = policy.roles[record.roleKey];
    if (!currentRole) throw new Error("probe rollback cannot find staged broker policy");
    const request = rollbackRequest(record, intent, generationAck, currentRole, {
      kind: result.kind,
      reason: result.failureClass,
    });
    const ack = exactPolicyMatch(currentRole, request)
      ? validateAck(latestAck(currentRole), request, "probe rollback")
      : validateAck((await brokerRequest("/model-policy/cas", request))?.ack, request, "probe rollback");
    return { request, ack };
  };

  const recoverCommittedProbeRollback = async (record, intent, generationAck, sources) => {
    const policy = await status();
    const role = policy.roles[record.roleKey];
    const prefix = `${record.transitionID}:probe-rollback:`;
    if (!role?.transitionID?.startsWith(prefix)) return null;
    const kind = role.transitionID.slice(prefix.length);
    if (!PROBE_KINDS.includes(kind)) throw new Error("probe rollback status has an unknown probe kind");
    const failureClass = kind === "tool"
      ? "invalid-model-tool-call-response"
      : kind === "reasoning" ? "invalid-model-reasoning-response" : "invalid-model-normal-response";
    const request = rollbackRequest(record, intent, generationAck, role, { kind, reason: failureClass });
    if (!exactPolicyMatch(role, request)) throw new Error("probe rollback status mismatch");
    const ack = validateAck(latestAck(role), request, "probe rollback");
    const policyInput = rolePolicy(record);
    const result = {
      kind,
      requestID: requestIDFor({
        kind,
        ordinaryModel: sources.ordinaryModel,
        introduction: { generation: generationAck.generation, manifestHash: generationAck.manifestHash },
        policy: policyInput,
      }),
      success: false,
      failureClass,
      observedAt: ack.appliedAt,
    };
    persistProbeResult(store, record.transitionID, result, ack);
    return result;
  };

  const recoverManualRollback = async (record, intent, generationAck) => {
    if (record.state !== "rolled-back" || !record.probeRollbackAck) return null;
    const policy = await status();
    const role = policy.roles[record.roleKey];
    if (role?.transitionID !== `${record.transitionID}:rollback`) return null;
    const request = rollbackRequest(record, intent, generationAck, role, {
      kind: "manual",
      reason: record.reason,
    });
    if (!exactPolicyMatch(role, request)) throw new Error("manual rollback broker status mismatch");
    const ack = validateAck(record.probeRollbackAck, request, "manual rollback");
    validateAck(latestAck(role), request, "manual rollback broker status");
    return { ok: true, mutated: false, transitionID: record.transitionID, state: "rolled-back", rollbackAck: ack };
  };

  const ensureIntent = (record, sources) => {
    if (record.applyIntent) {
      if (record.applyIntent.revision !== intentRevision(record)) {
        throw new Error("apply intent revision mismatch");
      }
      if (!record.probationAck) validateSources(sources, record, record.applyIntent.authRevision);
      return record.applyIntent;
    }
    if (!AUTHORIZED_STATES.has(record.state)) {
      throw new Error(`transition ${record.transitionID} is not authorized for apply`);
    }
    const validated = validateSources(sources, record);
    const previous = overlayStore.read();
    const registry = generationManager.readRegistry();
    const intent = {
      transitionID: record.transitionID,
      revision: intentRevision(record),
      reservedGeneration: registry.highWater + 1,
      overlayUpdatedAt: now(),
      authRevision: validated.authRevision,
      previousOverlayHash: hashResolverOverlay(previous),
      previousOverlayRevision: previous.revision,
      catalogModels: clone(validated.catalogModels),
    };
    updateTransition(store, record.transitionID, (current) => {
      if (current.applyIntent) {
        if (!same(current.applyIntent, intent)) throw new Error("concurrent apply intent conflict");
        return current;
      }
      if (!AUTHORIZED_STATES.has(current.state) || intentRevision(current) !== intent.revision) {
        throw new Error("transition changed before apply intent reservation");
      }
      return { ...current, applyIntent: intent };
    });
    return intent;
  };

  const ensureGeneration = async (record, intent, sources) => {
    if (record.generationAck) {
      const durable = generationManager.generation(record.generationAck.generation);
      if (durable.manifestHash !== record.generationAck.manifestHash
        || durable.effectiveHash !== record.generationAck.effectiveHash
        || (record.overlayAck && durable.manifest?.overlayHash !== record.overlayAck.hash)) {
        throw new Error("generation acknowledgement mismatch");
      }
      return record.generationAck;
    }
    const previous = overlayStore.read();
    const desired = buildResolverOverlay({
      ledger: store.read(),
      modelRoles: sources.modelRoles,
      catalogModels: intent.catalogModels,
      introductionGeneration: intent.reservedGeneration,
      overlayUpdatedAt: intent.overlayUpdatedAt,
      previous,
    });
    const overlayResult = overlayStore.write(desired, {
      expectedPreviousHash: intent.previousOverlayHash,
      expectedRevision: intent.previousOverlayRevision,
    });
    const overlayAck = { hash: overlayResult.hash, revision: overlayResult.revision };
    const authorizingRevisions = Object.values(desired.entries).map((entry) => entry.revision).sort();
    const registry = generationManager.readRegistry();
    let candidate;
    if (registry.highWater >= intent.reservedGeneration) {
      if (registry.highWater !== intent.reservedGeneration) {
        throw new Error(`reserved generation ${intent.reservedGeneration} is stale`);
      }
      candidate = generationManager.generation(intent.reservedGeneration);
      if (candidate.manifest?.overlayHash !== overlayAck.hash
        || !same(candidate.manifest?.authorizingRevisions, authorizingRevisions)) {
        throw new Error("published generation acknowledgement mismatch");
      }
      const current = generationManager.current?.();
      if (!current || current.generation !== candidate.generation || current.manifestHash !== candidate.manifestHash) {
        candidate = await generationManager.publish(candidate);
      }
    } else {
      const references = sources.protectedReferences ?? protectedReferences(await status());
      candidate = await generationManager.build({
        reservedGeneration: intent.reservedGeneration,
        baseConfigPath: sources.baseConfigPath,
        overlay: desired,
        authorizingRevisions,
        protectedReferences: references,
        authorizedRetirements: sources.authorizedRetirements ?? [],
      });
      candidate = await generationManager.publish(candidate);
    }
    const generationAck = {
      generation: candidate.generation,
      manifestHash: candidate.manifestHash,
      effectiveHash: candidate.effectiveHash,
    };
    updateTransition(store, record.transitionID, (current) => {
      if (!same(current.applyIntent, intent)) throw new Error("apply intent changed before generation acknowledgement");
      if (current.generationAck && !same(current.generationAck, generationAck)) {
        throw new Error("generation acknowledgement conflict");
      }
      return { ...current, overlayAck, generationAck };
    });
    return generationAck;
  };

  const ensureStagedPolicy = async (record, intent, generationAck) => {
    const desired = stagedDesired(record);
    const request = {
      transitionID: record.transitionID,
      revision: intent.revision,
      roleKey: record.roleKey,
      expectedIncumbentModelID: record.incumbentModelID ?? null,
      generation: generationAck.generation,
      manifestHash: generationAck.manifestHash,
      desired,
    };
    if (!record.policyPending) {
      updateTransition(store, record.transitionID, (current) => ({
        ...current,
        state: "probing",
        transitions: current.transitions?.at(-1) === "probing"
          ? current.transitions : [...(current.transitions ?? []), "probing"],
        policyPending: clone(request),
      }));
    } else if (!same(record.policyPending, request)) {
      throw new Error("staged policy pending intent mismatch");
    }
    record = durableRecord(store, record.transitionID);
    if (record.brokerAck) {
      validateAck(record.brokerAck, request, "staged policy");
      const policy = await status();
      if (!exactPolicyMatch(policy.roles[record.roleKey], request)) {
        throw new Error("staged broker acknowledgement status mismatch");
      }
      return record.brokerAck;
    }
    const ack = await applyCAS(request, "staged policy");
    updateTransition(store, record.transitionID, (current) => {
      if (!same(current.policyPending, request)) throw new Error("staged policy intent changed before acknowledgement");
      return { ...current, brokerAck: ack };
    });
    return ack;
  };

  const runMissingProbes = async (record, intent, generationAck, sources) => {
    const results = allResults(record);
    const failed = results.find((result) => result.success !== true);
    if (failed) throw new Error(`probe ${failed.kind} failed (${failed.failureClass})`);
    const missing = PROBE_KINDS.filter((kind) => !record.probeResults?.[kind]);
    if (!missing.length) return;

    const introduction = { generation: generationAck.generation, manifestHash: generationAck.manifestHash };
    const identity = candidateIdentity(record);
    const launch = await brokerRequest("/model-policy/probe-launch", {
      transitionID: record.transitionID,
      operationID: `${record.transitionID}:staged-probing`,
      expectedPolicyRevision: intent.revision,
      roleKey: record.roleKey,
      candidateIdentity: identity,
      candidateIntroduction: introduction,
    });
    if (typeof launch?.probeLaunchNonce !== "string" || !launch.probeLaunchNonce) {
      throw new Error("probe launch returned no nonce");
    }
    const client = await probeClientFactory.open({
      transitionID: record.transitionID,
      roleKey: record.roleKey,
      candidateIdentity: identity,
      candidateIntroduction: introduction,
      generationAck,
      ordinaryModel: sources.ordinaryModel,
      probeLaunchNonce: launch.probeLaunchNonce,
    });
    let primary = null;
    try {
      await runModelCompatibilityProbes({
        probeClient: client,
        rolePolicy: rolePolicy(record),
        ordinaryModel: sources.ordinaryModel,
        candidateIntroduction: introduction,
        probeKinds: missing,
        now,
        onResult: async (rawResult) => {
          let result = clone(rawResult);
          if (result.success !== true) {
            const rollback = await rollbackProbe(record, intent, generationAck, result);
            // The broker acknowledgement is the durable clock for the crash window between
            // rollback and terminal ledger write. Recovery can reconstruct these exact bytes.
            result = { ...result, observedAt: rollback.ack.appliedAt };
            persistProbeResult(store, record.transitionID, result, rollback.ack);
            throw new Error(`probe ${result.kind} failed (${result.failureClass})`);
          }
          persistProbeResult(store, record.transitionID, result);
        },
      });
    } catch (error) {
      primary = error;
    }
    await closeProbeClient(client, primary);
  };

  const ensureProbeAck = (record) => {
    const results = allResults(record);
    if (results.length !== PROBE_KINDS.length) throw new Error("probe result set is incomplete");
    const failed = results.find((result) => result.success !== true);
    if (failed) throw new Error(`probe ${failed.kind} failed (${failed.failureClass})`);
    const desired = {
      revision: record.applyIntent.revision,
      resultsHash: canonicalHash(Object.fromEntries(PROBE_KINDS.map((kind) => [kind, record.probeResults[kind]]))),
      acknowledgedAt: now(),
    };
    if (record.probeAck) {
      if (record.probeAck.revision !== desired.revision || record.probeAck.resultsHash !== desired.resultsHash) {
        throw new Error("aggregate probe acknowledgement mismatch");
      }
      return record.probeAck;
    }
    updateTransition(store, record.transitionID, (current) => {
      for (const kind of PROBE_KINDS) {
        if (!same(current.probeResults?.[kind], record.probeResults[kind])) {
          throw new Error(`probe result ${kind} changed before aggregate acknowledgement`);
        }
      }
      return { ...current, probeAck: desired };
    });
    return desired;
  };

  const ensureProbation = async (record, intent, generationAck) => {
    const staged = stagedDesired(record);
    const desired = probationDesired(record, staged);
    const request = {
      transitionID: `${record.transitionID}:probation`,
      revision: canonicalHash({ intent: intent.revision, phase: "probation" }),
      roleKey: record.roleKey,
      expectedIncumbentModelID: record.incumbentModelID ?? null,
      generation: generationAck.generation,
      manifestHash: generationAck.manifestHash,
      desired,
    };
    if (!record.probationPending) {
      updateTransition(store, record.transitionID, (current) => ({ ...current, probationPending: clone(request) }));
    } else if (!same(record.probationPending, request)) {
      throw new Error("probation pending intent mismatch");
    }
    record = durableRecord(store, record.transitionID);
    if (record.probationAck) {
      validateAck(record.probationAck, request, "probation policy");
      const policy = await status();
      if (!exactPolicyMatch(policy.roles[record.roleKey], request)) {
        throw new Error("probation broker acknowledgement status mismatch");
      }
      return record.probationAck;
    }
    const ack = await applyCAS(request, "probation policy");
    updateTransition(store, record.transitionID, (current) => ({
      ...current,
      state: "probation",
      stateChangedAt: ack.appliedAt,
      transitions: current.transitions?.at(-1) === "probation"
        ? current.transitions : [...(current.transitions ?? []), "probation"],
      probationAck: ack,
    }));
    return ack;
  };

  const drive = async (transitionID, sources, { createIntent }) => {
    let record = durableRecord(store, transitionID);
    if (!createIntent && !record.applyIntent) throw new Error(`transition ${transitionID} has no apply intent to recover`);
    if (!RECOVERABLE_STATES.has(record.state)) throw new Error(`transition ${transitionID} cannot be recovered from ${record.state}`);
    const intent = ensureIntent(record, sources);
    record = durableRecord(store, transitionID);
    const generationAck = await ensureGeneration(record, intent, sources);
    record = durableRecord(store, transitionID);
    const manualRollback = await recoverManualRollback(record, intent, generationAck);
    if (manualRollback) return { ...manualRollback, generationAck };
    const recoveredFailure = await recoverCommittedProbeRollback(record, intent, generationAck, sources);
    if (recoveredFailure) {
      throw new Error(`probe ${recoveredFailure.kind} failed (${recoveredFailure.failureClass})`);
    }
    record = durableRecord(store, transitionID);
    // A durable terminal acknowledgement means every earlier ledger boundary already committed.
    // Validate the broker's exact final state, but never replay staging or probe work merely to
    // walk through intermediate phases that are already superseded.
    if (record.probationPending || record.probationAck) {
      const probationAck = await ensureProbation(record, intent, generationAck);
      return {
        ok: true,
        mutated: !record.probationAck,
        transitionID,
        state: "probation",
        generationAck,
        probationAck,
      };
    }
    await ensureStagedPolicy(record, intent, generationAck);
    record = durableRecord(store, transitionID);
    await runMissingProbes(record, intent, generationAck, sources);
    record = durableRecord(store, transitionID);
    ensureProbeAck(record);
    record = durableRecord(store, transitionID);
    const probationAck = await ensureProbation(record, intent, generationAck);
    return { ok: true, mutated: true, transitionID, state: "probation", generationAck, probationAck };
  };

  const collect = async () => await collectSources();

  const apply = async ({ transitionID, dryRun = false } = {}) => {
    if (typeof transitionID !== "string" || !transitionID) throw new Error("apply needs a transition ID");
    const sources = await collect();
    const record = durableRecord(store, transitionID);
    if (dryRun) {
      validateSources(sources, record, record.applyIntent?.authRevision ?? null);
      return { ok: true, dryRun: true, mutated: false, transitionID, state: record.state };
    }
    try {
      return await drive(transitionID, sources, { createIntent: true });
    } catch (error) {
      if (blockedError(error)) persistBlocked(store, transitionID, error, now);
      throw error;
    }
  };

  const recover = async ({ transitionID, dryRun = false } = {}) => {
    const sources = await collect();
    const state = store.read();
    const transitions = transitionID ? [transitionID] : [
      ...Object.values(state.roles ?? {}),
      ...Object.values(state.unknown ?? {}),
    ].filter(incompleteRecord).map((record) => record.transitionID).sort();
    if (dryRun) return { ok: true, dryRun: true, mutated: false, transitions };
    const results = [];
    for (const id of transitions) {
      try {
        results.push(await drive(id, sources, { createIntent: false }));
      } catch (error) {
        if (blockedError(error)) persistBlocked(store, id, error, now);
        throw error;
      }
    }
    return transitionID ? results[0] : { ok: true, mutated: results.length > 0, results };
  };

  const rollback = async ({ transitionID, reason, dryRun = false } = {}) => {
    if (typeof transitionID !== "string" || !transitionID) throw new Error("rollback needs a transition ID");
    if (typeof reason !== "string" || !reason.trim()) throw new Error("rollback needs a reason");
    const record = durableRecord(store, transitionID);
    if (dryRun) return { ok: true, dryRun: true, mutated: false, transitionID, reason };
    try {
      if (!record.applyIntent || !record.generationAck) throw new Error("rollback requires an acknowledged apply generation");
      const policy = await status();
      const role = policy.roles[record.roleKey];
      if (!role) throw new Error("rollback cannot find broker policy for the transition role");
      if (role.introduction?.generation !== record.generationAck.generation
        || role.introduction?.manifestHash !== record.generationAck.manifestHash) {
        throw new Error("rollback broker generation status mismatch");
      }
      const request = rollbackRequest(record, record.applyIntent, record.generationAck, role, {
        kind: "manual",
        reason: reason.trim(),
      });
      if (record.probeRollbackAck) {
        const ack = validateAck(record.probeRollbackAck, request, "manual rollback");
        if (record.state !== "rolled-back" || record.reason !== reason.trim()
          || !exactPolicyMatch(role, request)) {
          throw new Error("manual rollback ledger and broker status mismatch");
        }
        return { ok: true, mutated: false, transitionID, reason: reason.trim(), rollbackAck: ack };
      }
      const ack = exactPolicyMatch(role, request)
        ? validateAck(latestAck(role), request, "manual rollback")
        : validateAck((await brokerRequest("/model-policy/cas", request))?.ack, request, "manual rollback");
      updateTransition(store, transitionID, (current) => ({
        ...current,
        state: "rolled-back",
        reason: reason.trim(),
        stateChangedAt: ack.appliedAt,
        transitions: current.transitions?.at(-1) === "rolled-back"
          ? current.transitions : [...(current.transitions ?? []), "rolled-back"],
        probeRollbackAck: ack,
      }));
      return { ok: true, mutated: true, transitionID, reason: reason.trim(), rollbackAck: ack };
    } catch (error) {
      if (blockedError(error)) persistBlocked(store, transitionID, error, now);
      throw error;
    }
  };

  const refresh = async ({ dryRun = false } = {}) => {
    const sources = await collect();
    const state = store.read();
    const transitions = [...Object.values(state.roles ?? {}), ...Object.values(state.unknown ?? {})]
      .filter((record) => incompleteRecord(record) || (!record?.applyIntent && AUTHORIZED_STATES.has(record?.state)))
      .map((record) => record.transitionID)
      .sort();
    if (dryRun) {
      for (const id of transitions) validateSources(sources, durableRecord(store, id));
      return { ok: true, dryRun: true, mutated: false, transitions };
    }
    const results = [];
    for (const id of transitions) {
      try {
        results.push(await drive(id, sources, { createIntent: true }));
      } catch (error) {
        if (blockedError(error)) persistBlocked(store, id, error, now);
        throw error;
      }
    }
    return { ok: true, mutated: results.length > 0, results };
  };

  return { apply, rollback, refresh, recover };
};
