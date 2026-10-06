# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A model id the provider no longer offers fences that target instead of quarantining the
  provider.** opencode raises `ProviderModelNotFoundError` client-side with no HTTP status, so
  the `404 && modelEvidence` gate never matched it and the fault scored `other` — the default
  evidence path, which indicts the provider. On 2026-10-06 at 02:07:15 `openai/gpt-6-luna`
  sat in `resolvable-models.json` (refreshed 00:08) and answered "Model not found: ... Did you
  mean: gpt-5.6-luna" at 02:07, because the ChatGPT account gates its offered list on the
  Codex client version. openai went dark whole — `gpt-terra`, `gpt-flagship`, `gpt-astra` and
  `gpt-6-1-sol` with it — leaving the build tier one busy `local-27b`, and the broker answered
  432 worker and 17 build lease requests `target-busy`, which callers see as a failed dispatch.
  It then cycled every 30 minutes: probation admits one lease, that lease hit the same id, and
  the probation branch re-quarantines on contact. The error class is now evidence in its own
  right, so the fault takes the existing `model` scope that fences the hit target and records
  nothing against provider health; the next inventory refresh is what removes the id.

### Changed

- **The session burn alarm is calibrated to 3.5M weighted tokens in five minutes.** An 8.5-day
  replay of 41,872 real cloud requests across 1,787 session trees (subagents rolled into their
  roots through parent links recovered from the session DB, task-tool records and workflow child
  records) measured a healthy tree p99 of 0.95M in 5 min and a worst case of 2.71M after
  attributing every deleted-session request to the busiest tree. 3.5M sits 1.29x above that
  worst-case healthy peak and still catches the worst runaway of the original calibration week
  (3.94M). `sessionStopTokens` (6M) and the rewrite thresholds are unchanged. See the
  calibration paragraph in `lib/burn-watch.js` for the full numbers.

- **Burn-watch alerts fire per session TREE, and the all-sessions aggregates were removed.** The
  router plugin now walks `parentID` up to the root and names it on every `/usage` report, so the
  burn watch rolls a fan-out of subagents into their root for the session-spend check. Stops stay
  per actual session on its OWN weighted spend inside `sessionSpendWindowMs` — only the looping
  child is stopped, never its tree, and no sibling's spend can push another session over the
  line. The tree only notifies; it never stops. After a stop the counters restart from zero for
  the continued session, and the stopped session's entries are dropped from the tree history
  (that spend has been acted on). The stop title no longer carries the provider id; the body
  names the model as `providerID/modelID` and, for a subagent, says `(a subagent of <root>)`. The
  session-spend notify body says `across N subagent session(s)` only when `N > 0`, counting
  distinct children of the root (never the root itself). The two all-sessions `{kind}` values
  the notifier used to receive, `provider-spend` and `plan-rise`, no longer occur: in the
  fourteen days before the removal they fired 47 of 49 alerts for 2 real stops (17
  provider-spend, 30 plan-rise), always a parallel burst of healthy sessions summing past a
  fixed line, and the fan-out case they existed for is now handled by the tree rollup of the
  per-session check instead. The surviving `{kind}` values are `session-spend` (title: `Burn
  watch: session <root> is burning abnormally`) and `stop` (title: `Burn watch stopped a
  session`). `rootSessionID` lands in `usage.jsonl` only when it differs from the session
  itself, so older readers of the log keep parsing it unchanged.

### Removed

- **`burnWatch.providerSpendTokens`, `providerSpendWindowMs`, `planWindow`, `planRisePoints`, and
  `planRiseWindowMs` are no longer used.** A config that still carries any of them loads
  unchanged with one stderr line per key explaining it is ignored; the remaining thresholds keep
  tuning normally.

### Added

- **Session-bound gateway requests.** opencode reaches its subscription providers through the
  fleet gateway, and the router plugin has already leased the turn's model by then. A request
  carrying `x-opencode-session-id` (plus `x-opencode-lease-id`, which the plugin now sends for
  `anthropic` and `openai`) is forwarded on that session's own lease, for exactly the model it
  names, after a new read-only broker check, `/lease/verify`. The gateway makes one attempt and
  does no lease accounting of its own; the plugin owns the lease. Loopback only; a session with
  no matching live lease gets a 409 the plugin classifies as its own route error. Before this,
  the gateway re-leased every such request from its default worker tier, so Claude turns failed
  whenever the worker lanes were fenced.

- **Per-tier local share.** `tierLocalShare` (e.g. `{ "build": 4, "review": 4 }`) reserves one in N
  new assignments on a non-Worker Auto tier for its local target. Worker keeps
  `workerLocalShareDenominator`; a `tierLocalShare.worker` entry is rejected, not silently ignored.
- **`planUsage.keyFile`** for the `http` plan-usage source: the credential is read from an
  owner-only key file (refused if group- or world-readable), as the gateway reads its provider
  keys, instead of from an `authRef` entry in opencode's `auth.json`.
- **`forwardSessionHints` per gateway provider.** The router plugin's session hints
  (`x-opencode-session-id`, `x-opencode-session-kind`) are now forwarded to a provider that
  opts in with `forwardSessionHints: true`, on every api it serves. llm-auth-proxy uses the
  kind to pick its prompt-cache TTL (subagent 5m, otherwise 1h) and the id to link request
  fingerprints for prefix-change diagnostics, and strips both before calling Anthropic; until
  now the gateway dropped both on every forward, so every request took the 1h TTL and the
  fingerprint linking saw nothing. The decision is per provider at the forward site, so a
  failover to a lane that did not opt in leaves the hints behind, and invalid values (a kind
  other than `primary`/`subagent`, an id outside `[A-Za-z0-9_-]{1,128}`) are dropped silently.
  A session id is a fleet-internal identity and must never reach a third-party upstream.

### Fixed

- **Engine-owned compaction can finish after a local context-overflow failover.** The router now
  temporarily accepts the failed model only for that session's `compaction` turn, continues to
  reject every other routed-model mismatch, and clears the exception after the replacement turn
  completes. Before this, a subagent that overflowed a local window was re-leased to a larger
  model while the engine's own compaction still ran on the local one, and that compaction died as
  a "routed model mismatch". A compaction error on the displaced model is still not charged to
  the replacement lease; the queued re-engage continues the session there.

- **Malformed string reconciliation provider IDs now fail closed before apply or overlay writes.** Empty,
  uppercase, and non-slug provider IDs report `provider-id-invalid`; non-string provider IDs continue
  to reach the existing loud identity validation, while well-formed IDs outside the allowlist remain
  `provider-not-allowlisted`.

- **Configured cloud-model pins now retire older discovered models in their own catalog family.**
  Discovery resolves each standard pin against its provider catalog and reports older, same-family
  subscription candidates as `superseded by pin <targetID>` instead of letting them compete in a
  tier. Newer models, other family lines, and fast-versus-standard variants remain eligible.
  `opencode-broker-watch` prints these retirements to stdout as `discovery retired ...`; genuine
  admission failures stay on stderr.

### Added

- **The gateway serves `POST /v1/embeddings`.** A request names a gateway model whose profile maps
  to the new `embedding` tier; the gateway leases with `api: "embeddings"` and forwards to the
  leased provider's `/embeddings` (buffered only, `stream: true` is refused). Targets marked
  `embedding: true` are leasable only by such requests, and embedding requests can reach only
  them, so chat work never lands on an embedding model and the reverse. Eligibility uses the
  largest single input, not the whole batch; a batch is capped at 2,048 inputs and the body at
  1 MiB (413). Usage comes from the upstream or is estimated from the inputs alone.

- **Busy local lanes now name a shared model ID once instead of repeating it.** A target's
  identity is its config key, while its `modelID` may be shared across several lanes; wait
  messages now group those busy lanes and retain the original single-target wording.
- **One session can no longer quarantine a provider.** A provider is quarantined only on
  failures across at least two models *and* at least two sessions; evidence now records its
  session. A content-filter block (`content filter`, `content_policy_violation`) is classified
  `payload`: no circuit, no health evidence, no auto re-engage onto a sibling. On 2026-10-01 a
  single blocked turn, re-sent from opus-5-5 to opus-5, quarantined anthropic while openai and
  alibaba were already out, and every large smart session was refused at send.
- **An account without usage credits fences the fast targets instead of failing every turn on
  them.** Anthropic answers fast mode on such an account with HTTP 429 `rate_limit_error` "Usage
  credits are required for fast mode." The gateway dropped the body, the router read its 502 as
  the gateway's own refusal (`noop`), and nothing ever marked the `-fast` targets unusable. The
  gateway now appends a fixed, gateway-owned phrase for that one upstream signal (no upstream
  bytes are echoed), the classifier maps it to `model`, and the broker circuits every `-fast`
  target of that provider for 6 hours (the lapsed-plan hold: an account setting a person has to
  change), leaving the provider and its standard-speed models untouched. `fast-build` falls
  through to its non-fast candidate meanwhile; `/rearm <targetID>` lifts the fence at once after
  credits are bought.
- **Session-bound requests on a speed-alias lease are forwarded instead of refused (#5).** OpenCode
  leases the synthesized alias (`claude-opus-5-5-fast`, `-standard`) but sends the base id
  (`claude-opus-5-5`) on the wire, so the exact-match check refused every such lease with HTTP 409
  and every build-tier subagent on a `-fast` target ended with no output. A lease now also covers
  the id it is an alias of (exactly one trailing `-fast` or `-standard`, nothing looser), and the
  upstream receives the id the client sent rather than the alias, which does not exist upstream.
  Known widening: the rule is lexical, so a lease on a REAL catalog id ending in `-fast` would also
  cover its base id; none is configured today, and the durable fix is for `/lease/verify` to name
  the wire id itself.
- **llm-auth-proxy plan usage is read again.** Its OpenAI route reports `{ windows: [{ percent,
  resetsAt (epoch s), durationSeconds }] }`, not the canonical shape, and the configured `authRef`
  named an `auth.json` entry that never existed. Both readings failed, the last good report served
  indefinitely, and an OpenAI plan at 100% kept reading 89%, so new sessions balanced onto it and
  failed. The proxy shape is now accepted (strictly), and an exhausted window locks the provider
  until its reset.
- **ChatGPT's "model is not supported when using Codex with a ChatGPT account"** opens a model
  circuit for that one model rather than a five-minute target failure with provider evidence.
- **The gateway's own "no provider could serve the request" refusal no longer quarantines a
  provider.** opencode's `anthropic` provider can sit behind the fleet gateway; when every target
  was fenced, the gateway's 502 was recorded as an `other` failure against the anthropic target,
  and two of them quarantined a healthy anthropic. It is now classified `noop`, like the router's
  other self-inflicted errors.

## [1.24.0] — 2026-09-30

### Added

- **Dormant model-promotion runtime.** Trusted subscription models can be represented in authorized
  zero-cost resolver overlays and immutable resolver generations, while the broker can bind clients
  to exact generation manifests, stage compare-and-swap model policy, probe candidates through the
  loopback gateway, require production probation, and roll back qualifying failures. All apply,
  publication, mutation, and scheduling controls remain default-OFF; Package 4 alone activates them
  after deployment cutover gates.

### Security

- **Reconciliation probes authenticate to the gateway without publishing its key.** Enabled apply
  commands read the same private `OPENCODE_BROKER_GATEWAY_KEY_FILE` contract as the gateway (default
  `~/.config/opencode-broker/gateway-key`) and pass the in-memory bearer header only in the probe
  child's stdin bootstrap, never argv, output, state, or protocol traces.

### Fixed

- **Broker state replacement is crash-durable.** Every `broker.json` update now fully writes and
  fsyncs an exact-mode-0600 sibling temp before rename, then fsyncs the parent directory. A failure
  before rename removes the temp and preserves the live file; a directory-sync failure after rename
  reports the already committed state as a warning rather than inviting a duplicate mutation.
- **The production reconciler uses GET for broker model-policy status.** The full production adapter
  test exposed that the shared socket client hardcoded POST even for the broker's read-only status
  endpoint, preventing an enabled apply from reaching its probes.

## [1.23.1] — 2026-09-30

### Fixed

- **Gateway retry errors preserve safe provider attribution.** When a failed provider is the only
  forwardable Responses lane, local retry exhaustion now retains the provider ID and HTTP status
  while redacting the upstream response body from both client and broker failure payloads.

## [1.23.0] — 2026-09-29

### Added

- **Native Anthropic Messages gateway protocol.** `POST /v1/messages` now leases only providers
  with `messagesApi: true`, rewrites only the leased model, preserves native request and response
  shapes, relays Anthropic SSE through `message_stop` without an OpenAI `[DONE]`, and accounts for
  input, output, cache-read, and cache-write tokens.
- **Explicit per-API provider capabilities.** Chat remains enabled unless `chatApi: false` is set,
  while Messages and Responses require `messagesApi: true` and `responsesApi: true`; a request with
  no capable provider fails before the broker or any upstream is contacted.

### Security

- **Proxy-provider keys are isolated from OpenCode auth state.** A provider `keyFile` is validated
  as a non-empty regular file with no group or world permission bits and read for each request.
  Proxy requests replace either inbound gateway authentication form with `x-api-key`, forward only
  the native Anthropic header allowlist plus configured headers, and never relay client credentials.

### Fixed

- **Duplicate failure reports are idempotent.** Once a session failure consumes its lease, repeated
  router/guard reports return the original result instead of extending or changing the circuit.
- **Synthesized model modes inherit catalog reasoning capability.** Resolver-visible `-fast` and
  `-standard` static targets now receive their base model's variants, so policy ceilings cannot
  reject a valid lease merely because models.dev has no separate alias row.

## [1.22.0] — 2026-09-29

### Added

- **Catalog-native reasoning capability and policy ceilings.** Reasoning variants now come from OpenCode's
  `reasoning_options` catalog data, including synthesized fast/standard model IDs, while per-target
  `effortCeiling` limits deployment policy without mirroring capability lists in config.

### Changed

- **Classifier children now use one broker-owned lease.** The routed `classifier` tier selects and applies the
  model and variant, inherits only the owner's LAN egress boundary, refreshes cloud inventory when eligible,
  keeps heartbeat coverage, and leaves abort/retry lifecycle ownership with the guard.
- **Implicit Auto always routes through the broker.** A saved default model no longer locks an implicit-Auto
  root outside routing; explicit Manual Model remains the sole intentional broker bypass.

### Security

- **Inventory publishers are fenced by the exact loaded config bytes.** Full and auth-only publications carry
  the import-time config fingerprint, so stale panes cannot restore old admission or capability state.
- **Abandoned lease acquisition cannot mutate broker state.** The daemon rechecks client abandonment after
  probes and immediately before cursor, assignment, or lease mutations, and local-only requests skip cloud
  plan refreshes.

## [1.21.1] — 2026-09-29

### Fixed

- **Gateway wait inheritance.** Mapped models without their own `prepareWaitMs` now inherit the global wait after
  config loading, while an explicit zero still disables waiting.
- **Swap restoration ownership.** The HUD now restores displaced models only for swapped sessions owned by that OpenCode
  process, so unrelated session deletion and process exit cannot interrupt gateway-only model loads.

## [1.21.0] — 2026-09-29

### Added

- **Model reconciliation now collects official evidence and asks before it guesses.** A bounded
  request queue feeds a read-only researcher run through the fleet gateway, whose output is
  validated against the role's own official domains and the exact candidate model before it can be
  stored. An unambiguous same-role successor becomes `auto-eligible` on its own; a new role, a
  contradiction or a comparative-only claim becomes `awaiting-approval` and gets one Gitea issue
  whose `decision/approved` or `decision/rejected` label is authoritative -- closing it is not
  approval, and both labels at once changes nothing. Every transition pushes exactly one ntfy
  event. Routing is still untouched: nothing is published, probed or activated.
- The Gitea projection holds its ground against everything that can happen to an issue between two
  runs. A decision made with `opencode-broker-reconcile approve|reject` while a projection is
  mid-flight is kept, and the label decision that would have overwritten it is reported instead of
  applied. An issue closed without a decision label is reopened **once** even if the instructional
  comment that follows fails: the reopen and the comment carry separate durable markers, so the
  comment is retried alone and a second undecided close stays closed. An issue an operator deleted
  is detected from the forge's own 404, clears only that pointer, and is proposed again on the next
  run, while any other forge failure leaves the pointer untouched. A 2xx answer whose body is not
  JSON -- a proxy or a login page in front of the forge -- now fails with the method, path and
  status and never the body it came with.

### Security

- **The gateway key file is now held to the same standard as the reconciler's forge token.** This
  endpoint fronts paid quota, and the key was being read with a plain `readFileSync` -- a `0640`
  drop file left by a deploy script was accepted in silence, while the Gitea token already refused
  one. Startup now requires a non-empty regular file with no group or other permission bits and
  stops with the path and the mode named, and never the key, when it is anything else. The check
  follows symlinks on purpose: a link is `0777` on Linux and always will be, so the mode that
  matters is the target's. The tenant token is deliberately exempt -- its documented deployment is
  a root-owned `0640` file whose group is how the gateway reads it at all.
- **`reconcile.gitea.enabled: true` now requires `baseURL`, `owner` and `repo`.** Omitting them
  fell through to a destination the code picked, so a deployment that turned the projection on
  without naming a forge would have filed issues about its models into a repository its operator
  never chose -- and had no reason to go looking at. An incomplete destination now leaves the
  projection OFF and reports `reconcile.gitea.configError` plus one startup line naming exactly
  the missing fields. It reports rather than throws because routing, the plugin and the TUI all
  import the config module, and a misconfigured publisher must not become an outage.

### Fixed

- **The reconciliation ledger's lock can no longer be stolen from a live writer.** It was a
  mkdir that published an empty directory and recorded its owner immediately afterwards, so for
  the microseconds in between a live holder looked ownerless -- and the recovery path for an
  ownerless lock is to take it. Worse, a writer that proved an owner dead then deleted *whatever*
  occupied the lock path, which by then could be the live instance that had replaced it: a
  textbook time-of-check/time-of-use window onto two writers inside one read-modify-write of the
  file that records which models were approved. The lock is now published by renaming a fully
  built private directory onto the lock path, so its `owner` record is already inside it the
  instant it is visible; a rename onto a populated directory fails and moves nothing, which makes
  the `instance.<pid>.<uuid>` file inside the lock the thing that holds it. A reclaim is a single
  unlink of the *exact* instance that was observed dead, and an `ENOENT` there is read as "another
  actor won, touch nothing else". The lock directory is never deleted recursively again. A
  private directory whose construction fails partway -- after its `mkdir`, before its records
  exist -- removes itself before the failure is reported, because the sweep that collects
  abandoned ones only deletes on proof the identity inside is dead and a half-built directory has
  no identity to prove anything with, so it would have accumulated under the state root forever.
- **A recycled pid no longer reads as a live lock owner.** Liveness was `kill(pid, 0)` alone, which
  answers "live" for whatever unrelated process inherited that number after a reboot or a pid
  wraparound -- so a lock nobody held could be honoured until it timed out, and on the other side
  a genuinely dead writer's lock could be waited on forever. The owner record now also carries the
  Linux boot id and the process start time from `/proc/<pid>/stat`, and a mismatch in either is
  proof the recorded writer is gone. Anything unreadable -- `EPERM`, a missing field, no `/proc` --
  still reads as live, because guessing wrong in that direction costs a decision. Locks written by
  an older build are still understood, and an empty lock directory, which is all a writer killed
  mid-acquisition can leave, is now taken over at once instead of after the full wait.
- **A ledger mutation that succeeded is no longer reported as failed.** The rename is the commit
  point, but the `fsync` of the directory entry and a `chmod` came after it and threw on failure --
  so a full disk or an I/O error at that moment told the caller its write had failed while the new
  ledger was already on disk, and a caller that believes that re-runs or misreports a decision.
  The file mode is now enforced on the temp before it is committed, the post-rename `chmod` is
  gone, and a post-commit `fsync` failure reports the committed state and warns. Lock release
  errors, which were swallowed entirely, are reported the same way -- including the one that
  matters most, a release finding its own instance file gone, which means the lock was not
  exclusive while the ledger was being written. Reporting cannot fail the mutation either: the
  warning sink is wrapped where the store is created, so an injected logger that throws -- past
  the commit point, inside release, or inside the sweep that runs before the release function
  reaches the caller -- can no longer bury a committed decision or strand a published lock.
- **A `model-swap` child can no longer grow the gateway's heap without bound.** The tenant routes
  await the child and captured everything it printed, trimming to the last 4 KB only once it
  exited -- so a swap stuck in a retry loop held every byte it had ever written, inside a process
  concurrently serving paid requests. Capture is now trimmed after every chunk to a documented
  32 KiB diagnostic tail. Each stream also decodes through its own `StringDecoder`, so a UTF-8
  character split across two chunks no longer arrives as `U+FFFD` -- which garbled the error line
  exactly when someone was reading it to find out what the swap refused.

## [1.20.0] — 2026-09-29

### Added

- **GPU tenant control routes on the gateway.** `POST /tenant/<id>/acquire`,
  `POST /tenant/<id>/release` and `GET /tenant/<id>` let an app that needs a whole card for a
  while -- an image generator, a training run -- have the resident set rearranged on its behalf.
  It cannot do that itself: it is typically a container with no access to the swap tooling, the
  router or its state directory, while the gateway already spawns `model-swap` for
  `prepareCommand` and already runs on the host that owns the reservation file. `acquire` runs
  `reserve <id> --no-start --wait-active 60` and `release` runs `release <id> --no-stop`, so the
  tenant's own lifecycle stays outside the swap tool's business.
- All three routes answer `{"held": true|false}` -- whether the reservation is **actually on
  file** afterwards, which is deliberately not the child's exit code. `model-swap` prints a
  refusal and exits 0 by design, so a caller trusting the exit code would believe it owns a card
  it does not own; the failure mode that follows is not an error but a silently spilled card,
  where llama.cpp partial-offloads to CPU and still answers HTTP 200.
- The surface has **its own credential and shares nothing with the OpenAI path**. It requires a
  bearer token from `OPENCODE_BROKER_TENANT_TOKEN_FILE` (default
  `~/.config/opencode-broker/tenant-token`), read once at startup so a restart never depends on
  an unlocked secret store, and the gateway key does not authorize it -- a container running
  third-party code gets a token that can move a local model off a card and cannot spend paid
  quota. Each tenant also declares `allowFrom`, and a token presented from any other address is
  refused with the observed address logged, so a wrong list costs one request to diagnose
  instead of presenting as a silent 401 on every job. No token file, no `tenants` block or an
  empty `allowFrom` all mean closed: there is no permissive default. A `tenants` block with no
  token file is logged once at startup, naming the tenants nothing can reach, because its only
  other symptom is every request 401ing with nothing in the log -- the address log runs after
  the token check and never sees those. The routes are dispatched ahead of every other URL, so
  a tenant path can never fall through into a completion.
- **`opencode-broker-tenant-token`** creates that token as the drop file the deploy needs:
  256 bits of `base64url` (an alphabet no shell, YAML or systemd file can mangle) written
  `root:<group>` mode `0640`, staged and renamed so a chown it cannot perform leaves no
  half-deployed file, and the path reported instead of the value so the secret never reaches
  scrollback or a deploy log. It **refuses to overwrite an existing token** unless `--force`:
  the tenant reads its bind-mounted copy when the container starts, so a rotation has to be
  paired with restarting the tenant and must never be a side effect of re-running a deploy.
- **Provider model reconciliation now has a safe dry-run foundation.** A validated provider-role
  registry drives the existing family-tier discovery policy, and `opencode-broker-reconcile dry-run`
  refreshes isolated catalog/resolver inputs, records idempotent candidate observations, reports stale
  or unresolved blockers, and previews the legacy reviewed-model import without publishing inventory
  or changing routing.

## [1.19.1] — 2026-09-28

### Fixed

- **A lapsed subscription no longer occupies the usage sidebar.** `/status` keeps reporting a
  provider's budget after its plan lapses, because that spend history is diagnostic, so the HUD
  went on drawing a stale percentage row for it plus a `circuit til HH:MM` note that the
  background check renewed every six hours -- two permanent lines for a plan nobody holds. The
  sidebar now drops a provider whose `provider:` circuit reads `plan-lapsed`, along with its
  health note and its session usage badge. Only that reason hides a lane: a quota stop, a bench,
  a quarantine or a probation is a provider still in use, and its note is the only warning anyone
  gets that routing is avoiding it. Nothing is muted -- the lapse and the recovery each push a
  notification as they happen, and the row returns on its own once the plan is renewed. With every
  budgeted provider lapsed the block reads `(no active providers)` instead of standing empty
  under its heading, and still carries the stale marker when the broker has stopped answering.

## [1.19.0] — 2026-09-28

### Added

- **`profileLocalShare`**: a named profile whose lane mixes local and cloud targets can now be
  balanced like `auto` worker routing -- one in N leases to its local target when it has a free
  slot, the rest by weighted depletion across the cloud providers, and a full local target sends
  the lease to cloud instead of waiting. Without it such a profile only ever reached its local
  target once every cloud target was out. Built for an ingestion lane (supermemory) that had been
  local-first with a single cloud overflow rung.

### Fixed

- **A synthetic prompt no longer moves a root session onto the pane's default model.** A
  background-job notice, re-engage or `oc_send` names no model, so opencode stamps it with the
  pane default, and the router passed that on as the session's preference. On 2026-09-28 a job
  notice moved a gpt-5.6-sol root onto claude-opus-5 while the pane still showed Sol, and each
  side's next turn then failed `routed model mismatch`, back and forth. A prompt with no
  user-authored text now keeps a routed root on its current model, as subagents already were;
  a typed prompt still carries the user's model choice.

## [1.18.0] — 2026-09-28

### Changed

- **Every tier balances across providers.** At equal headroom (within the 2% epsilon, which is
  every provider early in a week) the old tiebreak let a model's tier fit pick the provider, so a
  whole tier went to one: all 11 new review leases since 14:29 on 2026-09-28 went to
  claude-sonnet-4-6 (review fit 1.4) over an idle gpt-terra, draining the anthropic 5h window.
  Tied providers now take turns for new sessions, in configured order. The order of tiebreaks is
  headroom, then a configured `tierProviderWeights` lean, then an active usage deal, then the
  provider rotation, then model fit within the chosen provider. Fit no longer scales the
  utilization providers are compared on. Decisions report `provider-rotation-at-equal-headroom`.
- **A burst window binds when it is on pace to run out,** not only past `burstFence`: spent share
  divided by the elapsed share of the window, from one fifth of the way in. Anthropic's 5h at 41%
  with 54% elapsed stays on the weekly figure; 60% at 40% elapsed now steers new sessions away.

### Fixed

- **A subagent is no longer moved to another provider by a message it did not choose.** A prompt
  that names no model is stamped with the pane default, and the router passed that as the
  session's preferred model: a gpt-5.6-sol `sp-implementer` 24 steps in was re-leased onto Opus,
  a 170k-token cold write. Once routed, a subagent's preference is the model it is already on.
  Re-engage prompts also carry the session's own agent instead of falling back to `smart`.

### Added

- **`x-opencode-session-id` on anthropic requests**, beside the session kind, so claude-proxy can
  fingerprint prompts per session and name the part that changed when a request misses the cache.

## [1.17.0] — 2026-09-28

### Added

- **Cache lifetime hint for claude-proxy.** The router plugin's new `chat.headers` hook sends
  `x-opencode-session-kind: primary | subagent` on anthropic requests, so the proxy writes
  1-hour cache entries for root sessions (which sit idle while a human thinks or a subagent
  runs) and 5-minute entries for subagents (which run back to back, then end). This matches
  Claude Code on the same plan: over 60k requests, 97% of its main-session cache writes were
  1-hour and 99.9% of its subagent writes 5-minute. Other providers get no header, and an
  unknown session sends none, leaving the proxy's 1-hour default.

## [1.16.0] — 2026-09-28

### Fixed

- **The broker no longer goes mute when clients give up on it.** It stayed `active (running)`
  from 2026-09-24 01:46 to 09-28 13:25 while answering nothing, so every opencode session kept
  its last fallback model (`FALLBACK:qwen-max`) long after Anthropic had recovered. The cause:
  clients time out after 2.5 s and retry, but the request they abandon stays in the broker's
  serial queue, and `parseBody` never settles on a dead socket — it waited for `end`/`error`,
  neither of which fires. The 30 s handler deadline therefore charged every abandoned request
  30 s, and once the queue was 2.5 s deep everything behind it was abandoned too, while retries
  kept refilling it. Reproduced: five abandoned requests held one `/status` for 150 s. Requests
  whose client has gone are now dropped at the head of the queue at no cost, and `parseBody`
  rejects on `close`. The same scenario now answers in under half a second.
- **A lapsed subscription plan idles its provider instead of failing one model at a time.**
  An expired Alibaba token plan answers every model with 403 `AccessDenied.Unpurchased`,
  "Access to model denied" — the same words as a per-model entitlement denial, and the code
  was lost because opencode ships the provider body only as the `responseBody` string. It was
  classified `model`: qwen-max was fenced permanently (never coming back after a renewal) and
  every sibling model was left to fail in turn. The provider code is now read from
  `responseBody`, and `Unpurchased` is a provider-wide `quota` stop held until the background
  provider check below sees the renewal (6 hours is only the backstop).

### Added

- **Provider checks** (`lib/provider-check.js`). Each provider gets the best signal it offers,
  so neither a lapse nor a recovery has to be discovered by a user's prompt. Providers with a
  live usage reading are judged on the refresh every request already makes; only providers
  without one are polled, every 5 minutes, outside the request queue:
  - `budgets.<provider>.check: { type: "count-tokens", url, model }` — a free Anthropic-compatible
    `count_tokens` call. Alibaba answers it 403 `AccessDenied.Unpurchased` on a lapsed plan and
    200 on a live one (verified 2026-09-28). It can lift a lapse, never a window-quota stop,
    since counting is not metered.
  - Providers with a `planUsage` source use a *fresh* reading (never the cached last-good):
    OpenAI's `plan_type: "free"` is a lapse, and an unlocked reading lifts a failure-reported
    quota stop older than 15 minutes. On deployment this released an openai stop held on a
    guessed 17:05 reset while its own usage API already said `allowed: true`.
  - Transitions are logged (`provider-check-lapsed` / `provider-check-recovered`) and pushed
    through `burnWatch.notifyCommand`.
- **Stalls are visible.** A request that waited 10 s or more in the queue, or hit the handler
  deadline, is logged to the journal and sent through `burnWatch.notifyCommand` (at most one
  push per 10 minutes). `/status` now reports `queue`: depth, abandoned requests skipped, slow
  waits, deadline hits and when the last one happened.
- **`opencode-broker health [timeout-ms]`**: a liveness check for timers. Exits 0 when `/status`
  answers and the queue is draining, 1 when nothing answers, 2 when it answers but is backed up.
- **The HUD shows `BROKER DOWN`** once `/status` has failed for 30 s, instead of the session's
  stale `FALLBACK:` badge (the marker is cleared only by a healthy lease, so a mute broker left
  it naming the wrong problem).

## [1.15.1] — 2026-09-24

### Fixed

- **A full primary no longer pre-empts a delayed fallback rung.** The context-overflow last
  resort fires whenever nothing is available and a context size was supplied, and it reads the
  rung list unfiltered by design — so a lane whose primary was merely *busy* fell straight
  through to the roomiest cloud window, and any delay configured on the rung it reached became
  decorative. Measured on a live lane configured to wait 60 s: 183 cloud leases in eight minutes.
  The rescue now runs only when context is genuinely what disqualified everything. A target that
  fits the request but is full is a wait — the broker returns `target-busy`, the caller retries,
  and the rung still opens once its delay elapses — while a request nothing can hold even with
  every slot free still gets the roomiest window, because a refusal there is unrecoverable.
- **The gateway now names a lane whose credential fails to resolve.** An expired OAuth token
  makes `providerKey` throw; the gateway releases the lease and skips the lane, and deliberately
  files no `/failure` because a stale *local* credential must not indict a healthy provider. With
  no log line that was completely invisible: the only trace was cloud leases in the decision log
  with no matching usage, which reads like a routing bug rather than an expired token. The lane
  and the reason now reach both stderr and the client-visible error.

## [1.15.0] — 2026-09-23

### Added

- **A profile's fallback rung can now be made to wait before it opens, with
  `profileFallbackAfterMs`.** A rung has always opened the instant the profile's own lane had
  nothing eligible, which is right for an interactive lane and wrong for a bursty background one
  sharing a scarce target: "my lane is busy" arrives constantly, so the rung stops being overflow
  and quietly becomes a second primary. The new setting takes one non-negative delay per rung,
  positionally, and holds that rung shut until the caller has actually waited that long. A rung
  with no entry opens immediately, so every rung that existed before this release behaves exactly
  as it did — the setting can only ever delay a rung, never introduce one. Delays are attached to
  their rung before the cloud-target drop that `profileCloudEgress` governs, so a rung deleted for
  naming a cloud target on a LAN profile takes its delay with it instead of shifting another
  rung's delay onto a neighbour. Once two rungs are both open the earlier authored one wins, so
  delays need not increase.
- **`/lease` accepts `waitedMs`,** the milliseconds a caller has already spent waiting for its
  primary, and the gateway now reports it. The clock starts at the first *waitable* refusal rather
  than at request arrival — a slow answer is latency, not time spent queuing — and resets for each
  upstream forward attempt, because attempt two has not waited for anything yet. The request
  deadline stays shared across attempts, so a retry still cannot buy itself a second full wait
  window. A zero-budget caller never accrues a wait, preserving tell-me-now behaviour. An invalid
  value is refused rather than coerced: read as 0 it would hold a delayed rung shut forever, and
  read as huge it would surrender a scarce slot immediately.
- **`/preview` reports `delayedProfileFallbacks`.** A preview answers for the present moment, so a
  rung that is merely *not yet* open reads as `null` — indistinguishable from a profile that has no
  fallback at all. The new field names each delayed rung and its threshold so a reader can tell
  "nothing behind this" from "not yet". The existing `preview` object is unchanged.

Two paths deliberately ignore the delay. Refusal classification keeps seeing every rung, so a
full-but-delayed rung still reads as `target-busy` — "keep waiting" — rather than "no target
exists"; on a lane where a refusal is a permanently lost record, that distinction is the whole
difference. The context-overflow last resort also keeps seeing every rung, so a session too big
for every window is never denied the roomiest one merely because its clock has not run out.

### Fixed

- **A profile whose only local target sat in a fallback rung could never reach it.** The
  resident-model set was fetched only when the profile's *primary* lane named a local target, and
  a local target judged without that set is ineligible by definition — so a profile with a cloud
  primary and a local rung behind it refused forever, reporting "no eligible target" rather than
  naming the rung. Residency is now fetched whenever a local target appears anywhere in the
  profile's eligible set. This shape was previously unused, and a per-rung delay invites it.

## [1.14.0] — 2026-09-23

### Changed

- **The usage log now keeps the prompt's cache split, so a burn-watch stop can be audited
  after the fact.** Each `usage.jsonl` line recorded only `prompt` — the total of fresh
  input, cache reads and cache writes — which is the size that has to fit the window but
  cannot say how much of it was actually uncached. The burn watch stops a session on
  exactly that distinction (`lib/burn-watch.js` counts a step as a full rewrite when fresh
  input is at least half the prompt), yet the ledger it rode on threw the split away, and
  opencode deletes a stopped session's own token history. So when a session was stopped for
  "re-sending its whole prompt uncached", nothing on disk could confirm or refute it. The
  record now also carries `input`, `cacheRead` and `cacheWrite`, always present including
  zero — a `cacheRead: 0` beside a large `prompt` is the uncached-resend signal. `prompt`
  keeps its exact meaning, and `opencode-broker usage` is unchanged.

## [1.13.0] — 2026-09-23

### Fixed

- **The assignment cap no longer spends live sessions' sticky pins on dead gateway
  traffic.** The 512-entry cap and the 14-day TTL both worked — measured on this host,
  `broker.json` sat at exactly 512 assignments and 65 KB, not growing — but the cap
  ranked entries purely by `updatedAt`, and that is the wrong order. `updatedAt` moves
  only on a fresh *selection*: `/touch` and held-lease revalidation refresh the lease and
  leave the assignment's timestamp untouched, so an active session's pin ages as though
  it were idle. Meanwhile the gateway mints a new `sessionID` per client request and
  never reuses it, so each one-shot completion leaves an assignment that nothing can ever
  read again. Those dead entries were *newer*, so they outranked real pins: 450 of the
  512 were settled gateway one-shots, and one of ten live leases already had no
  assignment left at all. A session that lost its pin gets re-rolled onto a different
  model mid-task and re-reads its whole transcript — the exact failure session stickiness
  exists to prevent, arriving through the sweep instead of through selection. Eviction is
  now tiered: an assignment whose session still holds a live lease is never evicted, and
  settled `oneShot` entries are all spent before the first session pin, each tier
  oldest-first. When pins are evicted anyway the daemon says so on stderr with the counts,
  since reaching that point means the cap is below the host's real session concurrency.
  The cap, the TTL, selection, and the `sessionRebalance` cooldown are all unchanged.
  The tier applies to the entries a host **already has**, not only to new traffic: the
  455 gateway assignments already on disk here predate the `oneShot` flag and carry no
  such field, so read literally they would have counted as session pins and sat protected
  ahead of real pins for the full 14-day TTL — leaving this fix inert on exactly the
  traffic it was written for. An entry with no flag whose id starts with `gw-` is read as
  one-shot, which is the gateway's own naming contract (`gw-<time36>-<rand>`) and is
  enforced on the other side by the refusal below. No manual state surgery is needed on
  an existing `broker.json`.
- **A live lease's assignment now survives the 14-day age rule too, not just the cap.**
  The TTL evicted on `updatedAt` alone, which the same paragraph above explains is not
  evidence of idleness: a session that only ever revalidates a held lease (`replace:
  false`) refreshes `lease.touchedAt` and never the assignment, so after 14 days of that
  pattern the lease was alive and its pin was deleted underneath it. The age rule now
  skips any session that still holds a live lease, which is what the tiered cap already
  promised.
- **One-shot assignments are dropped when their lease ends,** at `/release`, `/complete`
  and `/forget`, instead of waiting for the cap to reclaim them. An ordinary assignment
  outlives its lease because the session's next turn reads it back; a one-shot id never
  recurs, so there is no next turn and no reader. This keeps settled gateway traffic out
  of the assignment map entirely rather than parked in it until the cap overflows.

### Added

- **`oneShot` on `/lease`.** A caller whose `sessionID` is minted per request and never
  reused declares it with `oneShot: true`; the broker records it on the assignment, the
  cap discards those entries first, and the end-of-lease endpoints drop them outright. It
  has no effect on selection or stickiness. The bundled gateway now sets it on every lease
  it takes. The declaration is **refused** for a `sessionID` that does not start with
  `gw-`: `oneShot` asks for preferential eviction, so a caller that set it on a real
  session id — a copied request body, a proxy that sets it for everything — would hand the
  cap a live pin to spend first, and that is the original bug in new clothes.

## [1.12.1] — 2026-09-23

### Fixed

- **The daemon no longer trusts a publisher's inventory.** Model admission shipped in
  1.12.0 lives in `plugin/router.js`, which every opencode process loads at spawn, so a
  pane started before the fix keeps publishing the old unfiltered inventory on every
  `chat.message`. Seconds after a clean `systemctl --user restart
  opencode-model-broker.service` reported `discovered: []`, one such pane republished
  `gpt-6-astra`, `gpt-6-luna` and `gpt-6-sol`, and `/preview` again routed the worker
  tier at `openai/gpt-6-luna` — a model this host cannot resolve, so every worker-tier
  session died with `ProviderModelNotFoundError`. `/inventory` ingest now applies the
  same admission filter server-side: it intersects published targets with the host's
  resolver-view snapshot, drops anything unresolvable or with a malformed model id, and
  drops that model's `modelContexts`, `modelOutputs` and `modelVariants` entries with
  it. The snapshot is read from disk per ingest, never by running `opencode models`.
  Fail-closed matches the publisher: a missing or unusable snapshot admits nothing and
  leaves every tier on its configured static pins. Every drop is logged with its
  provider, model id and reason; the `/inventory` response contract is unchanged.
- **A restart no longer resurrects unresolvable targets from `broker.json`.** Ingest is
  only one of the two ways discovered inventory enters the daemon; the other is the
  state file it reloads at startup. A daemon poisoned before the filter existed has
  already persisted those targets, so `gpt-6-astra`, `gpt-6-luna` and `gpt-6-sol` came
  back on the next restart with no client publishing anything, routing the deep, worker
  and smart tiers at models this host cannot resolve until some later ingest happened to
  clean them out. `readState` now applies the same admission filter to the stored
  inventory, with the same fail-closed semantics: a missing or unusable resolver-view
  snapshot admits nothing and every tier keeps its configured static pins. Scope is the
  discovered inventory alone — leases, circuits, health, budgets and plan usage keep
  their existing shape-normalization. A load-time drop is reported on stderr as
  `broker.json` rather than `/inventory`, so the operator can tell a state file already
  on disk from a publisher still running; a clean start logs nothing.

## [1.12.0] — 2026-09-23

### Fixed

- **Catalog discovery no longer admits models this host cannot resolve.** models.dev
  is a catalog, not a resolver: it lists every model a vendor ships, while opencode
  resolves only what the deployment's provider configuration admits. When the catalog
  published `gpt-6-astra`, `gpt-6-luna` and `gpt-6-sol`, discovery minted targets for
  all three, they outranked the configured pins on release date, and every lease on
  them died client-side with `ProviderModelNotFoundError: Model not found:
  openai/gpt-6-luna` — 11 worker-tier and 8 deep-tier failures, with no provider error
  to trip a circuit, so the tiers stayed down. Discovery now intersects the catalog
  with the host's own resolver view and drops what is not in it.

### Changed

- Resolvable-models snapshot now emits a staleness warning when older than 72 hours,
  and the watch job reuses the in-memory model set instead of re-reading the snapshot
  file.

### Added

- **Resolver-view snapshot.** `opencode-broker-watch` now records what this host can
  actually address (`opencode models --pure`) as `resolvable-models.json` in the
  routing state directory, next to the model catalog it already refreshes. The
  publication path inside `chat.message` reads that snapshot rather than running the
  subprocess, so no prompt pays for it. A missing or unusable snapshot fails closed:
  discovery admits nothing and every tier stays on its configured targets, rather than
  admitting a catalog the host may not resolve. A failed or empty listing throws
  instead of writing an empty view.

- **Discovery admission is reported, never silent.** Every model dropped at admission
  is returned to the caller with its provider, model id, would-be tiers and reason
  (`unresolvable` or `invalid-model-id`); `opencode-broker-watch` logs one line each.
  A model id that is not a usable model reference at all is dropped on shape alone,
  with or without a resolver view.

## [1.11.0] — 2026-09-22

### Added

- Per-model tier override for gateway leases.
- Routing fixture coverage for explicit targets, quota/circuit eligibility, aliasing, and stickiness.

### Changed

- Add configurable strict model-name allowlisting and ordered advertised IDs; enforcement remains disabled by default for compatibility.

## [1.10.0] — 2026-09-22

### Added

- **Generic authenticated HTTP plan-usage sources.** A provider budget can set
  `planUsage.type` to `http`, name an absolute HTTP or HTTPS URL, and select an
  exact auth-file entry with `authRef`. The broker sends the resolved credential
  only as `x-api-key`, accepts only canonical multi-window reports, refreshes
  credentials after the cache TTL, and degrades endpoint failures to the last
  good report or local estimates.

## [1.9.0] — 2026-09-21

### Changed

- **The gateway serves waiting requests in arrival order.** Every waiter used to
  retry the broker on its own timer, so a freed slot went to whichever retry landed
  first, often a request that had only just arrived. Measured on a memory service's
  3-slot lane after 1.8.0: median wait 55 s, p99 27 minutes, worst 40 minutes,
  against a 50-minute budget. A request that outwaits its budget is a lost call.
  Waiters on one profile now form a queue. Only the head retries, a newcomer does not
  try ahead of a non-empty queue, and a head that gets its lease wakes the next one
  immediately, so several slots freeing together drain without a retry interval
  between them. A name with `prepareWaitMs: 0` never waits, so it never queues.

## [1.8.0] — 2026-09-21

### Added

- **`holdOpenMs` for a gateway name keeps a long buffered wait alive.** The gateway can
  hold a request for many minutes waiting for a slot or a model (`waitForLocal`,
  `prepareWaitMs`), but a non-streaming request is silent all that time, and clients
  give up on silence. Bun's fetch drops the connection after about 5 minutes with no
  bytes ("The operation timed out."). Measured live: a memory service's cron retried
  11 documents at once into a 3-slot lane. Every call the gateway parked past 5 minutes
  died client-side while its 50-minute budget still had 45 minutes to run, and each one
  was a document marked failed with its memories lost.

  With `holdOpenMs`, a buffered request still unanswered after that long gets its
  `200` head and a space every `holdOpenMs` until the JSON follows. Leading whitespace
  is valid JSON. A request that settles sooner is untouched and keeps its real status;
  a failure after the commit arrives as the error object under the 200. Streaming
  requests never take this path.

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
