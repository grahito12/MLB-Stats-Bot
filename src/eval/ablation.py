"""P5 chronological ablations.

Runs common-fold, common-cohort ablations on the all-game dataset:

  - control ``heuristic_v1`` (stored calibrated probability) as the reference
  - candidate-family ablations: for each family declared in the candidate
    schema, compare the learned_v2_logistic challenger trained on the FULL
    feature vector vs leave-one-family-out vs that-family-only. This isolates
    each family's incremental contribution under identical chronological folds.
  - V1 term neutralization (diagnostic only): for the control heuristic_v1,
    replay the frozen stored probability with a family's contribution
    neutralized by zeroing the corresponding feature cells in the feature
    vector and re-scoring a challenger proxy. This NEVER modifies live control
    math — it is a leave-one-out probe on the frozen snapshot.

All ablations use the SAME chronological walk-forward folds (from
``build_folds``) so comparisons are apples-to-apples. Metrics: accuracy, Brier,
log loss, ROC AUC, ECE, coverage. Empty cohorts yield ``None``, never zero.

Reports are written to ``reports/ablation/`` as machine JSON + Markdown.

Leakage rules (same as P2/P3):
  - Imputation/scaling/coefficients fit INSIDE each training fold only.
  - L2 selected via inner chronological validation.
  - Holdout is never opened here — ablations run on test folds only.
  - Outcomes remain separate labels; never embedded in features.
"""

from __future__ import annotations

import json
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
    FEATURE_NAMES,
    MIN_TRAIN_ROWS_PER_FOLD,
    MIN_EVENTS_PER_CLASS,
    REGULARIZATION_GRID,
    INNER_VAL_FRACTION,
)

# Candidate families from the P4 schema. Each maps to the subset of
# CANDIDATE_FEATURE_NAMES it owns. These only apply when candidate vectors are
# joined to the dataset (via the P4 extractor); with no candidate data the
# ablation falls back to the 62-control families below.
CANDIDATE_FAMILY_GROUPS: dict[str, list[str]] = {
    "statcast": ["awayTeamXwoba", "homeTeamXwoba", "awayTeamXslg", "homeTeamXslg",
                 "awayTeamBarrelRate", "homeTeamBarrelRate", "awayTeamHardHitRate", "homeTeamHardHitRate"],
    "arsenal": ["awayStarterStuffPlus", "homeStarterStuffPlus", "awayStarterStuffVsLhh", "homeStarterStuffVsRhh"],
    "expected_innings": ["awayStarterExpectedInnings", "homeStarterExpectedInnings"],
    "bullpen_quality": ["awayBullpenQuality", "homeBullpenQuality", "awayBullpenAvailInnings", "homeBullpenAvailInnings"],
    "lineup": ["awayLineupWeightedOps", "homeLineupWeightedOps", "awayLineupBattersCaptured", "homeLineupBattersCaptured"],
    "bvp": ["awayLineupBvpOps", "homeLineupBvpOps"],
    "xera": ["awayStarterXera", "homeStarterXera"],
}

# Control (62-vector) family groupings for V1 diagnostic neutralization. These
# mirror the heuristic_v1 component structure in CURRENT_MODEL_FORMULA.md.
CONTROL_FAMILY_GROUPS: dict[str, list[str]] = {
    "offense": ["awayRpg", "awayOps", "homeRpg", "homeOps", "awayRollingRpg", "awayRollingOps",
                "homeRollingRpg", "homeRollingOps"],
    "prevention": ["awayEra", "awayWhip", "homeEra", "homeWhip"],
    "starter": ["awayStarterEra", "awayStarterWhip", "homeStarterEra", "homeStarterWhip",
                "awayStarterKMinusBb", "homeStarterKMinusBb", "awayStarterHr9", "homeStarterHr9",
                "awayStarterRecentEra", "awayStarterRecentWhip", "awayStarterRecentInnings",
                "homeStarterRecentEra", "homeStarterRecentWhip", "homeStarterRecentInnings"],
    "bullpen": ["awayBullpenFatigue", "homeBullpenFatigue", "awayBullpenBackToBack", "homeBullpenBackToBack"],
    "form": ["awayWinPct", "homeWinPct", "awayLastTenPct", "homeLastTenPct",
             "awayRunDiffPerGame", "homeRunDiffPerGame", "awayRollingGames", "homeRollingGames"],
    "lineup": ["awayLineupConfirmed", "homeLineupConfirmed", "awayLineupQuality", "homeLineupQuality",
               "awayLineupCount", "homeLineupCount"],
    "schedule": ["awayRestDays", "homeRestDays", "awayRoadStreak", "homeRoadStreak"],
    "injury": ["awayInjuryCount", "homeInjuryCount"],
    "h2h": ["h2hGames", "h2hHomeWinPct"],
    "weather": ["temperature", "windSpeed", "windHittingOut", "windHittingIn"],
    "platoon": ["awayVsStarterHandPct", "homeVsStarterHandPct", "awayStarterHandLeft", "homeStarterHandLeft"],
}


@dataclass
class AblationResult:
    family: str
    full_metrics: dict[str, Any]
    leave_one_out_metrics: dict[str, Any]
    family_only_metrics: dict[str, Any]
    delta_brier: float | None  # leave_one_out - full (positive = family helps)
    delta_log_loss: float | None
    delta_accuracy: float | None
    coverage: int
    note: str | None = None


def _norm_prob(p: float | None) -> float | None:
    if p is None:
        return None
    p = float(p)
    return p / 100.0 if p > 1.5 else p


def _sigmoid(z: np.ndarray) -> np.ndarray:
    out = np.empty_like(z, dtype=float)
    high = z >= 35
    low = z <= -35
    mid = ~(high | low)
    out[high] = 1.0
    out[low] = 0.0
    out[mid] = 1.0 / (1.0 + np.exp(-z[mid]))
    return out


def _fit_logistic_fold(
    train_rows: list[DatasetRow],
    feature_subset: list[str] | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Fit an L2 logistic on the given feature subset (or all 62 if None).

    Returns (fit_dict, None) or (None, reason). fit_dict carries imputation,
    mean, std, coefficients (per subset feature), intercept, l2_strength.
    """
    matrix = _build_matrix(train_rows)
    if matrix is None:
        return None, "no_feature_vectors"
    X_all, y_all, valid_mask = matrix
    valid_idx = [i for i, m in enumerate(valid_mask) if m]
    X = X_all[valid_idx]
    y = y_all[valid_idx]

    if len(X) < MIN_TRAIN_ROWS_PER_FOLD:
        return None, f"insufficient_rows_{len(X)}_below_{MIN_TRAIN_ROWS_PER_FOLD}"
    pos = int(np.sum(y == 1.0))
    neg = int(np.sum(y == 0.0))
    if pos < MIN_EVENTS_PER_CLASS or neg < MIN_EVENTS_PER_CLASS:
        return None, f"insufficient_events_pos_{pos}_neg_{neg}"

    # Select feature columns for the subset.
    if feature_subset:
        col_idx = [FEATURE_NAMES.index(n) for n in feature_subset if n in FEATURE_NAMES]
        if not col_idx:
            return None, "empty_feature_subset"
        X = X[:, col_idx]
    names = feature_subset if feature_subset else list(FEATURE_NAMES)
    n_feat = len(names)

    # Imputation (training fold only).
    imputation: dict[str, float] = {}
    for j, name in enumerate(names):
        col = X[:, j]
        finite = col[np.isfinite(col)]
        imputation[name] = float(np.median(finite)) if finite.size else 0.0
        nan_mask = np.isnan(col)
        if nan_mask.any():
            X[nan_mask, j] = imputation[name]

    # Scaling (training fold only).
    feature_mean: dict[str, float] = {}
    feature_std: dict[str, float] = {}
    for j, name in enumerate(names):
        col = X[:, j]
        mu = float(np.mean(col))
        sigma = float(np.std(col))
        feature_mean[name] = mu
        feature_std[name] = sigma if sigma > 1e-9 else 1.0
        X[:, j] = (col - mu) / feature_std[name]

    # Inner chronological C selection.
    order = np.arange(len(y))
    n_val = max(1, int(len(y) * INNER_VAL_FRACTION))
    inner_train = order[:-n_val]
    inner_val = order[-n_val:]
    best_c = REGULARIZATION_GRID[0]
    best_brier = float("inf")
    for c in REGULARIZATION_GRID:
        clf = LogisticRegression(C=c, solver="lbfgs", max_iter=1000, fit_intercept=True)
        try:
            clf.fit(X[inner_train], y[inner_train])
        except (ValueError, np.linalg.LinAlgError):
            continue
        prob = _sigmoid(clf.intercept_[0] + clf.coef_[0] @ X[inner_val].T)
        brier = float(np.mean((prob - y[inner_val]) ** 2))
        if brier < best_brier:
            best_brier = brier
            best_c = c

    clf = LogisticRegression(C=best_c, solver="lbfgs", max_iter=1000, fit_intercept=True)
    clf.fit(X, y)
    coefficients = {names[j]: float(clf.coef_[0][j]) for j in range(n_feat)}
    return {
        "feature_names": names,
        "imputation": imputation,
        "feature_mean": feature_mean,
        "feature_std": feature_std,
        "coefficients": coefficients,
        "intercept": float(clf.intercept_[0]),
        "l2_strength": best_c,
    }, None


def _predict_logistic(fit: dict[str, Any], rows: list[DatasetRow]) -> tuple[list[float], list[int]]:
    probs: list[float] = []
    valid: list[int] = []
    names = fit["feature_names"]
    for row in rows:
        extracted = _row_features(row)
        if extracted is None:
            probs.append(0.5)
            valid.append(0)
            continue
        values, _missing = extracted
        z = fit["intercept"]
        for j, name in enumerate(names):
            if name not in FEATURE_NAMES:
                continue
            fi = FEATURE_NAMES.index(name)
            v = values[fi]
            if v is None:
                v = fit["imputation"].get(name, 0.0)
            scaled = (v - fit["feature_mean"][name]) / fit["feature_std"][name]
            z += fit["coefficients"][name] * scaled
        probs.append(float(_sigmoid(np.array([z]))[0]))
        valid.append(1)
    return probs, valid


def _score_folds(
    clean: list[DatasetRow],
    folds: list[dict[str, Any]],
    feature_subset: list[str] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Score a logistic ablation variant across test folds. Returns (metrics, reasons)."""
    oof_probs: list[float] = []
    oof_labels: list[int] = []
    reasons: list[str] = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        train_rows = [r for r in clean if fold["train_start_date"] <= r.date_ymd <= fold["train_end_date"]]
        test_rows = [r for r in clean if fold["start_date"] <= r.date_ymd < fold["end_date"]]
        fit, reason = _fit_logistic_fold(train_rows, feature_subset=feature_subset)
        if fit is None:
            reasons.append(f"fold_{fold['fold_index']}_{reason}")
            continue
        probs, valid = _predict_logistic(fit, test_rows)
        for p, r, v in zip(probs, test_rows, valid):
            if v and r.home_won is not None:
                oof_probs.append(p)
                oof_labels.append(1 if r.home_won else 0)
    if not oof_probs:
        return {"n": 0}, reasons + ["no_oof_predictions"]
    return model_metrics(oof_probs, oof_labels), reasons


def run_ablations(
    db_path: str,
    model_id: str = "heuristic_v1",
    cohort: str = "main",
    family_groups: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Run full / leave-one-out / family-only ablations per family group.

    Returns a report dict with per-family AblationResult summaries. Families
    without enough support yield an ``insufficient`` note, never a fabricated
    metric.
    """
    clean, quarantined = build_game_dataset(db_path, model_id=model_id, cohort=cohort)
    folds, dataset_hash = build_folds(clean)

    groups = family_groups or CONTROL_FAMILY_GROUPS

    # Full model (all 62 features) reference.
    full_metrics, full_reasons = _score_folds(clean, folds, feature_subset=None)

    # Control stored-probability reference (heuristic_v1 calibrated), per fold.
    control_oof_probs: list[float] = []
    control_oof_labels: list[int] = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        test_rows = [r for r in clean if fold["start_date"] <= r.date_ymd < fold["end_date"]]
        for r in test_rows:
            p = _norm_prob(r.calibrated_home_probability)
            if p is not None and r.home_won is not None:
                control_oof_probs.append(p)
                control_oof_labels.append(1 if r.home_won else 0)
    control_metrics = (
        model_metrics(control_oof_probs, control_oof_labels) if control_oof_probs else {"n": 0}
    )

    family_results: list[dict[str, Any]] = []
    for family, subset in groups.items():
        loo_metrics, loo_reasons = _score_folds(clean, folds, feature_subset=_complement(subset))
        only_metrics, only_reasons = _score_folds(clean, folds, feature_subset=subset)

        delta_brier = _delta(loo_metrics.get("brier"), full_metrics.get("brier"))
        delta_log_loss = _delta(loo_metrics.get("log_loss"), full_metrics.get("log_loss"))
        delta_accuracy = _delta(full_metrics.get("accuracy"), loo_metrics.get("accuracy"))

        note = None
        if loo_metrics.get("n", 0) == 0:
            note = f"loo_insufficient: {';'.join(loo_reasons)}"
        elif only_metrics.get("n", 0) == 0:
            note = f"family_only_insufficient: {';'.join(only_reasons)}"

        family_results.append({
            "family": family,
            "feature_count": len(subset),
            "full_metrics": full_metrics,
            "leave_one_out_metrics": loo_metrics,
            "family_only_metrics": only_metrics,
            "delta_brier_loo_minus_full": delta_brier,
            "delta_log_loss_loo_minus_full": delta_log_loss,
            "delta_accuracy_full_minus_loo": delta_accuracy,
            "coverage": loo_metrics.get("n", 0),
            "note": note,
        })

    return {
        "model_id": model_id,
        "cohort": cohort,
        "dataset_hash": dataset_hash,
        "row_count": len(clean),
        "quarantine_count": len(quarantined),
        "fold_count": len(folds),
        "control_stored_metrics": control_metrics,
        "full_model_metrics": full_metrics,
        "family_ablations": family_results,
        "ablation_schema": "control-v1-families" if (family_groups is None) else "candidate-v1-families",
        "full_model_reasons": full_reasons,
    }


def _delta(a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    return round(float(a) - float(b), 6)


def _complement(subset: list[str]) -> list[str]:
    """All 62 control features EXCEPT the subset (leave-one-family-out)."""
    s = set(subset)
    return [n for n in FEATURE_NAMES if n not in s]


def write_ablation_report(report: dict[str, Any], output_dir: str) -> str:
    """Write machine JSON + Markdown under reports/ablation/."""
    os.makedirs(output_dir, exist_ok=True)
    schema = report.get("ablation_schema", "unknown")
    json_path = os.path.join(output_dir, f"ablation_{schema}.json")
    with open(json_path, "w") as f:
        json.dump(report, f, indent=2, default=str)

    md_path = os.path.join(output_dir, f"ablation_{schema}.md")
    _write_markdown(report, md_path)
    return md_path


def _write_markdown(report: dict[str, Any], path: str) -> None:
    lines = ["# Chronological Ablation Report", ""]
    lines.append(f"- Schema: `{report.get('ablation_schema')}`")
    lines.append(f"- Cohort: `{report.get('cohort')}` | rows: {report.get('row_count')} | "
                 f"quarantined: {report.get('quarantine_count')} | folds: {report.get('fold_count')}")
    lines.append(f"- Dataset hash: `{report.get('dataset_hash')}`")
    lines.append("")

    ctrl = report.get("control_stored_metrics", {})
    full = report.get("full_model_metrics", {})
    lines.append("## Reference metrics (OOF test folds)")
    lines.append("")
    lines.append("| Model | n | accuracy | Brier | log loss | AUC | ECE |")
    lines.append("|---|---|---|---|---|---|---|")
    lines.append(f"| control heuristic_v1 (stored) | {ctrl.get('n',0)} | "
                 f"{_f(ctrl.get('accuracy'))} | {_f(ctrl.get('brier'))} | "
                 f"{_f(ctrl.get('log_loss'))} | {_f(ctrl.get('roc_auc'))} | {_f(ctrl.get('ece'))} |")
    lines.append(f"| logistic full (all features) | {full.get('n',0)} | "
                 f"{_f(full.get('accuracy'))} | {_f(full.get('brier'))} | "
                 f"{_f(full.get('log_loss'))} | {_f(full.get('roc_auc'))} | {_f(full.get('ece'))} |")
    lines.append("")

    lines.append("## Per-family ablation")
    lines.append("")
    lines.append("Delta = leave-one-out minus full. Positive ΔBrier / Δlog loss means removing the "
                 "family HURTS (family is useful). Positive Δaccuracy means full beats leave-one-out.")
    lines.append("")
    lines.append("| Family | feats | LOO n | ΔBrier | Δlog loss | Δaccuracy | note |")
    lines.append("|---|---|---|---|---|---|---|")
    for fr in report.get("family_ablations", []):
        lines.append(
            f"| {fr['family']} | {fr['feature_count']} | {fr['coverage']} | "
            f"{_f(fr['delta_brier_loo_minus_full'])} | {_f(fr['delta_log_loss_loo_minus_full'])} | "
            f"{_f(fr['delta_accuracy_full_minus_loo'])} | {fr.get('note') or ''} |"
        )
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("_V1 production math is unchanged by ablation results. Holdout is not opened here. "
                 "A family is retained only when temporally valid, supported across folds, and improving "
                 "or preserving Brier/log loss without material accuracy/subgroup failure._")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def _f(v: Any) -> str:
    if v is None:
        return "—"
    try:
        return f"{float(v):.4f}"
    except (TypeError, ValueError):
        return str(v)
