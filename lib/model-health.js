import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sameSecret = (left, right) => typeof left === 'string' && typeof right === 'string'
  && timingSafeEqual(Buffer.from(hash(left), 'hex'), Buffer.from(hash(right), 'hex'));
const SPEEDS = ['fast', 'standard'];

export function createHealthAuthority({ gatewayCredential, now = Date.now, randomBytes = cryptoRandomBytes, lookupLease, lookupGeneration, latestFailureAt, verifyAttestation }) {
  const tickets = new Map();
  let closed = false;
  const exactKeys = (input, allowed) => {
    if (!input || Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('unexpected fields');
  };
  const validateTerminal = (terminal) => {
    if (!Number.isInteger(terminal.status)) throw new Error('terminal status');
    const noResponse = terminal.status === 0 && ((terminal.state === 'invalid' && terminal.errorClass === 'network')
      || (terminal.state === 'cancelled' && terminal.errorClass === null));
    if (!noResponse && (terminal.status < 100 || terminal.status > 599)) throw new Error('terminal status');
    if (![null, 'service', 'auth', 'rate', 'quota', 'network', 'validation'].includes(terminal.errorClass)) {
      throw new Error('terminal error class');
    }
    // Optional ACTUAL upstream usage.speed, as parsed from the response by the gateway.
    if (Object.hasOwn(terminal, 'speed') && !SPEEDS.includes(terminal.speed)) throw new Error('terminal speed');
  };
  const authenticate = (input) => {
    if (closed || !sameSecret(input.gatewayCredential, gatewayCredential)) throw new Error('private authentication');
  };
  const prune = () => {
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(key);
  };

  return {
    issue(input) {
      authenticate(input);
      prune();
      if (tickets.size >= 4096) throw new Error('capability capacity');
      exactKeys(input, ['gatewayCredential', 'sessionID', 'leaseID', 'requestID', 'attemptID', 'purpose', 'modelID', 'bodySHA256', 'speed']);
      if (Object.hasOwn(input, 'speed') && !SPEEDS.includes(input.speed)) throw new Error('issuance fields');
      const assignment = lookupLease(input);
      if (!assignment?.held || assignment.sessionID !== input.sessionID || assignment.leaseID !== input.leaseID
        || assignment.purpose !== input.purpose || assignment.wireModelID !== input.modelID
        || !['real', 'outage-health'].includes(input.purpose)) throw new Error('assignment');
      // input.speed is the gateway's assertion of the FINAL body's speed (bound by bodySHA256). A
      // fast scope must have asked for fast, so no base-only request can hold a fast ticket; a
      // standard scope must not have. It is request intent only, never response proof.
      if (assignment.expectedScopePolicy?.speed === 'fast' ? input.speed !== 'fast' : input.speed === 'fast') throw new Error('speed scope');
      if (typeof input.bodySHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.bodySHA256) || !['requestID', 'attemptID'].every((key) => typeof input[key] === 'string' && input[key].length > 0 && input[key].length <= 512)) throw new Error('issuance fields');
      if ((assignment.purpose === 'outage-health' || assignment.targetID !== assignment.primaryID) && !assignment.expectedCredentialInstance) throw new Error('reserve/probe assertion');
      // An outage assignment buys exactly one isolated upstream attempt, so it holds at most one
      // capability: a second ticket (new nonce, new capability) could commit a later unknown or
      // fault over the first ticket's proof while the probe is still live. Checked only after every
      // validation above, so a refused begin never burns the assignment. The scan is bounded by the
      // 4096 ticket cap, and a ticket (2h) outlives its assignment (10s), so pruning can never lift
      // the guard while the assignment is live. Ordinary real leases need a capability per attempt.
      if (assignment.purpose === 'outage-health') {
        for (const ticket of tickets.values()) {
          if (ticket.purpose === 'outage-health' && ticket.leaseID === assignment.leaseID && ticket.sessionID === assignment.sessionID) {
            throw new Error('outage capability reuse');
          }
        }
      }
      const capability = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const startedAt = now();
      const generation = lookupGeneration(assignment.logicalID);
      const key = hash(capability);
      if (tickets.has(key)) throw new Error('entropy collision');
      tickets.set(key, { ...structuredClone(assignment), requestID: input.requestID, attemptID: input.attemptID,
        bodySHA256: input.bodySHA256, startedAt, generation, nonce, assignmentExpiresAt: assignment.expiresAt ?? null,
        expiresAt: startedAt + 7200000, receipt: null });
      return { capability, startedAt, generation, nonce };
    },

    accept(input) {
      authenticate(input);
      prune();
      const ticket = tickets.get(hash(input.capability ?? ''));
      if (!ticket) throw new Error('unknown capability');
      exactKeys(input, ['gatewayCredential', 'capability', 'context', 'contextSignature', 'attestation', 'attestationSignature', 'terminal', 'finishedAt']);
      exactKeys(input.terminal, ['api', 'state', 'status', 'errorClass', 'speed']);
      validateTerminal(input.terminal);
      const { request, attestation } = verifyAttestation(input, ticket);
      const digest = hash(JSON.stringify([input.context, input.contextSignature, input.attestation, input.attestationSignature, input.terminal, input.finishedAt]));
      if (ticket.receipt) {
        if (ticket.receipt.digest !== digest) throw new Error('changed replay');
        return { ok: true, duplicate: ticket.receipt.applied, leaseID: ticket.leaseID,
          outcome: ticket.receipt.applied ? null : structuredClone(ticket.receipt.outcome) };
      }
      if (request[1] !== ticket.nonce || request[2] !== ticket.startedAt || request[4] !== ticket.requestID
        || request[5] !== ticket.attemptID || request[6] !== ticket.purpose || request[7] !== ticket.providerID
        || request[8] !== ticket.wireModelID || request[9] !== ticket.bodySHA256
        || request[10] !== ticket.expectedCredentialInstance) throw new Error('request binding');
      if (request[3] <= request[2] || request[3] - request[2] > 30000 || ticket.generation !== lookupGeneration(ticket.logicalID)) throw new Error('generation/time');
      if (!Number.isSafeInteger(input.finishedAt) || input.finishedAt < ticket.startedAt || input.finishedAt > now()
        || ticket.startedAt < (latestFailureAt(ticket.logicalID, attestation[5]) ?? 0)) throw new Error('outcome ordering');
      if (ticket.purpose === 'outage-health' && input.finishedAt > Math.min(ticket.startedAt + 10000, ticket.assignmentExpiresAt ?? Infinity)) throw new Error('probe outcome deadline');
      const policy = ticket.expectedScopePolicy;
      if ([attestation[6], attestation[8], attestation[9], attestation[10]].some((value, index) => value !== [policy.connectionID, policy.authMode, policy.transport, policy.product][index])) throw new Error('actual route');
      if (attestation[7] !== (ticket.providerID === 'anthropic' ? 'https://api.anthropic.com' : 'https://chatgpt.com')) throw new Error('actual upstream');
      const origin = attestation[11];
      const status = attestation[12];
      const terminal = input.terminal;
      if (terminal.api !== policy.transport && !(policy.transport === 'messages' && terminal.api === 'chat')) throw new Error('terminal transport');
      if (!['complete', 'http-error', 'stream-error', 'invalid', 'cancelled'].includes(terminal.state)) throw new Error('terminal shape');
      if (ticket.expectedCredentialInstance && attestation[5] !== ticket.expectedCredentialInstance && origin !== 'proxy-scope') throw new Error('actual credential mismatch');
      let result = 'unknown';
      if (origin === 'proxy-scope') result = 'scope-mismatch';
      else if (attestation[5] && origin === 'upstream-response' && status >= 200 && status < 300
        && terminal.status === status && terminal.state === 'complete' && terminal.errorClass === null
        // HTTP success is not fast proof: some models silently serve standard. A fast scope needs the
        // response's own usage.speed fast; a standard scope that actually ran fast is mislabeled.
        // Both stay a durable unknown (diagnostic, never baseline or recovery).
        && (policy.speed === 'fast' ? terminal.speed === 'fast' : terminal.speed !== 'fast')) result = 'success';
      else if (attestation[5] && origin === 'upstream-http' && terminal.state === 'http-error' && terminal.status === status) {
        if (terminal.errorClass === 'service' && (status >= 500 || status === 429)) result = 'service-fault';
        if (terminal.errorClass === 'auth' && (status === 401 || status === 403)) result = 'auth-fault';
      }
      const outcome = { type: 'outcome', logicalID: ticket.logicalID, primaryID: ticket.primaryID, targetID: ticket.targetID,
        providerID: ticket.providerID, modelID: ticket.modelID, requestID: ticket.requestID, attemptID: ticket.attemptID,
        purpose: ticket.purpose, generation: ticket.generation, credentialInstance: attestation[5], expectedCredentialInstance: ticket.expectedCredentialInstance,
        connectionID: attestation[6],
        upstreamOrigin: attestation[7], authMode: attestation[8], transport: attestation[9], product: attestation[10],
        failureOrigin: origin, upstreamStatus: status, result, startedAt: ticket.startedAt, finishedAt: input.finishedAt };
      ticket.receipt = { digest, outcome, applied: false };
      return { ok: true, duplicate: false, leaseID: ticket.leaseID, outcome: structuredClone(outcome) };
    },

    markApplied(capability) {
      const ticket = tickets.get(hash(capability));
      if (!ticket?.receipt) throw new Error('unknown receipt');
      ticket.receipt.applied = true;
    },

    close() {
      closed = true;
      tickets.clear();
    },
  };
}
