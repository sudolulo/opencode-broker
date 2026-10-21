import test from 'node:test';
import assert from 'node:assert/strict';
import { allocationDraw, allocationRetained, fundedAllocation } from '../lib/spend-allocations.js';

const N = 1_000_000_000n;
const E = Date.parse('2026-10-28T12:00:00.000Z');
const W = 48 * 3_600_000;

test('protected remainder is unavailable one ms before unlock', () => {
  assert.throws(() => allocationDraw({ purpose: 'continuation', reserveNano: N,
    continuationAvailableNano: 0n, manualReserveAvailableNano: 50n * N,
    now: E - W - 1, expiresAtMs: E, releaseWindowMs: W }), { code: 'allocation_exhausted' });
});

test('unlock is inclusive and continuation uses normal first', () => {
  assert.deepEqual(allocationDraw({ purpose: 'continuation', reserveNano: 3n * N,
    continuationAvailableNano: N, manualReserveAvailableNano: 50n * N,
    now: E - W, expiresAtMs: E, releaseWindowMs: W }),
  { continuationReservedNano: N, manualReserveReservedNano: 2n * N });
  assert.deepEqual(allocationRetained({ continuationReservedNano: N,
    manualReserveReservedNano: 2n * N, retainedNano: 2n * N }),
  { continuationRetainedNano: N, manualReserveRetainedNano: N });
  assert.deepEqual(allocationDraw({ purpose: 'continuation', reserveNano: N,
    continuationAvailableNano: 0n, manualReserveAvailableNano: N,
    now: E - W + 1, expiresAtMs: E, releaseWindowMs: W }),
  { continuationReservedNano: 0n, manualReserveReservedNano: N });
});

test('manual draws protected funds only and expiry is exclusive', () => {
  assert.deepEqual(allocationDraw({ purpose: 'manual', reserveNano: N, continuationAvailableNano: 99n * N,
    manualReserveAvailableNano: N, now: E - 1, expiresAtMs: E, releaseWindowMs: W }),
  { continuationReservedNano: 0n, manualReserveReservedNano: N });
  assert.throws(() => allocationDraw({ purpose: 'manual', reserveNano: N, continuationAvailableNano: 99n * N,
    manualReserveAvailableNano: 0n, now: E - 1, expiresAtMs: E, releaseWindowMs: W }), { code: 'allocation_exhausted' });
  assert.throws(() => allocationDraw({ purpose: 'continuation', reserveNano: N, continuationAvailableNano: N,
    manualReserveAvailableNano: 0n, now: E, expiresAtMs: E, releaseWindowMs: W }), { code: 'expired' });
});

test('funding protects the full reserve and arithmetic rejects non-BigInt or unsafe time', () => {
  assert.deepEqual(fundedAllocation({ fundedNano: 175n * N, allocations: { continuationNano: 150n * N, manualReserveNano: 50n * N } }),
    { continuationFundedNano: 125n * N, manualReserveFundedNano: 50n * N });
  assert.deepEqual(fundedAllocation({ fundedNano: 0n, allocations: { continuationNano: 150n * N, manualReserveNano: 50n * N } }),
    { continuationFundedNano: 0n, manualReserveFundedNano: 0n });
  assert.throws(() => fundedAllocation({ fundedNano: 49n * N, allocations: { continuationNano: 150n * N, manualReserveNano: 50n * N } }));
  assert.throws(() => allocationDraw({ purpose: 'continuation', reserveNano: 1, continuationAvailableNano: 1n,
    manualReserveAvailableNano: 0n, now: NaN, expiresAtMs: E, releaseWindowMs: W }));
  assert.throws(() => allocationRetained({ continuationReservedNano: N, manualReserveReservedNano: 0n, retainedNano: 2n * N }));
});
