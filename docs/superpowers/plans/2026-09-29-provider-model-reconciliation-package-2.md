# Provider Model Reconciliation Package 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Package 1's dry-run observations into a complete proposal lifecycle: collect official provider evidence through the fleet gateway, decide automatically only for unambiguous same-role successors, and project everything else to one Gitea issue per proposal and one ntfy event per transition — while routing stays untouched.

**Architecture:** A bounded evidence request queue lives in the existing `evidenceRequests` map. A read-only `researcher` agent invoked through `fleet-gateway/smart` writes nothing; a deterministic wrapper validates exactly one JSON object from its stdout and hands it to a locked `evidence-ingest` command. Validated evidence then drives one classification step (`auto-eligible` versus `awaiting-approval`), and two idempotent projections — Gitea issues keyed by proposal revision, ntfy events keyed by delivery marker — reconcile presentation from that ledger. No inventory publication, no probes, no activation.

**Tech Stack:** Node.js 20.18+ ESM, `node:test`, built-in `fs`/`child_process`/`crypto`, global `fetch` for the Gitea API, the existing `opencode-broker-reconcile` CLI and reconciliation ledger.

**Spec:** `/home/dev/opencode-broker/docs/superpowers/specs/2026-09-28-provider-model-reconciliation-design.md`

**Predecessor:** `/home/dev/opencode-broker/docs/superpowers/plans/2026-09-28-provider-model-reconciliation-package-1.md` (shipped in 1.20.0)

## Package 1 facts this plan builds on

Verified in the current tree, not assumed:

- `lib/reconcile-state.js:37-38` validates only TOP-LEVEL keys, and `evidenceRequests` is already one of them. Package 2 populates records and that map **without a schema-version bump**; `RECONCILIATION_STATE_VERSION` stays `1`.
- `createReconciliationStore({ root, now, pid, lockWaitMs })` exposes `read()`, `update(mutator)`, `paths()`. `update()` is the only locked writer and the lock is held only for the callback. Status reads take no lock.
- Every role and unknown record already carries reserved `evidence: []`, `approval: null`, `issue: null`, `notified: null`, plus `transitionID`, `state`, `reason`, `stateChangedAt`, `lastObservedAt`, `transitions`.
- `classifyDryRunCandidate()` produces exactly `evidence-pending`, `blocked-stale`, `blocked-conflict`, `blocked-unresolvable`. `rejected`, `rolled-back`, `superseded` are declared terminal and unused.
- `matchModelRole()` returns `{ status: "known" | "unknown" | "conflict", roleKey?, roleKeys?, role?, version }`; role entries carry `evidenceDomains`.
- `notifyArgv(argv, { title, body, kind })` in `lib/notify.js:12` builds argv with no shell; an empty command array means "no notifier configured" and must skip, not crash.
- CLI today is exactly `dry-run [--json]` and `status [--json]`.

## Global Constraints

- Implement Package 2 only: evidence queue, evidence validator, gateway-routed collector, evidence-driven classification, Gitea projection, ntfy projection, decision commands, docs, release.
- Package 2 must NOT publish inventory, create governed-role holds, alter target eligibility or selection, run probes, count probation, activate or roll back a model, or call any broker control API. Routing behaviour is unchanged and `effects.routingMutated` stays `false`.
- Keep `RECONCILIATION_STATE_VERSION` at `1`. Populate reserved record fields and `evidenceRequests`; do not add or rename a top-level key.
- Every ledger mutation goes through `store.update()`. No command may read-modify-write the ledger outside that lock.
- **The research process boundary, stated exactly.** The researcher receives no credential in its environment and none in its argv, has no write path into the ledger, and its only channel is stdout parsed as one strict JSON object by a separate process. It is NOT filesystem-isolated: the `researcher` agent carries unrestricted `read`, `glob`, and `grep`, and it runs as the same user as the broker, so no file mode can hide a token from it. Same-user isolation is therefore not claimed anywhere in this package. The compensating controls are that the Gitea token is write-scoped to issues on one repository, and that `ingestEvidence()` refuses any payload whose serialized form contains the token value. A hostile model on a read-capable agent is a fleet-wide trust question and is out of scope here.
- Spec lines 220-224 say packages 1 and 2 call no external publisher, while spec lines 558-559 assign Package 2 the Gitea publisher and ntfy projection. This plan takes the decomposition reading deliberately: the publishers are built here and ship default-OFF (`reconcile.gitea.enabled: false`, no notify command configured), so a fresh install performs no external write until Package 4 turns them on. Reviewers must not treat that as a spec violation.
- The spec names `evidence-claim`, `evidence-ingest`, and `evidence-fail` as `opencode-broker-reconcile` subcommands. This plan deliberately substitutes one `opencode-broker-evidence` binary that claims, spawns, validates, and ingests in a single process under the same lock, because splitting them across processes would hand the model's own output a command that writes the ledger.
- Every LLM call goes through the fleet gateway: the collector invokes `opencode run --agent researcher --model fleet-gateway/smart`. Never `claude -p`, never a provider API directly.
- Evidence is accepted only from the matched role's `evidenceDomains`, over HTTPS, naming the exact candidate model ID. A newer release date is never sufficient for automatic promotion.
- Only `successor`, `recommended-replacement`, `new-role`, and `role-change` are policy claim types. `stronger`, `faster`, and `cheaper` may be stored as supporting quotes and must never drive automation.
- Automatic classification may reach `auto-eligible` only for a known-role successor. Unknown roles, conflicts, and contradictions reach `awaiting-approval` and wait for a human decision.
- Gitea decision labels are authoritative over issue text. Two decision labels at once is a conflict that changes nothing. Closing an undecided issue is not approval.
- Projections are idempotent **across completed runs**: re-running creates no duplicate issue, comment, or notification, deduped by proposal revision and delivery marker. This guarantee is deliberately scoped to completed runs. A crash between an external write and the ledger marker that records it can duplicate on restart, because closing that window needs either a Gitea issue search keyed by proposal revision or an ntfy idempotency key, and neither is in this package. State the limit in the README rather than implying crash-safety this design does not have; the blast radius is one extra issue or push, and the decision label logic is unaffected.
- Secrets: the Gitea token is read once from a deployment-provisioned mode-0600 drop file, never from `rbw`, never logged, never in argv, never in issue text or ledger state.
- Keep `reviewed-models.json` intact. Its deletion and the one-time migration remain Package 4.
- No systemd unit, timer, or `fleet-core` change in this package; Package 4 deploys the collector and projection schedule.
- Test command shape is `node --experimental-test-module-mocks --test ...`; full suite is `npm test`.
- No emoji and no secrets in source, comments, tests, docs, or commit messages.
- Commit each task separately. Do not push, restart services, or edit deployment config.
- Package 2 is a minor feature release: bump `package.json`, `package-lock.json`, and `CHANGELOG.md` from 1.20.0 to 1.21.0 only in the final task, after all implementation tests pass.

## Review Focus

- Two decision labels on one issue must change nothing, rather than letting whichever was read first win; Task 5 pins this.
- An issue closed with no decision label must never be read as approval, and must be reopened exactly once rather than every run; Task 5 pins this.
- Evidence naming a model ID, provider, or domain that is not the candidate's must be rejected outright, never coerced or partially accepted; Task 2 pins this.
- A second projection run over unchanged state must produce no duplicate issue, comment, or ntfy push; Tasks 5 and 6 pin this.
- The researcher process must never hold a credential or a ledger write path, and a failed or malicious stdout must not become stored evidence; Tasks 2 and 3 pin this.

---

### Task 1: Queue bounded evidence requests in the ledger

**Files:**
- Create: `lib/reconcile-evidence.js`
- Modify: `lib/model-reconcile.js` (the locked update inside `runDryReconciliation`)
- Create: `tests/reconcile-evidence-queue.test.mjs`

**Interfaces:**
- Produces: `EVIDENCE_CLAIM_LEASE_MS = 30 * 60_000`
- Produces: `EVIDENCE_RETRY_COOLDOWN_MS = 24 * 3600_000`
- Produces: `evidenceRequestKey(record): string` — the record's `transitionID`
- Produces: `candidateRevision(record): string` — sha256-hex-24 over provider, model, release date, and the group key resolved by `candidateIdentity()` below (`groupKey` first, falling back to `roleKey`), so a changed candidate invalidates old evidence while an operator's `amend --role` does not
- Produces: `enqueueEvidenceRequests(state, { now }): { state, enqueued, skipped }`
- Produces: `claimEvidenceRequest(state, { now, pid }): { state, claim }` returning `claim: null` when nothing is due
- Produces: `recordEvidenceFailure(state, transitionID, { error, now }): state`
- Produces: `expireEvidenceClaims(state, { now }): state`
- Consumes later: Task 2 validates before ingest; Task 3 drives claim and failure from the wrapper; Task 4 reads stored evidence

- [ ] **Step 1: Write the failing queue tests**

Create `tests/reconcile-evidence-queue.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_CLAIM_LEASE_MS,
  EVIDENCE_RETRY_COOLDOWN_MS,
  candidateRevision,
  claimEvidenceRequest,
  enqueueEvidenceRequests,
  expireEvidenceClaims,
  recordEvidenceFailure,
} from "../lib/reconcile-evidence.js";
import { emptyReconciliationState } from "../lib/reconcile-state.js";

const NOW = 1_800_000_000_000;

const pending = (overrides = {}) => ({
  transitionID: "aaaaaaaaaaaaaaaaaaaaaaaa",
  roleKey: "openai:gpt-sol",
  providerID: "openai",
  roleID: "gpt-sol",
  candidateModelID: "gpt-6-sol",
  candidateReleaseDate: "2026-09-22",
  incumbentModelID: "gpt-5.6-sol",
  state: "evidence-pending",
  evidence: [],
  approval: null,
  ...overrides,
});

const withRole = (record) => ({ ...emptyReconciliationState(), roles: { [record.roleKey]: record } });

test("only evidence-pending records are enqueued, once each", () => {
  const first = enqueueEvidenceRequests(withRole(pending()), { now: () => NOW });
  assert.deepEqual(first.enqueued, ["aaaaaaaaaaaaaaaaaaaaaaaa"]);
  const request = first.state.evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"];
  assert.equal(request.status, "pending");
  assert.equal(request.providerID, "openai");
  assert.equal(request.candidateModelID, "gpt-6-sol");
  assert.equal(request.incumbentModelID, "gpt-5.6-sol");
  assert.equal(request.attempts, 0);
  assert.equal(request.claimedAt, null);

  const second = enqueueEvidenceRequests(first.state, { now: () => NOW + 1000 });
  assert.deepEqual(second.enqueued, []);
  assert.deepEqual(Object.keys(second.state.evidenceRequests), ["aaaaaaaaaaaaaaaaaaaaaaaa"]);
});

test("blocked and decided records are never enqueued", () => {
  for (const state of ["blocked-stale", "blocked-unresolvable", "blocked-conflict", "rejected", "superseded"]) {
    const result = enqueueEvidenceRequests(withRole(pending({ state })), { now: () => NOW });
    assert.deepEqual(result.enqueued, []);
    assert.deepEqual(result.state.evidenceRequests, {});
  }
});

test("a claim leases one request and a second claim finds nothing", () => {
  const queued = enqueueEvidenceRequests(withRole(pending()), { now: () => NOW }).state;
  const first = claimEvidenceRequest(queued, { now: () => NOW, pid: 4242 });
  assert.equal(first.claim.transitionID, "aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(first.claim.candidateModelID, "gpt-6-sol");
  assert.deepEqual(first.claim.evidenceDomains, undefined,
    "the claim carries identity only; allowed domains come from the registry at validation time");
  assert.equal(first.state.evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"].status, "claimed");

  const second = claimEvidenceRequest(first.state, { now: () => NOW + 1000, pid: 4243 });
  assert.equal(second.claim, null);
});

test("an expired claim is reclaimable, a live one is not", () => {
  const queued = enqueueEvidenceRequests(withRole(pending()), { now: () => NOW }).state;
  const claimed = claimEvidenceRequest(queued, { now: () => NOW, pid: 4242 }).state;

  const early = expireEvidenceClaims(claimed, { now: () => NOW + EVIDENCE_CLAIM_LEASE_MS });
  assert.equal(early.evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"].status, "claimed");

  const late = expireEvidenceClaims(claimed, { now: () => NOW + EVIDENCE_CLAIM_LEASE_MS + 1 });
  assert.equal(late.evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"].status, "pending");
  assert.equal(claimEvidenceRequest(late, { now: () => NOW, pid: 1 }).claim.transitionID,
    "aaaaaaaaaaaaaaaaaaaaaaaa");
});

test("a failure records the error and holds the request for the cooldown", () => {
  const queued = enqueueEvidenceRequests(withRole(pending()), { now: () => NOW }).state;
  const claimed = claimEvidenceRequest(queued, { now: () => NOW, pid: 4242 }).state;
  const failed = recordEvidenceFailure(claimed, "aaaaaaaaaaaaaaaaaaaaaaaa",
    { error: "researcher exited 1", now: () => NOW });
  const request = failed.evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"];
  assert.equal(request.status, "failed");
  assert.equal(request.attempts, 1);
  assert.equal(request.lastError, "researcher exited 1");
  assert.equal(request.retryAfter, NOW + EVIDENCE_RETRY_COOLDOWN_MS);

  assert.equal(claimEvidenceRequest(failed, { now: () => NOW + EVIDENCE_RETRY_COOLDOWN_MS, pid: 1 }).claim, null);
  assert.equal(claimEvidenceRequest(failed, { now: () => NOW + EVIDENCE_RETRY_COOLDOWN_MS + 1, pid: 1 })
    .claim.transitionID, "aaaaaaaaaaaaaaaaaaaaaaaa");
});

test("a changed candidate invalidates the request and its revision", () => {
  const before = pending();
  const after = pending({ candidateModelID: "gpt-7-sol", candidateReleaseDate: "2027-01-05" });
  assert.notEqual(candidateRevision(before), candidateRevision(after));

  const queued = enqueueEvidenceRequests(withRole(before), { now: () => NOW }).state;
  const moved = { ...queued, roles: { "openai:gpt-sol": after } };
  const requeued = enqueueEvidenceRequests(moved, { now: () => NOW + 5000 });
  assert.deepEqual(requeued.enqueued, ["aaaaaaaaaaaaaaaaaaaaaaaa"]);
  assert.equal(requeued.state.evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"].candidateModelID, "gpt-7-sol");
  assert.equal(requeued.state.evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"].attempts, 0);
});

test("unknown-role records are enqueued alongside role records", () => {
  const state = {
    ...emptyReconciliationState(),
    unknown: {
      bbbbbbbbbbbbbbbbbbbbbbbb: {
        transitionID: "bbbbbbbbbbbbbbbbbbbbbbbb", groupKey: "example:example-new",
        providerID: "example", modelID: "new-role", family: "example-new",
        releaseDate: "2026-09-01", state: "evidence-pending", evidence: [], approval: null,
      },
    },
  };
  const result = enqueueEvidenceRequests(state, { now: () => NOW });
  assert.deepEqual(result.enqueued, ["bbbbbbbbbbbbbbbbbbbbbbbb"]);
  assert.equal(result.state.evidenceRequests.bbbbbbbbbbbbbbbbbbbbbbbb.kind, "unknown");
});
```

- [ ] **Step 2: Run the tests and verify the module is absent**

```bash
node --experimental-test-module-mocks --test tests/reconcile-evidence-queue.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/reconcile-evidence.js`.

- [ ] **Step 3: Implement the queue as pure state transitions**

Every exported function takes a state and returns a new state; none reads the clock or the filesystem directly. Request records carry exactly:

```js
{
  transitionID, kind: "role" | "unknown",
  roleKey: string | null, roleID: string | null,
  providerID, candidateModelID, incumbentModelID: string | null,
  candidateRevision, status: "pending" | "claimed" | "failed",
  attempts, claimedAt: number | null, claimedBy: number | null,
  retryAfter: number | null, lastError: string | null,
  enqueuedAt, updatedAt,
}
```

**Field mapping, because role and unknown records do not share names.** Package 1 writes role records with `candidateModelID`, `candidateReleaseDate`, `roleKey`, `roleID`, `incumbentModelID`, and unknown records with `modelID`, `releaseDate`, `groupKey`, no role fields and no incumbent (`lib/model-reconcile.js:610-624` versus `:652-666`). Both the request builder and `candidateRevision()` must read through one normalizer:

```js
const candidateIdentity = (record) => ({
  providerID: record.providerID,
  modelID: record.candidateModelID ?? record.modelID,
  releaseDate: record.candidateReleaseDate ?? record.releaseDate ?? "",
  // groupKey FIRST, deliberately. An unknown record keyed by its provider/family must keep the
  // same candidate revision after `amend --role` adds a roleKey, or its already-collected evidence
  // would read as stale and the proposal would fall back to evidence-pending on the next run.
  // Role records have no groupKey, so they resolve to roleKey unchanged.
  groupKey: record.groupKey ?? record.roleKey,
  roleID: record.roleID ?? null,
  incumbentModelID: record.incumbentModelID ?? null,
});
```

`candidateRevision()` therefore answers "is this still the same candidate from the same line", and is unaffected by an operator's mapping decision. `proposalRevision()` in Task 5 is the one that folds in the amended role and tiers, so an `amend` supersedes the open issue without invalidating the evidence.

`candidateRevision()` hashes exactly `providerID`, `modelID`, `releaseDate`, and `groupKey` from that normalizer, so an unknown record gets a revision as specific as a role record's. A revision computed over `undefined` is a defect, not an accepted default: throw when `modelID` or `groupKey` is missing.

Rules:

- enqueue only records whose `state === "evidence-pending"` and whose `evidence` array is empty;
- key requests by `transitionID`, and reset `attempts`, `status`, `lastError`, and `retryAfter` when `candidateRevision` changes;
- `claimEvidenceRequest()` picks the oldest eligible request by `enqueuedAt`, then `transitionID`, skipping `claimed` requests and `failed` requests whose `retryAfter` has not strictly passed;
- `expireEvidenceClaims()` returns a `claimed` request to `pending` only when `now - claimedAt > EVIDENCE_CLAIM_LEASE_MS`; equality is still live;
- truncate `lastError` to 500 characters;
- drop a request whose record no longer exists or is no longer `evidence-pending`, so the queue cannot outlive its candidate — EXCEPT one whose `status` is `claimed` and whose lease is still live, which is left alone so a collector holding it can still report;
- `recordEvidenceFailure()` for a transition ID with no surviving request is a no-op that returns the state unchanged, never a throw: the dry run may legitimately have dropped it while the collector was running.

In `runDryReconciliation()`, call `enqueueEvidenceRequests()` and `expireEvidenceClaims()` inside the existing `store.update()` callback, and add `evidenceRequests: { pending, claimed, failed }` counts to the report. Do not add a network or subprocess call to the dry run.

- [ ] **Step 4: Run the queue and Package 1 engine tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-evidence-queue.test.mjs tests/model-reconcile.test.mjs tests/reconcile-state.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Prove the tests fail without the implementation, then restore green**

```bash
git add tests/reconcile-evidence-queue.test.mjs
git stash push -u --keep-index -m "red-green evidence queue"
node --experimental-test-module-mocks --test tests/reconcile-evidence-queue.test.mjs
```

Expected: FAIL for the missing module. Restore:

```bash
git stash pop
git --no-pager status --short
node --experimental-test-module-mocks --test tests/reconcile-evidence-queue.test.mjs tests/model-reconcile.test.mjs
```

Expected: no unmerged entries, tests PASS.

- [ ] **Step 6: Commit the evidence queue**

```bash
git add lib/reconcile-evidence.js lib/model-reconcile.js tests/reconcile-evidence-queue.test.mjs
git commit -m "feat: queue bounded model evidence requests"
```

### Task 2: Validate official evidence before it can be stored

**Files:**
- Modify: `lib/reconcile-evidence.js`
- Create: `tests/reconcile-evidence-validate.test.mjs`

**Interfaces:**
- Produces: `POLICY_CLAIM_TYPES = ["successor", "recommended-replacement", "new-role", "role-change"]`
- Produces: `SUPPORTING_CLAIM_TYPES = ["stronger", "faster", "cheaper"]`
- Produces: `EVIDENCE_MAX_BYTES = 64 * 1024`
- Produces: `parseEvidencePayload(text): object` — exactly one JSON value, size-capped, no trailing content
- Produces: `allowedEvidenceDomains(request, roles): readonly string[]` — the matched role's `evidenceDomains` for a role request, and for an unknown request the sorted union of every registry role domain belonging to that same `providerID`
- Produces: `validateEvidencePayload(payload, { request, roles, now }): { claims, rejected, contradiction }` throwing on a payload that cannot be trusted at all
- Produces: `ingestEvidence(state, transitionID, payload, { roles, now, forbiddenStrings }): { state, accepted }`
- Consumes: `candidateRevision()` from Task 1
- Consumes later: Task 3 pipes wrapper stdout in; Task 4 classifies from stored claims

- [ ] **Step 1: Write the failing validator tests**

Create `tests/reconcile-evidence-validate.test.mjs` covering, at minimum:

```js
const payload = (overrides = {}) => ({
  providerID: "openai",
  candidateModelID: "gpt-6-sol",
  incumbentModelID: "gpt-5.6-sol",
  roleID: "gpt-sol",
  claims: [{
    claimType: "successor",
    sourceURL: "https://developers.openai.com/api/docs/guides/latest-model",
    exactQuote: "GPT-5.6 Sol maps to GPT-6 Sol.",
    retrievedAt: "2026-09-29T00:00:00Z",
  }],
  ...overrides,
});

test("a well-formed official successor claim is accepted", () => {
  const { claims, rejected } = validateEvidencePayload(payload(), { request, role, now: () => NOW });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claimType, "successor");
  assert.equal(claims[0].policy, true);
  assert.equal(typeof claims[0].contentHash, "string");
  assert.deepEqual(rejected, []);
});

test("a claim for a different model is rejected, never coerced", () => {
  const { claims, rejected } = validateEvidencePayload(
    payload({ candidateModelID: "gpt-6-luna" }), { request, roles: TEST_ROLES, now: () => NOW });
  assert.deepEqual(claims, []);
  assert.match(rejected.join(" "), /candidate/);
});

test("ingesting a payload with nothing acceptable throws and leaves the request claimable", () => {
  const state = freshClaimedState();
  assert.throws(() => ingestEvidence(state, "aaaaaaaaaaaaaaaaaaaaaaaa",
    payload({ candidateModelID: "gpt-6-luna" }), { roles: TEST_ROLES, now: () => NOW }),
    /no acceptable evidence/);
  assert.ok(state.evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"],
    "the request must survive so the collector can record a failure against it");
  assert.deepEqual(state.roles["openai:gpt-sol"].evidence, []);
});

test("an off-allowlist or non-HTTPS source is rejected", () => {
  for (const url of [
    "https://example.invalid/gpt-6-sol",
    "http://developers.openai.com/api/docs/guides/latest-model",
    "https://developers.openai.com.attacker.test/x",
  ]) {
    const { claims, rejected } = validateEvidencePayload(
      payload({ claims: [{ ...payload().claims[0], sourceURL: url }] }),
      { request, role, now: () => NOW });
    assert.deepEqual(claims, []);
    assert.equal(rejected.length, 1);
  }
});

test("comparative claims are stored but never policy", () => {
  const { claims } = validateEvidencePayload(payload({
    claims: [{ ...payload().claims[0], claimType: "faster" }],
  }), { request, role, now: () => NOW });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].policy, false);
});

test("contradictory policy claims are kept and flagged, not silently reduced", () => {
  const { claims, contradiction } = validateEvidencePayload(payload({
    claims: [
      { ...payload().claims[0], claimType: "successor" },
      { ...payload().claims[0], claimType: "role-change", exactQuote: "Sol is no longer the flagship." },
    ],
  }), { request, role, now: () => NOW });
  assert.equal(claims.length, 2);
  assert.equal(contradiction, true);
});

test("oversized, multi-value, and trailing-content stdout are all refused", () => {
  assert.throws(() => parseEvidencePayload("{}{}"), /exactly one JSON/);
  assert.throws(() => parseEvidencePayload('{"a":1} trailing'), /exactly one JSON/);
  assert.throws(() => parseEvidencePayload("x".repeat(EVIDENCE_MAX_BYTES + 1)), /too large/);
  assert.throws(() => parseEvidencePayload("not json"), /not valid JSON/);
});

test("ingest stores accepted claims, stamps the revision, and clears the request", () => {
  const result = ingestEvidence(claimedState, "aaaaaaaaaaaaaaaaaaaaaaaa", payload(),
    { roles: TEST_ROLES, now: () => NOW });
  const record = result.state.roles["openai:gpt-sol"];
  assert.equal(record.evidence.length, 1);
  assert.equal(record.evidenceRevision, candidateRevision(record));
  assert.equal(result.state.evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"], undefined);
});

test("evidence for a stale candidate revision is refused", () => {
  const moved = { ...claimedState, roles: { "openai:gpt-sol": { ...pendingRecord, candidateModelID: "gpt-7-sol" } } };
  assert.throws(() => ingestEvidence(moved, "aaaaaaaaaaaaaaaaaaaaaaaa", payload(),
    { roles: TEST_ROLES, now: () => NOW }), /revision/);
});
```

Also assert:

- an unknown-role request accepts a `new-role` claim sourced from any domain in its provider's union allowlist, and rejects one from another provider's domain;
- a `successor` claim naming no incumbent is rejected for a role that has one;
- `contradiction` survives ingest as `evidenceContradiction` on the record;
- a payload containing the configured Gitea token anywhere in it is refused, and nothing is written:

```js
test("a payload carrying the write token is refused and stores nothing", () => {
  assert.throws(() => ingestEvidence(claimedState, "aaaaaaaaaaaaaaaaaaaaaaaa",
    payload({ claims: [{ ...payload().claims[0], exactQuote: `leaked test-gitea-token here now` }] }),
    { roles: TEST_ROLES, now: () => NOW, forbiddenStrings: ["test-gitea-token"] }), /forbidden/i);
  assert.deepEqual(claimedState.roles["openai:gpt-sol"].evidence, []);
});
```

- [ ] **Step 2: Run the validator tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-evidence-validate.test.mjs
```

Expected: FAIL for the missing exports.

- [ ] **Step 3: Implement parsing and validation**

`parseEvidencePayload(text)`:

- refuse input over `EVIDENCE_MAX_BYTES` by byte length;
- `JSON.parse` the whole trimmed string so a second value or trailing content throws;
- require a plain object.

`validateEvidencePayload(payload, { request, roles, now })`:

- require `providerID` and `candidateModelID` to equal the request's own values exactly; a mismatch rejects the whole payload;
- require `roleID` to equal the request's `roleID` when the request has one; for an unknown request (`roleID: null`) the payload's `roleID` is advisory only and is stored on the claim without granting policy force;
- take the source allowlist from `allowedEvidenceDomains(request, roles)`, so an unknown-role candidate is checked against its own provider's known domains rather than being unverifiable and therefore permanently stuck;
- validate each claim independently and collect per-claim rejection reasons rather than throwing;
- require `claimType` in the policy or supporting list; mark `policy: true` only for the policy list;
- parse `sourceURL` with `new URL()`, require `https:`, and require the hostname to equal an `evidenceDomains` entry or be a dot-suffixed subdomain of one — never a substring match;
- require `exactQuote` of 10 to 1,000 characters, and store it verbatim;
- require `retrievedAt` to be an ISO timestamp not in the future by more than 5 minutes;
- compute `contentHash` as sha256 over URL plus quote so a later page edit cannot rewrite history;
- set `contradiction: true` when two policy claims disagree about the role's continuity;
- cap the accepted claim list at 10 entries.

**Zero accepted claims is a failure, not a success.** `validateEvidencePayload()` returns `{ claims: [], rejected, contradiction }` for a payload whose every claim was rejected, and returns rather than throwing so the caller can report each reason. `ingestEvidence()` then throws `no acceptable evidence` before mutating anything when `claims` is empty — including the whole-payload identity mismatch case. That ordering is load-bearing: if ingest treated an empty result as success it would delete the request, and `recordEvidenceFailure()` is a deliberate no-op once the request is gone (see Task 1), so the record would be stranded at `evidence-pending` with no evidence and nothing queued to fetch any. The collector's failure path therefore always has a live request to mark.

`ingestEvidence()` refuses when the record is missing, is no longer `evidence-pending`, or its `candidateRevision()` differs from the request's stored revision. It also refuses when the serialized payload contains any entry of `forbiddenStrings` — the caller passes the Gitea token when one is configured — so a credential that reached the model's output can never be persisted into the ledger or an issue body. On success it appends validated claims, sets `evidenceRevision`, `evidenceCollectedAt`, and **`evidenceContradiction`** (the validator's `contradiction` flag, persisted because Task 4 branches on it and a recomputation from the stored list is a second source of truth), and deletes the request. It never sets `state`; Task 4 owns classification.

- [ ] **Step 4: Run validator, queue, and state tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-evidence-validate.test.mjs tests/reconcile-evidence-queue.test.mjs tests/reconcile-state.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Prove red, then restore green**

```bash
git add tests/reconcile-evidence-validate.test.mjs
git stash push -u --keep-index -m "red-green evidence validator"
node --experimental-test-module-mocks --test tests/reconcile-evidence-validate.test.mjs
git stash pop
git --no-pager status --short
node --experimental-test-module-mocks --test tests/reconcile-evidence-validate.test.mjs tests/reconcile-evidence-queue.test.mjs
```

Expected: FAIL while stashed, then no unmerged entries and PASS.

- [ ] **Step 6: Commit the validator**

```bash
git add lib/reconcile-evidence.js tests/reconcile-evidence-validate.test.mjs
git commit -m "feat: validate official model evidence before storage"
```

### Task 3: Collect evidence through the gateway with a credential-free researcher

**Files:**
- Create: `bin/opencode-broker-evidence`
- Create: `lib/reconcile-collector.js`
- Create: `lib/reconcile-secrets.js`
- Modify: `lib/config.js`
- Create: `tests/reconcile-collector.test.mjs`

**Interfaces:**
- Produces: `readGiteaTokenIfPresent(tokenPath): string | null` in `lib/reconcile-secrets.js` — the one trusted token reader, returning null when the file is absent and throwing when its mode is group- or world-readable. Task 5's `createGiteaClient()` imports it rather than re-reading the file, so there is exactly one reader in the package.
- Produces: `CONFIG.reconcile: { gitea: { baseURL, owner, repo, tokenPath, enabled }, notifyCommand }` with `notifyCommand` falling back to `CONFIG.watch.notifyCommand`. Defined here because this is the earliest consumer; Task 5 and Task 6 read the same block.
- Produces: `EVIDENCE_JOB_TIMEOUT_MS = 20 * 60_000`
- Produces: `researcherArgv({ model }): string[]` — `["run", "--agent", "researcher", "--model", model]`
- Produces: `buildEvidencePrompt(claim, { allowedDomains }): string` — takes the resolved domain list, not a role, because an unknown-role claim has no matched role and must still be collectable
- Produces: `collectEvidenceOnce({ store, roles, spawn, now, pid, model, timeoutMs, forbiddenStrings }): CollectorResult`
- Produces CLI: `opencode-broker-evidence [--json] [--max N]`
- Exit `0`: a request was collected, or nothing was due
- Exit `1`: the collection failed after being recorded against the request
- Exit `2`: invalid usage

- [ ] **Step 1: Write the failing collector tests**

Use an injected `spawn` double; never run a real subprocess or reach the network.

```js
test("the researcher runs through the gateway, read-only, with no credential in its environment", () => {
  const calls = [];
  const result = collectEvidenceOnce({
    store, roles: TEST_ROLES, now: () => NOW, pid: 4242,
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0, stdout: JSON.stringify(PAYLOAD), stderr: "" };
    },
  });
  assert.equal(result.collected, true);
  assert.deepEqual(calls[0].args.slice(0, 5),
    ["run", "--agent", "researcher", "--model", "fleet-gateway/smart"]);
  const env = calls[0].options.env;
  for (const key of Object.keys(env)) {
    assert.doesNotMatch(key, /TOKEN|SECRET|KEY|PASSWORD/i, `${key} must not reach the researcher`);
  }
  assert.equal(calls[0].options.timeout, EVIDENCE_JOB_TIMEOUT_MS);
  assert.equal(store.read().roles["openai:gpt-sol"].evidence.length, 1);
});

test("nothing due is a success, not an error, and spawns nothing", () => {
  const result = collectEvidenceOnce({ store: emptyStore, roles: TEST_ROLES, now: () => NOW, pid: 1,
    spawn: () => { throw new Error("must not spawn"); } });
  assert.equal(result.collected, false);
  assert.equal(result.reason, "nothing-due");
});

test("a non-zero exit, a timeout, and unparseable stdout each record a failure and keep the request", () => {
  for (const outcome of [
    { status: 1, stdout: "", stderr: "researcher failed" },
    { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), status: null, stdout: "" },
    { status: 0, stdout: "I could not find anything.", stderr: "" },
  ]) {
    const store = freshClaimedStore();
    const result = collectEvidenceOnce({ store, roles: TEST_ROLES, now: () => NOW, pid: 1,
      spawn: () => outcome });
    assert.equal(result.collected, false);
    const request = store.read().evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"];
    assert.equal(request.status, "failed");
    assert.equal(request.attempts, 1);
    assert.ok(request.lastError.length > 0);
    assert.deepEqual(store.read().roles["openai:gpt-sol"].evidence, []);
  }
});

test("rejected evidence is a failure, and nothing partial is stored", () => {
  const store = freshClaimedStore();
  const result = collectEvidenceOnce({ store, roles: TEST_ROLES, now: () => NOW, pid: 1,
    spawn: () => ({ status: 0, stdout: JSON.stringify({ ...PAYLOAD, candidateModelID: "gpt-6-luna" }) }) });
  assert.equal(result.collected, false);
  assert.deepEqual(store.read().roles["openai:gpt-sol"].evidence, []);
});

test("the prompt names the candidate, the incumbent, and only the allowed domains", () => {
  const prompt = buildEvidencePrompt(CLAIM, {
    allowedDomains: allowedEvidenceDomains(ROLE_REQUEST, TEST_ROLES),
  });
  assert.match(prompt, /gpt-6-sol/);
  assert.match(prompt, /gpt-5\.6-sol/);
  assert.match(prompt, /developers\.openai\.com/);
  assert.doesNotMatch(prompt, /anthropic\.com/);
  assert.match(prompt, /exactly one JSON object/i);
});

test("an unknown-role request is collectable against its provider's domain union", () => {
  const calls = [];
  const store = freshUnknownClaimedStore();
  const result = collectEvidenceOnce({
    store, roles: TEST_ROLES, now: () => NOW, pid: 1,
    spawn: (file, args) => {
      calls.push(args.at(-1));
      return { status: 0, stdout: JSON.stringify(UNKNOWN_NEW_ROLE_PAYLOAD) };
    },
  });
  assert.equal(result.collected, true);
  assert.match(calls[0], /developers\.openai\.com/);
  assert.equal(store.read().unknown.bbbbbbbbbbbbbbbbbbbbbbbb.evidence.length, 1);
});
```

- [ ] **Step 2: Run the collector tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-collector.test.mjs
```

Expected: FAIL for the missing module.

- [ ] **Step 3: Implement the collector**

`collectEvidenceOnce()`:

1. `store.update()` once to expire stale claims and claim one request; return `{ collected: false, reason: "nothing-due" }` when `claim` is null;
2. resolve the allowlist with `allowedEvidenceDomains(claim, roles)` — a role request gets its role's domains, an unknown request gets its provider's union — and build the prompt from the claim plus that list, naming the exact candidate, the incumbent, the allowed domains, the four policy claim types, and the required single-JSON-object output shape. The collector never reaches into the registry for a role the request may not have;
3. spawn `opencode` with `researcherArgv({ model })` and the prompt as the final argument, `encoding: "utf8"`, `timeout: timeoutMs`, and a **scrubbed environment**: copy only `PATH`, `HOME`, `LANG`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, and drop every variable matching `/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i`;
4. on a spawn error, a non-zero status, or a signal, record the failure through `recordEvidenceFailure()` in a second `store.update()` and return;
5. otherwise `parseEvidencePayload()` then `ingestEvidence()` inside one `store.update()`, **passing `forbiddenStrings` through**; any throw becomes a recorded failure with the reason;
6. never hold the lock across the subprocess.

**Wire the token-leak control or it is decoration.** `ingestEvidence()` only rejects a leaked credential if the caller actually hands it one, so `bin/opencode-broker-evidence` resolves `forbiddenStrings` once at startup with `readGiteaTokenIfPresent(CONFIG.reconcile.gitea.tokenPath)` and passes `[token]` (or `[]` when no token is deployed) into every `collectEvidenceOnce()` call. The wrapper process holding the token is correct and intended — it is our deterministic code, not the model. The model still never sees it: the value is not in the child's argv and the env scrub in step 3 removes anything matching `/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i`. Pin all three properties in one test:

```js
test("a token-bearing stdout is refused, and the token never reaches the child", () => {
  const store = freshClaimedStore();
  let childEnv;
  let childArgv;
  const result = collectEvidenceOnce({
    store, roles: TEST_ROLES, now: () => NOW, pid: 1,
    forbiddenStrings: ["test-gitea-token"],
    spawn: (file, args, options) => {
      childEnv = options.env;
      childArgv = args;
      return { status: 0, stdout: JSON.stringify(payloadQuoting("test-gitea-token")) };
    },
  });
  assert.equal(result.collected, false);
  assert.match(result.reason, /forbidden/i);
  assert.deepEqual(store.read().roles["openai:gpt-sol"].evidence, []);
  assert.equal(store.read().evidenceRequests["aaaaaaaaaaaaaaaaaaaaaaaa"].status, "failed");
  assert.equal(Object.values(childEnv).some((value) => String(value).includes("test-gitea-token")), false);
  assert.equal(childArgv.join(" ").includes("test-gitea-token"), false);
});
```

The prompt must instruct the researcher to print exactly one JSON object and nothing else, and to omit a claim it cannot support with a quote from an allowed domain.

`bin/opencode-broker-evidence` parses only `--json` and `--max N` (default 1, maximum 5), resolves `forbiddenStrings` once as described above, loops `collectEvidenceOnce()` up to `N` times, stops early on `nothing-due`, prints a JSON or human summary, and exits per the table above. It contains no validation or state logic, and it never prints the token or its path contents.

- [ ] **Step 4: Run collector, evidence, and CLI tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-collector.test.mjs tests/reconcile-evidence-validate.test.mjs tests/reconcile-evidence-queue.test.mjs tests/reconcile-cli.test.mjs tests/config-parse.test.mjs
```

Expected: PASS, including the new `CONFIG.reconcile` defaults.

- [ ] **Step 5: Prove red, then restore green**

```bash
git add tests/reconcile-collector.test.mjs
git stash push -u --keep-index -m "red-green evidence collector"
node --experimental-test-module-mocks --test tests/reconcile-collector.test.mjs
git stash pop
git --no-pager status --short
node --experimental-test-module-mocks --test tests/reconcile-collector.test.mjs
```

Expected: FAIL while stashed, then PASS with no unmerged entries.

- [ ] **Step 6: Commit the collector**

```bash
git add bin/opencode-broker-evidence lib/reconcile-collector.js lib/reconcile-secrets.js lib/config.js tests/reconcile-collector.test.mjs
git commit -m "feat: collect model evidence through the gateway"
```

### Task 4: Classify validated evidence into eligibility or approval

**Files:**
- Modify: `lib/model-reconcile.js`
- Create: `tests/reconcile-classify.test.mjs`

**Interfaces:**
- Produces: `classifyEvidencedRecord(record, { roles }): { state, reason }`
- Produces: `applyEvidenceClassification(state, { roles, now }): { state, changed }`
- Produces: `POST_OBSERVATION_STATES = ["auto-eligible", "awaiting-approval", "approved"]`
- Modifies: `heldRecord()` and `mergeObservation()` in `lib/model-reconcile.js` so an advanced record survives re-observation
- Modifies: `runDryReconciliation()` to apply classification inside its existing locked update
- States added: `auto-eligible`, `awaiting-approval`
- Consumes later: Task 5 projects `awaiting-approval`; Task 6 notifies on every transition

- [ ] **Step 1: Write the failing classification tests**

Assert exactly this decision table:

```js
test("a known-role successor with an unambiguous official claim becomes auto-eligible", () => {
  const { state, reason } = classifyEvidencedRecord(roleRecord({
    evidence: [policyClaim("successor")],
  }), { roles: TEST_ROLES });
  assert.equal(state, "auto-eligible");
  assert.match(reason, /successor/);
});

test("recommended-replacement is equally sufficient for a known role", () => {
  assert.equal(classifyEvidencedRecord(roleRecord({
    evidence: [policyClaim("recommended-replacement")] }), { roles: TEST_ROLES }).state, "auto-eligible");
});

test("supporting claims alone are never enough", () => {
  for (const type of ["stronger", "faster", "cheaper"]) {
    const { state, reason } = classifyEvidencedRecord(roleRecord({
      evidence: [supportingClaim(type)] }), { roles: TEST_ROLES });
    assert.equal(state, "awaiting-approval");
    assert.match(reason, /no official successor/i);
  }
});

test("a contradiction, a role-change, or an unknown role requires approval", () => {
  assert.equal(classifyEvidencedRecord(roleRecord({
    evidence: [policyClaim("successor"), policyClaim("role-change")] }),
    { roles: TEST_ROLES }).state, "awaiting-approval");
  assert.equal(classifyEvidencedRecord(unknownRecord({
    evidence: [policyClaim("new-role")] }), { roles: TEST_ROLES }).state, "awaiting-approval");
});

test("a record with no evidence keeps waiting rather than being decided", () => {
  assert.equal(classifyEvidencedRecord(roleRecord({ evidence: [] }), { roles: TEST_ROLES }).state,
    "evidence-pending");
});

test("an existing decision or terminal state is never reclassified", () => {
  for (const record of [
    roleRecord({ state: "rejected", evidence: [policyClaim("successor")] }),
    roleRecord({ state: "approved", approval: { decision: "approved" }, evidence: [policyClaim("successor")] }),
    roleRecord({ state: "rolled-back", evidence: [policyClaim("successor")] }),
  ]) {
    const result = applyEvidenceClassification(withRole(record), { roles: TEST_ROLES, now: () => NOW });
    assert.equal(result.changed, false);
    assert.equal(result.state.roles[record.roleKey].state, record.state);
  }
});

test("classification appends to transitions and moves stateChangedAt exactly once", () => {
  const first = applyEvidenceClassification(withRole(roleRecord({ evidence: [policyClaim("successor")] })),
    { roles: TEST_ROLES, now: () => NOW });
  const record = first.state.roles["openai:gpt-sol"];
  assert.deepEqual(record.transitions.slice(-1), ["auto-eligible"]);
  assert.equal(record.stateChangedAt, NOW);

  const second = applyEvidenceClassification(first.state, { roles: TEST_ROLES, now: () => NOW + 9_000 });
  assert.equal(second.changed, false);
  assert.equal(second.state.roles["openai:gpt-sol"].stateChangedAt, NOW);
});

test("stale evidence for a superseded candidate is dropped rather than trusted", () => {
  const record = roleRecord({ evidence: [policyClaim("successor")], evidenceRevision: "stale-revision" });
  const result = applyEvidenceClassification(withRole(record), { roles: TEST_ROLES, now: () => NOW });
  assert.equal(result.state.roles["openai:gpt-sol"].state, "evidence-pending");
  assert.deepEqual(result.state.roles["openai:gpt-sol"].evidence, []);
});
```

Then add the tests that pin re-observation, which is where this package would otherwise loop. These go through the real `runDryReconciliation()` with injected sources so `mergeObservation` actually runs:

```js
test("a second dry run does not drag an advanced record back to evidence-pending", () => {
  runDryReconciliation(DRY_RUN_ARGS);                       // observe
  ingestSuccessorEvidence(store, "openai:gpt-sol");         // evidence arrives
  const classified = runDryReconciliation(DRY_RUN_ARGS);    // classify
  const first = store.read().roles["openai:gpt-sol"];
  assert.equal(first.state, "auto-eligible");

  const again = runDryReconciliation({ ...DRY_RUN_ARGS, now: () => NOW + 86_400_000 });
  const second = store.read().roles["openai:gpt-sol"];
  assert.equal(second.state, "auto-eligible");
  assert.equal(second.stateChangedAt, first.stateChangedAt,
    "an unchanged advanced record must not look like a fresh transition to the notifier");
  assert.deepEqual(second.transitions, first.transitions);
  assert.ok(second.lastObservedAt > first.lastObservedAt);
  assert.equal(again.effects.routingMutated, false);
  assert.equal(again.effects.inventoryPublished, false);
  assert.equal(again.effects.externalPublished, false);
});

test("an amended proposal keeps its operator tiers across dry runs", () => {
  seedAwaitingApproval(store);
  amendProposedTiers(store, "openai:gpt-sol", ["smart", "build"]);
  runDryReconciliation(DRY_RUN_ARGS);
  assert.deepEqual(store.read().roles["openai:gpt-sol"].proposedTiers, ["smart", "build"]);
});

test("a genuinely newer candidate supersedes an advanced record instead of being ignored", () => {
  seedAwaitingApproval(store);
  const result = runDryReconciliation({ ...DRY_RUN_ARGS, collectSources: () => SOURCES_WITH_GPT7_SOL });
  const record = store.read().roles["openai:gpt-sol"];
  assert.equal(record.candidateModelID, "gpt-7-sol");
  assert.equal(record.state, "evidence-pending");
  assert.deepEqual(record.evidence, []);
  assert.equal(record.approval, null);
  assert.equal(record.issue, null);
  assert.deepEqual(record.transitions.slice(-2), ["superseded", "evidence-pending"]);
  assert.deepEqual(result.superseded, [{ kind: "role", key: "openai:gpt-sol" }]);
});

test("supersession moves a real issue pointer and fabricates none when there was no issue", () => {
  // With an open issue: the pointer must survive so Task 5 can still close it.
  seedAwaitingApprovalWithIssue(store, { number: 41 });
  runDryReconciliation({ ...DRY_RUN_ARGS, collectSources: () => SOURCES_WITH_GPT7_SOL, now: () => NOW });
  const moved = store.read().roles["openai:gpt-sol"];
  assert.equal(moved.issue, null);
  assert.equal(moved.supersededIssue.number, 41);
  assert.equal(moved.supersededIssue.supersededAt, NOW);
  assert.equal(moved.supersededIssue.commentedAt, null);

  // Without one: `{ ...null }` would store a pointer with no number, and pass one would
  // then call the forge with `number === undefined` on every run forever.
  seedAwaitingApproval(freshStore);
  runDryReconciliation({ ...DRY_RUN_ARGS, store: freshStore,
    collectSources: () => SOURCES_WITH_GPT7_SOL, now: () => NOW });
  assert.equal(freshStore.read().roles["openai:gpt-sol"].supersededIssue, null);
});

test("an unknown candidate that leaves a healthy catalog is retired rather than left approvable", () => {
  const store = freshStore();
  seedUnknownAwaitingApproval(store, { transitionID: "bbbbbbbbbbbbbbbbbbbbbbbb", number: 42 });
  const result = runDryReconciliation({ ...DRY_RUN_ARGS, store, collectSources: () => SOURCES_WITHOUT_UNKNOWN });
  const record = store.read().unknown.bbbbbbbbbbbbbbbbbbbbbbbb;
  assert.equal(record.state, "superseded");
  assert.equal(record.supersededIssue.number, 42);
  assert.equal(record.supersededAt, NOW, "without the stamp the retirement is never announced");
  assert.deepEqual(result.superseded, [{ kind: "unknown", key: "bbbbbbbbbbbbbbbbbbbbbbbb" }]);
});

// The dangerous case: a transient failure must never retire a live proposal, because `superseded`
// is terminal and held, so the model would never be proposed again.
test("an uncertifiable run retires nothing", () => {
  for (const sources of [
    STALE_CATALOG_SOURCES, EMPTY_CATALOG_SOURCES, CATALOG_REFRESH_ERROR_SOURCES,
    STALE_RESOLVER_SOURCES, EMPTY_RESOLVER_SOURCES,
  ]) {
    const store = freshStore();
    seedUnknownAwaitingApproval(store, { transitionID: "bbbbbbbbbbbbbbbbbbbbbbbb", number: 42 });
    const result = runDryReconciliation({ ...DRY_RUN_ARGS, store, collectSources: () => sources });
    const record = store.read().unknown.bbbbbbbbbbbbbbbbbbbbbbbb;
    assert.equal(record.state, "awaiting-approval");
    assert.equal(record.supersededIssue, null);
    assert.equal(record.issue.number, 42);
    assert.deepEqual(result.superseded, []);
  }
});

test("a provider dropped by an unreadable auth store keeps its open proposals", () => {
  const store = freshStore();
  seedUnknownAwaitingApproval(store, { transitionID: "bbbbbbbbbbbbbbbbbbbbbbbb", number: 42 });
  const result = runDryReconciliation({ ...DRY_RUN_ARGS, store,
    authSnapshot: () => ({ revision: null, types: {} }) });
  assert.equal(store.read().unknown.bbbbbbbbbbbbbbbbbbbbbbbb.state, "awaiting-approval");
  assert.deepEqual(result.superseded, []);
});
```

- [ ] **Step 2: Run the classification tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-classify.test.mjs
```

Expected: FAIL for the missing exports.

- [ ] **Step 3: Implement classification**

`classifyEvidencedRecord()` is pure and applies this precedence:

1. a terminal or decided state returns unchanged;
2. no stored evidence, or `evidenceRevision` that does not match `candidateRevision()`, returns `evidence-pending` (and the caller drops the stale evidence);
3. a persisted `evidenceContradiction`, a `role-change` claim, an unknown-role record, or a record whose role match is `conflict` returns `awaiting-approval`;
4. a known-role record with at least one accepted `successor` or `recommended-replacement` policy claim returns `auto-eligible`;
5. anything else returns `awaiting-approval` with a reason naming what was missing.

`applyEvidenceClassification()` walks `roles` and `unknown`, applies the above, appends the new state to `transitions`, sets `stateChangedAt` only on an actual change, and never writes `approval`, `issue`, or `notified`. Call it from `runDryReconciliation()` inside the existing locked update, after enqueueing.

`auto-eligible` means "eligible for Package 3 to stage". Package 2 must not act on it further.

**Extend re-observation holding, or this package notifies in a loop.** Today `heldRecord()` at `lib/model-reconcile.js:461-462` holds a record only when its state is terminal or `approval !== null`. An `auto-eligible` or `awaiting-approval` record is neither, so `mergeObservation()` at `:491-505` overwrites `state` with the fresh `evidence-pending` observation, moves `stateChangedAt`, and appends to `transitions` — and because Task 6 keys its delivery marker on `stateChangedAt`, every scheduled run would re-notify every open proposal. Line 620 also rewrites `proposedTiers` from the registry, discarding an operator `amend`. Change it as follows:

- hold a record whose state is in `POST_OBSERVATION_STATES` as well as terminal-or-decided, so an advanced record keeps `state`, `stateChangedAt`, `transitions`, `proposedTiers`, `evidence`, `approval`, `issue`, and `notified`, while still taking a fresh `lastObservedAt`;
- override that hold on one condition only: the observation's `transitionID` differs from the record's, meaning the provider shipped a different candidate for that role. Then append `superseded` to `transitions`, clear `evidence`, `evidenceRevision`, `evidenceContradiction`, and `approval`, replace the record with the new observation at `evidence-pending`, and report the role key in the report's `superseded` array;
- **move the issue pointer, never drop it — and never fabricate one.** An open Gitea issue whose record no longer references it can never be closed, and a human applying a decision label to that orphan would get a silent no-op while believing the proposal was decided. So supersession sets

  ```js
  supersededIssue: record.issue ? { ...record.issue, supersededAt: observedAt, commentedAt: null } : null,
  ```

  and only then sets `issue: null`. It also stamps `supersededAt: observedAt` **on the record itself**, not only inside the pointer. That stamp is what makes the supersession notifiable: a role record ends this step back at `evidence-pending`, so a notifier deriving events from current state alone would never announce it, and the pointer that carries the timestamp is cleared as soon as pass one closes the issue. Task 6 keys its `superseded` event on `record.supersededAt`. The guard on the pointer is load-bearing: `{ ...null }` is `{}`, so an unconditional spread would store a non-null pointer carrying no issue number, and pass one would then call the forge with `number === undefined` on every run forever. `issue: null` is the normal case — an `auto-eligible` record is never projected, a fresh `awaiting-approval` record has not been projected yet, and Gitea ships disabled — so this path is the common one, not an edge case. Carry `notified` across unchanged: its markers are keyed on `transitionID` and `stateChangedAt`, both of which supersession changes, so old markers cannot collide with new ones and are kept only as history;
- leave the existing behaviour for `evidence-pending` and `blocked-*` records exactly as Package 1 wrote it, so a blocked record still tracks the live source status;
- **retire an unknown record whose candidate has left the catalog — but only on a run that can certify it.** Package 1 keys `unknown` by `transitionID` (`lib/model-reconcile.js:667-668`), so a different candidate lands in a fresh slot and the `transitionID differs` override above can never fire for it. Without a retirement rule the old entry survives forever at its old key, still `awaiting-approval`, still pointing at an open issue for a model the provider has withdrawn — and a human can approve it.

  After the observation loop, retire an `unknown` record only when ALL of these hold: this run did not observe it; its state is `evidence-pending` or `awaiting-approval`; its `providerID` is present in this run's `providerIDs`; and every field of `sourceStatus` is clean (`catalogStale`, `catalogEmpty`, `catalogError`, `resolverStale`, `resolverEmpty`, `resolverError`, and `authRevisionChanged` all falsy). Then append `superseded` to `transitions`, set `state` to `superseded`, **stamp `supersededAt: observedAt` on the record**, move its issue pointer with the same guarded expression, and report it in `superseded`. The stamp is required on this path too: notifications are keyed on `supersededAt`, and pass one clears `supersededIssue` as soon as it closes the issue, so a retirement without the stamp would go unannounced the moment the forge write succeeded.

  **The gate is not defensive padding; without it this rule destroys live proposals.** `collectCatalog()` does not abort on a failed refresh — it falls back to the live cache and returns `empty` (`lib/model-reconcile.js:96-99`) — and an unreadable auth store yields `authTypes = {}`, so `admittedProviderIDs()` silently drops a provider and every one of its candidates vanishes from the selection (`:560-561`). Those candidates are then "not observed" through no fault of their own. Because `superseded` is terminal (`:191`) and `heldRecord()` holds terminal records (`:461-462`), a single transient catalog or auth failure would permanently retire every open unknown proposal and close its issue, and the model would never be re-proposed when it reappeared. `sourceStatus` and `providerIDs` are both already in scope inside the locked update (`:561`, `:583-591`). Never retire a record this run observed, and never retire one already terminal or decided.

State plainly in the code comment that `lastObservedAt` is the only field a held record accepts from a later run.

- [ ] **Step 4: Run classification with the full reconciliation set**

```bash
node --experimental-test-module-mocks --test tests/reconcile-classify.test.mjs tests/model-reconcile.test.mjs tests/reconcile-evidence-validate.test.mjs tests/reconcile-cli.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Prove red, then restore green**

```bash
git add tests/reconcile-classify.test.mjs
git stash push -u --keep-index -m "red-green evidence classification"
node --experimental-test-module-mocks --test tests/reconcile-classify.test.mjs
git stash pop
git --no-pager status --short
node --experimental-test-module-mocks --test tests/reconcile-classify.test.mjs tests/model-reconcile.test.mjs
```

Expected: FAIL while stashed, then PASS with no unmerged entries.

- [ ] **Step 6: Commit classification**

```bash
git add lib/model-reconcile.js tests/reconcile-classify.test.mjs
git commit -m "feat: classify model evidence into eligibility or approval"
```

### Task 5: Project proposals to Gitea and read decision labels

**Files:**
- Create: `lib/reconcile-gitea.js`
- Create: `tests/reconcile-gitea.test.mjs`

**Interfaces:**
- Produces: `PROPOSAL_LABEL = "model-reconciliation"`
- Produces: `DECISION_LABELS = { approved: "decision/approved", rejected: "decision/rejected" }`
- Produces: `proposalRevision(record): string` — sha256-hex-24 over `candidateRevision(record)` plus the proposed tiers and role key, so an `amend` in Task 7 supersedes an open issue while an unchanged rerun does not
- Produces: `proposalIssueBody(record, { roles }): string`
- Produces: `createGiteaClient({ baseURL, owner, repo, tokenPath, fetch }): GiteaClient` — it resolves the token through Task 3's `readGiteaTokenIfPresent()` rather than reading the file itself, so the package has one reader and one mode check
- Consumes: `CONFIG.reconcile` and `readGiteaTokenIfPresent()`, both introduced in Task 3
- Produces: `closeSupersededIssue({ record, key, kind, client, store, now }): { closed: boolean, error: string | null }` — the package's only comment-and-close path
- Produces: `projectProposals({ store, roles, client, now }): ProjectionResult` with `{ state, created, closed, superseded, reopened, conflicts, errors, skipped }`, where `superseded` and `closed` carry `{ kind, key }` entries so a consumer knows which map to look in
- Consumes: `CONFIG.reconcile.gitea` and `CONFIG.reconcile.notifyCommand`, both defined in Task 3

- [ ] **Step 1: Write the failing projection tests**

Inject `fetch`; never contact a real forge. **Every fixture is a factory called inside the test, never a shared binding** — these tests drive records to `approved`, `rejected`, and cleared pointers, and `node:test` runs them in order, so a shared `storeWithIssue` would leak state into the next test. Follow the shape Tasks 3 and 6 already use (`freshClaimedStore()`, `freshStoreAwaitingNotification()`); the snippets below name `storeWith...` for readability and each must be a fresh call.

```js
test("one awaiting-approval proposal creates exactly one labelled issue, and a rerun creates none", () => {
  const first = projectProposals({ store, roles: TEST_ROLES, client, now: () => NOW });
  assert.equal(first.created.length, 1);
  const posted = calls.find((call) => call.method === "POST" && call.path.endsWith("/issues"));
  assert.deepEqual(posted.body.labels, [PROPOSAL_LABEL]);
  assert.match(posted.body.body, /aaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(posted.body.body, /developers\.openai\.com/);
  assert.match(posted.body.body, /decision\/approved/);
  const record = store.read().roles["openai:gpt-sol"];
  assert.equal(record.issue.number, 41);
  assert.equal(record.issue.revision, proposalRevision(record));

  calls.length = 0;
  const second = projectProposals({ store, roles: TEST_ROLES, client, now: () => NOW + 1000 });
  assert.deepEqual(second.created, []);
  assert.equal(calls.some((call) => call.method === "POST" && call.path.endsWith("/issues")), false);
});

test("an approved label applies the stored proposal, comments, and closes", () => {
  const result = projectProposals({ store: storeWithIssue(), roles: TEST_ROLES,
    client: clientWithLabels(["model-reconciliation", "decision/approved"]), now: () => NOW });
  const record = result.state.roles["openai:gpt-sol"];
  assert.equal(record.state, "approved");
  assert.equal(record.approval.decision, "approved");
  assert.equal(record.approval.source, "gitea-label");
  assert.equal(calls.filter((call) => call.path.endsWith("/comments")).length, 1);
  assert.equal(calls.find((call) => call.method === "PATCH").body.state, "closed");
});

test("a rejected label records the rejection and blocks re-proposal", () => {
  const result = projectProposals({ store: storeWithIssue(), roles: TEST_ROLES,
    client: clientWithLabels(["decision/rejected"]), now: () => NOW });
  assert.equal(result.state.roles["openai:gpt-sol"].state, "rejected");
});

test("both decision labels change nothing at all", () => {
  const store = storeWithIssue();
  const before = store.read();
  const result = projectProposals({ store, roles: TEST_ROLES,
    client: clientWithLabels(["decision/approved", "decision/rejected"]), now: () => NOW });
  assert.equal(result.state.roles["openai:gpt-sol"].state, "awaiting-approval");
  assert.equal(result.conflicts.length, 1);
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
  assert.deepEqual(result.state.roles["openai:gpt-sol"].approval, before.roles["openai:gpt-sol"].approval);
});

test("closing an undecided issue is not approval, and it is reopened exactly once", () => {
  const client = clientWithIssue({ state: "closed", labels: ["model-reconciliation"] });
  const store = storeWithIssue();                 // one store, deliberately reused across both runs
  const first = projectProposals({ store, roles: TEST_ROLES, client, now: () => NOW });
  assert.equal(first.state.roles["openai:gpt-sol"].state, "awaiting-approval");
  assert.equal(first.reopened.length, 1);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);

  calls.length = 0;
  const second = projectProposals({ store, roles: TEST_ROLES, client, now: () => NOW + 1000 });
  assert.deepEqual(second.reopened, []);
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
});

test("a superseded issue is closed from its moved pointer, whatever the record's state now is", () => {
  // Task 4 leaves `supersededIssue` on a record that has already dropped back to
  // evidence-pending, so this must not be gated on awaiting-approval.
  const store = storeWithSupersededIssue();
  const result = projectProposals({ store, roles: TEST_ROLES, client, now: () => NOW });
  assert.deepEqual(result.closed, [{ kind: "role", key: "openai:gpt-sol" }]);
  assert.match(calls.find((call) => call.path.endsWith("/comments")).body.body, /superseded/i);
  assert.equal(calls.find((call) => call.method === "PATCH").body.state, "closed");
  assert.equal(result.state.roles["openai:gpt-sol"].supersededIssue, null);

  calls.length = 0;
  const again = projectProposals({ store, roles: TEST_ROLES, client, now: () => NOW + 1000 });
  assert.deepEqual(again.closed, []);
  assert.deepEqual(calls, []);
});

test("a close that fails retries without repeating the comment", () => {
  const store = storeWithSupersededIssue();
  const failClose = clientWhere({ patchIssue: () => { throw new Error("502 bad gateway"); } });
  const first = projectProposals({ store, roles: TEST_ROLES, client: failClose, now: () => NOW });
  assert.equal(first.errors.length, 1);
  const pending = store.read().roles["openai:gpt-sol"].supersededIssue;
  assert.equal(pending.number, 41);
  assert.equal(pending.commentedAt, NOW);

  calls.length = 0;
  const second = projectProposals({ store, roles: TEST_ROLES, client, now: () => NOW + 1000 });
  assert.equal(second.closed.length, 1);
  assert.equal(calls.some((call) => call.path.endsWith("/comments")), false);
  assert.equal(store.read().roles["openai:gpt-sol"].supersededIssue, null);
});

test("an issue already closed on the forge is cleared without a new comment", () => {
  const store = storeWithSupersededIssue();
  const closedClient = clientWithIssue({ state: "closed", labels: [PROPOSAL_LABEL] });
  const result = projectProposals({ store, roles: TEST_ROLES, client: closedClient, now: () => NOW });
  assert.equal(result.closed.length, 1);
  assert.equal(calls.some((call) => call.path.endsWith("/comments")), false);
  assert.equal(store.read().roles["openai:gpt-sol"].supersededIssue, null);
});

test("an amended proposal supersedes its own open issue and opens the next revision", () => {
  const result = projectProposals({ store: storeWithAmendedTiers(), roles: TEST_ROLES, client, now: () => NOW });
  assert.deepEqual(result.superseded, [{ kind: "role", key: "openai:gpt-sol" }]);
  assert.deepEqual(result.closed, [{ kind: "role", key: "openai:gpt-sol" }]);
  assert.equal(result.created.length, 1);
});

test("a Gitea failure blocks the approval path without touching other records", () => {
  const result = projectProposals({ store, roles: TEST_ROLES,
    client: failingClient(new Error("502 bad gateway")), now: () => NOW });
  assert.equal(result.created.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(store.read().roles["openai:gpt-sol"].state, "awaiting-approval");
});

test("the token never appears in a body, a log line, or the ledger", () => {
  projectProposals({ store, roles: TEST_ROLES, client, now: () => NOW });
  const serialized = JSON.stringify(store.read()) + JSON.stringify(calls.map((call) => call.body));
  assert.doesNotMatch(serialized, /test-gitea-token/);
});

test("a group- or world-readable token file is refused before any request is made", () => {
  chmodSync(tokenPath, 0o644);
  assert.throws(() => createGiteaClient({ ...clientArgs, tokenPath }), /0600|permission/i);
  assert.deepEqual(calls, []);
});

test("approving an unknown role with no mapping is refused, not guessed", () => {
  const result = projectProposals({ store: storeWithUnknownIssue(), roles: TEST_ROLES,
    client: clientWithLabels(["decision/approved"]), now: () => NOW });
  const record = result.state.unknown.bbbbbbbbbbbbbbbbbbbbbbbb;
  assert.equal(record.state, "awaiting-approval");
  assert.equal(record.approval, null);
  assert.equal(result.errors.length, 1);
  assert.match(calls.find((call) => call.path.endsWith("/comments")).body.body, /amend/);
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
});

test("auto-eligible and blocked records are never projected", () => {
  for (const state of ["auto-eligible", "evidence-pending", "blocked-stale", "blocked-unresolvable"]) {
    const result = projectProposals({ store: storeWithRoleState(state), roles: TEST_ROLES, client, now: () => NOW });
    assert.deepEqual(result.created, []);
  }
});
```

- [ ] **Step 2: Run the projection tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-gitea.test.mjs
```

Expected: FAIL for the missing module.

- [ ] **Step 3: Implement the client and projection**

`createGiteaClient()` wraps injected `fetch` over four operations only: `getIssue`, `createIssue`, `addComment`, `patchIssue`. It sends `Authorization: token <token>` built at call time, sets `Accept: application/json`, uses a 30-second timeout, and throws an error naming status and path but never the token. Resolve the token by calling Task 3's `readGiteaTokenIfPresent(tokenPath)`; do not read or mode-check the file here, so the package keeps exactly one reader and one mode check. A null return means no token is deployed: refuse to construct the client rather than sending an unauthenticated request.

`projectProposals()` runs two passes.

**Pass one closes moved pointers, regardless of state.** Any record carrying a non-null `supersededIssue` is closed through the single shared helper `closeSupersededIssue({ record, key, kind, client, store, now })`. This pass is deliberately not filtered by `state`: Task 4 hands over records that have already dropped back to `evidence-pending`, and a retired unknown record arrives at `superseded`.

The helper owns every ledger write on this path — both the `commentedAt` stamp and the final clear — so the caller performs no `store.update()` of its own and there is exactly one place that can leave the pointer half-processed. It must survive a partial failure without duplicating a comment:

1. if the issue already reads `closed` on the forge, skip the comment entirely and go to step 4;
2. if `supersededIssue.commentedAt` is null, add the comment naming the candidate that replaced it, then persist `commentedAt` immediately — before attempting the close;
3. patch the issue closed;
4. clear `supersededIssue` only after the close succeeds.

A close that fails leaves `commentedAt` set and `supersededIssue` non-null, so the next run retries the close and never re-comments. Global Constraint "no duplicate issue, comment, or notification" is only true because of that ordering; a single `store.update()` spanning comment and close would break it.

**Pass two projects live proposals.** It selects only records whose `state === "awaiting-approval"` and:

- creates an issue when `issue` is null; when `issue.revision` no longer equals `proposalRevision(record)` — the `amend` case — it moves the pointer with the same guarded expression Task 4 uses, closes it through `closeSupersededIssue()`, and then creates the replacement, so there is exactly one comment-and-close code path in the package;
- otherwise reads the issue and acts on labels: exactly one decision label applies it, both is a conflict recorded in `conflicts` with no write, neither leaves the record waiting;
- treats a `closed` issue carrying no decision as an accident: comment the instructions, reopen, and set `issue.reopenedAt` so the next run does nothing;
- writes `approval: { decision, source: "gitea-label", at }` and the new `state` inside one `store.update()`, appending to `transitions`;
- collects per-record errors into `errors` and continues with the next record.

The issue body carries the transition ID, provider, role, candidate, incumbent, proposed tiers, every stored claim with its URL and quote, the operational admission status, and the exact label names to apply. It must not carry a credential or a host path.

**An unknown-role proposal has no mapping to approve yet, and must say so.** Package 1 writes `proposedTiers` only for role records (`lib/model-reconcile.js:620`); an unknown record has none, and the model is not allowed to invent one. So for an unknown record the issue body states that no role mapping is proposed and that a decision requires one, naming the exact command:

```text
opencode-broker-reconcile amend <transitionID> --role <provider>:<roleID> --tiers <tier,tier>
```

`decision/approved` on an unknown record that still has no role key and no proposed tiers is refused: the projection comments once naming the missing mapping, leaves the record `awaiting-approval`, records the refusal in `errors`, and does not close the issue. Approval becomes possible after `amend` supplies the mapping, which also bumps `proposalRevision` and supersedes the old issue.

`CONFIG.reconcile` already exists from Task 3 — `gitea.baseURL` (default `https://git.arch.fyi`), `gitea.owner` (default `opencode`), `gitea.repo` (default `opencode-broker`), `gitea.tokenPath` (default `~/.config/opencode-broker/gitea-token`), `gitea.enabled` (default `false`), and `notifyCommand`. Do not redefine it here. Disabled means the projection reports `skipped: "gitea-disabled"` and writes nothing.

- [ ] **Step 4: Run projection, config, and reconciliation tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-gitea.test.mjs tests/config-parse.test.mjs tests/model-reconcile.test.mjs tests/reconcile-classify.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Prove red, then restore green**

```bash
git add tests/reconcile-gitea.test.mjs
git stash push -u --keep-index -m "red-green gitea projection"
node --experimental-test-module-mocks --test tests/reconcile-gitea.test.mjs
git stash pop
git --no-pager status --short
node --experimental-test-module-mocks --test tests/reconcile-gitea.test.mjs tests/config-parse.test.mjs
```

Expected: FAIL while stashed, then PASS with no unmerged entries.

- [ ] **Step 6: Commit the Gitea projection**

```bash
git add lib/reconcile-gitea.js tests/reconcile-gitea.test.mjs
git commit -m "feat: project model proposals to gitea decisions"
```

### Task 6: Push one ntfy event per transition, with bounded retry

**Files:**
- Create: `lib/reconcile-notify.js`
- Create: `tests/reconcile-notify.test.mjs`

**Interfaces:**
- Produces: `NOTIFY_EVENTS = ["proposal-opened", "auto-eligible", "decision-applied", "blocked", "superseded"]`
- Produces: `NOTIFY_MAX_ATTEMPTS = 5`
- Produces: `deliveryMarker(record, event): string`
- Produces: `pendingNotifications(state, { roles }): readonly Notification[]`
- Produces: `deliverNotifications({ store, roles, run, now, notifyCommand }): { delivered, failed, pending, skipped }` with `notifyCommand` defaulting to `CONFIG.reconcile.notifyCommand`
- Produces: `notificationHealth(state): { pending, failed, oldestPendingAt }`

- [ ] **Step 1: Write the failing notification tests**

```js
test("each transition notifies exactly once, with a link for an approval proposal", () => {
  const argvs = [];
  const store = storeWithIssue();                 // one store, deliberately reused across both runs
  const first = deliverNotifications({ store, roles: TEST_ROLES,
    run: (argv) => { argvs.push(argv); return { status: 0 }; }, now: () => NOW });
  assert.equal(first.delivered.length, 1);
  assert.match(argvs[0].join(" "), /issues\/41/);
  assert.match(argvs[0].join(" "), /gpt-6-sol/);

  argvs.length = 0;
  const second = deliverNotifications({ store, roles: TEST_ROLES,
    run: (argv) => { argvs.push(argv); return { status: 0 }; }, now: () => NOW + 1000 });
  assert.deepEqual(second.delivered, []);
  assert.deepEqual(argvs, []);
});

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

test("a notification failure never reverts the transition that caused it", () => {
  const store = freshStoreAwaitingNotification();
  const before = store.read().roles["openai:gpt-sol"].state;
  deliverNotifications({ store, roles: TEST_ROLES, run: () => ({ status: 1 }), now: () => NOW });
  assert.equal(store.read().roles["openai:gpt-sol"].state, before);
});

test("no configured notifier is a clean skip, not a crash", () => {
  const result = deliverNotifications({ store: storeWithIssue(), roles: TEST_ROLES, notifyCommand: [],
    run: () => { throw new Error("must not run"); }, now: () => NOW });
  assert.deepEqual(result.delivered, []);
  assert.equal(result.skipped, "no-notify-command");
});

test("a blocked or rolled-back record notifies, and an unchanged one does not", () => {
  assert.equal(pendingNotifications(stateWith("blocked-stale"), { roles: TEST_ROLES }).length, 1);
  assert.equal(pendingNotifications(stateWith("evidence-pending"), { roles: TEST_ROLES }).length, 0);
});

test("a retired unknown record announces its supersession", () => {
  // Task 4 writes `state: "superseded"` plus the `supersededAt` stamp; this is where the stamp's
  // consequence is asserted, because pendingNotifications does not exist until this task.
  const state = unknownStateWith("superseded", { supersededAt: NOW });
  assert.deepEqual(pendingNotifications(state, { roles: TEST_ROLES }).map((entry) => entry.event),
    ["superseded"]);
});

test("a replaced role record announces its supersession even though it is back at evidence-pending", () => {
  const state = stateWith("evidence-pending", { supersededAt: NOW });
  const pending = pendingNotifications(state, { roles: TEST_ROLES });
  assert.deepEqual(pending.map((entry) => entry.event), ["superseded"]);

  const store = storeOf(state);
  const first = deliverNotifications({ store, roles: TEST_ROLES, run: () => ({ status: 0 }), now: () => NOW });
  assert.equal(first.delivered.length, 1);
  const second = deliverNotifications({ store, roles: TEST_ROLES,
    run: () => { throw new Error("must not run twice"); }, now: () => NOW + 1000 });
  assert.deepEqual(second.delivered, []);
});
```

- [ ] **Step 2: Run the notification tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-notify.test.mjs
```

Expected: FAIL for the missing module.

- [ ] **Step 3: Implement notification projection**

Build argv through the existing `notifyArgv()` so one notifier script serves the watch, the burn watch, and this projection; use `kind: "model-reconcile"`. Derive pending notifications from record state versus `notified` markers:

- `awaiting-approval` with an issue produces `proposal-opened` carrying the issue URL;
- `auto-eligible` produces `auto-eligible`;
- `approved` or `rejected` produces `decision-applied`;
- `blocked-*` and `rolled-back` produce `blocked`;
- a non-null `record.supersededAt` produces `superseded`, keyed on that timestamp rather than on the record's current state. A retired unknown record sits at `superseded`, but a replaced role record is already back at `evidence-pending`, so a state-derived rule would announce the unknown case and silently drop the role case. A record retired from under an operator who was asked to approve it is exactly what must not be silent, and with Gitea shipping disabled ntfy may be the only signal.

Add `superseded` to `NOTIFY_EVENTS`, and note that `awaiting-approval` without an issue produces nothing: the `proposal-opened` event is structurally gated on Gitea, so enabling ntfy without Gitea in Package 4 would drop proposal alerts. Package 4 must enable them together.

`deliveryMarker()` is the event name plus the record's `transitionID` and state-change timestamp, so the same transition never notifies twice while a genuinely new transition always does. This only holds because Task 4 stops `mergeObservation()` from moving `stateChangedAt` on an unchanged advanced record; do not build this task before that change is in place. Package 1 initialises `notified` to `null` (`lib/model-reconcile.js:487`), so convert it to `{}` on first write rather than indexing null. Record `notified[marker] = { at, attempts, lastError }` inside `store.update()`. Stop retrying at `NOTIFY_MAX_ATTEMPTS` and mark the marker failed, leaving it visible through `notificationHealth()`. Never change a record's `state` from this module. An empty notify command returns `skipped: "no-notify-command"` and writes nothing.

- [ ] **Step 4: Run notification and projection tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-notify.test.mjs tests/reconcile-gitea.test.mjs tests/reconcile-classify.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Prove red, then restore green**

```bash
git add tests/reconcile-notify.test.mjs
git stash push -u --keep-index -m "red-green notify projection"
node --experimental-test-module-mocks --test tests/reconcile-notify.test.mjs
git stash pop
git --no-pager status --short
node --experimental-test-module-mocks --test tests/reconcile-notify.test.mjs
```

Expected: FAIL while stashed, then PASS with no unmerged entries.

- [ ] **Step 6: Commit the notification projection**

```bash
git add lib/reconcile-notify.js tests/reconcile-notify.test.mjs
git commit -m "feat: notify once per model reconciliation transition"
```

### Task 7: Expose the commands, document the lifecycle, and prepare the release

**Files:**
- Modify: `bin/opencode-broker-reconcile`
- Modify: `package.json`, `package-lock.json`
- Modify: `README.md`, `docs/STATE.md`, `CHANGELOG.md`
- Modify: `tests/reconcile-cli.test.mjs`

**Interfaces:**
- Produces: `opencode-broker-reconcile project [--json] [--dry-run]`
- Produces: `opencode-broker-reconcile approve <transitionID> [--note TEXT]`
- Produces: `opencode-broker-reconcile reject <transitionID> [--note TEXT]`
- Produces: `opencode-broker-reconcile amend <transitionID> --tiers a,b [--role KEY]`
- Produces: `opencode-broker-reconcile evidence-status [--json]`
- Produces bin: `opencode-broker-evidence`
- Exit `0` on success or nothing to do; `1` on a projection, state, or decision failure; `2` on usage

- [ ] **Step 1: Write the failing CLI tests**

Extend `tests/reconcile-cli.test.mjs` with spawned-CLI cases using a temporary `HOME`, an explicit fixture config, a scratch `XDG_CACHE_HOME`, and `gitea.enabled: false` so no network call is possible:

```js
test("project is a clean no-op when gitea is disabled", () => {
  const result = run(["project", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).skipped, "gitea-disabled");
});

test("approve and reject record a local decision on an awaiting-approval record", () => {
  seedAwaitingApproval();
  assert.equal(run(["approve", TRANSITION_ID]).status, 0);
  const record = readLedger().roles["openai:gpt-sol"];
  assert.equal(record.state, "approved");
  assert.equal(record.approval.source, "cli");
  assert.equal(run(["reject", TRANSITION_ID]).status, 1,
    "an already-decided record cannot be decided again");
});

test("amend changes the proposed tiers and requires a fresh decision", () => {
  seedAwaitingApproval();
  assert.equal(run(["amend", TRANSITION_ID, "--tiers", "smart,build"]).status, 0);
  const record = readLedger().roles["openai:gpt-sol"];
  assert.deepEqual(record.proposedTiers, ["smart", "build"]);
  assert.equal(record.state, "awaiting-approval");
  assert.equal(record.approval, null);
});

test("approve refuses an unknown transition id and bad usage exits 2", () => {
  assert.equal(run(["approve", "ffffffffffffffffffffffff"]).status, 1);
  assert.equal(run(["approve"]).status, 2);
  assert.equal(run(["amend", TRANSITION_ID]).status, 2);
  assert.equal(run(["frobnicate"]).status, 2);
});

test("evidence-status reports the queue without taking the writer lock", () => {
  const status = JSON.parse(run(["evidence-status", "--json"]).stdout);
  assert.deepEqual(Object.keys(status).sort(), ["claimed", "failed", "pending", "requests"]);
});

test("no command prints a credential or contacts the network", () => {
  for (const argv of [["status", "--json"], ["project", "--json"], ["evidence-status", "--json"]]) {
    const result = run(argv);
    assert.doesNotMatch(result.stdout + result.stderr, /token|Authorization/i);
  }
});
```

- [ ] **Step 2: Run the CLI tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-cli.test.mjs
```

Expected: FAIL because the new subcommands do not exist.

- [ ] **Step 3: Implement the subcommands**

Keep the binary thin: parse, call, print, exit. `approve` and `reject` write `approval: { decision, source: "cli", at, note }` and the matching state through one `store.update()`, refusing a record that is not `awaiting-approval`. `approve` additionally refuses an unknown-role record that has no role key or no proposed tiers, with the same message the Gitea path uses, so neither decision surface can approve a mapping that does not exist. `amend` replaces `proposedTiers` (validated against the same tier names the registry accepts) and optionally sets `--role <provider>:<roleID>` for an unknown record, clears `approval`, bumps the proposal revision so Task 5 supersedes any open issue, and leaves the state at `awaiting-approval`. `project` runs the Gitea projection then the notification projection, in that order, and `--dry-run` reports what each would do without writing or calling out.

- [ ] **Step 4: Document the lifecycle**

Add to `README.md`: the evidence collector command and its gateway model, the five notification events, the two decision labels and what each does, the fact that duplicate suppression covers completed runs and not a crash mid-sequence, the fact that closing an issue is not approval, the local decision commands, and an explicit statement that Package 2 still does not publish inventory, probe, or change routing.

Add to `docs/STATE.md` the `evidenceRequests` map, plus every per-record field Package 2 writes — `evidence`, `evidenceRevision`, `evidenceContradiction`, `evidenceCollectedAt`, `approval`, `issue`, `supersededIssue`, `notified`, and `proposedTiers` on an amended unknown record — naming `opencode-broker-reconcile` and `opencode-broker-evidence` as the only writers. Keep the existing `reviewed-models.json` row unchanged.

- [ ] **Step 5: Run focused tests, then the whole suite**

```bash
node --experimental-test-module-mocks --test tests/reconcile-cli.test.mjs tests/reconcile-notify.test.mjs tests/reconcile-gitea.test.mjs tests/reconcile-classify.test.mjs tests/reconcile-collector.test.mjs tests/reconcile-evidence-validate.test.mjs tests/reconcile-evidence-queue.test.mjs tests/model-reconcile.test.mjs tests/reconcile-state.test.mjs tests/routing.test.mjs
npm test
```

Expected: both exit 0 with zero failures.

- [ ] **Step 6: Bump to 1.21.0 and write the changelog entry**

Set `package.json` and `package-lock.json` to `1.21.0` and add:

```markdown
## [1.21.0] — 2026-09-29

### Added

- **Model reconciliation now collects official evidence and asks before it guesses.** A bounded
  request queue feeds a read-only researcher run through the fleet gateway, whose output is
  validated against the role's own official domains and the exact candidate model before it can be
  stored. An unambiguous same-role successor becomes `auto-eligible` on its own; a new role, a
  contradiction or a comparative-only claim becomes `awaiting-approval` and gets one Gitea issue
  whose `decision/approved` or `decision/rejected` label is authoritative -- closing it is not
  approval, and both labels at once changes nothing. Every transition pushes exactly one ntfy
  event. Routing is still untouched: nothing is published, probed or activated.
```

Then:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm test
```

Expected: metadata agrees on 1.21.0 and the suite passes.

- [ ] **Step 7: Commit the CLI, docs, and release metadata**

```bash
git add bin/opencode-broker-reconcile package.json package-lock.json README.md docs/STATE.md CHANGELOG.md tests/reconcile-cli.test.mjs
git commit -m "release: add model evidence and proposal lifecycle"
```

- [ ] **Step 8: Request review and stop**

Run the repository review workflow over the full Package 2 commit range, with security focus on the credential boundary and the decision-label logic. Address verified findings, rerun `npm test`, and report the commit range and exact test counts. Do not push, do not deploy a unit or timer, do not touch `/home/dev/fleet-core`, and do not begin Package 3.
