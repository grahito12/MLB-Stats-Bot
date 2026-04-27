"""Sabermetric feature functions for MLB game prediction."""

from __future__ import annotations

from statistics import mean

from .utils import clamp, safe_float, safe_int


def pythagorean_win_pct(
    runs_scored: float | int | str | None,
    runs_allowed: float | int | str | None,
    exponent: float = 1.83,
) -> float:
    """Estimate team strength from runs scored and allowed.

    Formula: RS^exponent / (RS^exponent + RA^exponent).
    """
    rs = max(0.0, safe_float(runs_scored, 0.0))
    ra = max(0.0, safe_float(runs_allowed, 0.0))
    if rs == 0 and ra == 0:
        return 0.5

    rs_power = rs**exponent
    ra_power = ra**exponent
    denominator = rs_power + ra_power
    if denominator <= 0:
        return 0.5
    return clamp(rs_power / denominator, 0.0, 1.0)


def log5_probability(p_a: float, p_b: float) -> float:
    """Calculate Bill James Log5 probability for Team A beating Team B."""
    a = clamp(safe_float(p_a, 0.5), 0.001, 0.999)
    b = clamp(safe_float(p_b, 0.5), 0.001, 0.999)
    denominator = a + b - 2 * a * b
    if abs(denominator) < 1e-9:
        return 0.5
    return clamp((a - a * b) / denominator, 0.0, 1.0)


def normalize_stat(
    value: float | int | str | None,
    league_avg: float,
    higher_is_better: bool = True,
) -> float:
    """Normalize a stat around league average into an approximate -1..1 score."""
    parsed = safe_float(value, league_avg)
    average = max(abs(safe_float(league_avg, 1.0)), 1e-9)
    if parsed <= 0 and not higher_is_better:
        return 0.0

    ratio = parsed / average if higher_is_better else average / max(parsed, 1e-9)
    return clamp((ratio - 1.0) * 2.0, -1.0, 1.0)


def _average_available(values: list[float]) -> float:
    usable = [value for value in values if value is not None]
    return mean(usable) if usable else 0.0


def pitcher_score(
    era: float | int | str | None,
    whip: float | int | str | None,
    fip: float | int | str | None = None,
    k_bb_ratio: float | int | str | None = None,
) -> float:
    """Score starting pitcher strength using run prevention and command."""
    scores = [
        normalize_stat(era, 4.20, higher_is_better=False),
        normalize_stat(whip, 1.30, higher_is_better=False),
    ]
    if fip is not None:
        scores.append(normalize_stat(fip, 4.20, higher_is_better=False))
    if k_bb_ratio is not None:
        scores.append(normalize_stat(k_bb_ratio, 2.70, higher_is_better=True))
    return clamp(_average_available(scores), -1.0, 1.0)


def offense_score(
    ops: float | int | str | None = None,
    wrc_plus: float | int | str | None = None,
    runs_per_game: float | int | str | None = None,
) -> float:
    """Score offense with OPS, wRC+, and runs per game when available."""
    scores: list[float] = []
    if ops is not None:
        scores.append(normalize_stat(ops, 0.720, higher_is_better=True))
    if wrc_plus is not None:
        scores.append(normalize_stat(wrc_plus, 100.0, higher_is_better=True))
    if runs_per_game is not None:
        scores.append(normalize_stat(runs_per_game, 4.40, higher_is_better=True))
    return clamp(_average_available(scores), -1.0, 1.0)


def bullpen_score(
    bullpen_era: float | int | str | None = None,
    bullpen_whip: float | int | str | None = None,
    recent_usage: float | int | str | None = None,
) -> float:
    """Score bullpen quality, penalizing tired or heavily used bullpens."""
    scores: list[float] = []
    if bullpen_era is not None:
        scores.append(normalize_stat(bullpen_era, 4.10, higher_is_better=False))
    if bullpen_whip is not None:
        scores.append(normalize_stat(bullpen_whip, 1.30, higher_is_better=False))
    if recent_usage is not None:
        scores.append(normalize_stat(recent_usage, 0.50, higher_is_better=False))
    return clamp(_average_available(scores), -1.0, 1.0)


def recent_form_score(
    wins_last_n: int | str | None,
    games_n: int | str | None,
    run_diff_last_n: float | int | str | None,
) -> float:
    """Score recent form from recent win rate and run differential."""
    games = max(0, safe_int(games_n, 0))
    if games == 0:
        return 0.0

    wins = clamp(safe_int(wins_last_n, 0), 0, games)
    win_rate_score = (wins / games - 0.5) * 2.0
    run_diff_per_game = safe_float(run_diff_last_n, 0.0) / games
    run_diff_score = clamp(run_diff_per_game / 2.5, -1.0, 1.0)
    return clamp(win_rate_score * 0.6 + run_diff_score * 0.4, -1.0, 1.0)


def home_field_adjustment(home_team: bool = True) -> float:
    """Return a normalized home-field feature used by the weighted model."""
    return 1.0 if home_team else 0.0
