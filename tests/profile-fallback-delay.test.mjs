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
