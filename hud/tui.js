// The HUD: an always-visible cockpit for opencode's TUI, part of opencode-broker.
//
// It shows which routing profile a session is on, the provider usage behind it, a fallback
// marker when the broker degraded a session, and a roster of subagents and background shells.
// With opencode-guard installed it also carries the guard's permission mode (manual / edits /
// auto / god) and its safety-floor level -- see hud/guard.js for how that is detected.
//
// WARNING: A TUI plugin is declared in `tui.json`'s own `plugin` array, NOT in
// opencode.json's. The two loaders are separate: opencode.json's array is read by
// the SERVER loader, which requires `exports["./server"]` and quietly skips a
// tui-only package. Nothing is logged either way, which is what makes this so hard
// to see. Measured on 1.18.22.
//
// WARNING: Binding needs BOTH halves and neither works alone: the `bindings` entry below
// declares the command bindable, and tui.json's `keybinds` says which key it gets
// (and wins). ★ That map accepts arbitrary dotted command ids, not only the 162
// built-in snake_case names its schema advertises.
//
// The permission mode is published as one file per session so the server-side guard can
// read it -- the two plugins are separate module instances with no other channel.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONFIG,
  PROFILES,
  brokerRequest,
  readFallbackMarker,
  clearManagedModelSwitch,
  isClassifierAgent,
  isOfflineProfile,
  markManagedModelSwitch,
  publishAuthInventory,
  profileConfinesToLan,
  profileTitle,
  readPendingProfile,
  readSessionContextEstimate,
  resolveProfile,
  sessionsOnProfiles,
  tierForAgent,
  writePendingProfile,
  writePendingForgetRecord,
  writeSessionProfile,
} from "../lib/routing.js";
import { PLAN_LAPSED_REASON } from "../lib/provider-check.js";
import { formatReturnShort } from "../lib/usage-limit.js";
import { detectGuard } from "./guard.js";

// ---- swap-back: put the resting models back when the last session leaves -----------------
// Some local lanes need a model that cannot be resident beside the ones a GPU normally holds, so
// entering them swaps weights. The swap IN belongs to the broker: a target's `prepareCommand`
// runs when a lease is refused for a model that is genuinely absent, which covers every client
// (this TUI, headless runs, the gateway) rather than only the TUI.
// What stays here is the swap BACK, which the broker cannot own: "has the LAST session left the
// profiles that displaced the resting models?" is a session-lifecycle question, and the broker
// sees leases -- which a session drops the moment it goes idle -- not sessions.
//
// Configured in the broker config, and off unless `command` is set:
//   "hud": { "swapBack": {
//     "profiles": ["uncensored*"],                   the profiles that displace; trailing * = prefix
//     "command": ["/path/to/model-swap", "default"], run (argv, no shell) when the last one is left
//     "activeMarker": "~/.local/state/swap/active",  optional: only run while this file exists
//     "timeoutMs": 1800000                           optional: kill a swap-back that runs longer
//   } }
// ☠️ The veto set is DERIVED from the router's profile list through those patterns, never
// retyped. A profile it forgets is one whose sessions do not COUNT when the swap-back asks "is
// anyone still using the model that is up?" -- so leaving the last session on a sibling profile
// would pull the weights out from under a live one. The failure direction of a prefix is the
// right one: an over-broad match only DELAYS a swap-back, while a missing name yanks a model from
// a live session.
const SWAP_BACK = CONFIG.hud.swapBack;
const matchesPattern = (profile) => (pattern) => pattern.endsWith("*")
  ? profile.startsWith(pattern.slice(0, -1))
  : profile === pattern;
export const SWAP_BACK_PROFILES = SWAP_BACK.command
  ? PROFILES.filter((profile) => SWAP_BACK.profiles.some(matchesPattern(profile)))
  : [];
// ☠️ The ceiling must EXCEED the swap command's own worst case. A swap-back after a large model
// may restore several displaced models one after another, each with its own load ceiling, and a
// SIGTERM that lands between the unload and the loads leaves the GPUs holding nothing. Let the
// script always lose to its own timeouts, so it can report and self-restore.
// ☆ Nothing waits on this call, so a larger ceiling costs a user nothing.
const swapBackActive = () => {
  if (!SWAP_BACK.command) return false;
  if (!SWAP_BACK.activeMarker) return true;
  // One stat: when no swap is outstanding, closing a session costs nothing more.
  try { statSync(SWAP_BACK.activeMarker); return true; } catch { return false; }
};

const runSwapBack = () => new Promise((resolve, reject) => {
  const [command, ...args] = SWAP_BACK.command;
  execFile(command, args, { timeout: SWAP_BACK.timeoutMs }, (error, stdout, stderr) => {
    if (!error) return resolve(String(stdout).trim());
    // A swap script says what went wrong on its last line; the stack behind it is noise.
    const detail = String(stderr || stdout || error.message).trim().split("\n").pop();
    reject(new Error(detail || "swap-back command failed"));
  });
});

// Quitting opencode is the common way to leave such a session, and a swap-back takes far longer
// than the process has left. Detached + unref'd so it outlives the exit.
// ☠️ Fire-and-forget by necessity: nothing is left to report an error to. A deployment that
// cannot afford a missed swap-back should also run an idle timer of its own; this may fail
// silently but must never make things worse.
const runSwapBackDetached = () => {
  try {
    const [command, ...args] = SWAP_BACK.command;
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {}
};

// The sessions THIS instance put on a swapping profile. On shutdown they are leaving with us,
// so they must not count as "someone is still using it" -- their profile records outlive the
// process and would otherwise veto every swap-back on quit. Sessions belonging to another
// opencode instance are not in here, and correctly do veto it.
const ownSwapped = new Set();

// Closing a session is not switching out of its profile, so the profile-switch path never runs
// for it. This asks the same question from STATE rather than from the event: is a swap
// outstanding, and is anyone still on a swapping profile? Answering from state sidesteps the
// race with the router's own session.deleted handler, which removes the profile record --
// reading the closing session's old profile here would be a coin flip on handler order.
// ☠️ It covers a DELETED session only; quitting the TUI, killing opencode, or walking away fire
// no event at all (the dispose hook below covers the first).
// Module scope on purpose: the session.deleted subscription is registered near the top of the
// tui closure, long before a function declared further down would leave its temporal dead zone.
const restoreOnSessionClose = (closedID) => {
  if (!ownSwapped.delete(closedID)) return;
  if (!swapBackActive()) return;
  const remaining = sessionsOnProfiles(SWAP_BACK_PROFILES).filter((other) => other !== closedID);
  if (remaining.length) return;
  void runSwapBack().catch(() => {
    // Silent by design: the session that would have owned this toast is gone.
  });
};

// ---- how the profiles present -------------------------------------------------------------
// Module scope, and EXPORTED, so tests can check the picker and badges against the router's
// PROFILES list: a profile the router offers and the picker omits is unreachable from F11, and
// a badge the map omits renders as NOTHING, which would make a restricted session look exactly
// like an ordinary Auto one.
// ☆ The LIST comes from the router and only the COPY lives here. Each profile gets a sentence
// derived from what it actually is -- offline, LAN-confined, or allowed a cloud rung -- and a
// deployment can replace it with its own words (`hud.profiles.<name>.description`). The picker
// description is the last thing read before the keypress, so a lane that is expensive for the
// rest of the machine (one that evicts every other resident model, say) should say so there.
// ☆ Titles are never written here at all: profileTitle() is the router's, so the picker and the
// badge cannot disagree about what a lane is called.
const BUILT_IN_COPY = {
  // Deliberately blank badge: it is the default, and an always-on badge for it would be noise.
  auto: { badge: "", description: "The broker picks each session's model from the tier lanes" },
  manual: { badge: "R:manual", description: "Keep the model you choose in opencode; the broker does not assign one" },
};
export const derivedDescription = (profile) => {
  if (isOfflineProfile(profile)) return "LAN models only; no cloud, web or MCP tools, and a network-isolated shell";
  if (profileConfinesToLan(profile)) return "LAN models only; core tools and the configured extras";
  return "Its own model lane, with a cloud fallback the configuration allows";
};
export const fallbackBadge = (profile) => `R:${profile}`;
const copyFor = (profile) => ({ ...BUILT_IN_COPY[profile], ...CONFIG.hud.profiles[profile] });

export const ROUTING_OPTIONS = PROFILES.map((profile) => ({
  value: profile,
  title: profileTitle(profile),
  description: copyFor(profile).description ?? derivedDescription(profile),
}));

// The prompt badge's short label per profile: the only always-visible statement of which lane a
// session is on.
export const PROFILE_BADGES = Object.fromEntries(
  PROFILES.map((profile) => [profile, copyFor(profile).badge ?? fallbackBadge(profile)]),
);

// ---- waiting for the broker to make a local model resident --------------------------------
// A /lease refusal carries a machine-readable `code` beside the human `error` string, and that
// code -- never the sentence -- decides whether waiting can possibly help:
//   target-preparing          the model is not resident and its prepareCommand is RUNNING, whether
//                             this call started it or found it already in flight. It WILL clear.
//                             The only code worth waiting on, and the one this whole file is about.
//   no-eligible-local-target  no local target is deployed, free or within its context window, and
//                             nothing is being done about it.
//   no-eligible-target        the mixed/cloud case: every target busy or unavailable.
// `targetID` and `modelID` name what the code refers to when exactly one target applies.
// ☠️ AN ABSENT CODE MEANS DO NOT WAIT. An older broker, or a refusal path that does not set one
// yet, must never become a fifteen-minute poll on a lease nobody is working towards -- so anything
// that is not exactly `target-preparing` is final, and the user gets the broker's own sentence
// immediately. That is the compatibility branch, and what gates its removal is a DEPLOYMENT fact,
// not a code one: it can go once every broker on the fleet is opencode-router >= 0.28, the release
// that started coding refusals. Until then it is what makes a version skew cost one extra keypress
// instead of a quarter of an hour.
const PREPARING_CODE = "target-preparing";
const isPreparingRefusal = (error) => error?.code === PREPARING_CODE;

// One ask every 5 s. The wait is minutes long, so a tighter loop buys nothing: every attempt is a
// real /lease, which makes the broker re-read llama.cpp's /v1/models and append another refusal to
// decisions.jsonl. 5 s is ~32 of those across a measured 2m40s swap, and leaves the lease at most
// 5 s behind the weights landing -- invisible next to the swap itself.
// ☆ Read from the environment so the tests can drive this loop in milliseconds rather than
// minutes; nothing in normal operation sets it.
const PREPARE_POLL_MS = Number(process.env.OPENCODE_HUD_PREPARE_POLL_MS) || 5_000;
// The first refusal gets a toast, then one reassurance a minute. opencode's toasts are transient,
// and three silent minutes with the key doing nothing reads as a hung TUI.
const PREPARE_PROGRESS_MS = 60_000;
// ☠️ NO LONGER THE SAME NUMBER AS THE execFile CEILING, and the split is deliberate (0.9.0).
// This one is pinned to the BROKER's PREPARE_TTL_MS (900 s): past that the broker forgets the
// in-flight mark we are polling against, so waiting longer is waiting on nothing. The execFile
// ceiling above answers a different question -- how long a swap-BACK we launched may run before
// we kill it -- and the 70B made that answer bigger. Tying them together again would either
// outlive the mark or shorten the restore.
// ☆ A swap IN is the broker's detached child, so this expiring kills NOTHING: it ends only our
// wait, and the model keeps loading. That is why 900 s is still the right ceiling for the 70B
// even though its load is a 47.6 GiB read: worst case the user is told "still not resident after
// 15 min" and the next prompt finds it there. Expected is ~5 min (2m40s measured for 27.7 GiB,
// scaled, plus three unloads), comfortably inside it.
const MODEL_PREPARE_CEILING_MS = 900_000;

// What the wait is actually DOING, per profile, for the toast that fires on the broker's first
// `target-preparing` refusal: `hud.profiles.<name>.prepareNotice`, else the generic sentence.
// ☠️ Two swaps with different costs must not share a sentence. One that takes a single GPU for a
// minute and one that evicts every other resident model are different events, and a user told
// "a few minutes" while something else on the machine stops answering has been misled by the HUD.
// That difference is deployment knowledge, which is why it lives in config.
// ☆ A notice for a lane whose prepare may DECLINE (a restore that will not displace a model a
// live session is using) should say the request may wait on somebody else: the visible
// consequence of a decline is a wait that runs to its ceiling.
export const prepareNotice = (profile) => CONFIG.hud.profiles[profile]?.prepareNotice
  ?? "The broker is loading a local model for this profile -- this can take a few minutes.";

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Ask for the lease, and keep asking while the broker says it is loading the model.
// ☠️ The broker REFUSES the very lease it is preparing for, deliberately: /lease is also called
// from inside chat.params, where blocking for 2m40s would hang a turn with no feedback. The HUD is
// the one caller that can afford to wait -- F11 is a foreground gesture with a human behind it,
// and the swap-in this replaces blocked for exactly as long -- so the polling lives here rather
// than in the broker.
// Module scope, with its clock and its sleep injected: `requestLease` closes over `api`, and this
// loop is the half worth testing without one. Driven directly by tests/hud.test.mjs.
export const awaitPreparedLease = async (attempt, {
  announce, progress, now = Date.now, sleep = wait,
  pollMs = PREPARE_POLL_MS, progressMs = PREPARE_PROGRESS_MS, ceilingMs = MODEL_PREPARE_CEILING_MS,
} = {}) => {
  const startedAt = now();
  let announced = false;
  let nextProgressAt = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      // ☠️ Every other refusal is FINAL: busy, out of context window, no such target, broker down.
      // None of them are fixed by waiting, and retrying one would sit on the user for a quarter of
      // an hour before repeating what it already said.
      if (!isPreparingRefusal(error)) throw error;
      const elapsed = now() - startedAt;
      if (elapsed >= ceilingMs) {
        throw new Error(`the model is still not resident after ${Math.round(elapsed / 60000)} min of waiting for the broker -- ${error.message}`);
      }
      if (!announced) {
        announced = true;
        nextProgressAt = elapsed + progressMs;
        announce?.(error);
      } else if (elapsed >= nextProgressAt) {
        nextProgressAt = elapsed + progressMs;
        progress?.(elapsed);
      }
      await sleep(pollMs);
    }
  }
};

const DIR = join(homedir(), ".local/share/opencode/modes");
const GLOBAL_FLAG = join(homedir(), ".config/opencode/mode");
const ORDER = ["manual", "edits", "auto", "god"];
const LABEL = {
  manual: "manual -- asks about everything",
  edits: "edits -- edits go through, shell asks",
  auto: "auto -- everything goes through; risky commands still ask",
  god: "god -- everything runs, nothing asks, safety floor off",
};
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const normalize = (raw) => {
  const v = String(raw ?? "").trim().toLowerCase();
  return ORDER.includes(v) ? v : null;
};

// A session with no mode of its own inherits the global default, so the guard's CLI still
// sets what new sessions start as. God is per-session by design, so a global "god"
// (hand-written; the guard's CLI refuses it and the home-screen cycle skips it) resolves to
// auto -- the same resolution opencode-guard applies on the server side.
const fallback = () => {
  try {
    const v = normalize(readFileSync(GLOBAL_FLAG, "utf8")) ?? "manual";
    return v === "god" ? "auto" : v;
  } catch { return "manual"; }
};
const readMode = (sessionID) => {
  if (!sessionID) return fallback();
  try { return normalize(readFileSync(join(DIR, sessionID), "utf8")) ?? fallback(); } catch { return fallback(); }
};

// Prune on write rather than on a timer: this only runs when someone presses the
// key, and an unbounded directory of dead session files on a box that runs agents
// all day is exactly the "never auto-consume disk" failure mode.
const prune = () => {
  try {
    const now = Date.now();
    for (const name of readdirSync(DIR)) {
      const path = join(DIR, name);
      if (now - (statSync(path).mtimeMs || 0) > MAX_AGE_MS) unlinkSync(path);
    }
  } catch {}
};
const writeMode = (sessionID, mode) => {
  if (!sessionID) return false;
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(join(DIR, sessionID), mode + "\n"); prune(); return true; }
  catch { return false; }
};
const writeGlobal = (mode) => {
  try { writeFileSync(GLOBAL_FLAG, mode + "\n"); return true; } catch { return false; }
};

// ---- the subagent roster's one non-subagent ------------------------------------------------
// opencode-guard classifies gray-zone shell commands in a REAL child session: it creates one
// with the current session as `parentID`, prompts it once and deletes it. So every classified
// command puts a row in this roster that the user never launched, cannot act on, and that is
// gone again a few seconds later -- on a busy session that is most of what the panel shows, and
// it flickers.
// ☠️ NARROW ON PURPOSE, because the cost of a false positive is hiding a subagent the user IS
// waiting on. Matched on the AGENT through the router's own isClassifierAgent, i.e. the agents
// `agentTiers` maps to "classifier" -- one definition for routing and for this panel.
// ☆ Rejected signals, both wrong: the agent's `hidden: true`, which is also true of real
// subagents the user launches, and the session title, which a user can rename and which no
// contract pins.

// The indicator needs a real opentui <text> element: a slot returning a bare string
// dies with "Orphan text error: ... must have a <text> as a parent". WARNING: The host
// does NOT expose @opentui/solid to plugins even though @opencode-ai/plugin declares
// it a peer dependency, so this package depends on it directly and pinned, and
// node_modules here is host-local and gitignored -- a fresh host needs `npm install`
// in this directory. Every failure below is soft: no jsx means no indicator, while
// the key, the toast and the mode all keep working. A label is not worth a dead TUI.
const loadJsx = async () => {
  try { return (await import("@opentui/solid/jsx-runtime")).jsx; } catch { return null; }
};

export default {
  id: "opencode-broker-hud",
  tui: async (api) => {

    const jsx = await loadJsx();
    // opencode-guard's controls (permission-mode badge and cycle, floor menu) only mean something
    // when the guard is loaded; without it they would claim a protection nobody enforces.
    const guard = detectGuard({ setting: CONFIG.hud.permissionModes }).present;

    const sessionID = () => {
      const route = api.route?.current;
      return route?.name === "session" ? route?.params?.sessionID : undefined;
    };

    // Static session models are routing defaults, not evidence of what an assistant used.
    const assistantTurns = new Map();
    const assistantLoads = new Map();
    const assistantRelevant = new Map();
    let assistantDisposed = false;
    const assistantStamp = (info) => ({ created: Number(info?.time?.created ?? 0), id: String(info?.id ?? "") });
    const newerAssistant = (next, prior) => !prior || !Number.isFinite(prior.created) || next.created > prior.created ||
      (next.created === prior.created && next.id > prior.id);
    const noteAssistant = (info, live = false) => {
      const id = info?.sessionID;
      if (!assistantRelevant.has(id) || info?.role !== "assistant" || info?.summary || !info?.providerID || !info?.modelID) return;
      const next = { ...assistantStamp(info), model: `${info.providerID}/${info.modelID}`, state: "ready" };
      const prior = assistantTurns.get(id);
      if (newerAssistant(next, prior) || (live && next.created === prior?.created && next.id === prior?.id)) assistantTurns.set(id, next);
    };
    const hydrateAssistant = (id) => {
      if (!id || !assistantRelevant.has(id) || assistantLoads.has(id) || assistantTurns.has(id)) return;
      if (typeof api.client?.v2?.session?.messages !== "function") {
        assistantTurns.set(id, { state: "unavailable" });
        return;
      }
      const controller = new AbortController();
      const visit = assistantRelevant.get(id);
      const entry = { controller, visit, timer: null, finished: false, cancelled: false };
      const owns = () => !assistantDisposed && !entry.cancelled && assistantRelevant.get(id) === visit && assistantLoads.get(id) === entry;
      const finish = (state) => {
        if (!owns() || entry.finished) return;
        entry.finished = true;
        clearTimeout(entry.timer);
        if (assistantTurns.get(id)?.state === "pending") assistantTurns.set(id, { state });
        assistantLoads.delete(id);
      };
      entry.timer = setTimeout(() => { controller.abort(); finish("unavailable"); }, 5_000);
      const timer = entry.timer;
      if (typeof timer?.unref === "function") timer.unref();
      assistantLoads.set(id, entry);
      assistantTurns.set(id, { state: "pending" });
      const request = Promise.resolve()
        .then(() => api.client.v2.session.messages({ sessionID: id, limit: 20 }, { signal: controller.signal }))
        .then((res) => {
          if (!owns()) return;
          if (res?.error) { finish("unavailable"); return; }
          const messages = Array.isArray(res?.data) ? res.data : [];
          const latest = messages.reduce((top, message) => {
            const info = message?.info;
            if (info?.role !== "assistant" || message?.summary || info?.summary || !info?.providerID || !info?.modelID) return top;
            return newerAssistant(assistantStamp(info), top ? assistantStamp(top) : null) ? info : top;
          }, null);
          if (latest) noteAssistant(latest);
          else if (assistantTurns.get(id)?.state === "pending") assistantTurns.set(id, { state: "awaiting" });
          finish("awaiting");
        })
        .catch(() => {
          finish("unavailable");
        })
        .finally(() => { if (owns()) finish("unavailable"); });
      entry.request = request;
    };
    const syncAssistantSessions = (ids) => {
      const wanted = new Set(ids.filter(Boolean));
      for (const id of assistantRelevant.keys()) {
        if (wanted.has(id)) continue;
        assistantRelevant.delete(id); assistantTurns.delete(id);
        const load = assistantLoads.get(id); if (load) { load.cancelled = true; clearTimeout(load.timer); load.controller.abort(); assistantLoads.delete(id); }
      }
      for (const id of wanted) { if (!assistantRelevant.has(id)) assistantRelevant.set(id, Symbol(id)); hydrateAssistant(id); }
    };
    const assistantModel = (id) => {
      const record = assistantTurns.get(id);
      return record?.state === "ready" ? record.model : record?.state === "pending" ? "pending" : record?.state === "awaiting" ? "awaiting assistant model" : "unavailable";
    };
    const unsubscribeAssistantUpdates = api.event.on("message.updated", (event) => { noteAssistant(event?.properties?.info, true); refresh(); });
    const unsubscribeAssistantDelete = api.event.on("session.deleted", (event) => {
      const id = event?.properties?.info?.id ?? event?.properties?.sessionID;
      if (!id) return;
      assistantRelevant.delete(id); assistantTurns.delete(id);
      const load = assistantLoads.get(id); if (load) { load.cancelled = true; clearTimeout(load.timer); load.controller.abort(); assistantLoads.delete(id); }
    });
    api.lifecycle?.onDispose?.(() => {
      assistantDisposed = true; unsubscribeAssistantUpdates?.(); unsubscribeAssistantDelete?.();
      for (const load of assistantLoads.values()) { load.cancelled = true; clearTimeout(load.timer); load.controller.abort(); }
      assistantLoads.clear(); assistantTurns.clear(); assistantRelevant.clear();
    });

    // Session/profile/agent changes allocate the sticky model before dispatch. The
    // step-start listener remains a reconciliation guard for resumed sessions and
    // emits the native model-switch state used by the chat bar. The marker prevents
    // the model-default plugin from treating managed routing as a new Manual Model default.
    const syncedModels = new Map();
    const setRoutedModel = async (id, target) => {
      const providerID = target?.model?.providerID;
      const modelID = target?.model?.id ?? target?.model?.modelID;
      if (!providerID || !modelID) throw new Error("broker returned no model target");
      const model = { providerID, id: modelID, ...(typeof target?.model?.variant === "string" && target.model.variant ? { variant: target.model.variant } : {}) };
      markManagedModelSwitch(id, model);
      try {
        const result = await api.client.v2.session.switchModel({ sessionID: id, model });
        if (result?.error) throw new Error(String(result.error?.message ?? result.error));
        syncedModels.set(id, `${providerID}/${modelID}${model.variant ? `/${model.variant}` : ""}`);
      } catch (error) {
        clearManagedModelSwitch(id);
        throw error;
      }
    };
    const syncDispatchedModel = (event) => {
      const properties = event?.properties;
      const id = properties?.sessionID;
      const model = properties?.model;
      if (typeof id !== "string" || !id || typeof model?.providerID !== "string" ||
        !model.providerID || typeof model?.id !== "string" || !model.id) return;
      if (resolveProfile({ sessionID: id }).profile === "manual") return;
      const key = `${model.providerID}/${model.id}${model.variant ? `/${model.variant}` : ""}`;
      if (syncedModels.get(id) === key) return;
      syncedModels.set(id, key);
      markManagedModelSwitch(id, model);
      void api.client.v2.session.switchModel({ sessionID: id, model }).then((result) => {
        if (result?.error) throw new Error(String(result.error?.message ?? result.error));
      }).catch((error) => {
        if (syncedModels.get(id) === key) {
          syncedModels.delete(id);
          clearManagedModelSwitch(id);
        }
        api.ui?.toast?.({
          variant: "error",
          title: "routing model",
          message: `Could not sync the chat bar to ${key}: ${String(error?.message ?? error)}`,
        });
      });
    };
    const unsubscribeModelSync = api.event.on("session.next.step.started", syncDispatchedModel);
    const unsubscribeModelState = api.event.on("session.next.model.switched", (event) => {
      const id = event?.properties?.sessionID;
      const model = event?.properties?.model;
      if (typeof id !== "string" || !id || typeof model?.providerID !== "string" ||
        !model.providerID || typeof model?.id !== "string" || !model.id) return;
      syncedModels.set(id, `${model.providerID}/${model.id}${model.variant ? `/${model.variant}` : ""}`);
    });
    const unsubscribeModelCleanup = api.event.on("session.deleted", (event) => {
      const id = event?.properties?.info?.id ?? event?.properties?.sessionID;
      if (typeof id === "string" && id) syncedModels.delete(id);
    });
    const pendingQuestions = new Map();
    const questionState = (sessionID) => {
      let state = pendingQuestions.get(sessionID);
      if (!state) {
        state = { requestIDs: new Set(), modeClaimed: false, release: null, created: Date.now() };
        pendingQuestions.set(sessionID, state);
      }
      return state;
    };
    // Dropping the mode claim and forgetting the session are separate: navigation
    // away must pop the global mode while keeping the request bookkeeping alive.
    const dropModeClaim = (state) => {
      if (typeof state.release === "function") {
        try { state.release(); } catch {}
      }
      state.release = null;
      state.modeClaimed = false;
    };
    const releaseQuestionState = (sessionID) => {
      const state = pendingQuestions.get(sessionID);
      if (!state) return;
      dropModeClaim(state);
      pendingQuestions.delete(sessionID);
    };
    const clearQuestionRequest = (requestID) => {
      if (typeof requestID !== "string" || !requestID) return null;
      const sessionID = [...pendingQuestions.entries()].find(([, state]) => state.requestIDs.has(requestID))?.[0] ?? null;
      if (sessionID) {
        pendingQuestions.get(sessionID)?.requestIDs.delete(requestID);
      }
      return sessionID;
    };
    const ensureQuestionModeForCurrent = () => {
      const currentID = sessionID();
      if (typeof currentID !== "string" || !currentID) return;
      const state = questionState(currentID);
      if (state.modeClaimed) return;
      let modeAlreadyQuestion = false;
      try {
        modeAlreadyQuestion = api.mode?.current?.() === "question";
      } catch {}
      if (modeAlreadyQuestion) {
        state.modeClaimed = true;
        return;
      }
      try {
        const release = api.mode?.push?.("question");
        if (typeof release === "function") {
          state.release = release;
          state.modeClaimed = true;
        }
      } catch {}
    };
    const noteQuestionAsked = (event) => {
      const eventSessionID = event?.properties?.sessionID;
      const requestID = event?.properties?.id;
      if (typeof eventSessionID !== "string" || !eventSessionID || typeof requestID !== "string" || !requestID) return;
      const state = questionState(eventSessionID);
      if (state.requestIDs.has(requestID)) return;
      state.requestIDs.add(requestID);
      // A fresh request restarts the reconcile grace window: the host's question
      // list can lag this event by a beat, and releasing a just-asked question
      // would pop the mode out from under the prompt on screen.
      state.created = Date.now();
      if (eventSessionID === sessionID()) {
        ensureQuestionModeForCurrent();
      }
    };
    const clearQuestionSession = (event) => {
      const properties = event?.properties ?? {};
      const requestID = properties.requestID ?? properties.id;
      if (event?.type === "session.deleted") {
        const deletedID = properties.info?.id ?? properties.sessionID;
        if (typeof deletedID === "string" && deletedID) releaseQuestionState(deletedID);
        return;
      }
      const requestSessionID = clearQuestionRequest(requestID);
      const eventSessionID = properties.sessionID;
      const id = requestSessionID ?? eventSessionID;
      if (typeof id !== "string" || !id) return;
      if (pendingQuestions.get(id)?.requestIDs.size === 0) releaseQuestionState(id);
    };
    // The pushed question mode is TUI-GLOBAL state keyed off per-session event
    // bookkeeping, and event bookkeeping leaks: a replied/rejected event that
    // never reaches this process leaves the entry -- and the mode -- claimed until
    // restart, which wedges every mode-gated keybind (tab, the ctrl-x leader,
    // escape). Reconcile against the host's own question state once a second: the
    // host is the truth, this map is only a cache of it. The claim also follows
    // the ON-SCREEN session only -- a question left open in another session must
    // not hold the keyboard hostage here.
    const RECONCILE_GRACE_MS = 3000;
    const reconcileQuestionModes = () => {
      const current = sessionID();
      for (const [id, state] of [...pendingQuestions.entries()]) {
        if (state.modeClaimed && id !== current) dropModeClaim(state);
        if (Date.now() - (state.created ?? 0) < RECONCILE_GRACE_MS) continue;
        let live;
        // An unreadable host state keeps the entry (fail toward old behavior);
        // only a positive "no questions open" verdict releases it.
        try { live = api.state.session.question(id)?.length ?? 0; } catch { continue; }
        if (live === 0) releaseQuestionState(id);
      }
    };
    const unsubscribeQuestionAskedLegacy = api.event.on("question.asked", noteQuestionAsked);
    const unsubscribeQuestionAskedV2 = api.event.on("question.v2.asked", noteQuestionAsked);
    const unsubscribeQuestionRepliedLegacy = api.event.on("question.replied", clearQuestionSession);
    const unsubscribeQuestionRepliedV2 = api.event.on("question.v2.replied", clearQuestionSession);
    const unsubscribeQuestionRejectedLegacy = api.event.on("question.rejected", clearQuestionSession);
    const unsubscribeQuestionRejectedV2 = api.event.on("question.v2.rejected", clearQuestionSession);
    const unsubscribeQuestionDeleted = api.event.on("session.deleted", clearQuestionSession);
    const unsubscribeModelSwapRestore = api.event.on("session.deleted", (event) => {
      restoreOnSessionClose(event?.properties?.sessionID ?? event?.properties?.info?.id);
    });
    api.lifecycle?.onDispose?.(unsubscribeModelSync);
    api.lifecycle?.onDispose?.(unsubscribeModelState);
    api.lifecycle?.onDispose?.(unsubscribeModelCleanup);
    api.lifecycle?.onDispose?.(unsubscribeQuestionAskedLegacy);
    api.lifecycle?.onDispose?.(unsubscribeQuestionAskedV2);
    api.lifecycle?.onDispose?.(unsubscribeQuestionRepliedLegacy);
    api.lifecycle?.onDispose?.(unsubscribeQuestionRepliedV2);
    api.lifecycle?.onDispose?.(unsubscribeQuestionRejectedLegacy);
    api.lifecycle?.onDispose?.(unsubscribeQuestionRejectedV2);
    api.lifecycle?.onDispose?.(unsubscribeQuestionDeleted);
    api.lifecycle?.onDispose?.(unsubscribeModelSwapRestore);
    // Quitting opencode leaves no event behind and is the likeliest way to leave a swapping
    // profile, so shutdown is where the resting models usually have to be put back.
    api.lifecycle?.onDispose?.(() => {
      try {
        if (!ownSwapped.size) return;
        if (!swapBackActive()) return;
        // ☠️ Our own sessions must not veto this. Their profile records outlive the process, so
        // counting them would make the swap-back impossible on exactly the path that needs it.
        // Another instance's sessions are absent from the set and correctly do veto it.
        // ☠️ KNOWN LIMIT, and it fails SAFE. With two instances each holding a swapping session,
        // the second to quit still sees the first's record and skips -- neither restores. The fix
        // would be clearing our records on the way out, which would silently drop the profile of
        // a session the user expects to reopen on. Skipping is the conservative half: it can
        // delay a swap-back, never yank a model from a session that is still live.
        const remaining = sessionsOnProfiles(SWAP_BACK_PROFILES)
          .filter((other) => !ownSwapped.has(other));
        if (remaining.length) return;
        runSwapBackDetached();
      } catch {}
    });
    api.lifecycle?.onDispose?.(() => {
      for (const sessionID of [...pendingQuestions.keys()]) releaseQuestionState(sessionID);
    });
    const label = (id) => {
      const m = readMode(id);
      // The two modes that stop asking are the two worth shouting about.
      return m === "auto" || m === "god" ? m.toUpperCase() : m;
    };

    // WARNING: api.theme.current is a ProxyObject here, not the accessor function
    // opencode's own plugins call it as; calling it crashes the TUI.
    const themeColor = (name) => {
      try {
        const t = api.theme?.current;
        const obj = typeof t === "function" ? t() : t;
        return obj?.[name];
      } catch { return undefined; }
    };

    // WARNING: The prop shape was found by trial and all three parts matter: `children`
    // is what makes it render, `content` is what the solid layer maps onto the
    // TextRenderable, and getters are what let it pick up a new value when the slot
    // is re-evaluated. A function child renders nothing through the runtime jsx()
    // path, and a bare string child is an orphan-text crash.
    // ★ The indicator is mutated, not re-rendered. Setting `content` on the held
    // TextRenderable repaints immediately and does not care whose solid instance made
    // the element -- which is what every reactive route foundered on (a signal from
    // this plugin's solid-js is invisible to the host's computation, api.kv is not
    // reactive here, a function child renders nothing through the runtime jsx() path,
    // and re-registering the slot adds a SECOND indicator).
    //
    // The host re-creates slot elements after layout changes. Keep only the newest
    // element per slot: mutating historical renderables left stale text after resize.
    // ---- Subagent roster -------------------------------------------------
    // opencode models a subagent as a CHILD SESSION, so the roster is just the
    // sessions in this directory whose parentID is the one on screen. Kept in a
    // plain array refreshed on a timer: there is no event that fires reliably for
    // a child appearing, and a 2s poll of a local call is cheaper than being wrong.
    //
    // WARNING: We render this ourselves rather than installing opencode-subagent-statusline,
    // which does it more richly, because THAT PLUGIN SUPPRESSES EVERY OTHER PLUGIN'S
    // SLOTS. Bisected to its own `api.slots.register` call: neuter that one call and
    // other plugins render again; it is not the slot names, the order, the load
    // order, a throw, the return value, or an @opentui version skew (all measured).
    // Two ordinary plugins coexist fine, so opencode is not the problem.
    // Background jobs come off DISK (lib/bg-store.js), not out of a socket: the TUI
    // is a DIFFERENT PROCESS from the server plugin that starts them, and a local
    // web server is precisely what made opencode-pty hang `opencode run` forever.
    // opencode-background-shells is optional: its store is found as an installed package, or at
    // the path `hud.backgroundShells` names. Loaded defensively -- if the store fails to import,
    // the badge and the agent roster still have to render.
    let bg = null;
    let bgLoadWarning = null;
    for (const specifier of [
      CONFIG.hud.backgroundShells ? pathToFileURL(CONFIG.hud.backgroundShells).href : null,
      "opencode-background-shells/lib/bg-store.js",
    ].filter(Boolean)) {
      try { bg = await import(specifier); break; } catch (error) {
        // Only an uninstalled OPTIONAL package is absence. A configured path or a broken
        // installed package is a failed source, even when a fallback store can still load.
        // Node and Bun use different missing-import messages. Check package presence along
        // the runtime's resolution paths instead: a present package with a missing store file
        // or dependency is broken, not an optional plugin that was never installed.
        const notInstalled = specifier === "opencode-background-shells/lib/bg-store.js" &&
          error?.code === "ERR_MODULE_NOT_FOUND" &&
          createRequire(import.meta.url).resolve.paths("opencode-background-shells").every((directory) => {
            try { statSync(join(directory, "opencode-background-shells")); return false; }
            catch (error) { return error?.code === "ENOENT"; }
          });
        if (!notInstalled) bgLoadWarning = "shells: unavailable (job store could not load)";
      }
    }

    // DIR is a read-only contract; calling the producer's dir() would create the store.
    const bgDir = typeof bg?.DIR === "string" && bg.DIR
      ? bg.DIR : join(homedir(), ".local/share/opencode/bg");
    // A producer may silently skip bad records. Diagnose the raw store independently,
    // sharing the scan with Tasks without deriving source health from rendered UI text.
    // Unreadable records cannot be attributed to a session, so the warning is generic.
    const readStore = (directory, source, visit) => {
      let names;
      try { names = readdirSync(directory); } catch (error) {
        return error?.code === "ENOENT" ? null : `${source}: unavailable (store read failed)`;
      }
      let failures = 0;
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        try {
          const record = JSON.parse(readFileSync(join(directory, name), "utf8"));
          if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid task record");
          visit(record);
        } catch {
          failures += 1;
        }
      }
      return failures ? `${source}: partial read (${failures} unreadable or invalid record${failures === 1 ? "" : "s"})` : null;
    };
    const readShellExitCode = (job) => {
      const rc = join(bgDir, job.id + ".rc");
      return existsSync(rc) ? readFileSync(rc, "utf8").trim() : null;
    };

    // Jobs are folded into the SAME list as subagents so one panel, one cursor and
    // one Enter key cover both -- which is how Claude shows agents and shells.
    const loadJobs = (sid, { includeFinished = false } = {}) => {
      const result = { rows: [], warning: sid ? bgLoadWarning : null };
      if (!bg || !sid) return result;
      const storeWarning = readStore(bgDir, "shells", (job) => {
        if (typeof job.id !== "string" || !job.id) throw new Error("invalid job ID");
        readShellExitCode(job);
      });
      result.warning = [bgLoadWarning, storeWarning].filter(Boolean).join("; ") || null;
      try {
        const jobs = bg.listJobs(sid);
        if (!Array.isArray(jobs)) throw new Error("invalid job list");
        for (const j of jobs) {
          if (!j || typeof j.id !== "string" || !j.id || typeof j.state !== "string" || !j.state) {
            result.warning = [bgLoadWarning, storeWarning, "shells: partial read (invalid job records)"].filter(Boolean).join("; ");
            continue;
          }
          // Keep persisted output available in F10 without treating historical jobs
          // as live workflow rows for the next 24 hours.
          if (!includeFinished && j.state !== "running") continue;
          result.rows.push({
            kind: "shell",
            id: j.id,
            title: String(j.description || j.command || j.id),
            agent: "shell",
            status: j.state,
            code: j.code,
            session: j.session || null,
            created: Date.parse(j.started || 0) || 0,
            tokens: 0,
          });
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          result.warning = [bgLoadWarning, storeWarning, "shells: unavailable (job store read failed)"].filter(Boolean).join("; ");
        }
      }
      return result;
    };

    const isShell = (a) => a.kind === "shell";
    // A shell is only "running" while it actually is; a finished one must not keep
    // counting towards the badge the way `status !== "idle"` would make it.
    const busy = (list) => list.filter((a) => (isShell(a) ? a.status === "running" : a.status !== "idle")).length;
    const split = (list) => [list.filter((a) => !isShell(a)), list.filter(isShell)];
    // The badge shares its footer row with the model line, and the row wraps at
    // ordinary widths once the tally spells out nouns. So the badge gets busy/total
    // only -- agents bare, shells marked -- and F10 keeps the detailed roster.
    const tallyShort = (list) => {
      const [ag, sh] = split(list);
      const part = (n, running, mark) => (!n ? "" : `${running}/${n}${mark}`);
      return [part(ag.length, busy(ag), ""), part(sh.length, busy(sh), " sh")]
        .filter(Boolean).join(" \u00b7 ");
    };
    const PANEL_ROWS = 3;
    let selected = null;   // null = the prompt has the keys; a number = we do
    let scrollTop = 0;
    const strip = new Set();

    const SUBAGENT_SUFFIX = /\s*\(@[^)]*\)\s*$/;
    const shortTitle = (title, width) => {
      const clean = String(title).replace(SUBAGENT_SUFFIX, "").trim();
      return clean.length > width ? clean.slice(0, width - 1) + "…" : clean.padEnd(width);
    };
    const elapsed = (a) => {
      const started = Number(a.created ?? 0);
      if (!started) return "";
      const secs = Math.max(0, Math.round((Date.now() - started) / 1000));
      if (secs < 60) return `${secs}s`;
      const m = Math.floor(secs / 60);
      return m < 60 ? `${m}m ${secs % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
    };
    const tokens = (a) => {
      const n = Number(a.tokens ?? 0);
      if (!n) return "";
      return n >= 1000 ? `↓ ${(n / 1000).toFixed(1)}k tokens` : `↓ ${n} tokens`;
    };

    const width = () => {
      const w = api.renderer?.width ?? api.renderer?.terminalWidth ?? process.stdout?.columns ?? 100;
      return Math.max(60, Math.min(200, Number(w) || 100));
    };

    const panelText = () => {
      // BottomStripText appends the Tasks monitor below this roster, so tasks remain visible
      // even when there are no live child sessions.
      syncRoster();
      // A list that failed is said out loud: an empty strip would read as "no subagents".
      const notice = sessionID() ? [
        rosterUnavailable ? ` subagents: unavailable (session list ${rosterUnavailable})` : "",
        jobsWarning ? ` ${jobsWarning}` : "",
      ].filter(Boolean).join("\n") : "";
      if (!agents.length) return notice;
      const w = width();
      if (selected !== null) {
        if (selected < scrollTop) scrollTop = selected;
        if (selected >= scrollTop + PANEL_ROWS) scrollTop = selected - PANEL_ROWS + 1;
      }
      scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, agents.length - PANEL_ROWS)));

      // Name and description are separate columns, the way Claude lays them out:
      // the agent that is running, then what it was asked to do, then the numbers.
      const NAME = 14;
      const rows = agents.slice(scrollTop, scrollTop + PANEL_ROWS).map((a, i) => {
        const idx = scrollTop + i;
        const cursor = selected === idx ? "\u276f" : " ";
        // A shell reports an outcome, not just busy/idle, so it gets its own glyphs:
        // a finished job that still showed a filled dot would read as running.
        const glyph = isShell(a)
          ? ({ running: "\u25b8", done: "\u2713", failed: "\u2717" }[a.status] || "\u00b7")
          : a.status === "idle" ? "\u25cb" : "\u25cf";
        const state = isShell(a)
          ? (a.status === "running" ? "" : a.status + (a.code === null || a.code === undefined ? "" : " " + a.code))
          : (a.status === "idle" ? "" : a.status);
        const head = cursor + glyph + " " + shortTitle(a.agent, NAME) + "  ";
        const fitModel = (label, max) => {
          if (label.length <= max) return label;
          const slash = label.indexOf("/");
          if (slash < 1 || max < 5) return shortTitle(label, max);
          const provider = label.slice(0, slash);
          const model = label.slice(slash + 1);
          const modelRoom = Math.max(3, max - Math.min(provider.length, Math.max(2, Math.floor(max / 3))) - 2);
          return shortTitle(provider, max - modelRoom - 1) + "/" + (model.length <= modelRoom ? model : "…" + model.slice(-(modelRoom - 1)));
        };
        // Reserve the state, its separator, and a readable task column before fitting the model.
        // Otherwise the final row slice eats the model suffix we deliberately retained.
        let right;
        if (isShell(a)) {
          right = [state, elapsed(a)].filter(Boolean).join(" \u00b7 ") + "  ";
        } else {
          const model = fitModel(assistantModel(a.id), Math.max(8, w - head.length - state.length - (state ? 13 : 10)));
          const optional = [elapsed(a), tokens(a)].filter(Boolean);
          right = [state, model].filter(Boolean).join(" \u00b7 ");
          for (const metric of optional) {
            const candidate = [right, metric].filter(Boolean).join(" \u00b7 ");
            if (head.length + candidate.length + 10 <= w) right = candidate;
          }
          right += "  ";
        }
        // Size the task column to whatever is left, so a row can never exceed the
        // terminal and wrap -- a wrapped row breaks the panel's alignment and makes
        // the whole thing look like spilled output again.
        const room = Math.max(8, w - head.length - right.length - 1);
        const left = head + shortTitle(a.title, room);
        const gap = Math.max(1, w - left.length - right.length);
        return (left + " ".repeat(gap) + right).slice(0, w);
      });
      const more = agents.length - scrollTop - PANEL_ROWS;
      if (more > 0 && rows.length) rows[rows.length - 1] = rows[rows.length - 1].replace(/\s\s$/, ` +${more}`);

      return "\u2500".repeat(w).slice(0, w) + "\n" +
        "\u25cf main\n" +
        rows.join("\n") + (notice ? "\n" + notice : "");
    };

    let agents = [];
    // ---- whose roster `agents` is -----------------------------------------------------------
    // The roster belongs to the session ON SCREEN, and a session list takes time to answer, so
    // every change of session starts a new VISIT: `rosterGen` goes up, the old rows go at once,
    // and only an answer requested during the current visit may be installed. A bare sessionID
    // check is not enough -- A -> B -> A returns to the same ID, and the request from the first
    // visit to A can land after the one from the second.
    let rosterSid;
    let rosterGen = 0;
    let rosterLoadedGen = -1;     // the visit whose answer `agents` holds
    let rosterInFlight = null;    // { gen, promise }: at most one request per visit
    // Why the latest list for this visit could not be used -- "failed" or "not answering" --
    // or false. Said out loud, never guessed around.
    let rosterUnavailable = false;
    let rosterDisposed = false;
    let jobsAt = null;
    let jobsWarning = null;
    // Every session-list request still out (the poll's and F10's), so a navigation or a dispose
    // can cancel them and clear their deadline timers.
    const rosterCalls = new Set();
    // Synchronous, and called by everything that draws or reads the roster, so the first draw
    // after a navigation is already the new session's -- not up to a second of the old one's.
    const syncRoster = () => {
      const sid = sessionID();
      if (sid === rosterSid) return;
      rosterSid = sid;
      rosterGen += 1;
      agents = [];
      rosterUnavailable = false;
      jobsAt = null;
      jobsWarning = null;
      selected = null;
      scrollTop = 0;
      syncAssistantSessions(sid ? [sid] : []);
      // Every request still out belongs to a visit that just ended; its answer would be dropped.
      for (const call of [...rosterCalls]) call.cancel();
    };
    // Disk-backed shells have their own freshness boundary. A hung session list must not
    // postpone their reads (or keep showing a finished shell as running).
    const refreshJobs = () => {
      if (jobsAt !== null && Date.now() - jobsAt < 2000) return;
      const jobs = loadJobs(rosterSid);
      jobsAt = Date.now();
      jobsWarning = jobs.warning;
      agents = [...agents.filter((a) => !isShell(a)), ...jobs.rows];
      if (selected !== null && selected >= agents.length) selected = agents.length ? agents.length - 1 : null;
    };
    // Throws when the session list does. WARNING: The v2 SDK does NOT throw on failure by default
    // (throwOnError is off): a refused, failed or ABORTED request comes back as `{ error }`, so
    // that is checked here rather than left to fall through as an "empty" roster.
    const listChildren = async (parentID, signal) => {
      if (!parentID) return [];
      // The second argument is the SDK's per-request options; they are spread into the fetch's
      // RequestInit, which is how the signal reaches it.
      const res = await api.client.session.list({ query: { directory: api.state.path.directory } }, { signal });
      if (res?.error) throw new Error(String(res.error?.message ?? res.error));
      const rows = res?.data ?? res ?? [];
      if (!Array.isArray(rows)) throw new Error("the session list returned no rows");
      return rows
        // Children of THIS session, minus the command classifier -- see isClassifierAgent.
        .filter((row) => row?.parentID === parentID && !isClassifierAgent(String(row?.agent ?? "")))
        .map((row) => ({
          kind: "agent",
          id: row.id,
          title: String(row.title ?? row.id),
          // status is undefined for a session the TUI has not loaded; that is not
          // an error, it just means nothing is running in it.
          status: api.state.session.status(row.id)?.type ?? "idle",
          // Metrics are best-effort: the row carries them under a couple of
          // spellings depending on version, and a missing one just drops that
          // part of the right-hand column rather than breaking the row.
          agent: String(row.agent ?? "agent"),
          created: row.time?.created ?? row.timeCreated ?? row.time_created ?? 0,
          tokens: (row.tokens?.input ?? row.tokens_input ?? 0) +
                  (row.tokens?.output ?? row.tokens_output ?? 0),
        }));
    };
    // ---- a session list may not take forever ------------------------------------------------
    // A request that never settles would otherwise leave the last rows on screen as current for
    // ever (the poll) or leave F10 doing nothing (the dialog). So every list gets a deadline:
    //   answer   settles with the rows, or rejects -- on failure, at the deadline (err.timedOut),
    //            or when cancelled. Whatever awaits it is never left hanging.
    //   settled  resolves when the UNDERLYING request ends, however late. The poll holds its
    //            one-request guard until then, so a request whose cancellation does not take is
    //            shared by later ticks rather than joined by a new one every 2 s.
    //   cancel() aborts the request and rejects `answer`; the deadline timer goes with it.
    // The deadline aborts through the SDK's per-request `signal` (v2 RequestOptions extend
    // RequestInit and are spread into the fetch), so a hung request is torn down, not abandoned.
    const ROSTER_DEADLINE_MS = 5_000;
    const requestChildren = (parentID) => {
      const controller = new AbortController();
      let timer = null;
      let rejectAnswer = () => {};
      const request = listChildren(parentID, controller.signal);
      const call = {
        answer: new Promise((resolve, reject) => {
          rejectAnswer = reject;
          request.then(resolve, reject);
        }),
        settled: null,
        cancel: () => {
          clearTimeout(timer);
          rosterCalls.delete(call);
          rejectAnswer(new Error("cancelled"));
          controller.abort();
        },
      };
      timer = setTimeout(() => {
        rosterCalls.delete(call);
        rejectAnswer(Object.assign(new Error(`the session list did not answer within ${ROSTER_DEADLINE_MS / 1000} s`), { timedOut: true }));
        controller.abort();
      }, ROSTER_DEADLINE_MS);
      if (typeof timer?.unref === "function") timer.unref();
      call.settled = request.then(() => {}, () => {}).finally(() => {
        clearTimeout(timer);
        rosterCalls.delete(call);
      });
      rosterCalls.add(call);
      return call;
    };

    // Enter on a shell row in the roster. DialogAlert is one scrollable body with no
    // choices to make, and the roster already drives api.ui.dialog.
    const showJob = (job) => {
      if (!bg) return;
      let body = "";
      try {
        const out = bg.readOutput(job.id, 8 * 1024);
        body = (out.truncated ? "[earlier output truncated]\n\n" : "") + (out.text || "(no output yet)");
      } catch (e) { body = "could not read the job log: " + e; }
      const head = job.status === "running"
        ? "running"
        : job.status + (job.code === null || job.code === undefined ? "" : " (exit " + job.code + ")");
      // A running job has a real terminal behind it, so say how to get into it from
      // the roster where the user selected it.
      if (job.status === "running" && job.session) {
        body = "attach: tmux attach -t " + job.session + "\n\n" + body;
      }
      try {
        api.ui.dialog.setSize?.("large");
        api.ui.dialog.replace(() =>
          jsx(api.ui.DialogAlert, {
            title: job.id + "  \u00b7  " + head + "  \u00b7  " + job.title,
            message: body,
            onConfirm: () => { try { api.ui.dialog.clear(); } catch {} },
          }));
      } catch {
        try { api.ui?.toast?.({ variant: "info", message: job.id + ": " + head }); } catch {}
      }
    };

     // WARNING: The prompt eats `down` before a plugin's useKeyboard ever sees it -- measured.
     // keymap.intercept("key") runs first and can consume(), which is the only way to
     // get Claude's "arrow down into the list" feel. Deliberately narrow: `down` is
     // only taken when a subagent actually exists in a session with no interactive
     // surface open, and `up`/`enter`/`esc` only while a row is selected. Modal
     // dialogs and inline question/permission prompts own their arrows.
    try {
      api.keymap.intercept("key", (ctx) => {
        const name = ctx?.event?.name;
        const plain = ctx?.event && !ctx.event.ctrl && !ctx.event.meta && !ctx.event.option;
        // A row selected in the previous session must not be opened from this one.
        syncRoster();
        const id = sessionID();
        let interactionOpen = Boolean(api.ui?.dialog?.open);
        if (id) {
          if (pendingQuestions.has(id)) {
            interactionOpen = true;
            ensureQuestionModeForCurrent();
          } else {
            try {
              interactionOpen ||= (api.state.session.question(id)?.length ?? 0) > 0;
              if (interactionOpen) {
                ensureQuestionModeForCurrent();
              }
            } catch {
              interactionOpen = true;
            }
            if (!interactionOpen) {
              try {
                interactionOpen ||= (api.state.session.permission(id)?.length ?? 0) > 0;
              } catch {
                interactionOpen = true;
              }
            }
          }
        }
        if (!plain || !id || !agents.length || interactionOpen) return;
        if (name === "down") {
          selected = selected === null ? 0 : Math.min(agents.length - 1, selected + 1);
          refresh();
          ctx.consume?.();
          return;
        }
        if (selected === null) return;
        if (name === "up") {
          if (selected === 0) selected = null; else selected -= 1;
          refresh(); ctx.consume?.(); return;
        }
        if (name === "return" || name === "enter") {
          const target = agents[selected];
          selected = null; refresh(); ctx.consume?.();
          if (!target) return;
          // A subagent IS a session, so Enter opens it. A shell is not -- there is
          // nothing to navigate to, so Enter shows the output it has captured.
          if (isShell(target)) { showJob(target); return; }
          try { api.route.navigate("session", { sessionID: target.id }); } catch {}
          return;
        }
        if (name === "escape") { selected = null; refresh(); ctx.consume?.(); }
      });
    } catch {}

    const live = new Map();
    const profileBadge = (id) => {
      const profile = id ? resolveProfile({ sessionID: id }).profile : (readPendingProfile()?.profile ?? "auto");
      const short = PROFILE_BADGES[profile] ?? "";
      return short ? " \u00b7 " + short : "";
    };
    // Provider usage: the broker's budget ledger, polled lazily so the badge can
    // answer "how much of this provider's window have we burned" at a glance.
    // Stale numbers are worse than none: the badge hides the moment a poll fails, or once the
    // last answer is older than FRESHNESS_FALLBACK_MS, instead of lying.
    const budgetUtil = new Map();
    // providerID -> when the PROVIDER's reading was taken (the broker's `plan.fetchedAt`), as
    // opposed to budgetAt, which is only when this HUD last reached the broker. A broker that
    // answers every poll can still be serving a held-over reading; this is what tells them apart.
    // null = the reading's age is UNKNOWN (no usable fetchedAt): shown as such, never as current.
    const readingAt = new Map();
    // A reading older than this is shown with its age and never as a bare current number.
    // The chain is llm-auth-proxy's 60 s cache, the broker's 30 s refresh and 60 s cache, and
    // this HUD's 10 s poll, so a healthy reading is at most ~2.5 min old.
    const READING_STALE_MS = 3 * 60_000;
    const laneNotes = new Map();
    // When the /status request behind the numbers on screen was SENT -- not when it answered.
    // An answer that took three minutes to arrive is three minutes old, and must not read as
    // fresh just because it landed now.
    let budgetAt = 0;
    // When /status started failing, or null while it answers. 30 s of misses (three 10 s polls)
    // turn the badge into BROKER DOWN -- see fallbackBadge.
    let brokerFailingSince = null;
    // The failure flags above only move when a request ENDS. A request that never ends -- and
    // lib/client.js's timeout is a socket IDLE timeout, which a broker dribbling bytes never
    // trips -- would leave them unset and the last answer on screen as current for ever. So
    // freshness is also judged by AGE alone: older than two polls plus slack is stale (or, with
    // no answer yet, unavailable), whatever the flags say. Ages count from when this HUD started
    // until a first answer exists, so a broker that is hung from the start is caught too.
    // No second request is sent to find out: `budgetPolling` keeps one /status out at a time,
    // so a hung poll shows as stale instead of stacking new ones.
    const BUDGET_POLL_MS = 10_000;
    const FRESHNESS_FALLBACK_MS = 2 * BUDGET_POLL_MS + 5_000;
    const budgetSince = Date.now();
    const usageStale = () => brokerFailingSince !== null ||
      Date.now() - (budgetAt || budgetSince) > FRESHNESS_FALLBACK_MS;
    let budgetPolling = false;
    // Set on dispose. A poll already in flight must not write into a disposed HUD.
    let budgetDisposed = false;
    const pollBudgets = async () => {
      if (budgetPolling) return;
      budgetPolling = true;
      try {
        const askedAt = Date.now();
        const status = await brokerRequest("/status", {}, { timeout: 1500 });
        if (budgetDisposed) return;
        brokerFailingSince = null;
        // A provider whose SUBSCRIPTION has lapsed is not a provider in use: /status keeps
        // reporting its budget for diagnostics, so without this the sidebar showed a
        // percentage and a circuit note for a plan nobody holds. Computed before anything is
        // filled in, because the budgets, health and circuit loops below all consult it.
        // Only `plan-lapsed` counts -- a quota stop or a bench is a lane still in use, and
        // its note is the only warning that routing is avoiding it.
        const lapsedProviders = new Set(Object.entries(status?.circuits ?? {})
          .filter(([key, circuit]) => key.startsWith("provider:") && circuit?.reason === PLAN_LAPSED_REASON)
          .map(([key]) => key.slice("provider:".length)));
        budgetUtil.clear();
        readingAt.clear();
        for (const [providerID, report] of Object.entries(status?.budgets ?? {})) {
          if (lapsedProviders.has(providerID)) continue;
          // A provider that reports its own plan usage is EXACT: those numbers
          // replace the local spend estimate entirely (no tilde). Everything
          // else keeps the estimate, "~" marking a guessed capacity until a
          // provider 429 calibrates it.
          const planWindows = (Array.isArray(report?.plan?.windows) ? report.plan.windows : [])
            .filter((w) => Number.isFinite(Number(w?.percent)))
            .map((w) => ({
              id: String(w.id ?? "?"),
              pct: Math.round(Number(w.percent)),
              estimate: false,
              resetsAt: Date.parse(w.resetsAt ?? "") || null,
            }));
          // A plan reading without a usable fetchedAt -- absent (it predates the broker stamping
          // it), not a finite positive number, or in the FUTURE -- has an unknown age: treated as
          // stale and labelled "age unknown", never turned into a made-up age (an epoch-0 stamp
          // read as "30000000m old"; a future one read as current).
          if (planWindows.length) {
            const fetchedAt = typeof report.plan.fetchedAt === "number" ? report.plan.fetchedAt : Number.NaN;
            readingAt.set(providerID, Number.isFinite(fetchedAt) && fetchedAt > 0 && fetchedAt <= Date.now() ? fetchedAt : null);
          }
          const windows = planWindows.length ? planWindows : (Array.isArray(report?.windows) ? report.windows : [])
            .filter((w) => Number(w?.capacity) > 0)
            .map((w) => ({
              id: String(w.id ?? "?"),
              pct: Math.round((Number(w.spent) || 0) / Number(w.capacity) * 100),
              estimate: w.source !== "learned",
            }));
          if (windows.length) budgetUtil.set(providerID, windows);
        }
        budgetAt = askedAt;
        // Lane health: a benched provider must be VISIBLE, not silently absent
        // from routing (openai sat quarantined for a day before anyone knew).
        laneNotes.clear();
        for (const [providerID, record] of Object.entries(status?.health?.providers ?? {})) {
          if (lapsedProviders.has(providerID)) continue;
          // Only surface states that actually affect routing: quarantined and
          // probation exclude or restrict the lane. "observing" is a passive
          // pre-quarantine watch -- the lane is fully usable and it self-clears
          // as evidence ages, so showing it just false-alarms.
          if (record?.state === "quarantined" || record?.state === "probation") {
            laneNotes.set(providerID, record.state);
          }
        }
        for (const [key, circuit] of Object.entries(status?.circuits ?? {})) {
          const until = Number(circuit?.until);
          // With the weekday: a weekly limit's "til 03:38" alone read as later today.
          const when = Number.isFinite(until) && until > Date.now() ? formatReturnShort(until) : null;
          if (key.startsWith("provider:")) {
            const providerID = key.slice("provider:".length);
            if (lapsedProviders.has(providerID)) continue;
            // A usage stop says "limit"; one whose end is only the broker's next probe (no reset
            // reported) says "recheck", never "til" -- that time is not when usage returns.
            const usage = circuit?.kind === "plan-window" || circuit?.kind === "quota";
            const note = !when ? (usage ? "limit" : "circuit")
              : usage && circuit?.resetKnown === false ? `limit, recheck ${when}`
                : `${usage ? "limit" : "circuit"} til ${when}`;
            if (!laneNotes.has(providerID)) laneNotes.set(providerID, note);
          } else if (!laneNotes.has(key)) {
            laneNotes.set(key, when ? `benched til ${when}` : "benched");
          }
        }
      } catch {
        if (budgetDisposed) return;
        // broker down: every value is kept -- health and circuit warnings above all -- and marked
        // stale at once; the badge drops usage and, after 30 s, says BROKER DOWN.
        if (brokerFailingSince === null) brokerFailingSince = Date.now();
      }
      finally { budgetPolling = false; }
    };
    // Every HUD polls on the SAME wall-clock boundaries (:00, :10, :20 ...), not on a 10 s
    // interval from whenever its window opened: they all read the one broker reading, so
    // aligned polls show every window the same numbers at the same moment. Unaligned, two
    // windows side by side could disagree for up to a whole poll period.
    // (BUDGET_POLL_MS is declared above, with the freshness fallback derived from it.)
    let budgetTimer = null;
    const scheduleBudgetPoll = () => {
      if (budgetDisposed) return;
      budgetTimer = setTimeout(() => { void pollBudgets(); scheduleBudgetPoll(); },
        BUDGET_POLL_MS - (Date.now() % BUDGET_POLL_MS) + 50);
      if (typeof budgetTimer?.unref === "function") budgetTimer.unref();
    };
    void pollBudgets();
    scheduleBudgetPoll();
    api.lifecycle?.onDispose?.(() => { budgetDisposed = true; clearTimeout(budgetTimer); });
    // How old a provider's numbers are by their OWN account: the plan reading's fetch time,
    // or, for estimate-only providers (no reading), this HUD's last successful poll.
    // null when the reading's own stamp was unusable: its age is unknown, which counts as stale.
    const readingAge = (providerID) => {
      if (!readingAt.has(providerID)) return Date.now() - budgetAt;
      const at = readingAt.get(providerID);
      return at === null ? null : Date.now() - at;
    };
    const readingStale = (providerID) => {
      const age = readingAge(providerID);
      return age === null || age > READING_STALE_MS;
    };
    // A window past its reset no longer has the percentage it was read at.
    // A nearly-full window also says when it resets, with the weekday ("wk 100%! (Wed 03:38)"):
    // that is the moment the number stops being trivia. Below 85% it would only cost width.
    const windowCell = (w) => (w.resetsAt && w.resetsAt <= Date.now())
      ? `${windowLabel(w.id)} reset`
      : `${windowLabel(w.id)} ${w.estimate ? "~" : ""}${w.pct}%${w.pct >= 85 ? "!" : ""}` +
        (w.pct >= 85 && w.resetsAt ? ` (${formatReturnShort(w.resetsAt)})` : "");

    const PROVIDER_SHORT = { openai: "oai", anthropic: "ant", "alibaba-token-plan": "qwen" };
    const WINDOW_SHORT = { week: "wk", month: "mo" };
    const windowLabel = (id) => WINDOW_SHORT[id] ?? id;
    // The BINDING window (highest fill) speaks for the provider in compact
    // spots. Model-SCOPED windows (id "wk:<model>") only speak when the
    // session's model matches the scope: a Fable weekly cap on an Opus
    // session is someone else's limit.
    const windowAppliesTo = (windowID, modelID) => {
      const scope = String(windowID).split(":")[1];
      if (!scope) return true;
      return typeof modelID === "string" && modelID.toLowerCase().includes(scope.toLowerCase());
    };
    const pctOf = (providerID, modelID) => {
      // The badge has no room to say "old", so an old reading is not shown there at all, and
      // a window past its reset no longer speaks for the provider.
      if (readingStale(providerID)) return "";
      const windows = (budgetUtil.get(providerID) ?? [])
        .filter((w) => windowAppliesTo(w.id, modelID) && !(w.resetsAt && w.resetsAt <= Date.now()));
      const binding = windows.reduce((top, w) => (w.pct > (top?.pct ?? -1) ? w : top), null);
      if (!binding) return "";
      return `${PROVIDER_SHORT[providerID] ?? providerID.slice(0, 4)} ${binding.estimate ? "~" : ""}${binding.pct}% ${windowLabel(binding.id)}${binding.pct >= 85 ? "!" : ""}`;
    };
    // The CURRENT session's provider only -- the badge row is width-critical.
    // Read the LIVE session model from host state first: the local sync map can
    // lag a routed switch and showed the wrong provider's usage.
    const sessionModelRef = (id) => {
      if (!id) return undefined;
      try {
        const model = api.state?.session?.get?.(id)?.model;
        if (typeof model === "string" && model.includes("/")) {
          const [providerID, ...rest] = model.split("/");
          return { providerID, modelID: rest.join("/") };
        }
        if (model?.providerID) return { providerID: model.providerID, modelID: model.id ?? model.modelID };
      } catch {}
      const synced = syncedModels.get(id);
      if (typeof synced === "string" && synced.includes("/")) {
        const [providerID, ...rest] = synced.split("/");
        return { providerID, modelID: rest.join("/") };
      }
      return undefined;
    };
    const sessionProvider = (id) => sessionModelRef(id)?.providerID;
    const usageBadge = (id) => {
      // The badge has no room to say "stale", so a number the broker did not confirm on its
      // latest poll is not shown at all; the sidebar keeps it, marked stale.
      if (usageStale()) return "";
      const ref = sessionModelRef(id);
      if (!ref?.providerID || !budgetUtil.has(ref.providerID)) return "";
      const text = pctOf(ref.providerID, ref.modelID);
      return text ? " \u00b7 " + text : "";
    };
    // The sidebar block: every BUDGETED provider (local has no budget windows
    // and gets no row), each window shown with its own label -- the capacities
    // are operator ESTIMATES, and the header says so. Over 100% therefore means
    // "past the estimate", not "provider blocked": circuits handle real limits.
    const sidebarEls = new Set();
    // "12s" under a minute, "7m" after: a stale marker has to read at a glance.
    const ageText = (ms) => (ms < 60_000
      ? `${Math.max(0, Math.round(ms / 1000))}s`
      : `${Math.round(ms / 60_000)}m`);
    const PROVIDER_LONG = { "alibaba-token-plan": "token-plan" };
    const assistantTitleText = () => sessionID() ? "\nLast assistant turn" : "";
    const assistantText = () => sessionID() ? " " + assistantModel(sessionID()) : "";
    const assistantTitleEls = new Set();
    const assistantEls = new Set();
    // opencode-guard's floor LEVEL (its `oc-auto` CLI): how much of the safety floor
    // runs. Read straight off the flag-file contract; shown so "will this ask
    // me?" never requires remembering two invisible states.
    const levelFor = () => {
      try {
        const raw = readFileSync(join(homedir(), ".config/opencode/autoclass"), "utf8").trim().toLowerCase();
        if (raw === "strict") return "static";
        if (raw === "full" || raw === "auto") return "on";
        return ["off", "static", "on"].includes(raw) ? raw : "on";
      } catch { return "on"; }
    };
    let usageCollapsed = false;
    const sidebarTitleEls = new Set();
    // Collapsed, the heading is all that shows, so it carries the block's stale/unavailable
    // marker itself: hiding the body must not hide that the numbers behind it are old.
    const usageTitle = () => {
      if (!usageCollapsed) return "\nUsage";
      const marker = !usageStale() ? ""
        : !budgetAt ? " (unavailable)"
          : ` (stale ${ageText(Date.now() - budgetAt)})`;
      return "\nUsage \u25b8" + marker;
    };
    const sidebarText = () => {
      if (usageCollapsed) return "";
      if (!budgetUtil.size && !budgetAt) return usageStale() ? " (broker unavailable)" : " (no broker data yet)";
      const rows = [...budgetUtil.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([providerID, windows]) => {
          const name = (PROVIDER_LONG[providerID] ?? providerID).padEnd(10);
          const cells = windows.map(windowCell).join(" \u00b7 ");
          // Numbers older than READING_STALE_MS say how old they are, per provider: one
          // provider's usage API failing must not pass its last reading off as current.
          const readAge = readingAge(providerID);
          const age = !readingStale(providerID) ? ""
            : readAge === null ? " (age unknown)"
              : ` (${Math.max(1, Math.round(readAge / 60_000))}m old)`;
          return ` ${name} ${cells}${age}`;
        });
      // The broker answered and every provider it budgets is filtered out (all plans lapsed).
      // Saying nothing would leave the "Usage" heading standing over an empty block, which
      // reads as a broken HUD rather than as the true answer.
      if (!rows.length && !laneNotes.size) rows.push(" (no active providers)");
      // Stale from the first failed poll, or once the last answer is overdue by age alone (a
      // request that never ends fails nothing): every row below -- the lane warnings included,
      // which are kept rather than dropped -- is the last broker answer.
      if (usageStale()) rows.unshift(` (stale ${ageText(Date.now() - budgetAt)})`);
      if ([...budgetUtil.values()].some((windows) => windows.some((w) => w.pct > 100))) {
        rows.push(" ~ = estimated cap; >100% just means past the guess");
      }
      if (laneNotes.size) {
        for (const [key, note] of [...laneNotes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          const name = (PROVIDER_LONG[key] ?? key).padEnd(10);
          rows.push(` ${name} \u26d4 ${note}`);
        }
      }
      return rows.join("\n");
    };

    // TASKS: what is running in the background right now -- opencode-bg shell
    // jobs and review-panel runs -- plus anything that finished in the last few
    // minutes. Both stores are documented file contracts, read directly so a
    // missing sibling product just means an empty section.
    const TASK_DONE_LINGER_MS = 10 * 60 * 1000;
    let tasksCache = { at: 0, text: "" };
    const taskAge = (fromMs) => {
      const minutes = Math.max(0, Math.round((Date.now() - fromMs) / 60_000));
      return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? (minutes % 60) + "m" : ""}` : `${minutes}m`;
    };
    const pidAlive = (pid) => {
      if (!pid) return false;
      try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
    };
    const tasksText = (currentSid) => {
      if (Date.now() - tasksCache.at < 3000 && tasksCache.sid === currentSid) return tasksCache.text;
      const rows = [];
      const shellWarning = readStore(bgDir, "shells", (job) => {
        if (typeof job.id !== "string" || !job.id) throw new Error("invalid job ID");
        const jobSid = job.sessionID ?? job.session;
        // Another session's jobs are not this session's business. Unattributed older jobs
        // are likewise not shown; neither do their exit files need to be read here.
        if (!currentSid || jobSid !== currentSid) return;
        const startedAt = Date.parse(job.started ?? "") || 0;
        let state = "gone";
        try {
          const rc = readShellExitCode(job);
          if (rc !== null) {
            if (!/^-?\d+$/.test(rc)) throw new Error("invalid job exit code");
            state = Number(rc) === 0 ? "done" : `exit ${rc}`;
          } else if (pidAlive(job.pid)) state = "running";
        } catch (error) {
          // No exit file yet is normal for a running job. Every other read/parse failure
          // makes its outcome unknown, not "gone" (nor an invented successful completion).
          if (error?.code !== "ENOENT") throw error;
          if (pidAlive(job.pid)) state = "running";
        }
        // Running jobs are already in the interactive roster; only recent outcomes go here.
        if (state !== "running" && state !== "gone" && Date.now() - startedAt < TASK_DONE_LINGER_MS) {
          rows.push(` \u2713 ${String(job.description ?? job.id).slice(0, 30)} \u00b7 ${state}`);
        }
      });
      if (shellWarning) rows.push(` ${shellWarning}`);
      const workflowDir = join(homedir(), ".local/share/opencode/workflow-runs");
      const workflowWarning = readStore(workflowDir, "workflows", (run) => {
        if (typeof run.status !== "string" || !run.status) throw new Error("invalid workflow status");
        const label = String(run.name ?? "workflow").slice(0, 20);
        // Older runs without an owning session cannot be attributed and are not shown.
        if (!currentSid || run.sessionID !== currentSid) return;
        if (run.status === "running") {
          rows.push(` \u2691 ${label} \u00b7 ${String(run.phase ?? "").slice(0, 26)} \u00b7 ${run.agentsDone ?? 0}/${run.agentsStarted ?? 0} agents`);
        } else if (Date.now() - (run.finishedAt ?? run.startedAt ?? 0) < TASK_DONE_LINGER_MS) {
          rows.push(run.status === "done"
            ? ` \u2713 ${label} \u00b7 ${taskAge(run.finishedAt ?? run.startedAt)} ago`
            : ` \u2717 ${label} \u00b7 ${String(run.error ?? "failed").slice(0, 30)}`);
        }
      });
      if (workflowWarning) rows.push(` ${workflowWarning}`);
      tasksCache = { at: Date.now(), sid: currentSid, text: rows.length ? "\nTasks\n" + rows.join("\n") : "" };
      return tasksCache.text;
    };

    const fallbackBadge = (id) => {
      // The router plugin writes a marker when a lease landed on a fallback
      // target and clears it on the next healthy lease. A degraded route the
      // user cannot see is how a session quietly runs on the emergency model.
      // ☠️ A mute broker must outrank the marker. Only a healthy lease clears it, so with the
      // broker wedged a session showed FALLBACK:qwen-max for four days after the provider it
      // fell back from had recovered -- a true-looking badge naming the wrong problem.
      if (brokerFailingSince !== null && Date.now() - brokerFailingSince >= 30_000) return " · BROKER DOWN";
      if (!id) return "";
      try {
        const marker = readFallbackMarker(id);
        return marker ? " \u00b7 FALLBACK:" + marker.targetID : "";
      } catch { return ""; }
    };
    const textFor = (id) => {
      const current = id === undefined ? sessionID() : id;
      // Without opencode-guard there is no permission mode to show, and the badge starts at the
      // routing profile ("R:local"), or is empty on Auto.
      let prefix = "";
      if (guard) {
        const level = levelFor();
        prefix = label(current) + (level === "on" ? "" : ` \u00b7 floor:${level.toUpperCase()}`);
      }
      const parts = (prefix + profileBadge(current) + fallbackBadge(current) + usageBadge(current))
        .replace(/^ \u00b7 /, "");
      syncRoster();
      const tally = [agents.length ? tallyShort(agents) : "", rosterUnavailable ? "agents ?" : "", jobsWarning ? "shells ?" : ""]
        .filter(Boolean).join(" \u00b7 ");
      const suffix = tally ? (parts ? " \u00b7 " : "") + tally : "";
      return " " + parts + suffix + " ";
    };
    const indicator = (slot, id) => {
      if (!jsx) return null;
      const el = jsx("text", {
        get content() { return textFor(id); },
        get children() { return textFor(id); },
      });
      live.set(slot, { el, id });
      return el;
    };
    // Assign only on change, so the common case costs one string compare. The interval
    // is what keeps the label honest about things this plugin never sees: moving
    // between sessions, and `oc-mode` being run from a shell.
    // The bottom bar is the single home for both rosters: the interactive
    // subagent/shell panel, then the background-task monitor (workflow runs and
    // cross-session jobs) folded in below it. The sidebar no longer carries Tasks.
    const bottomStripText = () => panelText() + tasksText(sessionID());
    const refresh = () => {
      // A navigation is noticed here at the latest (every second): the old roster is dropped
      // before anything below draws, and the new visit's list is asked for straight away
      // rather than on the next 2 s roster tick.
      syncRoster();
      if (rosterLoadedGen !== rosterGen) void pollAgents();
      const want = bottomStripText();
      for (const el of strip) {
        try { if (el.content !== want) el.content = want; } catch {}
      }
      for (const entry of live.values()) {
        const want = textFor(entry.id);
        try { if (entry.el.content !== want) entry.el.content = want; } catch {}
      }
      const side = sidebarText();
      for (const el of sidebarEls) {
        try { if (el.content !== side) el.content = side; } catch {}
      }
      const heading = usageTitle();
      for (const el of sidebarTitleEls) {
        try { if (el.content !== heading) el.content = heading; } catch {}
      }
      const assistantTitle = assistantTitleText();
      for (const el of assistantTitleEls) {
        try { if (el.content !== assistantTitle) el.content = assistantTitle; } catch {}
      }
      const assistant = assistantText();
      for (const el of assistantEls) {
        try { if (el.content !== assistant) el.content = assistant; } catch {}
      }
    };
    // The roster poll is slower than the label repaint: the label has to be honest
    // the instant the key is pressed, the roster only has to keep up with reality.
    // One request per visit at a time: a tick that finds this visit's request still out shares
    // it rather than stacking another -- and "out" means until the underlying request has really
    // ended, not merely until its deadline (see requestChildren). A request from an EARLIER visit
    // never blocks this one: navigation cancels it and its answer is discarded.
    const pollAgents = () => {
      if (rosterDisposed) return Promise.resolve();
      syncRoster();
      refreshJobs();
      const gen = rosterGen;
      if (rosterInFlight?.gen === gen) return rosterInFlight.promise;
      const sid = rosterSid;
      const call = requestChildren(sid);
      const promise = (async () => {
        let children = [];
        let failure = null;
        try { children = await call.answer; } catch (error) { failure = error; }
        // Late: the screen moved on (or the HUD was disposed) while this was out.
        if (rosterDisposed || gen !== rosterGen) return;
        // Installed and repainted on every answer, so a same-session change of title, tokens
        // or status shows even when the IDs did not move. On a failure or a deadline the shells
        // (read off disk, not from the session list) stay; the subagent rows go, and say why.
        syncAssistantSessions(rosterSid ? [rosterSid, ...children.map((child) => child.id)] : []);
        agents = [...children, ...agents.filter(isShell)];
        rosterUnavailable = failure ? (failure.timedOut ? "not answering" : "failed") : false;
        rosterLoadedGen = gen;
        if (selected !== null && selected >= agents.length) selected = agents.length ? agents.length - 1 : null;
        refresh();
      })();
      const entry = { gen, promise };
      rosterInFlight = entry;
      void call.settled.then(() => { if (rosterInFlight === entry) rosterInFlight = null; });
      return promise;
    };
    const agentTimer = setInterval(pollAgents, 2000);
    if (typeof agentTimer?.unref === "function") agentTimer.unref();
    api.lifecycle?.onDispose?.(() => {
      rosterDisposed = true;
      clearInterval(agentTimer);
      for (const call of [...rosterCalls]) call.cancel();
    });

    const timer = setInterval(() => { reconcileQuestionModes(); refresh(); }, 1000);
    if (typeof timer?.unref === "function") timer.unref();
    api.lifecycle?.onDispose?.(() => clearInterval(timer));

    if (jsx) {
      api.slots.register({ order: 100, slots: {
        // `app_bottom` is the right home after all. It renders BELOW opencode's status
        // bar, outside the bordered frame.
        app_bottom: () => {
          const el = jsx("text", {
            get content() { return bottomStripText(); },
            get children() { return bottomStripText(); },
          });
          strip.add(el);
          while (strip.size > 8) strip.delete(strip.values().next().value);
          return el;
        },
        session_prompt_right: (props) => indicator("session", props?.session_id),
        home_prompt_right: () => indicator("home", undefined),

        sidebar_content: () => {
          // Bold TITLE, plain body -- two text elements in a box, because a
          // single text node carries one attribute set for its whole content.
          const title = jsx("text", {
            attributes: 1,
            get content() { return usageTitle(); },
            get children() { return usageTitle(); },
          });
          const body = jsx("text", {
            get content() { return sidebarText(); },
            get children() { return sidebarText(); },
          });
          sidebarTitleEls.add(title);
          sidebarEls.add(body);
          while (sidebarEls.size > 4) sidebarEls.delete(sidebarEls.values().next().value);
          while (sidebarTitleEls.size > 4) sidebarTitleEls.delete(sidebarTitleEls.values().next().value);
          const assistantTitle = jsx("text", {
            attributes: 1,
            get content() { return assistantTitleText(); },
            get children() { return assistantTitleText(); },
          });
          const assistant = jsx("text", {
            get content() { return assistantText(); },
            get children() { return assistantText(); },
          });
          assistantTitleEls.add(assistantTitle); assistantEls.add(assistant);
          while (assistantTitleEls.size > 4) assistantTitleEls.delete(assistantTitleEls.values().next().value);
          while (assistantEls.size > 4) assistantEls.delete(assistantEls.values().next().value);
          try {
            return jsx("box", { children: [title, body, assistantTitle, assistant] });
          } catch {
            return body;
          }
        },
      } });
    }

    const cycle = () => {
      // In a session this sets that session's mode. On the home screen there is no
      // session to set, so it sets the default a new session starts in -- the same
      // file `oc-mode` writes. God is per-session and attended only, so the home
      // screen (which writes the GLOBAL default, inherited by headless runs) cycles
      // without it.
      const id = sessionID();
      const order = id ? ORDER : ORDER.filter((m) => m !== "god");
      const next = order[(order.indexOf(readMode(id)) + 1) % order.length];
      if (!(id ? writeMode(id, next) : writeGlobal(next))) {
        api.ui?.toast?.({ variant: "error", message: "Could not write the mode file." });
        return;
      }
      refresh();
      // On the home screen, say where god went at the point it is conspicuously
      // missing -- the step where a session's cycle would have offered it next.
      // "Still don't see god mode" was a real report: the scoping is invisible
      // unless the toast explains it.
      const suffix = id ? ""
        : next === "auto" ? "  (default for new sessions -- god is per-session: press F9 inside one)"
        : "  (default for new sessions)";
      api.ui?.toast?.({
        variant: next === "god" ? "error" : next === "auto" ? "warning" : "info",
        title: "opencode mode",
        message: LABEL[next] + suffix,
      });
    };

    const unwrap = (value) => value?.data ?? value;
    // Switching an existing session needs no server metadata. New-session creation
    // fetches it only after the user has explicitly chosen to create a session.
    const currentInfo = async (id) => id ? unwrap(await api.client.v2.session.get({ sessionID: id })) : null;
    // ☠️ contextTokens is REQUIRED for a local target to be eligible AT ALL: localContextEligible
    // refuses a null estimate by design, because a request of unknown size must never be admitted
    // to a small local window. Omitting it here did not degrade the choice, it silently rejected
    // every local target. `local` and `private` hid that by falling through to their cloud rungs
    // -- their local targets were never being chosen either -- but the uncensored profiles have
    // no cloud target at all, so this lease could not pass and switchProfile threw before
    // writeSessionProfile ever ran. Whether the model was resident made no difference.
    // The persisted estimate is the same shortcut plugin/router.js takes before it scans history.
    // A session with no record genuinely has no context yet, so 0 is the honest value and
    // correctly admits local; an oversized session reads large and is correctly refused. Guessing
    // low costs a refusal at dispatch, where the true peak is always recomputed -- never a lease
    // against a window the session cannot fit.
    const leaseOnce = async (id, profile, agent, replace = false) => {
      if (profile === "auto") await publishAuthInventory();
      let contextTokens = 0;
      try { contextTokens = Number(readSessionContextEstimate(id)) || 0; } catch {}
      return brokerRequest("/lease", { sessionID: id, profile, tier: tierForAgent(agent), replace, contextTokens });
    };
    // ☠️ ASK EVERY TIME, including when the session is already sitting on this profile. A
    // session whose model went away underneath it -- an idle timer reclaiming the GPU, a swap run
    // by hand, a server restart, none of which change its profile -- would otherwise have no way
    // back, because re-selecting the profile you were already on would return early and change
    // nothing. Going through the broker keeps that property for free:
    // it answers from what /models reports loaded RIGHT NOW, so a resting model costs one refusal
    // and a wait rather than a dead end.
    const requestLease = (id, profile, agent, replace = false) => awaitPreparedLease(
      () => leaseOnce(id, profile, agent, replace), {
        // ☠️ PER PROFILE: what a swap costs the rest of the machine is the one thing the user
        // needs to know while they wait. See prepareNotice.
        announce: () => api.ui?.toast?.({ title: "routing profile", message: prepareNotice(profile) }),
        progress: (elapsed) => api.ui?.toast?.({ title: "routing profile",
          message: `Still loading -- ${Math.round(elapsed / 60000)} min so far, the broker is on it.` }),
      });
    const allocateSessionModel = async (id, profile, agent) => {
      if (!id || profile === "manual") return null;
      // A new session, or an agent switch, INHERITS a profile default without anyone pressing
      // F11 -- and the model can have been unloaded since it was chosen. requestLease covers
      // that on its own: it waits the broker's prepare out, so the allocation survives a model
      // that is merely asleep instead of failing on it. A resident model costs one round trip.
      const lease = await requestLease(id, profile, agent, true);
      // (claimSwapped and restoreDefaultModel are both declared below; every caller of this is
      // an event handler or a dialog callback, long after the closure around them has been built.)
      claimSwapped(id, profile);
      try {
        await setRoutedModel(id, lease?.target);
        return lease;
      } finally {
        await releaseLease(id, lease);
      }
    };
    const pendingAllocations = new Map();
    const queueSessionAllocation = (id, agent) => {
      if (!id) return;
      const prior = pendingAllocations.get(id);
      if (prior) clearTimeout(prior);
      const timer = setTimeout(() => {
        pendingAllocations.delete(id);
        const profile = resolveProfile({ sessionID: id, agent }).profile;
        if (profile === "manual") return;
        void allocateSessionModel(id, profile, agent).catch((error) => {
          api.ui?.toast?.({
            variant: "error",
            title: "routing model",
            message: `Could not allocate the ${tierForAgent(agent)} pool: ${String(error?.message ?? error)}`,
          });
        });
      }, 25);
      pendingAllocations.set(id, timer);
    };
    const unsubscribeSessionAllocation = api.event.on("session.created", (event) => {
      const info = event?.properties?.info;
      queueSessionAllocation(info?.id, info?.agent);
    });
    const unsubscribeAgentAllocation = api.event.on("session.next.agent.switched", (event) => {
      queueSessionAllocation(event?.properties?.sessionID, event?.properties?.agent);
    });
    api.lifecycle?.onDispose?.(() => {
      unsubscribeSessionAllocation?.();
      unsubscribeAgentAllocation?.();
      for (const timer of pendingAllocations.values()) clearTimeout(timer);
      pendingAllocations.clear();
    });
    const releaseLease = async (id, lease, forget = false) => {
      try {
        await brokerRequest(forget ? "/forget" : "/release", {
          sessionID: id,
          ...(lease?.leaseID ? { leaseID: lease.leaseID } : {}),
        });
      } catch {
        writePendingForgetRecord(id, { leaseID: lease?.leaseID });
      }
    };
    const validateHomeProfile = async (profile) => {
      if (profile === "auto" || profile === "manual") return;
      // ☠️ THE HOME SCREEN REACHES THE BROKER BY A DIFFERENT DOOR AND NEEDS THE SAME WAIT. With no
      // session open, F11 sets the default for new sessions and validates it with a probe lease --
      // which a profile whose model is unloaded at rest fails exactly as a session switch would.
      // Without the wait the picker reported "no eligible local model is currently deployed" and
      // left the default unchanged, with nothing to say that loading the model was all it wanted;
      // requestLease sits through the broker's prepare here too.
      // ☆ Nothing is claimed for the swap-back: the probe id is thrown away, and whichever session
      // later adopts this default takes ownership through its own lease.
      const probe = `profile-${process.pid}-${Date.now()}`;
      let lease = null;
      try {
        lease = await requestLease(probe, profile, "build");
      } finally {
        await releaseLease(probe, lease, true);
      }
    };
    // Leaving the LAST session on a swapping profile runs the swap-back. Deliberately not
    // awaited: changing profile should not block on a model load, and anything waiting on the
    // resting models retries its way out of a clean model-not-found until it lands.
    const restoreDefaultModel = (id, previous, next) => {
      if (!SWAP_BACK_PROFILES.includes(previous) || SWAP_BACK_PROFILES.includes(next)) return;
      ownSwapped.delete(id);
      if (!swapBackActive()) return;
      // ☠️ Another session may still be sitting on a swapping profile. Swapping back would pull
      // the model out from under it and strand it on a profile with no eligible target.
      const remaining = sessionsOnProfiles(SWAP_BACK_PROFILES).filter((other) => other !== id);
      if (remaining.length) return;
      void runSwapBack().catch((error) => {
        // The script's own last line (which is what `error.message` carries) names what failed.
        api.ui?.toast?.({ variant: "error", title: "model swap",
          message: `The displaced models did not come back: ${error.message}` });
      });
    };
    // The sessions THIS instance put on a swapping profile, which restoreDefaultModel and the
    // dispose hook subtract before asking "is anyone still using it?" -- see ownSwapped.
    // ☆ Claimed AFTER the lease is granted, not before it is asked for: a session whose lease
    // then FAILED would otherwise stay in the set and quietly stop vetoing a swap-back it had
    // every right to veto.
    const claimSwapped = (sessionID, profile) => {
      if (sessionID && SWAP_BACK_PROFILES.includes(profile)) ownSwapped.add(sessionID);
    };
    const switchProfile = async (id, info, profile) => {
      let lease = null;
      const previous = resolveProfile({ sessionID: id }).profile;
      try {
        if (profile === "manual") {
          // F11 must remain usable while the broker is restarting or unavailable.
          // The server router retries this durable cleanup before the next dispatch.
          writePendingForgetRecord(id);
          writeSessionProfile(id, profile, { explicit: true });
          restoreDefaultModel(id, previous, profile);
          refresh();
          api.ui?.toast?.({ title: "routing profile", message: profile === "manual"
            ? "Manual Model preserves the current model on the next reply."
            : "Auto applies on the next reply." });
          return;
        }
        if (!info?.agent) {
          try { info = await currentInfo(id); } catch {}
        }
        if (profile === "auto") {
          writeSessionProfile(id, profile, { explicit: true });
          restoreDefaultModel(id, previous, profile);
          lease = await allocateSessionModel(id, profile, info?.agent);
          lease = null;
          refresh();
          api.ui?.toast?.({ title: "routing profile", message: "Auto allocated a sticky model for this session." });
          return;
        }
        // Replace keeps a valid old lease if the selected restrictive profile has no
        // eligible target. The broker remembers the assignment after this validation;
        // no slot is held while the user is deciding what to send next.
        lease = await requestLease(id, profile, info?.agent, true);
        claimSwapped(id, profile);
        if (!lease?.target?.model) throw new Error("broker returned no model target");
        // ☠️ PIN the leased target, do not just validate it. Leaving the model alone meant the
        // chat bar still pointed at whatever was selected before, so entering an uncensored
        // profile appeared to do nothing and the model had to be chosen by hand -- and a HAND
        // -picked llamacpp model streams straight at llama.cpp, bypassing the broker's
        // loaded-only gate. That is what produced the retry storm: the request raced the 2m40s
        // swap and the AI SDK burned its whole backoff (2s, 4s, 8s, 16s, 37s) against
        // "AI_APICallError: Loading model" long before the weights landed. Going through the
        // lease makes that unrepresentable -- the broker will not hand out a target until
        // /models reports it `loaded`, so by the time it is pinned it can serve.
        await setRoutedModel(id, lease.target);
        const pinned = lease.target.model.id;
        await releaseLease(id, lease);
        lease = null;
        writeSessionProfile(id, profile, { explicit: true });
        restoreDefaultModel(id, previous, profile);
        refresh();
        api.ui?.toast?.({ title: "routing profile", message: `${profileTitle(profile)}: ${pinned} selected.` });
      } catch (error) {
        if (lease) await releaseLease(id, lease);
        api.ui?.toast?.({ variant: "error", title: "routing profile", message: String(error?.message ?? error) });
      }
    };
    const newProfileSession = async (sourceID, profile) => {
      let createdID = null;
      let lease = null;
      try {
        let info = null;
        try { info = await currentInfo(sourceID); } catch {}
        const created = unwrap(await api.client.v2.session.create({
          agent: typeof info?.agent === "string" ? info.agent : undefined,
          location: { directory: api.state.path.directory },
        }));
        createdID = created?.id;
        if (!createdID) throw new Error("OpenCode did not create a session");
        if (profile === "manual") {
          writeSessionProfile(createdID, profile, { explicit: true });
          writePendingForgetRecord(createdID);
          refresh();
          api.route.navigate("session", { sessionID: createdID });
          return;
        }
        if (profile === "auto") {
          writeSessionProfile(createdID, profile, { explicit: true });
          lease = await allocateSessionModel(createdID, profile, info?.agent);
          lease = null;
          refresh();
          api.route.navigate("session", { sessionID: createdID });
          return;
        }
        lease = await requestLease(createdID, profile, info?.agent, true);
        claimSwapped(createdID, profile);
        if (!lease?.target?.model) throw new Error("broker returned no model target");
        // Pinned BEFORE navigate so the session opens on the routed model rather than
        // inheriting the source session's. queueSessionAllocation would also set it off
        // session.created, but it resolves the profile 25 ms in -- before writeSessionProfile
        // below has recorded it -- so it would read the wrong profile and pin the wrong model.
        await setRoutedModel(createdID, lease.target);
        await releaseLease(createdID, lease);
        lease = null;
        writeSessionProfile(createdID, profile, { explicit: true });
        refresh();
        api.route.navigate("session", { sessionID: createdID });
      } catch (error) {
        if (createdID) {
          await releaseLease(createdID, lease, true);
          try { await api.client.session.delete({ sessionID: createdID, directory: api.state.path.directory }); } catch {}
        }
        api.ui?.toast?.({ variant: "error", title: "routing profile", message: String(error?.message ?? error) });
      }
    };
    const profileAction = (id, info, profile) => {
      if (!jsx) return;
      api.ui.dialog.replace(() =>
        jsx(api.ui.DialogSelect, {
          title: `Routing profile: ${profileTitle(profile)}`,
          options: [
            { value: "switch", title: "Switch next reply", description: profile === "manual" ? "Keep this conversation and stop broker model assignment" : "Keep this conversation and change its next provider turn" },
            { value: "new", title: "New clean session", description: profile === "manual" ? "Start the same agent with no broker model assignment" : "Start the same agent without this conversation's context" },
          ],
          onSelect: (option) => {
            try { api.ui.dialog.clear(); } catch {}
            if (option.value === "switch") void switchProfile(id, info, profile);
            else void newProfileSession(id, profile);
          },
        }));
    };
    const modeMenu = () => {
      const id = sessionID();
      const order = id ? ORDER : ORDER.filter((m) => m !== "god");
      api.ui.dialog.replace(() =>
        jsx(api.ui.DialogSelect, {
          title: id ? "Permissions (this session)" : "Permissions (default for new sessions)",
          current: readMode(id),
          options: order.map((m) => ({ value: m, title: m, description: LABEL[m]?.split(" -- ")[1] ?? "" })),
          onSelect: (option) => {
            try { api.ui.dialog.clear(); } catch {}
            if (!(id ? writeMode(id, option.value) : writeGlobal(option.value))) {
              api.ui?.toast?.({ variant: "error", message: "Could not write the mode file." });
              return;
            }
            refresh();
          },
        }));
    };
    const floorMenu = () => {
      api.ui.dialog.replace(() =>
        jsx(api.ui.DialogSelect, {
          title: "Guard floor (all sessions)",
          current: levelFor(),
          options: [
            { value: "on", title: "on", description: "credential guard + safety net + classifier (default)" },
            { value: "static", title: "static", description: "credential guard + safety net only; no model call" },
            { value: "off", title: "off", description: "nothing from opencode-guard -- no redaction either" },
          ],
          onSelect: (option) => {
            try { api.ui.dialog.clear(); } catch {}
            try {
              writeFileSync(join(homedir(), ".config/opencode/autoclass"), option.value + "\n");
              refresh();
              api.ui?.toast?.({ title: "guard floor", message: `floor ${option.value}` });
            } catch (error) {
              api.ui?.toast?.({ variant: "error", title: "guard floor", message: String(error?.message ?? error) });
            }
          },
        }));
    };
    // ONE menu for everything the HUD controls: every entry shows its current value,
    // so this is also the readable summary of mode / floor / profile at rest.
    const hudMenu = () => {
      if (!jsx) { api.ui?.toast?.({ variant: "error", message: "The HUD menu is unavailable without the TUI JSX runtime." }); return; }
      const id = sessionID();
      const mode = guard ? readMode(id) : null;
      const level = guard ? levelFor() : null;
      const profile = id ? resolveProfile({ sessionID: id }).profile : (readPendingProfile()?.profile ?? "auto");
      api.ui.dialog.replace(() =>
        jsx(api.ui.DialogSelect, {
          title: guard
            ? `HUD \u00b7 ${mode} \u00b7 floor ${level} \u00b7 ${profileTitle(profile)}`
            : `HUD \u00b7 ${profileTitle(profile)}`,
          options: [
            // Two different "auto"s live here: permissions-auto (what runs
            // without asking) and routing-Auto (the broker picks the model).
            // The titles keep them apart on purpose.
            ...(guard ? [{ value: "mode", title: `Permissions \u2014 ${mode}`, description: "What runs without asking you (F9 cycles)" }] : []),
            { value: "profile", title: `Model routing \u2014 ${profileTitle(profile)}`, description: "Who picks the model: the broker (Auto), you (Manual), or a profile's own lane" },
            ...(guard ? [{ value: "floor", title: `Guard floor \u2014 ${level}`, description: "Safety checks on shell commands; only matters under permissions-auto and headless runs" }] : []),
            { value: "usage", title: `Usage block \u2014 ${usageCollapsed ? "collapsed" : "expanded"}`, description: "Sidebar budget percentages (F7 toggles)" },
            { value: "agents", title: "Subagents\u2026", description: "Child sessions and background shells (F10)" },
            { value: "mcp", title: "MCP servers\u2026", description: "Attach or detach tool servers (F12)" },
          ],
          onSelect: (option) => {
            try { api.ui.dialog.clear(); } catch {}
            if (option.value === "mode") modeMenu();
            else if (option.value === "profile") void chooseProfile();
            else if (option.value === "floor") floorMenu();
            else if (option.value === "usage") { usageCollapsed = !usageCollapsed; refresh(); }
            else if (option.value === "agents") { void roster(); }
            else if (option.value === "mcp") { try { api.keymap.dispatchCommand("mcp_list"); } catch {} }
          },
        }));
    };
    const chooseProfile = async () => {
      if (!jsx) {
        api.ui?.toast?.({ variant: "error", message: "Routing profile picker is unavailable without the TUI JSX runtime." });
        return;
      }
      const id = sessionID();
      // On the start screen there is no session to set a profile ON, so the choice is
      // ARMED for the next one rather than stored as a default. There is no global
      // profile any more: one left set to a LAN-only profile confined every future session to
      // LAN routing and made the guard's classifier refuse every gray-zone command, with
      // nothing on screen to say why. See PENDING_PROFILE in lib/routing.js.
      const current = id
        ? resolveProfile({ sessionID: id }).profile
        : (readPendingProfile()?.profile ?? "auto");
      api.ui.dialog.replace(() =>
        jsx(api.ui.DialogSelect, {
          title: id ? "Routing profile" : "Routing profile · next session only",
          current,
          options: ROUTING_OPTIONS,
          onSelect: (option) => {
            try { api.ui.dialog.clear(); } catch {}
            if (id) {
              profileAction(id, null, option.value);
              return;
            }
            void (async () => {
              try {
                await validateHomeProfile(option.value);
                writePendingProfile(option.value);
                refresh();
                api.ui?.toast?.({
                  title: "routing profile",
                  message: `${profileTitle(option.value)} is armed for the NEXT session you start. Sessions after it stay on Auto.`,
                });
              } catch (error) {
                api.ui?.toast?.({ variant: "error", title: "routing profile", message: String(error?.message ?? error) });
              }
            })();
          },
        }));
    };
    // Open the roster. A picker rather than an inline arrow-through list: an inline
    // one needs keyboard focus handling, and DialogSelect is API we already know works.
    // `up` (session_parent) is opencode's own way back, so it is not reimplemented here.
    let pickerGen = 0;
    // Retain underlying requests until they actually settle, not merely until abort/deadline.
    // One replacement may proceed while its superseded request is cancelling; if both ignore
    // cancellation, further invocations report unavailable instead of accumulating requests.
    const pickerCalls = new Set();
    const roster = async () => {
      syncRoster();
      if (rosterDisposed) return;
      const invocation = ++pickerGen;
      for (const call of pickerCalls) call.cancel();
      // This explicit new invocation replaces any previous picker, even if it finds no rows.
      // Do it now, never from an obsolete completion or selection callback.
      api.ui.dialog.clear();
      const here = sessionID();
      if (!here) {
        api.ui?.toast?.({ variant: "warning", message: "Open a session first -- subagents belong to one." });
        return;
      }
      // The visit this dialog belongs to. Everything below runs after an await, by which time the
      // screen may be on another session -- or back on this one in a NEW visit (A -> B -> A),
      // which a bare session-ID check would wave through.
      const gen = rosterGen;
      const stillOwned = () => {
        syncRoster();
        return !rosterDisposed && gen === rosterGen && invocation === pickerGen;
      };
      // A failed or hung list is NOT an empty one: "Nothing running" would be a guess.
      let children = [];
      let failure = null;
      const call = pickerCalls.size < 2 ? requestChildren(here) : null;
      if (call) {
        pickerCalls.add(call);
        void call.settled.then(() => pickerCalls.delete(call));
      }
      try {
        children = await (call ? call.answer : Promise.reject(new Error("previous session list requests are still pending")));
      } catch (error) { failure = error; }
      if (!stillOwned()) return;
      const subagentWarning = !failure ? null
        : failure.timedOut ? `Subagents unavailable: ${failure.message}.`
          : `Subagents unavailable: the subagent list failed (${String(failure?.message ?? failure)}).`;
      // The live panel intentionally hides completed shells; F10 remains the place
      // to inspect their retained output until the background store prunes it.
      // Shells come off disk, not from the session list, so a failed list still offers them.
      const jobs = loadJobs(here, { includeFinished: true });
      const warning = [subagentWarning, jobs.warning].filter(Boolean).join(" ");
      const entries = [...children, ...jobs.rows];
      const options = entries.map((a) => ({
        title: a.title,
        value: a.id,
        description: isShell(a)
          ? "shell \u00b7 " + a.status + (a.code === null || a.code === undefined ? "" : " (" + a.code + ")")
          : (a.status === "idle" ? "idle" : a.status),
      }));
      if (warning) api.ui?.toast?.({ variant: "warning", title: "subagents", message: warning + (failure && jobs.rows.length ? " Showing shells only." : "") });
      if (!options.length) {
        if (!warning) api.ui?.toast?.({ title: "subagents", message: "Nothing running under this session." });
        return;
      }
      if (!jsx) {
        api.ui?.toast?.({ title: "subagents", message: options.map((o) => `${o.title} (${o.description})`).join(" | ") });
        return;
      }
      api.ui.dialog.replace(() =>
        jsx(api.ui.DialogSelect, {
          title: failure ? "Shells (subagents unavailable)" : jobs.warning ? "Subagents and shells (partial data)" : "Subagents and shells",
          placeholder: "Filter",
          options,
          onSelect: (option) => {
            // Ownership is checked BEFORE clearing: a retained callback must not close the
            // replacement dialog, even when that dialog belongs to this same session visit.
            if (!stillOwned()) return;
            const picked = entries.find((a) => a.id === option.value);
            if (!picked) return;
            pickerGen += 1;
            try {
              api.ui.dialog.clear();
              if (isShell(picked)) { showJob(picked); return; }
              api.route.navigate("session", { sessionID: picked.id });
            } catch {}
          },
        }));
    };

    const show = () => {
      api.ui?.toast?.({ title: "opencode mode", message: LABEL[readMode(sessionID())] });
    };

    // The permission-mode commands exist only when opencode-guard does; see hud/guard.js.
    const guardCommands = guard ? [
      {
        name: "hud.mode.cycle",
        title: "Cycle permission mode (manual / edits / auto)",
        desc: "What runs without asking, for this session only",
        category: "System",
        namespace: "palette",
        run: cycle,
      },
      {
        name: "hud.mode.show",
        title: "Show permission mode",
        category: "System",
        namespace: "palette",
        run: show,
      },
    ] : [];
    api.keymap.registerLayer({
      commands: [
        ...guardCommands,
        {
          name: "hud.agents.list",
          title: "Subagents: list and jump to one",
          desc: "Child sessions of this session; up returns to the parent",
          category: "System",
          namespace: "palette",
          run: () => { roster(); },
        },
        {
          name: "hud.menu",
          title: guard ? "HUD: mode, floor, profile, usage" : "HUD: profile, usage",
          desc: "One menu for everything the HUD controls, current values inline",
          category: "System",
          namespace: "palette",
          run: () => { hudMenu(); },
        },
        {
          name: "hud.routing.profile",
          title: "Routing profile",
          desc: "Choose Auto, Manual Model, or one of the configured profiles",
          category: "System",
          namespace: "palette",
          run: () => { void chooseProfile(); },
        },
        {
          name: "hud.usage.toggle",
          title: "Usage: collapse or expand the sidebar block",
          desc: "Provider budget-window percentages in the sidebar",
          category: "System",
          namespace: "palette",
          run: () => { usageCollapsed = !usageCollapsed; refresh(); },
        },
      ],
      bindings: [
        // BOTH halves are required for a working key: this entry declares the
        // command bindable, tui.json's keybinds picks the key (and wins).
        // hud.usage.toggle was once missing here, so its tui.json key (f7)
        // pressed as nothing at all.
        ...(guard ? [{ key: "f9", cmd: "hud.mode.cycle", desc: "Cycle permission mode" }] : []),
        { key: "f10", cmd: "hud.agents.list", desc: "List subagents" },
        { key: "f11", cmd: "hud.menu", desc: "HUD menu" },
        { key: "f7", cmd: "hud.usage.toggle", desc: "Collapse/expand sidebar usage" },
      ],
    });
  },
};
