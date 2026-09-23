# Delayed profile fallback (`profileFallbackAfterMs`)

Status: proposed (revision 2 — incorporates spec review 2026-09-23)
Date: 2026-09-23
Repo: opencode-broker (1.13.0)

## Problem

`profileFallbacks` rungs are consulted the instant a profile's primary lane has nothing
eligible, and "busy" counts as ineligible:

- `lib/routing.js:1600` — `const usingFallback = !availablePrimary.length && availableFallback.length > 0;`
- `lib/routing.js:1494` — inside `eligible()`, `if (targetFull(target, active)) return false;`

So a rung is an *alternative to waiting*, never an *overflow after waiting*. For a lane whose
primary is frequently saturated the rung becomes the common path rather than the exception.

This blocks the `memory` lane. Measured 2026-09-23 (figures from `usage.jsonl`, `nvidia-smi`
and the supermemory API; not re-verified by the spec reviewer):

| Fact | Value |
| --- | --- |
| memory requests, 24h | 1,210 |
| memory share of 9b generation tokens | 62.3% |
| document arrival vs completion | ~21/hr vs ~10-15/hr |
| card 0 | 82 C, `SW Thermal Slowdown` ACTIVE, 1,177/1,380 MHz |
| card 1 | 47 C, 0% utilisation |

Card 1 has idle capacity, but wiring `memory -> local-27b` under today's semantics would take
the single `local-27b` broker slot whenever the memory lane hits its 3 leases. That slot is
shared with the Frigate/paperless vision work the 27b exists for
(`/home/dev/devbox/config/opencode-broker/NOTES.md:461-466`), and Frigate genai fires every
~6.3 minutes into `np = 2` physical slots.

Adding a slot instead is blocked by VRAM: card 1 has ~940 MiB free and another
131,072-token slot needs ~2,939 MiB at this preset's measured 22.96 KiB/token.

## Goal

Let a profile declare how long a request must have waited before each fallback group becomes
eligible, so rungs act as genuine overflow and the primary lane keeps priority.

## Non-goals

- Changing `fallbacks` (tier rungs). Only `profileFallbacks` gains the delay.
- Changing default behaviour. A profile with no entry keeps today's immediate fallback.
- Enabling cloud egress for `memory`. Gated separately; see Privacy interlock.
- Preemption. A generation already holding a llama.cpp slot is not interruptible.

## Design

### Config shape

```jsonc
"profileFallbacks":       { "memory": [["local-27b"]] },
"profileFallbackAfterMs": { "memory": [300000] },
```

The delay array is positional against the **authored** group array.

☠️ Delays MUST travel with their group through normalization. `lib/config.js:529-538` maps
each group through `idList`, strips non-local members for a profile that may not leave the LAN
(`:533-536`), and then **drops fully-emptied groups** with `.filter((group) => group.length)`
(`:538`). That deletion shifts every later index, so a delay array indexed against the raw
config would silently attach a delay to the wrong rung. Therefore `normalizeProfileFallbacks`
takes the delay array as a second input and zips it, dropping delay entries in lockstep with
their groups, returning aligned `{ groups, delays }`. Nothing downstream may re-index by
authored position.

Rules:
- No entry for a profile: every group eligible immediately (current behaviour). `assist`
  relies on this — it fronts voice control and must not wait.
- Delay array shorter than the group array: missing entries default to 0.
- Delay array longer: surplus entries ignored, one `console.error` per surplus entry.
- Value is not an array (bare number, object, string): ignored entirely, one `console.error`.
- Names a profile with no `profileFallbacks` entry: ignored, one `console.error`.
- Names an unknown profile: ignored, one `console.error`, matching the existing warning at
  `lib/config.js:499`.
- Non-finite or negative value: coerced to 0, one `console.error`.
- Logging is **per offending entry**, matching this file's convention
  (`lib/config.js:411,415,497,499,535`) — not once per load, which would hide a second bad value.
- Delays need not increase monotonically. Filtering preserves group order, and
  `lib/routing.js:1597-1599` takes the first non-empty eligible group, so among eligible groups
  the earliest-indexed still wins. With `[A(900000), B(0)]`, B serves from t=0 and A displaces
  it from t=900000.

### The clock

`waitedMs` is the elapsed time since the **first refusal within the current
`leaseWithPrepare` invocation**; the first lease attempt always sends 0.

It is NOT derived from the client deadline. `deadline` is minted once per client request
(`gateway/lib/gateway.js:654`) *before* the `ATTEMPTS` loop (`:655`), so `budget - (deadline -
now())` would hand attempt 2 a large `waitedMs` after a failed forward/stream and let it take
the rung on its first lease call, having never queued for a slot.

### Control flow

The gateway owns the wait loop and therefore the elapsed time; the broker does not. The value
travels with the lease request. Six functions across two processes need the parameter:

1. `completionsFor` — `gateway/lib/gateway.js:636` (deadline minted `:654`)
2. `leaseWithPrepare` — `:536`, loop `:551-588`; owns the wait clock defined above
3. `leaseOnce` — `:440`, request body built `:467-486`; adds `waitedMs`
4. POST `/lease` handler — `bin/opencode-broker:1087-1098`
5. `acquire` — `bin/opencode-broker:644`; validates `waitedMs` in the block at `:645-685`,
   following the `contextTokens` pattern at `:649-653`; passes it through `selection` (`:772-783`)
6. `chooseTarget` — `lib/routing.js`, filters groups at the call site

☠️ The delay filter is applied at the `chooseTarget` call site (`lib/routing.js:1589`), NEVER
inside `fallbackTargetGroupsFor` (`lib/routing.js:937`). `targetEligibleIDsFor`
(`lib/routing.js:960-963`) shares that helper and feeds the broker's `busy` computation at
`bin/opencode-broker:958-965`, which must keep seeing **unfiltered** rungs — otherwise a
request refused because only a not-yet-eligible rung existed stops classifying as
`target-busy` at `:978-981` and the gateway stops retrying.

☠️ Keep an **unfiltered** `fallbackGroups` for the context-overflow last resort at
`lib/routing.js:1614-1635`, which reuses `fallbackGroups.flat()` at `:1617` to find the
roomiest window. Filtering it would strip rung targets from the rescue path whose own comment
(`:1604-1610`) notes a refusal there is unrecoverable. Inert for `memory` (that path selects
`kind === "cloud"` only) but latent for any profile with a cloud rung.

`chooseTarget` has three call sites:
- `bin/opencode-broker:807` — ordinary path, receives `waitedMs`
- `bin/opencode-broker:830` — context-pressure `roomyChoice` retry; spreads `...selection` and
  therefore inherits `waitedMs`. Must be confirmed by test, not assumed.
- `bin/opencode-broker:1401` — the `/preview` handler (not `/selection`, which is a separate
  handler at `:1430` returning the last recorded decision). Preview has no wait concept, so it
  passes `waitedMs = 0` and adds an additive `delayedProfileFallbacks` field naming each delayed
  rung and its threshold, so a null preview never implies a rung is unreachable. The existing
  `preview` object is preserved for HUD consumers.

### Refusal classification

Already satisfied today and must stay that way: `busy` at `bin/opencode-broker:958-965` is
computed from `targetEligibleIDsFor` (primary plus all rung ids, unfiltered) intersected with
`targetFull`. With `local-memory` resident and full, `busy.length > 0`, so `:978-981` yields
`target-busy` and the gateway retries. No change is required — the requirement exists to stop
an implementer breaking it by filtering in the wrong place.

Note the requirement matters for profiles *without* `waitForLocal`. For `memory` specifically
both codes are waited anyway: `ABSENT_LOCAL` is literally `"no-eligible-local-target"`
(`gateway/lib/gateway.js:66`) and `:559-561` converts it into a wait when `waitForLocal === true`.

### Scope: gateway-only, deliberately

`local` and `private` are plugin-driven, not gateway-driven. `plugin/router.js:544` keeps its
own clock (`Date.now() - waitStarted`) and retries `target-busy` itself, never entering
`gateway/lib/gateway.js`'s loop. Both profiles hold `local-27b` rungs (`config.json:386-395`)
guarding the same single 27b slot.

The mechanism is therefore gateway-only, and `local`/`private` keep immediate fallback. That
is the intended behaviour, not a gap:

> Starving Frigate is acceptable for `local`/`private`, because the user explicitly selected
> them — interactive opencode performance outranks Frigate. (Holden, 2026-09-23)

The asymmetry is the point. `memory` is unattended background ingestion with a 50-minute wait
budget and a hard "no memory may be lost" rule, so it can afford to yield the 27b slot to
Frigate for five minutes. A human sitting in a `local` or `private` session cannot, and has
already declared that preference by choosing the profile.

Consequently `plugin/router.js` is NOT modified, and no profile reached only through the
plugin can use `profileFallbackAfterMs`. If a plugin-driven profile ever needs a delayed rung,
sending `waitedMs` from `plugin/router.js:544` is the extension point.

### Backward compatibility

Absent config is identical to today. No existing profile declares the new key, so the only
behavioural change ships with the `memory` wiring.

## Privacy interlock

`memory` carries conversation text from every session, including ones run under `local` and
`private`, and nothing in the corpus marks which. The supermemory plugin's capture is gated
only by `SUPERMEMORY_API_KEY` presence; no profile signal reaches it.

This has already gone wrong once:
`/home/dev/devbox/config/opencode-broker/NOTES.md:400-403` records 2,551 ingestion requests
reaching qwen-flash in the week to 2026-09-21, "most of them personal memory content."

Order of operations:

1. `profileFallbackAfterMs` ships; `memory -> local-27b` wired and observed.
2. The 299 currently-failed documents are re-imported while the lane is still LAN-only.
3. Capture from `local`/`private` sessions is suppressed (separate work).
4. Only then is `memory` added to `profileCloudEgress` and the `["haiku"]` group appended.

☠️ The cloud group is NOT configured before step 4. `lib/config.js:533-538` does not make it
inert: it strips the non-local member, prints a `-- DROPPED` error to stderr on every broker
start (`:535`), and removes the emptied group entirely (`:538`).

## Testing

Framework is `node --test` (`package.json:68`), run as
`node --experimental-test-module-mocks --test tests/*.test.mjs gateway/tests/*.test.mjs hud/tests/*.test.mjs`.

Config normalization (new fixture `tests/fixtures/profile-fallback-delay.config.json`,
alongside the existing `tests/fixtures/profile-fallback.config.json`):
- delays stay aligned with their groups when an earlier group is dropped by `:538`
- each edge case in Rules above produces the documented coercion and one error per entry

Unit, against `chooseTarget`:
- a group with delay 300000 is NOT selected at `waitedMs = 0` when the primary is full
- the same group IS selected at `waitedMs = 300000` (boundary is `<=`)
- with two groups, only group 0 is eligible between its delay and group 1's
- a profile with no delay entry falls back immediately — regression guard for `assist`
- non-monotonic `[A(900000), B(0)]`: B at t=0, A from t=900000
- the context-overflow path at `:1614-1635` still sees unfiltered rungs

End-to-end, which the unit tests above cannot cover — an implementation that adds the
parameter to `chooseTarget` but never threads it through `acquire` passes all of them and is
inert in production:
- POST `/lease` with `waitedMs` below the delay against a full primary: rung NOT taken, refusal
  classifies `target-busy`
- POST `/lease` with `waitedMs` at/above the delay: rung taken
- the `roomyChoice` retry at `bin/opencode-broker:830` preserves `waitedMs`

Refusal classification belongs in `tests/refusal-codes.test.mjs`, which spins a real broker
(`:273-297`). It must NOT be asserted in `gateway/tests/gateway.test.mjs`, whose broker is a
stub returning canned bodies (e.g. a literal `{ code: "target-busy" }` at `:1295`) — such a
test asserts the stub, not `bin/opencode-broker:978-981`. The gateway test covers retry
behaviour only.

## Rollout

1. Ship the primitive with no config change; tests prove default behaviour is unchanged.
2. `systemctl --user restart opencode-model-broker.service` — running TUIs load broker-side
   code at spawn, so without the restart the old code keeps serving.
3. Wire `memory: [["local-27b"]]` with `[300000]`; watch memory completion rate, `local-27b`
   lease counts, and Frigate genai latency.
4. Re-import the 299 failed documents while LAN-only.
5. Private-capture suppression, then the cloud group and the `profileCloudEgress` entry.

## Risks

- **Frigate contention remains possible**, just rarer. A 5-minute delay makes the rung an
  exception, but a memory generation that wins the slot still holds it for minutes. Step 3
  must measure Frigate latency, not assume it.
- **Delay tuning is empirical.** 300,000 ms is chosen because memory's p99 wait was ~27 minutes
  against a 50-minute budget (`NOTES.md:424-428`); if the rung fires too often the delay rises.
- **`waitedMs` is caller-reported.** Any caller that does not run a wait loop always reports 0
  and therefore gets immediate fallback. Two such cases exist today: a non-gateway, non-plugin
  caller, and a gateway name with `budget === 0`, which `gateway/lib/gateway.js:554,565`
  short-circuits out of the queue so it can never accrue wait.
