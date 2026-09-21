import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// lib/config.js resolves its path once, at import, from HOME and the environment,
// so every case runs in a fresh node process with a scratch HOME.
const configModule = new URL("../lib/config.js", import.meta.url).href;
const resolveIn = (home, env = {}) => {
  const clean = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/^OPENCODE_(BROKER|MODEL_ROUTER)_CONFIG$|^XDG_CONFIG_HOME$/.test(name)));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { CONFIG, DEPRECATIONS } = await import(${JSON.stringify(configModule)});
    process.stdout.write(JSON.stringify({ path: CONFIG.path, targets: Object.keys(CONFIG.targets), deprecations: DEPRECATIONS }));
  `], { env: { ...clean, HOME: home, ...env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const writeConfig = (path, targetID) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    targets: { [targetID]: { providerID: "llamacpp", modelID: "m", kind: "local" } },
  }));
};
const scratch = () => mkdtempSync(join(tmpdir(), "broker-config-location-"));

test("the default location is ~/.config/opencode-broker/config.json, with nothing deprecated", () => {
  const home = scratch();
  try {
    writeConfig(join(home, ".config/opencode-broker/config.json"), "current");
    const resolved = resolveIn(home);
    assert.equal(resolved.path, join(home, ".config/opencode-broker/config.json"));
    assert.deepEqual(resolved.targets, ["current"]);
    assert.deepEqual(resolved.deprecations, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("an install that only has the pre-rename directory keeps working, and says so", () => {
  const home = scratch();
  try {
    writeConfig(join(home, ".config/opencode-model-router/config.json"), "legacy");
    const resolved = resolveIn(home);
    assert.equal(resolved.path, join(home, ".config/opencode-model-router/config.json"));
    assert.deepEqual(resolved.targets, ["legacy"]);
    assert.equal(resolved.deprecations.length, 1);
    assert.match(resolved.deprecations[0], /opencode-model-router.*move it to .*opencode-broker\/config\.json/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the new directory wins over the old one when both exist", () => {
  const home = scratch();
  try {
    writeConfig(join(home, ".config/opencode-model-router/config.json"), "legacy");
    writeConfig(join(home, ".config/opencode-broker/config.json"), "current");
    const resolved = resolveIn(home);
    assert.deepEqual(resolved.targets, ["current"]);
    assert.deepEqual(resolved.deprecations, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("XDG_CONFIG_HOME moves the default location", () => {
  const home = scratch();
  try {
    writeConfig(join(home, "xdg/opencode-broker/config.json"), "xdg");
    const resolved = resolveIn(home, { XDG_CONFIG_HOME: join(home, "xdg") });
    assert.deepEqual(resolved.targets, ["xdg"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("OPENCODE_BROKER_CONFIG beats the deprecated OPENCODE_MODEL_ROUTER_CONFIG, which still works alone", () => {
  const home = scratch();
  try {
    writeConfig(join(home, "a.json"), "new-env");
    writeConfig(join(home, "b.json"), "old-env");
    const both = resolveIn(home, { OPENCODE_BROKER_CONFIG: join(home, "a.json"), OPENCODE_MODEL_ROUTER_CONFIG: join(home, "b.json") });
    assert.deepEqual(both.targets, ["new-env"]);
    assert.deepEqual(both.deprecations, []);
    const legacy = resolveIn(home, { OPENCODE_MODEL_ROUTER_CONFIG: join(home, "b.json") });
    assert.deepEqual(legacy.targets, ["old-env"]);
    assert.match(legacy.deprecations[0], /OPENCODE_MODEL_ROUTER_CONFIG is deprecated; set OPENCODE_BROKER_CONFIG/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
