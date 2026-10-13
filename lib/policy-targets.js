import { CONFIG } from "./config.js";
import { matchModelRole, REASONING_MODES } from "./model-roles.js";
import { markManagedOutageScope, policyReserveIDs } from "./outage-policy.js";

// The staged candidates the model policy has NOT admitted yet: a probation model that is not
// the role's active model (in probation, or rolled back). The outage head calculation keeps
// these out of head candidacy -- a probation-only newer release must not displace the reviewed
// pin as the scope's ordinary head while the staged policy is still trialling it.
export const probationOnlyModelKeys = (modelPolicy) => {
  const keys = new Set();
  const roles = modelPolicy?.roles && typeof modelPolicy.roles === "object" ? modelPolicy.roles : {};
  for (const role of Object.values(roles)) {
    if (!role || typeof role.providerID !== "string" || typeof role.probationModelID !== "string") continue;
    if (role.probationModelID === role.activeModelID) continue;
    keys.add(`${role.providerID}/${role.probationModelID}`);
  }
  return keys;
};

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
  // Reserve IDs the outage gate has authorized for THIS lane (lib/outage-policy.js). They are
  // admitted through the same role governance as every other member below; nothing here makes
  // them ordinary -- chooseTarget still selects a reserve only under its grant.
  reserveTargetIDs = [],
  outagePolicy = CONFIG.modelOutages,
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
  // Outage routing must distinguish a genuinely unrelated target from a target in a managed
  // role whose catalog record cannot establish family/speed metadata. Mark FIRST, so every
  // entry below -- including the candidates derived from the role's routing intent -- is built
  // from the marked record and ordinaryAllowed can fail closed on the ambiguous managed role
  // without broad-blocking unrelated families.
  const markedTargets = markManagedOutageScope(targets, { policy: outagePolicy, modelRoles: CONFIG.modelRoles }) ?? {};
  const entries = inputIDs.map((id) => ({ id, target: markedTargets?.[id] }))
    .filter((entry) => entry.target);
  // Only an ID the reviewed policy lists as a reserve can be admitted as one, whatever the
  // caller passed: the lane never widens on an unlisted ID.
  const listedReserves = policyReserveIDs(outagePolicy);
  const reserveIDs = new Set((Array.isArray(reserveTargetIDs) ? reserveTargetIDs : []).filter((id) => listedReserves.has(id)));
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
    // An authorized outage reserve is a reviewed stand-in for this role's head: it rides the
    // role's tier intent exactly like the active member does (a role that does not route this
    // tier admits neither), and like the steady-state active member it keeps its own
    // configured fit/effort rather than a derived candidate.
    for (const entry of candidates) {
      if (reserveIDs.has(entry.id)) allowed.add(entry.id);
    }

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

  const changedTargets = { ...markedTargets, ...derived };
  return {
    targetIDs: inputIDs.filter((id) => allowed.has(id)),
    targets: changedTargets,
    policyTargetID,
    candidateOpportunityTargetID,
    reason: touched ? "model-policy-active" : null,
    blockedGeneration,
  };
};
