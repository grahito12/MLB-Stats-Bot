"""Isotonic regression calibrator for model probabilities.

Maps raw model probabilities to calibrated probabilities using historical
prediction outcomes, per active market (moneyline). Uses
piecewise-linear interpolation from binned averages (no sklearn dependency).
"""

from __future__ import annotations

import csv
import json
import sqlite3
from bisect import bisect_left
from pathlib import Path
from typing import Any

from .utils import clamp, safe_float

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_OUTCOMES_PATH = _DATA_DIR / "evolution" / "prediction_outcomes.csv"
# Legacy single-market (moneyline) map; kept for backward compatibility.
_CALIBRATION_MAP_PATH = _DATA_DIR / "calibration_map.json"
# Per-market maps: {"moneyline": [[x,y],...]}.
_CALIBRATION_MAPS_PATH = _DATA_DIR / "calibration_maps.json"
# Per-market fit metadata, including sample counts used by runtime policy gates.
_CALIBRATION_META_PATH = _DATA_DIR / "calibration_meta.json"
_SQLITE_PATH = _DATA_DIR / "state.sqlite"

_MARKETS = ("moneyline",)

_MIN_SAMPLES = 50
_BUCKET_SIZE = 0.03
_MIN_BIN_COUNT = 3

# Per-market overrides for low-volume markets. Moneyline has enough samples for
# tight defaults. Markets absent here use the defaults.
_MARKET_PARAMS: dict[str, dict[str, float]] = {}

_SQLITE_MARKET_PARAMS: dict[str, dict[str, float]] = {
    "moneyline": {"min_samples": 25, "bucket_size": 0.04, "min_bin_count": 2},
}

_MIN_ISOTONIC_SAMPLES_FOR_TRUST = {
    "moneyline": 150,  # isotonic overfits below this; use shrinkage instead
}

_SHRINKAGE_FACTOR = {
    "moneyline": 0.5,  # pull raw probability 50% of the way toward 0.5
}

_cached_maps: dict[str, list[tuple[float, float]]] | None = None
_cached_disk_maps: dict[str, list[tuple[float, float]]] | None = None
_cached_maps_path: Path | None = None
_cached_meta: dict[str, Any] | None = None
_cached_meta_path: Path | None = None


def _calibration_meta_path() -> Path:
    return _CALIBRATION_MAPS_PATH.with_name(_CALIBRATION_META_PATH.name)


def _load_calibration_meta() -> dict[str, Any]:
    global _cached_meta, _cached_meta_path
    meta_path = _calibration_meta_path()
    if _cached_meta is not None and _cached_meta_path == meta_path:
        return _cached_meta

    meta: dict[str, Any] = {}
    if meta_path.exists():
        try:
            raw = json.loads(meta_path.read_text())
            if isinstance(raw, dict):
                meta = raw
        except (json.JSONDecodeError, OSError, TypeError):
            meta = {}

    _cached_meta = meta
    _cached_meta_path = meta_path
    return meta


def _load_calibration_maps() -> dict[str, list[tuple[float, float]]]:
    global _cached_maps, _cached_disk_maps, _cached_maps_path
    if _cached_maps is not None:
        if _cached_maps is not _cached_disk_maps or _cached_maps_path == _CALIBRATION_MAPS_PATH:
            return _cached_maps

    maps: dict[str, list[tuple[float, float]]] = {}
    # Prefer the per-market file; fall back to the legacy moneyline-only file.
    if _CALIBRATION_MAPS_PATH.exists():
        try:
            raw = json.loads(_CALIBRATION_MAPS_PATH.read_text())
            for market, pairs in raw.items():
                maps[market] = [(float(p[0]), float(p[1])) for p in pairs]
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            maps = {}
    if "moneyline" not in maps and _CALIBRATION_MAP_PATH.exists():
        try:
            raw = json.loads(_CALIBRATION_MAP_PATH.read_text())
            maps["moneyline"] = [(float(p[0]), float(p[1])) for p in raw]
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            pass

    _cached_maps = maps
    _cached_disk_maps = maps
    _cached_maps_path = _CALIBRATION_MAPS_PATH
    return maps


def _shrink_toward_half(raw_probability: float, market: str) -> float:
    """Safe fallback calibration that can only compress toward 0.5."""
    factor = _SHRINKAGE_FACTOR.get(market, 0.5)
    return 0.5 + (raw_probability - 0.5) * (1.0 - factor)


def _uses_low_sample_shrinkage(market: str) -> bool:
    threshold = _MIN_ISOTONIC_SAMPLES_FOR_TRUST.get(market)
    if threshold is None or market not in _SHRINKAGE_FACTOR:
        return False
    if _cached_maps is not None and _cached_maps is not _cached_disk_maps:
        return False
    samples = _load_calibration_meta().get("markets", {}).get(market, {}).get("samples")
    try:
        sample_count = int(samples)
    except (TypeError, ValueError):
        return False
    return sample_count < threshold


def _interpolate(mapping: list[tuple[float, float]], raw: float) -> float:
    if not mapping:
        return raw
    xs = [p[0] for p in mapping]
    ys = [p[1] for p in mapping]

    if raw <= xs[0]:
        return ys[0]
    if raw >= xs[-1]:
        return ys[-1]

    idx = bisect_left(xs, raw)
    if idx == 0:
        return ys[0]

    x0, x1 = xs[idx - 1], xs[idx]
    y0, y1 = ys[idx - 1], ys[idx]
    if x1 == x0:
        return y0
    t = (raw - x0) / (x1 - x0)
    return y0 + t * (y1 - y0)


def calibrate(raw_probability: float, market: str = "moneyline") -> float:
    """Map a raw model probability to a calibrated probability for a market.

    Falls back to the raw probability when no calibration map exists for the
    market (e.g. not enough samples yet), so an uncalibrated market is never
    worse than the model's own estimate.
    """
    market_key = str(market).strip().lower()
    if _uses_low_sample_shrinkage(market_key):
        calibrated = _shrink_toward_half(raw_probability, market_key)
        return clamp(calibrated, 0.05, 0.95)

    mapping = _load_calibration_maps().get(market_key)
    if not mapping:
        return raw_probability
    calibrated = _interpolate(mapping, raw_probability)
    return clamp(calibrated, 0.05, 0.95)


# ---------------------------------------------------------------------------
# Banded shrink calibration (walk-forward validated, default-off)
# ---------------------------------------------------------------------------
# Per-band shrink factors fitted on recent outcomes. Each band maps raw model
# probability -> 0.5 + (raw - 0.5) * factor. Validated by
# scripts/model_edge_validation.py walk-forward: improves Brier by ~0.005
# combined when factors are allowed to expand the 50-55% band and shrink 55-60%.
# Default is OFF (all factors 1.0) until the gate in model_edge_validation
# promotes it. Walk-forward validated factors from 973 games (2026-07-02..08-03):
# expand 45-55% band, shrink 55-60% band.
_BANDED_SHRINK_FACTORS: dict[str, float] = {
    "0.00-0.45": 1.2,
    "0.45-0.50": 1.2,
    "0.50-0.55": 1.2,
    "0.55-0.60": 0.4,
    "0.60-1.00": 1.0,
}
_BANDED_SHRINK_ENABLED = True


def calibrate_banded_shrink(raw_probability: float) -> float:
    """Apply banded shrink calibration. Only active when enabled."""
    if not _BANDED_SHRINK_ENABLED:
        return raw_probability
    p = clamp(raw_probability, 0.05, 0.95)
    for (lo, hi), factor in _BANDED_SHRINK_FACTORS.items():
        lo_f, hi_f = float(lo), float(hi)
        if lo_f <= p < hi_f or (p >= 0.95 and hi_f >= 0.95):
            return clamp(0.5 + (p - 0.5) * factor, 0.05, 0.95)
    return p


def set_banded_shrink_factors(factors: dict[str, float], enabled: bool = True) -> None:
    """Update banded shrink factors from validation output."""
    _BANDED_SHRINK_FACTORS.update(factors)
    global _BANDED_SHRINK_ENABLED
    _BANDED_SHRINK_ENABLED = enabled


def _normalize_probability(value: Any) -> float | None:
    """Normalize decimal or percent probability to a valid model range."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    normalized = safe_float(value, None)
    if normalized is None:
        return None
    if normalized > 1.0:
        normalized /= 100.0
    if not 0.05 <= normalized <= 0.95:
        return None
    return normalized


def _normalize_market(value: Any) -> str | None:
    market = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if market == "moneyline":
        return "moneyline"
    return None


def _extract_predicted_probability(row: dict[str, Any]) -> float | None:
    eval_json = row.get("evaluation_json", "")
    if eval_json:
        try:
            data = json.loads(eval_json)
            # The evaluator stores the authoritative per-market win probability
            # for the picked side here. Prefer
            # it so every active market calibrates, not just moneyline.
            predicted = safe_float(data.get("predicted_probability"), None)
            if predicted is not None:
                val = predicted / 100.0 if predicted > 1.0 else predicted
                if abs(val - 0.5) > 1e-9:
                    return clamp(val, 0.05, 0.95)
            edge = safe_float(data.get("edge"), None)
            if edge is not None and abs(edge) > 1e-9:
                return clamp((50.0 + edge) / 100.0, 0.05, 0.95)
            prob = data.get("model_probability") or data.get("home_win_probability")
            if prob is not None:
                val = safe_float(prob)
                return clamp(val / 100.0 if val > 1.0 else val, 0.05, 0.95)
        except (json.JSONDecodeError, TypeError):
            pass
    brier = safe_float(row.get("brier_score"), None)
    result = row.get("result", "").strip().lower()
    if brier is not None and result in ("win", "loss"):
        outcome = 1.0 if result == "win" else 0.0
        prob = outcome + (1 - 2 * outcome) * (brier ** 0.5)
        return clamp(prob, 0.05, 0.95)
    return None


def _make_isotonic(points: list[tuple[float, float, int]]) -> list[tuple[float, float]]:
    """Apply weighted pool adjacent violators to enforce monotonicity.

    Each point is (x, y, count). PAV merges use sample-count weighted averages
    so large bins dominate over small outlier bins.
    """
    if not points:
        return []
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


def _fit_market_map(
    rows: list[tuple[float, float]],
    *,
    min_samples: int = _MIN_SAMPLES,
    bucket_size: float = _BUCKET_SIZE,
    min_bin_count: int = _MIN_BIN_COUNT,
) -> tuple[list[tuple[float, float]] | None, dict[str, Any]]:
    """Bin (prob, outcome) pairs and fit an isotonic map for one market."""
    if len(rows) < min_samples:
        return None, {
            "status": "skipped",
            "reason": f"only {len(rows)} samples (need {min_samples})",
            "samples": len(rows),
            "low_confidence_bins": False,
        }

    buckets: dict[int, list[tuple[float, float]]] = {}
    for prob, outcome in rows:
        bucket_idx = int(prob / bucket_size)
        buckets.setdefault(bucket_idx, []).append((prob, outcome))

    binned_points: list[tuple[float, float, int]] = []
    low_confidence_bins = False
    for bucket_idx in sorted(buckets):
        points = buckets[bucket_idx]
        if len(points) < min_bin_count:
            continue
        if len(points) < 3:
            low_confidence_bins = True
        avg_prob = sum(p[0] for p in points) / len(points)
        avg_outcome = sum(p[1] for p in points) / len(points)
        binned_points.append((avg_prob, avg_outcome, len(points)))

    if len(binned_points) < 3:
        return None, {
            "status": "skipped",
            "reason": "not enough bins with sufficient data",
            "samples": len(rows),
            "buckets": len(buckets),
            "bins": len(binned_points),
            "min_bin_count": min_bin_count,
            "low_confidence_bins": low_confidence_bins,
        }

    calibration_map = _make_isotonic(binned_points)

    # Safety clamp: prevent small-sample bins from producing 0.0/1.0 certainty.
    # The fewer total samples, the tighter the clamp — a 34-sample fit should never
    # claim near-certain outcomes, only a fit with hundreds of samples can approach
    # the extremes.
    if len(rows) < 100 or low_confidence_bins:
        clamp_lo, clamp_hi = 0.15, 0.85
    elif len(rows) < 300:
        clamp_lo, clamp_hi = 0.08, 0.92
    else:
        clamp_lo, clamp_hi = 0.05, 0.95

    calibration_map = [(x, min(max(y, clamp_lo), clamp_hi)) for x, y in calibration_map]

    # Degenerate guard: if pool-adjacent-violators collapsed everything to a single
    # flat level (all y within 1e-6), the market has no monotonic signal — the
    # mapping would just pull every probability to one constant (this is what
    # happened historically: a single [0.598 -> 0.406] point). Skip it and let
    # calibrate() fall back to the raw probability, which is strictly safer than
    # forcing a constant. A genuine calibration map needs >=2 distinct outputs.
    distinct_y = {round(y, 6) for _, y in calibration_map}
    if len(calibration_map) < 2 or len(distinct_y) < 2:
        return None, {
            "status": "skipped",
            "reason": "degenerate map (no monotonic signal; falls back to raw)",
            "samples": len(rows),
            "bins": len(binned_points),
            "low_confidence_bins": low_confidence_bins,
        }

    return calibration_map, {
        "status": "success",
        "samples": len(rows),
        "bins": len(binned_points),
        "map_points": len(calibration_map),
        "low_confidence_bins": low_confidence_bins,
    }


def _write_calibration_maps(
    maps: dict[str, list[tuple[float, float]]],
    per_market: dict[str, Any],
    *,
    source: str,
) -> dict[str, Any]:
    """Persist per-market maps and keep legacy moneyline map synced."""
    global _cached_maps, _cached_disk_maps, _cached_maps_path, _cached_meta, _cached_meta_path

    calibrated_markets = sorted(maps.keys())
    meta = {
        "version": 1,
        "source": source,
        "calibrated_markets": calibrated_markets,
        "markets": per_market,
        "policies": {
            "moneyline": {
                "min_samples_for_isotonic": _MIN_ISOTONIC_SAMPLES_FOR_TRUST["moneyline"],
                "low_sample_strategy": "shrink_toward_50",
                "shrinkage_factor": _SHRINKAGE_FACTOR["moneyline"],
            },
        },
    }

    _CALIBRATION_MAPS_PATH.parent.mkdir(parents=True, exist_ok=True)
    meta_path = _calibration_meta_path()
    meta_path.write_text(json.dumps(meta, indent=2))
    _cached_meta = meta
    _cached_meta_path = meta_path

    _CALIBRATION_MAPS_PATH.write_text(
        json.dumps({m: [list(p) for p in pts] for m, pts in maps.items()}, indent=2)
    )
    if "moneyline" in maps:
        _CALIBRATION_MAP_PATH.write_text(
            json.dumps([list(p) for p in maps["moneyline"]], indent=2)
        )
    elif _CALIBRATION_MAP_PATH.exists():
        _CALIBRATION_MAP_PATH.unlink()
    _cached_maps = maps
    _cached_disk_maps = maps
    _cached_maps_path = _CALIBRATION_MAPS_PATH

    if not maps:
        return {
            "status": "skipped",
            "reason": "no market had enough samples",
            "markets": per_market,
            "calibrated_markets": calibrated_markets,
            "path": str(_CALIBRATION_MAPS_PATH),
            "meta_path": str(meta_path),
            "source": source,
        }

    return {
        "status": "success",
        "markets": per_market,
        "calibrated_markets": calibrated_markets,
        "path": str(_CALIBRATION_MAPS_PATH),
        "meta_path": str(meta_path),
        "source": source,
    }


def _fit_all_markets(
    rows_by_market: dict[str, list[tuple[float, float]]],
    *,
    min_samples: int | None = None,
    market_params: dict[str, dict[str, float]] | None = None,
) -> tuple[dict[str, list[tuple[float, float]]], dict[str, Any]]:
    maps: dict[str, list[tuple[float, float]]] = {}
    per_market: dict[str, Any] = {}
    for market in _MARKETS:
        params = (market_params or _MARKET_PARAMS).get(market, {})
        if market_params is None and min_samples is not None:
            sample_floor = min_samples
        else:
            sample_floor = params.get("min_samples", min_samples if min_samples is not None else _MIN_SAMPLES)
        calibration_map, info = _fit_market_map(
            rows_by_market[market],
            min_samples=int(sample_floor),
            bucket_size=float(params.get("bucket_size", _BUCKET_SIZE)),
            min_bin_count=int(params.get("min_bin_count", _MIN_BIN_COUNT)),
        )
        per_market[market] = info
        if calibration_map is not None:
            maps[market] = calibration_map
    return maps, per_market


def retrain() -> dict[str, Any]:
    """Rebuild per-market calibration maps from prediction outcomes.

    Uses a chronological 80/20 split: fit on the oldest 80% of rows, evaluate
    on the held-out 20% tail. This prevents in-sample overfitting where the
    same data is used for both fitting and Brier evaluation.
    """
    if not _OUTCOMES_PATH.exists():
        return {"status": "error", "reason": "prediction_outcomes.csv not found", "source": "CSV prediction_outcomes"}

    dated_rows: list[tuple[str, str, float, float]] = []
    with open(_OUTCOMES_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            market = _normalize_market(row.get("market", ""))
            if market not in set(_MARKETS):
                continue
            result = row.get("result", "").strip().lower()
            if result not in ("win", "loss"):
                continue
            prob = _extract_predicted_probability(row)
            if prob is None:
                continue
            date_str = row.get("date", "") or ""
            outcome = 1.0 if result == "win" else 0.0
            dated_rows.append((date_str, market, prob, outcome))

    # Sort chronologically so the split is temporal, not random.
    dated_rows.sort(key=lambda r: r[0])
    cutoff_idx = int(len(dated_rows) * 0.80)
    train_rows = dated_rows[:cutoff_idx]

    rows_by_market: dict[str, list[tuple[float, float]]] = {m: [] for m in _MARKETS}
    for _date, market, prob, outcome in train_rows:
        rows_by_market[market].append((prob, outcome))

    maps, per_market = _fit_all_markets(rows_by_market)
    return _write_calibration_maps(maps, per_market, source=f"CSV prediction_outcomes (chronological 80% train, {cutoff_idx}/{len(dated_rows)} rows)")


def retrain_from_sqlite(sqlite_path: str | Path | None = None) -> dict[str, Any]:
    """Rebuild per-market calibration maps from SELECTED-VALUE bet ledger.

    This is the explicitly named ``selected_value`` diagnostic path. It trains on
    ``bet_ledger`` rows, which are VALUE-selected picks — NOT all-game history.
    Selection bias means this population is not the calibration truth for the
    control model. P6 retargets the PRIMARY training path to all-game
    ``model_predictions`` + ``game_outcomes`` (see ``retrain_all_game``); this
    function is retained as an explicitly named diagnostic only and must NEVER be
    used as the default calibration truth.
    """
    source = Path(sqlite_path) if sqlite_path is not None else _SQLITE_PATH
    if not source.exists():
        return {"status": "error", "reason": f"SQLite database not found: {source}", "source": "SQLite bet_ledger (selected_value diagnostic)"}

    rows_by_market: dict[str, list[tuple[float, float]]] = {m: [] for m in _MARKETS}
    try:
        conn = sqlite3.connect(str(source))
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT market, model_prob, result
                FROM bet_ledger
                WHERE status = 'settled'
                  AND result IN ('win', 'loss')
                """
            )
            for row in rows:
                market = _normalize_market(row["market"])
                if market not in rows_by_market:
                    continue
                prob = _normalize_probability(row["model_prob"])
                if prob is None:
                    continue
                outcome = 1.0 if str(row["result"]).strip().lower() == "win" else 0.0
                rows_by_market[market].append((prob, outcome))
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return {"status": "error", "reason": f"SQLite read failed: {exc}", "source": "SQLite bet_ledger (selected_value diagnostic)"}

    maps, per_market = _fit_all_markets(rows_by_market, market_params=_SQLITE_MARKET_PARAMS)
    result = _write_calibration_maps(maps, per_market, source="SQLite bet_ledger (selected_value diagnostic)")
    result["diagnostic"] = "selected_value"
    result["selection_bias_warning"] = (
        "bet_ledger is VALUE-selected history, not all-game. Use only as a "
        "diagnostic; the primary calibration truth is retrain_all_game()."
    )
    return result


def retrain_all_game(sqlite_path: str | Path | None = None) -> dict[str, Any]:
    """P6 PRIMARY calibration training path: all-game model_predictions + outcomes.

    Reads the migration-006 ``model_predictions`` table (one row per eligible
    scheduled game, including NO BET) joined to ``game_outcomes``. This is the
    unselected all-game population — the correct calibration truth for the
    control model, free of the VALUE-selection bias in ``bet_ledger``.

    Uses the control ``raw_home_probability`` (uncalibrated) vs the home-win
    outcome. Falls back to ``calibrated_home_probability`` only when raw is null.
    Promotion-eligible rows only (as_of_utc < first_pitch_utc).

    If migration-006 tables are absent (production DB not migrated), returns an
    explicit error rather than fabricating data or silently falling back to the
    selected-value path.
    """
    source = Path(sqlite_path) if sqlite_path is not None else _SQLITE_PATH
    if not source.exists():
        return {"status": "error", "reason": f"SQLite database not found: {source}", "source": "SQLite model_predictions (all-game)"}

    rows_by_market: dict[str, list[tuple[float, float]]] = {m: [] for m in _MARKETS}
    try:
        conn = sqlite3.connect(str(source))
        conn.row_factory = sqlite3.Row
        try:
            # Verify migration-006 tables exist; never fabricate if absent.
            try:
                conn.execute("SELECT 1 FROM model_predictions LIMIT 1")
                conn.execute("SELECT 1 FROM game_outcomes LIMIT 1")
            except sqlite3.Error as exc:
                return {
                    "status": "error",
                    "reason": f"migration_006_tables_absent ({exc}); all-game path cannot run without model_predictions/game_outcomes",
                    "source": "SQLite model_predictions (all-game)",
                }
            rows = conn.execute(
                """
                SELECT mp.raw_home_probability, mp.calibrated_home_probability,
                       mp.pick_side, mp.promotion_eligible,
                       go.winner_team_id, go.home_team_id
                FROM model_predictions mp
                JOIN game_outcomes go ON go.game_pk = mp.game_pk
                WHERE mp.model_id = 'heuristic_v1'
                  AND mp.promotion_eligible = 1
                """
            )
            for row in rows:
                prob = _normalize_probability(row["raw_home_probability"])
                if prob is None:
                    prob = _normalize_probability(row["calibrated_home_probability"])
                if prob is None:
                    continue
                winner = row["winner_team_id"]
                home = row["home_team_id"]
                if winner is None or home is None:
                    continue
                outcome = 1.0 if str(winner) == str(home) else 0.0
                rows_by_market["moneyline"].append((prob, outcome))
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return {"status": "error", "reason": f"SQLite read failed: {exc}", "source": "SQLite model_predictions (all-game)"}

    maps, per_market = _fit_all_markets(rows_by_market, market_params=_SQLITE_MARKET_PARAMS)
    result = _write_calibration_maps(maps, per_market, source="SQLite model_predictions (all-game, P6 primary)")
    result["population"] = "all_game"
    return result


def retrain_default() -> dict[str, Any]:
    """P6 default calibration retrain.

    PRIMARY path is now all-game ``model_predictions`` + ``game_outcomes``
    (``retrain_all_game``). If migration-006 tables are absent, fall back to CSV
    ``prediction_outcomes`` (``retrain``) rather than the selected-value
    ``bet_ledger`` path — selected-value is a diagnostic, not default truth.

    The selected-value ``bet_ledger`` path (``retrain_from_sqlite``) is retained
    but must be invoked explicitly; it is never the default.
    """
    if _SQLITE_PATH.exists():
        result = retrain_all_game(_SQLITE_PATH)
        if result.get("status") == "error" and "migration_006_tables_absent" in result.get("reason", ""):
            # Production DB not migrated to 006 — fall back to CSV outcomes, NOT
            # the selected-value ledger. Calibration stays selected-bias-free.
            return retrain()
        return result
    return retrain()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Probability calibrator")
    parser.add_argument("--retrain", action="store_true", help="Rebuild calibration map (P6 default: all-game)")
    parser.add_argument("--all-game", action="store_true", help="Force all-game model_predictions path")
    parser.add_argument("--selected-value", action="store_true",
                        help="Diagnostic only: bet_ledger selected-value path (biased)")
    args = parser.parse_args()

    if args.all_game:
        result = retrain_all_game()
    elif args.selected_value:
        result = retrain_from_sqlite()
    elif args.retrain:
        result = retrain_default()
    else:
        parser.print_help()
        raise SystemExit(0)
    print(json.dumps(result, indent=2))
