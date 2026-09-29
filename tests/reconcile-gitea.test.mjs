import assert from "node:assert/strict";
import test, { after } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/config.js reads its file once at import time, and lib/reconcile-gitea.js pulls CONFIG in for
// the default (OFF) projection settings. The fixture therefore has to be in place before the module
// graph loads, which a dynamic import is the only way to order.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const {
  DECISION_LABELS,
  PROPOSAL_LABEL,
  closeSupersededIssue,
  createGiteaClient,
  projectProposals,
  proposalIssueBody,
  proposalRevision,
} = await import(new URL("../lib/reconcile-gitea.js", import.meta.url).href);

const { createReconciliationStore, emptyReconciliationState } =
  await import(new URL("../lib/reconcile-state.js", import.meta.url).href);

const HOUR = 3600_000;
const NOW = Date.parse("2026-09-29T00:00:00Z");
const RETRIEVED_AT = new Date(NOW - HOUR).toISOString();
const ROLE_TRANSITION = "aaaaaaaaaaaaaaaaaaaaaaaa";
const UNKNOWN_TRANSITION = "bbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN = "test-gitea-token";
const ISSUE_NUMBER = 41;
const ISSUE_URL = `https://git.arch.fyi/opencode/opencode-broker/issues/${ISSUE_NUMBER}`;

// Hand-written rather than derived from the product registry: these tests are about what the
// projection does with a role, not about which roles ship by default.
const TEST_ROLES = Object.freeze({
  "openai:gpt-sol": Object.freeze({
    providerID: "openai",
    roleID: "gpt-sol",
    tiers: Object.freeze(["smart"]),
    evidenceDomains: Object.freeze(["openai.com", "developers.openai.com"]),
  }),
});

const ENABLED = Object.freeze({
  gitea: Object.freeze({
    baseURL: "https://git.arch.fyi",
    owner: "opencode",
    repo: "opencode-broker",
    tokenPath: null,        // filled in by tokenFile() below
    enabled: true,
  }),
  notifyCommand: Object.freeze([]),
});

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const tempRoot = (prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const tokenFile = (mode = 0o600) => {
  const path = join(tempRoot("reconcile-gitea-token-"), "gitea-token");
  writeFileSync(path, `${TOKEN}\n`);
  chmodSync(path, mode);
  return path;
};

const TOKEN_PATH = tokenFile();
const enabledConfig = (overrides = {}) => ({
  ...ENABLED,
  gitea: { ...ENABLED.gitea, tokenPath: TOKEN_PATH, ...overrides },
});

// ---- the forge double ------------------------------------------------------------------------
//
// Injected at `fetch`, not at the client: the client's own request shaping -- path, method,
// Authorization header, status handling -- is part of what these tests are for, so replacing the
// client with a hand-rolled object would leave all of it unexercised.

const jsonResponse = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

// The complete shape Gitea returns for an issue, including the fields the client does not read:
// a partial double would let the client start reading one of them without any test noticing.
const issuePayload = ({ number = ISSUE_NUMBER, state = "open", labels = [PROPOSAL_LABEL] } = {}) => ({
  id: 9000 + number,
  number,
  title: "model reconciliation proposal",
  body: "proposal body",
  state,
  labels: labels.map((name, index) => ({ id: index + 1, name, color: "ededed", description: "" })),
  html_url: `https://git.arch.fyi/opencode/opencode-broker/issues/${number}`,
  user: { id: 1, login: "broker" },
  created_at: "2026-09-28T00:00:00Z",
  updated_at: "2026-09-28T00:00:00Z",
  closed_at: state === "closed" ? "2026-09-28T12:00:00Z" : null,
});

const forgeWith = ({ issue = {}, failEvery = null, failPatch = null, httpStatus = null } = {}) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const { pathname } = new URL(url);
    const method = options.method ?? "GET";
    const body = options.body === undefined ? null : JSON.parse(options.body);
    calls.push({ method, path: pathname, url: String(url), body, headers: { ...(options.headers ?? {}) }, signal: options.signal });
    if (failEvery) throw failEvery;
    if (method === "PATCH" && failPatch) throw failPatch;
    if (httpStatus) return jsonResponse({ message: "refused" }, { ok: false, status: httpStatus });
    if (method === "POST" && pathname.endsWith("/comments")) {
      return jsonResponse({ id: 7, body: body.body, html_url: `${ISSUE_URL}#issuecomment-7` });
    }
    if (method === "POST" && pathname.endsWith("/issues")) {
      return jsonResponse(issuePayload({ labels: body.labels ?? [] }));
    }
    if (method === "PATCH") return jsonResponse(issuePayload({ ...issue, state: body.state }));
    return jsonResponse(issuePayload(issue));
  };
  return {
    calls,
    client: createGiteaClient({
      baseURL: "https://git.arch.fyi",
      owner: "opencode",
      repo: "opencode-broker",
      tokenPath: TOKEN_PATH,
      fetch: fetchImpl,
    }),
  };
};

const forge = () => forgeWith({});
const forgeWithLabels = (labels) => forgeWith({ issue: { labels } });

const project = async (args) => projectProposals({
  roles: TEST_ROLES,
  now: () => NOW,
  config: enabledConfig(),
  ...args,
});

// ---- record fixtures -------------------------------------------------------------------------
//
// Every one of these is a factory, called inside the test that needs it. These tests drive records
// to `approved`, `rejected` and cleared pointers, and node:test runs them in order, so a shared
// binding would leak a decided record into the next test.

const storedClaim = (overrides = {}) => ({
  providerID: "openai",
  candidateModelID: "gpt-6-sol",
  incumbentModelID: "gpt-5.6-sol",
  roleID: "gpt-sol",
  claimType: "stronger",
  sourceURL: "https://developers.openai.com/api/docs/models/gpt-6-sol",
  exactQuote: "GPT-6 Sol scores higher than GPT-5.6 Sol on every published benchmark.",
  retrievedAt: RETRIEVED_AT,
  contentHash: "a".repeat(64),
  policy: false,
  ...overrides,
});

const awaitingRecord = (overrides = {}) => ({
  transitionID: ROLE_TRANSITION,
  roleKey: "openai:gpt-sol",
  providerID: "openai",
  roleID: "gpt-sol",
  candidateModelID: "gpt-6-sol",
  candidateFamily: "gpt-sol",
  candidateReleaseDate: "2026-09-22",
  candidateVersion: "6",
  incumbentModelID: "gpt-5.6-sol",
  proposedTiers: ["smart"],
  proposedFit: {},
  state: "awaiting-approval",
  reason: "no official successor or recommended-replacement claim was accepted",
  stateChangedAt: NOW - HOUR,
  lastObservedAt: NOW - HOUR,
  transitions: ["discovered", "evidence-pending", "awaiting-approval"],
  evidence: [storedClaim()],
  evidenceRevision: null,
  evidenceContradiction: false,
  approval: null,
  issue: null,
  supersededIssue: null,
  notified: null,
  ...overrides,
});

const awaitingUnknownRecord = (overrides = {}) => ({
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
  evidence: [storedClaim({
    candidateModelID: "gpt-6-orbit",
    incumbentModelID: null,
    roleID: null,
    exactQuote: "GPT-6 Orbit is a new line of models for long-horizon work.",
  })],
  evidenceRevision: null,
  evidenceContradiction: false,
  approval: null,
  issue: null,
  supersededIssue: null,
  notified: null,
  ...overrides,
});

const openIssuePointer = (revision) => ({
  number: ISSUE_NUMBER,
  url: ISSUE_URL,
  revision,
  createdAt: NOW - HOUR,
  commentedAt: null,
  reopenedAt: null,
  refusedAt: null,
});

const storeWith = (state) => {
  const store = createReconciliationStore({ root: join(tempRoot("reconcile-gitea-"), "model-routing"), now: () => NOW, pid: 11 });
  if (state) store.update(() => state);
  return store;
};

const roleState = (record) => ({ ...emptyReconciliationState(), roles: { [record.roleKey]: record } });
const unknownState = (record) => ({ ...emptyReconciliationState(), unknown: { [record.transitionID]: record } });

const storeAwaiting = () => storeWith(roleState(awaitingRecord()));

const storeWithIssue = () => storeWith(roleState(awaitingRecord({
  issue: openIssuePointer(proposalRevision(awaitingRecord())),
})));

const storeWithUnknownIssue = () => storeWith(unknownState(awaitingUnknownRecord({
  issue: openIssuePointer(proposalRevision(awaitingUnknownRecord())),
})));

// Exactly what Task 4 leaves behind: the pointer moved off a record that has already dropped back
// to evidence-pending for the NEW candidate.
const storeWithSupersededIssue = (pointer = {}) => storeWith(roleState(awaitingRecord({
  state: "evidence-pending",
  reason: null,
  evidence: [],
  transitions: ["discovered", "evidence-pending", "awaiting-approval", "superseded", "evidence-pending"],
  candidateModelID: "gpt-7-sol",
  candidateReleaseDate: "2026-11-03",
  supersededAt: NOW - 1000,
  issue: null,
  supersededIssue: { number: ISSUE_NUMBER, url: ISSUE_URL, supersededAt: NOW - 1000, commentedAt: null, ...pointer },
})));

// An operator amended the tiers after the issue was opened, so the pointer carries the revision of
// the proposal as it was proposed, not as it now stands.
const storeWithAmendedTiers = () => storeWith(roleState(awaitingRecord({
  proposedTiers: ["smart", "build"],
  issue: openIssuePointer(proposalRevision(awaitingRecord())),
})));

const storeWithRoleState = (state) => storeWith(roleState(awaitingRecord({ state })));

// ---- the proposal revision -------------------------------------------------------------------

test("a proposal revision moves with the tiers and the role, and not with observation", () => {
  const base = proposalRevision(awaitingRecord());
  assert.match(base, /^[0-9a-f]{24}$/);
  assert.equal(proposalRevision(awaitingRecord()), base);
  assert.notEqual(proposalRevision(awaitingRecord({ proposedTiers: ["smart", "build"] })), base,
    "an amend has to supersede the issue it changed");
  assert.notEqual(proposalRevision(awaitingRecord({ roleKey: "openai:gpt-luna" })), base);
  assert.notEqual(proposalRevision(awaitingRecord({ candidateModelID: "gpt-7-sol" })), base);
  assert.equal(proposalRevision(awaitingRecord({ lastObservedAt: NOW, evidence: [] })), base,
    "a rerun that changes nothing about the proposal must not supersede its issue");
});

test("an unknown record with no proposed tiers still has a revision", () => {
  assert.match(proposalRevision(awaitingUnknownRecord()), /^[0-9a-f]{24}$/);
});

// ---- the client ------------------------------------------------------------------------------

test("every request carries the token in a header and never in the URL", async () => {
  const forged = forge();
  await forged.client.createIssue({ title: "t", body: "b", labels: [PROPOSAL_LABEL] });
  assert.equal(forged.calls[0].headers.Authorization, `token ${TOKEN}`);
  assert.equal(forged.calls[0].headers.Accept, "application/json");
  assert.equal(forged.calls[0].url.includes(TOKEN), false);
  assert.equal(forged.calls[0].path, "/api/v1/repos/opencode/opencode-broker/issues");
  assert.ok(forged.calls[0].signal, "an unbounded forge request would wedge the scheduled projection");
});

test("a non-2xx response names the status and the path, and never the token", async () => {
  const forged = forgeWith({ httpStatus: 403 });
  await assert.rejects(() => forged.client.getIssue(ISSUE_NUMBER), (error) => {
    assert.match(error.message, /403/);
    assert.match(error.message, /issues\/41/);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test("a group- or world-readable token file is refused before any request is made", () => {
  const calls = [];
  const loose = tokenFile(0o644);
  assert.throws(() => createGiteaClient({
    baseURL: "https://git.arch.fyi", owner: "opencode", repo: "opencode-broker",
    tokenPath: loose,
    fetch: (...args) => { calls.push(args); throw new Error("must not be called"); },
  }), /group- or world-readable/);
  assert.deepEqual(calls, []);
});

test("no deployed token refuses to construct a client rather than calling anonymously", () => {
  assert.throws(() => createGiteaClient({
    baseURL: "https://git.arch.fyi", owner: "opencode", repo: "opencode-broker",
    tokenPath: join(tempRoot("reconcile-gitea-notoken-"), "gitea-token"),
    fetch: () => { throw new Error("must not be called"); },
  }), /token/i);
});

// ---- projecting a proposal ---------------------------------------------------------------------

test("one awaiting-approval proposal creates exactly one labelled issue, and a rerun creates none", async () => {
  const store = storeAwaiting();
  const forged = forge();
  const first = await project({ store, client: forged.client });
  assert.equal(first.created.length, 1);
  const posted = forged.calls.find((call) => call.method === "POST" && call.path.endsWith("/issues"));
  assert.deepEqual(posted.body.labels, [PROPOSAL_LABEL]);
  assert.match(posted.body.body, new RegExp(ROLE_TRANSITION));
  assert.match(posted.body.body, /developers\.openai\.com/);
  assert.match(posted.body.body, /decision\/approved/);
  const record = store.read().roles["openai:gpt-sol"];
  assert.equal(record.issue.number, ISSUE_NUMBER);
  assert.equal(record.issue.revision, proposalRevision(record));

  forged.calls.length = 0;
  const second = await project({ store, client: forged.client, now: () => NOW + 1000 });
  assert.deepEqual(second.created, []);
  assert.equal(forged.calls.some((call) => call.method === "POST" && call.path.endsWith("/issues")), false);
});

test("the issue body carries the proposal and no host path or credential", () => {
  const body = proposalIssueBody(awaitingRecord(), { roles: TEST_ROLES });
  assert.match(body, /gpt-6-sol/);
  assert.match(body, /gpt-5\.6-sol/);
  assert.match(body, /openai:gpt-sol/);
  assert.match(body, /smart/);
  assert.match(body, /GPT-6 Sol scores higher/);
  assert.match(body, new RegExp(DECISION_LABELS.rejected.replace("/", "\\/")));
  assert.equal(body.includes(TOKEN), false);
  assert.equal(body.includes(TOKEN_PATH), false);
});

test("an unknown-role proposal says no mapping is proposed and names the amend command", () => {
  const body = proposalIssueBody(awaitingUnknownRecord(), { roles: TEST_ROLES });
  assert.match(body, /no role mapping is proposed/i);
  assert.match(body, new RegExp(`opencode-broker-reconcile amend ${UNKNOWN_TRANSITION} --role <provider>:<roleID> --tiers <tier,tier>`));
});

test("an approved label applies the stored proposal, comments, and closes", async () => {
  const store = storeWithIssue();
  const forged = forgeWithLabels([PROPOSAL_LABEL, DECISION_LABELS.approved]);
  const result = await project({ store, client: forged.client });
  const record = result.state.roles["openai:gpt-sol"];
  assert.equal(record.state, "approved");
  assert.equal(record.approval.decision, "approved");
  assert.equal(record.approval.source, "gitea-label");
  assert.equal(record.approval.at, NOW);
  assert.deepEqual(record.transitions.slice(-1), ["approved"]);
  assert.equal(forged.calls.filter((call) => call.path.endsWith("/comments")).length, 1);
  assert.equal(forged.calls.find((call) => call.method === "PATCH").body.state, "closed");
});

test("a rejected label records the rejection and blocks re-proposal", async () => {
  const store = storeWithIssue();
  const result = await project({ store, client: forgeWithLabels([DECISION_LABELS.rejected]).client });
  const record = result.state.roles["openai:gpt-sol"];
  assert.equal(record.state, "rejected");
  assert.equal(record.approval.decision, "rejected");
});

test("both decision labels change nothing at all", async () => {
  const store = storeWithIssue();
  const before = store.read();
  const forged = forgeWithLabels([DECISION_LABELS.approved, DECISION_LABELS.rejected]);
  const result = await project({ store, client: forged.client });
  assert.equal(result.state.roles["openai:gpt-sol"].state, "awaiting-approval");
  assert.equal(result.conflicts.length, 1);
  assert.equal(forged.calls.some((call) => call.method === "PATCH"), false);
  assert.equal(forged.calls.some((call) => call.path.endsWith("/comments")), false);
  assert.deepEqual(result.state.roles["openai:gpt-sol"].approval, before.roles["openai:gpt-sol"].approval);
});

test("closing an undecided issue is not approval, and it is reopened exactly once", async () => {
  const store = storeWithIssue();                 // one store, deliberately reused across both runs
  const forged = forgeWith({ issue: { state: "closed", labels: [PROPOSAL_LABEL] } });
  const first = await project({ store, client: forged.client });
  assert.equal(first.state.roles["openai:gpt-sol"].state, "awaiting-approval");
  assert.equal(first.state.roles["openai:gpt-sol"].approval, null);
  assert.equal(first.reopened.length, 1);
  assert.equal(forged.calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal(forged.calls.find((call) => call.method === "PATCH").body.state, "open");

  forged.calls.length = 0;
  const second = await project({ store, client: forged.client, now: () => NOW + 1000 });
  assert.deepEqual(second.reopened, []);
  assert.equal(forged.calls.some((call) => call.method === "PATCH"), false);
  assert.equal(forged.calls.some((call) => call.path.endsWith("/comments")), false);
});

// ---- moved pointers ----------------------------------------------------------------------------

test("a superseded issue is closed from its moved pointer, whatever the record's state now is", async () => {
  const store = storeWithSupersededIssue();
  const forged = forge();
  const result = await project({ store, client: forged.client });
  assert.deepEqual(result.closed, [{ kind: "role", key: "openai:gpt-sol" }]);
  assert.match(forged.calls.find((call) => call.path.endsWith("/comments")).body.body, /superseded/i);
  assert.equal(forged.calls.find((call) => call.method === "PATCH").body.state, "closed");
  assert.equal(store.read().roles["openai:gpt-sol"].supersededIssue, null);

  forged.calls.length = 0;
  const again = await project({ store, client: forged.client, now: () => NOW + 1000 });
  assert.deepEqual(again.closed, []);
  assert.deepEqual(forged.calls, []);
});

test("a close that fails retries without repeating the comment", async () => {
  const store = storeWithSupersededIssue();
  const failing = forgeWith({ failPatch: new Error("502 bad gateway") });
  const first = await project({ store, client: failing.client });
  assert.equal(first.errors.length, 1);
  assert.deepEqual(first.closed, []);
  const pending = store.read().roles["openai:gpt-sol"].supersededIssue;
  assert.equal(pending.number, ISSUE_NUMBER);
  assert.equal(pending.commentedAt, NOW);

  const forged = forge();
  const second = await project({ store, client: forged.client, now: () => NOW + 1000 });
  assert.equal(second.closed.length, 1);
  assert.equal(forged.calls.some((call) => call.path.endsWith("/comments")), false);
  assert.equal(store.read().roles["openai:gpt-sol"].supersededIssue, null);
});

test("an issue already closed on the forge is cleared without a new comment", async () => {
  const store = storeWithSupersededIssue();
  const forged = forgeWith({ issue: { state: "closed", labels: [PROPOSAL_LABEL] } });
  const result = await project({ store, client: forged.client });
  assert.equal(result.closed.length, 1);
  assert.equal(forged.calls.some((call) => call.path.endsWith("/comments")), false);
  assert.equal(forged.calls.some((call) => call.method === "PATCH"), false);
  assert.equal(store.read().roles["openai:gpt-sol"].supersededIssue, null);
});

// A pointer moved by `opencode-broker-reconcile approve|reject` is closed by the same pass, but it
// must NOT be explained as a supersession: nothing was withdrawn and the proposal was decided, so
// the supersession text ("nothing was applied", "the provider now publishes ...") would be untrue.
test("an issue closed by a local decision says so instead of claiming a supersession", async () => {
  const store = storeWithSupersededIssue({ reason: "decided-rejected" });
  const forged = forge();
  const result = await project({ store, client: forged.client });
  assert.deepEqual(result.closed, [{ kind: "role", key: "openai:gpt-sol" }]);
  const comment = forged.calls.find((call) => call.path.endsWith("/comments")).body.body;
  assert.match(comment, /opencode-broker-reconcile reject/);
  assert.doesNotMatch(comment, /superseded/i);
  assert.doesNotMatch(comment, /no longer the one under consideration/);
  assert.equal(forged.calls.find((call) => call.method === "PATCH").body.state, "closed");
  assert.equal(store.read().roles["openai:gpt-sol"].supersededIssue, null);
});

test("a pointer with no issue number is never sent to the forge", async () => {
  const forged = forge();
  const record = awaitingRecord({ supersededIssue: null });
  const result = await closeSupersededIssue({
    record, key: "openai:gpt-sol", kind: "role",
    client: forged.client, store: storeAwaiting(), now: () => NOW,
  });
  assert.deepEqual(result, { closed: false, error: null });
  assert.deepEqual(forged.calls, []);
});

test("an amended proposal supersedes its own open issue and opens the next revision", async () => {
  const store = storeWithAmendedTiers();
  const forged = forge();
  const result = await project({ store, client: forged.client });
  assert.deepEqual(result.superseded, [{ kind: "role", key: "openai:gpt-sol" }]);
  assert.deepEqual(result.closed, [{ kind: "role", key: "openai:gpt-sol" }]);
  assert.equal(result.created.length, 1);
  const record = store.read().roles["openai:gpt-sol"];
  assert.equal(record.supersededIssue, null);
  assert.equal(record.issue.revision, proposalRevision(record));
});

// ---- refusals and failures ---------------------------------------------------------------------

test("a Gitea failure blocks the approval path without touching other records", async () => {
  const store = storeAwaiting();
  const result = await project({ store, client: forgeWith({ failEvery: new Error("502 bad gateway") }).client });
  assert.equal(result.created.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(store.read().roles["openai:gpt-sol"].state, "awaiting-approval");
  assert.equal(store.read().roles["openai:gpt-sol"].issue, null);
});

test("an approved decision whose close fails is retried without repeating the comment", async () => {
  const store = storeWithIssue();
  const failing = forgeWith({ issue: { labels: [DECISION_LABELS.approved] }, failPatch: new Error("502 bad gateway") });
  const first = await project({ store, client: failing.client });
  assert.equal(first.errors.length, 1);
  assert.equal(store.read().roles["openai:gpt-sol"].state, "awaiting-approval",
    "a decision the forge never confirmed must not be recorded as applied");
  assert.equal(store.read().roles["openai:gpt-sol"].issue.commentedAt, NOW);

  const forged = forgeWithLabels([DECISION_LABELS.approved]);
  const second = await project({ store, client: forged.client, now: () => NOW + 1000 });
  assert.equal(second.errors.length, 0);
  assert.equal(second.state.roles["openai:gpt-sol"].state, "approved");
  assert.equal(forged.calls.some((call) => call.path.endsWith("/comments")), false);
});

test("the token never appears in a body, a comment, or the ledger", async () => {
  const store = storeWithIssue();
  const forged = forgeWithLabels([DECISION_LABELS.approved]);
  await project({ store, client: forged.client });
  const serialized = JSON.stringify(store.read()) + JSON.stringify(forged.calls.map((call) => call.body));
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(TOKEN_PATH), false);
});

test("approving an unknown role with no mapping is refused, not guessed", async () => {
  const store = storeWithUnknownIssue();
  const forged = forgeWithLabels([DECISION_LABELS.approved]);
  const result = await project({ store, client: forged.client });
  const record = result.state.unknown[UNKNOWN_TRANSITION];
  assert.equal(record.state, "awaiting-approval");
  assert.equal(record.approval, null);
  assert.equal(result.errors.length, 1);
  assert.match(forged.calls.find((call) => call.path.endsWith("/comments")).body.body, /amend/);
  assert.equal(forged.calls.some((call) => call.method === "PATCH"), false);

  // The refusal is explained once, not on every scheduled run.
  forged.calls.length = 0;
  await project({ store, client: forged.client, now: () => NOW + 1000 });
  assert.equal(forged.calls.some((call) => call.path.endsWith("/comments")), false);
});

test("an amended unknown proposal becomes approvable", async () => {
  // Exactly what Task 7's `amend` leaves behind: a role key and tiers on the unknown record, and a
  // revision that no longer matches the issue it was proposed under.
  const amended = awaitingUnknownRecord({
    roleKey: "openai:gpt-orbit",
    roleID: "gpt-orbit",
    proposedTiers: ["smart"],
    issue: openIssuePointer(proposalRevision(awaitingUnknownRecord())),
  });
  const store = storeWith(unknownState(amended));
  const forged = forgeWithLabels([DECISION_LABELS.approved]);
  const first = await project({ store, client: forged.client });
  assert.equal(first.created.length, 1, "the amendment supersedes the issue it changed");

  const decided = await project({
    store, client: forgeWithLabels([DECISION_LABELS.approved]).client, now: () => NOW + 1000,
  });
  assert.equal(decided.state.unknown[UNKNOWN_TRANSITION].state, "approved");
  assert.equal(decided.errors.length, 0);
});

test("auto-eligible and blocked records are never projected", async () => {
  for (const state of ["auto-eligible", "evidence-pending", "blocked-stale", "blocked-unresolvable"]) {
    const forged = forge();
    const result = await project({ store: storeWithRoleState(state), client: forged.client });
    assert.deepEqual(result.created, [], state);
    assert.deepEqual(forged.calls, [], state);
  }
});

test("a decided record is never re-projected", async () => {
  for (const state of ["approved", "rejected", "superseded"]) {
    const forged = forge();
    const result = await project({ store: storeWithRoleState(state), client: forged.client });
    assert.deepEqual(result.created, [], state);
    assert.deepEqual(forged.calls, [], state);
  }
});

// ---- the default-OFF guarantee -------------------------------------------------------------------

test("the projection is off unless the deployment turns it on, and says so", async () => {
  const store = storeAwaiting();
  const forged = forge();
  const result = await project({ store, client: forged.client, config: enabledConfig({ enabled: false }) });
  assert.equal(result.skipped, "gitea-disabled");
  assert.deepEqual(result.created, []);
  assert.deepEqual(forged.calls, []);
  assert.equal(store.read().roles["openai:gpt-sol"].issue, null);
});

test("a config that never mentioned the reconciler projects nothing", async () => {
  const store = storeAwaiting();
  const forged = forge();
  const result = await projectProposals({ store, roles: TEST_ROLES, client: forged.client, now: () => NOW });
  assert.equal(result.skipped, "gitea-disabled");
  assert.deepEqual(forged.calls, []);
});
