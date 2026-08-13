"""P6 all-game out-of-fold calibration + artifact governance.

Generates model OOF probabilities on the outer walk-forward test folds and fits
calibration methods with NO leakage:

  - Calibrate fold k ONLY with eligible OOF (raw_probability, outcome) pairs from
    STRICTLY EARLIER folds. The first eligible fold has no earlier history, so it
    uses identity (no calibration). A scored label can never enter the calibrator
    that calibrates it.
  - Compare identity, Platt, guarded isotonic, and beta calibration on the
    pre-holdout prequential OOF series (never the holdout). Apply predeclared
    minimum / distinctness / conditioning checks; skip unstable methods rather
    than forcing a map.
  - Select the deployable method from pre-holdout prequential Brier. Only methods
    with a JS parity implementation (identity, Platt, guarded isotonic) may be
    selected as the deployable proposal. Beta is scored as a comparison reference
    only (no JS betaincinv parity) — if it wins prequentially, the next-best
    parity-capable method is selected and beta is reported alongside.
  - Fit the final proposal calibrator on ALL pre-holdout OOF pairs, then score the
    untouched holdout ONCE.

Writes PROPOSAL artifacts to data/models/ only. It NEVER overwrites the current
V1 calibration files (calibration_maps.json / calibration_meta.json /
calibration_map.json), the active model registry, environment variables, or any
live pointer. Activation requires separate human approval.

Reads model_predictions + outcomes from a (copy of) the production DB via the P1
dataset builder. NEVER mutates production tables.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.optimize import minimize
from scipy.special import betainc  # noqa: F401  (parity note: no JS betaincinv)
from scipy.stats import beta as beta_dist

from src.dataset.build_game_dataset import build_game_dataset, build_folds, DatasetRow
from src.eval.metrics import model_metrics

# ---- Identity (mirrors src/core/model_ids.js) ----
OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION = "oof-calibration-artifact-v1"

# Methods compared prequentially.
METHOD_IDENTITY = "identity"
METHOD_PLATT = "platt"
METHOD_ISOTONIC_GUARDED = "isotonic_guarded"
METHOD_BETA = "beta"
ALL_METHODS = [METHOD_IDENTITY, METHOD_PLATT, METHOD_ISOTONIC_GUARDED, METHOD_BETA]

# Methods eligible to be SELECTED as a deployable proposal artifact. These have a
# pure-JS inference implementation (src/calibration.js) so JS/Python parity is
# guaranteed. Beta is excluded — scipy.stats.beta.cdf has no self-contained JS
# parity partner, so it is reported as a comparison reference only.
DEPLOYABLE_METHODS = [METHOD_IDENTITY, METHOD_PLATT, METHOD_ISOTONIC_GUARDED]

# ---- Predeclared gates (frozen before holdout is read) ----
# Minimum OOF pairs required to fit ANY non-identity calibrator.
MIN_CALIB_SAMPLES = 60
# Minimum events of each class to fit a calibrator (avoids degenerate fits).
MIN_CALIB_EVENTS_PER_CLASS = 8
# Isotonic binning.
ISOTONIC_BUCKET_SIZE = 0.04
ISOTONIC_MIN_BIN_COUNT = 3
# Distinctness: a non-identity method must move the mean calibrated probability
# away from the mean raw probability by at least this much somewhere, otherwise
# it is numerically identity and skipped (no forced map).
MIN_DISTINCTNESS = 1e-4
# Platt slope must be positive and finite (a downward slope inverts the ranking).
# A non-positive Platt slope is unstable and skipped.
# Small-sample clamp for calibrated outputs.
CALIB_CLAMP_LO = 0.05
CALIB_CLAMP_HI = 0.95

_EPS = 1e-6


def _norm_prob(p: float | None) -> float | None:
    """Normalize 0-100 or 0-1 probability to 0-1."""
    if p is None:
        return None
    try:
        v = float(p)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return v / 100.0 if v > 1.5 else v


def _clamp(v: float, lo: float = CALIB_CLAMP_LO, hi: float = CALIB_CLAMP_HI) -> float:
    return max(lo, min(hi, v))


def _logit(p: float) -> float:
    p = min(max(p, _EPS), 1 - _EPS)
    return math.log(p / (1 - p))


def _sigmoid(z: float) -> float:
    if z >= 35:
        return 1.0
    if z <= -35:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


# ---------------------------------------------------------------------------
# Method fitters. Each returns (params, info) or (None, reason).
# ---------------------------------------------------------------------------


def _fit_platt(probs: np.ndarray, outcomes: np.ndarray) -> tuple[dict | None, str | None]:
    """Platt scaling: cal(p) = sigmoid(a * logit(p) + b).

    Fit via logistic regression of outcome on logit(p). Slightly regularized for
    stability. Returns ({a, b}, None) or (None, reason).
    """
    from sklearn.linear_model import LogisticRegression

    if len(probs) < MIN_CALIB_SAMPLES:
        return None, f"insufficient_samples_{len(probs)}_below_{MIN_CALIB_SAMPLES}"
    pos = int(np.sum(outcomes == 1))
    neg = int(np.sum(outcomes == 0))
    if pos < MIN_CALIB_EVENTS_PER_CLASS or neg < MIN_CALIB_EVENTS_PER_CLASS:
        return None, f"insufficient_events_pos_{pos}_neg_{neg}"
    logit_p = np.array([_logit(float(p)) for p in probs]).reshape(-1, 1)
    try:
        clf = LogisticRegression(C=1.0, solver="lbfgs", max_iter=1000, fit_intercept=True)
        clf.fit(logit_p, outcomes)
    except (ValueError, np.linalg.LinAlgError) as exc:
        return None, f"platt_fit_failed:{exc}"
    a = float(clf.coef_[0][0])
    b = float(clf.intercept_[0])
    if not math.isfinite(a) or not math.isfinite(b):
        return None, "platt_nonfinite"
    # A non-positive slope inverts the probability ranking — unstable.
    if a <= 0:
        return None, f"platt_nonpositive_slope_{a:.6f}"
    return {"a": a, "b": b}, None


def _apply_platt(params: dict, p: float) -> float:
    return _clamp(_sigmoid(params["a"] * _logit(p) + params["b"]))


def _fit_isotonic_guarded(
    probs: np.ndarray, outcomes: np.ndarray
) -> tuple[list[list[float]] | None, str | None]:
    """Binned PAV isotonic with degenerate / low-sample guards.

    Returns (mapping [[x, y], ...], None) or (None, reason). Mirrors the guarded
    isotonic in probability_calibrator._make_isotonic but writes nothing.
    """
    if len(probs) < MIN_CALIB_SAMPLES:
        return None, f"insufficient_samples_{len(probs)}_below_{MIN_CALIB_SAMPLES}"
    pos = int(np.sum(outcomes == 1))
    neg = int(np.sum(outcomes == 0))
    if pos < MIN_CALIB_EVENTS_PER_CLASS or neg < MIN_CALIB_EVENTS_PER_CLASS:
        return None, f"insufficient_events_pos_{pos}_neg_{neg}"

    buckets: dict[int, list[tuple[float, float]]] = {}
    for prob, outcome in zip(probs, outcomes):
        bucket_idx = int(float(prob) / ISOTONIC_BUCKET_SIZE)
        buckets.setdefault(bucket_idx, []).append((float(prob), float(outcome)))

    binned: list[tuple[float, float, int]] = []
    low_conf = False
    for bucket_idx in sorted(buckets):
        pts = buckets[bucket_idx]
        if len(pts) < ISOTONIC_MIN_BIN_COUNT:
            continue
        if len(pts) < 3:
            low_conf = True
        avg_p = sum(pp for pp, _ in pts) / len(pts)
        avg_o = sum(oo for _, oo in pts) / len(pts)
        binned.append((avg_p, avg_o, len(pts)))
    if len(binned) < 3:
        return None, f"insufficient_bins_{len(binned)}"

    mapping = _pav(binned)
    if not mapping:
        return None, "pav_empty"
    # Clamp y to safe range.
    mapping = [(x, _clamp(y)) for x, y in mapping]
    # Degenerate guard: a flat single level has no monotonic signal.
    distinct_y = {round(y, 6) for _, y in mapping}
    if len(mapping) < 2 or len(distinct_y) < 2:
        return None, "degenerate_map_no_monotonic_signal"
    return [[x, y] for x, y in mapping], None


def _pav(points: list[tuple[float, float, int]]) -> list[tuple[float, float]]:
    """Pool-adjacent-violators, sample-count weighted. Returns (x, y) pairs."""
    points = sorted(points, key=lambda p: p[0])
    blocks: list[list[tuple[float, float, int]]] = [[points[0]]]
    for point in points[1:]:
        blocks.append([point])
        while len(blocks) >= 2:
            last_n = sum(p[2] for p in blocks[-1])
            prev_n = sum(p[2] for p in blocks[-2])
            last_avg = sum(p[1] * p[2] for p in blocks[-1]) / last_n if last_n else 0.0
            prev_avg = sum(p[1] * p[2] for p in blocks[-2]) / prev_n if prev_n else 0.0
            if prev_avg <= last_avg:
                break
            blocks[-2].extend(blocks[-1])
            blocks.pop()
    result: list[tuple[float, float]] = []
    for block in blocks:
        total_n = sum(p[2] for p in block)
        avg_x = sum(p[0] * p[2] for p in block) / total_n if total_n else sum(p[0] for p in block) / len(block)
        avg_y = sum(p[1] * p[2] for p in block) / total_n if total_n else sum(p[1] for p in block) / len(block)
        result.append((avg_x, avg_y))
    return result


def _apply_isotonic(mapping: list[list[float]], p: float) -> float:
    from bisect import bisect_left

    if not mapping:
        return p
    xs = [m[0] for m in mapping]
    ys = [m[1] for m in mapping]
    if p <= xs[0]:
        return ys[0]
    if p >= xs[-1]:
        return ys[-1]
    idx = bisect_left(xs, p)
    if idx == 0:
        return ys[0]
    x0, x1 = xs[idx - 1], xs[idx]
    y0, y1 = ys[idx - 1], ys[idx]
    if x1 == x0:
        return y0
    t = (p - x0) / (x1 - x0)
    return y0 + t * (y1 - y0)


def _fit_beta(probs: np.ndarray, outcomes: np.ndarray) -> tuple[dict | None, str | None]:
    """Beta-CDF calibration: cal(p) = BetaCDF(p; alpha, beta).

    Fit (alpha, beta) by MLE on the calibrated-likelihood of the outcomes.
    Comparison-reference only — no JS parity partner, so never selected as the
    deployable method (enforced by DEPLOYABLE_METHODS).
    """
    if len(probs) < MIN_CALIB_SAMPLES:
        return None, f"insufficient_samples_{len(probs)}_below_{MIN_CALIB_SAMPLES}"
    pos = int(np.sum(outcomes == 1))
    neg = int(np.sum(outcomes == 0))
    if pos < MIN_CALIB_EVENTS_PER_CLASS or neg < MIN_CALIB_EVENTS_PER_CLASS:
        return None, f"insufficient_events_pos_{pos}_neg_{neg}"
    p = np.clip(probs.astype(float), _EPS, 1 - _EPS)
    y = outcomes.astype(float)

    def neg_ll(theta: np.ndarray) -> float:
        alpha, beta = float(theta[0]), float(theta[1])
        if alpha <= 0 or beta <= 0:
            return 1e18
        cdf = beta_dist.cdf(p, alpha, beta)
        cdf = np.clip(cdf, _EPS, 1 - _EPS)
        return float(-np.sum(y * np.log(cdf) + (1 - y) * np.log(1 - cdf)))

    try:
        res = minimize(neg_ll, x0=np.array([1.0, 1.0]), method="Nelder-Mead",
                       options={"xatol": 1e-5, "fatol": 1e-5, "maxiter": 2000})
    except (ValueError, RuntimeError) as exc:
        return None, f"beta_fit_failed:{exc}"
    alpha, beta = float(res.x[0]), float(res.x[1])
    if alpha <= 0 or beta <= 0 or not math.isfinite(alpha) or not math.isfinite(beta):
        return None, "beta_nonpositive_params"
    return {"alpha": alpha, "beta": beta}, None


def _apply_beta(params: dict, p: float) -> float:
    p = min(max(float(p), _EPS), 1 - _EPS)
    return _clamp(float(beta_dist.cdf(p, params["alpha"], params["beta"])))


def _fit_method(method: str, probs: np.ndarray, outcomes: np.ndarray):
    """Dispatch fit. Returns (params, reason)."""
    if method == METHOD_IDENTITY:
        return {}, None
    if method == METHOD_PLATT:
        return _fit_platt(probs, outcomes)
    if method == METHOD_ISOTONIC_GUARDED:
        return _fit_isotonic_guarded(probs, outcomes)
    if method == METHOD_BETA:
        return _fit_beta(probs, outcomes)
    return None, f"unknown_method_{method}"


def _apply_method(method: str, params: Any, p: float) -> float:
    if method == METHOD_IDENTITY:
        return _clamp(p)
    if method == METHOD_PLATT:
        return _apply_platt(params, p)
    if method == METHOD_ISOTONIC_GUARDED:
        return _apply_isotonic(params, p)
    if method == METHOD_BETA:
        return _apply_beta(params, p)
    return _clamp(p)


def _distinctness_ok(method: str, params: Any, probs: np.ndarray) -> bool:
    """A non-identity method must change at least one probability beyond a tiny
    epsilon; otherwise it is numerically identity and skipped (no forced map)."""
    if method == METHOD_IDENTITY:
        return True
    sample = probs[:200] if len(probs) > 200 else probs
    raw = np.array([_clamp(float(p)) for p in sample])
    cal = np.array([_apply_method(method, params, float(p)) for p in sample])
    return float(np.max(np.abs(cal - raw))) >= MIN_DISTINCTNESS


# ---------------------------------------------------------------------------
# Stable stringify (mirrors src/core/learned_v2_logistic.js stableStringify)
# so the proposal artifact hash is reproducible across JS/Python.
# ---------------------------------------------------------------------------


def _stable_stringify(value: Any) -> str:
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
    return hashlib.sha256(_stable_stringify(content).encode()).hexdigest()


@dataclass
class CalibFold:
    fold_index: int
    method_used: str          # method actually applied to this test fold
    fit_source_folds: list[int]  # earlier folds used to fit
    reason: str | None


def run_oof_calibration(
    db_path: str,
    model_id: str = "heuristic_v1",
    cohort: str = "main",
    target_probability: str = "raw_home_probability",
) -> dict[str, Any]:
    """Run all-game OOF calibration and emit a PROPOSAL artifact (no live writes).

    target_probability selects which stored probability stage is calibrated:
      'raw_home_probability'  — the uncalibrated control probability (default;
        correct target for calibrating the control model).
      'calibrated_home_probability' — already-calibrated stage (diagnostic only).

    Returns a report dict. The deployable artifact lives under report['artifact'].
    """
    clean, quarantined = build_game_dataset(db_path, model_id=model_id, cohort=cohort)

    base: dict[str, Any] = {
        "artifact_manifest_version": OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION,
        "model_id": model_id,
        "cohort": cohort,
        "target_probability": target_probability,
        "dataset_row_count": len(clean),
        "quarantine_count": len(quarantined),
        "methods_compared": list(ALL_METHODS),
        "deployable_methods": list(DEPLOYABLE_METHODS),
        "gates": {
            "min_calib_samples": MIN_CALIB_SAMPLES,
            "min_calib_events_per_class": MIN_CALIB_EVENTS_PER_CLASS,
            "isotonic_bucket_size": ISOTONIC_BUCKET_SIZE,
            "isotonic_min_bin_count": ISOTONIC_MIN_BIN_COUNT,
            "min_distinctness": MIN_DISTINCTNESS,
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

    # Collect per-fold OOF (raw_prob, outcome) for test rows. These accumulate
    # and become the fit set for LATER folds only (prequential, no leakage).
    fold_oof: list[dict[str, Any]] = []  # per fold: {index, probs, labels}
    for fold in test_folds:
        test_start = fold["start_date"]
        test_end = fold["end_date"]
        test_rows = [r for r in clean if test_start <= r.date_ymd < test_end]
        probs: list[float] = []
        labels: list[int] = []
        for r in test_rows:
            raw = _extract_target_prob(r, target_probability)
            if raw is not None and r.home_won is not None:
                probs.append(raw)
                labels.append(1 if r.home_won else 0)
        fold_oof.append({"index": fold["fold_index"], "probs": probs, "labels": labels})

    # ---- Prequential OOF per method ----
    # For each method, calibrate fold k using ONLY earlier folds' OOF pairs.
    # First eligible (non-empty earlier) fold uses identity.
    prequential: dict[str, dict[str, Any]] = {}
    fold_records: list[dict[str, Any]] = []
    for method in ALL_METHODS:
        cal_probs: list[float] = []
        cal_labels: list[int] = []
        per_fold_used: list[CalibFold] = []
        accumulated_probs: list[float] = []
        accumulated_labels: list[int] = []
        for fo in fold_oof:
            idx = fo["index"]
            fprobs = fo["probs"]
            flabels = fo["labels"]
            if not fprobs:
                per_fold_used.append(CalibFold(idx, METHOD_IDENTITY, [], "empty_test_fold"))
                continue
            if not accumulated_probs:
                # First eligible fold: no earlier history -> identity.
                for p in fprobs:
                    cal_probs.append(_clamp(p))
                cal_labels.extend(flabels)
                per_fold_used.append(CalibFold(idx, METHOD_IDENTITY, [], "first_fold_identity"))
            else:
                train_p = np.array(accumulated_probs, dtype=float)
                train_y = np.array(accumulated_labels, dtype=int)
                params, reason = _fit_method(method, train_p, train_y)
                if params is None or not _distinctness_ok(method, params, train_p):
                    used = METHOD_IDENTITY if method != METHOD_IDENTITY else METHOD_IDENTITY
                    for p in fprobs:
                        cal_probs.append(_clamp(p))
                    cal_labels.extend(flabels)
                    per_fold_used.append(CalibFold(idx, used, [], f"fit_skipped:{reason}"))
                else:
                    for p in fprobs:
                        cal_probs.append(_apply_method(method, params, p))
                    cal_labels.extend(flabels)
                    per_fold_used.append(CalibFold(idx, method, list(range(len(fold_oof))), None))
            # Accumulate THIS fold's raw probs + labels for LATER folds.
            accumulated_probs.extend(fprobs)
            accumulated_labels.extend(flabels)
        metrics = model_metrics(cal_probs, cal_labels) if cal_probs else {"n": 0}
        prequential[method] = {
            "metrics": metrics,
            "fold_methods": [
                {"fold_index": cf.fold_index, "method_used": cf.method_used, "reason": cf.reason}
                for cf in per_fold_used
            ],
        }
        if method == ALL_METHODS[0] and idx == test_folds[-1]["fold_index"]:
            pass
    base["prequential"] = prequential

    # ---- Method selection from pre-holdout prequential Brier ----
    # Only deployable methods (JS parity) are eligible for selection. Beta is
    # reported but cannot be selected.
    method_scores: list[tuple[str, float | None]] = []
    for method in ALL_METHODS:
        brier = prequential.get(method, {}).get("metrics", {}).get("brier")
        method_scores.append((method, brier))
    base["method_prequential_brier"] = {m: b for m, b in method_scores}

    deployable_scores = [
        (m, b) for m, b in method_scores if m in DEPLOYABLE_METHODS and b is not None
    ]
    if not deployable_scores:
        return _insufficient(base, ["no_deployable_method_scored"])
    # Lowest Brier wins; identity is the floor (never worse than raw if others fail).
    deployable_scores.sort(key=lambda mb: mb[1])
    selected_method = deployable_scores[0][0]
    base["selected_method"] = selected_method
    base["selection_note"] = (
        "Selected by lowest pre-holdout prequential Brier among JS-parity-capable "
        "methods. Beta is comparison-only (no JS betaincinv parity)."
    )

    # ---- Final proposal calibrator: fit selected method on ALL pre-holdout OOF ----
    holdout_start = holdout_folds[0]["start_date"] if holdout_folds else None
    pre_holdout_rows = [r for r in clean if (r.date_ymd < holdout_start if holdout_start else True)]
    all_probs: list[float] = []
    all_labels: list[int] = []
    for r in pre_holdout_rows:
        raw = _extract_target_prob(r, target_probability)
        if raw is not None and r.home_won is not None:
            all_probs.append(raw)
            all_labels.append(1 if r.home_won else 0)

    if not all_probs:
        return _insufficient(base, ["no_pre_holdout_oof_pairs"])
    base["pre_holdout_oof_pairs"] = len(all_probs)

    train_p = np.array(all_probs, dtype=float)
    train_y = np.array(all_labels, dtype=int)
    final_params, final_reason = _fit_method(selected_method, train_p, train_y)
    if final_params is None:
        # Fall back to identity (never force an unstable map).
        selected_method = METHOD_IDENTITY
        final_params = {}
        base["fallback_to_identity_reason"] = final_reason
    if selected_method != METHOD_IDENTITY and not _distinctness_ok(selected_method, final_params, train_p):
        selected_method = METHOD_IDENTITY
        final_params = {}
        base["fallback_to_identity_reason"] = "final_fit_not_distinct_from_identity"

    base["final_method"] = selected_method
    base["final_params"] = final_params

    # ---- Score the untouched holdout ONCE ----
    holdout_metrics_identity: dict[str, Any] = {"n": 0}
    holdout_metrics_calibrated: dict[str, Any] = {"n": 0}
    if holdout_folds:
        h_start = holdout_folds[0]["start_date"]
        h_end = holdout_folds[0]["end_date"]
        h_rows = [r for r in clean if h_start <= r.date_ymd <= h_end]
        h_raw: list[float] = []
        h_cal: list[float] = []
        h_labels: list[int] = []
        for r in h_rows:
            raw = _extract_target_prob(r, target_probability)
            if raw is not None and r.home_won is not None:
                h_raw.append(_clamp(raw))
                h_cal.append(_apply_method(selected_method, final_params, raw))
                h_labels.append(1 if r.home_won else 0)
        holdout_metrics_identity = model_metrics(h_raw, h_labels) if h_raw else {"n": 0}
        holdout_metrics_calibrated = model_metrics(h_cal, h_labels) if h_cal else {"n": 0}
    base["holdout_metrics_identity"] = holdout_metrics_identity
    base["holdout_metrics_calibrated"] = holdout_metrics_calibrated
    base["holdout_scored_once"] = True

    # ---- Build deployable proposal artifact content ----
    artifact_content: dict[str, Any] = {
        "artifact_manifest_version": OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION,
        "model_id": model_id,
        "cohort": cohort,
        "method": selected_method,
        "target_probability": target_probability,
        "params": final_params,
        "dataset_hash": dataset_hash,
        "training_cutoff": holdout_start,
        "sample_count": len(all_probs),
        "pre_holdout_oof_pairs": len(all_probs),
        "prequential_brier_by_method": base["method_prequential_brier"],
        "selected_prequential_brier": base["method_prequential_brier"].get(selected_method),
        "holdout_metrics_identity": holdout_metrics_identity,
        "holdout_metrics_calibrated": holdout_metrics_calibrated,
        "gates": base["gates"],
        "deployable_methods": list(DEPLOYABLE_METHODS),
    }
    artifact_content["artifact_hash"] = _artifact_hash(artifact_content)

    base["artifact"] = artifact_content
    base["artifact_hash"] = artifact_content["artifact_hash"]
    base["status"] = "trained"
    base["reasons"] = []
    base["recommendation_eligible"] = False  # activation needs separate human approval
    return base


def _extract_target_prob(row: DatasetRow, target: str) -> float | None:
    if target == "raw_home_probability":
        return _norm_prob(row.raw_home_probability)
    if target == "calibrated_home_probability":
        return _norm_prob(row.calibrated_home_probability)
    return _norm_prob(row.raw_home_probability)


def _insufficient(base: dict[str, Any], reasons: list[str]) -> dict[str, Any]:
    base["status"] = "insufficient_data"
    base["reasons"] = reasons
    base["artifact"] = None
    base["artifact_hash"] = None
    base["recommendation_eligible"] = False
    return base


def write_proposal_artifact(report: dict[str, Any], output_dir: str) -> str:
    """Write the PROPOSAL calibration artifact JSON to data/models/.

    NEVER overwrites live V1 calibration files (calibration_maps.json /
    calibration_meta.json / calibration_map.json). Activation requires separate
    human approval.
    """
    os.makedirs(output_dir, exist_ok=True)
    status = report.get("status", "unknown")
    h = report.get("artifact_hash") or "insufficient"
    model_id = report.get("model_id", "heuristic_v1")
    fname = f"{model_id}-oof-calibration-{status}-{h[:12]}.json"
    path = os.path.join(output_dir, fname)
    with open(path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    return path
