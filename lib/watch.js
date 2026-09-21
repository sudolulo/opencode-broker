// Model-catalog watch: the assessment must not go stale when providers add
// models. Discovery auto-adopts newest family members for every mapped family;
// everything PINNED in config is a curated judgment, and this module notices
// when the catalog outgrows it:
//
//   * a model id never seen before on a watched provider (reported ONCE -- the
//     reviewed ledger remembers it afterwards);
//   * a model NEWER than a pinned one in the same name-line (qwen3.8-flash
//     pinned, qwen3.9-flash ships);
//   * a NEW family on a GOVERNED provider that the tier map does not cover, so
//     it would otherwise be silently unrouted.
//
// Pure functions here; bin/opencode-broker-watch wires the cache refresh, the
// reviewed ledger, and the notification command.
import { FAMILY_TIERS } from "./routing.js";

// `providerID:family` keys, taken from the one tier-role table rather than
// mirrored here -- a mirror is a second source of truth that drifts silently.
export const MAPPED_FAMILY_KEYS = Object.keys(FAMILY_TIERS);

// Collapse version-ish tokens so models in the same line compare equal:
// qwen3.8-flash / qwen3.9-flash -> qwen#-flash; deepseek-v4-pro-0813 and
// deepseek-v4-pro -> deepseek-v#-pro; gpt-5.6-luna / gpt-5.7-luna -> gpt-#-luna.
export const normalizeModelLine = (id) => String(id ?? "")
  .toLowerCase()
  .replace(/\d+(?:\.\d+)*/g, "#")
  .replace(/(?:[-.]#)+$/g, "")
  .replace(/#+/g, "#");

const toolCapable = (model) => model?.tool_call !== false;

export const watchReport = ({
  catalog = {},
  reviewed = {},
  targets = {},
  watchProviders = [],
  knownFamilies = MAPPED_FAMILY_KEYS,
} = {}) => {
  // A provider is GOVERNED once any of its families has a tier role: that is what
  // makes "this family has no role" a finding rather than noise. Providers nobody
  // has mapped (llamacpp, an api-key subscription) are not under this report.
  const governedProviders = new Set(knownFamilies
    .map((key) => key.slice(0, key.indexOf(":")))
    .filter(Boolean));
  const providers = new Set(watchProviders);
  const newModels = [];
  const newFamilies = new Set();
  const seenKeys = [];

  const byProvider = new Map();
  for (const provider of Object.values(catalog)) {
    if (typeof provider?.id === "string" && providers.has(provider.id)) {
      byProvider.set(provider.id, Object.values(provider.models ?? {}).filter(toolCapable));
    }
  }

  for (const [providerID, models] of byProvider) {
    for (const model of models) {
      if (typeof model?.id !== "string" || !model.id) continue;
      const key = `${providerID}/${model.id}`;
      seenKeys.push(key);
      if (!Object.prototype.hasOwnProperty.call(reviewed, key)) {
        newModels.push({
          providerID,
          id: model.id,
          family: model.family ?? null,
          releaseDate: model.release_date ?? null,
          cost: model.cost ? { input: model.cost.input ?? null, output: model.cost.output ?? null } : null,
        });
      }
      // Ledger-gated on purpose: a family can be unmapped BY DECISION (openai ships
      // gpt-image and text-embedding; neither wants a tier role), and an alert that
      // fires forever on a deliberate choice is an alert that gets muted. Firing only
      // while the family still contains an unreviewed model makes it a one-shot
      // "a new line appeared and has no role" notice, which is the actual finding.
      if (governedProviders.has(providerID) && typeof model.family === "string" && model.family &&
        !knownFamilies.includes(`${providerID}:${model.family}`) &&
        !Object.prototype.hasOwnProperty.call(reviewed, key)) {
        newFamilies.add(`${providerID}:${model.family}`);
      }
    }
  }

  const newerInLine = [];
  for (const target of Object.values(targets)) {
    const models = byProvider.get(target.providerID);
    if (!models) continue;
    const pinned = models.find((model) => model.id === target.modelID);
    const pinnedRelease = String(pinned?.release_date ?? "");
    const line = normalizeModelLine(target.modelID);
    for (const model of models) {
      if (model.id === target.modelID || normalizeModelLine(model.id) !== line) continue;
      if (String(model.release_date ?? "") > pinnedRelease) {
        newerInLine.push({
          providerID: target.providerID,
          targetID: target.id,
          pinned: target.modelID,
          newer: model.id,
          releaseDate: model.release_date ?? null,
        });
      }
    }
  }

  return { newModels, newerInLine, newFamilies: [...newFamilies].sort(), seenKeys };
};

export const formatReport = ({ newModels, newerInLine, newFamilies }) => {
  const lines = [];
  for (const family of newFamilies) {
    lines.push(`NEW FAMILY ${family}: unmapped in the tier table -- models in it will not route until mapped`);
  }
  for (const entry of newerInLine) {
    lines.push(`pin ${entry.targetID} (${entry.pinned}) has a newer line-mate: ${entry.newer} (${entry.releaseDate ?? "?"})`);
  }
  for (const model of newModels) {
    const cost = model.cost && (model.cost.input || model.cost.output)
      ? ` $${model.cost.input}/$${model.cost.output}`
      : "";
    lines.push(`new: ${model.providerID}/${model.id}${model.family ? ` [${model.family}]` : ""} (${model.releaseDate ?? "?"})${cost}`);
  }
  return lines;
};
