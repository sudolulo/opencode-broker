#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv.length !== 4 || process.argv[2] !== "models" || process.argv[3] !== "--pure") {
  throw new Error(`unexpected argv: ${JSON.stringify(process.argv.slice(2))}`);
}
const xdgConfigHome = process.env.XDG_CONFIG_HOME;
if (!xdgConfigHome) throw new Error("XDG_CONFIG_HOME is required");
const configPath = join(xdgConfigHome, "opencode", "opencode.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const modelKeys = [];
for (const [providerID, provider] of Object.entries(config.provider ?? {})) {
  for (const modelID of Object.keys(provider.models ?? {})) modelKeys.push(`${providerID}/${modelID}`);
}
if (process.env.FAKE_OPENCODE_RECORD) {
  writeFileSync(process.env.FAKE_OPENCODE_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    xdgConfigHome,
    configPath,
  }));
}
process.stdout.write(`${modelKeys.sort().join("\n")}\n`);
