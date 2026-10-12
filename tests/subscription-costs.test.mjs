import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "broker-subscription-costs-"));
const cacheHome = join(root, "cache");
const configPath = join(root, "broker.json");
const catalogPath = join(cacheHome, "opencode", "models.json");
process.env.HOME = root;
process.env.XDG_CACHE_HOME = cacheHome;
process.env.OPENCODE_BROKER_CONFIG = configPath;

writeFileSync(configPath, JSON.stringify({
  trustedSubscriptionProviders: ["anthropic"],
  targets: {
    "local-lane": { providerID: "llamacpp", modelID: "local-model", kind: "local" },
  },
}));

const catalog = {
  anthropic: { models: { "claude-catalog": {} } },
  llamacpp: { models: { "local-catalog": {} } },
  metered: { models: { "api-catalog": {} } },
  absent: { models: { "absent-catalog": {} } },
};
const writeCatalog = () => {
  mkdirSync(join(cacheHome, "opencode"), { recursive: true });
  writeFileSync(catalogPath, JSON.stringify(catalog));
};
const config = () => ({
  provider: {
    anthropic: { models: { "claude-config": { cost: { input: 3, output: 4, cache_read: 1, cache_write: 2 } } } },
    llamacpp: { models: { "local-config": { cost: { input: 5, output: 6, cache_read: 2, cache_write: 3 } } } },
    metered: { models: { "api-config": { cost: { input: 7, output: 8, cache_read: 3, cache_write: 4 } } } },
    unknown: { models: { "unknown-config": { cost: { input: 9, output: 10, cache_read: 4, cache_write: 5 } } } },
  },
});
const zeroCost = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

writeCatalog();
const { ModelDefault } = await import("../plugin/model-default.js");
const apply = async (value) => (await ModelDefault()).config(value);

after(() => rmSync(root, { recursive: true, force: true }));

test("config hook hides prices only for configured subscription and local provider models", async () => {
  const value = config();

  await apply(value);

  assert.deepEqual(value.provider.anthropic.models["claude-config"].cost, zeroCost);
  assert.deepEqual(value.provider.anthropic.models["claude-catalog"].cost, zeroCost);
  assert.deepEqual(value.provider.llamacpp.models["local-config"].cost, zeroCost);
  assert.deepEqual(value.provider.llamacpp.models["local-catalog"].cost, zeroCost);
  assert.deepEqual(value.provider.metered.models["api-config"].cost, { input: 7, output: 8, cache_read: 3, cache_write: 4 });
  assert.equal(value.provider.metered.models["api-catalog"], undefined);
  assert.deepEqual(value.provider.unknown.models["unknown-config"].cost, { input: 9, output: 10, cache_read: 4, cache_write: 5 });
});

test("config hook skips catalog providers absent from config.provider", async () => {
  const value = config();

  await apply(value);

  assert.equal(value.provider.absent, undefined);
});

test("missing or corrupt catalog leaves config unchanged without throwing", async () => {
  const missing = config();
  unlinkSync(catalogPath);
  await assert.doesNotReject(() => apply(missing));
  assert.deepEqual(missing, config());

  writeFileSync(catalogPath, "not json");
  const corrupt = config();
  await assert.doesNotReject(() => apply(corrupt));
  assert.deepEqual(corrupt, config());

  writeCatalog();
});

test("config hook is idempotent", async () => {
  const value = config();
  await apply(value);
  const once = structuredClone(value);

  await apply(value);

  assert.deepEqual(value, once);
});
