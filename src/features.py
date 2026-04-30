"""Sabermetric feature functions for MLB game prediction."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from statistics import mean
from typing import Any

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


def _as_mapping(item: Any) -> dict[str, Any]:
    if item is None:
        return {}
    if isinstance(item, dict):
        return item
    if is_dataclass(item):
        return asdict(item)
    return {
        key: getattr(item, key)
        for key in dir(item)
        if not key.startswith("_") and not callable(getattr(item, key, None))
    }


def _first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return None


def _parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if value in (None, ""):
        return None

    text = str(value).strip()
    if not text:
        return None

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        pass

    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y%m%d"):
        try:
            return datetime.strptime(text[:10], fmt).date()
        except ValueError:
            continue
    return None


def _game_date(game: Any) -> date | None:
    row = _as_mapping(game)
    return _parse_date(
        _first_present(row, "date", "game_date", "gameDate", "officialDate", "start_date")
    )


def _normalize_id(value: Any) -> str:
    return str(value).strip().lower()


def _id_matches(left: Any, right: Any) -> bool:
    if left in (None, "") or right in (None, ""):
        return False
    return _normalize_id(left) == _normalize_id(right)


def _nested_team(game: dict[str, Any], side: str) -> dict[str, Any]:
    team_entry = (game.get("teams") or {}).get(side) or {}
    team = team_entry.get("team") if isinstance(team_entry, dict) else None
    return team or team_entry if isinstance(team_entry, dict) else {}


def _pitcher_appeared(game: Any, pitcher_id: Any) -> bool:
    row = _as_mapping(game)
    direct_fields = (
        "pitcher_id",
        "player_id",
        "person_id",
        "starter_id",
        "probable_pitcher_id",
        "home_pitcher",
        "away_pitcher",
        "pitcher",
    )
    if any(_id_matches(row.get(field), pitcher_id) for field in direct_fields):
        return True

    for field in ("pitcher_ids", "pitchers", "player_ids", "appearance_pitcher_ids"):
        values = row.get(field)
        if isinstance(values, (list, tuple, set)) and any(_id_matches(value, pitcher_id) for value in values):
            return True

    teams = row.get("teams") or {}
    if isinstance(teams, dict):
        for side in ("away", "home"):
            side_row = teams.get(side) or {}
            pitcher = side_row.get("probablePitcher") or side_row.get("probable_pitcher") or {}
            if isinstance(pitcher, dict) and (
                _id_matches(pitcher.get("id"), pitcher_id)
                or _id_matches(pitcher.get("fullName"), pitcher_id)
                or _id_matches(pitcher.get("name"), pitcher_id)
            ):
                return True
    return False


def _team_side(game: Any, team_id: Any) -> str | None:
    row = _as_mapping(game)
    home_id = _first_present(row, "home_team_id", "home_id", "home_team")
    away_id = _first_present(row, "away_team_id", "away_id", "away_team")

    if _id_matches(home_id, team_id):
        return "home"
    if _id_matches(away_id, team_id):
        return "away"

    teams = row.get("teams") or {}
    if isinstance(teams, dict):
        for side in ("home", "away"):
            team = _nested_team(row, side)
            if (
                _id_matches(team.get("id"), team_id)
                or _id_matches(team.get("name"), team_id)
                or _id_matches(team.get("abbreviation"), team_id)
            ):
                return side
    return None


def _pitcher_rest_multiplier(rest_days: int) -> float:
    if rest_days <= 3:
        return 0.85
    if rest_days >= 6:
        return 0.93
    return 1.0


def get_pitcher_rest_days(
    pitcher_id: str | int,
    game_date: str | date | datetime,
    schedule_data: list[Any] | tuple[Any, ...] | None,
) -> int:
    """Return days since a pitcher's last appearance before the target game.

    Missing schedule history returns 5, which represents normal rest and avoids
    applying an unsupported fatigue or rust penalty.
    """
    target_date = _parse_date(game_date)
    if target_date is None or not schedule_data:
        return 5

    prior_appearances = [
        previous_date
        for game in schedule_data
        if (previous_date := _game_date(game)) is not None
        and previous_date < target_date
        and _pitcher_appeared(game, pitcher_id)
    ]
    if not prior_appearances:
        return 5

    rest_days = max(0, (target_date - max(prior_appearances)).days - 1)
    return rest_days if rest_days <= 30 else 5


def get_team_schedule_fatigue(
    team_id: str | int,
    game_date: str | date | datetime,
    schedule_data: list[Any] | tuple[Any, ...] | None,
) -> dict[str, Any]:
    """Summarize team schedule fatigue from games before the target date."""
    target_date = _parse_date(game_date)
    if target_date is None or not schedule_data:
        return {
            "rest_days": 1,
            "road_streak": 0,
            "recent_game_count": 0,
            "fatigue_level": "low",
            "doubleheader_last_3_days": False,
        }

    team_games: list[tuple[date, str]] = []
    for game in schedule_data:
        played_date = _game_date(game)
        if played_date is None or played_date >= target_date:
            continue
        side = _team_side(game, team_id)
        if side:
            team_games.append((played_date, side))

    if not team_games:
        return {
            "rest_days": 1,
            "road_streak": 0,
            "recent_game_count": 0,
            "fatigue_level": "low",
            "doubleheader_last_3_days": False,
        }

    team_games.sort(key=lambda item: item[0], reverse=True)
    last_game_date = team_games[0][0]
    recent_games = [(played_date, side) for played_date, side in team_games if 0 < (target_date - played_date).days <= 10]
    rest_days = max(0, (target_date - last_game_date).days - 1)
    if not recent_games:
        rest_days = min(rest_days, 10)
    last_three_dates = [
        played_date
        for played_date, _ in team_games
        if 0 < (target_date - played_date).days <= 3
    ]
    doubleheader_last_3_days = any(count >= 2 for count in Counter(last_three_dates).values())

    road_streak = 0
    for _, side in recent_games:
        if side != "away":
            break
        road_streak += 1

    fatigue_points = 0
    if len(recent_games) >= 9:
        fatigue_points += 2
    elif len(recent_games) >= 7:
        fatigue_points += 1
    if doubleheader_last_3_days:
        fatigue_points += 1
    if road_streak >= 7:
        fatigue_points += 2
    elif road_streak >= 4:
        fatigue_points += 1
    if rest_days == 0:
        fatigue_points += 1

    fatigue_level = "high" if fatigue_points >= 3 else "medium" if fatigue_points >= 1 else "low"
    return {
        "rest_days": rest_days,
        "road_streak": road_streak,
        "recent_game_count": len(recent_games),
        "fatigue_level": fatigue_level,
        "doubleheader_last_3_days": doubleheader_last_3_days,
    }


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
