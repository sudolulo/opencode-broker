import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, mock } from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const routingState = mkdtempSync(join(tmpdir(), "turn-effort-plugin-state-"));
process.env.OPENCODE_MODEL_ROUTING_DIR = routingState;
after(() => rmSync(routingState, { recursive: true, force: true }));

const realTurnEffort = await import("../lib/turn-effort.js");
let classifyCalls = [];
let classifyFailure = false;

mock.module("../lib/turn-effort.js", {
  namedExports: {
    classifyTurn(input) {
      classifyCalls.push(input);
      if (classifyFailure) throw new Error("classifier unavailable");
      return realTurnEffort.classifyTurn(input);
    },
    nextPrevious: realTurnEffort.nextPrevious,
  },
});

const { ModelRouter } = await import(`../plugin/router.js?turn-effort-plugin=${Date.now()}`);
const routing = await import("../lib/routing.js");

const withRouter = async (sessions, run, { staleLease = false, profile = "local" } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "turn-effort-plugin-"));
  const requests = [];
  const logs = [];
  let stale = staleLease;
  const brokerRequest = async (path, body) => {
    requests.push({ path, body });
    if (path === "/lease" && stale) {
      stale = false;
      throw new Error("provider inventory is stale");
    }
    if (path === "/lease") {
      return {
        leaseID: `lease-${body.sessionID}`,
        target: body.tier === "classifier"
          ? { id: "local-classifier", kind: "local", model: { providerID: "llamacpp", id: "qwen3.5-4b" } }
          : { id: "test-target", model: { providerID: "openai", id: "gpt-5.6-luna" } },
      };
    }
    return { changed: false };
  };
  const client = {
    app: { log: async () => {} },
    provider: { list: async () => ({ data: { connected: [], all: [] } }) },
    session: {
      get: async ({ path }) => {
        const session = sessions.get(path.id);
        if (Array.isArray(session)) {
          const next = session.shift();
          if (next instanceof Error) throw next;
          return next;
        }
        if (session instanceof Error) throw session;
        return session;
      },
      messages: async () => ({ data: [] }),
    },
  };
  client.app.log = async (entry) => { logs.push(entry); };
  const hooks = await ModelRouter({ client, directory: home }, { brokerRequest });
  for (const [sessionID, session] of sessions) {
    if (session instanceof Error) continue;
    if (profile) routing.writeSessionProfile(sessionID, profile, { explicit: true });
    else routing.removeSessionProfile(sessionID);
  }
  try {
    await run({ hooks, requests, logs, client });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const message = async (hooks, sessionID, text, agent = "standard") => {
  const output = {
    message: { model: { providerID: "openai", modelID: "gpt-5.6-luna" } },
    parts: [{ type: "text", text }],
  };
  await hooks["chat.message"]({
    sessionID,
    agent,
    model: { providerID: "openai", id: "gpt-5.6-luna" },
  }, output);
  return output;
};

test("sends an explicit hard turn and the default engine capability with its lease", async () => {
  classifyCalls = [];
  await withRouter(new Map([["root", { id: "root", agent: "standard" }]]), async ({ hooks, requests }) => {
    await message(hooks, "root", "ultrathink the design");
    const lease = requests.find((request) => request.path === "/lease");
    assert.deepEqual(lease.body.turnClass, { class: "hard", reason: "explicit" });
    assert.equal(lease.body.engineEffortUpdates, false);
    assert.equal(classifyCalls.length, 1);
  });
});

test("keeps engine effort capability isolated per session and defaults unseen sessions to false", async () => {
  await withRouter(new Map([
    ["a", { id: "a", agent: "standard" }],
    ["b", { id: "b", agent: "standard" }],
    ["unseen", { id: "unseen", agent: "standard" }],
  ]), async ({ hooks, requests }) => {
    const firstA = await message(hooks, "a", "first turn");
    const firstB = await message(hooks, "b", "first turn");
    await hooks["chat.params"]({
      sessionID: "a",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      message: firstA.message,
      effortUpdates: true,
    });
    await hooks["chat.params"]({
      sessionID: "b",
      model: { providerID: "openai", id: "gpt-5.6-luna" },
      message: firstB.message,
      effortUpdates: false,
    });
    await message(hooks, "a", "second turn");
    await message(hooks, "b", "second turn");
    await message(hooks, "unseen", "first turn");
    const leases = requests.filter((request) => request.path === "/lease");
    assert.deepEqual(leases.map((lease) => [lease.body.sessionID, lease.body.engineEffortUpdates]), [
      ["a", false], ["b", false], ["a", true], ["b", false], ["unseen", false],
    ]);
  });
});

test("classifies child and unavailable sessions as subagent seats", async () => {
  classifyCalls = [];
  await withRouter(new Map([
    ["child", { id: "child", parentID: "root", agent: "standard" }],
    ["missing", new Error("session unavailable")],
  ]), async ({ hooks, requests }) => {
    await message(hooks, "child", "ultrathink the design");
    await assert.rejects(message(hooks, "missing", "ultrathink the design"), /session unavailable/);
    const childLease = requests.find((request) => request.path === "/lease");
    assert.deepEqual(childLease.body.turnClass, { class: "normal", reason: "subagent-seat" });
    assert.deepEqual(classifyCalls.map((call) => call.isSubagent), [true, true]);
  });
});

test("does not classify or lease a Manual Model session", async () => {
  classifyCalls = [];
  await withRouter(new Map([["manual", { id: "manual", agent: "standard" }]]), async ({ hooks, requests }) => {
    routing.writeSessionProfile("manual", "manual", { explicit: true });
    await message(hooks, "manual", "ultrathink the design");
    assert.equal(requests.some((request) => request.path === "/lease"), false);
    assert.equal(classifyCalls.length, 0);
  });
});

test("carries the previous hard class through a light status question and go-ahead", async () => {
  await withRouter(new Map([["root", { id: "root", agent: "standard" }]]), async ({ hooks, requests }) => {
    await message(hooks, "root", "ultrathink x");
    await message(hooks, "root", "all good?");
    await message(hooks, "root", "continue");
    const leases = requests.filter((request) => request.path === "/lease");
    assert.deepEqual(leases.map((lease) => lease.body.turnClass), [
      { class: "hard", reason: "explicit" },
      { class: "light", reason: "status" },
      { class: "hard", reason: "go-ahead", resolvedFrom: "hard" },
    ]);
    assert.equal(Object.hasOwn(leases[0].body.turnClass, "resolvedFrom"), false);
  });
});

test("does not attach a class to synthetic-only prompts", async () => {
  await withRouter(new Map([["root", { id: "root", agent: "standard" }]]), async ({ hooks, requests }) => {
    const output = {
      message: { model: { providerID: "openai", modelID: "gpt-5.6-luna" } },
      parts: [{ type: "text", text: "continue", synthetic: true }],
    };
    await hooks["chat.message"]({ sessionID: "root", agent: "standard" }, output);
    const lease = requests.find((request) => request.path === "/lease");
    assert.equal(Object.hasOwn(lease.body, "turnClass"), false);
  });
});

test("bounds previous classes and does not send a class for compaction turns", async () => {
  await withRouter(new Map(), async ({ hooks, requests }) => {
    const sessions = 2100;
    const sessionIDs = Array.from({ length: sessions }, (_, index) => `session-${index}`);
    await Promise.all(sessionIDs.map(async (sessionID) => {
      await hooks.event({ event: { type: "session.created", properties: { info: { id: sessionID, agent: "fleet-classifier" } } } });
    }));
    await Promise.all(sessionIDs.map((sessionID) => message(hooks, sessionID, "ultrathink x", "fleet-classifier")));
    await message(hooks, "session-0", "continue", "fleet-classifier");
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "compaction", agent: "fleet-classifier" } } } });
    await message(hooks, "compaction", "ultrathink x", "compaction");
    await message(hooks, "compaction", "continue", "compaction");
    const leases = requests.filter((request) => request.path === "/lease");
    const continued = leases.filter((lease) => lease.body.sessionID === "session-0").at(-1);
    const compacted = leases.filter((lease) => lease.body.sessionID === "compaction").at(-1);
    assert.deepEqual(continued.body.turnClass, { class: "normal", reason: "go-ahead", resolvedFrom: "normal" });
    assert.equal(Object.hasOwn(compacted.body, "turnClass"), false);
  });
});

test("classifies once when a stale inventory retries ensure", async () => {
  classifyCalls = [];
  await withRouter(new Map([["root", { id: "root", agent: "standard" }]]), async ({ hooks, requests }) => {
    await message(hooks, "root", "ultrathink the design");
    const leases = requests.filter((request) => request.path === "/lease");
    assert.equal(classifyCalls.length, 1);
    assert.deepEqual(leases.map((lease) => lease.body.turnClass), [
      { class: "hard", reason: "explicit" },
      { class: "hard", reason: "explicit" },
    ]);
  }, { staleLease: true, profile: null });
});

test("routes with a classifier-error class when the classifier throws", async () => {
  classifyFailure = true;
  try {
    await withRouter(new Map([["root", { id: "root", agent: "standard" }]]), async ({ hooks, requests }) => {
      await message(hooks, "root", "ultrathink the design");
      const lease = requests.find((request) => request.path === "/lease");
      assert.deepEqual(lease.body.turnClass, { class: "normal", reason: "classifier-error" });
    });
  } finally {
    classifyFailure = false;
  }
});

test("routes and warns without prompt text when turn tier lookup throws", async () => {
  const prompt = "what dosage of ibuprofen is safe for a child";
  await withRouter(new Map([
    ["child", { id: "child", parentID: "root", agent: "general" }],
    ["root", [new Error("tier lookup unavailable"), { id: "root", agent: "standard" }]],
  ]), async ({ hooks, requests, logs }) => {
    await message(hooks, "child", prompt, "general");
    const lease = requests.find((request) => request.path === "/lease");
    assert.deepEqual(lease.body.turnClass, { class: "normal", reason: "classifier-error" });
    const warning = logs.find((entry) => entry.body?.level === "warn");
    assert.equal(warning.body.message, "turn effort classification failed");
    assert.equal(JSON.stringify(warning).includes(prompt), false);
  });
});

test("reports the current lease ID with usage", async () => {
  await withRouter(new Map([["root", { id: "root", agent: "standard" }]]), async ({ hooks, requests }) => {
    await message(hooks, "root", "normal task");
    await hooks.event({ event: { type: "message.updated", properties: {
      sessionID: "root",
      message: { id: "assistant-message", role: "assistant", providerID: "openai", modelID: "gpt-5.6-luna" },
    } } });
    await hooks.event({ event: { type: "message.part.updated", properties: {
      sessionID: "root",
      part: { type: "step-finish", id: "step", messageID: "assistant-message", tokens: { input: 1, output: 1 } },
    } } });
    await new Promise((resolve) => setImmediate(resolve));
    const usage = requests.find((request) => request.path === "/usage");
    assert.equal(usage.body.leaseID, "lease-root");
  });
});
