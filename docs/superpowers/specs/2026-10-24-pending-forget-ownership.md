# Immutable pending-forget ownership

Date: 2026-10-24
Status: User-authorized implementation and release in one existing 1.27.6 batch.
Repo: `opencode-broker`

## Goal

Eliminate cross-process stale L1 failure/success deleting or overwriting L2 pending cleanup. A read-then-write guard is insufficient: a consumer must hold authority over exactly the immutable publication it created or atomically claimed. Preserve privacy and session binding fixes, Manual offline immediacy, exact lease authority, and 14-day retention from original intent. Add no persistent locks and no broker endpoint.

## Publication format and validation

Use the existing own-private pending directory (mode 0700) and 0600 files. A publication is an immutable, uniquely named JSON file:

```text
v1.<sha256(JSON.stringify([sessionID, leaseID]))>.<randomUUID>.json
```

Its payload is exactly the record data needed by readers:

```json
{"version":1,"sessionID":"…","leaseID":"…","completed":false,"updatedAt":0}
```

Validate `sessionID` with the existing strict validator. `leaseID` must be a nonempty string and must not be whitespace-only; preserve it byte-for-byte as an opaque ID and never trim or otherwise modify it. Derive paths only from a validated record ID, never from payload paths. Never log or expose secret values or lease IDs.

Write temp files exclusively with `wx` and mode 0600; write complete JSON, `fchmod` to 0600, close, then `linkSync(temp, final)` for atomic create-only publication. In `finally`, remove only the temporary file this call created. On publication UUID collision (`EEXIST`), retry at most three times. Never fall back to rename-overwrite. Actual filesystem failures throw with context; if linking fails, no partial JSON is visible at the final name. Do not claim fsync or power-loss durability beyond the existing contract. If fsync is used, document and test it rather than assuming it.

Code sketch for store implementation in `lib/pending-forgets.js`:
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

## Interfaces in `lib/routing.js`

Add:

```js
publishPendingForgetRecord(sessionID, {
  leaseID,
  completed = false,
  updatedAt = Date.now(),
}) // -> opaque ownership handle, or null for invalid input

listPendingForgetRecords() // -> valid records with ownership handles

removePendingForgetRecord(sessionID, handle) // -> boolean
```

The publication handle identifies exactly one record and contains `{recordID, sessionID, leaseID, completed, updatedAt}`. Listing returns valid records with handles, oldest first; for identical session and lease, `completed: true` versions sort first so the visible completion state wins. Names are never reused. Removal accepts only a matching validated handle and removes only its owned publication. Missing or invalid handles return false; there is never a session-wide unlink.

Keep exported `writePendingForgetRecord` as a boolean compatibility adapter over the publisher. It returns false for missing/empty/whitespace-only lease IDs before touching existing files. `readPendingForgetRecord(sessionID)` remains a backward-compatible read-only latest summary, explicitly not an ownership token. New consumers use publication handles or listed entries. Update every existing public-helper caller; do not silently report success for ID-only enqueue. Preserve the root API boolean compatibility while making ownership removal explicit.

## Legacy mutable record handling

For legacy `<sessionID>.json`, never read then unlink the mutable path. Claim it by exclusively creating a unique `claim.<uuid>/` directory with mode 0700, then atomically rename the legacy file to a fixed claim-record name inside that directory. Parse the moved file, not a prior read. The claim handle is opaque and contains a safely validated UUID. Recovery listing scans claim directories after crashes. Rename preserves original age.

If a legacy record has unknown or ID-only lease data, discard only the locally claimed file, emit a warning, and make no RPC. Exact-lease legacy work is processed and removed by its claim handle. If a concurrent legacy replacement occurs before claim, parse the actual moved payload. Document the limitation of old legacy writers until their panes respawn. Do not create a separate migration pipeline; listing must continue to find remaining old-producer records while old TUIs are busy.

## Retention, cleanup, and completion

TTL is exactly 14 days from the original `updatedAt`, or from legacy original mtime when older. Retry must not refresh it. Remove expired published records and claimed records only through their owned handles. Normal publication cleanup removes its temporary in `finally`; abandoned temporary files and empty claim directories may be cleaned only when bounded age is at least 14 days, ensuring they cannot represent unexpired intent. Leave fresh active files/directories untouched. Never delete unknown subtrees or paths. A retry of expired intent must not publish it as fresh.

Retry failure performs zero disk rewrite or re-enqueue. Retry success removes only the captured handles. A concurrent new publication and a `completed: true` version must survive an older success. The first broker-accepted settlement remains authoritative; do not promise retroactive promotion to completion. HTTP 400 for a stale exact lease is not automatically success: retain until original TTL. Do not loosely match errors by string.

## Consumer changes

For owning cleanup, enqueue the exact captured intent before broker RPC. Manual cleanup remains nonblocking/immediate. If queue filesystem work fails, warn and continue best-effort RPC; never throw merely because cleanup enqueue failed. Retain the published handle and remove only that handle after RPC success; leave it unchanged on failure. A callback must not publish a new record if it already owns one. If queueing failed, warn and attempt RPC best-effort, but do not claim durable cleanup. Local route/session/heartbeat fences continue to protect local state only; they do not authorize mutation of other published records.

Consumer step code sketch:
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
Define `safelyPublishExactIntent` as LOCAL integration pattern, not undefined required public API: implementation try/catch around publish, returns null on FS failure + warn. Prefer inline exact try/catch instead of undefined helper name. New list/migration FS failures must be visible warn and fail closed for cleanup, NEVER unload router plugin or break Manual/private routing; don't suppress unexpected errors. Benign `ENOENT` explicitly handled. No broad catch cleanup elsewhere.

## Tests and additional corrections

Use real child processes for process-race tests, e.g. `process.execPath --input-type=module`; set private `HOME` before imports. Read/list actual JSON records with `fs`. Do not use live auth, providers, or inference. Pin: two processes with delayed L1 failure after L2 publication preserves both; L1 success preserves L2; simultaneous publication loses neither; false success cannot erase true completion; retry failure leaves bytes and timestamp unchanged; complete JSON is atomic and modes are correct; exclusive collision preserves a foreign file; crash stages before/after link and legacy claim recover without junk; legacy ID-only makes no RPC; legacy replacement parses moved payload; repeated failure never refreshes TTL; Manual offline is immediate and model-preserving; SDK duplicate 25-to-1 and retry-after-timeout behavior is unchanged; public writer returns false for ID-only and preserves existing exact records; missing handle cannot clear another intent; mixed-invalid and path-traversal handles are rejected.

Isolate the Manual-transition test currently at `tests/router.test.mjs:1055` in a private child with `HOME` set before imports; seed a foreign pending record deliberately and assert unrelated state cannot leak. In `bin/opencode-broker`, remove redundant `sweepChanged` in `/status` and `/selection` after global pending intent, but retain the sweep call and dirty tracking. Add deterministic cached-plan lockout and expired-record fixture-count tests proving one write, not two, stable follow-up zero writes, and retain ordinary and strict failure intent tests.

Clarify `docs/STATE` and `docs/API` that stale 400 is not success and first accepted settlement is authoritative. Update CHANGELOG under the existing 1.27.6 batch; preserve package version 1.27.6. Do not change gateway, paid-route policy, native fork, or devbox.

## Additional verified release blockers, received after workflow start

These corrections belong to the same authorized release task. Parent verification found that `applyProviderCheck` replaces an existing `plan-lapsed` circuit with a later expiry but returns null when there is no semantic transition; `applyCheckResult` incorrectly treats that null as proof of no mutation.

- The implementer must distinguish actual circuit mutation from notification transitions in `bin/opencode-broker`. Capture the circuit before applying the check, structurally compare the result, and retain pending persistence intent for every actual mutation. Persist when requested. Log and notify only genuine `lapsed` or `recovered` transitions, so repeated hold extensions do not repeat alerts. Preserve the provider-check API and admission policy.
- The regression must keep the cached usage report and its `fetchedAt` unchanged, advance a private clock while that report remains fresh, and verify the extended hold is persisted. A restart just after the old expiry and before the extended expiry, with usage fetching unavailable, must retain the hold and refuse admission to that provider. A fresh fetch must not mask this test.
- The implementer must cap outstanding underlying raw-deletion SDK lookup operations at **16 per ModelRouter instance**. A permit remains held until the underlying SDK promise actually settles, not merely until its event-hook timeout expires or its bookkeeping is trimmed. Saturation must warn and fail closed immediately, retaining cached route/profile and creating no SDK call or timer. Settlement or synchronous failure releases exactly one permit. Handle late rejections without an unhandled promise rejection. Do not claim SDK cancellation or a cap on unrelated SDK calls.
- The SDK regression must issue 3001 distinct hung checks and an evicted-ID repeat without exceeding 16 underlying operations, release one operation and admit one new lookup, and prove a late 404 after timeout frees capacity without authorizing cleanup. Preserve 25-to-1 same-binding coalescing, retry after timeout when capacity exists, replacement fencing, and private-profile retention under saturation.
- The HUD regression must begin with exact pending L1, observe ordinary L2 through `/status`, then switch offline to Manual. Both exact immutable intents must remain queued, with no ID-only fallback and no model change. An existing summary record must not suppress publication of known L2.
- Correct the stale `writeState` comment: ordinary writes use atomic temp/rename without file/directory fsync; strict outage commits require file and directory fsync, warn and throw on uncertain durability, and never permit dispatch after a failed strict commit.

Additional allowed test paths, only if needed for these regressions: `tests/plan-usage-queue.test.mjs` and `tests/provider-check.test.mjs`. No additional production paths are authorized by this addendum.

## Non-goals and boundaries

No new persistent lock, endpoint, migration pipeline, broad cleanup, or durability guarantee. Do not widen scope into unrelated pre-existing work. No gateway/paid-route-policy/native-fork/devbox changes. This spec authorizes implementation and release; workflow execution must still be preceded by parent verification.
