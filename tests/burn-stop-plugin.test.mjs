// The plugin half of the burn watch: a /usage reply carrying `burn.stop` aborts that
// session's turn and tells the person why. Hosted the way failover.test.mjs hosts the
// plugin: a child process with node:http's request replaced by a scripted broker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a burn stop on the /usage reply aborts that session and toasts the reason", () => {
  const home = mkdtempSync(join(tmpdir(), "broker-burn-plugin-"));
  const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;
  const configPath = new URL("./fixtures/config.json", import.meta.url).pathname;
  const script = `
    import { createRequire } from "node:module";
    import { EventEmitter } from "node:events";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const http = require("node:http");
    const usage = [];
    http.request = (options, callback) => {
      const req = new EventEmitter();
      req.end = (payload = "") => {
        const body = payload ? JSON.parse(payload) : {};
        if (options.path === "/usage") usage.push(body);
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        const reply = options.path === "/usage" && body.sessionID === "ses-runaway"
          ? { ok: true, burn: { stop: true, reason: "it re-sent its whole prompt uncached 4 times in 5 min (1.71M tokens)" } }
          : { ok: true };
        response.emit("data", JSON.stringify(reply));
        response.emit("end");
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      req.on = EventEmitter.prototype.on;
      return req;
    };
    mkdirSync(join(process.env.HOME, ".cache/opencode"), { recursive: true });
    writeFileSync(join(process.env.HOME, ".cache/opencode/models.json"), JSON.stringify({}));
    const aborts = [];
    const toasts = [];
    const client = {
      provider: { list: async () => ({ data: { connected: [], all: [] } }) },
      session: {
        get: async () => ({ id: "x", agent: "smart" }),
        messages: async () => ({ data: [] }),
        abort: async (input) => { aborts.push(input.path.id); return { data: true }; },
        prompt: async () => ({ data: true }),
      },
      tui: { showToast: async (input) => { toasts.push(input.body); return { data: true }; } },
    };
    const { ModelRouter } = await import(${JSON.stringify(pluginUrl)});
    const hooks = await ModelRouter({ client, directory: process.env.HOME }, {});
    const step = async (sessionID, n) => {
      await hooks.event({ event: { type: "message.updated", properties: { info: {
        id: "msg-" + sessionID + n, sessionID, role: "assistant", providerID: "anthropic", modelID: "claude-opus-5" } } } });
      await hooks.event({ event: { type: "message.part.updated", properties: { part: {
        id: "prt-" + sessionID + n, messageID: "msg-" + sessionID + n, sessionID, type: "step-finish",
        tokens: { input: 5, output: 400, cache: { read: 17000, write: 430000 } } } } } });
    };
    await step("ses-healthy", 1);
    await step("ses-runaway", 1);
    await new Promise((r) => setTimeout(r, 50));
    console.log(JSON.stringify({ usage: usage.length, aborts, toasts }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_CONFIG: configPath },
    encoding: "utf8",
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.equal(result.usage, 2, "every step is still reported");
    assert.deepEqual(result.aborts, ["ses-runaway"], "only the session the broker named is stopped");
    assert.equal(result.toasts.length, 1);
    assert.equal(result.toasts[0].title, "Burn watch stopped this session");
    assert.match(result.toasts[0].message, /re-sent its whole prompt uncached 4 times .*send a message to continue deliberately/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
