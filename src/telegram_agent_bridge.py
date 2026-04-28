"""Minimal JSON bridge from Telegram bot to Python agent tools."""

from __future__ import annotations

import json
import sys
from typing import Any

from .agent_tools import (
    get_game_context,
    get_today_games,
    predict_moneyline,
    predict_total_runs,
)
from .knowledge.baseball_knowledge import BaseballKnowledgeBase
from .utils import format_probability


KNOWLEDGE_QUESTIONS = {
    "wrc": "Why is wRC+ better than OPS for offense evaluation?",
    "fip": "Why does FIP matter more than ERA for pitcher prediction?",
    "wind": "Why does wind blowing out increase over probability?",
    "bullpen": "Why is bullpen fatigue important for totals?",
    "market": "What does it mean if model total is 9.2 but market total is 8.5?",
    "value": "Why can a team be favored but still not be a good value bet?",
    "markets": "What is the difference between moneyline, run line, and total?",
    "f5": "What are the best indicators for first 5 innings bets?",
}


def _json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def _pct(value: float | None) -> str:
    return format_probability(float(value or 0.0))


def _fmt_number(value: Any, digits: int = 1) -> str:
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "-"


def _game_label(game: dict[str, Any]) -> str:
    return f"{game.get('away_team')} @ {game.get('home_team')}"


def list_games() -> dict[str, Any]:
    games = [game for game in get_today_games(use_live=False) if not game.get("final")]
    return {
        "text": "Pilih game:",
        "games": [
            {
                "id": str(game["game_id"]),
                "label": _game_label(game),
                "date": game.get("date", ""),
            }
            for game in games
        ],
    }


def game_menu(game_id: str) -> dict[str, Any]:
    context = get_game_context(game_id)
    pitchers = context["probable_pitchers"]
    text = "\n".join(
        [
            "MLB Agent Tools",
            context["matchup"],
            f"Date: {context['date']}",
            f"Park: {context['park'].get('park', '-')}",
            f"SP: {pitchers['away']['pitcher']} vs {pitchers['home']['pitcher']}",
            "",
            "Pilih action:",
        ]
    )
    return {"text": text}


def moneyline(game_id: str) -> dict[str, Any]:
    result = predict_moneyline(game_id)
    market = result.get("market", {})
    edge = result.get("home_edge")
    lines = [
        "Moneyline",
        result["matchup"],
        f"Pick: {result['predicted_winner']}",
        f"Home: {_pct(result['home_win_probability'])}",
        f"Away: {_pct(result['away_win_probability'])}",
        f"Confidence: {result['confidence']}",
    ]
    if market.get("available"):
        lines.append(f"Market ML: home {market.get('home_moneyline')} | away {market.get('away_moneyline')}")
    if edge is not None:
        lines.append(f"Home edge: {edge * 100:+.1f}%")
    lines.append(f"No-bet: {'YES' if result['no_bet'] else 'NO'}")
    return {"text": "\n".join(lines)}


def total_runs(game_id: str) -> dict[str, Any]:
    result = predict_total_runs(game_id)
    over = result["over_probabilities"]
    under = result["under_probabilities"]
    market_total = result.get("market_total")
    lines = [
        "Total Runs",
        result["matchup"],
        f"Projected: {_fmt_number(result['projected_total_runs'])}",
        f"Expected: home {_fmt_number(result['home_expected_runs'])} | away {_fmt_number(result['away_expected_runs'])}",
    ]
    if market_total:
        lines.append(f"Market total: {_fmt_number(market_total)}")
    lines.extend(
        [
            f"Lean: {result['best_total_lean']}",
            f"Confidence: {result['confidence']}",
            "",
            "Over:",
            f"- Over 6.5: {_pct(over[6.5])}",
            f"- Over 7.5: {_pct(over[7.5])}",
            f"- Over 8.5: {_pct(over[8.5])}",
            f"- Over 9.5: {_pct(over[9.5])}",
            f"- Over 10.5: {_pct(over[10.5])}",
            "",
            "Under:",
            f"- Under 6.5: {_pct(under[6.5])}",
            f"- Under 7.5: {_pct(under[7.5])}",
            f"- Under 8.5: {_pct(under[8.5])}",
            f"- Under 9.5: {_pct(under[9.5])}",
            f"- Under 10.5: {_pct(under[10.5])}",
            f"No-bet: {'YES' if result['no_bet'] else 'NO'}",
        ]
    )
    return {"text": "\n".join(lines)}


def context(game_id: str) -> dict[str, Any]:
    item = get_game_context(game_id)
    weather = item.get("weather", {})
    market = item.get("market", {})
    lines = [
        "Game Context",
        item["matchup"],
        f"Park: {item['park'].get('park', '-')}",
        f"Weather: {_fmt_number(weather.get('temperature'))} F, wind {_fmt_number(weather.get('wind_speed'))} {weather.get('wind_direction', '')}",
        f"Market total: {_fmt_number(market.get('market_total')) if market.get('available') else '-'}",
        f"Run line: {market.get('run_line', '-') if market.get('available') else '-'}",
    ]
    return {"text": "\n".join(lines)}


def full(game_id: str) -> dict[str, Any]:
    ml = predict_moneyline(game_id)
    total = predict_total_runs(game_id)
    lines = [
        "MLB Game Analysis",
        ml["matchup"],
        f"ML pick: {ml['predicted_winner']} ({ml['confidence']})",
        f"Home/Away: {_pct(ml['home_win_probability'])} / {_pct(ml['away_win_probability'])}",
        f"Total: {_fmt_number(total['projected_total_runs'])}",
        f"Lean: {total['best_total_lean']} ({total['confidence']})",
        "",
        "Factors:",
        *[f"- {factor}" for factor in (ml["main_factors"] + total["main_factors"])[:4]],
        f"No-bet: {'YES' if ml['no_bet'] and total['no_bet'] else 'NO'}",
    ]
    return {"text": "\n".join(lines)}


def knowledge(question_key_or_text: str) -> dict[str, Any]:
    question = KNOWLEDGE_QUESTIONS.get(question_key_or_text, question_key_or_text)
    answer = BaseballKnowledgeBase().answer(question, limit=2)
    lines = [
        "Knowledge",
        question,
        "",
        answer.answer.replace("- ", "• "),
    ]
    if answer.sources:
        lines.append("")
        lines.append(f"Source: {answer.sources[0]}")
    return {"text": "\n".join(lines)}


def main(argv: list[str] | None = None) -> None:
    args = argv if argv is not None else sys.argv[1:]
    action = args[0] if args else "games"
    value = args[1] if len(args) > 1 else "0"

    if action == "games":
        _json(list_games())
    elif action == "game":
        _json(game_menu(value))
    elif action == "moneyline":
        _json(moneyline(value))
    elif action == "total":
        _json(total_runs(value))
    elif action == "context":
        _json(context(value))
    elif action == "full":
        _json(full(value))
    elif action == "knowledge":
        _json(knowledge(" ".join(args[1:]) or "wrc"))
    else:
        _json({"text": "Action tidak dikenal."})


if __name__ == "__main__":
    main()
