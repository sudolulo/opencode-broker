import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as continuationModule from '../lib/api-continuation.js';
import {
  continuationAuthorityCurrent,
  continuationRecordPermanentlyInvalid,
  continuationSessionEligible,
  DISABLED_API_CONTINUATION,
  durableOpenCodeSessionID,
  extractSubscriptionQuota,
  mintSpendGrant,
  normalizeApiContinuation,
  normalizeApiContinuationRecords,
  normalizeSubscriptionQuota,
  sourceTargetEligible,
  subscriptionQuotaFailureContradicted,
} from '../lib/api-continuation.js';
import { normalizeApiSpendGrant } from '../lib/api-spend-grant.js';
import { providerAuthRevision } from '../lib/routing.js';

// Synthetic fixtures only: no real provider, credential, price or ledger is involved.
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const NOW_S = NOW / 1000;
const HOUR = 3_600_000;
const TIERS = Object.freeze(['worker', 'review', 'build', 'fast-build', 'smart', 'deep', 'classifier', 'embedding']);
const PIN_A = 'a'.repeat(64);
const PIN_B = 'b'.repeat(64);
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The exact normalized shape lib/manual-api.js returns: {id: {providerID, modelID, profiles}}.
const manualFixture = (overrides = {}) => Object.freeze({
  'api-sonnet': Object.freeze({ providerID: 'anthropic-api', modelID: 'claude-sonnet-x', profiles: Object.freeze(['api-reserve']) }),
  'api-opus': Object.freeze({ providerID: 'anthropic-api', modelID: 'claude-opus-x', profiles: Object.freeze(['api-reserve']) }),
  ...overrides,
});
const MANUAL = manualFixture();
const CTX = Object.freeze({ manualApiTargets: MANUAL, tierNames: TIERS });
const rawEnabled = () => ({
  enabled: true,
  sourceProviders: ['openai', 'anthropic'],
  targets: { 'api-sonnet': ['smart', 'build'] },
  spendPolicyHashes: { 'api-sonnet': PIN_A },
  grantTTLms: 120000,
});

const deepFrozen = (value) => {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(deepFrozen);
};

// ---- 1. policy normalization ----------------------------------------------------------

test('absent block is the disabled default policy with exact canonical keys', () => {
  const policy = normalizeApiContinuation(undefined, CTX);
  assert.deepEqual(Object.keys(policy), ['enabled', 'sourceProviders', 'targets', 'spendPolicyHashes', 'grantTTLms', 'revision']);
  assert.equal(policy.enabled, false);
  assert.deepEqual(policy.sourceProviders, []);
  assert.deepEqual(policy.targets, {});
  assert.deepEqual(policy.spendPolicyHashes, {});
  assert.equal(policy.grantTTLms, 300000);
  assert.match(policy.revision, HEX);
  assert.ok(deepFrozen(policy));
  assert.deepEqual(DISABLED_API_CONTINUATION, normalizeApiContinuation(undefined));
  assert.ok(deepFrozen(DISABLED_API_CONTINUATION));
});

test('enabled block normalizes canonically and deeply frozen', () => {
  const policy = normalizeApiContinuation(rawEnabled(), CTX);
  assert.deepEqual(Object.keys(policy), ['enabled', 'sourceProviders', 'targets', 'spendPolicyHashes', 'grantTTLms', 'revision']);
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.sourceProviders, ['anthropic', 'openai']);
  assert.deepEqual(policy.targets, { 'api-sonnet': ['build', 'smart'] });
  assert.deepEqual(policy.spendPolicyHashes, { 'api-sonnet': PIN_A });
  assert.equal(policy.grantTTLms, 120000);
  assert.match(policy.revision, HEX);
  assert.ok(deepFrozen(policy));
});

test('source providers are an explicit allowlist, not trustedSubscriptionProviders membership', () => {
  // No trusted list is consulted: a provider no other config names is still a valid source.
  const policy = normalizeApiContinuation({ ...rawEnabled(), sourceProviders: ['some-oauth-provider'] },
    { ...CTX, trustedSubscriptionProviders: [] });
  assert.deepEqual(policy.sourceProviders, ['some-oauth-provider']);
});

test('revision is invariant to ordering and changes with every routing input', () => {
  const base = normalizeApiContinuation(rawEnabled(), CTX).revision;
  const reordered = normalizeApiContinuation({
    grantTTLms: 120000,
    spendPolicyHashes: { 'api-sonnet': PIN_A },
    targets: { 'api-sonnet': ['build', 'smart'] },
    sourceProviders: ['anthropic', 'openai'],
    enabled: true,
  }, CTX).revision;
  assert.equal(reordered, base);
  const variants = {
    disabled: [{ ...rawEnabled(), enabled: false }, CTX],
    sources: [{ ...rawEnabled(), sourceProviders: ['anthropic'] }, CTX],
    tiers: [{ ...rawEnabled(), targets: { 'api-sonnet': ['smart'] } }, CTX],
    targetPin: [{ ...rawEnabled(), spendPolicyHashes: { 'api-sonnet': PIN_B } }, CTX],
    extraPin: [{ ...rawEnabled(), spendPolicyHashes: { 'api-sonnet': PIN_A, 'api-opus': PIN_B } }, CTX],
    ttl: [{ ...rawEnabled(), grantTTLms: 120001 }, CTX],
    targetModelIdentity: [rawEnabled(), { ...CTX, manualApiTargets: manualFixture({
      'api-sonnet': Object.freeze({ providerID: 'anthropic-api', modelID: 'claude-sonnet-y', profiles: Object.freeze(['api-reserve']) }) }) }],
    targetProviderIdentity: [rawEnabled(), { ...CTX, manualApiTargets: manualFixture({
      'api-sonnet': Object.freeze({ providerID: 'anthropic-api-2', modelID: 'claude-sonnet-x', profiles: Object.freeze(['api-reserve']) }) }) }],
  };
  const seen = new Set([base]);
  for (const [name, [raw, context]] of Object.entries(variants)) {
    const revision = normalizeApiContinuation(raw, context).revision;
    assert.notEqual(revision, base, name);
    assert.ok(!seen.has(revision), `${name} collides with another variant`);
    seen.add(revision);
  }
  // Identity of a pin-only (non-continuation) target also binds the revision.
  const pinOnly = { ...rawEnabled(), spendPolicyHashes: { 'api-sonnet': PIN_A, 'api-opus': PIN_B } };
  const before = normalizeApiContinuation(pinOnly, CTX).revision;
  const after = normalizeApiContinuation(pinOnly, { ...CTX, manualApiTargets: manualFixture({
    'api-opus': Object.freeze({ providerID: 'anthropic-api', modelID: 'claude-opus-z', profiles: Object.freeze(['api-reserve']) }) }) }).revision;
  assert.notEqual(after, before);
});

test('malformed block shapes, unknown keys and non-boolean enabled are rejected', () => {
  for (const raw of [null, [], 'enabled', 1, true]) {
    assert.throws(() => normalizeApiContinuation(raw, CTX), /apiContinuation/, JSON.stringify(raw));
  }
  assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), quotaEvidence: true }, CTX), /apiContinuation/);
  assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), trustedSubscriptionProviders: [] }, CTX), /apiContinuation/);
  for (const enabled of ['true', 1, 0, null]) {
    assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), enabled }, CTX), /apiContinuation/, String(enabled));
  }
});

test('grantTTLms must be an integer from 1 through 300000', () => {
  for (const grantTTLms of [0, -1, 300001, 1.5, '1000', Number.NaN, Infinity, null]) {
    assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), grantTTLms }, CTX), /apiContinuation/, String(grantTTLms));
  }
  assert.equal(normalizeApiContinuation({ ...rawEnabled(), grantTTLms: 1 }, CTX).grantTTLms, 1);
  assert.equal(normalizeApiContinuation({ ...rawEnabled(), grantTTLms: 300000 }, CTX).grantTTLms, 300000);
  const { grantTTLms, ...noTTL } = rawEnabled();
  assert.equal(normalizeApiContinuation(noTTL, CTX).grantTTLms, 300000);
});

test('source providers must be explicit, unique, bounded identifiers and never paid providers', () => {
  const { sourceProviders, ...noSources } = rawEnabled();
  assert.throws(() => normalizeApiContinuation(noSources, CTX), /sourceProviders/);
  const bad = [[], ['anthropic', 'anthropic'], [''], ['anth\nropic'], ['x'.repeat(200)], 'anthropic', [7], ['has space'], ['anthropic-api']];
  for (const value of bad) {
    assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), sourceProviders: value }, CTX), /sourceProviders/, JSON.stringify(value));
  }
  // A registered paid provider is refused even while disabled.
  assert.throws(() => normalizeApiContinuation({ enabled: false, sourceProviders: ['anthropic-api'] }, CTX), /sourceProviders/);
  assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), sourceProviders: Array.from({ length: 33 }, (_, i) => `p${i}`) }, CTX), /sourceProviders/);
});

test('targets must be registered manual targets with nonempty unique generation-tier arrays', () => {
  const cases = {
    unregistered: { 'oauth-sonnet': ['smart'] },
    empty: { 'api-sonnet': [] },
    duplicate: { 'api-sonnet': ['smart', 'smart'] },
    unknownTier: { 'api-sonnet': ['ultra'] },
    classifier: { 'api-sonnet': ['classifier'] },
    embedding: { 'api-sonnet': ['embedding'] },
    notArray: { 'api-sonnet': 'smart' },
    notObject: ['api-sonnet'],
  };
  for (const [name, targets] of Object.entries(cases)) {
    assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), targets }, CTX), /targets/, name);
  }
  // Without a supplied tier vocabulary nothing is a valid tier: fail closed.
  assert.throws(() => normalizeApiContinuation(rawEnabled(), { manualApiTargets: MANUAL }), /targets/);
  // Without a manual registry nothing is a registered target.
  assert.throws(() => normalizeApiContinuation(rawEnabled(), { tierNames: TIERS }), /apiContinuation/);
});

test('every enabled continuation target needs a 64-lowercase-hex financial pin', () => {
  assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), spendPolicyHashes: {} }, CTX), /spendPolicyHashes/);
  const { spendPolicyHashes, ...noPins } = rawEnabled();
  assert.throws(() => normalizeApiContinuation(noPins, CTX), /spendPolicyHashes/);
  for (const pin of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 7, null]) {
    assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), spendPolicyHashes: { 'api-sonnet': pin } }, CTX), /spendPolicyHashes/, String(pin));
  }
  assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), spendPolicyHashes: { 'api-sonnet': PIN_A, 'oauth-sonnet': PIN_B } }, CTX), /spendPolicyHashes/);
  assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), spendPolicyHashes: [PIN_A] }, CTX), /spendPolicyHashes/);
});

test('a manual target pin is accepted while disabled and with no continuation targets', () => {
  const policy = normalizeApiContinuation({ enabled: false, spendPolicyHashes: { 'api-opus': PIN_B } }, CTX);
  assert.equal(policy.enabled, false);
  assert.deepEqual(policy.targets, {});
  assert.deepEqual(policy.spendPolicyHashes, { 'api-opus': PIN_B });
  const enabled = normalizeApiContinuation({ ...rawEnabled(), spendPolicyHashes: { 'api-sonnet': PIN_A, 'api-opus': PIN_B } }, CTX);
  assert.deepEqual(enabled.spendPolicyHashes, { 'api-opus': PIN_B, 'api-sonnet': PIN_A });
});

test('the error message never echoes a malformed pin value', () => {
  const marker = 'z'.repeat(64);
  assert.throws(() => normalizeApiContinuation({ ...rawEnabled(), spendPolicyHashes: { 'api-sonnet': marker } }, CTX),
    (error) => !error.message.includes(marker) && /spendPolicyHashes/.test(error.message));
});

// ---- 2. session eligibility ----------------------------------------------------------

test('only bounded native OpenCode ses_ identifiers are durable sessions', () => {
  for (const id of ['ses_abc123', 'ses_0AbZ', `ses_${'a'.repeat(124)}`]) assert.equal(durableOpenCodeSessionID(id), true, id);
  const bad = ['gw-lx2-abc', 'gw-probe-x', 'rig-1', 'ses_', 'ses_a-b', 'ses_ab\n', 'SES_abc', ' ses_abc', 'ses_ab_c',
    `ses_${'a'.repeat(125)}`, 'reserve-session', '', null, undefined, 7, {}];
  for (const id of bad) assert.equal(durableOpenCodeSessionID(id), false, String(id));
});

test('automatic continuation is restricted to durable, non-one-shot, non-embedding auto sessions', () => {
  const base = { sessionID: 'ses_abc123', profile: 'auto', oneShot: false, api: null };
  assert.equal(continuationSessionEligible(base), true);
  assert.equal(continuationSessionEligible({ sessionID: 'ses_abc123', profile: 'auto' }), true);
  for (const profile of ['manual', 'private', 'local', 'api-reserve', 'uncensored-offline', undefined]) {
    assert.equal(continuationSessionEligible({ ...base, profile }), false, String(profile));
  }
  for (const oneShot of [true, 'yes', 1]) assert.equal(continuationSessionEligible({ ...base, oneShot }), false, String(oneShot));
  assert.equal(continuationSessionEligible({ ...base, api: 'embeddings' }), false);
  assert.equal(continuationSessionEligible({ ...base, api: 'chat' }), false);
  for (const sessionID of ['gw-lx2-abc', 'gw-probe-x', 'rig-1']) assert.equal(continuationSessionEligible({ ...base, sessionID }), false, sessionID);
  assert.equal(continuationSessionEligible(undefined), false);
});

// ---- 3. subscription quota extraction ----------------------------------------------------

const anthropicHeaders = (overrides = {}) => {
  const values = {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(NOW_S + 3600),
    ...overrides,
  };
  return new Headers(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)));
};
const anthropicBody = (error = {}) => JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: "This request would exceed your account's rate limit. Please try again later.", ...error } });
const openaiBody = (error = {}) => JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: NOW_S + 600, ...error } });
const extract = (args) => extractSubscriptionQuota({ status: 429, now: NOW, headers: new Headers(), body: '', ...args });

test('Anthropic unified rejection with a known claim and future reset is positive and closed', () => {
  const quota = extract({ headers: anthropicHeaders(), body: anthropicBody() });
  assert.deepEqual(quota, { version: 1, kind: 'anthropic-unified', window: 'five_hour', resetAtMs: NOW + HOUR });
  assert.deepEqual(Object.keys(quota), ['version', 'kind', 'window', 'resetAtMs']);
  assert.ok(Object.isFrozen(quota));
  for (const claim of ['five_hour', 'seven_day']) {
    const result = extract({ headers: anthropicHeaders({ 'anthropic-ratelimit-unified-representative-claim': claim }), body: anthropicBody() });
    assert.equal(result?.window, claim, claim);
  }
});

// A model-scoped weekly claim exhausts ONE model family, not the provider; continuing on paid
// API while the provider's other models still serve is not proven exhaustion, so it refuses.
test('model-scoped Anthropic claims are never continuation proof', () => {
  for (const claim of ['seven_day_opus', 'seven_day_sonnet', 'seven_day_haiku', 'five_hour_opus']) {
    const result = extract({ headers: anthropicHeaders({ 'anthropic-ratelimit-unified-representative-claim': claim }), body: anthropicBody() });
    assert.equal(result, null, claim);
    assert.equal(normalizeSubscriptionQuota({ version: 1, kind: 'anthropic-unified', window: claim, resetAtMs: NOW + HOUR }, { now: NOW }), null, claim);
  }
});

test('Anthropic header facts alone carry the window without a body', () => {
  assert.deepEqual(extract({ headers: anthropicHeaders(), body: '' }), { version: 1, kind: 'anthropic-unified', window: 'five_hour', resetAtMs: NOW + HOUR });
  assert.deepEqual(extract({ headers: anthropicHeaders(), body: undefined }), { version: 1, kind: 'anthropic-unified', window: 'five_hour', resetAtMs: NOW + HOUR });
});

test('Anthropic negative, incomplete and contradictory signals are refused', () => {
  const cases = {
    status400: { status: 400, headers: anthropicHeaders() },
    status503: { status: 503, headers: anthropicHeaders() },
    statusString: { status: '429', headers: anthropicHeaders() },
    allowed: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-status': 'allowed' }) },
    allowedWarning: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-status': 'allowed_warning' }) },
    unknownClaim: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-representative-claim': 'overage' }) },
    missingClaim: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-representative-claim': undefined }) },
    missingReset: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-reset': undefined }) },
    pastReset: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-reset': String(NOW_S - 1) }) },
    nowReset: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-reset': String(NOW_S) }) },
    fractionalReset: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-reset': `${NOW_S + 3600}.5` }) },
    hugeReset: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-reset': '99999999999999' }) },
    textReset: { headers: anthropicHeaders({ 'anthropic-ratelimit-unified-reset': 'tomorrow' }) },
    retryAfterOnly: { headers: new Headers({ 'retry-after': '3600' }), body: anthropicBody() },
    billingType: { headers: anthropicHeaders(), body: anthropicBody({ type: 'billing_error' }) },
    authType: { headers: anthropicHeaders(), body: anthropicBody({ type: 'authentication_error' }) },
    overloaded: { headers: anthropicHeaders(), body: anthropicBody({ type: 'overloaded_error' }) },
    creditMessage: { headers: anthropicHeaders(), body: anthropicBody({ message: 'Your credit balance is too low to access the Anthropic API.' }) },
    fastMode: { headers: anthropicHeaders(), body: anthropicBody({ message: 'Fast mode requires extra usage credits.' }) },
    tpm: { headers: anthropicHeaders(), body: anthropicBody({ message: 'Number of input tokens per minute exceeds your rate limit.' }) },
    mixedKinds: { headers: anthropicHeaders(), body: openaiBody() },
    bodyResetConflict: { headers: anthropicHeaders(), body: anthropicBody({ resets_at: NOW_S + 7200 }) },
    malformedJSON: { headers: anthropicHeaders(), body: '{"type":"error"' },
    nonObjectJSON: { headers: anthropicHeaders(), body: '[1,2]' },
    oversized: { headers: anthropicHeaders(), body: anthropicBody({ message: 'x'.repeat(20000) }) },
    objectBody: { headers: anthropicHeaders(), body: { type: 'error' } },
    plainHeaders: { headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': String(NOW_S + 3600) } },
    badNow: { headers: anthropicHeaders(), now: Number.NaN },
    broadMessageOnly: { headers: new Headers(), body: anthropicBody({ message: 'Claude usage limit reached. Your limit will reset at 5pm.' }) },
  };
  for (const [name, args] of Object.entries(cases)) assert.equal(extract(args), null, name);
});

test('OpenAI exact usage_limit_reached with a future reset is positive and closed', () => {
  assert.deepEqual(extract({ body: openaiBody() }), { version: 1, kind: 'openai-usage-limit', window: 'usage_limit', resetAtMs: NOW + 600000 });
  assert.deepEqual(extract({ body: openaiBody({ type: undefined, code: 'usage_limit_reached' }) }),
    { version: 1, kind: 'openai-usage-limit', window: 'usage_limit', resetAtMs: NOW + 600000 });
  assert.deepEqual(extract({ body: openaiBody({ code: 'usage_limit_reached', resets_at: undefined, resets_in_seconds: 900 }) }),
    { version: 1, kind: 'openai-usage-limit', window: 'usage_limit', resetAtMs: NOW + 900000 });
  // Both reset forms present and consistent within whole-second rounding.
  const both = extract({ body: openaiBody({ resets_in_seconds: 601 }) });
  assert.equal(both?.resetAtMs, NOW + 600000);
  assert.ok(Object.isFrozen(both));
});

test('OpenAI billing, generic, conflicting and malformed reset signals are refused', () => {
  const cases = {
    insufficientQuota: { body: openaiBody({ type: 'insufficient_quota' }) },
    conflictingCode: { body: openaiBody({ code: 'insufficient_quota' }) },
    rateLimitCode: { body: openaiBody({ type: undefined, code: 'rate_limit_exceeded' }) },
    genericQuota: { body: JSON.stringify({ error: { message: 'You exceeded your current quota', resets_at: NOW_S + 600 } }) },
    noReset: { body: openaiBody({ resets_at: undefined }) },
    pastReset: { body: openaiBody({ resets_at: NOW_S - 10 }) },
    nonIntegerReset: { body: openaiBody({ resets_at: NOW_S + 600.5 }) },
    stringReset: { body: openaiBody({ resets_at: String(NOW_S + 600) }) },
    zeroIn: { body: openaiBody({ resets_at: undefined, resets_in_seconds: 0 }) },
    negativeIn: { body: openaiBody({ resets_at: undefined, resets_in_seconds: -5 }) },
    fractionalIn: { body: openaiBody({ resets_at: undefined, resets_in_seconds: 1.5 }) },
    stringIn: { body: openaiBody({ resets_at: undefined, resets_in_seconds: '600' }) },
    resetsDisagree: { body: openaiBody({ resets_in_seconds: 7200 }) },
    billingMessage: { body: openaiBody({ message: 'Billing hard limit has been reached' }) },
    planLapse: { body: openaiBody({ message: 'Your subscription has expired; renew your plan.' }) },
    retryAfterOnly: { headers: new Headers({ 'retry-after': '600' }), body: openaiBody({ resets_at: undefined }) },
    status403: { status: 403, body: openaiBody() },
    anthropicHeaderConflict: { headers: anthropicHeaders(), body: openaiBody() },
    nonStringType: { body: openaiBody({ type: ['usage_limit_reached'] }) },
  };
  for (const [name, args] of Object.entries(cases)) assert.equal(extract(args), null, name);
});

test('normalizeSubscriptionQuota accepts only the closed future wire shape', () => {
  const valid = { version: 1, kind: 'anthropic-unified', window: 'seven_day', resetAtMs: NOW + HOUR };
  const out = normalizeSubscriptionQuota(valid, { now: NOW });
  assert.deepEqual(out, valid);
  assert.ok(Object.isFrozen(out));
  assert.notEqual(out, valid);
  const bad = {
    extra: { ...valid, source: 'x' },
    missing: { version: 1, kind: 'anthropic-unified', window: 'seven_day' },
    version: { ...valid, version: 2 },
    kind: { ...valid, kind: 'anthropic' },
    anthropicUsageLimit: { ...valid, window: 'usage_limit' },
    openaiClaim: { ...valid, kind: 'openai-usage-limit', window: 'five_hour' },
    past: { ...valid, resetAtMs: NOW },
    float: { ...valid, resetAtMs: NOW + 0.5 },
    invalidDate: { ...valid, resetAtMs: 8.64e15 + 1 },
    string: { ...valid, resetAtMs: String(NOW + HOUR) },
    array: [valid],
    nullValue: null,
  };
  for (const [name, value] of Object.entries(bad)) assert.equal(normalizeSubscriptionQuota(value, { now: NOW }), null, name);
  assert.equal(normalizeSubscriptionQuota(valid, { now: Number.NaN }), null);
  assert.deepEqual(normalizeSubscriptionQuota({ version: 1, kind: 'openai-usage-limit', window: 'usage_limit', resetAtMs: NOW + 1 }, { now: NOW }),
    { version: 1, kind: 'openai-usage-limit', window: 'usage_limit', resetAtMs: NOW + 1 });
});

const DAY = 24 * HOUR;
const HORIZONS = Object.freeze({
  five_hour: ['anthropic-unified', 5 * HOUR],
  seven_day: ['anthropic-unified', 7 * DAY],
  usage_limit: ['openai-usage-limit', 31 * DAY],
});
const YEAR_2100_S = Date.parse('2100-01-01T00:00:00.000Z') / 1000;

test('normalizeSubscriptionQuota bounds each recognized window by a finite horizon, inclusive', () => {
  for (const [window, [kind, horizon]] of Object.entries(HORIZONS)) {
    const at = (resetAtMs) => normalizeSubscriptionQuota({ version: 1, kind, window, resetAtMs }, { now: NOW });
    assert.equal(at(NOW + horizon)?.resetAtMs, NOW + horizon, `${window} exact horizon`);
    assert.equal(at(NOW + horizon + 1), null, `${window} horizon + 1ms`);
    assert.equal(at(YEAR_2100_S * 1000), null, `${window} year 2100`);
    assert.equal(at(8.64e15), null, `${window} max date`);
    assert.equal(at(NOW - DAY), null, `${window} expired`);
  }
});

test('extraction applies the same horizons to Anthropic and OpenAI wire values', () => {
  const claim = (window, reset) => extract({ headers: anthropicHeaders({ 'anthropic-ratelimit-unified-representative-claim': window, 'anthropic-ratelimit-unified-reset': String(reset) }) });
  assert.equal(claim('five_hour', NOW_S + 5 * 3600)?.resetAtMs, NOW + 5 * HOUR);
  assert.equal(claim('five_hour', NOW_S + 5 * 3600 + 1), null);
  assert.equal(claim('five_hour', YEAR_2100_S), null);
  assert.equal(claim('seven_day', NOW_S + 7 * 86400)?.resetAtMs, NOW + 7 * DAY);
  assert.equal(claim('seven_day', NOW_S + 7 * 86400 + 1), null);
  for (const window of ['seven_day_opus', 'seven_day_sonnet']) assert.equal(claim(window, NOW_S + 3600), null, window);
  const openai = (error) => extract({ body: openaiBody(error) });
  assert.equal(openai({ resets_at: undefined, resets_in_seconds: 31 * 86400 })?.resetAtMs, NOW + 31 * DAY);
  assert.equal(openai({ resets_at: undefined, resets_in_seconds: 31 * 86400 + 1 }), null);
  assert.equal(openai({ resets_at: NOW_S + 31 * 86400 })?.resetAtMs, NOW + 31 * DAY);
  assert.equal(openai({ resets_at: NOW_S + 31 * 86400 + 1 }), null);
  assert.equal(openai({ resets_at: YEAR_2100_S }), null);
  assert.equal(openai({ resets_at: undefined, resets_in_seconds: 9_000_000_000 }), null);
  assert.equal(openai({ resets_at: Date.parse('2020-01-01T00:00:00.000Z') / 1000 }), null);
});

test('a persisted record whose closed evidence exceeds its horizon carries no authority', () => {
  const farReset = YEAR_2100_S * 1000;
  const far = validRecord({ circuitUntilMs: farReset, quotaEvidenceClosed: { version: 1, kind: 'anthropic-unified', window: 'five_hour', resetAtMs: farReset } });
  assert.deepEqual(normalizeApiContinuationRecords({ ses_far: far, ses_keep: validRecord() }, { now: NOW }), { ses_keep: validRecord() });
});

test('OpenAI path refuses any unified Anthropic header without the Anthropic status path', () => {
  const cases = {
    claimAndReset: new Headers({ 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': String(NOW_S + 3600) }),
    resetOnly: new Headers({ 'anthropic-ratelimit-unified-reset': String(NOW_S + 3600) }),
    claimOnly: new Headers({ 'anthropic-ratelimit-unified-representative-claim': 'seven_day' }),
    utilization: new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '1.0' }),
    upperCaseName: new Headers({ 'Anthropic-RateLimit-Unified-Fallback': 'available' }),
  };
  for (const [name, headers] of Object.entries(cases)) assert.equal(extract({ headers, body: openaiBody() }), null, name);
  // Unrelated rate-limit headers do not by themselves contradict the typed OpenAI signal.
  assert.equal(extract({ headers: new Headers({ 'x-ratelimit-remaining-requests': '0' }), body: openaiBody() })?.kind, 'openai-usage-limit');
});

test('OpenAI reset forms that agree within the conservative 5000ms budget yield the earlier hint', () => {
  const at = (now, resetsIn) => extractSubscriptionQuota({ status: 429, now, headers: new Headers(), body: openaiBody({ resets_at: NOW_S + 600, resets_in_seconds: resetsIn }) });
  // Absolute is 5000ms later than relative: exactly the budget, accepted, earliest (relative) wins.
  assert.equal(at(NOW, 595)?.resetAtMs, NOW + 595000);
  // Relative is 5000ms later than absolute: exactly the budget, accepted, earliest (absolute) wins.
  assert.equal(at(NOW, 605)?.resetAtMs, NOW + 600000);
  // Sub-second clock: the relative hint lands 400ms after the absolute; the absolute is earlier.
  assert.equal(at(NOW + 400, 600)?.resetAtMs, NOW + 600000);
  // 400ms before the whole second: relative lands earlier and wins.
  assert.equal(at(NOW - 400, 600)?.resetAtMs, NOW + 599600);
  // 5001ms disagreement either way is a contradiction and refuses.
  assert.equal(at(NOW - 1, 595), null);
  assert.equal(at(NOW + 1, 605), null);
  // Both forms must be future: an absolute at or before now refuses even within budget.
  const past = (resetsAt, resetsIn) => extract({ body: openaiBody({ resets_at: resetsAt, resets_in_seconds: resetsIn }) });
  assert.equal(past(NOW_S, 4), null);
  assert.equal(past(NOW_S - 1, 3), null);
  assert.equal(extractSubscriptionQuota({ status: 429, now: 1.5, headers: new Headers(), body: openaiBody() }), null);
});

test('every supplied OpenAI reset form must itself be within the horizon, not just the earliest', () => {
  // Relative is exactly the 31-day horizon; absolute is 1s beyond it (within the 5000ms budget).
  assert.equal(extract({ body: openaiBody({ resets_at: NOW_S + 31 * 86400 + 1, resets_in_seconds: 31 * 86400 }) }), null);
  assert.equal(extract({ body: openaiBody({ resets_at: NOW_S + 31 * 86400, resets_in_seconds: 31 * 86400 + 1 }) }), null);
  assert.equal(extract({ body: openaiBody({ resets_at: NOW_S + 31 * 86400, resets_in_seconds: 31 * 86400 }) })?.resetAtMs, NOW + 31 * DAY);
});

test('optional error.param and error.plan_type can only refuse, never create a signal', () => {
  assert.equal(extract({ body: openaiBody({ plan_type: 'plus' }) })?.kind, 'openai-usage-limit');
  assert.equal(extract({ body: openaiBody({ param: null, plan_type: null }) })?.kind, 'openai-usage-limit');
  const refused = {
    planTypeNumber: { body: openaiBody({ plan_type: 7 }) },
    planTypeObject: { body: openaiBody({ plan_type: { name: 'plus' } }) },
    paramArray: { body: openaiBody({ param: ['x'] }) },
    paramBool: { body: openaiBody({ param: false }) },
    planTypeExpired: { body: openaiBody({ plan_type: 'expired' }) },
    planTypeBilling: { body: openaiBody({ plan_type: 'billing_required' }) },
    paramCredit: { body: openaiBody({ param: 'credit_balance' }) },
    paramPerMinute: { body: openaiBody({ param: 'tokens_per_minute' }) },
    anthropicParamCredit: { headers: anthropicHeaders(), body: anthropicBody({ param: 'credit_balance' }) },
    anthropicPlanTypeNumber: { headers: anthropicHeaders(), body: anthropicBody({ plan_type: 3 }) },
  };
  for (const [name, args] of Object.entries(refused)) assert.equal(extract(args), null, name);
  // Neither field is a positive signal on its own, and neither is stored in the closed result.
  assert.equal(extract({ body: JSON.stringify({ error: { plan_type: 'plus', param: 'usage_limit_reached', resets_at: NOW_S + 600 } }) }), null);
  assert.deepEqual(Object.keys(extract({ body: openaiBody({ plan_type: 'plus', param: 'x' }) })), ['version', 'kind', 'window', 'resetAtMs']);
});

// The Codex CLI reads x-codex-rate-limit-reached-type next to a usage_limit_reached body. Only the
// rolling rate-limit outcome is a subscription window; credit and workspace outcomes are billing.
const CODEX_REACHED = 'x-codex-rate-limit-reached-type';
const OPENAI_POSITIVE = Object.freeze({ version: 1, kind: 'openai-usage-limit', window: 'usage_limit', resetAtMs: NOW + 600000 });

test('OpenAI positive without x-codex-rate-limit-reached-type stays positive (header absence allowed)', () => {
  assert.deepEqual(extract({ headers: new Headers(), body: openaiBody() }), OPENAI_POSITIVE);
  assert.deepEqual(extract({ headers: undefined, body: openaiBody() }), OPENAI_POSITIVE);
});

test('OpenAI positive with x-codex-rate-limit-reached-type exactly rate_limit_reached stays positive', () => {
  assert.deepEqual(extract({ headers: new Headers({ [CODEX_REACHED]: 'rate_limit_reached' }), body: openaiBody() }), OPENAI_POSITIVE);
  assert.deepEqual(extract({ headers: new Headers({ [CODEX_REACHED]: 'rate_limit_reached' }), body: openaiBody({ type: undefined, code: 'usage_limit_reached' }) }), OPENAI_POSITIVE);
});

test('x-codex-rate-limit-reached-type header name is matched case-insensitively via native Headers', () => {
  assert.deepEqual(extract({ headers: new Headers({ 'X-Codex-Rate-Limit-Reached-Type': 'rate_limit_reached' }), body: openaiBody() }), OPENAI_POSITIVE);
  assert.equal(extract({ headers: new Headers({ 'X-CODEX-RATE-LIMIT-REACHED-TYPE': 'credits_depleted' }), body: openaiBody() }), null);
});

test('x-codex-rate-limit-reached-type rate_limit_reached alone (no usage_limit_reached body, bad status or no future reset) has zero authority', () => {
  const headers = () => new Headers({ [CODEX_REACHED]: 'rate_limit_reached' });
  const cases = {
    headerOnlyEmptyBody: { headers: headers(), body: '' },
    headerOnlyUndefinedBody: { headers: headers(), body: undefined },
    headerWithGenericBody: { headers: headers(), body: JSON.stringify({ error: { message: 'limit', resets_at: NOW_S + 600 } }) },
    headerWithRateLimitCode: { headers: headers(), body: openaiBody({ type: undefined, code: 'rate_limit_exceeded' }) },
    headerWithStatus403: { status: 403, headers: headers(), body: openaiBody() },
    headerWithNoReset: { headers: headers(), body: openaiBody({ resets_at: undefined }) },
    headerWithPastReset: { headers: headers(), body: openaiBody({ resets_at: NOW_S - 10 }) },
    headerWithRetryAfterOnly: { headers: new Headers({ [CODEX_REACHED]: 'rate_limit_reached', 'retry-after': '600' }), body: '' },
  };
  for (const [name, args] of Object.entries(cases)) assert.equal(extract(args), null, name);
});

test('x-codex-rate-limit-reached-type credit, workspace, unknown, empty and comma-joined values refuse the OpenAI positive', () => {
  const refused = {
    credits_depleted: 'credits_depleted',
    workspace_owner_credits_depleted: 'workspace_owner_credits_depleted',
    workspace_member_credits_depleted: 'workspace_member_credits_depleted',
    workspace_owner_usage_limit_reached: 'workspace_owner_usage_limit_reached',
    workspace_member_usage_limit_reached: 'workspace_member_usage_limit_reached',
    unknown: 'something_new',
    empty: '',
    upperCase: 'RATE_LIMIT_REACHED',
    usageLimitReached: 'usage_limit_reached',
    commaJoinedSame: 'rate_limit_reached, rate_limit_reached',
    commaJoinedMixed: 'rate_limit_reached, credits_depleted',
    quoted: '"rate_limit_reached"',
  };
  for (const [name, value] of Object.entries(refused)) {
    assert.equal(extract({ headers: new Headers({ [CODEX_REACHED]: value }), body: openaiBody() }), null, name);
    assert.equal(extract({ headers: new Headers({ [CODEX_REACHED]: value }), body: openaiBody({ type: undefined, code: 'usage_limit_reached' }) }), null, `${name} via code`);
  }
  // A repeated header is joined by native Headers and refuses even when each copy is acceptable.
  const repeated = new Headers();
  repeated.append(CODEX_REACHED, 'rate_limit_reached');
  repeated.append(CODEX_REACHED, 'rate_limit_reached');
  assert.equal(extract({ headers: repeated, body: openaiBody() }), null, 'repeated header');
});

test('x-codex-credits-has-credits false or x-codex-credits-balance 0 alone does not refuse a recognized rolling quota', () => {
  const cases = {
    hasCreditsFalse: new Headers({ 'x-codex-credits-has-credits': 'false' }),
    balanceZero: new Headers({ 'x-codex-credits-balance': '0' }),
    both: new Headers({ 'x-codex-credits-has-credits': 'false', 'x-codex-credits-balance': '0' }),
    bothWithRollingType: new Headers({ 'x-codex-credits-has-credits': 'false', 'x-codex-credits-balance': '0', [CODEX_REACHED]: 'rate_limit_reached' }),
  };
  for (const [name, headers] of Object.entries(cases)) assert.deepEqual(extract({ headers, body: openaiBody() }), OPENAI_POSITIVE, name);
  // Credit headers never create a positive on their own.
  assert.equal(extract({ headers: cases.both, body: '' }), null, 'credit headers alone');
});

test('Anthropic unified positive mixed with any x-codex limit header is a cross-provider contradiction and refuses', () => {
  const cases = {
    reachedTypeRolling: { [CODEX_REACHED]: 'rate_limit_reached' },
    reachedTypeCredits: { [CODEX_REACHED]: 'credits_depleted' },
    reachedTypeEmpty: { [CODEX_REACHED]: '' },
    hasCredits: { 'x-codex-credits-has-credits': 'false' },
    balance: { 'x-codex-credits-balance': '0' },
    primaryUsed: { 'x-codex-primary-used-percent': '100' },
    upperCaseName: { 'X-Codex-Rate-Limit-Reached-Type': 'rate_limit_reached' },
  };
  for (const [name, extra] of Object.entries(cases)) {
    const headers = anthropicHeaders();
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    assert.equal(extract({ headers, body: anthropicBody() }), null, name);
    assert.equal(extract({ headers, body: '' }), null, `${name} without body`);
  }
  // Control: the same Anthropic response without any x-codex header is still positive.
  assert.equal(extract({ headers: anthropicHeaders(), body: anthropicBody() })?.kind, 'anthropic-unified');
});

// ---- 4. persisted continuation records ------------------------------------------------

const ROUTING_REVISION = 'd'.repeat(64);
const AUTH_REVISION = `1760000000000:420:${'c'.repeat(64)}`;
const validRecord = (overrides = {}) => ({
  sourceLeaseID: 'lease-source-1',
  sourceTargetID: 'claude-sonnet',
  sourceModelID: 'claude-sonnet-4',
  sourceProviderID: 'anthropic',
  sourceAuthRevision: AUTH_REVISION,
  observedAtMs: NOW - 60000,
  circuitKind: 'quota',
  circuitUpdatedAtMs: NOW - 60000,
  circuitUntilMs: NOW + HOUR,
  policyRevision: ROUTING_REVISION,
  quotaEvidenceClosed: { version: 1, kind: 'anthropic-unified', window: 'five_hour', resetAtMs: NOW + HOUR },
  ...overrides,
});
const RECORD_KEYS = ['sourceLeaseID', 'sourceTargetID', 'sourceModelID', 'sourceProviderID', 'sourceAuthRevision', 'observedAtMs',
  'circuitKind', 'circuitUpdatedAtMs', 'circuitUntilMs', 'policyRevision', 'quotaEvidenceClosed'];

test('valid durable records decode to an exact deeply frozen map', () => {
  const out = normalizeApiContinuationRecords({ ses_abc: validRecord() }, { now: NOW });
  assert.deepEqual(out, { ses_abc: validRecord() });
  assert.deepEqual(Object.keys(out.ses_abc), RECORD_KEYS);
  assert.ok(deepFrozen(out));
  const parsed = normalizeApiContinuationRecords(JSON.parse(JSON.stringify({ ses_abc: validRecord() })), { now: NOW });
  assert.deepEqual(parsed, { ses_abc: validRecord() });
});

test('non-durable session keys and non-object state decode to nothing', () => {
  const out = normalizeApiContinuationRecords({ 'gw-lx2-a': validRecord(), 'gw-probe-x': validRecord(), 'rig-1': validRecord(), other: validRecord() }, { now: NOW });
  assert.deepEqual(out, {});
  for (const raw of [undefined, null, [], 'x', 7]) {
    const empty = normalizeApiContinuationRecords(raw, { now: NOW });
    assert.deepEqual(empty, {}, String(raw));
    assert.ok(Object.isFrozen(empty));
  }
});

test('malformed or chronologically impossible records fail closed individually', () => {
  const { quotaEvidenceClosed, ...missingEvidence } = validRecord();
  const cases = {
    missingEvidence,
    priorFieldName: { ...missingEvidence, quotaEvidence: quotaEvidenceClosed },
    extraField: validRecord({ grant: true }),
    rateCircuit: validRecord({ circuitKind: 'rate' }),
    caseCircuit: validRecord({ circuitKind: 'Quota' }),
    badRevision: validRecord({ policyRevision: 'D'.repeat(64) }),
    controlID: validRecord({ sourceLeaseID: 'lease\u0000' }),
    longID: validRecord({ sourceTargetID: 'x'.repeat(513) }),
    emptyID: validRecord({ sourceModelID: '' }),
    nullAuth: validRecord({ sourceAuthRevision: null }),
    observedAfterUpdate: validRecord({ observedAtMs: NOW - 1000, circuitUpdatedAtMs: NOW - 2000 }),
    updatedInFuture: validRecord({ circuitUpdatedAtMs: NOW + 1 }),
    expired: validRecord({ circuitUntilMs: NOW, quotaEvidenceClosed: { ...quotaEvidenceClosed, resetAtMs: NOW } }),
    resetMismatch: validRecord({ circuitUntilMs: NOW + HOUR + 1 }),
    evidenceExtraKey: validRecord({ quotaEvidenceClosed: { ...quotaEvidenceClosed, raw: 'x' } }),
    stringTime: validRecord({ observedAtMs: String(NOW - 60000) }),
    infinity: validRecord({ circuitUntilMs: Infinity }),
    float: validRecord({ observedAtMs: NOW - 0.5 }),
    nonPlain: Object.assign(Object.create({ inherited: true }), validRecord()),
    arrayRecord: [validRecord()],
  };
  for (const [name, record] of Object.entries(cases)) {
    assert.deepEqual(normalizeApiContinuationRecords({ ses_abc: record, ses_keep: validRecord() }, { now: NOW }), { ses_keep: validRecord() }, name);
  }
});

test('records are bounded newest-first with deterministic ties', () => {
  const raw = {
    ses_old: validRecord({ observedAtMs: NOW - 5000, circuitUpdatedAtMs: NOW - 5000 }),
    ses_newB: validRecord({ observedAtMs: NOW - 1000, circuitUpdatedAtMs: NOW - 1000 }),
    ses_newA: validRecord({ observedAtMs: NOW - 1000, circuitUpdatedAtMs: NOW - 1000 }),
    ses_mid: validRecord({ observedAtMs: NOW - 3000, circuitUpdatedAtMs: NOW - 3000 }),
  };
  const out = normalizeApiContinuationRecords(raw, { now: NOW, max: 3 });
  assert.deepEqual(Object.keys(out), ['ses_newA', 'ses_newB', 'ses_mid']);
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`ses_n${i}`, validRecord({ observedAtMs: NOW - 10000 + i, circuitUpdatedAtMs: NOW - 10000 + i })]));
  const capped = normalizeApiContinuationRecords(many, { now: NOW });
  assert.equal(Object.keys(capped).length, 512);
  assert.equal(Object.keys(capped)[0], 'ses_n599');
  for (const max of [Infinity, 0, -1, 1.5, Number.NaN, '3']) {
    assert.throws(() => normalizeApiContinuationRecords(raw, { now: NOW, max }), /max/, String(max));
  }
  for (const now of [undefined, Number.NaN, '1']) {
    assert.throws(() => normalizeApiContinuationRecords(raw, { now }), /now/, String(now));
  }
});

// ---- 5. source eligibility and current authority --------------------------------------

// Lazy, so a broken normalizer fails each test on its own instead of the whole file at load.
const ENABLED = () => normalizeApiContinuation(rawEnabled(), CTX);
const sourceTarget = (overrides = {}) => ({ id: 'claude-sonnet', providerID: 'anthropic', modelID: 'claude-sonnet-4', kind: 'cloud', source: 'subscription-oauth', ...overrides });
const provider = (overrides = {}) => ({ connected: true, authType: 'oauth', admission: 'admitted', models: 3, ...overrides });
const eligibleArgs = (overrides = {}) => ({ target: sourceTarget(), policy: ENABLED(), provider: provider(), liveAuthType: 'oauth', manualApiTargets: MANUAL, ...overrides });

test('a configured connected OAuth subscription target is an eligible source', () => {
  assert.equal(sourceTargetEligible(eligibleArgs()), true);
});

test('source eligibility refuses disabled policy, unlisted, non-OAuth, local and paid targets', () => {
  const disabled = normalizeApiContinuation({ ...rawEnabled(), enabled: false }, CTX);
  const cases = {
    disabled: { policy: disabled },
    defaultPolicy: { policy: DISABLED_API_CONTINUATION },
    unlisted: { target: sourceTarget({ providerID: 'github-copilot' }) },
    sourceUndefined: { target: sourceTarget({ source: undefined }) },
    trustedSource: { target: sourceTarget({ source: 'subscription-trusted' }) },
    local: { target: sourceTarget({ kind: 'local' }) },
    disconnected: { provider: provider({ connected: false }) },
    apiAuth: { provider: provider({ authType: 'api' }) },
    liveApiAuth: { liveAuthType: 'api' },
    liveUnknown: { liveAuthType: undefined },
    noProvider: { provider: undefined },
    manualTargetID: { target: sourceTarget({ id: 'api-sonnet' }) },
    paidProvider: { target: sourceTarget({ providerID: 'anthropic-api' }), policy: Object.freeze({ ...ENABLED(), sourceProviders: Object.freeze(['anthropic-api']) }) },
    missingModel: { target: sourceTarget({ modelID: '' }) },
    controlModel: { target: sourceTarget({ modelID: 'm\n' }) },
    noTarget: { target: undefined },
  };
  for (const [name, overrides] of Object.entries(cases)) assert.equal(sourceTargetEligible(eligibleArgs(overrides)), false, name);
});

test('source eligibility fails closed on a missing or malformed manual registry; an empty registry is valid', () => {
  assert.equal(sourceTargetEligible(eligibleArgs({ manualApiTargets: Object.freeze({}) })), true);
  assert.equal(sourceTargetEligible(eligibleArgs({ manualApiTargets: {} })), true);
  const cases = {
    omitted: undefined,
    nullRegistry: null,
    arrayRegistry: [],
    stringRegistry: 'api-sonnet',
    nonPlainRegistry: Object.assign(Object.create({ inherited: true }), MANUAL),
    nullEntry: { ...MANUAL, broken: null },
    entryNoProvider: { ...MANUAL, broken: { modelID: 'm', profiles: ['api-reserve'] } },
    entryEmptyModel: { ...MANUAL, broken: { providerID: 'p', modelID: '', profiles: ['api-reserve'] } },
    entryProfilesNotArray: { ...MANUAL, broken: { providerID: 'p', modelID: 'm', profiles: 'api-reserve' } },
  };
  for (const [name, manualApiTargets] of Object.entries(cases)) {
    assert.equal(sourceTargetEligible(eligibleArgs({ manualApiTargets })), false, name);
  }
  // The key is genuinely absent, not just undefined-valued.
  const { manualApiTargets, ...omittedKey } = eligibleArgs();
  assert.equal(sourceTargetEligible(omittedKey), false);
});

const CIRCUIT = Object.freeze({ kind: 'quota', until: NOW + HOUR, resetKnown: true, updatedAt: NOW - 60000 });
// Per-provider auth fence: the record fences the SOURCE PROVIDER's own auth.json entry (liveSourceAuthRevision); the
// whole-file revision is only a currency check (live file == published inventory) for minting.
const FILE_REVISION = `1760000000000:999:${'f'.repeat(64)}`;
const authorityArgs = (overrides = {}) => ({
  record: validRecord({ policyRevision: ENABLED().revision }),
  policy: ENABLED(),
  sourceTarget: sourceTarget(),
  provider: provider(),
  liveAuthType: 'oauth',
  circuit: CIRCUIT,
  liveSourceAuthRevision: AUTH_REVISION,
  liveAuthRevision: FILE_REVISION,
  inventoryAuthRevision: FILE_REVISION,
  manualApiTargets: MANUAL,
  now: NOW,
  ...overrides,
});

test('current exact source evidence with a matching quota circuit is current authority', () => {
  assert.equal(continuationAuthorityCurrent(authorityArgs()), true);
});

// A later re-stamp of the same quota circuit (another session's /failure on the same provider,
// same or later reset) keeps every earlier record current; the grant stays clipped to the record.
test('a quota circuit re-stamped later or extended keeps the record current', () => {
  const cases = {
    sameUntilRestamped: { circuit: { ...CIRCUIT, updatedAt: CIRCUIT.updatedAt + 1 } },
    muchNewerCircuit: { circuit: { ...CIRCUIT, updatedAt: NOW } },
    untilExtended: { circuit: { ...CIRCUIT, until: CIRCUIT.until + 1000 } },
    bothLater: { circuit: { ...CIRCUIT, until: CIRCUIT.until + 60000, updatedAt: NOW } },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    assert.equal(continuationAuthorityCurrent(authorityArgs(overrides)), true, name);
  }
});

test('current authority refuses a weakened, cleared or ended circuit and any source, identity or policy drift', () => {
  const otherEntry = 'e'.repeat(64);
  const changedPolicy = normalizeApiContinuation({ ...rawEnabled(), grantTTLms: 60000 }, CTX);
  const cases = {
    olderCircuit: { circuit: { ...CIRCUIT, updatedAt: CIRCUIT.updatedAt - 1 } },
    untilEarlier: { circuit: { ...CIRCUIT, until: CIRCUIT.until - 1 } },
    resetUnknown: { circuit: { ...CIRCUIT, resetKnown: false } },
    resetMissing: { circuit: { kind: 'quota', until: CIRCUIT.until, updatedAt: CIRCUIT.updatedAt } },
    rateCircuit: { circuit: { ...CIRCUIT, kind: 'rate' } },
    planWindowCircuit: { circuit: { ...CIRCUIT, kind: 'plan-window' } },
    lapsedCircuit: { circuit: { ...CIRCUIT, reason: 'plan-lapsed' } },
    cleared: { circuit: undefined },
    expired: { now: CIRCUIT.until },
    // The circuit was extended, but the RECORD's own end has passed: the record is spent.
    recordEndPassed: { now: CIRCUIT.until, circuit: { ...CIRCUIT, until: CIRCUIT.until + HOUR, updatedAt: CIRCUIT.until } },
    policyChanged: { policy: changedPolicy },
    disabledPolicy: { policy: normalizeApiContinuation({ ...rawEnabled(), enabled: false }, CTX) },
    sourceEntryChanged: { liveSourceAuthRevision: otherEntry },
    sourceEntryAbsent: { liveSourceAuthRevision: 'absent' },
    recordAuthDrift: { record: validRecord({ policyRevision: ENABLED().revision, sourceAuthRevision: otherEntry }) },
    modelDrift: { sourceTarget: sourceTarget({ modelID: 'claude-sonnet-5' }) },
    targetDrift: { sourceTarget: sourceTarget({ id: 'claude-sonnet-alt' }) },
    providerDrift: { sourceTarget: sourceTarget({ providerID: 'openai' }) },
    malformedRecord: { record: { ...validRecord({ policyRevision: ENABLED().revision }), extra: 1 } },
    recordFromFuture: { record: validRecord({ policyRevision: ENABLED().revision, observedAtMs: NOW + 1, circuitUpdatedAtMs: NOW + 1 }), circuit: { ...CIRCUIT, updatedAt: NOW + 1 } },
    noRecord: { record: undefined },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    assert.equal(continuationAuthorityCurrent(authorityArgs(overrides)), false, name);
  }
});

test('transient auth, inventory and provider conditions make a record non-current', () => {
  const otherFile = `1760000000001:420:${'e'.repeat(64)}`;
  const cases = {
    // An UNRELATED provider's auth entry changed: the whole file moved, the inventory is stale.
    liveFileAheadOfInventory: { liveAuthRevision: otherFile },
    inventoryStale: { inventoryAuthRevision: otherFile },
    fileUnreadable: { liveAuthRevision: null },
    sourceEntryUnreadable: { liveSourceAuthRevision: null },
    allAuthUnknown: { liveSourceAuthRevision: null, liveAuthRevision: null, inventoryAuthRevision: null },
    disconnected: { provider: provider({ connected: false }) },
    noProvider: { provider: undefined },
    liveAuthTypeUnknown: { liveAuthType: undefined },
    sourceTargetMissing: { sourceTarget: undefined },
    brokenRegistry: { manualApiTargets: { ...MANUAL, broken: null } },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    assert.equal(continuationAuthorityCurrent(authorityArgs(overrides)), false, name);
  }
});

// The permanent-invalidity predicate. True ONLY when the record can never become current
// again; an unreadable source entry or a circuit that merely lost its known reset is not permanent.
const permanentArgs = (overrides = {}) => ({
  record: validRecord({ policyRevision: ENABLED().revision }),
  circuit: CIRCUIT,
  liveSourceAuthRevision: AUTH_REVISION,
  policyRevision: ENABLED().revision,
  now: NOW,
  identityOK: true,
  ...overrides,
});

test('permanent invalidity truth table: only source entry change, circuit loss or shortening, record end, policy and identity drift', () => {
  const permanent = {
    sourceEntryChanged: { liveSourceAuthRevision: 'e'.repeat(64) },
    sourceEntryAbsent: { liveSourceAuthRevision: 'absent' },
    circuitCleared: { circuit: undefined },
    circuitNull: { circuit: null },
    rateCircuit: { circuit: { ...CIRCUIT, kind: 'rate' } },
    untilEarlier: { circuit: { ...CIRCUIT, until: CIRCUIT.until - 1 } },
    recordEnded: { now: CIRCUIT.until },
    recordEndedLongAgo: { now: CIRCUIT.until + HOUR, circuit: { ...CIRCUIT, until: CIRCUIT.until + 2 * HOUR } },
    policyChanged: { policyRevision: 'e'.repeat(64) },
    identityDrift: { identityOK: false },
  };
  for (const [name, overrides] of Object.entries(permanent)) {
    assert.equal(continuationRecordPermanentlyInvalid(permanentArgs(overrides)), true, name);
  }
  const notPermanent = {
    baseline: {},
    sourceEntryUnreadable: { liveSourceAuthRevision: null },
    sourceEntryUnknown: { liveSourceAuthRevision: undefined },
    resetUnknown: { circuit: { ...CIRCUIT, resetKnown: false } },
    restampedLater: { circuit: { ...CIRCUIT, updatedAt: NOW } },
    untilExtended: { circuit: { ...CIRCUIT, until: CIRCUIT.until + HOUR } },
    identityUnknown: { identityOK: undefined },
  };
  for (const [name, overrides] of Object.entries(notPermanent)) {
    assert.equal(continuationRecordPermanentlyInvalid(permanentArgs(overrides)), false, name);
  }
});

// Request gate (narrowest real seam): the request-side gate the broker's late refusal branch consults. A
// fully valid baseline is eligible; each case varies exactly ONE gate.
// The baseline lane includes a local target whose residency the probe DID establish.
const lateRequest = (overrides = {}) => ({
  refusalCode: 'usage-limit', policy: ENABLED(), probe: false, localOnly: false, api: null,
  sessionID: 'ses_abc', profile: 'auto', tier: 'smart', oneShot: false,
  policyTargetID: null, blockedGeneration: false, includesLocal: true, localResidencyUnknown: false,
  tierNames: TIERS, ...overrides,
});

const lateContinuationRequestEligible = (args) => continuationModule.lateContinuationRequestEligible(args);
test('late continuation request gate: valid baseline passes, every single varied gate refuses', () => {
  assert.equal(typeof continuationModule.lateContinuationRequestEligible, 'function');
  assert.equal(lateContinuationRequestEligible(lateRequest()), true);
  assert.equal(lateContinuationRequestEligible(lateRequest({ refusalCode: 'no-eligible-target' })), true);
  // Unknown residency only matters when the lane actually has a local target.
  assert.equal(lateContinuationRequestEligible(lateRequest({ includesLocal: false, localResidencyUnknown: true })), true);
  const cases = {
    preparing: { refusalCode: 'target-preparing' },
    configInvalid: { refusalCode: 'api-continuation-config-invalid' },
    noRefusalCode: { refusalCode: undefined },
    busy: { refusalCode: 'target-busy' },
    localRefusal: { refusalCode: 'no-eligible-local-target' },
    unresolvable: { refusalCode: 'no-resolvable-target' },
    disabledPolicy: { policy: normalizeApiContinuation({ ...rawEnabled(), enabled: false }, CTX) },
    noPolicy: { policy: undefined },
    probeAssignment: { probe: true },
    localOnly: { localOnly: true },
    embeddings: { api: 'embeddings' },
    // The broker normalizes an absent api to null; anything else is not the generation API.
    apiUndefined: { api: undefined },
    oneShot: { oneShot: true },
    gatewaySession: { sessionID: 'gw-lx2-abc' },
    probeSession: { sessionID: 'gw-probe-abc' },
    rigSession: { sessionID: 'rig-session-1' },
    manualProfile: { profile: 'manual' },
    namedProfile: { profile: 'api-reserve' },
    classifierTier: { tier: 'classifier' },
    embeddingTier: { tier: 'embedding' },
    unknownTier: { tier: 'not-a-tier' },
    // Without the broker's route tier list no tier can be proven a generation tier: fail closed.
    noTierNames: { tierNames: undefined },
    policyTarget: { policyTargetID: 'subscription-x-candidate' },
    blockedGeneration: { blockedGeneration: true },
    localResidencyUnknown: { localResidencyUnknown: true },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    assert.equal(lateContinuationRequestEligible(lateRequest(overrides)), false, name);
  }
  assert.equal(lateContinuationRequestEligible(undefined), false, 'no arguments');
});

test('current authority inherits the fail-closed manual registry gate', () => {
  for (const manualApiTargets of [undefined, null, [], { ...MANUAL, broken: null }]) {
    assert.equal(continuationAuthorityCurrent(authorityArgs({ manualApiTargets })), false, String(manualApiTargets));
  }
  assert.equal(continuationAuthorityCurrent(authorityArgs({ manualApiTargets: {} })), true);
});

// ---- 6. grant minting --------------------------------------------------------------------

// The exact static target shape: a registered cloud target with no subscription source marker.
const PAID = Object.freeze({ id: 'api-sonnet', providerID: 'anthropic-api', modelID: 'claude-sonnet-x', kind: 'cloud' });
const PAID_OPUS = Object.freeze({ id: 'api-opus', providerID: 'anthropic-api', modelID: 'claude-opus-x', kind: 'cloud' });
// Manual-only pins: continuation disabled, no continuation targets, both manual targets pinned.
const MANUAL_ONLY = () => normalizeApiContinuation({ enabled: false, spendPolicyHashes: { 'api-sonnet': PIN_A, 'api-opus': PIN_B } }, CTX);
// Continuation enabled for api-sonnet (build, smart) with the maximum grant TTL; api-opus pinned for manual use only.
const CONTINUATION = () => normalizeApiContinuation({ ...rawEnabled(), spendPolicyHashes: { 'api-sonnet': PIN_A, 'api-opus': PIN_B }, grantTTLms: 300000 }, CTX);
const manualMint = (overrides = {}) => ({ purpose: 'manual', sessionID: 'gw-lx2-abc', leaseID: 'lease-paid-1', target: PAID, profile: 'api-reserve', tier: 'smart', policy: MANUAL_ONLY(), manualApiTargets: MANUAL, ttlMs: 60000, now: NOW, ...overrides });
const continuationMint = (overrides = {}) => ({ purpose: 'continuation', sessionID: 'ses_abc', leaseID: 'lease-paid-2', target: PAID, profile: 'auto', tier: 'smart', policy: CONTINUATION(), manualApiTargets: MANUAL, ttlMs: 300000, now: NOW, record: validRecord(), ...overrides });

test('manual grant is closed, frozen, sourceless and carries the exact financial pin', () => {
  const grant = mintSpendGrant(manualMint());
  assert.match(grant.grantID, UUID);
  assert.deepEqual({ ...grant, grantID: 'x' }, {
    version: 1, grantID: 'x', purpose: 'manual', sessionID: 'gw-lx2-abc', leaseID: 'lease-paid-1', targetID: 'api-sonnet',
    providerID: 'anthropic-api', modelID: 'claude-sonnet-x', profile: 'api-reserve', tier: 'smart', issuedAtMs: NOW,
    expiresAtMs: NOW + 60000, policyRevision: PIN_A, source: null,
  });
  assert.ok(deepFrozen(grant));
  assert.deepEqual(normalizeApiSpendGrant(grant, { now: NOW, sessionID: 'gw-lx2-abc', leaseID: 'lease-paid-1', targetID: 'api-sonnet', providerID: 'anthropic-api', modelID: 'claude-sonnet-x' }), grant);
  assert.notEqual(mintSpendGrant(manualMint()).grantID, grant.grantID);
});

test('continuation grant copies exact source fields and is bounded by TTL and source circuit', () => {
  const grant = mintSpendGrant(continuationMint());
  assert.equal(grant.purpose, 'continuation');
  assert.equal(grant.policyRevision, PIN_A);
  assert.notEqual(grant.policyRevision, validRecord().policyRevision);
  assert.deepEqual(grant.source, {
    providerID: 'anthropic', targetID: 'claude-sonnet', leaseID: 'lease-source-1', modelID: 'claude-sonnet-4',
    quotaObservedAtMs: NOW - 60000, quotaUntilMs: NOW + HOUR,
  });
  assert.equal(grant.expiresAtMs, NOW + 300000);
  assert.ok(deepFrozen(grant));
  const shortSource = validRecord({ circuitUntilMs: NOW + 1000, quotaEvidenceClosed: { version: 1, kind: 'anthropic-unified', window: 'five_hour', resetAtMs: NOW + 1000 } });
  assert.equal(mintSpendGrant(continuationMint({ record: shortSource })).expiresAtMs, NOW + 1000);
  assert.equal(mintSpendGrant(continuationMint({ ttlMs: 1 })).expiresAtMs, NOW + 1);
});

test('grant minting refuses bad purpose, TTL, pin, session, profile and source', () => {
  const invalid = { code: 'invalid_authorization' };
  const cases = {
    purpose: manualMint({ purpose: 'auto' }),
    ttlZero: manualMint({ ttlMs: 0 }),
    ttlHigh: manualMint({ ttlMs: 300001 }),
    ttlFloat: manualMint({ ttlMs: 1.5 }),
    pinUpper: manualMint({ policyRevision: PIN_A.toUpperCase() }),
    manualWithRecord: manualMint({ record: validRecord() }),
    manualNoTarget: manualMint({ target: undefined }),
    manualBadNow: manualMint({ now: Number.NaN }),
    continuationNamedProfile: continuationMint({ profile: 'api-reserve' }),
    continuationOneShotSession: continuationMint({ sessionID: 'gw-lx2-abc' }),
    continuationRigSession: continuationMint({ sessionID: 'rig-1' }),
    continuationNoRecord: continuationMint({ record: undefined }),
    continuationMalformedRecord: continuationMint({ record: { ...validRecord(), extra: true } }),
    continuationExpiredRecord: continuationMint({ now: NOW + HOUR }),
    continuationSameProvider: continuationMint({ record: validRecord({ sourceProviderID: 'anthropic-api' }) }),
  };
  for (const [name, args] of Object.entries(cases)) assert.throws(() => mintSpendGrant(args), invalid, name);
});

test('the grant pin is derived from the configured spendPolicyHashes entry for the target', () => {
  // No policyRevision argument at all: the pin comes from policy.spendPolicyHashes[target.id].
  assert.equal(mintSpendGrant(manualMint()).policyRevision, PIN_A);
  assert.equal(mintSpendGrant(manualMint({ target: PAID_OPUS })).policyRevision, PIN_B);
  assert.equal(mintSpendGrant(continuationMint()).policyRevision, PIN_A);
  // A legacy policyRevision argument equal to the configured pin is accepted and changes nothing.
  assert.equal(mintSpendGrant(manualMint({ policyRevision: PIN_A })).policyRevision, PIN_A);
  assert.equal(mintSpendGrant(continuationMint({ policyRevision: PIN_A })).policyRevision, PIN_A);
});

test('manual grants work from manual-only pins: disabled policy, empty targets, or a non-continuation target', () => {
  const disabled = MANUAL_ONLY();
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.targets, {});
  assert.equal(mintSpendGrant(manualMint({ policy: disabled })).purpose, 'manual');
  // Enabled continuation policy whose targets exclude api-opus: a manual grant for api-opus is still valid.
  const grant = mintSpendGrant(manualMint({ policy: CONTINUATION(), target: PAID_OPUS, tier: 'worker' }));
  assert.equal(grant.targetID, 'api-opus');
  assert.equal(grant.policyRevision, PIN_B);
  // Named one-shot gateway session IDs remain valid for manual grants.
  assert.equal(mintSpendGrant(manualMint({ sessionID: 'gw-lx2-zzz' })).sessionID, 'gw-lx2-zzz');
});

// Every refusal below also passes a legacy policyRevision equal to the configured pin, so a
// refusal can only come from the policy/registry context check, never from a missing pin.
const withLegacyPin = (args) => ({ policyRevision: PIN_A, ...args });

test('grant minting refuses a legacy pin that differs from the configured pin, including the routing revision', () => {
  const invalid = { code: 'invalid_authorization' };
  const cases = {
    manualOtherPin: manualMint({ policyRevision: PIN_B }),
    manualRoutingRevision: manualMint({ policyRevision: MANUAL_ONLY().revision }),
    continuationOtherPin: continuationMint({ policyRevision: PIN_B }),
    continuationRoutingRevision: continuationMint({ policyRevision: CONTINUATION().revision }),
  };
  for (const [name, args] of Object.entries(cases)) assert.throws(() => mintSpendGrant(args), invalid, name);
});

test('grant minting refuses a missing, malformed or unbound policy and registry', () => {
  const invalid = { code: 'invalid_authorization' };
  const policy = MANUAL_ONLY();
  const unpinned = normalizeApiContinuation({ enabled: false, spendPolicyHashes: { 'api-opus': PIN_B } }, CTX);
  const cases = {
    noPolicy: manualMint({ policy: undefined }),
    nullPolicy: manualMint({ policy: null }),
    arrayPolicy: manualMint({ policy: [policy] }),
    nonPlainPolicy: manualMint({ policy: Object.assign(Object.create({ x: 1 }), policy) }),
    policyExtraKey: manualMint({ policy: { ...policy, extra: true } }),
    policyMissingRevision: manualMint({ policy: (({ revision, ...rest }) => rest)(policy) }),
    policyBadRevision: manualMint({ policy: { ...policy, revision: 'x' } }),
    policyBadTTL: manualMint({ policy: { ...policy, grantTTLms: 0 } }),
    policyBadEnabled: manualMint({ policy: { ...policy, enabled: 'false' } }),
    policyPinsNotObject: manualMint({ policy: { ...policy, spendPolicyHashes: [PIN_A] } }),
    policyPinUppercase: manualMint({ policy: { ...policy, spendPolicyHashes: { 'api-sonnet': PIN_A.toUpperCase() } } }),
    targetUnpinned: manualMint({ policy: unpinned }),
    noRegistry: manualMint({ manualApiTargets: undefined }),
    nullRegistry: manualMint({ manualApiTargets: null }),
    arrayRegistry: manualMint({ manualApiTargets: [MANUAL['api-sonnet']] }),
    malformedRegistryEntry: manualMint({ manualApiTargets: { ...MANUAL, 'api-sonnet': { providerID: 'anthropic-api', modelID: 'claude-sonnet-x', profiles: 'api-reserve' } } }),
    emptyRegistry: manualMint({ manualApiTargets: {} }),
    // The policy was normalized against a different registry: it pins api-opus, which this one lacks.
    policyPinUnregistered: manualMint({ manualApiTargets: { 'api-sonnet': MANUAL['api-sonnet'] } }),
    policyTargetUnregistered: manualMint({ policy: { ...CONTINUATION(), spendPolicyHashes: { 'api-opus': PIN_B } }, manualApiTargets: { 'api-opus': MANUAL['api-opus'] }, target: PAID_OPUS, policyRevision: PIN_B }),
    nullArgs: null,
  };
  for (const [name, args] of Object.entries(cases)) {
    assert.throws(() => mintSpendGrant(args === null ? null : withLegacyPin(args)), invalid, name);
  }
});

test('grant minting refuses a target that is not exactly its static manual registration', () => {
  const invalid = { code: 'invalid_authorization' };
  for (const mint of [manualMint, continuationMint]) {
    const cases = {
      unregisteredID: { target: { ...PAID, id: 'oauth-sonnet' } },
      wrongModel: { target: { ...PAID, modelID: 'claude-opus-x' } },
      wrongProvider: { target: { ...PAID, providerID: 'anthropic' } },
      missingKind: { target: { id: PAID.id, providerID: PAID.providerID, modelID: PAID.modelID } },
      localKind: { target: { ...PAID, kind: 'local' } },
      subscriptionSource: { target: { ...PAID, source: 'subscription-oauth' } },
      trustedSource: { target: { ...PAID, source: 'subscription-trusted' } },
      registryModelDrift: { manualApiTargets: manualFixture({ 'api-sonnet': Object.freeze({ providerID: 'anthropic-api', modelID: 'claude-sonnet-y', profiles: Object.freeze(['api-reserve']) }) }) },
    };
    for (const [name, overrides] of Object.entries(cases)) {
      assert.throws(() => mintSpendGrant(withLegacyPin(mint(overrides))), invalid, `${mint.name}:${name}`);
    }
  }
});

test('manual minting requires actual manual admission of the target for the profile', () => {
  const invalid = { code: 'invalid_authorization' };
  for (const profile of ['auto', 'manual', 'uncensored-offline', 'private', 'api-reserve-2', undefined]) {
    assert.throws(() => mintSpendGrant(withLegacyPin(manualMint({ profile }))), invalid, String(profile));
  }
  // A registry entry that does not list the profile admits nothing.
  const narrowed = manualFixture({ 'api-sonnet': Object.freeze({ providerID: 'anthropic-api', modelID: 'claude-sonnet-x', profiles: Object.freeze(['other-reserve']) }) });
  assert.throws(() => mintSpendGrant(withLegacyPin(manualMint({ manualApiTargets: narrowed }))), invalid);
  assert.equal(mintSpendGrant(manualMint({ manualApiTargets: narrowed, profile: 'other-reserve' })).profile, 'other-reserve');
});

test('continuation minting requires an enabled policy, a listed generation tier and the policy grant TTL', () => {
  const invalid = { code: 'invalid_authorization' };
  const shortTTL = normalizeApiContinuation({ ...rawEnabled(), grantTTLms: 120000 }, CTX);
  const forgedNonGeneration = { ...CONTINUATION(), targets: { 'api-sonnet': ['classifier', 'embedding', 'smart'] } };
  const cases = {
    disabledPolicy: { policy: MANUAL_ONLY() },
    disabledWithTargets: { policy: normalizeApiContinuation({ ...rawEnabled(), enabled: false }, CTX) },
    targetNotContinuation: { target: PAID_OPUS, policyRevision: PIN_B },
    tierNotListed: { tier: 'worker' },
    tierMissing: { tier: undefined },
    classifierTier: { policy: forgedNonGeneration, tier: 'classifier' },
    embeddingTier: { policy: forgedNonGeneration, tier: 'embedding' },
    ttlAbovePolicy: { policy: shortTTL, ttlMs: 120001 },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    assert.throws(() => mintSpendGrant(withLegacyPin(continuationMint(overrides))), invalid, name);
  }
  assert.equal(mintSpendGrant(continuationMint({ policy: shortTTL, ttlMs: 120000 })).expiresAtMs, NOW + 120000);
  assert.equal(mintSpendGrant(continuationMint({ tier: 'build' })).tier, 'build');
});

// The broker's later /failure may only CONSUME an already-stored positive observation; this
// helper can only deny. A false result is never proof on its own.
test('a quota failure is contradicted by billing/credit/lapse/auth/burst wording or any non-429 status', () => {
  const upstream = (wording) => `APIError 429 upstream oauthsrc HTTP 429: ${wording}`;
  const compatible = [
    [{ text: upstream('usage limit reached'), statusCode: 429 }, 'actual 429'],
    [{ text: upstream('usage limit reached (5-hour limit; resets at 2026-10-21T14:00:00.000Z)'), statusCode: 429 }, 'reset wording'],
    [{ text: 'APIError usage limit reached', statusCode: undefined }, 'missing status, stored observation proves 429'],
    [{ text: 'APIError usage limit reached', statusCode: null }, 'null status'],
    [{ text: `APIError 502 ${upstream('usage limit reached').slice(13)}`, statusCode: 502 }, 'outer 502 over an explicit nested upstream 429'],
  ];
  for (const [input, name] of compatible) {
    assert.equal(subscriptionQuotaFailureContradicted(input), false, name);
  }
  const contradicted = [
    [{ text: upstream('billing limit exhausted'), statusCode: 429 }, 'billing'],
    [{ text: upstream('insufficient credit balance'), statusCode: 429 }, 'credit'],
    [{ text: upstream('Usage credits are required for fast mode.'), statusCode: 429 }, 'fast-mode credit'],
    [{ text: upstream('subscription lapsed'), statusCode: 429 }, 'lapse'],
    [{ text: upstream('authentication failed'), statusCode: 429 }, 'auth'],
    [{ text: upstream('too many requests per minute'), statusCode: 429 }, 'burst'],
    [{ text: 'APIError 502 bad gateway: usage limit reached', statusCode: 502 }, 'a 502 message alone'],
    [{ text: 'APIError 502 upstream oauthsrc HTTP 529: usage limit reached', statusCode: 502 }, 'outer 502 over a nested 529'],
    [{ text: `${upstream('usage limit reached')}; upstream oauthsrc HTTP 503`, statusCode: 429 }, 'mixed upstream statuses'],
    [{ text: upstream('usage limit reached'), statusCode: 403 }, 'known other status'],
    [{ text: upstream('usage limit reached'), statusCode: 529 }, 'overload status'],
    [{ text: upstream('usage limit reached'), statusCode: '429' }, 'non-integer status'],
    [{ text: undefined, statusCode: 429 }, 'missing text'],
    [{ text: 7, statusCode: 429 }, 'non-string text'],
    [{ text: 'x'.repeat(16_385), statusCode: 429 }, 'oversized text'],
    [undefined, 'no input'],
  ];
  for (const [input, name] of contradicted) {
    assert.equal(subscriptionQuotaFailureContradicted(input), true, name);
  }
});

// ---- 7. per-provider auth entry revision -------------------------------------------------

// Synthetic auth stores only, in a private temp dir removed in finally; no real credential.
const withAuthDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'api-continuation-auth-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const writeAuth = (dir, name, contents) => {
  const path = join(dir, name);
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), { mode: 0o600 });
  return path;
};

test('providerAuthRevision is a sha256 hex stable across key order', () => withAuthDir((dir) => {
  const a = writeAuth(dir, 'a.json', { anthropic: { type: 'oauth', refresh: 'r-1', access: 'a-1', expires: 1 }, openai: { type: 'oauth', z: 1 } });
  const b = writeAuth(dir, 'b.json', { openai: { z: 1, type: 'oauth' }, anthropic: { expires: 1, access: 'a-1', type: 'oauth', refresh: 'r-1' } });
  const revision = providerAuthRevision('anthropic', { authPath: a });
  assert.match(revision, HEX);
  assert.equal(providerAuthRevision('anthropic', { authPath: b }), revision);
  // Deterministic: a nested object's key order does not matter either.
  const c = writeAuth(dir, 'c.json', { anthropic: { type: 'oauth', meta: { y: 2, x: 1 } } });
  const d = writeAuth(dir, 'd.json', { anthropic: { meta: { x: 1, y: 2 }, type: 'oauth' } });
  assert.equal(providerAuthRevision('anthropic', { authPath: c }), providerAuthRevision('anthropic', { authPath: d }));
}));

test('providerAuthRevision changes with the provider entry and ignores other providers', () => withAuthDir((dir) => {
  const base = writeAuth(dir, 'base.json', { anthropic: { type: 'oauth', refresh: 'r-1' }, openai: { type: 'oauth', refresh: 'o-1' } });
  const rotated = writeAuth(dir, 'rotated.json', { anthropic: { type: 'oauth', refresh: 'r-2' }, openai: { type: 'oauth', refresh: 'o-1' } });
  const otherChanged = writeAuth(dir, 'other.json', { anthropic: { type: 'oauth', refresh: 'r-1' }, openai: { type: 'oauth', refresh: 'o-2' }, extra: { type: 'api' } });
  const revision = providerAuthRevision('anthropic', { authPath: base });
  assert.notEqual(providerAuthRevision('anthropic', { authPath: rotated }), revision);
  assert.equal(providerAuthRevision('anthropic', { authPath: otherChanged }), revision);
  assert.notEqual(providerAuthRevision('openai', { authPath: otherChanged }), providerAuthRevision('openai', { authPath: base }));
  // The result is a digest, never the raw entry.
  assert.ok(!revision.includes('r-1'));
}));

test('providerAuthRevision is "absent" without an own entry and null when unreadable or unparseable', () => withAuthDir((dir) => {
  const store = writeAuth(dir, 'store.json', { openai: { type: 'oauth' } });
  assert.equal(providerAuthRevision('anthropic', { authPath: store }), 'absent');
  assert.equal(providerAuthRevision('toString', { authPath: store }), 'absent');
  assert.equal(providerAuthRevision('__proto__', { authPath: store }), 'absent');
  assert.equal(providerAuthRevision('anthropic', { authPath: writeAuth(dir, 'empty.json', {}) }), 'absent');
  assert.equal(providerAuthRevision('anthropic', { authPath: writeAuth(dir, 'bad.json', '{"anthropic": ') }), null);
  assert.equal(providerAuthRevision('anthropic', { authPath: writeAuth(dir, 'array.json', '[]') }), null);
  assert.equal(providerAuthRevision('anthropic', { authPath: writeAuth(dir, 'null.json', 'null') }), null);
  assert.equal(providerAuthRevision('anthropic', { authPath: join(dir, 'missing.json') }), null);
}));
