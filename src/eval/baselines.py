"""Simple baselines scored on identical cohorts for direct comparison.

  - home_baseline: always pick home; probability is training-fold home rate.
  - market_baseline: same-book no-vig pair available by run as-of; with-market
    cohort only.
  - elo_log5: Elo ratings updated only after each completed prior date — no
    current/future outcomes.

All baselines return home-win probability in [0,1]. Heuristic_v1 uses its
stored control probability. Metrics computed via eval.metrics.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from src.elo_rating import build_elo_from_schedule, elo_to_win_probability
from src.eval.metrics import model_metrics


def home_baseline(
    test_rows: list[dict[str, Any]],
    train_rows: list[dict[str, Any]],
) -> list[float]:
    """Home-win probability = training-fold home rate. Always picks home."""
    home_wins = sum(1 for r in train_rows if r.get("home_won") == 1)
    total = len(train_rows)
    rate = home_wons_rate = (home_wins / total) if total > 0 else 0.5
    return [rate for _ in test_rows]


def market_baseline(test_rows: list[dict[str, Any]]) -> list[float | None]:
    """Same-book no-vig home probability. None where no market available."""
    return [r.get("market_no_vig_home_prob") for r in test_rows]


def _elo_history_from_train(train_rows: list[dict[str, Any]]):
    """Build Elo from completed prior-date games only (no current/future)."""
    games = []
    for r in train_rows:
        home = r.get("home_team_id")
        away = r.get("away_team_id")
        if not home or not away or r.get("home_won") is None:
            continue
        games.append({
            "home_team": str(home),
            "away_team": str(away),
            "home_score": 1 if r.get("home_won") == 1 else 0,
            "away_score": 0 if r.get("home_won") == 1 else 1,
            "date": r.get("date_ymd") or "",
        })
    return build_elo_from_schedule(games)


def elo_log5_baseline(
    test_rows: list[dict[str, Any]],
    train_rows: list[dict[str, Any]],
) -> list[float | None]:
    """Elo/Log5 home-win probability from prior-date ratings only."""
    history = _elo_history_from_train(train_rows)
    probs = []
    for r in test_rows:
        home = str(r.get("home_team_id") or "")
        away = str(r.get("away_team_id") or "")
        if not home or not away:
            probs.append(None)
            continue
        p = elo_to_win_probability(home, away, history)
        probs.append(p)
    return probs


def score_baselines(
    rows: list[dict[str, Any]],
    folds: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Score home/market/elo baselines per fold + aggregate.

    Each baseline is scored only on rows where it produces a non-None
    probability. Market baseline is restricted to with-market rows. Reports
    common-intersection metrics separately from model-specific coverage.
    """
    results: dict[str, dict[str, Any]] = {}

    # --- Home baseline (full coverage) ---
    home_by_fold = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        test_rows = [r for r in rows if fold["start_date"] <= r["date_ymd"] < fold["end_date"]]
        train_rows = [r for r in rows if fold["train_start_date"] <= r["date_ymd"] <= fold["train_end_date"]]
        probs = home_baseline(test_rows, train_rows)
        outcomes = [r.get("home_won") for r in test_rows]
        # Only score where outcome present.
        paired = [(p, o) for p, o in zip(probs, outcomes) if o is not None and p is not None]
        m = model_metrics([p for p, _ in paired], [o for _, o in paired])
        m["fold"] = fold["fold_index"]
        m["coverage"] = len(paired)
        m["fold_total"] = len(test_rows)
        home_by_fold.append(m)
    results["home_baseline"] = _aggregate_folds(home_by_fold)

    # --- Elo/Log5 baseline ---
    elo_by_fold = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        test_rows = [r for r in rows if fold["start_date"] <= r["date_ymd"] < fold["end_date"]]
        train_rows = [r for r in rows if fold["train_start_date"] <= r["date_ymd"] <= fold["train_end_date"]]
        probs = elo_log5_baseline(test_rows, train_rows)
        outcomes = [r.get("home_won") for r in test_rows]
        paired = [(p, o) for p, o in zip(probs, outcomes) if o is not None and p is not None]
        m = model_metrics([p for p, _ in paired], [o for _, o in paired])
        m["fold"] = fold["fold_index"]
        m["coverage"] = len(paired)
        m["fold_total"] = len(test_rows)
        elo_by_fold.append(m)
    results["elo_log5"] = _aggregate_folds(elo_by_fold)

    # --- Market baseline (with-market only) ---
    market_by_fold = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        test_rows = [r for r in rows if fold["start_date"] <= r["date_ymd"] < fold["end_date"]]
        probs = market_baseline(test_rows)
        outcomes = [r.get("home_won") for r in test_rows]
        paired = [(p, o) for p, o in zip(probs, outcomes) if o is not None and p is not None]
        m = model_metrics([p for p, _ in paired], [o for _, o in paired])
        m["fold"] = fold["fold_index"]
        m["coverage"] = len(paired)
        m["fold_total"] = len(test_rows)
        market_by_fold.append(m)
    results["market_baseline"] = _aggregate_folds(market_by_fold)

    return results


def _aggregate_folds(fold_metrics: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate per-fold metrics into a summary. Pool probabilities only
    conceptually; here we report mean-of-folds + coverage."""
    if not fold_metrics:
        return {"n_folds": 0, "total_coverage": 0}
    keys = ["accuracy", "brier", "log_loss", "roc_auc", "ece"]
    agg: dict[str, Any] = {"n_folds": len(fold_metrics), "total_coverage": sum(f["coverage"] for f in fold_metrics)}
    for k in keys:
        vals = [f[k] for f in fold_metrics if f.get(k) is not None]
        agg[f"mean_{k}"] = float(np.mean(vals)) if vals else None
        agg[f"std_{k}"] = float(np.std(vals)) if vals else None
        agg[f"per_fold_{k}"] = vals
    agg["per_fold"] = fold_metrics
    return agg
