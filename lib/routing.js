import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeProviderError, providerEligible, providerErrorText } from "./provider-health.js";
import { CONFIG, OFFLINE_PROFILE_NAMES, PROFILE_NAMES } from "./config.js";
import { PROVIDER_BUDGETS, budgetUtilization, effectiveUtilization, utilizationIsObserved } from "./budgets.js";
import { brokerRequest, brokerSocketPath } from "./client.js";
import { activeDealMultiplier } from "./deals.js";

// ☠️ COMPOSED, NEVER RETYPED. The routed profiles are declared once, in lib/config.js, next
// to the code that builds their lanes; this list is just those plus the two that have no lane
// (`auto` routes on the tier ladder, `manual` leases nothing). The failure a second copy
// produces is silent and asymmetric: a name present here and absent there is a profile the
// TUI offers, isProfile() accepts and the broker then refuses every lease for, because
// CONFIG.profiles has no lane under that key. One list cannot drift from itself.
export const PROFILES = Object.freeze(["auto", "manual", ...PROFILE_NAMES]);

// The human name of each profile. `profileTitles` in config names any of them; otherwise the
// name is title-cased ("uncensored-70b" -> "Uncensored 70B").
// ☠️ profileTitle() falls back to "Auto" only for a name that is not a profile at all. A
// profile must never display as "Auto": a toast reading "Auto: <model> selected" while the
// user sits on a restricted lane says the opposite of the truth, which is why every declared
// profile gets a derived title rather than the fallback.
const titleCase = (name) => name.split("-")
  .map((word) => /^\d+[a-z]$/.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))
  .join(" ");
const PROFILE_TITLES = Object.freeze({
  auto: "Auto",
  manual: "Manual Model",
  ...Object.fromEntries(PROFILE_NAMES.map((name) => {
    const configured = CONFIG.profileTitles?.[name];
    return [name, typeof configured === "string" && configured ? configured : titleCase(name)];
  })),
});

// The legacy agent names that MEAN a routing profile: `-a uncensored` predates F11 and still
// resolves to the profile of the same name. Derived as the identity map over the routed
// profiles, because that is all it has ever been, and a hand-written copy is one more list to
// forget a profile in.
const AGENT_PROFILES = Object.freeze(Object.fromEntries(PROFILE_NAMES.map((name) => [name, name])));

const ROUTE_TIERS = new Set(["deep", "smart", "build", "fast-build", "review", "worker"]);

// ☠️ A LANE THE MACHINERY DISPATCHES FOR ITSELF, on an agent the user never chose. The
// rule that decides what such a lane inherits is about WHAT IT PROCESSES:
//
//     A lane that processes the CONVERSATION follows the conversation's profile.
//     A lane that processes something else routes ordinarily, but never outside
//     the profile's egress boundary.
//
// `compaction` processes the conversation itself -- it summarises the transcript and the
// summary REPLACES it -- so it follows the profile like any ordinary turn and is not
// listed here. ☠️ Under `uncensored` that is not a preference: a censored model asked to
// compact an uncensored conversation may refuse, or quietly sanitise, and a sanitised
// summary replaces the history permanently and silently. Compaction is its own turn and
// never overlaps the user's, so a capacity-1 profile target is free when it runs.
//
// A command-classifier lane (opencode-guard's command gate: one real CHILD session per
// classification, each pinned to its own model in frontmatter) processes a SHELL COMMAND.
// That has nothing to do with the conversation's content or model class, so it takes its
// own `classifier` tier -- and inheriting the conversation's profile is what takes the gate
// down: a child that inherits a local-only profile whose single target is at capacity 1,
// held by the user's own turn, is refused every lease, and the guard FAILS CLOSED on an
// unreachable classifier. Which agents are classifier lanes is config: any agent that
// `agentTiers` maps to "classifier" (by default opencode-guard's `fleet-classifier*`
// family, matched by PREFIX so a lane added later is covered the day it is added).
// ☠️ WHO MAY TAKE THE GPUS FROM WHOM. A forward model swap evicts whatever is resident, so
// when two consumers want different models one of them loses a live conversation mid-sentence.
// The order, highest first:
//   1. the gateway's clients (a chat UI, a voice assistant) -- a person or a device is waiting
//      on the other end and cannot re-route; their sessionIDs are minted `gw-...` by the gateway.
//   2. an opencode session -- it wants the same models, but it can wait.
// ☆ A boolean and not a number, because only those two requesters reach a FORWARD swap. The
// broker passes it to a target's prepareCommand as MODEL_SWAP_YIELD_TO_ACTIVE=1 (see
// prepareTarget in bin/opencode-broker), and it is the swap script's job to honour it: decline
// to evict a model a live conversation is using, and let the requester wait. A restore that
// puts the resting models back should decline on an in-use model unconditionally.
export const swapRequesterYields = ({ sessionID } = {}) =>
  !(typeof sessionID === "string" && sessionID.startsWith("gw-"));

// The configured tier rule for an agent name: an exact agentTiers entry, else the longest
// matching `prefix*` entry, else null. See lib/config.js for the config shape and defaults.
export const agentTierRule = (agent) => {
  if (typeof agent !== "string" || !agent) return null;
  const exact = CONFIG.agentTiers.exact.get(agent);
  if (exact) return exact;
  for (const [prefix, tier] of CONFIG.agentTiers.prefixes) {
    if (agent.startsWith(prefix)) return tier;
  }
  return null;
};

export const isClassifierAgent = (agent) => agentTierRule(agent) === "classifier";

// ...but "routes ordinarily" is not "routes anywhere". The EGRESS BOUNDARY still crosses:
// what propagates to such a lane is "this content does not leave the LAN", never "use
// uncensored-qwen". ☠️ A command line is where secrets travel inline -- `rbw get <entry>`,
// an inline env assignment, a token in a curl, a private hostname, a customer id in a
// path -- and it runs on nearly EVERY bash command, so classifying it off-LAN is a
// higher-volume leak than a transcript, not a lower one. The fleet's own config already
// said so: its classifier tier is local-first precisely because the command text "carries
// paths, hostnames and sometimes secrets-adjacent strings", with cloud as the rung below.
// ☠️ Accept the consequence rather than engineering around it: under a restrictive profile,
// with no local classifier available the gate fails closed and the command is blocked. The
// user chose privacy over convenience explicitly, and a cloud escape hatch "just for the
// classifier" would quietly un-choose it for them.
// ☆ `auto` / `manual` / no profile are untouched, so the cloud rung the deployment
// configured on the classifier tier stays exactly where it is.

// Is this model one of the deployment's declared LOCAL targets? Answered from config --
// the authority on what "local" means here -- by exact provider+model, so an agent PINNED
// in frontmatter can be checked against the boundary without leasing anything.
// ☠️ An unknown or missing model is NOT local. Under a confined session that is the
// fail-closed direction, and the only safe reading: we cannot verify what we were not told.
export const modelIsLocalTarget = (model) => {
  const providerID = model?.providerID;
  const modelID = model?.id ?? model?.modelID;
  if (!providerID || !modelID) return false;
  return Object.values(CONFIG.targets)
    .some((target) => target.kind === "local" && target.providerID === providerID && target.modelID === modelID);
};

// An agent mapped to "inherit" (by default opencode's built-in `general` subagent) carries
// arbitrary work delegated by its parent, so it rides the parent's tier: a smart session's
// design delegation must not silently land on a worker model (measured: a "smart-tier"
// design task ran on a mini model because task->general resolved to worker).
export const inheritsParentTier = (agent) => agentTierRule(agent) === "inherit";

// The tier ladder is a COST ladder: every agent rides the cheapest tier
// adequate for its task class, and the expensive tiers exist only for work the
// cheap ones would fail. worker (mechanical) -> review (read + judge, no design
// authority) -> build (implementation) -> smart (design decisions) -> deep
// (frontier thinking, explicit switch only).
// High-stakes content raises the tier FLOOR regardless of the session's agent:
// where being wrong is dangerous, the fleet must serve the answer from a strong
// model, not whatever tier the session happens to sit on. Deterministic (a
// content match, not a model nudge) so it escalates every time. Returns the
// minimum tier the request must be served at, or null. Ordered most-risk first.
const TIER_RANK = { worker: 0, review: 1, "fast-build": 2, build: 3, smart: 4, deep: 5 };
// ☠️ TRIGGER ON THE SAFETY TOPIC, NOT ON A WORD CODE ALSO USES. This floor reads every
// subagent brief, and coding briefs are full of this vocabulary: the circuit-breaker
// pattern, dependency wiring, SVG stroke, short-circuit evaluation, a diagnostics
// endpoint, the symptom of a race, cache poisoning, a load-bearing assumption, a Visa
// payment. Each of those bumped a worker to smart or DEEP (Fable, 2x): 14 worker
// sessions went straight to deep in three days. The bump stays, and so does every
// genuinely medical, legal, electrical and structural phrasing; the ambiguous single
// words now need the context that makes them about safety.
const EXTREME_RISK = /\b(?:dosage|dose|mg\/kg|overdose|how much .{0,30}(?:take|give|administer)|drug interaction|contraindicat|food poisoning|poison control|poisonous|toxic (?:to|for) (?:dogs?|cats?|pets?|kids|children|humans|people)|lethal dose|anaphyla|suicid|self[- ]harm|overdos|seizure|chest pain|(?:having|had|signs of|symptoms of) a stroke|stroke symptoms|allergic reaction|load[- ]bearing wall|structural(?:ly)? (?:sound|safe|support) (?:wall|beam|floor|deck|roof|joist)|gas leak|carbon monoxide|(?:electrical|house|home|mains|outlet|panel) wiring|amperage|breaker (?:panel|box)|mix(?:ing)? (?:bleach|ammonia|chemical))/i;
const HIGH_RISK = /\b(?:medical|medication|prescription|diagnosed with|diagnosis (?:of|for)|symptoms? of (?:a |an )?(?:illness|disease|infection|flu|covid|cold|fever|allergy|heart|stroke)|treatment (?:for|options|plan)|health condition|blood pressure|insulin|antibiotic|pregnan|dosing|legal(?:ly)? (?:advice|liable|binding|required)|lawsuit|legal liability|tax(?:es)? (?:owed|due|liability)|custody|immigration status|visa (?:application|status|interview|sponsorship)|deportation|investment|retirement (?:account|fund)|electrical (?:work|panel|outlet|fire|shock|code)|(?:high|mains|line) voltage|firearm|ammunition|allergen|dietary restriction)\b/i;

export const highRiskTier = (text) => {
  if (typeof text !== "string" || !text) return null;
  if (EXTREME_RISK.test(text)) return "deep";
  if (HIGH_RISK.test(text)) return "smart";
  return null;
};

// The higher of two tiers by rank; used to apply a risk floor over the
// agent-derived tier without ever LOWERING it.
export const raiseTier = (tier, floor) => {
  if (!floor || !(floor in TIER_RANK)) return tier;
  if (!(tier in TIER_RANK)) return floor;
  return (TIER_RANK[floor] > TIER_RANK[tier]) ? floor : tier;
};

// The tier an agent's session is leased on. Always a routable tier: an agent marked
// "classifier" is not leased on its own lane (it keeps its pinned model; see
// isClassifierAgent), so a caller that asks anyway gets the default tier.
export const tierForAgent = (agent, { parentTier } = {}) => {
  const rule = agentTierRule(agent);
  if (rule === "inherit") return ROUTE_TIERS.has(parentTier) ? parentTier : CONFIG.defaultAgentTier;
  if (rule && ROUTE_TIERS.has(rule)) return rule;
  return CONFIG.defaultAgentTier;
};

// ☆ Overridable alongside OPENCODE_MODEL_BROKER_SOCKET, and for the same reason: a
// rehearsal broker MUST NOT share broker.json with the live one. Two brokers writing
// that file trade blind overwrites -- leases, circuits and health from whichever wrote
// last -- so testing an outage against the real state directory would corrupt the thing
// under test. Unset in normal operation.
const ROOT = process.env.OPENCODE_MODEL_ROUTING_DIR ||
  join(homedir(), ".local/share/opencode/model-routing");
const PROFILE_DIR = join(ROOT, "profiles");
const CONTEXT_DIR = join(ROOT, "context-estimates");
const MODEL_SWITCH_DIR = join(ROOT, "managed-switches");
const PENDING_FORGET_DIR = join(ROOT, "pending-forgets");
const GLOBAL_PROFILE = join(ROOT, "profile.json");
const AUTH_PATH = join(homedir(), ".local/share/opencode/auth.json");
const MODEL_CACHE_PATH = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode/models.json");
const MAX_PROFILE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CONTEXT_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SWITCH_AGE_MS = 5 * 60 * 1000;
const MAX_PENDING_FORGET_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

export const routingStateDir = () => ROOT;
export const profileTitle = (profile) => PROFILE_TITLES[profile] ?? "Auto";
export const isProfile = (profile) => PROFILES.includes(profile);
export const isOfflineProfile = (profile) => OFFLINE_PROFILE_NAMES.includes(profile);
// The RESTRICTIVE profiles: everything with a config lane of its own, i.e. every profile that
// is neither `auto` (the broker picks from the tier ladder) nor `manual` (the user's own pick,
// no lease at all). Derived, for the same reason PROFILES is.
// ☠️ THIS IS AN EGRESS BOUNDARY, and a profile omitted from it does not merely lose a label:
// profileConfinesToLan() goes false, which is what plugin/router.js consults before it lets a
// machine-dispatched lane send that session's content off the LAN. A new uncensored profile
// that this list had not heard of would quietly let the guard's classifier ship the user's
// command lines -- `rbw get`, tokens, private hostnames -- to a cloud model. Deriving makes
// the omission unrepresentable; an UNKNOWN name is still not restrictive, because it is not in
// PROFILES either, which is exactly what profileReachesCloud already assumes.
const RESTRICTIVE_PROFILES = Object.freeze(PROFILES.filter((profile) => profile !== "auto" && profile !== "manual"));
export const isLocalOnlyProfile = (profile) => RESTRICTIVE_PROFILES.includes(profile);
// Whether any target this profile can actually REACH lives off the LAN -- its primary
// lane plus its fallback rungs, read from config rather than from the profile's name.
// ☠️ isLocalOnlyProfile answers "is this one of the restrictive profiles", which is a
// different question the moment a deployment grants one `profileCloudEgress`: the
// profile is still restrictive, but it now has a cloud rung, and a caller that skips
// provider-inventory work on the name alone would leave that rung permanently
// unadmitted -- an opt-in that silently does nothing. Callers deciding whether cloud
// admission matters must ask this instead.
// ☆ Unknown ids and unknown profiles read as cloud: the fail-safe direction here is to
// do the admission work needlessly, never to skip it.
// Whether a profile CONFINES its session's content to the LAN -- the one property a lane
// dispatched on that session's behalf inherits even when it does not inherit the profile
// itself. Composed from the two existing predicates rather than adding a
// third notion: isLocalOnlyProfile says the profile expresses a confinement at all, and
// profileReachesCloud says whether config still honours it (a profile granted
// profileCloudEgress stops confining; an offline one can never be granted it).
// ☠️ `manual` reaches no cloud target only because it leases NOTHING. That is not a LAN
// confinement and must never be read as one -- isLocalOnlyProfile("manual") is false,
// which is exactly why the composition is written this way round.
export const profileConfinesToLan = (profile) => isLocalOnlyProfile(profile) && !profileReachesCloud(profile);
export const profileReachesCloud = (profile) => {
  if (profile === "manual") return false;
  if (profile !== "auto" && !PROFILES.includes(profile)) return true;
  if (profile === "auto") return true;
  return [...(CONFIG.profiles[profile] ?? []), ...(CONFIG.profileFallbacks[profile] ?? []).flat()]
    .some((id) => CONFIG.targets[id]?.kind !== "local");
};

export const authSnapshot = () => {
  // Only auth types leave OpenCode's auth store. The content hash lets the broker reject
  // inventory that was discovered against an older auth configuration.
  try {
    const stat = statSync(AUTH_PATH);
    const contents = readFileSync(AUTH_PATH);
    const auth = JSON.parse(contents);
    return {
      revision: `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(contents).digest("hex")}`,
      types: Object.fromEntries(Object.entries(auth).map(([id, value]) => [id, value?.type ?? "unknown"])),
    };
  } catch {
    return { revision: null, types: {} };
  }
};

const validSessionID = (sessionID) => typeof sessionID === "string" && SESSION_ID.test(sessionID);

export const ensureRoutingStateDir = () => {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(CONTEXT_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(MODEL_SWITCH_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(PENDING_FORGET_DIR, { recursive: true, mode: 0o700 });
  chmodSync(ROOT, 0o700);
  chmodSync(PROFILE_DIR, 0o700);
  chmodSync(CONTEXT_DIR, 0o700);
  chmodSync(MODEL_SWITCH_DIR, 0o700);
  chmodSync(PENDING_FORGET_DIR, 0o700);
};

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const writeJson = (path, value) => {
  ensureRoutingStateDir();
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
    // chmodSync retained as explicit defense against unusual umask (process.umask() > 0o177);
    // writeFileSync already creates with mode 0o600 and rename preserves it on Linux.
    chmodSync(path, 0o600);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
};

const normalizeRecord = (value) => {
  if (!isProfile(value?.profile)) return null;
  return {
    profile: value.profile,
    explicit: value.explicit === true,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
};

const profilePath = (sessionID) => validSessionID(sessionID) ? join(PROFILE_DIR, `${sessionID}.json`) : null;

// ☠️ THERE IS NO GLOBAL PROFILE ANY MORE, and removing it is a fix, not a tidy-up.
// A profile is a privacy posture, and as a persistent global default it was silently
// inherited by every session that never set one of its own. Pressing F11 on the start
// screen -- where there is no session yet -- used to WRITE that default, so a one-off
// choice became the standing posture for all future work with nothing to indicate it.
// Measured 2026-09-08: `uncensored` had been the global default since 09-07 03:56, which
// (a) confined every session to LAN routing and (b) made opencode-guard refuse to
// classify ANY gray-zone command, because that profile will not send command text off-LAN
// -- so the safety gate denied ordinary work in ~10ms without ever consulting a model.
// A global default cannot fail safely: the blast radius is every session, and the only
// evidence is a file nobody looks at.
// ☆ What replaces it is a ONE-SHOT arming record. A start-screen choice applies to the
// NEXT root session created and is consumed at that moment, so it reaches exactly the
// session the person was about to start and nothing after it.
const PENDING_PROFILE = join(ROOT, "pending-profile.json");
const MAX_PENDING_PROFILE_AGE_MS = 30 * 60 * 1000;

export const readPendingProfile = (now = Date.now()) => {
  const record = normalizeRecord(readJson(PENDING_PROFILE));
  if (!record) return null;
  // A selection left armed for half an hour was not "for the next prompt" any more.
  if (now - Number(record.updatedAt ?? 0) > MAX_PENDING_PROFILE_AGE_MS) return null;
  return record;
};
export const writePendingProfile = (profile) => {
  if (!isProfile(profile)) throw new Error(`unknown routing profile: ${profile}`);
  ensureRoutingStateDir();
  writeJson(PENDING_PROFILE, { profile, updatedAt: Date.now() });
  // A legacy global default must not outlive this call: it would keep applying to every
  // session that does not consume the pending record.
  clearLegacyGlobalProfile();
};
export const clearPendingProfile = () => {
  try { unlinkSync(PENDING_PROFILE); } catch {}
};
// Read-and-delete: the arming record exists to reach ONE session.
export const consumePendingProfile = (now = Date.now()) => {
  const record = readPendingProfile(now);
  clearPendingProfile();
  return record;
};
// Any profile.json left by a build that still had a global default is inert to
// resolveProfile now, but deleting it stops the HUD and any external reader from
// resurrecting the idea that a global posture exists.
export const clearLegacyGlobalProfile = () => {
  try { unlinkSync(GLOBAL_PROFILE); } catch {}
};

export const readSessionProfile = (sessionID) => {
  const path = profilePath(sessionID);
  return path ? normalizeRecord(readJson(path)) : null;
};

const contextPath = (sessionID) => validSessionID(sessionID) ? join(CONTEXT_DIR, `${sessionID}.json`) : null;

const normalizeContextEstimate = (value) => {
  const tokens = Number(value?.tokens ?? value?.estimate ?? value);
  return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : null;
};

export const readSessionContextEstimate = (sessionID) => {
  const path = contextPath(sessionID);
  return path ? normalizeContextEstimate(readJson(path)) : null;
};

export const writeSessionContextEstimate = (sessionID, tokens) => {
  const path = contextPath(sessionID);
  const estimate = normalizeContextEstimate(tokens);
  if (!path || !estimate) return false;
  writeJson(path, { tokens: estimate, updatedAt: Date.now() });
  pruneContextEstimates();
  return true;
};

export const removeSessionContextEstimate = (sessionID) => {
  const path = contextPath(sessionID);
  if (!path) return;
  try { unlinkSync(path); } catch {}
};

const pruneContextEstimates = () => {
  try {
    const now = Date.now();
    for (const name of readdirSync(CONTEXT_DIR)) {
      const path = join(CONTEXT_DIR, name);
      if (now - (statSync(path).mtimeMs || 0) > MAX_CONTEXT_AGE_MS) unlinkSync(path);
    }
  } catch {}
};

const pruneProfiles = () => {
  try {
    const now = Date.now();
    for (const name of readdirSync(PROFILE_DIR)) {
      const path = join(PROFILE_DIR, name);
      if (now - (statSync(path).mtimeMs || 0) > MAX_PROFILE_AGE_MS) unlinkSync(path);
    }
  } catch {}
};

// Kept as a hard failure rather than deleted, so a caller that still reaches for a global
// default gets told what to use instead of silently writing a file nothing reads.
export const writeGlobalProfile = () => {
  throw new Error(
    "the global routing profile has been removed: a profile is per-session. " +
    "Use writePendingProfile() to arm the NEXT session created, or writeSessionProfile() " +
    "to set one on a session that already exists.");
};

export const writeSessionProfile = (sessionID, profile, { explicit = false } = {}) => {
  const path = profilePath(sessionID);
  if (!path) throw new Error("Invalid session id for routing profile");
  if (!isProfile(profile)) throw new Error(`Unknown routing profile: ${profile}`);
  writeJson(path, { profile, explicit, updatedAt: Date.now() });
  pruneProfiles();
};

// Which live sessions are currently on one of `profiles`.
// ☠️ This is the "may I swap the resting model back in?" question. Two models that share a GPU
// cannot both be resident, so switching ONE session out of a swapping profile must not pull the
// model out from under another session still sitting on it. Asking per-session is the only way
// to know; a lease does not survive the reply that used it.
// A record older than MAX_PROFILE_AGE_MS is ignored exactly as pruneProfiles would drop it,
// so an abandoned session cannot pin a swapped-in model on the GPU forever.
export const sessionsOnProfiles = (profiles) => {
  const wanted = new Set(Array.isArray(profiles) ? profiles : [profiles]);
  const now = Date.now();
  const found = [];
  let names;
  try { names = readdirSync(PROFILE_DIR); } catch { return found; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const path = join(PROFILE_DIR, name);
      if (now - (statSync(path).mtimeMs || 0) > MAX_PROFILE_AGE_MS) continue;
      const record = normalizeRecord(readJson(path));
      if (record && wanted.has(record.profile)) found.push(name.slice(0, -".json".length));
    } catch {}
  }
  return found;
};

export const removeSessionProfile = (sessionID) => {
  const path = profilePath(sessionID);
  if (!path) return;
  try { unlinkSync(path); } catch {}
};

const managedSwitchPath = (sessionID) =>
  validSessionID(sessionID) ? join(MODEL_SWITCH_DIR, `${sessionID}.json`) : null;

const pendingForgetPath = (sessionID) => validSessionID(sessionID) ? join(PENDING_FORGET_DIR, `${sessionID}.json`) : null;

// Fallback visibility: when a lease lands on a fallback group (or emergency
// target) the plugin records it here, the hud shows it, and a non-fallback
// lease clears it. A degraded route the user cannot see is how a session quietly
// runs on the emergency model for a day.
const FALLBACK_DIR = join(ROOT, "fallbacks");
const fallbackPath = (sessionID) => validSessionID(sessionID) ? join(FALLBACK_DIR, `${sessionID}.json`) : null;
export const writeFallbackMarker = (sessionID, { policy, targetID, reasons, restoreAt } = {}) => {
  const path = fallbackPath(sessionID);
  if (!path) return false;
  mkdirSync(FALLBACK_DIR, { recursive: true, mode: 0o700 });
  writeJson(path, {
    policy: String(policy ?? "fallback"),
    targetID: String(targetID ?? ""),
    reasons: (Array.isArray(reasons) ? reasons : []).map(String).slice(0, 8),
    // When the displaced-from provider is due back: the lease path drops model
    // stickiness once this passes so the session can rebalance home.
    ...(Number.isFinite(Number(restoreAt)) && Number(restoreAt) > 0 ? { restoreAt: Number(restoreAt) } : {}),
    updatedAt: Date.now(),
  });
  return true;
};
export const readFallbackMarker = (sessionID) => {
  const path = fallbackPath(sessionID);
  const value = path ? readJson(path) : null;
  return value && typeof value === "object" && value.targetID ? value : null;
};
export const removeFallbackMarker = (sessionID) => {
  const path = fallbackPath(sessionID);
  if (!path) return;
  try { unlinkSync(path); } catch {}
};

const normalizePendingForget = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    completed: value.completed === true,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
  };
};

export const readPendingForgetRecord = (sessionID) => {
  const path = pendingForgetPath(sessionID);
  return path ? normalizePendingForget(readJson(path)) : null;
};

export const listPendingForgetRecords = () => {
  prunePendingForgetRecords();
  const records = [];
  try {
    for (const name of readdirSync(PENDING_FORGET_DIR)) {
      const sessionID = name.endsWith(".json") ? name.slice(0, -5) : name;
      const path = pendingForgetPath(sessionID);
      const record = path ? normalizePendingForget(readJson(path)) : null;
      if (!path || !record) continue;
      records.push({ sessionID, ...record });
    }
  } catch {}
  return records.sort((left, right) => left.updatedAt - right.updatedAt || left.sessionID.localeCompare(right.sessionID));
};

export const writePendingForgetRecord = (sessionID, { completed = false } = {}) => {
  const path = pendingForgetPath(sessionID);
  if (!path) return false;
  writeJson(path, { completed: completed === true, updatedAt: Date.now() });
  prunePendingForgetRecords();
  return true;
};

export const removePendingForgetRecord = (sessionID) => {
  const path = pendingForgetPath(sessionID);
  if (!path) return;
  try { unlinkSync(path); } catch {}
};

export const prunePendingForgetRecords = () => {
  try {
    const now = Date.now();
    for (const name of readdirSync(PENDING_FORGET_DIR)) {
      const path = join(PENDING_FORGET_DIR, name);
      if (now - (statSync(path).mtimeMs || 0) > MAX_PENDING_FORGET_AGE_MS) unlinkSync(path);
    }
  } catch {}
};

const pruneManagedSwitches = () => {
  try {
    const now = Date.now();
    for (const name of readdirSync(MODEL_SWITCH_DIR)) {
      const path = join(MODEL_SWITCH_DIR, name);
      if (now - (statSync(path).mtimeMs || 0) > MAX_SWITCH_AGE_MS) unlinkSync(path);
    }
  } catch {}
};

// The model-default TUI plugin records manual switches for future root sessions.
// Router switches carry a short-lived marker so they do not overwrite that choice.
export const markManagedModelSwitch = (sessionID, model) => {
  const path = managedSwitchPath(sessionID);
  if (!path || typeof model?.providerID !== "string" || typeof model?.id !== "string") return false;
  writeJson(path, { providerID: model.providerID, id: model.id, ...(typeof model.variant === "string" && model.variant ? { variant: model.variant } : {}), createdAt: Date.now() });
  pruneManagedSwitches();
  return true;
};

export const clearManagedModelSwitch = (sessionID) => {
  const path = managedSwitchPath(sessionID);
  if (!path) return;
  try { unlinkSync(path); } catch {}
};

export const consumeManagedModelSwitch = (sessionID, model) => {
  const path = managedSwitchPath(sessionID);
  const marker = path && readJson(path);
  if (!path || !marker) return false;
  if (Date.now() - Number(marker.createdAt || 0) > MAX_SWITCH_AGE_MS) {
    try { unlinkSync(path); } catch {}
    return false;
  }
  if (marker.providerID !== model?.providerID || marker.id !== model?.id ||
    (marker.variant ?? undefined) !== (model?.variant ?? undefined)) return false;
  try { unlinkSync(path); } catch {}
  return true;
};

// Every created session gets a record so a Task child inherits exactly the profile
// its parent had at dispatch time, even if the home-screen default changes later.
export const resolveProfile = ({ sessionID, parentID, agent } = {}) => {
  // ☠️ BEFORE the session's own record, not merely before the parent's. A classifier lane
  // must resolve to ordinary routing no matter what any record says, for two reasons:
  //   - the child's "own" record IS the inherited one (session.created wrote the parent's
  //     profile onto it), so checking `own` first leaks anyway; and
  //   - records already on disk from before this fix would otherwise keep leaking for the
  //     full MAX_PROFILE_AGE_MS -- resolving first heals them on contact.
  // The GLOBAL profile is skipped for the same reason: F11 says what the USER'S work runs
  // on, and a safety gate that stops answering because the user pressed F11 is the same
  // outage by another route.
  // ☆ The result is exactly "route this as if no profile were set", which puts the gate
  // back on the `classifier` tier the deployment configured for it. Where that content may
  // GO is a separate question the caller still has to honour -- see profileConfinesToLan.
  if (isClassifierAgent(agent)) {
    return { profile: "auto", explicit: false, updatedAt: 0, source: "internal-lane" };
  }
  const own = readSessionProfile(sessionID);
  if (own) return { ...own, source: "session" };
  const parent = readSessionProfile(parentID);
  if (parent) return { ...parent, source: "parent", explicit: false };
  // ☠️ NO GLOBAL RUNG. A session with no record of its own, and no parent to inherit from,
  // is `auto` -- always. The rung that used to sit here read profile.json and made one
  // start-screen keypress the standing posture for every future session; see the comment
  // on PENDING_PROFILE for what that cost. A start-screen choice now reaches exactly one
  // session, by being written ONTO that session when it is created.
  const profile = AGENT_PROFILES[agent] ?? "auto";
  return { profile, explicit: false, updatedAt: 0, source: profile === "auto" ? "default" : "agent" };
};

export const manualModelLock = () => {
  const value = readJson(join(homedir(), ".local/share/opencode/model-default.json"));
  return typeof value?.providerID === "string" && !!value.providerID &&
    typeof value?.id === "string" && !!value.id;
};

// Model targets and subscription budget windows are deployment DATA -- they
// load from lib/config.js (~/.config/opencode-model-router/config.json). The
// budget arithmetic lives in lib/budgets.js. See examples/config.example.json.
export const TARGETS = CONFIG.targets;

// Providers listed here are trusted subscription integrations despite using
// API-style credentials. Every other static cloud provider must prove OAuth at
// inventory time before the broker can select it.
const TRUSTED_SUBSCRIPTION_PROVIDER_IDS = new Set(CONFIG.trustedSubscriptionProviders);
const PROVIDER_ADMISSIONS = new Set(["admitted", "disconnected", "quarantined-auth", "quarantined-model"]);
const providerAdmission = ({ connected, authType, modelCount = null, trusted = false }) => {
  if (!connected) return "disconnected";
  if (authType !== "oauth" && !trusted) return "quarantined-auth";
  if (authType === "oauth" && modelCount === 0) return "quarantined-model";
  return "admitted";
};
const normalizeProviderAdmission = (value) => {
  if (value === "static" || value === "subscription") return "admitted";
  return PROVIDER_ADMISSIONS.has(value) ? value : "quarantined-auth";
};
const ROUTING_TIERS = new Set(["worker", "review", "build", "fast-build", "smart", "deep", "classifier"]);
const TARGET_ID = /^[a-z0-9][a-z0-9._:-]{0,180}$/;
const MODEL_CATALOG_KEY = /^[A-Za-z0-9._:-]{1,180}\/[A-Za-z0-9._:-]{1,180}$/;
// The provider half of a catalog key is split off before this is applied, so a model id
// carrying a slash, a space or a control character is not a model reference the host can
// ever resolve -- it is junk that would reach the provider verbatim.
const MODEL_ID = /^[A-Za-z0-9._:-]{1,180}$/;

export const modelRef = (target, variant) => ({
  providerID: target.providerID,
  id: target.modelID,
  ...(typeof variant === "string" && variant ? { variant } : {}),
});

// Desired effort per tier. This is the CEILING we aim for; modelRefForTier
// drops each model to the highest effort it actually advertises. Stock Claude
// runs frontier work at xhigh, so the deep tier aims there -- an xhigh-capable
// model uses it, a high-capped model (today's openai catalog tops at high)
// falls back to high rather than opencode's low default.
export const desiredVariantForTier = (tier) => ({
  worker: "medium",
  // ☠️ ORDERED PREFERENCE, not a single level, and this is what makes a REASONING model
  // usable on this lane. A one-word SAFE/RISKY verdict needs no reasoning budget at all, and
  // the cost of paying for one is LATENCY against opencode-guard' 12s classifier budget.
  // Measured 2026-09-08 on gpt-5.6-luna, six labelled commands through the real path:
  //     default effort  6/6 correct, p50 9,649ms, max 24,478ms -- 2 of 6 OVER the budget
  //     effort "none"   6/6 correct, p50 6,834ms, max 11,404ms -- 0 of 6 over
  // It was never that the model could not classify; it was being driven at an effort that
  // made it miss the deadline about a third of the time, and every abort was reported as
  // "classifier returned no text" by a masking bug (opencode-guard 0.4.0).
  // ☆ `none` is exactly right here and luna advertises it; `low` is the fallback for a model
  // that does not. Ask for the cheapest first and take the first one offered.
  classifier: ["none", "low"],
  // review deliberately has NO forced variant: its saving comes from the model
  // CLASS (sonnet/glm/deepseek instead of a flagship), and low reasoning is the
  // wrong economy for a tier whose whole job is catching the subtle flaw.
  smart: "high",
  deep: "xhigh",
  build: "high",
  "fast-build": "medium",
})[tier] ?? null;

export const modelRefForTier = (target, tier, modelVariants = {}) => {
  // Effort resolution: this model's tuned effort for the tier, else the tier
  // default -- applied only when the variant is known-supported (declared in
  // config or advertised by the catalog).
  const desired = target?.effort?.[tier] ?? desiredVariantForTier(tier);
  // UNION of the discovered inventory variants and the fleet-configured ones.
  // Discovery can lag the live catalog (it long advertised only high/low/medium
  // while the models actually support xhigh/max), so a variant the fleet
  // explicitly declares in config must still count as available -- otherwise a
  // configured xhigh is silently dropped whenever discovery has ANY entry.
  const key = `${target?.providerID}/${target?.modelID}`;
  const discovered = modelVariants?.[key];
  const configured = CONFIG.modelVariants[key];
  const advertised = [...new Set([
    ...(Array.isArray(discovered) ? discovered : []),
    ...(Array.isArray(configured) ? configured : []),
  ])];
  // Apply the desired effort ONLY when the model actually advertises it.
  // Otherwise use the model's own default (no variant) -- never substitute a
  // different level: forcing the highest-available is wrong in the other
  // direction (over/under-driving a model at an effort it wasn't tuned for).
  // A model that should run a tier at a specific effort declares it in the
  // config's per-target `effort` map, which the catalog advertises.
  // A tier may name ONE level or an ordered preference; take the first the model offers.
  // Never substitute an unrequested level -- a model that advertises none of them runs at
  // its own default, which is the documented behaviour above.
  const preferences = Array.isArray(desired) ? desired : (desired ? [desired] : []);
  const variant = preferences.find((level) =>
    typeof level === "string" && Array.isArray(advertised) && advertised.includes(level));
  return modelRef(target, variant);
};

// A lease must leave room for the session to keep working: the compaction request is the
// whole conversation plus a prompt, and the reply needs output space, so a window is only
// usable while the conversation sits below (window - output reserve). Unknown sizes stay
// permissive, and a model whose output budget we do not know falls back to a flat fraction.
//
// ☠️ The flat 0.85 this replaced was wrong in BOTH directions, because a model's output
// reserve is not a constant fraction of its window:
//   - too tight on big windows. 0.85 of 1,000,000 refuses at 850,000, but the host does not
//     auto-compact until ~(1,000,000 - 128,000) = 872,000. Between those two numbers a lease
//     was refused while the host was still happily working -- and since compaction rides the
//     session's own tier, the refusal ALSO blocked the compaction that would have ended it.
//     `failLease` throws, so the session could neither run nor shrink. Measured 2026-09-08:
//     the ladder's hard ceiling was 892,500 with a 892,500-922,000 dead band above it.
//   - too loose on small windows. 0.85 of haiku's 200,000 is 170,000, but haiku reserves
//     64,000 for output, so a 170,000-token request plus its reply is 234,000 against a
//     200,000 window -- a provider overflow the check was supposed to prevent.
// The reserve is the model's own declared output limit, which is the same figure the host
// reserves, so the two now agree instead of racing.
const CONTEXT_HEADROOM = 0.85;
export const contextFits = (declaredContext, contextTokens, outputReserve = null) => {
  const declared = Number(declaredContext);
  const tokens = Number(contextTokens);
  if (!Number.isFinite(declared) || declared <= 0) return true;
  if (!Number.isFinite(tokens) || tokens <= 0) return true;
  return tokens <= usableContext(declared, outputReserve);
};
// The share of a window a lease may actually occupy. Exported so the broker's
// context-pressure comparison ranks "roomier" by the same figure the fit check uses.
export const usableContext = (declaredContext, outputReserve = null) => {
  const declared = Number(declaredContext);
  if (!Number.isFinite(declared) || declared <= 0) return 0;
  const reserve = Number(outputReserve);
  // A reserve at or above the window is a catalog error, not a 0-token model.
  if (!Number.isFinite(reserve) || reserve <= 0 || reserve >= declared) {
    return declared * CONTEXT_HEADROOM;
  }
  return declared - reserve;
};
// LOCAL windows are small and overflow is a measured failure mode (a 133k
// session once leased a 32k target and could not even compact its way out). So
// local targets are STRICT: an unknown context NEVER fits -- the plugin reports
// 0 for a genuinely fresh session, so only "could not determine" is refused --
// and the headroom is tighter than the cloud check because tool results grow
// the context mid-turn, after this check ran.
//
// ☆ THE RESERVE IS AN ABSOLUTE QUANTITY, NOT A FRACTION. A local slot's KV holds
// the prompt AND the generation in ONE allocation, so what must stay free is a SUM
// of absolute terms that do not scale with the window:
//
//     reasoning budget  +  answer tokens  +  growth after this check  <=  reserve
//
// MEASURED 2026-09-19 against 1,815 worker/classifier sessions in the routing trail:
// p50 peak 15,489, p90 36,925, p99 58,433, p99.9 65,639. Turn growth between two
// decisions in the same session: p90 13,042 (weakly supported -- 231 of 232 samples
// were smart-tier, so worker growth is effectively unmeasured; 16,384 is the rounded
// figure the deployed reserves use).
//
// A fraction gets this wrong in both directions. 0.6 holds back a correct ~13k on a
// 32k model and 79k on a 131k one -- the latter ~2.4x more than the model can
// physically generate -- so it refuses sessions for room nothing can use. When a
// target declares `outputReserve` that absolute figure wins; `contextHeadroom` (and
// the global `localContextHeadroom`) survive only as the fallback for a target whose
// generation budget nobody has measured yet, so omitting a reserve keeps the old
// conservative behaviour rather than dropping the guard.
export const localContextEligible = (declaredContext, contextTokens, headroom = CONFIG.localContextHeadroom, outputReserve = null) => {
  const declared = Number(declaredContext);
  if (!Number.isFinite(declared) || declared <= 0) return false;
  if (contextTokens === null || contextTokens === undefined) return false;
  const tokens = Number(contextTokens);
  if (!Number.isFinite(tokens) || tokens < 0) return false;
  const reserve = Number(outputReserve);
  // A reserve at or above the window is a config error, not a 0-token target: fall
  // back to the fraction rather than making the target permanently unroutable. Same
  // guard, and for the same reason, as usableContext above.
  if (Number.isFinite(reserve) && reserve > 0 && reserve < declared) return tokens <= declared - reserve;
  return tokens <= declared * headroom;
};

// The headroom fraction to apply to one local target: its own declared
// `contextHeadroom` when it has one, else the global default. Validation already
// happened in config parsing, so a value here is known to be in (0,1]; this
// re-checks only so a hand-built target object in a test or caller cannot
// quietly disable the local size check by carrying a junk field.
export const targetContextHeadroom = (target, fallback = CONFIG.localContextHeadroom) => {
  const declared = Number(target?.contextHeadroom);
  return Number.isFinite(declared) && declared > 0 && declared <= 1 ? declared : fallback;
};

// True when the request is big enough for a target declaring a minimum. Targets
// without `minContextTokens` (all of them, historically) always pass.
export const meetsContextFloor = (target, contextTokens) => {
  const floor = Number(target?.minContextTokens);
  if (!Number.isFinite(floor) || floor <= 0) return true;
  const tokens = Number(contextTokens);
  if (!Number.isFinite(tokens)) return false;
  return tokens >= floor;
};

// An explicitly declared `context` WINS over the catalog. The catalog is
// genuinely discovered for cloud providers, and no cloud target declares one, so
// they are unaffected -- but llamacpp's "catalog" is a hand-written block in
// opencode.json, and it structurally cannot express the only figure that matters
// for a local slot: the per-slot window is `--ctx-size / --parallel`, and
// opencode has no notion of `--parallel`. Letting it win made the router's
// audited per-slot number decorative.
// ☠️ This is not hypothetical. opencode.json declared 32768 for qwen3.8-27b
// while this config declared the correct 131072; the catalog won, so
// localContextEligible capped local-27b at 19,660 usable while its
// minContextTokens floor demanded 49,153 -- an empty band. The target was
// UNROUTABLE for two days and nothing reported it, because the audit script checked
// the config value the router was ignoring.
export const targetContext = (target, modelContexts = {}) => {
  const declared = Number(target?.context);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const catalog = modelContexts?.[`${target?.providerID}/${target?.modelID}`];
  return Number.isFinite(Number(catalog)) && Number(catalog) > 0 ? Number(catalog) : null;
};
// The output budget the provider will reserve on top of the request, by the same
// precedence as targetContext: an explicit `outputReserve` on the target beats the
// catalog. Null means "unknown", which sends contextFits back to the flat fraction.
// ☠️ A LOCAL TARGET NEVER READS THE CATALOG for this. The original rule excluded
// local entirely, to stop a catalog output limit being subtracted ON TOP of the
// headroom fraction and shrinking the local band to nothing. That concern is intact
// and is why the catalog is still unreachable here for local -- but it argued against
// DOUBLE-COUNTING, not against the reserve itself. An EXPLICIT `outputReserve` is now
// honoured for local too, and localContextEligible drops the fraction whenever it sees
// one, so exactly one of the two is ever applied. The catalog stays out because a
// provider's advertised output limit knows nothing about this deployment's
// `--reasoning-budget`, which is the largest term in a local slot's reserve.
export const targetOutputReserve = (target, modelOutputs = {}) => {
  const declared = Number(target?.outputReserve);
  if (Number.isFinite(declared) && declared > 0) return declared;
  if (target?.kind === "local") return null;
  const catalog = modelOutputs?.[`${target?.providerID}/${target?.modelID}`];
  return Number.isFinite(Number(catalog)) && Number(catalog) > 0 ? Number(catalog) : null;
};
export const targetForID = (id, targets = TARGETS) => targets[id] ?? null;
export const providerCircuitID = (targetOrProvider) => {
  const providerID = typeof targetOrProvider === "string"
    ? targetOrProvider
    : targetOrProvider?.providerID;
  return typeof providerID === "string" && providerID ? `provider:${providerID}` : null;
};

export const targetAtCapacity = (target, active = 0) => {
  if (!target || target.kind === "cloud" || target.capacity === null) return false;
  const capacity = Number(target.capacity);
  if (!Number.isInteger(capacity) || capacity < 1) return false;
  return (Number(active) || 0) >= capacity;
};

// ☠️ SLOTS BELONG TO THE MODEL, NOT THE TARGET. Two targets can name one local model --
// a coder lane and a classifier lane both served by one llama.cpp model's four slots --
// and per-target capacity alone let them claim 4 + 2 = 6 of those 4. It also left nothing
// for a caller the broker never sees: a command classifier that calls the local server
// DIRECTLY (opencode-guard can) queues behind every slot mid-generation, runs out its
// time budget, and the gate fails closed on an ordinary `go test`.
// `modelCapacity` is how many leases the MODEL may already carry, summed over every target
// that names it, for THIS target to take one more. It is a second limit, not a replacement:
// `capacity` still caps the target's own share. A coder lane at modelCapacity 3 keeps the
// model's fourth slot for the classifier; a target that declares none keeps the per-target
// rule alone.
// The model-wide count rides in the same `active` map under modelSlotKey, which no target
// ID can collide with (target IDs never contain a slash).
export const modelSlotKey = (target) =>
  target?.kind === "local" && target.providerID && target.modelID
    ? `model:${target.providerID}/${target.modelID}`
    : null;

export const targetFull = (target, active = {}) => {
  if (targetAtCapacity(target, active[target?.id] ?? 0)) return true;
  const key = modelSlotKey(target);
  const limit = Number(target?.modelCapacity);
  if (!key || !Number.isInteger(limit) || limit < 1) return false;
  return (Number(active[key]) || 0) >= limit;
};

export const cloudTargetAdmitted =(target, providers = {}) => {
  if (!target || target.kind !== "cloud") return true;
  if (target.source === "subscription-oauth") return true;
  const provider = providers[target.providerID];
  // A TRUSTED subscription provider is exempt from the oauth requirement -- its
  // credential is a plain API key by design -- but NOT from being switched off.
  // ☠️ This used to `return true` unconditionally, which made "trusted" mean
  // "permanently admitted": alibaba-token-plan stayed in every pool for days
  // after its token expired, so leases were handed to a lane that could only
  // answer HTTP 401, and the tier looked capacity-starved instead of unplugged.
  // `revalidateAdmission` already sets connected:false the moment a provider
  // disappears from opencode's auth.json, so honouring it here is what makes
  // "disabled in opencode" mean "disabled in the router".
  // Admit on a MISSING entry, reject only on a known-disconnected one: before
  // the first revalidation there is no providers map at all, and failing closed
  // there would strand routing on a cold state rather than on a real signal.
  if (TRUSTED_SUBSCRIPTION_PROVIDER_IDS.has(target.providerID)) {
    return provider === undefined || provider.connected === true;
  }
  return provider?.connected === true && provider?.authType === "oauth";
};

const targetIDsFromInventory = (targets, tier) => Object.values(targets)
  .filter((target) => target?.source === "subscription-oauth" && target?.tiers?.includes(tier))
  .map((target) => target.id)
  .sort();

const anthropicFamilyTargetIDs = (targets, family) => Object.values(targets)
  .filter((target) => target?.source === "subscription-oauth" && target.providerID === "anthropic" &&
    target.family === family && target.speed === "standard")
  .map((target) => target.id)
  .sort();

export const targetIDsFor = (profile, tier = "worker", targets = TARGETS) => {
  // Manual Model deliberately leaves the current OpenCode model alone. It has no
  // broker target; an explicit user switch is the source of truth for that session.
  if (profile === "manual") return [];
  // Non-auto profiles route only within their configured lane.
  if (profile !== "auto") return [...(CONFIG.profiles[profile] ?? [])];
  // The classifier and fast-build lanes are pinned: classifier targets need a
  // matching prompt-only agent, and fast-build is an explicit speed/quality
  // trade -- neither auto-adopts newly inventoried subscription models. Smart,
  // build and worker lanes append discovered subscription models after the
  // configured entries.
  const lane = CONFIG.tiers[tier] ?? [];
  if (tier === "classifier" || tier === "fast-build") return [...lane];
  return [...lane, ...targetIDsFromInventory(targets, tier)];
};

const fallbackTargetGroupsFor = (profile, tier = "worker", targets = TARGETS) => {
  // Manual Model has no broker target at all, so it has nothing to fall back to.
  if (profile === "manual") return [];
  // A restrictive profile falls back within ITS OWN rungs, never the tier's. The tier
  // rungs are full of cloud targets; handing them to `local` or `private` would turn a
  // privacy lane into a paid API on a bad night, silently, which is the exact defect
  // this whole mechanism exists to prevent. `profileFallbacks` is filtered to the LAN
  // at config load (lib/config.js) unless the deployment named the profile in
  // `profileCloudEgress`, so by the time a rung arrives here it is already safe.
  // ☆ Keyed by profile and NOT by tier, exactly as the profile's primary lane is:
  // a profile is a privacy scope, not a quality ladder, and targetIDsFor already
  // ignores the tier for one. An empty/absent entry means no fallback -- the pre-0.28
  // behaviour, which is what a deployment that says nothing keeps getting.
  if (profile !== "auto") return (CONFIG.profileFallbacks[profile] ?? []).map((group) => [...group]);
  const groups = (CONFIG.fallbacks[tier] ?? []).map((group) => [...group]);
  // Fast models are speed variants of a standard family: when the fast lane has
  // no eligible target, the newest standard model of the same family is the
  // right fallback -- and it is DISCOVERED from the provider catalog, not
  // configured, so a new family release needs no config edit.
  if (tier === "fast-build") return [anthropicFamilyTargetIDs(targets, "claude-opus"), ...groups];
  return groups;
};

export const targetEligibleIDsFor = (profile, tier = "worker", targets = TARGETS) => [
  ...targetIDsFor(profile, tier, targets),
  ...fallbackTargetGroupsFor(profile, tier, targets).flat(),
];

const activeModel = (model) => !model?.status || model.status === "active";
// A speed variant is a lane of its own: it is pinned in config for fast-build and never
// joins a standard tier, and it never suppresses the standard model it is a variant of.
const SPEED_VARIANT = /-fast(?:-|$)/i;
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
// The single discovery policy. Keys include the provider because family names are not
// globally unique; an absent family is never guessed into a tier. `fit` is measured
// preference, so new GPT family members join their lane without inheriting a pin's fit.
// Ceiling: hosts cannot override roles yet. The upgrade is a validated config override
// merged over these safe defaults, never a replacement that can silently remove Opus.
export const FAMILY_TIERS = {
  "anthropic:claude-opus": { tiers: ["build", "smart"], fit: { build: 1.5 } },
  "anthropic:claude-sonnet": { tiers: ["build", "review"], fit: { review: 1.4 } },
  "anthropic:claude-fable": { tiers: ["deep"], fit: { deep: 1.5 } },
  "anthropic:claude-haiku": { tiers: ["worker", "classifier"], fit: {} },
  "openai:gpt-astra": { tiers: ["deep"], fit: {} },
  "openai:gpt-sol": { tiers: ["smart"], fit: {} },
  "openai:gpt-terra": { tiers: ["build"], fit: {} },
  // Luna cannot appoint itself to the security-sensitive classifier lane.
  "openai:gpt-luna": { tiers: ["worker"], fit: {} },
  // Alibaba stays pinned: API auth is not discoverable, and family `qwen` mixes max,
  // flash and image models, so no single tier assignment is correct.
};

// CRITICAL: A CATALOG IS NOT A RESOLVER. models.dev advertises every model a vendor ships;
// OpenCode resolves only what the deployment's provider config admits, which is routinely
// a strict subset (see `opencode models <provider> --pure`). A discovered model the host
// cannot resolve is strictly worse than no target at all: it is the newest of its family,
// so it wins its tier outright, and then every lease on it dies with
// `ProviderModelNotFoundError` and takes the tier down. Admission therefore drops it HERE,
// before it can become a candidate, so chooseTarget simply falls through to the next one.
//
// `resolvable` null means the caller's inventory already IS the host's resolver view (the
// live provider list), so there is nothing to intersect against. The id-shape check runs
// either way: a malformed id can never resolve, with or without a resolver view.
// Returns null when the model is admissible, otherwise the reason it was dropped.
const modelAdmissionFailure = (providerID, modelID, resolvable) => {
  if (typeof modelID !== "string" || !MODEL_ID.test(modelID)) return "invalid-model-id";
  if (resolvable && !resolvable.has(`${providerID}/${modelID}`)) return "unresolvable";
  return null;
};

// Model catalogs report API reference prices even when a provider's OAuth path is
// subscription-backed. OAuth is the admission signal; API-key and unknown auth
// remain quarantined so merely enabling a metered provider never spends tokens.
export const discoverSubscriptionTargets = (inventory, authTypes = {}, staticTargets = TARGETS,
  { resolvableModels = null } = {}) => {
  const all = Array.isArray(inventory?.all) ? inventory.all : [];
  const connected = new Set(Array.isArray(inventory?.connected) ? inventory.connected : []);
  const staticModelKeys = new Set(Object.values(staticTargets && typeof staticTargets === "object" ? staticTargets : {})
    .map((target) => `${target.providerID}/${target.modelID}`));
  const targets = {};
  const providers = {};
  const modelContexts = {};
  const modelOutputs = {};
  const modelVariants = {};
  // Every model dropped by admission, so the skip is reportable rather than silent.
  const skipped = [];
  const resolvable = resolvableModels instanceof Set ? resolvableModels
    : Array.isArray(resolvableModels) ? new Set(resolvableModels)
    : null;
  for (const provider of all) {
    const providerID = typeof provider?.id === "string" ? provider.id : "";
    if (!providerID) continue;
    const models = Object.values(provider.models ?? {});
    // Every catalog model's declared window feeds the broker's fit check. For cloud
    // providers this is discovered and authoritative. For a static provider like
    // llamacpp it is only a fallback: a target that declares its own `context` in the
    // router config outranks it -- see targetContext.
    for (const model of models) {
      const modelID = typeof model?.id === "string" ? model.id : "";
      // Same admission predicate as target discovery below: a window, an output budget or
      // a variant list for a model that can never be leased is dead weight in the
      // published inventory, and the keys would outlive the model that justified them.
      if (modelAdmissionFailure(providerID, modelID, resolvable)) continue;
      const context = Number(model?.limit?.context);
      if (Number.isFinite(context) && context > 0) {
        modelContexts[`${providerID}/${modelID}`] = Math.floor(context);
      }
      // The output budget rides along with the window: contextFits subtracts it so the
      // router stops refusing leases the HOST would still have been working in.
      const output = Number(model?.limit?.output);
      if (Number.isFinite(output) && output > 0) {
        modelOutputs[`${providerID}/${modelID}`] = Math.floor(output);
      }
      const variants = Object.keys(model?.variants ?? {}).filter((variant) =>
        typeof variant === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(variant));
      if (variants.length) {
        modelVariants[`${providerID}/${modelID}`] = [...new Set(variants)].sort();
      }
    }
    const authType = authTypes[providerID] ?? "unknown";
    const oauthModels = connected.has(providerID) && authType === "oauth"
      ? models.filter(activeModel)
      : [];
    const trustedSubscription = TRUSTED_SUBSCRIPTION_PROVIDER_IDS.has(providerID);
    const isConnected = connected.has(providerID);
    const summary = {
      authType,
      connected: isConnected,
      admission: providerAdmission({
        connected: isConnected,
        authType,
        modelCount: oauthModels.length,
        trusted: trustedSubscription,
      }),
      models: oauthModels.length,
    };
    providers[providerID] = summary;
    // One admission rule for every provider, and it is already computed: the list above
    // is empty unless the provider is connected AND OAuth. Being named in the config
    // `targets` map no longer switches discovery off wholesale -- the local key set makes
    // that gate per model, so pinning one model stops hiding the rest of a catalog.
    if (!oauthModels.length) continue;
    // Pins suppress aliases of the same family RELEASE, never the whole family line.
    // Only active OAuth catalog pins participate; excluding speed variants prevents a
    // fast-build pin from suppressing its standard model in smart/build.
    const pinnedLines = new Set(oauthModels
      .filter((model) => staticModelKeys.has(`${providerID}/${model?.id}`) &&
        !SPEED_VARIANT.test(model?.id ?? "") &&
        typeof model?.family === "string" && model.family && model?.release_date)
      .map((model) => `${model.family}\u0000${model.release_date}`));
    for (const model of oauthModels) {
      const family = typeof model?.family === "string" ? model.family : "";
      const mapped = FAMILY_TIERS[`${providerID}:${family}`];
      const releaseDate = typeof model?.release_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(model.release_date) &&
        Number.isFinite(Date.parse(`${model.release_date}T00:00:00Z`)) ? model.release_date : null;
      if (!mapped || !releaseDate || model.tool_call === false || SPEED_VARIANT.test(model.id ?? "")) continue;
      // Exact id also covers pins whose catalog entry has no family or release date.
      if (pinnedLines.has(`${family}\u0000${releaseDate}`) ||
        staticModelKeys.has(`${providerID}/${model.id}`)) continue;
      // Last gate, and deliberately the last one: everything above has already decided
      // this model WOULD take a lane, so a failure here is the interesting event -- a
      // mapped, unpinned, tool-calling model the host cannot actually address. Recorded,
      // never swallowed; the caller logs it (bin/opencode-broker-watch).
      const failure = modelAdmissionFailure(providerID, model.id, resolvable);
      if (failure) {
        skipped.push({ providerID, modelID: String(model?.id ?? ""), tiers: mapped.tiers, reason: failure });
        continue;
      }
      const id = `subscription-${slug(providerID)}-${slug(model.id)}-standard`;
      targets[id] = {
        id,
        providerID,
        modelID: model.id,
        kind: "cloud",
        capacity: null,
        source: "subscription-oauth",
        tiers: mapped.tiers,
        ...(Object.keys(mapped.fit).length ? { fit: mapped.fit } : {}),
        family,
        releaseDate,
        speed: "standard",
      };
    }
  }
  return { targets, providers, modelContexts, modelOutputs, modelVariants, skipped };
};

export const publishSubscriptionInventory = async ({ listProviders, directory, request = brokerRequest }) => {
  const { revision, types } = authSnapshot();
  if (!revision) throw new Error("unable to determine auth revision");
  // OpenCode's generated V2 client takes route parameters directly. Wrapping
  // `directory` in `query` causes TUI API calls to close before publishing.
  const result = await listProviders({ directory });
  const inventory = result?.data ?? result;
  // No resolvable set is intersected here: this inventory IS the host's own provider
  // list, so it already carries exactly what OpenCode resolves. The id-shape guard inside
  // discovery still applies.
  const { skipped, ...discovered } = discoverSubscriptionTargets(inventory, types);
  if (authSnapshot().revision !== revision) {
    throw new Error("auth revision changed during inventory refresh");
  }
  // `skipped` is a diagnostic for the caller, not inventory state: it is returned, not published.
  const published = await request("/inventory", { ...discovered, authRevision: revision });
  return { ...published, skipped };
};

// Routing hooks run inside OpenCode's prompt request. Calling the generated
// Provider.list client from there re-enters the server control socket and can reset
// the request. Static routing targets only need subscription-backed auth admission;
// catalog discovery remains available to non-prompt callers through the function
// above, but must not sit on the prompt's critical path.
export const publishAuthInventory = async ({ request = brokerRequest } = {}) => {
  const { revision, types } = authSnapshot();
  if (!revision) throw new Error("unable to determine auth revision");
  const providers = {};
  const providerIDs = new Set(Object.values(TARGETS)
    .filter((target) => target.kind === "cloud")
    .map((target) => target.providerID));
  for (const providerID of providerIDs) {
    const authType = types[providerID] ?? "unknown";
    const trusted = TRUSTED_SUBSCRIPTION_PROVIDER_IDS.has(providerID);
    providers[providerID] = {
      authType,
      connected: authType === "oauth" || (trusted && authType !== "unknown"),
      admission: providerAdmission({ connected: authType === "oauth" || (trusted && authType !== "unknown"), authType, trusted }),
      models: 0,
    };
  }
  if (authSnapshot().revision !== revision) {
    throw new Error("auth revision changed before inventory publication");
  }
  return request("/inventory", { providers, authOnly: true, authRevision: revision });
};

// The host's resolver view.
// The set of model references THIS host will actually resolve, straight from OpenCode's
// own resolver: `opencode models --pure` prints one `providerID/modelID` per line, and it
// reflects the deployment's provider config (an explicit `provider.<id>.models` block
// narrows a provider to a handful of the catalog's models, and OpenCode adds its own
// built-ins). The models.dev cache that discovery reads is the full vendor catalog and a
// strict superset of it, so the two must be intersected before anything becomes a target.
//
// It is a SNAPSHOT on disk rather than a live subprocess because the cached publication
// path runs inside chat.message: `opencode models --pure` takes ~3s here, and no prompt
// may pay that. bin/opencode-broker-watch refreshes the snapshot in the same job that
// refreshes the models.dev cache, so catalog and resolver view move together.
export const resolvableModelsPath = () => join(ROOT, "resolvable-models.json");

// Ask OpenCode. Batch contexts only (the watch job) -- never the prompt path.
// The opencode binary is a hard dependency of this broker, not an optimisation: a failure
// to run it, or an empty listing, THROWS here rather than degrading into "admit the raw
// catalog", which is the behaviour that took the worker and deep tiers down.
export const refreshResolvableModels = ({ exec = execFileSync, path = resolvableModelsPath() } = {}) => {
  let output;
  try {
    output = exec("opencode", ["models", "--pure"],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`unable to list resolvable models via 'opencode models --pure': ${error?.message ?? error}`);
  }
  const keys = [];
  for (const line of String(output).split("\n")) {
    const key = line.trim();
    if (MODEL_CATALOG_KEY.test(key)) keys.push(key);
  }
  if (!keys.length) {
    throw new Error("'opencode models --pure' listed no usable models; refusing to write an empty resolver view");
  }
  const models = [...new Set(keys)].sort();
  writeJson(path, { updatedAt: Date.now(), models });
  return new Set(models);
};

// CRITICAL: read side, and deliberately FAIL-CLOSED. A missing or unusable snapshot means
// "nothing is known to resolve", which fences catalog discovery off entirely and leaves
// every tier on its hand-pinned config targets -- the known-good ones. The opposite
// default (no snapshot, admit the whole catalog) is exactly the failure being fixed: it
// hands a tier to a model the host cannot address. The skip is reported, never silent.
export const readResolvableModels = (path = resolvableModelsPath()) => {
  const snapshot = readJson(path);
  const models = Array.isArray(snapshot?.models) ? snapshot.models : [];
  if (snapshot?.updatedAt != null && typeof snapshot.updatedAt === "number" &&
    Date.now() - snapshot.updatedAt > 72 * 3600_000) {
    const ageHours = Math.floor((Date.now() - snapshot.updatedAt) / 3600_000);
    console.warn(`resolvable-models snapshot is ${ageHours}h old; model admission may be stale`);
  }
  return new Set(models.filter((key) => typeof key === "string" && MODEL_CATALOG_KEY.test(key)));
};

// Prompt dispatch must not call Provider.list: doing so re-enters OpenCode's control
// socket. models.dev's local cache provides the same catalog without network or server
// re-entry, while the auth revision still guards admission at the broker boundary.
export const publishCachedSubscriptionInventory = async ({ cachePath = MODEL_CACHE_PATH,
  request = brokerRequest, listResolvableModels = readResolvableModels } = {}) => {
  const { revision, types } = authSnapshot();
  if (!revision) throw new Error("unable to determine auth revision");
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch (error) {
    throw new Error(`unable to read OpenCode model cache at ${cachePath}; run 'opencode models --refresh': ${error?.message ?? error}`);
  }
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error(`invalid OpenCode model cache at ${cachePath}; run 'opencode models --refresh'`);
  }
  const admitted = Object.values(catalog).filter((provider) => {
    const providerID = typeof provider?.id === "string" ? provider.id : "";
    const authType = types[providerID] ?? "unknown";
    return providerID && (authType === "oauth" ||
      (TRUSTED_SUBSCRIPTION_PROVIDER_IDS.has(providerID) && authType !== "unknown"));
  });
  const inventory = { all: admitted, connected: admitted.map((provider) => provider.id) };
  const { skipped, ...discovered } = discoverSubscriptionTargets(inventory, types, TARGETS,
    { resolvableModels: listResolvableModels() });
  // The cache rarely advertises variants; the deployment's own declarations
  // fill the gap so effort control actually happens.
  discovered.modelVariants = { ...CONFIG.modelVariants, ...discovered.modelVariants };
  if (authSnapshot().revision !== revision) {
    throw new Error("auth revision changed during cached inventory refresh");
  }
  // `skipped` is a diagnostic for the caller, not inventory state: it rides back on the
  // broker's own response (which carries `changed`, and which callers read) but is never
  // published into the inventory.
  const published = await request("/inventory", { ...discovered, authRevision: revision });
  return { ...published, skipped };
};

// The broker calls this when a lease arrives under a rotated auth.json: rather
// than refusing every caller until some plugin republishes, admission is
// recomputed from the FRESH auth types -- conservatively: discovered
// subscription targets whose provider no longer proves OAuth (and is not a
// trusted subscription integration) are dropped, so a revoked credential can
// never ride stale admission. Catalog content itself does not change with an
// auth rotation; only admission does.
export const revalidateAdmission = (inventory, types = {}) => {
  const providers = {};
  const providerIDs = new Set([
    ...Object.values(TARGETS).filter((target) => target.kind === "cloud").map((target) => target.providerID),
    ...Object.values(inventory?.targets ?? {}).map((target) => target.providerID),
  ]);
  for (const providerID of providerIDs) {
    const authType = types[providerID] ?? "unknown";
    const trusted = TRUSTED_SUBSCRIPTION_PROVIDER_IDS.has(providerID);
    providers[providerID] = {
      authType,
      connected: authType === "oauth" || (trusted && authType !== "unknown"),
      admission: providerAdmission({ connected: authType === "oauth" || (trusted && authType !== "unknown"), authType, trusted }),
      models: 0,
    };
  }
  const targets = {};
  for (const [id, target] of Object.entries(inventory?.targets ?? {})) {
    const authType = types[target.providerID] ?? "unknown";
    // Same rule for DISCOVERED targets: trusted exempts a provider from needing
    // oauth, never from having been removed. "unknown" means opencode no longer
    // holds a credential for it, so its targets must drop out of the inventory
    // instead of lingering as leasable dead ends.
    const trusted = TRUSTED_SUBSCRIPTION_PROVIDER_IDS.has(target.providerID);
    if (authType === "oauth" || (trusted && authType !== "unknown")) targets[id] = target;
  }
  return { ...inventory, targets, providers };
};

export const normalizeDiscoveredInventory = (inventory) => {
  const targets = {};
  for (const candidate of Object.values(inventory?.targets ?? {})) {
    if (!TARGET_ID.test(candidate?.id ?? "") || typeof candidate?.providerID !== "string" ||
      !candidate.providerID || typeof candidate?.modelID !== "string" || !candidate.modelID ||
      !Array.isArray(candidate.tiers) || !candidate.tiers.length ||
      candidate.tiers.some((tier) => !ROUTING_TIERS.has(tier))) continue;
    if (candidate.kind === "cloud") {
      if (candidate.source !== "subscription-oauth" || candidate.capacity !== null) continue;
    } else if (candidate.kind === "local") {
      if (!Number.isInteger(candidate.capacity) || candidate.capacity < 1) continue;
    } else {
      continue;
    }
    targets[candidate.id] = {
      id: candidate.id,
      providerID: candidate.providerID,
      modelID: candidate.modelID,
      kind: candidate.kind,
      capacity: candidate.capacity,
      ...(candidate.kind === "cloud" ? { source: "subscription-oauth" } : {}),
      tiers: [...new Set(candidate.tiers)],
      ...(FAMILY_TIERS[`${candidate.providerID}:${candidate.family}`] &&
        typeof candidate.releaseDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.releaseDate) &&
        candidate.speed === "standard"
        ? { family: candidate.family, releaseDate: candidate.releaseDate, speed: "standard" }
        : {}),
      ...(() => {
        const fit = {};
        for (const [tier, value] of Object.entries(candidate.fit && typeof candidate.fit === "object" ? candidate.fit : {})) {
          const weight = Number(value);
          if (ROUTING_TIERS.has(tier) && Number.isFinite(weight) && weight > 0) fit[tier] = weight;
        }
        return Object.keys(fit).length ? { fit } : {};
      })(),
    };
  }
  const providers = {};
  for (const [providerID, summary] of Object.entries(inventory?.providers ?? {})) {
    if (typeof providerID !== "string" || !providerID || typeof summary !== "object" || !summary) continue;
    const authType = summary.authType === "oauth" ? "oauth" : String(summary.authType ?? "unknown");
    const connected = summary.connected === true;
    providers[providerID] = {
      authType,
      connected,
      // `classification` is the pre-0.43 persisted field; normalize it once and
      // publish only the admission contract from here onward.
      admission: normalizeProviderAdmission(summary.admission ?? summary.classification),
      models: Number.isInteger(summary.models) ? summary.models : 0,
    };
  }
  const modelContexts = {};
  for (const [key, value] of Object.entries(inventory?.modelContexts ?? {})) {
    const context = Number(value);
    if (typeof key !== "string" || key.length > 400 || !key.includes("/") ||
      !Number.isFinite(context) || context <= 0 || context > 20_000_000) continue;
    modelContexts[key] = Math.floor(context);
  }
  const modelOutputs = {};
  for (const [key, value] of Object.entries(inventory?.modelOutputs ?? {})) {
    const output = Number(value);
    if (typeof key !== "string" || key.length > 400 || !key.includes("/") ||
      !Number.isFinite(output) || output <= 0 || output > 20_000_000) continue;
    modelOutputs[key] = Math.floor(output);
  }
  const modelVariants = {};
  for (const [key, variants] of Object.entries(inventory?.modelVariants ?? {})) {
    if (typeof key !== "string" || !MODEL_CATALOG_KEY.test(key) || !Array.isArray(variants)) continue;
    const valid = [...new Set(variants.filter((variant) =>
      typeof variant === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(variant)))].sort();
    if (valid.length) modelVariants[key] = valid;
  }
  return { targets, providers, modelContexts, modelOutputs, modelVariants };
};

const circuitOpen = (circuit, now) => {
  if (!circuit) return false;
  return circuit.until === null || Number(circuit.until) > now;
};

// Subscription providers commonly include a precise renewal time in their first
// quota response. Keep the provider usable again at that time without spending a
// probe request. A provider that omits it remains blocked until the operator confirms
// recovery and rearms it; guessing a reset risks repeatedly sending known-failing work.
export const quotaRenewalAt = (error, now = Date.now()) => {
  const structured = normalizeProviderError(error).resetAt;
  if (structured) {
    const parsed = Date.parse(structured);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  const text = providerErrorText(error);
  const timestamp = text.match(/(?:renew(?:s|al)?|reset(?:s)?|available again)\D{0,48}(20\d\d-[0-1]\d-[0-3]\d[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][0-2]\d:?[0-5]\d)?)/i);
  if (timestamp) {
    const parsed = Date.parse(timestamp[1].replace(" ", "T"));
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  const duration = text.match(/(?:renew(?:s|al)?|reset(?:s)?|available again)\D{0,32}\bin\s+(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?)/i);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2].toLowerCase();
    const multiplier = unit.startsWith("second") ? 1000
      : unit.startsWith("minute") ? 60 * 1000
        : unit.startsWith("hour") ? 60 * 60 * 1000
          : unit.startsWith("day") ? 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
    if (Number.isFinite(amount) && amount > 0) return now + amount * multiplier;
  }
  return null;
};

const eligible = (target, { active = {}, circuits = {}, health = {}, localModels, now = Date.now(), targets = TARGETS, contextTokens = null, modelContexts = {}, modelOutputs = {}, budgets = {}, budgetConfig = PROVIDER_BUDGETS, ignoreContext = false }) => {
  if (!target || circuitOpen(circuits[target.id], now) ||
    circuitOpen(circuits[providerCircuitID(target)], now)) return false;
  // ignoreContext is the last-resort pass only (see chooseTarget): everything else
  // about the target must still hold, so circuits, capacity, health and quota below
  // are never skipped -- only the size check is.
  if (!ignoreContext) {
    if (target.kind === "local") {
      if (!localContextEligible(targetContext(target, modelContexts), contextTokens,
        targetContextHeadroom(target), targetOutputReserve(target, modelOutputs))) return false;
    } else if (!contextFits(targetContext(target, modelContexts), contextTokens,
      targetOutputReserve(target, modelOutputs))) {
      return false;
    }
  }
  // A declared floor makes a target ineligible for work too small to be worth
  // it. Scarce targets (a big local model with 2 slots next to a small one with
  // 6) otherwise take trivial turns by pure round-robin: nothing in the tiebreak
  // below looks at the request, so without this the expensive slot is spent on
  // whatever arrives first. Only rejects on a KNOWN size -- an unknown context
  // is already refused for local targets above and stays permissive for cloud,
  // so the floor never invents a new failure mode for callers that report none.
  if (!meetsContextFloor(target, contextTokens)) return false;
  if (targetFull(target, active)) return false;
  const providerActive = Object.entries(active).reduce((counts, [targetID, count]) => {
    const candidate = targetForID(targetID, targets);
    if (!candidate) return counts;
    counts[candidate.providerID] = (counts[candidate.providerID] ?? 0) + Number(count || 0);
    return counts;
  }, {});
  if (!providerEligible(health, target.providerID, providerActive[target.providerID] ?? 0)) return false;
  if (target.kind === "local") return localModels instanceof Set && localModels.has(target.modelID);
  return true;
};

// Pure selection: callers persist `nextCursor` only after granting the lease. Auto
// worker routing reserves one in four eligible assignments for the shared local model;
// the remaining cloud assignments use weighted depletion. Providers within this much
// observed utilization count as balanced, and the cursor avoids tiny-spend flapping.
const BUDGET_EPSILON = 0.02;
const AUTO_LOCAL_SHARE_DENOMINATOR = CONFIG.workerLocalShareDenominator;

const datedSnapshot = (modelID) => /(?:^|-)(?:20\d{6}|20\d{2}-\d{2}-\d{2})$/.test(modelID);
// Newest-per-family collapse for every provider, not just Anthropic: a discovered target
// carries family/releaseDate/speed, a configured pin carries none of them and passes
// through untouched, so this only ever prunes the catalog's own back-catalogue.
const collapseNewestFamilies = (candidates) => {
  const grouped = new Map();
  const passthrough = [];
  for (const target of candidates) {
    if (!target.family || !target.releaseDate || target.speed !== "standard") {
      passthrough.push(target);
      continue;
    }
    const key = `${target.providerID}:${target.family}:${target.speed}`;
    const current = grouped.get(key);
    const better = !current || target.releaseDate > current.releaseDate ||
      (target.releaseDate === current.releaseDate && datedSnapshot(current.modelID) && !datedSnapshot(target.modelID)) ||
      (target.releaseDate === current.releaseDate && datedSnapshot(current.modelID) === datedSnapshot(target.modelID) &&
        target.id.localeCompare(current.id) < 0);
    if (better) grouped.set(key, target);
  }
  return [...passthrough, ...grouped.values()];
};

// ☠️☠️ AN UNREADABLE QUOTA MUST NOT READ AS AN EMPTY ONE. Weighted depletion
// spends into the lowest utilization, so a provider whose real usage cannot be
// observed -- its plan-usage source unauthenticated, unreachable, or absent --
// reports only what THIS host's ledger saw and therefore looks emptier than
// every provider that reports honestly. It then wins the comparison over and
// over and is drained first, which is precisely backwards: the lane we can least
// account for is the one we spend hardest. Measured 2026-09-04: alibaba read
// 2.75% against anthropic's 32% and openai's 18% purely because its plan-usage
// CLI had no console token, and every build lease went to it.
// Fix: float an unobserved CLOUD provider up to the mean of the observed ones so
// it sits IN BALANCE -- never preferred for being unreadable, never fenced for
// it either. `max` keeps a HIGHER inferred figure: if the local ledger already
// says the lane is heavily used that is real evidence, and only the
// implausibly-empty case is corrected.
// ☆ Local targets are excluded: they have no quota to deplete, so their 0 is a
// fact rather than a gap. The worker local-share selects them, not this.
// ☆ With nothing observed there is no balance point to move toward, so every
// value is left exactly as it was.
// Mutates `utilizations` in place and returns the balance applied (or null).
export const balanceUnobservedUtilization = (targets, utilizations, isObserved) => {
  // ☠️ Average PER PROVIDER, not per target. Utilization is a property of the
  // provider, so a provider contributing three targets to a tier would otherwise
  // count three times and drag the balance point toward its own figure -- the
  // mean of anthropic 0.32 and openai 0.18 must be 0.25, not 0.2733 because
  // anthropic happened to field two eligible models.
  const observedByProvider = new Map();
  const unobserved = [];
  for (const target of targets) {
    if (!target || target.kind !== "cloud") continue;
    if (isObserved(target.providerID)) {
      if (!observedByProvider.has(target.providerID)) {
        observedByProvider.set(target.providerID, utilizations.get(target.id) ?? 0);
      }
    } else {
      unobserved.push(target);
    }
  }
  const observedValues = [...observedByProvider.values()];
  if (!observedValues.length || !unobserved.length) return null;
  const balance = observedValues.reduce((total, value) => total + value, 0) / observedValues.length;
  for (const target of unobserved) {
    utilizations.set(target.id, Math.max(utilizations.get(target.id) ?? 0, balance));
  }
  return balance;
};

export const chooseTarget = ({ profile, tier, active = {}, circuits = {}, health = {}, cursors = {}, localModels, now = Date.now(), targets = TARGETS, contextTokens = null, modelContexts = {}, modelOutputs = {}, budgets = {}, budgetConfig = PROVIDER_BUDGETS, deals = undefined, tierWeights = undefined }) => {
  const weights = (tierWeights === undefined ? CONFIG.tierProviderWeights : tierWeights)?.[tier] ?? {};
  const providerWeightOf = (target) => weights[target.providerID] ?? 1;
  const fitOf = (target) => target.fit?.[tier] ?? 1;
  const weightOf = (target) => providerWeightOf(target) * fitOf(target);
  const fit = { active, circuits, health, localModels, now, targets, contextTokens, modelContexts, modelOutputs, budgets, budgetConfig };
  const primaryIDs = targetIDsFor(profile, tier, targets);
  const fallbackGroups = fallbackTargetGroupsFor(profile, tier, targets);
  const primaryCandidates = primaryIDs.map((id) => targetForID(id, targets)).filter(Boolean);
  const primaryCloud = primaryCandidates.filter((target) => target.kind === "cloud");
  const primaryLocal = primaryCandidates.filter((target) => target.kind === "local");
  const availablePrimaryCloud = collapseNewestFamilies(primaryCloud.filter((target) => eligible(target, fit)));
  const availablePrimaryLocal = primaryLocal.filter((target) => eligible(target, fit));
  const availablePrimary = [...availablePrimaryCloud, ...availablePrimaryLocal];

  const availableFallback = fallbackGroups
    .map((ids) => collapseNewestFamilies(ids.map((id) => targetForID(id, targets)).filter(Boolean).filter((target) => eligible(target, fit))))
    .find((group) => group.length) ?? [];
  const usingFallback = !availablePrimary.length && availableFallback.length > 0;
  const availableCloud = usingFallback ? availableFallback : availablePrimaryCloud;
  const availableLocal = usingFallback ? [] : availablePrimaryLocal;
  const available = usingFallback ? availableFallback : availablePrimary;
  // ☠️ LAST RESORT: a session too big for every window in its tier used to get NOTHING,
  // and `failLease` turns nothing into a thrown turn. Compaction rides the session's own
  // tier, so the refusal blocked the one operation that could have made the session small
  // enough to route -- a session that crossed the line could not run and could not shrink,
  // and only a manual model pin got it back. Hand it the ROOMIEST cloud window instead:
  // the request may still overflow at the provider, but an overflow is recoverable (the
  // plugin reads the real size out of the error and re-leases) whereas a refusal is not.
  // ☆ Cloud only, and only when context was the sole disqualifier. A local slot's window
  // is a hard wall with no bigger sibling behind it, and a LAN-confined profile that
  // genuinely cannot serve a request should say so rather than fail at the provider.
  if (!available.length) {
    if (contextTokens === null || contextTokens === undefined) return null;
    const overflowFit = { ...fit, ignoreContext: true };
    const roomiest = [...primaryCandidates, ...fallbackGroups.flat().map((id) => targetForID(id, targets))]
      .filter((target) => target && target.kind === "cloud" && eligible(target, overflowFit))
      .map((target) => ({ target, window: Number(targetContext(target, modelContexts)) || 0 }))
      .filter((entry) => entry.window > 0)
      .sort((a, b) => b.window - a.window)[0];
    if (!roomiest) return null;
    return {
      target: roomiest.target,
      cursorKey: `${profile}:${tier}:overflow`,
      nextCursor: Number(cursors[`${profile}:${tier}:overflow`] ?? 0) + 1,
      decision: {
        policy: "context-overflow-last-resort",
        reasons: [`no target in ${tier} fits ${contextTokens} tokens; leased the roomiest window (${roomiest.window}) so the session can still compact`],
        eligibleTargetIDs: [roomiest.target.id],
        balancedTargetIDs: [roomiest.target.id],
        providerUtilization: {},
      },
    };
  }

  const localShare = profile === "auto" && tier === "worker" &&
    availableCloud.length > 0 && availableLocal.length > 0;
  const cursorKey = `${profile}:${tier}:${localShare ? "mixed" : availableCloud.length ? "cloud" : "local"}`;
  const cursor = Number(cursors[cursorKey] ?? 0);
  const group = localShare && cursor % AUTO_LOCAL_SHARE_DENOMINATOR === 0
    ? availableLocal
    : availableCloud.length ? availableCloud : availableLocal;
  if (!group.length) return null;

  // Weighted depletion: spend where the most observed headroom is left. Local has no
  // subscription quota, so its separately configured share is selected above.
  const utilizations = new Map(available.map((target) => [
    target.id,
    effectiveUtilization(budgets, target.providerID, now, budgetConfig),
  ]));
  balanceUnobservedUtilization(available, utilizations, utilizationIsObserved);
  const effective = (target) => utilizations.get(target.id) / weightOf(target);
  const leanest = Math.min(...group.map(effective));
  let balanced = group.filter((target) => effective(target) - leanest <= BUDGET_EPSILON);
  // At equal effective headroom (the all-zero fresh window especially), the
  // preferred provider still absorbs the tier.
  const bestWeight = Math.max(...balanced.map(weightOf));
  const weighted = balanced.filter((target) => weightOf(target) === bestWeight);
  const usedProviderWeight = weighted.length < balanced.length &&
    new Set(balanced.map(providerWeightOf)).size > 1;
  const usedFit = weighted.length < balanced.length &&
    new Set(balanced.map(fitOf)).size > 1;
  if (weighted.length) balanced = weighted;

  const loadScore = (target) => {
    if (target.capacity === null) return 0;
    const capacity = Number(target.capacity);
    const activeCount = Number(active[target.id] ?? 0) || 0;
    return Number.isFinite(capacity) && capacity > 0 ? activeCount / capacity : 0;
  };
  // Usage deals reorder WITHIN the balanced set: discounted capacity absorbs
  // traffic first, without ever changing which targets are eligible for the tier.
  const dealOf = (target) => activeDealMultiplier({ providerID: target.providerID, modelID: target.modelID }, now, deals);
  const bestDeal = Math.min(...balanced.map(dealOf));
  const discounted = bestDeal < 1 ? balanced.filter((target) => dealOf(target) === bestDeal) : balanced;
  const score = Math.min(...discounted.map(loadScore));
  const tied = discounted.filter((target) => loadScore(target) === score);
  const target = tied[cursor % tied.length];
  const reasons = [];
  if (balanced.length < available.length) reasons.push("lowest-normalized-provider-utilization");
  if (usedProviderWeight) reasons.push("tier-provider-preference");
  if (usedFit) reasons.push("model-tier-fit");
  if (bestDeal < 1 && discounted.length < balanced.length) reasons.push(`active-usage-deal-x${bestDeal}`);
  if (tied.length < discounted.length) reasons.push("lowest-active-capacity-ratio");
  if (tied.length > 1) reasons.push("round-robin-tiebreak");
  if (!reasons.length) reasons.push("only-eligible-target");
  // ☆ A restrictive profile that degraded must SAY SO. `strict-fallback` alone reads
  // the same as a tier rung; a user on `local` who is quietly being served by the
  // profile's last rung instead of its primary model deserves to find that in
  // /selection rather than infer it from the model name. Non-auto only, so nothing
  // about the auto trail changes.
  if (usingFallback && profile !== "auto") reasons.push("profile-fallback-rung");
  return {
    target,
    cursorKey,
    nextCursor: cursor + 1,
    decision: {
      policy: usingFallback
        ? "strict-fallback"
        : localShare ? "weighted-depletion-with-local-share" : "weighted-depletion",
      reasons,
      eligibleTargetIDs: available.map((candidate) => candidate.id),
      balancedTargetIDs: balanced.map((candidate) => candidate.id),
      providerUtilization: Object.fromEntries(available.map((candidate) => [
        candidate.providerID,
        utilizations.get(candidate.id),
      ])),
    },
  };
};

export const classifyRoutingFailure = (error) => {
  const safe = normalizeProviderError(error);
  const text = providerErrorText(safe).toLowerCase();
  if (safe.code === "LOCAL_INACTIVITY_TIMEOUT") return "overload";
  // Caller-side non-faults that must NEVER indict a provider, no matter which
  // client reports them (an old plugin in a live session can't be patched
  // in place -- the broker is the authority). An empty/unparsable classifier
  // response and a caller timeout are the caller's problem; the model behind
  // gpt-5.6-luna answers fine. Benching for these churned openai/llamacpp
  // into "observing" on every command (2026-09-01).
  // ☠️ The router's OWN guard errors belong here too, and their absence cost three
  // providers. `routed model mismatch` and `route unavailable` are thrown by this
  // plugin about its own cached route -- the provider was never even called. They
  // were reaching the default branch as "other", which is one of only two kinds that
  // record health evidence, so two of them inside fifteen minutes quarantined the
  // provider until its re-probe. On 2026-09-15 a local slot
  // overflow failed over to cloud while leaving the stale local model on the retry;
  // the mismatch guard fired, and openai, alibaba-token-plan and llamacpp all went
  // dark, collapsing every tier onto the one surviving lane.
  // ☠️ HTTP 499 is "client closed request" -- it is OUR abort, observed from the
  // server side, and it names the caller's impatience, never the provider's health.
  // It arrives as a wrapped string (`classifier request failed (HTTP 499): {}`), so
  // `isAbortError` cannot see it: the name is "Error" and the message is that whole
  // sentence. Reaching the default branch as "other" is how the guard's
  // classifier's own 30s timeout put llamacpp into quarantine on 2026-09-17 --
  // local-classifier had answered every real request that hour.
  if (/classifier returned no text|returned no text|no (?:output|content|completion)|empty (?:response|completion|output)|routed model mismatch|route unavailable; resend the prompt|\(http 499\)|\bhttp[._ -]?499\b|client closed request/.test(text)) {
    return "noop";
  }
  const modelEvidence = /\bmodel(?:[._ -]?(?:not[._ -]?found|unavailable|does not exist|is not available|unsupported|unknown))\b|\b(?:not[._ -]?found|model[._ -]?unavailable)\b.{0,80}\bmodel\b|\bmodel\b\s*[:=-]\s*[a-z0-9][\w.-]*/.test(text);
  // Entitlement denials on catalog-listed models (subscription plans serve a
  // catalog wider than any one plan's entitlement): fence the MODEL, not the
  // provider, so an optimistic pin costs one failed call and nothing else.
  const modelDenied = /\baccess to (?:the )?model denied\b|\bmodel access denied\b|\bnot entitled\b.{0,60}\bmodel\b|\bmodel\b.{0,60}\bnot (?:entitled|authorized|permitted)\b/.test(text);
  const modelErrorCode = /\bmodel[._-]?(?:not[._-]?found|unavailable|unknown|unsupported|denied)\b|\baccessdenied[._-]?model\b/.test(String(safe.code ?? "").toLowerCase());
  // ☠️ A CLIENT-VERSION GATE IS A FACT ABOUT ONE MODEL, NOT THE PROVIDER'S HEALTH.
  // Anthropic refuses a model the installed client is too old to drive: "Claude Code
  // 2.1.217 does not support this model; version 2.1.251 or newer is required." Every
  // other model on the same subscription answers normally, so indicting the provider
  // benches every build, smart and deep lane over one model the binary cannot speak to
  // yet -- and it is DETERMINISTIC, so the retry ladder reproduces it on sibling models
  // and manufactures the distinct-model evidence a quarantine needs, exactly like a
  // malformed payload does. Caught live on 2026-09-17 with claude-fable-5-1 already at
  // `observing`: one more family and anthropic would have gone dark for the third time
  // that day. Fencing the TARGET is both correct and self-healing -- the model returns
  // to the pool the moment the client is updated.
  const modelClientTooOld = /does not support this model|does not support the model|version [\d.]+ or newer is required|requires? (?:a )?(?:newer|later) (?:client|version|release)/.test(text);
  if (modelErrorCode || modelClientTooOld || (safe.statusCode === 404 && modelEvidence) ||
      ((safe.statusCode === 403 || safe.statusCode === undefined) && modelDenied)) return "model";
  // A stale or revoked credential is OUR auth store's problem, not provider
  // compatibility: it heals on the next token refresh. Indicting the provider
  // for it quarantined a perfectly healthy openai lane (2026-08-31).
  if (safe.statusCode === 401 ||
      /\bunauthorized\b|\bauthentication[._ -]?(?:failed|error|required)\b|invalid[._ -]?(?:api[._ -]?key|access[._ -]?token|bearer|credential)|token[._ -]?(?:expired|revoked|invalid)|expired[._ -]?(?:token|credential)|credential[._ -]?(?:expired|revoked)|\bre-?authenticat/.test(text)) return "auth";
  // Account-scoped limit wording is a PLAN window, not a burst limit: it holds
  // for hours and covers every model on the provider, so it must circuit the
  // provider until the window resets rather than one target for five minutes.
  if (/would exceed your account.{0,8}rate limit|account.{0,24}(?:rate ?limit|spend(?:ing)? limit|usage limit).{0,24}(?:exceed|reached|hit)|account.{0,8}(?:rate ?limit|spend(?:ing)? limit|usage limit)/.test(text)) return "quota";
  if (/throttling[._-]?ratequota|rate[._ -]?quota|limitrequests|limit_requests|throttling[._-]?burstrate|concurren|retry.?after/.test(text)) return "rate";
  if (/throttling[._-]?allocationquota|insufficient[._-]?quota|allocated quota exceeded|usage allocated quota exceeded|exceeded your current quota|token-plan.*exhausted|insufficient.*credit|billing|(?:daily|weekly|monthly|subscription|usage).{0,32}(?:cap|limit|exhausted)|(?:cap|limit).{0,32}(?:reset|renew|exhausted)/.test(text)) return "quota";
  if (/\b429\b|rate.?limit|too many requests|retry.?after/.test(text)) return "rate";
  // Provider capacity overload (Anthropic 529, some 503s) is TRANSIENT, not a
  // fault -- it usually clears in seconds. Treat it as its own kind so the
  // broker fences the target only briefly and records NO health evidence: a
  // brief overload must not quarantine a provider or force a lasting switch.
  if (Number(safe.statusCode) === 529 || Number(safe.statusCode) === 503 ||
      /\boverloaded?\b|too busy|temporarily unavailable|service unavailable|capacity/.test(text)) {
    return "overload";
  }
  // Context overflow is a FIT problem, not a provider fault: the model answered
  // correctly that the request does not fit its window. Indicting the provider
  // for it would fence a healthy lane (and llama.cpp is the lane that serves
  // every local target). Classified so the next lease can prefer a roomier
  // window instead of blaming the target -- see contextOverflow handling in the
  // broker's /failure route.
  if (/exceeds the available context size|context[._ -]?length[._ -]?exceeded|maximum context length|too many tokens|reduce the length of the messages|prompt is too long/.test(text)) {
    return "context";
  }
  // ☠️ A DEAD SOCKET IS THE CLEAREST "this target is down" SIGNAL THERE IS, and it was
  // reaching the default branch as "other". On 2026-09-14 llama.cpp went down mid-deploy and a
  // `tester` on qwen3.5-9b hit `Cannot connect to API` five times in 33 seconds, surfacing each
  // one to the user in AUTO -- where a cloud lane was sitting there healthy.
  // ☆ It is its own kind, not `overload`: overload means the server ANSWERED (529/503) and will
  // clear in seconds. This means nothing answered at all, so there is no status code to read and
  // every target on that provider is equally gone -- which is why the broker circuits the
  // PROVIDER for this kind rather than the one target it happened to be asked about.
  // ☆ And no health evidence, for the same reason `overload` records none: a container restart
  // must not quarantine the lane for the rest of the day.
  // ☆ NARROW ON PURPOSE: only "never got a connection", never "the connection broke". A mid-stream
  // `connection reset` or `socket hang up` may be one bad stream on a healthy endpoint, and this
  // kind circuits the whole PROVIDER -- too big a hammer for that. Those stay "other", which is
  // what tests/routing.test.mjs already pinned before this kind existed.
  // ☠️ THE REQUEST WAS MALFORMED, WHICH IS OUR BUG, NOT THE PROVIDER'S ILL HEALTH --
  // and it is the one failure shape that MANUFACTURES its own quarantine evidence.
  // A bad payload belongs to the SESSION, so it reproduces identically on every model
  // of every provider it is handed to; failover then walks it across siblings and
  // hands `recordFailureEvidence` exactly the >=2 distinct models the quarantine rule
  // asks for. On 2026-09-17 an openai plan-limit failover carried a transcript whose
  // `tool_use` blocks had lost their `tool_result` partners (the turn died mid-tool-call,
  // OpenAI-shaped `call_…` ids and all) onto anthropic: opus-5 rejected it with a 400,
  // opus-4-8 rejected the same bytes seven seconds later, and the provider serving every
  // build and smart lane went dark with two healthy models and zero sick ones.
  // ☆ No circuit and no evidence, like `context` above: the provider ANSWERED, and it
  // answered correctly. Only resending or compacting the session fixes this, and
  // benching a lane does not.
  // ☆ Alibaba's Anthropic-compat shim reports an unimplemented ROUTE this way too --
  // HTTP 404 with `{"code":"InvalidParameter","message":"Not support"}`, rendered
  // "Not Found: Not support". Verified 2026-09-17 against the live endpoint: every
  // configured model id answers 200, as do tools, cache_control, thinking and
  // count_tokens, while `/models` and `/organizations/usage_report/messages` return
  // exactly that error. It is a call the shim does not serve, not a model and not a
  // fault -- but it quarantined alibaba-token-plan across deepseek-flash and qwen-flash.
  if (/tool_use\b.{0,120}\btool_result\b|\btool_result\b.{0,120}\btool_use\b|unexpected .?tool_use_id|invalid[._ -]?request[._ -]?error|\binvalidparameter\b|not found: not support/.test(text)) {
    return "payload";
  }
  if (safe.statusCode === undefined &&
      /cannot connect|unable to connect|econnrefused|enotfound|ehostunreach|enetunreach|fetch failed/.test(text)) {
    return "connect";
  }
  return "other";
};

const OFFLINE_TOOLS = new Set([
  "read", "glob", "grep", "edit", "write", "patch", "bash", "task", "todowrite",
  "question", "skill", "lsp", "list", "todoread",
]);
const LOCAL_ONLINE_TOOLS = new Set([
  ...OFFLINE_TOOLS,
  "webfetch", "websearch",
  ...CONFIG.profileTools.localOnlineExtra,
]);
const LOCAL_ONLINE_PREFIXES = CONFIG.profileTools.localOnlinePrefixes;

export const toolAllowedForProfile = (profile, tool) => {
  if (profile === "auto" || profile === "manual") return { allowed: true };
  if (isOfflineProfile(profile)) {
    return OFFLINE_TOOLS.has(tool)
      ? { allowed: true }
      : { allowed: false, reason: `${profile} blocks network and MCP tools` };
  }
  if (LOCAL_ONLINE_TOOLS.has(tool) ||
    LOCAL_ONLINE_PREFIXES.some((prefix) => String(tool).startsWith(prefix))) return { allowed: true };
  return { allowed: false, reason: `${profile} allows only core tools and the configured extras` };
};

export const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

export const wrapOfflineCommand = (command, cwd) =>
  `bwrap --die-with-parent --unshare-net --bind / / --proc /proc --dev /dev --chdir ${shellQuote(cwd)} /bin/sh -lc ${shellQuote(command)}`;

// Facade re-exports: consumers import this one stable module while the code
// lives in budgets.js (window math), client.js (the broker wire) and config.js
// (deployment data).
export { brokerRequest, brokerSocketPath };
export { PROVIDER_BUDGETS, recordBudgetUsage, budgetUtilization, effectiveUtilization, utilizationIsObserved, budgetReport, learnCapacityFromFailure, capacityFor } from "./budgets.js";
export { CONFIG } from "./config.js";
