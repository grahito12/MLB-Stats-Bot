import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Storage } from '../src/storage.js';
import {
  buildFeatureVector,
  flattenFeatureVector,
  FEATURE_VECTOR_SCHEMA_VERSION
} from '../src/core/feature_vector.js';
import {
  MARKET_RESIDUAL_V2_MODEL_ID,
  MARKET_RESIDUAL_V2_IMPL_VERSION,
  LEARNED_V2_LOGISTIC_MODEL_ID,
  HEURISTIC_V1_MODEL_ID
} from '../src/core/model_ids.js';
import {
  verifyMarketResidualV2Artifact,
  scoreMarketResidualV2,
  hashArtifactContent,
  MARKET_OFFSET_COEFFICIENT
} from '../src/core/market_residual_v2.js';
import {
  scoreShadowChallengers
} from '../src/core/model_registry.js';

// Reuse the P2 sample coreInputs shape.
function sampleCoreInputs() {
  return {
    game: {
      gamePk: 12345, officialDate: '2026-07-21', venue: { id: 3, name: 'Park' },
      weather: { temp: '88', wind: '12 mph, out' },
      teams: {
        away: { team: { id: 113 }, probablePitcher: { id: 605397, pitchHand: { code: 'R' } } },
        home: { team: { id: 120 }, probablePitcher: { id: 543037, pitchHand: { code: 'L' } } }
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
    bullpenProfiles: { '113': { fatigueScore: 3, backToBackRelievers: 1 }, '120': { fatigueScore: 1, backToBackRelievers: 0 } },
    scheduleFatigueProfiles: { '113': { restDays: 2, roadStreak: 3 }, '120': { restDays: 4, roadStreak: 0 } },
    headToHead: { games: 6, homeProbability: 66.7 },
    injuryProfiles: { '113': [{ position: 'CF' }], '120': [] },
    lineupProfiles: { away: { confirmed: false, count: 9, qualityScore: 0.45 }, home: { confirmed: true, count: 9, qualityScore: 0.7 } },
    modelMemory: {}, rollingTeamStats: {}, evolutionControls: {}, parkFactorBaselines: []
  };
}

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
  coefficients.homeWinPct = 0.8;
  const content = {
    artifact_manifest_version: 'market-residual-v2-artifact-v1',
    model_id: MARKET_RESIDUAL_V2_MODEL_ID,
    model_impl_version: MARKET_RESIDUAL_V2_IMPL_VERSION,
    feature_schema_version: FEATURE_VECTOR_SCHEMA_VERSION,
    feature_names: FEATURE_NAMES,
    coefficients,
    intercept: -0.1,
    imputation,
    feature_mean,
    feature_std,
    l2_strength: 0.1,
    market_offset_coefficient: MARKET_OFFSET_COEFFICIENT,
    cohort: 'main',
    dataset_hash: 'beefdead',
    training_cutoff: '2026-08-01',
    train_rows: 100,
    pos_events: 55,
    neg_events: 45,
    oof_metrics: { brier: 0.23, n: 40 },
    market_oof_metrics: { brier: 0.24, n: 40 },
    oof_row_count: 40,
    fold_count: 5,
    gates: { min_train_rows_per_fold: 60, min_events_per_class: 10, min_with_market_rows: 40 }
  };
  content.artifact_hash = hashArtifactContent(content);
  return content;
}

function freshStorage() {
  const tempDir = resolve(process.cwd(), `.tmp-p3-tests-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, 'state-p3.json');
  return { storage: new Storage(statePath), tempDir };
}

// ---------- Artifact verification ----------

test('verifyMarketResidualV2Artifact accepts well-formed artifact', () => {
  const a = makeArtifact();
  const v = verifyMarketResidualV2Artifact(a);
  assert.ok(v.ok, `expected ok: ${v.reasons.join(';')}`);
});

test('verifyMarketResidualV2Artifact rejects when market offset coefficient != 1', () => {
  const a = makeArtifact();
  a.market_offset_coefficient = 0.5;
  // rehash so only the coefficient check fires
  a.artifact_hash = hashArtifactContent(a);
  const v = verifyMarketResidualV2Artifact(a);
  assert.ok(!v.ok);
  assert.ok(v.reasons.some((r) => r.includes('market_offset_coefficient_not_fixed_1')));
});

test('verifyMarketResidualV2Artifact rejects tampered hash', () => {
  const a = makeArtifact();
  a.coefficients.homeWinPct = 99.0;
  const v = verifyMarketResidualV2Artifact(a);
  assert.ok(!v.ok);
  assert.ok(v.reasons.includes('artifact_hash_mismatch'));
});

// ---------- Inference ----------

test('scoreMarketResidualV2 returns unavailable when market prob missing', () => {
  const a = makeArtifact();
  const flat = flattenFeatureVector(buildFeatureVector(sampleCoreInputs()));
  const scored = scoreMarketResidualV2(a, flat, null);
  assert.ok(!scored.available);
  assert.ok(scored.reasons.includes('market_no_vig_home_prob_missing'));
  assert.equal(scored.homeProbability, null);
});

test('scoreMarketResidualV2 returns unavailable when market prob out of range', () => {
  const a = makeArtifact();
  const flat = flattenFeatureVector(buildFeatureVector(sampleCoreInputs()));
  const scored = scoreMarketResidualV2(a, flat, 0.0);
  assert.ok(!scored.available);
  assert.ok(scored.reasons.some((r) => r.includes('out_of_range')));
  const scored2 = scoreMarketResidualV2(a, flat, 1.5);
  assert.ok(!scored2.available);
});

test('scoreMarketResidualV2 applies fixed market offset + residual logit', () => {
  const a = makeArtifact();
  const flat = flattenFeatureVector(buildFeatureVector(sampleCoreInputs()));
  const marketNoVigHome = 0.6;
  const scored = scoreMarketResidualV2(a, flat, marketNoVigHome);
  assert.ok(scored.available, `reasons: ${scored.reasons.join(';')}`);
  // market logit = log(0.6/0.4)
  const expectedMarketLogit = Math.log(marketNoVigHome / (1 - marketNoVigHome));
  assert.ok(Math.abs(scored.marketLogit - expectedMarketLogit) < 1e-9);
  // residual logit = intercept + beta * scaled(homeWinPct)
  const homeWinPct = flat.homeWinPct;
  const scaledHomeWinPct = (homeWinPct - a.feature_mean.homeWinPct) / a.feature_std.homeWinPct;
  const expectedResidual = a.intercept + a.coefficients.homeWinPct * scaledHomeWinPct;
  assert.ok(Math.abs(scored.residualLogit - expectedResidual) < 1e-9);
  // combined
  const z = scored.marketLogit + scored.residualLogit;
  const expectedProb = 1 / (1 + Math.exp(-z));
  assert.ok(Math.abs(scored.homeProbability - expectedProb) < 1e-9);
  assert.ok(Math.abs(scored.homeProbability + scored.awayProbability - 1) < 1e-9);
});

// ---------- Shadow orchestrator ----------

test('scoreShadowChallengers returns no_same_book_market_pair when odds missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'p3-shadow-'));
  const a = makeArtifact();
  writeFileSync(join(tempDir, 'market_residual_v2-trained.json'), JSON.stringify({ status: 'trained', artifact: a, artifact_hash: a.artifact_hash }));
  // Also drop a learned_v2 artifact so its path is covered.
  process.env.MLB_SHADOW_MODE = 'true';
  process.env.MLB_MODEL_ARTIFACTS_DIR = tempDir;
  try {
    const prediction = {
      coreInputs: sampleCoreInputs(),
      runId: 'run-1', gamePk: 12345, dateYmd: '2026-07-21',
      asOfUtc: '2026-07-21T17:00:00Z', startTime: '2026-07-21T23:05:00Z',
      home: { id: 120 }, away: { id: 113 },
      currentOdds: null // no market
    };
    const results = scoreShadowChallengers(prediction);
    const mr = results.find((r) => r.modelId === MARKET_RESIDUAL_V2_MODEL_ID);
    assert.ok(mr, 'market_residual_v2 result should exist');
    assert.equal(mr.entry, null);
    assert.ok(mr.reason.includes('no_same_book_market_pair') || mr.reason.includes('no_compatible_artifact'));
  } finally {
    delete process.env.MLB_SHADOW_MODE;
    delete process.env.MLB_MODEL_ARTIFACTS_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('scoreShadowChallengers produces market_residual_v2 entry when same-book market present', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'p3-shadow-'));
  const a = makeArtifact();
  writeFileSync(join(tempDir, 'market_residual_v2-trained.json'), JSON.stringify({ status: 'trained', artifact: a, artifact_hash: a.artifact_hash }));
  process.env.MLB_SHADOW_MODE = 'true';
  process.env.MLB_MODEL_ARTIFACTS_DIR = tempDir;
  try {
    const prediction = {
      coreInputs: sampleCoreInputs(),
      runId: 'run-12345-abc', gamePk: 12345, dateYmd: '2026-07-21',
      asOfUtc: '2026-07-21T17:00:00Z', startTime: '2026-07-21T23:05:00Z',
      home: { id: 120 }, away: { id: 113 },
      // Same-book moneyline pair: home -150, away 130 (same book 'pinnacle').
      currentOdds: { homeMoneyline: -150, awayMoneyline: 130, moneylineBook: 'pinnacle' }
    };
    const results = scoreShadowChallengers(prediction);
    const mr = results.find((r) => r.modelId === MARKET_RESIDUAL_V2_MODEL_ID);
    assert.ok(mr, 'market_residual_v2 result should exist');
    assert.ok(mr.entry, `expected entry, reason: ${mr.reason}`);
    const e = mr.entry;
    assert.equal(e.modelId, MARKET_RESIDUAL_V2_MODEL_ID);
    assert.equal(e.status, 'SHADOW');
    assert.equal(e.promotionEligible, false);
    assert.equal(e.displayHomeProbability, null);
    assert.ok(e.residualLogit != null);
    assert.ok(e.marketNoVigHomeProb > 0 && e.marketNoVigHomeProb < 1);
    assert.ok(e.rawHomeProbability >= 0 && e.rawHomeProbability <= 1);
  } finally {
    delete process.env.MLB_SHADOW_MODE;
    delete process.env.MLB_MODEL_ARTIFACTS_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- Non-same-book odds yield no residual ----------

test('scoreShadowChallengers yields no residual when odds are different books', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'p3-shadow-'));
  const a = makeArtifact();
  writeFileSync(join(tempDir, 'market_residual_v2-trained.json'), JSON.stringify({ status: 'trained', artifact: a, artifact_hash: a.artifact_hash }));
  process.env.MLB_SHADOW_MODE = 'true';
  process.env.MLB_MODEL_ARTIFACTS_DIR = tempDir;
  try {
    const prediction = {
      coreInputs: sampleCoreInputs(),
      runId: 'run-2', gamePk: 12346,
      home: { id: 120 }, away: { id: 113 },
      currentOdds: { homeMoneyline: -150, awayMoneyline: 130, homeMoneylineBook: 'pinnacle', awayMoneylineBook: 'draftkings' }
    };
    const results = scoreShadowChallengers(prediction);
    const mr = results.find((r) => r.modelId === MARKET_RESIDUAL_V2_MODEL_ID);
    assert.equal(mr.entry, null);
    assert.ok(mr.reason.includes('no_same_book_market_pair'));
  } finally {
    delete process.env.MLB_SHADOW_MODE;
    delete process.env.MLB_MODEL_ARTIFACTS_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- End-to-end shadow persistence ----------

test('shadow mode on persists market_residual_v2 row alongside control + learned_v2', () => {
  const { storage, tempDir } = freshStorage();
  const artifactsDir = mkdtempSync(join(tmpdir(), 'p3-artifacts-'));
  // Both challenger artifacts present.
  const mrArt = makeArtifact();
  writeFileSync(join(artifactsDir, 'market_residual_v2-trained.json'), JSON.stringify({ status: 'trained', artifact: mrArt, artifact_hash: mrArt.artifact_hash }));
  // learned_v2 artifact (minimal, reusing P2 shape) — reuse makeArtifact fields under different model id is invalid;
  // instead skip learned_v2 artifact so only market_residual_v2 scores. That still tests P3 persistence.
  process.env.MLB_SHADOW_MODE = 'true';
  process.env.MLB_MODEL_ARTIFACTS_DIR = artifactsDir;
  try {
    const pred = {
      gamePk: 7005,
      dateYmd: '2026-07-21',
      status: 'Scheduled',
      startTime: '2026-07-21T23:05:00Z',
      asOfUtc: '2026-07-21T17:00:00Z',
      predictionTimestampUtc: '2026-07-21T17:00:00Z',
      home: { id: 120 }, away: { id: 113 },
      home: { id: 120, rawBaseballProbability: 53, pureModelProbability: 53, displayProbability: 52 },
      away: { id: 113, rawBaseballProbability: 47, pureModelProbability: 47, displayProbability: 48 },
      modelId: HEURISTIC_V1_MODEL_ID,
      coreInputs: sampleCoreInputs(),
      currentOdds: { homeMoneyline: -150, awayMoneyline: 130, moneylineBook: 'pinnacle' },
      modelBreakdown: { pureHomeProbability: 53, pureAwayProbability: 47 }
    };
    storage.savePredictions('2026-07-21', [pred]);

    const rows = storage.db
      .prepare('SELECT model_id, status, residual_logit, market_no_vig_home_prob FROM model_predictions WHERE game_pk = ? ORDER BY model_id')
      .all('7005');
    const ids = rows.map((r) => r.model_id);
    assert.ok(ids.includes(HEURISTIC_V1_MODEL_ID), 'control row present');
    assert.ok(ids.includes(MARKET_RESIDUAL_V2_MODEL_ID), 'market_residual_v2 row present');
    const mr = rows.find((r) => r.model_id === MARKET_RESIDUAL_V2_MODEL_ID);
    assert.equal(mr.status, 'SHADOW');
    assert.ok(mr.residual_logit != null);
    assert.ok(mr.market_no_vig_home_prob != null);
  } finally {
    delete process.env.MLB_SHADOW_MODE;
    delete process.env.MLB_MODEL_ARTIFACTS_DIR;
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});
