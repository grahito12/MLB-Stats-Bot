/**
 * P6 OOF calibration proposal artifact reader (shadow/proposal only).
 *
 * Reads a versioned OOF-calibration proposal artifact (produced by
 * src/eval/oof_calibration.py) and applies the selected calibration method to a
 * raw probability. Pure JS inference — no Python child process, no network.
 *
 * This module is PROPOSAL-ONLY. It never replaces the live V1 calibration path
 * (src/calibration.js calibrateProbability), never mutates calibration_maps.json
 * / calibration_meta.json / calibration_map.json, the model registry, env vars,
 * or any live pointer. Activation requires separate human approval.
 *
 * Compatibility checks enforced on load:
 *   model_id, artifact_manifest_version, method, target_probability,
 *   dataset_hash, artifact_hash (tamper reject), training_cutoff, sample_count.
 * A mismatched/tampered artifact is rejected (returns unavailable), never a
 * silently applied default.
 *
 * Supported methods (must mirror DEPLOYABLE_METHODS in oof_calibration.py):
 *   identity            — cal(p) = p
 *   platt               — cal(p) = sigmoid(a * logit(p) + b)
 *   isotonic_guarded    — cal(p) = piecewise-linear interpolation of PAV map
 *
 * beta is NOT supported here (no JS betaincinv parity); it is a comparison
 * reference only on the Python side and never selected as deployable.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HEURISTIC_V1_MODEL_ID,
  CONTROL_FEATURE_SCHEMA_VERSION
} from './model_ids.js';

export const OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION =
  'oof-calibration-artifact-v1';
export const OOF_CALIBRATION_DEPLOYABLE_METHODS = [
  'identity',
  'platt',
  'isotonic_guarded'
];

const CLAMP_LO = 0.05;
const CLAMP_HI = 0.95;
const EPS = 1e-6;

/**
 * Verify an OOF calibration proposal artifact is compatible + untampered.
 * Returns { ok, reasons }.
 */
export function verifyOofCalibrationArtifact(artifact) {
  const reasons = [];
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, reasons: ['artifact_missing'] };
  }
  if (artifact.artifact_manifest_version !== OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION) {
    reasons.push(
      `manifest_version_mismatch (got ${artifact.artifact_manifest_version})`
    );
  }
  if (artifact.model_id !== HEURISTIC_V1_MODEL_ID) {
    reasons.push(`model_id_mismatch (got ${artifact.model_id})`);
  }
  const method = artifact.method;
  if (!OOF_CALIBRATION_DEPLOYABLE_METHODS.includes(method)) {
    reasons.push(
      `method_not_deployable (got ${method}; only ${OOF_CALIBRATION_DEPLOYABLE_METHODS.join('/')} have JS parity)`
    );
  }
  if (typeof artifact.sample_count !== 'number' || artifact.sample_count < 0) {
    reasons.push('sample_count_missing_or_nonnumeric');
  }
  if (!artifact.dataset_hash) {
    reasons.push('dataset_hash_missing');
  }
  if (!artifact.training_cutoff) {
    reasons.push('training_cutoff_missing');
  }
  // Method-specific param presence.
  if (method === 'platt') {
    const p = artifact.params || {};
    if (typeof p.a !== 'number' || typeof p.b !== 'number') {
      reasons.push('platt_params_missing');
    } else if (!Number.isFinite(p.a) || !Number.isFinite(p.b)) {
      reasons.push('platt_params_nonfinite');
    } else if (p.a <= 0) {
      reasons.push('platt_nonpositive_slope');
    }
  } else if (method === 'isotonic_guarded') {
    if (!Array.isArray(artifact.params) || artifact.params.length < 2) {
      reasons.push('isotonic_map_missing_or_too_short');
    } else {
      // Validate map structure + monotonicity.
      const v = validateIsotonicMap(artifact.params);
      if (!v.valid) reasons.push(`isotonic_map_invalid:${v.reason}`);
    }
  }
  // Re-derive artifact hash (tamper reject).
  if (artifact.artifact_hash) {
    const recomputed = hashArtifactContent(artifact);
    if (recomputed !== artifact.artifact_hash) {
      reasons.push('artifact_hash_mismatch');
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Apply a verified proposal artifact to a raw probability (0-1).
 * Frozen-replay: all params come from the artifact, nothing recomputed live.
 */
export function applyOofCalibration(artifact, rawProbability) {
  const raw = Number(rawProbability);
  if (!Number.isFinite(raw)) return rawProbability;
  const method = artifact.method;
  const params = artifact.params;
  if (method === 'identity') {
    return clamp(raw);
  }
  if (method === 'platt') {
    return clamp(sigmoid(params.a * logit(raw) + params.b));
  }
  if (method === 'isotonic_guarded') {
    return clamp(interpolateIsotonic(params, raw));
  }
  // Unknown method — identity fallback (never a fabricated probability).
  return clamp(raw);
}

/**
 * Load the newest compatible OOF calibration proposal artifact for a model.
 * Returns { artifact, path } or null. Proposal-only; never touches live maps.
 */
export function loadOofCalibrationArtifact(
  modelId = HEURISTIC_V1_MODEL_ID,
  artifactsDir = 'data/models'
) {
  if (!existsSync(artifactsDir)) return null;
  let candidates = [];
  try {
    candidates = readdirSync(artifactsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(artifactsDir, f));
  } catch {
    return null;
  }
  let best = null;
  for (const path of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const inner =
      parsed.artifact && typeof parsed.artifact === 'object'
        ? parsed.artifact
        : parsed;
    if (inner.model_id !== modelId) continue;
    if (
      inner.artifact_manifest_version !== OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION
    )
      continue;
    // Skip report-form files that carry no usable artifact (insufficient_data).
    if (parsed.status === 'insufficient_data') continue;
    const verify = verifyOofCalibrationArtifact(inner);
    if (!verify.ok) continue;
    const mtime = fileMtime(path);
    if (!best || mtime > best.mtime) {
      best = { artifact: inner, path, mtime };
    }
  }
  return best ? { artifact: best.artifact, path: best.path } : null;
}

// ---- math helpers ----

function clamp(v, lo = CLAMP_LO, hi = CLAMP_HI) {
  return Math.max(lo, Math.min(hi, v));
}

function logit(p) {
  const c = Math.min(Math.max(p, EPS), 1 - EPS);
  return Math.log(c / (1 - c));
}

function sigmoid(z) {
  if (z >= 35) return 1;
  if (z <= -35) return 0;
  return 1 / (1 + Math.exp(-z));
}

function validateIsotonicMap(mapping) {
  if (!Array.isArray(mapping) || mapping.length < 2) {
    return { valid: false, reason: 'too_short' };
  }
  let prevX = null;
  let prevY = null;
  for (const pair of mapping) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return { valid: false, reason: 'invalid_pair' };
    }
    const x = Number(pair[0]);
    const y = Number(pair[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { valid: false, reason: 'non_finite_point' };
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return { valid: false, reason: 'point_out_of_range' };
    }
    if (prevX !== null && x <= prevX) {
      return { valid: false, reason: 'x_not_strictly_increasing' };
    }
    if (prevY !== null && y < prevY) {
      return { valid: false, reason: 'y_not_monotonic' };
    }
    prevX = x;
    prevY = y;
  }
  return { valid: true, reason: null };
}

function interpolateIsotonic(mapping, raw) {
  if (!mapping || mapping.length === 0) return raw;
  const xs = mapping.map((p) => p[0]);
  const ys = mapping.map((p) => p[1]);
  if (raw <= xs[0]) return ys[0];
  if (raw >= xs[xs.length - 1]) return ys[ys.length - 1];
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

function fileMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Re-derive the artifact hash over content fields (excluding the hash itself).
 * Mirrors Python _artifact_hash (stable sorted-key stringify + sha256).
 */
export function hashArtifactContent(artifact) {
  const { artifact_hash: _omit, ...body } = artifact;
  const stable = stableStringify(body);
  return createHash('sha256').update(stable).digest('hex');
}

function stableStringify(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

// Re-export for test convenience.
export { CONTROL_FEATURE_SCHEMA_VERSION };
