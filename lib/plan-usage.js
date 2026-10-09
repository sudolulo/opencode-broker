// Exact plan usage, as the provider reports it. The budget ledger estimates
// spend from what the router itself routes -- it cannot see requests that burn
// the same subscription from other tools (a Claude Code session bills the same
// Anthropic plan the broker is balancing). When a provider exposes a usage API,
// its numbers are the truth: they replace the estimate in reports, gate
// admission when a window is exhausted, and carry the exact reset time the
// restore path waits for.
//
// Sources are keyed by `budgets.<provider>.planUsage.type` in the routing
// config, so any provider that grows a usage API gains this without code
// changes elsewhere. Every source normalizes to:
//   { windows: [{ id, percent, resetsAt|null, active, severity|null }],
//     lockedUntil: epochMs|null }
// `lockedUntil` is set when the provider says a plan window is exhausted right
// now -- the broker turns it into a provider circuit that expires exactly when
// the provider says the window resets.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 60 * 1000;
// A failing endpoint backs off, but only to two minutes: the last good reading keeps serving
// meanwhile, and every minute it serves is a minute the HUD has to call it stale. Ten minutes
// left readings up to that old on screen with nothing saying so (2026-10-09).
const FAILURE_TTL_MS = 2 * 60 * 1000;
// Anthropic's usage endpoint rate-limits per token and Claude Code shares the
// same budget: one poll a minute 429s it. Five minutes keeps both citizens fed.
const SOURCE_TTLS = { "anthropic-oauth": 5 * 60 * 1000, http: CACHE_TTL_MS };

const cache = new Map();
// In-flight de-duplication: concurrent broker requests during a cache-miss
// window must share ONE outbound call, not each fire their own.
const inFlight = new Map();

const defaultAuthPath = () => join(homedir(), ".local/share/opencode/auth.json");

// The token is read fresh on every fetch so opencode's own refresh cycle is
// honored, and it never leaves this module except inside the request header.
const oauthAccessToken = (authPath, providerKey) => {
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  for (const [key, value] of Object.entries(auth && typeof auth === "object" ? auth : {})) {
    if (key.includes(providerKey) && value && typeof value === "object" &&
      typeof value.access === "string" && value.access) {
      return value.access;
    }
  }
  return null;
};

const authCredential = (authPath, authRef) => {
  if (typeof authRef !== "string" || !authRef) return null;
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  const credential = auth && typeof auth === "object" && !Array.isArray(auth)
    ? auth[authRef]
    : null;
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) return null;
  for (const field of ["key", "apiKey", "access"]) {
    if (typeof credential[field] === "string" && credential[field]) return credential[field];
  }
  return null;
};

// A key held in its own file (the llm-auth-proxy front-door key), read the same way the gateway
// reads it: a regular file, owner-only, non-empty. Keeps the secret out of opencode's auth.json.
const keyFileCredential = (keyFile) => {
  if (typeof keyFile !== "string" || !keyFile) return null;
  const stat = statSync(keyFile);
  if (!stat.isFile() || (stat.mode & 0o077)) return null;
  return readFileSync(keyFile, "utf8").trim() || null;
};

const httpPlanUsageURL = (value) => {
  if (typeof value !== "string" || !value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username || parsed.password) return null;
  return parsed.href;
};

const normalizeCanonicalUsage = (data) => {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
    !Array.isArray(data.windows) || !data.windows.length ||
    !(data.lockedUntil === null || (typeof data.lockedUntil === "number" && Number.isFinite(data.lockedUntil)))) {
    return null;
  }
  const windows = [];
  for (const window of data.windows) {
    if (!window || typeof window !== "object" || Array.isArray(window) ||
      typeof window.id !== "string" || !window.id ||
      typeof window.percent !== "number" || !Number.isFinite(window.percent) ||
      !(window.resetsAt === null || (typeof window.resetsAt === "string" &&
        window.resetsAt.length > 0 && Number.isFinite(Date.parse(window.resetsAt)))) ||
      typeof window.active !== "boolean" ||
      !(window.severity === null || typeof window.severity === "string")) {
      return null;
    }
    windows.push({
      id: window.id,
      percent: window.percent,
      resetsAt: window.resetsAt,
      active: window.active,
      severity: window.severity,
    });
  }
  return { windows, lockedUntil: data.lockedUntil };
};

const ANTHROPIC_WINDOW_IDS = { session: "5h", weekly_all: "wk" };

const normalizeAnthropicUsage = (data) => {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const windows = [];
  for (const limit of limits) {
    if (!limit || typeof limit !== "object" || !Number.isFinite(Number(limit.percent))) continue;
    const scopedModel = limit.scope?.model?.display_name;
    const id = typeof scopedModel === "string" && scopedModel
      ? `wk:${scopedModel.toLowerCase()}`
      : (ANTHROPIC_WINDOW_IDS[limit.kind] ?? String(limit.kind ?? "window"));
    windows.push({
      id,
      percent: Number(limit.percent),
      resetsAt: typeof limit.resets_at === "string" && limit.resets_at ? limit.resets_at : null,
      active: limit.is_active === true,
      severity: typeof limit.severity === "string" ? limit.severity : null,
    });
  }
  if (!windows.length) return null;
  // Only the plan-wide windows lock the provider; a model-scoped weekly cap
  // (e.g. Fable) is the model's problem, not the provider's.
  // ☠️ A FULL WINDOW IS NOT A LOCKED ONE. Anthropic says when it is refusing in the top-level
  // `five_hour` / `seven_day` entry's `locked_reason`; on 2026-10-09 the session window read
  // 100% with `locked_reason: null` while every request still succeeded, and the lock took
  // anthropic out of routing until the reset. The percentage is only the fallback for a
  // response without that entry. Kept identical to llm-auth-proxy's src/plan-usage.ts.
  const enforced = (id) => {
    const entry = data?.[id === "5h" ? "five_hour" : "seven_day"];
    if (!entry || typeof entry !== "object" || !Object.hasOwn(entry, "locked_reason")) return null;
    return entry.locked_reason !== null && entry.locked_reason !== undefined;
  };
  const exhausted = windows
    .filter((window) => (window.id === "5h" || window.id === "wk") &&
      (enforced(window.id) ?? window.percent >= 100) && window.resetsAt)
    .map((window) => Date.parse(window.resetsAt))
    .filter((at) => Number.isFinite(at));
  return {
    windows,
    lockedUntil: exhausted.length ? Math.min(...exhausted) : null,
  };
};

const windowIDFromSeconds = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "window";
  if (value === 604800) return "wk";
  if (value % 3600 === 0) return `${value / 3600}h`;
  return `${Math.round(value / 60)}m`;
};

// llm-auth-proxy's OpenAI route reports `{ provider, plan?, windows: [{ id, percent, resetsAt,
// durationSeconds }] }` with `resetsAt` in epoch seconds, not the canonical shape. Read as
// canonical it was rejected outright, the last good reading served forever, and a plan at 100%
// kept reading 89% -- so every new session balanced onto an exhausted OpenAI (2026-10-01).
const normalizeProxyWindows = (data) => {
  // Only the proxy's own shape: a canonical-looking report (it carries `lockedUntil`) that
  // failed canonical validation stays rejected, never half-read through this door.
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.hasOwn(data, "lockedUntil") ||
    !Array.isArray(data.windows) || !data.windows.length) return null;
  const windows = [];
  for (const window of data.windows) {
    if (!window || typeof window !== "object" || typeof window.percent !== "number" || !Number.isFinite(window.percent) ||
      typeof window.durationSeconds !== "number" || !(window.durationSeconds > 0) ||
      !(window.resetsAt === null || (typeof window.resetsAt === "number" && window.resetsAt > 0))) return null;
    windows.push({
      id: windowIDFromSeconds(window.durationSeconds),
      percent: window.percent,
      resetsAt: window.resetsAt === null ? null : new Date(window.resetsAt * 1000).toISOString(),
      active: window.percent >= 100,
      severity: null,
    });
  }
  const exhausted = windows
    .filter((window) => window.percent >= 100 && window.resetsAt)
    .map((window) => Date.parse(window.resetsAt));
  return {
    windows,
    lockedUntil: exhausted.length ? Math.min(...exhausted) : null,
    ...(typeof data.plan === "string" && data.plan ? { plan: data.plan } : {}),
  };
};

const normalizeOpenaiUsage = (data) => {
  const rate = data?.rate_limit;
  if (!rate || typeof rate !== "object") return null;
  const windows = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = rate[key];
    if (!window || typeof window !== "object" || !Number.isFinite(Number(window.used_percent))) continue;
    windows.push({
      id: windowIDFromSeconds(window.limit_window_seconds),
      percent: Number(window.used_percent),
      resetsAt: Number.isFinite(Number(window.reset_at)) && Number(window.reset_at) > 0
        ? new Date(Number(window.reset_at) * 1000).toISOString()
        : null,
      active: rate.limit_reached === true || rate.allowed === false,
      severity: null,
    });
  }
  if (!windows.length) return null;
  const locked = (rate.limit_reached === true || rate.allowed === false)
    ? windows.map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : NaN)).filter(Number.isFinite)
    : [];
  return {
    windows,
    lockedUntil: locked.length ? Math.min(...locked) : null,
    // The subscription tier (`plus`, `pro`, `prolite`, ...). `free` means the paid
    // plan lapsed; provider-check.js reads it.
    ...(typeof data?.plan_type === "string" && data.plan_type ? { plan: data.plan_type } : {}),
  };
};

// A hard wall-clock deadline for a child-process promise. Nothing here waits on `close`,
// so a grandchild holding the pipes cannot outlive it. The child (and anything sharing its
// pid) is killed on expiry so the fds are released rather than leaked for the next call.
const BAILIAN_DEADLINE_MS = 20_000;

export const withDeadline = (pending, ms, label) => {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { pending?.child?.kill?.("SIGKILL"); } catch {}
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
};

const SOURCES = {
  "anthropic-oauth": async ({ authPath, fetchImpl = fetch }) => {
    const token = oauthAccessToken(authPath ?? defaultAuthPath(), "anthropic");
    if (!token) return null;
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return normalizeAnthropicUsage(await response.json());
  },
  "bailian-cli": async ({ execImpl = execFileAsync } = {}) => {
    // ☠️ execFile's own `timeout` IS NOT A DEADLINE ON THE PROMISE. It SIGTERMs the child,
    // but promisify(execFile) settles on `close`, which fires only once every stdio pipe is
    // shut -- and a grandchild that inherited stdout/stderr keeps them open after `bl` is
    // long dead. The await then hangs FOREVER with no child process left to see.
    // ☠️ And `/lease` awaits this refresh, so one wedged usage CLI stops the WHOLE FLEET
    // from leasing: on 2026-09-17 the broker sat on pipes opened at 22:21 with its event
    // loop fine and every prompt in every session timing out, for an hour and three
    // quarters, because a quota lookup never came back.
    // ☆ So: a real timer that does not care about pipes. On expiry the child is killed and
    // the source degrades to estimates -- which is what a missing reading already means.
    const pending = execImpl(blBinary(), ["usage", "token-plan", "--output", "json"], {
      timeout: 15000,
      killSignal: "SIGKILL",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const { stdout } = await withDeadline(pending, BAILIAN_DEADLINE_MS, "bailian usage CLI");
    return normalizeBailianUsage(JSON.parse(stdout));
  },
  http: async ({ authPath, fetchImpl = fetch, planUsage }) => {
    const url = httpPlanUsageURL(planUsage?.url);
    if (!url) return null;
    const credential = planUsage?.keyFile
      ? keyFileCredential(planUsage.keyFile)
      : authCredential(authPath ?? defaultAuthPath(), planUsage?.authRef);
    if (!credential) return null;
    const response = await fetchImpl(url, {
      redirect: "error",
      headers: { "x-api-key": credential },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return normalizeCanonicalUsage(data) ?? normalizeProxyWindows(data);
  },
  "openai-oauth": async ({ authPath, fetchImpl = fetch }) => {
    const token = oauthAccessToken(authPath ?? defaultAuthPath(), "openai");
    if (!token) return null;
    const response = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return normalizeOpenaiUsage(await response.json());
  },
};

// Alibaba's token-plan quota is queryable only with CONSOLE auth (the sk-sp
// key cannot read its own quota), and the official bailian CLI owns that token
// lifecycle. Shelling out keeps the auth handling theirs: `bl auth login
// --console` once, and this source serves exact numbers; without it, the CLI
// errors and estimates keep serving.
const blBinary = () => {
  const local = join(homedir(), ".local/bin/bl");
  return existsSync(local) ? local : "bl";
};

const percentFrom = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // The CLI reports fractions (0..1); tolerate a future switch to 0..100.
  return n <= 1 ? n * 100 : n;
};

const resetISOFrom = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Epoch ms vs epoch seconds.
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toISOString();
};

const normalizeBailianUsage = (data) => {
  if (!data || typeof data !== "object" || data.error) return null;
  const windows = [];
  const fiveHour = percentFrom(data.per5HourPercentage);
  if (fiveHour !== null) {
    windows.push({ id: "5h", percent: fiveHour, resetsAt: resetISOFrom(data.per5HourResetTime), active: fiveHour >= 100, severity: null });
  }
  const week = percentFrom(data.per1WeekPercentage);
  if (week !== null) {
    windows.push({ id: "wk", percent: week, resetsAt: resetISOFrom(data.per1WeekResetTime), active: week >= 100, severity: null });
  }
  if (!windows.length) return null;
  const exhausted = windows
    .filter((window) => window.percent >= 100 && window.resetsAt)
    .map((window) => Date.parse(window.resetsAt))
    .filter(Number.isFinite);
  return { windows, lockedUntil: exhausted.length ? Math.min(...exhausted) : null };
};

// Only a reset that happened AFTER the reading was taken: an upstream that hands back a
// reading whose reset is already past (llm-auth-proxy caches for a minute) must not turn
// every request into a refetch.
const windowHasReset = (report, now, fetchedAt) => (Array.isArray(report?.windows) ? report.windows : [])
  .some((window) => {
    const at = Date.parse(window?.resetsAt ?? "");
    return Number.isFinite(at) && at <= now && fetchedAt < at;
  });

export const planUsageConfigured = (providerConfig) =>
  Boolean(SOURCES[providerConfig?.planUsage?.type]);

// Cached fetch: at most one provider request a minute, and a null result is
// cached too (backed off harder) so a broken endpoint degrades to estimates
// instead of latency.
export const fetchPlanUsage = async (providerID, providerConfig, { now = Date.now(), fetchImpl, execImpl, authPath } = {}) => {
  const source = SOURCES[providerConfig?.planUsage?.type];
  if (!source) return null;
  const cached = cache.get(providerID);
  const successTtl = SOURCE_TTLS[providerConfig.planUsage.type] ?? CACHE_TTL_MS;
  // A reading is also over the moment one of its windows resets: past `resetsAt` its percentage
  // describes a window that no longer exists, and serving it out the TTL showed 100% for a
  // window that had already rolled over.
  if (cached && now - cached.at < (cached.report ? successTtl : Math.max(successTtl, FAILURE_TTL_MS)) &&
      !windowHasReset(cached.report, now, cached.at)) {
    return cached.report ?? cached.lastGood ?? null;
  }
  if (inFlight.has(providerID)) return inFlight.get(providerID);
  const fetching = (async () => {
    let report = null;
    try {
      report = await source({
        authPath: providerConfig.planUsage.authPath ?? authPath,
        fetchImpl,
        execImpl,
        planUsage: providerConfig.planUsage,
      });
    } catch {
      report = null;
    }
    // Every reading says when it was taken, so whoever shows it can tell a live number from
    // a held-over one (the HUD marks it stale; see hud/tui.js). It survives the snapshot and
    // a restart's seed, so a seeded reading is old by its own account, not "fresh".
    if (report) report = { ...report, fetchedAt: now };
    // A transient failure (the usage endpoint itself rate-limits) must not blank
    // the display: minutes-stale exact numbers beat "no data". The last good
    // report keeps serving until a fresh one replaces it -- carrying its own fetchedAt.
    cache.set(providerID, { at: now, report, lastGood: report ?? cached?.lastGood ?? null });
    return report ?? cached?.lastGood ?? null;
  })();
  inFlight.set(providerID, fetching);
  try {
    return await fetching;
  } finally {
    inFlight.delete(providerID);
  }
};

// ☠️ The cache is in-memory, so a broker restart loses every plan reading. That
// matters beyond a stale display: `balanceUnobservedUtilization` floats a
// provider with no readable quota up to the mean of the OBSERVED ones, and with
// an empty cache nothing is observed, so the balancing stands down and the
// unreadable lane is briefly the leanest-looking again -- the exact bug it
// exists to prevent, re-appearing for a minute after every restart.
// So the snapshot is persisted with the broker's state and seeded back on boot.
// Seeded entries carry `at: 0`, i.e. immediately stale: they serve as `lastGood`
// until the first real refresh replaces them, and never suppress that refresh.
export const planUsageSnapshot = () => {
  const snapshot = {};
  for (const [providerID, entry] of cache) {
    const report = entry?.report ?? entry?.lastGood ?? null;
    if (report) snapshot[providerID] = report;
  }
  return snapshot;
};

export const seedPlanUsageCache = (snapshot) => {
  let seeded = 0;
  for (const [providerID, report] of Object.entries(snapshot ?? {})) {
    if (!report || typeof report !== "object" || cache.has(providerID)) continue;
    cache.set(providerID, { at: 0, report: null, lastGood: report });
    seeded += 1;
  }
  return seeded;
};

// Only the reading the LAST fetch produced -- null when that fetch failed or the entry
// is a boot-time seed -- for callers that must not act on a stale `lastGood`.
export const freshPlanUsage = (providerID) => cache.get(providerID)?.report ?? null;

export const cachedPlanUsage = (providerID) => {
  const cached = cache.get(providerID);
  return cached?.report ?? cached?.lastGood ?? null;
};

// The reset the failover/restore path should wait for: the earliest future
// reset among exhausted plan-wide windows, else among active windows.
export const planUsageResetAt = (report, now = Date.now()) => {
  if (!report) return null;
  const future = (windows) => windows
    .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : NaN))
    .filter((at) => Number.isFinite(at) && at > now);
  const exhausted = future(report.windows.filter((window) => window.percent >= 100));
  if (exhausted.length) return Math.min(...exhausted);
  const active = future(report.windows.filter((window) => window.active));
  if (active.length) return Math.min(...active);
  return null;
};


// Provider-reported lockout as an ordinary circuit: the whole eligibility/
// decision/UI machinery already understands circuits, and the expiry is the
// provider's OWN reset time. The next refresh clears it early if the provider
// reopens sooner. Never shortens a longer non-plan circuit.
export const PLAN_WINDOW_KIND = "plan-window";
export const applyPlanUsageCircuit = (circuits, providerKey, report, now = Date.now()) => {
  if (!providerKey) return circuits;
  const existing = circuits[providerKey];
  if (report?.lockedUntil && report.lockedUntil > now) {
    const holdsLonger = existing && existing.kind !== PLAN_WINDOW_KIND &&
      (existing.until === null || Number(existing.until) >= report.lockedUntil);
    if (!holdsLonger) {
      circuits[providerKey] = { kind: PLAN_WINDOW_KIND, until: report.lockedUntil, updatedAt: now };
    }
  } else if (existing?.kind === PLAN_WINDOW_KIND) {
    delete circuits[providerKey];
  }
  return circuits;
};

export const __resetPlanUsageCacheForTests = () => cache.clear();
