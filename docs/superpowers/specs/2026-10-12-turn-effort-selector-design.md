# Per-turn effort selector

Status: design, revised after independent review (2026-10-12). It changes the router plugin and the
broker in this repo, plus one small change in the OpenCode fork engine.

## Goal

Choose each main-session user turn's reasoning effort deliberately instead of always using the tier
default. Hard turns get one step more thinking and light turns one step less. Short go-aheads keep what
the previous substantive turn used. Two default policies are recorded side by side in shadow mode, and
Holden picks the one to enforce.

This is the selection half of dynamic effort. The transport half has already shipped: the OpenCode fork
build `0.0.0-fork/effort-combined-202610122257`, with `experimental.effort_updates: true` in devbox
`config/opencode/opencode.json`. On allowlisted models it sends a same-model effort change as a native
mid-conversation update, so the change does not rewrite the cached prompt prefix. OpenAI live check: 20/20
sessions kept the cache, against 0/5 for a top-level change. Anthropic kept the cache in both arms on
this route. Spec:
`/home/dev/projects/effort/docs/superpowers/specs/2026-10-09-cache-safe-effort-wiring-design.md`.

## Decisions already taken (Holden, 2026-10-12)

1. Signal: deterministic rules on cheap local signals. No classifier model, so no added latency.
2. Direction: move both ways from the tier default.
3. Default policy: decided after measurement. `tier` (today's default) and `savings` (one step below
   it) are both computed for every eligible turn.
4. Granularity: main sessions are classified on every real user turn. A subagent has exactly one real
   user turn, its brief; everything after it is tool steps, and the engine can change effort only at a
   real user turn. Subagents therefore take their seat's tier effort at creation, and briefs are not
   text-classified. Briefs are long: 21 of 31 stored briefs are over 1,000 characters, so a length rule
   would raise almost all of them.

## Measurements behind the rules

Real user turns, from the fork session DBs `opencode-fork-snip-always-prefix.db` and
`opencode-fork-atomic-runtime-contracts.db` under `~/.local/share/opencode/`, tables `message` and
`part`, read-only:

| | Main sessions | Subagents (mostly deleted after they finish) |
|---|---|---|
| Real user turns | 2,170 (299 session starts) | 31 (all first turns) |
| Agent, variant | 90% `smart` at `high` | workers `medium`, some `high`/`xhigh` |
| 20 characters or fewer | 39%: `continue` 230, `go` 118, `yes` 61, `all good?` 30, `a` 25, `approve` 12, `1` 12, `do it` 10, ... | 0 |
| Over 1,000 characters | 10% | 68% |

The short turns are go-aheads for heavy work, so length alone must never lower effort. Status questions
are about 2% of main turns.

Where the tokens go comes from broker `usage.jsonl` plus `usage.jsonl.1`, 2026-10-08 15:00 to 10-12
23:09 (4.3 days, 35,416 rows). The weights are Anthropic list ratios (input 1, output 5, cache read 0.1,
cache write 1.25). They give a relative measure of quota use, not billing.

| Bucket | Sessions | Share of weighted cost | Of which output |
|---|---|---|---|
| main `smart` | 55 | 45% | 2.9% |
| subagent `build` (sp-implementer) | 318 | 25% | 3.1% |
| subagent `worker` | 447 | 8% | 0.8% |
| main `worker` (one-shot gateway callers) | 10,326 | 7% | 1.2% |
| subagent `smart`, `review`, `deep` | 328 | 15% | 3.2% |

Output, including thinking, is about 11% of weighted cost, and effort mainly moves that part. Expect a
few percent of total savings at most. One OpenAI cache miss on a 150k prefix costs as much as roughly
45-65 turns of step savings. The selector's main value is more thinking on hard main-session turns.
Cache safety is a hard requirement, not a nice-to-have.

## Facts this design rests on (verified 2026-10-12)

- `plugin/router.js:1152-1243`: `chat.message` runs `ensure()` on every user turn (`:1232`, with a
  second call on a stale inventory `:1232-1237`). It has the agent, the session record (`:1159`, which
  can be undefined when `getSession` fails), the non-synthetic text parts (`:1172-1174`) and the
  user-picked variant (`:1186-1190`). Synthetic-only prompts keep the routed model (`:1198-1204`).
- `plugin/router.js:728-743`: `route()` builds the `/lease` body. It sends `replace: true` every turn.
  Manual Model roots return earlier and take no lease (`:671-703`).
- `plugin/router.js:662`, `lib/routing.js:152-177`: the risk floor (`highRiskTier`, a regex) raises
  the tier via `raiseTier`. It never sets effort.
- `lib/routing.js:667-717`: tier defaults come from `desiredVariantForTier`. `review` has none.
  `modelRefForTier` uses `target.effort[tier]`, else the default. It clamps to `effortCeiling`
  assuming ascending advertised order (`:698-702`) and throws if the ceiling is not advertised.
  `lib/model-candidates.js:53-62`: the advertised list is in catalog order, with null mapped to `none`.
- `bin/opencode-broker:434-437`, `:1851`: the variant is computed only in `publicTarget` in the
  `/lease` and `/preview` handlers, after `acquire()` has already logged its decision.
- `bin/opencode-broker:1298-1304`: stickiness compares provider, model, profile and tier, not variant.
  The lease record holds no variant. A per-turn variant change therefore causes no re-lease, pin churn
  or capacity change.
- `plugin/router.js:1281-1299`: `chat.params` throws `routed model mismatch` when the applied variant
  differs from the lease. A stepped variant agrees with it by construction. `plugin/router.js:1474-1479`:
  fallback leases store the variant.
- `hud/tui.js:384-408`: the HUD calls `session.switchModel` whenever the dispatched
  provider/model/variant changes, and marks the switch as managed. `tui/tui.js:25-38` saves any
  `model.switched` event it does not recognise as managed to `model-default.json`.
- `bin/opencode-broker:138-148`: `decisions.jsonl` is truncated wholesale at 4 MiB, which is about every
  4 hours of traffic, so it cannot hold shadow data. `:153-161` with `lib/usage-log.js:27-48`:
  `usage.jsonl` rotates to `.1` and has `at` and `sessionID`. Main sessions have no `rootSessionID`.
- `lib/config.js:505-509`, `:763-771`: the shared config loader never throws; it logs and ignores bad
  values. A throw there would stop routing in every OpenCode process.
- Engine effort-update gate: fork `packages/opencode/src/session/llm/effort-eligibility.ts`. Allowlist
  `anthropic/claude-opus-5-5`, `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5-5`,
  `anthropic/claude-fable-5-1`, `openai/gpt-6-sol`, `openai/gpt-6-luna`, `openai/gpt-6-astra`,
  `openai/gpt-6.1-sol`. It matches `model.api.id`. It also requires the flag, the AI SDK runtime (not
  native), a non-small and non-compaction/title/summary agent, the patched SDK, and stateless OpenAI.

## Design

### S1. Turn classes (`lib/turn-effort.js`, pure, no I/O)

`classifyTurn({ text, isSubagent, riskRaisedTier, riskFloor, previous })` returns
`{ class, reason, resolvedFrom? }`, where `class` is one of `normal`, `light`, `hard`. It runs only for a
`chat.message` that carries non-synthetic text. Synthetic-only turns are not classified and keep the
current lease variant, as today.

Normalisation: trim, lower-case, collapse whitespace, then strip trailing `.!?,` (for example `go!`
becomes `go`). Rules run in this order, and the first match wins:

1. `isSubagent`: `normal` / `subagent-seat`.
2. Agent notice. A trimmed, case-insensitive text prefix of `[team report from `, `[team idle from `,
   `[team notice from `, `[team message`, `[peer message `, `[scheduled prompt `, or `[background job `
   is a harness-injected notice from another agent, not a human turn. It inherits `previous` like a
   go-ahead, with reason `agent-notice`; this prevents 726 of 4,074 replayed messages (including 251
   of 473 hard messages) from being raised merely to read a teammate report.
3. Go-ahead. The normalised text must FULLY match one of the following:
   - one of `continue`, `go`, `go on`, `go ahead`, `yes`, `y`, `ok`, `okay`, `do it`, `you do it`,
     `approve`, `approved`, `push`, `try again`, `proceed`, `keep going`, `sounds good`;
   - a single option token: `^[a-z0-9]$`, `^option [a-z0-9]$`;
   - a one-edit typo of a listed word of 5 or more characters (`conitnue`, `contnue`, `approev`).
     Shorter words never match by typo, so `no`, `do` and `n` are not go-aheads.

   The result is the previous substantive class (`previous`; `normal` when unset), with reason
   `go-ahead` and `resolvedFrom` set to that class.
4. Hard:
   - `riskFloor` set and NOT `riskRaisedTier` gives `risk-floor`. When the floor already raised the tier,
     that tier's default is the escalation, so the turn gets no extra step;
   - an explicit ask (substring): `ultra-think`, `ultrathink`, `think harder`, `think deeply`,
     `go deep` gives `explicit`;
   - a failure signal gives `failure`. Either a substring (`still failing`, `didn't work`,
     `doesn't work`, `same error`, `still broken`), or at least two stack-frame lines (a JavaScript
     frame `at <frame> (<path>:<n>:<n>)`, or a Python frame `File "...", line <n>`);
   - normalised text over 1,000 characters gives `long-task`.
5. Light: normalised text of 200 characters or fewer that STARTS with a status pattern: `all good`,
   `status`, `what did we do`, `where are we`, `is it done`, `did it work`, `any update`, `check status`.
   A bare `check` is not light, because "check the migration for races" is real work.
6. Otherwise `normal` / `default`.

Carry-over: the plugin keeps `previous` per session (bounded, like its other per-session maps). It
updates `previous` only on real, non-synthetic, non-compaction user turns, and only to `normal` or
`hard`. `light`, go-aheads, and agent notices are never carried. So "all good?" followed by "continue"
resumes the heavy level. A plugin or broker restart forgets `previous`, and the go-ahead chain after it
then resolves to `normal` until the next substantive turn.

### S2. Steps, policies and eligibility (broker)

- Canonical rank: `none < minimal < low < medium < high < xhigh < max`. A step moves to the
  next or previous rank in the set formed by the model's advertised levels intersected with the
  ceiling-clamped range.
- Base:
  - `tier` policy: today's resolved variant (`target.effort[tier]` or `desiredVariantForTier`).
  - `savings` policy: one rank below that base.
  - If the base is undefined (`review`, or a model with no advertised level), nothing is stepped and
    both policies equal today's variant.
- Class step: `normal` 0, `light` -1, `hard` +1. A `light` result never goes below `low`.
- `eligible` is true only when ALL of these hold. Only an eligible lease gets the base shift and the
  class step:
  - the broker config `turnEffort.mode` is `enforce` (or `canary`, see S3);
  - the lease carries a `turnClass` from the plugin with a reason other than `subagent-seat`, `absent`
    or `classifier-error`;
  - the lease carries `engineEffortUpdates: true` (S3);
  - the target's `providerID/modelID` is in `turnEffort.models`.
- The `clamped: true` flag is recorded whenever the ceiling or the advertised set changed the computed
  result.

### S3. Data flow, engine capability and config

1. Engine (fork, small change in `packages/opencode/src/session/llm/request.ts`): the `chat.params`
   hook input gains `effortUpdates: boolean`. It is `true` when `experimental.effort_updates` is on
   and the build contains the effort-update feature. A binary without this change never sends the
   field, which counts as false.
2. Plugin `chat.params`: records `effortUpdates` per process. The first lease of a process happens
   before any `chat.params`, so it counts as not capable. That lease is not stepped, which costs
   nothing, since a session's first request has no cache to lose.
3. Plugin `chat.message`:
   - computes the risk floor as today, then calls `classifyTurn` once;
   - `isSubagent` comes from the session object `route()` uses; an unknown session counts as not a
     subagent only when `getSession` succeeded with no `parentID`, and otherwise as a subagent;
   - the result is passed through `ensure(sessionID, agent, preferredModel, turnEffort)` into
     `route()`, which adds `turnClass: { class, reason }` and `engineEffortUpdates` to the `/lease` body.

   Manual Model takes no lease and gets no record.
4. Broker `/lease` handler, after `publicTarget`:
   - computes both policies and the eligibility;
   - returns the enforced variant, which is today's variant unless eligible;
   - appends one compact row (about 250 bytes, no prompt text) to a new rotated
     `~/.local/share/opencode/model-routing/turn-effort.jsonl` (`usage.jsonl` pattern). Fields: `at`,
     `sessionID`, `leaseID`, `tier`, `targetID`, `providerID`, `modelID`, `mode`, `class`, `reason`,
     `resolvedFrom`, `engineEffortUpdates`, `eligible`, `base`, `policies: { tier, savings }`,
     `applied`, `clamped`.

   `decisions.jsonl` is unchanged.
5. `usage.jsonl` rows gain `leaseID`, which the plugin already holds, so a provider request can be joined
   to its lease exactly.
6. Config, in the broker config (devbox `config/opencode-broker/config.json`):

   ```
   "turnEffort": {
     "mode": "off" | "shadow" | "canary" | "enforce",
     "policy": "tier" | "savings",
     "models": ["provider/model", ...]
   }
   ```

   - `models` is seeded with the 8 engine IDs above.
   - `shadow` records everything and changes nothing.
   - `canary` enforces `policy` only for eligible sessions whose sessionID hash is even. That gives a
     measured comparison between the two halves.
   - `enforce` applies `policy` to every eligible lease.
   - An invalid `turnEffort` is normalised to `mode: "off"` with a `console.error`, the shared loader's
     behaviour. `bin/opencode-broker` exposes `configError` in `/status`, and it alone may refuse to
     start on an invalid value.
7. `/preview` keeps showing the unstepped variant, because it has no turn class. The HUD shows the
   applied variant from the routed message.

### S4. Error handling

- An exception in `classifyTurn` gives `normal` / `classifier-error`. The plugin logs it once per session
  and turn. It never fails a turn.
- The broker treats a missing or unknown `turnClass` as `absent`, which is not eligible. An older plugin
  or broker therefore works unchanged in either order.
- Stepping uses only levels in the advertised, ceiling-clamped set, so no new error path exists.

### S5. Testing and measurement

- `classifyTurn` table test built from real shapes: every go-ahead and its trailing punctuation, option
  tokens, typo variants (accepted for words of 5 or more characters, rejected for `no`/`do`/`n`), stack
  traces in both languages, status patterns that do and do not start the text, "check the migration
  ..." (normal), a 1,001-character task, subagent briefs, a risk floor with and without a tier raise,
  and `light` then go-ahead resuming `hard`.
- Broker tests:
  - the variant for each mode, class and policy;
  - the canonical-rank stepping over a non-ascending advertised list (`["high","max"]`) and the `low`
    floor;
  - an undefined base; the ceiling clamp and the `clamped` flag;
  - each eligibility gate alone (mode, absent class, subagent, capability false, model not
    allowlisted);
  - the `canary` hash split;
  - the `turn-effort.jsonl` row shape and rotation;
  - invalid config falls back to off.
- A drift test: the seeded `turnEffort.models` equals the engine's eligibility routes. It reads the fork
  file when present and is skipped with an explicit message otherwise.
- Plugin tests:
  - the class is threaded through `ensure()` and `route()` and computed once per `chat.message`;
  - `effortUpdates` is captured from `chat.params`;
  - `previous` follows the carry-over rules and is bounded.
- HUD/TUI tests: a variant-only routed change switches the chat bar as a managed switch, and
  `model-default.json` never receives a stepped variant. That includes two `model.switched` events in
  one turn.
- Engine test (fork): the `chat.params` input carries `effortUpdates` true with the flag on and false
  with it off.
- Replay: `scripts/turn-effort-replay.mjs` reads the fork session DBs read-only (paths and tables
  above, plus `opencode-fork-debug-agent-stdout-drain.db`). It prints the class split per policy, with 5
  sample prompts per class truncated to 120 characters. Holden reviews it before shadow mode.
- Report: `scripts/turn-effort-report.mjs` joins `turn-effort.jsonl` with `usage.jsonl` on `leaseID`. It
  excludes title and compaction rows. It shows the class split and output tokens per turn per class,
  and a cache tripwire: the first-request `cacheRead/prompt` on eligible turns where the effort changed,
  against those where it did not.
  - Shadow data alone can show the split, but not what a policy would save.
  - `canary` data shows measured output and cache per policy half.

### S6. Rollout

1. Ship with `mode: "off"`. The engine change is part of the next fork build, which keeps the
   `OPENCODE_CHANNEL=fork/snip-always-prefix` rule from FORK.md.
2. Run the replay; Holden reviews the class split.
3. `mode: "shadow"` for a few days, then the report.
4. `mode: "canary"` with `policy: "savings"`, only with Holden's approval, then the report.
5. Holden picks `policy` and sets `mode: "enforce"`.
6. Changing mode or rolling back means editing the config and running
   `systemctl --user restart opencode-model-broker.service`, because the config is read at startup.
   Running TUIs keep the old plugin until they respawn.

## Non-goals

- A classifier model, embeddings, or any per-turn network call.
- Classifying subagent briefs. Per-seat effort tuning, if the report shows it is needed, is config
  (`target.effort[tier]`), not new rules.
- Changing tiers, models, ceilings, the risk-floor regex, or Manual Model behaviour.
- Effort steps on models outside `turnEffort.models`, or on engines that do not report the capability.

## Open risks

- The go-ahead and status lists are English and tuned to Holden's phrasing. A miss falls back to
  `normal`, today's behaviour, so it costs only the missed saving.
- `HIGH_RISK` matches some ordinary words (`investment`, `medication`, `tax`). Under these rules a
  false positive raises the tier as today and adds no effort step on top.
- The engine can still fall back for a request (for example, anchors lost after a transform). That
  request then carries a top-level change. The cache tripwire in the report watches for this.
- The 1,000-character threshold comes from the length split. The replay and report exist to correct it
  before enforcement.
- Quality effects of `savings` cannot be measured from logs. Holden judges them during `canary`.
