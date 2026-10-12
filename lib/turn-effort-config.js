import { existsSync, readFileSync } from "node:fs";
import { configFile, envSetting } from "./config.js";

const DEFAULT_CONFIG = Object.freeze({ mode: "off", policy: "tier", models: Object.freeze([]) });
const MODES = new Set(["off", "shadow", "canary", "enforce"]);
const POLICIES = new Set(["tier", "savings"]);
const CONFIG_PATH = envSetting("OPENCODE_BROKER_CONFIG", "OPENCODE_MODEL_ROUTER_CONFIG") ?? configFile("config.json");

const stripJsonComments = (text) => {
  let output = "";
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
    } else if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") output += "\n";
        index += 1;
      }
      index += 2;
    } else {
      output += character;
      index += 1;
    }
  }
  return output;
};

const invalid = (message) => {
  TURN_EFFORT_CONFIG_ERROR = `${CONFIG_PATH}: ${message}`;
  console.error(`opencode-broker: TURN EFFORT CONFIG REJECTED -- using mode off. ${TURN_EFFORT_CONFIG_ERROR}`);
  return DEFAULT_CONFIG;
};

export let TURN_EFFORT_CONFIG_ERROR = null;

const load = () => {
  if (!existsSync(CONFIG_PATH)) return invalid("config file is missing");
  let raw;
  try {
    raw = JSON.parse(stripJsonComments(readFileSync(CONFIG_PATH, "utf8"))) || {};
  } catch (error) {
    return invalid(error.message);
  }
  if (raw.turnEffort === undefined) return DEFAULT_CONFIG;
  const value = raw.turnEffort;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("turnEffort must be an object");
  if (value.mode !== undefined && !MODES.has(value.mode)) return invalid(`turnEffort.mode ${JSON.stringify(value.mode)} is invalid`);
  if (value.policy !== undefined && !POLICIES.has(value.policy)) return invalid(`turnEffort.policy ${JSON.stringify(value.policy)} is invalid`);
  if (value.models !== undefined && (!Array.isArray(value.models) || value.models.some((model) => typeof model !== "string" || !model))) {
    return invalid("turnEffort.models must be an array of nonempty strings");
  }
  return Object.freeze({
    mode: value.mode ?? "off",
    policy: value.policy ?? "tier",
    models: Object.freeze(value.models ?? []),
  });
};

export const TURN_EFFORT_CONFIG = load();
