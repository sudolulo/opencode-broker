// How the gateway captures a `model-swap` child's diagnostic output.
//
// ☠️ Nothing here may spawn a real `model-swap` -- the 2026-09-07 incident recorded in
// tenant.test.mjs was a test run that fired a real swap and pulled a model out from under a
// live session. Every child below is `process.execPath` running an inline script, which owns
// no card and touches no reservation state.
//
// The property under test is memory safety, not formatting: a swap that goes wrong can print
// without bound (a retry loop, a driver dumping state), and the gateway holds that string in
// a process that is also serving paid requests.
import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_SWAP_OUTPUT_LIMIT, createModelSwapCapture, spawnModelSwap } from "../lib/gateway.js";

const node = (script) => spawnModelSwap(process.execPath, ["-e", script]);

// ☠️ The bound has to hold AFTER EVERY CHUNK, not once at the end. Slicing only when the child
// exits still lets a swap stuck in a retry loop grow the string without limit for as long as it
// runs, inside a process that is concurrently serving paid requests. Asserting on the final
// value cannot tell the two apart, so this test reads the retained text as it accumulates.
test("retained output never exceeds the ceiling while chunks are still arriving", () => {
  const limit = 1024;
  const capture = createModelSwapCapture(limit);
  const sink = capture.sink();

  for (let i = 0; i < 64; i += 1) {
    sink(Buffer.from("a".repeat(8192), "utf8"));
    assert.ok(
      capture.text().length <= limit,
      `after chunk ${i} the capture held ${capture.text().length} chars, ceiling is ${limit}`,
    );
  }
});

test("the ceiling is a small diagnostic bound, not a document buffer", () => {
  assert.equal(MODEL_SWAP_OUTPUT_LIMIT, 32 * 1024);
});

test("a child that prints past the ceiling is capped in flight, keeping the tail", async () => {
  // Four times the ceiling, written in pieces so the cap has to hold across many data events
  // rather than once at the end.
  const script = `
    process.stdout.write("HEAD-MARKER");
    for (let i = 0; i < 16; i += 1) process.stdout.write("a".repeat(8192));
    process.stdout.write("TAIL-MARKER");
  `;
  const result = await node(script);

  assert.equal(result.code, 0);
  assert.ok(
    result.output.length <= MODEL_SWAP_OUTPUT_LIMIT,
    `retained ${result.output.length} chars, ceiling is ${MODEL_SWAP_OUTPUT_LIMIT}`,
  );
  assert.ok(result.output.endsWith("TAIL-MARKER"), "the tail is the useful end of a failure");
  assert.ok(!result.output.includes("HEAD-MARKER"), "the head is what gets dropped");
});

// A UTF-8 character that straddles two chunks decodes to U+FFFD twice if each Buffer is
// stringified on its own, which is how a swap's error line becomes unreadable exactly when it
// is being read.
test("a multibyte character split across chunks decodes intact", async () => {
  const script = `
    const buf = Buffer.from("model-swap: \\u65e5\\u672c\\u8a9e refused", "utf8");
    const cut = buf.indexOf(0xe6) + 1;   // one byte into the first three-byte character
    process.stdout.write(buf.subarray(0, cut));
    setTimeout(() => process.stdout.write(buf.subarray(cut)), 25);
  `;
  const result = await node(script);

  assert.equal(result.code, 0);
  assert.equal(result.output, "model-swap: \u65e5\u672c\u8a9e refused");
  assert.ok(!result.output.includes("\uFFFD"), "no replacement characters");
});

// stdout and stderr are separate byte streams; decoding them through one shared decoder makes
// a partial character on one stream corrupt the next chunk of the other.
test("stdout and stderr are decoded independently", async () => {
  const script = `
    const out = Buffer.from("\\u65e5", "utf8");
    process.stdout.write(out.subarray(0, 2));
    setTimeout(() => {
      process.stderr.write("stderr-line");
      setTimeout(() => process.stdout.write(out.subarray(2)), 25);
    }, 25);
  `;
  const result = await node(script);

  assert.equal(result.code, 0);
  assert.ok(result.output.includes("stderr-line"), "stderr is captured");
  assert.ok(result.output.includes("\u65e5"), "the split stdout character survives");
  assert.ok(!result.output.includes("\uFFFD"), "no replacement characters");
});

// ☠️ model-swap exits 0 on a policy refusal, so the gateway reads the reservation back rather
// than trusting the code -- but a non-zero code still has to arrive intact for the log line.
test("the exit code is reported as the child gave it", async () => {
  const result = await spawnModelSwap(process.execPath, ["-e", "process.exit(7)"]);
  assert.equal(result.code, 7);
});

// An ENOENT is a deployment fault, not a tenant declining: it resolves rather than rejects so
// the handler can log it, and carries the reason.
test("a command that does not exist resolves with a null code and the reason", async () => {
  const result = await spawnModelSwap("/does/not/exist/model-swap-for-tests", ["reserve"]);
  assert.equal(result.code, null);
  assert.match(result.output, /ENOENT/);
});
