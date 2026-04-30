"""Feature engineering layer for the MLB prediction pipeline.

This module converts raw collected data into clean deterministic features.
It does not make picks, compare markets, run quality control, or explain.
"""

from __future__ import annotations

from typing import Any

from .bullpen import bullpen_fatigue_adjustment
from .features import (
    bullpen_score,
    get_pitcher_rest_days,
    get_team_schedule_fatigue,
    home_field_adjustment,
    log5_probability,
    offense_score,
    pitcher_score,
    pythagorean_win_pct,
    recent_form_score,
)
from .lineup import lineup_adjustment
from .odds import american_odds_to_implied_probability
from .park_factors import park_factor_adjustment
from .utils import clamp
from .weather import weather_adjustment


SIGNAL_PRIORITY = {
    "tier_1": [
        "probable_pitchers",
        "team_offense",
        "bullpen_usage",
        "park_factor",
        "market_odds",
    ],
    "tier_2": [
        "weather",
        "confirmed_lineup",
        "platoon_splits",
        "recent_form",
    ],
    "tier_3": [
        "umpire_tendency",
        "public_betting_percentage",
        "news_sentiment",
        "head_to_head_trends",
    ],
}


def _team_strength(team) -> float:
    pyth = pythagorean_win_pct(team.runs_scored, team.runs_allowed)
    return clamp(pyth * 0.65 + team.win_pct * 0.35, 0.05, 0.95)


def _pitcher_rest_multiplier(rest_days: int) -> float:
    if rest_days <= 3:
        return 0.85
    if rest_days >= 6:
        return 0.93
    return 1.0


def _team_fatigue_offense_adjustment(fatigue: dict[str, Any]) -> float:
    return -0.05 if fatigue.get("doubleheader_last_3_days") else 0.0


def _team_fatigue_overall_adjustment(fatigue: dict[str, Any]) -> float:
    return -0.03 if int(fatigue.get("road_streak") or 0) >= 7 else 0.0


def _pitcher_feature(pitcher, rest_days: int | None = None) -> float:
    if pitcher is None:
        return 0.0
    score = pitcher_score(pitcher.era, pitcher.whip, pitcher.fip, pitcher.k_bb_ratio)
    if rest_days is not None:
        score *= _pitcher_rest_multiplier(rest_days)
    return clamp(score, -1.0, 1.0)


def _offense_feature(team, fatigue: dict[str, Any] | None = None) -> float:
    score = offense_score(team.ops, team.wrc_plus, team.runs_per_game)
    if fatigue:
        score += _team_fatigue_offense_adjustment(fatigue)
    return clamp(score, -1.0, 1.0)


def _bullpen_feature(team) -> float:
    return bullpen_score(team.bullpen_era, team.bullpen_whip, team.bullpen_recent_usage)


def _recent_feature(team) -> float:
    return recent_form_score(team.wins_last_10, team.games_last_10, team.run_diff_last_10)


def _market_probability(odds: Any) -> float | None:
    if odds in (None, ""):
        return None
    return american_odds_to_implied_probability(str(odds))


def build_moneyline_features(collected: dict[str, Any]) -> dict[str, Any]:
    """Create clean moneyline model features from raw game data."""
    home_team = collected["home_team"]
    away_team = collected["away_team"]
    home_pitcher = collected["home_pitcher"]
    away_pitcher = collected["away_pitcher"]
    market = collected["market"]
    game = collected.get("game")
    schedule_data = collected.get("state", {}).get("games", [])
    game_date = getattr(game, "date", collected.get("context", {}).get("date", ""))

    home_pitcher_rest_days = (
        get_pitcher_rest_days(home_pitcher.pitcher, game_date, schedule_data)
        if home_pitcher is not None
        else None
    )
    away_pitcher_rest_days = (
        get_pitcher_rest_days(away_pitcher.pitcher, game_date, schedule_data)
        if away_pitcher is not None
        else None
    )
    home_fatigue = get_team_schedule_fatigue(home_team.team, game_date, schedule_data)
    away_fatigue = get_team_schedule_fatigue(away_team.team, game_date, schedule_data)

    home_team_adjustment = _team_fatigue_overall_adjustment(home_fatigue)
    away_team_adjustment = _team_fatigue_overall_adjustment(away_fatigue)
    home_strength = clamp(_team_strength(home_team) + home_team_adjustment, 0.05, 0.95)
    away_strength = clamp(_team_strength(away_team) + away_team_adjustment, 0.05, 0.95)
    log5_home = log5_probability(home_strength, away_strength)

    components = {
        "team_strength": (log5_home - 0.5) * 5.0,
        "starting_pitcher": _pitcher_feature(home_pitcher, home_pitcher_rest_days)
        - _pitcher_feature(away_pitcher, away_pitcher_rest_days),
        "offense": _offense_feature(home_team, home_fatigue) - _offense_feature(away_team, away_fatigue),
        "bullpen": _bullpen_feature(home_team) - _bullpen_feature(away_team),
        "recent_form": _recent_feature(home_team) - _recent_feature(away_team),
        "home_field": home_field_adjustment(True),
    }

    return {
        "home_strength": home_strength,
        "away_strength": away_strength,
        "log5_home": log5_home,
        "components": components,
        "pitcher_rest_adjustment": {
            "home": {
                "pitcher": home_pitcher.pitcher if home_pitcher else None,
                "rest_days": home_pitcher_rest_days,
                "multiplier": _pitcher_rest_multiplier(home_pitcher_rest_days)
                if home_pitcher_rest_days is not None
                else 1.0,
            },
            "away": {
                "pitcher": away_pitcher.pitcher if away_pitcher else None,
                "rest_days": away_pitcher_rest_days,
                "multiplier": _pitcher_rest_multiplier(away_pitcher_rest_days)
                if away_pitcher_rest_days is not None
                else 1.0,
            },
        },
        "team_fatigue_adjustment": {
            "home": {
                **home_fatigue,
                "team": home_team.team,
                "offense_adjustment": _team_fatigue_offense_adjustment(home_fatigue),
                "team_adjustment": home_team_adjustment,
            },
            "away": {
                **away_fatigue,
                "team": away_team.team,
                "offense_adjustment": _team_fatigue_offense_adjustment(away_fatigue),
                "team_adjustment": away_team_adjustment,
            },
        },
        "market_implied_probability": {
            "home": _market_probability(market.get("home_moneyline")),
            "away": _market_probability(market.get("away_moneyline")),
        },
        "signal_priority": SIGNAL_PRIORITY,
    }


def build_total_features(collected: dict[str, Any]) -> dict[str, Any]:
    """Create clean total-runs model features from raw game data."""
    context = collected["total_context"]
    home_team = collected["home_team"]
    away_team = collected["away_team"]

    return {
        "park_factor_adjustment": park_factor_adjustment(context.park),
        "weather_adjustment": weather_adjustment(context.weather),
        "home_lineup_adjustment": lineup_adjustment(context.home_lineup),
        "away_lineup_adjustment": lineup_adjustment(context.away_lineup),
        "home_bullpen_fatigue": bullpen_fatigue_adjustment(context.home_bullpen),
        "away_bullpen_fatigue": bullpen_fatigue_adjustment(context.away_bullpen),
        "home_recent_form_score": _recent_feature(home_team),
        "away_recent_form_score": _recent_feature(away_team),
        "market_total": collected["market"].get("market_total") if collected["market"].get("available") else None,
        "signal_priority": SIGNAL_PRIORITY,
    }


def build_game_features(collected: dict[str, Any]) -> dict[str, Any]:
    """Build all deterministic features for one game."""
    return {
        "moneyline": build_moneyline_features(collected),
        "totals": build_total_features(collected),
        "signal_priority": SIGNAL_PRIORITY,
    }
