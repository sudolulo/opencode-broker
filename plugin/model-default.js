// Apply the model most recently selected in the TUI to subsequently created sessions.
// The TUI plugin owns the state file so command-line and agent-selected models do not
// silently become the user's default.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE = join(homedir(), ".local/share/opencode/model-default.json");

const selectedModel = () => {
  try {
    const value = JSON.parse(readFileSync(STATE, "utf8"));
    if (typeof value?.providerID !== "string" || !value.providerID) return null;
    if (typeof value?.id !== "string" || !value.id) return null;
    return `${value.providerID}/${value.id}`;
  } catch {
    return null;
  }
};

const applySelectedModel = (config) => {
  const model = selectedModel();
  if (model) config.model = model;
};

export const ModelDefault = async () => {
  let config;

  return {
    config: async (input) => {
      config = input;
      applySelectedModel(config);
    },
    event: async ({ event }) => {
      // A long-lived TUI server does not reload config between home-screen prompts.
      if (event?.type === "session.created" && config) applySelectedModel(config);
    },
  };
};
