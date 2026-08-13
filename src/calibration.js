import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clamp } from './utils.js';
import {
  CONTROL_FEATURE_SCHEMA_VERSION,
  HEURISTIC_V1_IMPL_VERSION,
  HEURISTIC_V1_MODEL_ID
} from './core/model_ids.js';

// JS port of src/probability_calibrator.py so the live JS prediction path
// (/picks, recaps) applies the same per-market calibration policy the Python
// evolution pipeline trains. Without this, /picks shows raw model probabilities
// that the audit has already shown to be over/under-confident.

function dataDir() {
  return fileURLToPath(new URL('../data', import.meta.url));
}

const MIN_ISOTONIC_SAMPLES_FOR_TRUST = {
  moneyline: 150
};

const SHRINKAGE_FACTOR = {
  moneyline: 0.5
};

export const CALIBRATION_CONTENT_HASH_SCHEMA =
  'calibration-content-v1';
export const CALIBRATION_ARTIFACT_HASH_SCHEMA =
  'calibration-artifact-v1';

let cachedMaps = null;
let cachedMeta = null;
let cachedMapDiagnostics = null;
let cachedMetaDiagnostics = null;
/** @type {Map<string, object>} */
let cachedArtifacts = new Map();

function errorMessage(error) {
  return error?.message || String(error || 'unknown_error');
}

function loadCalibrationMeta() {
  if (cachedMeta !== null) return cachedMeta;
  const metaPath = resolve(dataDir(), 'calibration_meta.json');
  let meta = {};
  const diagnostics = {
    path: metaPath,
    found: existsSync(metaPath),
    malformed: false,
    failureReason: null
  };
  if (diagnostics.found) {
    try {
      const raw = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        meta = raw;
      } else {
        diagnostics.malformed = true;
        diagnostics.failureReason =
          'calibration metadata must be an object';
      }
    } catch (error) {
      diagnostics.malformed = true;
      diagnostics.failureReason = errorMessage(error);
    }
  }
  cachedMetaDiagnostics = diagnostics;
  cachedMeta = meta;
  return meta;
}

function loadCalibrationMaps() {
  if (cachedMaps !== null) return cachedMaps;
  const maps = {};
  const sourceByMarket = {};
  const warningsByMarket = {};
  const perMarketPath = resolve(
    dataDir(),
    'calibration_maps.json'
  );
  const legacyPath = resolve(
    dataDir(),
    'calibration_map.json'
  );
  let primaryMalformed = false;

  if (existsSync(perMarketPath)) {
    try {
      const raw = JSON.parse(
        readFileSync(perMarketPath, 'utf8')
      );
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw)
      ) {
        primaryMalformed = true;
      } else {
        for (const [market, pairs] of Object.entries(raw)) {
          maps[market] = pairs;
          sourceByMarket[market] =
            'calibration_maps.json';
        }
      }
    } catch (error) {
      primaryMalformed = true;
      warningsByMarket.moneyline = [
        `calibration_maps_parse_error:${errorMessage(error)}`
      ];
    }
  }

  if (
    !Object.prototype.hasOwnProperty.call(
      maps,
      'moneyline'
    ) &&
    existsSync(legacyPath)
  ) {
    try {
      maps.moneyline = JSON.parse(
        readFileSync(legacyPath, 'utf8')
      );
      sourceByMarket.moneyline =
        'calibration_map.json';
      if (primaryMalformed) {
        warningsByMarket.moneyline = [
          ...(warningsByMarket.moneyline || []),
          'primary_map_malformed_legacy_fallback'
        ];
      }
    } catch (error) {
      warningsByMarket.moneyline = [
        ...(warningsByMarket.moneyline || []),
        `legacy_calibration_map_parse_error:${errorMessage(
          error
        )}`
      ];
    }
  }

  cachedMapDiagnostics = {
    sourceByMarket,
    warningsByMarket,
    primaryMalformed
  };
  cachedMaps = maps;
  return maps;
}

// Test/refresh hook: clear memoized calibration files so next call re-reads disk.
export function resetCalibrationCache() {
  cachedMaps = null;
  cachedMeta = null;
  cachedMapDiagnostics = null;
  cachedMetaDiagnostics = null;
  cachedArtifacts = new Map();
}

function hashJson(value, length = 64) {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, length);
}

export function validateCalibrationMapping(value) {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      reason: value == null ? 'missing' : 'not_array',
      mapping: null,
      points: 0
    };
  }
  if (value.length < 2) {
    return {
      valid: false,
      reason: 'insufficient_points',
      mapping: null,
      points: value.length
    };
  }

  const mapping = [];
  let previousX = null;
  let previousY = null;
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return {
        valid: false,
        reason: 'invalid_pair',
        mapping: null,
        points: value.length
      };
    }
    const x = Number(pair[0]);
    const y = Number(pair[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        valid: false,
        reason: 'non_finite_point',
        mapping: null,
        points: value.length
      };
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return {
        valid: false,
        reason: 'point_out_of_range',
        mapping: null,
        points: value.length
      };
    }
    if (previousX !== null && x <= previousX) {
      return {
        valid: false,
        reason: 'x_not_strictly_increasing',
        mapping: null,
        points: value.length
      };
    }
    if (previousY !== null && y < previousY) {
      return {
        valid: false,
        reason: 'y_not_monotonic',
        mapping: null,
        points: value.length
      };
    }
    mapping.push([x, y]);
    previousX = x;
    previousY = y;
  }

  return {
    valid: true,
    reason: null,
    mapping,
    points: mapping.length
  };
}

function normalizedHashInput(value = {}) {
  const validation = validateCalibrationMapping(
    value.mapping
  );
  return {
    schema: CALIBRATION_CONTENT_HASH_SCHEMA,
    market: value.market || null,
    mapping: validation.valid
      ? validation.mapping
      : null,
    shrinkFactor:
      Number.isFinite(Number(value.shrinkFactor))
        ? Number(value.shrinkFactor)
        : null,
    modelId: value.modelId || null,
    modelImplVersion:
      value.modelImplVersion || null,
    featureSchemaVersion:
      value.featureSchemaVersion || null,
    population: value.population || null,
    trainingCutoff: value.trainingCutoff || null,
    method: value.method || null,
    samples: Number.isFinite(Number(value.samples))
      ? Number(value.samples)
      : null,
    datasetHash: value.datasetHash || null
  };
}

export function computeCalibrationContentHash(value) {
  return hashJson(normalizedHashInput(value));
}

export function computeCalibrationArtifactHash(value) {
  return hashJson(
    {
      schema: CALIBRATION_ARTIFACT_HASH_SCHEMA,
      contentHash: value.contentHash || null,
      mode: value.mode || value.applicationMode || 'identity',
      integrityStatus: value.integrityStatus || null,
      promotionSafe: value.promotionSafe === true,
      expectedModelId: value.expectedModelId || null,
      expectedModelImplVersion:
        value.expectedModelImplVersion || null,
      expectedFeatureSchemaVersion:
        value.expectedFeatureSchemaVersion || null
    },
    24
  );
}

function hashMatches(expected, actual, market) {
  if (!expected || !actual) return false;
  const normalized = String(expected).trim();
  return [
    actual,
    `sha256:${actual}`,
    `cal-${market}-${actual}`
  ].includes(normalized);
}

function parseTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function usesLowSampleShrinkage(
  market,
  marketMeta = {}
) {
  const threshold =
    MIN_ISOTONIC_SAMPLES_FOR_TRUST[market];
  if (
    threshold === undefined ||
    SHRINKAGE_FACTOR[market] === undefined
  ) {
    return false;
  }
  const samples = Number(marketMeta.samples);
  return (
    Number.isFinite(samples) && samples < threshold
  );
}

function calibrationArtifactCacheKey(
  marketKey,
  expected
) {
  return [
    marketKey,
    expected.modelId || '',
    expected.modelImplVersion || '',
    expected.featureSchemaVersion || ''
  ].join('|');
}

export function buildCalibrationArtifact({
  market = 'moneyline',
  mapping: rawMapping = null,
  meta = {},
  expected = {},
  source = null,
  sourceWarnings = [],
  nowUtc = null
} = {}) {
  const marketKey = String(market)
    .trim()
    .toLowerCase();
  const expectedIdentity = {
    modelId:
      expected.modelId || HEURISTIC_V1_MODEL_ID,
    modelImplVersion:
      expected.modelImplVersion ||
      HEURISTIC_V1_IMPL_VERSION,
    featureSchemaVersion:
      expected.featureSchemaVersion ||
      CONTROL_FEATURE_SCHEMA_VERSION
  };
  const marketMeta = meta?.markets?.[marketKey] || {};
  const bindings =
    marketMeta.bindings ||
    marketMeta.compatibility ||
    {};
  const validation =
    validateCalibrationMapping(rawMapping);
  const mapping = validation.mapping;
  const mapFound = rawMapping != null;
  const mapPresent = validation.valid;
  const metaStatus = String(
    marketMeta.status || ''
  )
    .trim()
    .toLowerCase();
  const metaSuccess = metaStatus === 'success';
  const samples = Number(marketMeta.samples);
  const lowSample = usesLowSampleShrinkage(
    marketKey,
    marketMeta
  );
  const modelId =
    bindings.modelId || marketMeta.modelId || null;
  const modelImplVersion =
    bindings.modelImplVersion ||
    marketMeta.modelImplVersion ||
    null;
  const featureSchemaVersion =
    bindings.featureSchemaVersion ||
    marketMeta.featureSchemaVersion ||
    null;
  const population =
    bindings.population ||
    marketMeta.population ||
    null;
  const trainingCutoff =
    bindings.trainingCutoff ||
    marketMeta.trainingCutoff ||
    null;
  const method =
    bindings.method ||
    marketMeta.method ||
    'isotonic';
  const datasetHash =
    bindings.datasetHash ||
    marketMeta.datasetHash ||
    null;
  const expectedContentHash =
    bindings.contentHash ||
    marketMeta.contentHash ||
    null;
  const validThrough =
    bindings.validThrough ||
    marketMeta.validThrough ||
    bindings.expiresAt ||
    marketMeta.expiresAt ||
    null;
  const shrinkFactor =
    SHRINKAGE_FACTOR[marketKey] ?? null;
  const contentHash = computeCalibrationContentHash({
    market: marketKey,
    mapping,
    shrinkFactor,
    modelId,
    modelImplVersion,
    featureSchemaVersion,
    population,
    trainingCutoff,
    method,
    samples,
    datasetHash
  });
  const explicitCompatibilityMismatch = Boolean(
    (modelId && modelId !== expectedIdentity.modelId) ||
      (modelImplVersion &&
        modelImplVersion !==
          expectedIdentity.modelImplVersion) ||
      (featureSchemaVersion &&
        featureSchemaVersion !==
          expectedIdentity.featureSchemaVersion)
  );
  const hashMismatch = Boolean(
    expectedContentHash &&
      !hashMatches(
        expectedContentHash,
        contentHash,
        marketKey
      )
  );
  const referenceMs = parseTimestamp(
    nowUtc || new Date().toISOString()
  );
  const validThroughMs = parseTimestamp(validThrough);
  const stale = Boolean(
    metaStatus === 'stale' ||
      bindings.stale === true ||
      marketMeta.stale === true ||
      (validThrough &&
        (validThroughMs === null ||
          (referenceMs !== null &&
            referenceMs > validThroughMs)))
  );
  const hasRequiredBindings = Boolean(
    modelId &&
      modelImplVersion &&
      featureSchemaVersion &&
      population &&
      trainingCutoff &&
      method &&
      datasetHash &&
      expectedContentHash
  );

  const warnings = [...sourceWarnings];
  if (!validation.valid) {
    if (mapFound) {
      warnings.push(
        `malformed_calibration_map:${validation.reason}`
      );
    } else {
      warnings.push('missing_calibration_map');
    }
  }
  if (explicitCompatibilityMismatch) {
    warnings.push('incompatible_calibration_binding');
  }
  if (hashMismatch) {
    warnings.push(
      'calibration_artifact_hash_mismatch'
    );
  }
  if (stale) warnings.push('stale_calibration_artifact');

  let mode = 'identity';
  if (
    !explicitCompatibilityMismatch &&
    !hashMismatch &&
    !stale &&
    mapPresent &&
    !lowSample
  ) {
    mode = 'map';
  } else if (
    !explicitCompatibilityMismatch &&
    !hashMismatch &&
    !stale &&
    mapPresent &&
    lowSample
  ) {
    mode = 'map_low_sample_shrink';
    warnings.push('low_sample_map');
  } else if (
    !explicitCompatibilityMismatch &&
    !hashMismatch &&
    !stale &&
    !mapFound &&
    usesLowSampleShrinkage(marketKey, marketMeta)
  ) {
    mode = 'shrink_toward_50';
    warnings.push('missing_map_using_shrinkage');
  } else if (metaSuccess && !mapPresent) {
    warnings.push(
      'meta_claims_success_but_map_missing_or_unusable'
    );
  }

  let integrityStatus;
  if (explicitCompatibilityMismatch || hashMismatch) {
    integrityStatus = 'incompatible_version';
  } else if (stale) {
    integrityStatus = 'stale';
  } else if (!mapPresent) {
    integrityStatus =
      metaSuccess || mapFound
        ? 'missing_artifact'
        : 'identity';
  } else if (!hasRequiredBindings) {
    integrityStatus = 'legacy_unbound';
    warnings.push('legacy_unbound');
  } else {
    integrityStatus = 'active';
  }

  // Promotion requires a fully-bound active artifact using a pure map — not
  // identity, not low-sample shrinkage, not shrink-toward-50. Shrinkage modes
  // are numerically active but their calibration is too weak to trust.
  const promotionSafe =
    integrityStatus === 'active' && mode === 'map';
  const baseArtifact = {
    hashSchema: CALIBRATION_ARTIFACT_HASH_SCHEMA,
    market: marketKey,
    mode,
    applicationMode: mode,
    integrityStatus,
    applied: mode !== 'identity',
    promotionSafe,
    mapFound,
    mapPresent,
    mapPoints: validation.points,
    mapValidation: {
      valid: validation.valid,
      reason: validation.reason
    },
    mapping,
    shrinkFactor,
    metaSuccess,
    samples: Number.isFinite(samples) ? samples : null,
    modelId,
    modelImplVersion,
    featureSchemaVersion,
    expectedModelId: expectedIdentity.modelId,
    expectedModelImplVersion:
      expectedIdentity.modelImplVersion,
    expectedFeatureSchemaVersion:
      expectedIdentity.featureSchemaVersion,
    population,
    trainingCutoff,
    validThrough,
    method,
    datasetHash,
    contentHash,
    expectedContentHash,
    warnings: [...new Set(warnings)],
    source:
      source ||
      meta?.source ||
      (mapFound ? 'calibration_maps.json' : null)
  };
  const artifactHash =
    computeCalibrationArtifactHash(baseArtifact);
  return {
    ...baseArtifact,
    artifactHash,
    calibrationVersion:
      `cal-${marketKey}-${artifactHash}`
  };
}

/**
 * Explicit runtime calibration artifact identity.
 * Never pretends calibrated when maps are missing while meta claims success.
 */
export function getCalibrationArtifact(
  market = 'moneyline',
  expected = {}
) {
  const marketKey = String(market)
    .trim()
    .toLowerCase();
  const expectedIdentity = {
    modelId:
      expected.modelId || HEURISTIC_V1_MODEL_ID,
    modelImplVersion:
      expected.modelImplVersion ||
      HEURISTIC_V1_IMPL_VERSION,
    featureSchemaVersion:
      expected.featureSchemaVersion ||
      CONTROL_FEATURE_SCHEMA_VERSION
  };
  const cacheKey = calibrationArtifactCacheKey(
    marketKey,
    expectedIdentity
  );
  if (cachedArtifacts.has(cacheKey)) {
    return cachedArtifacts.get(cacheKey);
  }

  const maps = loadCalibrationMaps();
  const meta = loadCalibrationMeta();
  const sourceWarnings = [
    ...(
      cachedMapDiagnostics?.warningsByMarket?.[
        marketKey
      ] || []
    )
  ];
  if (cachedMetaDiagnostics?.malformed) {
    sourceWarnings.push(
      `calibration_meta_parse_error:${
        cachedMetaDiagnostics.failureReason
      }`
    );
  }
  const artifact = buildCalibrationArtifact({
    market: marketKey,
    mapping: maps[marketKey],
    meta,
    expected: expectedIdentity,
    source:
      cachedMapDiagnostics?.sourceByMarket?.[
        marketKey
      ] || null,
    sourceWarnings
  });
  cachedArtifacts.set(cacheKey, artifact);
  return artifact;
}

function shrinkTowardHalf(raw, market) {
  const factor = SHRINKAGE_FACTOR[market] ?? 0.5;
  return 0.5 + (raw - 0.5) * (1 - factor);
}

function interpolate(mapping, raw) {
  if (!mapping || mapping.length === 0) return raw;
  const xs = mapping.map((p) => p[0]);
  const ys = mapping.map((p) => p[1]);
  if (raw <= xs[0]) return ys[0];
  if (raw >= xs[xs.length - 1]) {
    return ys[ys.length - 1];
  }

  // First index whose x is >= raw (bisect_left equivalent).
  const idx = xs.findIndex((x) => x >= raw);
  if (idx <= 0) return ys[0];
  const x0 = xs[idx - 1];
  const x1 = xs[idx];
  const y0 = ys[idx - 1];
  const y1 = ys[idx];
  if (x1 === x0) return y0;
  const t = (raw - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

/**
 * Map a raw model probability (0-1) to a calibrated probability for a market.
 * Low-sample moneyline metadata uses shrinkage even without a trusted map;
 * otherwise markets fall back to the raw probability when no map exists.
 * Call getCalibrationArtifact() to inspect application and integrity states.
 */
export function calibrateProbability(
  rawProbability,
  market = 'moneyline'
) {
  const marketKey = String(market)
    .trim()
    .toLowerCase();
  const artifact = getCalibrationArtifact(marketKey);

  if (
    artifact.mode === 'shrink_toward_50' ||
    artifact.mode === 'map_low_sample_shrink'
  ) {
    let base = rawProbability;
    if (artifact.mapPresent) {
      base = interpolate(
        artifact.mapping,
        rawProbability
      );
    }
    if (
      artifact.mode === 'shrink_toward_50' ||
      artifact.mode === 'map_low_sample_shrink'
    ) {
      base = shrinkTowardHalf(base, marketKey);
    }
    return clamp(base, 0.05, 0.95);
  }

  if (artifact.mode === 'map' && artifact.mapPresent) {
    const calibrated = interpolate(
      artifact.mapping,
      rawProbability
    );
    return clamp(calibrated, 0.05, 0.95);
  }

  // Identity — explicit, not silent success.
  return rawProbability;
}

/** Percent-scale (0-100) wrapper used across the JavaScript path. */
export function calibratePercent(
  rawPercent,
  market = 'moneyline'
) {
  const raw = Number(rawPercent);
  if (!Number.isFinite(raw)) return rawPercent;
  const side = raw > 1 ? raw / 100 : raw;
  const calibrated = calibrateProbability(side, market);
  return Math.round(calibrated * 1000) / 10;
}

/** True when a usable calibration map exists for the market. */
export function hasCalibrationMap(
  market = 'moneyline'
) {
  const artifact = getCalibrationArtifact(market);
  return (
    artifact.mapPresent && artifact.mode !== 'identity'
  );
}

/**
 * Pure calibration from an explicit frozen artifact — no filesystem, no cache.
 * Used by snapshot replay so exact historical calibration is applied.
 */
export function calibrateProbabilityWithArtifact(
  rawProbability,
  artifact
) {
  const raw = Number(rawProbability);
  if (!Number.isFinite(raw)) return rawProbability;
  const mode = String(artifact?.mode || 'identity');
  const validation = validateCalibrationMapping(
    artifact?.mapping
  );
  const mapping = validation.valid
    ? validation.mapping
    : null;
  const shrinkFactor = Number.isFinite(
    Number(artifact?.shrinkFactor)
  )
    ? Number(artifact.shrinkFactor)
    : 0.5;
  const shrink = (p) =>
    0.5 + (p - 0.5) * (1 - shrinkFactor);

  if (mode === 'map' && mapping) {
    return clamp(interpolate(mapping, raw), 0.05, 0.95);
  }
  if (mode === 'map_low_sample_shrink') {
    const base = mapping
      ? interpolate(mapping, raw)
      : raw;
    return clamp(shrink(base), 0.05, 0.95);
  }
  if (mode === 'shrink_toward_50') {
    return clamp(shrink(raw), 0.05, 0.95);
  }
  return raw;
}

/** Percent-scale convenience for frozen replay. */
export function calibratePercentWithArtifact(
  rawPercent,
  artifact
) {
  const raw = Number(rawPercent);
  if (!Number.isFinite(raw)) return rawPercent;
  const side = raw > 1 ? raw / 100 : raw;
  return Math.round(
    calibrateProbabilityWithArtifact(side, artifact) *
      1000
  ) / 10;
}

/** Build a frozen, serializable calibration artifact from live loader. */
export function freezeCalibrationArtifact(
  market = 'moneyline',
  expected = {}
) {
  const artifact = getCalibrationArtifact(
    market,
    expected
  );
  return JSON.parse(JSON.stringify(artifact));
}

export function verifyCalibrationArtifact(artifact) {
  const reasons = [];
  if (!artifact || typeof artifact !== 'object') {
    return {
      ok: false,
      reasons: ['missing_calibration_artifact'],
      contentHash: null,
      artifactHash: null
    };
  }

  const mode = String(
    artifact.mode ||
      artifact.applicationMode ||
      'identity'
  );
  const validation = validateCalibrationMapping(
    artifact.mapping
  );
  if (
    ['map', 'map_low_sample_shrink'].includes(mode) &&
    !validation.valid
  ) {
    reasons.push('invalid_calibration_mapping');
  }

  const contentHash = computeCalibrationContentHash({
    ...artifact,
    mapping: validation.valid
      ? validation.mapping
      : null
  });
  if (!artifact.contentHash) {
    reasons.push('missing_calibration_content_hash');
  } else if (artifact.contentHash !== contentHash) {
    reasons.push('calibration_content_hash_mismatch');
  }
  if (
    artifact.expectedContentHash &&
    !hashMatches(
      artifact.expectedContentHash,
      contentHash,
      artifact.market
    )
  ) {
    reasons.push(
      'calibration_expected_content_hash_mismatch'
    );
  }

  const artifactHash =
    computeCalibrationArtifactHash({
      ...artifact,
      contentHash
    });
  if (!artifact.artifactHash) {
    reasons.push('missing_calibration_artifact_hash');
  } else if (artifact.artifactHash !== artifactHash) {
    reasons.push('calibration_artifact_hash_mismatch');
  }
  const expectedVersion =
    `cal-${artifact.market}-${artifactHash}`;
  if (!artifact.calibrationVersion) {
    reasons.push('missing_calibration_version');
  } else if (
    artifact.calibrationVersion !== expectedVersion
  ) {
    reasons.push('calibration_version_hash_mismatch');
  }

  if (artifact.integrityStatus === 'active') {
    if (!artifact.modelId) {
      reasons.push('missing_calibration_model_id');
    }
    if (!artifact.modelImplVersion) {
      reasons.push(
        'missing_calibration_model_impl_version'
      );
    }
    if (!artifact.featureSchemaVersion) {
      reasons.push(
        'missing_calibration_feature_schema_version'
      );
    }
    if (!artifact.population) {
      reasons.push('missing_calibration_population');
    }
    if (!artifact.trainingCutoff) {
      reasons.push(
        'missing_calibration_training_cutoff'
      );
    }
    if (!artifact.method) {
      reasons.push('missing_calibration_method');
    }
    if (!artifact.datasetHash) {
      reasons.push('missing_calibration_dataset_hash');
    }
    if (!artifact.expectedContentHash) {
      reasons.push(
        'missing_calibration_expected_content_hash'
      );
    }
  }

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    contentHash,
    artifactHash
  };
}

/** Attach artifact identity onto a prediction object (mutates lightly). */
export function attachCalibrationIdentity(
  prediction,
  market = 'moneyline'
) {
  if (!prediction || typeof prediction !== 'object') {
    return prediction;
  }
  const artifact = getCalibrationArtifact(market);
  prediction.calibrationArtifact = artifact;
  prediction.calibrationVersion =
    artifact.calibrationVersion;
  if (!prediction.versions) prediction.versions = {};
  prediction.versions.calibration =
    artifact.calibrationVersion;
  return prediction;
}
