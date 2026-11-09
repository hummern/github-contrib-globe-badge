import assert from 'node:assert/strict';
import test from 'node:test';
import { firstCurrentOwnerSeenAt, getHistoricalOwner } from './repository-owner-history.js';

test('uses the former owner for commits before the cached ownership boundary', () => {
  const history = {
    'cheaper-inference/omniroute': [{
      owner: 'diegosouzapw',
      repository: 'diegosouzapw/OmniRoute',
      through: '2026-10-29T03:33:15.969Z',
    }],
  };

  assert.equal(
    getHistoricalOwner(history, 'Cheaper-Inference/OmniRoute', '2026-10-08T14:32:31Z')?.owner,
    'diegosouzapw',
  );
  assert.equal(getHistoricalOwner(history, 'cheaper-inference/OmniRoute', '2026-10-30T00:00:00Z'), null);
});

test('keeps the earliest recorded current-owner time when cache entries refresh', () => {
  const cache = {
    a: {
      origin: 'cheaper-inference/OmniRoute',
      owner: 'cheaper-inference',
      resolvedAt: Date.parse('2026-11-01T00:00:00Z'),
      firstSeenAt: Date.parse('2026-10-29T00:00:00Z'),
    },
    b: {
      origin: 'cheaper-inference/OmniRoute',
      owner: 'cheaper-inference',
      resolvedAt: Date.parse('2026-10-30T00:00:00Z'),
    },
    c: {
      origin: 'diegosouzapw/OmniRoute',
      owner: 'diegosouzapw',
      resolvedAt: Date.parse('2026-09-01T00:00:00Z'),
    },
  };

  assert.equal(
    firstCurrentOwnerSeenAt(cache, 'cheaper-inference/OmniRoute', 'cheaper-inference', Date.now()),
    Date.parse('2026-10-29T00:00:00Z'),
  );
});
