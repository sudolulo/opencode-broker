import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import { DEFAULT_MODEL_ROLES } from "../lib/model-roles.js";
import { candidateRevision } from "../lib/reconcile-evidence.js";
import { proposalRevision } from "../lib/reconcile-gitea.js";
import {
  RESOLVER_OVERLAY_VERSION,
  buildResolverOverlay,
  createResolverOverlayStore,
  emptyResolverOverlay,
  hashResolverOverlay,
  validateResolverOverlay,
} from "../lib/reconcile-overlay.js";

const NOW = 1_800_000_000_000;
const INTENT_OVERLAY_UPDATED_AT = NOW + 10;
const NEXT_INTENT_OVERLAY_UPDATED_AT = NOW + 20;
const MODEL = "openai/gpt-6-sol";
const ZERO_COST = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tempRoot = (label) => {
  const base = mkdtempSync(join(tmpdir(), `reconcile-overlay-${label}-`));
  roots.push(base);
  return join(base, "model-routing");
};

const modelMetadata = (modelID = "gpt-6-sol", family = "gpt-sol", overrides = {}) => ({
  id: modelID,
  name: modelID === "gpt-6-sol" ? "GPT 6 Sol" : modelID,
  family,
  release_date: "2026-09-22",
  tool_call: true,
  limit: { context: 1_050_000, output: 128_000 },
  variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
  ...overrides,
});

const catalogWith = (...models) => ({
  openai: {
    id: "openai",
    models: Object.fromEntries(models.map((model) => [model.id, model])),
  },
});

const authorizedRecord = ({
  roleKey = "openai:gpt-sol",
  roleID = roleKey.split(":")[1],
  modelID = "gpt-6-sol",
  family = roleID,
  transitionID = "a".repeat(24),
  state = "auto-eligible",
  approval = null,
} = {}) => {
  const record = {
    transitionID,
    roleKey,
    providerID: "openai",
    roleID,
    candidateModelID: modelID,
    candidateFamily: family,
    candidateReleaseDate: "2026-09-22",
    candidateVersion: "6",
    incumbentModelID: "gpt-5.6-sol",
    proposedTiers: [...DEFAULT_MODEL_ROLES[roleKey].tiers],
    proposedFit: { ...DEFAULT_MODEL_ROLES[roleKey].fit },
    state,
    reason: state === "auto-eligible" ? `official successor claim for ${modelID}` : "approved by operator",
    stateChangedAt: NOW - 100,
    lastObservedAt: NOW - 100,
    transitions: ["discovered", "evidence-pending", state],
    evidence: [{
      providerID: "openai",
      candidateModelID: modelID,
      incumbentModelID: "gpt-5.6-sol",
      roleID,
      claimType: "successor",
      sourceURL: "https://openai.com/index/new-model",
      exactQuote: `${modelID} succeeds the prior model in this role.`,
      retrievedAt: "2026-09-29T12:00:00Z",
      contentHash: "b".repeat(64),
      policy: true,
    }],
    evidenceRevision: null,
    evidenceCollectedAt: NOW - 200,
    evidenceContradiction: false,
    approval,
    issue: null,
    notified: null,
  };
  record.evidenceRevision = candidateRevision(record);
  return record;
};

const authorizedLedger = (...records) => ({
  version: 1,
  updatedAt: NOW,
  roles: Object.fromEntries(records.map((record) => [record.roleKey, record])),
  unknown: {},
  evidenceRequests: {},
});

const SOL_RECORD = authorizedRecord();
const GPT6_CATALOG = catalogWith(modelMetadata());
const OVERLAY_ARGS = {
  ledger: authorizedLedger(SOL_RECORD),
  modelRoles: DEFAULT_MODEL_ROLES,
  catalogModels: GPT6_CATALOG,
  introductionGeneration: 4,
  overlayUpdatedAt: INTENT_OVERLAY_UPDATED_AT,
};

const bytesOf = (overlay) => Buffer.from(`${JSON.stringify(overlay, null, 1)}\n`);

test("authorized entries are stable, zero cost, and retain first introduction generation", () => {
  const first = buildResolverOverlay(OVERLAY_ARGS);
  const entry = first.entries[MODEL];

  assert.equal(first.version, RESOLVER_OVERLAY_VERSION);
  assert.equal(first.revision, 1);
  assert.equal(first.updatedAt, INTENT_OVERLAY_UPDATED_AT);
  assert.equal(entry.transitionID, SOL_RECORD.transitionID);
  assert.equal(entry.revision, proposalRevision(SOL_RECORD));
  assert.equal(entry.authorizationKind, "auto-eligible");
  assert.equal(entry.introductionGeneration, 4);
  assert.deepEqual(entry.model.cost, ZERO_COST);
  assert.equal("status" in entry.model, false);
  assert.equal("reasoning_options" in entry.model, false);
  assert.match(entry.authorizationHash, /^[a-f0-9]{64}$/);

  const replay = buildResolverOverlay({
    ...OVERLAY_ARGS,
    introductionGeneration: 9,
    previous: first,
    overlayUpdatedAt: NOW + 86_400_000,
  });
  assert.deepEqual(replay, first);
  assert.equal(replay.entries[MODEL].introductionGeneration, 4);
  assert.equal(replay.entries[MODEL].authorizationHash, entry.authorizationHash);
});

test("approved authorization hashes the durable decision and rejects a non-approval", () => {
  const approval = { decision: "approved", source: "cli", at: NOW, note: "known successor" };
  const approved = authorizedRecord({ state: "approved", approval });
  const first = buildResolverOverlay({ ...OVERLAY_ARGS, ledger: authorizedLedger(approved) });
  assert.equal(first.entries[MODEL].authorizationKind, "approved");
  assert.equal(first.entries[MODEL].revision, proposalRevision(approved));

  const amendedDecision = authorizedRecord({
    state: "approved",
    approval: { ...approval, note: "different durable decision" },
  });
  const changed = buildResolverOverlay({ ...OVERLAY_ARGS, ledger: authorizedLedger(amendedDecision) });
  assert.notEqual(changed.entries[MODEL].authorizationHash, first.entries[MODEL].authorizationHash);

  assert.throws(() => buildResolverOverlay({
    ...OVERLAY_ARGS,
    ledger: authorizedLedger(authorizedRecord({
      state: "approved",
      approval: { ...approval, decision: "rejected" },
    })),
  }), /approved.*decision|authorization/i);
});

test("canonical overlay hashes ignore object insertion order", () => {
  const ordinary = emptyResolverOverlay({ now: () => 1 });
  const reordered = { entries: {}, updatedAt: 1, revision: 0, version: 1 };
  assert.equal(hashResolverOverlay(ordinary), "b39ffd5419cefbef7b77243a053c291d147d00feed315fa20f928ba01abae346");
  assert.equal(hashResolverOverlay(reordered), hashResolverOverlay(ordinary));
});

test("construction omits unauthorized records and rejects suspicious catalog metadata", () => {
  assert.deepEqual(buildResolverOverlay({
    ...OVERLAY_ARGS,
    ledger: authorizedLedger(authorizedRecord({ state: "evidence-pending" })),
  }).entries, {});

  for (const field of ["apiKey", "baseURL", "credentials", "tokenPath"]) {
    assert.throws(() => buildResolverOverlay({
      ...OVERLAY_ARGS,
      catalogModels: catalogWith(modelMetadata("gpt-6-sol", "gpt-sol", { [field]: "not-a-real-secret" })),
    }), new RegExp(`unsupported|secret|${field}`, "i"));
  }
});

test("validation rejects orphan mismatch nonzero secret baseURL mutation and deletion", () => {
  const valid = buildResolverOverlay(OVERLAY_ARGS);
  const semanticMutations = [
    [(x) => { x.entries[MODEL].transitionID = "orphan"; }, /orphan|transition|mismatch/],
    [(x) => { x.entries[MODEL].providerID = "anthropic"; }, /provider|key|mismatch/],
    [(x) => { x.entries[MODEL].model.cost.input = 1; }, /cost|zero/],
    [(x) => { x.entries[MODEL].model.apiKey = "not-a-real-secret"; }, /unsupported|secret|apiKey/i],
    [(x) => { x.entries[MODEL].model.baseURL = "https:\/\/provider.invalid"; }, /unsupported|baseURL/i],
  ];
  for (const [mutate, expected] of semanticMutations) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => validateResolverOverlay(changed, {
      ledger: OVERLAY_ARGS.ledger,
      modelRoles: DEFAULT_MODEL_ROLES,
      previous: emptyResolverOverlay({ now: () => NOW }),
    }), expected);
  }

  for (const mutate of [
    (x) => { x.entries[MODEL].model.limit.context += 1; },
    (x) => { delete x.entries[MODEL]; },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => validateResolverOverlay(changed, {
      ledger: OVERLAY_ARGS.ledger,
      modelRoles: DEFAULT_MODEL_ROLES,
      previous: valid,
    }), /append-only|changed|removed/);
  }
});

test("a later authorization cannot rewrite an existing append-only entry", () => {
  const valid = buildResolverOverlay(OVERLAY_ARGS);
  const changedEvidence = authorizedRecord();
  changedEvidence.evidence[0].exactQuote = "A changed quote cannot rewrite historical resolver metadata.";
  assert.throws(() => buildResolverOverlay({
    ...OVERLAY_ARGS,
    ledger: authorizedLedger(changedEvidence),
    previous: valid,
    overlayUpdatedAt: NEXT_INTENT_OVERLAY_UPDATED_AT,
  }), /append-only|changed|authorization/);
});

test("the overlay store atomically writes a private versioned file and rejects stale or corrupt state", () => {
  const root = tempRoot("store");
  const store = createResolverOverlayStore({ root, now: () => NOW - 1, pid: 42 });
  const initial = store.read();
  const next = buildResolverOverlay({ ...OVERLAY_ARGS, previous: initial });
  const result = store.write(next, {
    expectedPreviousHash: hashResolverOverlay(initial),
    expectedRevision: initial.revision,
  });

  assert.deepEqual(result, {
    changed: true,
    replayed: false,
    hash: hashResolverOverlay(next),
    revision: next.revision,
  });
  assert.equal(statSync(store.paths().root).mode & 0o777, 0o700);
  assert.equal(statSync(store.paths().overlay).mode & 0o777, 0o600);
  assert.equal(readFileSync(store.paths().overlay, "utf8").endsWith("\n"), true);
  assert.deepEqual(store.read(), next);

  const before = readFileSync(store.paths().overlay);
  const staleDesired = structuredClone(next);
  staleDesired.revision += 1;
  staleDesired.updatedAt = NEXT_INTENT_OVERLAY_UPDATED_AT;
  const store2 = createResolverOverlayStore({ root, now: () => NOW + 1, pid: 43 });
  assert.throws(() => store2.write(staleDesired, {
    expectedPreviousHash: hashResolverOverlay(initial),
    expectedRevision: initial.revision,
  }), /stale overlay hash|stale overlay revision/);
  assert.deepEqual(readFileSync(store.paths().overlay), before);

  writeFileSync(store.paths().overlay, "{broken\n", { mode: 0o600 });
  assert.throws(() => store.read(), /resolver overlay.*corrupt/i);
  assert.equal(readFileSync(store.paths().overlay, "utf8"), "{broken\n");
});

test("commit-before-ack replay at a later clock is byte-identical and does not rewrite", () => {
  const root = tempRoot("replay");
  const first = createResolverOverlayStore({ root, now: () => NOW - 1, pid: 42 });
  const initial = first.read();
  const desired = buildResolverOverlay({ ...OVERLAY_ARGS, previous: initial });
  first.write(desired, {
    expectedPreviousHash: hashResolverOverlay(initial),
    expectedRevision: initial.revision,
  });
  const before = readFileSync(first.paths().overlay);
  utimesSync(first.paths().overlay, new Date(1_000), new Date(1_000));
  const beforeMtime = statSync(first.paths().overlay).mtimeMs;

  const recovered = createResolverOverlayStore({ root, now: () => NOW + 86_400_000, pid: 43 });
  const result = recovered.write(buildResolverOverlay({ ...OVERLAY_ARGS, previous: initial }), {
    expectedPreviousHash: hashResolverOverlay(initial),
    expectedRevision: initial.revision,
  });

  assert.deepEqual(result, {
    changed: false,
    replayed: true,
    hash: hashResolverOverlay(desired),
    revision: desired.revision,
  });
  assert.deepEqual(readFileSync(first.paths().overlay), before);
  assert.equal(statSync(first.paths().overlay).mtimeMs, beforeMtime);
});

const forkOverlayWriter = ({ root, desired, expected, startPath }) => new Promise((resolve, reject) => {
  const moduleURL = new URL("../lib/reconcile-overlay.js", import.meta.url).href;
  const script = `
    import { existsSync } from "node:fs";
    const [moduleURL, root, desiredText, expectedText, startPath] = process.argv.slice(1);
    while (!existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    const { createResolverOverlayStore } = await import(moduleURL);
    const desired = JSON.parse(Buffer.from(desiredText, "base64url").toString("utf8"));
    const expected = JSON.parse(Buffer.from(expectedText, "base64url").toString("utf8"));
    try {
      const result = createResolverOverlayStore({ root, pid: process.pid }).write(desired, expected);
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      process.stderr.write(String(error?.message ?? error));
      process.exitCode = 1;
    }
  `;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script,
    moduleURL, root, encode(desired), encode(expected), startPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code === 0) resolve({ overlay: desired, result: JSON.parse(stdout) });
    else reject(new Error(stderr || `overlay writer exited ${code}`));
  });
});

const deadPID = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--eval", ""]);
  child.once("error", reject);
  child.once("exit", () => resolve(child.pid));
});

test("two writers from one expected revision cannot overwrite each other", async () => {
  const root = tempRoot("writers");
  const store = createResolverOverlayStore({ root, now: () => NOW - 1, pid: 40 });
  const initial = store.read();
  const current = buildResolverOverlay({ ...OVERLAY_ARGS, previous: initial });
  store.write(current, {
    expectedPreviousHash: hashResolverOverlay(initial),
    expectedRevision: initial.revision,
  });

  const luna = authorizedRecord({
    roleKey: "openai:gpt-luna",
    modelID: "gpt-6-luna",
    family: "gpt-luna",
    transitionID: "c".repeat(24),
  });
  const terra = authorizedRecord({
    roleKey: "openai:gpt-terra",
    modelID: "gpt-6-terra",
    family: "gpt-terra",
    transitionID: "d".repeat(24),
  });
  const left = buildResolverOverlay({
    ...OVERLAY_ARGS,
    ledger: authorizedLedger(SOL_RECORD, luna),
    catalogModels: catalogWith(modelMetadata(), modelMetadata("gpt-6-luna", "gpt-luna")),
    previous: current,
    introductionGeneration: 5,
    overlayUpdatedAt: NEXT_INTENT_OVERLAY_UPDATED_AT,
  });
  const right = buildResolverOverlay({
    ...OVERLAY_ARGS,
    ledger: authorizedLedger(SOL_RECORD, terra),
    catalogModels: catalogWith(modelMetadata(), modelMetadata("gpt-6-terra", "gpt-terra")),
    previous: current,
    introductionGeneration: 5,
    overlayUpdatedAt: NEXT_INTENT_OVERLAY_UPDATED_AT,
  });
  const expected = {
    expectedPreviousHash: hashResolverOverlay(current),
    expectedRevision: current.revision,
  };
  const startPath = join(root, "start-writers");
  const pending = [
    forkOverlayWriter({ root, desired: left, expected, startPath }),
    forkOverlayWriter({ root, desired: right, expected, startPath }),
  ];
  writeFileSync(startPath, "go\n", { mode: 0o600 });
  const settled = await Promise.allSettled(pending);

  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(settled.find((result) => result.status === "rejected").reason.message,
    /stale overlay hash|stale overlay revision/);
  const winner = settled.find((result) => result.status === "fulfilled").value;
  assert.deepEqual(readFileSync(store.paths().overlay), bytesOf(winner.overlay));
  assert.equal(statSync(store.paths().root).mode & 0o777, 0o700);
  assert.equal(statSync(store.paths().overlay).mode & 0o777, 0o600);
});

test("custom overlay and lock paths remain private siblings", () => {
  const root = tempRoot("paths");
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const overlay = join(root, "custom-overlay.json");
  const lock = join(root, ".custom-overlay.lock");
  const store = createResolverOverlayStore({ path: overlay, root, lockPath: lock, now: () => NOW });
  assert.deepEqual(store.paths(), { root, overlay, lock });
  const initial = store.read();
  const desired = buildResolverOverlay({ ...OVERLAY_ARGS, previous: initial });
  store.write(desired, {
    expectedPreviousHash: hashResolverOverlay(initial),
    expectedRevision: initial.revision,
  });
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(overlay).mode & 0o777, 0o600);
});

test("a writer sweeps only dead private lock state and its own abandoned temps", async () => {
  const root = tempRoot("stale-private");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dead = await deadPID();
  const uuid = "11111111-1111-4111-8111-111111111111";
  const privateLock = join(root, `.resolver-overlay.lock.${dead}.${uuid}`);
  const owner = { pid: dead, acquiredAt: NOW, uuid };
  mkdirSync(privateLock, { mode: 0o700 });
  writeFileSync(join(privateLock, "owner"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  writeFileSync(join(privateLock, `instance.${dead}.${uuid}`), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  const ownTemp = join(root, `.resolver-overlay.${dead}.${uuid}.tmp`);
  const foreignTemp = join(root, "profile.json.42.tmp");
  writeFileSync(ownTemp, "abandoned\n", { mode: 0o600 });
  writeFileSync(foreignTemp, "foreign\n", { mode: 0o600 });

  const store = createResolverOverlayStore({ root, now: () => NOW - 1 });
  const initial = store.read();
  const desired = buildResolverOverlay({ ...OVERLAY_ARGS, previous: initial });
  store.write(desired, {
    expectedPreviousHash: hashResolverOverlay(initial),
    expectedRevision: initial.revision,
  });

  assert.equal(existsSync(privateLock), false);
  assert.equal(existsSync(ownTemp), false);
  assert.equal(existsSync(foreignTemp), true);
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".resolver-overlay.lock")), []);
});
