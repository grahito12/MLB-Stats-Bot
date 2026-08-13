import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calibrateProbability,
  calibratePercent,
  freezeCalibrationArtifact,
  getCalibrationArtifact,
  hasCalibrationMap
} from '../src/calibration.js';

test('calibration applies the trained moneyline isotonic map', () => {
  // From data/calibration_maps.json: a raw 0.65 maps below 0.56 (the model is
  // overconfident at that band), so calibration must pull it DOWN, never up.
  if (hasCalibrationMap('moneyline')) {
    const calibrated = calibrateProbability(0.65, 'moneyline');
    assert.ok(calibrated < 0.65, `expected calibrated < raw, got ${calibrated}`);
    assert.ok(calibrated > 0.5, `expected calibrated still a favorite, got ${calibrated}`);
  }
});

test('calibratePercent round-trips the percent scale', () => {
  const result = calibratePercent(65, 'moneyline');
  assert.ok(result > 1 && result <= 100, `expected a percent, got ${result}`);
});

test('unknown market falls back to the raw probability', () => {
  assert.equal(calibrateProbability(0.61, 'no_such_market'), 0.61);
});

test('calibrated probability is clamped to [0.05, 0.95]', () => {
  assert.ok(calibrateProbability(0.999, 'moneyline') <= 0.95);
  assert.ok(calibrateProbability(0.001, 'moneyline') >= 0.05);
});

test('legacy moneyline map remains numerically active but not promotion-safe', () => {
  const artifact = getCalibrationArtifact('moneyline');
  const frozen = freezeCalibrationArtifact('moneyline');
  const mapping = frozen.mapping;
  const upperIndex = mapping.findIndex(([x]) => x >= 0.65);
  const [x0, y0] = mapping[upperIndex - 1];
  const [x1, y1] = mapping[upperIndex];
  const expected = y0 + ((0.65 - x0) / (x1 - x0)) * (y1 - y0);

  assert.equal(artifact.applicationMode, 'map');
  assert.equal(artifact.integrityStatus, 'legacy_unbound');
  assert.equal(artifact.promotionSafe, false);
  assert.ok(artifact.warnings.includes('legacy_unbound'));
  assert.ok(Math.abs(calibrateProbability(0.65, 'moneyline') - expected) < 1e-12);
});

test('frozen calibration artifact carries full integrity identity', () => {
  const frozen = freezeCalibrationArtifact('moneyline');
  assert.equal(frozen.applicationMode, 'map');
  assert.equal(frozen.integrityStatus, 'legacy_unbound');
  assert.equal(frozen.promotionSafe, false);
  assert.equal(frozen.expectedModelId, 'heuristic_v1');
  assert.equal(frozen.expectedModelImplVersion, 'moneyline-core-v1.0');
  assert.equal(frozen.expectedFeatureSchemaVersion, 'mlb-control-features-v1.0');
  assert.equal(frozen.method, 'isotonic');
  assert.equal(frozen.samples, 1044);
  assert.ok(Array.isArray(frozen.mapping));
  assert.ok(Array.isArray(frozen.warnings));
  assert.match(frozen.calibrationVersion, /^cal-moneyline-/);
});

test('unbound legacy artifact cannot establish challenger compatibility', () => {
  const artifact = getCalibrationArtifact('moneyline', {
    modelId: 'learned_v2_logistic',
    modelImplVersion: 'learned-v2-test',
    featureSchemaVersion: 'learned-features-test'
  });
  assert.equal(artifact.applicationMode, 'map');
  assert.equal(artifact.integrityStatus, 'legacy_unbound');
  assert.equal(artifact.promotionSafe, false);
  assert.equal(artifact.expectedModelId, 'learned_v2_logistic');
  assert.equal(artifact.expectedModelImplVersion, 'learned-v2-test');
  assert.equal(artifact.expectedFeatureSchemaVersion, 'learned-features-test');
});

test.skip('totals market is calibrated at the source and probs sum to 100', () => {});

