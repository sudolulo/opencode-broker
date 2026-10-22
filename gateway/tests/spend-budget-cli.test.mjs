import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { rawPolicy, FINGERPRINT, PROVIDER_ID, ORIGIN, MODEL } from './helpers/spend-fixture.mjs';

test('spend budget CLI module is available', async () => {
  await import('../lib/spend-budget.js');
});

const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['gateway/bin/opencode-broker-spend-budget', ...args], { cwd: '/home/dev/opencode-broker' });
  let stdout = ''; let stderr = '';
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 4000);
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.once('error', cause => { clearTimeout(deadline); reject(cause); });
  child.once('close', code => { clearTimeout(deadline); if (timedOut) reject(new Error('CLI deadline exceeded; child killed and reaped')); else resolve({ code, stdout, stderr }); });
});

async function fixture(action) {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-spend-cli-'));
  try {
    await chmod(dir, 0o700);
    const ledgerPath = join(dir, 'wallet.sqlite'); const policyPath = join(dir, 'policy.json'); const now = Date.now();
    await writeFile(policyPath, JSON.stringify(rawPolicy(ledgerPath, { validUntil: new Date(now + 7200000).toISOString() })), { mode: 0o600 });
    const fund = ['fund', '--policy', policyPath, '--amount-usd', '0.0000003509', '--reference', "synthetic'); DROP TABLE wallet; --", '--confirmed-at', new Date(now - 60000).toISOString(), '--expires-at', new Date(now + 3600000).toISOString(), '--provider-id', PROVIDER_ID, '--origin', ORIGIN, '--credential-sha256', FINGERPRINT, '--confirm-exclusive-promotional-allocation'];
    await action({ dir, ledgerPath, policyPath, fund });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function success(result) {
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const value = JSON.parse(result.stdout);
  for (const key of ['fundedNano', 'availableNano', 'heldNano', 'spentNano', 'observedCostNano', 'additionalLiabilityNano']) assert.match(value[key], /^(0|[1-9]\d*)$/);
  return value;
}
function refusal(result, forbidden = 'SYNTHETIC-RAW-SECRET-SENTINEL') {
  assert.notEqual(result.code, 0); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  const value = JSON.parse(result.stderr); assert.equal(typeof value.error.code, 'string'); assert.equal(typeof value.error.message, 'string');
  assert.ok(!result.stderr.includes(forbidden)); return value;
}

test('CLI synthetic init fund status has exact decimal money and permanently one epoch', { timeout: 20000 }, async () => fixture(async ({ ledgerPath, policyPath, fund }) => {
  refusal(await run(['status', '--policy', policyPath]));
  const init = success(await run(['init', '--policy', policyPath])); assert.equal(init.fundedNano, '0'); assert.equal(init.epochID, null);
  refusal(await run(['init', '--policy', policyPath]));
  const funded = success(await run(fund)); assert.equal(funded.fundedNano, '350'); assert.equal(funded.availableNano, '350');
  assert.deepEqual(success(await run(['status', '--policy', policyPath])), funded);
  const bytes = await readFile(ledgerPath);
  for (const args of [fund, fund.map(v => v === fund[6] ? 'another-reference' : v), ['init', '--policy', policyPath]]) {
    refusal(await run(args)); assert.deepEqual(success(await run(['status', '--policy', policyPath])), funded); assert.deepEqual(await readFile(ledgerPath), bytes);
  }
}));

test('CLI exact flag matrix rejects unknown raw-key duplicate missing and invalid values without funds', { timeout: 30000 }, async () => fixture(async ({ policyPath, fund }) => {
  success(await run(['init', '--policy', policyPath]));
  const baseline = success(await run(['status', '--policy', policyPath]));
  const cases = [
    [], ['nope'], ['status'], ['status', '--policy'], ['status', '--policy', ''],
    ['status', '--policy', policyPath, '--policy', policyPath], ['status', '--policy', policyPath, '--unknown', 'x'],
    ['status', '--policy', policyPath, '--raw-key', 'SYNTHETIC-RAW-SECRET-SENTINEL'],
    ['status', '--policy', policyPath, '--key', 'SYNTHETIC-RAW-SECRET-SENTINEL'],
    ['status', '--policy', policyPath, '--confirm-exclusive-promotional-allocation'],
    [...fund, '--confirm-exclusive-promotional-allocation'], [...fund, '--amount-usd', '1'], [...fund, '--unknown', 'x'],
    fund.map(v => v === '0.0000003509' ? '1e-9' : v), fund.map(v => v === FINGERPRINT ? 'raw-synthetic-value' : v),
    fund.map(v => v === fund[8] ? 'not-a-time' : v),
  ];
  for (let i = 1; i < fund.length; i += 2) cases.push(fund.filter((_, index) => index !== i && index !== i + 1));
  for (const args of cases) {
    refusal(await run(args)); assert.deepEqual(success(await run(['status', '--policy', policyPath])), baseline);
  }
}));

test('CLI corrupt or unrelated existing state is not overwritten and errors never echo source bytes', { timeout: 15000 }, async () => fixture(async ({ ledgerPath, policyPath, fund }) => {
  await writeFile(ledgerPath, 'SYNTHETIC-RAW-SECRET-SENTINEL', { mode: 0o600 });
  for (const args of [['init', '--policy', policyPath], ['status', '--policy', policyPath], fund]) {
    refusal(await run(args)); assert.equal(await readFile(ledgerPath, 'utf8'), 'SYNTHETIC-RAW-SECRET-SENTINEL');
  }
  await writeFile(policyPath, '{"bad":SYNTHETIC-RAW-SECRET-SENTINEL}');
  refusal(await run(['status', '--policy', policyPath]), 'SYNTHETIC');
}));

// Synthetic split policy: the registered paid identity is bound into the policy
// hash, so the offline CLI must name it explicitly; it carries no credential.
async function splitFixture(action) {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-spend-cli-'));
  try {
    await chmod(dir, 0o700);
    const ledgerPath = join(dir, 'wallet.sqlite'); const policyPath = join(dir, 'policy.json'); const now = Date.now();
    const expiresAt = new Date(now + 7 * 86400000).toISOString();
    await writeFile(policyPath, JSON.stringify(rawPolicy(ledgerPath, { ceilingUSD: '200', validUntil: new Date(now + 8 * 86400000).toISOString(),
      allocations: { continuationUSD: '150', manualReserveUSD: '50', releaseWindowHours: 48 } })), { mode: 0o600 });
    const identity = ['--target-id', 'paid-anthropic-target', '--model-id', MODEL];
    const fund = amount => ['fund', '--policy', policyPath, ...identity, '--amount-usd', amount, '--reference', 'synthetic-split', '--confirmed-at', new Date(now - 60000).toISOString(), '--expires-at', expiresAt, '--provider-id', PROVIDER_ID, '--origin', ORIGIN, '--credential-sha256', FINGERPRINT, '--confirm-exclusive-promotional-allocation'];
    await action({ ledgerPath, policyPath, identity, fund, expiresAtMs: Date.parse(expiresAt) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const bucketKeys = ['fundedNano', 'availableNano', 'heldNano', 'spentNano'];

test('CLI split policy reports allocation buckets as exact decimal strings and refuses funding below the reserve', { timeout: 20000 }, async () => splitFixture(async ({ policyPath, identity, fund, expiresAtMs }) => {
  refusal(await run(['init', '--policy', policyPath]));
  const init = success(await run(['init', '--policy', policyPath, ...identity]));
  assert.equal(init.schemaVersion, 2);
  assert.deepEqual(init.registeredIdentity, { targetID: 'paid-anthropic-target', providerID: PROVIDER_ID, modelID: MODEL });
  assert.deepEqual(init.allocations, { continuation: Object.fromEntries(bucketKeys.map(key => [key, '0'])), manualReserve: Object.fromEntries(bucketKeys.map(key => [key, '0'])) });
  assert.deepEqual([init.epochExpiresAtMs, init.reserveUnlockAtMs, init.reserveWindowOpen, init.continuationMayUseReserve], [null, null, false, false]);
  for (const args of [fund('49.999999999'), fund('200.000000001')]) { refusal(await run(args)); assert.deepEqual(success(await run(['status', '--policy', policyPath, ...identity])), init); }
  const funded = success(await run(fund('180')));
  assert.deepEqual(funded.allocations, {
    continuation: { fundedNano: '130000000000', availableNano: '130000000000', heldNano: '0', spentNano: '0' },
    manualReserve: { fundedNano: '50000000000', availableNano: '50000000000', heldNano: '0', spentNano: '0' },
  });
  assert.deepEqual([funded.epochExpiresAtMs, funded.reserveUnlockAtMs, funded.reserveWindowOpen, funded.continuationMayUseReserve], [expiresAtMs, expiresAtMs - 48 * 3600000, false, false]);
  assert.deepEqual(success(await run(['status', '--policy', policyPath, ...identity])), funded);
  refusal(await run(fund('200')));
  for (const args of [['status', '--policy', policyPath, '--target-id', 'other-target', '--model-id', MODEL], ['status', '--policy', policyPath, '--target-id', 'paid-anthropic-target']]) refusal(await run(args));
}));

// A split epoch no longer than its release window would open the protected reserve to
// continuation from the first day, so the operator funding path refuses it statically.
test('CLI split fund refuses an epoch no longer than the release window and funds a longer one', { timeout: 20000 }, async () => splitFixture(async ({ policyPath, identity }) => {
  const init = success(await run(['init', '--policy', policyPath, ...identity]));
  const confirmed = Date.now() - 60000; const window = 48 * 3600000;
  const fundFor = expires => ['fund', '--policy', policyPath, ...identity, '--amount-usd', '180', '--reference', 'synthetic-short-epoch', '--confirmed-at', new Date(confirmed).toISOString(), '--expires-at', new Date(expires).toISOString(), '--provider-id', PROVIDER_ID, '--origin', ORIGIN, '--credential-sha256', FINGERPRINT, '--confirm-exclusive-promotional-allocation'];
  for (const expires of [confirmed + window - 3600000, confirmed + window]) {
    const value = refusal(await run(fundFor(expires)));
    assert.deepEqual(value, { error: { code: 'epoch_shorter_than_release_window', message: 'epoch_shorter_than_release_window' } });
    assert.deepEqual(success(await run(['status', '--policy', policyPath, ...identity])), init);
  }
  const funded = success(await run(fundFor(confirmed + window + 1000)));
  assert.equal(funded.fundedNano, '180000000000');
}));

test('CLI legacy policies refuse split identity flags', { timeout: 10000 }, async () => fixture(async ({ policyPath }) => {
  const init = success(await run(['init', '--policy', policyPath]));
  assert.equal(Object.hasOwn(init, 'registeredIdentity'), false, 'legacy status keys are unchanged');
  refusal(await run(['status', '--policy', policyPath, '--target-id', 'paid-anthropic-target', '--model-id', MODEL]));
}));

test('offline CLI initializes and reports zero without accepting unknown flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-spend-cli-'));
  try {
    await chmod(dir, 0o700);
    const ledgerPath = join(dir, 'wallet.sqlite'); const policyPath = join(dir, 'policy.json');
    await writeFile(policyPath, JSON.stringify(rawPolicy(ledgerPath)), { mode: 0o600 });
    const init = await run(['init', '--policy', policyPath]);
    assert.equal(init.code, 0, init.stderr); assert.equal(JSON.parse(init.stdout).fundedNano, '0');
    const status = await run(['status', '--policy', policyPath]);
    assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).heldNano, '0');
    const refused = await run(['status', '--policy', policyPath, '--raw-key', 'no']);
    assert.notEqual(refused.code, 0); assert.match(refused.stderr, /unknown_flag/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
