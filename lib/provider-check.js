// Background provider checks: the broker, not a user's prompt, finds out that a
// plan has lapsed or that a fenced provider is usable again.
//
// Before this, the only way to learn either was a real request: a lapsed plan
// surfaced as an error in whichever session leased it first, and a provider fenced
// on a guessed reset time stayed out of the pool until that guess expired -- on
// 2026-09-28 openai sat fenced until 17:05 while its own usage API already said
// `allowed: true` on a freshly reset week.
//
// Each provider gets the best signal it offers, cheapest first:
//   - `check: { type: "count-tokens", url, model }` -- an Anthropic-compatible
//     `/messages/count_tokens` call. Free (nothing is generated), and entitlement-
//     gated: Alibaba's token plan answers 403 `AccessDenied.Unpurchased` there on
//     a lapsed plan and 200 on a live one. It says nothing about window quota
//     (counting is not metered), so it may only clear a LAPSE, never a quota stop.
//   - a configured `planUsage` source -- the provider's own usage API, which is
//     authoritative on both: a fresh reading means the subscription is live
//     (openai additionally names the plan, and `free` means the paid one lapsed),
//     and its lock state is the provider's own.
// The first runs on a timer (lib/provider-check.js's only poll); the second rides the
// usage refresh every broker request already makes. Both yield
// { entitlement: "active" | "lapsed", quotaAuthoritative } or null when nothing was
// learned; null never changes a circuit.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// A lapsed plan has no reset coming. The background check refreshes this hold for
// as long as the lapse lasts; the expiry is only the backstop for a check that has
// stopped working, after which one real request re-probes.
export const LAPSED_HOLD_MS = 6 * 60 * 60 * 1000;
// A failure-reported quota stop is the provider's own word at the moment of the
// failure. A usage reading may lag it, so only an older stop is lifted on a reading
// -- no faster than the fixed re-probe it replaces.
export const QUOTA_CLEAR_MIN_AGE_MS = 15 * 60 * 1000;
export const PLAN_LAPSED_REASON = "plan-lapsed";

const defaultAuthPath = () => join(homedir(), ".local/share/opencode/auth.json");

const apiKey = (authPath, providerID) => {
  try {
    const entry = JSON.parse(readFileSync(authPath, "utf8"))?.[providerID];
    return entry?.type === "api" && typeof entry.key === "string" && entry.key ? entry.key : null;
  } catch {
    return null;
  }
};

const CHECKS = {
  "count-tokens": async ({ providerID, check, authPath, fetchImpl }) => {
    if (typeof check.url !== "string" || !/^https:\/\//.test(check.url) || typeof check.model !== "string") return null;
    const key = apiKey(authPath, providerID);
    if (!key) return null;
    const response = await fetchImpl(`${check.url.replace(/\/+$/, "")}/messages/count_tokens`, {
      method: "POST",
      redirect: "error",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: check.model, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { entitlement: "active", quotaAuthoritative: false };
    const text = await response.text().catch(() => "");
    if (/\bunpurchased\b/i.test(text)) return { entitlement: "lapsed", quotaAuthoritative: false };
    return null;
  },
};

// Only providers WITHOUT a live usage reading need the timer: a planUsage source is
// already refreshed on every broker request (and awaited before admission), so its
// result is applied there, via planUsageResult, not polled a second time.
export const providerCheckConfigured = (providerConfig) => Boolean(CHECKS[providerConfig?.check?.type]);

export const checkProvider = async (providerID, providerConfig, { fetchImpl = fetch, authPath = defaultAuthPath() } = {}) => {
  const check = CHECKS[providerConfig?.check?.type];
  if (!check) return null;
  try {
    return await check({ providerID, check: providerConfig.check, authPath: providerConfig.check.authPath ?? authPath, fetchImpl });
  } catch {
    return null;
  }
};

// A usage reading as a check result. The caller must pass only a FRESH reading
// (freshPlanUsage): `fetchPlanUsage` serves the last good report when the endpoint
// fails, and a stale "active" must not lift anything.
export const planUsageResult = (report) => {
  if (!report) return null;
  if (report.plan === "free") return { entitlement: "lapsed", quotaAuthoritative: true };
  return { entitlement: "active", quotaAuthoritative: true, lockedUntil: report.lockedUntil ?? null };
};

// Pure: apply one check result to the provider-scoped circuit. Returns what changed
// ("lapsed" | "recovered") or null. Only quota-kind circuits are ever lifted -- a
// connect outage or a compatibility quarantine is not the plan's business.
export const applyProviderCheck = (circuits, providerKey, result, now = Date.now()) => {
  if (!providerKey || !result) return null;
  const existing = circuits[providerKey];
  if (result.entitlement === "lapsed") {
    const wasLapsed = existing?.reason === PLAN_LAPSED_REASON;
    circuits[providerKey] = { kind: "quota", reason: PLAN_LAPSED_REASON, until: now + LAPSED_HOLD_MS, updatedAt: now };
    return wasLapsed ? null : "lapsed";
  }
  if (result.entitlement !== "active" || existing?.kind !== "quota") return null;
  if (existing.reason === PLAN_LAPSED_REASON) {
    delete circuits[providerKey];
    return "recovered";
  }
  if (result.quotaAuthoritative && !result.lockedUntil &&
    now - Number(existing.updatedAt ?? 0) >= QUOTA_CLEAR_MIN_AGE_MS) {
    delete circuits[providerKey];
    return "recovered";
  }
  return null;
};
