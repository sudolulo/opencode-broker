// Compaction guard: local, plugin-side protection against three defects that
// lined up on 2026-09-21 and burned ~8% of the anthropic plan in five minutes.
// None of them is in this repo, and the opencode fork is meant to go away, so
// the guard works entirely through stock hooks and stock HTTP routes.
//
// 1. opencode processes a compaction task with `parentID: lastUser.id`. When a
//    compaction is queued, the turn dies, and a LATER prompt resumes it, the
//    summary hangs off that later prompt. filterCompacted only honours a summary
//    whose parent carries the compaction part, so the summary is invisible and
//    the next turn re-sends the whole pre-compaction history.
// 2. With nothing to stop it, overflow -> auto-compaction -> overflow repeats,
//    each round a full-history compaction on the paid model.
// 3. DCP (@tarquinen/opencode-dcp) treats ANY assistant message with
//    `summary: true` as a finished compaction, including one that was cancelled
//    or failed, since opencode sets the flag when a compaction starts. It then
//    wipes its pruning state and stops pruning everything older, while opencode
//    still sends all of it. One cancelled compaction tripled a session's
//    per-turn size (408k -> 1.34M).
//
// The pure planners below mirror the runtime's own MessageV2.latest(). The
// session API adapter only touches routes present in upstream v1.18.22.
import { randomBytes } from "node:crypto";

const created = (info) => Number(info?.time?.created) || 0;
const isAfter = (info, other) => {
  if (!other) return true;
  const a = created(info);
  const b = created(other);
  return a !== b ? a > b : String(info.id) > String(other.id);
};
const rowsOf = (rows) => (Array.isArray(rows) ? rows : [])
  .map((row) => (row?.info ? row : null))
  .filter((row) => row && typeof row.info.id === "string");
const hasCompactionPart = (row) => (row?.parts ?? []).some((part) => part?.type === "compaction");

// A summary that never finished, or finished in error: cancelled, crashed, or
// too large to compact. It replaced nothing, but DCP counts it as a compaction.
export const isDeadSummary = (info) =>
  info?.role === "assistant" && info.summary === true && (!info.finish || Boolean(info.error));

const isGoodSummary = (info) =>
  info?.role === "assistant" && info.summary === true && Boolean(info.finish) && !info.error;

// Mirrors MessageV2.latest(): the newest user message, the newest finished
// assistant message, and the compaction/subtask parts queued after that finished
// message. The runtime pops the LAST of those parts as its next task.
export const sessionState = (input) => {
  const rows = rowsOf(input);
  let user;
  let finished;
  for (const { info } of rows) {
    if (info.role === "user" && isAfter(info, user)) user = info;
    if (info.role === "assistant" && info.finish && isAfter(info, finished)) finished = info;
  }
  const tasks = [];
  for (const row of rows) {
    if (finished && !isAfter(row.info, finished)) continue;
    for (const part of row.parts ?? []) {
      if (part?.type === "compaction" || part?.type === "subtask") tasks.push({ part, row });
    }
  }
  return { user, finished, tasks };
};

export const REFUSAL =
  "automatic compaction refused: the previous compaction did not bring this session under the " +
  "model's context limit, and compacting again would re-send the same history for the same " +
  "result. Run /compact to try once more, or start a new session.";

// Called from experimental.session.compacting, i.e. after the runtime has picked
// a compaction task and BEFORE the summary message exists or anything is sent.
export const planCompaction = (input) => {
  const rows = rowsOf(input);
  const { user, finished, tasks } = sessionState(rows);
  const task = tasks.at(-1);
  if (task?.part?.type !== "compaction") return { refuse: null, repair: null };
  // Defect 2: an automatic compaction queued while the newest finished message is
  // a successful summary. That summary did not get the request under the limit.
  // A manual /compact (auto: false) is never refused.
  if (task.part.auto === true && isGoodSummary(finished)) return { refuse: REFUSAL, repair: null };
  // Defect 1: the runtime will parent the summary to the newest user message.
  // If that message does not carry a compaction part, the summary will be
  // ignored, so give it one.
  const newest = rows.find((row) => row.info.id === user?.id);
  if (newest && task.row.info.id !== newest.info.id && !hasCompactionPart(newest)) {
    return {
      refuse: null,
      repair: {
        sessionID: newest.info.sessionID,
        messageID: newest.info.id,
        auto: task.part.auto === true,
        ...(task.part.overflow === true ? { overflow: true } : {}),
      },
    };
  }
  return { refuse: null, repair: null };
};

// Called while the session is idle and a new prompt is arriving. It returns the
// session to a state where the runtime, DCP and the model agree on what the
// context is.
export const planHygiene = (input) => {
  const rows = rowsOf(input);
  // Defect 3: dead summaries tell DCP a compaction happened that never did.
  const dead = rows.filter((row) => isDeadSummary(row.info));
  const deadIDs = new Set(dead.map((row) => row.info.id));
  const live = rows.filter((row) => !deadIDs.has(row.info.id));
  const byID = new Map(live.map((row) => [row.info.id, row]));
  // Defect 1, after the fact: a finished summary whose parent lacks the
  // compaction part. DCP already treats it as a boundary; make opencode agree.
  const anchors = new Map();
  for (const row of live) {
    if (!isGoodSummary(row.info)) continue;
    const parent = byID.get(row.info.parentID);
    if (parent?.info.role === "user" && !hasCompactionPart(parent) && !anchors.has(parent.info.id)) {
      anchors.set(parent.info.id, { sessionID: parent.info.sessionID, messageID: parent.info.id, auto: true });
    }
  }
  // A compaction task still queued when a new prompt arrives never ran: its turn
  // died. Left in place, the runtime resumes it under the new prompt, which is
  // defect 1's trigger. Dropping it lets the runtime decide again from the
  // current state, and create a fresh, correctly-parented compaction if needed.
  const { tasks } = sessionState(live);
  const stale = tasks
    .filter((task) => task.part.type === "compaction" && typeof task.part.id === "string")
    .map((task) => ({
      sessionID: task.row.info.sessionID,
      messageID: task.row.info.id,
      partID: task.part.id,
      wholeMessage: (task.row.parts ?? []).every((part) => part?.type === "compaction"),
    }));
  return {
    deleteMessages: dead.map((row) => ({ sessionID: row.info.sessionID, messageID: row.info.id })),
    addCompactionParts: [...anchors.values()],
    dropTasks: stale,
  };
};

export const hygieneIsEmpty = (plan) =>
  !plan.deleteMessages.length && !plan.addCompactionParts.length && !plan.dropTasks.length;

// opencode's ascending identifier (packages/opencode/src/id/id.ts): 48 bits of
// (ms * 0x1000 + counter) in hex, then 14 base62 characters.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastStamp = 0;
let counter = 0;
export const ascendingID = (prefix, now = Date.now()) => {
  if (now !== lastStamp) {
    lastStamp = now;
    counter = 0;
  }
  counter += 1;
  const stamp = ((BigInt(now) * 0x1000n + BigInt(counter)) & 0xffffffffffffn).toString(16).padStart(12, "0");
  let tail = "";
  for (const byte of randomBytes(14)) tail += BASE62[byte % 62];
  return `${prefix}_${stamp}${tail}`;
};

// The plugin SDK client has no message/part mutation methods, but the routes are
// stock upstream (session.deleteMessage / deletePart / updatePart), so they go
// through the client's own HTTP client and keep its base URL and auth.
export const sessionApi = (client, directory) => {
  const query = directory ? { directory } : undefined;
  const http = () => {
    const raw = client?.session?._client ?? client?._client;
    if (!raw || typeof raw.delete !== "function" || typeof raw.patch !== "function") {
      throw new Error("opencode client exposes no raw HTTP client");
    }
    return raw;
  };
  const ok = (result, what) => {
    const status = result?.response?.status;
    if (result?.error || (typeof status === "number" && status >= 400)) {
      throw new Error(`${what} failed${status ? ` (HTTP ${status})` : ""}`);
    }
    return result?.data ?? result;
  };
  return {
    async messages(sessionID) {
      const result = await client.session.messages({ path: { id: sessionID }, query });
      const rows = result?.data ?? result;
      return Array.isArray(rows) ? rows : null;
    },
    // /session/status lists only sessions that are not idle. Any failure reads as
    // busy: skipping hygiene once is harmless, mutating a running session is not.
    async busy(sessionID) {
      try {
        const result = await client.session.status({ query });
        const map = result?.data ?? result;
        const status = map && typeof map === "object" ? map[sessionID] : undefined;
        return Boolean(status && status.type && status.type !== "idle");
      } catch {
        return true;
      }
    },
    async deleteMessage(sessionID, messageID) {
      ok(await http().delete({ url: "/session/{sessionID}/message/{messageID}", path: { sessionID, messageID }, query }),
        `delete message ${messageID}`);
    },
    async deletePart(sessionID, messageID, partID) {
      ok(await http().delete({
        url: "/session/{sessionID}/message/{messageID}/part/{partID}",
        path: { sessionID, messageID, partID },
        query,
      }), `delete part ${partID}`);
    },
    async putPart(part) {
      ok(await http().patch({
        url: "/session/{sessionID}/message/{messageID}/part/{partID}",
        path: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id },
        query,
        body: part,
        headers: { "Content-Type": "application/json" },
      }), `write part ${part.id}`);
    },
    async toast(message) {
      await client?.tui?.showToast?.({
        body: { title: "Compaction guard", message, variant: "error", duration: 20000 },
        query,
      });
    },
  };
};
