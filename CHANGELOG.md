# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
