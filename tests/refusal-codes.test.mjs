// A /lease refusal used to be prose and nothing else, so a caller that needed to tell
// "the model is being swapped in, keep waiting" from "there is no target for you, give up"
// had to regex the message -- which makes the wording an unversioned API nobody may fix.
// The HUD had grown its own copy of the socket transport just to recover the distinction.
//
// Every case here pins BOTH halves: the machine-readable code, and the human string
// staying byte-identical to what it has always been.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const here = fileURLToPath(new URL(".", import.meta.url));
const brokerScript = join(here, "..", "bin/opencode-broker");
const clientUrl = new URL("../lib/client.js", import.meta.url).href;

// The two wordings that already existed. ☠️ Byte-identical, or clients that read them --
// logs, lastDecision.reasons[0], the HUD's current match -- break on the way to the codes.
const NO_LOCAL = "no eligible local model is currently deployed, free, or within its context window";
const NO_TARGET = "all lightweight routing targets are busy or unavailable";

const post = (socketPath, path, body = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = http.request({
    socketPath, path, method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { text += c; });
    res.on("end", () => { try { resolve({ statusCode: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
  });
  req.on("error", reject);
  req.end(payload);
});

const config = (marker) => ({
  targets: {
    // The profile target that has to be swapped onto its card before it can serve.
    "swap-me": {
      providerID: "llamacpp", modelID: "swap-model", kind: "local", capacity: 1, context: 65536,
      prepareCommand: ["/bin/sh", "-c", `touch ${marker}`],
    },
    "lan-solo": { providerID: "llamacpp", modelID: "lan-solo", kind: "local", capacity: 1, context: 65536 },
    "lan-extra": { providerID: "llamacpp", modelID: "lan-extra", kind: "local", capacity: 1, context: 65536 },
    "cloud-a": { providerID: "openai", modelID: "cloud-a-1", kind: "cloud" },
    "cloud-b": { providerID: "openai", modelID: "cloud-b-1", kind: "cloud" },
  },
  tiers: { worker: ["cloud-a", "cloud-b"] },
  // A local rung under a cloud-only lane: the shape a local-only request has to be able
  // to reach, and the shape that proves the rung is what answered.
  fallbacks: { worker: [["lan-solo"]] },
  profiles: {
    uncensored: ["swap-me"],
    local: ["lan-solo"],
    private: ["lan-solo", "lan-extra"],
  },
  localContextHeadroom: 0.6,
});

const withBroker = async ({ resident = () => [], auth = true } = {}, run) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-refusal-"));
  const marker = join(home, "prepared");
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify(config(marker)));
  const models = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: resident().map((id) => ({ id, status: { value: "loaded" } })) }));
  });
  await new Promise((resolve) => models.listen(0, "127.0.0.1", resolve));
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  if (auth) writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
  const env = {
    ...process.env, HOME: home,
    OPENCODE_BROKER_CONFIG: configPath,
    OPENCODE_BROKER_LOCAL_MODELS_URL: `http://127.0.0.1:${models.address().port}/v1/models`,
  };
  let stderr = "";
  const child = spawn(process.execPath, [brokerScript, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (c) => { if (String(c).includes("listening on ")) resolve(); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`broker exited before listen (${code}): ${stderr}`)));
  });
  try {
    return await run({ socketPath: join(home, ".local/share/opencode/model-routing/broker.sock"), home, env, marker });
  } finally {
    child.kill("SIGKILL");
    models.close();
    rmSync(home, { recursive: true, force: true });
  }
};

test("target-preparing covers BOTH prepare wordings and names the model", async () => {
  // This is also the shape a COMPACTION turn takes on an uncensored session: it follows
  // the profile, so mid-swap it must get the retryable refusal and succeed on the next
  // turn, rather than anything terminal.
  await withBroker({ resident: () => [] }, async ({ socketPath }) => {
    const first = await post(socketPath, "/lease", { sessionID: "ses_a", profile: "uncensored", tier: "worker", contextTokens: 100 });
    assert.equal(first.body.code, "target-preparing");
    assert.equal(first.body.error, "swap-model is not resident; preparing it now -- resend the prompt in a moment");
    assert.equal(first.body.targetID, "swap-me");
    assert.equal(first.body.modelID, "swap-model");

    // ☆ The second wording. A human wants to know whether this call started the swap; a
    // client does not, and splitting the codes would push it back into matching prose.
    const second = await post(socketPath, "/lease", { sessionID: "ses_a", profile: "uncensored", tier: "worker", contextTokens: 100 });
    assert.equal(second.body.code, "target-preparing");
    assert.equal(second.body.error, "swap-model is not resident; still preparing it -- resend the prompt in a moment");
    assert.equal(second.body.targetID, "swap-me");
  });
});

test("no-eligible-local-target, with the single target it refers to", async () => {
  await withBroker({ resident: () => [] }, async ({ socketPath }) => {
    const one = await post(socketPath, "/lease", { sessionID: "ses_b", profile: "local", tier: "worker", contextTokens: 100 });
    assert.equal(one.body.code, "no-eligible-local-target");
    assert.equal(one.body.error, NO_LOCAL);
    assert.equal(one.body.targetID, "lan-solo");
    assert.equal(one.body.modelID, "lan-solo");

    // Two targets wanted: no single one is the subject, so neither field is sent. A client
    // must not require them.
    const two = await post(socketPath, "/lease", { sessionID: "ses_c", profile: "private", tier: "worker", contextTokens: 100 });
    assert.equal(two.body.code, "no-eligible-local-target");
    assert.equal(two.body.error, NO_LOCAL);
    assert.equal(two.body.targetID, undefined);
    assert.equal(two.body.modelID, undefined);
  });
});

test("no-eligible-target is the mixed/cloud case", async () => {
  await withBroker({ resident: () => [] }, async ({ socketPath }) => {
    // A providers allowlist that matches nothing leaves the lane with no eligible target
    // and nothing local to blame it on -- the mixed/cloud shape of the refusal.
    const refused = await post(socketPath, "/lease", {
      sessionID: "ses_d", profile: "auto", tier: "worker", contextTokens: 100, providers: ["nobody"],
    });
    assert.equal(refused.body.code, "no-eligible-target", JSON.stringify(refused.body));
    assert.equal(refused.body.error, NO_TARGET);
    assert.equal(refused.body.targetID, undefined);
  });
});

test("the recorded decision carries the code too", async () => {
  await withBroker({ resident: () => [] }, async ({ socketPath }) => {
    await post(socketPath, "/lease", { sessionID: "ses_e", profile: "local", tier: "worker", contextTokens: 100 });
    // /selection is where refusals get read after the fact -- until now, by eye.
    const selection = await post(socketPath, "/selection", {});
    assert.equal(selection.body.lastDecision?.policy, "refused");
    assert.equal(selection.body.lastDecision?.code, "no-eligible-local-target");
    assert.deepEqual(selection.body.lastDecision?.reasons, [NO_LOCAL]);
    assert.equal(selection.body.lastDecision?.targetID, null,
      "targetID on a decision means the target that was LEASED, and a refusal leased nothing");
  });
});

test("a refusal outside the closed set carries NO code at all", async () => {
  // The auth-store refusal fits none of the three. Absence is the honest answer and the
  // signal consumers read as "final"; a fourth code invented at the call site would not be.
  await withBroker({ resident: () => [], auth: false }, async ({ socketPath }) => {
    const refused = await post(socketPath, "/lease", { sessionID: "ses_f", profile: "auto", tier: "worker", contextTokens: 100 });
    assert.equal(refused.body.error, "no readable auth.json; cloud routing needs credentials");
    assert.equal(refused.body.code, undefined);
    // And a plain validation error is not a routing refusal either.
    const invalid = await post(socketPath, "/lease", { sessionID: "ses_g", profile: "nonsense", tier: "worker" });
    assert.equal(invalid.body.error, "invalid routing profile");
    assert.equal(invalid.body.code, undefined);
  });
});

test("a local-only request stays on the LAN, and is refused as a LOCAL failure", async () => {
  // The egress boundary a caller carries for content that may not leave the LAN. It
  // narrows like the providers allowlist and can never widen.
  await withBroker({ resident: () => ["lan-solo"] }, async ({ socketPath }) => {
    // ☠️ The only local target in this lane is in a FALLBACK rung, and residency is
    // otherwise only fetched when the lane's own targets include a local one -- so without
    // that, a local-only lease could never succeed here at all.
    const leased = await post(socketPath, "/lease", { sessionID: "ses_h", profile: "auto", tier: "worker", contextTokens: 100, localOnly: true });
    assert.equal(leased.body.target?.id, "lan-solo", `expected the local rung, got ${JSON.stringify(leased.body)}`);
    assert.equal(leased.body.target?.kind, "local");
  });
  await withBroker({ resident: () => [] }, async ({ socketPath }) => {
    const refused = await post(socketPath, "/lease", { sessionID: "ses_i", profile: "auto", tier: "worker", contextTokens: 100, localOnly: true });
    assert.equal(refused.body.code, "no-eligible-local-target",
      "a local-only request that cannot be served is a LOCAL failure, whatever the lane holds");
    assert.equal(refused.body.error, NO_LOCAL);
  });
});

// --- the client half -------------------------------------------------------------
//
// Structure on the wire is worth nothing if brokerRequest throws it away rebuilding the
// Error, which is what drove one consumer to re-implement this transport.

const clientProbe = async (env, body) => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { brokerRequest } = await import(${JSON.stringify(clientUrl)});
    try {
      await brokerRequest("/lease", ${JSON.stringify(body)});
      process.stdout.write(JSON.stringify({ threw: false }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        threw: true,
        message: error.message,
        code: error.code,
        targetID: error.targetID,
        modelID: error.modelID,
        hasCode: Object.prototype.hasOwnProperty.call(error, "code"),
      }));
    }
  `], { env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};

test("brokerRequest hands the caller the code, with the message untouched", async () => {
  await withBroker({ resident: () => [] }, async ({ env }) => {
    const refusal = await clientProbe(env, { sessionID: "ses_j", profile: "uncensored", tier: "worker", contextTokens: 100 });
    assert.equal(refusal.threw, true);
    assert.equal(refusal.code, "target-preparing");
    assert.equal(refusal.targetID, "swap-me");
    assert.equal(refusal.modelID, "swap-model");
    assert.equal(refusal.message, "swap-model is not resident; preparing it now -- resend the prompt in a moment",
      "☠️ shown to users verbatim and written to logs: not one byte may move");

    // ☠️ An uncoded refusal must leave `code` UNDEFINED and unset -- consumers read the
    // absence as "final, do not wait", so an empty string or a default would be worse
    // than nothing.
    const invalid = await clientProbe(env, { sessionID: "ses_k", profile: "nonsense", tier: "worker" });
    assert.equal(invalid.threw, true);
    assert.equal(invalid.message, "invalid routing profile");
    assert.equal(invalid.code, undefined);
    assert.equal(invalid.hasCode, false, "the property must be absent, not present-and-empty");
  });
});

// ☠️ A wait is not a refusal. `target-preparing` clears itself -- the local model is
// loading and the same prompt routes on the retry -- while a refusal is terminal and
// needs the caller to change something. Filing both under `refused` made the decision
// log read as a 43% failure rate on the uncensored profile when nothing had failed.
test("a preparing target records policy 'waiting', not 'refused'", async () => {
  await withBroker({ resident: () => [] }, async ({ socketPath }) => {
    const lease = await post(socketPath, "/lease", {
      sessionID: "ses_wait", profile: "uncensored", tier: "worker", contextTokens: 100,
    });
    assert.equal(lease.body.code, "target-preparing", JSON.stringify(lease.body));
    const selection = await post(socketPath, "/selection", {});
    assert.equal(selection.body.lastDecision?.policy, "waiting");
    assert.equal(selection.body.lastDecision?.code, "target-preparing");
    assert.equal(selection.body.lastDecision?.targetID, null);
  });
});

test("a genuine dead end is still 'refused'", async () => {
  await withBroker({ resident: () => [] }, async ({ socketPath }) => {
    await post(socketPath, "/lease", { sessionID: "ses_dead", profile: "local", tier: "worker", contextTokens: 100 });
    const selection = await post(socketPath, "/selection", {});
    assert.equal(selection.body.lastDecision?.policy, "refused");
    assert.equal(selection.body.lastDecision?.code, "no-eligible-local-target");
  });
});

// ☠️ FULL IS NOT GONE. A resident local model refused only because every slot is taken used
// to be "no eligible local model" -- a terminal refusal -- and the work was dropped: 992
// times in three days. It is a WAIT now, with its own code, so a client retries into the
// next free slot. A model that is not loaded at all is still a refusal.
test("target-busy: a resident local model with every slot taken is a wait, not a refusal", async () => {
  await withBroker({ resident: () => ["lan-solo"] }, async ({ socketPath }) => {
    const held = await post(socketPath, "/lease", { sessionID: "ses-holder", profile: "local", tier: "worker", replace: true, contextTokens: 100 });
    assert.equal(held.statusCode, 200, JSON.stringify(held.body));
    const waiting = await post(socketPath, "/lease", { sessionID: "ses-waiter", profile: "local", tier: "worker", replace: true, contextTokens: 100 });
    assert.equal(waiting.statusCode, 400);
    assert.equal(waiting.body.code, "target-busy");
    assert.equal(waiting.body.targetID, "lan-solo");
    assert.match(waiting.body.error, /lan-solo is busy \(every slot in use\); waiting for a free slot -- resend the prompt in a moment/);
    const selection = await post(socketPath, "/selection");
    assert.equal(selection.body.lastDecision?.policy, "waiting", "a wait is not filed as a refusal");

    // The slot frees: the waiter gets it on the retry.
    await post(socketPath, "/forget", { sessionID: "ses-holder" });
    const granted = await post(socketPath, "/lease", { sessionID: "ses-waiter", profile: "local", tier: "worker", replace: true, contextTokens: 100 });
    assert.equal(granted.statusCode, 200);
    assert.equal(granted.body.target.id, "lan-solo");
  });
});

test("a local model that is not loaded at all is still a refusal, not a wait", async () => {
  await withBroker({ resident: () => [] }, async ({ socketPath }) => {
    const refused = await post(socketPath, "/lease", { sessionID: "ses-nothing", profile: "local", tier: "worker", replace: true, contextTokens: 100 });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.body.code, "no-eligible-local-target");
  });
});
