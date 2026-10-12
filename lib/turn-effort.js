export const TURN_CLASSES = ["normal", "light", "hard"];

export const TURN_REASONS = new Set([
  "subagent-seat",
  "go-ahead",
  "risk-floor",
  "explicit",
  "failure",
  "long-task",
  "status",
  "default",
  "classifier-error",
  "absent",
]);

const GO_AHEADS = new Set([
  "continue",
  "go",
  "go on",
  "go ahead",
  "yes",
  "y",
  "ok",
  "okay",
  "do it",
  "you do it",
  "approve",
  "approved",
  "push",
  "try again",
  "proceed",
  "keep going",
  "sounds good",
]);

const OPTION = /^(option )?[a-mo-z0-9]$/;
const EXPLICIT_SIGNALS = ["ultrathink", "ultra-think", "think harder", "think deeply", "go deep"];
const FAILURE_SIGNALS = ["still failing", "didn't work", "doesn't work", "same error", "still broken"];
const STATUS_PREFIXES = [
  "all good",
  "status",
  "what did we do",
  "where are we",
  "is it done",
  "did it work",
  "any update",
  "check status",
];

const normalize = (text) => String(text ?? "")
  .trim()
  .toLowerCase()
  .replace(/\s+/g, " ")
  .replace(/[.!?,]+$/, "");

const damerauLevenshteinAtMostOne = (left, right) => {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;

  let mismatches = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    mismatches += 1;
    if (mismatches > 1) return false;

    if (left[leftIndex + 1] === right[rightIndex] && left.length > right.length) {
      leftIndex += 1;
    } else if (left[leftIndex] === right[rightIndex + 1] && right.length > left.length) {
      rightIndex += 1;
    } else if (left[leftIndex] === right[rightIndex + 1]
      && left[leftIndex + 1] === right[rightIndex]) {
      leftIndex += 2;
      rightIndex += 2;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return true;
};

const isGoAhead = (text) => GO_AHEADS.has(text)
  || OPTION.test(text)
  || [...GO_AHEADS].some((goAhead) => goAhead.length >= 5
    && damerauLevenshteinAtMostOne(text, goAhead));

const countTraceLines = (text, pattern) => (text.match(pattern) ?? []).length;

export function classifyTurn({ text, isSubagent, riskFloor, riskRaisedTier, previous }) {
  const sourceText = String(text ?? "");
  const normalized = normalize(text);

  if (isSubagent) return { class: "normal", reason: "subagent-seat" };
  if (isGoAhead(normalized)) {
    const resolvedFrom = previous === "hard" ? "hard" : "normal";
    return { class: resolvedFrom, reason: "go-ahead", resolvedFrom };
  }
  if (riskFloor && !riskRaisedTier) return { class: "hard", reason: "risk-floor" };
  if (EXPLICIT_SIGNALS.some((signal) => normalized.includes(signal))) {
    return { class: "hard", reason: "explicit" };
  }
  if (FAILURE_SIGNALS.some((signal) => normalized.includes(signal))
    || countTraceLines(sourceText, /^\s*at .+\(.+:\d+:\d+\)\s*$/gm) >= 2
    || countTraceLines(sourceText, /^\s*File ".+", line \d+/gm) >= 2) {
    return { class: "hard", reason: "failure" };
  }
  if (normalized.length > 1000) return { class: "hard", reason: "long-task" };
  if (normalized.length <= 200 && STATUS_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return { class: "light", reason: "status" };
  }
  return { class: "normal", reason: "default" };
}

export function nextPrevious(previous, result) {
  if (result.reason === "go-ahead" || result.class === "light") return previous;
  return result.class;
}
