export function createRedirectTransfer(previousObservation, currentOwner, observedAt, repository) {
  if (
    !previousObservation?.owner
    || previousObservation.owner.toLowerCase() === currentOwner.toLowerCase()
  ) return null;

  return {
    fromOwner: previousObservation.owner,
    toOwner: currentOwner,
    notBefore: previousObservation.observedAt || null,
    observedAt,
    repository,
    source: 'redirect',
  };
}

export function legacyOwnerTransfers(entries, currentOwner, repository) {
  const sortedEntries = [...entries]
    .filter((entry) => entry?.owner && Number.isFinite(Date.parse(entry.through)))
    .sort((a, b) => Date.parse(a.through) - Date.parse(b.through));

  return sortedEntries.map((entry, index) => {
    const boundary = new Date(Date.parse(entry.through) + 1).toISOString();
    return {
      fromOwner: entry.owner,
      toOwner: sortedEntries[index + 1]?.owner || currentOwner,
      notBefore: boundary,
      observedAt: boundary,
      repository: entry.repository || repository,
      source: 'legacy-cache',
    };
  });
}

export function getOwnerAtCommit(transfers, commitDate, currentOwner, fallbackOwner = null) {
  const committedAt = Date.parse(commitDate);
  if (!Number.isFinite(committedAt)) return fallbackOwner;

  const events = transfers
    .map((transfer) => ({
      ...transfer,
      lowerBound: transfer.notBefore ? Date.parse(transfer.notBefore) : NaN,
      observedAt: Date.parse(transfer.observedAt || transfer.at),
    }))
    .filter((transfer) => Number.isFinite(transfer.observedAt))
    .sort((a, b) => a.observedAt - b.observedAt);
  if (!events.length) return fallbackOwner || currentOwner;

  let owner = events[0].fromOwner || fallbackOwner || currentOwner;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (committedAt < event.observedAt) {
      if (Number.isFinite(event.lowerBound) && committedAt <= event.lowerBound) return owner;
      return fallbackOwner;
    }
    owner = event.toOwner || events[index + 1]?.fromOwner || currentOwner || owner;
  }
  return owner;
}
