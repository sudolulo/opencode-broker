import assert from "node:assert/strict";
import test from "node:test";

import {
  replyContentFilter,
  terminalContentFilter,
  errorContentFilter,
  CONTENT_FILTER_REASONS,
} from "../lib/content-filter.js";

test("Anthropic messages reply: stop_reason refusal is a block, end_turn is not", () => {
  assert.equal(replyContentFilter("messages", { stop_reason: "refusal", content: [] }), "refusal");
  assert.equal(replyContentFilter("messages", { stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] }), null);
  assert.equal(replyContentFilter("messages", { stop_reason: "tool_use" }), null);
});

test("OpenAI responses reply: incomplete/content_filter and refusal output items are blocks", () => {
  assert.equal(replyContentFilter("responses", { status: "incomplete", incomplete_details: { reason: "content_filter" } }), "content_filter");
  assert.equal(replyContentFilter("responses", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), null);
  assert.equal(replyContentFilter("responses", { status: "completed", output: [{ type: "refusal", refusal: "no" }] }), "refusal");
  assert.equal(replyContentFilter("responses", { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), null);
});

test("chat reply: finish_reason content_filter or a message.refusal is a block", () => {
  assert.equal(replyContentFilter("chat", { choices: [{ finish_reason: "content_filter" }] }), "content_filter");
  assert.equal(replyContentFilter("chat", { choices: [{ finish_reason: "stop", message: { refusal: "I can't help with that" } }] }), "content_filter");
  assert.equal(replyContentFilter("chat", { choices: [{ finish_reason: "stop", message: { content: "fine" } }] }), null);
  assert.equal(replyContentFilter("chat", { choices: [{ finish_reason: "length" }] }), null);
});

test("junk payloads never throw and are not blocks", () => {
  assert.equal(replyContentFilter("chat", null), null);
  assert.equal(replyContentFilter("messages", "nope"), null);
  assert.equal(replyContentFilter("responses", 7), null);
});

test("terminalContentFilter accepts only the two block reasons", () => {
  assert.equal(terminalContentFilter("content_filter"), "content_filter");
  assert.equal(terminalContentFilter("refusal"), "refusal");
  assert.equal(terminalContentFilter("stop"), null);
  assert.equal(terminalContentFilter("end_turn"), null);
  assert.equal(terminalContentFilter(undefined), null);
  assert.deepEqual([...CONTENT_FILTER_REASONS].sort(), ["content_filter", "refusal"]);
});

test("error bodies: policy blocks match, ordinary 400s do not", () => {
  assert.equal(errorContentFilter(400, JSON.stringify({ error: { type: "content_filter", message: "blocked" } })), "content_filter");
  assert.equal(errorContentFilter(400, JSON.stringify({ error: { type: "invalid_request_error", message: "Output blocked by content filtering policy" } })), "content_filter");
  assert.equal(errorContentFilter(422, JSON.stringify({ error: { code: "content_policy_violation", message: "nope" } })), "content_filter");
  assert.equal(errorContentFilter(400, JSON.stringify({ error: { type: "invalid_request_error", message: "max_tokens: must be >= 1" } })), null);
  assert.equal(errorContentFilter(400, JSON.stringify({ error: { type: "invalid_request_error", message: "prompt is too long: 1600000 tokens" } })), null);
  assert.equal(errorContentFilter(429, JSON.stringify({ error: { message: "usage limit reached" } })), null);
});

test("error bodies: non-JSON, oversized, or empty are ignored", () => {
  assert.equal(errorContentFilter(500, "Bad Gateway"), null);
  assert.equal(errorContentFilter(400, ""), null);
  assert.equal(errorContentFilter(400, "x".repeat(20000)), null);
});
