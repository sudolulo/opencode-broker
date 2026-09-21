import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.OPENCODE_BROKER_CONFIG = new URL("./fixtures/config.json", import.meta.url).pathname;

// opencode calls every export of a plugin module as a plugin factory; a
// non-function export -- or a second function export that cannot survive being
// called with the plugin input -- unloads the whole module, silently.
const dir = new URL("../plugin/", import.meta.url);
for (const name of readdirSync(fileURLToPath(dir)).filter((n) => n.endsWith(".js")).sort()) {
  test(`plugin ${name} exports exactly one factory function`, async () => {
    const mod = await import(new URL(name, dir).href);
    const exports = Object.entries(mod);
    assert.equal(exports.length, 1, `exports: ${exports.map(([k]) => k).join(", ")}`);
    assert.equal(typeof exports[0][1], "function");
  });
}
