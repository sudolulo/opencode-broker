# Provider model reconciliation: Package 4 fleet cutover

Status: approved deployment specification
Date: 2026-10-01
Repositories: `/home/dev/opencode-broker` and `/home/dev/fleet-core` (the compatibility path resolves to `/home/dev/devbox`)

## Purpose and authority

This specification resolves the remaining deployment decisions in the approved umbrella
architecture at `docs/superpowers/specs/2026-09-28-provider-model-reconciliation-design.md`.
Package 4 is an in-place, staged fleet cutover that activates Package 3's dormant
reconciliation safely. It bootstraps immutable generation 0, migrates the legacy ledger,
retires the old model-watch schedule, enables live publication and mutation, and preserves
rollback and existing clients.

Package 4 does not alter the classifier-routing work in
`docs/superpowers/plans/2026-09-29-broker-native-classifier-routing.md`.

## Runtime contract

The reconciler owns these host paths:

| Purpose | Path |
| --- | --- |
| Version-controlled raw base | `/home/dev/devbox/config/opencode/opencode.json` |
| Managed overlay | `/home/dev/.local/share/opencode/model-routing/resolver-overlay.json` |
| Immutable generations | `/home/dev/.local/share/opencode/model-routing/resolver-generations` |
| Live generation link | `/home/dev/.local/share/opencode/model-routing/resolver-current` |
| Generation registry | `/home/dev/.local/share/opencode/model-routing/resolver-generations.json` |
| Reconciliation ledger | `/home/dev/.local/share/opencode/model-routing/model-reconciliation.json` |

Runtime directories are mode `0700`; runtime files are mode `0600`. Generation directories and
their contents are immutable after publication. The live link is switched atomically and points
only to a validated generation. `resolver-generations.json` is renderer-only: no writer or
policy mutator may update it. Its initialization records a monotonic high-water generation and
the exact manifest hash for every published generation. Updates are written to a temporary
0600 file, fsynced, and atomically renamed, with the parent directory fsynced. Rollback
preserves the registry and never lowers its high-water mark. After initialization, missing,
corrupt, non-monotonic, or manifest-hash-regressed registry state fails closed and blocks
publication, recovery, and mutation; it is not recreated from empty state.
Under the reconciliation lock, stale registry temporary files may be swept only after the final
registry and initialization acknowledgement validate exactly. Otherwise temporary and final files
are preserved for diagnosis and the operation blocks. A corrupt, partial, or wrong-schema final
registry is never replaced from empty.

## Ledger schemas

### `generationRegistryInitialized` (immutable bootstrap evidence)

This ledger record is immutable and written exactly once. It is created only once during generation-0
bootstrap. On later bootstrap attempts, an exact match of `registryHash`, `manifestHash`, `rawBaseHash`,
generation 0, and `sourceLedgerRevision` skips creation and validates successfully. Any mismatch,
deletion, downgrade, or stale CAS fails closed. Never overwrite, delete, or downgrade it.

```
{
  "schemaVersion": 1,
  "generation": 0,
  "registryHash": "<sha256 of exact resolver-generations.json bytes>",
  "manifestHash": "<sha256 of exact generation-0 manifest.json bytes>",
  "rawBaseHash": "<sha256 of exact canonical raw-base bytes>",
  "sourceLedgerRevision": <non-negative integer>,
  "initializedAt": "<UTC ISO-8601>"
}
```

- `registryHash` is lowercase 64-hex SHA-256 of the exact resolver-generations.json bytes.
- `manifestHash` is lowercase 64-hex SHA-256 of the exact generation-0 manifest.json bytes.
- `rawBaseHash` is lowercase 64-hex SHA-256 of the exact canonical raw-base bytes.
- `sourceLedgerRevision` is a non-negative integer supplied by the enclosing ledger mutation
  acknowledgement (no self-referential hash/revision).
- `initializedAt` is UTC ISO-8601 timestamp.

### `configCutover` (mutable audited config link control)

This ledger record controls the outer config link and is mutable for cutover/rollback.

```
{
  "schemaVersion": 1,
  "mode": "generated" | "raw-emergency",
  "target": "<exact approved absolute target>",
  "generation": 0 | <non-negative integer> | null,
  "manifestHash": "<64-hex>" | null,
  "registryHash": "<64-hex>",
  "rawBaseHash": "<64-hex>",
  "sourceLedgerRevision": <non-negative integer>,
  "changedAt": "<UTC ISO-8601>",
  "reason": "bootstrap" | "provider-stage" | "emergency-rollback" | "reactivation"
}
```

- `mode` is `generated` for normal operation or `raw-emergency` for rollback.
- `target` is the exact approved absolute target:
  - Generated mode: `/home/dev/.local/share/opencode/model-routing/resolver-current/opencode.json`
   - Raw-emergency mode: `/home/dev/devbox/config/opencode/opencode.json`
- `generation` is `0` for bootstrap, a non-negative integer for provider stages, or `null` for
  raw-emergency.
- `manifestHash` is lowercase 64-hex SHA-256 or `null` for raw-emergency.
- `registryHash` and `rawBaseHash` are lowercase 64-hex SHA-256.
- `sourceLedgerRevision` is a non-negative integer supplied by the enclosing ledger mutation
  acknowledgement (no self-referential hash/revision).
- `changedAt` is UTC ISO-8601 timestamp.
- `reason` describes the cutover trigger.

The CURRENT pre-cutover deployed chain is:
`/home/dev/.config/opencode/opencode.json` -> `/home/dev/fleet-core/config/opencode/opencode.json`
-> `/home/dev/devbox/config/opencode/opencode.json` (raw base, version-controlled generation-0 source).
The verified deployment fact required before cutover is that `/home/dev/fleet-core` is a
compatibility symlink to `/home/dev/devbox`. Package 4 does not create or repair that symlink.
The outer config link resolves through `/home/dev/fleet-core/config/opencode/opencode.json` to
the regular mode-0600 file `/home/dev/devbox/config/opencode/opencode.json`.

Normal Package 4 cutover must:
1. Build generation 0 from `/home/dev/devbox/config/opencode/opencode.json` (raw base)
2. Point `/home/dev/.local/share/opencode/model-routing/resolver-current` atomically to the immutable generation 0 directory
3. Atomically retarget `/home/dev/.config/opencode/opencode.json` to `/home/dev/.local/share/opencode/model-routing/resolver-current/opencode.json`

The two symlink swaps cannot be jointly atomic. Apply remains disabled throughout the entire
cutover window. After `resolver-current` switches to generation 0 and before the outer config
link retargets, a newly starting process may load the canonical raw base through the existing
outer link and register legacy/base-only eligibility. This is explicitly safe because generation
0 is byte-derived only from that same raw base, and the process cannot receive overlay-only
models. The outer-link retarget must immediately follow under the same reconciliation lock;
completion requires verification that its exact target is
`/home/dev/.local/share/opencode/model-routing/resolver-current/opencode.json`.

Recovery must use the persisted `configCutover` evidence to detect this intermediate state:
when `resolver-current` points to the exact validated generation 0 but the outer link still
resolves through the pre-cutover chain, recovery may complete the outer-link retarget under the
reconciliation lock and then verify the exact generated target. Any other link, ledger, hash, or
acknowledgement mismatch blocks recovery and mutation.

New OpenCode processes load the generated `opencode.json` through the deployed symlink; the router plugin resolves `resolver-current` once and registers its matching manifest. Existing TUIs keep their startup-captured config/generation and are not killed.

Fleet-core/devbox-sync owns routine convergence of `/home/dev/.config/opencode/opencode.json` but never changes ledger state. Its recovery decision tree is explicit: unreadable, corrupt, or schema-invalid `generationRegistryInitialized` or `configCutover` makes the verifier exit nonzero, leaves the outer link unchanged, and emits a durable alert. Generated mode requires a readable current link, the exact generation directory, config, manifest, hashes, and registry; any missing or mismatched item blocks with no link change. Raw-emergency mode hashes the exact canonical devbox raw target first, and only after that match preserves or recreates the outer link to that exact target. Pre-bootstrap raw linking is allowed only when both ledger records and all generation artifacts are absent. No mode or target is inferred from filesystem presence.

Before cutover, Step 0 verifies the compatibility topology and records the raw base hash. Exact link
resolution must be `/home/dev/fleet-core` -> `/home/dev/devbox`, the outer config link must resolve
through `/home/dev/fleet-core/config/opencode/opencode.json`, and the final real file must be
`/home/dev/devbox/config/opencode/opencode.json`, a regular mode-0600 file. Any mismatch stops
before bootstrap. The raw-emergency `configCutover.target` is the canonical direct
`/home/dev/devbox/config/opencode/opencode.json`, removing rollback dependence on the compatibility
symlink. Validation reads `configCutover.mode` and `target`, requires the target string to exactly
equal the mode-specific absolute path without canonicalizing before comparison, and then resolves
and reads the target contents for hash checks.

Valid `configCutover` states are only:

- `generated`: generation is non-negative, `manifestHash` is non-null, and both ledger records are
  readable and matching.
- `raw-emergency`: generation and `manifestHash` are null, the initialization acknowledgement is
  readable and matching, and raw/registry hashes are retained.

All other combinations are invalid. Required generated commit evidence is: prepared intent/evidence;
registry and published-manifest verification; ledger generation acknowledgement; broker CAS
acknowledgement when policy changes; final ledger acknowledgement; `configCutover` CAS
acknowledgement; and outer-link target verification. Missing or mismatched evidence blocks mutation
and recovery. The sole writer of `configCutover` is `opencode-broker-reconcile`.

### Generation 0 and apply policy

Generation 0 contains **only** the version-controlled raw base. It excludes the managed overlay
and mutable Package 3 policy. Its manifest records the exact raw-base revision and a pinned
SHA-256 base hash; construction verifies that hash before publication and fails closed on any
mismatch. Generation 0 is built and validated before any live switch.

Generation 0's manifest may contain every resolver key present in the raw base, including Alibaba
keys not present in the four governed mappings. Manifest presence does not confer routing
eligibility. Base-only and legacy eligibility remains limited to the existing configured static
target IDs. Unknown Alibaba siblings, including `qwen3.7-max`, `qwen3.7-plus`, and
`deepseek-v4-flash-0731`, remain unrouted and blocked and cannot become active without a separately
reviewed exact role/evidence change. No raw resolver-only key may become routable solely because it
appears in generation 0's manifest.

The validated configuration contains `reconcile.apply.providers`.

```
"reconcile": { "apply": { "enabled": false, "providers": ["openai"] } }
```

- `providers` is always a duplicate-free array if present. When `enabled=false`, it may be absent, empty, or contain valid trusted provider IDs. When `enabled=true`, it is required and nonempty. Every present value is still syntax-validated and must be an exact `trustedSubscriptionProviders` member.
- Unknown/untrusted/malformed/duplicate values fail startup validation, never silently ignore.
- Initial disabled deployment may contain `["openai"]` while enabled=false.

## Provider expansion sequence

Define each provider expansion sequence explicitly: stop/await new timer service; edit fleet config to append exactly one provider; sync config; restart broker and gateway; run prepare/commit/manual canary with zero scheduled writers; re-enable timer only after success; persist and observe the 24-hour gate. Do not deploy all three allowlist entries at once. The fleet-core script `/home/dev/fleet-core/bin/opencode-model-provider-stage`, with real path `/home/dev/devbox/bin/opencode-model-provider-stage`, is the provider-expansion lock acquirer and orchestrator. It uses kernel `flock -w 5` on the mode-0600 `/home/dev/.local/share/opencode/model-routing/provider-expansion.lock`, holds the file descriptor from config validation through manual canary, and relies on process exit for release. Never manually delete the lock file: a persistent inode is harmless, and ownership is determined by the kernel, not mtime. Acquisition timeout exits nonzero and alerts. Existing persisted provider gate state blocks the next provider while a gate is pending or failed; the gate must be healthy or rolled back before another provider stage begins. Add test/acceptance coverage.

## Verified two-phase apply

Initial cutover and every provider expansion use Package 3's existing saga and its single
authority; Package 4 does not introduce a second apply or rollback authority.

**Prepare** runs with mutation disabled. It acquires the reconciliation lock, stages and
validates the provider allowlist, ledger revision, exact overlay/effective/base hashes,
generation manifest, and policy intent, then persists the complete evidence record without
switching live policy. Missing or inconsistent evidence aborts prepare.

**Commit** quiesces the scheduled writer, confirms that it is stopped, holds the reconciliation
lock, and uses the existing CAS sequence to publish the prepared generation. It records the
generation acknowledgement, broker policy acknowledgement, and final ledger acknowledgement.
On crash or restart, recovery is permitted only after exact persisted hashes, revisions, and all
required acknowledgements verify; any mismatch blocks recovery and mutation.

During manual commit and canary there are zero scheduled writers after the old watch is
quiesced. Dry-run coexistence with the old watch is allowed. Only after manual canary success
may the new timer be enabled; the operator then verifies exactly one mutation-capable schedule.

## Fleet scheduling and compatibility

Fleet-core installs `opencode-model-reconcile.service`, a oneshot service invoked through
`job-run`, and `opencode-model-reconcile.timer`, daily, `Persistent=true`, with a randomized
delay of no more than one hour. `watch.notifyCommand` remains configured for burn-watch and
slot-watch fallback; removing model-watch must not remove that compatibility behavior.

The approval skill source is `/home/dev/devbox/config/opencode/skills/model-reconciliation-approval/SKILL.md`.
Its compatibility path is `/home/dev/fleet-core/config/opencode/skills/model-reconciliation-approval/SKILL.md`,
and the existing devbox-sync skills-directory symlink deploys it. Approval-skill preflight must
verify that the source, compatibility, and deployed paths all exist, are readable, resolve to the
same regular source file, and have matching SHA-256 bytes. A broken, missing, or mismatched path
stops cutover. Devbox-sync repairs the skills symlink before retrying preflight, never during the
cutover transaction. No duplicate units.toml entry.

## Provider stages and Alibaba prerequisites

Provider ID `alibaba-token-plan` is stage 3. Its admission is exact-key only and preserves the
current deployed policy; no sibling, family, prefix, or inferred tier is permitted:

| Exact model | Role | Tier(s) |
| --- | --- | --- |
| `qwen3.8-max` | Qwen Max | `deep` |
| `qwen3.6-flash` | Qwen Flash | `worker` |
| `deepseek-v4-pro` | DeepSeek Pro | `build`, `review` |
| `glm-5.2` | GLM | `build`, `review` |

The resolver must succeed on every exact key, and each admitted model must pass complete
capabilities, context, and effort checks plus trusted-provider admission. Official evidence must
identify the exact model ID on `help.aliyun.com` or `www.alibabacloud.com`; absent or conflicting
evidence blocks admission. A `qwen` prefix never authorizes an unknown sibling or tier.

## Legacy watch and ledger migration

At cutover, record `baselineCount=B` and `baselineHash`; the current observed deployment evidence
is `B=83`, not an invariant. Stop and disable the old timer and await its active service exit.
Read the final legacy source, compute delta `D`, and idempotently import the complete `B + D` key
set. Verify exact key equality and zero duplicate transitions or notifications, then record the
`finalCount=B+D`, final hash, and revision.

Archive a read-only **copy** for seven days while preserving/restoring a writable legacy ledger
at its old path for rollback. Before re-enabling the old watch, verify the writable ledger's hash,
mode, and revision. After seven days, `legacyQuiescedAt` is recorded only after old timer is
disabled and old service exit is confirmed. Cleanup after seven calendar days additionally requires
exactly one healthy new schedule, no outstanding recovery/rollback/alerts, verified archive hash,
and all provider stages that have begun either healthy or rolled back. Then manually remove the
copy/old executable once.

## Exact cutover sequence

The operator performs these stages in order; a failed validation stops progression:

0. Verify `/home/dev/fleet-core` resolves exactly to `/home/dev/devbox`, the outer config link resolves
   exactly through `/home/dev/fleet-core/config/opencode/opencode.json`, and the final real file is the
   regular mode-0600 `/home/dev/devbox/config/opencode/opencode.json`; record the rawBaseHash. Any
   mismatch stops before bootstrap. Verify the approval-skill source, compatibility, and deployed
   paths all exist, are readable, resolve to the same regular source file, and have matching
   SHA-256 bytes. Any mismatch stops before cutover; devbox-sync must repair the skills symlink
   before retrying, never during the cutover transaction.
1. Deploy product and fleet changes with apply disabled.
2. Build generation 0 from `/home/dev/devbox/config/opencode/opencode.json` (raw base); pin and verify its base hash,
    initialize the renderer-only registry and persist the `generationRegistryInitialized`
    acknowledgement, then validate without switching `resolver-current`. Step 6 performs the first
    normal `resolver-current` switch. If crash recovery finds it already points to the exact validated
    generation-0 manifest, skip replacement idempotently and continue outer-link retargeting; any other
    target/hash blocks.
3. After generation-0 validation and before old-watch quiescence, run one complete manual
   `--dry-run`. The new timer is disabled; the old watch may coexist per the umbrella design, and
   final-delta import captures any concurrent old-watch change. Dry-run must exit 0 and must not
   mutate prohibited live paths or publishers; allowed ledger observations remain permitted by the
   umbrella architecture. Verify prohibited bytes and mtimes are unchanged and publisher calls are zero.
4. Execute verified prepare, then stop and disable the old timer and await service exit.
5. Perform the final delta import and preserve the writable legacy ledger plus its read-only copy.
6. Execute verified commit with apply still disabled throughout the cutover window, atomically switch
   `resolver-current` to generation 0 directory, then immediately and under the same reconciliation
   lock atomically retarget `/home/dev/.config/opencode/opencode.json` to `resolver-current/opencode.json`.
   The swaps are not jointly atomic: a process starting between them may load the canonical raw base,
   register only legacy/base-only eligibility, and cannot receive overlay-only models. Record all saga
   acknowledgements and require the exact generated outer target before completing cutover.
7. Restart broker and gateway without killing existing TUIs.
8. Enable OpenAI apply, perform manual prepare and commit, and run the manual canary with zero
   scheduled writers.
9. Verify probes, generation compatibility, policy state, probation behavior, rollback, and
   singleton checks.
10. Enable exactly one new reconciliation timer only after canary success; verify exactly one
    mutation-capable schedule, one socket owner, and one publisher.
11. For each expansion, complete the provider gate, review the allowlist change, then repeat
    prepare, commit, canary, and singleton verification before enabling that provider.

Existing clients continue using the generation or legacy base captured at startup. Existing TUIs
are not killed, and no simultaneous policy-era publishers are permitted.

## Provider health gate

For each provider, the gate starts at successful manual prepare and commit and ends only after
all of the following are persisted with start time, end time, and evidence references:

- at least 24 elapsed hours;
- at least one successful scheduled daily run after commit;
- all exact-model probes, singleton schedule/socket/publisher checks, policy/probation checks,
  and rollback-status checks pass;
- no unresolved alert, recovery, corruption, or rollback remains.

Any failure resets that provider's gate and requires a new manual prepare and commit. Alibaba
must itself complete 24 healthy hours before Package 4 is operationally complete. A full dry-run
cycle must complete before the old watch is retired.

## Failure rollback

If quiescence cannot be confirmed, abort rollback without publishing another generation and alert
loudly.

Normal rollback atomically switches `resolver-current` to the immutable generation 0 directory
while leaving the deployed config link through `resolver-current/opencode.json` intact. This
restores the pre-cutover state where new OpenCode processes load generation 0 through the
deployed symlink.

Raw-base emergency rollback: if generation 0 is verified unusable (corrupt, missing, or hash
mismatch), the reconciler's audited rollback first CAS-writes `configCutover.mode=raw-emergency`
while retaining registry/generations/init ack for diagnosis, then atomically retargets the outer link
to the exact raw target. This requires existing `configCutover.mode=generated` with exact current
generation, `manifestHash`, `registryHash`, `rawBaseHash`, and `sourceLedgerRevision`. A stale/mismatched
record aborts rollback and alerts. The CAS writes raw-emergency target/reason while preserving all
retained hashes/artifacts.

For provider expansion failure after OpenAI/Anthropic success: restore the pre-stage known-good
checkpoint (generation and manifest hash, allowlist, ledger revision, and broker policy revision),
remove only the failed provider, and keep the new scheduler and earlier healthy providers.
Generation 0 and the old watch are reserved for global integrity failure.

Every rollback is loud, durable, and auditable. It never silently resets state, runs simultaneous
publishers, exposes a secret, or replaces corrupt state with empty state.

## Repository responsibilities and version selection

`/home/dev/opencode-broker` owns provider allowlist filtering and validation, all apply entry
points (including refresh, recover, and scheduled paths), bootstrap and migration commands,
product tests, documentation, version metadata, and changelog entries. The broker reconcile command
is sole transition writer.

`/home/dev/fleet-core` (resolved by deployment to `/home/dev/devbox`) owns live configuration,
systemd units and timer, the approval skill, deployment checks, fleet release wiring, and the
`opencode-model-provider-stage` orchestration script. Fleet-core/devbox-sync owns convergence and
must follow verified `configCutover` mode. The broker transition writer, devbox-sync convergence,
and provider-stage script orchestration are distinct responsibilities; none may independently
infer or override another's state.

The repositories ship as one coordinated Package 4 release batch. The version-controlled raw
base is exactly `/home/dev/devbox/config/opencode/opencode.json`; no deferred raw-base selection is
permitted.

## Test ownership table

| Contract | Repo | Harness | Dependencies |
| --- | --- | --- | --- |
| broker unit: schemas/config/registry/roles | `/home/dev/opencode-broker` | unit tests | schemas, config |
| broker integration: prepare/commit/recovery/migration/eligibility/probes | `/home/dev/opencode-broker` | integration tests | saga, ledger |
| fleet-core deployment tests: devbox-sync outer-link modes, unit/timer singleton, skill deployment | `/home/dev/fleet-core` | deployment tests | systemd, timer, skill |
| live cutover checks: services/PIDs/socket/API/schedule/TUI continuity/24h evidence | `/home/dev/opencode-broker` | live tests | broker, gateway |

Duplicate projection is repeated stable transition/projection ID or repeated external delivery marker across idempotent replay. TUI continuity evidence is representative pre-cutover PID/start-time survival plus acceptance of its captured generation token and exclusion from newer model keys.

## Quantified completion criteria

Operational completion requires evidence of all of the following:

- exactly one live link targets a validated immutable generation; generation 0 remains available
  as the deterministic global rollback target, and the registry remains monotonic and intact;
- the authoritative ledger contains a durable `generationRegistryInitialized` acknowledgement for
  generation 0 with the registry hash, generation-0 manifest hash, raw-base hash, and ledger
  revision; no partial or regressed registry/artifact state is initialized from empty;
- the `configCutover` ledger record is present with `mode=generated` and `target=/home/dev/.local/share/opencode/model-routing/resolver-current/opencode.json` in generated mode, or `mode=raw-emergency` and `target=/home/dev/devbox/config/opencode/opencode.json` in raw-emergency mode;
- new OpenCode processes resolve the generated config through `/home/dev/.config/opencode/opencode.json` -> `resolver-current/opencode.json`; the router plugin resolves `resolver-current` once and registers its matching manifest;
- existing TUIs retain their startup-captured config generation and are not killed; future fleet sync preserves the deployed runtime symlink;
- every listed runtime directory is `0700` and every listed runtime file is `0600`;
- apply is disabled during bootstrap, prepare, and dry-run; dry-run records zero publisher calls
  and no prohibited byte or mtime changes;
- the recorded baseline `B` (with current observed deployment evidence `B=83`) plus final delta
  `D` produces one exact import with zero duplicate transitions or notifications, a final
  count/hash/revision, and a read-only seven-day copy; acceptance uses recorded `B`, never a
  hardcoded 83;
- after canary there are zero scheduled writers during manual commit, then exactly one
  mutation-capable schedule, one active publisher, one API publication path, and one live socket;
- OpenAI and Anthropic each pass a persisted healthy 24-hour gate before the next expansion,
  and Alibaba passes its own persisted healthy 24-hour gate before operational completion;
- all exact Alibaba mappings and official evidence checks pass, with no unknown model admitted;
- all broker, gateway, npm, fleet, deployment, and release checks pass with captured output, and
  a complete dry-run cycle precedes old-watch retirement;
- rollback drills prove global restoration and provider-scoped checkpoint restoration without
  killing existing TUIs, losing ledger entries, exposing secrets, or publishing while quiescence
  is unconfirmed;
- fleet-core/devbox-sync idempotent deployment rule preserves the runtime deployed symlink on
  subsequent syncs and retains `/home/dev/devbox/config/opencode/opencode.json` as the raw base;
- `/home/dev/devbox` remains the single registered unit source in `/home/dev/fleet-core/units.toml`,
  with old and new units delivered through `/home/dev/devbox/systemd`; before cutover sync maintains
  the raw-base chain, and after atomic cutover it validates the exact runtime target and preserves or
  recreates only `/home/dev/.local/share/opencode/model-routing/resolver-current/opencode.json`;
- devbox-sync fails loudly rather than relinking raw base when initialization evidence exists but
  the deployed link or validation is wrong, while normal raw-base linking remains valid without
  initialization evidence; devbox-sync never relinks to fleet-core raw config unless a verified
  `raw-emergency` record authorizes it;
- generation-0 manifests may contain all raw-base resolver keys, but only existing configured static
  target IDs are eligible; raw resolver-only keys and unknown Alibaba siblings cannot become routable
  without a separately reviewed exact role/evidence change;
- acceptance requires bootstrap to succeed only from an entirely absent/empty initial artifact set,
  to persist and later validate the four acknowledgement values, and to reject every partial,
  mismatched, or regressed state without empty-state initialization;
- acceptance requires raw-base resolver-only keys to remain unrouted regardless of manifest presence,
  including the named unknown Alibaba siblings, until a separately reviewed exact role/evidence
  change makes one eligible;
- raw-base emergency restoration from `/home/dev/devbox/config/opencode/opencode.json` is verified
  and auditable with hash checks, integrity confirmation, and logged evidence;
- new OpenCode processes successfully resolve the generated config through the deployed symlink
  and the router plugin registers the matching manifest from `resolver-current`;
- future fleet sync preserves the deployed runtime symlink and does not replace it with raw base;
- normal generation swaps affect only future processes; existing TUIs retain their startup-captured
  config generation;
- acceptance covers a process started after the `resolver-current` generation-0 switch but before
  the outer-link retarget: it may load the canonical raw base and register legacy/base-only
  eligibility, must not receive overlay-only models, and recovery must then complete and verify the
  exact generated outer target from `configCutover` evidence under the reconciliation lock;
- approval-skill preflight rejects any missing, unreadable, non-regular, unresolved, or SHA-256
  mismatched source, compatibility, or deployed path, and cutover proceeds only after devbox-sync
  repairs the skills symlink outside the cutover transaction and a subsequent preflight passes.

Rollback acceptance requires restoration within one operator run, zero concurrent
mutation-capable schedules, no lost durable ledger entries, no secret exposure, and old clients
remaining eligible for their captured model generation.

## Explicit non-goals

- Killing existing TUIs.
- Running simultaneous policy-era publishers.
- Recurring cleanup of the legacy watch or ledger.
- Unrelated classifier-routing changes.
- Automatic provider expansion by time.
- Deleting the legacy executable or ledger before seven days.
- Inventing credential storage or bypassing the existing gateway and approval controls.
