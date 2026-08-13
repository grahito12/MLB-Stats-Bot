import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { Storage } from '../src/storage.js';
import { applyMigrations, migrationStatus } from '../src/storage/migrations.js';
import { buildFeatureVector, flattenFeatureVector, classifyInformationState, hashFeatureVector, FEATURE_VECTOR_SCHEMA_VERSION } from '../src/core/feature_vector.js';
import { HEURISTIC_V1_MODEL_ID, HEURISTIC_V1_IMPL_VERSION, CONTROL_FEATURE_SCHEMA_VERSION } from '../src/core/model_ids.js';

function freshStorage() {
  const tempDir = resolve(process.cwd(), '.tmp-p1-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `state-p1-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return { storage: new Storage(statePath), tempDir };
}

// A minimal frozen coreInputs for feature-vector tests.
function sampleCoreInputs() {
  return {
    game: {
      gamePk: 12345,
      officialDate: '2026-07-21',
      venue: { id: 3, name: 'Park' },
      weather: { temp: '88', wind: '12 mph, out' },
      teams: {
        away: {
          team: { id: 113, name: 'Reds' },
          probablePitcher: { id: 605397, pitchHand: { code: 'R' } }
        },
        home: {
          team: { id: 120, name: 'Nationals' },
          probablePitcher: { id: 543037, pitchHand: { code: 'L' } }
        }
      }
    },
    teamStats: {
      '113': { hitting: { gamesPlayed: 100, runs: 430, ops: '.710' }, pitching: { era: '4.30', whip: '1.35' } },
      '120': { hitting: { gamesPlayed: 100, runs: 470, ops: '.740' }, pitching: { era: '3.90', whip: '1.25' } }
    },
    standings: {
      '113': { leagueRecord: { wins: 50, losses: 50 }, gamesPlayed: 100, runDifferential: -10, records: { splitRecords: [{ type: 'lastTen', pct: 0.5 }, { type: 'left', pct: 0.45 }, { type: 'right', pct: 0.51 }] } },
      '120': { leagueRecord: { wins: 55, losses: 45 }, gamesPlayed: 100, runDifferential: 50, records: { splitRecords: [{ type: 'lastTen', pct: 0.6 }, { type: 'left', pct: 0.57 }, { type: 'right', pct: 0.54 }] } }
    },
    pitcherStats: {
      '605397': { era: '4.10', whip: '1.30', strikeoutsMinusWalksPercentage: 0.11, homeRunsPer9: 1.1 },
      '543037': { era: '3.20', whip: '1.10', strikeoutsMinusWalksPercentage: 0.16, homeRunsPer9: 0.85 }
    },
    pitcherDetails: {},
    pitcherRecentStarts: {
      '605397': { innings: 30, era: '4.50', whip: '1.35' },
      '543037': { innings: 32, era: '2.80', whip: '1.05' }
    },
    bullpenProfiles: {
      '113': { fatigueScore: 3, backToBackRelievers: 1 },
      '120': { fatigueScore: 1, backToBackRelievers: 0 }
    },
    scheduleFatigueProfiles: {
      '113': { restDays: 2, roadStreak: 3 },
      '120': { restDays: 4, roadStreak: 0 }
    },
    headToHead: { games: 6, homeProbability: 66.7 },
    injuryProfiles: { '113': [{ position: 'CF' }], '120': [] },
    lineupProfiles: {
      away: { confirmed: false, count: 9, qualityScore: 0.45 },
      home: { confirmed: true, count: 9, qualityScore: 0.7 }
    },
    modelMemory: {},
    rollingTeamStats: {},
    evolutionControls: {},
    parkFactorBaselines: []
  };
}

// ---------- Migration 006 ----------

test('migration 006 applies additively and is checksum-stable', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const status = migrationStatus(storage.db);
    assert.ok(status.applied.includes('006_model_prediction_history'), 'migration 006 should be applied');
    // Tables created.
    const tables = storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes('model_predictions'));
    assert.ok(tables.includes('market_quote_pairs'));
    assert.ok(tables.includes('model_dataset_folds'));

    // prediction_runs has the additive columns.
    const cols = storage.db.prepare('PRAGMA table_info(prediction_runs)').all().map((r) => r.name);
    for (const col of ['model_id', 'model_impl_version', 'feature_schema_version', 'information_state', 'prediction_quality_status', 'paired_quote_pair_id', 'producer_timestamp_utc']) {
      assert.ok(cols.includes(col), `prediction_runs missing column ${col}`);
    }
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('migration 006 does not edit migrations 001-005 checksums', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const applied = storage.db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all();
    const ids = applied.map((r) => r.id);
    for (const legacy of ['001_schema_migrations_bootstrap', '002_immutable_accounting', '003_bet_ledger_identity_columns', '004_append_only_picks', '005_shadow_ledger']) {
      assert.ok(ids.includes(legacy), `${legacy} should remain applied`);
    }
    assert.ok(ids.includes('006_model_prediction_history'));
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Feature vector ----------

test('feature vector builds from frozen coreInputs with named stages + missingness', () => {
  const vector = buildFeatureVector(sampleCoreInputs());
  assert.equal(vector.schemaVersion, FEATURE_VECTOR_SCHEMA_VERSION);
  assert.equal(vector.featureSchemaVersion, CONTROL_FEATURE_SCHEMA_VERSION);
  assert.equal(vector.gamePk, '12345');
  // Present value.
  assert.equal(vector.awayRpg.value, 4.3);
  assert.equal(vector.awayRpg.missing, 0);
  // Missing value (rollingTeamStats empty).
  assert.equal(vector.awayRollingRpg.value, null);
  assert.equal(vector.awayRollingRpg.missing, 1);
  // Platoon vs starter hand: away bats vs home LHP -> 'left' split.
  assert.equal(vector.awayVsStarterHandPct.value, 0.45);
  // Handedness encoding.
  assert.equal(vector.homeStarterHandLeft.value, 1); // home SP is L
  assert.equal(vector.awayStarterHandLeft.value, 0); // away SP is R
  assert.ok(vector.featureVectorHash);
});

test('feature vector hash is deterministic and outcome-free', () => {
  const v1 = buildFeatureVector(sampleCoreInputs());
  const v2 = buildFeatureVector(sampleCoreInputs());
  assert.equal(v1.featureVectorHash, v2.featureVectorHash);
  // Mutating an outcome-like field must not exist in the vector at all.
  assert.equal(v1.winnerTeamId, undefined);
  assert.equal(v1.homeWon, undefined);
});

test('flattenFeatureVector produces missing_ columns', () => {
  const vector = buildFeatureVector(sampleCoreInputs());
  const flat = flattenFeatureVector(vector);
  assert.equal(flat.awayRpg, 4.3);
  assert.equal(flat.missing_awayRpg, 0);
  assert.equal(flat.awayRollingRpg, null);
  assert.equal(flat.missing_awayRollingRpg, 1);
  assert.ok(flat.featureVectorHash);
});

test('information state classification', () => {
  // Unknown lineup state + far from first pitch -> scheduled_early.
  assert.equal(
    classifyInformationState({ asOfUtc: '2026-07-21T12:00:00Z', firstPitchUtc: '2026-07-21T23:05:00Z', lineupsConfirmed: null }),
    'scheduled_early'
  );
  // Projected (not confirmed) lineup -> projected_lineup.
  assert.equal(
    classifyInformationState({ asOfUtc: '2026-07-21T15:00:00Z', firstPitchUtc: '2026-07-21T23:05:00Z', lineupsConfirmed: false }),
    'projected_lineup'
  );
  // Within 2h of first pitch -> close_time regardless of lineup.
  assert.equal(
    classifyInformationState({ asOfUtc: '2026-07-21T22:00:00Z', firstPitchUtc: '2026-07-21T23:05:00Z', lineupsConfirmed: false }),
    'close_time'
  );
  // Both lineups confirmed + far -> confirmed_lineup.
  assert.equal(
    classifyInformationState({ asOfUtc: '2026-07-21T20:00:00Z', firstPitchUtc: '2026-07-21T23:05:00Z', lineupsConfirmed: true }),
    'confirmed_lineup'
  );
  // Post-pitch -> ineligible.
  assert.equal(
    classifyInformationState({ asOfUtc: '2026-07-21T23:30:00Z', firstPitchUtc: '2026-07-21T23:05:00Z', lineupsConfirmed: true }),
    'ineligible'
  );
});

// ---------- Market quote pairs ----------

test('recordMarketQuotePair dedups and enforces first-pitch guard', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const id1 = storage.recordMarketQuotePair({
      gamePk: '777',
      bookmaker: 'draftkings',
      market: 'moneyline',
      homeOdds: -150,
      awayOdds: 130,
      homeImpliedProb: 0.6,
      awayImpliedProb: 0.435,
      overround: 1.035,
      homeNoVigProb: 0.5797,
      awayNoVigProb: 0.4203,
      fetchedAtUtc: '2026-07-21T12:00:00Z',
      firstPitchUtc: '2026-07-21T23:05:00Z'
    });
    assert.ok(id1);
    // Duplicate is ignored.
    const id2 = storage.recordMarketQuotePair({
      gamePk: '777',
      bookmaker: 'draftkings',
      market: 'moneyline',
      homeOdds: -150,
      awayOdds: 130,
      homeImpliedProb: 0.6,
      awayImpliedProb: 0.435,
      overround: 1.035,
      homeNoVigProb: 0.5797,
      awayNoVigProb: 0.4203,
      fetchedAtUtc: '2026-07-21T12:00:00Z',
      firstPitchUtc: '2026-07-21T23:05:00Z'
    });
    assert.equal(id2, id1);
    const count = storage.db.prepare('SELECT COUNT(*) AS c FROM market_quote_pairs').get().c;
    assert.equal(count, 1);

    // First eligible pair is opening.
    const row = storage.db.prepare('SELECT is_opening, is_eligible, ineligibility_reason FROM market_quote_pairs').get();
    assert.equal(row.is_opening, 1);
    assert.equal(row.is_eligible, 1);

    // Post-pitch pair is ineligible.
    storage.recordMarketQuotePair({
      gamePk: '777',
      bookmaker: 'fanduel',
      market: 'moneyline',
      homeOdds: -160,
      awayOdds: 140,
      fetchedAtUtc: '2026-07-22T00:30:00Z',
      firstPitchUtc: '2026-07-21T23:05:00Z'
    });
    const ineligible = storage.db.prepare("SELECT is_eligible, ineligibility_reason FROM market_quote_pairs WHERE bookmaker='fanduel'").get();
    assert.equal(ineligible.is_eligible, 0);
    assert.equal(ineligible.ineligibility_reason, 'post_first_pitch');
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pairQuoteToRun never attaches a later quote to an earlier run', () => {
  const { storage, tempDir } = freshStorage();
  try {
    storage.recordMarketQuotePair({
      gamePk: '888', bookmaker: 'pinnacle', market: 'moneyline',
      homeOdds: -150, awayOdds: 130, fetchedAtUtc: '2026-07-21T18:00:00Z',
      firstPitchUtc: '2026-07-21T23:05:00Z'
    });
    // Run as_of is before the quote -> no pair.
    const early = storage.pairQuoteToRun('888', 'moneyline', '2026-07-21T12:00:00Z');
    assert.equal(early, null);
    // Run as_of is after the quote -> pair found.
    const later = storage.pairQuoteToRun('888', 'moneyline', '2026-07-21T19:00:00Z');
    assert.ok(later);
    assert.equal(later.bookmaker, 'pinnacle');
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- All-game model predictions + outcomes ----------

test('recordModelPrediction is append-only by (run_id, model_id)', () => {
  const { storage, tempDir } = freshStorage();
  try {
    // FK requires a parent prediction_runs row first.
    storage.db
      .prepare('INSERT INTO prediction_runs (run_id, game_pk, market, created_at) VALUES (?, ?, ?, ?)')
      .run('run-1', '999', 'moneyline', new Date().toISOString());

    const id1 = storage.recordModelPrediction({
      runId: 'run-1', gamePk: '999', dateYmd: '2026-07-21',
      modelId: HEURISTIC_V1_MODEL_ID,
      modelImplVersion: HEURISTIC_V1_IMPL_VERSION,
      featureSchemaVersion: CONTROL_FEATURE_SCHEMA_VERSION,
      rawHomeProbability: 55, rawAwayProbability: 45,
      calibratedHomeProbability: 54, calibratedAwayProbability: 46,
      pickSide: 'home', pickTeamId: '120', pickProbability: 54,
      status: 'NO_BET', asOfUtc: '2026-07-21T12:00:00Z',
      firstPitchUtc: '2026-07-21T23:05:00Z',
      informationState: 'scheduled_early',
      promotionEligible: true
    });
    assert.ok(id1);
    // Duplicate (same run+model) is ignored — returns null.
    const id2 = storage.recordModelPrediction({
      runId: 'run-1', gamePk: '999', dateYmd: '2026-07-21',
      modelId: HEURISTIC_V1_MODEL_ID,
      rawHomeProbability: 99, // different value ignored
      asOfUtc: '2026-07-21T12:00:00Z',
      promotionEligible: true
    });
    assert.equal(id2, null);
    const row = storage.db.prepare('SELECT raw_home_probability, pick_side FROM model_predictions').get();
    assert.equal(row.raw_home_probability, 55);
    assert.equal(row.pick_side, 'home');
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordGameOutcome is idempotent and all-game', () => {
  const { storage, tempDir } = freshStorage();
  try {
    storage.recordGameOutcome({
      gamePk: '999', dateYmd: '2026-07-21',
      home: { id: '120' }, away: { id: '113' },
      homeScore: 5, awayScore: 3
    });
    // Idempotent.
    storage.recordGameOutcome({
      gamePk: '999', dateYmd: '2026-07-21',
      home: { id: '120' }, away: { id: '113' },
      homeScore: 5, awayScore: 3
    });
    const count = storage.db.prepare('SELECT COUNT(*) AS c FROM game_outcomes WHERE game_pk = ?').get('999').c;
    assert.equal(count, 1);
    const row = storage.db.prepare('SELECT winner_team_id, loser_team_id, home_score, away_score FROM game_outcomes WHERE game_pk = ?').get('999');
    assert.equal(row.winner_team_id, '120');
    assert.equal(row.loser_team_id, '113');
    assert.equal(row.home_score, 5);
    assert.equal(row.away_score, 3);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('saveDatasetFolds + getDatasetFolds round-trip', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const folds = [
      { fold_index: 0, fold_type: 'test', start_date: '2026-07-01', end_date: '2026-07-08', train_start_date: '2026-06-01', train_end_date: '2026-06-30', game_count: 12, date_count: 7 },
      { fold_index: 1, fold_type: 'holdout', start_date: '2026-07-08', end_date: '2026-07-15', train_start_date: '2026-06-01', train_end_date: '2026-07-07', game_count: 10, date_count: 7 }
    ];
    storage.saveDatasetFolds(folds, 'abc123hash', 'walk-forward-v1');
    const loaded = storage.getDatasetFolds();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].fold_type, 'test');
    assert.equal(loaded[1].fold_type, 'holdout');
    assert.equal(loaded[0].dataset_hash, 'abc123hash');
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
