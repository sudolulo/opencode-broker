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
// Three signals. The default numbers come from replaying a week of real step-finish data
// (9,079 steps, 47 cloud sessions, frontier models with contexts up to ~450K) through this
// module; every one of them is config (`burnWatch` in lib/config.js):
//
//   1. REPEATED FULL REWRITES (stops the session). A healthy session writes its whole
//      prompt to the provider cache once -- after a restart, a compaction or a model
//      change -- and reads it back on every later step. A runaway re-writes it again
//      and again: the worst session of that week re-sent its full 427K six times in two
//      minutes, and a context-pruning loop re-sent 250K seven times in 2.5 minutes. A
//      rewrite is a step whose FRESH prompt (input plus cache write: uncached for OpenAI,
//      newly cached for Anthropic) is at least `rewriteTokens` and at least half of the
//      whole prompt. It trips on `rewriteCount` of them inside `rewriteWindowMs` carrying
//      `rewriteVolumeTokens` between them.
//      ☠️ The count ALONE is not enough. "3 rewrites in 10 min" stopped 81 sessions that
//      week: while the pruning loop was live, nearly every busy session re-sent its prompt
//      every few steps. The volume floor is what separates a burst that costs real plan
//      from a cache that is merely being used badly.
//   2. SESSION SPEND. Weighted tokens -- input + output + cache write + 0.1 x cache read,
//      the balancer's own spend measure -- within `sessionSpendWindowMs`.
//      `sessionSpendTokens` (3M) NOTIFIES; `sessionStopTokens` (6M) stops. The worst
//      runaway peaked at 3.94M in five minutes and the next highest at 2.09M, but spend
//      alone cannot tell a loop from honest heavy work: a 440K context stepping every 5 s,
//      all cache reads, is ~2.7M in five minutes, and an 800K one ~4.8M. Stopping that
//      would stop real work every few minutes. So spend stops only at 1.5x the worst
//      runaway, a shape no working session reaches, and the loop signature in (1) is what
//      stops loops.
//   (1) alone would have stopped FOUR sessions that week, each a burst of 1.5M+ fresh
//   tokens in five minutes, and the worst of them 72 s into its burst.
//   3. PROVIDER SPEND and PLAN VELOCITY (notify only). Across all sessions, where no
//      single one is to blame: a fan-out whose children each stay under (2), or a burn
//      the broker cannot see in tokens at all. Provider spend at 3M in five minutes would
//      have alerted four times that week, all during the bursts above. Plan velocity reads
//      the provider's OWN percent (config `budgets.*.planUsage`), so it is ground truth,
//      but coarse: a provider may refresh it only every few minutes, in whole percent.
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
  providerSpendTokens: 3_000_000,
  providerSpendWindowMs: 5 * 60_000,
  planWindow: "5h",
  planRisePoints: 6,
  planRiseWindowMs: 10 * 60_000,
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

// Every alert is { kind, title, body }. `kind` is one of "stop", "session-spend",
// "provider-spend" or "plan-rise", so a notify command can treat a stop differently.
export const createBurnWatch = ({ config = BURN_DEFAULTS, now = () => Date.now() } = {}) => {
  const c = { ...BURN_DEFAULTS, ...config };
  const sessions = new Map(); // sessionID -> [{ at, spend, rewrite, fresh }]
  const providers = new Map(); // providerID -> [{ at, spend }]
  const plans = new Map(); // providerID -> [{ at, percent }]
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
    for (const [key, last] of alerted) {
      if (at - last >= c.notifyCooldownMs) alerted.delete(key);
    }
  };

  // One provider request. Returns { stop, alerts }: `stop` is { reason } when this
  // session has to be stopped now, and `alerts` are notifications to send.
  const recordUsage = ({ sessionID, providerID, tokens, at = now() }) => {
    sweep(at);
    const alerts = [];
    const spend = weightedSpend(tokens);
    const rewrite = isFullRewrite(tokens, c.rewriteTokens);

    const all = within(providers.get(providerID) ?? [], c.providerSpendWindowMs, at);
    all.push({ at, spend });
    providers.set(providerID, all);
    const providerSpend = all.reduce((sum, entry) => sum + entry.spend, 0);
    if (providerSpend >= c.providerSpendTokens && due(`provider:${providerID}`, at)) {
      alerts.push({
        kind: "provider-spend",
        title: `Burn watch: ${providerID} is spending fast`,
        body: `${fmt(providerSpend)} weighted tokens across all sessions in ${minutes(c.providerSpendWindowMs)} (alarm at ${fmt(c.providerSpendTokens)}). No session was stopped; check what is running.`,
      });
    }

    if (!sessionID) return { stop: null, alerts };
    const own = within(sessions.get(sessionID) ?? [], longest, at);
    const fresh = n(tokens?.input) + n(tokens?.cacheWrite);
    own.push({ at, spend, rewrite, fresh });
    sessions.set(sessionID, own);
    const rewrites = within(own, c.rewriteWindowMs, at).filter((entry) => entry.rewrite);
    const rewritten = rewrites.reduce((sum, entry) => sum + entry.fresh, 0);
    const sessionSpend = within(own, c.sessionSpendWindowMs, at).reduce((sum, entry) => sum + entry.spend, 0);
    let reason = null;
    if (rewrites.length >= c.rewriteCount && rewritten >= c.rewriteVolumeTokens) {
      reason = `it re-sent its whole prompt uncached ${rewrites.length} times in ${minutes(c.rewriteWindowMs)} (${fmt(rewritten)} tokens) -- a healthy session does that once, then reads the cache`;
    } else if (sessionSpend >= c.sessionStopTokens) {
      reason = `it spent ${fmt(sessionSpend)} weighted tokens in ${minutes(c.sessionSpendWindowMs)} (stop limit ${fmt(c.sessionStopTokens)})`;
    }
    if (!reason) {
      if (sessionSpend >= c.sessionSpendTokens && due(`session-spend:${sessionID}`, at)) {
        alerts.push({
          kind: "session-spend",
          title: `Burn watch: one session is spending fast (${providerID})`,
          body: `Session ${sessionID} spent ${fmt(sessionSpend)} weighted tokens in ${minutes(c.sessionSpendWindowMs)} (alarm at ${fmt(c.sessionSpendTokens)}, stop at ${fmt(c.sessionStopTokens)}). It was not stopped.`,
        });
      }
      return { stop: null, alerts };
    }
    // Start over: continuing is the person's call, and a continued session must earn
    // a second stop on its own evidence rather than trip again on the first one's.
    sessions.delete(sessionID);
    if (due(`session:${sessionID}`, at)) {
      alerts.push({
        kind: "stop",
        title: `Burn watch stopped a session (${providerID})`,
        body: `Session ${sessionID} was stopped because ${reason}.`,
      });
    }
    return { stop: { reason }, alerts };
  };

  // A provider's plan windows as the broker last read them. Alerts when the watched
  // window's percent rose by planRisePoints or more within planRiseWindowMs.
  const recordPlan = ({ providerID, windows, at = now() }) => {
    const window = (Array.isArray(windows) ? windows : []).find((entry) => entry?.id === c.planWindow);
    const percent = Number(window?.percent);
    if (!Number.isFinite(percent)) return [];
    const readings = within(plans.get(providerID) ?? [], c.planRiseWindowMs, at);
    // The broker re-reads a cached report on every request; keep a reading only when
    // the value moved, or the list would be thousands of copies of one number.
    if (readings.at(-1)?.percent !== percent) readings.push({ at, percent });
    plans.set(providerID, readings);
    const low = Math.min(...readings.map((entry) => entry.percent));
    const rise = percent - low;
    if (rise < c.planRisePoints || !due(`plan:${providerID}`, at)) return [];
    return [{
      kind: "plan-rise",
      title: `Burn watch: ${providerID} plan rising fast`,
      body: `The ${c.planWindow} window went from ${low}% to ${percent}% within ${minutes(c.planRiseWindowMs)} (alarm at +${c.planRisePoints} points).`,
    }];
  };

  // How many sessions and alert cooldowns are held in memory.
  const tracked = () => ({ sessions: sessions.size, cooldowns: alerted.size });

  return { recordUsage, recordPlan, tracked };
};
