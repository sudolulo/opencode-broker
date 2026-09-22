import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case needs its own module instance, because lib/config.js reads the file
// once at import. A cache-busting query string gives us a fresh evaluation.
const loadConfig = async (contents) => {
  const dir = mkdtempSync(join(tmpdir(), "router-config-"));
  const path = join(dir, "config.json");
  if (contents !== null) writeFileSync(path, contents);
  process.env.OPENCODE_BROKER_CONFIG = path;
  return import(`../lib/config.js?case=${encodeURIComponent(dir)}`);
};

test("JSONC comments are stripped, not rejected", async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig(`{
    // a note explaining why this target exists
    "targets": {
      "local-x": { "providerID": "llamacpp", "modelID": "m", "kind": "local", "capacity": 1 }
    },
    /* block comments too */
    "tiers": { "worker": ["local-x"] }
  }`);
  assert.equal(CONFIG_ERROR, null);
  assert.deepEqual(Object.keys(CONFIG.targets), ["local-x"]);
});

// ☠️ The regression that caused the 2026-09-04 outage: a blind //-strip also
// eats the "//" inside a URL, silently removing the local model server so every
// local request goes to a paid provider.
test("a // inside a string value survives comment stripping", async () => {
  const { CONFIG } = await loadConfig(`{
    // leading comment
    "localModelsUrl": "http://gpu-box:8080/v1/models",
    "targets": {}
  }`);
  assert.equal(CONFIG.localModelsUrl, "http://gpu-box:8080/v1/models");
});

test("an absent config is silent -- that is the documented default", async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig(null);
  assert.equal(CONFIG_ERROR, null);
  assert.deepEqual(CONFIG.targets, {});
});

// A malformed config must never look like an absent one: it means the operator
// declared targets, so serving zero of them has to be reported, not swallowed.
test("a malformed config reports the reason instead of silently emptying routing", async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig('{ "targets": { bad }');
  assert.deepEqual(CONFIG.targets, {});
  assert.ok(CONFIG_ERROR, "CONFIG_ERROR must be set for a malformed config");
  assert.match(CONFIG_ERROR, /config\.json/);
});

// ☠️ Both of these knobs shipped documented-but-unreadable: CONFIG is an explicit
// Object.freeze whitelist, so a key the loader does not name is dropped and the
// consumer silently falls back to its default. The config line looks right, reads
// right in review, and does nothing.
test("burstFence and sessionRebalance survive the CONFIG whitelist", async () => {
  const { CONFIG, CONFIG_ERROR } = await loadConfig(`{
    "burstFence": 0.75,
    "sessionRebalance": { "divergence": 0.2, "cooldownMs": 600000 }
  }`);
  assert.equal(CONFIG_ERROR, null);
  assert.equal(CONFIG.burstFence, 0.75);
  assert.equal(CONFIG.sessionRebalance.divergence, 0.2);
  assert.equal(CONFIG.sessionRebalance.cooldownMs, 600000);
});

test("both knobs fall back to their defaults rather than NaN", async () => {
  const { CONFIG } = await loadConfig(`{ "burstFence": "banana", "sessionRebalance": { "divergence": -1 } }`);
  assert.equal(CONFIG.burstFence, 0.9);
  assert.equal(CONFIG.sessionRebalance.divergence, 0.15);
  assert.equal(CONFIG.sessionRebalance.cooldownMs, 1800000);
});

test("per-target contextHeadroom is kept for local targets and rejected otherwise", async () => {
  const { CONFIG } = await loadConfig(`{
    "targets": {
      "local-valid": { "providerID": "llamacpp", "modelID": "valid", "kind": "local", "contextHeadroom": 0.75 },
      "local-too-high": { "providerID": "llamacpp", "modelID": "high", "kind": "local", "contextHeadroom": 1.5 },
      "local-zero": { "providerID": "llamacpp", "modelID": "zero", "kind": "local", "contextHeadroom": 0 },
      "cloud": { "providerID": "openai", "modelID": "cloud", "kind": "cloud", "contextHeadroom": 0.75 }
    }
  }`);
  assert.equal(CONFIG.targets["local-valid"].contextHeadroom, 0.75);
  assert.equal(CONFIG.targets["local-too-high"].contextHeadroom, undefined);
  assert.equal(CONFIG.targets["local-zero"].contextHeadroom, undefined);
  assert.equal(CONFIG.targets.cloud.contextHeadroom, undefined);
});

// outputReserve is the mechanism that REPLACED the fraction above; contextHeadroom
// survives only as the fallback for a target whose generation budget is unmeasured.
// Kept for BOTH kinds, unlike contextHeadroom: targetOutputReserve has always
// documented "an explicit outputReserve beats the catalog", but nothing ever parsed
// the key, so that precedence was dead text for cloud targets too.
test("per-target outputReserve is parsed for both kinds, floored, and junk is dropped", async () => {
  const { CONFIG } = await loadConfig(`{
    "targets": {
      "local-reserve": { "providerID": "llamacpp", "modelID": "r", "kind": "local", "context": 196608, "outputReserve": 49152 },
      "local-fractional": { "providerID": "llamacpp", "modelID": "f", "kind": "local", "outputReserve": 4096.7 },
      "local-zero": { "providerID": "llamacpp", "modelID": "z", "kind": "local", "outputReserve": 0 },
      "local-junk": { "providerID": "llamacpp", "modelID": "j", "kind": "local", "outputReserve": "banana" },
      "cloud": { "providerID": "openai", "modelID": "c", "kind": "cloud", "outputReserve": 32000 }
    }
  }`);
  assert.equal(CONFIG.targets["local-reserve"].outputReserve, 49152);
  // A token count is an integer: a fractional reserve is floored, never rounded up
  // into the window it is protecting.
  assert.equal(CONFIG.targets["local-fractional"].outputReserve, 4096);
  // Absent rather than 0 -- so targetOutputReserve reports "unknown" and the caller
  // falls back to the fraction, instead of subtracting nothing and calling it a fit.
  assert.equal(CONFIG.targets["local-zero"].outputReserve, undefined);
  assert.equal(CONFIG.targets["local-junk"].outputReserve, undefined);
  assert.equal(CONFIG.targets.cloud.outputReserve, 32000);
});

// modelCapacity counts a local model server's slots across every target naming the model;
// a cloud target has no slots to share, and a non-integer limit is not a limit.
test("per-target modelCapacity is kept for local targets as a positive integer only", async () => {
  const { CONFIG } = await loadConfig(`{
    "targets": {
      "local-valid": { "providerID": "llamacpp", "modelID": "m", "kind": "local", "capacity": 4, "modelCapacity": 3 },
      "local-zero": { "providerID": "llamacpp", "modelID": "m", "kind": "local", "modelCapacity": 0 },
      "local-fraction": { "providerID": "llamacpp", "modelID": "m", "kind": "local", "modelCapacity": 2.5 },
      "cloud": { "providerID": "openai", "modelID": "c", "kind": "cloud", "modelCapacity": 3 }
    }
  }`);
  assert.equal(CONFIG.targets["local-valid"].modelCapacity, 3);
  assert.equal(CONFIG.targets["local-zero"].modelCapacity, undefined);
  assert.equal(CONFIG.targets["local-fraction"].modelCapacity, undefined);
  assert.equal(CONFIG.targets.cloud.modelCapacity, undefined);
});

test("HTTP plan usage keeps its type, URL, and exact auth reference", async () => {
  const { CONFIG } = await loadConfig(`{
    "budgets": {
      "example-provider": {
        "windows": [{ "id": "wk", "periodMs": 604800000, "meter": "tokens", "capacity": 1000000 }],
        "planUsage": {
          "type": "http",
          "url": "https://usage.example.invalid/v1/plan-usage",
          "authRef": "provider-credential"
        }
      }
    }
  }`);
  assert.deepEqual(CONFIG.budgets["example-provider"].planUsage, {
    type: "http",
    url: "https://usage.example.invalid/v1/plan-usage",
    authRef: "provider-credential",
  });
});

test("HTTP plan usage drops empty and non-string URL and auth reference fields", async () => {
  const window = `"windows": [{ "id": "wk", "periodMs": 604800000, "meter": "tokens", "capacity": 1000000 }]`;
  const { CONFIG } = await loadConfig(`{
    "budgets": {
      "empty-fields": {
        ${window},
        "planUsage": { "type": "http", "url": "", "authRef": "" }
      },
      "invalid-fields": {
        ${window},
        "planUsage": { "type": "http", "url": 42, "authRef": false }
      }
    }
  }`);
  assert.deepEqual(CONFIG.budgets["empty-fields"].planUsage, { type: "http" });
  assert.deepEqual(CONFIG.budgets["invalid-fields"].planUsage, { type: "http" });
});

// An absent burnWatch block is the full watch with its documented defaults, and its
// notifier falls back to the model watch's, so one notify script serves both.
test("burnWatch defaults to on, takes its thresholds from config, and borrows watch.notifyCommand", async () => {
  const { BURN_DEFAULTS } = await import("../lib/burn-watch.js");
  const absent = (await loadConfig(`{ "watch": { "notifyCommand": ["/usr/local/bin/notify"] } }`)).CONFIG.burnWatch;
  assert.equal(absent.enabled, true);
  assert.deepEqual(absent.notifyCommand, ["/usr/local/bin/notify"]);
  for (const [key, value] of Object.entries(BURN_DEFAULTS)) assert.equal(absent[key], value, key);

  const tuned = (await loadConfig(`{
    "watch": { "notifyCommand": ["/usr/local/bin/notify"] },
    "burnWatch": {
      "notifyCommand": ["/usr/local/bin/alert", "{title}", "{body}", "high"],
      "sessionStopTokens": 8000000,
      "planWindow": "wk",
      "rewriteCount": "banana",
      "providerSpendTokens": -1
    }
  }`)).CONFIG.burnWatch;
  assert.deepEqual(tuned.notifyCommand, ["/usr/local/bin/alert", "{title}", "{body}", "high"]);
  assert.equal(tuned.sessionStopTokens, 8000000);
  assert.equal(tuned.planWindow, "wk");
  assert.equal(tuned.rewriteCount, BURN_DEFAULTS.rewriteCount, "junk falls back to the default");
  assert.equal(tuned.providerSpendTokens, BURN_DEFAULTS.providerSpendTokens);

  const off = (await loadConfig(`{ "burnWatch": { "enabled": false, "notifyCommand": [] } }`)).CONFIG.burnWatch;
  assert.equal(off.enabled, false);
  assert.deepEqual(off.notifyCommand, []);
  assert.deepEqual((await loadConfig(`{}`)).CONFIG.burnWatch.notifyCommand, [], "no notifier anywhere: log only");
});

// The shipped examples are documentation; a typo in one would teach every new install a
// config that silently routes nothing.
test("the shipped example configs parse and declare targets", async () => {
  const { readFileSync } = await import("node:fs");
  for (const name of ["minimal.config.json", "config.example.json"]) {
    const text = readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8");
    const { CONFIG, CONFIG_ERROR } = await loadConfig(text);
    assert.equal(CONFIG_ERROR, null, name);
    assert.ok(Object.keys(CONFIG.targets).length >= 3, name);
    assert.ok(Object.keys(CONFIG.profiles).includes("private"), name);
  }
});
