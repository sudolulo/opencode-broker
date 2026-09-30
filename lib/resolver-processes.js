// Resolver process registrations are deliberately memory-only. A broker restart drops every
// token, forcing each live OpenCode process to prove its immutable resolver generation again.
import { createHash, randomBytes } from "node:crypto";

const DEFAULT_ACTIVE_MS = 10 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
const MODEL_KEY = /^[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._:-]{1,180}$/;

const isPlainObject = (value) => value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

const normalizeModelKeys = (value, label) => {
  if (!Array.isArray(value)
    || value.some((key) => typeof key !== "string" || !MODEL_KEY.test(key))) {
    throw new Error(`${label} modelKeys must be valid model keys`);
  }
  const sorted = [...value].sort(compareText);
  if (new Set(value).size !== value.length || sorted.join("\0") !== value.join("\0")) {
    throw new Error(`${label} modelKeys must be an exact sorted set`);
  }
  return sorted;
};

const normalizeLoadedRegistry = (value) => {
  if (!isPlainObject(value) || value.version !== 1
    || !Number.isInteger(value.highWater) || value.highWater < 0
    || !isPlainObject(value.generations)) {
    throw new Error("resolver process generation registry is invalid");
  }
  const generations = {};
  for (const [key, entry] of Object.entries(value.generations)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || !isPlainObject(entry) || !SHA256.test(entry.manifestHash)) {
      throw new Error(`resolver process generation registry entry ${key} is invalid`);
    }
    const sourceKeys = entry.modelKeys ?? entry.manifest?.modelKeys;
    generations[key] = {
      manifestHash: entry.manifestHash,
      modelKeys: normalizeModelKeys(sourceKeys, `resolver generation ${key}`),
    };
  }
  return { version: 1, highWater: value.highWater, generations };
};

const sameKeys = (left, right) => left.length === right.length
  && left.every((key, index) => key === right[index]);

export const createResolverProcessRegistry = ({
  loadRegistry,
  loadBaseModelKeys,
  mintToken = () => randomBytes(32).toString("base64url"),
  now = Date.now,
  activeMs = DEFAULT_ACTIVE_MS,
} = {}) => {
  if (typeof loadRegistry !== "function") throw new Error("resolver process loadRegistry is required");
  if (typeof loadBaseModelKeys !== "function") throw new Error("resolver process loadBaseModelKeys is required");
  if (typeof mintToken !== "function") throw new Error("resolver process mintToken is required");
  if (typeof now !== "function") throw new Error("resolver process now is required");
  if (!Number.isFinite(activeMs) || activeMs <= 0) throw new Error("resolver process activeMs must be positive");

  // Keys are SHA-256 token digests. The plaintext token exists only in the response that minted it.
  const registrations = new Map();

  const baseOnly = (reason, modelKey) => {
    const modelKeys = normalizeModelKeys(loadBaseModelKeys(), "base resolver");
    return {
      generation: 0,
      manifestHash: null,
      modelKeys,
      compatible: modelKey === undefined ? true : modelKeys.includes(modelKey),
      reason,
    };
  };

  const registrationFallback = (reason) => {
    const fallback = baseOnly(reason);
    return {
      resolverToken: null,
      scope: "base-only",
      generation: fallback.generation,
      manifestHash: fallback.manifestHash,
      modelKeys: fallback.modelKeys,
      reason,
    };
  };

  const findGeneration = (registry, generation, { previouslyRegistered = false } = {}) => {
    if (generation > registry.highWater) return { reason: "future-generation" };
    const record = registry.generations[String(generation)];
    if (!record) return { reason: previouslyRegistered ? "cleaned-generation" : "unknown-generation" };
    return { record };
  };

  const register = (request = {}) => {
    if (!isPlainObject(request)) return registrationFallback("invalid-registration");
    if (request.rawBase === true) return registrationFallback("raw-base");
    if (!Number.isInteger(request.generation) || request.generation < 0
      || !SHA256.test(request.manifestHash ?? "") || !Array.isArray(request.modelKeys)) {
      return registrationFallback("invalid-registration");
    }

    const registry = normalizeLoadedRegistry(loadRegistry());
    const found = findGeneration(registry, request.generation);
    if (!found.record) return registrationFallback(found.reason);
    if (found.record.manifestHash !== request.manifestHash) return registrationFallback("manifest-mismatch");

    let suppliedKeys;
    try {
      suppliedKeys = normalizeModelKeys(request.modelKeys, "resolver registration");
    } catch {
      return registrationFallback("manifest-membership-mismatch");
    }
    if (!sameKeys(found.record.modelKeys, suppliedKeys)) {
      return registrationFallback("manifest-membership-mismatch");
    }

    const resolverToken = mintToken();
    if (typeof resolverToken !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(resolverToken)) {
      throw new Error("resolver process mintToken returned an invalid opaque token");
    }
    const at = now();
    if (!Number.isFinite(at)) throw new Error("resolver process clock returned an invalid time");
    const hash = tokenHash(resolverToken);
    if (registrations.has(hash)) throw new Error("resolver process mintToken returned a duplicate token");
    const record = {
      generation: request.generation,
      manifestHash: found.record.manifestHash,
      modelKeys: [...found.record.modelKeys],
      registeredAt: at,
      touchedAt: at,
      expiresAt: at + activeMs,
    };
    registrations.set(hash, record);
    return {
      resolverToken,
      scope: "ordinary",
      generation: record.generation,
      manifestHash: record.manifestHash,
      modelKeys: [...record.modelKeys],
      expiresAt: record.expiresAt,
    };
  };

  const authorize = ({ resolverToken, modelKey } = {}) => {
    if (resolverToken === undefined || resolverToken === null || resolverToken === "") {
      return baseOnly("missing-token", modelKey);
    }
    if (typeof resolverToken !== "string") return baseOnly("invalid-token", modelKey);
    const hash = tokenHash(resolverToken);
    const registered = registrations.get(hash);
    if (!registered) return baseOnly("invalid-token", modelKey);
    const at = now();
    if (!Number.isFinite(at)) throw new Error("resolver process clock returned an invalid time");
    if (at >= registered.expiresAt) {
      registrations.delete(hash);
      return baseOnly("expired-token", modelKey);
    }

    const registry = normalizeLoadedRegistry(loadRegistry());
    const found = findGeneration(registry, registered.generation, { previouslyRegistered: true });
    if (!found.record) {
      registrations.delete(hash);
      return baseOnly(found.reason, modelKey);
    }
    if (found.record.manifestHash !== registered.manifestHash
      || !sameKeys(found.record.modelKeys, registered.modelKeys)) {
      registrations.delete(hash);
      return baseOnly("manifest-mismatch", modelKey);
    }

    registered.touchedAt = at;
    registered.expiresAt = at + activeMs;
    return {
      generation: registered.generation,
      manifestHash: registered.manifestHash,
      modelKeys: [...registered.modelKeys],
      compatible: modelKey === undefined ? true : registered.modelKeys.includes(modelKey),
      reason: null,
    };
  };

  const touch = (resolverToken) => authorize({ resolverToken });

  const status = () => {
    const at = now();
    for (const [hash, record] of registrations) {
      if (at >= record.expiresAt) registrations.delete(hash);
    }
    const records = [...registrations.values()]
      .sort((left, right) => left.generation - right.generation || left.registeredAt - right.registeredAt)
      .map((record) => ({ ...record, modelKeys: [...record.modelKeys] }));
    const generations = {};
    for (const record of records) generations[record.generation] = (generations[record.generation] ?? 0) + 1;
    return { active: records.length, generations, registrations: records };
  };

  const clear = () => registrations.clear();

  return { register, authorize, touch, status, clear };
};
