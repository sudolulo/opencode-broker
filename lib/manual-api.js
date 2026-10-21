// Manual API reserves are a closed, static allowlist.  This module intentionally
// has no config import: callers supply already-normalized deployment data.
const fail = (message) => { throw new Error(`manualApiTargets: ${message}`); };

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

const contains = (value, id) => Array.isArray(value) && value.includes(id);

const rawContains = (value, id) => {
  if (Array.isArray(value)) return value.some((entry) => rawContains(entry, id));
  return value === id;
};

const inMembership = (memberships, id) => Object.values(memberships ?? {}).some((value) => rawContains(value, id));

export const normalizeManualApiTargets = (raw, context = {}) => {
  if (raw === undefined) return Object.freeze({});
  if (!record(raw)) fail('must be an object from target IDs to profile arrays');

  const targets = record(context.targets) ? context.targets : {};
  const profiles = record(context.profiles) ? context.profiles : {};
  const offline = new Set(Array.isArray(context.offlineProfiles) ? context.offlineProfiles : []);
  const trusted = new Set(Array.isArray(context.trustedSubscriptionProviders) ? context.trustedSubscriptionProviders : []);
  const result = {};
  const registeredProviders = new Map();

  for (const [targetID, allowedProfiles] of Object.entries(raw)) {
    const target = Object.hasOwn(targets, targetID) ? targets[targetID] : undefined;
    if (!target || target.id !== targetID || target.kind !== 'cloud' ||
      typeof target.providerID !== 'string' || !target.providerID || typeof target.modelID !== 'string' || !target.modelID) {
      fail(`"${targetID}" must name a normalized static cloud target`);
    }
    if (!Array.isArray(allowedProfiles) || allowedProfiles.length === 0) fail(`"${targetID}" must name a nonempty profile array`);
    const names = [...new Set(allowedProfiles)];
    if (names.length !== allowedProfiles.length || names.some((name) => typeof name !== 'string' || !name)) fail(`"${targetID}" has invalid or duplicate profiles`);
    for (const name of names) {
      if (name === 'auto' || name === 'manual' || offline.has(name)) fail(`"${targetID}" cannot use ${name}`);
      if (!contains(profiles[name], targetID)) fail(`"${targetID}" is not a primary target of profile "${name}"`);
    }
    const providerTargets = registeredProviders.get(target.providerID) ?? new Set();
    providerTargets.add(targetID);
    registeredProviders.set(target.providerID, providerTargets);
    Object.defineProperty(result, targetID, { value: Object.freeze({
      providerID: target.providerID,
      modelID: target.modelID,
      profiles: Object.freeze(names),
    }), enumerable: true, configurable: false, writable: false });
  }

  for (const [providerID, targetIDs] of registeredProviders) {
    if (trusted.has(providerID)) fail(`provider "${providerID}" is also trustedSubscriptionProviders`);
    for (const [id, target] of Object.entries(targets)) {
      if (!targetIDs.has(id) && target?.providerID === providerID) fail(`provider "${providerID}" is shared with static target "${id}"`);
    }
  }
  for (const targetID of Object.keys(result)) {
    if (inMembership(context.tiers, targetID) || inMembership(context.fallbacks, targetID) || inMembership(context.profileFallbacks, targetID) ||
      inMembership(context.rawMemberships?.tiers, targetID) || inMembership(context.rawMemberships?.fallbacks, targetID) || inMembership(context.rawMemberships?.profileFallbacks, targetID)) {
      fail(`"${targetID}" appears in a tier or fallback`);
    }
    for (const [name, ids] of Object.entries(profiles)) {
      if (!contains(ids, targetID)) continue;
      if (!result[targetID].profiles.includes(name)) fail(`"${targetID}" is an unauthorized primary of profile "${name}"`);
    }
    for (const [name, ids] of Object.entries(context.rawMemberships?.profiles ?? {})) {
      if (rawContains(ids, targetID) && !result[targetID].profiles.includes(name)) fail(`"${targetID}" has a forbidden raw profile placement`);
    }
  }
  return Object.freeze(result);
};

export const manualApiAdmission = (target, profile, policy = {}) => {
  if (!target || typeof target.providerID !== 'string') return null;
  const entries = Object.entries(policy);
  const registeredProvider = entries.some(([, entry]) => entry?.providerID === target.providerID);
  if (!registeredProvider) return null;
  const entry = typeof target.id === 'string' && Object.hasOwn(policy, target.id) ? policy[target.id] : undefined;
  return target.kind === 'cloud' && entry?.providerID === target.providerID && target.modelID === entry.modelID &&
    target.source === undefined && entry.profiles.includes(profile) === true;
};
