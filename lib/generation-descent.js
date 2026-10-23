// Walk configured reserve chains without changing their declared precedence. Callers
// apply their own eligibility gates; this helper only represents configuration order.
export function orderedReserveDescent(primaryIDs, mappings) {
  if (!Array.isArray(primaryIDs) || !mappings || typeof mappings !== "object") return [];

  const descent = [];
  for (const primaryID of primaryIDs) {
    const reserves = mappings[primaryID];
    if (!Array.isArray(reserves)) continue;
    reserves.forEach((targetID, rank) => descent.push({ primaryID, targetID, rank }));
  }
  return descent;
}
