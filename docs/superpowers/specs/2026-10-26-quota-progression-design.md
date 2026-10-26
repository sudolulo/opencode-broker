# Quota progression: assignment taper and main-session safety

**Status:** Approved behavior and implementation progress recorded for parent self-review. Implementation runs inline in `/home/dev/obk-merge`, not through a workflow rooted at `/home/dev/projects/per`.

## Intent and boundaries

Short windows should approach their actual maximum while progressively steering **new assignments only** elsewhere. Requests are not delayed; held leases and pinned sessions are not moved. Main sessions should progressively prepare for a potentially long weekly pause, persist a useful handoff, and **keep doing useful, safe, authorized work below actual exhaustion**. A warning neither stops a session nor hands it to another tier.

This extends the current balancer and quota-safety prompt flow. It adds no subsystem, plugin, request scheduler, hard tool enforcement, or automatic tier handoff. Children retain their existing nearly-out return-to-parent behavior; classifiers receive no quota policy prompt.

## Verified integration points

References are to the pre-implementation checkout, package `1.27.6` (parent reports main `12a729e`, aligned with origin/main).

- `lib/budgets.js:138-200`: period parsing, top-level `burstFence`, durable utilization, and the existing abrupt burst fence. The removed on-pace/elapsed-reset rule must stay removed.
- `lib/routing.js:1930-2020,2137-2150`: candidate-stage balancing, cursor, existing ordering and decision trail. The cursor advances on ordinary granted choices, not only ties.
- `bin/opencode-broker:1962-2018,2331-2407,2750`: held-lease reuse, assignment stickiness, and persisted cursor. These selection boundaries stay unchanged.
- `lib/usage-limit.js:93-132` and `bin/opencode-broker:3874-3892`: plan-wide headroom and side-effect-free `/headroom`.
- `plugin/router.js:921-928,1494-1521,1641-1719`: route shape, binding guards, once-per-episode delivery, existing one-minute poll and `promptAsync`. The plugin provider is **`routed.target.model.providerID`**, not the internal broker target's top-level `providerID`.
- `lib/plan-usage.js:393-445`: reports carry `fetchedAt`; cached last-good readings survive failures. `freshPlanUsage` means last-fetch success, not an age-based freshness guarantee.
- `tests/failover.test.mjs:1914-1975,2223-2274`: reusable lifecycle fixture and pending-warning race regressions. There is no `tests/router.test.mjs`; plugin quota tests belong in `tests/failover.test.mjs`.

## A. Progressive short-window assignment steering

Keep the existing durable/longest-period utilization and local-ledger fallback as the base cross-provider comparison. Remove only the short-window `Math.max(durable, burst)` override; a 65% five-hour window must not become 65% weekly usage. Keep observed/unobserved balancing, provider weights, deals, provider rotation, model fit, load, eligibility, context, circuits, outage grants and local shares unchanged.

Add `shortWindowTaper(providerID, {plan, start})` in `lib/budgets.js`, defaulting to cached plan usage and configured top-level `burstFence`. `chooseTarget` obtains a pure taper result that identifies each considered provider and its admission decision. Each provider has its own evaluation counter: on an actual successful new-lease commit, advance the counter for every considered taper provider, including providers rejected in that evaluation. Do not advance counters during previews or held/pinned reuse. Recognized plan-wide windows shorter than seven days count; exclude `:model` subcaps, unknown-period IDs and weekly aliases. Use the maximum finite short-window percentage. Missing/null/blank/nonfinite percentages are unknown, not zero or 100. Unknown/no short window gives weight 1. Clamp valid percentage to [0,100], start to [0,1] (invalid start uses 0.9), and result to [0,1]. Start 1 gives weight 1 below 100 and 0 at 100.

```js
x = clamp((shortPercent / 100 - start) / (1 - start), 0, 1);
w = 1 - x * x;
admit = Math.floor((providerCounter + 1) * w) > Math.floor(providerCounter * w);
```

The live start is reported as 0.75; the code default stays 0.9. This is admission density, not score multiplication: multiplying a winner-takes-all score still creates a winner cliff.

Inside the already-selected candidate stage/group, first obtain the ordinary preferred target with the current ordering. If cloud and density rejects its provider, remove **all** targets from that provider for this attempt and repeat the same ordering over remaining candidates. Try at most the number of unique cloud providers. Never promote a forbidden/delayed fallback rung, outage reserve or excluded target to satisfy the taper. Do not reallocate the configured primary local-share turn. If a permissible local target was already in a fallback group, its existing ordering remains applicable. If every cloud provider rejects, return the original valid preferred target: taper is never a new availability refusal. A single-provider lane therefore keeps progressing. Actual 100% holds remain the existing quota/circuit machinery's responsibility; fallback must never revive an ineligible held target.

Advance the global cursor once per committed ordinary selection, not per attempt or preview. Separately, advance each considered taper provider's counter only at actual successful new-lease commit, including rejected providers; a preview or held/pinned path does not advance it. Retain all sticky/held bypass behavior. Remove the shared-cursor rotation and local-share alias so evaluation density does not depend on unrelated providers' rotation or local turns. Add `short-window-taper` to diversion reasons and an additive `decision.providerShortWindowWeights` map for eligible cloud providers; keep durable `providerUtilization` distinct. A final availability override adds `short-window-taper-availability-fallback` without claiming a diversion occurred.

With an always-preferred provider and an untapered alternative, 10,000 consecutive cloud-cursor opportunities at start 0.75 produce approximately:

| Short usage | Weight / preferred assignments |
| --- | --- |
| <=75% | 1 / 10,000 |
| 80% | .96 / 9,600 |
| 90% | .64 / 6,400 |
| 95% | .36 / 3,600 |
| 99% | .0784 / 784 |

Allow one assignment of floating-point tolerance. These are controlled-fixture opportunity densities, not universal production provider-mix shares: ordinary ranking, eligibility and the available candidate opportunities determine which provider can be selected. Below start, preserve the exact existing distribution, including equal-headroom rotation; do not bias an ordinary tie merely to meet a share claim.

## B. Progressive main-session safety through existing prompts

Extend each `/headroom` provider entry with `weekly: null | {window, percent, resetsAt, fetchedAt, source}`. Match plan-wide IDs `wk`, `week`, `weekly`, `7d`, `168h` only; exclude any colon-scoped entry. If aliases coexist, choose the largest finite percent. Dates are epoch milliseconds or null; percentages are finite and clamped. `source` is `last-fetch`, `cached`, or `unknown`, using optional `freshPlanFor` alongside `planFor`; it never asserts TTL freshness. Missing timestamp remains explicitly unknown. Preserve all existing entry fields and `nearlyOut` semantics, including unknown usage counting as room. No new fetch or persisted write occurs in `/headroom`.

Only a root/main session uses its **currently routed provider's** weekly entry, even when other providers/local capacity leave `nearlyOut` false. No entry or stale/missing metadata invents exhaustion. Cached readings may prompt caution under the existing cached semantics, labelled with source/time or unknown freshness; they cannot create a stop or quota hold.

Weekly-only messages must describe the routed provider and weekly stage without saying that nothing else can take over. The existing no-alternative heading is reserved for an actual `nearlyOut` cause.

| Weekly percent | Main instruction (cumulative) |
| --- | --- |
| <75 / unknown | No weekly warning. |
| >=75 | Prepare now: write/update the durable handoff and update it at stage boundaries; continue authorized work. |
| >=85 | Also checkpoint before **every mutating unit**. Before starting it, write/update the handoff and establish a safe, resumable stopping state if quota pauses for hours/days. |
| >=95 | Also restrict new mutating work to safe, reversible, bounded units. Do not start deployments, migrations, irreversible changes, or an unattended dangerous phase that could remain unfinished. Continue useful safe authorized work below 100; no blanket “start nothing new.” |
| >=100 / genuine limit | Existing exhaustion/parking/failover paths apply. Warning delivery itself adds no stop, abort, model move or tier handoff. |

Main `nearlyOut` warnings (normally 97%, including short-window pressure) likewise require a safe checkpoint and handoff while continuing safe authorized work until a real limit. Replace the old main “start nothing new” wording; retain it only for children. If weekly and lane warnings coincide, send one cumulative main message covering both causes, not competing instructions. A jump straight to 95 delivers all lower-stage obligations in one prompt.

Extend `wrapUpMessage(headroom, {subagent, now, sessionID, providerID, stage})`; add pure `primaryQuotaStage(headroom, providerID)` returning `prepare`, `checkpoint`, `bounded`, or null. It classifies caution, not eligibility, so a recorded 100 remains bounded caution while existing limit handling governs exhaustion. Main lane-only prompts receive `stage: null`. Children never get weekly policy or the main handoff contract. Preserve the session's own agent in synthetic `promptAsync`.

### Durable handoff contract

The prompt **requires** the agent to write/update `~/.local/share/opencode/handoffs/<sessionID>.md` now, before an unsafe/mutating unit as specified above, and at stage boundaries. The agent creates a private directory (0700) and document (0600), validates the session-ID filename (no path traversal), and must not follow an unexpected symlink or overwrite another owner's file. The router sends instructions; it does not capture transcripts or write the document itself.

The document contains: purpose and authorization; decisions; current repository/branch/HEAD and dirty paths with ownership; exact paths/commands; completed work and actual test evidence (including not-run tests); pending/background jobs and cleanup obligations; remaining work and next safe action; and a copy-pasteable resume command verified against the installed CLI help and correct working directory/session. Do not invent a tested resume command. If it cannot be verified, record that fact and the exact missing verification. No secrets, credentials, raw transcripts or unnecessary PII. The agent reports a handoff-write failure explicitly, keeps doing safe nonmutating work, and does not begin the unit whose safety depends on that checkpoint. This is an **instruction-based safety contract**, not hard tool enforcement or a reason to end the authorized task early.

### Episodes and asynchronous ownership

Extend the existing warning tracker with per-session, per-provider, per-stage episode markers; keep the lane-nearly-out marker logically independent. Persist neither markers nor a new subsystem. Preserve successful delivery across idle/release/release-to-same-session cycles, while authoritative same-ID replacement/retirement clears only its owned markers. A provider change selects that provider's marker set; it must not turn the other provider's warning into this provider's warning.

Mark all lower weekly stages covered by a successfully delivered higher stage. Re-arm affected stages after a real observed drop below their boundary (use a one-percentage-point hysteresis), or a confirmed rollover: a newer timestamped reading taken after the previous reset whose new reset advances by at least 60 seconds. Subsecond reset jitter, missing data, timestamp changes alone and failed reads do not re-arm. A material drop with unknown freshness can re-arm on the next current-binding observation but cannot establish exhaustion. Reject older timestamped observations for re-arming. For lane warnings retain the current room-return episode semantics.

Capture route/session/heartbeat before awaits and recheck binding before marker mutation and delivery. Reserve a unique marker before sending. Returned SDK errors and thrown errors remove only the identical attempted marker, leaving a later provider/stage/episode untouched and keeping failed delivery retryable across same-session leases. An old successful send cannot mark a newer episode delivered or suppress its higher stage. Keep the confirmed-missing-session retirement and stale-binding reporting fences. Update toasts/logs to “checkpoint and continue safely” for mains, not a false claim that all sessions were told to stop.

## Acceptance and release boundary

Task A tests pin the density table, baseline order below start, single/all-tapered progress, held-100 exclusion, provider-wide skipping, invalid data/start=1, local shares and pins, counter rotation independent of local-share aliasing, and read-only preview versus actual commit advancement. Task B tests pin weekly aliases/model-subcap exclusion, own-provider selection, 75/85/95 cumulative wording, lane-only main continuation, unchanged child/classifier policy, jitter/drop/rollover, idle/provider/replacement races, and failure retry identity. Unit tests prove prompts and routing decisions, **not agent compliance with writing a file**.

Verified source/test mismatch: `tests/budgets.test.mjs:126-139` still expects an elapsed-reset on-pace result of .60 although current code returns durable .05. Replace that obsolete test with a regression proving reset timing does not change the base. No tests were run while writing these documents.

After both implementation tasks pass review, the parent runs the full `npm test` suite and cuts **one** meaningful-behavior batch, version **1.28.0**, with matching changelog and one commit/push. No per-task commits or releases. The unrelated dirty `gateway/lib/gateway.js` is preserved and excluded from staging; `/home/dev/projects/opencode-broker` is dirty WIP and must not be touched. There is no package-lock.json in this checkout; do not invent one. Deployment/restarts and existing-pane respawns are outside this plan's authorized execution boundary unless separately authorized.
