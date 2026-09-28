// claude-proxy picks the cache lifetime from this header: 1 hour for a root session that can sit
// idle, 5 minutes for a subagent that runs back to back. Only the anthropic provider gets it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("chat.headers marks anthropic requests as primary or subagent, and nothing else", () => {
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
      session: { get: async ({ path }) => ({ data: path.id === "ses-child" ? { id: "ses-child", parentID: "ses-root", agent: "reviewer" } : { id: path.id, agent: "smart" } }), messages: async () => ({ data: [] }) },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {});
    const anthropic = { providerID: "anthropic", id: "claude-opus-5" };
    const run = async (sessionID, model) => {
      const output = { headers: {} };
      await hooks["chat.headers"]({ sessionID, agent: "smart", model, message: {} }, output);
      return output.headers["x-opencode-session-kind"] ?? null;
    };
    console.log(JSON.stringify({
      root: await run("ses-root", anthropic),
      child: await run("ses-child", anthropic),
      openai: await run("ses-root", { providerID: "openai", id: "gpt-5.6-sol" }),
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath, OPENCODE_MODEL_ROUTER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.deepEqual(result, { root: "primary", child: "subagent", openai: null });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
