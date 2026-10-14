import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { nextProbe, reduceOutages, reserveProbe } from './model-outages.js';
import { outageRoutingEnabled } from './outage-policy.js';

const POLL_INTERVAL = 60_000;

// This worker owns scheduling only. Every state transition is committed through the
// supplied serializer, while network I/O always happens after that transaction ends.
export function createOutageWorker({
  policy,
  now = Date.now,
  read,
  commit,
  fetchStatus,
  runProbe,
  canProbe,
  timers = globalThis,
  randomBytes = cryptoRandomBytes,
  serialize: sharedSerialize = null,
  onError = (error) => {
    const name = error?.name;
    const safeName = typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : 'unknown';
    process.stderr.write(`outage worker error: ${safeName}\n`);
  },
}) {
  const enabled = policy?.enabled === true;
  const active = outageRoutingEnabled(policy);
  let closed = false;
  let interval = null;
  let localTail = Promise.resolve();
  let hasPendingError = false;
  let pendingError = null;
  const jobs = new Set();
  const polling = new Set();
  const dispatching = new Set();
  const controllers = new Set();
  const timeouts = new Set();

  const localSerialize = (transaction) => {
    const result = localTail.then(transaction);
    localTail = result.catch(() => {});
    return result;
  };
  const serialize = sharedSerialize ?? localSerialize;

  function report(error) {
    if (!hasPendingError) {
      hasPendingError = true;
      pendingError = error;
    }
    try { onError(error); } catch (reportError) {
      if (!hasPendingError) {
        hasPendingError = true;
        pendingError = reportError;
      }
    }
  }

  function launch(operation) {
    const job = Promise.resolve().then(operation);
    jobs.add(job);
    job.then(
      () => jobs.delete(job),
      (error) => { jobs.delete(job); report(error); },
    );
    return job;
  }

  // `validate`, when supplied, runs synchronously inside the serialized transaction against the
  // image this commit will be reduced from; a throw refuses the event with no commit. It closes
  // the gap between an outside check (e.g. outcome acceptance) and the queued commit.
  async function mutate(event, validate = null) {
    if (!enabled) return;
    if (closed) throw new Error('outage worker closed');
    await serialize(async () => {
      if (closed) throw new Error('outage worker closed');
      const current = read();
      if (validate) validate(event, current);
      await commit(reduceOutages(current, event, { policy, now: now() }));
    });
  }

  async function dispatchDueProbe() {
    if (!active || closed) return;
    const reservation = await serialize(async () => {
      if (closed) return null;
      const at = now();
      const state = reduceOutages(read(), { type: 'tick' }, { policy, now: at });
      const candidate = nextProbe(state, policy, at);
      const providerID = candidate ? policy.expectedScopePolicies[candidate.logicalID]?.providerID : null;
      const reserved = candidate && providerID && !dispatching.has(providerID) && canProbe(candidate, state)
        ? reserveProbe(state, {
          ...candidate,
          id: randomBytes(16).toString('hex'),
          nonce: randomBytes(32).toString('base64url'),
          now: at,
        }, { policy })
        : null;
      // Tick and reservation state are durable before any probe is allowed to leave.
      await commit(reserved?.state ?? state);
      return reserved?.reservation ?? null;
    });
    if (!reservation || closed) return;

    dispatching.add(reservation.providerID);
    launch(async () => {
      if (closed) {
        dispatching.delete(reservation.providerID);
        return;
      }
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = timers.setTimeout(
        () => controller.abort(),
        Math.max(0, reservation.expiresAt - now()),
      );
      timeouts.add(timeout);
      try {
        const outcome = await runProbe(reservation, { signal: controller.signal });
        if (outcome && !closed) await mutate(outcome);
      } catch (error) {
        // Retain the primary failure before cleanup can fail independently.
        report(error);
      } finally {
        timers.clearTimeout(timeout);
        timeouts.delete(timeout);
        controllers.delete(controller);
        try {
          if (!closed) await mutate({ type: 'probe-finished', providerID: reservation.providerID, id: reservation.id });
        } catch (error) {
          report(error);
        } finally {
          // A failed durable clear must not strand this in-memory single-flight latch.
          dispatching.delete(reservation.providerID);
        }
      }
    });
  }

  function poll(providerID) {
    if (!active || closed || polling.has(providerID)) return;
    polling.add(providerID);
    launch(async () => {
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const allowed = await serialize(async () => {
          if (closed) return false;
          const state = read();
          const lastPollAt = state?.providers?.[providerID]?.lastPollAt;
          const at = now();
          if (lastPollAt !== null && lastPollAt !== undefined && (at < lastPollAt || at - lastPollAt < POLL_INTERVAL)) return false;
          await commit(reduceOutages(state, { type: 'poll-start', providerID }, { policy, now: at }));
          return true;
        });
        if (!allowed || closed) return;
        const snapshot = await fetchStatus(providerID, { signal: controller.signal });
        if (!closed) {
          await mutate(snapshot);
          // Snapshot completion may make pending auth evidence eligible; dispatch occurs
          // outside the snapshot transaction so the shared daemon queue cannot deadlock.
          await dispatchDueProbe();
        }
      } finally {
        controllers.delete(controller);
        polling.delete(providerID);
      }
    });
  }

  async function tick() {
    if (!active || closed) return;
    await dispatchDueProbe();
    poll('anthropic');
    poll('openai');
  }

  return {
    start() {
      if (!active || closed || interval !== null) return;
      interval = timers.setInterval(() => { launch(tick); }, POLL_INTERVAL);
      launch(tick);
    },
    tick,
    observe(event, { validate } = {}) {
      if (validate !== undefined && typeof validate !== 'function') return Promise.reject(new Error('outage observe validate'));
      if (!enabled) return Promise.resolve();
      return mutate(event, validate ?? null);
    },
    requestPoll(providerID) { poll(providerID); },
    async drain() {
      for (;;) {
        await serialize(async () => {});
        const pending = [...jobs];
        if (pending.length === 0) break;
        await Promise.allSettled(pending);
      }
      if (hasPendingError) {
        const error = pendingError;
        hasPendingError = false;
        pendingError = null;
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (interval !== null) timers.clearInterval(interval);
      interval = null;
      for (const controller of controllers) controller.abort();
      for (const timeout of timeouts) timers.clearTimeout(timeout);
      timeouts.clear();
      await Promise.allSettled([...jobs]);
      await serialize(async () => {});
    },
  };
}
