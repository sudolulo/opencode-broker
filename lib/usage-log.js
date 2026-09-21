// The usage log: how big every provider request actually was, kept by the broker because
// nothing else keeps it.
//
// Tuning a local model's window (`context`, the server's slot count, `outputReserve`) needs the
// real distribution of prompt sizes, per request and per session. opencode's own database is a
// poor source: subagent and workflow child sessions are routinely deleted when their work is
// done, which takes their token history with them, so what survives is a small, biased sample.
// The lease-time `contextTokens` in decisions.jsonl is not it either: a lease records a
// session's size when its turn STARTS, and a subagent's single long turn grows far past that.
// Every opencode process (and the gateway) already reports each request's tokens on /usage, so
// the broker appends one line per request here. `opencode-broker usage` summarises it.

// Who sent a gateway request: the client's address and the model name it asked for. Anything
// that does not look like an address or a short name is dropped, never logged raw.
export const sanitizeCaller = (caller) => {
  if (!caller || typeof caller !== "object") return null;
  const address = typeof caller.address === "string" && /^[0-9A-Fa-f:.]{1,64}$/.test(caller.address) ? caller.address : null;
  const model = typeof caller.model === "string" && /^[\x20-\x7e]{1,100}$/.test(caller.model) ? caller.model : null;
  return address || model ? { address, model } : null;
};

// One compact line per request. `prompt` is everything the model read: fresh input, cache
// reads and cache writes together, which is the size that has to fit the window.
export const usageRecord = ({ at, sessionID, providerID, modelID, lease, tokens, local, caller = null }) => {
  const n = (value) => Math.max(0, Math.round(Number(value) || 0));
  return {
    at,
    sessionID: sessionID ?? null,
    providerID,
    modelID: modelID ?? null,
    targetID: lease?.targetID ?? null,
    profile: lease?.profile ?? null,
    tier: lease?.tier ?? null,
    prompt: n(tokens?.input) + n(tokens?.cacheRead) + n(tokens?.cacheWrite),
    output: n(tokens?.output),
    local: Boolean(local),
    ...(caller ? { caller } : {}),
  };
};

// "address model" for a gateway caller, "opencode" for a routed session, else "unknown".
const callerLabel = (record) => record.caller
  ? `${record.caller.address ?? "?"} ${record.caller.model ?? "?"}`
  : String(record.sessionID ?? "").startsWith("ses") ? "opencode" : "unknown";

const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), p99: quantile(sorted, 0.99), max: sorted.at(-1) ?? 0 };
};

// Per model: request sizes, each session's PEAK (the number a slot has to hold), and, for
// every local target naming the model, how many session peaks fit what it routes.
// `ceilingOf(target)` is the largest prompt the broker will lease onto that target.
export const summarizeUsage = (records, { since = 0, targets = {}, ceilingOf = () => null } = {}) => {
  const byModel = new Map();
  for (const record of records) {
    if (!record || record.at < since || !record.modelID) continue;
    const key = `${record.providerID}/${record.modelID}`;
    let entry = byModel.get(key);
    if (!entry) {
      entry = { key, providerID: record.providerID, modelID: record.modelID, local: record.local, prompts: [], peaks: new Map(), outputs: [], callers: new Map() };
      byModel.set(key, entry);
    }
    const label = callerLabel(record);
    entry.callers.set(label, (entry.callers.get(label) ?? 0) + 1);
    entry.prompts.push(record.prompt);
    entry.outputs.push(record.output);
    const session = record.sessionID ?? `anon-${entry.prompts.length}`;
    entry.peaks.set(session, Math.max(entry.peaks.get(session) ?? 0, record.prompt));
  }
  return [...byModel.values()]
    .map((entry) => {
      const peaks = [...entry.peaks.values()];
      const windows = Object.values(targets)
        .filter((target) => target?.kind === "local" && target.providerID === entry.providerID && target.modelID === entry.modelID)
        .map((target) => ({ targetID: target.id, ceiling: ceilingOf(target) }))
        .filter((window) => Number(window.ceiling) > 0)
        .map((window) => ({ ...window, sessionsFit: peaks.filter((peak) => peak <= window.ceiling).length }));
      return {
        model: entry.key,
        local: entry.local,
        requests: stats(entry.prompts),
        sessionPeaks: stats(peaks),
        output: stats(entry.outputs),
        callers: [...entry.callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([caller, requests]) => ({ caller, requests })),
        windows,
      };
    })
    .sort((a, b) => (Number(b.local) - Number(a.local)) || (b.requests.count - a.requests.count));
};
