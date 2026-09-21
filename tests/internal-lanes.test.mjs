// A routing profile is a statement about the USER'S conversation, and the rule for a lane
// the machinery dispatches for itself turns on what that lane PROCESSES:
//
//     A lane that processes the CONVERSATION follows the conversation's profile.
//     A lane that processes something else routes ordinarily, but never outside
//     the profile's egress boundary.
//
// `compaction` summarises the transcript and its summary REPLACES it, so it follows the
// profile: under `uncensored` it runs on the uncensored target, because a censored model
// asked to compact that conversation may refuse or quietly sanitise, and a sanitised
// summary is permanent and silent.
// `fleet-classifier*` classifies a shell command, which has nothing to do with the
// conversation's model class, so it takes its own tier -- but the command line is still
// the user's content, so it may not leave the LAN under a restrictive profile.
//
// Inheriting the profile took the gate down on 2026-09-07:
//
//   15:05:34 INFO  stream providerID=llamacpp modelID=qwen3.5-4b agent=fleet-classifier-local
//   15:05:34 ERROR process error="[opencode-broker] route unavailable; resend the prompt"
//                  at chat.params (plugin/router.js:623:30)
//
// Five classifier sessions died that way in 30 seconds, and the guard fails closed on an
// unreachable classifier -- so it denied the user's shell commands. Two distinct defects:
//   1. a classifier lane is deliberately NOT routed (it is pinned in its own frontmatter),
//      and chat.params threw on the missing route entry;
//   2. the classifier child inherited its parent's profile, so under `uncensored` it was
//      aimed at one local model at capacity 1 that the user's own turn already held.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Every profile in this fixture is LAN-only -- no `profileCloudEgress`, which is the
// default and the fleet's real shape.
process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/internal-lanes.config.json", import.meta.url).pathname;

const routingUrl = new URL("../lib/routing.js", import.meta.url).href;
const pluginUrl = new URL("../plugin/router.js", import.meta.url).href;

// HOME is read when lib/routing.js computes its state root, so every profile-record test
// runs in a child process with HOME already pointed at a scratch directory.
const inTempHome = (script) => {
  const home = mkdtempSync(join(tmpdir(), "fleet-internal-lane-"));
  mkdirSync(join(home, ".cache/opencode"), { recursive: true });
  writeFileSync(join(home, ".cache/opencode/models.json"), "{}\n");
  mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
  writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" } }));
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home }, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

// A broker on a fake socket that records what was asked of it. Same shape the other plugin
// suites use: opencode's own client is mocked, node:http is not real.
const FAKE_BROKER = `
  import { createRequire } from "node:module";
  import { EventEmitter } from "node:events";
  const http = createRequire(import.meta.url)("node:http");
  const calls = [];
  http.request = (options, callback) => {
    const request = new EventEmitter();
    request.end = (payload = "") => {
      let body = {};
      try { body = payload ? JSON.parse(payload) : {}; } catch {}
      calls.push({ path: options.path, body });
      const answer = options.path === "/lease"
        ? { target: { id: "lan-uncensored", model: { providerID: "llamacpp", id: "lan-uncensored-27b" }, kind: "local" }, existing: false }
        : { changed: false };
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.emit("data", JSON.stringify(answer));
      response.emit("end");
    };
    request.destroy = () => {};
    request.setTimeout = () => {};
    request.on = EventEmitter.prototype.on;
    return request;
  };
`;

test("a classifier lane resolves before every profile record; compaction does not", () => {
  const result = inTempHome(`
    import { resolveProfile, writeSessionProfile, writePendingProfile, readPendingProfile, consumePendingProfile } from ${JSON.stringify(routingUrl)};
    writeSessionProfile("ses-user", "uncensored", { explicit: true });
    // Exactly what session.created used to persist onto the classifier child.
    writeSessionProfile("ses-classifier", "uncensored", { explicit: false });
    const out = {
      // Its OWN record says uncensored. Resolution ORDER is the only thing that can
      // separate a lane session from the profile it was handed.
      classifierWithRecord: resolveProfile({ sessionID: "ses-classifier", parentID: "ses-user", agent: "fleet-classifier-local" }),
      // A lane added later is covered by the prefix, on the day it is added.
      classifierFuture: resolveProfile({ sessionID: "ses-new", parentID: "ses-user", agent: "fleet-classifier-invented-tomorrow" }),
      // ☠️ compaction is NOT exempt: it processes the conversation, so it follows it.
      compaction: resolveProfile({ sessionID: "ses-user", agent: "compaction" }),
      // The guard must not touch ordinary delegation either: a subagent is the user's work.
      subagent: resolveProfile({ sessionID: "ses-child", parentID: "ses-user", agent: "reviewer" }),
    };
    // ☠️ An ARMED start-screen choice must not behave like the global default it replaced.
    // Arming is a message to session.created -- "put this on the ONE session you make
    // next" -- and resolution must stay blind to it, or it becomes the same standing
    // posture inherited by every session that never set its own.
    writePendingProfile("uncensored");
    out.armedIsVisible = readPendingProfile()?.profile ?? null;
    out.classifierUnderArmed = resolveProfile({ sessionID: "ses-fresh", agent: "fleet-classifier-local" });
    out.userUnderArmed = resolveProfile({ sessionID: "ses-fresh2", agent: "standard" });
    // And it reaches exactly ONE consumer.
    out.firstConsume = consumePendingProfile()?.profile ?? null;
    out.secondConsume = consumePendingProfile()?.profile ?? null;
    process.stdout.write(JSON.stringify(out));
  `);
  assert.equal(result.classifierWithRecord.profile, "auto");
  assert.equal(result.classifierWithRecord.source, "internal-lane");
  assert.equal(result.classifierFuture.profile, "auto");
  assert.equal(result.classifierUnderArmed.profile, "auto");
  assert.equal(result.compaction.profile, "uncensored",
    "☠️ a censored model must never compact an uncensored conversation");
  assert.equal(result.subagent.profile, "uncensored", "ordinary delegation still inherits");
  assert.equal(result.armedIsVisible, "uncensored", "the HUD must be able to show what is armed");
  assert.equal(result.userUnderArmed.profile, "auto",
    "☠️ an armed choice must NOT resolve as a default -- that is the global profile all over again");
  assert.equal(result.firstConsume, "uncensored", "the armed choice reaches the next session created");
  assert.equal(result.secondConsume, null, "and nothing after it");
});

test("☠️ a classifier lane keeps its pin AND its turn survives chat.params", () => {
  const result = inTempHome(`
    ${FAKE_BROKER}
    import { resolveProfile, writeSessionProfile } from ${JSON.stringify(routingUrl)};
    import { ModelRouter } from ${JSON.stringify(pluginUrl)};
    writeSessionProfile("ses-user", "uncensored", { explicit: true });
    const sessions = {
      "ses-user": { id: "ses-user", agent: "standard" },
      "ses-classifier": { id: "ses-classifier", parentID: "ses-user", agent: "fleet-classifier-local" },
    };
    const hooks = await ModelRouter({ client: { session: {
      get: async ({ path }) => sessions[path.id],
      messages: async () => ({ data: [] }),
    } }, directory: process.env.HOME });
    // The session.created the guard's child raises, carrying its agent.
    await hooks.event({ event: { type: "session.created", properties: { info: sessions["ses-classifier"] } } });
    const afterCreated = resolveProfile({ sessionID: "ses-classifier" });
    // ☠️ session.created does not always carry the agent. Simulate the record that case
    // still writes, and check the first dispatch clears it -- a record left behind makes
    // sessionsOnProfiles() believe a dead classifier is still holding the shared model.
    writeSessionProfile("ses-classifier", "uncensored", { explicit: false });
    const output = { message: { model: { providerID: "llamacpp", modelID: "lan-small-4b" } }, parts: [] };
    await hooks["chat.message"]({
      sessionID: "ses-classifier", agent: "fleet-classifier-local",
      model: { providerID: "llamacpp", id: "lan-small-4b" },
    }, output);
    let paramsError = "";
    try {
      await hooks["chat.params"]({
        sessionID: "ses-classifier",
        model: { providerID: "llamacpp", id: "lan-small-4b" },
        message: { model: { providerID: "llamacpp", modelID: "lan-small-4b" } },
      });
    } catch (error) { paramsError = String(error.message); }
    process.stdout.write(JSON.stringify({
      paramsError,
      model: output.message.model,
      calls: calls.map((call) => call.path),
      afterCreated,
      childRecord: resolveProfile({ sessionID: "ses-classifier" }),
    }));
  `);
  assert.equal(result.paramsError, "", "the classifier turn must not be aborted by the router");
  assert.deepEqual(result.model, { providerID: "llamacpp", modelID: "lan-small-4b" },
    "the frontmatter pin is still what runs");
  assert.deepEqual(result.calls, [], "a lane that is not routed asks the broker for nothing");
  assert.equal(result.afterCreated.source, "default",
    "session.created must leave a lane session with NO profile record of its own");
  assert.equal(result.childRecord.source, "default",
    "and a record written before this fix is cleared on the lane's first dispatch");
});

test("☠️ compaction leases the profile's OWN target, not a censored one", () => {
  const result = inTempHome(`
    ${FAKE_BROKER}
    import { resolveProfile, writeSessionProfile } from ${JSON.stringify(routingUrl)};
    import { ModelRouter } from ${JSON.stringify(pluginUrl)};
    writeSessionProfile("ses-user", "uncensored", { explicit: true });
    const sessions = { "ses-user": { id: "ses-user", agent: "standard" } };
    const hooks = await ModelRouter({ client: { session: {
      get: async ({ path }) => sessions[path.id],
      messages: async () => ({ data: [] }),
    } }, directory: process.env.HOME });
    const output = { message: { model: { providerID: "llamacpp", modelID: "lan-uncensored-27b" } }, parts: [] };
    await hooks["chat.message"]({ sessionID: "ses-user", agent: "compaction" }, output);
    process.stdout.write(JSON.stringify({
      lease: calls.find((call) => call.path === "/lease")?.body ?? null,
      stillUncensored: resolveProfile({ sessionID: "ses-user" }),
      model: output.message.model,
    }));
  `);
  assert.equal(result.lease?.profile, "uncensored",
    "☠️ compaction operates ON the conversation, so it needs the conversation's model class");
  assert.equal(result.lease?.sessionID, "ses-user");
  assert.equal(result.lease?.localOnly, undefined,
    "and needs no egress flag: the profile's own lane is already the boundary");
  assert.deepEqual(result.model, { providerID: "llamacpp", modelID: "lan-uncensored-27b" });
  assert.equal(result.stillUncensored.profile, "uncensored");
  assert.equal(result.stillUncensored.explicit, true, "the explicit F11 selection survives");
});

test("☠️ a restrictive profile does NOT let the classifier reach cloud", () => {
  const result = inTempHome(`
    ${FAKE_BROKER}
    import { writeSessionProfile } from ${JSON.stringify(routingUrl)};
    import { ModelRouter } from ${JSON.stringify(pluginUrl)};
    // Each profile gets a parent and a classifier child dispatched on the CLOUD lane agent
    // -- which is what the guard picks when no local classifier target was eligible.
    const profiles = ["private", "uncensored-offline", "local", "uncensored", "uncensored-70b", "vision"];
    const sessions = {};
    for (const profile of profiles) {
      writeSessionProfile("parent-" + profile, profile, { explicit: true });
      sessions["parent-" + profile] = { id: "parent-" + profile, agent: "standard" };
      sessions["child-" + profile] = { id: "child-" + profile, parentID: "parent-" + profile, agent: "fleet-classifier-haiku" };
    }
    // Controls: no profile at all, and manual. The cloud rung the deployment configured on
    // the classifier tier must still work for both.
    sessions["parent-auto"] = { id: "parent-auto", agent: "standard" };
    sessions["child-auto"] = { id: "child-auto", parentID: "parent-auto", agent: "fleet-classifier-haiku" };
    writeSessionProfile("parent-manual", "manual", { explicit: true });
    sessions["parent-manual"] = { id: "parent-manual", agent: "standard" };
    sessions["child-manual"] = { id: "child-manual", parentID: "parent-manual", agent: "fleet-classifier-haiku" };
    const hooks = await ModelRouter({ client: { session: {
      get: async ({ path }) => sessions[path.id],
      messages: async () => ({ data: [] }),
    } }, directory: process.env.HOME });
    const out = {};
    for (const key of [...profiles, "auto", "manual"]) {
      const output = { message: { model: { providerID: "openai", modelID: "cloud-worker-1" } }, parts: [] };
      try {
        await hooks["chat.message"]({
          sessionID: "child-" + key, agent: "fleet-classifier-haiku",
          model: { providerID: "openai", id: "cloud-worker-1" },
        }, output);
        out[key] = { blocked: false, model: output.message.model };
      } catch (error) { out[key] = { blocked: true, error: String(error.message) }; }
    }
    // The LOCAL lane agent under the strictest profile: nothing to block.
    sessions["child-lan"] = { id: "child-lan", parentID: "parent-uncensored-offline", agent: "fleet-classifier-local" };
    const lanOut = { message: { model: { providerID: "llamacpp", modelID: "lan-small-4b" } }, parts: [] };
    try {
      await hooks["chat.message"]({
        sessionID: "child-lan", agent: "fleet-classifier-local",
        model: { providerID: "llamacpp", id: "lan-small-4b" },
      }, lanOut);
      out.lanLane = { blocked: false, model: lanOut.message.model };
    } catch (error) { out.lanLane = { blocked: true, error: String(error.message) }; }
    out.calls = calls.map((call) => call.path);
    process.stdout.write(JSON.stringify(out));
  `);
  // ☆ `vision` is in this list to prove the boundary is about RESTRICTIVENESS and not about
  // being an uncensored lane: it holds the general 27b, nothing about it is uncensored, and it
  // confines the session's content exactly as `local` and `private` do -- with no special case
  // anywhere, because the predicate reads the profile's configured lane rather than its name.
  for (const profile of ["private", "uncensored-offline", "local", "uncensored", "uncensored-70b", "vision"]) {
    assert.equal(result[profile].blocked, true,
      `${profile} must not let a command line be classified off the LAN`);
    assert.ok(result[profile].error.startsWith(`[opencode-broker] ${profile} profile blocked: `),
      `the refusal must name the profile that caused it, not the lane's auto: ${result[profile].error}`);
    assert.match(result[profile].error, /not one of this deployment's local targets/);
  }
  // ☆ Suppressed for restrictive profiles SPECIFICALLY, not deleted globally: under auto
  // and manual the configured cloud rung is exactly right and stays untouched.
  assert.equal(result.auto.blocked, false, "auto keeps the classifier's cloud rung");
  assert.deepEqual(result.auto.model, { providerID: "openai", modelID: "cloud-worker-1" });
  assert.equal(result.manual.blocked, false, "manual keeps it too");
  // The boundary is about where content GOES, not about refusing the gate: a LAN-pinned
  // lane runs normally under the strictest profile there is.
  assert.equal(result.lanLane.blocked, false);
  assert.deepEqual(result.lanLane.model, { providerID: "llamacpp", modelID: "lan-small-4b" });
  assert.deepEqual(result.calls, [], "and none of this costs a lease on a scarce local target");
});

// ☠️ A NEW UNCENSORED PROFILE INHERITS THE WHOLE RULE, OR IT INHERITS NONE OF IT. `uncensored-70b`
// (0.29.0) exists for exactly one reason: the 70B must never be interchangeable with the 27b,
// because choosing it evicts every other resident model. That is
// a statement about which TARGET the lane holds, and about NOTHING else -- every other property of
// an uncensored profile has to carry over unchanged, and both machine-dispatched lanes are meant
// to be written profile-AGNOSTICALLY so that carrying over costs no code at all.
// This test is what says so out loud. It runs both profiles through both lanes and asserts they
// answer the same way, so a lane that ever starts special-casing profiles BY NAME fails here
// rather than in production, where the two failures are a censored compaction of an uncensored
// transcript and a command line classified off the LAN.
test("☠️ uncensored-70b behaves exactly like uncensored on both machine-dispatched lanes", () => {
  const result = inTempHome(`
    ${FAKE_BROKER}
    import { writeSessionProfile } from ${JSON.stringify(routingUrl)};
    import { ModelRouter } from ${JSON.stringify(pluginUrl)};
    const profiles = ["uncensored", "uncensored-70b"];
    const sessions = {};
    for (const profile of profiles) {
      writeSessionProfile("user-" + profile, profile, { explicit: true });
      sessions["user-" + profile] = { id: "user-" + profile, agent: "standard" };
      // The CLOUD classifier lane agent -- what the guard picks when no local classifier
      // target was eligible, and the only one there is anything to block.
      sessions["cls-" + profile] = { id: "cls-" + profile, parentID: "user-" + profile, agent: "fleet-classifier-haiku" };
    }
    const hooks = await ModelRouter({ client: { session: {
      get: async ({ path }) => sessions[path.id],
      messages: async () => ({ data: [] }),
    } }, directory: process.env.HOME });
    const out = {};
    for (const profile of profiles) {
      // Lane one: compaction PROCESSES THE CONVERSATION. Its summary replaces the transcript
      // permanently, so it has to lease on the session's own profile.
      const output = { message: { model: { providerID: "llamacpp", modelID: "lan-uncensored-27b" } }, parts: [] };
      await hooks["chat.message"]({ sessionID: "user-" + profile, agent: "compaction" }, output);
      const lease = calls.filter((call) => call.path === "/lease").pop()?.body ?? null;
      // Lane two: the classifier processes a SHELL COMMAND, so it takes its own tier rather
      // than the profile -- but the command line is still the user's content and stays on the LAN.
      const clsOut = { message: { model: { providerID: "openai", modelID: "cloud-worker-1" } }, parts: [] };
      let classifier;
      try {
        await hooks["chat.message"]({
          sessionID: "cls-" + profile, agent: "fleet-classifier-haiku",
          model: { providerID: "openai", id: "cloud-worker-1" },
        }, clsOut);
        classifier = { blocked: false, model: clsOut.message.model };
      } catch (error) { classifier = { blocked: true, error: String(error.message) }; }
      out[profile] = {
        compaction: {
          profile: lease?.profile ?? null,
          sessionID: lease?.sessionID ?? null,
          localOnly: lease?.localOnly ?? null,
          tier: lease?.tier ?? null,
        },
        classifier,
      };
    }
    process.stdout.write(JSON.stringify(out));
  `);
  const control = result.uncensored;
  const subject = result["uncensored-70b"];

  // -- compaction follows the profile, for both, and asks for nothing else -------------------
  assert.equal(control.compaction.profile, "uncensored");
  assert.equal(subject.compaction.profile, "uncensored-70b",
    "☠️ a 27b -- censored or not -- must never compact a conversation the user put on the 70B");
  assert.equal(subject.compaction.sessionID, "user-uncensored-70b");
  assert.equal(subject.compaction.tier, control.compaction.tier,
    "the lane is chosen by what it processes, not by which uncensored profile it is under");
  assert.equal(subject.compaction.localOnly, null,
    "and it needs no egress flag either: the profile's own lane is already the boundary");

  // -- the classifier is refused the cloud under both ----------------------------------------
  assert.equal(control.classifier.blocked, true);
  assert.equal(subject.classifier.blocked, true,
    "☠️ isLocalOnlyProfile must know this profile, or a command line leaves the LAN under it");
  assert.ok(subject.classifier.error.startsWith("[opencode-broker] uncensored-70b profile blocked: "),
    `the refusal must name the profile that caused it: ${subject.classifier.error}`);
  // The two refusals differ only in the profile name they quote -- which is the whole claim.
  assert.equal(
    subject.classifier.error.replace("uncensored-70b", "uncensored"),
    control.classifier.error,
    "any difference beyond the profile's name is a lane that has started special-casing profiles");
});
