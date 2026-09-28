# Provider Model Reconciliation Package 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provider-role registry and a stateful dry-run reconciler that safely identifies model-upgrade candidates without publishing inventory, changing routing, contacting Gitea/ntfy, or running a research agent.

**Architecture:** A new `model-roles` module becomes the single source for provider role/family mappings while preserving the existing `FAMILY_TIERS` export and routing behavior. A pure candidate normalizer and pure cached-inventory builder feed a dry-run engine whose source refreshes use scratch cache paths; only its versioned, mkdir-locked reconciliation ledger may be written. A separate CLI exposes `dry-run` and `status`, leaving evidence collection, approvals, runtime holds, probing, probation, and deployment cutover to Packages 2–4.

**Tech Stack:** Node.js 20.18+ ESM, `node:test`, built-in `fs`/`child_process`/`crypto`, JSON state with atomic rename, existing OpenCode model catalog and resolver commands.

**Spec:** `/home/dev/opencode-broker/docs/superpowers/specs/2026-09-28-provider-model-reconciliation-design.md`

## Global Constraints

- Implement Package 1 only: registry, provider adapters, reconciliation ledger/lock, scratch refresh, proposed-inventory validation, stale gates, legacy-ledger preview, dry-run engine, and dry-run/status CLI.
- Package 1 must not call `/inventory` or any broker control API, create governed-role holds, alter target eligibility, send ntfy, create/update Gitea issues, run a research agent, or implement evidence/approval/probe/probation commands.
- Dry-run catalog and resolver refreshes must use a scratch `XDG_CACHE_HOME` and in-memory resolver output. They must not write the live models.dev cache or `resolvable-models.json`.
- A failed scratch refresh may read the live cache/snapshot as stale observation input, but must not modify either file.
- Preserve all existing `FAMILY_TIERS`, discovery, API-key quarantine, resolver-admission, pin suppression, speed-variant, and target-selection behavior byte-for-byte at the public interface.
- `modelRoles` overrides merge over product defaults. Invalid values are ignored with an actionable warning; no override can delete a default role by using `null`, `false`, an empty object, or an invalid replacement.
- The state root remains `~/.local/share/opencode/model-routing/` or `OPENCODE_MODEL_ROUTING_DIR`; directories are mode `0700`, state files are mode `0600`, and writes use fsync plus atomic rename.
- Every reconciliation-ledger mutation goes through one exclusive mkdir lock under the injected routing-state root. A live or unverifiable owner is never stolen.
- Catalog age is stale after 48 hours; resolver age is stale after 72 hours. Equality at exactly the threshold is fresh; only `age > threshold` is stale.
- Package 1 may persist dry-run observations in `model-reconciliation.json`; that is its only production-state mutation.
- Keep `reviewed-models.json` intact. Package 1 reads it and reports a proposed import only; deletion and one-time migration occur in Package 4.
- Use the project test command shape: `node --experimental-test-module-mocks --test ...`; run the full suite with `npm test`.
- No source, comments, tests, docs, or commit messages may contain emoji or secrets.
- Commit each task separately. Do not push, restart services, replace the timer, edit fleet deployment config, or remove model-watch in this package.
- Package 1 is a minor feature release: update `package.json`, `package-lock.json`, and `CHANGELOG.md` from 1.19.1 to 1.20.0 only in the final task after all implementation tests pass.

## Review Focus

- Malformed or deletion-shaped `modelRoles` overrides must preserve every safe default and must not create an empty routing map; Task 1 pins this.
- A catalog family and model-ID pattern that point at different roles must become `blocked-conflict`, never whichever match ran first; Tasks 1, 2, and 5 pin this.
- Failed scratch refreshes and exact 48h/72h boundaries must leave live cache/snapshot bytes and mtimes unchanged while reporting the correct stale status; Task 4 pins this.
- Concurrent dry-runs must serialize without lost updates, and a live lock owner must never be reclaimed merely because a timeout elapsed; Task 3 pins this.
- Re-running an unchanged dry-run must retain the same transition ID and `stateChangedAt`, and must preserve terminal/decision fields already in the ledger; Task 5 pins this.

---

### Task 1: Make provider roles the single source of discovery policy

**Files:**
- Create: `lib/model-roles.js`
- Modify: `lib/config.js:377-439,623-648`
- Modify: `lib/routing.js:965-987,1087-1118,1322-1326`
- Create: `tests/model-roles.test.mjs`
- Extend: `tests/routing.test.mjs:657-725,816-898`

**Interfaces:**
- Produces: `DEFAULT_MODEL_ROLES: Readonly<Record<string, ModelRole>>`
- Produces: `normalizeModelRoles(overrides, { warn? } = {}): Readonly<Record<string, ModelRole>>`
- Produces: `familyTiersFromRoles(roles): Readonly<Record<string, { tiers: readonly string[], fit: Readonly<Record<string, number>> }>>`
- Produces: `matchModelRole(providerID, model, roles): RoleMatch`
- Produces: `CONFIG.modelRoles: Readonly<Record<string, ModelRole>>`
- Preserves: `FAMILY_TIERS` as a derived export with its current exact keys and values
- Consumes later: Tasks 2, 4, and 5 use `CONFIG.modelRoles` and `matchModelRole()`

- [ ] **Step 1: Write failing registry and compatibility tests**

Create `tests/model-roles.test.mjs` with these core cases:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL_ROLES,
  familyTiersFromRoles,
  matchModelRole,
  normalizeModelRoles,
} from "../lib/model-roles.js";

const EXPECTED_FAMILIES = {
  "anthropic:claude-opus": { tiers: ["build", "smart"], fit: { build: 1.5 } },
  "anthropic:claude-sonnet": { tiers: ["build", "review"], fit: { review: 1.4 } },
  "anthropic:claude-fable": { tiers: ["deep"], fit: { deep: 1.5 } },
  "anthropic:claude-haiku": { tiers: ["worker", "classifier"], fit: {} },
  "openai:gpt-astra": { tiers: ["deep"], fit: {} },
  "openai:gpt-sol": { tiers: ["smart"], fit: {} },
  "openai:gpt-terra": { tiers: ["build"], fit: {} },
  "openai:gpt-luna": { tiers: ["worker"], fit: {} },
};

test("default roles derive the existing family-tier policy exactly", () => {
  assert.deepEqual(familyTiersFromRoles(DEFAULT_MODEL_ROLES), EXPECTED_FAMILIES);
});

test("deletion-shaped and invalid overrides cannot remove safe defaults", () => {
  const warnings = [];
  for (const value of [null, false, {}, { tiers: [] }, { families: [] }]) {
    const roles = normalizeModelRoles({ "anthropic:claude-opus": value }, {
      warn: (line) => warnings.push(line),
    });
    assert.deepEqual(roles["anthropic:claude-opus"].tiers, ["build", "smart"]);
    assert.deepEqual(roles["anthropic:claude-opus"].families, ["claude-opus"]);
  }
  assert.ok(warnings.length >= 4);
});

test("a valid subscription-provider role can be added without replacing defaults", () => {
  const roles = normalizeModelRoles({
    "example:prime": {
      families: ["example-prime"],
      idPatterns: [{ prefix: "example-", suffix: "-prime" }],
      tiers: ["smart"],
      fit: { smart: 1.2 },
      rank: 3,
      requiredCapabilities: { toolCall: true },
      evidenceDomains: ["models.example.com"],
    },
  });
  assert.ok(roles["anthropic:claude-opus"]);
  assert.equal(roles["example:prime"].providerID, "example");
  assert.equal(roles["example:prime"].roleID, "prime");
  assert.deepEqual(familyTiersFromRoles(roles)["example:example-prime"], {
    tiers: ["smart"], fit: { smart: 1.2 },
  });
});

test("a colliding override is ignored and the default family owner wins", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "anthropic:premium": {
      families: ["claude-opus"], idPatterns: [{ prefix: "premium-", suffix: "" }],
      tiers: ["deep"], rank: 9, requiredCapabilities: { toolCall: true },
      evidenceDomains: ["anthropic.com"],
    },
  }, { warn: (line) => warnings.push(line) });
  assert.equal(roles["anthropic:premium"], undefined);
  assert.ok(roles["anthropic:claude-opus"]);
  assert.match(warnings.join("\n"), /claude-opus.*already belongs to anthropic:claude-opus/);
});

test("a same-key override changes policy without removing safe matchers", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "anthropic:claude-opus": { tiers: ["smart"], fit: { smart: 1.25 } },
  }, { warn: (line) => warnings.push(line) });
  assert.deepEqual(roles["anthropic:claude-opus"].tiers, ["smart"]);
  assert.deepEqual(roles["anthropic:claude-opus"].fit, { smart: 1.25 });
  assert.deepEqual(roles["anthropic:claude-opus"].families, ["claude-opus"]);
  assert.deepEqual(roles["anthropic:claude-opus"].idPatterns,
    [{ prefix: "claude-opus-", suffix: "" }]);
  assert.deepEqual(warnings, []);
});

test("family and id-pattern disagreement is an explicit conflict", () => {
  const roles = normalizeModelRoles({
    "example:alpha": {
      families: ["example-alpha"], idPatterns: [{ prefix: "example-", suffix: "-alpha" }],
      tiers: ["smart"], rank: 2, requiredCapabilities: { toolCall: true },
      evidenceDomains: ["example.com"],
    },
    "example:beta": {
      families: ["example-beta"], idPatterns: [{ prefix: "example-", suffix: "-beta" }],
      tiers: ["worker"], rank: 1, requiredCapabilities: { toolCall: true },
      evidenceDomains: ["example.com"],
    },
  });
  const match = matchModelRole("example", { id: "example-2-beta", family: "example-alpha" }, roles);
  assert.equal(match.status, "conflict");
  assert.deepEqual(match.roleKeys, ["example:alpha", "example:beta"]);
});
```

Extend `tests/routing.test.mjs` to assert `R.FAMILY_TIERS` still deep-equals `EXPECTED_FAMILIES`, the existing mapped OpenAI/Anthropic discovery cases still produce the same tiers, and an invalid config override does not alter them.

- [ ] **Step 2: Run the tests and verify the new module is absent**

Run:

```bash
node --experimental-test-module-mocks --test tests/model-roles.test.mjs tests/routing.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/model-roles.js`.

- [ ] **Step 3: Implement the default role table and strict normalization**

Create `lib/model-roles.js` with no imports from `config.js` or `routing.js`. Use this complete default data:

```js
const DEFAULT_DEFINITIONS = {
  "anthropic:claude-opus": {
    families: ["claude-opus"], idPatterns: [{ prefix: "claude-opus-", suffix: "" }],
    tiers: ["build", "smart"], fit: { build: 1.5 }, rank: 3,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["anthropic.com", "platform.claude.com"],
  },
  "anthropic:claude-sonnet": {
    families: ["claude-sonnet"], idPatterns: [{ prefix: "claude-sonnet-", suffix: "" }],
    tiers: ["build", "review"], fit: { review: 1.4 }, rank: 2,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["anthropic.com", "platform.claude.com"],
  },
  "anthropic:claude-fable": {
    families: ["claude-fable"], idPatterns: [{ prefix: "claude-fable-", suffix: "" }],
    tiers: ["deep"], fit: { deep: 1.5 }, rank: 4,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["anthropic.com", "platform.claude.com"],
  },
  "anthropic:claude-haiku": {
    families: ["claude-haiku"], idPatterns: [{ prefix: "claude-haiku-", suffix: "" }],
    tiers: ["worker", "classifier"], fit: {}, rank: 1,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["anthropic.com", "platform.claude.com"],
  },
  "openai:gpt-astra": {
    families: ["gpt-astra"], idPatterns: [{ prefix: "gpt-", suffix: "-astra" }],
    tiers: ["deep"], fit: {}, rank: 4,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["openai.com", "developers.openai.com"],
  },
  "openai:gpt-sol": {
    families: ["gpt-sol"], idPatterns: [{ prefix: "gpt-", suffix: "-sol" }],
    tiers: ["smart"], fit: {}, rank: 3,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["openai.com", "developers.openai.com"],
  },
  "openai:gpt-terra": {
    families: ["gpt-terra"], idPatterns: [{ prefix: "gpt-", suffix: "-terra" }],
    tiers: ["build"], fit: {}, rank: 2,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["openai.com", "developers.openai.com"],
  },
  "openai:gpt-luna": {
    families: ["gpt-luna"], idPatterns: [{ prefix: "gpt-", suffix: "-luna" }],
    tiers: ["worker"], fit: {}, rank: 1,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ["openai.com", "developers.openai.com"],
  },
};
```

Implement these rules explicitly:

- parse each key as exactly `providerID:roleID`, each side matching `/^[a-z0-9][a-z0-9-]{0,99}$/`;
- accept only tier names `deep`, `smart`, `build`, `fast-build`, `review`, `worker`, `classifier`;
- accept family/domain strings of 1–200 characters with no whitespace;
- accept `idPatterns` only as `{ prefix, suffix }`, each string at most 100 characters;
- extract the text between prefix and suffix as a version only when it matches `/^\d+(?:[.-]\d+)*$/`, then normalize internal `-` separators to `.`;
- freeze nested arrays/objects;
- begin normalization from defaults and ignore an invalid override as a whole, leaving that role's default unchanged;
- for an existing role key, accept a non-empty partial override: omitted fields inherit; `tiers`,
  `fit`, `rank`, and `requiredCapabilities` replace their corresponding validated fields, while
  `families`, `idPatterns`, and `evidenceDomains` are additive unions so a host cannot erase a safe
  matcher or source allowlist;
- for a new role key, require `families`, `idPatterns`, `tiers`, `rank`, `requiredCapabilities`, and
  `evidenceDomains`; `fit` is optional and defaults to `{}`;
- key `familyTiersFromRoles()` by `${providerID}:${family}`, never by role key; one role may own
  multiple family keys and a role ID need not equal its family;
- process defaults before overrides; family ownership by the same role key is valid, but if an
  override under a different role key claims a provider/family already owned by a default or earlier
  valid role, ignore that entire override with a warning and keep the existing owner; never throw
  during config import and never drop the default;
- return `{ status: "known", roleKey, role, version }`, `{ status: "unknown", roleKeys: [] }`, or `{ status: "conflict", roleKeys }` from `matchModelRole()`.

Default `warn` to `(message) => console.error(`opencode-broker: ${message}`)`, matching existing config
diagnostics. Package 1 accepts only the fields listed above; Package 3 must extend validation before it
adds reasoning-mode or compatibility-probe fields rather than silently passing unknown keys.

- [ ] **Step 4: Wire normalized roles through config and routing**

In `lib/config.js`, import `normalizeModelRoles` and add:

```js
modelRoles: normalizeModelRoles(raw.modelRoles),
```

next to `agentTiers`. In `lib/routing.js`, import `familyTiersFromRoles` and replace the literal table with:

```js
export const FAMILY_TIERS = familyTiersFromRoles(CONFIG.modelRoles);
```

Add `modelRoles = CONFIG.modelRoles` to `discoverSubscriptionTargets()` options and derive the local family map from that argument. Use the same derived map when normalizing broker inventory. Do not change the exported target shape or matching order.

Keep `normalizeDiscoveredInventory()` on the module-level derived `FAMILY_TIERS`; do not add an options
argument in Package 1. Its behavior remains identical while the literal table disappears.

- [ ] **Step 5: Run focused and full routing tests**

Run:

```bash
node --experimental-test-module-mocks --test tests/model-roles.test.mjs tests/routing.test.mjs tests/watch.test.mjs tests/config-parse.test.mjs
```

Expected: PASS; all existing family-tier and watch behavior remains identical.

- [ ] **Step 6: Prove the new tests fail without the implementation, then restore green**

Stage only the tests, stash the unstaged production changes, and run the focused tests:

```bash
git add tests/model-roles.test.mjs tests/routing.test.mjs
git stash push -u --keep-index -m "red-green model roles"
node --experimental-test-module-mocks --test tests/model-roles.test.mjs tests/routing.test.mjs
```

Expected: FAIL because `lib/model-roles.js` and the derived routing policy are absent. Restore and
rerun:

```bash
git stash pop
git --no-pager status --short
node --experimental-test-module-mocks --test tests/model-roles.test.mjs tests/routing.test.mjs tests/watch.test.mjs tests/config-parse.test.mjs
```

Expected: status shows staged test changes plus restored, non-conflicted production changes; no `UU`,
`AA`, or `DU` entries. Tests PASS.

- [ ] **Step 7: Commit the role registry**

```bash
git add lib/model-roles.js lib/config.js lib/routing.js tests/model-roles.test.mjs tests/routing.test.mjs
git commit -m "feat: centralize provider model roles"
```

### Task 2: Normalize catalog models into provider-role candidates

**Files:**
- Create: `lib/model-candidates.js`
- Modify: `lib/routing.js:639-643,965-1005,1082-1103`
- Create: `tests/model-candidates.test.mjs`
- Extend: `tests/routing.test.mjs:657-725,863-898`

**Interfaces:**
- Consumes: `matchModelRole(providerID, model, roles)` from Task 1
- Produces: `VALID_MODEL_ID` and `isSpeedVariant(modelID)` as the
  shared catalog-ID admission primitives used by routing and reconciliation
- Produces: `normalizeCatalogModel(providerID, model, { roles, resolvableModels }): NormalizedCandidate | null`
- Produces: `normalizeCatalogCandidates(catalog, { providerIDs, roles, resolvableModels }): readonly NormalizedCandidate[]`
- Candidate fields: `providerID`, `modelID`, `family`, `roleKey`, `roleID`, `roleStatus`, `roleMatches`, `version`, `releaseDate`, `capabilities`, `context`, `output`, `variants`, `resolverKey`, `resolvable`, `active`, `validModelID`, `speedVariant`
- Consumes later: Task 5 uses normalized candidates; Task 4 supplies `providerIDs` and resolver data

- [ ] **Step 1: Write failing normalization tests**

Create tests for known, unknown, conflicting, inactive, malformed-date, and missing-capability models. Include this representative assertion:

```js
test("normalizes provider metadata without making a quality decision", () => {
  const candidate = normalizeCatalogModel("openai", {
    id: "gpt-6-sol",
    family: "gpt-sol",
    release_date: "2026-09-22",
    status: "active",
    tool_call: true,
    limit: { context: 1_050_000, output: 128_000 },
    variants: { low: {}, medium: {}, high: {} },
  }, {
    roles: DEFAULT_MODEL_ROLES,
    resolvableModels: new Set(["openai/gpt-6-sol"]),
  });
  assert.deepEqual(candidate, {
    providerID: "openai",
    modelID: "gpt-6-sol",
    family: "gpt-sol",
    roleKey: "openai:gpt-sol",
    roleID: "gpt-sol",
    roleStatus: "known",
    roleMatches: ["openai:gpt-sol"],
    version: "6",
    releaseDate: "2026-09-22",
    capabilities: { toolCall: true },
    context: 1_050_000,
    output: 128_000,
    variants: ["high", "low", "medium"],
    resolverKey: "openai/gpt-6-sol",
    resolvable: true,
    active: true,
    validModelID: true,
    speedVariant: false,
  });
});
```

Also assert that no `gpt-6-terra` candidate is synthesized when the catalog contains only Astra, Sol, and Luna.

- [ ] **Step 2: Run the test and verify the module is absent**

```bash
node --experimental-test-module-mocks --test tests/model-candidates.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic candidate normalization**

Implement `normalizeCatalogModel()` as a pure function:

- return `null` when provider/model IDs are absent;
- validate model IDs with the same `/^[A-Za-z0-9._:-]{1,180}$/` rule routing already uses;
- classify `/-fast(?:-|$)/i` as a speed variant through one shared exported helper;
- copy only validated scalar metadata;
- treat missing/invalid release dates as `null`;
- treat absent status as active, matching current discovery;
- sort and deduplicate valid variant names;
- use `matchModelRole()` for role status and version;
- expose `roleMatches: [roleKey]` for a known role and the returned conflict list otherwise;
- expose `version: null` for unknown and conflicting matches;
- mark resolver membership but do not filter unresolved or unknown candidates;
- never infer missing siblings, rank candidates, or assign a tier in this module.

`lib/model-candidates.js` may import `lib/model-roles.js` but must not import `lib/routing.js`; routing
imports the shared ID/speed helpers from candidates, so a back-import would create an ESM cycle.

Replace routing's private `MODEL_ID` and `SPEED_VARIANT` definitions with imports from this module so
discovery and dry-run cannot drift. Keep `modelAdmissionFailure()` and every existing skip reason
unchanged. Extend routing tests to prove malformed IDs and fast variants still receive their existing
behavior.

Implement `normalizeCatalogCandidates()` to process only exact provider IDs supplied through
`providerIDs`, sort by `providerID`, then `family`, then `releaseDate`, then `modelID`, and return a
frozen array.

- [ ] **Step 4: Run candidate and role tests**

```bash
node --experimental-test-module-mocks --test tests/model-candidates.test.mjs tests/model-roles.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit candidate normalization**

```bash
git add lib/model-candidates.js lib/routing.js tests/model-candidates.test.mjs tests/routing.test.mjs
git commit -m "feat: normalize provider model candidates"
```

### Task 3: Add the versioned reconciliation ledger and exclusive writer lock

**Files:**
- Create: `lib/reconcile-state.js`
- Create: `tests/reconcile-state.test.mjs`
- Create: `tests/fixtures/reconcile-state-worker.mjs`

**Interfaces:**
- Consumes: `routingStateDir()` from `lib/routing.js`
- Produces: `RECONCILIATION_STATE_VERSION = 1`
- Produces: `emptyReconciliationState(): ReconciliationState`
- Produces: `createReconciliationStore({ root?, now?, pid?, lockWaitMs? }): ReconciliationStore`
- Produces: `store.read(): ReconciliationState`
- Produces: `store.update(mutator): ReconciliationState`
- Produces: `store.paths(): { state, lock, reviewed }`
- Produces: `readReviewedModels(path): Readonly<Record<string, string>>`
- Produces: `planReviewedModelsImport(state, reviewed): { importKeys, existingKeys }`
- Consumes later: Task 5 persists candidate observations; Task 6 status reads the ledger

- [ ] **Step 1: Write failing state, permission, corruption, migration, and concurrency tests**

Cover all of these behaviors:

```js
test("state round-trips atomically with private permissions", () => {
  const store = createReconciliationStore({ root });
  const saved = store.update((state) => ({
    ...state,
    roles: { "openai:gpt-sol": { providerID: "openai", roleID: "gpt-sol", state: "evidence-pending" } },
  }));
  assert.equal(saved.version, 1);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(store.paths().state).mode & 0o777, 0o600);
  assert.equal(store.read().roles["openai:gpt-sol"].state, "evidence-pending");
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
});

test("unknown versions and corrupt JSON fail loudly without replacement", () => {
  writeFileSync(statePath, JSON.stringify({ version: 99 }) + "\n");
  assert.throws(() => store.read(), /unsupported reconciliation state version 99/);
  const before = readFileSync(statePath, "utf8");
  assert.throws(() => store.update((state) => state), /unsupported/);
  assert.equal(readFileSync(statePath, "utf8"), before);
});

test("unknown top-level fields are rejected by the state whitelist", () => {
  writeFileSync(statePath, JSON.stringify({ ...emptyReconciliationState(), surprise: true }) + "\n");
  assert.throws(() => store.read(), /unknown reconciliation state field surprise/);
});

test("legacy reviewed-model import is preview-only", () => {
  writeFileSync(reviewedPath, JSON.stringify({ "openai/gpt-5.6-sol": "2026-07-09" }) + "\n");
  const reviewed = readReviewedModels(reviewedPath);
  assert.deepEqual(planReviewedModelsImport(emptyReconciliationState(), reviewed), {
    importKeys: ["openai/gpt-5.6-sol"], existingKeys: [],
  });
  assert.equal(readFileSync(reviewedPath, "utf8").includes("gpt-5.6-sol"), true);
});
```

Use `tests/fixtures/reconcile-state-worker.mjs` to spawn two processes that each perform 100 locked
increments. Assert the final value is 200 with no lost updates. Add a second worker mode that holds
the lock longer than `lockWaitMs`; the contender must fail with a lock timeout while the owner PID is
live, not reclaim it.

Use `lockWaitMs: 30_000` for the 200-increment test. Use `lockWaitMs: 50` for the deliberate timeout
test so it finishes promptly. Store the test counter at
`state.roles["test:counter"].testCount`, under the whitelisted `roles` key; do not add an arbitrary
top-level `count` field.

- [ ] **Step 2: Run the tests and verify the module is absent**

```bash
node --experimental-test-module-mocks --test tests/reconcile-state.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the store and lock**

Use this top-level schema:

```js
export const emptyReconciliationState = () => ({
  version: 1,
  updatedAt: 0,
  roles: {},
  unknown: {},
  evidenceRequests: {},
});
```

Implement the lock under `<root>/.model-reconciliation.lock` with atomic `mkdirSync()`. Store an owner
record containing PID and acquisition time. Reclaim only when `process.kill(pid, 0)` returns `ESRCH`;
an `EPERM`/unknown owner is live for safety. Wait no more than `lockWaitMs` for a live owner, then throw
`model reconciliation lock timed out`.

Default `lockWaitMs` to 5,000 ms and poll every 5 ms, matching the session-janitor lock style. Validate
state through an explicit top-level whitelist (`version`, `updatedAt`, `roles`, `unknown`,
`evidenceRequests`); unknown top-level keys and unknown versions fail loudly rather than round-tripping.

Implement `store.update()` as:

1. acquire the lock;
2. remove only leftover `.model-reconciliation.*.tmp` files while holding it;
3. read and validate the current version, or create version 1 when absent;
4. deep-clone the state before passing it to the mutator;
5. set `updatedAt` from injected `now()`;
6. write a unique mode-0600 temp with `openSync(..., "wx", 0o600)`;
7. fsync the file, rename over the destination, and fsync the directory;
8. remove temp and lock in `finally`.

Do not silently catch malformed JSON or unknown versions. `readReviewedModels()` may treat a missing
legacy file as `{}`, but malformed JSON must throw and preserve the file.

- [ ] **Step 4: Run state and concurrency tests**

```bash
node --experimental-test-module-mocks --test tests/reconcile-state.test.mjs
```

Expected: PASS, including the two-process increment and live-owner cases.

- [ ] **Step 5: Prove the state tests fail without the implementation, then restore green**

```bash
git add tests/reconcile-state.test.mjs tests/fixtures/reconcile-state-worker.mjs
git stash push -u --keep-index -m "red-green reconciliation state"
node --experimental-test-module-mocks --test tests/reconcile-state.test.mjs
```

Expected: FAIL because `lib/reconcile-state.js` is absent. Restore and rerun:

```bash
git stash pop
git --no-pager status --short
node --experimental-test-module-mocks --test tests/reconcile-state.test.mjs
```

Expected: status contains no unmerged entries and the tests PASS.

- [ ] **Step 6: Commit reconciliation state**

```bash
git add lib/reconcile-state.js tests/reconcile-state.test.mjs tests/fixtures/reconcile-state-worker.mjs
git commit -m "feat: add reconciliation state ledger"
```

### Task 4: Collect scratch refresh data and build a non-publishing proposed inventory

**Files:**
- Modify: `lib/routing.js:1171-1261`
- Create: `lib/model-reconcile.js`
- Create: `tests/model-reconcile-sources.test.mjs`
- Extend: `tests/routing.test.mjs:646-805`

**Interfaces:**
- Produces from routing: `modelCachePath(): string`
- Produces from routing: `parseResolvableModelsOutput(output): ReadonlySet<string>`
- Produces from routing: `readResolvableModelsSnapshot(path?): { updatedAt: number | null, models: ReadonlySet<string> }`
- Produces from routing: `buildCachedSubscriptionInventory({ catalog, authTypes, staticTargets?, resolvableModels, modelRoles?, trustedProviderIDs?, configuredModelVariants? }): DiscoveryResult`
- Preserves: `publishCachedSubscriptionInventory()` behavior by making it call the pure builder before its existing request
- Produces from reconcile: `CATALOG_MAX_AGE_MS = 48 * 3600_000`
- Produces from reconcile: `RESOLVER_MAX_AGE_MS = 72 * 3600_000`
- Produces from reconcile: `assessSourceAge(updatedAt, maxAgeMs, now): { ageMs, stale }`
- Produces from reconcile: `collectDryRunSources(options): DryRunSources`
- Consumes later: Task 5 uses `collectDryRunSources()` and the pure inventory builder

- [ ] **Step 1: Write failing pure-builder and scratch-isolation tests**

Extend `tests/routing.test.mjs` with a parity test that supplies the same catalog/auth/resolver data to
`buildCachedSubscriptionInventory()` and `publishCachedSubscriptionInventory()`, injects a request
spy into the publisher, and asserts parity without making a request from the builder:

```js
const built = routing.buildCachedSubscriptionInventory(INPUTS);
const { skipped, ...publishedFields } = built;
const result = await routing.publishCachedSubscriptionInventory({
  cachePath,
  listResolvableModels: () => INPUTS.resolvableModels,
  configuredModelVariants: INPUTS.configuredModelVariants,
  request: async (path, body) => { calls.push({ path, body }); return { changed: true }; },
});
assert.deepEqual(calls[0].body, { ...publishedFields, authRevision: calls[0].body.authRevision });
assert.equal(typeof calls[0].body.authRevision, "string");
assert.deepEqual(result.skipped, skipped);
```

Pass the same explicit `configuredModelVariants` fixture to both paths. The pure builder performs the
configured-variant merge from its argument; the publisher passes `CONFIG.modelVariants`. `skipped`
remains return-only and is never included in the broker request body.

Use the existing `withTempHome()` routing-test harness to write an OAuth `auth.json`. Set
`INPUTS.staticTargets = routing.TARGETS` (or omit it and use that default) because `config.js` is cached
for this test file; do not attempt to swap config mid-file. The publisher must not read the developer's
auth. Pass `trustedProviderIDs` through the pure builder and through
`discoverSubscriptionTargets()` options so provider-admission summaries are injectable while the
existing rule remains: only OAuth models are dynamically discovered.

Create `tests/model-reconcile-sources.test.mjs` with an injected fake `exec`:

```js
test("successful dry-run refresh writes only below scratch XDG_CACHE_HOME", async () => {
  const liveCacheBefore = readFileSync(liveCachePath);
  const liveResolverBefore = readFileSync(liveResolverPath);
  const liveCacheMtime = statSync(liveCachePath).mtimeMs;
  const liveResolverMtime = statSync(liveResolverPath).mtimeMs;

  const sources = collectDryRunSources({
    liveCachePath,
    liveResolverPath,
    now: () => NOW,
    exec: (_file, args, options) => {
      if (args[0] === "models" && args.length === 1) {
        const path = join(options.env.XDG_CACHE_HOME, "opencode/models.json");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(CATALOG));
        return "";
      }
      if (args.join(" ") === "models --pure") return "openai/gpt-6-sol\n";
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });

  assert.equal(sources.catalog.refreshed, true);
  assert.equal(sources.resolver.refreshed, true);
  assert.deepEqual(readFileSync(liveCachePath), liveCacheBefore);
  assert.deepEqual(readFileSync(liveResolverPath), liveResolverBefore);
  assert.equal(statSync(liveCachePath).mtimeMs, liveCacheMtime);
  assert.equal(statSync(liveResolverPath).mtimeMs, liveResolverMtime);
});
```

Add tests for:

- refresh failure falling back to read-only live sources with captured error strings;
- empty catalog and resolver output remaining explicit;
- both scratch refresh and live fallback missing/unreadable throwing an actionable source error;
- `age === maxAgeMs` fresh and `age === maxAgeMs + 1` stale for both thresholds;
- scratch directory removal after success and failure;
- auth data never copied into the scratch directory.

- [ ] **Step 2: Run source tests and verify the new APIs are absent**

```bash
node --experimental-test-module-mocks --test tests/model-reconcile-sources.test.mjs tests/routing.test.mjs
```

Expected: FAIL because the source collector and pure builder do not exist.

- [ ] **Step 3: Refactor routing into parse/read/build primitives without changing publication**

In `lib/routing.js`:

- export the existing model-cache path through `modelCachePath()`;
- extract resolver line parsing into `parseResolvableModelsOutput()` and use it inside
  `refreshResolvableModels()`;
- add `readResolvableModelsSnapshot()` and make `readResolvableModels()` return its `.models`;
- preserve `readResolvableModels()`'s existing `>72h` warning when delegating to the snapshot reader;
- extract the catalog/auth/filter/discovery logic from `publishCachedSubscriptionInventory()` into
  `buildCachedSubscriptionInventory()`;
- add an optional `configuredModelVariants = CONFIG.modelVariants` injection to the publishing
  wrapper and pass it into the pure builder;
- keep auth revision checks and the `/inventory` request only in the publishing wrapper;
- pass `modelRoles` to `discoverSubscriptionTargets()` so the pure builder and live publisher use the
  same registry.
- pass `trustedProviderIDs` to `discoverSubscriptionTargets()` and use it instead of the module-level
  trusted-provider set inside provider admission; default it to the configured set so callers that do
  not inject it retain identical behavior.

The pure builder must return `{ targets, providers, modelContexts, modelOutputs, modelVariants,
skipped }` and must accept catalog data directly; it must not read files, shell out, or accept a broker
request callback.

- [ ] **Step 4: Implement scratch source collection**

In `lib/model-reconcile.js`, implement `collectDryRunSources()` with injected dependencies and this
order:

1. create a unique scratch root under injected `tmpRoot` or `tmpdir()`;
2. invoke `opencode models` with only `XDG_CACHE_HOME` replaced by `<scratch>/cache`;
3. read `<scratch>/cache/opencode/models.json` on success;
4. invoke `opencode models --pure` with the same environment and parse stdout in memory;
5. on either failure, read the corresponding live source without writing it;
6. derive catalog `updatedAt` from scratch creation time on success or live file `mtimeMs` on fallback;
7. derive resolver `updatedAt` from `now()` on success or the live snapshot field on fallback;
8. return refresh flags, errors, ages, stale flags, catalog object, and resolver set;
9. recursively remove the scratch root in `finally`.

Default `liveCachePath` from the new `modelCachePath()` export and `liveResolverPath` from
`resolvableModelsPath()`. If refresh and fallback both fail for either source, throw; that is a CLI
exit-1 collection failure, not a reportable blocked candidate.

Do not call `refreshResolvableModels()` because it writes `resolvable-models.json`. Do not call
`publishCachedSubscriptionInventory()` because it posts to the broker.

- [ ] **Step 5: Run source, routing, and watch tests**

```bash
node --experimental-test-module-mocks --test tests/model-reconcile-sources.test.mjs tests/routing.test.mjs tests/watch.test.mjs
```

Expected: PASS; live publication remains unchanged and dry-run isolation is pinned.

- [ ] **Step 6: Commit scratch source collection**

```bash
git add lib/routing.js lib/model-reconcile.js tests/model-reconcile-sources.test.mjs tests/routing.test.mjs
git commit -m "feat: build dry-run model inventory"
```

### Task 5: Reconcile candidates into an idempotent dry-run ledger

**Files:**
- Modify: `lib/model-reconcile.js`
- Create: `tests/model-reconcile.test.mjs`

**Interfaces:**
- Consumes: `CONFIG.modelRoles`, `CONFIG.targets`, `authSnapshot()`
- Consumes: `normalizeCatalogCandidates()` from Task 2
- Consumes: `createReconciliationStore()` and migration readers from Task 3
- Consumes: `collectDryRunSources()` and `buildCachedSubscriptionInventory()` from Task 4
- Produces: `candidateTransitionID(candidate): string`
- Produces: `selectUpgradeCandidates(candidates, staticTargets): SelectionResult`
- Produces: `classifyDryRunCandidate(candidate, sourceStatus): ReconciliationStateName`
- Produces: `runDryReconciliation(options): DryRunReport`
- Produces: `formatDryRunReport(report): string`
- Produces: `readReconciliationStatus(store): ReconciliationStatus`
- Produces: `formatReconciliationStatus(status): string`
- Consumes later: Task 6 CLI calls `runDryReconciliation()` and `formatDryRunReport()`

- [ ] **Step 1: Write failing end-to-end dry-run engine tests**

Use injected source data; never run a real subprocess. Cover this release scenario:

```js
test("records known successors, unknown roles, conflicts, and unresolved models without publishing", () => {
  const report = runDryReconciliation({
    store,
    modelRoles: TEST_ROLES,
    staticTargets: {
      sol: { id: "sol", providerID: "openai", modelID: "gpt-5.6-sol", tiers: ["smart"] },
      opus: { id: "opus", providerID: "anthropic", modelID: "claude-opus-5", tiers: ["build", "smart"] },
    },
    authSnapshot: sequence(
      { revision: "same", types: { openai: "oauth", anthropic: "oauth" } },
      { revision: "same", types: { openai: "oauth", anthropic: "oauth" } },
    ),
    collectSources: () => FRESH_SOURCES_WITH_GPT6_AND_CLAUDE55,
    now: () => NOW,
  });

  assert.equal(report.dryRun, true);
  assert.deepEqual(report.effects, {
    ledgerWritten: true,
    inventoryPublished: false,
    routingMutated: false,
    externalPublished: false,
  });
  assert.equal(report.byModel["openai/gpt-6-sol"].state, "evidence-pending");
  assert.equal(report.byModel["anthropic/claude-opus-5-5"].state, "evidence-pending");
  assert.equal(report.byModel["openai/gpt-6-luna"].state, "blocked-unresolvable");
  assert.equal(report.byModel["example/new-role"].state, "evidence-pending");
  assert.equal(report.byModel["example/conflict"].state, "blocked-conflict");
});
```

Add tests proving:

- API-key, unknown-auth, disconnected, inactive, non-tool, malformed-ID, and speed-variant models are
  never eligible proposed targets, matching current discovery;
- absent GPT-6 Terra is never synthesized;
- global stale/failed refresh produces `blocked-stale` for otherwise valid candidates;
- auth revision change produces `blocked-conflict` and no activation-eligible result;
- exact incumbent models are reported as incumbents, not upgrade candidates;
- per role, only the newest release/date/model-ID candidate is persisted;
- unknown models group by `providerID:family`, or exact model ID when family is absent;
- a second identical run retains transition ID and `stateChangedAt`;
- an existing `rejected`, `rolled-back`, or non-null approval field is never overwritten by dry-run;
- malformed legacy `reviewed-models.json` fails loudly; valid keys appear only in
  `legacyMigration.importKeys` and the legacy file remains unchanged.
- status for an absent ledger equals `{ exists: false, version: null, updatedAt: null, counts: {},
  roles: [], unknown: [] }`; populated status contains sorted role/unknown summaries and counts by
  state without exposing raw evidence or future issue payloads.
- a new record persists `transitions: ["discovered", finalState]`, and Package 1 leaves the top-level
  `evidenceRequests` object empty.

- [ ] **Step 2: Run the engine tests and verify missing exports**

```bash
node --experimental-test-module-mocks --test tests/model-reconcile.test.mjs
```

Expected: FAIL because the dry-run engine functions do not exist.

- [ ] **Step 3: Implement deterministic candidate selection and transition IDs**

Implement transition IDs as the first 24 hex characters of SHA-256 over this NUL-separated tuple:

```text
providerID, roleKey-or-unknown-group, modelID, releaseDate-or-empty
```

Select incumbents by matching configured target models through the same role registry and catalog
metadata. Select one candidate per known role by descending valid release date, then model ID. For an
unknown role, group by exact provider/family (or provider/model when family is absent) and apply the
same ordering. Persist a conflicting family/ID match in `unknown` under that provider/family group and
retain `roleMatches` on its record for Package 2 evidence. Do not compare versions numerically when
provider release dates are available.

- [ ] **Step 4: Implement state classification and locked persistence**

Use this precedence:

1. stale/failed/empty sources → `blocked-stale`;
2. auth revision changed or role match conflict → `blocked-conflict`;
3. not present in resolver → `blocked-unresolvable`;
4. otherwise → `evidence-pending`.

`sourceStatus` includes `catalogStale`, `resolverStale`, refresh errors, empty flags, and
`authRevisionChanged`; `classifyDryRunCandidate()` must not read global state.

`runDryReconciliation()` must:

- take auth snapshots before and after source collection;
- call only pure inventory/candidate functions;
- compute the legacy migration preview;
- acquire the state lock only for the final read-modify-write, not while subprocess refreshes run;
- preserve terminal states, decisions, evidence, Gitea/ntfy fields, and histories already present;
- update `stateChangedAt` only when state or candidate identity changes;
- set `lastObservedAt` on every successful observation;
- initialize a new candidate's transition history as `["discovered", finalState]`, preserving the
  umbrella state machine even though Package 1 computes both states in one locked update;
- return an immutable report with proposed targets and skipped reasons;
- expose no request, notify, Gitea, or broker-control callback.

The human formatter must print source freshness, counts by state, every candidate as
`provider/model -> state (role-or-unknown)`, skipped admission reasons, and the legacy-import preview.
`readReconciliationStatus()` must project the exact bounded JSON shape tested above, and
`formatReconciliationStatus()` must print `no reconciliation state` for `exists: false`; both are pure
read projections and never acquire a writer lock.

For populated state, each `roles` item is exactly `{ roleKey, providerID, roleID, state,
candidateModelID, stateChangedAt, lastObservedAt }`; each `unknown` item is exactly `{ transitionID,
providerID, modelID, family, state, stateChangedAt, lastObservedAt }`. Sort both arrays by their first
identifier and derive `counts` as a sorted state-to-count object. Do not include normalized catalog,
evidence, approvals, issue fields, or histories in status output.

- [ ] **Step 5: Run dry-run engine and all supporting tests**

```bash
node --experimental-test-module-mocks --test tests/model-reconcile.test.mjs tests/model-reconcile-sources.test.mjs tests/reconcile-state.test.mjs tests/model-candidates.test.mjs tests/model-roles.test.mjs tests/routing.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Prove the engine tests fail without the implementation, then restore green**

Stage only the tests before stashing the unstaged engine changes:

```bash
git add tests/model-reconcile.test.mjs
git stash push -u --keep-index -m "red-green dry reconciliation"
node --experimental-test-module-mocks --test tests/model-reconcile.test.mjs
```

Expected: FAIL because the Task 5 engine exports are absent. Restore and rerun:

```bash
git stash pop
git --no-pager status --short
node --experimental-test-module-mocks --test tests/model-reconcile.test.mjs tests/model-reconcile-sources.test.mjs tests/reconcile-state.test.mjs tests/model-candidates.test.mjs tests/model-roles.test.mjs tests/routing.test.mjs
```

Expected: status contains no unmerged entries and the tests PASS.

- [ ] **Step 7: Commit the dry-run engine**

```bash
git add lib/model-reconcile.js tests/model-reconcile.test.mjs
git commit -m "feat: reconcile model candidates in dry run"
```

### Task 6: Expose the CLI, document state, and prepare the Package 1 release

**Files:**
- Create: `bin/opencode-broker-reconcile`
- Create: `tests/reconcile-cli.test.mjs`
- Modify: `package.json:1-36,67-72`
- Modify: `package-lock.json`
- Modify: `README.md` model discovery/watch section
- Modify: `docs/STATE.md:3-20`
- Modify: `CHANGELOG.md:1-23`

**Interfaces:**
- Produces: `opencode-broker-reconcile dry-run [--json]`
- Produces: `opencode-broker-reconcile status [--json]`
- Preserves: existing `opencode-broker` and `opencode-broker-watch` binaries
- Exit `0`: command completed, including reports containing blocked candidates
- Exit `1`: corrupt state, invalid config, source collection failure with no readable fallback, or internal error
- Exit `2`: invalid command/flag usage

- [ ] **Step 1: Write failing spawned-CLI tests**

Create a fake `opencode` executable in a temporary `PATH`. Its `models` command writes a catalog below
the process's supplied `XDG_CACHE_HOME`; its `models --pure` command prints fixed resolver keys. Create
a temporary `HOME` containing OAuth auth metadata and sentinel live cache/resolver files.

Test:

```js
test("dry-run JSON is machine-readable and cannot touch live routing inputs", () => {
  const result = spawnSync(process.execPath, [CLI, "dry-run", "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`,
      OPENCODE_MODEL_ROUTING_DIR: stateRoot,
      XDG_CACHE_HOME: liveCacheRoot,
      XDG_CONFIG_HOME: configRoot,
      OPENCODE_BROKER_CONFIG: configPath },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.effects.inventoryPublished, false);
  assert.equal(report.effects.routingMutated, false);
  assert.deepEqual(readFileSync(liveCachePath), liveCacheBefore);
  assert.deepEqual(readFileSync(liveResolverPath), liveResolverBefore);
  assert.equal(existsSync(join(stateRoot, "model-reconciliation.json")), true);
});
```

Also test human output, `status --json`, missing-state status, corrupt-state exit 1, unknown command exit 2,
unknown option exit 2, and absence of any Gitea/ntfy/broker request in stderr/stdout. In the primary
fixture, omit `openai/gpt-6-sol` from fake resolver stdout and assert the CLI reports that catalog model
as `blocked-unresolvable`, matching the live September 2026 condition. Add a fixture where scratch
refresh and live fallback are both unavailable and assert exit 1 plus an actionable stderr error.

- [ ] **Step 2: Run CLI tests and verify the binary is absent**

```bash
node --experimental-test-module-mocks --test tests/reconcile-cli.test.mjs
```

Expected: FAIL because `bin/opencode-broker-reconcile` does not exist.

- [ ] **Step 3: Implement the thin CLI and package binary**

The binary must parse only:

```text
opencode-broker-reconcile dry-run [--json]
opencode-broker-reconcile status [--json]
```

It must call Task 5 functions, print JSON with one trailing newline under `--json`, print the human
formatter otherwise, and send actionable errors to stderr. It must not contain catalog, state, or
routing logic.

Add to `package.json`:

```json
"opencode-broker-reconcile": "bin/opencode-broker-reconcile"
```

Update `package-lock.json` through `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` after the version change in Step 6.

- [ ] **Step 4: Document the Package 1 boundary and state contract**

Add to `README.md`:

- exact dry-run/status commands;
- dry-run's ledger-only mutation;
- scratch cache/resolver isolation;
- 48h/72h stale definitions;
- explicit statement that Package 1 does not publish inventory or alter routing;
- note that `opencode-broker-watch` remains the live publisher until Package 4.

Add these state rows to `docs/STATE.md`:

```markdown
| `model-reconciliation.json` | `opencode-broker-reconcile` | `opencode-broker-reconcile`, operator tooling | Versioned provider-role candidate observations and future proposal presentation state; Package 1 writes dry-run observations only |
| `.model-reconciliation.lock/` | `opencode-broker-reconcile` | `opencode-broker-reconcile` | Ephemeral mkdir lock and owner record serializing every reconciliation-ledger mutation; removed when the writer exits |
```

Keep the existing `reviewed-models.json` row unchanged and document that Package 1 only previews its
future import.

- [ ] **Step 5: Run focused tests, then the complete suite**

Run:

```bash
node --experimental-test-module-mocks --test tests/reconcile-cli.test.mjs tests/model-reconcile.test.mjs tests/model-reconcile-sources.test.mjs tests/reconcile-state.test.mjs tests/model-candidates.test.mjs tests/model-roles.test.mjs tests/routing.test.mjs tests/watch.test.mjs tests/config-parse.test.mjs
npm test
```

Expected: both commands exit 0 with zero failing tests.

- [ ] **Step 6: Bump Package 1 to 1.20.0 and add the changelog entry**

Change `package.json` and `package-lock.json` from `1.19.1` to `1.20.0`. Add:

```markdown
## [1.20.0] — 2026-09-28

### Added

- **Provider model reconciliation now has a safe dry-run foundation.** A validated provider-role
  registry drives the existing family-tier discovery policy, and `opencode-broker-reconcile dry-run`
  refreshes isolated catalog/resolver inputs, records idempotent candidate observations, reports stale
  or unresolved blockers, and previews the legacy reviewed-model import without publishing inventory
  or changing routing.
```

Run:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm test
```

Expected: package metadata agrees on 1.20.0 and the full suite passes.

- [ ] **Step 7: Commit CLI, docs, and release metadata**

```bash
git add bin/opencode-broker-reconcile tests/reconcile-cli.test.mjs package.json package-lock.json README.md docs/STATE.md CHANGELOG.md
git commit -m "release: add model reconciliation dry run"
```

- [ ] **Step 8: Request code review and stop before deployment**

Run the repository review workflow against the full Package 1 commit range. Address verified findings,
rerun `npm test`, and report the commit range and exact test counts. Do not push, restart the broker,
replace `opencode-model-watch.timer`, edit `/home/dev/fleet-core`, or begin Package 2 in this plan.
