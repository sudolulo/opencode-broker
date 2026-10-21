# Manual API Spend Budget

> **Opt-in feature; installation does not activate or fund paid routing.** The operator must configure verified identity and pricing/billing bounds and explicitly record an exclusive promotional allocation before guarded dispatch can succeed. Initialization supplies zero funds. The invoice bound remains conditional on the guarantees below; the known history-scaling limitation is documented under [History growth and latency](#history-growth-and-latency).

## Scope and guarantees

The spend budget applies only to native Messages requests sent to a broker-attested manual API target or a provider with a `spendBudget` policy. It does not govern existing subscription routes.

There is no unconditional guarantee that a provider invoice will match local accounting. The bound depends on all of these conditions:

- The provider honors the documented price and token/input bounds.
- The promotional allocation is exclusive and actually available at the provider.
- Exactly one authoritative ledger is used; it is not rolled back or cloned.
- No direct-key caller, old binary, or operator bypass sends unaccounted requests.
- **Unverified activation gate:** whether the promotional credit allocation, and its provider-side expiry, actually applies to these requests when they are billed has not been verified. This document grants no operational authority to activate or fund the gate.

A local receipt is evidence observed by the broker, not an invoice or proof of the provider's counter.

## Funding and lifecycle

- The default budget is zero. Initialization creates no funds.
- Use exactly one immutable promotional funding epoch, confirmed externally.
- There is no assumed `$200/month`, auto-renewal, reset, top-up, or purchased-credit fallback.
- This integration uses no admin credential or live credit-balance API. Anthropic's [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) provides historical reports; no authoritative live promotional-credit balance endpoint has been verified.
- Local funding records money already available at the provider; it does not purchase or transfer funds.
- Expiry blocks new calls and does not release existing holds.
- Policy or credential-binding changes invalidate the existing wallet. There is no migration, reset, or refund command.
- Missing, corrupt, locked, or binding-mismatched state denies spending; it is never automatically created or repaired.

## Conservative reservation

Accounting uses integer `BigInt` nanoUSD. Available funds and ceilings are floored; positive sub-nano amounts are rejected. Charges are conservative.

For each request, reserve:

```text
maxInputTokens * max(inputRate, cacheReadRate, cacheWrite1hRate)
+ request.max_tokens * outputRate
```

The provider contract must bound aggregated billable input. `count_tokens` or character estimates are not currency-admission evidence.

Synthetic example: a model bound to 100 input tokens and 10 output tokens, with rates of 2, 1, 3, and 5 nanoUSD per token for input, cache-read, cache-write-1h, and output, reserves `100 * 3 + 10 * 5 = 350` nanoUSD—even for a tiny `hello` request.

Default settlement burns the full 350 nanoUSD reservation; any observed actual usage of 42 nanoUSD is recorded separately. A 308 nanoUSD refund is permitted only when `reconcileUsage` is explicitly enabled, the billing contract is confirmed, and the receipt is complete and verified. This intentionally underuses provider funds. Timeouts and crashes do not trigger refunds.

## History growth and latency

The ledger validates full schema/index integrity, historical accounting, and stored
receipts before and after each transaction action; it never automatically prunes or
resets history. Cost grows with history, and synchronous checks under the write lock can
delay workers or cause locked refusals. The operator must not use reduced integrity
checks, altered lock timeout, ledger deletion/rollback/cloning, automated rollover, or
new funding as a workaround. Performance changes require separate design preserving
tamper detection and accounting invariants.

Historical synthetic benchmark before the in-process ledger queue was added, with
every integrity check enabled. It characterizes history growth, not post-queue
concurrent throughput. Values are the lower median of 3 samples, in milliseconds:

| Initial settled attempts | Samples | Status | Reserve | Settle |
| --- | --- | --- | --- | --- |
| 0 | 3 | 7.25 | 9.24 | 8.99 |
| 100 | 3 | 39.54 | 39.80 | 37.62 |
| 1000 | 3 | 278.32 | 271.00 | 315.71 |
| 10000 | 3 | 2438.42 | 2409.45 | 2441.63 |

Measurement limits:

- Sequential, single process, warm tmpfs and page cache, settled history only. Each
  sample adds one attempt. The whole four-history run took 31,714 ms and exited 0.
- The 120-second budget covered the whole run. It was cooperative and checked between
  operations; it was not a per-operation limit and did not preempt anything.
- Ledgers were fresh and purely synthetic, seeded by batch SQL from a valid public-API
  settlement template with unique receipt hashes and an exact wallet balance. The public
  validator passed before the run, around every timed operation, and at the end.
- No provider, network or real money was involved. Contention, p99, an SLA and power
  loss were not measured.
- About 2.4 s per operation at 10,000 attempts is an availability risk, not a spend
  bypass. The source ledger and schema were not changed.

## Synthetic policy example

The following is the exact `spendBudget` object, not a complete gateway configuration. **All prices, model bounds, and counters here are SYNTHETIC, NOT production current prices or model policy. Do not use this example to enable live models.** Enabling model prices/bounds or refunds requires strong parent/operator evidence.

```json
{
  "ledgerPath": "/home/example/.local/share/opencode/spend/wallet.sqlite",
  "policyID": "synthetic-example-v1",
  "validUntil": "2026-10-21T12:00:00.000Z",
  "ceilingUSD": "0.000050000",
  "binding": {
    "providerID": "manual-anthropic-fixture",
    "origin": "https://api.anthropic.com",
    "credentialSHA256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "reconcileUsage": false,
  "models": {
    "claude-sonnet-4-5-20250929": {
      "maxInputTokens": 100,
      "maxOutputTokens": 10,
      "ratesNanoUSD": {"input":"2","cacheRead":"1","cacheWrite1h":"3","output":"5"}
    },
    "claude-opus-4-1-20250805": {
      "maxInputTokens": 200,
      "maxOutputTokens": 20,
      "ratesNanoUSD": {"input":"4","cacheRead":"2","cacheWrite1h":"6","output":"10"}
    }
  }
}
```

## Operator interface (examples only)

These commands are examples for an authorized operator, not instructions for an agent to run. None were performed for this documentation task.

```sh
node gateway/bin/opencode-broker-spend-budget init --policy /absolute/path/synthetic-policy.json
node gateway/bin/opencode-broker-spend-budget status --policy /absolute/path/synthetic-policy.json
node gateway/bin/opencode-broker-spend-budget fund --policy /absolute/path/synthetic-policy.json --amount-usd 0.000000350 --reference synthetic-exclusive-grant-1 --confirmed-at 2026-10-20T11:00:00.000Z --expires-at 2026-10-21T11:00:00.000Z --provider-id manual-anthropic-fixture --origin https://api.anthropic.com --credential-sha256 '0000000000000000000000000000000000000000000000000000000000000000' --confirm-exclusive-promotional-allocation
```

The example is a synthetic temporary fixture only. Replace the placeholder with the authorized real allocation digest only when separately authorized; real funding requires separate authority and account verification. Never pass a raw key on a CLI or store secrets or keys in policy. No live-host directory, permissions, or credential commands are part of this work.

## Durable request accounting

- Every HTTP attempt gets a fresh UUID and a durable `DISPATCH_COMMITTED` record before fetch.
- Errors, disconnects, and partial receipts retain the full hold as `UNCERTAIN`. A process crash or failed uncertainty write can leave `DISPATCH_COMMITTED`; that durable hold still reduces available funds and is never automatically refunded or replayed.
- A UUID is never replayed. Duplicate settlement is idempotent; conflicts deny further spending.
- `SETTLED` burns the reservation by default. A verified, eligible refund is the only exception.
- If observed usage exceeds a bound, freeze new egress and preserve the exact TEXT addition as additional liability; never clamp it.
- Track funded, available, held, spent, observed cost, and additional liability separately.
- Zero additional liability while a request is unknown is not proof of zero actual provider charge.

## Broker admission and request envelope

The trusted registered manual target must declare `requiresSpendBudget: true` and `billingClass: "manual-api"`; `provider.spendBudget` is a policy object, not a boolean. Either a trusted paid attestation or an explicit provider policy independently requires a matching policy. Missing both is not safe against old binaries. False/manual contradictions or unknown classes fail closed. A financial refusal sent before the response head returns **HTTP 402** with header `x-should-retry: false` and the native Anthropic error envelope `{"type":"error","error":{"type":"spend_budget_refusal","code":...,"message":...,"retryable":false}}`. It is terminal, with no fallback. Deliberately removing both declarations or using an old binary is outside this guarantee.

Startup normalizes policy and checks provider/origin binding without opening the wallet. The gateway has no broker-inventory discovery contract: startup explicitly reports registration validation as deferred, not verified. Admission always checks the trusted fields from both `/lease` and `/lease/verify`; legacy leases are still guarded by an explicit provider policy. Invalid/null policy properties are never ignored. Key/config failures on a paid route are terminal, not a reason to try another lane. Only credential fingerprints, never raw keys or request bodies, are stored in the ledger or financial errors.

The request envelope is limited to `POST https://api.anthropic.com/v1/messages`, version `2023-06-01`, `standard_only` tier, and bounded recognized `cache_control`. An absent tier is pinned; an explicit different/premium tier is refused, not silently downgraded. Beta, fast (including fast aliases), region, server tools, container, MCP, and adaptive-thinking features are excluded. Chat, Responses, embeddings and probes cannot use the guarded paid lane. Redirects are errors. After all shaping and header normalization, the gateway binds the exact final body/headers and actual effective key hash, awaits durable reservation, and sends that immutable snapshot. Retries require new UUIDs and full reservations; a financial refusal stops fallback.

Request-level enabled thinking does not admit `thinking` or `redacted_thinking` content blocks in conversation history. Clients that need to echo those blocks in a multi-turn or tool flow cannot use that flow through this gate. Unsupported history is refused before reservation; it is not stripped or rewritten.

Direct global Anthropic cannot verify the proxy's private `x-fleet-health-*` context. The paid path never invokes `healthReporter.begin` or generates private fleet/session headers. Requests requiring health attestation, outage-health or fast scope are refused before egress. Explicit unsupported provider/incoming controls are refused rather than stripped to make the guard pass. Ordinary subscription/proxy health remains unchanged.

SSE accounting observation is bounded to 65,536 bytes per event, without an extra or unbounded tee. A single reader forwards bytes while awaiting downstream backpressure; invalid/oversized events make accounting permanently uncertain but do not buffer the full stream. Usage is cumulative, not summed; cache counters require explicit numeric values, with no zero assumption. EOF must be complete, including trailing bytes after message_stop. Uncertain streams are never refunded.

### Receipt usage metadata

Documented Messages usage metadata changes price: priority or batch tier, US-only `inference_geo` (1.1x), fast `speed`, and server-tool charges. The gateway therefore never ignores it wholesale. The JSON message, `message_start` and **every** cumulative `message_delta` usage block are validated against one closed allowlist. Earlier code ignored unknown `message_delta` usage keys; that is now fixed.

| Key | Accepted only as |
| --- | --- |
| `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` | required nonnegative safe integers in JSON and `message_start`; deltas may omit one, but a present counter must not regress. Missing or null is never zero-filled. |
| `cache_creation` | `{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` summing to `cache_creation_input_tokens` |
| `service_tier` | missing, `null` or `"standard"` |
| `inference_geo` | missing, `null` or `"global"` |
| `speed` | missing, `null` or `"standard"` |
| `server_tool_use` | missing, `null` or exactly `{web_search_requests: 0, web_fetch_requests: 0}` |
| `output_tokens_details` | missing, `null` or exactly `{thinking_tokens}`, where the value is `null` or a safe integer no larger than the (cumulative) `output_tokens` |
| `iterations` (beta) | missing, `null` or `[]` |

Each rule exists for a reason:

- **`code_execution_requests` is rejected even when it is 0.** Anthropic's pricing example shows it but the API reference does not, so its contract cannot be bounded.
- **A nonempty `iterations` list is rejected.** Billing only the final iteration would undercount.
- **Thinking tokens are observed, never charged twice.** `thinking_tokens` is included in `output_tokens`.
- **Anything else makes the receipt incomplete.** That includes a premium or non-global value, nonzero server-tool use, unknown keys or values, and malformed or negative counters. The attempt stays UNCERTAIN with its full hold and is never refunded.

Missing and null metadata are both treated as neutral because the schema does not distinguish them, and the guarded request already pins `standard_only` with no region, speed or server tools. Accepted metadata is validated and then dropped: canonical receipt evidence and the stored `receipt_json` keep only the four counters and the cache breakdown. An empty `content: []` is a valid completed response. `model_context_window_exceeded` is a recognized completed stop reason, and the input/output bounds still apply to it.

**The returned model must exactly equal the approved wire model ID.** Mapping a provider alias (for example an undated ID) to a dated ID has not been verified. The gateway does no prefix or date normalization, so an alias-shaped returned model makes settlement fail (`invalid_receipt`) and the hold stays UNCERTAIN. Policies must use the exact model IDs the provider echoes back.

Paid nonstream JSON, including unsuccessful HTTP responses, has a **hard 1,048,576-byte collection cap**. Overflow aborts generation and cancels the reader, retains the full hold as UNCERTAIN, and returns a terminal error without retry. Even legitimate larger paid JSON replies are refused: this deliberate availability tradeoff avoids unbounded buffering and further generation to hunt for a receipt. Subscription JSON behavior is unchanged.

Client cancellation aborts the actual fetch signal and cancels the single upstream reader; the gateway stops new pulls and performs no background receipt hunt. Transport cleanup, financial settlement and broker completion reporting are awaited by the real Node HTTP handler before it finishes. A storage error is an explicit terminal financial error, never successful accounting. After streaming bytes have been sent, HTTP 402 cannot replace the already-sent 200; a connected client instead receives a safe SSE `error` event with the same `retryable: false` payload, and local failure logging records the financial refusal. A local fetch abort or reader cancellation does not prove that the provider stopped generating. The full hold retained as UNCERTAIN covers any remote cost that continues within the reserved bounds.

### Why HTTP 402, and what it costs

Before this change, refusals used HTTP 503. Both default clients retry a 503: the Vercel AI SDK's `APICallError.isRetryable` retries 408, 409, 429 and every status >= 500, and the Anthropic TypeScript SDK does the same unless `x-should-retry` says otherwise. Each default client makes up to three tries, and **each retry is a new paid HTTP request** to the gateway. A refusal after dispatch (JSON overflow, malformed receipt or storage failure) could therefore become three paid sends. HTTP 402 is outside both retry predicates. `x-should-retry: false` is the Anthropic SDK's explicit override, and the top-level `type: "error"` keeps the AI SDK's Anthropic error schema parsing the body. Costs of this change:

- **Clients see a different status.** A client that branched on 503 sees 402 for every financial refusal, including pre-dispatch refusals such as `missing_ledger` or `insufficient_funds`.
- **The status cannot change once streaming starts.** After the first streamed byte the head is already 200, so the SSE error event is the only signal.
- **Clients can opt back into retries.** A client that explicitly enables stream retries, or that ignores both signals, can still retry. That is outside the gateway's control, but every new HTTP request still passes its own independent admission and full reservation, so a retry can never spend unreserved money.

These predicates were checked against the published source of both SDKs. The tests emulate them over a real Node HTTP server. No installed SDK was run.

### Deterministic paid 4xx

A guarded upstream response of 400–499, other than 408, 409 or 429, is not retried. The identical prepared request would be refused again. On a profile-mapped route `excludeLane` is a no-op, so the inherited second attempt would only be a second paid send. The bounded body is still collected, the full hold is kept as UNCERTAIN, and the existing `/failure` report and attempt log are still written. The gateway then returns a terminal 402 `unsupported_request`, with no new lease, fetch or reservation. **Cost:** the hold is never released. Whether the provider charges for a 4xx is unverified, so that money stays unavailable. Responses of 408, 409, 429 and 5xx, and fetch failures, keep the existing behaviour: a fresh UUID and a full new reservation when funds allow, and a halt before egress when they do not.

### Dispatch-path audit

The four API descriptors in [the gateway source](file:///home/dev/opencode-broker/gateway/lib/gateway.js) converge in `completions` → `completionsFor`. There is one actual upstream `fetchImpl` site. Normal leases, verified session leases and outage-bound leases all pass the policy/classification check before credential resolution. Policy alone protects the outage path even when it bypasses normal `/lease` construction. Guarded unsupported APIs/probes/health scopes are refused before that site.

The existing two-attempt loop encloses final preparation and reservation, so HTTP/fetch retries cannot reuse a UUID or an earlier hold. Only 408, 409, 429, 5xx and fetch failures reach the second attempt on a paid lane; any other paid 4xx is terminal (see above). Financial errors return directly, never entering capacity failure/backoff/fallback. Only after reservation succeeds does the single fetch use prepared bytes/headers and `redirect: 'error'`. Guarded bodies are consumed by [the bounded transport helper](file:///home/dev/opencode-broker/gateway/lib/spend-transport.js); ordinary JSON/SSE and nonfinancial estimated usage retain their existing paths. The helper has no fetch, lease, policy bypass or independent production handler.

## Runtime and storage requirements

Ordinary runtime remains Node `>=20.18`. Budget support requires Node `>=22.13` and a working `node:sqlite` `DatabaseSync` with `BigInt`, WAL, `FULL` synchronous durability, foreign keys, and a 1000 ms busy timeout. Host tests use Node 24.16; no actual Node 20 import test has been performed, so none is claimed. The gateway imports SQLite lazily only for budget operations. Unsupported runtimes fail closed; there is no dependency fallback.

The existing parent directory must be private, UID-owned, and mode `0700`. Database, WAL, and SHM files must be regular files, same-UID-owned, and mode `0600` or stricter. Reject symlink paths and unsafe ancestors; root-owned sticky `/tmp` is allowed. Do not automatically chmod. Backups must never restore or clone a funded wallet for reuse. SQLite protects concurrency, not rollback or cloning.
