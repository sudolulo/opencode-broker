import { appendFileSync, chmodSync, rmSync } from "node:fs";
import { createServer } from "node:http";

const [tracePath, socketPath] = process.argv.slice(2);
if (!tracePath || !socketPath) throw new Error("usage: runtime-boundary-trap TRACE_PATH SOCKET_PATH");

const record = (entry) => appendFileSync(tracePath, `${JSON.stringify({
  observerPID: process.pid,
  ...entry,
})}\n`);

const handler = (transport) => async (request, response) => {
  let bytes = 0;
  for await (const chunk of request) bytes += chunk.length;
  record({ kind: "request", transport, method: request.method, path: request.url, bytes });
  response.writeHead(503, { "content-type": "application/json" });
  response.end(`${JSON.stringify({ error: "runtime boundary trap" })}\n`);
};

const broker = createServer(handler("broker"));
const external = createServer(handler("external"));
for (const [transport, server] of [["broker", broker], ["external", external]]) {
  server.on("connection", () => record({ kind: "connection", transport }));
}

await new Promise((resolve, reject) => {
  broker.once("error", reject);
  broker.listen(socketPath, resolve);
});
chmodSync(socketPath, 0o600);
await new Promise((resolve, reject) => {
  external.once("error", reject);
  external.listen(0, "127.0.0.1", resolve);
});

process.stdout.write(`${JSON.stringify({ port: external.address().port })}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await Promise.all([
    new Promise((resolve) => broker.close(resolve)),
    new Promise((resolve) => external.close(resolve)),
  ]);
  rmSync(socketPath, { force: true });
};

process.once("SIGTERM", () => { void stop().then(() => { process.exitCode = 0; }); });
process.once("SIGINT", () => { void stop().then(() => { process.exitCode = 0; }); });
