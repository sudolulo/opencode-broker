#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { classifyTurn, nextPrevious, TURN_CLASSES } from "../lib/turn-effort.js";

const defaultDatabases = [
  "opencode-fork-snip-always-prefix.db",
  "opencode-fork-atomic-runtime-contracts.db",
  "opencode-fork-debug-agent-stdout-drain.db",
].map((name) => join(homedir(), ".local", "share", "opencode", name));

const parseArguments = (arguments_) => {
  const databases = [];
  let samples = 5;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--db") {
      const path = arguments_[index + 1];
      if (!path) throw new Error("--db requires a path");
      databases.push(path);
      index += 1;
      continue;
    }
    if (argument === "--samples") {
      const value = Number(arguments_[index + 1]);
      if (!Number.isInteger(value) || value < 0) throw new Error("--samples requires a non-negative integer");
      samples = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { databases: databases.length ? databases : defaultDatabases, samples };
};

const parseData = (value, label) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid ${label} JSON: ${error.message}`);
  }
};

const truncate = (text) => text.length <= 120 ? text : `${text.slice(0, 117)}...`;

const replay = (path, state) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT message.session_id, message.id AS message_id, message.time_created AS message_time,
        message.data AS message_data, part.id AS part_id, part.time_created AS part_time,
        part.data AS part_data
      FROM message
      JOIN part ON part.message_id = message.id
      JOIN session ON session.id = message.session_id
      WHERE session.parent_id IS NULL
      ORDER BY message.session_id, message.time_created, message.id, part.time_created, part.id
    `).all();
    const seenSessions = new Set();
    for (const row of rows) {
      seenSessions.add(row.session_id);
      const message = parseData(row.message_data, `message ${row.message_id}`);
      const part = parseData(row.part_data, `part ${row.part_id}`);
      if (message.role !== "user" || part.type !== "text" || part.synthetic === true || typeof part.text !== "string") continue;
      const previous = state.previous.get(row.session_id);
      const result = classifyTurn({
        text: part.text,
        isSubagent: false,
        riskFloor: null,
        riskRaisedTier: false,
        previous,
      });
      state.previous.set(row.session_id, nextPrevious(previous, result));
      state.counts[result.class] += 1;
      if (state.samples[result.class].length < state.sampleLimit) state.samples[result.class].push(truncate(part.text));
    }
    state.sessionIDs = new Set([...state.sessionIDs, ...seenSessions]);
  } finally {
    database.close();
  }
};

const main = () => {
  const { databases, samples } = parseArguments(process.argv.slice(2));
  const state = {
    counts: Object.fromEntries(TURN_CLASSES.map((turnClass) => [turnClass, 0])),
    samples: Object.fromEntries(TURN_CLASSES.map((turnClass) => [turnClass, []])),
    previous: new Map(),
    sessionIDs: new Set(),
    sampleLimit: samples,
  };
  for (const path of databases) {
    if (!existsSync(path)) {
      console.log(`skipping missing database: ${path}`);
      continue;
    }
    replay(path, state);
  }
  const total = TURN_CLASSES.reduce((sum, turnClass) => sum + state.counts[turnClass], 0);
  console.log(`main sessions: ${state.sessionIDs.size}`);
  console.log(`real user text parts: ${total}`);
  for (const turnClass of TURN_CLASSES) {
    const percentage = total === 0 ? 0 : (state.counts[turnClass] / total) * 100;
    console.log(`${turnClass}: ${state.counts[turnClass]} (${percentage.toFixed(1)}%)`);
  }
  for (const turnClass of TURN_CLASSES) {
    console.log(`${turnClass} samples:`);
    for (const sample of state.samples[turnClass]) console.log(`- ${sample}`);
  }
};

main();
