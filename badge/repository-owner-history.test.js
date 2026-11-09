import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRedirectTransfer,
  getOwnerAtCommit,
  legacyOwnerTransfers,
  mergeRepositoryHistoryCache,
  selectPreviousOwnerObservation,
} from './repository-owner-history.js';

test('creates a transfer observation from a redirect and its prior owner snapshot', () => {
  assert.deepEqual(createRedirectTransfer(
    { owner: 'former-owner', observedAt: '2024-01-01T00:00:00Z' },
    'current-owner',
    '2024-01-03T00:00:00Z',
    'former-owner/project',
  ), {
    fromOwner: 'former-owner',
    toOwner: 'current-owner',
    notBefore: '2024-01-01T00:00:00Z',
    observedAt: '2024-01-03T00:00:00Z',
    repository: 'former-owner/project',
    source: 'redirect',
  });
  assert.equal(createRedirectTransfer(
    { owner: 'current-owner', observedAt: '2024-01-01T00:00:00Z' },
    'current-owner',
    '2024-01-03T00:00:00Z',
    'current-owner/project',
  ), null);
  assert.equal(createRedirectTransfer(null, 'current-owner', '2024-01-03T00:00:00Z', 'project'), null);
});

test('attributes commits outside a redirect-observation window to the correct owner', () => {
  const transfers = [{
    fromOwner: 'former-owner',
    toOwner: 'current-owner',
    notBefore: '2024-01-01T00:00:00Z',
    observedAt: '2024-01-03T00:00:00Z',
  }];

  assert.equal(
    getOwnerAtCommit(transfers, '2023-12-31T23:59:59Z', 'current-owner'),
    'former-owner',
  );
  assert.equal(
    getOwnerAtCommit(transfers, '2024-01-04T00:00:00Z', 'current-owner'),
    'current-owner',
  );
});

test('does not guess the owner for commits in an unobserved transfer window', () => {
  const transfers = [{
    fromOwner: 'former-owner',
    toOwner: 'current-owner',
    notBefore: '2024-01-01T00:00:00Z',
    observedAt: '2024-01-03T00:00:00Z',
  }];

  assert.equal(
    getOwnerAtCommit(transfers, '2024-01-02T00:00:00Z', 'current-owner'),
    null,
  );
  assert.equal(
    getOwnerAtCommit(transfers, '2024-01-02T00:00:00Z', 'current-owner', 'former-owner'),
    'former-owner',
  );
  assert.equal(getOwnerAtCommit(transfers, 'not-a-date', 'current-owner'), null);
});

test('handles multiple transfers recorded by consecutive observations', () => {
  const transfers = [
    {
      fromOwner: 'former-owner',
      toOwner: 'middle-owner',
      notBefore: '2024-01-01T00:00:00Z',
      observedAt: '2024-01-03T00:00:00Z',
    },
    {
      fromOwner: 'middle-owner',
      toOwner: 'current-owner',
      notBefore: '2025-01-01T00:00:00Z',
      observedAt: '2025-01-03T00:00:00Z',
    },
  ];

  assert.equal(
    getOwnerAtCommit(transfers, '2024-06-01T00:00:00Z', 'current-owner'),
    'middle-owner',
  );
  assert.equal(
    getOwnerAtCommit(transfers, '2025-02-01T00:00:00Z', 'current-owner'),
    'current-owner',
  );
});

test('does not re-open an interval for a redirect duplicating a cached transfer', () => {
  const transfers = [
    {
      fromOwner: 'former-owner',
      toOwner: 'current-owner',
      notBefore: '2024-01-01T00:00:00Z',
      observedAt: '2024-01-01T00:00:00.001Z',
    },
    {
      fromOwner: 'former-owner',
      toOwner: 'current-owner',
      notBefore: '2023-12-31T00:00:00Z',
      observedAt: '2024-01-03T00:00:00Z',
    },
  ];

  assert.equal(
    getOwnerAtCommit(transfers, '2024-01-02T00:00:00Z', 'current-owner'),
    'current-owner',
  );
});

test('converts legacy owner boundaries into point-in-time transfers', () => {
  const transfers = legacyOwnerTransfers([
    {
      owner: 'former-owner',
      repository: 'former-owner/project',
      through: '2024-01-01T00:00:00Z',
    },
    {
      owner: 'middle-owner',
      repository: 'middle-owner/project',
      through: '2025-01-01T00:00:00Z',
    },
  ], 'current-owner', 'current-owner/project');

  assert.equal(
    getOwnerAtCommit(transfers, '2024-06-01T00:00:00Z', 'current-owner'),
    'middle-owner',
  );
  assert.equal(
    getOwnerAtCommit(transfers, '2025-01-01T00:00:00.001Z', 'current-owner'),
    'current-owner',
  );
});

test('uses cached owner data when no prior redirect observation is available', () => {
  const cachedOwner = {
    owner: 'former-owner',
    commitDate: '2024-01-01T00:00:00Z',
    origin: 'former-owner/project',
  };
  assert.deepEqual(selectPreviousOwnerObservation(null, cachedOwner, 'current-owner'), {
    ...cachedOwner,
    observedAt: cachedOwner.commitDate,
  });
  assert.deepEqual(selectPreviousOwnerObservation({
    owner: 'current-owner',
    observedAt: '2024-01-04T00:00:00Z',
  }, cachedOwner, 'current-owner'), {
    ...cachedOwner,
    observedAt: cachedOwner.commitDate,
  });
});

test('seeds a fork cache with parent transfer history without copying commit records', () => {
  const forkCache = {
    'fork-commit': {
      origin: 'cheaper-inference/OmniRoute',
      ownerAtCommit: 'cheaper-inference',
      commitDate: '2026-10-08T11:32:31.000-03:00',
      repositoryId: 1157102282,
    },
    _repositoryOwnerHistory: {},
    _repositoryRedirectHistory: {},
  };
  const parentCache = {
    'parent-commit': { ownerAtCommit: 'diegosouzapw' },
    _repositoryOwnerHistory: {
      'cheaper-inference/omniroute': [{
        owner: 'diegosouzapw',
        repository: 'diegosouzapw/OmniRoute',
        through: '2026-10-30T03:36:28.212Z',
      }],
    },
    _repositoryRedirectHistory: {
      '1157102282': {
        events: [{
          fromOwner: 'diegosouzapw',
          toOwner: 'cheaper-inference',
          notBefore: '2026-10-29T07:55:07.000-03:00',
          observedAt: '2026-11-09T10:21:21.631Z',
          repository: 'diegosouzapw/OmniRoute',
          source: 'redirect',
        }],
        ownerObservations: {
          'cheaper-inference/omniroute': {
            owner: 'cheaper-inference',
            fullName: 'cheaper-inference/OmniRoute',
            observedAt: '2026-11-09T10:21:21.631Z',
          },
        },
      },
    },
  };

  mergeRepositoryHistoryCache(forkCache, parentCache);

  const transfers = [
    ...legacyOwnerTransfers(
      forkCache._repositoryOwnerHistory['cheaper-inference/omniroute'],
      'cheaper-inference',
      'cheaper-inference/OmniRoute',
    ),
    ...forkCache._repositoryRedirectHistory['1157102282'].events,
  ];
  assert.equal(
    getOwnerAtCommit(
      transfers,
      forkCache['fork-commit'].commitDate,
      'cheaper-inference',
      forkCache['fork-commit'].ownerAtCommit,
    ),
    'diegosouzapw',
  );
  assert.equal(Object.hasOwn(forkCache, 'parent-commit'), false);
  assert.equal(Object.hasOwn(parentCache, 'fork-commit'), false);
});
