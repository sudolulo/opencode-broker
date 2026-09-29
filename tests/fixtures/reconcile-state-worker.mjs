// A separate process that drives the reconciliation ledger, because the lock's whole job is
// cross-process exclusion and an in-process test can never observe it: two stores inside one
// process would serialize on the event loop, not on the lock.
//
// Modes:
//   increment <root> <marker> <rounds>  -- performs <rounds> locked read-modify-write increments
//   hold      <root> <marker> <holdMs>  -- takes the lock, announces itself by writing <marker>,
//                                          then blocks <holdMs> while still holding it
import { writeFileSync } from "node:fs";

import { createReconciliationStore } from "../../lib/reconcile-state.js";

const [mode, root, marker, argument] = process.argv.slice(2);

// Synchronous on purpose: the hold mode must keep the lock while doing nothing else, and a
// timer would release control to code that could exit the process.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const bump = (state) => ({
  ...state,
  roles: {
    ...state.roles,
    "test:counter": {
      ...(state.roles["test:counter"] ?? {}),
      testCount: Number(state.roles["test:counter"]?.testCount ?? 0) + 1,
    },
  },
});

if (mode === "increment") {
  // A wait long enough that the contending worker never times out: this mode measures lost
  // updates, not lock impatience.
  const store = createReconciliationStore({ root, lockWaitMs: 30_000 });
  const rounds = Number(argument);
  for (let round = 0; round < rounds; round += 1) store.update(bump);
} else if (mode === "hold") {
  const store = createReconciliationStore({ root, lockWaitMs: 30_000 });
  store.update((state) => {
    // Written inside the critical section so the parent only contends once the lock is
    // genuinely held; a stdout handshake could be buffered past the release.
    writeFileSync(marker, `${process.pid}\n`);
    sleep(Number(argument));
    return state;
  });
} else {
  throw new Error(`unknown reconcile-state worker mode ${mode}`);
}
