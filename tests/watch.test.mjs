import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const { normalizeModelLine, watchReport, formatReport } = await import("../lib/watch.js");
const watchScript = new URL("../bin/opencode-broker-watch", import.meta.url).pathname;

const runWatch = async ({ brokerResponse, catalog = {}, startBroker = true } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "opencode-broker-watch-"));
  const cacheDir = join(home, ".cache/opencode");
  const authDir = join(home, ".local/share/opencode");
  const routingDir = join(authDir, "model-routing");
  const binDir = join(home, "bin");
  const socketPath = join(routingDir, "broker.sock");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(routingDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(cacheDir, "models.json"), JSON.stringify(catalog) + "\n");
  writeFileSync(join(authDir, "auth.json"), JSON.stringify({ openai: { type: "oauth" } }) + "\n");
  const opencode = join(binDir, "opencode");
  writeFileSync(opencode, `#!/usr/bin/env node\nif (process.argv.includes("--pure")) process.stdout.write("openai/test\\n");\n`);
  chmodSync(opencode, 0o755);

  let server;
  if (startBroker) {
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(brokerResponse) + "\n");
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  }

  try {
    const child = spawn(process.execPath, [watchScript], {
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, ".cache"),
        OPENCODE_MODEL_BROKER_SOCKET: socketPath,
        PATH: `${binDir}:${process.env.PATH}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    return { status, stdout, stderr };
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
};

test("line normalization groups versions and snapshots, separates products", () => {
  assert.equal(normalizeModelLine("qwen3.8-flash"), normalizeModelLine("qwen3.9-flash"));
  assert.equal(normalizeModelLine("deepseek-v4-pro-0813"), normalizeModelLine("deepseek-v4-pro"));
  assert.equal(normalizeModelLine("gpt-5.6-luna"), normalizeModelLine("gpt-5.7-luna"));
  assert.notEqual(normalizeModelLine("qwen3.8-flash"), normalizeModelLine("qwen3.8-max"));
  assert.notEqual(normalizeModelLine("gpt-5.6-luna"), normalizeModelLine("gpt-5.6-terra"));
  assert.equal(normalizeModelLine("claude-opus-5"), normalizeModelLine("claude-opus-4-8"));
});

const catalog = {
  a: { id: "alibaba-token-plan", models: {
    "qwen3.8-flash": { id: "qwen3.8-flash", release_date: "2026-08-26", tool_call: true },
    "qwen3.9-flash": { id: "qwen3.9-flash", release_date: "2026-10-01", tool_call: true, cost: { input: 0.1, output: 0.3 } },
    "happy-video": { id: "happy-video", release_date: "2026-10-02", tool_call: false },
  } },
  b: { id: "anthropic", models: {
    "claude-nova-1": { id: "claude-nova-1", family: "claude-nova", release_date: "2026-10-03", tool_call: true },
  } },
  c: { id: "unwatched", models: { "x-1": { id: "x-1", tool_call: true } } },
};
const targets = { "qwen-flash": { id: "qwen-flash", providerID: "alibaba-token-plan", modelID: "qwen3.8-flash", kind: "cloud" } };

test("watch reports new models once, newer line-mates, and unmapped families", () => {
  const first = watchReport({
    catalog,
    reviewed: { "alibaba-token-plan/qwen3.8-flash": "2026-08-31" },
    targets,
    watchProviders: ["alibaba-token-plan", "anthropic"],
  });
  assert.deepEqual(first.newModels.map((m) => m.id).sort(), ["claude-nova-1", "qwen3.9-flash"],
    "tool-incapable and unwatched-provider models are ignored");
  assert.deepEqual(first.newerInLine, [{
    providerID: "alibaba-token-plan", targetID: "qwen-flash",
    pinned: "qwen3.8-flash", newer: "qwen3.9-flash", releaseDate: "2026-10-01",
  }]);
  // Provider-qualified: a family name is only unique within its provider, and the tier
  // table is keyed the same way.
  assert.deepEqual(first.newFamilies, ["anthropic:claude-nova"]);
  const reviewed = Object.fromEntries(first.seenKeys.map((key) => [key, "2026-08-31"]));
  const second = watchReport({ catalog, reviewed, targets, watchProviders: ["alibaba-token-plan", "anthropic"] });
  assert.deepEqual(second.newModels, [], "everything reports exactly once");
  assert.deepEqual(second.newFamilies, [],
    "an unmapped family is a one-shot notice: leaving it unmapped is a decision, not a standing alarm");
  assert.equal(second.newerInLine.length, 1, "a stale pin keeps nagging until repinned");
  const lines = formatReport(first);
  assert.ok(lines.some((line) => line.includes("NEW FAMILY anthropic:claude-nova")));
  assert.ok(lines.some((line) => line.includes("qwen3.9-flash")));
});

test("watch exits nonzero and omits success when the broker rejects publication", async () => {
  const result = await runWatch({
    brokerResponse: { accepted: false, reason: "config-fingerprint-mismatch" },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, /broker inventory republished from the fresh cache/);
  assert.match(result.stderr, /config-fingerprint-mismatch/);
});

test("watch exits nonzero and omits success when inventory publication throws", async () => {
  const result = await runWatch({ startBroker: false });
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, /broker inventory republished from the fresh cache/);
  assert.match(result.stderr, /inventory republish skipped/);
});

test("watch reports retired discovery aliases as information and admission failures as errors", async () => {
  const result = await runWatch({
    brokerResponse: { changed: true },
    catalog: {
      openai: { id: "openai", models: {
        "gpt-5.5-luna": {
          id: "gpt-5.5-luna", family: "gpt-luna", release_date: "2026-06-01", status: "active", tool_call: true,
        },
        "gpt-5.6-luna": {
          id: "gpt-5.6-luna", family: "gpt-luna", release_date: "2026-07-09", status: "active", tool_call: true,
        },
        "gpt-6-luna": {
          id: "gpt-6-luna", family: "gpt-luna", release_date: "2026-09-22", status: "active", tool_call: true,
        },
      } },
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /discovery retired openai\/gpt-5\.5-luna \(superseded by pin gpt-luna\)/);
  assert.doesNotMatch(result.stderr, /gpt-5\.5-luna/);
  assert.match(result.stderr, /discovery skipped openai\/gpt-6-luna \(unresolvable\) for worker/);
});
