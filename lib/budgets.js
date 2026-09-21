// Budget math for the weighted depletion balancer: the broker routes toward the
// provider with the most observed window headroom so subscriptions burn at
// roughly the same relative rate. Capacities are operator estimates, not
// provider quota truth: they influence selection only. Provider quota circuits
// are the authoritative eligibility gate after a provider reports exhaustion.
// Windows are fixed-length and anchored at first spend (how these plans actually
// meter); an `anchor` epoch-ms pins the phase for plans with a published reset
// (e.g. Monday UTC+8).
//
// Everything here is pure over (budgets ledger, window config, now) -- the
// broker owns the ledger, this module owns the arithmetic.
import { CONFIG } from "./config.js";
import { activeDealMultiplier } from "./deals.js";
import { cachedPlanUsage } from "./plan-usage.js";

export const PROVIDER_BUDGETS = CONFIG.budgets;

// Providers do not publish their plan limits; the only truth arrives as 429s.
// So capacities SELF-CALIBRATE: when a provider reports rate/quota exhaustion,
// the ledger's spend at that moment is the observed ceiling for the matching
// window; when spend later passes a learned ceiling without complaint, the
// ceiling raises to match. Configured capacities are only the prior shown
// (and used) until the first observation.
const learnedOf = (budgets, providerID) => budgets?.[providerID]?.learned ?? {};
export const capacityFor = (window, learned = {}) => {
  const observed = Number(learned[window.id]);
  return Number.isFinite(observed) && observed > 0 ? observed : Number(window.capacity);
};

export const learnCapacityFromFailure = (budgets, providerID, kind, now = Date.now(), config = PROVIDER_BUDGETS) => {
  const windows = config[providerID]?.windows;
  if (!Array.isArray(windows) || !windows.length) return budgets ?? {};
  const rolled = rolledProviderBudget(providerID, budgets, now, config);
  if (!rolled) return budgets ?? {};
  // A rate error names the short window, a quota error the long one.
  const sorted = [...windows].sort((a, b) => a.periodMs - b.periodMs);
  const hit = kind === "rate" ? sorted[0] : sorted[sorted.length - 1];
  const index = windows.findIndex((window) => window.id === hit.id);
  const spent = hit.meter === "tokens" ? rolled.windows[index].spentTokens : rolled.windows[index].spentRequests;
  if (!(spent > 0)) return budgets ?? {};
  const learned = { ...learnedOf(budgets, providerID), [hit.id]: spent };
  return {
    ...(budgets ?? {}),
    [providerID]: { ...(budgets?.[providerID] ?? {}), windows: rolled.windows, learned },
  };
};

// Cache reads are billed well under fresh input everywhere we route; a flat
// discount is close enough for balancing.
const CACHE_READ_WEIGHT = 0.1;
const tokenSpendOf = (tokens = {}) =>
  (Number(tokens.input) || 0) + (Number(tokens.output) || 0) +
  (Number(tokens.cacheWrite) || 0) + CACHE_READ_WEIGHT * (Number(tokens.cacheRead) || 0);

const rolledWindow = (window, record, now) => {
  const spentRequests = Number(record?.spentRequests) || 0;
  const spentTokens = Number(record?.spentTokens) || 0;
  const anchor = Number(window.anchor);
  let windowStart = Number(record?.windowStart);
  if (!Number.isFinite(windowStart) || windowStart <= 0) {
    windowStart = Number.isFinite(anchor) && anchor > 0
      ? anchor + Math.floor(Math.max(0, now - anchor) / window.periodMs) * window.periodMs
      : now;
    return { id: window.id, windowStart, spentRequests: 0, spentTokens: 0 };
  }
  if (now - windowStart < window.periodMs) {
    return { id: window.id, windowStart, spentRequests, spentTokens };
  }
  const advanced = windowStart + Math.floor((now - windowStart) / window.periodMs) * window.periodMs;
  return { id: window.id, windowStart: advanced, spentRequests: 0, spentTokens: 0 };
};

const rolledProviderBudget = (providerID, budgets, now, config) => {
  const windows = config[providerID]?.windows;
  if (!Array.isArray(windows) || !windows.length) return null;
  const records = budgets?.[providerID]?.windows ?? [];
  const byID = new Map(records.map((record) => [record?.id, record]));
  return { windows: windows.map((window) => rolledWindow(window, byID.get(window.id), now)) };
};

export const recordBudgetUsage = (budgets, providerID, { requests = 0, tokens = {}, modelID } = {}, now = Date.now(), config = PROVIDER_BUDGETS, deals = undefined) => {
  const rolled = rolledProviderBudget(providerID, budgets, now, config);
  if (!rolled) return budgets ?? {};
  const spendRequests = Math.max(0, Number(requests) || 0);
  // Spend during an active usage deal is recorded at the discounted rate, so
  // utilization tracks the TRUE burn and depletion keeps favoring the window.
  const spendTokens = Math.max(0, tokenSpendOf(tokens)) *
    activeDealMultiplier({ providerID, modelID }, now, deals);
  const nextWindows = rolled.windows.map((window) => ({
    ...window,
    spentRequests: window.spentRequests + spendRequests,
    spentTokens: window.spentTokens + spendTokens,
  }));
  // Passing a learned ceiling without a provider complaint proves it is higher.
  const learned = { ...learnedOf(budgets, providerID) };
  const windows = config[providerID].windows;
  for (let index = 0; index < windows.length; index++) {
    const observed = Number(learned[windows[index].id]);
    if (!Number.isFinite(observed) || observed <= 0) continue;
    const spent = windows[index].meter === "tokens" ? nextWindows[index].spentTokens : nextWindows[index].spentRequests;
    if (spent > observed) learned[windows[index].id] = spent;
  }
  return {
    ...(budgets ?? {}),
    [providerID]: {
      ...(budgets?.[providerID] ?? {}),
      windows: nextWindows,
      ...(Object.keys(learned).length ? { learned } : {}),
    },
  };
};

export const budgetUtilization = (budgets, providerID, now = Date.now(), config = PROVIDER_BUDGETS) => {
  const rolled = rolledProviderBudget(providerID, budgets, now, config);
  if (!rolled) return 0;
  const windows = config[providerID].windows;
  const learned = learnedOf(budgets, providerID);
  let utilization = 0;
  for (let index = 0; index < windows.length; index++) {
    const capacity = capacityFor(windows[index], learned);
    if (!Number.isFinite(capacity) || capacity <= 0) continue;
    const spent = windows[index].meter === "tokens"
      ? rolled.windows[index].spentTokens
      : rolled.windows[index].spentRequests;
    utilization = Math.max(utilization, spent / capacity);
  }
  return utilization;
};

// Plan windows encode their period in the id: "5h", "wk", "wk:fable" (a
// model-scoped weekly sub-cap), or openai's "30m"/"Nh"/"wk" from
// limit_window_seconds. The balancer must compare LIKE PERIOD TO LIKE PERIOD --
// a 5-hour burst window and a weekly subscription window measure different
// things and recover at different rates, so ranking one provider's 5h against
// another's weekly is apples-to-oranges. An unparseable id is treated as
// durable (never as a fast burst that gets discounted below).
const WEEK_MS = 7 * 86_400_000;
const planWindowPeriodMs = (id) => {
  const base = String(id ?? "").split(":")[0];
  if (base === "wk" || base === "week" || base === "weekly") return WEEK_MS;
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(base);
  if (!match) return null;
  const scale = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return Number(match[1]) * scale;
};
// A short burst window this close to its own cap fences its provider before the
// hard 100% circuit fires -- a taper, not a balancing input, so a half-spent
// burst window can't starve a provider whose durable budget is the leanest.
//
// That reasoning holds only while the burst window is not the binding
// constraint. When a plan's 5h window is the one that actually throttles, a
// durable-only comparison balances on a weekly total that is nearly empty for
// everyone and never sees the pressure the session is really under. Lower this
// (top-level `burstFence`) to let the burst window count sooner; the default
// keeps the original taper semantics.
//
// Top level, NOT under `budgets`: that object is keyed by providerID and gets
// walked as one (budgetReport below, the plan-usage refresh in the broker), so
// a scalar parked beside the providers would be iterated as if it were one.
const BURST_FENCE = Number(CONFIG.burstFence ?? 0.9);

// The balancer's utilization: the provider's OWN reported plan percent when a
// fresh report exists, else the local estimate. The estimate guessed anthropic
// at 100.8% burn while the plan API said 2% -- and weighted depletion steered
// by that guess. "Usage is exact as reported, not an estimate" applies to the
// decision point, not just the display. The DURABLE (longest-period) window is
// the subscription budget to spread across providers; shorter windows are burst
// rate-limits that only fence their own provider as they near exhaustion.
// Whether a provider's utilization is OBSERVED (the provider told us what it has
// spent) or merely INFERRED from the local ledger. The distinction decides how
// much a number is worth in a cross-provider comparison: an inferred figure is
// only as complete as this host's own ledger, and the ledger is host-local.
export const utilizationIsObserved = (providerID, plan = cachedPlanUsage(providerID)) => {
  const windows = plan?.windows;
  return Array.isArray(windows) && windows.some((window) => Number.isFinite(Number(window?.percent)));
};

export const effectiveUtilization = (budgets, providerID, now = Date.now(), config = PROVIDER_BUDGETS, plan = cachedPlanUsage(providerID)) => {
  const windows = plan?.windows;
  if (Array.isArray(windows) && windows.length) {
    const scored = [];
    for (const window of windows) {
      const percent = Number(window?.percent);
      if (!Number.isFinite(percent)) continue;
      scored.push({ percent: percent / 100, period: planWindowPeriodMs(window?.id) ?? Infinity });
    }
    if (scored.length) {
      const maxPeriod = Math.max(...scored.map((w) => w.period));
      const durable = Math.max(...scored.filter((w) => w.period === maxPeriod).map((w) => w.percent));
      const shorter = scored.filter((w) => w.period < maxPeriod).map((w) => w.percent);
      const burst = shorter.length ? Math.max(...shorter) : 0;
      return burst >= BURST_FENCE ? Math.max(durable, burst) : durable;
    }
  }
  return budgetUtilization(budgets, providerID, now, config);
};

export const budgetReport = (budgets, now = Date.now(), config = PROVIDER_BUDGETS) => {
  const report = {};
  for (const providerID of Object.keys(config)) {
    const rolled = rolledProviderBudget(providerID, budgets, now, config);
    if (!rolled) continue;
    report[providerID] = {
      source: "observed-local-estimate",
      utilization: Number(budgetUtilization(budgets, providerID, now, config).toFixed(4)),
      windows: config[providerID].windows.map((window, index) => {
        const learned = learnedOf(budgets, providerID);
        const capacity = capacityFor(window, learned);
        return {
          id: window.id,
          meter: window.meter,
          capacity,
          source: Number.isFinite(Number(learned[window.id])) && Number(learned[window.id]) > 0 ? "learned" : "estimate",
          spent: window.meter === "tokens"
            ? Math.round(rolled.windows[index].spentTokens)
            : rolled.windows[index].spentRequests,
          resetsAt: new Date(rolled.windows[index].windowStart + window.periodMs).toISOString(),
        };
      }),
    };
  }
  return report;
};
