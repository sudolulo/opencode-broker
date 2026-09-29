// The gateway key drop file, and the modes it may have.
//
// This endpoint fronts PAID QUOTA: the bearer key in this file is the only thing between a
// local account and someone else's Anthropic bill. The reconciler's Gitea token already
// refuses to be read out of a group- or world-readable file (lib/reconcile-secrets.js); a
// gateway key held to a looser standard than a forge token is the wrong way round.
//
// Nothing here ever asserts on the key's VALUE beyond the round trip, and every rejection is
// checked for NOT naming it -- an error message is the one place a startup secret leaks into
// a log that is not itself 0600.
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readGatewayKeyFile } from "../lib/gateway.js";

// Not a real credential: a literal this test writes and reads back.
const KEY_TEXT = "gateway-key-value-used-only-by-this-test";

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-key-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

const keyAt = (dir, mode, contents = `${KEY_TEXT}\n`) => {
  const path = join(dir, "gateway-key");
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
};

test("a 0600 key file is accepted and read back trimmed", () => {
  withDir((dir) => {
    assert.equal(readGatewayKeyFile(keyAt(dir, 0o600)), KEY_TEXT);
  });
});

// The whole point: every group and other bit, across all three triads, is a refusal. 0640 is
// the mode a deploy script writes when it forgets; 0604 and 0666 are the ones a careless
// umask or a `chmod -R` leaves behind.
for (const mode of [0o640, 0o604, 0o660, 0o666, 0o644, 0o610, 0o601]) {
  const octal = mode.toString(8).padStart(4, "0");
  test(`a ${octal} key file is refused, naming the path and the mode but not the key`, () => {
    withDir((dir) => {
      const path = keyAt(dir, mode);
      assert.throws(() => readGatewayKeyFile(path), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(path), `message should name the path: ${error.message}`);
        assert.ok(error.message.includes(octal), `message should name the mode: ${error.message}`);
        assert.ok(!error.message.includes(KEY_TEXT), "message must never quote the key");
        return true;
      });
    });
  });
}

test("a 0600 file holding only whitespace is refused", () => {
  withDir((dir) => {
    const path = keyAt(dir, 0o600, "   \n");
    assert.throws(() => readGatewayKeyFile(path), /is empty/);
  });
});

// A directory at the key path is a deploy that created the mount point and never dropped the
// file. readFileSync would surface EISDIR; saying what is actually wrong is cheaper to fix.
test("a directory at the key path is refused as not a regular file", () => {
  withDir((dir) => {
    const path = join(dir, "gateway-key");
    mkdirSync(path);
    assert.throws(() => readGatewayKeyFile(path), /not a regular file/);
  });
});

// ☠️ An absent key file must never read as "no key": the handler's auth gate treats a falsy
// gatewayKey as "refuse everyone", which looks identical to a broken deploy. It has to stop
// startup instead.
test("an absent key file stops startup rather than returning nothing", () => {
  withDir((dir) => {
    const path = join(dir, "gateway-key");
    assert.throws(() => readGatewayKeyFile(path), (error) => {
      assert.ok(error.message.includes(path));
      return true;
    });
    assert.notEqual(readGatewayKeyFile, undefined);
  });
});

// The mode that matters is the FILE's, not the link's: a symlink is 0777 on Linux and always
// would be, so checking the link would refuse every indirection a deploy legitimately uses.
test("a symlink to a 0600 file is accepted; a symlink to a 0644 file is refused", () => {
  withDir((dir) => {
    const tight = keyAt(dir, 0o600);
    const link = join(dir, "linked-key");
    symlinkSync(tight, link);
    assert.equal(readGatewayKeyFile(link), KEY_TEXT);

    chmodSync(tight, 0o644);
    assert.throws(() => readGatewayKeyFile(link), /0644/);
  });
});
