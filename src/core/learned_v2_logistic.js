/**
 * Deterministic pure-JS inference for the learned_v2_logistic challenger.
 *
 * Reads a versioned proposal artifact (produced by
 * src/models/train_learned_v2_logistic.py) and scores a frozen feature vector.
 * No Python child process. No network. No mutation of control surfaces.
 *
 * Contract:
 *  - Input: the frozen flattened feature vector (flattenFeatureVector) +
 *    a loaded artifact.
 *  - Output: { available, homeProbability, awayProbability, logit, reasons }.
 *  - Missing required features without declared imputation support return
 *    `available: false` (unavailable), NOT a default probability. The caller
 *    (model_registry) must then skip recording a usable row or record an
 *    explicit unavailable reason.
 *  - All imputation medians, scaling, and coefficients come from the artifact,
 *    frozen at training time. Nothing is recomputed live.
 */

import { LEARNED_V2_LOGISTIC_MODEL_ID, LEARNED_V2_LOGISTIC_IMPL_VERSION } from './model_ids.js';

export const LEARNED_V2_LOGISTIC_FEATURE_SCHEMA_VERSION = 'mlb-feature-vector-v1.0';
export const LEARNED_V2_LOGISTIC_ARTIFACT_MANIFEST_VERSION = 'learned-v2-logistic-artifact-v1';

/**
 * Verify an artifact is compatible with this inference engine.
 * Returns { ok, reasons }.
 */
export function verifyLearnedV2Artifact(artifact) {
  const reasons = [];
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, reasons: ['artifact_missing'] };
  }
  if (artifact.model_id !== LEARNED_V2_LOGISTIC_MODEL_ID) {
    reasons.push(`model_id_mismatch (got ${artifact.model_id})`);
  }
  if (artifact.model_impl_version !== LEARNED_V2_LOGISTIC_IMPL_VERSION) {
    reasons.push(`impl_version_mismatch (got ${artifact.model_impl_version})`);
  }
  if (artifact.feature_schema_version !== LEARNED_V2_LOGISTIC_FEATURE_SCHEMA_VERSION) {
    reasons.push(`feature_schema_mismatch (got ${artifact.feature_schema_version})`);
  }
  if (artifact.artifact_manifest_version !== LEARNED_V2_LOGISTIC_ARTIFACT_MANIFEST_VERSION) {
    reasons.push(`manifest_version_mismatch (got ${artifact.artifact_manifest_version})`);
  }
  if (!Array.isArray(artifact.feature_names) || artifact.feature_names.length === 0) {
    reasons.push('feature_names_missing_or_empty');
  }
  if (!artifact.coefficients || typeof artifact.coefficients !== 'object') {
    reasons.push('coefficients_missing');
  }
  if (!artifact.imputation || typeof artifact.imputation !== 'object') {
    reasons.push('imputation_missing');
  }
  if (!artifact.feature_mean || typeof artifact.feature_mean !== 'object') {
    reasons.push('feature_mean_missing');
  }
  if (!artifact.feature_std || typeof artifact.feature_std !== 'object') {
    reasons.push('feature_std_missing');
  }
  if (typeof artifact.intercept !== 'number' || !Number.isFinite(artifact.intercept)) {
    reasons.push('intercept_missing_or_nonfinite');
  }
  // Re-derive the artifact hash and confirm it was not tampered with.
  if (artifact.artifact_hash) {
    const recomputed = hashArtifactContent(artifact);
    if (recomputed !== artifact.artifact_hash) {
      reasons.push('artifact_hash_mismatch');
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Score a frozen flattened feature vector with a verified artifact.
 *
 * @param {object} artifact - verified proposal artifact
 * @param {object} flatVector - flattenFeatureVector() output (value + missing_<f>)
 * @returns {{ available: boolean, homeProbability: number|null, awayProbability: number|null, logit: number|null, reasons: string[] }}
 */
export function scoreLearnedV2Logistic(artifact, flatVector) {
  const reasons = [];
  if (!flatVector || typeof flatVector !== 'object') {
    return { available: false, homeProbability: null, awayProbability: null, logit: null, reasons: ['flat_vector_missing'] };
  }

  const featureNames = artifact.feature_names;
  const { coefficients, imputation, feature_mean, feature_std, intercept } = artifact;

  let z = intercept;
  let missingWithoutImputation = 0;

  for (const name of featureNames) {
    let value = flatVector[name];
    const missingFlag = flatVector[`missing_${name}`];

    // Treat as missing if value is null/undefined/non-finite OR the explicit
    // missingness flag is set.
    const isMissing =
      value == null ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      missingFlag === 1;

    if (isMissing) {
      // Imputation median was declared at training time for every feature.
      // If the artifact lacks a median for this feature (shouldn't happen for
      // a compatible artifact), the row is unavailable, not defaulted.
      const median = imputation[name];
      if (median == null || !Number.isFinite(median)) {
        missingWithoutImputation += 1;
        continue;
      }
      value = median;
    }

    const coef = coefficients[name];
    const mean = feature_mean[name];
    const std = feature_std[name];

    if (coef == null || mean == null || std == null || !Number.isFinite(std) || std === 0) {
      // A compatible artifact declares all of these; absence is a hard fault.
      reasons.push(`incomplete_artifact_for_feature_${name}`);
      continue;
    }

    const scaled = (value - mean) / std;
    z += coef * scaled;
  }

  if (missingWithoutImputation > 0) {
    return {
      available: false,
      homeProbability: null,
      awayProbability: null,
      logit: null,
      reasons: [`missing_features_without_imputation_${missingWithoutImputation}`]
    };
  }

  if (reasons.length > 0) {
    return { available: false, homeProbability: null, awayProbability: null, logit: null, reasons };
  }

  // Sigmoid with safe clamp (matches Python _predict_fold).
  const homeProbability = sigmoid(z);
  return {
    available: true,
    homeProbability,
    awayProbability: 1 - homeProbability,
    logit: z,
    reasons: []
  };
}

function sigmoid(z) {
  if (z >= 35) return 1;
  if (z <= -35) return 0;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Re-derive the artifact hash over the content fields (excluding the hash
 * itself). Must match the Python _artifact_hash ordering (sort_keys, default=str).
 */
export function hashArtifactContent(artifact) {
  const { artifact_hash: _omit, ...body } = artifact;
  const stable = stableStringify(body);
  return sha256Hex(stable);
}

function stableStringify(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

import { createHash } from 'node:crypto';
function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}
