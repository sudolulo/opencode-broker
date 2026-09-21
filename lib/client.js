// The broker wire client: JSON-over-HTTP on a unix socket.
//
// The socket path is part of the router's documented contract -- opencode-guard and
// any other integration reach the broker the same way. docs/API.md describes
// the endpoints.
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// ☆ Overridable so a second broker can be stood up on its own socket -- which is the
// only way to rehearse a broker OUTAGE without inflicting one on every live session.
// The hardcoded path meant the 2026-09-17 "does a session recover when the broker comes
// back?" question could only be answered by taking the real broker down while people
// were working. Unset in normal operation, so the default path is unchanged.
const SOCKET = process.env.OPENCODE_MODEL_BROKER_SOCKET ||
  join(homedir(), ".local/share/opencode/model-routing/broker.sock");

export const brokerSocketPath = () => SOCKET;

// A non-2xx body is STRUCTURE, not just prose. The broker labels a /lease refusal with a
// machine-readable `code` (docs/API.md) so a caller can tell "the model is being swapped
// in, keep waiting" from "there is no target for you, give up" -- and rebuilding the
// Error from `parsed.error` alone threw that away at the last possible moment, leaving
// every consumer to re-implement this socket transport just to read a field the broker
// had already sent. One of them did.
// ☠️ `message` stays BYTE-IDENTICAL. It is shown to users verbatim in toasts and written
// to logs; the structure is additive and nothing may be moved into or out of the text.
// ☠️ Only what the broker ACTUALLY SENT is attached. An absent `code` must leave
// `error.code` undefined, because absence is itself the signal -- consumers read it as
// "final, do not wait", and a default or an empty string would answer a question the
// broker did not answer.
// ☆ Generic over the body, so the next endpoint that returns structure needs no edit
// here. `error` is excluded (it IS the message) and so is anything that would overwrite
// an Error's own machinery.
const ERROR_OWN_FIELDS = new Set(["error", "message", "stack", "name", "cause"]);
const brokerError = (parsed, statusCode) => {
  const error = new Error(parsed?.error || `broker HTTP ${statusCode ?? "error"}`);
  for (const [key, value] of Object.entries(parsed && typeof parsed === "object" ? parsed : {})) {
    if (ERROR_OWN_FIELDS.has(key) || value === undefined) continue;
    error[key] = value;
  }
  return error;
};

const brokerRequestOnce = (path, body = {}, { timeout = 2500 } = {}) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const request = http.request({
    socketPath: SOCKET,
    path,
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    timeout,
  }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => {
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : {}; } catch {}
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
        resolve(parsed ?? {});
        return;
      }
      reject(brokerError(parsed, response.statusCode));
    });
  });
  request.on("timeout", () => request.destroy(new Error("broker timeout")));
  request.on("error", reject);
  request.end(payload);
});

// One retry for transient faults. Under host load spikes (shared kernel) a
// single slow broker tick otherwise surfaces as an error in the SESSION --
// and a plugin throw on the message path blocks the send. A dead broker
// still fails fast: connection refusals reject in milliseconds, so the
// retry adds ~250ms, not another full timeout.
const TRANSIENT = /broker timeout|ECONNREFUSED|ECONNRESET|EPIPE|ENOENT/;

export const brokerRequest = async (path, body = {}, options = {}) => {
  try {
    return await brokerRequestOnce(path, body, options);
  } catch (error) {
    if (!TRANSIENT.test(String(error?.message ?? ""))) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return brokerRequestOnce(path, body, options);
  }
};
