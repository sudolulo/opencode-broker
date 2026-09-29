import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const tempRoot = (prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

// The DEFAULT notify command is part of what these tests cover: deliverNotifications() falls back
// to CONFIG.reconcile.notifyCommand, which in turn falls back to watch.notifyCommand, and a test
// that passed the command explicitly everywhere would leave that wiring unexercised. lib/config.js
// reads its file once at import time, so the config has to exist before the module graph loads --
// which a written temp file plus a dynamic import is the only way to order.
const NOTIFY_COMMAND = ["/usr/local/bin/fleet-notify", "--kind={kind}", "{title}", "{body}"];
const CONFIG_PATH = join(tempRoot("reconcile-notify-config-"), "config.json");
writeFileSync(CONFIG_PATH, JSON.stringify({ watch: { notifyCommand: NOTIFY_COMMAND } }) + "\n");
process.env.OPENCODE_BROKER_CONFIG = CONFIG_PATH;

const {
  NOTIFY_EVENTS,
  NOTIFY_MAX_ATTEMPTS,
  deliverNotifications,
  deliveryMarker,
  notificationHealth,
  pendingNotifications,
} = await import(new URL("../lib/reconcile-notify.js", import.meta.url).href);

const { createReconciliationStore, emptyReconciliationState } =
  await import(new URL("../lib/reconcile-state.js", import.meta.url).href);

const HOUR = 3600_000;
const NOW = Date.parse("2026-09-29T00:00:00Z");
const ROLE_KEY = "openai:gpt-sol";
const ROLE_TRANSITION = "aaaaaaaaaaaaaaaaaaaaaaaa";
const UNKNOWN_TRANSITION = "bbbbbbbbbbbbbbbbbbbbbbbb";
const ISSUE_NUMBER = 41;
const ISSUE_URL = `https://git.arch.fyi/opencode/opencode-broker/issues/${ISSUE_NUMBER}`;

// Hand-written rather than taken from the product registry: these tests are about what the
// projection does with a role, not about which roles ship by default.
const TEST_ROLES = Object.freeze({
  "openai:gpt-sol": Object.freeze({
    providerID: "openai",
    roleID: "gpt-sol",
    tiers: Object.freeze(["smart"]),
    evidenceDomains: Object.freeze(["openai.com", "developers.openai.com"]),
  }),
});

// ---- record fixtures ---------------------------------------------------------------------------
//
// Factories, called inside the test that needs them: these tests write delivery markers into the
// records, and node:test runs them in order, so a shared binding would leak a delivered marker
// into the next test.

const issuePointer = () => ({
  number: ISSUE_NUMBER,
  url: ISSUE_URL,
  revision: "c".repeat(24),
  createdAt: NOW - HOUR,
  commentedAt: null,
  reopenedAt: null,
  refusedAt: null,
  closedAt: null,
});

const roleRecord = (overrides = {}) => ({
  transitionID: ROLE_TRANSITION,
  roleKey: ROLE_KEY,
  providerID: "openai",
  roleID: "gpt-sol",
  candidateModelID: "gpt-6-sol",
  candidateFamily: "gpt-sol",
  candidateReleaseDate: "2026-09-22",
  candidateVersion: "6",
  incumbentModelID: "gpt-5.6-sol",
  proposedTiers: ["smart"],
  proposedFit: {},
  state: "auto-eligible",
  reason: "official successor claim for gpt-6-sol",
  stateChangedAt: NOW - HOUR,
  lastObservedAt: NOW - HOUR,
  transitions: ["discovered", "evidence-pending", "auto-eligible"],
  evidence: [],
  evidenceRevision: null,
  evidenceCollectedAt: null,
  evidenceContradiction: false,
  supersededAt: null,
  approval: null,
  issue: null,
  supersededIssue: null,
  // Package 1 initialises this to null, so every fixture starts there: a projection that indexed
  // it without converting it first would throw on the very first delivery.
  notified: null,
  ...overrides,
});

const unknownRecord = (overrides = {}) => ({
  transitionID: UNKNOWN_TRANSITION,
  groupKey: "openai:gpt-orbit",
  providerID: "openai",
  modelID: "gpt-6-orbit",
  family: "gpt-orbit",
  roleStatus: "unknown",
  roleMatches: [],
  releaseDate: "2026-09-20",
  version: null,
  state: "awaiting-approval",
  reason: "the candidate is not mapped to a known role",
  stateChangedAt: NOW - HOUR,
  lastObservedAt: NOW - HOUR,
  transitions: ["discovered", "evidence-pending", "awaiting-approval"],
  evidence: [],
  evidenceRevision: null,
  evidenceCollectedAt: null,
  evidenceContradiction: false,
  supersededAt: null,
  approval: null,
  issue: null,
  supersededIssue: null,
  notified: null,
  ...overrides,
});

const stateWith = (recordState, overrides = {}) => ({
  ...emptyReconciliationState(),
  roles: { [ROLE_KEY]: roleRecord({ state: recordState, ...overrides }) },
});

const unknownStateWith = (recordState, overrides = {}) => ({
  ...emptyReconciliationState(),
  unknown: { [UNKNOWN_TRANSITION]: unknownRecord({ state: recordState, ...overrides }) },
});

const storeOf = (state) => {
  const store = createReconciliationStore({
    root: join(tempRoot("reconcile-notify-"), "model-routing"),
    now: () => NOW,
    pid: 11,
  });
  store.update(() => state);
  return store;
};

// An awaiting-approval proposal that already has its Gitea issue: the only shape that produces a
// `proposal-opened` event, because the event carries the link a human is meant to follow.
const storeWithIssue = () => storeOf(stateWith("awaiting-approval", {
  reason: "no official successor or recommended-replacement claim was accepted",
  transitions: ["discovered", "evidence-pending", "awaiting-approval"],
  issue: issuePointer(),
}));

// An auto-eligible record needs no issue and no human, so it is the smallest thing that has one
// undelivered notification.
const freshStoreAwaitingNotification = () => storeOf(stateWith("auto-eligible"));

const okRun = () => ({ status: 0, stdout: "", stderr: "", signal: null, error: undefined });

const eventsOf = (entries) => entries.map((entry) => entry.event);

// ---- one event per transition -------------------------------------------------------------------

test("each transition notifies exactly once, with a link for an approval proposal", () => {
  const argvs = [];
  const store = storeWithIssue();                 // one store, deliberately reused across both runs
  const first = deliverNotifications({ store, roles: TEST_ROLES,
    run: (argv) => { argvs.push(argv); return okRun(); }, now: () => NOW });
  assert.equal(first.delivered.length, 1);
  assert.deepEqual(eventsOf(first.delivered), ["proposal-opened"]);
  assert.match(argvs[0].join(" "), /issues\/41/);
  assert.match(argvs[0].join(" "), /gpt-6-sol/);

  argvs.length = 0;
  const second = deliverNotifications({ store, roles: TEST_ROLES,
    run: (argv) => { argvs.push(argv); return okRun(); }, now: () => NOW + 1000 });
  assert.deepEqual(second.delivered, []);
  assert.deepEqual(argvs, []);
});

test("the argv is the configured notifier, carrying the reconciliation kind and the registry tiers", () => {
  const argvs = [];
  deliverNotifications({ store: freshStoreAwaitingNotification(), roles: TEST_ROLES,
    run: (argv) => { argvs.push(argv); return okRun(); }, now: () => NOW });
  assert.equal(argvs.length, 1);
  assert.equal(argvs[0][0], "/usr/local/bin/fleet-notify");
  assert.equal(argvs[0][1], "--kind=model-reconcile");
  assert.equal(argvs[0].length, 4, "a notifier naming {title} and {body} gets no appended pair");
  assert.match(argvs[0][3], /registry tiers: smart/);
  assert.match(argvs[0][3], /openai:gpt-sol/);
});

test("a genuinely new transition on the same record notifies again", () => {
  const store = freshStoreAwaitingNotification();
  const first = deliverNotifications({ store, roles: TEST_ROLES, run: okRun, now: () => NOW });
  assert.deepEqual(eventsOf(first.delivered), ["auto-eligible"]);

  // What Task 5 leaves behind when a human's decision label lands on the proposal.
  store.update((state) => ({
    ...state,
    roles: {
      ...state.roles,
      [ROLE_KEY]: { ...state.roles[ROLE_KEY], state: "approved", stateChangedAt: NOW + 5000 },
    },
  }));
  const second = deliverNotifications({ store, roles: TEST_ROLES, run: okRun, now: () => NOW + 6000 });
  assert.deepEqual(eventsOf(second.delivered), ["decision-applied"]);
});

// ---- failure, retry and the cap ------------------------------------------------------------------

test("a failed delivery stays pending, is retried, and is capped", () => {
  let attempts = 0;
  const store = freshStoreAwaitingNotification();
  for (let round = 0; round < NOTIFY_MAX_ATTEMPTS + 2; round += 1) {
    deliverNotifications({ store, roles: TEST_ROLES,
      run: () => { attempts += 1; return { status: 1, stderr: "ntfy unreachable" }; },
      now: () => NOW + round * 60_000 });
  }
  assert.equal(attempts, NOTIFY_MAX_ATTEMPTS);
  const health = notificationHealth(store.read());
  assert.equal(health.failed, 1);
  assert.equal(health.pending, 0);
});

test("a single failed delivery is visible as pending, with its error and the time it was first tried", () => {
  const store = freshStoreAwaitingNotification();
  const result = deliverNotifications({ store, roles: TEST_ROLES,
    run: () => ({ status: 1, stderr: "ntfy unreachable" }), now: () => NOW });
  assert.deepEqual(result.delivered, []);
  assert.deepEqual(eventsOf(result.pending), ["auto-eligible"]);
  assert.deepEqual(notificationHealth(store.read()), { pending: 1, failed: 0, oldestPendingAt: NOW });

  const record = store.read().roles[ROLE_KEY];
  const marker = record.notified[deliveryMarker(record, "auto-eligible")];
  assert.equal(marker.at, null, "an undelivered marker must not look delivered");
  assert.equal(marker.attempts, 1);
  assert.match(marker.lastError, /ntfy unreachable/);
});

test("a notify command that throws is a failed attempt, not a crashed projection", () => {
  const store = freshStoreAwaitingNotification();
  const result = deliverNotifications({ store, roles: TEST_ROLES,
    run: () => { throw new Error("spawn ENOENT"); }, now: () => NOW });
  assert.deepEqual(result.delivered, []);
  assert.equal(result.pending.length, 1);
  const record = store.read().roles[ROLE_KEY];
  assert.match(record.notified[deliveryMarker(record, "auto-eligible")].lastError, /ENOENT/);
});

test("a notification failure never reverts the transition that caused it", () => {
  const store = freshStoreAwaitingNotification();
  const before = store.read().roles[ROLE_KEY].state;
  deliverNotifications({ store, roles: TEST_ROLES, run: () => ({ status: 1 }), now: () => NOW });
  assert.equal(store.read().roles[ROLE_KEY].state, before);
});

test("no configured notifier is a clean skip, not a crash", () => {
  const result = deliverNotifications({ store: storeWithIssue(), roles: TEST_ROLES, notifyCommand: [],
    run: () => { throw new Error("must not run"); }, now: () => NOW });
  assert.deepEqual(result.delivered, []);
  assert.equal(result.skipped, "no-notify-command");
});

// ---- which records produce an event ---------------------------------------------------------------

test("a blocked or rolled-back record notifies, and an unchanged one does not", () => {
  assert.equal(pendingNotifications(stateWith("blocked-stale"), { roles: TEST_ROLES }).length, 1);
  assert.equal(pendingNotifications(stateWith("evidence-pending"), { roles: TEST_ROLES }).length, 0);
  for (const recordState of ["blocked-conflict", "blocked-unresolvable", "rolled-back"]) {
    assert.deepEqual(eventsOf(pendingNotifications(stateWith(recordState), { roles: TEST_ROLES })),
      ["blocked"], recordState);
  }
  assert.deepEqual(eventsOf(pendingNotifications(stateWith("rejected"), { roles: TEST_ROLES })),
    ["decision-applied"]);
});

test("an awaiting-approval proposal with no issue notifies nothing at all", () => {
  // Structurally gated on Gitea: without the issue there is no link to follow, so the event is
  // withheld rather than pushed with nothing actionable in it. Package 4 must enable the two
  // projections together, or proposal alerts are dropped.
  assert.deepEqual(pendingNotifications(stateWith("awaiting-approval"), { roles: TEST_ROLES }), []);
});

test("superseded is one of the announced events", () => {
  assert.equal(NOTIFY_EVENTS.includes("superseded"), true);
});

test("a retired unknown record announces its supersession", () => {
  // Task 4 writes `state: "superseded"` plus the `supersededAt` stamp; this is where the stamp's
  // consequence is asserted, because pendingNotifications does not exist until this task.
  const state = unknownStateWith("superseded", { supersededAt: NOW });
  assert.deepEqual(eventsOf(pendingNotifications(state, { roles: TEST_ROLES })), ["superseded"]);
});

test("a replaced role record announces its supersession even though it is back at evidence-pending", () => {
  const state = stateWith("evidence-pending", { supersededAt: NOW });
  const pending = pendingNotifications(state, { roles: TEST_ROLES });
  assert.deepEqual(eventsOf(pending), ["superseded"]);

  const store = storeOf(state);
  const first = deliverNotifications({ store, roles: TEST_ROLES, run: okRun, now: () => NOW });
  assert.equal(first.delivered.length, 1);
  const second = deliverNotifications({ store, roles: TEST_ROLES,
    run: () => { throw new Error("must not run twice"); }, now: () => NOW + 1000 });
  assert.deepEqual(second.delivered, []);
});

test("a supersession is announced once even after the record's state moves on", () => {
  // The marker for `superseded` is keyed on the stamp, not on stateChangedAt. Keyed on the state
  // change, the next classification of the replacement candidate would re-announce a retirement
  // that happened once.
  const store = storeOf(stateWith("evidence-pending", { supersededAt: NOW }));
  const first = deliverNotifications({ store, roles: TEST_ROLES, run: okRun, now: () => NOW });
  assert.deepEqual(eventsOf(first.delivered), ["superseded"]);

  store.update((state) => ({
    ...state,
    roles: {
      ...state.roles,
      [ROLE_KEY]: { ...state.roles[ROLE_KEY], state: "auto-eligible", stateChangedAt: NOW + 5000 },
    },
  }));
  const second = deliverNotifications({ store, roles: TEST_ROLES, run: okRun, now: () => NOW + 6000 });
  assert.deepEqual(eventsOf(second.delivered), ["auto-eligible"]);
});
