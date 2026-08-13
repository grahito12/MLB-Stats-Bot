/**
 * Deterministic pure-JS inference for the market_residual_v2 challenger.
 *
 * Fixed-offset residual model:
 *
 *   logit(P_home) = logit(P_market_no_vig_home) + beta0 + beta . X_baseball
 *
 * The market-offset coefficient is FIXED at exactly 1.0 — never fit. Only
 * intercept + baseball-feature coefficients (from the frozen artifact) are
 * applied. Missing/stale/unpaired market data => `unavailable`, NOT a default
 * probability. Missing required features without declared imputation likewise.
 *
 * No Python child process. No network. No mutation of control surfaces.
 */

import { createHash } from 'node:crypto';
import { MARKET_RESIDUAL_V2_MODEL_ID, MARKET_RESIDUAL_V2_IMPL_VERSION } from './model_ids.js';

export const MARKET_RESIDUAL_V2_FEATURE_SCHEMA_VERSION = 'mlb-feature-vector-v1.0';
export const MARKET_RESIDUAL_V2_ARTIFACT_MANIFEST_VERSION = 'market-residual-v2-artifact-v1';
export const MARKET_OFFSET_COEFFICIENT = 1.0;

/**
 * Verify an artifact is compatible with this inference engine.
 */
export function verifyMarketResidualV2Artifact(artifact) {
  const reasons = [];
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, reasons: ['artifact_missing'] };
  }
  if (artifact.model_id !== MARKET_RESIDUAL_V2_MODEL_ID) {
    reasons.push(`model_id_mismatch (got ${artifact.model_id})`);
  }
  if (artifact.model_impl_version !== MARKET_RESIDUAL_V2_IMPL_VERSION) {
    reasons.push(`impl_version_mismatch (got ${artifact.model_impl_version})`);
  }
  if (artifact.feature_schema_version !== MARKET_RESIDUAL_V2_FEATURE_SCHEMA_VERSION) {
    reasons.push(`feature_schema_mismatch (got ${artifact.feature_schema_version})`);
  }
  if (artifact.artifact_manifest_version !== MARKET_RESIDUAL_V2_ARTIFACT_MANIFEST_VERSION) {
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
  // Market offset coefficient must be exactly 1 (fixed, never fit).
  if (artifact.market_offset_coefficient !== MARKET_OFFSET_COEFFICIENT) {
    reasons.push(`market_offset_coefficient_not_fixed_1 (got ${artifact.market_offset_coefficient})`);
  }
  if (artifact.artifact_hash) {
    const recomputed = hashArtifactContent(artifact);
    if (recomputed !== artifact.artifact_hash) {
      reasons.push('artifact_hash_mismatch');
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Score a frozen flattened feature vector + a no-vig market home probability.
 *
 * @param {object} artifact - verified proposal artifact
 * @param {object} flatVector - flattenFeatureVector() output
 * @param {number} marketNoVigHomeProb - same-book no-vig home probability in [0,1]
 * @returns {{ available, homeProbability, awayProbability, marketLogit, residualLogit, marketNoVigProbability, reasons }}
 */
export function scoreMarketResidualV2(artifact, flatVector, marketNoVigHomeProb) {
  if (!flatVector || typeof flatVector !== 'object') {
    return {
      available: false, homeProbability: null, awayProbability: null,
      marketLogit: null, residualLogit: null, marketNoVigProbability: null,
      reasons: ['flat_vector_missing']
    };
  }

  // Market must be present and a valid probability. No market => no residual.
  const reasons = [];
  if (marketNoVigHomeProb == null || typeof marketNoVigHomeProb !== 'number' || !Number.isFinite(marketNoVigHomeProb)) {
    return {
      available: false, homeProbability: null, awayProbability: null,
      marketLogit: null, residualLogit: null, marketNoVigProbability: null,
      reasons: ['market_no_vig_home_prob_missing']
    };
  }
  if (marketNoVigHomeProb <= 0 || marketNoVigHomeProb >= 1) {
    return {
      available: false, homeProbability: null, awayProbability: null,
      marketLogit: null, residualLogit: null, marketNoVigProbability: null,
      reasons: [`market_no_vig_home_prob_out_of_range (${marketNoVigHomeProb})`]
    };
  }

  const marketLogit = Math.log(marketNoVigHomeProb / (1 - marketNoVigHomeProb));

  const featureNames = artifact.feature_names;
  const { coefficients, imputation, feature_mean, feature_std, intercept } = artifact;

  // Baseball residual: beta0 + beta . X_scaled.
  let residualLogit = intercept;
  let missingWithoutImputation = 0;

  for (const name of featureNames) {
    let value = flatVector[name];
    const missingFlag = flatVector[`missing_${name}`];
    const isMissing =
      value == null ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      missingFlag === 1;

    if (isMissing) {
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
      reasons.push(`incomplete_artifact_for_feature_${name}`);
      continue;
    }
    const scaled = (value - mean) / std;
    residualLogit += coef * scaled;
  }

  if (missingWithoutImputation > 0) {
    return {
      available: false, homeProbability: null, awayProbability: null,
      marketLogit, residualLogit: null, marketNoVigProbability: marketNoVigHomeProb,
      reasons: [`missing_features_without_imputation_${missingWithoutImputation}`]
    };
  }
  if (reasons.length > 0) {
    return {
      available: false, homeProbability: null, awayProbability: null,
      marketLogit, residualLogit: null, marketNoVigProbability: marketNoVigHomeProb,
      reasons
    };
  }

  // Fixed-offset combination: market logit (coeff 1) + residual.
  const z = marketLogit + residualLogit;
  const homeProbability = sigmoid(z);
  return {
    available: true,
    homeProbability,
    awayProbability: 1 - homeProbability,
    marketLogit,
    residualLogit,
    marketNoVigProbability: marketNoVigHomeProb,
    reasons: []
  };
}

function sigmoid(z) {
  if (z >= 35) return 1;
  if (z <= -35) return 0;
  return 1 / (1 + Math.exp(-z));
}

export function hashArtifactContent(artifact) {
  const { artifact_hash: _omit, ...body } = artifact;
  return sha256Hex(stableStringify(body));
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

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}
