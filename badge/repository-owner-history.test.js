import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRedirectTransfer,
  getOwnerAtCommit,
  legacyOwnerTransfers,
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
