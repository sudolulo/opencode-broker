import { createHealthProtocol, sha256 } from './proxy-health-context.js';

const isCanonical32ByteBase64url = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
  } catch { return false; }
};

const validCredentialAssertion = (value) => value === null || (typeof value === 'string' && value.startsWith('ci_') && isCanonical32ByteBase64url(value.slice(3)));

const validIssuanceTicket = (ticket, purpose, currentTime) => {
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) return false;
  if (!isCanonical32ByteBase64url(ticket.nonce) || !isCanonical32ByteBase64url(ticket.capability)) return false;
  if (!Number.isSafeInteger(ticket.startedAt) || ticket.startedAt < 0 || ticket.startedAt > currentTime) return false;
  const ttl = purpose === 'outage-health' ? 10000 : 30000;
  const expiresAt = ticket.startedAt + ttl;
  if (!Number.isSafeInteger(expiresAt) || currentTime >= expiresAt) return false;
  if (Object.hasOwn(ticket, 'generation') && (!Number.isSafeInteger(ticket.generation) || ticket.generation < 0)) return false;
  return true;
};

export function classifyHTTP(status, raw) {
  const text = String(raw).toLowerCase();
  if (/quota|credit|usage.limit|budget/.test(text)) return 'quota';
  if (status === 429 && !/overload|service.unavailable/.test(text)) return 'rate';
  if (status >= 500 || (status === 429 && /overload|service.unavailable/.test(text))) return 'service';
  if (status === 401 || status === 403) return 'auth';
  return status >= 400 ? 'validation' : null;
}

export function createTerminalParser(api) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const limit = 1048576;
  let pending = '', pendingBytes = 0, raw = '', rawBytes = 0, rawOverflow = false, failed = false, terminal = false, started = false, stop = false, chatFinish = false, carryCR = false;
  const blocks = new Set();
  // ACTUAL served speed, from the response's own usage.speed only (never the request's speed or
  // model alias). null/absent is no evidence. An unsupported value or a fast/standard conflict is
  // malformed response metadata and fails the whole parse: omitting it instead would let a
  // standard-scope request that partly reported fast still count as a clean standard success.
  let speed;
  const noteSpeed = (usage) => {
    if (!usage || typeof usage !== 'object' || !Object.hasOwn(usage, 'speed') || usage.speed === null) return true;
    if (!['fast', 'standard'].includes(usage.speed) || (speed !== undefined && speed !== usage.speed)) return false;
    speed = usage.speed;
    return true;
  };
  const fail = () => {
    failed = true;
    pending = '';
    pendingBytes = 0;
    raw = '';
    rawBytes = 0;
  };
  const appendRaw = (text) => {
    if (rawOverflow || failed) return;
    const bytes = Buffer.byteLength(text);
    if (rawBytes + bytes > limit) { raw = ''; rawBytes = 0; rawOverflow = true; return; }
    raw += text;
    rawBytes += bytes;
  };
  const frame = (block) => {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (terminal) { fail(); return; }
    if (data === '[DONE]') { if (api === 'chat' && chatFinish) terminal = true; else fail(); return; }
    let value;
    try { value = JSON.parse(data); } catch { fail(); return; }
    if (!value || typeof value !== 'object' || (event && event !== value.type) || value.error || value.type === 'error' || ['response.failed', 'response.incomplete'].includes(value.type)) { fail(); return; }
    if (api === 'messages') {
      if (value.type === 'message_start') {
        if (started || value.message?.type !== 'message' || !value.message?.id || value.message.role !== 'assistant' || !noteSpeed(value.message.usage)) fail();
        started = true;
      } else if (value.type === 'content_block_start') {
        if (!started || !Number.isInteger(value.index) || value.index < 0 || blocks.has(value.index)) fail(); else blocks.add(value.index);
      } else if (value.type === 'content_block_delta') {
        if (!started || !blocks.has(value.index)) fail();
      } else if (value.type === 'content_block_stop') {
        if (!started || !blocks.delete(value.index)) fail();
      } else if (value.type === 'message_delta') {
        if (!started || blocks.size || !noteSpeed(value.usage)) fail();
        if (['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'].includes(value.delta?.stop_reason)) stop = true;
      } else if (value.type === 'message_stop') {
        if (!started || !stop || blocks.size) fail();
        terminal = true;
      } else if (value.type !== 'ping' || !started) fail();
    } else if (api === 'responses') {
      if (value.type === 'response.completed') {
        if (!value.response?.id || value.response.object !== 'response' || value.response.status !== 'completed' || !Array.isArray(value.response.output)) fail();
        terminal = true;
      } else if (typeof value.type !== 'string' || !value.type.startsWith('response.')) fail();
    } else {
      if (!Array.isArray(value.choices) || !noteSpeed(value.usage)) { fail(); return; }
      for (const choice of value.choices) if (choice.index === 0 && ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(choice.finish_reason)) chatFinish = true;
    }
  };
  const appendPending = (text) => {
    if (failed || text.length === 0) return;
    const bytes = Buffer.byteLength(text);
    if (pendingBytes + bytes > limit) { fail(); return; }
    pending += text;
    pendingBytes += bytes;
    let end;
    while (!failed && (end = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, end);
      pending = pending.slice(end + 2);
      pendingBytes = Buffer.byteLength(pending);
      frame(block);
    }
  };
  const consumeText = (text) => {
    if (failed) return;
    if (carryCR) {
      carryCR = false;
      if (text.startsWith('\n')) text = text.slice(1);
      appendPending('\n');
    }
    const trailingCR = text.endsWith('\r');
    if (trailingCR) text = text.slice(0, -1);
    appendPending(text.replace(/\r\n/g, '\n'));
    carryCR = trailingCR;
  };
  const consumeString = (text) => {
    for (let offset = 0; offset < text.length && !failed; offset += 65536) {
      const part = text.slice(offset, offset + 65536);
      appendRaw(part);
      consumeText(part);
    }
  };
  return {
    push(chunk) {
      try {
        if (typeof chunk === 'string') consumeString(chunk);
        else for (let offset = 0; offset < chunk.length && !failed; offset += 65536) consumeString(decoder.decode(chunk.subarray(offset, offset + 65536), { stream: true }));
      } catch { fail(); }
    },
    finish({ status, contentType, cancelled = false, networkError = false }) {
      if (cancelled) return { api, state: 'cancelled', status, errorClass: null };
      if (networkError) return { api, state: 'invalid', status, errorClass: 'network' };
      if (status >= 400) return { api, state: 'http-error', status, errorClass: classifyHTTP(status, raw) };
      try { consumeString(decoder.decode()); if (carryCR) { carryCR = false; appendPending('\n'); } } catch { fail(); }
      let complete = false;
      if (String(contentType).includes('text/event-stream')) complete = !failed && terminal && pending.trim() === '';
      else if (String(contentType).includes('application/json') && !rawOverflow) {
        try {
          const value = JSON.parse(raw);
          complete = !value.error && (api === 'messages'
            ? value.type === 'message' && typeof value.id === 'string' && value.role === 'assistant' && Array.isArray(value.content) && ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use'].includes(value.stop_reason)
            : api === 'responses' ? value.object === 'response' && typeof value.id === 'string' && value.status === 'completed' && Array.isArray(value.output)
              : Array.isArray(value.choices) && value.choices.length > 0 && value.choices.every((choice) => choice.message && ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(choice.finish_reason)));
          if (complete && api !== 'responses' && !noteSpeed(value.usage)) complete = false;
        } catch { complete = false; }
      }
      // The speed key exists only on a complete terminal with consistent evidence, so every
      // speed-less terminal keeps its exact legacy four-key shape.
      return { api, state: complete ? 'complete' : 'invalid', status, errorClass: complete ? null : 'validation',
        ...(complete && speed !== undefined ? { speed } : {}) };
    },
  };
}

export function createGatewayHealth({ key, gatewayCredential, brokerRequest, now = Date.now, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const protocol = createHealthProtocol({ key, now });
  // Header objects may be mutable test doubles or be backed by a stream adapter. Capture both
  // authenticated wire strings synchronously at fetch return, before any body consumer runs.
  const capturedResponses = new WeakMap();
  const captureResponse = (attempt, responseHeaders) => {
    if (!attempt) return null;
    if (capturedResponses.has(attempt)) return capturedResponses.get(attempt)?.tuple ?? null;
    const attestation = responseHeaders?.get?.('x-fleet-health-attestation');
    const attestationSignature = responseHeaders?.get?.('x-fleet-health-attestation-signature');
    let captured = null;
    try {
      const tuple = protocol.verifyResponse(attestation, attestationSignature, attempt.request, attempt.context);
      captured = { tuple: Object.freeze(tuple), attestation, attestationSignature };
    } catch { /* Invalid evidence must remain invalid for this attempt. */ }
    capturedResponses.set(attempt, captured);
    return captured?.tuple ?? null;
  };
  return {
    async begin({ leased, requestID, attemptID, purpose, bodyText, api }) {
      const expectedCredentialInstance = leased.expectedCredentialInstance ?? null;
      if (!['real', 'outage-health'].includes(purpose) || !validCredentialAssertion(expectedCredentialInstance) || (purpose === 'outage-health' && expectedCredentialInstance === null)) return null;
      const finalBody = JSON.parse(bodyText);
      const modelID = finalBody.model;
      // The gateway's trusted assertion of the FINAL body's speed, bound to it by bodySHA256. Only
      // Messages and the Anthropic chat-compat body define the field. An unsupported value refuses
      // admission rather than being read as standard; an absent one sends no key at all.
      let speed;
      if ((api === 'messages' || api === 'chat') && Object.hasOwn(finalBody, 'speed')) {
        if (!['fast', 'standard'].includes(finalBody.speed)) return null;
        speed = finalBody.speed;
      }
      const ticket = await brokerRequest('/model-health/begin', { gatewayCredential, sessionID: leased.sessionID, leaseID: leased.leaseID, requestID, attemptID, purpose, modelID, bodySHA256: sha256(bodyText), ...(speed === undefined ? {} : { speed }) });
      const currentTime = now();
      if (!validIssuanceTicket(ticket, purpose, currentTime)) return null;
      const ttl = purpose === 'outage-health' ? 10000 : 30000;
      const request = [1, ticket.nonce, ticket.startedAt, ticket.startedAt + ttl, requestID, attemptID, purpose, leased.providerID, modelID, sha256(bodyText), expectedCredentialInstance];
      const signed = protocol.signRequest(request);
      return { ticket, request, ...signed, leased, api, headers: { 'x-fleet-health-context': signed.context, 'x-fleet-health-signature': signed.contextSignature } };
    },
    captureResponse,
    async finish(attempt, { responseHeaders, terminal, finishedAt }) {
      if (!attempt) return null;
      let captured;
      if (capturedResponses.has(attempt)) {
        captured = capturedResponses.get(attempt);
        if (!captured) return null;
      } else {
        const attestation = responseHeaders?.get?.('x-fleet-health-attestation');
        const attestationSignature = responseHeaders?.get?.('x-fleet-health-attestation-signature');
        try {
          captured = { tuple: protocol.verifyResponse(attestation, attestationSignature, attempt.request, attempt.context), attestation, attestationSignature };
        } catch { return null; }
      }
      const { attestation, attestationSignature } = captured;
      const report = { gatewayCredential, capability: attempt.ticket.capability, context: attempt.context, contextSignature: attempt.contextSignature, attestation, attestationSignature, terminal, finishedAt };
      const started = now();
      const deadline = Date.now() + 1000;
      const awaitBeforeDeadline = (promise) => new Promise((resolve) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { resolve({ timedOut: true }); return; }
        const timer = setTimeout(() => resolve({ timedOut: true }), remaining);
        Promise.resolve(promise).then((value) => resolve({ value }), (error) => resolve({ error })).finally(() => clearTimeout(timer));
      });
      for (let delivery = 0; delivery < 2; delivery += 1) {
        const outcome = await awaitBeforeDeadline(brokerRequest('/model-health/outcome', report));
        if ('value' in outcome) return outcome.value;
        if (outcome.timedOut || delivery === 1 || now() - started >= 900 || Date.now() >= deadline) return null;
        const pause = await awaitBeforeDeadline(sleepImpl(100));
        if (pause.timedOut || 'error' in pause || now() - started >= 1000 || Date.now() >= deadline) return null;
      }
      return null;
    },
  };
}
