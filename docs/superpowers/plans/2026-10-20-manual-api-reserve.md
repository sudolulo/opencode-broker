# Manual API Reserve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit operator-configured manual Anthropic API targets only through explicit named broker profiles and the existing gateway path, without changing defaults or permitting automatic fallback.

**Architecture:** Normalize an explicit allowlist from existing static cloud targets and enforce it with a pure admission helper. Thread profile context through broker selection and leases; keep the gateway as the only credential owner and test the real alias/proxy flow with fake services.

**Tech Stack:** Node ESM, broker config and routing, `node:test`, existing gateway tests and fake upstream/broker harnesses.

**Spec:** `/home/dev/opencode-broker/docs/superpowers/specs/2026-10-20-manual-api-reserve-design.md`

## Global Constraints

- Absent or empty `manualApiTargets` normalizes to `{}` and ordinary behavior remains unchanged.
- Registered paid providers are explicit-profile only; automatic routing, discovery, fallback, outage, probation, and trial routes must not select them.
- Gateway owns API credential bytes via keyFile. Manual API policy reads no credentials/auth files; existing subscription authRevision/authTypes behavior remains unchanged.
- Existing budgets remain requests/tokens only; do not claim USD enforcement or infer spend caps.
- No host config/secret/service-unit edits, deployment, restart, version change, paid inference, or commits in this phase.
- Do not widen provider allowlist, `localOnly`, or `resolvableModels`.

## Review Focus

1. Malformed or misplaced config fails startup closed; test invalid fields, unknown/non-cloud target, and auto-tier placement in Task 1.
2. Forged inventory and OAuth/trusted metadata cannot authorize paid automatic access; test wrong identity and discovered source in Task 1 and routing regression in Task 1.
3. Explicit-to-auto lease reuse stops paid spending; test stale held lease release/rejection in Task 2.
4. Missing/unreadable gateway key or missing auth store fails without bypass; test fail-closed errors, while an API-only explicit profile works without unrelated `auth.json`, in Task 2.
5. Protocol/header/model alias isolation; test alias translation, key destination, proxy exclusion, and upstream failure isolation with fake services in Task 2.

---

### Task 1: Pure manual API policy, config integration, and routing admission

**Files:**
- Create: `lib/manual-api.js`
- Create: `tests/manual-api.test.mjs`
- Modify as needed: `lib/config.js`, `lib/routing.js`, `tests/config-parse.test.mjs`, `tests/provider-disable.test.mjs`, `tests/routing.test.mjs`
- No `bin/` edits until Task 2.

**Interfaces:**
- Produces `normalizeManualApiTargets(raw, context)`, which returns a record keyed by target ID with frozen `{ providerID, modelID, profiles }` values, or throws a clear error.
- Produces `manualApiAdmission(target, profile, policy)`, returning `true` for exact registered static cloud identity in an allowed explicit profile, `false` for any disallowed case for a registered provider, and `null` for unregistered providers.
- Config record derives only from normalized static cloud `CONFIG.targets`; context contains normalized targets, profiles, tiers, fallbacks, profile fallbacks, offline profiles, and `trustedSubscriptionProviders`.
- The helper performs no I/O, reads no credentials, and imports no config module.

- [ ] **Step 1: Write failing pure-policy tests.** Add this runnable test code to `tests/manual-api.test.mjs`:
  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { normalizeManualApiTargets, manualApiAdmission } from '../lib/manual-api.js';

  const target = { id: 'reserve-sonnet', providerID: 'paid-test-provider', modelID: 'test-sonnet', kind: 'cloud' };
  const context = {
    targets: { [target.id]: target },
    profiles: { 'api-reserve': [target.id] },
    tiers: { worker: [] },
    fallbacks: { worker: [] },
    profileFallbacks: {},
    offlineProfiles: [],
    trustedSubscriptionProviders: [],
  };
  const raw = { [target.id]: ['api-reserve'] };

  test('normalizes an explicit API reserve and applies exact admission', () => {
    const policy = normalizeManualApiTargets(raw, context);
    assert.deepEqual(Object.keys(normalizeManualApiTargets(undefined, context)), []);
    assert.equal(manualApiAdmission(target, 'api-reserve', policy), true);
    assert.equal(manualApiAdmission(target, 'auto', policy), false);
    assert.equal(manualApiAdmission(target, 'wrong-profile', policy), false);
    assert.equal(manualApiAdmission({ ...target, source: 'subscription-oauth' }, 'api-reserve', policy), false);
    assert.equal(manualApiAdmission({ ...target, id: 'other-id' }, 'api-reserve', policy), false);
    assert.equal(manualApiAdmission({ ...target, providerID: 'unrelated-provider' }, 'api-reserve', policy), null);
    assert.throws(
      () => normalizeManualApiTargets(raw, { ...context, tiers: { worker: [target.id] } }),
      /manualApiTargets/,
    );
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy[target.id]));
    assert.ok(Object.isFrozen(policy[target.id].profiles));
  });
  ```
- [ ] **Step 2: Run the focused pure test** with `node --experimental-test-module-mocks --test tests/manual-api.test.mjs`. Expected before implementation: module/export unavailable and test fails.
- [ ] **Step 3: Implement normalization and admission** exactly per the spec. Validate malformed fields; unknown/non-cloud targets; no valid non-auto/non-manual/non-offline profile; target not primary; shared registered paid provider with non-registered static target; trusted-subscription overlap; target membership in tiers, tier fallbacks, any `profileFallbacks`, or unauthorized profile primary. Throw a clear startup error; do not silently normalize invalid input.
- [ ] **Step 4: Add config-parse and routing regression tests before routing changes.** Cover absent/empty map identity, forged synthetic OAuth inventory, default/auto exclusion, discovery and fallback exclusion, exact explicit primary availability, and unchanged ordinary OAuth/subscription/local admission. Expected before implementation: new regressions fail against existing routing.
- [ ] **Step 5: Wire config and selection.** Normalize `CONFIG.manualApiTargets`; consult `manualApiAdmission` first in `cloudTargetAdmitted(target, providers = {}, profile = 'auto')`, then preserve existing admission behavior. Ensure target membership functions exclude registered paid providers from auto/discovery/fallback and only the allowed explicit profile primary can select one.
- [ ] **Step 6: Run focused pure/config/routing tests.** Run `node --experimental-test-module-mocks --test tests/manual-api.test.mjs tests/config-parse.test.mjs tests/provider-disable.test.mjs tests/routing.test.mjs`. Expected before implementation: tests fail; after implementation: all asserted policy and regression cases pass; no default route selects a paid target.

### Task 2: Request profile propagation, leases, and gateway end-to-end isolation

**Files:**
- Modify: `bin/opencode-broker`; existing broker tests; gateway fake tests
- Create: gateway manual API test file only if appropriate to existing test layout
- No production gateway changes unless a pinned contract fails; report that unexpected gap to the parent first. Do not edit `model-outage-runtime.js` to allow API; defaults deny.

**Interfaces:**
- Consumes the `CONFIG.manualApiTargets` record and `manualApiAdmission` contract from Task 1.
- Explicit request profile is passed through lease filtering, held-lease reuse, and profile-scoped selection/projection. Calls without profile remain default-deny for paid targets.
- `requestedCloud` authRevision logic exempts only a valid dedicated API-only explicit profile from unrelated OpenCode `auth.json`; ordinary mixed/subscription requests retain checks.

- [ ] **Step 1: Write failing broker request-path tests.** In `tests/manual-api-profile.test.mjs`, cover explicit-profile target lease; same request without `auth.json`; ordinary cloud denial unchanged; ordinary mixed/subscription authRevision check retained; held paid lease released or rejected after switching to auto; no profile-context leakage in global inventory/status; outage runtime call without profile remains denied; no automatic outage/probation/trial route selects paid target.
- [ ] **Step 2: Run the focused request-path test** with `node --experimental-test-module-mocks --test tests/manual-api-profile.test.mjs`. Expected before implementation: profile-only lease/auth behavior and stale-lease rejection regressions fail.
- [ ] **Step 3: Implement request-path propagation.** Thread explicit profile through lease filtering, held-lease reuse, and profile-scoped selection/projection. Ensure profile context does not expand global inventory. Switch-to-auto releases/rejects stale paid leases. Keep `model-outage-runtime` calls without profile default-denied. Keep provider IDs distinct in budget/control metrics; do not add USD budget logic.
- [ ] **Step 4: Implement authRevision boundary and pin its failures.** A valid dedicated API-only explicit profile must not require unrelated OpenCode `auth.json`; ordinary mixed/subscription requests continue authRevision checks. Missing auth store in ordinary cloud must fail closed.
- [ ] **Step 5: Write gateway fake-service tests.** Adapt existing test harness in `gateway/tests/manual-api.test.mjs`, reusing the existing server helper from `router.test.mjs` (do not invent a new helper signature). Use these exact fixture requests and expected outcomes for `/lease`:
  ```json
  {"request":{"sessionID":"reserve-check","profile":"api-reserve","tier":"worker","providers":["paid-test-provider"]},"expected":{"status":200,"target":"reserve-sonnet"}}
  {"request":{"sessionID":"reserve-auto","profile":"auto","tier":"worker","providers":["paid-test-provider"]},"expected":{"status":"refused","target":"not paid-test-provider"}}
  {"request":{"sessionID":"reserve-local","profile":"api-reserve","tier":"worker","providers":["paid-test-provider"],"localOnly":true},"expected":{"status":"refused","target":"none"}}
  {"request":{"sessionID":"reserve-unrelated","profile":"api-reserve","tier":"worker","providers":["unrelated-provider"]},"expected":{"status":"refused","target":"none"}}
  {"request":{"sessionID":"reserve-check","profile":"auto","tier":"worker","providers":["paid-test-provider"]},"expected":{"status":"refused","target":"no held paid lease"}}
  ```
  The implementer reuses the existing router test server helper and adapts these fixtures to its established request/assertion shape. Also assert alias translation, `Messages` protocol, `x-api-key` only to intended upstream, no subscription proxy request, unknown model/default routes cannot choose paid provider, upstream failure isolation, and missing/unreadable `keyFile` fail-closed behavior. Fakes must not perform paid inference.
- [ ] **Step 6: Run focused broker and gateway tests.** Run `node --experimental-test-module-mocks --test tests/manual-api-profile.test.mjs` and the gateway manual API test. Expected: explicit API-only path succeeds without auth.json; normal/default, stale lease, outage, missing credential, and protocol isolation cases fail closed as specified.
- [ ] **Step 7: Document operator semantics in `docs/MANUAL-API.md`.** Describe explicit-only admission, gateway-owned keyFile, no auto/fallback, request/token-only budgets, and that deployment/host config changes are outside this phase. Include no secret value and no claim of dollar-cap enforcement.

## Verification handoff

- [ ] Run focused broker tests: `node --experimental-test-module-mocks --test tests/manual-api.test.mjs tests/config-parse.test.mjs tests/provider-disable.test.mjs tests/routing.test.mjs tests/manual-api-profile.test.mjs`.
- [ ] Run focused gateway test: `node --experimental-test-module-mocks --test gateway/tests/manual-api.test.mjs`.
- [ ] Run full suite separately with the package script: `npm test`.
- Expected before implementation: focused tests fail; expected after implementation: all focused tests and full suite pass. Tester performs verification. Do not deploy, edit host configuration, restart services, perform paid inference, or commit in any task.
