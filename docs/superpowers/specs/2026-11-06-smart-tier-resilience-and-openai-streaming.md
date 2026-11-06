# Smart-tier resilience + OpenAI streaming (2026-11-06)

## Problem
Main (`smart`) sessions default to tier `smart` → cloud (claude-opus-5-5 + gpt-6-1-sol), not the
saturated local qwen. But gpt-6-1-sol rides the OpenAI **Codex/Responses impersonation path** (via
llm-auth-proxy), which is fragile: HTTP 400s (content/shape), `status:"failed"` envelopes, and
multi-minute stalls. When it failed, the gateway did **not** fail over to the healthy claude — it
502'd, and sessions fell back to the saturated qwen worker lane. That fallback (not permissions, not
the goal machinery) was why pi/smart sessions lagged Claude Code on the same models.

## What shipped
1. **Config (fleet-core `config/opencode-broker/config.json`).** `tiers.smart` = `[claude-opus-5-5,
   gpt-6-1-sol]` (claude is the reliable co-primary). **Logical fallbacks**: every cloud tier degrades
   by PROVIDER then to LOCAL — rung 1 a non-primary openai sibling (gpt-6-sol / gpt-terra; openai has
   no reserve mechanism so its depth lives in the fallback, and it also covers a merely rate-limited
   anthropic primary cross-provider), rung 2 the local backstop (local-27b / local-coder) for when
   BOTH clouds are out. Anthropic depth stays automatic via `modelOutages` reserves (forbidden from
   ordinary membership). Fixed: worker→flagship fallback, review's gpt-terra listed as both primary
   and fallback, and the missing both-clouds-out local rung.

2. **Cross-provider failover on a provider-backend fault.** A `status:"failed"` (or malformed)
   Responses envelope is a PROVIDER fault, not a model/request fault — all openai models share the
   Codex backend. Chain:
   - **Proxy** (`llm-auth-proxy` @ `56380ed`): `responses-backend.ts` extracts the envelope's real
     `value.error.{code,message}` (was discarded into a reasonless 502) and surfaces it via the
     adapters' 502.
   - **Gateway** (`gateway/lib/gateway.js`): a new `UPSTREAM_SIGNALS` entry maps "OpenAI Responses
     backend reported/returned…" → phrase `"upstream responses-backend failed"`.
   - **Broker** (`lib/routing.js` `classifyRoutingFailure`): that phrase → `connect` (provider-wide
     60s fence, no health evidence) → next lease avoids all of openai and reaches claude, instead of
     re-leasing gpt-terra on the same dead backend. Reuses the proven `connect` mechanism; distinct
     phrase keeps a backend fault legible from a dead socket in the journal.
   `content_filter` refusals are NOT this path — they come back 2xx and are handled by the existing
   reply content-filter cascade.

3. **OpenAI Messages streaming buffered (`5215d55`).** The gateway was sending `stream:true` to
   openai's buffered-only Messages endpoint → 400 "stream must be false" → 502 on every openai
   `/v1/messages` streaming turn. Restored the per-lane `bufferStreamingMessagesUpstream` clause (+ the
   `!spendPolicy` paid-request guard). Deliberately did NOT also buffer Anthropic Messages, so claude
   keeps its native incremental stream. Verified 10/10 streaming on :8792 then live :8790.

## Deferred: mid-stream commit threshold
The failover boundary (`gateway/lib/gateway.js`, the `relayed` flag): once a frame is relayed the
response head commits and the turn can no longer fail over. So a non-buffered stream that dribbles a
frame then stalls commits and 502s instead of failing over. **Deferred on purpose**: the live agent
path (`/v1/messages` → openai) now BUFFERS, so it fails pre-commit and already fails over; the commit
boundary only affects non-buffered streaming (direct chat/responses-API clients), which is edge-case
and the highest-risk hot-path change. When it's worth building: hold `relayed=true` until ≥N frames
OR ≥T ms of real content, so an early stall still fails over. Tests to model near
`gateway/tests/gateway.test.mjs:899` (fails-over-before-first-frame) and `:922` (committed, no retry).

## Deploy discipline (incident note)
`~/obk-merge` is a pinned-deploy worktree: the systemd drop-ins pin a reviewed DETACHED commit and
mandate an :8792 smoke-test before flipping — "committing main does not deploy it". An earlier
`git merge --ff-only … && restart` prematurely flipped it onto unreviewed main and caused the
streaming break above. Deploy by pinning a reviewed commit and smoke-testing on :8792 first; never
`ff main + restart`. Rollback: the `broker-rollback-841d051` archive, or
`bash ~/cutover-observe.sh --rollback <state>`.
