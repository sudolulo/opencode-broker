// The ONE reader of the reconciler's Gitea write token, and deliberately the only one.
//
// The token is provisioned by deployment into a mode-0600 drop file. It is never fetched from a
// password manager at run time, never passed in argv, never written into ledger state, issue text
// or a log line, and never handed to a model: the evidence collector holds it only so it can
// REFUSE a researcher payload that quotes it (see lib/reconcile-collector.js), and the child it
// spawns gets a scrubbed environment.
//
// A single reader matters because the loose-mode check below is the whole guarantee that the
// token is not readable by another account on the host. A second call site that read the file
// directly would silently skip that check, so Task 5's Gitea client imports this function instead.
import { readFileSync, statSync } from "node:fs";

// Group and other bits, for the read/write/execute triads we refuse to see set.
const SHARED_MODE_BITS = 0o077;

export const readGiteaTokenIfPresent = (tokenPath) => {
  if (typeof tokenPath !== "string" || tokenPath === "") return null;

  let stats;
  try {
    stats = statSync(tokenPath);
  } catch (error) {
    // Absent is a legitimate deployment: the projections ship off, and nothing that needs a
    // token runs until an operator drops one in.
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile()) throw new Error(`${tokenPath} is not a regular file`);

  const mode = stats.mode & 0o777;
  if (mode & SHARED_MODE_BITS) {
    // Loud, never a downgrade to "no token": a deployment that provisioned a credential and
    // left it group-readable has a problem that silence would preserve. The message names the
    // path and the mode and never the contents.
    throw new Error(`${tokenPath} is group- or world-readable (mode ${mode.toString(8).padStart(4, "0")}); chmod 600 it`);
  }

  const token = readFileSync(tokenPath, "utf8").trim();
  if (token === "") {
    throw new Error(`${tokenPath} is empty; remove the file or write the token into it`);
  }
  return token;
};
