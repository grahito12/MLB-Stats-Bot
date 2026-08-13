"""Compare control heuristic_v1 against baselines and (later) challengers on
identical all-game cohorts. Reports common-intersection metrics for direct
comparisons and model-specific coverage separately.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from src.dataset.build_game_dataset import build_game_dataset, build_folds, DatasetRow
from src.eval.metrics import model_metrics
from src.eval.baselines import score_baselines


def compare_models(
    db_path: str,
    model_id: str = "heuristic_v1",
    cohort: str = "main",
) -> dict[str, Any]:
    """Build the dataset, score the control + baselines on common folds.

    Returns a comparison report. Control uses stored calibrated home
    probability. Common-intersection metrics restrict to rows where EVERY
    model produces a probability (so the market baseline's with-market-only
    coverage doesn't inflate apparent market performance).
    """
    clean, quarantined = build_game_dataset(db_path, model_id=model_id, cohort=cohort)
    folds, dataset_hash = build_folds(clean)
    rows = [r.to_dict() for r in clean]

    # --- Control heuristic_v1 per fold ---
    control_by_fold = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        test_rows = [r for r in rows if fold["start_date"] <= r["date_ymd"] < fold["end_date"]]
        probs = [r.get("calibrated_home_probability") for r in test_rows]
        # Convert percentages (0-100) to 0-1 if needed.
        probs = [_norm_prob(p) for p in probs]
        outcomes = [r.get("home_won") for r in test_rows]
        paired = [(p, o) for p, o in zip(probs, outcomes) if o is not None and p is not None]
        m = model_metrics([p for p, _ in paired], [o for _, o in paired])
        m["fold"] = fold["fold_index"]
        m["coverage"] = len(paired)
        m["fold_total"] = len(test_rows)
        control_by_fold.append(m)

    control_summary = _aggregate_folds(control_by_fold)
    baseline_summary = score_baselines(rows, folds)

    # --- Common-intersection: rows where control AND market both have prob ---
    common_intersection = _common_intersection_metrics(rows, folds)

    return {
        "model_id": model_id,
        "cohort": cohort,
        "dataset_hash": dataset_hash,
        "row_count": len(rows),
        "quarantine_count": len(quarantined),
        "fold_count": len(folds),
        "holdout_present": any(f["fold_type"] == "holdout" for f in folds),
        "control": control_summary,
        "baselines": baseline_summary,
        "common_intersection": common_intersection,
        "folds": folds,
    }


def _norm_prob(p: float | None) -> float | None:
    if p is None:
        return None
    p = float(p)
    if p > 1.5:  # stored as percentage 0-100
        return p / 100.0
    return p


def _aggregate_folds(fold_metrics: list[dict[str, Any]]) -> dict[str, Any]:
    if not fold_metrics:
        return {"n_folds": 0, "total_coverage": 0}
    keys = ["accuracy", "brier", "log_loss", "roc_auc", "ece"]
    agg: dict[str, Any] = {"n_folds": len(fold_metrics), "total_coverage": sum(f["coverage"] for f in fold_metrics)}
    for k in keys:
        vals = [f[k] for f in fold_metrics if f.get(k) is not None]
        agg[f"mean_{k}"] = float(np.mean(vals)) if vals else None
        agg[f"std_{k}"] = float(np.std(vals)) if vals else None
    agg["per_fold"] = fold_metrics
    return agg


def _common_intersection_metrics(rows: list[dict[str, Any]], folds: list[dict[str, Any]]) -> dict[str, Any]:
    """Score control + market on the SAME rows (with-market only) so the
    comparison is apples-to-apples."""
    intersection_by_fold = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        test_rows = [r for r in rows if fold["start_date"] <= r["date_ymd"] < fold["end_date"]]
        control_probs = []
        market_probs = []
        outcomes = []
        for r in test_rows:
            cp = _norm_prob(r.get("calibrated_home_probability"))
            mp = _norm_prob(r.get("market_no_vig_home_prob"))
            o = r.get("home_won")
            if cp is not None and mp is not None and o is not None:
                control_probs.append(cp)
                market_probs.append(mp)
                outcomes.append(o)
        intersection_by_fold.append({
            "fold": fold["fold_index"],
            "n": len(outcomes),
            "control": model_metrics(control_probs, outcomes),
            "market": model_metrics(market_probs, outcomes),
        })

    # Aggregate.
    def _mean(key, which):
        vals = [f[which].get(key) for f in intersection_by_fold if f[which].get(key) is not None]
        return float(np.mean(vals)) if vals else None

    summary = {
        "n_folds": len(intersection_by_fold),
        "total_n": sum(f["n"] for f in intersection_by_fold),
        "control_mean_brier": _mean("brier", "control"),
        "market_mean_brier": _mean("brier", "market"),
        "control_mean_log_loss": _mean("log_loss", "control"),
        "market_mean_log_loss": _mean("log_loss", "market"),
        "control_mean_accuracy": _mean("accuracy", "control"),
        "market_mean_accuracy": _mean("accuracy", "market"),
        "control_mean_auc": _mean("roc_auc", "control"),
        "market_mean_auc": _mean("roc_auc", "market"),
        "per_fold": intersection_by_fold,
    }
    return summary
