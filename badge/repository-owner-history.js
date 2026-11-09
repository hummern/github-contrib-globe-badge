function parseTimestamp(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value ?? ''))) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }
  return Date.parse(value);
}

export function normalizeTransferEvent(event, repositoryId, repositoryNames) {
  const action = String(event?.action || '').toLowerCase();
  if (!/^repo\.transfer(?:_outgoing)?$/.test(action)) return null;

  const repository = typeof event.repo === 'string'
    ? event.repo
    : event.repository?.full_name || '';
  const eventRepositoryId = event.repository_id ?? event.repo_id;
  if (
    repositoryId != null
    && eventRepositoryId != null
    && String(eventRepositoryId) !== String(repositoryId)
  ) return null;
  if (
    eventRepositoryId == null
    && repository
    && !repositoryNames.has(repository.toLowerCase())
  ) return null;
  if (eventRepositoryId == null && !repository) return null;

  const timestamp = parseTimestamp(event['@timestamp'] ?? event.created_at ?? event.timestamp);
  if (!Number.isFinite(timestamp)) return null;

  const explicitFromOwner = event.old_owner
    || event.from_owner
    || event.source_owner
    || null;
  const fromOwner = explicitFromOwner
    || (action === 'repo.transfer_outgoing' && (repository.split('/')[0] || event.org))
    || null;
  if (!fromOwner) return null;
  const destination = event.new_owner
    || event.to_owner
    || event.target_owner
    || event.destination_owner
    || null;

  return {
    at: new Date(timestamp).toISOString(),
    fromOwner,
    toOwner: typeof destination === 'string' ? destination.split('/')[0] : null,
    repository,
    source: 'audit-log',
  };
}

export function legacyOwnerTransfers(entries, currentOwner, repository) {
  const sortedEntries = [...entries]
    .filter((entry) => entry?.owner && Number.isFinite(Date.parse(entry.through)))
    .sort((a, b) => Date.parse(a.through) - Date.parse(b.through));

  return sortedEntries.map((entry, index) => {
    const boundary = Date.parse(entry.through) + 1;
    return {
      at: new Date(boundary).toISOString(),
      fromOwner: entry.owner,
      toOwner: sortedEntries[index + 1]?.owner || currentOwner,
      repository: entry.repository || repository,
      source: 'legacy-cache',
    };
  });
}

export function getOwnerAtCommit(transfers, commitDate, currentOwner, fallbackOwner = currentOwner) {
  const committedAt = Date.parse(commitDate);
  if (!Number.isFinite(committedAt)) return fallbackOwner;

  const events = transfers
    .map((transfer) => ({ ...transfer, timestamp: Date.parse(transfer.at) }))
    .filter((transfer) => Number.isFinite(transfer.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!events.length) return fallbackOwner;

  let owner = events[0].fromOwner || fallbackOwner || currentOwner;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (committedAt < event.timestamp) return owner;
    owner = event.toOwner || events[index + 1]?.fromOwner || currentOwner || owner;
  }
  return owner;
}
