// Test-only preload (`node --require`) for spawned brokers with an enabled outage policy. It
// replaces global fetch so the official status feeds are never contacted: every status request
// is recorded and answered offline, and any other non-loopback destination is refused loudly.
// Loopback requests (the fixture gateway, a local model endpoint) pass through unchanged.
//
//   OPENCODE_BROKER_TEST_FETCH_TRACE   JSONL file each intercepted request is appended to
//   OPENCODE_BROKER_TEST_STATUS_MODE   "unavailable" (default): answer HTTP 503, which the
//                                      bounded fetcher normalizes to an unknown snapshot;
//                                      "hang": never answer, settle only when aborted.
const { appendFileSync } = require("node:fs");

const original = globalThis.fetch;
const tracePath = process.env.OPENCODE_BROKER_TEST_FETCH_TRACE;
const mode = process.env.OPENCODE_BROKER_TEST_STATUS_MODE ?? "unavailable";
const STATUS_HOSTS = new Set(["status.claude.com", "status.openai.com"]);
const loopback = (hostname) => hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
const record = (event) => { if (tracePath) appendFileSync(tracePath, `${JSON.stringify({ at: Date.now(), ...event })}\n`); };

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (STATUS_HOSTS.has(url.hostname)) {
    record({ kind: "status", host: url.hostname, path: url.pathname });
    if (mode === "hang") {
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
  }
  if (!loopback(url.hostname)) {
    record({ kind: "refused", host: url.hostname });
    throw new Error(`test fixture refuses network access to ${url.hostname}`);
  }
  return original(input, init);
};
