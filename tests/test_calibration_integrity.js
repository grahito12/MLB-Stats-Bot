import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCalibrationArtifact,
  computeCalibrationContentHash,
  computeCalibrationArtifactHash,
  verifyCalibrationArtifact,
  calibrateProbabilityWithArtifact,
  validateCalibrationMapping
} from '../src/calibration.js';

// A structurally valid 3-point isotonic map used as the baseline for fixtures.
const VALID_MAPPING = [
  [0.4, 0.38],
  [0.55, 0.54],
  [0.7, 0.62]
];

// Full bindings block that satisfies every active-status requirement.
function fullBindings(overrides = {}) {
  return {
    modelId: 'heuristic_v1',
    modelImplVersion: 'moneyline-core-v1.0',
    featureSchemaVersion: 'mlb-control-features-v1.0',
    population: 'mlb-regular-season-2026',
    trainingCutoff: '2026-07-01',
    method: 'isotonic',
    datasetHash: 'dataset-test-0x1',
    contentHash: null, // stamped below after content hash is known
    ...overrides
  };
}

/**
 * Build a fully-bound, hash-consistent ACTIVE artifact through the public
 * builder. Content hash is precomputed so bindings.contentHash is non-null
 * before the builder runs — that makes hasRequiredBindings true, which is what
 * promotes the artifact to integrityStatus='active'. Artifact hash + version
 * are re-stamped from the final fields so verifyCalibrationArtifact passes.
 */
function activeArtifact(mapping = VALID_MAPPING, bindingsOverrides = {}, samples = 1044) {
  const validated = validateCalibrationMapping(mapping);
  const bindings = fullBindings(bindingsOverrides);
  // Precompute the content hash from the same normalized fields the builder
  // will use, then seed bindings.contentHash so hasRequiredBindings is true.
  const seedContentHash = computeCalibrationContentHash({
    market: 'moneyline',
    mapping: validated.mapping,
    shrinkFactor: 0.5,
    modelId: bindings.modelId,
    modelImplVersion: bindings.modelImplVersion,
    featureSchemaVersion: bindings.featureSchemaVersion,
    population: bindings.population,
    trainingCutoff: bindings.trainingCutoff,
    method: bindings.method,
    samples,
    datasetHash: bindings.datasetHash
  });
  const meta = {
    markets: {
      moneyline: {
        status: 'success',
        samples,
        bindings: { ...bindings, contentHash: seedContentHash }
      }
    }
  };
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping,
    meta,
    expected: {
      modelId: bindings.modelId,
      modelImplVersion: bindings.modelImplVersion,
      featureSchemaVersion: bindings.featureSchemaVersion
    },
    source: 'calibration_maps.json'
  });
  // Re-stamp the artifact hash + version from the final assembled fields so
  // verifyCalibrationArtifact sees a self-consistent hash chain.
  const artifactHash = computeCalibrationArtifactHash(artifact);
  return {
    ...artifact,
    artifactHash,
    calibrationVersion: `cal-moneyline-${artifactHash}`
  };
}

test('active artifact with full bindings and consistent hashes verifies clean', () => {
  const artifact = activeArtifact();
  const verification = verifyCalibrationArtifact(artifact);
  assert.equal(verification.ok, true, JSON.stringify(verification.reasons));
  assert.equal(artifact.integrityStatus, 'active');
  assert.equal(artifact.promotionSafe, true);
  assert.equal(artifact.applicationMode, 'map');
});

test('missing map with success meta yields identity mode and missing_artifact status', () => {
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: null,
    meta: { markets: { moneyline: { status: 'success', samples: 1044 } } },
    expected: {}
  });
  assert.equal(artifact.mapFound, false);
  assert.equal(artifact.mapPresent, false);
  assert.equal(artifact.applicationMode, 'identity');
  // meta claims success but map is absent -> missing_artifact (not identity),
  // so the false success claim stays visible rather than silently passing.
  assert.equal(artifact.integrityStatus, 'missing_artifact');
  assert.equal(artifact.promotionSafe, false);
  assert.ok(artifact.warnings.includes('missing_calibration_map'));
  // Identity mode applies no transform: calibrated equals raw.
  assert.equal(calibrateProbabilityWithArtifact(0.6, artifact), 0.6);
});

test('missing map with no success meta yields identity status', () => {
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: null,
    meta: { markets: {} },
    expected: {}
  });
  assert.equal(artifact.mapFound, false);
  assert.equal(artifact.mapPresent, false);
  assert.equal(artifact.applicationMode, 'identity');
  assert.equal(artifact.integrityStatus, 'identity');
  assert.equal(artifact.promotionSafe, false);
  assert.ok(artifact.warnings.includes('missing_calibration_map'));
});

test('malformed map (non-monotonic y) is rejected and falls back to identity', () => {
  const badMapping = [
    [0.4, 0.5],
    [0.6, 0.4], // y decreases -> not monotonic
    [0.8, 0.7]
  ];
  const validation = validateCalibrationMapping(badMapping);
  assert.equal(validation.valid, false);
  assert.equal(validation.reason, 'y_not_monotonic');
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: badMapping,
    meta: { markets: { moneyline: { status: 'success', samples: 1044 } } },
    expected: {}
  });
  assert.equal(artifact.mapPresent, false);
  assert.equal(artifact.applicationMode, 'identity');
  assert.ok(artifact.warnings.some((w) => w.startsWith('malformed_calibration_map')));
  assert.equal(artifact.integrityStatus, 'missing_artifact');
});

test('malformed map (x not strictly increasing) is rejected', () => {
  const badMapping = [
    [0.4, 0.4],
    [0.4, 0.5], // duplicate x
    [0.8, 0.7]
  ];
  const validation = validateCalibrationMapping(badMapping);
  assert.equal(validation.valid, false);
  assert.equal(validation.reason, 'x_not_strictly_increasing');
});

test('malformed map (point out of range) is rejected', () => {
  const badMapping = [
    [0.4, 0.4],
    [0.6, 1.4], // y > 1
    [0.8, 0.7]
  ];
  const validation = validateCalibrationMapping(badMapping);
  assert.equal(validation.valid, false);
  assert.equal(validation.reason, 'point_out_of_range');
});

test('explicit model-id mismatch degrades to incompatible_version', () => {
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: VALID_MAPPING,
    meta: {
      markets: {
        moneyline: {
          status: 'success',
          samples: 1044,
          bindings: fullBindings({ modelId: 'learned_v2_logistic' })
        }
      }
    },
    expected: {
      modelId: 'heuristic_v1',
      modelImplVersion: 'moneyline-core-v1.0',
      featureSchemaVersion: 'mlb-control-features-v1.0'
    }
  });
  assert.equal(artifact.integrityStatus, 'incompatible_version');
  assert.equal(artifact.applicationMode, 'identity');
  assert.equal(artifact.promotionSafe, false);
  assert.ok(artifact.warnings.includes('incompatible_calibration_binding'));
});

test('explicit impl-version mismatch degrades to incompatible_version', () => {
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: VALID_MAPPING,
    meta: {
      markets: {
        moneyline: {
          status: 'success',
          samples: 1044,
          bindings: fullBindings({ modelImplVersion: 'learned-v2-test' })
        }
      }
    },
    expected: {
      modelId: 'heuristic_v1',
      modelImplVersion: 'moneyline-core-v1.0',
      featureSchemaVersion: 'mlb-control-features-v1.0'
    }
  });
  assert.equal(artifact.integrityStatus, 'incompatible_version');
  assert.equal(artifact.promotionSafe, false);
});

test('content-hash mismatch is detected and degrades to incompatible_version', () => {
  const artifact = activeArtifact();
  // Corrupt the mapping without fixing the content hash.
  const tampered = {
    ...artifact,
    mapping: [
      [0.4, 0.3],
      [0.55, 0.54],
      [0.7, 0.62]
    ]
  };
  const verification = verifyCalibrationArtifact(tampered);
  assert.equal(verification.ok, false);
  assert.ok(verification.reasons.includes('calibration_content_hash_mismatch'));
  // The builder itself, given an explicit wrong expectedContentHash, flags it.
  const rebuilt = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: VALID_MAPPING,
    meta: {
      markets: {
        moneyline: {
          status: 'success',
          samples: 1044,
          bindings: fullBindings({ contentHash: 'bogus-wrong-hash' })
        }
      }
    },
    expected: {}
  });
  assert.equal(rebuilt.integrityStatus, 'incompatible_version');
  assert.ok(rebuilt.warnings.includes('calibration_artifact_hash_mismatch'));
});

test('stale artifact (validThrough in past) degrades to stale status', () => {
  const staleDate = '2026-01-01T00:00:00Z';
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: VALID_MAPPING,
    meta: {
      markets: {
        moneyline: {
          status: 'success',
          samples: 1044,
          bindings: fullBindings({ validThrough: staleDate })
        }
      }
    },
    expected: {},
    nowUtc: '2026-07-21T12:00:00Z'
  });
  assert.equal(artifact.integrityStatus, 'stale');
  assert.equal(artifact.applicationMode, 'identity');
  assert.equal(artifact.promotionSafe, false);
  assert.ok(artifact.warnings.includes('stale_calibration_artifact'));
});

test('stale artifact (meta status=stale) degrades to stale status', () => {
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: VALID_MAPPING,
    meta: {
      markets: {
        moneyline: {
          status: 'stale',
          samples: 1044,
          bindings: fullBindings()
        }
      }
    },
    expected: {}
  });
  assert.equal(artifact.integrityStatus, 'stale');
  assert.equal(artifact.promotionSafe, false);
});

test('active artifact missing a required binding field fails verification', () => {
  const artifact = activeArtifact();
  const incomplete = { ...artifact, datasetHash: null };
  const verification = verifyCalibrationArtifact(incomplete);
  assert.equal(verification.ok, false);
  assert.ok(verification.reasons.includes('missing_calibration_dataset_hash'));
});

test('active artifact with tampered artifactHash fails verification', () => {
  const artifact = activeArtifact();
  const tampered = { ...artifact, artifactHash: 'tampered-hash' };
  const verification = verifyCalibrationArtifact(tampered);
  assert.equal(verification.ok, false);
  assert.ok(verification.reasons.includes('calibration_artifact_hash_mismatch'));
});

test('legacy unbound map is numerically active but not promotion-safe', () => {
  // No bindings at all: the on-disk legacy moneyline map shape.
  const artifact = buildCalibrationArtifact({
    market: 'moneyline',
    mapping: VALID_MAPPING,
    meta: { markets: { moneyline: { status: 'success', samples: 1044 } } },
    expected: {}
  });
  assert.equal(artifact.applicationMode, 'map');
  assert.equal(artifact.integrityStatus, 'legacy_unbound');
  assert.equal(artifact.promotionSafe, false);
  assert.ok(artifact.warnings.includes('legacy_unbound'));
  // Still interpolates numerically.
  const calibrated = calibrateProbabilityWithArtifact(0.6, artifact);
  assert.ok(calibrated > 0.5 && calibrated < 0.7);
});

test('low-sample map uses shrinkage and is not promotion-safe', () => {
  const lowSample = activeArtifact(VALID_MAPPING, {}, 50); // below trust threshold 150
  assert.equal(lowSample.applicationMode, 'map_low_sample_shrink');
  assert.equal(lowSample.integrityStatus, 'active');
  // Shrinkage mode is numerically active but too weak to trust for promotion.
  assert.equal(lowSample.promotionSafe, false);
  assert.ok(lowSample.warnings.includes('low_sample_map'));
});
