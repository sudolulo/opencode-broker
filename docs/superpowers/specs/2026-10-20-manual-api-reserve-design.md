# Manual API reserve admission

Date: 2026-10-20
Status: User-authorized implementation; deployment and spending activation remain separate.
Repo: `opencode-broker`

## Goal

Add first-class, operator-configured manual API admission in the broker, with gateway integration
tests. Defaults remain unchanged. This is an isolated, explicit reserve behind the gateway; it is
not a subscription, cannot masquerade as one, and never enters automatic routing.

## Verified facts and scope

- The vault entry `api key claude` exists. A workspace request successfully called `GET /v1/models`
  using workspace `wrkspc_01QQDkU45JAcPPLdaT82S5xt`; `claude-sonnet-5-5` and `claude-opus-5-5` were
  available. No secret value belongs in this document.
- Console dollar caps and account balances cannot be API-verified with this key. Do not claim fake
  dollar enforcement. Existing budgets remain requests/tokens only.
- No paid inference, service restart, deployment, version change, or host config/secret/service-unit
  edit is authorized in this phase. Deployment is separate.
- Gateway owns API credential bytes via keyFile. Manual API policy reads no credentials/auth files;
  existing subscription authRevision/authTypes behavior remains unchanged.

## Configuration and normalization

Add raw config `manualApiTargets`, an object from `targetID` to an array of named broker profiles.
Normalize it to `CONFIG.manualApiTargets`, a record from `targetID` to frozen
`{ providerID, modelID, profiles }` records. Derive entries only from existing normalized static cloud
`CONFIG.targets`. An absent or empty value normalizes to `{}`; every ordinary behavior stays unchanged
when absent.

Reject malformed fields, an unknown or non-cloud target, an empty set or set with no valid profile,
and any profile that is auto, manual, offline, or does not have that target as a primary. Reject a
registered provider shared with any non-registered static target; a registered provider also listed
in `trustedSubscriptionProviders`; and any registered target appearing in tiers, tier fallbacks,
any `profileFallbacks`, or another unauthorized profile primary. Invalid config must throw a clear
startup error, not silently drop or repair entries.

## Admission module and routing

Add pure `lib/manual-api.js` exports:

```js
normalizeManualApiTargets(raw, context)
manualApiAdmission(target, profile, policy)
```

`context` supplies normalized targets, profiles, tiers, fallbacks, profile fallbacks, offline profiles,
and `trustedSubscriptionProviders`. `manualApiAdmission` returns `true`, `false`, or `null`; `null`
means this provider is not a registered paid API provider and existing admission applies. For a
registered provider, permit only the exact registered static target identity (`id`, `providerID`,
`modelID`, cloud kind), not a discovered subscription source, and only in a registered explicit
profile. Every other case denies, including default `auto`, regardless of inventory metadata claiming
OAuth or trust. This module reads no auth files or credential bytes, depends only on passed normalized
data, and must not create a config import cycle.

`cloudTargetAdmitted(target, providers = {}, profile = 'auto')` consults manual admission first, then
preserves existing OAuth, subscription, and local behavior. Thread explicit request profile through
lease filtering, held-lease reuse, and profile-scoped selection/projection. Missing profile continues
to default-deny paid targets, notably in `model-outage-runtime`. The `requestedCloud` authRevision
path must not require unrelated OpenCode `auth.json` for a valid dedicated API-only profile; ordinary
mixed/subscription requests retain authRevision checks.

`targetIDsFor`/`chooseTarget` and `fallbackTargetGroupsFor` exclude registered paid provider targets
from auto, discovery, and fallback, even if synthetic dynamic inventory claims subscription OAuth.
Only the explicitly allowed profile's primary selection returns paid targets. There are no automatic
outage, probation, or trial routes. Switching from explicit profile to auto releases or rejects stale
paid leases. Keep provider ID distinct in budgets/control metrics; existing request/token budgets do
not become USD budgets. Status accurately exposes profile targets when profile context exists without
broadening global inventory.

## Gateway integration

Do not add an unbrokered bypass. Exercise the existing `modelProfiles` alias -> named broker profile ->
dedicated API provider (Messages enabled, `x-api-key`, existing `keyFile`) -> real model path. Use a
fake broker and fake upstream. Verify alias translation, that the key goes only to the intended
upstream, no subscription proxy path, unknown-model/default routes cannot select the paid provider,
and upstream failures do not switch a normal route into paid API. OpenCode later selects Manual Model
plus an explicit Anthropic-SDK provider alias; no current host config is edited.

## Test contract

Test pure normalization/admission, malformed and misplaced config, config-parse and routing
regressions, request-profile propagation, authRevision behavior, held-lease switching, and outage
exclusion. Gateway end-to-end tests use fakes and must not perform paid inference. Verify valid
API-only profile without `auth.json`, while ordinary cloud remains denied; missing/unreadable gateway
key and missing auth store fail correctly without bypass. Also verify provider allowlist,
`localOnly`, and `resolvableModels` are never widened.

Relevant seams: `bin/opencode-broker:1030-1032` and `:1169-1217`,
`lib/model-outage-runtime.js:179`, and `gateway/lib/gateway.js:1356-1406`, `:1960-1989`.

## Non-goals

- No credentials or secret values in broker config, docs, or tests.
- No spend controls inferred from console balance or caps.
- No current host config, secret file, service unit, deployment, restart, or paid inference.
- No automatic fallback from subscription or normal routes into the paid API reserve.
