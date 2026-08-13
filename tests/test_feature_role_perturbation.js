import assert from 'node:assert/strict';
import test from 'node:test';

import { predictGameMoneylineCore, buildCoreInputsSnapshot } from '../src/core/prediction_core.js';
import { CONTROL_FEATURE_ROLES } from '../src/core/feature_roles.js';
import { calibratePercent } from '../src/calibration.js';
import { loadEvolutionControls, moneylineWeightMultiplier } from '../src/evolutionControls.js';

function toKeyMap(value) {
  if (value == null) return new Map();
  if (value instanceof Map) return value;
  const map = new Map();
  for (const [key, entry] of Object.entries(value)) {
    const numeric = Number(key);
    map.set(Number.isFinite(numeric) && String(numeric) === key ? numeric : key, entry);
  }
  return map;
}

/**
 * A feature-rich bundle where every active family has real (non-default) data.
 * Mutating any active family must change the raw probability; mutating an
 * informational_only/unused family must not.
 */
function richBundle() {
  return {
    game: {
      gamePk: 778001,
      officialDate: '2026-07-21',
      gameDate: '2026-07-21T23:05:00Z',
      venue: { id: 3, name: 'Great American Ball Park' },
      weather: { temp: '88', wind: '12 mph, out' },
      status: { detailedState: 'Scheduled' },
      teams: {
        away: {
          team: { id: 113, name: 'Reds', abbreviation: 'CIN' },
          leagueRecord: { wins: 50, losses: 50 },
          probablePitcher: { id: 605397, fullName: 'Away SP', pitchHand: { code: 'R' } }
        },
        home: {
          team: { id: 120, name: 'Nationals', abbreviation: 'WSH' },
          leagueRecord: { wins: 55, losses: 45 },
          probablePitcher: { id: 543037, fullName: 'Home SP', pitchHand: { code: 'L' } }
        }
      }
    },
    teamStats: toKeyMap({
      113: {
        hitting: { gamesPlayed: 100, runs: 430, ops: '.710' },
        pitching: { era: '4.30', whip: '1.35' },
        hittingAdvanced: { iso: 0.15, strikeoutsPerPlateAppearance: 0.24, walksPerPlateAppearance: 0.08 },
        pitchingAdvanced: { strikeoutsMinusWalksPercentage: 0.10, homeRunsPer9: 1.15 }
      },
      120: {
        hitting: { gamesPlayed: 100, runs: 470, ops: '.740' },
        pitching: { era: '3.90', whip: '1.25' },
        hittingAdvanced: { iso: 0.17, strikeoutsPerPlateAppearance: 0.22, walksPerPlateAppearance: 0.09 },
        pitchingAdvanced: { strikeoutsMinusWalksPercentage: 0.14, homeRunsPer9: 0.95 }
      }
    }),
    standings: toKeyMap({
      113: {
        leagueRecord: { wins: 50, losses: 50 },
        gamesPlayed: 100,
        runsScored: 430,
        runsAllowed: 440,
        runDifferential: -10,
        records: {
          splitRecords: [
            { type: 'lastTen', pct: 0.5 },
            { type: 'home', pct: 0.52 },
            { type: 'away', pct: 0.48 },
            { type: 'left', pct: 0.45 },
            { type: 'right', pct: 0.51 }
          ]
        }
      },
      120: {
        leagueRecord: { wins: 55, losses: 45 },
        gamesPlayed: 100,
        runsScored: 470,
        runsAllowed: 420,
        runDifferential: 50,
        records: {
          splitRecords: [
            { type: 'lastTen', pct: 0.6 },
            { type: 'home', pct: 0.58 },
            { type: 'away', pct: 0.52 },
            { type: 'left', pct: 0.57 },
            { type: 'right', pct: 0.54 }
          ]
        }
      }
    }),
    pitcherStats: toKeyMap({
      605397: { era: '4.10', whip: '1.30', strikeOuts: 120, baseOnBalls: 45, strikeoutsMinusWalksPercentage: 0.11, homeRunsPer9: 1.1 },
      543037: { era: '3.20', whip: '1.10', strikeOuts: 150, baseOnBalls: 40, strikeoutsMinusWalksPercentage: 0.16, homeRunsPer9: 0.85 }
    }),
    pitcherDetails: toKeyMap({
      605397: { pitchHand: { code: 'R' } },
      543037: { pitchHand: { code: 'L' } }
    }),
    pitcherRecentStarts: toKeyMap({
      605397: { innings: 30, era: '4.50', whip: '1.35', strikeouts: 28, walks: 10, homeRuns: 4, lastStartDate: '2026-07-16' },
      543037: { innings: 32, era: '2.80', whip: '1.05', strikeouts: 35, walks: 8, homeRuns: 2, lastStartDate: '2026-07-16' }
    }),
    bullpenProfiles: toKeyMap({
      113: { teamId: 113, fatigueScore: 3, backToBackRelievers: 1, highPitchRelievers: 1 },
      120: { teamId: 120, fatigueScore: 1, backToBackRelievers: 0, highPitchRelievers: 0 }
    }),
    scheduleFatigueProfiles: toKeyMap({
      113: { restDays: 2, roadStreak: 3, recentGameCount: 8, doubleheaderLast3Days: false, fatigueLevel: 'medium', offenseAdjustment: 0, teamAdjustment: 0 },
      120: { restDays: 4, roadStreak: 0, recentGameCount: 7, doubleheaderLast3Days: false, fatigueLevel: 'low', offenseAdjustment: 0, teamAdjustment: 0 }
    }),
    headToHead: { games: 6, awayWins: 2, homeWins: 4, awayProbability: 33.3, homeProbability: 66.7 },
    injuryProfiles: toKeyMap({
      113: [{ position: 'CF', status: '10-Day IL' }],
      120: []
    }),
    lineupProfiles: {
      away: { confirmed: true, count: 9, qualityScore: 0.45 },
      home: { confirmed: true, count: 9, qualityScore: 0.7 }
    },
    modelMemory: {
      teamBias: { '113': -0.02, '120': 0.03 },
      matchupMemory: {
        '113:120': {
          totalGames: 6,
          recentGames: [
            { dateYmd: '2026-06-01', winner: { id: 120 }, loser: { id: 113 }, margin: 2, correct: true }
          ],
          note: 'test memory'
        }
      }
    },
    rollingTeamStats: toKeyMap({
      113: { games: 10, hitting: { runs: 42, ops: '.700' }, pitching: { era: '4.40', whip: '1.36', homeRunsPer9: 1.2, strikeoutWalkRatio: 2.0 } },
      120: { games: 10, hitting: { runs: 48, ops: '.750' }, pitching: { era: '3.60', whip: '1.15', homeRunsPer9: 0.9, strikeoutWalkRatio: 2.6 } }
    }),
    evolutionControls: loadEvolutionControls(),
    parkFactorBaselines: new Map([[3, { runFactor: 1.08, homeRunFactor: 1.15 }]]),
    calibratePercent,
    nowMs: new Date('2026-07-21T12:00:00Z'),
    moneylineWeightMultiplierFn: moneylineWeightMultiplier
  };
}

function runCore(bundle) {
  return predictGameMoneylineCore(bundle);
}

const TOL = 1e-9;

// Compare the raw pre-sigmoid edge, not the clamped [35,65] probability: a
// strong bundle pins raw probability at the 65 ceiling, so a perturbation that
// further strengthens home is invisible in probability but still visible in the
// underlying edge. The edge is the honest signal that the family contributed.
function assertChanged(label, base, mutated) {
  const before = base.raw.edge;
  const after = mutated.raw.edge;
  assert.ok(
    Math.abs(before - after) > TOL,
    `${label}: expected raw edge to change (${before} -> ${after})`
  );
}

function assertUnchanged(label, base, mutated) {
  const before = base.raw.edge;
  const after = mutated.raw.edge;
  assert.ok(
    Math.abs(before - after) <= TOL,
    `${label}: expected raw edge to NOT change (${before} -> ${after})`
  );
}

test('feature-role manifest declares every collected family', () => {
  const required = [
    'team_season_basic', 'team_season_advanced', 'rolling_team_form',
    'probable_starter_season', 'probable_starter_recent', 'lineup',
    'bullpen_fatigue', 'schedule_fatigue', 'standings_and_splits',
    'weather', 'park_factor', 'head_to_head', 'matchup_memory',
    'team_platoon_splits', 'player_platoon', 'injuries', 'sharp_money',
    'statcast', 'batter_vs_pitcher', 'pitch_arsenal', 'travel_distance',
    'umpire', 'market_blend_weight'
  ];
  for (const family of required) {
    assert.ok(family in CONTROL_FEATURE_ROLES, `missing feature role: ${family}`);
  }
  for (const [family, role] of Object.entries(CONTROL_FEATURE_ROLES)) {
    assert.ok(
      ['active', 'defaulted', 'informational_only', 'unused'].includes(role),
      `invalid role for ${family}: ${role}`
    );
  }
});

test('active family: team_season_basic perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  bundle.teamStats = toKeyMap({
    113: { hitting: { gamesPlayed: 100, runs: 350, ops: '.680' }, pitching: { era: '5.20', whip: '1.50' }, hittingAdvanced: { iso: 0.12 }, pitchingAdvanced: {} },
    120: { hitting: { gamesPlayed: 100, runs: 520, ops: '.800' }, pitching: { era: '3.00', whip: '1.05' }, hittingAdvanced: { iso: 0.2 }, pitchingAdvanced: {} }
  });
  const mutated = runCore(bundle);
  assertChanged('team_season_basic', base, mutated);
});

test('active family: probable_starter_recent perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  // Reverse the starter edge: away SP dominant, home SP shelled.
  // (The default already favors home heavily and clamps at the ceiling;
  // reversing crosses zero so the edge actually moves.)
  bundle.pitcherRecentStarts = toKeyMap({
    605397: { innings: 30, era: '1.50', whip: '0.85', strikeouts: 45, walks: 4, homeRuns: 1, lastStartDate: '2026-07-16' },
    543037: { innings: 32, era: '7.50', whip: '1.90', strikeouts: 18, walks: 14, homeRuns: 9, lastStartDate: '2026-07-16' }
  });
  const mutated = runCore(bundle);
  assertChanged('probable_starter_recent', base, mutated);
});

test('active family: lineup perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  bundle.lineupProfiles = {
    away: { confirmed: true, count: 9, qualityScore: 0.85 },
    home: { confirmed: true, count: 9, qualityScore: 0.15 }
  };
  const mutated = runCore(bundle);
  assertChanged('lineup', base, mutated);
});

test('active family: bullpen_fatigue perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  // Reverse the fatigue direction: home bullpen exhausted, away rested.
  // (The default has away more fatigued, which already clamps at the +0.18
  // ceiling; reversing crosses zero so the edge actually moves.)
  bundle.bullpenProfiles = toKeyMap({
    113: { teamId: 113, fatigueScore: 0, backToBackRelievers: 0, highPitchRelievers: 0 },
    120: { teamId: 120, fatigueScore: 8, backToBackRelievers: 3, highPitchRelievers: 3 }
  });
  const mutated = runCore(bundle);
  assertChanged('bullpen_fatigue', base, mutated);
});

test('active family: schedule_fatigue perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  bundle.scheduleFatigueProfiles = toKeyMap({
    113: { restDays: 0, roadStreak: 10, recentGameCount: 10, doubleheaderLast3Days: true, fatigueLevel: 'high', offenseAdjustment: -0.05, teamAdjustment: -0.03 },
    120: { restDays: 5, roadStreak: 0, recentGameCount: 5, doubleheaderLast3Days: false, fatigueLevel: 'low', offenseAdjustment: 0, teamAdjustment: 0 }
  });
  const mutated = runCore(bundle);
  assertChanged('schedule_fatigue', base, mutated);
});

test('active family: weather perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  bundle.game = { ...bundle.game, weather: { temp: '34', wind: '25 mph, in' } };
  const mutated = runCore(bundle);
  assertChanged('weather', base, mutated);
});

test('active family: head_to_head perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  bundle.headToHead = { games: 6, awayWins: 5, homeWins: 1, awayProbability: 83.3, homeProbability: 16.7 };
  const mutated = runCore(bundle);
  assertChanged('head_to_head', base, mutated);
});

test('active family: matchup_memory perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  bundle.modelMemory = {
    teamBias: { '113': -0.06, '120': 0.06 },
    matchupMemory: {
      '113:120': {
        totalGames: 6,
        recentGames: [
          { dateYmd: '2026-06-01', winner: { id: 113 }, loser: { id: 120 }, margin: 5, correct: true }
        ],
        note: 'flipped memory'
      }
    }
  };
  const mutated = runCore(bundle);
  assertChanged('matchup_memory', base, mutated);
});

test('active family: team_platoon_splits perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  // Flip platoon splits: away strong vs LHP, home weak vs RHP.
  bundle.standings = toKeyMap({
    113: {
      leagueRecord: { wins: 50, losses: 50 },
      gamesPlayed: 100, runsScored: 430, runsAllowed: 440, runDifferential: -10,
      records: { splitRecords: [
        { type: 'lastTen', pct: 0.5 }, { type: 'home', pct: 0.52 }, { type: 'away', pct: 0.48 },
        { type: 'left', pct: 0.65 }, { type: 'right', pct: 0.45 }
      ]}
    },
    120: {
      leagueRecord: { wins: 55, losses: 45 },
      gamesPlayed: 100, runsScored: 470, runsAllowed: 420, runDifferential: 50,
      records: { splitRecords: [
        { type: 'lastTen', pct: 0.6 }, { type: 'home', pct: 0.58 }, { type: 'away', pct: 0.52 },
        { type: 'left', pct: 0.40 }, { type: 'right', pct: 0.54 }
      ]}
    }
  });
  const mutated = runCore(bundle);
  assertChanged('team_platoon_splits', base, mutated);
});

test('active family: injuries perturbation changes probability', () => {
  const base = runCore(richBundle());
  const bundle = richBundle();
  // Home team decimated by hitter injuries — enough to pull lineupEdge below
  // the [−0.18, 0.18] clamp ceiling the default sits at.
  bundle.injuryProfiles = toKeyMap({
    113: [],
    120: [
      { position: 'RF', status: 'IL' }, { position: '1B', status: 'IL' },
      { position: 'SS', status: 'IL' }, { position: 'C', status: 'IL' },
      { position: 'CF', status: 'IL' }, { position: 'LF', status: 'IL' },
      { position: '3B', status: 'IL' }, { position: '2B', status: 'IL' }
    ]
  });
  const mutated = runCore(bundle);
  assertChanged('injuries', base, mutated);
});

test('informational_only family: sharp_money field does not exist in core inputs', () => {
  // sharp_money is informational_only — the core has no input slot for it.
  const bundle = richBundle();
  const snapshot = buildCoreInputsSnapshot(bundle);
  assert.equal(snapshot.sharpMoney, undefined);
  assert.equal(snapshot.sharp_money, undefined);
});

test('unused families: statcast/arsenal/bvp/travel/umpire have no core input slot', () => {
  const bundle = richBundle();
  const snapshot = buildCoreInputsSnapshot(bundle);
  for (const field of ['statcast', 'pitchArsenal', 'batterVsPitcher', 'travelDistance', 'umpire']) {
    assert.equal(snapshot[field], undefined, `${field} should not be a core input`);
  }
});

test('coreInputs snapshot is plain JSON serializable (no Maps/functions)', () => {
  const bundle = richBundle();
  const snapshot = buildCoreInputsSnapshot(bundle);
  const json = JSON.stringify(snapshot);
  const parsed = JSON.parse(json);
  // Round-trip should not lose structure.
  assert.equal(parsed.game.gamePk, 778001);
  assert.equal(parsed.lineupProfiles.home.confirmed, true);
  assert.ok(Array.isArray(parsed.parkFactorBaselines));
});
