// The Gitea projection: one issue per open proposal, and the decision labels a human applies to it.
//
// This module PRESENTS durable state and READS decisions back. It never invents a proposal, never
// edits routing, and never trusts issue text -- approval applies the proposal as the ledger stored
// it, which is why an operator who wants a different mapping has to `amend` it rather than edit the
// issue body.
//
// Three properties shape everything below.
//
//   1. THE LABEL IS THE DECISION. Exactly one decision label applies; both at once is a conflict
//      that writes nothing at all, not a race whichever label was read first wins. A closed issue
//      carrying no decision label is an accident, not an approval: it is reopened once, with
//      instructions, and the marker that records the reopen is what stops the next run doing it
//      again.
//
//   2. THE EXTERNAL WRITE COMES FIRST, THEN THE MARKER, THEN THE LEDGER. Every comment is followed
//      immediately by a persisted marker before the close is attempted, so a close that fails
//      retries without re-commenting. A single store.update() spanning comment and close would make
//      "no duplicate comment" false on the first 502. The ledger decision itself is written only
//      after the forge has confirmed the close, so a proposal is never recorded as applied on the
//      strength of a write that did not land.
//
//   3. IDEMPOTENCE IS SCOPED TO COMPLETED RUNS. A crash between an external write and the marker
//      that records it can duplicate one issue or one comment on restart. Closing that window needs
//      an issue search keyed by proposal revision, which this package does not have. The blast
//      radius is one extra issue or comment; the decision logic is unaffected.
//
// The token is read through lib/reconcile-secrets.js and nowhere else, so the mode-0600 check
// happens exactly once in the package. It travels in an Authorization header -- never in a URL,
// never in argv, never in issue text, never in the ledger, never in an error message.
import { createHash } from "node:crypto";

import { CONFIG } from "./config.js";
import { candidateRevision } from "./reconcile-evidence.js";
import { readGiteaTokenIfPresent } from "./reconcile-secrets.js";

export const PROPOSAL_LABEL = "model-reconciliation";
export const DECISION_LABELS = Object.freeze({
  approved: "decision/approved",
  rejected: "decision/rejected",
});

// Thirty seconds. A scheduled projection that hung on a single forge request would hold nothing
// (the ledger lock is never held across a request) but would never finish either, and the next run
// would pile up behind it.
export const GITEA_REQUEST_TIMEOUT_MS = 30_000;

// lib/config.js parses these as null when the deployment does not name them -- it has no business
// knowing this fleet's forge. Resolving the nulls here keeps the defaults in the one module that
// actually talks to the forge, without a second parser.
const DEFAULT_BASE_URL = "https://git.arch.fyi";
const DEFAULT_OWNER = "opencode";
const DEFAULT_REPO = "opencode-broker";

const AMEND_COMMAND = "opencode-broker-reconcile amend";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const recordCandidateModelID = (record) => record?.candidateModelID ?? record?.modelID ?? null;

const recordReleaseDate = (record) => record?.candidateReleaseDate ?? record?.releaseDate ?? null;

const proposedTiersOf = (record) => (Array.isArray(record?.proposedTiers) ? [...record.proposedTiers] : []);

// The identity of THIS PROPOSAL, as opposed to the identity of the candidate. An `amend` changes
// the role or the tiers without changing the candidate, and that has to supersede the open issue --
// a human who approved the old text would otherwise be approving a mapping they never saw. A rerun
// that changes neither must produce the same revision, or every scheduled run would file a new
// issue. Tier ORDER is part of it: the tier list is ordered, and a reordering is an amendment.
export const proposalRevision = (record) => createHash("sha256")
  .update([
    candidateRevision(record),
    proposedTiersOf(record).join(","),
    String(record?.roleKey ?? ""),
  ].join("\u0000"))
  .digest("hex")
  .slice(0, 24);

// A proposal a decision can actually be applied to: it names a role and the tiers that role would
// take. Package 1 writes `proposedTiers` only for role records, so an unknown candidate arrives
// with neither -- and the model is not allowed to invent them.
const proposalIsApprovable = (record) => typeof record?.roleKey === "string"
  && record.roleKey !== ""
  && proposedTiersOf(record).length > 0;

const evidenceLines = (record) => {
  const evidence = Array.isArray(record?.evidence) ? record.evidence : [];
  if (!evidence.length) return ["  no official claim has been accepted for this candidate"];
  return evidence.flatMap((claim, index) => [
    `  ${index + 1}. ${claim.claimType}${claim.policy === true ? " (decides policy)" : " (supporting only)"}`,
    `     ${claim.sourceURL}`,
    `     "${claim.exactQuote}"`,
    `     retrieved ${claim.retrievedAt}`,
  ]);
};

export const proposalIssueBody = (record, { roles } = {}) => {
  if (!isPlainObject(record)) throw new Error("a proposal issue body needs a reconciliation record");
  const registry = isPlainObject(roles) ? roles : {};
  const roleKey = typeof record.roleKey === "string" && record.roleKey ? record.roleKey : null;
  const role = roleKey ? registry[roleKey] : null;
  const tiers = proposedTiersOf(record);
  const approvable = proposalIsApprovable(record);

  return [
    `Proposal ${record.transitionID} (revision ${proposalRevision(record)})`,
    "",
    `provider: ${record.providerID}`,
    roleKey
      ? `role: ${roleKey}${role?.tiers ? ` (registry tiers: ${[...role.tiers].join(", ")})` : ""}`
      : "role: none -- no role mapping is proposed for this candidate",
    `candidate: ${recordCandidateModelID(record)}${recordReleaseDate(record) ? ` (released ${recordReleaseDate(record)})` : ""}`,
    `model currently in use for the role: ${record.incumbentModelID ?? "none"}`,
    `proposed tiers: ${tiers.length ? tiers.join(", ") : "none"}`,
    "",
    // Every gate is applied before a candidate can reach a proposal at all: one that failed
    // admission, resolution or a capability check is recorded as blocked and never projected.
    "Operational admission: this candidate is published by a provider this deployment holds",
    "subscription auth for, is present in the host resolver view, and passed the capability gates.",
    "A candidate that failed any of those is recorded as blocked and is never proposed here.",
    `current state: ${record.state}${record.reason ? ` -- ${record.reason}` : ""}`,
    "",
    "Official evidence:",
    ...evidenceLines(record),
    "",
    "To decide, apply exactly ONE label to this issue:",
    `  ${DECISION_LABELS.approved} -- apply the proposal exactly as stored above`,
    `  ${DECISION_LABELS.rejected} -- record the rejection and stop proposing this candidate`,
    "",
    "Both labels at once is a conflict and changes nothing. Closing this issue without a decision",
    "label is not a decision: the reconciler reopens it once. Editing this text changes nothing --",
    "the stored proposal is what a decision applies.",
    ...(approvable ? [] : [
      "",
      "NO ROLE MAPPING IS PROPOSED, so this proposal cannot be approved as it stands. Supply the",
      "mapping first, which also opens a fresh issue for the amended proposal:",
      `  ${AMEND_COMMAND} ${record.transitionID} --role <provider>:<roleID> --tiers <tier,tier>`,
    ]),
  ].join("\n");
};

const proposalIssueTitle = (record) => {
  const candidate = recordCandidateModelID(record);
  const target = typeof record.roleKey === "string" && record.roleKey ? `role ${record.roleKey}` : "no mapped role";
  return `model reconciliation: ${record.providerID}/${candidate} for ${target} (${record.transitionID})`;
};

const supersededComment = (record) => [
  "This proposal has been superseded and is closed without a decision.",
  "",
  `The provider now publishes ${recordCandidateModelID(record)} for this line, so the candidate this`,
  "issue described is no longer the one under consideration.",
  "",
  "Nothing was applied. A fresh proposal is opened when the new candidate has its own evidence.",
].join("\n");

const decisionComment = (decision, record) => [
  `Applied: ${decision} (from ${DECISION_LABELS[decision]}).`,
  "",
  decision === "approved"
    ? `The stored proposal for ${recordCandidateModelID(record)} is accepted: role ${record.roleKey}, tiers ${proposedTiersOf(record).join(", ")}.`
    : `The stored proposal for ${recordCandidateModelID(record)} is rejected and will not be proposed again.`,
  "",
  "Closing this issue.",
].join("\n");

const reopenComment = () => [
  "Reopened: this proposal was closed without a decision label, which is not a decision.",
  "",
  "Apply exactly one of the decision labels to decide it:",
  `  ${DECISION_LABELS.approved}`,
  `  ${DECISION_LABELS.rejected}`,
  "",
  "This issue is reopened once only. If it is closed undecided again it stays closed, and the",
  "proposal stays open in the reconciliation ledger, undecided.",
].join("\n");

const unmappedRefusalComment = (record) => [
  `${DECISION_LABELS.approved} cannot be applied to this proposal.`,
  "",
  "No role mapping is proposed for this candidate, so there is nothing to approve: approving it",
  "would mean guessing which role and which tiers it should take, which the reconciler will not do.",
  "",
  "Supply the mapping, which opens a fresh issue for the amended proposal:",
  `  ${AMEND_COMMAND} ${record.transitionID} --role <provider>:<roleID> --tiers <tier,tier>`,
].join("\n");

// ---- the forge client -------------------------------------------------------------------------

const issueNumberOf = (value) => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${String(value)} is not a Gitea issue number`);
  return value;
};

// Gitea returns labels as objects; every caller here wants names. Normalizing at the boundary keeps
// the label comparison in one place rather than in each branch of the projection.
const normalizeIssue = (payload) => ({
  number: Number(payload?.number),
  state: payload?.state === "closed" ? "closed" : "open",
  labels: (Array.isArray(payload?.labels) ? payload.labels : [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string"),
  url: typeof payload?.html_url === "string" ? payload.html_url : null,
});

export const createGiteaClient = ({
  baseURL,
  owner,
  repo,
  tokenPath,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = GITEA_REQUEST_TIMEOUT_MS,
} = {}) => {
  // The ONE reader, so the mode check happens once. A null return means no token is deployed, and
  // an unauthenticated call to a write API would fail anyway -- refusing to construct the client
  // makes that a deployment error at the top of the run instead of a 403 halfway through it.
  const token = readGiteaTokenIfPresent(tokenPath);
  if (token === null) {
    throw new Error("no Gitea token is deployed; the reconciler will not call the forge anonymously");
  }
  if (typeof fetchImpl !== "function") throw new Error("a Gitea client needs a fetch implementation");

  const base = String(baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const repoPath = `/api/v1/repos/${encodeURIComponent(owner ?? DEFAULT_OWNER)}/${encodeURIComponent(repo ?? DEFAULT_REPO)}`;

  const request = async (method, path, body) => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        // Built at call time and never stored on the returned object, so the token is not sitting
        // in a closure-visible field any caller could serialize.
        Authorization: `token ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response || response.ok !== true) {
      // Status and path only: the URL carries no credential and neither does this message.
      throw new Error(`gitea ${method} ${path} failed with status ${String(response?.status)}`);
    }
    return response.json();
  };

  return {
    getIssue: async (number) => normalizeIssue(await request("GET", `${repoPath}/issues/${issueNumberOf(number)}`)),
    createIssue: async ({ title, body, labels }) =>
      normalizeIssue(await request("POST", `${repoPath}/issues`, { title, body, labels: [...labels] })),
    addComment: async (number, body) => {
      await request("POST", `${repoPath}/issues/${issueNumberOf(number)}/comments`, { body });
      return true;
    },
    patchIssue: async (number, patch) =>
      normalizeIssue(await request("PATCH", `${repoPath}/issues/${issueNumberOf(number)}`, { ...patch })),
  };
};

// ---- ledger helpers ---------------------------------------------------------------------------

const mapField = (kind) => (kind === "unknown" ? "unknown" : "roles");

// Every ledger write in this module goes through here, so there is exactly one read-modify-write
// shape and it is always inside store.update()'s lock. The mutator sees the record as the ledger
// holds it NOW, not as this run read it before the forge call.
const writeRecord = (store, kind, key, mutate) => {
  const field = mapField(kind);
  const next = store.update((state) => {
    const current = state[field]?.[key];
    if (!current) return state;
    const updated = mutate(current);
    if (!updated || updated === current) return state;
    return { ...state, [field]: { ...state[field], [key]: updated } };
  });
  return next[field]?.[key] ?? null;
};

const readRecord = (store, kind, key) => store.read()[mapField(kind)]?.[key] ?? null;

const allRecords = (state) => [
  ...Object.entries(state.roles ?? {}).map(([key, record]) => ({ kind: "role", key, record })),
  ...Object.entries(state.unknown ?? {}).map(([key, record]) => ({ kind: "unknown", key, record })),
].sort((left, right) => compareText(left.kind, right.kind) || compareText(left.key, right.key));

const errorText = (error) => {
  const message = String(error?.message ?? error ?? "unknown error").trim();
  return message === "" ? "unknown error" : message;
};

// ---- closing a moved pointer --------------------------------------------------------------------

// The package's ONLY comment-and-close path, and the owner of every ledger write on it -- both the
// `commentedAt` stamp and the final clear -- so there is exactly one place a pointer can be left
// half-processed.
//
// The ordering is the guarantee: comment, persist that the comment happened, THEN close, and clear
// the pointer only once the close lands. A close that fails leaves `commentedAt` set and the
// pointer non-null, so the next run retries the close and never re-comments.
export const closeSupersededIssue = async ({ record, key, kind, client, store, now = Date.now }) => {
  const pointer = record?.supersededIssue ?? null;
  // A pointer with no issue number can only come from a bug upstream; calling the forge with
  // `number === undefined` on every run forever is the failure mode this guard exists for.
  if (!pointer || !Number.isInteger(pointer.number)) return { closed: false, error: null };

  try {
    const issue = await client.getIssue(pointer.number);
    if (issue.state !== "closed") {
      if (pointer.commentedAt === null || pointer.commentedAt === undefined) {
        await client.addComment(pointer.number, supersededComment(record));
        const at = now();
        writeRecord(store, kind, key, (current) => (current.supersededIssue
          ? { ...current, supersededIssue: { ...current.supersededIssue, commentedAt: at } }
          : current));
      }
      await client.patchIssue(pointer.number, { state: "closed" });
    }
    writeRecord(store, kind, key, (current) => ({ ...current, supersededIssue: null }));
    return { closed: true, error: null };
  } catch (error) {
    return { closed: false, error: errorText(error) };
  }
};

// ---- the projection ------------------------------------------------------------------------------

const createProposalIssue = async ({ record, kind, key, client, store, roles, now, result }) => {
  const revision = proposalRevision(record);
  const issue = await client.createIssue({
    title: proposalIssueTitle(record),
    body: proposalIssueBody(record, { roles }),
    labels: [PROPOSAL_LABEL],
  });
  const at = now();
  writeRecord(store, kind, key, (current) => ({
    ...current,
    issue: {
      number: issue.number,
      url: issue.url,
      revision,
      createdAt: at,
      commentedAt: null,
      reopenedAt: null,
      refusedAt: null,
      closedAt: null,
    },
  }));
  result.created.push({ kind, key, number: issue.number });
};

const applyDecision = async ({ decision, record, kind, key, client, store, now, result }) => {
  const pointer = record.issue;

  // An unknown candidate has no role and no tiers, so there is nothing an approval could apply.
  // Refused once, explained once, and left awaiting a decision that an `amend` can make possible.
  if (decision === "approved" && !proposalIsApprovable(record)) {
    if (pointer.refusedAt === null || pointer.refusedAt === undefined) {
      await client.addComment(pointer.number, unmappedRefusalComment(record));
      const refusedAt = now();
      writeRecord(store, kind, key, (current) => (current.issue
        ? { ...current, issue: { ...current.issue, refusedAt } }
        : current));
    }
    result.errors.push({
      kind,
      key,
      error: `${DECISION_LABELS.approved} cannot be applied: no role mapping is proposed for this candidate`,
    });
    return;
  }

  if (pointer.commentedAt === null || pointer.commentedAt === undefined) {
    await client.addComment(pointer.number, decisionComment(decision, record));
    const commentedAt = now();
    writeRecord(store, kind, key, (current) => (current.issue
      ? { ...current, issue: { ...current.issue, commentedAt } }
      : current));
  }
  await client.patchIssue(pointer.number, { state: "closed" });

  // Written last, and only now: a decision recorded before the forge confirmed the close would let
  // a failed close leave an open, labelled issue that no later run ever looks at again.
  const at = now();
  writeRecord(store, kind, key, (current) => ({
    ...current,
    state: decision,
    reason: `${decision} by ${DECISION_LABELS[decision]} on issue #${pointer.number}`,
    approval: { decision, source: "gitea-label", at },
    stateChangedAt: at,
    transitions: [...(Array.isArray(current.transitions) ? current.transitions : ["discovered"]), decision],
    issue: current.issue ? { ...current.issue, closedAt: at } : current.issue,
  }));
};

const reopenUndecidedIssue = async ({ record, kind, key, client, store, now, result }) => {
  const pointer = record.issue;
  if (pointer.reopenedAt !== null && pointer.reopenedAt !== undefined) return;
  // Reopen FIRST: if the comment then fails, the next run sees an open issue and does nothing,
  // rather than re-commenting on an issue it already reopened.
  await client.patchIssue(pointer.number, { state: "open" });
  await client.addComment(pointer.number, reopenComment());
  const reopenedAt = now();
  writeRecord(store, kind, key, (current) => (current.issue
    ? { ...current, issue: { ...current.issue, reopenedAt } }
    : current));
  result.reopened.push({ kind, key });
};

const supersedeOwnIssue = async ({ record, kind, key, client, store, now, result }) => {
  const at = now();
  // The same guarded expression Task 4 uses: `{ ...null }` is `{}`, so an unconditional spread
  // would store a pointer carrying no issue number.
  const moved = writeRecord(store, kind, key, (current) => ({
    ...current,
    issue: null,
    supersededIssue: current.issue ? { ...current.issue, supersededAt: at, commentedAt: null } : null,
  }));
  result.superseded.push({ kind, key });
  const outcome = await closeSupersededIssue({ record: moved, key, kind, client, store, now });
  if (outcome.closed) result.closed.push({ kind, key });
  if (outcome.error) result.errors.push({ kind, key, error: outcome.error });
};

export const projectProposals = async ({
  store,
  roles = CONFIG.modelRoles,
  client,
  now = Date.now,
  config = CONFIG.reconcile,
} = {}) => {
  if (!store || typeof store.update !== "function" || typeof store.read !== "function") {
    throw new Error("projecting proposals needs a reconciliation store");
  }
  const result = {
    state: null,
    created: [],
    closed: [],
    superseded: [],
    reopened: [],
    conflicts: [],
    errors: [],
    skipped: null,
  };

  // Default OFF, and a strict boolean: a fresh install performs no external write at all, and a
  // truthy string in config cannot turn the publisher on.
  if (config?.gitea?.enabled !== true) {
    result.skipped = "gitea-disabled";
    result.state = store.read();
    return result;
  }
  if (!client) throw new Error("projecting proposals needs a Gitea client");

  // PASS ONE: close issues whose pointer has been MOVED, whatever state the record is in now.
  // Deliberately not filtered by state -- Task 4 hands over role records that have already dropped
  // back to `evidence-pending` for the new candidate, and retired unknown records at `superseded`.
  for (const { kind, key, record } of allRecords(store.read())) {
    if (!record?.supersededIssue) continue;
    const outcome = await closeSupersededIssue({ record, key, kind, client, store, now });
    if (outcome.closed) result.closed.push({ kind, key });
    if (outcome.error) result.errors.push({ kind, key, error: outcome.error });
  }

  // PASS TWO: project live proposals. Only `awaiting-approval` -- an auto-eligible record needs no
  // human, and a blocked one is tracking a source problem rather than waiting on a decision.
  for (const { kind, key, record } of allRecords(store.read())) {
    if (record?.state !== "awaiting-approval") continue;
    try {
      const revision = proposalRevision(record);
      const pointer = record.issue ?? null;

      if (!pointer || !Number.isInteger(pointer.number)) {
        await createProposalIssue({ record, kind, key, client, store, roles, now, result });
        continue;
      }
      if (pointer.revision !== revision) {
        // The proposal changed under an open issue: retire that issue through the one
        // comment-and-close path, then propose the new revision.
        await supersedeOwnIssue({ record, kind, key, client, store, now, result });
        const amended = readRecord(store, kind, key);
        if (amended) await createProposalIssue({ record: amended, kind, key, client, store, roles, now, result });
        continue;
      }

      const issue = await client.getIssue(pointer.number);
      const approved = issue.labels.includes(DECISION_LABELS.approved);
      const rejected = issue.labels.includes(DECISION_LABELS.rejected);

      if (approved && rejected) {
        // Not a race to resolve: two decisions are no decision, and nothing is written anywhere.
        result.conflicts.push({ kind, key });
        continue;
      }
      if (!approved && !rejected) {
        if (issue.state === "closed") {
          await reopenUndecidedIssue({ record, kind, key, client, store, now, result });
        }
        continue;
      }
      await applyDecision({
        decision: approved ? "approved" : "rejected",
        record, kind, key, client, store, now, result,
      });
    } catch (error) {
      // Per-record: one unreachable issue blocks its own proposal and nothing else.
      result.errors.push({ kind, key, error: errorText(error) });
    }
  }

  result.state = store.read();
  return result;
};
