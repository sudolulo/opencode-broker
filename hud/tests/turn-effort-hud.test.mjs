import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runHudScenario = (scenario) => {
  const home = mkdtempSync(join(tmpdir(), "turn-effort-hud-home-"));
  try {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { existsSync, readFileSync } from "node:fs";
      import { join } from "node:path";
      import { markManagedModelSwitch } from "./lib/routing.js";
      import modelDefaultPlugin from "./tui/tui.js";

      const modelDefault = join(process.env.HOME, ".local/share/opencode/model-default.json");
      let switchHandler;
      await modelDefaultPlugin.tui({
        event: {
          on: (name, handler) => {
            assert.equal(name, "session.next.model.switched");
            switchHandler = handler;
            return () => {};
          },
        },
        lifecycle: { onDispose: () => {} },
        ui: { toast: () => { throw new Error("a valid model switch must not toast"); } },
      });

      ${scenario}
    `], { cwd: "/home/dev/opencode-broker", env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("duplicate managed effort switches never replace the user model default", () => {
  runHudScenario(`
    const sessionID = "effort-session";
    const managedModel = { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" };
    assert.equal(markManagedModelSwitch(sessionID, managedModel), true);

    switchHandler({ properties: { sessionID, model: managedModel } });
    switchHandler({ properties: { sessionID, model: managedModel } });

    assert.equal(existsSync(modelDefault), false);

    const userModel = { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" };
    switchHandler({ properties: { sessionID, model: userModel } });

    assert.deepEqual(JSON.parse(readFileSync(modelDefault, "utf8")), userModel);
  `);
});

test("a matching managed switch after the duplicate window replaces the user model default", () => {
  runHudScenario(`
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const sessionID = "late-managed-switch";
    const managedModel = { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" };
    assert.equal(markManagedModelSwitch(sessionID, managedModel), true);

    switchHandler({ properties: { sessionID, model: managedModel } });
    now += 10_001;
    switchHandler({ properties: { sessionID, model: managedModel } });

    assert.deepEqual(JSON.parse(readFileSync(modelDefault, "utf8")), managedModel);
  `);
});

test("a non-matching switch clears the managed marker", () => {
  runHudScenario(`
    const sessionID = "user-switch";
    const managedModel = { providerID: "openai", id: "gpt-6.1-sol", variant: "xhigh" };
    const userModel = { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" };
    assert.equal(markManagedModelSwitch(sessionID, managedModel), true);

    switchHandler({ properties: { sessionID, model: userModel } });
    switchHandler({ properties: { sessionID, model: managedModel } });

    assert.deepEqual(JSON.parse(readFileSync(modelDefault, "utf8")), managedModel);
  `);
});
