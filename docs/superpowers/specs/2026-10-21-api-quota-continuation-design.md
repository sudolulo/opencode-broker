# Subscription-quota API continuation with protected manual reserves

Date: 2026-10-21
Status: User-authorized architecture; implementation and financial activation are separate gates.

## Intent and selected approach

Holden wants running sessions to continue doing their existing work after subscription quota is exhausted. Subscription and ordinary routing remain first. A native Anthropic API allocation provides up to $150 of normal automatic continuation and protects $50 for explicitly selected manual one-shot uses. During the final 48 hours before the actual allocation expiry, unused and uncommitted protected funds may also pay for genuine continuation requests. No process starts work, fabricates prompts, or sends inference merely because credits are expiring.

The user selected ONE shared durable ledger with protected allocations, not two wallets with transfers. The combined accounted exposure must never exceed the explicitly verified funded allocation or the configured $200 ceiling. A provider-side $200 limit is user-confirmed; it is not evidence of $200 remaining funds. Actual available allocation, exact expiry, exclusive use, and billing bindings remain activation prerequisites. Screenshots are not required; operator confirmation in text is acceptable and must be identified as such.

The deployed 1.26.0 manual-only gate does not implement this extension. This specification supersedes neither its financial safety requirements nor historical documentation.

## Scope and non-goals

- Extend static paid-target registration with a separately configured, quota-only continuation permission; do not put paid targets into ordinary tiers, fallback lists, discovery, outage reserves, health probes, burn watchers, or trials.
- Preserve explicitly selected manual paid profiles and normal subscription routing when the extension is absent.
- Use existing request-driven session recovery for the same task. A recovery prompt continuing an interrupted task is not permission to invent new work.
- Do not infer subscription exhaustion from generic 429, timeout, network errors, 401, missing credentials, billing-only credit errors, fast-mode credit refusal, or lapsed subscription.
- Do not automatically fund, top up, reset, roll over, transfer between wallets, inspect a live wallet, change billing settings, or install credentials.
- Do not weaken the closed request/pricing/receipt contract or remove unsupported history blocks to force a handoff. Unsupported requests fail closed before paid egress.
- Do not migrate, overwrite, repair, or delete an existing ledger implicitly. Do not alter the unrelated preexisting source commit.

## Runtime components and responsibility

1. Broker configuration names approved source subscription providers, eligible normal profiles, and exact static API continuation targets. Static identities remain quarantined from normal discovery/routing. The broker is the authority for route purpose.
2. Broker session state retains exact bound quota evidence from a real prior subscription lease, and mints a continuation grant only for an eligible durable session while the corresponding source quota block is current. A request's purpose, header, or caller-supplied failure class is not sufficient authority.
3. The existing plugin obtains the next lease during request-driven recovery. It does not schedule credit spending at the unlock boundary. Manual Model, private/offline profiles, gateway-generated per-request one-shot IDs, probes, and idle sessions cannot acquire automatic continuation authority.
4. The gateway obtains paid identity and purpose only from the broker's lease/verification response. It binds that authority to the final native request and passes the immutable admission context into the spend gate.
5. The shared ledger atomically checks global and allocation availability and persists the full worst-case reservation, purpose, draw provenance, and authorization identity before dispatch. Validated settlement retains or refunds the same provenance.
6. Offline CLI status reports the allocation split and unlock timing. Funding remains a separate explicitly verified operator action.

## Policy and funding contract

The new optional spend-policy field is `allocations`, with exact keys `continuationUSD`, `manualReserveUSD`, and `releaseWindowHours`. An example deployment policy uses:

```json
{
  "ceilingUSD": "200",
  "allocations": {
    "continuationUSD": "150",
    "manualReserveUSD": "50",
    "releaseWindowHours": 48
  }
}
```

This fragment augments, rather than replaces, existing required policy identity, credential fingerprint, native origin, approved models/rates, validity, and ledger path. Budget values are deployment data, not hardcoded product configuration. Normalize money to exact BigInt nanoUSD. Reject unknown allocation keys, nonpositive reserve/continuation values, time windows that are not integer hours from 1 through 744 inclusive, overflow, and an allocation sum different from the policy ceiling. Bind every allocation setting into the policy hash. Policies without `allocations` retain their existing normalization, hash, schema, and manual-only behavior.

One immutable verified funding epoch remains authoritative. Let F be its funded amount, C the configured continuation ceiling, and R the protected manual reserve. Require R <= F <= C + R; funding below R cannot promise the selected protection and is refused. Allocate R to protected funds and F - R to normal continuation. Thus partially remaining credits below $200 reduce normal capacity rather than silently reduce the promised $50 reserve. Never infer F from the provider spending limit. Existing expiry <= policy validity and binding/exclusive-allocation checks remain mandatory.

Before explicit funding, both allocations have zero funded and available amounts. Configured reserve protection is not money. The lower bound R <= F applies only when creating a funded epoch, not to an initialized zero-balance wallet.

The actual funding epoch expiry E, not calendar month-end or organization spend-limit reset, defines U = E - releaseWindowHours * 3600000. Unlock applies at now >= U and now < E. There is no timer or database transfer at U: eligibility is evaluated atomically when an actual request reserves funds. There is no automatic new funding epoch at E.

## Allocation accounting

Maintain the global conservation invariant `available + held + spent = funded` and exact per-allocation conservation against the immutable funded split. Amounts never pass through JavaScript Number.

Each attempt persists its purpose (`manual` or `continuation`) and the exact normal/protected portions of its original reservation; the portions sum to the reservation. Persist the corresponding trusted authorization identity. A held or uncertain reservation consumes its full original portions. A settled attempt consumes its retained portions. Full historical validation recomputes both the global and allocation sums from attempts before and after mutations.

Admission rules:

- Explicit manual requests draw only from the protected allocation, before and after U.
- Continuation requests before U draw only from normal availability.
- Continuation requests at or after U draw from normal availability first, then from the currently available protected remainder.
- No request can use settled or held protected amounts, exceed its permitted available allocations, or exceed global availability.
- Never split one provider request into extra paid calls to fit a bucket; either reserve its complete worst-case cost atomically or refuse.

Default reserve-and-burn remains unchanged: a complete receipt settles the whole reservation unless the existing explicitly confirmed reconciliation contract permits refunds. For an eligible refund, retain normal provenance first and protected provenance second; refund the reverse of the original normal-first draw. A manual attempt remains protected-only. Returned funds go to their original allocation, not a new funding epoch. Subsequent eligibility is evaluated at the current request time.

Examples with a fully verified $200 epoch:

- Before U, $150 normal exposure leaves no more continuation room even if the $50 reserve is untouched.
- If manual attempts have consumed or held $20, at U no more than the remaining $30 protected funds can become available to continuation.
- If all $50 are held, uncertain, or settled, U releases none of them.
- Concurrent manual and continuation requests in the unlock window race through one atomic transaction; they cannot both spend the same remaining cent.

## Broker authority and subscription-first routing

Automatic continuation requires a previously leased, durable session and broker-validated evidence tied to its exact source subscription lease/provider. Only configured, trusted subscription identities are eligible sources. Broad existing routing class `quota` alone is insufficient; the narrower continuation policy must distinguish subscription usage exhaustion from billing, lapse, fast-mode credits, auth, burst limits, and generic failures.

Ordinary eligible routes retain priority, including an existing eligible local route. Paid continuation is a separate final admission path when ordinary routing cannot supply an eligible route and the bound subscription-quota evidence is still current. Ordinary local/private/manual exclusions must not be weakened. A source quota recovery, expired/replaced evidence, policy change, explicit session end/forget, or incompatible profile must prevent a new continuation grant. Ordinary per-request lease settlement is not by itself session termination: it must not erase the bound historical source-quota evidence needed by a later request in the same running task. Newly issued grants always require current source-quota state. Quota failure on a paid target never creates source-subscription evidence or an endless paid fallback ladder.

The broker-derived paid authorization identifies purpose, session, lease, static target, grant lifetime, and (for continuation) the source quota identity. It is preserved through lease responses, `/lease/verify`, and allowed gateway retry/handoff paths. The gateway never accepts authority supplied in client body/header metadata. Missing, malformed, inconsistent, or expired authority fails closed for allocation-enabled policies, including a new gateway talking to an old broker that cannot attest purpose. Authenticated local same-user/operator processes remain an explicit trust boundary; this is not a cryptographic claim against a malicious operator with direct IPC or credential access.

Every retry is separately authorized as needed and reserves a fresh full worst-case attempt. An allowed retry cannot silently change manual/continuation purpose. Each paid dispatch remains native Anthropic and must satisfy existing URL, credential, exact model, body, headers, and rate checks. Existing unsupported controls/history are not translated or silently stripped.

## Expiry, queueing, failure, and settlement

- Preserve the whole-connection per-ledger FIFO and SQLite cross-process `BEGIN IMMEDIATE` exclusion; unrelated ledgers remain independent.
- Preserve WAL, FULL sync, private owned paths/sidecars, strict exact schema/index checks, quick_check, integrity_check, full row/receipt validation, and parameterized integer SQL.
- Reserve before the sole upstream fetch, and return an immutable dispatch deadline bounded by policy expiry, epoch expiry, and continuation authority validity.
- Recheck the actual clock after asynchronous admission and immediately before the sole fetch, with no await between successful final check and dispatch. An invalid/expired grant or epoch produces no paid egress. Its already committed hold remains conservatively uncertain; expiry is not refund evidence.
- Crashes, disconnects, cancellation, malformed receipts, unknown billing semantics, conflicts, and bounds violations retain the existing uncertain/freeze behavior. No automatic recovery of held funds occurs at U or E.
- A historic valid receipt can settle its own hold after expiry without authorizing new requests. Preserve idempotence and default burn; never count observed usage as available funds by itself.
- Preserve terminal financial 402 with no-retry/native error envelope before headers and owned stream error after headers; do not turn financial refusal into a paid retry storm.
- Clock correctness, verified rates/token bounds, exclusive allocation, one authoritative unrolledback ledger, and durable storage remain explicit assumptions. No unconditional provider-invoice or zero-overshoot guarantee is claimed.

## Schema and compatibility

Allocation-enabled policies use exact schema version 2 containing allocation and authorization provenance. Existing schema1 files remain supported only with their original unpartitioned policies; no existing schema1 file is silently upgraded or reinterpreted as split funds. A split policy requires an explicitly initialized fresh ledger path. Old binaries must fail closed on the new schema. Unknown objects, versions, columns, purpose values, inconsistent provenance, or mutated policy bindings fail closed. Initialization never funds a wallet. Existing ledger/receipt APIs retain their legacy behavior when `allocations` is absent.

Status must expose global accounting, each allocation's funded/available/held/spent amounts, actual epoch expiry, computed unlock instant, and whether continuation may use the available protected remainder. Status does not treat unlock as new funds, count held money as unused, or advertise an invented actual provider balance. Operator logs contain no API keys, request contents, or credentials.

## Verification requirements

Use the project's Node test runner and fresh owned private fixtures only. Production logic is test-first, with meaningful RED then GREEN evidence. Do not touch the two previously prohibited temporary wallet/profile fixtures.

Required coverage:

1. Policy exactness, allocation hash changes, sum/overflow/type errors, and byte-compatible legacy normalization.
2. Zero funding, explicit one-time partial/full funding, preservation of R, refusal below R/above ceiling, and no reset/top-up.
3. Manual/normal isolation before U; U - 1 ms, exactly U, E - 1 ms, and exactly E; epoch expiry differing from calendar month and policy validity.
4. Normal-first mixed reservations; protected manual use before/after U; held/uncertain/settled protected funds excluded from release.
5. Concurrent final-dollar/final-cent manual/continuation reservations in one process and separate processes, asserting exact winner counts and conservation.
6. Crashes/uncertain holds, default burn, permitted receipt refunds to original provenance, duplicate/conflicting/bounds receipts, and corruption of allocation/auth rows.
7. Exact prior subscription lease and current quota evidence; ordinary routing priority; no automatic paid route for generic rate/network/auth/lapse/billing/fast-credit, wrong source, stale/replayed grant, new one-shot, idle/probe, private/offline/Manual Model, or caller-supplied purpose.
8. Broker/gateway version skew; lease verification and retry/handoff preserve purpose; strict final native binding and complete reserve before fetch.
9. Queue crossing expiry or authority deadline produces zero egress and full conservative hold; historical settlement remains possible.
10. Existing plugin request-driven quota continuation works against a real broker/gateway fixture without scheduled budget-burning work. Unsupported request/history still fails closed before paid egress.
11. Legacy disabled-path tests, existing manual gate tests, full repository suite, release metadata/package validation, and isolated nonbillable startup/catalog smoke.

## Release and activation

Release in one reviewed batch after fresh full-suite verification, preserving all preexisting user work and historical evidence. Confirm clean source and the actual canonical remote. Deploy a committed candidate through the existing isolated-smoke/detached-worktree mechanism, not mutable source. Restart broker before gateway, verify their actual process paths/version/catalog, and preserve rollback. Do not publish packages, make inference calls, or change credentials as a smoke test.

Shipping this software does not activate or fund paid routing. Real activation separately requires exact exclusive available credit amount, actual expiry, source/paid target identities, supported model/rate/input bounds, receipt policy, and credential binding. No financial prerequisite is filled in by inference from a $200 provider limit. The final report must distinguish implemented/tested/released behavior from actual funded operation.
