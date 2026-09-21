import assert from "node:assert/strict";
import test from "node:test";

const {
  ascendingID,
  hygieneIsEmpty,
  planCompaction,
  planHygiene,
  REFUSAL,
  sessionApi,
  sessionState,
} = await import("../lib/compaction-guard.js");
const { CompactionGuard } = await import("../plugin/compaction-guard.js");

const S = "ses_test";
let clock = 1_000;
const user = (id, parts = [{ type: "text", text: "continue" }]) => ({
  info: { id, sessionID: S, role: "user", time: { created: clock++ } },
  parts: parts.map((part, index) => ({ id: `${id}_p${index}`, sessionID: S, messageID: id, ...part })),
});
const assistant = (id, extra = {}) => ({
  info: { id, sessionID: S, role: "assistant", parentID: extra.parentID, time: { created: clock++ }, ...extra },
  parts: [],
});
const compaction = (id, extra = {}) => user(id, [{ type: "compaction", auto: true, ...extra }]);

test("sessionState mirrors the runtime: tasks are the parts queued after the newest finished message", () => {
  const rows = [
    user("u1"),
    assistant("a1", { finish: "stop", parentID: "u1" }),
    compaction("c1"),
    user("u2"),
  ];
  const state = sessionState(rows);
  assert.equal(state.user.id, "u2");
  assert.equal(state.finished.id, "a1");
  assert.deepEqual(state.tasks.map((task) => task.row.info.id), ["c1"]);
});

test("a second automatic compaction right after a successful one is refused", () => {
  // overflow -> compaction -> overflow again: the 2026-09-21 loop, one round in.
  const rows = [
    user("u1"),
    assistant("a1", { finish: "stop", parentID: "u1" }),
    compaction("c1", { overflow: true }),
    assistant("s1", { summary: true, finish: "stop", parentID: "c1" }),
    user("u2"),
    assistant("a2", { parentID: "u2" }),
    compaction("c2", { overflow: true }),
  ];
  assert.deepEqual(planCompaction(rows), { refuse: REFUSAL, repair: null });
});

test("a manual /compact after a successful compaction is never refused", () => {
  const rows = [
    user("u1"),
    compaction("c1"),
    assistant("s1", { summary: true, finish: "stop", parentID: "c1" }),
    compaction("c2", { auto: false }),
  ];
  assert.deepEqual(planCompaction(rows), { refuse: null, repair: null });
});

test("an automatic compaction after a FAILED compaction is not refused", () => {
  // A summary that errored replaced nothing; trying again is not a loop.
  const rows = [
    user("u1"),
    assistant("a1", { finish: "stop", parentID: "u1" }),
    compaction("c1"),
    assistant("s1", { summary: true, finish: "error", error: { name: "ContextOverflowError" }, parentID: "c1" }),
    user("u2"),
    compaction("c2"),
  ];
  assert.equal(planCompaction(rows).refuse, null);
});

test("a resumed compaction is anchored to the message its summary will hang off", () => {
  // The compaction was queued, its turn died, and the user typed "continue".
  const rows = [
    user("u1"),
    assistant("a1", { finish: "stop", parentID: "u1" }),
    compaction("c1", { overflow: true }),
    user("u2"),
  ];
  assert.deepEqual(planCompaction(rows), {
    refuse: null,
    repair: { sessionID: S, messageID: "u2", auto: true, overflow: true },
  });
});

test("an ordinary compaction on the newest message is left alone", () => {
  const rows = [user("u1"), assistant("a1", { finish: "stop", parentID: "u1" }), compaction("c1")];
  assert.deepEqual(planCompaction(rows), { refuse: null, repair: null });
});

test("hygiene clears the exact debris the superpowers session was left with", () => {
  // Shape of ses_f45826bad... after the incident: a cancelled local compaction, a
  // resumed one parented to "continue", an interrupted one, a second orphaned
  // summary, and an overflow compaction still queued.
  const rows = [
    user("u1"),
    assistant("a1", { finish: "tool-calls", parentID: "u1" }),
    compaction("c0"),
    assistant("d0", { summary: true, parentID: "c0", error: { name: "MessageAbortedError" } }),
    user("u2"),
    assistant("s1", { summary: true, finish: "stop", parentID: "u2" }),
    compaction("c1", { overflow: true }),
    assistant("d1", { summary: true, parentID: "c1" }),
    user("u3"),
    assistant("s2", { summary: true, finish: "stop", parentID: "u3" }),
    user("u4", [{ type: "text", text: "[opencode-broker] continue" }]),
    assistant("a4", { parentID: "u4" }),
    compaction("c2", { overflow: true }),
  ];
  const plan = planHygiene(rows);
  assert.deepEqual(plan.deleteMessages.map((item) => item.messageID), ["d0", "d1"],
    "summaries that never finished are what fool DCP");
  assert.deepEqual(plan.addCompactionParts.map((item) => item.messageID), ["u2", "u3"],
    "finished summaries become real boundaries");
  assert.deepEqual(plan.dropTasks, [{ sessionID: S, messageID: "c2", partID: "c2_p0", wholeMessage: true }],
    "only the compaction queued after the newest finished summary is still pending");
});

test("hygiene drops only the part when a queued compaction shares a message with text", () => {
  const rows = [
    user("u1"),
    assistant("a1", { finish: "stop", parentID: "u1" }),
    user("u2", [{ type: "text", text: "go on" }, { type: "compaction", auto: true }]),
  ];
  assert.deepEqual(planHygiene(rows).dropTasks, [{ sessionID: S, messageID: "u2", partID: "u2_p1", wholeMessage: false }]);
});

test("hygiene leaves a healthy compacted session untouched", () => {
  const rows = [
    user("u1"),
    assistant("a1", { finish: "stop", parentID: "u1" }),
    compaction("c1"),
    assistant("s1", { summary: true, finish: "stop", parentID: "c1" }),
    user("u2"),
    assistant("a2", { finish: "stop", parentID: "u2" }),
  ];
  assert.equal(hygieneIsEmpty(planHygiene(rows)), true);
  assert.equal(hygieneIsEmpty(planHygiene([])), true);
});

test("ascendingID matches opencode's id shape and sorts in creation order", () => {
  const ids = [ascendingID("prt", 1_790_000_000_000), ascendingID("prt", 1_790_000_000_000), ascendingID("prt", 1_790_000_000_001)];
  for (const id of ids) assert.match(id, /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.deepEqual([...ids].sort(), ids);
  // Same 48-bit stamp the runtime writes: low 48 bits of (ms * 0x1000 + counter),
  // with the counter restarting at 1 on a new millisecond.
  const stamp = (ms, n) => ((BigInt(ms) * 0x1000n + BigInt(n)) & 0xffffffffffffn).toString(16).padStart(12, "0");
  assert.equal(ids[0].slice(4, 16), stamp(1_790_000_000_000, 1));
  assert.equal(ids[1].slice(4, 16), stamp(1_790_000_000_000, 2));
  assert.equal(ids[2].slice(4, 16), stamp(1_790_000_000_001, 1));
});

const fakeApi = ({ rows = [], busy = false } = {}) => {
  const calls = [];
  const api = {
    calls,
    rows,
    busyNow: busy,
    async messages(sessionID) { calls.push(["messages", sessionID]); return api.rows; },
    async busy(sessionID) { calls.push(["busy", sessionID]); return api.busyNow; },
    async deleteMessage(sessionID, messageID) { calls.push(["deleteMessage", messageID]); },
    async deletePart(sessionID, messageID, partID) { calls.push(["deletePart", messageID, partID]); },
    async putPart(part) { calls.push(["putPart", part.messageID, part.type, part.auto, /^prt_/.test(part.id)]); },
    async toast(message) { calls.push(["toast", message]); },
  };
  return api;
};
const mutations = (api) => api.calls.filter(([name]) => !["messages", "busy"].includes(name));

test("chat.message cleans an idle session once, and again only after compaction activity", async () => {
  const api = fakeApi({
    rows: [
      user("u1"),
      assistant("a1", { finish: "stop", parentID: "u1" }),
      compaction("c1"),
      assistant("d1", { summary: true, parentID: "c1", error: { name: "MessageAbortedError" } }),
    ],
  });
  const hooks = await CompactionGuard({}, { api });
  await hooks["chat.message"]({ sessionID: S });
  assert.deepEqual(mutations(api), [["deleteMessage", "d1"], ["deleteMessage", "c1"]]);

  api.calls.length = 0;
  await hooks["chat.message"]({ sessionID: S });
  assert.deepEqual(api.calls, [], "a checked session costs no history fetch per prompt");

  await hooks.event({ event: { type: "message.updated", properties: { info: { sessionID: S, summary: true } } } });
  await hooks["chat.message"]({ sessionID: S });
  assert.ok(api.calls.some(([name]) => name === "messages"), "compaction activity re-arms the check");
});

test("chat.message never mutates a busy session and retries on the next prompt", async () => {
  const api = fakeApi({ busy: true, rows: [compaction("c1"), assistant("d1", { summary: true, parentID: "c1" })] });
  const hooks = await CompactionGuard({}, { api });
  await hooks["chat.message"]({ sessionID: S });
  assert.deepEqual(mutations(api), [], "a running compaction also looks like a dead one; hands off");
  api.busyNow = false;
  await hooks["chat.message"]({ sessionID: S });
  assert.deepEqual(mutations(api), [["deleteMessage", "d1"], ["deleteMessage", "c1"]]);
});

test("chat.message swallows hygiene failures so a prompt is never blocked", async () => {
  const api = fakeApi();
  api.messages = async () => { throw new Error("boom"); };
  const hooks = await CompactionGuard({}, { api });
  await hooks["chat.message"]({ sessionID: S });
});

test("the compacting hook refuses a repeat compaction before anything is sent", async () => {
  const api = fakeApi({
    rows: [
      user("u1"),
      compaction("c1", { overflow: true }),
      assistant("s1", { summary: true, finish: "stop", parentID: "c1" }),
      user("u2"),
      compaction("c2", { overflow: true }),
    ],
  });
  const hooks = await CompactionGuard({}, { api });
  await assert.rejects(
    hooks["experimental.session.compacting"]({ sessionID: S }, { context: [] }),
    /^Error: \[compaction-guard\] automatic compaction refused/,
  );
  assert.deepEqual(mutations(api), [["toast", REFUSAL]]);
});

test("the compacting hook anchors a resumed compaction and lets it run", async () => {
  const api = fakeApi({
    rows: [user("u1"), assistant("a1", { finish: "stop", parentID: "u1" }), compaction("c1"), user("u2")],
  });
  const hooks = await CompactionGuard({}, { api });
  await hooks["experimental.session.compacting"]({ sessionID: S }, { context: [] });
  assert.deepEqual(mutations(api), [["putPart", "u2", "compaction", true, true]]);
});

test("the compacting hook fails open when the history cannot be read", async () => {
  const api = fakeApi();
  api.messages = async () => { throw new Error("unreachable"); };
  const hooks = await CompactionGuard({}, { api });
  await hooks["experimental.session.compacting"]({ sessionID: S }, { context: [] });
  assert.deepEqual(mutations(api), []);
});

test("sessionApi drives the stock routes through the client's own HTTP client", async () => {
  const seen = [];
  const raw = {
    delete: async (options) => { seen.push(["DELETE", options.url, options.path, options.query]); return { data: true, response: { status: 200 } }; },
    patch: async (options) => { seen.push(["PATCH", options.url, options.path, options.body.type]); return { data: options.body, response: { status: 200 } }; },
  };
  const client = {
    session: {
      _client: raw,
      messages: async () => ({ data: [user("u1")] }),
      status: async () => ({ data: { busy_one: { type: "busy" } } }),
    },
  };
  const api = sessionApi(client, "/work");
  await api.deleteMessage(S, "m1");
  await api.deletePart(S, "m1", "p1");
  await api.putPart({ id: "prt_x", sessionID: S, messageID: "m1", type: "compaction", auto: true });
  assert.deepEqual(seen, [
    ["DELETE", "/session/{sessionID}/message/{messageID}", { sessionID: S, messageID: "m1" }, { directory: "/work" }],
    ["DELETE", "/session/{sessionID}/message/{messageID}/part/{partID}", { sessionID: S, messageID: "m1", partID: "p1" }, { directory: "/work" }],
    ["PATCH", "/session/{sessionID}/message/{messageID}/part/{partID}", { sessionID: S, messageID: "m1", partID: "prt_x" }, "compaction"],
  ]);
  assert.equal(await api.busy("busy_one"), true);
  assert.equal(await api.busy(S), false, "an idle session is absent from /session/status");
  assert.equal((await api.messages(S)).length, 1);

  raw.delete = async () => ({ error: { name: "NotFound" }, response: { status: 404 } });
  await assert.rejects(api.deleteMessage(S, "gone"), /HTTP 404/);
  client.session.status = async () => { throw new Error("down"); };
  assert.equal(await api.busy(S), true, "an unknown status is treated as busy");
});
