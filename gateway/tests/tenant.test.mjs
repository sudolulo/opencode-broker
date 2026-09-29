// The tenant control surface: POST /tenant/:id/acquire, POST /tenant/:id/release,
// GET /tenant/:id.
//
// Why these routes exist at all: a container (ComfyUI on truenas) needs a whole GPU card for
// the duration of a render, and cannot run `model-swap` itself -- no midclt, no router, no
// state dir. The gateway already spawns `model-swap` as a prepareCommand and already runs on
// the host that owns its reservation state, so it is the one process that can do this on the
// container's behalf.
//
// Every test here drives a real http server, exactly like gateway.test.mjs, and injects a
// fake `runModelSwap` so no test can reach a real card. On 2026-09-07 a test run in the
// llamacpp repo fired a real swap and pulled a model out from under a live session; nothing
// in this file may spawn a child process.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createGatewayHandler, loadGatewayConfig } from "../lib/gateway.js";

const GATEWAY_SECRET = "gw-value-used-only-by-this-test";
const TENANT_SECRET = "tenant-value-used-only-by-this-test";

const CONFIG = {
  tier: "worker",
  profile: "auto",
  providers: { llamacpp: { baseUrl: "http://local.example/v1" } },
  // The tenant id, the address it may call from and the command that serves it are all
  // deployment data, so they live in config -- gateway.js names no tenant of its own.
  tenants: { comfyui: { allowFrom: ["127.0.0.1"], command: ["/does/not/exist/model-swap"] } },
};

const withServer = async (handler, fn) => {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); }
};

// A reservations file in a temp dir: the real one lives under
// $XDG_STATE_HOME/llamacpp-model-swap/ and belongs to the live host.
// ☆ ONE exit listener for ALL temp dirs, not one per file: node warns at 11 listeners on a
// single emitter, and a per-call listener made the suite print a MaxListenersExceededWarning
// once the file passed ten tests. The warning is noise that hides a real one.
const tempDirs = [];
process.on("exit", () => {
  for (const dir of tempDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});
// EVERY temp dir in this file comes from here, so the listener above stays the only one.
// A test that mkdtemps and registers its own cleanup is what the count above exists to prevent.
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
const reservationsFile = (contents) => {
  const path = join(tempDir("gw-tenant-"), "reservations.json");
  if (contents !== undefined) writeFileSync(path, JSON.stringify(contents));
  return path;
};

// `calls` records every model-swap invocation so a test can assert the NEGATIVE -- that a
// refused request spawned nothing.
const tenantHandler = ({ reservations, onRun } = {}) => {
  const calls = [];
  const reservationsPath = reservationsFile(reservations);
  const handler = createGatewayHandler({
    config: CONFIG,
    brokerRequest: async () => { throw new Error("no test on the tenant surface may lease a model"); },
    gatewayKey: GATEWAY_SECRET,
    tenantToken: TENANT_SECRET,
    reservationsPath,
    runModelSwap: async (command, args) => {
      calls.push({ command, args });
      await onRun?.({ reservationsPath, args });
      return { code: 0 };
    },
  });
  return { handler, calls, reservationsPath };
};

const ask = (base, path, { method = "POST", token } = {}) => fetch(`${base}${path}`, {
  method,
  headers: token ? { Authorization: `Bearer ${token}` } : {},
}).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

test("an unauthenticated acquire is 401 and spawns nothing", async () => {
  const { handler, calls } = tenantHandler();
  await withServer(handler, async (base) => {
    const result = await ask(base, "/tenant/comfyui/acquire");
    assert.equal(result.status, 401);
    assert.equal(result.body?.error, "unauthorized");
  });
  // The point of the assertion: a caller with no credential must not be able to make the
  // household's vision model disappear off card 1.
  assert.deepEqual(calls, [], "an unauthorized request must not run model-swap");
});

test("a wrong token is 401 and spawns nothing", async () => {
  const { handler, calls } = tenantHandler();
  await withServer(handler, async (base) => {
    assert.equal((await ask(base, "/tenant/comfyui/acquire", { token: "wrong" })).status, 401);
  });
  assert.deepEqual(calls, []);
});

test("the gateway key does not buy the tenant surface, and the tenant token does not buy inference", async () => {
  // Least privilege, and the reason the tenant branch is dispatched BEFORE the gateway-key
  // gate: the container runs third-party custom nodes and must hold a credential that can
  // reserve a card and nothing else. The paid-quota key is a different secret with a
  // different blast radius, and neither may stand in for the other.
  const { handler, calls } = tenantHandler();
  await withServer(handler, async (base) => {
    assert.equal((await ask(base, "/tenant/comfyui/acquire", { token: GATEWAY_SECRET })).status, 401,
      "the gateway key must not authorize a card eviction");
    assert.equal((await ask(base, "/v1/models", { method: "GET", token: TENANT_SECRET })).status, 401,
      "the tenant token must not authorize inference");
  });
  assert.deepEqual(calls, []);
});

test("an unknown tenant id is 404 even with a valid token", async () => {
  const { handler, calls } = tenantHandler();
  await withServer(handler, async (base) => {
    const result = await ask(base, "/tenant/ghost/acquire", { token: TENANT_SECRET });
    assert.equal(result.status, 404);
    assert.equal(result.body?.error, "unknown tenant");
  });
  assert.deepEqual(calls, [], "an unknown tenant must not reach model-swap");
});

test("acquire runs reserve --no-start --wait-active and reports the reservation it can see", async () => {
  const { handler, calls } = tenantHandler({
    reservations: {},
    // model-swap's real effect, faked: the reservation appears on disk.
    onRun: ({ reservationsPath }) => writeFileSync(reservationsPath, JSON.stringify({ comfyui: { card: 1, mib: 24576 } })),
  });
  await withServer(handler, async (base) => {
    const result = await ask(base, "/tenant/comfyui/acquire", { token: TENANT_SECRET });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { held: true });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/does/not/exist/model-swap");
  // --no-start because ComfyUI's lifecycle is not model-swap's business any more: it runs
  // permanently under `restart: unless-stopped`. --wait-active bounds how long the reserve
  // waits for an in-use model to go quiet before overriding the activity guard.
  assert.deepEqual(calls[0].args, ["reserve", "comfyui", "--no-start", "--wait-active", "60"]);
});

test("a model-swap that exits 0 while REFUSING reports held:false", async () => {
  // THE EXIT CODE IS NOT THE POSTCONDITION. `model-swap` prints a refusal and exits 0 by
  // design (a correct decline must not toast the HUD), so a route that returned success on
  // exit 0 would tell ComfyUI it owns a card it does not own, and the render would spill
  // card 1 into CPU at 0.88 tok/s. The reservation file is the only truth.
  const { handler, calls } = tenantHandler({ reservations: {} });
  await withServer(handler, async (base) => {
    const result = await ask(base, "/tenant/comfyui/acquire", { token: TENANT_SECRET });
    assert.equal(result.status, 200, "a refusal is a verdict, not a transport error");
    assert.deepEqual(result.body, { held: false });
  });
  assert.equal(calls.length, 1, "the refusal still came from a real attempt");
});

test("release runs release --no-stop and leaves the tenant running, logging nothing", async (t) => {
  // ☠️ `held` is not a success flag, it is a reading of the reservation file, and the two
  // actions want OPPOSITE readings: acquire succeeded when the reservation appeared, release
  // succeeded when it is GONE. A guard written `if (!held) console.error(...)` therefore fires
  // on every clean release and never on a stuck one -- exactly inverted. The spy is what makes
  // that visible: without it this test passes while the log lies on the happy path, and an
  // operator chasing "tenant comfyui release: held=false" is chasing the case that worked.
  const errors = t.mock.method(console, "error");
  const { handler, calls } = tenantHandler({
    reservations: { comfyui: { card: 1, mib: 24576 } },
    onRun: ({ reservationsPath }) => writeFileSync(reservationsPath, JSON.stringify({})),
  });
  await withServer(handler, async (base) => {
    const result = await ask(base, "/tenant/comfyui/release", { token: TENANT_SECRET });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { held: false });
  });
  assert.deepEqual(calls[0].args, ["release", "comfyui", "--no-stop"]);
  assert.deepEqual(errors.mock.calls.map((call) => call.arguments), [],
    "a release that gave the card back is the happy path and must not log an error");
});

test("a release that did NOT give the card back is logged", async (t) => {
  // The negative control for the test above: the cure for "logs on success" must not be
  // "delete the log". A release whose reservation is still on file afterwards means the 27b
  // never comes home to card 1 and nothing else will notice -- that one must reach the log.
  const errors = t.mock.method(console, "error");
  // No onRun: model-swap exits 0 but the reservation survives.
  const { handler } = tenantHandler({ reservations: { comfyui: { card: 1, mib: 24576 } } });
  await withServer(handler, async (base) => {
    const result = await ask(base, "/tenant/comfyui/release", { token: TENANT_SECRET });
    assert.equal(result.status, 200, "still a verdict, not a transport error");
    assert.deepEqual(result.body, { held: true }, "the caller is told the truth: it still holds the card");
  });
  assert.equal(errors.mock.calls.length, 1, "a stuck release must be logged exactly once");
  assert.match(String(errors.mock.calls[0].arguments[0]), /tenant comfyui release/);
});

test("GET /tenant/:id reports what is held without running anything", async () => {
  const { handler, calls } = tenantHandler({ reservations: { comfyui: { card: 1, mib: 24576 } } });
  await withServer(handler, async (base) => {
    const result = await ask(base, "/tenant/comfyui", { method: "GET", token: TENANT_SECRET });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { held: true });
  });
  assert.deepEqual(calls, [], "a status read must never mutate the resident set");
});

test("a missing reservations file reads as nothing held, not as an error", async () => {
  // A host that has never reserved anything has no file at all. That is "free", not 500.
  const { handler } = tenantHandler({ reservations: undefined });
  await withServer(handler, async (base) => {
    const result = await ask(base, "/tenant/comfyui", { method: "GET", token: TENANT_SECRET });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { held: false });
  });
});

test("an entry without a card and a mib is not a reservation, exactly as model-swap reads it", async () => {
  // model-swap's read_reservations() keeps only entries that are dicts carrying BOTH "card"
  // and "mib" (tools/model-swap:263-274). If the gateway counted a half-written or
  // hand-edited entry as held, the two would disagree about who owns card 1 -- and the
  // disagreement resolves as a spilled card, never as a wasted eviction.
  const { handler } = tenantHandler({ reservations: { comfyui: { mib: 24576 } } });
  await withServer(handler, async (base) => {
    const result = await ask(base, "/tenant/comfyui", { method: "GET", token: TENANT_SECRET });
    assert.deepEqual(result.body, { held: false });
  });
});

test("an unknown method or action on the tenant surface is 405, never a model request", async () => {
  const { handler, calls } = tenantHandler();
  await withServer(handler, async (base) => {
    assert.equal((await ask(base, "/tenant/comfyui/acquire", { method: "PUT", token: TENANT_SECRET })).status, 405);
    assert.equal((await ask(base, "/tenant/comfyui", { token: TENANT_SECRET })).status, 405,
      "POST to the status route is not an acquire");
  });
  assert.deepEqual(calls, []);
});

test("a caller from an address the tenant does not allow is 401", async () => {
  const calls = [];
  const handler = createGatewayHandler({
    config: { ...CONFIG, tenants: { comfyui: { allowFrom: ["10.9.9.9"], command: ["/does/not/exist/model-swap"] } } },
    brokerRequest: async () => { throw new Error("unreachable"); },
    gatewayKey: GATEWAY_SECRET,
    tenantToken: TENANT_SECRET,
    reservationsPath: reservationsFile({}),
    runModelSwap: async (command, args) => { calls.push({ command, args }); return { code: 0 }; },
  });
  await withServer(handler, async (base) => {
    assert.equal((await ask(base, "/tenant/comfyui/acquire", { token: TENANT_SECRET })).status, 401,
      "a stolen token from the wrong host is still refused");
  });
  assert.deepEqual(calls, []);
});

test("with no token configured the tenant surface is closed, not open, and says so once at startup", async (t) => {
  // A gateway deployed before the drop file exists must refuse, never default to allowing.
  // ☆ And it must SAY so, once, when it starts: a `tenants` block with no token is a deploy
  // that half-happened, and its only other symptom is every render 401ing with NOTHING in
  // this log -- the address log fires after the token check, so it never sees these. The
  // deploy this guards against ran live for ten days once (env var and device_ids disagreeing,
  // 2026-09) because nothing said anything.
  const errors = t.mock.method(console, "error");
  const calls = [];
  const handler = createGatewayHandler({
    config: CONFIG,
    brokerRequest: async () => { throw new Error("unreachable"); },
    gatewayKey: GATEWAY_SECRET,
    reservationsPath: reservationsFile({}),
    runModelSwap: async (command, args) => { calls.push({ command, args }); return { code: 0 }; },
  });
  assert.equal(errors.mock.calls.length, 1, "a configured tenant with no token is logged exactly once, at construction");
  assert.match(String(errors.mock.calls[0].arguments[0]), /tenants? \[comfyui\]/);
  assert.match(String(errors.mock.calls[0].arguments[0]), /no tenant token/);
  await withServer(handler, async (base) => {
    assert.equal((await ask(base, "/tenant/comfyui/acquire", { token: TENANT_SECRET })).status, 401);
    assert.equal((await ask(base, "/tenant/comfyui/acquire")).status, 401);
  });
  assert.deepEqual(calls, []);
  // Once at startup, not once per request: an unauthenticated prober must not be able to
  // fill the log by hitting a closed surface.
  assert.equal(errors.mock.calls.length, 1, "refused requests on a closed surface add nothing to the log");
});

test("a gateway with no tenants block and no token is the ordinary deployment and logs nothing", (t) => {
  // The negative control: every gateway on the fleet today has neither, and a warning on
  // each of them would be noise that hides the one that matters.
  const errors = t.mock.method(console, "error");
  const { tenants: _unused, ...withoutTenants } = CONFIG;
  createGatewayHandler({
    config: withoutTenants,
    brokerRequest: async () => { throw new Error("unreachable"); },
    gatewayKey: GATEWAY_SECRET,
    reservationsPath: reservationsFile({}),
    runModelSwap: async () => { throw new Error("unreachable"); },
  });
  assert.deepEqual(errors.mock.calls.map((call) => call.arguments), []);
});

test("a url that merely starts with /tenant is not the tenant surface", async () => {
  // /tenants, /tenantfoo and friends must fall through to the ordinary gateway auth and 404,
  // so a typo can never be read as an unauthenticated tenant call.
  const { handler } = tenantHandler();
  await withServer(handler, async (base) => {
    assert.equal((await ask(base, "/tenantfoo", { token: GATEWAY_SECRET })).status, 404);
    assert.equal((await ask(base, "/tenantfoo")).status, 401, "still behind the gateway key");
  });
});

test("the config loader keeps a tenant's address list and command, and rejects a malformed one", () => {
  const path = join(tempDir("gw-tenant-cfg-"), "gateway.json");
  const write = (extra) => writeFileSync(path, JSON.stringify({
    providers: { llamacpp: { baseUrl: "http://x/v1" } }, ...extra,
  }));

  write({});
  assert.deepEqual(loadGatewayConfig(path).tenants, {}, "no tenants is the default, and it is closed");

  write({ tenants: { comfyui: { allowFrom: ["192.168.50.1"], command: ["/tools/model-swap"] } } });
  assert.deepEqual(loadGatewayConfig(path).tenants, {
    comfyui: { allowFrom: ["192.168.50.1"], command: ["/tools/model-swap"] },
  });

  // A tenant with no command could never do anything; loud at load beats a 500 per render.
  write({ tenants: { comfyui: { allowFrom: ["192.168.50.1"] } } });
  assert.throws(() => loadGatewayConfig(path), /tenants\["comfyui"\]/);

  // An empty allowFrom would accept every address on the LAN.
  write({ tenants: { comfyui: { allowFrom: [], command: ["/tools/model-swap"] } } });
  assert.throws(() => loadGatewayConfig(path), /allowFrom/);

  // An id outside [a-z0-9-] cannot be reached by the route regex, so accepting it at load
  // would silently create a tenant nothing can call.
  write({ tenants: { ComfyUI: { allowFrom: ["192.168.50.1"], command: ["/tools/model-swap"] } } });
  assert.throws(() => loadGatewayConfig(path), /ComfyUI/);
});
