import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { consumeManagedModelSwitch } from "../lib/routing.js";

const DIRECTORY = join(homedir(), ".local/share/opencode");
const STATE = join(DIRECTORY, "model-default.json");

const persist = (model) => {
  if (typeof model?.providerID !== "string" || !model.providerID) return false;
  if (typeof model?.id !== "string" || !model.id) return false;

  try {
    mkdirSync(DIRECTORY, { recursive: true });
    writeFileSync(STATE, JSON.stringify(model) + "\n", { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
};

export default {
  id: "opencode-broker-model-default",
  tui: async (api) => {
    const unsubscribe = api.event.on("session.next.model.switched", (event) => {
      const sessionID = event.properties?.sessionID;
      const model = event.properties?.model;
      if (consumeManagedModelSwitch(sessionID, model)) return;
      if (persist(model)) return;
      api.ui.toast({
        variant: "error",
        title: "model default",
        message: "Could not save the selected model for future prompts.",
      });
    });

    api.lifecycle.onDispose(unsubscribe);
  },
};
