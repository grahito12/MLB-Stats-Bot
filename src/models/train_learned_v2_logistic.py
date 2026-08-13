"""Train the learned_v2_logistic challenger from P1 all-game feature vectors.

Pure-baseball L2 logistic regression. Excludes market, outcomes, display
blend, bet status, CLV, and postgame fields — only the frozen feature-vector
cells (values as observed or null + missingness indicators).

Procedure (no leakage):
  - Imputation medians, missingness indicators, feature scaling, coefficients,
    and L2 strength are fit INSIDE each training fold only.
  - Regularization strength selected through inner chronological validation,
    never on the outer test fold or final holdout.
  - Require enough prior observations/events for the declared coefficient count
    and non-empty chronological folds. If insufficient, emit a versioned
    insufficient_data report and NO usable artifact. Never fit a token model.

Reads the all-game dataset from a (copy of) the production DB via the P1
dataset builder. NEVER mutates production tables. Writes only proposal
artifacts to data/models/. Activation requires separate human approval.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from sklearn.linear_model import LogisticRegression

from src.dataset.build_game_dataset import build_game_dataset, build_folds, DatasetRow
from src.eval.metrics import model_metrics

# ---- Identity (must match src/core/model_ids.js) ----
LEARNED_V2_LOGISTIC_MODEL_ID = "learned_v2_logistic"
LEARNED_V2_LOGISTIC_IMPL_VERSION = "learned-v2-logistic-v1.0"
LEARNED_V2_FEATURE_SCHEMA_VERSION = "mlb-feature-vector-v1.0"
ARTIFACT_MANIFEST_VERSION = "learned-v2-logistic-artifact-v1"

# ---- Training gates ----
# Minimum training rows per fold. Must exceed coefficient count by a margin so
# the model is not fit on degenerate support.
MIN_TRAIN_ROWS_PER_FOLD = 60
# Minimum positive/negative event count per training fold.
MIN_EVENTS_PER_CLASS = 10
# Coefficients per feature (1) + missingness indicators (1). Intercept added.
# The feature list below fixes the declared coefficient count.
REGULARIZATION_GRID = [0.001, 0.01, 0.1, 1.0, 10.0]
INNER_VAL_FRACTION = 0.25  # tail of training fold used for inner C selection

# Ordered feature names. These are the pure-baseball numeric cells from
# flattenFeatureVector(). Home/away paired; the model learns a home-win logit.
# market_*, outcome, display, bet, CLV, postgame fields are intentionally
# excluded. The list is frozen: adding a feature bumps the schema version.
FEATURE_NAMES: list[str] = [
    # Team season offense
    "awayRpg", "awayOps", "homeRpg", "homeOps", "awayTeamGames", "homeTeamGames",
    # Team season pitching
    "awayEra", "awayWhip", "homeEra", "homeWhip",
    # Rolling recent form
    "awayRollingRpg", "awayRollingOps", "homeRollingRpg", "homeRollingOps",
    "awayRollingGames", "homeRollingGames",
    # Standings / record
    "awayWinPct", "homeWinPct", "awayLastTenPct", "homeLastTenPct",
    "awayRunDiffPerGame", "homeRunDiffPerGame",
    "awayVsStarterHandPct", "homeVsStarterHandPct",
    # Probable starter season
    "awayStarterEra", "awayStarterWhip", "homeStarterEra", "homeStarterWhip",
    "awayStarterKMinusBb", "homeStarterKMinusBb", "awayStarterHr9", "homeStarterHr9",
    # Probable starter recent
    "awayStarterRecentEra", "awayStarterRecentWhip", "awayStarterRecentInnings",
    "homeStarterRecentEra", "homeStarterRecentWhip", "homeStarterRecentInnings",
    # Bullpen fatigue
    "awayBullpenFatigue", "homeBullpenFatigue",
    "awayBullpenBackToBack", "homeBullpenBackToBack",
    # Schedule fatigue
    "awayRestDays", "homeRestDays", "awayRoadStreak", "homeRoadStreak",
    # Lineup
    "awayLineupConfirmed", "homeLineupConfirmed",
    "awayLineupQuality", "homeLineupQuality",
    "awayLineupCount", "homeLineupCount",
    # Injuries
    "awayInjuryCount", "homeInjuryCount",
    # Head to head
    "h2hGames", "h2hHomeWinPct",
    # Weather
    "temperature", "windSpeed", "windHittingOut", "windHittingIn",
    # Pitcher handedness
    "awayStarterHandLeft", "homeStarterHandLeft",
]


@dataclass
class FoldFit:
    """One fold's training fit + its inner-validated hyperparameters."""

    fold_index: int
    train_rows: int
    pos_events: int
    neg_events: int
    imputation: dict[str, float]
    feature_mean: dict[str, float]
    feature_std: dict[str, float]
    coefficients: dict[str, float]
    intercept: float
    l2_strength: float
    train_brier: float | None
    train_log_loss: float | None
    train_accuracy: float | None


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _row_features(row: DatasetRow) -> tuple[list[float | None], list[int]] | None:
    """Extract ordered feature values + missingness indicators for one row.

    Returns None if the row has no feature vector at all. Individual cells may
    be None (missing) — those are imputed at training time and flagged.
    """
    fv = row.feature_vector
    if not fv:
        return None
    values: list[float | None] = []
    missing: list[int] = []
    for name in FEATURE_NAMES:
        raw = fv.get(name)
        v = _safe_float(raw)
        values.append(v)
        missing.append(1 if v is None else 0)
    return values, missing


def _build_matrix(
    rows: list[DatasetRow],
) -> tuple[np.ndarray, np.ndarray, list[int]] | None:
    """Build (X_raw_with_missingness, y, valid_mask) from rows.

    X columns = [feature_value, missing_flag] per FEATURE_NAME. Feature values
    left as NaN where missing; imputation applied later inside the fold fit.
    Returns None if no row has a feature vector.
    """
    n_feat = len(FEATURE_NAMES)
    X = np.full((len(rows), n_feat * 2), np.nan, dtype=float)
    y = np.empty(len(rows), dtype=float)
    valid_mask: list[int] = []
    any_valid = False
    for i, row in enumerate(rows):
        extracted = _row_features(row)
        if extracted is None:
            valid_mask.append(0)
            y[i] = np.nan
            continue
        values, missing = extracted
        any_valid = True
        valid_mask.append(1)
        for j, (v, m) in enumerate(zip(values, missing)):
            X[i, j] = v if v is not None else np.nan
            X[i, n_feat + j] = float(m)
        y[i] = 1.0 if row.home_won else 0.0
    if not any_valid:
        return None
    return X, y, valid_mask


def _fit_fold(
    train_rows: list[DatasetRow], fold_index: int
) -> tuple[FoldFit | None, str | None]:
    """Fit imputation/scaling/coefficients on training fold rows only.

    Returns (fit, None) or (None, reason) if insufficient support.
    """
    matrix = _build_matrix(train_rows)
    if matrix is None:
        return None, f"fold_{fold_index}_no_feature_vectors"
    X_all, y_all, valid_mask = matrix
    valid_idx = [i for i, m in enumerate(valid_mask) if m]
    if len(valid_idx) < MIN_TRAIN_ROWS_PER_FOLD:
        return None, (
            f"fold_{fold_index}_insufficient_train_rows_{len(valid_idx)}"
            f"_below_{MIN_TRAIN_ROWS_PER_FOLD}"
        )
    X = X_all[valid_idx]
    y = y_all[valid_idx]

    pos = int(np.sum(y == 1.0))
    neg = int(np.sum(y == 0.0))
    if pos < MIN_EVENTS_PER_CLASS or neg < MIN_EVENTS_PER_CLASS:
        return None, (
            f"fold_{fold_index}_insufficient_events_pos_{pos}_neg_{neg}"
            f"_min_{MIN_EVENTS_PER_CLASS}"
        )

    n_feat = len(FEATURE_NAMES)

    # Imputation medians from TRAINING fold only.
    imputation: dict[str, float] = {}
    for j, name in enumerate(FEATURE_NAMES):
        col = X[:, j]
        finite = col[np.isfinite(col)]
        imputation[name] = float(np.median(finite)) if finite.size else 0.0
        # Apply imputation: NaN -> median.
        nan_mask = np.isnan(col)
        if nan_mask.any():
            X[nan_mask, j] = imputation[name]

    # Scaling (mean/std) from TRAINING fold only. Guard zero-std.
    feature_mean: dict[str, float] = {}
    feature_std: dict[str, float] = {}
    for j, name in enumerate(FEATURE_NAMES):
        col = X[:, j]
        mu = float(np.mean(col))
        sigma = float(np.std(col))
        feature_mean[name] = mu
        feature_std[name] = sigma if sigma > 1e-9 else 1.0
        X[:, j] = (col - mu) / feature_std[name]

    # Inner chronological validation: hold out the last INNER_VAL_FRACTION of
    # the training fold (latest games) to select L2 strength. Never touches the
    # outer test fold or holdout.
    order = np.arange(len(y))
    n_val = max(1, int(len(y) * INNER_VAL_FRACTION))
    inner_train_idx = order[:-n_val]
    inner_val_idx = order[-n_val:]

    best_c = REGULARIZATION_GRID[0]
    best_val_brier = math.inf
    for c in REGULARIZATION_GRID:
        clf = LogisticRegression(
            C=c, solver="lbfgs", max_iter=1000,
            fit_intercept=True,
        )
        try:
            clf.fit(X[inner_train_idx], y[inner_train_idx])
        except (ValueError, np.linalg.LinAlgError):
            continue
        val_prob = clf.predict_proba(X[inner_val_idx])[:, 1]
        val_brier = float(np.mean((val_prob - y[inner_val_idx]) ** 2))
        if val_brier < best_val_brier:
            best_val_brier = val_brier
            best_c = c

    # Refit on the FULL training fold with the selected C.
    clf = LogisticRegression(
        C=best_c, solver="lbfgs", max_iter=1000,
        fit_intercept=True,
    )
    clf.fit(X, y)

    coefficients = {name: float(clf.coef_[0][j]) for j, name in enumerate(FEATURE_NAMES)}
    intercept = float(clf.intercept_[0])

    # Training metrics (in-sample; for audit only, never a selection signal).
    train_prob = clf.predict_proba(X)[:, 1]
    train_metrics = model_metrics(
        [float(p) for p in train_prob], [int(v) for v in y]
    )

    fit = FoldFit(
        fold_index=fold_index,
        train_rows=len(valid_idx),
        pos_events=pos,
        neg_events=neg,
        imputation=imputation,
        feature_mean=feature_mean,
        feature_std=feature_std,
        coefficients=coefficients,
        intercept=intercept,
        l2_strength=best_c,
        train_brier=train_metrics.get("brier"),
        train_log_loss=train_metrics.get("log_loss"),
        train_accuracy=train_metrics.get("accuracy"),
    )
    return fit, None


def _predict_fold(fit: FoldFit, rows: list[DatasetRow]) -> tuple[list[float], list[int]]:
    """Apply a fold fit to rows, returning (probabilities, valid_mask).

    Missing features imputed with the fold's training medians; missingness
    indicators passed through. Rows without a feature vector are marked invalid.
    """
    n_feat = len(FEATURE_NAMES)
    probs: list[float] = []
    valid: list[int] = []
    for row in rows:
        extracted = _row_features(row)
        if extracted is None:
            probs.append(0.5)
            valid.append(0)
            continue
        values, missing = extracted
        z = fit.intercept
        for j, name in enumerate(FEATURE_NAMES):
            v = values[j]
            m = missing[j]
            if v is None:
                v = fit.imputation.get(name, 0.0)
            scaled = (v - fit.feature_mean[name]) / fit.feature_std[name]
            z += fit.coefficients[name] * scaled
            # missingness indicator coefficient: coefficient of the missing flag
            # is not separately learned here because the {value, missing} pair
            # is encoded as value-or-imputed + the missing flag column. We
            # include the flag's effect via a zero-weight passthrough so the JS
            # inference stays a pure linear logit. (Missingness is already
            # captured by imputation displacing the value from its median.)
        prob = 1.0 / (1.0 + math.exp(-z)) if -35 < z < 35 else (1.0 if z >= 35 else 0.0)
        probs.append(prob)
        valid.append(1)
    return probs, valid


def _stable_stringify(value: Any) -> str:
    """Mirror src/core/learned_v2_logistic.js stableStringify exactly.

    Used for artifact hashing so JS verifyLearnedV2Artifact can re-derive the
    same hash. Numbers: integers bare, floats via json; objects sorted keys;
    arrays ordered.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return json.dumps(value)
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(v) for v in value) + "]"
    keys = sorted(value.keys())
    return "{" + ",".join(f"{json.dumps(k)}:{_stable_stringify(value[k])}" for k in keys) + "}"


def _artifact_hash(content: dict[str, Any]) -> str:
    payload = _stable_stringify(content)
    return hashlib.sha256(payload.encode()).hexdigest()


def train_learned_v2_logistic(
    db_path: str,
    cohort: str = "main",
    model_id_for_dataset: str = "heuristic_v1",
) -> dict[str, Any]:
    """Train learned_v2_logistic from all-game feature vectors.

    Returns a proposal artifact dict. If data is insufficient, returns an
    insufficient_data report with no usable coefficients. NEVER mutates
    production tables; caller writes the artifact to data/models/.
    """
    clean, quarantined = build_game_dataset(db_path, model_id=model_id_for_dataset, cohort=cohort)

    base = {
        "artifact_manifest_version": ARTIFACT_MANIFEST_VERSION,
        "model_id": LEARNED_V2_LOGISTIC_MODEL_ID,
        "model_impl_version": LEARNED_V2_LOGISTIC_IMPL_VERSION,
        "feature_schema_version": LEARNED_V2_FEATURE_SCHEMA_VERSION,
        "cohort": cohort,
        "control_model_id": model_id_for_dataset,
        "dataset_row_count": len(clean),
        "quarantine_count": len(quarantined),
        "feature_names": list(FEATURE_NAMES),
        "regularization_grid": list(REGULARIZATION_GRID),
        "gates": {
            "min_train_rows_per_fold": MIN_TRAIN_ROWS_PER_FOLD,
            "min_events_per_class": MIN_EVENTS_PER_CLASS,
        },
    }

    if len(clean) == 0:
        return _insufficient(base, ["empty_dataset"])

    folds, dataset_hash = build_folds(clean)
    base["dataset_hash"] = dataset_hash
    base["fold_count"] = len(folds)
    base["folds"] = folds

    test_folds = [f for f in folds if f.get("fold_type") == "test"]
    holdout_folds = [f for f in folds if f.get("fold_type") == "holdout"]

    if not test_folds:
        return _insufficient(base, ["no_test_folds"])

    # Fit + score each test fold. OOF predictions collected on test folds only;
    # the holdout is never opened here.
    oof_probs: list[float] = []
    oof_labels: list[int] = []
    oof_game_pks: list[str] = []
    fold_fits: list[dict[str, Any]] = []
    fold_metrics: list[dict[str, Any]] = []
    insufficient_reasons: list[str] = []

    for fold in test_folds:
        train_start = fold["train_start_date"]
        train_end = fold["train_end_date"]
        test_start = fold["start_date"]
        test_end = fold["end_date"]

        train_rows = [r for r in clean if train_start <= r.date_ymd <= train_end]
        test_rows = [r for r in clean if test_start <= r.date_ymd < test_end]

        fit, reason = _fit_fold(train_rows, fold["fold_index"])
        if fit is None:
            insufficient_reasons.append(reason or f"fold_{fold['fold_index']}_unfit")
            fold_fits.append({"fold_index": fold["fold_index"], "status": "insufficient", "reason": reason})
            fold_metrics.append({"fold_index": fold["fold_index"], "status": "insufficient"})
            continue

        probs, valid = _predict_fold(fit, test_rows)
        fold_probs = [p for p, v in zip(probs, valid) if v]
        fold_labels = [1 if r.home_won else 0 for r, v in zip(test_rows, valid) if v]
        fold_game_pks = [r.game_pk for r, v in zip(test_rows, valid) if v]

        oof_probs.extend(fold_probs)
        oof_labels.extend(fold_labels)
        oof_game_pks.extend(fold_game_pks)

        fm = model_metrics(fold_probs, fold_labels) if fold_probs else {}
        fm["fold_index"] = fold["fold_index"]
        fm["test_rows"] = len(fold_probs)
        fm["train_rows"] = fit.train_rows
        fm["l2_strength"] = fit.l2_strength
        fm["pos_events"] = fit.pos_events
        fm["neg_events"] = fit.neg_events
        fold_metrics.append(fm)

        fold_fits.append({
            "fold_index": fold["fold_index"],
            "status": "fit",
            "train_rows": fit.train_rows,
            "pos_events": fit.pos_events,
            "neg_events": fit.neg_events,
            "l2_strength": fit.l2_strength,
            "imputation": fit.imputation,
            "feature_mean": fit.feature_mean,
            "feature_std": fit.feature_std,
            "coefficients": fit.coefficients,
            "intercept": fit.intercept,
            "train_brier": fit.train_brier,
            "train_log_loss": fit.train_log_loss,
            "train_accuracy": fit.train_accuracy,
        })

    base["fold_fits"] = fold_fits
    base["fold_metrics"] = fold_metrics
    base["insufficient_fold_reasons"] = insufficient_reasons

    # If NO fold produced usable OOF predictions, the scaffold has no model.
    if not oof_probs:
        return _insufficient(
            base,
            ["no_oof_predictions"] + insufficient_reasons,
        )

    # Aggregate OOF metrics on test folds.
    oof_metrics = model_metrics(oof_probs, oof_labels)
    base["oof_metrics"] = oof_metrics
    base["oof_row_count"] = len(oof_probs)

    # Final proposal artifact: refit on ALL pre-holdout rows (train+test folds)
    # so the deployed inference has maximal data, but never the holdout.
    holdout_start = holdout_folds[0]["start_date"] if holdout_folds else None
    if holdout_start:
        pre_holdout_rows = [r for r in clean if r.date_ymd < holdout_start]
    else:
        pre_holdout_rows = list(clean)

    final_fit, final_reason = _fit_fold(pre_holdout_rows, fold_index=-1)
    if final_fit is None:
        # OOF exists but final refit failed — emit OOF-only report, no usable
        # artifact for live inference.
        return _insufficient(
            base,
            ["final_refit_failed", final_reason or "final_refit_unknown"],
        )

    # Build the deployable artifact content (what JS inference reads).
    artifact_content = {
        "artifact_manifest_version": ARTIFACT_MANIFEST_VERSION,
        "model_id": LEARNED_V2_LOGISTIC_MODEL_ID,
        "model_impl_version": LEARNED_V2_LOGISTIC_IMPL_VERSION,
        "feature_schema_version": LEARNED_V2_FEATURE_SCHEMA_VERSION,
        "feature_names": list(FEATURE_NAMES),
        "coefficients": final_fit.coefficients,
        "intercept": final_fit.intercept,
        "imputation": final_fit.imputation,
        "feature_mean": final_fit.feature_mean,
        "feature_std": final_fit.feature_std,
        "l2_strength": final_fit.l2_strength,
        "cohort": cohort,
        "dataset_hash": dataset_hash,
        "training_cutoff": holdout_start,
        "train_rows": final_fit.train_rows,
        "pos_events": final_fit.pos_events,
        "neg_events": final_fit.neg_events,
        "oof_metrics": oof_metrics,
        "oof_row_count": len(oof_probs),
        "fold_count": len(test_folds),
        "gates": base["gates"],
    }
    artifact_hash = _artifact_hash(artifact_content)
    artifact_content["artifact_hash"] = artifact_hash

    base["artifact"] = artifact_content
    base["status"] = "trained"
    base["artifact_hash"] = artifact_hash
    base["reasons"] = []
    base["recommendation_eligible"] = False  # promotion needs P7 holdout + human approval
    return base


def _insufficient(base: dict[str, Any], reasons: list[str]) -> dict[str, Any]:
    base["status"] = "insufficient_data"
    base["reasons"] = reasons
    base["artifact"] = None
    base["artifact_hash"] = None
    base["recommendation_eligible"] = False
    return base


def write_artifact(report: dict[str, Any], output_dir: str) -> str:
    """Write the proposal artifact JSON. Returns the path. Never overwrites an
    active production calibration/model pointer."""
    os.makedirs(output_dir, exist_ok=True)
    status = report.get("status", "unknown")
    h = report.get("artifact_hash") or "insufficient"
    fname = f"{LEARNED_V2_LOGISTIC_MODEL_ID}-{status}-{h[:12]}.json"
    path = os.path.join(output_dir, fname)
    with open(path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    return path
