import assert from "node:assert/strict";
import test from "node:test";

import { classifyTurn, nextPrevious } from "../lib/turn-effort.js";

const defaults = {
  isSubagent: false,
  riskFloor: null,
  riskRaisedTier: false,
  previous: undefined,
};

const classifyCases = [
  ["keeps subagent briefs at their seat effort", { text: "x".repeat(2000), isSubagent: true }, "normal", "subagent-seat"],
  ...["continue", "Continue.", "go!", "  yes ", "do it", "you do it", "approve", "approved", "push", "try again", "keep going", "sounds good", "a", "1", "option b", "conitnue", "contnue"].map((text) => [
    `resumes a hard turn for go-ahead ${JSON.stringify(text)}`,
    { text, previous: "hard" }, "hard", "go-ahead", "hard",
  ]),
  ...["continue", "Continue.", "go!", "  yes ", "do it", "you do it", "approve", "approved", "push", "try again", "keep going", "sounds good", "a", "1", "option b", "conitnue", "contnue"].map((text) => [
    `uses normal for go-ahead ${JSON.stringify(text)} without history`,
    { text }, "normal", "go-ahead", "normal",
  ]),
  ...["no", "do", "n", "go fix the parser"].map((text) => [
    `does not treat ${JSON.stringify(text)} as a go-ahead`,
    { text }, "normal", "default",
  ]),
  ["recognizes explicit deep thinking", { text: "ultrathink about the cache layout" }, "hard", "explicit"],
  ["recognizes a failure report", { text: "it still failing after the patch" }, "hard", "failure"],
  ["recognizes a JavaScript stack trace", { text: "    at foo (/a/b.js:1:2)\n    at foo (/a/b.js:1:2)" }, "hard", "failure"],
  ["recognizes a Python stack trace", { text: '  File "x.py", line 3\n  File "x.py", line 3' }, "hard", "failure"],
  ["recognizes a long task", { text: "a ".repeat(501) }, "hard", "long-task"],
  ["inherits normal for a long team report", { text: `[team report from "x" (sp-implementer, task none)]\n${"a".repeat(1500)}`, previous: "normal" }, "normal", "agent-notice", "normal"],
  ["inherits hard for a team report", { text: `[team report from "x" (sp-implementer, task none)]\n${"a".repeat(1500)}`, previous: "hard" }, "hard", "agent-notice", "hard"],
  ["recognizes an unraised risk floor", { text: "hi", riskFloor: "smart" }, "hard", "risk-floor"],
  ["does not add effort when the risk floor raised the tier", { text: "hi", riskFloor: "smart", riskRaisedTier: true }, "normal", "default"],
  ...["all good?", "Status?", "what did we do so far", "did it work?"].map((text) => [
    `recognizes status question ${JSON.stringify(text)}`,
    { text }, "light", "status",
  ]),
  ["does not lower effort for a migration task", { text: "check the migration for races and fix it" }, "normal", "default"],
  ["does not lower effort for a refactoring task", { text: "summarize the auth flow, then refactor it" }, "normal", "default"],
];

for (const [name, input, expectedClass, expectedReason, resolvedFrom] of classifyCases) {
  test(name, () => {
    const result = classifyTurn({ ...defaults, ...input });
    assert.equal(result.class, expectedClass);
    assert.equal(result.reason, expectedReason);
    if (resolvedFrom === undefined) assert.equal(result.resolvedFrom, undefined);
    else assert.equal(result.resolvedFrom, resolvedFrom);
  });
}

test("keeps the previous substantive class across a light result", () => {
  assert.equal(nextPrevious("hard", { class: "light" }), "hard");
});

test("stores a hard result as the previous substantive class", () => {
  assert.equal(nextPrevious(undefined, { class: "hard" }), "hard");
});

test("replaces the previous substantive class with normal", () => {
  assert.equal(nextPrevious("hard", { class: "normal" }), "normal");
});

test("keeps the previous substantive class for a go-ahead", () => {
  assert.equal(nextPrevious("hard", { class: "hard", reason: "go-ahead" }), "hard");
});

test("recognizes trimmed case-insensitive harness notice prefixes", () => {
  for (const text of [
    "  [PEER MESSAGE abc from \"s\" ...",
    "\t[Scheduled Prompt task]",
    "\n[background job completed]",
  ]) {
    const result = classifyTurn({ ...defaults, text, previous: "normal" });
    assert.deepEqual(result, { class: "normal", reason: "agent-notice", resolvedFrom: "normal" });
  }
});

test("does not classify a human message containing a harness notice prefix as a notice", () => {
  const result = classifyTurn({
    ...defaults,
    text: "Please explain why [team report from another agent] did not arrive.",
  });
  assert.deepEqual(result, { class: "normal", reason: "default" });
});

test("keeps the previous substantive class for an agent notice", () => {
  assert.equal(nextPrevious("hard", { class: "hard", reason: "agent-notice" }), "hard");
});

test("resumes hard after an agent notice followed by a go-ahead", () => {
  let previous = "hard";
  const notice = classifyTurn({ ...defaults, text: "[team notice from x] complete", previous });
  previous = nextPrevious(previous, notice);
  const resume = classifyTurn({ ...defaults, text: "continue", previous });
  assert.deepEqual(resume, { class: "hard", reason: "go-ahead", resolvedFrom: "hard" });
});

test("keeps subagent briefs at their seat effort when they start with a harness prefix", () => {
  const result = classifyTurn({
    ...defaults,
    isSubagent: true,
    text: "[team report from x] do the task",
  });
  assert.deepEqual(result, { class: "normal", reason: "subagent-seat" });
});

test("resumes hard after a status question followed by a go-ahead", () => {
  let previous = "hard";
  const status = classifyTurn({ ...defaults, text: "all good?", previous });
  previous = nextPrevious(previous, status);
  const resume = classifyTurn({ ...defaults, text: "continue", previous });
  assert.deepEqual(resume, { class: "hard", reason: "go-ahead", resolvedFrom: "hard" });
});
