# Manual API reserve

`manualApiTargets` is an operator-only allowlist for a static cloud target and its
dedicated named broker profile. It is not subscription routing: automatic routing,
discovery, tiers, fallbacks, outage handling, trials, and profile fallbacks cannot
select a registered reserve target.

One dedicated provider may register multiple static models, but every static target
for that provider must be registered. Each registered target is admitted only by its
exact target ID, provider ID, model ID, cloud kind, and named profile. Malformed
`manualApiTargets` input, including `null`, fails startup closed.

The broker stores policy only. The gateway owns the provider `keyFile` and credential
bytes; manual admission does not read OpenCode authentication files. A dedicated
API-only profile may route without an unrelated `auth.json`, while ordinary cloud
profiles retain their normal authentication checks.

## Budget layers

`manualApiTargets` controls routing admission only and does not itself enforce a dollar
cap. Broker request/token budgets continue to apply. The separate
[spending gate](SPEND-BUDGET.md) authorizes guarded paid dispatch against a dollar
ceiling only after the operator configures verified identity bindings and explicitly
records a verified exclusive allocation. Initialization supplies zero funds; guarded
requests fail closed without a valid funded ledger. Installing this feature does not configure
credentials, register or enable a paid route, or fund a ledger; those require explicit operator
configuration and verified billing prerequisites.

## Manual spend grants and API continuation

A registered target can also serve [subscription-quota API continuation](API-CONTINUATION.md).
That feature changes manual targets in three ways:

- **A pin turns on manual grants.** When `apiContinuation.spendPolicyHashes` names a registered
  target with its 64-hex financial pin (the gateway spend policy's `policyHash`), every explicit
  lease through that target's named profile carries a broker-minted manual `spendGrant`, even with
  `apiContinuation.enabled: false`. The grant lasts at most `apiContinuation.grantTTLms` (300 s or
  less), so a long turn re-leases and its lease ID rotates. A grant-bearing lease verifies only
  with its exact lease ID. A target without a pin keeps the legacy behavior exactly (no grant,
  `billingClass: "manual-api"`). See [API.md](API.md#paid-lease-attestation).
- **An invalid `apiContinuation` block fails every manual target closed.** While a present block
  does not normalize, every `manualApiTargets` entry is unleasable, unverifiable, absent from
  `/preview` and grantless, `/lease` answers `api-continuation-config-invalid`, and `/status`
  reports `apiContinuationConfigError: true`. Fix the block and restart the broker. An absent block
  changes nothing.
- **Split allocations.** Under a spend policy with `allocations`, a manual grant draws only from the
  protected manual reserve and continuation draws from its own allocation (and, in the final
  release window, the reserve's available remainder). The gateway's split-policy refusals
  `invalid_authorization` and `allocation_exhausted` reach the client as themselves in the
  terminal 402 envelope. See [SPEND-BUDGET.md](SPEND-BUDGET.md#split-allocations-schema-2).

Registration itself is unchanged: `manualApiTargets` keeps its format and quarantine rules, and an
API continuation target must be a registered manual target. `apiContinuation.targets` and
`spendPolicyHashes` may name only registered manual targets, and `sourceProviders` may not name a
registered paid provider. A pinned target whose lease carries no grant no longer verifies.
