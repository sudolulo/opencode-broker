import assert from "node:assert/strict";
import test from "node:test";
import { notifyArgv } from "../lib/notify.js";

test("a plain notify command gets the title and body appended", () => {
  assert.deepEqual(notifyArgv(["/usr/local/bin/notify"], { title: "T", body: "B", kind: "stop" }),
    ["/usr/local/bin/notify", "T", "B"]);
});

test("no command configured means nothing to run, not a title run as a command", () => {
  assert.deepEqual(notifyArgv([], { title: "T", body: "B" }), []);
  assert.deepEqual(notifyArgv(undefined, { title: "T", body: "B" }), []);
});

test("placeholders put the message where the command wants it, and nothing is appended", () => {
  assert.deepEqual(notifyArgv(["notify", "--title={title}", "{body}", "--priority", "high", "--tag", "{kind}"],
    { title: "Burn watch", body: "It stopped", kind: "stop" }),
  ["notify", "--title=Burn watch", "It stopped", "--priority", "high", "--tag", "stop"]);
});

test("a message is substituted once and never expanded again", () => {
  assert.deepEqual(notifyArgv(["notify", "{title}", "{body}"], { title: "{body}", body: "x" }),
    ["notify", "{body}", "x"]);
});
