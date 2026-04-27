"""Betting odds helpers for optional market comparison."""

from __future__ import annotations

from .utils import safe_float


def american_odds_to_implied_probability(odds: float | int | str) -> float:
    """Convert American odds to implied probability."""
    value = safe_float(odds)
    if value == 0:
        raise ValueError("American odds cannot be 0.")
    if value > 0:
        return 100.0 / (value + 100.0)
    return abs(value) / (abs(value) + 100.0)


def decimal_odds_to_implied_probability(odds: float | int | str) -> float:
    """Convert decimal odds to implied probability."""
    value = safe_float(odds)
    if value <= 1.0:
        raise ValueError("Decimal odds must be greater than 1.0.")
    return 1.0 / value


def calculate_edge(model_probability: float, market_probability: float) -> float:
    """Return model probability minus market implied probability."""
    return safe_float(model_probability) - safe_float(market_probability)
