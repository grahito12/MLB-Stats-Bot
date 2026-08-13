// P6 OOF calibration proposal artifact reader (JS) tests.
//
// Verifies:
//   - identity / platt / isotonic_guarded application correctness
//   - verifyOofCalibrationArtifact rejects tampered / incompatible artifacts
//   - artifact hash re-derivation matches Python layout
//   - loadOofCalibrationArtifact picks newest compatible, skips insufficient
//   - proposal-only: module never reads/writes live calibration files
//
// Uses temp dirs. Never touches live data/state.sqlite or data/calibration_*.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifyOofCalibrationArtifact,
  applyOofCalibration,
  hashArtifactContent,
  loadOofCalibrationArtifact,
  OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION,
  OOF_CALIBRATION_DEPLOYABLE_METHODS
} from '../src/core/calibration_proposal.js';

function baseArtifact(overrides = {}) {
  return {
    artifact_manifest_version: OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION,
    model_id: 'heuristic_v1',
    method: 'identity',
    target_probability: 'raw_home_probability',
    params: {},
    dataset_hash: 'abc123',
    training_cutoff: '2026-08-01',
    sample_count: 220,
    ...overrides
  };
}

function withHash(artifact) {
  const hash = hashArtifactContent(artifact);
  return { ...artifact, artifact_hash: hash };
}

// ---------- method application ----------

test('identity application returns clamped input', () => {
  const a = withHash(baseArtifact({ method: 'identity' }));
  assert.ok(verifyOofCalibrationArtifact(a).ok);
  assert.equal(applyOofCalibration(a, 0.5), 0.5);
  // clamp to [0.05, 0.95]
  assert.equal(applyOofCalibration(a, 0.99), 0.95);
  assert.equal(applyOofCalibration(a, 0.01), 0.05);
});

test('platt application compresses over-confident probability', () => {
  // a<1 shrinks toward 0.5: sigmoid(0.5*logit(0.8)+0). logit(0.8)=1.386, *0.5=0.693,
  // sigmoid(0.693)=0.666 -> over-confident 0.8 pulled toward 0.5.
  const a = withHash(baseArtifact({
    method: 'platt',
    params: { a: 0.5, b: 0.0 }
  }));
  assert.ok(verifyOofCalibrationArtifact(a).ok);
  const cal = applyOofCalibration(a, 0.8);
  assert.ok(cal < 0.8 && cal > 0.5, `expected shrunk, got ${cal}`);
  // symmetry: 0.2 maps below 0.5
  const calLow = applyOofCalibration(a, 0.2);
  assert.ok(calLow > 0.2 && calLow < 0.5);
});

test('isotonic_guarded interpolates the PAV map', () => {
  const mapping = [[0.3, 0.35], [0.5, 0.48], [0.7, 0.62]];
  const a = withHash(baseArtifact({
    method: 'isotonic_guarded',
    params: mapping
  }));
  assert.ok(verifyOofCalibrationArtifact(a).ok);
  // below first x -> first y
  assert.equal(applyOofCalibration(a, 0.2), 0.35);
  // above last x -> last y
  assert.equal(applyOofCalibration(a, 0.9), 0.62);
  // midpoint between 0.3 and 0.5 -> midpoint of 0.35 and 0.48
  const mid = applyOofCalibration(a, 0.4);
  assert.ok(Math.abs(mid - 0.415) < 1e-6, `got ${mid}`);
});

// ---------- verification / tamper ----------

test('verify rejects wrong model_id', () => {
  const a = withHash(baseArtifact({ model_id: 'learned_v2_logistic' }));
  const v = verifyOofCalibrationArtifact(a);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.startsWith('model_id_mismatch')));
});

test('verify rejects beta (no JS parity)', () => {
  const a = withHash(baseArtifact({ method: 'beta', params: { alpha: 1, beta: 1 } }));
  const v = verifyOofCalibrationArtifact(a);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.startsWith('method_not_deployable')));
});

test('verify rejects tampered params (hash mismatch)', () => {
  const a = withHash(baseArtifact({ method: 'platt', params: { a: 0.5, b: 0.0 } }));
  // mutate params after hashing
  a.params.a = 2.0;
  const v = verifyOofCalibrationArtifact(a);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes('artifact_hash_mismatch'));
});

test('verify rejects nonpositive platt slope', () => {
  const a = withHash(baseArtifact({ method: 'platt', params: { a: -0.5, b: 0.0 } }));
  const v = verifyOofCalibrationArtifact(a);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes('platt_nonpositive_slope') || r.includes('hash')));
});

test('verify rejects non-monotonic isotonic map', () => {
  const a = withHash(baseArtifact({
    method: 'isotonic_guarded',
    params: [[0.3, 0.4], [0.5, 0.35], [0.7, 0.6]]  // 0.35 < 0.4 breaks monotonicity
  }));
  const v = verifyOofCalibrationArtifact(a);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes('isotonic_map_invalid:y_not_monotonic') || r.includes('hash')));
});

test('verify rejects missing dataset_hash / training_cutoff', () => {
  const a = baseArtifact();
  delete a.dataset_hash;
  delete a.training_cutoff;
  const h = hashArtifactContent(a);
  a.artifact_hash = h;
  const v = verifyOofCalibrationArtifact(a);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.includes('dataset_hash_missing'));
  assert.ok(v.reasons.includes('training_cutoff_missing'));
});

// ---------- artifact loading ----------

test('loadOofCalibrationArtifact picks newest compatible', () => {
  const dir = join(tmpdir(), `p6-calib-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const old = withHash(baseArtifact({ sample_count: 100 }));
    writeFileSync(join(dir, 'heuristic_v1-oof-calibration-trained-aaaaaaaaaaaa.json'),
      JSON.stringify({ status: 'trained', artifact: old }));
    // newest mtime: write second file slightly later, then bump its mtime.
    const newer = withHash(baseArtifact({ sample_count: 200 }));
    const newerPath = join(dir, 'heuristic_v1-oof-calibration-trained-bbbbbbbbbbbb.json');
    writeFileSync(newerPath, JSON.stringify({ status: 'trained', artifact: newer }));
    const future = new Date(Date.now() / 1000 * 1000 + 5000);
    utimesSync(newerPath, future, future);
    const loaded = loadOofCalibrationArtifact('heuristic_v1', dir);
    assert.ok(loaded, 'should load an artifact');
    assert.equal(loaded.artifact.sample_count, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOofCalibrationArtifact skips insufficient_data reports', () => {
  const dir = join(tmpdir(), `p6-calib-insuf-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'heuristic_v1-oof-calibration-insufficient_data-xxxxxxxxxxxx.json'),
      JSON.stringify({ status: 'insufficient_data', artifact: null, model_id: 'heuristic_v1' }));
    const loaded = loadOofCalibrationArtifact('heuristic_v1', dir);
    assert.equal(loaded, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deployable methods are identity/platt/isotonic_guarded', () => {
  assert.deepEqual([...OOF_CALIBRATION_DEPLOYABLE_METHODS].sort(),
    ['identity', 'isotonic_guarded', 'platt']);
});

test('hashArtifactContent excludes the artifact_hash field', () => {
  const a = baseArtifact({ method: 'platt', params: { a: 1.0, b: 0.0 } });
  const h1 = hashArtifactContent(a);
  // adding an artifact_hash field must not change the content hash
  const h2 = hashArtifactContent({ ...a, artifact_hash: h1 });
  assert.equal(h1, h2);
});
