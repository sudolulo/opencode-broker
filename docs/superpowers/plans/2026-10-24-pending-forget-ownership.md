# Immutable pending-forget ownership implementation plan

**Goal:** Deliver the complete authorized 1.27.6 candidate as one versioned release batch, replacing unsafe mutable pending-forget ownership with immutable create-only records and exact-handle cleanup. Independent-review corrections may use additional commits without another version bump; never amend.

**Architecture:** Publish immutable, validated records by exclusive temp write plus atomic hard-link create-only publication. Make cleanup authority explicit in handles; claim legacy mutable files by atomic rename into private claim directories. Integrate all consumers and preserve original-intent TTL and first-settlement authority.

**Tech Stack:** Node ESM, Node filesystem APIs, `node:test`, child processes with isolated private `HOME`, existing broker/HUD tests.

**Spec:** `/home/dev/projects/audit/broker-release/docs/superpowers/specs/2026-10-24-pending-forget-ownership.md`

> **Required subskill:** `subagent-driven-development` via `plan-run`; `executing-plans` only when inline execution is allowed.

## Global Constraints

- Implement the whole authorized candidate as **one** existing 1.27.6 release commit, only after TDD and the full suite pass.
- All 12 pre-existing OWN candidate changes are intended in this batch, not foreign changes. Include allowed new `lib/router-core.js`, `lib/routing.js`, focused queue tests/fixture, docs/API, this plan, and spec.
- Snapshot `git status`, `git diff`, and `git log --oneline -10` first, using the explicit candidate workdir `/home/dev/projects/audit/broker-release`. Never run Git from the session root.
- No pushes or deploys within workflow execution; root owns final integration. Commit is authorized. Do not add attribution, amend, force, or include secrets.
- Before commit, the full bounded test command below must pass with normal exit 0. Capture logs outside the checkout at the unique path `/home/dev/projects/audit/verification-logs/immutable-pending-ownership-full.log`; never overwrite an existing log. If using `tee`, propagate and inspect `PIPESTATUS[0]` explicitly.
- Root-owned temporary peer link `/home/dev/projects/audit/opencode-background-shells` must remain available for tests. Do not npm-reinstall or force-exit processes. Ensure test-owned processes are killed and temporary bases removed on both normal and failure paths.
- Preserve package version 1.27.6 and place changelog updates in its existing batch. Do not alter protected repositories. If authority is missing, return BLOCKED without bypass.

## Review Focus

1. **Cross-process ownership:** delayed L1 failure after L2 publication and L1 success both preserve L2; simultaneous publication loses neither.
2. **Completion version:** false success does not erase `completed: true`; first accepted settlement remains authoritative.
3. **Legacy claim and crash recovery:** claim parses the moved payload, preserves age, and recovers every crash stage without junk or unsafe unlink.
4. **Invalid handles and permissions:** invalid/path-traversal handles reject; files/directories have required modes; collision preserves foreign content.
5. **Offline Manual and lookup/deadline:** immediate model-preserving Manual behavior remains; raw lookup coalescing/deadline/warning and SDK retry behavior stay unchanged.

## Files
`CHANGELOG.md`, `bin/opencode-broker`, `docs/STATE.md`, `hud/tests/hud.test.mjs`, `hud/tui.js`, `package.json`, `plugin/router.js`, `tests/broker-state-durability.test.mjs`, `tests/failover.test.mjs`, `tests/provider-outage-recovery.test.mjs`, `tests/read-only-persistence.test.mjs`, `tests/router.test.mjs`, plus `lib/routing.js`, `lib/router-core.js`, new `lib/pending-forgets.js`, new `tests/pending-forget-ownership.test.mjs`, existing `tests/routing.test.mjs` and `tests/router-core.test.mjs`, only needed private fixtures `tests/fixtures/pending-forget-ownership*.cjs`, `docs/API.md`, and this plan/spec. No other paths without parent context.

**Interfaces:** The spec defines `publishPendingForgetRecord(sessionID, options)` returning an opaque handle or null; `writePendingForgetRecord(sessionID, options)` remains a boolean adapter; `listPendingForgetRecords()` returns records with handles; `readPendingForgetRecord(sessionID)` is summary-only; `removePendingForgetRecord(sessionID, handle)` returns a boolean and never removes by session ID alone. The new `lib/pending-forgets.js` owns the filesystem store; `lib/routing.js` supplies thin compatibility exports using its existing directory and session validator. No production-only fault hooks or exports solely for tests.

## Task 1: Implement and integrate the complete candidate as one release batch

### Step 1: Snapshot scope and write failing tests (TDD red)

- [ ] In `/home/dev/projects/audit/broker-release`, record exact output from `git --no-pager status`, `git --no-pager diff`, and `git --no-pager log --oneline -10`. Reconcile the 12 already-owned candidate changes; do not overwrite or revert unrelated existing WIP.
- [ ] Add focused tests before production changes for all pinned contracts below. Child-process scripts use `process.execPath --input-type=module`, establish private `HOME` before imports, and inspect actual filesystem records. Use no live auth/providers/inference.
- [ ] Prove the tests fail for the current race/unsafe ownership before implementing.

Required test cases:

```js
const assert = require('node:assert');
const { publishPendingForgetRecord, removePendingForgetRecord, listPendingForgetRecords } = require('lib/pending-forgets');

const a = publishPendingForgetRecord('session_a', { leaseID: 'lease_L1' });
const b = publishPendingForgetRecord('session_a', { leaseID: 'lease_L2', completed: true });
assert.notEqual(a.recordID, b.recordID);
assert.equal(removePendingForgetRecord('session_a', a), true);
assert.equal(listPendingForgetRecords().some(r => r.recordID === b.recordID), true);
```
Child sets private `HOME` before imports. Additional listed multi-process cases remain required, not substituted by snippet.

Required test cases:

```text
two processes: delayed L1 failure after L2 publication preserves both
L1 success preserves L2; simultaneous publish loses neither
false-success cannot erase a completed:true version
retry failure leaves bytes and updatedAt unchanged
complete JSON is atomic; directories mode 0700 and records/temp mode 0600
exclusive collision preserves a foreign file
crashes before/after link and during legacy claim recover without junk
legacy ID-only record results in no RPC
legacy replacement is parsed from the moved payload
repeated retry failure never refreshes original TTL
Manual offline cleanup remains immediate and model-preserving
SDK duplicate requests remain 25-to-1; retry-after-timeout unchanged
public writer returns false for ID-only input and preserves existing exact records
missing handle cannot clear another intent; mixed-invalid/path-traversal handles reject
```

Run the focused suite (including the new queue-focused test file) before implementation:

```bash
node --experimental-test-module-mocks --test --test-concurrency=4 \
  tests/routing.test.mjs tests/router-core.test.mjs tests/router.test.mjs \
  tests/failover.test.mjs tests/provider-outage-recovery.test.mjs \
  tests/read-only-persistence.test.mjs tests/broker-state-durability.test.mjs \
  hud/tests/hud.test.mjs tests/pending-forget-ownership.test.mjs
```

Expected red: the new ownership/race assertions fail against mutable session-wide cleanup.

### Step 2: Implement immutable publisher, listing, removal, and legacy claim

- [ ] In `lib/routing.js`, implement the exact interfaces and validation in the spec. Build record IDs from validated session/opaque lease identity and a random UUID; paths must use validated IDs only.
- [ ] Write temp files exclusively (`wx`, 0600), fully serialize before publication, `fchmod`, close, and `linkSync` create-only. Retry publication UUID collisions at most three times. Never rename over a final record. Clean only the temp created by this call in `finally`.
  - Code sketch for temp write pattern:
    ```js
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record) + '\n');
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
      linkSync(temp, destination);
    }
    ```
    Enclosing `finally` unlinks ONLY temp this call created; final `EEXIST` retry fresh UUID up to 3, all other errors explicit.
- [ ] Return opaque exact-record handles; list valid immutable entries oldest-first, with completed versions first for identical session+lease; remove only the matching handle. Keep `readPendingForgetRecord` summary-only and `writePendingForgetRecord` a boolean adapter that rejects bad lease IDs before filesystem access.
- [ ] Claim legacy `<sessionID>.json` through exclusive 0700 `claim.<uuid>/` and atomic rename to fixed in-claim filename. Parse moved bytes, preserve mtime/age, recover claim dirs, and discard ID-only claims locally with warning and no RPC. Never read-then-unlink the mutable source or remove unknown subtrees.
- [ ] Enforce exact 14-day original timestamp/mtime TTL. Do not refresh on retry; expired retry must not republish fresh. Clean expired records/claims by owned handle only; bound stale-temp and empty-claim cleanup to age >=14 days.
- [ ] Re-run the focused suite; turn all publisher/ownership tests green before moving on.

### Step 3: Migrate all consumers and remove alternate unconditional cleanup

- [ ] Update `plugin/router.js`: `retryPendingForgets`, `retireRouteForManual`, and `forgetBinding`; update `hud/tui.js`: `queueKnownPendingForget` and `releaseLease`; update `lib/router-core.js` exported `cleanupDeletedSession` so it cannot remain an unconditional alternate cleanup path.
- [ ] For owning cleanup, enqueue exact intent before broker RPC. Manual cleanup remains nonblocking/immediate. Keep the returned handle and remove only that handle after RPC success; on RPC failure leave its publication untouched. Never publish a new record in a callback that already owns one.
  - Consumer code sketch:
    ```js
    const handle = safelyPublishExactIntent(captured);
    try {
      await brokerRequest('/forget', captured);
      if (handle) removePendingForgetRecord(captured.sessionID, handle);
    } catch (error) {
      reportWarn(error);
      /* existing publication unchanged; no re-enqueue */
    }
    ```
    `safelyPublishExactIntent` is a LOCAL integration pattern, not undefined required public API: implementation try/catch around publish, returns null on FS failure + warn. Prefer inline exact try/catch instead of undefined helper name.
- [ ] If queue filesystem work fails, warn and continue best-effort RPC; do not throw merely because enqueue failed and do not claim durable cleanup. Local route/session/heartbeat fences protect local state only, never other published records.
- [ ] Preserve existing raw lookup coalescing, deadline, warning fixes, SDK duplicate 25-to-1, and retry-after-timeout behavior. Do not claim SDK request cancellation.
- [ ] Convert every existing public-helper caller; ID-only enqueue must not silently succeed. Preserve root API boolean compatibility and require ownership handles for removal.
- [ ] Isolate the Manual-transition test at `tests/router.test.mjs:1055` in a private child. Set `HOME` before imports and deliberately seed a foreign pending record; assert unrelated state cannot leak.
- [ ] Retain older producer compatibility by listing remaining legacy records while busy old TUIs remain; document old legacy-writer limitations until pane respawn. Do not add a migration pipeline.
- [ ] Re-run focused tests and verify Manual offline is immediate and model-preserving.

### Step 4: Apply bounded broker sweep and documentation corrections

- [ ] In `bin/opencode-broker`, remove only redundant `sweepChanged` in `/status` and `/selection` after global pending intent. Retain the sweep call and dirty tracking.
- [ ] Add deterministic cached-plan lockout and expired-record fixture-count cases proving one write, not two, and a stable follow-up of zero writes. Keep ordinary and strict failure-intent tests passing.
- [ ] Clarify `docs/STATE` and `docs/API`: stale exact-lease HTTP 400 is not success; first broker-accepted settlement is authoritative; original 14-day intent retention applies.
- [ ] Update CHANGELOG under the existing 1.27.6 batch and preserve package version 1.27.6.
- [ ] Do not touch gateway, paid-route policy, native fork, devbox, or other protected repos.

### Step 5: Focused and full verification

Before verification, the implementer must complete the additional verified release blockers in the spec's matching addendum. The prior workflow was interrupted and its existing deep worker reported incomplete, uncommitted work; continue that work rather than replacing or reverting it.

- [ ] Add RED/GREEN coverage for cached `plan-lapsed` expiry extension without a new usage snapshot, then correct `applyCheckResult` mutation accounting, persistence intent, and transition-only notification behavior in `bin/opencode-broker`. Prove restart between old/new expiries remains blocked when usage fetching is unavailable.
- [ ] Add RED/GREEN coverage for 3001 hung raw-deletion events, then enforce the 16-underlying-operation cap per ModelRouter instance. Permits survive hook timeout and map trimming and release only on actual SDK settlement. Prove recovery of one permit, no late-404 cleanup, and retention of private routing. Keep existing coalescing/deadline/retry tests green.
- [ ] Verify the offline HUD L1-to-observed-L2 regression preserves both immutable records and the user's model. Correct the ordinary/strict fsync comment. Only `tests/plan-usage-queue.test.mjs` and `tests/provider-check.test.mjs` are additionally allowed if needed; the spec addendum gives the precise semantics.

- [ ] Run the focused command and capture its actual output:

```bash
node --experimental-test-module-mocks --test --test-concurrency=4 \
  tests/routing.test.mjs tests/router-core.test.mjs tests/router.test.mjs \
  tests/failover.test.mjs tests/provider-outage-recovery.test.mjs \
  tests/read-only-persistence.test.mjs tests/broker-state-durability.test.mjs \
  hud/tests/hud.test.mjs tests/pending-forget-ownership.test.mjs
```

- [ ] Run the full suite using `bg_run`, writing to the external log path only if it does not already exist; otherwise choose a new timestamp-suffixed filename and preserve every prior log. Use `tee` with explicit `PIPESTATUS[0]`; never treat a successful `tee` as proof the test command passed.

```bash
set -o pipefail
timeout 600s node --experimental-test-module-mocks --test --test-concurrency=4 \
  tests/*.test.mjs gateway/tests/*.test.mjs hud/tests/*.test.mjs \
  2>&1 | tee /home/dev/projects/audit/verification-logs/immutable-pending-ownership-full.log
test_exit=${PIPESTATUS[0]}
printf '\nFULL_TEST_EXIT=%s\n' "$test_exit"
exit "$test_exit"
```

- [ ] Confirm the full test process exits normally with code 0 and actually runs more than 2800 tests, with zero failures, cancellations, and skips. Zero tests is a verification failure even if Node exits 0. Inspect the complete log, ensure test-owned processes are gone, and remove test-owned temporary bases on both success and failure. Keep the root-owned peer link intact. Diagnose any in-scope pre-existing failure; never bypass a missing authority gate.

### Step 6: Review, stage exact paths, and commit the authorized release batch

- [ ] Inspect complete `git --no-pager diff`, status, and recent log in the candidate workdir. Check all twelve intended pre-existing candidate changes plus authorized new files; exclude anything outside the authorized batch.
- [ ] Stage only individually named intended paths (never `git add .`), including the allowed `lib/router-core.js`, `lib/routing.js`, new store, focused queue tests/fixture, `docs/API.md`, this plan/spec, `docs/STATE.md`, and 1.27.6 changelog updates.
- [ ] Recheck staged diff and compare the intended tracked/untracked file-content fingerprint with the green full-suite tree. Reuse that evidence only if the tree is unchanged; rerun the full suite if implementation or tests changed. Commit one versioned 1.27.6 release batch; subsequent independent-review corrections may use additional commits without another version bump. Never amend, push, or deploy from the workflow.
- [ ] Report the commit and verification evidence to the parent; do not perform root-owned final integration.
