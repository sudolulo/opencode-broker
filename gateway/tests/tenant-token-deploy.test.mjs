// The deploy step for the tenant surface's credential:
// `gateway/bin/opencode-broker-tenant-token`.
//
// Why it is a script and not two lines of README shell: the drop file has four properties that
// are all easy to get silently wrong by hand, and every one of them is a live failure --
// world-readable mode hands a card-eviction credential to every user on the host, a clobbered
// token 401s every render from a container still mounting the old copy, a token echoed to the
// terminal lands in scrollback and shell history, and a trailing newline or a `$` mangled by a
// double-quoted shell string produces a token the gateway trims into something else.
//
// The script is spawned for real here: it only ever writes a file under a temp path this test
// owns. It never reaches a GPU, a router, or midclt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("../bin/opencode-broker-tenant-token", import.meta.url).pathname;

const tempDirs = [];
process.on("exit", () => {
  for (const dir of tempDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});
const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-token-"));
  tempDirs.push(dir);
  return join(dir, "tenant-token");
};

// ☆ Owner and group default to root:root, which a test cannot set. Passing the current user
// keeps the chown path exercised (it is where a non-root deploy must fail loudly) without
// needing privilege.
const run = (args) => {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const runAsMe = (args) => run([...args, "--owner", String(process.getuid()), "--group", String(process.getgid())]);

// ☆ A REAL write failure, not a mocked one: RLIMIT_FSIZE 0 lets the staging `openSync(.., "wx")`
// succeed -- creating a zero-length file is within the limit -- and makes the very next
// `writeSync` of the token fail with EFBIG. That is the exact shape of the failure this path
// exists for (a full or quota-exhausted deploy target), reached without mocking node:fs and
// without a privileged mount, so the script under test is the shipped script.
const runWithNoWritableBytes = (args) => {
  const argv = [...args, "--owner", String(process.getuid()), "--group", String(process.getgid())];
  const result = spawnSync("/bin/sh", ["-c", 'ulimit -f 0; exec "$0" "$@"', process.execPath, SCRIPT, ...argv],
    { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

test("writes a 0640 drop file and never prints the token", () => {
  const path = tempPath();
  const result = runAsMe(["--path", path]);
  assert.equal(result.code, 0, result.stderr);
  const token = readFileSync(path, "utf8");
  // 0640: the gateway's user reads it, a group the container maps to reads it, nobody else.
  assert.equal(statSync(path).mode & 0o777, 0o640, "the drop file must not be readable by others");
  assert.ok(token.length >= 32, `a token of ${token.length} chars is not worth writing`);
  // ☠️ A secret printed to stdout is a secret in the operator's scrollback and in any deploy
  // log that captures it. The script reports the PATH, never the value.
  assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token),
    "the token must never appear in the script's own output");
  assert.match(result.stdout, /tenant-token/, "the path is what the operator needs told");
});

test("the token survives the readFileSync().trim() the gateway does to it", () => {
  // The gateway reads the file with `readFileSync(path, "utf8").trim()`. A token that changes
  // under trim -- one written with a trailing newline, or with leading whitespace -- means the
  // container's mounted copy and the gateway's in-memory copy are different strings, and every
  // render 401s with both sides looking correct.
  const path = tempPath();
  assert.equal(runAsMe(["--path", path]).code, 0);
  const raw = readFileSync(path, "utf8");
  assert.equal(raw, raw.trim(), "the file must hold exactly the token, no surrounding whitespace");
  assert.doesNotMatch(raw, /\s/, "whitespace inside the token would split under any shell word-splitting");
});

test("refuses to overwrite an existing token", () => {
  // ☠️ THE ONE THAT BITES. Re-running a deploy must not rotate this credential: the container
  // holds a bind-mounted copy read at ITS start, so a silent rotation leaves ComfyUI presenting
  // a stale token and every render 401ing until someone restarts the container. Rotation is a
  // deliberate act, never a side effect of running the deploy again.
  const path = tempPath();
  writeFileSync(path, "already-deployed-value", { mode: 0o640 });
  const result = runAsMe(["--path", path]);
  assert.notEqual(result.code, 0, "an accidental rotation must fail loudly, not succeed quietly");
  assert.equal(readFileSync(path, "utf8"), "already-deployed-value", "the existing token is untouched");
  assert.match(result.stderr, /--force/, "the refusal must name the way to do it on purpose");
});

test("--force rotates the token to a different value", () => {
  const path = tempPath();
  assert.equal(runAsMe(["--path", path]).code, 0);
  const first = readFileSync(path, "utf8");
  const result = runAsMe(["--path", path, "--force"]);
  assert.equal(result.code, 0, result.stderr);
  const second = readFileSync(path, "utf8");
  assert.notEqual(second, first, "a rotation that produced the same token would not be a rotation");
  assert.equal(statSync(path).mode & 0o777, 0o640, "rotating must not relax the mode of an existing file");
});

test("a failed token write leaves no staging file behind", () => {
  // ☠️ A deploy step that dies mid-write must not seed the config directory with
  // `.tenant-token.new.<pid>` droppings. They accumulate one per failed attempt, they sit next to
  // a live credential in a directory an operator greps when a tenant 401s, and a 0600 file whose
  // name says "new token" invites someone to mount the empty one. The chown path already cleans
  // up after itself; the write path must too.
  const path = tempPath();
  const dir = dirname(path);
  const result = runWithNoWritableBytes(["--path", path]);
  assert.match(result.stderr, /cannot write/,
    "the write must actually have been forced to fail -- otherwise this test proves nothing");
  assert.notEqual(result.code, 0, "a deploy that wrote no token must not claim success");
  assert.throws(() => statSync(path), /ENOENT/, "no drop file may be left at the target path");
  assert.deepEqual(readdirSync(dir), [],
    "a failed write must leave the directory exactly as it found it, staging file included");
});

test("a chown it cannot perform fails loudly and leaves no partial drop file", () => {
  // ☆ The tool is a REQUIREMENT, not an option: a deploy that could not set root ownership must
  // say so, not write a token owned by whoever happened to run it. Root is uid 0, so a non-root
  // test process asking for the default ownership is exactly this case.
  const path = tempPath();
  const result = run(["--path", path, "--owner", "0", "--group", "0"]);
  if (process.getuid() === 0) return; // running the suite as root cannot exercise the refusal
  assert.notEqual(result.code, 0, "an unprivileged deploy must not claim success");
  assert.match(result.stderr, /own/i, "the message must name ownership as the problem");
  assert.throws(() => statSync(path), /ENOENT/,
    "a half-deployed token file is worse than none: the gateway would come up serving a token nobody mounted");
});
