import { normalizeSpendPolicy, prepareSpendAttempt } from '../../lib/spend-policy.js';
import { reserveAttempt } from '../../lib/spend-budget.js';
import { bodyFor, headersFor, NOW, PROVIDER_ID, ORIGIN, FINGERPRINT } from './spend-fixture.mjs';

const [mode, ledgerPath, attemptID] = process.argv.slice(2);
let policy;
let rawPolicy;
let started = false;
const send = message => new Promise((resolve, reject) => process.send(message, cause => cause ? reject(cause) : resolve()));
async function gatewayDeathBarrier() {
  let actualSends = 0;
  let moduleMock;
  if (mode === 'gateway-before-send') {
    const { mock } = await import('node:test');
    const realLedger = await import('../../lib/spend-budget.js');
    moduleMock = mock.module('../../lib/spend-budget.js', { exports: { ...realLedger,
      reserveAttempt: async args => {
        const reservation = await realLedger.reserveAttempt(args);
        // Test-only barrier AFTER the real durable reservation returned. The
        // production handler has no mutation/testing hook between reserve/send.
        await send({ type: 'committed', actualSends, attemptID: reservation.attemptID });
        await new Promise(() => {}); // Parent owns SIGKILL and reaping via IPC.
        return reservation;
      },
    } });
  }
  const { makeHarness } = await import('./spend-gateway-fixture.mjs');
  const harness = await makeHarness({ ledgerPath, policyOverrides: rawPolicy,
    fetchImpl: async () => {
      actualSends++;
      await send({ type: 'entered', actualSends });
      await new Promise(() => {}); // Simulated in-flight send; never network.
    },
  });
  try { await harness.send(); }
  finally { await harness.close(); moduleMock?.restore(); }
}
process.on('message', async message => {
  try {
    if (message.type === 'policy' && !policy) { rawPolicy = message.raw; policy = normalizeSpendPolicy(message.raw); await send({ type: 'ready' }); return; }
    if (message.type !== 'go' || !policy || started || !['reserve', 'reserve-then-wait', 'gateway-before-send', 'gateway-after-send'].includes(mode)) return;
    started = true;
    if (mode.startsWith('gateway-')) { await gatewayDeathBarrier(); return; }
    const prepared = prepareSpendAttempt({ policy, providerID: PROVIDER_ID, url: `${ORIGIN}/v1/messages`, body: bodyFor(), headers: headersFor(), credentialFingerprint: FINGERPRINT, now: NOW });
    await reserveAttempt({ ledgerPath, policy, prepared, attemptID, now: NOW });
    await send({ type: mode === 'reserve-then-wait' ? 'committed' : 'result', ok: true });
    // The live IPC channel is the barrier, not a timer or a network request.
    if (mode === 'reserve-then-wait') return;
  } catch (error) { await send({ type: 'result', ok: false, code: error.code ?? 'worker_error' }); }
  process.disconnect();
});
