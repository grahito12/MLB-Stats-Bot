"""Characterization corpus for src.quality_control.apply_confidence_downgrade.

Each entry is a (prediction, quality_report) input pair fed directly to
apply_confidence_downgrade(). The goldens in moneyline_py_goldens.json were
captured from the PRE-refactor function; the parity suite proves the full
output dict stays byte-identical after apply_confidence_downgrade delegates its
middle block to src.rule_engine.evaluate_moneyline().

The cases exercise every py rule branch and its boundaries in source order:
probable-pitcher missing (NO_BET), opener consideration (adjust-only), the
edge if/elif chain (unavailable / edge<threshold), the data-quality
floor (score<60), the sharp downgrade x2/x1, odds-stale + weather-stale
downgrades, the lineup / pitcher-projected Medium caps, and the score-band cap
elif chain (60-74 -> Low, 75-84 -> Medium, 85+ High-without-calibration ->
Medium). A clean-pass case (LEAN) and a BET-grade case are included so the host
decision-label block (which is NOT part of the engine) is also pinned.
"""

from __future__ import annotations

from typing import Any, Callable

MISSING = "Missing"
PROJECTED = "Projected"
CONFIRMED = "Confirmed"
STALE = "Stale"
FRESH = "Fresh"
AVAILABLE = "Available"


def _report(**overrides: Any) -> dict[str, Any]:
    """A maximal-quality report (score 100, everything confirmed/fresh)."""
    base: dict[str, Any] = {
        "probable_pitchers": CONFIRMED,
        "lineup": CONFIRMED,
        "weather": FRESH,
        "odds": FRESH,
        "bullpen_usage": AVAILABLE,
        "park_factor": AVAILABLE,
        "market_odds": AVAILABLE,
        "injury_news": AVAILABLE,
        "score": 100,
        "missing_fields": [],
        "stale_fields": [],
        "projected_fields": [],
        "opener_situation": "none",
        "no_bet_considerations": [],
        "weather_outdoor": True,
        "calibration_supports_high": True,
        "confidence_adjustments": [],
        "sharp_money_signal": None,
    }
    base.update(overrides)
    return base


def _prediction(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "confidence": "High",
        "model_edge": 0.05,
        "final_lean": "Home Team",
        "market_type": "moneyline",
    }
    base.update(overrides)
    return base


def _sharp(adjustment: str) -> dict[str, Any]:
    return {"confidence_adjustment": adjustment}


CORPUS: dict[str, Callable[[], tuple[dict[str, Any], dict[str, Any]]]] = {
    # --- clean passes / decision-label pins ---------------------------------
    "clean_bet_high_edge": lambda: (
        _prediction(confidence="High", model_edge=0.06),
        _report(),
    ),
    "clean_lean_medium": lambda: (
        _prediction(confidence="Medium", model_edge=0.06),
        _report(),
    ),
    "bet_grade_floor_exactly_005": lambda: (
        _prediction(confidence="High", model_edge=0.05),
        _report(),
    ),
    "lean_high_edge_just_below_bet_floor": lambda: (
        _prediction(confidence="High", model_edge=0.049),
        _report(),
    ),
    # --- probable pitcher missing (NO_BET, order 10) ------------------------
    "probable_pitcher_missing": lambda: (
        _prediction(),
        _report(probable_pitchers=MISSING, score=100),
    ),
    # --- opener consideration (adjust-only, order 15) -----------------------
    "opener_consideration": lambda: (
        _prediction(),
        _report(no_bet_considerations=["opener_situation"]),
    ),
    # --- edge if/elif chain (orders 20/21/22) -------------------------------
    "edge_unavailable": lambda: (
        _prediction(model_edge=None),
        _report(),
    ),
    "edge_below_threshold": lambda: (
        _prediction(model_edge=0.03),
        _report(),
    ),
    "edge_at_threshold_ok": lambda: (
        _prediction(model_edge=0.05),
        _report(),
    ),
    # --- data quality floor (NO_BET, order 30) ------------------------------
    "score_below_60": lambda: (
        _prediction(),
        _report(score=59),
    ),
    "score_at_60_no_floor": lambda: (
        _prediction(),
        _report(score=60),
    ),
    # --- sharp downgrades (order 40) ----------------------------------------
    "sharp_downgrade_two": lambda: (
        _prediction(confidence="High"),
        _report(sharp_money_signal=_sharp("downgrade_two")),
    ),
    "sharp_downgrade_one": lambda: (
        _prediction(confidence="High"),
        _report(sharp_money_signal=_sharp("downgrade_one")),
    ),
    # --- odds stale downgrade (order 50) ------------------------------------
    "odds_stale_downgrade": lambda: (
        _prediction(confidence="High"),
        _report(odds=STALE),
    ),
    # --- weather stale downgrade (order 60) ---------------------------------
    "weather_stale_outdoor": lambda: (
        _prediction(confidence="High"),
        _report(weather=STALE, weather_outdoor=True),
    ),
    "weather_stale_indoor_no_downgrade": lambda: (
        _prediction(confidence="High"),
        _report(weather=STALE, weather_outdoor=False),
    ),
    # --- lineup cap Medium (order 70) ---------------------------------------
    "lineup_projected_cap": lambda: (
        _prediction(confidence="High"),
        _report(lineup=PROJECTED),
    ),
    "lineup_missing_cap": lambda: (
        _prediction(confidence="High"),
        _report(lineup=MISSING),
    ),
    # --- pitcher projected cap Medium (order 80) ----------------------------
    "pitcher_projected_cap": lambda: (
        _prediction(confidence="High"),
        _report(probable_pitchers=PROJECTED),
    ),
    # --- score band cap elif chain (order 90) -------------------------------
    "score_band_60_74_low": lambda: (
        _prediction(confidence="High"),
        _report(score=70),
    ),
    "score_band_75_84_medium": lambda: (
        _prediction(confidence="High"),
        _report(score=80),
    ),
    "score_band_85_high_no_calibration": lambda: (
        _prediction(confidence="High"),
        _report(score=90, calibration_supports_high=False),
    ),
    "score_band_85_high_with_calibration": lambda: (
        _prediction(confidence="High"),
        _report(score=90, calibration_supports_high=True),
    ),
    "score_band_85_medium_no_calibration": lambda: (
        _prediction(confidence="Medium"),
        _report(score=90, calibration_supports_high=False),
    ),
    # --- compounding across handlers in source order ------------------------
    "compound_sharp_then_stale_then_lineup": lambda: (
        _prediction(confidence="High"),
        _report(
            sharp_money_signal=_sharp("downgrade_one"),
            odds=STALE,
            lineup=PROJECTED,
            score=80,
        ),
    ),
    "compound_no_bet_and_caps": lambda: (
        _prediction(confidence="High", model_edge=0.02),
        _report(
            probable_pitchers=PROJECTED,
            lineup=PROJECTED,
            score=70,
            odds=STALE,
        ),
    ),
    "low_confidence_downgrade_floor": lambda: (
        _prediction(confidence="Low"),
        _report(sharp_money_signal=_sharp("downgrade_two")),
    ),
}
