# Broker-native classifier routing, zero model pins, and inventory publisher fencing

Date: 2026-09-29
Status: Design, awaiting review
Repos touched: `opencode-broker`, `opencode-guard`, `devbox` (fleet config + tests)

## Problem

Three coupled defects, all instances of one root pattern: **capability and model
selection are mirrored by hand into config and agent frontmatter instead of being
derived from, and assigned by, the broker.**

1. **Model pins bypass the broker.** Seven agents carry `model:` frontmatter:
   `fleet-classifier`, `fleet-classifier-local`, `fleet-classifier-haiku`,
   `standard`, `smart`, `deep`, `fast-build`
   (`devbox/config/opencode/agent/*.md`, deployed copies under
   `~/.config/opencode/agent/`). The classifier three are load-bearing today because
   the classifier lane is deliberately **not routed**; the other four are
   broker-overridable in Auto but still decide the model for implicit-Auto and
   Manual Model. `scout`, `grunt`, `build`, `tester`, `reviewer`, `researcher` are
   already unpinned and route cleanly, which is the proof that pins are unnecessary.

2. **The classifier lane cannot be routed because the guard pre-leases.**
   `opencode-guard/plugin.js:380` leases `tier: classifier` with a synthetic
   `leaseID`, then creates a child session whose pinned agent supplies the model.
   If that child were also routed by the broker plugin it would lease a **second**
   slot on a capacity-2 local target for one classification
   (`opencode-broker/plugin/router.js:407-427`), so routing is refused and the pin
   is the only thing that sets the model. `classifier.json.brokerAgents` is the
   hand-maintained mirror mapping each leasable target to its pinned agent.

3. **Capability discovery reads the wrong catalog field, forcing a stale mirror.** The
   OpenCode catalog carries discrete effort levels in
   `reasoning_options[].values` (`type: "effort"`), but broker discovery reads the
   nonexistent `model.variants` field (`lib/model-candidates.js:121`,
   `lib/routing.js:1055`). That yields no discovered variants and forced
   `CONFIG.modelVariants` (`lib/config.js:788-799`, frozen at import) to mirror
   catalog capability by hand. That mirror is overlaid onto catalog discovery in
   `buildCachedSubscriptionInventory` (`lib/routing.js:1286`). A long-lived OpenCode
   process holds the pre-edit config in module memory; because `/inventory` has no
   config-generation fencing, a late publish from that old process is accepted and
   **last accepted publisher wins**, restoring a key deleted from config hours
   earlier. Reproduced live 2026-09-29: `anthropic/claude-haiku-4-5` variants
   `["low","medium","none"]` reappeared in `broker.json` at 17:28:49Z, from disk
   config that no longer contained them, driven by a cloud-reaching lease from an
   OpenCode process started before the deletion. Separately,
   `bin/opencode-broker-watch:58-60` swallows a publication failure without a nonzero
   exit, so systemd success does not prove publication.

## Goals

- Every non-Manual model choice is assigned by the broker. Zero `model:` pins in any
  agent, source or deployed.
- The command classifier is routed through the ordinary broker machinery, taking
  exactly one lease and one capacity slot per classification.
- Capability (reasoning variants) is derived from the OpenCode catalog's actual
  `reasoning_options` schema, including synthesized `-fast`/`-standard` modes. Config
  carries policy ceilings, never a second capability list.
- A stale or mismatched-config publisher cannot overwrite the broker's inventory.
- `local`/`private` and any LAN-confined owner can never have command text sent to a
  cloud classifier. This invariant is enforced at lease time and fails closed.
- Explicit F11 **Manual Model** remains the sole intentional broker bypass.

## Non-goals

- No change to per-turn effort selection (shelved; V2-gated, see the per-turn-effort
  spec).
- No change to the reconciliation ledger, gateway tenant tokens, or provider admission
  beyond the `modelVariants` removal.
- No new classifier targets or tiers; the classifier lane keeps its configured targets.

## Design

### 1. Remove all agent model pins

Delete the `model:` frontmatter line from all seven pinned agents. Delete the two
target-specific classifier agents entirely, leaving a single unpinned
`fleet-classifier`:

- Removed files: `fleet-classifier-local.md`, `fleet-classifier-haiku.md`
  (source under `devbox/config/opencode/agent/`, plus both symlink layers per the
  per-file symlink contract: `~/.config/opencode/agent/` -> `fleet-core/...` ->
  source).
- Depinned files: `fleet-classifier.md`, `standard.md`, `smart.md`, `deep.md`,
  `fast-build.md`.

An unpinned agent routes exactly like `scout`/`grunt`/`build` today: the child session
is created with no explicit model, and the broker plugin assigns provider/model/variant
on `chat.message` via `applyMessageModel`/`applyOutputModel`
(`plugin/router.js:832-836`). OAuth provider auth resolves through the same in-band path
those agents already use; the pin was a static convenience, never an auth requirement
(verified: `session.create` with `agent` and no model resolves auth like any Task
child, and unpinned agents work in production).

### 2. Route the classifier through the broker

**Guard (`opencode-guard/plugin.js`):**

- Delete the pre-lease (`brokerRequest("/lease", ...)` with `leaseID`), the
  `brokerAgents` lookup, the leased-target `localOnly` refusal, and the synthetic
  `leaseID`/`/forget` accounting tied to it.
- `classifyRouted` creates the child with a fixed `agent: "fleet-classifier"` and
  prompts it. The broker plugin routes the child, leases once, and applies the model.
- Session lifecycle (abort, idle-barrier status poll, delete) is unchanged. The guard
  explicitly calls `/forget` with the **real child session ID** in `finally`, even when
  deletion is deferred because an aborted loop is still busy. `session.deleted` may
  later call `/forget` again through `cleanupDeletedSession`; `/forget` is idempotent.
  This prevents a 12-second classifier timeout from holding a capacity-2 local slot
  until lease TTL.
- On a genuine transport/provider fault, the guard calls `/failure` with the real
  child session ID and no target ID; the daemon infers the target from that session's
  lease (`body.targetID || lease.targetID || assignment.targetID`) and releases it.
  Plugin event reporting may report the same fault first; a repeated failure/forget is
  harmless because the lease mutation is idempotent. The existing one bounded retry
  then leases the next eligible classifier rung.
- Every generic failover path recognizes classifier sessions. A classifier provider
  error event reports/releases the failed lease but never calls `scheduleReengage`.
  A classifier `session.status: retry` event likewise reports/releases the failure but
  does not call `client.session.abort` or `scheduleReengage`. Either generic path would
  prompt or abort the same child while the guard waits on its cleanup barrier, then race
  the guard's own retry in a second child. The guard exclusively owns classifier abort,
  retry, and lifecycle.
- Remove `brokerAgents` from `classifierConfig()`
  (`opencode-guard/lib/classifier.js`), the README/CHANGELOG references, and the
  example files. Direct-lane logic (`classifyDirect` -> `safety-classifier` gateway
  name) is unchanged; the gateway itself leases through the broker.
- Preserve llama.cpp's required no-thinking override without the map:
  `localNoThinkApplies` matches the fixed `fleet-classifier` identity plus
  `noThinkProviders`. `chat.params` no longer destructures or enumerates
  `brokerAgents`. Update the stale comments at `opencode-guard/plugin.js:128-132`,
  `:405-420`, and `:634-643` so none claims a model pin supplies auth or lane identity.

**Broker plugin (`opencode-broker/plugin/router.js`):**

- Replace the classifier "declined route" branch (`route()`, ~410-428) with a real
  lease. For a classifier agent:
  - Resolve the **owner** profile from `parentID` (as today, after
    `removeSessionProfile` self-heal).
  - Lease `{ tier: "classifier", profile: "auto", localOnly:
    profileConfinesToLan(ownerProfile), contextTokens }`. The classifier inherits the
    owner's **egress boundary** (via `localOnly`) but not the owner's model-quality
    profile.
  - The daemon must not await cloud plan refresh when `localOnly === true`, even though
    the classifier's quality profile is `auto`: gate it with
    `!body.localOnly && profileReachesCloud(profile)`. Otherwise a LAN-only classifier
    can wait behind a 20-second plan API, outlive the client's 2.5-second lease timeout,
    and create a late lease after cleanup already called `/forget`.
  - Skipping plan refresh is not sufficient cancellation: a local-model probe may still
    outlive the broker client's timeout after the handler starts. The request handler
    passes an abandonment/deadline predicate into `acquire`; after every awaited probe
    and immediately before mutating target cursors, one-shot assignments, or leases,
    `acquire` rechecks it and returns a non-mutating `request-abandoned` result. Thus a
    timed-out classifier lease cannot commit after the guard has already cleaned up.
  - Any classifier lease failure propagates out of `chat.message`, leaves no route
    record, and ends the turn. In particular, a confined owner with no eligible local
    target fails closed; OpenCode must never continue on the pane/default model.
  - Belt-and-braces: if the owner is confined and a returned target is not local,
    `failLease` (leave no route record; fail closed). This preserves the existing
    confined+cloud refusal now that the lease, not the pin, is the boundary.
  - Return a normal `routed` record (`{ profile, tier: "classifier", target,
    explicit }`), so `applyMessageModel`/`applyOutputModel` apply the leased model —
    the same path as every routed session.
- `needsInventory` (line 815) currently skips inventory for classifier agents. A routed
  classifier that can reach cloud needs a fresh inventory like any other lease. For a
  classifier, refresh when the owner is **not confined** and the configured classifier
  lane can reach a cloud target. Do not reuse `profileReachesCloud(ownerProfile)`:
  Manual itself leases nothing and returns false there, but a Manual owner's classifier
  is not confined and may use the cloud classifier fallback. The guard's old
  `localOnly` argument is removed because owner confinement is now computed and
  enforced solely in the broker plugin.
- The `applyClassifierVariant` post-step (841-847) is removed: the routed classifier
  already receives its variant from `modelRefForTier` at lease time, so the effort-only
  patch is redundant. **Keep** `desiredVariantForTier("classifier") = ["none", "low"]`:
  it is policy selecting the cheapest advertised level and prevents the measured
  default-effort regression (9.6s p50 / 24.5s max against a 12s timeout).
- Routed local classifier children do not arm the general 10-minute local-child
  inactivity watchdog. The guard already owns a tighter 12-second timeout and failure
  classification; the generic watchdog adds no protection and could falsely indict a
  healthy target after guard abort. Lease heartbeat remains normal.

### 3. Read catalog capability correctly; delete the mirror

- Add one shared catalog capability reader used by both discovery paths
  (`lib/model-candidates.js` and `lib/routing.js`). It reads
  `reasoning_options`:
  - `type: "effort"` -> normalize `values` (`null` becomes `"none"`).
  - `type: "budget_tokens"` -> the existing OpenCode abstraction `high,max`.
  - no reasoning options -> no variants.
- A synthesized model ID ending `-fast` or `-standard` inherits the base model's
  capability when there is no direct catalog record, matching OpenCode's
  `fromModelsDevProvider` behavior and the existing fleet-config test.
- Delete `CONFIG.modelVariants` construction (`lib/config.js:788-799`). In
  `buildCachedSubscriptionInventory` (`lib/routing.js:1267-1290`), drop the
  `configuredModelVariants` parameter and overlay at line 1286; discovered variants
  come solely from the shared catalog reader. Drop the same parameter from
  `publishCachedSubscriptionInventory` (1295-1297), and remove the configured union
  from `modelRefForTier`.
- Move the three deliberate restrictions out of capability and into policy:
  - `anthropic/claude-fable-5-1`: `effortCeiling: "xhigh"` (catalog also advertises
    `max`).
  - `anthropic/claude-opus-5-5-fast`: `effortCeiling: "high"` (base advertises through
    `max`).
  - `anthropic/claude-opus-4-8-fast`: `effortCeiling: "high"` (same).
  All other seven mirror entries are exactly catalog-derivable, including
  Sonnet's `budget_tokens` -> `high,max`, and are removed without replacement.
- `effortCeiling` caps the ordered advertised levels before tier policy chooses a
  desired variant. A ceiling absent from the discovered capability is a loud config
  error, never a silent no-op.

### 4. Publisher fencing on `/inventory`

Root cause is an old process publishing stale in-memory config. Two independent
defenses:

- **Config fingerprint.** The config loader reads `config.json` bytes once, computes
  SHA-256 from those exact bytes, parses those same bytes into frozen `CONFIG`, and
  exports the captured fingerprint. Every inventory publisher sends that snapshot; it
  must never re-hash disk at publish time, which would let an old pane claim the new
  file's fingerprint while publishing old in-memory config. The broker daemon holds
  the fingerprint of the config **it** loaded. A mismatched or
  legacy/missing-fingerprint publication is a no-op for **every `/inventory`
  mutation, including `authOnly` provider updates**: return HTTP 200 with
  `{ accepted: false, reason: "config-fingerprint-mismatch" }` and do not mutate
  inventory. This rollout shape lets old panes continue routing on the daemon's current
  inventory rather than failing every turn, while making them unable to overwrite it.
  The publication primitive returns this typed rejection rather than throwing. Chat
  routing logs it and continues on the daemon's current inventory; operational callers
  (model-watch and reconciliation publication) convert it to a failure/nonzero exit.
  Equal
  fingerprint = same config version = accepted. There is exactly one current config
  (the daemon's); only publishers running it may publish. When config changes, the
  daemon is restarted (per the deploy contract for broker-side changes), its
  fingerprint updates, and old panes are locked out until they reload. This needs no
  monotonic ordering. It composes with the existing auth `revision` fence
  (`authSnapshot().revision`, `lib/routing.js:1298`), which fences auth changes, not
  config.
- **No config capability to leak.** With `CONFIG.modelVariants` gone (part 3), even a
  publisher that slipped through carries no config-sourced variants; capability is
  catalog-only. The fingerprint fence stops stale publishers; the capability removal
  makes a stale publish harmless if one ever occurred.

- **Watch exit code.** The watch checks the publication primitive's typed result and
  throws when the daemon says `accepted: false`. `bin/opencode-broker-watch:58-60`
  sets a nonzero `process.exitCode` on rejection or any publication failure so systemd
  (and any operator) sees a failed republish as a failure. The success line at :52
  stays; failure is no longer silent.

### 5. Manual Model unchanged; remove implicit-Auto saved-model lock

- Keep the explicit Manual Model branch (`route()`, `resolved.profile === "manual"`,
  ~453-485): a Manual root keeps its selected model, a Manual child continues the
  parent — no broker model decision. This is the one intentional bypass.
- Remove the implicit-Auto saved-model lock (`rootManualLock`, ~486-493, and
  `manualModelLock()`): an implicit-Auto root with a saved default now leases through
  the broker like any Auto session. The saved default is a pre-dispatch label, not a
  pin.

## Privacy invariants (must hold after the change)

| Invariant | Enforcement |
|---|---|
| Confined owner never leases a cloud classifier | Lease carries `localOnly` derived from owner confinement; broker refuses cloud under `localOnly` |
| Confined owner + cloud leased target | `failLease`, no route record, fail closed (belt-and-braces after lease) |
| Classifier inherits egress boundary, not model-quality profile | Lease `profile: "auto"` + `localOnly` from owner |
| No static/default fallback for a failed classifier lease | Any classifier lease error throws from `chat.message`, leaves no route record, and has an explicit regression test |
| A provider fault indicts the routed target | Guard reports `/failure` by real session ID; daemon infers target; one bounded retry reaches the next rung |

## Test plan (failing first)

Broker (`node --test tests/*.mjs`):
1. Routed classifier: a classifier-agent session leases `tier: classifier` once, gets a
   broker-selected model+variant applied to the message, and produces a normal `routed`
   record (not `declined`). (New; fails today — classifier declines.)
2. Confined classifier owner cannot lease cloud: owner profile confines to LAN ->
   lease refused / `failLease`, no route record. (New.)
3. Confined classifier with no eligible local target throws from `chat.message`; the
   unpinned child never continues on its pane/default model. (New security regression.)
4. Classifier timeout explicitly forgets its real-session lease even when child
   deletion is deferred; repeated `/forget` remains harmless. (New.)
5. Routed classifier does not arm the generic local-child inactivity watchdog. (New.)
6. Classifier provider-error **and retry-status** events report/release the failure but
   neither abort nor schedule generic re-engagement; the guard remains the only abort,
   retry, and lifecycle owner. (New.)
7. A `localOnly` classifier lease does not await cloud plan refresh and cannot appear
   after client timeout/cleanup: disconnect/timeout after handler start but before
   commit leaves no target cursor, assignment, or lease mutation. (New.)
8. A Manual owner's non-confined classifier refreshes inventory when its lane has cloud
   fallback; confined owners do not. (New.)
9. Catalog capability reader extracts `effort` values, maps `budget_tokens`, and
   inherits base capability for synthesized `-fast`/`-standard` IDs. (New; fails today
   because both discovery paths read nonexistent `model.variants`.)
10. `effortCeiling` removes levels above the cap and rejects an underivable ceiling.
   (New.)
11. Full-inventory replacement removes deleted keys. (Control; passes today.)
12. Cached-config publish does not resurrect a removed variant: import plugin with
   config A (key present), rewrite config to B (key absent), publish -> body omits the
   key. (New; fails today.)
13. Config loader parses bytes A and captures hash A; rewriting disk to B before
    publication still sends A. A legacy/mismatched full **or authOnly** publish returns
    accepted:false and cannot mutate inventory; a matching publish succeeds. (New.)
14. Watch publication rejection/failure exits nonzero. (New; fails today.)
    Chat publication rejection instead logs and continues with daemon inventory;
    reconciliation publication fails loudly like the watch. (New.)

Guard (`node --test tests/*.mjs`):
15. `classifierConfig()` exposes no `brokerAgents`; `chat.params` matches fixed
    `fleet-classifier` plus `noThinkProviders` and keeps `enable_thinking:false` for the
    llama.cpp classifier only. (Adjust existing
   `classifier.test.mjs:29` which asserts the empty map — now the field is gone.)
16. `classifyRouted` creates the child with fixed `fleet-classifier`, takes no
    pre-lease, reports provider failures by real session ID, and always forgets that ID.
    (New.)

Devbox (`tests/fleet-config.test.mjs`):
17. No source or deployed agent contains `model:` frontmatter. (New; replaces the
   brokerAgents-mirror pin-equality tests, which no longer apply.)
18. Every discovered catalog effort and synthesized-mode inheritance matches the
    OpenCode catalog; no `modelVariants` mirror remains. (Replace current mirror test.)
19. `effortCeiling`/effort policy in config is catalog-derivable; an underivable level
    fails loudly. (Extend existing catalog-effort guard.)
20. A single unpinned `fleet-classifier` agent exists; the two target-specific
    classifier agents are gone. (New.)
21. Explicit Manual root and child sessions remain unleased and preserve their selected
    model; an implicit-Auto root with a saved `model-default.json` now leases normally.
    (New.)
22. Duplicate plugin+guard `/failure` reports followed by repeated `/forget` calls have
    one effective circuit/release outcome: no extended circuit, duplicate evidence, or
    retained lease. (New.)

Migration accounting: remove `modelVariants` from `README.md`,
`examples/config.example.json`, `tests/fixtures/config.json`, and
`hud/tests/fixtures-config.json`; remove `configuredModelVariants` injection arguments
and union-behavior assertions in `tests/routing.test.mjs`. Replace those assertions with
the shared `reasoning_options`, synthesized-mode inheritance, catalog-only inventory,
and `effortCeiling` contracts above.

Pin/classifier migration accounting: remove or consolidate the pinned example agents
`opencode-guard/examples/agents/guard-classifier.md` and
`guard-classifier-local.md`; remove `brokerAgents` from
`devbox/config/opencode/classifier.example.json`; replace the contradictory pin guidance
in `devbox/config/opencode-broker/NOTES.md:326-338` and `ROUTING.md:167`; update stale
pin comments in `opencode-broker/lib/routing.js:930-936` and
`bin/opencode-broker:729-730`; replace pin-dependent assertions in
`opencode-broker/tests/router.test.mjs:1333-1363` and
`tests/internal-lanes.test.mjs:135-367`. The zero-pin fleet test scans every agent
source shipped by all three repos plus both deployed symlink layers, not only devbox.
Delete the obsolete `applyClassifierVariant` helper at
`opencode-broker/lib/router-core.js:105-128` and replace its pinned-classifier test
contract at `tests/routing.test.mjs:1955-1983`. Rewrite the remaining stale
"classifier is pinned/unleased" contracts at `lib/config.js:394-397` and
`lib/routing.js:65-73,117-128,173-180`; after this change no source comment or test may
describe classifier model selection as static, declined, pinned, or outside broker
routing.

All existing broker, guard, and fleet-config suites stay green otherwise.

## Deploy / rollout

- Broker-side plugin and lib changes need
  `systemctl --user restart opencode-model-broker.service`; panes started before the
  restart run old plugin code until respawned (per opencode-products-dev).
- The daemon restart updates the config fingerprint, locking out pre-existing panes'
  stale publishes without breaking their turns — which is the desired effect.
- Agent file deletions update both symlink layers.
- Republish inventory after deploy via
  `systemctl --user start opencode-model-watch.service` and verify:
  no agent carries a pin, a classification leases once and runs a broker-selected
  model, a confined-profile classification stays local, and a stale pane's publish is
  rejected.

## Risks

- **Latency.** Routing adds a lease round-trip to each classification versus the
  pinned direct model. Mitigated: the classifier lane's targets are unchanged and the
  local target is top-priority; the guard's 12s abort and one-retry budget are
  unchanged. Measure p50/max against the pre-change baseline before claiming done.
- **Auth resolution on the routed child.** Verified equivalent to Task children, but
  confirm in a live classification that the routed model resolves OAuth (no "no text"
  masking of an auth failure) before finalizing.
- **Fingerprint churn.** If the daemon is not restarted after a config edit, new panes
  are locked out of publishing while old panes still match the daemon's loaded config.
  This is acceptable and matches the existing broker-side deploy contract. A rejected
  publication is a no-op for chat paths and a loud failure for the watch job; diagnostics
  must name the fix (restart daemon / reload pane).
