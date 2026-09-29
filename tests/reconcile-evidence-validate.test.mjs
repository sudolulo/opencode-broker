import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_MAX_BYTES,
  POLICY_CLAIM_TYPES,
  SUPPORTING_CLAIM_TYPES,
  allowedEvidenceDomains,
  candidateRevision,
  ingestEvidence,
  parseEvidencePayload,
  validateEvidencePayload,
} from "../lib/reconcile-evidence.js";
import { emptyReconciliationState } from "../lib/reconcile-state.js";

const NOW = Date.parse("2026-09-29T00:04:00Z");
const TRANSITION_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

const TEST_ROLES = Object.freeze({
  "openai:gpt-sol": Object.freeze({
    providerID: "openai",
    roleID: "gpt-sol",
    evidenceDomains: Object.freeze(["openai.com", "developers.openai.com"]),
  }),
  "openai:gpt-luna": Object.freeze({
    providerID: "openai",
    roleID: "gpt-luna",
    evidenceDomains: Object.freeze(["platform.openai.com", "openai.com"]),
  }),
  "anthropic:claude-opus": Object.freeze({
    providerID: "anthropic",
    roleID: "claude-opus",
    evidenceDomains: Object.freeze(["anthropic.com"]),
  }),
});

const pendingRecord = Object.freeze({
  transitionID: TRANSITION_ID,
  roleKey: "openai:gpt-sol",
  providerID: "openai",
  roleID: "gpt-sol",
  candidateModelID: "gpt-6-sol",
  candidateReleaseDate: "2026-09-22",
  incumbentModelID: "gpt-5.6-sol",
  state: "evidence-pending",
  evidence: Object.freeze([]),
  approval: null,
});

const request = Object.freeze({
  transitionID: TRANSITION_ID,
  kind: "role",
  roleKey: "openai:gpt-sol",
  roleID: "gpt-sol",
  providerID: "openai",
  candidateModelID: "gpt-6-sol",
  incumbentModelID: "gpt-5.6-sol",
  candidateRevision: candidateRevision(pendingRecord),
  status: "claimed",
});

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

const freshClaimedState = () => ({
  ...emptyReconciliationState(),
  roles: { "openai:gpt-sol": { ...pendingRecord, evidence: [] } },
  evidenceRequests: { [TRANSITION_ID]: { ...request } },
});

test("a well-formed official successor claim is accepted", () => {
  const { claims, rejected } = validateEvidencePayload(payload(), {
    request,
    roles: TEST_ROLES,
    now: () => NOW,
  });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claimType, "successor");
  assert.equal(claims[0].policy, true);
  assert.match(claims[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(claims[0].exactQuote, "GPT-5.6 Sol maps to GPT-6 Sol.");
  assert.deepEqual(rejected, []);
});

test("payload identity mismatches are rejected, never coerced", () => {
  for (const [field, value, expected] of [
    ["providerID", "anthropic", /provider/],
    ["candidateModelID", "gpt-6-luna", /candidate/],
    ["roleID", "gpt-luna", /role/],
  ]) {
    const { claims, rejected } = validateEvidencePayload(payload({ [field]: value }), {
      request,
      roles: TEST_ROLES,
      now: () => NOW,
    });
    assert.deepEqual(claims, []);
    assert.match(rejected.join(" "), expected);
  }
});

test("ingesting a payload with nothing acceptable throws and leaves the request claimable", () => {
  const state = freshClaimedState();
  assert.throws(() => ingestEvidence(state, TRANSITION_ID,
    payload({ candidateModelID: "gpt-6-luna" }),
    { roles: TEST_ROLES, now: () => NOW }), /no acceptable evidence/);
  assert.ok(state.evidenceRequests[TRANSITION_ID],
    "the request must survive so the collector can record a failure against it");
  assert.deepEqual(state.roles["openai:gpt-sol"].evidence, []);
});

test("an off-allowlist or non-HTTPS source is rejected", () => {
  for (const url of [
    "https://example.invalid/gpt-6-sol",
    "http://developers.openai.com/api/docs/guides/latest-model",
    "https://developers.openai.com.attacker.test/x",
  ]) {
    const { claims, rejected } = validateEvidencePayload(payload({
      claims: [{ ...payload().claims[0], sourceURL: url }],
    }), { request, roles: TEST_ROLES, now: () => NOW });
    assert.deepEqual(claims, []);
    assert.equal(rejected.length, 1);
  }
});

test("an HTTPS subdomain of an allowlisted domain is accepted", () => {
  const { claims, rejected } = validateEvidencePayload(payload({
    claims: [{
      ...payload().claims[0],
      sourceURL: "https://docs.developers.openai.com/models/gpt-6-sol",
    }],
  }), { request, roles: TEST_ROLES, now: () => NOW });
  assert.equal(claims.length, 1);
  assert.deepEqual(rejected, []);
});

test("comparative claims are stored but never policy", () => {
  const { claims } = validateEvidencePayload(payload({
    claims: [{ ...payload().claims[0], claimType: "faster" }],
  }), { request, roles: TEST_ROLES, now: () => NOW });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].policy, false);
});

test("contradictory policy claims are kept and flagged, not silently reduced", () => {
  const { claims, contradiction } = validateEvidencePayload(payload({
    claims: [
      { ...payload().claims[0], claimType: "successor" },
      {
        ...payload().claims[0],
        claimType: "role-change",
        exactQuote: "Sol is no longer the flagship role.",
      },
    ],
  }), { request, roles: TEST_ROLES, now: () => NOW });
  assert.equal(claims.length, 2);
  assert.equal(contradiction, true);
});

test("oversized, multi-value, trailing-content, and non-object stdout are refused", () => {
  assert.throws(() => parseEvidencePayload("{}{}"), /exactly one JSON/);
  assert.throws(() => parseEvidencePayload('{"a":1} trailing'), /exactly one JSON/);
  assert.throws(() => parseEvidencePayload("x".repeat(EVIDENCE_MAX_BYTES + 1)), /too large/);
  assert.throws(() => parseEvidencePayload("not json"), /not valid JSON/);
  assert.throws(() => parseEvidencePayload("[]"), /plain object/);
  assert.deepEqual(parseEvidencePayload(' \n {"a":1}\n'), { a: 1 });
});

test("claims with invalid quotes, times, or types are rejected independently", () => {
  const good = payload().claims[0];
  const { claims, rejected } = validateEvidencePayload(payload({
    claims: [
      { ...good, exactQuote: "too short" },
      { ...good, retrievedAt: "not-a-timestamp" },
      { ...good, retrievedAt: "2026-02-30T00:00:00Z" },
      { ...good, retrievedAt: "2026-09-29T00:09:00.001Z" },
      { ...good, claimType: "newer" },
      { ...good, claimType: "faster", retrievedAt: "2026-09-29T00:09:00Z" },
    ],
  }), { request, roles: TEST_ROLES, now: () => NOW });
  assert.equal(claims.length, 1, "exactly five minutes into the future remains acceptable");
  assert.equal(claims[0].claimType, "faster");
  assert.equal(rejected.length, 5);
});

test("at most ten acceptable claims are stored", () => {
  const claimsInput = Array.from({ length: 11 }, (_, index) => ({
    ...payload().claims[0],
    exactQuote: `GPT-6 Sol is the official successor statement number ${index}.`,
  }));
  const { claims, rejected } = validateEvidencePayload(payload({ claims: claimsInput }), {
    request,
    roles: TEST_ROLES,
    now: () => NOW,
  });
  assert.equal(claims.length, 10);
  assert.match(rejected.join(" "), /10/);
});

test("the claim type lists separate policy from supporting evidence", () => {
  assert.deepEqual(POLICY_CLAIM_TYPES,
    ["successor", "recommended-replacement", "new-role", "role-change"]);
  assert.deepEqual(SUPPORTING_CLAIM_TYPES, ["stronger", "faster", "cheaper"]);
});

test("allowed domains use the role or the unknown candidate provider union", () => {
  assert.deepEqual(allowedEvidenceDomains(request, TEST_ROLES),
    ["openai.com", "developers.openai.com"]);
  assert.deepEqual(allowedEvidenceDomains({ ...request, kind: "unknown", roleID: null, roleKey: null }, TEST_ROLES),
    ["developers.openai.com", "openai.com", "platform.openai.com"]);
  assert.deepEqual(allowedEvidenceDomains({
    ...request,
    kind: "unknown",
    roleID: "gpt-orbit",
    roleKey: "openai:gpt-orbit",
  }, TEST_ROLES), ["developers.openai.com", "openai.com", "platform.openai.com"],
  "an amended unknown request remains an unknown request for source validation");
});

test("an unknown-role request accepts only its provider union and grants no policy force", () => {
  const unknownRequest = {
    transitionID: "bbbbbbbbbbbbbbbbbbbbbbbb",
    kind: "unknown",
    roleKey: null,
    roleID: null,
    providerID: "openai",
    candidateModelID: "gpt-6-orbit",
    incumbentModelID: null,
  };
  const unknownPayload = payload({
    candidateModelID: "gpt-6-orbit",
    incumbentModelID: null,
    roleID: "gpt-orbit",
    claims: [{
      ...payload().claims[0],
      claimType: "new-role",
      sourceURL: "https://platform.openai.com/docs/models/gpt-6-orbit",
      exactQuote: "GPT-6 Orbit introduces a new official role.",
    }],
  });
  const accepted = validateEvidencePayload(unknownPayload, {
    request: unknownRequest,
    roles: TEST_ROLES,
    now: () => NOW,
  });
  assert.equal(accepted.claims.length, 1);
  assert.equal(accepted.claims[0].roleID, "gpt-orbit");
  assert.equal(accepted.claims[0].policy, false);

  const amended = validateEvidencePayload(unknownPayload, {
    request: { ...unknownRequest, roleID: "gpt-orbit", roleKey: "openai:gpt-orbit" },
    roles: TEST_ROLES,
    now: () => NOW,
  });
  assert.equal(amended.claims.length, 1);
  assert.equal(amended.claims[0].policy, false,
    "mapping an unknown record does not turn its evidence into automatic policy");

  const refused = validateEvidencePayload({
    ...unknownPayload,
    claims: [{ ...unknownPayload.claims[0], sourceURL: "https://anthropic.com/gpt-6-orbit" }],
  }, { request: unknownRequest, roles: TEST_ROLES, now: () => NOW });
  assert.deepEqual(refused.claims, []);
  assert.equal(refused.rejected.length, 1);
});

test("a successor claim naming no incumbent is rejected for a role that has one", () => {
  const { claims, rejected } = validateEvidencePayload(payload({ incumbentModelID: null }), {
    request,
    roles: TEST_ROLES,
    now: () => NOW,
  });
  assert.deepEqual(claims, []);
  assert.match(rejected.join(" "), /incumbent/);
});

test("ingest stores accepted claims, stamps the revision, and clears the request", () => {
  const claimedState = freshClaimedState();
  const result = ingestEvidence(claimedState, TRANSITION_ID, payload(), {
    roles: TEST_ROLES,
    now: () => NOW,
  });
  const record = result.state.roles["openai:gpt-sol"];
  assert.equal(result.accepted, 1);
  assert.equal(record.evidence.length, 1);
  assert.equal(record.evidenceRevision, candidateRevision(record));
  assert.equal(record.evidenceCollectedAt, NOW);
  assert.equal(result.state.evidenceRequests[TRANSITION_ID], undefined);
  assert.ok(claimedState.evidenceRequests[TRANSITION_ID], "ingest returns a new state");
  assert.deepEqual(claimedState.roles["openai:gpt-sol"].evidence, []);
});

test("evidence for a stale candidate revision is refused", () => {
  const claimedState = freshClaimedState();
  const moved = {
    ...claimedState,
    roles: { "openai:gpt-sol": { ...pendingRecord, candidateModelID: "gpt-7-sol", evidence: [] } },
  };
  assert.throws(() => ingestEvidence(moved, TRANSITION_ID, payload(), {
    roles: TEST_ROLES,
    now: () => NOW,
  }), /revision/);
});

test("contradiction survives ingest on the evidence record", () => {
  const result = ingestEvidence(freshClaimedState(), TRANSITION_ID, payload({
    claims: [
      { ...payload().claims[0], claimType: "successor" },
      {
        ...payload().claims[0],
        claimType: "role-change",
        exactQuote: "Sol is no longer the flagship role.",
      },
    ],
  }), { roles: TEST_ROLES, now: () => NOW });
  assert.equal(result.state.roles["openai:gpt-sol"].evidenceContradiction, true);
});

test("a payload carrying the write token is refused and stores nothing", () => {
  const claimedState = freshClaimedState();
  assert.throws(() => ingestEvidence(claimedState, TRANSITION_ID, payload({
    claims: [{
      ...payload().claims[0],
      exactQuote: "leaked test-gitea-token here now",
    }],
  }), {
    roles: TEST_ROLES,
    now: () => NOW,
    forbiddenStrings: ["test-gitea-token"],
  }), /forbidden/i);
  assert.ok(claimedState.evidenceRequests[TRANSITION_ID]);
  assert.deepEqual(claimedState.roles["openai:gpt-sol"].evidence, []);
});
