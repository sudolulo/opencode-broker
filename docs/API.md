# Broker socket API

The broker listens as JSON-over-HTTP on a unix socket:
`~/.local/share/opencode/model-routing/broker.sock`. Every request is a `POST`
with a JSON body; every response is JSON. Non-2xx responses carry
`{ "error": "<message>" }`. This socket — together with the state files in
[STATE.md](STATE.md) — is the broker's public contract: anything that speaks it
(the bundled plugins and gateway, opencode-guard's classifier route, your own
tooling) is a supported client.

| Endpoint | Body | Purpose |
|---|---|---|
| `/lease` | `{ sessionID, profile, tier, replace?, preferredModel?, contextTokens?, providers?, localOnly?, releasePin?, oneShot?, waitedMs? }` | Acquire (or revalidate) a model lease. Returns `{ target: { id, model: { providerID, id, variant? }, kind }, existing }`. Fails with a clear error when no eligible target fits (context, circuits, health, admission) — see **Refusals** below. `providers` and `localOnly` NARROW admission and can never widen it: `providers` to callers a client can actually speak to, `localOnly: true` to targets on the LAN, for content that may not leave it. A session keeps the model it was last assigned while that model can serve it; `releasePin: true` asks for a fresh decision. `oneShot: true` declares that this `sessionID` is minted per request and will never be reused (the gateway does this): it does not affect selection, it only marks the assignment as safe to discard ahead of real sessions' pins. It is **refused** unless the `sessionID` starts with `gw-`, the per-request naming contract — a real session must not be able to ask for its own pin to be spent first. `waitedMs` is the optional non-negative finite count of milliseconds this caller has **already** spent waiting for its primary in the current lease loop; it defaults to 0 and gates rungs carrying `profileFallbackAfterMs` (see **Selection semantics**). Callers reset it for a new upstream-forward attempt, so a retry after a failed forward does not inherit the first attempt's elapsed time. An invalid value is refused rather than coerced: read as 0 it would hold a delayed rung shut forever, and read as huge it would surrender a scarce shared slot immediately. |
| `/release` | `{ sessionID }` | Drop the session's lease. A one-shot session's assignment is dropped with it (nothing can read it back); an ordinary session's pin stays. |
| `/touch` | `{ sessionID }` | Heartbeat; leases expire after 2h untouched. |
| `/failure` | `{ sessionID, targetID?, error }` | Report a provider failure. Quota errors open a **provider-wide** circuit until the reported reset; other failures open a 5-minute target circuit and add health evidence (two distinct targets within 15 min quarantines the provider). |
| `/complete` | `{ sessionID }` | Successful end: clears probation for the target's provider, drops the lease, and drops a one-shot session's assignment with it. |
| `/forget` | `{ sessionID, completed? }` | Drop the lease at the end of a turn. The assignment (the session's pinned model) stays and ages out after 14 days — unless the session is one-shot, which has no next turn to read it, so its assignment goes with the lease; `completed: true` also clears probation. Assignments are also capped at 512: eviction is oldest-first, but it spends every settled one-shot entry before any session pin. **An assignment whose session still holds a live lease is never evicted**, by the cap or by the 14-day age rule — a session that only revalidates a held lease never moves `updatedAt`, so age is not evidence that it is idle. An entry counts as one-shot if it carries the `oneShot` flag, or carries no flag at all and its id starts with `gw-` (entries written before the flag existed). |
| `/usage` | `{ sessionID?, providerID, modelID?, requests, tokens: { input, output, cacheRead, cacheWrite }, caller? }` | Feed the budget ledger and the burn watch (one report per provider request). Returns current `utilization`, plus `burn: { stop: true, reason }` when this report tipped the session into a runaway: the client that owns the session must stop its turn. |
| `/inventory` | `{ targets, providers, modelContexts, modelVariants, authRevision, authOnly? }` | Publish discovered provider/model inventory. Refused unless `authRevision` matches the broker's own hash of opencode's `auth.json` — an OAuth-to-API-key change can never publish stale admission. |
| `/status` | `{}` | Full public state: leases, circuits (with `renewsAt`), health, budget report, last decision, and `deprecations` when the broker is still reading a renamed setting. |
| `/selection` | `{}` | Just `lastDecision` — why the last lease chose its target. |
| `/preview` | `{ profile?, tiers?, contextTokens? }` | Side-effect-free selection: what each tier WOULD get right now. No lease, no cursor advance. Returns `{ preview: { <tier>: target \| null }, delayedProfileFallbacks: [{ targetIDs, afterMs }] }`. Preview answers for the present moment, so it selects as `waitedMs: 0` and a rung that is merely *not yet* open reads as `null`. `delayedProfileFallbacks` is what keeps that honest: it names the profile's delayed rungs and their thresholds, so a reader can tell "this profile has no fallback" from "its fallback has not opened yet". |
| `/rearm` | `{ targetID? , reasonCode? }` | Clear a circuit. `provider:<id>` rearms a quarantined provider into probation; a target id clears that target; empty clears all circuits. |
| `/quarantine` | `{ scope: "provider", kind: "compatibility", providerID, reasonCode? }` | Operator quarantine of a provider. |

Each `/inventory` provider has `admission`, one of `admitted`, `disconnected`,
`quarantined-auth`, or `quarantined-model`. It describes access only; whether the
deployment pins any targets for that provider does not change it. Broker state written
before 0.43 used `classification: "static" | "subscription"`; the reader migrates both
values to `admission: "admitted"`.

## Refusals

A `/lease` that cannot be served answers 400 with the human message **and** a
machine-readable code, so a caller can tell "keep waiting" from "give up" without
matching prose:

```json
{
  "error":    "swap-model is not resident; preparing it now -- resend the prompt in a moment",
  "code":     "target-preparing",
  "targetID": "uncensored-qwen",
  "modelID":  "qwen3.8-27b-uncensored"
}
```

| `code` | Meaning |
|---|---|
| `target-preparing` | A local target's model is not resident and its `prepareCommand` is running — whether this call started it or it was already in flight. Retry shortly; this **will** clear. |
| `target-busy` | A local target is resident, fits the request and has no open circuit, but every slot is taken. Retry shortly; a slot frees within one job. |
| `no-eligible-local-target` | Every wanted target is local and none is deployed, free, or within its context window (or the request was `localOnly`). Nothing is being done about it. |
| `no-eligible-target` | The mixed/cloud case: no target in the lane is currently usable. |

The HTTP shape is identical for all of them — a client must resend either way — but the
recorded **decision** separates them, because a log reader is asking a different question.
`target-preparing` and `target-busy` record `policy: "waiting"`; the others record
`policy: "refused"`.
A wait is transient and self-healing (a local model is loading; the same prompt routes on
the retry), a refusal is terminal and needs the caller to change something. Filing both as
`refused` made `decisions.jsonl` report a 43% failure rate on a deployment whose broker was
working correctly and waiting out a GPU swap.

The set is **closed**. A refusal that fits none of it — an unreadable auth store, an
invalid profile or tier — carries no `code` at all, and callers should read that absence
as "unclassified, treat as final" rather than expecting a catch-all. `targetID`/`modelID`
appear only when exactly one target is the subject (the one being prepared, or the single
target the lane wanted); a client must not require them. `error` is unchanged from before
codes existed and is stable; the same `code` is written onto the recorded decision, so
`/status`, `/selection` and `decisions.jsonl` carry it too.

`brokerRequest` (`lib/client.js`) attaches every structured field of a non-2xx body to the
rejected `Error` (`error.code`, `error.targetID`, …) while leaving `error.message`
byte-identical, so clients do not need their own transport to read them.

Concurrency: the broker serializes request handling, so two simultaneous
`/lease` calls cannot both take the last local slot. State is persisted to
`broker.json` after every mutation (atomic rename, mode 0600).

## Selection semantics

- Profiles: `manual` never leases; `auto` uses the tier lanes and `fallbacks`; every
  profile declared in the config's `profiles` routes within its own lane and then within its
  OWN `profileFallbacks` rungs. A profile's rungs are filtered to local targets at config
  load unless the deployment names the profile in `profileCloudEgress` — which an offline
  profile (`offlineProfiles`; by default `private` and `*-offline`) may never be. A lease
  taken from a rung carries `profile-fallback-rung` in its reasons.
  A rung may also declare a WAIT before it opens, via `profileFallbackAfterMs` (per profile, one
  entry per rung, positionally): the rung is only considered for ordinary selection once the
  caller's `waitedMs` reaches its threshold. A rung with no entry opens immediately, which is
  every rung that existed before the setting. This exists so a bursty background lane cannot
  seize a scarce shared target the instant its own lane is busy, while an interactive lane keeps
  its immediate rung. Two things deliberately ignore the delay: the refusal classifier, so a
  full-but-delayed rung still reads as `target-busy` (keep waiting) rather than "no target
  exists"; and the context-overflow last resort, so a session too big for every window is never
  denied the roomiest one just because its clock has not run out.
  A profile whose single target is made resident by a `prepareCommand` should be given **no**
  rungs at all: an eligible rung means the lease succeeds, so the refusal that runs the
  prepare never happens and the target is never swapped back in.
  Declare a separate profile whenever a model must be *selectable* without being
  *interchangeable* with the one beside it: a large model that evicts everything else
  should be chosen on purpose, never by a tie-break, and a model a caller specifically needs
  is unreachable from a lane that also holds a cheaper sibling the broker would choose.
  A single-target lane must not name a target carrying `minContextTokens`. That floor
  steers between candidates; with one candidate it only refuses, and the small request it
  refuses is usually the one the lane was added for.
- Machine-dispatched lanes (resolved by the router plugin; the socket takes whatever
  `profile` the caller sends): a lane that processes the **conversation** follows the
  conversation's profile — `compaction` leases on the session's own profile, so an
  `uncensored` session is compacted by its own model and never by a censored one. A lane
  that processes something else routes ordinarily but stays inside the profile's egress
  boundary — a command-classifier agent (`agentTiers` maps it to `classifier`; by default
  opencode-guard's `fleet-classifier*`) takes the `classifier` tier rather than the session's
  profile, and under any restrictive profile it may not leave the LAN, so its cloud rung
  is suppressed there (and there only) and the gate fails closed if no local classifier
  target is available.
- Tiers: `deep` / `smart` / `build` / `fast-build` / `review` / `worker` / `classifier`.
  The router plugin picks the tier from the session's agent (`agentTiers`), raises it for
  high-risk content, and applies `tierAliases`. Discovered subscription (OAuth) models join
  lanes by model family; `classifier` and `fast-build` lanes are pinned to config.
- Admission: a cloud target is eligible only if its provider proved OAuth at
  inventory time or is listed in `trustedSubscriptionProviders`. Merely enabling
  a metered provider in opencode never spends tokens.
- Context fit: a target is skipped when the session's tracked context exceeds
  85% of the target's declared window (config `context` for local targets,
  catalog-declared for cloud). Unknown sizes stay permissive.
- Balancing: weighted depletion toward the provider with the most observed
  budget headroom (see `budgets` in config — operator estimates, selection-only;
  quota circuits are the hard gate), with one in N worker assignments reserved
  for the local lane and round-robin tie-breaking. It applies when a session gets
  its first model; after that the session keeps it until it cannot be served there.
- Context pressure: hosts auto-compact near (context − output reserve), so once
  a session's tracked context passes 60% of its current model's declared window,
  selection retries against only roomier-window targets and both held-lease
  revalidation and model stickiness yield (`context-pressure-prefers-roomier-window`
  in the decision trail). If nothing roomier exists, normal selection stands.
- Family upgrade: session stickiness never outranks a NEWER same-family,
  same-speed sibling that is eligible again — a session displaced onto an older
  family member by a transient circuit rebalances forward on its next lease
  (`family-upgrade-releases-stickiness`).
- Plan-window lockout: when a provider's own usage API (config
  `budgets.<provider>.planUsage`) reports an exhausted plan-wide window, a
  `plan-window` provider circuit opens until the provider's reported reset and
  clears early if a later report says the window reopened. `/failure` responses
  carry `circuitUntil` so callers can schedule a restore; a displaced session's
  fallback marker records it as `restoreAt` and stickiness is released once it
  passes.

### `caller`

`/lease` and `/usage` accept an optional `caller: { address?, model? }`: the client address and the
model name a proxy's own client asked for. The gateway sends it for every request, so its
anonymous `gw-...` sessions can be told apart. The broker records it on that session's lines in
`decisions.jsonl` and `usage.jsonl`, and `opencode-broker usage` reports the top callers per
model. An address must look like an IP and a model name must be 1-100 printable characters;
anything else is dropped, never logged raw.
