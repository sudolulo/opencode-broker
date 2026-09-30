# On-disk state contract

Everything lives under `~/.local/share/opencode/model-routing/` (0700; files
0600, written atomically via rename). This inventory is the complete list —
if a file is not here, the router does not own it.

| Path | Writer | Readers | Content |
|---|---|---|---|
| `broker.sock` | broker | plugins, gateway, opencode-guard, CLIs | The API socket ([API.md](API.md)) |
| `broker.json` | broker | broker | Leases, assignments, circuits, cursors, inventory, health, budget ledger |
| `pending-profile.json` | hud | router plugin | A profile armed for the NEXT root session `{ profile, updatedAt }`; consumed when that session is created, ignored after 30 min. (A `profile.json` left by an older build is deleted, never read.) |
| `profiles/<sessionID>.json` | router plugin, hud | plugins, opencode-guard | Per-session profile `{ profile, explicit, updatedAt }`; pruned after 14 days |
| `context-estimates/<sessionID>.json` | router plugin | router plugin | Last known context tokens `{ tokens, updatedAt }`; seeds resumed sessions without a full history fetch; 14-day prune |
| `managed-switches/<sessionID>.json` | router plugin, hud | hud | Short-lived marker (5 min) distinguishing router-driven model switches from the user's own |
| `pending-forgets/<sessionID>.json` | router plugin | router plugin | Queued `/forget` calls to retry when the broker was unreachable; 14-day prune |
| `decisions.jsonl` | broker | operator, tooling | Every routing decision — grants, revalidations, refusals, failures, and burn-watch stops (`policy: "burn-stop"`), with the gateway's `caller` on a gateway session's lines (bounded 4MB, truncating) |
| `usage.jsonl` (+ `usage.jsonl.1`) | broker | `opencode-broker usage`, operator | One line per provider request: session, model, the lease's target/profile/tier, `prompt` (input + cache read + cache write), that total split into `input`, `cacheRead` and `cacheWrite` (always present, zeroes included, so a burn-watch stop can be audited afterwards), `output` tokens, and for gateway requests the `caller` (client address and requested model). For tuning local windows, because opencode deletes child sessions and their token history. Rotated at 8MB, one previous generation kept |
| `fallbacks/<sessionID>.json` | router plugin | hud, router plugin | Fallback/displacement marker; `policy: "provider-displaced"` carries `restoreAt` -- stickiness is released once it passes, and a healthy lease clears every other kind |
| `reviewed-models.json` | opencode-broker-watch | opencode-broker-watch | Catalog model ids already seen/assessed, so each new model notifies exactly once. `opencode-broker-reconcile` READS it and reports which keys a future import would cover; the import itself, and the deletion of this file, belong to a later package |
| `model-reconciliation.json` | `opencode-broker-reconcile`, `opencode-broker-evidence` | `opencode-broker-reconcile`, `opencode-broker-evidence`, operator tooling | Versioned provider-role candidate observations, the evidence request queue, and proposal presentation state. Those two commands are its ONLY writers; see the field inventory below |
| `.model-reconciliation.lock/` | `opencode-broker-reconcile`, `opencode-broker-evidence` | `opencode-broker-reconcile`, `opencode-broker-evidence` | The ephemeral lock serializing every reconciliation-ledger mutation. Holds an `owner` identity record and an `instance.<pid>.<uuid>` file; see the protocol below. Removed when the writer exits |
| `.model-reconciliation.lock.<pid>.<uuid>/` | `opencode-broker-reconcile`, `opencode-broker-evidence` | same | A lock directory being built, before publication. Exists only between its mkdir and the rename that publishes it; a writer killed in that window leaves one behind, and the next writer to hold the public lock sweeps it — only on proof the identity inside is dead |
| `resolver-overlay.json` | reconciliation applier | generation renderer, reconciliation status tooling | Versioned append-only materialized view of ledger-authorized resolver models; see the schema and ownership contract below |
| `.resolver-overlay.lock/` | reconciliation applier | reconciliation applier | Ephemeral inter-process lock covering overlay disk read, hash/revision CAS, replay detection, atomic replacement, and parent-directory fsync. The directory is 0700 and its complete `owner` and `instance.<pid>.<uuid>` records are 0600 before publication |
| `<generationsRoot>/resolver-generations.json` | generation renderer | broker, plugin registration, reconciliation tooling | Versioned registry of immutable generation manifest/effective hashes and the monotonic generation high-water mark |
| `<generationsRoot>/generation-N/` | generation renderer | OpenCode resolver processes, broker, reconciliation tooling | Immutable mode-0700 generation bundle containing mode-0600 `opencode.json` and `manifest.json` |
| `<generationsRoot>/current` | generation renderer | OpenCode startup, router plugin | Relative symlink atomically replaced only after the complete bundle and registry entry validate |
| `<generationsRoot>/.resolver-generations.lock/` | generation renderer | generation renderer | Ephemeral private inter-process lock serializing generation reservation, rendering, registry publication, current-link replacement, and cleanup |

## Inside `model-reconciliation.json`

Schema version `1`. The top-level keys are exactly `version`, `updatedAt`, `roles`,
`unknown` and `evidenceRequests`; an unknown key or a different version is a
newer writer's file and is refused rather than round-tripped. `roles` is keyed by
`providerID:roleID`, `unknown` by the candidate's `transitionID`.

`evidenceRequests` is the bounded queue, keyed by `transitionID`:

| Field | Writer | Content |
|---|---|---|
| `status` | `opencode-broker-reconcile dry-run`, `opencode-broker-evidence` | `pending`, `claimed` or `failed`. A claim is a 30-minute lease; an expired one returns to `pending` |
| `kind`, `roleKey`, `roleID`, `providerID`, `candidateModelID`, `incumbentModelID` | `opencode-broker-reconcile dry-run` | The identity a payload has to match exactly before any of it is stored |
| `candidateRevision` | `opencode-broker-reconcile dry-run` | The candidate the request was raised for; evidence collected against a different one is refused |
| `attempts`, `claimedAt`, `claimedBy`, `retryAfter`, `lastError` | `opencode-broker-evidence` | Collection bookkeeping. A failure sets a 24-hour `retryAfter` |
| `enqueuedAt`, `updatedAt` | both | Queue order and last change |

Per-record fields the proposal lifecycle writes. Everything else on a record is
observation, written by `dry-run`:

| Field | Writer | Content |
|---|---|---|
| `evidence[]` | `opencode-broker-evidence` | Accepted official claims: `claimType`, `sourceURL`, `exactQuote`, `retrievedAt`, `contentHash`, and `policy` -- whether the claim may drive automation at all |
| `evidenceRevision`, `evidenceCollectedAt` | `opencode-broker-evidence` | Which candidate the evidence was collected against, and when. A mismatch with the record's current candidate drops the evidence rather than reinterpreting it |
| `evidenceContradiction` | `opencode-broker-evidence` | Continuity and discontinuity claims were both accepted; the record waits for a human |
| `proposedTiers` | `opencode-broker-reconcile dry-run`, `amend` | The tiers an approval would apply. `dry-run` takes them from the role registry; `amend` replaces them, and supplies them for an unknown candidate that has none |
| `approval` | `opencode-broker-reconcile project`, `approve`, `reject` | `{ decision, source, at, note }`. `source` is `gitea-label` or `cli`. Its presence is what makes a record decided, and a decided record is never reclassified or re-observed |
| `issue` | `opencode-broker-reconcile project` | The open Gitea issue: `number`, `url`, `revision`, and the `createdAt`/`commentedAt`/`reopenedAt`/`reopenCommentedAt`/`refusedAt`/`closedAt` markers each external write is deduped by. `reopenedAt` is stamped the moment the forge confirms the reopen and `reopenCommentedAt` only when the instructional comment lands, so a failed comment is retried without a second reopen. The whole pointer is cleared if the issue is found deleted (a 404), and the proposal is projected again |
| `supersededIssue` | `opencode-broker-reconcile project`, `approve`, `reject` | An issue pointer moved off a proposal that is no longer the one being asked about, carrying `supersededAt` and (for a local decision) `reason`. The next `project` run comments and closes it, then clears the pointer |
| `notified` | `opencode-broker-reconcile project` | One entry per announced event, keyed `event\|transitionID\|timestamp`, holding `{ at, attempts, lastError, firstAttemptAt }`. `at` stays null until the notifier exits 0 |
| `supersededAt` | `opencode-broker-reconcile dry-run` | When this proposal was retired. Stamped on the record because a role record drops back to `evidence-pending` afterwards, so current state alone cannot tell |

Nothing here is routing state. No field in this file makes a model eligible, and
the broker never reads it.

## Inside `resolver-overlay.json`

Schema version `1`. The top-level fields are exactly `version`, `revision`,
`updatedAt`, and `entries`. The reconciliation applier is the sole writer. It writes
the file synchronously as a mode-0600 sibling temp with one trailing newline, fsyncs
the temp, renames it over the overlay, and fsyncs the mode-0700 parent directory.
The lock remains held from the disk read through canonical-hash and revision CAS,
same-intent replay detection, replacement, and fsync, so two processes starting from
one revision cannot overwrite each other.

Entries are keyed by exact `providerID/modelID` and contain `transitionID`, canonical
proposal `revision`, `authorizationKind` (`auto-eligible` or `approved`),
`providerID`, `modelID`, `roleKey`, `authorizationHash`, the first positive
`introductionGeneration`, and allowlisted resolver `model` metadata. The only cost
object permitted is numeric zero for `input`, `output`, `cache_read`, and
`cache_write`. Entries are append-only: a later generation may add a model but may
not remove or alter any historical entry, including its first introduction
generation. `updatedAt` comes from the durable apply intent rather than the wall
clock used during recovery, making a commit-before-ack replay byte-identical and
non-writing.

The overlay contains no credentials, API keys, bearer values, token paths,
environment values, or `baseURL`. Validation cross-checks each entry's exact
transition, proposal revision, provider/model/role identity, and evidence-or-decision
authorization hash against the reconciliation ledger and role registry. Unknown
versions or fields, corrupt JSON, orphaned entries, changed history, nonzero cost,
and stale hash/revision CAS fail loudly without replacing the existing bytes.

## Inside resolver generations

`resolver-generations.json` has schema version `1` and exactly `version`, `highWater`,
and `generations`. Each generation record contains `manifestHash`, `effectiveHash`,
and `createdAt`. The high-water mark never decreases, including when cleanup removes
an old registry entry. A missing or corrupt registry, an unknown version, or a
generation above its high-water mark fails loudly; state is not reconstructed from
directory names.

Each `generation-N` directory is published only after its mode-0600
`opencode.json` and `manifest.json` have been fsynced together in a sibling mode-0700
temporary directory. The manifest records version, generation, exact base-byte hash,
canonical resolver-overlay hash, canonical effective-config hash, exact sorted model
keys returned by a fresh `opencode models --pure` run in an isolated scratch
`XDG_CONFIG_HOME`, creation time, and sorted authorizing ledger revisions. Overlay
models may only be added beneath an existing provider, may not collide with base
models, and retain Task 2's zero-cost and no-credential/`baseURL` constraints.

Publication independently re-verifies the canonical directory, both regular files,
the exact manifest-byte hash, and the canonical effective-config hash before first
atomically replacing the private registry and then atomically replacing `current`
with a relative sibling symlink. A crash before registry publication leaves the old
link current and permits only an exact-intent orphan recovery; a crash after registry
publication is completed by replaying the link replacement. Generation 0 is a
base-only bootstrap accepted only with an empty registry, no current link, and an
empty overlay. It can later be republished for rollback and is never cleaned.

Cleanup always retains generation 0, `current`, and generations named by active
process registrations. It removes unreferenced generation directories only after 30
days by default, removes their registry entries without lowering `highWater`, and
sweeps renderer temp directories. Generation lookup accepts only a number, derives
the registry-owned `generation-N` path, rejects directory or file symlinks and path
escape, and rechecks exact manifest/effective hashes. Unknown or cleaned generations
are reported rather than recreated. A render that would remove an active, probation,
or rollback model reference fails unless the same exact role/kind/model reference is
present in the authorized retirement set.

## The reconciliation ledger lock

The lock is **published by renaming** a fully built private
`.model-reconciliation.lock.<pid>.<uuid>` directory onto `.model-reconciliation.lock`,
not by mkdir. A rename onto an *empty* directory succeeds; onto a *populated* one it
fails and moves nothing. So the `instance.<pid>.<uuid>` file inside the lock is what
makes the lock held, and the complete `owner` record is already inside the directory
the instant it becomes visible — there is no window in which a live holder looks
ownerless and can be stolen.

`owner` stays readable by older builds: `pid` and `acquiredAt` still mean what they
did, alongside `uuid`, the Linux `bootId` and the `/proc/<pid>/stat` `starttime` when
those are readable. A contender is reclaimed **only on proof it is dead** — `ESRCH`
from `kill(pid, 0)`, a boot id that is not this boot, or a start time that does not
match the record — and the reclaim is a single unlink of that *exact* observed
instance file. `ENOENT` there means another actor already won, and nothing else is
touched. `.model-reconciliation.lock` itself is never deleted recursively: removing the
entries an identity owns is what frees it, and the empty directory left behind is what
the next rename takes over. An unreadable pid, `EPERM`, a missing `/proc` field or any
other error reads as live, because a stolen lock means two writers in one
read-modify-write and a lost decision.

An empty `.model-reconciliation.lock` carries no identity, so nobody can be holding it:
it is taken over immediately, by rename, deleting nothing. The ledger's own write is
committed by the rename of its temp: a durability `fsync` that fails *after* that point
is reported as a warning, never as a failed mutation.

A private `.model-reconciliation.lock.<pid>.<uuid>` that fails *while being built* —
after its `mkdir`, before its records exist — removes itself before the failure is
reported, because the sweep that would otherwise collect it only deletes on proof the
identity inside is dead and a half-built directory carries no identity to prove
anything with. Only that exact path is removed, and only when this process created it:
a name collision at `mkdir` is somebody else's directory and is left alone. If the
removal itself fails, the orphan is named in a warning and the original construction
error is what the caller still receives.

Every warning this module raises is **non-throwing by construction**: the sink is
wrapped once where the store is created, and a sink that throws is caught and reported
to stderr instead. Warnings are raised past the ledger's commit point, inside release,
and inside the sweep that runs before the release function reaches the caller — a
throwing sink at any of those points would report a committed decision as failed or
strand a published lock that nothing will ever release.

Outside that directory:

| Path | Writer | Readers | Content |
|---|---|---|---|
| `~/.local/share/opencode/session-janitor/children/` | session janitor | session janitor | One record per managed child session, plus reservations and terminal intents; mkdir-locked, capacity 1024. Moved by `OPENCODE_SESSION_JANITOR_DIR`. |
| `~/.local/share/opencode/model-default.json` | `tui/` plugin | model-default plugin, router plugin | The user's last manual model pick |
| `~/.local/share/opencode/modes/<sessionID>`, `~/.config/opencode/mode`, `~/.config/opencode/autoclass` | hud (only when opencode-guard is present) | opencode-guard | The guard's permission mode per session, its default, and its floor level. These are the guard's files; the HUD writes them only as its user interface. |

`~/.local/share/opencode/auth.json` is hashed (never parsed beyond auth types) for
inventory admission, and the gateway reads the one entry each provider's `authRef` names.
