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

3. **A stale publisher can resurrect deleted capability data.** `CONFIG.modelVariants`
   (`lib/config.js:788-799`, frozen at import) is overlaid onto catalog discovery in
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
- Capability (reasoning variants) is derived only from the OpenCode catalog. Config
  carries policy, never capability.
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
- Session lifecycle (abort, idle-barrier status poll, delete) is unchanged; the child
  is a normal routed session and its single lease is forgotten through the plugin's
  own `cleanupDeletedSession`/`/forget` path when the session is deleted.
- Remove `brokerAgents` from `classifierConfig()`
  (`opencode-guard/lib/classifier.js`), the README/CHANGELOG references, and the
  example files. Direct-lane logic (`classifyDirect` -> `safety-classifier` gateway
  name) is unchanged; the gateway itself leases through the broker.

**Broker plugin (`opencode-broker/plugin/router.js`):**

- Replace the classifier "declined route" branch (`route()`, ~410-428) with a real
  lease. For a classifier agent:
  - Resolve the **owner** profile from `parentID` (as today, after
    `removeSessionProfile` self-heal).
  - Lease `{ tier: "classifier", profile: "auto", localOnly:
    profileConfinesToLan(ownerProfile), contextTokens }`. The classifier inherits the
    owner's **egress boundary** (via `localOnly`) but not the owner's model-quality
    profile.
  - Belt-and-braces: if the owner is confined and the leased target is not a local
    target, `failLease` (leave no route record; fail closed). This preserves the
    existing confined+cloud refusal now that the lease, not the pin, is the boundary.
  - Return a normal `routed` record (`{ profile, tier: "classifier", target,
    explicit }`), so `applyMessageModel`/`applyOutputModel` apply the leased model —
    the same path as every routed session.
- `needsInventory` (line 815) currently skips inventory for classifier agents. A routed
  classifier that can reach cloud needs a fresh inventory like any other lease, so the
  guard `!isClassifierAgent(agent)` exclusion is removed; `profileReachesCloud` alone
  decides. A confined classifier stays local and does not refresh.
- The `applyClassifierVariant` post-step (841-847) is removed: the routed classifier
  already receives its variant from the leased target's live inventory, so the
  effort-only patch is redundant. `applyClassifierVariant` and its
  `desiredVariantForTier("classifier")` config source are deleted (see part 3).

### 3. Capability from catalog only; delete `CONFIG.modelVariants`

- Delete `CONFIG.modelVariants` construction (`lib/config.js:788-799`).
- In `buildCachedSubscriptionInventory` (`lib/routing.js:1267-1290`), drop the
  `configuredModelVariants` parameter and the overlay at line 1286;
  `discovered.modelVariants` comes solely from catalog discovery. Drop the same
  parameter from `publishCachedSubscriptionInventory` (1295-1297).
- `modelRefForTier` (`lib/routing.js`) no longer unions a configured variant list; it
  reads the variant from live inventory only.
- Policy, not capability, stays in config. Where a target needs a deliberate reasoning
  cap, introduce `effortCeiling` (policy: an upper bound applied to a
  catalog-discovered capability). If config names an `effortCeiling` (or any effort
  policy) that the discovered capability does not contain, **fail loudly** at load
  rather than silently no-op. (The existing devbox catalog-effort guard test already
  asserts config effort is catalog-derivable; it is extended to the ceiling form.)

### 4. Publisher fencing on `/inventory`

Root cause is an old process publishing stale in-memory config. Two independent
defenses:

- **Config fingerprint.** Each publisher includes the SHA-256 of the deployed
  `config.json` it loaded. The broker daemon holds the fingerprint of the config **it**
  loaded and **rejects** any `/inventory` publish whose fingerprint differs, with a
  clear `config-fingerprint-mismatch` error telling the caller to reload. Equal
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

- **Watch exit code.** `bin/opencode-broker-watch:58-60` sets a nonzero
  `process.exitCode` on publication failure so systemd (and any operator) sees a failed
  republish as a failure. The success line at :52 stays; failure is no longer silent.

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
| No static model fallback for a failed classifier lease | Existing "never bypass admission with a static fallback" path is unchanged |
| A provider fault indicts the routed target | Guard `/failure` reporting is unchanged; one bounded retry reaches the next classifier rung |

## Test plan (failing first)

Broker (`node --test tests/*.mjs`):
1. Routed classifier: a classifier-agent session leases `tier: classifier` once, gets a
   broker-selected model+variant applied to the message, and produces a normal `routed`
   record (not `declined`). (New; fails today — classifier declines.)
2. Confined classifier owner cannot lease cloud: owner profile confines to LAN ->
   lease refused / `failLease`, no route record. (New.)
3. Full-inventory replacement removes deleted keys. (Control; passes today.)
4. Cached-config publish does not resurrect a removed variant: import plugin with
   config A (key present), rewrite config to B (key absent), publish -> body omits the
   key. (New; fails today.)
5. Config-fingerprint fence: a publish whose fingerprint differs from the daemon's is
   rejected. (New; fails today.)
6. Watch publication failure exits nonzero. (New; fails today.)

Guard (`node --test tests/*.mjs`):
7. `classifierConfig()` exposes no `brokerAgents`. (Adjust existing
   `classifier.test.mjs:29` which asserts the empty map — now the field is gone.)
8. `classifyRouted` creates the child with the fixed `fleet-classifier` agent and takes
   no pre-lease. (New.)

Devbox (`tests/fleet-config.test.mjs`):
9. No source or deployed agent contains `model:` frontmatter. (New; replaces the
   brokerAgents-mirror pin-equality tests, which no longer apply.)
10. `effortCeiling`/effort policy in config is catalog-derivable; an underivable level
    fails loudly. (Extend existing catalog-effort guard.)
11. A single unpinned `fleet-classifier` agent exists; the two target-specific
    classifier agents are gone. (New.)

All existing broker, guard, and fleet-config suites stay green otherwise.

## Deploy / rollout

- Broker-side plugin and lib changes need
  `systemctl --user restart opencode-model-broker.service`; panes started before the
  restart run old plugin code until respawned (per opencode-products-dev).
- The daemon restart updates the config fingerprint, locking out pre-existing panes'
  stale publishes — which is the desired effect.
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
- **Fingerprint churn.** If the daemon is not restarted after a config edit, every pane
  is locked out of publishing until restart. This is acceptable and matches the
  existing broker-side deploy contract, but the mismatch error must name the fix
  (reload/restart) explicitly.
