import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";

import {
  RESOLVER_REGISTRY_VERSION,
  createResolverGenerationManager,
  mergeResolverConfig,
} from "../lib/resolver-generations.js";

const NOW = 1_800_000_000_000;
const ZERO_COST = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const FIXTURE = fileURLToPath(new URL("./fixtures/fake-opencode-models.mjs", import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const temp = (label) => {
  const path = mkdtempSync(join(tmpdir(), `resolver-generations-${label}-`));
  roots.push(path);
  return path;
};

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const canonicalHash = (value) => createHash("sha256")
  .update(JSON.stringify(canonical(value)))
  .digest("hex");

const baseConfig = ({ includeIncumbent = true, reordered = false } = {}) => {
  const model = {
    name: "GPT 5.6 Sol",
    limit: { context: 400_000, output: 128_000 },
    cost: { ...ZERO_COST },
  };
  const provider = { models: includeIncumbent ? { "gpt-5.6-sol": model } : {} };
  return reordered
    ? { provider: { openai: provider }, $schema: "https://opencode.ai/config.json" }
    : { $schema: "https://opencode.ai/config.json", provider: { openai: provider } };
};

const overlayForGeneration = (generation = 1) => ({
  version: 1,
  revision: 1,
  updatedAt: NOW - 1,
  entries: {
    "openai/gpt-6-sol": {
      transitionID: "transition-gpt-6-sol",
      revision: "revision-gpt-6-sol",
      authorizationKind: "auto-eligible",
      providerID: "openai",
      modelID: "gpt-6-sol",
      roleKey: "openai:gpt-sol",
      authorizationHash: "a".repeat(64),
      introductionGeneration: generation,
      model: {
        id: "gpt-6-sol",
        name: "GPT 6 Sol",
        family: "gpt-sol",
        release_date: "2026-09-22",
        tool_call: true,
        limit: { context: 1_050_000, output: 128_000 },
        variants: { high: { reasoningEffort: "high" } },
        cost: { ...ZERO_COST },
      },
    },
  },
});

const emptyOverlay = () => ({ version: 1, revision: 0, updatedAt: NOW - 1, entries: {} });

const writeBase = (directory, config = baseConfig(), spacing = 2) => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "base.json");
  writeFileSync(path, `${JSON.stringify(config, null, spacing)}\n`);
  return path;
};

const outputFromConfig = ({ configPath }) => {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  return `${Object.entries(config.provider ?? {}).flatMap(([providerID, provider]) =>
    Object.keys(provider.models ?? {}).map((modelID) => `${providerID}/${modelID}`)).sort().join("\n")}\n`;
};

const setup = (label, options = {}) => {
  const parent = temp(label);
  const root = join(parent, "generations");
  const currentLinkPath = join(root, "current");
  const baseConfigPath = writeBase(join(parent, "input"), options.config ?? baseConfig(), options.spacing);
  const calls = [];
  const runResolver = options.runResolver ?? (async (request) => {
    calls.push(request);
    return outputFromConfig(request);
  });
  const manager = createResolverGenerationManager({
    root,
    currentLinkPath,
    runResolver,
    now: options.now ?? (() => NOW),
    pid: options.pid ?? 7,
  });
  return { parent, root, currentLinkPath, baseConfigPath, calls, manager };
};

const buildArgs = (fixture, overrides = {}) => ({
  reservedGeneration: 1,
  baseConfigPath: fixture.baseConfigPath,
  overlay: overlayForGeneration(1),
  authorizingRevisions: ["rev-1"],
  protectedReferences: [],
  authorizedRetirements: [],
  ...overrides,
});

const bootstrap = async (fixture) => {
  const candidate = await fixture.manager.build(buildArgs(fixture, {
    reservedGeneration: 0,
    bootstrapGeneration0: true,
    overlay: emptyOverlay(),
    authorizingRevisions: [],
  }));
  await fixture.manager.publish(candidate);
  return candidate;
};

test("merge is immutable, adds only validated zero-cost overlay models, and rejects collisions", () => {
  const base = baseConfig();
  const overlay = overlayForGeneration(1);
  const beforeBase = structuredClone(base);
  const beforeOverlay = structuredClone(overlay);
  const merged = mergeResolverConfig(base, overlay);

  assert.equal(merged.provider.openai.models["gpt-6-sol"].name, "GPT 6 Sol");
  assert.deepEqual(base, beforeBase);
  assert.deepEqual(overlay, beforeOverlay);
  merged.provider.openai.models["gpt-6-sol"].name = "changed returned clone";
  assert.equal(overlay.entries["openai/gpt-6-sol"].model.name, "GPT 6 Sol");

  const collisionBase = baseConfig();
  collisionBase.provider.openai.models["gpt-6-sol"] = { name: "base owns this" };
  assert.throws(() => mergeResolverConfig(collisionBase, overlay), /collision.*openai\/gpt-6-sol/i);
  assert.throws(() => mergeResolverConfig(base, {
    ...overlay,
    entries: {
      ...overlay.entries,
      "missing/model": {
        ...overlay.entries["openai/gpt-6-sol"],
        providerID: "missing",
        modelID: "model",
        model: { ...overlay.entries["openai/gpt-6-sol"].model, id: "model" },
      },
    },
  }), /existing provider.*missing|provider.*missing/i);
});

test("merge rejects unsupported overlay fields, deletion syntax, identity mismatch, and nonzero costs", () => {
  const base = baseConfig();
  const cases = [
    (overlay) => { overlay.delete = ["openai/gpt-5.6-sol"]; },
    (overlay) => { overlay.entries["openai/gpt-6-sol"].unsupported = true; },
    (overlay) => { overlay.entries["openai/gpt-6-sol"].model.baseURL = "https://provider.invalid"; },
    (overlay) => { overlay.entries["openai/gpt-6-sol"].model.cost.input = 1; },
    (overlay) => { overlay.entries["openai/gpt-6-sol"].model.id = "different"; },
    (overlay) => { overlay.entries["openai/gpt-6-sol"].providerID = "anthropic"; },
  ];
  for (const mutate of cases) {
    const overlay = overlayForGeneration(1);
    mutate(overlay);
    assert.throws(() => mergeResolverConfig(base, overlay), /unsupported|delet|zero|identity|mismatch|baseURL/i);
  }
});

test("build records exact resolver membership from an isolated scratch XDG config", async () => {
  const fixture = setup("exact", {
    runResolver: async (request) => {
      assert.equal(request.xdgConfigHome.startsWith(fixture.root), true);
      assert.equal(request.env.XDG_CONFIG_HOME, request.xdgConfigHome);
      assert.equal(realpathSync(join(request.xdgConfigHome, "opencode", "opencode.json")), realpathSync(request.configPath));
      assert.match(readFileSync(request.configPath, "utf8"), /gpt-6-sol/);
      return "junk\nopenai/gpt-6-sol\nopenai/gpt-5.6-sol\nopenai/gpt-6-sol\n";
    },
  });
  const candidate = await fixture.manager.build(buildArgs(fixture));

  assert.deepEqual(candidate.manifest.modelKeys, ["openai/gpt-5.6-sol", "openai/gpt-6-sol"]);
  assert.equal(readdirSync(fixture.root).some((name) => name.startsWith(".resolver-xdg.")), false);
  assert.equal(lstatSync(candidate.directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(candidate.directory, "opencode.json")).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(candidate.directory, "manifest.json")).mode & 0o777, 0o600);
});

test("the production resolver adapter runs opencode models --pure in scratch XDG and cleans it", async () => {
  const fixture = setup("adapter", { runResolver: undefined });
  const bin = join(fixture.parent, "bin");
  const record = join(fixture.parent, "record.json");
  mkdirSync(bin);
  const executable = join(bin, "opencode");
  writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH;
  const oldRecord = process.env.FAKE_OPENCODE_RECORD;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.FAKE_OPENCODE_RECORD = record;
  try {
    const manager = createResolverGenerationManager({
      root: fixture.root,
      currentLinkPath: fixture.currentLinkPath,
      now: () => NOW,
      pid: 8,
    });
    const candidate = await manager.build(buildArgs(fixture));
    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert.deepEqual(seen.argv, ["models", "--pure"]);
    assert.equal(seen.xdgConfigHome.startsWith(fixture.root), true);
    assert.deepEqual(candidate.manifest.modelKeys, ["openai/gpt-5.6-sol", "openai/gpt-6-sol"]);
    assert.equal(existsSync(seen.xdgConfigHome), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldRecord === undefined) delete process.env.FAKE_OPENCODE_RECORD;
    else process.env.FAKE_OPENCODE_RECORD = oldRecord;
  }
});

test("canonical effective hashes ignore base object order while manifest hashes cover exact bytes", async () => {
  const left = setup("hash-left", { config: baseConfig(), spacing: 2 });
  const right = setup("hash-right", { config: baseConfig({ reordered: true }), spacing: 4 });
  const leftCandidate = await left.manager.build(buildArgs(left));
  const rightCandidate = await right.manager.build(buildArgs(right));

  assert.equal(leftCandidate.effectiveHash, rightCandidate.effectiveHash);
  assert.notEqual(leftCandidate.manifest.baseHash, rightCandidate.manifest.baseHash);
  const config = JSON.parse(readFileSync(join(leftCandidate.directory, "opencode.json"), "utf8"));
  assert.equal(leftCandidate.effectiveHash, canonicalHash(config));
  assert.equal(leftCandidate.manifestHash, createHash("sha256")
    .update(readFileSync(join(leftCandidate.directory, "manifest.json"))).digest("hex"));
});

test("bootstrap generation zero is base-only and accepted only for a pristine manager", async () => {
  const fixture = setup("bootstrap");
  await assert.rejects(fixture.manager.build(buildArgs(fixture, {
    reservedGeneration: 0,
    bootstrapGeneration0: true,
  })), /generation zero.*empty overlay|bootstrap.*empty overlay/i);
  await assert.rejects(fixture.manager.build(buildArgs(fixture, {
    reservedGeneration: 0,
    overlay: emptyOverlay(),
  })), /bootstrap.*generation zero/i);

  const generation0 = await bootstrap(fixture);
  assert.equal(generation0.generation, 0);
  assert.deepEqual(generation0.manifest.modelKeys, ["openai/gpt-5.6-sol"]);
  await assert.rejects(fixture.manager.build(buildArgs(fixture, {
    reservedGeneration: 0,
    bootstrapGeneration0: true,
    overlay: emptyOverlay(),
  })), /bootstrap.*empty registry|current link|pristine/i);
});

test("new overlay entries must use the reserved introduction generation", async () => {
  const fixture = setup("introduction");
  const overlay = overlayForGeneration(2);
  await assert.rejects(fixture.manager.build(buildArgs(fixture, { overlay })), /introduction generation.*expected 1/i);
});

test("identical effective config reuses current generation without consuming high-water or running resolver", async () => {
  const fixture = setup("reuse");
  const first = await fixture.manager.build(buildArgs(fixture));
  await fixture.manager.publish(first);
  const replay = createResolverGenerationManager({
    root: fixture.root,
    currentLinkPath: fixture.currentLinkPath,
    now: () => NOW + 1,
    pid: 8,
    runResolver: () => { throw new Error("must not run for hash reuse"); },
  });
  const candidate = await replay.build(buildArgs(fixture, { reservedGeneration: 2 }));

  assert.equal(candidate.reused, true);
  assert.equal(candidate.generation, 1);
  assert.equal(replay.readRegistry().highWater, 1);
});

test("orphaned immutable build is recovered only when all durable intent hashes match", async () => {
  const fixture = setup("orphan");
  const first = await fixture.manager.build(buildArgs(fixture));
  const recoveredManager = createResolverGenerationManager({
    root: fixture.root,
    currentLinkPath: fixture.currentLinkPath,
    now: () => NOW + 86_400_000,
    pid: 8,
    runResolver: () => { throw new Error("orphan recovery must not rerun resolver"); },
  });
  const recovered = await recoveredManager.build(buildArgs(fixture));
  assert.equal(recovered.reused, true);
  assert.equal(recovered.manifestHash, first.manifestHash);

  const changedOverlay = overlayForGeneration(1);
  changedOverlay.entries["openai/gpt-6-sol"].authorizationHash = "b".repeat(64);
  await assert.rejects(recoveredManager.build(buildArgs(fixture, { overlay: changedOverlay })), /immutable generation.*mismatch|hash mismatch/i);
});

test("config manifest publication crash preserves current generation", async () => {
  const fixture = setup("publish-crash");
  const generation0 = await bootstrap(fixture);
  const generation1 = await fixture.manager.build(buildArgs(fixture));
  unlinkSync(join(generation1.directory, "manifest.json"));

  await assert.rejects(fixture.manager.publish(generation1), /manifest.*missing|hash mismatch/i);
  assert.equal(fixture.manager.current().generation, generation0.generation);
  assert.equal(fixture.manager.readRegistry().highWater, 0);
});

test("registry-committed current-link crash is recovered by idempotent publication", async () => {
  const fixture = setup("publish-recovery");
  await bootstrap(fixture);
  const generation1 = await fixture.manager.build(buildArgs(fixture));
  const registry = fixture.manager.readRegistry();
  registry.highWater = 1;
  registry.generations[1] = {
    manifestHash: generation1.manifestHash,
    effectiveHash: generation1.effectiveHash,
    createdAt: generation1.manifest.createdAt,
  };
  writeFileSync(fixture.manager.paths().registry, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  assert.equal(fixture.manager.current().generation, 0);

  await fixture.manager.publish(generation1);
  assert.equal(fixture.manager.current().generation, 1);
  assert.equal(readlinkSync(fixture.manager.paths().currentLink), "generation-1");
});

test("publish writes a private registry and atomically replaces current with a relative symlink", async () => {
  const fixture = setup("publish");
  const candidate = await fixture.manager.build(buildArgs(fixture));
  await fixture.manager.publish(candidate);

  assert.equal(lstatSync(fixture.root).mode & 0o777, 0o700);
  assert.equal(lstatSync(fixture.manager.paths().registry).mode & 0o777, 0o600);
  assert.equal(lstatSync(fixture.manager.paths().currentLink).isSymbolicLink(), true);
  assert.equal(readlinkSync(fixture.manager.paths().currentLink), "generation-1");
  assert.equal(readdirSync(fixture.root).some((name) => /^\.current\..*\.tmp$/.test(name)), false);
  assert.equal(existsSync(fixture.manager.paths().lock), false);
});

test("generation lookup returns only a canonical independently verified bundle", async (t) => {
  const ordinary = setup("lookup");
  const built = await ordinary.manager.build(buildArgs(ordinary));
  await ordinary.manager.publish(built);
  assert.deepEqual(ordinary.manager.generation(1), {
    generation: 1,
    directory: built.directory,
    manifest: built.manifest,
    manifestHash: built.manifestHash,
    effectiveHash: built.effectiveHash,
  });
  assert.throws(() => ordinary.manager.generation("../1"), /canonical|escape|generation/i);

  for (const mutation of ["directory-symlink", "manifest-symlink", "config-symlink", "manifest-bytes", "effective-config", "registry-hash"]) {
    await t.test(mutation, async () => {
      const fixture = setup(`lookup-${mutation}`);
      const candidate = await fixture.manager.build(buildArgs(fixture));
      await fixture.manager.publish(candidate);
      if (mutation === "directory-symlink") {
        const backup = `${candidate.directory}.real`;
        renameSync(candidate.directory, backup);
        symlinkSync(backup, candidate.directory);
      } else if (mutation === "manifest-symlink" || mutation === "config-symlink") {
        const name = mutation === "manifest-symlink" ? "manifest.json" : "opencode.json";
        const path = join(candidate.directory, name);
        const backup = `${path}.real`;
        renameSync(path, backup);
        symlinkSync(backup, path);
      } else if (mutation === "manifest-bytes") {
        const path = join(candidate.directory, "manifest.json");
        writeFileSync(path, `${readFileSync(path, "utf8")} `);
      } else if (mutation === "effective-config") {
        const path = join(candidate.directory, "opencode.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.provider.openai.models["gpt-5.6-sol"].name = "tampered";
        writeFileSync(path, `${JSON.stringify(config)}\n`);
      } else {
        const path = fixture.manager.paths().registry;
        const registry = JSON.parse(readFileSync(path, "utf8"));
        registry.generations[1].manifestHash = "f".repeat(64);
        writeFileSync(path, `${JSON.stringify(registry)}\n`);
      }
      assert.throws(() => fixture.manager.generation(1), /canonical|symlink|escape|manifest|effective|registry|hash/i);
    });
  }
});

test("registry loss or high-water regression fails loudly", async () => {
  const fixture = setup("high-water");
  const candidate = await fixture.manager.build(buildArgs(fixture));
  await fixture.manager.publish(candidate);
  const registryPath = fixture.manager.paths().registry;
  unlinkSync(registryPath);
  assert.throws(() => fixture.manager.readRegistry(), /registry.*missing|generation directories.*without registry/i);
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    highWater: 0,
    generations: { 4: { manifestHash: "a".repeat(64), effectiveHash: "b".repeat(64), createdAt: NOW } },
  }));
  assert.throws(() => fixture.manager.readRegistry(), /high-water.*regressed/i);
});

test("stale and concurrent reserved generations cannot replace an immutable winner", async () => {
  const fixture = setup("reserved");
  const reserved = fixture.manager.readRegistry().highWater + 1;
  const winner = await fixture.manager.build(buildArgs(fixture, { reservedGeneration: reserved }));
  await fixture.manager.publish(winner);
  await assert.rejects(fixture.manager.build(buildArgs(fixture, { reservedGeneration: reserved })), /reserved generation.*stale.*expected/i);

  const race = setup("reserved-race", {
    runResolver: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return outputFromConfig(request);
    },
  });
  const otherBase = writeBase(join(race.parent, "other"), {
    ...baseConfig(),
    provider: { openai: { models: { "gpt-5.5-sol": { name: "other", cost: ZERO_COST } } } },
  });
  const results = await Promise.allSettled([
    race.manager.build(buildArgs(race)),
    race.manager.build(buildArgs(race, { baseConfigPath: otherBase })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /immutable generation.*mismatch|reserved generation.*stale/i);
});

test("acquiring the manager lock sweeps only dead private lock construction directories", async () => {
  const fixture = setup("dead-private-lock");
  mkdirSync(fixture.root, { recursive: true });
  const dead = join(fixture.root, ".resolver-generations.lock.999999.dead");
  const live = join(fixture.root, `.resolver-generations.lock.${process.pid}.live`);
  for (const [path, owner] of [
    [dead, { pid: 999999, uuid: "dead" }],
    [live, { pid: process.pid, uuid: "live" }],
  ]) {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "owner"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    writeFileSync(join(path, `instance.${owner.pid}.${owner.uuid}`), "owned\n", { mode: 0o600 });
  }

  await fixture.manager.build(buildArgs(fixture));
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(live), true);
});

test("render start race keeps config and manifest in one resolved directory", async () => {
  const fixture = setup("render-race");
  await bootstrap(fixture);
  const startupDirectory = realpathSync(fixture.manager.paths().currentLink);
  const generation1 = await fixture.manager.build(buildArgs(fixture));
  await fixture.manager.publish(generation1);

  assert.equal(JSON.parse(readFileSync(join(startupDirectory, "manifest.json"))).generation, 0);
  assert.equal(readFileSync(join(startupDirectory, "opencode.json"), "utf8").includes("gpt-6-sol"), false);
});

test("base removal requires the same authorized retirement", async () => {
  const fixture = setup("base-removal");
  await bootstrap(fixture);
  const removedBase = writeBase(join(fixture.parent, "removed"), baseConfig({ includeIncumbent: false }));
  const protectedReferences = [{ roleKey: "openai:gpt-sol", kind: "rollback", modelKey: "openai/gpt-5.6-sol" }];
  const args = buildArgs(fixture, {
    baseConfigPath: removedBase,
    protectedReferences,
  });
  await assert.rejects(fixture.manager.build(args), /protected rollback reference.*gpt-5\.6-sol/i);
  await assert.rejects(fixture.manager.build({
    ...args,
    authorizedRetirements: [{ roleKey: "openai:other", kind: "rollback", modelKey: "openai/gpt-5.6-sol" }],
  }), /protected rollback reference.*gpt-5\.6-sol/i);

  const allowed = await fixture.manager.build({
    ...args,
    authorizedRetirements: protectedReferences,
  });
  assert.equal(allowed.generation, 1);
});

test("generation zero rollback and cleanup retain current and active generations, remove old retired ones, and sweep temps", async () => {
  const fixture = setup("cleanup");
  const generation0 = await bootstrap(fixture);
  const generation1 = await fixture.manager.build(buildArgs(fixture));
  await fixture.manager.publish(generation1);

  const secondOverlay = structuredClone(overlayForGeneration(1));
  secondOverlay.revision = 2;
  secondOverlay.updatedAt = NOW;
  secondOverlay.entries["openai/gpt-7-sol"] = {
    ...structuredClone(secondOverlay.entries["openai/gpt-6-sol"]),
    transitionID: "transition-gpt-7-sol",
    revision: "revision-gpt-7-sol",
    modelID: "gpt-7-sol",
    authorizationHash: "b".repeat(64),
    introductionGeneration: 2,
    model: { ...structuredClone(secondOverlay.entries["openai/gpt-6-sol"].model), id: "gpt-7-sol", name: "GPT 7 Sol" },
  };
  const generation2 = await fixture.manager.build(buildArgs(fixture, {
    reservedGeneration: 2,
    overlay: secondOverlay,
    authorizingRevisions: ["rev-1", "rev-2"],
  }));
  await fixture.manager.publish(generation2);
  await fixture.manager.publish(generation0);
  const old = new Date(NOW - 31 * 86_400_000);
  utimesSync(generation1.directory, old, old);
  utimesSync(generation2.directory, old, old);
  mkdirSync(join(fixture.root, ".generation-9.7.tmp"));
  writeFileSync(join(fixture.root, ".resolver-generations.7.crash.tmp"), "partial", { mode: 0o600 });

  const cleaned = fixture.manager.cleanup({ activeGenerations: new Set([1]) });
  assert.equal(fixture.manager.current().generation, 0);
  assert.equal(existsSync(generation0.directory), true);
  assert.equal(existsSync(generation1.directory), true);
  assert.equal(existsSync(generation2.directory), false);
  assert.deepEqual(cleaned.removedGenerations, [2]);
  assert.deepEqual(cleaned.removedTemp, [".generation-9.7.tmp", ".resolver-generations.7.crash.tmp"]);
  assert.equal(fixture.manager.readRegistry().highWater, 2);
  assert.equal(fixture.manager.readRegistry().generations[2], undefined);
  assert.throws(() => fixture.manager.generation(2), /unknown|cleaned/i);
});

test("cleanup honors an explicit retention age and never cleans generation zero", async () => {
  const fixture = setup("cleanup-age");
  const generation0 = await bootstrap(fixture);
  const generation1 = await fixture.manager.build(buildArgs(fixture));
  await fixture.manager.publish(generation1);
  await fixture.manager.publish(generation0);
  const currentTime = new Date(NOW);
  utimesSync(generation1.directory, currentTime, currentTime);

  const first = fixture.manager.cleanup({ activeGenerations: new Set(), olderThanMs: 10_000 });
  assert.deepEqual(first.removedGenerations, []);
  const second = fixture.manager.cleanup({ activeGenerations: new Set(), olderThanMs: 0 });
  assert.deepEqual(second.removedGenerations, [1]);
  assert.equal(existsSync(generation0.directory), true);
});

test("registry and manifest schemas are versioned and paths expose only manager-owned locations", async () => {
  const fixture = setup("schema");
  const candidate = await fixture.manager.build(buildArgs(fixture));
  await fixture.manager.publish(candidate);
  const registry = fixture.manager.readRegistry();

  assert.equal(RESOLVER_REGISTRY_VERSION, 1);
  assert.deepEqual(Object.keys(registry).sort(), ["generations", "highWater", "version"]);
  assert.equal(registry.version, RESOLVER_REGISTRY_VERSION);
  assert.deepEqual(Object.keys(candidate.manifest).sort(), [
    "authorizingRevisions", "baseHash", "createdAt", "effectiveHash", "generation",
    "modelKeys", "overlayHash", "version",
  ]);
  assert.deepEqual(Object.keys(fixture.manager.paths()).sort(), ["currentLink", "lock", "registry", "root"]);
  assert.equal(dirname(fixture.manager.paths().registry), fixture.root);
});
