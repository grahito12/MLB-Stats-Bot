import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

import { Storage } from '../src/storage.js';
import {
  buildFeatureVector,
  flattenFeatureVector,
  FEATURE_VECTOR_SCHEMA_VERSION
} from '../src/core/feature_vector.js';
import {
  LEARNED_V2_LOGISTIC_MODEL_ID,
  LEARNED_V2_LOGISTIC_IMPL_VERSION,
  HEURISTIC_V1_MODEL_ID,
  DEFAULT_MODEL_VERSION,
  DEFAULT_SHADOW_MODE,
  MODEL_ARTIFACTS_DIR
} from '../src/core/model_ids.js';
import {
  verifyLearnedV2Artifact,
  scoreLearnedV2Logistic,
  hashArtifactContent
} from '../src/core/learned_v2_logistic.js';
import {
  readModelRegistryConfig,
  loadChallengerArtifact,
  scoreShadowChallengers
} from '../src/core/model_registry.js';

// Reuse the same minimal frozen coreInputs shape as the P1 tests.
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

// The ordered feature names the trainer uses (must match Python).
const FEATURE_NAMES = [
  'awayRpg', 'awayOps', 'homeRpg', 'homeOps', 'awayTeamGames', 'homeTeamGames',
  'awayEra', 'awayWhip', 'homeEra', 'homeWhip',
  'awayRollingRpg', 'awayRollingOps', 'homeRollingRpg', 'homeRollingOps',
  'awayRollingGames', 'homeRollingGames',
  'awayWinPct', 'homeWinPct', 'awayLastTenPct', 'homeLastTenPct',
  'awayRunDiffPerGame', 'homeRunDiffPerGame',
  'awayVsStarterHandPct', 'homeVsStarterHandPct',
  'awayStarterEra', 'awayStarterWhip', 'homeStarterEra', 'homeStarterWhip',
  'awayStarterKMinusBb', 'homeStarterKMinusBb', 'awayStarterHr9', 'homeStarterHr9',
  'awayStarterRecentEra', 'awayStarterRecentWhip', 'awayStarterRecentInnings',
  'homeStarterRecentEra', 'homeStarterRecentWhip', 'homeStarterRecentInnings',
  'awayBullpenFatigue', 'homeBullpenFatigue',
  'awayBullpenBackToBack', 'homeBullpenBackToBack',
  'awayRestDays', 'homeRestDays', 'awayRoadStreak', 'homeRoadStreak',
  'awayLineupConfirmed', 'homeLineupConfirmed',
  'awayLineupQuality', 'homeLineupQuality',
  'awayLineupCount', 'homeLineupCount',
  'awayInjuryCount', 'homeInjuryCount',
  'h2hGames', 'h2hHomeWinPct',
  'temperature', 'windSpeed', 'windHittingOut', 'windHittingIn',
  'awayStarterHandLeft', 'homeStarterHandLeft'
];

function freshStorage() {
  const tempDir = resolve(process.cwd(), `.tmp-p2-tests-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, 'state-p2.json');
  return { storage: new Storage(statePath), tempDir };
}

/**
 * Build a minimal but internally-consistent artifact by hand. Coefficients and
 * scaling are arbitrary but valid; the point is to exercise the JS inference +
 * registry paths, not to assert prediction quality.
 */
function makeArtifact() {
  const flat = flattenFeatureVector(buildFeatureVector(sampleCoreInputs()));
  const imputation = {};
  const feature_mean = {};
  const feature_std = {};
  const coefficients = {};
  for (const name of FEATURE_NAMES) {
    const v = flat[name];
    imputation[name] = typeof v === 'number' && Number.isFinite(v) ? v : 0.0;
    feature_mean[name] = 0.0;
    feature_std[name] = 1.0;
    coefficients[name] = 0.0;
  }
  // Give one feature a nonzero coefficient so the logit is nontrivial.
  coefficients.homeWinPct = 1.5;
  const content = {
    artifact_manifest_version: 'learned-v2-logistic-artifact-v1',
    model_id: LEARNED_V2_LOGISTIC_MODEL_ID,
    model_impl_version: LEARNED_V2_LOGISTIC_IMPL_VERSION,
    feature_schema_version: FEATURE_VECTOR_SCHEMA_VERSION,
    feature_names: FEATURE_NAMES,
    coefficients,
    intercept: -0.2,
    imputation,
    feature_mean,
    feature_std,
    l2_strength: 0.1,
    cohort: 'main',
    dataset_hash: 'deadbeef',
    training_cutoff: '2026-08-01',
    train_rows: 100,
    pos_events: 55,
    neg_events: 45,
    oof_metrics: { brier: 0.24, log_loss: 0.68, accuracy: 0.55, n: 40 },
    oof_row_count: 40,
    fold_count: 5,
    gates: { min_train_rows_per_fold: 60, min_events_per_class: 10 }
  };
  content.artifact_hash = hashArtifactContent(content);
  return content;
}

// ---------- Registry config ----------

test('model registry defaults preserve control behavior', () => {
  delete process.env.MLB_MODEL_VERSION;
  delete process.env.MLB_SHADOW_MODE;
  const cfg = readModelRegistryConfig();
  assert.equal(cfg.modelVersion, DEFAULT_MODEL_VERSION);
  assert.equal(cfg.modelVersion, HEURISTIC_V1_MODEL_ID);
  assert.equal(cfg.shadowMode, DEFAULT_SHADOW_MODE);
  assert.equal(cfg.shadowMode, false);
});

test('MLB_SHADOW_MODE env is parsed but never mutates process.env', () => {
  const before = process.env.MLB_SHADOW_MODE;
  process.env.MLB_SHADOW_MODE = 'true';
  try {
    const cfg = readModelRegistryConfig();
    assert.equal(cfg.shadowMode, true);
    // env still the literal string, not coerced
    assert.equal(process.env.MLB_SHADOW_MODE, 'true');
  } finally {
    if (before === undefined) delete process.env.MLB_SHADOW_MODE;
    else process.env.MLB_SHADOW_MODE = before;
  }
});

// ---------- Artifact verification ----------

test('verifyLearnedV2Artifact accepts a well-formed artifact', () => {
  const a = makeArtifact();
  const v = verifyLearnedV2Artifact(a);
  assert.ok(v.ok, `expected ok, got: ${v.reasons.join(';')}`);
});

test('verifyLearnedV2Artifact rejects tampered coefficients (hash mismatch)', () => {
  const a = makeArtifact();
  a.coefficients.homeWinPct = 99.0; // tamper without updating hash
  const v = verifyLearnedV2Artifact(a);
  assert.ok(!v.ok);
  assert.ok(v.reasons.includes('artifact_hash_mismatch'));
});

test('verifyLearnedV2Artifact rejects incompatible model_id', () => {
  const a = makeArtifact();
  a.model_id = 'some_other_model';
  const v = verifyLearnedV2Artifact(a);
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => r.startsWith('model_id_mismatch')));
});

// ---------- Inference ----------

test('scoreLearnedV2Logistic returns a probability in [0,1] for a complete vector', () => {
  const a = makeArtifact();
  const flat = flattenFeatureVector(buildFeatureVector(sampleCoreInputs()));
  const scored = scoreLearnedV2Logistic(a, flat);
  assert.ok(scored.available, `expected available, reasons: ${scored.reasons.join(';')}`);
  assert.ok(scored.homeProbability >= 0 && scored.homeProbability <= 1);
  assert.ok(scored.awayProbability >= 0 && scored.awayProbability <= 1);
  assert.ok(Math.abs(scored.homeProbability + scored.awayProbability - 1) < 1e-9);
  assert.equal(typeof scored.logit, 'number');
});

test('scoreLearnedV2Logistic returns unavailable when a feature lacks imputation', () => {
  const a = makeArtifact();
  // Remove imputation for one feature so a missing cell cannot be filled.
  delete a.imputation.homeWinPct;
  // Tamper-without-rehash is irrelevant here; verification is a separate path.
  const flat = flattenFeatureVector(buildFeatureVector(sampleCoreInputs()));
  // Force the cell missing so the imputation path is exercised.
  flat.homeWinPct = null;
  flat.missing_homeWinPct = 1;
  const scored = scoreLearnedV2Logistic(a, flat);
  assert.ok(!scored.available);
  assert.ok(scored.reasons.some((r) => r.includes('missing_features_without_imputation')));
  assert.equal(scored.homeProbability, null);
});

// ---------- Shadow orchestrator ----------

test('scoreShadowChallengers is a no-op when shadow mode is off', () => {
  delete process.env.MLB_SHADOW_MODE;
  const prediction = { coreInputs: sampleCoreInputs(), runId: 'run-1', gamePk: 12345 };
  const results = scoreShadowChallengers(prediction);
  assert.equal(results.length, 0);
});

test('scoreShadowChallengers returns no_compatible_artifact when shadow on but no artifact', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'p2-shadow-'));
  process.env.MLB_SHADOW_MODE = 'true';
  try {
    const prediction = { coreInputs: sampleCoreInputs(), runId: 'run-1', gamePk: 12345 };
    const results = scoreShadowChallengers(prediction, { artifactsDir: tempDir });
    // Both challengers are scored; both lack an artifact in the empty tempDir.
    assert.equal(results.length, 2);
    const lr = results.find((r) => r.modelId === LEARNED_V2_LOGISTIC_MODEL_ID);
    assert.ok(lr, 'learned_v2_logistic result should exist');
    assert.equal(lr.entry, null);
    assert.ok(lr.reason.includes('no_compatible_artifact') || lr.reason.includes('no_frozen'));
  } finally {
    delete process.env.MLB_SHADOW_MODE;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('scoreShadowChallengers produces a challenger entry when shadow on + artifact present', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'p2-shadow-'));
  const a = makeArtifact();
  // loadChallengerArtifact reads the inner artifact if wrapped in a report.
  writeFileSync(join(tempDir, 'learned_v2_logistic-trained.json'), JSON.stringify({ status: 'trained', artifact: a, artifact_hash: a.artifact_hash }));
  process.env.MLB_SHADOW_MODE = 'true';
  try {
    const prediction = {
      coreInputs: sampleCoreInputs(),
      runId: 'run-12345-abc',
      gamePk: 12345,
      dateYmd: '2026-07-21',
      asOfUtc: '2026-07-21T17:00:00Z',
      startTime: '2026-07-21T23:05:00Z',
      home: { id: 120 },
      away: { id: 113 }
    };
    const results = scoreShadowChallengers(prediction, { artifactsDir: tempDir });
    // Both challengers are scored; learned_v2 has an artifact, market_residual_v2
    // does not (no market quote in this prediction either).
    assert.equal(results.length, 2);
    const lr = results.find((r) => r.modelId === LEARNED_V2_LOGISTIC_MODEL_ID);
    assert.ok(lr, 'learned_v2_logistic result should exist');
    assert.ok(lr.entry, `expected entry, reason was: ${lr.reason}`);
    const e = lr.entry;
    assert.equal(e.modelId, LEARNED_V2_LOGISTIC_MODEL_ID);
    assert.equal(e.modelImplVersion, LEARNED_V2_LOGISTIC_IMPL_VERSION);
    assert.equal(e.runId, 'run-12345-abc');
    assert.equal(e.status, 'SHADOW');
    assert.equal(e.promotionEligible, false);
    assert.equal(e.displayHomeProbability, null); // never overwrites control display
    assert.equal(e.calibrationStatus, 'identity');
    assert.ok(e.rawHomeProbability >= 0 && e.rawHomeProbability <= 1);
    assert.ok(Math.abs(e.rawHomeProbability + e.rawAwayProbability - 1) < 1e-9);
  } finally {
    delete process.env.MLB_SHADOW_MODE;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Feature-vector persistence in prediction_runs ----------

test('capturePredictionSnapshot persists normalized_feature_vector + feature_hash into prediction_runs', () => {
  const { storage, tempDir } = freshStorage();
  try {
    const pred = {
      gamePk: 7002,
      dateYmd: '2026-07-21',
      status: 'Scheduled',
      startTime: '2026-07-21T23:05:00Z',
      asOfUtc: '2026-07-21T17:00:00Z',
      predictionTimestampUtc: '2026-07-21T17:00:00Z',
      home: { id: 120 },
      away: { id: 113 },
      home: { id: 120, rawBaseballProbability: 53, pureModelProbability: 53, displayProbability: 52 },
      away: { id: 113, rawBaseballProbability: 47, pureModelProbability: 47, displayProbability: 48 },
      modelId: HEURISTIC_V1_MODEL_ID,
      coreInputs: sampleCoreInputs(),
      modelBreakdown: { pureHomeProbability: 53, pureAwayProbability: 47 }
    };
    storage.savePredictions('2026-07-21', [pred]);

    const run = storage.db
      .prepare('SELECT * FROM prediction_runs WHERE game_pk = ?')
      .get('7002');
    assert.ok(run, 'prediction_runs row should exist');
    assert.ok(run.feature_hash, 'feature_hash should be populated');
    assert.ok(run.normalized_feature_vector, 'normalized_feature_vector should be populated');
    assert.equal(run.feature_manifest_version, FEATURE_VECTOR_SCHEMA_VERSION);
    assert.ok(run.core_inputs_hash, 'core_inputs_hash should be populated');

    const fv = JSON.parse(run.normalized_feature_vector);
    assert.equal(fv.featureVectorHash, run.feature_hash);
    assert.equal(fv.homeWinPct, 0.55); // 55/(55+45)
    assert.equal(fv.awayWinPct, 0.5);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Shadow-off byte compatibility ----------

test('shadow mode off leaves only the control heuristic_v1 row in model_predictions', () => {
  const { storage, tempDir } = freshStorage();
  delete process.env.MLB_SHADOW_MODE;
  try {
    const pred = {
      gamePk: 7003,
      dateYmd: '2026-07-21',
      status: 'Scheduled',
      startTime: '2026-07-21T23:05:00Z',
      asOfUtc: '2026-07-21T17:00:00Z',
      predictionTimestampUtc: '2026-07-21T17:00:00Z',
      home: { id: 120 },
      away: { id: 113 },
      home: { id: 120, rawBaseballProbability: 53, pureModelProbability: 53, displayProbability: 52 },
      away: { id: 113, rawBaseballProbability: 47, pureModelProbability: 47, displayProbability: 48 },
      modelId: HEURISTIC_V1_MODEL_ID,
      coreInputs: sampleCoreInputs(),
      modelBreakdown: { pureHomeProbability: 53, pureAwayProbability: 47 }
    };
    storage.savePredictions('2026-07-21', [pred]);

    const rows = storage.db
      .prepare('SELECT model_id FROM model_predictions WHERE game_pk = ?')
      .all('7003');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model_id, HEURISTIC_V1_MODEL_ID);
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Shadow-on persists challenger row ----------

test('shadow mode on with artifact persists a learned_v2_logistic row alongside control', () => {
  const { storage, tempDir } = freshStorage();
  // Point the registry at an artifacts dir that has a compatible artifact.
  const artifactsDir = mkdtempSync(join(tmpdir(), 'p2-artifacts-'));
  const a = makeArtifact();
  writeFileSync(join(artifactsDir, 'learned_v2_logistic-trained.json'), JSON.stringify({ status: 'trained', artifact: a, artifact_hash: a.artifact_hash }));

  process.env.MLB_SHADOW_MODE = 'true';
  // The registry reads MODEL_ARTIFACTS_DIR by default; override via env to the
  // temp dir so savePredictions finds the artifact.
  process.env.MLB_MODEL_ARTIFACTS_DIR = artifactsDir;
  try {
    const pred = {
      gamePk: 7004,
      dateYmd: '2026-07-21',
      status: 'Scheduled',
      startTime: '2026-07-21T23:05:00Z',
      asOfUtc: '2026-07-21T17:00:00Z',
      predictionTimestampUtc: '2026-07-21T17:00:00Z',
      home: { id: 120 },
      away: { id: 113 },
      home: { id: 120, rawBaseballProbability: 53, pureModelProbability: 53, displayProbability: 52 },
      away: { id: 113, rawBaseballProbability: 47, pureModelProbability: 47, displayProbability: 48 },
      modelId: HEURISTIC_V1_MODEL_ID,
      coreInputs: sampleCoreInputs(),
      modelBreakdown: { pureHomeProbability: 53, pureAwayProbability: 47 }
    };
    storage.savePredictions('2026-07-21', [pred]);

    const rows = storage.db
      .prepare('SELECT model_id, status, promotion_eligible, display_home_probability FROM model_predictions WHERE game_pk = ? ORDER BY model_id')
      .all('7004');
    const modelIds = rows.map((r) => r.model_id);
    assert.ok(modelIds.includes(HEURISTIC_V1_MODEL_ID), 'control row should exist');
    assert.ok(modelIds.includes(LEARNED_V2_LOGISTIC_MODEL_ID), 'challenger row should exist');
    const challenger = rows.find((r) => r.model_id === LEARNED_V2_LOGISTIC_MODEL_ID);
    assert.equal(challenger.status, 'SHADOW');
    assert.equal(challenger.promotion_eligible, 0);
    assert.equal(challenger.display_home_probability, null); // control display untouched
  } finally {
    delete process.env.MLB_SHADOW_MODE;
    delete process.env.MLB_MODEL_ARTIFACTS_DIR;
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});
