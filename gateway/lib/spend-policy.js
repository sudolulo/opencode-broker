import { createHash } from 'node:crypto';
import { normalizeApiSpendGrant } from '../../lib/api-spend-grant.js';

const MAX_SQLITE = 9223372036854775807n;
const POLICY_KEYS = new Set(['ledgerPath', 'policyID', 'validUntil', 'ceilingUSD', 'binding', 'models', 'reconcileUsage', 'billingReceiptContract', 'allocations']);
const REQUEST_KEYS = new Set(['model', 'messages', 'max_tokens', 'stream', 'system', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata', 'tools', 'tool_choice', 'thinking', 'service_tier']);
const HEADER_KEYS = new Set(['content-type', 'accept', 'anthropic-version', 'x-api-key', 'user-agent', 'x-request-id', 'traceparent', 'tracestate']);

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const safePositive = value => Number.isSafeInteger(value) && value > 0;
const own = (object, key) => Object.hasOwn(object, key);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0-\x1f\x7f]/.test(value);

function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreeze(item)])));
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hasDuplicateObjectKey(json) {
  const objects = [];
  for (let index = 0; index < json.length; index += 1) {
    if (json[index] === '{') { objects.push(new Set()); continue; }
    if (json[index] === '}') { objects.pop(); continue; }
    if (json[index] === '"') {
      const start = index;
      index += 1;
      while (index < json.length) { if (json[index] === '\\') { index += 2; continue; } if (json[index] === '"') break; index += 1; }
      if (index >= json.length) return true;
      let next = index + 1; while (/\s/.test(json[next] ?? '')) next += 1;
      if (json[next] !== ':') continue;
      let key; try { key = JSON.parse(json.slice(start, index + 1)); } catch { return true; }
      const current = objects.at(-1);
      if (!current || current.has(key)) return true;
      current.add(key);
    }
  }
  return false;
}

function nanos(decimal, { allowZero = true } = {}) {
  if (typeof decimal !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal)) fail('invalid_policy', 'invalid decimal money');
  const [whole, fraction = ''] = decimal.split('.');
  const amount = BigInt(whole) * 1000000000n + BigInt((fraction.slice(0, 9) + '000000000').slice(0, 9));
  const positiveSubnano = BigInt(whole) === 0n && /[1-9]/.test(fraction) && amount === 0n;
  if ((!allowZero && amount === 0n) || positiveSubnano || amount > MAX_SQLITE) fail('invalid_policy', 'invalid nanoUSD amount');
  return amount;
}

function canonicalUSD(amount) {
  const whole = amount / 1000000000n;
  const fraction = (amount % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function originOf(value, code = 'invalid_policy') {
  if (typeof value !== 'string') fail(code, 'invalid origin');
  let url; try { url = new URL(value); } catch { fail(code, 'invalid origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || value !== url.origin || url.origin !== 'https://api.anthropic.com') fail(code, 'unsupported origin');
  return url.origin;
}

function digest(value, code = 'invalid_policy') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(code, 'invalid digest');
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail('invalid_policy', 'invalid timestamp');
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) fail('invalid_policy', 'invalid timestamp');
  return milliseconds;
}

function validateCacheControl(value) {
  if (value === undefined) return;
  if (!exactKeys(value, ['type', 'ttl']) || value.type !== 'ephemeral' || (value.ttl !== undefined && value.ttl !== '5m' && value.ttl !== '1h')) fail('unsupported_request', 'invalid cache control');
}

function validateContentBlock(item, { allowTool = true } = {}) {
  if (!plain(item) || !['text', 'image', 'tool_use', 'tool_result'].includes(item.type)) fail('unsupported_request', 'unsupported content');
  const common = ['type', 'cache_control'];
  if (item.type === 'text') {
    if (!exactKeys(item, [...common, 'text']) || typeof item.text !== 'string') fail('unsupported_request', 'invalid text content');
  } else if (item.type === 'image') {
    if (!exactKeys(item, [...common, 'source']) || !exactKeys(item.source, ['type', 'media_type', 'data']) || item.source.type !== 'base64' || typeof item.source.media_type !== 'string' || typeof item.source.data !== 'string') fail('unsupported_request', 'invalid image content');
  } else if (item.type === 'tool_use') {
    if (!allowTool || !exactKeys(item, [...common, 'id', 'name', 'input']) || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name || !plain(item.input)) fail('unsupported_request', 'invalid tool use');
  } else {
    if (!allowTool || !exactKeys(item, [...common, 'tool_use_id', 'content', 'is_error']) || typeof item.tool_use_id !== 'string' || !item.tool_use_id || (item.content !== undefined && typeof item.content !== 'string' && !Array.isArray(item.content)) || (item.is_error !== undefined && typeof item.is_error !== 'boolean')) fail('unsupported_request', 'invalid tool result');
    if (Array.isArray(item.content)) for (const nested of item.content) validateContentBlock(nested, { allowTool: false });
  }
  validateCacheControl(item.cache_control);
}

function validateContent(content) {
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) fail('unsupported_request', 'unsupported content');
  for (const item of content) validateContentBlock(item);
}

function validateBody(body, policy) {
  let parsed;
  try { if (hasDuplicateObjectKey(body)) fail('unsupported_request', 'ambiguous request body'); parsed = JSON.parse(body); } catch { fail('unsupported_request', 'invalid request body'); }
  if (!plain(parsed) || Object.keys(parsed).some(key => !REQUEST_KEYS.has(key)) || !own(parsed, 'model') || !own(parsed, 'messages') || !own(parsed, 'max_tokens') || !own(parsed, 'service_tier')) fail('unsupported_request', 'unsupported request field');
  if (parsed.service_tier !== 'standard_only' || typeof parsed.model !== 'string' || !own(policy.models, parsed.model)) fail('unsupported_request', 'unsupported model or tier');
  if (!safePositive(parsed.max_tokens) || parsed.max_tokens > policy.models[parsed.model].maxOutputTokens) fail('unsupported_request', 'invalid output bound');
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) fail('unsupported_request', 'invalid messages');
  for (const message of parsed.messages) {
    if (!exactKeys(message, ['role', 'content']) || !['user', 'assistant'].includes(message.role) || !own(message, 'content')) fail('unsupported_request', 'invalid message');
    validateContent(message.content);
  }
  if (parsed.stream !== undefined && typeof parsed.stream !== 'boolean') fail('unsupported_request', 'invalid stream');
  if (parsed.system !== undefined) {
    if (typeof parsed.system === 'string') { /* supported */ } else if (Array.isArray(parsed.system)) {
      for (const block of parsed.system) {
        if (!exactKeys(block, ['type', 'text', 'cache_control']) || block.type !== 'text' || typeof block.text !== 'string') fail('unsupported_request', 'invalid system');
        validateCacheControl(block.cache_control);
      }
    } else fail('unsupported_request', 'invalid system');
  }
  for (const field of ['temperature', 'top_p']) if (parsed[field] !== undefined && (typeof parsed[field] !== 'number' || !Number.isFinite(parsed[field]))) fail('unsupported_request', `invalid ${field}`);
  if (parsed.top_k !== undefined && !safePositive(parsed.top_k)) fail('unsupported_request', 'invalid top_k');
  if (parsed.stop_sequences !== undefined && (!Array.isArray(parsed.stop_sequences) || parsed.stop_sequences.some(item => typeof item !== 'string'))) fail('unsupported_request', 'invalid stop sequences');
  if (parsed.metadata !== undefined && (!exactKeys(parsed.metadata, ['user_id']) || typeof parsed.metadata.user_id !== 'string')) fail('unsupported_request', 'invalid metadata');
  if (parsed.tools !== undefined) {
    if (!Array.isArray(parsed.tools)) fail('unsupported_request', 'invalid tools');
    for (const tool of parsed.tools) if (!exactKeys(tool, ['name', 'description', 'input_schema', 'cache_control']) || typeof tool.name !== 'string' || !tool.name || (tool.description !== undefined && typeof tool.description !== 'string') || !plain(tool.input_schema)) fail('unsupported_request', 'unsupported tool'); else validateCacheControl(tool.cache_control);
  }
  if (parsed.tool_choice !== undefined) {
    if (!plain(parsed.tool_choice) || !['auto', 'any', 'tool', 'none'].includes(parsed.tool_choice.type)) fail('unsupported_request', 'unsupported tool choice');
    const keys = parsed.tool_choice.type === 'tool' ? ['type', 'name', 'disable_parallel_tool_use'] : ['type', 'disable_parallel_tool_use'];
    if (!exactKeys(parsed.tool_choice, keys) || (parsed.tool_choice.type === 'tool' && (typeof parsed.tool_choice.name !== 'string' || !parsed.tool_choice.name)) || (parsed.tool_choice.disable_parallel_tool_use !== undefined && typeof parsed.tool_choice.disable_parallel_tool_use !== 'boolean')) fail('unsupported_request', 'unsupported tool choice');
  }
  if (parsed.thinking !== undefined) {
    if (!plain(parsed.thinking) || !['enabled', 'disabled'].includes(parsed.thinking.type)) fail('unsupported_request', 'unsupported thinking');
    if (parsed.thinking.type === 'disabled' ? !exactKeys(parsed.thinking, ['type']) : !exactKeys(parsed.thinking, ['type', 'budget_tokens']) || !safePositive(parsed.thinking.budget_tokens) || parsed.thinking.budget_tokens > parsed.max_tokens) fail('unsupported_request', 'unsupported thinking');
  }
  return parsed;
}

function canonicalHeaders(headers) {
  const entries = headers instanceof Headers ? [...headers.entries()] : plain(headers) ? Object.entries(headers) : null;
  if (!entries) fail('unsupported_request', 'invalid headers');
  const pairs = []; const seen = new Set();
  for (const [rawName, rawValue] of entries) {
    if (typeof rawName !== 'string' || typeof rawValue !== 'string') fail('unsupported_request', 'invalid headers');
    const name = rawName.toLowerCase();
    if (seen.has(name) || !HEADER_KEYS.has(name)) fail('unsupported_request', 'unsupported headers');
    seen.add(name); pairs.push([name, rawValue]);
  }
  if (!seen.has('x-api-key') || !seen.has('anthropic-version') || !seen.has('content-type')) fail('unsupported_request', 'missing required header');
  const get = name => pairs.find(([key]) => key === name)?.[1];
  if (get('anthropic-version') !== '2023-06-01' || get('content-type') !== 'application/json' || get('x-api-key').length === 0 || get('x-api-key').includes(',')) fail('unsupported_request', 'invalid required header');
  return pairs.sort(([left], [right]) => left.localeCompare(right));
}

export function normalizeSpendPolicy(raw, registeredIdentity) {
  if (!plain(raw) || Object.keys(raw).some(key => !POLICY_KEYS.has(key)) || typeof raw.ledgerPath !== 'string' || !raw.ledgerPath.startsWith('/') || typeof raw.policyID !== 'string' || !raw.policyID || !plain(raw.binding) || !plain(raw.models) || Object.keys(raw.models).length === 0) fail('invalid_policy', 'invalid policy');
  if (!exactKeys(raw.binding, ['providerID', 'origin', 'credentialSHA256']) || typeof raw.binding.providerID !== 'string' || !raw.binding.providerID) fail('invalid_policy', 'invalid binding');
  const binding = { providerID: raw.binding.providerID, origin: originOf(raw.binding.origin), credentialSHA256: digest(raw.binding.credentialSHA256) };
  const models = Object.create(null);
  for (const [id, model] of Object.entries(raw.models)) {
    if (!id || !exactKeys(model, ['maxInputTokens', 'maxOutputTokens', 'ratesNanoUSD']) || !safePositive(model.maxInputTokens) || !safePositive(model.maxOutputTokens) || !exactKeys(model.ratesNanoUSD, ['input', 'cacheRead', 'cacheWrite1h', 'output'])) fail('invalid_policy', 'invalid model');
    const ratesNanoUSD = Object.create(null);
    for (const key of ['input', 'cacheRead', 'cacheWrite1h', 'output']) {
      const value = model.ratesNanoUSD[key];
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || BigInt(value) > MAX_SQLITE) fail('invalid_policy', 'invalid rate');
      ratesNanoUSD[key] = BigInt(value);
    }
    models[id] = { maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens, ratesNanoUSD };
  }
  const ceilingNano = nanos(raw.ceilingUSD);
  let allocations;
  if (raw.allocations !== undefined) {
    if (!exactKeys(raw.allocations, ['continuationUSD', 'manualReserveUSD', 'releaseWindowHours']) || !Number.isSafeInteger(raw.allocations.releaseWindowHours) || raw.allocations.releaseWindowHours < 1 || raw.allocations.releaseWindowHours > 744) fail('invalid_policy', 'invalid allocations');
    if ([raw.allocations.continuationUSD, raw.allocations.manualReserveUSD].some(value => typeof value !== 'string' || (value.split('.')[1]?.slice(9).match(/[1-9]/)))) fail('invalid_policy', 'allocation amount is subnano');
    const continuationNano = nanos(raw.allocations.continuationUSD, { allowZero: false });
    const manualReserveNano = nanos(raw.allocations.manualReserveUSD, { allowZero: false });
    if (continuationNano + manualReserveNano !== ceilingNano) fail('invalid_policy', 'allocation total differs from ceiling');
    allocations = { continuationUSD: canonicalUSD(continuationNano), manualReserveUSD: canonicalUSD(manualReserveNano), continuationNano, manualReserveNano, releaseWindowHours: raw.allocations.releaseWindowHours, releaseWindowMs: raw.allocations.releaseWindowHours * 3600000 };
  }
  let registered;
  if (allocations) {
    if (!exactKeys(registeredIdentity, ['targetID', 'providerID', 'modelID'])
      || !identifier(registeredIdentity.targetID) || !identifier(registeredIdentity.providerID)
      || !identifier(registeredIdentity.modelID) || registeredIdentity.providerID !== binding.providerID
      || !own(models, registeredIdentity.modelID)) fail('invalid_policy', 'invalid registered identity');
    registered = { targetID: registeredIdentity.targetID, providerID: registeredIdentity.providerID, modelID: registeredIdentity.modelID };
  }
  const reconcileUsage = raw.reconcileUsage === undefined ? false : raw.reconcileUsage;
  if (typeof reconcileUsage !== 'boolean') fail('invalid_policy', 'invalid reconciliation setting');
  let billingReceiptContract;
  if (raw.billingReceiptContract !== undefined) {
    if (!exactKeys(raw.billingReceiptContract, ['confirmedAt', 'reference']) || typeof raw.billingReceiptContract.reference !== 'string' || !raw.billingReceiptContract.reference) fail('invalid_policy', 'invalid receipt contract');
    timestamp(raw.billingReceiptContract.confirmedAt);
    billingReceiptContract = { confirmedAt: raw.billingReceiptContract.confirmedAt, reference: raw.billingReceiptContract.reference };
  }
  const normalized = { ledgerPath: raw.ledgerPath, policyID: raw.policyID, validUntil: raw.validUntil, validUntilMs: timestamp(raw.validUntil), ceilingUSD: canonicalUSD(ceilingNano), ceilingNano, binding, models, reconcileUsage, ...(billingReceiptContract ? { billingReceiptContract } : {}), ...(allocations ? { allocations, registeredIdentity: registered } : {}) };
  const hashable = { ...normalized, ceilingNano: ceilingNano.toString(), models: Object.fromEntries(Object.entries(models).map(([id, model]) => [id, { ...model, ratesNanoUSD: Object.fromEntries(Object.entries(model.ratesNanoUSD).map(([name, rate]) => [name, rate.toString()])) }])), ...(allocations ? { allocations: { ...allocations, continuationNano: allocations.continuationNano.toString(), manualReserveNano: allocations.manualReserveNano.toString() } } : {}), ...(registered ? { registeredIdentity: registered } : {}) };
  return deepFreeze({ ...normalized, policyHash: hash(canonical(hashable)) });
}

export function prepareSpendAttempt({ policy, providerID, targetID, url, body, headers, credentialFingerprint, now, spendGrant }) {
  if (!policy || typeof body !== 'string' || !Number.isSafeInteger(now) || now >= policy.validUntilMs) fail('unsupported_request', 'invalid or expired request');
  let parsedURL; try { parsedURL = new URL(url); } catch { fail('unsupported_request', 'invalid request URL'); }
  if (parsedURL.username || parsedURL.password || parsedURL.origin !== policy.binding.origin || parsedURL.pathname !== '/v1/messages' || parsedURL.search || parsedURL.hash) fail('unsupported_request', 'unsupported request URL');
  const pairs = canonicalHeaders(headers);
  const apiKey = pairs.find(([name]) => name === 'x-api-key')[1];
  const actualFingerprint = hash(apiKey);
  if (providerID !== policy.binding.providerID || credentialFingerprint !== actualFingerprint || actualFingerprint !== policy.binding.credentialSHA256 || !/^[a-f0-9]{64}$/.test(credentialFingerprint)) fail('unsupported_request', 'binding mismatch');
  const parsed = validateBody(body, policy);
  const model = policy.models[parsed.model];
  const maxInputRate = [model.ratesNanoUSD.input, model.ratesNanoUSD.cacheRead, model.ratesNanoUSD.cacheWrite1h].reduce((left, right) => left > right ? left : right);
  const reserveNano = BigInt(model.maxInputTokens) * maxInputRate + BigInt(parsed.max_tokens) * model.ratesNanoUSD.output;
  if (reserveNano > MAX_SQLITE) fail('unsupported_request', 'reservation exceeds SQLite range');
  const bodyDigest = hash(body);
  const digestHeaders = pairs.map(([name, value]) => [name, name === 'x-api-key' ? actualFingerprint : value]);
  let canonicalGrant;
  if (policy.allocations) {
    if (!policy.registeredIdentity || targetID !== policy.registeredIdentity.targetID) fail('invalid_authorization', 'spend authorization target mismatch');
    try { canonicalGrant = normalizeApiSpendGrant(spendGrant, { now, targetID, providerID, modelID: parsed.model }); }
    catch (error) { if (error?.code === 'invalid_authorization') throw error; fail('unsupported_request', 'invalid spend authorization'); }
    if (canonicalGrant.policyRevision !== policy.policyHash) fail('unsupported_request', 'spend authorization policy mismatch');
  }
  const requestDigest = hash(canonical({ method: 'POST', url: parsedURL.toString(), headers: digestHeaders, bodyDigest, policyHash: policy.policyHash, providerID, credentialFingerprint: actualFingerprint, ...(canonicalGrant ? { spendGrant: canonicalGrant } : {}) }));
  return deepFreeze({ policyHash: policy.policyHash, providerID, origin: parsedURL.origin, credentialFingerprint: actualFingerprint, model: parsed.model, maxInputTokens: model.maxInputTokens, maxOutputTokens: parsed.max_tokens, ratesNanoUSD: model.ratesNanoUSD, reserveNano, body, bodyDigest, requestDigest, url: parsedURL.toString(), headers: pairs, ...(canonicalGrant ? { spendGrant: canonicalGrant } : {}) });
}
