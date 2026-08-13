import assert from 'node:assert/strict';
import test from 'node:test';

import {
  predictGameMoneylineCore,
  buildCoreInputsSnapshot
} from '../src/core/prediction_core.js';
import { buildPredictionSnapshot, hashPayload } from '../src/prediction_snapshot.js';
import {
  replaySnapshot,
  recomputeFromSnapshot,
  replayTwice,
  compareRecomputeToStored,
  PROBABILITY_TOLERANCE
} from '../src/prediction_replay.js';
import {
  calibratePercent,
  freezeCalibrationArtifact,
  buildCalibrationArtifact,
  computeCalibrationContentHash,
  computeCalibrationArtifactHash,
  validateCalibrationMapping
} from '../src/calibration.js';
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

function baseGame() {
  return {
    gamePk: 888001,
    officialDate: '2026-07-21',
    gameDate: '2026-07-21T23:05:00Z',
    venue: { id: 119, name: 'Dodger Stadium' },
    weather: { temp: '72', wind: '5 mph' },
    status: { detailedState: 'Scheduled' },
    teams: {
      away: {
        team: { id: 147, name: 'Yankees', abbreviation: 'NYY' },
        leagueRecord: { wins: 58, losses: 42 },
        probablePitcher: { id: 111, fullName: 'Away P', pitchHand: { code: 'R' } }
      },
      home: {
        team: { id: 119, name: 'Dodgers', abbreviation: 'LAD' },
        leagueRecord: { wins: 62, losses: 38 },
        probablePitcher: { id: 222, fullName: 'Home P', pitchHand: { code: 'L' } }
      }
    }
  };
}

function baseBundle() {
  return {
    game: baseGame(),
    teamStats: toKeyMap({
      147: { hitting: { gamesPlayed: 100, runs: 480, ops: '.750' } },
      119: { hitting: { gamesPlayed: 100, runs: 520, ops: '.780' } }
    }),
    standings: toKeyMap({
      147: { leagueRecord: { wins: 58, losses: 42 } },
      119: { leagueRecord: { wins: 62, losses: 38 } }
    }),
    pitcherStats: toKeyMap({
      111: { era: '3.50', whip: '1.15' },
      222: { era: '2.80', whip: '1.00' }
    }),
    pitcherDetails: new Map(),
    pitcherRecentStarts: new Map(),
    bullpenProfiles: new Map(),
    scheduleFatigueProfiles: new Map(),
    headToHead: { games: 0 },
    injuryProfiles: new Map(),
    lineupProfiles: { away: null, home: null },
    modelMemory: {},
    rollingTeamStats: new Map(),
    evolutionControls: loadEvolutionControls(),
    parkFactorBaselines: new Map([[119, { runFactor: 0.99, homeRunFactor: 1.02 }]])
  };
}

function liveCore(bundle) {
  return predictGameMoneylineCore({
    ...bundle,
    calibratePercent,
    nowMs: new Date('2026-07-21T12:00:00Z'),
    moneylineWeightMultiplierFn: moneylineWeightMultiplier
  });
}

// A fully-bound, hash-consistent ACTIVE calibration artifact for replay
// fixtures. The live on-disk map is legacy_unbound (no model bindings), so
// promotion-eligible replay tests cannot reuse it. This synthetic artifact is
// built through the same public builder the loader uses, then re-stamped with
// the binding fields it would carry once trained with full provenance.
function syntheticActiveArtifact() {
  const frozen = freezeCalibrationArtifact('moneyline');
  const validation = validateCalibrationMapping(frozen.mapping);
  const base = {
    market: 'moneyline',
    mode: 'map',
    applicationMode: 'map',
    integrityStatus: 'active',
    promotionSafe: true,
    mapFound: true,
    mapPresent: validation.valid,
    mapPoints: validation.points,
    mapValidation: { valid: validation.valid, reason: validation.reason },
    mapping: validation.mapping,
    shrinkFactor: frozen.shrinkFactor,
    metaSuccess: true,
    samples: 1044,
    modelId: 'heuristic_v1',
    modelImplVersion: 'moneyline-core-v1.0',
    featureSchemaVersion: 'mlb-control-features-v1.0',
    expectedModelId: 'heuristic_v1',
    expectedModelImplVersion: 'moneyline-core-v1.0',
    expectedFeatureSchemaVersion: 'mlb-control-features-v1.0',
    population: 'mlb-regular-season-2026',
    trainingCutoff: '2026-07-01',
    validThrough: null,
    method: 'isotonic',
    datasetHash: 'dataset-test-0x1',
    warnings: [],
    source: 'calibration_maps.json'
  };
  const contentHash = computeCalibrationContentHash(base);
  const expectedContentHash = contentHash;
  const artifactHash = computeCalibrationArtifactHash({
    ...base,
    contentHash
  });
  return {
    ...base,
    contentHash,
    expectedContentHash,
    artifactHash,
    calibrationVersion: `cal-moneyline-${artifactHash}`,
    hashSchema: 'calibration-artifact-v1'
  };
}

function buildSnapshot(bundle, live) {
  const coreInputs = buildCoreInputsSnapshot(bundle);
  const prediction = {
    gamePk: 888001,
    dateYmd: '2026-07-21',
    startTime: '2026-07-21T23:05:00Z',
    away: {
      id: 147,
      name: 'Yankees',
      abbreviation: 'NYY',
      pureModelProbability: live.calibrated.awayProbability
    },
    home: {
      id: 119,
      name: 'Dodgers',
      abbreviation: 'LAD',
      pureModelProbability: live.calibrated.homeProbability
    },
    modelBreakdown: live.modelBreakdown,
    valuePick: null,
    betDecision: { status: 'NO BET' }
  };
  return buildPredictionSnapshot({
    prediction,
    dateYmd: '2026-07-21',
    asOfUtc: '2026-07-21T12:00:00.000Z',
    predictionTimestampUtc: '2026-07-21T12:00:00.000Z',
    versions: {
      modelId: 'heuristic_v1',
      modelVersion: 'moneyline-core-v1.0',
      modelImplVersion: 'moneyline-core-v1.0',
      featureSchemaVersion: 'mlb-control-features-v1.0'
    },
    coreInputs,
    calibrationArtifact: syntheticActiveArtifact()
  });
}

function makeSnapshot() {
  const bundle = baseBundle();
  const live = liveCore(bundle);
  return { bundle, live, snapshot: buildSnapshot(bundle, live) };
}

function rehash(snapshot) {
  const { snapshotHash: _oldHash, ...body } = snapshot;
  return {
    ...body,
    snapshotHash: hashPayload(body)
  };
}

test('exact snapshot replay is deterministic and parity-true (recompute mode)', () => {
  const { snapshot } = makeSnapshot();
  const result = replaySnapshot(snapshot);
  assert.equal(result.mode, 'recompute');
  assert.equal(result.parity.ok, true, JSON.stringify(result.parity.mismatches));
  assert.equal(result.promotionEligible, true);
  const twice = replayTwice(snapshot);
  assert.equal(twice.parity.ok, true);
});

test('mutating starter data changes probability', () => {
  const { snapshot } = makeSnapshot();
  const base = recomputeFromSnapshot(snapshot);
  const mutated = JSON.parse(JSON.stringify(snapshot));
  mutated.coreInputs.pitcherStats['222'] = {
    ...mutated.coreInputs.pitcherStats['222'],
    era: '7.50',
    whip: '1.90'
  };
  const changed = recomputeFromSnapshot(mutated);
  assert.notEqual(changed.pureHomeProbability, base.pureHomeProbability);
  assert.ok(
    Math.abs(changed.rawHomeProbability - base.rawHomeProbability) > PROBABILITY_TOLERANCE
  );
});

test('mutating lineup strength changes prediction', () => {
  const { snapshot } = makeSnapshot();
  const base = recomputeFromSnapshot(snapshot);
  const mutated = JSON.parse(JSON.stringify(snapshot));
  mutated.coreInputs.lineupProfiles = {
    away: { confirmed: true, count: 9, qualityScore: 0.9 },
    home: { confirmed: true, count: 9, qualityScore: 0.2 }
  };
  const changed = recomputeFromSnapshot(mutated);
  assert.ok(
    Math.abs(changed.rawHomeProbability - base.rawHomeProbability) > PROBABILITY_TOLERANCE,
    `lineup mutation should change raw home probability (${base.rawHomeProbability} -> ${changed.rawHomeProbability})`
  );
});

test('mutating calibration artifact changes calibrated probability', () => {
  const { snapshot } = makeSnapshot();
  const base = recomputeFromSnapshot(snapshot);
  const mutated = JSON.parse(JSON.stringify(snapshot));
  // Identity calibration: no map, no shrink -> calibrated equals raw.
  mutated.calibrationArtifact = { market: 'moneyline', mode: 'identity', mapping: null };
  const changed = recomputeFromSnapshot(mutated);
  assert.notEqual(changed.pureHomeProbability, base.pureHomeProbability);
});

test('changing only irrelevant metadata does not change the prediction', () => {
  const { snapshot } = makeSnapshot();
  const base = recomputeFromSnapshot(snapshot);
  const mutated = JSON.parse(JSON.stringify(snapshot));
  mutated.teams.home.name = 'Renamed FC';
  mutated.config = { note: 'irrelevant display metadata' };
  const changed = recomputeFromSnapshot(mutated);
  assert.equal(changed.rawHomeProbability, base.rawHomeProbability);
  assert.equal(changed.pureHomeProbability, base.pureHomeProbability);
});

test('recompute parity cannot promote a post-pitch snapshot', () => {
  const { snapshot } = makeSnapshot();
  const late = JSON.parse(JSON.stringify(snapshot));
  late.asOfUtc = late.firstPitchUtc;
  late.predictionTimestampUtc = late.firstPitchUtc;
  const result = replaySnapshot(rehash(late));

  assert.equal(result.parity.ok, true);
  assert.equal(result.promotionEligible, false);
  assert.ok(result.promotionReasons.includes('as_of_at_first_pitch'));
});

test('recompute parity cannot promote an unbound calibration artifact', () => {
  const { snapshot } = makeSnapshot();
  const unbound = JSON.parse(JSON.stringify(snapshot));
  unbound.calibrationArtifact.integrityStatus = 'legacy_unbound';
  unbound.calibrationArtifact.promotionSafe = false;
  const result = replaySnapshot(rehash(unbound));

  assert.equal(result.parity.ok, true);
  assert.equal(result.promotionEligible, false);
  assert.ok(result.promotionReasons.includes('calibration_legacy_unbound'));
});

test('recompute parity requires complete model identity', () => {
  const { snapshot } = makeSnapshot();
  const missing = JSON.parse(JSON.stringify(snapshot));
  missing.versions.modelId = null;
  missing.versions.modelVersion = null;
  missing.versions.modelImplVersion = null;
  missing.versions.featureSchemaVersion = null;
  const result = replaySnapshot(rehash(missing));

  assert.equal(result.parity.ok, true);
  assert.equal(result.promotionEligible, false);
  assert.ok(result.promotionReasons.includes('missing_model_id'));
  assert.ok(result.promotionReasons.includes('missing_model_impl_version'));
  assert.ok(result.promotionReasons.includes('missing_feature_schema_version'));
});

test('recompute parity rejects calibration identity inconsistent with snapshot', () => {
  const { snapshot } = makeSnapshot();
  const mismatched = JSON.parse(JSON.stringify(snapshot));
  mismatched.calibrationArtifact.expectedModelId = 'learned_v2_logistic';
  mismatched.calibrationArtifact.expectedModelImplVersion = 'learned-v2-test';
  mismatched.calibrationArtifact.expectedFeatureSchemaVersion = 'learned-features-test';
  const result = replaySnapshot(rehash(mismatched));

  assert.equal(result.parity.ok, true);
  assert.equal(result.promotionEligible, false);
  assert.ok(result.promotionReasons.includes('calibration_expected_model_mismatch'));
  assert.ok(result.promotionReasons.includes('calibration_expected_model_impl_mismatch'));
  assert.ok(result.promotionReasons.includes('calibration_expected_feature_schema_mismatch'));
});

test('projection-only snapshot (no coreInputs) is not promotion-eligible', () => {
  const body = {
    schemaVersion: 1,
    gamePk: '555001',
    dateYmd: '2026-07-27',
    asOfUtc: '2026-07-27T18:00:00.000Z',
    predictionTimestampUtc: '2026-07-27T18:00:00.000Z',
    firstPitchUtc: '2026-07-27T23:10:00Z',
    teams: { away: { id: 10 }, home: { id: 20 } },
    features: null,
    quotes: { currentOdds: null, openingOdds: null },
    modelInputs: { pureAwayProbability: 44, pureHomeProbability: 56, modelBreakdown: null },
    decisionInputs: { valuePick: null, betDecision: { status: 'NO BET' }, moneylineValueOptions: [] },
    versions: {},
    coreInputs: null,
    calibrationArtifact: null,
    config: null
  };
  const projectionSnapshot = { ...body, snapshotHash: hashPayload(body) };
  const result = replaySnapshot(projectionSnapshot);
  assert.equal(result.mode, 'projection');
  assert.equal(result.promotionEligible, false);
});
