// Hide catalog prices for providers whose usage is covered by a subscription or
// a local lane. OpenCode omits a zero session cost from the TUI footer.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const catalogPath = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "models.json");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const zeroCost = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

const catalog = () => {
  try {
    const value = JSON.parse(readFileSync(catalogPath(), "utf8"));
    return object(value) ? value : null;
  } catch {
    return null;
  }
};

const brokerConfig = async () => {
  try {
    const { CONFIG, CONFIG_ERROR } = await import("./config.js");
    return CONFIG_ERROR ? null : CONFIG;
  } catch {
    return null;
  }
};

export const hideSubscriptionCosts = async (config) => {
  if (!object(config) || !object(config.provider)) return;

  const models = catalog();
  const broker = await brokerConfig();
  if (!models || !broker) return;

  const covered = new Set(broker.trustedSubscriptionProviders ?? []);
  for (const target of Object.values(broker.targets ?? {})) {
    if (target?.kind === "local" && typeof target.providerID === "string") covered.add(target.providerID);
  }

  for (const providerID of covered) {
    const provider = config.provider[providerID];
    if (!object(provider)) continue;

    const configuredModels = object(provider.models) ? provider.models : (provider.models = {});
    for (const model of Object.values(configuredModels)) {
      if (object(model)) model.cost = zeroCost();
    }

    const catalogModels = models[providerID]?.models;
    if (!object(catalogModels)) continue;
    for (const modelID of Object.keys(catalogModels)) {
      const model = configuredModels[modelID];
      if (object(model)) model.cost = zeroCost();
      else configuredModels[modelID] = { cost: zeroCost() };
    }
  }
};
