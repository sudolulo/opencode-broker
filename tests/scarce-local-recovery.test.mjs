// Two ways a scarce local target becomes unusable with nothing in the routing path able to fix
// it. Both were total outages of a capacity-1 profile, and both reported the same generic
// "no eligible local model is currently deployed, free, or within its context window".
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const here = fileURLToPath(new URL(".", import.meta.url));
const brokerScript = join(here, "..", "bin/opencode-broker");

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

// `loaded` decides residency, so the fake endpoint can put a model on or off the "card".
const withBroker = async ({ config, resident }, run) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-scarce-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const models = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: resident().map((id) => ({ id, status: { value: "loaded" } })) }));
  });
  await new Promise((resolve) => models.listen(0, "127.0.0.1", resolve));
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));

  let stderr = "";
  let child = null;
  // State is persisted and re-read at start, so a restart over the same HOME is how a test ages
  // a lease without a test-only seam in the broker -- and it exercises the real reload path.
  const start = async () => {
    child = spawn(process.execPath, [brokerScript, "serve"], {
      env: {
        ...process.env, HOME: home,
        OPENCODE_BROKER_CONFIG: configPath,
        OPENCODE_BROKER_LOCAL_MODELS_URL: `http://127.0.0.1:${models.address().port}/v1/models`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (c) => { if (String(c).includes("listening on ")) resolve(); });
      child.stderr.on("data", (c) => { stderr += String(c); });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
    });
  };
  const restart = async () => {
    await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });
    await start();
  };
  await start();
  try {
    return await run({ socketPath: join(home, ".local/share/opencode/model-routing/broker.sock"), home, restart, stderr: () => stderr });
  } finally {
    child?.kill("SIGKILL");
    models.close();
  }
};

const baseConfig = (targetExtras = {}) => ({
  targets: {
    "uncensored-qwen": {
      providerID: "llamacpp", modelID: "qwen3.8-27b-uncensored",
      kind: "local", capacity: 1, context: 65536, ...targetExtras,
    },
  },
  tiers: { worker: [] },
  profiles: { uncensored: ["uncensored-qwen"] },
  localContextHeadroom: 0.6,
});

// `/new` navigates away mid-turn and the opencode holding the route can be quit outright, so
// session.idle never fires and the plugin never calls /forget. At capacity 1 the abandoned
// lease then blocked the profile for the full two-hour LEASE_TTL_MS.
test("an idle lease on a full local target is reclaimed for the next session", async () => {
  await withBroker({ config: baseConfig(), resident: () => ["qwen3.8-27b-uncensored"] }, async ({ socketPath, home, restart }) => {
    const first = await post(socketPath, "/lease", { sessionID: "ses_abandoned", profile: "uncensored", tier: "worker", contextTokens: 100 });
    assert.equal(first.target?.id, "uncensored-qwen", "the first session takes the only slot");

    const blocked = await post(socketPath, "/lease", { sessionID: "ses_new", profile: "uncensored", tier: "worker", contextTokens: 100 });
    assert.ok(blocked.error, "a FRESH holder must still block: reclaim is not a free-for-all");

    // Age the abandoned lease past the reclaim threshold, exactly as walking away would.
    const statePath = join(home, ".local/share/opencode/model-routing/broker.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.leases.ses_abandoned.touchedAt = Date.now() - 13 * 60 * 1000;
    writeFileSync(statePath, JSON.stringify(state));
    await restart();

    const recovered = await post(socketPath, "/lease", { sessionID: "ses_new", profile: "uncensored", tier: "worker", contextTokens: 100 });
    assert.equal(recovered.target?.id, "uncensored-qwen", "the quiet lease is reclaimed and the new session gets the slot");
  });
});

// A local model can be swapped off its card by a cardmate, an idle timer or a restart. Nothing
// in the routing path could put it back, so every session on a local-only profile stayed stuck.
test("a non-resident local target runs its prepareCommand and says to resend", async () => {
  const marker = join(mkdtempSync(join(tmpdir(), "fleet-prepare-")), "ran");
  const config = baseConfig({ prepareCommand: ["/bin/sh", "-c", `touch ${marker}`] });
  await withBroker({ config, resident: () => [] }, async ({ socketPath }) => {
    const refused = await post(socketPath, "/lease", { sessionID: "ses_a", profile: "uncensored", tier: "worker", contextTokens: 100 });
    assert.match(String(refused.error), /not resident; preparing it now -- resend the prompt/,
      "the refusal must say what is happening, not the generic no-eligible-target string");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(existsSync(marker), "prepareCommand actually ran");

    // ☠️ A session retrying every few seconds must not queue a swap per attempt.
    const again = await post(socketPath, "/lease", { sessionID: "ses_a", profile: "uncensored", tier: "worker", contextTokens: 100 });
    assert.match(String(again.error), /still preparing it/, "the second refusal reports in-flight, and spawns nothing new");
  });
});

// Without a prepareCommand the old generic reason must survive verbatim -- a target that simply
// has no way to make itself resident is not a new failure mode and must not read like one.
test("a non-resident target with no prepareCommand keeps the original reason", async () => {
  await withBroker({ config: baseConfig(), resident: () => [] }, async ({ socketPath }) => {
    const refused = await post(socketPath, "/lease", { sessionID: "ses_a", profile: "uncensored", tier: "worker", contextTokens: 100 });
    assert.match(String(refused.error), /no eligible local model is currently deployed, free, or within its context window/);
  });
});
