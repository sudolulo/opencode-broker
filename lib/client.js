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
// Keep HTTP origin outside the exposed fields: response bodies cannot forge or erase it.
const HTTP_ERRORS = new WeakSet();
const brokerError = (parsed, statusCode) => {
  const error = new Error(parsed?.error || `broker HTTP ${statusCode ?? "error"}`);
  for (const [key, value] of Object.entries(parsed && typeof parsed === "object" ? parsed : {})) {
    if (ERROR_OWN_FIELDS.has(key) || value === undefined) continue;
    error[key] = value;
  }
  HTTP_ERRORS.add(error);
  return error;
};

// Cloud admission can legitimately wait for the daemon's 30 s arrival window while a
// plan-usage reader completes.  These two mutating routes get one end-to-end allowance,
// rather than making the existing 2.5 s transport timeout the daemon's effective limit.
const LEASE_FAILURE_DEADLINE_MS = 32_500;

const brokerRequestOnce = (path, body = {}, { timeout = 2500, method = "POST", deadline = null } = {}) => new Promise((resolve, reject) => {
  let remaining = deadline === null ? timeout : deadline - Date.now();
  if (deadline !== null && remaining <= 0) {
    reject(new Error("broker timeout"));
    return;
  }
  const payload = method === "GET" ? null : JSON.stringify(body);
  if (deadline !== null) {
    remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new Error("broker timeout"));
      return;
    }
  }
  let settled = false;
  let request;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    callback(value);
  };
  const deadlineTimer = deadline === null ? null : setTimeout(() => {
    const error = new Error("broker timeout");
    request?.destroy(error);
    finish(reject, error);
  }, remaining);
  try {
    request = http.request({
      socketPath: SOCKET,
      path,
      method,
      headers: payload === null
        ? {}
        : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      timeout: remaining,
    }, (response) => {
      let text = "";
      // A peer can abort after headers without a request error or response end.
      // Keep this listener after settlement to consume late destruction errors too.
      response.on("error", (error) => finish(reject, error));
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : {}; } catch {}
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          finish(resolve, parsed ?? {});
          return;
        }
        finish(reject, brokerError(parsed, response.statusCode));
      });
    });
    request.on("timeout", () => request.destroy(new Error("broker timeout")));
    request.on("error", (error) => finish(reject, error));
    request.end(payload ?? undefined);
  } catch (error) {
    finish(reject, error);
    if (request) request.destroy();
  }
});

// One retry for transient faults. Under host load spikes (shared kernel) a
// single slow broker tick otherwise surfaces as an error in the SESSION --
// and a plugin throw on the message path blocks the send. A dead broker
// still fails fast: connection refusals reject in milliseconds, so the
// retry adds ~250ms, not another full timeout.
const TRANSIENT = /broker timeout|ECONNREFUSED|ECONNRESET|EPIPE|ENOENT/;

export const brokerRequest = async (path, body = {}, options = {}) => {
  const sharedDeadline = options.timeout === undefined && (options.method === undefined || options.method === "POST") &&
    (path === "/lease" || path === "/failure")
    ? Date.now() + LEASE_FAILURE_DEADLINE_MS
    : null;
  const requestOptions = sharedDeadline === null ? options : { ...options, deadline: sharedDeadline };
  try {
    return await brokerRequestOnce(path, body, requestOptions);
  } catch (error) {
    if (HTTP_ERRORS.has(error) || !TRANSIENT.test(String(error?.message ?? ""))) throw error;
    const remaining = sharedDeadline === null ? null : sharedDeadline - Date.now();
    if (remaining !== null && remaining <= 0) throw error;
    const retryDelay = remaining === null ? 250 : Math.min(250, remaining);
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
    return brokerRequestOnce(path, body, requestOptions);
  }
};

export const selectBrokerTransport = ({ brokerRequest: ordinaryRequest, healthRequest, quotaEvidenceRequest }) => (path, body) =>
  path === "/quota-evidence"
    ? typeof quotaEvidenceRequest === "function"
      ? quotaEvidenceRequest(path, body)
      : Promise.reject(new Error("quota evidence transport unavailable"))
    : path.startsWith("/model-health/") ||
  ((path === "/probe/consume" || path === "/probe/release") && body?.purpose === "outage-health")
    ? healthRequest(path, body) : ordinaryRequest(path, body);

// Health reports are capabilities: retrying the ordinary client here would duplicate an
// outcome delivery. This transport therefore makes exactly one, size-bounded delivery
// under an absolute deadline, including while a peer trickles response bytes.
const createBoundedOneShotBrokerRequest = ({ socketPath, timeoutMs, paths, prefix, rejected }) => (path, body = {}) => new Promise((resolve, reject) => {
  if (!paths.includes(path)) return reject(new Error(`${prefix} path`));
  if (typeof socketPath !== "string" || !socketPath || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return reject(new Error(`${prefix} options`));
  }
  let payload;
  try { payload = JSON.stringify(body); } catch (error) { reject(error); return; }
  const chunks = [];
  let bytes = 0;
  let settled = false;
  let request;
  const finishError = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  };
  const timer = setTimeout(() => {
    const error = new Error(`${prefix} deadline`);
    request?.destroy(error);
    finishError(error);
  }, timeoutMs);
  try {
    request = http.request({
      socketPath,
      path,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (response) => {
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) {
          const error = new Error(`${prefix} response size`);
          request.destroy(error);
          finishError(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", finishError);
      response.on("end", () => {
        if (settled) return;
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode < 200 || response.statusCode >= 300) {
            // A caller distinguishes refusals by the HTTP status and the broker's static
            // machine-readable code, never by message text. Only a short kebab-case token is
            // copied, so free text in a reply body can never reach the caller's diagnostics.
            const error = new Error(rejected);
            error.status = response.statusCode;
            if (typeof value?.code === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.code)) error.code = value.code;
            throw error;
          }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        } catch (error) {
          finishError(error);
        }
      });
    });
    request.on("error", finishError);
    request.end(payload);
  } catch (error) {
    finishError(error);
  }
});

export const createHealthBrokerRequest = ({ socketPath = brokerSocketPath(), timeoutMs = 400 } = {}) =>
  createBoundedOneShotBrokerRequest({
    socketPath, timeoutMs, paths: ["/model-health/begin", "/model-health/outcome", "/probe/consume", "/probe/release"],
    prefix: "health", rejected: "health report rejected",
  });

export const createQuotaEvidenceBrokerRequest = ({ socketPath = brokerSocketPath(), timeoutMs = 400 } = {}) =>
  createBoundedOneShotBrokerRequest({
    socketPath, timeoutMs, paths: ["/quota-evidence"],
    prefix: "quota evidence", rejected: "quota evidence rejected",
  });
