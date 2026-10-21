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
