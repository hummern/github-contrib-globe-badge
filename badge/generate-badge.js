import fs from 'fs';
import https from 'https';
import { createCanvas, loadImage } from 'canvas';
import GIFEncoder from 'gif-encoder-2';
import { execSync } from 'child_process';
import { groupMarkersByCountry } from './group-markers.js';
import { firstCurrentOwnerSeenAt, getHistoricalOwner } from './repository-owner-history.js';

const SIZE = 520;
const INTERNAL_SIZE = SIZE * 2;
const CX = SIZE / 2;
const CY = SIZE / 2;
const RADIUS = 238;
const FRAMES = 120;
const FRAME_DELAY = 100; // ms — 120 frames × 100ms = 12s per rotation (50% slower)
const WORLD_GEOJSON_URL = 'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson';
const REPOSITORY_OWNER_HISTORY_PATH = 'repository-owner-history.json';

function getRepositoryOwner() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY.split('/')[0];
  }
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    const match = remote.match(/github\.com(?::[0-9]+)?[:/]([^/]+)/);
    if (match) return match[1].toLowerCase();
  } catch (err) {}
  if (process.env.GITHUB_ACTOR) return process.env.GITHUB_ACTOR;
  throw new Error('Could not determine repository owner. Set GITHUB_ACTOR or ensure the script is run in a GitHub repo with remote origin.');
}

const USER = getRepositoryOwner();

function fetchJSONOnce(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      const redirectCodes = new Set([301, 302, 303, 307, 308]);
      if (redirectCodes.has(res.statusCode) && res.headers.location) {
        if (redirectCount >= 5) {
          res.resume();
          reject(new Error(`Too many redirects for GET ${url}`));
          return;
        }

        let redirectUrl;
        try {
          redirectUrl = new URL(res.headers.location, url);
        } catch (error) {
          res.resume();
          reject(error);
          return;
        }
        if (redirectUrl.origin !== new URL(url).origin) {
          res.resume();
          reject(new Error(`Refusing cross-origin redirect for GET ${url}`));
          return;
        }

        res.resume();
        fetchJSONOnce(redirectUrl.toString(), headers, redirectCount + 1).then(resolve, reject);
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`GET ${url} returned ${res.statusCode}`);
          error.status = res.statusCode;
          const retryAfter = res.headers['retry-after'];
          const resetHeader = res.headers['x-ratelimit-reset'];
          if (retryAfter) error.retryAfterMs = Number(retryAfter) * 1000;
          else if (resetHeader) error.retryAfterMs = Math.max(0, Number(resetHeader) * 1000 - Date.now());
          reject(error);
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function fetchJSON(url, headers = {}) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await fetchJSONOnce(url, headers);
    } catch (error) {
      lastError = error;
      const isRateLimited = error.status === 403 || error.status === 429;
      if (attempt < 4) {
        const waitMs = isRateLimited && error.retryAfterMs
          ? error.retryAfterMs + 500
          : 1000 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  throw lastError;
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'github-contrib-globe-badge',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

// Throttles calls to a shared budget within a rolling time window.
class RateLimiter {
  constructor(maxCalls, windowMs) {
    this.maxCalls = maxCalls;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  async wait() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxCalls) {
      const waitMs = this.windowMs - (now - this.timestamps[0]) + 250;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.wait();
    }
    this.timestamps.push(Date.now());
    return undefined;
  }
}

// Keep a shared conservative budget for GitHub Search API requests.
// Commit search and pull-request search both use the Search API, so sharing
// the limiter avoids exhausting the search budget when both are used.
const githubSearchLimiter = new RateLimiter(25, 60_000);

async function searchCommits(query) {
  await githubSearchLimiter.wait();
  return fetchJSON(
    `https://api.github.com/search/commits?q=${query}&per_page=100`,
    { ...githubHeaders(), Accept: 'application/vnd.github+json' },
  );
}

async function searchPullRequests(query) {
  await githubSearchLimiter.wait();
  return fetchJSON(
    `https://api.github.com/search/issues?q=${query}&per_page=100`,
    { ...githubHeaders(), Accept: 'application/vnd.github+json' },
  );
}

const COMMIT_CACHE_PATH = 'commit-cache.json';
function loadRepositoryOwnerHistory() {
  return JSON.parse(fs.readFileSync(REPOSITORY_OWNER_HISTORY_PATH, 'utf8'));
}

// A cached commit->origin mapping is trusted for this long before being
// re-resolved, since a repository that is private today (and thus invisible
// to the search API) can turn public later and turn out to be the true,
// older origin of a commit we already attributed elsewhere.
// The cached owner is retained across re-resolution so transfers don't change
// the location used for commits attributed before the transfer.
const ORIGIN_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function loadCommitCache() {
  try {
    return JSON.parse(fs.readFileSync(COMMIT_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function midpointDate(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  return new Date(from + Math.floor((to - from) / 2)).toISOString().slice(0, 10);
}

// GitHub's search API refuses to paginate past 1000 results for a single
// query, so a query matching more than that would silently drop the rest.
// Splitting the author-date range in half and recursing (only when needed)
// keeps each query's total_count under the cap while still covering the
// account's entire history.
async function fetchAllCommitItems(baseQuery, fromDate, toDate) {
  const items = [];
  async function fetchRange(from, to) {
    const q = encodeURIComponent(`${baseQuery} author-date:${from}..${to}`);
    const first = await searchCommits(`${q}&page=1`);
    const totalCount = first.total_count || 0;
    if (totalCount === 0) return;

    if (totalCount > 1000 && from !== to) {
      const mid = midpointDate(from, to);
      await fetchRange(from, mid);
      await fetchRange(addDays(mid, 1), to);
      return;
    }

    items.push(...(first.items || []));
    if (totalCount > 1000) {
      console.warn(`${totalCount} commits on ${from} exceed the search API's 1000-result cap; some may be missed.`);
    }
    const pages = Math.min(10, Math.ceil(totalCount / 100));
    for (let page = 2; page <= pages; page += 1) {
      const data = await searchCommits(`${q}&page=${page}`);
      items.push(...(data.items || []));
    }
  }
  await fetchRange(fromDate, toDate);
  return items;
}

// GitHub's search API refuses to paginate past 1000 results for a single
// query. Split the merged-date range recursively when necessary so that
// all merged pull requests can be collected.
async function fetchAllPullRequestItems(baseQuery, fromDate, toDate) {
  const items = [];
  async function fetchRange(from, to) {
    const q = encodeURIComponent(`${baseQuery} merged:${from}..${to}`);
    const first = await searchPullRequests(`${q}&page=1`);
    const totalCount = first.total_count || 0;
    if (totalCount === 0) return;

    if (totalCount > 1000 && from !== to) {
      const mid = midpointDate(from, to);
      await fetchRange(from, mid);
      await fetchRange(addDays(mid, 1), to);
      return;
    }

    items.push(...(first.items || []));
    if (totalCount > 1000) {
      console.warn(
        `${totalCount} pull requests on ${from} exceed the search API's ` +
        '1000-result cap; some may be missed.',
      );
    }
    const pages = Math.min(10, Math.ceil(totalCount / 100));
    for (let page = 2; page <= pages; page += 1) {
      const data = await searchPullRequests(`${q}&page=${page}`);
      items.push(...(data.items || []));
    }
  }
  await fetchRange(fromDate, toDate);
  return items;
}

// True when `message` has a `Co-authored-by:` trailer identifying the user,
// either by GitHub noreply address (with or without the numeric id prefix),
// by the user's public profile email, or by a name equal to their login.
function isCoAuthoredBy(message, { login, id, email }) {
  if (!message) return false;
  const lowerLogin = login.toLowerCase();
  const emails = new Set([`${lowerLogin}@users.noreply.github.com`]);
  if (id) emails.add(`${id}+${lowerLogin}@users.noreply.github.com`);
  if (email) emails.add(email.toLowerCase());
  const trailer = /^co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/gim;
  for (const match of message.matchAll(trailer)) {
    const name = match[1].trim().toLowerCase();
    const addr = match[2].trim().toLowerCase();
    if (emails.has(addr) || name === lowerLogin) return true;
  }
  return false;
}

async function getContributions(user, commitCache, repositoryOwnerHistory) {
  // Cache for repository metadata (repos API — 5000 req/hour limit).
  // Failures are NOT cached, so a transient error can be retried on a later
  // reference to the same repo instead of permanently poisoning the result.
  const repoCache = new Map();
  async function getRepositoryInfo(fullName) {
    if (repoCache.has(fullName)) return repoCache.get(fullName);
    const repo = await fetchJSON(`https://api.github.com/repos/${fullName}`, githubHeaders());
    repoCache.set(fullName, repo);
    return repo;
  }

  const ownerHistoryLookup = new Map();
  async function getRepositoryOwnerHistory(fullName, repositoryInfo) {
    const canonicalName = repositoryInfo.full_name || fullName;
    const key = canonicalName.toLowerCase();
    if (ownerHistoryLookup.has(key)) return ownerHistoryLookup.get(key);

    const currentOwner = repositoryInfo.owner?.login || canonicalName.split('/')[0];
    const repositoryName = canonicalName.split('/').at(-1).toLowerCase();
    const sources = new Map();
    for (const entry of Object.values(commitCache)) {
      if (!entry?.origin || entry.origin.split('/').at(-1).toLowerCase() !== repositoryName) continue;
      const owner = entry.owner || entry.origin.split('/')[0];
      if (owner.toLowerCase() === currentOwner.toLowerCase()) continue;
      sources.set(`${owner.toLowerCase()}/${entry.origin.toLowerCase()}`, {
        owner,
        repository: entry.origin,
      });
    }

    const entries = repositoryOwnerHistory[key] || [];
    for (const source of sources.values()) {
      if (entries.some((entry) => (
        entry.owner.toLowerCase() === source.owner.toLowerCase()
        && entry.repository.toLowerCase() === source.repository.toLowerCase()
      ))) continue;

      try {
        const sourceInfo = await getRepositoryInfo(source.repository);
        if (
          sourceInfo.full_name?.toLowerCase() !== key
          || sourceInfo.owner?.login?.toLowerCase() === source.owner.toLowerCase()
        ) continue;

        // GitHub doesn't expose transfer timestamps; use the earliest cached observation of the current owner.
        const through = firstCurrentOwnerSeenAt(
          commitCache,
          canonicalName,
          currentOwner,
          Date.now(),
        );
        entries.push({
          owner: source.owner,
          repository: source.repository,
          through: new Date(through).toISOString(),
        });
        console.log(`Recorded historical owner ${source.owner} for ${canonicalName}`);
      } catch (error) {
        console.warn(`Could not check historical repository ${source.repository}: ${error.message}`);
      }
    }

    entries.sort((a, b) => Date.parse(a.through) - Date.parse(b.through));
    if (entries.length) repositoryOwnerHistory[key] = entries;
    else delete repositoryOwnerHistory[key];
    ownerHistoryLookup.set(key, entries);
    return entries;
  }

  async function getTransferredOwner(cached, resolvedOrigin) {
    if (!cached?.origin) return null;
    const previousOwner = cached.owner || cached.origin.split('/')[0];
    if (previousOwner.toLowerCase() === resolvedOrigin.split('/')[0].toLowerCase()) return null;

    // GitHub redirects the old repository URL to its new owner after a transfer.
    try {
      const previousRepo = await getRepositoryInfo(cached.origin);
      if (previousRepo?.full_name?.toLowerCase() === resolvedOrigin.toLowerCase()) {
        return previousOwner;
      }
    } catch (error) {
      console.warn(`Could not check previous repository ${cached.origin}: ${error.message}`);
    }
    return null;
  }

  // Resolve the oldest repository that shares history with `fullName`.
  // A repo duplicating another repo's commits (same SHAs) is treated as a
  // copy of the original regardless of whether GitHub marks it as a fork —
  // plenty of repos are seeded from a full clone of another repo's history
  // without going through GitHub's fork feature. All candidates sharing a
  // SHA are found via the commits search API and the oldest (by creation
  // date) is kept as the origin. Results are cached per repository (not per
  // commit), so this search runs at most once per distinct repository
  // instead of once per commit.
  const originCache = new Map();
  async function resolveOriginRepo(fullName, sha) {
    if (originCache.has(fullName)) return originCache.get(fullName);

    const candidates = new Set([fullName]);
    try {
      const data = await searchCommits(`sha%3A${encodeURIComponent(sha)}+is:public`);
      for (const item of data.items || []) {
        if (item.repository?.full_name) candidates.add(item.repository.full_name);
      }
    } catch (error) {
      console.warn(`Could not search repositories for commit ${sha.slice(0, 8)}: ${error.message}`);
    }

    // Expand fork networks too — a candidate that's a GitHub fork points at its ultimate origin.
    for (const name of [...candidates]) {
      try {
        const info = await getRepositoryInfo(name);
        if (info?.fork && info.source?.full_name) candidates.add(info.source.full_name);
      } catch (error) {
        console.warn(`Could not fetch repository ${name}: ${error.message}`);
      }
    }

    // Pick the oldest candidate by creation date; unresolved repos are ignored.
    let oldest = null;
    let oldestDate = null;
    for (const name of candidates) {
      let info;
      try {
        info = await getRepositoryInfo(name);
      } catch (error) {
        console.warn(`Could not fetch repository ${name}: ${error.message}`);
        continue;
      }
      if (!info?.created_at) continue;
      if (oldest === null || info.created_at < oldestDate) {
        oldest = name;
        oldestDate = info.created_at;
      }
    }

    const resolved = oldest || fullName;
    originCache.set(fullName, resolved);
    return resolved;
  }

  // Search no further back than the account's own creation date — commits
  // authored before the account existed cannot belong to it. Falls back to
  // the previous hardcoded date if the account lookup fails for any reason.
  const accountInfo = await fetchJSON(`https://api.github.com/users/${encodeURIComponent(user)}`, githubHeaders())
    .catch((error) => {
      console.warn(`Could not fetch account info for ${user}: ${error.message}`);
      return null;
    });
  const accountCreatedAt = accountInfo?.created_at || null;
  const sinceDate = accountCreatedAt ? accountCreatedAt.slice(0, 10) : '2023-01-01';
  const untilDate = new Date().toISOString().slice(0, 10);

  const counts = new Map();
  const seenShas = new Set();
  const seenPullRequests = new Set();
  let totalCommits = 0;
  let totalPullRequests = 0;
  const now = Date.now();

  // `-user:${user}` excludes repos the user owns directly at the query
  // level, since those are never counted as external contributions anyway
  // — this cuts the result set (and thus the API calls needed) drastically
  // and keeps it well under the search API's 1000-result cap in practice.
  const baseQuery = `author:${user} is:public -user:${user}`;
  const items = await fetchAllCommitItems(baseQuery, sinceDate, untilDate);

  // Commits where the user is only credited through a `Co-authored-by:`
  // trailer are not matched by `author:`. The phrase search below is fuzzy
  // (it is tokenized full-text search), so each hit is verified against the
  // actual trailers in the commit message before being counted.
  const coAuthorQuery = `"Co-authored-by: ${user}" is:public -user:${user}`;
  const coAuthorItems = await fetchAllCommitItems(coAuthorQuery, sinceDate, untilDate);
  const coAuthorIdentity = { login: user, id: accountInfo?.id, email: accountInfo?.email };
  items.push(...coAuthorItems.filter((item) => isCoAuthoredBy(item.commit?.message, coAuthorIdentity)));

  for (const item of items) {
    const fullName = item.repository?.full_name;
    const sha = item.sha;
    if (!fullName || !sha) continue;
    if (seenShas.has(sha)) continue;
    seenShas.add(sha);

    const cached = commitCache[sha];
    const cacheIsFresh = cached && now - cached.resolvedAt < ORIGIN_CACHE_TTL_MS;
    let originRepo;
    let owner;
    if (cacheIsFresh) {
      originRepo = cached.origin;
      owner = cached.owner || cached.origin.split('/')[0];
    } else {
      const resolvedOrigin = await resolveOriginRepo(fullName, sha);
      const transferredOwner = cached?.owner || await getTransferredOwner(cached, resolvedOrigin);
      owner = transferredOwner || resolvedOrigin.split('/')[0];
      originRepo = transferredOwner ? cached.origin : resolvedOrigin;
    }

    let repositoryInfo;
    try {
      repositoryInfo = await getRepositoryInfo(originRepo);
    } catch (error) {
      console.warn(`Could not check repository owner history for ${originRepo}: ${error.message}`);
    }

    if (repositoryInfo?.full_name) {
      const canonicalName = repositoryInfo.full_name;
      await getRepositoryOwnerHistory(canonicalName, repositoryInfo);
      const commitDate = item.commit?.committer?.date || item.commit?.author?.date;
      const historicalOwner = getHistoricalOwner(repositoryOwnerHistory, canonicalName, commitDate);
      const canonicalOwner = repositoryInfo.owner?.login || canonicalName.split('/')[0];
      if (historicalOwner) {
        originRepo = historicalOwner.repository;
        owner = historicalOwner.owner;
      } else if (
        canonicalName.toLowerCase() !== originRepo.toLowerCase()
        && owner.toLowerCase() !== canonicalOwner.toLowerCase()
      ) {
        originRepo = canonicalName;
        owner = canonicalOwner;
      }
    }

    commitCache[sha] = {
      origin: originRepo,
      owner,
      resolvedAt: cacheIsFresh ? cached.resolvedAt : now,
      // Keep the first observation stable while resolvedAt is refreshed.
      firstSeenAt: cached?.firstSeenAt ?? cached?.resolvedAt ?? now,
    };

    if (owner === user) continue;
    if (!counts.has(owner)) counts.set(owner, { commits: 0, pullRequests: 0, repositories: new Set() });
    const ownerStats = counts.get(owner);
    ownerStats.commits += 1;
    ownerStats.repositories.add(originRepo);
    totalCommits += 1;
    console.log(`Commit ${sha.slice(0, 8)} attributed to ${originRepo}`);
  }

  // Find pull requests authored by the user that were merged into main
  // in public repositories not owned by the user.
  // base:main deliberately means the literal main branch, rather than
  // whatever the repository's default branch happens to be.
  const pullRequestQuery = `author:${user} is:public -user:${user} is:merged`;
  const pullRequests = await fetchAllPullRequestItems(pullRequestQuery, sinceDate, untilDate);
    console.log("Pull Request Query:", pullRequestQuery);
    console.log("Fetched PR items length:", (pullRequests || []).length);
    if (pullRequests && pullRequests.length > 0) {
        console.log("First PR:", JSON.stringify(pullRequests[0], null, 2));
    }
  for (const pullRequest of pullRequests) {
    const repoUrl = pullRequest.repository_url;
    let fullName = null;
    if (repoUrl) {
      const parts = repoUrl.split('/');
      if (parts.length >= 2) {
        fullName = parts.slice(4).join('/');
      }
    }
    console.log("DEBUG: repoUrl=", repoUrl, "fullName=", fullName);
    const number = pullRequest.number;
    if (!fullName || !number) continue;
    const pullRequestId = `${fullName}#${number}`;
    if (seenPullRequests.has(pullRequestId)) continue;
    seenPullRequests.add(pullRequestId);
    const owner = fullName.split('/')[0];
    if (owner.toLowerCase() === user.toLowerCase()) continue;
    if (!counts.has(owner)) counts.set(owner, { commits: 0, pullRequests: 0, repositories: new Set() });
    const ownerStats = counts.get(owner);
    ownerStats.pullRequests += 1;
    ownerStats.repositories.add(fullName);
    totalPullRequests += 1;
    console.log(`PR #${number} merged into main in ${fullName}`);
  }

  return { counts, totalCommits, totalPullRequests };
}

async function getOwnerLocation(owner) {
  const user = await fetchJSON(`https://api.github.com/users/${encodeURIComponent(owner)}`, githubHeaders());
  return user.location || null;
}

async function geocode(location) {
  if (!location) return null;
  const result = await fetchJSON(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(location)}`,
    { 'User-Agent': 'github-contrib-globe-badge/1.0' },
  );
  if (!result[0]) return null;
  return [+result[0].lat, +result[0].lon];
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = ((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    return pointInRing(lon, lat, geometry.coordinates[0])
      && !geometry.coordinates.slice(1).some((ring) => pointInRing(lon, lat, ring));
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => (
      pointInRing(lon, lat, polygon[0])
      && !polygon.slice(1).some((ring) => pointInRing(lon, lat, ring))
    ));
  }
  return false;
}

function countryCodeAt([lat, lon], geojson) {
  const feature = geojson.features.find(({ geometry }) => pointInGeometry(lon, lat, geometry));
  if (!feature) return null;
  const code = feature.properties['ISO3166-1-Alpha-2'];
  // These two countries have "-99" instead of ISO codes in geo-countries.
  const missingCodes = { France: 'FR', Norway: 'NO' };
  return /^[A-Z]{2}$/.test(code) ? code : missingCodes[feature.properties.name] || null;
}

async function reverseCountryCode([lat, lon]) {
  const result = await fetchJSON(
    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=3&addressdetails=1`,
    { 'User-Agent': 'github-contrib-globe-badge/1.0' },
  );
  const code = result.address?.country_code?.toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

async function loadFlags(markers) {
  const codes = new Set(markers.map((marker) => marker.countryCode).filter(Boolean));
  return new Map(await Promise.all([...codes].map(async (code) => {
    const svg = fs.readFileSync(new URL(`../node_modules/flag-icons/flags/4x3/${code.toLowerCase()}.svg`, import.meta.url), 'utf8');
    const sizedSvg = svg.replace('<svg ', '<svg width="64" height="48" ');
    return [code, await loadImage(Buffer.from(sizedSvg))];
  })));
}

function landPolygons(geojson) {
  const polygons = [];
  for (const feature of geojson.features || []) {
    const geometry = feature.geometry;
    const groups = geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
    for (const polygon of groups) {
      const ring = polygon[0];
      const lons = ring.map(([lon]) => lon);
      const lats = ring.map(([, lat]) => lat);
      polygons.push({
        polygon,
        minLon: Math.min(...lons),
        maxLon: Math.max(...lons),
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
      });
    }
  }
  return polygons;
}

// Orthographic projection — centerLonDeg rotates the globe for animation.
function project(lat, lon, centerLonDeg = 0) {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const centerLon = (centerLonDeg * Math.PI) / 180;
  const centerLat = (12 * Math.PI) / 180;
  const cosLat = Math.cos(latRad);
  const x = Math.cos(latRad) * Math.sin(lonRad - centerLon);
  const y = Math.cos(centerLat) * Math.sin(latRad) - Math.sin(centerLat) * cosLat * Math.cos(lonRad - centerLon);
  const z = Math.sin(centerLat) * Math.sin(latRad) + Math.cos(centerLat) * cosLat * Math.cos(lonRad - centerLon);
  if (z < 0) return null;
  return [CX + x * RADIUS, CY - y * RADIUS, z];
}

// Precompute which grid points are land — independent of rotation angle.
function computeLandGrid(geojson) {
  const polygons = landPolygons(geojson);
  const grid = [];
  for (let lat = -84; lat <= 84; lat += 2.8) {
    for (let lon = -180; lon < 180; lon += 2.8) {
      const land = polygons.some(({ polygon, minLon, maxLon, minLat, maxLat }) => (
        lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat
        && pointInRing(lon, lat, polygon[0])
        && !polygon.slice(1).some((ring) => pointInRing(lon, lat, ring))
      ));
      if (land) grid.push([lat, lon]);
    }
  }
  return grid;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function placeLabel(x, y, width, height, placed) {
  const baseX = Math.max(4, Math.min(SIZE - width - 4, x - width / 2));
  const baseY = Math.max(4, Math.min(SIZE - height - 4, y - height));
  const candidates = [];
  for (const desiredX of [baseX, 4, SIZE - width - 4, baseX - width / 2, baseX + width / 2]) {
    for (let row = -10; row <= 10; row += 1) {
      const left = Math.max(4, Math.min(SIZE - width - 4, desiredX));
      const dy = row * (height + 4);
      const top = Math.max(4, Math.min(SIZE - height - 4, baseY + dy));
      candidates.push({ left, top, distance: Math.abs(left - baseX) + Math.abs(top - baseY) });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const spot = candidates.find(({ left, top }) => placed.every((box) => (
    left >= box.left + width + 2 || box.left >= left + width + 2
    || top >= box.top + height + 2 || box.top >= top + height + 2
  ))) || { left: baseX, top: baseY };
  placed.push(spot);
  return [spot.left, spot.top];
}

function renderFrame(ctx, centerLonDeg, landGrid, markers, flags, totalCommits, totalPullRequests) {
  // Background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Shadow
  ctx.fillStyle = 'rgba(156, 163, 175, 0.2)';
  ctx.beginPath();
  ctx.arc(CX + 4, CY + 8, RADIUS, 0, Math.PI * 2);
  ctx.fill();

  // Ocean
  const grad = ctx.createRadialGradient(
    CX - RADIUS * 0.08, CY - RADIUS * 0.15, 0,
    CX, CY, RADIUS,
  );
  grad.addColorStop(0, '#fff');
  grad.addColorStop(0.86, '#f3f4f6');
  grad.addColorStop(1, '#d1d5db');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(CX, CY, RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Land dots (clipped to globe)
  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, RADIUS, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#343a40';
  ctx.globalAlpha = 0.9;
  for (const [lat, lon] of landGrid) {
    const p = project(lat, lon, centerLonDeg);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 1.15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // Markers — fade near the globe edge for smooth rotation
  const visibleMarkers = markers.map((marker) => ({
    marker,
    position: project(marker.location[0], marker.location[1], centerLonDeg),
  })).filter(({ position }) => position && position[2] > 0);
  for (const { position: [x, y, z] } of visibleMarkers) {
    ctx.globalAlpha = Math.min(1, z * 2.5);
    ctx.fillStyle = '#34d399';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // One label per country (aggregate commits/PRs across all locations for that country)
  const countryGroups = new Map();
  for (const { marker, position: [x, y, z] } of visibleMarkers) {
    const code = marker.countryCode || '__unknown__';
    let group = countryGroups.get(code);
    if (!group) {
      group = {
        countryCode: marker.countryCode,
        commits: 0,
        pullRequests: 0,
        // Use the first visible position as anchor for the country label
        anchor: { x, y, z },
      };
      countryGroups.set(code, group);
    }
    group.commits += marker.commits;
    group.pullRequests += marker.pullRequests;
    // Prefer the marker with higher activity as anchor for better visibility
    const activity = marker.commits + marker.pullRequests;
    const currentActivity = group.anchor.activity || 0;
    if (activity > currentActivity) {
      group.anchor = { x, y, z, activity };
    } else if (!group.anchor.activity) {
      group.anchor.activity = 0;
    }
  }

  const placedLabels = [];
  for (const group of countryGroups.values()) {
    const { x, y, z } = group.anchor;
    const opacity = Math.min(1, z * 2.5);
    const activityCount = group.commits + group.pullRequests;
    const totalActivities = totalCommits + totalPullRequests;
    const percentage = totalActivities ? Math.round((activityCount / totalActivities) * 100) : 0;

    ctx.globalAlpha = opacity;

    const boxWidth = 109;
    const boxHeight = 34;
    const [boxX, boxY] = placeLabel(x, y, boxWidth, boxHeight, placedLabels);

    if (Math.abs(boxX + boxWidth / 2 - x) > 5 || Math.abs(boxY + boxHeight - y) > 5) {
      ctx.strokeStyle = '#374151';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(boxX + boxWidth / 2, boxY + boxHeight / 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(23, 23, 23, 0.94)';
    roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 5);
    ctx.fill();

    const flag = flags.get(group.countryCode);
    const textX = flag ? boxX + 30 : boxX + 6;
    if (flag) ctx.drawImage(flag, boxX + 6, boxY + 8, 20, 15);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(`${group.commits} commits`, textX, boxY + 12);
    ctx.fillText(`${group.pullRequests} PRs`, textX, boxY + 24);
    ctx.font = '7px monospace';
    ctx.fillText(`↑ ${percentage}%`, boxX + 80, boxY + 24);

    ctx.globalAlpha = 1;
  }
}

async function main() {
  const renderOnly = process.argv.slice(2).includes('--render-only');
  if (process.argv.slice(2).some((arg) => arg !== '--render-only')) {
    throw new Error('Usage: node badge/generate-badge.js [--render-only]');
  }
  let data;
  if (renderOnly) {
    data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
  } else {
    const commitCache = loadCommitCache();
    const repositoryOwnerHistory = loadRepositoryOwnerHistory();
    const { counts, totalCommits, totalPullRequests } = await getContributions(
      USER,
      commitCache,
      repositoryOwnerHistory,
    );
    // Persist right away so already-resolved commits are saved even if a
    // later step (geocoding, GIF rendering) fails on this run.
    fs.writeFileSync(COMMIT_CACHE_PATH, JSON.stringify(commitCache, null, 2));
    fs.writeFileSync(REPOSITORY_OWNER_HISTORY_PATH, JSON.stringify(repositoryOwnerHistory, null, 2));
    const rankedOwners = [...counts.entries()].sort((a, b) => b[1].commits - a[1].commits);
    console.log(`Found ${totalCommits} commits and ${totalPullRequests} merged PRs across ${counts.size} owners`);
    // Walk the full ranking (not just the top 8) so an owner with no usable
    // location — e.g. a bot or org account — doesn't consume one of the 8
    // marker slots and hide a lower-ranked but geocodable contributor.
    const markers = [];
    for (const [owner, stats] of rankedOwners) {
      if (markers.length >= 1000) break;
      const location = await getOwnerLocation(owner).then(geocode);
      console.log(`Located ${owner}: ${location ? location.join(', ') : 'unknown'}`);
      if (location) markers.push({
        owner,
        commits: stats.commits,
        pullRequests: stats.pullRequests,
        location,
        repositories: [...stats.repositories].sort().map((fullName) => ({
          name: fullName.split('/').slice(1).join('/'),
          url: `https://github.com/${fullName}`,
        })),
      });
    }
    data = { user: USER, generatedAt: new Date().toISOString(), totalCommits, totalPullRequests, markers };
  }
  const geojson = await fetchJSON(WORLD_GEOJSON_URL, { 'User-Agent': 'github-contrib-globe-badge/1.0' });
  let lastReverseLookup = 0;
  for (const marker of data.markers) {
    marker.countryCode = countryCodeAt(marker.location, geojson);
    if (!marker.countryCode) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1100 - (Date.now() - lastReverseLookup))));
      lastReverseLookup = Date.now();
      marker.countryCode = await reverseCountryCode(marker.location);
    }
    if (!marker.countryCode) console.warn(`No country flag available for ${(marker.owners || [marker.owner]).join(', ')}`);
  }
  data.markers = groupMarkersByCountry(data.markers);
  const flags = await loadFlags(data.markers);
  fs.writeFileSync('data.json', JSON.stringify(data, null, 2));

  // Render animated GIF — globe rotates one full turn seamlessly.
  const landGrid = computeLandGrid(geojson);
  const internalCanvas = createCanvas(INTERNAL_SIZE, INTERNAL_SIZE);
  const internalCtx = internalCanvas.getContext('2d');
  const encoder = new GIFEncoder(SIZE, SIZE);
  encoder.setDelay(FRAME_DELAY);
  encoder.setRepeat(0); // loop forever
  encoder.setQuality(10);
  encoder.start();

  for (let i = 0; i < FRAMES; i += 1) {
    // Reverse rotation direction
    const angle = (360 / FRAMES) * (FRAMES - 1 - i);
    
    // Scale context for 2x supersampling
    internalCtx.save();
    internalCtx.scale(2, 2);
    renderFrame(internalCtx, angle, landGrid, data.markers, flags, data.totalCommits, data.totalPullRequests);
    internalCtx.restore();
    
    // Scale down from internal size to output size
    const outputCanvas = createCanvas(SIZE, SIZE);
    const outputCtx = outputCanvas.getContext('2d');
    outputCtx.drawImage(internalCanvas, 0, 0, INTERNAL_SIZE, INTERNAL_SIZE, 0, 0, SIZE, SIZE);
    encoder.addFrame(outputCtx);
  }
  encoder.finish();
  fs.writeFileSync('badge.gif', Buffer.from(encoder.out.getData()));
  console.log(`✅ badge.gif written – ${data.markers.length} country markers, ${data.totalCommits} commits, ${data.totalPullRequests} merged PRs, ${FRAMES} frames`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
