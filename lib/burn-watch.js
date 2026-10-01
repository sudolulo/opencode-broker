// ☠️ THE BURN WATCH: a runaway is caught by its RATE, whatever caused it.
//
// A session caught in a loop can burn a large share of a subscription window in minutes: a
// compaction that repeats, a context-pruning plugin that keeps invalidating the prompt cache,
// a turn that re-engages after every overflow. Each such cause can be fixed at its source,
// but nothing fixed at a source watches the RATE, so the next loop of a new shape runs until
// the plan is gone. This module is that watch. It lives in the broker because every opencode
// instance already reports each provider request to /usage (one step-finish part = one
// request, tokens included): the broker is the one place that sees every session at once.
//
// Two signals. The default numbers come from replaying a week of real step-finish data
// (9,079 steps, 47 cloud sessions, frontier models with contexts up to ~450K) through this
// module; every one of them is config (`burnWatch` in lib/config.js):
//
//   1. REPEATED FULL REWRITES (stops the session, per actual sessionID). A healthy session
//      writes its whole prompt to the provider cache once -- after a restart, a compaction
//      or a model change -- and reads it back on every later step. A runaway re-writes it
//      again and again: the worst session of that week re-sent its full 427K six times in
//      two minutes, and a context-pruning loop re-sent 250K seven times in 2.5 minutes. A
//      rewrite is a step whose FRESH prompt (input plus cache write: uncached for OpenAI,
//      newly cached for Anthropic) is at least `rewriteTokens` and at least half of the
//      whole prompt. It trips on `rewriteCount` of them inside `rewriteWindowMs` carrying
//      `rewriteVolumeTokens` between them. The looping session is stopped by itself; a
//      subagent that loops never drags its root down with it.
//      ☠️ The count ALONE is not enough. "3 rewrites in 10 min" stopped 81 sessions that
//      week: while the pruning loop was live, nearly every busy session re-sent its prompt
//      every few steps. The volume floor is what separates a burst that costs real plan
//      from a cache that is merely being used badly.
//   2. SESSION-TREE SPEND. Weighted tokens -- input + output + cache write + 0.1 x cache
//      read, the balancer's own spend measure -- within `sessionSpendWindowMs`, summed over
//      every report whose root is this root. `sessionSpendTokens` (3M) NOTIFIES, keyed to
//      the root; `sessionStopTokens` (6M) stops the actual sessionID whose report crossed
//      the line. The worst runaway peaked at 3.94M in five minutes and the next highest at
//      2.09M, but spend alone cannot tell a loop from honest heavy work: a 440K context
//      stepping every 5 s, all cache reads, is ~2.7M in five minutes, and an 800K one
//      ~4.8M. Stopping that would stop real work every few minutes. So spend stops only at
//      1.5x the worst runaway, a shape no working session reaches, and the loop signature
//      in (1) is what stops loops. A lone session is a tree of one, so a session without
//      subagents behaves exactly as before.
//   (1) alone would have stopped FOUR sessions that week, each a burst of 1.5M+ fresh
//   tokens in five minutes, and the worst of them 72 s into its burst.
//
// Two signals used to live here and were REMOVED (2026-10): provider-spend (across all
// sessions on one provider) and plan-rise (the provider's own plan-usage percent climbing).
// In the fourteen days before the removal they fired 47 of 49 alerts for 2 real stops --
// 17 provider-spend, 30 plan-rise -- and every one was a fan-out of healthy sessions
// summing past a fixed all-sessions line. The provider-spend signal cannot tell N parallel
// healthy sessions from one runaway: once there is enough traffic, any fixed sum trips. The
// plan-rise signal could only ever fire for providers that publish a plan percent, so it
// was coverage-shaped like a config of providers rather than a property of a runaway. The
// fan-out case the two signals existed for -- many children of one root each under the
// per-session limit -- is covered now by rolling every subagent into its root for (2), and
// a parallel burst from unrelated sessions is no longer alerted at all.
//
// "Stops" means the broker answers the /usage report with `burn.stop`, and the router
// plugin that sent it aborts that session's turn and says why. Nothing is deleted; the
// person can continue deliberately, and the counters restart from zero when they do.
// Local providers are never counted (the broker leaves them out): they cost no plan.

export const BURN_DEFAULTS = Object.freeze({
  rewriteTokens: 100_000,
  rewriteCount: 4,
  rewriteVolumeTokens: 1_500_000,
  rewriteWindowMs: 5 * 60_000,
  sessionSpendTokens: 3_000_000,
  sessionStopTokens: 6_000_000,
  sessionSpendWindowMs: 5 * 60_000,
  notifyCooldownMs: 15 * 60_000,
});

const CACHE_READ_WEIGHT = 0.1;
const n = (value) => Math.max(0, Number(value) || 0);

export const weightedSpend = (tokens = {}) =>
  n(tokens.input) + n(tokens.output) + n(tokens.cacheWrite) + CACHE_READ_WEIGHT * n(tokens.cacheRead);

export const isFullRewrite = (tokens = {}, minTokens = BURN_DEFAULTS.rewriteTokens) => {
  const fresh = n(tokens.input) + n(tokens.cacheWrite);
  const prompt = fresh + n(tokens.cacheRead);
  return fresh >= minTokens && fresh * 2 >= prompt;
};

const fmt = (tokens) => `${(tokens / 1e6).toFixed(2)}M`;
const minutes = (ms) => `${Math.round(ms / 60_000)} min`;

// A short "provider/model, provider/model, +K more" list of the distinct pairs that
// contributed spend inside the window, in the order they first appeared.
const summarizeModels = (entries, cap = 4) => {
  const seen = [];
  for (const entry of entries) {
    const label = entry.model;
    if (!label) continue;
    if (!seen.includes(label)) seen.push(label);
  }
  if (!seen.length) return "";
  if (seen.length <= cap) return seen.join(", ");
  const extra = seen.length - cap;
  return `${seen.slice(0, cap).join(", ")}, +${extra} more`;
};

// Every alert is { kind, title, body }. `kind` is one of "stop" or "session-spend", so a
// notify command can treat a stop differently.
export const createBurnWatch = ({ config = BURN_DEFAULTS, now = () => Date.now() } = {}) => {
  const c = { ...BURN_DEFAULTS, ...config };
  const sessions = new Map(); // sessionID -> [{ at, spend, rewrite, fresh }]
  const trees = new Map(); // rootSessionID -> [{ at, spend, sessionID, model }]
  const alerted = new Map(); // alert key -> at
  const longest = Math.max(c.rewriteWindowMs, c.sessionSpendWindowMs);

  const within = (list, windowMs, at) => list.filter((entry) => entry.at > at - windowMs);
  const due = (key, at) => {
    const last = alerted.get(key);
    if (last !== undefined && at - last < c.notifyCooldownMs) return false;
    alerted.set(key, at);
    return true;
  };
  // The broker runs for weeks, and every session (and every gateway request, which mints
  // its own id) leaves an entry here. Drop the ones whose windows have fully passed, at
  // most once per window, so memory follows live sessions rather than every one ever seen.
  let sweptAt = -Infinity;
  const sweep = (at) => {
    if (at - sweptAt < longest) return;
    sweptAt = at;
    for (const [sessionID, list] of sessions) {
      if (!list.some((entry) => entry.at > at - longest)) sessions.delete(sessionID);
    }
    for (const [root, list] of trees) {
      if (!list.some((entry) => entry.at > at - longest)) trees.delete(root);
    }
    for (const [key, last] of alerted) {
      if (at - last >= c.notifyCooldownMs) alerted.delete(key);
    }
  };

  // One provider request. Returns { stop, alerts }: `stop` is { reason } when this
  // session has to be stopped now, and `alerts` are notifications to send.
  //
  // `rootSessionID` identifies the parent session for a subagent; a session without a
  // parent has root === sessionID (a tree of one). Spend is summed across the tree so a
  // fan-out of children each under the per-session line still trips the tree alarm, while
  // STOPS stay per actual sessionID: only the looping session is stopped, never its tree.
  const recordUsage = ({ sessionID, rootSessionID, providerID, modelID, tokens, at = now() }) => {
    sweep(at);
    const alerts = [];
    const spend = weightedSpend(tokens);
    const rewrite = isFullRewrite(tokens, c.rewriteTokens);
    const root = rootSessionID || sessionID;
    const model = providerID && modelID ? `${providerID}/${modelID}` : (providerID || null);

    if (!sessionID) return { stop: null, alerts };

    // Per-session history for the rewrite signature and the per-session spend stop.
    const own = within(sessions.get(sessionID) ?? [], longest, at);
    const fresh = n(tokens?.input) + n(tokens?.cacheWrite);
    own.push({ at, spend, rewrite, fresh });
    sessions.set(sessionID, own);

    // Per-tree history for the session-spend NOTIFY only. Stops are per actual session
    // (see below): the tree sum is a fan-out signal, not a stop input.
    const treeHistory = within(trees.get(root) ?? [], c.sessionSpendWindowMs, at);
    treeHistory.push({ at, spend, sessionID, model });
    trees.set(root, treeHistory);

    const rewrites = within(own, c.rewriteWindowMs, at).filter((entry) => entry.rewrite);
    const rewritten = rewrites.reduce((sum, entry) => sum + entry.fresh, 0);
    // Own-spend inside the session-spend window: THIS session's weighted tokens, nothing
    // the tree summed from siblings. Stops are per actual sessionID (the looping child,
    // never its tree), so the stop check reads this and not the tree sum.
    const ownSpendWindow = within(own, c.sessionSpendWindowMs, at)
      .reduce((sum, entry) => sum + entry.spend, 0);
    const treeSpend = treeHistory.reduce((sum, entry) => sum + entry.spend, 0);

    let reason = null;
    if (rewrites.length >= c.rewriteCount && rewritten >= c.rewriteVolumeTokens) {
      reason = `it re-sent its whole prompt uncached ${rewrites.length} times in ${minutes(c.rewriteWindowMs)} (${fmt(rewritten)} tokens) -- a healthy session does that once, then reads the cache`;
    } else if (ownSpendWindow >= c.sessionStopTokens) {
      reason = `it spent ${fmt(ownSpendWindow)} weighted tokens in ${minutes(c.sessionSpendWindowMs)} (stop limit ${fmt(c.sessionStopTokens)})`;
    }
    if (!reason) {
      if (treeSpend >= c.sessionSpendTokens && due(`session-spend:${root}`, at)) {
        // Count DISTINCT subagent sessions in the tree window: the fan-out signal is "how
        // many children of this root are contributing", so the root's own entries don't
        // count. The phrase is omitted when nobody but the root reported (N === 0).
        const subagentIDs = new Set();
        for (const entry of treeHistory) {
          if (entry.sessionID && entry.sessionID !== root) subagentIDs.add(entry.sessionID);
        }
        const subagentPhrase = subagentIDs.size > 0
          ? ` across ${subagentIDs.size} subagent session(s)`
          : "";
        const modelList = summarizeModels(treeHistory);
        const modelPhrase = modelList ? ` on ${modelList}` : "";
        alerts.push({
          kind: "session-spend",
          title: `Burn watch: session ${root} is burning abnormally`,
          body: `Session ${root} spent ${fmt(treeSpend)} weighted tokens in ${minutes(c.sessionSpendWindowMs)}${subagentPhrase}${modelPhrase} (alarm at ${fmt(c.sessionSpendTokens)}, stop at ${fmt(c.sessionStopTokens)}). It was not stopped.`,
        });
      }
      return { stop: null, alerts };
    }
    // Start over for the stopped session: continuing is the person's call, and a continued
    // session must earn a second stop on its OWN evidence rather than trip again on the
    // first one's. sessions.delete clears the per-session window the stop check reads, so
    // the stopped-and-continued session needs to re-earn the stop line from zero.
    //
    // The tree keeps the OTHER members' entries -- a stopped looping child does not reset
    // the alarm its siblings still deserve -- but drops the stopped session's own entries:
    // they have already been acted on, so leaving them in would keep the notify above its
    // line on pre-stop evidence after the stop and tempt the next (unstopped) child's
    // small step past the alarm when its own spend did nothing of the kind.
    sessions.delete(sessionID);
    const siblings = (trees.get(root) ?? []).filter((entry) => entry.sessionID !== sessionID);
    if (siblings.length) trees.set(root, siblings);
    else trees.delete(root);
    if (due(`session:${sessionID}`, at)) {
      const subagent = root !== sessionID ? ` (a subagent of ${root})` : "";
      const modelPhrase = model ? ` on ${model}` : "";
      alerts.push({
        kind: "stop",
        title: `Burn watch stopped a session`,
        body: `Session ${sessionID}${subagent} was stopped because ${reason}${modelPhrase}.`,
      });
    }
    return { stop: { reason }, alerts };
  };

  // How many sessions, trees and alert cooldowns are held in memory.
  const tracked = () => ({ sessions: sessions.size, trees: trees.size, cooldowns: alerted.size });

  return { recordUsage, tracked };
};
