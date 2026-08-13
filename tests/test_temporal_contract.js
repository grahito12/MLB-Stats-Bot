import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ageMinutes,
  assertPregameEligible,
  checkDataFreshness,
  filterSplitsBeforeDate,
  parseUtcMs,
  toUtcIso
} from '../src/temporal_contract.js';
import { __mlbTestInternals } from '../src/mlb.js';

test('checkDataFreshness: missing / fresh / stale', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');
  assert.equal(checkDataFreshness(null, 15, { now }), 'missing');
  assert.equal(checkDataFreshness('', 15, { now }), 'missing');
  assert.equal(checkDataFreshness('2026-07-27T11:50:00Z', 15, { now }), 'fresh');
  assert.equal(checkDataFreshness('2026-07-27T11:00:00Z', 15, { now }), 'stale');
});

test('checkDataFreshness: future timestamp is invalid_future, not fresh', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');
  assert.equal(checkDataFreshness('2026-07-27T13:00:00Z', 15, { now }), 'invalid_future');
  assert.equal(checkDataFreshness('2026-07-27T12:00:30Z', 15, { now }), 'fresh'); // within skew
});

test('ageMinutes returns null for future timestamps (not 0)', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');
  assert.equal(ageMinutes('2026-07-27T13:00:00Z', now), null);
  assert.ok(ageMinutes('2026-07-27T11:30:00Z', now) > 29);
});

test('filterSplitsBeforeDate drops same-day and future logs', () => {
  const splits = [
    { date: '2026-07-20', stat: { gamesStarted: 1 } },
    { date: '2026-07-27', stat: { gamesStarted: 1 } },
    { date: '2026-07-28', stat: { gamesStarted: 1 } },
    { date: '2026-07-10', stat: { gamesStarted: 1 } }
  ];
  const kept = filterSplitsBeforeDate(splits, '2026-07-27');
  assert.deepEqual(
    kept.map((s) => s.date),
    ['2026-07-20', '2026-07-10']
  );
  assert.deepEqual(filterSplitsBeforeDate(splits, null), []);
});

test('assertPregameEligible rejects observation after as_of / first pitch', () => {
  const ok = assertPregameEligible({
    observedAt: '2026-07-27T16:00:00Z',
    asOf: '2026-07-27T17:00:00Z',
    firstPitch: '2026-07-27T18:00:00Z'
  });
  assert.equal(ok.ok, true);

  const afterAsOf = assertPregameEligible({
    observedAt: '2026-07-27T17:30:00Z',
    asOf: '2026-07-27T17:00:00Z',
    firstPitch: '2026-07-27T18:00:00Z'
  });
  assert.equal(afterAsOf.ok, false);
  assert.equal(afterAsOf.reason, 'observed_at_after_as_of');

  const missing = assertPregameEligible({ observedAt: '2026-07-27T16:00:00Z' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing_as_of');
});

test('assertPregameEligible requires producer time strictly before first pitch', () => {
  const atPitch = assertPregameEligible({
    asOf: '2026-07-27T18:00:00Z',
    firstPitch: '2026-07-27T18:00:00Z'
  });
  assert.deepEqual(atPitch, { ok: false, reason: 'as_of_at_first_pitch' });

  const afterPitchWithinOldSkew = assertPregameEligible({
    asOf: '2026-07-27T18:00:30Z',
    firstPitch: '2026-07-27T18:00:00Z'
  });
  assert.deepEqual(afterPitchWithinOldSkew, {
    ok: false,
    reason: 'as_of_after_first_pitch'
  });
});

test('mlb odds age: future fetchedAt is unavailable, not age 0', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');
  const item = {
    currentOdds: { oddsFetchedAt: '2026-07-27T15:00:00Z', awayMoneyline: 120, homeMoneyline: -140 }
  };
  assert.equal(__mlbTestInternals.moneylineOddsAgeMinutes(item, now), null);
  assert.match(
    __mlbTestInternals.moneylineOddsFreshnessReason(item, now),
    /masa depan|invalid/i
  );
});

test('determinePredictionTier rejects already-started games', () => {
  const now = new Date('2026-07-27T18:30:00Z');
  const started = __mlbTestInternals.determinePredictionTier('2026-07-27T18:00:00Z', now);
  assert.equal(started.tier, 'in_play');
  assert.equal(started.reject, true);

  const early = __mlbTestInternals.determinePredictionTier('2026-07-28T02:00:00Z', now);
  assert.equal(early.tier, 'early_preview');
});

test('parseUtcMs / toUtcIso round-trip Z timestamps', () => {
  const ms = parseUtcMs('2026-07-27T12:00:00Z');
  assert.equal(toUtcIso(ms), '2026-07-27T12:00:00.000Z');
});
