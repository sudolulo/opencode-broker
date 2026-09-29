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
  assert.deepEqual(Object.keys(request).sort(), [
    "attempts", "candidateModelID", "candidateRevision", "claimedAt", "claimedBy", "enqueuedAt",
    "incumbentModelID", "kind", "lastError", "providerID", "retryAfter", "roleID", "roleKey",
    "status", "transitionID", "updatedAt",
  ]);

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

test("a candidate revision keeps the unknown group when a role is amended", () => {
  const unknown = {
    providerID: "example", modelID: "new-role", releaseDate: "2026-09-01",
    groupKey: "example:example-new",
  };
  assert.equal(candidateRevision(unknown), candidateRevision({ ...unknown, roleKey: "example:new-role" }));
  assert.throws(() => candidateRevision({ ...unknown, modelID: undefined }), /model ID/);
  assert.throws(() => candidateRevision({ ...unknown, groupKey: undefined }), /group key/);
});

test("amending an unknown request updates its role without resetting the request", () => {
  const record = {
    transitionID: "bbbbbbbbbbbbbbbbbbbbbbbb", groupKey: "example:example-new",
    providerID: "example", modelID: "new-role", family: "example-new",
    releaseDate: "2026-09-01", state: "evidence-pending", evidence: [], approval: null,
  };
  const queued = enqueueEvidenceRequests({
    ...emptyReconciliationState(), unknown: { [record.transitionID]: record },
  }, { now: () => NOW }).state;
  const amended = enqueueEvidenceRequests({
    ...queued,
    unknown: { [record.transitionID]: { ...record, roleKey: "example:new-role", roleID: "new-role" } },
  }, { now: () => NOW + 1 });

  assert.deepEqual(amended.enqueued, []);
  assert.equal(amended.state.evidenceRequests[record.transitionID].roleKey, "example:new-role");
  assert.equal(amended.state.evidenceRequests[record.transitionID].roleID, "new-role");
  assert.equal(amended.state.evidenceRequests[record.transitionID].attempts, 0);
  assert.equal(amended.state.evidenceRequests[record.transitionID].enqueuedAt, NOW);
});

test("claims are selected by enqueue time and then transition ID", () => {
  const older = pending({ transitionID: "cccccccccccccccccccccccc", roleKey: "openai:older" });
  const newer = pending({ transitionID: "bbbbbbbbbbbbbbbbbbbbbbbb", roleKey: "openai:newer" });
  let state = enqueueEvidenceRequests(withRole(older), { now: () => NOW }).state;
  state = enqueueEvidenceRequests({ ...state, roles: {
    [older.roleKey]: older,
    [newer.roleKey]: newer,
  } }, { now: () => NOW + 1 }).state;
  assert.equal(claimEvidenceRequest(state, { now: () => NOW + 2, pid: 1 }).claim.transitionID,
    "cccccccccccccccccccccccc");

  const tied = enqueueEvidenceRequests({ ...emptyReconciliationState(), roles: {
    [older.roleKey]: older,
    [newer.roleKey]: newer,
  } }, { now: () => NOW }).state;
  assert.equal(claimEvidenceRequest(tied, { now: () => NOW + 1, pid: 1 }).claim.transitionID,
    "bbbbbbbbbbbbbbbbbbbbbbbb");
});

test("queue cleanup drops obsolete requests but preserves a live claim", () => {
  const queued = enqueueEvidenceRequests(withRole(pending()), { now: () => NOW }).state;
  const blocked = { ...queued, roles: {
    "openai:gpt-sol": pending({ state: "blocked-stale" }),
  } };
  assert.deepEqual(enqueueEvidenceRequests(blocked, { now: () => NOW + 1 }).state.evidenceRequests, {});

  const claimed = claimEvidenceRequest(queued, { now: () => NOW, pid: 4242 }).state;
  const removed = { ...claimed, roles: {} };
  assert.equal(enqueueEvidenceRequests(removed, { now: () => NOW + EVIDENCE_CLAIM_LEASE_MS })
    .state.evidenceRequests.aaaaaaaaaaaaaaaaaaaaaaaa.status, "claimed");
  assert.deepEqual(enqueueEvidenceRequests(removed,
    { now: () => NOW + EVIDENCE_CLAIM_LEASE_MS + 1 }).state.evidenceRequests, {});
});

test("failure errors are bounded and a missing request is unchanged", () => {
  const queued = enqueueEvidenceRequests(withRole(pending()), { now: () => NOW }).state;
  const failed = recordEvidenceFailure(queued, "aaaaaaaaaaaaaaaaaaaaaaaa",
    { error: "x".repeat(600), now: () => NOW });
  assert.equal(failed.evidenceRequests.aaaaaaaaaaaaaaaaaaaaaaaa.lastError.length, 500);
  assert.equal(recordEvidenceFailure(failed, "missing", { error: "ignored", now: () => NOW }), failed);
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
