import assert from 'node:assert/strict';
import test from 'node:test';

import { __mlbTestInternals } from '../src/mlb.js';

const {
  aggregateDateRange,
  buildFeatureAvailability,
  buildPredictionQuality,
  featureFallbackSummary,
  getTeamStatMap,
  lineupTemporalEligibility,
  mergeTeamStatMaps,
  parkFactorContext,
  summarizeHeadToHeadGames,
  teamStatBlockKind
} = __mlbTestInternals;

function block(type, group, teamId, stat) {
  return {
    type: { displayName: type },
    group: { displayName: group },
    splits: [
      {
        team: { id: teamId, name: `Team ${teamId}` },
        stat
      }
    ]
  };
}

function game() {
  return {
    gamePk: 9002,
    gameDate: '2026-07-27T23:00:00Z',
    teams: {
      away: {
        team: { id: 10 },
        probablePitcher: { id: 110 }
      },
      home: {
        team: { id: 20 },
        probablePitcher: { id: 220 }
      }
    }
  };
}

test('team-stat classifier accepts season/date-range basic and advanced blocks', () => {
  assert.deepEqual(teamStatBlockKind(block('season', 'hitting', 10, {})), {
    group: 'hitting',
    advanced: false,
    type: 'season'
  });
  assert.deepEqual(teamStatBlockKind(block('seasonAdvanced', 'pitching', 10, {})), {
    group: 'pitching',
    advanced: true,
    type: 'seasonadvanced'
  });
  assert.deepEqual(teamStatBlockKind(block('byDateRange', 'hitting', 10, {})), {
    group: 'hitting',
    advanced: false,
    type: 'bydaterange'
  });
  assert.deepEqual(teamStatBlockKind(block('byDateRangeAdvanced', 'pitching', 10, {})), {
    group: 'pitching',
    advanced: true,
    type: 'bydaterangeadvanced'
  });
  assert.equal(teamStatBlockKind(block('gameLog', 'hitting', 10, {})), null);
  assert.equal(teamStatBlockKind(block('season', 'fielding', 10, {})), null);
});

test('getTeamStatMap keeps basic and advanced families distinct', () => {
  const map = getTeamStatMap({
    stats: [
      block('season', 'hitting', 10, { runs: 101 }),
      block('seasonAdvanced', 'hitting', 10, { iso: 0.19 }),
      block('byDateRange', 'pitching', 10, { era: '3.21' }),
      block('byDateRangeAdvanced', 'pitching', 10, { homeRunsPer9: 0.91 })
    ]
  });

  assert.equal(map.size, 1);
  assert.deepEqual(map.get(10).hitting, { runs: 101 });
  assert.deepEqual(map.get(10).hittingAdvanced, { iso: 0.19 });
  assert.deepEqual(map.get(10).pitching, { era: '3.21' });
  assert.deepEqual(map.get(10).pitchingAdvanced, { homeRunsPer9: 0.91 });
});

test('getTeamStatMap ignores malformed, partial, and unsupported blocks', () => {
  const map = getTeamStatMap({
    stats: [
      null,
      { type: { displayName: 'season' }, group: { displayName: 'hitting' } },
      block('gameLog', 'hitting', 10, { runs: 999 }),
      block('season', 'fielding', 10, { errors: 1 }),
      {
        type: { displayName: 'season' },
        group: { displayName: 'hitting' },
        splits: [{ team: { id: 10 }, stat: null }]
      },
      block('season', 'pitching', 20, { era: '4.10' })
    ]
  });

  assert.equal(map.size, 1);
  assert.equal(map.get(20).pitching.era, '4.10');
  assert.equal(map.get(20).hitting, null);
  assert.equal(getTeamStatMap(null).size, 0);
});

test('mergeTeamStatMaps preserves partial basic and advanced responses', () => {
  const basic = getTeamStatMap({
    stats: [
      block('byDateRange', 'hitting', 10, { runs: 50 }),
      block('byDateRange', 'pitching', 10, { era: '3.50' })
    ]
  });
  const advanced = getTeamStatMap({
    stats: [
      block('byDateRangeAdvanced', 'hitting', 10, { iso: 0.17 }),
      block('byDateRangeAdvanced', 'pitching', 10, { homeRunsPer9: 1.05 })
    ]
  });
  const merged = mergeTeamStatMaps(basic, advanced);

  assert.equal(merged.get(10).hitting.runs, 50);
  assert.equal(merged.get(10).pitching.era, '3.50');
  assert.equal(merged.get(10).hittingAdvanced.iso, 0.17);
  assert.equal(merged.get(10).pitchingAdvanced.homeRunsPer9, 1.05);
});

test('aggregate date range ends day before prediction and rejects preseason/invalid dates', () => {
  assert.deepEqual(aggregateDateRange(2026, '2026-07-27'), {
    startDate: '2026-03-01',
    endDate: '2026-07-26'
  });
  assert.equal(aggregateDateRange(2026, '2026-03-01'), null);
  assert.equal(aggregateDateRange(2026, '2026-02-28'), null);
  assert.equal(aggregateDateRange(2026, 'not-a-date'), null);
  assert.equal(aggregateDateRange(2026, '2026-02-31'), null);
});

test('H2H summary excludes same-day opener, current game, non-finals, and future games', () => {
  const target = game();
  const makeGame = (gamePk, officialDate, winnerId, state = 'Final') => ({
    gamePk,
    officialDate,
    status: { abstractGameState: state },
    teams: {
      away: { team: { id: 10 }, score: winnerId === 10 ? 5 : 2 },
      home: { team: { id: 20 }, score: winnerId === 20 ? 5 : 2 }
    }
  });
  const result = summarizeHeadToHeadGames(
    target,
    [
      makeGame(8001, '2026-07-20', 10),
      makeGame(8002, '2026-07-27', 20),
      makeGame(9002, '2026-07-20', 20),
      makeGame(8003, '2026-07-28', 20),
      makeGame(8004, '2026-07-19', 20, 'Live')
    ],
    '2026-07-27'
  );

  assert.equal(result.games, 1);
  assert.equal(result.awayWins, 1);
  assert.equal(result.homeWins, 0);
  assert.equal(result.awayProbability, (2 / 3) * 100);
});

test('lineup temporal eligibility rejects first pitch and post-start timestamps', () => {
  const target = game();
  assert.deepEqual(lineupTemporalEligibility(target, '2026-07-27T22:59:59Z'), {
    ok: true,
    reason: null
  });
  assert.deepEqual(lineupTemporalEligibility(target, '2026-07-27T23:00:00Z'), {
    ok: false,
    reason: 'as_of_at_first_pitch'
  });
  assert.deepEqual(lineupTemporalEligibility(target, '2026-07-27T23:00:01Z'), {
    ok: false,
    reason: 'as_of_after_first_pitch'
  });
});

test('park-factor context keys by venue ID', () => {
  const dodger = parkFactorContext(119, 'Wrong Name');
  const unknown = parkFactorContext(999999, 'Unknown Park');

  assert.equal(dodger.label, 'Dodger Stadium');
  assert.equal(dodger.runFactor, 0.99);
  assert.equal(unknown.label, 'Unknown Park');
  assert.equal(unknown.runFactor, 1);
});

test('fallbacks and quality expose missing critical families', () => {
  const target = game();
  const teamStats = new Map([
    [10, { hitting: {}, pitching: {}, hittingAdvanced: null, pitchingAdvanced: null }],
    [20, { hitting: {}, pitching: {}, hittingAdvanced: {}, pitchingAdvanced: {} }]
  ]);
  const standings = new Map([[10, {}]]);
  const pitcherStats = new Map([[110, {}]]);
  const rollingTeamStats = new Map([
    [10, {}],
    [20, {}]
  ]);
  const lineupProfiles = { away: null, home: null };
  const headToHead = { games: 0 };

  const fallbacks = featureFallbackSummary({
    game: target,
    teamStats,
    standings,
    pitcherStats,
    rollingTeamStats,
    lineupProfiles,
    headToHead
  });

  assert.deepEqual(fallbacks.reasons.sort(), [
    'missing_lineup',
    'missing_probable_starter_stats',
    'missing_standings',
    'missing_team_season_advanced'
  ]);
  assert.deepEqual(fallbacks.criticalReasons.sort(), [
    'missing_probable_starter_stats',
    'missing_standings'
  ]);
  assert.ok(fallbacks.features.includes('lineup'));
  const quality = buildPredictionQuality({
    game: target,
    predictionTimestampUtc: '2026-07-27T20:00:00Z',
    featureFallbacks: fallbacks
  });
  assert.equal(quality.status, 'DEGRADED');
  assert.equal(quality.promotionEligible, false);
  assert.deepEqual(quality.reasons.sort(), [
    'missing_probable_starter_stats',
    'missing_standings'
  ]);
  assert.deepEqual(
    buildPredictionQuality({
      game: target,
      predictionTimestampUtc: '2026-07-27T23:00:00Z',
      featureFallbacks: { count: 0, features: [], reasons: [] }
    }),
    {
      status: 'INELIGIBLE_TEMPORAL',
      promotionEligible: false,
      reasons: ['as_of_at_first_pitch']
    }
  );

  const availability = buildFeatureAvailability({
    game: target,
    teamStats,
    standings,
    pitcherStats,
    rollingTeamStats,
    lineupProfiles,
    headToHead,
    predictionTimestampUtc: '2026-07-27T20:00:00Z'
  });
  assert.equal(availability.teamSeasonBasic, true);
  assert.equal(availability.teamSeasonAdvanced, false);
  assert.equal(availability.standings, false);
  assert.equal(availability.probableStarters, false);
  assert.equal(availability.pregame, true);
});

test('team basic availability requires hitting and pitching for both teams', () => {
  const target = game();
  const partialTeamStats = new Map([
    [10, { hitting: {}, pitching: null }],
    [20, { hitting: {}, pitching: {} }]
  ]);

  const fallbacks = featureFallbackSummary({
    game: target,
    teamStats: partialTeamStats,
    standings: new Map([
      [10, {}],
      [20, {}]
    ]),
    pitcherStats: new Map([
      [110, {}],
      [220, {}]
    ]),
    rollingTeamStats: new Map([
      [10, {}],
      [20, {}]
    ]),
    lineupProfiles: { away: {}, home: {} },
    headToHead: { games: 0 }
  });
  const availability = buildFeatureAvailability({
    game: target,
    teamStats: partialTeamStats,
    standings: new Map([
      [10, {}],
      [20, {}]
    ]),
    pitcherStats: new Map([
      [110, {}],
      [220, {}]
    ]),
    rollingTeamStats: new Map([
      [10, {}],
      [20, {}]
    ]),
    lineupProfiles: { away: {}, home: {} },
    headToHead: { games: 0 },
    predictionTimestampUtc: '2026-07-27T20:00:00Z'
  });

  assert.equal(availability.teamSeasonBasic, false);
  assert.ok(fallbacks.features.includes('team_season_basic'));
  assert.ok(fallbacks.criticalReasons.includes('missing_team_season_basic'));
});

test('optional fallbacks degrade quality without blocking promotion', () => {
  const quality = buildPredictionQuality({
    game: game(),
    predictionTimestampUtc: '2026-07-27T20:00:00Z',
    featureFallbacks: {
      count: 2,
      features: ['lineup', 'head_to_head'],
      reasons: ['missing_lineup', 'missing_head_to_head'],
      criticalCount: 0,
      criticalReasons: []
    }
  });

  assert.equal(quality.status, 'DEGRADED');
  assert.equal(quality.promotionEligible, true);
  assert.deepEqual(quality.reasons, []);
  assert.deepEqual(quality.fallbackFeatures, ['lineup', 'head_to_head']);
});
