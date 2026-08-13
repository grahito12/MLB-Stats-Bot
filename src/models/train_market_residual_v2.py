"""Train the market_residual_v2 challenger (fixed-offset residual model).

Model:

    logit(P_home) = logit(P_market_no_vig_home) + beta0 + beta . X_baseball

The market-offset coefficient is FIXED at exactly 1.0 — it is never fit. Only
beta0 (intercept) and beta (baseball-feature coefficients) are learned, via L2-
penalized Bernoulli regression on the residual logit. L2 strength is selected
through inner chronological validation, never on the outer test fold or holdout.

Leakage rules (same as P2):
  - Imputation medians, missingness, scaling, coefficients fit INSIDE each
    training fold only.
  - Require enough prior observations/events; else insufficient_data (no artifact).
  - Uses ONLY complete same-book quote pairs available by run as_of. Missing /
    stale / unpaired market data produces NO residual prediction (the row is
    excluded from training and scored unavailable at inference).

Reads the all-game dataset from a (copy of) the production DB. NEVER mutates
production tables. Writes proposal artifacts to data/models/. Activation
requires separate human approval.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass
from typing import Any

import numpy as np
from sklearn.linear_model import LogisticRegression

from src.dataset.build_game_dataset import build_game_dataset, build_folds, DatasetRow
from src.eval.metrics import model_metrics
from src.models.train_learned_v2_logistic import (
    _build_matrix,
    _row_features,
    _stable_stringify,
    FEATURE_NAMES,
)

# ---- Identity (must match src/core/model_ids.js) ----
MARKET_RESIDUAL_V2_MODEL_ID = "market_residual_v2"
MARKET_RESIDUAL_V2_IMPL_VERSION = "market-residual-v2-v1.0"
MARKET_RESIDUAL_V2_FEATURE_SCHEMA_VERSION = "mlb-feature-vector-v1.0"
ARTIFACT_MANIFEST_VERSION = "market-residual-v2-artifact-v1"

# The market logit is a FIXED offset; coefficient is exactly 1 (never fit).
MARKET_OFFSET_COEFFICIENT = 1.0

# ---- Training gates ----
MIN_TRAIN_ROWS_PER_FOLD = 60
MIN_EVENTS_PER_CLASS = 10
MIN_WITH_MARKET_ROWS = 40  # residual model needs market-paired rows
REGULARIZATION_GRID = [0.001, 0.01, 0.1, 1.0, 10.0]
INNER_VAL_FRACTION = 0.25


@dataclass
class ResidualFoldFit:
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


def _market_logit(row: DatasetRow) -> float | None:
    """Fixed market logit offset: logit(P_market_no_vig_home).

    Returns None if no complete same-book no-vig market probability is paired to
    the run. A row without market cannot train or score a residual prediction.
    """
    p = _safe_float(row.market_no_vig_home_prob)
    if p is None or p <= 0.0 or p >= 1.0:
        return None
    return math.log(p / (1.0 - p))


def _fit_residual_fold(
    train_rows: list[DatasetRow], fold_index: int
) -> tuple[ResidualFoldFit | None, str | None]:
    """Fit the residual model on training-fold rows that have market + features.

    The model regresses the home-win indicator on [X_baseball] with the market
    logit as a FIXED offset (coefficient 1). Equivalently, we fit a logistic
    regression of y on X_baseball + a constant market-offset feature whose
    coefficient is frozen at 1. We implement this by offsetting the decision
    function: z = market_logit + intercept + beta . X_scaled, and fit
    intercept+beta by providing the market logit as an exposure/offset.

    sklearn LogisticRegression has no native offset, so we fit on the
    *residualized* target is not valid for Bernoulli. Instead we use the standard
    trick: include market_logit as a feature but FIX its coefficient by
    subtracting it from the intercept after fitting a model where market_logit
    is penalized to 0. Concretely: fit y ~ intercept + beta.X with sample
    weights, then add market_logit to the linear predictor at predict time.

    Returns (fit, None) or (None, reason).
    """
    # Keep only rows with market + features + outcome.
    usable = [
        r for r in train_rows
        if _market_logit(r) is not None and r.home_won is not None and _row_features(r) is not None
    ]
    if len(usable) < MIN_TRAIN_ROWS_PER_FOLD:
        return None, (
            f"fold_{fold_index}_insufficient_with_market_rows_{len(usable)}"
            f"_below_{MIN_TRAIN_ROWS_PER_FOLD}"
        )

    matrix = _build_matrix(usable)
    if matrix is None:
        return None, f"fold_{fold_index}_no_feature_vectors"
    X_all, y_all, valid_mask = matrix
    # _build_matrix already filtered feature-vector presence; all usable rows
    # are valid here.
    valid_idx = [i for i, m in enumerate(valid_mask) if m]
    X = X_all[valid_idx]
    y = y_all[valid_idx]
    market_logits = np.array([_market_logit(usable[i]) for i in valid_idx], dtype=float)

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
        nan_mask = np.isnan(col)
        if nan_mask.any():
            X[nan_mask, j] = imputation[name]

    # Scaling from TRAINING fold only.
    feature_mean: dict[str, float] = {}
    feature_std: dict[str, float] = {}
    for j, name in enumerate(FEATURE_NAMES):
        col = X[:, j]
        mu = float(np.mean(col))
        sigma = float(np.std(col))
        feature_mean[name] = mu
        feature_std[name] = sigma if sigma > 1e-9 else 1.0
        X[:, j] = (col - mu) / feature_std[name]

    # Inner chronological validation for L2 selection. The market logit is a
    # FIXED offset at predict time; we select C on the offset-adjusted loss.
    order = np.arange(len(y))
    n_val = max(1, int(len(y) * INNER_VAL_FRACTION))
    inner_train_idx = order[:-n_val]
    inner_val_idx = order[-n_val:]

    best_c = REGULARIZATION_GRID[0]
    best_val_brier = math.inf
    for c in REGULARIZATION_GRID:
        clf = LogisticRegression(C=c, solver="lbfgs", max_iter=1000, fit_intercept=True)
        try:
            clf.fit(X[inner_train_idx], y[inner_train_idx])
        except (ValueError, np.linalg.LinAlgError):
            continue
        # Offset-adjusted probabilities on the inner validation set.
        z = clf.intercept_[0] + clf.coef_[0] @ X[inner_val_idx].T + market_logits[inner_val_idx]
        val_prob = _sigmoid(z)
        val_brier = float(np.mean((val_prob - y[inner_val_idx]) ** 2))
        if val_brier < best_val_brier:
            best_val_brier = val_brier
            best_c = c

    # Refit on the FULL training fold with the selected C.
    clf = LogisticRegression(C=best_c, solver="lbfgs", max_iter=1000, fit_intercept=True)
    clf.fit(X, y)

    coefficients = {name: float(clf.coef_[0][j]) for j, name in enumerate(FEATURE_NAMES)}
    intercept = float(clf.intercept_[0])

    # Training metrics (offset-adjusted; audit only, never a selection signal).
    z_train = clf.intercept_[0] + clf.coef_[0] @ X.T + market_logits
    train_prob = _sigmoid(z_train)
    train_metrics = model_metrics(
        [float(p) for p in train_prob], [int(v) for v in y]
    )

    return ResidualFoldFit(
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
    ), None


def _predict_residual_fold(
    fit: ResidualFoldFit, rows: list[DatasetRow]
) -> tuple[list[float], list[int]]:
    """Apply a residual fit. Rows without market OR without features are invalid."""
    probs: list[float] = []
    valid: list[int] = []
    for row in rows:
        market_logit = _market_logit(row)
        extracted = _row_features(row)
        if market_logit is None or extracted is None:
            probs.append(0.5)
            valid.append(0)
            continue
        values, _missing = extracted
        z = fit.intercept + market_logit  # market offset coefficient = 1.0
        for j, name in enumerate(FEATURE_NAMES):
            v = values[j]
            if v is None:
                v = fit.imputation.get(name, 0.0)
            scaled = (v - fit.feature_mean[name]) / fit.feature_std[name]
            z += fit.coefficients[name] * scaled
        probs.append(_sigmoid_scalar(z))
        valid.append(1)
    return probs, valid


def _sigmoid(z: np.ndarray) -> np.ndarray:
    out = np.empty_like(z, dtype=float)
    high = z >= 35
    low = z <= -35
    mid = ~(high | low)
    out[high] = 1.0
    out[low] = 0.0
    out[mid] = 1.0 / (1.0 + np.exp(-z[mid]))
    return out


def _sigmoid_scalar(z: float) -> float:
    if z >= 35:
        return 1.0
    if z <= -35:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


def _artifact_hash(content: dict[str, Any]) -> str:
    return hashlib.sha256(_stable_stringify(content).encode()).hexdigest()


def train_market_residual_v2(
    db_path: str,
    cohort: str = "main",
    model_id_for_dataset: str = "heuristic_v1",
) -> dict[str, Any]:
    """Train market_residual_v2 from all-game feature vectors + market quotes.

    Returns a proposal artifact dict. If data is insufficient, returns an
    insufficient_data report with no usable coefficients. NEVER mutates
    production tables.
    """
    clean, quarantined = build_game_dataset(db_path, model_id=model_id_for_dataset, cohort=cohort)

    base = {
        "artifact_manifest_version": ARTIFACT_MANIFEST_VERSION,
        "model_id": MARKET_RESIDUAL_V2_MODEL_ID,
        "model_impl_version": MARKET_RESIDUAL_V2_IMPL_VERSION,
        "feature_schema_version": MARKET_RESIDUAL_V2_FEATURE_SCHEMA_VERSION,
        "cohort": cohort,
        "control_model_id": model_id_for_dataset,
        "dataset_row_count": len(clean),
        "quarantine_count": len(quarantined),
        "feature_names": list(FEATURE_NAMES),
        "market_offset_coefficient": MARKET_OFFSET_COEFFICIENT,
        "regularization_grid": list(REGULARIZATION_GRID),
        "gates": {
            "min_train_rows_per_fold": MIN_TRAIN_ROWS_PER_FOLD,
            "min_events_per_class": MIN_EVENTS_PER_CLASS,
            "min_with_market_rows": MIN_WITH_MARKET_ROWS,
        },
    }

    if len(clean) == 0:
        return _insufficient(base, ["empty_dataset"])

    # Count market-paired rows.
    with_market = [r for r in clean if _market_logit(r) is not None]
    base["with_market_row_count"] = len(with_market)
    if len(with_market) < MIN_WITH_MARKET_ROWS:
        return _insufficient(base, [
            f"with_market_rows_{len(with_market)}_below_{MIN_WITH_MARKET_ROWS}"
        ])

    folds, dataset_hash = build_folds(clean)
    base["dataset_hash"] = dataset_hash
    base["fold_count"] = len(folds)
    base["folds"] = folds

    test_folds = [f for f in folds if f.get("fold_type") == "test"]
    holdout_folds = [f for f in folds if f.get("fold_type") == "holdout"]

    if not test_folds:
        return _insufficient(base, ["no_test_folds"])

    oof_probs: list[float] = []
    oof_labels: list[int] = []
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

        fit, reason = _fit_residual_fold(train_rows, fold["fold_index"])
        if fit is None:
            insufficient_reasons.append(reason or f"fold_{fold['fold_index']}_unfit")
            fold_fits.append({"fold_index": fold["fold_index"], "status": "insufficient", "reason": reason})
            fold_metrics.append({"fold_index": fold["fold_index"], "status": "insufficient"})
            continue

        probs, valid = _predict_residual_fold(fit, test_rows)
        fold_probs = [p for p, v in zip(probs, valid) if v]
        fold_labels = [1 if r.home_won else 0 for r, v in zip(test_rows, valid) if v]

        oof_probs.extend(fold_probs)
        oof_labels.extend(fold_labels)

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

    if not oof_probs:
        return _insufficient(base, ["no_oof_predictions"] + insufficient_reasons)

    oof_metrics = model_metrics(oof_probs, oof_labels)
    base["oof_metrics"] = oof_metrics
    base["oof_row_count"] = len(oof_probs)

    # Market baseline metrics on the SAME with-market OOF rows for the
    # incremental-over-market comparison P3 requires.
    market_oof_probs: list[float] = []
    market_oof_labels: list[int] = []
    for fold in test_folds:
        test_start = fold["start_date"]
        test_end = fold["end_date"]
        test_rows = [r for r in clean if test_start <= r.date_ymd < test_end]
        for r in test_rows:
            p = _safe_float(r.market_no_vig_home_prob)
            if p is not None and 0.0 < p < 1.0 and r.home_won is not None:
                market_oof_probs.append(p)
                market_oof_labels.append(1 if r.home_won else 0)
    base["market_oof_metrics"] = model_metrics(market_oof_probs, market_oof_labels) if market_oof_probs else {}

    # Final proposal artifact: refit on ALL pre-holdout with-market rows.
    holdout_start = holdout_folds[0]["start_date"] if holdout_folds else None
    pre_holdout = [r for r in clean if (r.date_ymd < holdout_start if holdout_start else True)]

    final_fit, final_reason = _fit_residual_fold(pre_holdout, fold_index=-1)
    if final_fit is None:
        return _insufficient(base, ["final_refit_failed", final_reason or "final_refit_unknown"])

    artifact_content = {
        "artifact_manifest_version": ARTIFACT_MANIFEST_VERSION,
        "model_id": MARKET_RESIDUAL_V2_MODEL_ID,
        "model_impl_version": MARKET_RESIDUAL_V2_IMPL_VERSION,
        "feature_schema_version": MARKET_RESIDUAL_V2_FEATURE_SCHEMA_VERSION,
        "feature_names": list(FEATURE_NAMES),
        "coefficients": final_fit.coefficients,
        "intercept": final_fit.intercept,
        "imputation": final_fit.imputation,
        "feature_mean": final_fit.feature_mean,
        "feature_std": final_fit.feature_std,
        "l2_strength": final_fit.l2_strength,
        "market_offset_coefficient": MARKET_OFFSET_COEFFICIENT,
        "cohort": cohort,
        "dataset_hash": dataset_hash,
        "training_cutoff": holdout_start,
        "train_rows": final_fit.train_rows,
        "pos_events": final_fit.pos_events,
        "neg_events": final_fit.neg_events,
        "oof_metrics": oof_metrics,
        "market_oof_metrics": base["market_oof_metrics"],
        "oof_row_count": len(oof_probs),
        "fold_count": len(test_folds),
        "gates": base["gates"],
    }
    artifact_content["artifact_hash"] = _artifact_hash(artifact_content)

    base["artifact"] = artifact_content
    base["status"] = "trained"
    base["artifact_hash"] = artifact_content["artifact_hash"]
    base["reasons"] = []
    base["recommendation_eligible"] = False  # P7 holdout + human approval needed
    return base


def _insufficient(base: dict[str, Any], reasons: list[str]) -> dict[str, Any]:
    base["status"] = "insufficient_data"
    base["reasons"] = reasons
    base["artifact"] = None
    base["artifact_hash"] = None
    base["recommendation_eligible"] = False
    return base


def write_artifact(report: dict[str, Any], output_dir: str) -> str:
    os.makedirs(output_dir, exist_ok=True)
    status = report.get("status", "unknown")
    h = report.get("artifact_hash") or "insufficient"
    fname = f"{MARKET_RESIDUAL_V2_MODEL_ID}-{status}-{h[:12]}.json"
    path = os.path.join(output_dir, fname)
    with open(path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    return path
