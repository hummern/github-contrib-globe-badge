export function getHistoricalOwner(history, repository, commitDate) {
  const committedAt = Date.parse(commitDate);
  if (!Number.isFinite(committedAt)) return null;

  const entries = history[repository.toLowerCase()] || [];
  return entries
    .filter(({ through }) => {
      const cutoff = Date.parse(through);
      return Number.isFinite(cutoff) && committedAt <= cutoff;
    })
    .sort((a, b) => Date.parse(a.through) - Date.parse(b.through))[0] || null;
}

export function firstCurrentOwnerSeenAt(commitCache, repository, currentOwner, fallback) {
  let firstSeenAt = fallback;
  for (const entry of Object.values(commitCache)) {
    if (!entry?.origin || entry.origin.toLowerCase() !== repository.toLowerCase()) continue;
    const owner = entry.owner || entry.origin.split('/')[0];
    if (owner.toLowerCase() !== currentOwner.toLowerCase()) continue;

    const seenAt = Number(entry.firstSeenAt ?? entry.resolvedAt);
    if (Number.isFinite(seenAt) && seenAt < firstSeenAt) firstSeenAt = seenAt;
  }
  return firstSeenAt;
}
