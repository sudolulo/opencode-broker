# Provider Model Reconciliation Package 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the dormant, default-off runtime needed to admit trusted subscription models, render authorized resolver generations, stage broker-owned model policy, probe exact targets, promote proven candidates, and roll them back safely without changing live routing until Package 4.

**Architecture:** The reconciliation ledger remains policy authority while a deterministic resolver overlay and immutable config generations materialize authorized intent; the broker separately owns runtime `modelPolicy`, process registrations, probe nonces, probation, and rollback. A compare-and-swap saga links those stores without holding a filesystem lock across resolver or broker calls, and exact manifest membership keeps old, legacy, forged, or cleaned generations on generation-0 incumbents. Every live-mutation entry point is present but dormant behind `reconcile.apply.enabled: false`; Package 4 alone performs cutover and enables publication, mutation, and scheduling.

**Tech Stack:** Node.js >=20.18, ESM, `node:test`, Unix socket HTTP, OpenCode plugin hooks, fleet gateway, POSIX atomic filesystem operations (`fsync`, rename, private modes, atomic symlink replacement).

**Spec:** [`docs/superpowers/specs/2026-09-28-provider-model-reconciliation-design.md`](../specs/2026-09-28-provider-model-reconciliation-design.md)

## Global Constraints

- Package 3 is default-OFF and dormant. `reconcile.apply.enabled` defaults to `false`; all live paths default to `null`; no fresh install mutates live inventory, overlay, resolver config, broker policy, Gitea, ntfy, or schedules.
- Package 4 alone activates live inventory publication, overlay/config publication, broker-policy mutation, external projections, and scheduling after its cutover gates. Package 3 tests may reach machinery only through injected state roots, local fake broker/gateway services, and explicit test config.
- `createReconciliationStore().update(mutator)` remains the sole reconciliation-ledger mutation boundary used directly by both `opencode-broker-reconcile` and `opencode-broker-evidence`. No helper, API handler, renderer, or broker code writes `model-reconciliation.json` independently.
- Never edit `/home/dev/devbox`, `/home/dev/fleet-core`, `~/.config/opencode`, deployment/source config, systemd units, timers, or live state. Repository examples and product defaults may change; deployment config may not.
- Treat API-key and unknown-auth inventory as untrusted and quarantined. An untrusted `api` provider becomes `blocked-quarantined`, never `evidence-pending`; trust is the operator's explicit subscription attestation in `trustedSubscriptionProviders`, not a catalog claim or reference price.
- Generated resolver entries set every supported input, output, cache-read, and cache-write cost field to numeric zero. Generated entries contain no credentials, bearer values, API keys, token paths, environment values, or `baseURL`.
- Resolver overlays, generation registries, generation bundles, broker policy, and reconciliation state are schema-versioned, private (`0700` directories, `0600` files), atomically replaced, and fail loudly on corruption, unknown versions, hash mismatch, or high-water regression. Corrupt state is preserved for diagnosis, never reset to empty.
- Every compatibility probe goes through the normal loopback fleet gateway and broker. No test, CLI, renderer, plugin, or service calls a provider API or llama.cpp directly, and no externally advertised gateway model is added.
- Preserve the plugin one-export rule: `plugin/router.js` continues to export exactly one factory function; all helper constants and functions live under `lib/`.
- Policy replacement must preserve provider weighting, quota balancing, target health/circuits, context/output limits, profile and tier boundaries, local/private network constraints, and unrelated routing. It inherits routing intent only; candidate context, output, variants, and capabilities come from fresh candidate metadata.
- Every test injects clocks, randomness, filesystem roots, resolver execution, broker calls, gateway calls, process identity, and network-facing functions. Tests must not use the live home directory, live Unix socket, live resolver cache, live gateway, provider network, or deployment config.
- Release baseline is exactly `1.23.0`, and Task 10 may change only `package.json` to `1.24.0` dated `2026-09-30`. Before Task 1, run `node -e 'const p=require("./package.json"); if (p.version!=="1.23.0") process.exit(1)'`; a nonzero result stops all ten tasks and requires re-planning. This repository does not track `package-lock.json`; do not generate or stage one. Never downgrade or overwrite an intervening release.
- Begin execution from a clean worktree, never stage unrelated files, and use each task's exact `git add` list. If any listed path has concurrent edits, stop that task and integrate from clean HEAD rather than overwriting it; this is especially strict for gateway files in Task 7.
- Commit each task independently. Do not push, deploy, restart a service, publish inventory, activate apply mode, or begin Package 4 in this plan.

## Review Focus

1. Trusted `api` subscription models must enumerate as `subscription-trusted`, while an otherwise identical untrusted `api` provider remains `blocked-quarantined`; Task 1 pins this in `trusted api subscriptions enumerate active models while untrusted api stays blocked-quarantined`.
2. A crash between config and manifest publication, or a base edit removing an active/probation/rollback reference, must leave the prior generation current; Task 3 pins this in `config manifest publication crash preserves current generation` and `base removal requires the same authorized retirement`.
3. Missing, invalid, forged-future, cleaned-generation, and pre-restart process tokens must all receive generation-0-only eligibility without rolling back global policy; Task 5 pins this in `unsafe registrations fall back to generation zero and restart invalidates tokens`.
4. Every saga crash boundary must recover idempotently, while stale revision/incumbent CAS must stop before later mutation; Task 9 pins this in `recovery resumes every acknowledged saga boundary and stale CAS blocks`.
5. Old-client-only traffic must pause probation, abandoned leases and non-model failures must remain neutral, and two post-activation model failures must roll back; Task 8 pins this in `probation pauses without compatible opportunity and post-active failures roll back`.

---

### Task 1: Trusted subscription admission and role policy

**Files:**
- Modify: `lib/model-roles.js`
- Modify: `lib/routing.js`
- Modify: `lib/model-reconcile.js`
- Modify: `lib/config.js`
- Modify: `examples/config.example.json`
- Modify: `examples/minimal.config.json`
- Modify: `tests/model-roles.test.mjs`
- Modify: `tests/routing.test.mjs`
- Modify: `tests/model-reconcile.test.mjs`
- Modify: `tests/config-parse.test.mjs`

**Interfaces:**
- Produces: `REASONING_MODES = Object.freeze(["none", "low", "medium", "high", "xhigh"])` from `lib/model-roles.js`.
- Extends every normalized role with required `effortCeiling: "none" | "low" | "medium" | "high" | "xhigh"` and optional `requiredReasoningMode: null | one of REASONING_MODES`.
- Keeps `matchModelRole(providerID, model, roles)` and `normalizeModelRoles(overrides, { warn })` signatures unchanged.
- Extends `discoverSubscriptionTargets(inventory, authTypes, staticTargets, options)` so connected OAuth active models retain `source: "subscription-oauth"`, connected trusted `api` active models use `source: "subscription-trusted"`, and untrusted `api` models produce no targets.
- Extends reconciliation observations with `role.effortCeiling`, `role.requiredReasoningMode`, and `state: "blocked-quarantined"` for untrusted API inventory. Trust remains the injected/configured `trustedProviderIDs` set.
- Default ceilings preserve current intent: Opus/Sonnet/Sol/Terra `high`, Fable/Astra `xhigh`, Haiku/Luna `medium`; current roles set `requiredReasoningMode: null`.

- [ ] **Step 1: Add the failing role-policy tests**

```js
import { REASONING_MODES, normalizeModelRoles } from "../lib/model-roles.js";

test("roles carry an effort ceiling and an optional required reasoning mode", () => {
  assert.deepEqual(REASONING_MODES, ["none", "low", "medium", "high", "xhigh"]);
  const roles = normalizeModelRoles({
    "openai:gpt-sol": { effortCeiling: "medium", requiredReasoningMode: "low" },
  });
  assert.equal(roles["openai:gpt-sol"].effortCeiling, "medium");
  assert.equal(roles["openai:gpt-sol"].requiredReasoningMode, "low");
  assert.equal(Object.isFrozen(roles["openai:gpt-sol"]), true);
});

test("invalid effort policy is rejected without deleting the product role", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "openai:gpt-sol": { effortCeiling: "turbo", requiredReasoningMode: "magic" },
  }, { warn: (message) => warnings.push(message) });
  assert.equal(roles["openai:gpt-sol"].effortCeiling, "high");
  assert.equal(warnings.length, 1);
});
```

- [ ] **Step 2: Add the failing trusted-versus-untrusted admission test**

```js
test("trusted api subscriptions enumerate active models while untrusted api stays blocked-quarantined", () => {
  const trusted = discoverSubscriptionTargets(INVENTORY_WITH_ACTIVE_ANTHROPIC, { anthropic: "api" }, {}, {
    resolvableModels: new Set(["anthropic/claude-opus-5-5"]),
    trustedProviderIDs: new Set(["anthropic"]),
  });
  assert.equal(trusted.providers.anthropic.admission, "admitted");
  assert.equal(Object.values(trusted.targets)[0].source, "subscription-trusted");

  const untrusted = discoverSubscriptionTargets(INVENTORY_WITH_ACTIVE_ANTHROPIC, { anthropic: "api" }, {}, {
    resolvableModels: new Set(["anthropic/claude-opus-5-5"]),
    trustedProviderIDs: new Set(),
  });
  assert.deepEqual(untrusted.targets, {});
  const report = runDryReconciliation(reconcileArgs({ authTypes: { anthropic: "api" }, trustedProviderIDs: [] }));
  assert.equal(report.roles[0].state, "blocked-quarantined");
  assert.equal(report.roles[0].reason, "provider authentication is not operator-attested subscription access");
});
```

- [ ] **Step 3: Run the focused tests and verify the red state**

```bash
node --experimental-test-module-mocks --test --test-name-pattern="effort ceiling|trusted api subscriptions" tests/model-roles.test.mjs tests/routing.test.mjs tests/model-reconcile.test.mjs
```

Expected: FAIL because `REASONING_MODES` is not exported, role fields are rejected, trusted API inventory reports zero models, and the untrusted record does not reach `blocked-quarantined`.

- [ ] **Step 4: Implement strict role-policy normalization**

Add both keys to `ROLE_FIELDS`, make `effortCeiling` part of `REQUIRED_NEW_FIELDS`, and normalize without mutating defaults:

```js
export const REASONING_MODES = Object.freeze(["none", "low", "medium", "high", "xhigh"]);
const validateReasoningMode = (label, value, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null)) return null;
  if (!REASONING_MODES.includes(value)) fail(`${label} must be one of ${REASONING_MODES.join(", ")}`);
  return value;
};
```

`buildRole()` replaces `effortCeiling` and `requiredReasoningMode` when supplied, inherits them otherwise, and freezes both into the returned role. Update repository examples with one documented trusted provider and explicit role effort fields; examples must not contain credentials or live host paths.

- [ ] **Step 5: Implement trusted active-model enumeration and quarantine classification**

In `discoverSubscriptionTargets()`, compute the admitted active set once:

```js
const trustedSubscription = trusted.has(providerID);
const subscriptionModels = connected.has(providerID) &&
  (authType === "oauth" || (authType === "api" && trustedSubscription))
  ? models.filter(activeModel)
  : [];
const source = authType === "oauth" ? "subscription-oauth" : "subscription-trusted";
```

Use `subscriptionModels` consistently for provider counts, pin detection, and target creation. In `runDryReconciliation()`, map connected untrusted `api`/unknown auth to `blocked-quarantined` before evidence enqueueing; never enqueue an evidence request for that state.

- [ ] **Step 6: Run focused and admission regressions**

```bash
node --experimental-test-module-mocks --test tests/model-roles.test.mjs tests/routing.test.mjs tests/model-reconcile.test.mjs tests/config-parse.test.mjs
node --experimental-test-module-mocks --test tests/reconcile-evidence-queue.test.mjs tests/reconcile-classify.test.mjs tests/provider-check.test.mjs
```

Expected: PASS with zero failures; OAuth sources remain `subscription-oauth`, trusted API sources are `subscription-trusted`, untrusted API records are never evidence-queued, and role defaults cannot be removed.

- [ ] **Step 7: Prove the new tests fail without production changes, then restore green**

```bash
git add tests/model-roles.test.mjs tests/routing.test.mjs tests/model-reconcile.test.mjs tests/config-parse.test.mjs
git stash push -u --keep-index -m "red-green trusted subscription admission"
node --experimental-test-module-mocks --test --test-name-pattern="effort ceiling|trusted api subscriptions" tests/model-roles.test.mjs tests/routing.test.mjs tests/model-reconcile.test.mjs
git stash pop
node --experimental-test-module-mocks --test tests/model-roles.test.mjs tests/routing.test.mjs tests/model-reconcile.test.mjs tests/config-parse.test.mjs
```

Expected: FAIL while production changes are stashed, then PASS after restore with no unmerged entries.

- [ ] **Step 8: Commit trusted admission and role policy**

```bash
git add lib/model-roles.js lib/routing.js lib/model-reconcile.js lib/config.js examples/config.example.json examples/minimal.config.json tests/model-roles.test.mjs tests/routing.test.mjs tests/model-reconcile.test.mjs tests/config-parse.test.mjs
git commit -m "feat: admit trusted subscription provider models"
```

### Task 2: Authorized resolver overlay

**Files:**
- Create: `lib/reconcile-overlay.js`
- Create: `tests/reconcile-overlay.test.mjs`
- Modify: `docs/STATE.md`

**Interfaces:**
- Produces: `RESOLVER_OVERLAY_VERSION = 1`.
- Produces: `emptyResolverOverlay({ now? }): { version, revision, updatedAt, entries }` and `hashResolverOverlay(overlay): sha256hex` over canonical JSON.
- Produces: `buildResolverOverlay({ ledger, modelRoles, catalogModels, introductionGeneration, overlayUpdatedAt, previous? }): ResolverOverlay`; `overlayUpdatedAt` comes from durable apply intent so recovery reconstructs identical bytes.
- Produces: `validateResolverOverlay(overlay, { ledger, modelRoles, previous? }): ResolverOverlay` returning a normalized clone or throwing.
- Produces: `createResolverOverlayStore({ path?, root?, lockPath?, now?, pid? }): { read(), write(overlay, { expectedPreviousHash, expectedRevision }), paths() }`; synchronous `write()` holds a private inter-process exclusive lock and returns `{ changed, replayed, hash, revision }`.
- Overlay entries are keyed by exact `providerID/modelID` and contain `{ transitionID, revision, authorizationKind, providerID, modelID, roleKey, authorizationHash, introductionGeneration, model }`.
- `authorizationKind` is exactly `"auto-eligible" | "approved"`; `authorizationHash` is sha256 hex of immutable evidence or approval decision fields. `model.cost` is exactly `{ input: 0, output: 0, cache_read: 0, cache_write: 0 }`.
- `introductionGeneration` is the positive generation reserved in the ledger intent before rendering. Existing entries retain their first introduction generation forever.

- [ ] **Step 1: Write failing construction and stability tests**

```js
import {
  RESOLVER_OVERLAY_VERSION,
  buildResolverOverlay,
  createResolverOverlayStore,
  emptyResolverOverlay,
  validateResolverOverlay,
} from "../lib/reconcile-overlay.js";

test("authorized entries are stable, zero cost, and retain first introduction generation", () => {
  const first = buildResolverOverlay({
    ledger: authorizedLedger(), modelRoles: TEST_ROLES, catalogModels: GPT6_CATALOG,
    introductionGeneration: 4, overlayUpdatedAt: NOW,
  });
  const entry = first.entries["openai/gpt-6-sol"];
  assert.equal(first.version, RESOLVER_OVERLAY_VERSION);
  assert.equal(entry.authorizationKind, "auto-eligible");
  assert.equal(entry.introductionGeneration, 4);
  assert.deepEqual(entry.model.cost, { input: 0, output: 0, cache_read: 0, cache_write: 0 });

  const replay = buildResolverOverlay({
    ledger: authorizedLedger(), modelRoles: TEST_ROLES, catalogModels: GPT6_CATALOG,
    introductionGeneration: 9, previous: first, overlayUpdatedAt: NOW,
  });
  assert.equal(replay.entries["openai/gpt-6-sol"].introductionGeneration, 4);
  assert.equal(replay.entries["openai/gpt-6-sol"].authorizationHash, entry.authorizationHash);
});
```

- [ ] **Step 2: Write failing rejection and private-store tests**

```js
test("validation rejects orphan mismatch nonzero secret baseURL mutation and deletion", () => {
  const valid = buildResolverOverlay(OVERLAY_ARGS);
  for (const mutate of [
    (x) => { x.entries[MODEL].transitionID = "orphan"; },
    (x) => { x.entries[MODEL].providerID = "anthropic"; },
    (x) => { x.entries[MODEL].model.cost.input = 1; },
    (x) => { x.entries[MODEL].model.apiKey = "not-a-real-secret"; },
    (x) => { x.entries[MODEL].model.baseURL = "https://provider.invalid"; },
    (x) => { x.entries[MODEL].model.limit.context += 1; },
    (x) => { delete x.entries[MODEL]; },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => validateResolverOverlay(changed, {
      ledger: authorizedLedger(), modelRoles: TEST_ROLES, previous: valid,
    }), /orphan|mismatch|zero|secret|baseURL|append-only|removed/);
  }
});

test("the overlay store atomically writes a private versioned file and rejects corruption", () => {
  const store = createResolverOverlayStore({ root, now: () => NOW, pid: 42 });
  const initial = emptyResolverOverlay({ now: () => NOW - 1 });
  const next = buildResolverOverlay({
    ...OVERLAY_ARGS, previous: initial, overlayUpdatedAt: INTENT_OVERLAY_UPDATED_AT,
  });
  store.write(next, {
    expectedPreviousHash: hashResolverOverlay(initial), expectedRevision: initial.revision,
  });
  assert.equal(statSync(store.paths().root).mode & 0o777, 0o700);
  assert.equal(statSync(store.paths().overlay).mode & 0o777, 0o600);
  const before = readFileSync(store.paths().overlay);
  const store2 = createResolverOverlayStore({ root, now: () => NOW + 1, pid: 43 });
  assert.throws(() => store2.write(
    buildResolverOverlay({
      ...OVERLAY_ARGS, previous: next, overlayUpdatedAt: NEXT_INTENT_OVERLAY_UPDATED_AT,
    }),
    { expectedPreviousHash: hashResolverOverlay(initial), expectedRevision: initial.revision },
  ), /stale overlay hash|revision/);
  assert.deepEqual(readFileSync(store.paths().overlay), before);
  writeFileSync(store.paths().overlay, "{broken\n", { mode: 0o600 });
  assert.throws(() => store.read(), /resolver overlay.*corrupt/i);
});

test("commit-before-ack replay at a later clock is byte-identical", () => {
  const initial = emptyResolverOverlay({ now: () => NOW - 1 });
  const desired = buildResolverOverlay({
    ...OVERLAY_ARGS, previous: initial, overlayUpdatedAt: INTENT_OVERLAY_UPDATED_AT,
  });
  const first = createResolverOverlayStore({ root, now: () => NOW, pid: 42 });
  first.write(desired, {
    expectedPreviousHash: hashResolverOverlay(initial), expectedRevision: initial.revision,
  });
  const before = readFileSync(first.paths().overlay);
  const recovered = createResolverOverlayStore({ root, now: () => NOW + 86_400_000, pid: 43 });
  const result = recovered.write(buildResolverOverlay({
    ...OVERLAY_ARGS, previous: initial, overlayUpdatedAt: INTENT_OVERLAY_UPDATED_AT,
  }), {
    expectedPreviousHash: hashResolverOverlay(initial), expectedRevision: initial.revision,
  });
  assert.equal(result.replayed, true);
  assert.deepEqual(readFileSync(first.paths().overlay), before);
});

test("two writers from one expected revision cannot overwrite each other", async () => {
  const [left, right] = await Promise.allSettled([
    forkOverlayWriter({ root, desired: LEFT, expected: INITIAL_IDENTITY }),
    forkOverlayWriter({ root, desired: RIGHT, expected: INITIAL_IDENTITY }),
  ]);
  assert.equal([left, right].filter((x) => x.status === "fulfilled").length, 1);
  assert.match([left, right].find((x) => x.status === "rejected").reason.message,
    /stale overlay hash|revision/);
  assert.deepEqual(readFileSync(overlayPath), bytesOf(
    [left, right].find((x) => x.status === "fulfilled").value.overlay,
  ));
});
```

- [ ] **Step 3: Run the overlay tests and verify the red state**

```bash
node --experimental-test-module-mocks --test tests/reconcile-overlay.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/reconcile-overlay.js`.

- [ ] **Step 4: Implement the pure overlay schema and authorization checks**

Use a canonical JSON helper that recursively sorts object keys before hashing. Build only from ledger records in `auto-eligible` or `approved` with exact provider/model/role identity, immutable evidence/decision hash, valid role mapping, positive reserved generation, and the persisted `overlayUpdatedAt` from apply intent. Copy only allowlisted resolver metadata (`id`, `name`, `family`, `release_date`, `tool_call`, `limit`, `variants`) and synthesize the zero-cost object; reject unsupported keys rather than filtering a suspicious entry silently.

```js
export const RESOLVER_OVERLAY_VERSION = 1;
export const emptyResolverOverlay = ({ now = Date.now } = {}) => ({
  version: RESOLVER_OVERLAY_VERSION,
  revision: 0,
  updatedAt: now(),
  entries: {},
});
```

- [ ] **Step 5: Implement the append-only private atomic store**

`read()` returns `emptyResolverOverlay()` only when the file is absent. Synchronous `write()` acquires a mode-0600 sibling lock across disk read, expected hash/revision validation, replay detection, atomic write, and parent `fsync`; lock acquisition is bounded and stale ownership uses the repository's existing lock primitive, never blind deletion. Under the lock it compares both expected previous canonical hash and revision with disk. A same-intent commit-before-ack replay returns `replayed: true` without rewriting bytes; different desired bytes against stale expectations throw. A new write uses a mode-0600 sibling temp file with one trailing newline, `fsync`s it, renames it, and `fsync`s the mode-0700 parent. A parse error, unknown version, unsupported field, changed historical entry, removed entry, stale hash, or stale revision throws and leaves the original bytes untouched. `paths()` returns `{ root, overlay, lock }`.

- [ ] **Step 6: Document overlay ownership and run focused regressions**

Add the overlay path, schema, owner, modes, append-only rule, and explicit prohibition on credentials/`baseURL` to `docs/STATE.md`, then run:

```bash
node --experimental-test-module-mocks --test tests/reconcile-overlay.test.mjs tests/reconcile-state.test.mjs tests/reconcile-classify.test.mjs
```

Expected: PASS with zero failures; corruption remains loud and the existing ledger schema remains version 1.

- [ ] **Step 7: Prove red/green and commit**

```bash
git add tests/reconcile-overlay.test.mjs
git stash push -u --keep-index -m "red-green resolver overlay"
node --experimental-test-module-mocks --test tests/reconcile-overlay.test.mjs
git stash pop
node --experimental-test-module-mocks --test tests/reconcile-overlay.test.mjs
git add lib/reconcile-overlay.js tests/reconcile-overlay.test.mjs docs/STATE.md
git commit -m "feat: materialize authorized resolver overlays"
```

Expected: missing-module FAIL while stashed, then PASS and one commit containing only the three listed paths.

### Task 3: Immutable resolver generations

**Files:**
- Create: `lib/resolver-generations.js`
- Create: `tests/resolver-generations.test.mjs`
- Create: `tests/fixtures/fake-opencode-models.mjs`
- Modify: `docs/STATE.md`

**Interfaces:**
- Produces: `RESOLVER_REGISTRY_VERSION = 1`.
- Produces: `mergeResolverConfig(baseConfig, overlay): object`, returning a new config and rejecting provider/model collisions, unsupported overlay fields, nonzero costs, mutation, or deletion.
- Produces: `createResolverGenerationManager({ root, currentLinkPath, runResolver, now, pid })`.
- Manager methods: `readRegistry()`, `build({ reservedGeneration, bootstrapGeneration0?, baseConfigPath, overlay, authorizingRevisions, protectedReferences, authorizedRetirements })`, `publish(candidate)`, `generation(generation)`, `current()`, `cleanup({ activeGenerations, olderThanMs? })`, and `paths()`.
- `reservedGeneration` comes from the already-persisted ledger intent and must equal registry `highWater + 1` under the manager lock. `bootstrapGeneration0: true` is accepted only for an empty registry, no current link, and an empty overlay; it builds immutable generation 0 without weakening later monotonic checks.
- `build()` returns `{ generation, directory, manifest, manifestHash, effectiveHash, reused }`; it validates `overlay.entries[*].introductionGeneration` against the chosen generation for newly introduced entries.
- `generation(generation)` returns `{ generation, directory, manifest, manifestHash, effectiveHash }` only after resolving the canonical registry-owned directory under `root`, rejecting directory/file symlinks or path escape, hashing exact manifest bytes, hashing canonical effective config JSON, and matching registry generation/hash/effectiveHash. It never accepts a caller path.
- Registry shape: `{ version: 1, highWater, generations: { [generation]: { manifestHash, effectiveHash, createdAt } } }`. Manifest shape: `{ version: 1, generation, baseHash, overlayHash, effectiveHash, modelKeys, createdAt, authorizingRevisions }`.
- `runResolver({ xdgConfigHome, configPath, env }): Promise<string>` runs the production equivalent of `opencode models --pure`; tests inject a child-process fixture and never invoke providers.

- [ ] **Step 1: Write failing merge, canonical hash, and exact-manifest tests**

```js
test("build records the exact resolver set from a scratch XDG config", async () => {
  const calls = [];
  const manager = createResolverGenerationManager({
    root, currentLinkPath,
    runResolver: async (request) => {
      calls.push(request);
      assert.equal(request.xdgConfigHome.startsWith(root), true);
      assert.equal(readFileSync(request.configPath, "utf8").includes("gpt-6-sol"), true);
      return "openai/gpt-5.6-sol\nopenai/gpt-6-sol\n";
    },
    now: () => NOW, pid: 7,
  });
  const candidate = await manager.build({
    reservedGeneration: 1, baseConfigPath, overlay: overlayForGeneration(1),
    authorizingRevisions: ["rev-1"], protectedReferences: [], authorizedRetirements: [],
  });
  assert.deepEqual(candidate.manifest.modelKeys, ["openai/gpt-5.6-sol", "openai/gpt-6-sol"]);
  assert.equal(calls.length, 1);
});

test("identical effective config reuses the current generation without resolver execution", async () => {
  const first = await manager.build(BUILD_ARGS);
  await manager.publish(first);
  const replayManager = createResolverGenerationManager({
    root, currentLinkPath, now: () => NOW + 1, pid: 8,
    runResolver: () => { throw new Error("must not run for hash reuse"); },
  });
  const replay = await replayManager.build({ ...BUILD_ARGS, reservedGeneration: 2 });
  assert.equal(replay.reused, true);
  assert.equal(replay.generation, first.generation);
});

test("generation lookup returns only the canonical independently verified bundle", async () => {
  const built = await manager.build(GEN1_ARGS);
  await manager.publish(built);
  assert.deepEqual(manager.generation(1), {
    generation: 1, directory: built.directory, manifest: built.manifest,
    manifestHash: built.manifestHash, effectiveHash: built.effectiveHash,
  });
  for (const mutation of ["directory-symlink", "manifest-symlink", "config-symlink",
    "path-escape", "manifest-bytes", "effective-config", "registry-hash"]) {
    const fixture = mutatedGenerationFixture(mutation);
    assert.throws(() => fixture.manager.generation(fixture.generation),
      /canonical|symlink|escape|manifest|effective|registry|hash/);
  }
});
```

- [ ] **Step 2: Write the named crash, high-water, cleanup, and base-removal tests**

```js
test("config manifest publication crash preserves current generation", async () => {
  const generation0 = await manager.build({ ...GEN0_ARGS, reservedGeneration: 0, bootstrapGeneration0: true });
  await manager.publish(generation0);
  const generation1 = await manager.build({ ...GEN1_ARGS, reservedGeneration: 1 });
  unlinkSync(join(generation1.directory, "manifest.json"));
  await assert.rejects(manager.publish(generation1), /manifest.*missing|hash mismatch/i);
  assert.equal(manager.current().generation, 0);
});

test("base removal requires the same authorized retirement", async () => {
  await assert.rejects(manager.build({
    ...BUILD_WITH_BASE_REMOVAL,
    protectedReferences: [{ roleKey: "openai:gpt-sol", kind: "rollback", modelKey: "openai/gpt-5.6-sol" }],
    authorizedRetirements: [],
  }), /protected rollback reference.*gpt-5\.6-sol/);
});

test("registry loss or high-water regression fails loudly", () => {
  writeFileSync(manager.paths().registry, JSON.stringify({ version: 1, highWater: 0, generations: { 4: HASHES } }));
  assert.throws(() => manager.readRegistry(), /high-water.*regressed/i);
});

test("a stale reserved generation is rejected after another publisher advances high-water", async () => {
  const reserved = manager.readRegistry().highWater + 1;
  const winner = await manager.build({ ...BUILD_ARGS, reservedGeneration: reserved });
  await manager.publish(winner);
  await assert.rejects(manager.build({ ...OTHER_BUILD_ARGS, reservedGeneration: reserved }),
    /reserved generation.*stale.*expected/);
});

test("render start race keeps config and manifest in one resolved directory", async () => {
  const generation0 = await manager.build({ ...GEN0_ARGS, reservedGeneration: 0, bootstrapGeneration0: true });
  await manager.publish(generation0);
  const startupDirectory = realpathSync(manager.paths().currentLink);
  const generation1 = await manager.build({ ...GEN1_ARGS, reservedGeneration: 1 });
  await manager.publish(generation1);
  assert.equal(JSON.parse(readFileSync(join(startupDirectory, "manifest.json"))).generation, 0);
  assert.equal(readFileSync(join(startupDirectory, "opencode.json"), "utf8").includes("gpt-6-sol"), false);
});

test("generation zero rollback and cleanup preserve protected generations and sweep temps", async () => {
  const generation0 = await manager.build({ ...GEN0_ARGS, reservedGeneration: 0, bootstrapGeneration0: true });
  await manager.publish(generation0);
  const generation1 = await manager.build({ ...GEN1_ARGS, reservedGeneration: 1 });
  await manager.publish(generation1);
  await manager.publish(generation0);
  mkdirSync(join(root, ".generation-9.7.tmp"));
  const cleaned = manager.cleanup({ activeGenerations: new Set([1]), olderThanMs: 0 });
  assert.equal(manager.current().generation, 0);
  assert.equal(existsSync(generation1.directory), true, "an active process keeps generation 1");
  assert.equal(existsSync(join(root, ".generation-9.7.tmp")), false);
  assert.deepEqual(cleaned.removedTemp, [".generation-9.7.tmp"]);
});
```

- [ ] **Step 3: Run the generation tests and verify the red state**

```bash
node --experimental-test-module-mocks --test tests/resolver-generations.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/resolver-generations.js`.

- [ ] **Step 4: Implement immutable merge and build**

`mergeResolverConfig()` deep-clones the base and adds only overlay model keys under their existing provider. `build()` reads base and overlay bytes once, hashes those exact bytes, acquires the registry lock, and requires the supplied `reservedGeneration` to equal `highWater + 1`; a stale or duplicate reservation fails before writing. It creates a mode-0700 sibling temp directory, writes mode-0600 `opencode.json`, and invokes `runResolver()` with a scratch `XDG_CONFIG_HOME` whose real config points only at that candidate. Parse the returned lines with `parseResolvableModelsOutput()`, require every overlay key, sort the exact set, write and hash `manifest.json`, `fsync` both files and directory, then rename the directory into its immutable generation name. If a crash left an immutable directory at the reserved number, reuse it only when every canonical hash and revision matches; otherwise fail loudly.

- [ ] **Step 5: Implement registry and atomic current-link publication**

`publish(candidate)` re-reads and validates both files and hashes, writes the versioned registry atomically, then creates a relative sibling symlink such as `.current.<pid>.tmp` and renames it over `currentLinkPath`; `fsync` the parent after each rename. If config or manifest is absent/mismatched, do not alter registry or `current`. `current()` resolves the link once and verifies generation plus manifest hash. Generation 0 is built from base only and is never cleaned.

- [ ] **Step 6: Implement recovery-safe cleanup and the real CLI adapter contract**

`cleanup()` removes only temp directories and immutable generations that are not generation 0, current, or in `activeGenerations`, and only after 30 days by default. An unknown/cleaned generation is reported, not recreated. The production `runResolver` adapter uses argv `opencode models --pure`, passes `XDG_CONFIG_HOME` as the candidate scratch root, captures bounded stdout, and deletes its scratch directory in `finally`; the test fixture asserts argv/env and emits deterministic model lines without network access.

- [ ] **Step 7: Run focused and filesystem regressions**

```bash
node --experimental-test-module-mocks --test tests/resolver-generations.test.mjs tests/reconcile-overlay.test.mjs tests/reconcile-state.test.mjs tests/model-reconcile-sources.test.mjs
```

Expected: PASS with zero failures, including render/start race, generation-0 rollback, temp cleanup, exact resolver membership, idempotent hash reuse, and base-reference safety.

- [ ] **Step 8: Prove red/green, document state, and commit**

```bash
git add tests/resolver-generations.test.mjs tests/fixtures/fake-opencode-models.mjs
git stash push -u --keep-index -m "red-green resolver generations"
node --experimental-test-module-mocks --test tests/resolver-generations.test.mjs
git stash pop
node --experimental-test-module-mocks --test tests/resolver-generations.test.mjs
git add lib/resolver-generations.js tests/resolver-generations.test.mjs tests/fixtures/fake-opencode-models.mjs docs/STATE.md
git commit -m "feat: render immutable resolver generations"
```

Expected: missing-module FAIL while stashed, then PASS; the commit contains no generated generation directories.

### Task 4: Broker modelPolicy and compare-and-swap API

**Files:**
- Create: `lib/model-policy.js`
- Create: `tests/model-policy.test.mjs`
- Modify: `bin/opencode-broker`
- Modify: `lib/config.js`
- Modify: `examples/config.example.json`
- Modify: `examples/minimal.config.json`
- Modify: `tests/broker.test.mjs`
- Modify: `tests/config-parse.test.mjs`
- Modify: `docs/API.md`
- Modify: `docs/STATE.md`

**Interfaces:**
- Produces: `MODEL_POLICY_VERSION = 1`.
- Produces: `emptyModelPolicy(): { version: 1, roles: {}, history: [] }`.
- Produces: `normalizeModelPolicy(value, { modelRoles, staticTargets }): ModelPolicy` and throws on unknown fields, invalid role/model identity, malformed counters, or version mismatch.
- Produces: `compareAndSwapModelPolicy(current, request, { now? }): { policy, ack, changed }`.
- CAS request shape: `{ transitionID, revision, roleKey, expectedIncumbentModelID, generation, manifestHash, desired }`.
- Explicit role record shape: `{ roleKey, providerID, incumbentModelID, activeModelID, probationModelID, rollbackModelID, routingIntent: { tiers, fit, effortCeiling, requiredReasoningMode }, introduction: { generation, manifestHash }, probation, revision, transitionID, history }`.
- Broker state migrates version 4 to version 5 by adding normalized `modelPolicy`; `bin/opencode-broker` remains the only `broker.json` writer.
- Config adds `reconcile.apply: { enabled: false, overlayPath: null, generationsRoot: null, currentLinkPath: null }`.
- API adds loopback `POST /model-policy/cas` and read-only `GET /model-policy/status`.

- [ ] **Step 1: Write failing pure policy and CAS tests**

```js
test("CAS seeds an explicit incumbent and is idempotent for the same transition revision", () => {
  const request = policyRequest({ expectedIncumbentModelID: "gpt-5.6-sol" });
  const first = compareAndSwapModelPolicy(emptyModelPolicy(), request, { now: () => NOW });
  assert.equal(first.changed, true);
  assert.equal(first.policy.roles[ROLE].activeModelID, "gpt-5.6-sol");
  assert.equal(first.policy.roles[ROLE].probationModelID, "gpt-6-sol");
  const replay = compareAndSwapModelPolicy(first.policy, request, { now: () => NOW + 1 });
  assert.equal(replay.changed, false);
  assert.deepEqual(replay.ack, first.ack);
});

test("CAS rejects stale revision and incumbent mismatch without changing bytes", () => {
  const current = seededPolicy();
  for (const request of [policyRequest({ revision: "older" }), policyRequest({ expectedIncumbentModelID: "wrong" })]) {
    assert.throws(() => compareAndSwapModelPolicy(current, request), /stale revision|incumbent mismatch/);
    assert.deepEqual(current, seededPolicy());
  }
});
```

- [ ] **Step 2: Write failing broker migration, disabled, and status tests**

```js
test("disabled model-policy CAS returns 409 and writes no broker state", async () => {
  const before = readFileSync(statePath);
  const response = await post(socketPath, "/model-policy/cas", policyRequest());
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "reconcile-apply-disabled");
  assert.deepEqual(readFileSync(statePath), before);
});

test("v4 state migrates to v5 with an empty policy and status is readable", async () => {
  seedBrokerState({ version: 4 });
  const status = await get(socketPath, "/model-policy/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.modelPolicy.version, MODEL_POLICY_VERSION);
  assert.deepEqual(status.body.modelPolicy.roles, {});
});
```

- [ ] **Step 3: Run focused tests and verify the red state**

```bash
node --experimental-test-module-mocks --test tests/model-policy.test.mjs tests/config-parse.test.mjs --test-name-pattern="CAS|model-policy|apply"
```

Expected: FAIL because `lib/model-policy.js`, `reconcile.apply`, state v5, and both endpoints do not exist.

- [ ] **Step 4: Implement normalized policy and CAS**

Keep `compareAndSwapModelPolicy()` pure. First creation requires `current incumbent === expectedIncumbentModelID`; a role with no incumbent stores explicit `activeModelID: null`. A replay with the same transition/revision and canonical desired-policy hash returns the original ack. A lower/different revision for the same transition, changed desired hash, changed introduction manifest, or incumbent mismatch throws before returning a policy.

- [ ] **Step 5: Migrate broker state v4 to v5 and add default-off config**

Change `emptyState()` and `writeState()` to version 5. `readState()` accepts only current v5 plus explicit v4 migration, preserves all existing fields, and normalizes `modelPolicy`; malformed v5 policy must fail broker startup loudly rather than enter the existing catch-to-empty path. Parse `reconcile.apply.enabled` only when strictly `true`, require all three non-empty absolute paths when enabled, otherwise force `enabled: false` and paths to `null` with a visible `configError`.

- [ ] **Step 6: Add loopback CAS and status handlers**

`POST /model-policy/cas` returns 409 `{ code: "reconcile-apply-disabled" }` before calling CAS when disabled. When enabled, it validates, computes CAS, calls the existing `writeState(state)` once only when `changed`, and returns `{ ok: true, ack, changed }`. `GET /model-policy/status` returns normalized policy and apply status without writing. Reject non-loopback peers before parsing a control body.

- [ ] **Step 7: Run policy and broker regressions**

```bash
node --experimental-test-module-mocks --test tests/model-policy.test.mjs tests/broker.test.mjs tests/config-parse.test.mjs tests/refusal-codes.test.mjs
node --experimental-test-module-mocks --test tests/routing.test.mjs tests/model-slots.test.mjs tests/provider-health.test.mjs
```

Expected: PASS with zero failures; disabled CAS has byte-identical state, v4 migration preserves leases/inventory/health, and existing broker endpoints behave unchanged.

- [ ] **Step 8: Prove red/green, document, and commit**

```bash
git add tests/model-policy.test.mjs tests/broker.test.mjs tests/config-parse.test.mjs
git stash push -u --keep-index -m "red-green broker model policy"
node --experimental-test-module-mocks --test tests/model-policy.test.mjs tests/broker.test.mjs --test-name-pattern="CAS|model-policy"
git stash pop
node --experimental-test-module-mocks --test tests/model-policy.test.mjs tests/broker.test.mjs tests/config-parse.test.mjs
git add lib/model-policy.js bin/opencode-broker lib/config.js examples/config.example.json examples/minimal.config.json tests/model-policy.test.mjs tests/broker.test.mjs tests/config-parse.test.mjs docs/API.md docs/STATE.md
git commit -m "feat: persist broker model policy"
```

### Task 5: Resolver process registration and plugin token

**Files:**
- Create: `lib/resolver-processes.js`
- Create: `tests/resolver-processes.test.mjs`
- Modify: `bin/opencode-broker`
- Modify: `plugin/router.js`
- Modify: `lib/router-core.js`
- Modify: `tests/broker.test.mjs`
- Modify: `tests/router.test.mjs`
- Modify: `tests/plugin-exports.test.mjs`
- Modify: `docs/API.md`
- Modify: `docs/STATE.md`

**Interfaces:**
- Produces: `createResolverProcessRegistry({ loadRegistry, loadBaseModelKeys, mintToken, now, activeMs: 600000 })`; `loadBaseModelKeys()` reads normalized static targets and is available without a generations root.
- Registry methods: `register({ generation, manifestHash, modelKeys, rawBase? })`, `authorize({ resolverToken, modelKey? })`, `touch(resolverToken)`, `status()`, and `clear()`.
- Successful registration returns `{ resolverToken, scope: "ordinary", generation, manifestHash, modelKeys, expiresAt }`; fallback authorization returns `{ resolverToken: null, scope: "base-only", generation: 0, manifestHash: null, modelKeys: loadBaseModelKeys(), reason }`.
- `authorize()` returns `{ generation, manifestHash, modelKeys, compatible, reason }`; absent/invalid/expired resolver token, future/unknown/cleaned generation, manifest mismatch, and raw-base identity return generation-0-only eligibility.
- API adds loopback `POST /resolver-process/register`. Every normal broker request may carry `resolverToken`; valid use touches its 10-minute active window.
- `ModelRouter({ client, directory } = {}, options = {})` keeps its public signature and sole export. Tests inject `options.brokerRequest`, `options.realpath`, and `options.readFile`; production defaults use existing helpers.

- [ ] **Step 1: Write failing registry identity and restart tests**

```js
test("valid current and old registrations authorize only exact manifest membership", () => {
  const registry = createResolverProcessRegistry({
    loadRegistry: () => generations([GEN0, GEN1, GEN2]), mintToken: () => "token-1",
    loadBaseModelKeys: () => GEN0.modelKeys,
    now: () => NOW, activeMs: 600_000,
  });
  const old = registry.register({ generation: 1, manifestHash: GEN1.hash, modelKeys: GEN1.modelKeys });
  assert.equal(registry.authorize({ resolverToken: old.resolverToken, modelKey: "openai/gpt-5.6-sol" }).compatible, true);
  assert.equal(registry.authorize({ resolverToken: old.resolverToken, modelKey: "openai/gpt-6-sol" }).compatible, false);
});

test("unsafe registrations fall back to generation zero and restart invalidates tokens", () => {
  for (const input of [null, { generation: 99, manifestHash: "forged" }, { generation: 1, manifestHash: "wrong" }, { rawBase: true }]) {
    assert.equal(registry.register(input ?? {}).generation, 0);
  }
  const issued = registry.register({ generation: 2, manifestHash: GEN2.hash, modelKeys: GEN2.modelKeys });
  const restarted = createResolverProcessRegistry(REGISTRY_ARGS);
  assert.equal(restarted.authorize({ resolverToken: issued.resolverToken, modelKey: "openai/gpt-6-sol" }).generation, 0);
  assert.equal(restarted.authorize({ resolverToken: issued.resolverToken }).reason, "invalid-token");
});

test("missing tokens and cleaned generations authorize generation zero only", () => {
  assert.equal(registry.authorize({ resolverToken: undefined, modelKey: "openai/gpt-6-sol" }).generation, 0);
  const issued = registry.register({ generation: 2, manifestHash: GEN2.hash, modelKeys: GEN2.modelKeys });
  diskRegistry = generations([GEN0, GEN1]);
  const cleaned = registry.authorize({ resolverToken: issued.resolverToken, modelKey: "openai/gpt-6-sol" });
  assert.equal(cleaned.generation, 0);
  assert.equal(cleaned.compatible, false);
  assert.equal(cleaned.reason, "cleaned-generation");
});
```

- [ ] **Step 2: Write failing plugin startup and sole-export tests**

```js
test("enabled plugin resolves config and manifest once then attaches its process token", async () => {
  const requests = [];
  const hooks = await ModelRouter({ client: fakeClient, directory: root }, {
    apply: { enabled: true, currentLinkPath },
    realpath: () => generationDirectory,
    readFile: (path) => fixtures[path],
    brokerRequest: async (path, body) => {
      requests.push({ path, body });
      return path === "/resolver-process/register" ? { resolverToken: "process-token", scope: "ordinary" } : LEASE;
    },
  });
  await routeOneMessage(hooks);
  assert.deepEqual(requests.map((x) => x.path), ["/resolver-process/register", "/lease"]);
  assert.equal(requests[1].body.resolverToken, "process-token");
  assert.equal(realpathCalls, 1);
});
```

- [ ] **Step 3: Run focused tests and verify the red state**

```bash
node --experimental-test-module-mocks --test tests/resolver-processes.test.mjs tests/router.test.mjs tests/plugin-exports.test.mjs --test-name-pattern="registration|process token|one factory"
```

Expected: FAIL because the registry and register endpoint are absent and lease bodies have no `resolverToken`.

- [ ] **Step 4: Implement the in-memory process registry**

Load and validate the generation registry on each registration, never trust caller-provided model keys over the stored manifest, and mint 256-bit URL-safe tokens. Store only token hash, generation, manifest hash, exact immutable model-key set, registered/touched/expiry times. `authorize()` never throws for an unsafe client; it returns generation 0 with a bounded reason and lets the broker record `blocked-generation`. `clear()` supports broker shutdown tests; process restart naturally starts empty.

- [ ] **Step 5: Add broker registration and token authorization**

The broker constructs one process registry at startup. `POST /resolver-process/register` is loopback-only and returns 409 `reconcile-apply-disabled` without reading generation paths or creating a record whenever apply is disabled. With apply enabled, validate the disk registry and return current/old registration or base-only fallback. Missing/invalid registration authorization derives logical generation-0/base-only model keys from normalized static targets, with `manifestHash: null`; it does not require the immutable generation-0 bundle that Package 4 creates at cutover. Lease parsing accepts only opaque `resolverToken`, calls `authorize()` inside the serial mutation path, and stores the authorization result on the lease decision without persisting the token.

- [ ] **Step 6: Register once in the plugin and wrap broker requests**

When apply is disabled, do not resolve/read/register and preserve byte-for-byte request bodies. When enabled, resolve `currentLinkPath` once during factory construction, read `opencode.json` and `manifest.json` from that one real directory, register their generation/hash, and close over the returned token. A local wrapper adds `{ resolverToken }` to every broker request body; helper code belongs in `lib/router-core.js`, and `plugin/router.js` remains the only factory export.

- [ ] **Step 7: Run registration, plugin, and broker regressions**

```bash
node --experimental-test-module-mocks --test tests/resolver-processes.test.mjs tests/router.test.mjs tests/plugin-exports.test.mjs tests/broker.test.mjs tests/resolver-generations.test.mjs
```

Expected: PASS with zero failures for valid old/current registrations, missing/invalid/future/cleaned/raw-base fallback, re-registration after restart, and the one-export rule.

- [ ] **Step 8: Prove red/green, document, and commit**

```bash
git add tests/resolver-processes.test.mjs tests/router.test.mjs tests/plugin-exports.test.mjs tests/broker.test.mjs
git stash push -u --keep-index -m "red-green resolver process registration"
node --experimental-test-module-mocks --test tests/resolver-processes.test.mjs tests/router.test.mjs --test-name-pattern="registration|process token"
git stash pop
node --experimental-test-module-mocks --test tests/resolver-processes.test.mjs tests/router.test.mjs tests/plugin-exports.test.mjs tests/broker.test.mjs
git add lib/resolver-processes.js bin/opencode-broker plugin/router.js lib/router-core.js tests/resolver-processes.test.mjs tests/broker.test.mjs tests/router.test.mjs tests/plugin-exports.test.mjs docs/API.md docs/STATE.md
git commit -m "feat: bind leases to resolver generations"
```

### Task 6: Policy-aware lane replacement and holds

**Files:**
- Create: `lib/policy-targets.js`
- Create: `tests/policy-targets.test.mjs`
- Modify: `lib/routing.js`
- Modify: `bin/opencode-broker`
- Modify: `tests/routing.test.mjs`
- Modify: `tests/broker.test.mjs`

**Interfaces:**
- Produces: `resolvePolicyLane({ targetIDs, targets, modelPolicy, registration, activeLeases, tier, enabled })`.
- Returns `{ targetIDs, targets, policyTargetID, reason, blockedGeneration }`; `targets` is the original map when unchanged or a shallow-cloned map containing derived candidate metadata. When disabled it returns a shallow copy of input IDs, the original target map, `policyTargetID: null`, and no hold.
- `registration` is the Task 5 authorization result with exact `modelKeys`; numeric generation ordering is never consulted.
- A governed role exposes only its `activeModelID` or eligible `probationModelID`. Every other fresh or stale discovered target in that role is held.
- Candidate targets inherit policy `tiers`, `fit`, `effortCeiling`, and `requiredReasoningMode`; they retain their own provider/model/source/context/output/variants metadata.
- Probation uses `offerEvery: 5` and `opportunityCursor` from policy. Only cursor slots divisible by five may return `policyTargetID` for the candidate, and no candidate is offered while another candidate lease for the role is active.
- Routing integrates this after profile/tier/fallback lane expansion and before `chooseTarget()`; unrelated target ordering and selection inputs remain unchanged.

- [ ] **Step 1: Write failing identity, hold, and generation-membership tests**

```js
test("disabled policy is identity and governed roles hold unnamed models", () => {
  assert.deepEqual(resolvePolicyLane({ ...ARGS, enabled: false }).targetIDs, ARGS.targetIDs);
  const held = resolvePolicyLane({ ...ARGS, enabled: true });
  assert.deepEqual(held.targetIDs, [INCUMBENT_TARGET_ID]);
  assert.equal(held.reason, "model-policy-active");
});

test("new clients may see the candidate while old clients receive the incumbent", () => {
  const current = resolvePolicyLane({ ...ARGS, enabled: true, registration: registrationWith(CANDIDATE_MODEL_KEY) });
  assert.equal(current.policyTargetID, CANDIDATE_TARGET_ID);
  const old = resolvePolicyLane({ ...ARGS, enabled: true, registration: registrationWith(INCUMBENT_MODEL_KEY) });
  assert.deepEqual(old.targetIDs, [INCUMBENT_TARGET_ID]);
  assert.equal(old.blockedGeneration, true);
});
```

- [ ] **Step 2: Write failing effort, required-mode, and one-lease tests**

```js
test("candidate metadata stays fresh while routing intent is inherited and effort is clamped", () => {
  const lane = resolvePolicyLane({ ...ARGS, enabled: true, registration: CURRENT_REGISTRATION });
  const candidate = lane.targets[CANDIDATE_TARGET_ID];
  assert.deepEqual(candidate.tiers, ["smart"]);
  assert.deepEqual(candidate.fit, { smart: 1.25 });
  assert.equal(candidate.context, 400_000);
  assert.deepEqual(candidate.variants, ["low", "medium"]);
  assert.equal(candidate.effortCeiling, "medium");
});

test("missing required mode blocks candidate and an active candidate lease blocks another", () => {
  const requiringHigh = structuredClone(ARGS.modelPolicy);
  requiringHigh.roles[ROLE].routingIntent.requiredReasoningMode = "high";
  assert.deepEqual(ARGS.targets[CANDIDATE_TARGET_ID].variants, ["low", "medium"]);
  assert.equal(resolvePolicyLane({ ...ARGS, modelPolicy: requiringHigh }).policyTargetID, null);
  assert.equal(resolvePolicyLane({ ...ARGS, activeLeases: [candidateLease()] }).policyTargetID, null);
});
```

- [ ] **Step 3: Run focused tests and verify the red state**

```bash
node --experimental-test-module-mocks --test tests/policy-targets.test.mjs tests/routing.test.mjs --test-name-pattern="policy|candidate|governed"
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/policy-targets.js` and current routing admits all expanded targets.

- [ ] **Step 4: Implement the pure policy-lane resolver**

Map target IDs to role keys by provider plus role matcher. For each governed role, remove every target not named active/probation. Require candidate exact key in `registration.modelKeys`, required capabilities and mode, and available candidate lease slot. Clamp the effective effort to the highest advertised mode at or below the role ceiling; preferred ceiling absence clamps, required mode absence blocks. Return derived target objects in a `targets` field only for changed candidates; never mutate `targets` or policy.

- [ ] **Step 5: Integrate between expansion and `chooseTarget()`**

At the existing `targetIDsFor()`/fallback expansion call site, pass expanded IDs and Task 5 registration into `resolvePolicyLane()`, merge any derived candidate target into the per-request target map, and pass the resulting IDs to existing eligibility and `chooseTarget()` code. If `policyTargetID` is set, narrow that one opportunity to the candidate; otherwise incumbent selection still uses existing weights, quota, context, health, circuit, and privacy checks. Record `blocked-generation` on that lease decision only.

- [ ] **Step 6: Run focused and unrelated-routing regressions**

```bash
node --experimental-test-module-mocks --test tests/policy-targets.test.mjs tests/routing.test.mjs tests/broker.test.mjs
node --experimental-test-module-mocks --test tests/ladder.test.mjs tests/profile-fallback.test.mjs tests/internal-lanes.test.mjs tests/model-slots.test.mjs tests/provider-health.test.mjs tests/budgets.test.mjs
```

Expected: PASS with zero failures; old clients stay on incumbent, one probation lease is possible only on bounded cursor slots, and balancing/privacy/profile behavior is unchanged.

- [ ] **Step 7: Prove red/green and commit**

```bash
git add tests/policy-targets.test.mjs tests/routing.test.mjs tests/broker.test.mjs
git stash push -u --keep-index -m "red-green policy target lanes"
node --experimental-test-module-mocks --test tests/policy-targets.test.mjs --test-name-pattern="disabled policy|new clients|missing required mode"
git stash pop
node --experimental-test-module-mocks --test tests/policy-targets.test.mjs tests/routing.test.mjs tests/broker.test.mjs
git add lib/policy-targets.js lib/routing.js bin/opencode-broker tests/policy-targets.test.mjs tests/routing.test.mjs tests/broker.test.mjs
git commit -m "feat: apply model policy to routing lanes"
```

### Task 7: Authenticated fresh-process exact-target probes

**Files:**
- Create: `lib/model-probe.js`
- Create: `bin/opencode-broker-probe-client`
- Create: `tests/model-probe.test.mjs`
- Modify: `bin/opencode-broker`
- Modify: `tests/broker.test.mjs`
- Modify: `gateway/lib/gateway.js`
- Modify: `gateway/tests/gateway.test.mjs`
- Modify: `docs/API.md`

**Interfaces:**
- Defines: `GenerationAck = { generation, manifestHash, effectiveHash }`.
- Produces: `createProbeClientFactory({ spawnProbeProcess, generationManager, brokerSocketPath, gatewayURL, gatewayHeaders, now })`; `await factory.open({ transitionID, roleKey, candidateIdentity, candidateIntroduction, generationAck, ordinaryModel, probeLaunchNonce })` returns only `{ probe(request), close() }`.
- Produces: `runModelCompatibilityProbes({ probeClient, rolePolicy, ordinaryModel, candidateIntroduction, probeKinds?, onResult?, now })`. The runner owns probe semantics only; it never receives a token, transport, factory, or close responsibility.
- Adds control-socket-only `POST /model-policy/probe-launch` with exact request `{ transitionID, operationID, expectedPolicyRevision, roleKey, candidateIdentity, candidateIntroduction }` and response `{ probeLaunchNonce, expiresAt }`.
- The helper may add `probeLaunchNonce` to ordinary `{ generation, manifestHash }` `/resolver-process/register`. Successful redemption returns `{ resolverToken, scope: "probeFresh", generation, manifestHash, expiresAt }` bound to the exact transition, role, candidate identity, and introduction. The token never leaves the child.
- The child calls authenticated `POST /model-policy/probe` with `{ transitionID, roleKey, candidateIdentity, candidateIntroduction, probeKind, requestID }`; the broker returns `{ sessionID, probeNonce, expiresAt }`.

- [ ] **Step 1: Write facade-only runner tests**

```js
import { runModelCompatibilityProbes } from "../lib/model-probe.js";

test("runner executes canonical or missing subsets and awaits each result callback", async () => {
  const calls = [];
  let callbackFinished = true;
  const probeClient = { probe: async (request) => {
    assert.equal(callbackFinished, true);
    calls.push(request);
    return semanticResponseFor(request.kind);
  }};
  const persisted = [];
  const results = await runModelCompatibilityProbes({
    probeClient, rolePolicy: ROLE_POLICY, ordinaryModel: "smart",
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    probeKinds: ["tool", "reasoning"], now: () => NOW,
    onResult: async (result) => {
      callbackFinished = false;
      await Promise.resolve();
      persisted.push(result.kind);
      callbackFinished = true;
    },
  });
  assert.deepEqual(calls.map((x) => x.kind), ["tool", "reasoning"]);
  assert.deepEqual(persisted, ["tool", "reasoning"]);
  assert.deepEqual(results.map((x) => x.kind), ["tool", "reasoning"]);
});

test("runner aborts after callback rejection and validates tool semantics", async () => {
  let probes = 0;
  const probeClient = { probe: async () => {
    probes += 1;
    return { status: 200, body: { content: [{ type: "text", text: "no tool call" }] } };
  }};
  const [tool] = await runModelCompatibilityProbes({
    probeClient, rolePolicy: ROLE_POLICY, ordinaryModel: "smart",
    candidateIntroduction: CANDIDATE_INTRODUCTION, probeKinds: ["tool"], now: () => NOW,
  });
  assert.equal(tool.success, false);
  assert.equal(tool.failureClass, "invalid-model-tool-call-response");
  await assert.rejects(runModelCompatibilityProbes({
    probeClient, rolePolicy: ROLE_POLICY, ordinaryModel: "smart",
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    onResult: async () => { throw new Error("persist failed"); }, now: () => NOW,
  }), /persist failed/);
  assert.equal(probes, 2, "one tool probe plus one aborted normal probe");
});
```

The test file also asserts the default order `normal`, `tool`, `reasoning`; exact ordinary model and candidate introduction in every semantic request; stable request IDs; and that neither the runner arguments nor returned results contain a resolver token, gateway credential, launch nonce, or child-process handle.

- [ ] **Step 2: Write direct broker launch, registration, and assignment tests**

Define one `VALID_LAUNCH_REQUEST` containing all six request fields. Table-test apply disabled, wrong operation ID, unacknowledged operation history, stale policy revision, non-probing/routable policy, and every role/identity/introduction mismatch. Every rejection must assert HTTP 409 with a stable code, byte-identical policy, and zero launch nonce, resolver token, assignment, or lease.

```js
test("one launch nonce authorizes exactly one fresh probe registration", async () => {
  const broker = await createBrokerHarness({ applyEnabled: true, policy: PROBING_POLICY });
  const launch = await broker.postControl("/model-policy/probe-launch", VALID_LAUNCH_REQUEST);
  assert.match(launch.probeLaunchNonce, /^pln_/);
  const registration = {
    generation: GENERATION_ACK.generation,
    manifestHash: GENERATION_ACK.manifestHash,
    probeLaunchNonce: launch.probeLaunchNonce,
  };
  const settled = await Promise.allSettled([
    broker.register(registration), broker.register(registration),
  ]);
  assert.equal(settled.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(settled.filter((x) => x.status === "rejected").length, 1);
  assert.equal(settled.find((x) => x.status === "fulfilled").value.scope, "probeFresh");
  assert.deepEqual(broker.counts(), { assignments: 0, leases: 0 });
});

test("ordinary and prior-process tokens cannot create probe assignments", async () => {
  const broker = await createBrokerHarness({ applyEnabled: true, policy: PROBING_POLICY });
  const ordinary = await broker.register({
    generation: GENERATION_ACK.generation,
    manifestHash: GENERATION_ACK.manifestHash,
  });
  const response = await broker.postAuthenticated(
    "/model-policy/probe", ordinary.resolverToken, VALID_PROBE_REQUEST,
  );
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "probe-process-required");
  assert.deepEqual(broker.counts(), { assignments: 0, leases: 0 });
});
```

Direct tests also prove a launch nonce is a random 256-bit `pln_` value while only its SHA-256 digest is retained; state changes atomically from `issued` to `redeemed`; expiry is exactly 60 seconds; broker restart invalidates unredeemed nonces; replay, concurrent redemption, wrong generation/manifest, and wrong launch binding fail before token issuance; and the successful probe token is exact-bound. `operationID` must equal `${transitionID}:staged-probing`. The authorization boundary is the same-UID mode-0600 control socket, apply gate, exact staged non-routable policy, revision, and acknowledged operation history.

- [ ] **Step 3: Write real helper/factory and protocol tests**

`startRealProbeFixture()` creates an actual immutable generation root, local fake Unix broker, local authenticated HTTP gateway, parent-network trap, and a factory whose production spawn adapter launches `bin/opencode-broker-probe-client`. The fixture supplies deterministic randomness only to the fake broker; production IDs remain cryptographically random.

```js
test("real fresh child owns registration, broker probe, and ordinary gateway request", async () => {
  const fixture = await startRealProbeFixture({ generationAck: GENERATION_ACK });
  const launch = await fixture.issueLaunch(VALID_LAUNCH_REQUEST);
  const client = await fixture.factory.open({
    transitionID: TRANSITION_ID, roleKey: ROLE, candidateIdentity: CANDIDATE_IDENTITY,
    candidateIntroduction: CANDIDATE_INTRODUCTION, generationAck: GENERATION_ACK,
    ordinaryModel: "smart", probeLaunchNonce: launch.probeLaunchNonce,
  });
  try {
    const results = await runModelCompatibilityProbes({
      probeClient: client, rolePolicy: ROLE_POLICY, ordinaryModel: "smart",
      candidateIntroduction: CANDIDATE_INTRODUCTION, now: () => NOW,
    });
    assert.equal(results.every((x) => x.success), true);
  } finally {
    await client.close();
  }
  assert.deepEqual(fixture.parentNetworkCalls, []);
  assert.equal(fixture.brokerCalls.every((x) => x.pid === fixture.childPID), true);
  assert.equal(fixture.gatewayCalls.every((x) => x.pid === fixture.childPID), true);
  assert.equal(fixture.gatewayCalls.every((x) => x.model === "smart"), true);
  assert.equal(fixture.gatewayCalls.every((x) => x.authorization === fixture.gatewayAuthorization), true);
  assert.equal(fixture.registeredGeneration, GENERATION_ACK.generation);
  assert.equal(fixture.childReaped(), true);
});
```

The factory accepts no caller-supplied directory. It derives `generationManager.generation(generationAck.generation)`, resolves it under the mode-0700 generation root, and parent and child independently reject path escape, an alternate/copied directory, symlinked manifest or config, registry/ack/manifest generation mismatch, SHA-256 mismatch of exact manifest bytes, canonical-JSON effective config hash mismatch, and absent exact candidate model key before registration. Table-driven fixture tests mutate each condition separately and assert zero registration/network calls.

Protocol tests feed fragmented frames, multiple frames per chunk, unknown versions/types, malformed JSON, and 65,537-byte frames through the real parser. The protocol is versioned NDJSON with a 64 KiB maximum per frame and requestID correlation. The parent sends one bootstrap frame over stdin/IPC, never argv, containing broker socket, gateway URL/headers, transition/role/candidate/introduction, `GenerationAck`, ordinary model, and launch nonce. The child retains its resolver token, emits bounded `ready` without token, and stdout contains protocol frames only. Stderr is redacted and truncated to 16 KiB. Sentinel gateway auth, token, and nonces must be absent from argv, stdout, stderr, logs, ledger, and policy.

Table-test spawn error, malformed/oversized/EOF/10-second readiness handshake, child crash, request timeout, and parent stdin EOF. Handshake failure always terminates and reaps. `close()` is async and idempotent: request shutdown, wait two seconds, SIGTERM, wait two seconds, SIGKILL, then await reaping. Tests use an injected clock/process adapter to assert each escalation and close-error propagation without sleeping.

- [ ] **Step 4: Write gateway ownership and terminal-release tests**

The child uses the broker-returned cryptographically random `gw-probe-*` session ID and purpose-separated random `pbn_` nonce. The gateway accepts the marker only from authenticated loopback, verifies the supplied session instead of replacing it, consumes before `/lease`, and uses the exact preferred model without exposing a new gateway model name.

```js
for (const scenario of ["success", "lease-failure", "downstream-failure", "timeout"]) {
  test(`gateway owns and releases a consumed probe after ${scenario}`, async () => {
    const fixture = createGatewayProbeFixture({ scenario });
    await fixture.request({
      model: "smart", sessionID: fixture.assignment.sessionID,
      headers: { "x-opencode-probe-nonce": fixture.assignment.probeNonce },
    }).catch(() => {});
    assert.deepEqual(fixture.calls.slice(0, 2), ["probe:consume", "lease"]);
    assert.deepEqual(fixture.states, ["issued", "consumed-gateway-owned", "released"]);
    assert.equal(fixture.releaseCalls, 1);
  });
}
```

Additional tests cover session mismatch, missing/ordinary auth, LAN origin, uncertain dispatch, duplicate release, and hard expiry/reaping. A pre-consumption child cancellation changes only `issued -> released`; it is idempotent and becomes a no-op after ownership transfers. On uncertain timeout the child attempts release, but only the gateway or reaper may release `consumed-gateway-owned`. Requests without the probe header remain byte-equivalent to the existing path, and `/v1/models` never advertises the candidate.

- [ ] **Step 5: Run the focused tests and verify the red state**

```bash
node --experimental-test-module-mocks --test tests/model-probe.test.mjs tests/broker.test.mjs gateway/tests/gateway.test.mjs --test-name-pattern="probe|fresh child|NDJSON|release"
```

Expected: FAIL because the module, helper, launch/assignment APIs, protocol, and gateway ownership path do not exist.

- [ ] **Step 6: Implement the ownership boundaries and lifecycle**

The broker owns the in-memory purpose-separated launch and assignment maps. `/model-policy/probe` accepts only an exact-bound `probeFresh` token, creates the session and nonce, and tracks `issued`, `consumed-gateway-owned`, and `released` with hard expiry/reaping. The child owns registration, token retention, broker and gateway transports, and pre-consumption cancellation. The gateway owns release after consumption on success, lease failure, downstream failure, and timeout. The runner owns only semantic request/result validation. Task 9's applier—not the runner—owns `close()` in `finally`; Task 9 also combines a primary and close failure as `AggregateError`. Gateway release completes before the child facade returns a result.

- [ ] **Step 7: Run probe, broker, and gateway regressions**

```bash
node --experimental-test-module-mocks --test tests/model-probe.test.mjs tests/broker.test.mjs gateway/tests/gateway.test.mjs gateway/tests/tenant.test.mjs
```

Expected: PASS with zero failures for fresh-process proof, exact generation and launch binding, token secrecy, protocol bounds, replay/expiry/restart, random session verification, ownership transfer, all terminal releases, and ordinary-request compatibility.

- [ ] **Step 8: Prove red/green, stage every Task 7 path, and commit**

```bash
git add tests/model-probe.test.mjs tests/broker.test.mjs gateway/tests/gateway.test.mjs
git stash push -u --keep-index -m "red-green fresh process probes" -- lib/model-probe.js bin/opencode-broker-probe-client bin/opencode-broker gateway/lib/gateway.js docs/API.md
if node --experimental-test-module-mocks --test tests/model-probe.test.mjs tests/broker.test.mjs gateway/tests/gateway.test.mjs --test-name-pattern="probe|fresh child|NDJSON|release"; then
  echo "expected fresh-process probe tests to fail without implementation" >&2
  exit 1
fi
git stash pop
node --experimental-test-module-mocks --test tests/model-probe.test.mjs tests/broker.test.mjs gateway/tests/gateway.test.mjs gateway/tests/tenant.test.mjs
git add lib/model-probe.js bin/opencode-broker-probe-client tests/model-probe.test.mjs bin/opencode-broker tests/broker.test.mjs gateway/lib/gateway.js gateway/tests/gateway.test.mjs docs/API.md
git commit -m "feat: add authenticated fresh-process probes"
```

Expected: the guarded red command fails, the green suite passes, and all eight listed Task 7 paths are staged. No helper token, launch nonce, gateway credential, or candidate model name is persisted or exposed.

### Task 8: Model probation, opportunity accounting, and rollback

**Files:**
- Create: `lib/model-probation.js`
- Create: `tests/model-probation.test.mjs`
- Modify: `bin/opencode-broker`
- Modify: `lib/model-lease.js`
- Modify: `lib/model-policy.js`
- Modify: `tests/broker.test.mjs`
- Modify: `docs/API.md`
- Modify: `docs/STATE.md`

**Interfaces:**
- Produces from `lib/model-lease.js`: `PROBATION_SUCCESS_THRESHOLD = 5`, `QUALIFYING_FAILURE_THRESHOLD = 2`, `QUALIFYING_FAILURE_WINDOW_MS = 15 * 60_000`, `OPPORTUNITY_WINDOW_MS = 10 * 60_000`, and `OPPORTUNITY_TIMEOUT_MS = 7 * 24 * 60 * 60_000`.
- Produces: `classifyModelPolicyFailure(failure): { classification, qualifying }`.
- Produces: `recordCandidateLease(policy, { roleKey, leaseID, sessionID, now, synthetic? }): { policy, event }`.
- Produces: `settleCandidateOutcome(policy, { roleKey, leaseID, sessionID, outcome, failureClass?, source, now }): { policy, event }`.
- Produces: `accrueOpportunityTime(policy, { roleKey, now, compatibleActiveRegistration, eligibleCandidateRequest }): { policy, accruedMs, timedOut }`; it returns a cloned policy and never mutates its input.
- Qualifying classes are exactly `model-not-found`, `unsupported-model-parameter`, `invalid-model-tool-call-response`, and `model-entitlement-failure`.
- Excluded classes are exactly `network-failure`, `rate-limit`, `provider-overload`, `user-cancellation`, `client-disconnect`, and `tool-execution-failure`; unknown is recorded but non-qualifying.
- Success requires five distinct production lease IDs. Rollback requires two qualifying failures in a rolling 15 minutes during probation or after activation. The 15-minute value is only the qualifying-failure window; it is not a settlement deadline. Opportunity timeout is seven cumulative eligible opportunity-days beginning at the first eligible candidate production lease.
- Candidate runtime persists `opportunityEligibleUntil` and an accrual cursor. A compatible eligible request opens or extends a window to at most `now + 600_000`; accrual adds only overlap with an already-open window. Old-client/incompatible traffic closes the window, and silence can add at most the unaccrued remainder of the bounded window rather than the whole gap.

- [ ] **Step 1: Write failing taxonomy, deduplication, and threshold tests**

```js
test("five distinct production successes promote and complete plus usage counts once", () => {
  let policy = probationPolicy();
  for (let index = 0; index < 5; index += 1) {
    ({ policy } = recordCandidateLease(policy, { roleKey: ROLE, leaseID: `lease-${index}`, sessionID: `ses-${index}`, now: NOW + index }));
    ({ policy } = settleCandidateOutcome(policy, {
      roleKey: ROLE, leaseID: `lease-${index}`, sessionID: `ses-${index}`,
      outcome: "success", source: "complete", now: NOW + index,
    }));
    ({ policy } = settleCandidateOutcome(policy, {
      roleKey: ROLE, leaseID: `lease-${index}`, sessionID: `ses-${index}`,
      outcome: "success", source: "usage", now: NOW + index,
    }));
  }
  assert.equal(policy.roles[ROLE].activeModelID, "gpt-6-sol");
  assert.equal(policy.roles[ROLE].probation.successes.length, 5);
});

test("an exactly bound delayed settlement remains valid until normal lease retention expires", () => {
  let policy = probationPolicy();
  ({ policy } = recordCandidateLease(policy, {
    roleKey: ROLE, leaseID: "delayed", sessionID: "ses-delayed", now: NOW,
  }));
  ({ policy } = settleCandidateOutcome(policy, {
    roleKey: ROLE, leaseID: "delayed", sessionID: "ses-delayed",
    outcome: "success", source: "usage", now: NOW + 24 * 60 * 60_000,
  }));
  assert.deepEqual(policy.roles[ROLE].probation.successes, ["delayed"]);
});
```

- [ ] **Step 2: Write the named pause, abandonment, exclusion, and post-active rollback test**

```js
test("probation pauses without compatible opportunity and post-active failures roll back", () => {
  let policy = activeCandidatePolicy();
  ({ policy } = accrueOpportunityTime(policy, {
    roleKey: ROLE, now: NOW + 86_400_000, compatibleActiveRegistration: false, eligibleCandidateRequest: true,
  }));
  assert.equal(policy.roles[ROLE].probation.opportunityMs, 0, "old-only traffic pauses the clock");

  ({ policy } = settleCandidateOutcome(policy, {
    roleKey: ROLE, leaseID: "abandoned", sessionID: "ses-a", outcome: "abandoned", source: "expiry", now: NOW,
  }));
  ({ policy } = settleCandidateOutcome(policy, {
    roleKey: ROLE, leaseID: "network", sessionID: "ses-b", outcome: "failure",
    failureClass: "network-failure", source: "failure", now: NOW,
  }));
  assert.equal(policy.roles[ROLE].probation.failures.length, 0);

  for (const [leaseID, offset] of [["bad-1", 0], ["bad-2", 14 * 60_000]]) {
    ({ policy } = recordCandidateLease(policy, {
      roleKey: ROLE, leaseID, sessionID: `ses-${leaseID}`, now: NOW + offset,
    }));
    ({ policy } = settleCandidateOutcome(policy, {
      roleKey: ROLE, leaseID, sessionID: `ses-${leaseID}`, outcome: "failure",
      failureClass: "model-not-found", source: "failure", now: NOW + offset,
    }));
  }
  assert.equal(policy.roles[ROLE].activeModelID, "gpt-5.6-sol");
  assert.equal(policy.roles[ROLE].rollbackReason, "model-failure-threshold");
});

test("eligible windows are bounded while old-only and silent periods pause", () => {
  let policy = probationPolicy();
  let result = accrueOpportunityTime(policy, {
    roleKey: ROLE, now: NOW, compatibleActiveRegistration: true, eligibleCandidateRequest: false,
  });
  policy = result.policy;
  assert.equal(result.accruedMs, 0);
  assert.equal(policy.roles[ROLE].probation.opportunityEligibleUntil, null);
  ({ policy } = recordCandidateLease(policy, {
    roleKey: ROLE, leaseID: "first", sessionID: "ses-first", now: NOW,
  }));
  result = accrueOpportunityTime(policy, {
    roleKey: ROLE, now: NOW, compatibleActiveRegistration: true, eligibleCandidateRequest: true,
  });
  policy = result.policy;
  assert.equal(result.accruedMs, 0, "the first request opens a future window");
  assert.equal(policy.roles[ROLE].probation.opportunityEligibleUntil, NOW + 600_000);
  result = accrueOpportunityTime(policy, {
    roleKey: ROLE, now: NOW + 86_400_000,
    compatibleActiveRegistration: false, eligibleCandidateRequest: true,
  });
  policy = result.policy;
  assert.equal(result.accruedMs, 600_000, "silence adds only the prior bounded window");
  assert.equal(policy.roles[ROLE].probation.opportunityMs, 600_000);
  assert.equal(policy.roles[ROLE].probation.opportunityEligibleUntil, null, "old-only request closes the window");
  assert.throws(() => settleCandidateOutcome(policy, {
    roleKey: ROLE, leaseID: "forged", sessionID: "ses-forged", outcome: "success", source: "complete", now: NOW,
  }), /unknown lease/);
});

test("timeout requires seven cumulative eligible opportunity-days", () => {
  let policy = probationPolicy();
  ({ policy } = recordCandidateLease(policy, {
    roleKey: ROLE, leaseID: "first", sessionID: "ses-first", now: NOW,
  }));
  let result = accrueOpportunityTime(policy, {
    roleKey: ROLE, now: NOW, compatibleActiveRegistration: true, eligibleCandidateRequest: true,
  });
  policy = result.policy;
  for (let window = 1; window <= 7 * 24 * 6; window += 1) {
    result = accrueOpportunityTime(policy, {
      roleKey: ROLE, now: NOW + window * 600_000,
      compatibleActiveRegistration: true, eligibleCandidateRequest: true,
    });
    policy = result.policy;
  }
  assert.equal(result.timedOut, true);
  assert.equal(policy.roles[ROLE].rollbackReason, "probation-timeout");
});
```

- [ ] **Step 3: Run focused tests and verify the red state**

```bash
node --experimental-test-module-mocks --test tests/model-probation.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/model-probation.js`.

- [ ] **Step 4: Implement closed classification and lease/outcome idempotency**

Store bounded distinct outcomes keyed by `leaseID` and verify matching `sessionID`. Synthetic `gw-probe-*` leases never count. `/complete` and validated `/usage` settle one success once; duplicate or contradictory settlement is recorded as replay and changes no counter. Abandoned/expired leases clear active candidate occupancy and count neither success nor failure. Retain exact lease/session settlement binding and idempotency until normal lease expiry/state retention; do not introduce an independent settlement cutoff. Expire only qualifying failure records at `now - 15 * 60_000` before checking the two-failure rolling threshold.

- [ ] **Step 5: Implement opportunity time, promotion, and both rollback modes**

The first compatible eligible candidate production request after the first candidate lease opens `opportunityEligibleUntil = now + 600_000` and records the accrual cursor without adding elapsed time. Each later call first accrues only `[cursor, min(now, opportunityEligibleUntil)]`. A compatible eligible request then opens/extends a window no later than `now + 600_000`; an incompatible/old-only request closes it. Long silence therefore adds at most the remainder of the last open window. Persist this bounded state across restart. At exactly `7 * 24 * 60 * 60_000` cumulative milliseconds, restore `rollbackModelID` or explicit `activeModelID: null` with `probation-timeout`. On five successes, clear probation but retain rollback target and the same 2-in-15-minute failure watch. Any rollback persists through broker `writeState()` before a response is sent.

- [ ] **Step 6: Wire broker lease and settlement endpoints**

On a candidate lease, call `recordCandidateLease()` before persisting the lease. On `/complete`, validated `/usage`, `/failure`, normal expiry, and `/forget`, call `settleCandidateOutcome()` with a unique lease ID already present in broker state. Call `accrueOpportunityTime()` only from an eligible candidate-capable production request. Never write the reconciliation ledger from these paths.

- [ ] **Step 7: Run probation and broker regressions**

```bash
node --experimental-test-module-mocks --test tests/model-probation.test.mjs tests/model-policy.test.mjs tests/broker.test.mjs tests/policy-targets.test.mjs tests/refusal-codes.test.mjs
```

Expected: PASS with zero failures for first eligible window, cumulative seven-day accounting, old-client/no-traffic pause, bounded-window restart, delayed valid settlement, rolling failure expiry, five-success promotion, deduplication, abandoned neutrality, non-model exclusion, new-role null rollback, and post-active rollback.

- [ ] **Step 8: Prove red/green, document, and commit**

```bash
git add tests/model-probation.test.mjs tests/broker.test.mjs
git stash push -u --keep-index -m "red-green model probation"
node --experimental-test-module-mocks --test tests/model-probation.test.mjs
git stash pop
node --experimental-test-module-mocks --test tests/model-probation.test.mjs tests/model-policy.test.mjs tests/broker.test.mjs tests/policy-targets.test.mjs
git add lib/model-probation.js lib/model-lease.js lib/model-policy.js bin/opencode-broker tests/model-probation.test.mjs tests/broker.test.mjs docs/API.md docs/STATE.md
git commit -m "feat: enforce model probation and rollback"
```

### Task 9: Apply saga, recovery, and dormant CLI

**Files:**
- Create: `lib/reconcile-apply.js`
- Create: `tests/reconcile-apply.test.mjs`
- Modify: `lib/model-reconcile.js`
- Modify: `bin/opencode-broker-reconcile`
- Modify: `tests/reconcile-cli.test.mjs`
- Modify: `docs/API.md`
- Modify: `docs/STATE.md`

**Interfaces:**
- Produces: `createReconciliationApplier({ store, overlayStore, generationManager, brokerRequest, probeClientFactory, collectSources, now })`.
- Applier methods: `apply({ transitionID, dryRun? })`, `rollback({ transitionID, reason, dryRun? })`, `refresh({ dryRun? })`, and `recover({ transitionID?, dryRun? })`.
- Ledger runtime fields are presentation/saga acknowledgements only: `{ applyIntent, overlayAck, generationAck, policyPending, brokerAck, probeResults, probeAck, probationPending, probationAck, probeRollbackAck }`; runtime counters, launch nonces, resolver tokens, and assignments remain broker-owned or process-local.
- Apply order is exact: ledger intent -> overlay -> immutable generation -> ledger generation ack -> policy-pending ledger intent -> broker CAS to non-routable `staged-probing` -> ledger broker ack -> missing probe lifecycle -> aggregate probe ack -> probation-pending intent -> broker CAS to routable `probation` -> ledger probation ack. The probe lifecycle is launch authorization -> open fresh child from the exact generation ack -> run missing kinds with awaited per-result persistence -> close in `finally`. A failed probe instead performs broker rollback before its terminal result/rollback acknowledgement and never enters probation.
- CLI adds `apply <transitionID> [--json] [--dry-run]`, `rollback <transitionID> --reason TEXT [--json] [--dry-run]`, `refresh [--json] [--dry-run]`, and `recover [transitionID] [--json] [--dry-run]`.
- Disabled commands exit 1 with `{ ok: false, code: "reconcile-apply-disabled", mutated: false }`; malformed usage exits 2. Existing `dry-run` remains observational and may mutate only the Package 1/2 ledger fields already allowed.

- [ ] **Step 1: Write failing saga-order and crash-boundary tests**

```js
test("apply records each durable boundary in order without holding the ledger lock across calls", async () => {
  const events = [];
  const applier = createReconciliationApplier(injectedApplierDeps(events));
  const result = await applier.apply({ transitionID: TRANSITION_ID });
  assert.equal(result.ok, true);
  assert.deepEqual(events, [
    "ledger:intent", "overlay:write", "generation:build", "generation:publish",
    "ledger:generation-ack", "ledger:policy-pending", "broker:cas", "ledger:broker-ack",
    "broker:probe-launch", "probe:open", "probe:normal", "ledger:probe-normal",
    "probe:tool", "ledger:probe-tool", "probe:reasoning", "ledger:probe-reasoning",
    "probe:close", "ledger:probe-ack", "ledger:probation-pending",
    "broker:probation-cas", "ledger:probation-ack",
  ]);
  assert.equal(events.some((event) => event.startsWith("external:") && ledgerLockHeld()), false);
});

test("recovery resumes every acknowledged saga boundary and stale CAS blocks", async () => {
  for (const boundary of SAGA_BOUNDARIES) {
    const deps = injectedApplierDeps([], { crashAfter: boundary });
    await assert.rejects(createReconciliationApplier(deps).apply({ transitionID: TRANSITION_ID }), /injected crash/);
    const recovered = await createReconciliationApplier(deps.afterRestart()).recover({ transitionID: TRANSITION_ID });
    assert.equal(recovered.ok, true, boundary);
    assert.equal(deps.counts.overlayWrites <= 1, true, boundary);
    assert.equal(deps.counts.brokerChanges <= 1, true, boundary);
  }
  const stale = injectedApplierDeps([], { brokerError: { code: "stale-model-policy" } });
  await assert.rejects(createReconciliationApplier(stale).apply({ transitionID: TRANSITION_ID }), /stale-model-policy/);
  assert.equal(stale.counts.ledgerBrokerAcks, 0);
});

test("applier opens the exact acknowledged generation and always closes it", async () => {
  const deps = injectedApplierDeps([]);
  await createReconciliationApplier(deps).apply({ transitionID: TRANSITION_ID });
  assert.deepEqual(deps.openCalls, [{
    transitionID: TRANSITION_ID, roleKey: ROLE,
    candidateIdentity: CANDIDATE_IDENTITY,
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    generationAck: GENERATION_ACK, ordinaryModel: "smart",
    probeLaunchNonce: deps.launchResponse.probeLaunchNonce,
  }]);
  assert.equal(deps.closeCalls, 1);
});

test("complete persisted probe results skip launch and child creation", async () => {
  const deps = injectedApplierDeps([], { probeResults: COMPLETE_PROBE_RESULTS });
  await createReconciliationApplier(deps).recover({ transitionID: TRANSITION_ID });
  assert.equal(deps.counts.probeLaunches, 0);
  assert.equal(deps.openCalls.length, 0);
  assert.equal(deps.counts.probeRuns, 0);
  assert.equal(deps.counts.probeAcks, 1);
  assert.equal(deps.counts.probationChanges, 1);
});

test("failed probe rolls policy back before recording the terminal failure", async () => {
  const events = [];
  const deps = injectedApplierDeps(events, { probeFailure: "tool" });
  await assert.rejects(createReconciliationApplier(deps).apply({ transitionID: TRANSITION_ID }),
    /probe.*tool/i);
  assert.equal(events.indexOf("broker:probe-rollback") < events.indexOf("ledger:probe-tool"), true);
  assert.equal(events.includes("broker:probation-cas"), false);
  assert.equal(deps.policy().activeModelID, INCUMBENT_MODEL_ID);
});

for (const failureAt of ["probe", "dispatch", "callback", "close"]) {
  test(`probe lifecycle closes each opened child when ${failureAt} fails`, async () => {
    const deps = injectedApplierDeps([], { failureAt });
    await assert.rejects(
      createReconciliationApplier(deps).recover({ transitionID: TRANSITION_ID }),
      failureAt === "close" ? /close/ : /probe|dispatch|callback/,
    );
    assert.equal(deps.openCalls.length, 1);
    assert.equal(deps.closeCalls, deps.openCalls.length);
  });
}
```

Separate launch/open-failure cases assert zero close calls because no facade was returned. If both the primary probe/callback path and `close()` fail, the assertion requires an `AggregateError` whose ordered `errors` retain both causes. Each recovery attempt requests a new launch nonce and opens a new child; neither nonce nor token is persisted.

- [ ] **Step 2: Write failing default-off and dry-run byte/mtime tests**

```js
test("disabled CLI exits nonzero with structured output and no mutation", () => {
  const before = snapshotProhibitedPaths();
  for (const argv of [
    ["apply", TRANSITION_ID, "--json"],
    ["rollback", TRANSITION_ID, "--reason", "operator-request", "--json"],
    ["refresh", "--json"], ["recover", TRANSITION_ID, "--json"],
  ]) {
    const result = run(argv);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false, code: "reconcile-apply-disabled", mutated: false,
    });
  }
  for (const endpoint of [
    "/model-policy/cas", "/model-policy/rollback",
    "/model-policy/probe-launch", "/model-policy/probe",
    "/probe/consume", "/probe/release", "/resolver-process/register",
  ]) {
    const response = postControl(endpoint, {});
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "reconcile-apply-disabled");
  }
  assert.deepEqual(snapshotProhibitedPaths(), before);
  assert.equal(publisherCalls, 0);
  assert.deepEqual({ resolverRegistrations, probeLaunches, probeAssignments, leases, externalCalls }, {
    resolverRegistrations: 0, probeLaunches: 0, probeAssignments: 0, leases: 0, externalCalls: 0,
  });
});

test("dry-run preserves bytes and mtimes and makes zero broker or publisher calls", async () => {
  const before = snapshotBytesAndMtimes(PROHIBITED_PATHS);
  await applier.apply({ transitionID: TRANSITION_ID, dryRun: true });
  assert.deepEqual(snapshotBytesAndMtimes(PROHIBITED_PATHS), before);
  assert.equal(brokerCalls, 0);
  assert.equal(resolverRuns, 0);
  assert.equal(publisherCalls, 0);
});
```

- [ ] **Step 3: Run focused tests and verify the red state**

```bash
node --experimental-test-module-mocks --test tests/reconcile-apply.test.mjs tests/reconcile-cli.test.mjs --test-name-pattern="saga|recovery|disabled CLI|dry-run"
```

Expected: FAIL because `lib/reconcile-apply.js` and apply/rollback/refresh/recover commands do not exist.

- [ ] **Step 4: Implement intent reservation and deterministic overlay/generation phases**

Inside a short `store.update()`, validate the transition is `auto-eligible` or `approved`, sources/auth revision are fresh, and persist `reservedGeneration = generationManager.readRegistry().highWater + 1`, `overlayUpdatedAt = now()`, and a canonical intent revision. Release the ledger lock. Build and atomically write the deterministic overlay with that introduction generation and persisted timestamp, then call `generationManager.build({ reservedGeneration, ... })` and publish the immutable generation. Recovery reuses `overlayUpdatedAt`; it never samples a new timestamp for the same intent. Use a second `store.update()` to acknowledge only if transition/revision/overlay hash/generation/manifest still match. The manager verifies the reservation against registry high-water under its own lock; a concurrent publisher makes the reservation stale and blocks recovery for a fresh operator-visible retry, never silent renumbering.

- [ ] **Step 5: Implement policy-pending, broker CAS, probing, acknowledgement, rollback, and recovery**

Persist `policyPending` in a separate short ledger update. Call broker CAS with transition/revision, expected incumbent, generation+manifest hash, and desired explicit non-routable probing policy. On success, persist the exact broker ack in another update. If any canonical probe kind is absent, call `/model-policy/probe-launch` with the exact operation/revision/role/candidate fields, then `await probeClientFactory.open()` with the complete arguments named in the interface. Invoke `runModelCompatibilityProbes()` once for only the missing kinds. Its awaited callback writes each passing result by transition+kind CAS; a matching existing result is an idempotent replay and a conflicting result fails. For a failed result, first broker-CAS the staged policy back to its recorded incumbent or explicit null, then persist the terminal result and exact rollback acknowledgement; never expose the candidate to probation. Read after a write error: matching persisted bytes mean commit-before-ack succeeded, absence means recovery reruns that external probe with a fresh child/nonce, and conflict blocks. Gateway release completes before the callback receives a result. External synthetic execution is therefore at-least-once across that crash window, while durable per-kind recording is exactly-once. Always `await client.close()` in `finally` and aggregate primary+close failures.

After all three durable results pass, persist aggregate `probeAck`, then a separate `probationPending` intent. Broker-CAS the exact same candidate/generation from non-routable `staged-probing` to routable `probation`, initializing Task 8 counters and rollback target, and persist the exact `probationAck`. The apply operation is not successful until this acknowledgement is durable.

`recover()` inspects durable acknowledgements and current generation/broker status to resume the first missing phase. A complete passing `probeResults` set performs zero launch/open/run calls, validates/persists the aggregate acknowledgement, and resumes probation CAS/ack if missing. After either staged-probing, probe rollback, or probation broker commit-before-ledger-ack, query `/model-policy/status` and record only the exact matching ack without replaying a changed CAS. Any hash, revision, incumbent, result, or ack mismatch stores a blocked reason through `store.update()` and performs no later mutation. `rollback()` uses broker CAS first; the next ledger update records its observed ack.

- [ ] **Step 6: Keep both binaries on the sole ledger writer and add thin CLI commands**

`opencode-broker-reconcile` constructs the stores/managers/applier, parses argv, calls one method, prints bounded JSON/human output, and sets exit status. It never writes ledger bytes itself. Confirm `opencode-broker-evidence` still claims/fails/ingests only through `createReconciliationStore().update()`. Every disabled command returns before source collection or any other external call. Enabled `refresh()` and enabled dry-run may call injected `collectSources()` before their later mutation checks; auth revision change, stale/empty source, overlay corruption, resolver failure, or exact-key absence blocks without policy CAS.

- [ ] **Step 7: Run saga, CLI, and dry-run regressions**

```bash
node --experimental-test-module-mocks --test tests/reconcile-apply.test.mjs tests/reconcile-cli.test.mjs tests/model-reconcile.test.mjs tests/reconcile-state.test.mjs tests/reconcile-overlay.test.mjs tests/resolver-generations.test.mjs tests/model-policy.test.mjs
```

Expected: PASS with zero failures for every crash window, stale CAS, idempotent replay, fresh-child launch/open/run/close order, no-launch complete recovery, at-least-once external/exactly-once durable probe results, all cleanup failures, complete default-off endpoint matrix, auth/source gate, generated-config failure, dry-run byte/mtime identity, zero external calls, and no lock held across process/API work.

- [ ] **Step 8: Prove red/green, document, and commit**

```bash
git add tests/reconcile-apply.test.mjs tests/reconcile-cli.test.mjs
git stash push -u --keep-index -m "red-green reconciliation apply saga"
node --experimental-test-module-mocks --test tests/reconcile-apply.test.mjs tests/reconcile-cli.test.mjs --test-name-pattern="saga|recovery|disabled CLI|dry-run"
git stash pop
node --experimental-test-module-mocks --test tests/reconcile-apply.test.mjs tests/reconcile-cli.test.mjs tests/model-reconcile.test.mjs tests/reconcile-state.test.mjs
git add lib/reconcile-apply.js lib/model-reconcile.js bin/opencode-broker-reconcile tests/reconcile-apply.test.mjs tests/reconcile-cli.test.mjs docs/API.md docs/STATE.md
git commit -m "feat: reconcile runtime model transitions"
```

### Task 10: Integration, documentation, verification, and 1.24.0 release

**Files:**
- Create: `tests/helpers/model-reconcile-runtime.mjs`
- Create: `tests/model-reconcile-runtime.test.mjs`
- Modify: `README.md`
- Modify: `docs/API.md`
- Modify: `docs/STATE.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

**Interfaces:**
- Produces one temporary-root end-to-end fixture spanning ledger, overlay, generation registry, broker policy, process registration, the real probe helper child, local fake broker/gateway services, probation, promotion, post-active rollback, trusted Anthropic admission, and old-client incumbent behavior.
- Documents that all Package 3 machinery is dormant/default-off and Package 4 alone enables live mutation/publication/scheduling.
- Releases exactly `1.24.0` from exact baseline `1.23.0`; any other starting version blocks this task and requires plan revision. Do not create or stage `package-lock.json`.

- [ ] **Step 1: Verify release baseline and clean execution preconditions**

```bash
git --no-pager status --short
node -e 'const p=require("./package.json"); if (p.version!=="1.23.0") { console.error({package:p.version}); process.exit(1) }'
test ! -e package-lock.json
```

Expected: status prints nothing, the version check exits 0, and no lockfile exists. Any other baseline stops the task for plan revision; never generate a lockfile to satisfy metadata tooling.

- [ ] **Step 2: Write the failing dormant end-to-end runtime test**

```js
test("GPT6 overlay promotes after five successes and rolls back after two post-active failures", async () => {
  const runtime = await createModelReconcileRuntime({
    applyEnabled: true, baseModels: ["openai/gpt-5.6-sol"], realProbeHelper: true,
  });
  await runtime.discover(TRUSTED_OPENAI_GPT6);
  await runtime.applier.apply({ transitionID: runtime.transitionID("openai:gpt-sol") });
  assert.equal(runtime.overlay().entries["openai/gpt-6-sol"].model.cost.input, 0);
  assert.equal(runtime.currentManifest().modelKeys.includes("openai/gpt-6-sol"), true);
  assert.deepEqual(runtime.probeTrace(), [
    "probe-launch", "child-register", "child-model-policy-probe", "child-gateway",
    "child-model-policy-probe", "child-gateway", "child-model-policy-probe", "child-gateway",
  ]);
  assert.equal(runtime.probeGeneration(), runtime.currentGeneration());
  assert.equal(runtime.parentProbeNetworkCalls(), 0);
  assert.equal(runtime.probeChildReaped(), true);

  const oldClient = runtime.registerGeneration(0);
  const newClient = runtime.registerCurrentGeneration();
  assert.equal((await runtime.lease({ client: oldClient, tier: "smart" })).modelID, "gpt-5.6-sol");
  const forbidden = await runtime.postProbeWithToken(newClient.resolverToken, VALID_PROBE_REQUEST);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, "probe-process-required");
  for (let index = 0; index < 5; index += 1) await runtime.successfulCandidateLease(newClient, `lease-${index}`);
  assert.equal(runtime.policy(ROLE).activeModelID, "gpt-6-sol");

  await runtime.failCandidate("post-1", "model-not-found");
  await runtime.failCandidate("post-2", "unsupported-model-parameter");
  assert.equal(runtime.policy(ROLE).activeModelID, "gpt-5.6-sol");
  assert.equal((await runtime.lease({ client: oldClient, tier: "smart" })).modelID, "gpt-5.6-sol");
});

test("trusted Anthropic api is admitted while default-off runtime mutates nothing", async () => {
  assert.equal((await createModelReconcileRuntime({ applyEnabled: true }).discover(TRUSTED_ANTHROPIC_55)).source,
    "subscription-trusted");
  const dormant = await createModelReconcileRuntime({ applyEnabled: false });
  for (const operation of [
    () => dormant.runCLI(["apply", TRANSITION_ID, "--json"]),
    () => dormant.runCLI(["rollback", TRANSITION_ID, "--reason", "operator-request", "--json"]),
    () => dormant.runCLI(["refresh", "--json"]),
    () => dormant.runCLI(["recover", TRANSITION_ID, "--json"]),
    () => dormant.postControl("/model-policy/cas", {}),
    () => dormant.postControl("/model-policy/rollback", {}),
    () => dormant.postControl("/model-policy/probe-launch", {}),
    () => dormant.postControl("/model-policy/probe", {}),
    () => dormant.postControl("/probe/consume", {}),
    () => dormant.postControl("/probe/release", {}),
    () => dormant.postControl("/resolver-process/register", {}),
  ]) {
    const before = dormant.snapshotBytesAndMtimes();
    const result = await operation();
    assert.equal(result.code, "reconcile-apply-disabled");
    assert.deepEqual(dormant.snapshotBytesAndMtimes(), before);
  }
  assert.deepEqual(dormant.effectCounts(), {
    launchNonces: 0, assignments: 0, leases: 0,
    safeRegistrations: 0, resolverRuns: 0, brokerMutations: 0, externalCalls: 0,
  });
});
```

- [ ] **Step 3: Run the integration test and verify the red state**

```bash
node --experimental-test-module-mocks --test tests/model-reconcile-runtime.test.mjs
```

Expected: FAIL until the test fixture connects all Package 3 interfaces and the full transition reaches rollback.

- [ ] **Step 4: Complete only the injected integration fixture and close interface gaps**

Build `tests/helpers/model-reconcile-runtime.mjs` from real Package 3 modules with temporary roots, an actual mode-0600 Unix broker socket, a local HTTP gateway, and the production `createProbeClientFactory` spawn adapter. Do not add alternate production code paths and do not invoke parent-side probe transports. The required path is `/model-policy/probe-launch` -> real `bin/opencode-broker-probe-client` -> child `/resolver-process/register` redemption -> child `/model-policy/probe` -> child ordinary authenticated gateway request -> gateway consume/lease/release -> child exit/reap. Exercise GPT-6 absent -> overlay -> exact candidate generation -> three probes -> five distinct production successes -> active -> two qualifying post-active failures -> rollback, plus trusted Anthropic admission, ordinary-token `probe-process-required`, and an old generation-0 client that always receives the incumbent.

- [ ] **Step 5: Update product documentation without implying activation**

README must describe trusted subscription attestation, immutable resolver generations, process registration, policy holds, probe/probation/rollback, the default-off apply commands, and the Package 4 activation boundary. `docs/API.md` must list every new method, request/response field, loopback requirement, 409 disabled response, and probe header. `docs/STATE.md` must identify authority, owner, version, mode, atomicity, retention, and corruption behavior for every state in the writers table below.

- [ ] **Step 6: Run focused Package 3 tests**

```bash
node --experimental-test-module-mocks --test tests/model-roles.test.mjs tests/reconcile-overlay.test.mjs tests/resolver-generations.test.mjs tests/model-policy.test.mjs tests/resolver-processes.test.mjs tests/policy-targets.test.mjs tests/model-probe.test.mjs tests/model-probation.test.mjs tests/reconcile-apply.test.mjs tests/model-reconcile-runtime.test.mjs tests/reconcile-cli.test.mjs tests/broker.test.mjs tests/routing.test.mjs gateway/tests/gateway.test.mjs
```

Expected: exit 0 with exactly zero failures; do not assert a fixed test count.

- [ ] **Step 7: Run the exact product and gateway regression commands**

```bash
node --test tests/*.mjs
node --test gateway/tests/*.mjs
npm test
```

Expected: each command exits 0 with exactly zero failures; do not hide, filter, or exclude a failing test and do not assert a fixed count.

- [ ] **Step 8: Inspect secret/debug findings and resolve every match**

```bash
rg -n '(api[_-]?key|authorization:|bearer |token\s*[:=]\s*["'"'][^"'"']+|console\.log|debugger|\.only\(|\.skip\(|FIXME|XXX)' lib plugin gateway bin tests README.md docs examples CHANGELOG.md
```

Expected: inspect every printed line. Credential-shaped text is allowed only as a redacted fixture/assertion proving rejection; remove debug statements and silent test exclusions. Re-run the focused test command after any correction.

- [ ] **Step 9: Bump only 1.23.0 to 1.24.0 and write the dated dormant changelog**

Set only the root version in `package.json` to `1.24.0`; do not create `package-lock.json`. Add this release heading and meaning above the preserved `1.23.0` entry:

```markdown
## [1.24.0] — 2026-09-30

### Added

- **Dormant model-promotion runtime.** Trusted subscription models can be represented in authorized
  zero-cost resolver overlays and immutable resolver generations, while the broker can bind clients
  to exact generation manifests, stage compare-and-swap model policy, probe candidates through the
  loopback gateway, require production probation, and roll back qualifying failures. All apply,
  publication, mutation, and scheduling controls remain default-OFF; Package 4 alone activates them
  after deployment cutover gates.
```

```bash
test ! -e package-lock.json
node -e 'const fs=require("fs"); const p=require("./package.json"); const changelog=fs.readFileSync("./CHANGELOG.md","utf8"); const heading=/^## \[([^\]]+)\] — (\d{4}-\d{2}-\d{2})/m.exec(changelog); if (p.version!=="1.24.0"||!heading||heading[1]!=="1.24.0"||heading[2]!=="2026-09-30"||!changelog.includes("## [1.23.0]")) process.exit(1)'
npm test
```

Expected: no lockfile exists, `package.json` and the first changelog heading agree exactly on `1.24.0` dated `2026-09-30`, the prior `1.23.0` entry remains, and the suite exits 0 with zero failures.

- [ ] **Step 10: Use the required verification and review skills**

Load `verification-before-completion`, rerun the focused command, both exact `node --test` commands, and `npm test` from fresh shell invocations, and record each exit status and zero-failure result. Then load `requesting-code-review` and dispatch an independent reviewer over the full Package 3 commit range, explicitly asking it to verify the five Review Focus tests, dormant defaults, state-writer boundaries, plugin one-export rule, gateway loopback boundary, and no Package 4 activation. Address every verified finding and repeat verification.

- [ ] **Step 11: Prove integration red/green and commit the release**

```bash
test -f tests/helpers/model-reconcile-runtime.mjs
test -f tests/model-reconcile-runtime.test.mjs
python3 - <<'PY'
from pathlib import Path
path = Path("lib/model-lease.js")
text = path.read_text()
seam = "export const PROBATION_SUCCESS_THRESHOLD = 5;"
assert text.count(seam) == 1
path.write_text(text.replace(seam, "export const PROBATION_SUCCESS_THRESHOLD = 6;"))
PY
if node --experimental-test-module-mocks --test tests/model-reconcile-runtime.test.mjs; then
  echo "expected threshold mutation to fail integration test" >&2
  exit 1
fi
git stash push -m "red proof promotion threshold" -- lib/model-lease.js
node --experimental-test-module-mocks --test tests/model-reconcile-runtime.test.mjs
git stash drop
test -z "$(git status --porcelain -- lib/model-lease.js)"
git add tests/helpers/model-reconcile-runtime.mjs tests/model-reconcile-runtime.test.mjs README.md docs/API.md docs/STATE.md CHANGELOG.md package.json
git commit -m "release: ship dormant model promotion runtime"
```

Expected: changing the sole threshold seam from five to six makes the integration test fail; stashing only that mutation restores the green test; dropping the stash restores and then removes the temporary mutation so `lib/model-lease.js` is clean before staging. The commit stages only the seven listed release paths. Do not push, deploy, enable apply, or start Package 4.

## Requirement-to-task coverage

| Spec domain | Owning task(s) | Concrete proof |
|---|---:|---|
| Trusted subscription authentication, active model enumeration, quarantine | 1, 10 | Trusted API versus untrusted API test; Anthropic integration case |
| Provider-role registry, routing intent, effort ceiling, required reasoning mode | 1, 6 | Strict role normalization; effort clamp and required-mode block |
| Authorized append-only zero-cost resolver overlay | 2 | Overlay schema/stability/rejection/private atomic store tests |
| Immutable resolver generations, exact resolver set, generation 0 | 3 | Scratch XDG resolver, canonical hashes, atomic symlink, gen0 tests |
| Registry high-water, crash recovery, retention, base-reference safety | 3 | Regression/loss, publication crash, cleanup, protected-removal tests |
| Broker-owned modelPolicy and v4 -> v5 migration | 4 | Normalization, migration, status, single-write CAS tests |
| Default-off apply configuration and loopback policy API | 4, 9, 10 | Complete CLI/control matrix including disabled `/resolver-process/register`, `/cas`, `/rollback`, `/probe-launch`, `/probe`, `/probe/consume`, `/probe/release`, with byte/mtime identity and zero effects |
| Process registration, token lifetime, legacy/forged/cleaned fallback | 5 | Exact-manifest authorization and restart invalidation tests |
| Plugin startup identity and one-export contract | 5 | Resolve-once/token wrapping and plugin export tests |
| Governed-role holds, active/probation replacement, old/new clients | 6 | Policy lane hold and generation-membership tests |
| Preserve weights, quotas, context, health, profiles, privacy | 6, 10 | Existing routing regression suites and end-to-end old-client case |
| Fresh-process exact-target probes through ordinary gateway model | 7, 9, 10 | Launch authorization, real helper, exact generation, child-owned transport, replay/expiry/binding/LAN/no-advertisement/release tests |
| Closed failure taxonomy and idempotent production outcomes | 8 | Taxonomy, duplicate complete/usage, abandoned/transient tests |
| Five-success promotion, 2-in-15 rollback, post-active rollback | 8, 10 | Unit thresholds and full promotion/rollback integration |
| Seven cumulative eligible days and old-only pause | 8 | Compatible-registration interval and timeout tests |
| Cross-store saga, probe result CAS, acknowledgements, recovery | 9 | Every-boundary crash injection, stale CAS, no-launch complete recovery, and at-least-once external/exactly-once durable probe result tests |
| Sole ledger writer shared by reconcile/evidence binaries | 9 | CLI implementation boundary and existing evidence regression |
| Dry-run mutation matrix | 9, 10 | Bytes, mtimes, zero broker/resolver/publisher calls |
| Documentation, dormant release, Package 4 activation boundary | 10 | README/API/STATE/changelog review and version gate |

## State writers

| State | Authoritative writer | Mutation API / atomic boundary | Readers |
|---|---|---|---|
| `model-reconciliation.json` ledger | `opencode-broker-reconcile` and `opencode-broker-evidence`, both through the same store | Only `createReconciliationStore().update(mutator)` under its exclusive lock and atomic rename | Reconciler status/projectors/applier |
| `resolver-overlay.json` | Reconciler applier | Synchronous `createResolverOverlayStore().write(overlay, { expectedPreviousHash, expectedRevision })`; private temp file, fsync, rename, parent fsync | Generation manager, status |
| `resolver-generations.json` registry | Resolver generation manager | Manager registry lock plus private temp file, fsync, rename, parent fsync | Manager, broker process registry |
| Immutable generation directories (`opencode.json`, `manifest.json`) | Resolver generation manager | New private temp directory, both private files fsynced, directory fsynced, immutable directory rename | OpenCode process/plugin, process registry, cleanup |
| `current` generation symlink | Resolver generation manager | Sibling temporary symlink atomically renamed over `current`, then parent fsync | Plugin startup, recovery/status |
| `broker.json.modelPolicy` | Broker daemon only | `compareAndSwapModelPolicy()` result persisted by existing broker `writeState()` atomic replacement | Routing, status, reconciler recovery |
| In-memory process registrations | Broker daemon only | `createResolverProcessRegistry()` methods; deliberately lost on restart | Lease authorization, status, cleanup retention input |
| In-memory probe-launch authorizations | Broker daemon only | Digest-only `pln_` records; atomic issue/redeem/expire; deliberately lost on restart | Probe registration control path |
| In-memory probe assignments | Broker daemon only | Random `gw-probe-*` plus digest-bound `pbn_`; `issued -> consumed-gateway-owned -> released` with hard expiry/reaper | Fresh helper and loopback gateway |

## API additions

| Method and path | Caller | Purpose | Disabled/unsafe behavior |
|---|---|---|---|
| `POST /model-policy/cas` | Reconciler over broker Unix socket | Compare-and-swap explicit provider-role policy | 409 with `reconcile-apply-disabled`; stale/incumbent mismatch writes nothing |
| `GET /model-policy/status` | Reconciler/operator status | Read normalized policy, history, apply status | Read-only; malformed persisted state fails loudly |
| `POST /resolver-process/register` | Plugin factory or fresh helper at process startup | Bind generation+manifest to an opaque token; helper may atomically redeem `probeLaunchNonce` | 409 when apply disabled; missing/invalid token authorization uses static-target base-only eligibility without requiring a generation bundle; invalid identity or launch binding cannot mint `probeFresh` |
| `POST /model-policy/probe-launch` | Reconciler over mode-0600 control socket | Authorize one fresh helper registration for the exact staged transition | 409 when apply disabled; exact operation/revision/policy binding; 60-second single-use restart-volatile nonce |
| `POST /model-policy/probe` | Fresh helper with exact-bound `probeFresh` token | Create staged exact-target one-shot assignment and nonce | Ordinary/prior token returns `probe-process-required`; loopback/apply/staged-policy required |
| `POST /probe/consume` | Loopback gateway | Atomically consume exact-bound nonce before lease | Replay, expiry, LAN, and binding mismatch rejected |
| `POST /probe/release` | Fresh helper before consumption; loopback gateway after consumption | Release the caller-owned probe assignment on cancellation/completion/failure/timeout | Idempotent; helper no-op after transfer; cannot release another session |
| Gateway header `x-opencode-probe-nonce` | Loopback probe client | Select the broker-created one-shot assignment while using an ordinary model label | Rejected from LAN/external clients; never advertised as a model |

## Self-review checklist results

- **Spec coverage: PASS.** Every Package 3 decomposition item and every testing domain in the approved spec maps to Tasks 1-10 in the coverage table; Package 4 activation/deployment remains explicitly excluded.
- **Placeholder scan: PASS.** The plan contains no deferred-work markers, “similar to” shortcuts, unspecified validation requests, or unnamed implementation steps; every task names files, interfaces, red/green commands, regressions, and an exact commit.
- **Type/signature consistency: PASS.** Overlay generation identity flows from ledger reservation to overlay entry to generation manifest to broker CAS; `GenerationAck` and launch binding flow into a canonical fresh child; the helper alone retains its `probeFresh` token and supplies the exact random gateway session; probation mutates only broker-owned policy; the applier alone coordinates acknowledgements and child closure.
- **Review Focus 1: PASS.** Task 1 names and implements the trusted/untrusted API test.
- **Review Focus 2: PASS.** Task 3 names and implements config/manifest crash and protected base-removal tests.
- **Review Focus 3: PASS.** Task 5 names and implements missing/invalid/forged/cleaned/restart registration fallback.
- **Review Focus 4: PASS.** Task 9 names and implements every saga crash boundary, stale CAS blocking, fresh child lifecycle, commit-before-ack probe recovery, and no-launch complete recovery.
- **Review Focus 5: PASS.** Task 8 names and implements old-only pause, abandoned/non-model neutrality, and post-active rollback.
- **Baseline precondition: PASS.** Planning-time verification established exact `1.23.0`; Task 10 permits only `1.23.0 -> 1.24.0` dated `2026-09-30` and forbids creating or staging `package-lock.json`.

## Execution recommendation

Use subagent-driven `plan-run` because these tightly coupled routing, broker, plugin, gateway, and state changes can affect every OpenCode session. Assign one `sp-implementer` and one independent `reviewer` per task, preserve the task order, then run a full-branch review after Task 10; escalate only a blocked implementation or twice-failed review according to the fleet rules. **No implementation begins until Holden reviews and explicitly approves this rebuilt plan.**
