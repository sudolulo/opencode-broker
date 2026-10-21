import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']);
const USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const BREAKDOWN_KEYS = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'];
const SERVER_TOOL_KEYS = ['web_search_requests', 'web_fetch_requests'];

// Documented Messages usage metadata is price-affecting (priority/batch tier,
// regional US inference, fast speed, server tool charges), so it is accepted only
// in its closed, neutral form. Missing and null are both accepted because the
// schema does not distinguish them; anything else keeps the receipt incomplete
// (full hold retained, never a refund). The four token counters are NEVER part of
// this allowance: they must be present safe integers and are never zero-filled.
//   - code_execution_requests is deliberately NOT accepted, even as 0: the pricing
//     example shows it but the API reference does not, so its contract is unbounded.
//   - Beta `iterations` is not in the main schema; only null/[] are accepted. A
//     nonempty list would need per-iteration billing, which is not modelled, and
//     billing only the final iteration would undercount.
//   - output_tokens_details.thinking_tokens is INCLUSIVE in output_tokens; it is
//     bounded by output_tokens and never charged a second time.
const NEUTRAL_METADATA = {
  service_tier: value => value === null || value === 'standard',
  inference_geo: value => value === null || value === 'global',
  speed: value => value === null || value === 'standard',
  server_tool_use: value => value === null || (plain(value) && Object.keys(value).length === SERVER_TOOL_KEYS.length
    && SERVER_TOOL_KEYS.every(key => own(value, key) && value[key] === 0)),
  iterations: value => value === null || (Array.isArray(value) && value.length === 0),
  // Checked against the (cumulative) output count separately; shape only here.
  output_tokens_details: value => value === null || (plain(value) && Object.keys(value).length === 1 && own(value, 'thinking_tokens')
    && (value.thinking_tokens === null || safeCount(value.thinking_tokens))),
};
const metadataNeutral = (usage, outputTokens) => Object.entries(usage).every(([key, value]) => {
  if (USAGE_KEYS.includes(key) || key === 'cache_creation') return true;
  if (!own(NEUTRAL_METADATA, key) || !NEUTRAL_METADATA[key](value)) return false;
  return key !== 'output_tokens_details' || value === null || value.thinking_tokens === null || value.thinking_tokens <= outputTokens;
});

const fail = () => { const error = new Error('invalid receipt'); error.code = 'invalid_receipt'; throw error; };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const own = (object, key) => Object.hasOwn(object, key);
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const incomplete = (kind, errorCode = null) => Object.freeze({ kind, complete: false, messageID: null, model: null, usage: null, cacheCreationBreakdown: null, initialOutputTokens: null, errorCode });

function cloneFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFreeze));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneFreeze(item)])));
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

function usageOf(value) {
  if (!plain(value) || Object.keys(value).some(key => !USAGE_KEYS.includes(key) && key !== 'cache_creation') || !USAGE_KEYS.every(key => safeCount(value[key]))) return null;
  return Object.fromEntries(USAGE_KEYS.map(key => [key, value[key]]));
}

// Provider wire usage (JSON message or message_start): all four counters required,
// neutral metadata validated and then dropped, so canonical evidence is unchanged.
function wireUsageOf(value) {
  if (!plain(value) || !USAGE_KEYS.every(key => safeCount(value[key])) || !metadataNeutral(value, value.output_tokens)) return null;
  return Object.fromEntries(USAGE_KEYS.map(key => [key, value[key]]));
}

function breakdownOf(value) {
  if (value === undefined || value === null) return null;
  if (!plain(value) || Object.keys(value).some(key => !BREAKDOWN_KEYS.includes(key)) || !BREAKDOWN_KEYS.every(key => safeCount(value[key]))) return undefined;
  return Object.fromEntries(BREAKDOWN_KEYS.map(key => [key, value[key]]));
}

function completeMessage(message) {
  if (!plain(message) || message.type !== 'message' || message.role !== 'assistant' || typeof message.id !== 'string' || !message.id || typeof message.model !== 'string' || !message.model || !Array.isArray(message.content) || !STOP_REASONS.has(message.stop_reason)) return null;
  // An empty content array is a valid completed response (e.g. end_turn with no text).
  const usage = wireUsageOf(message.usage);
  const breakdown = breakdownOf(message.usage?.cache_creation);
  if (!usage || breakdown === undefined) return null;
  return { messageID: message.id, model: message.model, usage, cacheCreationBreakdown: breakdown };
}

export function parseMessagesReceipt({ bodyText, httpStatus }) {
  if (!Number.isSafeInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300 || typeof bodyText !== 'string' || Buffer.byteLength(bodyText) > 1048576) return incomplete('json', 'http_or_size');
  let message;
  try { if (hasDuplicateObjectKey(bodyText)) return incomplete('json', 'duplicate_field'); message = JSON.parse(bodyText); } catch { return incomplete('json', 'malformed_json'); }
  const parsed = completeMessage(message);
  return parsed ? cloneFreeze({ kind: 'json', complete: true, ...parsed, initialOutputTokens: null, errorCode: null }) : incomplete('json');
}

function parseEvent(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return null; }
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let event = null; const data = [];
  for (const line of lines) {
    if (line.startsWith('event:')) { if (event !== null) return null; event = line.slice(6).trim(); }
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    else if (line !== '' && !line.startsWith(':')) return null;
  }
  if (!event || data.length !== 1) return null;
  const source = data[0];
  try { if (hasDuplicateObjectKey(source)) return null; const value = JSON.parse(source); return plain(value) && value.type === event ? { event, value } : null; } catch { return null; }
}

export function createSpendSSEObserver({ maxEventBytes = 65536 } = {}) {
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) throw new RangeError('maxEventBytes must be positive');
  let bytes = [];
  let failed = false;
  let finished = false;
  let result;
  let seenStart = false;
  let seenStop = false;
  let messageID = null;
  let model = null;
  let usage = null;
  let breakdown = null;
  let initialOutputTokens = null;
  let terminalStopReason = null;
  let previousByte = null;

  const failState = () => { failed = true; bytes = []; };
  const updateCumulative = next => {
    // Deltas may omit individual counters (cumulative snapshots), but a present
    // counter must be a nondecreasing safe integer. Every other key must be
    // closed neutral metadata, checked against the RESULTING cumulative output.
    for (const key of USAGE_KEYS) if (own(next, key)) {
      if (!safeCount(next[key]) || next[key] < usage[key]) return false;
      usage[key] = next[key];
    }
    if (!metadataNeutral(next, usage.output_tokens)) return false;
    const nextBreakdown = breakdownOf(next.cache_creation);
    if (nextBreakdown === undefined) return false;
    if (nextBreakdown !== null) {
      if (breakdown !== null && (nextBreakdown.ephemeral_5m_input_tokens < breakdown.ephemeral_5m_input_tokens || nextBreakdown.ephemeral_1h_input_tokens < breakdown.ephemeral_1h_input_tokens)) return false;
      if (nextBreakdown.ephemeral_5m_input_tokens + nextBreakdown.ephemeral_1h_input_tokens !== usage.cache_creation_input_tokens) return false;
      breakdown = nextBreakdown;
    }
    return true;
  };
  const accept = eventBytes => {
    const parsed = parseEvent(eventBytes);
    if (!parsed) return failState();
    const { event, value } = parsed;
    if (event === 'error') return failState();
    if (event === 'ping') return;
    if (event === 'message_start') {
      const message = value.message;
      if (Object.keys(value).some(key => !['type', 'message'].includes(key)) || seenStart || seenStop || !plain(message) || message.type !== 'message' || message.role !== 'assistant' || typeof message.id !== 'string' || !message.id || typeof message.model !== 'string' || !message.model || !Array.isArray(message.content) || message.stop_reason !== null) return failState();
      const initialUsage = wireUsageOf(message.usage); const initialBreakdown = breakdownOf(message.usage?.cache_creation);
      if (!initialUsage || initialBreakdown === undefined || (initialBreakdown !== null && initialBreakdown.ephemeral_5m_input_tokens + initialBreakdown.ephemeral_1h_input_tokens !== initialUsage.cache_creation_input_tokens)) return failState();
      seenStart = true; messageID = message.id; model = message.model; usage = initialUsage; breakdown = initialBreakdown; initialOutputTokens = initialUsage.output_tokens;
      return;
    }
    if (!seenStart || seenStop) return failState();
    if (event === 'message_delta') {
      if (Object.keys(value).some(key => !['type', 'delta', 'usage'].includes(key)) || !plain(value.delta) || !own(value, 'usage') || !plain(value.usage) || !updateCumulative(value.usage)) return failState();
      if (value.delta.stop_reason !== undefined) {
        if (value.delta.stop_reason !== null && !STOP_REASONS.has(value.delta.stop_reason)) return failState();
        terminalStopReason = value.delta.stop_reason;
      }
      return;
    }
    if (event === 'content_block_delta' || event === 'content_block_start' || event === 'content_block_stop') return;
    if (event === 'message_stop') {
      if (Object.keys(value).some(key => key !== 'type') || seenStop || terminalStopReason === null) return failState();
      seenStop = true;
      return;
    }
    failState();
  };
  const endEvent = () => {
    const eventBytes = bytes;
    bytes = [];
    previousByte = null;
    if (eventBytes.length === 0 || failed) return;
    // Strip the event separator, including CRLF before its final newline.
    while (eventBytes.at(-1) === 10 || eventBytes.at(-1) === 13) eventBytes.pop();
    accept(eventBytes);
  };
  return {
    push(chunk) {
      if (finished) { failed = true; result = incomplete('sse', 'push_after_finish'); return; }
      if (failed || !(chunk instanceof Uint8Array)) return failState();
      for (const byte of chunk) {
        bytes.push(byte);
        if (bytes.length > maxEventBytes) { failState(); return; }
        if (byte === 10 && previousByte === 10) endEvent();
        else if (byte === 10 && previousByte === 13 && bytes.length >= 4 && bytes.at(-3) === 10 && bytes.at(-4) === 13) endEvent();
        else previousByte = byte;
      }
    },
    finish() {
      if (!finished) {
        finished = true;
        if (bytes.length !== 0 || failed || !seenStart || !seenStop || terminalStopReason === null) result = incomplete('sse', failed ? 'invalid_stream' : 'incomplete_stream');
        else result = cloneFreeze({ kind: 'sse', complete: true, messageID, model, usage, cacheCreationBreakdown: breakdown, initialOutputTokens, errorCode: null });
      }
      return result;
    },
    snapshot() { return { bufferedBytes: bytes.length, failed }; },
  };
}

export function validateSpendReceipt({ attempt, evidence }) {
  if (!plain(attempt) || !plain(evidence) || !['json', 'sse'].includes(evidence.kind) || evidence.complete !== true || typeof evidence.messageID !== 'string' || !evidence.messageID || typeof evidence.model !== 'string' || !evidence.model || evidence.model !== attempt.model || evidence.errorCode !== null || !safeCount(evidence.initialOutputTokens ?? 0)) fail();
  const usage = usageOf(evidence.usage);
  if (!usage || (evidence.initialOutputTokens !== null && usage.output_tokens < evidence.initialOutputTokens)) fail();
  const breakdown = breakdownOf(evidence.cacheCreationBreakdown);
  if (breakdown === undefined || (breakdown !== null && BigInt(breakdown.ephemeral_5m_input_tokens) + BigInt(breakdown.ephemeral_1h_input_tokens) !== BigInt(usage.cache_creation_input_tokens))) fail();
  const rates = attempt.ratesNanoUSD;
  if (typeof attempt.attemptID !== 'string' || !attempt.attemptID || typeof attempt.epochID !== 'string' || !attempt.epochID || typeof attempt.requestDigest !== 'string' || !attempt.requestDigest || typeof attempt.policyHash !== 'string' || !attempt.policyHash || !Number.isSafeInteger(attempt.maxInputTokens) || attempt.maxInputTokens < 0 || !Number.isSafeInteger(attempt.maxOutputTokens) || attempt.maxOutputTokens < 0 || !plain(rates) || !['input', 'cacheRead', 'cacheWrite1h', 'output'].every(key => typeof rates[key] === 'bigint' && rates[key] > 0n) || typeof attempt.reserveNano !== 'bigint' || attempt.reserveNano < 0n) fail();
  const actualCostNano = BigInt(usage.input_tokens) * rates.input + BigInt(usage.cache_read_input_tokens) * rates.cacheRead + BigInt(usage.cache_creation_input_tokens) * rates.cacheWrite1h + BigInt(usage.output_tokens) * rates.output;
  const inputTokens = BigInt(usage.input_tokens) + BigInt(usage.cache_creation_input_tokens) + BigInt(usage.cache_read_input_tokens);
  const boundsViolated = inputTokens > BigInt(attempt.maxInputTokens) || BigInt(usage.output_tokens) > BigInt(attempt.maxOutputTokens);
  const additionalLiabilityNano = actualCostNano > attempt.reserveNano ? actualCostNano - attempt.reserveNano : 0n;
  const evidenceCopy = cloneFreeze({ kind: evidence.kind, complete: true, messageID: evidence.messageID, model: evidence.model, usage, cacheCreationBreakdown: breakdown, initialOutputTokens: evidence.initialOutputTokens, errorCode: null });
  const receiptHash = hash(canonical({ attemptID: attempt.attemptID, epochID: attempt.epochID, requestDigest: attempt.requestDigest, policyHash: attempt.policyHash, evidence: evidenceCopy }));
  return cloneFreeze({ attemptID: attempt.attemptID, epochID: attempt.epochID, requestDigest: attempt.requestDigest, policyHash: attempt.policyHash, receiptHash, messageID: evidenceCopy.messageID, model: evidenceCopy.model, usage: evidenceCopy.usage, complete: true, actualCostNano, boundsViolated, additionalLiabilityNano, evidence: evidenceCopy });
}
