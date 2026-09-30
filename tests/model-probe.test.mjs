import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PROBE_PROTOCOL_VERSION,
  createProbeBrokerState,
  createProbeClientFactory,
  createProbeProtocolParser,
  runModelCompatibilityProbes,
} from "../lib/model-probe.js";
import { createResolverGenerationManager } from "../lib/resolver-generations.js";

const NOW = 1_800_000_000_000;
const ROLE = "openai:gpt-sol";
const TRANSITION_ID = "transition-openai-sol-gpt6";
const REVISION = "revision-2";
const MANIFEST_HASH = "a".repeat(64);
const EFFECTIVE_HASH = "b".repeat(64);
const CANDIDATE_IDENTITY = Object.freeze({ providerID: "openai", modelID: "gpt-6-sol" });
const CANDIDATE_INTRODUCTION = Object.freeze({ generation: 4, manifestHash: MANIFEST_HASH });
const GENERATION_ACK = Object.freeze({
  generation: 4,
  manifestHash: MANIFEST_HASH,
  effectiveHash: EFFECTIVE_HASH,
});
const ROLE_POLICY = Object.freeze({
  effortCeiling: "high",
  requiredReasoningMode: "medium",
});
const MODEL_KEYS = Object.freeze(["openai/gpt-5.6-sol", "openai/gpt-6-sol"]);

const stagedPolicy = () => ({
  version: 1,
  roles: {
    [ROLE]: {
      roleKey: ROLE,
      providerID: "openai",
      transitionID: TRANSITION_ID,
      revision: REVISION,
      activeModelID: "gpt-5.6-sol",
      probationModelID: "gpt-6-sol",
      introduction: { ...CANDIDATE_INTRODUCTION },
      probation: { phase: "staged-probing" },
      history: [{
        transitionID: TRANSITION_ID,
        revision: REVISION,
        roleKey: ROLE,
        generation: 4,
        manifestHash: MANIFEST_HASH,
      }],
    },
  },
  history: [{
    transitionID: TRANSITION_ID,
    revision: REVISION,
    roleKey: ROLE,
    generation: 4,
    manifestHash: MANIFEST_HASH,
  }],
});

const launchRequest = (overrides = {}) => ({
  transitionID: TRANSITION_ID,
  operationID: `${TRANSITION_ID}:staged-probing`,
  expectedPolicyRevision: REVISION,
  roleKey: ROLE,
  candidateIdentity: { ...CANDIDATE_IDENTITY },
  candidateIntroduction: { ...CANDIDATE_INTRODUCTION },
  ...overrides,
});

const probeRequest = (overrides = {}) => ({
  transitionID: TRANSITION_ID,
  roleKey: ROLE,
  candidateIdentity: { ...CANDIDATE_IDENTITY },
  candidateIntroduction: { ...CANDIDATE_INTRODUCTION },
  probeKind: "normal",
  requestID: "probe_request_1",
  ...overrides,
});

const semanticResponseFor = (kind) => kind === "tool"
  ? {
      status: 200,
      body: { choices: [{ message: { tool_calls: [{ function: { name: "probe_echo", arguments: "{\"ok\":true}" } }] } }] },
    }
  : { status: 200, body: { choices: [{ message: { content: "PROBE_OK" } }] } };

test("runner executes canonical or missing subsets and awaits each result callback", async () => {
  const calls = [];
  let callbackFinished = true;
  const probeClient = { probe: async (request) => {
    assert.equal(callbackFinished, true);
    calls.push(request);
    return semanticResponseFor(request.kind);
  } };
  const persisted = [];
  const results = await runModelCompatibilityProbes({
    probeClient,
    rolePolicy: ROLE_POLICY,
    ordinaryModel: "smart",
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    probeKinds: ["tool", "reasoning"],
    now: () => NOW,
    onResult: async (result) => {
      callbackFinished = false;
      await Promise.resolve();
      persisted.push(result.kind);
      callbackFinished = true;
    },
  });
  assert.deepEqual(calls.map((entry) => entry.kind), ["tool", "reasoning"]);
  assert.deepEqual(persisted, ["tool", "reasoning"]);
  assert.deepEqual(results.map((entry) => entry.kind), ["tool", "reasoning"]);
  for (const call of calls) {
    assert.equal(call.ordinaryModel, "smart");
    assert.deepEqual(call.candidateIntroduction, CANDIDATE_INTRODUCTION);
    assert.match(call.requestID, /^mpr_[a-f0-9]{32}$/);
    assert.equal(JSON.stringify(call).includes("resolverToken"), false);
    assert.equal(JSON.stringify(call).includes("probeLaunchNonce"), false);
  }
  assert.equal(JSON.stringify(results).includes("gatewayHeaders"), false);
});

test("runner defaults to stable normal tool reasoning order", async () => {
  const firstCalls = [];
  const secondCalls = [];
  const run = (calls) => runModelCompatibilityProbes({
    probeClient: { probe: async (request) => {
      calls.push(request);
      return semanticResponseFor(request.kind);
    } },
    rolePolicy: ROLE_POLICY,
    ordinaryModel: "smart",
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    now: () => NOW,
  });
  await run(firstCalls);
  await run(secondCalls);
  assert.deepEqual(firstCalls.map((entry) => entry.kind), ["normal", "tool", "reasoning"]);
  assert.deepEqual(firstCalls.map((entry) => entry.requestID), secondCalls.map((entry) => entry.requestID));
});

test("runner aborts after callback rejection and validates tool semantics", async () => {
  let probes = 0;
  const probeClient = { probe: async () => {
    probes += 1;
    return { status: 200, body: { content: [{ type: "text", text: "no tool call" }] } };
  } };
  const [tool] = await runModelCompatibilityProbes({
    probeClient,
    rolePolicy: ROLE_POLICY,
    ordinaryModel: "smart",
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    probeKinds: ["tool"],
    now: () => NOW,
  });
  assert.equal(tool.success, false);
  assert.equal(tool.failureClass, "invalid-model-tool-call-response");
  await assert.rejects(runModelCompatibilityProbes({
    probeClient,
    rolePolicy: ROLE_POLICY,
    ordinaryModel: "smart",
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    onResult: async () => { throw new Error("persist failed"); },
    now: () => NOW,
  }), /persist failed/);
  assert.equal(probes, 2, "one tool probe plus one aborted normal probe");
});

test("launch redemption is digest-only single-use exact-bound and restart-volatile", () => {
  let at = NOW;
  let randomCounter = 0;
  const state = createProbeBrokerState({
    now: () => at,
    randomBytes: () => Buffer.alloc(32, ++randomCounter),
  });
  const launch = state.issueLaunch(launchRequest(), { modelPolicy: stagedPolicy() });
  assert.match(launch.probeLaunchNonce, /^pln_[A-Za-z0-9_-]{43}$/);
  assert.equal(launch.expiresAt, NOW + 60_000);
  const status = state.status();
  assert.deepEqual(status.launches, { issued: 1, redeemed: 0 });
  assert.deepEqual(status.launchDigests, [
    createHash("sha256").update(launch.probeLaunchNonce).digest("hex"),
  ]);
  assert.equal(JSON.stringify(status).includes(launch.probeLaunchNonce), false);

  assert.throws(() => state.redeemLaunch({
    generation: 3,
    manifestHash: MANIFEST_HASH,
    modelKeys: MODEL_KEYS,
    probeLaunchNonce: launch.probeLaunchNonce,
  }), /generation.*binding/i);
  const registration = state.redeemLaunch({
    generation: 4,
    manifestHash: MANIFEST_HASH,
    modelKeys: MODEL_KEYS,
    probeLaunchNonce: launch.probeLaunchNonce,
  });
  assert.equal(registration.scope, "probeFresh");
  assert.equal(registration.generation, 4);
  assert.equal(registration.manifestHash, MANIFEST_HASH);
  assert.equal(registration.expiresAt, NOW + 5 * 60_000);
  assert.equal(Object.hasOwn(registration, "modelKeys"), false);
  assert.throws(() => state.redeemLaunch({
    generation: 4,
    manifestHash: MANIFEST_HASH,
    modelKeys: MODEL_KEYS,
    probeLaunchNonce: launch.probeLaunchNonce,
  }), /redeemed|single-use/i);
  assert.equal(JSON.stringify(state.status()).includes(registration.resolverToken), false);

  const restarted = createProbeBrokerState({ now: () => at });
  assert.throws(() => restarted.redeemLaunch({
    generation: 4,
    manifestHash: MANIFEST_HASH,
    modelKeys: MODEL_KEYS,
    probeLaunchNonce: launch.probeLaunchNonce,
  }), /invalid.*launch nonce/i);

  const expiring = state.issueLaunch(launchRequest(), { modelPolicy: stagedPolicy() });
  at += 60_000;
  assert.throws(() => state.redeemLaunch({
    generation: 4,
    manifestHash: MANIFEST_HASH,
    modelKeys: MODEL_KEYS,
    probeLaunchNonce: expiring.probeLaunchNonce,
  }), /expired/i);
});

test("redeeming at the launch deadline edge starts a separate bounded probe-process lifetime", () => {
  let at = NOW;
  let randomCounter = 40;
  const state = createProbeBrokerState({
    now: () => at,
    randomBytes: () => Buffer.alloc(32, ++randomCounter),
  });
  const launch = state.issueLaunch(launchRequest(), { modelPolicy: stagedPolicy() });
  at = launch.expiresAt - 1;
  const registration = state.redeemLaunch({
    generation: 4,
    manifestHash: MANIFEST_HASH,
    modelKeys: MODEL_KEYS,
    probeLaunchNonce: launch.probeLaunchNonce,
  });
  assert.equal(registration.expiresAt, at + 5 * 60_000);
});

test("probeFresh tokens create exact assignments while ordinary and prior tokens are rejected", () => {
  let randomCounter = 10;
  const transitions = [];
  const state = createProbeBrokerState({
    now: () => NOW,
    randomBytes: () => Buffer.alloc(32, ++randomCounter),
    onAssignmentState: (value) => transitions.push(value),
  });
  const launch = state.issueLaunch(launchRequest(), { modelPolicy: stagedPolicy() });
  const registration = state.redeemLaunch({
    generation: 4,
    manifestHash: MANIFEST_HASH,
    modelKeys: MODEL_KEYS,
    probeLaunchNonce: launch.probeLaunchNonce,
  });
  for (const resolverToken of ["ordinary-token", "prior-probe-token"]) {
    assert.throws(() => state.issueAssignment({
      resolverToken,
      request: probeRequest(),
      modelPolicy: stagedPolicy(),
    }), (error) => error?.code === "probe-process-required");
  }
  const assignment = state.issueAssignment({
    resolverToken: registration.resolverToken,
    request: probeRequest(),
    modelPolicy: stagedPolicy(),
  });
  assert.match(assignment.sessionID, /^gw-probe-[A-Za-z0-9_-]{43}$/);
  assert.match(assignment.probeNonce, /^pbn_[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(state.status()).includes(assignment.probeNonce), false);
  const consumed = state.consumeAssignment({
    sessionID: assignment.sessionID,
    probeNonce: assignment.probeNonce,
  });
  assert.deepEqual(consumed.preferredModel, CANDIDATE_IDENTITY);
  assert.deepEqual(state.assignmentForLease(assignment.sessionID), {
    sessionID: assignment.sessionID,
    preferredModel: CANDIDATE_IDENTITY,
    modelKeys: MODEL_KEYS,
    generation: 4,
    manifestHash: MANIFEST_HASH,
  });
  assert.deepEqual(state.releaseAssignment({
    sessionID: assignment.sessionID,
    probeNonce: assignment.probeNonce,
    owner: "gateway",
  }), { changed: true, state: "released" });
  assert.deepEqual(state.releaseAssignment({
    sessionID: assignment.sessionID,
    probeNonce: assignment.probeNonce,
    owner: "gateway",
  }), { changed: false, state: "released" });
  assert.deepEqual(transitions.map((entry) => entry.state), [
    "issued", "consumed-gateway-owned", "released",
  ]);
});

test("a newly redeemed helper revokes the prior process token for the same staged operation", () => {
  let randomCounter = 70;
  const state = createProbeBrokerState({
    now: () => NOW,
    randomBytes: () => Buffer.alloc(32, ++randomCounter),
  });
  const register = () => {
    const launch = state.issueLaunch(launchRequest(), { modelPolicy: stagedPolicy() });
    return state.redeemLaunch({
      generation: 4,
      manifestHash: MANIFEST_HASH,
      modelKeys: MODEL_KEYS,
      probeLaunchNonce: launch.probeLaunchNonce,
    });
  };
  const prior = register();
  const current = register();
  assert.throws(() => state.issueAssignment({
    resolverToken: prior.resolverToken,
    request: probeRequest(),
    modelPolicy: stagedPolicy(),
  }), (error) => error?.code === "probe-process-required");
  const assignment = state.issueAssignment({
    resolverToken: current.resolverToken,
    request: probeRequest(),
    modelPolicy: stagedPolicy(),
  });
  assert.match(assignment.sessionID, /^gw-probe-/);
});

test("assignment hard expiry reaps ownership and helper cancellation cannot release gateway-owned work", () => {
  let at = NOW;
  let randomCounter = 90;
  const transitions = [];
  const state = createProbeBrokerState({
    now: () => at,
    randomBytes: () => Buffer.alloc(32, ++randomCounter),
    onAssignmentState: (entry) => transitions.push(entry.state),
  });
  const launch = state.issueLaunch(launchRequest(), { modelPolicy: stagedPolicy() });
  const registration = state.redeemLaunch({
    generation: 4,
    manifestHash: MANIFEST_HASH,
    modelKeys: MODEL_KEYS,
    probeLaunchNonce: launch.probeLaunchNonce,
  });
  const issued = state.issueAssignment({
    resolverToken: registration.resolverToken,
    request: probeRequest(),
    modelPolicy: stagedPolicy(),
  });
  assert.deepEqual(state.releaseAssignment({
    sessionID: issued.sessionID,
    probeNonce: issued.probeNonce,
    resolverToken: registration.resolverToken,
    owner: "helper",
  }), { changed: true, state: "released" });

  const consumed = state.issueAssignment({
    resolverToken: registration.resolverToken,
    request: probeRequest({ requestID: "probe_request_2" }),
    modelPolicy: stagedPolicy(),
  });
  state.consumeAssignment(consumed);
  assert.deepEqual(state.releaseAssignment({
    sessionID: consumed.sessionID,
    probeNonce: consumed.probeNonce,
    resolverToken: registration.resolverToken,
    owner: "helper",
  }), { changed: false, state: "consumed-gateway-owned" });
  at += 60_000;
  state.reap();
  assert.equal(state.assignmentForLease(consumed.sessionID), null);
  assert.deepEqual(state.status().assignments, {
    issued: 0,
    "consumed-gateway-owned": 0,
    released: 0,
  });
  assert.deepEqual(transitions, [
    "issued", "released", "issued", "consumed-gateway-owned", "released",
  ]);
});

test("protocol parser handles fragmentation and rejects malformed unknown and oversized frames", () => {
  const frames = [];
  const parser = createProbeProtocolParser({ onFrame: (frame) => frames.push(frame) });
  parser.push(Buffer.from('{"version":1,"type":"ready"}\n{"version":1,'));
  parser.push(Buffer.from('"type":"result","requestID":"r1"}\n'));
  parser.end();
  assert.deepEqual(frames.map((frame) => frame.type), ["ready", "result"]);

  for (const bytes of [
    Buffer.from("{broken}\n"),
    Buffer.from('{"version":2,"type":"ready"}\n'),
    Buffer.from('{"version":1,"type":"unknown"}\n'),
    Buffer.concat([Buffer.from('{"version":1,"type":"ready","padding":"'), Buffer.alloc(65_537, 97)]),
  ]) {
    const candidate = createProbeProtocolParser({ onFrame: () => {} });
    assert.throws(() => candidate.push(bytes), /protocol|json|version|type|64 KiB|frame/i);
  }
});

test("factory validates the canonical generation acknowledgement and exact candidate before spawn", async () => {
  let spawns = 0;
  const bundle = {
    generation: 4,
    directory: "/private/generations/generation-4",
    manifest: { generation: 4, modelKeys: MODEL_KEYS },
    manifestHash: MANIFEST_HASH,
    effectiveHash: EFFECTIVE_HASH,
  };
  const generationManager = {
    generation: (generation) => {
      assert.equal(generation, 4);
      return structuredClone(bundle);
    },
    paths: () => ({ root: "/private/generations" }),
  };
  const factory = createProbeClientFactory({
    spawnProbeProcess: () => { spawns += 1; throw new Error("must not spawn"); },
    generationManager,
    brokerSocketPath: "/private/broker.sock",
    gatewayURL: "http://127.0.0.1:8790/v1/chat/completions",
    gatewayHeaders: { Authorization: "Bearer sentinel-gateway-secret" },
    now: () => NOW,
  });
  const open = (overrides = {}) => factory.open({
    transitionID: TRANSITION_ID,
    roleKey: ROLE,
    candidateIdentity: CANDIDATE_IDENTITY,
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    generationAck: GENERATION_ACK,
    ordinaryModel: "smart",
    probeLaunchNonce: `pln_${"x".repeat(43)}`,
    ...overrides,
  });
  await assert.rejects(open({ generationAck: { ...GENERATION_ACK, manifestHash: "c".repeat(64) } }), /manifest.*ack.*mismatch/i);
  await assert.rejects(open({ generationAck: { ...GENERATION_ACK, effectiveHash: "c".repeat(64) } }), /effective.*ack.*mismatch/i);
  await assert.rejects(open({ candidateIdentity: { providerID: "openai", modelID: "gpt-7-sol" } }), /candidate.*manifest/i);
  assert.equal(spawns, 0);
});

test("factory spawn failure rejects and reaps without waiting forever for an exit event", async () => {
  const bundle = {
    generation: 4,
    directory: "/private/generations/generation-4",
    manifest: { generation: 4, modelKeys: MODEL_KEYS },
    manifestHash: MANIFEST_HASH,
    effectiveHash: EFFECTIVE_HASH,
  };
  const factory = createProbeClientFactory({
    spawnProbeProcess: ({ options }) => spawn("/definitely/missing/opencode-probe-helper", [], options),
    generationManager: {
      generation: () => structuredClone(bundle),
      paths: () => ({ root: "/private/generations" }),
    },
    brokerSocketPath: "/private/broker.sock",
    gatewayURL: "http://127.0.0.1:8790/v1/chat/completions",
    gatewayHeaders: { Authorization: "Bearer sentinel-gateway-secret" },
    now: () => NOW,
  });
  const opening = factory.open({
    transitionID: TRANSITION_ID,
    roleKey: ROLE,
    candidateIdentity: CANDIDATE_IDENTITY,
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    generationAck: GENERATION_ACK,
    ordinaryModel: "smart",
    probeLaunchNonce: `pln_${"x".repeat(43)}`,
  });
  await assert.rejects(Promise.race([
    opening,
    new Promise((_, reject) => setTimeout(() => reject(new Error("spawn failure hung")), 500)),
  ]), (error) => {
    assert.doesNotMatch(error.message, /hung/);
    return true;
  });
});

test("factory readiness timeout escalates from SIGTERM to SIGKILL and reaps the child", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); };
  const bundle = {
    generation: 4,
    directory: "/private/generations/generation-4",
    manifest: { generation: 4, modelKeys: MODEL_KEYS },
    manifestHash: MANIFEST_HASH,
    effectiveHash: EFFECTIVE_HASH,
  };
  const factory = createProbeClientFactory({
    spawnProbeProcess: () => child,
    generationManager: {
      generation: () => structuredClone(bundle),
      paths: () => ({ root: "/private/generations" }),
    },
    brokerSocketPath: "/private/broker.sock",
    gatewayURL: "http://127.0.0.1:8790/v1/chat/completions",
    gatewayHeaders: { Authorization: "Bearer sentinel-gateway-secret" },
    now: () => NOW,
  });
  const opening = factory.open({
    transitionID: TRANSITION_ID,
    roleKey: ROLE,
    candidateIdentity: CANDIDATE_IDENTITY,
    candidateIntroduction: CANDIDATE_INTRODUCTION,
    generationAck: GENERATION_ACK,
    ordinaryModel: "smart",
    probeLaunchNonce: `pln_${"x".repeat(43)}`,
  });

  context.mock.timers.tick(10_000);
  await Promise.resolve();
  await Promise.resolve();
  context.mock.timers.tick(2_000);
  await Promise.resolve();
  child.emit("exit", null, "SIGKILL");

  await assert.rejects(opening, /readiness handshake timed out/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

const listen = (server, ...args) => new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(...args, resolveListen);
});

const closeServer = (server) => new Promise((resolveClose) => server.close(resolveClose));

const readRequestBody = async (request) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
};

const realProbeGeneration = async (root) => {
  const generationsRoot = join(root, "generations");
  const currentLinkPath = join(generationsRoot, "current");
  const baseRoot = join(root, "base");
  mkdirSync(baseRoot, { recursive: true, mode: 0o700 });
  const baseConfigPath = join(baseRoot, "opencode.json");
  writeFileSync(baseConfigPath, JSON.stringify({
    provider: { openai: { models: { "gpt-5.6-sol": { id: "gpt-5.6-sol" } } } },
  }) + "\n", { mode: 0o600 });
  const manager = createResolverGenerationManager({
    root: generationsRoot,
    currentLinkPath,
    runResolver: async ({ configPath }) => readFileSync(configPath, "utf8").includes("gpt-6-sol")
      ? "openai/gpt-5.6-sol\nopenai/gpt-6-sol\n"
      : "openai/gpt-5.6-sol\n",
    now: () => NOW,
    pid: 701,
  });
  const generation0 = await manager.build({
    reservedGeneration: 0,
    bootstrapGeneration0: true,
    baseConfigPath,
    overlay: { version: 1, revision: 0, updatedAt: NOW, entries: {} },
    authorizingRevisions: [],
    protectedReferences: [],
    authorizedRetirements: [],
  });
  await manager.publish(generation0);
  const generation = await manager.build({
    reservedGeneration: 1,
    baseConfigPath,
    overlay: {
      version: 1,
      revision: 1,
      updatedAt: NOW + 1,
      entries: {
        "openai/gpt-6-sol": {
          transitionID: TRANSITION_ID,
          revision: REVISION,
          authorizationKind: "auto-eligible",
          providerID: "openai",
          modelID: "gpt-6-sol",
          roleKey: ROLE,
          authorizationHash: "c".repeat(64),
          introductionGeneration: 1,
          model: {
            id: "gpt-6-sol",
            name: "GPT-6 Sol",
            family: "gpt-sol",
            release_date: "2026-09-22",
            tool_call: true,
            limit: { context: 400_000, output: 96_000 },
            variants: { medium: {}, high: {} },
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
        },
      },
    },
    authorizingRevisions: [REVISION],
    protectedReferences: [],
    authorizedRetirements: [],
  });
  await manager.publish(generation);
  return { manager, generation };
};

test("real fresh child owns registration broker probe and ordinary gateway request", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-probe-real-"));
  const brokerSocketPath = join(root, "broker.sock");
  const brokerCalls = [];
  const gatewayCalls = [];
  const sentinel = {
    gatewayAuthorization: "Bearer sentinel-gateway-secret",
    resolverToken: "sentinel-resolver-token",
    launchNonce: `pln_${"l".repeat(43)}`,
    probeNonce: `pbn_${"p".repeat(43)}`,
  };
  let child = null;
  let childStdout = "";
  let childStderr = "";
  const childTrace = [];
  let results = [];
  const broker = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    brokerCalls.push({ path: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/resolver-process/register") {
      assert.equal(body.probeLaunchNonce, sentinel.launchNonce);
      response.end(JSON.stringify({
        resolverToken: sentinel.resolverToken,
        scope: "probeFresh",
        generation: body.generation,
        manifestHash: body.manifestHash,
        expiresAt: NOW + 60_000,
      }));
      return;
    }
    if (request.url === "/model-policy/probe") {
      assert.equal(request.headers["x-opencode-resolver-token"], sentinel.resolverToken);
      response.end(JSON.stringify({
        sessionID: `gw-probe-${"s".repeat(43)}`,
        probeNonce: sentinel.probeNonce,
        expiresAt: NOW + 60_000,
      }));
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  const gateway = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    gatewayCalls.push({
      body,
      authorization: request.headers.authorization,
      sessionID: request.headers["x-opencode-probe-session"],
      nonce: request.headers["x-opencode-probe-nonce"],
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body.tools ? {
      choices: [{ message: { tool_calls: [{ function: { name: "probe_echo", arguments: "{\"ok\":true}" } }] } }],
    } : { choices: [{ message: { content: "PROBE_OK" } }] }));
  });
  try {
    const { manager, generation } = await realProbeGeneration(root);
    await listen(broker, brokerSocketPath);
    chmodSync(brokerSocketPath, 0o600);
    await listen(gateway, 0, "127.0.0.1");
    const spawnRequests = [];
    const factory = createProbeClientFactory({
      spawnProbeProcess: (request) => {
        spawnRequests.push(request);
        child = spawn(request.command, request.args, request.options);
        child.stdout.on("data", (chunk) => { childStdout += String(chunk); });
        child.stderr.on("data", (chunk) => { childStderr += String(chunk); });
        return child;
      },
      generationManager: manager,
      brokerSocketPath,
      gatewayURL: `http://127.0.0.1:${gateway.address().port}/v1/chat/completions`,
      gatewayHeaders: { Authorization: sentinel.gatewayAuthorization },
      onTrace: (event) => childTrace.push(event),
      now: () => NOW,
    });
    const client = await factory.open({
      transitionID: TRANSITION_ID,
      roleKey: ROLE,
      candidateIdentity: CANDIDATE_IDENTITY,
      candidateIntroduction: { generation: generation.generation, manifestHash: generation.manifestHash },
      generationAck: {
        generation: generation.generation,
        manifestHash: generation.manifestHash,
        effectiveHash: generation.effectiveHash,
      },
      ordinaryModel: "smart",
      probeLaunchNonce: sentinel.launchNonce,
    });
    try {
      results = await runModelCompatibilityProbes({
        probeClient: client,
        rolePolicy: ROLE_POLICY,
        ordinaryModel: "smart",
        candidateIntroduction: { generation: generation.generation, manifestHash: generation.manifestHash },
        now: () => NOW,
      });
      assert.equal(results.every((result) => result.success), true);
    } finally {
      await Promise.all([client.close(), client.close()]);
    }
    assert.equal(child.exitCode, 0);
    assert.equal(brokerCalls[0].path, "/resolver-process/register");
    assert.equal(brokerCalls.slice(1).every((call) => call.path === "/model-policy/probe"), true);
    assert.equal(gatewayCalls.length, 3);
    assert.equal(gatewayCalls.every((call) => call.authorization === sentinel.gatewayAuthorization), true);
    assert.equal(gatewayCalls.every((call) => call.body.model === "smart"), true);
    assert.equal(gatewayCalls.every((call) => call.nonce === sentinel.probeNonce), true);
    assert.equal(childTrace.every((event) => event.pid === child.pid), true);
    assert.equal(childTrace[0].generation, generation.generation);
    assert.equal(childTrace.slice(1).every((event) => event.generation === null), true);
    assert.deepEqual(childTrace.map(({ event, requestID, path, socketPath }) => ({
      event,
      requestID,
      path,
      socketPath,
    })), [
      {
        event: "broker-registration",
        requestID: "bootstrap",
        path: "/resolver-process/register",
        socketPath: brokerSocketPath,
      },
      ...results.flatMap(({ requestID }) => [
        {
          event: "broker-probe",
          requestID,
          path: "/model-policy/probe",
          socketPath: brokerSocketPath,
        },
        {
          event: "gateway-request",
          requestID,
          path: "/v1/chat/completions",
          socketPath: null,
        },
        {
          event: "gateway-release-complete",
          requestID,
          path: "/probe/release",
          socketPath: null,
        },
      ]),
    ]);
    assert.equal(childTrace.filter((event) => event.event === "broker-probe")
      .every((event) => typeof event.assignmentHash === "string" && event.assignmentHash.length === 64), true);
    assert.equal(childTrace.filter((event) => event.requestID !== "bootstrap")
      .every((event) => event.assignmentHash === childTrace.find((candidate) =>
        candidate.requestID === event.requestID)?.assignmentHash), true);
    assert.equal(JSON.stringify(spawnRequests).includes(sentinel.gatewayAuthorization), false);
    assert.equal(JSON.stringify(spawnRequests).includes(sentinel.launchNonce), false);
    assert.equal(JSON.stringify(spawnRequests).includes(CANDIDATE_IDENTITY.modelID), false);
    for (const secret of Object.values(sentinel).concat(CANDIDATE_IDENTITY.modelID)) {
      assert.equal(childStdout.includes(secret), false);
      assert.equal(childStderr.includes(secret), false);
      assert.equal(JSON.stringify(childTrace).includes(secret), false);
    }
    for (const line of childStdout.trim().split("\n")) {
      const frame = JSON.parse(line);
      assert.equal(frame.version, PROBE_PROTOCOL_VERSION);
      assert.equal(typeof frame.type, "string");
    }
  } finally {
    await Promise.allSettled([closeServer(broker), closeServer(gateway)]);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("child independently rejects a post-parent manifest mutation before registration or network", async () => {
  const root = mkdtempSync(join(tmpdir(), "model-probe-race-"));
  const brokerSocketPath = join(root, "broker.sock");
  let brokerCalls = 0;
  let child = null;
  const broker = createServer(async (request, response) => {
    brokerCalls += 1;
    await readRequestBody(request);
    response.end(JSON.stringify({ error: "must not register" }));
  });
  try {
    const { manager, generation } = await realProbeGeneration(root);
    await listen(broker, brokerSocketPath);
    chmodSync(brokerSocketPath, 0o600);
    const factory = createProbeClientFactory({
      spawnProbeProcess: (request) => {
        writeFileSync(join(generation.directory, "manifest.json"), "{}\n", { mode: 0o600 });
        child = spawn(request.command, request.args, request.options);
        return child;
      },
      generationManager: manager,
      brokerSocketPath,
      gatewayURL: "http://127.0.0.1:8790/v1/chat/completions",
      gatewayHeaders: { Authorization: "Bearer sentinel-gateway-secret" },
      now: () => NOW,
    });
    await assert.rejects(factory.open({
      transitionID: TRANSITION_ID,
      roleKey: ROLE,
      candidateIdentity: CANDIDATE_IDENTITY,
      candidateIntroduction: { generation: generation.generation, manifestHash: generation.manifestHash },
      generationAck: {
        generation: generation.generation,
        manifestHash: generation.manifestHash,
        effectiveHash: generation.effectiveHash,
      },
      ordinaryModel: "smart",
      probeLaunchNonce: `pln_${"l".repeat(43)}`,
    }), /helper|protocol|completion|exited/i);
    assert.equal(brokerCalls, 0);
  } finally {
    await closeServer(broker);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("protocol version is pinned to one", () => {
  assert.equal(PROBE_PROTOCOL_VERSION, 1);
});
