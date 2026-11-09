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

export function selectPreviousOwnerObservation(latestObservation, cachedOwner, currentOwner) {
  if (
    latestObservation?.owner
    && latestObservation.owner.toLowerCase() !== currentOwner.toLowerCase()
  ) return latestObservation;

  if (
    cachedOwner?.owner
    && cachedOwner.owner.toLowerCase() !== currentOwner.toLowerCase()
  ) {
    return {
      ...cachedOwner,
      observedAt: cachedOwner.observedAt || cachedOwner.commitDate || null,
    };
  }

  return latestObservation || null;
}

export function mergeRepositoryHistoryCache(targetCache, sourceCache) {
  const targetOwnerHistory = targetCache._repositoryOwnerHistory ||= {};
  const sourceOwnerHistory = sourceCache?._repositoryOwnerHistory || {};

  for (const [repository, entries] of Object.entries(sourceOwnerHistory)) {
    if (!Array.isArray(entries)) continue;
    const merged = new Map();
    for (const entry of [
      ...(Array.isArray(targetOwnerHistory[repository]) ? targetOwnerHistory[repository] : []),
      ...entries,
    ]) {
      if (!entry?.owner || !entry?.through) continue;
      const key = [
        entry.owner.toLowerCase(),
        (entry.repository || '').toLowerCase(),
        entry.through,
      ].join('|');
      merged.set(key, { ...entry });
    }
    targetOwnerHistory[repository] = [...merged.values()]
      .sort((a, b) => Date.parse(a.through) - Date.parse(b.through));
  }

  const targetTransferHistory = targetCache._repositoryRedirectHistory ||= {};
  const sourceTransferHistory = sourceCache?._repositoryRedirectHistory || {};
  for (const [repositoryId, sourceRecord] of Object.entries(sourceTransferHistory)) {
    if (!sourceRecord || typeof sourceRecord !== 'object') continue;
    const targetRecord = targetTransferHistory[repositoryId] || {};
    const eventsByTransition = new Map();
    for (const event of [
      ...(Array.isArray(targetRecord.events) ? targetRecord.events : []),
      ...(Array.isArray(sourceRecord.events) ? sourceRecord.events : []),
    ]) {
      if (!event?.fromOwner || !event?.toOwner) continue;
      const key = [
        event.fromOwner.toLowerCase(),
        event.toOwner.toLowerCase(),
        event.notBefore || '',
      ].join('|');
      const existing = eventsByTransition.get(key);
      const observedAt = Date.parse(event.observedAt || event.at);
      const existingObservedAt = Date.parse(existing?.observedAt || existing?.at);
      if (
        !existing
        || (Number.isFinite(observedAt) && (
          !Number.isFinite(existingObservedAt) || observedAt < existingObservedAt
        ))
      ) eventsByTransition.set(key, { ...event });
    }

    const ownerObservations = { ...(targetRecord.ownerObservations || {}) };
    for (const [name, observation] of Object.entries(sourceRecord.ownerObservations || {})) {
      if (!observation?.owner) continue;
      const existing = ownerObservations[name];
      const observedAt = Date.parse(observation.observedAt);
      const existingObservedAt = Date.parse(existing?.observedAt);
      if (
        !existing
        || (Number.isFinite(observedAt) && (
          !Number.isFinite(existingObservedAt) || observedAt > existingObservedAt
        ))
      ) ownerObservations[name] = { ...observation };
    }

    targetTransferHistory[repositoryId] = {
      ...targetRecord,
      events: [...eventsByTransition.values()],
      ownerObservations,
    };
  }
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
    if (owner?.toLowerCase() === event.toOwner?.toLowerCase()) continue;
    if (committedAt < event.observedAt) {
      if (Number.isFinite(event.lowerBound) && committedAt <= event.lowerBound) return owner;
      return fallbackOwner;
    }
    owner = event.toOwner || events[index + 1]?.fromOwner || currentOwner || owner;
  }
  return owner;
}
