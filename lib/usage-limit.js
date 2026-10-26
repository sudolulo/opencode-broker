// One wording for "you hit a usage limit", shared by the broker's lease refusal, the gateway's
// upstream-429 reply and the router's toast, so every place a user can meet it says the same
// thing: WHICH provider, WHICH limit, and WHEN it comes back -- the day as well as the time,
// because a weekly limit returns days out and "03:38" alone reads as later today.
// Times render in UTC (the hosts' zone) plus a relative "in 4d 23h", which is right in any zone.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (value) => String(value).padStart(2, "0");

const relative = (ms) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

// "Wed Oct 14 03:38 UTC (in 4d 23h)"
export const formatReturn = (at, now = Date.now()) => {
  const when = new Date(Number(at));
  if (!Number.isFinite(when.getTime())) return null;
  const stamp = `${WEEKDAYS[when.getUTCDay()]} ${MONTHS[when.getUTCMonth()]} ${when.getUTCDate()} ` +
    `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())} UTC`;
  return when.getTime() > now ? `${stamp} (in ${relative(when.getTime() - now)})` : stamp;
};

// The sidebar's compact form, on the same UTC clock as formatReturn: "Wed 03:38". The weekday is
// the point -- a weekly limit's "03:38" alone reads as later today. A week or more out, the
// weekday repeats, so the date replaces it: "Oct 20 03:38".
export const formatReturnShort = (at, now = Date.now()) => {
  const when = new Date(Number(at));
  if (!Number.isFinite(when.getTime())) return null;
  const time = `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`;
  return when.getTime() - now >= 6.5 * 24 * 3_600_000
    ? `${MONTHS[when.getUTCMonth()]} ${when.getUTCDate()} ${time}`
    : `${WEEKDAYS[when.getUTCDay()]} ${time}`;
};

const LIMIT_NAMES = { "5h": "5-hour limit", wk: "weekly limit", week: "weekly limit", mo: "monthly limit", month: "monthly limit" };

// The plan window a lock belongs to: the full window whose reset matches (or is nearest).
const limitName = (plan, until) => {
  const windows = (Array.isArray(plan?.windows) ? plan.windows : [])
    .filter((window) => Number(window?.percent) >= 100 && !String(window?.id ?? "").includes(":"));
  const match = windows.find((window) => Date.parse(window?.resetsAt ?? "") === Number(until)) ?? windows[0];
  return match ? (LIMIT_NAMES[match.id] ?? `${match.id} limit`) : null;
};

// One provider's line: "anthropic 5-hour limit, back Fri Oct 9 08:20 UTC (in 4h 58m)".
export const describeProviderLimit = ({ providerID, limit = null, until = null, lapsed = false }, now = Date.now()) => {
  if (lapsed) return `${providerID} plan has lapsed, back when it is renewed`;
  const back = until ? formatReturn(until, now) : null;
  return `${providerID} ${limit ?? "usage limit"}${back ? `, back ${back}` : ", return time not reported"}`;
};

// The whole message. Starts with the fact the user needs; callers append their own context.
export const usageLimitMessage = (limits, now = Date.now()) =>
  `usage limit reached -- ${limits.map((entry) => describeProviderLimit(entry, now)).join("; ")}`;

// Which of `providerIDs` are held out by a USAGE stop right now, from broker state: a provider
// circuit of kind plan-window or quota, named from the provider's own plan reading when it has one.
export const activeUsageLimits = (circuits, providerIDs, planFor, now = Date.now()) => {
  const limits = [];
  for (const providerID of providerIDs) {
    const circuit = circuits?.[`provider:${providerID}`];
    if (!circuit || !["plan-window", "quota"].includes(circuit.kind)) continue;
    const until = circuit.until === null ? null : Number(circuit.until);
    if (until !== null && !(until > now)) continue;
    if (circuit.reason === "plan-lapsed") {
      limits.push({ providerID, lapsed: true, until: null });
      continue;
    }
    // A quota circuit whose end is only the broker's next probe (resetKnown: false) has no
    // return date to give; saying the probe time would promise a return that is not coming.
    const known = circuit.kind === "plan-window" || circuit.resetKnown !== false;
    limits.push({ providerID, limit: limitName(planFor(providerID), until), until: known ? until : null });
  }
  return limits.sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity));
};

// ---- Wrap-up before the limit ------------------------------------------------------------
// When every cloud provider a session's lane can use is about to run out, and no local model
// can take over, a session that just keeps going is cut off mid-step with nothing written down.
// Failover cannot help -- there is nowhere to fail over to -- so the router asks each working
// session to finish or checkpoint its step and write a handoff while there is still budget.
// "Very very close": a plan-wide window at 97% by default (OPENCODE_BROKER_WRAP_UP_PERCENT).
const configuredPercent = Number(process.env.OPENCODE_BROKER_WRAP_UP_PERCENT);
export const WRAP_UP_PERCENT = Number.isFinite(configuredPercent) && configuredPercent > 0 && configuredPercent <= 100
  ? configuredPercent : 97;

// The tightest plan-wide window of one provider's reading (model-scoped ones excluded).
const tightestWindow = (plan) => (Array.isArray(plan?.windows) ? plan.windows : [])
  .filter((window) => Number.isFinite(Number(window?.percent)) && !String(window?.id ?? "").includes(":"))
  .reduce((top, window) => (Number(window.percent) > Number(top?.percent ?? -1) ? window : top), null);

// The headroom of a lane: per cloud provider, whether it is held out right now or how full its
// tightest window is, and whether that leaves the lane nearly out. A provider with no reading and
// no hold counts as having room -- an unknown is never a reason to stop a session.
export const laneHeadroom = ({ providerIDs, circuits, planFor, freshPlanFor = null, localFits, now = Date.now(), threshold = WRAP_UP_PERCENT }) => {
  const providers = providerIDs.map((providerID) => {
    const circuit = circuits?.[`provider:${providerID}`];
    const held = Boolean(circuit && (circuit.until === null || Number(circuit.until) > now));
    const plan = planFor(providerID);
    const window = tightestWindow(plan);
    const finitePercent = (value) => {
      if (value == null || typeof value === "boolean" || typeof value === "object") return null;
      if (typeof value === "string" && !value.trim()) return null;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };
    const weeklyWindow = (Array.isArray(plan?.windows) ? plan.windows : []).reduce((best, item) => {
      if (!["wk", "week", "weekly", "7d", "168h"].includes(item?.id)) return best;
      const percent = finitePercent(item?.percent);
      if (percent === null) return best;
      return !best || percent > best.percent ? { item, percent } : best;
    }, null);
    const timestamp = (raw) => {
      if (typeof raw !== "number" && typeof raw !== "string") return null;
      if (typeof raw === "string" && !raw.trim()) return null;
      const value = typeof raw === "number" ? raw : Date.parse(raw);
      return Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : null;
    };
    const fetchedAt = timestamp(plan?.fetchedAt);
    const weekly = weeklyWindow ? {
      window: weeklyWindow.item.id, percent: Math.max(0, Math.min(100, weeklyWindow.percent)),
      resetsAt: timestamp(weeklyWindow.item.resetsAt), fetchedAt,
      source: fetchedAt === null ? "unknown" : freshPlanFor?.(providerID) ? "last-fetch" : "cached",
    } : null;
    const percent = window ? Number(window.percent) : null;
    const resetsAt = held && circuit.until !== null && circuit.resetKnown !== false && circuit.kind !== "connect"
      ? Number(circuit.until)
      : (Date.parse(window?.resetsAt ?? "") || null);
    return {
      providerID, held, percent, window: window?.id ?? null, resetsAt,
      room: !held && (percent === null || percent < threshold), weekly,
    };
  });
  const nearlyOut = providers.length > 0 && !localFits && providers.every((provider) => !provider.room);
  return { threshold, providers, localFits, nearlyOut };
};

const WINDOW_WORDS = { "5h": "5-hour window", wk: "weekly window", week: "weekly window", mo: "monthly window", month: "monthly window" };

export const primaryQuotaStage = (headroom, providerID) => {
  const p = headroom?.providers?.find((item) => item.providerID === providerID)?.weekly?.percent;
  if (typeof p !== "number" || !Number.isFinite(p)) return null;
  return p >= 95 ? "bounded" : p >= 85 ? "checkpoint" : p >= 75 ? "prepare" : null;
};

// What the session is told. A main session writes the handoff; a subagent returns what it has.
export const wrapUpMessage = ({ providers, nearlyOut }, { subagent = false, now = Date.now(), sessionID, providerID, stage = null } = {}) => {
  const state = providers.map((provider) => {
    const at = provider.resetsAt ? `, back ${formatReturn(provider.resetsAt, now)}` : "";
    if (provider.held) return `${provider.providerID} is already out${at}`;
    return `${provider.providerID} ${WINDOW_WORDS[provider.window] ?? provider.window ?? "plan"} at ${provider.percent}%${at}`;
  }).join("; ");
  const selected = providers.find((item) => item.providerID === providerID);
  // Weekly evidence is reported only alongside a real weekly stage (>= 75%). A lane-only warning
  // (stage null) must not print a null stage or imply weekly policy for a sub-75 reading.
  const weekly = stage ? selected?.weekly ?? null : null;
  const head = nearlyOut === true
    ? `[opencode-broker] Usage is about to run out and nothing else can take over: ${state}.`
    : subagent
      ? "[opencode-broker] Usage caution."
      : !selected || !weekly
        ? "[opencode-broker] Quota checkpoint."
        : `[opencode-broker] ${providerID} weekly quota ${stage}: ${weekly.percent}%.`;
  const path = typeof sessionID === "string" && /^[a-zA-Z0-9_-]+$/.test(sessionID)
    ? `~/.local/share/opencode/handoffs/${sessionID}.md`
    : "the handoff path under ~/.local/share/opencode/handoffs/ after obtaining and validating your actual session ID";
  const needsCheckpoint = stage === "checkpoint" || stage === "bounded" || nearlyOut === true;
  const needsBoundedWork = stage === "bounded" || nearlyOut === true;
  return subagent
    ? `${head} Wrap up now: finish or checkpoint your current step, start nothing new, and return what you have to your parent -- what is done, what is not, and the exact next step.`
    : [
      head,
      weekly && (() => {
        const fetchedAt = typeof weekly.fetchedAt === "number" && Number.isFinite(weekly.fetchedAt) && Number.isFinite(new Date(weekly.fetchedAt).getTime())
          ? formatReturn(weekly.fetchedAt, now)
          : null;
        const source = !fetchedAt
          ? `source ${weekly.source ?? "unknown"}; fetch time unknown; freshness unknown`
          : weekly.source === "last-fetch"
            ? `source last-fetch; last successful fetch ${fetchedAt}; freshness unverified`
            : weekly.source === "cached"
              ? `source cached; fetched ${fetchedAt}; freshness unverified`
              : `source unknown; fetched ${fetchedAt}; freshness unverified`;
        return `Weekly usage: ${selected.providerID} weekly quota ${stage}, ${weekly.percent}% (${source}).`;
      })(),
      `Write or update a durable handoff now at ${path} and at stage boundaries.`,
      "Create a private directory (0700) and document (0600); validate the session ID, do not follow unexpected symlinks or overwrite another owner's file.",
      "Include purpose and authorization, decisions, repository/branch/HEAD and dirty paths with ownership, exact paths and commands, completed work and actual test evidence including tests not run, pending/background jobs and cleanup obligations, remaining work and next safe action.",
      "Include a copy-pasteable resume command verified against installed CLI help and the correct working directory and session; if unverifiable, record the missing verification rather than inventing it.",
      "Exclude secrets, credentials, raw transcripts and unnecessary PII.",
      needsCheckpoint && "Before every mutating unit, update the handoff and establish a safe resumable stopping state for a pause of hours or days.",
      needsBoundedWork && "Start only safe, reversible, bounded mutating units; do not start deployments, migrations, irreversible changes or unattended dangerous phases that could remain unfinished.",
      "If the handoff write fails, report the failure explicitly, do not begin the unit depending on it, and continue safe nonmutating work.",
      "Continue useful safe authorized work until actual exhaustion: 100% or a genuine provider limit.",
    ].filter(Boolean).join("\n");
};
