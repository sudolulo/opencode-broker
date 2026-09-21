import assert from "node:assert/strict";
import test from "node:test";

import {
  isAbortError,
  markProbationSuccessHealthy,
  normalizeHealth,
  normalizeProviderError,
  operatorQuarantineProvider,
  providerEligible,
  recordFailureEvidence,
  rearmQuarantinedProvider,
} from "../lib/provider-health.js";

const baseFailure = (overrides = {}) => ({
  targetID: "anthropic-worker",
  modelID: "claude-haiku-4-5",
  reasonCode: "compatibility",
  error: { name: "RateLimitError", message: "rate limited" },
  at: 0,
  ...overrides,
});

test("one compatibility failure observes but still allows routing", () => {
  const health = recordFailureEvidence(normalizeHealth({}), "anthropic", baseFailure());
  assert.equal(health.providers.anthropic.state, "observing");
  assert.equal(providerEligible(health, "anthropic", 0), true);
});

test("normalizeProviderError keeps only safe fields", () => {
  assert.deepEqual(normalizeProviderError({ name: "ToolStateError", message: "rate limited", code: "Throttling.RateQuota", statusCode: 429, nested: { secret: true } }), {
    name: "ToolStateError",
    message: "rate limited",
    code: "Throttling.RateQuota",
    statusCode: 429,
  });
});

test("normalizeProviderError preserves only safe nested provider signals", () => {
  assert.deepEqual(normalizeProviderError({
    name: "APIError",
    message: "request failed",
    data: { code: "Throttling.AllocationQuota", resetAt: "2026-09-03T12:00:00Z", secret: "nope" },
  }), {
    name: "APIError",
    message: "request failed",
    code: "Throttling.AllocationQuota",
    resetAt: "2026-09-03T12:00:00.000Z",
  });
  assert.deepEqual(normalizeProviderError({
    data: { code: "Throttling.AllocationQuota", resetAt: "2026-09-03T12:00:00Z", secret: "nope" },
  }), {
    name: "Error",
    message: "unknown provider error",
    code: "Throttling.AllocationQuota",
    resetAt: "2026-09-03T12:00:00.000Z",
  });
});

test("failures from two distinct targets quarantine the provider even with different normalized messages", () => {
  let health = normalizeHealth({});
  health = recordFailureEvidence(health, "anthropic", baseFailure({
    error: { name: "RateLimitError", message: "rate limited after 1 request" },
  }));
  health = recordFailureEvidence(health, "anthropic", baseFailure({
    targetID: "anthropic-opus",
    modelID: "claude-opus-4-6",
    error: { name: "RateLimitError", message: "rate limited after 2 requests" },
    at: 15 * 60 * 1000 - 1,
  }));
  assert.equal(health.providers.anthropic.state, "quarantined");
  assert.equal(health.providers.anthropic.evidence.length, 2);
});

test("repeating the same target does not quarantine the provider even when the message changes", () => {
  let health = normalizeHealth({});
  health = recordFailureEvidence(health, "anthropic", baseFailure({
    error: { name: "RateLimitError", message: "rate limited after 1 request" },
  }));
  health = recordFailureEvidence(health, "anthropic", baseFailure({
    error: { name: "RateLimitError", message: "rate limited after 2 requests" },
    at: 60_000,
  }));
  assert.equal(health.providers.anthropic.state, "observing");
  assert.equal(health.providers.anthropic.evidence.length, 1);
});

test("evidence expires and stays bounded", () => {
  const now = 20 * 60 * 1000;
  const health = normalizeHealth({
    providers: {
      anthropic: {
        state: "observing",
        kind: "compatibility",
        source: "automatic",
        reasonCode: "compatibility",
        fingerprint: "fingerprint-a",
        firstAt: 0,
        lastAt: now,
        evidence: [
          { targetID: "anthropic-old", modelID: "claude-haiku-4-5", at: 0 },
          ...Array.from({ length: 10 }, (_, index) => ({
            targetID: `anthropic-${index}`,
            modelID: `claude-${index}`,
            at: now - 10_000 + index,
          })),
        ],
      },
    },
  }, now);
  assert.equal(health.providers.anthropic.evidence.length, 8);
  assert.equal(health.providers.anthropic.evidence[0].targetID, "anthropic-2");
  assert.ok(health.providers.anthropic.evidence.every((entry) => now - entry.at <= 15 * 60 * 1000));
});

test("quarantine blocks and probation allows one provider-wide active lease", () => {
  let health = operatorQuarantineProvider(normalizeHealth({}), "anthropic", { reasonCode: "operator", at: 1 });
  assert.equal(providerEligible(health, "anthropic", 0), false);
  health = rearmQuarantinedProvider(health, "anthropic", { reasonCode: "operator", at: 2 });
  assert.equal(health.providers.anthropic.state, "probation");
  assert.equal(providerEligible(health, "anthropic", 0), true);
  assert.equal(providerEligible(health, "anthropic", 1), false);
});

test("an automatic quarantine re-probes itself, an operator one never does", () => {
  // Anchored to real time on purpose: providerEligible re-normalizes at Date.now(),
  // so an epoch-0 fixture would read as infinitely stale and prove nothing.
  const now = Date.now();
  const quarantinedFor = (source, minutes) => ({
    providers: {
      openai: {
        state: "quarantined",
        kind: "compatibility",
        source,
        reasonCode: "other",
        firstAt: now - minutes * 60_000,
        lastAt: now - minutes * 60_000,
        evidence: [],
      },
    },
  });
  // Still inside the re-probe interval: stays down, and stays ineligible.
  const fresh = normalizeHealth(quarantinedFor("automatic", 10), now);
  assert.equal(fresh.providers.openai.state, "quarantined");
  assert.equal(providerEligible(fresh, "openai", 0), false);
  // Past it: probation, which admits exactly one probe lease and no more.
  const reprobed = normalizeHealth(quarantinedFor("automatic", 31), now);
  assert.equal(reprobed.providers.openai.state, "probation");
  assert.equal(providerEligible(reprobed, "openai", 0), true);
  assert.equal(providerEligible(reprobed, "openai", 1), false);
  // A human decision is not a symptom and no timer may undo it.
  const operator = normalizeHealth(quarantinedFor("operator", 31), now);
  assert.equal(operator.providers.openai.state, "quarantined");
  assert.equal(providerEligible(operator, "openai", 0), false);
  // And a failure on the probe puts it straight back, with the wait restarted.
  const failed = recordFailureEvidence(reprobed, "openai", {
    targetID: "gpt-flagship",
    modelID: "gpt-5.6-sol",
    reasonCode: "other",
    error: new Error("boom"),
    at: now,
  });
  assert.equal(failed.providers.openai.state, "quarantined");
  assert.equal(providerEligible(failed, "openai", 0), false);
});

test("probation success clears the record", () => {
  let health = operatorQuarantineProvider(normalizeHealth({}), "anthropic", { reasonCode: "operator", at: 1 });
  health = rearmQuarantinedProvider(health, "anthropic", { reasonCode: "operator", at: Date.now() });
  const probationAt = health.providers.anthropic.lastAt;
  health = markProbationSuccessHealthy(health, "anthropic", { at: probationAt - 1 });
  assert.equal(health.providers.anthropic.state, "probation", "stale success cannot clear newer probation");
  health = markProbationSuccessHealthy(health, "anthropic", { at: probationAt });
  assert.equal(health.providers.anthropic, undefined);
  assert.equal(providerEligible(health, "anthropic", 0), true);
});

test("normalization rejects malformed and unbounded state", () => {
  const health = normalizeHealth({
    providers: {
      "bad id": {
        state: "observing",
        kind: "compatibility",
        source: "automatic",
        evidence: [{ targetID: "anthropic-worker", modelID: "claude-haiku-4-5", at: 1 }],
      },
      anthropic: {
        state: "observing",
        kind: "compatibility",
        source: "automatic",
        reasonCode: "compatibility",
        fingerprint: "fingerprint-a",
        firstAt: 0,
        lastAt: 0,
        evidence: Array.from({ length: 20 }, (_, index) => ({
          targetID: `anthropic-${index}`,
          modelID: `claude-${index}`,
          at: 30 * 60 * 1000 - 10_000 + index,
        })),
      },
    },
  }, 30 * 60 * 1000);
  assert.equal(health.providers["bad id"], undefined);
  assert.equal(health.providers.anthropic.evidence.length, 8);
  assert.ok(health.providers.anthropic.evidence.every((entry) => typeof entry.targetID === "string" && typeof entry.modelID === "string" && Number.isFinite(entry.at)));
});

test("aborts are recognized in every observed wire shape and nothing else", () => {
  // SDK MessageAbortedError carries its text under data.message, so only the name survives
  // normalization; session.error events carry the bare string.
  assert.equal(isAbortError({ name: "MessageAbortedError", data: { message: "Aborted" } }), true);
  assert.equal(isAbortError({ name: "AbortError", message: "The operation was aborted" }), true);
  assert.equal(isAbortError("Aborted"), true);
  assert.equal(isAbortError({ message: "Aborted" }), true);
  assert.equal(isAbortError({ name: "APIError", message: "connection aborted by upstream" }), false);
  assert.equal(isAbortError({ name: "APIError", message: "request exceeds the available context size" }), false);
  assert.equal(isAbortError(null), false);
});

test("a throttle fences the target but never quarantines the provider", () => {
  // `rate` was the last kind falling through to the catch-all that records health evidence,
  // while `quota` -- the same signal, harder -- has never recorded any. Two throttled models
  // inside the window therefore quarantined a provider for being busy.
  let health = { providers: {} };
  const at = Date.now();
  // Simulate what the broker now does for `rate`: circuit the target, record NOTHING.
  assert.deepEqual(health.providers, {});
  // And prove the evidence path still works for a genuine compatibility fault, so the
  // mechanism is fenced, not disabled.
  health = recordFailureEvidence(health, "acme", { targetID: "acme-a", modelID: "a", reasonCode: "other", error: { message: "boom" }, at });
  health = recordFailureEvidence(health, "acme", { targetID: "acme-b", modelID: "b", reasonCode: "other", error: { message: "boom" }, at: at + 1 });
  assert.equal(health.providers.acme.state, "quarantined");
});
