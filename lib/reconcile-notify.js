// The ntfy projection: one notification per reconciliation transition, and never a second one for
// the same transition.
//
// This module PRESENTS durable state. It reads the ledger, pushes through the deployment's notifier,
// and writes nothing but delivery markers -- it never sets a record's `state`, never decides
// anything, and a notifier that is down cannot roll a transition back. That separation is the point:
// the ledger is the record of what happened, and this is the record of what was announced.
//
// Three properties shape everything below.
//
//   1. THE MARKER IS THE IDEMPOTENCE. Each event is keyed by its name plus the record's
//      transitionID and the timestamp of the thing being announced, so a rerun over unchanged state
//      pushes nothing while a genuinely new transition always pushes. Task 4's rule that
//      mergeObservation() leaves `stateChangedAt` alone on an unchanged advanced record is what
//      makes that true; without it every scheduled run would re-announce every open proposal.
//
//   2. `superseded` IS KEYED ON THE STAMP, NOT ON THE STATE. A retired unknown record sits at
//      `superseded`, but a role record whose candidate was replaced is already back at
//      `evidence-pending` with a fresh `stateChangedAt`. A state-derived rule would announce the
//      first case and silently drop the second, and a proposal retired from under an operator who
//      was asked to approve it is exactly what must not be silent -- with the Gitea publisher
//      shipping disabled, this push may be the only signal. So the event hangs off
//      `record.supersededAt`, which supersession stamps on the record itself and nothing else
//      moves.
//
//   3. `proposal-opened` IS STRUCTURALLY GATED ON GITEA. It carries the issue link a human is meant
//      to follow, so an awaiting-approval record with no issue produces nothing rather than a push
//      with nothing actionable in it. Enabling ntfy without Gitea would therefore drop proposal
//      alerts entirely: Package 4 must enable the two projections together.
//
// IDEMPOTENCE IS SCOPED TO COMPLETED RUNS. A crash between the notifier exiting 0 and the marker
// being persisted can push one duplicate on restart. Closing that window needs an ntfy idempotency
// key, which this package does not have; the blast radius is one extra push.
//
// The notifier is argv run WITHOUT a shell, built by lib/notify.js, so one notifier script serves
// the model watch, the burn watch and this projection. An empty command means the deployment
// configured none: that is a clean skip, not a crash.
import { spawnSync } from "node:child_process";

import { CONFIG } from "./config.js";
import { notifyArgv } from "./notify.js";

// The complete set of announced events. Nothing else is pushed, and an unknown event name is a
// programming error rather than a silently dropped notification.
export const NOTIFY_EVENTS = Object.freeze([
  "proposal-opened",
  "auto-eligible",
  "decision-applied",
  "blocked",
  "superseded",
]);

// Five attempts, then the marker is failed and left visible through notificationHealth(). Retrying
// forever would mean every scheduled run spending a subprocess on a notifier that is not coming
// back, and dropping it after one would lose an event to a single restart of the push service.
export const NOTIFY_MAX_ATTEMPTS = 5;

// The kind every notification carries, so a notifier script can route reconciliation events
// separately from the model watch and the burn watch.
export const NOTIFY_KIND = "model-reconcile";

// Thirty seconds, matching the other notify call sites. A notifier that hangs would otherwise hold
// the whole projection, and the next scheduled run would pile up behind it.
export const NOTIFY_TIMEOUT_MS = 30_000;

// A block on a source or a rollback is announced as one event: an operator needs to know the
// reconciler has stopped making progress, not which of the three source checks tripped -- the
// record's `reason` carries that, and it is in the body.
const BLOCKED_STATES = Object.freeze(["blocked-stale", "blocked-conflict", "blocked-unresolvable", "rolled-back"]);

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const candidateModelIDOf = (record) => record?.candidateModelID ?? record?.modelID ?? null;

const issueURLOf = (record) => {
  const url = record?.issue?.url ?? record?.supersededIssue?.url ?? null;
  return typeof url === "string" && url ? url : null;
};

const hasOpenIssue = (record) => Number.isInteger(record?.issue?.number) && record.issue.number > 0;

// ---- which events a record owes ------------------------------------------------------------------

// The event the record's CURRENT state asks for, or null when the state announces nothing.
// `evidence-pending` is deliberately silent: it is the resting state of a candidate nobody has to
// look at yet, and announcing it would push once per newly discovered model.
const stateEvent = (record) => {
  const state = record?.state;
  if (state === "awaiting-approval") return hasOpenIssue(record) ? "proposal-opened" : null;
  if (state === "auto-eligible") return "auto-eligible";
  if (state === "approved" || state === "rejected") return "decision-applied";
  if (BLOCKED_STATES.includes(state)) return "blocked";
  return null;
};

// Supersession first: it happened before whatever the record's current state is, and a stable order
// keeps a run's output reproducible.
const recordEvents = (record) => {
  const events = [];
  if (Number.isFinite(record?.supersededAt)) events.push("superseded");
  const current = stateEvent(record);
  if (current) events.push(current);
  return events;
};

// The identity of ONE announcement. The event name, the record's transition, and the timestamp of
// the thing being announced -- the supersession stamp for `superseded`, the state change for
// everything else. A rerun that changes none of the three reproduces the marker exactly and pushes
// nothing; a new transition produces a new marker and pushes.
export const deliveryMarker = (record, event) => {
  if (!NOTIFY_EVENTS.includes(event)) {
    throw new Error(`${String(event)} is not a model reconciliation notify event`);
  }
  const at = event === "superseded" ? record?.supersededAt : record?.stateChangedAt;
  return [event, String(record?.transitionID ?? ""), String(Number.isFinite(at) ? at : 0)].join("|");
};

// ---- markers -------------------------------------------------------------------------------------

// A marker is `{ at, attempts, lastError, firstAttemptAt }`. `at` is the delivery timestamp and is
// null until the notifier has actually exited 0, so a marker can never look delivered because an
// attempt was made.
const markerStatus = (entry) => {
  if (!isPlainObject(entry)) return "pending";
  if (Number.isFinite(entry.at)) return "delivered";
  const attempts = Number.isInteger(entry.attempts) && entry.attempts > 0 ? entry.attempts : 0;
  return attempts >= NOTIFY_MAX_ATTEMPTS ? "failed" : "pending";
};

const markerOf = (record, marker) => (isPlainObject(record?.notified) ? record.notified[marker] : undefined);

const attemptsOf = (entry) => (isPlainObject(entry) && Number.isInteger(entry.attempts) && entry.attempts > 0
  ? entry.attempts
  : 0);

// ---- the message ---------------------------------------------------------------------------------

const notificationTitle = (record, event) =>
  `model reconciliation ${event}: ${record.providerID}/${candidateModelIDOf(record)}`;

const notificationBody = (record, event, { roles } = {}) => {
  const registry = isPlainObject(roles) ? roles : {};
  const roleKey = typeof record.roleKey === "string" && record.roleKey ? record.roleKey : null;
  const role = roleKey ? registry[roleKey] : null;
  const issueURL = issueURLOf(record);
  return [
    `${event}: ${record.providerID}/${candidateModelIDOf(record)}`,
    roleKey
      ? `role: ${roleKey}${role?.tiers ? ` (registry tiers: ${[...role.tiers].join(", ")})` : ""}`
      : "role: none -- this candidate is not mapped to a known role",
    `state: ${record.state}${record.reason ? ` -- ${record.reason}` : ""}`,
    ...(event === "superseded"
      ? ["this proposal was retired without a decision; nothing was applied"]
      : []),
    // Only when there is one: a push naming an issue that does not exist is worse than one that
    // names none, and `proposal-opened` is the event that guarantees it.
    ...(issueURL ? [`issue: ${issueURL}`] : []),
    `proposal: ${record.transitionID}`,
  ].join("\n");
};

// ---- the queue -----------------------------------------------------------------------------------

const allRecords = (state) => [
  ...Object.entries(state?.roles ?? {}).map(([key, record]) => ({ kind: "role", key, record })),
  ...Object.entries(state?.unknown ?? {}).map(([key, record]) => ({ kind: "unknown", key, record })),
].sort((left, right) => compareText(left.kind, right.kind) || compareText(left.key, right.key));

// Every announcement the ledger owes right now, in a deterministic order. Pure: it reads no clock,
// spawns nothing, and writes nothing.
export const pendingNotifications = (state, { roles = CONFIG.modelRoles } = {}) => {
  const queue = [];
  for (const { kind, key, record } of allRecords(state)) {
    if (!isPlainObject(record)) continue;
    for (const event of recordEvents(record)) {
      const marker = deliveryMarker(record, event);
      const entry = markerOf(record, marker);
      if (markerStatus(entry) !== "pending") continue;
      queue.push(Object.freeze({
        kind,
        key,
        event,
        marker,
        attempts: attemptsOf(entry),
        title: notificationTitle(record, event),
        body: notificationBody(record, event, { roles }),
      }));
    }
  }
  return Object.freeze(queue);
};

// What an operator needs to see about the projection itself: pushes still being retried, pushes
// that hit the cap and were given up on, and how long the oldest unfinished one has been stuck.
export const notificationHealth = (state) => {
  let pending = 0;
  let failed = 0;
  let oldestPendingAt = null;
  for (const { record } of allRecords(state)) {
    const notified = isPlainObject(record?.notified) ? record.notified : {};
    for (const entry of Object.values(notified)) {
      const status = markerStatus(entry);
      if (status === "delivered") continue;
      if (status === "failed") { failed += 1; continue; }
      pending += 1;
      const at = isPlainObject(entry) && Number.isFinite(entry.firstAttemptAt) ? entry.firstAttemptAt : null;
      if (at !== null && (oldestPendingAt === null || at < oldestPendingAt)) oldestPendingAt = at;
    }
  }
  return { pending, failed, oldestPendingAt };
};

// ---- delivery ------------------------------------------------------------------------------------

const failureMessage = (error) => {
  const message = String(error?.message ?? error ?? "unknown error").trim();
  return message === "" ? "unknown error" : message;
};

// spawnSync reports a timeout, an ENOENT and a kill as `error`/`signal` with a null status, so both
// are checked before the exit code rather than after it. Returns null on success, else the text.
const deliveryFailure = (outcome) => {
  if (!isPlainObject(outcome)) return "the notify command produced no result";
  if (outcome.error) return failureMessage(outcome.error);
  if (outcome.signal) return `the notify command was killed by ${outcome.signal}`;
  if (outcome.status === 0) return null;
  const stderr = String(outcome.stderr ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  return `the notify command exited ${String(outcome.status)}${stderr ? `: ${stderr}` : ""}`;
};

const spawnNotifier = (argv) => spawnSync(argv[0], argv.slice(1), {
  encoding: "utf8",
  timeout: NOTIFY_TIMEOUT_MS,
  // stdin closed and stdout discarded: the notifier is not interactive and its chatter is not this
  // module's output. stderr is kept because it is what a failure reason is built from.
  stdio: ["ignore", "ignore", "pipe"],
});

const mapField = (kind) => (kind === "unknown" ? "unknown" : "roles");

// The ONE ledger write in this module, and the only shape of it: a marker on one record, inside
// store.update()'s lock, touching nothing else. `notified` is initialised to null by Package 1, so
// it is converted to an object here rather than indexed.
const writeMarker = (store, { kind, key, marker }, { at, error }) => {
  const field = mapField(kind);
  store.update((state) => {
    const current = state[field]?.[key];
    if (!current) return state;
    const notified = isPlainObject(current.notified) ? current.notified : {};
    const previous = notified[marker];
    return {
      ...state,
      [field]: {
        ...state[field],
        [key]: {
          ...current,
          notified: {
            ...notified,
            [marker]: {
              at: error === null ? at : null,
              attempts: attemptsOf(previous) + 1,
              lastError: error,
              firstAttemptAt: isPlainObject(previous) && Number.isFinite(previous.firstAttemptAt)
                ? previous.firstAttemptAt
                : at,
            },
          },
        },
      },
    };
  });
};

export const deliverNotifications = ({
  store,
  roles = CONFIG.modelRoles,
  run = spawnNotifier,
  now = Date.now,
  notifyCommand = CONFIG.reconcile.notifyCommand,
} = {}) => {
  if (!store || typeof store.update !== "function" || typeof store.read !== "function") {
    throw new Error("delivering notifications needs a reconciliation store");
  }
  const result = { delivered: [], failed: [], pending: [], skipped: null };

  const command = (Array.isArray(notifyCommand) ? notifyCommand : []).map(String);
  // No notifier configured is the DEFAULT, and it must cost nothing: no subprocess, no ledger
  // write, and no error. A fresh install performs no external write at all.
  if (!command.length) {
    result.skipped = "no-notify-command";
    return result;
  }

  for (const notification of pendingNotifications(store.read(), { roles })) {
    const argv = notifyArgv(command, {
      title: notification.title,
      body: notification.body,
      kind: NOTIFY_KIND,
    });
    let error;
    try {
      error = deliveryFailure(run(argv));
    } catch (thrown) {
      // A notifier that cannot even be spawned is a failed attempt like any other: it counts
      // against the cap and the event is retried, rather than taking the projection down with it.
      error = failureMessage(thrown);
    }

    const at = now();
    writeMarker(store, notification, { at, error });

    const entry = { kind: notification.kind, key: notification.key, event: notification.event };
    if (error === null) {
      result.delivered.push(entry);
      continue;
    }
    // The attempt that reached the cap is reported as failed, not as pending: nothing will retry
    // it, and a caller that logged it as pending would imply it is still in flight.
    if (notification.attempts + 1 >= NOTIFY_MAX_ATTEMPTS) result.failed.push({ ...entry, error });
    else result.pending.push({ ...entry, error });
  }

  return result;
};
