/**
 * Real snapshot-based prediction replay.
 *
 * Two modes, chosen by what the frozen snapshot contains:
 *
 *   - RECOMPUTE: the snapshot carries `coreInputs` (frozen raw features, plain
 *     JSON) plus a frozen `calibrationArtifact`. Replay re-runs the canonical
 *     pure core (src/core/prediction_core.js) from those inputs and compares
 *     the recomputed probabilities against the stored decision. This is the
 *     honest replay: it does not merely copy saved decisions.
 *
 *   - PROJECTION (legacy): older snapshots only store the already-computed
 *     decision fields. Replay round-trips them through canonical serialization
 *     and asserts hash/field stability. This proves snapshot integrity but does
 *     NOT recompute the model — it is labeled `projection` so it is never
 *     mistaken for promotion-eligible replay evidence.
 *
 * No network, database, current-time, current-odds, or current-calibration
 * access: the calibration function and `now` are reconstructed only from the
 * frozen artifact and frozen timestamps inside the snapshot.
 */

import { predictGameMoneylineCore } from './core/prediction_core.js';
import {
  calibratePercentWithArtifact,
  verifyCalibrationArtifact
} from './calibration.js';
import { moneylineWeightMultiplier } from './evolutionControls.js';
import {
  assertReplayParity,
  projectDecisionFromSnapshot
} from './prediction_snapshot.js';
import { parseSnapshot, readSnapshotFile, serializeSnapshot } from './prediction_serializer.js';
import { hashPayload } from './prediction_snapshot.js';
import { assertPregameEligible } from './temporal_contract.js';
import {
  CONTROL_FEATURE_SCHEMA_VERSION,
  HEURISTIC_V1_IMPL_VERSION,
  HEURISTIC_V1_MODEL_ID
} from './core/model_ids.js';

export const PROBABILITY_TOLERANCE = 1e-9;
export const EDGE_TOLERANCE = 1e-9;

/** Convert a plain-JS object of id->value back into a Map (ids stay numeric-ish). */
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

/**
 * Rebuild the pure-core input bundle from frozen snapshot coreInputs.
 * Everything comes from the snapshot; nothing is read live.
 */
function rebuildCoreInput(snapshot) {
  const raw = snapshot.coreInputs || {};
  const artifact = snapshot.calibrationArtifact || {};
  const parkEntries = Array.isArray(raw.parkFactorBaselines) ? raw.parkFactorBaselines : [];
  const parkFactorBaselines = new Map(
    parkEntries.map((entry) => [entry.id ?? entry[0], entry.value ?? entry[1]])
  );

  return {
    game: raw.game,
    teamStats: toKeyMap(raw.teamStats),
    standings: toKeyMap(raw.standings),
    pitcherStats: toKeyMap(raw.pitcherStats),
    pitcherDetails: toKeyMap(raw.pitcherDetails),
    pitcherRecentStarts: toKeyMap(raw.pitcherRecentStarts),
    bullpenProfiles: toKeyMap(raw.bullpenProfiles),
    scheduleFatigueProfiles: toKeyMap(raw.scheduleFatigueProfiles),
    headToHead: raw.headToHead || null,
    injuryProfiles: toKeyMap(raw.injuryProfiles),
    lineupProfiles: raw.lineupProfiles || { away: null, home: null },
    modelMemory: raw.modelMemory || {},
    rollingTeamStats: toKeyMap(raw.rollingTeamStats),
    evolutionControls: raw.evolutionControls || {},
    calibratePercent: (percent, market) => calibratePercentWithArtifact(percent, artifact),
    parkFactorBaselines,
    nowMs: snapshot.predictionTimestampUtc || snapshot.asOfUtc,
    // Same multiplier math as live (ratio of active weight to the baseline
    // defaults) so situational/home-advantage components match bit-for-bit.
    moneylineWeightMultiplierFn: moneylineWeightMultiplier
  };
}

/**
 * Recompute the moneyline prediction from a frozen snapshot using the pure core.
 * Throws when the snapshot lacks coreInputs (projection-only snapshot).
 */
export function recomputeFromSnapshot(snapshot) {
  if (!snapshot?.coreInputs || !snapshot.coreInputs.game) {
    throw new Error(
      'snapshot has no coreInputs — only projection replay is possible (not promotion-eligible)'
    );
  }
  const core = predictGameMoneylineCore(rebuildCoreInput(snapshot));
  return {
    gamePk: String(snapshot.gamePk),
    snapshotHash: snapshot.snapshotHash,
    rawHomeProbability: core.raw.homeProbability,
    rawAwayProbability: core.raw.awayProbability,
    pureHomeProbability: core.calibrated.homeProbability,
    pureAwayProbability: core.calibrated.awayProbability,
    edge: core.raw.edge,
    dampenedEdge: core.raw.dampenedEdge,
    dampeningFactor: core.raw.dampeningFactor,
    versions: snapshot.versions || {},
    asOfUtc: snapshot.asOfUtc,
    firstPitchUtc: snapshot.firstPitchUtc
  };
}

// Display probabilities are rounded to 0.1 on every surface; recomputing the
// exact value can land on the other side of a rounding boundary. Raw (full
// precision) stages use PROBABILITY_TOLERANCE; display stages use the rounding
// quantum so a 50.49->50.5 vs 50.51->50.5 style boundary is not a false failure.
const DISPLAY_ROUNDING_TOLERANCE = 0.1 + PROBABILITY_TOLERANCE;

/**
 * Compare a recomputed core result against the probabilities stored in the
 * snapshot's modelInputs, within explicit tolerance.
 */
export function compareRecomputeToStored(snapshot, recomputed) {
  const stored = snapshot.modelInputs || {};
  // Full-precision raw stages: authoritative parity gate.
  const rawChecks = [
    ['rawHomeProbability', stored.rawHomeProbability, recomputed.rawHomeProbability, PROBABILITY_TOLERANCE],
    ['rawAwayProbability', stored.rawAwayProbability, recomputed.rawAwayProbability, PROBABILITY_TOLERANCE],
    ['dampenedEdge', stored.dampenedEdge, recomputed.dampenedEdge, EDGE_TOLERANCE],
    ['rawEdge', stored.rawEdge, recomputed.edge, EDGE_TOLERANCE]
  ];
  // Display-rounded calibrated stages: rounding-tolerant.
  const displayChecks = [
    ['pureHomeProbability', stored.pureHomeProbability, recomputed.pureHomeProbability, DISPLAY_ROUNDING_TOLERANCE],
    ['pureAwayProbability', stored.pureAwayProbability, recomputed.pureAwayProbability, DISPLAY_ROUNDING_TOLERANCE]
  ];
  const mismatches = [];
  for (const [key, expected, actual, tolerance] of [...rawChecks, ...displayChecks]) {
    if (expected == null) continue; // older snapshots may not store raw stages
    const e = Number(expected);
    const a = Number(actual);
    if (!Number.isFinite(e) || !Number.isFinite(a) || Math.abs(e - a) > tolerance) {
      mismatches.push({ key, stored: expected, recomputed: actual, tolerance });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function replayProjection(snapshot) {
  const first = projectDecisionFromSnapshot(snapshot);
  const roundTrip = parseSnapshot(serializeSnapshot(snapshot));
  const second = projectDecisionFromSnapshot(roundTrip);
  const parity = assertReplayParity(first, second);
  return {
    mode: 'projection',
    promotionEligible: false,
    decision: first,
    parity,
    snapshotHash: snapshot.snapshotHash
  };
}

function replayPromotionGate(snapshot, parity) {
  const reasons = [];
  const temporal = assertPregameEligible({
    asOf: snapshot.asOfUtc || snapshot.predictionTimestampUtc,
    firstPitch: snapshot.firstPitchUtc
  });
  if (!temporal.ok) reasons.push(temporal.reason);

  const versions = snapshot.versions || {};
  if (!versions.modelId) {
    reasons.push('missing_model_id');
  } else if (versions.modelId !== HEURISTIC_V1_MODEL_ID) {
    reasons.push('incompatible_model_id');
  }
  const modelImplVersion = versions.modelImplVersion || versions.modelVersion;
  if (!modelImplVersion) {
    reasons.push('missing_model_impl_version');
  } else if (modelImplVersion !== HEURISTIC_V1_IMPL_VERSION) {
    reasons.push('incompatible_model_impl_version');
  }
  if (!versions.featureSchemaVersion) {
    reasons.push('missing_feature_schema_version');
  } else if (versions.featureSchemaVersion !== CONTROL_FEATURE_SCHEMA_VERSION) {
    reasons.push('incompatible_feature_schema_version');
  }

  const calibration = snapshot.calibrationArtifact;
  if (!calibration) {
    reasons.push('missing_calibration_artifact');
  } else {
    const verification = verifyCalibrationArtifact(
      calibration
    );
    reasons.push(...verification.reasons);
    if (calibration.promotionSafe !== true) {
      reasons.push(`calibration_${calibration.integrityStatus || 'not_promotion_safe'}`);
    }
    if (calibration.expectedModelId !== versions.modelId) {
      reasons.push('calibration_expected_model_mismatch');
    }
    if (calibration.expectedModelImplVersion !== modelImplVersion) {
      reasons.push('calibration_expected_model_impl_mismatch');
    }
    if (calibration.expectedFeatureSchemaVersion !== versions.featureSchemaVersion) {
      reasons.push('calibration_expected_feature_schema_mismatch');
    }
    if (
      calibration.modelId &&
      calibration.modelId !== versions.modelId
    ) {
      reasons.push('calibration_model_mismatch');
    }
    if (
      calibration.modelImplVersion &&
      calibration.modelImplVersion !== modelImplVersion
    ) {
      reasons.push('calibration_model_impl_mismatch');
    }
    if (
      calibration.featureSchemaVersion &&
      calibration.featureSchemaVersion !== versions.featureSchemaVersion
    ) {
      reasons.push('calibration_feature_schema_mismatch');
    }
  }
  if (snapshot.predictionQuality?.promotionEligible === false) {
    reasons.push(...(snapshot.predictionQuality.reasons || ['prediction_quality_ineligible']));
  }
  if (!parity.ok) reasons.push('recompute_parity_failed');

  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)]
  };
}

function snapshotIntegrity(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      ok: false,
      reason: 'invalid_snapshot'
    };
  }
  const { snapshotHash, ...body } = snapshot;
  const expected = hashPayload(body);
  if (!snapshotHash) {
    return {
      ok: false,
      reason: 'missing_snapshot_hash',
      expected,
      actual: snapshotHash || null
    };
  }
  if (snapshotHash !== expected) {
    return {
      ok: false,
      reason: 'snapshot_hash_integrity_failure',
      expected,
      actual: snapshotHash
    };
  }
  return { ok: true, expected, actual: snapshotHash };
}

function replayRecompute(snapshot) {
  const integrity = snapshotIntegrity(snapshot);
  const recomputed = recomputeFromSnapshot(snapshot);
  const parity = compareRecomputeToStored(snapshot, recomputed);
  const gatedParity = integrity.ok
    ? parity
    : {
        ok: false,
        mismatches: [
          ...parity.mismatches,
          {
            key: 'snapshotHash',
            stored: integrity.actual,
            recomputed: integrity.expected,
            reason: integrity.reason
          }
        ]
      };
  const promotionGate = replayPromotionGate(snapshot, gatedParity);
  return {
    mode: 'recompute',
    promotionEligible: promotionGate.eligible,
    promotionReasons: promotionGate.reasons,
    decision: recomputed,
    parity: gatedParity,
    integrity,
    snapshotHash: snapshot.snapshotHash
  };
}

/**
 * Replay a snapshot. Uses recompute when coreInputs are present, otherwise
 * falls back to projection (explicitly labeled, never promotion-eligible).
 */
export function replaySnapshot(snapshot) {
  if (snapshot?.coreInputs?.game) {
    return replayRecompute(snapshot);
  }
  return replayProjection(snapshot);
}

export function replaySnapshotFile(path) {
  return replaySnapshot(readSnapshotFile(path));
}

export function replayTwice(snapshot) {
  const a = replaySnapshot(snapshot);
  const b = replaySnapshot(snapshot);
  // For recompute mode, compare the recomputed decisions; for projection,
  // compare projected decisions.
  const parity = assertReplayParity(a.decision, b.decision);
  return { a, b, parity };
}

/** Hash a snapshot's coreInputs for change-detection in mutation tests. */
export function coreInputsHash(snapshot) {
  return snapshot?.coreInputs ? hashPayload(snapshot.coreInputs) : null;
}
