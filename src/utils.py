"""Shared utilities for the Python MLB prediction engine."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"


def safe_float(value: Any, default: float = 0.0) -> float:
    """Convert a value to float while tolerating blanks and invalid input."""
    if value is None:
        return default
    if isinstance(value, str) and not value.strip():
        return default
    try:
        result = float(str(value).replace("%", "").strip())
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def safe_int(value: Any, default: int = 0) -> int:
    """Convert a value to int safely."""
    return int(round(safe_float(value, float(default))))


def clamp(value: float, lower: float, upper: float) -> float:
    """Clamp a numeric value to a bounded range."""
    return min(upper, max(lower, value))


def logistic(value: float) -> float:
    """Convert a rating difference to probability with a logistic curve."""
    if value >= 35:
        return 1.0
    if value <= -35:
        return 0.0
    return 1.0 / (1.0 + math.exp(-value))


def probability_to_logit(probability: float) -> float:
    """Convert probability to log-odds, safely clipped away from 0 and 1."""
    clipped = clamp(probability, 0.001, 0.999)
    return math.log(clipped / (1.0 - clipped))


def data_path(filename: str) -> Path:
    """Return a path inside the project data directory."""
    return DATA_DIR / filename


def clean_name(value: str) -> str:
    """Normalize a team or player name for case-insensitive lookup."""
    return " ".join(str(value).strip().lower().split())


def format_probability(probability: float) -> str:
    """Format a decimal probability as a percentage."""
    return f"{probability * 100:.1f}%"


def confidence_label(probability: float) -> str:
    """Map a win probability to a simple confidence bucket."""
    edge = abs(probability - 0.5)
    if edge < 0.04:
        return "Low"
    if edge < 0.10:
        return "Medium"
    return "High"
