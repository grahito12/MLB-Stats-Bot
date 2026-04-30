"""Explanation layer for final MLB prediction outputs."""

from __future__ import annotations

from typing import Any

from .utils import format_probability


def _join(values: list[str]) -> str:
    return ", ".join(values or ["none"])


def _overall_decision(moneyline: dict[str, Any], totals: dict[str, Any]) -> str:
    if moneyline.get("decision") == "BET" or totals.get("decision") == "BET":
        return "BET"
    if moneyline.get("decision") == "LEAN" or totals.get("decision") == "LEAN":
        return "LEAN"
    return "NO BET"


def _overall_confidence(moneyline: dict[str, Any], totals: dict[str, Any]) -> str:
    if _overall_decision(moneyline, totals) == "NO BET":
        return "Low"
    levels = {"Low": 0, "Medium": 1, "High": 2}
    confidence = max(
        (moneyline.get("confidence", "Low"), totals.get("confidence", "Low")),
        key=lambda item: levels.get(item, 0),
    )
    return confidence


def _risk_factors(
    market: dict[str, Any],
    quality_report: dict[str, Any],
    moneyline: dict[str, Any],
    totals: dict[str, Any],
) -> list[str]:
    risks: list[str] = []
    if moneyline.get("decision") == "NO BET":
        risks.append(f"Moneyline no-bet: {moneyline.get('decision_reason')}")
    if totals.get("decision") == "NO BET":
        risks.append(f"Total no-bet: {totals.get('decision_reason')}")
    if quality_report.get("missing_fields"):
        risks.append(f"Missing data: {_join(quality_report['missing_fields'])}")
    if quality_report.get("stale_fields"):
        risks.append(f"Stale data: {_join(quality_report['stale_fields'])}")
    if not market.get("available"):
        risks.append("Market odds unavailable")
    return risks or ["Normal MLB variance; no model output is guaranteed"]


def _fatigue_context(pipeline_result: dict[str, Any]) -> list[str]:
    moneyline_features = pipeline_result.get("features", {}).get("moneyline", {})
    rest = moneyline_features.get("pitcher_rest_adjustment", {})
    team_fatigue = moneyline_features.get("team_fatigue_adjustment", {})
    notes: list[str] = []

    for side in ("away", "home"):
        pitcher = rest.get(side, {})
        rest_days = pitcher.get("rest_days")
        if rest_days is not None and rest_days < 4 and pitcher.get("pitcher"):
            notes.append(f"⚠️ {pitcher['pitcher']} on short rest ({rest_days} days)")

    for side in ("away", "home"):
        fatigue = team_fatigue.get(side, {})
        if fatigue.get("fatigue_level") == "high":
            team = fatigue.get("team") or side
            road_streak = fatigue.get("road_streak", 0)
            if road_streak >= 7:
                notes.append(f"⚠️ {team} showing schedule fatigue ({road_streak}-game road trip)")
            else:
                notes.append(f"⚠️ {team} showing schedule fatigue")

    return notes


def build_prediction_explanation(
    pipeline_result: dict[str, Any],
) -> str:
    """Render the conservative final output in a fixed order."""
    context = pipeline_result["context"]
    moneyline = pipeline_result["moneyline"]
    totals = pipeline_result["totals"]
    market = pipeline_result["market"]
    quality = pipeline_result["quality_report"]
    market_comparison = pipeline_result["market_comparison"]
    decision = _overall_decision(moneyline, totals)
    confidence = _overall_confidence(moneyline, totals)
    missing = _join(quality.get("missing_fields", []))
    stale = _join(quality.get("stale_fields", []))
    adjustments = _join(quality.get("confidence_adjustments", []))
    home_team = context["home_team"]["team"]
    away_team = context["away_team"]["team"]
    total_edge = market_comparison.get("totals", {}).get("model_edge")
    moneyline_edge = market_comparison.get("moneyline", {}).get("pick_edge")
    final_lean = (
        totals.get("raw_lean")
        if totals.get("decision") in {"BET", "LEAN"}
        else moneyline.get("raw_lean")
    )
    if decision == "NO BET":
        final_lean = "NO BET"
    risk_factors = _risk_factors(market, quality, moneyline, totals) + _fatigue_context(pipeline_result)

    lines = [
        "MLB Game Analysis:",
        "",
        "1. Prediction Summary",
        f"- Matchup: {context['matchup']}",
        f"- Game time: {context['date']}",
        f"- Final lean: {final_lean}",
        "",
        "2. Moneyline Probability",
        "Moneyline prediction:",
        f"- {home_team}: {format_probability(moneyline['home_win_probability'])}",
        f"- {away_team}: {format_probability(moneyline['away_win_probability'])}",
        f"- Predicted winner: {moneyline['predicted_winner']}",
        f"- Moneyline decision: {moneyline['decision']}",
        "",
        "3. Total Runs Projection",
        "Total runs prediction:",
        f"- Home expected runs: {totals['home_expected_runs']:.1f}",
        f"- Away expected runs: {totals['away_expected_runs']:.1f}",
        f"- Projected total: {totals['projected_total_runs']:.1f}",
        f"- Total lean: {totals.get('raw_lean', totals.get('best_total_lean'))}",
        f"- Total decision: {totals['decision']}",
        "",
        "4. Market Comparison",
        f"- Home moneyline: {market.get('home_moneyline', '-')}",
        f"- Away moneyline: {market.get('away_moneyline', '-')}",
        f"- Market total: {market.get('market_total', '-')}",
        f"- Moneyline edge: {moneyline_edge * 100:+.1f}%" if moneyline_edge is not None else "- Moneyline edge: unavailable",
        f"- Total edge: {total_edge * 100:+.1f}%" if total_edge is not None else "- Total edge: unavailable",
        "",
        "5. Data Quality Report",
        f"- Score: {quality.get('score', 0)}/100",
        f"- Missing: {missing}",
        f"- Stale: {stale}",
        f"- Confidence adjustments: {adjustments}",
        "",
        "6. Main Supporting Factors",
        *[f"- {factor}" for factor in pipeline_result.get("supporting_factors", [])[:5]],
        "",
        "7. Risk Factors",
        *[f"- {factor}" for factor in risk_factors],
        "",
        f"8. Final Decision: {decision}",
        f"9. Confidence: {confidence}",
        f"No-bet flag: {'YES' if decision == 'NO BET' else 'NO'}",
    ]
    return "\n".join(lines)
