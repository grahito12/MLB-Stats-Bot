"""Agent-facing MLB tools backed by local CSVs and optional data clients."""

from __future__ import annotations

from dataclasses import asdict
from datetime import date
from typing import Any

from .bullpen import get_bullpen_usage as find_bullpen_usage
from .bullpen import load_bullpen_usage
from .data_loader import (
    GameRow,
    PitcherStats,
    TeamStats,
    find_pitcher,
    find_team,
    load_pitcher_stats,
    load_sample_games,
    load_team_stats,
)
from .data_sources.mlb_statsapi_client import MlbStatsApiClient
from .data_sources.retrosheet_loader import load_game_logs, team_recent_form
from .lineup import get_lineup, load_lineups
from .model import BaselinePredictionModel
from .odds import american_odds_to_implied_probability, calculate_edge
from .park_factors import get_park_factor as find_park_factor
from .park_factors import load_park_factors
from .totals import COMMON_TOTAL_LINES, GameTotalContext
from .totals import predict_total_runs as predict_total_runs_model
from .utils import clean_name, data_path, format_probability, safe_float
from .weather import get_weather_context as find_weather_context
from .weather import load_weather_contexts


def _local_state() -> dict[str, Any]:
    return {
        "games": load_sample_games(),
        "teams": load_team_stats(),
        "pitchers": load_pitcher_stats(),
        "parks": load_park_factors(),
        "weather": load_weather_contexts(),
        "bullpens": load_bullpen_usage(),
        "lineups": load_lineups(),
        "retrosheet": load_game_logs(),
    }


def _game_key(game: GameRow) -> str:
    return f"{clean_name(game.away_team)}@{clean_name(game.home_team)}"


def _resolve_game(game_id: str | int, games: list[GameRow] | None = None) -> GameRow:
    all_games = games or load_sample_games()
    raw = str(game_id).strip()
    if raw.isdigit():
        index = int(raw)
        if 0 <= index < len(all_games):
            return all_games[index]

    normalized = clean_name(raw.replace(" vs ", "@").replace(" at ", "@"))
    for game in all_games:
        keys = {
            clean_name(game.home_team),
            clean_name(game.away_team),
            _game_key(game),
            clean_name(f"{game.away_team} @ {game.home_team}"),
            clean_name(f"{game.home_team} vs {game.away_team}"),
        }
        if normalized in keys:
            return game
    available = ", ".join(f"{idx}: {game.away_team} @ {game.home_team}" for idx, game in enumerate(all_games))
    raise ValueError(f'Game "{game_id}" not found. Available: {available}')


def _pitcher_for_game(game: GameRow, side: str, pitchers: dict[str, PitcherStats]) -> PitcherStats | None:
    return find_pitcher(pitchers, game.home_pitcher if side == "home" else game.away_pitcher)


def _team(teams: dict[str, TeamStats], name: str) -> TeamStats:
    return find_team(teams, name)


def get_today_games(use_live: bool = False, date_ymd: str | None = None) -> list[dict[str, Any]]:
    """Return today's games from MLB Stats API or local sample games."""
    if use_live:
        target_date = date_ymd or date.today().isoformat()
        schedule = MlbStatsApiClient().schedule(target_date)
        return [
            {
                "game_id": game.get("gamePk"),
                "game_time": game.get("gameDate"),
                "status": game.get("status", {}).get("detailedState"),
                "away_team": game.get("teams", {}).get("away", {}).get("team", {}).get("name"),
                "home_team": game.get("teams", {}).get("home", {}).get("team", {}).get("name"),
                "ballpark": game.get("venue", {}).get("name"),
            }
            for day in schedule.get("dates", [])
            for game in day.get("games", [])
        ]

    return [
        {
            "game_id": index,
            "date": game.date,
            "away_team": game.away_team,
            "home_team": game.home_team,
            "away_pitcher": game.away_pitcher,
            "home_pitcher": game.home_pitcher,
        }
        for index, game in enumerate(load_sample_games())
    ]


def get_game_context(game_id: str | int) -> dict[str, Any]:
    """Return compact pre-game context for a local sample matchup."""
    state = _local_state()
    game = _resolve_game(game_id, state["games"])
    home = _team(state["teams"], game.home_team)
    away = _team(state["teams"], game.away_team)
    home_pitcher = _pitcher_for_game(game, "home", state["pitchers"])
    away_pitcher = _pitcher_for_game(game, "away", state["pitchers"])
    return {
        "matchup": f"{game.away_team} @ {game.home_team}",
        "date": game.date,
        "home_team": asdict(home),
        "away_team": asdict(away),
        "probable_pitchers": {
            "home": asdict(home_pitcher) if home_pitcher else None,
            "away": asdict(away_pitcher) if away_pitcher else None,
        },
        "park": get_park_factor(game.home_team),
        "weather": get_weather_context(game.home_team, away_team=game.away_team),
        "lineup": {
            "home": asdict(get_lineup(state["lineups"], game.home_team)) if get_lineup(state["lineups"], game.home_team) else None,
            "away": asdict(get_lineup(state["lineups"], game.away_team)) if get_lineup(state["lineups"], game.away_team) else None,
        },
        "market": get_market_odds(game_id),
    }


def get_probable_pitchers(game_id: str | int) -> dict[str, Any]:
    """Return probable starters for a matchup."""
    state = _local_state()
    game = _resolve_game(game_id, state["games"])
    home_pitcher = _pitcher_for_game(game, "home", state["pitchers"])
    away_pitcher = _pitcher_for_game(game, "away", state["pitchers"])
    return {
        "home": asdict(home_pitcher) if home_pitcher else None,
        "away": asdict(away_pitcher) if away_pitcher else None,
    }


def get_team_recent_form(team_id: str, last_n_games: int = 10) -> dict[str, Any]:
    """Return leakage-safe recent form from local Retrosheet-style game logs."""
    return team_recent_form(load_game_logs(), team_id, last_n_games=last_n_games)


def get_pitcher_recent_form(pitcher_id: str, last_n_starts: int = 3) -> dict[str, Any]:
    """Return sample pitcher recent form fields."""
    pitcher = find_pitcher(load_pitcher_stats(), pitcher_id)
    if pitcher is None:
        return {"pitcher": pitcher_id, "starts": 0}
    return {
        "pitcher": pitcher.pitcher,
        "starts": last_n_starts,
        "recent_era": pitcher.recent_3_start_era,
        "recent_whip": pitcher.recent_3_start_whip,
        "pitch_count_last_start": pitcher.pitch_count_last_start,
        "days_rest": pitcher.days_rest,
    }


def get_team_offense_splits(team_id: str, pitcher_hand: str) -> dict[str, Any]:
    """Return team offense split versus pitcher handedness."""
    team = find_team(load_team_stats(), team_id)
    hand = pitcher_hand.strip().lower()
    vs_lhp = hand.startswith("l")
    return {
        "team": team.team,
        "pitcher_hand": "LHP" if vs_lhp else "RHP",
        "ops": team.ops_vs_lhp if vs_lhp else team.ops_vs_rhp,
        "wrc_plus": team.wrc_plus_vs_lhp if vs_lhp else team.wrc_plus_vs_rhp,
        "season_ops": team.ops,
        "season_wrc_plus": team.wrc_plus,
    }


def get_bullpen_usage(team_id: str, last_n_days: int = 3) -> dict[str, Any]:
    """Return bullpen usage and fatigue sample fields."""
    usage = find_bullpen_usage(load_bullpen_usage(), team_id)
    if usage is None:
        return {"team": team_id, "last_n_days": last_n_days, "available": False}
    payload = asdict(usage)
    payload["last_n_days"] = last_n_days
    payload["available"] = True
    return payload


def get_park_factor(ballpark_id: str) -> dict[str, Any]:
    """Return park factor by home team or ballpark key."""
    parks = load_park_factors()
    park = find_park_factor(parks, ballpark_id)
    if park is None:
        return {"ballpark_id": ballpark_id, "available": False}
    payload = asdict(park)
    payload["available"] = True
    return payload


def get_weather_context(ballpark_id: str, game_time: str | None = None, away_team: str | None = None) -> dict[str, Any]:
    """Return local weather context by home team and optional away team."""
    contexts = load_weather_contexts()
    if away_team:
        context = find_weather_context(contexts, ballpark_id, away_team)
    else:
        context = next(
            (item for item in contexts.values() if clean_name(item.home_team) == clean_name(ballpark_id)),
            None,
        )
    if context is None:
        return {"ballpark_id": ballpark_id, "game_time": game_time, "available": False}
    payload = asdict(context)
    payload["game_time"] = game_time
    payload["available"] = True
    return payload


def get_market_odds(game_id: str | int) -> dict[str, Any]:
    """Return local market total/odds row when present."""
    game = _resolve_game(game_id)
    source = data_path("sample_market_totals.csv")
    if not source.exists():
        return {"available": False}
    from .data_loader import read_csv

    for row in read_csv(source):
        if clean_name(row.get("home_team", "")) == clean_name(game.home_team) and clean_name(row.get("away_team", "")) == clean_name(game.away_team):
            return {
                "available": True,
                "home_team": row.get("home_team"),
                "away_team": row.get("away_team"),
                "home_moneyline": row.get("home_moneyline"),
                "away_moneyline": row.get("away_moneyline"),
                "run_line": safe_float(row.get("run_line"), 0.0),
                "home_run_line_odds": row.get("home_run_line_odds"),
                "away_run_line_odds": row.get("away_run_line_odds"),
                "market_total": safe_float(row.get("market_total"), 0.0),
                "opening_total": safe_float(row.get("opening_total"), 0.0),
                "current_total": safe_float(row.get("current_total"), 0.0),
                "closing_total": safe_float(row.get("closing_total"), 0.0),
                "over_odds": row.get("over_odds"),
                "under_odds": row.get("under_odds"),
            }
    return {"available": False}


def predict_moneyline(game_id: str | int) -> dict[str, Any]:
    """Predict moneyline with model probability and market edge when available."""
    state = _local_state()
    game = _resolve_game(game_id, state["games"])
    result = BaselinePredictionModel().predict(
        _team(state["teams"], game.home_team),
        _team(state["teams"], game.away_team),
        _pitcher_for_game(game, "home", state["pitchers"]),
        _pitcher_for_game(game, "away", state["pitchers"]),
    )
    market = get_market_odds(game_id)
    home_market_probability = None
    home_edge = None
    if market.get("home_moneyline"):
        home_market_probability = american_odds_to_implied_probability(str(market["home_moneyline"]))
        home_edge = calculate_edge(result.home_win_probability, home_market_probability)
    return {
        "matchup": f"{game.away_team} @ {game.home_team}",
        "home_win_probability": result.home_win_probability,
        "away_win_probability": result.away_win_probability,
        "predicted_winner": result.predicted_winner,
        "confidence": result.confidence,
        "components": result.components | {"defense": 0.0, "injuries_lineup": 0.0, "market_odds": 0.0},
        "market": market,
        "home_market_implied_probability": home_market_probability,
        "home_edge": home_edge,
        "main_factors": result.main_factors,
        "no_bet": result.confidence == "Low" or (home_edge is not None and abs(home_edge) < 0.02),
    }


def predict_total_runs(game_id: str | int) -> dict[str, Any]:
    """Predict total runs and common over/under probabilities."""
    state = _local_state()
    game = _resolve_game(game_id, state["games"])
    home_team = _team(state["teams"], game.home_team)
    away_team = _team(state["teams"], game.away_team)
    market = get_market_odds(game_id)
    context = GameTotalContext(
        home_pitcher=_pitcher_for_game(game, "home", state["pitchers"]),
        away_pitcher=_pitcher_for_game(game, "away", state["pitchers"]),
        home_lineup=get_lineup(state["lineups"], game.home_team),
        away_lineup=get_lineup(state["lineups"], game.away_team),
        home_bullpen=find_bullpen_usage(state["bullpens"], game.home_team),
        away_bullpen=find_bullpen_usage(state["bullpens"], game.away_team),
        weather=find_weather_context(state["weather"], game.home_team, game.away_team),
        park=find_park_factor(state["parks"], game.home_team),
    )
    result = predict_total_runs_model(
        home_team,
        away_team,
        context,
        market_total=market.get("market_total") if market.get("available") else None,
    )
    return {
        "matchup": f"{game.away_team} @ {game.home_team}",
        "home_expected_runs": result.home_expected_runs,
        "away_expected_runs": result.away_expected_runs,
        "projected_total_runs": result.projected_total_runs,
        "market_total": result.market_total,
        "over_probabilities": result.over_probabilities,
        "under_probabilities": result.under_probabilities,
        "best_total_lean": result.best_total_lean,
        "confidence": result.confidence,
        "model_edge": result.model_edge,
        "main_factors": result.main_factors,
        "no_bet": result.confidence == "Low",
    }


def explain_prediction(game_id: str | int) -> str:
    """Render a full MLB Game Analysis output for the agent."""
    context = get_game_context(game_id)
    moneyline = predict_moneyline(game_id)
    totals = predict_total_runs(game_id)
    market = context["market"]
    lines = [
        "MLB Game Analysis:",
        f"- Matchup: {context['matchup']}",
        f"- Game time: {context['date']}",
        f"- Ballpark: {context['park'].get('park', 'Unknown')}",
        f"- Weather: {context['weather'].get('temperature', 'N/A')} F, wind {context['weather'].get('wind_speed', 'N/A')} mph {context['weather'].get('wind_direction', '')}",
        f"- Probable pitchers: {context['probable_pitchers']['away']['pitcher']} vs {context['probable_pitchers']['home']['pitcher']}",
        "",
        "Moneyline prediction:",
        f"- {context['home_team']['team']}: {format_probability(moneyline['home_win_probability'])}",
        f"- {context['away_team']['team']}: {format_probability(moneyline['away_win_probability'])}",
        f"- Predicted winner: {moneyline['predicted_winner']}",
        "",
        "Total runs prediction:",
        f"- Projected total: {totals['projected_total_runs']:.1f}",
        f"- Home expected runs: {totals['home_expected_runs']:.1f}",
        f"- Away expected runs: {totals['away_expected_runs']:.1f}",
    ]
    for total_line in (6.5, 7.5, 8.5, 9.5, 10.5):
        lines.append(
            f"- Over {total_line:.1f}: {format_probability(totals['over_probabilities'][total_line])}"
        )
    if market.get("available"):
        edge = totals.get("model_edge")
        lines.extend(
            [
                "",
        "Market comparison:",
        f"- Home moneyline: {market.get('home_moneyline')}",
        f"- Away moneyline: {market.get('away_moneyline')}",
        f"- Run line: {market.get('run_line')}",
        f"- Market total: {market.get('market_total')}",
        f"- Opening total: {market.get('opening_total')}",
        f"- Edge calculation: {edge * 100:+.1f}%" if edge is not None else "- Edge calculation: unavailable",
            ]
        )

    risk_factors = []
    if moneyline["confidence"] == "Low" or totals["confidence"] == "Low":
        risk_factors.append("Low confidence or conflicting model signals")
    if not market.get("available"):
        risk_factors.append("Market odds unavailable")
    if "belum tersedia" in str(context.get("lineup", "")).lower():
        risk_factors.append("Lineup uncertainty")

    final_lean = totals["best_total_lean"] if totals["confidence"] != "Low" else moneyline["predicted_winner"]
    no_bet = moneyline["no_bet"] and totals["no_bet"]
    lines.extend(
        [
            "",
            f"- Confidence level: ML {moneyline['confidence']} | Total {totals['confidence']}",
            "- Main supporting factors:",
            *[f"  - {factor}" for factor in (moneyline["main_factors"] + totals["main_factors"])[:5]],
            "- Risk factors:",
            *[f"  - {factor}" for factor in (risk_factors or ["Normal MLB variance"])],
            f"- Final lean: {'No bet' if no_bet else final_lean}",
            f"- No-bet flag: {'YES' if no_bet else 'NO'}",
        ]
    )
    return "\n".join(lines)


def explain_market_value(model_probability: float, american_odds: str | int | float) -> dict[str, float]:
    """Explain why a favorite can be bad value when market price is too high."""
    implied = american_odds_to_implied_probability(str(american_odds))
    return {
        "model_probability": model_probability,
        "market_implied_probability": implied,
        "edge": calculate_edge(model_probability, implied),
    }
