import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const execFile = promisify(execFileCallback);
const repo = new URL("..", import.meta.url).pathname;

const run = (script, args) => execFile(process.execPath, [join(repo, script), ...args], { cwd: repo });

const createReplayFixture = (path) => {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  const session = db.prepare("INSERT INTO session (id, parent_id) VALUES (?, ?)");
  session.run("root", null);
  session.run("child", "root");
  const message = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)");
  const part = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)");
  message.run("m1", "root", 10, JSON.stringify({ role: "user" }));
  part.run("p1", "m1", "root", 10, JSON.stringify({ type: "text", text: "Please think deeply about this migration" }));
  message.run("m2", "root", 11, JSON.stringify({ role: "assistant" }));
  part.run("p2", "m2", "root", 11, JSON.stringify({ type: "text", text: "I will" }));
  message.run("m3", "root", 12, JSON.stringify({ role: "user" }));
  part.run("p3", "m3", "root", 12, JSON.stringify({ type: "text", text: "synthetic prompt", synthetic: true }));
  message.run("m4", "root", 13, JSON.stringify({ role: "user" }));
  part.run("p4", "m4", "root", 13, JSON.stringify({ type: "text", text: "continue" }));
  message.run("m5", "root", 14, JSON.stringify({ role: "user" }));
  part.run("p5", "m5", "root", 14, JSON.stringify({ type: "text", text: "status?" }));
  message.run("m6", "child", 15, JSON.stringify({ role: "user" }));
  part.run("p6", "m6", "child", 15, JSON.stringify({ type: "text", text: "think deeply" }));
  db.close();
};

test("replay classifies real main-session user parts without writing its SQLite fixture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turn-effort-replay-"));
  try {
    const dbPath = join(dir, "sessions.db");
    createReplayFixture(dbPath);
    const before = await readFile(dbPath);

    const { stdout } = await run("scripts/turn-effort-replay.mjs", ["--db", dbPath, "--samples", "1"]);

    assert.deepEqual(await readFile(dbPath), before, "the replay opens its database read-only");
    assert.match(stdout, /main sessions: 1/);
    assert.match(stdout, /normal: 0 \(0\.0%\)/);
    assert.match(stdout, /light: 1 \(33\.3%\)/);
    assert.match(stdout, /hard: 2 \(66\.7%\)/);
    assert.match(stdout, /hard samples:\n- Please think deeply about this migration/);
    assert.doesNotMatch(stdout, /synthetic prompt|child/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("report keeps unmatched turns, reports malformed JSONL, and compares cache-read shares", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turn-effort-report-"));
  try {
    const turns = [
      { leaseID: "lease-hard", class: "hard", eligible: true, base: "high", applied: "xhigh" },
      { leaseID: "lease-normal", class: "normal", eligible: true, base: "high", applied: "high" },
      { leaseID: "lease-light", class: "light", eligible: false, base: "high", applied: "high" },
    ];
    const usage = [
      { leaseID: "lease-hard", input: 100, cacheRead: 900, output: 50 },
      { leaseID: "lease-normal", input: 800, cacheRead: 200, output: 20 },
    ];
    await writeFile(join(dir, "turn-effort.jsonl"), `${turns.map(JSON.stringify).join("\n")}\nnot json\n`);
    await writeFile(join(dir, "usage.jsonl.1"), `${usage.map(JSON.stringify).join("\n")}\nnot json\n`);

    const { stdout } = await run("scripts/turn-effort-report.mjs", ["--dir", dir]);

    assert.match(stdout, /shadow data shows distributions only, not causal savings/i);
    assert.match(stdout, /cache tripwire: cacheRead \/ prompt/);
    assert.match(stdout, /hard: turns 1, matched 1, unmatched 0, mean output tokens 50/);
    assert.match(stdout, /normal: turns 1, matched 1, unmatched 0, mean output tokens 20/);
    assert.match(stdout, /light: turns 1, matched 0, unmatched 1, mean output tokens n\/a/);
    assert.match(stdout, /changed applied: 0\.900; unchanged applied: 0\.200/);
    assert.match(stdout, /malformed JSONL lines: 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
