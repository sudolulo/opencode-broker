# Broker-native Classifier Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every agent model pin, route command classification through one broker-owned lease, derive reasoning capability from OpenCode's catalog, and prevent stale publishers or abandoned requests from mutating broker state.

**Architecture:** A single unpinned `fleet-classifier` child enters the ordinary broker `chat.message` route, which leases `tier: classifier`, applies the selected model and variant, and inherits only the owner's egress boundary. Catalog capability comes from a shared `reasoning_options` reader, while three deliberate restrictions become `effortCeiling` policy. Inventory mutations are fenced by an import-time config fingerprint, and lease acquisition rechecks client abandonment immediately before state mutation.

**Tech Stack:** Node.js 20+ ESM, `node:test`, Unix-socket HTTP broker, OpenCode plugin SDK, JSON/JSONC fleet configuration, systemd user services.

**Spec:** `docs/superpowers/specs/2026-09-29-broker-native-classifier-and-inventory-fencing-design.md`

## Global Constraints

- Explicit F11 **Manual Model** remains the sole broker bypass; implicit Auto always leases.
- A confined owner (`local`, `private`, or any LAN-confined profile) must never send command text to a cloud classifier.
- One classification owns exactly one broker lease; guard retry and lifecycle ownership must not overlap router re-engagement.
- No source or deployed agent may contain `model:` frontmatter after migration.
- Capability comes from catalog `reasoning_options`; deployment config may contain `effortCeiling` policy but no `modelVariants` mirror.
- Every `/inventory` mutation, including `authOnly`, requires the fingerprint captured from the exact bytes parsed into frozen `CONFIG`.
- A fingerprint rejection is non-fatal for chat routing but fatal for model-watch and reconciliation publication.
- Never stage unrelated dirty files in any checkout.
- Broker tests: `node --test tests/*.mjs`; guard tests: `node --test tests/*.test.mjs`; devbox tests: `node --test tests/*.test.mjs`.

## Review Focus

1. A confined classifier with no eligible local target throws before model execution; it never falls through to the pane/default model. Covered in Task 4.
2. A lease request disconnected after its local probe but before commit leaves target cursors, assignments, and leases unchanged. Covered in Task 3.
3. A stale `authOnly` publisher cannot mutate provider admission, while chat continues on daemon inventory and watch exits nonzero. Covered in Task 2.
4. Provider-error and retry-status events for classifiers never abort or re-engage the guard-owned child. Covered in Task 4.
5. A timed-out classifier whose delete is deferred still releases its real-session lease, and duplicate failure/forget reports do not extend circuits or leave state. Covered in Task 5.

## File Structure

### `opencode-broker`

- `lib/model-candidates.js`: shared catalog reasoning-capability normalization.
- `lib/config.js`: exact-byte config fingerprint, target `effortCeiling` normalization, no `modelVariants` mirror.
- `lib/routing.js`: catalog-derived variants, ceiling-aware model references, fingerprinted publishers.
- `lib/router-core.js`: routed message application and cleanup; obsolete classifier post-step removed.
- `plugin/router.js`: broker-native classifier route, inventory rejection handling, classifier lifecycle exclusions.
- `hud/tui.js`: existing `publishAuthInventory()` caller; stale-TUI rejection is an intentional silent no-op.
- `bin/opencode-broker`: inventory fence, local-only plan-refresh bypass, abandoned-acquire fence.
- `bin/opencode-broker-watch`: operational rejection becomes nonzero exit.
- `tests/*.mjs`, `tests/fixtures/config.json`, `hud/tests/fixtures-config.json`: unit and regression coverage.
- `README.md`, `examples/config.example.json`, `CHANGELOG.md`, `package.json`: public contract and release.

### `opencode-guard`

- `plugin.js`: one unpinned classifier child, real-session failure/forget, fixed no-think identity.
- `lib/classifier.js`: remove `brokerAgents` config contract.
- `lib/policy.js`: fixed classifier identity for llama.cpp no-thinking.
- `tests/*.test.mjs`: routed child, cleanup, retry, and no-think tests.
- `README.md`, `examples/`, `CHANGELOG.md`, `package.json`: remove pinned-agent/map instructions and release.

### `devbox` / `fleet-core`

- `config/opencode/agent/*.md`: zero pins; one classifier agent.
- `config/opencode/classifier.example.json`: no `brokerAgents` mirror.
- `config/opencode-broker/config.json`: no `modelVariants`; three `effortCeiling` policies.
- `config/opencode-broker/NOTES.md`, `ROUTING.md`: broker-native classifier contract.
- `tests/fleet-config.test.mjs`: cross-repo/source/deployed invariants.
- `bin/devbox-sync`: existing per-file deployment mechanism; no code change expected.

---

### Task 1: Catalog reasoning capabilities and policy ceilings

**Files:**
- Modify: `/home/dev/opencode-broker/lib/model-candidates.js:34-129`
- Modify: `/home/dev/opencode-broker/lib/config.js:187-193,788-799`
- Modify: `/home/dev/opencode-broker/lib/routing.js:654-712,1005-1126,1267-1325`
- Modify: `/home/dev/opencode-broker/tests/model-candidates.test.mjs:26-59,145-178`
- Modify: `/home/dev/opencode-broker/tests/ladder.test.mjs:25-59`
- Modify: `/home/dev/opencode-broker/tests/routing.test.mjs:688-705,842-901,1752-1793`
- Modify: `/home/dev/opencode-broker/tests/fixtures/config.json`
- Modify: `/home/dev/opencode-broker/hud/tests/fixtures-config.json`
- Modify: `/home/dev/opencode-broker/README.md:112`
- Modify: `/home/dev/opencode-broker/examples/config.example.json:475`

**Interfaces:**
- Produces: `reasoningVariants(model: object): string[]` and `catalogModelForID(models: object, modelID: string): object | null` exported from `lib/model-candidates.js`.
- Produces: normalized target field `effortCeiling?: string`.
- Changes: `modelRefForTier(target, tier, modelVariants)` applies `effortCeiling` before selecting tier policy.
- Removes: `CONFIG.modelVariants`, `configuredModelVariants` parameters, and config/discovery union behavior.

- [ ] **Step 1: Add failing capability-reader tests**

Add tests equivalent to:

```js
test("reasoningVariants reads effort, budget and null-as-none", () => {
  assert.deepEqual(reasoningVariants({ reasoning_options: [{ type: "effort", values: [null, "low", "high"] }] }), ["none", "low", "high"]);
  assert.deepEqual(reasoningVariants({ reasoning_options: [{ type: "budget_tokens", min: 1024 }] }), ["high", "max"]);
  assert.deepEqual(reasoningVariants({ reasoning: false }), []);
});

test("synthesized fast and standard IDs inherit base capability", () => {
  const models = { "claude-opus-5-5": { reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }] } };
  assert.equal(catalogModelForID(models, "claude-opus-5-5-fast"), models["claude-opus-5-5"]);
  assert.equal(catalogModelForID(models, "claude-opus-5-5-standard"), models["claude-opus-5-5"]);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test tests/model-candidates.test.mjs tests/ladder.test.mjs tests/routing.test.mjs tests/config-parse.test.mjs
```

Expected: FAIL because the exported helpers and `effortCeiling` contract do not exist and discovery still reads `model.variants`.

- [ ] **Step 3: Implement the shared reader**

Implement these semantics in `lib/model-candidates.js` and use them from both discovery paths:

```js
export const reasoningVariants = (model) => {
  const options = Array.isArray(model?.reasoning_options) ? model.reasoning_options : [];
  const effort = options.find((option) => option?.type === "effort" && Array.isArray(option.values));
  if (effort) return [...new Set(effort.values
    .map((value) => value === null ? "none" : value)
    .filter((value) => typeof value === "string" && value))];
  return options.some((option) => option?.type === "budget_tokens") ? ["high", "max"] : [];
};

export const catalogModelForID = (models, modelID) => {
  if (!models || typeof models !== "object") return null;
  return models[modelID] ?? models[modelID.replace(/-(?:fast|standard)$/, "")] ?? null;
};
```

Replace both `model.variants` readers with these helpers.

- [ ] **Step 4: Add failing ceiling and mirror-removal tests**

Add assertions equivalent to:

```js
test("effortCeiling caps advertised capability before tier selection", () => {
  const target = { providerID: "anthropic", modelID: "claude-fable-5-1", effortCeiling: "xhigh" };
  assert.equal(modelRefForTier(target, "deep", {
    "anthropic/claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  }).variant, "xhigh");
});

test("an underivable effortCeiling fails loudly", () => {
  const target = { providerID: "anthropic", modelID: "example", effortCeiling: "max" };
  assert.throws(() => modelRefForTier(target, "deep", {
    "anthropic/example": ["low", "medium", "high"],
  }), /effortCeiling.*max.*not advertised/);
});
```

Change cached-inventory expectations so catalog variants are preserved without a configured union and assert `CONFIG.modelVariants === undefined`.

- [ ] **Step 5: Implement ceilings and remove the mirror**

Normalize optional non-empty `target.effortCeiling`. In `modelRefForTier`, use the advertised array from inventory only; if a ceiling exists, require it in that array and slice through its index before matching `target.effort[tier] ?? desiredVariantForTier(tier)`. Remove `CONFIG.modelVariants`, both `configuredModelVariants` injection parameters, the overlay, example keys, fixture keys, README text, and union-behavior tests.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
node --test tests/model-candidates.test.mjs tests/ladder.test.mjs tests/routing.test.mjs tests/config-parse.test.mjs
npm test
```

Expected: focused tests and the package's broker/gateway/HUD suite pass; no test or fixture refers to configured `modelVariants`.

- [ ] **Step 7: Commit Task 1**

```bash
cd /home/dev/opencode-broker
git add lib/model-candidates.js lib/config.js lib/routing.js tests/model-candidates.test.mjs tests/ladder.test.mjs tests/routing.test.mjs tests/fixtures/config.json hud/tests/fixtures-config.json README.md examples/config.example.json
git commit -m "derive reasoning capability from the model catalog"
```

---

### Task 2: Fingerprint every inventory mutation

**Files:**
- Modify: `/home/dev/opencode-broker/lib/config.js:15-125,624-626`
- Modify: `/home/dev/opencode-broker/lib/routing.js:1129-1174,1295-1325`
- Modify: `/home/dev/opencode-broker/plugin/router.js:235-247,813-830`
- Modify: `/home/dev/opencode-broker/bin/opencode-broker:1500-1532`
- Modify: `/home/dev/opencode-broker/bin/opencode-broker-watch:42-60`
- Modify: `/home/dev/opencode-broker/tests/broker.test.mjs:570-615,1720-1784`
- Modify: `/home/dev/opencode-broker/tests/routing.test.mjs:568-654,810-901`
- Modify: `/home/dev/opencode-broker/tests/watch.test.mjs:1-46`
- Modify: `/home/dev/opencode-broker/tests/model-reconcile.test.mjs` (publisher-import boundary test)

**Interfaces:**
- Produces: `CONFIG_FINGERPRINT: string`, captured from the exact bytes parsed into `CONFIG`.
- Changes: full and `authOnly` `/inventory` bodies include `configFingerprint`.
- Changes: mismatched/missing fingerprint returns `{ accepted: false, reason: "config-fingerprint-mismatch" }` with HTTP 200 and no mutation.
- Caller contract: chat logs and continues; watch/operational publication exits nonzero.

- [ ] **Step 1: Write failing exact-byte and broker-fence tests**

Add tests that load config bytes A, rewrite disk to B after import, and assert the publisher still sends `sha256(A)`. In broker tests, seed inventory and then post full and `authOnly` bodies with missing/wrong fingerprints:

```js
assert.deepEqual(await postInventory({ authOnly: true, providers: changed }), {
  accepted: false,
  reason: "config-fingerprint-mismatch",
});
assert.deepEqual((await status()).inventory.providers, originalProviders);
```

Add a matching-fingerprint case that mutates inventory normally.

Add two watch subprocess cases: one broker response with `accepted:false`, and one thrown/transport publication failure. Both must exit nonzero and omit the success line.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test tests/broker.test.mjs tests/routing.test.mjs tests/watch.test.mjs
```

Expected: FAIL because fingerprints are absent and legacy publishers still mutate inventory.

- [ ] **Step 3: Capture one config source and hash**

Refactor the config loader so one `Buffer` supplies both parsing and hashing while preserving JSONC parsing and the load-bearing distinction between an absent config (`{}`) and a malformed config (`CONFIG_ERROR`):

```js
let CONFIG_SOURCE = Buffer.from("{}");
let configAbsent = false;
try {
  CONFIG_SOURCE = readFileSync(CONFIG_PATH);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  configAbsent = true;
}
export const CONFIG_FINGERPRINT = createHash("sha256").update(CONFIG_SOURCE).digest("hex");
let parsed = {};
if (!configAbsent) {
  try {
    parsed = JSON.parse(stripJsonComments(CONFIG_SOURCE.toString("utf8")));
  } catch (error) {
    CONFIG_ERROR = error;
  }
}
```

Integrate this into the existing loader rather than creating a second parse path. Retain the existing `stripJsonComments` implementation and current malformed-config error handling exactly; do not re-read `CONFIG_PATH` during publication.

- [ ] **Step 4: Fence daemon inventory before all mutation**

At the start of `/inventory`, before full or `authOnly` state changes:

```js
if (body.configFingerprint !== CONFIG_FINGERPRINT) {
  return reply(response, 200, { accepted: false, reason: "config-fingerprint-mismatch" });
}
```

Matching publications return `accepted: true` plus the existing inventory response fields and preserve existing auth-revision checks.

- [ ] **Step 5: Implement caller-specific rejection handling**

Both publishers attach `CONFIG_FINGERPRINT`. `publishCachedSubscriptionInventory` and `publishAuthInventory` return the typed broker response unchanged. `refreshInventory()` in `plugin/router.js` logs `accepted:false` and continues. The existing HUD/TUI `publishAuthInventory()` caller receives the typed no-op and intentionally does not fail the UI. `opencode-broker-watch` throws on `accepted:false`; its existing broad catch sets `process.exitCode = 1` for both typed rejection and any thrown/transport failure, and prints no success line. No reconciliation command currently publishes inventory; add a source-contract test in `tests/model-reconcile.test.mjs` asserting it imports neither `publishCachedSubscriptionInventory` nor `publishAuthInventory`, so this remains true.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
node --test tests/broker.test.mjs tests/routing.test.mjs tests/watch.test.mjs
```

Expected: all selected tests pass; mismatched full/auth-only bodies are no-ops, chat continues, and watch exits nonzero.

- [ ] **Step 7: Commit Task 2**

```bash
cd /home/dev/opencode-broker
git add lib/config.js lib/routing.js plugin/router.js bin/opencode-broker bin/opencode-broker-watch tests/broker.test.mjs tests/routing.test.mjs tests/watch.test.mjs tests/model-reconcile.test.mjs
git commit -m "fence inventory updates by loaded config"
```

---

### Task 3: Cancel abandoned lease acquisition

**Files:**
- Modify: `/home/dev/opencode-broker/bin/opencode-broker:322-336,505-537,669-745,823-848,1049-1062,1131-1152,1588-1622`
- Modify: `/home/dev/opencode-broker/tests/broker.test.mjs:1633-1718`

**Interfaces:**
- Changes: `acquire(state, body, { isAbandoned = () => false } = {})` checks cancellation after awaits and before mutation.
- Produces: error/result code `request-abandoned` with no cursor, assignment, or lease mutation.
- Changes: `/lease` plan refresh predicate is `body.localOnly !== true && profileReachesCloud(profile)`.

- [ ] **Step 1: Write failing local-only and post-probe disconnect tests**

Add one test with a due 20-second cloud-plan refresh and `localOnly:true`; assert the local lease completes without awaiting that promise. Add one test whose local-model probe resolves only after the response/socket is marked destroyed; snapshot cursors, assignments, and leases before the resolution and assert all three remain byte-for-byte equal afterward.

- [ ] **Step 2: Run broker tests and verify RED**

```bash
node --test tests/broker.test.mjs
```

Expected: local-only request awaits plan refresh and/or the disconnected post-probe request commits a lease.

- [ ] **Step 3: Thread abandonment into acquire**

Pass `() => abandoned(request, response)` from the `/lease` handler into `acquire`. Call it after each awaited local/model-presence probe and immediately before every mutation of selection cursors, one-shot assignments, and `state.leases`. Throw an error with `code = "request-abandoned"`; the handler must not write state or reply to a destroyed socket.

- [ ] **Step 4: Skip cloud-plan refresh for local-only requests**

Change the gate to:

```js
if (body.localOnly !== true && profileReachesCloud(isProfile(body?.profile) ? body.profile : "auto")) {
  await planRefresh;
}
```

- [ ] **Step 5: Run broker tests and verify GREEN**

```bash
node --test tests/broker.test.mjs
```

Expected: all broker tests pass; no late lease/assignment/cursor mutation exists after abandonment.

- [ ] **Step 6: Commit Task 3**

```bash
cd /home/dev/opencode-broker
git add bin/opencode-broker tests/broker.test.mjs
git commit -m "cancel abandoned lease acquisition before commit"
```

---

### Task 4: Route classifier children through one broker lease

**Files:**
- Modify: `/home/dev/opencode-broker/plugin/router.js:35-45,290-356,382-428,486-493,755-847,952-1075,1138-1182`
- Modify: `/home/dev/opencode-broker/lib/router-core.js:105-128`
- Modify: `/home/dev/opencode-broker/lib/config.js:394-397`
- Modify: `/home/dev/opencode-broker/lib/routing.js:65-73,117-128,173-180,930-936`
- Modify: `/home/dev/opencode-broker/bin/opencode-broker:729-730`
- Modify: `/home/dev/opencode-broker/tests/router.test.mjs:877-1108,1333-1363,1955-1983`
- Modify: `/home/dev/opencode-broker/tests/internal-lanes.test.mjs:91-367`
- Modify: `/home/dev/opencode-broker/tests/agent-tiers.test.mjs:53-59`
- Modify: `/home/dev/opencode-broker/CHANGELOG.md`
- Modify: `/home/dev/opencode-broker/package.json`

**Interfaces:**
- Consumes: catalog-derived model variants and `effortCeiling` from Task 1.
- Consumes: non-mutating abandoned acquisition from Task 3.
- Produces: classifier route `{ profile: "auto", tier: "classifier", target, explicit: false }` with one lease.
- Removes: declined classifier route, `applyClassifierVariant`, and implicit-Auto `rootManualLock`.

- [ ] **Step 1: Write failing routed-classifier tests**

Cover these exact outcomes:

```js
assert.equal(route.tier, "classifier");
assert.equal(route.declined, undefined);
assert.equal(leaseCalls.length, 1);
assert.equal(leaseCalls[0].localOnly, true); // confined owner
assert.deepEqual(message.model, route.target.model);
```

Add separate tests for an Auto owner (`localOnly` omitted/false), a Manual owner whose classifier lane may refresh cloud inventory, a confined owner with no local target (throws; no route; message model unchanged), and a returned cloud target despite `localOnly` (belt-and-braces `failLease`).

- [ ] **Step 2: Add failing lifecycle and Manual tests**

Assert provider-error and retry-status events on a classifier report failure but call neither `scheduleReengage` nor `client.session.abort`. Assert no local-child inactivity watchdog is armed, while heartbeat remains. Assert explicit Manual root/child stays locked and unleased; implicit Auto with a saved default now calls `/lease`.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --test tests/router.test.mjs tests/internal-lanes.test.mjs tests/agent-tiers.test.mjs
```

Expected: classifier route remains declined, lifecycle paths re-engage, and implicit Auto remains locked.

- [ ] **Step 4: Implement broker-native classifier routing**

Replace the early declined branch with classifier-specific routing inputs feeding the ordinary lease path:

```js
const classifier = isClassifierAgent(session.agent);
const owner = classifier
  ? resolveProfile({ sessionID: session.id, parentID: session.parentID })
  : null;
const resolved = classifier
  ? { profile: "auto", explicit: false }
  : resolveProfile({ sessionID: session.id, parentID: session.parentID, agent: session.agent });
const tier = classifier ? "classifier" : await routeTierForSession({
  agent: session.agent,
  parentID: session.parentID,
  sessionID: session.id,
  routes,
  sessions,
  getSession,
});
const localOnly = classifier && profileConfinesToLan(owner.profile);
```

Include `localOnly` in the lease body; propagate every lease error; after lease, reject non-local target when `localOnly`; return the normal routed record. Compute classifier inventory refresh as `!profileConfinesToLan(owner.profile) && classifierTierReachesCloud()`. Do not use `profileReachesCloud("manual")` for this decision.

- [ ] **Step 5: Remove obsolete pin-era paths**

Delete `applyClassifierVariant` export/call/tests. Keep `desiredVariantForTier("classifier") = ["none", "low"]`. Remove `rootManualLock` and `manualModelLock` only where they implement implicit-Auto bypass; retain explicit Manual handling. Exempt classifier sessions from local inactivity watchdog and every generic abort/reengage path, but retain heartbeat and failure reporting. Rewrite all named pinned/unleased comments and tests.

- [ ] **Step 6: Run focused and full broker tests**

```bash
node --test tests/router.test.mjs tests/internal-lanes.test.mjs tests/agent-tiers.test.mjs
npm test
```

Expected: both commands pass; routed classifier receives `none` for luna when available, exactly one lease is recorded, and no pin-era contract remains.

- [ ] **Step 7: Bump and document broker release**

Set `package.json` version from `1.21.1` to `1.22.0`. Add one `## [1.22.0] — 2026-09-29` changelog batch covering catalog capability, effort ceilings, inventory fingerprint fencing, abandoned acquisition, broker-native classifier routing, and removal of implicit-Auto locking.

- [ ] **Step 8: Commit Task 4**

```bash
cd /home/dev/opencode-broker
git add plugin/router.js lib/router-core.js lib/config.js lib/routing.js bin/opencode-broker tests/router.test.mjs tests/internal-lanes.test.mjs tests/agent-tiers.test.mjs package.json CHANGELOG.md
git commit -m "route classifiers through one broker-owned lease"
```

---

### Task 5: Make opencode-guard use the routed classifier

**Files:**
- Modify: `/home/dev/opencode-guard/plugin.js:128-132,353-522,634-650`
- Modify: `/home/dev/opencode-guard/lib/classifier.js:26-30,56-84`
- Modify: `/home/dev/opencode-guard/lib/policy.js:977-983`
- Modify: `/home/dev/opencode-guard/tests/classifier.test.mjs:29-106`
- Modify: `/home/dev/opencode-guard/tests/policy.test.mjs` (existing `localNoThinkApplies` block)
- Modify: `/home/dev/opencode-guard/tests/plugin-exports.test.mjs:1-25`
- Modify: `/home/dev/opencode-guard/tests/broker.test.mjs:1-110`
- Modify: `/home/dev/opencode-guard/README.md:136-156`
- Delete: `/home/dev/opencode-guard/examples/classifier.broker.example.json`
- Delete: `/home/dev/opencode-guard/examples/agents/guard-classifier-local.md`
- Rename: `/home/dev/opencode-guard/examples/agents/guard-classifier.md` to `/home/dev/opencode-guard/examples/agents/fleet-classifier.md`; remove its model pin
- Modify: `/home/dev/opencode-guard/CHANGELOG.md`
- Modify: `/home/dev/opencode-guard/package.json`

**Interfaces:**
- Consumes: broker plugin route from Task 4.
- Changes: `classifyRouted(command, cwd, parentSessionID, config)` creates `agent: "fleet-classifier"` with no model/pre-lease.
- Changes: `localNoThinkApplies(agent, providerID, noThinkProviders)` matches only fixed classifier identity and listed provider.
- Removes: `classifierConfig().brokerAgents` and target-to-agent mapping.

- [ ] **Step 1: Write failing guard route and cleanup tests**

Capture broker and SDK calls and assert:

```js
assert.equal(created.body.agent, "fleet-classifier");
assert.equal(created.body.model, undefined);
assert.equal(calls.filter((call) => call.path === "/lease").length, 0);
assert.deepEqual(failure.body, { sessionID: createdSessionID, error: expectedDetail });
assert.equal(forgets.at(-1).body.sessionID, createdSessionID);
```

Add a deferred-delete case where status never becomes idle; `/forget` must still occur. Add duplicate `/failure`/`/forget` integration coverage against a broker fixture and assert no retained lease or extended circuit.

- [ ] **Step 2: Write failing fixed no-think tests**

```js
assert.equal(localNoThinkApplies("fleet-classifier", "llamacpp", ["llamacpp"]), true);
assert.equal(localNoThinkApplies("standard", "llamacpp", ["llamacpp"]), false);
assert.equal(localNoThinkApplies("fleet-classifier", "anthropic", ["llamacpp"]), false);
```

Assert `chat.params` sets `chat_template_kwargs.enable_thinking = false` only for the first case and does not read `brokerAgents`.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --test tests/classifier.test.mjs tests/policy.test.mjs tests/plugin-exports.test.mjs tests/broker.test.mjs
```

Expected: pre-lease and brokerAgents assumptions fail; the new helper signature is absent.

- [ ] **Step 4: Remove guard-side model selection**

Create the child first with fixed `fleet-classifier`, prompt it without an explicit model, report genuine provider/transport failures using the real child ID and no target ID, and always `/forget` that ID in `finally` after abort/status/delete cleanup. Keep timeout and no-text exclusions from provider fault reporting. Remove synthetic lease ID, target selection, localOnly argument, `leaseRespectsLocalOnly` usage in this path, and `brokerAgents` parsing.

- [ ] **Step 5: Preserve llama.cpp no-thinking and update docs/examples**

Change `localNoThinkApplies` to fixed agent identity plus provider list. Update stale comments that claim pins resolve auth. Remove map docs and the local pinned example; rename the remaining example to `fleet-classifier.md`, remove its pin, and update the README configuration table to use that exact identity.

- [ ] **Step 6: Run focused and full guard tests**

```bash
node --test tests/classifier.test.mjs tests/policy.test.mjs tests/plugin-exports.test.mjs tests/broker.test.mjs
node --test tests/*.test.mjs
```

Expected: all tests pass; no guard route issues `/lease`; real-session failure/forget and no-thinking are covered.

- [ ] **Step 7: Bump and document guard release**

Set `package.json` version from `1.1.0` to `1.2.0`. Add one `## [1.2.0] — 2026-09-29` changelog batch covering broker-native classifier routing, real-session cleanup/failure, fixed no-thinking identity, and removal of `brokerAgents`.

- [ ] **Step 8: Commit Task 5**

```bash
cd /home/dev/opencode-guard
git add -A plugin.js lib/classifier.js lib/policy.js tests README.md examples package.json CHANGELOG.md
git commit -m "delegate classifier model selection to the broker"
```

---

### Task 6: Remove fleet pins and capability mirrors

**Permission unblock (2026-09-29):** Holden switched the session to Manual permission
mode and authorized one-time removal of exactly these two retired deployed symlinks if
`devbox-sync --no-pull` leaves them dangling:

- `/home/dev/.config/opencode/agent/fleet-classifier-local.md`
- `/home/dev/.config/opencode/agent/fleet-classifier-haiku.md`

Do not remove or rewrite any other deployed agent path.

**Cleanup completed by the GOD root session (2026-09-29):** Both authorized
symlinks above were removed and verified absent with both `test ! -L` and `test ! -e`.
The Task 6 child must not attempt another unlink; continue with sync, GREEN verification,
staging isolation, commit, and review.

**Deployed guard config completed by the GOD root session (2026-09-29):** Removed only
the `brokerAgents` key from `/home/dev/.config/opencode/classifier.json`, verified that
the key is absent, and verified the file remains mode `0600`. The Task 6 child must not
edit this guard control file; rerun deployed-state tests, sync, review, and commit.

**Files:**
- Modify: `/home/dev/devbox/config/opencode/agent/fleet-classifier.md`
- Delete: `/home/dev/devbox/config/opencode/agent/fleet-classifier-local.md`
- Delete: `/home/dev/devbox/config/opencode/agent/fleet-classifier-haiku.md`
- Modify: `/home/dev/devbox/config/opencode/agent/standard.md`
- Modify: `/home/dev/devbox/config/opencode/agent/smart.md`
- Modify: `/home/dev/devbox/config/opencode/agent/deep.md`
- Modify: `/home/dev/devbox/config/opencode/agent/fast-build.md`
- Modify: `/home/dev/devbox/config/opencode/classifier.example.json:18-31`
- Modify: `/home/dev/devbox/config/opencode-broker/config.json:47-67,515-581`
- Modify: `/home/dev/devbox/config/opencode-broker/NOTES.md:326-338`
- Modify: `/home/dev/devbox/config/opencode-broker/ROUTING.md:163-170`
- Modify: `/home/dev/devbox/tests/fleet-config.test.mjs:850-968`

**Interfaces:**
- Consumes: `effortCeiling` and catalog capability from Task 1.
- Produces: one unpinned `fleet-classifier`; zero model-pinned agents; no `brokerAgents`; no `modelVariants`.
- Produces policy: target `claude-fable-5-1` ceiling `xhigh`; targets `claude-opus-5-5-fast` and `claude-opus-4-8-fast` ceiling `high`.

- [ ] **Step 1: Replace pin-equality tests with failing zero-pin tests**

Scan every agent source in devbox and opencode-guard plus both deployed link layers. Assert no frontmatter line matches `/^model:/m`, exactly one classifier source/deployed agent remains, and target-specific local/haiku classifier paths do not exist. Assert classifier config has no `brokerAgents` and broker config has no `modelVariants`.

- [ ] **Step 2: Add failing catalog/ceiling config tests**

Reuse the fleet catalog derivation (including base-model fallback for `-fast`/`-standard`) and assert:

```js
assert.equal(router.targets["claude-fable-5-1"].effortCeiling, "xhigh");
assert.equal(router.targets["claude-opus-5-5-fast"].effortCeiling, "high");
assert.equal(router.targets["claude-opus-4-8-fast"].effortCeiling, "high");
assert.equal("modelVariants" in router, false);
```

For every ceiling, assert the inherited/direct catalog capability contains it.

- [ ] **Step 3: Run fleet config tests and verify RED**

```bash
node --test tests/fleet-config.test.mjs
```

Expected: FAIL on seven pins, two target-specific classifier agents, `brokerAgents`, and `modelVariants`.

- [ ] **Step 4: Apply the fleet configuration migration**

Remove `model:` from the five retained agent files; delete the two target-specific classifier files. Remove `brokerAgents` from `classifier.example.json`. Delete the complete `modelVariants` object. Add the three exact `effortCeiling` values to their target objects. Rewrite NOTES/ROUTING to describe one routed classifier agent, one broker lease, owner-derived egress boundary, catalog capability, and policy ceilings.

- [ ] **Step 5: Run fleet config tests and verify GREEN**

```bash
node --test tests/fleet-config.test.mjs
```

Expected: all tests pass in source state.

- [ ] **Step 6: Deploy per-file links and verify convergence**

Run:

```bash
/home/dev/devbox/bin/devbox-sync --no-pull
```

Then verify the removed links are absent and every deployed/source agent is unpinned:

```bash
test ! -L "$HOME/.config/opencode/agent/fleet-classifier-local.md" && test ! -e "$HOME/.config/opencode/agent/fleet-classifier-local.md"
test ! -L "$HOME/.config/opencode/agent/fleet-classifier-haiku.md" && test ! -e "$HOME/.config/opencode/agent/fleet-classifier-haiku.md"
! grep -R '^model:' /home/dev/devbox/config/opencode/agent "$HOME/.config/opencode/agent"
```

If either deleted-agent path remains as a dangling symlink after sync, remove that one stale link manually, rerun `devbox-sync --no-pull`, and repeat both `-L`/`-e` assertions. The deleted source is a closed set, so this is one-time cleanup rather than a recurring sync workaround.

- [ ] **Step 7: Re-run the fleet test against deployed state**

```bash
node --test tests/fleet-config.test.mjs
```

Expected: all tests pass with both symlink layers converged.

- [ ] **Step 8: Commit Task 6**

Stage only the listed config/docs/tests; do not stage unrelated plan/spec files from other sessions:

```bash
cd /home/dev/devbox
git add -A config/opencode/agent config/opencode/classifier.example.json config/opencode-broker/config.json config/opencode-broker/NOTES.md config/opencode-broker/ROUTING.md tests/fleet-config.test.mjs
git commit -m "route every agent model choice through the broker"
```

---

### Task 7: Cross-product review, release verification, and deployment

**Files:**
- Verify only; edit only if review finds a concrete defect, then repeat that task's RED/GREEN cycle.

**Interfaces:**
- Consumes all prior tasks.
- Produces released broker `1.22.0`, guard `1.2.0`, converged fleet config, and runtime evidence.

- [ ] **Step 1: Inspect intended diffs and cleanliness in all three repos**

Run per checkout:

```bash
git --no-pager status --short
git --no-pager diff --stat
git --no-pager log --oneline -10
```

Expected: only intended commits/files from this plan; unrelated dirty gateway/HUD/Tandoor files remain unstaged and untouched.

- [ ] **Step 2: Run all suites**

```bash
cd /home/dev/opencode-broker && npm test
cd /home/dev/opencode-guard && npm test
cd /home/dev/devbox && node --test tests/*.test.mjs
```

Expected: zero failures in all three commands.

- [ ] **Step 3: Request independent whole-change review**

Review the combined commits against the approved spec, with special attention to privacy fail-closed behavior, exact-one-lease accounting, cancellation before mutation, duplicate failure/forget idempotence, and old-pane fingerprint rollout. Fix only verified findings using a failing test first, then repeat Step 2.

- [ ] **Step 4: Check for an in-progress model swap before broker restart**

```bash
systemctl --user status opencode-model-broker.service --no-pager
journalctl --user -u opencode-model-broker.service --since "10 minutes ago" --no-pager
```

Expected: broker is active and no model preparation/swap is in progress. If a swap is active, wait for its terminal state rather than interrupt it.

- [ ] **Step 5: Restart broker and republish fresh inventory**

```bash
systemctl --user restart opencode-model-broker.service
systemctl --user start opencode-model-watch.service
systemctl --user --no-pager --full status opencode-model-broker.service opencode-model-watch.service
```

Expected: broker active; watch exits successfully after an accepted fingerprinted publication.

- [ ] **Step 6: Verify deployed state and broker inventory**

Assert:

```bash
! grep -R '^model:' /home/dev/devbox/config/opencode/agent "$HOME/.config/opencode/agent"
jq -e 'has("modelVariants") | not' /home/dev/devbox/config/opencode-broker/config.json
jq -e '.inventory.modelVariants["openai/gpt-5.6-luna"] | index("none") != null' "$HOME/.local/share/opencode/model-routing/broker.json"
```

Expected: no agent pins, no config mirror, and fresh catalog-derived luna capability includes `none`.

- [ ] **Step 7: Verify routing evidence**

Record the decision timestamp, run one disposable fresh OpenCode process that must invoke `bash`, and inspect the broker's decision trail:

```bash
started=$(date +%s%3N)
smoke=$(mktemp /tmp/opencode/classifier-smoke.XXXXXX)
root=""
cleanup_smoke() {
  if [ -n "$root" ]; then opencode session delete "$root" >/dev/null 2>&1 || true; fi
  rm -f "$smoke"
}
trap cleanup_smoke EXIT
opencode run --format json --agent standard 'Use the bash tool exactly once to execute pwd, report its output, then stop.' > "$smoke"
root=$(jq -sr '[.. | objects | .sessionID? // empty] | map(select(startswith("ses"))) | first // empty' "$smoke")
test -n "$root"
jq -se --argjson started "$started" '
  [.[] | select(.at >= $started and .tier == "classifier")] as $routes
  | ($routes | length) == 1
  and ($routes[0].targetID | type == "string")
' "$HOME/.local/share/opencode/model-routing/decisions.jsonl"
classifier_session=$(jq -sr --argjson started "$started" '[.[] | select(.at >= $started and .tier == "classifier")][0].sessionID' "$HOME/.local/share/opencode/model-routing/decisions.jsonl")
jq -e --arg sid "$classifier_session" '((.leases // {}) | has($sid)) | not' "$HOME/.local/share/opencode/model-routing/broker.json"
```

Expected: the disposable command succeeds and exactly one post-start classifier decision exists. Use its `sessionID` to assert the live `broker.json` has no retained lease after cleanup. The Task 4 confined-owner integration tests are the authoritative local/private proof; do not mutate this session's active profile merely to repeat them live.

- [ ] **Step 8: Push all three repos**

After checking status and intended commits, push canonical Gitea branches:

```bash
cd /home/dev/opencode-broker && git push origin main
cd /home/dev/opencode-guard && git push origin main
cd /home/dev/devbox && git push origin main
```

Expected: all pushes succeed without force; report the three commit IDs, versions, exact test counts, service state, and the fact that already-running TUIs keep old plugin code until respawned.
