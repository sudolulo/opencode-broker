// `profileFallbacks` rungs were consulted the instant the primary lane had nothing
// eligible, and "busy" counts as ineligible -- so a rung was an ALTERNATIVE TO WAITING
// rather than an OVERFLOW AFTER WAITING. On a lane whose primary is routinely saturated
// (the fleet's `memory` ingestion lane: 1210 requests in 24h through one 3-slot local
// model) the rung became the common path and took the scarce 27b slot that the vision
// work shares.
//
// `profileFallbackAfterMs` declares how long a request must already have waited before a
// group becomes eligible, so the primary keeps priority and the rung is genuine overflow.
//
// Three defects this file exists to keep fixed:
//   1. delays must travel with their group through normalization -- an emptied group is
//      DELETED at config load, which shifts every later index;
//   2. the delay filter lives at the chooseTarget call site, never inside
//      fallbackTargetGroupsFor, which also feeds the broker's `busy` computation;
//   3. the context-overflow last resort must keep seeing UNFILTERED rungs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

// config.js reads its file once at import time, so the fixture has to be in place first.
const fixturePath = fileURLToPath(new URL("./fixtures/profile-fallback-delay.config.json", import.meta.url));
process.env.OPENCODE_BROKER_CONFIG = fixturePath;

const configUrl = new URL("../lib/config.js", import.meta.url).href;
const { CONFIG } = await import(configUrl);
const R = await import(new URL("../lib/routing.js", import.meta.url).href);

const plain = (groups) => groups.map((group) => [...group]);
const resident = (...modelIDs) => new Set(modelIDs);
const CONTEXT = 100;

// A config load in its own process, so stderr belongs to exactly this config.
const loadConfig = (config) => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-fallback-delay-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { CONFIG } = await import(${JSON.stringify(configUrl)});
    process.stdout.write(JSON.stringify({
      groups: CONFIG.profileFallbacks,
      delays: CONFIG.profileFallbackAfterMs,
    }));
  `], { env: { ...process.env, OPENCODE_BROKER_CONFIG: path }, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(child.status, 0, child.stderr);
  return { ...JSON.parse(child.stdout), stderr: child.stderr };
};

const errorLines = (stderr, needle) => stderr.split("\n").filter((line) => line.includes(needle));

const lanConfig = (extra) => ({
  targets: {
    "lan-a": { providerID: "llamacpp", modelID: "lan-a", kind: "local", capacity: 1, context: 65536 },
    "lan-b": { providerID: "llamacpp", modelID: "lan-b", kind: "local", capacity: 1, context: 65536 },
    "cloud-a": { providerID: "openai", modelID: "cloud-a", kind: "cloud" },
  },
  profiles: { memory: ["lan-a"], assist: ["lan-a"] },
  profileFallbacks: { memory: [["lan-b"]] },
  ...extra,
});

// --- config normalization -------------------------------------------------------

test("a declared delay is normalized alongside its group", () => {
  assert.deepEqual(plain(CONFIG.profileFallbacks.memory), [["lan-rung-a"]]);
  assert.deepEqual([...CONFIG.profileFallbackAfterMs.memory], [300_000]);
  assert.deepEqual([...CONFIG.profileFallbackAfterMs.staged], [60_000, 300_000]);
});

test("a profile with no delay entry keeps today's immediate fallback", () => {
  // ☠️ `assist` fronts voice control and must never wait for its rung.
  assert.deepEqual(plain(CONFIG.profileFallbacks.assist), [["lan-rung-a"]]);
  assert.deepEqual([...CONFIG.profileFallbackAfterMs.assist], [0]);
});

test("☠️ delays are zipped through the group filter, never indexed by authored position", () => {
  // `shifted` authored [[cloud-small](0), [lan-rung-a](300000)] on a LAN profile. The cloud
  // rung is deleted at load, so the surviving rung is index 0 -- and a delay array read by
  // authored position would hand it the 0 that belonged to the rung that no longer exists.
  assert.deepEqual(plain(CONFIG.profileFallbacks.shifted), [["lan-rung-a"]]);
  assert.deepEqual([...CONFIG.profileFallbackAfterMs.shifted], [300_000],
    "the surviving rung keeps ITS OWN delay, not the deleted rung's");
});

test("a delay array shorter than the group array defaults the rest to 0", () => {
  const { groups, delays, stderr } = loadConfig(lanConfig({
    profileFallbacks: { memory: [["lan-b"], ["lan-a"]] },
    profileFallbackAfterMs: { memory: [300_000] },
  }));
  assert.deepEqual(groups.memory, [["lan-b"], ["lan-a"]]);
  assert.deepEqual(delays.memory, [300_000, 0]);
  assert.deepEqual(errorLines(stderr, "profileFallbackAfterMs"), [],
    "a short array is the documented shorthand, not a mistake");
});

test("surplus delay entries are ignored, one error each", () => {
  const { delays, stderr } = loadConfig(lanConfig({
    profileFallbackAfterMs: { memory: [300_000, 60_000, 90_000] },
  }));
  assert.deepEqual(delays.memory, [300_000]);
  assert.equal(errorLines(stderr, "profileFallbackAfterMs.memory").length, 2,
    "one line per surplus entry -- a single summary hides the second bad value");
});

test("a non-array value is ignored entirely, with one error", () => {
  for (const value of [300_000, "300000", { "0": 300_000 }]) {
    const { delays, stderr } = loadConfig(lanConfig({ profileFallbackAfterMs: { memory: value } }));
    assert.deepEqual(delays.memory, [0], `${JSON.stringify(value)} must not delay anything`);
    assert.equal(errorLines(stderr, "profileFallbackAfterMs.memory").length, 1, JSON.stringify(value));
  }
});

test("a delay on a profile with no rungs is ignored, with one error", () => {
  const { delays, stderr } = loadConfig(lanConfig({ profileFallbackAfterMs: { assist: [300_000] } }));
  assert.deepEqual(delays.assist, []);
  assert.equal(errorLines(stderr, "profileFallbackAfterMs.assist").length, 1);
});

test("a delay on an unknown profile is ignored, with one error", () => {
  const { delays, stderr } = loadConfig(lanConfig({ profileFallbackAfterMs: { nonsense: [300_000] } }));
  assert.equal(delays.nonsense, undefined);
  assert.equal(errorLines(stderr, "nonsense").length, 1);
});

test("a non-finite or negative delay is coerced to 0, one error per entry", () => {
  const { delays, stderr } = loadConfig(lanConfig({
    profileFallbacks: { memory: [["lan-b"], ["lan-a"]] },
    profileFallbackAfterMs: { memory: [-1, "later"] },
  }));
  assert.deepEqual(delays.memory, [0, 0]);
  assert.equal(errorLines(stderr, "profileFallbackAfterMs.memory").length, 2);
});

test("a non-object profileFallbackAfterMs map is ignored safely", () => {
  for (const value of [300_000, "memory", []]) {
    const { delays, stderr } = loadConfig(lanConfig({ profileFallbackAfterMs: value }));
    assert.deepEqual(delays.memory, [0]);
    assert.equal(errorLines(stderr, "profileFallbackAfterMs must be an object").length, 1);
  }
});

// Ordinary selection: a rung is only a candidate once the caller has waited out its delay.
// The primary is held full so that every one of these turns on the rung alone.
const fullPrimary = { "lan-primary": 1 };
const lanResident = resident("lan-primary-9b", "lan-rung-a-27b", "lan-rung-b-4b");

const choose = (profile, waitedMs) =>
  R.chooseTarget({
    profile,
    tier: "worker",
    active: fullPrimary,
    localModels: lanResident,
    contextTokens: CONTEXT,
    ...(waitedMs === undefined ? {} : { waitedMs }),
  });

test("a delayed rung is not selected before its threshold", () => {
  assert.equal(choose("memory", 299_999), null);
});

test("a delayed rung is selected at its threshold", () => {
  assert.equal(choose("memory", 300_000).target.id, "lan-rung-a");
});

test("a rung with no delay entry is selected immediately", () => {
  assert.equal(choose("assist", 0).target.id, "lan-rung-a");
});

test("staged rungs open in order and the earliest eligible group keeps winning", () => {
  assert.equal(choose("staged", 59_999), null);
  assert.equal(choose("staged", 60_000).target.id, "lan-rung-a");
  assert.equal(choose("staged", 299_999).target.id, "lan-rung-a");
  // Both groups are open here; filtering preserves group order, so the earliest still wins.
  assert.equal(choose("staged", 300_000).target.id, "lan-rung-a");
});

test("a non-monotonic delay list serves whichever rung is open", () => {
  assert.equal(choose("wobbly", 0).target.id, "lan-rung-b");
  assert.equal(choose("wobbly", 900_000).target.id, "lan-rung-a");
});

test("an omitted waitedMs behaves as zero elapsed", () => {
  assert.equal(choose("memory", undefined), null);
});

// The last-resort rescue for an oversized session must keep seeing EVERY rung, delayed or not.
// It is the one path whose refusal is unrecoverable: the session cannot run and cannot compact.
test("context-overflow rescue keeps seeing unfiltered delayed rungs", () => {
  const choice = R.chooseTarget({
    profile: "overflow",
    tier: "worker",
    active: {},
    contextTokens: 100_000,
    waitedMs: 0,
  });
  assert.equal(choice.target.id, "cloud-big");
  // Pin the path as well as the target: cloud-big is only reachable here THROUGH the rescue,
  // because its 300000ms delay excludes it from ordinary selection at waitedMs 0. Without this
  // the test would still pass if the delay filter were removed altogether.
  assert.equal(choice.decision.policy, "context-overflow-last-resort");
});

// --- The value has to survive the trip from the gateway, not just work inside chooseTarget. ---
// These run a REAL broker: an implementation that adds waitedMs to chooseTarget but drops it in
// the lease handler passes every unit test above and is completely inert in production.
const brokerScript = fileURLToPath(new URL("../bin/opencode-broker", import.meta.url));

const postRaw = (socketPath, path, payload) => new Promise((resolve, reject) => {
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

const post = (socketPath, path, body = {}) => postRaw(socketPath, path, JSON.stringify(body));

const withBroker = async ({ resident = () => [] } = {}, run) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-delay-broker-"));
  const models = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: resident().map((id) => ({ id, status: { value: "loaded" } })) }));
  });
  await new Promise((resolve) => models.listen(0, "127.0.0.1", resolve));
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
  const env = {
    ...process.env, HOME: home,
    OPENCODE_BROKER_CONFIG: fixturePath,
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
    return await run({ socketPath: join(home, ".local/share/opencode/model-routing/broker.sock"), home, env });
  } finally {
    child.kill("SIGKILL");
    models.close();
    rmSync(home, { recursive: true, force: true });
  }
};

test("a delayed rung is a wait before its threshold and a lease after it", async () => {
  await withBroker({ resident: () => ["lan-primary-9b", "lan-rung-a-27b"] }, async ({ socketPath }) => {
    const holder = await post(socketPath, "/lease", {
      sessionID: "ses-holder", profile: "memory", tier: "worker", contextTokens: CONTEXT,
    });
    assert.equal(holder.statusCode, 200);
    assert.equal(holder.body.target.id, "lan-primary");

    const early = await post(socketPath, "/lease", {
      sessionID: "ses-memory-early", profile: "memory", tier: "worker", contextTokens: CONTEXT, waitedMs: 299_999,
    });
    assert.equal(early.statusCode, 400);
    // ☆ A wait, NOT a refusal: the delayed rung must stay visible to the busy computation,
    // or a caller that should keep waiting is told to give up instead.
    assert.equal(early.body.code, "target-busy");

    const elapsed = await post(socketPath, "/lease", {
      sessionID: "ses-memory-elapsed", profile: "memory", tier: "worker", contextTokens: CONTEXT, waitedMs: 300_000,
    });
    assert.equal(elapsed.statusCode, 200);
    assert.equal(elapsed.body.target.id, "lan-rung-a");
  });
});

// The busy computation reads targetEligibleIDsFor(), which is deliberately NOT delay-filtered.
// If a future change moved the delay filter down into fallbackTargetGroupsFor(), the rung would
// vanish from busy and a caller that should keep waiting would be told no target exists at all.
// Naming both models in the refusal is the direct evidence that the delayed rung is still counted.
test("a delayed rung that is full still counts as busy, not as a missing target", async () => {
  await withBroker({ resident: () => ["lan-primary-9b", "lan-rung-a-27b"] }, async ({ socketPath }) => {
    const primary = await post(socketPath, "/lease", {
      sessionID: "ses-fill-primary", profile: "memory", tier: "worker", contextTokens: CONTEXT,
    });
    assert.equal(primary.body.target.id, "lan-primary");
    const rung = await post(socketPath, "/lease", {
      sessionID: "ses-fill-rung", profile: "memory", tier: "worker", contextTokens: CONTEXT, waitedMs: 300_000,
    });
    assert.equal(rung.body.target.id, "lan-rung-a");

    const refused = await post(socketPath, "/lease", {
      sessionID: "ses-both-full", profile: "memory", tier: "worker", contextTokens: CONTEXT, waitedMs: 0,
    });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.body.code, "target-busy");
    assert.match(refused.body.error, /lan-primary-9b and lan-rung-a-27b are busy/);
  });
});

test("an invalid waitedMs is refused rather than silently read as elapsed", async () => {
  await withBroker({ resident: () => ["lan-primary-9b", "lan-rung-a-27b"] }, async ({ socketPath }) => {
    for (const waitedMs of [-1, "300000", null]) {
      const res = await post(socketPath, "/lease", {
        sessionID: "ses-bad", profile: "memory", tier: "worker", contextTokens: CONTEXT, waitedMs,
      });
      assert.equal(res.statusCode, 400, `waitedMs=${JSON.stringify(waitedMs)}`);
      assert.match(res.body.error, /waitedMs must be a non-negative finite number/);
    }
    // JSON.stringify(Infinity) emits `null`, so the only way to exercise the non-finite branch
    // is a raw body: JSON.parse turns 1e309 into Infinity.
    const infinite = await postRaw(socketPath, "/lease",
      '{"sessionID":"ses-inf","profile":"memory","tier":"worker","contextTokens":100,"waitedMs":1e309}');
    assert.equal(infinite.statusCode, 400);
    assert.match(infinite.body.error, /waitedMs must be a non-negative finite number/);
  });
});

test("context pressure keeps the elapsed wait when it re-selects on a roomier set", async () => {
  await withBroker({ resident: () => ["lan-rung-a-27b"] }, async ({ socketPath }) => {
    const res = await post(socketPath, "/lease", {
      sessionID: "ses-pressured", profile: "pressured", tier: "worker", contextTokens: 6000, waitedMs: 300_000,
    });
    assert.equal(res.statusCode, 200);
    // Only reachable if waitedMs rode `...selection` into the SECOND chooseTarget call.
    assert.equal(res.body.target.id, "lan-rung-a");
  });
});

test("preview names a delayed rung instead of implying no fallback exists", async () => {
  await withBroker({ resident: () => ["lan-primary-9b", "lan-rung-a-27b"] }, async ({ socketPath }) => {
    await post(socketPath, "/lease", {
      sessionID: "ses-preview-holder", profile: "memory", tier: "worker", contextTokens: CONTEXT,
    });
    const res = await post(socketPath, "/preview", { profile: "memory", tiers: ["worker"], contextTokens: CONTEXT });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.preview.worker, null);
    assert.deepEqual(res.body.delayedProfileFallbacks, [{ targetIDs: ["lan-rung-a"], afterMs: 300_000 }]);
  });
});
