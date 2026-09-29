import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  EVIDENCE_JOB_TIMEOUT_MS,
  buildEvidencePrompt,
  collectEvidenceOnce,
  researcherArgv,
} from "../lib/reconcile-collector.js";
import { readGiteaTokenIfPresent } from "../lib/reconcile-secrets.js";
import { allowedEvidenceDomains, enqueueEvidenceRequests } from "../lib/reconcile-evidence.js";
import { createReconciliationStore, emptyReconciliationState } from "../lib/reconcile-state.js";

// Far enough after every fixture retrievedAt to be inside the accepted skew window.
const NOW = Date.parse("2026-09-29T00:04:00Z");
const ROLE_TRANSITION = "aaaaaaaaaaaaaaaaaaaaaaaa";
const UNKNOWN_TRANSITION = "bbbbbbbbbbbbbbbbbbbbbbbb";

const TEST_ROLES = Object.freeze({
  "openai:gpt-sol": Object.freeze({
    providerID: "openai",
    roleID: "gpt-sol",
    evidenceDomains: Object.freeze(["openai.com", "developers.openai.com"]),
  }),
  "openai:gpt-luna": Object.freeze({
    providerID: "openai",
    roleID: "gpt-luna",
    evidenceDomains: Object.freeze(["platform.openai.com", "openai.com"]),
  }),
  "anthropic:claude-opus": Object.freeze({
    providerID: "anthropic",
    roleID: "claude-opus",
    evidenceDomains: Object.freeze(["anthropic.com"]),
  }),
});

const ROLE_RECORD = Object.freeze({
  transitionID: ROLE_TRANSITION,
  roleKey: "openai:gpt-sol",
  providerID: "openai",
  roleID: "gpt-sol",
  candidateModelID: "gpt-6-sol",
  candidateReleaseDate: "2026-09-22",
  incumbentModelID: "gpt-5.6-sol",
  state: "evidence-pending",
  evidence: [],
  approval: null,
  issue: null,
  notified: null,
});

const UNKNOWN_RECORD = Object.freeze({
  transitionID: UNKNOWN_TRANSITION,
  groupKey: "openai:gpt-orbit",
  providerID: "openai",
  modelID: "gpt-6-orbit",
  family: "gpt-orbit",
  releaseDate: "2026-09-20",
  state: "evidence-pending",
  evidence: [],
  approval: null,
  issue: null,
  notified: null,
});

const PAYLOAD = Object.freeze({
  providerID: "openai",
  candidateModelID: "gpt-6-sol",
  incumbentModelID: "gpt-5.6-sol",
  roleID: "gpt-sol",
  claims: [{
    claimType: "successor",
    sourceURL: "https://developers.openai.com/api/docs/guides/latest-model",
    exactQuote: "GPT-5.6 Sol maps to GPT-6 Sol.",
    retrievedAt: "2026-09-29T00:00:00Z",
  }],
});

const UNKNOWN_NEW_ROLE_PAYLOAD = Object.freeze({
  providerID: "openai",
  candidateModelID: "gpt-6-orbit",
  incumbentModelID: null,
  roleID: "gpt-orbit",
  claims: [{
    claimType: "new-role",
    sourceURL: "https://platform.openai.com/docs/models/gpt-6-orbit",
    exactQuote: "GPT-6 Orbit introduces a new official role.",
    retrievedAt: "2026-09-29T00:00:00Z",
  }],
});

const payloadQuoting = (text) => ({
  ...PAYLOAD,
  claims: [{ ...PAYLOAD.claims[0], exactQuote: `leaked ${text} here now` }],
});

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A REAL store over a temp root, not a double: the collector's claim/ingest sequencing is only
// meaningful against the locked writer, and every assertion below reads the ledger back.
const storeWith = (state) => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-collector-"));
  roots.push(root);
  const store = createReconciliationStore({ root, now: () => NOW, pid: 7 });
  if (state) store.update(() => state);
  return store;
};

const queuedState = (records) => enqueueEvidenceRequests(
  { ...emptyReconciliationState(), ...records },
  { now: () => NOW },
).state;

// Named for what it holds: ONE claimable evidence request for the role candidate. The collector
// takes the claim itself, so a store whose request was already claimed would be nothing-due.
const freshQueuedStore = () => storeWith(queuedState({ roles: { "openai:gpt-sol": { ...ROLE_RECORD } } }));
const freshUnknownQueuedStore = () => storeWith(queuedState({ unknown: { [UNKNOWN_TRANSITION]: { ...UNKNOWN_RECORD } } }));
const ROLE_CLAIM = queuedState({ roles: { "openai:gpt-sol": { ...ROLE_RECORD } } }).evidenceRequests[ROLE_TRANSITION];

test("the researcher runs through the gateway, read-only, with no credential in its environment", () => {
  const calls = [];
  const store = freshQueuedStore();
  const result = collectEvidenceOnce({
    store, roles: TEST_ROLES, now: () => NOW, pid: 4242,
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0, stdout: JSON.stringify(PAYLOAD), stderr: "" };
    },
  });
  assert.equal(result.collected, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "opencode");
  assert.deepEqual(calls[0].args.slice(0, 5),
    ["run", "--agent", "researcher", "--model", "fleet-gateway/smart"]);
  const env = calls[0].options.env;
  for (const key of Object.keys(env)) {
    assert.doesNotMatch(key, /TOKEN|SECRET|KEY|PASSWORD/i, `${key} must not reach the researcher`);
  }
  assert.equal(calls[0].options.timeout, EVIDENCE_JOB_TIMEOUT_MS);
  assert.equal(store.read().roles["openai:gpt-sol"].evidence.length, 1);
  assert.equal(store.read().evidenceRequests[ROLE_TRANSITION], undefined);
});

test("researcherArgv names the read-only agent and the gateway model, and nothing else", () => {
  assert.deepEqual(researcherArgv({ model: "fleet-gateway/smart" }),
    ["run", "--agent", "researcher", "--model", "fleet-gateway/smart"]);
});

// Nothing due must not create the ledger either: a collector that wrote empty state on a host
// that has never reconciled would make `status` report reconciliation that never happened.
test("nothing due is a success, not an error, and spawns nothing", () => {
  const emptyStore = storeWith(null);
  const result = collectEvidenceOnce({
    store: emptyStore, roles: TEST_ROLES, now: () => NOW, pid: 1,
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(result.collected, false);
  assert.equal(result.reason, "nothing-due");
  assert.equal(existsSync(emptyStore.paths().state), false);
});

test("a non-zero exit, a timeout, and unparseable stdout each record a failure and keep the request", () => {
  for (const outcome of [
    { status: 1, stdout: "", stderr: "researcher failed" },
    { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), status: null, stdout: "" },
    { status: 0, stdout: "I could not find anything.", stderr: "" },
  ]) {
    const store = freshQueuedStore();
    const result = collectEvidenceOnce({
      store, roles: TEST_ROLES, now: () => NOW, pid: 1,
      spawn: () => outcome,
    });
    assert.equal(result.collected, false);
    const request = store.read().evidenceRequests[ROLE_TRANSITION];
    assert.equal(request.status, "failed");
    assert.equal(request.attempts, 1);
    assert.ok(request.lastError.length > 0);
    assert.deepEqual(store.read().roles["openai:gpt-sol"].evidence, []);
  }
});

test("rejected evidence is a failure, and nothing partial is stored", () => {
  const store = freshQueuedStore();
  const result = collectEvidenceOnce({
    store, roles: TEST_ROLES, now: () => NOW, pid: 1,
    spawn: () => ({ status: 0, stdout: JSON.stringify({ ...PAYLOAD, candidateModelID: "gpt-6-luna" }) }),
  });
  assert.equal(result.collected, false);
  assert.match(result.reason, /no acceptable evidence/);
  assert.deepEqual(store.read().roles["openai:gpt-sol"].evidence, []);
  assert.equal(store.read().evidenceRequests[ROLE_TRANSITION].status, "failed");
});

test("the prompt names the candidate, the incumbent, and only the allowed domains", () => {
  const prompt = buildEvidencePrompt(ROLE_CLAIM, {
    allowedDomains: allowedEvidenceDomains(ROLE_CLAIM, TEST_ROLES),
  });
  assert.match(prompt, /gpt-6-sol/);
  assert.match(prompt, /gpt-5\.6-sol/);
  assert.match(prompt, /developers\.openai\.com/);
  assert.doesNotMatch(prompt, /anthropic\.com/);
  assert.match(prompt, /exactly one JSON object/i);
  // A newer release date is never sufficient, and the four policy claim types are named.
  assert.match(prompt, /release date/i);
  for (const claimType of ["successor", "recommended-replacement", "new-role", "role-change"]) {
    assert.match(prompt, new RegExp(claimType));
  }
});

test("an unknown-role request is collectable against its provider's domain union", () => {
  const calls = [];
  const store = freshUnknownQueuedStore();
  const result = collectEvidenceOnce({
    store, roles: TEST_ROLES, now: () => NOW, pid: 1,
    spawn: (file, args) => {
      calls.push(args.at(-1));
      return { status: 0, stdout: JSON.stringify(UNKNOWN_NEW_ROLE_PAYLOAD) };
    },
  });
  assert.equal(result.collected, true);
  assert.match(calls[0], /developers\.openai\.com/);
  assert.match(calls[0], /platform\.openai\.com/);
  assert.equal(store.read().unknown[UNKNOWN_TRANSITION].evidence.length, 1);
});

// The wrapper process holds the token so it can refuse a payload quoting it; the model must
// never see it. All three properties are one control, so they are pinned together.
test("a token-bearing stdout is refused, and the token never reaches the child", () => {
  const store = freshQueuedStore();
  let childEnv;
  let childArgv;
  const result = collectEvidenceOnce({
    store, roles: TEST_ROLES, now: () => NOW, pid: 1,
    forbiddenStrings: ["test-gitea-token"],
    spawn: (file, args, options) => {
      childEnv = options.env;
      childArgv = args;
      return { status: 0, stdout: JSON.stringify(payloadQuoting("test-gitea-token")) };
    },
  });
  assert.equal(result.collected, false);
  assert.match(result.reason, /forbidden/i);
  assert.deepEqual(store.read().roles["openai:gpt-sol"].evidence, []);
  assert.equal(store.read().evidenceRequests[ROLE_TRANSITION].status, "failed");
  assert.equal(Object.values(childEnv).some((value) => String(value).includes("test-gitea-token")), false);
  assert.equal(childArgv.join(" ").includes("test-gitea-token"), false);
});

// Without the token in forbiddenStrings the same payload is ACCEPTED, which is what makes the
// test above a test of the control rather than of the quote's shape.
test("the refusal comes from the forbidden list, not from the quote itself", () => {
  const store = freshQueuedStore();
  const result = collectEvidenceOnce({
    store, roles: TEST_ROLES, now: () => NOW, pid: 1,
    spawn: () => ({ status: 0, stdout: JSON.stringify(payloadQuoting("test-gitea-token")) }),
  });
  assert.equal(result.collected, true);
});

// The one trusted token reader, tested here because the collector wrapper is its first caller
// and the two ship together. Task 5's Gitea client imports it rather than re-reading the file.
test("an absent token drop file is null, not an error", () => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-secrets-"));
  roots.push(root);
  assert.equal(readGiteaTokenIfPresent(join(root, "gitea-token")), null);
});

test("a token is read and trimmed, and never returned with its newline", () => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-secrets-"));
  roots.push(root);
  const path = join(root, "gitea-token");
  writeFileSync(path, "test-gitea-token\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  assert.equal(readGiteaTokenIfPresent(path), "test-gitea-token");
});

test("a group- or world-readable token file is refused instead of used", () => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-secrets-"));
  roots.push(root);
  for (const mode of [0o640, 0o604, 0o666]) {
    const path = join(root, `token-${mode.toString(8)}`);
    writeFileSync(path, "test-gitea-token\n");
    chmodSync(path, mode);
    assert.throws(() => readGiteaTokenIfPresent(path), (error) => {
      assert.match(error.message, /readable/);
      assert.equal(error.message.includes("test-gitea-token"), false,
        "the refusal must never echo the token");
      return true;
    });
  }
});

test("an empty token drop file is a loud deployment error, not a silent absence", () => {
  const root = mkdtempSync(join(tmpdir(), "reconcile-secrets-"));
  roots.push(root);
  const path = join(root, "gitea-token");
  writeFileSync(path, "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  assert.throws(() => readGiteaTokenIfPresent(path), /empty/);
});

// ---------------------------------------------------------------------------------------------
// The CLI, as a SPAWNED PROCESS. Only paths that reach no research job are exercised here: the
// fake `opencode` on PATH fails loudly, so a test that passes is a test where nothing was spawned.
const CLI = new URL("../bin/opencode-broker-evidence", import.meta.url).pathname;

const POISONED_OPENCODE = `#!/bin/sh
echo "fake opencode: nothing in this suite may spawn a research job: $*" >&2
exit 1
`;

const cliFixture = ({ config = "{}", tokenMode = null } = {}) => {
  const base = mkdtempSync(join(tmpdir(), "evidence-cli-"));
  roots.push(base);
  const home = join(base, "home");
  const stateRoot = join(base, "state");
  const configRoot = join(base, "config");
  const fakeBin = join(base, "bin");
  const configPath = join(configRoot, "opencode-broker/config.json");
  const tokenPath = join(configRoot, "opencode-broker/gitea-token");

  mkdirSync(home, { recursive: true });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, config);
  if (tokenMode !== null) {
    writeFileSync(tokenPath, "test-gitea-token\n");
    chmodSync(tokenPath, tokenMode);
  }
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "opencode"), POISONED_OPENCODE, { mode: 0o755 });

  return { base, home, stateRoot, configRoot, configPath, tokenPath, fakeBin, statePath: join(stateRoot, "model-reconciliation.json") };
};

// Inherited OPENCODE_* and XDG_* variables are stripped: this suite runs on a host with a real
// broker config, a real state root and a real token drop file, and any of them leaking in would
// make a test pass for the wrong reason or write to live state.
const runCLI = (fixture, args) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCODE_|XDG_)/.test(name)));
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...clean,
      HOME: fixture.home,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      OPENCODE_MODEL_ROUTING_DIR: fixture.stateRoot,
      XDG_CONFIG_HOME: fixture.configRoot,
      XDG_CACHE_HOME: join(fixture.base, "cache"),
      OPENCODE_BROKER_CONFIG: fixture.configPath,
    },
  });
};

test("the CLI reports nothing due as success, spawns no job, and creates no ledger", () => {
  const fixture = cliFixture();
  const result = runCLI(fixture, ["--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),
    { max: 1, attempted: 0, collected: 0, failed: 0, results: [] });
  assert.equal(existsSync(fixture.statePath), false);
  assert.deepEqual(readdirSync(fixture.stateRoot), []);

  const human = runCLI(fixture, []);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, "nothing due\n");
});

test("the CLI refuses an unknown option and an out-of-range --max without collecting", () => {
  const fixture = cliFixture();
  for (const args of [["--publish"], ["--max", "6"], ["--max", "0"], ["--max"], ["--max", "two"], ["--json=1"]]) {
    const result = runCLI(fixture, args);
    assert.equal(result.status, 2, `${args.join(" ")} was not refused: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /usage: opencode-broker-evidence/);
    assert.equal(existsSync(fixture.statePath), false);
  }
});

// A credential left group-readable is a deployment fault, and proceeding without the token would
// leave ingestEvidence unable to refuse a payload quoting it. Exit 1 before any job runs.
test("the CLI refuses to run with a loosely permissioned token drop file, and never prints it", () => {
  const fixture = cliFixture({ tokenMode: 0o644 });
  const result = runCLI(fixture, ["--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /group- or world-readable/);
  assert.match(result.stderr, /gitea-token/);
  assert.equal(`${result.stdout}${result.stderr}`.includes("test-gitea-token"), false);
  assert.equal(existsSync(fixture.statePath), false);
});

test("a correctly permissioned token drop file is accepted and never printed", () => {
  const fixture = cliFixture({ tokenMode: 0o600 });
  const result = runCLI(fixture, ["--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`${result.stdout}${result.stderr}`.includes("test-gitea-token"), false);
});

test("an unparseable config exits 1 instead of collecting against no roles", () => {
  const fixture = cliFixture({ config: "{ targets: oops\n" });
  const result = runCLI(fixture, ["--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /config/i);
  assert.equal(existsSync(fixture.statePath), false);
});

test("the researcher is never given a shell, stdin, or an unbounded run", () => {
  const store = freshQueuedStore();
  let options;
  collectEvidenceOnce({
    store, roles: TEST_ROLES, now: () => NOW, pid: 1, timeoutMs: 1234,
    spawn: (file, args, opts) => {
      options = opts;
      return { status: 0, stdout: JSON.stringify(PAYLOAD) };
    },
  });
  assert.equal(options.shell, undefined);
  assert.equal(options.timeout, 1234);
  assert.equal(options.encoding, "utf8");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
});
