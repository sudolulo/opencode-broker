# Quota Progression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` inline in the existing `/home/dev/obk-merge` checkout. Parent self-reviews before execution. Steps use checkbox (`- [ ]`) syntax for tracking. Do not invoke a workflow from `/home/dev/projects/per`, create a worktree, or hand off to another session.

**Goal:** Progressively steer fresh cloud assignments away from nearly full short windows, and require durable, progressive main-session checkpoints without stopping safe authorized work before exhaustion.

**Architecture:** Extend the existing durable balancer with cursor-density admission, and the existing `/headroom` plus `checkWrapUp()` synthetic prompt flow with own-provider weekly stages. Keep quota circuits, lease stickiness and child behavior intact; no new subsystem or hard enforcement.

**Tech Stack:** ES modules, Node's `node:test`/strict assert, existing injected timer and lifecycle fixtures; no dependencies.

**Spec:** [Quota progression design](file:///home/dev/obk-merge/docs/superpowers/specs/2026-10-26-quota-progression-design.md).

## Global Constraints

- Execution checkout: `/home/dev/obk-merge`; parent reports main `12a729e == origin/main`, package `1.27.6`. Recheck HEAD and tracking before implementation; planning ran no tests and made no git-state changes. A final read-only status check showed only the two new documents alongside the pre-existing dirty gateway and budgets files.
- Preserve unrelated dirty `gateway/lib/gateway.js`; never touch dirty canonical `/home/dev/projects/opencode-broker`.
- New assignments only; no request sleeps, lease/pin moves, early stops or automatic tier handoffs. Existing eligibility/circuits/outage/context/local-share fences remain authoritative.
- Top-level `burstFence`: live reported 0.75, default 0.9. No reset-elapsed/on-pace rule.
- Main weekly stages: 75 prepare, 85 pre-mutation checkpoint, 95 bounded/reversible work; genuine exhaustion remains existing behavior at actual limit.
- No new plugin exports: helpers belong in existing `lib/` modules. Root weekly policy never reaches children/classifiers.
- All commands below are future execution steps, run with working directory `/home/dev/obk-merge`; none were run to author this plan.
- No per-task commits. Review both tasks, then full-suite verification and one `1.28.0` release commit/push. No deployment or restarts in this plan.

## Review Focus

1. Provider IDs differ across layers: plugin `routed.target.model.providerID` must select its own weekly entry, not the tightest lane provider.
2. Per-provider taper counters must advance for every considered taper provider only on actual successful new-lease commit, including rejected providers. Add counter-rotation/local-share-alias and read-only-preview/commit regressions; preserve ordinary ties/local turns and describe controlled opportunity density, not a universal provider-mix share.
3. Missing/null/nonfinite quota and cached reports cannot fabricate 100%, suppress availability or claim fresh data.
4. Async failed/successful sends across idle, provider change and replacement must not clear or cover a newer marker; reset timestamp jitter must not repeat messages.
5. Prompt text must mandate a private durable handoff and continued useful safe work, while remaining honest that tests cannot enforce agent compliance.

---

## Task 1: Short-window density on fresh cloud selection

**Files:** Modify `lib/budgets.js:138-200`, `lib/routing.js:19,1881-2020,2137-2150`, `tests/budgets.test.mjs:40-49,126-139`, `lib/config.js:1061-1067`, `README.md:118`; create `tests/quota-progression.test.mjs`.

**Interfaces:**
- `shortWindowTaper(providerID, {plan = cachedPlanUsage(providerID), start = CONFIG.burstFence} = {}) -> number` in budgets.
- `taperAdmits(cursor, weight) -> boolean` in budgets; finite/clamped weight, nonnegative safe-integer cursor (invalid cursor normalizes to zero).
- `chooseTarget({...existingOptions, burstFence = CONFIG.burstFence})` passes that start to the helper; optional override makes fixtures independent of deployed configuration.
- Additive `decision.providerShortWindowWeights: {[providerID]: number}`; diversion reason `short-window-taper`; all-rejected progress reason `short-window-taper-availability-fallback`.

- [ ] **1. Write red helper/routing tests.** New file starts with the real fixture-import pattern and this complete controlled-share case:

```js
import assert from "node:assert/strict";
import test from "node:test";
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const B = await import("../lib/budgets.js");
const R = await import("../lib/routing.js");
const P = await import("../lib/plan-usage.js");
const targets = Object.fromEntries(["a", "b"].map((id) => [id, {
  id, providerID: `provider-${id}`, modelID: `model-${id}`, kind: "cloud",
  capacity: null, source: "subscription-oauth", tiers: ["worker"],
}]));
const report = (short, weekly) => ({windows: [
  {id: "5h", percent: short}, {id: "wk", percent: weekly},
]});
test("short-window taper gradually diverts a durable-preferred provider", () => {
  try {
    for (const [percent, expected] of [[65,10000],[75,10000],[80,9600],[90,6400],[95,3600],[99,784]]) {
      P.__resetPlanUsageCacheForTests();
      P.seedPlanUsageCache({"provider-a": report(percent, 10), "provider-b": report(0, 40)});
      let cursors = {}; let count = 0; let diverted = 0;
      for (let i = 0; i < 10000; i++) {
        const choice = R.chooseTarget({profile: "auto", tier: "worker", targets,
          cursors, tierWeights: {}, deals: [], outagePolicy: {enabled: false}, burstFence: .75});
        assert.ok(choice.target, "taper never creates a refusal");
        assert.equal(choice.nextCursor, i + 1);
        cursors = {[choice.cursorKey]: choice.nextCursor};
        if (choice.target.providerID === "provider-a") count++;
        else { diverted++; assert.ok(choice.decision.reasons.includes("short-window-taper")); }
      }
      assert.ok(Math.abs(count - expected) <= 1, `${percent}%: ${count}, expected ${expected}`);
      assert.equal(count + diverted, 10000);
    }
  } finally { P.__resetPlanUsageCacheForTests(); }
});
test("taper uses percentage, not reset elapsed time", () => {
  for (const resetsAt of ["2026-10-26T00:01:00Z", "2026-11-02T00:00:00Z"]) {
    const plan = report(65, 10); plan.windows[0].resetsAt = resetsAt;
    assert.equal(B.shortWindowTaper("provider-a", {plan, start: .75}), 1);
    assert.equal(B.effectiveUtilization({}, "provider-a", 0, undefined, plan), .10);
  }
});
```

- [ ] **2. Run red:** `node --experimental-test-module-mocks --test tests/quota-progression.test.mjs`. Expected: missing helper or wrong share, not an unrelated import failure. Fix fixture errors before interpreting red.
- [ ] **3. Implement helpers and durable-only base.** Reuse `planWindowPeriodMs`; use plan-wide recognized periods <604800000ms for taper. Reject null/blank/nonfinite percentages before numeric conversion. The core is:

```js
const p = Math.min(1, Math.max(0, shortPercent / 100));
const w = start === 1 ? (p < 1 ? 1 : 0)
  : 1 - Math.min(1, Math.max(0, (p - start) / (1 - start))) ** 2;
return Math.min(1, Math.max(0, w));
// taperAdmits, after argument normalization:
return Math.floor((cursor + 1) * weight) > Math.floor(cursor * weight);
```

Keep `effectiveUtilization`'s longest-period aggregation and ledger fallback; remove its burst-fence override. Replace the old 95%-burst expectation with durable .10, and the obsolete .60 on-pace expectation with durable .05 for every reset-time variation. Update the misleading test names and comments rather than leaving a deliberately red historical assertion.

- [ ] **4. Integrate bounded admission into `balance`.** Isolate the current group ranking sequence in a local helper; do not redesign its order. Rank once for the original choice. On cloud rejection, filter every target of that provider and re-rank the remaining original group, at most once per distinct provider. Stop at the first admitted cloud or ordinary permissible local choice. If no candidate is admitted, restore the original valid choice. Return the selected attempt's ranking metadata, diversion reasons and provider-weight map; preserve original eligible-target observability and one `nextCursor = cursor + 1`. Advance per-provider counters for every considered taper provider only when the broker commits an actual successful new lease, including rejected providers. Never advance on preview, held lease or pinned reuse; do not reintroduce shared-cursor rotation or local-share aliasing.
- [ ] **5. Add edge regressions before finishing the implementation:** helper factors at default .9 (80/90 =>1,95=>.75,99=>.19); start1 at99/100; clamped out-of-range values; null/blank/NaN/infinite/unknown windows; short-only plan; `wk:model`/`5h:model` exclusions; multiple short windows use maximum. Routing: equal weekly usage below start preserves alternating baseline, equal weekly with provider-a weight2 retains its ordinary preference below start, duplicate models cannot evade provider skip, untapered second-best respects existing weights/deals/fit, sole provider and all-tapered providers still return eligible targets, active 100% quota-held provider remains excluded. Prove counter advancement rotates independently from ordinary provider rotation/local-share opportunities; prove read-only previews leave counters unchanged and actual successful lease commit advances every considered provider, rejected providers included. Replay existing mixed/local-share, profile fallback and lease-stickiness regressions unchanged. Controlled fixture densities are opportunity-based, not universal provider-mix shares.
- [ ] **6. Run green:** `node --experimental-test-module-mocks --test tests/quota-progression.test.mjs tests/budgets.test.mjs tests/routing.test.mjs tests/profile-local-share.test.mjs tests/ladder.test.mjs tests/model-outage-lanes.test.mjs`. Use existing broker lease tests to verify held/pin bypasses; record exact files/outcomes. Update `burstFence` comments and README row to say progressive new-assignment taper start, not a cross-period score fence. Review Task 1; leave uncommitted.

## Task 2: Own-provider weekly stages and durable main handoff instructions

**Files:** Modify `lib/usage-limit.js:93-132`, `bin/opencode-broker:3874-3892`, `plugin/router.js:1494-1521,1641-1719` plus existing owned cleanup sites, `tests/usage-limit.test.mjs:77-108`, `tests/failover.test.mjs:848-1084,1914-1975,2223-2274`, and `tests/refusal-codes.test.mjs:462-475`. Document the policy in `README.md` adjacent to routing configuration.

**Interfaces:**
- `laneHeadroom({...existingOptions, freshPlanFor = null})` keeps old fields and adds each provider's `weekly: null | {window, percent, resetsAt, fetchedAt, source}`. `source` values: `last-fetch`, `cached`, `unknown`. Broker passes `freshPlanUsage` alongside `cachedPlanUsage`; no new fetch/write.
- `primaryQuotaStage(headroom, providerID) -> "prepare" | "checkpoint" | "bounded" | null`, purely from that provider's finite weekly percent.
- `wrapUpMessage(headroom, {subagent = false, now = Date.now(), sessionID, providerID, stage = null} = {})` retains child semantics and generates cumulative root instructions. Its handoff path must use a validated session ID, never an unchecked path interpolation.
- Existing `checkWrapUp`/scheduler/`promptAsync` transport, optional agent field, `captureSessionBinding`/`bindingIsCurrent`, marker identity and confirmed-missing retirement remain the integration surface. Main selection uses `routed.target.model.providerID`.

- [ ] **1. Write red weekly and wording units** in `tests/usage-limit.test.mjs`, using the existing `NOW` and imports plus:

```js
test("weekly caution is plan-wide and belongs to the routed provider", async () => {
  const {laneHeadroom, primaryQuotaStage, wrapUpMessage} = await import("../lib/usage-limit.js");
  const plans = {
    openai: {fetchedAt: NOW, windows: [{id:"5h",percent:99},{id:"wk",percent:85},{id:"wk:model",percent:100}]},
    anthropic: {windows: [{id:"7d",percent:10}]},
  };
  const room = laneHeadroom({providerIDs:["openai","anthropic"], circuits:{},
    planFor:id=>plans[id], localFits:true, now:NOW});
  assert.equal(room.nearlyOut, false);
  assert.equal(room.providers[0].weekly.percent, 85);
  assert.equal(primaryQuotaStage(room,"openai"), "checkpoint");
  assert.equal(primaryQuotaStage(room,"anthropic"), null);
  const main = wrapUpMessage(room,{sessionID:"ses-main",providerID:"openai",stage:"checkpoint",now:NOW});
  assert.match(main,/before every mutating unit/i);
  assert.match(main,/handoffs\/ses-main\.md/);
  assert.match(main,/keep (doing|working)|continue.*safe/i);
  assert.doesNotMatch(main,/start nothing new/i);
  const child = wrapUpMessage(room,{subagent:true,now:NOW});
  assert.match(child,/return what you have to your parent/);
  assert.doesNotMatch(child,/handoffs|before every mutating unit/i);
});
```

Add table-driven boundaries at74.99/75/84.99/85/94.99/95/99.99/100; all five weekly aliases; colon subcaps; unknown/invalid numbers; no weekly window; duplicate aliases select maximum; cached/last-fetch/missing timestamp labels. For main lane-only nearlyOut at short98, assert checkpoint+handoff+continued safe work and absence of “start nothing new.” Child retains that wording. Add main-message assertions for `0700`, `0600`, verified resume command, pending jobs/cleanup, no secrets/transcripts, and explicit handoff-write failure handling; test an invalid session ID such as `../escape` never becomes a handoff path.

- [ ] **2. Write red integration using the real `runLifecycleFixture`** in `tests/failover.test.mjs` (append after its declaration). This pins own-provider stages despite an otherwise roomy lane:

```js
test("main weekly stages checkpoint even while the lane has room", () => {
  const result = runLifecycleFixture(`
    let percent = 74; let sample = 0;
    brokerReply = (path, body, send) => {
      if (path !== "/headroom") return false;
      send({nearlyOut:false,threshold:97,localFits:true,providers:[
        {providerID:"openai",held:false,percent,window:"wk",room:true,
         weekly:{window:"wk",percent,resetsAt:null,fetchedAt:1000 + sample++,source:"last-fetch"}},
        {providerID:"anthropic",held:false,percent:99,window:"wk",room:false,
         weekly:{window:"wk",percent:99,resetsAt:null,fetchedAt:1000,source:"last-fetch"}}
      ]}); return true;
    };
    await created("weekly"); await routeBusy("weekly");
    const counts = [];
    for (const next of [74,75,75,85,95,99]) {
      percent = next; await runNextTimer(60000); counts.push(prompts.length);
    }
    console.log(JSON.stringify({counts,texts:prompts.map(p=>p.body.parts[0].text),leases:leases.get("weekly")}));
  `);
  assert.deepEqual(result.counts,[0,1,1,2,3,3]);
  assert.equal(result.leases,1,"warnings do not re-lease or move the session");
  assert.match(result.texts[2],/reversible|bounded/i);
  assert.doesNotMatch(result.texts.join("\n"),/start nothing new/);
});
```

Extend this fixture with a child (`parentID`) and classifier and assert neither receives a weekly prompt. Add cases: jump74->95 produces one cumulative warning; weekly+lane cause coalescing; same percent with ±500ms reset jitter no repeat; new sample drop95->70 then75 re-arms prepare; confirmed rollover re-arms even if reported usage remains high; older sample does not re-arm; provider switch uses its own stage set; idle/release keeps delivered stage; same-ID replacement has its own stage; returned/thrown send failure retries only its marker. Adapt existing deferred-send cases at2223-2274 for weekly85->95 and provider changes so stale success/failure cannot suppress/erase the newer warning.

- [ ] **3. Run red:** `node --experimental-test-module-mocks --test tests/usage-limit.test.mjs tests/failover.test.mjs`. Expect missing weekly fields/stage helper or wrong main behavior. Do not rename non-existent router tests into the command.
- [ ] **4. Extend headroom and message generation.** Read each plan once per provider; select plan-wide weekly aliases; clamp finite values without converting unknowns to zero. Copy `fetchedAt`, reset and accurate source labels. Wire optional `freshPlanFor: freshPlanUsage` in `/headroom`. Add the stage helper:

```js
const p = headroom.providers.find(item => item.providerID === providerID)?.weekly?.percent;
if (typeof p !== "number" || !Number.isFinite(p)) return null;
return p >= 95 ? "bounded" : p >= 85 ? "checkpoint" : p >= 75 ? "prepare" : null;
```

Replace root wrap-up text with the spec's cumulative contract: mandatory private durable file, required content, before-mutation/stage-boundary updates, verified resume command, no secrets/transcripts, explicit failure handling, and continue useful safe authorized work below100. Stage95 forbids only unsafe new units, not all work. For weekly-only causes, name the current provider/window/stage; do not reuse the old claim that nothing else can take over when `nearlyOut` is false. Missing sessionID must not fabricate a path or break legacy pure-message callers: explicitly require the agent to obtain its actual ID before writing. Keep child text unchanged. Source strings must not claim that a cached/missing timestamp is fresh.

- [ ] **5. Extend existing tracker/delivery, not the plugin system.** In `checkWrapUp`, retain the classifier skip; branch children to the existing lane-only path. Roots compute own-provider stage independently of nearlyOut. Capture route/session/heartbeat binding before the context/headroom awaits, not merely before prompt delivery. Store per-provider/stage markers under the existing session warning tracking with a separate lane marker; coalesce active causes. Apply one-point drop hysteresis and confirmed rollover rules from the spec, not raw reset-string keys. Check binding before every post-await mutation/send. Reserve a unique marker before sending. On success, mark only that exact episode and its covered lower stages; on failure remove only identical reserved markers, using current retry/retirement guards. Preserve successful same-session warnings across leases, and clear all newly added markers at the existing owned replacement/retirement sites. Keep tracker trimming and current poll lifecycle. Update root log/toast wording without masking child warnings.
- [ ] **6. Run green:** `node --experimental-test-module-mocks --test tests/usage-limit.test.mjs tests/failover.test.mjs tests/refusal-codes.test.mjs tests/read-only-persistence.test.mjs`. Extend the existing `/headroom` integration assertion to require `weekly:null` when no weekly report exists, and verify it remains a nonwriting read. Review Task2, including the handoff privacy/instruction contract. Record that file-writing compliance is not exercised by prompt tests; do not claim otherwise. Leave uncommitted.

## Integration, final verification and one release batch (parent execution only)

**Review ruling:** Phase aliasing can disable taper; per-provider counters require additional bounded cursor keys. Both costs belong in review of the selection and persistence boundary.

- [ ] Inspect `git --no-pager status`, `git --no-pager diff`, and `git --no-pager log --oneline -10` in the verified checkout. Preserve unrelated work; do not restore/stash the unrelated gateway edit. Resolve only in-scope regressions and distinguish pre-existing failures with evidence.
- [ ] Complete spec/plan self-review plus implementation review for both tasks. Check decision metadata, shared-cursor aliasing, providerID shape, prompt cumulative obligations, private-file wording, race ownership and absence of early stop/tier handoff. No per-task commits.
- [ ] Run **`npm test`** once the combined reviewed implementation is ready (script: `node --experimental-test-module-mocks --test tests/*.test.mjs gateway/tests/*.test.mjs hud/tests/*.test.mjs`). Record exact pass/fail counts and any unrelated dirty-gateway failure; never claim a green suite without results. Use an owned background runner for a long suite and clean it up when done.
- [ ] Bump `package.json` from 1.27.6 to **1.28.0** and add `## [1.28.0] — 2026-10-26` immediately below empty `Unreleased`; include separate bullets for assignment taper and progressive main checkpoint/handoff policy. No `package-lock.json` exists in the inspected checkout; create no lockfile. If another tracked lockfile actually carries the root package version, update that existing metadata in the same batch. No per-task versions.
- [ ] Re-run `npm test` against the release-ready tree; inspect status/diff/recent log again. Stage only the exact implementation/test/docs/version paths for these two tasks, **excluding `gateway/lib/gateway.js`** and any other unrelated dirt. Parent makes one descriptive commit and pushes main to canonical Gitea under the supplied commit/push authorization. Do not use `git add .`, amend, force push, or create a PR/worktree.
- [ ] Verify the pushed commit/ref and report tests, version and the preserved unrelated dirty path. Do not restart services or claim existing running panes loaded new plugin code. This planning assignment ends with only the two uncommitted documents; every implementation/release checkbox remains pending.

## Verified implementation status — 2026-10-26

Implementation and review are complete. Final full-suite verification used `/bin/sh /home/dev/obk-merge/.superpowers/sdd/2026-10-26-quota-progression-plan/verification/run.sh`; tester receipt `bg008-mvpr145h` exited 0 with 3004 total, 3003 passed, 0 failed, 0 cancelled, and 1 skipped (skip reason not captured). Inventory was closed, the socket was removed, 1 child was reaped with `ECHILD` confirmed, no owned jobs remain running, and `git diff --check` returned 0. Fresh review by `ses_e85f5222affek0OijeGWMBMi2h` reported no findings, including on fixture and PATH corrections.

The original unchecked checklist remains the historical planning record. Commit, push, and runtime verification remain pending as of this pre-commit note; the execution receipt is tracked separately. Subsequent user authorization permits commit/push to canonical main and a broker-only restart, superseding the original plan's no-restart line. The user's latest choice to leave live TUIs untouched remains in effect. Handoff-file writing compliance is an agent-instruction contract, not something proven by enforced filesystem or tool tests. Do not treat future actions as complete until performed and verified.
