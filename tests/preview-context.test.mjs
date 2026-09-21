import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

// Route the config loader at the fleet-shaped fixture BEFORE any router module loads.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

const brokerScript = join(fileURLToPath(new URL("..", import.meta.url)), "bin/opencode-broker");

const post = (socketPath, path, body = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = http.request({
    socketPath, path, method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { text += c; });
    res.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
  });
  req.on("error", reject);
  req.end(payload);
});

// A local-first lane can only be previewed correctly when the caller declares a size:
// localContextEligible refuses a null estimate by design, so before /preview accepted
// contextTokens it dropped every local candidate and reported the cloud FALLBACK as
// though it were the destination.
test("/preview answers for a local target only when the caller declares a size", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-preview-context-"));
  const models = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen3.5-4b" }] }));
  });
  await new Promise((resolve) => models.listen(0, "127.0.0.1", resolve));
  const localModelsURL = `http://127.0.0.1:${models.address().port}/v1/models`;
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));

  const child = spawn(process.execPath, [brokerScript, "serve"], {
    env: { ...process.env, HOME: home, OPENCODE_BROKER_LOCAL_MODELS_URL: localModelsURL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => { if (String(c).includes("listening on ")) resolve(); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
  });
  const socketPath = join(home, ".local/share/opencode/model-routing/broker.sock");

  try {
    const sized = await post(socketPath, "/preview", { profile: "auto", tiers: ["classifier"], contextTokens: 1100 });
    assert.equal(sized.preview.classifier?.id, "local-classifier",
      "a declared size must let the local-first lane preview its real destination");

    const unsized = await post(socketPath, "/preview", { profile: "auto", tiers: ["classifier"] });
    assert.notEqual(unsized.preview.classifier?.id, "local-classifier",
      "with no size declared a local target is correctly ineligible, exactly as /lease treats it");

    // A garbage size must not be read as zero -- that would admit a local target on
    // a request whose real size is unknown.
    const bogus = await post(socketPath, "/preview", { profile: "auto", tiers: ["classifier"], contextTokens: "not-a-number" });
    assert.notEqual(bogus.preview.classifier?.id, "local-classifier");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => models.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
