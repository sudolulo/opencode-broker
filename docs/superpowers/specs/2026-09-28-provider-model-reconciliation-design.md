# Provider model reconciliation

Status: proposed
Date: 2026-09-28
Repo: opencode-broker (1.19.1 baseline)

## Problem

The broker already discovers subscription-backed models and assigns models from known provider
families to router tiers. Discovery is intentionally fail-closed: a model must be connected through
OAuth, resolvable by OpenCode, tool-capable, and mapped in `FAMILY_TIERS` before it can route.

That mechanism handles new releases inside a known family, but it does not provide a complete model
upgrade lifecycle:

- `lib/routing.js:975-987` hard-codes provider family-to-tier assignments.
- `lib/routing.js:1087-1118` admits mapped, resolvable family members as dynamic targets.
- `lib/routing.js:1517-1537` prefers the newest eligible discovered release in a family.
- `lib/watch.js:57-105` reports new models, newer line-mates, and unknown families, but cannot approve,
  stage, promote, or roll back a model.
- `reviewed-models.json` is a seen-notification ledger, not an approval or policy record.
- Provider health is provider-wide. A broken new model can affect the provider before the broker has
  a model-specific rollback decision.

This is already visible in the September 2026 releases. OpenAI's catalog contains GPT-6 Sol and
GPT-6 Luna, but the current OpenCode resolver does not expose them, so they correctly remain
unrouted. OpenAI also introduced Astra as a new top role and did not introduce GPT-6 Terra.
Anthropic's Opus 5 to 5.5 and Sonnet 5 to 5.5 transitions preserve stable role families. A rule that
only sorts version numbers is therefore insufficient: it must understand provider roles, must not
invent missing role siblings, and must retain the resolver gate.

The existing model-watch ntfy notifications are also a dead-end workflow. They report changes but
do not produce a durable proposal, an approval decision, or an auditable reconciliation result.

## Goal

Automatically keep each connected subscription provider on the provider-recommended best model for
each configured router role while preserving explicit safety gates and human control over new roles.

The finished system will:

1. Automatically recognize and stage an official same-role successor.
2. Use official provider comparisons and migration guidance rather than a homegrown quality
   benchmark.
3. Require approval for a genuinely new or contradictory provider role.
4. Verify runtime compatibility through the fleet gateway before full activation.
5. Retain the prior model as a deterministic rollback target.
6. Represent unresolved proposals as Gitea issues and alert through ntfy.
7. Replace the existing ad-hoc new-model notification path so only one reconciliation system runs.
8. Support all current and future OAuth/subscription providers through provider adapters.
9. Automatically give a known-role successor blocked only by OpenCode's static resolver model list a
   managed zero-cost resolver entry.
10. Ensure running clients never receive a model absent from the resolver generation they loaded at
    startup.

## Success criteria

- A known-role successor cannot become active until it is resolvable, subscription-backed,
  tool-capable, supported by official evidence, and operationally compatible.
- Generated resolver config is derived atomically from the version-controlled base plus a
  schema-validated overlay without editing the checkout.
- Known successors blocked only by the resolver can become resolvable automatically.
- Old clients stay on the incumbent while fresh-generation clients can receive the successor.
- The broker daemon counts distinct probation outcomes as they settle. Five successful production
  leases promote a candidate; two model-attributable failures within 15 minutes roll it back.
- A new provider role remains unrouted until its exact proposed mapping is approved.
- Re-running reconciliation creates no duplicate issue, notification, policy entry, or transition.
- Rejected and rolled-back models do not re-enter routing merely because they remain newest in the
  catalog.
- Gitea, ntfy, research, or catalog failures are explicit and do not silently change routing.
- The existing `opencode-model-watch` schedule and reviewed-model notification machinery are retired
  after a one-time migration.

## Non-goals

- Building a local benchmark that claims to rank frontier-model quality.
- Automatically discovering metered, unknown-auth, or local providers. Those remain explicitly
  configured. A provider reported as `api` may participate only when explicitly listed as a trusted
  subscription provider; trust never implies that arbitrary API-key providers are safe.
- Comparing provider pricing as if it were a quality score.
- Assuming every provider generation contains the same roles.
- Letting a research agent, issue edit, ntfy message, or arbitrary web page mutate production policy.
- Replacing quota balancing, provider weights, profiles, session stickiness, or provider-wide health.
- Calling provider APIs directly from the reconciler or compatibility checks.

## Terminology

- **Role:** A provider-defined capability/cost position such as OpenAI Sol or Anthropic Opus.
- **Router tier:** A broker lane such as `worker`, `review`, `build`, `smart`, or `deep`.
- **Successor:** A newer model that the provider officially identifies as the continuation or
  recommended replacement of an already governed role.
- **Proposal:** A durable suggested mapping for a new or contradictory role that requires approval.
- **Reconciliation:** Computing desired policy from catalog, resolver, role registry, evidence, and
  recorded decisions, then applying an allowed transition.
- **Operational probation:** Compatibility and reliability validation. It does not measure model
  quality.
- **Managed resolver overlay:** A schema-versioned, reconciler-written materialized view of
  policy-authorized ledger intents; the dedicated architecture section defines authorization and
  validation.
- **Resolver generation:** An immutable generated resolver configuration version captured by an
  OpenCode process at startup and attached to its lease requests.

## Architecture

The implementation remains in `opencode-broker`. The retired `opencode-router` predecessor is not
revived.

### Provider role registry

The broker gains a provider-qualified role registry. Product defaults define safe known mappings;
validated host overrides merge over those defaults and cannot silently remove a default role.

Each role entry contains:

- provider ID and stable role ID;
- accepted catalog family names and deterministic model-ID matchers;
- router tiers and per-tier fit and effort values;
- relative rank inside that provider's lineup;
- required capabilities, including tool and reasoning-mode requirements;
- version parsing rules;
- official provider domains and evidence requirements;
- optional compatibility-probe parameters.

The current `FAMILY_TIERS` data becomes the initial registry rather than remaining a second source of
truth. Discovery, watch/reconciliation, tests, and documentation all consume the registry.

Initial role intent is:

| Provider | Role | Router tiers | Notes |
| --- | --- | --- | --- |
| Anthropic | Opus | `build`, `smart` | Highest general Anthropic role |
| Anthropic | Sonnet | `build`, `review` | Faster scoped implementation/review role |
| Anthropic | Fable | `deep` | Reserved expensive reasoning role |
| Anthropic | Haiku | `worker`, `classifier` | Efficient worker role |
| OpenAI | Astra | `deep` | Highest GPT-6 role; not inferred from Sol |
| OpenAI | Sol | `smart` | Complex coding and agentic workflows |
| OpenAI | Terra | `build` | No GPT-6 sibling may be invented |
| OpenAI | Luna | `worker` | Efficient high-volume role; never classifier by inference |

Static host targets remain rollback anchors. An active/probation policy supersedes only the matching
provider-role for eligible client generations; unrelated targets and version-controlled config are
not rewritten.

### Provider adapters

Each subscription provider adapter normalizes catalog records into:

```text
providerID, modelID, family, roleID, version, releaseDate,
capabilities, context, output, variants, resolverKey
```

Adapters are deterministic. They may identify a candidate and its likely known role, but they do not
declare it better. Missing roles are valid. A model that fails normalization is recorded with a
reason and never guessed into a tier.

The generic discovery boundary remains:

- provider is connected;
- authentication is OAuth, or the provider is explicitly trusted as subscription-backed despite an
  `api` auth label;
- model is active and tool-capable;
- model ID is valid;
- OpenCode's resolver exposes the exact provider/model key for activation.

Untrusted `api` providers remain quarantined. Provider adapters make adding a future subscription
provider explicit without weakening the generic admission boundary.

Resolver admission distinguishes initial observation from activation. A known-role successor may
first be observed as `blocked-unresolvable`, but it must resolve exactly after a policy-authorized
managed overlay/render before probe or policy staging.

### Trusted subscription admission

`trustedSubscriptionProviders` is an explicit, operator-reviewed set for subscription-backed
providers whose OpenCode auth is labelled `api`. Explicit membership in this list is the operator
attestation that the provider is subscription-backed despite the `api` label. There is no runtime
inference from plan usage. An ordinary configuration review and deployment authorizes changes.
Connected trusted providers enumerate active catalog models exactly like OAuth providers. Trust is
provider-level only and does not bypass role mapping, official evidence, tool/capability/context,
resolver, probe, probation, rejection, or rollback gates.
Untrusted `api` providers remain quarantined and are reported as `blocked-quarantined` rather than
`evidence-pending`. Admission summaries must not say `admitted with models:0` merely because trust was
named.

### Managed resolver overlay

`~/.local/share/opencode/model-routing/resolver-overlay.json` is a schema-versioned, reconciler-written
deterministic materialized view of policy-authorized ledger intents, not policy authority. Each entry
includes:
- exact transition ID and revision;
- authorization kind (`auto-eligible` known successor or `approved` proposal);
- provider, model, role;
- evidence-or-decision hash;
- zero-cost model metadata.

Entries contain no credentials or `baseURL`. Known successors may authorize automatically when
supported by official evidence. Unknown, new, or contradictory roles require approval. Introduced
entries are append-only. The renderer cross-checks the ledger and rejects orphan or mismatched
entries.

### Immutable generation bundles

The renderer builds each candidate generation in a new immutable mode-0700 directory under a
deployment-configured generations root. The directory contains mode-0600 `opencode.json` and
`manifest.json` together. Manifest contains schema version, monotonic generation number, base hash,
overlay hash, effective config hash, exact resolver model-key set from a successful fresh
`opencode models --pure` run against that directory, creation time, and authorizing ledger revision(s).

Build and validate the full directory, fsync files+directory, then atomically switch one `current`
symlink. Never publish config and generation metadata separately. At Package 4 cutover, generate
immutable generation 0 from the version-controlled base only. Raw-base emergency fallback is treated
as legacy/base generation 0; normal emergency rollback atomically switches to the immutable
generation-0 directory.

Sole-writer `resolver-generations.json` registry persists the monotonic high-water mark and immutable
manifest hashes. Missing/regressed/corrupt high-water fails closed. An identical effective hash
reuses current generation. Base changes may add/remove/change models, so eligibility uses exact
manifest membership, never numeric ordering alone. Overlay model additions remain append-only; policy
holds remove routing eligibility rather than deleting additions. Cleanup retains generation 0,
current, and generations referenced by active process registrations; unreferenced retired
directories older than 30 days are removed with temp cleanup. A client presenting a cleaned/unknown
generation falls back to generation-0 eligibility, safely losing access to overlay-only models.

### Process registration and unambiguous legacy behavior

Plugin factory resolves the live config symlink once at process startup, reads config+manifest from
the same real generation directory, and registers `(generation, manifestHash)` with loopback broker.
Broker validates against registry and returns a process-registration token bound to that generation.
Lease calls carry token, not a caller-selected number. Token is process-lifetime and re-registration
is required after broker restart.

Missing token (legacy), unknown/cleaned generation, invalid token, forged future generation, or
raw-base config all get explicit generation-0/base-only eligibility. They may receive only model
keys in generation 0. Record `blocked-generation` per lease and select incumbent; never fail global
promotion. Numeric generation ordering never establishes model eligibility; only exact model-key
membership in the registered generation manifest does. `modelPolicy` stores candidate introduction
generation and manifest hash for audit, but selection checks membership. Status reports active process
registrations by generation. Old generations are informational.

### Official evidence collector

A research worker gathers provider comparisons and migration guidance from the registry's allowlisted
official domains. It returns constrained data rather than prose-driven policy:

```text
providerID, candidateModelID, incumbentModelID, claimType,
roleID, sourceURL, exactQuote, retrievedAt
```

Allowed policy claim types are `successor`, `recommended-replacement`, `new-role`, and `role-change`.
Comparative claims such as stronger, faster, and cheaper may be retained as supporting quotations but
never trigger automatic promotion. The worker's output is rejected when IDs do not match the
discovered candidate, the URL is outside the provider allowlist, required fields are missing, or
claims conflict.

The worker cannot write broker config, reconciliation state, Gitea labels, or routing policy. Stored
evidence includes the URL, exact quoted passage, retrieval time, and content hash so later page edits
do not alter the decision record.

A release date by itself is not evidence that a model is best. Automatic same-role promotion requires
an unambiguous official successor or replacement claim that agrees with the deterministic adapter.

Evidence collection is asynchronous and gateway-routed:

- Discovery writes one bounded evidence request to the reconciliation ledger and exits.
- A dedicated service runs `opencode-broker-evidence --max 1`.
- That deterministic wrapper calls `createReconciliationStore().update()` to claim the request under
  the shared lock, spawns `opencode run --agent researcher --model fleet-gateway/smart`, captures
  exactly one bounded JSON object, validates it, and calls the same store update boundary to ingest
  the evidence or record failure.
- There is no model-facing or separate evidence-ingest CLI command.
- The existing read-only `researcher` agent may search and read official sources but cannot edit files,
  run shell commands, call Gitea, or receive credentials.
- Temporary input, stdout, and stderr files are removed by a process-group cleanup trap. Bounded job
  artifacts follow the fleet job retention policy rather than accumulating indefinitely.
- On success the evidence unit triggers another reconciliation run. On failure the request remains
  `evidence-pending` with an explicit error and a 24-hour retry cooldown.

The evidence job has a 20-minute outer timeout. Validated evidence is immutable for that candidate
revision and is recollected only when the candidate revision changes, evidence conflicts, or an
operator explicitly requests refresh. The model process never receives a Gitea token.

### Reconciler

`opencode-broker-reconcile` replaces `opencode-broker-watch` as the single scheduled model-change
entry point. It inherits all three load-bearing duties of the retired watch: catalog refresh,
`opencode models --pure` resolver refresh, and publication of cached subscription inventory to the
broker. Each run:

1. Loads and validates the role registry, reconciliation ledger, resolver overlay, and broker policy.
2. Refreshes the catalog and current OpenCode resolver even when either previous snapshot is stale.
3. Seeds broker holds before inventory publication, then publishes the latest admissible cached
   subscription inventory.
4. Normalizes candidates through provider adapters, including trusted-subscription admission.
5. Gathers missing official evidence or reuses validated evidence for the same candidate revision.
6. When a known successor is blocked only by the resolver, dry-run only proposes and reports the
   overlay mutation. Apply mode atomically adds the entry, renders the next generation, launches a
   fresh resolver process against it, and requires the exact key before staging.
7. Rejects activation when sources are stale or empty, refresh fails, or the authentication revision
   changes during the run.
8. Stages eligible policy through the broker daemon and reconciles projections from durable state.

Steps 3, 6, and 8 have a strict dry-run/package boundary. Dry-run proposes and reports the overlay
mutation only; it does not add an entry, render, run a fresh resolver, or mutate policy. Package 3
implements inventory/control/apply machinery reachable only through injected test endpoints/state
roots and default-off controls. Package 4 alone enables live inventory
publication, overlay/config publication, broker policy mutation, external projections, and scheduling
after cutover gates.

Cached data may still produce observations and evidence requests, clearly marked stale, but it can
never activate a model. `blocked-stale` retries on the next scheduled run because refresh always
precedes the mutation gate; stale state cannot prevent its own refresh.

Every operation uses a stable transition key. Repeating a partially completed run resumes the same
transition rather than creating another issue, alert, or decision.

## Durable state

Proposal, evidence, approval, and presentation state lives at:

```text
~/.local/share/opencode/model-routing/model-reconciliation.json
```

The existing state directory remains mode `0700`; the file is atomically replaced and mode `0600`.
The schema is versioned and read through an explicit whitelist, following the existing broker-state
contract.

`createReconciliationStore().update()` is the sole ledger mutation implementation and lock/atomic-write
boundary. Both `opencode-broker-reconcile` and `opencode-broker-evidence` invoke it directly. Every
update takes the same exclusive lock before reading and atomically replacing state. The evidence binary
claims, collects, validates, and ingests in one deterministic process. The relevant reconcile commands
are: `dry-run`, `status`, `evidence-status`, `project`, `approve`, `reject`, `amend`. Package 3 adds
explicit apply/rollback/refresh entry points rather than assuming a generic `run`.

An expired evidence claim becomes eligible for another worker; concurrent read-modify-write is never
allowed. Each provider-role record contains:

- stable proposal/transition ID;
- provider, role, candidate, incumbent, and prior rollback model;
- normalized catalog metadata;
- official evidence records;
- proposed tiers, fit, and effort;
- resolver-overlay decision and generation;
- `blocked-quarantined` status and reason;
- state and state-change timestamps;
- observed broker policy/probation state, copied for presentation but never used as the runtime
  counter source;
- approval decision and source;
- Gitea issue number and URL;
- ntfy delivery markers;
- activation and rollback history.

Runtime activation, probation counters, active/rollback target IDs, and immediate rollback state live
under a new `modelPolicy` section in broker-owned `broker.json`. Each `modelPolicy` record stores the
provider-role, incumbent/active/probation/rollback model IDs, inherited routing envelope (tiers, fit,
and effort), candidate introduction generation and manifest hash for audit, counters/windows, and
transition identity/history. The broker daemon remains the only writer to `broker.json`; the
reconciler stages decisions through a new loopback-only control command and reads status through the
broker API. Lease eligibility uses exact key membership in registered generation manifest.

### Cross-store transition protocol

The reconciler and broker maintain consistency through an explicit saga:

1. Reconciler persists ledger intent with transition ID and revision under shared lock.
2. For resolver changes, it deterministically materializes overlay from authorized ledger intents,
   each entry naming exact transition/revision/authorization kind. Renderer cross-checks
   provider/model/role/evidence-or-decision hash before building; orphan/mismatch rejects.
3. Immutable generation is built, resolver-validated and atomically published. Manifest names ledger
   revision.
4. Reconciler records generation acknowledgement in ledger. No broker policy staging before this ack.
5. Reconciler persists policy-pending intent/revision.
6. Broker loopback compare-and-set receives transition ID, revision, expected incumbent, generation+
   manifest hash and desired policy. Broker rejects stale revisions/mismatch, persists idempotently,
   returns ack.
7. Reconciler records broker ack.

Recovery windows: after ledger intent only, next run rematerializes; after generation publish before
ack, next run verifies current manifest and records ack; after broker commit before ledger ack, next
run queries broker and records ack. Repeated command returns same result. Any mismatch blocks with
no later mutation. Broker rollback persists first and is later observed/projected by reconciler.

Overlay is a deterministic materialized view of authorized ledger state, not a second policy
authority. Renderer consistency validation is not policy decision-making. Fault-injection tests run
after every write/ack boundary.

Every governed provider-role has a broker policy record, even before it has a candidate. On first
enablement the broker seeds each record atomically from the current incumbent before refreshed
inventory is published. If a role has no incumbent, its active model is explicitly `null`. All
discovered models for a governed role are held ineligible unless the policy record names them as the
active model or current probation candidate. This hold applies to fresh and stale inventory alike, so
publication can expose metadata without bypassing evidence or approval.

The reconciliation state machine is:

```text
discovered -> evidence-pending -> auto-eligible | awaiting-approval
awaiting-approval -> approved | rejected
auto-eligible | approved -> probing -> probation -> active
```

Side and terminal states are:

```text
blocked-unresolvable, blocked-quarantined, blocked-generation, blocked-stale, blocked-conflict,
rejected, rolled-back, superseded
```

Rejected and rolled-back records are policy decisions. They remain effective until a later explicit
decision supersedes them.

The four state contracts are:
- `ledger` is authoritative; `createReconciliationStore().update()` is its sole mutation implementation
  and lock/atomic-write boundary, invoked directly by the reconcile/evidence binaries;
- `resolver-overlay.json` is a reconciler materialized view;
- `generation bundles` and `resolver-generations.json` are renderer-only outputs with no policy
  authority;
- `broker.json` `modelPolicy` is broker-only.
All are documented in `docs/STATE.md`.

## Reconciliation paths

### Known-role successor

A candidate proceeds automatically only when:

1. The adapter maps candidate and incumbent to the same stable role.
2. Official evidence identifies the candidate as successor or recommended replacement.
3. The provider-role mapping already exists.
4. Authentication is OAuth or trusted subscription, and the exact resolver key succeeds in the
   rendered generation.
5. All capability and context gates pass.
6. No rejection, rollback hold, or contradictory evidence applies.

Known-role successors may receive an automatic overlay addition. Unknown, new, or contradictory roles
receive no overlay entry until approval.

The reconciler stages the candidate with the broker daemon, which owns operational probing,
probation counters, activation, and immediate rollback. The prior active model remains the rollback
target. A newly approved role may have no prior active model; that absence is represented explicitly,
not filled by another role or provider.

### New or contradictory role

An unknown family, new role, changed role hierarchy, or evidence conflict remains unrouted. The
collector produces a structured proposal containing the exact suggested role and router tiers.

The reconciler creates one issue in `opencode/opencode-broker` with:

- proposal ID;
- candidate and current provider lineup;
- proposed role/tier mapping;
- official source links and quotes;
- operational admission status;
- exact approval and rejection instructions.

The issue receives `model-reconciliation` and awaits exactly one decision label:

- `decision/approved`
- `decision/rejected`

Approval accepts the locally stored proposal, not mutable issue text. Rejection records the decision
and prevents repeated proposals for the same identity. Both labels together are a conflict and cause
no policy change.

The reconciler comments with the applied result and closes the issue. Closing an undecided issue does
not approve it; the reconciler reopens it once with instructions. A changed proposal gets a new
revision and requires a fresh decision.

### OpenCode approval skill

A small fleet skill exposes list, inspect, approve, reject, amend, and reconcile operations. It calls
the same broker command and durable state contract as the Gitea path. It does not maintain separate
approval state. Gitea remains the remote/mobile approval surface; the skill is the convenient session
surface.

## Operational probing and probation

Compatibility checks use an exact-target broker assignment followed by a request through the fleet
gateway. No script or service calls a provider API directly, and no new externally selectable gateway
model name is introduced.

Exact-target probes launch from a fresh process using an immutable registered generation whose
manifest contains the candidate's exact model key; older/other manifest without exact key invalid.

The flow is:

1. The reconciler stages the exact candidate in broker-owned `modelPolicy` through a loopback-only
   control command.
2. The broker creates a one-shot exact `preferredModel` assignment for a random probe session and
   returns a short-lived single-use nonce.
3. The probe client calls the normal loopback fleet-gateway endpoint with the role's ordinary gateway
   model name, existing session identity, and nonce.
4. The gateway accepts the probe marker only from loopback, validates the nonce with the broker, and
   consumes it before forwarding the request. LAN clients and ordinary gateway credentials cannot
   create or reuse probe assignments.
5. The broker releases the assignment on completion, failure, or timeout.

The probe verifies:

1. A normal response can complete.
2. A strict no-side-effect tool schema produces a valid tool call.
3. The role's required reasoning and request-parameter mode is accepted.

Probe prompts contain no user data. The exact-target probe capability is local and narrowly scoped;
it cannot be used by ordinary clients to bypass profile or tier policy.

After probes pass, the broker daemon enters model-specific probation:

- at most one candidate probation lease is active at a time for that provider-role;
- five distinct successful production leases activate the candidate fully;
- two model-attributable failures within 15 minutes roll it back;
- provider, network, user cancellation, and unrelated tool failures do not count as model failures;
- a success is counted once from `/complete` or validated `/usage`, never once from each;
- a failure older than 15 minutes expires from the failure window;
- probation expires after seven cumulative eligible opportunity-days without five successes and rolls
  back as `probation-timeout`; old-client-only periods pause the clock;
- synthetic probes do not count toward production successes;
- probation observes operational success only and makes no quality claim;
- timeout occurs after seven cumulative eligible opportunity-days beginning with first eligible
  candidate production lease; time pauses when no generation-compatible production client requests
  the role; blocked-generation is reported; no eligible traffic never creates rollback hold;
- distinct outcomes keyed by lease ID and session ID, counted once from complete/validated usage;
- abandoned leases expire via normal lease expiry and count neither success nor model failure;
- lack of eligible traffic never creates rolled-back/model-failure hold.

Package 3 defines a closed failure taxonomy at the broker API boundary. Only model-attributable
classes such as model-not-found, unsupported model parameter, invalid model tool-call response, and
model entitlement failure count toward rollback. Network failure, rate limiting, provider overload,
user cancellation, client disconnect, and tool execution failure do not count. Unknown failure classes
are recorded but do not count automatically.

Model-specific health is separate from provider-wide health. A bad candidate does not quarantine an
otherwise healthy provider. Existing provider circuits still apply independently.

## Activation, selection, and rollback

Activation atomically updates broker-owned `modelPolicy` state consumed by target discovery and
selection. This state identifies the candidate, active model, and prior rollback model for the
provider-role. Selection no longer uses newest release alone when a reconciliation decision exists.

The overlay is seeded from the static incumbent. A candidate inherits role routing intent from the
incumbent: tiers, fit, and configured effort intent/ceiling. Its actual context, output, and variants
come from the candidate's fresh resolver/catalog metadata. Effective effort is the intersection of
role policy and the variants the candidate actually resolves. Missing required effort or capability
blocks staging; never copy the incumbent's literal variant list to the successor. For a new approved
role with no incumbent, the proposal supplies complete routing intent and required capabilities, not
fabricated model capabilities. Within a provider-role, active/probation policy replaces the static
incumbent rather than competing by fit; the static target remains the rollback anchor. Outside that
role, preserve provider weights, quota balancing, contexts, health/circuits, local/private boundaries,
and profile/tier boundaries.

**Effort policy location and candidate capability:** `effortCeiling` and required reasoning mode live
in provider role registry / modelPolicy routing intent, not CONFIG.modelVariants and not copied from
incumbent model capabilities. Candidate supported variants come only from fresh resolver metadata.
Effective effort clamps to highest candidate-supported level at/below ceiling. If a specifically
required reasoning mode is absent, staging blocks. A preferred ceiling absent is clamped, not blocked.

Policy has precedence over automatic family release sorting but not over:

- resolver admission;
- profile and tier boundaries;
- context fit;
- provider health/circuits;
- local-only/private network boundaries;
- explicit model quarantine;
- configured provider weighting and quota balancing.

The client's resolver generation must have exact model-key membership in the registered generation
manifest. Older and legacy clients receive the incumbent. During probation at most one candidate
lease is active for the role; the candidate receives bounded opportunities rather than losing to
incumbent fit. A `blocked-generation` state describes a lease/client compatibility exclusion, not a
failed global promotion.

The broker daemon performs automatic rollback immediately when the second qualifying failure settles;
it does not wait for the scheduled reconciler. It restores the recorded prior model, persists the
runtime decision, and records a transition event. The reconciler observes that event, marks its
presentation record `rolled-back`, and sends one notification. Manual rollback uses the same broker
transition and is idempotent.

**Post-promotion rollback:** modelPolicy retains rollback target after promotion. The same closed
two-qualifying-model-failures/15-minute threshold remains active after promotion; reaching it
atomically rolls back. Ordinary transient/provider failures remain excluded. A later explicit
operator decision may retire/change rollback target.

When an approved new role has no incumbent, probe failure, the second probation failure, or the
seven cumulative eligible opportunity-days without five successes removes the candidate from
active/probation eligibility and restores the role to explicit `activeModelID: null`. The persisted
reconciliation state is the existing `rolled-back` state; `activeModelID: null` expresses that it is
unrouted. The approved role mapping
remains recorded, and it cannot borrow a model from another role. A later official successor may be
staged through a new transition.

Rollback does not remove the historical overlay entry. A policy hold makes the model ineligible, and
preserved state prevents repeated retries.

## Gitea and ntfy integration

The reconciliation ledger is authoritative for proposals, evidence, approvals, and presentation;
broker-owned `modelPolicy` is authoritative for runtime activation, probation, and rollback. Gitea
and ntfy are projections of those two state contracts.

The reconciler sends one ntfy event for each of:

1. Approval-required proposal opened, linking to its Gitea issue.
2. Known successor entering probation.
3. Promotion completed.
4. Promotion rolled back or reconciliation blocked.

Delivery markers prevent duplicates. Failed delivery remains pending for bounded retry and appears in
broker/reconciler health. A notification failure does not reverse a safe automatic transition.
Failure to create or read the required Gitea issue blocks approval-required transitions.

Gitea and ntfy credentials are never stored in source, state, logs, issue text, or command arguments.
The model process receives neither credential. A deterministic publisher uses fixed API operations and
a write-scoped Gitea token from a mode-0600 deployment-time drop file. Scheduled services do not call
`rbw`.

## Error handling

Before a candidate is staged, reconciliation fails closed without policy mutation when:

- the current run cannot refresh the catalog or resolver, the catalog cache exceeds 48 hours, or the
  resolver snapshot exceeds 72 hours;
- authentication revision changes during a run;
- trusted-provider admission is inconsistent, including an admitted provider with no enumerated
  models when eligible models exist;
- provider/model identity is malformed;
- the overlay is invalid or corrupt;
- an overlay/base collision is detected;
- generated-config render validation fails;
- either base or overlay input hash changes during render;
- a resolver refresh does not expose the exact model;
- official evidence is missing, ambiguous, conflicting, or off-domain;
- required catalog capabilities regress;
- the durable state version is unknown;
- Gitea decisions conflict;
- an approval-required issue cannot be reconciled.

A stale or legacy client generation is a per-lease eligibility exclusion recorded as
`blocked-generation`; the broker selects the incumbent for that lease and does not fail or roll back
global promotion. A claimed future or unknown generation is rejected to the incumbent and logged.

Every blocked transition stores a reason and retry condition. Corrupt state is preserved for diagnosis
and causes a loud failure; it is never silently replaced with empty state.

No policy mutation occurs until overlay render and a fresh resolver pass succeed. Generated-config
failure leaves the current generation live. Temporary artifacts are always swept.

After staging, a probe regression is not a no-mutation case: the broker must mutate `modelPolicy` to
remove the candidate, restore the incumbent or explicit `activeModelID: null`, and persist
`rolled-back`. That rollback is the only permitted policy mutation from a failed probe; the candidate
never becomes active.

**Base change safety:** renderer refuses to publish a generation that removes any modelPolicy active,
probation, or rollback target unless the same authorized transition replaces/retires that reference.

## Notification retirement and migration

The fleet currently runs `opencode-model-watch.service` and `.timer` from `fleet-core`, with the watch
notification command configured in `config/opencode-broker/config.json`.

Deployment follows the canonical Rollout section below. Dry-run may coexist with the old timer because
it is prohibited from live mutation. Before any apply, the old timer is stopped and disabled and the
active service is awaited; the final delta import occurs after exit. On failure, generation 0/raw base
is restored and the old timer is re-enabled. On success, the new timer is enabled, exactly one schedule
is verified, the old executable and ledger are retained for a seven-day rollback window, and then
one-time manual cleanup is performed. No simultaneous policy-era publishers run.

`watch.notifyCommand` currently supplies a compatibility default used by burn-watch and slot-watch.
This release does not delete that config key. The reconciler adds its own notification setting with a
fallback to the legacy shared value, and tests pin existing burn-watch/slot-watch inheritance. A later
independent config cleanup may replace the deprecated alias only after every alert consumer has an
equivalent explicit default.

This cleanup is not a recurring pipeline step because the retired path cannot recreate the old state.
Unrelated fleet and broker ntfy alerts remain unchanged.

## Testing

### Unit tests

- Provider adapter parsing for known roles, versions, missing siblings, malformed IDs, and unknown
  roles.
- Trusted `api`-labelled subscription enumeration versus untrusted `api` quarantine, including an
  honest `blocked-quarantined` summary.
- Overlay schema, collision, zero-cost, atomic rendering, hash races, and temp cleanup.
- Resolver-generation parsing and legacy behavior.
- Registry validation, default/override merging, and prevention of silent default removal.
- Official evidence schema, allowlists, exact-ID matching, conflicting claims, and content hashes.
- Evidence request cooldown, timeout, bounded JSON validation, immutable candidate revision, and
  process cleanup.
- Every state transition, invalid transition, idempotent replay, and state-version rejection.
- Shared reconciliation lock, evidence claim expiry, and concurrent ingest/run exclusion.
- Stable proposal IDs and notification/issue deduplication.
- Approval, rejection, conflicting labels, close-without-decision, amendment, and supersession.
- Failure classification and probation counters.
- Single-writer contracts: reconciler ledger versus broker-owned `modelPolicy` runtime state.
- Active-overlay precedence, rejection holds, rollback holds, and prior-model restoration.
- Incumbent routing-intent inheritance, candidate resolver/catalog metadata for context/output/variants,
  effort intersection, static-pin replacement rather than fit competition, generation eligibility, and
  the policy schema.
- Missing required effort/capability blocks staging; new approved roles provide routing intent and
  required capabilities without fabricating model capabilities.
- Governed-role holds prevent fresh or stale published candidates from routing while evidence or
  approval is pending.
- Burn-watch and slot-watch notifications remain configured when model-watch code is removed.

### Integration tests

- Catalog visible but resolver absent: record `blocked-unresolvable`, do not route.
- GPT-6 absent from base: automatic overlay, fresh resolver, and exact model exposure.
- Resolver later exposes the same model: resume the existing transition without duplication.
- Known successor with official evidence: probe, probation, activate, and preserve rollback.
- Anthropic `api`-labelled trusted provider discovers 5.5; untrusted `api` remains quarantined.
- An old client never receives an introduced model while a new client does.
- Five-success promotion and second-failure rollback preserve old clients.
- Unrelated provider balancing remains unchanged.
- Generated-config failure leaves the old generation live.
- Unknown role: create one issue and ntfy event, remain unrouted, approve, then continue.
- Rejected proposal remains excluded on later refreshes.
- Probe failure and two probation failures restore the prior model.
- Probe failure, probation failure, and timeout for a new role with no incumbent restore explicit
  unrouted state while preserving the approved role mapping.
- `/complete` plus `/usage` for one lease counts once; failures age out after 15 minutes; seven
  cumulative eligible opportunity-days without five successes restore the prior model; old-client-only
  periods pause the clock.
- Gitea outage blocks approval-required transitions without blocking unrelated known successors.
- ntfy outage retains a bounded pending delivery and surfaces unhealthy status.
- Authentication changes mid-run abort atomically.
- Gateway probe nonce is loopback-only, single-use, short-lived, and cannot be requested or replayed
  by an ordinary external client.

### Migration and deployment tests

- A v1 reviewed ledger imports once and cannot recreate duplicate notifications.
- Initial rendering occurs before symlink cutover; switching to immutable generation 0, with raw-base
  fallback only as the legacy emergency path, provides emergency rollback.
- Existing TUIs need not be killed, and the old timer is retired only after one healthy full cycle.
- Existing broker state and static targets remain valid.
- The fleet sync deploys the reconciler unit, config, and approval skill through existing symlink
  conventions.
- `systemctl --user` shows the old timer disabled and exactly one reconciler timer active.
- Dry-run reports the exact GPT-6 managed-overlay proposal and makes no resolver, config, or routing
  mutation.

### Named tests

- Config/manifest publication crash
- Render/start race
- High-water loss/regression
- Base-model removal is refused until the same authorized transition migrates or retires every active,
  probation, and rollback reference
- Generation-0 rollback
- Legacy/missing token
- Valid old/current registrations
- Forged future/unknown generation
- Re-registration after broker restart
- Cleanup fallback
- Old-client-only paused probation
- First eligible lease clock
- Abandoned lease neutral
- Post-promotion rollback
- Each saga crash window/stale CAS
- Dry-run bytes+mtimes/API calls
- Old-watch quiesce/final delta/failure restore
- Product tests use `node --test tests/*.mjs`; deployment checks run separately in `fleet-core`.

### Dry-run mutation matrix
Dry-run may create scratch temp files, transient lock, and durable ledger observations/evidence
requests as Packages 1/2 already do. It must not change live catalog/resolver snapshots, resolver
overlay, generation registry/directories/current symlink, broker inventory/policy/API, Gitea, or ntfy.
Fresh resolver means post-overlay apply-only resolver. Tests compare bytes/mtimes of prohibited files
and assert zero broker/publisher calls.

## Implementation decomposition

This architecture is intentionally delivered through four sequential implementation plans. No plan
may silently absorb a later package:

1. **Registry and dry-run reconciliation:** role registry, provider adapters, reconciler ledger and
   lock, catalog/resolver refresh, proposed-inventory validation, stale gates, migration reader, and
   dry-run CLI. This package does not publish inventory, perform web research, enable governed-role
   holds, or mutate live routing.
2. **Evidence and approval projections:** gateway-routed asynchronous researcher job, bounded evidence
   validator, deterministic Gitea publisher, decision labels, ntfy transition projection, and
   idempotent proposal lifecycle. Routing remains dry-run only.
3. **Runtime promotion:** trusted-subscription enumeration, overlay schema/renderer, broker
    `modelPolicy`, incumbent seeding/holds, generation-aware leases, control/status API, exact probes,
    probation, policy precedence/envelope inheritance, and immediate rollback; dormant apply controls.
4. **Fleet cutover:** generated-config symlink cutover, Anthropic trusted-subscription enablement,
   approval skill, fleet config/services/timer, projections/live apply enablement, one-time
   migration/removal, deployment, and emergency rollback verification.

Each package receives its own implementation plan, tests, review, and commit boundary. Versioning and
release batching follow the fleet release rules rather than being implied by these package boundaries.
Packages 1 and 2 are complete; the next plan is revised package 3, based on their verified output.
Later plans must re-read this architecture and the verified output of the preceding package.

## Rollout

1. Finish Package 3 dormant and verify injected/test-only paths.
2. Package 4 deploys new units disabled and builds/validates immutable generation 0 from current base
   without switching live config.
3. Run dry-run while old timer remains active.
4. Stop+disable old timer and wait for active old service exit; perform final delta import.
5. Atomically switch live config to generation 0, add Anthropic trusted-subscription attestation,
   restart broker/gateway, manually run apply, generation compatibility checks, and probation/rollback
   drill.
6. On failure switch back to generation 0/raw-base safe path as appropriate and re-enable old timer.
7. On success enable new timer and verify exactly one schedule; keep old executable+ledger for a
   seven-day rollback window, then one-time manual removal because no process can recreate old state.
Existing TUIs remain on captured generation/legacy base eligibility and are not killed; no
simultaneous policy-era publishers run.

The implementation spans two repositories in one coordinated release batch:

- `opencode/opencode-broker`: product logic, state/API/CLI, tests, and docs.
- `flan/devbox` (`/home/dev/fleet-core` compatibility path): config, systemd deployment, and approval
  skill.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Provider marketing language is ambiguous | Require constrained official evidence; contradictions become approval proposals |
| A provider changes naming conventions | Provider adapter fails closed and opens a new-role proposal |
| A new release is cataloged before OpenCode supports it | Give a known successor overlay/render/fresh resolver; if still absent, remain `blocked-unresolvable` |
| New model accepts text but breaks tools | Exact-target tool and parameter probes plus limited probation |
| Newest-model sorting resurrects a rejected model | Reconciliation overlay and durable rejection/rollback holds outrank release sorting |
| Agent output changes policy | Agent output is evidence only; deterministic validation and reconciliation own mutation |
| Issue text is edited maliciously | Local proposal is authoritative; approval accepts only its stored revision |
| Gitea or ntfy creates duplicate work | Stable IDs and per-transition delivery markers make projections idempotent |
| Credentials leak from a scheduled unit | Deployment-provisioned service credentials; no rbw calls, argv secrets, state, or logs |
| Two schedules race | Replace and disable the old timer; lock reconciliation; verify one active schedule |
| State corruption erases decisions | Atomic writes, explicit schema version, preserved corrupt evidence, loud failure |
| Scheduled reconciler cannot react inside the failure window | Broker daemon alone owns probation counters and immediate rollback |
| Evidence job bypasses the gateway | Force `fleet-gateway/smart`; integration-test the resolved provider path before enablement |
| Removing model-watch mutes other alerts | Preserve the shared notify fallback and pin burn-watch/slot-watch behavior in tests |
| Daemon dirties repo | Generated host config; never edits checkout |
| Old TUI/new model | Registration token and exact manifest membership |
| Trust admits metered | Membership is explicit operator subscription attestation; untrusted api quarantined |
| Static fit | Role policy replacement and inherited intent |
| Bad render | Immutable validated bundle/current symlink/gen0 rollback |
| Temp/generation junk | Cleanup traps, bounded retention |
| Cross-store crash | Saga/CAS recovery |
| Registry corruption | Sole writer/high-water/fail closed |
| Stale/malicious generation | Registry-validated process token and base-only fallback |
| Old-watch delta race | Stop/wait then final delta import |
| Cleanup loses active client | Retain active registrations, 30-day grace, unknown falls base-only |

## Accepted decisions

- Use a provider role registry and deterministic reconciler.
- Use provider-published comparisons instead of local quality benchmarking.
- Use operational probes and probation only for compatibility/reliability.
- Let an agent propose new roles; require Holden's approval.
- Use Gitea decision labels as the remote approval action.
- Provide a thin OpenCode skill over the same reconciliation contract.
- Keep ntfy for alerts while retiring the existing ad-hoc model notifications.
- Open one Gitea issue per unresolved proposal and close it through reconciliation.
- Known-role resolver overlay is automatic.
- Unknown roles require approval before overlay.
- Trusted `api`-labelled subscriptions enumerate models; untrusted `api` remains quarantined.
- Generated config never edits the checkout.
- Static pins are rollback anchors; policy replaces the same role with an inherited envelope.
- Immutable generation directories with exact manifests.
- Process registration token for unambiguous eligibility.
- Ledger-first CAS saga for cross-store consistency.
- Probation opportunity clock with opportunity pause on old-client-only traffic.
- Post-promotion rollback with retained target.
- Trusted-list attestation via explicit membership.
- Safe cutover with no simultaneous policy-era publishers.

## Effort policy resolution

`CONFIG.modelVariants` is not a policy source for Package 3. Candidate-supported variants come only
from fresh resolver metadata. Role-level `effortCeiling` and required reasoning mode live in the role
registry and `modelPolicy`; preferred ceilings clamp to supported variants, while a missing required
mode blocks staging. The existing fleet-config guard continues to reject configured effort levels that
OpenCode cannot resolve.
