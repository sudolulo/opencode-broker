// Detect a provider CONTENT-FILTER block in an upstream reply, across the three
// wire shapes the gateway proxies (chat, Anthropic messages, OpenAI responses).
//
// A content-filter block is a HEALTHY model declining ONE query on policy
// grounds. It is deliberately NOT any of the failure classes the gateway already
// handles -- not a transport fault, not a usage limit, not an outage -- and it is
// the ONLY signal that drives the content-filter cascade (the broker's
// lib/content-filter-cascade.js). Keeping the predicate here, pure and separate,
// is what lets the cascade advance on a block and nothing else (the operator's
// rule: other errors keep using the ordinary failover).
//
// Everything here reads already-parsed data or matches an error-body string; it
// mutates nothing and relays nothing. `apiName` is the gateway api discriminator
// ("chat" | "responses" | "messages").

// chat finish_reason and the OpenAI Responses incomplete reason both spell it
// "content_filter"; Anthropic Messages spells the same thing "refusal" (and the
// llm-auth-proxy's responses adapter maps that refusal back to "content_filter").
export const CONTENT_FILTER_REASONS = Object.freeze(["content_filter", "refusal"]);

// Error-body phrasings that mean a provider content/safety policy blocked the
// request. Scoped to a policy/filter keyword so an ordinary 400 (bad field, too
// long, etc.) is never misread as a filter block.
const CONTENT_FILTER_MESSAGE = /content[_ -]?filter|content management policy|responsible[_ -]?ai[_ -]?polic|content[_ -]?polic|safety (?:polic|system|filter)|output (?:was )?blocked|blocked by (?:the )?.{0,20}polic|flagged by .{0,20}polic/i;
const CONTENT_FILTER_TYPE = /content[_-]?filter|content[_-]?polic|invalid[_-]?prompt/i;

const isObject = (v) => v !== null && typeof v === "object";

// A SUCCESSFUL (2xx) parsed reply that is actually a policy refusal. Returns the
// reason string ("content_filter" | "refusal") or null.
export function replyContentFilter(apiName, payload) {
  if (!isObject(payload)) return null;
  if (apiName === "messages") {
    return payload.stop_reason === "refusal" ? "refusal" : null;
  }
  if (apiName === "responses") {
    if (payload.status === "incomplete" && payload.incomplete_details?.reason === "content_filter") {
      return "content_filter";
    }
    // A refusal surfaced as an output item/content part rather than a status.
    if (Array.isArray(payload.output) && payload.output.some((item) =>
      item?.type === "refusal"
      || (Array.isArray(item?.content) && item.content.some((part) => part?.type === "refusal")))) {
      return "refusal";
    }
    return null;
  }
  // chat
  if (Array.isArray(payload.choices) && payload.choices.some((choice) =>
    choice?.finish_reason === "content_filter"
    || choice?.message?.refusal != null)) {
    return "content_filter";
  }
  return null;
}

// The terminal reason an assembled/streamed reply ended on (chat finish_reason,
// responses incomplete reason, or Anthropic stop_reason), if it is a block.
export function terminalContentFilter(reason) {
  return typeof reason === "string" && CONTENT_FILTER_REASONS.includes(reason) ? reason : null;
}

// A non-2xx upstream ERROR body that is a policy/content block (some providers
// reject a prompt outright with 400/422 rather than returning a refusal reply).
// `body` is the raw error text; returns "content_filter" or null.
export function errorContentFilter(status, body) {
  if (typeof body !== "string" || body.length === 0 || body.length > 16384) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const error = isObject(parsed?.error) ? parsed.error : parsed;
  const type = String(error?.type ?? error?.code ?? "");
  const message = String(error?.message ?? "");
  if (type && CONTENT_FILTER_TYPE.test(type)) return "content_filter";
  if (message && CONTENT_FILTER_MESSAGE.test(message)) return "content_filter";
  return null;
}
