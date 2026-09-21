// The slot watch: says so when a local model is actually oversaturated, instead of trusting
// the arithmetic that says it cannot be.
//
// The broker caps what it leases on a shared model (`capacity`, `modelCapacity`), but it is
// rarely the only caller: a command classifier, a document extractor or any service pointed
// straight at the model server reaches it without a lease, and the broker never sees them.
// The one signal that counts EVERY caller is the server's own: llama.cpp's
// `llamacpp:requests_deferred` is the number of requests waiting because every slot is busy.
// Zero is the healthy state. A non-zero reading in `deferredSamples` consecutive polls means
// requests are queueing, not merely that one arrived at a busy moment, and that is worth
// telling a person about. Notify only: the fix for a saturated model is a routing or capacity
// decision, not something a watcher should improvise.

export const SLOT_DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  deferredSamples: 2,
  notifyCooldownMs: 30 * 60_000,
});

// llama.cpp's Prometheus text: `llamacpp:<name> <value>` lines. Anything missing reads null.
export const parseLlamaMetrics = (text) => {
  const read = (name) => {
    const match = new RegExp(`^llamacpp:${name}\\s+([0-9.eE+-]+)\\s*$`, "m").exec(String(text ?? ""));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  return { processing: read("requests_processing"), deferred: read("requests_deferred") };
};

export const createSlotWatch = ({ config = SLOT_DEFAULTS, now = () => Date.now() } = {}) => {
  const c = { ...SLOT_DEFAULTS, ...config };
  const streaks = new Map(); // modelID -> consecutive samples with deferred > 0
  const alerted = new Map(); // modelID -> at

  // One poll of one model. Returns the notifications to send (at most one).
  const record = ({ modelID, processing, deferred, at = now() }) => {
    if (!(Number(deferred) > 0)) {
      streaks.delete(modelID);
      return [];
    }
    const streak = (streaks.get(modelID) ?? 0) + 1;
    streaks.set(modelID, streak);
    if (streak < c.deferredSamples) return [];
    const last = alerted.get(modelID);
    if (last !== undefined && at - last < c.notifyCooldownMs) return [];
    alerted.set(modelID, at);
    const minutes = Math.max(1, Math.round((streak * c.intervalMs) / 60_000));
    return [{
      kind: "slot-deferred",
      title: `Slot watch: ${modelID} is oversaturated`,
      body: `${deferred} request(s) waiting for a slot with ${processing ?? "?"} processing, for ${minutes} min or more. Every slot is busy: callers are queueing inside the model server.`,
    }];
  };

  return { record };
};
