import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createGatewayHandler } from "../../gateway/lib/gateway.js";
import { normalizeModelRoles } from "../../lib/model-roles.js";
import { createProbeClientFactory } from "../../lib/model-probe.js";
import { createReconciliationApplier } from "../../lib/reconcile-apply.js";
import { createResolverOverlayStore } from "../../lib/reconcile-overlay.js";
import { createReconciliationStore } from "../../lib/reconcile-state.js";
import { createResolverGenerationManager } from "../../lib/resolver-generations.js";
import { discoverSubscriptionTargets } from "../../lib/routing.js";

export const ROLE = "openai:gpt-sol";
export const TRANSITION_ID = "a1b2c3d4e5f60718293a4b5c";

export const TRUSTED_OPENAI_GPT6 = Object.freeze({
  providerID: "openai",
  authType: "oauth",
  modelID: "gpt-6-sol",
});

export const TRUSTED_ANTHROPIC_55 = Object.freeze({
  providerID: "anthropic",
  authType: "api",
  modelID: "claude-opus-5-5",
});

export const VALID_PROBE_REQUEST = Object.freeze({
  transitionID: TRANSITION_ID,
  roleKey: ROLE,
  candidateIdentity: { providerID: "openai", modelID: "gpt-6-sol" },
  probeKind: "normal",
  requestID: "ordinary-token-must-not-probe",
});

const NOW = 1_800_000_000_000;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BROKER_SCRIPT = join(REPO_ROOT, "bin/opencode-broker");
const RECONCILE_SCRIPT = join(REPO_ROOT, "bin/opencode-broker-reconcile");
const GATEWAY_KEY = "runtime-gateway-fixture-key";
const MODEL_ROLES = normalizeModelRoles();

const CATALOG = Object.freeze({
  openai: {
    models: {
      "gpt-6-sol": {
        id: "gpt-6-sol",
        name: "GPT-6 Sol",
        family: "gpt-sol",
        release_date: "2026-09-22",
        tool_call: true,
        limit: { context: 400_000, output: 96_000 },
        variants: { medium: {}, high: {} },
      },
    },
  },
});

const catalogInventory = (providerID, modelID) => ({
  connected: [providerID],
  all: [{
    id: providerID,
    models: {
      [modelID]: providerID === "anthropic"
        ? {
            id: modelID,
            name: "Claude Opus 5.5",
            family: "claude-opus",
            release_date: "2026-09-20",
            tool_call: true,
            limit: { context: 200_000, output: 64_000 },
            reasoning_options: [{ type: "effort", values: ["medium", "high"] }],
          }
        : {
            ...CATALOG.openai.models[modelID],
            reasoning_options: [{ type: "effort", values: ["medium", "high"] }],
          },
    },
  }],
});

const listen = (server, ...args) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(...args, resolve);
});

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

const unixRequest = (socketPath, path, body = {}, { method = "POST", headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const payload = method === "GET" ? null : Buffer.from(JSON.stringify(body));
    const request = httpRequest({
      socketPath,
      path,
      method,
      headers: payload === null ? headers : {
        ...headers,
        "content-type": "application/json",
        "content-length": payload.length,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = text ? JSON.parse(text) : {};
        resolve({ status: response.statusCode ?? 500, body: parsed });
      });
    });
    request.once("error", reject);
    request.end(payload ?? undefined);
  });

const authRevision = (path) => {
  const bytes = readFileSync(path);
  const stat = statSync(path);
  return `${Math.trunc(stat.mtimeMs)}:${stat.size}:${createHash("sha256").update(bytes).digest("hex")}`;
};

const snapshotPath = (path) => {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return { exists: true, kind: "symlink", target: readlinkSync(path), mtimeMs: stat.mtimeMs };
  }
  if (stat.isDirectory()) {
    return {
      exists: true,
      kind: "directory",
      mode: stat.mode & 0o777,
      entries: Object.fromEntries(readdirSync(path).sort().map((name) => [name, snapshotPath(join(path, name))])),
    };
  }
  return {
    exists: true,
    kind: "file",
    mode: stat.mode & 0o777,
    mtimeMs: stat.mtimeMs,
    bytes: readFileSync(path).toString("base64"),
  };
};

const approvedRecord = () => ({
  transitionID: TRANSITION_ID,
  roleKey: ROLE,
  providerID: "openai",
  roleID: "gpt-sol",
  candidateModelID: "gpt-6-sol",
  candidateFamily: "gpt-sol",
  candidateReleaseDate: "2026-09-22",
  candidateVersion: "6",
  incumbentModelID: "gpt-5.6-sol",
  proposedTiers: ["smart"],
  proposedFit: { smart: 1.4 },
  proposedEffortCeiling: "high",
  requiredReasoningMode: null,
  state: "approved",
  reason: "fixture operator approval",
  stateChangedAt: NOW - 1,
  lastObservedAt: NOW - 1,
  transitions: ["discovered", "awaiting-approval", "approved"],
  evidence: [],
  evidenceRevision: null,
  evidenceCollectedAt: null,
  evidenceContradiction: false,
  approval: { decision: "approved", source: "cli", at: NOW - 1, note: null },
  issue: null,
  notified: null,
});

const writeJSON = (path, value, mode = 0o600) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(path, mode);
};

const startBroker = async ({ home, configPath, actualSocketPath }) => {
  const child = spawn(process.execPath, [BROKER_SCRIPT, "serve"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_BROKER_CONFIG: configPath,
      OPENCODE_MODEL_BROKER_SOCKET: actualSocketPath,
      OPENCODE_BROKER_LOCAL_MODELS_URL: "http://127.0.0.1:9/v1/models",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on ")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(
      `runtime broker exited before listen (${code ?? signal}): ${stderr}`,
    )));
  });
  assertSocketMode(actualSocketPath);
  return { child, stderr: () => stderr };
};

const assertSocketMode = (path) => {
  const stat = lstatSync(path);
  if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`runtime broker socket ${path} is not a mode-0600 Unix socket`);
  }
};

const stopChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
};

const startGateway = async ({ brokerRequest, recordTrace, effects }) => {
  const checkedBrokerRequest = async (path, body) => {
    const result = await brokerRequest(path, body);
    if (result.status < 200 || result.status >= 300) {
      const error = new Error(result.body.error ?? `broker HTTP ${result.status}`);
      error.code = result.body.code;
      throw error;
    }
    return result.body;
  };
  const handler = createGatewayHandler({
    config: {
      tier: "smart",
      profile: "auto",
      routedModelId: "routed",
      strictModelNames: false,
      modelProfiles: { smart: { profile: "auto", tier: "smart" } },
      providers: { openai: { baseUrl: "http://provider.invalid/v1" } },
    },
    gatewayKey: GATEWAY_KEY,
    brokerRequest: checkedBrokerRequest,
    fetchImpl: async (_url, options) => {
      effects.externalCalls += 1;
      const body = JSON.parse(options.body);
      const payload = body.tools
        ? { choices: [{ message: { tool_calls: [{ function: { name: "probe_echo", arguments: "{\"ok\":true}" } }] } }], usage: {} }
        : { choices: [{ message: { content: "PROBE_OK" } }], usage: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const server = createServer((request, response) => {
    if (request.headers["x-opencode-probe-session"]) {
      recordTrace({
        source: "gateway",
        event: "ordinary-gateway",
        childOwned: Boolean(request.headers["x-opencode-probe-pid"]),
      });
    }
    void handler(request, response);
  });
  await listen(server, 0, "127.0.0.1");
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
  };
};

export const createModelReconcileRuntime = async ({
  applyEnabled = false,
  baseModels = ["openai/gpt-5.6-sol"],
  realProbeHelper = false,
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), "model-reconcile-runtime-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  const stateRoot = join(home, ".local/share/opencode/model-routing");
  const configPath = join(home, ".config/opencode-broker/config.json");
  const authPath = join(home, ".local/share/opencode/auth.json");
  const overlayPath = join(stateRoot, "resolver-overlay.json");
  const generationsRoot = join(stateRoot, "generations");
  const currentLinkPath = join(generationsRoot, "current");
  const actualSocketPath = join(stateRoot, "broker.sock");
  const tracePath = join(root, "probe-trace.jsonl");
  const childTraceModulePath = join(root, "child-trace.mjs");
  const baseConfigPath = join(root, "base/opencode.json");
  const effects = {
    resolverRuns: 0,
    externalCalls: 0,
  };
  let probeChildReaped = false;
  let closed = false;
  let broker = null;
  let gateway = null;
  let probeChild = null;
  const pendingFailures = new Map();
  let leaseSequence = 0;

  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  writeFileSync(tracePath, "", { mode: 0o600 });
  writeFileSync(childTraceModulePath, `
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const http = require("node:http");
const originalRequest = http.request;
const tracePath = process.env.OPENCODE_BROKER_TEST_TRACE;

http.request = function tracedRequest(...args) {
  const options = args[0] instanceof URL ? {} : args[0] ?? {};
  const requestPath = options.path;
  let requestBody = "";
  const callbackIndex = args.findIndex((value, index) => index > 0 && typeof value === "function");
  if (callbackIndex !== -1) {
    const callback = args[callbackIndex];
    args[callbackIndex] = function tracedResponse(response) {
      let generation = null;
      if (requestPath === "/resolver-process/register" && requestBody) {
        try {
          generation = JSON.parse(requestBody).generation ?? null;
        } catch (error) {
          generation = { parseError: String(error?.message ?? error) };
        }
      }
      appendFileSync(tracePath, JSON.stringify({
        source: "child",
        kind: "broker-response",
        path: requestPath,
        status: response.statusCode ?? 500,
        socketPath: options.socketPath ?? null,
        generation,
      }) + "\\n");
      return callback(response);
    };
  }
  const request = originalRequest.apply(this, args);
  const originalEnd = request.end;
  request.end = function tracedEnd(chunk, ...rest) {
    if (chunk !== undefined && chunk !== null) requestBody += Buffer.from(chunk).toString("utf8");
    return originalEnd.call(this, chunk, ...rest);
  };
  return request;
};
syncBuiltinESMExports();
`, { mode: 0o600 });
  writeJSON(authPath, {
    openai: { type: "oauth", access: "runtime-openai-fixture-access" },
    anthropic: { type: "api", key: "runtime-anthropic-fixture-key" },
  });
  const config = {
    targets: {
      "gpt-incumbent": {
        providerID: "openai",
        modelID: "gpt-5.6-sol",
        kind: "cloud",
        fit: { smart: 1.4 },
        effort: { smart: "high" },
      },
    },
    tiers: { smart: ["gpt-incumbent"] },
    trustedSubscriptionProviders: ["anthropic"],
    burnWatch: { enabled: false },
    slotWatch: { enabled: false },
    reconcile: {
      apply: applyEnabled ? {
        enabled: true,
        overlayPath,
        generationsRoot,
        currentLinkPath,
      } : { enabled: false },
    },
  };
  writeJSON(configPath, config);
  writeJSON(join(stateRoot, "resolvable-models.json"), {
    updatedAt: Date.now(),
    models: ["openai/gpt-5.6-sol", "openai/gpt-6-sol", "anthropic/claude-opus-5-5"],
  });
  writeJSON(baseConfigPath, {
    provider: {
      openai: {
        models: Object.fromEntries(baseModels
          .filter((key) => key.startsWith("openai/"))
          .map((key) => {
            const modelID = key.slice("openai/".length);
            return [modelID, { id: modelID, variants: { high: {} } }];
          })),
      },
    },
  });

  const generationManager = createResolverGenerationManager({
    root: generationsRoot,
    currentLinkPath,
    runResolver: async ({ configPath: candidatePath }) => {
      effects.resolverRuns += 1;
      const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
      return Object.entries(candidate.provider ?? {}).flatMap(([providerID, provider]) =>
        Object.keys(provider.models ?? {}).map((modelID) => `${providerID}/${modelID}`)).sort().join("\n") + "\n";
    },
    now: () => NOW,
    pid: process.pid,
  });

  if (applyEnabled) {
    const generation0 = await generationManager.build({
      reservedGeneration: 0,
      bootstrapGeneration0: true,
      baseConfigPath,
      overlay: { version: 1, revision: 0, updatedAt: NOW - 2, entries: {} },
      authorizingRevisions: [],
      protectedReferences: [],
      authorizedRetirements: [],
    });
    await generationManager.publish(generation0);
  }

  broker = await startBroker({ home, configPath, actualSocketPath });

  const recordTrace = (record) => {
    appendFileSync(tracePath, `${JSON.stringify(record)}\n`);
  };
  const traceRecords = () => readFileSync(tracePath, "utf8").split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const policyIdentity = () => {
    const brokerStatePath = join(stateRoot, "broker.json");
    if (!existsSync(brokerStatePath)) return null;
    return JSON.stringify(JSON.parse(readFileSync(brokerStatePath, "utf8")).modelPolicy ?? null);
  };
  const requestBroker = async (path, body = {}, options = {}) => {
    const beforePolicy = policyIdentity();
    const result = await unixRequest(actualSocketPath, path, body, options);
    recordTrace({
      source: "parent",
      kind: "broker-response",
      path,
      status: result.status,
      policyChanged: policyIdentity() !== beforePolicy,
    });
    return result;
  };

  gateway = await startGateway({ brokerRequest: requestBroker, recordTrace, effects });

  const rawBrokerRequest = async (path, body = {}, options = {}) => {
    const requestOptions = path === "/model-policy/status" ? { ...options, method: "GET" } : options;
    const result = await requestBroker(path, body, requestOptions);
    if (result.status < 200 || result.status >= 300) {
      const error = new Error(result.body.error ?? `broker HTTP ${result.status}`);
      error.code = result.body.code;
      error.status = result.status;
      throw error;
    }
    return result.body;
  };

  const store = createReconciliationStore({ root: stateRoot, now: () => NOW, pid: process.pid });
  const overlayStore = createResolverOverlayStore({ path: overlayPath, now: () => NOW, pid: process.pid });
  if (applyEnabled) {
    store.update((state) => ({
      ...state,
      roles: { ...state.roles, [ROLE]: approvedRecord() },
    }));
  }
  const sources = {
    catalog: { stale: false, empty: false, error: false },
    resolver: { stale: false, empty: false, error: false },
    authRevision: authRevision(authPath),
    authRevisionAfter: authRevision(authPath),
    catalogModels: CATALOG,
    baseConfigPath,
    modelRoles: MODEL_ROLES,
    ordinaryModel: "smart",
  };
  const probeClientFactory = createProbeClientFactory({
    spawnProbeProcess: (request) => {
      if (!realProbeHelper) throw new Error("runtime requires the real probe helper");
      probeChild = spawn(request.command, request.args, {
        ...request.options,
        env: {
          ...process.env,
          OPENCODE_BROKER_TEST_TRACE: tracePath,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${childTraceModulePath}`].filter(Boolean).join(" "),
        },
      });
      probeChild.once("exit", () => {
        probeChildReaped = true;
        recordTrace({ source: "parent", event: "reap" });
      });
      return probeChild;
    },
    generationManager,
    brokerSocketPath: actualSocketPath,
    gatewayURL: gateway.url,
    gatewayHeaders: { Authorization: `Bearer ${GATEWAY_KEY}` },
  });
  const realApplier = createReconciliationApplier({
    store,
    overlayStore,
    generationManager,
    brokerRequest: rawBrokerRequest,
    probeClientFactory,
    collectSources: async () => sources,
    now: () => NOW,
  });

  const inventoryFor = (descriptor) => discoverSubscriptionTargets(
    catalogInventory(descriptor.providerID, descriptor.modelID),
    { [descriptor.providerID]: descriptor.authType },
    config.targets,
    {
      resolvableModels: new Set([`${descriptor.providerID}/${descriptor.modelID}`]),
      modelRoles: MODEL_ROLES,
      trustedProviderIDs: new Set(["anthropic"]),
    },
  );

  const discover = async (descriptor) => {
    const discovered = inventoryFor(descriptor);
    const target = Object.values(discovered.targets)[0] ?? null;
    if (descriptor.providerID === "openai") {
      const response = await rawBrokerRequest("/inventory", {
        ...discovered,
        authRevision: authRevision(authPath),
        configFingerprint: createHash("sha256").update(readFileSync(configPath)).digest("hex"),
      });
      if (response.accepted !== true) throw new Error(`runtime inventory was rejected: ${response.reason}`);
    }
    return target;
  };

  const registerGeneration = async (generation) => {
    const bundle = generationManager.generation(generation);
    const registration = await rawBrokerRequest("/resolver-process/register", {
      generation,
      manifestHash: bundle.manifestHash,
      modelKeys: bundle.manifest.modelKeys,
    });
    return registration;
  };

  const lease = async ({ client, tier = "smart", sessionID = `runtime-${++leaseSequence}` }) => {
    const response = await rawBrokerRequest("/lease", {
      sessionID,
      profile: "auto",
      tier,
      contextTokens: 100,
      resolverToken: client?.resolverToken,
      replace: true,
    });
    return {
      sessionID,
      leaseID: response.leaseID,
      targetID: response.target.id,
      modelID: response.target.model.id,
      response,
    };
  };

  const successfulCandidateLease = async (client, label) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const acquired = await lease({ client, sessionID: `${label}-${attempt}` });
      if (acquired.modelID === "gpt-6-sol") {
        await rawBrokerRequest("/complete", {
          sessionID: acquired.sessionID,
          leaseID: acquired.leaseID,
          targetID: acquired.targetID,
        });
        return acquired;
      }
      await rawBrokerRequest("/release", {
        sessionID: acquired.sessionID,
        leaseID: acquired.leaseID,
      });
    }
    const diagnostic = JSON.parse(readFileSync(join(stateRoot, "broker.json"), "utf8"));
    throw new Error(`candidate was not offered for ${label}: ${JSON.stringify({
      policy: diagnostic.modelPolicy?.roles?.[ROLE],
      lastDecision: diagnostic.lastDecision,
      inventoryTargets: diagnostic.inventory?.targets ?? {},
      modelVariants: diagnostic.inventory?.modelVariants ?? {},
    })}`);
  };

  const seedPostActiveFailures = async (client) => {
    if (pendingFailures.size) return;
    for (const label of ["post-1", "post-2"]) {
      const acquired = await lease({ client, sessionID: label });
      if (acquired.modelID !== "gpt-6-sol") throw new Error("active candidate was not leased");
      pendingFailures.set(label, acquired);
    }
  };

  let latestCurrentClient = null;
  const registerCurrentGeneration = async () => {
    latestCurrentClient = await registerGeneration(generationManager.current().generation);
    return latestCurrentClient;
  };

  const failCandidate = async (label, failureClass) => {
    if (!latestCurrentClient) throw new Error("current generation is not registered");
    await seedPostActiveFailures(latestCurrentClient);
    const acquired = pendingFailures.get(label);
    if (!acquired) throw new Error(`no pending candidate lease ${label}`);
    pendingFailures.delete(label);
    await rawBrokerRequest("/failure", {
      sessionID: acquired.sessionID,
      leaseID: acquired.leaseID,
      targetID: acquired.targetID,
      failureClass,
      error: { message: failureClass },
    });
  };

  const prohibitedPaths = [
    join(stateRoot, "model-reconciliation.json"),
    overlayPath,
    generationsRoot,
    join(stateRoot, "broker.json"),
  ];

  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([
      gateway ? closeServer(gateway.server) : Promise.resolve(),
    ]);
    if (probeChild && probeChild.exitCode === null && probeChild.signalCode === null) probeChild.kill("SIGKILL");
    await stopChild(broker?.child);
    rmSync(root, { recursive: true, force: true });
  };

  return {
    applier: realApplier,
    close,
    discover,
    transitionID: (roleKey) => {
      if (roleKey !== ROLE) throw new Error(`unknown runtime role ${roleKey}`);
      return TRANSITION_ID;
    },
    overlay: () => overlayStore.read(),
    currentManifest: () => generationManager.current().manifest,
    currentGeneration: () => generationManager.current().generation,
    probeGeneration: () => traceRecords().find((record) =>
      record.source === "child" && record.path === "/resolver-process/register" && record.status === 200)?.generation ?? null,
    probeTrace: () => traceRecords().flatMap((record) => {
      if (record.source === "parent" && record.path === "/model-policy/probe-launch" && record.status === 200) {
        return ["probe-launch"];
      }
      if (record.source === "child" && record.path === "/resolver-process/register" && record.status === 200) {
        return ["child-register"];
      }
      if (record.source === "child" && record.path === "/model-policy/probe" && record.status === 200) {
        return ["child-model-policy-probe"];
      }
      if (record.event === "ordinary-gateway") return ["ordinary-gateway"];
      if (record.source === "parent" && record.path === "/probe/release" && record.status === 200) {
        return ["release"];
      }
      if (record.event === "reap") return ["reap"];
      return [];
    }),
    parentProbeNetworkCalls: () => traceRecords().filter((record) =>
      record.event === "ordinary-gateway" && !record.childOwned).length,
    probeChildReaped: () => probeChildReaped,
    actualBrokerSocketPath: () => actualSocketPath,
    actualBrokerSocketMode: () => lstatSync(actualSocketPath).mode & 0o777,
    probeBrokerSocketPath: () => traceRecords().find((record) =>
      record.source === "child" && record.path === "/resolver-process/register")?.socketPath ?? null,
    registerGeneration,
    registerCurrentGeneration,
    lease,
    successfulCandidateLease,
    failCandidate,
    policy: (roleKey) => JSON.parse(readFileSync(join(stateRoot, "broker.json"), "utf8")).modelPolicy.roles[roleKey],
    postProbeWithToken: async (resolverToken, request) => requestBroker("/model-policy/probe", {
      ...request,
      candidateIntroduction: request.candidateIntroduction ?? {
        generation: generationManager.current().generation,
        manifestHash: generationManager.current().manifestHash,
      },
    }, { headers: { "x-opencode-resolver-token": resolverToken } }),
    runCLI: (argv) => {
      const result = spawnSync(process.execPath, [RECONCILE_SCRIPT, ...argv], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: home,
          OPENCODE_BROKER_CONFIG: configPath,
          OPENCODE_MODEL_BROKER_SOCKET: actualSocketPath,
        },
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      return { status: result.status, body: JSON.parse(result.stdout || "{}") };
    },
    postControl: (path, body) => requestBroker(path, body),
    snapshotBytesAndMtimes: () => Object.fromEntries(prohibitedPaths.map((path) => [path, snapshotPath(path)])),
    effectCounts: () => {
      const successful = traceRecords().filter((record) =>
        record.kind === "broker-response" && record.status >= 200 && record.status < 300);
      return {
        launchNonces: successful.filter((record) => record.path === "/model-policy/probe-launch").length,
        assignments: successful.filter((record) => record.path === "/model-policy/probe").length,
        leases: successful.filter((record) => record.path === "/lease").length,
        safeRegistrations: successful.filter((record) => record.path === "/resolver-process/register").length,
        resolverRuns: effects.resolverRuns,
        brokerMutations: successful.filter((record) => record.policyChanged === true).length,
        externalCalls: effects.externalCalls,
      };
    },
  };
};
