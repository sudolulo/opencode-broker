export const TURN_CLASSES = ["normal", "light", "hard"];

export const TURN_REASONS = new Set([
  "subagent-seat",
  "agent-notice",
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

export const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

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
// Harness-injected notices from other agents, not the human.
const AGENT_NOTICE_PREFIXES = [
  "[team report from ",
  "[team idle from ",
  "[team notice from ",
  "[team message",
  "[peer message ",
  "[scheduled prompt ",
  "[background job ",
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
  const trimmedSourceText = sourceText.trim();
  const normalized = normalize(text);

  if (isSubagent) return { class: "normal", reason: "subagent-seat" };
  if (AGENT_NOTICE_PREFIXES.some((prefix) => trimmedSourceText.toLowerCase().startsWith(prefix))) {
    const resolvedFrom = previous === "hard" ? "hard" : "normal";
    return { class: resolvedFrom, reason: "agent-notice", resolvedFrom };
  }
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
  if (["agent-notice", "go-ahead"].includes(result.reason) || result.class === "light") return previous;
  return result.class;
}

const rankOf = (effort) => EFFORT_RANK.indexOf(effort);

const usableEfforts = (advertised, ceiling) => {
  const ceilingRank = rankOf(ceiling);
  return [...new Set(advertised)]
    .filter((effort) => rankOf(effort) >= 0 && (ceilingRank < 0 || rankOf(effort) <= ceilingRank))
    .sort((left, right) => rankOf(left) - rankOf(right));
};

const stepEffort = (effort, direction, efforts, minimum) => {
  const allowed = minimum === undefined
    ? efforts
    : efforts.filter((candidate) => rankOf(candidate) >= rankOf(minimum));
  const index = allowed.indexOf(effort);

  if (index < 0) {
    if (direction < 0 && allowed.length > 0 && rankOf(effort) < rankOf(minimum)) {
      return { effort: allowed[0], clamped: true };
    }
    return { effort, clamped: true };
  }

  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= allowed.length) return { effort, clamped: true };
  return { effort: allowed[nextIndex], clamped: false };
};

const classStep = (turnClass) => ({ normal: 0, light: -1, hard: 1 }[turnClass]);

export function canaryHalf(sessionID) {
  let hash = 0x811c9dc5;
  const value = String(sessionID ?? "");
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 2;
}

export function resolveTurnEffort({
  baseVariant,
  advertised = [],
  ceiling,
  turnClass,
  engineEffortUpdates,
  modelKey,
  sessionID,
  config,
}) {
  const efforts = usableEfforts(Array.isArray(advertised) ? advertised : [], ceiling);
  const validClass = TURN_CLASSES.includes(turnClass?.class) && TURN_REASONS.has(turnClass?.reason);
  const eligible = baseVariant !== undefined
    && validClass
    && !["subagent-seat", "absent", "classifier-error"].includes(turnClass.reason)
    && engineEffortUpdates === true
    && config?.models?.includes(modelKey)
    && config?.mode !== "off";

  if (baseVariant === undefined) {
    return {
      eligible: false,
      base: undefined,
      policies: { tier: undefined, savings: undefined },
      applied: undefined,
      clamped: false,
    };
  }

  if (!validClass || efforts.length === 0 || !efforts.includes(baseVariant)) {
    return {
      eligible: false,
      base: baseVariant,
      policies: { tier: baseVariant, savings: baseVariant },
      applied: baseVariant,
      clamped: efforts.length > 0 && !efforts.includes(baseVariant),
    };
  }

  const step = classStep(turnClass.class);
  const savingsBase = stepEffort(baseVariant, -1, efforts);
  const tier = step === 0
    ? { effort: baseVariant, clamped: false }
    : stepEffort(baseVariant, step, efforts, step < 0 ? "low" : undefined);
  const savings = step === 0
    ? { effort: savingsBase.effort, clamped: false }
    : stepEffort(savingsBase.effort, step, efforts, step < 0 ? "low" : undefined);
  const policies = { tier: tier.effort, savings: savings.effort };
  const applies = eligible && (config.mode === "enforce"
    || (config.mode === "canary" && canaryHalf(sessionID) === 0));

  return {
    eligible,
    base: baseVariant,
    policies,
    applied: applies ? policies[config.policy] : baseVariant,
    clamped: savingsBase.clamped || tier.clamped || savings.clamped,
  };
}
