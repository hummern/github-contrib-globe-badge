import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getOwnerAtCommit,
  legacyOwnerTransfers,
  normalizeTransferEvent,
} from './repository-owner-history.js';

test('attributes commits to the repository owner across multiple transfers', () => {
  const transfers = [
    {
      at: '2024-01-01T00:00:00Z',
      fromOwner: 'former-owner',
      toOwner: 'middle-owner',
    },
    {
      at: '2025-01-01T00:00:00Z',
      fromOwner: 'middle-owner',
      toOwner: 'current-owner',
    },
  ];

  assert.equal(
    getOwnerAtCommit(transfers, '2023-12-31T23:59:59Z', 'current-owner'),
    'former-owner',
  );
  assert.equal(
    getOwnerAtCommit(transfers, '2024-06-01T00:00:00Z', 'current-owner'),
    'middle-owner',
  );
  assert.equal(
    getOwnerAtCommit(transfers, '2025-01-01T00:00:00Z', 'current-owner'),
    'current-owner',
  );
});

test('uses the next outgoing owner when a transfer event has no destination field', () => {
  const transfers = [
    { at: '2024-01-01T00:00:00Z', fromOwner: 'former-owner' },
    { at: '2025-01-01T00:00:00Z', fromOwner: 'middle-owner' },
  ];

  assert.equal(
    getOwnerAtCommit(transfers, '2024-06-01T00:00:00Z', 'current-owner'),
    'middle-owner',
  );
  assert.equal(
    getOwnerAtCommit(transfers, '2025-06-01T00:00:00Z', 'current-owner'),
    'current-owner',
  );
});

test('does not let a later legacy boundary overwrite a precise transfer event', () => {
  const transfers = [
    { at: '2024-01-01T00:00:00Z', fromOwner: 'former-owner', toOwner: 'current-owner' },
    { at: '2024-03-01T00:00:00Z', fromOwner: 'former-owner', toOwner: 'current-owner' },
  ];

  assert.equal(
    getOwnerAtCommit(transfers, '2024-02-01T00:00:00Z', 'current-owner'),
    'current-owner',
  );
});

test('normalizes matching repository transfer audit events', () => {
  const event = normalizeTransferEvent({
    action: 'repo.transfer_outgoing',
    '@timestamp': 1704067200000,
    org: 'former-owner',
    repo: 'former-owner/project',
    repository_id: 42,
  }, 42, new Set(['former-owner/project']));

  assert.deepEqual(event, {
    at: '2024-01-01T00:00:00.000Z',
    fromOwner: 'former-owner',
    toOwner: null,
    repository: 'former-owner/project',
    source: 'audit-log',
  });
  assert.equal(normalizeTransferEvent({
    action: 'repo.transfer_outgoing',
    '@timestamp': 1704067200000,
    repo: 'former-owner/other-project',
  }, 42, new Set(['former-owner/project'])), null);
  assert.equal(normalizeTransferEvent({
    action: 'repo.transfer',
    '@timestamp': 1704067200000,
    repo: 'former-owner/project',
  }, 42, new Set(['former-owner/project'])), null);
  assert.equal(normalizeTransferEvent({
    action: 'repo.transfer',
    '@timestamp': 1704067200000,
    old_owner: 'former-owner',
    new_owner: 'current-owner',
    repo: 'former-owner/project',
    repo_id: 42,
  }, 42, new Set(['former-owner/project']))?.toOwner, 'current-owner');
});

test('converts legacy owner boundaries into transfer events', () => {
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

  assert.deepEqual(transfers.map(({ fromOwner, toOwner }) => [fromOwner, toOwner]), [
    ['former-owner', 'middle-owner'],
    ['middle-owner', 'current-owner'],
  ]);
  assert.equal(
    getOwnerAtCommit(transfers, '2024-06-01T00:00:00Z', 'current-owner'),
    'middle-owner',
  );
});
