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

## Success criteria

- A known-role successor cannot become active until it is resolvable, subscription-backed,
  tool-capable, supported by official evidence, and operationally compatible.
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
- Automatically discovering API-key, metered, unknown-auth, or local models. Those remain explicitly
  configured unless a separate design enables them.
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

## Architecture

The implementation remains in `opencode-broker`. The retired `opencode-router` predecessor is not
revived.

### Provider role registry

The broker gains a provider-qualified role registry. Product defaults define safe known mappings;
validated host overrides merge over those defaults and cannot silently remove a default role.

Each role entry contains:

- provider ID and stable role ID;
- accepted catalog family names and deterministic model-ID matchers;
- router tiers and per-tier fit values;
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

Static host targets remain valid. A reconciled active decision supersedes only the matching
provider-role lane; it does not rewrite unrelated targets or config files.

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
- authentication is OAuth/subscription;
- model is active and tool-capable;
- model ID is valid;
- OpenCode's resolver exposes the exact provider/model key.

Provider adapters make adding a future subscription provider explicit without weakening the generic
admission boundary.

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

1. Discovery writes one bounded evidence request to the reconciliation ledger and exits.
2. A dedicated user service claims at most one pending request and runs:

   ```text
   opencode run --agent researcher --model fleet-gateway/smart
   ```

3. The existing read-only `researcher` agent may search and read official sources but cannot edit
   files, run shell commands, or call Gitea.
4. A deterministic wrapper captures stdout, requires exactly one bounded JSON value matching the
   evidence schema, validates it, and passes it on stdin to
   `opencode-broker-reconcile evidence-ingest`. That command is the only writer that updates the
   reconciliation ledger.
5. Temporary input, stdout, and stderr files are removed by a process-group cleanup trap. Bounded job
   artifacts follow the fleet job retention policy rather than accumulating indefinitely.
6. On success the evidence unit triggers another reconciliation run. On failure the request remains
   `evidence-pending` with an explicit error and a 24-hour retry cooldown.

The evidence job has a 20-minute outer timeout. Validated evidence is immutable for that candidate
revision and is recollected only when the candidate revision changes, evidence conflicts, or an
operator explicitly requests refresh. The model process never receives a Gitea token.

### Reconciler

`opencode-broker-reconcile` replaces `opencode-broker-watch` as the single scheduled model-change
entry point. It inherits all three load-bearing duties of the retired watch: catalog refresh,
`opencode models --pure` resolver refresh, and publication of cached subscription inventory to the
broker. Each run:

1. Loads and validates the role registry and reconciliation ledger.
2. Attempts catalog and OpenCode resolver refreshes, even when the previous snapshots are stale.
3. Ensures the broker has an active-model hold for every governed provider-role, then republishes the
   latest admissible cached subscription inventory. A successful refresh is not discarded merely
   because activation is blocked, but publication cannot make a held candidate selectable.
4. Refuses activation when the current run did not refresh both sources successfully, the catalog
   cache is older than 48 hours, the resolver snapshot is older than 72 hours, either source is
   empty, or authentication revision changes mid-run.
5. Normalizes candidates through provider adapters.
6. Enqueues missing official evidence or reuses validated evidence for the same candidate revision.
7. Computes transitions and stages eligible policy changes through the broker daemon.
8. Reconciles Gitea and ntfy presentation from durable state.

Steps 3, 7, and 8 have a strict dry-run boundary. In packages 1 and 2 the reconciler builds and
validates the proposed inventory, holds, transitions, issues, and notifications but does not call the
broker inventory/control APIs or external publishers. Live inventory publication is first enabled in
package 3 only after incumbent seeding and governed-role holds commit atomically. Package 4 then moves
that live path onto the scheduled fleet service.

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

The `opencode-broker-reconcile` executable is the only writer implementation for this file. Every
ledger-mutating subcommand, whether invoked by the scheduled service or evidence wrapper, acquires the
same exclusive lock before reading and atomically replacing state. The relevant subcommands are:

- `evidence-claim`, which leases one request for 30 minutes and emits its bounded input;
- `evidence-ingest`, which validates and records a completed result;
- `evidence-fail`, which records a bounded error and retry time;
- `approve`, `reject`, and `amend`, which apply operator decisions;
- `run`, which performs ordinary reconciliation and presentation updates.

An expired evidence claim becomes eligible for another worker; concurrent read-modify-write is never
allowed. Each provider-role record contains:

- stable proposal/transition ID;
- provider, role, candidate, incumbent, and prior rollback model;
- normalized catalog metadata;
- official evidence records;
- proposed tiers and fit;
- state and state-change timestamps;
- observed broker policy/probation state, copied for presentation but never used as the runtime
  counter source;
- approval decision and source;
- Gitea issue number and URL;
- ntfy delivery markers;
- activation and rollback history.

Runtime activation, probation counters, active/rollback target IDs, and immediate rollback state live
under a new `modelPolicy` section in broker-owned `broker.json`. The broker daemon remains the only
writer to `broker.json`; the reconciler stages decisions through a new loopback-only control command
and reads status through the broker API. Both files receive explicit writer/reader/schema rows in
`docs/STATE.md`.

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
blocked-unresolvable, blocked-stale, blocked-conflict,
rejected, rolled-back, superseded
```

Rejected and rolled-back records are policy decisions. They remain effective until a later explicit
decision supersedes them.

## Reconciliation paths

### Known-role successor

A candidate proceeds automatically only when:

1. The adapter maps candidate and incumbent to the same stable role.
2. Official evidence identifies the candidate as successor or recommended replacement.
3. The provider-role mapping already exists.
4. All subscription, resolver, capability, and context gates pass.
5. No rejection, rollback hold, or contradictory evidence applies.

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
- probation expires after seven days without five successes and rolls back as `probation-timeout`;
- synthetic probes do not count toward production successes;
- probation observes operational success only and makes no quality claim.

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

The overlay has precedence over automatic family release sorting but not over:

- resolver admission;
- profile and tier boundaries;
- context fit;
- provider health/circuits;
- local-only/private network boundaries;
- explicit model quarantine;
- configured provider weighting and quota balancing.

The broker daemon performs automatic rollback immediately when the second qualifying failure settles;
it does not wait for the scheduled reconciler. It restores the recorded prior model, persists the
runtime decision, and records a transition event. The reconciler observes that event, marks its
presentation record `rolled-back`, and sends one notification. Manual rollback uses the same broker
transition and is idempotent.

When an approved new role has no incumbent, probe failure, the second probation failure, or the
seven-day probation timeout removes the candidate from active/probation eligibility and restores the
role to explicit `activeModelID: null`. The persisted reconciliation state is the existing
`rolled-back` state; `activeModelID: null` expresses that it is unrouted. The approved role mapping
remains recorded, and it cannot borrow a model from another role. A later official successor may be
staged through a new transition.

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
- provider/model identity is malformed;
- official evidence is missing, ambiguous, conflicting, or off-domain;
- required catalog capabilities regress;
- the durable state version is unknown;
- Gitea decisions conflict;
- an approval-required issue cannot be reconciled.

Every blocked transition stores a reason and retry condition. Corrupt state is preserved for diagnosis
and causes a loud failure; it is never silently replaced with empty state.

After staging, a probe regression is not a no-mutation case: the broker must mutate `modelPolicy` to
remove the candidate, restore the incumbent or explicit `activeModelID: null`, and persist
`rolled-back`. That rollback is the only permitted policy mutation from a failed probe; the candidate
never becomes active.

## Notification retirement and migration

The fleet currently runs `opencode-model-watch.service` and `.timer` from `fleet-core`, with the watch
notification command configured in `config/opencode-broker/config.json`.

Deployment will:

1. Introduce the reconciler service/timer with `[X-Job] Replaces=opencode-model-watch.timer`.
2. Disable the old timer before enabling the new timer.
3. Import relevant seen keys from `reviewed-models.json` once to avoid an initial alert flood.
4. Verify the new state and schedule.
5. Remove the old reviewed ledger and old new-model/new-family/newer-line notification path as a
   one-time cleanup.
6. Confirm only one model-change schedule remains enabled.

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
- Governed-role holds prevent fresh or stale published candidates from routing while evidence or
  approval is pending.
- Burn-watch and slot-watch notifications remain configured when model-watch code is removed.

### Integration tests

- Catalog visible but resolver absent: record `blocked-unresolvable`, do not route.
- Resolver later exposes the same model: resume the existing transition without duplication.
- Known successor with official evidence: probe, probation, activate, and preserve rollback.
- Unknown role: create one issue and ntfy event, remain unrouted, approve, then continue.
- Rejected proposal remains excluded on later refreshes.
- Probe failure and two probation failures restore the prior model.
- Probe failure, probation failure, and timeout for a new role with no incumbent restore explicit
  unrouted state while preserving the approved role mapping.
- `/complete` plus `/usage` for one lease counts once; failures age out after 15 minutes; seven-day
  probation timeout restores the prior model.
- Gitea outage blocks approval-required transitions without blocking unrelated known successors.
- ntfy outage retains a bounded pending delivery and surfaces unhealthy status.
- Authentication changes mid-run abort atomically.
- Gateway probe nonce is loopback-only, single-use, short-lived, and cannot be requested or replayed
  by an ordinary external client.

### Migration and deployment tests

- A v1 reviewed ledger imports once and cannot recreate duplicate notifications.
- Existing broker state and static targets remain valid.
- The fleet sync deploys the reconciler unit, config, and approval skill through existing symlink
  conventions.
- `systemctl --user` shows the old timer disabled and exactly one reconciler timer active.
- A dry-run reconciliation reports the expected GPT-6 blocked state without mutating routing.
- Product tests use `node --test tests/*.mjs`; deployment checks run separately in `fleet-core`.

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
3. **Runtime promotion:** broker-owned `modelPolicy`, atomic incumbent seeding and governed-role holds,
   live inventory republication, control/status API, exact-target probe assignment, loopback gateway
   nonce, closed failure taxonomy, model-specific probation, selection precedence, and immediate
   rollback.
4. **Fleet cutover:** approval skill, fleet config, service/timer replacement, one-time reviewed-ledger
   migration/removal, live enablement, and deployment verification.

Each package receives its own implementation plan, tests, review, and commit boundary. Versioning and
release batching follow the fleet release rules rather than being implied by these package boundaries.
The next planning step after this design is approved is package 1 only. Later plans must re-read this
architecture and the verified output of the preceding package.

## Rollout

1. Complete packages 1 and 2 in dry-run mode and verify they cannot mutate routing.
2. Complete package 3, then enable policy mutation only after its runtime tests and review pass.
3. Complete package 4 and run one dry reconciliation before fleet cutover.
4. Verify GPT-6 Sol/Luna remain blocked until resolvable and existing routes remain unchanged.
5. Enable live reconciliation, migrate seen state once, and remove the old watch path.
6. Restart `opencode-model-broker.service` for broker-side changes. Existing TUI panes continue using
   code loaded at spawn and must be respawned where applicable.

The implementation spans two repositories in one coordinated release batch:

- `opencode/opencode-broker`: product logic, state/API/CLI, tests, and docs.
- `flan/devbox` (`/home/dev/fleet-core` compatibility path): config, systemd deployment, and approval
  skill.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Provider marketing language is ambiguous | Require constrained official evidence; contradictions become approval proposals |
| A provider changes naming conventions | Provider adapter fails closed and opens a new-role proposal |
| A new release is cataloged before OpenCode supports it | Preserve `blocked-unresolvable`; retry after resolver refresh |
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

## Accepted decisions

- Use a provider role registry and deterministic reconciler.
- Use provider-published comparisons instead of local quality benchmarking.
- Use operational probes and probation only for compatibility/reliability.
- Let an agent propose new roles; require Holden's approval.
- Use Gitea decision labels as the remote approval action.
- Provide a thin OpenCode skill over the same reconciliation contract.
- Keep ntfy for alerts while retiring the existing ad-hoc model notifications.
- Open one Gitea issue per unresolved proposal and close it through reconciliation.
- Cover all OAuth/subscription providers; keep API-key and local providers pinned.
