// opencode's title call runs on `small_model` and fires only chat.params (never chat.message).
// It must not be checked against the conversation's route; a conversation turn still is.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("the title call passes on the small model; a conversation turn on the wrong model is refused", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-title-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/lease"
          ? { target: { id: "t", model: { providerID: "openai", id: "gpt-5.6-sol" } }, decision: { policy: "weighted-depletion", reasons: [] } }
          : { ok: true };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {}; req.setTimeout = () => {}; req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".local/share/opencode"), { recursive: true });
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    writeFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\\n");
    const client = {
      provider: { list: async () => ({ data: { connected: ["openai"], all: [{ id: "openai", models: {} }] } }) },
      session: { get: async () => ({ id: "ses-t", agent: "smart" }), messages: async () => ({ data: [] }) },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {});
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses-t", agent: "smart" } } } });
    await hooks["chat.message"]({ sessionID: "ses-t", agent: "smart" }, { message: { agent: "smart", model: {} }, parts: [{ type: "text", text: "hi" }] });
    const small = { providerID: "fleet-gateway", id: "titles" };
    let title = "passed";
    try { await hooks["chat.params"]({ sessionID: "ses-t", agent: "title", model: small, message: {} }); } catch (e) { title = e.message; }
    let turn = "passed";
    try { await hooks["chat.params"]({ sessionID: "ses-t", agent: "smart", model: small, message: {} }); } catch (e) { turn = e.message; }
    console.log(JSON.stringify({ title, turn }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath, OPENCODE_MODEL_ROUTER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.title, "passed");
    assert.match(result.turn, /routed model mismatch/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
