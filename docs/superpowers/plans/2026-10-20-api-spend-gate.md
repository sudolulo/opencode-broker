# API Spend Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent controlled Anthropic manual API attempts from consuming more than an explicitly confirmed, exclusive promotional allocation by durably reserving maximum liability before every send.

**Architecture:** Pure helpers validate a closed final Messages envelope and complete billing receipts. A lazily loaded SQLite wallet reserves one worst-case charge per HTTP attempt; the gateway binds those reservations to final bytes and broker-attested paid targets. Missing evidence or financial state denies egress or retains the whole reservation, while default successful settlement also burns the whole reservation.

**Tech Stack:** Existing JavaScript ESM, node:test and assert/strict; node:crypto; lazy node:sqlite on a verified Node >=22.13 budget runtime; no new dependencies.

**Spec:** [Authorized design](file:///home/dev/opencode-broker/docs/superpowers/specs/2026-10-20-api-spend-gate-design.md).

## Global Constraints

- Scope is controlled Anthropic native Messages only; unrelated subscription routes remain unchanged.
- Funding is promotional-only, starts at zero, and supports exactly one funding epoch; no monthly/calendar reset, automatic $200 allowance, top-up, purchased-credit fallback, or second funding operation.
- Runtime baseline stays Node >=20.18; spend-budget functionality requires Node >=22.13 with working `node:sqlite`, subject to the parent's capability verification. No dependency addition or package engine bump.
- Import `node:sqlite` lazily only when spend-budget functionality is used; unsupported budget runtimes fail loudly and closed, while unbudgeted gateway operation still loads and functions.
- Use integer nanoUSD and BigInt arithmetic; round USD funding and ceiling strings down to spendable nanoUSD, rejecting positive amounts below one nanoUSD; round computed charges upward if quantization is needed, never floating-point dollars.
- Use SQLite foreign_keys=ON, bounded busy_timeout=1000 ms, journal_mode=WAL, synchronous=FULL, BEGIN IMMEDIATE, and parameterized SQL.
- Implicit ledger opens never create schema, funds, or replacement state; only explicit offline initialization creates an empty wallet.
- Every controlled HTTP attempt has a fresh UUID and a durable DISPATCH_COMMITTED reservation before egress; no replay or timeout/expiry/crash refunds.
- Validate the final serialized request and final effective headers after all shaping, immediately before the guarded fetch; no request mutation after reservation; guarded fetch uses redirect:error.
- Refunds require reconcileUsage:true and a separately confirmed billing receipt contract; default reconcileUsage:false burns the full reservation.
- No production model prices in modules; price/model data belongs in deployment policy, with synthetic Sonnet/Opus examples confined to tests/docs.
- No commits, staging, deployment, host/service edits, credentials, or provider operations are part of this plan's execution authority.

## Review Focus

1. Decimal tails, integer overflow and mixed cache categories must never under-reserve or double-refund — Task 1 `decimal and mixed-cache charges are exact`, Task 2 `duplicate settlement has one refund`.
2. Two processes, a killed sender and a reused UUID must never spend the same allocation — Task 2 `one cross-process winner`, `committed attempts survive process death`, `reused UUID never dispatches`.
3. Final-body/header mutation, credential/origin changes, legacy leases and redirect responses must never bypass admission — Task 3 `final bytes are bound`, `manual binding matrix`, `redirect cannot escape`.
4. Split/oversized/error SSE and downstream disconnect must retain full liability without extra reads or unbounded observer storage — Task 1 `bounded incremental SSE`, Task 3 `disconnect stops upstream and retains hold`.
5. Missing/corrupt/expired/unsafe ledger, a second funding attempt and unsupported SQLite runtime must fail closed without resetting funds or breaking subscriptions — Task 2 `lifecycle never resets`, Task 3 `financial errors have zero upstream calls` and `unbudgeted Node baseline still loads`.

---

## Execution ruling and progress ledger

This document is planning output; its author does not execute production work. The parent is authorized to execute the approved design without another approval ceremony, retains final security/integration judgment, and first reads this plan plus the spec. Use existing executing-plans progress tracking with three serialized sp-implementers; send exact test commands to tester and use a fresh independent final reviewer. No concurrent writers overlap these tasks. Do not use plan-run/review-panel here: runtime.directory is the nongit anthro directory and plan-run requires unauthorized commits. Do not create replacement workflows or change the tooling to make that path work.

- [x] Task 1 pure policy/receipt helpers and shared fixtures — completed and verified; covered by the later full-suite results below.
- [x] Task 2 durable ledger and offline CLI — completed and verified; covered by the later full-suite results below.
- [x] Task 3 integration and operator docs (historical checkpoint) — source/offline verification at that time: 119/119 focused and 2,317/2,317 full on Node v24.16.0. Superseded by the [latest follow-up status](#latest-follow-up-status-2026-10-20); no activation claim.
- [x] Fresh independent final financial/security review (historical checkpoint; single reviewer, not a panel), parent disposition, fixes to three Important findings, and verification at that time: 219/219 focused and 2,403/2,403 full on Node v24.16.0. Its five deferred Minor findings are superseded by the [latest follow-up status](#latest-follow-up-status-2026-10-20) (four fixed, one open).

Run every command with working directory `/home/dev/opencode-broker`, never the session's `/home/dev/projects/anthro`. Preserve existing manual API files/tests and all unrelated changes. Use background execution for long suites; the parent owns cleanup of jobs and test-owned temporary files. All network tests are fake/local fetchImpl tests, not provider calls. Real credential access, installations, host/deploy changes and funding are outside this implementation authority.

## File ownership map

| Task | Create | Modify |
| --- | --- | --- |
| 1 | `gateway/lib/spend-policy.js`, `gateway/lib/spend-receipt.js`, `gateway/tests/helpers/spend-fixture.mjs`, `gateway/tests/spend-policy.test.mjs`, `gateway/tests/spend-receipt.test.mjs` | None |
| 2 | `gateway/lib/spend-budget.js`, `gateway/bin/opencode-broker-spend-budget`, `gateway/tests/spend-ledger.test.mjs`, `gateway/tests/spend-budget-cli.test.mjs`, `gateway/tests/helpers/spend-worker.mjs` | None; only Task 1 fixture extensions if an interface defect is explicitly resolved before Task 3 |
| 3 | `gateway/tests/spend-budget.test.mjs`, `docs/SPEND-BUDGET.md` | `gateway/lib/gateway.js`, `bin/opencode-broker`, `tests/manual-api-profile.test.mjs`; `lib/manual-api.js`, `lib/config.js`, `lib/routing.js` only if necessary to preserve/validate registered target metadata; existing gateway/manual API tests only for real integration coverage |

No package version, package engine, package bin entry, host configuration, or deployment change is required. Invoke the offline CLI with node directly. Before editing a known large source file the executor follows its own delegated exploration rules; the source anchors below are parent-supplied rather than verified by this writing task.

## Shared types and exact contracts

Money `Nano` means nonnegative BigInt, <= 9223372036854775807n wherever stored in SQLite INTEGER. API JSON uses canonical unsigned decimal strings. `Timestamp` means safe-integer UTC epoch milliseconds. `Digest` means lowercase 64-character SHA-256 hex. Error objects have `.code` from the refusal list in the spec; no credential/body values in `.message`.

`RawPolicy` is exactly the spendBudget object in spec section 4. `Policy` is an immutable normalized object with the same semantic fields, `ceilingNano:bigint`, `validUntilMs:number`, normalized `models[id].ratesNanoUSD` BigInts, explicit `reconcileUsage:boolean`, optional validated billingReceiptContract, and `policyHash:Digest`; it retains no raw credential. `normalizeSpendPolicy(raw:RawPolicy):Policy` is synchronous and throws invalid_policy for unknown fields, invalid types, unsupported origin, invalid digest, zero/overflow rates/bounds, or invalid money/time. It does not inspect files or a provider.

`prepareSpendAttempt({policy:Policy,providerID:string,url:string,body:string,headers:Headers|Record<string,string>,credentialFingerprint:Digest,now:number}):PreparedAttempt` is synchronous. It returns an immutable `{policyHash,providerID,origin,credentialFingerprint,model,maxInputTokens,maxOutputTokens,ratesNanoUSD,reserveNano,body,bodyDigest,requestDigest,url,headers}`. `headers` is a canonical immutable array of header pairs containing actual final outbound values in memory only; neither it nor `body` is stored in the ledger. The request digest substitutes the credential fingerprint for credential bytes. `maxOutputTokens` is the request's explicit max_tokens, not the policy cap. `PreparedAttempt` is private gateway data; clients cannot submit it.

`ReceiptEvidence` is `{kind:'json'|'sse',complete:boolean,messageID:string|null,model:string|null,usage:{input_tokens:number,cache_creation_input_tokens:number,cache_read_input_tokens:number,output_tokens:number}|null,cacheCreationBreakdown:null|{ephemeral_5m_input_tokens:number,ephemeral_1h_input_tokens:number},initialOutputTokens:number|null,errorCode:string|null}`. Missing required components remain missing evidence, never zero-filled. Production parsing rejects fractional, unsafe-integer, negative and duplicate/conflicting identity/terminal fields. A stream accepts one or more ordered cumulative message_delta snapshots, replacing validated counters rather than summing them; later counters cannot regress.

`parseMessagesReceipt({bodyText:string,httpStatus:number}):ReceiptEvidence` validates bounded buffered JSON. `createSpendSSEObserver({maxEventBytes=65536}={}):SpendSSEObserver` returns `{push(chunk:Uint8Array):void,finish():ReceiptEvidence,snapshot():{bufferedBytes:number,failed:boolean}}`. It uses fatal incremental UTF-8 validation, bounds each SSE event rather than each network chunk, treats message_delta output as cumulative, tracks completion and identity, rejects errors/invalid order/malformed JSON and unterminated trailing bytes, and becomes irreversibly uncertain on limits. `finish()` is idempotent; push after finish fails closed. No chunk/body text is exposed in evidence or errors. Parser limits apply to bytes, not JS UTF-16 length.

`validateSpendReceipt({attempt:AttemptSnapshot,evidence:ReceiptEvidence}):ValidatedReceipt` recomputes money/bounds/hash synchronously. `AttemptSnapshot` includes attemptID, epochID, requestDigest, bodyDigest, policyHash, providerID, origin, credentialFingerprint, model, maxInputTokens, maxOutputTokens, frozen ratesNanoUSD and reserveNano. `ValidatedReceipt` is `{attemptID,epochID,requestDigest,policyHash,receiptHash,messageID,model,usage,complete:true,actualCostNano:bigint,boundsViolated:boolean,additionalLiabilityNano:bigint,evidence:ReceiptEvidence}`; bounds violation is returned as evidence to freeze, not discarded as an ordinary parser error. Invalid/incomplete evidence throws invalid_receipt. The hash covers canonical evidence plus attempt/epoch/request/policy binding, not caller-provided money.

`initializeLedger({ledgerPath:string,policy:Policy,now:number}):Promise<LedgerStatus>` exclusively creates a zero wallet. `fundLedger({ledgerPath,policy,allocation:{amountUSD:string,reference:string,confirmedAt:string,expiresAt:string,providerID:string,origin:string,credentialFingerprint:Digest,exclusivePromotionalAllocation:true},now:number}):Promise<LedgerStatus>` funds once. `reserveAttempt({ledgerPath,policy,prepared:PreparedAttempt,attemptID:string,now:number}):Promise<Reservation>` commits before returning. `Reservation` is an immutable `AttemptSnapshot` plus `state:'DISPATCH_COMMITTED'` and `createdAtMs:number`. Ledger functions validate snapshots themselves; caller objects are not financial authority.

`settleAttempt({ledgerPath,policy,attemptID:string,evidence:ReceiptEvidence,now:number}):Promise<SettlementResult>` reads the stored snapshot, calls validateSpendReceipt, and atomically records/refunds or freezes. `SettlementResult` is `{state:'SETTLED'|'UNCERTAIN',duplicate:boolean,frozen:boolean,retainedNano:bigint,refundedNano:bigint,actualCostNano:bigint|null,additionalLiabilityNano:bigint}`. Incomplete/invalid evidence is caught inside this operation and atomically marks UNCERTAIN, retaining the full hold with actualCostNano null, not zero. Additional liability is recorded known excess only; zero there is not a claim that unknown liability is zero. A conflicting receipt commits a violation/freeze then throws frozen. `markUncertain({ledgerPath,policy,attemptID:string,reason:string,now:number}):Promise<void>` retains all money and does not downgrade SETTLED; a repeated reason is idempotent. `inspectStatus({ledgerPath,policy,now:number}):Promise<LedgerStatus>` never repairs or creates state. `LedgerStatus` contains `{schemaVersion:1,policyHash,fundedNano,availableNano,heldNano,spentNano,observedCostNano,additionalLiabilityNano,frozen,expired,epochID:string|null,reference:string|null,attemptCounts:{DISPATCH_COMMITTED:number,SETTLED:number,UNCERTAIN:number}}`; totals are BigInt and observed cost sums one recorded cost per receipt-bearing attempt, not estimated cost for unknown receipts. Every ledger operation closes its connection in finally.

## Task 1: Pure policy, final-request and receipt contracts

**Files:** Create the five Task 1 files in the ownership map. No existing production imports are changed yet.

**Consumes:** RawPolicy, timestamps and exact native Messages bytes; no SQLite, actual keys, network, broker state or host configuration.

**Produces:** normalizeSpendPolicy, prepareSpendAttempt, parseMessagesReceipt, createSpendSSEObserver, validateSpendReceipt with the exact contracts above, and all shared fixtures below. Later tasks import these names rather than independently reimplementing price/hash/parser logic.

### Fixtures — fully defined synthetic values

`gateway/tests/helpers/spend-fixture.mjs` exports these constants and functions. All rate numbers are synthetic test data, NOT current provider prices:

```js
export const NOW = Date.parse('2026-10-20T12:00:00.000Z');
export const MODEL = 'claude-sonnet-4-5-20250929';
export const OPUS_MODEL = 'claude-opus-4-1-20250805';
export const PROVIDER_ID = 'manual-anthropic-fixture';
export const ORIGIN = 'https://api.anthropic.com';
export const TEST_KEY = 'synthetic-not-a-provider-key';
export const ATTEMPT_A = '11111111-1111-4111-8111-111111111111';
export const ATTEMPT_B = '22222222-2222-4222-8222-222222222222';
```

Import createHash from node:crypto and export `FINGERPRINT = createHash('sha256').update(TEST_KEY).digest('hex')`. `rawPolicy(ledgerPath, overrides={})` returns a fresh object with ledgerPath, policyID `fixture-v1`, validUntil `2026-10-21T12:00:00.000Z`, ceilingUSD `'0.000050000'`, binding `{providerID:PROVIDER_ID,origin:ORIGIN,credentialSHA256:FINGERPRINT}`, reconcileUsage false, and two model entries: MODEL input/output bounds 100/10 and rates input/cacheRead/cacheWrite1h/output `'2'/'1'/'3'/'5'`; OPUS_MODEL bounds 200/20 and rates `'4'/'2'/'6'/'10'`. Apply overrides only at top level, so callers explicitly replace nested maps when testing them. Never retain or mutate shared fixture objects.

`policyFor(ledgerPath,overrides={})` returns normalizeSpendPolicy(rawPolicy(...)). `bodyFor(overrides={})` returns JSON.stringify of `{model:MODEL,messages:[{role:'user',content:'hello'}],max_tokens:10,stream:false,service_tier:'standard_only',...overrides}`. `headersFor(overrides={})` returns a new Headers with content-type application/json, anthropic-version 2023-06-01 and x-api-key TEST_KEY, then applies overrides. `preparedFor(policy,bodyOverrides={})` calls prepareSpendAttempt with PROVIDER_ID, ORIGIN+'/v1/messages', bodyFor(bodyOverrides), headersFor(), FINGERPRINT, NOW.

`allocationFor(amountUSD='0.000000700',overrides={})` returns `{amountUSD,reference:'promo-fixture-1',confirmedAt:'2026-10-20T11:00:00.000Z',expiresAt:'2026-10-21T11:00:00.000Z',providerID:PROVIDER_ID,origin:ORIGIN,credentialFingerprint:FINGERPRINT,exclusivePromotionalAllocation:true,...overrides}`. Two reservations of 350n exactly exhaust this allocation.

`messageFor(overrides={})` returns a fresh `{id:'msg_fixture_1',type:'message',role:'assistant',model:MODEL,content:[{type:'text',text:'ok'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:2,cache_creation_input_tokens:3,cache_read_input_tokens:4,output_tokens:5},...overrides}`. Full conservative observed cost is 42n; reserve-and-burn retains 350n, verified-refund mode releases 308n.

`evidenceFor(overrides={})` returns `{kind:'json',complete:true,messageID:'msg_fixture_1',model:MODEL,usage:{input_tokens:2,cache_creation_input_tokens:3,cache_read_input_tokens:4,output_tokens:5},cacheCreationBreakdown:null,initialOutputTokens:null,errorCode:null,...overrides}`. `snapshotFor(prepared,overrides={})` copies ONLY the AttemptSnapshot fields, adds attemptID ATTEMPT_A and epochID `'33333333-3333-4333-8333-333333333333'`, then applies overrides.

`sseFor()` returns UTF-8 bytes for four valid events, each terminated by two newlines: message_start with `{type:'message_start',message:{...messageFor(),content:[],usage:{input_tokens:2,cache_creation_input_tokens:3,cache_read_input_tokens:4,output_tokens:1}}}`; content_block_delta with `{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ok'}}`; message_delta with `{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}}`; message_stop with `{type:'message_stop'}`. Every event line is `event: <type>`, followed by `data: <JSON>`. `chunksOf(bytes,width)` returns consecutive Uint8Array subarrays of positive width, with no copying assumption.

`withLedgerDir(fn)` creates a test-owned temporary directory using mkdtemp under os.tmpdir, sets mode 0700, passes `join(dir,'wallet.sqlite')` to async fn, and recursively removes that directory in finally after child processes/handles are closed. No build/dependency output lives in /tmp. `confirmedRefundPolicy(ledgerPath)` calls policyFor with reconcileUsage true and billingReceiptContract `{confirmedAt:'2026-10-20T10:00:00.000Z',reference:'synthetic-contract-fixture'}`; this is test-only evidence, not production approval.

- [ ] **Step 1: Write minimal RED policy tests**, including the exact maximum-reservation assertion:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { policyFor, preparedFor, rawPolicy, MODEL } from './helpers/spend-fixture.mjs';
import { normalizeSpendPolicy } from '../lib/spend-policy.js';
test('maximum context, not short text, sets the reservation', () => {
  assert.equal(preparedFor(policyFor('/synthetic/wallet.sqlite')).reserveNano, 350n);
});
test('unknown policy keys are rejected', () => {
  assert.throws(() => normalizeSpendPolicy(rawPolicy('/synthetic/wallet.sqlite', { monthlyUSD: '200' })),
    { code: 'invalid_policy' });
});
test('decimal and mixed-cache charges are exact', () => {
  assert.throws(() => normalizeSpendPolicy(rawPolicy('/synthetic/wallet.sqlite', { ceilingUSD: '0.0000000001' })), {code:'invalid_policy'});
  const p = normalizeSpendPolicy(rawPolicy('/synthetic/wallet.sqlite', { ceilingUSD: '0.0000000019' }));
  assert.equal(p.ceilingNano, 1n);
  assert.equal(p.models[MODEL].ratesNanoUSD.cacheWrite1h, 3n);
});
```

- [ ] **Step 2: Run RED**: `node --experimental-test-module-mocks --test gateway/tests/spend-policy.test.mjs`. Expected: nonzero missing-module/export failure before implementation. After module scaffolding exists, every new behavior test must fail on the intended assertion, not an unrelated loader error; record both stages.

- [ ] **Step 3: Add receipt RED tests** using the defined parser/evidence contracts:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpendReceipt, createSpendSSEObserver } from '../lib/spend-receipt.js';
import { policyFor, preparedFor, snapshotFor, evidenceFor, sseFor, chunksOf } from './helpers/spend-fixture.mjs';
test('complete mixed-cache receipt costs 42 nanoUSD', () => {
  const attempt = snapshotFor(preparedFor(policyFor('/synthetic/wallet.sqlite')));
  assert.equal(validateSpendReceipt({ attempt, evidence: evidenceFor() }).actualCostNano, 42n);
  assert.throws(() => validateSpendReceipt({ attempt, evidence: evidenceFor({ usage: null }) }),
    { code: 'invalid_receipt' });
});
test('bounded incremental SSE', () => {
  const observer = createSpendSSEObserver();
  for (const part of chunksOf(sseFor(), 1)) observer.push(part);
  const evidence = observer.finish();
  assert.equal(evidence.complete, true);
  assert.equal(evidence.usage.output_tokens, 5);
  assert.ok(observer.snapshot().bufferedBytes <= 65536);
  const oversized = createSpendSSEObserver({ maxEventBytes: 32 });
  oversized.push(new TextEncoder().encode('data: ' + 'x'.repeat(100)));
  assert.equal(oversized.finish().complete, false);
  assert.ok(oversized.snapshot().bufferedBytes <= 32);
});
```

- [ ] **Step 4: Pin policy boundaries with table-driven failing cases**. In spend-policy.test.mjs use `assert.throws(() => preparedFor(policyFor(path), override), {code:'unsupported_request'})` for max_tokens 0, -1, 1.5, missing, 11, unknown model, fast/service-tier auto, server tool types, MCP/container/batch extras and unknown top-level properties. Direct prepare calls cover wrong provider, non-global origin, credential mismatch, beta/region headers, duplicate auth, URL userinfo/query/path, expired policy, unsafe integers and reserve overflow. Add accepted client-tool, image-content, bounded-thinking, exact-cap, and reordered-JSON-hash controls. The body digest must change for changed final bytes; the policy hash must not change for mere object-key ordering.

- [ ] **Step 5: Pin receipt boundaries with failing cases**. Parse messageFor JSON and remove each required usage field separately; test negatives/fractions/unsafe integers, malformed JSON, missing message/model, duplicate start/stop, terminal-before-start, SSE error, output regression, incomplete EOF, CRLF/multibyte splits, cache breakdown mismatch and matching breakdown without double count. For input 101 or output 11, assert boundsViolated true, not a fabricated cheap valid receipt. Generate an oversized nonstream collector case in Task 3, where collection is owned.

- [ ] **Step 6: Implement the minimal pure helpers** using these explicit algorithms, without adding a production price table: normalize strict shapes and decimal-to-BigInt floor parse for credit/ceilings and conservative charge arithmetic; canonicalize/hash policy; validate the closed nested request envelope; hash final bytes/header fingerprint binding; compute maximum charge; incrementally parse bounded SSE; normalize complete usage; compute frozen per-category cost and receipt hash; report over-bound evidence for the ledger. Use Object.freeze/defensive copies for snapshots. No filesystem or financial side effects belong in these modules. Do not include a full production implementation in this plan.

- [ ] **Step 7: Tester runs** `node --experimental-test-module-mocks --test gateway/tests/spend-policy.test.mjs gateway/tests/spend-receipt.test.mjs`, then `npm test`. Expected: all focused tests pass and the entire existing suite plus added tests passes; report exact totals rather than reusing the earlier 2,007 count. If a test does not catch its feature, the parent uses the authorized stash/stash-pop verification procedure without disturbing pre-existing work, never git restore/checkout. Record outcomes and resolve defects before Task 2. No commit/staging step.

## Task 2: Atomic SQLite wallet and explicit offline lifecycle

**Files:** Create gateway/lib/spend-budget.js, gateway/bin/opencode-broker-spend-budget, gateway/tests/spend-ledger.test.mjs, gateway/tests/spend-budget-cli.test.mjs, and gateway/tests/helpers/spend-worker.mjs.

**Consumes:** Policy, PreparedAttempt, AttemptSnapshot, ReceiptEvidence, validateSpendReceipt, and all Task 1 fixtures, exactly as defined above. **Produces:** initializeLedger, fundLedger, reserveAttempt, settleAttempt, markUncertain and inspectStatus, with the shared signatures and schema in spec section 6. No network dispatch is performed by this task.

- [ ] **Step 1: Write the minimal RED lifecycle/reservation test**:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeLedger, fundLedger, reserveAttempt, inspectStatus } from '../lib/spend-budget.js';
import { withLedgerDir, policyFor, preparedFor, allocationFor, NOW, ATTEMPT_A } from './helpers/spend-fixture.mjs';
test('zero wallet refuses; one allocation can reserve exactly once per UUID', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = policyFor(ledgerPath);
    await initializeLedger({ ledgerPath, policy, now: NOW });
    const args = { ledgerPath, policy, prepared: preparedFor(policy), attemptID: ATTEMPT_A, now: NOW };
    await assert.rejects(reserveAttempt(args), { code: 'insufficient_funds' });
    await fundLedger({ ledgerPath, policy, allocation: allocationFor('0.000000350'), now: NOW });
    const reservation = await reserveAttempt(args);
    assert.equal(reservation.state, 'DISPATCH_COMMITTED');
    const status = await inspectStatus({ ledgerPath, policy, now: NOW });
    assert.equal(status.availableNano, 0n);
    assert.equal(status.heldNano, 350n);
    await assert.rejects(reserveAttempt(args));
  });
});
```

- Funding precision controls: amountUSD 0.0000003509 provides exactly 350n; positive subnano funding is rejected without minting funds. Parent directory and ancestor checks follow spec section 6: no symlinks or group/other-writable ancestors, except a root-owned sticky directory such as /tmp; no automatic chmod of existing files.

- [ ] **Step 2: Tester runs RED** `node --experimental-test-module-mocks --test gateway/tests/spend-ledger.test.mjs`. Expected: nonzero missing export/module, then targeted assertion failure before each financial behavior is implemented. Run this on the parent's verified SQLite runtime; do not install a runtime or silently skip when node:sqlite is absent.

- [ ] **Step 3: Add settlement RED controls**, with separate complete setup per test:

```js
test('duplicate settlement has one refund', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = confirmedRefundPolicy(ledgerPath);
    await initializeLedger({ ledgerPath, policy, now: NOW });
    await fundLedger({ ledgerPath, policy, allocation: allocationFor('0.000000350'), now: NOW });
    await reserveAttempt({ ledgerPath, policy, prepared: preparedFor(policy), attemptID: ATTEMPT_A, now: NOW });
    const args = { ledgerPath, policy, attemptID: ATTEMPT_A, evidence: evidenceFor(), now: NOW };
    assert.equal((await settleAttempt(args)).refundedNano, 308n);
    assert.equal((await settleAttempt(args)).duplicate, true);
    const status = await inspectStatus({ ledgerPath, policy, now: NOW });
    assert.equal(status.availableNano, 308n);
    assert.equal(status.spentNano, 42n);
    assert.equal(status.heldNano, 0n);
  });
});
```

Import settleAttempt plus confirmedRefundPolicy/evidenceFor in that test file. Duplicate result reports the historical retained/refunded amounts with duplicate true, not a new transfer. Separate tests pin default policy retained=350n/refunded=0n/observed=42n, reconcileUsage true without contract still no refund, incomplete evidence -> UNCERTAIN, repeated uncertain no-op, late complete receipt after expiry, conflicting receipt freeze, output/input over-bound freeze, and actual cost above reservation recorded without clamp (e.g. output_tokens 100 gives 517n actual and 167n additional liability). The default max_tokens 10 bound is violated by that case even before cost comparison; both reasons must be visible.

- [ ] **Step 4: Implement schema and transactions**, exactly the four tables in spec section 6. Lazy import node:sqlite inside budget operations; assert required DatabaseSync capabilities and readBigInts support. Configure all four required pragmas, verify their returned values, and fail closed if durability cannot be established. A private existing parent and exclusive 0600 initialization are mandatory; runtime opens use existing read/write state only. Every operation opens/closes in finally; mutation performs BEGIN IMMEDIATE, validates full invariants, makes one transition, validates again, COMMIT, and rolls back on failure. No implicit initialization/migration/repair or SUM overflow. Store frozen rate/model/request/epoch binding on each attempt, never the raw request/key. Implement exact invariants, policy comparison, freeze/violation persistence, and one-time funding before considering performance shortcuts.

- [ ] **Step 5: Add cross-process/crash RED tests and worker**, not mocked single-process promises. `gateway/tests/helpers/spend-worker.mjs` is an IPC-only node child script invoked with mode `reserve` or `reserve-then-wait`, ledgerPath and attemptID arguments; parent sends serialized RawPolicy over IPC. Worker normalizes it, prepares the defined synthetic request and uses NOW. For reserve mode it waits for IPC `{type:'go'}`, returns `{type:'result',ok:true}` or `{type:'result',ok:false,code}` and exits. For reserve-then-wait it reports `{type:'committed'}` only after reserveAttempt returns, then awaits termination without fetching. It never reads actual credentials/config or initializes/funds the database. Parent test cleans up every child in finally.

Use two simultaneously released workers with ATTEMPT_A/B and a 350n wallet: exactly one result succeeds, the other is insufficient_funds, available=0 and held=350. Kill reserve-then-wait with SIGKILL after committed; reopen and assert the hold survives and reused UUID fails. Kill a worker before release and assert no debit. Task 3 supplies the post-send crash case. Hold BEGIN IMMEDIATE on a separate test connection and assert bounded lock refusal, unchanged counters and no fallback; close it in finally.

- [ ] **Step 6: Add lifecycle/security RED tests** `lifecycle never resets`: second initialize, second fund with same/different reference, expired/burned epoch, amount above ceiling, nonexclusive allocation, malformed timestamps, missing file/parent, symlink path, wrong owner/mode where testable without privilege, corrupt bytes, missing schema, changed policy/provider/origin/credential, negative counters and mismatched attempt sums all fail without creating/replacing state. Tests must assert prior balances remain exact after each refused funding/reset. Test canonical decimal tails, signed-64 overflow, all valid state transitions, frozen admission refusal, unsafe receipt text overflow recording, and SQL values containing quotes as parameters. Do not mutate host ownership/permissions to run a test; use test-owned directories and injected metadata for inaccessible ownership cases.

- [ ] **Step 7: Define and test the offline CLI**. File is ESM invoked as `node gateway/bin/opencode-broker-spend-budget <command> --policy <path>`, with command init, fund or status. Policy file contains ONLY the strict spendBudget object, not a gateway config/key. Fund additionally requires `--amount-usd <decimal> --reference <string> --confirmed-at <ISO> --expires-at <ISO> --provider-id <id> --origin <origin> --credential-sha256 <digest> --confirm-exclusive-promotional-allocation`; all required, no interactive prompt. Paths/digests are nonsecret; CLI must reject raw key flags/unknown flags. Init creates zero only; status opens existing only. Print a single JSON object with decimal-string money, status and no key; refused actions print structured errors to stderr and exit nonzero. CLI never fetches credentials, checks an online balance, updates providers, starts services or supplies funds by default. Child-process CLI tests cover success, invalid/missing flags, duplicate init/fund, existing/corrupt state preserved, status zero and refusal output. No package bin/version edit.

- [ ] **Step 8: Tester runs** `node --experimental-test-module-mocks --test gateway/tests/spend-ledger.test.mjs gateway/tests/spend-budget-cli.test.mjs`, then `npm test`. Expected: all focused lifecycle/concurrency/crash tests and full suite pass; no silently skipped runtime checks, child processes, DB/WAL/SHM leftovers, or background jobs. Record actual Node version and required SQLite capability outcomes; parent resolves feature-floor evidence before Task 3. No commit/staging step.

## Task 3: Broker attestation, final-fetch guard, bounded receipts and operator docs

**Files:** Create gateway/tests/spend-budget.test.mjs and docs/SPEND-BUDGET.md; modify gateway/lib/gateway.js and bin/opencode-broker; extend tests/manual-api-profile.test.mjs. Only modify the listed manual API/config/routing helpers if the attestation cannot otherwise survive existing target normalization. Preserve all existing manual API behavior outside the newly required spend admission. **Parent execution ruling:** the independent broker annotation slice was already pulled forward, disjoint from Task 2 hardening; preserve it and run combined verification. Task 3 may isolate bounded transport consumption in gateway/lib/spend-transport.js and a test-only adapter over the real handler in gateway/tests/helpers/spend-gateway-fixture.mjs, and extend spend-worker.mjs only with the two gateway death modes. It must not weaken Task 1/2 modules. This deliberately selected Deep pass writes/tests inline under the supplied authority; the parent retains the fresh independent review after it.

**Consumes:** All Task 1/2 APIs and fixtures. **Produces:** registered-target billing attestation on lease responses; strict provider spendBudget validation; one guarded native Messages dispatch point for every controlled attempt; bounded receipt-driven settlement; terminal structured financial refusals; source-only operator instructions. Existing createGatewayHandler accepts config, brokerRequest, fetchImpl, gatewayKey, authPath, now and existing optional fields; do not invent a second production handler or bypass its authentication/routing.

- [x] **Step 1: Reverify source anchors and audit dispatch paths before editing**. Parent-supplied hints: gateway provider validation near 489/497 and createGatewayHandler near 1261/1287; existing receipt handling near 885–959; final serialization near 2017, final health/header shaping near 2018–2054, actual attempt fetch near 2055. Broker /lease near 2180–2258 computes publicTarget near 2208, appliedTarget near 2220, reply.target near 2246. Trace every upstream fetch and retry/fallback for the controlled provider and write the audit result in task progress. Existing usage chars/4 remains nonfinancial; do not reuse it. Do not change native Messages into an OpenAI envelope.

- [x] **Step 2: Build test-local integration adapters over the real handler**, after reading the current gateway/manual API test factory. In gateway/tests/spend-budget.test.mjs define `makeHarness({ledgerPath,policyOverrides={},attested=true,includePolicy=true,fetchImpl,brokerTargetOverrides={}}):Promise<{handler,policy,upstreamCalls:()=>number,send:(bodyOverrides?,requestOptions?)=>Promise<Response>,close:()=>Promise<void>}>`. It creates a gateway config using the actual existing schema, a single fake Anthropic provider with TEST_KEY and provider.spendBudget=rawPolicy when includePolicy, and a brokerRequest stub returning its real lease shape with registered-like billingClass/manual attestation unless disabled. handler is the real createGatewayHandler with now=()=>NOW and fake/local auth fixture. send makes an authenticated native Messages request through that real handler; it never fetches the remote origin except through the injected fake fetchImpl. Wrap fetchImpl to increment upstreamCalls before invoking the fake. close releases harness-owned resources only. Policy is policyFor(ledgerPath,policyOverrides). Reuse existing auth fixture patterns; no actual key file, gateway key or provider access. This adapter is local to Task 3, not a new production interface.

- [x] **Step 3: Write the minimal no-egress RED test**:

```js
test('missing ledger has zero upstream calls', async () => {
  await withLedgerDir(async ledgerPath => {
    const h = await makeHarness({ ledgerPath,
      fetchImpl: async () => new Response(JSON.stringify(messageFor()), {status:200}) });
    try {
      const response = await h.send();
      assert.equal(response.status, 402); // review-fix ruling: was 503, see "Review-fix pass" below
      assert.equal(response.headers.get('x-should-retry'), 'false');
      assert.equal((await response.json()).error.type, 'spend_budget_refusal');
      assert.equal(h.upstreamCalls(), 0);
    } finally { await h.close(); }
  });
});
```

Import every symbol used in each snippet explicitly, including test/assert, withLedgerDir, messageFor, NOW, policyFor, allocationFor, and initializeLedger/fundLedger/inspectStatus plus the other Task 2 APIs as used. Tester runs `node --experimental-test-module-mocks --test --test-name-pattern='missing ledger has zero upstream calls' gateway/tests/spend-budget.test.mjs`; expected before integration: assertion failure because old code either sends or lacks the required refusal, not a fixture/auth/config error. Establish one successful baseline fixture call first so the RED failure is about admission.

- [x] **Step 4: Implement broker/provider defense and terminal admission**. Derive requiresSpendBudget:true and billingClass:'manual-api' exclusively from registered manualApiTargets at lease target construction, preserving fields through applied/public target shaping. Caller-supplied target metadata cannot attest itself. Extend manual-api-profile.test.mjs: registered manual target gets both fields on the lease target, an ordinary subscription target does not, and spoofed caller metadata does not create a paid target. Strictly normalize provider.spendBudget during configuration validation without opening/creating its ledger. If startup can identify a registered manual target missing a policy/binding, fail configuration validation loudly; when target knowledge is unavailable at startup, explicitly report that validation is deferred and always enforce it at request time. At admission, provider policy alone requires the guard even on legacy/no-attestation leases; paid attestation requires a matching policy. Contradictory/unknown classification, provider/origin/key-digest mismatch and unsupported envelopes are terminal spend_budget_refusal, not retry/backoff/fallback. Update existing manual API integration fixtures to use an explicitly funded synthetic test wallet where success now requires it, or assert the new terminal refusal; do not remove the attestation or weaken the gate merely to retain old success assertions.

- [x] **Step 5: Add the decisive final-fetch binding test**, using a fake that observes exact bytes and durable state:

```js
test('final bytes are bound and durable before fetch', async () => {
  await withLedgerDir(async ledgerPath => {
    const policy = policyFor(ledgerPath);
    await initializeLedger({ ledgerPath, policy, now: NOW });
    await fundLedger({ ledgerPath, policy, allocation: allocationFor('0.000000350'), now: NOW });
    let seen = 0;
    const h = await makeHarness({ ledgerPath, fetchImpl: async (url, init) => {
      seen++;
      assert.equal(new URL(url).origin, ORIGIN);
      assert.equal(init.redirect, 'error');
      assert.equal(JSON.parse(init.body).service_tier, 'standard_only');
      assert.equal(JSON.parse(init.body).max_tokens, 10);
      const s = await inspectStatus({ledgerPath,policy,now:NOW});
      assert.equal(s.availableNano, 0n);
      assert.equal(s.heldNano, 350n);
      return new Response(JSON.stringify(messageFor()), {status:200,
        headers:{'content-type':'application/json'}});
    }});
    try { await (await h.send()).text(); assert.equal(seen, 1); }
    finally { await h.close(); }
    const s = await inspectStatus({ledgerPath,policy,now:NOW});
    assert.equal(s.spentNano, 350n);
    assert.equal(s.observedCostNano, 42n);
  });
});
```

Also inspect the attempt row through a test-only read-only connection to compare its request/body digest with prepareSpendAttempt over the exact bytes/headers captured by fake fetch. Do not add a production raw-attempt dump that leaks headers/body. If current gateway response consumption finalizes asynchronously, the harness exposes an explicit bounded observer-drain promise through test-local plumbing rather than arbitrary sleeps; ensure real handler completion actually owns settlement work.

- [x] **Step 6: Integrate per-attempt reservation immediately before fetch**. Finish body/auth/header shaping, pin an absent tier to standard_only but reject an explicit premium/different tier, prepare/freeze final bytes and effective headers with the actual in-memory credential digest, allocate crypto.randomUUID, await reserveAttempt, and invoke fetchImpl(url,{...finalInit,body:prepared.body,headers:prepared.headers,redirect:'error'}). **Parent health ruling:** global direct Anthropic cannot verify proxy-only private fleet context. Never invoke healthReporter or generate private fleet/session headers for guarded traffic; refuse required health, probe/outage-health and fast scope before egress. Explicit unsupported controls are refused, not stripped; ordinary proxy health is unchanged. No downstream shaping occurs after reservation. Catch budget errors before generic retry logic. Fetch exceptions and failed HTTP mark that attempt UNCERTAIN without refund; an allowed HTTP retry, if current retry policy permits it, needs another UUID/reservation and cannot reuse the earlier one. If funds cannot cover the retry, return terminal financial refusal. A redirect error has already consumed a reservation and remains uncertain; it must not follow to another origin. Audit that every guarded paid fetch, including fallback paths, obeys this sequence.

- [x] **Step 7: Wire bounded observation without changing ordinary subscription response semantics**. For guarded SSE use one upstream reader, await the Node sink's backpressure before another pull, and call observer.push once per forwarded chunk; on normal EOF call finish then settleAttempt (invalid evidence retains UNCERTAIN). Continue bounded SSE pass-through after its 65,536-byte per-event observation limit, without accumulating the full stream. **Parent JSON-memory ruling:** collect guarded nonstream JSON, including HTTP errors, with a hard 1,048,576-byte cap. Overflow aborts the actual fetch controller and cancels the reader, marks UNCERTAIN and returns a terminal error without retry or further receipt reads. Legitimate larger paid JSON replies are refused; subscription JSON is unchanged. On downstream cancel, abort upstream AND cancel its reader, mark uncertain and stop new pulls. Release locks in finally; the actual handler awaits cleanup, settlement and completion reporting, never detached promises. Never clone the response into an undrained unbounded tee. Settlement storage errors are explicit local failures; do not fabricate a cheap receipt or claim success accounting. Response bytes already delivered cannot be recalled, which is why funds were reserved first.

- [x] **Step 8: Add the owning adversarial matrix**. Each admission refusal asserts upstreamCalls()===0, unchanged prior balances, type spend_budget_refusal and retryable false. Matrix: missing/corrupt/unsafe ledger, zero/insufficient funds, expired policy/epoch, frozen wallet, lock failure, unsupported request/model/max_tokens, attested missing policy, policy with missing attestation (must still gate), unknown/contradictory billing class, wrong provider/origin/final credential, final billing-beta/header mutation and policy hash mismatch. Test actual final native body contains no OpenAI extras. Unknown beta/region/premium flags fail after shaping, not merely on incoming JSON. Registered attestation must survive all real target normalization. Ordinary subscription lease/provider without either declaration succeeds unchanged and never imports node:sqlite.

Explicitly test requiresSpendBudget:false combined with billingClass:manual-api, plus unknown paid classifications; both are terminal refusals with zero upstream calls.

Use fake fetch counters and recorded init objects to prove redirects use redirect:error, every retry reserves a distinct UUID, insufficient retry funds stop all further egress, and no financial error falls back to another paid provider. Two concurrent handler requests with one 350n wallet produce exactly one upstream call. A child gateway worker killed after reporting that fake fetch was entered leaves a committed full hold on reopen and never replays; another killed after commit but before fake fetch retains the same full hold with zero sends. Extend spend-worker.mjs only in this serialized task with explicit `gateway-before-send`/`gateway-after-send` modes using the same harness-equivalent real handler; use IPC barriers, not timing sleeps.

Stream controls: complete sseFor one byte at a time settles/burns once; stream error, absent message_stop, malformed/partial usage, over-limit event and mid-UTF8 disconnect retain full liability. Instrument fake stream pull/cancel and AbortSignal to prove downstream cancellation stops upstream pulls and aborts, with no background receipt hunt. Oversized JSON stays bounded and uncertain. In verified-refund fixture mode a complete JSON/SSE receipt releases exactly 308n once; duplicate/conflicting receipt tests remain pinned by Task 2. Usage above configured bounds or reservation freezes next request with zero new calls. All tests clean children/streams/DB connections in finally.

- [x] **Step 9: Pin unsupported-runtime isolation (actual Node 20 baseline verification remains unperformed and explicitly reported)**. In a child process use the project's node module-mock facility to make lazy node:sqlite import fail, then assert a budgeted request is unsupported_runtime with zero calls while an ordinary subscription request succeeds. In the available Node >=20.18 baseline runtime, run the unbudgeted import/handler control without using SQLite; if that runtime is not installed, report the missing verification explicitly rather than installing it or claiming it passed. Parent's capability tester verifies the actual >=22.13 runtime independently; no engine bump or fallback dependency is permitted.

- [x] **Step 10: Write docs/SPEND-BUDGET.md**. Explain conditional guarantee, promotional-only exclusive allocation, one immutable funding epoch, conservative maximum formula, default reserve-and-burn, policy/epoch expiry, unsupported-runtime refusal, uncertainty/crash loss of available funds and frozen excess liability. Give synthetic policy JSON using the exact RawPolicy fields and clearly non-real Sonnet/Opus prices, never live provider config. Document direct node init/fund/status command forms with digest placeholders only and an explicit statement that init funds zero and the implementation task performs none of those operator actions. Describe private paths, backup/rollback/cloning prohibition, policy changes invalidating an epoch, no renewal/reset/refund command, missing policy/attestation defense, subscription exclusion, startup validation and response codes. Record that real billing-usage contract evidence and provider-enforced bounds remain parent prerequisites for enabling the relevant model/refund mode, not proved facts. Explain no administrative credential or live credit API is used. This task neither funds nor activates the live host; live host state was not inspected.

- [x] **Step 11: Tester runs focused integration and regression**: `node --experimental-test-module-mocks --test gateway/tests/spend-budget.test.mjs tests/manual-api-profile.test.mjs gateway/tests/manual-api.test.mjs`, then `npm test`. Expected: focused tests and entire suite pass with no external/provider requests and no skipped financial assertions. Record exact totals, runtime, duration, all dispatch-path audit locations and any unrelated baseline failures separately; diagnose/fix in-scope failures before completion. Do not stage, commit, deploy, restart or install.

## Review-fix pass (parent rulings on three Important findings)

These rulings change the current contract. The original Task 1–3 text above is kept as history wherever it differs.

- [x] **Finding 1, neutral receipt metadata.** The JSON, `message_start` and every cumulative `message_delta` usage block are checked against one closed neutral allowlist:
  - `service_tier`: missing, null or `standard`.
  - `inference_geo`: missing, null or `global`.
  - `speed`: missing, null or `standard`.
  - `server_tool_use`: missing, null or exactly zero web search and web fetch. `code_execution_requests` is rejected even at 0.
  - `output_tokens_details`: missing, null or a closed `{thinking_tokens}` no larger than the cumulative output. It is observability only and never charged.
  - `iterations`: missing, null or `[]`.

  Anything else is incomplete: UNCERTAIN, no refund. The four counters stay required, are never zero-filled, and may still be omitted from individual deltas. `content: []` is valid, and `model_context_window_exceeded` is a recognized stop. The returned model must exactly equal the wire model; alias normalization is unverified and not done. Canonical evidence and the ledger are unchanged. Owning tests are in `gateway/tests/spend-receipt.test.mjs` and the `neutral metadata`/`non-neutral` cases in `gateway/tests/spend-budget.test.mjs`.
- [x] **Finding 2, terminal refusals.** Every `spend_budget_refusal` sent before the head is HTTP 402 with `x-should-retry: false` and the native `{type:'error',error:{...}}` envelope; `retryable:false` is kept. After stream bytes, the owned SSE error is unchanged. Owning tests are the `real NodeHTTP` cases, which emulate the published default retry predicates of the AI SDK and the Anthropic SDK. No installed SDK was run.
- [x] **Finding 3, deterministic paid 4xx.** Status 400–499 other than 408/409/429 is terminal 402 `unsupported_request` after bounded collection, UNCERTAIN full hold and the existing `/failure`/attempt reporting. There is no second lease, fetch or reservation, and held funds are not released. Owning tests are `deterministic paid HTTP …` for 400/401/402/403/404/405/413/415/422. The `control: retryable paid HTTP …` cases cover 408/409/429/503.

## Completion and final independent review

- [x] Parent checked the spec against Task 1 pure envelopes/receipt limits, Task 2 schema/invariants/funding, and Task 3 final-send/broker/stream integration; source inspection and interface checks completed.
- [x] A fresh read-only independent reviewer (one reviewer, not a panel) reported findings; parent regraded them and retained final security/integration ownership.
- [x] Parent had a separate implementer fix three Important findings and tester rerun; five Minor findings were deferred at this historical checkpoint (later status: four fixed, one open; see the latest follow-up status below). No policy/price/funding risk was waived; unverified billing bounds keep live functionality unavailable.
- [x] Historical checkpoint: tester verification passed 219/219 focused and 2,403/2,403 full on Node v24.16.0. Parent confirmed no owned jobs remain and changes are unstaged/uncommitted. Actual Node 20 verification remains unverified; activation is out of scope.

Planning self-review: the three tasks cover the complete spec; all five Review Focus classes have named owning tests; shared fixture values and function signatures are defined once; no production implementation, live capability claim or billing-contract proof is supplied by this document. The unresolved items are external evidence checks retained by the parent, not a new user design decision.

## Latest follow-up status (2026-10-20)

This section supersedes the five-deferred-Minor status above. The 2,317 and 2,403 counts above are historical records of earlier checkpoints, not the current result.

- [x] Minor findings: four of five fixed. They cover a null-safe startup diagnostic with no admission widening; keeping the primary spend reason and cleanup reason (`cancel_failed`) while awaiting a cleanup or sync throw; requiring an own `manualApiTargets` entry before the manual auth exemption; and documenting that manual routing admission and request/token budgets are separate from the explicit dollar gate. A bounded independent follow-up review found no correctness blocker. Its one minor gap, missing sync-cancel coverage, was added and passes.
- [ ] History scaling remains open and unoptimized. At 10,000 settled attempts each operation takes about 2.4 s, which is an availability risk, not a spend bypass. See [the operator guide](file:///home/dev/opencode-broker/docs/SPEND-BUDGET.md). Optimizing it needs a separate design that preserves the invariants.
- [x] Fresh independent full `npm test`, run after the strengthened null test: **2,411/2,411**, 0 fail/cancel/skip/todo, exit 0, 43,583.444021 ms, Node v24.16.0. The focused `node --experimental-test-module-mocks --test gateway/tests/spend-budget.test.mjs tests/manual-api-profile.test.mjs` exited 0, but its aggregate count was not captured.
- [x] Static analysis ran over 261 added lines in 5 tracked files plus the full text of 17 untracked source/test candidates (22 distinct paths). It found 0 emoji and 0 trailing whitespace, no candidate was missing, and it exited 0.
- [x] Controlled stash replay regression proof. This is not the original author's TDD sequence, which cannot be recovered. Evidence: [regproof-red.log](file:///tmp/opencode/regproof-red.log), [nullproof-red.log](file:///tmp/opencode/nullproof-red.log) and [nullproof-green-final.log](file:///tmp/opencode/nullproof-green-final.log), which passed 8/8.
- [ ] Actual Node 20 execution, actual SDK execution, physical power loss and live activation have not been performed.
- No package, version, staging, commit, deploy, funding or host changes were made. The full record is in the [progress ledger](file:///tmp/opencode/api-spend-gate-progress.md).

## Release follow-through authorization (2026-10-20)

After the source-only verification checkpoint, the user explicitly authorized completing implementation, committing and deploying. That authorization supersedes the earlier no-staging/no-commit/no-deployment restrictions for this release phase only. The release is 1.26.0; installation and service restart do not activate paid routing or create funds. No provider billing assumption is waived, and no real allocation or billable test is authorized by this record. History scaling remains a documented limitation with all integrity checks retained. Release verification and actual deployment results must be reported separately, not preclaimed here.
