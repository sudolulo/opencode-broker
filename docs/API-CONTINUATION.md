# Subscription-quota API continuation

> **Disabled by default; installing it activates and funds nothing.** With no `apiContinuation`
> block (or `enabled: false`) the broker never routes a session to a paid target automatically.
> Real operation additionally needs a registered manual API target, a funded split spending ledger
> ([SPEND-BUDGET.md](SPEND-BUDGET.md)) and a financial pin copied by the operator. Never enable it
> without a funded, bounded spend policy whose allocation, expiry and exclusivity the operator has
> verified.

## What it is

When a running session's subscription provider answers with a typed subscription-quota 429 and
no ordinary route can serve the session's next lease, the broker may lease a **registered manual
API target** for that session instead, carrying a short-lived, broker-minted **spend grant**. The
gateway admits the paid request only with that grant, against a split spending ledger that keeps a
protected manual reserve apart from continuation funds.

It continues work a session is already doing. Nothing schedules, invents or resends work: a paid
lease is only ever handed out in answer to a real `/lease` from a session that was already working
on a subscription target. Subscription and ordinary routing always come first; the paid target is
chosen only in the broker's final refusal branch.

Moving parts:

| Component | Role |
|---|---|
| `lib/api-continuation.js` | Pure policy normalization, quota-evidence parsing, record validation, currency checks and grant minting |
| `bin/opencode-broker` | Source snapshots on new leases, `POST /quota-evidence`, proof recording in `/failure`, the late paid branch in `acquire`, lease attestation for `/lease` and `/lease/verify`, `/status` redaction |
| `gateway/lib/gateway.js` | Extracts typed quota evidence from bound 429s, binds the broker grant to the held lease, refuses near-expiry grants, passes the grant into the ledger |
| `gateway/lib/spend-budget.js` | Schema-2 ledger with continuation and protected manual allocations |
| `plugin/router.js` | Binds session/lease headers for the exact paid route, warns and writes a fallback marker |

## Preconditions for a paid continuation lease

Every condition below must hold at the moment of the `/lease`. Anything else leaves the original
refusal standing.

### 1. Captured source-quota proof

1. **Source snapshot.** When `apiContinuation.enabled` is true, a **new** lease on an eligible
   source target carries a private `apiContinuationSource` snapshot. Eligible means: the session ID
   is a durable OpenCode ID (`ses_` followed by 1-124 letters/digits), profile `auto`, a configured
   generation tier (not `classifier` or `embedding`), not a one-shot, not an embeddings call; the
   target is a cloud target discovered with `source: "subscription-oauth"` whose provider is in
   `sourceProviders`, is `connected` with `authType: "oauth"` in the published inventory, is
   `oauth` in the live `auth.json`, and is not a registered paid provider; the live `auth.json`
   revision equals the inventory's `authRevision`; and the source provider's own `auth.json` entry
   is readable. Held leases issued before enabling are never retrofitted.
2. **Typed 429 observed by the gateway.** On a session-bound request (the plugin's
   `x-opencode-session-id` / `x-opencode-lease-id`), a non-2xx upstream answer is parsed by
   `extractSubscriptionQuota`. Only HTTP 429 with one of two typed signals is positive:
   - **Anthropic unified:** `anthropic-ratelimit-unified-status: rejected`,
     `anthropic-ratelimit-unified-representative-claim` exactly `five_hour` or `seven_day`, and
     `anthropic-ratelimit-unified-reset` as whole epoch seconds. `error.type` must be absent, null
     or `rate_limit_error`; `error.code` absent or null; no `x-codex-*` header and no
     `resets_at`/`resets_in_seconds` body field. Model-scoped claims (`seven_day_opus`,
     `seven_day_sonnet`, anything else) are never positive.
   - **OpenAI usage limit:** `error.type` or `error.code` is `usage_limit_reached` (whichever is
     present must say exactly that), with `resets_at` (epoch seconds) and/or `resets_in_seconds`.
     When both are present they must agree within 5 s and the earlier one is used. No
     `anthropic-ratelimit-unified-*` header may be present, and
     `x-codex-rate-limit-reached-type`, when present, must be exactly `rate_limit_reached`.

   Refused in every case: a body over 16,384 characters or not a JSON object; contradiction wording
   (billing, credit, balance, payment, insufficient, fast mode, extra usage, overage, lapse, expired,
   cancel, renew, auth, unauthorized, per-minute, RPM/TPM, burst) in `error.message`, `error.param`
   or `error.plan_type`; a reset that is not in the future or lies beyond its window's horizon
   (5 h for `five_hour`, 7 days for `seven_day`, 31 days for `usage_limit`). A bare `Retry-After`
   or generic quota wording is never evidence.
3. **Observation stored.** The gateway sends `POST /quota-evidence` (see [API.md](API.md)). The
   broker stores a broker-timestamped `quotaObservation` on the exact current source lease. It
   settles nothing and creates no circuit. Two different observations for one lease erase it and
   leave a conflict tombstone.
4. **Exact `/failure` consumes it.** The plugin's own `/failure` for that exact current lease (its
   nonempty `leaseID` must equal the live lease's) consumes the observation, whatever kind the
   failure turns out to be. A proof record is written only when the failure classifies as a
   provider-wide `quota` failure that is not a lapsed plan, the snapshot is still current, the
   failure text is not contradicted (no contradiction wording; any `HTTP nnn` in it must be 429;
   the status must be absent, 429, or the gateway's 502 wrapping `upstream <id> HTTP 429`), and
   any explicit reset in the failure equals the observed one. When the failure carries no reset,
   the observed reset becomes the quota circuit's `until` (with `resetKnown: true`). The record is
   persisted in `state.apiContinuations[sessionID]` only if it re-proves as current authority
   immediately after the circuit write.

### 2. Current record

At lease time the session's record must still be current (`continuationAuthorityCurrent`): same
routing `policyRevision`; same source target, provider and model; the source provider's own
`auth.json` entry revision unchanged and present; live whole-file auth revision equal to the
published inventory's; and the source provider's circuit is a `quota` circuit with no `reason`,
`resetKnown: true`, `until` at or after the record's `circuitUntilMs`, `updatedAt` at or after the
record's, and the record's end still in the future.

### 3. Request gates (`lateContinuationRequestEligible`)

- The ordinary refusal code is `usage-limit` or `no-eligible-target`. `target-preparing`,
  `target-busy`, `no-resolvable-target`, `no-eligible-local-target` and
  `api-continuation-config-invalid` are never overridden.
- Policy enabled; not a model-probe assignment; not `localOnly`; not embeddings.
- Durable `ses_` session, profile `auto`, not `oneShot`; the tier is configured and is a generation
  tier.
- No staged model-policy candidate (`policyTargetID`) and no blocked generation in the lane.
- If the lane includes a local target, its residency probe must have answered. A probe that failed
  or timed out (unknown residency) blocks; a probe that answered "nothing resident" does not.

### 4. Ordinary routes exhausted (the projection)

The broker re-runs ordinary selection twice, purely (no clock, circuit, cursor, prepare or probe
changes): once with the current slot counts and once with every slot free, both with every delayed
profile rung opened (`waitedMs` at its maximum). If either projection finds a target, no paid lease
is issued. The projection is relaxed toward ordinary routing, never toward paid:

- **Only usage-stop circuits block** in it: kinds `quota` and `plan-window`
  (`USAGE_STOP_CIRCUIT_KINDS`, kept in step with `lib/usage-limit.js`). Auth, rate, overload,
  connect and every other circuit are treated as open.
- **Provider health is ignored** (quarantine does not count as exhaustion).
- **Caller `excludeTargetIDs` and policy avoids are ignored** (a route the caller fenced off is not
  exhaustion). They still bind the paid target itself.
- Admission narrowing (`providers`, `resolvableModels`, `localOnly`) and context fit still apply.

### 5. An eligible paid target (`lateContinuationTarget`)

Candidates are the policy's `targets`, in sorted target-ID order; the first that passes wins:
listed for this tier; pinned in `spendPolicyHashes`; exactly its static manual registration
(provider, model, cloud, no `source`); not an embedding target; its provider is not a source
provider; not excluded by the request or a policy avoid; inside the `providers` allowlist and
`resolvableModels`; not an outage-policy reserve or outside outage automatic scope; no staged or
active model-policy role and not probation-only; no open target or provider circuit; context fits;
**not at capacity** (a full paid target is skipped, not waited for); provider health eligible.

### 6. The grant mints

`mintSpendGrant` (purpose `continuation`) must succeed: the record normalizes, the target and tier
are in the enabled policy, the TTL is within `grantTTLms`. The grant expires at
`min(now + grantTTLms, record.circuitUntilMs)`. If minting fails the original refusal stands.

### What the paid lease looks like

- Decision `policy: "api-continuation"`, reasons `api-continuation-after-<code>` and the original
  refusal reason.
- The assignment is marked `fallback: true` (never a normal pin) and `grantLease: true`.
- The `/lease` reply's `target` carries `requiresSpendBudget: true`,
  `billingClass: "api-continuation"` and the `spendGrant`.
- A held continuation lease is **never reused**: every later `/lease` reruns ordinary selection, so
  a reopened ordinary route always wins, and a new grant is minted only after exhaustion is
  re-proven.
- A paid target's own 429 never creates source evidence: paid targets are not source-eligible.

## Configuration

`apiContinuation` is a top-level broker config block with exactly these keys:

| Key | Type | Rule |
|---|---|---|
| `enabled` | boolean | Default `false`. Only `true` permits automatic continuation. |
| `sourceProviders` | array of provider IDs | At most 32, no duplicates, none a registered paid provider. Must be nonempty when enabled. Independent of `trustedSubscriptionProviders`. |
| `targets` | object: manual target ID to tier array | Each key must be a `manualApiTargets` target; each tier array nonempty, no duplicates, generation tiers only. |
| `spendPolicyHashes` | object: manual target ID to 64 lowercase hex | The financial pin per paid target. Each key must be a `manualApiTargets` target. When enabled, every `targets` key must be pinned. |
| `grantTTLms` | integer | 1 to 300000; default 300000. Bounds manual and continuation grants alike. |

The normalized block gets a routing `revision` (SHA-256 over every key, including each target's
and pin's static provider/model identity). Changing anything in the block changes the revision,
which permanently invalidates every stored continuation record.

**An invalid block fails closed for all manual API targets.** A block that is present but does not
normalize is published on `CONFIG_ERROR`, logged once at startup naming the registered target IDs,
and while it stands every target in `manualApiTargets` is unleasable, unverifiable and grantless
(`api-continuation-config-invalid`). `/status` shows `apiContinuationConfigError: true`. Ordinary
routing is unaffected. An absent block keeps the legacy manual behavior exactly.

### Disabled example

The target ID below must exist in `manualApiTargets`, and its tiers must be generation tiers of
your config. This example leaves everything off:

```json
{
  "apiContinuation": {
    "enabled": false,
    "sourceProviders": ["anthropic", "openai"],
    "targets": { "manual-anthropic-api": ["build", "smart"] },
    "spendPolicyHashes": {},
    "grantTTLms": 300000
  }
}
```

Do not put a placeholder string in `spendPolicyHashes`: anything other than 64 lowercase hex makes
the block invalid, which fails every manual target closed. Note also that a pin takes effect even
with `enabled: false` (see Manual grants below).

### Obtaining the financial pin

The pin is the gateway spend policy's `policyHash`. The broker never computes it and never reads
credentials or rates; the operator copies it. For a split policy the hash binds the registered
paid identity, so the spend-budget CLI requires (and only for split policies accepts) that
identity. These are examples for an authorized operator, not commands an agent runs:

```sh
node gateway/bin/opencode-broker-spend-budget status --policy /absolute/path/policy.json \
  --target-id <manualApiTargets target ID> --model-id <that target's model ID>
```

`init` and `status` print JSON including `policyHash` and, for schema-2 ledgers,
`registeredIdentity`. Compare `registeredIdentity` with the broker's `manualApiTargets`
registration before funding: the gateway recomputes the hash with the broker-selected target ID,
the gateway provider ID and the leased model ID, and any mismatch refuses every request
(`binding_mismatch`). A wrong or stale pin makes paid routing unavailable; it never bypasses
funding. The provider ID comes from the policy's `binding.providerID`.

## Manual grants

A registered manual target with a pin in `spendPolicyHashes` gets a **manual** spend grant on
every explicit lease through its named manual profile, whether or not continuation is enabled. The
grant is minted only from the actual manual admission (never from caller fields) and lasts at most
`grantTTLms`. A manual target with no pin keeps the legacy unpartitioned behavior (no grant,
`billingClass: "manual-api"`). A pinned manual target leased without a grant (for example, minted
before the pin existed) no longer attests and fails verification. A held manual lease is reused
only while its grant, pin, TTL and admission are still current.

## Gateway admission and ledger allocations

The gateway takes paid identity only from the broker's `/lease` or `/lease/verify` target
(`requiresSpendBudget`, `billingClass`, `spendGrant`); client headers and bodies never supply it.

1. `billingClass` must be `manual-api` or `api-continuation` with `requiresSpendBudget: true`, else
   `invalid_policy`; a declared paid lease on a provider without `spendBudget` is `missing_policy`.
2. `api-continuation` requires a split (`allocations`) policy (`invalid_policy` otherwise) and a
   grant (`binding_mismatch` otherwise).
3. The grant must bind the held lease's exact session, lease, target, provider and model, carry the
   purpose matching its class, and name `policyRevision` equal to the gateway policy's `policyHash`
   (`binding_mismatch`); an expired grant is `expired`.
4. Split policies also require the request's model to be the registered model and the target to be
   the registered target (`invalid_authorization`).
5. A grant with less than 2 s left (`SPEND_GRANT_MIN_REMAINING_MS`) is refused `expired` before
   reserving, so no hold is stranded.
6. The reservation draws the full worst-case cost atomically; the dispatch deadline is the earliest
   of policy validity, funding-epoch expiry and grant expiry.

On the session-bound path a grant-bearing lease is never served by the same-model lease-ID rotation
fallback: the request must name that exact lease, or it gets the routing refusal
`400 ... session holds no live lease`, before any reservation.

### Allocation contract (from the design spec)

The selected deployment shape is a $200 ceiling split into $150 continuation and $50 protected
manual reserve with a 48-hour release window:

```json
{ "ceilingUSD": "200", "allocations": { "continuationUSD": "150", "manualReserveUSD": "50", "releaseWindowHours": 48 } }
```

- Funding F must satisfy reserve <= F <= ceiling. The reserve is funded first and in full:
  F = 200 gives 150/50, F = 180 gives 130/50, F < 50 is refused.
- Manual requests draw only from the protected reserve, at any time.
- Continuation draws only from the continuation allocation until the unlock instant
  U = epoch expiry - `releaseWindowHours`. From U until expiry it draws continuation first, then the
  protected reserve's **available** remainder. Held, uncertain and settled reserve money is never
  released.
- Before U, $150 of continuation exposure leaves no continuation room even with the reserve
  untouched. If manual use has consumed or holds $20, at most $30 can become available to
  continuation at U.
- Concurrent requests race through one ledger transaction; they cannot both spend the same cent.
- Refusal for lack of eligible funds is `allocation_exhausted`.

Details, schema 2 and status fields: [SPEND-BUDGET.md](SPEND-BUDGET.md).

## Refusal codes

| Where | Code | Meaning |
|---|---|---|
| Broker `/lease` | `api-continuation-config-invalid` | The lane names a manual target that an invalid `apiContinuation` block fails closed. Terminal until the config is fixed and the broker restarted. |
| Broker `/lease` | (no code) `lease authority could not be attested` | A just-granted paid lease could not attest itself; it was deleted. |
| Broker `/quota-evidence` | `invalid-quota-evidence`, `invalid-subscription-quota` (400); `unknown-or-stale-lease`, `not-a-continuation-source`, `quota-evidence-conflict` (409) | See [API.md](API.md). |
| Gateway (HTTP 402, `x-should-retry: false`) | `invalid_policy`, `missing_policy`, `binding_mismatch`, `expired`, `invalid_authorization`, `allocation_exhausted`, `unsupported_request`, plus the existing ledger codes | Terminal financial refusals; the code is passed through as itself. |
| Plugin `chat.headers` | `paid route attestation is malformed or unbound; resend the prompt` | The route claims to be paid but its grant does not bind this session, lease, target and model. Thrown before the SDK sends anything. |

## The plugin warning

When `/lease` returns `decision.policy: "api-continuation"` the router logs a `warn`:
`<profile>/<tier> PAID API CONTINUATION: leased <target> (<provider>/<model>) -- this turn runs on
paid API continuation, billed per token, because no subscription <tier> target was eligible
(<reasons>)`. It writes a fallback marker with `policy: "api-continuation"` (the HUD badge reads
`FALLBACK:<targetID>`), and for a root session starts the same restore-home watch as a strict
fallback. For a paid route, `chat.headers` sends `x-opencode-session-id`, `x-opencode-lease-id`
and `x-opencode-session-kind` only on calls to that route's exact provider and model; small-model
and unrelated-provider calls send nothing. No grant, purpose or billing header is ever sent.

## Known limits

- **The source provider's own token refresh revokes its records.** Records are fenced to a
  SHA-256 of that provider's `auth.json` entry, and there is no stable account ID to fence to
  instead. An OAuth refresh rewrites the entry, so the record becomes permanently invalid and is
  pruned; a new quota hit must be observed again.
- **An unrelated provider's token refresh briefly breaks held paid leases.** It changes the
  whole-file auth revision, so until the inventory republishes against it, continuation records
  are not current: `/lease/verify` answers `held: false` and the gateway returns its no-live-lease
  400. The plugin's relocate path re-leases once. The record itself is kept.
- **Grants last at most `grantTTLms` (300 s or less).** A long turn outlives its grant; verification
  then fails, the turn relocates and re-leases, and the session's paid lease ID rotates. This
  applies to manual grants too.
- **A capped paid target refuses rather than waits.** A paid target at capacity is skipped and the
  original `usage-limit` / `no-eligible-target` refusal stands.
- **A plan window derived from usage readings counts as a usage stop.** In the projection, a
  `plan-window` circuit on another ordinary provider counts as exhaustion even though no request
  failed there. (The source record itself still needs an exact `quota` circuit from a real
  failure; `applyPlanUsageCircuit` extends such a circuit in place instead of re-kinding it.)
- **Model-policy staged candidates block continuation.** A lane with a staged candidate or blocked
  generation cannot be proven exhausted, so it never goes paid.
- **Lease IDs are written to disk.** `usage.jsonl` records the caller-supplied `leaseID` of each
  `/usage` report, and `pending-forgets/` stores queued forget lease IDs, both inside the mode-0700
  routing directory. Only the turn-effort log and `/status` omit grant-bearing lease IDs.
- **OpenAI typed quota depends on headers surviving proxies.** `x-codex-rate-limit-reached-type` is
  the only signal separating a rolling-window `usage_limit_reached` from a credit or workspace
  outcome, and it can only refuse. A proxy that strips it can let a non-window outcome with the
  same body (and no contradiction wording) read as subscription quota.
- **Stripped Anthropic headers fail closed.** A proxy that strips the Anthropic unified headers
  only removes evidence. No continuation record can then be created from that response.
- **Uncertain holds keep the full worst-case reservation.** When a ledger hold ends uncertain (a
  non-2xx upstream reply, an abort, or a malformed usage receipt), the full worst-case reservation
  stays charged. The spend-budget CLI has no operator release path for such a hold yet.
- **A non-session-bound paid gateway request can make a second paid attempt.** On a retryable
  upstream status (408, 409, 429 or 5xx) the gateway may retry such a request, and each attempt is
  paid. Continuation traffic is always session-bound and does not retry this way.
- **An epoch shorter than the release window opens the reserve immediately.** If a funded epoch is
  shorter than `releaseWindowHours`, the final release window has already begun at funding, so
  continuation can draw the protected reserve's available remainder from the start.
- **A grant is not single-use within its TTL.** The same grant can admit more than one request
  until it expires. The ledger, not the grant, bounds total spend.
- **`/forget` does not revoke a record.** A record is pruned when its session no longer has a lease
  or assignment (assignment TTL or cap eviction) or when a permanent condition hits (source auth
  entry changed or removed, circuit cleared, re-kinded, shortened or expired, routing revision
  changed, source identity drifted). It still needs ordinary exhaustion and current authority
  before any new grant.
- **Trust boundary.** Every check is shape and context validation by local processes running as the
  same user. None of it is a cryptographic claim against a malicious operator with IPC or credential
  access.
- **Never enable without a funded, bounded spend policy.** Enabling continuation with no split
  ledger, an unfunded ledger, or a pin that does not match makes every continuation request refuse
  at the gateway; enabling it against money whose allocation, expiry and exclusivity were not
  verified is outside every guarantee here.
