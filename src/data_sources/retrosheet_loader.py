"""Retrosheet local CSV loaders for historical game logs and play-by-play."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..utils import clean_name, data_path, safe_int
from .cache import read_csv_records


@dataclass(frozen=True)
class RetrosheetGame:
    """Minimal game-log row used for historical form and backtesting."""

    date: str
    home_team: str
    away_team: str
    home_score: int
    away_score: int
    game_id: str = ""

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "RetrosheetGame":
        return cls(
            date=str(row.get("date") or row.get("Date") or ""),
            game_id=str(row.get("game_id") or row.get("GAME_ID") or ""),
            home_team=str(row.get("home_team") or row.get("home") or row.get("Home") or ""),
            away_team=str(row.get("away_team") or row.get("away") or row.get("Away") or ""),
            home_score=safe_int(row.get("home_score") or row.get("home_runs") or row.get("HomeScore")),
            away_score=safe_int(row.get("away_score") or row.get("away_runs") or row.get("AwayScore")),
        )


def load_game_logs(path: str | Path | None = None) -> list[RetrosheetGame]:
    """Load local Retrosheet-style game logs.

    Local CSV support is the default to avoid scraping or repeated downloads.
    """
    source = Path(path) if path else data_path("sample_retrosheet_games.csv")
    return [RetrosheetGame.from_row(row) for row in read_csv_records(source)]


def load_play_by_play(path: str | Path) -> list[dict[str, str]]:
    """Load local Retrosheet event/play-by-play CSV rows."""
    return read_csv_records(path)


def team_recent_form(
    games: list[RetrosheetGame],
    team_id: str,
    before_date: str | None = None,
    last_n_games: int = 10,
) -> dict[str, Any]:
    """Return leakage-safe recent team form before a target date."""
    team_key = clean_name(team_id)
    eligible = [
        game
        for game in games
        if clean_name(game.home_team) == team_key or clean_name(game.away_team) == team_key
    ]
    if before_date:
        eligible = [game for game in eligible if game.date < before_date]

    recent = sorted(eligible, key=lambda game: game.date)[-last_n_games:]
    wins = 0
    runs_for = 0
    runs_against = 0
    for game in recent:
        is_home = clean_name(game.home_team) == team_key
        team_runs = game.home_score if is_home else game.away_score
        opponent_runs = game.away_score if is_home else game.home_score
        wins += int(team_runs > opponent_runs)
        runs_for += team_runs
        runs_against += opponent_runs

    games_played = len(recent)
    return {
        "team": team_id,
        "games": games_played,
        "wins": wins,
        "losses": games_played - wins,
        "win_pct": wins / games_played if games_played else 0.0,
        "runs_for": runs_for,
        "runs_against": runs_against,
        "run_diff": runs_for - runs_against,
        "run_diff_per_game": (runs_for - runs_against) / games_played if games_played else 0.0,
        "before_date": before_date,
    }

