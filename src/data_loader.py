"""CSV loading helpers for the local MLB prediction engine."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .utils import clean_name, data_path, safe_float, safe_int


@dataclass(frozen=True)
class TeamStats:
    """Team-level features available before a matchup."""

    team: str
    wins: int
    losses: int
    runs_scored: float
    runs_allowed: float
    ops: float | None = None
    wrc_plus: float | None = None
    runs_per_game: float | None = None
    bullpen_era: float | None = None
    bullpen_whip: float | None = None
    bullpen_recent_usage: float | None = None
    wins_last_10: int = 0
    games_last_10: int = 0
    run_diff_last_10: float = 0.0

    @property
    def win_pct(self) -> float:
        total = self.wins + self.losses
        return self.wins / total if total > 0 else 0.5

    @classmethod
    def from_row(cls, row: dict[str, str]) -> "TeamStats":
        return cls(
            team=row["team"],
            wins=safe_int(row.get("wins")),
            losses=safe_int(row.get("losses")),
            runs_scored=safe_float(row.get("runs_scored")),
            runs_allowed=safe_float(row.get("runs_allowed")),
            ops=safe_float(row.get("ops"), 0.0) or None,
            wrc_plus=safe_float(row.get("wrc_plus"), 0.0) or None,
            runs_per_game=safe_float(row.get("runs_per_game"), 0.0) or None,
            bullpen_era=safe_float(row.get("bullpen_era"), 0.0) or None,
            bullpen_whip=safe_float(row.get("bullpen_whip"), 0.0) or None,
            bullpen_recent_usage=safe_float(row.get("bullpen_recent_usage"), 0.0) or None,
            wins_last_10=safe_int(row.get("wins_last_10")),
            games_last_10=safe_int(row.get("games_last_10")),
            run_diff_last_10=safe_float(row.get("run_diff_last_10")),
        )


@dataclass(frozen=True)
class PitcherStats:
    """Starting-pitcher features available before a matchup."""

    pitcher: str
    team: str
    era: float
    whip: float
    fip: float | None = None
    k_bb_ratio: float | None = None

    @classmethod
    def from_row(cls, row: dict[str, str]) -> "PitcherStats":
        return cls(
            pitcher=row["pitcher"],
            team=row["team"],
            era=safe_float(row.get("era"), 4.20),
            whip=safe_float(row.get("whip"), 1.30),
            fip=safe_float(row.get("fip"), 0.0) or None,
            k_bb_ratio=safe_float(row.get("k_bb_ratio"), 0.0) or None,
        )


@dataclass(frozen=True)
class GameRow:
    """Sample game row used for CLI defaults and optional ML examples."""

    date: str
    home_team: str
    away_team: str
    home_pitcher: str
    away_pitcher: str
    home_score: int | None = None
    away_score: int | None = None

    @property
    def home_win(self) -> int | None:
        if self.home_score is None or self.away_score is None:
            return None
        return int(self.home_score > self.away_score)

    @classmethod
    def from_row(cls, row: dict[str, str]) -> "GameRow":
        home_score = row.get("home_score")
        away_score = row.get("away_score")
        return cls(
            date=row["date"],
            home_team=row["home_team"],
            away_team=row["away_team"],
            home_pitcher=row["home_pitcher"],
            away_pitcher=row["away_pitcher"],
            home_score=safe_int(home_score) if home_score else None,
            away_score=safe_int(away_score) if away_score else None,
        )


def read_csv(path: str | Path) -> list[dict[str, str]]:
    """Read a CSV file into dictionaries."""
    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def load_team_stats(path: str | Path | None = None) -> dict[str, TeamStats]:
    """Load team stats keyed by normalized team name."""
    source = Path(path) if path else data_path("sample_team_stats.csv")
    return {clean_name(item.team): item for item in map(TeamStats.from_row, read_csv(source))}


def load_pitcher_stats(path: str | Path | None = None) -> dict[str, PitcherStats]:
    """Load pitcher stats keyed by normalized pitcher name."""
    source = Path(path) if path else data_path("sample_pitcher_stats.csv")
    return {clean_name(item.pitcher): item for item in map(PitcherStats.from_row, read_csv(source))}


def load_sample_games(path: str | Path | None = None) -> list[GameRow]:
    """Load sample games."""
    source = Path(path) if path else data_path("sample_games.csv")
    return [GameRow.from_row(row) for row in read_csv(source)]


def find_team(teams: dict[str, TeamStats], name: str) -> TeamStats:
    """Find a team by name or raise a readable error."""
    key = clean_name(name)
    if key not in teams:
        available = ", ".join(sorted(team.team for team in teams.values()))
        raise ValueError(f'Team "{name}" not found. Available teams: {available}')
    return teams[key]


def find_pitcher(pitchers: dict[str, PitcherStats], name: str | None) -> PitcherStats | None:
    """Find a pitcher by name, returning None for missing optional input."""
    if not name:
        return None
    key = clean_name(name)
    if key not in pitchers:
        available = ", ".join(sorted(pitcher.pitcher for pitcher in pitchers.values()))
        raise ValueError(f'Pitcher "{name}" not found. Available pitchers: {available}')
    return pitchers[key]


def pitchers_for_team(pitchers: Iterable[PitcherStats], team: str) -> list[PitcherStats]:
    """Return all pitchers assigned to a team."""
    key = clean_name(team)
    return [pitcher for pitcher in pitchers if clean_name(pitcher.team) == key]
