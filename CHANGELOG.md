# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] — 2026-09-21

### Fixed

- **opencode's session titles.** Title generation runs on `small_model` and only fires
  `chat.params` (agent `title`), never `chat.message`, so it has no route of its own. The plugin
  checked it against the conversation's route and rejected it as a model mismatch whenever the
  session was on any other model. 60 of 69 root sessions in a week kept opencode's placeholder
  title. The `title` agent now passes untouched. Point `small_model` at the gateway to have it
  leased and counted like everything else.
- **A LAN-only lease no longer waits for a plan-usage refresh.** Every `/lease` awaited a due
  refresh of the providers' plan windows, which can take seconds (one usage API is allowed 20 s),
  even for a lane that can never reach a cloud target and so has no plan to admit against. For a
  latency-critical local caller, such as a command classifier with a 25 s budget that fails
  closed, that wait was pure risk. Leases on profiles that cannot reach the cloud now skip it.

## [1.6.0] — 2026-09-21

### Added

- **The broker's logs say who asked.** Every gateway request is its own anonymous `gw-...`
  session, so `decisions.jsonl` and `usage.jsonl` could not tell a memory service's ingestion
  from a document extractor or a chat UI. The gateway now sends `caller: { address, model }` on
  `/lease` and `/usage`: the client's address (IPv4-mapped form normalized) and the model name
  it sent. The broker records it on that session's decision lines and on its usage lines, and
  `opencode-broker usage` lists each model's top callers (`opencode` for routed sessions). A
  caller that does not look like an address or a short printable name is dropped, never logged
  raw.

## [1.5.3] — 2026-09-21

### Added

- **`mirrorTextFormat: true` copies a /responses `text.format` into chat's `response_format`.**
  llama.cpp serves /responses but ignores `text.format`: a strict JSON schema came back as prose,
  or as fenced JSON with keys the schema never named. The same endpoint enforces
  `response_format`, so a lane with this flag gets the format mirrored (json_schema and
  json_object; never over a `response_format` the client set itself).

## [1.5.2] — 2026-09-21

### Fixed

- **A `waitForLocal` name kept waiting only while the broker stayed up.** The broker client
  retries a refused socket once, 250 ms later, and a broker restart outlasts that, so every
  request such a name had parked in the wait loop failed when the broker was bounced. Measured:
  36 waiting ingestion requests stopped at one broker restart. An unreachable broker is now
  waited out on the same budget as a busy or absent model, for `waitForLocal` names only; others
  still fail at once.

## [1.5.1] — 2026-09-21

### Fixed

- **A caller waiting for a local slot no longer floods `decisions.jsonl`.** Every re-lease a
  waiting caller made was logged as its own "waiting" decision. A burst of 36 background requests
  waiting their turn wrote ~850 B/s, which would have truncated the 4 MiB decision trace, and
  every routing decision in it, within half an hour. A session's wait is now logged once, and
  then at most once a minute, until it is leased or refused. The live `/selection` state still
  shows every wait.

## [1.5.0] — 2026-09-21

### Added

- **`POST /v1/responses`, the OpenAI Responses API.** The Vercel AI SDK's OpenAI provider calls
  it by default, so clients built on it (firecrawl's extraction, for one) got a 404 from the
  gateway and had to point at llama.cpp directly, where the broker could not see them. It rides
  the same leasing, lane and name `bodyExtras`, `dropBodyKeys`, failover and accounting as chat.
  What differs: it goes to the lane's `/responses`; usage is read from `input_tokens` and
  `output_tokens` (on `response.completed` when streamed); and a stream gets neither
  `stream_options` nor a `[DONE]`, and fails with the API's own `error` event.
- **`responsesApi: true` marks a provider that serves `/responses`**, and only those are offered a
  /responses lease. llama.cpp serves it natively; Anthropic's compat endpoint and most
  OpenAI-compatible clouds do not, and a 404 there would score as a provider fault until the
  lane's circuit opened, taking it away from chat as well. With no such lane configured the
  gateway answers 502 and says so, without asking the broker.

## [1.4.0] — 2026-09-21

### Added

- **`waitForLocal` on a gateway model name.** A busy local slot was already waited out for
  every caller, but a local-only lane with no resident model answers `no-eligible-local-target`,
  and the gateway failed that at once. That happens during a model-server restart (~70 s) or a
  swap that displaced the model. A name with `"waitForLocal": true` now waits that refusal out on
  its `prepareWaitMs` budget as well. It is for background writers where a failed call is lost
  data. A self-hosted memory service, for example, records a failed extraction as "no memories"
  and never tries the document again. Names without it still fail fast.

## [1.3.0] — 2026-09-21

### Added

- **A mapped model name can carry its own `bodyExtras`**, layered over the provider's key by
  key. A key set to `null` injects nothing, so the client's own value, or the model's default,
  stands. A lane whose `bodyExtras` turn thinking off for every local model can now serve one
  name with that model's default (`"chat_template_kwargs": null`) without moving any other name.
- **Usage log** (`lib/usage-log.js`, `usage.jsonl` in the routing state directory) and an
  `opencode-broker usage [days]` report. Every `/usage` report now also appends one line: session,
  model, the lease's target/profile/tier, `prompt` (input + cache read + cache write) and `output`
  tokens. Tuning a local model's window and slot count needs the real size distribution, and
  nothing kept it. opencode deletes subagent and workflow child sessions, and their token history
  with them, so the database keeps a small, biased sample: 15 sessions on a local model over two
  weeks, where the broker had leased it for hundreds. The lease-time `contextTokens` in
  `decisions.jsonl` misses each session's peak, because a subagent's single long turn grows past
  its starting size. The report gives per-model request and session-peak percentiles, and for
  each local target the share of session peaks that fit what it routes. Rotated at 8 MB with one
  previous generation kept, so the history outlives a busy week.

## [1.2.0] — 2026-09-21

### Added

- **Slot watch** (`lib/slot-watch.js`, config `slotWatch`). Once a minute the broker reads
  llama.cpp's `requests_deferred` for each resident model a local target names. That count
  includes services that call the model server without a lease, which the broker's own caps
  cannot see. Two non-zero readings in a row notify through `burnWatch.notifyCommand` with
  `{kind}` = `slot-deferred`. This is the check that `capacity` and `modelCapacity` actually
  keep a shared model from queueing.

### Fixed

- **A headless `opencode run` without `--agent` leased the default tier, whatever its default
  agent was.** `chat.message` receives the agent the caller named, and a run that names none
  leaves it unset: opencode resolves its default agent onto the user message only after that
  input is built, and a fresh session's record may not carry the agent yet. The router now
  reads the agent from the message itself before falling back to the session. Measured before
  the fix: four headless runs of a `smart` default agent, all leased `worker`, with no
  smart-tier request ever reaching the broker.

### Changed

- The example config's classifier and coder share one model through `modelCapacity`, the
  way the burn-watch and slot-limit work was measured.

## [1.1.0] — 2026-09-21

### Added

- **`modelCapacity`: a model-wide slot limit for local targets that share one
  model.** Two targets can name the same local model (a coder lane and a
  classifier lane on one small model, say), and per-target `capacity` let them
  claim more slots between them than the server has; it also left nothing for a
  caller that reaches the model server without a lease, such as a command
  classifier that calls it directly and fails closed when it times out.
  `modelCapacity` is how many leases the model may already carry, summed over
  every target that names it, for this target to take another. `capacity` still
  caps the target's own share, and a target without `modelCapacity` behaves as
  before. Reclaiming idle leases now also frees a quiet lease on a sibling
  target that is holding a target full.
- **Burn watch: a runaway session is stopped by its rate, whatever caused it**
  (`lib/burn-watch.js`, config `burnWatch`). A loop of any shape (a compaction
  that repeats, a context-pruning plugin that keeps invalidating the prompt
  cache) could spend a large share of a plan window before anyone noticed. The
  broker already receives every cloud request's tokens on `/usage`, so it now
  watches the rate there:
  - **Stop:** 4 or more steps in five minutes that each re-send most of the
    prompt uncached (100K+ fresh tokens), 1.5M+ between them; or 6M weighted
    tokens (input + output + cache write + 0.1 x cache read) from one session
    in five minutes.
  - **Notify only:** one session at 3M weighted tokens in five minutes, one
    provider across all sessions at 3M, or the provider's own `5h` plan window
    rising 6+ points in ten minutes.

  The defaults come from replaying a week of real usage and are all config. A
  stop rides back on the `/usage` reply as `burn: { stop: true, reason }`; the
  router plugin that reported the step aborts that session's turn and shows a
  toast with the reason. Nothing is deleted, and the counters restart so
  continuing is deliberate. Alerts run `burnWatch.notifyCommand` (default:
  `watch.notifyCommand`), at most once per subject per 15 minutes, and every
  stop is logged to `decisions.jsonl` as `policy: "burn-stop"`. Local providers
  are never counted. On by default; `burnWatch.enabled: false` turns it off.
- **Placeholders in notify commands.** `watch.notifyCommand` and
  `burnWatch.notifyCommand` replace `{title}`, `{body}` and `{kind}` wherever
  they appear, so a notifier that wants a priority or a tag after the message
  can be called directly. A command naming neither `{title}` nor `{body}` gets
  both appended, as before.

### Changed

- **The broker sizes a local window the same way everywhere.** Selection
  admitted a target that declares `outputReserve` up to `context -
  outputReserve`, but the broker's eligibility re-check and its busy test used
  the headroom fraction instead (147,456 against 117,964 tokens on a 196,608
  window). A session between the two was leased the model, judged ineligible
  for it on the next turn, and moved off it mid-task. Both checks now apply the
  reserve.

## [1.0.0] — 2026-09-21

The first public release. The project was developed privately as
`opencode-router` (0.1.0 to 0.53.0), next to two companion packages,
`opencode-gateway` (0.1.0 to 0.6.0) and `opencode-hud` (0.1.0 to 0.15.0). This
release renames it, folds both companions into one package, and moves every deployment-specific decision out of the code
and into config. Several changes break an existing config; the old names are
still read where noted, and the broker lists each one it still relies on at
startup and under `deprecations` in `opencode-broker status`.

### Changed (breaking)

- **The project is now `opencode-broker`.** Package name, log prefixes
  (`[opencode-broker]`), the plugin log service name, and plugin ids
  (`opencode-broker-hud`, `opencode-broker-model-default`) follow.
- **Command-line tools are renamed** to share the package's prefix:
  `opencode-model-broker` is `bin/opencode-broker`, `opencode-model-watch` is
  `bin/opencode-broker-watch`, and the gateway's `fleet-gateway-server` is
  `gateway/bin/opencode-broker-gateway`.
- **The config directory moves** from `~/.config/opencode-model-router/` to
  `~/.config/opencode-broker/` (honouring `XDG_CONFIG_HOME`). The old directory
  is still read when the new one has no `config.json`, with a deprecation note.
- **Environment variables are renamed:** `OPENCODE_MODEL_ROUTER_CONFIG` is now
  `OPENCODE_BROKER_CONFIG`, and `OPENCODE_MODEL_ROUTER_LOCAL_MODELS_URL` is now
  `OPENCODE_BROKER_LOCAL_MODELS_URL`. The old names still work and are reported
  as deprecated. `OPENCODE_MODEL_BROKER_SOCKET` and `OPENCODE_MODEL_ROUTING_DIR`
  are unchanged, and so is the state directory.
- **The agent-to-tier mapping comes from config.** `tierForAgent` no longer
  knows any deployment's agent names. `agentTiers` maps exact names and
  trailing-`*` prefixes to a tier, `inherit` or `classifier`, merged over
  defaults built on opencode's own agents (`build`, `plan`, `general`,
  `explore`), tier-named primary agents, and opencode-guard's `fleet-classifier*`
  agents. `defaultAgentTier` catches the rest. A deployment that relied on the
  old table must declare the agents it used (`sp-implementer`,
  `review-verifier`, `verifier`, `tester`, `reviewer`, `review-*`,
  `researcher`); a test pins that such a block reproduces the old table exactly.
- **Routing profiles come from config.** Every key of `profiles` is a profile,
  offered in the order written. Profiles named `private` or ending in `-offline`
  are offline unless `offlineProfiles` says otherwise; titles are derived from
  the name unless `profileTitles` sets them. A profile the config does not
  declare no longer exists.
- **The build-to-smart fold (0.52.0) is config.** Set
  `"tierAliases": { "build": "smart" }` to keep it. Aliases may only point to a
  stronger tier, so a risk floor is never undercut.
- **The HUD's deployment-specific parts are config** under `hud`: picker copy,
  badges and the loading notice per profile (`hud.profiles`), and the swap-back
  that restores the resting models (`hud.swapBack`), which is off unless a
  command is configured. `OPENCODE_MODEL_SWAP` and the built-in swap script path
  are gone. Profiles without copy get a description derived from what they are.
- **HUD command ids are renamed** from `fleet.*` to `hud.*` (`hud.mode.cycle`,
  `hud.mode.show`, `hud.agents.list`, `hud.menu`, `hud.routing.profile`,
  `hud.usage.toggle`); keybinds in `tui.json` must use the new ids.
- **The gateway's config moves** from `~/.config/opencode-fleet-gateway/config.json`
  to `~/.config/opencode-broker/gateway.json` (still read from the old path, with
  a deprecation note), and its key file defaults to
  `~/.config/opencode-broker/gateway-key`. `OPENCODE_FLEET_GATEWAY_KEY_FILE` is
  deprecated in favour of `OPENCODE_BROKER_GATEWAY_KEY_FILE`.
- **The gateway listens on 127.0.0.1** unless `HOST` is set. Set `HOST=0.0.0.0`
  to serve the LAN as before.
- **The gateway's routed model id is `routed`** (configurable with
  `routedModelId`) instead of `fleet-routed`. Only the `/v1/models` listing
  changes: any model name that is not mapped still routes on the configured tier.

### Added

- **The gateway and the HUD are part of the package** (`gateway/`, `hud/`),
  covered by the one `npm test`.
- **A session janitor** (`plugin/session-janitor.js`, `lib/session-janitor.js`)
  that deletes the child sessions native `task` delegation leaves behind, once
  it can prove each one finished and idle. The protocol is the one
  opencode-agent-workflows 0.11.0 uses internally; it never depended on that
  project's workflow engine, so it is shipped here as a standalone plugin with
  its own registry directory (`OPENCODE_SESSION_JANITOR_DIR`).
- **opencode-guard is optional for the HUD.** The permission-mode badge, the
  mode cycle key and the floor menu appear only when the guard is detected (its
  package, plugin file, a mention in `opencode.json`, or its state files), or
  when `hud.permissionModes` or `OPENCODE_BROKER_HUD_GUARD` says so.
- The HUD finds opencode-background-shells' job store as an installed package or
  at `hud.backgroundShells`, instead of at a fixed sibling path.
- `examples/minimal.config.json`, and a test that both example configs parse.
- The gateway compares its key in constant time.
- MIT license, contribution and security policies, and CI on Node 20 and 22.

### Removed

- A test that exercised a private delegation script outside this repository.

## [0.53.0] — 2026-09-21

### Removed

- The primary-agent switch mode and the tier-gate module (`plugin/tier-gate.js`,
  `lib/tier-gate.js` and their exports), together with the HUD's switching menu,
  picker and question auto-reply. Off had been the default, and with it on,
  sessions ratcheted *down* whenever a hand-back question was auto-answered.
  Escalation is done by dispatching work to a stronger agent instead; the
  content-based safety floor is unchanged. The `tier-gate-audit.json`,
  `tier-switch.log` and `agent-switch-mode.d/` state files are no longer written.
- The tier lifts that only ran in the switch mode's "automatic" setting.

## [0.52.0] — 2026-09-21

### Changed

- **A session keeps its model.** The broker pins each session to its last
  assignment, and `/forget` (called at every idle) releases only the lease. A
  session moves only when its model cannot serve it: circuit open, quota, not
  loaded, outgrown, or released on purpose (`releasePin`, sent when a displaced
  session is restored). Measured before the change: 146 mid-session model
  changes in three days, each a different model re-reading a transcript it did
  not write.
- **No live rebalancing.** Moving a live session to a less-used provider handed
  long tasks to a different model mid-task. Balancing now happens only when a
  session gets its first model; the `sessionRebalance` keys are inert.
- **Context pressure moves a session only to a strictly larger window.**
- **The build tier leased the smart lane** (moved to `tierAliases` in 1.0.0).
- **The safety floor matches the safety topic, not words code also uses**
  ("circuit breaker", "wiring", "stroke", "short circuit" no longer bump a
  coding brief to the strongest tier).

### Added

- **A busy local model is waited out instead of refused.** A resident local
  target that fits the request and is ineligible only because every slot is
  taken answers `code: "target-busy"`. The router plugin retries `target-busy`
  and `target-preparing` for up to 10 minutes (`leaseWaitMaxMs`,
  `leaseWaitStepMs`) and shows one toast, and the gateway waits it out for every
  request.

## [0.51.0] and earlier

Private development of `opencode-router` 0.1.0 to 0.51.0, `opencode-gateway`
0.1.0 to 0.5.0 and `opencode-hud` 0.1.0 to 0.14.0. Their per-release notes are
in the git history of `CHANGELOG.md`, `gateway/CHANGELOG.md` and
`hud/CHANGELOG.md`.
