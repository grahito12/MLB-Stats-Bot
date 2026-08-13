/**
 * Model registry / shadow orchestrator.
 *
 * Defaults preserve control behavior exactly:
 *   MLB_MODEL_VERSION  (default heuristic_v1)
 *   MLB_SHADOW_MODE    (default false)
 *
 * When MLB_SHADOW_MODE is explicitly true AND a compatible challenger
 * artifact exists, the orchestrator scores the challenger on the SAME frozen
 * run and returns a row to append via recordModelPrediction. It NEVER mutates
 * winner, winProbability, VALUE, stake, Telegram, dashboard, CLV, or model
 * memory. The control row is written by capturePredictionSnapshot before any
 * shadow scoring; shadow rows are appended separately.
 *
 * Artifact discovery: scans data/models/ for the newest compatible artifact of
 * each challenger model_id. A missing/incompatible artifact is a no-op (no
 * shadow row, clear reason in logs) — never a default probability.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEARNED_V2_LOGISTIC_MODEL_ID,
  LEARNED_V2_LOGISTIC_IMPL_VERSION,
  MARKET_RESIDUAL_V2_MODEL_ID,
  MARKET_RESIDUAL_V2_IMPL_VERSION,
  DEFAULT_MODEL_VERSION,
  DEFAULT_SHADOW_MODE,
  MODEL_ARTIFACTS_DIR
} from './model_ids.js';
import { buildFeatureVector, flattenFeatureVector } from './feature_vector.js';
import {
  verifyLearnedV2Artifact,
  scoreLearnedV2Logistic,
  LEARNED_V2_LOGISTIC_FEATURE_SCHEMA_VERSION
} from './learned_v2_logistic.js';
import {
  verifyMarketResidualV2Artifact,
  scoreMarketResidualV2,
  MARKET_RESIDUAL_V2_FEATURE_SCHEMA_VERSION
} from './market_residual_v2.js';
import { noVigMarketProbabilities } from '../market_residual.js';

/**
 * Read shadow-mode config from env. Pure read; never mutates env.
 */
export function readModelRegistryConfig() {
  const modelVersion = process.env.MLB_MODEL_VERSION || DEFAULT_MODEL_VERSION;
  const shadowMode = parseBool(process.env.MLB_SHADOW_MODE, DEFAULT_SHADOW_MODE);
  const artifactsDir = process.env.MLB_MODEL_ARTIFACTS_DIR || MODEL_ARTIFACTS_DIR;
  return { modelVersion, shadowMode, artifactsDir };
}

function parseBool(value, fallback) {
  if (value == null) return fallback;
  const s = String(value).toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

function verifyArtifactForModel(modelId, artifact) {
  if (modelId === LEARNED_V2_LOGISTIC_MODEL_ID) {
    return verifyLearnedV2Artifact(artifact);
  }
  if (modelId === MARKET_RESIDUAL_V2_MODEL_ID) {
    return verifyMarketResidualV2Artifact(artifact);
  }
  return { ok: false, reasons: ['unknown_challenger_model_id'] };
}

/**
 * Load the newest compatible artifact for a challenger model_id.
 * Returns { artifact, path } or null.
 */
export function loadChallengerArtifact(modelId, artifactsDir = MODEL_ARTIFACTS_DIR) {
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
    // The artifact file is the full training report; the deployable artifact
    // lives under its `artifact` key. Accept either form.
    const inner = parsed.artifact && typeof parsed.artifact === 'object' ? parsed.artifact : parsed;
    if (inner.model_id !== modelId) continue;
    if (inner.status === 'insufficient_data' || inner.artifact == null) {
      // Report form with no usable artifact.
      if (parsed.status === 'insufficient_data' || parsed.artifact == null) continue;
    }
    const verify = verifyArtifactForModel(modelId, inner);
    if (!verify.ok) continue;
    // Newest by mtime — prefer the most recently trained compatible artifact.
    const mtime = fileMtime(path);
    if (!best || mtime > best.mtime) {
      best = { artifact: inner, path, mtime };
    }
  }
  return best ? { artifact: best.artifact, path: best.path } : null;
}

function fileMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Score all enabled shadow challengers for a frozen prediction.
 *
 * @param {object} prediction - the control prediction (has coreInputs, runId, etc.)
 * @param {object} options - { artifactsDir, now } for testability
 * @returns {Array<{modelId, entry, reason}>} - one per challenger; entry is a
 *   recordModelPrediction payload or null with a reason string.
 */
export function scoreShadowChallengers(prediction, options = {}) {
  const { shadowMode, artifactsDir: configuredDir } = readModelRegistryConfig();
  const artifactsDir = options.artifactsDir || configuredDir;

  const results = [];
  if (!shadowMode) {
    return results;
  }

  const coreInputs = prediction.coreInputs || null;
  if (!coreInputs) {
    return CHALLENGER_MODEL_IDS.map((modelId) => ({
      modelId,
      entry: null,
      reason: 'no_frozen_core_inputs'
    }));
  }

  // Build the frozen flattened feature vector ONCE from the same frozen inputs.
  let flatVector = null;
  try {
    flatVector = flattenFeatureVector(buildFeatureVector(coreInputs));
  } catch (e) {
    return CHALLENGER_MODEL_IDS.map((modelId) => ({
      modelId,
      entry: null,
      reason: `feature_vector_build_failed: ${e?.message || e}`
    }));
  }

  // --- learned_v2_logistic ---
  results.push(scoreLearnedV2Shadow(prediction, flatVector, artifactsDir));

  // --- market_residual_v2 ---
  results.push(scoreMarketResidualV2Shadow(prediction, flatVector, artifactsDir));

  return results;
}

const CHALLENGER_MODEL_IDS = [LEARNED_V2_LOGISTIC_MODEL_ID, MARKET_RESIDUAL_V2_MODEL_ID];

/**
 * Score the learned_v2_logistic challenger. Returns a result record
 * { modelId, entry, reason }.
 */
function scoreLearnedV2Shadow(prediction, flatVector, artifactsDir) {
  const loaded = loadChallengerArtifact(LEARNED_V2_LOGISTIC_MODEL_ID, artifactsDir);
  if (!loaded) {
    return { modelId: LEARNED_V2_LOGISTIC_MODEL_ID, entry: null, reason: 'no_compatible_artifact' };
  }
  const scored = scoreLearnedV2Logistic(loaded.artifact, flatVector);
  if (!scored.available) {
    return {
      modelId: LEARNED_V2_LOGISTIC_MODEL_ID,
      entry: null,
      reason: `unavailable: ${scored.reasons.join(';')}`
    };
  }
  return {
    modelId: LEARNED_V2_LOGISTIC_MODEL_ID,
    entry: buildLearnedV2Entry(prediction, loaded.artifact, scored),
    reason: null
  };
}

/**
 * Score the market_residual_v2 challenger. Requires a complete same-book no-vig
 * market pair available to this run; missing/stale/unpaired market produces no
 * residual prediction (unavailable), never a default probability.
 */
function scoreMarketResidualV2Shadow(prediction, flatVector, artifactsDir) {
  const loaded = loadChallengerArtifact(MARKET_RESIDUAL_V2_MODEL_ID, artifactsDir);
  if (!loaded) {
    return { modelId: MARKET_RESIDUAL_V2_MODEL_ID, entry: null, reason: 'no_compatible_artifact' };
  }
  // Resolve the same-book no-vig home probability from the run's frozen odds.
  const marketNoVigHome = resolveSameBookNoVigHomeProb(prediction);
  if (marketNoVigHome == null) {
    return {
      modelId: MARKET_RESIDUAL_V2_MODEL_ID,
      entry: null,
      reason: 'no_same_book_market_pair'
    };
  }
  const scored = scoreMarketResidualV2(loaded.artifact, flatVector, marketNoVigHome);
  if (!scored.available) {
    return {
      modelId: MARKET_RESIDUAL_V2_MODEL_ID,
      entry: null,
      reason: `unavailable: ${scored.reasons.join(';')}`
    };
  }
  return {
    modelId: MARKET_RESIDUAL_V2_MODEL_ID,
    entry: buildMarketResidualV2Entry(prediction, loaded.artifact, scored),
    reason: null
  };
}

/**
 * Resolve the same-book no-vig home probability for a prediction. Uses the
 * frozen currentOdds (home/away moneyline + book provenance). Returns null when
 * the pair is not same-book or odds are missing — the residual model then makes
 * no prediction (correct, not a default).
 *
 * noVigMarketProbabilities returns 0-100 scale; convert to 0-1.
 */
function resolveSameBookNoVigHomeProb(prediction) {
  const odds = prediction.currentOdds || prediction.openingOdds || null;
  if (!odds) return null;
  if (!moneylineBooksAreSameLocal(odds)) return null;
  const noVig = noVigMarketProbabilities({
    homeMoneyline: odds.homeMoneyline,
    awayMoneyline: odds.awayMoneyline
  });
  if (!noVig || noVig.home == null) return null;
  return Number(noVig.home) / 100;
}

// Local same-book check mirroring mlb.js moneylineBooksAreSame (kept here to
// avoid importing __mlbTestInternals into the production registry).
function moneylineBooksAreSameLocal(currentOdds) {
  if (!currentOdds) return false;
  const homeSide = currentOdds.homeMoneylineBook || null;
  const awaySide = currentOdds.awayMoneylineBook || null;
  if (homeSide && awaySide) {
    return String(homeSide).toLowerCase() === String(awaySide).toLowerCase();
  }
  if (homeSide || awaySide) {
    const generic = currentOdds.moneylineBook || null;
    if (!generic) return false;
    const known = homeSide || awaySide;
    return String(known).toLowerCase() === String(generic).toLowerCase();
  }
  return Boolean(currentOdds.moneylineBook);
}

/**
 * Build a recordModelPrediction entry for the market_residual_v2 challenger.
 * Carries the residual stages separately: marketNoVig, marketLogit,
 * residualLogit, residualAdjusted.
 */
function buildMarketResidualV2Entry(prediction, artifact, scored) {
  const homeProb = scored.homeProbability;
  const awayProb = scored.awayProbability;
  const pickSide = homeProb >= awayProb ? 'home' : 'away';
  const pickTeamId =
    pickSide === 'home'
      ? String(prediction.home?.id ?? '')
      : String(prediction.away?.id ?? '');
  return {
    runId: prediction.runId,
    gamePk: prediction.gamePk,
    dateYmd: prediction.dateYmd || null,
    modelId: MARKET_RESIDUAL_V2_MODEL_ID,
    modelImplVersion: MARKET_RESIDUAL_V2_IMPL_VERSION,
    featureSchemaVersion: MARKET_RESIDUAL_V2_FEATURE_SCHEMA_VERSION,
    modelArtifactHash: artifact.artifact_hash || null,
    calibrationArtifactHash: null,
    calibrationStatus: 'identity',
    rawHomeProbability: homeProb,
    rawAwayProbability: awayProb,
    calibratedHomeProbability: null,
    calibratedAwayProbability: null,
    finalHomeProbability: homeProb,
    finalAwayProbability: awayProb,
    residualLogit: scored.residualLogit,
    displayHomeProbability: null, // never overwrites control display
    displayAwayProbability: null,
    pickSide,
    pickTeamId,
    pickProbability: pickSide === 'home' ? homeProb : awayProb,
    status: 'SHADOW',
    reasonCodes: JSON.stringify({ source: 'market_residual_v2_shadow' }),
    pairedQuotePairId: null,
    marketNoVigHomeProb: scored.marketNoVigProbability,
    marketNoVigAwayProb: scored.marketNoVigProbability != null ? 1 - scored.marketNoVigProbability : null,
    asOfUtc: prediction.asOfUtc || null,
    firstPitchUtc: prediction.startTime || null,
    informationState: prediction.informationState || null,
    promotionEligible: false, // shadow rows are never promotion-eligible
    promotionReasons: JSON.stringify({ shadow: true, model: MARKET_RESIDUAL_V2_MODEL_ID }),
    modelVersion: `market-residual-v2-${(artifact.artifact_hash || '').slice(0, 12)}`,
    featureVersion: prediction.featureVersion || null,
    calibrationVersion: 'identity',
    snapshotHash: prediction.snapshotHash || null,
    payload: {
      marketLogit: scored.marketLogit,
      residualLogit: scored.residualLogit,
      marketNoVigHomeProb: scored.marketNoVigProbability,
      marketOffsetCoefficient: 1.0
    }
  };
}

/**
 * Build a recordModelPrediction entry for the learned_v2_logistic challenger.
 * Mirrors the control row's provenance but carries challenger probabilities.
 * pick_side/eligible mirror control so the dataset builder can join them.
 */
function buildLearnedV2Entry(prediction, artifact, scored) {
  const homeProb = scored.homeProbability;
  const awayProb = scored.awayProbability;
  const pickSide = homeProb >= awayProb ? 'home' : 'away';
  const pickTeamId =
    pickSide === 'home'
      ? String(prediction.home?.id ?? '')
      : String(prediction.away?.id ?? '');
  return {
    runId: prediction.runId,
    gamePk: prediction.gamePk,
    dateYmd: prediction.dateYmd || null,
    modelId: LEARNED_V2_LOGISTIC_MODEL_ID,
    modelImplVersion: LEARNED_V2_LOGISTIC_IMPL_VERSION,
    featureSchemaVersion: LEARNED_V2_LOGISTIC_FEATURE_SCHEMA_VERSION,
    modelArtifactHash: artifact.artifact_hash || null,
    calibrationArtifactHash: null,
    calibrationStatus: 'identity', // challenger uses no calibration map in P2
    rawHomeProbability: homeProb,
    rawAwayProbability: awayProb,
    calibratedHomeProbability: null, // P6 applies OOF calibration; P2 is identity
    calibratedAwayProbability: null,
    finalHomeProbability: homeProb,
    finalAwayProbability: awayProb,
    residualLogit: null,
    displayHomeProbability: null, // never overwrite control display
    displayAwayProbability: null,
    pickSide,
    pickTeamId,
    pickProbability: pickSide === 'home' ? homeProb : awayProb,
    status: 'SHADOW',
    reasonCodes: JSON.stringify({ source: 'learned_v2_logistic_shadow' }),
    pairedQuotePairId: null,
    marketNoVigHomeProb: null,
    marketNoVigAwayProb: null,
    asOfUtc: prediction.asOfUtc || null,
    firstPitchUtc: prediction.startTime || null,
    informationState: prediction.informationState || null,
    promotionEligible: false, // shadow rows are never promotion-eligible
    promotionReasons: JSON.stringify({ shadow: true, model: LEARNED_V2_LOGISTIC_MODEL_ID }),
    modelVersion: `learned-v2-${(artifact.artifact_hash || '').slice(0, 12)}`,
    featureVersion: prediction.featureVersion || null,
    calibrationVersion: 'identity',
    snapshotHash: prediction.snapshotHash || null,
    payload: {
      logit: scored.logit,
      artifactPath: null
    }
  };
}
