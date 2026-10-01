// claude-proxy picks the cache lifetime from these headers (1 hour for a root session that can
// sit idle, 5 minutes for a subagent that runs back to back) and fingerprints prompts per
// session. Only the anthropic provider gets them. The same harness pins the subagent rule: a
// routed subagent's preference is the model it is on, not the model a message is stamped with.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const runPlugin = (body) => {
  const home = mkdtempSync(join(tmpdir(), "broker-kind-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const leases = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      let sent = "";
      req.write = (chunk) => { sent += chunk; };
      req.end = (chunk) => {
        if (chunk) sent += chunk;
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        let reply = { ok: true };
        if (options.path === "/lease") {
          const lease = JSON.parse(sent || "{}");
          leases.push(lease);
          // The broker honours an eligible preference; otherwise it balances onto sol.
          const model = lease.preferredModel ?? { providerID: "openai", id: "gpt-5.6-sol" };
          reply = { leaseID: "lease-" + leases.length, target: { id: model.id, model }, decision: { policy: "weighted-depletion", reasons: [] } };
        }
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {}; req.setTimeout = () => {}; req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" }, anthropic: { type: "oauth" } }) + "\\n");
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai", "anthropic"], all: [{ id: "openai", models: {} }, { id: "anthropic", models: {} }] } }) },
      session: {
        get: async ({ path }) => ({ data: path.id === "ses-child" ? { id: "ses-child", parentID: "ses-root", agent: "sp-implementer" } : { id: path.id, agent: "smart" } }),
        // A seasoned session: one completed 90k-token step, so leases carry a preference.
        messages: async () => ({ data: [{ info: { role: "assistant", time: { completed: 1 }, tokens: { input: 90000, output: 10 } } }] }),
      },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {});
    ${body}
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath, OPENCODE_MODEL_ROUTER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split("\n").at(-1));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("chat.headers marks gateway-bound requests as primary or subagent, with the session id, and nothing else", () => {
  const result = runPlugin(`
    const anthropic = { providerID: "anthropic", id: "claude-opus-5" };
    const run = async (sessionID, model) => {
      const output = { headers: {} };
      await hooks["chat.headers"]({ sessionID, agent: "smart", model, message: {} }, output);
      return output.headers;
    };
    console.log(JSON.stringify({
      root: await run("ses-root", anthropic),
      child: await run("ses-child", anthropic),
      openai: await run("ses-root", { providerID: "openai", id: "gpt-5.6-sol" }),
      local: await run("ses-root", { providerID: "llamacpp", id: "qwen3.5-9b" }),
    }));
  `);
  assert.deepEqual(result, {
    root: { "x-opencode-session-kind": "primary", "x-opencode-session-id": "ses-root" },
    child: { "x-opencode-session-kind": "subagent", "x-opencode-session-id": "ses-child" },
    openai: { "x-opencode-session-kind": "primary", "x-opencode-session-id": "ses-root" },
    local: {},
  });
});

// The gateway forwards a routed session's request on that session's own lease, so the
// header must name the lease the turn actually holds.
test("chat.headers carries the routed turn's lease id", () => {
  const result = runPlugin(`
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-root", agent: "smart" } } } });
    await hooks["chat.message"](
      { sessionID: "ses-root", agent: "smart", model: { providerID: "openai", id: "gpt-5.6-sol" } },
      { message: { agent: "smart", model: { providerID: "openai", modelID: "gpt-5.6-sol" } }, parts: [{ type: "text", text: "go" }] },
    );
    const output = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "ses-root", agent: "smart", model: { providerID: "openai", id: "gpt-5.6-sol" }, message: {} }, output);
    console.log(JSON.stringify(output.headers));
  `);
  assert.equal(result["x-opencode-session-id"], "ses-root");
  assert.match(result["x-opencode-lease-id"] ?? "", /^lease-\d+$/);
});

test("a routed subagent keeps its model when a message arrives stamped with another", () => {
  const result = runPlugin(`
    const send = (model, agent) => hooks["chat.message"](
      { sessionID: "ses-child", agent, model },
      { message: { agent, model: { providerID: model.providerID, modelID: model.id } }, parts: [{ type: "text", text: "go" }] },
    );
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-child", parentID: "ses-root", agent: "sp-implementer" } } } });
    await send({ providerID: "openai", id: "gpt-5.6-sol" }, "sp-implementer");
    // The 2026-09-28 shape: an agent-less prompt, stamped with the pane default.
    await send({ providerID: "anthropic", id: "claude-opus-5" }, "smart");
    console.log(JSON.stringify({ leases: leases.map((lease) => lease.preferredModel ?? null) }));
  `);
  const last = result.leases.at(-1);
  assert.equal(last?.providerID, "openai", JSON.stringify(result.leases));
  assert.equal(last?.id, "gpt-5.6-sol");
});

// ☠️ The same stamp on a ROOT (2026-09-28): a background-job notice named no model,
// arrived stamped with the pane default, and re-leased a gpt-5.6-sol root onto claude-opus-5
// while the pane still showed Sol -- after which every turn failed "routed model mismatch".
const rootSend = `
  const send = (model, parts) => hooks["chat.message"](
    { sessionID: "ses-root", agent: "smart", model },
    { message: { agent: "smart", model: { providerID: model.providerID, modelID: model.id } }, parts },
  );
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-root", agent: "smart" } } } });
  await send({ providerID: "openai", id: "gpt-5.6-sol" }, [{ type: "text", text: "start the task" }]);
`;

test("a synthetic prompt keeps a routed root on its model", () => {
  const result = runPlugin(rootSend + `
    await send({ providerID: "anthropic", id: "claude-opus-5" }, [{ type: "text", text: "[background job bg002 finished]", synthetic: true }]);
    console.log(JSON.stringify({ leases: leases.map((lease) => lease.preferredModel ?? null) }));
  `);
  const last = result.leases.at(-1);
  assert.equal(last?.providerID, "openai", JSON.stringify(result.leases));
  assert.equal(last?.id, "gpt-5.6-sol");
});

test("a root's own typed prompt still carries the user's model choice", () => {
  const result = runPlugin(rootSend + `
    await send({ providerID: "anthropic", id: "claude-opus-5" }, [{ type: "text", text: "switch to opus please" }]);
    console.log(JSON.stringify({ leases: leases.map((lease) => lease.preferredModel ?? null) }));
  `);
  const last = result.leases.at(-1);
  assert.equal(last?.providerID, "anthropic", JSON.stringify(result.leases));
  assert.equal(last?.id, "claude-opus-5");
});
