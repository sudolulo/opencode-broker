// Durable forget retry scheduling is deliberately in a small injected controller so the
// plugin never needs to synchronously enumerate the pending-forgets directory.
const groupKey = (record) => JSON.stringify([record.sessionID, record.leaseID]);

export const createPendingForgetRetry = ({
  records, forget, remove, warn = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
  schedule = setImmediate, concurrency = 4, batchSize = 16,
} = {}) => {
  const workers = Math.max(1, Math.min(4, Math.floor(concurrency) || 4));
  const quantum = Math.max(1, Math.min(16, Math.floor(batchSize) || 16));
  let running = null;
  let timer = null;
  let failures = 0;
  let unattended = 0;
  let requested = false;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const arm = () => {
    if (timer !== null || unattended >= 8) return;
    const delay = Math.min(5000 * (2 ** Math.max(0, failures - 1)), 300000);
    timer = setTimer(() => {
      cancelTimer();
      unattended += 1;
      // The timer is not an external kick: it must spend, not replenish, the budget.
      // Returning the handled promise also makes deterministic timers awaitable.
      return run(false);
    }, delay);
    timer?.unref?.();
  };
  let attempts = 0, yielding = null;
  const permit = async () => {
    // All workers and immediate follow-up sweeps share this gate. Even immediately
    // resolved RPCs cannot start more than sixteen attempts between explicit yields.
    while (yielding || attempts >= quantum) {
      if (!yielding) yielding = new Promise((resolve) => schedule(resolve)).then(() => {
        attempts = 0;
        yielding = null;
      });
      await yielding;
    }
    attempts += 1;
  };
  const sweep = async () => {
    const groups = new Map();
    try {
      for await (const item of records()) {
        const key = groupKey(item);
        let group = groups.get(key);
        if (!group) {
          group = { completed: [], pending: [], completionIndex: 0, pendingIndex: 0, completionFailed: false, next: null };
          groups.set(key, group);
        }
        (item.completed ? group.completed : group.pending).push(item);
      }
    } catch {
      warn("could not list durable pending cleanup; keeping existing intent");
      return { nonempty: true, failed: true };
    }
    if (groups.size === 0) return { nonempty: false, failed: false };
    let failed = false;
    // An intrusive FIFO has O(1) dequeue/requeue, without shift(), repeated lookahead,
    // or retaining an ever-growing history of queue entries. Each visit does ONE RPC.
    // Materialized handles remain intentionally O(N), just like the compatibility list.
    let head = null, tail = null;
    const enqueue = (group) => {
      group.next = null;
      if (tail) tail.next = group;
      else head = group;
      tail = group;
    };
    for (const group of groups.values()) enqueue(group);
    await Promise.all(Array.from({ length: Math.min(workers, groups.size) }, async () => {
      while (head) {
        const group = head;
        head = group.next;
        if (!head) tail = null;
        await permit();
        const completing = group.completionIndex < group.completed.length;
        const item = completing ? group.completed[group.completionIndex++] : group.pending[group.pendingIndex++];
        let ok = false;
        try {
          await forget(item);
          ok = (await remove(item.sessionID, item)) === true;
        } catch {
          // The immutable intent, not an exception payload, is the retry authority.
        }
        if (!ok) {
          failed = true;
          if (completing) group.completionFailed = true;
          warn("pending broker forget or exact cleanup failed; retaining original intent");
        }
        // Requeue only after the RPC AND exact removal settle: one group never overlaps.
        // Failed completion blocks only its own false records, not other completions.
        if (group.completionIndex < group.completed.length ||
          (!group.completionFailed && group.pendingIndex < group.pending.length)) enqueue(group);
      }
    }));
    return { nonempty: true, failed };
  };
  const run = (external) => {
    if (running) return running;
    running = (async () => {
      let result;
      // Only an externally started run gets one immediate follow-up. Timer invocations
      // each mean exactly one unattended sweep, and a failure ALWAYS observes backoff.
      for (let pass = 0; pass < (external ? 2 : 1); pass++) {
        requested = false;
        result = await sweep();
        if (result.failed || !requested) break;
      }
      if (result.failed) {
        failures = Math.min(failures + 1, 7);
        arm();
      } else {
        failures = 0;
        if (requested) arm(); // Further kicks are deferred, not dropped or looped forever.
        else { unattended = 0; cancelTimer(); }
      }
    })().catch(() => {
      warn("pending cleanup retry failed; retaining original intent");
      failures = Math.min(failures + 1, 7);
      arm();
    }).finally(() => {
      running = null;
      // A kick can land after the last result was handled but before this promise's
      // finalizer. Preserve that request without reopening the immediate-sweep loop.
      if (requested) arm();
    });
    return running;
  };
  const kick = () => {
    unattended = 0;
    if (running) {
      requested = true;
      return running;
    }
    // Sustained chat must neither cancel the deadline nor reset failure backoff.
    if (timer !== null) return Promise.resolve();
    return run(true);
  };
  return { kick, state: () => ({ timer: Boolean(timer), failures, unattended }) };
};
