// The provider-role registry: the SINGLE source of which provider model plays which routing
// role, and the only place a family name is allowed to become a tier assignment.
//
// Before this module the policy was a literal `FAMILY_TIERS` table in lib/routing.js and a
// second, implicit copy of the same knowledge in the watch job. `FAMILY_TIERS` is now DERIVED
// from here (see familyTiersFromRoles), so there is one table to edit and one table to review.
//
// CRITICAL: NOTHING HERE MAY IMPORT config.js OR routing.js. This module is the bottom of the
// dependency order: config.js normalizes host `modelRoles` overrides through it at load time,
// and routing.js derives its discovery policy from the result. An import in the other
// direction is a cycle whose symptom is an undefined CONFIG at module-evaluation time.
//
// A HOST OVERRIDE MAY CHANGE POLICY; IT MAY NEVER DELETE ONE. Every rule below starts from the
// product defaults and treats an invalid override as absent, because the failure mode being
// designed against is a typo in a config file quietly removing Opus from `build`/`smart` (or
// promoting an efficient worker model into the security-sensitive `classifier` lane) and the
// router then serving that lane from whatever was left. Deletion-shaped values -- null, false,
// {}, an empty tier list, an empty family list -- are therefore ignored with a diagnostic
// rather than honoured, and `families`, `idPatterns` and `evidenceDomains` merge ADDITIVELY so
// a host cannot erase a safe matcher or a source allowlist by restating the field.

// The routing tiers a role may claim. `classifier` is included because the haiku role owns it;
// it is not a leasable lane (see isClassifierAgent in routing.js).
// Exported because the reconciler's `amend` command has to validate an operator's tier list
// against exactly this set. A second copy of the names there would let an amendment write a lane
// routing never reads -- silently, because nothing downstream would complain.
export const TIER_NAMES = Object.freeze(["deep", "smart", "build", "fast-build", "review", "worker", "classifier"]);
// A role key is exactly `providerID:roleID`; each half is a lowercase slug of 1-100 characters.
const KEY_PART = /^[a-z0-9][a-z0-9-]{0,99}$/;
// Family names and evidence domains: 1-200 characters, no whitespace.
const NAME = /^\S{1,200}$/;
// The text between an id matcher's prefix and suffix counts as a VERSION only when it is
// digits and separators -- "5", "5.6", "4-5". Anything else ("latest", "preview") is a valid
// model id with no parseable version, which is reported as null rather than guessed at.
const VERSION = /^\d+(?:[.-]\d+)*$/;

const ROLE_FIELDS = Object.freeze([
  "families", "idPatterns", "tiers", "fit", "rank", "requiredCapabilities", "evidenceDomains",
]);
// CRITICAL: A new field is a POLICY change, so it is rejected until its validator exists. Package 3
// adds reasoning-mode and compatibility-probe parameters; it must extend this list and write
// the matching validation. Passing an unknown key through would let a host write a rule that
// reads as effective, reviews as effective, and does nothing.
const CAPABILITY_FIELDS = Object.freeze(["toolCall"]);
// A brand-new role key is policy from scratch: there is no safe default underneath it, so
// everything that decides where it routes and what may justify it has to be declared. `fit` is
// the one exception -- an absent fit means "no measured preference", which is a real answer.
const REQUIRED_NEW_FIELDS = Object.freeze([
  "families", "idPatterns", "tiers", "rank", "requiredCapabilities", "evidenceDomains",
]);

// ---- product defaults -------------------------------------------------------------------
// This IS the pre-registry FAMILY_TIERS table, plus the matching/evidence data the
// reconciler needs. `tiers` and `fit` here must keep deriving the exact same family-tier
// policy routing.js used to carry as a literal -- tests/routing.test.mjs pins that.
//
// `fit` is MEASURED preference, not a synonym for rank: it is why Opus outranks Sonnet inside
// `build` without a second config knob, and why a new family member joins its lane without
// inheriting a pin's fit.
const DEFAULT_DEFINITIONS = {
  "anthropic:claude-opus": {
    families: ["claude-opus"], idPatterns: [{ prefix: "claude-opus-", suffix: "" }],
    tiers: ["build", "smart"], fit: { build: 1.5 }, rank: 3,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["anthropic.com", "platform.claude.com"],
  },
  "anthropic:claude-sonnet": {
    families: ["claude-sonnet"], idPatterns: [{ prefix: "claude-sonnet-", suffix: "" }],
    tiers: ["build", "review"], fit: { review: 1.4 }, rank: 2,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["anthropic.com", "platform.claude.com"],
  },
  "anthropic:claude-fable": {
    families: ["claude-fable"], idPatterns: [{ prefix: "claude-fable-", suffix: "" }],
    tiers: ["deep"], fit: { deep: 1.5 }, rank: 4,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["anthropic.com", "platform.claude.com"],
  },
  "anthropic:claude-haiku": {
    families: ["claude-haiku"], idPatterns: [{ prefix: "claude-haiku-", suffix: "" }],
    tiers: ["worker", "classifier"], fit: {}, rank: 1,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["anthropic.com", "platform.claude.com"],
  },
  "openai:gpt-astra": {
    families: ["gpt-astra"], idPatterns: [{ prefix: "gpt-", suffix: "-astra" }],
    tiers: ["deep"], fit: {}, rank: 4,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["openai.com", "developers.openai.com"],
  },
  "openai:gpt-sol": {
    families: ["gpt-sol"], idPatterns: [{ prefix: "gpt-", suffix: "-sol" }],
    tiers: ["smart"], fit: {}, rank: 3,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["openai.com", "developers.openai.com"],
  },
  "openai:gpt-terra": {
    families: ["gpt-terra"], idPatterns: [{ prefix: "gpt-", suffix: "-terra" }],
    tiers: ["build"], fit: {}, rank: 2,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["openai.com", "developers.openai.com"],
  },
  // CRITICAL: Luna cannot appoint itself to the security-sensitive classifier lane: the efficient
  // worker role owns `worker` only, and no inference from "small and fast" adds `classifier`.
  "openai:gpt-luna": {
    families: ["gpt-luna"], idPatterns: [{ prefix: "gpt-", suffix: "-luna" }],
    tiers: ["worker"], fit: {}, rank: 1,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["openai.com", "developers.openai.com"],
  },
  // Alibaba stays pinned in config and gets no role: API auth is not discoverable, and the
  // `qwen` family mixes max, flash and image models, so no single tier assignment is correct.
};

// ---- validation -------------------------------------------------------------------------
// Validation failures are thrown internally and caught at the override boundary, so one bad
// entry costs exactly that entry. normalizeModelRoles() itself never throws: lib/config.js is
// imported by the TUI plugin, where an exception at import takes the editor's session with it.
class RoleError extends Error {}
const fail = (message) => { throw new RoleError(message); };

const parseRoleKey = (key) => {
  if (typeof key !== "string") return null;
  const parts = key.split(":");
  if (parts.length !== 2) return null;
  const [providerID, roleID] = parts;
  if (!KEY_PART.test(providerID) || !KEY_PART.test(roleID)) return null;
  return { providerID, roleID };
};

const validateNames = (label, value) => {
  if (!Array.isArray(value) || !value.length) fail(`${label} must be a non-empty array of names`);
  const names = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !NAME.test(entry)) {
      fail(`${label} entry ${JSON.stringify(entry) ?? "undefined"} must be 1-200 characters with no whitespace`);
    }
    if (!names.includes(entry)) names.push(entry);
  }
  return names;
};

const validateIdPatterns = (label, value) => {
  if (!Array.isArray(value) || !value.length) fail(`${label} must be a non-empty array of { prefix, suffix }`);
  const patterns = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`${label} entry ${JSON.stringify(entry) ?? "undefined"} must be an object of { prefix, suffix }`);
    }
    const unsupported = Object.keys(entry).filter((field) => field !== "prefix" && field !== "suffix");
    if (unsupported.length) fail(`${label} entry carries unsupported field(s) ${unsupported.join(", ")}`);
    const prefix = entry.prefix ?? "";
    const suffix = entry.suffix ?? "";
    if (typeof prefix !== "string" || typeof suffix !== "string") {
      fail(`${label} prefix and suffix must be strings`);
    }
    if (prefix.length > 100 || suffix.length > 100) {
      fail(`${label} prefix and suffix must be at most 100 characters`);
    }
    if (/\s/.test(prefix) || /\s/.test(suffix)) fail(`${label} prefix and suffix must not contain whitespace`);
    // A matcher with neither half matches every model id the provider ships, which is the one
    // shape that could hand a whole catalog to one role.
    if (!prefix.length && !suffix.length) fail(`${label} entry must declare a prefix or a suffix`);
    if (!patterns.some((known) => known.prefix === prefix && known.suffix === suffix)) {
      patterns.push({ prefix, suffix });
    }
  }
  return patterns;
};

const validateTiers = (label, value) => {
  if (!Array.isArray(value) || !value.length) fail(`${label} must be a non-empty array of routing tiers`);
  const tiers = [];
  for (const tier of value) {
    if (!TIER_NAMES.includes(tier)) {
      fail(`${label} entry ${JSON.stringify(tier) ?? "undefined"} is not one of ${TIER_NAMES.join(", ")}`);
    }
    if (!tiers.includes(tier)) tiers.push(tier);
  }
  return tiers;
};

const validateFit = (label, value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object of tier weights`);
  }
  const fit = {};
  for (const [tier, weight] of Object.entries(value)) {
    if (!TIER_NAMES.includes(tier)) fail(`${label} key ${JSON.stringify(tier)} is not a routing tier`);
    const number = Number(weight);
    if (!Number.isFinite(number) || number <= 0) {
      fail(`${label}["${tier}"] = ${JSON.stringify(weight) ?? "undefined"} must be a positive number`);
    }
    fit[tier] = number;
  }
  return fit;
};

const validateRank = (label, value) => {
  if (!Number.isInteger(value) || value < 1) {
    fail(`${label} = ${JSON.stringify(value) ?? "undefined"} must be an integer >= 1`);
  }
  return value;
};

const validateCapabilities = (label, value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object of required capabilities`);
  }
  const unsupported = Object.keys(value).filter((field) => !CAPABILITY_FIELDS.includes(field));
  if (unsupported.length) {
    fail(`${label} carries unsupported field(s) ${unsupported.join(", ")} -- Package 3 must validate a capability before accepting it`);
  }
  const capabilities = {};
  for (const field of CAPABILITY_FIELDS) {
    if (!(field in value)) continue;
    if (typeof value[field] !== "boolean") fail(`${label}.${field} must be a boolean`);
    capabilities[field] = value[field];
  }
  return capabilities;
};

// Base order first, then whatever the override adds: a host teaches a role a new catalog
// family or evidence domain, it never takes one away.
const union = (base, added) => {
  const merged = [...base];
  for (const entry of added) if (!merged.includes(entry)) merged.push(entry);
  return merged;
};

const unionPatterns = (base, added) => {
  const merged = [...base];
  for (const entry of added) {
    if (!merged.some((known) => known.prefix === entry.prefix && known.suffix === entry.suffix)) {
      merged.push(entry);
    }
  }
  return merged;
};

// Builds one frozen role from a definition, inheriting from `base` when the key already exists.
// `tiers`, `fit`, `rank` and `requiredCapabilities` REPLACE (that is the policy a host is
// entitled to change); `families`, `idPatterns` and `evidenceDomains` are additive unions.
const buildRole = (key, providerID, roleID, definition, base) => {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    fail(`modelRoles["${key}"] = ${JSON.stringify(definition) ?? "undefined"} must be an object`);
  }
  const fields = Object.keys(definition);
  if (!fields.length) fail(`modelRoles["${key}"] is an empty object -- a role cannot be removed`);
  const unsupported = fields.filter((field) => !ROLE_FIELDS.includes(field));
  if (unsupported.length) {
    fail(`modelRoles["${key}"] carries unsupported field(s) ${unsupported.join(", ")} -- only ${ROLE_FIELDS.join(", ")} are accepted`);
  }
  if (!base) {
    const missing = REQUIRED_NEW_FIELDS.filter((field) => !fields.includes(field));
    if (missing.length) {
      fail(`modelRoles["${key}"] is a new role and must declare ${missing.join(", ")}`);
    }
  }
  const families = "families" in definition
    ? union(base?.families ?? [], validateNames(`modelRoles["${key}"].families`, definition.families))
    : [...base.families];
  const idPatterns = "idPatterns" in definition
    ? unionPatterns(base?.idPatterns ?? [], validateIdPatterns(`modelRoles["${key}"].idPatterns`, definition.idPatterns))
    : base.idPatterns.map((pattern) => ({ ...pattern }));
  const evidenceDomains = "evidenceDomains" in definition
    ? union(base?.evidenceDomains ?? [], validateNames(`modelRoles["${key}"].evidenceDomains`, definition.evidenceDomains))
    : [...base.evidenceDomains];
  const tiers = "tiers" in definition
    ? validateTiers(`modelRoles["${key}"].tiers`, definition.tiers)
    : [...base.tiers];
  const fit = "fit" in definition
    ? validateFit(`modelRoles["${key}"].fit`, definition.fit)
    : { ...(base?.fit ?? {}) };
  const rank = "rank" in definition
    ? validateRank(`modelRoles["${key}"].rank`, definition.rank)
    : base.rank;
  const requiredCapabilities = "requiredCapabilities" in definition
    ? validateCapabilities(`modelRoles["${key}"].requiredCapabilities`, definition.requiredCapabilities)
    : { ...base.requiredCapabilities };
  return Object.freeze({
    providerID,
    roleID,
    families: Object.freeze(families),
    idPatterns: Object.freeze(idPatterns.map((pattern) => Object.freeze({ ...pattern }))),
    tiers: Object.freeze(tiers),
    fit: Object.freeze(fit),
    rank,
    requiredCapabilities: Object.freeze(requiredCapabilities),
    evidenceDomains: Object.freeze(evidenceDomains),
  });
};

// ---- the default registry ---------------------------------------------------------------
// Built through the same validator the overrides use, so a broken PRODUCT default fails loudly
// at import instead of shipping as a silently missing role.
const buildDefaults = () => {
  const roles = {};
  const owners = new Map();
  for (const [key, definition] of Object.entries(DEFAULT_DEFINITIONS)) {
    const parsed = parseRoleKey(key);
    if (!parsed) throw new Error(`opencode-broker: default model role key "${key}" is not providerID:roleID`);
    const role = buildRole(key, parsed.providerID, parsed.roleID, definition, undefined);
    for (const family of role.families) {
      const familyKey = `${parsed.providerID}:${family}`;
      const owner = owners.get(familyKey);
      if (owner && owner !== key) {
        throw new Error(`opencode-broker: default model roles ${owner} and ${key} both claim family ${familyKey}`);
      }
      owners.set(familyKey, key);
    }
    roles[key] = role;
  }
  return { roles: Object.freeze(roles), owners };
};

const { roles: BUILT_DEFAULT_ROLES, owners: DEFAULT_FAMILY_OWNERS } = buildDefaults();

export const DEFAULT_MODEL_ROLES = BUILT_DEFAULT_ROLES;

const defaultWarn = (message) => console.error(`opencode-broker: ${message}`);

// Merges validated host overrides over the product defaults.
//
// Key insertion order is DEFAULTS FIRST, then any new role key, and a same-key override keeps
// the default's position: lib/watch.js publishes Object.keys(FAMILY_TIERS) as
// MAPPED_FAMILY_KEYS, so a reshuffle would silently change what that job reports on.
export const normalizeModelRoles = (overrides, { warn = defaultWarn } = {}) => {
  const roles = { ...DEFAULT_MODEL_ROLES };
  const owners = new Map(DEFAULT_FAMILY_OWNERS);
  const authored = overrides && typeof overrides === "object" ? overrides : {};
  for (const [key, definition] of Object.entries(authored)) {
    const parsed = parseRoleKey(key);
    if (!parsed) {
      warn(`modelRoles key "${key}" is not providerID:roleID with lowercase slug halves -- ignored.`);
      continue;
    }
    const { providerID, roleID } = parsed;
    let role;
    try {
      role = buildRole(key, providerID, roleID, definition, roles[key]);
    } catch (error) {
      if (!(error instanceof RoleError)) throw error;
      warn(`${error.message} -- ignored, the safe default stands.`);
      continue;
    }
    // CRITICAL: One family belongs to exactly ONE role. An override under a DIFFERENT key that
    // claims a family a default (or an earlier valid override) already owns is ignored whole:
    // letting it through would silently move the incumbent's lane to a role the host meant to
    // add alongside it, and which of the two won would depend on iteration order.
    const stolen = role.families
      .map((family) => ({ family, owner: owners.get(`${providerID}:${family}`) }))
      .filter((claim) => claim.owner && claim.owner !== key);
    if (stolen.length) {
      const claim = stolen[0];
      warn(`modelRoles["${key}"] family "${claim.family}" already belongs to ${claim.owner} -- ignored, the existing owner keeps it.`);
      continue;
    }
    for (const family of role.families) owners.set(`${providerID}:${family}`, key);
    roles[key] = role;
  }
  return Object.freeze(roles);
};

// The discovery policy lib/routing.js routes on, derived from the registry.
//
// CRITICAL: KEYED BY `${providerID}:${family}`, NEVER BY ROLE KEY. Family names are not globally
// unique, and a role ID need not equal its family name -- one role may own several catalog
// families (a provider renames one, or ships a preview line), and the same family string under
// a different provider is a different model entirely.
export const familyTiersFromRoles = (roles) => {
  const table = {};
  for (const role of Object.values(roles && typeof roles === "object" ? roles : {})) {
    if (!role || typeof role !== "object" || typeof role.providerID !== "string") continue;
    for (const family of role.families ?? []) {
      table[`${role.providerID}:${family}`] = Object.freeze({ tiers: role.tiers, fit: role.fit });
    }
  }
  return Object.freeze(table);
};

// Which of a role's id matchers this model id satisfies, and the version it encodes.
// A model matched on FAMILY alone has no parseable version: a family name carries no release.
const matchIdPatterns = (patterns, modelID) => {
  for (const { prefix, suffix } of patterns) {
    if (modelID.length < prefix.length + suffix.length) continue;
    if (!modelID.startsWith(prefix) || !modelID.endsWith(suffix)) continue;
    const middle = modelID.slice(prefix.length, modelID.length - suffix.length);
    // "4-5" and "5.6" are the same kind of version string with different separators; a
    // non-numeric middle ("latest", "preview") is a legitimate id with no version to report.
    return { matched: true, version: VERSION.test(middle) ? middle.replace(/-/g, ".") : null };
  }
  return { matched: false, version: null };
};

// Resolves a catalog model to at most one role.
//
// CRITICAL: AGREEMENT IS REQUIRED, AND DISAGREEMENT IS AN EXPLICIT CONFLICT -- not whichever matcher
// happened to run first. A model whose catalog family says one role and whose id shape says
// another is exactly the case where guessing puts a model in the wrong lane, so both keys are
// returned and the caller (Task 5's reconciler) blocks on the conflict instead.
export const matchModelRole = (providerID, model, roles) => {
  const modelID = typeof model?.id === "string" ? model.id : "";
  const family = typeof model?.family === "string" ? model.family : "";
  const matches = [];
  for (const [key, role] of Object.entries(roles && typeof roles === "object" ? roles : {})) {
    if (!role || typeof role !== "object" || role.providerID !== providerID) continue;
    const byFamily = family !== "" && (role.families ?? []).includes(family);
    const byPattern = modelID !== ""
      ? matchIdPatterns(role.idPatterns ?? [], modelID)
      : { matched: false, version: null };
    if (!byFamily && !byPattern.matched) continue;
    matches.push({ key, role, version: byPattern.version });
  }
  if (!matches.length) return Object.freeze({ status: "unknown", roleKeys: Object.freeze([]) });
  if (matches.length > 1) {
    // Sorted, so the reported conflict is the same on every run and in every process.
    return Object.freeze({
      status: "conflict",
      roleKeys: Object.freeze(matches.map((match) => match.key).sort()),
    });
  }
  const [match] = matches;
  return Object.freeze({
    status: "known",
    roleKey: match.key,
    role: match.role,
    version: match.version,
  });
};
