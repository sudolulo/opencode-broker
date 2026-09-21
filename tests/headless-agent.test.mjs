// A headless `opencode run` without --agent: chat.message's input names no agent, and a fresh
// session's record may not carry one yet. opencode resolves its default agent onto the user
// message itself, so that is the field the router must read -- otherwise every such run leases
// the default (worker) tier however strong the default agent is.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const leaseTierFor = ({ inputAgent, messageAgent }) => {
  const home = mkdtempSync(join(tmpdir(), "broker-headless-agent-"));
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
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        if (options.path === "/lease") leases.push(body);
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/lease"
          ? { target: { id: "t", model: { providerID: "openai", id: "gpt-5.6-luna" } }, decision: { policy: "weighted-depletion", reasons: [] } }
          : { ok: true };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      // A fresh session: its record carries no agent yet.
      session: { get: async () => ({ id: "ses-headless" }), messages: async () => ({ data: [] }) },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {});
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-headless" } } } });
    await hooks["chat.message"](
      { sessionID: "ses-headless", ${inputAgent ? `agent: ${JSON.stringify(inputAgent)}` : ""} },
      { message: { ${messageAgent ? `agent: ${JSON.stringify(messageAgent)},` : ""} model: {} }, parts: [{ type: "text", text: "hello" }] },
    );
    console.log(JSON.stringify({ tiers: leases.map((l) => l.tier) }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath, OPENCODE_MODEL_ROUTER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split("\n").at(-1)).tiers;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("with no agent in the input, the agent opencode resolved onto the message decides the tier", () => {
  assert.deepEqual(leaseTierFor({ messageAgent: "smart" }), ["smart"]);
});

test("an agent the caller named still wins over the message's", () => {
  assert.deepEqual(leaseTierFor({ inputAgent: "deep", messageAgent: "smart" }), ["deep"]);
});
