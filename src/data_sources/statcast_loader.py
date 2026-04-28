"""Baseball Savant / Statcast CSV loader and summary helpers."""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from statistics import mean
from typing import Any

from ..utils import data_path, safe_float
from .cache import read_csv_records

STATCAST_CORE_FIELDS = (
    "game_date",
    "player_name",
    "batter",
    "pitcher",
    "events",
    "description",
    "pitch_type",
    "release_speed",
    "pfx_x",
    "pfx_z",
    "launch_speed",
    "launch_angle",
    "estimated_woba_using_speedangle",
    "estimated_ba_using_speedangle",
    "estimated_slg_using_speedangle",
    "woba_value",
    "barrel",
)


def load_statcast_csv(path: str | Path | None = None) -> list[dict[str, str]]:
    """Load local Baseball Savant / Statcast CSV rows."""
    source = Path(path) if path else data_path("sample_statcast.csv")
    return read_csv_records(source)


def _number_values(rows: list[dict[str, str]], field: str) -> list[float]:
    values = [safe_float(row.get(field), float("nan")) for row in rows]
    return [value for value in values if value == value]


def _mean_field(rows: list[dict[str, str]], field: str) -> float:
    values = _number_values(rows, field)
    return mean(values) if values else 0.0


def _barrel_like(row: dict[str, str]) -> bool:
    barrel_value = str(row.get("barrel", "")).strip().lower()
    if barrel_value in {"1", "true", "yes"}:
        return True
    exit_velocity = safe_float(row.get("launch_speed"), 0.0)
    launch_angle = safe_float(row.get("launch_angle"), -99.0)
    return exit_velocity >= 98.0 and 26.0 <= launch_angle <= 30.0


def filter_statcast_rows(
    rows: list[dict[str, str]],
    *,
    batter_id: str | int | None = None,
    pitcher_id: str | int | None = None,
    before_date: str | None = None,
) -> list[dict[str, str]]:
    """Filter Statcast rows without using future data."""
    filtered = rows
    if batter_id is not None:
        filtered = [row for row in filtered if str(row.get("batter")) == str(batter_id)]
    if pitcher_id is not None:
        filtered = [row for row in filtered if str(row.get("pitcher")) == str(pitcher_id)]
    if before_date:
        filtered = [row for row in filtered if str(row.get("game_date", "")) < before_date]
    return filtered


def summarize_statcast(rows: list[dict[str, str]]) -> dict[str, Any]:
    """Summarize pitch-level and batted-ball Statcast rows."""
    batted_ball_rows = [row for row in rows if row.get("launch_speed")]
    hard_hit_count = sum(safe_float(row.get("launch_speed"), 0.0) >= 95.0 for row in batted_ball_rows)
    barrel_count = sum(_barrel_like(row) for row in batted_ball_rows)
    pitch_types = Counter(row.get("pitch_type", "UNK") or "UNK" for row in rows)
    total_batted = len(batted_ball_rows)

    return {
        "pitches": len(rows),
        "batted_balls": total_batted,
        "avg_exit_velocity": _mean_field(batted_ball_rows, "launch_speed"),
        "avg_launch_angle": _mean_field(batted_ball_rows, "launch_angle"),
        "xwoba": _mean_field(rows, "estimated_woba_using_speedangle"),
        "xba": _mean_field(rows, "estimated_ba_using_speedangle"),
        "xslg": _mean_field(rows, "estimated_slg_using_speedangle"),
        "hard_hit_rate": hard_hit_count / total_batted if total_batted else 0.0,
        "barrel_rate": barrel_count / total_batted if total_batted else 0.0,
        "pitch_type_mix": dict(pitch_types),
        "avg_pitch_velocity": _mean_field(rows, "release_speed"),
        "avg_horizontal_movement": _mean_field(rows, "pfx_x"),
        "avg_vertical_movement": _mean_field(rows, "pfx_z"),
    }
