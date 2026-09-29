// Evidence collection: the deterministic wrapper around one read-only research job.
//
// THE PROCESS BOUNDARY IS THE POINT. The researcher is a language model, so everything it
// produces is untrusted input. This module is what makes that safe to act on:
//   - it runs through the FLEET GATEWAY (`opencode run --agent researcher --model
//     fleet-gateway/smart`), never a provider API and never `claude -p`, because the broker can
//     only schedule what it can see;
//   - the child gets a SCRUBBED environment -- six named variables, and anything that looks like
//     a credential is dropped even if it is one of them -- and no credential in its argv;
//   - the child has NO write path into the ledger. Its only channel is stdout, parsed by this
//     process as exactly one JSON object and validated against the claimed request before a
//     single byte is stored;
//   - a payload quoting a forbidden string (the deployment's Gitea write token) is refused
//     outright. The wrapper holds that token so it can make that comparison; the model never
//     sees it.
//
// What is NOT claimed: the researcher is not filesystem-isolated. The `researcher` agent carries
// unrestricted read/glob/grep and runs as the same user as the broker, so no file mode hides
// anything from it. The compensating controls are that the token is write-scoped to issues on one
// repository and that a payload containing it is refused.
//
// THE LOCK IS NEVER HELD ACROSS THE SUBPROCESS. Claiming, failing and ingesting are three short
// locked writes around a job that may run for twenty minutes; holding the ledger lock for that
// long would block every other writer, including the dry run.
import { spawnSync } from "node:child_process";

import { CONFIG } from "./config.js";
import {
  POLICY_CLAIM_TYPES,
  SUPPORTING_CLAIM_TYPES,
  allowedEvidenceDomains,
  claimEvidenceRequest,
  expireEvidenceClaims,
  ingestEvidence,
  parseEvidencePayload,
  recordEvidenceFailure,
} from "./reconcile-evidence.js";

// Twenty minutes: a real documentation search runs several fetches, and the claim lease
// (EVIDENCE_CLAIM_LEASE_MS, 30 minutes) has to outlast it or a second collector could take the
// request out from under a job that is still working.
export const EVIDENCE_JOB_TIMEOUT_MS = 20 * 60_000;

export const EVIDENCE_COMMAND = "opencode";
export const DEFAULT_EVIDENCE_MODEL = "fleet-gateway/smart";

// The only environment the child is given. An allowlist rather than a denylist: a new
// credential-shaped variable in the parent environment must not become a new leak here just
// because nobody added it to a pattern.
const RESEARCHER_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "LANG", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
]);
const CREDENTIAL_NAME = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i;

const POLICY_CLAIM_MEANING = Object.freeze({
  successor: "the provider states this model replaces the model currently in use for the role",
  "recommended-replacement": "the provider recommends moving from that model to this one",
  "new-role": "the provider presents this model as a new line, not a replacement for anything",
  "role-change": "the provider states the role itself has changed or been retired",
});

// argv only, never a shell string: the prompt is appended by the caller as one argument, so no
// quoting, no word splitting, and nothing in it can become a command.
export const researcherArgv = ({ model = DEFAULT_EVIDENCE_MODEL } = {}) => [
  "run", "--agent", "researcher", "--model", model,
];

export const researcherEnv = (source = process.env) => {
  const env = {};
  for (const key of RESEARCHER_ENV_KEYS) {
    // Belt and braces: the allowlist already excludes every credential-shaped name, but the
    // filter keeps that true if the allowlist ever grows.
    if (CREDENTIAL_NAME.test(key)) continue;
    const value = source?.[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  return env;
};

// Takes the RESOLVED domain list, not a role: an unknown-role candidate has no matched role and
// must still be collectable against its provider's domain union.
export const buildEvidencePrompt = (claim, { allowedDomains = [] } = {}) => {
  if (!claim || typeof claim !== "object") throw new Error("an evidence prompt needs a claimed request");
  const domains = [...allowedDomains];
  const incumbent = claim.incumbentModelID ?? null;
  const shape = JSON.stringify({
    providerID: claim.providerID,
    candidateModelID: claim.candidateModelID,
    incumbentModelID: incumbent,
    roleID: claim.roleID ?? null,
    claims: [{
      claimType: "<one of the claim types listed above>",
      sourceURL: "<https URL on an allowed domain>",
      exactQuote: "<10 to 1000 characters copied verbatim from that page>",
      retrievedAt: "<ISO 8601 timestamp, for example 2026-09-29T00:00:00Z>",
    }],
  }, null, 2);

  return [
    "Collect official provider documentation about one model. You are read-only: change nothing,",
    "write no files, and ask no questions -- there is nobody to answer them.",
    "",
    `Provider: ${claim.providerID}`,
    `Candidate model ID: ${claim.candidateModelID}`,
    incumbent
      ? `Model currently in use for this role: ${incumbent}`
      : "No model is currently in use for this candidate; it is unmapped.",
    claim.roleID ? `Role ID: ${claim.roleID}` : "Role ID: none, this candidate is not mapped to a role.",
    "",
    domains.length
      ? `Use ONLY pages served over https on these domains, or their subdomains: ${domains.join(", ")}.`
      : "No evidence domain is allowed for this candidate, so report no claims at all.",
    "A page on any other domain is not acceptable evidence, however authoritative it looks, and a",
    "claim sourced from one will be discarded along with the rest of your answer.",
    "",
    "Report a claim only when the page states it about this exact model ID. These four decide policy:",
    ...POLICY_CLAIM_TYPES.map((claimType) => `  ${claimType}: ${POLICY_CLAIM_MEANING[claimType]}`),
    `These are stored as supporting quotes and decide nothing: ${SUPPORTING_CLAIM_TYPES.join(", ")}.`,
    "",
    "A newer release date is NOT evidence of succession, and neither is a benchmark, a blog",
    "roundup or your own judgement. Omit any claim you cannot support with a verbatim quote from",
    "an allowed page. Reporting no claims is a correct and useful answer.",
    "At most ten claims are kept.",
    "",
    "Print exactly one JSON object on stdout and nothing else: no prose before or after it, no",
    "markdown code fence, no explanation. Keep the identity fields exactly as given here:",
    shape,
  ].join("\n");
};

const failureMessage = (error) => {
  const message = String(error?.message ?? error ?? "unknown error").trim();
  return message === "" ? "unknown error" : message;
};

export const collectEvidenceOnce = ({
  store,
  roles = CONFIG.modelRoles,
  spawn = spawnSync,
  now = Date.now,
  pid = process.pid,
  model = DEFAULT_EVIDENCE_MODEL,
  timeoutMs = EVIDENCE_JOB_TIMEOUT_MS,
  forbiddenStrings = [],
} = {}) => {
  if (!store || typeof store.update !== "function" || typeof store.read !== "function") {
    throw new Error("evidence collection needs a reconciliation store");
  }
  const nothingDue = { collected: false, reason: "nothing-due", transitionID: null, accepted: 0 };

  // An unlocked pre-check, and not only for speed: store.update() CREATES the ledger, so taking
  // the writer lock with nothing queued would leave reconciliation state on a host that has
  // never reconciled, and `status` would report a run that never happened. A request queued
  // between this read and the next run is simply picked up then.
  if (!Object.keys(store.read().evidenceRequests ?? {}).length) return nothingDue;

  let claim = null;
  store.update((state) => {
    const expired = expireEvidenceClaims(state, { now });
    const claimed = claimEvidenceRequest(expired, { now, pid });
    claim = claimed.claim;
    return claimed.state;
  });
  if (!claim) return nothingDue;

  const fail = (error) => {
    const reason = failureMessage(error);
    // Recorded against the request the collector actually holds, so the attempt count and the
    // retry cooldown are real rather than inferred from a missing result.
    store.update((state) => recordEvidenceFailure(state, claim.transitionID, { error: reason, now }));
    return { collected: false, reason, transitionID: claim.transitionID, accepted: 0 };
  };

  const prompt = buildEvidencePrompt(claim, {
    // Resolved from the request, never from a role the request may not have.
    allowedDomains: allowedEvidenceDomains(claim, roles),
  });

  let child;
  try {
    child = spawn(EVIDENCE_COMMAND, [...researcherArgv({ model }), prompt], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: researcherEnv(process.env),
      // stdin closed: the researcher is not interactive, and a child that blocked on a prompt
      // would hold the claim for its whole lease and then time out with nothing to show.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return fail(error);
  }

  if (!child || typeof child !== "object") return fail(new Error("the research job produced no result"));
  // spawnSync reports a timeout, an ENOENT and a kill as `error`/`signal` with a null status, so
  // these are checked before the exit code rather than after it.
  if (child.error) return fail(child.error);
  if (child.signal) return fail(new Error(`the research job was killed by ${child.signal}`));
  if (child.status !== 0) {
    const stderr = String(child.stderr ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
    return fail(new Error(`the research job exited ${String(child.status)}${stderr ? `: ${stderr}` : ""}`));
  }

  let accepted = 0;
  try {
    const payload = parseEvidencePayload(child.stdout);
    store.update((state) => {
      // forbiddenStrings is passed THROUGH: ingestEvidence can only refuse a leaked credential
      // if the caller hands it one, so dropping it here would make the control decoration.
      const result = ingestEvidence(state, claim.transitionID, payload, { roles, now, forbiddenStrings });
      accepted = result.accepted;
      return result.state;
    });
  } catch (error) {
    // Nothing partial is stored: the mutator threw, so store.update() wrote nothing at all, and
    // the request survives to be retried after its cooldown.
    return fail(error);
  }

  return { collected: true, reason: null, transitionID: claim.transitionID, accepted };
};
