# Per-turn Effort Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify each real main-session user turn as normal, light or hard. In the broker, step the
tier effort accordingly, only for engines and models that can change effort without rewriting the
cached prefix. Start in `off`, then move to `shadow`.

**Architecture:** A pure classifier in `lib/turn-effort.js` runs in the router plugin's `chat.message`.
The class travels in the `/lease` body. A pure resolver in the same module computes the `tier` and
`savings` policies and the eligibility. The broker `/lease` handler applies the resolver to the
`publicTarget` variant and logs a compact row to a rotated `turn-effort.jsonl`. The fork engine adds
`effortUpdates` to the `chat.params` hook input so the plugin knows whether the engine can apply a
change cache-safely.

**Tech Stack:** Node ESM (`node --test`), the broker in `bin/opencode-broker`, the plugin in
`plugin/router.js`, the shared config in `lib/config.js`, and the fork engine (TypeScript, Bun 1.4.2)
for Task 6.

**Spec:** `/home/dev/opencode-broker/docs/superpowers/specs/2026-10-12-turn-effort-selector-design.md`

## Global Constraints

- Test command (repo root): `node --experimental-test-module-mocks --test tests/*.test.mjs gateway/tests/*.test.mjs hud/tests/*.test.mjs`.
  A single file is run as `node --experimental-test-module-mocks --test tests/<file>.test.mjs`.
- `plugin/router.js` exports exactly one factory (`ModelRouter`). Helpers live in `lib/`.
- Config loading never throws (`lib/config.js` convention; the new `lib/turn-effort-config.js` follows
  it). An invalid value is logged with
  `console.error` and normalised to a safe default: `turnEffort.mode: "off"`.
- The canonical effort rank is `none < minimal < low < medium < high < xhigh < max` (a new
  constant; `REASONING_MODES` in `lib/model-roles.js:28` lacks `minimal`/`max` and stays unchanged).
- Default config is `turnEffort.mode: "off"`. With mode `off`, `/lease` responses and the plugin's
  lease bodies may only ADD fields; existing fields and the returned variant must be unchanged.
- Prompt text must never be logged: no `turn-effort.jsonl` row and no log line may contain it.
- The other sessions' uncommitted files in `/home/dev/opencode-broker` are NOT yours. They are
  `hud/tests/hud.test.mjs`, `hud/tui.js`, `lib/config.js`, `lib/outage-policy.js`,
  `tests/helpers/model-outages.mjs` and `tests/model-outage-config.test.mjs`; check
  `git status --short` at task start. Never stage or revert them.
  - If a task must edit one of those paths (`lib/config.js`, `hud/tui.js`), STOP and report: the
    controller decides.
  - Stage only your own files, by explicit path.
- Commit to `main`, one commit per task. Messages describe the change. Do not push; the controller
  pushes.
- No emoji, no TODO without owner and reason, no swallowed errors.

## Review Focus

1. Default-off identity: with `turnEffort` absent or `mode: "off"`, every `/lease` response variant
   equals today's for every tier (test it across all tiers and a model with an `effortCeiling`).
2. Go-ahead resume: a `light` status turn followed by `continue` resolves to the last
   substantive class, not `light`. Pin it in Task 1's tests.
3. A Manual Model session and a subagent session are never stepped and never change variant (Task 4
   tests).
4. A stepped variant never reaches `model-default.json` through the HUD's model-switch sync (Task 5
   test).
5. A broker restart with an invalid `turnEffort` still routes, with mode off and
   `turnEffortConfigError` visible in `/status` (Task 3 test).

---

### Task 1: Turn classifier (`lib/turn-effort.js`)

**Files:**
- Create: `lib/turn-effort.js`
- Test: `tests/turn-effort-classify.test.mjs`

**Interfaces:**
- Produces: `export function classifyTurn({ text, isSubagent, riskFloor, riskRaisedTier, previous })`
  returns `{ class: "normal"|"light"|"hard", reason: string, resolvedFrom?: "normal"|"hard" }`.
  It also exports `TURN_CLASSES = ["normal","light","hard"]` and
  `TURN_REASONS` (the set of all reason strings: `subagent-seat`, `go-ahead`, `risk-floor`,
  `explicit`, `failure`, `long-task`, `status`, `default`, `classifier-error`, `absent`).
  `export function nextPrevious(previous, result)` returns the carry-over value.

- [ ] **Step 1: Write the failing table test.** In `tests/turn-effort-classify.test.mjs`, import
  `classifyTurn` and `nextPrevious` and write one `test` per row below. Each row is
  `[input, expected class, expected reason, expected resolvedFrom?]`; the default input is
  `{ isSubagent:false, riskFloor:null, riskRaisedTier:false, previous:undefined }`.
  - Subagent: `{ text: "x".repeat(2000), isSubagent: true }` gives `normal`/`subagent-seat`.
  - Go-aheads with `previous: "hard"` give `hard`/`go-ahead`/`hard`: each of `continue`, `Continue.`,
    `go!`, `  yes `, `do it`, `you do it`, `approve`, `approved`, `push`, `try again`, `keep going`,
    `sounds good`, `a`, `1`, `option b`, `conitnue`, `contnue`.
  - The same go-aheads with `previous` undefined give `normal`/`go-ahead`/`normal`.
  - Not go-aheads: `no`, `do`, `n`, `go fix the parser` give `normal`/`default`.
  - Hard:
    - `ultrathink about the cache layout` gives `explicit`.
    - `it still failing after the patch` gives `failure`.
    - A JavaScript trace (two lines matching `    at foo (/a/b.js:1:2)`) gives `failure`.
    - A Python trace (two `  File "x.py", line 3` lines) gives `failure`.
    - `"a ".repeat(501)` (1,002 characters) gives `long-task`.
    - `riskFloor:"smart", riskRaisedTier:false` gives `risk-floor`.
    - `riskFloor:"smart", riskRaisedTier:true` with text `hi` gives `normal`/`default`.
  - Light: `all good?`, `Status?`, `what did we do so far`, `did it work?` give `light`/`status`.
  - Not light: `check the migration for races and fix it` and
    `summarize the auth flow, then refactor it` give `normal`/`default`.
  - `nextPrevious`:
    - `nextPrevious("hard", {class:"light"})` is `"hard"`.
    - `nextPrevious(undefined, {class:"hard"})` is `"hard"`.
    - `nextPrevious("hard", {class:"normal"})` is `"normal"`.
    - `nextPrevious("hard", {class:"hard", reason:"go-ahead"})` is `"hard"`.
  - Resume sequence: `previous="hard"`. Classify `all good?` (light), then
    `p = nextPrevious(p, r)`, then classify `continue`. The result is `hard`/`go-ahead`.
- [ ] **Step 2: Run the test and see it fail.**
  `node --experimental-test-module-mocks --test tests/turn-effort-classify.test.mjs`.
  Expected: FAIL with `Cannot find module '../lib/turn-effort.js'`.
- [ ] **Step 3: Implement `lib/turn-effort.js`** per spec S1:
  - Normalise the text: trim, lower-case, collapse whitespace, strip trailing `[.!?,]+`.
  - Exact sets: `GO_AHEADS` (spec list) and `OPTION = /^(option )?[a-z0-9]$/`.
  - Typo matching: Damerau-Levenshtein distance of at most 1 against `GO_AHEADS` entries of 5 or
    more characters. Write a small function; no dependency.
  - Hard substrings: `ultrathink`, `ultra-think`, `think harder`, `think deeply`, `go deep`;
    and failure substrings `still failing`, `didn't work`, `doesn't work`, `same error`,
    `still broken`.
  - Trace regexes: `/^\s*at .+\(.+:\d+:\d+\)\s*$/m` and `/^\s*File ".+", line \d+/m`, each with
    at least 2 matches counted with a global flag.
  - Long task: normalised length > 1000.
  - Light: normalised length <= 200, and the text STARTS with one of the status prefixes (spec list).
  - Order of checks: subagent, go-ahead, hard, light, default.
  - `nextPrevious`: a result with `reason === "go-ahead"` keeps the previous value. `light` keeps the
    previous value. Otherwise use the result class (`normal` or `hard`).
- [ ] **Step 4: Run the test and see it pass.** Expected: every row passes.
- [ ] **Step 5: Commit.**
  `git add lib/turn-effort.js tests/turn-effort-classify.test.mjs && git commit -m "Classify routed user turns as normal, light or hard"`

### Task 2: Policy resolver (`lib/turn-effort.js`)

**Files:**
- Modify: `lib/turn-effort.js`
- Test: `tests/turn-effort-resolve.test.mjs`

**Interfaces:**
- Consumes: `TURN_CLASSES` and `TURN_REASONS` from Task 1.
- Produces:
  - `export const EFFORT_RANK = ["none","minimal","low","medium","high","xhigh","max"]`.
  - `export function resolveTurnEffort({ baseVariant, advertised, ceiling, turnClass, engineEffortUpdates, modelKey, sessionID, config })`
    returns `{ eligible, base, policies: { tier, savings }, applied, clamped }`.
    - `config` is the normalised `{ mode, policy, models }`.
    - `baseVariant` is today's resolved variant (string or undefined).
    - `advertised` is the model's advertised list (`string[]`).
    - `ceiling` is `target.effortCeiling` (string or undefined).
    - `modelKey` is `"provider/model"`.
    - `applied` is the variant to return: equal to `baseVariant` unless eligible and the mode applies.
  - `export function canaryHalf(sessionID)` returns `0` or `1`, using a stable FNV-1a 32-bit hash of the
    string, mod 2.

- [ ] **Step 1: Write failing tests** in `tests/turn-effort-resolve.test.mjs`. Base fixture:
  `advertised ["low","medium","high","xhigh"]`, `ceiling "xhigh"`, `baseVariant "high"`,
  `modelKey "openai/gpt-6.1-sol"`, `engineEffortUpdates true`, `turnClass {class:"hard",reason:"explicit"}`,
  `config {mode:"enforce",policy:"tier",models:["openai/gpt-6.1-sol"]}`.
  1. Base fixture: `eligible` true; `policies.tier` `xhigh`; `policies.savings` `high`
     (base minus 1 plus 1); `applied` `xhigh`.
  2. `light`: tier `medium`, savings `low`. Light with base `low`: tier stays `low` (floor);
     savings `low`.
  3. `normal` with policy `savings`: applied `medium`.
  4. Ceiling `high` with hard: tier `high`, `clamped` true.
  5. Non-ascending advertised `["high","max"]`, base `high`, hard: tier `max`. Light: tier `high`
     (no lower advertised level at or above the `low` floor), `clamped` true.
  6. Undefined `baseVariant` (review tier): `eligible` false, `applied` undefined, both policies
     undefined.
  7. Each gate alone makes `eligible` false and `applied === baseVariant`:
     - `mode` `off`;
     - `mode` `shadow`, which still computes the policies;
     - `turnClass` undefined (reason `absent`);
     - `reason` `subagent-seat`;
     - `reason` `classifier-error`;
     - `engineEffortUpdates` false;
     - `modelKey` not in `models`.
  8. `shadow`: policies computed as in case 1, `eligible` true, `applied` `"high"`.
  9. `canary`: two fixed sessionIDs with known `canaryHalf` 0 and 1. Half 0 gets the policy applied,
     half 1 gets base. Pin the two IDs by computing them in the test with the exported function and
     asserting it is deterministic.
  10. An unknown `turnClass.class` (`"weird"`) is treated as absent.
- [ ] **Step 2: Run the tests; they FAIL** (`resolveTurnEffort` is not exported).
- [ ] **Step 3: Implement** per spec S2:
  - Step over `EFFORT_RANK` restricted to the levels that are advertised and at or below the ceiling
    rank.
  - `eligible` is computed before the mode, but `applied` changes only when mode is `enforce`, or
    when mode is `canary` and `canaryHalf === 0`.
  - `eligible` means all gates pass except mode. Mode `off` sets `eligible` false.
- [ ] **Step 4: Run the tests; they PASS.**
- [ ] **Step 5: Commit** `"Resolve tier and savings effort policies for a classified turn"`.

### Task 3: Config section and broker wiring

**Files:**
- Create: `lib/turn-effort-config.js`. Ruling: `lib/config.js` holds another session's uncommitted
  work, and its `raw` parse and comment stripper are module-private. Do NOT edit `lib/config.js`; you
  may read it.
  - Resolve the same path with the exported helpers:
    `envSetting("OPENCODE_BROKER_CONFIG", "OPENCODE_MODEL_ROUTER_CONFIG") ?? configFile("config.json")`.
  - Read the file and strip `//` and `/* */` comments outside strings with a small stripper of your
    own, then parse JSON.
  - Normalise only the `turnEffort` key, modelled on `defaultAgentTier` `:774-779` and `stringList`
    `:501-503`.
  - A missing file, a parse error or an invalid value gives `{mode:"off",policy:"tier",models:[]}`
    plus the exported string `TURN_EFFORT_CONFIG_ERROR`, and a `console.error`. It never throws.
- Modify: `bin/opencode-broker` (the `/lease` handler near `:1800-1859`, `/status` `publicState` near
  `:441`, the logging helpers near `:138-161`).
- Modify: `lib/usage-log.js` (`usageRecord`: add `leaseID`).
- Test: `tests/turn-effort-broker.test.mjs`. Spawn the broker as `tests/preview-context.test.mjs:34-75`
  does, with a temp HOME and a config file.

**Interfaces:**
- Consumes: `resolveTurnEffort` (Task 2).
- Produces:
  - `export const TURN_EFFORT_CONFIG` (from `lib/turn-effort-config.js`), normalised to
    `{ mode, policy, models }`. The default is `{ mode:"off", policy:"tier", models:[] }`.
  - `export let TURN_EFFORT_CONFIG_ERROR` (string or null).
  - `/lease` request fields `turnClass` and `engineEffortUpdates`.
  - Each `/lease` writes one row to `model-routing/turn-effort.jsonl`, rotated like `usage.jsonl`.
  - `/status` gains `turnEffortConfigError`.

- [ ] **Step 1: Write failing tests.**
  1. With no `turnEffort` in the config, `/lease` for tiers `smart`, `build`, `worker` and `deep`
     returns the same `target.model.variant` as a lease without the new fields, and no
     `turnEffort` block appears in the response.
  2. With `{mode:"enforce",policy:"tier",models:[<fixture model>]}`, a lease with
     `turnClass:{class:"hard",reason:"explicit"}, engineEffortUpdates:true` returns the stepped
     variant. The same lease with `engineEffortUpdates:false` returns the base variant.
  3. Each lease appends one JSON row to `turn-effort.jsonl` with exactly the spec S3.4 fields, and no
     field holds a value longer than 200 characters. Rotation: with the file pre-filled past the size
     limit, the next write moves it to `.1`.
  4. An invalid `turnEffort.mode: "always"` still starts the broker. `/lease` behaves as off, and
     `/status` contains `turnEffortConfigError` naming `turnEffort.mode`. A config with `//` and
     `/* */` comments, including a `//` inside a string value that must survive, parses correctly.
  5. `/usage` rows include `leaseID` when the plugin posts it.
- [ ] **Step 2: Run the tests; they FAIL.**
- [ ] **Step 3: Implement.**
  - `lib/turn-effort-config.js` as described in Files.
  - `bin/opencode-broker` `/lease`: after computing `target = publicTarget(...)`, call
    `resolveTurnEffort` with:
    - `baseVariant: target?.model?.variant`;
    - `advertised: state.inventory?.modelVariants?.[key] ?? []`;
    - `ceiling: lease.target.effortCeiling`;
    - `modelKey: \`${providerID}/${modelID}\``;
    - `sessionID: body.sessionID`;
    - `turnClass: body.turnClass`;
    - `engineEffortUpdates: body.engineEffortUpdates === true`;
    - `config: TURN_EFFORT_CONFIG`.

    If `applied !== baseVariant`, return a copy of `target` with `model.variant = applied`. Append the
    row with a `logTurnEffort` helper built like `logUsage`.
  - `usageRecord`: copy `leaseID` from the posted body when it is a string.
  - `/status`: add `turnEffortConfigError`.
- [ ] **Step 4: Run the tests, then the full suite;** they PASS.
- [ ] **Step 5: Commit** `"Step routed effort per turn in the broker, off by default"`.

### Task 4: Plugin wiring (`plugin/router.js`)

**Files:**
- Modify: `plugin/router.js` (`chat.message` `:1152-1243`, `ensure` `:1063-1112`, `route` `:635-749`,
  `chat.params` `:1268-1301`, the usage emitter `:1578-1592`).
- Test: `tests/turn-effort-plugin.test.mjs`. Drive the hooks as `tests/failover.test.mjs:1308-1323`
  does, with a stub broker that records `/lease` bodies.

**Interfaces:**
- Consumes: `classifyTurn` and `nextPrevious` (Task 1). Broker request fields (Task 3).
- Produces:
  - `/lease` bodies carry `turnClass:{class,reason}` and `engineEffortUpdates` on classified turns.
  - `/usage` posts carry `leaseID`.

- [ ] **Step 1: Write failing tests.**
  1. `chat.message` with text `ultrathink the design` on a root session sends
     `turnClass:{class:"hard",reason:"explicit"}` and `engineEffortUpdates:false` (no `chat.params`
     yet).
  2. After a `chat.params` call whose input has `effortUpdates:true`, the next lease sends
     `engineEffortUpdates:true`. An input without the field leaves it false.
  3. Subagent session (parentID set): the class is `normal`/`subagent-seat`. If `getSession`
     fails, `isSubagent` is true.
  4. Manual Model session: no `/lease` is posted at all (existing behaviour) and `classifyTurn` is not
     called. Assert this through the stub broker.
  5. Sequence on one session: `ultrathink x` (hard), then `all good?` (light), then `continue`. The
     third lease sends `class:"hard",reason:"go-ahead"`.
  6. A synthetic-only prompt sends no `turnClass`.
  7. The per-session previous map is bounded through `trimTracker` (create 2,100 sessions, assert
     size <= 2000).
  8. Each turn is classified once even when `ensure()` runs twice on a stale inventory. Count calls with
     a spy via `--experimental-test-module-mocks`.
  9. A classifier throw gives `normal`/`classifier-error`, and the turn still routes.
  10. `/usage` posts include the current `leaseID`.
- [ ] **Step 2: Run the tests; they FAIL.**
- [ ] **Step 3: Implement.**
  - In `chat.message`, after the risk floor, compute
    `riskRaisedTier = floor !== null && raiseTier(baseTier, floor) !== baseTier`. Use the same helper
    `route()` uses, or have `route()` report it.
  - Call `classifyTurn` once, inside try/catch, and store the result in a per-call variable.
  - Thread the result through `ensure(sessionID, agentHint, preferredModel, turnEffort)` into
    `route(session, preferredModel, turnEffort)`, which adds the fields to the lease body.
  - Update `previous` with `nextPrevious` only on real non-synthetic, non-compaction turns.
  - Record `effortUpdates` from the `chat.params` input in a process-level variable.
- [ ] **Step 4: Run the tests and the full suite;** they PASS.
- [ ] **Step 5: Commit** `"Send each turn's effort class and engine capability with the lease"`.

### Task 5: HUD model-default safety

**Files:**
- Test: `hud/tests/turn-effort-hud.test.mjs` (new; do not edit `hud/tests/hud.test.mjs`, which another
  session has uncommitted edits in).
- Modify only if the test fails: `lib/routing.js` (`markManagedModelSwitch` / `consumeManagedModelSwitch`
  `:567-592`), never `hud/tui.js` without controller approval.

**Interfaces:**
- Consumes: the existing managed-switch API in `lib/routing.js:461-592`.

- [ ] **Step 1: Write the test.** For the same session, simulate the HUD flow twice in one turn:
  - `markManagedModelSwitch(id, {providerID:"openai", id:"gpt-6.1-sol", variant:"xhigh"})`, then
    deliver two `model.switched` events with that model to the `tui/tui.js` handler (import its default
    export and drive `tui(api)` with a stub `api.event.on`).
  - Assert that `model-default.json`, under a temp HOME, is never written.
  - Then simulate a USER switch (no marker) and assert that it IS written.
- [ ] **Step 2: Run it.**
  - If it passes, the existing single-slot marker already holds. Commit the test as a regression pin.
  - If the second event is persisted, fix the marker so a managed switch is consumed for every event
    carrying the same model within a short window. Then show RED, then GREEN.
- [ ] **Step 3: Commit** `"Pin that routed effort steps never become the saved model default"`.

### Task 6: Engine reports effort-update capability (fork)

**Files (fork repo, deployment branch `fork/effort-combined`; work in a NEW worktree, never the main
checkout, which holds Holden's uncommitted files):**
- Modify: `packages/plugin/src/index.ts:254-263`. Add `effortUpdates?: boolean` to the `chat.params`
  input type.
- Modify: `packages/opencode/src/session/llm/request.ts:114-132`. Pass `effortUpdates` in the
  `chat.params` input. `request.ts` does not read config, so add an `effortUpdates: boolean` field to
  `PrepareInput`, set by `llm.ts` from `cfg.experimental?.effort_updates === true` (`llm.ts:291-293`).
- Test: extend `packages/opencode/test/session/llm.test.ts` or `effort-llm.test.ts`, whichever has the
  plugin-trigger harness. A test plugin captures the `chat.params` input and asserts `effortUpdates`
  is true with the flag on and false with it off.

- [ ] **Step 1: Write the failing test; run it; see it FAIL.** Use
  `PATH=/home/dev/.local/share/opencode-effort-toolchain/bun-1.4.2:$PATH bun test --timeout 30000 <file>`
  from `packages/opencode`.
- [ ] **Step 2: Implement; run the test, the effort suites and `bun run typecheck`.** Typecheck must be
  clean on `fork/effort-combined`.
- [ ] **Step 3: Commit** `"Tell chat.params plugins whether mid-conversation effort updates are on"`.
  Do not build or install; the controller does that with `OPENCODE_CHANNEL=fork/snip-always-prefix`
  per FORK.md.

### Task 7: Replay and report scripts

**Files:**
- Create: `scripts/turn-effort-replay.mjs` and `scripts/turn-effort-report.mjs`
- Test: `tests/turn-effort-scripts.test.mjs`. Use fixture DBs built with `node:sqlite` (Node 24), in a
  temp dir, with tables `session(id,parent_id)`, `message(id,session_id,time_created,data)` and
  `part(id,message_id,session_id,time_created,data)`, plus fixture JSONL files.

**Interfaces:**
- Consumes: `classifyTurn` and `nextPrevious` (Task 1). The `turn-effort.jsonl` and `usage.jsonl` row
  shapes (Task 3).

- [ ] **Step 1: Write failing tests.**
  - The replay prints the class split for main sessions and 5 samples per class, each truncated to 120
    characters, and opens DBs read-only (`?mode=ro`).
  - The report joins on `leaseID` and prints per class: turns, mean output tokens, and the cache
    tripwire ratio for changed versus unchanged `applied`.
  - Rows without a `leaseID` match are counted as `unmatched`, not dropped silently.
- [ ] **Step 2: Implement; run the tests; they PASS.**
  - DB paths default to the three fork DBs named in the spec, and the replay takes `--db` overrides.
  - The report reads `~/.local/share/opencode/model-routing/` by default.
- [ ] **Step 3: Commit** `"Replay stored turns and report turn-effort decisions"`.

### Task 8: Rollout (controller, not a subagent)

- [ ] Push `opencode-broker` `main`. Add `"turnEffort": {"mode":"off","policy":"tier","models":[<the 8 IDs>]}`
  to devbox `config/opencode-broker/config.json`, commit and push.
- [ ] Restart the broker: `systemctl --user restart opencode-model-broker.service`. Then check
  `/status` (no `turnEffortConfigError`) and that a lease variant is unchanged.
- [ ] Build the fork with Task 6 per FORK.md (channel rule) and install it with a rollback copy.
- [ ] Run the replay and show Holden the class split.
- [ ] Set `mode: "shadow"`, restart the broker, and confirm rows appear in `turn-effort.jsonl`.
- [ ] After a few days, run the report. `canary` and `enforce` need Holden's explicit approval.
