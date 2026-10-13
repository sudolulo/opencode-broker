# Model outages

Model outage reserves are disabled by default. An operator must explicitly enable the
`modelOutages` policy; absence or disablement preserves ordinary routing behavior. The
policy maps a canonical newest head to older reserve models. Older mappings are eligible
only during a verified, model-specific outage of that head, never as normal fallback.

## Authority and scope

The broker may route to a reserve only after its verified outage rules authorize it. The
reserve must retain the same actual credential instance, provider, authentication mode,
product, transport, and speed scope as the affected head. A route retains the primary
preference and all existing security, capacity, budget, and ordinary-routing fences.
Policy membership is not evidence of actual credential identity.

Diagnosis requires an actual failed head plus either at least three qualifying failures
from two distinct actual requests within 60 seconds, or a fresh applicable model-specific
status notice. A same-scope reserve must still pass verification before it is eligible.
Status notices alone never authorize a reserve.

## Bounded verification

Status is polled every 60 seconds. Proof freshness is 120 seconds. Episodes have a fixed
10-minute provisional lifetime and at most four probes (two reserve and two primary),
spaced by at least 60 seconds. At most one provider-wide probe may be in flight, with a
10-second wall deadline. Reservations are persisted before dispatch and survive restart;
a failed durable reservation permits no probe dispatch. Exhaustion or uncertainty fails
closed to unknown rather than granting more attempts.

Claude Messages probes enforce `max_tokens: 256` total, including reasoning, where the
selected model's supported request schema permits it. Do not force disabled thinking on
models that reject it. OpenAI Responses has no guaranteed output-token cap under this
contract. Do not infer exact probe cost or claim a universal output cap.

Fast Claude scope is bound using the existing broker alias/base-wire mapping. Before
hashing and signing, the final request body must contain `speed: "fast"` and the outbound
anthropic-beta header must include `fast-mode-2026-02-01`. A fast-scope begin request must
assert `speed: "fast"`; the field remains optional for standard scope. Fast success
additionally requires actual response `usage.speed: "fast"`; missing, standard, invalid,
or conflicting evidence cannot prove fast. Keep the broker model ID and preferred alias;
only normalize a known matching `-fast`/`-standard` wire suffix.

## Health evidence and state

Only an authenticated, attestation-verified health report with a valid terminal result can
establish health. HTTP 200 alone, and `/complete`, are not health proof. Synthetic health traffic does not settle
ordinary leases or trigger ordinary synthetic alerts; existing real alerts remain intact.
Outage state contains no raw secrets, prompts, or PII. Disable/rollback prevents new
grants but preserves episode history, counters, deadlines, and suppression history.

The gateway assigns one internal request ID per actual HTTP request. Upstream retries retain that request ID but receive distinct attempt IDs; redelivery of one health report retains both IDs. One outage lease issues one health capability, while a real lease may span multiple turns. Callers cannot choose the internal IDs. Raw health capabilities and credentials must not be logged.

## Runtime contract and deployment boundary

The following is the current required runtime interface and product contract when the
feature is enabled; it does not claim implementation or live-environment verification:

- `OPENCODE_BROKER_OUTAGE_GATEWAY_URL` must explicitly name the gateway origin. Do not
  infer a live port or network topology.
- `OPENCODE_BROKER_GATEWAY_KEY_FILE` uses the existing `gateway-key` fallback.
- Broker: `OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE` is required for the private
  gateway credential. `OPENCODE_BROKER_HEALTH_KEY_FILE` overrides the health-key path;
  otherwise the broker uses `routingStateDir()/model-health.key`.
- Gateway: health is enabled only when both `OPENCODE_BROKER_HEALTH_KEY_FILE` and
  `OPENCODE_BROKER_HEALTH_GATEWAY_CREDENTIAL_FILE` are set. It has no health-key default
  and refuses to start when only one of the pair is configured.

The enabled guard precedes all new key reads, timers, and network activity. Enabled
missing dependencies must fail startup clearly; disabled mode performs no feature I/O.
Keys are drop files, not JSON secrets; this guide neither creates nor reads them. The
gateway environment pair must match the broker. The proxy uses the same private key path
as `LLM_AUTH_PROXY_HEALTH_KEY_FILE`, only after separate deployment approval. No commands
in this guide activate, restart, rekey, or induce a live outage.

## Verification and readiness

Offline verification commands, from the broker repository root:

```sh
npm test
node --experimental-strip-types --test tests/model-outage-e2e.integration.mjs
```

The integration test imports the real proxy's TypeScript sources from a sibling checkout:
`tests/helpers/outage-e2e.mjs` resolves `../../../projects/llm-auth-proxy`, so the directory
containing the broker checkout must also contain `projects/llm-auth-proxy`. It is deliberately not
part of `npm test`. For cross-repository verification, the proxy suite uses `npm test` and
`npm run typecheck`.
Unit tests and the full-path offline integration test are distinct evidence; neither proves
production readiness. Node versions without TypeScript stripping support are a reported
block, not a reason to claim integration coverage.

Current readiness is **NO-GO** until all five logical-scope rows have actual offline
full-path proof and a separately authorized runtime enumeration, key UID/readability
proof, and passive attestation of legitimate current-head traffic. Do not manufacture
readiness booleans, deliberately call providers, or treat absent traffic as proof. Runtime
enumeration and key checks require separate approval. Keep counts and history when
disabling; rollback must not delete them.
