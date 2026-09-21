import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const { cloudTargetAdmitted, revalidateAdmission } = await import("../lib/routing.js");

// alibaba-token-plan is the fixture's trustedSubscriptionProviders entry.
const TRUSTED = "alibaba-token-plan";
const cloud = (providerID, extra = {}) => ({ kind: "cloud", providerID, ...extra });

test("a trusted provider is admitted while opencode still holds its credential", () => {
  const providers = { [TRUSTED]: { authType: "api", connected: true } };
  assert.equal(cloudTargetAdmitted(cloud(TRUSTED), providers), true);
});

// ☠️ The regression this guards: "trusted" used to mean "permanently admitted",
// so a provider whose token had expired kept being leased and could only answer
// 401 -- the tier looked capacity-starved rather than unplugged.
test("a trusted provider removed from opencode is NOT admitted", () => {
  const providers = { [TRUSTED]: { authType: "unknown", connected: false } };
  assert.equal(cloudTargetAdmitted(cloud(TRUSTED), providers), false);
});

test("revalidateAdmission disconnects a trusted provider whose auth is gone", () => {
  const inventory = { targets: {
    "t-alibaba": { id: "t-alibaba", providerID: TRUSTED, modelID: "m", kind: "cloud", tiers: ["worker"] },
  } };
  const withAuth = revalidateAdmission(inventory, { [TRUSTED]: "api" });
  assert.equal(withAuth.providers[TRUSTED].connected, true);
  assert.ok(withAuth.targets["t-alibaba"], "kept while the credential exists");

  const removed = revalidateAdmission(inventory, {});   // opencode no longer has it
  assert.equal(removed.providers[TRUSTED].connected, false);
  assert.equal(removed.targets["t-alibaba"], undefined, "discovered targets drop with the credential");
});

// Before the first revalidation there is no providers map at all. Failing closed
// there would strand routing on a cold start rather than on a real signal, so a
// missing entry stays permissive; only a known-disconnected one rejects.
test("a cold providers map does not disable a trusted provider", () => {
  assert.equal(cloudTargetAdmitted(cloud(TRUSTED), {}), true);
});

test("a non-trusted cloud provider still requires proven oauth", () => {
  assert.equal(cloudTargetAdmitted(cloud("openai"), { openai: { authType: "oauth", connected: true } }), true);
  assert.equal(cloudTargetAdmitted(cloud("openai"), { openai: { authType: "api-key", connected: true } }), false);
});

test("local targets are unaffected by provider admission", () => {
  assert.equal(cloudTargetAdmitted({ kind: "local", providerID: "llamacpp" }, {}), true);
});
