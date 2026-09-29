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
| `.model-reconciliation.lock/` | `opencode-broker-reconcile`, `opencode-broker-evidence` | `opencode-broker-reconcile`, `opencode-broker-evidence` | Ephemeral mkdir lock and owner record serializing every reconciliation-ledger mutation; removed when the writer exits |

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
| `issue` | `opencode-broker-reconcile project` | The open Gitea issue: `number`, `url`, `revision`, and the `createdAt`/`commentedAt`/`reopenedAt`/`refusedAt`/`closedAt` markers each external write is deduped by |
| `supersededIssue` | `opencode-broker-reconcile project`, `approve`, `reject` | An issue pointer moved off a proposal that is no longer the one being asked about, carrying `supersededAt` and (for a local decision) `reason`. The next `project` run comments and closes it, then clears the pointer |
| `notified` | `opencode-broker-reconcile project` | One entry per announced event, keyed `event\|transitionID\|timestamp`, holding `{ at, attempts, lastError, firstAttemptAt }`. `at` stays null until the notifier exits 0 |
| `supersededAt` | `opencode-broker-reconcile dry-run` | When this proposal was retired. Stamped on the record because a role record drops back to `evidence-pending` afterwards, so current state alone cannot tell |

Nothing here is routing state. No field in this file makes a model eligible, and
the broker never reads it.

Outside that directory:

| Path | Writer | Readers | Content |
|---|---|---|---|
| `~/.local/share/opencode/session-janitor/children/` | session janitor | session janitor | One record per managed child session, plus reservations and terminal intents; mkdir-locked, capacity 1024. Moved by `OPENCODE_SESSION_JANITOR_DIR`. |
| `~/.local/share/opencode/model-default.json` | `tui/` plugin | model-default plugin, router plugin | The user's last manual model pick |
| `~/.local/share/opencode/modes/<sessionID>`, `~/.config/opencode/mode`, `~/.config/opencode/autoclass` | hud (only when opencode-guard is present) | opencode-guard | The guard's permission mode per session, its default, and its floor level. These are the guard's files; the HUD writes them only as its user interface. |

`~/.local/share/opencode/auth.json` is hashed (never parsed beyond auth types) for
inventory admission, and the gateway reads the one entry each provider's `authRef` names.
