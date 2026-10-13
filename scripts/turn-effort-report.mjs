#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { TURN_CLASSES } from "../lib/turn-effort.js";

const defaultDirectory = join(homedir(), ".local", "share", "opencode", "model-routing");

const parseArguments = (arguments_) => {
  if (arguments_.length === 0) return defaultDirectory;
  if (arguments_.length === 2 && arguments_[0] === "--dir" && arguments_[1]) return arguments_[1];
  throw new Error("usage: turn-effort-report.mjs [--dir <path>]");
};

const readJsonLines = (directory, name, state) => {
  const records = [];
  for (const suffix of [".1", ""]) {
    const path = join(directory, `${name}${suffix}`);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        state.malformed += 1;
      }
    }
  }
  return records;
};

const number = (value) => Math.max(0, Number(value) || 0);
const cacheRatio = (usage) => {
  const prompt = number(usage.prompt) || number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite);
  return prompt === 0 ? 0 : number(usage.cacheRead) / prompt;
};

const main = () => {
  const directory = parseArguments(process.argv.slice(2));
  const state = { malformed: 0 };
  const turns = readJsonLines(directory, "turn-effort.jsonl", state);
  const usage = readJsonLines(directory, "usage.jsonl", state);
  const usageByLease = new Map();
  for (const record of usage) {
    if (typeof record.leaseID !== "string") continue;
    const rows = usageByLease.get(record.leaseID) ?? [];
    rows.push(record);
    usageByLease.set(record.leaseID, rows);
  }
  const classes = Object.fromEntries(TURN_CLASSES.map((turnClass) => [turnClass, {
    turns: 0, matched: 0, unmatched: 0, output: 0,
  }]));
  const unclassified = { turns: 0, matched: 0, unmatched: 0 };
  const tripwire = { changed: [], unchanged: [] };
  for (const turn of turns) {
    const summary = TURN_CLASSES.includes(turn.class) ? classes[turn.class] : unclassified;
    summary.turns += 1;
    const rows = typeof turn.leaseID === "string" ? usageByLease.get(turn.leaseID) : undefined;
    if (!rows?.length) {
      summary.unmatched += 1;
      continue;
    }
    summary.matched += 1;
    if (!TURN_CLASSES.includes(turn.class)) continue;
    summary.output += rows.reduce((sum, row) => sum + number(row.output), 0);
    if (turn.eligible === true) {
      const first = [...rows].sort((left, right) => number(left.at) - number(right.at))[0];
      tripwire[turn.applied !== turn.base ? "changed" : "unchanged"].push(cacheRatio(first));
    }
  }
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  console.log("shadow data shows distributions only, not causal savings.");
  console.log("cache tripwire: cacheRead / prompt on the first usage row of each matched eligible turn; prompt is input + cacheRead + cacheWrite.");
  for (const turnClass of TURN_CLASSES) {
    const summary = classes[turnClass];
    const output = summary.matched ? String(summary.output / summary.matched) : "n/a";
    console.log(`${turnClass}: turns ${summary.turns}, matched ${summary.matched}, unmatched ${summary.unmatched}, mean output tokens ${output}`);
  }
  // Title calls produce no usage rows and compaction leases are unclassified.
  console.log(`unclassified: turns ${unclassified.turns}, matched ${unclassified.matched}, unmatched ${unclassified.unmatched}`);
  const changed = mean(tripwire.changed);
  const unchanged = mean(tripwire.unchanged);
  console.log(`cache tripwire changed applied: ${changed === null ? "n/a" : changed.toFixed(3)}; unchanged applied: ${unchanged === null ? "n/a" : unchanged.toFixed(3)}`);
  console.log(`malformed JSONL lines: ${state.malformed}`);
};

main();
