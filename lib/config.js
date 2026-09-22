// Deployment configuration for opencode-broker.
//
// EVERYTHING model- and site-specific lives here, loaded once from
// ~/.config/opencode-broker/config.json (override the path with
// OPENCODE_BROKER_CONFIG). The code in the sibling modules is pure
// mechanism: which models exist, which tier lane each serves, what each
// subscription's windows look like, and where the local model server answers are
// all DATA a deployment declares -- see examples/config.example.json.
//
// With no config file the broker still serves and every lease fails with a clear
// "no targets configured" -- safe, useless, and honest. Nothing here invents a
// default model: a router that silently spends someone's metered provider
// because it shipped with that provider's name baked in would be exactly the
// bug this file exists to prevent.
import { existsSync, readFileSync } from "node:fs";
import { BURN_DEFAULTS } from "./burn-watch.js";
import { SLOT_DEFAULTS } from "./slot-watch.js";
import { homedir } from "node:os";
import { join } from "node:path";

// Where the config lives, in precedence order:
//   1. $OPENCODE_BROKER_CONFIG
//   2. $OPENCODE_MODEL_ROUTER_CONFIG                  (deprecated name)
//   3. $XDG_CONFIG_HOME/opencode-broker/config.json    (XDG_CONFIG_HOME defaults to ~/.config)
//   4. ~/.config/opencode-model-router/config.json     (deprecated location)
// The deprecated names are still honoured so an existing install keeps working
// after the rename; each one that is actually used is recorded in DEPRECATIONS,
// which the broker prints at startup and returns from /status. Nothing is
// printed from here: this module is also imported by the TUI plugin, where a
// stray stderr line lands on the user's screen.
export const DEPRECATIONS = [];
const CONFIG_BASE = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
export const CONFIG_DIR = join(CONFIG_BASE, "opencode-broker");
export const LEGACY_CONFIG_DIR = join(homedir(), ".config/opencode-model-router");
export const envSetting = (name, legacyName) => {
  if (process.env[name]) return process.env[name];
  if (legacyName && process.env[legacyName]) {
    DEPRECATIONS.push(`${legacyName} is deprecated; set ${name} instead.`);
    return process.env[legacyName];
  }
  return undefined;
};
// A file that lives in the config directory, falling back to the pre-rename
// directory when only the old one has it.
export const configFile = (name, legacyName = name) => {
  const current = join(CONFIG_DIR, name);
  if (existsSync(current)) return current;
  const legacy = join(LEGACY_CONFIG_DIR, legacyName);
  if (existsSync(legacy)) {
    DEPRECATIONS.push(`${legacy} is read from the deprecated opencode-model-router directory; move it to ${current}.`);
    return legacy;
  }
  return current;
};
const CONFIG_PATH = envSetting("OPENCODE_BROKER_CONFIG", "OPENCODE_MODEL_ROUTER_CONFIG") ?? configFile("config.json");

const TARGET_ID = /^[a-z0-9][a-z0-9._:-]{0,180}$/;
const ROUTE_TIER_NAMES = ["worker", "review", "build", "fast-build", "smart", "deep", "classifier"];
// The config is JSONC: it carries `//` notes explaining why each target exists
// and what its capacity/context mean, and those notes are the only place that
// reasoning is written down. JSON.parse rejects them, so strip comments first.
// ☠️ Strip them STRING-AWARE. A blind /\/\/.*$/ also eats the "//" inside
// "localModelsUrl": "http://gpu-box:8080/v1/models", which silently drops
// the local model server and sends every local request to a paid provider.
const stripJsonComments = (text) => {
  let out = "", inString = false, escaped = false, i = 0;
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;                       // keep the newline: line numbers survive
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

// ☠️☠️ A MALFORMED config must never be mistaken for an ABSENT one. Swallowing
// the parse error with `catch { return {}; }` cost a real outage on 2026-09-04:
// a `//` note added to this file left CONFIG.targets empty, so every local
// target vanished, the broker refused every lease as "all lightweight routing
// targets are busy or unavailable", and work that should have run on the local
// GPUs silently went to paid providers instead. Nothing logged a word.
// Absent file  -> {} in silence; that IS the documented, intended default.
// Present file that will not parse -> keep serving (throwing here would take
// down the plugin and TUI that import this module too), but say so loudly and
// publish the reason so /status and the lease refusal can name the real cause
// instead of blaming provider capacity.
export let CONFIG_ERROR = null;

const raw = (() => {
  let text;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return {};                        // no config file: documented default
  }
  try {
    return JSON.parse(stripJsonComments(text)) || {};
  } catch (error) {
    CONFIG_ERROR = `${CONFIG_PATH}: ${error.message}`;
    console.error(`opencode-broker: CONFIG FAILED TO PARSE -- routing has NO targets. ${CONFIG_ERROR}`);
    return {};
  }
})();

// ---- routing profiles -----------------------------------------------------------------
// A PROFILE is a lane the user picks on purpose (F11 in the HUD): its own ordered target
// list, optional fallback rungs, and an egress boundary. Every key of `profiles` in the
// config is one, in the order written, which is also the order the HUD offers them:
//
//   "profiles": {
//     "local":   ["local-coder"],        LAN models only, online tools
//     "private": ["local-coder"],        LAN models only, no network at all
//     "vision":  ["local-vision"]        a single pinned model
//   },
//   "offlineProfiles": ["private"]       optional; see below
//
// `auto` (the broker picks from the tier lanes) and `manual` (the user's own model, no
// lease) always exist and cannot be declared here.
// These names are exported ONCE so lib/routing.js composes PROFILES as ["auto", "manual",
// ...these] rather than keeping a second copy.
// ☠️ A profile missing from this list is not a narrower profile, it is a BROKEN one: its
// lane is never built, so every lease on it is refused with "no eligible target" while the
// config plainly names its targets. Two divergent lists produce exactly that, which is why
// there is one.
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PROFILE_NAMES = Object.freeze(Object.keys(raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles) ? raw.profiles : {})
  .filter((name) => {
    if (PROFILE_NAME.test(name) && name !== "auto" && name !== "manual") return true;
    console.error(`opencode-broker: profiles["${name}"] is not a usable profile name (lowercase letters, digits and dashes; not auto or manual) -- ignored.`);
    return false;
  }));
// The OFFLINE profiles promise that the session does not touch the network at all: shell
// commands run in a network-less bubblewrap sandbox and web/MCP tools are refused.
// Declared with `offlineProfiles`; without it, a profile named `private` or ending in
// `-offline` is offline. Named ONCE -- routing.js's isOfflineProfile reads this list,
// because two copies of a privacy boundary is one copy that gets updated and one that
// quietly does not.
export const OFFLINE_PROFILE_NAMES = Object.freeze(Array.isArray(raw.offlineProfiles)
  ? raw.offlineProfiles.filter((name) => {
    if (PROFILE_NAMES.includes(name)) return true;
    console.error(`opencode-broker: offlineProfiles names "${name}", which is not a declared profile -- ignored.`);
    return false;
  })
  : PROFILE_NAMES.filter((name) => name === "private" || name.endsWith("-offline")));

const normalizeTargets = (value) => {
  const targets = {};
  for (const [id, candidate] of Object.entries(value && typeof value === "object" ? value : {})) {
    if (!TARGET_ID.test(id) || !candidate || typeof candidate !== "object") continue;
    if (typeof candidate.providerID !== "string" || !candidate.providerID) continue;
    if (typeof candidate.modelID !== "string" || !candidate.modelID) continue;
    if (candidate.kind !== "cloud" && candidate.kind !== "local") continue;
    const capacity = candidate.kind === "cloud"
      ? null
      : Number.isInteger(candidate.capacity) && candidate.capacity >= 1 ? candidate.capacity : 1;
    const context = Number(candidate.context);
    // Per-tier FIT: an explicit judgment that this model is unusually strong (>1)
    // or weak (<1) at a tier's task class. Fit orders equally-affordable options;
    // it never changes eligibility, and budget circuits still outrank it.
    const fit = {};
    for (const [tier, value] of Object.entries(candidate.fit && typeof candidate.fit === "object" ? candidate.fit : {})) {
      const weight = Number(value);
      if (ROUTE_TIER_NAMES.includes(tier) && Number.isFinite(weight) && weight > 0) fit[tier] = weight;
    }
    // Per-tier EFFORT: the reasoning variant this model performs best at for
    // this tier's task class -- overrides the generic tier default. Only applied
    // when the variant is declared/advertised for the model.
    const effort = {};
    for (const [tier, value] of Object.entries(candidate.effort && typeof candidate.effort === "object" ? candidate.effort : {})) {
      if (ROUTE_TIER_NAMES.includes(tier) && typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value)) effort[tier] = value;
    }
    // MINIMUM context: a floor below which this target is not eligible at all.
    // `context` says what a target CAN take; this says what is worth giving it.
    // A big local model with few slots is wasted on one-line turns -- it holds a
    // slot a small model could have served, and the small model is idle. The
    // floor is a size proxy for substance, not a difficulty judgement: it cannot
    // tell a long ramble from a hard problem, it only keeps trivia off a scarce
    // target. Omitted or 0 means "no floor", which is every existing target.
    const minContext = Number(candidate.minContextTokens);
    // Per-target local HEADROOM: the fraction of this target's window the router
    // will lease into, overriding the global `localContextHeadroom`. The global
    // default is sized for a SMALL window, where one fat tool result arriving
    // after the lease check can overflow whatever is left. That fraction is the
    // wrong shape for a large window: the same 0.6 that reserves 13k on a 32k
    // model reserves 49k on a 123k one, far more than any turn can grow, and
    // every session in the gap is pushed to cloud the local model could have
    // held. Declared per target because window size is a deployment fact.
    // ☠️ Local targets only: cloud eligibility uses the output reserve instead,
    // so a headroom there would silently double-count against it.
    // ☆ A fraction is the WRONG SHAPE for this quantity and is now the FALLBACK,
    // not the mechanism -- see `outputReserve` directly below. It still applies to
    // any target that has not declared one, so an unmeasured target keeps the old
    // conservative behaviour instead of silently losing its guard.
    const headroom = Number(candidate.contextHeadroom);
    // ABSOLUTE output reserve: the tokens that must stay free ON TOP of the
    // conversation, in tokens rather than as a share of the window.
    // ☠️ This is the correct shape, and it is what a fraction cannot express. A
    // llama.cpp slot's KV holds the prompt AND the generation in ONE allocation
    // (verified upstream: generated tokens are appended to the same buffer, and
    // `--reasoning-budget` is a logit-masking SAMPLER, not a second buffer -- so
    // thinking tokens consume slot context like any other). The room a turn needs
    // is therefore a SUM of absolute terms -- reasoning budget + answer + the
    // growth a tool result adds after the lease check -- and none of them scale
    // with the window. The same 0.6 that reserves a correct ~13k on a 32k model
    // reserves 79k on a 131k one, ~2.4x more than that model can physically
    // generate, and every session in the gap is pushed to cloud for nothing.
    // Declared per target because the reasoning budget is a per-preset deployment
    // fact, not something the router can discover.
    const reserve = Number(candidate.outputReserve);
    // MODEL-WIDE capacity: how many leases the model may already carry, across every target
    // that names it, for this one to take another (see targetFull in routing.js). Local only:
    // it counts the model server's slots, and a cloud target has none to share.
    const modelCapacity = candidate.modelCapacity;
    // PREPARE: how to make a local target RESIDENT when it is not. A local model can be
    // displaced by a cardmate, reclaimed by an idle timer, or lost to a server restart, and
    // nothing in the routing path could put it back: the lease was simply refused and every
    // session on a local-only profile stayed stuck until a human noticed and ran something by
    // hand. This is that something, as argv -- NO SHELL, so nothing here is word-split or
    // glob-expanded, and the command lives in config rather than in the router because which
    // models share which card is a deployment fact, not a routing one.
    // ☠️ Local targets only. A cloud target is never "not resident", so a prepare there would
    // be a command run on a condition that cannot occur.
    const prepare = Array.isArray(candidate.prepareCommand) && candidate.prepareCommand.length &&
      candidate.prepareCommand.every((word) => typeof word === "string" && word && word.length <= 4096)
      ? Object.freeze([...candidate.prepareCommand])
      : null;
    targets[id] = Object.freeze({
      id,
      providerID: candidate.providerID,
      modelID: candidate.modelID,
      kind: candidate.kind,
      capacity,
      ...(Number.isFinite(context) && context > 0 ? { context: Math.floor(context) } : {}),
      ...(Number.isFinite(minContext) && minContext > 0 ? { minContextTokens: Math.floor(minContext) } : {}),
      ...(prepare && candidate.kind === "local" ? { prepareCommand: prepare } : {}),
      ...(candidate.kind === "local" && Number.isInteger(modelCapacity) && modelCapacity >= 1
        ? { modelCapacity }
        : {}),
      ...(candidate.kind === "local" && Number.isFinite(headroom) && headroom > 0 && headroom <= 1
        ? { contextHeadroom: headroom }
        : {}),
      // Kept for BOTH kinds. `targetOutputReserve` has always documented "an explicit
      // outputReserve on the target beats the catalog", but nothing ever parsed the
      // field, so that precedence was dead text and cloud targets were catalog-only.
      // No cloud target declares one today, so admitting it here changes nothing live
      // and makes the documented behaviour real.
      ...(Number.isFinite(reserve) && reserve > 0 ? { outputReserve: Math.floor(reserve) } : {}),
      ...(Object.keys(fit).length ? { fit: Object.freeze(fit) } : {}),
      ...(Object.keys(effort).length ? { effort: Object.freeze(effort) } : {}),
    });
  }
  return Object.freeze(targets);
};

const idList = (value, known) => Object.freeze(
  (Array.isArray(value) ? value : []).filter((id) => typeof id === "string" && known[id]),
);

const normalizeLanes = (value, known) => {
  const lanes = {};
  for (const tier of ROUTE_TIER_NAMES) lanes[tier] = idList(value?.[tier], known);
  return Object.freeze(lanes);
};

const normalizeFallbacks = (value, known) => {
  const fallbacks = {};
  for (const tier of ROUTE_TIER_NAMES) {
    const groups = Array.isArray(value?.[tier]) ? value[tier] : [];
    fallbacks[tier] = Object.freeze(groups.map((group) => idList(group, known)).filter((group) => group.length));
  }
  return Object.freeze(fallbacks);
};

const normalizeProfiles = (value, known) => {
  const profiles = {};
  for (const profile of PROFILE_NAMES) profiles[profile] = idList(value?.[profile], known);
  return Object.freeze(profiles);
};

const normalizeBudgets = (value) => {
  const budgets = {};
  for (const [providerID, entry] of Object.entries(value && typeof value === "object" ? value : {})) {
    if (!TARGET_ID.test(providerID)) continue;
    const windows = (Array.isArray(entry?.windows) ? entry.windows : [])
      .filter((window) =>
        typeof window?.id === "string" && window.id &&
        Number.isFinite(Number(window.periodMs)) && Number(window.periodMs) > 0 &&
        (window.meter === "requests" || window.meter === "tokens") &&
        Number.isFinite(Number(window.capacity)) && Number(window.capacity) > 0)
      .map((window) => Object.freeze({
        id: window.id,
        periodMs: Number(window.periodMs),
        meter: window.meter,
        capacity: Number(window.capacity),
        ...(Number.isFinite(Number(window.anchor)) && Number(window.anchor) > 0
          ? { anchor: Number(window.anchor) }
          : {}),
      }));
    // A plan-usage source names the provider's own usage API; its exact numbers
    // replace the local spend estimate wherever the provider reports them.
    const planUsage = typeof entry?.planUsage?.type === "string" && entry.planUsage.type
      ? Object.freeze({
        type: entry.planUsage.type,
        ...(typeof entry.planUsage.authPath === "string" && entry.planUsage.authPath
          ? { authPath: entry.planUsage.authPath }
          : {}),
        ...(typeof entry.planUsage.url === "string" && entry.planUsage.url
          ? { url: entry.planUsage.url }
          : {}),
        ...(typeof entry.planUsage.authRef === "string" && entry.planUsage.authRef
          ? { authRef: entry.planUsage.authRef }
          : {}),
      })
      : null;
    if (windows.length) budgets[providerID] = Object.freeze({
      windows: Object.freeze(windows),
      ...(planUsage ? { planUsage } : {}),
    });
  }
  return Object.freeze(budgets);
};

const normalizeDeals = (value) => Object.freeze(
  (Array.isArray(value) ? value : []).filter((deal) =>
    deal && typeof deal === "object" &&
    typeof deal.providerID === "string" && deal.providerID &&
    Number.isFinite(Number(deal.multiplier)) && Number(deal.multiplier) > 0 && Number(deal.multiplier) <= 1)
    .map((deal) => Object.freeze({
      providerID: deal.providerID,
      multiplier: Number(deal.multiplier),
      ...(typeof deal.modelPrefix === "string" && deal.modelPrefix ? { modelPrefix: deal.modelPrefix } : {}),
      ...(deal.daily && typeof deal.daily === "object" ? { daily: Object.freeze({
        start: String(deal.daily.start ?? ""),
        end: String(deal.daily.end ?? ""),
        utcOffsetMinutes: Number.isFinite(Number(deal.daily.utcOffsetMinutes)) ? Number(deal.daily.utcOffsetMinutes) : 0,
      }) } : {}),
      ...(deal.window && typeof deal.window === "object" ? { window: Object.freeze({
        ...(typeof deal.window.from === "string" ? { from: deal.window.from } : {}),
        ...(typeof deal.window.to === "string" ? { to: deal.window.to } : {}),
      }) } : {}),
      ...(typeof deal.note === "string" && deal.note ? { note: deal.note } : {}),
    })),
);

// ---- which tier each opencode agent rides -----------------------------------------------
// An agent's NAME decides its tier. The mapping is deployment data because agent names are:
// opencode ships `build`, `plan`, `general` and `explore`, and everything else is whatever a
// deployment has written into its agent directory.
//
//   "agentTiers": {
//     "review-verifier": "smart",   exact name
//     "review-*": "review",         prefix: a trailing * matches every name that starts with it
//     "general": "inherit",         ride the parent session's tier (worker when there is none)
//     "my-classifier*": "classifier"
//   },
//   "defaultAgentTier": "worker"    anything not matched above
//
// Resolution: an exact entry wins, then the LONGEST matching prefix, then defaultAgentTier.
// Entries merge over DEFAULT_AGENT_TIERS key by key, so a deployment only lists what differs.
//
// `classifier` is not a lane to lease on: it marks a machine-dispatched command-classifier
// session (opencode-guard's). Such a session keeps the model pinned in its agent file, takes
// only the classifier tier's reasoning effort, and is exempt from the conversation's routing
// profile while still honouring its egress boundary -- see isClassifierAgent in routing.js.
export const AGENT_TIER_VALUES = Object.freeze(["deep", "smart", "build", "fast-build", "review", "worker", "classifier", "inherit"]);
const DEFAULT_TIER_VALUES = Object.freeze(["deep", "smart", "build", "fast-build", "review", "worker"]);
// The cost ladder, weakest first (the same order as TIER_RANK in routing.js).
const TIER_ORDER = Object.freeze(["worker", "review", "fast-build", "build", "smart", "deep"]);
export const DEFAULT_AGENT_TIERS = Object.freeze({
  // opencode's built-in agents.
  build: "build",
  plan: "smart",
  // `general` carries arbitrary work delegated by its parent, so it rides the parent's tier:
  // a design task delegated from a smart session must not silently land on a worker model.
  general: "inherit",
  explore: "worker",
  // Primary agents named after a tier ride that tier; the tier gate switches between them.
  deep: "deep",
  smart: "smart",
  "fast-build": "fast-build",
  // opencode-guard's command-classifier agents (fleet-classifier, fleet-classifier-local, ...).
  "fleet-classifier*": "classifier",
});

const normalizeAgentTiers = (value) => {
  const merged = { ...DEFAULT_AGENT_TIERS };
  for (const [name, tier] of Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {})) {
    const pattern = name.endsWith("*") ? name.slice(0, -1) : name;
    if (!pattern || pattern.length > 200 || pattern.includes("*")) {
      console.error(`opencode-broker: agentTiers key "${name}" is not an agent name or a single trailing-* prefix -- ignored.`);
      continue;
    }
    if (!AGENT_TIER_VALUES.includes(tier)) {
      console.error(`opencode-broker: agentTiers["${name}"] = ${JSON.stringify(tier)} is not one of ${AGENT_TIER_VALUES.join(", ")} -- ignored.`);
      continue;
    }
    merged[name] = tier;
  }
  const exact = new Map();
  const prefixes = [];
  for (const [name, tier] of Object.entries(merged)) {
    if (name.endsWith("*")) prefixes.push([name.slice(0, -1), tier]);
    else exact.set(name, tier);
  }
  prefixes.sort(([a], [b]) => b.length - a.length);
  return Object.freeze({ exact, prefixes: Object.freeze(prefixes), entries: Object.freeze(merged) });
};

const stringList = (value) => Object.freeze(
  (Array.isArray(value) ? value : []).filter((entry) => typeof entry === "string" && entry),
);

// ---- the TUI cockpit (hud/tui.js) --------------------------------------------------------
// Everything here is optional; hud/tui.js documents what each key does.
const expandHome = (path) => typeof path === "string" && path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const normalizeHud = (value) => {
  const hud = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const profiles = {};
  for (const [name, copy] of Object.entries(hud.profiles && typeof hud.profiles === "object" ? hud.profiles : {})) {
    if (!copy || typeof copy !== "object") continue;
    profiles[name] = Object.freeze({
      ...(typeof copy.badge === "string" ? { badge: copy.badge.slice(0, 24) } : {}),
      ...(typeof copy.description === "string" && copy.description ? { description: copy.description } : {}),
      ...(typeof copy.prepareNotice === "string" && copy.prepareNotice ? { prepareNotice: copy.prepareNotice } : {}),
    });
  }
  const swap = hud.swapBack && typeof hud.swapBack === "object" ? hud.swapBack : {};
  const command = Array.isArray(swap.command) && swap.command.length &&
    swap.command.every((word) => typeof word === "string" && word && word.length <= 4096)
    ? Object.freeze(swap.command.map((word, index) => index === 0 ? expandHome(word) : word))
    : null;
  const timeout = Number(swap.timeoutMs);
  const setting = hud.permissionModes;
  return Object.freeze({
    permissionModes: setting === true || setting === false ? setting : "auto",
    profiles: Object.freeze(profiles),
    swapBack: Object.freeze({
      command,
      profiles: stringList(swap.profiles),
      activeMarker: typeof swap.activeMarker === "string" && swap.activeMarker ? expandHome(swap.activeMarker) : null,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 1_800_000,
    }),
    backgroundShells: typeof hud.backgroundShells === "string" && hud.backgroundShells ? expandHome(hud.backgroundShells) : null,
  });
};

const targets = normalizeTargets(raw.targets);
const profiles = normalizeProfiles(raw.profiles, targets);

// ☠️☠️ THE PRIVACY BOUNDARY OF A PROFILE, decided here and nowhere else.
// A profile is a lane the user picked ON PURPOSE: `local` and `private` exist so the
// conversation stays on the LAN, `uncensored-offline` promises the same. Anything
// DERIVED from a profile -- today its fallback rungs -- is filtered through this
// predicate, so a profile can never degrade onto a model its own lane would not have
// reached in the first place.
// A privacy profile that quietly fails over to a cloud API is WORSE than a hard
// error. The error is visible, honest and recoverable; the leak is none of those, it
// has already happened by the time anyone could notice, and preventing exactly that
// is why the user selected the profile. So the default is CLOSED, and there are
// precisely two ways to open it:
//   1. the profile's own lane already contains a cloud target -- then it is not a LAN
//      profile at all and a derived pool cannot leak anything the primary path is not
//      already sending; or
//   2. the deployment names the profile in `profileCloudEgress`.
// ☆ (2) is deliberately a SEPARATE top-level allowlist rather than a flag inside a
// rung list. The plausible mistake is copying a tier's fallback rungs -- which are
// full of cloud targets -- into `profileFallbacks`, and no amount of copying a rung
// list can grant egress: opening the boundary takes a second, differently-shaped
// edit in another part of the file, and `grep profileCloudEgress` shows every profile
// that may leave the LAN on one line.
// ☠️ An OFFLINE profile is refused either way: `profileCloudEgress` cannot list one.
// "Offline" is not a preference the config gets to override.
const cloudEgressRequests = stringList(raw.profileCloudEgress);
for (const profile of cloudEgressRequests) {
  if (OFFLINE_PROFILE_NAMES.includes(profile)) {
    console.error(`opencode-broker: profileCloudEgress names the OFFLINE profile "${profile}" -- IGNORED. An offline profile never leaves the LAN, whatever the config says.`);
  } else if (!PROFILE_NAMES.includes(profile)) {
    console.error(`opencode-broker: profileCloudEgress names "${profile}", which is not a routing profile -- ignored.`);
  }
}
const cloudEgressProfiles = new Set(cloudEgressRequests
  .filter((profile) => PROFILE_NAMES.includes(profile) && !OFFLINE_PROFILE_NAMES.includes(profile)));
const profileMayLeaveLan = (profile) => !OFFLINE_PROFILE_NAMES.includes(profile) &&
  (cloudEgressProfiles.has(profile) || (profiles[profile] ?? []).some((id) => targets[id]?.kind === "cloud"));

// Fallback rungs for a PROFILE, in exactly the shape `fallbacks` uses for a tier:
// ordered groups, the first group with an eligible member wins, and a group is only
// consulted once the profile's primary lane has nothing eligible at all.
// Without this a restrictive profile had no rung to fall to: `uncensored` is one
// local target at capacity 1, so the night that model was not resident every request
// on the profile hard-failed. `local` and `private` are armed the same way -- both
// their targets are local, and a large model that wants both GPUs evicts both.
// ☠️ Kept as "keep only kind === local", NEVER as "drop kind === cloud". If a third
// kind is ever added, the closed form drops it (safe) and the open form would admit
// it (a leak) -- the difference between the two spellings is the whole boundary.
// ☠️ A RUNG SUPPRESSES `prepareCommand` (0.27.0). The broker only runs a prepare on
// the path where it refused the lease, so an eligible rung means the lease succeeds,
// the refusal never happens, and the primary is never swapped back in. That is right
// for a rung that is a peer of the primary and WRONG for one that quietly changes what
// the profile means: never give a profile a rung whose model contradicts the reason the
// profile exists (a censored model under `uncensored`) -- there, being refused with
// "preparing it now, resend" is the honest answer and the one that heals.
const normalizeProfileFallbacks = (value, known) => {
  const fallbacks = {};
  for (const profile of PROFILE_NAMES) {
    const groups = Array.isArray(value?.[profile]) ? value[profile] : [];
    const mayLeaveLan = profileMayLeaveLan(profile);
    fallbacks[profile] = Object.freeze(groups
      .map((group) => idList(group, known))
      .map((group) => {
        if (mayLeaveLan) return group;
        const lan = group.filter((id) => known[id]?.kind === "local");
        if (lan.length === group.length) return group;
        console.error(`opencode-broker: profileFallbacks.${profile} names ${group.filter((id) => known[id]?.kind !== "local").join(", ")} -- DROPPED. ${profile} routes on the LAN; add it to profileCloudEgress if it may really leave.`);
        return Object.freeze(lan);
      })
      .filter((group) => group.length));
  }
  return Object.freeze(fallbacks);
};

const denominator = Number(raw.workerLocalShareDenominator);

export const CONFIG = Object.freeze({
  path: CONFIG_PATH,
  targets,
  agentTiers: normalizeAgentTiers(raw.agentTiers),
  // Tier ALIASES: a tier the router resolves (from the agent, a parent, or a risk floor)
  // that should lease another tier's lane instead, e.g. { "build": "smart" } when both
  // lanes would hold the same model and a second lane only adds a place for a session to
  // be moved between. One hop, applied after the risk floor. Empty by default.
  tierAliases: (() => {
    const aliases = {};
    for (const [from, to] of Object.entries(raw.tierAliases && typeof raw.tierAliases === "object" ? raw.tierAliases : {})) {
      // Upward only (by the cost ladder's rank): an alias to a weaker tier could undercut
      // a risk floor, which exists precisely so that a dangerous question is never served
      // below it.
      if (DEFAULT_TIER_VALUES.includes(from) && DEFAULT_TIER_VALUES.includes(to) && TIER_ORDER.indexOf(to) > TIER_ORDER.indexOf(from)) aliases[from] = to;
      else console.error(`opencode-broker: tierAliases["${from}"] = ${JSON.stringify(to)} must name a stronger routing tier -- ignored.`);
    }
    return Object.freeze(aliases);
  })(),
  defaultAgentTier: (() => {
    if (raw.defaultAgentTier === undefined) return "worker";
    if (DEFAULT_TIER_VALUES.includes(raw.defaultAgentTier)) return raw.defaultAgentTier;
    console.error(`opencode-broker: defaultAgentTier ${JSON.stringify(raw.defaultAgentTier)} is not one of ${DEFAULT_TIER_VALUES.join(", ")} -- using worker.`);
    return "worker";
  })(),
  tiers: normalizeLanes(raw.tiers, targets),
  fallbacks: normalizeFallbacks(raw.fallbacks, targets),
  profiles,
  profileTitles: Object.freeze(Object.fromEntries(Object.entries(raw.profileTitles && typeof raw.profileTitles === "object" ? raw.profileTitles : {})
    .filter(([name, title]) => PROFILE_NAMES.includes(name) && typeof title === "string" && title.length <= 60))),
  profileFallbacks: normalizeProfileFallbacks(raw.profileFallbacks, targets),
  // Read-only record of which profiles the deployment opened; nothing routes off it
  // (the rungs were already filtered above), it exists so /status and a human can see
  // the answer without re-deriving it.
  profileCloudEgress: Object.freeze([...cloudEgressProfiles]),
  budgets: normalizeBudgets(raw.budgets),
  localModelsUrl: typeof raw.localModelsUrl === "string" && raw.localModelsUrl ? raw.localModelsUrl : null,
  trustedSubscriptionProviders: stringList(raw.trustedSubscriptionProviders),
  // Auto worker routing reserves one in N eligible assignments for the shared
  // local model; N <= 1 disables the local share.
  workerLocalShareDenominator: Number.isInteger(denominator) && denominator >= 1 ? denominator : 4,
  // A local model's declared window must fit the session with room for the turn
  // to GROW -- tool results land mid-turn, after the lease check. 0.6 leaves the
  // remaining 40% for that growth plus compaction; raise it only with evidence.
  localContextHeadroom: (() => {
    const value = Number(raw.localContextHeadroom);
    return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.6;
  })(),
  // Model-watch's notification: an argv array run when the catalog changes (a new
  // model, a newer line-mate). Empty (the default) prints the summary and SKIPS
  // the external notify instead of crashing on a missing `watch` config.
  watch: { notifyCommand: Array.isArray(raw.watch?.notifyCommand) ? raw.watch.notifyCommand.map(String) : [] },
  // The burn watch (lib/burn-watch.js): stops a runaway session and notifies on fast
  // spend. Every threshold defaults to the value documented there, so an absent block is
  // the full watch, not none; `enabled: false` turns it off. notifyCommand is argv (see
  // lib/notify.js for {title}/{body}/{kind}) and defaults to watch.notifyCommand, so one
  // notifier serves both; an empty list only logs to stderr.
  burnWatch: (() => {
    const block = raw.burnWatch && typeof raw.burnWatch === "object" && !Array.isArray(raw.burnWatch) ? raw.burnWatch : {};
    const thresholds = {};
    for (const key of Object.keys(BURN_DEFAULTS)) {
      if (block[key] === undefined) continue;
      if (key === "planWindow") {
        if (typeof block.planWindow === "string" && block.planWindow) thresholds.planWindow = block.planWindow;
        else console.error(`opencode-broker: burnWatch.planWindow ${JSON.stringify(block.planWindow)} is not a window id -- using ${BURN_DEFAULTS.planWindow}.`);
        continue;
      }
      const value = Number(block[key]);
      if (Number.isFinite(value) && value > 0) thresholds[key] = value;
      else console.error(`opencode-broker: burnWatch.${key} ${JSON.stringify(block[key])} is not a positive number -- using ${BURN_DEFAULTS[key]}.`);
    }
    const notifyCommand = Array.isArray(block.notifyCommand)
      ? block.notifyCommand.map(String)
      : Array.isArray(raw.watch?.notifyCommand) ? raw.watch.notifyCommand.map(String) : [];
    return Object.freeze({
      enabled: block.enabled !== false,
      notifyCommand: Object.freeze(notifyCommand),
      ...BURN_DEFAULTS,
      ...thresholds,
    });
  })(),
  // The slot watch (lib/slot-watch.js): once per `intervalMs`, read the local model server's
  // requests_deferred for each resident model a local target names, and notify through
  // burnWatch.notifyCommand when requests keep queueing. On by default; `enabled: false`
  // turns it off. It needs `localModelsUrl`, whose origin serves `/metrics?model=`.
  slotWatch: (() => {
    const block = raw.slotWatch && typeof raw.slotWatch === "object" && !Array.isArray(raw.slotWatch) ? raw.slotWatch : {};
    const values = {};
    for (const key of Object.keys(SLOT_DEFAULTS)) {
      if (block[key] === undefined) continue;
      const value = Number(block[key]);
      if (Number.isFinite(value) && value > 0) values[key] = value;
      else console.error(`opencode-broker: slotWatch.${key} ${JSON.stringify(block[key])} is not a positive number -- using ${SLOT_DEFAULTS[key]}.`);
    }
    return Object.freeze({ enabled: block.enabled !== false, ...SLOT_DEFAULTS, ...values });
  })(),
  // Limited-time provider discounts the balancer leans into -- see lib/deals.js.
  deals: normalizeDeals(raw.deals),
  // Variants the deployment KNOWS its models support ("provider/model" ->
  // [names]). The models.dev cache advertises none for most providers, so
  // without this declaration no effort control happens at all.
  modelVariants: (() => {
    const variants = {};
    for (const [key, value] of Object.entries(raw.modelVariants && typeof raw.modelVariants === "object" ? raw.modelVariants : {})) {
      if (!/^[A-Za-z0-9._:-]{1,180}\/[A-Za-z0-9._:-]{1,180}$/.test(key) || !Array.isArray(value)) continue;
      const clean = [...new Set(value.filter((name) => typeof name === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(name)))].sort();
      if (clean.length) variants[key] = Object.freeze(clean);
    }
    return Object.freeze(variants);
  })(),
  // Per-tier provider preference: >1 leans a tier's traffic toward the provider,
  // <1 saves the provider for tiers that lean into it. Applied as a divisor on
  // observed utilization when comparing headroom, and as a preference within the
  // balanced set -- a weight never changes WHAT is eligible, and never overrides
  // circuits or quota. Missing entries mean 1.
  tierProviderWeights: (() => {
    const weights = {};
    for (const tier of ROUTE_TIER_NAMES) {
      const entries = raw.tierProviderWeights?.[tier];
      if (!entries || typeof entries !== "object") continue;
      const clean = {};
      for (const [providerID, value] of Object.entries(entries)) {
        const weight = Number(value);
        if (TARGET_ID.test(providerID) && Number.isFinite(weight) && weight > 0) clean[providerID] = weight;
      }
      if (Object.keys(clean).length) weights[tier] = Object.freeze(clean);
    }
    return Object.freeze(weights);
  })(),
  hud: normalizeHud(raw.hud),
  profileTools: Object.freeze({
    localOnlineExtra: stringList(raw.profileTools?.localOnlineExtra),
    localOnlinePrefixes: stringList(raw.profileTools?.localOnlinePrefixes),
  }),
  // How far into its own cap a short burst window must be before it counts as a
  // balancing input rather than only a taper near exhaustion (see BURST_FENCE in
  // budgets.js). Top level, not under `budgets`: that object is keyed by provider
  // and gets walked as one.
  burstFence: (() => {
    const value = Number(raw.burstFence);
    return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.9;
  })(),
  // INERT since live rebalancing was removed (a session now keeps its model; balancing
  // happens only when a session gets its first one). Still parsed so an existing config
  // loads unchanged, and the broker uses cooldownMs only to prune old rebalance stamps.
  sessionRebalance: Object.freeze({
    divergence: (() => {
      const value = Number(raw.sessionRebalance?.divergence);
      return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.15;
    })(),
    cooldownMs: (() => {
      const value = Number(raw.sessionRebalance?.cooldownMs);
      return Number.isFinite(value) && value >= 0 ? value : 1800000;
    })(),
  }),
});
