# Delayed Profile Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-profile, per-rung fallback delays so background memory ingestion can wait five minutes before using `local-27b`, preserving Frigate's slot during ordinary bursts while using card 1 for genuine overflow.

**Architecture:** Configuration normalizes authored fallback groups and delay values as one aligned structure, then exports the established `profileFallbacks` arrays plus a parallel normalized `profileFallbackAfterMs` map. Gateway lease attempts report elapsed wait time to the broker; `chooseTarget` filters only the fallback groups used for normal selection while retaining unfiltered groups for refusal classification and context-overflow rescue. The plugin path remains unchanged so explicitly selected `local`/`private` sessions retain immediate 27B fallback and interactive OpenCode performance outranks Frigate.

**Tech Stack:** Node.js ESM, `node:test`, Unix-domain HTTP broker API, JSON/JSONC deployment configuration, systemd user service.

**Spec:** `/home/dev/opencode-broker/docs/superpowers/specs/2026-09-23-delayed-profile-fallback-design.md`

## Global Constraints

- Existing profiles with no `profileFallbackAfterMs` entry retain immediate fallback exactly.
- Apply delay filtering only in normal `chooseTarget` fallback selection; never change `fallbackTargetGroupsFor()` or `targetEligibleIDsFor()`.
- Preserve unfiltered fallback groups for the context-overflow rescue at `lib/routing.js:1614-1635`.
- `waitedMs` measures time since the first refusal inside the current `leaseWithPrepare()` invocation; the first lease attempt sends `0`.
- Do not derive `waitedMs` from the outer client deadline or carry it across forward/stream retry attempts.
- Do not modify `plugin/router.js`; `local`/`private` fallback remains immediate by design.
- Do not enable cloud egress for `memory` until private-session capture suppression exists and the historical failed corpus has been re-imported locally.
- Per-task commits on this feature branch are expected and required (the run reviews each task's `base..HEAD`). What needs a separate explicit authorization, and is gated to Task 6, is the RELEASE: merging or pushing to `main`, any version bump or CHANGELOG entry, restarting the live broker, and modifying deployment config under `/home/dev/devbox/config/opencode-broker/`. Do not perform any of those before Task 6's authorization gate.
- Preserve the partially written failing normalization tests and fixture left by the cancelled worker; remove only defects, do not restart that work.

## Review Focus

- A LAN filter deleting authored rung 0 must not shift rung 1 onto rung 0's delay.
- An absent delay entry must preserve immediate fallback for latency-sensitive profiles such as `assist`.
- A not-yet-eligible rung must remain visible to busy/refusal classification so the gateway retries instead of failing.
- Context-window rescue must retain all unfiltered cloud rungs even when their ordinary-selection delay has not elapsed.
- A second forward attempt after a failed upstream stream must begin at `waitedMs = 0`, not inherit elapsed wall time from the client request.

---

### Task 1: Finish delay configuration normalization

**Files:**
- Modify: `lib/config.js:524-579,583-618`
- Preserve/extend: `tests/fixtures/profile-fallback-delay.config.json`
- Preserve/extend: `tests/profile-fallback-delay.test.mjs:26-138`

**Interfaces:**
- Consumes: raw `profileFallbacks`, raw `profileFallbackAfterMs`, normalized `targets`
- Produces: `CONFIG.profileFallbacks: Readonly<Record<string, readonly (readonly string[])[]>>`
- Produces: `CONFIG.profileFallbackAfterMs: Readonly<Record<string, readonly number[]>>`

- [ ] **Step 1: Run the existing failing normalization test**

Run:

```bash
node --test tests/profile-fallback-delay.test.mjs
```

Expected: FAIL during config import: the cancelled worker changed `normalizeProfileFallbacks()` to three arguments but `CONFIG` still calls it with two, so `known` is undefined when `idList()` reads it. Step 2 must fix both the call signature and the exported wrapper shape.

- [ ] **Step 2: Export normalized groups and delays under separate public keys**

Create one normalized value before `CONFIG` and preserve the public shape expected by all routing consumers:

```js
const normalizedProfileFallbacks = normalizeProfileFallbacks(
  raw.profileFallbacks,
  raw.profileFallbackAfterMs,
  targets,
);

export const CONFIG = Object.freeze({
  // existing fields...
  profileFallbacks: normalizedProfileFallbacks.groups,
  profileFallbackAfterMs: normalizedProfileFallbacks.delays,
  // existing fields...
});
```

Do not expose the wrapper object as `CONFIG.profileFallbacks`.

- [ ] **Step 3: Add the uncovered config edge-case assertions**

Extend `tests/profile-fallback-delay.test.mjs` with a top-level non-object case and verify all failures remain safe-immediate:

```js
test("a non-object profileFallbackAfterMs map is ignored safely", () => {
  for (const value of [300_000, "memory", []]) {
    const { delays, stderr } = loadConfig(lanConfig({ profileFallbackAfterMs: value }));
    assert.deepEqual(delays.memory, [0]);
    assert.equal(errorLines(stderr, "profileFallbackAfterMs must be an object").length, 1);
  }
});
```

Also retain the existing assertions for short arrays, surplus entries, non-array per-profile values, unknown profiles, profiles without rungs, negative/non-finite values, and group-delay alignment after LAN filtering.

- [ ] **Step 4: Run normalization tests**

Run:

```bash
node --test tests/profile-fallback-delay.test.mjs tests/profile-fallback.test.mjs
```

Expected: PASS; existing `profileFallbacks` consumers still receive arrays, and the new parallel delays map is present.

### Task 2: Gate ordinary fallback selection by elapsed wait

**Files:**
- Modify: `lib/routing.js:937-963,1570-1635`
- Extend: `tests/profile-fallback-delay.test.mjs`

**Interfaces:**
- Consumes: `chooseTarget({ ..., waitedMs?: number })`
- Consumes: `CONFIG.profileFallbackAfterMs[profile]`
- Produces: ordinary fallback groups whose normalized delay is `<= waitedMs`
- Preserves: unfiltered groups for `targetEligibleIDsFor()` and context-overflow rescue

- [ ] **Step 1: Add failing ordinary-selection tests**

Append tests using the existing `R.chooseTarget`, `resident()`, fixture profiles, and `CONTEXT` helpers:

```js
const fullPrimary = { "lan-primary": 1 };

test("a delayed rung is not selected before its threshold", () => {
  const choice = R.chooseTarget({
    profile: "memory",
    tier: "worker",
    active: fullPrimary,
    localModels: resident("lan-primary-9b", "lan-rung-a-27b"),
    contextTokens: CONTEXT,
    waitedMs: 299_999,
  });
  assert.equal(choice, null);
});

test("a delayed rung is selected at its threshold", () => {
  const choice = R.chooseTarget({
    profile: "memory",
    tier: "worker",
    active: fullPrimary,
    localModels: resident("lan-primary-9b", "lan-rung-a-27b"),
    contextTokens: CONTEXT,
    waitedMs: 300_000,
  });
  assert.equal(choice.target.id, "lan-rung-a");
});
```

Add equivalent tests for:
- `assist` with no delay entry selecting immediately at `waitedMs: 0`
- `staged`: rung A from 60,000 through 299,999; rung A still wins after 300,000 because earliest eligible group wins
- `wobbly`: rung B at 0; rung A displaces it at 900,000
- omitted `waitedMs` behaving as 0

- [ ] **Step 2: Run the routing tests and verify the right failure**

Run:

```bash
node --test tests/profile-fallback-delay.test.mjs
```

Expected: FAIL because `chooseTarget()` ignores `waitedMs` and immediately selects `lan-rung-a` while the primary is full.

- [ ] **Step 3: Implement normal-selection filtering without touching shared helpers**

Add `waitedMs = 0` to `chooseTarget`'s options. Keep the existing unfiltered value:

```js
const fallbackGroups = fallbackTargetGroupsFor(profile, tier, targets);
const fallbackDelays = CONFIG.profileFallbackAfterMs?.[profile] ?? [];
const elapsed = Number.isFinite(Number(waitedMs)) && Number(waitedMs) >= 0
  ? Number(waitedMs)
  : 0;
const selectableFallbackGroups = fallbackGroups.filter((_, index) =>
  (fallbackDelays[index] ?? 0) <= elapsed);
```

Use `selectableFallbackGroups` only for the `availableFallback` calculation at current `lib/routing.js:1597-1599`. Keep `fallbackGroups` for the context-overflow expression at current `:1617`. Do not alter `fallbackTargetGroupsFor()` or `targetEligibleIDsFor()`.

- [ ] **Step 4: Add the context-overflow regression test**

Use fixture profile `overflow` (`cloud-small` primary, delayed `cloud-big` rung). Supply a context larger than `cloud-small` but fitting `cloud-big`, with `waitedMs: 0`, and assert the roomiest rescue still chooses `cloud-big` despite its ordinary delay:

```js
test("context-overflow rescue keeps seeing unfiltered delayed rungs", () => {
  const choice = R.chooseTarget({
    profile: "overflow",
    tier: "worker",
    active: {},
    contextTokens: 100_000,
    waitedMs: 0,
  });
  assert.equal(choice.target.id, "cloud-big");
});
```

- [ ] **Step 5: Run targeted routing tests**

Run:

```bash
node --test tests/profile-fallback-delay.test.mjs tests/profile-fallback.test.mjs
```

Expected: PASS, including existing immediate-fallback behavior.

### Task 3: Thread and validate `waitedMs` through the broker lease API

**Files:**
- Modify: `bin/opencode-broker:644-685,772-835,958-981,1087-1107,1401-1414`
- Extend: `tests/profile-fallback-delay.test.mjs`
- Extend: `tests/refusal-codes.test.mjs:260-299`
- Modify: `docs/API.md:11-13,79-86`

**Interfaces:**
- Consumes: optional `/lease` JSON field `waitedMs: non-negative finite number`
- Produces: `selection.waitedMs`, passed to ordinary and `roomyChoice` `chooseTarget()` calls
- Preserves: `/preview` selection semantics as `waitedMs = 0`, with additive delayed-rung metadata

- [ ] **Step 1: Add a failing real-broker `/lease` test**

Add local real-broker helpers to `tests/profile-fallback-delay.test.mjs`; the helpers in `tests/profile-fallback.test.mjs` are file-local, return only parsed bodies, and hard-wire another fixture. The new `post()` returns `{ statusCode, body }`; the new `withBroker()` explicitly sets `OPENCODE_BROKER_CONFIG` to `profile-fallback-delay.config.json`, uses a temporary HOME, starts the model-residency HTTP stub with both primary and rung resident, and removes the temporary HOME in `finally`.

Fill the fixture primary with a holder lease, then assert:

```js
const early = await post(socketPath, "/lease", {
  sessionID: "ses-memory-early",
  profile: "memory",
  tier: "worker",
  contextTokens: CONTEXT,
  waitedMs: 299_999,
});
assert.equal(early.statusCode, 400);
assert.equal(early.body.code, "target-busy");

const elapsed = await post(socketPath, "/lease", {
  sessionID: "ses-memory-elapsed",
  profile: "memory",
  tier: "worker",
  contextTokens: CONTEXT,
  waitedMs: 300_000,
});
assert.equal(elapsed.statusCode, 200);
assert.equal(elapsed.body.target.id, "lan-rung-a");
```

Expected pre-implementation failure: both requests behave identically because `/lease` drops `waitedMs` before selection.

- [ ] **Step 2: Add validation tests**

Post `waitedMs` values `-1`, `"300000"`, and `null`. Add a raw-body helper and send valid JSON containing `"waitedMs":1e309`; JavaScript parses that number as `Infinity`, exercising the `Number.isFinite` branch. Assert every invalid value receives HTTP 400 rather than silently becoming an elapsed delay. Omitted `waitedMs` remains valid and means 0.

- [ ] **Step 3: Add refusal-code regression coverage in the real-broker suite**

Extend the existing test `"target-busy: a resident local model with every slot taken is a wait, not a refusal"` in `tests/refusal-codes.test.mjs`, or add a neighboring test using delayed fixture config, to prove a delayed but resident/full rung remains visible to the unfiltered busy computation and yields `target-busy`, not `no-eligible-local-target`.

- [ ] **Step 4: Thread `waitedMs` through `acquire()`**

Validate beside `contextTokens`:

```js
const hasWaitedMs = request.waitedMs !== undefined;
const waitedMs = hasWaitedMs ? request.waitedMs : 0;
if (hasWaitedMs && (typeof waitedMs !== "number" || !Number.isFinite(waitedMs) || waitedMs < 0)) {
  throw new Error("waitedMs must be a non-negative finite number");
}
```

The request handler converts validation exceptions to HTTP 400 at `bin/opencode-broker:1492-1501`; there is no `failLease()` helper.

Add `waitedMs` to `selection`, so both the ordinary call at current `bin/opencode-broker:807` and `roomyChoice` call at `:830` inherit it.

Add a real-broker context-pressure test that specifically reaches `roomyChoice`: extend the delay fixture with a profile whose primary is `cloud-small` and delayed rung is `lan-rung-a`; send `contextTokens: 6000`, make the local rung resident, and send `waitedMs: 300000`. Context pressure removes the 8k cloud primary while retaining the local rung. Assert the broker leases `lan-rung-a`; without propagation to the `roomyChoice` call, it cannot.

- [ ] **Step 5: Run broker and refusal tests**

Run:

```bash
node --test tests/profile-fallback-delay.test.mjs tests/profile-fallback.test.mjs tests/refusal-codes.test.mjs
```

Expected: PASS; early request is `target-busy`, elapsed request leases the rung, invalid request bodies receive 400, and the context-pressure `roomyChoice` retains the value.

- [ ] **Step 6: Document the lease field**

Update `docs/API.md` `/lease` request schema with:

```text
waitedMs — optional non-negative finite milliseconds already spent waiting in the current
gateway lease loop; defaults to 0. Callers must reset it for a new upstream-forward attempt.
```

- [ ] **Step 7: Keep `/preview` truthful about delayed rungs**

The call at `bin/opencode-broker:1401` belongs to `/preview`, not `/selection`. Pass `waitedMs: 0`. Preserve the existing `preview` object for HUD consumers and add an additive response field:

```json
{
  "delayedProfileFallbacks": [
    { "targetIDs": ["local-27b"], "afterMs": 300000 }
  ]
}
```

Add a real `/preview` test: with a full primary and a delayed rung, selection is null at time zero but the response names the delayed rung and threshold, so preview does not imply no fallback exists. Document the additive field in `docs/API.md`.

### Task 4: Report elapsed wait from the gateway retry loop

**Files:**
- Modify: `gateway/lib/gateway.js:440-496,536-592,636-658`
- Extend: `gateway/tests/gateway.test.mjs:1293-1368,1544-1568`

**Interfaces:**
- `leaseOnce(sessionID, requestBody, excludeProviders, route, api, waitedMs = 0)` adds `waitedMs` to the broker body
- `leaseWithPrepare(..., deadline, api)` owns a per-invocation `waitStarted` set only after the first waitable refusal
- `completionsFor()` creates a fresh `leaseWithPrepare()` invocation for every outer forward attempt

- [ ] **Step 1: Add deterministic time injection and a failing gateway body-capture test**

Add `sleepImpl = sleep` beside the existing injected `now` in `createGatewayHandler`, and replace the retry-loop `sleep(...)` call at `gateway/lib/gateway.js:584-587` with `sleepImpl(...)`. Production behavior remains identical.

Use the existing stub-broker gateway harness with `prepareRetryMs: 5`, `now: () => clock`, and `sleepImpl: async (ms) => { clock += ms; }`. Return `target-busy` twice then success, record each `/lease` body, and assert:

```js
assert.equal(leaseBodies[0].waitedMs, 0);
assert.equal(leaseBodies[1].waitedMs, 5);
assert.equal(leaseBodies[2].waitedMs, 10);
```

The injected sleep advances the injected clock, so the test uses no real delay or flaky wall-clock equality.

- [ ] **Step 2: Add the first-refusal clock test**

Advance `clock` while the stub constructs the first `target-busy` refusal, then allow `sleepImpl(5)` to advance it again. Assert the second lease body reports exactly `5`, excluding the first response's simulated latency and proving the clock starts only after the first waitable refusal.

- [ ] **Step 3: Add the outer-attempt reset test**

Simulate `target-busy → successful lease → upstream forward failure → successful lease`, causing the `ATTEMPTS` loop to invoke `leaseWithPrepare()` again. Assert lease bodies report `[0, 5, 0]`; the first lease of attempt 2 resets despite the older request-level deadline.

- [ ] **Step 4: Implement the gateway clock**

Pass `waitedMs` into `leaseOnce()` and include it in the `/lease` body at current `gateway/lib/gateway.js:467-486`. In `leaseWithPrepare()`:

```js
let waitStarted = null;
for (;;) {
  const waitedMs = waitStarted === null ? 0 : Math.max(0, now() - waitStarted);
  try {
    return await leaseOnce(sessionID, requestBody, excluded, route, api, waitedMs);
  } catch (refusal) {
    // preserve existing waitability checks
    if (waitStarted === null) waitStarted = now();
    // preserve existing queue/retry/deadline logic
  }
}
```

Set `waitStarted` only after a refusal has passed the existing `isBusy` / `isPreparing` / `absentLocal` waitability gate. Do not change zero-budget behavior.

- [ ] **Step 5: Run gateway tests**

Run:

```bash
node --test gateway/tests/gateway.test.mjs
```

Expected: PASS, including existing keepalive, wait fairness, zero-budget, and timeout behavior.

### Task 5: Document, verify, and independently review the feature

**Files:**
- Modify: `README.md:92-105`
- Preserve: `docs/superpowers/specs/2026-09-23-delayed-profile-fallback-design.md`
- Preserve: `docs/superpowers/plans/2026-09-23-delayed-profile-fallback-implementation.md`

**Interfaces:**
- Documents deployment config only; no new runtime interface beyond Tasks 1-4

- [ ] **Step 1: Document the configuration key**

Add a README example and semantics:

```jsonc
"profileFallbacks":       { "memory": [["local-27b"], ["haiku"]] },
"profileFallbackAfterMs": { "memory": [300000, 900000] }
```

State that arrays are aligned after normalization, missing entries mean 0, the first eligible group in authored order wins, no entry preserves immediate fallback, and gateway callers accumulate delay only after their first waitable refusal. State explicitly that plugin-driven `local`/`private` profiles remain immediate.

- [ ] **Step 2: Run the full suite**

Run exactly:

```bash
npm test
```

Expected: every test passes with zero failures. Record exact pass/fail/skip counts.

- [ ] **Step 3: Inspect the complete diff**

Run:

```bash
git --no-pager status --short
git --no-pager diff --check
git --no-pager diff
```

Expected: only delayed-profile-fallback source, tests, API/README documentation, spec, and plan changes; no usage-log/cache-token edits from the cancelled worker.

- [ ] **Step 4: Request independent review**

The reviewer must inspect the complete diff with emphasis on: normalized group/delay alignment, preservation of unfiltered fallback groups, real `/lease` threading, gateway clock reset boundaries, refusal classification, and unchanged immediate fallback for profiles without config.

### Task 6: Wire and verify local overflow after product release authorization

**Files:**
- Modify later: `/home/dev/devbox/config/opencode-broker/config.json`
- Modify later: `/home/dev/devbox/config/opencode-broker/NOTES.md`

**Interfaces:**
- Consumes released broker support for `profileFallbackAfterMs`
- Produces deployment config: `memory` primary `local-memory`; `local-27b` eligible after five minutes

- [ ] **Step 1: Do not perform this task until release/deploy authorization is explicit**

Per-task commits on the feature branch are already done by Tasks 1-5; this task is the RELEASE, and the development policy forbids merging or pushing to `main`, bumping the version, restarting the live broker, or modifying deployment config without explicit authorization. Stop after Task 5 and present verification evidence unless that authorization has been supplied.

- [ ] **Step 2: Deploy and restart the released primitive with the OLD config first**

This ordering is load-bearing. Add the rung only AFTER the new broker code is live. If the rung
is added while the old broker is still running (or before its restart), the old code ignores the
unknown `profileFallbackAfterMs` key and routes `memory` to `local-27b` IMMEDIATELY — the exact
Frigate starvation this feature exists to prevent.

Deploy the released primitive with the deployment config unchanged, restart, and verify a profile
with no delay entry still falls back immediately (backward compatibility in the live process).

- [ ] **Step 3: Update the deployment config atomically**

Preserve all existing keys and add:

```jsonc
"profileFallbacks": {
  // preserve existing entries
  "memory": [["local-27b"]]
},
"profileFallbackAfterMs": {
  "memory": [300000]
}
```

Do not add `haiku` or add `memory` to `profileCloudEgress` yet.

- [ ] **Step 4: Mark the workaround and priorities in NOTES.md**

Record:
- delayed 27B overflow is a capacity workaround, not the desired final topology
- memory waits five minutes because background ingestion yields to Frigate
- `local`/`private` retain immediate 27B fallback because explicitly selected interactive OpenCode performance outranks Frigate
- cloud remains blocked until private capture suppression and local backlog re-import are complete

- [ ] **Step 5: Restart and verify the delayed rung**

Restart:

```bash
systemctl --user restart opencode-model-broker.service
```

Verify status, then submit controlled lease probes proving `memory` is `target-busy` before five minutes and routes to `local-27b` after five minutes. Monitor Frigate genai latency and local-27b lease counts; roll back the deployment config if Frigate begins timing out.

- [ ] **Step 6: Measure capacity before resuming re-import**

Measure at least one normal active-hour window. Success criteria:
- indexing queue no longer grows monotonically
- completion rate meets or exceeds organic arrival rate
- no Frigate timeout increase
- no cloud egress from `memory`

Only then restart failed-document re-import at a rate below measured spare completion capacity.
