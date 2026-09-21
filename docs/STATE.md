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
| `decisions.jsonl` | broker | operator, tooling | Every routing decision — grants, revalidations, refusals, failures (bounded 4MB, truncating) |
| `fallbacks/<sessionID>.json` | router plugin | hud, router plugin | Fallback/displacement marker; `policy: "provider-displaced"` carries `restoreAt` -- stickiness is released once it passes, and a healthy lease clears every other kind |
| `reviewed-models.json` | opencode-broker-watch | opencode-broker-watch | Catalog model ids already seen/assessed, so each new model notifies exactly once |

Outside that directory:

| Path | Writer | Readers | Content |
|---|---|---|---|
| `~/.local/share/opencode/session-janitor/children/` | session janitor | session janitor | One record per managed child session, plus reservations and terminal intents; mkdir-locked, capacity 1024. Moved by `OPENCODE_SESSION_JANITOR_DIR`. |
| `~/.local/share/opencode/model-default.json` | `tui/` plugin | model-default plugin, router plugin | The user's last manual model pick |
| `~/.local/share/opencode/modes/<sessionID>`, `~/.config/opencode/mode`, `~/.config/opencode/autoclass` | hud (only when opencode-guard is present) | opencode-guard | The guard's permission mode per session, its default, and its floor level. These are the guard's files; the HUD writes them only as its user interface. |

`~/.local/share/opencode/auth.json` is hashed (never parsed beyond auth types) for
inventory admission, and the gateway reads the one entry each provider's `authRef` names.
