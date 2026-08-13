"""Probability scoring metrics for binary (home-win) outcomes.

All metrics take home-win probability in [0,1] and home_won in {0,1}. Empty
cohorts return None, never zero — a silent 0.0 would read as "perfect" or
"terrible" depending on the metric.
"""

from __future__ import annotations

from typing import Iterable

import numpy as np

from src.calibration import brier_score as _py_brier, log_loss as _py_log_loss


def _to_arrays(probs: Iterable[float], outcomes: Iterable[int]):
    p = np.asarray([float(x) for x in probs if x is not None], dtype=float)
    y = np.asarray([int(x) for x in outcomes if x is not None], dtype=int)
    n = min(len(p), len(y))
    return p[:n], y[:n]


def accuracy(probs: Iterable[float], outcomes: Iterable[int]) -> float | None:
    p, y = _to_arrays(probs, outcomes)
    if len(p) == 0:
        return None
    preds = (p >= 0.5).astype(int)
    return float(np.mean(preds == y))


def brier_score(probs: Iterable[float], outcomes: Iterable[int]) -> float | None:
    p, y = _to_arrays(probs, outcomes)
    if len(p) == 0:
        return None
    return float(np.mean((p - y) ** 2))


def log_loss(probs: Iterable[float], outcomes: Iterable[int], epsilon: float = 1e-15) -> float | None:
    p, y = _to_arrays(probs, outcomes)
    if len(p) == 0:
        return None
    p = np.clip(p, epsilon, 1 - epsilon)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def roc_auc(probs: Iterable[float], outcomes: Iterable[int]) -> float | None:
    """ROC AUC. Requires both classes present, else None."""
    p, y = _to_arrays(probs, outcomes)
    if len(p) == 0 or len(np.unique(y)) < 2:
        return None
    # Rank-based AUC (Mann-Whitney U).
    order = np.argsort(p)
    ranks = np.empty(len(p), dtype=float)
    ranks[order] = np.arange(1, len(p) + 1, dtype=float)
    # Handle ties by averaging ranks.
    unique, inverse, counts = np.unique(p, return_inverse=True, return_counts=True)
    if np.any(counts > 1):
        rank_sums = np.zeros(len(unique), dtype=float)
        np.add.at(rank_sums, inverse, ranks)
        avg_ranks = rank_sums / counts
        ranks = avg_ranks[inverse]
    pos = y == 1
    n_pos = int(np.sum(pos))
    n_neg = len(y) - n_pos
    if n_pos == 0 or n_neg == 0:
        return None
    sum_ranks_pos = float(np.sum(ranks[pos]))
    auc = (sum_ranks_pos - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)
    return float(auc)


def ece(probs: Iterable[float], outcomes: Iterable[int], n_bins: int = 10) -> float | None:
    """Expected Calibration Error."""
    p, y = _to_arrays(probs, outcomes)
    if len(p) == 0:
        return None
    bins = np.linspace(0, 1, n_bins + 1)
    total_ece = 0.0
    n = len(p)
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        if i == n_bins - 1:
            mask = (p >= lo) & (p <= hi)
        else:
            mask = (p >= lo) & (p < hi)
        count = int(np.sum(mask))
        if count == 0:
            continue
        bin_conf = float(np.mean(p[mask]))
        bin_acc = float(np.mean(y[mask]))
        total_ece += (count / n) * abs(bin_conf - bin_acc)
    return float(total_ece)


def reliability_bins(probs: Iterable[float], outcomes: Iterable[int], n_bins: int = 10) -> list[dict]:
    """Per-bin reliability table for calibration plots."""
    p, y = _to_arrays(probs, outcomes)
    if len(p) == 0:
        return []
    bins = np.linspace(0, 1, n_bins + 1)
    table = []
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        if i == n_bins - 1:
            mask = (p >= lo) & (p <= hi)
        else:
            mask = (p >= lo) & (p < hi)
        count = int(np.sum(mask))
        table.append({
            "bin_lo": round(float(lo), 3),
            "bin_hi": round(float(hi), 3),
            "count": count,
            "mean_prob": round(float(np.mean(p[mask])), 4) if count else None,
            "mean_outcome": round(float(np.mean(y[mask])), 4) if count else None,
        })
    return table


def model_metrics(probs: Iterable[float], outcomes: Iterable[int]) -> dict:
    """Compute the full metric suite. Empty cohort -> all None."""
    p, y = _to_arrays(probs, outcomes)
    if len(p) == 0:
        return {
            "n": 0,
            "accuracy": None,
            "brier": None,
            "log_loss": None,
            "roc_auc": None,
            "ece": None,
            "reliability": [],
        }
    return {
        "n": int(len(p)),
        "accuracy": accuracy(p, y),
        "brier": brier_score(p, y),
        "log_loss": log_loss(p, y),
        "roc_auc": roc_auc(p, y),
        "ece": ece(p, y),
        "reliability": reliability_bins(p, y),
    }
