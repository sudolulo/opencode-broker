import { createSpendSSEObserver, parseMessagesReceipt } from './spend-receipt.js';

const JSON_LIMIT = 1048576;
const transportError = reason => Object.assign(new Error('paid upstream response could not be completed'),
  { code: 'unsupported_request', spendReason: reason });

// Exactly one reader, with cancellation owned by this awaited call. AbortSignal
// alone is insufficient: an injected stream (or pending reader) need not react
// to fetch cancellation. Cancel that reader as well, and never pull after abort.
async function consume({ response, controller, signal, chunk }) {
  if (!response.body?.getReader) throw transportError('missing_body');
  const reader = response.body.getReader();
  let cancellation = null;
  let cancelFailure = false;
  let primaryFailure = null;
  const cancel = () => {
    if (!cancellation) {
      try { cancellation = Promise.resolve(reader.cancel()).catch(() => { cancelFailure = true; }); }
      catch { cancelFailure = true; cancellation = Promise.resolve(); }
    }
    return cancellation;
  };
  const onAbort = () => { cancel(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw transportError('aborted');
      const item = await reader.read();
      if (signal.aborted) throw transportError('aborted');
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw transportError('invalid_chunk');
      await chunk(item.value);
    }
  } catch (error) {
    controller.abort();
    primaryFailure = transportError(error?.spendReason ?? 'body_error');
    await cancel();
    throw primaryFailure;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (signal.aborted) await cancel();
    if (cancellation) await cancellation;
    reader.releaseLock();
    if (primaryFailure && cancelFailure) primaryFailure.cleanupReason = 'cancel_failed';
    if (cancelFailure && !primaryFailure) throw transportError('cancel_failed');
  }
}

export async function collectSpendJSON({ response, controller, signal }) {
  // Fixed allocation avoids both an unbounded Response.text() and retaining
  // arbitrarily large network backing buffers via small subarray views.
  const bytes = new Uint8Array(JSON_LIMIT);
  let length = 0;
  await consume({ response, controller, signal, chunk(part) {
    if (part.byteLength > JSON_LIMIT - length) throw transportError('json_limit');
    bytes.set(part, length); length += part.byteLength;
  } });
  let rawBody;
  try { rawBody = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
  catch { throw transportError('invalid_utf8'); }
  return { rawBody, evidence: parseMessagesReceipt({ bodyText: rawBody, httpStatus: response.status }) };
}

export async function relaySpendSSE({ response, controller, signal, sink, touch }) {
  const observer = createSpendSSEObserver();
  let outputBytes = 0;
  await consume({ response, controller, signal, async chunk(part) {
    touch();
    observer.push(part);
    outputBytes += part.byteLength;
    // No tee, read-ahead or reconstructed text: Node's sink owns drain/close.
    // Even after observation fails, pass-through uses constant additional space.
    await sink.write(part);
  } });
  return { evidence: observer.finish(), outputBytes };
}
