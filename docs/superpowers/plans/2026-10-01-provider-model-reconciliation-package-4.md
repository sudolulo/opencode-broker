# Provider Model Reconciliation Package 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on Package 3's dormant provider-model reconciliation across the fleet through a staged cutover that is audited and can be rolled back. The cutover builds an immutable generation 0, records the config cutover in the ledger, migrates the legacy ledger, applies one provider at a time behind a 24-hour health gate, and leaves a single scheduled writer.

**Architecture:** `opencode-broker` owns every transition write. Its version-2 reconciliation ledger holds five things, each written only through `createReconciliationStore().update()`:
- the generation-0 bootstrap evidence;
- the `configCutover` record that controls the outer config link;
- the legacy-migration record;
- per-provider stage checkpoints;
- a bounded history of scheduled runs.

A new controller in `lib/reconcile-cutover.js` and new `opencode-broker-reconcile` subcommands drive bootstrap, cutover, both kinds of rollback, prepare/commit/canary and the health gates. They all run through the existing Package 3 saga, and the trusted `reconcile.apply.providers` allowlist filters what that saga may touch.

The fleet repo (`/home/dev/devbox`, also reachable as `/home/dev/fleet-core`) owns:
- live configuration;
- the `opencode-model-reconcile` service and timer;
- devbox-sync's convergence of `~/.config/opencode/opencode.json`, which follows the verifier's output;
- the approval skill;
- the `opencode-model-provider-stage` orchestrator. It holds the kernel `flock` on `provider-expansion.lock`, and both scheduled units honour that lock through `flock -n -E 5`.

Neither side infers the other's state. devbox-sync follows `verify-deployed-config`, the stage script calls broker commands, and only the broker writes the ledger.

**Tech Stack:** Node.js >=20.18 (ESM), `node:test` run with `--experimental-test-module-mocks`, POSIX atomic filesystem operations (`fsync`, rename, `0600`/`0700` modes, atomic symlink replacement), systemd user units invoked through `job-run`, bash (`devbox-sync`, stage script), util-linux `flock`.

**Spec:** [`docs/superpowers/specs/2026-10-01-provider-model-reconciliation-package-4-design.md`](../specs/2026-10-01-provider-model-reconciliation-package-4-design.md). This plan implements it inside the umbrella architecture [`docs/superpowers/specs/2026-09-28-provider-model-reconciliation-design.md`](../specs/2026-09-28-provider-model-reconciliation-design.md).

## Global Constraints

- Baselines:
  - Broker: `/home/dev/opencode-broker`, branch `main`, at or after `38069c6`, `package.json` `1.24.0`.
  - Fleet: `/home/dev/devbox`, branch `main`. `/home/dev/fleet-core` is a compatibility symlink to it; Package 4 neither creates nor repairs that symlink.
  - Before Task B1, the implementer runs this in `/home/dev/opencode-broker`: `node -e 'const p=require("./package.json"); if (p.version!=="1.24.0") process.exit(1)' && git merge-base --is-ancestor 38069c6 HEAD`. A nonzero result stops every task and requires re-planning.
- Task order: B1–B9 in `/home/dev/opencode-broker`, then F1–F5 in `/home/dev/devbox`, then R1. B2 must land before B5–B8, and B1 before B3.
- Never stage these files:
  - `/home/dev/opencode-broker/docs/superpowers/plans/2026-09-29-broker-native-classifier-routing.md`
  - `/home/dev/devbox/docs/superpowers/plans/2026-09-22-routing-live-app-cutover.md`
  - `/home/dev/devbox/docs/superpowers/plans/2026-09-22-routing-retirement.md`
  - `/home/dev/devbox/docs/superpowers/plans/2026-09-29-tandoor-router-cutover.md`
  - `/home/dev/devbox/docs/superpowers/specs/2026-09-29-tandoor-router-cutover-design.md`
- Always use each task's exact `git add <explicit paths>`. Never use `git add -A`, `git add .` or `git commit -a`.
- No implementation task pushes, deploys, restarts a service, enables a timer, or touches live state. Only the Operator runbook does those things.
- Production paths (every one can be overridden in tests through options or environment):
  - `RAW_BASE=/home/dev/devbox/config/opencode/opencode.json`
  - `OUTER_LINK=/home/dev/.config/opencode/opencode.json`
  - `COMPAT_RAW=/home/dev/fleet-core/config/opencode/opencode.json`
  - `STATE_ROOT=/home/dev/.local/share/opencode/model-routing` (0700)
  - `OVERLAY=$STATE_ROOT/resolver-overlay.json`
  - `GENERATIONS_ROOT=$STATE_ROOT/resolver-generations`
  - `CURRENT_LINK=$STATE_ROOT/resolver-generations/current`
  - `GENERATED_TARGET=$STATE_ROOT/resolver-generations/current/opencode.json`
  - `REGISTRY=$STATE_ROOT/resolver-generations/resolver-generations.json`
  - `LEDGER=$STATE_ROOT/model-reconciliation.json`
  - `LEGACY_LEDGER=$STATE_ROOT/reviewed-models.json`
  - `EXPANSION_LOCK=$STATE_ROOT/provider-expansion.lock` (0600; never deleted)
- Test environment overrides:
  - `OPENCODE_RECONCILE_STATE_ROOT`
  - `OPENCODE_RECONCILE_RAW_BASE`
  - `OPENCODE_RECONCILE_OUTER_LINK`
  - `OPENCODE_RECONCILE_COMPAT_RAW`
  - `OPENCODE_RECONCILE_FLEET_CORE` (default `/home/dev/fleet-core`)
  - `OPENCODE_RECONCILE_DEVBOX` (default `/home/dev/devbox`)
- No test reads or writes `/home/dev/.local/share/opencode`, `/home/dev/.config/opencode`, `/home/dev/devbox` or `/home/dev/fleet-core`. Every test injects clocks, filesystem roots, broker calls, gateway calls and process identity.
- Runtime directories are `0700` and runtime files are `0600`.
- Generation directories are immutable after publication.
- `resolver-generations.json` is renderer-only, and its high-water mark never decreases.
- Corrupt, partial, wrong-schema or regressed state is preserved for diagnosis and blocks the operation. It is never replaced with empty state.
- `createReconciliationStore().update(mutator)` is the only ledger mutation boundary.
- The only writer of `configCutover` and `generationRegistryInitialized` is `opencode-broker-reconcile`. devbox-sync and the stage script never write ledger state.
- The ledger revision is the top-level integer `revision` added in Task B2:
  - `update()` increments it by exactly 1 on every committed mutation.
  - Every `sourceLedgerRevision` and `ledgerRevision` field is a value of that counter. A record written inside a mutation receives the revision of that mutation as `store.update(mutator)` calls `mutator(state, { revision })`.
- Every timestamp in a Package 4 ledger record is a UTC ISO-8601 string produced by `new Date(ms).toISOString()`.
- Package 3's saga (`createReconciliationApplier`) is the single apply and rollback authority. Package 4 adds no second publisher, and no second rollback path for broker policy.
- `reconcile.apply.enabled` stays `false` through bootstrap, prepare, dry-run and the whole cutover window. Dry-run makes zero publisher calls and changes no prohibited bytes or mtimes.
- Singleton writer rule:
  - Both scheduled units run under `flock -n -E 5 <EXPANSION_LOCK>`.
  - The stage script holds fd 9 on the lock for its whole run.
  - Broker commands never implement their own `flock`.
  - `bin/opencode-broker-watch` exits 5 when `configCutover.mode === "generated"`.
  - `scheduled-run` exits 5 when `configCutover.mode === "raw-emergency"`.
- CLI exit codes follow the job-run contract: 0 ok, 5 quiet/skipped, 10 finding, 20 needs attention, any other value failure. Every `--json` subcommand prints exactly one JSON object.
- Generation-0 manifest membership never confers routing eligibility. Only existing static target IDs are base or legacy eligible. Alibaba admission is exact-key only (`qwen3.8-max` deep, `qwen3.6-flash` worker, `deepseek-v4-pro` build+review, `glm-5.2` build+review). Unknown siblings stay unrouted, including `qwen3.7-max`, `qwen3.7-plus` and `deepseek-v4-flash-0731`.
- Every compatibility probe goes through the loopback fleet gateway and broker. Nothing calls a provider API or llama.cpp directly.
- Plugin one-export rule: `plugin/router.js` keeps exporting exactly one factory, and helpers live under `lib/`.
- After the first version-2 ledger write, a broker older than 1.25.0 cannot read the ledger. Rollback is done through `configCutover` and provider checkpoints, never by downgrading the product.
- Release:
  - Only R1 bumps `package.json` (to `1.25.0`), in the same commit that moves `[Unreleased]` to `## [1.25.0] — <release date>`.
  - B-tasks never add a version heading.
  - This repository does not track `package-lock.json`, so never generate or stage one.

## Review Focus

- RF1 devbox-sync or a timer firing mid-cutover/mid-expansion -> owner F2 (devbox-sync run while configCutover is generated but outer link still raw = intermediate state: must fail loudly, no relink to raw) and F1 (both units carry `flock -n -E 5` wrapper).
- RF2 broker/host restart between the resolver-generations/current swap and the outer-link retarget -> owner B6 (re-running cutover-config completes the retarget from configCutover evidence; verify-deployed-config reports invalid until then).
- RF3 corrupt/partial ledger or registry encountered by scheduled-run -> owner B8 (exit nonzero non-5, no mutation, corrupt bytes preserved, alert-worthy JSON).
- RF4 provider removed from trustedSubscriptionProviders while still in reconcile.apply.providers -> owner B1 (config load reports `apply.configError` naming the provider and forces apply off, never throws), B6a (verify-deployed-config still reports), B8 (stage commands and scheduled-run refuse with `config-unusable` and an alert) and B3 (applier constructed with such a provider refuses).
- RF5 clock skew / host suspend affecting the 24h gate -> owner B8 (gate-complete requires injected wall clock >= startedAt+24h AND >=1 successful scheduledRuns entry whose startedAt > committed.at; a clock earlier than startedAt yields not-eligible with reason "clock-regressed", never completes).

---

### Task B1: Validate the `reconcile.apply.providers` allowlist and pin the notifier fallback

**Files:**
- Modify: `lib/config.js:455-457` (add the allowlist normalizer after `stringList`)
- Modify: `lib/config.js:789-822` (the `reconcile` block: compute and expose `apply.providers`)
- Modify: `examples/config.example.json:410-418`
- Modify: `examples/minimal.config.json:38-41`
- Modify: `tests/config-parse.test.mjs:359-411` (existing apply test) and append new tests
- Modify: `tests/helpers/model-reconcile-runtime.mjs:394` and `:406-411` (apply-enabled fixture must allowlist a trusted provider)
- Modify: `tests/reconcile-cli.test.mjs:119-130` (apply-enabled fixture)
- Modify: `tests/broker.test.mjs:1820-1827` (apply-enabled fixture)

**Interfaces:**
- Consumes: `stringList(value)` (`lib/config.js:455`) and `raw.trustedSubscriptionProviders`.
- Produces: `CONFIG.reconcile.apply.providers: readonly string[]`. It is frozen and always present. An absent value becomes `[]`, and the order is preserved as configured. An invalid allowlist yields `[]`.
- Produces: an invalid allowlist sets `CONFIG.reconcile.apply.configError` (prefixed by any apply-path error already there, joined with `; `), forces `CONFIG.reconcile.apply.enabled` to `false`, and prints `opencode-broker: <message> -- reconciliation apply stays OFF.` to stderr. The import of `lib/config.js` NEVER throws for it. The message is exactly one of:
  - `reconcile.apply.providers is required and must be nonempty when reconcile.apply.enabled is true`
  - `reconcile.apply.providers must be an array of provider IDs, got <JSON>`
  - `reconcile.apply.providers[<i>] <JSON value> is not a valid provider ID`
  - `reconcile.apply.providers[<i>] "<id>" is a duplicate`
  - `reconcile.apply.providers[<i>] "<id>" is not a trustedSubscriptionProviders member`
- Provider-ID syntax: `/^[a-z0-9][a-z0-9-]{0,99}$/`. This is the provider half of a model-role key (`KEY_PART` in `lib/model-roles.js:30`). Task B3 enforces the identical regex inside the applier.
- `CONFIG.reconcile.notifyCommand` is unchanged: `reconcile.notifyCommand` when it is an array, otherwise `watch.notifyCommand`, otherwise `[]`. `CONFIG.watch.notifyCommand` stays configured for burn-watch and slot-watch fallback.
- This task follows the apply-path rule already in this file ("report and stay OFF"), not a throw. `lib/config.js` is imported by the broker daemon, the gateway and the router plugin in every OpenCode process, and an import-time throw would unload the plugin and stop routing fleet-wide over a reconciler-only setting. Spec §Generation 0 and apply policy ("fail startup validation, never silently ignore") is met because the failure is loud at load and every reconciler writer refuses on it: B6b's `cutover-config` and B8's stage commands and `scheduled-run` exit nonzero with `code: "config-unusable"` and an alert, and the existing `APPLY_COMMANDS` gate refuses because `enabled` is false. Only the read-only `verify-deployed-config` and the emergency `rollback-config --raw-emergency` still run.

- [ ] **Step 1: Write the failing allowlist, RF4 and notifier tests**

Append to `tests/config-parse.test.mjs`:

```js
const APPLY_PATHS = Object.freeze({
  overlayPath: "/var/lib/opencode-broker/resolver-overlay.json",
  generationsRoot: "/var/lib/opencode-broker/generations",
  currentLinkPath: "/var/lib/opencode-broker/current",
});
const applyConfig = (apply, trusted = ["openai", "anthropic"]) => loadConfig(JSON.stringify({
  trustedSubscriptionProviders: trusted,
  reconcile: { apply },
}));

test("reconcile.apply.providers accepts absent, empty, or trusted lists while apply is disabled", async () => {
  assert.deepEqual([...(await applyConfig({ enabled: false })).CONFIG.reconcile.apply.providers], []);
  assert.deepEqual([...(await applyConfig({ enabled: false, providers: [] })).CONFIG.reconcile.apply.providers], []);
  const listed = (await applyConfig({ enabled: false, providers: ["openai"] })).CONFIG.reconcile.apply;
  assert.equal(listed.enabled, false);
  assert.deepEqual([...listed.providers], ["openai"]);
  assert.equal(Object.isFrozen(listed.providers), true);
});

// An invalid allowlist never throws (the router plugin in every OpenCode process imports this
// module). It is reported in configError, apply is forced off, and the list is empty.
const rejectedApply = async (apply, pattern, trusted) => {
  const result = (await applyConfig(apply, trusted)).CONFIG.reconcile.apply;
  assert.match(String(result.configError), pattern);
  assert.equal(result.enabled, false);
  assert.deepEqual([...result.providers], []);
  return result;
};

test("enabled apply requires a nonempty reconcile.apply.providers allowlist", async () => {
  await rejectedApply({ enabled: true, ...APPLY_PATHS },
    /reconcile\.apply\.providers is required and must be nonempty when reconcile\.apply\.enabled is true/);
  await rejectedApply({ enabled: true, ...APPLY_PATHS, providers: [] },
    /reconcile\.apply\.providers is required and must be nonempty/);
  const enabled = (await applyConfig({ enabled: true, ...APPLY_PATHS, providers: ["openai"] })).CONFIG.reconcile.apply;
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.configError, null);
  assert.deepEqual([...enabled.providers], ["openai"]);
});

test("malformed, duplicate, or non-array provider allowlists are reported even while apply is disabled", async () => {
  await rejectedApply({ enabled: false, providers: "openai" },
    /reconcile\.apply\.providers must be an array of provider IDs, got "openai"/);
  await rejectedApply({ enabled: false, providers: ["OpenAI"] },
    /reconcile\.apply\.providers\[0\] "OpenAI" is not a valid provider ID/);
  await rejectedApply({ enabled: false, providers: [7] },
    /reconcile\.apply\.providers\[0\] 7 is not a valid provider ID/);
  await rejectedApply({ enabled: false, providers: ["openai", "openai"] },
    /reconcile\.apply\.providers\[1\] "openai" is a duplicate/);
});

// RF4 pin: a provider dropped from the operator's attestation list while still allowlisted for
// mutation is reported at load, naming the provider, and apply is forced off rather than mutating
// without trust. Routing itself keeps loading.
test("a provider removed from trustedSubscriptionProviders but still allowlisted is reported at load naming it", async () => {
  await rejectedApply({ enabled: false, providers: ["openai", "alibaba-token-plan"] },
    /reconcile\.apply\.providers\[1\] "alibaba-token-plan" is not a trustedSubscriptionProviders member/, ["openai"]);
  const enabled = await rejectedApply({ enabled: true, ...APPLY_PATHS, providers: ["openai"] },
    /reconcile\.apply\.providers\[0\] "openai" is not a trustedSubscriptionProviders member/, []);
  assert.equal(enabled.overlayPath, null);
});

test("an apply-path error and an allowlist error are both reported", async () => {
  await rejectedApply({ enabled: true, overlayPath: "relative.json", generationsRoot: APPLY_PATHS.generationsRoot,
    currentLinkPath: APPLY_PATHS.currentLinkPath, providers: ["OpenAI"] },
    /overlayPath must be an absolute path; .*"OpenAI" is not a valid provider ID/);
});

test("reconcile.notifyCommand is optional and watch.notifyCommand stays configured beside it", async () => {
  const both = (await loadConfig(JSON.stringify({
    watch: { notifyCommand: ["/usr/local/bin/watch-notify", "{title}"] },
    reconcile: { notifyCommand: ["/usr/local/bin/reconcile-notify", "{body}"] },
  }))).CONFIG;
  assert.deepEqual([...both.reconcile.notifyCommand], ["/usr/local/bin/reconcile-notify", "{body}"]);
  assert.deepEqual([...both.watch.notifyCommand], ["/usr/local/bin/watch-notify", "{title}"]);
  assert.deepEqual([...both.burnWatch.notifyCommand], ["/usr/local/bin/watch-notify", "{title}"]);

  const fallback = (await loadConfig(JSON.stringify({
    watch: { notifyCommand: ["/usr/local/bin/watch-notify"] },
    reconcile: { apply: { enabled: false, providers: [] } },
  }))).CONFIG;
  assert.deepEqual([...fallback.reconcile.notifyCommand], ["/usr/local/bin/watch-notify"]);
  assert.deepEqual([...fallback.watch.notifyCommand], ["/usr/local/bin/watch-notify"]);
});
```

Replace the existing test `reconcile apply defaults off with null paths and requires all absolute paths` (`tests/config-parse.test.mjs:359-411`) with the version below. It adds `providers` to the default shape and gives the two enabled cases a trusted allowlist, which the new rule requires.

```js
test("reconcile apply defaults off with null paths and requires all absolute paths", async () => {
  const defaults = (await loadConfig(`{}`)).CONFIG.reconcile.apply;
  assert.deepEqual({ ...defaults, providers: [...defaults.providers] }, {
    enabled: false,
    providers: [],
    overlayPath: null,
    generationsRoot: null,
    currentLinkPath: null,
    configError: null,
  });

  const enabled = (await loadConfig(`{
    "trustedSubscriptionProviders": ["openai"],
    "reconcile": { "apply": {
      "enabled": true,
      "providers": ["openai"],
      "overlayPath": "/var/lib/opencode-broker/resolver-overlay.json",
      "generationsRoot": "/var/lib/opencode-broker/generations",
      "currentLinkPath": "/var/lib/opencode-broker/current"
    } }
  }`)).CONFIG.reconcile.apply;
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.configError, null);

  const invalid = (await loadConfig(`{
    "trustedSubscriptionProviders": ["openai"],
    "reconcile": { "apply": {
      "enabled": true,
      "providers": ["openai"],
      "overlayPath": "relative/overlay.json",
      "generationsRoot": "/var/lib/opencode-broker/generations"
    } }
  }`)).CONFIG.reconcile.apply;
  assert.deepEqual({
    enabled: invalid.enabled,
    overlayPath: invalid.overlayPath,
    generationsRoot: invalid.generationsRoot,
    currentLinkPath: invalid.currentLinkPath,
  }, { enabled: false, overlayPath: null, generationsRoot: null, currentLinkPath: null });
  assert.match(invalid.configError, /overlayPath.*absolute/);
  assert.match(invalid.configError, /currentLinkPath.*missing/);

  const truthy = (await loadConfig(`{
    "reconcile": { "apply": {
      "enabled": "true",
      "overlayPath": "/tmp/overlay",
      "generationsRoot": "/tmp/generations",
      "currentLinkPath": "/tmp/current"
    } }
  }`)).CONFIG.reconcile.apply;
  assert.deepEqual({ ...truthy, providers: [...truthy.providers] }, {
    enabled: false,
    providers: [],
    overlayPath: null,
    generationsRoot: null,
    currentLinkPath: null,
    configError: null,
  });
});
```

- [ ] **Step 2: Run the focused tests to verify the red state**

Run: `node --experimental-test-module-mocks --test --test-name-pattern="reconcile.apply.providers|enabled apply requires|malformed, duplicate|removed from trustedSubscriptionProviders|notifyCommand is optional|reconcile apply defaults off|apply-path error and an allowlist" tests/config-parse.test.mjs`

Expected: FAIL.
- The allowlist cases fail with `TypeError: ... is not iterable` (`providers` is `undefined`).
- The rejection cases fail in `rejectedApply` because `configError` is null for a bad allowlist.
- The rewritten default-shape case fails with `TypeError: ... is not iterable` on `[...defaults.providers]`.
- `reconcile.notifyCommand is optional and watch.notifyCommand stays configured beside it` already PASSES, because the fallback shipped in 1.24.0. It pins existing behaviour so that removing the old watch cannot remove the fallback.

- [ ] **Step 3: Implement the allowlist normalizer**

In `lib/config.js`, directly after the `stringList` definition (`lib/config.js:455-457`), insert:

```js
// reconcile.apply.providers names the ONLY providers the reconciler may mutate. A bad allowlist
// reports and forces apply OFF, like the Gitea destination and the apply paths below. It never
// throws: the router plugin in every OpenCode process imports this module, and a throw would stop
// routing fleet-wide over a reconciler-only setting. It is still never silently ignored, because
// every reconciler writer refuses with an alert while configError is set (B6b, B8). The syntax is
// the provider half of a model-role key (lib/model-roles.js KEY_PART), so every allowlisted
// provider is one a role can actually name; lib/reconcile-apply.js enforces the same regex again.
// Returns { providers, error }: a frozen list and null, or a frozen empty list and the FIRST problem.
const APPLY_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const normalizeApplyProviders = (value, { enabled, trusted }) => {
  const label = "reconcile.apply.providers";
  const rejected = (error) => ({ providers: Object.freeze([]), error });
  const required = `${label} is required and must be nonempty when reconcile.apply.enabled is true`;
  if (value === undefined) return enabled ? rejected(required) : { providers: Object.freeze([]), error: null };
  if (!Array.isArray(value)) return rejected(`${label} must be an array of provider IDs, got ${JSON.stringify(value)}`);
  if (enabled && value.length === 0) return rejected(required);
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !APPLY_PROVIDER_ID.test(entry)) {
      return rejected(`${label}[${index}] ${JSON.stringify(entry)} is not a valid provider ID`);
    }
    if (seen.has(entry)) return rejected(`${label}[${index}] "${entry}" is a duplicate`);
    if (!trusted.includes(entry)) return rejected(`${label}[${index}] "${entry}" is not a trustedSubscriptionProviders member`);
    seen.add(entry);
  }
  return { providers: Object.freeze([...value]), error: null };
};
```

In the `reconcile` IIFE, directly after `const applyRequested = applyValue.enabled === true;` (`lib/config.js:790`), insert:

```js
    // Validated against the RAW trusted list (exact members only).
    const applyProviders = normalizeApplyProviders(applyValue.providers, {
      enabled: applyRequested,
      trusted: stringList(raw.trustedSubscriptionProviders),
    });
```

Replace the two statements that compute and report the path error:

```js
    const applyConfigError = invalidApplyPaths.length
      ? `reconcile.apply.enabled is true but ${invalidApplyPaths.join(", ")}`
      : null;
    if (applyConfigError) console.error(`opencode-broker: ${applyConfigError} -- reconciliation apply stays OFF.`);
```

with:

```js
    // Both problems are reported together, so the operator fixes the config once.
    const applyConfigError = [
      invalidApplyPaths.length ? `reconcile.apply.enabled is true but ${invalidApplyPaths.join(", ")}` : null,
      applyProviders.error,
    ].filter(Boolean).join("; ") || null;
    if (applyConfigError) console.error(`opencode-broker: ${applyConfigError} -- reconciliation apply stays OFF.`);
```

Replace the `apply: Object.freeze({ ... })` entry of the returned object (`lib/config.js:815-821`) with:

```js
      apply: Object.freeze({
        enabled: applyRequested && !applyConfigError,
        providers: applyConfigError ? Object.freeze([]) : applyProviders.providers,
        ...(applyRequested && !applyConfigError
          ? applyPaths
          : { overlayPath: null, generationsRoot: null, currentLinkPath: null }),
        configError: applyConfigError,
      }),
```

If the line numbers above no longer match HEAD, locate the statements by their text; `git --no-pager log --oneline -3 -- lib/config.js` shows whether the file moved since this plan was written.

- [ ] **Step 4: Document the key in both shipped examples**

In `examples/config.example.json`, replace lines 410-418 with:

```jsonc
  // Reconciliation mutation is default-OFF. Package 4 cutover supplies absolute deployment paths.
  // `providers` lists the only providers the reconciler may mutate once apply is enabled; every
  // entry must also appear in trustedSubscriptionProviders above, and Package 4 adds one at a time.
  "reconcile": {
    "apply": {
      "enabled": false,
      "providers": ["alibaba-token-plan"],
      "overlayPath": null,
      "generationsRoot": null,
      "currentLinkPath": null
    }
  },
```

In `examples/minimal.config.json`, replace lines 38-41 with:

```jsonc
  // Package 3 ships reconciliation apply dormant. Package 4 supplies deployment paths, an allowlist
  // of trusted providers, and enables it.
  "reconcile": {
    "apply": { "enabled": false, "providers": [], "overlayPath": null, "generationsRoot": null, "currentLinkPath": null }
  },
```

- [ ] **Step 5: Give the three apply-enabled test fixtures a trusted allowlist**

Without this step each of these fixtures enables apply with no providers, so its config now loads with apply forced off and `configError` set, and every apply-path test in those files fails.

In `tests/helpers/model-reconcile-runtime.mjs`, replace line 394 with:

```js
    // openai is attested only on apply-enabled runs, because reconcile.apply.providers may name
    // trustedSubscriptionProviders members only; dormant runs keep the original attestation.
    trustedSubscriptionProviders: applyEnabled ? ["anthropic", "openai"] : ["anthropic"],
```

and replace lines 406-411 with:

```js
      apply: applyEnabled ? {
        enabled: true,
        providers: ["openai"],
        overlayPath,
        generationsRoot,
        currentLinkPath,
      } : { enabled: false },
```

In `tests/reconcile-cli.test.mjs`, replace lines 119-130 with:

```js
  const effectiveConfig = typeof config === "string" || !applyEnabled ? config : {
    ...config,
    trustedSubscriptionProviders: [...new Set([...(config.trustedSubscriptionProviders ?? []), "openai"])],
    reconcile: {
      ...(config.reconcile ?? {}),
      apply: {
        enabled: true,
        providers: ["openai"],
        overlayPath: join(stateRoot, "resolver-overlay.json"),
        generationsRoot: join(stateRoot, "generations"),
        currentLinkPath: join(stateRoot, "generations/current"),
      },
    },
  };
```

In `tests/broker.test.mjs`, replace lines 1820-1827 with the version below. `alibaba-token-plan` is the only `trustedSubscriptionProviders` entry in `tests/fixtures/config.json:363-365`.

```js
  fixture.reconcile = {
    apply: {
      enabled: true,
      providers: ["alibaba-token-plan"],
      overlayPath: join(home, "state/resolver-overlay.json"),
      generationsRoot: join(home, "state/generations"),
      currentLinkPath: join(home, "state/generations/current"),
    },
  };
```

- [ ] **Step 6: Run the focused tests to verify they pass**

Run: `node --experimental-test-module-mocks --test --test-name-pattern="reconcile.apply.providers|enabled apply requires|malformed, duplicate|removed from trustedSubscriptionProviders|notifyCommand is optional|reconcile apply defaults off|shipped example configs|apply-path error and an allowlist" tests/config-parse.test.mjs`

Expected: PASS, 0 failures.

- [ ] **Step 7: Run the full suite**

Run: `npm test`

Expected: PASS, 0 failures. If a test fails outside the files listed for this task, the implementer stops and reports it, and does not edit unrelated tests. An apply-enabled CLI or runtime test whose outcome changed because openai is now attested is a BLOCKED report, not something to fix by editing assertions.

- [ ] **Step 8: Commit**

```bash
git add lib/config.js examples/config.example.json examples/minimal.config.json tests/config-parse.test.mjs tests/helpers/model-reconcile-runtime.mjs tests/reconcile-cli.test.mjs tests/broker.test.mjs
git commit -m "Validate reconcile.apply.providers against trusted subscription providers"
```

---

### Task B2: Ledger schema v2 with strict v1 migration and Package 4 records (lib/reconcile-state.js)

**Files:**
- Modify: `lib/reconcile-state.js:43` (path import), `:47` (version constant), `:61-63` (field constants), `:193-235` (`emptyReconciliationState`, `validateState`, `readStateFile`, replaced by v2 validators, migration and transition rules), `:488-513` (`createReconciliationStore`)
- Create: `tests/reconcile-state-v2.test.mjs`
- Modify (version assertions only): `tests/reconcile-state.test.mjs:113,130-132,412,438,497,530,567`, `tests/model-reconcile.test.mjs:697`, `tests/reconcile-cli.test.mjs:296,350,357`

**Why it is shaped this way (read before editing):**
- The spec requires `sourceLedgerRevision` and `ledgerRevision` values that are "supplied by the enclosing ledger mutation acknowledgement". The v1 ledger has no revision counter at all, so this task adds one top-level key that the contract's key list does not name: `revision`. It is a non-negative integer, and `store.update()` sets it to `current.revision + 1` on every write. Any value a mutator sets is overwritten. `update()` passes the revision of the write in progress to the mutator as a second argument, `{ revision }`. Existing one-argument mutators ignore it and keep working.
- Migration happens in memory on read and nowhere else. A v1 file is migrated strictly, and an unknown v1 key fails closed. `read()` never rewrites the file. Only the next locked `update()` writes v2. **Downgrade risk:** once any v2 ledger is on disk, broker 1.24.x readers fail loudly with `unknown reconciliation state field revision`. That is the intended fail-closed behaviour. A package rollback below 1.25.0 also needs the ledger restored from backup.
- The `configCutover.target` check is an exact string comparison against two targets that each store fixes at construction:
  - `generated` defaults to `join(root, "resolver-generations", "current", "opencode.json")`. That is exactly GENERATED_TARGET when `root` is STATE_ROOT.
  - `rawEmergency` defaults to `process.env.OPENCODE_RECONCILE_RAW_BASE || "/home/dev/devbox/config/opencode/opencode.json"`.

  Every process that reads the same ledger must agree on both values. If they do not, its reads fail closed.
- Optional records (`generationRegistryInitialized`, `configCutover`, `legacyMigration`) are **absent** until written. A mutator that returns `null` for one of them is treated as removing it. A `null` on disk is corrupt.
- All Package 4 ledger timestamps (`initializedAt`, `changedAt`, `prepared.at`, `committed.at`, `gate.startedAt`, `gate.completedAt`, `scheduledRuns[].startedAt`/`endedAt`, `quiescedAt`) are exact `new Date(ms).toISOString()` strings.

**Interfaces:**
- Consumes: nothing from earlier Package 4 tasks. It uses the existing `routingStateDir()` from `lib/routing.js`.
- Produces (exports of `lib/reconcile-state.js`):
  - `RECONCILIATION_STATE_VERSION = 2`
  - `SCHEDULED_RUNS_LIMIT = 50`
  - `DEFAULT_RAW_BASE_PATH = "/home/dev/devbox/config/opencode/opencode.json"`
  - `CONFIG_CUTOVER_MODES = ["generated", "raw-emergency"]`
  - `CONFIG_CUTOVER_REASONS = ["bootstrap", "provider-stage", "emergency-rollback", "reactivation"]`
  - `PROVIDER_STAGE_STATUSES = ["prepared", "committed", "gate-running", "healthy", "failed", "rolled-back"]`
  - `SCHEDULED_RUN_MODES = ["dry-run", "apply"]`
  - `emptyReconciliationState(): { version: 2, updatedAt: 0, revision: 0, roles: {}, unknown: {}, evidenceRequests: {}, providerStages: {}, scheduledRuns: [] }`
  - `migrateReconciliationState(value: unknown): unknown`. A plain object with `version === 1` becomes v2 (`revision: 0`, `providerStages: {}`, `scheduledRuns: []`), and an unknown or missing v1 key throws. Any other value is returned as is, by identity.
  - `validateGenerationRegistryInitialized(value, { ledgerRevision: number }): value` throws `Error`
  - `validateConfigCutover(value, { generationRegistryInitialized, ledgerRevision: number, targets: { generated: string, rawEmergency: string } }): value` throws
   - `validateLegacyMigration(value, { ledgerRevision: number }): value` throws. During baseline phase, `sourceLedgerRevision` may be `null`; during final phase it must be set and must not exceed `ledgerRevision`.
  - `validateProviderStage(providerID: string, value, { ledgerRevision: number }): value` throws
  - `validateScheduledRuns(runs, { ledgerRevision: number }): runs` throws
  - `appendScheduledRun(runs: object[], run: object): object[]` returns a new array, oldest first, holding the newest 50.
  - `createReconciliationStore({ root, now, pid, lockWaitMs, onWarning, fsyncDir, chmodLockDir, configTargets?: { generated?: string, rawEmergency?: string } })` returns `{ read(), update(mutator), paths(), configTargets() }`.
    - `update(mutator)` calls `mutator(stateClone, { revision })`. A **newly created** `generationRegistryInitialized`, or a **created or changed** `configCutover`, must carry `sourceLedgerRevision === revision`.
    - `configTargets()` returns `{ generated, rawEmergency }`.
   - Transition rules enforced by `update()`:
     - `generationRegistryInitialized` is immutable once written (no change, delete or null).
     - `configCutover` and `legacyMigration` are never removed.
     - `legacyMigration.baselineCount` and `baselineHash` are immutable.

**STATE/schema:**
- The v2 ledger carries a top-level integer `revision` key that increments by exactly 1 on every committed mutation. Every `sourceLedgerRevision` and `ledgerRevision` field in Package 4 records is a value of that counter, recording which mutation wrote that record.
- A broker older than 1.25.0 cannot read a version-2 ledger and fails closed with `unknown reconciliation state field revision`. Downgrade from 1.25.0+ to an earlier version requires restoring the pre-cutover ledger backup; the product downgrade alone is insufficient.

---

- [ ] **Step 1: Write the failing test** (create `tests/reconcile-state-v2.test.mjs`)

```js
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { routingStateDir } from "../lib/routing.js";
import {
  DEFAULT_RAW_BASE_PATH,
  RECONCILIATION_STATE_VERSION,
  SCHEDULED_RUNS_LIMIT,
  appendScheduledRun,
  createReconciliationStore,
  emptyReconciliationState,
  migrateReconciliationState,
} from "../lib/reconcile-state.js";

const NOW = 1_800_000_000_000;
const AT = new Date(NOW).toISOString();
const LATER = new Date(NOW + 60_000).toISOString();
const DAY_LATER = new Date(NOW + 86_400_000 + 120_000).toISOString();
const hash = (char) => char.repeat(64);
// Any absolute path will do: configCutover targets are compared as exact strings.
const RAW = "/srv/fixture-devbox/config/opencode/opencode.json";

const withStore = (name, run) => {
  const base = mkdtempSync(join(tmpdir(), `reconcile-state-v2-${name}-`));
  try {
    const root = join(base, "model-routing");
    const store = createReconciliationStore({ root, now: () => NOW, configTargets: { rawEmergency: RAW } });
    return run({ root, store, generated: join(root, "resolver-generations", "current", "opencode.json") });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

const seed = (root, store, value) => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(store.paths().state, JSON.stringify(value) + "\n", { mode: 0o600 });
};

const ledgerBytes = (store) => readFileSync(store.paths().state, "utf8");

// A refused update must leave the ledger byte-identical (or still absent) and release its lock.
const assertRefused = (store, mutator, pattern) => {
  const before = existsSync(store.paths().state) ? ledgerBytes(store) : null;
  assert.throws(() => store.update(mutator), pattern);
  assert.equal(existsSync(store.paths().state) ? ledgerBytes(store) : null, before);
  assert.equal(existsSync(store.paths().lock), false);
};

const V1 = Object.freeze({
  version: 1,
  updatedAt: 5,
  roles: { "openai:gpt-sol": { providerID: "openai", roleID: "gpt-sol", state: "evidence-pending" } },
  unknown: {},
  evidenceRequests: {},
});

const initRecord = (revision) => ({
  schemaVersion: 1, generation: 0, registryHash: hash("1"), manifestHash: hash("2"), rawBaseHash: hash("3"),
  sourceLedgerRevision: revision, initializedAt: AT,
});
const generatedCutover = (target, revision, overrides = {}) => ({
  schemaVersion: 1, mode: "generated", target, generation: 0, manifestHash: hash("2"),
  registryHash: hash("1"), rawBaseHash: hash("3"), sourceLedgerRevision: revision, changedAt: AT,
  reason: "bootstrap", ...overrides,
});
const rawCutover = (revision, overrides = {}) => ({
  schemaVersion: 1, mode: "raw-emergency", target: RAW, generation: null, manifestHash: null,
  registryHash: hash("1"), rawBaseHash: hash("3"), sourceLedgerRevision: revision, changedAt: LATER,
  reason: "emergency-rollback", ...overrides,
});
const legacy = (revision, overrides = {}) => ({
  schemaVersion: 1, baselineCount: 83, baselineHash: hash("b"), finalCount: null, finalHash: null,
  sourceLedgerRevision: revision, quiescedAt: null, archivePath: null, archiveHash: null, ...overrides,
});
const prepared = (overrides = {}) => ({
  at: AT, allowlist: ["openai"], ledgerRevision: 1, overlayHash: hash("4"), effectiveHash: hash("5"),
  baseHash: hash("3"), manifestHash: null, policyIntentHash: hash("6"), ...overrides,
});
const committed = (overrides = {}) => ({
  at: LATER, generation: 1, manifestHash: hash("7"),
  generationAck: { generation: 1, manifestHash: hash("7"), effectiveHash: hash("5") },
  brokerAck: null, ledgerAck: { revision: 2 }, ...overrides,
});
const checkpoint = (overrides = {}) => ({
  generation: 0, manifestHash: hash("2"), allowlist: [], ledgerRevision: 1, brokerPolicyRevision: null, ...overrides,
});
const gate = (overrides = {}) => ({
  startedAt: LATER, completedAt: null, scheduledRunIDs: [], evidence: [], resetCount: 0, ...overrides,
});
const stage = (overrides = {}) => ({
  schemaVersion: 1, status: "prepared", prepared: prepared(), committed: null, checkpoint: null, gate: null, ...overrides,
});
const scheduledRun = (index, overrides = {}) => ({
  id: `run-${index}`, startedAt: AT, endedAt: LATER, ok: true, mode: "dry-run", providers: [],
  ledgerRevision: 0, exitCode: 0, ...overrides,
});

const bootstrap = (store) => store.update((state, { revision }) => ({
  ...state, generationRegistryInitialized: initRecord(revision),
}));

test("an empty v2 ledger carries a zero revision, no stages and no scheduled runs", () => {
  assert.equal(RECONCILIATION_STATE_VERSION, 2);
  assert.deepEqual(emptyReconciliationState(), {
    version: 2, updatedAt: 0, revision: 0, roles: {}, unknown: {}, evidenceRequests: {},
    providerStages: {}, scheduledRuns: [],
  });
});

test("a v1 ledger migrates in memory on read and is persisted as v2 only by a locked update", () => {
  const input = structuredClone(V1);
  const migrated = migrateReconciliationState(input);
  assert.equal(input.version, 1, "migration must not mutate its input");
  assert.deepEqual(migrated, { ...V1, version: 2, revision: 0, providerStages: {}, scheduledRuns: [] });
  assert.equal(migrateReconciliationState(migrated), migrated);

  withStore("migrate", ({ root, store }) => {
    seed(root, store, V1);
    const before = ledgerBytes(store);
    const read = store.read();
    assert.equal(read.version, 2);
    assert.equal(read.revision, 0);
    assert.deepEqual(read.roles, V1.roles);
    assert.deepEqual(read.providerStages, {});
    assert.deepEqual(read.scheduledRuns, []);
    // Reading is never a reason to rewrite: a read-only verifier must leave the bytes alone.
    assert.equal(ledgerBytes(store), before);

    let seen = null;
    const saved = store.update((state, ack) => {
 seen = ack; return state; });
    assert.deepEqual(seen, { revision: 1 });
    assert.equal(saved.revision, 1);
    const onDisk = JSON.parse(ledgerBytes(store));
    assert.equal(onDisk.version, 2);
    assert.equal(onDisk.revision, 1);
    assert.deepEqual(onDisk.roles, V1.roles);
  });
});

test("v1 migration is strict and fails closed with the bytes preserved", () => {
  const { evidenceRequests, ...missing } = V1;
  assert.deepEqual(evidenceRequests, {});
  const cases = [
    [{ ...V1, surprise: true }, /unknown reconciliation state v1 field surprise/],
    [{ ...V1, revision: 3 }, /unknown reconciliation state v1 field revision/],
    [missing, /reconciliation state v1 is missing field evidenceRequests/],
    [{ ...V1, roles: [] }, /reconciliation state field roles is not an object/],
  ];
  for (const [value, pattern] of cases) {
    withStore("strict-v1", ({ root, store }) => {
      seed(root, store, value);
      assert.throws(() => store.read(), pattern);
      assertRefused(store, (state) => state, pattern);
    });
  }
});

test("unknown versions, unknown v2 fields and a malformed revision fail loudly", () => {
  const cases = [
    [{ ...emptyReconciliationState(), version: 3 }, /unsupported reconciliation state version 3/],
    [{ ...emptyReconciliationState(), surprise: true }, /unknown reconciliation state field surprise/],
    [{ ...emptyReconciliationState(), revision: -1 }, /reconciliation state has an invalid revision -1/],
    [{ ...emptyReconciliationState(), scheduledRuns: {} }, /reconciliation state field scheduledRuns is not an array/],
  ];
  for (const [value, pattern] of cases) {
    withStore("versions", ({ root, store }) => {
      seed(root, store, value);
      assert.throws(() => store.read(), pattern);
      assertRefused(store, (state) => state, pattern);
    });
  }
});

test("every update advances the revision by exactly one and a mutator cannot set it", () => {
  withStore("revision", ({ store }) => {
    assert.equal(store.update((state) => state).revision, 1);
    assert.equal(store.update((state) => ({ ...state, revision: 40 })).revision, 2);
    assert.equal(store.read().revision, 2);
  });
});

test("generationRegistryInitialized is validated field by field", () => {
  withStore("init-fields", ({ store }) => {
    const cases = [
      [{ generation: 1 }, /generationRegistryInitialized generation must be 0/],
      [{ schemaVersion: 2 }, /generationRegistryInitialized schemaVersion must be 1/],
      [{ manifestHash: hash("A") }, /generationRegistryInitialized\.manifestHash must be a lowercase 64-hex SHA-256/],
      [{ initializedAt: "2026-10-01 00:00:00" }, /generationRegistryInitialized\.initializedAt must be a UTC ISO-8601 timestamp/],
      [{ initializedAt: "2026-10-01T00:00:00+02:00" }, /initializedAt must be a UTC ISO-8601 timestamp/],
      [{ extra: true }, /generationRegistryInitialized has unknown field extra/],
    ];
    for (const [overrides, pattern] of cases) {
      assertRefused(store, (state, { revision }) => ({
        ...state, generationRegistryInitialized: { ...initRecord(revision), ...overrides },
      }), pattern);
    }
  });
});

test("generationRegistryInitialized is written once with the enclosing revision and is then immutable", () => {
  withStore("init-immutable", ({ store }) => {
    store.update((state) => state); // revision 1
    assertRefused(store, (state) => ({ ...state, generationRegistryInitialized: initRecord(1) }),
      /generationRegistryInitialized\.sourceLedgerRevision must be the enclosing ledger revision 2/);
    const saved = bootstrap(store);
    assert.equal(saved.generationRegistryInitialized.sourceLedgerRevision, 2);
    // An identical record rebuilt in another key order is an exact replay, not a change.
    const replayed = store.update((state) => ({
      ...state,
      generationRegistryInitialized: Object.fromEntries(Object.entries(state.generationRegistryInitialized).reverse()),
    }));
    assert.equal(replayed.generationRegistryInitialized.sourceLedgerRevision, 2);
    for (const mutator of [
      (state) => ({ ...state, generationRegistryInitialized: { ...state.generationRegistryInitialized, registryHash: hash("9") } }),
      (state) => { delete state.generationRegistryInitialized; return state; },
      (state) => ({ ...state, generationRegistryInitialized: null }),
    ]) {
      assertRefused(store, mutator, /generationRegistryInitialized is immutable once written/);
    }
  });
});

test("configCutover accepts only the two valid states of the spec table", () => {
  withStore("cutover", ({ store, generated }) => {
    bootstrap(store); // revision 1; every refused attempt below runs at revision 2
    const cases = [
      [(rev) => generatedCutover(generated, rev, { manifestHash: null }), /configCutover\.manifestHash must be a lowercase 64-hex SHA-256/],
      [(rev) => generatedCutover(generated, rev, { generation: null }), /configCutover\.generation must be a non-negative integer/],
      [(rev) => rawCutover(rev, { generation: 0 }), /configCutover raw-emergency requires null generation and manifestHash/],
      [(rev) => rawCutover(rev, { manifestHash: hash("2") }), /configCutover raw-emergency requires null generation and manifestHash/],
      [(rev) => rawCutover(rev, { reason: "bootstrap" }), /configCutover raw-emergency requires reason emergency-rollback/],
      [(rev) => generatedCutover(generated, rev, { reason: "emergency-rollback" }), /configCutover reason emergency-rollback requires mode raw-emergency/],
      [(rev) => generatedCutover(generated.replace("/current/", "/./current/"), rev), /configCutover target for mode generated must be exactly/],
      [(rev) => generatedCutover(RAW, rev), /configCutover target for mode generated must be exactly/],
      [(rev) => rawCutover(rev, { target: generated }), /configCutover target for mode raw-emergency must be exactly/],
      [(rev) => generatedCutover(generated, rev, { manifestHash: hash("8") }), /configCutover generation 0 does not match the generationRegistryInitialized acknowledgement/],
      [(rev) => generatedCutover(generated, rev, { rawBaseHash: hash("9") }), /configCutover bootstrap rawBaseHash does not match the generationRegistryInitialized acknowledgement/],
      [(rev) => generatedCutover(generated, rev, { generation: 2, manifestHash: hash("a") }), /configCutover reason bootstrap requires generation 0/],
      [(rev) => generatedCutover(generated, rev, { mode: "rollback" }), /configCutover mode rollback is invalid/],
      [(rev) => ({ ...generatedCutover(generated, rev), extra: 1 }), /configCutover has unknown field extra/],
      [(rev) => generatedCutover(generated, rev - 1), /configCutover\.sourceLedgerRevision must be the enclosing ledger revision 2/],
    ];
    for (const [build, pattern] of cases) {
      assertRefused(store, (state, { revision }) => ({ ...state, configCutover: build(revision) }), pattern);
    }
    const cutover = store.update((state, { revision }) => ({ ...state, configCutover: generatedCutover(generated, revision) }));
    assert.equal(cutover.configCutover.sourceLedgerRevision, 2);
    // Carrying an unchanged record through an unrelated write is not a new CAS.
    assert.equal(store.update((state) => state).configCutover.sourceLedgerRevision, 2);
    const rolledBack = store.update((state, { revision }) => ({ ...state, configCutover: rawCutover(revision) }));
    assert.equal(rolledBack.configCutover.mode, "raw-emergency");
    assert.equal(rolledBack.configCutover.generation, null);
    const reactivated = store.update((state, { revision }) => ({
      ...state,
      configCutover: generatedCutover(generated, revision, { generation: 3, manifestHash: hash("a"), reason: "reactivation" }),
    }));
    assert.equal(reactivated.configCutover.generation, 3);
    assertRefused(store, (state) => { delete state.configCutover; return state; }, /configCutover cannot be removed once written/);
    assertRefused(store, (state) => ({ ...state, configCutover: null }), /configCutover cannot be removed once written/);
  });
});

test("configCutover without the initialization acknowledgement is invalid in both modes", () => {
  withStore("cutover-no-init", ({ store, generated }) => {
    assertRefused(store, (state, { revision }) => ({ ...state, configCutover: generatedCutover(generated, revision) }),
      /configCutover requires a generationRegistryInitialized acknowledgement/);
    assertRefused(store, (state, { revision }) => ({ ...state, configCutover: rawCutover(revision) }),
      /configCutover requires a generationRegistryInitialized acknowledgement/);
  });
});

test("a schema-invalid v2 ledger on disk fails closed for read and update with its bytes preserved", () => {
  withStore("corrupt-v2", ({ root, store, generated }) => {
    const cases = [
      [{ ...emptyReconciliationState(), revision: 4, configCutover: generatedCutover(generated, 4) }, /configCutover requires a generationRegistryInitialized acknowledgement/],
      [{ ...emptyReconciliationState(), generationRegistryInitialized: null }, /generationRegistryInitialized is not an object/],
      [{ ...emptyReconciliationState(), revision: 2, generationRegistryInitialized: initRecord(3) }, /generationRegistryInitialized\.sourceLedgerRevision 3 is ahead of ledger revision 2/],
      [{ ...emptyReconciliationState(), scheduledRuns: Array.from({ length: 51 }, (_, index) => scheduledRun(index)) }, /scheduledRuns holds 51 entries; the limit is 50/],
    ];
    for (const [value, pattern] of cases) {
      seed(root, store, value);
      const before = ledgerBytes(store);
      assert.throws(() => store.read(), pattern);
      assertRefused(store, (state) => state, pattern);
      assert.equal(ledgerBytes(store), before);
    }
  });
});

test("legacyMigration records a baseline first and keeps that baseline immutable", () => {
   withStore("legacy", ({ store }) => {
     const saved = store.update((state, { revision }) => ({ ...state, legacyMigration: legacy(revision) }));
     assert.equal(saved.legacyMigration.finalCount, null);
     const cases = [
       [{ finalCount: 80, finalHash: hash("c") }, /legacyMigration\.finalCount is below baselineCount/],
       [{ finalHash: hash("c") }, /legacyMigration\.finalHash requires finalCount/],
       [{ archivePath: "archive/reviewed-models.json", archiveHash: hash("d") }, /legacyMigration\.archivePath must be a normalized absolute path/],
       [{ archivePath: "/srv/archive/../reviewed-models.json", archiveHash: hash("d") }, /legacyMigration\.archivePath must be a normalized absolute path/],
       [{ archiveHash: hash("d") }, /legacyMigration\.archiveHash requires archivePath/],
       [{ quiescedAt: "yesterday" }, /legacyMigration\.quiescedAt must be a UTC ISO-8601 timestamp/],
       [{ baselineCount: 84 }, /legacyMigration baseline is immutable once recorded/],
       [{ baselineHash: hash("e") }, /legacyMigration baseline is immutable once recorded/],
     ];
     for (const [overrides, pattern] of cases) {
       assertRefused(store, (state) => ({ ...state, legacyMigration: { ...state.legacyMigration, ...overrides } }), pattern);
     }
     const final = store.update((state, { revision }) => ({
       ...state,
       legacyMigration: {
         ...state.legacyMigration, finalCount: 85, finalHash: hash("c"), sourceLedgerRevision: revision,
         quiescedAt: LATER, archivePath: "/srv/archive/reviewed-models.json", archiveHash: hash("d"),
       },
     }));
     assert.equal(final.legacyMigration.finalCount, 85);
     assertRefused(store, (state) => { delete state.legacyMigration; return state; }, /legacyMigration cannot be removed once written/);
   });
});

test("legacyMigration baseline phase allows null sourceLedgerRevision; final phase requires it and rejects values greater than ledger revision", () => {
    withStore("legacy-revision", ({ store }) => {
      // Baseline phase: sourceLedgerRevision may be null
      const baseline = store.update((state, { revision }) => ({
        ...state,
        legacyMigration: { ...legacy(null), sourceLedgerRevision: null },
      }));
      assert.equal(baseline.legacyMigration.sourceLedgerRevision, null);
      // Final phase: sourceLedgerRevision must be set and must not exceed ledger revision
      const final = store.update((state, { revision }) => ({
        ...state,
        legacyMigration: {
          ...state.legacyMigration,
          finalCount: 85,
          finalHash: hash("c"),
          sourceLedgerRevision: revision,
          quiescedAt: LATER,
          archivePath: "/srv/archive/reviewed-models.json",
          archiveHash: hash("d"),
        },
      }));
      assert.equal(final.legacyMigration.sourceLedgerRevision, 2);
      // Reject a sourceLedgerRevision greater than the current ledger revision
      assertRefused(store, (state, { revision }) => ({
        ...state,
        legacyMigration: { ...state.legacyMigration, sourceLedgerRevision: revision + 1 },
      }), /legacyMigration\.sourceLedgerRevision \d+ is ahead of ledger revision \d+/);
      // Final phase with null finalCount: sourceLedgerRevision must be set even if finalCount is null
      assertRefused(store, (state, { revision }) => ({
        ...state,
        legacyMigration: { ...state.legacyMigration, sourceLedgerRevision: null },
      }), /legacyMigration\.sourceLedgerRevision is required once finalCount is set/);
    });
  });

test("a re-prepared stage may keep its failed gate, but never committed evidence", () => {
  withStore("reprepare", ({ store }) => {
    const kept = store.update((state) => ({ ...state,
      providerStages: { openai: stage({ gate: gate({ resetCount: 1 }) }) } }));
    assert.equal(kept.providerStages.openai.status, "prepared");
    assert.equal(kept.providerStages.openai.gate.resetCount, 1);
    assertRefused(store, (state) => ({ ...state, providerStages: { openai: stage({ committed: committed() }) } }),
      /providerStages\.openai status prepared cannot carry committed evidence/);
  });
});

test("provider stages enforce exact shapes and status consistency", () => {
  withStore("stages", ({ store }) => {
    const cases = [
      [{ OpenAI: stage() }, /providerStages key OpenAI is not a valid provider ID/],
      [{ openai: stage({ status: "paused" }) }, /providerStages\.openai status paused is invalid/],
      [{ openai: stage({ prepared: prepared({ allowlist: ["anthropic"] }) }) }, /providerStages\.openai\.prepared\.allowlist must include openai/],
      [{ openai: stage({ prepared: prepared({ allowlist: ["openai", "openai"] }) }) }, /providerStages\.openai\.prepared\.allowlist has duplicate provider IDs/],
      [{ openai: stage({ prepared: prepared({ ledgerRevision: 99 }) }) }, /providerStages\.openai\.prepared\.ledgerRevision 99 is ahead of ledger revision 1/],
      [{ openai: stage({ prepared: prepared({ policyIntentHash: "nope" }) }) }, /providerStages\.openai\.prepared\.policyIntentHash must be a lowercase 64-hex SHA-256/],
      [{ openai: stage({ committed: committed(), checkpoint: checkpoint() }) }, /providerStages\.openai status prepared cannot carry committed evidence/],
      [{ openai: stage({ status: "committed", committed: committed() }) }, /providerStages\.openai status committed requires committed and checkpoint/],
      [{ openai: stage({ status: "committed", checkpoint: checkpoint() }) }, /providerStages\.openai status committed requires committed and checkpoint/],
      [{ openai: stage({ status: "committed", checkpoint: checkpoint(), committed: committed({ generationAck: { generation: 2, manifestHash: hash("7"), effectiveHash: hash("5") } }) }) }, /providerStages\.openai\.committed\.generationAck does not match committed generation 1/],
      [{ openai: stage({ status: "committed", committed: committed(), checkpoint: checkpoint({ brokerPolicyRevision: "" }) }) }, /providerStages\.openai\.checkpoint\.brokerPolicyRevision must be null, a non-negative integer or a non-empty string/],
      [{ openai: stage({ status: "gate-running", committed: committed(), checkpoint: checkpoint() }) }, /providerStages\.openai status gate-running requires a started, uncompleted gate/],
      [{ openai: stage({ status: "gate-running", committed: committed(), checkpoint: checkpoint(), gate: gate({ completedAt: DAY_LATER }) }) }, /providerStages\.openai status gate-running requires a started, uncompleted gate/],
      [{ openai: stage({ status: "gate-running", committed: committed(), checkpoint: checkpoint(), gate: gate({ scheduledRunIDs: ["run-1", "run-1"] }) }) }, /providerStages\.openai\.gate\.scheduledRunIDs has duplicate run IDs/],
      [{ openai: stage({ status: "healthy", committed: committed(), checkpoint: checkpoint(), gate: gate() }) }, /providerStages\.openai status healthy requires a completed gate/],
      [{ openai: stage({ status: "healthy", committed: committed(), checkpoint: checkpoint(), gate: gate({ completedAt: AT }) }) }, /providerStages\.openai\.gate\.completedAt precedes gate\.startedAt/],
    ];
    for (const [providerStages, pattern] of cases) {
      assertRefused(store, (state) => ({ ...state, providerStages }), pattern);
    }
    store.update((state) => ({ ...state, providerStages: { openai: stage() } }));
    store.update((state) => ({ ...state, providerStages: { openai: stage({ status: "committed", committed: committed(), checkpoint: checkpoint() }) } }));
    store.update((state) => ({ ...state, providerStages: { openai: stage({ status: "gate-running", committed: committed(), checkpoint: checkpoint(), gate: gate() }) } }));
    const healthy = store.update((state) => ({
      ...state,
      providerStages: { openai: stage({ status: "healthy", committed: committed(), checkpoint: checkpoint(), gate: gate({ completedAt: DAY_LATER, scheduledRunIDs: ["run-1"] }) }) },
    }));
    assert.equal(healthy.providerStages.openai.status, "healthy");
    const failed = store.update((state) => ({ ...state, providerStages: { ...state.providerStages, anthropic: stage({ status: "failed", prepared: prepared({ allowlist: ["openai", "anthropic"] }) }) } }));
    assert.equal(failed.providerStages.anthropic.status, "failed");
  });
});

test("scheduled runs keep only the newest fifty and reject malformed entries", () => {
  withStore("runs", ({ store }) => {
    assert.equal(SCHEDULED_RUNS_LIMIT, 50);
    const input = Object.freeze([scheduledRun(0)]);
    assert.equal(appendScheduledRun(input, scheduledRun(1)).length, 2);
    assert.equal(input.length, 1, "appendScheduledRun must not mutate its input");
    let runs = [];
    for (let index = 0; index < 55; index += 1) runs = appendScheduledRun(runs, scheduledRun(index));
    assert.equal(runs.length, 50);
    assert.equal(runs[0].id, "run-5");
    assert.equal(runs.at(-1).id, "run-54");
    assert.equal(store.update((state) => ({ ...state, scheduledRuns: runs })).scheduledRuns.length, 50);
    const cases = [
      [(state) => [...state.scheduledRuns, scheduledRun(99)], /scheduledRuns holds 51 entries; the limit is 50/],
      [() => [scheduledRun(1), scheduledRun(1)], /scheduledRuns has duplicate id run-1/],
      [() => [scheduledRun(1, { mode: "live" })], /scheduledRuns\[0\]\.mode live is invalid/],
      [() => [scheduledRun(1, { endedAt: null })], /scheduledRuns\[0\]\.endedAt and exitCode must both be null or both be set/],
      [() => [scheduledRun(1, { exitCode: 256 })], /scheduledRuns\[0\]\.exitCode must be an integer from 0 to 255/],
      [() => [scheduledRun(1, { ledgerRevision: 99 })], /scheduledRuns\[0\]\.ledgerRevision 99 is ahead of ledger revision 2/],
      [() => [scheduledRun(1, { providers: ["openai", "openai"] })], /scheduledRuns\[0\]\.providers has duplicate provider IDs/],
    ];
    for (const [build, pattern] of cases) {
      assertRefused(store, (state) => ({ ...state, scheduledRuns: build(state) }), pattern);
    }
    // A run still in flight has neither an end nor an exit code.
    const inFlight = store.update((state) => ({
      ...state, scheduledRuns: appendScheduledRun(state.scheduledRuns, scheduledRun(60, { endedAt: null, exitCode: null })),
    }));
    assert.equal(inFlight.scheduledRuns.at(-1).id, "run-60");
    assert.equal(inFlight.scheduledRuns.length, 50);
  });
});

test("config targets default to the store root and the raw base, with an env override for tests", () => {
  const saved = process.env.OPENCODE_RECONCILE_RAW_BASE;
  try {
    delete process.env.OPENCODE_RECONCILE_RAW_BASE;
    assert.equal(DEFAULT_RAW_BASE_PATH, "/home/dev/devbox/config/opencode/opencode.json");
    assert.deepEqual(createReconciliationStore().configTargets(), {
      generated: join(routingStateDir(), "resolver-generations", "current", "opencode.json"),
      rawEmergency: DEFAULT_RAW_BASE_PATH,
    });
    process.env.OPENCODE_RECONCILE_RAW_BASE = "/tmp/fixture-raw-base.json";
    assert.equal(createReconciliationStore({ root: "/tmp/fixture-root" }).configTargets().rawEmergency, "/tmp/fixture-raw-base.json");
    assert.throws(() => createReconciliationStore({ configTargets: { rawEmergency: "relative.json" } }),
      /config target rawEmergency must be an absolute path/);
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_RECONCILE_RAW_BASE;
    else process.env.OPENCODE_RECONCILE_RAW_BASE = saved;
  }
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/reconcile-state-v2.test.mjs`
Expected: FAIL. The whole file fails to load with `SyntaxError: The requested module '../lib/reconcile-state.js' does not provide an export named 'DEFAULT_RAW_BASE_PATH'`.

- [ ] **Step 3: Update the existing version assertions to v2**

These sites are the only real-store assertions on the ledger version, found by grepping `tests/` for `.version, 1)` and `version: 1, updatedAt`. The fake store in `tests/reconcile-apply.test.mjs:115-121,209` never goes through `createReconciliationStore` and is left alone. `tests/reconcile-cli.test.mjs:237-240` (`seedLedger`) also stays as it is. It still writes a **v1** ledger, so the CLI subprocess tests now also cover the v1 to v2 migration.

In `tests/reconcile-state.test.mjs`, line 113:

```js
    assert.equal(saved.version, 2);
```

In `tests/reconcile-state.test.mjs`, lines 130-132:

```js
    assert.deepEqual(emptyReconciliationState(), {
      version: 2, updatedAt: 0, revision: 0, roles: {}, unknown: {}, evidenceRequests: {},
      providerStages: {}, scheduledRuns: [],
    });
```

In `tests/reconcile-state.test.mjs`, lines 412, 438, 497, 530 and 567, replace every `store.update((state) => state).version, 1);` and keep each line's own indentation:

```js
    assert.equal(store.update((state) => state).version, RECONCILIATION_STATE_VERSION);
```

In `tests/model-reconcile.test.mjs`, line 697:

```js
    assert.equal(status.version, 2);
```

In `tests/reconcile-cli.test.mjs`, line 296 and line 350, in that order:

```js
    assert.equal(ledger.version, 2);
```

```js
    assert.equal(status.version, 2);
```

In `tests/reconcile-cli.test.mjs`, line 357:

```js
    assert.match(human.stdout, /^reconciliation state v2, updated /);
```

Run: `node --experimental-test-module-mocks --test tests/reconcile-state.test.mjs tests/model-reconcile.test.mjs tests/reconcile-cli.test.mjs`
Expected: FAIL. Exactly five tests fail with `1 !== 2` or deepEqual differences:
- "state round-trips atomically with private permissions"
- "an absent ledger reads as the empty state and constructing a store writes nothing"
- "populated status is a sorted, bounded projection with no evidence or issue payload"
- "dry-run JSON is machine-readable and cannot touch live routing inputs"
- "status reports the ledger a dry run wrote"

The five `RECONCILIATION_STATE_VERSION` lines still pass, because the constant is still 1.

- [ ] **Step 4: Implement v2 in `lib/reconcile-state.js`**

4a. Replace line 43 (`import { join } from "node:path";`) with:

```js
import { isAbsolute, join, normalize } from "node:path";
```

4b. Replace line 47 (`export const RECONCILIATION_STATE_VERSION = 1;`) with:

```js
export const RECONCILIATION_STATE_VERSION = 2;
```

4c. Replace lines 61-63 (the `// The complete set of top-level keys version 1 defines...` comment, `STATE_FIELDS` and `MAP_FIELDS`) with:

```js
// Version 1 defined exactly these top-level keys. A version-1 file is migrated in memory on read
// (migrateReconciliationState) and written back as version 2 only by the next locked update;
// reading never rewrites the file.
const V1_STATE_FIELDS = Object.freeze(["version", "updatedAt", "roles", "unknown", "evidenceRequests"]);
// The complete set of top-level keys version 2 defines. Anything else is a different schema.
// `revision` is the ledger revision Package 4 records cite: +1 on every committed update.
const STATE_FIELDS = Object.freeze([
  ...V1_STATE_FIELDS, "revision", "providerStages", "scheduledRuns",
  "generationRegistryInitialized", "configCutover", "legacyMigration",
]);
const MAP_FIELDS = Object.freeze(["roles", "unknown", "evidenceRequests", "providerStages"]);
// Records that are ABSENT until the step that creates them. There is no null form on disk.
const OPTIONAL_RECORDS = Object.freeze(["generationRegistryInitialized", "configCutover", "legacyMigration"]);

export const SCHEDULED_RUNS_LIMIT = 50;
export const DEFAULT_RAW_BASE_PATH = "/home/dev/devbox/config/opencode/opencode.json";
export const CONFIG_CUTOVER_MODES = Object.freeze(["generated", "raw-emergency"]);
export const CONFIG_CUTOVER_REASONS = Object.freeze(["bootstrap", "provider-stage", "emergency-rollback", "reactivation"]);
export const PROVIDER_STAGE_STATUSES = Object.freeze(["prepared", "committed", "gate-running", "healthy", "failed", "rolled-back"]);
export const SCHEDULED_RUN_MODES = Object.freeze(["dry-run", "apply"]);

const SHA256_HEX = /^[a-f0-9]{64}$/;
// Same syntax as provider/target IDs in lib/config.js (TARGET_ID) and lib/provider-health.js.
const PROVIDER_ID = /^[a-z0-9][a-z0-9._:-]{0,180}$/;
const RUN_ID = /^[A-Za-z0-9._:-]{1,200}$/;
```

4d. Replace lines 193-235 (`emptyReconciliationState` through the end of `readStateFile`) with:

```js
export const emptyReconciliationState = () => ({
  version: RECONCILIATION_STATE_VERSION,
  updatedAt: 0,
  revision: 0,
  roles: {},
  unknown: {},
  evidenceRequests: {},
  providerStages: {},
  scheduledRuns: [],
});

const fail = (message) => { throw new Error(message); };
const isCount = (value) => Number.isInteger(value) && value >= 0;
// Exactly the form Date#toISOString produces: UTC, millisecond precision, trailing Z.
const isUtcIso = (value) => typeof value === "string"
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString() === value;

const exactKeys = (value, fields, label) => {
  if (!isPlainObject(value)) fail(`${label} is not an object`);
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) fail(`${label} has unknown field ${key}`);
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing field ${key}`);
  }
};
const requireCount = (value, label) => {
  if (!isCount(value)) fail(`${label} must be a non-negative integer`);
};
const requireHash = (value, label) => {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) fail(`${label} must be a lowercase 64-hex SHA-256`);
};
const requireIso = (value, label) => {
  if (!isUtcIso(value)) fail(`${label} must be a UTC ISO-8601 timestamp`);
};
// A record can only cite a ledger revision that already exists, never a future one.
const requireRevision = (value, label, ledgerRevision) => {
  requireCount(value, label);
  if (value > ledgerRevision) fail(`${label} ${value} is ahead of ledger revision ${ledgerRevision}`);
};
const requireProviderList = (value, label) => {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  for (const id of value) {
    if (typeof id !== "string" || !PROVIDER_ID.test(id)) fail(`${label} has an invalid provider ID ${String(id)}`);
  }
  if (new Set(value).size !== value.length) fail(`${label} has duplicate provider IDs`);
};

// Key-order-independent equality for the immutability rules: a mutator that rebuilds an
// identical record in another key order has not changed it.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const sameRecord = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

const INIT_FIELDS = Object.freeze([
  "schemaVersion", "generation", "registryHash", "manifestHash", "rawBaseHash", "sourceLedgerRevision", "initializedAt",
]);

export const validateGenerationRegistryInitialized = (value, { ledgerRevision }) => {
  const label = "generationRegistryInitialized";
  exactKeys(value, INIT_FIELDS, label);
  if (value.schemaVersion !== 1) fail(`${label} schemaVersion must be 1`);
  if (value.generation !== 0) fail(`${label} generation must be 0`);
  requireHash(value.registryHash, `${label}.registryHash`);
  requireHash(value.manifestHash, `${label}.manifestHash`);
  requireHash(value.rawBaseHash, `${label}.rawBaseHash`);
  requireRevision(value.sourceLedgerRevision, `${label}.sourceLedgerRevision`, ledgerRevision);
  requireIso(value.initializedAt, `${label}.initializedAt`);
  return value;
};

const CUTOVER_FIELDS = Object.freeze([
  "schemaVersion", "mode", "target", "generation", "manifestHash", "registryHash", "rawBaseHash",
  "sourceLedgerRevision", "changedAt", "reason",
]);

// The valid-state table from the Package 4 spec. Only two shapes exist:
//   generated     -- non-negative generation, non-null manifestHash, initialization ack present;
//   raw-emergency -- null generation and manifestHash, ack present, raw/registry hashes retained.
// The target is compared as an exact string and never canonicalized first: an equivalent
// spelling of the approved path is a different, unapproved target.
export const validateConfigCutover = (value, { generationRegistryInitialized: init, ledgerRevision, targets }) => {
  const label = "configCutover";
  exactKeys(value, CUTOVER_FIELDS, label);
  if (value.schemaVersion !== 1) fail(`${label} schemaVersion must be 1`);
  if (!init) fail(`${label} requires a generationRegistryInitialized acknowledgement`);
  if (!CONFIG_CUTOVER_MODES.includes(value.mode)) fail(`${label} mode ${String(value.mode)} is invalid`);
  if (!CONFIG_CUTOVER_REASONS.includes(value.reason)) fail(`${label} reason ${String(value.reason)} is invalid`);
  const expectedTarget = value.mode === "generated" ? targets.generated : targets.rawEmergency;
  if (value.target !== expectedTarget) fail(`${label} target for mode ${value.mode} must be exactly ${expectedTarget}`);
  requireHash(value.registryHash, `${label}.registryHash`);
  requireHash(value.rawBaseHash, `${label}.rawBaseHash`);
  requireRevision(value.sourceLedgerRevision, `${label}.sourceLedgerRevision`, ledgerRevision);
  if (value.sourceLedgerRevision < init.sourceLedgerRevision) {
    fail(`${label} predates its generationRegistryInitialized acknowledgement`);
  }
  requireIso(value.changedAt, `${label}.changedAt`);
  if (value.mode === "raw-emergency") {
    if (value.generation !== null || value.manifestHash !== null) {
      fail(`${label} raw-emergency requires null generation and manifestHash`);
    }
    if (value.reason !== "emergency-rollback") fail(`${label} raw-emergency requires reason emergency-rollback`);
    return value;
  }
  requireCount(value.generation, `${label}.generation`);
  requireHash(value.manifestHash, `${label}.manifestHash`);
  if (value.reason === "emergency-rollback") fail(`${label} reason emergency-rollback requires mode raw-emergency`);
  if (value.reason === "bootstrap" && value.generation !== 0) fail(`${label} reason bootstrap requires generation 0`);
  // Generation 0 is immutable and acknowledged exactly once, so its manifest cannot differ.
  if (value.generation === 0 && value.manifestHash !== init.manifestHash) {
    fail(`${label} generation 0 does not match the generationRegistryInitialized acknowledgement`);
  }
  if (value.reason === "bootstrap" && value.rawBaseHash !== init.rawBaseHash) {
    fail(`${label} bootstrap rawBaseHash does not match the generationRegistryInitialized acknowledgement`);
  }
  return value;
};

const LEGACY_FIELDS = Object.freeze([
  "schemaVersion", "baselineCount", "baselineHash", "finalCount", "finalHash", "sourceLedgerRevision",
  "quiescedAt", "archivePath", "archiveHash",
]);

export const validateLegacyMigration = (value, { ledgerRevision }) => {
  const label = "legacyMigration";
  exactKeys(value, LEGACY_FIELDS, label);
  if (value.schemaVersion !== 1) fail(`${label} schemaVersion must be 1`);
  requireCount(value.baselineCount, `${label}.baselineCount`);
  requireHash(value.baselineHash, `${label}.baselineHash`);
  if (value.finalCount === null) {
    if (value.finalHash !== null) fail(`${label}.finalHash requires finalCount`);
  } else {
    requireCount(value.finalCount, `${label}.finalCount`);
    // The final key set is B + D: the import only ever adds keys to the baseline.
    if (value.finalCount < value.baselineCount) fail(`${label}.finalCount is below baselineCount`);
    requireHash(value.finalHash, `${label}.finalHash`);
  }
  // The baseline phase is written before the final import names its revision, so null is allowed
  // until finalCount is set (CONTRACT v2).
  if (value.sourceLedgerRevision !== null) {
    requireRevision(value.sourceLedgerRevision, `${label}.sourceLedgerRevision`, ledgerRevision);
  }
  if (value.finalCount !== null && value.sourceLedgerRevision === null) {
    fail(`${label}.sourceLedgerRevision is required once finalCount is set`);
  }
  if (value.quiescedAt !== null) requireIso(value.quiescedAt, `${label}.quiescedAt`);
  if (value.archivePath === null) {
    if (value.archiveHash !== null) fail(`${label}.archiveHash requires archivePath`);
  } else {
    if (typeof value.archivePath !== "string" || !isAbsolute(value.archivePath)
      || normalize(value.archivePath) !== value.archivePath) {
      fail(`${label}.archivePath must be a normalized absolute path`);
    }
    requireHash(value.archiveHash, `${label}.archiveHash`);
  }
  return value;
};

const STAGE_FIELDS = Object.freeze(["schemaVersion", "status", "prepared", "committed", "checkpoint", "gate"]);
const PREPARED_FIELDS = Object.freeze([
  "at", "allowlist", "ledgerRevision", "overlayHash", "effectiveHash", "baseHash", "manifestHash", "policyIntentHash",
]);
const COMMITTED_FIELDS = Object.freeze(["at", "generation", "manifestHash", "generationAck", "brokerAck", "ledgerAck"]);
const CHECKPOINT_FIELDS = Object.freeze(["generation", "manifestHash", "allowlist", "ledgerRevision", "brokerPolicyRevision"]);
const GATE_FIELDS = Object.freeze(["startedAt", "completedAt", "scheduledRunIDs", "evidence", "resetCount"]);

export const validateProviderStage = (providerID, value, { ledgerRevision }) => {
  if (typeof providerID !== "string" || !PROVIDER_ID.test(providerID)) {
    fail(`providerStages key ${String(providerID)} is not a valid provider ID`);
  }
  const label = `providerStages.${providerID}`;
  exactKeys(value, STAGE_FIELDS, label);
  if (value.schemaVersion !== 1) fail(`${label} schemaVersion must be 1`);
  if (!PROVIDER_STAGE_STATUSES.includes(value.status)) fail(`${label} status ${String(value.status)} is invalid`);
  const { prepared, committed, checkpoint, gate } = value;

  exactKeys(prepared, PREPARED_FIELDS, `${label}.prepared`);
  requireIso(prepared.at, `${label}.prepared.at`);
  requireProviderList(prepared.allowlist, `${label}.prepared.allowlist`);
  if (!prepared.allowlist.includes(providerID)) fail(`${label}.prepared.allowlist must include ${providerID}`);
  requireRevision(prepared.ledgerRevision, `${label}.prepared.ledgerRevision`, ledgerRevision);
  for (const field of ["overlayHash", "effectiveHash", "baseHash", "policyIntentHash"]) {
    requireHash(prepared[field], `${label}.prepared.${field}`);
  }
  // A prepare that has not published a generation yet has no manifest to name.
  if (prepared.manifestHash !== null) requireHash(prepared.manifestHash, `${label}.prepared.manifestHash`);

  if (committed !== null) {
    exactKeys(committed, COMMITTED_FIELDS, `${label}.committed`);
    requireIso(committed.at, `${label}.committed.at`);
    requireCount(committed.generation, `${label}.committed.generation`);
    requireHash(committed.manifestHash, `${label}.committed.manifestHash`);
    if (!isPlainObject(committed.generationAck)
      || committed.generationAck.generation !== committed.generation
      || committed.generationAck.manifestHash !== committed.manifestHash) {
      fail(`${label}.committed.generationAck does not match committed generation ${committed.generation}`);
    }
    // brokerAck is null when the stage changed no broker policy (spec: "when policy changes").
    if (committed.brokerAck !== null && !isPlainObject(committed.brokerAck)) {
      fail(`${label}.committed.brokerAck must be an object or null`);
    }
    if (!isPlainObject(committed.ledgerAck)) fail(`${label}.committed.ledgerAck must be an object`);
  }

  if (checkpoint !== null) {
    exactKeys(checkpoint, CHECKPOINT_FIELDS, `${label}.checkpoint`);
    requireCount(checkpoint.generation, `${label}.checkpoint.generation`);
    requireHash(checkpoint.manifestHash, `${label}.checkpoint.manifestHash`);
    requireProviderList(checkpoint.allowlist, `${label}.checkpoint.allowlist`);
    requireRevision(checkpoint.ledgerRevision, `${label}.checkpoint.ledgerRevision`, ledgerRevision);
    const policy = checkpoint.brokerPolicyRevision;
    if (policy !== null && !isCount(policy) && !(typeof policy === "string" && policy.length > 0)) {
      fail(`${label}.checkpoint.brokerPolicyRevision must be null, a non-negative integer or a non-empty string`);
    }
  }

  if (gate !== null) {
    exactKeys(gate, GATE_FIELDS, `${label}.gate`);
    if (gate.startedAt !== null) requireIso(gate.startedAt, `${label}.gate.startedAt`);
    if (gate.completedAt !== null) {
      requireIso(gate.completedAt, `${label}.gate.completedAt`);
      if (gate.startedAt === null) fail(`${label}.gate.completedAt requires gate.startedAt`);
      if (Date.parse(gate.completedAt) < Date.parse(gate.startedAt)) fail(`${label}.gate.completedAt precedes gate.startedAt`);
    }
    if (!Array.isArray(gate.scheduledRunIDs) || gate.scheduledRunIDs.some((id) => typeof id !== "string" || !RUN_ID.test(id))) {
      fail(`${label}.gate.scheduledRunIDs must be an array of run IDs`);
    }
    if (new Set(gate.scheduledRunIDs).size !== gate.scheduledRunIDs.length) {
      fail(`${label}.gate.scheduledRunIDs has duplicate run IDs`);
    }
    if (!Array.isArray(gate.evidence) || gate.evidence.some((entry) => !isPlainObject(entry))) {
      fail(`${label}.gate.evidence must be an array of objects`);
    }
    requireCount(gate.resetCount, `${label}.gate.resetCount`);
  }

  // Status consistency. failed and rolled-back can stop anywhere in the saga, so they carry
  // whatever evidence existed when they stopped and are not constrained further here.
  switch (value.status) {
    case "prepared":
      if (committed !== null) fail(`${label} status prepared cannot carry committed evidence`);
      // A prepared stage MAY carry a gate whose completedAt is null; re-preparing after a failed
      // gate keeps resetCount history.
      if (gate !== null && gate.startedAt === null) fail(`${label} status prepared requires a gate with startedAt set`);
      break;
    case "committed":
      if (committed === null || checkpoint === null) fail(`${label} status committed requires committed and checkpoint`);
      break;
    case "gate-running":
      if (committed === null || checkpoint === null) fail(`${label} status gate-running requires committed and checkpoint`);
      if (gate === null || gate.startedAt === null || gate.completedAt !== null) {
        fail(`${label} status gate-running requires a started, uncompleted gate`);
      }
      break;
    case "healthy":
      if (committed === null || checkpoint === null) fail(`${label} status healthy requires committed and checkpoint`);
      if (gate === null || gate.completedAt === null) fail(`${label} status healthy requires a completed gate`);
      break;
    default:
      break;
  }
  return value;
};

const RUN_FIELDS = Object.freeze(["id", "startedAt", "endedAt", "ok", "mode", "providers", "ledgerRevision", "exitCode"]);

export const validateScheduledRuns = (runs, { ledgerRevision }) => {
  if (!Array.isArray(runs)) fail("reconciliation state field scheduledRuns is not an array");
  if (runs.length > SCHEDULED_RUNS_LIMIT) {
    fail(`scheduledRuns holds ${runs.length} entries; the limit is ${SCHEDULED_RUNS_LIMIT}`);
  }
  const seen = new Set();
  runs.forEach((run, index) => {
    const label = `scheduledRuns[${index}]`;
    exactKeys(run, RUN_FIELDS, label);
    if (typeof run.id !== "string" || !RUN_ID.test(run.id)) fail(`${label}.id is invalid`);
    if (seen.has(run.id)) fail(`scheduledRuns has duplicate id ${run.id}`);
    seen.add(run.id);
    requireIso(run.startedAt, `${label}.startedAt`);
    // A run still in flight has neither; a finished run has both.
    if ((run.endedAt === null) !== (run.exitCode === null)) {
      fail(`${label}.endedAt and exitCode must both be null or both be set`);
    }
    if (run.endedAt !== null) requireIso(run.endedAt, `${label}.endedAt`);
    if (run.exitCode !== null && !(Number.isInteger(run.exitCode) && run.exitCode >= 0 && run.exitCode <= 255)) {
      fail(`${label}.exitCode must be an integer from 0 to 255`);
    }
    if (typeof run.ok !== "boolean") fail(`${label}.ok must be a boolean`);
    if (!SCHEDULED_RUN_MODES.includes(run.mode)) fail(`${label}.mode ${String(run.mode)} is invalid`);
    requireProviderList(run.providers, `${label}.providers`);
    requireRevision(run.ledgerRevision, `${label}.ledgerRevision`, ledgerRevision);
  });
  return runs;
};

// Appends one run and keeps the newest SCHEDULED_RUNS_LIMIT, oldest first. Returns a new array
// and never mutates its input; the store validates the result when it is written.
export const appendScheduledRun = (runs, run) => {
  if (!Array.isArray(runs)) fail("scheduledRuns must be an array");
  return [...runs, run].slice(-SCHEDULED_RUNS_LIMIT);
};

// The one explicit v1 -> v2 step. Strict: a v1 file with a key v1 never defined is a different
// writer's schema, and silently carrying it forward would lose what it meant, so it fails closed.
export const migrateReconciliationState = (value) => {
  if (!isPlainObject(value) || value.version !== 1) return value;
  for (const key of Object.keys(value)) {
    if (!V1_STATE_FIELDS.includes(key)) fail(`unknown reconciliation state v1 field ${key}`);
  }
  for (const key of V1_STATE_FIELDS) {
    if (!Object.hasOwn(value, key)) fail(`reconciliation state v1 is missing field ${key}`);
  }
  return { ...value, version: RECONCILIATION_STATE_VERSION, revision: 0, providerStages: {}, scheduledRuns: [] };
};

const validateState = (value, targets) => {
  if (!isPlainObject(value)) fail("reconciliation state is not an object");
  for (const key of Object.keys(value)) {
    if (!STATE_FIELDS.includes(key)) fail(`unknown reconciliation state field ${key}`);
  }
  if (value.version !== RECONCILIATION_STATE_VERSION) {
    fail(`unsupported reconciliation state version ${String(value.version)}`);
  }
  if (!Number.isFinite(value.updatedAt) || value.updatedAt < 0) {
    fail(`reconciliation state has an invalid updatedAt ${String(value.updatedAt)}`);
  }
  if (!isCount(value.revision)) fail(`reconciliation state has an invalid revision ${String(value.revision)}`);
  for (const field of MAP_FIELDS) {
    if (!isPlainObject(value[field])) fail(`reconciliation state field ${field} is not an object`);
  }
  const ledgerRevision = value.revision;
  validateScheduledRuns(value.scheduledRuns, { ledgerRevision });
  const init = value.generationRegistryInitialized;
  if (init !== undefined) validateGenerationRegistryInitialized(init, { ledgerRevision });
  if (value.configCutover !== undefined) {
    validateConfigCutover(value.configCutover, { generationRegistryInitialized: init, ledgerRevision, targets });
  }
  if (value.legacyMigration !== undefined) validateLegacyMigration(value.legacyMigration, { ledgerRevision });
  for (const [providerID, stage] of Object.entries(value.providerStages)) {
    validateProviderStage(providerID, stage, { ledgerRevision });
  }
  return value;
};

// A mutator may express "not recorded" as null or by omitting the key; on disk it is always
// omission, so there is one representation and the transition rules see removal as removal.
const dropAbsentRecords = (value) => {
  const next = { ...value };
  for (const field of OPTIONAL_RECORDS) {
    if (next[field] === null || next[field] === undefined) delete next[field];
  }
  return next;
};

// Rules that need the PREVIOUS state, so they live here rather than in validateState:
//   - generationRegistryInitialized is written exactly once: never changed, deleted or nulled;
//   - a newly written generationRegistryInitialized, and a newly written or changed
//     configCutover, cite the very mutation that writes them (spec: "supplied by the enclosing
//     ledger mutation acknowledgement"); update() hands that revision to the mutator;
//   - configCutover and legacyMigration are never removed once written;
//   - legacyMigration's baseline is immutable once recorded.
const validateTransition = (current, next) => {
  const priorInit = current.generationRegistryInitialized;
  const nextInit = next.generationRegistryInitialized;
  if (priorInit !== undefined && (nextInit === undefined || !sameRecord(priorInit, nextInit))) {
    fail("generationRegistryInitialized is immutable once written");
  }
  if (priorInit === undefined && nextInit !== undefined && nextInit.sourceLedgerRevision !== next.revision) {
    fail(`generationRegistryInitialized.sourceLedgerRevision must be the enclosing ledger revision ${next.revision}`);
  }
  if (current.configCutover !== undefined && next.configCutover === undefined) {
    fail("configCutover cannot be removed once written");
  }
  if (next.configCutover !== undefined
    && (current.configCutover === undefined || !sameRecord(current.configCutover, next.configCutover))
    && next.configCutover.sourceLedgerRevision !== next.revision) {
    fail(`configCutover.sourceLedgerRevision must be the enclosing ledger revision ${next.revision}`);
  }
  if (current.legacyMigration !== undefined) {
    if (next.legacyMigration === undefined) fail("legacyMigration cannot be removed once written");
    if (next.legacyMigration.baselineCount !== current.legacyMigration.baselineCount
      || next.legacyMigration.baselineHash !== current.legacyMigration.baselineHash) {
      fail("legacyMigration baseline is immutable once recorded");
    }
  }
};

const readStateFile = (path, targets) => {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Never repaired or replaced: a half-written or hand-edited ledger is an operator problem,
    // and overwriting it would destroy the only record of what was already decided.
    throw new Error(`${path} is not valid reconciliation state JSON`, { cause: error });
  }
  return validateState(migrateReconciliationState(parsed), targets);
};
```

4e. Replace lines 488-513 (the whole `createReconciliationStore` function, keeping the comment block above it at 480-487) with:

```js
// `configTargets` fixes the two exact outer-link targets configCutover may name. The generated
// target defaults to <root>/resolver-generations/current/opencode.json (the Package 3 generations
// root is a direct child of the routing state root); the raw target defaults to the canonical
// devbox raw base, overridable by OPENCODE_RECONCILE_RAW_BASE for fixture trees. Every process
// reading one ledger must agree on both, or its reads fail closed.
export const createReconciliationStore = ({ root = routingStateDir(), now = Date.now, pid = process.pid, lockWaitMs = DEFAULT_LOCK_WAIT_MS, onWarning = defaultOnWarning, fsyncDir = fsyncDirectory, chmodLockDir = chmodSync, configTargets = {} } = {}) => {
  const warn = nonThrowingWarning(onWarning);
  const statePath = join(root, STATE_NAME);
  const lockPath = join(root, LOCK_NAME);
  const targets = Object.freeze({
    generated: configTargets.generated ?? join(root, "resolver-generations", "current", "opencode.json"),
    rawEmergency: configTargets.rawEmergency ?? (process.env.OPENCODE_RECONCILE_RAW_BASE || DEFAULT_RAW_BASE_PATH),
  });
  for (const [name, target] of Object.entries(targets)) {
    if (typeof target !== "string" || !isAbsolute(target)) fail(`config target ${name} must be an absolute path`);
  }
  const paths = () => ({ state: statePath, lock: lockPath, reviewed: join(root, REVIEWED_NAME) });
  // An absent ledger is a legitimate state, not an error: nothing has been reconciled yet.
  // Callers that must distinguish "absent" from "empty" stat paths().state themselves.
  const read = () => readStateFile(statePath, targets) ?? emptyReconciliationState();
  const update = (mutator) => {
    if (typeof mutator !== "function") throw new Error("reconciliation state update needs a mutator function");
    const release = acquire(root, lockPath, lockWaitMs, pid, warn, chmodLockDir);
    try {
      const current = readStateFile(statePath, targets) ?? emptyReconciliationState();
      const revision = current.revision + 1;
      // The mutator gets a detached copy, so an in-place edit it then discards cannot reach
      // the file: what is written is exactly what it returns. It also gets the revision this
      // write will carry, so a record that must cite its enclosing mutation can do so.
      const proposed = mutator(structuredClone(current), { revision });
      if (!isPlainObject(proposed)) throw new Error("reconciliation state update must return the next state object");
      const next = validateState(dropAbsentRecords({
        ...proposed, version: RECONCILIATION_STATE_VERSION, updatedAt: now(), revision,
      }), targets);
      validateTransition(current, next);
      writeStateFile(root, statePath, next, pid, warn, fsyncDir);
      return structuredClone(next);
    } finally {
      release();
    }
  };
  return { read, update, paths, configTargets: () => ({ ...targets }) };
};
```

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `node --experimental-test-module-mocks --test tests/reconcile-state-v2.test.mjs tests/reconcile-state.test.mjs tests/model-reconcile.test.mjs tests/reconcile-cli.test.mjs`
Expected: PASS. Every test in all four files passes and the command exits 0.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, exit 0. Every caller found by grepping `lib/` for `store.update(` returns `{ ...state, ... }` or `{ ...current, ... }`, so the new keys survive their writes:
- `lib/model-reconcile.js:1013`
- `lib/reconcile-evidence.js:411,433,472`
- `lib/reconcile-notify.js:254`
- `lib/reconcile-gitea.js:321,729`
- `lib/reconcile-apply.js:45`

If a test asserts the ledger `version` or the exact top-level ledger keys and is not listed in Step 3, it is a real v2 consequence. Update that assertion to v2 in this task and add its path to the commit. Do not weaken the schema.

- [ ] **Step 7: Commit**

```bash
git add lib/reconcile-state.js tests/reconcile-state-v2.test.mjs tests/reconcile-state.test.mjs tests/model-reconcile.test.mjs tests/reconcile-cli.test.mjs
git commit -m "feat(reconcile): ledger schema v2 with strict v1 migration and Package 4 records"
```

### Task B3: Provider allowlist filtering in the reconciliation applier

**Files:**
- Modify: `lib/reconcile-apply.js`. Add the exports after `incompleteRecord` (line 17). Add the allowlist normalizer before `createReconciliationApplier` (line 297). Change the factory options and the post-dependency check (lines 297-313). Change the `ensureGeneration` overlay build (line 543). Change `apply` (lines 806-820), and rewrite `recover` (lines 822-840) and `refresh` (lines 889-910). Change the return value (line 912).
- Modify: `bin/opencode-broker-reconcile`. Change the import at line 41 and the `createApplyRuntime` applier construction (lines 383-390).
- Modify: `tests/helpers/model-reconcile-runtime.mjs`. Change the `createReconciliationApplier` call (lines 539-547).
- Test: `tests/reconcile-apply.test.mjs`. Change the import at line 5, the `makeFixture` options and `applier` factory (lines 141-150 and 440-461), and the recover-all assertion at line 508. Append the new tests at the end of the file.
- Test: `tests/reconcile-cli.test.mjs` (raw-base default pin test)

**Why the overlay must be filtered as well as the transition list:** `buildResolverOverlay` (`lib/reconcile-overlay.js:360-388`) renders every ledger record in an authorized state (`approved` or `auto-eligible`). It does not limit itself to the transition being applied. `validateResolverOverlay` (lines 307-339) then runs `checkedRecord` on every ledger record and requires every authorized record to be present in the overlay. If only `refresh` and `recover` were filtered, applying an `openai` transition while an approved `anthropic` record sits in the ledger would do one of two things:
- publish the Anthropic model into the OpenAI stage's generation, or
- fail the OpenAI apply on the Anthropic record's missing role or catalog entry.

So the applier gives the overlay renderer a view of the ledger that is limited to the allowlist. An excluded record stays in that view only if the prior overlay already carries its `transitionID`. Those entries are append-only history from a time when the provider was allowlisted, and removing them would trip the "orphaned from the ledger" check.

**Decisions this task fixes:**
- **"Excluded" means unchanged and reported.** "Durable" means the ledger record is left byte-for-byte unchanged. Its state is not reset or blocked, and it is not deleted, so a provider that is allowlisted later can still apply it. "Visible" means every `apply`, `recover` and `refresh` result reports it as `{ transitionID, providerID, state, reason: "provider-not-allowlisted" }`. No new ledger field is written, because Task B2's strict v2 schema defines none.
- **Rollback is not filtered.** A provider that Task B8 removes from the allowlist must still be rollable back.
- **Only a well-formed provider ID outside the allowlist counts as excluded.** If a record's `providerID` is not a string, the record is corrupt, not excluded. It still flows into `drive()` and into the overlay renderer, where the existing identity checks fail loudly.
- **Provider IDs are checked against a slug pattern.** The pattern is `/^[a-z0-9][a-z0-9-]{0,99}$/`, the same as the providerID half of a model-role key (`lib/model-roles.js:30`).

**Interfaces:**
- Consumes:
  - From Task B1 (`lib/config.js`):
    - `CONFIG.reconcile.apply.providers: string[]`. When `enabled=true` this is nonempty, duplicate-free, and every entry is a member of `CONFIG.trustedSubscriptionProviders`.
    - `CONFIG.trustedSubscriptionProviders: string[]`.
    - B1 has also already added `providers` to the enabled-apply test fixtures, because its validation would otherwise throw. B3 does not edit those config blocks.
  - Existing code:
    - `createReconciliationApplier({ store, overlayStore, generationManager, brokerRequest, probeClientFactory, collectSources, now })`
    - `buildResolverOverlay({ ledger, modelRoles, catalogModels, introductionGeneration, overlayUpdatedAt, previous })`
    - `makeFixture(...)` in `tests/reconcile-apply.test.mjs`
- Produces (Task B8 relies on these):
  - `export const PROVIDER_NOT_ALLOWLISTED = "provider-not-allowlisted"`
  - `export const applyProviderOptionsFromConfig = (config) => ({ providers: config?.reconcile?.apply?.providers, trustedProviders: config?.trustedSubscriptionProviders })`. This is a pure mapping; the applier does the validation.
  - `createReconciliationApplier({ ...existing, providers: string[], trustedProviders: string[] })` throws `Error` at construction for any of these:
    - `trustedProviders` is not an array: `reconciliation applier needs the trustedSubscriptionProviders list`
    - `providers` is missing, empty or not an array: `reconciliation applier needs a nonempty reconcile.apply.providers allowlist`
    - an entry does not match the slug pattern: `reconciliation applier provider "<id>" is not a valid provider ID`
    - an entry appears twice: `... provider "<id>" is listed twice`
    - an entry is not trusted: `... provider "<id>" is not a trusted subscription provider` (this is the RF4 pin)
  - The applier returns `{ apply, rollback, refresh, recover, providers }`. `providers` is a frozen copy of the allowlist; Task B8 records it as `scheduledRuns[].providers`.
  - `ExclusionEntry = { transitionID: string, providerID: string, state: string|null, reason: "provider-not-allowlisted" }`.
  - `apply({ transitionID, dryRun })` and `recover({ transitionID, dryRun })` on an excluded transition return `{ ok: false, dryRun: boolean, mutated: false, ...ExclusionEntry }`. Sources are still collected once (read-only). There is no ledger write and no overlay, generation, broker or probe call.
  - `refresh({ dryRun })` returns `{ ok, dryRun: true, mutated: false, transitions, excluded }` for a dry run and `{ ok, mutated, results, excluded }` otherwise. `recover()` with no ID returns the same shapes; both carry `excluded: ExclusionEntry[]`, sorted by transitionID.
  - `rollback(...)` is not changed.
  - Task B8's scheduled-run and its per-provider prepare/commit must reach transitions only through `apply`, `refresh` or `recover` on an applier built with `applyProviderOptionsFromConfig(CONFIG)`. There is no other scheduled entry point that drives transitions.

- [ ] **Step 1: Write the failing tests**

In `tests/reconcile-apply.test.mjs`, replace line 5:

```js
import { createReconciliationApplier } from "../lib/reconcile-apply.js";
```

with:

```js
import {
  PROVIDER_NOT_ALLOWLISTED,
  applyProviderOptionsFromConfig,
  createReconciliationApplier,
} from "../lib/reconcile-apply.js";
```

In `makeFixture`, replace the options tail (lines 149-150):

```js
  sourceOverrides = {},
} = {}) => {
```

with:

```js
  sourceOverrides = {},
  providers = ["openai"],
  trustedProviders = ["openai"],
} = {}) => {
```

Replace the `applier` factory and the start of the returned object (lines 440-451):

```js
  const applier = () => createReconciliationApplier({
    store,
    overlayStore,
    generationManager,
    brokerRequest,
    probeClientFactory,
    collectSources,
    now: () => NOW,
  });
  return {
    applier,
    events,
```

with:

```js
  const applier = (overrides = {}) => createReconciliationApplier({
    store,
    overlayStore,
    generationManager,
    brokerRequest,
    probeClientFactory,
    collectSources,
    now: () => NOW,
    providers,
    trustedProviders,
    ...overrides,
  });
  return {
    applier,
    overlay: () => clone(overlay),
    events,
```

Replace line 508. `recover()` with no ID now always reports its exclusions:

```js
  assert.deepEqual(result, { ok: true, mutated: false, results: [] });
```

with:

```js
  assert.deepEqual(result, { ok: true, mutated: false, results: [], excluded: [] });
```

Append to the end of the file:

```js
const ANTHROPIC_TRANSITION_ID = "f0e1d2c3b4a5968778695a4b";
const ANTHROPIC_ROLE = "anthropic:claude-opus";

const anthropicRecord = (overrides = {}) => approvedRecord({
  transitionID: ANTHROPIC_TRANSITION_ID,
  roleKey: ANTHROPIC_ROLE,
  providerID: "anthropic",
  roleID: "claude-opus",
  candidateModelID: "claude-opus-5-5",
  candidateFamily: "claude-opus",
  candidateVersion: "5.5",
  incumbentModelID: "claude-opus-4-8",
  ...overrides,
});

// The OpenAI record stays under ROLE so the fixture's ledger-event classifier keeps working. The
// Anthropic record deliberately has no model role or catalog entry in the fixture sources: any path
// that lets it reach the overlay renderer fails, which is exactly the leak this task closes.
const twoProviderState = (anthropic = anthropicRecord()) => ({
  ...initialState(),
  roles: { [ROLE]: approvedRecord(), [ANTHROPIC_ROLE]: anthropic },
});

const anthropicExclusion = (state) => ({
  transitionID: ANTHROPIC_TRANSITION_ID,
  providerID: "anthropic",
  state,
  reason: "provider-not-allowlisted",
});

test("the exclusion reason is the literal provider-not-allowlisted", () => {
  assert.equal(PROVIDER_NOT_ALLOWLISTED, "provider-not-allowlisted");
});

test("applier provider options come from reconcile.apply.providers and trustedSubscriptionProviders", () => {
  assert.deepEqual(applyProviderOptionsFromConfig({
    trustedSubscriptionProviders: ["alibaba-token-plan", "anthropic", "openai"],
    reconcile: { apply: { enabled: true, providers: ["openai"] } },
  }), { providers: ["openai"], trustedProviders: ["alibaba-token-plan", "anthropic", "openai"] });
  assert.deepEqual(applyProviderOptionsFromConfig({}), { providers: undefined, trustedProviders: undefined });
});

test("RF4: an applier whose allowlist names a no-longer-trusted provider refuses to construct", () => {
  const fixture = makeFixture({ state: twoProviderState() });
  const before = fixture.state();
  assert.throws(
    () => fixture.applier({ providers: ["openai", "anthropic"], trustedProviders: ["openai"] }),
    /reconciliation applier provider "anthropic" is not a trusted subscription provider/,
  );
  assert.deepEqual(fixture.state(), before);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.counts.sourceCollections, 0);
});

test("the applier refuses a missing, empty, duplicated or malformed provider allowlist", () => {
  const fixture = makeFixture();
  const cases = [
    [{ providers: undefined }, /needs a nonempty reconcile\.apply\.providers allowlist/],
    [{ providers: [] }, /needs a nonempty reconcile\.apply\.providers allowlist/],
    [{ providers: "openai" }, /needs a nonempty reconcile\.apply\.providers allowlist/],
    [{ providers: ["openai", "openai"] }, /provider "openai" is listed twice/],
    [{ providers: ["OpenAI"], trustedProviders: ["OpenAI"] }, /provider "OpenAI" is not a valid provider ID/],
    [{ providers: [""] }, /provider "" is not a valid provider ID/],
    [{ trustedProviders: undefined }, /needs the trustedSubscriptionProviders list/],
  ];
  for (const [options, pattern] of cases) {
    assert.throws(() => fixture.applier(options), pattern, JSON.stringify(options));
  }
  assert.equal(fixture.counts.sourceCollections, 0);
});

test("refresh drives only allowlisted providers and reports the rest without touching them", async () => {
  const dry = await makeFixture({ state: twoProviderState() }).applier().refresh({ dryRun: true });
  assert.deepEqual(dry, {
    ok: true, dryRun: true, mutated: false,
    transitions: [TRANSITION_ID],
    excluded: [anthropicExclusion("approved")],
  });

  const fixture = makeFixture({ state: twoProviderState() });
  const seeded = fixture.state().roles[ANTHROPIC_ROLE];
  const result = await fixture.applier().refresh();
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((entry) => entry.transitionID), [TRANSITION_ID]);
  assert.deepEqual(result.excluded, [anthropicExclusion("approved")]);
  assert.deepEqual(fixture.state().roles[ANTHROPIC_ROLE], seeded);
  assert.equal(fixture.state().roles[ROLE].state, "probation");
  // The generation rendered for the OpenAI stage carries no Anthropic model.
  assert.deepEqual(Object.keys(fixture.overlay().entries), [`openai/${CANDIDATE_MODEL_ID}`]);
  assert.deepEqual(fixture.openCalls.map((call) => call.candidateIdentity.providerID), ["openai"]);
});

test("recover leaves an in-flight transition of a non-allowlisted provider durable and reports it", async () => {
  const inFlight = anthropicRecord({
    state: "probing",
    transitions: ["discovered", "awaiting-approval", "approved", "probing"],
    applyIntent: { transitionID: ANTHROPIC_TRANSITION_ID, revision: "f".repeat(64) },
  });
  const fixture = makeFixture({ state: twoProviderState(inFlight) });
  const before = fixture.state();

  const all = await fixture.applier().recover();
  assert.deepEqual(all, { ok: true, mutated: false, results: [], excluded: [anthropicExclusion("probing")] });
  assert.deepEqual(fixture.state(), before);

  const single = await fixture.applier().recover({ transitionID: ANTHROPIC_TRANSITION_ID });
  assert.deepEqual(single, { ok: false, dryRun: false, mutated: false, ...anthropicExclusion("probing") });
  assert.deepEqual(fixture.state(), before);
  assert.equal(fixture.counts.brokerChanges, 0);
  assert.equal(fixture.counts.overlayChanges, 0);
  assert.equal(fixture.counts.generationBuilds, 0);
  assert.equal(fixture.counts.probeLaunches, 0);
});

test("a provider removed from the allowlist can still be rolled back but is never driven forward", async () => {
  const fixture = makeFixture();
  await fixture.applier().apply({ transitionID: TRANSITION_ID });
  const narrowed = { providers: ["anthropic"], trustedProviders: ["anthropic", "openai"] };
  const before = fixture.state();
  const brokerChanges = fixture.counts.brokerChanges;

  const exclusion = {
    transitionID: TRANSITION_ID, providerID: "openai", state: "probation", reason: "provider-not-allowlisted",
  };
  assert.deepEqual(await fixture.applier(narrowed).apply({ transitionID: TRANSITION_ID }),
    { ok: false, dryRun: false, mutated: false, ...exclusion });
  assert.deepEqual(await fixture.applier(narrowed).apply({ transitionID: TRANSITION_ID, dryRun: true }),
    { ok: false, dryRun: true, mutated: false, ...exclusion });
  assert.deepEqual(await fixture.applier(narrowed).recover({ transitionID: TRANSITION_ID }),
    { ok: false, dryRun: false, mutated: false, ...exclusion });
  assert.deepEqual(fixture.state(), before);
  assert.equal(fixture.counts.brokerChanges, brokerChanges);

  const rolledBack = await fixture.applier(narrowed).rollback({
    transitionID: TRANSITION_ID,
    reason: "provider-stage-failed",
  });
  assert.equal(rolledBack.ok, true);
  assert.equal(rolledBack.mutated, true);
  assert.equal(fixture.state().roles[ROLE].state, "rolled-back");
  assert.equal(fixture.policy().activeModelID, INCUMBENT_MODEL_ID);
});

test("the applier exposes its frozen allowlist for scheduled-run bookkeeping", () => {
  const applier = makeFixture({ providers: ["openai"], trustedProviders: ["anthropic", "openai"] }).applier();
  assert.deepEqual(applier.providers, ["openai"]);
  assert.equal(Object.isFrozen(applier.providers), true);
});
```

- [ ] **Step 2: Run the tests to confirm the file fails to load**

Run: `node --experimental-test-module-mocks --test tests/reconcile-apply.test.mjs`
Expected: FAIL. The file aborts with `SyntaxError: The requested module '../lib/reconcile-apply.js' does not provide an export named 'PROVIDER_NOT_ALLOWLISTED'`.

- [ ] **Step 3: Add only the two exports, so the behaviour failures show**

In `lib/reconcile-apply.js`, insert this after line 17 (the end of `incompleteRecord`):

```js

// Reason recorded for a transition whose provider is outside reconcile.apply.providers. Exported so
// the CLI, scheduled-run and tests all compare against one spelling.
export const PROVIDER_NOT_ALLOWLISTED = "provider-not-allowlisted";
// Same slug grammar as the providerID half of a model-role key (lib/model-roles.js KEY_PART).
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

// Pure mapping from the validated broker config; createReconciliationApplier owns the checks so a
// caller that bypasses lib/config.js (tests, Task B8 stage commands) cannot skip them.
export const applyProviderOptionsFromConfig = (config) => ({
  providers: config?.reconcile?.apply?.providers,
  trustedProviders: config?.trustedSubscriptionProviders,
});
```

Run: `node --experimental-test-module-mocks --test tests/reconcile-apply.test.mjs`
Expected: FAIL. The two export tests pass. These fail:
- `RF4: an applier whose allowlist names a no-longer-trusted provider refuses to construct`: `Missing expected exception`.
- `the applier refuses a missing, empty, duplicated or malformed provider allowlist`: `Missing expected exception`.
- `refresh drives only allowlisted providers ...`: rejected with `resolver overlay role mismatch for anthropic/claude-opus-5-5`. In the dry-run case, it may instead fail on `catalog is missing exact candidate anthropic/claude-opus-5-5`.
- `recover leaves an in-flight transition ...`: rejected with `apply intent is missing the ordinary probe model`.
- `a provider removed from the allowlist ...`: `deepEqual` failure, because the actual value has `ok: true`.
- `the applier exposes its frozen allowlist ...`: `undefined` is not `["openai"]`.
- `recover-all skips completed probation transitions`: `deepEqual` failure on the missing `excluded: []`.

- [ ] **Step 4: Add allowlist validation and filtering to the applier**

In `lib/reconcile-apply.js`, insert this before `export const createReconciliationApplier = ({` (line 297):

```js
const normalizeProviderAllowlist = (providers, trustedProviders) => {
  if (!Array.isArray(trustedProviders)) {
    throw new Error("reconciliation applier needs the trustedSubscriptionProviders list");
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("reconciliation applier needs a nonempty reconcile.apply.providers allowlist");
  }
  const trusted = new Set(trustedProviders);
  const seen = new Set();
  for (const providerID of providers) {
    const label = JSON.stringify(providerID);
    if (typeof providerID !== "string" || !PROVIDER_ID.test(providerID)) {
      throw new Error(`reconciliation applier provider ${label} is not a valid provider ID`);
    }
    if (seen.has(providerID)) throw new Error(`reconciliation applier provider ${label} is listed twice`);
    // RF4: trust can be withdrawn while a provider is still allowlisted. Refuse to exist rather than
    // drive a provider whose subscription attestation is gone.
    if (!trusted.has(providerID)) {
      throw new Error(`reconciliation applier provider ${label} is not a trusted subscription provider`);
    }
    seen.add(providerID);
  }
  return Object.freeze([...providers]);
};

```

Replace the factory head and dependency check (lines 297-313):

```js
export const createReconciliationApplier = ({
  store,
  overlayStore,
  generationManager,
  brokerRequest,
  probeClientFactory,
  collectSources,
  now = Date.now,
} = {}) => {
  if (typeof store?.read !== "function" || typeof store?.update !== "function"
    || typeof overlayStore?.read !== "function" || typeof overlayStore?.write !== "function"
    || typeof generationManager?.readRegistry !== "function" || typeof generationManager?.build !== "function"
    || typeof generationManager?.publish !== "function" || typeof generationManager?.generation !== "function"
    || typeof brokerRequest !== "function" || typeof probeClientFactory?.open !== "function"
    || typeof collectSources !== "function" || typeof now !== "function") {
    throw new Error("reconciliation applier dependencies are incomplete");
  }
```

with:

```js
export const createReconciliationApplier = ({
  store,
  overlayStore,
  generationManager,
  brokerRequest,
  probeClientFactory,
  collectSources,
  now = Date.now,
  providers,
  trustedProviders,
} = {}) => {
  if (typeof store?.read !== "function" || typeof store?.update !== "function"
    || typeof overlayStore?.read !== "function" || typeof overlayStore?.write !== "function"
    || typeof generationManager?.readRegistry !== "function" || typeof generationManager?.build !== "function"
    || typeof generationManager?.publish !== "function" || typeof generationManager?.generation !== "function"
    || typeof brokerRequest !== "function" || typeof probeClientFactory?.open !== "function"
    || typeof collectSources !== "function" || typeof now !== "function") {
    throw new Error("reconciliation applier dependencies are incomplete");
  }
  const allowlist = normalizeProviderAllowlist(providers, trustedProviders);
  const allowed = new Set(allowlist);

  // CRITICAL: ONLY A STRING providerID OUTSIDE THE ALLOWLIST IS EXCLUDED. A record with no usable
  // providerID is corrupt, not excluded: it keeps flowing into drive() and the overlay renderer so
  // their identity checks fail loudly instead of filing it quietly under provider-not-allowlisted.
  const isExcluded = (record) => typeof record?.providerID === "string" && !allowed.has(record.providerID);
  const exclusion = (record) => ({
    transitionID: record.transitionID,
    providerID: record.providerID,
    state: record.state ?? null,
    reason: PROVIDER_NOT_ALLOWLISTED,
  });
  // Excluded transitions are never written: the ledger record stays byte-identical so the provider
  // can be staged later, and every result names it so the exclusion is visible to the operator.
  const exclusionResult = (record, dryRun) => ({ ok: false, dryRun, mutated: false, ...exclusion(record) });
  const partition = (records) => {
    const transitions = [];
    const excluded = [];
    for (const record of records) {
      if (isExcluded(record)) excluded.push(exclusion(record));
      else transitions.push(record.transitionID);
    }
    transitions.sort();
    excluded.sort((left, right) => (left.transitionID < right.transitionID ? -1
      : left.transitionID > right.transitionID ? 1 : 0));
    return { transitions, excluded };
  };
  // CRITICAL: buildResolverOverlay renders EVERY authorized ledger record, not just the transition
  // being applied, so the raw ledger would publish an excluded provider's approved model into this
  // stage's generation. An excluded record stays in the view only when the prior overlay already
  // carries its transition (append-only history from when that provider was allowlisted), because
  // validateResolverOverlay rejects an overlay entry orphaned from its ledger record. Non-object
  // shapes pass through untouched so the renderer's own corruption checks still fire.
  const overlayLedgerView = (ledger, previous) => {
    if (!plainObject(ledger)) return ledger;
    const carried = new Set(Object.values(plainObject(previous?.entries) ? previous.entries : {})
      .map((entry) => entry?.transitionID));
    const view = { ...ledger };
    for (const field of ["roles", "unknown"]) {
      const records = ledger[field];
      view[field] = plainObject(records)
        ? Object.fromEntries(Object.entries(records)
          .filter(([, record]) => !isExcluded(record) || carried.has(record.transitionID)))
        : records;
    }
    return view;
  };
```

In `ensureGeneration`, replace (line 543):

```js
      ledger: store.read(),
```

with:

```js
      ledger: overlayLedgerView(store.read(), previous),
```

In `apply`, replace (lines 808-809):

```js
    const sources = await collect();
    const record = durableRecord(store, transitionID);
```

with:

```js
    const sources = await collect();
    const record = durableRecord(store, transitionID);
    if (isExcluded(record)) return exclusionResult(record, dryRun);
```

Replace the whole of `recover` (lines 822-840) with:

```js
  const recover = async ({ transitionID, dryRun = false } = {}) => {
    const sources = await collect();
    if (transitionID) {
      const record = durableRecord(store, transitionID);
      if (isExcluded(record)) return exclusionResult(record, dryRun);
    }
    const state = store.read();
    const { transitions, excluded } = transitionID
      ? { transitions: [transitionID], excluded: [] }
      : partition([
        ...Object.values(state.roles ?? {}),
        ...Object.values(state.unknown ?? {}),
      ].filter(incompleteRecord));
    if (dryRun) return { ok: true, dryRun: true, mutated: false, transitions, excluded };
    const results = [];
    for (const id of transitions) {
      try {
        results.push(await drive(id, sources, { createIntent: false }));
      } catch (error) {
        if (blockedError(error)) persistBlocked(store, id, error, now);
        throw error;
      }
    }
    return transitionID ? results[0] : { ok: true, mutated: results.length > 0, results, excluded };
  };
```

Replace the whole of `refresh` (lines 889-910) with:

```js
  const refresh = async ({ dryRun = false } = {}) => {
    const sources = await collect();
    const state = store.read();
    const { transitions, excluded } = partition(
      [...Object.values(state.roles ?? {}), ...Object.values(state.unknown ?? {})]
        .filter((record) => incompleteRecord(record) || (!record?.applyIntent && AUTHORIZED_STATES.has(record?.state))),
    );
    if (dryRun) {
      for (const id of transitions) validateSources(sources, durableRecord(store, id));
      return { ok: true, dryRun: true, mutated: false, transitions, excluded };
    }
    const results = [];
    for (const id of transitions) {
      try {
        results.push(await drive(id, sources, { createIntent: true }));
      } catch (error) {
        if (blockedError(error)) persistBlocked(store, id, error, now);
        throw error;
      }
    }
    return { ok: true, mutated: results.length > 0, results, excluded };
  };
```

Replace the return value (line 912):

```js
  return { apply, rollback, refresh, recover };
```

with:

```js
  // rollback is deliberately unfiltered: a provider removed from the allowlist after a failed stage
  // (Task B8 rollback-config --provider) must still be rollable back to its incumbent.
  return { apply, rollback, refresh, recover, providers: allowlist };
```

- [ ] **Step 5: Run the applier tests to confirm they pass**

Run: `node --experimental-test-module-mocks --test tests/reconcile-apply.test.mjs`
Expected: PASS. Every test passes, including all pre-existing ones: the default fixture now passes `providers: ["openai"]` and `trustedProviders: ["openai"]`, and line 508 expects `excluded: []`.

- [ ] **Step 6: Wire the CLI and the runtime helper to the new required options**

In `bin/opencode-broker-reconcile`, replace line 41:

```js
import { createReconciliationApplier } from "../lib/reconcile-apply.js";
```

with:

```js
import { applyProviderOptionsFromConfig, createReconciliationApplier } from "../lib/reconcile-apply.js";
```

Replace the construction in `createApplyRuntime` (lines 383-390):

```js
  return createReconciliationApplier({
    store,
    overlayStore,
    generationManager,
    brokerRequest,
    probeClientFactory,
    collectSources,
  });
```

with:

```js
  // The dormant gate in run() guarantees apply is enabled here, so lib/config.js has already
  // required a nonempty trusted allowlist; the applier re-checks it and refuses on drift (RF4).
  return createReconciliationApplier({
    store,
    overlayStore,
    generationManager,
    brokerRequest,
    probeClientFactory,
    collectSources,
    ...applyProviderOptionsFromConfig(CONFIG),
  });
```

Also in `createApplyRuntime`, replace the base-config resolution (lines 366-368):

```js
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const baseConfigPath = process.env.OPENCODE_RECONCILE_BASE_CONFIG
    || join(configHome, "opencode/opencode.json");
```

with:

```js
  // Contract v2: every generation is built from the canonical RAW base, never from the deployed
  // outer link. After cutover ~/.config/opencode/opencode.json points at the generated
  // resolver-generations/current/opencode.json, so building from it would stack generated config
  // on generated config and break the pinned rawBaseHash. OPENCODE_RECONCILE_BASE_CONFIG stays as
  // the explicit test/override hook; OPENCODE_RECONCILE_RAW_BASE is the shared Package 4 override.
  const baseConfigPath = process.env.OPENCODE_RECONCILE_BASE_CONFIG
    || process.env.OPENCODE_RECONCILE_RAW_BASE
    || "/home/dev/devbox/config/opencode/opencode.json";
```

If `configHome` and `homedir` have no other use in the file after this edit, remove the now-unused
`homedir` import so the linter stays clean (check with `grep -n 'homedir\|configHome' bin/opencode-broker-reconcile`).

Add this test to `tests/reconcile-cli.test.mjs` (it pins that the apply runtime ignores the outer
link). It reuses the existing CLI-spawn helper in that file; use its actual name (grep for the
helper that spawns `bin/opencode-broker-reconcile`):

```js
test("apply runtime builds from the raw base, not the deployed outer link", () => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-rawbase-"));
  const raw = join(dir, "raw-opencode.json");
  const outerHome = join(dir, "xdg");
  mkdirSync(join(outerHome, "opencode"), { recursive: true });
  writeFileSync(raw, JSON.stringify({ provider: { marker: { name: "raw" } } }), { mode: 0o600 });
  writeFileSync(join(outerHome, "opencode/opencode.json"), JSON.stringify({ provider: { marker: { name: "generated" } } }));
  const source = readFileSync(new URL("../bin/opencode-broker-reconcile", import.meta.url), "utf8");
  // Static pin: the resolution chain must not consult XDG_CONFIG_HOME or the outer link at all.
  const block = source.slice(source.indexOf("const baseConfigPath"), source.indexOf("const collectSources"));
  assert.match(block, /OPENCODE_RECONCILE_RAW_BASE/);
  assert.match(block, /\/home\/dev\/devbox\/config\/opencode\/opencode\.json/);
  assert.doesNotMatch(block, /XDG_CONFIG_HOME|\.config/);
  rmSync(dir, { recursive: true, force: true });
});
```

Ensure `mkdtempSync`, `mkdirSync`, `writeFileSync`, `readFileSync`, `rmSync` (from `node:fs`), `join` (from `node:path`)
and `tmpdir` (from `node:os`) are imported at the top of `tests/reconcile-cli.test.mjs`; add any that are missing.
Run `node --test tests/reconcile-cli.test.mjs`: the new test FAILS before the replacement above (the block
still references `XDG_CONFIG_HOME`) and PASSES after it.

In `tests/helpers/model-reconcile-runtime.mjs`, replace lines 539-547:

```js
  const realApplier = createReconciliationApplier({
    store,
    overlayStore,
    generationManager,
    brokerRequest: rawBrokerRequest,
    probeClientFactory,
    collectSources: async () => sources,
    now: () => NOW,
  });
```

with:

```js
  // Literal, not read from `config`: this applier is built in both enabled and dormant runtimes, and
  // a dormant config has no reconcile.apply block. The runtime only ever drives the openai ROLE.
  const realApplier = createReconciliationApplier({
    store,
    overlayStore,
    generationManager,
    brokerRequest: rawBrokerRequest,
    probeClientFactory,
    collectSources: async () => sources,
    now: () => NOW,
    providers: ["openai"],
    trustedProviders: ["openai"],
  });
```

- [ ] **Step 7: Run the affected suites, then the full suite**

Run: `node --experimental-test-module-mocks --test tests/reconcile-apply.test.mjs tests/model-reconcile-runtime.test.mjs tests/reconcile-cli.test.mjs`
Expected: PASS. If the import or the spread in `bin/opencode-broker-reconcile` is broken, every `reconcile-cli` test fails at process start, because each one spawns the binary.

Run: `npm test`
Expected: PASS, with zero failures across `tests/*.test.mjs`, `gateway/tests/*.test.mjs` and `hud/tests/*.test.mjs`.

- [ ] **Step 8: Commit**

```bash
git add lib/reconcile-apply.js tests/reconcile-apply.test.mjs tests/helpers/model-reconcile-runtime.mjs bin/opencode-broker-reconcile tests/reconcile-cli.test.mjs
git commit -m "feat(reconcile): filter apply, refresh and recover by the provider allowlist

The applier now requires reconcile.apply.providers and trustedSubscriptionProviders and refuses to
construct when an allowlisted provider is no longer trusted. Transitions of non-allowlisted
providers are left untouched in the ledger and reported as provider-not-allowlisted. The overlay
renderer sees a view of the ledger limited to the allowlist, so one provider's stage can no longer
publish another provider's approved model. Rollback stays unfiltered so a de-allowlisted provider
can still be rolled back."
```

### Task B4: Exact Alibaba roles, official evidence domains, and generation-0 non-eligibility

**Files:**
- Modify: `lib/model-roles.js`. Line numbers are at HEAD 38069c6:
  - 13-20: header comment
  - 38-52: `ROLE_FIELDS`, `REQUIRED_NEW_FIELDS`
  - 113-114: the "Alibaba gets no role" comment
  - after 171: new `validateExactModelIDs`
  - 251-311: `buildRole`
  - 313-338: `buildDefaults`
  - 342-382: `normalizeModelRoles`
  - 384-389: comment on `familyTiersFromRoles`
  - 415-449: `matchModelRole`
- Modify: `lib/reconcile-evidence.js` at line 1 (import), after line 105 (new helpers), and lines 137-185 (`validateEvidencePayload`)
- Modify (tests): `tests/model-roles.test.mjs`, `tests/reconcile-evidence-validate.test.mjs`
- Create (test): `tests/generation-zero-eligibility.test.mjs`

**Interfaces:**
- Consumes. These are existing HEAD functions; nothing in this task comes from B1-B3:
  - `resolvePolicyLane({ targetIDs, targets, modelPolicy, registration, activeLeases, tier, enabled })` in `lib/policy-targets.js`. It returns `{ targetIDs, targets, policyTargetID, candidateOpportunityTargetID, reason, blockedGeneration }`.
  - `createResolverProcessRegistry({ loadRegistry, loadBaseModelKeys, mintToken, now })` in `lib/resolver-processes.js`. It returns `{ register(request), authorize({ resolverToken, modelKey }), ... }`.
  - `discoverSubscriptionTargets(inventory, authTypes, staticTargets, { resolvableModels, modelRoles, trustedProviderIDs })` in `lib/routing.js`. It returns `{ targets, providers, modelContexts, modelOutputs, modelVariants, skipped }`.
  - `validateEvidencePayload(payload, { request, roles, now })` and `allowedEvidenceDomains(request, roles)` in `lib/reconcile-evidence.js`.
- Produces. Later tasks (B8 prepare/commit/canary, B9 docs) depend on these:
  - `export const isExactRole = (role) => boolean` in `lib/model-roles.js`. It is true exactly when `role.exactModelIDs` is a non-empty array.
  - Every role from `DEFAULT_MODEL_ROLES` and `normalizeModelRoles()` gains a frozen `exactModelIDs: readonly string[]`. Family roles get `[]`. Exact roles get `families: []` and `idPatterns: []`.
  - The role field `exactModelIDs` is accepted in host `modelRoles` overrides with these rules:
    - It is valid only on a new exact role, or on an existing exact role. On an existing exact role it is an additive union.
    - An exact role cannot declare `families`/`idPatterns`.
    - A family role cannot gain `exactModelIDs`.
    - One provider cannot mix exact and family roles.
    - Each `providerID/modelID` has exactly one owner.
  - There are four product-default exact roles:

    | Role key | Exact model | Tiers | Effort ceiling |
    | --- | --- | --- | --- |
    | `alibaba-token-plan:qwen-max` | `["qwen3.8-max"]` | `["deep"]` | `"high"` |
    | `alibaba-token-plan:qwen-flash` | `["qwen3.6-flash"]` | `["worker"]` | `"medium"` |
    | `alibaba-token-plan:deepseek-pro` | `["deepseek-v4-pro"]` | `["build","review"]` | `"high"` |
    | `alibaba-token-plan:glm` | `["glm-5.2"]` | `["build","review"]` | `"high"` |

    All four have `evidenceDomains: ["help.aliyun.com","www.alibabacloud.com"]` and `requiredCapabilities: { toolCall: true }`.
  - `matchModelRole(providerID, model, roles)`: an exact role matches only when `model.id` is in its `exactModelIDs`. The family is ignored. The result is `{ status: "known", roleKey, role, version: null }`.
  - `familyTiersFromRoles()` is unchanged in behaviour: exact roles have no families, so `FAMILY_TIERS`, `MAPPED_FAMILY_KEYS` and subscription discovery never map an Alibaba model.
  - `validateEvidencePayload` adds two rules for an exact role. Both strings are exact:
    - Whole-payload rejection: `"candidateModelID is not an exact model of its exact role"`.
    - Per-claim rejection: `"exactQuote must name the exact candidate model ID for an exact role"`.

- [ ] **Step 1: Write the failing tests**

In `tests/model-roles.test.mjs`, the implementer adds `isExactRole` to the import list:

```js
import {
  DEFAULT_MODEL_ROLES,
  REASONING_MODES,
  familyTiersFromRoles,
  isExactRole,
  matchModelRole,
  normalizeModelRoles,
} from "../lib/model-roles.js";
```

Then replace the effort-ceiling expectation at lines 32-42 so the four Alibaba roles appear in insertion order:

```js
  assert.deepEqual(Object.fromEntries(Object.entries(DEFAULT_MODEL_ROLES)
    .map(([key, role]) => [key, role.effortCeiling])), {
    "anthropic:claude-opus": "high",
    "anthropic:claude-sonnet": "high",
    "anthropic:claude-fable": "xhigh",
    "anthropic:claude-haiku": "medium",
    "openai:gpt-astra": "xhigh",
    "openai:gpt-sol": "high",
    "openai:gpt-terra": "high",
    "openai:gpt-luna": "medium",
    "alibaba-token-plan:qwen-max": "high",
    "alibaba-token-plan:qwen-flash": "medium",
    "alibaba-token-plan:deepseek-pro": "high",
    "alibaba-token-plan:glm": "high",
  });
```

Then append these tests at the end of `tests/model-roles.test.mjs`:

```js
// ---- Package 4: exact-ID roles -----------------------------------------------------------
const ALIBABA = "alibaba-token-plan";
const ALIBABA_DOMAINS = ["help.aliyun.com", "www.alibabacloud.com"];
const ALIBABA_EXACT = {
  "alibaba-token-plan:qwen-max": { modelID: "qwen3.8-max", tiers: ["deep"] },
  "alibaba-token-plan:qwen-flash": { modelID: "qwen3.6-flash", tiers: ["worker"] },
  "alibaba-token-plan:deepseek-pro": { modelID: "deepseek-v4-pro", tiers: ["build", "review"] },
  "alibaba-token-plan:glm": { modelID: "glm-5.2", tiers: ["build", "review"] },
};
const exactRole = (modelIDs, overrides = {}) => ({
  exactModelIDs: modelIDs, tiers: ["build"], rank: 2, effortCeiling: "high",
  requiredCapabilities: { toolCall: true }, evidenceDomains: ["help.aliyun.com"], ...overrides,
});

test("Alibaba roles are exact single-model roles with the deployed tiers and official domains", () => {
  for (const [key, expected] of Object.entries(ALIBABA_EXACT)) {
    const role = DEFAULT_MODEL_ROLES[key];
    assert.ok(role, key);
    assert.equal(isExactRole(role), true, key);
    assert.deepEqual(role.exactModelIDs, [expected.modelID], key);
    assert.deepEqual(role.families, [], key);
    assert.deepEqual(role.idPatterns, [], key);
    assert.deepEqual(role.tiers, expected.tiers, key);
    assert.deepEqual(role.evidenceDomains, ALIBABA_DOMAINS, key);
    assert.deepEqual(role.requiredCapabilities, { toolCall: true }, key);
    assert.equal(Object.isFrozen(role.exactModelIDs), true, key);
    // The catalog family is ignored: "qwen" names Max, Plus, Flash and image models alike.
    assert.deepEqual(matchModelRole(ALIBABA, { id: expected.modelID, family: "qwen" }, DEFAULT_MODEL_ROLES),
      { status: "known", roleKey: key, role, version: null }, key);
  }
  for (const role of Object.values(DEFAULT_MODEL_ROLES)) {
    if (role.providerID === ALIBABA) continue;
    assert.equal(isExactRole(role), false, `${role.providerID}:${role.roleID}`);
    assert.deepEqual(role.exactModelIDs, [], `${role.providerID}:${role.roleID}`);
  }
  // Exact roles contribute nothing to the family-keyed discovery policy.
  assert.equal(Object.keys(familyTiersFromRoles(DEFAULT_MODEL_ROLES))
    .some((familyKey) => familyKey.startsWith(`${ALIBABA}:`)), false);
});

test("unknown Alibaba siblings, suffixed variants and family names stay unknown", () => {
  const unknownIDs = ["qwen3.7-max", "qwen3.7-plus", "deepseek-v4-flash-0731", "qwen3.8-max-preview",
    "qwen3.8-max-0901", "QWEN3.8-MAX", "deepseek-v4-pro-0813", "glm-5.2-air", "qwen3.9-max", "qwen-max"];
  for (const id of unknownIDs) {
    for (const family of ["qwen", "deepseek", "glm", "qwen3.8-max", ""]) {
      assert.deepEqual(matchModelRole(ALIBABA, { id, family }, DEFAULT_MODEL_ROLES),
        { status: "unknown", roleKeys: [] }, `${id} / ${family}`);
    }
  }
  assert.deepEqual(matchModelRole(ALIBABA, { family: "qwen3.8-max" }, DEFAULT_MODEL_ROLES),
    { status: "unknown", roleKeys: [] });
  assert.deepEqual(matchModelRole("openai", { id: "qwen3.8-max" }, DEFAULT_MODEL_ROLES),
    { status: "unknown", roleKeys: [] });
});

test("an exact role never gains a matcher and a family role never gains exact IDs", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "alibaba-token-plan:qwen-max": { families: ["qwen"] },
    "alibaba-token-plan:qwen-flash": { idPatterns: [{ prefix: "qwen", suffix: "-flash" }] },
    "openai:gpt-sol": { exactModelIDs: ["gpt-6-sol"] },
  }, { warn: (line) => warnings.push(line) });
  assert.deepEqual(roles["alibaba-token-plan:qwen-max"].families, []);
  assert.deepEqual(roles["alibaba-token-plan:qwen-max"].exactModelIDs, ["qwen3.8-max"]);
  assert.deepEqual(roles["alibaba-token-plan:qwen-flash"].idPatterns, []);
  assert.deepEqual(roles["openai:gpt-sol"].exactModelIDs, []);
  assert.deepEqual(roles["openai:gpt-sol"].families, ["gpt-sol"]);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /exact role.*cannot declare families or idPatterns/);
  assert.match(warnings[1], /exact role.*cannot declare families or idPatterns/);
  assert.match(warnings[2], /exactModelIDs cannot be added/);
  assert.equal(matchModelRole(ALIBABA, { id: "qwen3.7-max", family: "qwen" }, roles).status, "unknown");
});

test("one provider cannot mix exact and family roles in either direction", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "alibaba-token-plan:qwen": {
      families: ["qwen"], idPatterns: [{ prefix: "qwen", suffix: "" }], tiers: ["deep"], rank: 4,
      effortCeiling: "high", requiredCapabilities: { toolCall: true }, evidenceDomains: ["help.aliyun.com"],
    },
    "openai:gpt-nova": exactRole(["gpt-nova-1"], { tiers: ["worker"], evidenceDomains: ["openai.com"] }),
  }, { warn: (line) => warnings.push(line) });
  assert.equal(roles["alibaba-token-plan:qwen"], undefined);
  assert.equal(roles["openai:gpt-nova"], undefined);
  assert.equal(warnings.length, 2);
  for (const line of warnings) assert.match(line, /cannot mix exact and family/);
  assert.deepEqual(familyTiersFromRoles(roles), EXPECTED_FAMILIES);
  assert.equal(matchModelRole(ALIBABA, { id: "qwen3.7-max", family: "qwen" }, roles).status, "unknown");
});

test("exact model IDs grow only by a reviewed same-key or new-role change and keep one owner", () => {
  const warnings = [];
  const roles = normalizeModelRoles({
    "alibaba-token-plan:qwen-max": { exactModelIDs: ["qwen3.9-max"] },
    "alibaba-token-plan:qwen-flash": { exactModelIDs: [] },
    "alibaba-token-plan:qwen-plus": exactRole(["qwen3.7-plus"]),
    "alibaba-token-plan:qwen-max-shadow": exactRole(["qwen3.8-max"], { tiers: ["smart"] }),
    "alibaba-token-plan:bad-id": exactRole(["qwen 3"]),
  }, { warn: (line) => warnings.push(line) });
  assert.deepEqual(roles["alibaba-token-plan:qwen-max"].exactModelIDs, ["qwen3.8-max", "qwen3.9-max"]);
  assert.deepEqual(roles["alibaba-token-plan:qwen-flash"].exactModelIDs, ["qwen3.6-flash"]);
  assert.deepEqual(roles["alibaba-token-plan:qwen-plus"].exactModelIDs, ["qwen3.7-plus"]);
  assert.deepEqual(roles["alibaba-token-plan:qwen-plus"].families, []);
  assert.equal(roles["alibaba-token-plan:qwen-max-shadow"], undefined);
  assert.equal(roles["alibaba-token-plan:bad-id"], undefined);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join("\n"),
    /exact model "qwen3\.8-max" already belongs to alibaba-token-plan:qwen-max/);
  assert.equal(matchModelRole(ALIBABA, { id: "qwen3.7-plus" }, roles).roleKey, "alibaba-token-plan:qwen-plus");
  assert.equal(matchModelRole(ALIBABA, { id: "qwen3.8-max" }, roles).roleKey, "alibaba-token-plan:qwen-max");
});
```

In `tests/reconcile-evidence-validate.test.mjs`, add this import after the existing `reconcile-state.js` import (line 14):

```js
import { DEFAULT_MODEL_ROLES } from "../lib/model-roles.js";
```

Then append:

```js
// ---- Package 4: Alibaba exact-role evidence ----------------------------------------------
const alibabaRequest = (candidateModelID = "qwen3.8-max") => Object.freeze({
  transitionID: TRANSITION_ID,
  kind: "role",
  roleKey: "alibaba-token-plan:qwen-max",
  roleID: "qwen-max",
  providerID: "alibaba-token-plan",
  candidateModelID,
  incumbentModelID: null,
  status: "claimed",
});

const alibabaPayload = (claim, candidateModelID = "qwen3.8-max") => ({
  providerID: "alibaba-token-plan",
  candidateModelID,
  incumbentModelID: null,
  roleID: "qwen-max",
  claims: [{
    claimType: "new-role",
    sourceURL: "https://help.aliyun.com/zh/model-studio/models",
    exactQuote: "The model ID qwen3.8-max is available in the Token Plan.",
    retrievedAt: "2026-09-29T00:00:00Z",
    ...claim,
  }],
});

const validateAlibaba = (claim = {}, candidateModelID = "qwen3.8-max") =>
  validateEvidencePayload(alibabaPayload(claim, candidateModelID), {
    request: alibabaRequest(candidateModelID),
    roles: DEFAULT_MODEL_ROLES,
    now: () => NOW,
  });

test("Alibaba exact roles accept only Alibaba Cloud documentation hosts", () => {
  assert.deepEqual(allowedEvidenceDomains(alibabaRequest(), DEFAULT_MODEL_ROLES),
    ["help.aliyun.com", "www.alibabacloud.com"]);
  for (const sourceURL of [
    "https://help.aliyun.com/zh/model-studio/models",
    "https://www.alibabacloud.com/help/en/model-studio/models",
  ]) {
    const { claims, rejected } = validateAlibaba({ sourceURL });
    assert.equal(claims.length, 1, sourceURL);
    assert.equal(claims[0].policy, true, sourceURL);
    assert.deepEqual(rejected, [], sourceURL);
  }
  for (const sourceURL of [
    "https://alibabacloud.com/help/en/model-studio/models",
    "https://qwen.ai/blog?id=qwen3.8-max",
    "http://help.aliyun.com/zh/model-studio/models",
    "https://help.aliyun.com.evil.example/models",
  ]) {
    const { claims, rejected } = validateAlibaba({ sourceURL });
    assert.deepEqual(claims, [], sourceURL);
    assert.match(rejected.join(" "), /allowed evidence domain/, sourceURL);
  }
});

test("Alibaba evidence must name the exact candidate model ID and the candidate must be in the role", () => {
  for (const exactQuote of ["Use qwen3.8-max.", "Model (qwen3.8-max) supports tool calling."]) {
    assert.equal(validateAlibaba({ exactQuote }).claims.length, 1, exactQuote);
  }
  for (const exactQuote of [
    "Qwen3.8 Max is the most capable Qwen model.",
    "qwen3.8-max-preview is available for testing.",
    "The legacy xqwen3.8-max alias is retired.",
    "QWEN3.8-MAX is listed on this page.",
  ]) {
    const { claims, rejected } = validateAlibaba({ exactQuote });
    assert.deepEqual(claims, [], exactQuote);
    assert.match(rejected.join(" "), /must name the exact candidate model ID/, exactQuote);
  }
  // An unknown sibling can never borrow the Qwen Max role's evidence path, however exact its quote.
  const sibling = validateAlibaba(
    { exactQuote: "The model ID qwen3.7-max is available in the Token Plan." }, "qwen3.7-max");
  assert.deepEqual(sibling.claims, []);
  assert.match(sibling.rejected.join(" "), /not an exact model of its exact role/);
});
```

Create `tests/generation-zero-eligibility.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

// Same fixture tests/routing.test.mjs uses. It has no modelRoles overrides, so CONFIG.modelRoles
// is exactly the shipped registry. Set before any lib import: lib/config.js reads it at evaluation.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const { CONFIG } = await import("../lib/config.js");
const { matchModelRole } = await import("../lib/model-roles.js");
const { resolvePolicyLane } = await import("../lib/policy-targets.js");
const { createResolverProcessRegistry } = await import("../lib/resolver-processes.js");
const { discoverSubscriptionTargets } = await import("../lib/routing.js");

const PROVIDER = "alibaba-token-plan";
const MANIFEST_HASH = "b".repeat(64);
// Every Alibaba resolver key in the canonical raw base, i.e. what generation 0's manifest holds.
// Sorted: lib/resolver-processes.js requires an exact sorted set.
const GENERATION_ZERO_KEYS = Object.freeze([
  "alibaba-token-plan/deepseek-v4-flash-0731",
  "alibaba-token-plan/deepseek-v4-pro",
  "alibaba-token-plan/glm-5.2",
  "alibaba-token-plan/qwen3.6-flash",
  "alibaba-token-plan/qwen3.7-max",
  "alibaba-token-plan/qwen3.7-plus",
  "alibaba-token-plan/qwen3.8-max",
]);
const UNKNOWN_SIBLINGS = Object.freeze(["qwen3.7-max", "qwen3.7-plus", "deepseek-v4-flash-0731"]);

// The deployed static Alibaba targets (fleet config/opencode-broker/config.json), and only those.
const STATIC_TARGETS = Object.freeze({
  "qwen-max": {
    id: "qwen-max", providerID: PROVIDER, modelID: "qwen3.8-max", kind: "cloud",
    tiers: ["deep"], fit: { smart: 1.1 }, variants: ["high"], capabilities: { toolCall: true },
  },
  "qwen-flash": {
    id: "qwen-flash", providerID: PROVIDER, modelID: "qwen3.6-flash", kind: "cloud",
    tiers: ["worker"], variants: ["medium"], capabilities: { toolCall: true },
  },
  "deepseek-pro": {
    id: "deepseek-pro", providerID: PROVIDER, modelID: "deepseek-v4-pro", kind: "cloud",
    tiers: ["build", "review"], fit: { build: 1.15, review: 1.0 }, variants: ["high"],
    capabilities: { toolCall: true },
  },
  glm: {
    id: "glm", providerID: PROVIDER, modelID: "glm-5.2", kind: "cloud",
    tiers: ["build", "review"], fit: { build: 1.1, review: 1.1 }, variants: ["high"],
    capabilities: { toolCall: true },
  },
});

const generationZeroRegistration = () => {
  const registry = createResolverProcessRegistry({
    loadRegistry: () => ({
      version: 1,
      highWater: 0,
      generations: { 0: { manifestHash: MANIFEST_HASH, modelKeys: [...GENERATION_ZERO_KEYS] } },
    }),
    loadBaseModelKeys: () => [...GENERATION_ZERO_KEYS],
    mintToken: () => "gen0-token",
    now: () => 1_000,
  });
  const registered = registry.register({
    generation: 0, manifestHash: MANIFEST_HASH, modelKeys: [...GENERATION_ZERO_KEYS],
  });
  assert.equal(registered.scope, "ordinary");
  return { registry, token: registered.resolverToken };
};

const qwenMaxPolicy = (overrides = {}) => ({
  roleKey: "alibaba-token-plan:qwen-max",
  providerID: PROVIDER,
  incumbentModelID: "qwen3.8-max",
  activeModelID: "qwen3.8-max",
  probationModelID: null,
  rollbackModelID: "qwen3.8-max",
  routingIntent: { tiers: ["deep"], fit: {}, effortCeiling: "high", requiredReasoningMode: null },
  probation: { phase: "probation", offerEvery: 1, opportunityCursor: 0, leases: {} },
  ...overrides,
});

test("generation-0 manifest membership authorizes resolution but confers no routing eligibility", () => {
  const { registry, token } = generationZeroRegistration();
  // Membership is real: a generation-0 process may RESOLVE every raw-base key...
  for (const modelID of UNKNOWN_SIBLINGS) {
    assert.equal(registry.authorize({ resolverToken: token, modelKey: `${PROVIDER}/${modelID}` }).compatible,
      true, modelID);
    // ...but no role claims a sibling, so lib/model-policy.js (modelMatchesRole) rejects any policy
    // record naming it, and no lane can derive a candidate for it.
    assert.equal(matchModelRole(PROVIDER, { id: modelID, family: "qwen" }, CONFIG.modelRoles).status,
      "unknown", modelID);
  }
  // Positive control: the exact roles are live in this process.
  for (const target of Object.values(STATIC_TARGETS)) {
    assert.equal(matchModelRole(PROVIDER, { id: target.modelID }, CONFIG.modelRoles).status, "known",
      target.modelID);
  }

  const registration = registry.authorize({ resolverToken: token });
  for (const tier of ["deep", "worker", "build", "review"]) {
    const targetIDs = Object.keys(STATIC_TARGETS).filter((id) => STATIC_TARGETS[id].tiers.includes(tier));
    const lane = resolvePolicyLane({
      targetIDs, targets: STATIC_TARGETS, modelPolicy: { version: 1, roles: {}, history: [] },
      registration, activeLeases: [], tier, enabled: true,
    });
    assert.deepEqual(lane.targetIDs, targetIDs, tier);
    assert.equal(lane.policyTargetID, null, tier);
    assert.equal(Object.values(lane.targets).some((target) => UNKNOWN_SIBLINGS.includes(target.modelID)),
      false, tier);
  }

  // Even a forged policy naming a manifest-only sibling as probation cannot surface it.
  const forged = resolvePolicyLane({
    targetIDs: ["qwen-max"],
    targets: STATIC_TARGETS,
    modelPolicy: {
      version: 1,
      roles: { "alibaba-token-plan:qwen-max": qwenMaxPolicy({ probationModelID: "qwen3.7-max" }) },
      history: [],
    },
    registration,
    activeLeases: [],
    tier: "deep",
    enabled: true,
  });
  assert.equal(forged.reason, "model-policy-active", "the exact incumbent IS governed by its role");
  assert.deepEqual(forged.targetIDs, ["qwen-max"]);
  assert.equal(forged.policyTargetID, null);
  assert.equal(forged.blockedGeneration, false);
});

test("trusted Alibaba discovery maps no model even with every generation-0 key resolvable", () => {
  const familyOf = (id) => (id.startsWith("qwen") ? "qwen" : id.startsWith("deepseek") ? "deepseek" : "glm");
  const alibabaModels = Object.fromEntries(GENERATION_ZERO_KEYS.map((key) => {
    const id = key.slice(`${PROVIDER}/`.length);
    return [id, {
      id, family: familyOf(id), release_date: "2026-07-31", status: "active", tool_call: true,
      limit: { context: 1_000_000, output: 32_768 },
    }];
  }));
  const inventory = {
    connected: [PROVIDER, "openai"],
    all: [
      { id: PROVIDER, models: alibabaModels },
      { id: "openai", models: { "gpt-6-sol": {
        id: "gpt-6-sol", family: "gpt-sol", release_date: "2026-09-22", status: "active", tool_call: true,
        limit: { context: 400_000, output: 96_000 },
      } } },
    ],
  };
  const discovery = discoverSubscriptionTargets(inventory, { [PROVIDER]: "api", openai: "oauth" }, STATIC_TARGETS, {
    resolvableModels: new Set([...GENERATION_ZERO_KEYS, "openai/gpt-6-sol"]),
    modelRoles: CONFIG.modelRoles,
    trustedProviderIDs: new Set([PROVIDER]),
  });
  assert.equal(discovery.providers[PROVIDER].admission, "admitted");
  assert.deepEqual(Object.values(discovery.targets).filter((target) => target.providerID === PROVIDER), []);
  assert.deepEqual(discovery.skipped.filter((entry) => entry.providerID === PROVIDER), []);
  // Control: discovery itself ran and admitted a family-mapped model from the same call.
  assert.equal(Object.values(discovery.targets)
    .some((target) => target.providerID === "openai" && target.modelID === "gpt-6-sol"), true);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

The implementer runs:

```bash
node --experimental-test-module-mocks --test tests/model-roles.test.mjs tests/reconcile-evidence-validate.test.mjs tests/generation-zero-eligibility.test.mjs
```

Expected result is FAIL, with nonzero exit:

- In `model-roles.test.mjs`, these fail:
  - "roles carry an effort ceiling…": the deepEqual is missing the four `alibaba-token-plan:*` keys.
  - "Alibaba roles are exact…": `assert.ok(undefined)`.
  - "an exact role never gains a matcher…": TypeError reading `families` of undefined.
  - "one provider cannot mix…": `alibaba-token-plan:qwen` is accepted, so the result is not `undefined`.
  - "exact model IDs grow only…": TypeError on `exactModelIDs`.
- "unknown Alibaba siblings…" **passes** before and after. It pins that the change does not widen matching.
- In `reconcile-evidence-validate.test.mjs`, both new tests fail. `allowedEvidenceDomains` returns `[]`, so even the valid claim is rejected.
- In `generation-zero-eligibility.test.mjs`, 1 of 2 tests fails: "generation-0 manifest membership authorizes resolution but confers no routing eligibility" stops at its first failing assertion, the positive control (`qwen3.8-max` gives `unknown !== known`). The discovery test's assertions pass at HEAD.

- [ ] **Step 3: Write the implementation in `lib/model-roles.js`**

(a) In the header comment, replace lines 19-20:

```js
// rather than honoured, and `families`, `idPatterns`, `exactModelIDs` and `evidenceDomains`
// merge ADDITIVELY so a host cannot erase a safe matcher, an exact model or a source allowlist
// by restating the field.
```

(b) Replace lines 38-52 (`ROLE_FIELDS` through `REQUIRED_NEW_FIELDS`):

```js
const ROLE_FIELDS = Object.freeze([
  "families", "idPatterns", "exactModelIDs", "tiers", "fit", "rank", "requiredCapabilities",
  "evidenceDomains", "effortCeiling", "requiredReasoningMode",
]);
// CRITICAL: A new field is a POLICY change, so it is rejected until its validator exists. Package 3
// adds reasoning-mode and compatibility-probe parameters; it must extend this list and write
// the matching validation. Passing an unknown key through would let a host write a rule that
// reads as effective, reviews as effective, and does nothing.
const CAPABILITY_FIELDS = Object.freeze(["toolCall"]);
// A brand-new role key is policy from scratch: there is no safe default underneath it, so
// everything that decides where it routes and what may justify it has to be declared. `fit` is
// the one exception -- an absent fit means "no measured preference", which is a real answer.
const REQUIRED_NEW_FIELDS = Object.freeze([
  "families", "idPatterns", "tiers", "rank", "requiredCapabilities", "evidenceDomains", "effortCeiling",
]);
// An EXACT role names its models one by one and declares no matcher at all, so it needs the
// same policy fields minus the two matchers -- which it is forbidden to carry (see buildRole).
const REQUIRED_NEW_EXACT_FIELDS = Object.freeze([
  "exactModelIDs", "tiers", "rank", "requiredCapabilities", "evidenceDomains", "effortCeiling",
]);
// The model-id alphabet lib/model-candidates.js (VALID_MODEL_ID) and the resolver use.
const MODEL_ID = /^[A-Za-z0-9._:-]{1,180}$/;

// True for a role admitted by exact model ID only. Exported because the evidence validator and
// the Package 4 provider stages must apply exact-only rules to exactly the same set of roles.
export const isExactRole = (role) => Array.isArray(role?.exactModelIDs) && role.exactModelIDs.length > 0;
```

(c) Replace lines 113-114, the comment that says Alibaba gets no role, with the four exact roles. These sit inside `DEFAULT_DEFINITIONS`, before its closing `};`. Also add the domain constant directly above `const DEFAULT_DEFINITIONS = {` at line 62:

```js
// Alibaba's own documentation hosts. Exact hostnames: lib/reconcile-evidence.js also accepts
// their subdomains, never the bare parent domain or a lookalike suffix.
const ALIBABA_EVIDENCE_DOMAINS = Object.freeze(["help.aliyun.com", "www.alibabacloud.com"]);
```

```js
  // CRITICAL: Alibaba Token Plan is admitted by EXACT model ID only. Its catalog mixes Max, Plus,
  // Flash, image and third-party models under shared `qwen`/`deepseek` names, so no family,
  // prefix or inferred tier is safe. qwen3.7-max, qwen3.7-plus and deepseek-v4-flash-0731 stay
  // unknown -- and unroutable -- until a separately reviewed change names them here.
  // Tiers mirror the deployed static targets; fit is the deployed target fit restricted to the
  // role's own tiers.
  "alibaba-token-plan:qwen-max": {
    exactModelIDs: ["qwen3.8-max"], tiers: ["deep"], fit: {}, rank: 4,
    effortCeiling: "high", requiredReasoningMode: null,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ALIBABA_EVIDENCE_DOMAINS,
  },
  "alibaba-token-plan:qwen-flash": {
    exactModelIDs: ["qwen3.6-flash"], tiers: ["worker"], fit: {}, rank: 1,
    effortCeiling: "medium", requiredReasoningMode: null,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ALIBABA_EVIDENCE_DOMAINS,
  },
  "alibaba-token-plan:deepseek-pro": {
    exactModelIDs: ["deepseek-v4-pro"], tiers: ["build", "review"], fit: { build: 1.15, review: 1.0 }, rank: 2,
    effortCeiling: "high", requiredReasoningMode: null,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ALIBABA_EVIDENCE_DOMAINS,
  },
  "alibaba-token-plan:glm": {
    exactModelIDs: ["glm-5.2"], tiers: ["build", "review"], fit: { build: 1.1, review: 1.1 }, rank: 2,
    effortCeiling: "high", requiredReasoningMode: null,
    requiredCapabilities: { toolCall: true }, evidenceDomains: ALIBABA_EVIDENCE_DOMAINS,
  },
```

(d) Insert this immediately after `validateIdPatterns`, which ends at line 171:

```js
const validateExactModelIDs = (label, value) => {
  if (!Array.isArray(value) || !value.length) fail(`${label} must be a non-empty array of exact model IDs`);
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !MODEL_ID.test(entry)) {
      fail(`${label} entry ${JSON.stringify(entry) ?? "undefined"} must be an exact model ID of 1-180 characters [A-Za-z0-9._:-]`);
    }
    if (!ids.includes(entry)) ids.push(entry);
  }
  return ids;
};
```

(e) Replace `buildRole` (lines 251-311) completely:

```js
// Builds one frozen role from a definition, inheriting from `base` when the key already exists.
// `tiers`, `fit`, `rank` and `requiredCapabilities` REPLACE (that is the policy a host is
// entitled to change); `families`, `idPatterns`, `exactModelIDs` and `evidenceDomains` are
// additive unions.
const buildRole = (key, providerID, roleID, definition, base) => {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    fail(`modelRoles["${key}"] = ${JSON.stringify(definition) ?? "undefined"} must be an object`);
  }
  const fields = Object.keys(definition);
  if (!fields.length) fail(`modelRoles["${key}"] is an empty object -- a role cannot be removed`);
  const unsupported = fields.filter((field) => !ROLE_FIELDS.includes(field));
  if (unsupported.length) {
    fail(`modelRoles["${key}"] carries unsupported field(s) ${unsupported.join(", ")} -- only ${ROLE_FIELDS.join(", ")} are accepted`);
  }
  // CRITICAL: A role is EITHER exact (named model IDs, nothing else) OR family-matched, and it
  // stays what it was born as. Letting an exact role gain a family or prefix would turn
  // "qwen3.8-max only" into "every qwen", which is precisely the sibling admission Package 4
  // forbids; letting a family role gain exact IDs would hide a second matching rule inside it.
  const exact = base ? isExactRole(base) : fields.includes("exactModelIDs");
  if (exact && (fields.includes("families") || fields.includes("idPatterns"))) {
    fail(`modelRoles["${key}"] is an exact role -- it matches exactModelIDs only and cannot declare families or idPatterns`);
  }
  if (!exact && fields.includes("exactModelIDs")) {
    fail(`modelRoles["${key}"] is matched by family -- exactModelIDs cannot be added to it`);
  }
  if (!base) {
    const required = exact ? REQUIRED_NEW_EXACT_FIELDS : REQUIRED_NEW_FIELDS;
    const missing = required.filter((field) => !fields.includes(field));
    if (missing.length) {
      fail(`modelRoles["${key}"] is a new role and must declare ${missing.join(", ")}`);
    }
  }
  const families = exact ? []
    : "families" in definition
      ? union(base?.families ?? [], validateNames(`modelRoles["${key}"].families`, definition.families))
      : [...base.families];
  const idPatterns = exact ? []
    : "idPatterns" in definition
      ? unionPatterns(base?.idPatterns ?? [], validateIdPatterns(`modelRoles["${key}"].idPatterns`, definition.idPatterns))
      : base.idPatterns.map((pattern) => ({ ...pattern }));
  const exactModelIDs = !exact ? []
    : "exactModelIDs" in definition
      ? union(base?.exactModelIDs ?? [], validateExactModelIDs(`modelRoles["${key}"].exactModelIDs`, definition.exactModelIDs))
      : [...base.exactModelIDs];
  const evidenceDomains = "evidenceDomains" in definition
    ? union(base?.evidenceDomains ?? [], validateNames(`modelRoles["${key}"].evidenceDomains`, definition.evidenceDomains))
    : [...base.evidenceDomains];
  const tiers = "tiers" in definition
    ? validateTiers(`modelRoles["${key}"].tiers`, definition.tiers)
    : [...base.tiers];
  const fit = "fit" in definition
    ? validateFit(`modelRoles["${key}"].fit`, definition.fit)
    : { ...(base?.fit ?? {}) };
  const rank = "rank" in definition
    ? validateRank(`modelRoles["${key}"].rank`, definition.rank)
    : base.rank;
  const requiredCapabilities = "requiredCapabilities" in definition
    ? validateCapabilities(`modelRoles["${key}"].requiredCapabilities`, definition.requiredCapabilities)
    : { ...base.requiredCapabilities };
  const effortCeiling = "effortCeiling" in definition
    ? validateReasoningMode(`modelRoles["${key}"].effortCeiling`, definition.effortCeiling)
    : base.effortCeiling;
  const requiredReasoningMode = "requiredReasoningMode" in definition
    ? validateReasoningMode(`modelRoles["${key}"].requiredReasoningMode`, definition.requiredReasoningMode,
      { optional: true })
    : (base?.requiredReasoningMode ?? null);
  return Object.freeze({
    providerID,
    roleID,
    families: Object.freeze(families),
    idPatterns: Object.freeze(idPatterns.map((pattern) => Object.freeze({ ...pattern }))),
    exactModelIDs: Object.freeze(exactModelIDs),
    tiers: Object.freeze(tiers),
    fit: Object.freeze(fit),
    rank,
    requiredCapabilities: Object.freeze(requiredCapabilities),
    evidenceDomains: Object.freeze(evidenceDomains),
    effortCeiling,
    requiredReasoningMode,
  });
};
```

(f) Replace lines 313-338, from the `// ---- the default registry` banner through `export const DEFAULT_MODEL_ROLES = BUILT_DEFAULT_ROLES;`:

```js
// ---- the default registry ---------------------------------------------------------------
// Ownership claims shared by the defaults and the override merge: which matching mode each
// provider uses, which role owns each `${providerID}:${family}`, and which role owns each exact
// `${providerID}/${modelID}`. Separate maps, so a family string can never collide with a model id.
const emptyClaims = () => ({ modes: new Map(), families: new Map(), models: new Map() });
const copyClaims = (claims) => ({
  modes: new Map(claims.modes), families: new Map(claims.families), models: new Map(claims.models),
});
const roleMode = (role) => (isExactRole(role) ? "exact" : "family");

// Returns why this role cannot join the registry, or null.
// CRITICAL: One provider is matched ONE way. A family role beside exact roles (or the reverse)
// would let a catalog family re-admit exactly the siblings the exact roles exist to exclude.
const claimConflict = (claims, key, role) => {
  const mode = roleMode(role);
  const providerMode = claims.modes.get(role.providerID);
  if (providerMode && providerMode !== mode) {
    return `modelRoles["${key}"] is a ${mode} role but provider ${role.providerID} is matched by ${providerMode} roles -- one provider cannot mix exact and family matching`;
  }
  for (const family of role.families) {
    const owner = claims.families.get(`${role.providerID}:${family}`);
    if (owner && owner !== key) return `modelRoles["${key}"] family "${family}" already belongs to ${owner}`;
  }
  for (const modelID of role.exactModelIDs) {
    const owner = claims.models.get(`${role.providerID}/${modelID}`);
    if (owner && owner !== key) return `modelRoles["${key}"] exact model "${modelID}" already belongs to ${owner}`;
  }
  return null;
};

const recordClaims = (claims, key, role) => {
  claims.modes.set(role.providerID, roleMode(role));
  for (const family of role.families) claims.families.set(`${role.providerID}:${family}`, key);
  for (const modelID of role.exactModelIDs) claims.models.set(`${role.providerID}/${modelID}`, key);
};

// Built through the same validator the overrides use, so a broken PRODUCT default fails loudly
// at import instead of shipping as a silently missing role.
const buildDefaults = () => {
  const roles = {};
  const claims = emptyClaims();
  for (const [key, definition] of Object.entries(DEFAULT_DEFINITIONS)) {
    const parsed = parseRoleKey(key);
    if (!parsed) throw new Error(`opencode-broker: default model role key "${key}" is not providerID:roleID`);
    const role = buildRole(key, parsed.providerID, parsed.roleID, definition, undefined);
    const conflict = claimConflict(claims, key, role);
    if (conflict) throw new Error(`opencode-broker: default ${conflict}`);
    recordClaims(claims, key, role);
    roles[key] = role;
  }
  return { roles: Object.freeze(roles), claims };
};

const { roles: BUILT_DEFAULT_ROLES, claims: DEFAULT_CLAIMS } = buildDefaults();

export const DEFAULT_MODEL_ROLES = BUILT_DEFAULT_ROLES;
```

(g) Replace `normalizeModelRoles` (lines 342-382):

```js
// Merges validated host overrides over the product defaults.
//
// Key insertion order is DEFAULTS FIRST, then any new role key, and a same-key override keeps
// the default's position: lib/watch.js publishes Object.keys(FAMILY_TIERS) as
// MAPPED_FAMILY_KEYS, so a reshuffle would silently change what that job reports on.
export const normalizeModelRoles = (overrides, { warn = defaultWarn } = {}) => {
  const roles = { ...DEFAULT_MODEL_ROLES };
  const claims = copyClaims(DEFAULT_CLAIMS);
  const authored = overrides && typeof overrides === "object" ? overrides : {};
  for (const [key, definition] of Object.entries(authored)) {
    const parsed = parseRoleKey(key);
    if (!parsed) {
      warn(`modelRoles key "${key}" is not providerID:roleID with lowercase slug halves -- ignored.`);
      continue;
    }
    const { providerID, roleID } = parsed;
    let role;
    try {
      role = buildRole(key, providerID, roleID, definition, roles[key]);
    } catch (error) {
      if (!(error instanceof RoleError)) throw error;
      warn(`${error.message} -- ignored, the safe default stands.`);
      continue;
    }
    // CRITICAL: One family -- and one exact model -- belongs to exactly ONE role, and one provider
    // uses one matching mode. An override that breaks any of these is ignored whole: letting it
    // through would silently move the incumbent's lane to a role the host meant to add alongside
    // it, and which of the two won would depend on iteration order.
    const conflict = claimConflict(claims, key, role);
    if (conflict) {
      warn(`${conflict} -- ignored, the existing owner keeps it.`);
      continue;
    }
    recordClaims(claims, key, role);
    roles[key] = role;
  }
  return Object.freeze(roles);
};
```

(h) In the comment above `familyTiersFromRoles` (lines 384-389), append these lines after line 389 ("a different provider is a different model entirely."):

```js
//
// Exact roles have no families, so they contribute NOTHING here: an exact-ID provider such as
// alibaba-token-plan is never auto-discovered from its catalog. Its models route only through
// configured static targets and the governed model policy.
```

(i) Replace `matchModelRole` (lines 415-449):

```js
// Resolves a catalog model to at most one role.
//
// CRITICAL: AGREEMENT IS REQUIRED, AND DISAGREEMENT IS AN EXPLICIT CONFLICT -- not whichever matcher
// happened to run first. A model whose catalog family says one role and whose id shape says
// another is exactly the case where guessing puts a model in the wrong lane, so both keys are
// returned and the caller (Task 5's reconciler) blocks on the conflict instead.
export const matchModelRole = (providerID, model, roles) => {
  const modelID = typeof model?.id === "string" ? model.id : "";
  const family = typeof model?.family === "string" ? model.family : "";
  const matches = [];
  for (const [key, role] of Object.entries(roles && typeof roles === "object" ? roles : {})) {
    if (!role || typeof role !== "object" || role.providerID !== providerID) continue;
    // CRITICAL: An exact role answers ONLY for the model IDs it names. Family and id shape are
    // never consulted, not even as a fallback: "qwen" is the family of every Qwen tier. An exact
    // ID carries no parsed version.
    if (isExactRole(role)) {
      if (modelID !== "" && role.exactModelIDs.includes(modelID)) matches.push({ key, role, version: null });
      continue;
    }
    const byFamily = family !== "" && (role.families ?? []).includes(family);
    const byPattern = modelID !== ""
      ? matchIdPatterns(role.idPatterns ?? [], modelID)
      : { matched: false, version: null };
    if (!byFamily && !byPattern.matched) continue;
    matches.push({ key, role, version: byPattern.version });
  }
  if (!matches.length) return Object.freeze({ status: "unknown", roleKeys: Object.freeze([]) });
  if (matches.length > 1) {
    // Sorted, so the reported conflict is the same on every run and in every process.
    return Object.freeze({
      status: "conflict",
      roleKeys: Object.freeze(matches.map((match) => match.key).sort()),
    });
  }
  const [match] = matches;
  return Object.freeze({
    status: "known",
    roleKey: match.key,
    role: match.role,
    version: match.version,
  });
};
```

- [ ] **Step 4: Write the implementation in `lib/reconcile-evidence.js`**

(a) After line 1 (`import { createHash } from "node:crypto";`), add the following. `lib/model-roles.js` imports nothing, so this import cannot create a cycle:

```js
import { isExactRole } from "./model-roles.js";
```

(b) Insert after `sourceIsAllowed`, which ends at line 105:

```js
// The exact role a role-kind request is for, or null. Unknown-kind requests and family roles
// keep the pre-Package-4 rules unchanged.
const exactRoleFor = (request, roles) => {
  if (request?.kind === "unknown" || request?.roleID === null || request?.roleID === undefined) return null;
  const roleKey = request.roleKey ?? `${request.providerID}:${request.roleID}`;
  const role = isPlainObject(roles) ? roles[roleKey] : null;
  return isExactRole(role) ? role : null;
};

// CRITICAL: An exact role is admitted model by model, so its evidence must NAME that model.
// A quote about "Qwen Max" or about a sibling id proves nothing about this one. A match counts
// only when the id is not glued to more id characters on either side, so "qwen3.8-max-preview"
// and "xqwen3.8-max" do not name "qwen3.8-max", while "Use qwen3.8-max." does: a trailing
// period followed by a non-id character ends a sentence, not an id. Case-sensitive on purpose:
// an id is exact or it is absent.
const quoteNamesModel = (quote, modelID) => {
  if (typeof modelID !== "string" || !modelID) return false;
  for (let index = quote.indexOf(modelID); index >= 0; index = quote.indexOf(modelID, index + 1)) {
    const before = quote.slice(0, index);
    const after = quote.slice(index + modelID.length);
    if (/[A-Za-z0-9._:-]$/.test(before)) continue;
    if (/^[A-Za-z0-9_:-]/.test(after) || /^\.[A-Za-z0-9]/.test(after)) continue;
    return true;
  }
  return false;
};
```

(c) In `validateEvidencePayload`, insert this directly after the `roleID` mismatch check (`if (request.roleID !== null && ... ) { return rejectedResult("payload roleID does not match the evidence request role"); }`) and before `if (!Array.isArray(payload.claims))`:

```js
  // An exact role has a closed model list: a candidate outside it is a sibling, and no quote can
  // make a sibling eligible. Only a reviewed change to lib/model-roles.js can.
  const exactRole = exactRoleFor(request, roles);
  if (exactRole && !exactRole.exactModelIDs.includes(request.candidateModelID)) {
    return rejectedResult("candidateModelID is not an exact model of its exact role");
  }
```

Then, inside the claim loop, insert this immediately after the `exactQuote must be 10 to 1000 characters` check (after its `continue; }`) and before `const retrievedAt = ...`:

```js
    if (exactRole && !quoteNamesModel(claim.exactQuote, request.candidateModelID)) {
      reject("exactQuote must name the exact candidate model ID for an exact role");
      continue;
    }
```

- [ ] **Step 5: Run the tests and confirm they pass**

The implementer runs:

```bash
node --experimental-test-module-mocks --test tests/model-roles.test.mjs tests/reconcile-evidence-validate.test.mjs tests/generation-zero-eligibility.test.mjs
```

Expected: PASS, every test `ok`, `# fail 0`, exit 0.

Then the full suite. This is the regression guard for everything else that reads the role registry: `FAMILY_TIERS` pins in `tests/routing.test.mjs`, `MAPPED_FAMILY_KEYS` in `tests/watch.test.mjs`, and the reconciler, overlay, notify and gitea tests that use `DEFAULT_MODEL_ROLES`/`CONFIG.modelRoles`:

```bash
npm test
```

Expected: PASS, `# fail 0`, exit 0. If `tests/model-reconcile.test.mjs` or `tests/reconcile-overlay.test.mjs` fails, the implementer stops and reports it rather than editing those tests. The failure would mean the four Alibaba IDs moving from `unknown` to `known` changed reconciler output, and that needs a design decision, not a test fix.

- [ ] **Step 6: Commit**

```bash
git --no-pager status --short
git add lib/model-roles.js lib/reconcile-evidence.js tests/model-roles.test.mjs tests/reconcile-evidence-validate.test.mjs tests/generation-zero-eligibility.test.mjs
git --no-pager diff --cached --stat
git commit -m "feat(roles): exact-ID Alibaba roles with official evidence domains

Alibaba Token Plan models are now admitted by exact model ID only: qwen3.8-max (deep),
qwen3.6-flash (worker), deepseek-v4-pro and glm-5.2 (build, review). Exact roles carry no
family or id pattern, so catalog discovery never maps an Alibaba model and unknown siblings
(qwen3.7-max, qwen3.7-plus, deepseek-v4-flash-0731) stay unknown. A provider cannot mix
exact and family roles, and each exact model has one owner. Evidence for an exact role must
come from help.aliyun.com or www.alibabacloud.com and must name the exact candidate model ID.
Generation-0 manifest membership is pinned as conferring no routing eligibility."
```

The staged set must be exactly those five paths. The implementer never stages `docs/superpowers/plans/2026-09-29-broker-native-classifier-routing.md` or anything under `docs/superpowers/plans/.p4-sections/`.

### Task B5: Generation-zero bootstrap controller (`preflight-topology`, `bootstrap-generation-zero`)

**Files:**
- Create: `lib/reconcile-cutover.js`
- Modify: `lib/resolver-generations.js:552-565` (add the temporary-name helper after `writeAtomicJSON`), `:906-949` (add `initializeRegistry` and `sweepTemporaryFiles`, have `cleanup` use the shared helper, extend the returned object)
- Modify: `bin/opencode-broker-reconcile:30-57` (imports), `:59-76` (USAGE), `:97-106` (FLAG_ONLY), after `:391` (cutover runner), `:435-438` (dispatch)
- Test: `tests/resolver-generations.test.mjs` (append), `tests/reconcile-cutover.test.mjs` (create), `tests/reconcile-cutover-cli.test.mjs` (create)

**Interfaces:**
- Consumes:
  - From B2 (`lib/reconcile-state.js`): `createReconciliationStore({ root, now }) -> { read(): State, update(mutator: (State) => State): State, paths() }`. `RECONCILIATION_STATE_VERSION` is 2, and the store validates the top-level `generationRegistryInitialized` against the spec schema. Before bootstrap, `generationRegistryInitialized` and `configCutover` are absent (B2 rejects a `null` on disk, and no task writes one). B5 still reads both through `?? null`.
  - From Package 3 (`lib/resolver-generations.js`): `createResolverGenerationManager({ root, currentLinkPath, runResolver?, now?, pid?, lockWaitMs? }) -> { readRegistry, build, publish, generation, current, cleanup, paths }`, which includes `build({ reservedGeneration: 0, bootstrapGeneration0: true, baseConfigPath, overlay, authorizingRevisions, protectedReferences, authorizedRetirements })`.
  - From B1 (`lib/config.js`): `CONFIG.reconcile.apply.enabled: boolean`.
- Produces (later tasks rely on these exact names):
  - `lib/resolver-generations.js` manager gains:
    - `initializeRegistry(candidate) -> Promise<{ generation: 0, directory, manifest, manifestHash, effectiveHash, registryHash }>`. It writes a fresh registry `{version:1, highWater:0, generations:{"0":…}}` and never creates the current link. It refuses a candidate other than generation 0, an existing registry, an existing current link, or any other generation directory.
    - `sweepTemporaryFiles({ expectedRegistryHash }) -> Promise<{ removedTemp: string[] }>`. It runs under the manager lock. It first re-hashes the registry, and on a mismatch it throws `...temporary files preserved` without removing anything.
  - `lib/reconcile-cutover.js` exports:
    - `CUTOVER_DEFAULTS` (frozen production paths)
    - `CUTOVER_EXIT = { OK: 0, ERROR: 1, SKIPPED: 5, FINDING: 10, ATTENTION: 20 }`
    - `resolveCutoverPaths(env = process.env) -> Readonly<{ stateRoot, rawBase, outerLink, compatRaw, fleetCore, devbox, overlay, generationsRoot, currentLink, generatedTarget, registry, ledger, legacyLedger, expansionLock }>`. It reads the `OPENCODE_RECONCILE_*` overrides and throws on a non-absolute path.
    - `ledgerRevisionOf(state) -> number`. This is THE ledger revision every Package 4 record uses: the store's integer `revision` counter (contract v2), which must be a non-negative safe integer; mutators receive the enclosing update's revision as `{ revision }`.
    - `verifyRawTopology({ paths, fs }) -> { ok, rawBaseHash: string|null, checks: {name, ok, detail}[], reasons: string[] }`
    - `cutoverExitCode(result) -> 0|5|20`. `ok` maps to 0, `skipped` to 5, anything else to 20.
    - `formatCutoverResult(result) -> string`
    - `createCutoverController({ paths, store, generations, clock = Date.now, fs = node:fs, verifyRawTopology }) -> { preflightTopology(), bootstrapGenerationZero() }`. B6–B8 add their methods inside this same factory. Inside the factory they can reuse the closure helpers `validateInitialization(ack, state) -> string[]` (an empty array means an exact match) and the module helper `readRawBaseHash(paths, fs) -> string`.
    - `createCutoverRuntime(): CutoverController`, defined in `bin/opencode-broker-reconcile` (NOT exported by `lib/reconcile-cutover.js`). Top-level CLI helper for B5 and B6b that builds a controller from the `OPENCODE_RECONCILE_*` environment. Later tasks (B6b) reuse it instead of repeating the inline construction.
    - `preflightTopology() -> { ok, command: "preflight-topology", status: "ok"|"blocked", rawBaseHash, checks, reasons }`
    - `bootstrapGenerationZero() -> Promise<{ ok, command: "bootstrap-generation-zero", status: "initialized"|"already-initialized"|"blocked", reasons, generation: 0|null, registryHash, manifestHash, rawBaseHash, sourceLedgerRevision, artifacts: string[], removedTemp: string[] }>`
  - CLI: `preflight-topology [--json]` and `bootstrap-generation-zero [--json]` exit 0 when `ok` and 20 when blocked. An unknown flag exits 2. `bootstrap-generation-zero` is refused (exit 20, reason `reconcile-apply-enabled`) while apply is enabled.
  - Invariant for B6: `cutoverConfig` must require `readRawBaseHash(paths, fs) === generationRegistryInitialized.rawBaseHash`. The in-window safety argument says generation 0 is byte-identical to the raw base, and that only holds if the raw base has not changed since bootstrap.

- [ ] **Step 1: Write the failing manager tests**

Append this block to the end of `tests/resolver-generations.test.mjs`. It reuses that file's existing `setup`, `buildArgs`, `emptyOverlay`, `bootstrap`, `NOW` and imports.

```js
test("initializeRegistry records generation 0 without creating the current link, and publish later reuses that record", async () => {
  const fixture = setup("initialize-registry");
  const candidate = await fixture.manager.build(buildArgs(fixture, {
    reservedGeneration: 0,
    bootstrapGeneration0: true,
    overlay: emptyOverlay(),
    authorizingRevisions: [],
  }));
  const initialized = await fixture.manager.initializeRegistry(candidate);
  const registryPath = join(fixture.root, "resolver-generations.json");
  const registryBytes = readFileSync(registryPath);
  assert.equal(initialized.registryHash, createHash("sha256").update(registryBytes).digest("hex"));
  assert.equal(initialized.manifestHash, candidate.manifestHash);
  assert.deepEqual(JSON.parse(registryBytes), {
    version: RESOLVER_REGISTRY_VERSION,
    highWater: 0,
    generations: { 0: { manifestHash: candidate.manifestHash, effectiveHash: candidate.effectiveHash, createdAt: NOW } },
  });
  assert.equal(existsSync(fixture.currentLinkPath), false);
  assert.equal(fixture.manager.current(), null);

  const published = await fixture.manager.publish(candidate);
  assert.equal(published.changed, false);
  assert.deepEqual(readFileSync(registryPath), registryBytes);
  assert.equal(readlinkSync(fixture.currentLinkPath), "generation-0");
});

test("initializeRegistry refuses an existing registry and any candidate other than generation 0", async () => {
  const fixture = setup("initialize-refusals");
  const candidate = await bootstrap(fixture);
  await assert.rejects(fixture.manager.initializeRegistry(candidate), /registry already exists/);
  await assert.rejects(fixture.manager.initializeRegistry({ ...candidate, generation: 1 }), /only the generation 0 candidate/);
});

test("sweepTemporaryFiles removes only manager temporaries, and only while the registry matches the expected hash", async () => {
  const fixture = setup("sweep-temporaries");
  await bootstrap(fixture);
  const registryPath = join(fixture.root, "resolver-generations.json");
  const registryHash = createHash("sha256").update(readFileSync(registryPath)).digest("hex");
  const temporaries = [
    ".current.7.dead.tmp",
    ".generation-1.7.dead.tmp",
    ".resolver-generations.7.dead.tmp",
    ".resolver-xdg.1.7.dead.tmp",
  ];
  for (const name of temporaries) writeFileSync(join(fixture.root, name), "x", { mode: 0o600 });
  writeFileSync(join(fixture.root, "unrelated.txt"), "keep", { mode: 0o600 });

  await assert.rejects(
    fixture.manager.sweepTemporaryFiles({ expectedRegistryHash: "0".repeat(64) }),
    /temporary files preserved/,
  );
  for (const name of temporaries) assert.equal(existsSync(join(fixture.root, name)), true);

  const swept = await fixture.manager.sweepTemporaryFiles({ expectedRegistryHash: registryHash });
  assert.deepEqual(swept.removedTemp, temporaries);
  assert.deepEqual(readdirSync(fixture.root).sort(), ["current", "generation-0", "resolver-generations.json", "unrelated.txt"]);
});
```

- [ ] **Step 2: Run the manager tests to verify they fail**

Run: `node --test --test-name-pattern="initializeRegistry|sweepTemporaryFiles" tests/resolver-generations.test.mjs`
Expected: FAIL. The three new tests report `TypeError: fixture.manager.initializeRegistry is not a function` and `TypeError: fixture.manager.sweepTemporaryFiles is not a function`.

- [ ] **Step 3: Extend the Package 3 manager (registry-only init and the validated temp sweep)**

In `lib/resolver-generations.js`, insert this directly after the closing `};` of `writeAtomicJSON` (currently line 565):

```js
// The four temporary names this manager creates: candidate directories, scratch XDG roots,
// registry writes and current-link swaps. Lock state (.resolver-generations.lock*) is deliberately
// not one of them -- the lock protocol reclaims its own leftovers.
const TEMPORARY_NAMES = Object.freeze([
  /^\.generation-\d+\..+\.tmp$/,
  /^\.resolver-xdg\.\d+\..+\.tmp$/,
  /^\.resolver-generations\.\d+\..+\.tmp$/,
  /^\.current\..+\.tmp$/,
]);
const isTemporaryName = (name) => TEMPORARY_NAMES.some((pattern) => pattern.test(name));
```

Insert this between the end of `publish` (the `};` at line 906) and `const cleanup = (`:

```js
  // Package 4 bootstrap: record generation 0 in a brand-new registry WITHOUT creating the current
  // link. The first current-link switch is a later publish() of the same candidate, which finds
  // this exact record, reports changed=false and leaves the registry bytes untouched -- so the
  // registry hash acknowledged in the ledger stays valid across that switch.
  const initializeRegistry = async (candidate) => {
    if (!isPlainObject(candidate) || candidate.generation !== 0) {
      throw new Error("registry initialization accepts only the generation 0 candidate");
    }
    const release = await acquireLock(root, lockPath, pid, lockWaitMs);
    try {
      if (lstatOrNull(registryPath) !== null) {
        throw new Error("resolver generation registry already exists; refusing to initialize over it");
      }
      if (lstatOrNull(currentLinkPath) !== null) {
        throw new Error("resolver current link exists; registry initialization requires no current link");
      }
      // With no registry this throws unless generation-0 is the only generation directory.
      readRegistryInternal({ allowedOrphanGeneration: 0 });
      const expectedDirectory = realpathSync(generationDirectory(0));
      if (candidate.directory !== expectedDirectory) throw new Error("resolver generation candidate directory is not canonical");
      const verified = readBundle(0);
      if (candidate.manifestHash !== verified.manifestHash
        || candidate.effectiveHash !== verified.effectiveHash
        || canonicalJSON(candidate.manifest) !== canonicalJSON(verified.manifest)) {
        throw new Error("resolver generation 0 candidate hash mismatch");
      }
      const registry = normalizeRegistry({
        version: RESOLVER_REGISTRY_VERSION,
        highWater: 0,
        generations: {
          0: {
            manifestHash: verified.manifestHash,
            effectiveHash: verified.effectiveHash,
            createdAt: verified.manifest.createdAt,
          },
        },
      });
      writeAtomicJSON(root, registryPath, registry, pid, "resolver-generations");
      return { ...verified, registryHash: sha256(readFileSync(registryPath)) };
    } finally {
      release();
    }
  };

  // Stale temporaries may be removed only after the final registry validates exactly: the caller
  // passes the hash it has already proven against its acknowledgement, and the hash is checked
  // again here under the lock. On any mismatch every file is preserved for diagnosis.
  const sweepTemporaryFiles = async ({ expectedRegistryHash } = {}) => {
    if (typeof expectedRegistryHash !== "string" || !SHA256.test(expectedRegistryHash)) {
      throw new Error("temporary sweep requires the expected registry hash");
    }
    const release = await acquireLock(root, lockPath, pid, lockWaitMs);
    try {
      const registryBytes = regularFileBytes(registryPath, "resolver generation registry");
      if (sha256(registryBytes) !== expectedRegistryHash) {
        throw new Error("resolver generation registry does not match the expected hash; temporary files preserved");
      }
      normalizeRegistry(parseJSON(registryBytes, "resolver generation registry"));
      const removedTemp = [];
      for (const name of readdirSync(root).sort(compareText)) {
        if (!isTemporaryName(name)) continue;
        rmSync(join(root, name), { recursive: true, force: true });
        removedTemp.push(name);
      }
      if (removedTemp.length) fsyncDirectory(root);
      return { removedTemp };
    } finally {
      release();
    }
  };
```

In `cleanup`, replace the four-pattern condition (currently lines 922-925):

```js
        if (/^\.generation-\d+\..+\.tmp$/.test(name)
          || /^\.resolver-xdg\.\d+\..+\.tmp$/.test(name)
          || /^\.resolver-generations\.\d+\..+\.tmp$/.test(name)
          || /^\.current\..+\.tmp$/.test(name)) {
```

with:

```js
        if (isTemporaryName(name)) {
```

Replace the final return (line 949):

```js
  return { readRegistry, build, publish, generation, current, cleanup, paths };
```

with:

```js
  return { readRegistry, build, publish, initializeRegistry, sweepTemporaryFiles, generation, current, cleanup, paths };
```

- [ ] **Step 4: Run the manager tests to verify they pass**

Run: `node --test tests/resolver-generations.test.mjs`
Expected: PASS. Every test passes, including the existing cleanup tests that now go through `isTemporaryName`.

- [ ] **Step 5: Write the failing controller tests**

Create `tests/reconcile-cutover.test.mjs`:

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import {
  CUTOVER_EXIT,
  createCutoverController,
  cutoverExitCode,
  resolveCutoverPaths,
} from "../lib/reconcile-cutover.js";
import { createReconciliationStore } from "../lib/reconcile-state.js";
import { createResolverGenerationManager } from "../lib/resolver-generations.js";

const NOW = 1_800_000_000_000;
const RAW_BASE_CONFIG = Object.freeze({
  $schema: "https://opencode.ai/config.json",
  provider: { openai: { models: { "gpt-5.6-sol": { name: "GPT 5.6 Sol", limit: { context: 400000, output: 128000 } } } } },
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The exact pre-cutover chain, rebuilt in a temp dir: outer link -> fleet-core compat path ->
// (fleet-core is a symlink to devbox) -> the regular mode-0600 devbox raw base.
const fixture = (label, { resolver } = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `reconcile-cutover-${label}-`)));
  roots.push(base);
  const devbox = join(base, "devbox");
  const fleetCore = join(base, "fleet-core");
  mkdirSync(join(devbox, "config/opencode"), { recursive: true });
  const env = {
    OPENCODE_RECONCILE_STATE_ROOT: join(base, "state"),
    OPENCODE_RECONCILE_RAW_BASE: join(devbox, "config/opencode/opencode.json"),
    OPENCODE_RECONCILE_OUTER_LINK: join(base, "home/.config/opencode/opencode.json"),
    OPENCODE_RECONCILE_COMPAT_RAW: join(fleetCore, "config/opencode/opencode.json"),
    OPENCODE_RECONCILE_FLEET_CORE: fleetCore,
    OPENCODE_RECONCILE_DEVBOX: devbox,
  };
  const paths = resolveCutoverPaths(env);
  writeFileSync(paths.rawBase, `${JSON.stringify(RAW_BASE_CONFIG, null, 2)}\n`, { mode: 0o600 });
  chmodSync(paths.rawBase, 0o600);
  symlinkSync(devbox, fleetCore);
  mkdirSync(join(base, "home/.config/opencode"), { recursive: true });
  symlinkSync(paths.compatRaw, paths.outerLink);
  mkdirSync(paths.stateRoot, { recursive: true, mode: 0o700 });
  const calls = [];
  const generations = createResolverGenerationManager({
    root: paths.generationsRoot,
    currentLinkPath: paths.currentLink,
    now: () => NOW,
    pid: 7,
    runResolver: async (request) => {
      calls.push(request);
      if (resolver) await resolver(request);
      return "openai/gpt-5.6-sol\n";
    },
  });
  const store = createReconciliationStore({ root: paths.stateRoot, now: () => NOW });
  const controller = (overrides = {}) => createCutoverController({ paths, store, generations, clock: () => NOW, ...overrides });
  return { base, paths, calls, generations, store, controller };
};

const buildGenerationZero = (f) => f.generations.build({
  reservedGeneration: 0,
  bootstrapGeneration0: true,
  baseConfigPath: f.paths.rawBase,
  overlay: { version: 1, revision: 0, updatedAt: 0, entries: {} },
  authorizingRevisions: [],
  protectedReferences: [],
  authorizedRetirements: [],
});

test("resolveCutoverPaths pins the production chain and the generations-root layout", () => {
  const state = "/home/dev/.local/share/opencode/model-routing";
  assert.deepEqual({ ...resolveCutoverPaths({}) }, {
    stateRoot: state,
    rawBase: "/home/dev/devbox/config/opencode/opencode.json",
    outerLink: "/home/dev/.config/opencode/opencode.json",
    compatRaw: "/home/dev/fleet-core/config/opencode/opencode.json",
    fleetCore: "/home/dev/fleet-core",
    devbox: "/home/dev/devbox",
    overlay: `${state}/resolver-overlay.json`,
    generationsRoot: `${state}/resolver-generations`,
    currentLink: `${state}/resolver-generations/current`,
    generatedTarget: `${state}/resolver-generations/current/opencode.json`,
    registry: `${state}/resolver-generations/resolver-generations.json`,
    ledger: `${state}/model-reconciliation.json`,
    legacyLedger: `${state}/reviewed-models.json`,
    expansionLock: `${state}/provider-expansion.lock`,
  });
  assert.throws(() => resolveCutoverPaths({ OPENCODE_RECONCILE_RAW_BASE: "relative/opencode.json" }), /must be absolute/);
});

test("cutoverExitCode maps ok to 0, skipped to 5 and every other result to 20", () => {
  assert.equal(cutoverExitCode({ ok: true }), CUTOVER_EXIT.OK);
  assert.equal(cutoverExitCode({ ok: false, skipped: true }), CUTOVER_EXIT.SKIPPED);
  assert.equal(cutoverExitCode({ ok: false }), CUTOVER_EXIT.ATTENTION);
  assert.deepEqual([CUTOVER_EXIT.OK, CUTOVER_EXIT.SKIPPED, CUTOVER_EXIT.FINDING, CUTOVER_EXIT.ATTENTION], [0, 5, 10, 20]);
});

test("preflight-topology accepts the exact compatibility chain, records the raw base hash, and writes nothing", () => {
  const f = fixture("preflight-ok");
  const result = f.controller().preflightTopology();
  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.command, "preflight-topology");
  assert.equal(result.status, "ok");
  assert.equal(result.rawBaseHash, sha256(readFileSync(f.paths.rawBase)));
  assert.deepEqual(result.checks.map((entry) => [entry.name, entry.ok]), [
    ["fleet-core-compatibility-link", true],
    ["outer-config-link", true],
    ["raw-chain-resolution", true],
    ["raw-base-file", true],
  ]);
  assert.equal(existsSync(f.paths.generationsRoot), false);
  assert.equal(existsSync(f.paths.ledger), false);
});

const TOPOLOGY_BREAKS = [
  ["fleet-core is a real directory", (f) => {
    unlinkSync(f.paths.fleetCore);
    mkdirSync(join(f.paths.fleetCore, "config/opencode"), { recursive: true });
    writeFileSync(f.paths.compatRaw, readFileSync(f.paths.rawBase), { mode: 0o600 });
  }, /fleet-core-compatibility-link: .* is not a symlink/],
  ["the outer link targets the raw base directly", (f) => {
    unlinkSync(f.paths.outerLink);
    symlinkSync(f.paths.rawBase, f.paths.outerLink);
  }, /outer-config-link: .* expected exactly/],
  ["the raw base is group-readable", (f) => chmodSync(f.paths.rawBase, 0o640), /raw-base-file: .* mode 0640/],
  ["the raw base is a symlink", (f) => {
    const real = `${f.paths.rawBase}.real`;
    renameSync(f.paths.rawBase, real);
    symlinkSync(real, f.paths.rawBase);
  }, /raw-base-file: .* not a regular file/],
];

for (const [name, breakTopology, reason] of TOPOLOGY_BREAKS) {
  test(`preflight-topology blocks when ${name}`, () => {
    const f = fixture("preflight-break");
    breakTopology(f);
    const result = f.controller().preflightTopology();
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.rawBaseHash, null);
    assert.match(result.reasons.join("\n"), reason);
  });
}

test("bootstrap builds generation 0 from the raw base only, registers it without a current link, and acknowledges it", async () => {
  const f = fixture("bootstrap-fresh");
  // An overlay on disk must not reach generation 0: it is built from the raw base alone.
  writeFileSync(f.paths.overlay, "{\"not\":\"read\"}\n", { mode: 0o600 });
  const rawBaseHash = sha256(readFileSync(f.paths.rawBase));
  const result = await f.controller().bootstrapGenerationZero();
  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.status, "initialized");
  assert.equal(lstatSync(f.paths.currentLink, { throwIfNoEntry: false }), undefined);

  const registryBytes = readFileSync(f.paths.registry);
  const registry = JSON.parse(registryBytes);
  assert.equal(registry.highWater, 0);
  assert.deepEqual(Object.keys(registry.generations), ["0"]);
  const manifestBytes = readFileSync(join(f.paths.generationsRoot, "generation-0/manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.baseHash, rawBaseHash);
  assert.deepEqual(manifest.authorizingRevisions, [`raw-base-sha256:${rawBaseHash}`]);
  assert.deepEqual(JSON.parse(readFileSync(join(f.paths.generationsRoot, "generation-0/opencode.json"))), RAW_BASE_CONFIG);

  const ack = f.store.read().generationRegistryInitialized;
  assert.deepEqual(ack, {
    schemaVersion: 1,
    generation: 0,
    registryHash: sha256(registryBytes),
    manifestHash: sha256(manifestBytes),
    rawBaseHash,
    // An empty ledger's first committed update has revision 1 (contract v2).
    sourceLedgerRevision: 1,
    initializedAt: new Date(NOW).toISOString(),
  });
  assert.deepEqual(
    [result.generation, result.registryHash, result.manifestHash, result.rawBaseHash, result.sourceLedgerRevision],
    [0, ack.registryHash, ack.manifestHash, rawBaseHash, 1],
  );
  assert.equal(f.calls.length, 1);
});

test("a repeated bootstrap validates the exact acknowledgement and changes nothing, before and after the first current switch", async () => {
  const f = fixture("bootstrap-replay");
  assert.equal((await f.controller().bootstrapGenerationZero()).ok, true);
  const ledgerBefore = readFileSync(f.paths.ledger);
  const registryBefore = readFileSync(f.paths.registry);

  const replay = await f.controller({ clock: () => NOW + 60_000 }).bootstrapGenerationZero();
  assert.equal(replay.ok, true, replay.reasons.join("\n"));
  assert.equal(replay.status, "already-initialized");
  assert.deepEqual(readFileSync(f.paths.ledger), ledgerBefore);
  assert.deepEqual(readFileSync(f.paths.registry), registryBefore);
  assert.equal(f.calls.length, 1);

  await f.generations.publish(f.generations.generation(0));
  const afterSwitch = await f.controller().bootstrapGenerationZero();
  assert.equal(afterSwitch.ok, true, afterSwitch.reasons.join("\n"));
  assert.deepEqual(readFileSync(f.paths.registry), registryBefore);
});

const REPLAY_BREAKS = [
  ["the registry bytes changed", (f) => {
    const value = JSON.parse(readFileSync(f.paths.registry));
    unlinkSync(f.paths.registry);
    writeFileSync(f.paths.registry, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }, /registry: hash .* does not match acknowledged/],
  ["the raw base changed after bootstrap", (f) => {
    writeFileSync(f.paths.rawBase, `${JSON.stringify({ ...RAW_BASE_CONFIG, theme: "edited" }, null, 2)}\n`);
  }, /raw-base: current raw base hash .* does not match acknowledged/],
  ["the registry is missing", (f) => unlinkSync(f.paths.registry), /registry: /],
];

for (const [name, breakReplay, reason] of REPLAY_BREAKS) {
  test(`a repeated bootstrap fails closed and preserves every file when ${name}`, async () => {
    const f = fixture("bootstrap-replay-break");
    assert.equal((await f.controller().bootstrapGenerationZero()).ok, true);
    const ack = f.store.read().generationRegistryInitialized;
    const temp = join(f.paths.generationsRoot, ".resolver-generations.7.stale.tmp");
    writeFileSync(temp, "{}\n", { mode: 0o600 });
    breakReplay(f);
    const registryAfterBreak = existsSync(f.paths.registry) ? readFileSync(f.paths.registry) : null;

    const result = await f.controller().bootstrapGenerationZero();
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.match(result.reasons.join("\n"), reason);
    assert.equal(existsSync(temp), true);
    assert.deepEqual(f.store.read().generationRegistryInitialized, ack);
    assert.deepEqual(existsSync(f.paths.registry) ? readFileSync(f.paths.registry) : null, registryAfterBreak);
  });
}

test("stale generation temporaries are swept only after the registry and acknowledgement validate exactly", async () => {
  const f = fixture("bootstrap-sweep");
  assert.equal((await f.controller().bootstrapGenerationZero()).ok, true);
  mkdirSync(join(f.paths.generationsRoot, ".generation-1.7.dead.tmp"), { mode: 0o700 });
  writeFileSync(join(f.paths.generationsRoot, ".resolver-generations.7.dead.tmp"), "{}\n", { mode: 0o600 });
  const registryBefore = readFileSync(f.paths.registry);

  const replay = await f.controller().bootstrapGenerationZero();
  assert.equal(replay.ok, true, replay.reasons.join("\n"));
  assert.deepEqual(replay.removedTemp, [".generation-1.7.dead.tmp", ".resolver-generations.7.dead.tmp"]);
  assert.deepEqual(readdirSync(f.paths.generationsRoot).sort(), ["generation-0", "resolver-generations.json"]);
  assert.deepEqual(readFileSync(f.paths.registry), registryBefore);
});

const PARTIAL_STATES = [
  ["an unregistered generation-0 directory from a crashed bootstrap", async (f) => { await buildGenerationZero(f); }, ["generation-0"]],
  ["a stale registry temporary", async (f) => {
    mkdirSync(f.paths.generationsRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(f.paths.generationsRoot, ".resolver-generations.7.dead.tmp"), "{}\n", { mode: 0o600 });
  }, [".resolver-generations.7.dead.tmp"]],
  ["a registry with no acknowledgement", async (f) => {
    await f.generations.initializeRegistry(await buildGenerationZero(f));
  }, ["generation-0", "resolver-generations.json"]],
];

for (const [name, seed, artifacts] of PARTIAL_STATES) {
  test(`bootstrap refuses ${name} and never initializes from empty over it`, async () => {
    const f = fixture("bootstrap-partial");
    await seed(f);
    const before = readdirSync(f.paths.generationsRoot).sort();
    const registryBefore = existsSync(f.paths.registry) ? readFileSync(f.paths.registry) : null;
    const callsBefore = f.calls.length;

    const result = await f.controller().bootstrapGenerationZero();
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.artifacts, artifacts);
    assert.match(result.reasons.join("\n"), /bootstrap runs only from an empty set/);
    assert.deepEqual(readdirSync(f.paths.generationsRoot).sort(), before);
    assert.deepEqual(existsSync(f.paths.registry) ? readFileSync(f.paths.registry) : null, registryBefore);
    assert.equal(f.calls.length, callsBefore);
    assert.equal(f.store.read().generationRegistryInitialized ?? null, null);
  });
}

test("bootstrap never overwrites an acknowledgement written concurrently", async () => {
  const f = fixture("bootstrap-race");
  const forged = {
    schemaVersion: 1,
    generation: 0,
    registryHash: "b".repeat(64),
    manifestHash: "c".repeat(64),
    rawBaseHash: "d".repeat(64),
    sourceLedgerRevision: 1,
    initializedAt: "2027-01-15T08:00:00.000Z",
  };
  const racing = {
    ...f.store,
    update: (mutator) => {
      f.store.update((state) => ({ ...state, generationRegistryInitialized: forged }));
      return f.store.update(mutator);
    },
  };
  const result = await f.controller({ store: racing }).bootstrapGenerationZero();
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /written concurrently/);
  assert.deepEqual(f.store.read().generationRegistryInitialized, forged);
});

test("bootstrap stops at a topology mismatch before creating any generation artifact", async () => {
  const f = fixture("bootstrap-topology");
  unlinkSync(f.paths.outerLink);
  symlinkSync(f.paths.rawBase, f.paths.outerLink);
  const result = await f.controller().bootstrapGenerationZero();
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /topology outer-config-link/);
  assert.equal(existsSync(f.paths.generationsRoot), false);
  assert.equal(f.calls.length, 0);
});

test("bootstrap pins the raw base hash and refuses to register a generation built while the raw base changed", async () => {
  let f;
  f = fixture("bootstrap-drift", {
    resolver: () => writeFileSync(f.paths.rawBase, `${JSON.stringify({ ...RAW_BASE_CONFIG, theme: "drift" }, null, 2)}\n`),
  });
  const result = await f.controller().bootstrapGenerationZero();
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /raw base changed during bootstrap/);
  assert.equal(existsSync(f.paths.registry), false);
  assert.deepEqual(readdirSync(f.paths.generationsRoot).sort(), ["generation-0"]);
  assert.equal(f.store.read().generationRegistryInitialized ?? null, null);
});

test("a resolver failure leaves no artifact, so the bootstrap is retryable", async () => {
  let failing = true;
  const f = fixture("bootstrap-retry", {
    resolver: () => { if (failing) throw new Error("opencode models --pure exited 127"); },
  });
  const failed = await f.controller().bootstrapGenerationZero();
  assert.equal(failed.ok, false);
  assert.match(failed.reasons.join("\n"), /exited 127/);
  assert.deepEqual(readdirSync(f.paths.generationsRoot), []);
  failing = false;
  const retried = await f.controller().bootstrapGenerationZero();
  assert.equal(retried.ok, true, retried.reasons.join("\n"));
  assert.equal(retried.status, "initialized");
});
```

- [ ] **Step 6: Run the controller tests to verify they fail**

Run: `node --test tests/reconcile-cutover.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` / `Cannot find module '.../lib/reconcile-cutover.js'`.

- [ ] **Step 7: Implement `lib/reconcile-cutover.js`**

Create `lib/reconcile-cutover.js`:

```js
// Package 4 fleet cutover controller: the broker half of the staged cutover. It verifies the
// pre-cutover raw config topology, bootstraps immutable generation 0 from the version-controlled
// raw base, and owns the ledger records later cutover, rollback and provider-stage commands use.
//
// CRITICAL: generation, registry, lock and current-link writes go ONLY through the Package 3
// resolver generation manager, and ledger writes ONLY through createReconciliationStore().update().
// This module never writes either itself.
//
// CRITICAL: the provider-expansion flock is held by the fleet stage script for its whole run and
// inherited by these commands. This module never takes that lock; each step instead re-validates
// under the manager or ledger lock it writes through.
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { isAbsolute, join } from "node:path";

// job-run contract: 0 ok, 5 quiet/skipped, 10 finding, 20 needs attention, anything else failure.
export const CUTOVER_EXIT = Object.freeze({ OK: 0, ERROR: 1, SKIPPED: 5, FINDING: 10, ATTENTION: 20 });

export const CUTOVER_DEFAULTS = Object.freeze({
  stateRoot: "/home/dev/.local/share/opencode/model-routing",
  rawBase: "/home/dev/devbox/config/opencode/opencode.json",
  outerLink: "/home/dev/.config/opencode/opencode.json",
  compatRaw: "/home/dev/fleet-core/config/opencode/opencode.json",
  fleetCore: "/home/dev/fleet-core",
  devbox: "/home/dev/devbox",
});

const SHA256 = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACK_FIELDS = Object.freeze([
  "generation", "initializedAt", "manifestHash", "rawBaseHash", "registryHash", "schemaVersion", "sourceLedgerRevision",
]);
const RAW_BASE_REVISION_PREFIX = "raw-base-sha256:";
// The manager's lock directory and its private pre-publication directories: lock state the
// manager reclaims itself, not generation artifacts.
const MANAGER_LOCK_PREFIX = ".resolver-generations.lock";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const message = (error) => error?.message ?? String(error);
const emptyOverlay = () => ({ version: 1, revision: 0, updatedAt: 0, entries: {} });

export const resolveCutoverPaths = (env = process.env) => {
  const pick = (name, fallback) => (typeof env[name] === "string" && env[name] ? env[name] : fallback);
  const stateRoot = pick("OPENCODE_RECONCILE_STATE_ROOT", CUTOVER_DEFAULTS.stateRoot);
  const generationsRoot = join(stateRoot, "resolver-generations");
  const currentLink = join(generationsRoot, "current");
  const paths = {
    stateRoot,
    rawBase: pick("OPENCODE_RECONCILE_RAW_BASE", CUTOVER_DEFAULTS.rawBase),
    outerLink: pick("OPENCODE_RECONCILE_OUTER_LINK", CUTOVER_DEFAULTS.outerLink),
    compatRaw: pick("OPENCODE_RECONCILE_COMPAT_RAW", CUTOVER_DEFAULTS.compatRaw),
    fleetCore: pick("OPENCODE_RECONCILE_FLEET_CORE", CUTOVER_DEFAULTS.fleetCore),
    devbox: pick("OPENCODE_RECONCILE_DEVBOX", CUTOVER_DEFAULTS.devbox),
    overlay: join(stateRoot, "resolver-overlay.json"),
    generationsRoot,
    currentLink,
    generatedTarget: join(currentLink, "opencode.json"),
    registry: join(generationsRoot, "resolver-generations.json"),
    ledger: join(stateRoot, "model-reconciliation.json"),
    legacyLedger: join(stateRoot, "reviewed-models.json"),
    expansionLock: join(stateRoot, "provider-expansion.lock"),
  };
  // Exact string comparison is the whole point of these paths, so a relative one is refused.
  for (const [name, value] of Object.entries(paths)) {
    if (!isAbsolute(value)) throw new Error(`cutover path ${name} must be absolute, got ${value}`);
  }
  return Object.freeze(paths);
};

// THE ledger revision for every Package 4 record (contract v2): the integer `revision` counter
// owned by createReconciliationStore().update(). A record written inside a mutation carries the
// enclosing update's revision, which the store passes to the mutator as `{ revision }`.
export const ledgerRevisionOf = (state) => {
  const revision = state?.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`reconciliation ledger revision ${String(revision)} is not a non-negative integer`);
  }
  return revision;
};

export const readRawBaseHash = (paths, fs = nodeFs) => {
  const stat = fs.lstatSync(paths.rawBase);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`${paths.rawBase} is not a regular mode-0600 file`);
  }
  return sha256(fs.readFileSync(paths.rawBase));
};

// Spec step 0: fleet-core -> devbox, the outer link targets EXACTLY the compat path, both resolve
// to the canonical raw base, and the raw base is a regular mode-0600 file. Read-only.
export const verifyRawTopology = ({ paths, fs = nodeFs }) => {
  const checks = [];
  const check = (name, probe) => {
    try {
      const detail = probe();
      checks.push({ name, ok: detail === true, detail: detail === true ? "ok" : detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: message(error) });
    }
  };
  check("fleet-core-compatibility-link", () => {
    if (!fs.lstatSync(paths.fleetCore).isSymbolicLink()) return `${paths.fleetCore} is not a symlink`;
    const devbox = fs.lstatSync(paths.devbox);
    if (devbox.isSymbolicLink() || !devbox.isDirectory()) return `${paths.devbox} is not a real directory`;
    const resolved = fs.realpathSync(paths.fleetCore);
    return resolved === paths.devbox ? true : `${paths.fleetCore} resolves to ${resolved}, expected ${paths.devbox}`;
  });
  check("outer-config-link", () => {
    if (!fs.lstatSync(paths.outerLink).isSymbolicLink()) return `${paths.outerLink} is not a symlink`;
    const target = fs.readlinkSync(paths.outerLink);
    return target === paths.compatRaw ? true : `${paths.outerLink} targets ${target}, expected exactly ${paths.compatRaw}`;
  });
  check("raw-chain-resolution", () => {
    const viaCompat = fs.realpathSync(paths.compatRaw);
    if (viaCompat !== paths.rawBase) return `${paths.compatRaw} resolves to ${viaCompat}, expected ${paths.rawBase}`;
    const viaOuter = fs.realpathSync(paths.outerLink);
    return viaOuter === paths.rawBase ? true : `${paths.outerLink} resolves to ${viaOuter}, expected ${paths.rawBase}`;
  });
  let rawBaseHash = null;
  check("raw-base-file", () => {
    const stat = fs.lstatSync(paths.rawBase);
    if (stat.isSymbolicLink() || !stat.isFile()) return `${paths.rawBase} is not a regular file`;
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) return `${paths.rawBase} has mode ${mode.toString(8).padStart(4, "0")}, expected 0600`;
    rawBaseHash = sha256(fs.readFileSync(paths.rawBase));
    return true;
  });
  const reasons = checks.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.detail}`);
  return { ok: reasons.length === 0, rawBaseHash: reasons.length === 0 ? rawBaseHash : null, checks, reasons };
};

export const cutoverExitCode = (result) => {
  if (result?.ok === true) return CUTOVER_EXIT.OK;
  if (result?.skipped === true) return CUTOVER_EXIT.SKIPPED;
  return CUTOVER_EXIT.ATTENTION;
};

export const formatCutoverResult = (result) => [
  `${result.command}: ${result.status}`,
  ...(result.rawBaseHash ? [`  raw base sha256 ${result.rawBaseHash}`] : []),
  ...(result.reasons ?? []).map((reason) => `  ${reason}`),
].join("\n");

// Everything in the generations root except manager lock state. Bootstrap requires this to be empty.
const generationArtifacts = (paths, fs) => {
  let stat;
  try {
    stat = fs.lstatSync(paths.generationsRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return [paths.generationsRoot];
  return fs.readdirSync(paths.generationsRoot).filter((name) => !name.startsWith(MANAGER_LOCK_PREFIX)).sort();
};

const ackProblems = (ack, currentRevision) => {
  if (ack === null || typeof ack !== "object" || Array.isArray(ack)) return ["generationRegistryInitialized is not an object"];
  const problems = [];
  const keys = Object.keys(ack).sort();
  if (keys.join(",") !== ACK_FIELDS.join(",")) problems.push(`generationRegistryInitialized carries fields ${keys.join(", ")}`);
  if (ack.schemaVersion !== 1) problems.push(`generationRegistryInitialized schemaVersion ${String(ack.schemaVersion)} is not 1`);
  if (ack.generation !== 0) problems.push(`generationRegistryInitialized generation ${String(ack.generation)} is not 0`);
  for (const field of ["registryHash", "manifestHash", "rawBaseHash"]) {
    if (typeof ack[field] !== "string" || !SHA256.test(ack[field])) problems.push(`generationRegistryInitialized ${field} is not lowercase 64-hex`);
  }
  if (!Number.isSafeInteger(ack.sourceLedgerRevision) || ack.sourceLedgerRevision < 0 || ack.sourceLedgerRevision > currentRevision) {
    problems.push(`generationRegistryInitialized sourceLedgerRevision ${String(ack.sourceLedgerRevision)} is not within 0..${currentRevision}`);
  }
  if (typeof ack.initializedAt !== "string" || !ISO_UTC.test(ack.initializedAt)) {
    problems.push("generationRegistryInitialized initializedAt is not a UTC ISO-8601 timestamp");
  }
  return problems;
};

const ackSummary = (ack) => ({
  generation: ack.generation,
  registryHash: ack.registryHash,
  manifestHash: ack.manifestHash,
  rawBaseHash: ack.rawBaseHash,
  sourceLedgerRevision: ack.sourceLedgerRevision,
});

const bootstrapResult = (fields) => ({
  ok: false,
  command: "bootstrap-generation-zero",
  status: "blocked",
  reasons: [],
  generation: null,
  registryHash: null,
  manifestHash: null,
  rawBaseHash: null,
  sourceLedgerRevision: null,
  artifacts: [],
  removedTemp: [],
  ...fields,
});

export const createCutoverController = ({
  paths,
  store,
  generations,
  clock = Date.now,
  fs = nodeFs,
  verifyRawTopology: verifyTopology = verifyRawTopology,
} = {}) => {
  if (!paths || typeof paths.rawBase !== "string" || typeof paths.generationsRoot !== "string") {
    throw new Error("cutover controller requires resolved cutover paths");
  }
  if (!store || typeof store.read !== "function" || typeof store.update !== "function") {
    throw new Error("cutover controller requires a reconciliation store");
  }
  if (!generations || typeof generations.build !== "function" || typeof generations.paths !== "function") {
    throw new Error("cutover controller requires a resolver generation manager");
  }
  const managed = generations.paths();
  if (managed.root !== paths.generationsRoot || managed.currentLink !== paths.currentLink || managed.registry !== paths.registry) {
    throw new Error("resolver generation manager paths do not match the cutover paths");
  }

  // Exact replay validation of the immutable acknowledgement against the artifacts on disk.
  // Returns every problem found; an empty array is an exact match.
  const validateInitialization = (ack, state) => {
    let currentRevision;
    try {
      currentRevision = ledgerRevisionOf(state);
    } catch (error) {
      return [message(error)];
    }
    const problems = ackProblems(ack, currentRevision);
    if (problems.length) return problems;
    const attempt = (label, probe) => {
      try {
        const problem = probe();
        if (problem) problems.push(`${label}: ${problem}`);
      } catch (error) {
        problems.push(`${label}: ${message(error)}`);
      }
    };
    attempt("registry", () => {
      const stat = fs.lstatSync(paths.registry);
      if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) return "not a regular mode-0600 file";
      const hash = sha256(fs.readFileSync(paths.registry));
      return hash === ack.registryHash ? null : `hash ${hash} does not match acknowledged ${ack.registryHash}`;
    });
    attempt("generation-0", () => {
      const bundle = generations.generation(0);
      if (bundle.manifestHash !== ack.manifestHash) return `manifest hash ${bundle.manifestHash} does not match acknowledged ${ack.manifestHash}`;
      if (bundle.manifest.baseHash !== ack.rawBaseHash) return `manifest baseHash ${bundle.manifest.baseHash} does not match acknowledged rawBaseHash ${ack.rawBaseHash}`;
      return null;
    });
    attempt("raw-base", () => {
      const hash = readRawBaseHash(paths, fs);
      return hash === ack.rawBaseHash ? null : `current raw base hash ${hash} does not match acknowledged ${ack.rawBaseHash}`;
    });
    attempt("current-link", () => {
      const active = generations.current();
      if (active === null) return null;
      return active.generation === 0 && active.manifestHash === ack.manifestHash
        ? null
        : `current link points to generation ${active.generation}, not the acknowledged generation 0`;
    });
    return problems;
  };

  const preflightTopology = () => {
    const topology = verifyTopology({ paths, fs });
    return {
      ok: topology.ok,
      command: "preflight-topology",
      status: topology.ok ? "ok" : "blocked",
      rawBaseHash: topology.rawBaseHash,
      checks: topology.checks,
      reasons: topology.reasons,
    };
  };

  // Every failure is fail-closed: nothing already on disk is replaced, deleted or initialized from
  // empty, and the reasons say what blocked.
  const bootstrapGenerationZero = async () => {
    try {
      const before = store.read();
      const existing = before.generationRegistryInitialized ?? null;
      if (existing !== null) {
        // Replay deliberately skips the outer-link topology: B6 retargets that link legitimately.
        // It still pins the raw base, because generation 0 must stay byte-derived from it.
        const problems = validateInitialization(existing, before);
        if (problems.length) return bootstrapResult({ reasons: problems });
        const { removedTemp } = await generations.sweepTemporaryFiles({ expectedRegistryHash: existing.registryHash });
        return bootstrapResult({ ok: true, status: "already-initialized", ...ackSummary(existing), removedTemp });
      }
      if ((before.configCutover ?? null) !== null) {
        return bootstrapResult({ reasons: ["configCutover exists without a generationRegistryInitialized acknowledgement; refusing to bootstrap"] });
      }
      const topology = verifyTopology({ paths, fs });
      if (!topology.ok) return bootstrapResult({ reasons: topology.reasons.map((reason) => `topology ${reason}`) });
      const artifacts = generationArtifacts(paths, fs);
      if (artifacts.length) {
        return bootstrapResult({
          artifacts,
          reasons: [`generation artifacts exist without an initialization acknowledgement (${artifacts.join(", ")}); bootstrap runs only from an empty set and preserves them for diagnosis`],
        });
      }
      const pinned = topology.rawBaseHash;
      const candidate = await generations.build({
        reservedGeneration: 0,
        bootstrapGeneration0: true,
        baseConfigPath: paths.rawBase,
        overlay: emptyOverlay(),
        authorizingRevisions: [`${RAW_BASE_REVISION_PREFIX}${pinned}`],
        protectedReferences: [],
        authorizedRetirements: [],
      });
      if (candidate.reused) return bootstrapResult({ reasons: ["generation 0 build reused an existing directory; bootstrap requires a fresh build"] });
      if (candidate.manifest.baseHash !== pinned) {
        return bootstrapResult({ reasons: [`raw base changed during bootstrap: generation 0 baseHash ${candidate.manifest.baseHash} is not the pinned ${pinned}; generation-0 directory preserved for diagnosis`] });
      }
      const afterBuild = readRawBaseHash(paths, fs);
      if (afterBuild !== pinned) {
        return bootstrapResult({ reasons: [`raw base changed during bootstrap: pinned ${pinned}, now ${afterBuild}; generation-0 directory preserved for diagnosis`] });
      }
      const initialized = await generations.initializeRegistry(candidate);
      const written = store.update((state, { revision }) => {
        if ((state.generationRegistryInitialized ?? null) !== null) {
          throw new Error("generationRegistryInitialized was written concurrently; refusing to overwrite it");
        }
        if ((state.configCutover ?? null) !== null) {
          throw new Error("configCutover was written concurrently; refusing to acknowledge bootstrap");
        }
        state.generationRegistryInitialized = {
          schemaVersion: 1,
          generation: 0,
          registryHash: initialized.registryHash,
          manifestHash: initialized.manifestHash,
          rawBaseHash: pinned,
          sourceLedgerRevision: revision,
          initializedAt: new Date(clock()).toISOString(),
        };
        return state;
      });
      const ack = written.generationRegistryInitialized;
      const problems = validateInitialization(ack, written);
      if (problems.length) return bootstrapResult({ reasons: problems });
      const { removedTemp } = await generations.sweepTemporaryFiles({ expectedRegistryHash: ack.registryHash });
      return bootstrapResult({ ok: true, status: "initialized", ...ackSummary(ack), removedTemp });
    } catch (error) {
      return bootstrapResult({ reasons: [message(error)] });
    }
  };

  return { preflightTopology, bootstrapGenerationZero };
};
```

- [ ] **Step 8: Run the controller tests to verify they pass**

Run: `node --test tests/reconcile-cutover.test.mjs`
Expected: PASS (all tests, 0 failures).

- [ ] **Step 9: Write the failing CLI tests**

Create `tests/reconcile-cutover-cli.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

// Spawned, never imported: lib/config.js and lib/routing.js resolve their paths at import.
const CLI = new URL("../bin/opencode-broker-reconcile", import.meta.url).pathname;
const RAW_BASE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  provider: { openai: { models: { "gpt-5.6-sol": { name: "GPT 5.6 Sol", limit: { context: 400000, output: 128000 } } } } },
};
const BROKER_CONFIG = {
  targets: { sol: { providerID: "openai", modelID: "gpt-5.6-sol", kind: "cloud", fit: { smart: 1.4 } } },
  tiers: { smart: ["sol"] },
};
const FAKE_OPENCODE = `#!/bin/sh
if [ "$1" = "models" ] && [ "$2" = "--pure" ]; then
  echo "openai/gpt-5.6-sol"
  exit 0
fi
echo "fake opencode: unexpected invocation: $*" >&2
exit 1
`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (label, { applyEnabled = false } = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `reconcile-cutover-cli-${label}-`)));
  roots.push(base);
  const devbox = join(base, "devbox");
  const fleetCore = join(base, "fleet-core");
  const home = join(base, "home");
  const stateRoot = join(base, "state");
  mkdirSync(join(devbox, "config/opencode"), { recursive: true });
  const rawBase = join(devbox, "config/opencode/opencode.json");
  writeFileSync(rawBase, `${JSON.stringify(RAW_BASE_CONFIG, null, 2)}\n`, { mode: 0o600 });
  chmodSync(rawBase, 0o600);
  symlinkSync(devbox, fleetCore);
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  const outerLink = join(home, ".config/opencode/opencode.json");
  const compatRaw = join(fleetCore, "config/opencode/opencode.json");
  symlinkSync(compatRaw, outerLink);
  mkdirSync(stateRoot, { mode: 0o700 });
  const config = applyEnabled ? {
    ...BROKER_CONFIG,
    trustedSubscriptionProviders: ["openai"],
    reconcile: {
      apply: {
        enabled: true,
        providers: ["openai"],
        overlayPath: join(stateRoot, "resolver-overlay.json"),
        generationsRoot: join(stateRoot, "resolver-generations"),
        currentLinkPath: join(stateRoot, "resolver-generations/current"),
      },
    },
  } : BROKER_CONFIG;
  const configPath = join(base, "broker-config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const fakeBin = join(base, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "opencode"), FAKE_OPENCODE, { mode: 0o755 });
  return { base, home, stateRoot, rawBase, outerLink, compatRaw, fleetCore, devbox, configPath, fakeBin };
};

// Inherited OPENCODE_* and XDG_* variables are stripped so nothing can reach live state.
const runCLI = (f, args) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...clean,
      HOME: f.home,
      PATH: `${f.fakeBin}:${process.env.PATH}`,
      XDG_CONFIG_HOME: join(f.home, ".config"),
      XDG_CACHE_HOME: join(f.base, "cache"),
      OPENCODE_MODEL_ROUTING_DIR: f.stateRoot,
      OPENCODE_BROKER_CONFIG: f.configPath,
      OPENCODE_RECONCILE_STATE_ROOT: f.stateRoot,
      OPENCODE_RECONCILE_RAW_BASE: f.rawBase,
      OPENCODE_RECONCILE_OUTER_LINK: f.outerLink,
      OPENCODE_RECONCILE_COMPAT_RAW: f.compatRaw,
      OPENCODE_RECONCILE_FLEET_CORE: f.fleetCore,
      OPENCODE_RECONCILE_DEVBOX: f.devbox,
    },
  });
};

test("preflight-topology --json exits 0 on the exact chain and 20 on a broken one, writing nothing", () => {
  const f = fixture("preflight");
  const ok = runCLI(f, ["preflight-topology", "--json"]);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.command, "preflight-topology");
  assert.equal(report.rawBaseHash, sha256(readFileSync(f.rawBase)));
  assert.equal(existsSync(join(f.stateRoot, "resolver-generations")), false);

  unlinkSync(f.outerLink);
  symlinkSync(f.rawBase, f.outerLink);
  const broken = runCLI(f, ["preflight-topology", "--json"]);
  assert.equal(broken.status, 20, broken.stderr + broken.stdout);
  assert.equal(JSON.parse(broken.stdout).ok, false);
});

test("bootstrap-generation-zero --json initializes once with exit 0 and replays idempotently with exit 0", () => {
  const f = fixture("bootstrap");
  const first = runCLI(f, ["bootstrap-generation-zero", "--json"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.status, "initialized");
  assert.equal(report.rawBaseHash, sha256(readFileSync(f.rawBase)));
  const ledger = JSON.parse(readFileSync(join(f.stateRoot, "model-reconciliation.json"), "utf8"));
  assert.equal(ledger.generationRegistryInitialized.manifestHash, report.manifestHash);
  assert.equal(lstatSync(join(f.stateRoot, "resolver-generations/current"), { throwIfNoEntry: false }), undefined);

  const second = runCLI(f, ["bootstrap-generation-zero", "--json"]);
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.equal(JSON.parse(second.stdout).status, "already-initialized");
});

test("bootstrap-generation-zero refuses with exit 20 while reconcile apply is enabled, touching no generation path", () => {
  const f = fixture("apply-enabled", { applyEnabled: true });
  const result = runCLI(f, ["bootstrap-generation-zero", "--json"]);
  assert.equal(result.status, 20, result.stderr + result.stdout);
  assert.match(JSON.parse(result.stdout).reasons.join("\n"), /reconcile-apply-enabled/);
  assert.equal(existsSync(join(f.stateRoot, "resolver-generations")), false);
});

test("cutover commands refuse an unknown flag with exit 2", () => {
  const f = fixture("flags");
  const result = runCLI(f, ["bootstrap-generation-zero", "--force"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option "--force"/);
});
```

- [ ] **Step 10: Run the CLI tests to verify they fail**

Run: `node --test tests/reconcile-cutover-cli.test.mjs`
Expected: FAIL. The first three tests fail with `2 !== 0` / `2 !== 20`, and stderr shows `unknown command "preflight-topology"` / `unknown command "bootstrap-generation-zero"`. The flag test happens to pass already because unknown commands also exit 2. That is fine: it pins the behaviour once the command exists.

- [ ] **Step 11: Wire the CLI**

In `bin/opencode-broker-reconcile`, add this paragraph to the header comment, directly after line 15 (`//                    path configuration is explicitly enabled.`):

```js
//   preflight-topology / bootstrap-generation-zero
//                    Package 4 cutover steps 0 and 2, owned by lib/reconcile-cutover.js. Paths
//                    come from resolveCutoverPaths (OPENCODE_RECONCILE_* overrides); exit 0 ok,
//                    20 blocked and needs attention.
```

Add this import after line 44 (`import { createResolverGenerationManager } ...`):

```js
import {
  createCutoverController,
  cutoverExitCode,
  formatCutoverResult,
  resolveCutoverPaths,
} from "../lib/reconcile-cutover.js";
```

In `USAGE`, replace:

```js
  "                                        resume one or every incomplete transition",
].join("\n");
```

with:

```js
  "                                        resume one or every incomplete transition",
  "  preflight-topology [--json]           verify the raw config chain and record the raw base hash",
  "  bootstrap-generation-zero [--json]    build and acknowledge immutable generation 0 (apply off)",
].join("\n");
```

In `FLAG_ONLY`, replace:

```js
  recover: ["--json", "--dry-run"],
});
```

with:

```js
  recover: ["--json", "--dry-run"],
  "preflight-topology": ["--json"],
  "bootstrap-generation-zero": ["--json"],
});
```

Insert this after the closing `};` of `createApplyRuntime` (currently line 391):

```js
// Package 4 cutover commands. Every rule lives in lib/reconcile-cutover.js; this wires the
// production paths and maps the result onto the job-run exit contract.
const CUTOVER_COMMANDS = new Set(["preflight-topology", "bootstrap-generation-zero"]);

// Top-level helper for Package 4 cutover commands; B6b and B8 reuse it.
// It reads only the environment, never CONFIG, so raw-emergency rollback works on a broken config.
const createCutoverRuntime = () => {
  const paths = resolveCutoverPaths(process.env);
  return createCutoverController({
    paths,
    store: createReconciliationStore({ root: paths.stateRoot }),
    generations: createResolverGenerationManager({ root: paths.generationsRoot, currentLinkPath: paths.currentLink }),
  });
};
const runCutoverCommand = async (options) => {
  // Generation 0 is built only while apply is off: the spec keeps apply disabled through
  // bootstrap, prepare and dry-run, so an enabled config is a refusal, not a warning.
  if (options.command === "bootstrap-generation-zero" && CONFIG.reconcile.apply.enabled) {
    const refusal = {
      ok: false,
      command: options.command,
      status: "blocked",
      reasons: ["reconcile-apply-enabled: generation 0 bootstraps only while reconcile.apply.enabled is false"],
    };
    writeReport(options.json, refusal, formatCutoverResult);
    return cutoverExitCode(refusal);
  }
  const controller = createCutoverRuntime();
  const result = options.command === "preflight-topology"
    ? controller.preflightTopology()
    : await controller.bootstrapGenerationZero();
  writeReport(options.json, result, formatCutoverResult);
  return cutoverExitCode(result);
};
```

In `run()`, replace:

```js
  try {
    // Defaults all the way down: the state root from the environment, the registry, the pinned
    // targets and the projection settings from config, the sources from the isolating collector.
    const store = createReconciliationStore();
```

with:

```js
  try {
    if (CUTOVER_COMMANDS.has(options.command)) return await runCutoverCommand(options);
    // Defaults all the way down: the state root from the environment, the registry, the pinned
    // targets and the projection settings from config, the sources from the isolating collector.
    const store = createReconciliationStore();
```

- [ ] **Step 12: Run the CLI tests, then the whole suite, to verify they pass**

Run: `node --test tests/reconcile-cutover-cli.test.mjs`
Expected: PASS (4 tests, 0 failures).

Run: `npm test`
Expected: PASS with 0 failures, including the existing `tests/reconcile-cli.test.mjs` and `tests/resolver-generations.test.mjs`.

- [ ] **Step 13: Commit**

```bash
git add lib/reconcile-cutover.js lib/resolver-generations.js bin/opencode-broker-reconcile tests/reconcile-cutover.test.mjs tests/reconcile-cutover-cli.test.mjs tests/resolver-generations.test.mjs
git commit -m "feat(reconcile): bootstrap immutable generation 0 behind a raw-topology preflight

Adds lib/reconcile-cutover.js with preflightTopology and bootstrapGenerationZero, plus the
preflight-topology and bootstrap-generation-zero CLI commands. Generation 0 is built from
the raw base alone with a pinned SHA-256. The registry is initialized through the Package 3
manager without creating the current link, and the immutable generationRegistryInitialized
acknowledgement is written via the ledger store. Replays are exact and change nothing.
Partial, mismatched or concurrently acknowledged state fails closed and keeps every file.
Stale manager temporaries are swept only after the registry hash re-validates under the
manager lock."
```

### Task B6a: Read-only deployed-config verifier (`verifyDeployedConfig`, `classifyCutoverState`, `verify-deployed-config` CLI)

This task adds the read-only half of the config cutover. `classifyCutoverState` is a pure function that implements the spec's valid-state table ("Valid `configCutover` states are only", spec lines 153-160). `readDeployedFacts` inspects the deployment using only `lstat`, `readlink`, `readFile` and `readdir`. `verifyDeployedConfigWith` and the controller method `verifyDeployedConfig()` combine the two and return a report with exactly the nine contract keys. `opencode-broker-reconcile verify-deployed-config --json` prints that report. It exits 0 only when `ok` is true, 20 when the state is invalid, and 1 when the inspection itself throws.

The verifier deliberately does NOT read through `createResolverGenerationManager`. The manager's `readRegistry()` and `current()` call `ensurePrivateRoot()` (lib/resolver-generations.js:200-207), which runs `mkdirSync` and `chmodSync`. That changes ctime and can change mode, so it would break the no-mutation guarantee.

The design follows from the devbox-sync decision tree (contract F2):
- **Outer link absent:** acceptable in `generated` and `raw-emergency` mode. devbox-sync recreates the link only when the verifier reports `ok`.
- **Outer link present with the wrong target:** always invalid. This is the intermediate state from RF2 (current link already switched, outer link still raw) and from RF1, and it must block, not be relinked.
- **Pre-bootstrap:** ok only when both ledger records and every generation artifact are absent.

**Files:**
- Modify: `lib/reconcile-cutover.js` (created by Task B5; add the exports below and one method on the object `createCutoverController` returns)
- Modify: `bin/opencode-broker-reconcile` (imports, USAGE, `FLAG_ONLY`, new exit code, a new command runner, a dispatch line before the apply gate)
- Create: `tests/reconcile-cutover-verify.test.mjs`

**Interfaces:**
- Consumes:
   - B2 `createReconciliationStore({ root })` from `lib/reconcile-state.js`:
     - `store.read()` returns the v2 state, with `generationRegistryInitialized` and `configCutover` absent when they were never written (never `null` on disk; B2 rejects it).
     - It throws on corrupt or schema-invalid bytes, and it migrates v1 in memory without writing.
     - `store.paths().state` gives the ledger path. `state.revision` is the integer revision counter (contract v2).
   - B2 `store.update(mutator)` (tests only), which accepts the spec-schema records.
   - B5 `resolveCutoverPaths(env = process.env)` from `lib/reconcile-cutover.js`, returning at least `{ rawBase, compatRaw, outerLink, stateRoot, generationsRoot, currentLink, generatedTarget }`. These are absolute strings honouring the `OPENCODE_RECONCILE_*` env overrides.
   - B5 `createCutoverController({ paths, store, generations, clock, fs, verifyRawTopology })`, whose returned object gains `verifyDeployedConfig`.
- Produces:
   - `classifyCutoverState({ initAck, configCutover, outerLink, currentLink, registry, manifest, rawBase }, { generatedTarget, rawBasePath, compatRaw })` returns `{ ok: boolean, mode: "pre-bootstrap"|"generated"|"raw-emergency"|"bootstrap-incomplete"|"invalid", expectedTarget: string|null, reason: string|null, generation: number|null, registryHash: string|null, manifestHash: string|null, rawBaseHash: string|null }`. Its inputs have these shapes:
     - `outerLink` and `currentLink`: `{ kind: "absent"|"symlink"|"other", target: string|null }`
     - `registry`: `{ kind: "absent"|"valid"|"invalid", hash, highWater, entries: { [generation]: manifestHash }, generationDirs: string[] }`
     - `manifest`: `{ kind: "absent"|"valid"|"invalid", generation, hash, configKind: "absent"|"regular"|"invalid" }`
     - `rawBase`: `{ kind: "absent"|"regular"|"invalid", hash }`
   - `readDeployedFacts({ paths, fs })` returns `{ outerLink, currentLink, registry, manifest, rawBase }` in the shapes above. It throws only on unexpected IO errors.
   - `verifyDeployedConfigWith({ paths, store, fs })` returns `{ report, reason }`:
     - `report` has exactly these keys, in this order: `ok, mode, expectedTarget, actualTarget, generation, registryHash, manifestHash, rawBaseHash, ledgerRevision`.
     - `ledgerRevision` is `state.revision` when the ledger file exists, otherwise `null`.
     - `ok === false` implies `mode === "invalid"` or `mode === "bootstrap-incomplete"`.
   - Controller method `verifyDeployedConfig()` returns the bare report object `{ ok, mode, expectedTarget, actualTarget, generation, registryHash, manifestHash, rawBaseHash, ledgerRevision }` (not wrapped in `{ report, reason }`). devbox-sync must treat `bootstrap-incomplete` like any non-ok mode (fail loudly, no link change), and `stage cutover` may resume from it.
   - Reason strings that B6b and F2 may match on:
     - `generation-artifacts-without-ledger-records`
     - `config-cutover-without-registry-initialization`
     - `registry-initialized-without-config-cutover` (reported as mode `bootstrap-incomplete` with exit code nonzero, outer link never changed)
    - `config-cutover-mode-unknown`
    - `config-cutover-target-mismatch`
    - `registry-absent`, `registry-invalid`
    - `registry-generation-0-mismatch`
    - `generated-record-incomplete`
    - `registry-generation-mismatch`
    - `current-link-mismatch`
    - `manifest-absent`, `manifest-invalid`
    - `manifest-generation-mismatch`
    - `manifest-hash-mismatch`
    - `generation-config-absent`, `generation-config-invalid`
    - `outer-link-still-raw`
    - `outer-link-still-generated`
    - `outer-link-mismatch`
    - `outer-link-not-symlink`
    - `raw-emergency-record-carries-generation`
    - `raw-base-absent`, `raw-base-invalid`
    - `raw-base-hash-mismatch`
    - `ledger-unreadable: <message>`
    - `inspection-failed: <message>`
   - CLI `verify-deployed-config [--json]` exits 0 when ok, 20 when invalid or bootstrap-incomplete (the reason goes to stderr), and 1 when paths cannot be resolved. It reads no CONFIG field and is dispatched before the `APPLY_COMMANDS` and `CONFIG_ERROR` gates, so it still reports when the broker config is unparseable or its apply block is invalid (e.g. an allowlisted provider is no longer trusted); paths come from `resolveCutoverPaths(process.env)`.

- [ ] **Step 1: Write the failing tests (pure table plus real-filesystem verifier)**

Create `tests/reconcile-cutover-verify.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import { classifyCutoverState, readDeployedFacts, verifyDeployedConfigWith } from "../lib/reconcile-cutover.js";
import { createReconciliationStore } from "../lib/reconcile-state.js";

const ISO = "2026-10-02T00:00:00.000Z";
const NOW = 1_800_000_000_000;
const H = (c) => c.repeat(64);
const M0 = H("a");
const REG = H("c");
const RAW = H("d");
const REPORT_KEYS = ["ok", "mode", "expectedTarget", "actualTarget", "generation", "registryHash", "manifestHash", "rawBaseHash", "ledgerRevision"];
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// ---- pure valid-state table ----------------------------------------------------------------------

const TARGETS = Object.freeze({
  generatedTarget: "/s/resolver-generations/current/opencode.json",
  rawBasePath: "/d/config/opencode/opencode.json",
  compatRaw: "/f/config/opencode/opencode.json",
});
const INIT = Object.freeze({ schemaVersion: 1, generation: 0, registryHash: REG, manifestHash: M0, rawBaseHash: RAW, sourceLedgerRevision: 3, initializedAt: ISO });
const GENERATED_CUT = Object.freeze({
  schemaVersion: 1, mode: "generated", target: TARGETS.generatedTarget, generation: 0, manifestHash: M0,
  registryHash: REG, rawBaseHash: RAW, sourceLedgerRevision: 4, changedAt: ISO, reason: "bootstrap",
});
const RAW_CUT = Object.freeze({ ...GENERATED_CUT, mode: "raw-emergency", target: TARGETS.rawBasePath, generation: null, manifestHash: null, reason: "emergency-rollback" });
const VALID_REGISTRY = Object.freeze({ kind: "valid", hash: REG, highWater: 0, entries: { 0: M0 }, generationDirs: ["generation-0"] });
const ABSENT_REGISTRY = Object.freeze({ kind: "absent", hash: null, highWater: null, entries: {}, generationDirs: [] });
const ABSENT_LINK = Object.freeze({ kind: "absent", target: null });
const link = (target) => ({ kind: "symlink", target });

const PRE = Object.freeze({
  initAck: null, configCutover: null, outerLink: link(TARGETS.compatRaw), currentLink: ABSENT_LINK,
  registry: ABSENT_REGISTRY, manifest: { kind: "absent", generation: null, hash: null, configKind: "absent" },
  rawBase: { kind: "regular", hash: RAW },
});
const GEN = Object.freeze({
  ...PRE, initAck: INIT, configCutover: GENERATED_CUT, outerLink: link(TARGETS.generatedTarget),
  currentLink: link("generation-0"), registry: VALID_REGISTRY,
  manifest: { kind: "valid", generation: 0, hash: M0, configKind: "regular" },
});
const EMERGENCY = Object.freeze({ ...GEN, configCutover: RAW_CUT, outerLink: link(TARGETS.rawBasePath) });

test("pre-bootstrap is ok only with no ledger records and no generation artifacts", () => {
  assert.deepEqual(classifyCutoverState(PRE, TARGETS), {
    ok: true, mode: "pre-bootstrap", expectedTarget: TARGETS.compatRaw, reason: null,
    generation: null, registryHash: null, manifestHash: null, rawBaseHash: RAW,
  });
  // A missing outer link is still pre-bootstrap: devbox-sync owns creating the raw chain.
  assert.equal(classifyCutoverState({ ...PRE, outerLink: ABSENT_LINK }, TARGETS).mode, "pre-bootstrap");
});

test("generated is ok with exact evidence, and with an absent outer link devbox-sync may recreate", () => {
  assert.deepEqual(classifyCutoverState(GEN, TARGETS), {
    ok: true, mode: "generated", expectedTarget: TARGETS.generatedTarget, reason: null,
    generation: 0, registryHash: REG, manifestHash: M0, rawBaseHash: RAW,
  });
  assert.equal(classifyCutoverState({ ...GEN, outerLink: ABSENT_LINK }, TARGETS).ok, true);
});

test("raw-emergency is ok with null generation evidence and a matching canonical raw base", () => {
  assert.deepEqual(classifyCutoverState(EMERGENCY, TARGETS), {
    ok: true, mode: "raw-emergency", expectedTarget: TARGETS.rawBasePath, reason: null,
    generation: null, registryHash: REG, manifestHash: null, rawBaseHash: RAW,
  });
  assert.equal(classifyCutoverState({ ...EMERGENCY, outerLink: ABSENT_LINK }, TARGETS).ok, true);
});

const INVALID_CASES = [
   ["registry without ledger records", { ...PRE, registry: { ...VALID_REGISTRY } }, "generation-artifacts-without-ledger-records"],
   ["generation dir without ledger records", { ...PRE, registry: { ...ABSENT_REGISTRY, generationDirs: ["generation-0"] } }, "generation-artifacts-without-ledger-records"],
   ["current link without ledger records", { ...PRE, currentLink: link("generation-0") }, "generation-artifacts-without-ledger-records"],
   ["configCutover without init ack", { ...GEN, initAck: null }, "config-cutover-without-registry-initialization"],
  ["unknown mode", { ...GEN, configCutover: { ...GENERATED_CUT, mode: "raw" } }, "config-cutover-mode-unknown"],
  ["generated target not exact (no canonicalizing)", { ...GEN, configCutover: { ...GENERATED_CUT, target: "/s/resolver-generations/generation-0/opencode.json" } }, "config-cutover-target-mismatch"],
  ["registry absent after init", { ...GEN, registry: ABSENT_REGISTRY }, "registry-absent"],
  ["registry corrupt", { ...GEN, registry: { ...VALID_REGISTRY, kind: "invalid" } }, "registry-invalid"],
  ["registry generation-0 regressed vs init ack", { ...GEN, registry: { ...VALID_REGISTRY, entries: { 0: H("9") } } }, "registry-generation-0-mismatch"],
  ["generated generation null", { ...GEN, configCutover: { ...GENERATED_CUT, generation: null } }, "generated-record-incomplete"],
  ["generated manifestHash null", { ...GEN, configCutover: { ...GENERATED_CUT, manifestHash: null } }, "generated-record-incomplete"],
  ["generation above registry high-water", { ...GEN, configCutover: { ...GENERATED_CUT, generation: 1 } }, "registry-generation-mismatch"],
  ["registry entry for generation differs", { ...GEN, registry: { ...VALID_REGISTRY, highWater: 1, entries: { 0: M0, 1: H("b") } }, configCutover: { ...GENERATED_CUT, generation: 1, manifestHash: H("e") } }, "registry-generation-mismatch"],
  ["current link absent", { ...GEN, currentLink: ABSENT_LINK }, "current-link-mismatch"],
  ["current link names another generation", { ...GEN, currentLink: link("generation-1") }, "current-link-mismatch"],
  ["current link is not a symlink", { ...GEN, currentLink: { kind: "other", target: null } }, "current-link-mismatch"],
  ["manifest missing", { ...GEN, manifest: { kind: "absent", generation: null, hash: null, configKind: "regular" } }, "manifest-absent"],
  ["manifest corrupt", { ...GEN, manifest: { kind: "invalid", generation: null, hash: H("7"), configKind: "regular" } }, "manifest-invalid"],
  ["manifest generation differs", { ...GEN, manifest: { ...GEN.manifest, generation: 1 } }, "manifest-generation-mismatch"],
  ["manifest bytes differ", { ...GEN, manifest: { ...GEN.manifest, hash: H("7") } }, "manifest-hash-mismatch"],
  ["generation config missing", { ...GEN, manifest: { ...GEN.manifest, configKind: "absent" } }, "generation-config-absent"],
  ["generation config not private regular", { ...GEN, manifest: { ...GEN.manifest, configKind: "invalid" } }, "generation-config-invalid"],
  ["RF2 intermediate: outer still on compat raw chain", { ...GEN, outerLink: link(TARGETS.compatRaw) }, "outer-link-still-raw"],
  ["RF2 intermediate: outer on direct raw base", { ...GEN, outerLink: link(TARGETS.rawBasePath) }, "outer-link-still-raw"],
  ["generated outer elsewhere", { ...GEN, outerLink: link("/elsewhere/opencode.json") }, "outer-link-mismatch"],
  ["generated outer is a regular file", { ...GEN, outerLink: { kind: "other", target: null } }, "outer-link-not-symlink"],
  ["raw-emergency carries generation", { ...EMERGENCY, configCutover: { ...RAW_CUT, generation: 0 } }, "raw-emergency-record-carries-generation"],
  ["raw-emergency carries manifestHash", { ...EMERGENCY, configCutover: { ...RAW_CUT, manifestHash: M0 } }, "raw-emergency-record-carries-generation"],
  ["raw-emergency target is the compat path", { ...EMERGENCY, configCutover: { ...RAW_CUT, target: TARGETS.compatRaw } }, "config-cutover-target-mismatch"],
  ["raw-emergency raw base missing", { ...EMERGENCY, rawBase: { kind: "absent", hash: null } }, "raw-base-absent"],
  ["raw-emergency raw base not private regular", { ...EMERGENCY, rawBase: { kind: "invalid", hash: null } }, "raw-base-invalid"],
  ["raw-emergency raw base edited", { ...EMERGENCY, rawBase: { kind: "regular", hash: H("6") } }, "raw-base-hash-mismatch"],
  ["raw-emergency outer still generated", { ...EMERGENCY, outerLink: link(TARGETS.generatedTarget) }, "outer-link-still-generated"],
  ["raw-emergency outer via compat chain", { ...EMERGENCY, outerLink: link(TARGETS.compatRaw) }, "outer-link-mismatch"],
  ["raw-emergency registry gone", { ...EMERGENCY, registry: ABSENT_REGISTRY }, "registry-absent"],
];

for (const [name, facts, reason] of INVALID_CASES) {
   test(`invalid: ${name}`, () => {
     const result = classifyCutoverState(facts, TARGETS);
     assert.equal(result.ok, false);
     assert.equal(result.mode, "invalid");
     assert.equal(result.reason, reason);
   });
 }

test("bootstrap-incomplete: init ack without configCutover", () => {
   const result = classifyCutoverState({ ...GEN, configCutover: null }, TARGETS);
   assert.equal(result.ok, false);
   assert.equal(result.mode, "bootstrap-incomplete");
   assert.equal(result.reason, "registry-initialized-without-config-cutover");
 });

// ---- real filesystem ------------------------------------------------------------------------------

const RAW_TEXT = `${JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "fleet-gateway/smart" }, null, 2)}\n`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writePrivate = (path, text) => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return sha(Buffer.from(text));
};
const relink = (path, target) => { rmSync(path, { force: true }); symlinkSync(target, path); };

const makeTree = () => {
  const home = mkdtempSync(join(tmpdir(), "cutover-verify-"));
  roots.push(home);
  mkdirSync(join(home, "devbox/config/opencode"), { recursive: true });
  symlinkSync(join(home, "devbox"), join(home, "fleet-core"));
  mkdirSync(join(home, ".config/opencode"), { recursive: true });
  const stateRoot = join(home, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  const generationsRoot = join(stateRoot, "resolver-generations");
  const currentLink = join(generationsRoot, "current");
  const paths = {
    rawBase: join(home, "devbox/config/opencode/opencode.json"),
    compatRaw: join(home, "fleet-core/config/opencode/opencode.json"),
    outerLink: join(home, ".config/opencode/opencode.json"),
    stateRoot,
    generationsRoot,
    currentLink,
    generatedTarget: join(currentLink, "opencode.json"),
  };
  const rawBaseHash = writePrivate(paths.rawBase, RAW_TEXT);
  symlinkSync(paths.compatRaw, paths.outerLink);
  const env = {
    ...process.env,
    HOME: home,
    OPENCODE_BROKER_CONFIG: new URL("./fixtures/config.json", import.meta.url).pathname,
    OPENCODE_RECONCILE_STATE_ROOT: stateRoot,
    OPENCODE_RECONCILE_RAW_BASE: paths.rawBase,
    OPENCODE_RECONCILE_OUTER_LINK: paths.outerLink,
    OPENCODE_RECONCILE_COMPAT_RAW: paths.compatRaw,
    OPENCODE_RECONCILE_FLEET_CORE: join(home, "fleet-core"),
    OPENCODE_RECONCILE_DEVBOX: join(home, "devbox"),
  };
  // The store must accept this tree's raw base as the raw-emergency target; its default comes
  // from the test process environment, which names the production path.
  const store = createReconciliationStore({ root: stateRoot, configTargets: { rawEmergency: paths.rawBase } });
  return { home, paths, env, rawBaseHash, store };
};

const bootstrapArtifacts = (tree) => {
  const { generationsRoot, currentLink } = tree.paths;
  mkdirSync(join(generationsRoot, "generation-0"), { recursive: true, mode: 0o700 });
  chmodSync(generationsRoot, 0o700);
  writePrivate(join(generationsRoot, "generation-0/opencode.json"), RAW_TEXT);
  const manifestHash = writePrivate(join(generationsRoot, "generation-0/manifest.json"), `${JSON.stringify({
    version: 1, generation: 0, baseHash: tree.rawBaseHash, overlayHash: H("e"), effectiveHash: H("f"),
    modelKeys: [], createdAt: NOW, authorizingRevisions: [],
  }, null, 2)}\n`);
  const registryHash = writePrivate(join(generationsRoot, "resolver-generations.json"), `${JSON.stringify({
    version: 1, highWater: 0, generations: { 0: { manifestHash, effectiveHash: H("f"), createdAt: NOW } },
  }, null, 2)}\n`);
  symlinkSync("generation-0", currentLink);
  return { manifestHash, registryHash };
};

const recordCutover = (tree, { manifestHash, registryHash }, mode) => tree.store.update((state, { revision }) => ({
  ...state,
  generationRegistryInitialized: {
    schemaVersion: 1, generation: 0, registryHash, manifestHash, rawBaseHash: tree.rawBaseHash,
    sourceLedgerRevision: revision, initializedAt: ISO,
  },
  configCutover: {
    schemaVersion: 1,
    mode,
    target: mode === "generated" ? tree.paths.generatedTarget : tree.paths.rawBase,
    generation: mode === "generated" ? 0 : null,
    manifestHash: mode === "generated" ? manifestHash : null,
    registryHash,
    rawBaseHash: tree.rawBaseHash,
    sourceLedgerRevision: revision,
    changedAt: ISO,
    reason: mode === "generated" ? "bootstrap" : "emergency-rollback",
  },
}));

// Every path under the tree: mode, size, mtime AND ctime (a same-mode chmod still moves ctime),
// plus file bytes and link targets.
const snapshot = (root) => {
  const out = {};
  const walk = (path) => {
    const stat = lstatSync(path);
    out[path] = {
      mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      content: stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? readFileSync(path, "hex") : null,
    };
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return out;
};

const verify = (tree) => verifyDeployedConfigWith({ paths: tree.paths, store: tree.store, fs: nodeFs });

test("verifier reports exact generated evidence with the ledger revision counter", () => {
  const tree = makeTree();
  const hashes = bootstrapArtifacts(tree);
  recordCutover(tree, hashes, "generated");
  relink(tree.paths.outerLink, tree.paths.generatedTarget);
  const { report, reason } = verify(tree);
  assert.deepEqual(Object.keys(report), REPORT_KEYS);
  assert.deepEqual(report, {
    ok: true, mode: "generated", expectedTarget: tree.paths.generatedTarget, actualTarget: tree.paths.generatedTarget,
    generation: 0, registryHash: hashes.registryHash, manifestHash: hashes.manifestHash,
    rawBaseHash: tree.rawBaseHash, ledgerRevision: tree.store.read().revision,
  });
  assert.equal(reason, null);
});

test("RF2: current link switched but outer link still raw is invalid until retargeted", () => {
  const tree = makeTree();
  recordCutover(tree, bootstrapArtifacts(tree), "generated");
  const { report, reason } = verify(tree);
  assert.equal(report.ok, false);
  assert.equal(report.mode, "invalid");
  assert.equal(report.actualTarget, tree.paths.compatRaw);
  assert.equal(report.expectedTarget, tree.paths.generatedTarget);
  assert.equal(reason, "outer-link-still-raw");
});

test("generation artifacts without ledger records are never pre-bootstrap", () => {
  const tree = makeTree();
  bootstrapArtifacts(tree);
  const { report, reason } = verify(tree);
  assert.equal(report.mode, "invalid");
  assert.equal(report.ledgerRevision, null);
  assert.equal(reason, "generation-artifacts-without-ledger-records");
});

test("a tampered manifest byte blocks generated mode", () => {
  const tree = makeTree();
  recordCutover(tree, bootstrapArtifacts(tree), "generated");
  relink(tree.paths.outerLink, tree.paths.generatedTarget);
  const manifestPath = join(tree.paths.generationsRoot, "generation-0/manifest.json");
  writePrivate(manifestPath, `${readFileSync(manifestPath, "utf8")} `);
  assert.equal(verify(tree).reason, "manifest-hash-mismatch");
});

test("raw-emergency hashes the canonical raw base before accepting it", () => {
  const tree = makeTree();
  recordCutover(tree, bootstrapArtifacts(tree), "raw-emergency");
  relink(tree.paths.outerLink, tree.paths.rawBase);
  assert.deepEqual(verify(tree).report, {
    ok: true, mode: "raw-emergency", expectedTarget: tree.paths.rawBase, actualTarget: tree.paths.rawBase,
    generation: null, registryHash: verify(tree).report.registryHash, manifestHash: null,
    rawBaseHash: tree.rawBaseHash, ledgerRevision: tree.store.read().revision,
  });
  writePrivate(tree.paths.rawBase, `${RAW_TEXT} `);
  assert.equal(verify(tree).reason, "raw-base-hash-mismatch");
});

test("a corrupt ledger is invalid and its bytes are preserved", () => {
  const tree = makeTree();
  const ledger = join(tree.paths.stateRoot, "model-reconciliation.json");
  writePrivate(ledger, "{\"version\": 2, \"trunc");
  const { report, reason } = verify(tree);
  assert.equal(report.mode, "invalid");
  assert.equal(report.ok, false);
  assert.match(reason, /^ledger-unreadable: /);
  assert.equal(readFileSync(ledger, "utf8"), "{\"version\": 2, \"trunc");
});

test("readDeployedFacts and the verifier change no byte, mode, mtime or ctime", () => {
  const tree = makeTree();
  recordCutover(tree, bootstrapArtifacts(tree), "generated");
  relink(tree.paths.outerLink, tree.paths.generatedTarget);
  chmodSync(tree.paths.generationsRoot, 0o755); // a manager read would chmod this back to 0700
  const before = snapshot(tree.home);
  readDeployedFacts({ paths: tree.paths, fs: nodeFs });
  verify(tree);
  assert.deepEqual(snapshot(tree.home), before);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test tests/reconcile-cutover-verify.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../lib/reconcile-cutover.js' does not provide an export named 'classifyCutoverState'`

- [ ] **Step 3: Implement the verifier in `lib/reconcile-cutover.js`**

Add these imports at the top of `lib/reconcile-cutover.js`. Where B5 already imports a name, merge the names into its existing import line instead of adding a duplicate:

```js
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";
```

Add these module-level definitions above `createCutoverController`:

```js
// ---- read-only deployed-config verification ---------------------------------------------------
// CRITICAL: this path never goes through createResolverGenerationManager. Its readRegistry() and
// current() call ensurePrivateRoot(), which mkdirs and chmods the generations root -- a mutation.
// The verifier is what devbox-sync runs every sync, so it may only lstat, readlink, read and list.
const SHA256_HEX = /^[a-f0-9]{64}$/;
const GENERATION_NAME = /^generation-(0|[1-9]\d*)$/;
const REGISTRY_FILE = "resolver-generations.json";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const lstatOrNull = (fs, path) => {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
};

const readLinkFact = (fs, path) => {
  const stat = lstatOrNull(fs, path);
  if (stat === null) return { kind: "absent", target: null };
  if (!stat.isSymbolicLink()) return { kind: "other", target: null };
  return { kind: "symlink", target: fs.readlinkSync(path) };
};

// Exactly the bytes at this path: never followed through a symlink, and only a mode-0600 regular
// file counts, the same rule regularFileBytes applies in lib/resolver-generations.js.
const readPrivateFile = (fs, path) => {
  const stat = lstatOrNull(fs, path);
  if (stat === null) return { kind: "absent", bytes: null };
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) return { kind: "invalid", bytes: null };
  return { kind: "regular", bytes: fs.readFileSync(path) };
};

const readRegistryFact = (fs, root) => {
  const rootStat = lstatOrNull(fs, root);
  const rootIsDirectory = rootStat !== null && !rootStat.isSymbolicLink() && rootStat.isDirectory();
  const generationDirs = rootIsDirectory ? fs.readdirSync(root).filter((name) => GENERATION_NAME.test(name)).sort() : [];
  const fact = (kind, hash = null, extra = {}) => ({ kind, hash, highWater: null, entries: {}, generationDirs, ...extra });
  if (rootStat !== null && !rootIsDirectory) return fact("invalid");
  const file = readPrivateFile(fs, join(root, REGISTRY_FILE));
  if (file.kind !== "regular") return fact(file.kind);
  const hash = digest(file.bytes);
  let parsed;
  try {
    parsed = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    return fact("invalid", hash);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isCount(parsed.highWater) || !isRecord(parsed.generations)) {
    return fact("invalid", hash);
  }
  const entries = {};
  for (const [key, entry] of Object.entries(parsed.generations)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > parsed.highWater || !isRecord(entry) || !SHA256_HEX.test(entry.manifestHash ?? "")) {
      return fact("invalid", hash);
    }
    entries[key] = entry.manifestHash;
  }
  return fact("valid", hash, { highWater: parsed.highWater, entries });
};

const readManifestFact = (fs, root, currentLink) => {
  const none = { kind: "absent", generation: null, hash: null, configKind: "absent" };
  if (currentLink.kind !== "symlink" || !GENERATION_NAME.test(currentLink.target)) return none;
  const directory = join(root, currentLink.target);
  const directoryStat = lstatOrNull(fs, directory);
  if (directoryStat === null) return none;
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return { ...none, kind: "invalid" };
  const manifest = readPrivateFile(fs, join(directory, "manifest.json"));
  const configKind = readPrivateFile(fs, join(directory, "opencode.json")).kind;
  if (manifest.kind !== "regular") return { kind: manifest.kind, generation: null, hash: null, configKind };
  const hash = digest(manifest.bytes);
  let parsed;
  try {
    parsed = JSON.parse(manifest.bytes.toString("utf8"));
  } catch {
    return { kind: "invalid", generation: null, hash, configKind };
  }
  const generation = isRecord(parsed) && isCount(parsed.generation) ? parsed.generation : null;
  return { kind: generation === null ? "invalid" : "valid", generation, hash, configKind };
};

export const readDeployedFacts = ({ paths, fs = nodeFs }) => {
  const currentLink = readLinkFact(fs, paths.currentLink);
  const raw = readPrivateFile(fs, paths.rawBase);
  return {
    outerLink: readLinkFact(fs, paths.outerLink),
    currentLink,
    registry: readRegistryFact(fs, paths.generationsRoot),
    manifest: readManifestFact(fs, paths.generationsRoot, currentLink),
    rawBase: { kind: raw.kind, hash: raw.bytes === null ? null : digest(raw.bytes) },
  };
};

// An absent outer link is recreatable by devbox-sync once the verifier says ok. A link that EXISTS
// with the wrong target is never repaired here or there: in generated mode a raw-chain target is
// the RF2 intermediate state that only cutover-config may complete under the lock.
const outerLinkProblem = (outerLink, expected, intermediateTargets, intermediateReason) => {
  if (outerLink.kind === "absent") return null;
  if (outerLink.kind !== "symlink") return "outer-link-not-symlink";
  if (outerLink.target === expected) return null;
  return intermediateTargets.includes(outerLink.target) ? intermediateReason : "outer-link-mismatch";
};

export const classifyCutoverState = (
  { initAck, configCutover, outerLink, currentLink, registry, manifest, rawBase },
  { generatedTarget, rawBasePath, compatRaw },
) => {
  const observed = { generation: null, registryHash: registry.hash, manifestHash: null, rawBaseHash: rawBase.hash };
  const invalid = (reason, expectedTarget = null) => ({
    ok: false, mode: "invalid", expectedTarget, reason, ...observed,
    generation: isCount(configCutover?.generation) ? configCutover.generation : null,
  });
  const initialized = initAck !== null && initAck !== undefined;
  const cutOver = configCutover !== null && configCutover !== undefined;
  if (!initialized && !cutOver) {
    // Pre-bootstrap is never inferred from a partial filesystem: ANY generation artifact blocks it.
    const artifacts = registry.kind !== "absent" || registry.generationDirs.length > 0 || currentLink.kind !== "absent";
    if (artifacts) return invalid("generation-artifacts-without-ledger-records", compatRaw);
    return { ok: true, mode: "pre-bootstrap", expectedTarget: compatRaw, reason: null, ...observed };
  }
  if (!initialized) return invalid("config-cutover-without-registry-initialization");
  // Bootstrapped but not cut over is not a valid resting state (spec: "All other combinations are
  // invalid"), so it is never ok and never moves the outer link. It gets its own mode because it is
  // the one non-ok state with a safe forward path: bootstrap replays idempotently, so the stage
  // script's cutover may resume from it after a failure at steps 2-5.
  if (!cutOver) {
    return { ok: false, mode: "bootstrap-incomplete", expectedTarget: null,
      reason: "registry-initialized-without-config-cutover", ...observed };
  }
  const expectedTarget = configCutover.mode === "generated" ? generatedTarget
    : configCutover.mode === "raw-emergency" ? rawBasePath : null;
  if (expectedTarget === null) return invalid("config-cutover-mode-unknown");
  // Exact string equality BEFORE any resolution, as the spec requires.
  if (configCutover.target !== expectedTarget) return invalid("config-cutover-target-mismatch", expectedTarget);
  if (registry.kind !== "valid") return invalid(`registry-${registry.kind}`, expectedTarget);
  if (registry.entries["0"] !== initAck.manifestHash) return invalid("registry-generation-0-mismatch", expectedTarget);

  if (configCutover.mode === "raw-emergency") {
    if (configCutover.generation !== null || configCutover.manifestHash !== null) {
      return invalid("raw-emergency-record-carries-generation", expectedTarget);
    }
    if (rawBase.kind !== "regular") return invalid(`raw-base-${rawBase.kind}`, expectedTarget);
    if (rawBase.hash !== configCutover.rawBaseHash) return invalid("raw-base-hash-mismatch", expectedTarget);
    const problem = outerLinkProblem(outerLink, rawBasePath, [generatedTarget], "outer-link-still-generated");
    if (problem) return invalid(problem, expectedTarget);
    return { ok: true, mode: "raw-emergency", expectedTarget, reason: null, ...observed };
  }

  const { generation } = configCutover;
  if (!isCount(generation) || !SHA256_HEX.test(configCutover.manifestHash ?? "")) {
    return invalid("generated-record-incomplete", expectedTarget);
  }
  // The registry legitimately grows as generations publish, so its whole-file hash is reported,
  // not pinned; the entries that must hold are generation 0 (above) and the current generation.
  if (generation > registry.highWater || registry.entries[String(generation)] !== configCutover.manifestHash) {
    return invalid("registry-generation-mismatch", expectedTarget);
  }
  if (currentLink.kind !== "symlink" || currentLink.target !== `generation-${generation}`) {
    return invalid("current-link-mismatch", expectedTarget);
  }
  if (manifest.kind !== "valid") return invalid(`manifest-${manifest.kind}`, expectedTarget);
  if (manifest.generation !== generation) return invalid("manifest-generation-mismatch", expectedTarget);
  if (manifest.hash !== configCutover.manifestHash) return invalid("manifest-hash-mismatch", expectedTarget);
  if (manifest.configKind !== "regular") return invalid(`generation-config-${manifest.configKind}`, expectedTarget);
  const problem = outerLinkProblem(outerLink, generatedTarget, [compatRaw, rawBasePath], "outer-link-still-raw");
  if (problem) return invalid(problem, expectedTarget);
  return { ok: true, mode: "generated", expectedTarget, reason: null, ...observed, generation, manifestHash: manifest.hash };
};

const toReport = (result, outerLink, ledgerRevision) => ({
  ok: result.ok,
  mode: result.mode,
  expectedTarget: result.expectedTarget,
  actualTarget: outerLink?.kind === "symlink" ? outerLink.target : null,
  generation: result.generation,
  registryHash: result.registryHash,
  manifestHash: result.manifestHash,
  rawBaseHash: result.rawBaseHash,
  ledgerRevision,
});

export const verifyDeployedConfigWith = ({ paths, store, fs = nodeFs }) => {
  const targets = { generatedTarget: paths.generatedTarget, rawBasePath: paths.rawBase, compatRaw: paths.compatRaw };
  const blank = { generation: null, registryHash: null, manifestHash: null, rawBaseHash: null };
  let facts;
  let ledgerPresent;
  try {
    facts = readDeployedFacts({ paths, fs });
    ledgerPresent = lstatOrNull(fs, store.paths().state) !== null;
  } catch (error) {
    const reason = `inspection-failed: ${error?.message ?? String(error)}`;
    return { report: toReport({ ok: false, mode: "invalid", expectedTarget: null, ...blank }, null, null), reason };
  }
  let state;
  try {
    state = store.read();
  } catch (error) {
    // Corrupt or schema-invalid ledger: report, never repair. The bytes stay for diagnosis.
    const reason = `ledger-unreadable: ${error?.message ?? String(error)}`;
    const result = { ok: false, mode: "invalid", expectedTarget: null, ...blank, registryHash: facts.registry.hash, rawBaseHash: facts.rawBase.hash };
    return { report: toReport(result, facts.outerLink, null), reason };
  }
  const result = classifyCutoverState({
    initAck: state.generationRegistryInitialized ?? null,
    configCutover: state.configCutover ?? null,
    ...facts,
  }, targets);
  return { report: toReport(result, facts.outerLink, ledgerPresent ? state.revision : null), reason: result.reason };
};
```

Inside `createCutoverController`, before the return statement, add:

```js
  const verifyDeployedConfig = () => verifyDeployedConfigWith({ paths, store, fs: fs ?? nodeFs }).report;
```

Then add this method to the returned object, next to B5's `preflightTopology` and `bootstrapGenerationZero`:

```js
    // Read-only; devbox-sync and cutover-config both call this.
    verifyDeployedConfig,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test tests/reconcile-cutover-verify.test.mjs`
Expected: PASS. All pure-table and real-filesystem tests pass with `# fail 0`.

- [ ] **Step 5: Write the failing CLI tests**

Append to `tests/reconcile-cutover-verify.test.mjs`:

```js
// ---- CLI (spawned: lib/config.js and the path resolution read the environment at import) -------

const CLI = new URL("../bin/opencode-broker-reconcile", import.meta.url).pathname;
const runVerify = (tree, ...flags) => spawnSync(process.execPath, [CLI, "verify-deployed-config", ...flags], { env: tree.env, encoding: "utf8" });

test("CLI pre-bootstrap: exit 0, exactly the nine keys, no ledger revision", () => {
  const tree = makeTree();
  const result = runVerify(tree, "--json");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report), REPORT_KEYS);
  assert.deepEqual(report, {
    ok: true, mode: "pre-bootstrap", expectedTarget: tree.paths.compatRaw, actualTarget: tree.paths.compatRaw,
    generation: null, registryHash: null, manifestHash: null, rawBaseHash: tree.rawBaseHash, ledgerRevision: null,
  });
});

test("CLI generated ok exits 0 and mutates nothing", () => {
  const tree = makeTree();
  recordCutover(tree, bootstrapArtifacts(tree), "generated");
  relink(tree.paths.outerLink, tree.paths.generatedTarget);
  const before = snapshot(tree.home);
  const result = runVerify(tree, "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, "generated");
  assert.deepEqual(snapshot(tree.home), before);
});

test("CLI RF2 intermediate: exit 20, reason on stderr, outer link untouched", () => {
  const tree = makeTree();
  recordCutover(tree, bootstrapArtifacts(tree), "generated");
  const before = snapshot(tree.home);
  const result = runVerify(tree, "--json");
  assert.equal(result.status, 20);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(report), REPORT_KEYS);
  assert.equal(report.ok, false);
  assert.equal(report.mode, "invalid");
  assert.match(result.stderr, /outer-link-still-raw/);
  assert.deepEqual(snapshot(tree.home), before);
});

test("CLI corrupt ledger: exit 20 and the ledger bytes are preserved", () => {
  const tree = makeTree();
  const ledger = join(tree.paths.stateRoot, "model-reconciliation.json");
  writePrivate(ledger, "not json");
  const result = runVerify(tree, "--json");
  assert.equal(result.status, 20);
  assert.match(result.stderr, /ledger-unreadable/);
  assert.equal(readFileSync(ledger, "utf8"), "not json");
});

test("CLI refuses an unknown flag with the usage exit code", () => {
   const result = runVerify(makeTree(), "--fix");
   assert.equal(result.status, 2);
   assert.match(result.stderr, /unknown option "--fix"/);
 });

// RF4: a provider dropped from trustedSubscriptionProviders but left in the apply allowlist makes
// the apply block invalid (B1 reports it in CONFIG.reconcile.apply.configError; it never throws).
// The convergence oracle must keep working, because devbox-sync calls it on every sync.
test("CLI verify-deployed-config still reports when the apply allowlist names an untrusted provider", () => {
  const tree = makeTree();
  const badConfig = join(tree.home, "untrusted-allowlist.json");
  writePrivate(badConfig, JSON.stringify({ trustedSubscriptionProviders: [],
    reconcile: { apply: { enabled: false, providers: ["openai"] } } }));
  const result = spawnSync(process.execPath, [CLI, "verify-deployed-config", "--json"],
    { env: { ...tree.env, OPENCODE_BROKER_CONFIG: badConfig }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "pre-bootstrap");
  assert.equal(report.ok, true);
});
```

- [ ] **Step 6: Run the CLI tests to verify they fail**

Run: `node --experimental-test-module-mocks --test --test-name-pattern "^CLI" tests/reconcile-cutover-verify.test.mjs`
Expected: FAIL. The CLI exits 2 with `unknown command "verify-deployed-config"`, so the exit-0 and exit-20 assertions fail. The unknown-flag test may already pass; that is acceptable.

- [ ] **Step 7: Wire the CLI in `bin/opencode-broker-reconcile`**

Add these imports. If B5 already imports from `../lib/reconcile-cutover.js`, add the two names to that import line instead:

```js
import * as nodeFs from "node:fs";
import { resolveCutoverPaths, verifyDeployedConfigWith } from "../lib/reconcile-cutover.js";
```

`createReconciliationStore` is already imported from `../lib/reconcile-state.js` (bin line 56); do not import it a second time. The static `import { CONFIG, CONFIG_ERROR } from "../lib/config.js"` stays: `lib/config.js` never throws at import (a parse failure sets `CONFIG_ERROR`, and an invalid apply block, including an untrusted allowlisted provider, sets `CONFIG.reconcile.apply.configError` per Task B1), so the verifier only has to be dispatched before the gates that read them.

Append this line to the `USAGE` array, before `].join("\n");`:

```js
  "  verify-deployed-config [--json]       read-only check of the outer config link against the ledger",
```

Add this entry to `FLAG_ONLY`:

```js
  "verify-deployed-config": ["--json"],
```

Add this beside `EXIT_USAGE`:

```js
// Job-run contract: the deployed config is in a state a human must look at.
const EXIT_NEEDS_ATTENTION = 20;
```

Add this runner above `const run = async (argv) => {`:

```js
// devbox-sync's convergence oracle. It needs no broker routing config, so it runs BEFORE the
// CONFIG_ERROR gate: a broken broker config must not also leave the outer link unverifiable.
const runVerifyDeployedConfig = (json) => {
   let verdict;
   try {
     const paths = resolveCutoverPaths(process.env);
     const store = createReconciliationStore({ root: paths.stateRoot });
     verdict = verifyDeployedConfigWith({ paths, store, fs: nodeFs });
   } catch (error) {
     complain(`verify-deployed-config: ${error?.message ?? String(error)}`);
     return EXIT_ERROR;
   }
   const { report, reason } = verdict;
   write(json ? JSON.stringify(report, null, 2) : `verify-deployed-config: ${report.mode}${report.ok ? "" : ` (${reason})`}`);
   if (!report.ok) complain(`verify-deployed-config: ${reason}`);
   return report.ok ? EXIT_OK : EXIT_NEEDS_ATTENTION;
};
```

In `run`, insert this line directly after the `if (options.error) { ... return EXIT_USAGE; }` block:

```js
  if (options.command === "verify-deployed-config") return runVerifyDeployedConfig(options.json);
```

- [ ] **Step 8: Run the tests to verify they pass, then run the full suite**

Run: `node --experimental-test-module-mocks --test tests/reconcile-cutover-verify.test.mjs`
Expected: PASS with `# fail 0`.

Run: `npm test`
Expected: PASS with `# fail 0`. `tests/reconcile-cli.test.mjs` still passes, because existing commands and their exit codes are unchanged.

- [ ] **Step 9: Commit**

```bash
git add lib/reconcile-cutover.js bin/opencode-broker-reconcile tests/reconcile-cutover-verify.test.mjs
git commit -m "feat(reconcile): add read-only verify-deployed-config with exact cutover state classification"
```

### Task B6b: Config cutover and raw-emergency rollback (`cutoverConfig`, `rollbackConfigRawEmergency`)

**Files:**
- Modify: `lib/reconcile-cutover.js`. Add the module-level factory `createConfigCutoverOperations` and its helpers. Then spread its two methods into the object that `createCutoverController` returns.
- Modify: `bin/opencode-broker-reconcile`. Add the `cutover-config` and `rollback-config --raw-emergency` parsing, the usage lines and the dispatch.
- Test: `tests/reconcile-cutover-config.test.mjs` (new)

**Interfaces:**
- Consumes (Package 3, verified at `lib/resolver-generations.js:581-950`). `createResolverGenerationManager({ root, currentLinkPath, runResolver, now, pid })` returns `{ readRegistry, build, publish, generation, current, cleanup, paths }`:
  - `generation(n)` returns `{ generation, directory, manifest, manifestHash, effectiveHash }` and throws on any corrupt or unregistered bundle.
  - `current()` returns that same bundle, or `null` when the link is absent. It throws on a non-canonical link.
  - `publish(bundle)` re-publishes an already-registered generation 0 without writing the registry (`existing` branch, lines 862-867), then atomically renames `current`.
  - `paths()` returns `{ root, registry, lock, currentLink }`.
- Consumes (Package 1, `lib/reconcile-state.js:488-513`). `createReconciliationStore({ root, now })` returns `{ read, update(mutator), paths }`. `update` hands the mutator a detached clone and writes exactly what it returns. A throw inside the mutator aborts the update with no write.
- Consumes (B2): the ledger keys `generationRegistryInitialized` and `configCutover`, using the spec schemas, plus their validators inside `update`.
- Consumes (B5):
   - `createCutoverController({ paths, store, generations, clock, fs, verifyRawTopology })`.
   - `bootstrapGenerationZero(): Promise<{ ok: boolean, ... }>`.
   - `paths` keys used here: `rawBase`, `outerLink`, `compatRaw`, `generatedTarget`.
   - `clock(): number` (epoch ms).
   - CLI factory `createCutoverRuntime()`, defined by B5 in `bin/opencode-broker-reconcile`. It builds the controller from the `OPENCODE_RECONCILE_*` env and returns the controller object.
   - CLI constant `EXIT_NEEDS_ATTENTION = 20`, defined by B6a in `bin/opencode-broker-reconcile`.
- Consumes (B6a): `verifyDeployedConfig()` from the controller, returning `{ ok, mode, expectedTarget, actualTarget, generation, registryHash, manifestHash, rawBaseHash, ledgerRevision }`. `ledgerRevision` is an integer or null when the ledger file is absent, and is reported in every mode, including `invalid` and `bootstrap-incomplete`.
- Produces (B8, the runbook and F4 rely on these):
  - `createConfigCutoverOperations({ paths, store, generations, clock, fs, verifyDeployedConfig })` returns `{ cutoverConfig, rollbackConfigRawEmergency }`.
  - `controller.cutoverConfig(): Promise<CutoverResult>`.
  - `controller.rollbackConfigRawEmergency(): Promise<CutoverResult>`.
  - `CutoverResult` is one of two shapes:
    - success: `{ ok: true, changed: boolean, phase: "completed" | "already-complete", steps: string[], verification }`
    - refusal: `{ ok: false, code: string, reason: string, mutated: false, ...detail }`
  - Refusal codes: `not-bootstrapped`, `raw-emergency-active`, `deployed-config-invalid`, `cutover-record-mismatch`, `outer-link-unexpected`, `generation-zero-invalid`, `registry-hash-mismatch`, `manifest-hash-mismatch`, `raw-base-hash-mismatch`, `current-link-invalid`, `current-link-missing`, `current-link-mismatch`, `stale-cas`, `no-generated-cutover`. The CLI adds `reconcile-apply-enabled`.
  - Unexpected I/O failures, including a crash simulated between steps, throw.
  - CLI: `cutover-config --json` and `rollback-config --raw-emergency --json`. Exit 0 when `ok`, 20 on a refusal, 1 on a thrown failure, 2 on a usage error.

Locking: per the contract, the singleton writer's kernel lock is the stage script's `flock` on `EXPANSION_LOCK`, held for the whole run. The broker takes no flock of its own. Inside one invocation, the Package 3 manager lock (around `publish`) and the store lock (around `update`) serialize their own writes. Every CAS re-checks the ledger inside `update`.

- [ ] **Step 1: Write the failing tests**

Create `tests/reconcile-cutover-config.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { afterEach } from "node:test";

import { createCutoverController } from "../lib/reconcile-cutover.js";
import { createReconciliationStore } from "../lib/reconcile-state.js";
import { createResolverGenerationManager } from "../lib/resolver-generations.js";

const NOW = 1_800_000_000_000;
const CLI = new URL("../bin/opencode-broker-reconcile", import.meta.url).pathname;
const ZERO_COST = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const RAW = {
  $schema: "https://opencode.ai/config.json",
  provider: { openai: { models: { "gpt-5.6-sol": { name: "GPT 5.6 Sol", limit: { context: 400_000, output: 128_000 }, cost: { ...ZERO_COST } } } } },
};
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const modelKeys = (config) => Object.entries(config.provider ?? {})
  .flatMap(([providerID, provider]) => Object.keys(provider.models ?? {}).map((id) => `${providerID}/${id}`)).sort();
// The fake resolver lists exactly the provider/model keys in the config it was handed, which is
// what `opencode models --pure` prints.
const listModels = async ({ configPath }) => `${modelKeys(JSON.parse(readFileSync(configPath, "utf8"))).join("\n")}\n`;

// Builds the production topology in miniature: devbox raw base (0600), fleet-core -> devbox
// compatibility symlink, outer link -> fleet-core raw path, and a 0700 state root.
const fixture = (label) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `cutover-config-${label}-`)));
  roots.push(base);
  const devbox = join(base, "devbox");
  const fleetCore = join(base, "fleet-core");
  const rawBase = join(devbox, "config/opencode/opencode.json");
  mkdirSync(dirname(rawBase), { recursive: true });
  writeFileSync(rawBase, `${JSON.stringify(RAW, null, 2)}\n`, { mode: 0o600 });
  symlinkSync(devbox, fleetCore);
  const compatRaw = join(fleetCore, "config/opencode/opencode.json");
  const home = join(base, "home");
  const outerLink = join(home, ".config/opencode/opencode.json");
  mkdirSync(dirname(outerLink), { recursive: true });
  symlinkSync(compatRaw, outerLink);
  const stateRoot = join(base, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  const generationsRoot = join(stateRoot, "resolver-generations");
  const currentLink = join(generationsRoot, "current");
  const paths = {
    rawBase, outerLink, compatRaw, fleetCore, devbox, stateRoot,
    overlay: join(stateRoot, "resolver-overlay.json"),
    generationsRoot, currentLink,
    generatedTarget: join(currentLink, "opencode.json"),
    registry: join(generationsRoot, "resolver-generations.json"),
    ledger: join(stateRoot, "model-reconciliation.json"),
    legacyLedger: join(stateRoot, "reviewed-models.json"),
    expansionLock: join(stateRoot, "provider-expansion.lock"),
  };
  // The raw-emergency target must be this fixture's raw base; the store default names production.
  const store = createReconciliationStore({ root: stateRoot, now: () => NOW, configTargets: { rawEmergency: rawBase } });
  const generations = createResolverGenerationManager({
    root: generationsRoot, currentLinkPath: currentLink, runResolver: listModels, now: () => NOW, pid: 11,
  });
  // No verifyRawTopology stub: the fixture builds the exact real chain, and bootstrap needs the
  // real check's rawBaseHash to pin generation 0.
  const make = (overrides = {}) => createCutoverController({
    paths, store: overrides.store ?? store, generations, clock: () => NOW,
    fs: overrides.fs ?? nodeFs,
  });
  return { base, home, paths, store, generations, make };
};

const bootstrapped = async (label) => {
  const f = fixture(label);
  const result = await f.make().bootstrapGenerationZero();
  assert.equal(result.ok, true, JSON.stringify(result));
  return f;
};

const cutOver = async (label) => {
  const f = await bootstrapped(label);
  const result = await f.make().cutoverConfig();
  assert.equal(result.ok, true, JSON.stringify(result));
  return f;
};

// An fs whose renameSync onto one destination throws once: the host dying between two writes.
const crashRenameOnce = (destination) => {
  let armed = true;
  return {
    ...nodeFs,
    renameSync(from, to) {
      if (armed && to === destination) {
        armed = false;
        throw Object.assign(new Error("simulated host restart"), { code: "ESIMCRASH" });
      }
      return nodeFs.renameSync(from, to);
    },
  };
};

const absent = (path) => { assert.throws(() => lstatSync(path), { code: "ENOENT" }); };

test("cutover-config switches current to generation 0, CASes configCutover, retargets and verifies", async () => {
  const f = await bootstrapped("happy");
  const initAck = f.store.read().generationRegistryInitialized;
  const registryBefore = readFileSync(f.paths.registry);
  absent(f.paths.currentLink);

  const result = await f.make().cutoverConfig();

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.phase, "completed");
  assert.deepEqual(result.steps, ["current-switched", "config-cutover-recorded", "outer-link-retargeted"]);
  assert.equal(readlinkSync(f.paths.currentLink), "generation-0");
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.generatedTarget);
  assert.deepEqual(readFileSync(f.paths.registry), registryBefore, "re-publishing generation 0 must not rewrite the registry");
  const state = f.store.read();
  assert.deepEqual(state.generationRegistryInitialized, initAck);
  assert.equal(Number.isInteger(state.configCutover.sourceLedgerRevision) && state.configCutover.sourceLedgerRevision >= 0, true);
  assert.deepEqual(state.configCutover, {
    schemaVersion: 1, mode: "generated", target: f.paths.generatedTarget, generation: 0,
    manifestHash: initAck.manifestHash, registryHash: initAck.registryHash, rawBaseHash: initAck.rawBaseHash,
    sourceLedgerRevision: state.configCutover.sourceLedgerRevision,
    changedAt: new Date(NOW).toISOString(), reason: "bootstrap",
  });
  const verification = f.make().verifyDeployedConfig();
  assert.equal(verification.ok, true);
  assert.equal(verification.mode, "generated");
  assert.deepEqual(readdirSync(dirname(f.paths.outerLink)), ["opencode.json"], "no temp link left behind");
});

test("cutover-config replay after completion is an exact no-op", async () => {
  const f = await cutOver("replay");
  const ledgerBytes = readFileSync(f.paths.ledger);
  const result = await f.make().cutoverConfig();
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.phase, "already-complete");
  assert.deepEqual(readFileSync(f.paths.ledger), ledgerBytes);
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.generatedTarget);
});

test("RF2: restart between configCutover CAS and outer retarget is invalid until a rerun completes it", async () => {
  const f = await bootstrapped("rf2");
  await assert.rejects(f.make({ fs: crashRenameOnce(f.paths.outerLink) }).cutoverConfig(), /simulated host restart/);

  const recorded = f.store.read().configCutover;
  assert.equal(recorded.mode, "generated");
  assert.equal(readlinkSync(f.paths.currentLink), "generation-0");
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.compatRaw, "outer link still on the pre-cutover chain");
  assert.deepEqual(readdirSync(dirname(f.paths.outerLink)), ["opencode.json"]);
  const intermediate = f.make().verifyDeployedConfig();
  assert.equal(intermediate.ok, false);
  assert.equal(intermediate.mode, "invalid");

  const rerun = await f.make().cutoverConfig();
  assert.equal(rerun.ok, true);
  assert.deepEqual(rerun.steps, ["current-already-generation-0", "config-cutover-already-recorded", "outer-link-retargeted"]);
  assert.deepEqual(f.store.read().configCutover, recorded, "recovery completes from evidence, never rewrites it");
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.generatedTarget);
  assert.equal(f.make().verifyDeployedConfig().mode, "generated");
});

test("restart between current switch and configCutover CAS replays without a second switch", async () => {
  const f = await bootstrapped("pre-cas");
  const crashingStore = { ...f.store, update() { throw new Error("simulated crash before configCutover CAS"); } };
  await assert.rejects(f.make({ store: crashingStore }).cutoverConfig(), /before configCutover CAS/);
  assert.equal(readlinkSync(f.paths.currentLink), "generation-0");
  assert.equal(f.store.read().configCutover ?? null, null);
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.compatRaw);

  const rerun = await f.make().cutoverConfig();
  assert.equal(rerun.ok, true);
  assert.deepEqual(rerun.steps, ["current-already-generation-0", "config-cutover-recorded", "outer-link-retargeted"]);
});

test("a process starting inside the swap window loads only the raw base, then new processes load generation 0", async () => {
  const f = await bootstrapped("window");
  const rawBytes = readFileSync(f.paths.rawBase, "utf8");
  let windowLoad = null;
  const observingFs = {
    ...nodeFs,
    renameSync(from, to) {
      if (to === f.paths.outerLink && windowLoad === null) {
        // A new OpenCode process starting now: current already switched, outer link not yet.
        windowLoad = {
          current: readlinkSync(f.paths.currentLink),
          via: readlinkSync(f.paths.outerLink),
          bytes: readFileSync(f.paths.outerLink, "utf8"),
        };
      }
      return nodeFs.renameSync(from, to);
    },
  };
  const result = await f.make({ fs: observingFs }).cutoverConfig();
  assert.equal(result.ok, true);
  assert.equal(windowLoad.current, "generation-0");
  assert.equal(windowLoad.via, f.paths.compatRaw);
  assert.equal(windowLoad.bytes, rawBytes, "window process loads the canonical raw base");
  const generationZero = JSON.parse(readFileSync(join(f.paths.generationsRoot, "generation-0/opencode.json"), "utf8"));
  assert.deepEqual(modelKeys(JSON.parse(windowLoad.bytes)), modelKeys(RAW));
  assert.deepEqual(modelKeys(generationZero), modelKeys(RAW), "generation 0 adds no overlay-only model");
  assert.deepEqual(JSON.parse(readFileSync(f.paths.outerLink, "utf8")), generationZero);
});

test("cutover-config refuses without mutation on missing ack, foreign outer link, or drifted raw base", async () => {
  const bare = fixture("no-ack");
  const none = await bare.make().cutoverConfig();
  assert.equal(none.code, "not-bootstrapped");
  assert.equal(none.mutated, false);
  assert.equal(readlinkSync(bare.paths.outerLink), bare.paths.compatRaw);

  const foreign = await bootstrapped("foreign");
  const elsewhere = join(foreign.base, "elsewhere.json");
  writeFileSync(elsewhere, "{}\n", { mode: 0o600 });
  unlinkSync(foreign.paths.outerLink);
  symlinkSync(elsewhere, foreign.paths.outerLink);
  const foreignResult = await foreign.make().cutoverConfig();
  assert.equal(foreignResult.code, "outer-link-unexpected");
  absent(foreign.paths.currentLink);
  assert.equal(foreign.store.read().configCutover ?? null, null);
  assert.equal(readlinkSync(foreign.paths.outerLink), elsewhere);

  const drifted = await bootstrapped("drifted");
  writeFileSync(drifted.paths.rawBase, `${JSON.stringify({ ...RAW, extra: true }, null, 2)}\n`, { mode: 0o600 });
  const driftResult = await drifted.make().cutoverConfig();
  assert.equal(driftResult.code, "raw-base-hash-mismatch");
  absent(drifted.paths.currentLink);
  assert.equal(readlinkSync(drifted.paths.outerLink), drifted.paths.compatRaw);
});

test("rollback-config --raw-emergency CASes raw-emergency, retains artifacts, retargets to the direct raw base", async () => {
  const f = await cutOver("rollback");
  const before = f.store.read();
  const registryBefore = readFileSync(f.paths.registry);

  const result = await f.make().rollbackConfigRawEmergency();

  assert.equal(result.ok, true);
  assert.equal(result.phase, "completed");
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.rawBase, "direct devbox target, not the compat chain");
  const after = f.store.read();
  assert.deepEqual(after.generationRegistryInitialized, before.generationRegistryInitialized);
  assert.deepEqual(after.configCutover, {
    schemaVersion: 1, mode: "raw-emergency", target: f.paths.rawBase, generation: null, manifestHash: null,
    registryHash: before.configCutover.registryHash, rawBaseHash: before.configCutover.rawBaseHash,
    sourceLedgerRevision: after.configCutover.sourceLedgerRevision,
    changedAt: new Date(NOW).toISOString(), reason: "emergency-rollback",
  });
  assert.equal(Number.isInteger(after.configCutover.sourceLedgerRevision), true);
  assert.deepEqual(readFileSync(f.paths.registry), registryBefore);
  assert.equal(existsSync(join(f.paths.generationsRoot, "generation-0/manifest.json")), true);
  assert.equal(readlinkSync(f.paths.currentLink), "generation-0");
  assert.equal(f.make().verifyDeployedConfig().mode, "raw-emergency");

  const blocked = await f.make().cutoverConfig();
  assert.equal(blocked.code, "raw-emergency-active");
});

test("rollback works when generation 0 itself is corrupt", async () => {
  const f = await cutOver("corrupt-zero");
  unlinkSync(join(f.paths.generationsRoot, "generation-0/manifest.json"));
  const result = await f.make().rollbackConfigRawEmergency();
  assert.equal(result.ok, true);
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.rawBase);
  assert.equal(f.store.read().configCutover.mode, "raw-emergency");
});

test("rollback aborts on a stale configCutover CAS and leaves the link alone", async () => {
  const f = await cutOver("stale");
  const racing = {
    ...f.store,
    update(mutator) {
      // A competing writer must itself be a valid ledger write, so it stamps its own revision.
      f.store.update((state, { revision }) => ({
        ...state,
        configCutover: { ...state.configCutover, changedAt: "2027-01-01T00:00:00.000Z", sourceLedgerRevision: revision },
      }));
      return f.store.update(mutator);
    },
  };
  const result = await f.make({ store: racing }).rollbackConfigRawEmergency();
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale-cas");
  assert.equal(result.mutated, false);
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.generatedTarget);
  assert.equal(f.store.read().configCutover.mode, "generated");
});

test("rollback refuses before cutover and on a drifted raw base", async () => {
  const pre = await bootstrapped("rollback-pre");
  const preResult = await pre.make().rollbackConfigRawEmergency();
  assert.equal(preResult.code, "no-generated-cutover");
  assert.equal(readlinkSync(pre.paths.outerLink), pre.paths.compatRaw);

  const drifted = await cutOver("rollback-drift");
  writeFileSync(drifted.paths.rawBase, "{\"edited\":true}\n", { mode: 0o600 });
  const driftResult = await drifted.make().rollbackConfigRawEmergency();
  assert.equal(driftResult.code, "raw-base-hash-mismatch");
  assert.equal(readlinkSync(drifted.paths.outerLink), drifted.paths.generatedTarget);
  assert.equal(drifted.store.read().configCutover.mode, "generated");
});

test("rollback interrupted before the retarget completes on rerun, then replays as a no-op", async () => {
  const f = await cutOver("rollback-crash");
  await assert.rejects(f.make({ fs: crashRenameOnce(f.paths.outerLink) }).rollbackConfigRawEmergency(), /simulated host restart/);
  assert.equal(f.store.read().configCutover.mode, "raw-emergency");
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.generatedTarget);

  const rerun = await f.make().rollbackConfigRawEmergency();
  assert.equal(rerun.ok, true);
  assert.equal(rerun.phase, "completed");
  assert.deepEqual(rerun.steps, ["config-cutover-already-raw-emergency", "outer-link-retargeted"]);
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.rawBase);

  const replay = await f.make().rollbackConfigRawEmergency();
  assert.equal(replay.phase, "already-complete");
  assert.equal(replay.changed, false);
});

// ---- CLI ------------------------------------------------------------------------------------

const runCLI = (f, args, config = { targets: {}, tiers: {} }) => {
  const configPath = join(f.base, "broker-config.json");
  // A string is written verbatim, so a test can hand the CLI an unparseable config.
  writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...clean,
      HOME: f.home,
      XDG_CONFIG_HOME: join(f.home, ".config"),
      OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_MODEL_ROUTING_DIR: f.paths.stateRoot,
      OPENCODE_RECONCILE_STATE_ROOT: f.paths.stateRoot,
      OPENCODE_RECONCILE_RAW_BASE: f.paths.rawBase,
      OPENCODE_RECONCILE_OUTER_LINK: f.paths.outerLink,
      OPENCODE_RECONCILE_COMPAT_RAW: f.paths.compatRaw,
      OPENCODE_RECONCILE_FLEET_CORE: f.paths.fleetCore,
      OPENCODE_RECONCILE_DEVBOX: f.paths.devbox,
    },
  });
};

test("CLI cutover-config and rollback-config --raw-emergency report refusals with exit 20 and no mutation", () => {
  const f = fixture("cli");
  const cutover = runCLI(f, ["cutover-config", "--json"]);
  assert.equal(cutover.status, 20, cutover.stderr);
  assert.deepEqual(
    (({ ok, code, mutated }) => ({ ok, code, mutated }))(JSON.parse(cutover.stdout)),
    { ok: false, code: "not-bootstrapped", mutated: false },
  );
  const rollback = runCLI(f, ["rollback-config", "--raw-emergency", "--json"]);
  assert.equal(rollback.status, 20, rollback.stderr);
  assert.equal(JSON.parse(rollback.stdout).code, "not-bootstrapped");
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.compatRaw);
  assert.equal(existsSync(f.paths.ledger), false);
});

test("CLI refuses cutover-config while apply is enabled, and rejects malformed rollback-config", () => {
  const f = fixture("cli-flags");
  const enabled = runCLI(f, ["cutover-config", "--json"], {
    targets: {}, tiers: {}, trustedSubscriptionProviders: ["openai"],
    reconcile: { apply: {
      enabled: true, providers: ["openai"], overlayPath: f.paths.overlay,
      generationsRoot: f.paths.generationsRoot, currentLinkPath: f.paths.currentLink,
    } },
  });
  assert.equal(enabled.status, 20, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).code, "reconcile-apply-enabled");
  assert.equal(runCLI(f, ["rollback-config", "--json"]).status, 2);
  assert.equal(runCLI(f, ["cutover-config", "--bogus"]).status, 2);
  assert.equal(runCLI(f, ["rollback-config", "--raw-emergency", "--force"]).status, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-test-module-mocks --test tests/reconcile-cutover-config.test.mjs`
Expected: FAIL.
- Controller tests: `TypeError: f.make(...).cutoverConfig is not a function` and `... rollbackConfigRawEmergency is not a function`.
- CLI tests: exit status `2` instead of `20`, with stderr `unknown command "cutover-config"` / `unknown command "rollback-config"`. The `--bogus` and `--json`-only assertions already see 2, but each of those tests fails on its first assertion.

- [ ] **Step 3: Implement the operations in `lib/reconcile-cutover.js`**

Add these imports at the top of the file. Merge them with any identical imports B5 already added; do not duplicate a binding.

```js
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
```

Add at module level, above `createCutoverController`:

```js
const HEX64 = /^[0-9a-f]{64}$/;
const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Thrown only from inside a store.update mutator, so the update writes nothing; the caller turns
// it into a structured "stale-cas" refusal rather than a crash.
class ConfigCutoverCasError extends Error {}

const refusal = (code, reason, detail = {}) => ({ ok: false, code, reason, mutated: false, ...detail });

const linkState = (fs, path) => {
  let stat;
  try { stat = fs.lstatSync(path); } catch (error) {
    if (error?.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (!stat.isSymbolicLink()) return { kind: "not-symlink" };
  return { kind: "symlink", target: fs.readlinkSync(path) };
};

const realpathOrNull = (fs, path) => {
  try { return fs.realpathSync(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const fsyncDirectory = (fs, path) => {
  const fd = fs.openSync(path, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

// Atomic symlink replacement: a temp link in the same directory renamed over the live one, then
// the directory fsynced, then the exact link text re-read. The target string is compared
// verbatim -- never canonicalized -- because the spec approves exact strings, not resolutions.
const retargetSymlink = (fs, linkPath, target) => {
  const temp = join(dirname(linkPath), `.${basename(linkPath)}.cutover.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.symlinkSync(target, temp);
    fs.renameSync(temp, linkPath);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        throw new AggregateError([error, cleanupError], `outer link retarget failed and temp link ${temp} could not be removed`);
      }
    }
    throw error;
  }
  fsyncDirectory(fs, dirname(linkPath));
  const after = linkState(fs, linkPath);
  if (after.kind !== "symlink" || after.target !== target) {
    throw new Error(`outer config link does not read back as ${target} after retarget`);
  }
};

export const createConfigCutoverOperations = ({ paths, store, generations, clock, fs, verifyDeployedConfig }) => {
  const changedAt = () => new Date(clock()).toISOString();

  const outerIsPreCutover = (outer) => outer.kind === "symlink"
    && outer.target === paths.compatRaw
    && realpathOrNull(fs, paths.outerLink) === paths.rawBase;

  const isBootstrapRecord = (record, initAck) => record.schemaVersion === 1
    && record.mode === "generated"
    && record.target === paths.generatedTarget
    && record.generation === 0
    && record.manifestHash === initAck.manifestHash
    && record.registryHash === initAck.registryHash
    && record.rawBaseHash === initAck.rawBaseHash
    && record.reason === "bootstrap";

  const isRetainedEmergencyRecord = (record, initAck) => record.schemaVersion === 1
    && record.mode === "raw-emergency"
    && record.target === paths.rawBase
    && record.generation === null
    && record.manifestHash === null
    && HEX64.test(record.registryHash)
    && record.rawBaseHash === initAck.rawBaseHash
    && record.reason === "emergency-rollback";

  const rawBaseMatches = (expectedHash) => sha256Bytes(fs.readFileSync(paths.rawBase)) === expectedHash;

  // Generation 0 must still be byte-for-byte the artifact set the init ack pinned.
  const verifyGenerationZero = (initAck) => {
    if (sha256Bytes(fs.readFileSync(generations.paths().registry)) !== initAck.registryHash) {
      return refusal("registry-hash-mismatch", "resolver-generations.json no longer matches generationRegistryInitialized.registryHash");
    }
    let bundle;
    try { bundle = generations.generation(0); } catch (error) {
      return refusal("generation-zero-invalid", error.message);
    }
    if (bundle.manifestHash !== initAck.manifestHash) {
      return refusal("manifest-hash-mismatch", "generation-0 manifest.json no longer matches the init ack");
    }
    if (bundle.manifest.baseHash !== initAck.rawBaseHash || !rawBaseMatches(initAck.rawBaseHash)) {
      return refusal("raw-base-hash-mismatch", `${paths.rawBase} no longer matches the pinned rawBaseHash`);
    }
    return { ok: true, bundle };
  };

  const casConfigCutover = (expectedRecord, initAck, next) => {
    try {
      // CONTRACT v2: sourceLedgerRevision is the ENCLOSING update's revision, which only the
      // store knows; `next` is a builder so the record is stamped inside the mutator.
      store.update((draft, { revision }) => {
        if (!isDeepStrictEqual(draft.configCutover ?? null, expectedRecord)) {
          throw new ConfigCutoverCasError("configCutover changed after this run read the ledger");
        }
        if (!isDeepStrictEqual(draft.generationRegistryInitialized, initAck)) {
          throw new ConfigCutoverCasError("generationRegistryInitialized changed after this run read the ledger");
        }
        return { ...draft, configCutover: next(revision) };
      });
      return null;
    } catch (error) {
      if (error instanceof ConfigCutoverCasError) return refusal("stale-cas", error.message);
      throw error;
    }
  };

  const finish = (steps, expectedMode) => {
    const verification = verifyDeployedConfig();
    if (!verification.ok || verification.mode !== expectedMode) {
      throw new Error(`writes completed but verify-deployed-config reports mode ${verification.mode} (ok=${verification.ok}); expected ${expectedMode}`);
    }
    return { ok: true, changed: true, phase: "completed", steps, verification };
  };

  const cutoverConfig = async () => {
    const state = store.read();
    const initAck = state.generationRegistryInitialized ?? null;
    if (initAck === null) return refusal("not-bootstrapped", "generationRegistryInitialized is absent; run bootstrap-generation-zero first");
    const record = state.configCutover ?? null;
    const outer = linkState(fs, paths.outerLink);

    if (record?.mode === "raw-emergency") {
      return refusal("raw-emergency-active", "configCutover is raw-emergency; cutover-config never reactivates it");
    }
    if (record?.mode === "generated" && outer.kind === "symlink" && outer.target === paths.generatedTarget) {
      const verification = verifyDeployedConfig();
      if (verification.ok && verification.mode === "generated") {
        return { ok: true, changed: false, phase: "already-complete", steps: [], verification };
      }
      return refusal("deployed-config-invalid", "outer link is generated but verification fails", { verification });
    }
    // From here the outer link must still be the pre-cutover chain. A record, if any, must be the
    // exact bootstrap record this command would have written (RF2 intermediate state).
    if (record !== null && !isBootstrapRecord(record, initAck)) {
      return refusal("cutover-record-mismatch", "configCutover does not match the generation-0 bootstrap evidence");
    }
    if (!outerIsPreCutover(outer)) {
      return refusal("outer-link-unexpected", `outer link is neither ${paths.compatRaw} (resolving to ${paths.rawBase}) nor the generated target`);
    }
    const zero = verifyGenerationZero(initAck);
    if (!zero.ok) return zero;

    let current;
    try { current = generations.current(); } catch (error) {
      return refusal("current-link-invalid", error.message);
    }
    const steps = [];
    if (current === null) {
      if (record !== null) return refusal("current-link-missing", "configCutover is recorded but resolver-generations/current is absent");
      await generations.publish(zero.bundle);
      if (sha256Bytes(fs.readFileSync(generations.paths().registry)) !== initAck.registryHash) {
        throw new Error("generation-0 switch rewrote the registry; refusing to continue");
      }
      steps.push("current-switched");
    } else if (current.generation !== 0 || current.manifestHash !== initAck.manifestHash) {
      return refusal("current-link-mismatch", `resolver-generations/current points at generation ${current.generation}, not the pinned generation 0`);
    } else {
      steps.push("current-already-generation-0");
    }

    if (record === null) {
      const next = (revision) => ({
        schemaVersion: 1, mode: "generated", target: paths.generatedTarget, generation: 0,
        manifestHash: initAck.manifestHash, registryHash: initAck.registryHash, rawBaseHash: initAck.rawBaseHash,
        sourceLedgerRevision: revision, changedAt: changedAt(), reason: "bootstrap",
      });
      const stale = casConfigCutover(null, initAck, next);
      if (stale) return stale;
      steps.push("config-cutover-recorded");
    } else {
      steps.push("config-cutover-already-recorded");
    }
    retargetSymlink(fs, paths.outerLink, paths.generatedTarget);
    steps.push("outer-link-retargeted");
    return finish(steps, "generated");
  };

  // Deliberately does NOT validate generation 0: this path exists for when it is unusable.
  const rollbackConfigRawEmergency = async () => {
    const state = store.read();
    const initAck = state.generationRegistryInitialized ?? null;
    if (initAck === null) return refusal("not-bootstrapped", "generationRegistryInitialized is absent; nothing to roll back");
    const record = state.configCutover ?? null;
    const outer = linkState(fs, paths.outerLink);
    const outerIsGenerated = outer.kind === "symlink" && outer.target === paths.generatedTarget;

    if (record?.mode === "raw-emergency") {
      if (!isRetainedEmergencyRecord(record, initAck)) return refusal("cutover-record-mismatch", "raw-emergency record does not match retained evidence");
      if (!rawBaseMatches(record.rawBaseHash)) return refusal("raw-base-hash-mismatch", `${paths.rawBase} does not match the retained rawBaseHash`);
      if (outer.kind === "symlink" && outer.target === paths.rawBase) {
        const verification = verifyDeployedConfig();
        if (verification.ok && verification.mode === "raw-emergency") {
          return { ok: true, changed: false, phase: "already-complete", steps: [], verification };
        }
        return refusal("deployed-config-invalid", "outer link is raw-emergency but verification fails", { verification });
      }
      if (!outerIsGenerated) return refusal("outer-link-unexpected", "raw-emergency recovery requires the outer link at the generated target");
      retargetSymlink(fs, paths.outerLink, paths.rawBase);
      return finish(["config-cutover-already-raw-emergency", "outer-link-retargeted"], "raw-emergency");
    }
    if (record?.mode !== "generated") return refusal("no-generated-cutover", "rollback requires configCutover.mode=generated");
    if (record.schemaVersion !== 1
      || record.target !== paths.generatedTarget
      || !Number.isInteger(record.generation) || record.generation < 0
      || !HEX64.test(record.manifestHash ?? "")
      || !HEX64.test(record.registryHash ?? "")
      || record.rawBaseHash !== initAck.rawBaseHash
      || !Number.isInteger(record.sourceLedgerRevision) || record.sourceLedgerRevision < 0) {
      return refusal("cutover-record-mismatch", "generated configCutover is not an exact, internally consistent record");
    }
    // Hash the exact canonical raw target BEFORE pointing anything at it.
    if (!rawBaseMatches(record.rawBaseHash)) return refusal("raw-base-hash-mismatch", `${paths.rawBase} does not match configCutover.rawBaseHash`);
    if (!outerIsGenerated && !outerIsPreCutover(outer)) {
      return refusal("outer-link-unexpected", "outer link is neither the generated target nor the pre-cutover chain");
    }
    const next = (revision) => ({
      schemaVersion: 1, mode: "raw-emergency", target: paths.rawBase, generation: null, manifestHash: null,
      registryHash: record.registryHash, rawBaseHash: record.rawBaseHash,
      sourceLedgerRevision: revision, changedAt: changedAt(), reason: "emergency-rollback",
    });
    const stale = casConfigCutover(record, initAck, next);
    if (stale) return stale;
    retargetSymlink(fs, paths.outerLink, paths.rawBase);
    return { ...finish(["config-cutover-raw-emergency-recorded", "outer-link-retargeted"], "raw-emergency"), previous: record };
  };

  return { cutoverConfig, rollbackConfigRawEmergency };
};
```

Inside `createCutoverController`, after `verifyDeployedConfig` is defined (B6a), add:

```js
  const configOps = createConfigCutoverOperations({ paths, store, generations, clock, fs, verifyDeployedConfig });
```

Then add `...configOps,` to the controller's returned object, next to `verifyDeployedConfig`.

- [ ] **Step 4: Add the CLI subcommands in `bin/opencode-broker-reconcile`**

Append these lines to `USAGE`, before `].join("\n")`:

```js
  "  cutover-config [--json]               switch current to generation 0 and retarget the outer link",
  "  rollback-config --raw-emergency [--json]",
  "                                        audited raw-base emergency rollback of the outer link",
```

Add `"cutover-config": ["--json"],` to `FLAG_ONLY`. Then add the parser after `parseRollback`:

```js
// rollback-config names its mode explicitly; with no mode it is a usage error, never a default.
const parseRollbackConfig = (argv) => {
  const flags = { json: false, rawEmergency: false };
  for (const flag of argv) {
    if (flag === "--json") flags.json = true;
    else if (flag === "--raw-emergency") flags.rawEmergency = true;
    else return { error: `unknown option "${flag}"` };
  }
  if (!flags.rawEmergency) return { error: "rollback-config needs --raw-emergency" };
  return { command: "rollback-config", ...flags };
};
```

In `parseArgs`, add `if (command === "rollback-config") return parseRollbackConfig(rest);` after the `recover` line. Then add the runner above `run`:

```js
// The cutover window keeps apply disabled (spec "Exact cutover sequence" step 6); a host whose
// config already enables apply must not open that window.
// This runner is dispatched BEFORE run()'s APPLY_COMMANDS and CONFIG_ERROR gates: raw-emergency
// rollback reads only the environment (createCutoverRuntime) and must work on a broken config.
// cutover-config opens the cutover window, so it refuses on any config problem instead.
const runConfigCutoverCommand = async (options) => {
   const configProblem = CONFIG_ERROR ?? CONFIG.reconcile.apply.configError ?? null;
   if (options.command === "cutover-config" && configProblem) {
     write(JSON.stringify({ ok: false, code: "config-unusable", reason: configProblem, mutated: false }, null, 2));
     return EXIT_NEEDS_ATTENTION;
   }
   if (options.command === "cutover-config" && CONFIG.reconcile.apply.enabled) {
     write(JSON.stringify({ ok: false, code: "reconcile-apply-enabled",
       reason: "reconcile.apply.enabled must be false during config cutover", mutated: false }, null, 2));
     return EXIT_NEEDS_ATTENTION;
   }
   const controller = createCutoverRuntime();
   const result = options.command === "cutover-config"
     ? await controller.cutoverConfig()
     : await controller.rollbackConfigRawEmergency();
   write(options.json ? JSON.stringify(result, null, 2)
     : `${options.command}: ${result.ok ? result.phase : `refused (${result.code}): ${result.reason}`}`);
   return result.ok ? EXIT_OK : EXIT_NEEDS_ATTENTION;
};
```

In `run`, insert this directly after B6a's `if (options.command === "verify-deployed-config") return runVerifyDeployedConfig(options.json);` line, so it precedes the `APPLY_COMMANDS` and `CONFIG_ERROR` gates:

```js
  if (options.command === "cutover-config" || options.command === "rollback-config") {
    try {
      return await runConfigCutoverCommand(options);
    } catch (error) {
      complain(`${options.command}: ${error?.message ?? String(error)}`);
      return EXIT_ERROR;
    }
  }
```

A thrown failure returns `EXIT_ERROR` (1). Append this test to `tests/reconcile-cutover-config.test.mjs`. It reuses the file's `fixture` and `runCLI` helpers from Step 1:

```js
test("CLI: an unusable broker config refuses cutover-config but never blocks raw-emergency rollback", () => {
  const f = fixture("cli-config-unusable");
  const stateBefore = readdirSync(f.paths.stateRoot).sort();

  const cutover = runCLI(f, ["cutover-config", "--json"], "{ not json");
  assert.equal(cutover.status, 20, cutover.stderr);
  const refused = JSON.parse(cutover.stdout);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "config-unusable");
  assert.equal(refused.mutated, false);
  assert.deepEqual(readdirSync(f.paths.stateRoot).sort(), stateBefore, "no file appears under the state root");
  assert.equal(readlinkSync(f.paths.outerLink), f.paths.compatRaw);

  // Raw-emergency rollback reads only the environment, so the broken config does not stop it.
  // On this pre-bootstrap tree it reaches the controller and refuses for its own reason.
  const rollback = runCLI(f, ["rollback-config", "--raw-emergency", "--json"], "{ not json");
  assert.equal(rollback.status, 20, rollback.stderr);
  const rollbackResult = JSON.parse(rollback.stdout);
  assert.notEqual(rollbackResult.code, "config-unusable");
  assert.equal(rollbackResult.code, "not-bootstrapped");
});
```


- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --experimental-test-module-mocks --test tests/reconcile-cutover-config.test.mjs`
Expected: PASS, 14 tests, 0 failures.

Run: `npm test`
Expected: PASS, with no regressions in `tests/reconcile-cli.test.mjs`, `tests/resolver-generations.test.mjs` or B5/B6a's cutover tests.

- [ ] **Step 6: Commit**

```bash
git add lib/reconcile-cutover.js bin/opencode-broker-reconcile tests/reconcile-cutover-config.test.mjs
git commit -m "feat(reconcile): add audited config cutover and raw-emergency rollback

cutover-config switches resolver-generations/current to the pinned
generation 0 through the Package 3 manager, CAS-records configCutover,
then atomically retargets the outer config link. A rerun completes an
interrupted retarget from the persisted record. rollback-config
--raw-emergency CAS-writes raw-emergency over the exact generated record,
retains registry, generations and the init ack, and points the outer
link at the canonical devbox raw base."
```

### Task B7: Legacy ledger import, quiescence record and old-watch data guard

**Files:**
- Create: `lib/reconcile-legacy.js`
- Create: `tests/reconcile-legacy.test.mjs`
- Modify: `lib/reconcile-state.js`: change the declaration `const REVIEWED_KEY = /^[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._:-]{1,180}$/;` (line 66 at HEAD 38069c6) into an export. The import must use the same key grammar the legacy reader uses, and keeping a second copy of the regex would let the two drift apart.
- Modify: `lib/reconcile-cutover.js` (created in B5): delegate `recordLegacyQuiesced` and `importLegacyLedger` to the new module.
- Modify: `bin/opencode-broker-reconcile`: add the import, the `USAGE` lines, the `FLAG_ONLY` entry, the `import-legacy-ledger` parser and the dispatch.
- Modify: `bin/opencode-broker-watch`: add the data guard before step 1 (the cache refresh).

**Design decisions this task fixes (read before implementing):**
- **What "import" means.** `reviewed-models.json` is a set of `<providerID>/<modelID>` seen keys. The reconciler keys its transitions and notifications on `transitionID`, never on a seen key. So the import creates **zero** `roles`, `unknown` or `evidenceRequests` records. Creating any of them would produce exactly the duplicate transition or notification the spec forbids.
- **Where the imported key set lives.** The contract's `legacyMigration` record has no key-set field. The key set is carried by two read-only (`0400`) copies under `$STATE_ROOT/legacy-ledger-archive/` (directory `0700`):
  - `reviewed-models.baseline.json`: the exact bytes at the baseline.
  - `reviewed-models.final.<sha256-of-bytes>.json`: the exact bytes at the final import.

  The ledger pins both copies through the following fields:
  - `baselineCount` / `baselineHash`: the canonical key-set hash of the baseline.
  - `finalCount` / `finalHash`: the canonical key-set hash of the final source.
  - `archivePath` / `archiveHash`: the path and SHA-256 of the final copy's bytes.
- **Canonical key-set hash:** `sha256(JSON.stringify(sortedKeys))`, where keys are sorted in code-unit order.
- **`sourceLedgerRevision`:** the enclosing `store.update` mutation's revision, passed to the mutator as `{ revision }` (contract v2: an integer counter, never `updatedAt`). That is the revision the final import's CAS writes.
- **The legacy file is parsed strictly.** `readReviewedModels` silently drops junk entries, which is acceptable for its preview but would make `B` disagree with the file. Here any entry that fails `REVIEWED_KEY`, or has a non-string value, fails closed.
- **The writable legacy ledger is never moved, rewritten or re-moded.** It must be a regular `0600` file. An absent file fails closed (`legacy-ledger-missing`); it is not treated as `B=0`.
- **Replay doubles as the pre-rollback check.** `import-legacy-ledger --final --json` replays when a final is already recorded. The replay exits 0 only if all of the following hold:
  - the writable ledger is a regular `0600` file;
  - its bytes hash equals `archiveHash`;
  - its key-set hash equals `finalHash` and its count equals `finalCount`;
  - the archive is a separate `0400` inode with the same hash.

  That is the "verify the writable ledger's hash, mode, and revision before re-enabling the old watch" check, so F4 can call it.
- **Orphans block.** A crash between the copy and the ledger write leaves an orphaned copy. The next run fails closed (`legacy-baseline-orphan` / `legacy-archive-orphan`) and leaves the orphan for the operator to inspect. If the import's own post-write verification fails, it removes the copy it wrote during that run before rethrowing.
- **The data guard keeps the contract's exact semantics.** `bin/opencode-broker-watch` exits 5 only when `configCutover.mode === "generated"`. In `raw-emergency`, and before cutover, it runs. If the ledger cannot be read or validated, the guard cannot rule out generated mode, so the watch exits 1 loudly before any side effect.
- **Exit codes:**
  - `LegacyMigrationError` exits **20** (needs attention).
  - Any other error exits **1**.
  - Usage errors exit **2**.
  - Success and replay exit **0**.
- **Locking.** The broker takes no flock. Ledger writes go through `createReconciliationStore().update()` only.

**Interfaces:**
- Consumes:
  - From the current code and B2, `createReconciliationStore({ root, now }) -> { read(): State, update(mutator: (State) => State): State, paths(): { state: string, lock: string, reviewed: string } }`. `paths().reviewed` is `LEGACY_LEDGER` (`$STATE_ROOT/reviewed-models.json`).
  - From B2, the v2 validator accepts `legacyMigration` with exactly `{schemaVersion:1, baselineCount, baselineHash, finalCount, finalHash, sourceLedgerRevision, quiescedAt, archivePath, archiveHash}`:
    - `finalCount`, `finalHash`, `sourceLedgerRevision`, `quiescedAt`, `archivePath` and `archiveHash` are `null` until their phase records them;
    - `quiescedAt` is a UTC ISO-8601 string;
    - hashes are 64-hex.
  - From B2, the v2 validator accepts `generationRegistryInitialized` and `configCutover` shaped exactly as in the spec's "Ledger schemas" section.
  - From B5, `createCutoverController({ paths, store, generations, clock, fs, verifyRawTopology })`. Here `clock: () => number` returns epoch milliseconds, and `fs` is either `node:fs`-compatible or `undefined`.
  - From `lib/reconcile-state.js`, `export const REVIEWED_KEY: RegExp` (this task adds the export).
- Produces (`lib/reconcile-legacy.js`):
  - `LEGACY_MIGRATION_SCHEMA_VERSION = 1`, `LEGACY_ARCHIVE_DIR = "legacy-ledger-archive"`, `LEGACY_BASELINE_NAME = "reviewed-models.baseline.json"`, `EXIT_LEGACY_NEEDS_ATTENTION = 20`.
  - `class LegacyMigrationError extends Error { code: string; exitCode: 20 }`.
  - `legacyKeySetHash(keys: string[]) -> string` (64-hex).
  - `parseLegacyLedgerStrict(bytes: Buffer, path: string) -> string[]`: returns the keys sorted, or throws `LegacyMigrationError` with code `legacy-ledger-corrupt` or `legacy-ledger-invalid-entry`.
  - `legacyWatchSkipReason(state: object) -> string | null`.
  - `createLegacyMigration({ store, clock = Date.now, fs = node:fs, pid = process.pid }) -> { importLegacyLedger({ phase: "baseline" | "final" }), recordLegacyQuiesced(), paths() }`. The return shapes:
    - baseline: `{ ok: true, phase: "baseline", replay: boolean, baselineCount, baselineHash, snapshotPath }`
    - final: `{ ok: true, phase: "final", replay: boolean, baselineCount, deltaCount, finalCount, finalHash, sourceLedgerRevision, archivePath, archiveHash, legacyLedgerPath, transitionsCreated: 0 }`
    - quiesce: `{ ok: true, replay: boolean, quiescedAt: string }`
    - `paths() -> { legacyLedger, archiveRoot, baselineSnapshot }`
  - Error codes (all exit 20): `legacy-ledger-missing`, `legacy-not-regular-file`, `legacy-wrong-mode`, `legacy-ledger-corrupt`, `legacy-ledger-invalid-entry`, `legacy-baseline-missing`, `legacy-baseline-orphan`, `legacy-baseline-snapshot-missing`, `legacy-baseline-snapshot-mismatch`, `legacy-not-quiesced`, `legacy-keys-lost`, `legacy-key-equality-failed`, `legacy-archive-orphan`, `legacy-archive-missing`, `legacy-archive-mismatch`, `legacy-archive-not-a-copy`, `legacy-ledger-changed-during-import`, `legacy-ledger-changed-after-final`, `legacy-migration-raced`.
- Produces (controller): `controller.recordLegacyQuiesced()` and `controller.importLegacyLedger({ phase })`. Both are the same functions as above.
- Produces (CLI):
  - `opencode-broker-reconcile record-legacy-quiesced [--json]`
  - `opencode-broker-reconcile import-legacy-ledger (--baseline|--final) [--json]`

  On error, both print one JSON object `{ ok: false, command, code, reason, ledgerMutated: false }`. Both honour `OPENCODE_RECONCILE_STATE_ROOT`; when it is unset they fall back to the default store root.
- Produces (for B6/F4):
  - `legacyMigration.finalHash !== null` means the final import is complete.
  - `legacyMigration.quiescedAt` is the seven-day cleanup key.
  - The required order is: `--baseline`, then `record-legacy-quiesced` (only after F4 has stopped and disabled `opencode-model-watch.timer` and confirmed the service exited), then `--final`.
- Produces (watch): `bin/opencode-broker-watch` exits **5** with stderr `opencode-broker-watch: skipped: configCutover.mode is generated: ...` before any refresh, publication or ledger write.

- [ ] **Step 1: Write the failing tests**

Create `tests/reconcile-legacy.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReconciliationStore } from "../lib/reconcile-state.js";
import {
  LEGACY_ARCHIVE_DIR,
  LEGACY_BASELINE_NAME,
  LegacyMigrationError,
  createLegacyMigration,
  legacyKeySetHash,
  legacyWatchSkipReason,
  parseLegacyLedgerStrict,
} from "../lib/reconcile-legacy.js";

const RECONCILE_CLI = new URL("../bin/opencode-broker-reconcile", import.meta.url).pathname;
const WATCH_CLI = new URL("../bin/opencode-broker-watch", import.meta.url).pathname;
const QUIESCED_AT = "2026-10-01T12:00:00.000Z";

const BASELINE = Object.freeze({
  "anthropic/claude-opus-5": "2026-08-20",
  "openai/gpt-5.6-sol": "2026-07-09",
  "alibaba-token-plan/qwen3.8-max": "2026-08-31",
});
// What the old watch adds between the baseline and its quiescence: dry-run coexistence is allowed.
const DELTA = Object.freeze({
  "openai/gpt-6-sol": "2026-10-01",
  "anthropic/claude-opus-5-5": "2026-10-01",
});

const hex = (character) => character.repeat(64);
const REGISTRY_ACK = Object.freeze({
  schemaVersion: 1, generation: 0, registryHash: hex("a"), manifestHash: hex("b"), rawBaseHash: hex("c"),
  sourceLedgerRevision: 1, initializedAt: "2026-10-01T10:00:00.000Z",
});
const GENERATED_CUTOVER = Object.freeze({
  schemaVersion: 1, mode: "generated",
  target: "/home/dev/.local/share/opencode/model-routing/resolver-generations/current/opencode.json",
  generation: 0, manifestHash: hex("b"), registryHash: hex("a"), rawBaseHash: hex("c"),
  sourceLedgerRevision: 1, changedAt: "2026-10-01T11:00:00.000Z", reason: "bootstrap",
});
// The store only accepts the generated target under its own root, so tests that seed a ledger
// under a temp root use this per-root copy.
const generatedCutover = (root) => ({
  ...GENERATED_CUTOVER, target: join(root, "resolver-generations", "current", "opencode.json"),
});
// The raw-emergency target is the store default (OPENCODE_RECONCILE_RAW_BASE unset): the
// canonical devbox raw base.
const RAW_EMERGENCY_CUTOVER = Object.freeze({
  ...GENERATED_CUTOVER, mode: "raw-emergency", target: "/home/dev/devbox/config/opencode/opencode.json",
  generation: null, manifestHash: null, changedAt: "2026-10-01T11:30:00.000Z", reason: "emergency-rollback",
});

const withRoot = (name, run) => {
  const base = mkdtempSync(join(tmpdir(), `reconcile-legacy-${name}-`));
  const root = join(base, "model-routing");
  mkdirSync(root, { mode: 0o700 });
  try {
    return run({ base, root });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

// Exactly the shape and mode bin/opencode-broker-watch writes.
const writeLegacy = (root, entries) => {
  const path = join(root, "reviewed-models.json");
  writeFileSync(path, JSON.stringify(entries, null, 1) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

// A strictly increasing ledger clock, so sourceLedgerRevision is checkably the revision the final
// import wrote against rather than a constant.
const migration = (root) => {
  let tick = 1_000;
  const store = createReconciliationStore({ root, now: () => (tick += 1) });
  return { store, legacy: createLegacyMigration({ store, clock: () => Date.parse(QUIESCED_AT) }) };
};

const assertCode = (run, code) => assert.throws(run, (error) =>
  error instanceof LegacyMigrationError && error.code === code && error.exitCode === 20);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("baseline records B and the key-set hash, keeps a 0400 snapshot, and replays without rewriting", () => {
  withRoot("baseline", ({ root }) => {
    const legacyPath = writeLegacy(root, BASELINE);
    const legacyBytes = readFileSync(legacyPath);
    const { store, legacy } = migration(root);

    const result = legacy.importLegacyLedger({ phase: "baseline" });
    assert.deepEqual(result, {
      ok: true, phase: "baseline", replay: false, baselineCount: 3,
      baselineHash: legacyKeySetHash(Object.keys(BASELINE)),
      snapshotPath: join(root, LEGACY_ARCHIVE_DIR, LEGACY_BASELINE_NAME),
    });
    const state = store.read();
    assert.deepEqual(state.legacyMigration, {
      schemaVersion: 1, baselineCount: 3, baselineHash: result.baselineHash,
      finalCount: null, finalHash: null, sourceLedgerRevision: null, quiescedAt: null,
      archivePath: null, archiveHash: null,
    });
    // Zero projections: no transition, unknown-model or evidence record was created.
    assert.deepEqual([state.roles, state.unknown, state.evidenceRequests], [{}, {}, {}]);
    assert.equal(statSync(result.snapshotPath).mode & 0o777, 0o400);
    assert.deepEqual(readFileSync(result.snapshotPath), legacyBytes);
    assert.deepEqual(readFileSync(legacyPath), legacyBytes);
    assert.equal(statSync(legacyPath).mode & 0o777, 0o600);

    const ledgerBytes = readFileSync(store.paths().state);
    assert.deepEqual(legacy.importLegacyLedger({ phase: "baseline" }), { ...result, replay: true });
    assert.deepEqual(readFileSync(store.paths().state), ledgerBytes);
  });
});

test("quiesce and final refuse to run out of order and write nothing", () => {
  withRoot("order", ({ root }) => {
    writeLegacy(root, BASELINE);
    const { store, legacy } = migration(root);
    assertCode(() => legacy.recordLegacyQuiesced(), "legacy-baseline-missing");
    assertCode(() => legacy.importLegacyLedger({ phase: "final" }), "legacy-baseline-missing");
    assert.equal(existsSync(store.paths().state), false);

    legacy.importLegacyLedger({ phase: "baseline" });
    assertCode(() => legacy.importLegacyLedger({ phase: "final" }), "legacy-not-quiesced");
    assert.equal(store.read().legacyMigration.finalHash, null);
    assert.deepEqual(readdirSync(join(root, LEGACY_ARCHIVE_DIR)), [LEGACY_BASELINE_NAME]);
  });
});

test("final imports exactly B + D, archives a read-only copy, keeps the writable ledger, and replays idempotently", () => {
  withRoot("final", ({ root }) => {
    const legacyPath = writeLegacy(root, BASELINE);
    const { store, legacy } = migration(root);
    legacy.importLegacyLedger({ phase: "baseline" });
    writeLegacy(root, { ...BASELINE, ...DELTA });
    const finalBytes = readFileSync(legacyPath);

    assert.deepEqual(legacy.recordLegacyQuiesced(), { ok: true, replay: false, quiescedAt: QUIESCED_AT });
    assert.deepEqual(legacy.recordLegacyQuiesced(), { ok: true, replay: true, quiescedAt: QUIESCED_AT });

    const revisionBefore = store.read().revision;
    const result = legacy.importLegacyLedger({ phase: "final" });
    const allKeys = Object.keys({ ...BASELINE, ...DELTA });
    const archiveHash = sha256(finalBytes);
    const archivePath = join(root, LEGACY_ARCHIVE_DIR, `reviewed-models.final.${archiveHash}.json`);
    assert.deepEqual(result, {
      ok: true, phase: "final", replay: false, baselineCount: 3, deltaCount: 2, finalCount: 5,
      // The final import is itself one ledger write, so it records the revision it commits.
      finalHash: legacyKeySetHash(allKeys), sourceLedgerRevision: revisionBefore + 1,
      archivePath, archiveHash, legacyLedgerPath: legacyPath, transitionsCreated: 0,
    });

    const state = store.read();
    assert.deepEqual(state.legacyMigration, {
      schemaVersion: 1, baselineCount: 3, baselineHash: legacyKeySetHash(Object.keys(BASELINE)),
      finalCount: 5, finalHash: result.finalHash, sourceLedgerRevision: revisionBefore + 1,
      quiescedAt: QUIESCED_AT, archivePath, archiveHash,
    });
    assert.deepEqual([state.roles, state.unknown, state.evidenceRequests], [{}, {}, {}]);

    // A COPY, read-only, byte-identical; the writable ledger stays where the old watch expects it.
    const archiveStat = lstatSync(archivePath);
    const legacyStat = lstatSync(legacyPath);
    assert.equal(archiveStat.isFile(), true);
    assert.equal(archiveStat.mode & 0o777, 0o400);
    assert.notEqual(archiveStat.ino, legacyStat.ino);
    assert.deepEqual(readFileSync(archivePath), finalBytes);
    assert.equal(legacyStat.mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(legacyPath), finalBytes);
    // Exact key equality: the archive parses to exactly B + D.
    assert.deepEqual(parseLegacyLedgerStrict(readFileSync(archivePath), archivePath), [...allKeys].sort());

    const ledgerBytes = readFileSync(store.paths().state);
    assert.deepEqual(legacy.importLegacyLedger({ phase: "final" }), { ...result, replay: true });
    assert.deepEqual(readFileSync(store.paths().state), ledgerBytes);
    assert.deepEqual(readdirSync(join(root, LEGACY_ARCHIVE_DIR)).sort(),
      [LEGACY_BASELINE_NAME, `reviewed-models.final.${archiveHash}.json`].sort());
  });
});

test("a baseline key missing from the final source blocks the import with nothing archived", () => {
  withRoot("lost", ({ root }) => {
    writeLegacy(root, BASELINE);
    const { store, legacy } = migration(root);
    legacy.importLegacyLedger({ phase: "baseline" });
    const { ["openai/gpt-5.6-sol"]: dropped, ...rest } = BASELINE;
    assert.equal(dropped, "2026-07-09");
    writeLegacy(root, { ...rest, ...DELTA });
    legacy.recordLegacyQuiesced();
    assertCode(() => legacy.importLegacyLedger({ phase: "final" }), "legacy-keys-lost");
    assert.equal(store.read().legacyMigration.finalHash, null);
    assert.deepEqual(readdirSync(join(root, LEGACY_ARCHIVE_DIR)), [LEGACY_BASELINE_NAME]);
  });
});

test("a legacy ledger that changes after the final import fails replay loudly", () => {
  withRoot("changed", ({ root }) => {
    writeLegacy(root, BASELINE);
    const { store, legacy } = migration(root);
    legacy.importLegacyLedger({ phase: "baseline" });
    legacy.recordLegacyQuiesced();
    legacy.importLegacyLedger({ phase: "final" });
    const ledgerBytes = readFileSync(store.paths().state);
    writeLegacy(root, { ...BASELINE, "openai/gpt-6.1-sol": "2026-10-02" });
    assertCode(() => legacy.importLegacyLedger({ phase: "final" }), "legacy-ledger-changed-after-final");
    assert.deepEqual(readFileSync(store.paths().state), ledgerBytes);
  });
});

test("a missing, corrupt, lossy or loosened legacy ledger fails closed with its bytes untouched", () => {
  withRoot("strict", ({ root }) => {
    const { store, legacy } = migration(root);
    const legacyPath = join(root, "reviewed-models.json");
    assertCode(() => legacy.importLegacyLedger({ phase: "baseline" }), "legacy-ledger-missing");

    writeFileSync(legacyPath, "{ truncated\n", { mode: 0o600 });
    assertCode(() => legacy.importLegacyLedger({ phase: "baseline" }), "legacy-ledger-corrupt");
    assert.equal(readFileSync(legacyPath, "utf8"), "{ truncated\n");

    // readReviewedModels drops this entry for its preview; an import that did the same would
    // record a B that silently disagrees with the file.
    writeLegacy(root, { ...BASELINE, "no-provider": "2026-07-09" });
    assertCode(() => legacy.importLegacyLedger({ phase: "baseline" }), "legacy-ledger-invalid-entry");

    writeLegacy(root, BASELINE);
    chmodSync(legacyPath, 0o644);
    assertCode(() => legacy.importLegacyLedger({ phase: "baseline" }), "legacy-wrong-mode");

    assert.equal(existsSync(store.paths().state), false);
    assert.equal(existsSync(join(root, LEGACY_ARCHIVE_DIR)), false);
  });
});

test("an orphaned baseline snapshot with no ledger record blocks a new baseline", () => {
  withRoot("orphan", ({ root }) => {
    writeLegacy(root, BASELINE);
    const archiveRoot = join(root, LEGACY_ARCHIVE_DIR);
    mkdirSync(archiveRoot, { mode: 0o700 });
    writeFileSync(join(archiveRoot, LEGACY_BASELINE_NAME), "{}\n", { mode: 0o400 });
    const { store, legacy } = migration(root);
    assertCode(() => legacy.importLegacyLedger({ phase: "baseline" }), "legacy-baseline-orphan");
    assert.equal(existsSync(store.paths().state), false);
    assert.equal(readFileSync(join(archiveRoot, LEGACY_BASELINE_NAME), "utf8"), "{}\n");
  });
});

test("the old watch is skipped only while configCutover.mode is generated", () => {
  assert.match(legacyWatchSkipReason({ configCutover: { mode: "generated" } }), /configCutover\.mode is generated/);
  assert.equal(legacyWatchSkipReason({ configCutover: { mode: "raw-emergency" } }), null);
  assert.equal(legacyWatchSkipReason({}), null);
});

// ---- spawned binaries ----------------------------------------------------------------------------
// Inherited OPENCODE_* and XDG_* variables are stripped so no live state root, config or cache can
// leak in; both state-root variables point at the fixture root.
const cleanEnv = (base, root, extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name))),
  HOME: join(base, "home"),
  OPENCODE_MODEL_ROUTING_DIR: root,
  OPENCODE_RECONCILE_STATE_ROOT: root,
  OPENCODE_BROKER_CONFIG: join(base, "absent-config.json"),
  XDG_CACHE_HOME: join(base, "cache"),
  XDG_CONFIG_HOME: join(base, "config"),
  ...extra,
});

const runNode = (script, args, env) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env });

// A fake `opencode` that only records that it ran: any invocation is the old watch doing work.
const fakeOpencode = (base) => {
  const bin = join(base, "bin");
  mkdirSync(bin);
  const marker = join(base, "opencode-ran");
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho "$*" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  return { bin, marker };
};

test("the CLI runs baseline, quiesce and final as one JSON object each, and exits 20 out of order", () => {
  withRoot("cli", ({ base, root }) => {
    writeLegacy(root, BASELINE);
    const env = cleanEnv(base, root);

    const early = runNode(RECONCILE_CLI, ["import-legacy-ledger", "--final", "--json"], env);
    assert.equal(early.status, 20, early.stderr);
    assert.deepEqual(JSON.parse(early.stdout), {
      ok: false, command: "import-legacy-ledger", code: "legacy-baseline-missing",
      reason: "no baseline is recorded; run import-legacy-ledger --baseline first", ledgerMutated: false,
    });

    const baseline = runNode(RECONCILE_CLI, ["import-legacy-ledger", "--baseline", "--json"], env);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).baselineCount, 3);

    writeLegacy(root, { ...BASELINE, ...DELTA });
    const quiesced = runNode(RECONCILE_CLI, ["record-legacy-quiesced", "--json"], env);
    assert.equal(quiesced.status, 0, quiesced.stderr);
    assert.equal(JSON.parse(quiesced.stdout).replay, false);

    const final = runNode(RECONCILE_CLI, ["import-legacy-ledger", "--final", "--json"], env);
    assert.equal(final.status, 0, final.stderr);
    const report = JSON.parse(final.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.replay, false);
    assert.deepEqual([report.baselineCount, report.deltaCount, report.finalCount, report.transitionsCreated], [3, 2, 5, 0]);

    const replay = runNode(RECONCILE_CLI, ["import-legacy-ledger", "--final", "--json"], env);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).replay, true);

    const usage = runNode(RECONCILE_CLI, ["import-legacy-ledger", "--baseline", "--final"], env);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /exactly one of --baseline or --final/);
  });
});

test("the old watch exits 5 before any side effect once configCutover is generated", () => {
  withRoot("watch-generated", ({ base, root }) => {
    const { bin, marker } = fakeOpencode(base);
    const legacyPath = writeLegacy(root, BASELINE);
    const legacyBytes = readFileSync(legacyPath);
    createReconciliationStore({ root }).update((state) => ({
      ...state, generationRegistryInitialized: REGISTRY_ACK, configCutover: generatedCutover(root),
    }));
    const result = runNode(WATCH_CLI, [], cleanEnv(base, root, { PATH: `${bin}:${process.env.PATH}` }));
    assert.equal(result.status, 5, result.stderr);
    assert.match(result.stderr, /opencode-broker-watch: skipped: configCutover\.mode is generated/);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(readFileSync(legacyPath), legacyBytes);
  });
});

test("the old watch is NOT skipped before cutover or in raw-emergency", () => {
  withRoot("watch-raw", ({ base, root }) => {
    const { bin, marker } = fakeOpencode(base);
    const env = cleanEnv(base, root, { PATH: `${bin}:${process.env.PATH}` });

    const before = runNode(WATCH_CLI, [], env);
    assert.notEqual(before.status, 5, before.stderr);
    assert.equal(existsSync(marker), true);
    rmSync(marker);

    createReconciliationStore({ root }).update((state) => ({
      ...state, generationRegistryInitialized: REGISTRY_ACK, configCutover: RAW_EMERGENCY_CUTOVER,
    }));
    const raw = runNode(WATCH_CLI, [], env);
    assert.notEqual(raw.status, 5, raw.stderr);
    assert.equal(existsSync(marker), true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-test-module-mocks --test tests/reconcile-legacy.test.mjs`
Expected: FAIL. The file does not load, with `ERR_MODULE_NOT_FOUND`: `Cannot find module '/home/dev/opencode-broker/lib/reconcile-legacy.js'`.

- [ ] **Step 3: Export the key grammar and write the module**

In `lib/reconcile-state.js`, replace the declaration

```js
const REVIEWED_KEY = /^[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._:-]{1,180}$/;
```

with

```js
// Exported for lib/reconcile-legacy.js: the one-time import must accept exactly the keys this
// module's reader accepts, and a second copy of the grammar would drift.
export const REVIEWED_KEY = /^[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._:-]{1,180}$/;
```

Create `lib/reconcile-legacy.js`:

```js
// Package 4's one-time migration off opencode-broker-watch's seen-notification ledger, and the data
// guard that keeps that old watch from writing once opencode-broker-reconcile owns scheduling.
//
// WHAT "IMPORT" MEANS. reviewed-models.json is a set of `<providerID>/<modelID>` keys somebody was
// already told about. The reconciler keys transitions and notifications on transitionID, never on a
// seen key, so the import deliberately creates NO roles, unknown or evidence records: creating them
// is exactly the duplicate transition and notification the design forbids. The imported key set is
// carried by two read-only (0400) copies under <state root>/legacy-ledger-archive/ -- the baseline
// snapshot and the final archive -- and the ledger pins them with counts, canonical key-set hashes
// and the final copy's byte hash.
//
// WHAT IS NEVER TOUCHED. The writable legacy ledger stays at its old path, 0600, byte-identical: it
// is the old watch's rollback path. Every failure here leaves it, and the ledger, exactly as found.
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { REVIEWED_KEY } from "./reconcile-state.js";

export const LEGACY_MIGRATION_SCHEMA_VERSION = 1;
export const LEGACY_ARCHIVE_DIR = "legacy-ledger-archive";
export const LEGACY_BASELINE_NAME = "reviewed-models.baseline.json";
// job-run contract: 20 is "needs attention" -- an operator has to look before anything proceeds.
export const EXIT_LEGACY_NEEDS_ATTENTION = 20;

export class LegacyMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LegacyMigrationError";
    this.code = code;
    this.exitCode = EXIT_LEGACY_NEEDS_ATTENTION;
  }
}

const fail = (code, message) => { throw new LegacyMigrationError(code, message); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Code-unit order, the same order lib/reconcile-state.js sorts reviewed keys in.
const sortKeys = (keys) => [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const sameRecord = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

// The canonical key-set hash: values (seen dates) and formatting are deliberately excluded, so
// baselineHash/finalHash say which keys were imported; archiveHash separately pins the bytes.
export const legacyKeySetHash = (keys) => sha256(JSON.stringify(sortKeys(keys)));

// Strict on purpose. readReviewedModels drops junk entries for its advisory preview; doing that
// here would record a B that silently disagrees with the file it claims to describe.
export const parseLegacyLedgerStrict = (bytes, path) => {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("legacy-ledger-corrupt", `${path} is not valid reviewed-models JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("legacy-ledger-corrupt", `${path} is not a reviewed-models object`);
  }
  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (!REVIEWED_KEY.test(key) || typeof parsed[key] !== "string") {
      fail("legacy-ledger-invalid-entry", `${path} entry ${JSON.stringify(key)} cannot be imported exactly`);
    }
  }
  return sortKeys(keys);
};

// The singleton-writer data guard (second layer under the systemd flock). Only generated mode
// skips: in raw-emergency the old watch is the authorized writer again, and before cutover it is
// the only one.
export const legacyWatchSkipReason = (state) =>
  state?.configCutover?.mode === "generated"
    ? "configCutover.mode is generated: opencode-broker-reconcile is the only scheduled model-change writer"
    : null;

export const createLegacyMigration = ({ store, clock = Date.now, fs = nodeFs, pid = process.pid } = {}) => {
  if (!store || typeof store.read !== "function" || typeof store.update !== "function" || typeof store.paths !== "function") {
    throw new Error("legacy migration needs a reconciliation store");
  }
  const { state: statePath, reviewed: legacyPath } = store.paths();
  const archiveRoot = join(dirname(statePath), LEGACY_ARCHIVE_DIR);
  const baselinePath = join(archiveRoot, LEGACY_BASELINE_NAME);

  const present = (path) => {
    try {
      fs.lstatSync(path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  };

  // lstat, not stat: a symlink at any of these paths is not the file the record describes.
  const readRegular = (path, expectedMode, missingCode) => {
    let stat;
    try {
      stat = fs.lstatSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") fail(missingCode, `${path} does not exist`);
      throw error;
    }
    if (!stat.isFile()) fail("legacy-not-regular-file", `${path} is not a regular file`);
    const mode = stat.mode & 0o777;
    if (mode !== expectedMode) {
      fail("legacy-wrong-mode", `${path} has mode ${mode.toString(8)}, expected ${expectedMode.toString(8)}`);
    }
    const bytes = fs.readFileSync(path);
    return { bytes, hash: sha256(bytes), ino: stat.ino };
  };

  const readSource = () => {
    const file = readRegular(legacyPath, 0o600, "legacy-ledger-missing");
    const keys = parseLegacyLedgerStrict(file.bytes, legacyPath);
    return { ...file, keys, keySetHash: legacyKeySetHash(keys) };
  };

  // Written private, made read-only, then published with link(2): unlike rename, link refuses to
  // replace an existing name, so a copy that already exists can never be silently overwritten.
  const writeReadOnlyCopy = (path, bytes) => {
    fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(archiveRoot, 0o700);
    const temporary = `${path}.${pid}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(temporary, 0o400);
      try {
        fs.linkSync(temporary, path);
      } catch (error) {
        if (error?.code === "EEXIST") fail("legacy-archive-orphan", `${path} appeared while it was being written`);
        throw error;
      }
    } finally {
      fs.unlinkSync(temporary);
    }
    const directory = fs.openSync(archiveRoot, "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  };

  const verifyArchive = (path, expectedHash, sourceIno) => {
    const archive = readRegular(path, 0o400, "legacy-archive-missing");
    if (archive.hash !== expectedHash) fail("legacy-archive-mismatch", `${path} does not hash to the recorded ${expectedHash}`);
    if (archive.ino === sourceIno) {
      fail("legacy-archive-not-a-copy", `${path} shares an inode with ${legacyPath}; the archive must be an independent copy`);
    }
  };

  const readBaselineSnapshot = (record) => {
    const file = readRegular(baselinePath, 0o400, "legacy-baseline-snapshot-missing");
    const keys = parseLegacyLedgerStrict(file.bytes, baselinePath);
    if (keys.length !== record.baselineCount || legacyKeySetHash(keys) !== record.baselineHash) {
      fail("legacy-baseline-snapshot-mismatch", `${baselinePath} no longer matches the recorded baseline`);
    }
    return keys;
  };

  // Every ledger write is a compare-and-set on the legacyMigration record this call read, made
  // inside the store's own lock.
  const casLegacyMigration = (expected, buildNext) => {
    let written = null;
    // `ack` is the store's `{ revision }`: the revision this write commits. Builders that stamp
    // sourceLedgerRevision (the final import) take it as their second argument.
    store.update((current, ack) => {
      if (!sameRecord(current.legacyMigration ?? null, expected)) {
        fail("legacy-migration-raced", "legacyMigration changed while this command ran; re-run it to read the recorded state");
      }
      written = buildNext(current, ack);
      return { ...current, legacyMigration: written };
    });
    return written;
  };

  const baselineSummary = (record, replay) => ({
    ok: true, phase: "baseline", replay,
    baselineCount: record.baselineCount, baselineHash: record.baselineHash, snapshotPath: baselinePath,
  });

  const importBaseline = () => {
    const recorded = store.read().legacyMigration ?? null;
    if (recorded !== null) {
      readBaselineSnapshot(recorded);
      return baselineSummary(recorded, true);
    }
    // A snapshot with no ledger record is a crash between the two writes. It is evidence, so it
    // is left for the operator rather than overwritten.
    if (present(baselinePath)) {
      fail("legacy-baseline-orphan", `${baselinePath} exists but the ledger records no baseline; inspect and remove it by hand before re-running`);
    }
    const source = readSource();
    writeReadOnlyCopy(baselinePath, source.bytes);
    const written = casLegacyMigration(null, () => ({
      schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
      baselineCount: source.keys.length,
      baselineHash: source.keySetHash,
      finalCount: null,
      finalHash: null,
      sourceLedgerRevision: null,
      quiescedAt: null,
      archivePath: null,
      archiveHash: null,
    }));
    return baselineSummary(written, false);
  };

   // The broker cannot see systemd. The caller (bin/opencode-model-provider-stage) records this only
   // after it has stopped and disabled opencode-model-watch.timer and confirmed the service exited.
   const recordLegacyQuiesced = () => {
     const recorded = store.read().legacyMigration ?? null;
     if (recorded === null) fail("legacy-baseline-missing", "no baseline is recorded; run import-legacy-ledger --baseline first");
     if (recorded.quiescedAt !== null) return { ok: true, replay: true, quiescedAt: recorded.quiescedAt };
     const quiescedAt = new Date(clock()).toISOString();
     const written = casLegacyMigration(recorded, (current) => ({ ...recorded, quiescedAt }));
     return { ok: true, replay: false, quiescedAt: written.quiescedAt };
   };

  const finalSummary = (record, replay) => ({
    ok: true, phase: "final", replay,
    baselineCount: record.baselineCount,
    deltaCount: record.finalCount - record.baselineCount,
    finalCount: record.finalCount,
    finalHash: record.finalHash,
    sourceLedgerRevision: record.sourceLedgerRevision,
    archivePath: record.archivePath,
    archiveHash: record.archiveHash,
    legacyLedgerPath: legacyPath,
    transitionsCreated: 0,
  });

   const importFinal = () => {
     const recorded = store.read().legacyMigration ?? null;
     if (recorded === null) fail("legacy-baseline-missing", "no baseline is recorded; run import-legacy-ledger --baseline first");
     if (recorded.quiescedAt === null) {
       fail("legacy-not-quiesced", "the old watch is not recorded as quiesced; stop and disable its timer, await its service exit, then run record-legacy-quiesced");
     }
     const source = readSource();
     // Archive the final key set to $STATE_ROOT/legacy-ledger-archive/ as a read-only copy.

    // Replay doubles as the pre-rollback verification of the writable ledger: hash, mode, key set.
    if (recorded.finalHash !== null) {
      verifyArchive(recorded.archivePath, recorded.archiveHash, source.ino);
      if (source.hash !== recorded.archiveHash || source.keySetHash !== recorded.finalHash || source.keys.length !== recorded.finalCount) {
        fail("legacy-ledger-changed-after-final", `${legacyPath} no longer matches the recorded final import`);
      }
      return finalSummary(recorded, true);
    }

    const baselineKeys = readBaselineSnapshot(recorded);
    const finalSet = new Set(source.keys);
    const lost = baselineKeys.filter((key) => !finalSet.has(key));
    if (lost.length) {
      fail("legacy-keys-lost", `${lost.length} baseline key(s) are missing from the final legacy ledger, first ${JSON.stringify(lost.slice(0, 3))}`);
    }
    const baselineSet = new Set(baselineKeys);
    const delta = source.keys.filter((key) => !baselineSet.has(key));
    const union = sortKeys([...baselineKeys, ...delta]);
    // B + D must be exactly the final key set: same size, no repeats, same canonical hash.
    if (union.length !== baselineKeys.length + delta.length || new Set(union).size !== union.length
      || legacyKeySetHash(union) !== source.keySetHash) {
      fail("legacy-key-equality-failed", "baseline plus delta is not exactly the final legacy key set");
    }

    const archivePath = join(archiveRoot, `reviewed-models.final.${source.hash}.json`);
    if (present(archivePath)) {
      fail("legacy-archive-orphan", `${archivePath} exists but the ledger records no final import; inspect and remove it by hand before re-running`);
    }
    writeReadOnlyCopy(archivePath, source.bytes);
    try {
      verifyArchive(archivePath, source.hash, source.ino);
      const after = readRegular(legacyPath, 0o600, "legacy-ledger-missing");
      if (after.hash !== source.hash) {
        fail("legacy-ledger-changed-during-import", `${legacyPath} changed while it was being archived; the old watch is not quiesced`);
      }
    } catch (error) {
      // The copy is this run's own artifact and records nothing: removing it is a clean undo, and
      // leaving it would turn the retry into an orphan stop.
      fs.unlinkSync(archivePath);
      throw error;
    }

     const written = casLegacyMigration(recorded, (current, { revision }) => ({
       ...recorded,
       finalCount: source.keys.length,
       finalHash: source.keySetHash,
       sourceLedgerRevision: revision,
       archivePath,
       archiveHash: source.hash,
     }));
    return finalSummary(written, false);
  };

  const importLegacyLedger = ({ phase } = {}) => {
    if (phase === "baseline") return importBaseline();
    if (phase === "final") return importFinal();
    throw new Error(`import-legacy-ledger phase must be "baseline" or "final", got ${JSON.stringify(phase)}`);
  };

  return Object.freeze({
    importLegacyLedger,
    recordLegacyQuiesced,
    paths: () => ({ legacyLedger: legacyPath, archiveRoot, baselineSnapshot: baselinePath }),
  });
};
```

- [ ] **Step 4: Run the tests and confirm the library tests pass while the spawned binary tests still fail**

Run: `node --experimental-test-module-mocks --test tests/reconcile-legacy.test.mjs`

Expected:
- The eight library tests PASS, from "baseline records B ..." through "the old watch is skipped only while ...".
- "the old watch is NOT skipped before cutover or in raw-emergency" PASSes as well, because the watch has no guard yet.
- "the CLI runs baseline, quiesce and final ..." FAILs with `status` 2 instead of 20; stderr contains `unknown command "import-legacy-ledger"`.
- "the old watch exits 5 before any side effect ..." FAILs with `status` 1 instead of 5, because the fake `opencode` ran.

- [ ] **Step 5: Wire the CLI, the old-watch guard and the controller**

In `bin/opencode-broker-reconcile`:

1. Add this import after `import { createReconciliationStore } from "../lib/reconcile-state.js";`:

```js
import { LegacyMigrationError, createLegacyMigration } from "../lib/reconcile-legacy.js";
```

2. Append these two entries as the last elements of the `USAGE` array, immediately before `].join("\n");`:

```js
  "  record-legacy-quiesced [--json]       record that the old model-watch timer is stopped and its service exited",
  "  import-legacy-ledger (--baseline|--final) [--json]",
  "                                        import the legacy reviewed-models key set once (B, then B + D)",
```

3. Add this entry to the `FLAG_ONLY` object:

```js
  "record-legacy-quiesced": ["--json"],
```

4. Add this parser immediately above `const parseArgs = (argv) => {`:

```js
// Exactly one phase, named explicitly: a bare import-legacy-ledger must never guess which half of
// the migration the operator meant.
const parseImportLegacyLedger = (argv) => {
  let phase = null;
  let json = false;
  for (const flag of argv) {
    if (flag === "--json") { json = true; continue; }
    if (flag === "--baseline" || flag === "--final") {
      const next = flag.slice(2);
      if (phase !== null && phase !== next) return { error: "import-legacy-ledger takes exactly one of --baseline or --final" };
      phase = next;
      continue;
    }
    return { error: `unknown option "${flag}"` };
  }
  if (phase === null) return { error: "import-legacy-ledger needs --baseline or --final" };
  return { command: "import-legacy-ledger", phase, json, dryRun: false };
};
```

5. In `parseArgs`, add this line directly after `if (command === undefined) return { error: "no command given" };`:

```js
  if (command === "import-legacy-ledger") return parseImportLegacyLedger(rest);
```

6. Add the runner immediately above `const run = async (argv) => {`:

```js
// ---- Package 4 legacy migration -----------------------------------------------------------------
// Built straight from lib/reconcile-legacy.js instead of through the cutover controller. The
// controller delegates these two methods to this same factory, and constructing it here would pull
// in generation and topology dependencies a ledger import never uses. Every outcome prints one
// JSON object under --json, which is the job-run contract: 0 ok or replay, 20 needs attention,
// 1 any other failure.
const LEGACY_MIGRATION_COMMANDS = new Set(["record-legacy-quiesced", "import-legacy-ledger"]);

const runLegacyMigrationCommand = (options) => {
  let result;
  let exitCode = EXIT_OK;
  try {
    const root = process.env.OPENCODE_RECONCILE_STATE_ROOT;
    const legacy = createLegacyMigration({ store: createReconciliationStore(root ? { root } : {}) });
    result = options.command === "record-legacy-quiesced"
      ? legacy.recordLegacyQuiesced()
      : legacy.importLegacyLedger({ phase: options.phase });
  } catch (error) {
    const known = error instanceof LegacyMigrationError;
    const reason = error?.message ?? String(error);
    complain(reason);
    result = { ok: false, command: options.command, code: known ? error.code : "legacy-migration-failed", reason, ledgerMutated: false };
    exitCode = known ? error.exitCode : EXIT_ERROR;
  }
  write(options.json ? JSON.stringify(result, null, 2)
    : `${options.command}: ${result.ok ? "ok" : `${result.code}: ${result.reason}`}`);
  return exitCode;
};
```

7. Make this the first statement inside the `try {` block of `run()`, before the default `createReconciliationStore()` call:

```js
    if (LEGACY_MIGRATION_COMMANDS.has(options.command)) return runLegacyMigrationCommand(options);
```

In `bin/opencode-broker-watch`, add these two imports after `import { watchReport, formatReport } from "../lib/watch.js";`:

```js
import { createReconciliationStore } from "../lib/reconcile-state.js";
import { legacyWatchSkipReason } from "../lib/reconcile-legacy.js";
```

Then insert this block immediately after the `const LEDGER = ...` line and before the `// 1. Refresh the catalog cache.` comment:

```js
// 0. Package 4 data guard, the second layer under the systemd flock. devbox-sync re-enables every
// timer on each run, so a disabled timer is not durable. Once configCutover is generated,
// opencode-broker-reconcile is the only scheduled model-change writer, and this job must exit
// before it refreshes, publishes or writes anything. A ledger that cannot be read cannot rule out
// generated mode, so this watch refuses loudly rather than guessing it still owns the job.
let skipReason;
try {
  skipReason = legacyWatchSkipReason(createReconciliationStore().read());
} catch (error) {
  console.error(`opencode-broker-watch: refusing to run: the reconciliation ledger is unreadable: ${error?.message ?? error}`);
  process.exit(1);
}
if (skipReason !== null) {
  console.error(`opencode-broker-watch: skipped: ${skipReason}`);
  process.exit(5);
}
```

In `lib/reconcile-cutover.js` (B5's file):
- Add `import { createLegacyMigration } from "./reconcile-legacy.js";` beside its other `./` imports.
- Inside `createCutoverController`, immediately before its `return` statement, add:

```js
  // B7: the legacy ledger migration is its own module; the controller only exposes it.
  const legacy = createLegacyMigration({ store, clock, fs });
```

- Add these two properties to the object that `createCutoverController` returns:

```js
    recordLegacyQuiesced: legacy.recordLegacyQuiesced,
    importLegacyLedger: legacy.importLegacyLedger,
```

- [ ] **Step 6: Run the tests and verify everything passes**

Run: `node --experimental-test-module-mocks --test tests/reconcile-legacy.test.mjs`
Expected: PASS, 11 tests, 0 failures.

Run: `node --input-type=module -e "const m = await import('./lib/reconcile-cutover.js'); console.log(typeof m.createCutoverController)"`
Expected: prints `function`. This confirms that the controller module still loads with the new import.

Run: `npm test`
Expected: PASS, with no regressions. In particular, `tests/reconcile-state.test.mjs`, `tests/model-reconcile.test.mjs`, `tests/reconcile-cli.test.mjs` and `tests/watch.test.mjs` stay green.

- [ ] **Step 7: Commit**

```bash
git add lib/reconcile-legacy.js lib/reconcile-state.js lib/reconcile-cutover.js bin/opencode-broker-reconcile bin/opencode-broker-watch tests/reconcile-legacy.test.mjs
git commit -m "feat(reconcile): import the legacy reviewed-models ledger once and guard the old watch

import-legacy-ledger --baseline/--final records B, then B + D, with exact
key-set equality. It creates zero transitions and keeps hash-pinned 0400
copies while leaving the writable 0600 ledger untouched for rollback.
record-legacy-quiesced records the old watch's quiescence. The old watch
now exits 5 before any side effect once configCutover.mode is generated."
```

### Task B8: Provider staging, the 24-hour provider gate, and the scheduled run

**Files:**
- Create: `lib/reconcile-provider-stage.js`
- Modify: `lib/reconcile-apply.js`. Export `PROBE_KINDS`, and add `isIncompleteTransition` and `isApplyCandidate`, which `refresh()` then uses.
- Modify: `lib/reconcile-cutover.js`. `createCutoverController` merges the provider stage methods into its returned object.
- Modify: `bin/opencode-broker-reconcile`. Add the provider-stage parse and dispatch, plus USAGE lines.
- Test: `tests/reconcile-provider-stage.test.mjs` (new file)
- Test: `tests/reconcile-cli.test.mjs` (append tests)

**Interfaces:**
- Consumes:
  - `createReconciliationStore({ root, now })` from B2. It returns `{ read(), update(mutator), paths() }`. The v2 ledger accepts top-level `providerStages` and `scheduledRuns` (newest 50), using the contract's schemas. `store.read()` throws on corrupt JSON or a wrong schema.
  - `createResolverGenerationManager({ root, currentLinkPath })`, which returns `{ readRegistry(), current(), generation(n), publish(bundle) }`. `generation(n)` returns `{ generation, directory, manifest, manifestHash, effectiveHash }`. `publish()` of an already-registered generation only re-points `current`.
  - `createReconciliationApplier(...)`, which returns `{ apply({ transitionID }), rollback({ transitionID, reason }), refresh({ dryRun }), recover(...) }`. This is the Package 3 saga, already filtered by the allowlist in B3.
  - `CONFIG.reconcile.apply.{ enabled, providers, overlayPath, generationsRoot, currentLinkPath }` (from B1).
  - `createCutoverController({ paths, store, generations, clock, fs, verifyRawTopology })` (from B5/B6).
  - `runDryReconciliation({ store })` from `lib/model-reconcile.js`.
  - `brokerRequest(path, body, { method })` from `lib/client.js`. `GET /model-policy/status` returns `{ modelPolicy: { roles } }`.
- Produces (`lib/reconcile-provider-stage.js`):
  - `createProviderStage({ store, generations, clock, fs?, paths: { rawBase, overlay }, allowlist: string[], applyEnabled: boolean, applierFactory: () => applier, brokerRequest, confirmQuiescence: () => Promise<{ quiescent: boolean, units }>, observe: () => Promise<void>|void, cutoverMode: () => "generated"|"raw-emergency"|null, registryHash: () => string, newRunID?: (startedAt) => string })`. It returns `{ prepareProvider(id), commitProvider(id), canaryProvider(id), rollbackProvider(id), gateStatus(id), gateStart(id), gateComplete(id), gateReset(id, reason), scheduledRun() }`.
    - `prepareProvider` runs with apply disabled, and re-prepares a `prepared`, `failed` or `rolled-back` stage (the checkpoint is kept). Every stage write carries all six keys `{ schemaVersion, status, prepared, committed, checkpoint, gate }`, with `null` for absent values.
    - configCutover stamping: `commitProvider`, a generated-mode `rollbackProvider`, and an apply-mode `scheduledRun` stamp `configCutover.{ generation, manifestHash, registryHash, sourceLedgerRevision, changedAt, reason: "provider-stage" }` with the live generation, inside the same `store.update` as the stage write where there is one. `scheduledRun` also re-stamps first in generated mode, which heals a crash between a publish and its stamp. The stamp is a CAS on `configCutover.mode === "generated"` and refuses with `config-cutover-cas-failed` otherwise. `commitProvider` returns `configCutoverAck` (the stamped record), and `committed.ledgerAck` is `{ ledgerRevision: <integer revision of the commit write>, contentHash: <providerLedgerRevision digest>, configCutover: { generation, manifestHash, registryHash } }`.
    - Every method resolves to one JSON-safe report: `{ ok, exitCode, command, providerID?, mutated, code?, error?, ... }`.
    - Refusals use `exitCode` 20. `scheduledRun` returns 0, 5 or 20.
    - `gateStatus` returns `{ status, gate, ...eligibility, reason: string|null }` where `reason` is the first eligibility reason or null.
  - `gateEligibility({ stage, scheduledRuns, records, providerID, now })` returns `{ eligible, reasons: string[], elapsedMs, requiredMs, qualifyingRunIDs }`.
  - `systemdQuiescence({ exec?, units? })` returns `{ quiescent, units: {unit: ActiveState} }`.
  - `providerStagePaths({ env, applyConfig })` returns `{ stateRoot, rawBase, overlay, generationsRoot, currentLink }`.
  - `parseProviderStageArgs(argv)` returns `null` when the command is not a provider-stage command, `{ error }`, or `{ command, providerID, reason, json }`.
  - `runProviderStageCommand(stage, { command, providerID, reason })` resolves to a report.
  - Constants and helpers: `EXIT`, `GATE_MIN_ELAPSED_MS`, `SCHEDULED_RUNS_KEPT`, `SCHEDULED_UNITS`, `DEFAULT_RAW_BASE`, `ProviderStageRefusal`, `providerLedgerRevision(state)` (a content digest, stored only as `ledgerAck.contentHash`), `registryFileHash(generationsRoot, fs?)` (sha256 of `resolver-generations.json`).
  - `CONFIG.reconcile.apply.configError` (from B1) non-null makes every stage command and `scheduled-run` refuse with `code: "config-unusable"`, `alert: true`, exit 1.
- Produces (`lib/reconcile-apply.js`): `PROBE_KINDS`, `isIncompleteTransition(record)` and `isApplyCandidate(record)`.
- Produces (`createCutoverController`): an optional `providerStage` option. When it is given, the controller also exposes the nine methods above.
- Pinned Review Focus items: **RF3** (`scheduledRun` on a corrupt ledger or registry exits 20 with an alert, does not mutate anything, and keeps the corrupt bytes) and **RF5** (`gateComplete` reports `clock-regressed` and never completes when the clock is behind).

- [ ] **Step 1: Write the failing unit tests**

Create `tests/reconcile-provider-stage.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReconciliationStore } from "../lib/reconcile-state.js";
import { createCutoverController } from "../lib/reconcile-cutover.js";
import {
  EXIT,
  GATE_MIN_ELAPSED_MS,
  SCHEDULED_RUNS_KEPT,
  createProviderStage,
  parseProviderStageArgs,
  systemdQuiescence,
} from "../lib/reconcile-provider-stage.js";

const HASH = (character) => character.repeat(64);
const GEN0 = Object.freeze({ generation: 0, directory: "/gens/generation-0", manifest: { generation: 0 }, manifestHash: HASH("0"), effectiveHash: HASH("e") });
const GEN1 = Object.freeze({ generation: 1, directory: "/gens/generation-1", manifest: { generation: 1 }, manifestHash: HASH("1"), effectiveHash: HASH("f") });
const T1 = "aaaaaaaaaaaaaaaaaaaaaaaa";

const approvedRecord = () => ({
  transitionID: T1,
  roleKey: "openai:gpt-sol",
  providerID: "openai",
  roleID: "gpt-sol",
  candidateModelID: "gpt-6-sol",
  incumbentModelID: "gpt-5.6-sol",
  proposedTiers: ["smart"],
  proposedFit: {},
  proposedEffortCeiling: "high",
  evidenceRevision: "r1",
  state: "approved",
});

// A real v2 ledger in a temp root; fakes for every other authority, each recording its calls.
const harness = ({ allowlist = ["openai"], applyEnabled = true, mode = "generated" } = {}) => {
  const base = mkdtempSync(join(tmpdir(), "provider-stage-"));
  const stateRoot = join(base, "state");
  mkdirSync(stateRoot, { mode: 0o700 });
  const rawBase = join(base, "opencode.json");
  writeFileSync(rawBase, "{\"provider\":{}}\n", { mode: 0o600 });
  const h = {
    base, rawBase, statePath: join(stateRoot, "model-reconciliation.json"),
    nowMs: 1_000_000, mode, current: GEN0, bundles: new Map([[0, GEN0], [1, GEN1]]),
    published: [], applied: [], rolledBack: [], refreshed: [], observed: 0, applierBuilt: 0,
    quiescent: true, registryError: null, failObserve: null,
    policyRoles: { "openai:gpt-sol": { activeModelID: "gpt-5.6-sol", probationModelID: null } },
  };
  h.clock = () => h.nowMs;
  h.paths = { rawBase, overlay: join(stateRoot, "resolver-overlay.json") };
  h.store = createReconciliationStore({ root: stateRoot, now: h.clock });
  // A cut-over deployment is seeded as real, B2-valid ledger records: generation 0 acknowledged and
  // configCutover naming it. `mode` null seeds a pre-bootstrap ledger with neither record.
  h.store.update((state, { revision }) => {
    const seeded = { ...state, roles: { "openai:gpt-sol": approvedRecord() } };
    if (mode === null) return seeded;
    const at = new Date(h.nowMs).toISOString();
    const targets = h.store.configTargets();
    const common = { schemaVersion: 1, registryHash: HASH("a"), rawBaseHash: HASH("b"), sourceLedgerRevision: revision };
    return {
      ...seeded,
      generationRegistryInitialized: { ...common, generation: 0, manifestHash: GEN0.manifestHash, initializedAt: at },
      configCutover: mode === "generated"
        ? { ...common, mode, target: targets.generated, generation: 0, manifestHash: GEN0.manifestHash, changedAt: at, reason: "bootstrap" }
        : { ...common, mode, target: targets.rawEmergency, generation: null, manifestHash: null, changedAt: at, reason: "emergency-rollback" },
    };
  });
  // Puts the LEDGER (not the cutoverMode stub) into raw-emergency, to exercise the stamp's CAS.
  h.forceLedgerRawEmergency = () => h.store.update((state, { revision }) => ({ ...state, configCutover: {
    ...state.configCutover, mode: "raw-emergency", target: h.store.configTargets().rawEmergency, generation: null,
    manifestHash: null, sourceLedgerRevision: revision, changedAt: new Date(h.nowMs).toISOString(), reason: "emergency-rollback" } }));
  h.generations = {
    readRegistry: () => {
      if (h.registryError) throw new Error(h.registryError);
      return { version: 1, highWater: 1, generations: {} };
    },
    current: () => {
      if (h.registryError) throw new Error(h.registryError);
      return h.current;
    },
    generation: (n) => {
      const bundle = h.bundles.get(n);
      if (!bundle) throw new Error(`resolver generation ${n} is unknown or cleaned`);
      return bundle;
    },
    publish: async (bundle) => { h.published.push(bundle.generation); h.current = bundle; return { ...bundle, changed: false }; },
  };
  const applier = {
    apply: async ({ transitionID }) => {
      h.applied.push(transitionID);
      h.current = GEN1;
      h.store.update((state) => {
        state.roles["openai:gpt-sol"] = {
          ...state.roles["openai:gpt-sol"],
          state: "probation",
          applyIntent: { revision: "i1" },
          generationAck: { generation: 1, manifestHash: GEN1.manifestHash },
          probeResults: { normal: { success: true }, tool: { success: true }, reasoning: { success: true } },
          probeAck: { revision: "i1" },
          probationAck: { revision: "i1" },
        };
        return state;
      });
      h.policyRoles["openai:gpt-sol"] = { activeModelID: "gpt-5.6-sol", probationModelID: "gpt-6-sol" };
      return { ok: true };
    },
    rollback: async ({ transitionID, reason }) => {
      h.rolledBack.push([transitionID, reason]);
      h.store.update((state) => {
        state.roles["openai:gpt-sol"] = { ...state.roles["openai:gpt-sol"], state: "rolled-back" };
        return state;
      });
      h.policyRoles["openai:gpt-sol"] = { activeModelID: "gpt-5.6-sol", probationModelID: null };
      return { ok: true };
    },
    refresh: async ({ dryRun }) => { h.refreshed.push(dryRun); return { ok: true, mutated: false, results: [] }; },
  };
  h.deps = {
    allowlist,
    applyEnabled,
    applierFactory: () => { h.applierBuilt += 1; return applier; },
    brokerRequest: async (path) => {
      assert.equal(path, "/model-policy/status");
      return { modelPolicy: { roles: structuredClone(h.policyRoles) } };
    },
    confirmQuiescence: async () => ({ quiescent: h.quiescent, units: {} }),
    observe: async () => {
      if (h.failObserve) throw new Error(h.failObserve);
      h.observed += 1;
    },
    cutoverMode: () => h.mode,
    registryHash: () => HASH("a"),
    newRunID: (startedAt) => {
      // CONTRACT v2: run IDs derived from ISO timestamps for fixed-format comparison
      const iso = () => new Date(startedAt).toISOString();
      return `${iso()}-${randomUUID().slice(0, 8)}`;
    },
  };
  h.stage = createProviderStage({ store: h.store, generations: h.generations, clock: h.clock, paths: h.paths, ...h.deps });
  h.ledger = () => JSON.parse(readFileSync(h.statePath, "utf8"));
  return h;
};

const withHarness = async (options, run) => {
  const h = harness(options);
  try {
    await run(h);
  } finally {
    rmSync(h.base, { recursive: true, force: true });
  }
};

test("prepare records evidence and a pre-stage checkpoint; commit drives the Package 3 saga", async () => {
  await withHarness({}, async (h) => {
    const prepared = await h.stage.prepareProvider("openai");
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const stage = h.ledger().providerStages.openai;
    assert.equal(stage.status, "prepared");
    assert.equal(stage.schemaVersion, 1);
    assert.equal(stage.prepared.manifestHash, GEN0.manifestHash);
    assert.equal(stage.prepared.effectiveHash, GEN0.effectiveHash);
    assert.match(stage.prepared.baseHash, /^[0-9a-f]{64}$/);
    assert.match(stage.prepared.policyIntentHash, /^[0-9a-f]{64}$/);
    assert.match(stage.prepared.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(stage.checkpoint.generation, 0);
    assert.equal(stage.checkpoint.manifestHash, GEN0.manifestHash);
    assert.deepEqual(stage.checkpoint.allowlist, ["openai"]);
    assert.match(stage.checkpoint.brokerPolicyRevision, /^[0-9a-f]{64}$/);

    h.nowMs += 1000;
    const committed = await h.stage.commitProvider("openai");
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.deepEqual(h.applied, [T1]);
    const after = h.ledger().providerStages.openai;
    assert.equal(after.status, "committed");
    assert.match(after.committed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(after.committed.generation, 1);
    assert.equal(after.committed.manifestHash, GEN1.manifestHash);
    assert.deepEqual(after.committed.generationAck, { generation: 1, manifestHash: GEN1.manifestHash });
    assert.deepEqual(after.checkpoint, stage.checkpoint);
  });
});

test("commit refuses without confirmed quiescence or with drifted evidence, and changes nothing", async () => {
  await withHarness({}, async (h) => {
    await h.stage.prepareProvider("openai");
    h.quiescent = false;
    const before = readFileSync(h.statePath);
    const blocked = await h.stage.commitProvider("openai");
    assert.equal(blocked.code, "quiescence-unconfirmed");
    assert.equal(blocked.exitCode, EXIT.ATTENTION);
    assert.deepEqual(h.applied, []);
    assert.deepEqual(readFileSync(h.statePath), before);

    h.quiescent = true;
    writeFileSync(h.rawBase, "{\"provider\":{\"changed\":true}}\n");
    const drifted = await h.stage.commitProvider("openai");
    assert.equal(drifted.code, "prepared-evidence-mismatch");
    assert.deepEqual(drifted.fields, ["baseHash"]);
    assert.deepEqual(h.applied, []);
    assert.equal(h.ledger().providerStages.openai.status, "prepared");
  });
});

test("prepare refuses a non-allowlisted provider, a second provider while a gate is pending, and raw-emergency", async () => {
  await withHarness({ allowlist: ["openai", "anthropic"] }, async (h) => {
    assert.equal((await h.stage.prepareProvider("alibaba-token-plan")).code, "provider-not-allowlisted");
    assert.equal((await h.stage.prepareProvider("openai")).ok, true);
    const second = await h.stage.prepareProvider("anthropic");
    assert.equal(second.code, "provider-gate-pending");
    assert.equal(second.blockingProvider, "openai");
    h.mode = "raw-emergency";
    assert.equal((await h.stage.prepareProvider("openai")).code, "config-cutover-mode");
  });
});

test("canary passes only on durable exact-model probe evidence that the broker routes", async () => {
  await withHarness({}, async (h) => {
    await h.stage.prepareProvider("openai");
    await h.stage.commitProvider("openai");
    const canary = await h.stage.canaryProvider("openai");
    assert.equal(canary.ok, true, JSON.stringify(canary));
    assert.equal(canary.vacuous, false);
    assert.deepEqual(canary.results.map((result) => result.modelID), ["gpt-6-sol"]);

    h.policyRoles["openai:gpt-sol"] = { activeModelID: "gpt-5.6-sol", probationModelID: null };
    const drifted = await h.stage.canaryProvider("openai");
    assert.equal(drifted.ok, false);
    assert.equal(drifted.exitCode, EXIT.ATTENTION);
    assert.match(drifted.failures.join("\n"), /does not route gpt-6-sol/);
  });
});

test("RF5: the gate needs 24h past startedAt plus a successful scheduled run after commit; a regressed clock never completes", async () => {
  await withHarness({}, async (h) => {
    await h.stage.prepareProvider("openai");
    const early = await h.stage.scheduledRun();
    assert.equal(early.run.mode, "apply");
    h.nowMs += 500;
    assert.equal((await h.stage.commitProvider("openai")).ok, true);
    h.nowMs += 500;
    assert.equal((await h.stage.gateStart("openai")).ok, true);
    const startedAtISO = h.ledger().providerStages.openai.gate.startedAt;
    
    h.nowMs = Date.parse(startedAtISO) + GATE_MIN_ELAPSED_MS - 1;
    const waiting = await h.stage.gateStatus("openai");
    assert.equal(waiting.eligible, false);
    assert.deepEqual(waiting.reasons, ["elapsed-under-24h", "no-successful-scheduled-run"]);
    const second = await h.stage.scheduledRun();
    assert.equal(second.exitCode, EXIT.OK);

    h.nowMs = Date.parse(startedAtISO) - 1;
    const regressed = await h.stage.gateComplete("openai");
    assert.equal(regressed.code, "gate-not-eligible");
    assert.deepEqual(regressed.reasons, ["clock-regressed"]);
    assert.equal(h.ledger().providerStages.openai.status, "gate-running");

    h.nowMs = Date.parse(startedAtISO) + GATE_MIN_ELAPSED_MS;
    const done = await h.stage.gateComplete("openai");
    assert.equal(done.ok, true, JSON.stringify(done));
    const stage = h.ledger().providerStages.openai;
    assert.equal(stage.status, "healthy");
    assert.match(stage.gate.completedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Only the run after commit qualifies; `early` ran before it.
    assert.deepEqual(stage.gate.scheduledRunIDs, [second.run.id]);
    assert.notEqual(early.run.id, second.run.id);
  });
});

test("gate-reset fails the gate, counts the reset, and a new prepare keeps the pre-stage checkpoint", async () => {
  await withHarness({}, async (h) => {
    await h.stage.prepareProvider("openai");
    const checkpoint = h.ledger().providerStages.openai.checkpoint;
    await h.stage.commitProvider("openai");
    await h.stage.gateStart("openai");
    assert.equal((await h.stage.gateReset("openai", "   ")).code, "reason-required");
    const reset = await h.stage.gateReset("openai", "probe drift observed");
    assert.equal(reset.ok, true);
    const failed = h.ledger().providerStages.openai;
    assert.equal(failed.status, "failed");
    assert.equal(failed.gate.resetCount, 1);
    assert.equal(failed.gate.evidence.at(-1).kind, "reset");
    assert.equal(failed.gate.evidence.at(-1).reason, "probe drift observed");

    assert.equal((await h.stage.prepareProvider("openai")).ok, true);
    const reprepared = h.ledger().providerStages.openai;
    assert.deepEqual(reprepared.checkpoint, checkpoint);
    assert.equal(reprepared.gate.resetCount, 1);
  });
});

test("provider rollback restores the checkpoint through the saga and the generation manager, never without quiescence", async () => {
  await withHarness({}, async (h) => {
    await h.stage.prepareProvider("openai");
    await h.stage.commitProvider("openai");
    h.quiescent = false;
    assert.equal((await h.stage.rollbackProvider("openai")).code, "quiescence-unconfirmed");
    assert.deepEqual(h.published, []);
    assert.deepEqual(h.rolledBack, []);

    h.quiescent = true;
    const result = await h.stage.rollbackProvider("openai");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(h.rolledBack.map(([id]) => id), [T1]);
    assert.match(h.rolledBack[0][1], /provider-stage rollback of openai/);
    assert.deepEqual(h.published, [0]);
    assert.equal(h.current.generation, 0);
    assert.deepEqual(result.allowlistWithoutProvider, []);
    assert.equal(h.ledger().providerStages.openai.status, "rolled-back");
  });
});

test("scheduled-run in raw-emergency exits 5 and touches nothing", async () => {
  await withHarness({ mode: "raw-emergency" }, async (h) => {
    const before = readFileSync(h.statePath);
    const run = await h.stage.scheduledRun();
    assert.equal(run.exitCode, EXIT.QUIET);
    assert.equal(run.skipped, "raw-emergency");
    assert.equal(h.observed, 0);
    assert.deepEqual(readFileSync(h.statePath), before);
  });
});

test("scheduled-run with apply disabled only observes, never builds an applier, and keeps the newest 50 runs", async () => {
  await withHarness({ applyEnabled: false, mode: null }, async (h) => {
    const first = h.nowMs;
    for (let index = 0; index < SCHEDULED_RUNS_KEPT + 2; index += 1) {
      const run = await h.stage.scheduledRun();
      assert.equal(run.exitCode, EXIT.OK);
      h.nowMs += 1;
    }
    assert.equal(h.observed, SCHEDULED_RUNS_KEPT + 2);
    assert.equal(h.applierBuilt, 0);
    const runs = h.ledger().scheduledRuns;
    assert.equal(runs.length, SCHEDULED_RUNS_KEPT);
    // The run id is derived from ISO timestamp (format: ISO-uuid), so we check the structure
    assert.match(runs[0].id, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[\da-f]{8}$/);
    assert.ok(runs.every((run) => run.mode === "dry-run" && run.providers.length === 0 && run.ok === true && run.startedAt && run.endedAt));
  });
});

test("RF3: scheduled-run on a corrupt ledger or registry exits 20 with an alert and preserves the bytes", async () => {
  await withHarness({}, async (h) => {
    writeFileSync(h.statePath, "{\"version\": 2, \"roles\": {");
    const before = readFileSync(h.statePath);
    const run = await h.stage.scheduledRun();
    assert.equal(run.exitCode, EXIT.ATTENTION);
    assert.notEqual(run.exitCode, EXIT.QUIET);
    assert.equal(run.code, "state-corrupt");
    assert.equal(run.alert, true);
    assert.equal(run.mutated, false);
    assert.equal(h.observed, 0);
    assert.deepEqual(readFileSync(h.statePath), before);
  });
  await withHarness({}, async (h) => {
    h.registryError = "resolver generation registry is corrupt: Unexpected end of JSON input";
    const before = readFileSync(h.statePath);
    const run = await h.stage.scheduledRun();
    assert.equal(run.exitCode, EXIT.ATTENTION);
    assert.equal(run.code, "registry-corrupt");
    assert.equal(run.alert, true);
    assert.equal(h.observed, 0);
    assert.deepEqual(readFileSync(h.statePath), before);
  });
});

test("a failed scheduled run is recorded and resets every running gate", async () => {
  await withHarness({}, async (h) => {
    await h.stage.prepareProvider("openai");
    await h.stage.commitProvider("openai");
    await h.stage.gateStart("openai");
    h.failObserve = "catalog refresh failed";
    h.nowMs += 10;
    const run = await h.stage.scheduledRun();
    assert.equal(run.ok, false);
    assert.equal(run.exitCode, EXIT.ATTENTION);
    assert.equal(run.code, "run-failed");
    assert.deepEqual(run.gatesReset, ["openai"]);
    const ledger = h.ledger();
    assert.equal(ledger.scheduledRuns.at(-1).ok, false);
    assert.equal(ledger.scheduledRuns.at(-1).exitCode, EXIT.ATTENTION);
    assert.equal(ledger.providerStages.openai.status, "failed");
    assert.equal(ledger.providerStages.openai.gate.resetCount, 1);
    assert.equal(ledger.providerStages.openai.gate.evidence.at(-1).kind, "scheduled-run-failed");
    assert.equal(ledger.providerStages.openai.gate.evidence.at(-1).runID, run.run.id);
  });
});

test("commit stamps configCutover with the published generation in the same ledger write", async () => {
  await withHarness({}, async (h) => {
    await h.stage.prepareProvider("openai");
    const committed = await h.stage.commitProvider("openai");
    assert.equal(committed.ok, true, JSON.stringify(committed));
    const ledger = h.ledger();
    assert.equal(ledger.configCutover.mode, "generated");
    assert.equal(ledger.configCutover.generation, ledger.providerStages.openai.committed.generation);
    assert.equal(ledger.configCutover.manifestHash, GEN1.manifestHash);
    assert.equal(ledger.configCutover.reason, "provider-stage");
    // One write: the stamp's revision is the commit's revision.
    assert.equal(ledger.configCutover.sourceLedgerRevision, ledger.providerStages.openai.committed.ledgerAck.ledgerRevision);
    assert.equal(ledger.configCutover.sourceLedgerRevision, ledger.revision);
    assert.match(ledger.providerStages.openai.committed.ledgerAck.contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(committed.configCutoverAck, ledger.configCutover);
  });
});

test("provider rollback stamps configCutover back to the checkpoint generation", async () => {
  await withHarness({}, async (h) => {
    await h.stage.prepareProvider("openai");
    await h.stage.commitProvider("openai");
    const rolled = await h.stage.rollbackProvider("openai");
    assert.equal(rolled.ok, true, JSON.stringify(rolled));
    const ledger = h.ledger();
    assert.equal(ledger.configCutover.generation, 0);
    assert.equal(ledger.configCutover.manifestHash, GEN0.manifestHash);
    assert.equal(ledger.providerStages.openai.status, "rolled-back");
    assert.deepEqual(Object.keys(ledger.providerStages.openai).sort(),
      ["checkpoint", "committed", "gate", "prepared", "schemaVersion", "status"]);
  });
});

test("the configCutover stamp is a CAS on generated mode and refuses without writing otherwise", async () => {
  await withHarness({}, async (h) => {
    await h.stage.prepareProvider("openai");
    h.forceLedgerRawEmergency();
    const before = readFileSync(h.statePath);
    const committed = await h.stage.commitProvider("openai");
    assert.equal(committed.ok, false);
    assert.equal(committed.code, "config-cutover-cas-failed");
    assert.deepEqual(readFileSync(h.statePath), before);
  });
});

test("a scheduled run re-stamps a stale configCutover before doing anything else", async () => {
  await withHarness({ applyEnabled: false }, async (h) => {
    h.current = GEN1; // published, but the stamp was lost (crash between publish and stamp)
    const run = await h.stage.scheduledRun();
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.equal(h.ledger().configCutover.generation, 1);
    assert.equal(h.ledger().configCutover.manifestHash, GEN1.manifestHash);
  });
});

test("prepare runs with apply disabled, and a second prepare replaces the first", async () => {
  await withHarness({ applyEnabled: false }, async (h) => {
    const first = await h.stage.prepareProvider("openai");
    assert.equal(first.ok, true, JSON.stringify(first));
    h.nowMs += 1000;
    const second = await h.stage.prepareProvider("openai");
    assert.equal(second.ok, true, JSON.stringify(second));
    const stage = h.ledger().providerStages.openai;
    assert.equal(stage.status, "prepared");
    assert.equal(stage.prepared.at, new Date(h.nowMs).toISOString());
    assert.equal(stage.committed, null);
    assert.equal(stage.gate, null);
    assert.deepEqual(stage.checkpoint, first.checkpoint);
  });
});

test("provider stage argv parsing leaves raw-emergency rollback alone and refuses malformed lines", () => {
  assert.deepEqual(parseProviderStageArgs(["prepare", "--provider", "openai", "--json"]),
    { command: "prepare", providerID: "openai", reason: null, json: true });
  assert.deepEqual(parseProviderStageArgs(["rollback-config", "--provider", "openai", "--json"]),
    { command: "rollback-config", providerID: "openai", reason: null, json: true });
  assert.deepEqual(parseProviderStageArgs(["gate-reset", "--provider", "openai", "--reason", "drift", "--json"]),
    { command: "gate-reset", providerID: "openai", reason: "drift", json: true });
  assert.deepEqual(parseProviderStageArgs(["scheduled-run", "--json"]),
    { command: "scheduled-run", providerID: null, reason: null, json: true });
  assert.equal(parseProviderStageArgs(["rollback-config", "--raw-emergency", "--json"]), null);
  assert.equal(parseProviderStageArgs(["status", "--json"]), null);
  assert.match(parseProviderStageArgs(["commit", "--json"]).error, /commit needs --provider/);
  assert.match(parseProviderStageArgs(["gate-reset", "--provider", "openai"]).error, /--reason/);
  assert.match(parseProviderStageArgs(["prepare", "--provider", "Open AI"]).error, /not a provider id/);
  assert.match(parseProviderStageArgs(["canary", "--provider", "openai", "--apply"]).error, /unknown option "--apply"/);
  assert.match(parseProviderStageArgs(["scheduled-run", "--provider", "openai"]).error, /unknown option "--provider"/);
  assert.match(parseProviderStageArgs(["rollback-config", "--provider", "openai", "--raw-emergency"]).error,
    /unknown option "--raw-emergency"/);
});

test("systemd quiescence holds only when both scheduled services are inactive or failed", () => {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    return args.at(-1) === "opencode-model-watch.service" ? "activating\n" : "inactive\n";
  };
  const busy = systemdQuiescence({ exec });
  assert.equal(busy.quiescent, false);
  assert.deepEqual(busy.units, {
    "opencode-model-reconcile.service": "inactive",
    "opencode-model-watch.service": "activating",
  });
  assert.deepEqual(calls[0],
    ["systemctl", "--user", "show", "--property=ActiveState", "--value", "opencode-model-reconcile.service"]);
  assert.equal(systemdQuiescence({ exec: () => "failed\n" }).quiescent, true);
});

test("the cutover controller exposes the provider stage methods when given their dependencies", async () => {
  await withHarness({}, async (h) => {
    // The controller validates its paths and generation manager at construction, so the harness
    // fakes gain the generations-root paths and the manager's build/paths methods here.
    const G = join(h.base, "resolver-generations");
    const managed = { root: G, currentLink: join(G, "current"), registry: join(G, "resolver-generations.json") };
    const controller = createCutoverController({
      paths: { ...h.paths, generationsRoot: managed.root, currentLink: managed.currentLink, registry: managed.registry },
      store: h.store,
      generations: { ...h.generations, build: async () => { throw new Error("build is not used by this test"); }, paths: () => managed },
      clock: h.clock,
      fs,
      verifyRawTopology: () => ({ ok: true }),
      providerStage: h.deps,
    });
    for (const method of ["prepareProvider", "commitProvider", "canaryProvider", "rollbackProvider",
      "gateStatus", "gateStart", "gateComplete", "gateReset", "scheduledRun"]) {
      assert.equal(typeof controller[method], "function", method);
    }
    assert.equal((await controller.gateStatus("openai")).status, "absent");
  });
});
```

- [ ] **Step 2: Run the unit tests and confirm they fail**

Run: `node --experimental-test-module-mocks --test tests/reconcile-provider-stage.test.mjs`
Expected: FAIL with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/dev/opencode-broker/lib/reconcile-provider-stage.js'`

- [ ] **Step 3: Export the saga's own selection predicates from `lib/reconcile-apply.js`**

Change `const PROBE_KINDS = Object.freeze(["normal", "tool", "reasoning"]);` to:

```js
export const PROBE_KINDS = Object.freeze(["normal", "tool", "reasoning"]);
```

Insert the following directly after the `incompleteRecord` definition. That definition ends with `&& RECOVERABLE_STATES.has(record.state);`.

```js
// Exported for lib/reconcile-provider-stage.js, which must hash and drive EXACTLY the transition
// set this saga would. A second copy of either predicate there could drift from refresh().
export const isIncompleteTransition = incompleteRecord;
export const isApplyCandidate = (record) => incompleteRecord(record)
  || (!record?.applyIntent && AUTHORIZED_STATES.has(record?.state));
```

In `refresh`, replace the predicate `.filter((record) => incompleteRecord(record) || (!record?.applyIntent && AUTHORIZED_STATES.has(record?.state)))` with `.filter(isApplyCandidate)`. B3 may have added an allowlist step next to that filter. If it did, keep B3's step and replace only this predicate.

- [ ] **Step 4: Create `lib/reconcile-provider-stage.js`**

```js
// Package 4 provider staging: per-provider prepare / commit / canary / rollback, the persisted
// 24-hour provider health gate, and the daily scheduled run.
//
// CRITICAL: THIS MODULE IS NOT A SECOND APPLY OR ROLLBACK AUTHORITY. Policy, overlay and
// generation changes happen only inside Package 3's saga (lib/reconcile-apply.js apply/rollback/
// refresh) or by Package 3's generation manager republishing an already-registered generation
// (lib/resolver-generations.js publish). This module records evidence around those calls -- what
// was staged, proof it is still exactly that before the saga runs, and the saga's
// acknowledgements -- and writes it only through store.update().
//
// The singleton writer is enforced outside this module: both scheduled units run under
// `flock -n -E 5` on provider-expansion.lock, and the stage script holds that lock on fd 9 for its
// whole run. This module never takes that lock. Before commit and before a provider rollback it
// does confirm that neither scheduled service is running, and refuses loudly when it cannot.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";

import { PROBE_KINDS, isApplyCandidate, isIncompleteTransition } from "./reconcile-apply.js";
import { routingStateDir } from "./routing.js";

export const GATE_MIN_ELAPSED_MS = 24 * 60 * 60 * 1000;
export const SCHEDULED_RUNS_KEPT = 50;
export const SCHEDULED_UNITS = Object.freeze(["opencode-model-reconcile.service", "opencode-model-watch.service"]);
export const DEFAULT_RAW_BASE = "/home/dev/devbox/config/opencode/opencode.json";
// The job-run contract: 0 ok, 5 quiet/skipped, 10 finding, 20 needs attention.
export const EXIT = Object.freeze({ OK: 0, QUIET: 5, FINDING: 10, ATTENTION: 20 });

// CONTRACT v2: every ledger timestamp is UTC ISO-8601 (written by `iso()` inside
// createProviderStage); the gate-eligibility arithmetic parses stored strings with Date.parse and
// compares against now().

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_REASON_LENGTH = 512;
// A stage in one of these blocks every OTHER provider: the next provider may start only once this
// one is healthy or rolled back.
const BLOCKING_STATUSES = new Set(["prepared", "committed", "gate-running", "failed"]);
// Re-preparing from these keeps the checkpoint captured before the stage first changed anything, so
// a retry or a failed gate can never move the rollback target onto the stage's own damage.
const KEEP_CHECKPOINT_STATUSES = new Set(["prepared", "failed"]);
const PREPARABLE_STATUSES = new Set(["prepared", "failed", "rolled-back"]);
const CANARY_STATUSES = new Set(["committed", "gate-running", "healthy"]);
const RESETTABLE_STATUSES = new Set(["committed", "gate-running", "healthy"]);
const ROLLBACK_STATUSES = new Set(["prepared", "committed", "gate-running", "failed"]);
const PROVIDER_COMMANDS = new Set(["prepare", "commit", "canary", "gate-status", "gate-start",
  "gate-complete", "gate-reset", "rollback-config"]);

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const canonicalJSON = (value) => JSON.stringify(canonicalize(value));
const canonicalHash = (value) => createHash("sha256").update(canonicalJSON(value)).digest("hex");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The whole-file registry hash recorded in configCutover.registryHash. The verifier reports this
// value but does not pin it, because the registry legitimately grows as generations publish.
export const registryFileHash = (generationsRoot, fs = nodeFs) =>
  sha256(fs.readFileSync(join(generationsRoot, "resolver-generations.json")));

export class ProviderStageRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProviderStageRefusal";
    this.code = code;
    this.details = details;
  }
}
const refuse = (code, message, details = {}) => { throw new ProviderStageRefusal(code, message, details); };

const transitionRecords = (state) => [...Object.values(state.roles ?? {}), ...Object.values(state.unknown ?? {})];
const providerRecords = (state, providerID) => transitionRecords(state)
  .filter((record) => record?.providerID === providerID);
const byTransitionID = (left, right) => (left.transitionID < right.transitionID ? -1
  : left.transitionID > right.transitionID ? 1 : 0);

// Only transition records count. providerStages and scheduledRuns are this module's own
// bookkeeping: counting them would make every prepare invalidate itself.
export const providerLedgerRevision = (state) =>
  canonicalHash({ roles: state.roles ?? {}, unknown: state.unknown ?? {} });

// CONTRACT v2: every ledgerRevision field in the ledger is the store's integer `revision`.
// providerLedgerRevision above is a content digest and is kept ONLY inside the unchecked ledgerAck.
const ledgerRevisionOf = (state) => {
  if (!Number.isSafeInteger(state?.revision) || state.revision < 0) {
    throw new Error(`reconciliation ledger revision ${String(state?.revision)} is not a non-negative integer`);
  }
  return state.revision;
};

const policyIntent = (state, providerID) => providerRecords(state, providerID)
  .filter(isApplyCandidate)
  .map((record) => ({
    transitionID: record.transitionID,
    roleKey: record.roleKey ?? null,
    state: record.state,
    candidateModelID: record.candidateModelID ?? record.modelID ?? null,
    evidenceRevision: record.evidenceRevision ?? null,
    applyIntentRevision: record.applyIntent?.revision ?? null,
  }))
  .sort(byTransitionID);

// The transitions this stage introduced: the saga acknowledged them in a generation newer than the
// pre-stage checkpoint.
const stagedTransitions = (state, providerID, checkpoint) => providerRecords(state, providerID)
  .filter((record) => record.applyIntent && Number.isInteger(record.generationAck?.generation)
    && record.generationAck.generation > checkpoint.generation)
  .sort(byTransitionID);

export const gateEligibility = ({ stage, scheduledRuns = [], records = [], providerID, now }) => {
  if (stage?.status !== "gate-running") {
    return { eligible: false, reasons: ["gate-not-running"], elapsedMs: null, requiredMs: GATE_MIN_ELAPSED_MS, qualifyingRunIDs: [] };
  }
  const reasons = [];
  const { startedAt } = stage.gate;
  // CONTRACT v2: parse stored ISO strings with Date.parse and compare against now().
  // Keep the comparison run.startedAt > committed.at (fixed-format ISO compares correctly as strings).
  const afterCommit = scheduledRuns.filter((run) => Date.parse(run.startedAt) > Date.parse(stage.committed.at));
  // RF5: a host suspend still advances the wall clock. A clock that is behind the gate start, or
  // behind a run it already recorded, has stepped backward. It is never evidence that 24 hours
  // passed, so it blocks completion instead of being measured.
  if (now() < Date.parse(startedAt) || afterCommit.some((run) => Date.parse(run.startedAt) > now())) reasons.push("clock-regressed");
  else if (now() - Date.parse(startedAt) < GATE_MIN_ELAPSED_MS) reasons.push("elapsed-under-24h");
  const qualifying = afterCommit.filter((run) => run.ok === true && run.mode === "apply"
    && Array.isArray(run.providers) && run.providers.includes(providerID));
  if (!qualifying.length) reasons.push("no-successful-scheduled-run");
  if (afterCommit.some((run) => run.ok !== true)) reasons.push("scheduled-run-failed");
  if (records.some(isIncompleteTransition)) reasons.push("recovery-outstanding");
  if (records.some((record) => record.state === "rolled-back"
    && record.generationAck?.generation > stage.checkpoint.generation)) reasons.push("rollback-present");
  return {
    eligible: reasons.length === 0,
    reasons,
    elapsedMs: now() - Date.parse(startedAt),
    requiredMs: GATE_MIN_ELAPSED_MS,
    qualifyingRunIDs: qualifying.map((run) => run.id),
  };
};

// `systemctl show` reports "inactive" for a unit that is not installed, so a missing unit counts as
// quiescent. A missing systemctl throws, and the caller turns that into a loud refusal.
export const systemdQuiescence = ({ exec = execFileSync, units = SCHEDULED_UNITS } = {}) => {
  const states = Object.fromEntries(units.map((unit) => [unit, String(exec("systemctl",
    ["--user", "show", "--property=ActiveState", "--value", unit], { encoding: "utf8" })).trim()]));
  return {
    quiescent: Object.values(states).every((state) => state === "inactive" || state === "failed"),
    units: states,
  };
};

export const providerStagePaths = ({ env = process.env, applyConfig = {} } = {}) => {
  const stateRoot = env.OPENCODE_RECONCILE_STATE_ROOT || routingStateDir();
  const generationsRoot = applyConfig.generationsRoot ?? join(stateRoot, "resolver-generations");
  return Object.freeze({
    stateRoot,
    rawBase: env.OPENCODE_RECONCILE_RAW_BASE || DEFAULT_RAW_BASE,
    overlay: applyConfig.overlayPath ?? join(stateRoot, "resolver-overlay.json"),
    generationsRoot,
    currentLink: applyConfig.currentLinkPath ?? join(generationsRoot, "current"),
  });
};

// Returns null for any command that is not a provider-stage command, so the CLI's other parsers
// see it unchanged. That includes `rollback-config --raw-emergency`, which belongs to cutover.
export const parseProviderStageArgs = (argv) => {
  const [command, ...rest] = argv;
  if (command !== "scheduled-run" && !PROVIDER_COMMANDS.has(command)) return null;
  if (command === "rollback-config" && !rest.includes("--provider")) return null;
  const options = { command, providerID: null, reason: null, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--json") { options.json = true; continue; }
    const takesValue = (flag === "--provider" && command !== "scheduled-run")
      || (flag === "--reason" && command === "gate-reset");
    if (!takesValue) return { error: `${command}: unknown option "${flag}"` };
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
    index += 1;
    if (flag === "--provider") {
      if (!PROVIDER_ID.test(value)) return { error: `--provider: "${value}" is not a provider id` };
      options.providerID = value;
    } else {
      options.reason = value;
    }
  }
  if (command !== "scheduled-run" && options.providerID === null) return { error: `${command} needs --provider <id>` };
  if (command === "gate-reset" && (options.reason === null || !options.reason.trim())) {
    return { error: "gate-reset needs --reason with the reason to record" };
  }
  return options;
};

export const createProviderStage = ({
  store,
  generations,
  clock,
  fs = nodeFs,
  paths,
  allowlist = [],
  applyEnabled = false,
  applierFactory,
  brokerRequest,
  confirmQuiescence,
  observe,
  cutoverMode,
  registryHash,
  newRunID = (startedAt) => `${new Date(startedAt).toISOString()}-${randomUUID().slice(0, 8)}`,
} = {}) => {
  // `clock` may be a function returning epoch ms (Package 3's `now` convention) or an object with
  // now(). Anything else is a wiring error, so there is no fallback to Date.now.
  const now = typeof clock === "function" ? clock
    : typeof clock?.now === "function" ? () => clock.now() : null;
  const iso = () => new Date(now()).toISOString();
  if (typeof store?.read !== "function" || typeof store?.update !== "function"
    || typeof generations?.readRegistry !== "function" || typeof generations?.current !== "function"
    || typeof generations?.generation !== "function" || typeof generations?.publish !== "function"
    || now === null || typeof fs?.readFileSync !== "function"
    || typeof paths?.rawBase !== "string" || typeof paths?.overlay !== "string"
    || !Array.isArray(allowlist) || typeof applyEnabled !== "boolean"
    || typeof applierFactory !== "function" || typeof brokerRequest !== "function"
    || typeof confirmQuiescence !== "function" || typeof observe !== "function"
    || typeof cutoverMode !== "function" || typeof registryHash !== "function"
    || typeof newRunID !== "function") {
    throw new Error("provider stage dependencies are incomplete");
  }
  const providers = Object.freeze([...allowlist]);

  // A refusal becomes a structured exit-20 report. Any other error is a defect and propagates.
  const settle = async (command, providerID, body) => {
    try {
      return await body();
    } catch (error) {
      if (!(error instanceof ProviderStageRefusal)) throw error;
      return { ok: false, exitCode: EXIT.ATTENTION, command, providerID, mutated: false,
        code: error.code, error: error.message, ...error.details };
    }
  };

  const requireSyntax = (providerID) => {
    if (typeof providerID !== "string" || !PROVIDER_ID.test(providerID)) {
      refuse("invalid-provider", `"${String(providerID)}" is not a provider id`);
    }
  };
  const requireAllowlisted = (providerID) => {
    requireSyntax(providerID);
    if (!providers.includes(providerID)) refuse("provider-not-allowlisted", `${providerID} is not in reconcile.apply.providers`);
  };
  const requireMode = (allowed) => {
    const mode = cutoverMode() ?? null;
    if (!allowed.includes(mode)) {
      refuse("config-cutover-mode", `configCutover mode ${mode ?? "absent"} does not permit this command`, { mode });
    }
    return mode;
  };
  const requireQuiescence = async () => {
    let result;
    try {
      result = await confirmQuiescence();
    } catch (error) {
      refuse("quiescence-unconfirmed", `scheduled writer quiescence could not be confirmed: ${error?.message ?? error}`);
    }
    if (result?.quiescent !== true) {
      refuse("quiescence-unconfirmed", "a scheduled reconciliation writer is not stopped", { units: result?.units ?? null });
    }
  };
  const liveGeneration = () => {
    let bundle;
    try {
      bundle = generations.current() ?? generations.generation(generations.readRegistry().highWater);
    } catch (error) {
      refuse("generation-unverified", `resolver generation evidence is unusable: ${error?.message ?? error}`);
    }
    return bundle;
  };
  const rawBaseHash = () => {
    let bytes;
    try {
      bytes = fs.readFileSync(paths.rawBase);
    } catch (error) {
      refuse("raw-base-unreadable", `raw base ${paths.rawBase} is unreadable: ${error?.message ?? error}`);
    }
    return sha256(bytes);
  };
  // An absent overlay is a legitimate state before the first apply, and it hashes as zero bytes.
  // An empty file would collide with that hash, but the overlay store rejects an empty file before
  // the saga can use it.
  const overlayHash = () => {
    let bytes;
    try {
      bytes = fs.readFileSync(paths.overlay);
    } catch (error) {
      if (error?.code === "ENOENT") return sha256(Buffer.alloc(0));
      refuse("overlay-unreadable", `resolver overlay ${paths.overlay} is unreadable: ${error?.message ?? error}`);
    }
    return sha256(bytes);
  };
  const brokerPolicy = async () => {
    let response;
    try {
      response = await brokerRequest("/model-policy/status", {}, { method: "GET" });
    } catch (error) {
      refuse("broker-policy-unreadable", `broker model-policy status failed: ${error?.message ?? error}`);
    }
    const roles = response?.modelPolicy?.roles;
    if (!plainObject(roles)) refuse("broker-policy-unreadable", "broker model-policy status is malformed");
    return { roles, revision: canonicalHash(roles) };
  };
  // ledgerRevision is NOT part of the evidence equality set: every scheduled run bumps the counter.
  const evidenceFor = (state, providerID, bundle) => ({
    allowlist: [...providers],
    overlayHash: overlayHash(),
    effectiveHash: bundle.effectiveHash,
    baseHash: rawBaseHash(),
    manifestHash: bundle.manifestHash,
    policyIntentHash: canonicalHash(policyIntent(state, providerID)),
  });
  const stageOf = (state, providerID) => state.providerStages?.[providerID] ?? null;
  const withStage = (state, providerID, stage) =>
    ({ ...state, providerStages: { ...(state.providerStages ?? {}), [providerID]: stage } });

  // configCutover must name the live generation: the verifier requires `current` to equal
  // configCutover.generation, and the spec makes the configCutover CAS acknowledgement part of every
  // generated commit. This runs INSIDE the caller's store.update so the stage write and the stamp
  // land in one ledger revision. The CAS precondition is the generated mode; target, rawBaseHash and
  // schemaVersion are carried over unchanged. Equal values return the state untouched.
  const currentRegistryHash = () => {
    try {
      return registryHash();
    } catch (error) {
      refuse("generation-unverified", `resolver generation registry is unreadable: ${error?.message ?? error}`);
    }
  };
  const stampCutover = (state, bundle, registry, revision, at) => {
    const old = state.configCutover;
    if (old?.mode !== "generated") {
      refuse("config-cutover-cas-failed",
        `configCutover mode ${old?.mode ?? "absent"} is not generated; generation ${bundle.generation} was not stamped`,
        { mutated: null });
    }
    if (old.generation === bundle.generation && old.manifestHash === bundle.manifestHash
      && old.registryHash === registry) return state;
    return { ...state, configCutover: { ...old, generation: bundle.generation, manifestHash: bundle.manifestHash,
      registryHash: registry, sourceLedgerRevision: revision, changedAt: at, reason: "provider-stage" } };
  };
  // Standalone re-stamp for the scheduled run: heals a crash between a publish and its stamp.
  const restampConfigCutover = () => {
    const bundle = liveGeneration();
    const registry = currentRegistryHash();
    const at = iso();
    store.update((state, { revision }) => stampCutover(state, bundle, registry, revision, at));
    return { generation: bundle.generation, manifestHash: bundle.manifestHash, registryHash: registry };
  };

  const prepareProvider = (providerID) => settle("prepare", providerID, async () => {
    requireAllowlisted(providerID);
    requireMode([null, "generated"]);
    const bundle = liveGeneration();
    const broker = await brokerPolicy();
    const at = iso();
    // Evaluated inside the ledger lock. A refusal thrown here releases the lock and writes nothing.
    const next = store.update((state) => {
      const own = stageOf(state, providerID);
      if (own && !PREPARABLE_STATUSES.has(own.status)) {
        refuse("provider-stage-active", `${providerID} is ${own.status}; reset or roll it back before preparing again`);
      }
      const blocker = Object.entries(state.providerStages ?? {})
        .find(([id, stage]) => id !== providerID && BLOCKING_STATUSES.has(stage.status));
      if (blocker) {
        refuse("provider-gate-pending",
          `${blocker[0]} is ${blocker[1].status}; it must be healthy or rolled back before ${providerID} stages`,
          { blockingProvider: blocker[0] });
      }
      const prepared = { at, ledgerRevision: ledgerRevisionOf(state), ...evidenceFor(state, providerID, bundle) };
      const checkpoint = own && KEEP_CHECKPOINT_STATUSES.has(own.status) ? own.checkpoint : {
        generation: bundle.generation,
        manifestHash: bundle.manifestHash,
        allowlist: [...providers],
        ledgerRevision: prepared.ledgerRevision,
        brokerPolicyRevision: broker.revision,
      };
      // All six keys, always (B2 exactKeys). A re-prepare after a failed gate keeps that gate, with
      // its resetCount history; B2 allows a prepared stage to carry a gate whose completedAt is null.
      return withStage(state, providerID, {
        schemaVersion: 1, status: "prepared", prepared, committed: null, checkpoint, gate: own?.gate ?? null,
      });
    });
    const stage = stageOf(next, providerID);
    return { ok: true, exitCode: EXIT.OK, command: "prepare", providerID, mutated: true,
      prepared: stage.prepared, checkpoint: stage.checkpoint };
  });

  const commitProvider = (providerID) => settle("commit", providerID, async () => {
    requireAllowlisted(providerID);
    if (!applyEnabled) refuse("reconcile-apply-disabled", "commit needs reconcile.apply.enabled=true; prepare may run while it is disabled");
    requireMode(["generated"]);
    await requireQuiescence();
    const state = store.read();
    const stage = stageOf(state, providerID);
    if (stage?.status !== "prepared") refuse("provider-not-prepared", `${providerID} is ${stage?.status ?? "absent"}; run prepare first`);
    // The stamp at the end is a CAS on generated mode. Check it before the saga too, so a ledger
    // that is not generated refuses with nothing written rather than after Package 3 has applied.
    if (state.configCutover?.mode !== "generated") {
      refuse("config-cutover-cas-failed", `configCutover mode ${state.configCutover?.mode ?? "absent"} is not generated`);
    }
    const evidence = evidenceFor(state, providerID, liveGeneration());
    const fields = Object.keys(evidence)
      .filter((field) => canonicalJSON(evidence[field]) !== canonicalJSON(stage.prepared[field]));
    if (fields.length) refuse("prepared-evidence-mismatch", `prepared evidence changed (${fields.join(", ")}); run prepare again`, { fields });
    const transitionIDs = policyIntent(state, providerID).map((entry) => entry.transitionID);
    if (transitionIDs.length) {
      const applier = applierFactory();
      for (const transitionID of transitionIDs) {
        let result;
        try {
          result = await applier.apply({ transitionID });
        } catch (error) {
          // mutated is unknown: Package 3 has durably recorded whatever it acknowledged.
          refuse("saga-failed", `Package 3 apply of ${transitionID} failed: ${error?.message ?? error}`, { mutated: null, transitionID });
        }
        if (result?.ok !== true) refuse("saga-failed", `Package 3 apply of ${transitionID} did not report ok`, { mutated: null, transitionID });
      }
    }
    const after = liveGeneration();
    const registry = currentRegistryHash();
    const broker = await brokerPolicy();
    const at = iso();
    const next = store.update((current, { revision }) => {
      const own = stageOf(current, providerID);
      if (own?.status !== "prepared" || canonicalJSON(own.prepared) !== canonicalJSON(stage.prepared)) {
        refuse("provider-stage-changed", `${providerID} stage changed while the saga ran`, { mutated: null });
      }
      const configCutover = { generation: after.generation, manifestHash: after.manifestHash, registryHash: registry };
      const staged = withStage(current, providerID, { ...own, status: "committed", committed: {
        at,
        generation: after.generation,
        manifestHash: after.manifestHash,
        generationAck: { generation: after.generation, manifestHash: after.manifestHash },
        brokerAck: { policyRevision: broker.revision },
        // ledgerRevision is the integer revision of THIS write; contentHash is the transition digest.
        ledgerAck: { ledgerRevision: revision, contentHash: providerLedgerRevision(current), configCutover },
      } });
      return stampCutover(staged, after, registry, revision, at);
    });
    return { ok: true, exitCode: EXIT.OK, command: "commit", providerID, mutated: true,
      transitions: transitionIDs, committed: stageOf(next, providerID).committed,
      configCutoverAck: next.configCutover };
  });

  // Package 3's probe launch accepts only STAGED policy. The exact-model probes for a committed
  // stage are therefore the ones the saga already ran and persisted. The canary verifies that
  // durable evidence and checks that the live broker routes each candidate.
  const canaryReport = async (state, providerID) => {
    const stage = stageOf(state, providerID);
    if (!CANARY_STATUSES.has(stage?.status)) {
      refuse("provider-not-committed", `${providerID} has no committed stage to canary`, { status: stage?.status ?? "absent" });
    }
    const policy = await brokerPolicy();
    const bundle = liveGeneration();
    const failures = [];
    if (bundle.generation < stage.committed.generation) {
      failures.push(`live generation ${bundle.generation} is older than committed generation ${stage.committed.generation}`);
    }
    const results = stagedTransitions(state, providerID, stage.checkpoint).map((record) => {
      const modelID = record.candidateModelID ?? record.modelID ?? null;
      const probes = Object.fromEntries(PROBE_KINDS.map((kind) => [kind, record.probeResults?.[kind]?.success === true]));
      const role = policy.roles[record.roleKey] ?? null;
      const routed = modelID !== null && (role?.probationModelID === modelID || role?.activeModelID === modelID);
      if (!Object.values(probes).every(Boolean)) failures.push(`${record.transitionID}: an exact-model probe is missing or failed`);
      if (!record.probeAck) failures.push(`${record.transitionID}: the aggregate probe acknowledgement is missing`);
      if (!routed) failures.push(`${record.transitionID}: broker policy does not route ${modelID}`);
      return { transitionID: record.transitionID, roleKey: record.roleKey ?? null, modelID, probes,
        probeAck: Boolean(record.probeAck), routed };
    });
    return { results, failures, vacuous: results.length === 0, canaryHash: canonicalHash({ results, failures }) };
  };

  const canaryProvider = (providerID) => settle("canary", providerID, async () => {
    requireSyntax(providerID);
    const report = await canaryReport(store.read(), providerID);
    const ok = report.failures.length === 0;
    return { ok, exitCode: ok ? EXIT.OK : EXIT.ATTENTION, command: "canary", providerID, mutated: false, ...report };
  });

  const eligibilityAt = (state, providerID, at) => gateEligibility({
    stage: stageOf(state, providerID),
    scheduledRuns: state.scheduledRuns ?? [],
    records: providerRecords(state, providerID),
    providerID,
    now: () => at,
  });

  const gateStatus = (providerID) => settle("gate-status", providerID, async () => {
    requireSyntax(providerID);
    const state = store.read();
    const stage = stageOf(state, providerID);
    return { ok: true, exitCode: EXIT.OK, command: "gate-status", providerID, mutated: false,
      status: stage?.status ?? "absent", gate: stage?.gate ?? null,
      ...eligibilityAt(state, providerID, now()), reason: eligibilityAt(state, providerID, now()).reasons[0] ?? null };
  });

  const gateStart = (providerID) => settle("gate-start", providerID, async () => {
    requireAllowlisted(providerID);
    const state = store.read();
    const stage = stageOf(state, providerID);
    if (stage?.status !== "committed") {
      refuse("provider-not-committed", `${providerID} is ${stage?.status ?? "absent"}; the gate starts only after a successful commit`);
    }
    const canary = await canaryReport(state, providerID);
    if (canary.failures.length) refuse("canary-failed", `${providerID} canary failed; the gate was not started`, { failures: canary.failures });
    const startedAt = now();
    const next = store.update((current) => {
      const own = stageOf(current, providerID);
      if (own?.status !== "committed" || canonicalJSON(own.committed) !== canonicalJSON(stage.committed)) {
        refuse("provider-stage-changed", `${providerID} stage changed while the gate was starting`);
      }
      return withStage(current, providerID, { ...own, status: "gate-running", gate: {
        startedAt: iso(), completedAt: null, scheduledRunIDs: [],
        evidence: [{ kind: "canary", at: iso(), hash: canary.canaryHash }],
        resetCount: own.gate?.resetCount ?? 0,
      } });
    });
    return { ok: true, exitCode: EXIT.OK, command: "gate-start", providerID, mutated: true, gate: stageOf(next, providerID).gate };
  });

  const gateComplete = (providerID) => settle("gate-complete", providerID, async () => {
    requireAllowlisted(providerID);
    const state = store.read();
    if (stageOf(state, providerID)?.status !== "gate-running") refuse("gate-not-running", `${providerID} has no running gate`);
    const canary = await canaryReport(state, providerID);
    const completedAt = now();
    // Eligibility is decided again inside the lock, against the bytes that will be written.
    const next = store.update((current) => {
      const own = stageOf(current, providerID);
      const verdict = eligibilityAt(current, providerID, completedAt);
      const reasons = [...verdict.reasons, ...(canary.failures.length ? ["canary-failed"] : [])];
      if (reasons.length) {
        refuse("gate-not-eligible", `${providerID} gate cannot complete: ${reasons.join(", ")}`,
          { reasons, elapsedMs: verdict.elapsedMs, requiredMs: verdict.requiredMs, failures: canary.failures });
      }
      return withStage(current, providerID, { ...own, status: "healthy", gate: {
        ...own.gate,
        completedAt: iso(),
        scheduledRunIDs: verdict.qualifyingRunIDs,
        evidence: [...own.gate.evidence,
          { kind: "scheduled-runs", at: iso(), runIDs: verdict.qualifyingRunIDs },
          { kind: "elapsed-ms", at: iso(), ms: verdict.elapsedMs },
          { kind: "canary", at: iso(), hash: canary.canaryHash }],
      } });
    });
    return { ok: true, exitCode: EXIT.OK, command: "gate-complete", providerID, mutated: true,
      status: "healthy", gate: stageOf(next, providerID).gate };
  });

  const gateReset = (providerID, reason) => settle("gate-reset", providerID, async () => {
    requireSyntax(providerID);
    const text = typeof reason === "string" ? reason.trim() : "";
    if (!text || text.length > MAX_REASON_LENGTH) refuse("reason-required", `gate-reset needs a reason of 1-${MAX_REASON_LENGTH} characters`);
    const at = iso();
    const next = store.update((state) => {
      const own = stageOf(state, providerID);
      if (!RESETTABLE_STATUSES.has(own?.status)) {
        refuse("gate-not-resettable", `${providerID} is ${own?.status ?? "absent"}; only a committed, running or healthy gate resets`);
      }
      const gate = own.gate ?? { startedAt: at, completedAt: null, scheduledRunIDs: [], evidence: [], resetCount: 0 };
      return withStage(state, providerID, { ...own, status: "failed", gate: {
        ...gate, completedAt: null, resetCount: gate.resetCount + 1,
        evidence: [...gate.evidence, { kind: "reset", at, reason: text }],
      } });
    });
    return { ok: true, exitCode: EXIT.OK, command: "gate-reset", providerID, mutated: true,
      status: "failed", gate: stageOf(next, providerID).gate };
  });

  const rollbackProvider = (providerID) => settle("rollback-provider", providerID, async () => {
    requireSyntax(providerID);
    const mode = requireMode([null, "generated"]);
    const state = store.read();
    const stage = stageOf(state, providerID);
    if (stage?.status === "healthy") {
      refuse("provider-healthy", `${providerID} is healthy; a provider checkpoint rollback is only for a failed or unfinished stage`);
    }
    if (!ROLLBACK_STATUSES.has(stage?.status)) {
      refuse("provider-not-rollbackable", `${providerID} is ${stage?.status ?? "absent"}; nothing to roll back`);
    }
    // Quiescence comes first. Nothing is rolled back or republished while a scheduled writer may be running.
    await requireQuiescence();
    const { checkpoint } = stage;
    let target;
    try {
      target = generations.generation(checkpoint.generation);
    } catch (error) {
      refuse("checkpoint-generation-unusable", `checkpoint generation ${checkpoint.generation} is unusable: ${error?.message ?? error}`);
    }
    if (target.manifestHash !== checkpoint.manifestHash) {
      refuse("checkpoint-manifest-mismatch", `generation ${checkpoint.generation} no longer has the checkpoint manifest hash`);
    }
    const reason = `provider-stage rollback of ${providerID} to generation ${checkpoint.generation}`;
    const pending = stagedTransitions(state, providerID, checkpoint).filter((record) => record.state !== "rolled-back");
    const rolledBack = [];
    if (pending.length) {
      const applier = applierFactory();
      for (const record of pending) {
        try {
          await applier.rollback({ transitionID: record.transitionID, reason });
        } catch (error) {
          refuse("saga-rollback-failed", `Package 3 rollback of ${record.transitionID} failed: ${error?.message ?? error}`,
            { mutated: null, rolledBack, transitionID: record.transitionID });
        }
        rolledBack.push(record.transitionID);
      }
    }
    // Before cutover there is no live link for this module to move. The first switch belongs to
    // cutover-config, and a pre-cutover stage cannot have committed anything.
    let restored = null;
    let registry = null;
    if (mode === "generated") {
      if (liveGeneration().generation !== checkpoint.generation) await generations.publish(target);
      restored = liveGeneration();
      if (restored.generation !== checkpoint.generation || restored.manifestHash !== checkpoint.manifestHash) {
        refuse("checkpoint-restore-unverified", "the live generation is not the checkpoint after republishing it", { mutated: true });
      }
      registry = currentRegistryHash();
    }
    const broker = await brokerPolicy();
    const at = iso();
    const next = store.update((current, { revision }) => {
      const own = stageOf(current, providerID);
      if (canonicalJSON(own?.checkpoint) !== canonicalJSON(checkpoint)) {
        refuse("provider-stage-changed", `${providerID} stage changed during rollback`, { mutated: true });
      }
      const staged = withStage(current, providerID, { ...own, status: "rolled-back",
        gate: own.gate ? { ...own.gate, completedAt: null,
          evidence: [...own.gate.evidence, { kind: "rollback", at, generation: checkpoint.generation, transitions: rolledBack.length }] } : null });
      // The restored checkpoint generation is now live, so configCutover must name it too.
      return restored ? stampCutover(staged, restored, registry, revision, at) : staged;
    });
    return { ok: true, exitCode: EXIT.OK, command: "rollback-provider", providerID, mutated: true,
      rolledBackTransitions: rolledBack, restoredGeneration: checkpoint.generation, manifestHash: checkpoint.manifestHash,
      configCutoverAck: next.configCutover ?? null,
      brokerPolicyRevision: broker.revision, checkpointBrokerPolicyRevision: checkpoint.brokerPolicyRevision,
      allowlistWithoutProvider: providers.filter((id) => id !== providerID) };
  });

  const scheduledRun = async () => {
    const alert = (code, error, extra = {}) => ({ ok: false, exitCode: EXIT.ATTENTION, command: "scheduled-run",
      code, alert: true, mutated: false, error, ...extra });
    const startedAt = now();
    const startedAtIso = new Date(startedAt).toISOString();
    // RF3: a ledger or registry that does not validate is reported and left byte-for-byte as it is.
    // It is never repaired or replaced, and no work runs on top of it.
    try {
      store.read();
    } catch (error) {
      return alert("state-corrupt", `the reconciliation ledger is unreadable and was left untouched: ${error?.message ?? error}`);
    }
    const mode = cutoverMode() ?? null;
    if (mode === "raw-emergency") {
      return { ok: true, exitCode: EXIT.QUIET, command: "scheduled-run", mutated: false, skipped: "raw-emergency" };
    }
    try {
      generations.readRegistry();
      generations.current();
    } catch (error) {
      return alert("registry-corrupt", `the resolver generation registry is unusable and was left untouched: ${error?.message ?? error}`);
    }
    // Self-heal first: a crash between a publish and its configCutover stamp leaves the verifier
    // reporting current-link-mismatch until this runs. Equal values write nothing.
    if (mode === "generated") {
      try {
        restampConfigCutover();
      } catch (error) {
        return alert("config-cutover-restamp-failed",
          `configCutover could not be stamped with the live generation: ${error?.message ?? error}`);
      }
    }
    const runMode = applyEnabled && mode === "generated" && providers.length > 0 ? "apply" : "dry-run";
    let failure = null;
    let applied = 0;
    try {
      await observe();
      // The applier is built only in apply mode. A dormant install never reads the gateway key or
      // touches apply paths.
      if (runMode === "apply") {
        const result = await applierFactory().refresh({ dryRun: false });
        if (result?.ok !== true) throw new Error("Package 3 refresh did not report ok");
        applied = Array.isArray(result.results) ? result.results.length : 0;
        // A refresh that published a new generation is stamped before the run is recorded; a
        // failed stamp fails the run (and its running gates), loudly.
        restampConfigCutover();
      }
    } catch (error) {
      failure = error?.message ?? String(error);
    }
    const ok = failure === null;
    const exitCode = ok ? EXIT.OK : EXIT.ATTENTION;
    const id = newRunID(startedAt);
    const gatesReset = [];
    let run;
    try {
      store.update((state) => {
        gatesReset.length = 0;
        run = { id, startedAt: startedAtIso, endedAt: iso(), ok, mode: runMode, providers: runMode === "apply" ? [...providers] : [],
          ledgerRevision: ledgerRevisionOf(state), exitCode };
        const stages = { ...(state.providerStages ?? {}) };
        if (!ok) {
          // A failed run fails every running gate, and that provider then needs a new prepare and commit.
          for (const [providerID, stage] of Object.entries(stages)) {
            if (stage.status !== "gate-running") continue;
            gatesReset.push(providerID);
            stages[providerID] = { ...stage, status: "failed", gate: { ...stage.gate, completedAt: null,
              resetCount: stage.gate.resetCount + 1,
              evidence: [...stage.gate.evidence, { kind: "scheduled-run-failed", at: iso(), runID: id }] };
          }
        }
        return { ...state, providerStages: stages,
          scheduledRuns: [...(state.scheduledRuns ?? []), run].slice(-SCHEDULED_RUNS_KEPT) };
      });
    } catch (error) {
      return alert("run-record-failed", `the scheduled run could not be recorded: ${error?.message ?? error}`, { runFailure: failure });
    }
    return { ok, exitCode, command: "scheduled-run", mutated: true, run, appliedTransitions: applied, gatesReset,
      ...(ok ? {} : { code: "run-failed", alert: true, error: failure }) };
  };

  return { prepareProvider, commitProvider, canaryProvider, rollbackProvider, gateStatus, gateStart, gateComplete, gateReset, scheduledRun };
};

export const runProviderStageCommand = async (stage, { command, providerID, reason }) => {
  if (command === "prepare") return await stage.prepareProvider(providerID);
  if (command === "commit") return await stage.commitProvider(providerID);
  if (command === "canary") return await stage.canaryProvider(providerID);
  if (command === "rollback-config") return await stage.rollbackProvider(providerID);
  if (command === "gate-status") return await stage.gateStatus(providerID);
  if (command === "gate-start") return await stage.gateStart(providerID);
  if (command === "gate-complete") return await stage.gateComplete(providerID);
  if (command === "gate-reset") return await stage.gateReset(providerID, reason);
  if (command === "scheduled-run") return await stage.scheduledRun();
  throw new Error(`unknown provider stage command ${command}`);
};
```

- [ ] **Step 5: Merge the stage methods into `createCutoverController` (`lib/reconcile-cutover.js`)**

Add this import beside the module's other `./` imports:

```js
import { createProviderStage } from "./reconcile-provider-stage.js";
```

Add `providerStage = null` to the destructured parameter object of `createCutoverController`. The existing parameters are `{ paths, store, generations, clock, fs, verifyRawTopology }`. Insert the following directly before the controller's final `return`:

```js
  // Provider staging (Task B8) is optional, so B5/B6 callers that construct a controller without
  // apply dependencies keep working. When it is supplied, the same injected store, generation
  // manager, clock and fs serve both halves; `providerStage` supplies every other authority,
  // including `registryHash` (production: () => registryFileHash(paths.generationsRoot)).
  const stageMethods = providerStage
    ? createProviderStage({ store, generations, clock, fs, paths: { rawBase: paths.rawBase, overlay: paths.overlay }, ...providerStage })
    : {};
```

Then add `...stageMethods,` as the last entry of the object literal that `createCutoverController` returns. If B5 wrapped that literal in `Object.freeze(...)`, add the entry inside the freeze call.

- [ ] **Step 6: Run the unit tests and confirm they pass**

Run: `node --experimental-test-module-mocks --test tests/reconcile-provider-stage.test.mjs tests/reconcile-apply.test.mjs`
Expected: PASS. Every provider-stage test passes (`# fail 0`), and every `reconcile-apply` test still passes. The `refresh` predicate is unchanged in behaviour.

- [ ] **Step 7: Write the failing CLI tests**

Append these tests to `tests/reconcile-cli.test.mjs`. They use the file's existing `withFixture`, `runCLI` and `readLedger` helpers, plus its `existsSync`, `readFileSync`, `writeFileSync` and `join` imports.

```js
test("scheduled-run on a corrupt ledger exits 20 with an alert and leaves the bytes untouched", () => {
  withFixture("scheduled-corrupt", (fixture) => {
    writeFileSync(fixture.statePath, "{\"version\": 2, \"roles\": {", { mode: 0o600 });
    const before = readFileSync(fixture.statePath);
    const result = runCLI(fixture, ["scheduled-run", "--json"]);
    assert.equal(result.status, 20, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.code, "state-corrupt");
    assert.equal(report.alert, true);
    assert.deepEqual(readFileSync(fixture.statePath), before);
  });
});

test("scheduled-run with apply disabled runs a dry-run and records exactly one run", () => {
  withFixture("scheduled-dry", (fixture) => {
    const result = runCLI(fixture, ["scheduled-run", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.run.mode, "dry-run");
    assert.deepEqual(report.run.providers, []);
    assert.equal(readLedger(fixture).scheduledRuns.length, 1);
    assert.equal(existsSync(join(fixture.stateRoot, "resolver-generations")), false);
  });
});

test("provider stage commands refuse as JSON with exit 20 and reject malformed lines with exit 2", () => {
  withFixture("stage-refusals", (fixture) => {
    const refused = runCLI(fixture, ["prepare", "--provider", "openai", "--json"]);
    assert.equal(refused.status, 20, refused.stderr);
    assert.equal(JSON.parse(refused.stdout).code, "provider-not-allowlisted");

    const missing = runCLI(fixture, ["prepare", "--json"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /prepare needs --provider/);

    const mixed = runCLI(fixture, ["rollback-config", "--provider", "openai", "--raw-emergency"]);
    assert.equal(mixed.status, 2);
    assert.match(mixed.stderr, /unknown option "--raw-emergency"/);
  });
});
```

- [ ] **Step 8: Run the CLI tests and confirm they fail**

Run: `node --experimental-test-module-mocks --test --test-name-pattern="scheduled-run|provider stage commands" tests/reconcile-cli.test.mjs`
Expected: FAIL. `scheduled-run` and `prepare` are unknown commands, so the first assertions report `2 !== 20` and `2 !== 0`.

- [ ] **Step 9: Wire the CLI (`bin/opencode-broker-reconcile`)**

Add these imports next to the existing `../lib/` imports:

```js
import { createResolverGenerationManager } from "../lib/resolver-generations.js";
import {
  createProviderStage,
  parseProviderStageArgs,
  providerStagePaths,
  registryFileHash,
  runProviderStageCommand,
  systemdQuiescence,
} from "../lib/reconcile-provider-stage.js";
```

`createResolverGenerationManager` is already imported. Do not duplicate that line. Only the second import is new.

Append these lines to the `USAGE` array before `].join("\n");`:

```js
  "  prepare|commit|canary --provider <id> --json",
  "                                        stage one allowlisted provider through the Package 3 saga",
  "  rollback-config --provider <id> --json  restore that provider's pre-stage checkpoint",
  "  gate-status|gate-start|gate-complete --provider <id> --json",
  "  gate-reset --provider <id> --reason TEXT --json",
  "                                        the persisted 24-hour provider health gate",
  "  scheduled-run --json                  the daily run: dry-run, or apply when enabled and cut over",
```

Add this function directly above `const run = async (argv) => {`:

```js
// The provider stage report is always JSON, because job-run and the stage script parse it. Every
// rule lives in lib/reconcile-provider-stage.js. This function only builds its dependencies.
const runProviderStage = async (options) => {
  // An unparseable config, or an invalid apply block (B1: e.g. an allowlisted provider that is no
  // longer trusted), stops every stage command and the scheduled run with an alert. It never
  // degrades a scheduled run to a quiet dry-run.
  const configProblem = CONFIG_ERROR ?? CONFIG.reconcile.apply.configError ?? null;
  if (configProblem) {
    write(JSON.stringify({ ok: false, command: options.command, code: "config-unusable", alert: true, error: configProblem }, null, 2));
    return EXIT_ERROR;
  }
  try {
    const applyConfig = CONFIG.reconcile.apply;
    const paths = providerStagePaths({ env: process.env, applyConfig });
    const store = createReconciliationStore({ root: paths.stateRoot });
    const stage = createProviderStage({
      store,
      generations: createResolverGenerationManager({ root: paths.generationsRoot, currentLinkPath: paths.currentLink }),
      clock: Date.now,
      paths,
      allowlist: applyConfig.providers ?? [],
      applyEnabled: applyConfig.enabled,
      applierFactory: () => createApplyRuntime(store),
      brokerRequest,
      confirmQuiescence: () => systemdQuiescence(),
      observe: () => runDryReconciliation({ store }),
      cutoverMode: () => store.read().configCutover?.mode ?? null,
      registryHash: () => registryFileHash(paths.generationsRoot),
    });
    const report = await runProviderStageCommand(stage, options);
    write(JSON.stringify(report, null, 2));
    return report.exitCode;
  } catch (error) {
    write(JSON.stringify({ ok: false, command: options.command, code: "error", alert: true, error: error?.message ?? String(error) }, null, 2));
    return EXIT_ERROR;
  }
};
```

Make these lines the first statements inside `run`, before `const options = parseArgs(argv);`:

```js
  // Provider staging and the scheduled run are parsed first, so the older parser never sees them.
  // `rollback-config` without --provider falls through to the cutover parser untouched.
  const stageOptions = parseProviderStageArgs(argv);
  if (stageOptions?.error) {
    complain(`${stageOptions.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (stageOptions) return await runProviderStage(stageOptions);
```

- [ ] **Step 10: Run the CLI tests, then the full suite, and confirm they pass**

Run: `node --experimental-test-module-mocks --test tests/reconcile-cli.test.mjs tests/reconcile-provider-stage.test.mjs`
Expected: PASS. This includes the three new CLI tests and every existing CLI test.

Run: `npm test`
Expected: PASS with 0 failures.

- [ ] **Step 11: Commit**

```bash
git add lib/reconcile-provider-stage.js lib/reconcile-apply.js lib/reconcile-cutover.js bin/opencode-broker-reconcile tests/reconcile-provider-stage.test.mjs tests/reconcile-cli.test.mjs
git commit -m "Add provider staging, the persisted 24-hour provider gate and the scheduled reconcile run

prepare/commit/canary per provider drive only the Package 3 saga and record the
contract's prepared/committed/checkpoint evidence; rollback-config --provider
restores the pre-stage checkpoint through the saga and the generation manager
after confirming scheduled-writer quiescence. The gate completes only after 24h
of non-regressed wall clock and a successful scheduled apply run after commit.
scheduled-run exits 5 in raw-emergency, dry-runs while apply is disabled or
before cutover, keeps the newest 50 runs, and fails loudly with exit 20 and no
mutation on a corrupt ledger or registry."
```

### Task B9: Document the Package 4 cutover in README, STATE and CHANGELOG

**Files:**
- Create: `tests/docs-package-4.test.mjs`
- Modify: `README.md`. Six places: the `reconcile.apply` row of the Configuration reference table (line 113 at 38069c6); the "Model discovery and the reconciliation lifecycle" intro (lines 315-318); the `reviewed-models.json` bullet (lines 355-357); the "Dormant model-promotion runtime" opening paragraph (lines 361-365); a new subsection inserted before "### Evidence, collected through the gateway" (line 389); and the `opencode-broker-watch` and `opencode-broker-reconcile` rows of "Other pieces" (lines 737-738).
- Modify: `docs/STATE.md`. Five places: the `reviewed-models.json` inventory row (line 19); the `model-reconciliation.json` ownership row (line 34); the dormancy paragraph (lines 44-47); the schema paragraph of "Inside `model-reconciliation.json`" (lines 51-54); and a new section "## Package 4 cutover state" inserted before "## The reconciliation ledger lock" (line 268).
- Modify: `CHANGELOG.md`. Add Package 4 bullets at the end of the existing `## [Unreleased]` → `### Added` list, and add a new `### Changed` list before the existing `### Fixed`. Do not add a version heading.
- Not modified: `docs/API.md`. Package 4 adds no socket endpoint: the canary uses the existing Package 3 probe path, and every new surface is a CLI subcommand. Step 6 proves the file is untouched.

**Interfaces:**
- Consumes:
  - From B2: `export const RECONCILIATION_STATE_VERSION = 2` in `lib/reconcile-state.js`.
  - From B5: `export function createCutoverController({ paths, store, generations, clock, fs, verifyRawTopology })` in `lib/reconcile-cutover.js`. Only its existence is checked.
  - From B5-B8: every CLI subcommand name in the contract, present as a string literal (or object key) in `bin/opencode-broker-reconcile` or, for B8's provider-stage commands, in `lib/reconcile-provider-stage.js`. The names are `preflight-topology`, `bootstrap-generation-zero`, `verify-deployed-config`, `cutover-config`, `rollback-config`, `record-legacy-quiesced`, `import-legacy-ledger`, `prepare`, `commit`, `canary`, `gate-status`, `gate-start`, `gate-complete`, `gate-reset` and `scheduled-run`.
  - Reason strings: `"provider-not-allowlisted"` from B3 and `"clock-regressed"` from B8.
  - From B6: the `verify-deployed-config` output keys `ok, mode, expectedTarget, actualTarget, generation, registryHash, manifestHash, rawBaseHash, ledgerRevision`, with `mode` one of `"pre-bootstrap" | "bootstrap-incomplete" | "generated" | "raw-emergency" | "invalid"`.
- Produces:
  - `tests/docs-package-4.test.mjs`. `npm test` picks it up through the `tests/*.test.mjs` glob.
  - README anchor `#fleet-cutover-and-staged-provider-activation` and STATE anchor `#package-4-cutover-state`. F5 and the runbook may link to both.
  - Eight bold CHANGELOG bullet titles under `## [Unreleased]`. R1 must move them into `## [1.25.0] — <date>` together with Holden's pending entries. The test accepts the section whether its heading is `[Unreleased]` or `[1.25.0]`, so it stays green across R1.

- [ ] **Step 1: Verify that B1-B8 landed and that the code agrees with the contract paths**

Run from `/home/dev/opencode-broker`:

```bash
git --no-pager status --short
node -e 'import("./lib/reconcile-state.js").then((m) => { if (m.RECONCILIATION_STATE_VERSION !== 2) { console.error({ version: m.RECONCILIATION_STATE_VERSION }); process.exit(1); } })'
node -e 'import("./lib/reconcile-cutover.js").then((m) => { if (typeof m.createCutoverController !== "function") { console.error("createCutoverController missing"); process.exit(1); } })'
rg -n 'provider-not-allowlisted' lib
rg -n 'clock-regressed' lib
rg -n 'resolver-generations/current|resolver-generations\.json' lib bin
rg -n 'createResolverGenerationManager\(' lib/reconcile-cutover.js bin/opencode-broker-reconcile
rg -n 'dirname\(currentLinkPath\) !== root' lib/resolver-generations.js
git --no-pager diff --stat 38069c6 HEAD -- README.md docs/STATE.md docs/API.md CHANGELOG.md
```

What each line must show:
- `git status`: no modified tracked file among the files this task touches (README.md, docs/STATE.md, docs/API.md, CHANGELOG.md, tests/docs-package-4.test.mjs). Unrelated modified files elsewhere are not staged and do not block.
- Both `node -e` checks exit 0.
- Each of the first three `rg` commands prints at least one match.
- The last `git diff --stat` prints nothing.

Before you go on, check the layout:
1. Read the `createResolverGenerationManager(` call sites that `rg` printed.
2. If `lib/resolver-generations.js` still enforces `dirname(currentLinkPath) !== root`, the call must make that check pass with the deployed contract paths. Those paths are `currentLinkPath=/home/dev/.local/share/opencode/model-routing/resolver-generations/current`, registry `/home/dev/.local/share/opencode/model-routing/resolver-generations/resolver-generations.json`, and generations under `/home/dev/.local/share/opencode/model-routing/resolver-generations`.
3. If the code places the registry, the generation directories or the current link anywhere else, **stop and report BLOCKED**, quoting the call and the paths. Step 3's deployed-layout table must not describe a layout the code rejects.

Step 1 precondition (per contract v2 Repository hygiene): Holden's uncommitted work must be committed or set aside before execution starts. If `git diff --name-only` lists CHANGELOG.md, README.md or docs/STATE.md, stop and ask Holden to commit those hunks first. No task stages a file containing his uncommitted work.

- [ ] **Step 2: Write the failing documentation contract test**

Create `tests/docs-package-4.test.mjs`:

```js
// Documentation contract for the Package 4 fleet cutover. It pins the operator-facing docs to
// the code they describe: every documented cutover command must exist in the CLI, the ledger
// schema version in docs/STATE.md must be the one lib/reconcile-state.js writes, the deployed
// paths must be the contract's exact absolute paths, and the changelog must keep the Package 4
// entries in the same pending section as the entries already waiting beside them (R1 moves
// that section to 1.25.0 intact, so either heading is accepted).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { RECONCILIATION_STATE_VERSION } from "../lib/reconcile-state.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const README = read("README.md");
const STATE = read("docs/STATE.md");
const CHANGELOG = read("CHANGELOG.md");
const RECONCILE_BIN = read("bin/opencode-broker-reconcile");
// B8 defines the provider-stage subcommand names (prepare, commit, canary, gate-*, scheduled-run)
// in the library that bin/opencode-broker-reconcile delegates to.
const PROVIDER_STAGE_LIB = read("lib/reconcile-provider-stage.js");

const USAGE = Object.freeze([
  "opencode-broker-reconcile preflight-topology --json",
  "opencode-broker-reconcile bootstrap-generation-zero --json",
  "opencode-broker-reconcile verify-deployed-config --json",
  "opencode-broker-reconcile cutover-config --json",
  "opencode-broker-reconcile rollback-config --raw-emergency --json",
  "opencode-broker-reconcile rollback-config --provider <id> --json",
  "opencode-broker-reconcile record-legacy-quiesced --json",
  "opencode-broker-reconcile import-legacy-ledger --baseline --json",
  "opencode-broker-reconcile import-legacy-ledger --final --json",
  "opencode-broker-reconcile prepare --provider <id> --json",
  "opencode-broker-reconcile commit --provider <id> --json",
  "opencode-broker-reconcile canary --provider <id> --json",
  "opencode-broker-reconcile gate-status --provider <id> --json",
  "opencode-broker-reconcile gate-start --provider <id> --json",
  "opencode-broker-reconcile gate-complete --provider <id> --json",
  "opencode-broker-reconcile gate-reset --provider <id> --reason <text> --json",
  "opencode-broker-reconcile scheduled-run --json",
]);

const STATE_ROOT = "/home/dev/.local/share/opencode/model-routing";
const DEPLOYED_PATHS = Object.freeze([
  `${STATE_ROOT}/resolver-overlay.json`,
  `${STATE_ROOT}/resolver-generations`,
  `${STATE_ROOT}/resolver-generations/resolver-generations.json`,
  `${STATE_ROOT}/resolver-generations/current`,
  `${STATE_ROOT}/resolver-generations/current/opencode.json`,
  `${STATE_ROOT}/provider-expansion.lock`,
  "/home/dev/.config/opencode/opencode.json",
  "/home/dev/devbox/config/opencode/opencode.json",
]);

const LEDGER_RECORDS = Object.freeze([
  "generationRegistryInitialized", "configCutover", "legacyMigration", "providerStages", "scheduledRuns",
]);
const STAGE_STATUSES = Object.freeze(["prepared", "committed", "gate-running", "healthy", "failed", "rolled-back"]);
const VERIFY_MODES = Object.freeze(["pre-bootstrap", "bootstrap-incomplete", "generated", "raw-emergency", "invalid"]);

const PACKAGE_4_TITLES = Object.freeze([
  "**Staged fleet cutover for model reconciliation.**",
  "**Per-provider staging behind a 24-hour health gate.**",
  "**Daily `scheduled-run`.**",
  "**Legacy watch ledger import.**",
  "**Exact Alibaba Token Plan roles.**",
  "**Reconciliation ledger schema 2.**",
  "**`reconcile.apply.providers` allowlist.**",
  "**`opencode-broker-watch` stands down after cutover.**",
]);
// Holden's entries that were already pending when Package 4 was written. They must stay in the
// same section; Package 4 appends, it never moves or rewrites them.
const PENDING_TITLES = Object.freeze([
  "**Session-bound gateway requests.**",
  "**Per-tier local share.**",
  "**`planUsage.keyFile`**",
  "**`forwardSessionHints` per gateway provider.**",
  "(#5)",
  "**llm-auth-proxy plan usage is read again.**",
]);

test("README documents every Package 4 command, and each one exists in the CLI", () => {
  for (const line of USAGE) assert.ok(README.includes(line), `README is missing: ${line}`);
  const subcommands = [...new Set(USAGE.map((line) => line.split(" ")[1]))];
  assert.equal(subcommands.length, 15);
  for (const name of subcommands) {
    const literal = new RegExp(`["'\`]${name}["'\`]|^\\s*${name}\\s*:`, "m");
    assert.match(`${RECONCILE_BIN}\n${PROVIDER_STAGE_LIB}`, literal,
      `neither bin/opencode-broker-reconcile nor lib/reconcile-provider-stage.js defines the "${name}" subcommand`);
  }
});

test("README states the job-run exit codes, the verifier contract, and the singleton writer", () => {
  assert.ok(README.includes("`0` ok, `5` quiet or skipped, `10` finding, `20` needs attention"));
  assert.ok(README.includes(
    "`ok`, `mode`, `expectedTarget`, `actualTarget`, `generation`, `registryHash`, `manifestHash`, `rawBaseHash`, `ledgerRevision`",
  ));
  for (const mode of VERIFY_MODES) assert.ok(README.includes(`\`${mode}\``), `README is missing mode ${mode}`);
  for (const text of ["provider-not-allowlisted", "clock-regressed", "flock -n -E 5", "#fleet-cutover-and-staged-provider-activation"]) {
    assert.ok(README.includes(text), `README is missing: ${text}`);
  }
  for (const stale of [
    "**It remains the live publisher.**",
    "Package 4 owns live activation",
    "happen in a later package",
    "review and dormant apply surface",
  ]) {
    assert.equal(README.includes(stale), false, `README still says: ${stale}`);
  }
});

test("STATE.md documents ledger schema 2, the five Package 4 records, and the deployed paths", () => {
  assert.equal(RECONCILIATION_STATE_VERSION, 2);
  assert.ok(STATE.includes(`Schema version \`${RECONCILIATION_STATE_VERSION}\`.`), "ledger schema version is stale");
  assert.ok(STATE.includes("## Package 4 cutover state"));
  for (const record of LEDGER_RECORDS) assert.ok(STATE.includes(`\`${record}\``), `STATE.md is missing ${record}`);
  for (const path of DEPLOYED_PATHS) assert.ok(STATE.includes(`\`${path}\``), `STATE.md is missing ${path}`);
  for (const status of STAGE_STATUSES) assert.ok(STATE.includes(`\`${status}\``), `STATE.md is missing ${status}`);
  for (const text of ["clock-regressed", "provider-not-allowlisted", "never deleted", "createReconciliationStore().update()"]) {
    assert.ok(STATE.includes(text), `STATE.md is missing: ${text}`);
  }
  for (const stale of [
    "belong to a later package",
    "Package 4 alone configures paths",
    "Schema 1, mode 0600 under a mode-0700 root",
  ]) {
    assert.equal(STATE.includes(stale), false, `STATE.md still says: ${stale}`);
  }
});

test("CHANGELOG keeps Package 4 and the already-pending entries in one unreleased section", () => {
  const sections = CHANGELOG.split(/^(?=## \[)/m).slice(1);
  const holding = sections.filter((section) => section.includes(PACKAGE_4_TITLES[0]));
  assert.equal(holding.length, 1, "exactly one changelog section holds the Package 4 entries");
  const [section] = holding;
  assert.match(section, /^## \[(Unreleased|1\.25\.0)\]/);
  for (const title of [...PACKAGE_4_TITLES, ...PENDING_TITLES]) {
    assert.ok(section.includes(title), `the Package 4 changelog section is missing ${title}`);
  }
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
node --test tests/docs-package-4.test.mjs
```

Expected: FAIL. Four tests run, and these assertion messages appear:
- The first test fails with `README is missing: opencode-broker-reconcile preflight-topology --json`.
- The second test fails on the exit-code phrase.
- The third test fails with `ledger schema version is stale`.
- The fourth test fails with `exactly one changelog section holds the Package 4 entries`.

None of the subcommand-literal assertions may fail. They search `bin/opencode-broker-reconcile` (B5-B7 subcommands) together with `lib/reconcile-provider-stage.js` (B8's `PROVIDER_COMMANDS` and `scheduled-run`). If one does fail, a B5-B8 subcommand is missing: stop and report BLOCKED.

- [ ] **Step 4: Update README.md**

4a. In the Configuration reference table, replace this row:

```markdown
| `reconcile.apply` | Dormant runtime controls: `enabled` defaults to `false`. Enabling requires absolute `overlayPath`, `generationsRoot`, and `currentLinkPath`; incomplete configuration stays off with a visible error. Package 4 owns live activation. |
```

with:

```markdown
| `reconcile.apply` | Model-promotion controls, off by default: `enabled` defaults to `false`. Enabling requires absolute `overlayPath`, `generationsRoot`, and `currentLinkPath`; incomplete paths keep it off with a visible error. `providers` is the staged allowlist: a duplicate-free array whose every value must be an exact `trustedSubscriptionProviders` member, required and nonempty when `enabled` is `true`, optional when it is `false`. A malformed, duplicate, or untrusted value -- including a provider later removed from `trustedSubscriptionProviders` -- is reported at load in `reconcile.apply.configError`, naming it, and forces apply off; routing keeps loading, and every reconciler writer refuses with an alert until it is fixed. See [fleet cutover](#fleet-cutover-and-staged-provider-activation). |
```

4b. Replace:

```markdown
human still has to judge. **It remains the live publisher.**

`opencode-broker-reconcile` is the review and dormant apply surface. Its ordinary observation and
projection commands do not alter routing, and every runtime command remains disabled by default:
```

with:

```markdown
human still has to judge. It is the live publisher until the Package 4 cutover: once the ledger's
`configCutover.mode` is `generated` it exits 5 without doing any work, and only `raw-emergency`
mode makes it the authorized writer again.

`opencode-broker-reconcile` is the review and apply surface. Its ordinary observation and
projection commands do not alter routing, and every runtime command stays disabled until
`reconcile.apply.enabled` is set (the Package 4 cutover commands are listed
[below](#fleet-cutover-and-staged-provider-activation)):
```

4c. Replace:

```markdown
- **`reviewed-models.json` is left intact.** The dry run reads the watch job's ledger and
  reports which of its keys a future import would cover; the import and the deletion of that
  file happen in a later package.
```

with:

```markdown
- **`reviewed-models.json` is left intact.** The dry run reads the watch job's ledger and
  reports which of its keys an import would cover. `import-legacy-ledger` performs that import
  during the Package 4 cutover, keeps a read-only archive copy, and leaves the file itself
  writable at its old path for rollback; no command deletes it.
```

4d. Replace:

```markdown
Package 3 includes the runtime needed for a controlled model transition, but does not activate it.
`reconcile.apply.enabled` is `false` by default, all live paths normalize to `null`, the existing
watch remains the live inventory publisher, and no schedule invokes apply. Package 4 alone performs
the generated-config cutover, enables live inventory and policy mutation, configures trusted
providers, changes schedules, and retires the old publisher.
```

with:

```markdown
Package 3 ships the runtime needed for a controlled model transition with every control off:
`reconcile.apply.enabled` is `false` by default and all live paths normalize to `null`. The only
activation path is the staged cutover in
[Fleet cutover and staged provider activation](#fleet-cutover-and-staged-provider-activation),
which enables mutation one allowlisted provider at a time.
```

4e. Insert the following immediately before the line `### Evidence, collected through the gateway`:

````markdown
### Fleet cutover and staged provider activation

Package 4 activates the runtime above in place, one stage at a time. There are three separate
responsibilities, and none of them infers or overrides another's state:
- The broker's `opencode-broker-reconcile` is the only transition writer.
- The fleet's `opencode-model-provider-stage` script orchestrates the stages and holds the
  provider-expansion lock.
- Fleet sync converges the outer config link only after the broker's read-only verifier says it may.

```sh
opencode-broker-reconcile preflight-topology --json
opencode-broker-reconcile bootstrap-generation-zero --json
opencode-broker-reconcile verify-deployed-config --json
opencode-broker-reconcile cutover-config --json
opencode-broker-reconcile rollback-config --raw-emergency --json
opencode-broker-reconcile rollback-config --provider <id> --json
opencode-broker-reconcile record-legacy-quiesced --json
opencode-broker-reconcile import-legacy-ledger --baseline --json
opencode-broker-reconcile import-legacy-ledger --final --json
opencode-broker-reconcile prepare --provider <id> --json
opencode-broker-reconcile commit --provider <id> --json
opencode-broker-reconcile canary --provider <id> --json
opencode-broker-reconcile gate-status --provider <id> --json
opencode-broker-reconcile gate-start --provider <id> --json
opencode-broker-reconcile gate-complete --provider <id> --json
opencode-broker-reconcile gate-reset --provider <id> --reason <text> --json
opencode-broker-reconcile scheduled-run --json
```

Each of these commands prints exactly one JSON object with `--json`. They follow the fleet job-run
contract rather than the exit codes above:
`0` ok, `5` quiet or skipped, `10` finding, `20` needs attention, and any other code a failure.

- **Topology comes first.** `preflight-topology` requires all of the following:
  - `/home/dev/fleet-core` resolves to `/home/dev/devbox`.
  - `~/.config/opencode/opencode.json` resolves through
    `/home/dev/fleet-core/config/opencode/opencode.json`.
  - The final file is the regular mode-0600 raw base `/home/dev/devbox/config/opencode/opencode.json`.

  When all hold, it records the raw base's SHA-256. It never creates or repairs the compatibility
  symlink.
- **Generation 0 is the raw base and nothing else.** `bootstrap-generation-zero` builds generation 0
  from the raw base alone (no overlay, no mutable policy) and verifies the pinned hash. It then
  initializes the renderer-only registry and writes the `generationRegistryInitialized`
  acknowledgement exactly once. Running it again against the same exact state validates and writes
  nothing. A partial, mismatched or regressed artifact set fails closed and is never initialized
  from empty. Bootstrap does not switch `resolver-generations/current`. Membership in generation 0's manifest
  confers no routing eligibility: raw resolver-only keys, including the unknown Alibaba siblings
  `qwen3.7-max`, `qwen3.7-plus` and `deepseek-v4-flash-0731`, stay unrouted.
- **Cutover is two swaps, and it is recoverable.** Under the reconciliation lock, `cutover-config` switches
  `resolver-generations/current` to generation 0. It then CAS-writes `configCutover` with mode `generated` and
  retargets `~/.config/opencode/opencode.json` to
  `/home/dev/.local/share/opencode/model-routing/resolver-generations/current/opencode.json`. Apply stays
  disabled for the whole window.
  - The two swaps are not jointly atomic. A process that starts between them loads the raw base and
    gets base-only eligibility; it never sees an overlay-only model.
  - If the broker or host restarts between the swaps, `verify-deployed-config` reports `invalid`.
    Running `cutover-config` again finishes the retarget from the persisted `configCutover`
    evidence. Any other mismatch blocks the command.
  - Existing TUIs keep the config they captured at startup. Nothing kills them.
- **The verifier is read-only.** `verify-deployed-config` prints exactly the keys `ok`, `mode`, `expectedTarget`, `actualTarget`, `generation`, `registryHash`, `manifestHash`, `rawBaseHash`, `ledgerRevision`.
  `mode` is one of `pre-bootstrap`, `bootstrap-incomplete`, `generated`, `raw-emergency` or
  `invalid`, and the command exits 0 only when `ok` is true. `bootstrap-incomplete` means the
  generation-0 acknowledgement exists but no `configCutover` does yet: a cutover stopped between
  bootstrap and the config switch, and re-running the stage script's `cutover` resumes it.
  Fleet sync relinks the outer config only from a verifier result that is `ok`. On
  `bootstrap-incomplete`, `invalid`, or any verifier failure, fleet sync changes no link and
  fails loudly.
- **Emergency rollback is for an unusable generation 0 only.** `rollback-config --raw-emergency`
  runs only when `configCutover` is `generated` and every recorded value still matches exactly:
  generation, `manifestHash`, `registryHash`, `rawBaseHash` and `sourceLedgerRevision`. It first
  CAS-writes mode `raw-emergency`, then retargets the outer link to the canonical
  `/home/dev/devbox/config/opencode/opencode.json`. Registry, generations and the initialization
  acknowledgement are kept for diagnosis. A stale record aborts the command with an alert.
- **The legacy ledger is imported, not deleted.**
  - `import-legacy-ledger --baseline` records the baseline key count B and its hash.
  - `record-legacy-quiesced` records that the old watch timer is disabled and its service has
    exited.
  - `import-legacy-ledger --final` imports the complete B + D key set. It requires exact key
    equality and zero duplicate transitions or notifications, then keeps a read-only archive copy.
  - `reviewed-models.json` stays writable at its old path so a rollback can resume the old watch.
  - The read-only copy lives under `$STATE_ROOT/legacy-ledger-archive/` and is removed by hand once,
    seven days after `legacyMigration.quiescedAt`.
- **Ledger schema 2 is a one-way upgrade.** A broker older than 1.25.0 cannot read the version-2
  reconciliation ledger and fails closed; downgrading requires restoring the pre-cutover ledger.
  The ledger carries an integer `revision` counter, and every `sourceLedgerRevision` /
  `ledgerRevision` field records the revision of the update that wrote it.
- **One provider at a time.** `reconcile.apply.providers` is the allowlist. Apply, refresh, recover
  and scheduled runs skip any other provider, and the skipped transition stays durable and visible
  with reason `provider-not-allowlisted`. Each command's job:
  - `prepare --provider <id>` persists the complete evidence record without switching live policy.
  - `commit --provider <id>` publishes it through the existing Package 3 saga while no scheduled
    writer is running. It records the generation, broker and ledger acknowledgements plus a
    pre-stage checkpoint.
  - `canary --provider <id>` runs the exact-model probes through the existing Package 3 probe path.
  - `rollback-config --provider <id>` restores that checkpoint and removes only the failed
    provider. Generation 0 and the old watch are reserved for global integrity failure.
  - Provider `alibaba-token-plan` admits exactly `qwen3.8-max`, `qwen3.6-flash`, `deepseek-v4-pro`
    and `glm-5.2`. No sibling, prefix or inferred tier is admitted.
- **Every provider must pass a 24-hour gate.** `gate-start` opens the gate and `gate-status` reports
  it. `gate-complete` succeeds only when both of these hold:
  - the injected wall clock is at least 24 hours past the gate's start;
  - at least one successful scheduled run started after the provider's commit.

  A clock earlier than the gate's start reports not-eligible with reason `clock-regressed`; it
  never completes. `gate-reset --reason <text>` records the reason and requires a new prepare and
  commit. Another provider's stage may not begin while any begun stage is neither `healthy` nor
  `rolled-back`.
- **There is a single scheduled writer.** `scheduled-run` is the command the fleet's daily reconcile
  timer runs.
  - It runs dry-run only while apply is disabled or `configCutover` is absent.
  - It exits 5 in `raw-emergency`.
  - It records each run in `scheduledRuns`, keeping the newest 50.
  - A corrupt or partial ledger or registry makes it exit nonzero (never 5) with alert-worthy JSON,
    mutate nothing, and preserve the corrupt bytes.

  The fleet wraps both the new reconcile unit and the old watch unit in `flock -n -E 5` on
  `provider-expansion.lock`, so a timer that fires while the stage script holds the lock exits 5
  without doing work. The broker never takes that lock itself.
````

4f. In the "Other pieces" table, replace the start of the watch row:

```markdown
| `bin/opencode-broker-watch` | Run daily: refreshes
```

with:

```markdown
| `bin/opencode-broker-watch` | The pre-cutover publisher, run daily until Package 4 retires its timer: refreshes
```

In the same row, replace its ending:

```markdown
discovery admits nothing and every tier stays on its configured targets. |
```

with:

```markdown
discovery admits nothing and every tier stays on its configured targets. While the ledger's `configCutover.mode` is `generated` it exits 5 with the reason on stderr and does no work; in `raw-emergency` mode it is the authorized writer again. |
```

Then replace the reconcile row:

```markdown
| `bin/opencode-broker-reconcile` | The reconciliation operator surface: `dry-run`, `status`, `evidence-status`, `project`, `approve`, `reject`, `amend`. Refreshes isolated catalog and resolver views, records provider-role candidate observations in `model-reconciliation.json`, presents open proposals as Gitea issues and announces each transition -- without publishing inventory, probing, or altering routing. |
```

with:

```markdown
| `bin/opencode-broker-reconcile` | The reconciliation operator surface and the only transition writer. The review commands (`dry-run`, `status`, `evidence-status`, `project`, `approve`, `reject`, `amend`) refresh isolated views, record observations in `model-reconciliation.json` and project proposals without altering routing. The apply commands and the Package 4 cutover, staging, gate and `scheduled-run` commands are described under [fleet cutover](#fleet-cutover-and-staged-provider-activation). |
```

- [ ] **Step 5: Update docs/STATE.md**

5a. Replace the `reviewed-models.json` inventory row:

```markdown
| `reviewed-models.json` | opencode-broker-watch | opencode-broker-watch | Catalog model ids already seen/assessed, so each new model notifies exactly once. `opencode-broker-reconcile` READS it and reports which keys a future import would cover; the import itself, and the deletion of this file, belong to a later package |
```

with:

```markdown
| `reviewed-models.json` | opencode-broker-watch, only while `configCutover` is absent or `raw-emergency` | opencode-broker-watch, `opencode-broker-reconcile` | Catalog model ids already seen/assessed, so each new model notifies exactly once. `opencode-broker-reconcile import-legacy-ledger` imports its keys into the ledger and keeps a read-only archive copy; this file stays writable at this path for rollback and no command deletes it. Removing it is a one-time manual step, seven days after `legacyMigration.quiescedAt` |
```

5b. In the `model-reconciliation.json` ownership row, replace `Schema 1, mode 0600 under a mode-0700 root` with:

```markdown
Schema 2 (an exact version-1 file is migrated explicitly), mode 0600 under a mode-0700 root
```

5c. Replace:

```markdown
All Package 3 mutation machinery is dormant by default. `reconcile.apply.enabled`
normalizes to `false`, live paths normalize to `null`, and no live publication or
schedule uses these writers. Package 4 alone configures paths, performs cutover,
enables publication/policy mutation, and changes scheduling.
```

with:

```markdown
The Package 3 mutation machinery stays off by default in the product: `reconcile.apply.enabled`
normalizes to `false` and live paths normalize to `null`. Publication and policy mutation are
enabled only by a deployed configuration with the Package 4 paths and a nonempty
`reconcile.apply.providers` allowlist, and only for the allowlisted providers; see
[Package 4 cutover state](#package-4-cutover-state).
```

5d. Replace:

```markdown
Schema version `1`. The top-level keys are exactly `version`, `updatedAt`, `roles`,
`unknown` and `evidenceRequests`; an unknown key or a different version is a
newer writer's file and is refused rather than round-tripped.
```

with:

```markdown
Schema version `2`. The top-level keys are `version`, `updatedAt`, `roles`, `unknown`
and `evidenceRequests`, plus the five Package 4 records `generationRegistryInitialized`,
`configCutover`, `legacyMigration`, `providerStages` and `scheduledRuns` described under
[Package 4 cutover state](#package-4-cutover-state). An unknown key or a different version
is a newer writer's file and is refused rather than round-tripped. A version-1 file is
migrated to version 2 explicitly and strictly: a version-1 file carrying any key outside
the version-1 set fails closed, its bytes preserved, and is never upgraded around.
```

5e. Insert immediately before the line `## The reconciliation ledger lock`:

```markdown
## Package 4 cutover state

Package 4 deploys the Package 3 stores at fixed paths and records the cutover itself in
five ledger keys. Runtime directories are mode 0700 and runtime files mode 0600. Only
`opencode-broker-reconcile` writes the records below, and only through
`createReconciliationStore().update()`. The fleet's `opencode-model-provider-stage` script
and devbox-sync read them only through `verify-deployed-config` and the `gate-*` commands,
and never write them.

| Path | Writer | Readers | Content |
|---|---|---|---|
| `/home/dev/.local/share/opencode/model-routing/resolver-overlay.json` | reconciliation applier | generation renderer, `opencode-broker-reconcile` | The deployed `reconcile.apply.overlayPath`; schema above |
| `/home/dev/.local/share/opencode/model-routing/resolver-generations` | generation renderer | OpenCode resolver processes, broker, `opencode-broker-reconcile` | The deployed `reconcile.apply.generationsRoot`: the immutable `generation-N` bundles. Generation 0 holds only the raw base and is the global rollback target |
| `/home/dev/.local/share/opencode/model-routing/resolver-generations/resolver-generations.json` | generation renderer only | broker, router plugin, `verify-deployed-config` | The registry. No policy mutator writes it, and rollback never lowers its high-water mark. After initialization, a missing, corrupt, non-monotonic or manifest-hash-regressed registry blocks publication, recovery and mutation, and is never recreated from empty |
| `/home/dev/.local/share/opencode/model-routing/resolver-generations/current` | generation renderer, under `cutover-config`, `commit --provider` and `rollback-config --provider` | OpenCode startup, router plugin, `verify-deployed-config` | The deployed `reconcile.apply.currentLinkPath`, switched atomically and only to a validated generation. `bootstrap-generation-zero` never switches it |
| `/home/dev/.config/opencode/opencode.json` | `cutover-config`, `rollback-config --raw-emergency`; devbox-sync preserves or recreates it only after `verify-deployed-config` reports `ok` | every OpenCode process at startup | The outer config link. Pre-bootstrap, it is the raw chain through `/home/dev/fleet-core/config/opencode/opencode.json`. In `generated` mode it targets exactly `/home/dev/.local/share/opencode/model-routing/resolver-generations/current/opencode.json`. In `raw-emergency` mode it targets exactly `/home/dev/devbox/config/opencode/opencode.json` |
| `/home/dev/.local/share/opencode/model-routing/provider-expansion.lock` | none. The kernel lock is held by the fleet's `opencode-model-provider-stage` (`flock -w 5` on fd 9 for its whole run) and attempted by both timer units (`flock -n -E 5`) | kernel | An empty mode-0600 file. The kernel lock is what determines ownership, not the file's mtime. The file is never deleted. No broker command takes the lock; commands the stage script runs inherit its held descriptor |
| archive copy of `reviewed-models.json` (path in `legacyMigration.archivePath`) | `import-legacy-ledger --final` | operator | A read-only copy whose SHA-256 is `legacyMigration.archiveHash`. It is removed by hand, once, seven days after `legacyMigration.quiescedAt`, never by a pipeline |

### `generationRegistryInitialized`

Written exactly once, by `bootstrap-generation-zero`. Its fields:
`schemaVersion` (1), `generation` (0), `registryHash`, `manifestHash`, `rawBaseHash`,
`sourceLedgerRevision` and `initializedAt` (UTC ISO-8601). Each hash is the lowercase 64-hex
SHA-256 of an exact byte sequence: the registry, the generation-0 `manifest.json`, and the
canonical raw base respectively. `sourceLedgerRevision` comes from the enclosing ledger
mutation's acknowledgement.

A later bootstrap whose values all match exactly validates and writes nothing. Any mismatch,
deletion, downgrade or stale CAS fails closed, and the record is never overwritten. Bootstrap
succeeds only from an entirely absent artifact set. Stale registry temp files are swept only
after the final registry and this record validate exactly; otherwise every temp and final file
is preserved for diagnosis.

### `configCutover`

The audited control record for the outer config link. Its fields: `schemaVersion` (1), `mode`,
`target`, `generation`, `manifestHash`, `registryHash`, `rawBaseHash`, `sourceLedgerRevision`,
`changedAt`, and `reason`. `reason` is one of `bootstrap`, `provider-stage`,
`emergency-rollback` or `reactivation`. Only two states are valid:

- `generated`: `target` is exactly
  `/home/dev/.local/share/opencode/model-routing/resolver-generations/current/opencode.json`, `generation` is
  a non-negative integer, `manifestHash` is non-null, and both ledger records are readable and
  match.
- `raw-emergency`: `target` is exactly `/home/dev/devbox/config/opencode/opencode.json`,
  `generation` and `manifestHash` are `null`, the initialization record is readable and matches,
  and the registry and raw-base hashes are retained.

Validation compares `target` as a string before any canonicalization, then resolves it and
checks hashes. Every other combination is `invalid`. An `invalid` record blocks mutation and
recovery and leaves the outer link unchanged. One intermediate state is recoverable:
`resolver-generations/current` already names the exact validated generation 0, but the outer link still
resolves through the pre-cutover chain. Re-running `cutover-config` completes the retarget
under the reconciliation lock, and `verify-deployed-config` reports `invalid` until it does.
No mode or target is ever inferred from filesystem presence.

### `legacyMigration`

The record has these fields: `schemaVersion` (1), `baselineCount`, `baselineHash`, `finalCount`,
`finalHash`, `sourceLedgerRevision`, `quiescedAt`, `archivePath` and `archiveHash`.
- `--baseline` records the baseline count and hash. It reads them from the deployment, never
  from a constant.
- `record-legacy-quiesced` sets `quiescedAt` only after the old timer is disabled and its service
  has exited.
- `--final` imports the complete baseline-plus-delta key set. It requires exact key equality and
  zero duplicate projections, then records the final count, hash, revision and archive.

### `providerStages`

The record is keyed by provider ID. Each entry has `schemaVersion` (1), a `status`, and four blocks.

`status` is one of `prepared`, `committed`, `gate-running`, `healthy`, `failed` or `rolled-back`.

The four blocks:
- `prepared`: the allowlist, ledger revision, overlay, effective and base hashes, manifest hash,
  and policy-intent hash. `prepare` writes it without switching live policy.
- `committed`: the generation, manifest hash and the generation, broker and ledger
  acknowledgements.
- `checkpoint`: the pre-stage generation, manifest hash, allowlist, ledger revision and broker
  policy revision that `rollback-config --provider` restores.
- `gate`: `startedAt`, `completedAt`, `scheduledRunIDs`, `evidence` and `resetCount`.

`gate-complete` requires two things:
- the injected wall clock is at least `gate.startedAt` + 24 hours;
- at least one `scheduledRuns` entry with `ok` true whose `startedAt` is later than
  `committed.at`.

A clock earlier than `gate.startedAt` yields not-eligible with reason `clock-regressed`; it never
completes. A reset increments `resetCount` and requires a new prepare and commit.

A provider absent from `reconcile.apply.providers` gets no stage. Its transitions stay durable
and visible with reason `provider-not-allowlisted`.

### `scheduledRuns`

This is a bounded list holding the newest 50 runs. Each entry is
`{ id, startedAt, endedAt, ok, mode, providers, ledgerRevision, exitCode }`, where `mode` is
`dry-run` or `apply`.

`scheduled-run` behaves as follows:
- It runs dry-run only while apply is disabled or `configCutover` is absent, and then mutates no
  prohibited path.
- It exits 5 in `raw-emergency`.
- A corrupt or partial ledger or registry makes it exit nonzero (never 5) with alert-worthy JSON.
  It mutates nothing and preserves the corrupt bytes.

`opencode-broker-watch` exits 5 with its reason on stderr while `configCutover.mode` is
`generated`.
```

- [ ] **Step 6: Append the CHANGELOG entries under the existing `[Unreleased]`**

Replace:

```markdown
  A session id is a fleet-internal identity and must never reach a third-party upstream.

### Fixed
```

with:

```markdown
  A session id is a fleet-internal identity and must never reach a third-party upstream.
- **Staged fleet cutover for model reconciliation.** `opencode-broker-reconcile` gains
  `preflight-topology`, `bootstrap-generation-zero`, `verify-deployed-config`, `cutover-config`
  and `rollback-config --raw-emergency`. Generation 0 is built only from the version-controlled raw
  base with a pinned SHA-256. It is recorded once as `generationRegistryInitialized` and never
  initialized from partial state. Cutover switches `resolver-generations/current` to generation 0, records
  `configCutover`, and retargets `~/.config/opencode/opencode.json` to `resolver-generations/current/opencode.json`.
  If a restart lands between the two swaps, re-running `cutover-config` completes the retarget;
  until then `verify-deployed-config` reports `invalid`. Fleet sync consults that read-only
  verifier before touching the link. Every command prints one JSON object and uses the job-run
  exit codes.
- **Per-provider staging behind a 24-hour health gate.** `prepare`, `commit` and
  `canary --provider <id>` take one allowlisted provider through the existing Package 3 saga and
  probe path; there is no second apply authority. `rollback-config --provider <id>` restores the
  pre-stage checkpoint and removes only that provider. `gate-start`, `gate-status`,
  `gate-complete` and `gate-reset` persist the gate. Completion needs 24 wall-clock hours and a
  successful scheduled run that started after the commit. A clock earlier than the gate's start
  reports `clock-regressed` instead of completing.
- **Daily `scheduled-run`.** The command behind the fleet's new reconcile timer. It runs dry-run
  only while apply is disabled or before cutover, exits 5 in `raw-emergency`, and keeps the
  newest 50 runs in `scheduledRuns`. On a corrupt or partial ledger or registry it exits nonzero
  (never 5), mutates nothing, and preserves the corrupt bytes.
- **Legacy watch ledger import.** `import-legacy-ledger --baseline` / `--final` and
  `record-legacy-quiesced` import `reviewed-models.json` with exact key equality and zero
  duplicate projections. A read-only archive copy is kept, and the writable legacy ledger stays at
  its old path for rollback.
- **Exact Alibaba Token Plan roles.** `alibaba-token-plan` admits exactly `qwen3.8-max` (deep),
  `qwen3.6-flash` (worker), and `deepseek-v4-pro` and `glm-5.2` (build, review), with official
  evidence only from `help.aliyun.com` or `www.alibabacloud.com`. Unknown siblings such as
  `qwen3.7-max` stay unknown. Appearing in generation 0's manifest makes no model routable.

### Fixed
```

Then add the Changed entries at the end of the EXISTING `### Changed` section of `[Unreleased]` (do not add a second `### Changed` heading). Replace:

```markdown
  itself, so older readers of the log keep parsing it unchanged.

### Removed
```

with:

```markdown
  itself, so older readers of the log keep parsing it unchanged.
- **Reconciliation ledger schema 2.** A version-1 `model-reconciliation.json` is migrated
  explicitly and strictly. A version-1 file with any unexpected key fails closed and keeps its
  bytes. The ledger gains an integer `revision` counter. A broker older than 1.25.0 cannot read
  the version-2 reconciliation ledger and fails closed; downgrading requires restoring the
  pre-cutover ledger.
- **`reconcile.apply.providers` allowlist.** Validated at startup: the array must be
  duplicate-free, every value must be an exact `trustedSubscriptionProviders` member, and it must
  be nonempty when apply is enabled. A provider that is malformed, duplicated or untrusted
  (including one later removed from the trusted list) is reported at load in
  `reconcile.apply.configError`, naming it, and forces apply off; routing keeps loading. Every
  reconciler writer then refuses with an alert, and an applier constructed with such a provider
  refuses to run. Apply, refresh, recover and scheduled runs skip any other provider, and the
  skipped transition stays visible with reason `provider-not-allowlisted`.
- **`opencode-broker-watch` stands down after cutover.** It exits 5 with its reason on stderr
  while `configCutover.mode` is `generated`, and is the authorized writer again in
  `raw-emergency`.

### Removed
```

- [ ] **Step 7: Run the documentation test until it passes, then run the release-shape checks**

```bash
node --test tests/docs-package-4.test.mjs
node -e 'const c=require("fs").readFileSync("CHANGELOG.md","utf8"); const h=[...c.matchAll(/^## \[([^\]]+)\]/gm)].map((m)=>m[1]); if (h[0]!=="Unreleased"||h[1]!=="1.24.0"||c.split("## [Unreleased]").length!==2) { console.error(h.slice(0,3)); process.exit(1); }'
node -e 'if (require("./package.json").version!=="1.24.0") process.exit(1)'
test ! -e package-lock.json
git --no-pager diff --exit-code -- docs/API.md
```

Expected:
- The test file passes all 4 tests.
- The changelog check exits 0: the first heading is still `Unreleased`, the next is `1.24.0`, and there is no new version heading.
- `package.json` is still `1.24.0`.
- No lockfile exists.
- `docs/API.md` has no diff.

- [ ] **Step 8: Run the full suite**

```bash
npm test
```

Expected: exit 0 with zero failures. Do not assert a fixed test count.

- [ ] **Step 9: Commit**

```bash
git add tests/docs-package-4.test.mjs README.md docs/STATE.md CHANGELOG.md
git --no-pager diff --cached --name-only
git commit -m "docs: document the Package 4 fleet cutover and staged provider activation"
```

Expected: the cached name list is exactly these four paths: `CHANGELOG.md`, `README.md`, `docs/STATE.md` and `tests/docs-package-4.test.mjs`. Do not stage anything under `docs/superpowers/`. No push, no deploy.

## Fleet tasks

Every fleet task runs in `/home/dev/devbox`, on branch `main`. That checkout is also the live deployment. `devbox-sync.service` runs `%h/devbox/bin/devbox-sync --timers` from this working tree, so once a fleet commit lands, the next timer-driven sync installs its units and runs its code. Do not push, restart a service or run `devbox-sync` by hand inside these tasks. Each task has a precondition step for this, because the live timer will still pick the change up:

- F1 must not land before broker tasks B1, B5, B7 and B8 are committed in `/home/dev/opencode-broker`.
- F2 must not land before broker task B6 is committed there.

Stage only the explicit `git add` paths listed. Never stage `docs/superpowers/plans/2026-09-22-routing-live-app-cutover.md`, `docs/superpowers/plans/2026-09-22-routing-retirement.md`, `docs/superpowers/plans/2026-09-29-tandoor-router-cutover.md` or `docs/superpowers/specs/2026-09-29-tandoor-router-cutover-design.md`.

### Task F1: Reconcile config block, daily reconcile unit and timer, expansion-lock wrapper on both scheduled units

**Files:**
- Modify: `config/opencode-broker/config.json:618-622` (insert the `reconcile` block immediately before `"watch"`)
- Create: `systemd/opencode-model-reconcile.service`
- Create: `systemd/opencode-model-reconcile.timer`
- Modify: `systemd/opencode-model-watch.service:8`
- Modify: `tests/fleet-config.test.mjs:8-9` (imports) and append tests at end of file
- Test: `tests/fleet-config.test.mjs`

**Interfaces:**
- Consumes (B1, broker `lib/config.js`): the config validates `reconcile.apply.providers` at startup. The array must be duplicate-free, and every entry must be an exact member of `trustedSubscriptionProviders`. When `enabled=false` the array may be absent, empty or valid. `reconcile.notifyCommand` is optional and falls back to `watch.notifyCommand`.
- Consumes (B8): `node /home/dev/opencode-broker/bin/opencode-broker-reconcile scheduled-run --json`. It exits 0 when OK, 5 when quiet or skipped (including when `configCutover.mode === "raw-emergency"`), 10 on a finding, 20 when it needs attention, and any other code on failure. When apply is disabled or `configCutover` is absent, it runs dry-run only.
- Consumes (B7): `node /home/dev/opencode-broker/bin/opencode-broker-watch` exits 5 with a stderr reason when `configCutover.mode === "generated"`.
- Produces (for F4 and the runbook):
  - Unit names `opencode-model-reconcile.service` and `opencode-model-reconcile.timer`, with `[X-Job] Name=opencode-model-reconcile`.
  - `opencode-model-watch.timer` is unchanged.
  - Both scheduled services run their command as `flock -n -E 5 %h/.local/share/opencode/model-routing/provider-expansion.lock ...`. While any other open file description holds that lock (for example the stage script's `exec 9>"$LOCK"; flock -w 5 9`), a timer firing exits 5 and job-run counts that as success with no push.
  - Fleet config key `reconcile.apply = { enabled: false, providers: ["openai"], overlayPath, generationsRoot, currentLinkPath }`, with no `reconcile.notifyCommand`.

- [ ] **Step 0: Preconditions (stop the task if any check fails)**

Run (in `/home/dev/devbox`):

```bash
git --no-pager status --short -- config/opencode-broker/config.json systemd/opencode-model-reconcile.service systemd/opencode-model-reconcile.timer systemd/opencode-model-watch.service tests/fleet-config.test.mjs
grep -c "scheduled-run" /home/dev/opencode-broker/bin/opencode-broker-reconcile
node -e 'import("/home/dev/opencode-broker/lib/reconcile-cutover.js").then((m) => { if (typeof m.createCutoverController !== "function") process.exit(1); })'
grep -c "configCutover" /home/dev/opencode-broker/bin/opencode-broker-watch
command -v flock && test -x /usr/bin/node && echo tools-ok
node --test tests/fleet-config.test.mjs 2>&1 | grep -E "^# (pass|fail)"
```

Expected:
- The status output is empty.
- Both `grep -c` counts are at least 1.
- The `node -e` call exits 0.
- `flock` resolves, and the line `tools-ok` prints.
- Record the baseline `# pass` / `# fail` counts.

Why each check matters:
- A dirty listed path means: stop and integrate from a clean HEAD.
- A missing `scheduled-run`, controller export or watch guard means B5, B7 or B8 has not landed. The next devbox-sync would then install a unit that calls a missing command, so stop.
- A missing `flock` or `/usr/bin/node` is a missing requirement. Stop; do not fall back.

- [ ] **Step 1: Write the failing tests**

Replace lines 8-9 of `tests/fleet-config.test.mjs`:

```js
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
```

with:

```js
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
```

Append to the end of `tests/fleet-config.test.mjs`:

```js
// ---------------------------------------------------------------------------------------------
// Package 4: the scheduled model reconciler and the provider-expansion lock.
//
// devbox-sync re-enables every timer under ~/devbox/systemd on every run, so `systemctl disable`
// is not a durable way to keep a scheduled writer out of a cutover or a provider stage. The
// durable guard is the kernel lock: both scheduled units run their command under
// `flock -n -E 5 <lock>`, and opencode-model-provider-stage holds that lock on fd 9 for its whole
// run, so a timer that fires mid-stage exits 5 ("ran, nothing to report") and touches nothing.
// ---------------------------------------------------------------------------------------------

const EXPANSION_LOCK = "%h/.local/share/opencode/model-routing/provider-expansion.lock";
const UNIT_PATH = "PATH=%h/devbox/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin";

// A systemd unit as { Section: { Key: [value, ...] } }; a repeated key keeps every value, so an
// accidental second ExecStart= shows up as a two-element array instead of being overwritten.
function readUnit(name) {
  const text = readFileSync(new URL(`../systemd/${name}`, import.meta.url), "utf8");
  const unit = {};
  let section = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1];
      unit[section] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    assert.ok(section !== null && eq > 0, `${name}: unparseable line ${JSON.stringify(raw)}`);
    (unit[section][line.slice(0, eq)] ??= []).push(line.slice(eq + 1));
  }
  return unit;
}

// The unit's command after job-run's `--`, and its PATH, with %h pointed at a throwaway home.
function unitCommand(name, home) {
  const unit = readUnit(name);
  const exec = unit.Service.ExecStart[0];
  const at = exec.indexOf(" -- ");
  assert.ok(at > 0, `${name}: ExecStart has no job-run -- separator`);
  const argv = exec.slice(at + 4).split(/\s+/).map((word) => word.replaceAll("%h", home));
  const path = unit.Service.Environment.find((entry) => entry.startsWith("PATH="))
    .slice("PATH=".length).replaceAll("%h", home);
  return { argv, path };
}

test("model-reconcile deploy: the reconcile service runs scheduled-run through job-run under the expansion lock", () => {
  const unit = readUnit("opencode-model-reconcile.service");
  assert.deepEqual(unit.Service.Type, ["oneshot"]);
  assert.deepEqual(unit.Service.Environment, [UNIT_PATH]);
  // 0077: if this unit is the first opener, flock creates the lock file 0600 like every other
  // model-routing runtime file; scheduled-run's own state files are 0600 by contract anyway.
  assert.deepEqual(unit.Service.UMask, ["0077"]);
  assert.deepEqual(unit.Service.ExecStart, [
    `%h/devbox/bin/job-run opencode-model-reconcile --no-notify -- flock -n -E 5 ${EXPANSION_LOCK} /usr/bin/node %h/opencode-broker/bin/opencode-broker-reconcile scheduled-run --json`,
  ]);
  assert.deepEqual(unit.Service.NoNewPrivileges, ["true"]);
});

test("model-reconcile deploy: the reconcile timer is daily, persistent, jittered at most 1h, and a code job", () => {
  const unit = readUnit("opencode-model-reconcile.timer");
  assert.deepEqual(unit.Timer, {
    OnCalendar: ["daily"],
    RandomizedDelaySec: ["1h"],
    Persistent: ["true"],
    Unit: ["opencode-model-reconcile.service"],
  });
  // Exactly these keys: in particular no Replaces=opencode-model-watch.timer, which would make
  // devbox-sync disable the old watch on the next sync, before the runbook's dry-run cycle and
  // final legacy-ledger import.
  assert.deepEqual(unit["X-Job"], { Name: ["opencode-model-reconcile"], Host: ["code"], MaxAge: ["48h"] });
  assert.deepEqual(unit.Install, { WantedBy: ["timers.target"] });
});

test("model-reconcile deploy: the old watch takes the same expansion lock before running", () => {
  const unit = readUnit("opencode-model-watch.service");
  assert.deepEqual(unit.Service.Environment, [UNIT_PATH]);
  assert.deepEqual(unit.Service.ExecStart, [
    `%h/devbox/bin/job-run opencode-model-watch --no-notify -- flock -n -E 5 ${EXPANSION_LOCK} /usr/bin/node %h/opencode-broker/bin/opencode-broker-watch`,
  ]);
});

test("model-reconcile deploy: a held expansion lock makes both scheduled units exit 5 without running", () => {
  const home = mkdtempSync(join(tmpdir(), "model-reconcile-lock-"));
  try {
    const lockDir = join(home, ".local/share/opencode/model-routing");
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const lock = join(lockDir, "provider-expansion.lock");
    for (const name of ["opencode-model-reconcile.service", "opencode-model-watch.service"]) {
      const { argv, path } = unitCommand(name, home);
      assert.deepEqual(argv.slice(0, 5), ["flock", "-n", "-E", "5", lock],
        `${name} must take the expansion lock before anything else`);
      // Held: fd 9 is its own open file description, exactly like the stage script's
      // `exec 9>"$LOCK"; flock -w 5 9`, so the unit's flock conflicts with it and exits 5.
      const held = spawnSync("bash",
        ["-c", 'exec 9>"$1"; flock -n 9 || exit 99; shift; exec "$@"', "hold-lock", lock, ...argv],
        { env: { PATH: path }, encoding: "utf8" });
      assert.equal(held.status, 5, `${name} under a held lock exited ${held.status}: ${held.stderr}`);
      // Free: flock runs node, which cannot find the broker script under the throwaway home --
      // proof that the lock passes straight through to the real command when nobody holds it.
      const free = spawnSync(argv[0], argv.slice(1), { env: { PATH: path }, encoding: "utf8" });
      assert.equal(free.status, 1, `${name} with a free lock exited ${free.status}: ${free.stderr}`);
      assert.match(free.stderr, /Cannot find module/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("model-reconcile deploy: fleet config ships reconcile apply disabled with one trusted provider", () => {
  assert.deepEqual(router.reconcile, {
    apply: {
      enabled: false,
      providers: ["openai"],
      overlayPath: "/home/dev/.local/share/opencode/model-routing/resolver-overlay.json",
      generationsRoot: "/home/dev/.local/share/opencode/model-routing/resolver-generations",
      currentLinkPath: "/home/dev/.local/share/opencode/model-routing/resolver-generations/current",
    },
  });
  const providers = router.reconcile.apply.providers;
  assert.equal(new Set(providers).size, providers.length, "providers must be duplicate-free");
  for (const providerID of providers) {
    assert.ok(router.trustedSubscriptionProviders.includes(providerID),
      `${providerID} is allowlisted for apply but is not in trustedSubscriptionProviders`);
  }
});

test("model-reconcile deploy: reconcile notifications fall back to watch.notifyCommand, which stays", () => {
  // The broker falls back to watch.notifyCommand when reconcile.notifyCommand is absent, and
  // burn-watch and slot-watch keep their own fallback on it: retiring model-watch must not take
  // the key with it.
  assert.equal(Object.hasOwn(router.reconcile, "notifyCommand"), false);
  assert.deepEqual(router.watch.notifyCommand, ["/home/dev/fleet-core/bin/fleet-notify"]);
});

test("model-reconcile deploy: the reconcile units ship from the single devbox unit source", () => {
  const units = readFileSync(new URL("../units.toml", import.meta.url), "utf8");
  const paths = [...units.matchAll(/^\s*path\s*=\s*"([^"]+)"\s*$/gm)].map((match) => match[1]);
  assert.equal(paths.filter((path) => path === "~/devbox").length, 1, "devbox must be registered exactly once");
  assert.equal(paths.some((path) => path.includes("opencode-broker")), false,
    "the broker checkout must not become a second unit source");
  for (const unit of ["opencode-model-reconcile.service", "opencode-model-reconcile.timer"]) {
    assert.ok(existsSync(new URL(`../systemd/${unit}`, import.meta.url).pathname), `${unit} is missing from devbox/systemd`);
    assert.equal(existsSync(join(homedir(), "opencode-broker/systemd", unit)), false,
      `${unit} is duplicated in the broker checkout`);
  }
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run (in `/home/dev/devbox`):

```bash
node --test --test-name-pattern="model-reconcile deploy" tests/fleet-config.test.mjs
```

Expected: FAIL. The reconcile-unit tests throw `ENOENT: no such file or directory ... systemd/opencode-model-reconcile.service` (and `.timer`). The watch test fails its `deepEqual` because ExecStart has no `flock`. The lock test fails on the missing reconcile unit. Both config tests fail with `router.reconcile` undefined.

- [ ] **Step 3: Add the reconcile block to the fleet config**

In `config/opencode-broker/config.json`, replace:

```json
  "watch": {
    "notifyCommand": [
      "/home/dev/fleet-core/bin/fleet-notify"
    ]
  },
```

with:

```json
  "reconcile": {
    "apply": {
      "enabled": false,
      "providers": [
        "openai"
      ],
      "overlayPath": "/home/dev/.local/share/opencode/model-routing/resolver-overlay.json",
      "generationsRoot": "/home/dev/.local/share/opencode/model-routing/resolver-generations",
      "currentLinkPath": "/home/dev/.local/share/opencode/model-routing/resolver-generations/current"
    }
  },
  "watch": {
    "notifyCommand": [
      "/home/dev/fleet-core/bin/fleet-notify"
    ]
  },
```

`reconcile.notifyCommand` is intentionally absent. The broker falls back to `watch.notifyCommand`, which stays.

- [ ] **Step 4: Create the reconcile service**

Create `systemd/opencode-model-reconcile.service`:

```ini
[Unit]
Description=opencode-broker: daily model reconciliation (dry-run until apply is enabled and cut over)

[Service]
Type=oneshot
# --no-notify: the reconciler pushes its own findings through reconcile.notifyCommand, which
# falls back to watch.notifyCommand. job-run still writes the log and the heartbeat, so a failed
# run (exit other than 0/5/10/20, e.g. a corrupt ledger) trips "last run failed".
#
# flock -n -E 5: opencode-model-provider-stage holds this lock on fd 9 for its whole run. A timer
# firing meanwhile exits 5 -- ran, nothing to report -- without reading or writing state. Do not
# delete the lock file: the kernel owns the lock, a leftover inode is harmless.
# devbox-sync re-enables this timer on every run, so the lock, not `systemctl disable`, is what
# keeps it out of a cutover or provider stage.
#
# UMask=0077: if this unit is the first to open the lock, flock creates it 0600.
UMask=0077
Environment=PATH=%h/devbox/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/devbox/bin/job-run opencode-model-reconcile --no-notify -- flock -n -E 5 %h/.local/share/opencode/model-routing/provider-expansion.lock /usr/bin/node %h/opencode-broker/bin/opencode-broker-reconcile scheduled-run --json
NoNewPrivileges=true
```

- [ ] **Step 5: Create the reconcile timer**

Create `systemd/opencode-model-reconcile.timer`:

```ini
[Unit]
Description=opencode-broker: daily model reconciliation

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
Unit=opencode-model-reconcile.service

# No Replaces=opencode-model-watch.timer: devbox-sync would disable the old watch on the very next
# sync, before the dry-run cycle and the final legacy-ledger import the runbook still needs it for.
# Until cutover, scheduled-run is dry-run only, which the design allows beside the old watch.
[X-Job]
Name=opencode-model-reconcile
Host=code
MaxAge=48h

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: Wrap the old watch in the same lock**

Replace the whole of `systemd/opencode-model-watch.service` with:

```ini
[Unit]
Description=opencode-broker: refresh model catalog, republish inventory, notify about new models

[Service]
Type=oneshot
# --no-notify: the watch pushes its own findings (new models); job-run adds the log and heartbeat.
# flock -n -E 5: the same provider-expansion lock as opencode-model-reconcile.service. While
# opencode-model-provider-stage holds it, this run exits 5 and does nothing. Once configCutover is
# "generated" the watch binary also exits 5 on its own; in "raw-emergency" it is the authorized
# writer again.
Environment=PATH=%h/devbox/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/devbox/bin/job-run opencode-model-watch --no-notify -- flock -n -E 5 %h/.local/share/opencode/model-routing/provider-expansion.lock /usr/bin/node %h/opencode-broker/bin/opencode-broker-watch
NoNewPrivileges=true
```

On this live unit, only ExecStart and its comment change. No `UMask=` is added, because the watch's other outputs are out of this task's scope.

- [ ] **Step 7: Run the new tests and confirm they pass**

Run (in `/home/dev/devbox`):

```bash
node --test --test-name-pattern="model-reconcile deploy" tests/fleet-config.test.mjs
```

Expected: PASS, 7 tests, 0 failures.

- [ ] **Step 8: Run the whole file and validate the units**

Run (in `/home/dev/devbox`):

```bash
node --test tests/fleet-config.test.mjs 2>&1 | grep -E "^# (pass|fail)"
node -e 'JSON.parse(require("fs").readFileSync("config/opencode-broker/config.json","utf8"))' && echo json-ok
systemd-analyze --user verify systemd/opencode-model-reconcile.service systemd/opencode-model-reconcile.timer systemd/opencode-model-watch.service
```

Expected:
- `# pass` equals the Step 0 baseline plus 7.
- `# fail` equals the Step 0 baseline (0 unless a failure was already recorded there).
- `json-ok` prints.
- `systemd-analyze` reports no error for any of the three units. It may only warn that `%h/devbox/bin/job-run` is not executable from the repo-relative path; any other diagnostic is a failure to fix.

- [ ] **Step 9: Commit**

```bash
git add config/opencode-broker/config.json systemd/opencode-model-reconcile.service systemd/opencode-model-reconcile.timer systemd/opencode-model-watch.service tests/fleet-config.test.mjs
git commit -m "feat(systemd): add the daily model reconciler and gate both model timers on the expansion lock"
```

### Task F2: devbox-sync converges opencode.json only from the verified configCutover mode

**Files:**
- Create: `bin/_opencode_config.sh` (sourced helper holding `converge_opencode_config`)
- Modify: `bin/devbox-sync:22` (source the helper), `bin/devbox-sync:44` (declare `OC_CONFIG_RC`), `bin/devbox-sync:279-281` (take `opencode.json` out of the generic link loop and call the converger), `bin/devbox-sync:810-826` (a refusal fails the sync and the heartbeat)
- Modify: `tests/devbox-jobs.test.py` (new class `OpencodeConfigConverge` before the `if __name__ == "__main__":` block)
- Test: `tests/devbox-jobs.test.py`

The function lives in a sourced helper rather than inline in `devbox-sync`. That makes it testable: `devbox-sync`'s config section cannot run in a sandbox, because it runs `config/opencode/superpowers-override/regenerate` against the real checkout. `devbox-sync` sources the helper and calls the function, so the behavior is still `devbox-sync`'s.

**Interfaces:**
- Consumes (B6): `opencode-broker-reconcile verify-deployed-config --json`.
  - It is read-only.
  - stdout is one JSON object with exactly the keys `ok, mode, expectedTarget, actualTarget, generation, registryHash, manifestHash, rawBaseHash, ledgerRevision`.
  - `mode` is one of `"pre-bootstrap"`, `"generated"`, `"raw-emergency"`, `"invalid"`.
  - The exit status is 0 exactly when `ok` is true.
  - The verifier honors the `OPENCODE_RECONCILE_*` env overrides that it inherits.
  - It reports `invalid` in the intermediate state where `configCutover` is generated but the outer link still resolves through the raw chain (RF2/B6).
- Produces:
  - `converge_opencode_config` is a bash function in `bin/_opencode_config.sh`. It takes no arguments. It reads `OPENCODE_RECONCILE_VERIFY` (default `node /home/dev/opencode-broker/bin/opencode-broker-reconcile`), `OPENCODE_RECONCILE_STATE_ROOT` (default `/home/dev/.local/share/opencode/model-routing`), `OPENCODE_RECONCILE_OUTER_LINK` (default `/home/dev/.config/opencode/opencode.json`), `OPENCODE_RECONCILE_RAW_BASE` (default `/home/dev/devbox/config/opencode/opencode.json`) and `OPENCODE_RECONCILE_COMPAT_RAW` (default `/home/dev/fleet-core/config/opencode/opencode.json`).
  - It returns 0 when the link is converged or preserved. It returns 1 when it refuses; in that case the outer link is byte-for-byte unchanged, no temp file is left, and the reason is on stderr, prefixed `  FAILED: opencode.json:`.
  - `devbox-sync` sets `OC_CONFIG_RC=1` on a refusal. It then writes a failing `devbox-sync` heartbeat and exits 1, after every other link has still converged.
  - Decision table:
    - `pre-bootstrap` → outer link = literal `$OPENCODE_RECONCILE_COMPAT_RAW`.
    - `generated` with ok → preserve or recreate literal `$STATE_ROOT/resolver-generations/current/opencode.json`.
    - `raw-emergency` with ok → preserve or recreate literal `$OPENCODE_RECONCILE_RAW_BASE`.
    - Anything else → refuse.

- [ ] **Step 0: Preconditions (stop the task if any check fails)**

Run (in `/home/dev/devbox`):

```bash
git --no-pager status --short -- bin/_opencode_config.sh bin/devbox-sync tests/devbox-jobs.test.py
node /home/dev/opencode-broker/bin/opencode-broker-reconcile verify-deployed-config --json; echo "exit=$?"
readlink /home/dev/.config/opencode/opencode.json
python3 tests/devbox-jobs.test.py 2>&1 | tail -n 3
```

Expected:
- The status output is empty.
- The verifier prints one JSON object with exactly the nine contract keys and `"mode":"pre-bootstrap"`, followed by an `exit=` line.
- `readlink` prints `/home/dev/fleet-core/config/opencode/opencode.json`.
- Record the baseline test summary (`OK` or the existing failure count).

Why each check matters:
- If the verifier is missing, prints anything else, or reports another mode, stop. B6 has not landed, or the ledger is not in the state this task assumes. The live devbox-sync timer runs this checkout, so committing F2 now would fail every sync.
- If `readlink` prints `/home/dev/devbox/config/opencode/opencode.json` instead, record it. The first sync after this task repoints it to the fleet-core compatibility path. The bytes are the same, and it is the chain the Step 0 topology preflight requires.

- [ ] **Step 1: Write the failing tests**

In `tests/devbox-jobs.test.py`, insert this class immediately before the final `if __name__ == "__main__":` line:

```python
class OpencodeConfigConverge(Sandbox):
    """converge_opencode_config (bin/_opencode_config.sh) against a stub verify-deployed-config.

    devbox-sync owns the outer opencode.json link but never decides the mode: it acts only on the
    broker verifier's answer, and every refusal leaves the link exactly where it was."""

    KEYS = ("ok", "mode", "expectedTarget", "actualTarget", "generation",
            "registryHash", "manifestHash", "rawBaseHash", "ledgerRevision")

    def setUp(self):
        super().setUp()
        devbox = self.tmp / "devbox"
        self.raw_base = write(devbox / "config" / "opencode" / "opencode.json", '{"raw": true}\n')
        # The production compatibility topology: fleet-core is a symlink to devbox.
        (self.tmp / "fleet-core").symlink_to(devbox)
        self.compat_raw = self.tmp / "fleet-core" / "config" / "opencode" / "opencode.json"
        self.state_root = self.tmp / "model-routing"
        gen0 = self.state_root / "resolver-generations" / "0"
        write(gen0 / "opencode.json", '{"generated": 0}\n')
        (self.state_root / "resolver-generations/current").symlink_to(gen0)
        self.generated = self.state_root / "resolver-generations/current" / "opencode.json"
        self.outer = self.home / ".config" / "opencode" / "opencode.json"
        self.outer.parent.mkdir(parents=True)
        self.verify_out = self.tmp / "verify.out"
        write(self.stubs / "verify-deployed-config", f"""
            #!/usr/bin/env bash
            printf '%s\\n' "$*" >> {str(self.calls / "verify")!r}
            cat {str(self.verify_out)!r}
            exit "${{STUB_VERIFY_RC:-0}}"
            """, 0o755)

    def verdict(self, mode, ok, expected, **extra):
        doc = {key: None for key in self.KEYS}
        doc.update(ok=ok, mode=mode, expectedTarget=None if expected is None else str(expected))
        doc.update(extra)
        return doc

    def converge(self, doc, rc=0, raw_stdout=None, verify=None):
        self.verify_out.write_text(raw_stdout if raw_stdout is not None else json.dumps(doc) + "\n")
        return self.run_bin(
            "bash", "-c",
            'set -euo pipefail; . "$1"; '
            'if converge_opencode_config; then echo CONVERGED; else echo "REFUSED $?"; fi',
            "converge", BIN / "_opencode_config.sh",
            env={"OPENCODE_RECONCILE_VERIFY": str(verify or self.stubs / "verify-deployed-config"),
                 "OPENCODE_RECONCILE_STATE_ROOT": str(self.state_root),
                 "OPENCODE_RECONCILE_OUTER_LINK": str(self.outer),
                 "OPENCODE_RECONCILE_RAW_BASE": str(self.raw_base),
                 "OPENCODE_RECONCILE_COMPAT_RAW": str(self.compat_raw),
                 "STUB_VERIFY_RC": str(rc)})

    def link_state(self):
        if self.outer.is_symlink():
            return ("link", os.readlink(self.outer), os.lstat(self.outer).st_ino)
        if self.outer.exists():
            return ("file", self.outer.read_bytes(), os.lstat(self.outer).st_ino)
        return ("absent",)

    def assert_no_temp_left(self):
        self.assertEqual(sorted(p.name for p in self.outer.parent.iterdir() if p.name != "opencode.json"), [],
                         "convergence must not leave temp links behind")

    def assert_converged(self, r):
        self.assertIn("CONVERGED", r.stdout, r.stdout + r.stderr)
        self.assert_no_temp_left()

    def assert_refused(self, r, before):
        self.assertIn("REFUSED 1", r.stdout, r.stdout + r.stderr)
        self.assertIn("FAILED: opencode.json:", r.stderr)
        self.assertEqual(self.link_state(), before, "a refusal must leave the outer link exactly as it was")
        self.assert_no_temp_left()

    def test_pre_bootstrap_creates_the_raw_chain_through_the_compat_path(self):
        r = self.converge(self.verdict("pre-bootstrap", True, self.compat_raw))
        self.assert_converged(r)
        self.assertEqual(os.readlink(self.outer), str(self.compat_raw))
        self.assertEqual(self.outer.read_bytes(), self.raw_base.read_bytes())
        self.assertEqual((self.calls / "verify").read_text(), "verify-deployed-config --json\n")

    def test_pre_bootstrap_preserves_the_compat_link_and_repoints_a_bypass(self):
        self.outer.symlink_to(self.compat_raw)
        before = self.link_state()
        self.assert_converged(self.converge(self.verdict("pre-bootstrap", True, self.compat_raw)))
        self.assertEqual(self.link_state(), before, "an exact link must not be rewritten")
        # A link straight at the devbox file bypasses fleet-core; preflight requires the compat hop.
        self.outer.unlink()
        self.outer.symlink_to(self.raw_base)
        self.assert_converged(self.converge(self.verdict("pre-bootstrap", False, self.compat_raw), rc=20))
        self.assertEqual(os.readlink(self.outer), str(self.compat_raw))

    def test_pre_bootstrap_backs_up_a_real_file_before_linking(self):
        self.outer.write_text('{"hand": "edited"}\n')
        r = self.converge(self.verdict("pre-bootstrap", True, self.compat_raw))
        self.assertIn("CONVERGED", r.stdout, r.stdout + r.stderr)
        self.assertEqual(os.readlink(self.outer), str(self.compat_raw))
        backups = [p for p in self.outer.parent.iterdir() if p.name.startswith("opencode.json.pre-fleet.")]
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), '{"hand": "edited"}\n')

    def test_generated_preserves_the_exact_runtime_link(self):
        self.outer.symlink_to(self.generated)
        before = self.link_state()
        self.assert_converged(self.converge(self.verdict("generated", True, self.generated, generation=0)))
        self.assertEqual(self.link_state(), before)

    def test_generated_recreates_a_missing_link_to_the_literal_runtime_path(self):
        self.assert_converged(self.converge(self.verdict("generated", True, self.generated, generation=0)))
        # The literal resolver-generations/current path, never the resolved generation directory: a later
        # generation swap must reach new processes without another sync.
        self.assertEqual(os.readlink(self.outer), str(self.generated))

    def test_rf1_generated_ledger_with_the_raw_chain_still_linked_fails_loudly(self):
        # The cutover window: configCutover says generated and resolver-generations/current has switched, but
        # the outer link still points through the pre-cutover raw chain. devbox-sync must neither
        # relink raw nor complete the retarget itself -- that is the broker's audited transition.
        self.outer.symlink_to(self.compat_raw)
        before = self.link_state()
        with self.subTest("verifier reports invalid"):
            self.assert_refused(self.converge(self.verdict("invalid", False, self.generated), rc=20), before)
        with self.subTest("verifier wrongly reports generated ok"):
            self.assert_refused(self.converge(self.verdict("generated", True, self.generated, generation=0)), before)

    def test_generated_without_a_clean_verification_never_creates_a_link(self):
        r = self.converge(self.verdict("generated", False, self.generated, generation=0), rc=20)
        self.assert_refused(r, ("absent",))

    def test_a_verifier_target_other_than_the_mode_target_is_refused(self):
        self.outer.symlink_to(self.generated)
        before = self.link_state()
        self.assert_refused(self.converge(self.verdict("generated", True, self.raw_base, generation=0)), before)

    def test_raw_emergency_preserves_or_recreates_only_the_canonical_raw_base(self):
        doc = self.verdict("raw-emergency", True, self.raw_base)
        self.outer.symlink_to(self.raw_base)
        before = self.link_state()
        self.assert_converged(self.converge(doc))
        self.assertEqual(self.link_state(), before)
        self.outer.unlink()
        self.assert_converged(self.converge(doc))
        self.assertEqual(os.readlink(self.outer), str(self.raw_base))
        # Still on the generated config, or on the compat hop: retargeting is the broker's
        # rollback-config transition, never something devbox-sync infers.
        for stale in (self.generated, self.compat_raw):
            with self.subTest(stale=str(stale)):
                self.outer.unlink()
                self.outer.symlink_to(stale)
                before = self.link_state()
                self.assert_refused(self.converge(doc), before)

    def test_verifier_failure_or_malformed_answer_never_touches_the_link(self):
        self.outer.symlink_to(self.generated)
        before = self.link_state()
        good = self.verdict("generated", True, self.generated, generation=0)
        cases = {
            "not json": dict(doc=None, raw_stdout="Error: ledger unreadable\n", rc=1),
            "empty stdout": dict(doc=None, raw_stdout="", rc=1),
            "extra key": dict(doc={**good, "hint": "x"}),
            "missing key": dict(doc={k: v for k, v in good.items() if k != "rawBaseHash"}),
            "ok disagrees with exit status": dict(doc=good, rc=20),
            "unknown mode": dict(doc={**good, "mode": "legacy"}),
            "ok is not a boolean": dict(doc={**good, "ok": "true"}),
        }
        for name, kwargs in cases.items():
            with self.subTest(name):
                self.assert_refused(self.converge(**kwargs), before)
        with self.subTest("verifier not runnable"):
            self.assert_refused(self.converge(good, verify=self.tmp / "missing-verifier"), before)

    def test_devbox_sync_routes_opencode_json_through_the_converger(self):
        sync = (BIN / "devbox-sync").read_text()
        self.assertIn('. "$FLEET_CORE/bin/_opencode_config.sh"', sync)
        loops = re.findall(r"^\s*for f in ([^;]*); do$", sync, re.M)
        self.assertTrue(loops)
        for words in loops:
            self.assertNotIn("opencode.json", words.split(),
                             "the generic link loop would put the raw base back after cutover")
        self.assertIn("converge_opencode_config || OC_CONFIG_RC=1", sync)
        self.assertRegex(
            sync,
            r'if \[ "\$OC_CONFIG_RC" != 0 \]; then\n(?:\s*#.*\n)*'
            r'\s*"\$FLEET_CORE/bin/job-heartbeat" devbox-sync 1 "\$SYNC_START"; HB_WRITTEN=1; SYNC_RC=1\n')
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run (in `/home/dev/devbox`):

```bash
python3 tests/devbox-jobs.test.py OpencodeConfigConverge -v
```

Expected: `FAILED`, and every test in `OpencodeConfigConverge` reports a failure.
- The behavioral tests fail because `bin/_opencode_config.sh` does not exist. bash exits on the failed `.`, so stdout holds neither `CONVERGED` nor `REFUSED 1`.
- `test_devbox_sync_routes_opencode_json_through_the_converger` fails on the missing source line.

- [ ] **Step 3: Create the converger**

Create `bin/_opencode_config.sh`:

```bash
#!/usr/bin/env bash
# _opencode_config.sh -- converge ~/.config/opencode/opencode.json. Sourced by devbox-sync; do not
# execute.
#
# Before Package 4 this file was one more entry in devbox-sync's generic link loop, and `link`
# relinks anything that does not resolve to the repo copy. After the cutover the outer link points
# at the generated resolver-generations/current/opencode.json, so that loop would silently undo the cutover on
# the next sync. devbox-sync never infers the mode from the filesystem and never writes the ledger:
# it asks the broker's read-only `verify-deployed-config --json` and acts only on that answer.
#
#   pre-bootstrap  -> the raw chain: outer -> the fleet-core compatibility path, as before
#   generated      -> verifier ok only: preserve, or recreate when absent, outer -> resolver-generations/current
#   raw-emergency  -> verifier ok only: preserve, or recreate when absent, outer -> devbox raw base
#   invalid, verifier failure, malformed answer, anything else
#                  -> "FAILED: opencode.json:" on stderr, return 1, the link is not touched
#
# Every path is overridable for tests through OPENCODE_RECONCILE_*; the defaults are production and
# are the same defaults the broker verifier uses, so both sides compare the same strings.

# Validates the verifier's answer before anything acts on it. stdin: the verifier's stdout;
# argv[1]: its exit status. Prints "<mode>\t<true|false>\t<expectedTarget>" or exits 1 with why.
IFS= read -r -d '' _OC_VERIFY_PY <<'PY' || true
import json, sys

KEYS = {"ok", "mode", "expectedTarget", "actualTarget", "generation",
        "registryHash", "manifestHash", "rawBaseHash", "ledgerRevision"}
MODES = ("pre-bootstrap", "generated", "raw-emergency", "invalid")


def die(reason):
    print(f"verify-deployed-config answer rejected: {reason}", file=sys.stderr)
    sys.exit(1)


rc = int(sys.argv[1])
try:
    doc = json.loads(sys.stdin.read())
except ValueError as exc:
    die(f"stdout is not one JSON object ({exc})")
if not isinstance(doc, dict):
    die("stdout is not a JSON object")
if set(doc) != KEYS:
    die(f"keys {sorted(doc)} are not exactly {sorted(KEYS)}")
if not isinstance(doc["ok"], bool):
    die(f"ok is {doc['ok']!r}, not a boolean")
if doc["mode"] not in MODES:
    die(f"mode {doc['mode']!r} is not one of {', '.join(MODES)}")
# The contract is exit 0 exactly when ok; a disagreement means the verifier itself is broken.
if doc["ok"] != (rc == 0):
    die(f"ok={doc['ok']} disagrees with exit status {rc}")
expected = doc["expectedTarget"]
if expected is not None and (not isinstance(expected, str) or not expected.startswith("/")
                             or "\t" in expected or "\n" in expected):
    die(f"expectedTarget {expected!r} is not an absolute path")
print(f"{doc['mode']}\t{'true' if doc['ok'] else 'false'}\t{expected or ''}")
PY

# Create or replace the link with a single rename(2), so no reader ever sees opencode.json missing.
# The temp name is swept on every failure path.
_oc_swap_link() {
  local target="$1" outer="$2" tmp="$2.devbox-sync.$$"
  rm -f "$tmp"
  if ! ln -s "$target" "$tmp"; then
    rm -f "$tmp"
    echo "  FAILED: opencode.json: could not create a temporary link beside $outer" >&2
    return 1
  fi
  if ! mv -Tf "$tmp" "$outer"; then
    rm -f "$tmp"
    echo "  FAILED: opencode.json: could not move the new link into place at $outer" >&2
    return 1
  fi
}

# pre-bootstrap: the chain the cutover's topology preflight requires -- outer -> the fleet-core
# compatibility path -> the devbox raw base. The literal link text is compared, not the resolved
# file, so a link that bypasses fleet-core is repointed here instead of failing preflight later.
# A real file in the way is backed up exactly as `link` does.
_oc_link_raw_chain() {
  local outer="$1" src="$2" bak
  if [ ! -f "$src" ] || [ ! -r "$src" ]; then
    echo "  FAILED: opencode.json: raw source $src is not a readable regular file; link left as it is" >&2
    return 1
  fi
  if [ -L "$outer" ] && [ "$(readlink "$outer")" = "$src" ]; then
    echo "  ok    ${outer/#$HOME/\~}  (pre-bootstrap raw chain)"
    return 0
  fi
  if [ -e "$outer" ] && [ ! -L "$outer" ]; then
    bak="$outer.pre-fleet.$(date +%Y%m%d%H%M%S)"
    if ! mv "$outer" "$bak"; then
      echo "  FAILED: opencode.json: could not back up the real file at $outer; link left as it is" >&2
      return 1
    fi
    echo "  bak   ${outer/#$HOME/\~}  ->  ${bak##*/}"
  fi
  _oc_swap_link "$src" "$outer" || return 1
  echo "  link  ${outer/#$HOME/\~}  (pre-bootstrap raw chain)"
}

# generated / raw-emergency: only on a clean verification, and only to the one exact target the
# mode allows. An existing link whose literal text is that target is preserved; a missing link is
# recreated; anything else -- including the cutover window, where the outer link still points at
# the raw chain -- is refused, because moving it is the broker's audited transition, not ours.
_oc_link_exact() {
  local outer="$1" target="$2" mode="$3" ok="$4" expected="$5"
  if [ "$ok" != true ]; then
    echo "  FAILED: opencode.json: configCutover is $mode but verify-deployed-config is not ok; link left as it is" >&2
    return 1
  fi
  if [ "$expected" != "$target" ]; then
    echo "  FAILED: opencode.json: the verifier expects '$expected' but the $mode target is $target; link left as it is" >&2
    return 1
  fi
  if [ -L "$outer" ] && [ "$(readlink "$outer")" = "$target" ]; then
    echo "  ok    ${outer/#$HOME/\~}  ($mode)"
    return 0
  fi
  if [ -e "$outer" ] || [ -L "$outer" ]; then
    echo "  FAILED: opencode.json: configCutover is $mode but $outer is not a link to $target; link left as it is" >&2
    return 1
  fi
  if [ ! -f "$target" ]; then
    echo "  FAILED: opencode.json: $mode target $target does not resolve to a regular file; link not recreated" >&2
    return 1
  fi
  _oc_swap_link "$target" "$outer" || return 1
  echo "  link  ${outer/#$HOME/\~}  (recreated, $mode)"
}

# converge_opencode_config -- returns 0 when the outer link is converged or preserved, 1 when it
# refused (the link is unchanged and the reason is on stderr). The caller decides what a refusal
# costs; devbox-sync fails the sync and its heartbeat.
converge_opencode_config() {
  local state_root="${OPENCODE_RECONCILE_STATE_ROOT:-/home/dev/.local/share/opencode/model-routing}"
  local outer="${OPENCODE_RECONCILE_OUTER_LINK:-/home/dev/.config/opencode/opencode.json}"
  local raw_base="${OPENCODE_RECONCILE_RAW_BASE:-/home/dev/devbox/config/opencode/opencode.json}"
  local compat_raw="${OPENCODE_RECONCILE_COMPAT_RAW:-/home/dev/fleet-core/config/opencode/opencode.json}"
  local generated_target="$state_root/resolver-generations/current/opencode.json"
  local -a verify_cmd=()
  local out="" rc=0 parsed="" mode="" ok="" expected=""

  echo "==> converging opencode.json from the verified configCutover mode"
  read -r -a verify_cmd <<<"${OPENCODE_RECONCILE_VERIFY:-node /home/dev/opencode-broker/bin/opencode-broker-reconcile}"
  # The verifier's stderr passes straight through so its reason lands in the sync log.
  out="$("${verify_cmd[@]}" verify-deployed-config --json)" || rc=$?
  if ! parsed="$(printf '%s' "$out" | python3 -c "$_OC_VERIFY_PY" "$rc")"; then
    echo "  FAILED: opencode.json: verify-deployed-config (exit $rc) gave no usable answer; link left as it is" >&2
    return 1
  fi
  IFS=$'\t' read -r mode ok expected <<<"$parsed"
  case "$mode" in
    pre-bootstrap) _oc_link_raw_chain "$outer" "$compat_raw" ;;
    generated)     _oc_link_exact "$outer" "$generated_target" generated "$ok" "$expected" ;;
    raw-emergency) _oc_link_exact "$outer" "$raw_base" raw-emergency "$ok" "$expected" ;;
    *)
      echo "  FAILED: opencode.json: verify-deployed-config reports mode '$mode' -- ledger, registry, artifacts or link disagree; link left as it is. Inspect with: ${verify_cmd[*]} verify-deployed-config --json" >&2
      return 1
      ;;
  esac
}
```

- [ ] **Step 4: Wire the converger into devbox-sync**

In `bin/devbox-sync`, replace line 22:

```bash
. "$FLEET_CORE/bin/_devbox.sh"
```

with:

```bash
. "$FLEET_CORE/bin/_devbox.sh"
. "$FLEET_CORE/bin/_opencode_config.sh"
```

Replace line 44:

```bash
HB_WRITTEN=0
```

with:

```bash
HB_WRITTEN=0
# 1 when converge_opencode_config refused to touch ~/.config/opencode/opencode.json: the rest of
# the config still converges, then the sync fails at the end (see the heartbeat block).
OC_CONFIG_RC=0
```

Replace lines 279-281:

```bash
  for f in opencode.json AGENTS.md dcp.jsonc supermemory.jsonc tui.json package.json; do
    [ -e "$OC_SRC/$f" ] && link "opencode/$f" "$HOME/.config/opencode/$f"
  done
```

with:

```bash
  for f in AGENTS.md dcp.jsonc supermemory.jsonc tui.json package.json; do
    [ -e "$OC_SRC/$f" ] && link "opencode/$f" "$HOME/.config/opencode/$f"
  done
  # opencode.json is deliberately NOT in that loop. After the Package 4 cutover its link targets
  # the generated resolver-generations/current config, and `link` -- which relinks anything that does not
  # resolve to the repo file -- would silently put the raw base back. It converges from the
  # broker's verified configCutover mode instead (bin/_opencode_config.sh). A refusal changes no
  # link and fails this sync at the end, after every other link has still converged.
  converge_opencode_config || OC_CONFIG_RC=1
```

Replace lines 810-826:

```bash
SYNC_RC=0
if [ "$DO_PULL" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  case "$PULL_STATE" in
    synced|ahead) "$FLEET_CORE/bin/job-heartbeat" devbox-sync 0 "$SYNC_START"; HB_WRITTEN=1 ;;
    broken) "$FLEET_CORE/bin/job-heartbeat" devbox-sync 1 "$SYNC_START"; HB_WRITTEN=1; SYNC_RC=1 ;;
    behind) HB_WRITTEN=1 ;;
  esac
fi

if [ "$SYNC_RC" = 0 ] && [ "$PULL_STATE" = synced ]; then
  echo "==> devbox-sync done."
elif [ "$SYNC_RC" = 0 ] && [ "$PULL_STATE" = ahead ]; then
  echo "==> devbox-sync converged locally; a checkout is ahead of upstream. Publish the local commits." >&2
else
  echo "==> devbox-sync finished, but this host is NOT in sync with main (${PULL_STATE}${PULL_ERR:+: $PULL_ERR})." >&2
fi
exit "$SYNC_RC"
```

with:

```bash
SYNC_RC=0
if [ "$OC_CONFIG_RC" != 0 ]; then
  # A refused opencode.json convergence fails the sync whatever the pull did, --no-pull included:
  # the heartbeat goes red at once ("last run failed") and the unit fails, so a wrong deployed
  # link or a mid-cutover state cannot age quietly behind a green sync.
  "$FLEET_CORE/bin/job-heartbeat" devbox-sync 1 "$SYNC_START"; HB_WRITTEN=1; SYNC_RC=1
elif [ "$DO_PULL" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  case "$PULL_STATE" in
    synced|ahead) "$FLEET_CORE/bin/job-heartbeat" devbox-sync 0 "$SYNC_START"; HB_WRITTEN=1 ;;
    broken) "$FLEET_CORE/bin/job-heartbeat" devbox-sync 1 "$SYNC_START"; HB_WRITTEN=1; SYNC_RC=1 ;;
    behind) HB_WRITTEN=1 ;;
  esac
fi

if [ "$OC_CONFIG_RC" != 0 ]; then
  echo "==> devbox-sync FAILED: ~/.config/opencode/opencode.json was not converged (see FAILED above); the link was left as it was." >&2
elif [ "$SYNC_RC" = 0 ] && [ "$PULL_STATE" = synced ]; then
  echo "==> devbox-sync done."
elif [ "$SYNC_RC" = 0 ] && [ "$PULL_STATE" = ahead ]; then
  echo "==> devbox-sync converged locally; a checkout is ahead of upstream. Publish the local commits." >&2
else
  echo "==> devbox-sync finished, but this host is NOT in sync with main (${PULL_STATE}${PULL_ERR:+: $PULL_ERR})." >&2
fi
exit "$SYNC_RC"
```

- [ ] **Step 5: Run the new tests and confirm they pass**

Run (in `/home/dev/devbox`):

```bash
bash -n bin/_opencode_config.sh && bash -n bin/devbox-sync && echo syntax-ok
python3 tests/devbox-jobs.test.py OpencodeConfigConverge -v
```

Expected: `syntax-ok`, then `Ran 11 tests` and `OK`.

- [ ] **Step 6: Run both fleet suites**

Run (in `/home/dev/devbox`):

```bash
python3 tests/devbox-jobs.test.py 2>&1 | tail -n 3
node --test tests/fleet-config.test.mjs 2>&1 | grep -E "^# (pass|fail)"
```

Expected:
- The Python suite reports `OK`, with 11 more tests than the Step 0 baseline. The existing `DevboxSync` tests still pass, because they run with `--no-config` and never reach the converger.
- `fleet-config.test.mjs` shows the same `# fail` count as after F1, normally 0. Its `devbox-sync patches every installed supermemory package copy` test still passes.

- [ ] **Step 7: Commit**

```bash
git add bin/_opencode_config.sh bin/devbox-sync tests/devbox-jobs.test.py
git commit -m "fix(devbox-sync): converge opencode.json only from the verified configCutover mode"
```

### Task F3: Model-reconciliation approval skill and its deployment preflight

**Goal of this task:** Ship the approval skill (a session surface over the broker reconcile CLI that keeps no state of its own) and a read-only checker. The checker confirms that the skill's source, compatibility and deployed paths exist, are readable, resolve to the same regular source file, and have matching SHA-256 bytes. Cutover step 0 depends on that checker. It never repairs anything. Only devbox-sync repairs the skills symlink, and only outside the cutover transaction.

**Files:**
- Create: `config/opencode/skills/model-reconciliation-approval/SKILL.md`
- Create: `bin/opencode-model-skill-preflight` (executable Node ESM script, mode 0755; same shebang style as `bin/oc-bridge-mcp:1`)
- Test: `tests/model-reconciliation-skill.test.mjs` (`node:test` + `node:assert/strict`, like `tests/fleet-config.test.mjs:6-7`)

All paths are relative to `/home/dev/devbox`. Run every command below from `/home/dev/devbox`.

**Interfaces:**
- Consumes:
  - The existing skills-directory link at `bin/devbox-sync:303`: `[ -d "$OC_SRC/skills" ] && link "opencode/skills" "$HOME/.config/opencode/skills"`. It deploys the new skill with no devbox-sync change.
  - Contract env overrides, with these defaults:
    - `OPENCODE_RECONCILE_DEVBOX` (default `/home/dev/devbox`)
    - `OPENCODE_RECONCILE_FLEET_CORE` (default `/home/dev/fleet-core`)
    - `OPENCODE_RECONCILE_OUTER_LINK` (default `/home/dev/.config/opencode/opencode.json`). The deployed skills directory is `dirname(OUTER_LINK)/skills`, because the outer config link and the skills link both live in `~/.config/opencode`.
  - Broker CLI names from the contract (B5-B8), referenced in SKILL.md only:
    - `scheduled-run --json`
    - `gate-status --provider <id> --json`
    - the Package 1/2 commands `status`, `evidence-status`, `approve`, `reject`, `amend`
  - `EXPANSION_LOCK=/home/dev/.local/share/opencode/model-routing/provider-expansion.lock`.
- Produces:
  - `bin/opencode-model-skill-preflight --json`. It is read-only and never writes, links, chmods or deletes. Output and exit status:
    - stdout carries exactly one JSON line: `{ ok: boolean, source: Entry, compat: Entry, deployed: Entry, remedy: string | null }`
    - `Entry = { path: string, realPath: string | null, sha256: string | null, reasons: string[] }`
    - `reasons` items come from: `"missing" | "unresolved" | "not-regular" | "unreadable" | "source-not-canonical" | "not-same-file" | "sha256-mismatch"`
    - Exit `0` when every `reasons` array is empty. Exit `20` (needs attention) on any failure, with a `remedy` naming devbox-sync. Exit `2` on any argv other than exactly `--json` (nothing on stdout). Exit `1` on an unexpected error, with stdout `{ ok: false, error: string }`.
  - Operator tool. Holden runs `bin/opencode-model-skill-preflight --json` by hand (runbook R0) to check the skill deployment before staging anything. The stage script's `preflight` enforces the same rule with its own tested `check_approval_skill` (Task F4a1); the two must agree, and this script's tests pin the shared rule (same regular source file, identical SHA-256, refusal on a missing or broken path). No cutover step invokes this script.
  - `config/opencode/skills/model-reconciliation-approval/SKILL.md`, with frontmatter `name: model-reconciliation-approval`.

- [ ] **Step 1: Write the failing skill-content tests**

Create `tests/model-reconciliation-skill.test.mjs` with this content. Step 5 appends the preflight tests to this file.

```js
// Model-reconciliation approval skill (Package 4): the skill's own content
// contract, and the deployment preflight that cutover step 0 runs. The
// preflight is read-only; devbox-sync is the only thing that repairs the
// skills symlink, and never during the cutover transaction.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PREFLIGHT = join(REPO, "bin", "opencode-model-skill-preflight");
const SKILL_REL = join("config", "opencode", "skills", "model-reconciliation-approval", "SKILL.md");
const SKILL_SOURCE = join(REPO, SKILL_REL);
const skillText = () => readFileSync(SKILL_SOURCE, "utf8");

test("approval skill frontmatter names itself and states when to use it", () => {
  const match = skillText().match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
  assert.ok(match, "frontmatter must be exactly: ---, name, one-line description, ---");
  assert.equal(match[1], "model-reconciliation-approval");
  assert.match(match[2], /^Use when /);
  assert.ok(match[2].length <= 1024, `description is ${match[2].length} chars`);
});

test("approval skill drives only the broker reconcile CLI and reconciles under the expansion lock", () => {
  const text = skillText();
  for (const required of [
    "node /home/dev/opencode-broker/bin/opencode-broker-reconcile status --json",
    "node /home/dev/opencode-broker/bin/opencode-broker-reconcile evidence-status --json",
    "node /home/dev/opencode-broker/bin/opencode-broker-reconcile gate-status --provider <id> --json",
    "flock -n -E 5 /home/dev/.local/share/opencode/model-routing/provider-expansion.lock node /home/dev/opencode-broker/bin/opencode-broker-reconcile scheduled-run --json",
  ]) {
    assert.ok(text.includes(required), `missing: ${required}`);
  }
  for (const operation of ["approve", "reject", "amend"]) {
    assert.ok(text.includes(`\`${operation}\``), `missing operation: ${operation}`);
  }
  // The retired watch is never an approval path.
  assert.doesNotMatch(text, /opencode-broker-watch/);
  assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
});

test("approval skill keeps decisions with Holden and leaves operator steps to the stage script", () => {
  const text = skillText();
  assert.ok(text.includes("Holden names the decision and the exact transition ID"));
  assert.ok(text.includes("Never edit `model-reconciliation.json`"));
  assert.ok(text.includes("/home/dev/fleet-core/bin/opencode-model-provider-stage"));
  assert.ok(text.includes("never delete or reopen the lock file"));
});
```

- [ ] **Step 2: Run the skill tests to verify they fail**

Run: `node --test --test-name-pattern="approval skill" tests/model-reconciliation-skill.test.mjs`
Expected: FAIL. All 3 tests fail with `ENOENT: no such file or directory, open '/home/dev/devbox/config/opencode/skills/model-reconciliation-approval/SKILL.md'`.

- [ ] **Step 3: Confirm the broker command names the skill will cite (read-only)**

The decision syntax of `approve`, `reject` and `amend` lives in the broker repo, not in this plan. The skill points at it rather than guessing it. Confirm both facts before writing the skill:

Run: `grep -n -E 'evidence-status|\bapprove\b|\breject\b|\bamend\b' /home/dev/opencode-broker/README.md`
Expected: at least one line each for `evidence-status`, `approve`, `reject` and `amend`.

Run: `node /home/dev/opencode-broker/bin/opencode-broker-reconcile status --json >/dev/null; echo "exit=$?"`
Expected: `exit=0`. `status` is read-only (umbrella spec, reconcile command list).

If any name is absent, or `status --json` exits nonzero, stop and report BLOCKED with the exact output. Do not invent a substitute command.

- [ ] **Step 4: Write the skill**

Create `config/opencode/skills/model-reconciliation-approval/SKILL.md`:

````markdown
---
name: model-reconciliation-approval
description: Use when Holden asks to list, inspect, approve, reject or amend a model-reconciliation proposal, or to run one reconcile pass, from an OpenCode session. Drives only the broker's opencode-broker-reconcile CLI and keeps no approval state of its own. Not for provider cutover, expansion or rollback steps, which Holden runs through opencode-model-provider-stage.
---

# Model reconciliation approval

This skill is the in-session surface for model-reconciliation decisions. It calls the same broker
command and the same durable ledger as the Gitea issue path and holds no approval state of its
own. Gitea stays the remote and mobile surface. A decision made through either surface lands in
the same ledger, so read `status` before acting -- the proposal may already be decided.

The broker reconcile command is the sole writer. Never edit `model-reconciliation.json`,
`resolver-overlay.json`, `resolver-generations.json`, anything under `resolver-generations/` or
`resolver-generations/current`, or `/home/dev/.config/opencode/opencode.json` by hand.

## Operations

| Operation | Command | Mutates |
| --- | --- | --- |
| list | `node /home/dev/opencode-broker/bin/opencode-broker-reconcile status --json` | no |
| inspect | `node /home/dev/opencode-broker/bin/opencode-broker-reconcile status --json` and `node /home/dev/opencode-broker/bin/opencode-broker-reconcile evidence-status --json`, read for one transition ID | no |
| provider gate (read only) | `node /home/dev/opencode-broker/bin/opencode-broker-reconcile gate-status --provider <id> --json` | no |
| `approve`, `reject`, `amend` | the broker subcommand of that name; syntax under "Decisions" | yes, through the broker |
| reconcile | `flock -n -E 5 /home/dev/.local/share/opencode/model-routing/provider-expansion.lock node /home/dev/opencode-broker/bin/opencode-broker-reconcile scheduled-run --json` | only when apply is enabled |

## Decisions are Holden's

- Run `approve`, `reject` or `amend` only when Holden names the decision and the exact transition ID
  in this session. Agreement in passing, a decision from another session, or "looks fine" about a
  list is not a decision.
- Before the call, show him the inspect output for that transition: provider, role, candidate,
  incumbent, evidence status and proposal revision. A changed revision needs a fresh decision;
  never carry a decision across revisions.
- Argument syntax for the three decision subcommands is defined by the broker and documented in
  `/home/dev/opencode-broker/README.md`. Read that section before the first decision in a session
  and pass the transition ID and revision exactly as `status --json` printed them. Never guess a
  flag: a usage error changes nothing, but a guessed flag that happens to parse can change the
  wrong record.
- A proposal holding both an approval and a rejection is a conflict and causes no policy change.
  Report it; do not settle it with a third decision unless Holden asks for that.

## Reconcile

- Always run reconcile through the `flock` line above. `opencode-model-provider-stage` holds that
  lock for its whole run, and the scheduled timer takes it for each pass.
- Exit 5 means another writer holds the lock, or the ledger is in raw-emergency mode, where the
  reconciler deliberately stands down. Report it and stop: do not retry in a loop, and
  never delete or reopen the lock file.
- With apply disabled, or before config cutover, the pass is a dry run and changes no published
  policy. Say so when you report it.

## Reporting

Exit codes: 0 ok, 5 quiet or skipped, 10 finding, 20 needs attention, anything else failure.
Quote the JSON `ok` field and any `code` or `reason` verbatim. A `code` of
`reconcile-apply-disabled` is configuration, not an error to work around.

## Not this skill

Cutover, `prepare`, `commit`, `canary`, `gate-start`, `gate-complete`, `gate-reset` and every
`rollback-config` form are operator steps. Holden runs them through
`/home/dev/fleet-core/bin/opencode-model-provider-stage`. If he asks for one, name the stage-script
subcommand; do not call the broker CLI for it directly. Never run `~/fleet-core/bin/devbox-sync`
while that script is mid-run, and never call a provider API directly -- probes go through the
broker's canary path.
````

- [ ] **Step 5: Run the skill tests to verify they pass**

Run: `node --test --test-name-pattern="approval skill" tests/model-reconciliation-skill.test.mjs`
Expected: PASS, 3 tests, 0 failures.

- [ ] **Step 6: Write the failing preflight tests**

Append to `tests/model-reconciliation-skill.test.mjs`:

```js
// ---------------------------------------------------------------------------
// Deployment preflight. A fixture mirrors production: a real devbox tree, a
// fleet-core symlink to it, and a ~/.config/opencode/skills symlink into
// fleet-core, exactly what bin/devbox-sync:303 builds.

function fixture(t) {
  // realpath: tmpdir() may itself sit behind a symlink, and the source path
  // must be canonical for the preflight to accept it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skill-preflight-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const devbox = join(root, "devbox");
  const fleetCore = join(root, "fleet-core");
  const opencodeDir = join(root, "home", ".config", "opencode");
  const source = join(devbox, SKILL_REL);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, readFileSync(SKILL_SOURCE));
  symlinkSync(devbox, fleetCore);
  mkdirSync(opencodeDir, { recursive: true });
  const deployedSkills = join(opencodeDir, "skills");
  symlinkSync(join(fleetCore, "config", "opencode", "skills"), deployedSkills);
  return {
    root, devbox, fleetCore, source, deployedSkills,
    compat: join(fleetCore, SKILL_REL),
    deployed: join(deployedSkills, "model-reconciliation-approval", "SKILL.md"),
    env: {
      ...process.env,
      OPENCODE_RECONCILE_DEVBOX: devbox,
      OPENCODE_RECONCILE_FLEET_CORE: fleetCore,
      OPENCODE_RECONCILE_OUTER_LINK: join(opencodeDir, "opencode.json"),
    },
  };
}

const runPreflight = (env, args = ["--json"]) =>
  spawnSync(process.execPath, [PREFLIGHT, ...args], { env, encoding: "utf8" });

const reasonsOf = (json) => ({
  source: json.source.reasons, compat: json.compat.reasons, deployed: json.deployed.reasons,
});

// lstat-level picture of a tree, symlinks not followed: proves the preflight
// changed no byte, mode, mtime or link target.
function snapshot(root) {
  const out = {};
  const walk = (path) => {
    const st = lstatSync(path);
    out[path] = {
      mode: st.mode, size: st.size, mtimeMs: st.mtimeMs,
      link: st.isSymbolicLink() ? readlinkSync(path) : null,
    };
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  walk(root);
  return out;
}

test("skill preflight is an executable node script", () => {
  assert.equal(statSync(PREFLIGHT).mode & 0o111, 0o111);
  assert.match(readFileSync(PREFLIGHT, "utf8"), /^#!\/usr\/bin\/env node\n/);
});

test("skill preflight passes when source, compatibility and deployed paths are one regular file", (t) => {
  const fx = fixture(t);
  const result = runPreflight(fx.env);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  const sha = createHash("sha256").update(readFileSync(fx.source)).digest("hex");
  assert.deepEqual(json, {
    ok: true,
    source: { path: fx.source, realPath: fx.source, sha256: sha, reasons: [] },
    compat: { path: fx.compat, realPath: fx.source, sha256: sha, reasons: [] },
    deployed: { path: fx.deployed, realPath: fx.source, sha256: sha, reasons: [] },
    remedy: null,
  });
});

const FAILURES = [
  {
    name: "source missing",
    mutate: (fx) => rmSync(fx.source),
    expect: { source: ["missing"], compat: ["missing"], deployed: ["missing"] },
  },
  {
    name: "source is a symlink, not the regular file",
    mutate: (fx) => {
      const moved = join(fx.devbox, "elsewhere.md");
      renameSync(fx.source, moved);
      symlinkSync(moved, fx.source);
    },
    expect: { source: ["not-regular"], compat: [], deployed: [] },
  },
  {
    name: "source is a directory",
    mutate: (fx) => { rmSync(fx.source); mkdirSync(fx.source); },
    expect: { source: ["not-regular"], compat: ["not-regular"], deployed: ["not-regular"] },
  },
  {
    name: "source path reached through a symlink is not canonical",
    mutate: (fx) => { fx.env.OPENCODE_RECONCILE_DEVBOX = fx.fleetCore; },
    expect: { source: ["source-not-canonical"], compat: [], deployed: [] },
  },
  {
    name: "fleet-core is an identical copy instead of the devbox link",
    mutate: (fx) => { unlinkSync(fx.fleetCore); cpSync(fx.devbox, fx.fleetCore, { recursive: true }); },
    expect: { source: [], compat: ["not-same-file"], deployed: ["not-same-file"] },
  },
  {
    name: "fleet-core copy has different bytes",
    mutate: (fx) => {
      unlinkSync(fx.fleetCore);
      cpSync(fx.devbox, fx.fleetCore, { recursive: true });
      writeFileSync(fx.compat, "drifted\n", { flag: "a" });
    },
    expect: {
      source: [],
      compat: ["not-same-file", "sha256-mismatch"],
      deployed: ["not-same-file", "sha256-mismatch"],
    },
  },
  {
    name: "deployed skills link is absent",
    mutate: (fx) => unlinkSync(fx.deployedSkills),
    expect: { source: [], compat: [], deployed: ["missing"] },
  },
  {
    name: "deployed skills link dangles",
    mutate: (fx) => { unlinkSync(fx.deployedSkills); symlinkSync(join(fx.root, "gone"), fx.deployedSkills); },
    expect: { source: [], compat: [], deployed: ["missing"] },
  },
  {
    name: "deployed skill file is a dangling symlink",
    mutate: (fx) => {
      unlinkSync(fx.deployedSkills);
      mkdirSync(dirname(fx.deployed), { recursive: true });
      symlinkSync(join(fx.root, "nowhere.md"), fx.deployed);
    },
    expect: { source: [], compat: [], deployed: ["unresolved"] },
  },
  {
    name: "deployed skill file is a symlink loop",
    mutate: (fx) => {
      unlinkSync(fx.deployedSkills);
      mkdirSync(dirname(fx.deployed), { recursive: true });
      symlinkSync(fx.deployed, fx.deployed);
    },
    expect: { source: [], compat: [], deployed: ["unresolved"] },
  },
  {
    name: "deployed skills is a real directory holding a copy",
    mutate: (fx) => {
      unlinkSync(fx.deployedSkills);
      mkdirSync(dirname(fx.deployed), { recursive: true });
      writeFileSync(fx.deployed, readFileSync(fx.source));
    },
    expect: { source: [], compat: [], deployed: ["not-same-file"] },
  },
];

for (const failure of FAILURES) {
  test(`skill preflight rejects without repairing: ${failure.name}`, (t) => {
    const fx = fixture(t);
    failure.mutate(fx);
    const before = snapshot(fx.root);
    const result = runPreflight(fx.env);
    assert.equal(result.status, 20, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, false);
    assert.deepEqual(reasonsOf(json), failure.expect);
    assert.match(json.remedy, /devbox-sync/);
    assert.match(json.remedy, /outside the cutover transaction/);
    assert.deepEqual(snapshot(fx.root), before, "preflight must not touch the filesystem");
  });
}

test(
  "skill preflight rejects an unreadable source on every path",
  { skip: process.getuid?.() === 0 ? "root reads mode-0000 files, so EACCES cannot be produced" : false },
  (t) => {
    const fx = fixture(t);
    chmodSync(fx.source, 0o000);
    t.after(() => chmodSync(fx.source, 0o644));
    const before = snapshot(fx.root);
    const result = runPreflight(fx.env);
    assert.equal(result.status, 20, result.stderr);
    assert.deepEqual(reasonsOf(JSON.parse(result.stdout)), {
      source: ["unreadable"], compat: ["unreadable"], deployed: ["unreadable"],
    });
    assert.deepEqual(snapshot(fx.root), before);
  },
);

test("skill preflight refuses any argv other than exactly --json", (t) => {
  const fx = fixture(t);
  for (const args of [[], ["--fix"], ["--json", "--repair"]]) {
    const result = runPreflight(fx.env, args);
    assert.equal(result.status, 2, `argv ${JSON.stringify(args)}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /usage: opencode-model-skill-preflight --json/);
  }
});

test("skill preflight passes on the deployed host paths", () => {
  // Live deployment layer, as in fleet-config.test.mjs: no overrides, so the
  // production defaults are checked against this host's real links.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_RECONCILE_")),
  );
  const result = runPreflight(env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const json = JSON.parse(result.stdout);
  const real = "/home/dev/devbox/config/opencode/skills/model-reconciliation-approval/SKILL.md";
  assert.equal(json.source.path, real);
  assert.equal(json.compat.path, "/home/dev/fleet-core/config/opencode/skills/model-reconciliation-approval/SKILL.md");
  assert.equal(json.deployed.path, "/home/dev/.config/opencode/skills/model-reconciliation-approval/SKILL.md");
  for (const entry of [json.source, json.compat, json.deployed]) assert.equal(entry.realPath, real);
});
```

- [ ] **Step 7: Run the preflight tests to verify they fail**

Run: `node --test --test-name-pattern="skill preflight" tests/model-reconciliation-skill.test.mjs`
Expected: FAIL.
- The executable test fails with `ENOENT ... bin/opencode-model-skill-preflight`.
- Every spawn-based test fails on its status assertion (`1 !== 0`, `1 !== 20` or `1 !== 2`), because Node exits 1 with `Cannot find module '/home/dev/devbox/bin/opencode-model-skill-preflight'`.
- The unreadable-source test reports as skipped only when run as root.

- [ ] **Step 8: Implement the preflight**

Create `bin/opencode-model-skill-preflight`:

```js
#!/usr/bin/env node
// opencode-model-skill-preflight: Package 4 cutover step 0 check for the
// model-reconciliation approval skill.
//
// The skill has three paths that must all be the SAME regular file:
//   source    $DEVBOX/config/opencode/skills/model-reconciliation-approval/SKILL.md
//   compat    $FLEET_CORE/<same>        (fleet-core is a symlink to devbox)
//   deployed  ~/.config/opencode/skills/<same>  (devbox-sync links skills/ as a directory)
// Each must exist, resolve, be a regular file, be readable, resolve to the
// source's real path and inode, and carry the source's SHA-256 bytes.
//
// READ-ONLY by design. A failure stops cutover; the repair is a devbox-sync
// run OUTSIDE the cutover transaction followed by a fresh preflight. This
// script never links, copies or chmods anything -- repairing here would be a
// second writer racing the stage script that holds the expansion lock.
//
// Exit: 0 all paths valid; 20 any path invalid (needs attention, job-run
// contract); 2 usage; 1 unexpected error.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SKILL_REL = join("config", "opencode", "skills", "model-reconciliation-approval", "SKILL.md");
const REMEDY =
  "stop: do not start or continue cutover; run ~/fleet-core/bin/devbox-sync outside the cutover " +
  "transaction to repair the skills symlink, then re-run opencode-model-skill-preflight --json";

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--json") {
  process.stderr.write("usage: opencode-model-skill-preflight --json\n");
  process.exit(2);
}

// Map an fs error to a preflight reason. Unknown errno values are rethrown so
// they surface as exit 1 instead of being mislabelled as a path problem.
function classify(error, fallback) {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return fallback;
  if (error.code === "ELOOP") return "unresolved";
  if (error.code === "EACCES" || error.code === "EPERM") return "unreadable";
  throw error;
}

// isSource: the source itself must be a regular file (not a symlink) at its
// own canonical path; compat and deployed are expected to be reached through
// symlinks and are judged by what they resolve to.
function inspect(path, isSource) {
  const entry = { path, realPath: null, sha256: null, reasons: [], identity: null };
  let link;
  try { link = lstatSync(path); } catch (error) { entry.reasons.push(classify(error, "missing")); return entry; }
  if (isSource && !link.isFile()) { entry.reasons.push("not-regular"); return entry; }
  let realPath;
  try { realPath = realpathSync(path); } catch (error) { entry.reasons.push(classify(error, "unresolved")); return entry; }
  entry.realPath = realPath;
  if (isSource && realPath !== path) entry.reasons.push("source-not-canonical");
  let target;
  try { target = statSync(realPath, { bigint: true }); } catch (error) { entry.reasons.push(classify(error, "unresolved")); return entry; }
  if (!target.isFile()) { entry.reasons.push("not-regular"); return entry; }
  entry.identity = `${target.dev}:${target.ino}`;
  let bytes;
  // Read through the path under test, not the resolved one, so the bytes
  // hashed are the bytes a consumer of that path would load.
  try { bytes = readFileSync(path); } catch (error) { entry.reasons.push(classify(error, "unreadable")); return entry; }
  entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  return entry;
}

try {
  const devbox = process.env.OPENCODE_RECONCILE_DEVBOX || "/home/dev/devbox";
  const fleetCore = process.env.OPENCODE_RECONCILE_FLEET_CORE || "/home/dev/fleet-core";
  const outerLink = process.env.OPENCODE_RECONCILE_OUTER_LINK || "/home/dev/.config/opencode/opencode.json";
  // The deployed skills directory sits beside the outer opencode.json link in
  // ~/.config/opencode; deriving it keeps one override for that directory.
  const source = inspect(join(devbox, SKILL_REL), true);
  const compat = inspect(join(fleetCore, SKILL_REL), false);
  const deployed = inspect(
    join(dirname(outerLink), "skills", "model-reconciliation-approval", "SKILL.md"), false,
  );

  // Comparison needs a valid source; when the source is bad, its own reasons
  // already fail the run and comparing against it would only add noise.
  if (source.reasons.length === 0) {
    for (const entry of [compat, deployed]) {
      if (entry.identity === null || entry.sha256 === null) continue; // own reasons already recorded
      if (entry.realPath !== source.realPath || entry.identity !== source.identity) {
        entry.reasons.push("not-same-file");
      }
      if (entry.sha256 !== source.sha256) entry.reasons.push("sha256-mismatch");
    }
  }

  const view = ({ path, realPath, sha256, reasons }) => ({ path, realPath, sha256, reasons });
  const ok = [source, compat, deployed].every((entry) => entry.reasons.length === 0);
  process.stdout.write(`${JSON.stringify({
    ok, source: view(source), compat: view(compat), deployed: view(deployed), remedy: ok ? null : REMEDY,
  })}\n`);
  process.exit(ok ? 0 : 20);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) })}\n`);
  process.exit(1);
}
```

Then make it executable:

Run: `chmod 0755 bin/opencode-model-skill-preflight`

- [ ] **Step 9: Run the preflight tests to verify they pass**

Run: `node --test --test-name-pattern="skill preflight" tests/model-reconciliation-skill.test.mjs`
Expected: PASS, 16 tests, 0 failures: 1 executable, 1 pass fixture, 11 rejection cases, 1 unreadable, 1 usage, 1 live host. Running as root reports the unreadable test as skipped.

If only `skill preflight passes on the deployed host paths` fails, read its message before changing any code. A `deployed.reasons` of `["missing"]` or `["not-same-file"]` means this host's `~/.config/opencode/skills` link is wrong. Fix that by running `~/fleet-core/bin/devbox-sync` (no cutover is in progress during this task), then re-run. That outcome is the preflight working, not a test defect.

- [ ] **Step 10: Prove the comparison checks are load-bearing**

Temporarily replace the line `if (source.reasons.length === 0) {` in `bin/opencode-model-skill-preflight` with `if (false) {`.

Run: `node --test --test-name-pattern="skill preflight rejects without repairing" tests/model-reconciliation-skill.test.mjs`
Expected: FAIL. Exactly the 3 copy cases fail: the identical fleet-core copy, the different-bytes copy, and the real-directory deployed copy. They exit 0 instead of 20.

Restore the line to `if (source.reasons.length === 0) {`, then re-run the same command.
Expected: PASS, 11 tests.

- [ ] **Step 11: Run the whole fleet test suite**

Run: `node --test tests/*.test.mjs`
Expected: PASS with 0 failures. The new file adds 19 tests (3 skill + 16 preflight), and every pre-existing test keeps its prior result.

- [ ] **Step 12: Commit**

```bash
git add bin/opencode-model-skill-preflight config/opencode/skills/model-reconciliation-approval/SKILL.md tests/model-reconciliation-skill.test.mjs
git --no-pager diff --cached --stat
git commit -m "feat(opencode): add model-reconciliation approval skill and read-only deployment preflight

The skill is a session surface over opencode-broker-reconcile with no state of
its own; reconcile runs under the provider-expansion flock. The preflight
verifies the skill's devbox source, fleet-core compatibility and deployed
paths are one regular file with matching SHA-256 bytes, exits 20 otherwise,
and never repairs: devbox-sync does that outside the cutover transaction."
```

Expected `--stat` before the commit: exactly 3 files. If anything else is staged, unstage it with `git restore --staged <path>` before committing. Never stage the plan and spec files listed under "NEVER stage" in the contract.

### Task F4a1: Provider-stage script skeleton (lock, shared helpers, preflight)

Repository: `/home/dev/devbox`. Every path below is relative to that repository.

**Files:**
- Create: `bin/opencode-model-provider-stage` (executable)
- Create: `tests/opencode-model-provider-stage.test.sh`

**Interfaces:**
- Consumes:
  - Broker CLI from B5: `opencode-broker-reconcile preflight-topology --json` returns one JSON object on stdout and exits 0 when the topology is OK. This task needs `"ok": true` and a non-empty string `"rawBaseHash"`. It fails closed when either is missing. The key name follows `verify-deployed-config`'s `rawBaseHash`.
  - From F3: the approval skill source `config/opencode/skills/model-reconciliation-approval/SKILL.md`.
  - From F1: `config/opencode-broker/config.json` holds `"reconcile": {"apply": {"providers": ["openai"], ...}}`. Only test 15, which runs against the repo's own config, relies on it.
  - `bin/fleet-notify <title> <body> [priority] [tags]` already exists (it wraps `bin/notify` and never fails its caller).
- Produces (F4a2 and F4b consume these exact names):
  - Script globals: `STATE_ROOT`, `DEVBOX`, `FLEET_CORE`, `OUTER_LINK`, `LOCK`, `BROKER_CONFIG` (`$DEVBOX/config/opencode-broker/config.json`), `DEVBOX_SYNC` (`$FLEET_CORE/bin/devbox-sync`), `NOTIFY_BIN`, `SKILL_SOURCE`, `SKILL_COMPAT`, `SKILL_DEPLOYED`, `SUBCOMMAND` (one of `preflight|cutover|add|gate|rollback-global|rollback-provider`), `SUBCOMMAND_LABEL`, `PROVIDER`, `BROKER_OUT`, `BROKER_RC`, `RAW_BASE_HASH`.
  - `broker_cli <subcommand> [args...]`: runs `${OPENCODE_RECONCILE_CLI:-node /home/dev/opencode-broker/bin/opencode-broker-reconcile}` (split on whitespace) with `"$@" --json`. It sets `BROKER_OUT` (stdout) and `BROKER_RC`, and returns `BROKER_RC`. stderr passes through, and the child inherits fd 9.
  - `broker_require <subcommand> [args...]`: calls `broker_cli`. It returns 0 only when the exit is 0 and `json_is_true "$BROKER_OUT" ok` succeeds (the top-level `ok` is the boolean `true`; the string `"true"` fails). Otherwise it calls `stage_fail 1 ...`.
  - `json_is_true <json-text> <key>`: exit 0 only when the top-level `<key>` is the boolean `true`, else 1.
  - `sysd <args...>`: runs `"${OPENCODE_STAGE_SYSTEMCTL:-systemctl}" --user "$@"` and returns its status.
  - `json_get <json-text> <dotted.path>`: prints a string as-is and anything else as compact JSON. Exit 0 = found, 3 = path missing, 1 = invalid JSON. Array indices are path segments (`a.list.1`).
  - `config_append_provider <config-path> <provider-
id>`: appends exactly one provider to `reconcile.apply.providers` through node. It rewrites the file atomically (temp file in the same directory, fsync, rename), keeps the file mode, and writes 2-space JSON with a trailing newline. Exit 0 = appended. Exit 1 = refused, and the file is left unchanged: the id is malformed, the id is not in `trustedSubscriptionProviders`, the id is already present, the block is missing, or the file cannot be read or written.
  - `stage_notify <title> <body>`: sends a high-priority `warning` push through `$NOTIFY_BIN`. It never fails the caller.
  - `stage_fail <exit-code> <message>`: writes the message to stderr, calls `stage_notify`, then exits with `<exit-code>`.
  - `acquire_lock`: refuses a missing state root, or a lock path that is a symlink or not a regular file. It opens fd 9 under umask 077, runs `chmod 0600 "$LOCK"`, then `flock -w 5 9`. A timeout runs `stage_fail 75`; any other flock error runs `stage_fail 1`. It never deletes the lock.
  - `check_approval_skill` and `run_preflight_checks`. The second runs `broker_require preflight-topology`, sets `RAW_BASE_HASH`, then calls `check_approval_skill`.
  - `cmd_preflight`.
  - Stubs that F4a2 replaces: `cmd_cutover` and `cmd_rollback_global`.
  - Stubs that F4b replaces: `cmd_add <provider>`, `cmd_gate <provider>`, `cmd_rollback_provider <provider>`.
  - All stubs call `not_implemented`, which prints `<label>: not implemented in this task` and exits 2.
  - Exit codes: 0 ok; 1 failed (loud); 2 not implemented; 64 usage error (lock not taken, nothing called); 75 lock held elsewhere.
  - Sourcing guard: running `source bin/opencode-model-provider-stage` defines everything and runs nothing.
  - Test harness, in `tests/opencode-model-provider-stage.test.sh`:
    - Setup and run helpers: `make_sandbox <label>` prints the sandbox root; `broker_reply <root> <subcommand> <rc> <json>`; `run_stage <root> [KEY=VAL...] -- <args...>` sets `RC` and writes `$root/out` and `$root/err`; `run_helper <root> <function> [args...]` sources the script and calls one function, also setting `RC`.
    - Logs: `$root/calls.log` gets one line per call, as `broker <argv> lock=<held|free> fd9=<open|closed>`, `systemctl <argv>` or `devbox-sync <argv>`. `$root/notify.log` gets `title|body|priority|tags` lines, and `$root/node.log` records node invocations.
    - Control files: `$root/broker/<subcommand>.{json,rc}`, `$root/sysd/<verb>[.<unit>].{rc,out}` and `$root/devbox-sync.rc`.
    - Test utilities: `fail`, `run_test`, `HOLDER_PIDS`.
    - `test_unimplemented_subcommands_exit_2`: F4a2 and F4b delete their own entries from its `cases` list.

- [ ] **Step 1: Write the failing test harness and tests**

Create `tests/opencode-model-provider-stage.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for bin/opencode-model-provider-stage (Package 4 provider-expansion orchestrator).
# Each test runs the script under `env -i` in a sandbox: stub systemctl and node on PATH, a stub
# broker CLI via OPENCODE_RECONCILE_CLI, stub devbox-sync and fleet-notify inside a sandbox devbox
# reached through a sandbox fleet-core symlink, and a sandbox state root. Stubs append to
# $root/calls.log (broker, systemctl, devbox-sync), $root/notify.log and $root/node.log.
#
# Usage:
#   bash tests/opencode-model-provider-stage.test.sh            -- run all tests
#   bash tests/opencode-model-provider-stage.test.sh <nameglob> -- run only matching tests
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$REPO_ROOT/bin/opencode-model-provider-stage"
REAL_NODE="$(command -v node)" || { echo "node is required on PATH to run these tests" >&2; exit 1; }
command -v flock >/dev/null || { echo "flock (util-linux) is required to run these tests" >&2; exit 1; }

TEST_ROOT="/tmp/opencode/provider-stage-tests.$$"
rm -rf "$TEST_ROOT"
mkdir -p "$TEST_ROOT"
HOLDER_PIDS=()
cleanup() {
	local p
	for p in "${HOLDER_PIDS[@]}"; do kill "$p" 2>/dev/null; done
	rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

PASSED=0
FAILED=0
FAILED_NAMES=()
CURRENT_TEST=""
RC=0

say() { printf '%s\n' "$*"; }
fail() {
	say "  FAIL: $*"
	FAILED=$((FAILED+1))
	FAILED_NAMES+=("$CURRENT_TEST: $*")
	return 1
}

TEST_FILTER=("$@")
run_test() {
	local name=$1 fn=$2
	if [[ ${#TEST_FILTER[@]} -gt 0 ]]; then
		local keep=0 g
		for g in "${TEST_FILTER[@]}"; do [[ $name == *$g* ]] && keep=1; done
		(( keep )) || return 0
	fi
	CURRENT_TEST="$name"
	say "RUN  $name"
	local before_failed=$FAILED
	"$fn" || true
	if (( FAILED == before_failed )); then
		PASSED=$((PASSED+1))
		say "  OK"
	fi
}

make_sandbox() {
	local root="$TEST_ROOT/$1"
	mkdir -p "$root/bin" "$root/broker" "$root/sysd" "$root/home/.config/opencode" \
		"$root/devbox/bin" "$root/devbox/config/opencode/skills/model-reconciliation-approval" \
		"$root/devbox/config/opencode-broker"
	mkdir -m 0700 "$root/state"
	: >"$root/calls.log"; : >"$root/notify.log"; : >"$root/node.log"
	ln -s "$root/devbox" "$root/fleet-core"
	ln -s "$root/fleet-core/config/opencode/skills" "$root/home/.config/opencode/skills"
	printf '# model-reconciliation-approval test fixture\n' \
		>"$root/devbox/config/opencode/skills/model-reconciliation-approval/SKILL.md"
	cat >"$root/devbox/config/opencode-broker/config.json" <<'JSON'
{
  "trustedSubscriptionProviders": [
    "alibaba-token-plan",
    "anthropic",
    "openai"
  ],
  "reconcile": {
    "apply": {
      "enabled": false,
      "providers": [
        "openai"
      ]
    }
  }
}
JSON
	chmod 0640 "$root/devbox/config/opencode-broker/config.json"

	cat >"$root/bin/broker-stub" <<'EOF'
#!/usr/bin/env bash
# Stub reconcile CLI: records argv, whether the provider-expansion lock is held (a fresh open file
# description conflicts with the stage script's fd 9) and whether fd 9 was inherited.
sub=${1:-}
lock="$OPENCODE_RECONCILE_STATE_ROOT/provider-expansion.lock"
flock -n -E 99 "$lock" true; lrc=$?
if (( lrc == 99 )); then held=held; else held=free; fi
if [[ -e /proc/$$/fd/9 ]]; then fd=open; else fd=closed; fi
printf 'broker %s lock=%s fd9=%s\n' "$*" "$held" "$fd" >>"$STAGE_TEST_ROOT/calls.log"
ctl="$STAGE_TEST_ROOT/broker/$sub"
if [[ -f $ctl.json ]]; then cat "$ctl.json"; else printf '{"ok":true}\n'; fi
if [[ -f $ctl.rc ]]; then exit "$(cat "$ctl.rc")"; fi
exit 0
EOF
	cat >"$root/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$STAGE_TEST_ROOT/calls.log"
args=("$@")
[[ ${args[0]:-} == --user ]] && args=("${args[@]:1}")
verb=${args[0]:-}; unit=${args[1]:-}
d="$STAGE_TEST_ROOT/sysd"
for key in "$verb.$unit" "$verb"; do
	if [[ -f $d/$key.out ]]; then cat "$d/$key.out"; break; fi
done
for key in "$verb.$unit" "$verb"; do
	if [[ -f $d/$key.rc ]]; then exit "$(cat "$d/$key.rc")"; fi
done
exit 0
EOF
	cat >"$root/bin/node" <<'EOF'
#!/usr/bin/env bash
printf 'node\n' >>"$STAGE_TEST_ROOT/node.log"
exec "$STAGE_REAL_NODE" "$@"
EOF
	cat >"$root/devbox/bin/devbox-sync" <<'EOF'
#!/usr/bin/env bash
printf 'devbox-sync %s\n' "$*" >>"$STAGE_TEST_ROOT/calls.log"
if [[ -f $STAGE_TEST_ROOT/devbox-sync.rc ]]; then exit "$(cat "$STAGE_TEST_ROOT/devbox-sync.rc")"; fi
exit 0
EOF
	cat >"$root/devbox/bin/fleet-notify" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s|%s|%s\n' "${1-}" "${2-}" "${3-}" "${4-}" >>"$STAGE_TEST_ROOT/notify.log"
exit 0
EOF
	chmod +x "$root/bin/broker-stub" "$root/bin/systemctl" "$root/bin/node" \
		"$root/devbox/bin/devbox-sync" "$root/devbox/bin/fleet-notify"
	printf '%s\n' "$root"
}

broker_reply() {
	local root=$1 sub=$2 rc=$3 json=$4
	printf '%s\n' "$json" >"$root/broker/$sub.json"
	printf '%s\n' "$rc" >"$root/broker/$sub.rc"
}

SANDBOX_ENV=()
sandbox_env() {
	local root=$1
	SANDBOX_ENV=(
		HOME="$root/home"
		PATH="$root/bin:/usr/bin:/bin"
		STAGE_TEST_ROOT="$root"
		STAGE_REAL_NODE="$REAL_NODE"
		OPENCODE_RECONCILE_STATE_ROOT="$root/state"
		OPENCODE_RECONCILE_DEVBOX="$root/devbox"
		OPENCODE_RECONCILE_FLEET_CORE="$root/fleet-core"
		OPENCODE_RECONCILE_OUTER_LINK="$root/home/.config/opencode/opencode.json"
		OPENCODE_RECONCILE_CLI="$root/bin/broker-stub"
	)
}

# run_stage <root> [KEY=VAL...] -- <args...>
run_stage() {
	local root=$1; shift
	local -a extra=()
	while (( $# )); do
		if [[ $1 == -- ]]; then shift; break; fi
		extra+=("$1"); shift
	done
	sandbox_env "$root"
	RC=0
	env -i "${SANDBOX_ENV[@]}" "${extra[@]}" bash "$STAGE" "$@" >"$root/out" 2>"$root/err" || RC=$?
}

# run_helper <root> <function> [args...] -- sources the script (main guard keeps it inert).
run_helper() {
	local root=$1; shift
	sandbox_env "$root"
	RC=0
	env -i "${SANDBOX_ENV[@]}" bash -c 'source "$1"; shift; "$@"' stage-helper "$STAGE" "$@" \
		>"$root/out" 2>"$root/err" || RC=$?
}

providers_of() {
	CFG="$1" "$REAL_NODE" -e 'const c = JSON.parse(require("fs").readFileSync(process.env.CFG, "utf8")); process.stdout.write(JSON.stringify(c.reconcile.apply.providers));'
}

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

test_usage_errors_exit_64_without_lock() {
	local root; root=$(make_sandbox usage)
	local -a cases=("" "bogus" "preflight extra" "cutover extra" "add" "add OpenAI" "add openai extra"
		"gate" "gate -x" "rollback" "rollback --everything" "rollback --provider"
		"rollback --provider bad_id" "rollback --global extra")
	local c
	for c in "${cases[@]}"; do
		local -a argv=()
		read -r -a argv <<<"$c"
		run_stage "$root" -- "${argv[@]}"
		(( RC == 64 )) || fail "args '$c': expected exit 64, got $RC"
		grep -q 'usage:' "$root/err" || fail "args '$c': no usage text on stderr"
	done
	[[ ! -e $root/state/provider-expansion.lock ]] || fail "a usage error created the lock file"
	[[ ! -s $root/calls.log ]] || fail "a usage error called something: $(cat "$root/calls.log")"
	[[ ! -s $root/notify.log ]] || fail "a usage error notified: $(cat "$root/notify.log")"
}

test_help_exits_0_without_lock() {
	local root; root=$(make_sandbox help)
	run_stage "$root" -- --help
	(( RC == 0 )) || fail "expected exit 0, got $RC"
	grep -q 'usage:' "$root/err" || fail "no usage text on stderr"
	[[ ! -e $root/state/provider-expansion.lock ]] || fail "--help created the lock file"
}

test_unimplemented_subcommands_exit_2() {
	# F4a2 and F4b delete their entries from this list as they implement each subcommand.
	local -a cases=("cutover" "add openai" "gate openai" "rollback --global" "rollback --provider openai")
	local c
	for c in "${cases[@]}"; do
		local root; root=$(make_sandbox "unimpl_$(printf '%s' "$c" | tr -c 'a-z' '_')")
		local -a argv=()
		read -r -a argv <<<"$c"
		run_stage "$root" -- "${argv[@]}"
		(( RC == 2 )) || fail "'$c': expected exit 2, got $RC"
		grep -q 'not implemented in this task' "$root/err" || fail "'$c': stderr was $(cat "$root/err")"
		[[ -f $root/state/provider-expansion.lock ]] || fail "'$c': lock was not acquired before dispatch"
		[[ ! -s $root/calls.log ]] || fail "'$c': called something: $(cat "$root/calls.log")"
	done
}

test_preflight_success_holds_lock_and_is_read_only() {
	local root; root=$(make_sandbox preflight_ok)
	broker_reply "$root" preflight-topology 0 '{"ok":true,"rawBaseHash":"sha256:abc123"}'
	run_stage "$root" -- preflight
	(( RC == 0 )) || fail "expected exit 0, got $RC; stderr: $(cat "$root/err")"
	grep -Fxq 'preflight: ok rawBaseHash=sha256:abc123' "$root/out" || fail "stdout was: $(cat "$root/out")"
	local expected='broker preflight-topology --json lock=held fd9=open'
	[[ $(cat "$root/calls.log") == "$expected" ]] \
		|| fail "calls.log: expected exactly '$expected', got '$(cat "$root/calls.log")'"
	[[ ! -s $root/notify.log ]] || fail "success must not notify: $(cat "$root/notify.log")"
}

test_lock_file_kept_0600_and_released() {
	local root; root=$(make_sandbox lock_mode_existing)
	local lock="$root/state/provider-expansion.lock"
	install -m 0644 /dev/null "$lock"
	broker_reply "$root" preflight-topology 0 '{"ok":true,"rawBaseHash":"sha256:abc123"}'
	run_stage "$root" -- preflight
	(( RC == 0 )) || fail "expected exit 0, got $RC; stderr: $(cat "$root/err")"
	[[ -f $lock ]] || fail "lock file was deleted"
	[[ $(stat -c %a "$lock") == 600 ]] || fail "pre-existing 0644 lock not narrowed: $(stat -c %a "$lock")"
	flock -n -E 99 "$lock" true; local frc=$?
	(( frc == 0 )) || fail "lock still held after the script exited (flock rc $frc)"

	local root2; root2=$(make_sandbox lock_mode_new)
	run_stage "$root2" -- preflight
	[[ $(stat -c %a "$root2/state/provider-expansion.lock") == 600 ]] \
		|| fail "new lock mode is $(stat -c %a "$root2/state/provider-expansion.lock"), expected 600"
}

test_lock_timeout_exits_75_and_notifies() {
	local root; root=$(make_sandbox lock_timeout)
	local lock="$root/state/provider-expansion.lock"
	( exec 8>"$lock"; flock 8; exec sleep 30 ) &
	local holder=$!
	HOLDER_PIDS+=("$holder")
	local i hrc
	for i in $(seq 1 50); do
		flock -n -E 99 "$lock" true; hrc=$?
		(( hrc == 99 )) && break
		sleep 0.1
	done
	(( hrc == 99 )) || fail "test holder never acquired the lock"
	local t0=$SECONDS
	run_stage "$root" -- preflight
	local dt=$((SECONDS - t0))
	kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
	(( RC == 75 )) || fail "expected exit 75, got $RC; stderr: $(cat "$root/err")"
	(( dt >= 4 && dt <= 9 )) || fail "waited ${dt}s, expected about 5s"
	[[ ! -s $root/calls.log ]] || fail "broker was called without the lock: $(cat "$root/calls.log")"
	grep -q 'lock' "$root/notify.log" || fail "no notification naming the lock: $(cat "$root/notify.log")"
	grep -q '|high|' "$root/notify.log" || fail "notification was not high priority"
}

test_symlinked_lock_is_refused() {
	local root; root=$(make_sandbox lock_symlink)
	printf 'keep\n' >"$root/victim"
	ln -s "$root/victim" "$root/state/provider-expansion.lock"
	run_stage "$root" -- preflight
	(( RC == 1 )) || fail "expected exit 1, got $RC"
	[[ $(cat "$root/victim") == keep ]] || fail "symlink target was truncated"
	grep -q 'not a regular file' "$root/err" || fail "stderr was: $(cat "$root/err")"
	[[ ! -s $root/calls.log ]] || fail "broker was called: $(cat "$root/calls.log")"
}

test_preflight_topology_failure_stops_loudly() {
	local root; root=$(make_sandbox topology_fail)
	broker_reply "$root" preflight-topology 20 '{"ok":false,"reason":"outer-link-mismatch"}'
	run_stage "$root" -- preflight
	(( RC == 1 )) || fail "expected exit 1, got $RC"
	grep -q 'preflight-topology' "$root/err" || fail "stderr does not name the step: $(cat "$root/err")"
	grep -q 'outer-link-mismatch' "$root/err" || fail "stderr lacks the broker JSON: $(cat "$root/err")"
	[[ -s $root/notify.log ]] || fail "failure did not notify"
	! grep -q '^preflight: ok' "$root/out" || fail "printed ok after a failure"
}

test_preflight_topology_without_ok_true_fails_closed() {
	local json c=0
	for json in '{"mode":"pre-bootstrap","rawBaseHash":"sha256:x"}' 'not json' '{"ok":true}' '{"ok":"true","rawBaseHash":"sha256:x"}'; do
		c=$((c+1))
		local root; root=$(make_sandbox "topology_closed_$c")
		broker_reply "$root" preflight-topology 0 "$json"
		run_stage "$root" -- preflight
		(( RC == 1 )) || fail "reply '$json' with exit 0: expected exit 1, got $RC"
		[[ -s $root/notify.log ]] || fail "reply '$json': no notification"
	done
}

test_preflight_rejects_missing_deployed_skill() {
	local root; root=$(make_sandbox skill_missing)
	broker_reply "$root" preflight-topology 0 '{"ok":true,"rawBaseHash":"sha256:abc123"}'
	rm "$root/home/.config/opencode/skills"
	ln -s "$root/nowhere" "$root/home/.config/opencode/skills"
	run_stage "$root" -- preflight
	(( RC == 1 )) || fail "expected exit 1, got $RC"
	grep -Fq "$root/home/.config/opencode/skills/model-reconciliation-approval/SKILL.md" "$root/err" \
		|| fail "stderr does not name the deployed path: $(cat "$root/err")"
	grep -q 'devbox-sync' "$root/err" || fail "stderr does not point at devbox-sync repair"
	[[ -s $root/notify.log ]] || fail "failure did not notify"
}

test_preflight_rejects_skill_copy_not_source() {
	local root; root=$(make_sandbox skill_copy)
	broker_reply "$root" preflight-topology 0 '{"ok":true,"rawBaseHash":"sha256:abc123"}'
	rm "$root/home/.config/opencode/skills"
	mkdir -p "$root/home/.config/opencode/skills/model-reconciliation-approval"
	cp "$root/devbox/config/opencode/skills/model-reconciliation-approval/SKILL.md" \
		"$root/home/.config/opencode/skills/model-reconciliation-approval/SKILL.md"
	run_stage "$root" -- preflight
	(( RC == 1 )) || fail "identical-bytes copy accepted: expected exit 1, got $RC"
	grep -q 'resolves to' "$root/err" || fail "stderr was: $(cat "$root/err")"
}

test_json_get() {
	local root; root=$(make_sandbox json_get)
	local doc='{"ok":true,"a":{"b":"text","n":3,"list":["x","y"]},"o":{"k":1}}'
	local -a cases=("ok=true" "a.b=text" "a.n=3" "a.list.1=y" 'o={"k":1}')
	local c
	for c in "${cases[@]}"; do
		run_helper "$root" json_get "$doc" "${c%%=*}"
		(( RC == 0 )) || fail "path ${c%%=*}: exit $RC"
		[[ $(cat "$root/out") == "${c#*=}" ]] || fail "path ${c%%=*}: got '$(cat "$root/out")', want '${c#*=}'"
	done
	run_helper "$root" json_get "$doc" missing.path
	(( RC == 3 )) || fail "missing path: expected exit 3, got $RC"
	run_helper "$root" json_get 'not json' ok
	(( RC == 1 )) || fail "invalid JSON: expected exit 1, got $RC"
	[[ -s $root/node.log ]] || fail "json_get did not run through node"
}

test_config_append_provider_appends_exactly_one() {
	local root; root=$(make_sandbox cfg_append)
	local cfg="$root/devbox/config/opencode-broker/config.json"
	run_helper "$root" config_append_provider "$cfg" anthropic
	(( RC == 0 )) || fail "expected exit 0, got $RC; stderr: $(cat "$root/err")"
	[[ $(providers_of "$cfg") == '["openai","anthropic"]' ]] || fail "providers: $(providers_of "$cfg")"
	[[ $(stat -c %a "$cfg") == 640 ]] || fail "mode changed to $(stat -c %a "$cfg")"
	[[ -z $(tail -c1 "$cfg") ]] || fail "no trailing newline"
	if compgen -G "$(dirname "$cfg")/.config.json.stage-*" >/dev/null; then fail "temp file left behind"; fi
}

test_config_append_provider_refusals_leave_file_untouched() {
	local root; root=$(make_sandbox cfg_refuse)
	local cfg="$root/devbox/config/opencode-broker/config.json"
	local before; before=$(sha256sum "$cfg")
	local -a cases=("openai:already in reconcile.apply.providers" "mistral:not in trustedSubscriptionProviders" "Bad_ID:malformed provider id")
	local c
	for c in "${cases[@]}"; do
		run_helper "$root" config_append_provider "$cfg" "${c%%:*}"
		(( RC == 1 )) || fail "'${c%%:*}': expected exit 1, got $RC"
		grep -q "${c#*:}" "$root/err" || fail "'${c%%:*}': stderr was $(cat "$root/err")"
		[[ $(sha256sum "$cfg") == "$before" ]] || fail "'${c%%:*}': config bytes changed"
	done
	printf '{"trustedSubscriptionProviders":["openai"]}\n' >"$root/noblock.json"
	run_helper "$root" config_append_provider "$root/noblock.json" openai
	(( RC == 1 )) || fail "missing reconcile block: expected exit 1, got $RC"
	grep -q 'reconcile.apply.providers is missing' "$root/err" || fail "stderr was: $(cat "$root/err")"
}

test_config_append_provider_on_repo_config() {
	local root; root=$(make_sandbox cfg_repo)
	cp "$REPO_ROOT/config/opencode-broker/config.json" "$root/repo-config.json"
	run_helper "$root" config_append_provider "$root/repo-config.json" anthropic
	(( RC == 0 )) || fail "expected exit 0 on the repo config, got $RC; stderr: $(cat "$root/err")"
	ORIG="$REPO_ROOT/config/opencode-broker/config.json" NEW="$root/repo-config.json" "$REAL_NODE" -e '
const fs = require("fs");
const orig = JSON.parse(fs.readFileSync(process.env.ORIG, "utf8"));
const next = JSON.parse(fs.readFileSync(process.env.NEW, "utf8"));
const p = next.reconcile.apply.providers;
if (p[p.length - 1] !== "anthropic") { console.error("last provider is not anthropic"); process.exit(1); }
p.pop();
if (JSON.stringify(orig) !== JSON.stringify(next)) { console.error("config changed beyond the appended provider"); process.exit(1); }
' || fail "repo config rewrite changed more than reconcile.apply.providers"
}

test_sysd_wrapper() {
	local root; root=$(make_sandbox sysd)
	printf '3\n' >"$root/sysd/is-active.opencode-model-reconcile.timer.rc"
	printf 'inactive\n' >"$root/sysd/is-active.opencode-model-reconcile.timer.out"
	run_helper "$root" sysd is-active opencode-model-reconcile.timer
	(( RC == 3 )) || fail "expected systemctl exit 3 to propagate, got $RC"
	[[ $(cat "$root/out") == inactive ]] || fail "stdout was: $(cat "$root/out")"
	[[ $(cat "$root/calls.log") == 'systemctl --user is-active opencode-model-reconcile.timer' ]] \
		|| fail "calls.log: $(cat "$root/calls.log")"
}

# ---------------------------------------------------------------------------
# Run everything
# ---------------------------------------------------------------------------

run_test usage-errors-exit-64-without-lock             test_usage_errors_exit_64_without_lock
run_test help-exits-0-without-lock                     test_help_exits_0_without_lock
run_test unimplemented-subcommands-exit-2              test_unimplemented_subcommands_exit_2
run_test preflight-success-holds-lock-and-is-read-only test_preflight_success_holds_lock_and_is_read_only
run_test lock-file-kept-0600-and-released              test_lock_file_kept_0600_and_released
run_test lock-timeout-exits-75-and-notifies            test_lock_timeout_exits_75_and_notifies
run_test symlinked-lock-is-refused                     test_symlinked_lock_is_refused
run_test preflight-topology-failure-stops-loudly       test_preflight_topology_failure_stops_loudly
run_test preflight-topology-without-ok-fails-closed    test_preflight_topology_without_ok_true_fails_closed
run_test preflight-rejects-missing-deployed-skill      test_preflight_rejects_missing_deployed_skill
run_test preflight-rejects-skill-copy-not-source       test_preflight_rejects_skill_copy_not_source
run_test json-get                                      test_json_get
run_test config-append-provider-appends-exactly-one    test_config_append_provider_appends_exactly_one
run_test config-append-provider-refusals               test_config_append_provider_refusals_leave_file_untouched
run_test config-append-provider-on-repo-config         test_config_append_provider_on_repo_config
run_test sysd-wrapper                                  test_sysd_wrapper

echo
echo "passed: $PASSED  failed: $FAILED"
if (( FAILED > 0 )); then
	printf 'failures:\n'; printf '  - %s\n' "${FAILED_NAMES[@]}"
	exit 1
fi
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run (from `/home/dev/devbox`): `bash tests/opencode-model-provider-stage.test.sh`
Expected: exit 1, ending with `passed: 0  failed: 16`. Every test fails because `bin/opencode-model-provider-stage` does not exist yet. Each `run_stage` gets RC 127 from `bash: .../opencode-model-provider-stage: No such file or directory`, and each `source` in `run_helper` fails the same way.

- [ ] **Step 3: Write the script**

Create `bin/opencode-model-provider-stage`:

```bash
#!/usr/bin/env bash
# opencode-model-provider-stage -- Package 4 provider-expansion lock holder and orchestrator.
#
#   opencode-model-provider-stage preflight
#   opencode-model-provider-stage cutover
#   opencode-model-provider-stage add <provider>
#   opencode-model-provider-stage gate <provider>
#   opencode-model-provider-stage rollback --global
#   opencode-model-provider-stage rollback --provider <provider>
#
# Every subcommand (not --help) first takes the provider-expansion lock
# ($STATE_ROOT/provider-expansion.lock, mode 0600) on fd 9 with `flock -w 5` and holds it for the
# whole run; the kernel releases it when this process exits. The scheduled reconcile and watch
# units run under `flock -n -E 5` on the same file, so while this script runs they exit 5 (quiet)
# without doing work. Broker CLI calls inherit fd 9 and never take the lock themselves.
# NEVER delete the lock file: a persistent inode is harmless and ownership is the kernel's.
#
# Exit codes: 0 ok; 1 a check or step failed (loud notify); 2 subcommand not implemented yet;
# 64 usage error (lock not taken, nothing called); 75 lock held elsewhere for 5s (loud notify).
#
# Environment overrides (tests): OPENCODE_RECONCILE_STATE_ROOT, OPENCODE_RECONCILE_DEVBOX,
# OPENCODE_RECONCILE_FLEET_CORE, OPENCODE_RECONCILE_OUTER_LINK, OPENCODE_RECONCILE_CLI (a command
# line split on whitespace, so its path must not contain spaces), OPENCODE_STAGE_SYSTEMCTL.
set -uo pipefail

STATE_ROOT="${OPENCODE_RECONCILE_STATE_ROOT:-/home/dev/.local/share/opencode/model-routing}"
DEVBOX="${OPENCODE_RECONCILE_DEVBOX:-/home/dev/devbox}"
FLEET_CORE="${OPENCODE_RECONCILE_FLEET_CORE:-/home/dev/fleet-core}"
OUTER_LINK="${OPENCODE_RECONCILE_OUTER_LINK:-/home/dev/.config/opencode/opencode.json}"
LOCK="$STATE_ROOT/provider-expansion.lock"
BROKER_CONFIG="$DEVBOX/config/opencode-broker/config.json"
DEVBOX_SYNC="$FLEET_CORE/bin/devbox-sync"
NOTIFY_BIN="$FLEET_CORE/bin/fleet-notify"
SKILL_REL="config/opencode/skills/model-reconciliation-approval/SKILL.md"
SKILL_SOURCE="$DEVBOX/$SKILL_REL"
SKILL_COMPAT="$FLEET_CORE/$SKILL_REL"
SKILL_DEPLOYED="$(dirname "$OUTER_LINK")/skills/model-reconciliation-approval/SKILL.md"

SUBCOMMAND=""
SUBCOMMAND_LABEL="opencode-model-provider-stage"
PROVIDER=""
BROKER_OUT=""
BROKER_RC=0
RAW_BASE_HASH=""

usage() {
	cat >&2 <<'USAGE'
usage: opencode-model-provider-stage preflight
       opencode-model-provider-stage cutover
       opencode-model-provider-stage add <provider>
       opencode-model-provider-stage gate <provider>
       opencode-model-provider-stage rollback --global
       opencode-model-provider-stage rollback --provider <provider>
USAGE
}

usage_error() {
	printf 'opencode-model-provider-stage: %s\n' "$1" >&2
	usage
	exit 64
}

# Same shape as the trusted provider IDs in config/opencode-broker/config.json
# ("alibaba-token-plan", "anthropic", "openai"); the broker re-validates membership at startup.
valid_provider_id() {
	[[ $1 =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
}

parse_args() {
	(( $# >= 1 )) || usage_error "missing subcommand"
	case $1 in
		-h|--help|help)
			usage
			exit 0 ;;
		preflight|cutover)
			(( $# == 1 )) || usage_error "$1 takes no arguments"
			SUBCOMMAND=$1 ;;
		add|gate)
			(( $# == 2 )) || usage_error "$1 requires exactly one <provider>"
			valid_provider_id "$2" || usage_error "malformed provider id: $2"
			SUBCOMMAND=$1
			PROVIDER=$2 ;;
		rollback)
			if (( $# == 2 )) && [[ $2 == --global ]]; then
				SUBCOMMAND=rollback-global
			elif (( $# == 3 )) && [[ $2 == --provider ]]; then
				valid_provider_id "$3" || usage_error "malformed provider id: $3"
				SUBCOMMAND=rollback-provider
				PROVIDER=$3
			else
				usage_error "rollback requires --global or --provider <provider>"
			fi ;;
		*)
			usage_error "unknown subcommand: $1" ;;
	esac
	SUBCOMMAND_LABEL="$*"
}

# stage_notify <title> <body>: loud push through the fleet notifier. Never fails the caller;
# its stdout goes to stderr so this script's stdout stays machine-readable.
stage_notify() {
	local rc=0
	"$NOTIFY_BIN" "$1" "$2" high warning >&2 || rc=$?
	if (( rc != 0 )); then
		printf 'opencode-model-provider-stage: notify via %s failed (exit %d)\n' "$NOTIFY_BIN" "$rc" >&2
	fi
	return 0
}

# stage_fail <exit-code> <message>
stage_fail() {
	local code=$1 msg=$2
	printf 'opencode-model-provider-stage %s: FAILED: %s\n' "$SUBCOMMAND_LABEL" "$msg" >&2
	stage_notify "model provider stage: $SUBCOMMAND_LABEL failed" "$msg"
	exit "$code"
}

not_implemented() {
	printf 'opencode-model-provider-stage: %s: not implemented in this task\n' "$SUBCOMMAND_LABEL" >&2
	exit 2
}

# acquire_lock: fd 9 on $LOCK for the rest of the process lifetime. The timer units' flock(1)
# may have created the file with mode 0644 first, so the mode is narrowed after every open.
acquire_lock() {
	local old_umask rc=0
	[[ -d $STATE_ROOT ]] \
		|| stage_fail 1 "state root $STATE_ROOT does not exist; deploy the broker first"
	if [[ -L $LOCK ]] || { [[ -e $LOCK ]] && [[ ! -f $LOCK ]]; }; then
		stage_fail 1 "lock path $LOCK exists but is not a regular file; refusing to open it (inspect it by hand, never delete a live lock)"
	fi
	old_umask=$(umask)
	umask 077
	if ! exec 9>"$LOCK"; then
		umask "$old_umask"
		stage_fail 1 "cannot open lock file $LOCK"
	fi
	umask "$old_umask"
	chmod 0600 "$LOCK" || stage_fail 1 "cannot set mode 0600 on $LOCK"
	flock -w 5 9 || rc=$?
	if (( rc == 1 )); then
		stage_fail 75 "provider-expansion lock $LOCK is held by another process (waited 5s); another stage run or a scheduled reconcile is active"
	elif (( rc != 0 )); then
		stage_fail 1 "flock on $LOCK failed with exit $rc"
	fi
}

# broker_cli <subcommand> [args...]: sets BROKER_OUT and BROKER_RC, returns BROKER_RC.
broker_cli() {
	local -a cli=()
	read -r -a cli <<<"${OPENCODE_RECONCILE_CLI:-node /home/dev/opencode-broker/bin/opencode-broker-reconcile}"
	printf 'opencode-model-provider-stage: broker %s --json\n' "$*" >&2
	BROKER_RC=0
	BROKER_OUT="$("${cli[@]}" "$@" --json)" || BROKER_RC=$?
	return "$BROKER_RC"
}

# broker_require <subcommand> [args...]: exit 0 AND "ok": true, or stage_fail 1. Fails closed on
# any reply without a boolean true "ok".
broker_require() {
	local ok="" rc=0
	broker_cli "$@"
	if (( BROKER_RC != 0 )); then
		stage_fail 1 "broker $* exited $BROKER_RC: $BROKER_OUT"
	fi
	# json_get prints the string "true" and the boolean true identically, so the boolean is
	# checked strictly in JavaScript.
	json_is_true "$BROKER_OUT" ok || rc=$?
	if (( rc != 0 )); then
		ok="$(json_get "$BROKER_OUT" ok 2>/dev/null)" || true
		stage_fail 1 "broker $* exited 0 without a boolean \"ok\": true (ok=${ok:-<missing>}): $BROKER_OUT"
	fi
}

# json_is_true <json-text> <key>: exit 0 only when the top-level <key> is the boolean true.
json_is_true() {
	JSON_GET_TEXT="$1" JSON_GET_PATH="$2" node -e '
let value;
try {
  value = JSON.parse(process.env.JSON_GET_TEXT);
} catch {
  process.exit(1);
}
process.exit(value !== null && typeof value === "object" && value[process.env.JSON_GET_PATH] === true ? 0 : 1);
'
}

sysd() {
	printf 'opencode-model-provider-stage: systemctl --user %s\n' "$*" >&2
	"${OPENCODE_STAGE_SYSTEMCTL:-systemctl}" --user "$@"
}

# json_get <json-text> <dotted.path>: exit 0 found, 3 path missing, 1 not valid JSON.
# Values travel through the environment so no shell quoting reaches the JavaScript.
json_get() {
	JSON_GET_TEXT="$1" JSON_GET_PATH="$2" node -e '
const text = process.env.JSON_GET_TEXT;
const path = process.env.JSON_GET_PATH;
let value;
try {
  value = JSON.parse(text);
} catch (err) {
  process.stderr.write("json_get: not valid JSON: " + err.message + "\n");
  process.exit(1);
}
for (const key of path.split(".")) {
  if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) {
    process.exit(3);
  }
  value = value[key];
}
process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
'
}

# config_append_provider <config-path> <provider-id>: exit 0 appended, 1 refused (file untouched).
config_append_provider() {
	STAGE_CFG_PATH="$1" STAGE_CFG_PROVIDER="$2" node -e '
const fs = require("fs");
const path = require("path");
const file = process.env.STAGE_CFG_PATH;
const provider = process.env.STAGE_CFG_PROVIDER;
function refuse(msg) {
  process.stderr.write("config_append_provider: " + msg + "\n");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(provider)) refuse("malformed provider id " + JSON.stringify(provider));
let st;
let cfg;
try { st = fs.lstatSync(file); } catch (err) { refuse("cannot stat " + file + ": " + err.message); }
if (!st.isFile()) refuse(file + " is not a regular file");
try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { refuse("cannot parse " + file + ": " + err.message); }
const trusted = cfg.trustedSubscriptionProviders;
if (!Array.isArray(trusted) || !trusted.includes(provider)) refuse(provider + " is not in trustedSubscriptionProviders");
const apply = cfg.reconcile && cfg.reconcile.apply;
if (!apply || !Array.isArray(apply.providers)) refuse("reconcile.apply.providers is missing or not an array in " + file);
if (apply.providers.includes(provider)) refuse(provider + " is already in reconcile.apply.providers");
apply.providers.push(provider);
const tmp = path.join(path.dirname(file), "." + path.basename(file) + ".stage-" + process.pid);
try {
  const fd = fs.openSync(tmp, "wx", 0o600);
  fs.fchmodSync(fd, st.mode & 0o777);
  fs.writeSync(fd, JSON.stringify(cfg, null, 2) + "\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
} catch (err) {
  try {
    fs.unlinkSync(tmp);
  } catch (cleanupErr) {
    if (cleanupErr.code !== "ENOENT") process.stderr.write("config_append_provider: temp cleanup failed: " + cleanupErr.message + "\n");
  }
  refuse("write failed: " + err.message);
}
'
}

# check_approval_skill: source, compatibility and deployed paths must all exist, be readable,
# resolve to the one regular source file, and hash identically (spec Step 0). Identical bytes in
# a separate file are rejected: they would silently drift on the next edit.
check_approval_skill() {
	local src_real src_sum path real sum
	if [[ -L $SKILL_SOURCE || ! -f $SKILL_SOURCE || ! -r $SKILL_SOURCE ]]; then
		stage_fail 1 "approval skill source $SKILL_SOURCE must be a readable regular file, not a symlink"
	fi
	src_real="$(readlink -f -- "$SKILL_SOURCE")" || stage_fail 1 "cannot resolve $SKILL_SOURCE"
	src_sum="$(sha256sum -- "$SKILL_SOURCE")" || stage_fail 1 "cannot hash $SKILL_SOURCE"
	src_sum=${src_sum%% *}
	for path in "$SKILL_COMPAT" "$SKILL_DEPLOYED"; do
		if [[ ! -e $path ]]; then
			stage_fail 1 "approval skill path $path is missing or a broken link; run devbox-sync to repair the skills symlink, then re-run preflight (never during a cutover)"
		fi
		[[ -r $path ]] || stage_fail 1 "approval skill path $path is not readable"
		real="$(readlink -f -- "$path")" || stage_fail 1 "cannot resolve $path"
		if [[ $real != "$src_real" ]]; then
			stage_fail 1 "approval skill path $path resolves to $real, not to the source file $src_real"
		fi
		sum="$(sha256sum -- "$path")" || stage_fail 1 "cannot hash $path"
		sum=${sum%% *}
		[[ $sum == "$src_sum" ]] || stage_fail 1 "approval skill path $path has SHA-256 $sum, source has $src_sum"
	done
}

# run_preflight_checks: spec Step 0. Read-only: no systemctl, no devbox-sync, no config writes.
run_preflight_checks() {
	local rc=0
	broker_require preflight-topology
	RAW_BASE_HASH="$(json_get "$BROKER_OUT" rawBaseHash)" || rc=$?
	if (( rc != 0 )) || [[ -z $RAW_BASE_HASH ]]; then
		stage_fail 1 "preflight-topology reported ok but no rawBaseHash: $BROKER_OUT"
	fi
	check_approval_skill
}

cmd_preflight() {
	run_preflight_checks
	printf 'preflight: ok rawBaseHash=%s\n' "$RAW_BASE_HASH"
}

# Replaced by Task F4a2.
cmd_cutover() { not_implemented; }
cmd_rollback_global() { not_implemented; }
# Replaced by Task F4b.
cmd_add() { not_implemented; }
cmd_gate() { not_implemented; }
cmd_rollback_provider() { not_implemented; }

main() {
	parse_args "$@"
	acquire_lock
	case $SUBCOMMAND in
		preflight) cmd_preflight ;;
		cutover) cmd_cutover ;;
		add) cmd_add "$PROVIDER" ;;
		gate) cmd_gate "$PROVIDER" ;;
		rollback-global) cmd_rollback_global ;;
		rollback-provider) cmd_rollback_provider "$PROVIDER" ;;
	esac
}

# Sourcing (tests) defines the functions and runs nothing.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	main "$@"
fi
```

Then run:

```bash
chmod +x bin/opencode-model-provider-stage
bash -n bin/opencode-model-provider-stage
```

Expected: no output, exit 0.

- [ ] **Step 4: Run the tests to confirm they pass**

Run (from `/home/dev/devbox`): `bash tests/opencode-model-provider-stage.test.sh`
Expected: exit 0, ending with `passed: 16  failed: 0`. The run takes about 6-8 seconds, because the lock-timeout test waits out the real 5-second `flock -w 5`.

To confirm the lock-held assertion has teeth, the implementer comments out the `flock -w 5 9 || rc=$?` line and runs `bash tests/opencode-model-provider-stage.test.sh preflight-success lock-timeout`. Expected: FAIL. `calls.log` shows `lock=free`, and the timeout test gets exit 0 instead of 75. The implementer then restores the line and re-runs the full suite to get `passed: 16  failed: 0` again.

- [ ] **Step 5: Commit**

```bash
git -C /home/dev/devbox add bin/opencode-model-provider-stage tests/opencode-model-provider-stage.test.sh
git -C /home/dev/devbox commit -m "feat(provider-stage): add lock-holding stage script skeleton with preflight

bin/opencode-model-provider-stage takes the provider-expansion lock on fd 9
(flock -w 5, mode 0600, never deleted) for its whole run, parses all six
subcommands, and implements preflight (broker preflight-topology plus the
approval-skill same-file/SHA-256 check). Shared helpers broker_cli,
broker_require, sysd, json_get, config_append_provider and stage_notify are
in place for the cutover, add, gate and rollback subcommands."
```

### Task F4a2: Provider-stage `cutover` and `rollback --global`

**Files:**
- Modify: `bin/opencode-model-provider-stage`. Replace the F4a1 stub functions `cmd_cutover()` and `cmd_rollback_global()`, which currently `exit 2` with "not implemented in this task". Insert the new helpers directly above `cmd_cutover()`.
- Create: `tests/opencode-model-provider-stage-cutover.test.sh`

All paths are relative to `/home/dev/devbox`.

**Interfaces:**
- Consumes (from F4a1, by exact name):
   - `broker_cli <subcommand> [args...]` runs `${OPENCODE_RECONCILE_CLI:-node /home/dev/opencode-broker/bin/opencode-broker-reconcile} "$@" --json`. It stores stdout in global `BROKER_OUT` and returns the CLI's exit status. It does not exit the script. Call as `rc=0; broker_cli ... || rc=$?; X=$BROKER_OUT` (never inside `$(...)`). F4a2 has no `stage_deployed_mode` helper: each place that needs the deployed mode runs `rc=0; broker_cli verify-deployed-config || rc=$?; mode=$(json_get "$BROKER_OUT" mode)` inline.
   - `sysd <systemctl args...>` runs `systemctl --user "$@"` (resolved through `PATH`) and returns its status.
   - `stage_notify <title> <body>` runs `$NOTIFY_BIN` (`$FLEET_CORE/bin/fleet-notify`), so a test sandbox supplies a logging `fleet-notify` under its own fleet-core tree.
   - `cmd_preflight` runs topology and approval-skill preflight. It returns or exits nonzero on failure.
   - Lock: before dispatch, F4a1 has already run `exec 9>"$LOCK"; chmod 0600 "$LOCK"; flock -w 5 9`, with `LOCK=$OPENCODE_RECONCILE_STATE_ROOT/provider-expansion.lock`.
   - Dispatch: `cutover` goes to `cmd_cutover`, and `rollback --global` goes to `cmd_rollback_global`.
- Consumes (broker CLI, contract B5-B8): `verify-deployed-config`, `bootstrap-generation-zero`, `scheduled-run`, `import-legacy-ledger --baseline|--final`, `record-legacy-quiesced`, `cutover-config`, `rollback-config --raw-emergency`, `prepare|commit|canary|gate-start --provider <id>`. Exit 0 means success. Any other exit, including 5, is a failure for a manual stage step. `verify-deployed-config` output carries `ok` and `mode`. `scheduled-run` output carries `mode`.
- Consumes (contract env): `OPENCODE_RECONCILE_STATE_ROOT`, `OPENCODE_RECONCILE_RAW_BASE`, `OPENCODE_RECONCILE_OUTER_LINK`, `OPENCODE_RECONCILE_DEVBOX`, `OPENCODE_RECONCILE_FLEET_CORE`, `OPENCODE_RECONCILE_CLI`.
- Produces (F4b may use these by exact name):
   - `cmd_cutover`
   - `cmd_rollback_global`
   - `cutover_fail <step> <message>`: prints to stderr, calls `stage_notify`, re-enables the old watch timer if `STAGE_RESTORE_WATCH=1`, then exits 1.
   - `stage_broker_step <step> <subcommand> [args...]`: sets global `STAGE_OUT`. Calls `cutover_fail` if the exit status is not 0 or the output is not a JSON object.
   - `stage_json_field <dotted.key|.>`: reads stdin and prints a string raw or anything else as JSON. With `.` it only validates that the input is an object. Exit 3 means the input is not a JSON object; exit 4 means the key is missing.
   - `stage_await_inactive <unit>`: returns 0 once the unit is inactive, or 1 after `OPENCODE_STAGE_QUIESCE_TRIES` (default 60) checks spaced `OPENCODE_STAGE_QUIESCE_SLEEP` (default 1) seconds apart.
  - `restart_broker_gateway <step>`
   - `config_apply_enabled <check|true|false>`: atomic, canonical-only rewrite of `reconcile.apply.enabled` in `$OPENCODE_RECONCILE_DEVBOX/config/opencode-broker/config.json`.
   - `stage_fingerprint`
   - Globals: `STAGE_ACTION`, `STAGE_OUT`, `STAGE_RESTORE_WATCH`, `STAGE_HINT`.
  - Exit status: 0 on success, 1 on any refused or failed step.

- [ ] **Step 1: Write the failing test**

Create `tests/opencode-model-provider-stage-cutover.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for `opencode-model-provider-stage cutover` and `rollback --global`.
# Every run uses a sandbox: stub broker CLI (OPENCODE_RECONCILE_CLI), stub systemctl,
# devbox-sync and notify on PATH, and contract env overrides for every live path, so
# nothing touches real units, the real ledger, or ntfy. Real node and flock are used.
# Each stub appends one line per call to calls.log; the broker stub also records whether
# the expansion lock was held by someone else at that moment (lock=held|free).
#
# Usage:
#   bash tests/opencode-model-provider-stage-cutover.test.sh            -- run all tests
#   bash tests/opencode-model-provider-stage-cutover.test.sh <nameglob> -- run matching tests
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$REPO_ROOT/bin/opencode-model-provider-stage"

TEST_ROOT="/tmp/opencode/provider-stage-cutover-tests.$$"
rm -rf "$TEST_ROOT"
mkdir -p "$TEST_ROOT"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASSED=0
FAILED=0
FAILED_NAMES=()
CURRENT_TEST=""

say() { printf '%s\n' "$*"; }
fail() {
	say "  FAIL: $*"
	FAILED=$((FAILED+1))
	FAILED_NAMES+=("$CURRENT_TEST: $*")
	return 1
}

TEST_FILTER=("$@")
run_test() {
	local name=$1 fn=$2
	if [[ ${#TEST_FILTER[@]} -gt 0 ]]; then
		local keep=0 g
		for g in "${TEST_FILTER[@]}"; do
			[[ $name == *$g* ]] && keep=1
		done
		(( keep )) || return 0
	fi
	CURRENT_TEST="$name"
	say "RUN  $name"
	local before_failed=$FAILED
	"$fn" || true
	if (( FAILED == before_failed )); then
		PASSED=$((PASSED+1))
		say "  OK"
	fi
}

write_canonical_config() { # <enabled true|false>
	cat > "$SB/devbox/config/opencode-broker/config.json" <<EOF
{
  "reconcile": {
    "apply": {
      "enabled": $1,
      "providers": [
        "openai"
      ]
    }
  },
  "watch": {
    "notifyCommand": [
      "/bin/true"
    ]
  }
}
EOF
}

make_sandbox() {
	SB="$TEST_ROOT/$1"
	mkdir -p "$SB/bin" "$SB/units" "$SB/state" "$SB/home/.config/opencode" \
		"$SB/devbox/bin" \
		"$SB/devbox/config/opencode/skills/model-reconciliation-approval" \
		"$SB/devbox/config/opencode-broker"
	chmod 0700 "$SB/state"
	ln -s "$SB/devbox" "$SB/fleet-core"
	printf '{\n  "model": "openai/gpt-x"\n}\n' > "$SB/devbox/config/opencode/opencode.json"
	chmod 0600 "$SB/devbox/config/opencode/opencode.json"
	ln -s "$SB/fleet-core/config/opencode/opencode.json" "$SB/home/.config/opencode/opencode.json"
	printf '# model reconciliation approval\n' \
		> "$SB/devbox/config/opencode/skills/model-reconciliation-approval/SKILL.md"
	ln -s "$SB/fleet-core/config/opencode/skills" "$SB/home/.config/opencode/skills"
	write_canonical_config false
	printf '{\n  "reviewed": []\n}\n' > "$SB/state/reviewed-models.json"
	printf 'pre-bootstrap\n' > "$SB/mode"
	touch "$SB/units/opencode-model-watch.timer"   # the old watch timer starts enabled
	: > "$SB/calls.log"

	cat > "$SB/bin/stub-broker" <<'EOF'
#!/usr/bin/env bash
sb=$STUB_SB
lock="$OPENCODE_RECONCILE_STATE_ROOT/provider-expansion.lock"
# A fresh open of the lock file conflicts with the stage script's fd 9 lock.
if flock -n "$lock" true 2>/dev/null; then held=free; else held=held; fi
printf 'broker %s lock=%s\n' "$*" "$held" >> "$sb/calls.log"
args="$*"
if [[ -n ${STUB_FAIL_AT:-} && ${args% --json} == "$STUB_FAIL_AT" ]]; then
	printf '{"ok":false,"reason":"stub-injected-failure"}\n'
	exit 20
fi
mode=$(cat "$sb/mode")
case "$1" in
	preflight-topology)
		# F4a1's preflight requires a rawBaseHash beside "ok": true.
		printf '{"ok":true,"rawBaseHash":"%064d"}\n' 0
		exit 0 ;;
	verify-deployed-config)
		if [[ $mode == invalid ]]; then printf '{"ok":false,"mode":"invalid"}\n'; exit 20; fi
		printf '{"ok":true,"mode":"%s","expectedTarget":"t","actualTarget":"t","generation":0,"registryHash":"r","manifestHash":"m","rawBaseHash":"b","ledgerRevision":1}\n' "$mode"
		exit 0 ;;
	scheduled-run)
		if [[ ${STUB_DRYRUN_TOUCH:-0} == 1 ]]; then printf '\n' >> "$OPENCODE_RECONCILE_RAW_BASE"; fi
		# B8 nests the run mode under "run" (contract v2).
		printf '{"ok":true,"run":{"mode":"dry-run"}}\n'
		exit 0 ;;
	cutover-config) printf 'generated\n' > "$sb/mode" ;;
	rollback-config) [[ $2 == --raw-emergency ]] && printf 'raw-emergency\n' > "$sb/mode" ;;
esac
printf '{"ok":true}\n'
EOF

	cat > "$SB/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
sb=$STUB_SB
printf 'systemctl %s\n' "$*" >> "$sb/calls.log"
[[ ${1:-} == --user ]] && shift
if [[ -n ${STUB_SYSTEMCTL_FAIL:-} && "$*" == "$STUB_SYSTEMCTL_FAIL" ]]; then exit 1; fi
verb=$1; shift
unit=${!#}
case "$verb" in
	is-active)
		if [[ $unit == "${STUB_STUCK_UNIT:-none}" ]]; then exit 0; fi
		case "$unit" in opencode-model-broker.service|opencode-gateway.service) exit 0 ;; esac
		exit 3 ;;
	is-enabled)
		if [[ -e $sb/units/$unit ]]; then echo enabled; exit 0; fi
		echo disabled; exit 1 ;;
	enable) touch "$sb/units/$unit" ;;
	disable) rm -f "$sb/units/$unit" ;;
	start|stop|restart) ;;
	*) echo "stub systemctl: unexpected verb $verb" >&2; exit 64 ;;
esac
exit 0
EOF

	cat > "$SB/bin/devbox-sync" <<'EOF'
#!/usr/bin/env bash
printf 'devbox-sync %s\n' "$*" >> "$STUB_SB/calls.log"
EOF

	# F4a1's stage_notify runs $OPENCODE_RECONCILE_FLEET_CORE/bin/fleet-notify; the sandbox
	# fleet-core is a symlink to the sandbox devbox, so the logging notifier lives there.
	cat > "$SB/devbox/bin/fleet-notify" <<'EOF'
#!/usr/bin/env bash
printf 'notify %s\n' "${1-}" >> "$STUB_SB/calls.log"
EOF
	chmod +x "$SB/bin/stub-broker" "$SB/bin/systemctl" "$SB/bin/devbox-sync" "$SB/devbox/bin/fleet-notify"
}

run_stage() {
	(
		export HOME="$SB/home" PATH="$SB/bin:$PATH" STUB_SB="$SB" \
			OPENCODE_RECONCILE_STATE_ROOT="$SB/state" \
			OPENCODE_RECONCILE_RAW_BASE="$SB/devbox/config/opencode/opencode.json" \
			OPENCODE_RECONCILE_OUTER_LINK="$SB/home/.config/opencode/opencode.json" \
			OPENCODE_RECONCILE_COMPAT_RAW="$SB/fleet-core/config/opencode/opencode.json" \
			OPENCODE_RECONCILE_FLEET_CORE="$SB/fleet-core" \
			OPENCODE_RECONCILE_DEVBOX="$SB/devbox" \
			OPENCODE_RECONCILE_CLI="$SB/bin/stub-broker" \
			OPENCODE_STAGE_QUIESCE_SLEEP=0
		"$STAGE" "$@"
	) > "$SB/stdout" 2> "$SB/stderr"
	STAGE_RC=$?
}

calls() { grep -E '^(broker|systemctl) ' "$SB/calls.log" | sed 's/ lock=[a-z]*$//'; }
seq_from() { calls | awk -v first="$1" '$0 == first { on = 1 } on'; }
has_call() { calls | grep -qxF -- "$1"; }
apply_enabled() {
	node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).reconcile.apply.enabled))' \
		"$SB/devbox/config/opencode-broker/config.json"
}

read -r -d '' CUTOVER_SEQ <<'EOF'
systemctl --user disable --now opencode-model-reconcile.timer
systemctl --user is-active --quiet opencode-model-reconcile.service
broker bootstrap-generation-zero --json
broker scheduled-run --json
broker import-legacy-ledger --baseline --json
broker prepare --provider openai --json
systemctl --user disable --now opencode-model-watch.timer
systemctl --user is-active --quiet opencode-model-watch.service
broker record-legacy-quiesced --json
broker import-legacy-ledger --final --json
broker cutover-config --json
broker verify-deployed-config --json
systemctl --user restart opencode-model-broker.service
systemctl --user restart opencode-gateway.service
systemctl --user is-active --quiet opencode-model-broker.service
systemctl --user is-active --quiet opencode-gateway.service
systemctl --user restart opencode-model-broker.service
systemctl --user restart opencode-gateway.service
systemctl --user is-active --quiet opencode-model-broker.service
systemctl --user is-active --quiet opencode-gateway.service
broker prepare --provider openai --json
broker commit --provider openai --json
broker canary --provider openai --json
broker gate-start --provider openai --json
broker verify-deployed-config --json
systemctl --user enable --now opencode-model-reconcile.timer
systemctl --user is-enabled opencode-model-reconcile.timer
systemctl --user is-enabled opencode-model-watch.timer
EOF

read -r -d '' ROLLBACK_SEQ <<'EOF'
systemctl --user disable --now opencode-model-reconcile.timer
systemctl --user is-active --quiet opencode-model-reconcile.service
broker rollback-config --raw-emergency --json
broker verify-deployed-config --json
systemctl --user restart opencode-model-broker.service
systemctl --user restart opencode-gateway.service
systemctl --user is-active --quiet opencode-model-broker.service
systemctl --user is-active --quiet opencode-gateway.service
broker import-legacy-ledger --final --json
systemctl --user enable --now opencode-model-watch.timer
systemctl --user is-enabled opencode-model-reconcile.timer
systemctl --user is-enabled opencode-model-watch.timer
EOF

test_cutover_success_exact_order() {
	make_sandbox cutover-ok
	run_stage cutover
	[[ $STAGE_RC -eq 0 ]] || { fail "exit $STAGE_RC: $(cat "$SB/stderr")"; return; }
	local got
	got=$(seq_from "systemctl --user disable --now opencode-model-reconcile.timer")
	[[ $got == "$CUTOVER_SEQ" ]] || fail "call order differs:"$'\n'"$(diff <(printf '%s\n' "$CUTOVER_SEQ") <(printf '%s\n' "$got"))"
	[[ $(calls | head -n1) == "broker verify-deployed-config --json" ]] || fail "the read-only mode check must run first"
	grep '^broker ' "$SB/calls.log" | grep -qv ' lock=held$' && fail "a broker call ran without the expansion lock held"
	grep -q '^devbox-sync' "$SB/calls.log" && fail "cutover must never run devbox-sync"
	[[ $(apply_enabled) == true ]] || fail "reconcile.apply.enabled was not set to true"
	[[ -e $SB/units/opencode-model-reconcile.timer ]] || fail "reconcile timer not enabled"
	[[ ! -e $SB/units/opencode-model-watch.timer ]] || fail "old watch timer still enabled"
	return 0
}

test_cutover_aborts_at_each_broker_step() {
	local spec step restore i=0 last
	for spec in "bootstrap-generation-zero|0" "scheduled-run|0" "import-legacy-ledger --baseline|0" \
		"prepare --provider openai|0" "record-legacy-quiesced|1" "import-legacy-ledger --final|1" "cutover-config|0" \
		"commit --provider openai|0" \
		"canary --provider openai|0" "gate-start --provider openai|0"; do
		step=${spec%|*}; restore=${spec##*|}; i=$((i+1))
		make_sandbox "abort-$i"
		STUB_FAIL_AT="$step" run_stage cutover
		[[ $STAGE_RC -ne 0 ]] || fail "[$step] exited 0 after an injected failure"
		last=$(calls | grep '^broker ' | tail -n1)
		[[ $last == "broker $step --json" ]] || fail "[$step] a broker call ran after the failed step: $last"
		has_call "systemctl --user enable --now opencode-model-reconcile.timer" && fail "[$step] reconcile timer enabled despite failure"
		if (( restore )); then
			[[ $(calls | grep '^systemctl ' | tail -n1) == "systemctl --user enable --now opencode-model-watch.timer" ]] \
				|| fail "[$step] old watch timer not re-enabled inside the pre-cutover window"
		else
			has_call "systemctl --user enable --now opencode-model-watch.timer" && fail "[$step] old watch re-enabled outside the pre-cutover window"
		fi
		grep -q '^notify .*FAILED' "$SB/calls.log" || fail "[$step] no loud notification"
		if [[ $step == cutover-config ]]; then
			grep -q 'cutover-config --json' "$SB/stderr" && grep -q 'rollback --global' "$SB/stderr" \
				|| fail "[$step] stderr lacks the RF2 recovery hint"
		fi
	done
	return 0
}

test_cutover_aborts_when_old_watch_does_not_quiesce() {
	make_sandbox quiesce
	STUB_STUCK_UNIT=opencode-model-watch.service OPENCODE_STAGE_QUIESCE_TRIES=3 run_stage cutover
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 with an active old watch service"
	[[ $(calls | grep -cxF "systemctl --user is-active --quiet opencode-model-watch.service") -eq 3 ]] || fail "expected exactly 3 quiescence checks"
	has_call "broker record-legacy-quiesced --json" && fail "recorded quiescence that was never confirmed"
	has_call "broker cutover-config --json" && fail "published a generation without quiescence"
	[[ -e $SB/units/opencode-model-watch.timer ]] || fail "old watch timer not restored"
	return 0
}

test_cutover_aborts_when_dry_run_mutates_live_paths() {
	make_sandbox dryrun
	STUB_DRYRUN_TOUCH=1 run_stage cutover
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 after the dry-run changed the raw base"
	grep -q 'dry-run' "$SB/stderr" || fail "stderr does not name the dry-run"
	has_call "broker import-legacy-ledger --baseline --json" && fail "continued past a mutating dry-run"
	has_call "systemctl --user disable --now opencode-model-watch.timer" && fail "touched the old watch after a failed dry-run"
	return 0
}

test_cutover_refuses_when_apply_already_enabled() {
	make_sandbox apply-on
	write_canonical_config true
	run_stage cutover
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 with apply enabled"
	has_call "broker bootstrap-generation-zero --json" && fail "bootstrapped despite apply enabled"
	calls | grep -q '^systemctl --user disable' && fail "disabled a timer before refusing"
	return 0
}

test_cutover_refuses_noncanonical_config_without_rewriting() {
	make_sandbox noncanonical
	printf '{"reconcile":{"apply":{"enabled":false,"providers":["openai"]}}}\n' \
		> "$SB/devbox/config/opencode-broker/config.json"
	local before
	before=$(sha256sum < "$SB/devbox/config/opencode-broker/config.json")
	run_stage cutover
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 with a non-canonical config"
	has_call "broker bootstrap-generation-zero --json" && fail "bootstrapped before the config check"
	[[ $(sha256sum < "$SB/devbox/config/opencode-broker/config.json") == "$before" ]] || fail "config bytes changed"
	return 0
}

test_cutover_refuses_when_already_generated() {
	make_sandbox generated
	printf 'generated\n' > "$SB/mode"
	run_stage cutover
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 on an already cut-over deployment"
	[[ $(calls | wc -l) -eq 1 ]] || fail "expected only the mode check, got: $(calls | tr '\n' ';')"
	return 0
}

test_cutover_resumes_from_bootstrap_incomplete() {
	make_sandbox bootstrap_incomplete
	printf 'bootstrap-incomplete\n' > "$SB/mode"
	run_stage cutover
	[[ $STAGE_RC -eq 0 ]] || { fail "exit $STAGE_RC; stderr: $(cat "$SB/stderr")"; return; }
	has_call "broker bootstrap-generation-zero --json" || fail "bootstrap not called from bootstrap-incomplete"
	return 0
}

test_cutover_aborts_when_restart_fails() {
	make_sandbox restart
	STUB_SYSTEMCTL_FAIL="restart opencode-gateway.service" run_stage cutover
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 after a failed gateway restart"
	# The step-4 prepare legitimately ran before the restart; nothing may be committed after it.
	has_call "broker commit --provider openai --json" && fail "committed after a failed restart"
	[[ $(apply_enabled) == false ]] || fail "apply enabled although step 7 failed"
	return 0
}

test_rollback_global_success_exact_order() {
	make_sandbox rb-ok
	printf 'generated\n' > "$SB/mode"
	write_canonical_config true
	rm -f "$SB/units/opencode-model-watch.timer"
	touch "$SB/units/opencode-model-reconcile.timer"
	run_stage rollback --global
	[[ $STAGE_RC -eq 0 ]] || { fail "exit $STAGE_RC: $(cat "$SB/stderr")"; return; }
	local got
	got=$(seq_from "systemctl --user disable --now opencode-model-reconcile.timer")
	[[ $got == "$ROLLBACK_SEQ" ]] || fail "call order differs:"$'\n'"$(diff <(printf '%s\n' "$ROLLBACK_SEQ") <(printf '%s\n' "$got"))"
	grep '^broker ' "$SB/calls.log" | grep -qv ' lock=held$' && fail "a broker call ran without the expansion lock held"
	[[ $(apply_enabled) == false ]] || fail "apply not disabled"
	[[ -e $SB/units/opencode-model-watch.timer ]] || fail "old watch timer not re-enabled"
	[[ ! -e $SB/units/opencode-model-reconcile.timer ]] || fail "reconcile timer still enabled"
	return 0
}

test_rollback_global_refuses_unquiesced_reconcile() {
	make_sandbox rb-stuck
	printf 'generated\n' > "$SB/mode"
	STUB_STUCK_UNIT=opencode-model-reconcile.service OPENCODE_STAGE_QUIESCE_TRIES=2 run_stage rollback --global
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 with an active reconcile service"
	has_call "broker rollback-config --raw-emergency --json" && fail "rolled back without quiescence"
	grep -q '^notify .*FAILED' "$SB/calls.log" || fail "no loud notification"
	return 0
}

test_rollback_global_stops_when_broker_rollback_fails() {
	make_sandbox rb-fail
	printf 'generated\n' > "$SB/mode"
	write_canonical_config true
	rm -f "$SB/units/opencode-model-watch.timer"
	STUB_FAIL_AT="rollback-config --raw-emergency" run_stage rollback --global
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 after rollback-config failed"
	has_call "systemctl --user enable --now opencode-model-watch.timer" && fail "old watch re-enabled after a failed rollback"
	calls | grep -q '^systemctl --user restart' && fail "restarted services after a failed rollback"
	[[ $(apply_enabled) == true ]] || fail "config changed after a failed rollback"
	return 0
}

test_rollback_global_keeps_watch_off_without_legacy_ledger() {
	make_sandbox rb-ledger
	printf 'generated\n' > "$SB/mode"
	rm -f "$SB/units/opencode-model-watch.timer" "$SB/state/reviewed-models.json"
	STUB_FAIL_AT="import-legacy-ledger --final" run_stage rollback --global
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 without a writable legacy ledger"
	has_call "broker rollback-config --raw-emergency --json" || fail "raw-emergency rollback should still run"
	has_call "broker import-legacy-ledger --final --json" || fail "final import should be attempted"
	has_call "systemctl --user enable --now opencode-model-watch.timer" && fail "re-enabled the old watch after final import failed"
	return 0
}

test_rollback_global_refuses_pre_bootstrap() {
	make_sandbox rb-pre
	run_stage rollback --global
	[[ $STAGE_RC -ne 0 ]] || fail "exited 0 with nothing to roll back"
	calls | grep -q '^systemctl ' && fail "touched systemd while refusing"
	has_call "broker rollback-config --raw-emergency --json" && fail "called rollback-config while pre-bootstrap"
	return 0
}

run_test cutover_success_exact_order test_cutover_success_exact_order
run_test cutover_aborts_at_each_broker_step test_cutover_aborts_at_each_broker_step
run_test cutover_aborts_when_old_watch_does_not_quiesce test_cutover_aborts_when_old_watch_does_not_quiesce
run_test cutover_aborts_when_dry_run_mutates_live_paths test_cutover_aborts_when_dry_run_mutates_live_paths
run_test cutover_refuses_when_apply_already_enabled test_cutover_refuses_when_apply_already_enabled
run_test cutover_refuses_noncanonical_config test_cutover_refuses_noncanonical_config_without_rewriting
run_test cutover_refuses_when_already_generated test_cutover_refuses_when_already_generated
run_test cutover_resumes_from_bootstrap_incomplete test_cutover_resumes_from_bootstrap_incomplete
run_test cutover_aborts_when_restart_fails test_cutover_aborts_when_restart_fails
run_test rollback_global_success_exact_order test_rollback_global_success_exact_order
run_test rollback_global_refuses_unquiesced_reconcile test_rollback_global_refuses_unquiesced_reconcile
run_test rollback_global_stops_when_broker_rollback_fails test_rollback_global_stops_when_broker_rollback_fails
run_test rollback_global_keeps_watch_off_without_legacy_ledger test_rollback_global_keeps_watch_off_without_legacy_ledger
run_test rollback_global_refuses_pre_bootstrap test_rollback_global_refuses_pre_bootstrap

say ""
say "passed: $PASSED  failed: $FAILED"
if (( FAILED > 0 )); then
	printf '  %s\n' "${FAILED_NAMES[@]}"
	exit 1
fi
exit 0
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bash tests/opencode-model-provider-stage-cutover.test.sh`

Expected: FAIL, with `passed: 0  failed: 14` (or more) and exit status 1. The success tests fail with `exit 2: ... not implemented in this task`, because the F4a1 stubs are still in place. The abort and refusal tests fail with messages such as `has_call ... rollback-config` missing or `stderr lacks the RF2 recovery hint`.

- [ ] **Step 3: Implement**

In `bin/opencode-model-provider-stage`, delete the F4a1 stub bodies of `cmd_cutover` and `cmd_rollback_global`. Put the following block in their place:

```bash
# ---------------------------------------------------------------------------
# cutover / rollback --global
# Every broker call below runs while this process holds the expansion lock on fd 9
# (taken by the dispatcher), so the flock-wrapped timers exit 5 instead of writing.
# ---------------------------------------------------------------------------

STAGE_ACTION=""
STAGE_OUT=""
STAGE_HINT=""
# 1 only between disabling the old watch timer and invoking cutover-config: inside that
# window the old watch is still the authorized writer, so any abort must hand it back.
STAGE_RESTORE_WATCH=0

stage_state_root() { printf '%s' "${OPENCODE_RECONCILE_STATE_ROOT:-/home/dev/.local/share/opencode/model-routing}"; }
stage_raw_base() { printf '%s' "${OPENCODE_RECONCILE_RAW_BASE:-/home/dev/devbox/config/opencode/opencode.json}"; }
stage_outer_link() { printf '%s' "${OPENCODE_RECONCILE_OUTER_LINK:-/home/dev/.config/opencode/opencode.json}"; }
stage_broker_config() { printf '%s/config/opencode-broker/config.json' "${OPENCODE_RECONCILE_DEVBOX:-/home/dev/devbox}"; }

cutover_fail() { # <step> <message>
	local step=$1 msg=$2
	if (( STAGE_RESTORE_WATCH )); then
		STAGE_RESTORE_WATCH=0
		if sysd enable --now opencode-model-watch.timer; then
			msg+="; old watch timer re-enabled (pre-cutover state restored)"
		else
			msg+="; FAILED to re-enable opencode-model-watch.timer -- no scheduled writer is running"
		fi
	fi
	[[ -n $STAGE_HINT ]] && msg+="; next: $STAGE_HINT"
	printf 'opencode-model-provider-stage: %s FAILED at %s: %s\n' "$STAGE_ACTION" "$step" "$msg" >&2
	stage_notify "provider-stage $STAGE_ACTION FAILED at $step" "$msg" \
		|| printf 'opencode-model-provider-stage: stage_notify also failed\n' >&2
	exit 1
}

stage_json_field() { # <dotted.key|.>  reads JSON from stdin
	node -e '
		let s = "";
		process.stdin.on("data", (d) => { s += d; }).on("end", () => {
			let v;
			try { v = JSON.parse(s); } catch (e) { process.stderr.write("stage: output is not JSON: " + e.message + "\n"); process.exit(3); }
			if (v === null || typeof v !== "object" || Array.isArray(v)) { process.stderr.write("stage: JSON is not an object\n"); process.exit(3); }
			const key = process.argv[1];
			if (key === ".") return;
			for (const part of key.split(".")) {
				if (v === null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, part)) {
					process.stderr.write("stage: missing key " + key + "\n");
					process.exit(4);
				}
				v = v[part];
			}
			process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
		});' "$1"
}

stage_broker_step() { # <step> <subcommand> [args...]
	local step=$1 rc=0
	shift
	rc=0; broker_cli "$@" || rc=$?; STAGE_OUT=$BROKER_OUT
	(( rc == 0 )) || cutover_fail "$step" "opencode-broker-reconcile $* exited $rc: ${STAGE_OUT:0:500}"
	printf '%s' "$STAGE_OUT" | stage_json_field . \
		|| cutover_fail "$step" "opencode-broker-reconcile $* printed no JSON object: ${STAGE_OUT:0:500}"
}

stage_await_inactive() { # <unit>
	local unit=$1 tries=${OPENCODE_STAGE_QUIESCE_TRIES:-60} pause=${OPENCODE_STAGE_QUIESCE_SLEEP:-1} i
	for (( i = 0; i < tries; i++ )); do
		sysd is-active --quiet "$unit" || return 0
		(( i + 1 < tries )) && sleep "$pause"
	done
	return 1
}

restart_broker_gateway() { # <step>
	local unit
	for unit in opencode-model-broker.service opencode-gateway.service; do
		sysd restart "$unit" || cutover_fail "$1" "systemctl --user restart $unit failed"
	done
	for unit in opencode-model-broker.service opencode-gateway.service; do
		sysd is-active --quiet "$unit" || cutover_fail "$1" "$unit is not active after restart"
	done
}

config_apply_enabled() { # <check|true|false>
	# Refuses anything that is not canonical JSON.stringify(_, null, 2) output so a rewrite
	# can never reformat the tracked file; writes temp-in-same-dir then rename.
	node -e '
		const fs = require("fs"), path = require("path");
		const [file, action] = process.argv.slice(1);
		if (!fs.lstatSync(file).isFile()) { console.error("stage: " + file + " is not a regular file"); process.exit(3); }
		const raw = fs.readFileSync(file, "utf8");
		const cfg = JSON.parse(raw);
		if (JSON.stringify(cfg, null, 2) + "\n" !== raw) { console.error("stage: " + file + " is not canonical 2-space JSON; refusing to rewrite it"); process.exit(3); }
		const apply = cfg.reconcile && cfg.reconcile.apply;
		if (!apply || typeof apply !== "object" || typeof apply.enabled !== "boolean") { console.error("stage: " + file + " has no boolean reconcile.apply.enabled"); process.exit(3); }
		if (action === "check") process.exit(0);
		if (action !== "true" && action !== "false") { console.error("stage: bad action " + action); process.exit(2); }
		apply.enabled = action === "true";
		const tmp = path.join(path.dirname(file), "." + path.basename(file) + ".stage-" + process.pid);
		try {
			fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: fs.statSync(file).mode & 0o777 });
			fs.renameSync(tmp, file);
		} catch (e) {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
			throw e;
		}' "$(stage_broker_config)" "$1"
}

stage_fingerprint() {
	# Prohibited live paths for the step-3 dry-run: raw base bytes+mtime+mode, outer link
	# target, resolver-generations/current target. The ledger is excluded on purpose
	# (dry-run ledger observations are allowed).
	local raw outer current
	raw=$(stage_raw_base); outer=$(stage_outer_link)
	current="$(stage_state_root)/resolver-generations/current"
	sha256sum -- "$raw" || return 1
	stat -c '%y %s %a' -- "$raw" || return 1
	printf 'outer=%s\n' "$(readlink -- "$outer" 2>/dev/null || printf 'not-a-link')"
	printf 'current=%s\n' "$(readlink -- "$current" 2>/dev/null || printf 'absent')"
}

cmd_cutover() {
	STAGE_ACTION=cutover
	local mode cfg enabled providers before after dry_mode problem reconcile_state watch_state

	# Read-only gate: only a pre-bootstrap or bootstrap-incomplete deployment may start a cutover.
	# bootstrap-incomplete means the ledger is initialized but no configCutover exists, left by a
	# cutover that failed at steps 2-5. Bootstrap is idempotent, so re-running cutover from
	# bootstrap-incomplete resumes. "invalid" is the RF2 intermediate state (current swapped, outer
	# link not yet retargeted); it is finished by re-running the broker's cutover-config, never by
	# restarting this sequence.
	rc=0; broker_cli verify-deployed-config || rc=$?; mode=$(json_get "$BROKER_OUT" mode)
	case "$mode" in
		pre-bootstrap|bootstrap-incomplete) ;;
		invalid)
			STAGE_HINT="re-run 'node /home/dev/opencode-broker/bin/opencode-broker-reconcile cutover-config --json' to finish an interrupted retarget, or run 'opencode-model-provider-stage rollback --global'"
			cutover_fail mode-check "deployed config mode is invalid" ;;
		*) cutover_fail mode-check "deployed config mode is '$mode'; cutover only runs from pre-bootstrap or bootstrap-incomplete (use add/gate/rollback instead)" ;;
	esac

	# Step 0: topology + approval-skill preflight (F4a1). It never runs devbox-sync.
	cmd_preflight || cutover_fail step0-preflight "preflight failed (topology or approval-skill check); devbox-sync must repair before retrying"

	# Step 1: product and fleet changes are deployed with apply disabled and only openai allowlisted.
	cfg=$(stage_broker_config)
	config_apply_enabled check || cutover_fail step1-config "$cfg failed validation"
	enabled=$(stage_json_field reconcile.apply.enabled < "$cfg") || cutover_fail step1-config "cannot read reconcile.apply.enabled from $cfg"
	[[ $enabled == false ]] || cutover_fail step1-config "reconcile.apply.enabled is $enabled; cutover requires apply disabled"
	providers=$(stage_json_field reconcile.apply.providers < "$cfg") || cutover_fail step1-config "cannot read reconcile.apply.providers from $cfg"
	[[ $providers == '["openai"]' ]] || cutover_fail step1-config "reconcile.apply.providers is $providers; cutover requires exactly [\"openai\"]"
	# Stop the new timer first: zero mutation-capable schedules from here until step 10.
	sysd disable --now opencode-model-reconcile.timer || cutover_fail step1-timers "cannot disable opencode-model-reconcile.timer"
	stage_await_inactive opencode-model-reconcile.service || cutover_fail step1-timers "opencode-model-reconcile.service is still active"

	# Step 2: generation 0 from the raw base, registry init ack, no current switch.
	stage_broker_step step2-bootstrap bootstrap-generation-zero

	# Step 3: one complete dry-run; prohibited live paths must be byte- and mtime-identical.
	before=$(stage_fingerprint) || cutover_fail step3-dry-run "cannot fingerprint live paths before the dry-run"
	stage_broker_step step3-dry-run scheduled-run
	# scheduled-run nests its mode under run (contract v2).
	dry_mode=$(printf '%s' "$STAGE_OUT" | stage_json_field run.mode) || cutover_fail step3-dry-run "dry-run output has no run.mode"
	[[ $dry_mode == dry-run ]] || cutover_fail step3-dry-run "scheduled-run ran in mode '$dry_mode', expected dry-run"
	after=$(stage_fingerprint) || cutover_fail step3-dry-run "cannot fingerprint live paths after the dry-run"
	[[ $before == "$after" ]] || cutover_fail step3-dry-run "prohibited live path changed during the step-3 dry-run"

	# Step 4: baseline import, verified prepare, then quiesce the old watch.
	stage_broker_step step4-baseline import-legacy-ledger --baseline
	stage_broker_step step4-prepare prepare --provider openai
	STAGE_RESTORE_WATCH=1
	sysd disable --now opencode-model-watch.timer || cutover_fail step4-quiesce "cannot disable opencode-model-watch.timer"
	stage_await_inactive opencode-model-watch.service \
		|| cutover_fail step4-quiesce "opencode-model-watch.service still active; aborting before any generation is published"

	# Step 5: record quiescence, final delta import (writable ledger + read-only copy preserved by the broker).
	stage_broker_step step5-quiesced record-legacy-quiesced
	stage_broker_step step5-final import-legacy-ledger --final

	# Step 6: first resolver-generations/current switch + outer-link retarget (broker, under this lock).
	# From here on the old watch is NOT handed back automatically: its data guard skips once
	# configCutover is generated, and a global return to it is rollback --global's job.
	STAGE_RESTORE_WATCH=0
	STAGE_HINT="re-run 'node /home/dev/opencode-broker/bin/opencode-broker-reconcile cutover-config --json' to finish an interrupted retarget, or run 'opencode-model-provider-stage rollback --global'"
	stage_broker_step step6-cutover cutover-config
	stage_broker_step step6-verify verify-deployed-config
	mode=$(printf '%s' "$STAGE_OUT" | stage_json_field mode) || cutover_fail step6-verify "verify-deployed-config output has no mode"
	[[ $mode == generated ]] || cutover_fail step6-verify "deployed mode is '$mode' after cutover-config, expected generated"
	STAGE_HINT="inspect the failure; if generation 0 is unusable run 'opencode-model-provider-stage rollback --global'"

	# Step 7: restart broker and gateway (existing TUIs keep their loaded config).
	restart_broker_gateway step7-restart

	# Step 8: enable OpenAI apply, reload, then manual prepare/commit/canary with zero scheduled writers.
	config_apply_enabled true || cutover_fail step8-apply "cannot set reconcile.apply.enabled=true in $cfg"
	restart_broker_gateway step8-restart
	stage_broker_step step8-prepare prepare --provider openai
	stage_broker_step step8-commit commit --provider openai
	stage_broker_step step8-canary canary --provider openai

	# Step 9: start the 24h provider gate and re-verify the deployed generated config.
	stage_broker_step step9-gate-start gate-start --provider openai
	stage_broker_step step9-verify verify-deployed-config
	mode=$(printf '%s' "$STAGE_OUT" | stage_json_field mode) || cutover_fail step9-verify "verify-deployed-config output has no mode"
	[[ $mode == generated ]] || cutover_fail step9-verify "deployed mode is '$mode', expected generated"

	# Step 10: exactly one mutation-capable schedule, enabled only after canary success.
	sysd enable --now opencode-model-reconcile.timer || cutover_fail step10-timer "cannot enable opencode-model-reconcile.timer"
	# is-enabled exits nonzero for "disabled"; the printed state is the value being checked.
	reconcile_state=$(sysd is-enabled opencode-model-reconcile.timer) || true
	watch_state=$(sysd is-enabled opencode-model-watch.timer) || true
	[[ $reconcile_state == enabled ]] || cutover_fail step10-singleton "opencode-model-reconcile.timer is '$reconcile_state'"
	[[ $watch_state != enabled ]] || cutover_fail step10-singleton "opencode-model-watch.timer is still enabled: two schedules"

	printf '{"ok":true,"action":"cutover","provider":"openai","gate":"started","configChanged":"%s"}\n' "$cfg"
	printf 'opencode-model-provider-stage: %s now has reconcile.apply.enabled=true; commit it in the devbox repo\n' "$cfg" >&2
	stage_notify "provider-stage cutover complete" "generated config live; openai committed, canary passed, 24h gate started" \
		|| printf 'opencode-model-provider-stage: stage_notify failed after a successful cutover\n' >&2
}

cmd_rollback_global() {
	STAGE_ACTION=rollback-global
	local mode problem reconcile_state watch_state rc=0

	rc=0; broker_cli verify-deployed-config || rc=$?; mode=$(json_get "$BROKER_OUT" mode)
	# "invalid" proceeds: the broker's CAS decides whether configCutover evidence permits it.
	case "$mode" in
		pre-bootstrap|raw-emergency) cutover_fail precheck "deployed config mode is '$mode'; nothing to roll back globally" ;;
	esac

	sysd disable --now opencode-model-reconcile.timer || cutover_fail quiesce "cannot disable opencode-model-reconcile.timer"
	stage_await_inactive opencode-model-reconcile.service \
		|| cutover_fail quiesce "opencode-model-reconcile.service still active; rollback aborted without publishing anything"

	stage_broker_step rollback-config rollback-config --raw-emergency
	stage_broker_step verify verify-deployed-config
	mode=$(printf '%s' "$STAGE_OUT" | stage_json_field mode) || cutover_fail verify "verify-deployed-config output has no mode"
	[[ $mode == raw-emergency ]] || cutover_fail verify "deployed mode is '$mode' after rollback, expected raw-emergency"

	config_apply_enabled false || cutover_fail apply-off "cannot set reconcile.apply.enabled=false in $(stage_broker_config)"
	restart_broker_gateway restart

	# The old watch becomes the authorized writer again only if its writable ledger is intact.
	# The broker's idempotent final-import replay verifies the writable legacy ledger's hash, mode
	# and revision before the old watch is re-enabled.
	stage_broker_step legacy-ledger import-legacy-ledger --final
	sysd enable --now opencode-model-watch.timer || cutover_fail watch-enable "cannot enable opencode-model-watch.timer"

	# is-enabled exits nonzero for "disabled"; the printed state is the value being checked.
	reconcile_state=$(sysd is-enabled opencode-model-reconcile.timer) || true
	watch_state=$(sysd is-enabled opencode-model-watch.timer) || true
	[[ $reconcile_state != enabled ]] || cutover_fail singleton "opencode-model-reconcile.timer is still enabled"
	[[ $watch_state == enabled ]] || cutover_fail singleton "opencode-model-watch.timer is '$watch_state'"

	printf '{"ok":true,"action":"rollback-global","mode":"raw-emergency"}\n'
	stage_notify "provider-stage GLOBAL ROLLBACK done" "outer link on raw base (raw-emergency); apply disabled; old watch re-enabled; reconcile timer disabled (devbox-sync may re-enable it, scheduled-run then exits 5)" \
		|| printf 'opencode-model-provider-stage: stage_notify failed after rollback\n' >&2
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bash tests/opencode-model-provider-stage-cutover.test.sh`

Expected: PASS, with `passed: 14  failed: 0` and exit status 0.

Then run: `bash -n bin/opencode-model-provider-stage && for t in tests/opencode-model-provider-stage*.test.sh; do bash "$t" || echo "FAILED: $t"; done`

Expected: no syntax error, and no `FAILED:` line. This loop also runs the F4a1 suite. If an F4a1 test asserts that `cutover` or `rollback --global` exits 2 with "not implemented in this task", delete only that assertion. This task replaces that behaviour on purpose. After deleting it, re-run the loop.

- [ ] **Step 5: Commit**

```bash
cd /home/dev/devbox
git add bin/opencode-model-provider-stage tests/opencode-model-provider-stage-cutover.test.sh
git commit -m "feat(provider-stage): implement cutover (spec steps 0-10) and raw-emergency rollback --global"
```

If Step 4 required changing the F4a1 test file, the implementer adds that file to the same `git add` by its exact path.

### Task F4b: Provider-stage `add`, `gate` and `rollback --provider` subcommands

**Files:**
- Modify: `bin/opencode-model-provider-stage` (in `/home/dev/devbox`). Replace the F4a1 stub bodies of `cmd_add`, `cmd_gate` and `cmd_rollback_provider`, and add the "Provider expansion" helper block directly above `cmd_add`.
- Create: `tests/opencode-model-provider-stage-expand.test.sh`

**Interfaces:**
- Consumes. These come from F4a1 and must match exactly. Step 1 checks them before any code is written.
  - The main dispatch in `bin/opencode-model-provider-stage` takes the lock first, with `exec 9>"$LOCK"; chmod 0600 "$LOCK"; flock -w 5 9`. Only then does it call `cmd_add <provider>`, `cmd_gate <provider>` or `cmd_rollback_provider <provider>` (the last for `rollback --provider <id>`). `LOCK` is `${OPENCODE_RECONCILE_STATE_ROOT:-/home/dev/.local/share/opencode/model-routing}/provider-expansion.lock`. The script never deletes it. In F4a1 each of the three functions exits 2 with "not implemented in this task".
  - `broker_cli <subcommand> [args...]` runs the broker reconcile CLI with `--json` added at the end, stores the CLI's stdout in the global `BROKER_OUT`, prints nothing, and returns the CLI's exit code. Call it as `broker_cli ... || rc=$?` and read `$BROKER_OUT`; never inside `$(...)`, which would lose `BROKER_OUT` to the subshell (contract v2). The CLI path is `${OPENCODE_RECONCILE_CLI:-/home/dev/opencode-broker/bin/opencode-broker-reconcile}` and it is run with `node`.
  - `sysd <args...>` runs `systemctl --user <args...>`. `systemctl` is resolved from PATH.
  - `json_get <json-text> <dotted.path>` takes the JSON document as its first argument (contract v2; not stdin). It prints string values raw and booleans or numbers as text (`true`); array indices are allowed (`reasons.0`). It exits nonzero when the path is missing or the input is not JSON.
  - `config_append_provider <config-path> <providerID>` (two arguments, contract v2) appends exactly one provider to `reconcile.apply.providers` in `${OPENCODE_RECONCILE_DEVBOX:-/home/dev/devbox}/config/opencode-broker/config.json` as an atomic rewrite done with node. It exits nonzero on failure.
  - `stage_notify <title> <message>` sends a loud notification through the existing notify mechanism and exits nonzero if that fails.
  - Broker CLI output, from B6 and B8:
    - `verify-deployed-config` prints `ok` (boolean) and `mode` (string).
    - `gate-status --provider <id>` prints `status` (one of the providerStages status values), `eligible` (boolean) and `reason` (string; `"clock-regressed"` when the wall clock is earlier than `startedAt`).
    - `gate-complete --provider <id>` prints `status` (`"healthy"` on success).
    - `prepare`, `commit`, `canary`, `gate-start` and `rollback-config --provider <id>` each exit 0 on success.
- Produces:
  - `config_remove_provider <providerID>` takes exactly that provider out of `reconcile.apply.providers` with an atomic rewrite. It does nothing and exits 0 if the provider is already absent. It exits 1 instead of emptying the list while `reconcile.apply.enabled === true`.
  - Command behaviour that F5 and the runbook rely on:
    - `opencode-model-provider-stage add <provider>`, `gate <provider>` and `rollback --provider <id>`.
    - Exit codes: **0** done; **2** usage error; **5** gate not yet eligible (quiet, run it again later); **20** refused or needs attention, with nothing changed by this run; **1** failed after a change had begun (loud `stage_notify`, and the message names the exact recovery command).
  - Internal helpers, not a contract for other tasks: `expand_fleet_config`, `expand_valid_id`, `expand_refuse`, `expand_fail`, `expand_config_query`, `expand_load_providers` (fills the global array `EXPAND_PROVIDERS`), `expand_config_deployed`, `expand_require_generated`, `expand_quiesce_reconcile` and `expand_restart_broker_gateway`.

**Design decisions an implementer must not change:**
- `add` does **not** run devbox-sync. devbox-sync re-enables every timer under `systemd/` on every run, which would turn the reconcile timer back on before the canary has passed. The broker reads `~/.config/opencode-broker/config.json`, and devbox-sync already links that file straight to the repo file. So the edit is live as soon as it is written, and "sync config" is done by checking that the deployed link resolves to the edited file.
- `rollback --provider` runs the broker's `rollback-config --provider` **first**, while the running broker still knows the provider. Only after that does it remove the provider from the allowlist and restart the services. If the broker rollback fails, the allowlist stays as it was and the timer stays stopped.
- `rollback --provider` refuses to empty the allowlist and sends the operator to `rollback --global`, following the spec: "Generation 0 and the old watch are reserved for global integrity failure".
- Every allowlisted provider must report gate `healthy` before `add` can proceed. A rolled-back provider has already been removed from the allowlist, which is how the spec's "healthy or rolled back" rule is enforced.

- [ ] **Step 1: Verify the F4a1 names this task consumes**

Run (in `/home/dev/devbox`):
```bash
grep -nE '^(broker_cli|sysd|json_get|config_append_provider|stage_notify|cmd_add|cmd_gate|cmd_rollback_provider)\(\)' bin/opencode-model-provider-stage
bash -c 'eval "$(sed -n "/^json_get()/,/^}/p" bin/opencode-model-provider-stage)"; j={\"a\":{\"b\":\"x\"},\"t\":true}; json_get "$j" a.b; json_get "$j" t'
```
Expected: the grep prints exactly 8 lines, one per name, and the second command prints `x` and then `true`. If any name is missing, or `json_get` has a different calling convention (contract v2: JSON text plus dotted path), stop. Reconcile it with the F4a1 text in the plan before you continue. Do not rename F4a1's helpers inside this task.

- [ ] **Step 2: Write the failing test file**

Create `tests/opencode-model-provider-stage-expand.test.sh`:

```bash
#!/usr/bin/env bash
# Tests for the provider-expansion subcommands of bin/opencode-model-provider-stage:
# add <provider>, gate <provider>, rollback --provider <id>.
# Every run is sandboxed: env -i, HOME and all OPENCODE_RECONCILE_* roots live under
# a temp dir. The broker reconcile CLI is a node stub that logs its argv and probes
# the expansion lock with `flock -n` (so every logged broker call records whether
# the stage script still held the lock). systemctl, devbox-sync, notify, fleet-notify
# and curl are bash stubs on PATH (and under the sandbox fleet-core/bin) that log to calls.log.
# Real node performs the config rewrites.
#
# Usage:
#   bash tests/opencode-model-provider-stage-expand.test.sh            -- run all tests
#   bash tests/opencode-model-provider-stage-expand.test.sh <nameglob> -- run only matching tests
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$REPO_ROOT/bin/opencode-model-provider-stage"
NODE_BIN="$(command -v node)" || { echo "node is required on PATH" >&2; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"
command -v flock >/dev/null || { echo "flock (util-linux) is required" >&2; exit 1; }

TEST_ROOT="/tmp/opencode/provider-stage-expand-tests.$$"
rm -rf "$TEST_ROOT"
mkdir -p "$TEST_ROOT"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASSED=0
FAILED=0
FAILED_NAMES=()
CURRENT_TEST=""

say() { printf '%s\n' "$*"; }
fail() {
	say "  FAIL: $*"
	FAILED=$((FAILED+1))
	FAILED_NAMES+=("$CURRENT_TEST: $*")
	return 1
}

TEST_FILTER=("$@")
run_test() {
	local name=$1 fn=$2
	if [[ ${#TEST_FILTER[@]} -gt 0 ]]; then
		local keep=0 g
		for g in "${TEST_FILTER[@]}"; do
			[[ $name == *$g* ]] && keep=1
		done
		(( keep )) || return 0
	fi
	CURRENT_TEST="$name"
	say "RUN  $name"
	local before_failed=$FAILED
	"$fn" || true
	if (( FAILED == before_failed )); then
		PASSED=$((PASSED+1))
		say "  OK"
	fi
}

# log_stub <path> <label>: an executable that appends "<label> <argv>" to calls.log.
log_stub() {
	cat >"$1" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' "$2" "\$*" >>"\$STAGE_TEST_ROOT/calls.log"
exit 0
EOF
	chmod +x "$1"
}

# make_sandbox <label> <providers-json-array>: prints the sandbox root.
make_sandbox() {
	local label=$1 providers=$2
	local root="$TEST_ROOT/$label"
	mkdir -p "$root/bin" "$root/fleet-core/bin" "$root/home/.config/opencode-broker" \
		"$root/devbox/config/opencode-broker" "$root/units"
	mkdir -m 700 "$root/state"
	: >"$root/calls.log"
	cat >"$root/devbox/config/opencode-broker/config.json" <<JSON
{
  "trustedSubscriptionProviders": ["alibaba-token-plan", "anthropic", "openai"],
  "reconcile": {
    "apply": { "enabled": true, "providers": $providers }
  }
}
JSON
	ln -s "$root/devbox/config/opencode-broker/config.json" \
		"$root/home/.config/opencode-broker/config.json"
	printf 'active\n' >"$root/units/opencode-model-broker.service"
	printf 'active\n' >"$root/units/opencode-gateway.service"
	printf '%s\n' '{"verify-deployed-config":{"rc":0,"out":{"ok":true,"mode":"generated"}}}' \
		>"$root/broker-scenario.json"

	# Broker reconcile CLI stub. Reply lookup: "<sub>:<provider>", then "<sub>",
	# then {rc:0,out:{ok:true}}. Logs "[lock=held]" when flock -n on the
	# expansion lock is refused, i.e. the stage script still holds it.
	cat >"$root/broker-cli" <<'EOF'
#!/usr/bin/env node
"use strict";
const fs = require("fs");
const { spawnSync } = require("child_process");
const root = process.env.STAGE_TEST_ROOT;
const args = process.argv.slice(2);
const lockPath = process.env.OPENCODE_RECONCILE_STATE_ROOT + "/provider-expansion.lock";
const probe = spawnSync("flock", ["-n", "-E", "99", lockPath, "true"]);
const lock = probe.status === 99 ? "held" : probe.status === 0 ? "free" : "probe-error";
fs.appendFileSync(root + "/calls.log", "broker " + args.join(" ") + " [lock=" + lock + "]\n");
const sub = args[0];
const pi = args.indexOf("--provider");
const key = pi >= 0 ? sub + ":" + args[pi + 1] : sub;
const scenario = JSON.parse(fs.readFileSync(root + "/broker-scenario.json", "utf8"));
const reply = scenario[key] || scenario[sub] || { rc: 0, out: { ok: true } };
process.stdout.write(JSON.stringify(reply.out) + "\n");
process.exit(reply.rc);
EOF
	chmod +x "$root/broker-cli"

	# systemctl stub: logs argv without --user; is-active reads units/<unit>.
	cat >"$root/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
root=$STAGE_TEST_ROOT
args=("$@")
[[ ${args[0]:-} == --user ]] && args=("${args[@]:1}")
printf 'systemctl %s\n' "${args[*]}" >>"$root/calls.log"
case ${args[0]:-} in
	is-active)
		unit=${args[${#args[@]}-1]}
		state=$(cat "$root/units/$unit" 2>/dev/null || printf 'inactive')
		[[ " ${args[*]} " == *" --quiet "* ]] || printf '%s\n' "$state"
		[[ $state == active ]] && exit 0
		exit 3 ;;
	restart)
		[[ -e $root/fail-restart ]] && exit 1
		exit 0 ;;
esac
exit 0
EOF
	chmod +x "$root/bin/systemctl"

	log_stub "$root/bin/devbox-sync" devbox-sync
	log_stub "$root/fleet-core/bin/devbox-sync" devbox-sync
	log_stub "$root/bin/notify" notify
	log_stub "$root/bin/fleet-notify" notify
	log_stub "$root/fleet-core/bin/notify" notify
	log_stub "$root/fleet-core/bin/fleet-notify" notify
	cat >"$root/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf 'notify-curl\n' >>"$STAGE_TEST_ROOT/calls.log"
printf '200'
EOF
	chmod +x "$root/bin/curl"
	printf '%s\n' "$root"
}

# set_reply <root> <key> <rc> <json>
set_reply() {
	node -e '
		const fs = require("fs");
		const [file, key, rc, json] = process.argv.slice(1);
		const s = JSON.parse(fs.readFileSync(file, "utf8"));
		s[key] = { rc: Number(rc), out: JSON.parse(json) };
		fs.writeFileSync(file, JSON.stringify(s));
	' "$1/broker-scenario.json" "$2" "$3" "$4"
}

# run_stage <root> <stage args...>: returns the stage exit code.
run_stage() {
	local root=$1; shift
	env -i \
		HOME="$root/home" \
		PATH="$root/bin:$NODE_DIR:/usr/bin:/bin" \
		STAGE_TEST_ROOT="$root" \
		OPENCODE_RECONCILE_STATE_ROOT="$root/state" \
		OPENCODE_RECONCILE_DEVBOX="$root/devbox" \
		OPENCODE_RECONCILE_FLEET_CORE="$root/fleet-core" \
		OPENCODE_RECONCILE_CLI="$root/broker-cli" \
		FLEET_DESK=0 \
		NTFY_TOPIC_URL="http://ntfy.invalid/t" \
		bash "$STAGE" "$@" >"$root/stdout" 2>"$root/stderr"
}

providers_of() {
	node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).reconcile.apply.providers))' \
		"$1/devbox/config/opencode-broker/config.json"
}

cfg_hash() { sha256sum "$1/devbox/config/opencode-broker/config.json" | cut -d' ' -f1; }

# assert_order <root> <substring>...: first match of each appears in increasing line order.
assert_order() {
	local root=$1; shift
	local last=0 pat n
	for pat in "$@"; do
		n=$(grep -nF -- "$pat" "$root/calls.log" | head -n1 | cut -d: -f1)
		[[ -n $n ]] || { fail "missing call: $pat; log: $(tr '\n' '|' <"$root/calls.log")"; return 1; }
		(( n > last )) || { fail "out of order: '$pat' at line $n, previous step at line $last"; return 1; }
		last=$n
	done
}

assert_no_call() {
	if grep -qF -- "$2" "$1/calls.log"; then
		fail "unexpected call matching '$2'"
	fi
	return 0
}

assert_lock_held_throughout() {
	local root=$1
	grep -q '^broker ' "$root/calls.log" || { fail "no broker calls logged"; return 1; }
	if grep '^broker ' "$root/calls.log" | grep -vqF '[lock=held]'; then
		fail "broker called without the expansion lock held: $(grep '^broker ' "$root/calls.log" | grep -vF '[lock=held]' | tr '\n' '|')"
	fi
	[[ -e $root/state/provider-expansion.lock ]] || fail "lock file was deleted"
}

healthy() { printf '{"ok":true,"provider":"%s","status":"healthy","eligible":false,"reason":"already-healthy"}' "$1"; }

# ---------------------------------------------------------------------------
# add <provider>
# ---------------------------------------------------------------------------

test_add_happy_path() {
	local root rc=0; root=$(make_sandbox add_happy '["openai"]')
	set_reply "$root" gate-status:openai 0 "$(healthy openai)"
	run_stage "$root" add anthropic || rc=$?
	(( rc == 0 )) || { fail "exit $rc; stderr: $(cat "$root/stderr")"; return; }
	[[ $(providers_of "$root") == '["openai","anthropic"]' ]] || fail "providers: $(providers_of "$root")"
	assert_order "$root" \
		"broker verify-deployed-config --json" \
		"broker gate-status --provider openai --json" \
		"systemctl stop opencode-model-reconcile.timer" \
		"systemctl is-active --quiet opencode-model-reconcile.service" \
		"systemctl restart opencode-model-broker.service opencode-gateway.service" \
		"systemctl is-active --quiet opencode-model-broker.service" \
		"systemctl is-active --quiet opencode-gateway.service" \
		"broker prepare --provider anthropic --json" \
		"broker commit --provider anthropic --json" \
		"broker canary --provider anthropic --json" \
		"systemctl enable --now opencode-model-reconcile.timer" \
		"broker gate-start --provider anthropic --json"
	assert_lock_held_throughout "$root"
	assert_no_call "$root" "devbox-sync"
}

test_add_refuses_unhealthy_gate() {
	local status root rc before
	for status in prepared committed gate-running failed; do
		root=$(make_sandbox "add_gate_$status" '["openai"]')
		set_reply "$root" gate-status:openai 0 "{\"ok\":true,\"provider\":\"openai\",\"status\":\"$status\",\"eligible\":false,\"reason\":\"x\"}"
		before=$(cfg_hash "$root")
		rc=0; run_stage "$root" add anthropic || rc=$?
		(( rc == 20 )) || fail "status $status: exit $rc, want 20"
		[[ $(cfg_hash "$root") == "$before" ]] || fail "status $status: config changed"
		grep -qF "openai" "$root/stderr" || fail "status $status: stderr does not name openai"
		assert_no_call "$root" "systemctl stop"
		assert_no_call "$root" "broker prepare"
	done
}

test_add_refuses_bad_provider() {
	local spec id want root rc before
	# A malformed id never reaches cmd_add: F4a1's parse_args rejects it as a usage error (64).
	for spec in "openai:20" "mistral:20" "Bad/ID:64"; do
		id=${spec%:*}; want=${spec##*:}
		root=$(make_sandbox "add_bad_$(printf '%s' "$id" | tr -c 'A-Za-z0-9' '_')" '["openai"]')
		set_reply "$root" gate-status:openai 0 "$(healthy openai)"
		before=$(cfg_hash "$root")
		rc=0; run_stage "$root" add "$id" || rc=$?
		(( rc == want )) || fail "add '$id': exit $rc, want $want"
		[[ $(cfg_hash "$root") == "$before" ]] || fail "add '$id': config changed"
		assert_no_call "$root" "systemctl stop"
		assert_no_call "$root" "broker prepare"
	done
}

test_add_refuses_when_not_generated() {
	local root rc=0 before; root=$(make_sandbox add_not_generated '["openai"]')
	set_reply "$root" gate-status:openai 0 "$(healthy openai)"
	set_reply "$root" verify-deployed-config 20 '{"ok":false,"mode":"raw-emergency"}'
	before=$(cfg_hash "$root")
	run_stage "$root" add anthropic || rc=$?
	(( rc == 20 )) || fail "exit $rc, want 20"
	[[ $(cfg_hash "$root") == "$before" ]] || fail "config changed"
	assert_no_call "$root" "systemctl stop"
	assert_no_call "$root" "broker gate-status"
}

test_add_canary_failure_keeps_timer_stopped() {
	local root rc=0; root=$(make_sandbox add_canary_fail '["openai"]')
	set_reply "$root" gate-status:openai 0 "$(healthy openai)"
	set_reply "$root" canary:anthropic 20 '{"ok":false,"reason":"probe-failed"}'
	run_stage "$root" add anthropic || rc=$?
	(( rc == 1 )) || fail "exit $rc, want 1"
	[[ $(providers_of "$root") == '["openai","anthropic"]' ]] || fail "providers: $(providers_of "$root")"
	assert_order "$root" "broker commit --provider anthropic --json" "broker canary --provider anthropic --json"
	assert_no_call "$root" "systemctl enable --now opencode-model-reconcile.timer"
	assert_no_call "$root" "broker gate-start"
	grep -qF "rollback --provider anthropic" "$root/stderr" || fail "stderr lacks the recovery command"
	assert_lock_held_throughout "$root"
}

test_add_restart_failure_stops_before_prepare() {
	local root rc=0; root=$(make_sandbox add_restart_fail '["openai"]')
	set_reply "$root" gate-status:openai 0 "$(healthy openai)"
	: >"$root/fail-restart"
	run_stage "$root" add anthropic || rc=$?
	(( rc == 1 )) || fail "exit $rc, want 1"
	assert_no_call "$root" "broker prepare"
	assert_no_call "$root" "systemctl enable"
	grep -qF "rollback --provider anthropic" "$root/stderr" || fail "stderr lacks the recovery command"
}

# ---------------------------------------------------------------------------
# gate <provider>
# ---------------------------------------------------------------------------

test_gate_completes_when_eligible() {
	local root rc=0; root=$(make_sandbox gate_eligible '["openai","anthropic"]')
	set_reply "$root" gate-status:anthropic 0 '{"ok":true,"provider":"anthropic","status":"gate-running","eligible":true,"reason":"eligible"}'
	set_reply "$root" gate-complete:anthropic 0 '{"ok":true,"provider":"anthropic","status":"healthy"}'
	run_stage "$root" gate anthropic || rc=$?
	(( rc == 0 )) || { fail "exit $rc; stderr: $(cat "$root/stderr")"; return; }
	assert_order "$root" "broker gate-status --provider anthropic --json" "broker gate-complete --provider anthropic --json"
	assert_no_call "$root" "systemctl"
	assert_lock_held_throughout "$root"
}

test_gate_not_yet_eligible_is_quiet() {
	local root rc=0; root=$(make_sandbox gate_wait '["openai","anthropic"]')
	set_reply "$root" gate-status:anthropic 0 '{"ok":true,"provider":"anthropic","status":"gate-running","eligible":false,"reason":"under-24h"}'
	run_stage "$root" gate anthropic || rc=$?
	(( rc == 5 )) || fail "exit $rc, want 5"
	grep -qF "under-24h" "$root/stderr" || fail "stderr lacks the reason"
	assert_no_call "$root" "broker gate-complete"
}

test_gate_clock_regressed_needs_attention() {
	local root rc=0; root=$(make_sandbox gate_clock '["openai","anthropic"]')
	set_reply "$root" gate-status:anthropic 0 '{"ok":true,"provider":"anthropic","status":"gate-running","eligible":false,"reason":"clock-regressed"}'
	run_stage "$root" gate anthropic || rc=$?
	(( rc == 20 )) || fail "exit $rc, want 20"
	grep -qF "clock-regressed" "$root/stderr" || fail "stderr lacks clock-regressed"
	assert_no_call "$root" "broker gate-complete"
}

test_gate_status_matrix() {
	local spec status want root rc
	for spec in "healthy:0" "committed:20" "failed:20" "rolled-back:20"; do
		status=${spec%:*}; want=${spec##*:}
		root=$(make_sandbox "gate_status_$status" '["openai","anthropic"]')
		set_reply "$root" gate-status:anthropic 0 "{\"ok\":true,\"provider\":\"anthropic\",\"status\":\"$status\",\"eligible\":false,\"reason\":\"x\"}"
		rc=0; run_stage "$root" gate anthropic || rc=$?
		(( rc == want )) || fail "status $status: exit $rc, want $want"
		assert_no_call "$root" "broker gate-complete"
	done
}

# ---------------------------------------------------------------------------
# rollback --provider <id>
# ---------------------------------------------------------------------------

test_rollback_provider_happy_path() {
	local root rc=0; root=$(make_sandbox rb_happy '["openai","anthropic"]')
	run_stage "$root" rollback --provider anthropic || rc=$?
	(( rc == 0 )) || { fail "exit $rc; stderr: $(cat "$root/stderr")"; return; }
	[[ $(providers_of "$root") == '["openai"]' ]] || fail "providers: $(providers_of "$root")"
	assert_order "$root" \
		"systemctl stop opencode-model-reconcile.timer" \
		"systemctl is-active --quiet opencode-model-reconcile.service" \
		"broker rollback-config --provider anthropic --json" \
		"systemctl restart opencode-model-broker.service opencode-gateway.service" \
		"systemctl is-active --quiet opencode-model-broker.service" \
		"systemctl is-active --quiet opencode-gateway.service" \
		"broker verify-deployed-config --json" \
		"systemctl enable --now opencode-model-reconcile.timer"
	assert_lock_held_throughout "$root"
	assert_no_call "$root" "devbox-sync"
}

test_rollback_refuses_last_provider() {
	local root rc=0 before; root=$(make_sandbox rb_last '["openai"]')
	before=$(cfg_hash "$root")
	run_stage "$root" rollback --provider openai || rc=$?
	(( rc == 20 )) || fail "exit $rc, want 20"
	[[ $(cfg_hash "$root") == "$before" ]] || fail "config changed"
	grep -qF "rollback --global" "$root/stderr" || fail "stderr does not point at rollback --global"
	assert_no_call "$root" "broker "
	assert_no_call "$root" "systemctl stop"
}

test_rollback_broker_failure_leaves_allowlist() {
	local root rc=0; root=$(make_sandbox rb_broker_fail '["openai","anthropic"]')
	set_reply "$root" rollback-config:anthropic 20 '{"ok":false,"reason":"checkpoint-mismatch"}'
	run_stage "$root" rollback --provider anthropic || rc=$?
	(( rc == 1 )) || fail "exit $rc, want 1"
	[[ $(providers_of "$root") == '["openai","anthropic"]' ]] || fail "providers: $(providers_of "$root")"
	assert_no_call "$root" "systemctl restart"
	assert_no_call "$root" "systemctl enable"
}

# ---------------------------------------------------------------------------
# Run everything
# ---------------------------------------------------------------------------

run_test add-happy-path                          test_add_happy_path
run_test add-refuses-unhealthy-gate              test_add_refuses_unhealthy_gate
run_test add-refuses-bad-provider                test_add_refuses_bad_provider
run_test add-refuses-when-not-generated          test_add_refuses_when_not_generated
run_test add-canary-failure-keeps-timer-stopped  test_add_canary_failure_keeps_timer_stopped
run_test add-restart-failure-stops-before-prepare test_add_restart_failure_stops_before_prepare
run_test gate-completes-when-eligible            test_gate_completes_when_eligible
run_test gate-not-yet-eligible-is-quiet          test_gate_not_yet_eligible_is_quiet
run_test gate-clock-regressed-needs-attention    test_gate_clock_regressed_needs_attention
run_test gate-status-matrix                      test_gate_status_matrix
run_test rollback-provider-happy-path            test_rollback_provider_happy_path
run_test rollback-refuses-last-provider          test_rollback_refuses_last_provider
run_test rollback-broker-failure-leaves-allowlist test_rollback_broker_failure_leaves_allowlist

echo
echo "passed: $PASSED  failed: $FAILED"
if (( FAILED > 0 )); then
	printf 'failures:\n'; printf '  - %s\n' "${FAILED_NAMES[@]}"
	exit 1
fi
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (in `/home/dev/devbox`): `bash tests/opencode-model-provider-stage-expand.test.sh`
Expected: FAIL. Each test reports a failure such as `FAIL: exit 2; stderr: ... not implemented in this task` or `exit 2, want 20`, because the three F4a1 stubs still exit 2. The last line before the failure list is `passed: 0  failed: 13`, and the exit status is 1.

- [ ] **Step 4: Implement the helpers and the three subcommands**

In `bin/opencode-model-provider-stage`, insert this block directly above `cmd_add`. Then replace the complete F4a1 stub definitions of `cmd_add`, `cmd_gate` and `cmd_rollback_provider` with the definitions below.

```bash
# ---------------------------------------------------------------------------
# Provider expansion: add <provider>, gate <provider>, rollback --provider <id>.
# Every function here runs with the expansion lock already held on fd 9 by the
# main dispatch, so a scheduled reconcile or watch run that fires meanwhile
# exits 5 on the held lock without writing.
#
# Exit codes: 0 done; 2 usage; 5 gate not yet eligible (quiet, run again
# later); 20 refused or needs attention, nothing changed by this run; 1 failed
# after a change began (loud stage_notify, recovery command in the message).
# ---------------------------------------------------------------------------

expand_fleet_config() {
	printf '%s\n' "${OPENCODE_RECONCILE_DEVBOX:-/home/dev/devbox}/config/opencode-broker/config.json"
}

expand_valid_id() {
	[[ ${1:-} =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
}

expand_refuse() {
	printf 'opencode-model-provider-stage: refused: %s\n' "$*" >&2
	exit 20
}

expand_fail() {
	local msg="$*"
	printf 'opencode-model-provider-stage: FAILED: %s\n' "$msg" >&2
	if ! stage_notify "opencode-model-provider-stage failed" "$msg"; then
		printf 'opencode-model-provider-stage: stage_notify also failed; the failure above was NOT pushed\n' >&2
	fi
	exit 1
}

# expand_config_query providers | enabled | trusted <id>
expand_config_query() {
	node -e '
		"use strict";
		const fs = require("fs");
		const [file, query, arg] = process.argv.slice(1);
		const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
		const apply = (cfg.reconcile && cfg.reconcile.apply) || {};
		const providers = Array.isArray(apply.providers) ? apply.providers : [];
		const trusted = Array.isArray(cfg.trustedSubscriptionProviders) ? cfg.trustedSubscriptionProviders : [];
		if (query === "providers") { for (const p of providers) console.log(p); }
		else if (query === "enabled") { console.log(apply.enabled === true ? "true" : "false"); }
		else if (query === "trusted") { console.log(trusted.includes(arg) ? "true" : "false"); }
		else { console.error("expand_config_query: unknown query " + query); process.exit(2); }
	' "$(expand_fleet_config)" "$@"
}

# Fills the global array EXPAND_PROVIDERS with reconcile.apply.providers, in order.
expand_load_providers() {
	local listing
	listing=$(expand_config_query providers) || expand_fail "cannot read reconcile.apply.providers from $(expand_fleet_config)"
	EXPAND_PROVIDERS=()
	if [[ -n $listing ]]; then
		mapfile -t EXPAND_PROVIDERS <<<"$listing"
	fi
}

# The broker reads ~/.config/opencode-broker/config.json, which devbox-sync links
# straight to the repo file, so an edit is live once that link resolves to it.
# devbox-sync is deliberately NOT run here: it re-enables every timer under
# systemd/, which would restart the reconcile timer before the canary passed.
expand_config_deployed() {
	local want got
	want=$(realpath -e -- "$(expand_fleet_config)") || return 1
	got=$(realpath -e -- "$HOME/.config/opencode-broker/config.json") || return 1
	[[ $got == "$want" ]]
}

expand_require_generated() {
	local out rc=0 ok mode
	broker_cli verify-deployed-config || rc=$?; out=$BROKER_OUT
	ok=$(json_get "$out" ok) || ok=""
	mode=$(json_get "$out" mode) || mode=""
	if [[ $rc -ne 0 || $ok != true || $mode != generated ]]; then
		printf 'opencode-model-provider-stage: verify-deployed-config exit %s ok=%s mode=%s\n' \
			"$rc" "${ok:-?}" "${mode:-?}" >&2
		return 1
	fi
}

expand_quiesce_reconcile() {
	sysd stop opencode-model-reconcile.timer || return 1
	# We hold the expansion lock, so a service started now exits 5 at once; an
	# active service here means some writer bypassed the lock.
	if sysd is-active --quiet opencode-model-reconcile.service; then
		return 1
	fi
}

expand_restart_broker_gateway() {
	sysd restart opencode-model-broker.service opencode-gateway.service || return 1
	sysd is-active --quiet opencode-model-broker.service || return 1
	sysd is-active --quiet opencode-gateway.service || return 1
}

# config_remove_provider <providerID>: atomic rewrite without that provider.
# Already absent -> exit 0 (an interrupted rollback can be re-run). Refuses to
# empty the list while apply is enabled (that is rollback --global territory).
config_remove_provider() {
	node -e '
		"use strict";
		const fs = require("fs");
		const path = require("path");
		const [file, provider] = process.argv.slice(1);
		const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
		const apply = cfg.reconcile && cfg.reconcile.apply;
		if (!apply || !Array.isArray(apply.providers)) {
			console.error("reconcile.apply.providers is missing in " + file);
			process.exit(1);
		}
		const next = apply.providers.filter((p) => p !== provider);
		if (next.length === apply.providers.length) process.exit(0);
		if (apply.enabled === true && next.length === 0) {
			console.error("refusing to empty reconcile.apply.providers while apply is enabled");
			process.exit(1);
		}
		apply.providers = next;
		const mode = fs.statSync(file).mode & 0o777;
		const tmp = path.join(path.dirname(file), "." + path.basename(file) + ".stage-" + process.pid);
		try {
			fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode, flag: "wx" });
			const fd = fs.openSync(tmp, "r");
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			fs.renameSync(tmp, file);
		} finally {
			fs.rmSync(tmp, { force: true });
		}
	' "$(expand_fleet_config)" "$1"
}

cmd_add() {
	local provider=${1:-} p out rc status enabled trusted expected after step
	if ! expand_valid_id "$provider"; then
		printf 'usage: opencode-model-provider-stage add <provider>   (id must match ^[a-z0-9][a-z0-9-]{0,62}$)\n' >&2
		exit 2
	fi
	enabled=$(expand_config_query enabled) || expand_fail "cannot read $(expand_fleet_config)"
	[[ $enabled == true ]] || expand_refuse "reconcile.apply.enabled is not true in $(expand_fleet_config); finish cutover first"
	trusted=$(expand_config_query trusted "$provider") || expand_fail "cannot read $(expand_fleet_config)"
	[[ $trusted == true ]] || expand_refuse "$provider is not in trustedSubscriptionProviders"
	expand_load_providers
	for p in "${EXPAND_PROVIDERS[@]}"; do
		if [[ $p == "$provider" ]]; then
			expand_refuse "$provider is already in reconcile.apply.providers"
		fi
	done
	expand_require_generated || expand_refuse "deployed OpenCode config is not a verified generated config"
	# A pending or failed gate blocks the next provider. Rolled-back providers
	# were removed from the allowlist, so every listed one must be healthy.
	for p in "${EXPAND_PROVIDERS[@]}"; do
		rc=0
		broker_cli gate-status --provider "$p" || rc=$?; out=$BROKER_OUT
		status=$(json_get "$out" status) || status=""
		if [[ $status != healthy ]]; then
			expand_refuse "provider $p gate is '${status:-unreadable}' (gate-status exit $rc); it must be healthy, or rolled back with 'rollback --provider $p', before another provider stage begins"
		fi
	done

	expand_quiesce_reconcile || expand_fail "could not quiesce opencode-model-reconcile (timer stop failed or service active); config untouched; the timer may be stopped"
	config_append_provider "$(expand_fleet_config)" "$provider" || expand_fail "config_append_provider $provider failed; inspect $(expand_fleet_config); reconcile timer left stopped"
	expected=$(printf '%s\n' "${EXPAND_PROVIDERS[@]}" "$provider")
	after=$(expand_config_query providers) || expand_fail "cannot re-read $(expand_fleet_config); run: opencode-model-provider-stage rollback --provider $provider"
	if [[ $after != "$expected" ]]; then
		expand_fail "reconcile.apply.providers is [${after//$'\n'/,}], expected [${expected//$'\n'/,}]; run: opencode-model-provider-stage rollback --provider $provider"
	fi
	expand_config_deployed || expand_fail "~/.config/opencode-broker/config.json does not resolve to $(expand_fleet_config); repair with devbox-sync, then run: opencode-model-provider-stage rollback --provider $provider"
	expand_restart_broker_gateway || expand_fail "broker or gateway not active after restart with $provider allowlisted; run: opencode-model-provider-stage rollback --provider $provider"
	for step in prepare commit canary; do
		rc=0
		broker_cli "$step" --provider "$provider" || rc=$?; out=$BROKER_OUT
		if (( rc != 0 )); then
			expand_fail "$step --provider $provider exited $rc: ${out:0:400}; reconcile timer left stopped; run: opencode-model-provider-stage rollback --provider $provider"
		fi
	done
	sysd enable --now opencode-model-reconcile.timer || expand_fail "canary passed but enabling opencode-model-reconcile.timer failed; enable it by hand, then run broker gate-start --provider $provider"
	rc=0
	broker_cli gate-start --provider "$provider" || rc=$?; out=$BROKER_OUT
	(( rc == 0 )) || expand_fail "gate-start --provider $provider exited $rc: ${out:0:400}; reconcile timer IS enabled; the provider gate is not recorded"
	printf 'opencode-model-provider-stage: %s prepared, committed and canaried; reconcile timer enabled; 24-hour gate started. Run "opencode-model-provider-stage gate %s" after 24 hours.\n' "$provider" "$provider"
}

cmd_gate() {
	local provider=${1:-} out rc=0 status eligible reason
	if ! expand_valid_id "$provider"; then
		printf 'usage: opencode-model-provider-stage gate <provider>\n' >&2
		exit 2
	fi
	broker_cli gate-status --provider "$provider" || rc=$?; out=$BROKER_OUT
	status=$(json_get "$out" status) || status=""
	case $status in
		healthy)
			printf 'opencode-model-provider-stage: gate for %s is already healthy\n' "$provider"
			return 0 ;;
		gate-running) ;;
		"") expand_fail "gate-status --provider $provider exited $rc with no readable status: ${out:0:400}" ;;
		*) expand_refuse "gate for $provider is '$status', not gate-running; nothing to complete" ;;
	esac
	eligible=$(json_get "$out" eligible) || eligible=""
	reason=$(json_get "$out" reason) || reason=""
	if [[ $eligible != true ]]; then
		if [[ $reason == clock-regressed ]]; then
			if ! stage_notify "provider gate clock regressed" "gate for $provider: wall clock is earlier than the gate start; gate not completed"; then
				printf 'opencode-model-provider-stage: stage_notify failed; this alert was NOT pushed\n' >&2
			fi
			expand_refuse "gate for $provider not completed: clock-regressed (wall clock earlier than gate start)"
		fi
		printf 'opencode-model-provider-stage: gate for %s not yet eligible: %s\n' "$provider" "${reason:-no reason given}" >&2
		exit 5
	fi
	rc=0
	broker_cli gate-complete --provider "$provider" || rc=$?; out=$BROKER_OUT
	status=$(json_get "$out" status) || status=""
	if (( rc != 0 )) || [[ $status != healthy ]]; then
		expand_fail "gate-complete --provider $provider exited $rc with status '${status:-unreadable}': ${out:0:400}"
	fi
	printf 'opencode-model-provider-stage: gate for %s is healthy; the next provider stage may begin\n' "$provider"
}

cmd_rollback_provider() {
	local provider=${1:-} p out rc=0
	local -a remaining=()
	if ! expand_valid_id "$provider"; then
		printf 'usage: opencode-model-provider-stage rollback --provider <id>\n' >&2
		exit 2
	fi
	expand_load_providers
	for p in "${EXPAND_PROVIDERS[@]}"; do
		if [[ $p != "$provider" ]]; then
			remaining+=("$p")
		fi
	done
	if (( ${#remaining[@]} == 0 )); then
		expand_refuse "rolling back $provider would leave reconcile.apply.providers empty; generation 0 and the old watch are reserved for global failure: use 'opencode-model-provider-stage rollback --global'"
	fi
	expand_quiesce_reconcile || expand_fail "could not quiesce opencode-model-reconcile; no rollback performed"
	# Broker first: it restores the pre-stage checkpoint (generation, manifest,
	# ledger revision, broker policy revision) while the running broker still
	# knows the provider. Only then is the provider removed from the allowlist.
	broker_cli rollback-config --provider "$provider" || rc=$?; out=$BROKER_OUT
	(( rc == 0 )) || expand_fail "rollback-config --provider $provider exited $rc: ${out:0:400}; allowlist unchanged; reconcile timer left stopped"
	config_remove_provider "$provider" || expand_fail "broker checkpoint restored but removing $provider from $(expand_fleet_config) failed; reconcile timer left stopped"
	expand_config_deployed || expand_fail "~/.config/opencode-broker/config.json does not resolve to $(expand_fleet_config); reconcile timer left stopped"
	expand_restart_broker_gateway || expand_fail "broker or gateway not active after provider rollback of $provider; reconcile timer left stopped"
	expand_require_generated || expand_fail "after provider rollback of $provider the deployed config is not a verified generated config; reconcile timer left stopped; consider rollback --global"
	sysd enable --now opencode-model-reconcile.timer || expand_fail "provider rollback of $provider done but enabling opencode-model-reconcile.timer failed"
	if ! stage_notify "provider rollback: $provider" "restored the $provider pre-stage checkpoint, removed it from reconcile.apply.providers, restarted broker and gateway; reconcile timer re-enabled for: ${remaining[*]}"; then
		printf 'opencode-model-provider-stage: stage_notify failed; the rollback notice was NOT pushed\n' >&2
	fi
	printf 'opencode-model-provider-stage: %s rolled back; providers now: %s\n' "$provider" "${remaining[*]}"
}
```

- [ ] **Step 5: Run the tests to verify they pass, with no regression in the F4a1/F4a2 suites**

Run (in `/home/dev/devbox`):
```bash
bash tests/opencode-model-provider-stage-expand.test.sh
for t in tests/opencode-model-provider-stage*.test.sh; do bash "$t" || echo "REGRESSION: $t"; done
bash -n bin/opencode-model-provider-stage && echo syntax-ok
```
Expected: the first command ends with `passed: 13  failed: 0` and exits 0. The loop prints no `REGRESSION:` line. The final command prints `syntax-ok`.

- [ ] **Step 6: Prove red/green with the implementation stashed**

Run (in `/home/dev/devbox`):
```bash
git add tests/opencode-model-provider-stage-expand.test.sh
git stash push -m "f4b red-green" -- bin/opencode-model-provider-stage
if bash tests/opencode-model-provider-stage-expand.test.sh; then echo "UNEXPECTED: tests passed without the implementation"; fi
git stash pop
bash tests/opencode-model-provider-stage-expand.test.sh
```
Expected: the stashed run ends with `failed: 13` and does not print `UNEXPECTED`. After `git stash pop`, the run ends with `passed: 13  failed: 0`. The stash only works if this task's script edits are still uncommitted; F4a1/F4a2 are already committed and stay in place.

- [ ] **Step 7: Commit**

```bash
git -C /home/dev/devbox add bin/opencode-model-provider-stage tests/opencode-model-provider-stage-expand.test.sh
git -C /home/dev/devbox --no-pager diff --cached --stat
git -C /home/dev/devbox commit -m "opencode-model-provider-stage: add, gate and provider rollback subcommands

add <provider> refuses unless every allowlisted provider's gate is healthy, appends
exactly one provider, restarts broker and gateway, runs prepare/commit/canary under
the held expansion lock, and re-enables the reconcile timer only after canary
success before starting the 24-hour gate. gate <provider> completes only when the
broker reports eligibility (clock-regressed alerts). rollback --provider restores
the broker checkpoint first, then removes only that provider and keeps the
scheduler; it refuses to empty the allowlist."
```
Expected: `--stat` lists exactly these 2 paths, and the commit succeeds. Do not stage any of the never-stage plan or spec files listed in Global Constraints. Do not push.

### Task F5: Fleet documentation and changelog for the Package 4 cutover

**Files:**
- Modify: `README.md` (one Commands-table row after the `devbox-sync` row on line 28; a new `## Model reconciliation (opencode-broker Package 4)` section inserted between line 137 and `## Monitoring` on line 139)
- Modify: `docs/TIMERS.md` (a new `## Timers that share a lock` section inserted before `## Timers that are NOT in this system` on line 72)
- Modify: `CHANGELOG.md` (entries added at the top of the existing `## [Unreleased]` → `### Changed` on line 5 and `### Added` on line 48. No version heading is added.)
- Create: `tests/model-reconcile-docs.test.mjs`

**Interfaces:**
- Consumes (F1): `systemd/opencode-model-reconcile.service` and `systemd/opencode-model-watch.service`. Each `ExecStart=` line contains `flock -n -E 5 %h/.local/share/opencode/model-routing/provider-expansion.lock ` followed by the command. `systemd/opencode-model-reconcile.timer` has an `[X-Job]` `Name=<job>` line. By repo convention this plan expects `Name=opencode-model-reconcile`, and the test reads the real value.
- Consumes (F2): the shell function name `converge_opencode_config` in `bin/devbox-sync`, and the verifier modes `pre-bootstrap` | `generated` | `raw-emergency` | `invalid` from `verify-deployed-config --json`.
- Consumes (F3): `config/opencode/skills/model-reconciliation-approval/SKILL.md`.
- Consumes (F4): the executable `bin/opencode-model-provider-stage` with these subcommands: `preflight`, `cutover`, `add <provider>`, `gate <provider>`, `rollback --global`, `rollback --provider <id>`.
- Produces: `tests/model-reconcile-docs.test.mjs` with 4 `node:test` cases. It pins the docs to the unit files' lock path, the timer's job name, and the stage script's subcommand forms. Produces the README heading `## Model reconciliation (opencode-broker Package 4)` and the TIMERS.md heading `## Timers that share a lock`. Both are referenced by the Operator runbook below.

F5 must be executed after F1–F4 are committed. Its test reads their artifacts.

- [ ] **Step 1: Write the failing test**

Create `tests/model-reconcile-docs.test.mjs`:

```js
// Documentation drift pins for opencode-broker Package 4 (model reconciliation cutover).
// README.md, docs/TIMERS.md and CHANGELOG.md describe the singleton-writer lock, the units that
// take it, the reconcile job's heartbeat name and the operator stage script. These tests read the
// real unit files and fail when a lock path, job name or subcommand form changes without the docs
// following -- an operator reading a stale lock path during a cutover is the failure this prevents.
import assert from "node:assert/strict";
import test from "node:test";
import { accessSync, constants, readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const LOCK_UNIT_PATH = "%h/.local/share/opencode/model-routing/provider-expansion.lock";
const LOCK_DOC_PATH = "~/.local/share/opencode/model-routing/provider-expansion.lock";
const LOCKED_SERVICES = ["opencode-model-reconcile.service", "opencode-model-watch.service"];
const LOCKED_TIMERS = ["opencode-model-reconcile.timer", "opencode-model-watch.timer"];
const STAGE_FORMS = [
  "opencode-model-provider-stage preflight",
  "opencode-model-provider-stage cutover",
  "opencode-model-provider-stage add <provider>",
  "opencode-model-provider-stage gate <provider>",
  "opencode-model-provider-stage rollback --provider <id>",
  "opencode-model-provider-stage rollback --global",
];
const VERIFIER_MODES = ["pre-bootstrap", "generated", "raw-emergency", "invalid"];

// The lock path a unit's ExecStart passes to `flock -n -E 5`. Matches `flock` and `/usr/bin/flock`.
const execStartLockPath = (unitText, unitName) => {
  const execStart = unitText.split("\n").find((line) => line.startsWith("ExecStart="));
  assert.ok(execStart, `${unitName} has no ExecStart= line`);
  const match = execStart.match(/flock -n -E 5 (\S+) /);
  assert.ok(match, `${unitName} ExecStart does not run under "flock -n -E 5 <lock>": ${execStart}`);
  return match[1];
};

// The text between "## [Unreleased]" and the next "## [" heading.
const unreleasedBlock = (changelog) => {
  const marker = "## [Unreleased]";
  const start = changelog.indexOf(marker);
  assert.notEqual(start, -1, "CHANGELOG.md has no [Unreleased] section");
  const rest = changelog.slice(start + marker.length);
  const next = rest.search(/^## \[/m);
  return next === -1 ? rest : rest.slice(0, next);
};

test("both reconciliation-state services run under the lock the README documents", () => {
  const readme = read("README.md");
  for (const unit of LOCKED_SERVICES) {
    assert.equal(execStartLockPath(read(`systemd/${unit}`), unit), LOCK_UNIT_PATH);
    assert.ok(readme.includes(`\`${unit}\``), `README does not name ${unit}`);
  }
  for (const timer of LOCKED_TIMERS) {
    assert.ok(readme.includes(`\`${timer}\``), `README does not name ${timer}`);
  }
  assert.ok(
    readme.includes(`flock -n -E 5 ${LOCK_DOC_PATH}`),
    `README does not show the lock form "flock -n -E 5 ${LOCK_DOC_PATH}"`,
  );
});

test("README documents the stage script, the reconcile job name and the outer-link modes", () => {
  const readme = read("README.md");
  assert.match(readme, /^## Model reconciliation \(opencode-broker Package 4\)$/m);
  const jobName = read("systemd/opencode-model-reconcile.timer").match(/^Name=(\S+)/m);
  assert.ok(jobName, "opencode-model-reconcile.timer has no [X-Job] Name=");
  assert.ok(readme.includes(`\`${jobName[1]}\``), `README does not name the reconcile job ${jobName[1]}`);
  for (const form of STAGE_FORMS) assert.ok(readme.includes(form), `README is missing "${form}"`);
  for (const mode of VERIFIER_MODES) assert.ok(readme.includes(`\`${mode}\``), `README is missing mode ${mode}`);
  assert.ok(readme.includes("verify-deployed-config --json"), "README does not name the verifier command");
  assert.ok(readme.includes("`converge_opencode_config`"), "README does not name converge_opencode_config");
  assert.ok(readme.includes("model-reconciliation-approval"), "README does not name the approval skill");
  accessSync(new URL("../bin/opencode-model-provider-stage", import.meta.url), constants.X_OK);
});

test("docs/TIMERS.md records the timers that share the lock", () => {
  const timers = read("docs/TIMERS.md");
  assert.match(timers, /^## Timers that share a lock$/m);
  for (const timer of LOCKED_TIMERS) {
    assert.ok(timers.includes(`\`${timer}\``), `docs/TIMERS.md does not name ${timer}`);
  }
  assert.ok(timers.includes(LOCK_DOC_PATH), "docs/TIMERS.md does not name the lock path");
});

test("CHANGELOG [Unreleased] carries the Package 4 fleet entries", () => {
  const block = unreleasedBlock(read("CHANGELOG.md"));
  for (const needle of [
    "opencode-model-reconcile.timer",
    "opencode-model-provider-stage",
    "model-reconciliation-approval",
    "converge_opencode_config",
    "provider-expansion.lock",
    "watch.notifyCommand",
  ]) {
    assert.ok(block.includes(needle), `CHANGELOG [Unreleased] does not mention ${needle}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (workdir `/home/dev/devbox`): `node --test tests/model-reconcile-docs.test.mjs`
Expected: FAIL. The summary shows `# pass 0` and `# fail 4`, and each case fails with an `AssertionError`:
- test 1: `README does not name opencode-model-reconcile.service`
- test 2: `The input did not match the regular expression /^## Model reconciliation \(opencode-broker Package 4\)$/m`
- test 3: `The input did not match the regular expression /^## Timers that share a lock$/m`
- test 4: `CHANGELOG [Unreleased] does not mention opencode-model-reconcile.timer`

If test 1 instead fails on the lock-path `assert.equal`, or on `ExecStart does not run under "flock -n -E 5 <lock>"`, then F1 is not committed or differs from the contract. Stop and fix F1 before continuing; do not change the test.

- [ ] **Step 3: Add the README Commands row**

In `README.md`, insert this row directly after the table row that begins ``| `devbox-sync [--timers] [--prune] [--no-pull] [--no-config] [--dry-run]` |`` (line 28):

```markdown
| `opencode-model-provider-stage <subcommand>` | Run by hand: the staged model-reconciliation cutover and one-provider-at-a-time expansion. See "Model reconciliation" below. |
```

- [ ] **Step 4: Add the README section**

In `README.md`, insert this block after the paragraph ending ``are not jobs: they are linked and enabled by hand once (see the`` / ``comment in each unit).`` (line 137) and before `## Monitoring`. Leave one blank line on each side.

````markdown
## Model reconciliation (opencode-broker Package 4)

opencode-broker's reconciler (`opencode-broker-reconcile`, opencode-broker 1.25.0) keeps OpenCode's
resolver config in immutable generations under `~/.local/share/opencode/model-routing/`. Once
cut over, it is the only writer of that state and of the ledger's `configCutover` record. devbox
owns everything around it: the schedule, the deployed config link, the approval skill and the
operator script. Design:
https://git.arch.fyi/flan/opencode-broker/src/branch/main/docs/superpowers/specs/2026-10-01-provider-model-reconciliation-package-4-design.md

### Two units, one writer

| Units | Job | Writes when |
|---|---|---|
| `opencode-model-reconcile.service`, `opencode-model-reconcile.timer` (daily, `Persistent=true`, `RandomizedDelaySec=1h`) | `opencode-model-reconcile` | only when `reconcile.apply.enabled` is true and the ledger's `configCutover.mode` is `generated`. When apply is off, or there is no `configCutover`, it runs a dry-run that publishes nothing. Under `raw-emergency` it exits 5. |
| `opencode-model-watch.service`, `opencode-model-watch.timer` (daily) | `opencode-model-watch` | before cutover, and again under `raw-emergency`. Once `configCutover.mode` is `generated` it exits 5 and writes its reason to stderr. |

**The lock keeps it to one writer; timer state does not.** `devbox-sync --timers` re-enables every
timer under `systemd/` on each hourly run, so a `systemctl --user disable` lasts an hour at most.
Both services therefore run their command as
`flock -n -E 5 ~/.local/share/opencode/model-routing/provider-expansion.lock ...` (the units write
it with `%h`). `opencode-model-provider-stage` holds that lock on fd 9 for its whole run. A timer
that fires during that time exits 5, which `job-run` records as "ran, nothing to report": no push,
a success heartbeat, and no work done. Never delete the lock file. An idle inode is harmless,
and the kernel decides who holds the lock, not the file's presence or mtime. The broker commands
never take the lock themselves. Run by the stage script, they inherit the held descriptor.

### `opencode-model-provider-stage`

`~/fleet-core/bin/opencode-model-provider-stage` (real path `~/devbox/bin/`) is run by Holden,
one stage at a time. It takes the lock with `flock -w 5`, and a timeout exits nonzero and alerts.
It stops `opencode-model-reconcile.timer` and `opencode-model-watch.timer` for the duration of
the run. When a stage needs it, it restarts `opencode-model-broker.service` and
`opencode-gateway.service`. Existing OpenCode TUIs are never killed.

| Command | Does |
|---|---|
| `opencode-model-provider-stage preflight` | Changes nothing. Checks the compatibility topology: `~/fleet-core` resolves to `~/devbox`, and the outer config link resolves through `~/fleet-core/config/opencode/opencode.json` to the raw base, which must be a regular 0600 file. Also checks that the approval skill's source, compatibility and deployed paths are one regular file with matching SHA-256. |
| `opencode-model-provider-stage cutover` | Runs design steps 2-7 with apply disabled throughout: generation-0 bootstrap, the manual dry-run, the legacy-ledger baseline, quiescing the old watch, the final delta import, and the `configCutover` switch of the outer config link. Re-running it completes an interrupted outer-link retarget from the ledger's evidence. |
| `opencode-model-provider-stage add <provider>` | Adds exactly one provider to `reconcile.apply.providers` (the first one also enables apply). Then it restarts the broker and gateway and runs prepare, commit and the manual canary with no scheduled writer running. Refused while another provider's 24-hour gate is pending or failed. |
| `opencode-model-provider-stage gate <provider>` | Evaluates that provider's persisted 24-hour health gate. |
| `opencode-model-provider-stage rollback --provider <id>` | Restores the pre-stage checkpoint and removes only that provider. The scheduler and earlier healthy providers stay. |
| `opencode-model-provider-stage rollback --global` | Raw-emergency rollback. The outer config link goes back to `~/devbox/config/opencode/opencode.json`, and the old watch becomes the authorized writer again. |

### The deployed config link

`devbox-sync` no longer links `~/.config/opencode/opencode.json` in its generic config loop.
Instead, `converge_opencode_config` runs
`node ~/opencode-broker/bin/opencode-broker-reconcile verify-deployed-config --json` and follows
the mode that command reports. It never writes the ledger, and it never infers a mode from which
files happen to exist.

| Verifier mode | devbox-sync does |
|---|---|
| `pre-bootstrap` | keeps the raw link to `~/fleet-core/config/opencode/opencode.json`. This mode means there are no ledger records and no generation artifacts. |
| `generated` | preserves or recreates exactly the link to `~/.local/share/opencode/model-routing/resolver-generations/current/opencode.json`, and only when the verifier says `ok` |
| `raw-emergency` | preserves or recreates exactly the link to `~/devbox/config/opencode/opencode.json`, and only when the verifier says `ok` |
| `invalid`, or the verifier fails | changes nothing, prints the error and exits nonzero. This includes the moment between the ledger switching to `generated` and the link being retargeted, which a re-run of `opencode-model-provider-stage cutover` completes. |

The approval skill, `config/opencode/skills/model-reconciliation-approval/SKILL.md`, is deployed
through the existing skills-directory link. If `preflight` finds it missing or mismatched, Holden
runs `devbox-sync` to repair the link and then runs `preflight` again. Never do this during a
cutover.
````

- [ ] **Step 5: Add the docs/TIMERS.md section**

In `docs/TIMERS.md`, insert this block directly before the line `## Timers that are NOT in this system` (line 72), followed by one blank line:

```markdown
## Timers that share a lock

Added 2026-10 with opencode-broker 1.25.0 (Package 4). This section stays current even though
the placement table above is historical. Two timers on `code` write model-reconciliation state,
and neither may mutate while the other is mutating or while Holden is running
`opencode-model-provider-stage`:

| Timer | Mutation-capable when |
| --- | --- |
| `opencode-model-reconcile.timer` | `reconcile.apply.enabled` is true and the ledger's `configCutover.mode` is `generated` |
| `opencode-model-watch.timer` | the ledger has no `configCutover`, or its mode is `raw-emergency` |

Neither placement nor `systemctl --user disable` solves this, because `devbox-sync --timers`
re-enables every timer under `systemd/` within the hour. So both timers stay installed and
enabled. The ledger data decides which one may write, and a kernel lock serializes them:
both services run their command under `flock -n -E 5` on
`~/.local/share/opencode/model-routing/provider-expansion.lock`. A timer that fires while the
lock is held exits 5 (quiet success) and does nothing. Do not delete the lock file.
```

- [ ] **Step 6: Add the CHANGELOG entries**

In `CHANGELOG.md`, under `## [Unreleased]`, insert the following directly after the line `### Changed` on line 5 (before the line beginning `- **Subscription providers go through`):

```markdown
- **One writer for model-routing state, enforced by a kernel lock.** `opencode-model-reconcile.service`
  and `opencode-model-watch.service` both run under `flock -n -E 5` on
  `~/.local/share/opencode/model-routing/provider-expansion.lock`.
  `opencode-model-provider-stage` holds that lock for its whole run, so a timer that fires
  mid-cutover or mid-expansion exits 5 and does nothing. Disabling a timer could not do this,
  because `devbox-sync --timers` re-enables every timer hourly. Once the ledger's
  `configCutover.mode` is `generated`, the old watch also exits 5 by itself.
- **`devbox-sync` follows the reconciliation ledger for `~/.config/opencode/opencode.json`.** The
  link has left the generic config loop. Before bootstrap, `converge_opencode_config` keeps the
  link on the raw base. After that it preserves exactly the target that
  `opencode-broker-reconcile verify-deployed-config` reports as `ok`: `resolver-generations/current/opencode.json`
  in generated mode, or the devbox raw base under raw-emergency. An invalid or unreadable state
  makes the sync fail loudly with no link change. It never quietly relinks to the raw base.
```

Then insert the following directly after the line `### Added` on line 48 (before the line beginning `- **A tappable tmux session switcher`):

```markdown
- **Staged model-reconciliation cutover (opencode-broker 1.25.0, Package 4).**
  `systemd/opencode-model-reconcile.service` and `systemd/opencode-model-reconcile.timer` (daily,
  `Persistent=true`, `RandomizedDelaySec=1h`, through `job-run`) run
  `opencode-broker-reconcile scheduled-run`. `bin/opencode-model-provider-stage` (`preflight`,
  `cutover`, `add <provider>`, `gate <provider>`, `rollback --global`, `rollback --provider <id>`)
  is the operator's single entry point for the generation-0 cutover and for each provider
  expansion. `config/opencode/skills/model-reconciliation-approval/SKILL.md` is the approval skill,
  deployed by the existing skills link. `config/opencode-broker/config.json` gains
  `reconcile.apply` with `enabled: false` and `providers: ["openai"]`. It ships disabled, and the
  stage script turns providers on one at a time, each behind a 24-hour health gate.
  `watch.notifyCommand` stays: burn-watch and slot-watch still use it, and the reconciler falls
  back to it when `reconcile.notifyCommand` is unset.
```

- [ ] **Step 7: Run the test to verify it passes**

Run (workdir `/home/dev/devbox`): `node --test tests/model-reconcile-docs.test.mjs`
Expected: PASS, with `# pass 4` and `# fail 0`.

If test 2 fails on `README does not name the reconcile job <name>`, then F1 chose a timer `Name=` other than `opencode-model-reconcile`. Correct the job name in the README table and in the runbook's job-log path `~/.local/state/devbox/logs/opencode-model-reconcile/` to the real name. Do not change the unit.

- [ ] **Step 8: Run the full fleet suites to confirm nothing else moved**

Run (workdir `/home/dev/devbox`): `python3 tests/devbox-jobs.test.py && node --test tests/*.test.mjs`
Expected: PASS with zero failures. The README edit touches no code path that these suites exercise. Any failure here comes from F1–F4 and must be fixed there before this commit.

- [ ] **Step 9: Commit**

Run from workdir `/home/dev/devbox`:

```bash
git add README.md docs/TIMERS.md CHANGELOG.md tests/model-reconcile-docs.test.mjs
git commit -m "docs: document the model-reconciliation units, shared lock and provider stage script"
```

Do not stage `docs/superpowers/plans/2026-09-22-routing-live-app-cutover.md`, `docs/superpowers/plans/2026-09-22-routing-retirement.md`, `docs/superpowers/plans/2026-09-29-tandoor-router-cutover.md`, or `docs/superpowers/specs/2026-09-29-tandoor-router-cutover-design.md`.

---

## Release

### Task R1: Release opencode-broker 1.25.0

Runs last, after every B and F task is committed and reviewed. It changes only release metadata in
`/home/dev/opencode-broker`; the fleet CHANGELOG entry was written by Task F5 in the same batch.

**Files:**
- Modify: `/home/dev/opencode-broker/CHANGELOG.md` (rename the `## [Unreleased]` heading only)
- Modify: `/home/dev/opencode-broker/package.json` (`"version"`)

**Interfaces:**
- Consumes: every Package 4 entry Task B9 appended under `## [Unreleased]`, plus the entries Holden
  already wrote there before Package 4 (session-bound gateway requests, per-tier local share,
  `planUsage.keyFile`, and the three fixes). Those pre-existing entries ship in this release too;
  they are not reworded, reordered, or dropped.
- Produces: version `1.25.0` in `package.json` and a `## [1.25.0] — <release date>` heading; no new
  `## [Unreleased]` heading is added (the repo convention adds it when the next change lands).

- [ ] **Step 1: Confirm the release inputs before editing**

Run:
```bash
cd /home/dev/opencode-broker
git --no-pager status --short
grep -n '^## \[' CHANGELOG.md | head -3
node -p 'require("./package.json").version'
test ! -e package-lock.json && echo "no lockfile"
```
Expected:
- status shows ONLY ` M docs/superpowers/plans/2026-09-29-broker-native-classifier-routing.md`
  (the unrelated plan that is never staged); anything else stops the release until explained.
- The first heading is `## [Unreleased]`, the second `## [1.24.0] — 2026-09-30`.
- Version prints `1.24.0`; `no lockfile` prints.

- [ ] **Step 2: Run the full suite on the tree being released (must be green before editing)**

Run:
```bash
cd /home/dev/opencode-broker
node --test tests/*.mjs
node --test gateway/tests/*.mjs
npm test
git --no-pager diff --check
```
Expected: every command exits 0; the TAP summaries report `fail 0`. Record the three `pass` counts
for the release report. Any failure stops R1 and goes back to the owning task.

- [ ] **Step 3: Rename the heading and bump the version in one edit set**

Replace the single line `## [Unreleased]` in `CHANGELOG.md` with (use the actual UTC release date):
```markdown
## [1.25.0] — 2026-10-02
```
In `package.json` change:
```json
  "version": "1.24.0",
```
to:
```json
  "version": "1.25.0",
```

- [ ] **Step 4: Verify the metadata agrees**

Run:
```bash
cd /home/dev/opencode-broker
node -e 'const v=require("./package.json").version; const h=require("fs").readFileSync("CHANGELOG.md","utf8").match(/^## \[([^\]]+)\] — (\d{4}-\d{2}-\d{2})$/m); if(v!=="1.25.0"||!h||h[1]!=="1.25.0") {console.error("mismatch",v,h&&h[1]); process.exit(1)} console.log("release metadata ok", v, h[2])'
grep -c '^## \[Unreleased\]' CHANGELOG.md || true
npm test
git --no-pager diff --check
```
Expected: `release metadata ok 1.25.0 <date>`; the Unreleased count prints `0`; `npm test` exits 0
with `fail 0`; `diff --check` prints nothing.

- [ ] **Step 5: Commit**

```bash
cd /home/dev/opencode-broker
git add CHANGELOG.md package.json
git --no-pager diff --cached --name-only
git commit -m "release: 1.25.0 provider reconciliation fleet cutover"
```
Expected: the cached name list is exactly `CHANGELOG.md` and `package.json`. No push in this task;
pushing both repos is the first step of the Operator runbook deploy.

## Operator runbook

**Who:** Holden runs every command in this runbook, either at a terminal or through an OpenCode agent session he directs. No timer, workflow or unattended agent performs any of these steps. Each stage has expected outputs and abort criteria. If a stage's output does not match, stop at that stage. Do not edit the ledger, registry, generation directories or symlinks by hand at any point: `opencode-broker-reconcile` is the only transition writer.

**Broker version requirement:** This runbook requires broker 1.25.0 or later. A broker older than 1.25.0 cannot read the v2 ledger, so a version downgrade requires restoring the pre-cutover ledger backup.

**Prerequisites (all must hold before R0):**
- Every broker task B1–B9 and fleet task F1–F5 is committed, and R1 is committed: broker `CHANGELOG.md` has `## [1.25.0] — <release date>`, and `package.json` is `1.25.0` in the same commit.
- `npm test` in `/home/dev/opencode-broker` passes (R1's full verification output is captured).
- `python3 tests/devbox-jobs.test.py && node --test tests/*.test.mjs` in `/home/dev/devbox` passes.
- The time is outside 23:30–01:30 local. Both daily timers fire at 00:00 plus up to 1h of random delay, and the lock makes them harmless during stage runs. The window still matters for the global rollback drill, because the lock is released between its two halves.

**Session setup.** Holden pastes this once per shell. The evidence directory is the durable audit record that the spec requires and is kept permanently.

```bash
STATE=/home/dev/.local/share/opencode/model-routing
LEDGER=$STATE/model-reconciliation.json
LOCK=$STATE/provider-expansion.lock
RAW_BASE=/home/dev/devbox/config/opencode/opencode.json
OUTER_LINK=/home/dev/.config/opencode/opencode.json
GEN_TARGET=$STATE/resolver-generations/current/opencode.json
STAGE=/home/dev/fleet-core/bin/opencode-model-provider-stage
EVID=/home/dev/.local/state/devbox/p4-cutover
mkdir -p -m 700 "$EVID"
reconcile() { node /home/dev/opencode-broker/bin/opencode-broker-reconcile "$@"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
ledger() {
  node -e '
    const fs = require("fs");
    const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((o, k) => (o == null ? undefined : o[k]), state);
    process.stdout.write(JSON.stringify(value === undefined ? null : value) + "\n");
  ' "$LEDGER" "$1"
}
tuis_alive() { while read -r pid start; do [ "$(ps -o lstart= -p "$pid" 2>/dev/null)" = "$start" ] || echo "GONE: $pid"; done < "$EVID/tui-pids.txt"; }
```

### R0: Pre-deploy topology check (design step 0, manual half)

This runs before anything new is deployed, because the stage script does not exist on disk yet.

```bash
readlink -f /home/dev/fleet-core
readlink "$OUTER_LINK"
readlink -f "$OUTER_LINK"
stat -c '%F %a' "$RAW_BASE"
sha "$RAW_BASE" | tee "$EVID/raw-base-hash-predeploy.txt"
/home/dev/fleet-core/bin/gateway-models > "$EVID/gateway-models-before.json"
for pid in $(pgrep -x opencode); do echo "$pid $(ps -o lstart= -p "$pid")"; done > "$EVID/tui-pids.txt"; wc -l < "$EVID/tui-pids.txt"
```

Expected, line by line:
- `/home/dev/devbox`
- `/home/dev/fleet-core/config/opencode/opencode.json`
- `/home/dev/devbox/config/opencode/opencode.json`
- `regular file 600`
- a 64-hex hash
- `gateway-models` exits 0
- a TUI count of at least 1, matching the TUIs Holden has open

Abort criteria:
- If any `readlink` differs, stop. Package 4 does not create or repair the compatibility symlink.
- If the mode is `644`, Holden runs `chmod 600 "$RAW_BASE"` and re-runs `stat`. git records only the exec bit, so this does not dirty the checkout.
- If the TUI count is 0 while TUIs are visibly open, `pgrep -x` does not match the TUI's process name on this host. Holden records each TUI's PID by hand as `<pid> <lstart>` lines in `$EVID/tui-pids.txt` before continuing.

### R1-deploy: Deploy with apply disabled (design step 1)

```bash
node -e 'const c=JSON.parse(require("fs").readFileSync("/home/dev/devbox/config/opencode-broker/config.json","utf8").replace(/^\s*\/\/.*$/gm,""));console.log(JSON.stringify(c.reconcile.apply.enabled), JSON.stringify(c.reconcile.apply.providers))'
git -C /home/dev/opencode-broker --no-pager diff --name-only | grep -E '^(CHANGELOG\.md|package\.json)$' && { echo "CHANGELOG.md or package.json has uncommitted changes not made by Package 4 tasks; Holden must commit them first"; exit 1; } || true
git -C /home/dev/opencode-broker --no-pager status --short
git -C /home/dev/devbox --no-pager status --short
git -C /home/dev/opencode-broker push origin main
git -C /home/dev/devbox push origin main
/home/dev/fleet-core/bin/devbox-sync --timers; echo "devbox-sync exit $?"
systemctl --user restart opencode-model-broker.service opencode-gateway.service
systemctl --user is-active opencode-model-broker.service opencode-gateway.service
systemctl --user list-timers --all --no-pager | grep -E 'opencode-model-(reconcile|watch)\.timer'
systemctl --user cat opencode-model-reconcile.service opencode-model-watch.service | grep '^ExecStart='
reconcile verify-deployed-config --json | tee "$EVID/verify-predeploy.json"; echo "verify exit ${PIPESTATUS[0]}"
readlink "$OUTER_LINK"
/home/dev/fleet-core/bin/gateway-models | diff "$EVID/gateway-models-before.json" - && echo "gateway models unchanged"
```

Expected:
- `false ["openai"]`
- Both `status --short` listings show no modified tracked files among the files Package 4 touches, and `docs/superpowers/plans/.p4-sections/` does not exist. Other pre-existing dirty files (Holden's classifier plan and his uncommitted work) are allowed and must not be staged.
- Both pushes succeed.
- `devbox-sync exit 0`.
- `active` twice.
- Exactly 2 timer lines.
- Both `ExecStart=` lines contain `flock -n -E 5 %h/.local/share/opencode/model-routing/provider-expansion.lock`.
- The verifier JSON has `"ok":true,"mode":"pre-bootstrap"` and `verify exit 0`.
- The outer link is still `/home/dev/fleet-core/config/opencode/opencode.json`.
- `gateway models unchanged`.

Abort criteria:
- If the broker does not come back `active`, read `journalctl --user -u opencode-model-broker.service -n 50 --no-pager`. A config-validation throw that names a provider is B1 working as designed: fix the config. Otherwise, Holden reverts by checking out the previous broker tag in `/home/dev/opencode-broker` and restarting.
- A verifier mode other than `pre-bootstrap` means artifacts already exist that nobody bootstrapped. Stop and investigate. Never delete them.

### R2: Stage preflight (design step 0, automated half)

```bash
$STAGE preflight 2>&1 | tee "$EVID/preflight.log"; echo "preflight exit ${PIPESTATUS[0]}"
stat -c '%a' "$LOCK"
sha "$RAW_BASE" | diff "$EVID/raw-base-hash-predeploy.txt" - && echo "raw base unchanged"
```

Expected: `preflight exit 0`, then `600`, then `raw base unchanged`.

Abort criteria:
- If preflight names the approval skill as missing, unreadable or mismatched, Holden runs `/home/dev/fleet-core/bin/devbox-sync --no-pull` to repair the skills link, outside any cutover, and re-runs R2.
- If preflight names a topology mismatch, go back to R0.
- If the lock mode is not `600`, a timer created the lock file with its default umask. Holden runs `chmod 600 "$LOCK"`, never `rm`, and re-checks.

### R3: Cutover (design steps 2-10)

`stage cutover` performs spec steps 2-10 for OpenAI: bootstrap generation 0, dry-run, baseline import, quiesce the old watch, final import, cutover-config (first resolver-generations/current switch and outer-link retarget), broker+gateway restart, enable apply with providers ["openai"], prepare/commit/canary openai, gate-start openai, and enable the reconcile timer. Precondition: pre-bootstrap state and config providers ["openai"]. Holden stops the hourly convergence for the length of the transaction, so that no `devbox-sync` run lands between the two symlink swaps. A run that did land there would fail loudly and safely (RF1), but it would raise a spurious alert. He starts the timer again in the same step.

```bash
ledger generationRegistryInitialized; ledger configCutover
systemctl --user stop devbox-sync.timer
$STAGE cutover 2>&1 | tee "$EVID/cutover.log"; echo "cutover exit ${PIPESTATUS[0]}"
systemctl --user start devbox-sync.timer
reconcile verify-deployed-config --json | tee "$EVID/verify-cutover.json"; echo "verify exit ${PIPESTATUS[0]}"
readlink "$OUTER_LINK"
ledger configCutover
ledger generationRegistryInitialized | tee "$EVID/init-ack.json"
sha "$RAW_BASE"; sha "$STATE/resolver-generations/generation-0/manifest.json"
ledger providerStages.openai.committed.generation; sha "$STATE/resolver-generations/current/manifest.json"; sha "$STATE/resolver-generations/resolver-generations.json"
ledger legacyMigration | tee "$EVID/legacy-migration.json"
ARCHIVE=$(ledger legacyMigration.archivePath | tr -d '"'); sha "$ARCHIVE"; test -w "$ARCHIVE" && echo "ARCHIVE WRITABLE" || echo "archive read-only"
stat -c '%a %n' "$STATE" "$LEDGER" "$STATE/resolver-generations/resolver-generations.json" "$STATE/reviewed-models.json" "$LOCK"
ledger scheduledRuns
systemctl --user is-active opencode-model-watch.service
systemctl --user show -p ActiveEnterTimestamp opencode-model-broker.service opencode-gateway.service
tuis_alive; echo "tui check done"
/home/dev/fleet-core/bin/gateway-models | diff "$EVID/gateway-models-before.json" - && echo "gateway models unchanged"
```

Expected:
- First line: `null` twice. Bootstrap must start from an entirely absent artifact set.
- `cutover exit 0`.
- The verifier JSON has `"ok":true`, `"mode":"generated"`, `generation` equal to `providerStages.openai.committed.generation` (0 when the openai commit published nothing new, otherwise the published generation), and `expectedTarget` equal to `actualTarget` equal to `/home/dev/.local/share/opencode/model-routing/resolver-generations/current/opencode.json`, with `verify exit 0`.
- `readlink` prints that same path.
- `configCutover` has `"mode":"generated"`, `"target"` equal to exactly that path, the same `generation` as the verifier, and `"reason"` of `"bootstrap"` (generation 0) or `"provider-stage"` (the openai commit re-stamped it). Its `manifestHash` equals the `sha` of `current/manifest.json` and its `registryHash` equals the `sha` of `resolver-generations.json`.
- `generationRegistryInitialized` has `"generation":0`. Its `rawBaseHash` equals the `sha` of `$RAW_BASE` and `$EVID/raw-base-hash-predeploy.txt`, and its `manifestHash` equals the `sha` of `generation-0/manifest.json`. Its `registryHash` is the registry as bootstrap wrote it; it is not compared with today's registry, which every later publish rewrites.
- `legacyMigration`: `baselineCount` is an integer (the observed deployment value was 83 when the spec was written; that is not an invariant), `finalCount >= baselineCount`, and `finalHash`, `quiescedAt`, `archivePath` and `archiveHash` are all non-null. The archive `sha` equals `archiveHash`, followed by `archive read-only`.
- Modes: `700` for `$STATE`, and `600` for the ledger, registry, legacy ledger and lock.
- `scheduledRuns` has an entry from this run with `"mode":"dry-run"`, `"ok":true`, `"exitCode":0`.
- The old watch is `inactive`.
- Both services show an `ActiveEnterTimestamp` from this run (step 7 restart).
- `providerStages.openai` has `"status":"gate-running"`, with `prepared`, `committed`, and `gate.startedAt` all set.
- `tuis_alive` prints no `GONE:` line.
- `gateway models unchanged`.

As the operator, run `opencode models --pure` with the default config (no XDG override) and compare its model keys with the current manifest's `modelKeys` (`jq -r '.modelKeys[]' "$STATE/resolver-generations/current/manifest.json"`); expect identical sets. Record in the completion report that router-plugin manifest registration and TUI captured-generation acceptance are evidenced only by this key comparison and PID survival (`tuis_alive`); no stronger probe exists in this plan.

Abort criteria:
- **`cutover` exits nonzero and the verifier reports `mode` `invalid`, with `readlink "$STATE/resolver-generations/current"` pointing into `resolver-generations/` while the outer link still reads `/home/dev/fleet-core/config/opencode/opencode.json`.** This is the RF2 intermediate state. Holden stops `devbox-sync.timer` again, re-runs `$STAGE cutover`, starts the timer, and re-checks everything above. Do not retarget the link by hand.
- **The `cutover` output says quiescence of the old watch could not be confirmed.** Nothing was published. Holden waits until `systemctl --user is-active opencode-model-watch.service` prints `inactive` and re-runs R3.
- **Any other nonzero exit, any hash mismatch, or a writable archive.** Stop. Ledger, registry and generation artifacts are preserved for diagnosis. Do not proceed to R4. If new OpenCode processes must keep working while Holden investigates, he runs `$STAGE rollback --global` when the verifier mode is `generated` or `invalid`. When it is `bootstrap-incomplete`, the outer link never moved, so nothing needs rolling back: he fixes the cause and re-runs `$STAGE cutover`, which resumes.
- **A `GONE:` line.** A TUI died during the window. Holden checks its exit in tmux before continuing, because the spec requires TUI continuity.

### R4: Global rollback drill (raw-emergency)

R4 -- Global rollback drill: DEFERRED pending an operator decision on reactivation (see 'Open decision: global rollback drill' at the end of this runbook). Do not run `$STAGE rollback --global` on the live host during R3-R7 except as the R5 abort path.

### R5: OpenAI stage (design steps 8-10)

`stage cutover` has already run steps 8-10: enabled apply with providers ["openai"], prepared/committed/canary openai, gate-started openai, and enabled the reconcile timer. This step verifies that state and schedules the 24-hour gate check.

```bash
ledger providerStages.openai | tee "$EVID/stage-openai.json"
reconcile verify-deployed-config --json; echo "verify exit $?"
reconcile gate-status --provider openai --json
node -e 'const c=JSON.parse(require("fs").readFileSync("/home/dev/devbox/config/opencode-broker/config.json","utf8").replace(/^\s*\/\/.*$/gm,""));console.log(JSON.stringify(c.reconcile.apply))'
systemctl --user is-active opencode-model-broker.service opencode-gateway.service
pgrep -fc 'opencode-broker serve'; ss -xlp | grep -c "pid=$(systemctl --user show -p MainPID --value opencode-model-broker.service),"
systemctl --user list-timers --all --no-pager | grep -E 'opencode-model-(reconcile|watch)\.timer'
systemctl --user start opencode-model-watch.service; journalctl --user -u opencode-model-watch.service -n 5 --no-pager
/home/dev/fleet-core/bin/gateway-models | diff "$EVID/gateway-models-before.json" - && echo "gateway models unchanged"
tuis_alive; echo "tui check done"
```

Expected:
- `providerStages.openai` has `"status":"gate-running"`; `prepared` and `committed` are non-null, with `committed.generationAck`, `committed.brokerAck` and `committed.ledgerAck` all non-null; `checkpoint.generation` is `0`; `gate.startedAt` is set.
- The verifier has `"ok":true`, `"mode":"generated"`, and a `generation` equal to `committed.generation`.
- `gate-status` exits 0 and reports not yet eligible.
- The config line shows `"enabled":true` and `"providers":["openai"]`.
- `active` twice.
- Process count `1` and socket count `>= 1`. Together these show one socket owner and one publisher.
- Both timer lines are present. The old watch's manual start logs its configCutover-generated skip reason, and job-run records exit 5. Together these show exactly one mutation-capable schedule.
- `gateway models unchanged`.
- No `GONE:` line.

Holden commits the config edit that `cutover` made, so that `devbox-sync`'s `git pull --ff-only` never trips over a dirty file:

```bash
git -C /home/dev/devbox add config/opencode-broker/config.json
git -C /home/dev/devbox commit -m "config: enable model reconciliation apply for openai"
git -C /home/dev/devbox push origin main
```

**24-hour gate.** In the same OpenCode session, Holden (through the agent) calls `schedule_prompt` with `in_minutes: 1500` and this text:

`Package 4 OpenAI gate check. Run /home/dev/fleet-core/bin/opencode-model-provider-stage gate openai 2>&1 | tee -a /home/dev/.local/state/devbox/p4-cutover/gate-openai.log and report the exit code and the ledger's providerStages.openai (read /home/dev/.local/share/opencode/model-routing/model-reconciliation.json). Healthy = status "healthy" with gate.completedAt set. If status is still "gate-running" with a not-eligible reason (for example no successful scheduled run after commit yet, or "clock-regressed"), schedule this same check again in 360 minutes and change nothing. If status is "failed", do not retry: follow the Operator runbook's R5 abort criteria (rollback --global, because openai is the only provider) and tell Holden.`

The gate check is expected to finish with `status` `"healthy"`, `gate.completedAt` set, and at least one `scheduledRuns` entry with `"ok":true` whose `startedAt` is later than `committed.at`. With `OnCalendar=daily` and at most 1h of random delay, 25 hours always spans at least one firing. On a failed gate, the gate resets and a fresh `add` is needed after rollback.

Abort criteria:
- **`status` is anything other than `gate-running`.** Holden immediately runs `$STAGE rollback --global`. He then verifies the following:
   - `ledger configCutover.mode` prints `"raw-emergency"`.
   - The verifier reports `mode` `raw-emergency`.
   - The outer link points to `/home/dev/devbox/config/opencode/opencode.json`.
   - `ledger configCutover` has `"generation":null` and `"manifestHash":null`, with `"mode":"raw-emergency"` and `"target"` equal to the raw base.
   - The broker is `active`.

   Holden commits the reverted config and stops. A failed first provider leaves apply enabled for a provider that failed commit, and the hourly `devbox-sync` restarts timers. Leaving that state in place is the riskiest outcome in this runbook, so the rollback is not optional.
- **The old watch does not exit 5.** Its data guard is broken, and the fleet has two mutation-capable schedules. Holden runs `$STAGE rollback --global` (openai is the only provider, so a provider-scoped rollback is refused) and stops.

### R6: Anthropic stage with the provider-scoped rollback drill (design step 11)

Precondition: `ledger providerStages.openai.status` prints `"healthy"`.

```bash
$STAGE add anthropic 2>&1 | tee "$EVID/add-anthropic.log"; echo "add exit ${PIPESTATUS[0]}"
ledger providerStages.anthropic.checkpoint | tee "$EVID/anthropic-checkpoint.json"
$STAGE rollback --provider anthropic 2>&1 | tee "$EVID/rollback-anthropic.log"; echo "rollback exit ${PIPESTATUS[0]}"
ledger providerStages.anthropic.status; ledger providerStages.openai.status
reconcile verify-deployed-config --json; echo "verify exit $?"
node -e 'const c=JSON.parse(require("fs").readFileSync("/home/dev/devbox/config/opencode-broker/config.json","utf8").replace(/^\s*\/\/.*$/gm,""));console.log(JSON.stringify(c.reconcile.apply.providers))'
systemctl --user is-enabled opencode-model-reconcile.timer
tuis_alive; echo "tui check done"
```

Expected:
- `add exit 0`.
- The checkpoint has a `generation` equal to OpenAI's `committed.generation`, an `allowlist` of `["openai"]`, and non-null `ledgerRevision` and `brokerPolicyRevision`.
- `rollback exit 0`.
- `"rolled-back"`, then `"healthy"`.
- The verifier is `ok`, with `generation` and `manifestHash` equal to the checkpoint's values.
- `["openai"]`.
- `enabled`.
- No `GONE:` line.

This proves the provider-scoped rollback: the scheduler and the earlier healthy provider survived it.

Holden then re-adds Anthropic for real and repeats every R5 check, with `openai` replaced by `anthropic`. After that he commits and pushes the config with the message `config: enable model reconciliation apply for anthropic`, and schedules the same 1500-minute gate prompt with `openai` replaced by `anthropic`:

```bash
$STAGE add anthropic 2>&1 | tee "$EVID/add-anthropic-2.log"; echo "add exit ${PIPESTATUS[0]}"
```

Abort criteria:
- If the drill's rollback leaves `openai` anything other than `healthy`, or leaves the providers list anything other than `["openai"]`, stop. Do not re-add.
- If `add` refuses a provider whose previous stage is `rolled-back`, record the refusal. The spec permits a new prepare and commit after a rollback, so this is a stage-script defect, and Holden files it before continuing.

### R7: Alibaba stage (design step 11, final provider)

Precondition: `ledger providerStages.anthropic.status` prints `"healthy"`.

Holden runs `$STAGE add alibaba-token-plan` and every R5 check, with `openai` replaced by `alibaba-token-plan`. He also confirms in `$EVID/add-alibaba-token-plan.log` that the canary probed exactly `qwen3.8-max`, `qwen3.6-flash`, `deepseek-v4-pro` and `glm-5.2`, and that it did not route `qwen3.7-max`, `qwen3.7-plus` or `deepseek-v4-flash-0731`. Then he commits and pushes the config (`config: enable model reconciliation apply for alibaba-token-plan`) and schedules the 1500-minute gate prompt for `alibaba-token-plan`.

Package 4 is operationally complete when all of these hold:
- `ledger providerStages` shows `openai`, `anthropic` and `alibaba-token-plan` all `"healthy"`.
- The verifier is `ok` in mode `generated`.
- `gateway models unchanged` still holds.

Abort criterion: any canary probe for one of the four exact models fails, or a sibling appears as routed. Holden runs `$STAGE rollback --provider alibaba-token-plan`, then verifies the R6-style checkpoint restoration with both earlier providers still `healthy`.

### R8: One-time seven-day cleanup (closed set, run once by hand)

Right after R3 succeeds, Holden (through the agent) calls `schedule_prompt` with `in_minutes: 10080` and this text: `Package 4 seven-day cleanup eligibility: follow the Operator runbook R8 checks; change nothing unless every check passes, and report each check's result to Holden.` R3 completes after `legacyMigration.quiescedAt`, so 10080 minutes later is at least seven days after quiescence. Holden runs the following when that prompt arrives:

```bash
node -e 'const q=Date.parse(process.argv[1]); const ok=Date.now()-q>=7*86400000; console.log(ok?"seven days elapsed":"NOT YET: "+new Date(q+7*86400000).toISOString())' "$(ledger legacyMigration.quiescedAt | tr -d '"')"
ledger configCutover.mode
ledger providerStages
ARCHIVE=$(ledger legacyMigration.archivePath | tr -d '"'); sha "$ARCHIVE";
ledger legacyMigration.archiveHash
systemctl --user list-timers --all --no-pager | grep -E 'opencode-model-(reconcile|watch)\.timer'
ls -t /home/dev/.local/state/devbox/logs/opencode-model-reconcile/ | head -3
ls -t /home/dev/.local/state/devbox/logs/opencode-model-watch/ | head -3
```

**Expected:**
- `seven days elapsed`.
- `"generated"`.
- Every provider stage that has begun is `"healthy"` or `"rolled-back"`. None is `prepared`, `committed`, `gate-running` or `failed`.
- The archive `sha` equals the printed `archiveHash`.
- Both timer lines are present.
- The newest `opencode-model-reconcile` job logs show success within the last 48h.
- Every `opencode-model-watch` job log written since R3 shows exit 5.

Holden also confirms two things by hand:
- No ntfy alert, `FleetJobOverdue`, recovery or rollback from either job remains unresolved since the last gate.
- Exactly one healthy new schedule exists. That is the reconcile job. The watch only skips.

**Cleanup.** Only when every check passes, Holden runs this once:

```bash
test "$(sha "$ARCHIVE")" = "$(ledger legacyMigration.archiveHash | tr -d '"')" && rm -f -- "$ARCHIVE" && echo "archive copy removed"
```

Expected: `archive copy removed`.

The following stay in place:
- The writable legacy ledger `$STATE/reviewed-models.json`. It is the old watch's state, and the spec only removes the copy.
- The lock file. It is never deleted.
- `$EVID`. It is the permanent audit record.

**Retiring the old watch and its executable.** This is the second half of the spec's "remove the copy/old executable once". Holden opens it as its own reviewed change in both repos rather than running it as a runbook command, for two reasons:
- `systemd/opencode-model-watch.service` and `.timer` are pinned by F1's unit tests and by `tests/model-reconcile-docs.test.mjs`.
- `bin/opencode-broker-watch` is pinned by B7's data-guard tests.

That change:
- removes the fleet units and updates those tests and the README/TIMERS sections;
- runs `/home/dev/fleet-core/bin/devbox-sync --timers --prune` so the installed timer is removed;
- removes the broker executable in its own broker release;
- keeps `watch.notifyCommand` in `config/opencode-broker/config.json`, because burn-watch and slot-watch still use it.

After that change, the old watch is no longer a rollback writer. `rollback --global` still restores the raw-base config link, but no legacy writer resumes.

**Abort criteria:**
- `NOT YET`: Holden schedules the prompt again for the printed date and changes nothing.
- Any unhealthy stage, a hash mismatch, a missing reconcile success, or a watch run that did not exit 5: no cleanup. Holden investigates that cause first. The archive copy stays.

**Hand-off one-liner** (Holden pastes it to start the session after deployment):

```
opencode run --agent smart "Package 4 operator runbook: read the Operator runbook section of the opencode-broker Package 4 plan under /home/dev/opencode-broker/docs/superpowers/plans/, then execute R0 through R3 with Holden, stopping at the first abort criterion"
```

## Open decision: global rollback drill

The plan has no reactivation path after a live global rollback: `cutover` only starts from `pre-bootstrap` or `bootstrap-incomplete`, and B7's final import does not re-import a post-rollback legacy delta. So the live global drill needs either a new reactivation task or an isolated-state drill. Provider-scoped rollback is drilled live in R6.
