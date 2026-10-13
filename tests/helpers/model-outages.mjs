// Shared outage-reserve fixtures. Every object here is a complete, fake, offline
// fixture: no release dates are guessed, no alias marker is defaulted, and nothing
// here is (or stands in for) an actual runtime credential identity.
export const rows = [
  ['claude-opus-5-5', 'opus', 'standard', ['claude-opus-5', 'claude-opus-4-8']],
  ['claude-opus-5-5-fast', 'opus', 'fast', ['claude-opus-5-fast', 'claude-opus-4-8-fast']],
  ['claude-sonnet-5-5', 'sonnet', 'standard', ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929']],
  ['claude-fable-5-1', 'fable', 'standard', ['claude-fable-5']],
  ['gpt-6-1-sol', 'sol', 'standard', ['gpt-flagship']],
];
export const CI_A = `ci_${Buffer.alloc(32, 0xa1).toString('base64url')}`;
export const CI_B = `ci_${Buffer.alloc(32, 0xb2).toString('base64url')}`;
export const CI_C = `ci_${Buffer.alloc(32, 0xc3).toString('base64url')}`;
export function makeTargets() {
  const targets = {};
  for (const [primary, family, speed, reserves] of rows) {
    const providerID = family === 'sol' ? 'openai' : 'anthropic';
    for (const id of [primary, ...reserves]) targets[id] = {
      id, providerID, modelID: id === 'gpt-flagship' ? 'gpt-6-sol' : id,
      kind: 'cloud', family, speed, context: 200000, capacity: null,
    };
  }
  return targets;
}
export function makePolicy() {
  const mappings = {}, expectedScopePolicies = {}, incidentAliases = {}, primaryScope = {};
  const aliases = ['Claude Opus 5.5', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Fable 5.1', 'GPT-6.1 Sol'];
  rows.forEach(([primary, family, speed, reserves], i) => {
    const providerID = family === 'sol' ? 'openai' : 'anthropic';
    const id = `${providerID}/${family}/${speed}`;
    mappings[primary] = [...reserves]; primaryScope[primary] = id;
    incidentAliases[primary] = [aliases[i]];
    expectedScopePolicies[id] = providerID === 'anthropic'
      ? { providerID, connectionID: 'llm-auth-proxy/anthropic', authMode: 'claude-code-oauth',
          transport: 'messages', product: 'claude-code', speed,
          probe: { api: 'messages', tokenMode: 'max_tokens-total-256' } }
      : { providerID, connectionID: 'llm-auth-proxy/openai', authMode: 'chatgpt-oauth',
          transport: 'responses', product: 'codex', speed,
          probe: { api: 'responses', tokenMode: 'request-time-only' } };
  });
  return { enabled: true, mappings, expectedScopePolicies, incidentAliases, primaryScope };
}
export function makeBaseline(overrides = {}) {
  return { type: 'outcome', logicalID: 'anthropic/opus/standard', primaryID: 'claude-opus-5-5',
    targetID: 'claude-opus-5-5', providerID: 'anthropic', modelID: 'claude-opus-5-5',
    requestID: 'baseline', attemptID: 'baseline-1', purpose: 'real', credentialInstance: CI_A,
    failureOrigin: 'upstream-response', upstreamStatus: 200, result: 'success',
    connectionID:'llm-auth-proxy/anthropic',upstreamOrigin:'https://api.anthropic.com',
    authMode:'claude-code-oauth',transport:'messages',product:'claude-code',
    startedAt: 1000, finishedAt: 1100, generation: 0, ...overrides };
}
export function makeFailure(overrides = {}) {
  return makeBaseline({ requestID: 'r1', attemptID: 'a1', result: 'service-fault',
    failureOrigin: 'upstream-http', upstreamStatus: 503,
    startedAt: 2000, finishedAt: 2100, ...overrides });
}
export function makeSnapshot(overrides = {}) {
  return { type: 'snapshot', providerID: 'anthropic', status: 'valid', receivedAt: 2200,
    matches: { 'claude-opus-5-5': ['incident-1'] }, resolvedIncidentIDs: {}, resolved: [], ...overrides };
}
