import { CONFIG } from "./config.js";
import { matchModelRole, REASONING_MODES } from "./model-roles.js";

const modelKey = (target) => target?.providerID && target?.modelID
  ? `${target.providerID}/${target.modelID}`
  : null;

const roleKeyForTarget = (target) => {
  const matched = matchModelRole(target?.providerID, {
    id: target?.modelID,
    family: target?.family,
  }, CONFIG.modelRoles);
  return matched.status === "known" ? matched.roleKey : null;
};

const capabilitySatisfied = (target, role) => Object.entries(role?.requiredCapabilities ?? {})
  .every(([name, required]) => target?.capabilities?.[name] === required);

const effectiveEffort = (target, routingIntent) => {
  const ceiling = REASONING_MODES.indexOf(routingIntent?.effortCeiling);
  if (ceiling < 0 || !Array.isArray(target?.variants)) return null;
  const advertised = new Set(target.variants);
  const required = routingIntent.requiredReasoningMode;
  if (required !== null && (!advertised.has(required) || REASONING_MODES.indexOf(required) > ceiling)) {
    return null;
  }
  for (let index = ceiling; index >= 0; index -= 1) {
    if (advertised.has(REASONING_MODES[index])) return REASONING_MODES[index];
  }
  return null;
};

const deriveCandidate = (target, policy, role) => {
  if (!target || !capabilitySatisfied(target, role)) return null;
  const effort = effectiveEffort(target, policy.routingIntent);
  if (effort === null) return null;
  return {
    ...target,
    tiers: [...policy.routingIntent.tiers],
    fit: { ...policy.routingIntent.fit },
    effort: Object.fromEntries(policy.routingIntent.tiers.map((tier) => [tier, effort])),
    effortCeiling: effort,
    requiredReasoningMode: policy.routingIntent.requiredReasoningMode,
  };
};

const leaseUsesCandidate = (leases, candidateIDs) => (Array.isArray(leases) ? leases : [])
  .some((lease) => candidateIDs.has(lease?.targetID));

export const resolvePolicyLane = ({
  targetIDs = [],
  targets = {},
  modelPolicy,
  registration,
  activeLeases = [],
  tier,
  enabled,
} = {}) => {
  const inputIDs = Array.isArray(targetIDs) ? targetIDs : [];
  if (enabled !== true) {
    return {
      targetIDs: [...inputIDs],
      targets,
      policyTargetID: null,
      candidateOpportunityTargetID: null,
      reason: null,
      blockedGeneration: false,
    };
  }

  const governed = modelPolicy?.roles && typeof modelPolicy.roles === "object"
    ? modelPolicy.roles
    : {};
  const entries = inputIDs.map((id) => ({ id, target: targets?.[id] }))
    .filter((entry) => entry.target);
  const roleEntries = new Map();
  const ungoverned = new Set();
  let touched = false;
  for (const entry of entries) {
    const roleKey = roleKeyForTarget(entry.target);
    if (!roleKey || !governed[roleKey]) {
      ungoverned.add(entry.id);
      continue;
    }
    touched = true;
    if (!roleEntries.has(roleKey)) roleEntries.set(roleKey, []);
    roleEntries.get(roleKey).push(entry);
  }

  const allowed = new Set(ungoverned);
  const derived = {};
  const registeredKeys = new Set(Array.isArray(registration?.modelKeys) ? registration.modelKeys : []);
  let policyTargetID = null;
  let candidateOpportunityTargetID = null;
  let blockedGeneration = false;

  for (const [roleKey, candidates] of roleEntries) {
    const policy = governed[roleKey];
    if (!Array.isArray(policy?.routingIntent?.tiers) || !policy.routingIntent.tiers.includes(tier)) continue;
    const role = CONFIG.modelRoles[roleKey];
    if (!role) continue;

    const entriesForModel = (modelID) => candidates.filter((entry) => entry.target.modelID === modelID);
    const incumbentID = policy.rollbackModelID ?? policy.incumbentModelID;
    const activeEntries = entriesForModel(policy.activeModelID);
    const probationEntries = entriesForModel(policy.probationModelID);
    const probationKey = policy.probationModelID ? `${policy.providerID}/${policy.probationModelID}` : null;
    const activeKey = policy.activeModelID ? `${policy.providerID}/${policy.activeModelID}` : null;
    const activeIsIntroduced = policy.activeModelID !== null && policy.activeModelID !== policy.incumbentModelID;

    if (activeIsIntroduced) {
      const compatible = activeKey !== null && registeredKeys.has(activeKey);
      const activeCandidate = compatible ? deriveCandidate(activeEntries[0]?.target, policy, role) : null;
      if (activeCandidate) {
        for (const entry of activeEntries) allowed.add(entry.id);
        derived[activeEntries[0].id] = activeCandidate;
      } else {
        if (!compatible && activeEntries.length) blockedGeneration = true;
        for (const entry of entriesForModel(incumbentID)) allowed.add(entry.id);
      }
      continue;
    }

    for (const entry of activeEntries) allowed.add(entry.id);
    if (!policy.probationModelID || policy.probation?.phase !== "probation" || !probationEntries.length) continue;

    const compatible = probationKey !== null && registeredKeys.has(probationKey);
    if (!compatible) {
      blockedGeneration = true;
      continue;
    }
    const offerEvery = Number(policy.probation.offerEvery);
    const cursor = Number(policy.probation.opportunityCursor);
    const onOffer = Number.isInteger(offerEvery) && offerEvery > 0 && Number.isInteger(cursor) && cursor >= 0
      && cursor % offerEvery === 0;
    const candidateIDs = new Set(probationEntries.map((entry) => entry.id));
    const candidate = deriveCandidate(probationEntries[0].target, policy, role);
    if (!candidate) continue;
    derived[probationEntries[0].id] = candidate;
    if (leaseUsesCandidate(activeLeases, candidateIDs)) continue;
    if (candidateOpportunityTargetID === null) candidateOpportunityTargetID = probationEntries[0].id;
    if (!onOffer) continue;
    for (const entry of probationEntries) allowed.add(entry.id);
    if (policyTargetID === null) policyTargetID = probationEntries[0].id;
  }

  const changedTargets = Object.keys(derived).length
    ? { ...targets, ...derived }
    : targets;
  return {
    targetIDs: inputIDs.filter((id) => allowed.has(id)),
    targets: changedTargets,
    policyTargetID,
    candidateOpportunityTargetID,
    reason: touched ? "model-policy-active" : null,
    blockedGeneration,
  };
};
