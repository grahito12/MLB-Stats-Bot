"""Command-line prediction entry point.

Example:
    python -m src.predict --home "Los Angeles Dodgers" --away "New York Yankees"
"""

from __future__ import annotations

import argparse

from .data_loader import (
    PitcherStats,
    find_pitcher,
    find_team,
    load_pitcher_stats,
    load_sample_games,
    load_team_stats,
    pitchers_for_team,
)
from .model import BaselinePredictionModel
from .odds import (
    american_odds_to_implied_probability,
    calculate_edge,
    decimal_odds_to_implied_probability,
)
from .utils import clean_name, format_probability


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Predict an MLB matchup from local CSV data.")
    parser.add_argument("--home", required=True, help="Home team name")
    parser.add_argument("--away", required=True, help="Away team name")
    parser.add_argument("--home-pitcher", help="Override home starting pitcher")
    parser.add_argument("--away-pitcher", help="Override away starting pitcher")
    parser.add_argument("--team-stats", help="Path to team stats CSV")
    parser.add_argument("--pitcher-stats", help="Path to pitcher stats CSV")
    parser.add_argument("--games", help="Path to games CSV")
    parser.add_argument("--home-odds", help="Optional home odds for market edge comparison")
    parser.add_argument("--odds-format", choices=["american", "decimal"], default="american")
    return parser.parse_args()


def _matchup_pitcher_from_games(
    games_path: str | None,
    home_team: str,
    away_team: str,
    side: str,
) -> str | None:
    games = load_sample_games(games_path)
    home_key = clean_name(home_team)
    away_key = clean_name(away_team)
    for game in games:
        if clean_name(game.home_team) == home_key and clean_name(game.away_team) == away_key:
            return game.home_pitcher if side == "home" else game.away_pitcher
    return None


def _default_pitcher_for_team(pitchers: dict[str, PitcherStats], team: str) -> str | None:
    options = pitchers_for_team(pitchers.values(), team)
    return options[0].pitcher if options else None


def _resolve_pitcher(
    pitchers: dict[str, PitcherStats],
    games_path: str | None,
    team: str,
    opponent: str,
    side: str,
    override: str | None,
) -> PitcherStats | None:
    name = override or _matchup_pitcher_from_games(
        games_path,
        home_team=team if side == "home" else opponent,
        away_team=opponent if side == "home" else team,
        side=side,
    )
    name = name or _default_pitcher_for_team(pitchers, team)
    return find_pitcher(pitchers, name)


def _market_probability(odds: str | None, odds_format: str) -> float | None:
    if odds is None:
        return None
    if odds_format == "decimal":
        return decimal_odds_to_implied_probability(odds)
    return american_odds_to_implied_probability(odds)


def main() -> None:
    args = parse_args()
    teams = load_team_stats(args.team_stats)
    pitchers = load_pitcher_stats(args.pitcher_stats)

    home_team = find_team(teams, args.home)
    away_team = find_team(teams, args.away)
    home_pitcher = _resolve_pitcher(
        pitchers, args.games, args.home, args.away, "home", args.home_pitcher
    )
    away_pitcher = _resolve_pitcher(
        pitchers, args.games, args.away, args.home, "away", args.away_pitcher
    )

    result = BaselinePredictionModel().predict(home_team, away_team, home_pitcher, away_pitcher)
    print(result.format())

    market_probability = _market_probability(args.home_odds, args.odds_format)
    if market_probability is not None:
        edge = calculate_edge(result.home_win_probability, market_probability)
        print("")
        print("Market Comparison:")
        print(f"Home Market Implied Probability: {format_probability(market_probability)}")
        print(f"Home Model Edge: {edge * 100:+.1f}%")


if __name__ == "__main__":
    main()
