// A restrictive profile could not fall back AT ALL: fallbackTargetGroupsFor returned []
// for anything but `auto`, so a profile was exactly its configured lane and nothing else.
// `uncensored` is one local target at capacity 1, and the night that model was not
// resident every request on the profile hard-failed with no rung to fall to. `local` and
// `private` are armed the same way -- both their targets are local, and a model that
// wants both GPUs evicts both at once.
//
// The rungs are config data, and the interesting half of this file is what the config
// layer REFUSES to load: a LAN profile's rung may not name a cloud target, because a
// privacy profile that quietly fails over to a paid API is worse than the error it was
// trying to avoid.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

// Route the config loader at the fixture BEFORE any router module loads -- config.js
// reads its file once at import time.
const fixturePath = fileURLToPath(new URL("./fixtures/profile-fallback.config.json", import.meta.url));
process.env.OPENCODE_BROKER_CONFIG = fixturePath;

const { CONFIG } = await import(new URL("../lib/config.js", import.meta.url).href);
const R = await import(new URL("../lib/routing.js", import.meta.url).href);

const plain = (groups) => groups.map((group) => [...group]);
const resident = (...modelIDs) => new Set(modelIDs);
const CONTEXT = 100;

// --- what the config layer will and will not load -------------------------------

test("a LAN profile's cloud fallback rung is dropped at config load", () => {
  // `local` asked for [[lan-small], [cloud-worker]]. The second rung is entirely cloud,
  // so it does not survive; the LAN rung in front of it does.
  assert.deepEqual(plain(CONFIG.profileFallbacks.local), [["lan-small"]]);
  // `private` asked for ONE MIXED rung. The rung survives, minus its cloud member --
  // dropping the whole rung would have been the wrong repair (it would throw away a
  // perfectly good LAN target), and keeping the member would be the leak.
  assert.deepEqual(plain(CONFIG.profileFallbacks.private), [["lan-small"]]);
});

test("profileCloudEgress opens the boundary, and never for an offline profile", () => {
  // `uncensored` is named in profileCloudEgress, so its cloud rung is honoured.
  assert.deepEqual(plain(CONFIG.profileFallbacks.uncensored), [["lan-coder"], ["cloud-worker"]]);
  // `uncensored-offline` asks for exactly the same thing and is named in the same
  // allowlist. It is an OFFLINE profile, so the answer is still no.
  assert.deepEqual(plain(CONFIG.profileFallbacks["uncensored-offline"]), [["lan-coder"]]);
  assert.deepEqual([...CONFIG.profileCloudEgress], ["uncensored"],
    "the offline profile must not even appear in the resolved allowlist");
});

test("☠️ an offline profile is closed even when its own lane already leaves the LAN", () => {
  // The second way the boundary opens is "the primary lane already contains a cloud
  // target, so a rung cannot leak anything the primary path is not already sending".
  // That reasoning is sound for `local` and `uncensored` and WRONG for an offline
  // profile, where a cloud primary is itself the misconfiguration -- so offline is
  // refused by both clauses, not just by its exclusion from the allowlist.
  const dir = mkdtempSync(join(tmpdir(), "fleet-offline-lane-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    targets: {
      "lan-uncensored": { providerID: "llamacpp", modelID: "lan-uncensored-27b", kind: "local", capacity: 1, context: 65536 },
      "cloud-worker": { providerID: "openai", modelID: "cloud-worker-1", kind: "cloud" },
    },
    profiles: { "uncensored-offline": ["lan-uncensored", "cloud-worker"] },
    profileFallbacks: { "uncensored-offline": [["cloud-worker"]] },
  }));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { CONFIG } = await import(${JSON.stringify(new URL("../lib/config.js", import.meta.url).href)});
    process.stdout.write(JSON.stringify(CONFIG.profileFallbacks["uncensored-offline"]));
  `], { env: { ...process.env, OPENCODE_BROKER_CONFIG: path }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [], "no rung may survive for an offline profile");
});

test("an egress grant lifts the LAN confinement its lanes inherit -- offline never", () => {
  // profileConfinesToLan is what a lane dispatched on a session's behalf (the guard's
  // classifier) reads to decide whether its own routing may leave the LAN. It has to move
  // with the config, not with the profile's name.
  assert.equal(R.profileConfinesToLan("local"), true);
  assert.equal(R.profileConfinesToLan("private"), true);
  assert.equal(R.profileConfinesToLan("uncensored-offline"), true,
    "an offline profile can never be granted egress, so it can never stop confining");
  assert.equal(R.profileConfinesToLan("uncensored"), false,
    "this fixture granted it egress, and that statement is what governs");
  // ☠️ `manual` reaches no cloud target only because it leases nothing at all. That must
  // never read as a LAN confinement.
  assert.equal(R.profileConfinesToLan("manual"), false);
  assert.equal(R.profileConfinesToLan("auto"), false);
});

test("profileReachesCloud answers from config, not from the profile's name", () => {
  assert.equal(R.profileReachesCloud("local"), false);
  assert.equal(R.profileReachesCloud("private"), false);
  assert.equal(R.profileReachesCloud("uncensored-offline"), false);
  // Still one of the restrictive four by name, but it now holds a cloud rung: a caller
  // that skipped provider admission on the name alone would leave that rung unusable.
  assert.equal(R.profileReachesCloud("uncensored"), true);
  assert.equal(R.profileReachesCloud("auto"), true);
  assert.equal(R.profileReachesCloud("manual"), false);
});

// --- selection ------------------------------------------------------------------

test("a profile degrades to its own rung instead of hard-failing", () => {
  // The primary is not resident -- the outage that started this.
  const choice = R.chooseTarget({
    profile: "local", tier: "worker", localModels: resident("lan-small-4b"), contextTokens: CONTEXT,
  });
  assert.equal(choice?.target?.id, "lan-small");
  assert.equal(choice.decision.policy, "strict-fallback");
  assert.ok(choice.decision.reasons.includes("profile-fallback-rung"),
    "a degraded privacy profile must say so in the decision trail");
});

test("a rung is only reached when the primary lane has nothing", () => {
  const choice = R.chooseTarget({
    profile: "local", tier: "worker",
    localModels: resident("lan-coder-9b", "lan-small-4b"), contextTokens: CONTEXT,
  });
  assert.equal(choice?.target?.id, "lan-coder", "the primary still wins while it is eligible");
  assert.equal(choice.decision.policy, "weighted-depletion");
  assert.equal(choice.decision.reasons.includes("profile-fallback-rung"), false);
});

test("☠️ a LAN-only profile with nothing local left FAILS rather than reaching cloud", () => {
  // cloud-worker is eligible in this call -- it is what `auto` would pick -- and both
  // profiles named it in their config. The right answer is still null: a visible,
  // recoverable error beats a transcript on a paid API that nobody asked for.
  for (const profile of ["local", "private", "uncensored-offline"]) {
    assert.equal(R.chooseTarget({ profile, tier: "worker", localModels: resident(), contextTokens: CONTEXT }), null,
      `${profile} must never fall back off the LAN`);
  }
  // The same call on the profile that was granted egress does reach it.
  assert.equal(
    R.chooseTarget({ profile: "uncensored", tier: "worker", localModels: resident(), contextTokens: CONTEXT })?.target?.id,
    "cloud-worker");
});

test("manual leases nothing, with or without rungs", () => {
  assert.deepEqual(R.targetIDsFor("manual"), []);
  assert.equal(R.chooseTarget({ profile: "manual", tier: "worker", localModels: resident("lan-small-4b"), contextTokens: CONTEXT }), null);
});

test("a fallback target is routable for the held lease that landed on it", () => {
  // targetEligibleFor (broker) revalidates a held lease against this list. Without the
  // rung in it, a session that degraded onto lan-small would be re-selected every turn.
  assert.ok(R.targetEligibleIDsFor("local", "worker").includes("lan-small"));
  assert.equal(R.targetEligibleIDsFor("private", "worker").includes("cloud-worker"), false);
});

test("auto is untouched: it still rides the TIER rungs, and never a profile's", () => {
  const primary = R.chooseTarget({ profile: "auto", tier: "worker", localModels: resident("lan-small-4b"), contextTokens: CONTEXT });
  assert.equal(primary?.target?.id, "cloud-worker");
  const degraded = R.chooseTarget({
    profile: "auto", tier: "worker", localModels: resident("lan-small-4b"), contextTokens: CONTEXT,
    circuits: { "cloud-worker": { until: Date.now() + 60_000 } },
  });
  assert.equal(degraded?.target?.id, "lan-small", "the worker tier's own rung");
  assert.equal(degraded.decision.policy, "strict-fallback");
  assert.equal(degraded.decision.reasons.includes("profile-fallback-rung"), false,
    "the profile marker is for non-auto profiles only");
});

// --- through the real broker ----------------------------------------------------

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

// The whole path, not just the policy helper: the broker decides for itself which
// targets to fetch residency for and which ids a lease may name.
const withBroker = async ({ resident: residentModels }, run) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-profile-fallback-"));
  const models = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: residentModels().map((id) => ({ id, status: { value: "loaded" } })) }));
  });
  await new Promise((resolve) => models.listen(0, "127.0.0.1", resolve));
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
  let stderr = "";
  const child = spawn(process.execPath, [join(fileURLToPath(new URL(".", import.meta.url)), "..", "bin/opencode-broker"), "serve"], {
    env: {
      ...process.env, HOME: home,
      OPENCODE_BROKER_CONFIG: fixturePath,
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
  try {
    return await run({ socketPath: join(home, ".local/share/opencode/model-routing/broker.sock") });
  } finally {
    child.kill("SIGKILL");
    models.close();
  }
};

test("the broker leases a profile's rung when the profile's own model is gone", async () => {
  await withBroker({ resident: () => ["lan-small-4b"] }, async ({ socketPath }) => {
    const lease = await post(socketPath, "/lease", {
      sessionID: "ses_local_a", profile: "local", tier: "worker", contextTokens: CONTEXT,
    });
    assert.equal(lease.target?.id, "lan-small", `expected the rung, got ${JSON.stringify(lease)}`);
    // And it stays leased: the held-lease revalidation has to accept a rung target too.
    const held = await post(socketPath, "/lease", {
      sessionID: "ses_local_a", profile: "local", tier: "worker", contextTokens: CONTEXT,
    });
    assert.equal(held.target?.id, "lan-small");
    assert.equal(held.existing, true);
  });
});

test("☠️ the broker refuses rather than leasing cloud for an offline profile", async () => {
  await withBroker({ resident: () => [] }, async ({ socketPath }) => {
    const lease = await post(socketPath, "/lease", {
      sessionID: "ses_off_a", profile: "uncensored-offline", tier: "worker", contextTokens: CONTEXT,
    });
    assert.ok(lease.error, `an offline profile must fail, not leave the LAN: ${JSON.stringify(lease)}`);
    assert.match(String(lease.error), /no eligible local model/);
  });
});
