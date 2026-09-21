// Usage deals: limited-time provider discounts the balancer leans into
// automatically, so the user never has to know a deal exists.
//
// Subscription and credit plans run these (measured example: DeepSeek models on
// the Alibaba token plan bill 50% between 22:00 and 08:00 UTC+8). A deal is
// declared in config and does two things:
//   * SELECTION: within the budget-balanced candidate set, targets with the
//     lowest active multiplier are preferred, so discounted capacity absorbs
//     traffic first (never across tiers -- a deal reorders eligible candidates,
//     it does not change what is eligible);
//   * LEDGER: token spend on a discounted provider is recorded at the
//     multiplier, so utilization reflects the true burn and weighted depletion
//     keeps steering toward the cheaper window on its own.
//
// Config shape (see examples/config.example.json):
//   "deals": [{
//     "providerID": "alibaba-token-plan",       required
//     "modelPrefix": "deepseek-",               optional -- limits to matching modelIDs
//     "multiplier": 0.5,                        (0, 1]: fraction of normal cost
//     "daily": { "start": "22:00", "end": "08:00", "utcOffsetMinutes": 480 },
//       -- recurring window in the deal's own timezone; start > end wraps midnight
//     "window": { "from": "...iso...", "to": "...iso..." },   optional absolute bounds
//     "note": "why this exists / where it was announced"
//   }]
import { CONFIG } from "./config.js";

const minutesOfDay = (hhmm) => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

const dailyWindowActive = (daily, now) => {
  const start = minutesOfDay(daily?.start);
  const end = minutesOfDay(daily?.end);
  if (start === null || end === null) return false;
  const offset = Number.isFinite(Number(daily.utcOffsetMinutes)) ? Number(daily.utcOffsetMinutes) : 0;
  const local = new Date(now + offset * 60 * 1000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  // start > end wraps midnight (22:00-08:00): active when outside [end, start).
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
};

const absoluteWindowActive = (window, now) => {
  if (!window) return true;
  const from = Date.parse(window.from ?? "");
  const to = Date.parse(window.to ?? "");
  if (Number.isFinite(from) && now < from) return false;
  if (Number.isFinite(to) && now >= to) return false;
  return true;
};

const dealApplies = (deal, providerID, modelID, now) => {
  if (deal.providerID !== providerID) return false;
  if (deal.modelPrefix && !String(modelID ?? "").startsWith(deal.modelPrefix)) return false;
  if (!absoluteWindowActive(deal.window, now)) return false;
  if (deal.daily) return dailyWindowActive(deal.daily, now);
  return true;
};

// The lowest (best) multiplier of any active deal, or 1 when none applies.
export const activeDealMultiplier = ({ providerID, modelID } = {}, now = Date.now(), deals = undefined) => {
  if (deals === undefined) deals = CONFIG.deals;
  let best = 1;
  for (const deal of deals) {
    if (dealApplies(deal, providerID, modelID, now)) best = Math.min(best, deal.multiplier);
  }
  return best;
};
