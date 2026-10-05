# Broker socket API

The broker listens as JSON-over-HTTP on a unix socket:
`~/.local/share/opencode/model-routing/broker.sock`. Requests are `POST` with a
JSON body except for the read-only `GET /model-policy/status`; every response is
JSON. Non-2xx responses carry
`{ "error": "<message>" }`. This socket — together with the state files in
[STATE.md](STATE.md) — is the broker's public contract: anything that speaks it
(the bundled plugins and gateway, opencode-guard's classifier route, your own
tooling) is a supported client.

| Endpoint | Body | Purpose |
|---|---|---|
| `/lease` | `{ sessionID, profile, tier, replace?, preferredModel?, contextTokens?, providers?, localOnly?, releasePin?, oneShot?, waitedMs?, resolverToken? }` | Acquire (or revalidate) a model lease. Returns `{ leaseID, target: { id, model: { providerID, id, variant? }, kind }, existing, decision: { registration } }`. The broker-minted `leaseID` identifies this exact lease and must accompany every later settlement report for it. `registration` is the token's validated generation eligibility and never contains the token. Fails with a clear error when no eligible target fits (context, circuits, health, admission) — see **Refusals** below. `providers` and `localOnly` NARROW admission and can never widen it: `providers` to callers a client can actually speak to, `localOnly: true` to targets on the LAN, for content that may not leave it. A session keeps the model it was last assigned while that model can serve it; `releasePin: true` asks for a fresh decision. `oneShot: true` declares that this `sessionID` is minted per request and will never be reused (the gateway does this): it does not affect selection, it only marks the assignment as safe to discard ahead of real sessions' pins. It is **refused** unless the `sessionID` starts with `gw-`, the per-request naming contract — a real session must not be able to ask for its own pin to be spent first. `waitedMs` is the optional non-negative finite count of milliseconds this caller has **already** spent waiting for its primary in the current lease loop; it defaults to 0 and gates rungs carrying `profileFallbackAfterMs` (see **Selection semantics**). Callers reset it for a new upstream-forward attempt, so a retry after a failed forward does not inherit the first attempt's elapsed time. An invalid value is refused rather than coerced: read as 0 it would hold a delayed rung shut forever, and read as huge it would surrender a scarce shared slot immediately. |
| `/release` | `{ sessionID, leaseID }` | Drop the exact session lease. Missing, unknown, stale, or session-mismatched broker-minted bindings are refused. A one-shot session's assignment is dropped with it (nothing can read it back); an ordinary session's pin stays. |
| `/lease/verify` | `{ sessionID, leaseID? }` | Read-only. Returns `{ held: true, leaseID, target: { id, kind, model: { providerID, id } } }` when the session holds a live lease (and it is `leaseID`, when given), else `{ held: false }`. The gateway uses it to forward an opencode session's request on the session's own lease. |
| `/touch` | `{ sessionID }` | Heartbeat; leases expire after 2h untouched. |
| `/failure` | `{ sessionID, leaseID, targetID?, error, failureClass? }` | Report a provider failure for the exact broker-minted lease/session binding. Quota errors open a **provider-wide** circuit until the reported reset; other failures open a 5-minute target circuit and add health evidence (two distinct targets within 15 min quarantines the provider). For a governed candidate lease, `failureClass` is also classified by the closed model-policy taxonomy below; an absent or unknown class is neutral. |
| `/complete` | `{ sessionID, leaseID }` | Successful end: clears probation for the target's provider, settles an exactly bound candidate lease once, drops only that exact lease, and drops a one-shot session's assignment with it. |
| `/forget` | `{ sessionID, leaseID, completed? }` | Drop the exact lease at the end of a turn. `completed: true` settles a governed candidate's success and every other value settles neutral abandonment. The assignment (the session's pinned model) stays and ages out after 14 days — unless the session is one-shot, which has no next turn to read it, so its assignment goes with the lease; `completed: true` also clears provider probation. Assignments are also capped at 512: eviction is oldest-first, but it spends every settled one-shot entry before any session pin. **An assignment whose session still holds a live lease is never evicted**, by the cap or by the 14-day age rule — a session that only revalidates a held lease never moves `updatedAt`, so age is not evidence that it is idle. An entry counts as one-shot if it carries the `oneShot` flag, or carries no flag at all and its id starts with `gw-` (entries written before the flag existed). |
| `/usage` | `{ sessionID?, rootSessionID?, leaseID?, providerID, modelID?, observedAt?, requests, tokens: { input, output, cacheRead, cacheWrite }, caller? }` | Feed the budget ledger and the burn watch (one report per provider request). Usage for a broker lease requires its exact broker-minted lease/session binding; unleased/manual usage may omit both. `rootSessionID`, when given, names the parent session (same shape rule as `sessionID`) so the burn watch rolls a fan-out of subagents into their root for spend accounting; a lone session is a tree of one. A non-future observation whose provider/model exactly matches that retained binding settles candidate success; a later `/complete` is an idempotent replay. Returns current `utilization`, plus `burn: { stop: true, reason }` when this report tipped the session into a runaway: the client that owns the session must stop its turn. |
| `/inventory` | `{ targets, providers, modelContexts, modelOutputs, modelVariants, authRevision, configFingerprint, authOnly? }` | Publish discovered provider/model inventory. Refused unless `authRevision` matches the broker's own hash of opencode's `auth.json` and `configFingerprint` matches the exact config bytes loaded at broker startup. An OAuth-to-API-key or config change can never publish stale admission. |
| `/status` | `{ resolverToken? }` | Full public state: leases, circuits (with `renewsAt`), health, budget report, last decision, non-secret active resolver-process registrations by generation, and `deprecations` when the broker is still reading a renamed setting. |
| `/selection` | `{}` | Just `lastDecision` — why the last lease chose its target. |
| `/preview` | `{ profile?, tiers?, contextTokens? }` | Side-effect-free selection: what each tier WOULD get right now. No lease, no cursor advance. Returns `{ preview: { <tier>: target \| null }, delayedProfileFallbacks: [{ targetIDs, afterMs }] }`. Preview answers for the present moment, so it selects as `waitedMs: 0` and a rung that is merely *not yet* open reads as `null`. `delayedProfileFallbacks` is what keeps that honest: it names the profile's delayed rungs and their thresholds, so a reader can tell "this profile has no fallback" from "its fallback has not opened yet". |
| `/rearm` | `{ targetID? , reasonCode? }` | Clear a circuit. `provider:<id>` rearms a quarantined provider into probation; a target id clears that target; empty clears all circuits. |
| `/quarantine` | `{ scope: "provider", kind: "compatibility", providerID, reasonCode? }` | Operator quarantine of a provider. |
| `POST /resolver-process/register` | Ordinary: `{ generation, manifestHash, modelKeys, rawBase? }`; fresh probe helper: `{ generation, manifestHash, probeLaunchNonce }` | Loopback process-start call. With apply enabled, an ordinary registration independently verifies the exact immutable registry entry and manifest membership and returns `{ resolverToken, scope, generation, manifestHash, modelKeys, expiresAt? }`. Ordinary tokens are opaque, memory-only, and active for 10 minutes after their latest valid use. A fresh helper atomically redeems one exact-bound, 60-second `pln_` launch nonce; the broker loads model membership itself and returns a five-minute `{ resolverToken, scope: "probeFresh", generation, manifestHash, expiresAt }`. A new redemption for the same staged operation revokes its prior helper token. Only token and nonce SHA-256 digests remain in broker memory. Unsafe ordinary registrations return logical generation-0 `base-only` eligibility; an invalid probe redemption fails and never falls back or mints a token. With apply disabled this returns `409`/`reconcile-apply-disabled` before reading a body or generation path. |
| `POST /model-policy/cas` | `{ transitionID, revision, roleKey, expectedIncumbentModelID, generation, manifestHash, desired }` | Loopback control call that compare-and-swaps one normalized provider-role policy. It returns `{ ok, ack, changed }`. The same transition/revision, desired-policy hash, generation, and manifest is a non-writing replay; stale revision, incumbent, desired hash, generation, or manifest mismatches fail before mutation. Package 3 returns `409` with `code: "reconcile-apply-disabled"` unless `reconcile.apply.enabled` is strictly `true` with all three absolute paths configured. |
| `POST /model-policy/probe-launch` | `{ transitionID, operationID, expectedPolicyRevision, roleKey, candidateIdentity: { providerID, modelID }, candidateIntroduction: { generation, manifestHash } }` | Reconciler control call. Requires `operationID === transitionID + ":staged-probing"`, the acknowledged current revision, and the exact non-routable staged candidate identity/introduction. Returns `{ probeLaunchNonce, expiresAt }` with one random 256-bit `pln_` nonce valid for exactly 60 seconds. Issue, expiry, and redemption are memory-only; broker restart invalidates every nonce. |
| `POST /model-policy/probe` | Exact body `{ transitionID, roleKey, candidateIdentity: { providerID, modelID }, candidateIntroduction: { generation, manifestHash }, probeKind, requestID }` plus `x-opencode-resolver-token` | Fresh helper only. An ordinary, expired, prior-process, or wrong-bound token returns `403`/`probe-process-required` or a binding refusal before assignment. Success returns `{ sessionID, probeNonce, expiresAt }` with one random `gw-probe-*` session and purpose-separated `pbn_` nonce for the exact staged target. Duplicate request IDs are refused. |
| `POST /probe/consume` | `{ sessionID, probeNonce }` | Loopback gateway call. Atomically changes the exact assignment from `issued` to `consumed-gateway-owned` before `/lease`, and returns `{ sessionID, preferredModel: { providerID, modelID }, expiresAt }`. Replay, expiry, session mismatch, and nonce mismatch fail closed. |
| `POST /probe/release` | `{ sessionID, probeNonce }` | Idempotent terminal release returning `{ changed, state }`. A helper carrying its resolver-token header may release only an `issued` assignment; after consumption only the gateway path (without that header, carrying the exact nonce) or the hard-expiry reaper can release it. |
| `GET /model-policy/status` | no body | Returns `{ modelPolicy, apply: { enabled, overlayPath, generationsRoot, currentLinkPath, configError } }`. It is read-only and never rewrites `broker.json`. |

`/resolver-process/register`, `/model-policy/*`, and `/probe/*` are control operations. The Unix socket has
no remote address and is local by construction; any future TCP peer must have an
IPv4 or IPv6 loopback address. A non-loopback peer is rejected before a control
body is parsed. The broker enforces exact mode `0600` on the socket; that
same-UID boundary is checked again before issuing a probe-launch nonce.

## Gateway embeddings API

The authenticated gateway also accepts buffered `POST /v1/embeddings` requests in the OpenAI
shape: `{ model, input, encoding_format?, dimensions? }`, where `input` is a string, an array of
strings, or an array of token arrays. Unlike chat, an embeddings request must name a configured
`modelProfiles` entry; it never falls through to the default lane. The leased target must carry
`embedding: true`; the gateway sends `api: "embeddings"` on that broker lease, and the broker
refuses embedding targets without it or an embeddings lease on any other target. Embedding-only
profiles remain valid only for this gateway path and are not offered by OpenCode's F11 picker.
Chat, Responses, and Messages requests refuse such a target. The gateway
forwards the body to the leased provider's `/embeddings`, returns the upstream JSON unchanged, and
settles the one-shot lease exactly as other buffered requests do. It records
`usage.prompt_tokens` as input usage when present; otherwise it records an input-only estimate
(`ceil(chars / 4)` per string or token-array length, summed across the batch), output `0`, and
`estimated: true`. `stream: true` is refused with `400`; batches are limited to 2,048 items and
bodies to 1 MiB (declared or streamed oversize returns `413`). Per-slot eligibility uses the largest
single input estimate, not the serialized batch size.
When apply is disabled, every mutable control operation in this table returns
`409` with `code: "reconcile-apply-disabled"` before parsing its control body,
reading a generation path, minting a nonce/token, or changing state. The read-only
`GET /model-policy/status` remains available.

## Reconciliation apply CLI

`opencode-broker-reconcile` exposes the dormant Package 3 controls below. They
are disabled by default. When `reconcile.apply.enabled` is not strictly `true`,
each command exits 1 and prints
`{ "ok": false, "code": "reconcile-apply-disabled", "mutated": false }`
before constructing a store, collecting sources, reading generation paths, or
calling the broker. Invalid command syntax exits 2 before that disabled gate.

| Command | Purpose |
|---|---|
| `apply <transitionID> [--json] [--dry-run]` | Reserve and run one authorized transition through overlay, generation, staged policy, probes, and probation. |
| `rollback <transitionID> --reason TEXT [--json] [--dry-run]` | Compare-and-swap the broker back to the recorded rollback model (including explicit `null`) and then acknowledge the observed broker result in the ledger. |
| `refresh [--json] [--dry-run]` | Collect certified sources and apply every eligible or incomplete transition in stable transition order. |
| `recover [transitionID] [--json] [--dry-run]` | Resume the first missing durable phase for one transition, or every incomplete transition when no ID is supplied. |

`--dry-run` may perform the isolated source refresh but does not write the
ledger, overlay, generation registry/bundles/current link, or broker policy; it
does not run the generation renderer, open a probe child, or call any publisher.
Its isolated source collection may run `opencode models --pure` against scratch
cache state, exactly like the existing observational `dry-run`. The enabled
production adapter takes the base resolver config from
`OPENCODE_RECONCILE_BASE_CONFIG` when set, otherwise from
`$XDG_CONFIG_HOME/opencode/opencode.json` (or `~/.config/opencode/opencode.json`),
and uses the loopback gateway endpoint from `OPENCODE_RECONCILE_GATEWAY_URL` or
`http://127.0.0.1:8790/v1/chat/completions`.

The applier calls broker policy CAS for staging, probe rollback, probation, and
operator rollback. Each operation has a deterministic transition/revision and
is recovered through `GET /model-policy/status` before any replay. No separate
reconciler writer or direct `broker.json` mutation exists.

## Fresh-process probe transport

`createProbeClientFactory()` resolves and validates the registry-owned immutable
generation through `generationManager.generation()` before spawning
`bin/opencode-broker-probe-client`. The child independently derives the canonical
`generation-<n>` directory under the mode-`0700` root and verifies the private
registry, exact manifest bytes, canonical effective-config hash, acknowledgement,
and candidate membership before registration. Neither side accepts a caller path.

The parent and helper use version-1 NDJSON over stdin/stdout. Every frame is at
most 64 KiB and carries a correlated `requestID`; malformed JSON, partial EOF,
unknown version/type, or an oversized frame is fatal. The one bootstrap frame is
sent on stdin, never argv, and contains the broker socket, loopback gateway URL
and headers, exact policy/generation binding, ordinary gateway model, and launch
nonce. The helper retains its resolver token and emits protocol frames only;
stderr diagnostics are bounded to 16 KiB and redacted by the parent. Shutdown is
bounded and reaped: request shutdown, wait two seconds, `SIGTERM`, wait two
seconds, then `SIGKILL` and await exit. `close()` is asynchronous and idempotent.

The same bounded child-owned protocol carries observability frames for
successful registration, assignment, gateway dispatch, and gateway release
completion. The factory verifies each frame's PID against the actual spawned
`ChildProcess.pid`, verifies fixed endpoint names and the configured broker socket,
and forwards it only through the optional `onTrace` observer. A trace contains
only event name, PID, request ID, endpoint path, broker socket path where
applicable, and a SHA-256
assignment correlation hash; registration also names its numeric generation. It
never contains a token, nonce, authorization header, request or response body,
session ID, model identity, or provider content.

The helper requests one assignment per semantic probe, then calls the ordinary
authenticated gateway endpoint with the ordinary model plus
`x-opencode-probe-session` and `x-opencode-probe-nonce`. The gateway accepts these
markers only with valid gateway authentication from loopback, verifies and
consumes the supplied session before leasing, and passes the exact preferred model
to the broker. It awaits `/probe/release` on success, lease refusal, downstream
failure, and timeout. Headerless requests retain the ordinary path, and
`GET /v1/models` never advertises a candidate or probe-only model name.
The helper also supplies `x-opencode-probe-pid` on its broker and gateway requests;
it is diagnostic process identity only and grants no authority. The launch nonce,
fresh resolver token, and assignment nonce remain the authorization boundaries.

Every ordinary POST body may carry the opaque `resolverToken` returned at process
registration. A valid use extends its active window. Missing, invalid, expired, pre-restart,
future-generation, unknown-generation, cleaned-generation, manifest-mismatched, and raw-base
clients receive logical generation-0 `base-only` eligibility derived from normalized static
targets, with `manifestHash: null`. This fallback does not require or claim an immutable
generation-0 bundle and does not roll back global policy.

## Model probation and automatic rollback

Candidate outcomes are keyed by the broker-minted lease ID and exact session ID. A
validated `/usage` or `/complete` counts one production success, never one each; a
duplicate or contradictory report is a non-counting replay. Synthetic `gw-probe-*`
traffic, abandonment from expiry or `/forget`, and every unclassified or excluded
failure are neutral. The qualifying model failures are exactly
`model-not-found`, `unsupported-model-parameter`,
`invalid-model-tool-call-response`, and `model-entitlement-failure`. The excluded
classes are exactly `network-failure`, `rate-limit`, `provider-overload`,
`user-cancellation`, `client-disconnect`, and `tool-execution-failure`; every other
value normalizes to recorded, non-qualifying `unknown`.

Five distinct production lease successes promote the candidate. Two qualifying
failures that settle within one rolling 15-minute window roll it back during
probation or after promotion. The broker restores the recorded rollback model, or
explicit `activeModelID: null` for a new role, and writes `broker.json` before the
settlement response. Fifteen minutes is only the failure aggregation window: exact
lease/session settlement remains idempotent for the bounded candidate-binding
retention and has no separate settlement deadline.

Every broker-created lease and assignment retains its minted lease and session IDs.
Settlement endpoints resolve the reported `leaseID` first, then verify its exact
`sessionID` and, when supplied, `targetID`; they never infer an outcome from the
session's newest lease. Candidate bindings additionally retain their original target
and survive a later lease for the same session. A delayed report for an already
settled retained candidate binding is an idempotent replay, while a missing, unknown,
stale, cross-session, or cross-target binding is refused before it can settle or
indict the current lease.

The seven-day timeout counts cumulative eligible opportunity time, not wall time.
After the first compatible candidate production lease, every compatible,
candidate-capable production opportunity advances the offer cursor, including
off-offer slots that route the incumbent. Only a slot where the candidate is actually
eligible and selectable opens or extends a window no more than 10 minutes into the
future and accrues its previously open overlap; off-offer and blocked slots accrue
nothing and close the window. Silence can therefore add at most the remainder seen by
the next selectable candidate request; an incompatible/old-generation request closes it. At
exactly seven cumulative days without five successes the broker restores the same
rollback target with `rollbackReason: "probation-timeout"`. No compatible traffic
never starts this clock.

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
