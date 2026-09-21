// ☠️ THE LISTS THAT MUST NOT DRIFT.
//
// A routing profile is not one declaration, it is a set of them: a name the TUI offers, a lane
// in the deployment config, a human title, a legacy agent alias, and a place in the restrictive
// group that decides whether the session's content may leave the LAN. The failure mode of a
// missing entry is never a crash:
//
//   no lane built for it                  -> the profile is offered and accepted by isProfile(),
//                                            and every lease on it is refused with "no eligible
//                                            target" while the config plainly names its targets
//   missing from the restrictive group    -> profileConfinesToLan() goes false and the guard's
//                                            command classifier is free to send that session's
//                                            command lines to a cloud model
//   no title                              -> profileTitle() answers "Auto", so a toast reads
//                                            "Auto: <model> selected" on a restricted lane
//
// All of them derive from one place: the keys of `profiles` in the config (lib/config.js
// PROFILE_NAMES). This file asserts the derivations still hold for a realistic deployment
// (tests/fixtures/config.json), and pins the properties that deployment relies on.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ☠️ A TEMPORARY HOME, SET BEFORE THE FIRST DYNAMIC IMPORT. lib/routing.js resolves its state
// root from homedir() at MODULE scope, so this is the only point at which it can be redirected --
// and every import below is dynamic precisely so it lands after this line. Without it the alias
// assertion below would read the developer's own ~/.local/share/opencode/model-routing, and pass
// or fail according to which profile they happened to be sitting on.
const HOME = mkdtempSync(join(tmpdir(), "profile-registry-home-"));
process.env.HOME = HOME;
after(() => { rmSync(HOME, { recursive: true, force: true }); });

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;
const R = await import("../lib/routing.js");
const { PROFILE_NAMES } = await import("../lib/config.js");

test("every routing profile is titled, aliased and given a lane -- no silent gaps", () => {
  // `auto` and `manual` are the two with no lane of their own, by construction.
  assert.deepEqual(R.PROFILES, ["auto", "manual", ...PROFILE_NAMES]);
  for (const profile of R.PROFILES) {
    assert.equal(R.isProfile(profile), true, profile);
    // ☠️ The fallback in profileTitle() is "Auto". A profile that reaches it is not merely
    // unlabelled, it is labelled as the OPPOSITE of what it is.
    assert.notEqual(R.profileTitle(profile), profile === "auto" ? "" : "Auto",
      `${profile} has no PROFILE_TITLES entry and would display as "Auto"`);
  }
  for (const profile of PROFILE_NAMES) {
    // The legacy `-a <profile>` alias, which resolveProfile consults last.
    assert.deepEqual(R.resolveProfile({ agent: profile }),
      { profile, explicit: false, updatedAt: 0, source: "agent" }, profile);
    // And a lane the config layer actually built. Missing here is the refusal-with-no-reason case.
    assert.ok(Array.isArray(R.CONFIG.profiles[profile]),
      `${profile} has no lane in CONFIG.profiles -- every lease on it would be refused`);
    // ☠️ Every restrictive profile is LAN-confining unless the deployment opened it explicitly;
    // this fixture opens nothing, which is the safe default.
    assert.equal(R.isLocalOnlyProfile(profile), true, profile);
    assert.equal(R.profileConfinesToLan(profile), true, profile);
  }
  // The two that are NOT restrictive stay that way. `manual` is the trap: it reaches no cloud
  // target only because it leases nothing at all, which is not a confinement.
  assert.equal(R.isLocalOnlyProfile("auto"), false);
  assert.equal(R.isLocalOnlyProfile("manual"), false);
  assert.equal(R.profileConfinesToLan("manual"), false);
  // An unknown name is not quietly admitted to the restrictive group either.
  assert.equal(R.isLocalOnlyProfile("uncensored-90b"), false);
  assert.equal(R.isProfile("uncensored-90b"), false);
});

test("☠️ uncensored-70b is its own lane and shares no target with uncensored", () => {
  // THE WHOLE POINT OF THE PROFILE. A second target inside `uncensored` would have left the
  // broker free to CHOOSE between the 27b and the 70B, so F11 -> Uncensored could load 47.6 GiB
  // across both GPUs and evict every other resident model -- including the small one other
  // services on the machine depend on -- without anyone having asked for it. Separate lanes make
  // the two selectable and never interchangeable, and that is a property worth asserting.
  const small = R.targetIDsFor("uncensored");
  const big = R.targetIDsFor("uncensored-70b");
  assert.ok(big.length, "the profile must have a lane of its own");
  assert.deepEqual(big.filter((id) => small.includes(id)), [],
    "☠️ a shared target is a broker CHOICE between a 27b and a 70B, which is the bug this profile exists to prevent");
  assert.deepEqual(small.filter((id) => big.includes(id)), []);
  // ☠️ AND NO FALLBACK RUNG. A rung suppresses the target's prepareCommand (0.27.0): the broker
  // only prepares on the path where it refused the lease, so an eligible rung means the refusal
  // -- and the swap that would make the 70B resident -- never happens, and the profile silently
  // serves something that is not the model the user selected. The prepareCommand IS the recovery
  // path here, so the correct rung list is the empty one.
  assert.deepEqual(R.CONFIG.profileFallbacks["uncensored-70b"], [],
    "☠️ a rung on this profile would suppress the prepareCommand that is its only way back");
  assert.deepEqual(R.targetEligibleIDsFor("uncensored-70b"), big,
    "nothing outside its own lane may ever serve this profile");
  const target = R.CONFIG.targets[big[0]];
  assert.equal(target.kind, "local");
  assert.ok(Array.isArray(target.prepareCommand) && target.prepareCommand.length,
    "with no rung, prepareCommand is the only thing that makes a displaced 70B recoverable");
});

test("uncensored-70b inherits the uncensored tool policy exactly, and is not offline", () => {
  // It is the ONLINE uncensored lane, the sibling of `uncensored` rather than of
  // `uncensored-offline`: same core tools, same code-host MCPs, no bwrap shell.
  assert.equal(R.isOfflineProfile("uncensored-70b"), false);
  for (const tool of ["bash", "read", "webfetch", "gitea_get_file_contents", "some_random_mcp_tool"]) {
    assert.deepEqual(R.toolAllowedForProfile("uncensored-70b", tool).allowed,
      R.toolAllowedForProfile("uncensored", tool).allowed, tool);
  }
});

test("\u2620\ufe0f the vision lane carries no minContextTokens floor", () => {
  // ☠️ A FLOOR STEERS BETWEEN CANDIDATES; IT MUST NEVER BE WHY A ONE-CANDIDATE LANE REFUSES.
  // `local-27b` carries minContextTokens because its lane also holds a 6-slot 9b and the
  // tiebreak below it is a round-robin cursor that reads nothing about the request -- without a
  // floor the scarce 2-slot model takes trivial turns by pure chance. In the `vision` lane there
  // is no second candidate and nothing to steer: the floor would only refuse, and the request it
  // refuses is precisely the one the lane exists for. Someone picking the vision model in Open
  // WebUI to caption ONE image sends a few hundred tokens; under `local-27b`'s 49,153-token floor
  // that lease is rejected as "no eligible local model ... within its context window", which is
  // both false and unfixable by the person reading it.
  // ☆ This is why the deployment declares a SEPARATE target for the lane rather than reusing
  // local-27b: the floor has to stay where it is doing work, and go where it is not.
  const [id] = R.targetIDsFor("vision");
  const target = R.CONFIG.targets[id];
  assert.ok(target, "the vision lane must name a target");
  assert.equal(target.minContextTokens, undefined,
    "☠️ a floor here refuses the one-image caption this lane exists to serve");
  assert.equal(R.meetsContextFloor(target, 300), true, "a small request is admitted");
  assert.equal(R.meetsContextFloor(target, 0), true);
  // And it is still a scarce local target that has to be brought back when something displaced it.
  assert.equal(target.kind, "local");
  assert.ok(Array.isArray(target.prepareCommand) && target.prepareCommand.length,
    "the vision model is displaced whenever an uncensored swap is up; without a prepare, asking for it is a dead end");
});

test("\u2620\ufe0f vision is a LAN lane, not an uncensored one", () => {
  // The risk on this profile runs the OTHER way from uncensored-70b's: the danger is not
  // forgetting to add it to a grouping, it is adding it to one it does not belong in. It holds
  // the GENERAL 27b -- the resting model other local services use -- and nothing about it is
  // uncensored. It must inherit the egress boundary (it does, by being restrictive) and inherit
  // NOTHING that is keyed on the uncensored variant.
  assert.equal(R.isLocalOnlyProfile("vision"), true);
  assert.equal(R.profileConfinesToLan("vision"), true, "its content stays on the LAN like local/private");
  assert.equal(R.isOfflineProfile("vision"), false, "it is an online lane: core tools and code-host MCPs");
  assert.equal(R.profileReachesCloud("vision"), false);
  assert.ok(!"vision".startsWith("uncensored"),
    "☠️ this deployment's HUD swap-back set is `uncensored*` -- a vision lane inside it would " +
    "make an ordinary vision session veto the swap-back that restores the resting models");
  // Same tool policy as `local`, which is the profile it is a sibling of.
  for (const tool of ["bash", "read", "webfetch", "gitea_get_file_contents"]) {
    assert.deepEqual(R.toolAllowedForProfile("vision", tool),
      R.toolAllowedForProfile("local", tool), tool);
  }
});

test("`quick` is registered, LAN-confined, and has no swap power", async () => {
  const R = await import("../lib/routing.js");
  const { PROFILE_NAMES } = await import("../lib/config.js");

  assert.ok(PROFILE_NAMES.includes("quick"));
  assert.ok(R.PROFILES.includes("quick"));
  assert.equal(R.profileTitle("quick"), "Quick");

  // ☠️ THE WHOLE REASON THIS LANE EXISTS. Gateway clients that name the small local model had
  // no profile holding it, so they leased as `auto`, whose worker tier lists cloud FIRST -- and a
  // model called "Wiki (offline)" was measured answering from a cloud provider. A lane that does
  // not confine to the LAN would reintroduce exactly that.
  assert.equal(R.profileConfinesToLan("quick"), true);
  assert.equal(R.profileReachesCloud("quick"), false);

  // Not offline: it is an ordinary online lane like `local`/`vision`, just a smaller one.
  assert.equal(R.isOfflineProfile("quick"), false);

  // ☠️ This deployment's HUD swap-back set is `uncensored*`.
  assert.ok(!"quick".startsWith("uncensored"));
});

test("`assist` is registered everywhere, and is not an uncensored lane", async () => {
  const R = await import("../lib/routing.js");
  const { PROFILE_NAMES, OFFLINE_PROFILE_NAMES } = await import("../lib/config.js");

  assert.ok(PROFILE_NAMES.includes("assist"), "declared once, as a key of the config's profiles");
  assert.ok(R.PROFILES.includes("assist"), "and composed into the offered list");
  // ☠️ The silent one. profileTitle() falls back to "Auto" for anything unlisted, so a missing
  // title does not throw -- it just makes the HUD say "Auto" while the user sits on this lane.
  assert.equal(R.profileTitle("assist"), "Assist");

  // ☠️ NOT OFFLINE, and it must never be added to OFFLINE_PROFILE_NAMES. This is the one lane
  // in the deployment with a cloud rung under it; calling it offline would be a lie that
  // profileCloudEgress then refuses to honour, silently closing the fallback that exists so a
  // voice assistant keeps answering when its local model has been evicted.
  assert.equal(R.isOfflineProfile("assist"), false);
  assert.ok(!OFFLINE_PROFILE_NAMES.includes("assist"));

  // ☠️ This deployment's HUD swap-back set is `uncensored*`. An assist session is an ordinary
  // voice turn and must never veto the swap-back.
  assert.ok(!"assist".startsWith("uncensored"));
});

test("profiles, offline profiles and titles all come from config", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "profile-config-"));
  try {
    const path = join(dir, "config.json");
    const evaluate = (config) => {
      writeFileSync(path, JSON.stringify(config));
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        const R = await import(${JSON.stringify(new URL("../lib/routing.js", import.meta.url).href)});
        const C = await import(${JSON.stringify(new URL("../lib/config.js", import.meta.url).href)});
        process.stdout.write(JSON.stringify({ profiles: R.PROFILES, offline: C.OFFLINE_PROFILE_NAMES,
          titles: Object.fromEntries(R.PROFILES.map((p) => [p, R.profileTitle(p)])) }));
      `], { env: { ...process.env, HOME: dir, OPENCODE_BROKER_CONFIG: path }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return { ...JSON.parse(result.stdout), stderr: result.stderr };
    };
    const target = { providerID: "llamacpp", modelID: "m", kind: "local" };
    // Config order is the order offered; private and *-offline are offline by convention.
    const conventional = evaluate({ targets: { lan: target }, profiles: { lan: ["lan"], "night-70b": ["lan"], private: ["lan"], "air-offline": ["lan"] } });
    assert.deepEqual(conventional.profiles, ["auto", "manual", "lan", "night-70b", "private", "air-offline"]);
    assert.deepEqual(conventional.offline, ["private", "air-offline"]);
    assert.equal(conventional.titles["night-70b"], "Night 70B");
    assert.equal(conventional.titles["air-offline"], "Air Offline");
    // offlineProfiles replaces the convention, and profileTitles names a lane.
    const explicit = evaluate({
      targets: { lan: target },
      profiles: { lan: ["lan"], private: ["lan"], auto: ["lan"], "Bad Name": ["lan"] },
      offlineProfiles: ["lan", "nonexistent"],
      profileTitles: { lan: "Workshop" },
    });
    assert.deepEqual(explicit.profiles, ["auto", "manual", "lan", "private"], "auto/manual and malformed names are refused");
    assert.deepEqual(explicit.offline, ["lan"]);
    assert.equal(explicit.titles.lan, "Workshop");
    assert.match(explicit.stderr, /profiles\["auto"\]/);
    assert.match(explicit.stderr, /offlineProfiles names "nonexistent"/);
    // No profiles at all is a valid deployment: Auto and Manual only.
    assert.deepEqual(evaluate({}).profiles, ["auto", "manual"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
