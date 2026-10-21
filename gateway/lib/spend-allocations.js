const fail = (code, message = code) => { const error = new Error(message); error.code = code; throw error; };
const money = value => typeof value === 'bigint' && value >= 0n;
const positiveMoney = value => money(value) && value > 0n;
const validTime = value => Number.isSafeInteger(value);

function validateAllocations(allocations) {
  if (!allocations || !positiveMoney(allocations.continuationNano) || !positiveMoney(allocations.manualReserveNano)) fail('invalid_allocation');
  return allocations.continuationNano + allocations.manualReserveNano;
}

export function fundedAllocation({ fundedNano, allocations }) {
  const ceilingNano = validateAllocations(allocations);
  if (!money(fundedNano) || fundedNano > ceilingNano || (fundedNano !== 0n && fundedNano < allocations.manualReserveNano)) fail('invalid_allocation');
  if (fundedNano === 0n) return { continuationFundedNano: 0n, manualReserveFundedNano: 0n };
  return { continuationFundedNano: fundedNano - allocations.manualReserveNano, manualReserveFundedNano: allocations.manualReserveNano };
}

export function allocationDraw({ purpose, reserveNano, continuationAvailableNano, manualReserveAvailableNano, now, expiresAtMs, releaseWindowMs }) {
  if (!['manual', 'continuation'].includes(purpose) || !positiveMoney(reserveNano) || !money(continuationAvailableNano) || !money(manualReserveAvailableNano)
    || !validTime(now) || !validTime(expiresAtMs) || !Number.isSafeInteger(releaseWindowMs) || releaseWindowMs <= 0) fail('invalid_allocation');
  if (now >= expiresAtMs) fail('expired');
  if (purpose === 'manual') {
    if (manualReserveAvailableNano < reserveNano) fail('allocation_exhausted');
    return { continuationReservedNano: 0n, manualReserveReservedNano: reserveNano };
  }
  const continuationReservedNano = continuationAvailableNano < reserveNano ? continuationAvailableNano : reserveNano;
  const remainder = reserveNano - continuationReservedNano;
  if (remainder === 0n) return { continuationReservedNano, manualReserveReservedNano: 0n };
  if (now < expiresAtMs - releaseWindowMs || manualReserveAvailableNano < remainder) fail('allocation_exhausted');
  return { continuationReservedNano, manualReserveReservedNano: remainder };
}

export function allocationRetained({ continuationReservedNano, manualReserveReservedNano, retainedNano }) {
  if (!money(continuationReservedNano) || !money(manualReserveReservedNano) || !money(retainedNano) || retainedNano > continuationReservedNano + manualReserveReservedNano) fail('invalid_allocation');
  const continuationRetainedNano = retainedNano < continuationReservedNano ? retainedNano : continuationReservedNano;
  return { continuationRetainedNano, manualReserveRetainedNano: retainedNano - continuationRetainedNano };
}
